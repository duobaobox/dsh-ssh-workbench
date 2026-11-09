/**
 * Filesystem layout for dsh-ssh-workbench.
 *
 * Everything the plugin persists lives under the harness home so a profile
 * export/import carries it, and so tests can redirect it with DSH_SSH_WORKBENCH_DIR.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** New storage directory name, plus the pre-1.6.4 name for one-time migration. */
const DIR_NAME = 'ssh-workbench'
const LEGACY_DIR_NAME = 'ssh-ops'

/**
 * Directory that holds servers, credentials, known hosts and preferences.
 *
 * `DSH_SSH_WORKBENCH_DIR` wins in tests and for power users. Otherwise the
 * plugin uses `$DSH_HOME/ssh-workbench` and, on the first launch after the
 * 1.6.4 rename, moves an existing `$DSH_HOME/ssh-ops` directory into place so
 * credentials and trusted host keys are not lost. If the move fails (for
 * example because of permissions) the legacy directory stays in use.
 */
export function workbenchDir() {
  const configured = process.env.DSH_SSH_WORKBENCH_DIR
  if (configured) return configured
  const current = path.join(dshHome(), DIR_NAME)
  if (!fs.existsSync(current)) {
    const legacy = path.join(dshHome(), LEGACY_DIR_NAME)
    if (fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, current)
      } catch {
        return legacy
      }
    }
  }
  return current
}

export function serversPath() {
  return path.join(workbenchDir(), 'servers.json')
}

export function activityPath() {
  return path.join(workbenchDir(), 'activity.json')
}

export function knownHostsPath() {
  return path.join(workbenchDir(), 'known_hosts')
}

export function secretsPath() {
  return path.join(workbenchDir(), 'secrets.json')
}

export function secretsKeyPath() {
  return path.join(workbenchDir(), 'secrets.key')
}

export function prefsPath() {
  return path.join(workbenchDir(), 'prefs.json')
}

/** Create a private directory (0700) if missing. */
function ensurePrivateDir(dir = workbenchDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Windows cannot honour POSIX modes; the mkdir mode is best effort there.
  }
  return dir
}

/** Write a private file atomically (temp file + rename, 0600). */
export function writePrivateFile(file, text) {
  ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    // best effort on Windows
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // best effort on Windows
  }
}

export function readTextFile(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}
