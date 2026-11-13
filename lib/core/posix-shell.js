/**
 * Shared POSIX remote-shell helpers.
 *
 * Pure command construction used by `remote_bash` and `remote_exec`; the
 * native local `bash` tool never reaches this module.
 */
import { quotePosix } from './posix-quote.js'

const MIN_TIMEOUT_MS = 1000

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
