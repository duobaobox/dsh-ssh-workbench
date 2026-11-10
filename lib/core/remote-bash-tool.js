/**
 * Standalone remote shell tools (`remote_bash`, `remote_pwsh`).
 *
 * The plugin normally routes DSH's native `bash` tool to the active target.
 * That only works on Hosts that ship `bash`: Windows Desktop builds ship
 * `pwsh` instead and disable `bash` by platform, so the interception handler is
 * never called there. A Windows target is also unreachable from any Host
 * through the POSIX shell. These tools are the portable entry points — they are
 * registered where the native shell cannot cover the target dialect, never
 * shadow a native tool, and keep the local shell strictly local.
 *
 * The tools return rendered text instead of the native Bash value: the built-in
 * Bash renderer is reserved for the built-in tool and a remote result has no
 * native card. Text keeps command, target, cwd and exit status explicit.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { describeResultOutcome } from './activity.js'
import { parseBackgroundStart, renderBackgroundStart } from './background.js'
import { effectiveDialect, normalizeDialect } from './dialect.js'
import { isTransportFailure } from './remote-bash.js'
import { posixAdapter } from './shell-adapters.js'
import { findTarget } from './targets.js'

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Read the session key off one tool execution, tolerating test doubles. */
export function sessionKeyOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  const id = session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve the dialect a target actually runs. `facts.dialect` is a probe
 * result; when it is absent (fresh record, first selection) the runtime probe
 * runs once and is cached. The record's `platform` hint is only the last
 * fallback.
 */
export async function resolveDialect(server, runtime) {
  const probed = server?.facts?.dialect
  if (probed === 'posix' || probed === 'windows') return probed
  if (runtime && typeof runtime.probeDialect === 'function') {
    try {
      const dialect = await runtime.probeDialect(server)
      if (dialect === 'posix' || dialect === 'windows') return dialect
    } catch {
      // Fall through to the record hint.
    }
  }
  return effectiveDialect(server)
}

/**
 * Resolve the active target and the dialect for one call.
 * @returns {Promise<{ key: string, binding: object, server: object, dialect: string }>}
 */
export async function resolveRemoteTarget({ exec, targets, loadInventory, adapter, runtime, toolName = adapter?.toolName ?? 'remote shell' }) {
  const key = sessionKeyOf(exec)
  if (key === undefined) throw new Error(`${toolName} requires an agent session`)
  const binding = typeof targets?.get === 'function' ? targets.get(key) : undefined
  if (!binding || !binding.active) {
    if (binding && Array.isArray(binding.candidates) && binding.candidates.length > 1) {
      throw new Error(
        `several servers were mentioned in this session (${binding.candidates.join(', ')}); ` +
          `call ssh_workbench_target({ server: "<name>" }) before ${toolName}`,
      )
    }
    throw new Error(
      `no active target — call ssh_workbench_target({ server: "<name>" }) before ${toolName}, ` +
        'or ssh_workbench_target({ server: "local" }) to stay on the local DSH host',
    )
  }

  let servers
  try {
    servers = loadInventory()
  } catch (error) {
    throw new Error(`cannot read the managed server inventory: ${describeError(error)}`)
  }
  const server = findTarget(servers, binding.active)
  if (server === undefined) {
    throw new Error(
      `target "${binding.active}" is no longer in the managed inventory; ` +
        'call ssh_workbench_target to pick another target or "local"',
    )
  }
  if (server.enabled === false) {
    throw new Error(`target "${server.name}" is disabled; call ssh_workbench_target to pick another target or "local"`)
  }
  const dialect = await resolveDialect(server, runtime)
  if (typeof adapter?.supportsDialect === 'function' && !adapter.supportsDialect(dialect)) {
    throw new Error(adapter.unsupportedMessage(server, dialect))
  }
  return { key, binding, server, dialect }
}

/** Render one remote result as model-facing text. */
export function renderRemoteResult({ server, command, cwd, result, notices }) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null
  const lines = [`target: ${server.name} (${server.username}@${server.host}:${server.port})`, `command: ${command}`, `cwd: ${cwd}`]
  if (exitCode !== null) lines.push(`exit code: ${exitCode}`)
  if (result?.outcome === 'timeout') lines.push('outcome: timed out')
  if (result?.outcome === 'cancelled') lines.push('outcome: cancelled')
  lines.push('stdout:')
  lines.push(stdout.length > 0 ? stdout.replace(/\n$/, '') : '(empty)')
  if (stderr.length > 0) {
    lines.push('stderr:')
    lines.push(stderr.replace(/\n$/, ''))
  }
  if (result?.truncated?.stdout === true) lines.push('[stdout truncated by the plugin output cap]')
  if (result?.truncated?.stderr === true) lines.push('[stderr truncated by the plugin output cap]')
  for (const notice of notices ?? []) lines.push(notice)
  return { text: lines.join('\n') }
}

function defaultTimeoutNotice(capability) {
  return capability.mode === 'none'
    ? '[remote] client-side timeout only: the server has no usable `timeout` utility, so the remote process may still be running.'
    : `[remote] timeout: the remote command group was terminated (SIGTERM${capability.mode === 'kill' ? ', KILL after the remote deadline' : ''}).`
}

function defaultCancelNotice(capability) {
  return capability.mode === 'none'
    ? '[remote] cancelled: the SSH channel was closed, but the remote process may still be running.'
    : '[remote] cancelled: the SSH channel was closed; the remote wrapper terminates the command at its deadline if it is still running.'
}

/**
 * Create one remote shell tool definition.
 *
 * @param {object} deps
 * @param {object} deps.runtime SSH runtime facade (`createSshRuntime`)
 * @param {object} deps.targets per-session target store
 * @param {object} deps.config resolved plugin config
 * @param {() => object[]} deps.loadInventory
 * @param {(entry: object) => void} [deps.recordActivity]
 * @param {object} [deps.adapter] shell adapter (defaults to POSIX `remote_bash`)
 * @param {string} [deps.localShellName] native local shell label, for copy
 */
export function createRemoteShellTool({
  runtime,
  targets,
  config,
  loadInventory,
  recordActivity,
  adapter = posixAdapter,
  localShellName = 'bash',
} = {}) {
  const dialectName = normalizeDialect(adapter.platform) === 'windows' ? 'Windows/PowerShell' : 'POSIX shell'
  return defineTool({
    name: adapter.toolName,
    description:
      `Run a ${dialectName} command on the managed remote target selected with ssh_workbench_target. ` +
      'This is the remote execution tool: the native ' +
      `${localShellName} tool always runs on the local DSH host, so use this tool only for work that belongs on the target. ` +
      'Pass workdir to change the working directory and timeoutMs for a foreground deadline. ' +
      'Set run_in_background to start a detached process: the result gives its pid and log files, ' +
      'which you can read with tail/Get-Content and stop with kill/Stop-Process. ' +
      'If no target is active the tool fails; call ssh_workbench_target({ server: "<name>" }) first, ' +
      'or ssh_workbench_target({ server: "local" }) to detach.',
    parameters: {
      command: { type: 'string', required: true, description: `Command to run on the remote ${dialectName} target.` },
      workdir: {
        type: 'string',
        description: 'Remote working directory: an absolute path, ~/path, or a path relative to the login home.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Foreground timeout in milliseconds (default from config, capped by maxCommandTimeoutMs).',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Start the command detached instead of waiting. Returns the remote pid and log files; timeoutMs does not apply.',
      },
    },
    output: textOut,
    async execute(args, exec) {
      const { key, binding, server, dialect } = await resolveRemoteTarget({
        exec,
        targets,
        loadInventory,
        runtime,
        adapter,
      })

      const command = typeof args?.command === 'string' ? args.command : ''
      if (!command.trim()) throw new Error('command must not be empty')
      const sessionId = sessionKeyOf(exec)
      const startedAt = Date.now()

      if (args?.run_in_background === true) {
        if (typeof adapter.buildBackgroundCommand !== 'function') {
          throw new Error(`${adapter.toolName} does not support run_in_background`)
        }
        const background = adapter.buildBackgroundCommand(command, args?.workdir, server, dialect)
        if (background.error !== undefined) throw new Error(background.error)
        const startTimeout = Math.min(adapter.resolveTimeoutMs(args, config), 30000)
        let start
        try {
          start = await runtime.exec(server, background.command, {
            timeoutMs: startTimeout,
            signal: exec?.signal,
            readOnly: false,
            cap: Number.isInteger(config?.maxOutputBytes) ? config.maxOutputBytes : undefined,
            stderrCap: Number.isInteger(config?.maxStderrBytes) ? config.maxStderrBytes : undefined,
          })
        } catch (error) {
          try {
            recordActivity?.({
              kind: 'exec',
              server: server.name,
              summary: `[background] ${command.slice(0, 190)}`,
              outcome: 'failed',
              sessionId,
              durationMs: Date.now() - startedAt,
            })
          } catch {
            // Activity recording is best effort.
          }
          throw new Error(`remote execution failed: ${describeError(error)}`)
        }
        try {
          recordActivity?.({
            kind: 'exec',
            server: server.name,
            summary: `[background] ${command.slice(0, 190)}`,
            outcome: describeResultOutcome(start),
            sessionId,
            durationMs: Date.now() - startedAt,
          })
        } catch {
          // Activity recording is best effort.
        }
        if (isTransportFailure(start)) {
          const detail = typeof start?.stderr === 'string' && start.stderr.trim() ? start.stderr.trim() : 'remote execution failed'
          throw new Error(detail)
        }
        const started = parseBackgroundStart(start?.stdout)
        if (started.pid === undefined) {
          const detail = String(start?.stderr ?? '').trim() || String(start?.stdout ?? '').trim()
          throw new Error(`background start failed${detail ? `: ${detail}` : ''}`)
        }
        return {
          text: renderBackgroundStart({
            pid: started.pid,
            log: started.log,
            errLog: started.errLog,
            target: `${server.name} (${server.username}@${server.host}:${server.port})`,
            command,
            dialect,
          }),
        }
      }

      const workdir = adapter.buildCommand(command, args?.workdir, server, dialect)
      if (workdir.error !== undefined) throw new Error(workdir.error)
      const timeoutMs = adapter.resolveTimeoutMs(args, config)

      // A remote deadline wrapper stops the remote process group when the
      // client gives up; adapters without one fall back to the SSH channel
      // close and say so in the result.
      let capability = { mode: 'none', shell: '/bin/sh' }
      if (adapter.remoteTimeout) {
        try {
          if (typeof runtime.timeoutGuard === 'function') {
            const probed = await runtime.timeoutGuard(server)
            capability = typeof probed === 'string' ? { mode: probed } : (probed ?? capability)
          }
        } catch {
          capability = { mode: 'none', shell: '/bin/sh' }
        }
      }
      const remoteCommand = adapter.wrapTimeout(workdir.command, timeoutMs, capability, {
        killAfterMs: config?.timeoutKillAfterMs,
      })

      let result
      try {
        result = await runtime.exec(server, remoteCommand, {
          timeoutMs,
          signal: exec?.signal,
          readOnly: false,
          cap: Number.isInteger(config?.maxOutputBytes) ? config.maxOutputBytes : undefined,
          stderrCap: Number.isInteger(config?.maxStderrBytes) ? config.maxStderrBytes : undefined,
        })
      } catch (error) {
        try {
          recordActivity?.({ kind: 'exec', server: server.name, summary: command.slice(0, 200), outcome: 'failed', sessionId, durationMs: Date.now() - startedAt })
        } catch {
          // Activity recording is best effort.
        }
        throw new Error(`remote execution failed: ${describeError(error)}`)
      }

      try {
        recordActivity?.({
          kind: 'exec',
          server: server.name,
          summary: command.slice(0, 200),
          outcome: describeResultOutcome(result),
          sessionId,
          durationMs: Date.now() - startedAt,
        })
      } catch {
        // Activity recording is best effort.
      }

      if (isTransportFailure(result)) {
        const code = typeof result?.errorCode === 'string' && result.errorCode ? `${result.errorCode}: ` : ''
        const detail = typeof result?.stderr === 'string' && result.stderr.trim() ? result.stderr.trim() : 'remote execution failed'
        const suggestion = typeof result?.suggestedAction === 'string' && result.suggestedAction ? `\n${result.suggestedAction}` : ''
        throw new Error(`${code}${detail}${suggestion}`)
      }

      const notices = []
      // One line after each target change: makes a plain-text result
      // self-describing in multi-target sessions.
      if (binding.notifiedVersion !== binding.version && typeof targets?.markNotified === 'function') {
        notices.push(`[remote] target: ${server.name} (${server.username}@${server.host}:${server.port})`)
        targets.markNotified(key, binding.version)
      }
      if (result?.outcome === 'timeout') {
        notices.push(
          typeof adapter.timeoutNotice === 'function' ? adapter.timeoutNotice(capability) : defaultTimeoutNotice(capability),
        )
      }
      if (result?.outcome === 'cancelled') {
        notices.push(
          typeof adapter.cancelNotice === 'function' ? adapter.cancelNotice(capability) : defaultCancelNotice(capability),
        )
      }

      return renderRemoteResult({ server, command, cwd: workdir.cwd, result, notices })
    },
  })
}

