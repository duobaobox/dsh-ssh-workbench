/**
 * Detached ("background") remote commands.
 *
 * A remote process cannot be registered in DSH's local job registry, so a
 * background start returns the only facts that stay true across transports:
 * the remote pid and a log file. The model reads output with `tail` /
 * `Get-Content` and stops the process with `kill` / `Stop-Process`; that keeps
 * the behaviour identical on POSIX and Windows targets without pretending the
 * local `job_*` tools manage a remote process.
 *
 * The launcher itself must finish quickly and print machine-readable markers,
 * so the caller can distinguish "started" from "never started".
 */
import { quotePosix } from './posix-quote.js'

export const BG_PID_MARKER = '__SDH_BG_PID__'
export const BG_LOG_MARKER = '__SDH_BG_LOG__'
export const BG_ERR_MARKER = '__SDH_BG_ERR__'

/** Parse the marker lines out of the launcher's stdout. */
export function parseBackgroundStart(stdout) {
  const text = String(stdout ?? '')
  const pidMatch = /__SDH_BG_PID__(\d+)/.exec(text)
  const logMatch = /__SDH_BG_LOG__([^\r\n]+)/.exec(text)
  const errMatch = /__SDH_BG_ERR__([^\r\n]+)/.exec(text)
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined
  const log = logMatch ? logMatch[1].trim() : undefined
  const errLog = errMatch ? errMatch[1].trim() : undefined
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    log: log || undefined,
    errLog: errLog || undefined,
  }
}

/**
 * Build one POSIX launcher for an already workdir-prefixed command.
 *
 * `nohup` + redirected stdio is what keeps the child alive after the SSH
 * channel closes; the whole launcher runs under `sh -c` so a fish/csh login
 * shell only has to parse the simple outer command.
 *
 * Logs default to `~/.dsh/ssh-workbench/logs` instead of `/tmp`, because a
 * detached process may outlive the tmp cleanup window; `DSH_SSH_WORKBENCH_LOG_DIR`
 * overrides the directory remotely, and `/tmp` stays as the fallback when the
 * home directory is not writable.
 */
export function buildPosixBackgroundCommand(builtCommand) {
  const script = [
    'LOG_DIR=${DSH_SSH_WORKBENCH_LOG_DIR:-$HOME/.dsh/ssh-workbench/logs}',
    'mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR=/tmp',
    'LOG=$(mktemp "$LOG_DIR/dsh-ssh-workbench-bg.XXXXXX" 2>/dev/null || echo "$LOG_DIR/dsh-ssh-workbench-bg-$$-$(date +%s).log")',
    `nohup "\${SHELL:-/bin/sh}" -lc ${quotePosix(builtCommand)} >"$LOG" 2>&1 &`,
    `echo "${BG_PID_MARKER}$!"`,
    `echo "${BG_LOG_MARKER}$LOG"`,
  ].join('\n')
  return `sh -c ${quotePosix(script)}`
}

/** The pid/log/stop lines shared by every background result renderer. */
export function renderBackgroundDetails({ pid, log, errLog, dialect = 'posix' }) {
  const windows = dialect === 'windows'
  const lines = []
  if (pid !== undefined) lines.push(`pid: ${pid}`)
  if (log) lines.push(`log: ${log}`)
  if (errLog) lines.push(`stderr log: ${errLog}`)
  const logPath = log ?? '<log path from the launcher output>'
  lines.push(
    windows
      ? `read output: Get-Content -LiteralPath '${logPath.replace(/'/g, "''")}' -Wait`
      : `read output: tail -f ${quotePosix(logPath)}`,
  )
  if (pid !== undefined) lines.push(windows ? `stop: Stop-Process -Id ${pid} -Force` : `stop: kill ${pid}`)
  lines.push('The process is detached from this tool call: timeoutMs does not apply and it keeps running until it exits or is stopped.')
  return lines
}

/** One model-facing description of a started background process. */
export function renderBackgroundStart({ pid, log, errLog, target, command, dialect = 'posix' }) {
  const lines = [`background: started${target ? ` on ${target}` : ''}`, `command: ${command}`]
  lines.push(...renderBackgroundDetails({ pid, log, errLog, dialect }))
  return lines.join('\n')
}
