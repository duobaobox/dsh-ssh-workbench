/**
 * Resolve one managed-resource reference (name or id) against the inventory.
 *
 * v2.0 has no session-scoped active target: every remote tool call carries its
 * own `server`. Matching is case-insensitive so a hand-typed name still works,
 * but the resolved record is always the inventory record the runtime uses.
 */

/** @param {object[]} servers @param {string} ref */
export function findServerRef(servers, ref) {
  const value = String(ref ?? '').trim()
  if (!value) return undefined
  const wanted = value.toLowerCase()
  return (Array.isArray(servers) ? servers : []).find((server) => {
    if (!server || typeof server !== 'object') return false
    return (
      String(server.id ?? '').toLowerCase() === wanted ||
      String(server.name ?? '').toLowerCase() === wanted
    )
  })
}

/** Compact, model-facing list of enabled resource names. */
export function serverNameList(servers, limit = 20) {
  return (Array.isArray(servers) ? servers : [])
    .filter((server) => server && server.enabled !== false && server.name)
    .slice(0, Math.max(1, limit))
    .map((server) => String(server.name))
}

/**
 * Resolve and validate a server reference for a tool call.
 * Throws a model-readable error that lists the available resources.
 *
 * @param {object[]} servers
 * @param {string} ref
 * @param {{ label?: string, allowDisabled?: boolean }} [options]
 */
export function requireServerRef(servers, ref, options = {}) {
  const label = options.label ?? 'server'
  const value = String(ref ?? '').trim()
  if (!value) {
    throw new Error(`${label} is required; pass a managed resource name or id`)
  }
  if (value.toLowerCase() === 'local') {
    throw new Error(
      `${label} "${value}" is not a remote resource: the remote shell tools do not run on the local DSH host; use the native shell tool for local work`,
    )
  }
  const server = findServerRef(servers, value)
  if (server === undefined) {
    const names = serverNameList(servers)
    throw new Error(
      `unknown ${label} "${value}". Available resources: ${names.length > 0 ? names.join(', ') : '(none)'}`,
    )
  }
  if (server.enabled === false && options.allowDisabled !== true) {
    throw new Error(`${label} "${server.name}" is disabled`)
  }
  return server
}
