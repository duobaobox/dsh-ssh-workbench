/**
 * Server inventory: JSON document under the harness home.
 * Pure data logic; no DSH imports so it stays unit testable without the host
 * runtime.
 */
import { randomUUID } from 'node:crypto'
import { serversPath, writePrivateFile, readTextFile } from './paths.js'

const PLATFORMS = new Set(['posix', 'windows'])

function defaultShellFor(platform) {
  return platform === 'windows' ? 'powershell' : 'bash'
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => asString(item)).filter(Boolean)
}

/**
 * Validate and canonicalise one stored server record. Throws on records the
 * plugin could never execute, so a corrupt inventory fails loud at the
 * boundary instead of deep inside an SSH call.
 */
export function normalizeServer(raw, { idFactory = () => `srv_${randomUUID()}` } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('server record must be an object')
  const name = asString(raw.name)
  const host = asString(raw.host)
  if (!name) throw new Error('server.name is required')
  if (!host) throw new Error(`server "${name}" needs a host`)
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : 22
  const username = asString(raw.username, 'root') || 'root'
  const platform = PLATFORMS.has(raw.platform) ? raw.platform : 'posix'
  const authRef = normalizeAuthRef(raw.authRef, name)
  return {
    id: asString(raw.id, idFactory()) || idFactory(),
    name,
    host,
    port,
    username,
    platform,
    defaultShell: asString(raw.defaultShell, defaultShellFor(platform)) || defaultShellFor(platform),
    tags: asStringArray(raw.tags),
    description: asString(raw.description),
    enabled: raw.enabled !== false,
    facts: raw.facts && typeof raw.facts === 'object' ? { ...raw.facts } : {},
    authRef,
  }
}

function normalizeAuthRef(raw, serverName) {
  if (!raw || typeof raw !== 'object') throw new Error(`server "${serverName}" needs authRef`)
  if (raw.type === 'sshKey') {
    const keyPath = asString(raw.path)
    if (!keyPath) throw new Error(`server "${serverName}" sshKey authRef needs a path`)
    return { type: 'sshKey', path: keyPath }
  }
  if (raw.type === 'password') return { type: 'password' }
  throw new Error(`server "${serverName}" has unsupported authRef type`)
}

export function loadServers(file = serversPath()) {
  const text = readTextFile(file)
  if (!text.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`servers.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('servers.json must be an array')
  return parsed.map((record) => normalizeServer(record))
}

export function saveServers(servers, file = serversPath()) {
  const normalized = servers.map((record) => normalizeServer(record))
  writePrivateFile(file, `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}
