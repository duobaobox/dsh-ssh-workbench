/**
 * Plugin-local known_hosts with strict-by-default trust.
 *
 * ssh2 verifies the host key with `hostHash: 'sha256'`; the verifier receives
 * the hex digest, so this store keeps `<address> sha256:<hex>` lines. Unknown
 * hosts are rejected unless the user explicitly trusts the fingerprint.
 */
import { knownHostsPath, readTextFile, writePrivateFile } from './paths.js'

function addressOf(server) {
  return `${server.host}:${server.port}`
}

function normalizeFingerprint(fingerprint) {
  const value = String(fingerprint ?? '').trim().toLowerCase()
  if (!value) return ''
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

function parse(text) {
  const map = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+)\s+(sha256:[0-9a-f]+)$/i.exec(line)
    if (match) map.set(match[1], match[2].toLowerCase())
  }
  return map
}

export function createKnownHosts({ file = knownHostsPath() } = {}) {
  const load = () => parse(readTextFile(file))
  const save = (map) => {
    const lines = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([address, fp]) => `${address} ${fp}`)
    writePrivateFile(file, `${lines.join('\n')}${lines.length ? '\n' : ''}`)
  }
  return {
    addressOf,
    /** `mode: 'strict'` rejects unknown hosts; `'accept-new'` records them (TOFU). */
    verify(server, fingerprint, mode = 'strict') {
      const address = addressOf(server)
      const normalized = normalizeFingerprint(fingerprint)
      if (!normalized) return false
      const map = load()
      const known = map.get(address)
      if (known) return known === normalized
      if (mode === 'accept-new') {
        map.set(address, normalized)
        save(map)
        return true
      }
      return false
    },
    trust(server, fingerprint) {
      const normalized = normalizeFingerprint(fingerprint)
      if (!normalized) throw new Error('a fingerprint is required')
      const map = load()
      map.set(addressOf(server), normalized)
      save(map)
    },
    revoke(server) {
      const map = load()
      const deleted = map.delete(addressOf(server))
      save(map)
      return deleted
    },
    list() {
      return [...load().entries()].map(([address, fingerprint]) => ({ address, fingerprint }))
    },
    has(server) {
      return load().has(addressOf(server))
    },
  }
}
