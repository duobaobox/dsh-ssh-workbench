/**
 * Windows (PowerShell) shell adapter.
 *
 * Windows targets expose an SSH server (Microsoft OpenSSH Server) whose login
 * shell is either `cmd.exe` or PowerShell. A command is therefore not sent as
 * a raw string: it is wrapped into a small PowerShell script, encoded as
 * UTF-16LE base64 and executed with `-EncodedCommand`, which removes every
 * quoting/escaping failure mode and works no matter which default shell sshd
 * picked.
 *
 * The wrapper also forces UTF-8 console output (Windows defaults to an OEM
 * code page or UTF-16, which would arrive at ssh2 as mojibake) and propagates
 * the real exit code (`-EncodedCommand` alone exits 0 for a failed cmdlet).
 */
import { BG_ERR_MARKER, BG_LOG_MARKER, BG_PID_MARKER } from './background.js'
import { normalizeDialect } from './dialect.js'
import { resolveTimeoutMs } from './remote-bash.js'

const POWERSHELL_UTF8 = [
  "$ErrorActionPreference = 'Continue'",
  '$__sdhUtf8 = New-Object System.Text.UTF8Encoding $false',
  '[Console]::OutputEncoding = $__sdhUtf8',
  '$OutputEncoding = $__sdhUtf8',
].join('; ')

/**
 * Deterministic exit status for a PowerShell script:
 * - a failed statement without a native exit code → 1;
 * - a failed/native command with an exit code → that code;
 * - everything else → 0.
 */
const EXIT_SUFFIX = [
  'if (-not $?) { if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit [int]$LASTEXITCODE }; exit 1 }',
  'if ($LASTEXITCODE -ne $null) { exit [int]$LASTEXITCODE }',
  'exit 0',
].join('; ')

/** PowerShell single-quoted literal. */
export function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Classify one model-supplied workdir.
 * @returns {{ kind: 'none'|'home'|'absolute'|'relative', path?: string, label: string } | { error: string }}
 */
export function normalizeWindowsWorkdir(workdir) {
  const raw = typeof workdir === 'string' ? workdir.trim() : ''
  if (!raw) return { kind: 'none', label: '~' }
  if (raw.includes('\n') || raw.includes('\r')) return { error: 'workdir must not contain newlines' }
  if (raw === '~') return { kind: 'home', label: '~' }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const rest = raw.slice(2)
    if (!rest) return { kind: 'home', label: '~' }
    return { kind: 'relative', path: rest, label: `~/${rest.replace(/\\/g, '/')}` }
  }
  // Drive path, UNC path, or a root-relative POSIX-style path (Windows treats
  // `/foo` as the current drive root).
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    return { kind: 'absolute', path: raw, label: raw }
  }
  return { kind: 'relative', path: raw, label: `~/${raw.replace(/\\/g, '/')}` }
}

function locationScript(dir) {
  if (dir.kind === 'none') return ''
  const literal =
    dir.kind === 'home'
      ? '$HOME'
      : dir.kind === 'relative'
        ? `(Join-Path $HOME ${quotePowerShell(dir.path)})`
        : quotePowerShell(dir.path)
  return `try { Set-Location -LiteralPath ${literal} -ErrorAction Stop } catch { Write-Error ('cannot change directory: ' + $_.Exception.Message); exit 2 }`
}

/** The PowerShell executable to invoke on the target. */
function powershellExe(server) {
  const shell = String(server?.defaultShell ?? '')
  return /pwsh/i.test(shell) ? 'pwsh.exe' : 'powershell.exe'
}

/** Wrap a PowerShell script into one SSH command line. */
export function buildPowerShellInvocation(script, server) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64')
  return `${powershellExe(server)} -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

export const win32Adapter = {
  id: 'win32',
  platform: 'windows',
  toolName: 'remote_pwsh',
  label: 'Windows/PowerShell',
  // No POSIX `timeout` utility on Windows: the deadline is client-side only.
  remoteTimeout: false,
  supportsDialect: (dialect) => normalizeDialect(dialect) === 'windows',
  unsupportedMessage: (server) =>
    `target "${server?.name ?? 'unknown'}" is a POSIX server; remote_pwsh runs PowerShell on Windows targets — use remote_bash for POSIX targets`,
  buildCommand(command, workdir, server) {
    const dir = normalizeWindowsWorkdir(workdir)
    if (dir.error !== undefined) return dir
    const script = [POWERSHELL_UTF8, locationScript(dir), String(command ?? ''), EXIT_SUFFIX]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('\n')
    return { command: buildPowerShellInvocation(script, server), cwd: dir.label }
  },
  /**
   * Start a detached PowerShell script and report its pid plus log files.
   *
   * The inner script (the same one a foreground call would run) is launched by
   * `Start-Process`, which detaches it from the SSH channel; stdout/stderr are
   * redirected into files the model can read with `Get-Content -Wait`.
   */
  buildBackgroundCommand(command, workdir, server) {
    const dir = normalizeWindowsWorkdir(workdir)
    if (dir.error !== undefined) return dir
    const inner = [POWERSHELL_UTF8, locationScript(dir), String(command ?? ''), EXIT_SUFFIX]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('\n')
    const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64')
    const exe = quotePowerShell(powershellExe(server))
    const outer = [
      '$__sdhLog = Join-Path $env:TEMP ("dsh-ssh-workbench-bg-" + [Guid]::NewGuid().ToString("N") + ".log")',
      '$__sdhErr = "$__sdhLog.err"',
      `$__sdhExe = ${exe}`,
      `$__sdhArgs = @('-NoProfile','-NonInteractive','-EncodedCommand','${innerEncoded}')`,
      '$__sdhProc = Start-Process -FilePath $__sdhExe -ArgumentList $__sdhArgs -RedirectStandardOutput $__sdhLog -RedirectStandardError $__sdhErr -WindowStyle Hidden -PassThru',
      `Write-Output "${BG_PID_MARKER}$($__sdhProc.Id)"`,
      `Write-Output "${BG_LOG_MARKER}$__sdhLog"`,
      `Write-Output "${BG_ERR_MARKER}$__sdhErr"`,
    ].join('\n')
    return { command: buildPowerShellInvocation(outer, server), cwd: dir.label }
  },
  // The scripts already carry their own exit code handling; there is no
  // remote deadline utility to wrap around them.
  wrapTimeout: (command) => String(command ?? ''),
  resolveTimeoutMs,
  timeoutNotice: () =>
    '[remote] client-side timeout only: this Windows target has no POSIX `timeout` wrapper, so the PowerShell process may still be running.',
  cancelNotice: () =>
    '[remote] cancelled: the SSH channel was closed, but the PowerShell process may still be running.',
}
