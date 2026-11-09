/**
 * Route the native `bash` tool to a managed server.
 *
 * `tools/execute` is DSH's around-dispatch waterfall. This handler returns a
 * replacement result for exactly one tool — the built-in `bash` — and only
 * while the session has an active managed target; every other call falls
 * through with `next()`. The replacement value is the native bash foreground
 * value, so the registry validates it against the built-in output schema and
 * renders it with the built-in terminal renderer: no shadow tool, no schema
 * copy, no custom rendering.
 */
import { describeResultOutcome } from './activity.js'
import { buildPosixBackgroundCommand, parseBackgroundStart, renderBackgroundStart } from './background.js'
import { effectiveDialect } from './dialect.js'
import { quotePosix } from './posix-quote.js'
import { findTarget } from './targets.js'

export const BASH_TOOL_NAME = 'bash'

const MIN_TIMEOUT_MS = 1000
const POSIX_PLATFORM = 'posix'

export { quotePosix }

/**
 * Wrap a remote command with the remote `timeout` utility.
 *
 * A client-side timeout only closes the SSH channel; a process that ignores
 * SIGHUP (nohup/background) keeps running on the server. Wrapping the command
 * gives the remote side the same deadline: coreutils `timeout` runs the
 * managed command in its own process group and signals the whole group, so
 * when the client gives up the remote work stops too. `kill` adds `-k <n>`
 * (KILL after TERM); `basic` sends TERM only; `none` (or an unknown
 * capability) leaves the command untouched.
 *
 * The wrapper re-enters the remote login shell (`<shell> -c`) so shell
 * semantics do not change. The shell path comes from the capability probe and
 * is referenced as a quoted literal, so this also works on fish/csh (no POSIX
 * `${SHELL:-...}` expansion). The command itself is single-quote escaped and
 * therefore expanded exactly once, inside that shell.
 *
 * @param {string} command
 * @param {number} timeoutMs
 * @param {'kill'|'basic'|'none'|{mode?: string, shell?: string}} [capability]
 * @param {{ killAfterMs?: number }} [options]
 */
export function wrapRemoteTimeout(command, timeoutMs, capability = 'none', options = {}) {
  const info = typeof capability === 'string' ? { mode: capability } : (capability ?? {})
  const mode = info.mode === 'kill' || info.mode === 'basic' ? info.mode : 'none'
  if (mode === 'none') return String(command ?? '')
  const shell = typeof info.shell === 'string' && info.shell.startsWith('/') ? info.shell : '/bin/sh'
  const killAfterMs = Number.isFinite(options.killAfterMs) ? options.killAfterMs : 5000
  const killSeconds = Math.max(0, Math.ceil(killAfterMs / 1000))
  const seconds = Math.max(1, Number(timeoutMs) / 1000)
  const suffix = mode === 'kill' && killSeconds > 0 ? `-k ${killSeconds} ` : ''
  return `timeout ${suffix}${seconds} ${quotePosix(shell)} -c ${quotePosix(command)}`
}

/**
 * Turn the model-facing `workdir` into a shell prefix and the value's cwd label.
 *
 * The remote shell starts in the login home; absolute paths are used verbatim,
 * `~`/`~/x` and relative paths are anchored at `$HOME`.
 *
 * @returns {{ command: string, cwd: string } | { error: string }}
 */
export function applyWorkdir(command, workdir) {
  const raw = typeof workdir === 'string' ? workdir.trim() : ''
  const body = String(command ?? '')
  if (!raw) return { command: body, cwd: '~' }
  if (raw.includes('\n') || raw.includes('\r')) return { error: 'workdir must not contain newlines' }
  if (raw.startsWith('~')) {
    const rest = raw === '~' ? '' : raw.slice(1)
    if (rest !== '' && !rest.startsWith('/')) return { error: 'workdir must be an absolute path, ~/path, or a relative path' }
    const target = rest === '' ? '"$HOME"' : `"$HOME"${quotePosix(rest)}`
    return { command: `cd -- ${target} && ${body}`, cwd: raw }
  }
  if (raw.startsWith('/')) {
    return { command: `cd -- ${quotePosix(raw)} && ${body}`, cwd: raw }
  }
  return { command: `cd -- "$HOME"/${quotePosix(raw)} && ${body}`, cwd: `~/${raw}` }
}

/** Effective timeout for one call, clamped to the configured ceiling. */
export function resolveTimeoutMs(args, config) {
  const ceiling = Number.isInteger(config?.maxCommandTimeoutMs) ? config.maxCommandTimeoutMs : 30 * 60 * 1000
  const requested = Number.isInteger(args?.timeoutMs) ? args.timeoutMs : undefined
  const fallback = Number.isInteger(config?.commandTimeoutMs) ? config.commandTimeoutMs : 120000
  const value = requested ?? fallback
  return Math.max(MIN_TIMEOUT_MS, Math.min(value, ceiling))
}

/**
 * Map one runtime exec result onto the native bash foreground value.
 * Non-zero exits are normal results; only "the command never ran" becomes an
 * error result on the caller side.
 */
export function toBashValue(result, { cwd, timeoutMs }) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null
  const signal = typeof result?.signal === 'string' && result.signal.length > 0 ? result.signal : null
  return {
    kind: 'foreground',
    cwd,
    exitCode,
    signal,
    timedOut: result?.outcome === 'timeout',
    aborted: result?.outcome === 'cancelled',
    timeoutMs,
    stdout: { text: stdout, truncated: result?.truncated?.stdout === true },
    stderr: { text: stderr, truncated: result?.truncated?.stderr === true },
  }
}

/**
 * Whether a runtime result means the command never reached the remote shell.
 * Timeouts and aborts are real command outcomes (timedOut / aborted on the
 * native value), not transport failures.
 */
export function isTransportFailure(result) {
  if (!result || typeof result !== 'object') return true
  if (result.exitCode !== null && result.exitCode !== undefined) return false
  if (typeof result.signal === 'string' && result.signal.length > 0) return false
  return result.outcome === 'failed'
}

/** Build the structured error result the pipeline accepts for a failed call. */
export function createErrorResult(message, code = 'SSH_FAILED') {
  const text = String(message ?? 'remote bash failed')
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${code}: ${text}` }],
    error: { message: text, info: { name: 'SshOpsError', code } },
  }
}

/**
 * @param {object} deps
 * @param {object} deps.runtime SSH runtime facade (`createSshRuntime`)
 * @param {object} deps.targets per-session target store
 * @param {object} deps.config resolved plugin config
 * @param {() => object[]} deps.loadInventory
 * @param {(entry: object) => void} [deps.recordActivity]
 * @returns {(exec: object, next: () => Promise<object>) => Promise<object>}
 */
export function createRemoteBashRouter({ runtime, targets, config, loadInventory, recordActivity } = {}) {
  return async function remoteBashRouter(exec, next) {
    if (!exec || exec.name !== BASH_TOOL_NAME) return next()
    const session = exec.agent?.session
    const key = session?.id ?? exec.agent?.id
    const binding = typeof key === 'string' ? targets?.get(key) : undefined
    if (!binding || !binding.active) {
      // Several `@server` mentions clear the active target. Running bash locally
      // in that state would execute commands meant for a server on the DSH host,
      // so make the model choose a target first.
      if (binding && Array.isArray(binding.candidates) && binding.candidates.length > 1) {
        return createErrorResult(
          `several servers were mentioned in this session (${binding.candidates.join(', ')}); ` +
            'call ssh_workbench_target({ server: "<name>" }) before running bash, or server: "local" to run locally',
          'TARGET_NOT_SELECTED',
        )
      }
      return next()
    }

    const args = exec.arguments ?? {}
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command.trim()) return next()

    let servers
    try {
      servers = loadInventory()
    } catch (error) {
      return createErrorResult(`cannot read the managed server inventory: ${describeError(error)}`, 'INVENTORY_UNAVAILABLE')
    }
    const server = findTarget(servers, binding.active)
    if (server === undefined) {
      return createErrorResult(
        `target "${binding.active}" is no longer in the managed inventory; call ${'ssh_workbench_target'} to pick another target or "local"`,
        'TARGET_NOT_FOUND',
      )
    }
    if (server.enabled === false) {
      return createErrorResult(
        `target "${server.name}" is disabled; call ssh_workbench_target to pick another target or "local"`,
        'TARGET_DISABLED',
      )
    }
    if (effectiveDialect(server) !== POSIX_PLATFORM) {
      return createErrorResult(
        `target "${server.name}" is a Windows server; the native bash tool only runs POSIX commands — use remote_pwsh for Windows targets`,
        'TARGET_PLATFORM_UNSUPPORTED',
      )
    }

    const workdir = applyWorkdir(command, args.workdir)
    if (workdir.error !== undefined) return createErrorResult(workdir.error, 'INVALID_WORKDIR')

    // A detached command returns only remote facts that survive across
    // transports: pid + log file. It is not registered in DSH's local jobs.
    if (args.run_in_background === true) {
      const startTimeout = Math.min(resolveTimeoutMs(args, config), 30000)
      let start
      try {
        start = await runtime.exec(server, buildPosixBackgroundCommand(workdir.command), {
          timeoutMs: startTimeout,
          signal: exec.signal,
          readOnly: false,
          cap: Number.isInteger(config?.maxOutputBytes) ? config.maxOutputBytes : undefined,
          stderrCap: Number.isInteger(config?.maxStderrBytes) ? config.maxStderrBytes : undefined,
        })
      } catch (error) {
        return createErrorResult(describeError(error), 'SSH_EXEC_FAILED')
      }
      try {
        recordActivity?.({ kind: 'exec', server: server.name, summary: `[background] ${command.slice(0, 190)}`, outcome: describeResultOutcome(start) })
      } catch {
        // Activity recording is best effort.
      }
      if (isTransportFailure(start)) {
        const detail = typeof start?.stderr === 'string' && start.stderr.trim() ? start.stderr.trim() : 'remote execution failed'
        return createErrorResult(detail, start?.errorCode ?? 'SSH_EXEC_FAILED')
      }
      const started = parseBackgroundStart(start.stdout)
      if (started.pid === undefined) {
        const detail = String(start?.stderr ?? '').trim() || String(start?.stdout ?? '').trim()
        return createErrorResult(`background start failed${detail ? `: ${detail}` : ''}`, 'REMOTE_BACKGROUND_FAILED')
      }
      const text = renderBackgroundStart({
        pid: started.pid,
        log: started.log,
        errLog: started.errLog,
        target: `${server.name} (${server.username}@${server.host}:${server.port})`,
        command,
        dialect: 'posix',
      })
      const synthetic = {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: text,
        stderr: '',
        truncated: { stdout: false, stderr: false },
      }
      return { value: toBashValue(synthetic, { cwd: `${server.name}:${workdir.cwd}`, timeoutMs: startTimeout }) }
    }

    const timeoutMs = resolveTimeoutMs(args, config)

    // Detect (and cache) whether the server can enforce a remote deadline, so
    // a timed-out call also stops the remote work instead of leaving it behind.
    let capability = { mode: 'none', shell: '/bin/sh' }
    try {
      if (typeof runtime.timeoutGuard === 'function') {
        const probed = await runtime.timeoutGuard(server)
        capability = typeof probed === 'string' ? { mode: probed } : (probed ?? capability)
      }
    } catch {
      capability = { mode: 'none', shell: '/bin/sh' }
    }
    const remoteCommand = wrapRemoteTimeout(workdir.command, timeoutMs, capability, {
      killAfterMs: config?.timeoutKillAfterMs,
    })

    let result
    try {
      result = await runtime.exec(server, remoteCommand, {
        timeoutMs,
        signal: exec.signal,
        readOnly: false,
        cap: Number.isInteger(config?.maxOutputBytes) ? config.maxOutputBytes : undefined,
        stderrCap: Number.isInteger(config?.maxStderrBytes) ? config.maxStderrBytes : undefined,
      })
    } catch (error) {
      return createErrorResult(describeError(error), 'SSH_EXEC_FAILED')
    }

    try {
      recordActivity?.({
        kind: 'exec',
        server: server.name,
        summary: command.slice(0, 200),
        outcome: describeResultOutcome(result),
      })
    } catch {
      // Activity recording is best effort.
    }

    if (isTransportFailure(result)) {
      const code = typeof result?.errorCode === 'string' && result.errorCode ? result.errorCode : 'SSH_EXEC_FAILED'
      const detail = typeof result?.stderr === 'string' && result.stderr.trim() ? result.stderr.trim() : 'remote execution failed'
      const suggestion = typeof result?.suggestedAction === 'string' && result.suggestedAction ? `\n${result.suggestedAction}` : ''
      return createErrorResult(`${detail}${suggestion}`, code)
    }

    // The cwd label is also what the native Bash card shows in its expanded
    // prompt; prefixing the target makes a card self-describing in multi-target
    // sessions without shadowing DSH's shipped Bash renderer.
    let value = toBashValue(result, { cwd: `${server.name}:${workdir.cwd}`, timeoutMs })
    const notices = []
    // One line after each target change: a card-level "where did this run" hint.
    if (binding.notifiedVersion !== binding.version && typeof targets?.markNotified === 'function') {
      notices.push(`[remote] target: ${server.name} (${server.username}@${server.host}:${server.port})`)
      targets.markNotified(key, binding.version)
    }
    if (result?.outcome === 'timeout') {
      notices.push(
        capability.mode === 'none'
          ? '[remote] client-side timeout only: this server has no usable `timeout` utility, so the remote process may still be running.'
          : `[remote] timeout: the remote command group was terminated (SIGTERM${capability.mode === 'kill' ? ', KILL after the remote deadline' : ''}).`,
      )
    }
    if (result?.outcome === 'cancelled') {
      notices.push(
        capability.mode === 'none'
          ? '[remote] cancelled: the SSH channel was closed, but this server has no usable `timeout` utility, so the remote process may still be running.'
          : '[remote] cancelled: the SSH channel was closed; the remote wrapper terminates the command at its deadline if it is still running.',
      )
    }
    if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
      notices.push('[remote] sandbox_permissions does not apply to managed servers; the command ran over SSH.')
    }
    if (notices.length > 0) {
      const text = value.stderr.text
      value = {
        ...value,
        stderr: { ...value.stderr, text: `${text}${text ? '\n' : ''}${notices.join('\n')}` },
      }
    }
    return { value }
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}
