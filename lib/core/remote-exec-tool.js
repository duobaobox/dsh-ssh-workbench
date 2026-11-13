/**
 * `remote_exec`: run one or more commands on explicitly named managed servers.
 *
 * Every task carries its own server, so the model can fan out in one assistant
 * step and DSH's bounded parallel tool executor can overlap the SSH channels.
 * Nothing in this tool depends on session state or a remembered target.
 *
 * Tasks are validated before any command starts: a typo in the second server
 * must not run the first command and then report a half-completed batch. Each
 * task keeps its own dialect (POSIX shell or PowerShell), timeout, working
 * directory, output cap and error, and results are rendered in task order even
 * when the network completes them out of order.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { describeResultOutcome } from './activity.js'
import { effectiveDialect } from './dialect.js'
import { isTransportFailure } from './posix-shell.js'
import { resolveDialect, sessionKeyOf } from './remote-shell-tool.js'
import { requireServerRef } from './server-ref.js'
import { posixAdapter, win32Adapter } from './shell-adapters.js'

export const REMOTE_EXEC_TOOL_NAME = 'remote_exec'

const DEFAULT_CONCURRENCY = 4
const MAX_CONCURRENCY = 8
const DEFAULT_MAX_TASKS = 8
const DEFAULT_MAX_BATCH_OUTPUT_BYTES = 262144
const MIN_PER_TASK_CAP = 4096

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function integerConfig(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function clampConcurrency(value, taskCount, configured) {
  const configuredCap = Math.max(1, Math.min(integerConfig(configured, DEFAULT_CONCURRENCY), MAX_CONCURRENCY))
  const requested = Number.isInteger(value) && value > 0 ? value : configuredCap
  return Math.max(1, Math.min(requested, configuredCap, MAX_CONCURRENCY, Math.max(1, taskCount)))
}

function clipText(value, cap) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= cap) return { text, clipped: false }
  return { text: text.slice(0, cap), clipped: true }
}

function timeoutNotice(adapter, capability) {
  if (typeof adapter?.timeoutNotice === 'function') return adapter.timeoutNotice(capability)
  return capability?.mode === 'none'
    ? '[remote] client-side timeout only: the remote process may still be running.'
    : '[remote] timeout: the remote command group was terminated.'
}

function cancelNotice(adapter) {
  if (typeof adapter?.cancelNotice === 'function') return adapter.cancelNotice()
  return '[remote] cancelled: the SSH channel was closed; the remote process may still be running.'
}

function adapterFor(dialect) {
  return dialect === 'windows' ? win32Adapter : posixAdapter
}

/**
 * Resolve and validate every task before any of them runs.
 * @returns {Promise<object[]>} one resolved task per input, in input order
 */
async function resolveTasks({ tasks, servers, runtime, config, probe }) {
  const maxTasks = integerConfig(config?.maxBatchTasks, DEFAULT_MAX_TASKS)
  if (tasks.length > maxTasks) {
    throw new Error(`too many tasks: at most ${maxTasks} tasks are allowed per remote_exec call`)
  }

  const pending = tasks.map(async (task, index) => {
    const label = `task ${index + 1}`
    if (!task || typeof task !== 'object') throw new Error(`${label} must be an object`)
    const serverRef = typeof task.server === 'string' ? task.server.trim() : ''
    if (!serverRef) throw new Error(`${label} is missing server`)
    let server
    try {
      server = requireServerRef(servers, serverRef, { label: `${label} server` })
    } catch (error) {
      throw new Error(`${label}: ${describeError(error)}`)
    }

    const command = typeof task.command === 'string' ? task.command : ''
    if (!command.trim()) throw new Error(`${label}: command must not be empty`)

    const dialect = probe === false ? effectiveDialect(server) : await resolveDialect(server, runtime)
    const adapter = adapterFor(dialect)
    if (typeof adapter.supportsDialect === 'function' && !adapter.supportsDialect(dialect)) {
      throw new Error(`${label}: ${adapter.unsupportedMessage(server, dialect)}`)
    }

    const built = adapter.buildCommand(command, task.workdir, server, dialect)
    if (built?.error !== undefined) throw new Error(`${label}: ${built.error}`)
    return {
      index,
      task,
      server,
      dialect,
      adapter,
      command,
      cwd: built.cwd,
      remoteCommand: built.command,
      timeoutMs: adapter.resolveTimeoutMs(task, config),
      capability: undefined,
    }
  })

  const settled = await Promise.allSettled(pending)
  const errors = []
  const resolved = []
  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index]
    if (outcome.status === 'fulfilled') resolved[index] = outcome.value
    else errors.push(describeError(outcome.reason))
  }
  if (errors.length > 0) throw new Error(`remote_exec validation failed:\n- ${errors.join('\n- ')}`)
  return resolved
}

async function resolveCapabilities(tasks, runtime, probe = true) {
  if (probe === false) {
    for (const task of tasks) task.capability = { mode: 'none', shell: '/bin/sh' }
    return
  }
  const cache = new Map()
  await Promise.all(
    tasks.map(async (task) => {
      if (task.adapter?.remoteTimeout !== true) {
        task.capability = { mode: 'none', shell: '/bin/sh' }
        return
      }
      const key = task.server.name
      if (!cache.has(key)) {
        cache.set(
          key,
          (async () => {
            try {
              if (typeof runtime?.timeoutGuard !== 'function') return { mode: 'none', shell: '/bin/sh' }
              const probed = await runtime.timeoutGuard(task.server)
              return typeof probed === 'string' ? { mode: probed } : (probed ?? { mode: 'none', shell: '/bin/sh' })
            } catch {
              return { mode: 'none', shell: '/bin/sh' }
            }
          })(),
        )
      }
      task.capability = await cache.get(key)
    }),
  )
}

/**
 * Activity is best effort and must never change a batch result. Recording the
 * session id and duration is what lets the dock summarize this conversation
 * without touching DSH's private metrics.
 */
function recordTaskActivity(task, { sessionId, durationMs, outcome }) {
  try {
    task.recordActivity?.({
      kind: 'exec',
      server: task.server.name,
      summary: task.command.slice(0, 200),
      outcome,
      sessionId,
      durationMs,
    })
  } catch {
    // Best effort.
  }
}

async function runOne(task, { runtime, config, perTaskOutputCap, perTaskStderrCap, signal, sessionId, connectTimeoutMs }) {
  const startedAt = Date.now()
  let result
  try {
    result = await runtime.exec(task.server, task.adapter.wrapTimeout(task.remoteCommand, task.timeoutMs, task.capability, {
      killAfterMs: config?.timeoutKillAfterMs,
    }), {
      timeoutMs: task.timeoutMs,
      signal,
      readOnly: false,
      cap: perTaskOutputCap,
      stderrCap: perTaskStderrCap,
      connectTimeoutMs,
    })
  } catch (error) {
    const durationMs = Date.now() - startedAt
    recordTaskActivity(task, { sessionId, durationMs, outcome: 'failed' })
    return { index: task.index, task, error: describeError(error), durationMs }
  }

  const durationMs = Date.now() - startedAt
  recordTaskActivity(task, { sessionId, durationMs, outcome: describeResultOutcome(result) })

  if (isTransportFailure(result)) {
    const detail = typeof result?.stderr === 'string' && result.stderr.trim() ? result.stderr.trim() : 'remote execution failed'
    const code = typeof result?.errorCode === 'string' && result.errorCode ? `${result.errorCode}: ` : ''
    return {
      index: task.index,
      task,
      error: `${code}${detail}`,
      result,
      durationMs,
    }
  }
  return { index: task.index, task, result, durationMs }
}

/** Run `worker` over `tasks` with at most `concurrency` active promises. */
async function runPool(tasks, concurrency, run) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= tasks.length) return
      results[index] = await run(tasks[index])
    }
  })
  await Promise.all(workers)
  return results
}

function renderTask(outcome, { perTaskOutputCap, perTaskStderrCap }) {
  const { task } = outcome
  const target = `${task.server.username}@${task.server.host}:${task.server.port}`
  const lines = [
    `[${task.index + 1}] ${task.server.name} (${target}) · ${task.dialect}`,
    `command: ${task.command}`,
    `cwd: ${task.cwd}`,
    `duration: ${outcome.durationMs}ms`,
  ]
  if (outcome.error !== undefined) {
    lines.push(`error: ${outcome.error}`)
    return lines
  }

  const result = outcome.result ?? {}
  if (Number.isInteger(result.exitCode)) lines.push(`exit code: ${result.exitCode}`)
  if (result.outcome === 'timeout') lines.push('outcome: timed out')
  if (result.outcome === 'cancelled') lines.push('outcome: cancelled')

  const stdout = clipText(result.stdout, perTaskOutputCap)
  const stderr = clipText(result.stderr, perTaskStderrCap)
  lines.push('stdout:')
  lines.push(stdout.text.length > 0 ? stdout.text.replace(/\n$/, '') : '(empty)')
  if (stderr.text.length > 0) {
    lines.push('stderr:')
    lines.push(stderr.text.replace(/\n$/, ''))
  }
  if (stdout.clipped || result.truncated?.stdout === true) lines.push('[stdout truncated by the plugin output cap]')
  if (stderr.clipped || result.truncated?.stderr === true) lines.push('[stderr truncated by the plugin output cap]')
  if (result.outcome === 'timeout') lines.push(timeoutNotice(task.adapter, task.capability))
  if (result.outcome === 'cancelled') lines.push(cancelNotice(task.adapter))
  return lines
}

/**
 * @param {object} deps
 * @param {object} deps.runtime SSH runtime facade
 * @param {object} deps.config resolved plugin config
 * @param {() => object[]} deps.loadInventory
 * @param {(entry: object) => void} [deps.recordActivity]
 */
export function createRemoteExecTool({ runtime, config, loadInventory, recordActivity } = {}) {
  return defineTool({
    name: REMOTE_EXEC_TOOL_NAME,
    description:
      'Run one or more commands on explicitly named managed remote resources in one call. ' +
      'Each task carries its own server, so tasks on different resources run concurrently and no task depends on ' +
      'any session-level target state. Use it for multi-resource questions such as comparing versions ' +
      'or collecting status from several @mentioned resources in one step. POSIX targets use their login shell; ' +
      'Windows targets use PowerShell. This tool is foreground-only; use remote_bash/remote_pwsh for a detached process. ' +
      'The native shell tool always runs on the local DSH host, so never use it for these commands. ' +
      'Set probe:false to skip dialect/capability probing; combine it with connectTimeoutMs for quick status checks.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'Commands to run, one per managed resource. Each task must name its server explicitly.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            server: {
              type: 'string',
              required: true,
              description: 'Managed resource name or id.',
            },
            command: {
              type: 'string',
              required: true,
              description: 'Command to run on that resource.',
            },
            workdir: {
              type: 'string',
              description: 'Remote working directory: absolute path, ~/path, or a path relative to the login home.',
            },
            timeoutMs: {
              type: 'integer',
              description: 'Foreground timeout for this task in milliseconds (default from config, capped by maxCommandTimeoutMs).',
            },
          },
        },
      },
      concurrency: {
        type: 'integer',
        description: `Maximum tasks to run at once (1–${MAX_CONCURRENCY}; default ${DEFAULT_CONCURRENCY}, capped by the configured batch concurrency).`,
      },
      probe: {
        type: 'boolean',
        description:
          'Probe each target dialect and timeout capability before running (default true). Set false for quick status checks: it skips the two extra SSH round-trips and uses the recorded facts/platform instead.',
      },
      connectTimeoutMs: {
        type: 'integer',
        description:
          'Per-connection timeout in milliseconds (default from config). Use a short value with probe:false so unreachable resources fail fast instead of hanging on the SSH handshake.',
      },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const tasks = Array.isArray(args?.tasks) ? args.tasks : []
      if (tasks.length === 0) throw new Error('remote_exec requires at least one task')
      const maxTasks = integerConfig(config?.maxBatchTasks, DEFAULT_MAX_TASKS)
      if (tasks.length > maxTasks) throw new Error(`too many tasks: at most ${maxTasks} tasks are allowed per remote_exec call`)

      let servers
      try {
        servers = loadInventory()
      } catch (error) {
        throw new Error(`cannot read the managed server inventory: ${describeError(error)}`)
      }

      const probe = args?.probe !== false
      const configuredConnectTimeout = integerConfig(config?.connectTimeoutMs, 15000)
      const connectTimeoutMs = Number.isInteger(args?.connectTimeoutMs) && args.connectTimeoutMs > 0
        ? Math.max(1000, Math.min(args.connectTimeoutMs, configuredConnectTimeout))
        : undefined
      const resolved = await resolveTasks({ tasks, servers, runtime, config, probe })
      await resolveCapabilities(resolved, runtime, probe)
      for (const task of resolved) task.recordActivity = recordActivity

      const concurrency = clampConcurrency(args?.concurrency, resolved.length, config?.batchConcurrency)
      const maxBatch = integerConfig(config?.maxBatchOutputBytes, DEFAULT_MAX_BATCH_OUTPUT_BYTES)
      const maxPerTask = integerConfig(config?.maxOutputBytes, 102400)
      const perTaskOutputCap = Math.max(
        MIN_PER_TASK_CAP,
        Math.min(maxPerTask, Math.floor(maxBatch / Math.max(1, resolved.length))),
      )
      const perTaskStderrCap = Math.min(integerConfig(config?.maxStderrBytes, 16384), perTaskOutputCap)

      const sessionId = sessionKeyOf(exec)
      const outcomes = await runPool(resolved, concurrency, (task) =>
        runOne(task, {
          runtime,
          config,
          perTaskOutputCap,
          perTaskStderrCap,
          signal: exec?.signal,
          sessionId,
          connectTimeoutMs,
        }),
      )

      const serverCount = new Set(resolved.map((task) => task.server.name)).size
      const lines = [
        `remote_exec: ${resolved.length} task(s) on ${serverCount} server(s), concurrency ${concurrency}`,
      ]
      for (const outcome of outcomes) {
        lines.push('')
        lines.push(...renderTask(outcome, { perTaskOutputCap, perTaskStderrCap }))
      }
      let text = lines.join('\n')
      if (text.length > maxBatch) {
        text = `${text.slice(0, maxBatch)}\n[remote_exec output truncated at the ${maxBatch}-byte batch cap]`
      }
      return { text }
    },
  })
}
