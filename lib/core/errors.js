/**
 * Shared SSH error taxonomy.
 *
 * Kept in its own module so the transport broker and the tool-facing runtime
 * can share the same `SshError` class without an import cycle.
 */

export class SshError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SshError'
    this.code = code
    Object.assign(this, extra)
  }
}

export function normalizeError(error, fingerprint) {
  // Keep structured errors intact: a missing private key is an auth problem,
  // not a generic execution failure.
  if (error instanceof SshError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (/host key verification failed|host denied \(verification failed\)|hostVerifier/i.test(message)) {
    return new SshError('HOST_KEY_UNKNOWN', message, { fingerprint })
  }
  if (/all configured authentication methods failed|authentication failed|permission denied/i.test(message)) {
    return new SshError('AUTH_FAILED', message)
  }
  if (/timed out while waiting|connect timeout|timeout/i.test(message) && !/command/i.test(message)) {
    return new SshError('CONNECT_TIMEOUT', message)
  }
  if (/econnrefused|ehostunreach|enotfound|getaddrinfo|network unreachable|econnreset/i.test(message) || /^(ECONN|ENOTFOUND|EHOST)/.test(code)) {
    return new SshError('NETWORK', message)
  }
  return new SshError('EXEC_FAILED', message)
}

export function suggestedActionFor(code) {
  switch (code) {
    case 'AUTH_MISSING':
      return 'Set the SSH password (or switch to key auth) in Settings → SSH Workbench → managed resources.'
    case 'AUTH_FAILED':
      return 'Check the username, private key path, or password for this resource.'
    case 'HOST_KEY_UNKNOWN':
      return 'Compare the shown fingerprint with the server operator, then trust it in Settings → SSH Workbench.'
    case 'CONNECT_TIMEOUT':
      return 'Check the host/port and network path; raise connectTimeoutMs if the host is slow.'
    case 'NETWORK':
      return 'The host is unreachable: check DNS, routing, VPN, or the SSH port.'
    case 'TIMEOUT':
      return 'The command exceeded its timeout. Narrow the command or raise timeoutMs.'
    case 'CANCELLED':
      return 'The operation was cancelled.'
    case 'COMMAND_NOT_FOUND':
      return 'The remote shell reported a missing command; check the remote PATH.'
    case 'SFTP_FAILED':
      return 'The SFTP operation failed; check the remote path, permissions, and the SSH server SFTP subsystem.'
    case 'COMMAND_NOT_EXECUTABLE':
      return 'The file exists but is not executable (exit 126); check the shebang and chmod +x.'
    case 'PERMISSION_DENIED':
      return 'Permission denied: check the remote user, file ownership/mode, or use a privileged account.'
    case 'DISK_FULL':
      return 'The remote filesystem is full or over quota; free space (df -h) and retry.'
    case 'READ_ONLY_FS':
      return 'The remote filesystem is read-only; remount it read-write or pick another path.'
    case 'INTERRUPTED':
      return 'The command was interrupted (exit 130 / SIGINT).'
    case 'KILLED':
      return 'The command was killed (exit 137 / SIGKILL); it may have hit the OOM killer or a manual kill.'
    default:
      return 'Inspect stderr for details, or run a smaller diagnostic command first.'
  }
}

/**
 * Classify a failed exec result into the most specific error code we can infer
 * from the exit status and stderr. Used for both `errorCode` and the
 * human-readable suggestion.
 */
export function classifyExecFailure({ exitCode, stderr, signal } = {}) {
  const text = String(stderr ?? '')
  if (/command not found/i.test(text)) return 'COMMAND_NOT_FOUND'
  if (/permission denied/i.test(text)) return 'PERMISSION_DENIED'
  if (/no space left on device|disk quota exceeded/i.test(text)) return 'DISK_FULL'
  if (/read-only file system/i.test(text)) return 'READ_ONLY_FS'
  if (signal) return 'KILLED'
  switch (exitCode) {
    case 126: return 'COMMAND_NOT_EXECUTABLE'
    case 127: return 'COMMAND_NOT_FOUND'
    case 130: return 'INTERRUPTED'
    case 137: return 'KILLED'
    default: return 'EXEC_FAILED'
  }
}

export function errorResult(code, message, extra = {}) {
  return {
    outcome: code === 'CANCELLED' ? 'cancelled' : code === 'TIMEOUT' ? 'timeout' : 'failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: message,
    durationMs: 0,
    truncated: { stdout: false, stderr: false },
    errorCode: code,
    suggestedAction: suggestedActionFor(code),
    ...extra,
  }
}

/**
 * `grep`/`diff`/`pgrep` exit 1 for "no match" / "files differ": that is a
 * normal answer, not an execution failure. Reinterpret it only when the whole
 * command was classified read-only and the remote wrote nothing to stderr —
 * a read-only command that exits 1 with a silent stderr is almost certainly
 * reporting content, not a broken execution.
 */
export function isBenignReadOnlyExit({ readOnly, exitCode, stderr, signal } = {}) {
  return readOnly === true && exitCode === 1 && !signal && !String(stderr ?? '').trim()
}

/** Normalize any SFTP-layer error into a structured `SFTP_FAILED` SshError. */
export function toSftpError(error) {
  if (error instanceof SshError) {
    return error.code === 'EXEC_FAILED' ? new SshError('SFTP_FAILED', error.message) : error
  }
  return new SshError('SFTP_FAILED', error instanceof Error ? error.message : String(error))
}

/** Connection-level failure detection (used to evict a dead pooled connection). */
export function isConnectionLevelError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true
  return /not\s+connected|connection\s+(lost|reset|closed|force\s+closed)|socket\s+closed|force\s+closed|keepalive\s+timeout|read\s+ec\w+|broken\s+pipe|econn\w+|epipe|etimedout/i.test(
    message,
  )
}
