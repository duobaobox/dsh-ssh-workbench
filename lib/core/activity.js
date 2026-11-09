/**
 * Local, bounded activity log for the overview page (not an audit log).
 *
 * This is NOT an audit system: entries are best-effort, newest-first, and
 * capped so the file cannot grow without bound. A failed write never fails the
 * operation that produced the entry.
 */
import { activityPath, readTextFile, writePrivateFile } from './paths.js'

export const MAX_ACTIVITY_ENTRIES = 200

/**
 * Human-readable activity outcome for one command result.
 *
 * The overview must distinguish "the command ran and returned non-zero" from
 * "the transport failed": `cat missing-file` is `exit 1`, `docker` on a host
 * without Docker is `exit 127 (COMMAND_NOT_FOUND)`, while a dropped connection
 * is `failed (CONNECT_TIMEOUT)`. Without this, benign non-zero exits look like
 * remote failures.
 */
export function describeResultOutcome(result) {
  if (!result || typeof result !== 'object') return 'unknown'
  if (result.outcome === 'success') return 'success'
  const code = typeof result.errorCode === 'string' && result.errorCode ? result.errorCode : ''
  const hasExit = result.exitCode !== null && result.exitCode !== undefined
  if (hasExit) return code && code !== 'EXEC_FAILED' ? `exit ${result.exitCode} (${code})` : `exit ${result.exitCode}`
  if (code) return `${result.outcome ?? 'failed'} (${code})`
  return String(result.outcome ?? 'failed')
}

export function createActivityStore({ file = activityPath(), maxEntries = MAX_ACTIVITY_ENTRIES } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('maxEntries must be a positive safe integer')

  function load() {
    const text = readTextFile(file, '[]')
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') : []
    } catch {
      return []
    }
  }

  function save(entries) {
    try {
      writePrivateFile(file, `${JSON.stringify(entries, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  }

  /**
   * Prepend one entry. `at` defaults to now; unknown fields are kept so callers
   * can add outcome/latency without touching the store.
   * @returns the normalized entry (even when the write failed).
   */
  function append(entry) {
    const normalized = {
      at: typeof entry?.at === 'string' ? entry.at : new Date().toISOString(),
      kind: String(entry?.kind ?? 'operation'),
      ...(Array.isArray(entry?.servers) ? { servers: entry.servers.map(String) } : {}),
      ...(entry?.server !== undefined ? { server: String(entry.server) } : {}),
      ...(entry?.summary !== undefined ? { summary: String(entry.summary) } : {}),
      ...(entry?.outcome !== undefined ? { outcome: String(entry.outcome) } : {}),
    }
    const next = [normalized, ...load()].slice(0, maxEntries)
    save(next)
    return normalized
  }

  /** @returns newest-first entries, at most `limit`. */
  function list(limit = 20) {
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, maxEntries) : 20
    return load().slice(0, bounded)
  }

  function clear() {
    return save([])
  }

  return { append, list, clear, maxEntries }
}
