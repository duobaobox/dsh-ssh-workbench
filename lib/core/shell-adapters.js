/**
 * Shell adapters: one managed target dialect → the commands the plugin builds.
 *
 * A Host does not always ship a native shell tool for every target dialect.
 * Windows Desktop builds have `pwsh` but no `bash` (DSH disables `bash` by
 * platform), so remote POSIX execution must come from a plugin-owned tool
 * rather than from the native `bash` interception. Adapters keep everything
 * dialect-specific — quoting, working-directory prefix, timeout wrapper, exit
 * code propagation, user-facing labels — in one object so adding a dialect
 * never grows another branch inside a tool body.
 */
import { buildPosixBackgroundCommand } from './background.js'
import { normalizeDialect } from './dialect.js'
import { applyWorkdir, resolveTimeoutMs, wrapRemoteTimeout } from './remote-bash.js'
import { win32Adapter } from './win32-adapter.js'

/** Normalize the Host process platform to the two worlds the plugin cares about. */
export function hostPlatform(platform = process.platform) {
  return platform === 'win32' ? 'win32' : 'posix'
}

/**
 * POSIX adapter: Linux/Unix targets reached through the remote login shell.
 *
 * `remoteTimeout` means the target can run the coreutils `timeout` wrapper, so
 * a client-side deadline can also stop the remote process group.
 */
export const posixAdapter = {
  id: 'posix',
  platform: 'posix',
  toolName: 'remote_bash',
  label: 'Linux/Unix (POSIX)',
  remoteTimeout: true,
  supportsDialect: (dialect) => normalizeDialect(dialect) !== 'windows',
  unsupportedMessage: (server) =>
    `target "${server?.name ?? 'unknown'}" is a Windows server; remote_bash runs POSIX commands only — use remote_pwsh for Windows targets`,
  buildCommand: (command, workdir) => applyWorkdir(command, workdir),
  buildBackgroundCommand(command, workdir) {
    const built = applyWorkdir(command, workdir)
    if (built.error !== undefined) return built
    return { command: buildPosixBackgroundCommand(built.command), cwd: built.cwd }
  },
  wrapTimeout: wrapRemoteTimeout,
  resolveTimeoutMs,
}


export { win32Adapter }
