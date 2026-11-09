/**
 * JSON data plane for the settings page and the right-sidebar panel.
 *
 * One handler serves both carriers:
 *  - Web: `ctx.webServer.register({kind:'prefix', path:'/dsh-ssh-workbench'})`.
 *  - Desktop: the Electron shell has no webServer, so the same operations are
 *    registered as exact Connection Fetch routes under `/api/dsh-ssh-workbench/*`
 *    (GET/POST only, matching the host's route registry).
 *
 * Every browser-facing request is fenced by `ctx.connection.requestRejection`
 * when the Connection service exists.
 */
import { Readable } from 'node:stream'

import { createLocalFileApi, LOCAL_FILE_REF } from './core/local-file-api.js'
import { effectiveDialect } from './core/dialect.js'
import { SshError } from './core/errors.js'

const PREFIX = '/dsh-ssh-workbench'
const MAX_BODY = 8 * 1024 * 1024

/** Marker error for request-level failures that carry their own HTTP status. */
class HttpStatusError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

/**
 * Add user-facing operation/path context to a filesystem failure while keeping
 * the original error type (`SshError` code, Node `code`). B6/B12: a bare
 * `Failure` or `No such file` from SFTP tells the user nothing.
 */
function contextualFileError(operation, remotePath, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const label = typeof remotePath === 'string' && remotePath ? ` "${remotePath}"` : ''
  const message = `${operation}${label} failed: ${detail}`
  if (error instanceof SshError) {
    const wrapped = new SshError(error.code, message)
    if (error.fingerprint !== undefined) wrapped.fingerprint = error.fingerprint
    return wrapped
  }
  if (error instanceof HttpStatusError) return error
  const wrapped = new Error(message)
  wrapped.cause = error
  if (error && typeof error === 'object' && typeof error.code === 'string') wrapped.code = error.code
  return wrapped
}

/** Exact routes exposed to the Desktop Connection Fetch carrier. */
export const FETCH_ROUTES = [
  { path: `${PREFIX}/servers`, methods: ['GET'] },
  { path: `${PREFIX}/state`, methods: ['GET'] },
  { path: `${PREFIX}/known-hosts`, methods: ['GET'] },
  { path: `${PREFIX}/target`, methods: ['GET'] },
  { path: `${PREFIX}/activity`, methods: ['GET'] },
  { path: `${PREFIX}/activity/clear`, methods: ['POST'] },
  { path: `${PREFIX}/prefs`, methods: ['GET', 'POST'] },
  { path: `${PREFIX}/terminal/open`, methods: ['POST'] },
  { path: `${PREFIX}/terminal/input`, methods: ['POST'] },
  { path: `${PREFIX}/terminal/resize`, methods: ['POST'] },
  { path: `${PREFIX}/terminal/close`, methods: ['POST'] },
  { path: `${PREFIX}/terminal/read`, methods: ['GET'] },
  { path: `${PREFIX}/localfs/root`, methods: ['GET'] },
  { path: `${PREFIX}/sftp/home`, methods: ['GET', 'POST'] },
  { path: `${PREFIX}/server/create`, methods: ['POST'] },
  { path: `${PREFIX}/server/update`, methods: ['POST'] },
  { path: `${PREFIX}/server/remove`, methods: ['POST'] },
  { path: `${PREFIX}/server/test`, methods: ['POST'] },
  { path: `${PREFIX}/server/warm`, methods: ['POST'] },
  { path: `${PREFIX}/server/trust`, methods: ['POST'] },
  { path: `${PREFIX}/server/credential`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/list`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/read`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/open-write`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/write-chunk`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/close-write`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/open-read`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/read-chunk`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/close-read`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/mkdir`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/remove`, methods: ['POST'] },
  { path: `${PREFIX}/sftp/rename`, methods: ['POST'] },
]

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        // 413, matching the Desktop Connection Fetch carrier below.
        reject(new HttpStatusError(413, 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.setHeader?.('cache-control', 'no-store')
  for (const [key, value] of Object.entries(headers)) res.setHeader?.(key, value)
  res.end(text)
}

function errorBody(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

function parsePath(url) {
  const parsed = new URL(url, 'http://localhost')
  return { pathname: parsed.pathname, searchParams: parsed.searchParams }
}

function resolveRef(value) {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * @param {object} deps
 * @param {() => object[]} deps.loadServers
 * @param {(servers: object[]) => object[]} deps.saveServers
 * @param {object} deps.runtime
 * @param {object} deps.secrets
 * @param {object} deps.knownHosts
 * @param {{ load: () => object, save: (patch: object) => object }} [deps.prefs]
 * @param {object} [deps.terminals] interactive terminal hub
 * @param {object} [deps.localfs] local filesystem browser
 * @param {() => object} deps.publicConfig
 * @param {{ append: Function, list: Function }} [deps.activity] bounded local activity store
 */
export function createRoutes({ loadServers, saveServers, runtime, secrets, knownHosts, targets, refreshFacts, prefs, terminals, localfs, publicConfig, activity }) {
  const prefsApi = prefs ?? {
    load: () => ({ sidebar: true }),
    save: () => ({ sidebar: true }),
  }
  // Reuse the files panel for the local workspace by giving it the same
  // method surface as the SSH runtime under the synthetic `__local__` ref.
  const localFiles = localfs ? createLocalFileApi(localfs) : null
  // Small UI-facing caches: a repeated directory view or connection test should
  // not pay another round trip. Write operations invalidate the affected server.
  const TEST_TTL_MS = 30000
  const DIR_TTL_MS = 5000
  const testCache = new Map()
  const dirCache = new Map()
  const dirKey = (server, path) => `${server.id}:${path}`
  const clearDirCache = (serverId) => {
    for (const key of [...dirCache.keys()]) if (key.startsWith(`${serverId}:`)) dirCache.delete(key)
  }
  const invalidateServer = (serverId) => {
    testCache.delete(serverId)
    clearDirCache(serverId)
    try {
      runtime.invalidate?.(serverId)
    } catch {
      // pool invalidation is best effort
    }
    // A server edit/removal must not leave uploads/downloads writing through a
    // connection to the old host/credentials.
    try {
      void Promise.resolve(runtime.closeTransferSessionsForServer?.(serverId)).catch(() => {})
    } catch {
      // session cleanup is best effort
    }
  }

  function stateRows(servers) {
    return servers.map((server) => {
      const hasSecret =
        server.authRef.type === 'password' ? secrets.has(`server:${server.id}:password`) : true
      return {
        id: server.id,
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        platform: server.platform,
        dialect: effectiveDialect(server),
        tags: server.tags,
        description: server.description,
        defaultShell: server.defaultShell,
        enabled: server.enabled,
        keyPath: server.authRef.type === 'sshKey' ? server.authRef.path : undefined,
        authType: server.authRef.type,
        credentialConfigured: hasSecret,
        hostKeyKnown: knownHosts.has(server),
        hostname: server.facts?.hostname,
        facts: server.facts
          ? {
              hostname: server.facts.hostname,
              kernel: server.facts.kernel,
              uptime: server.facts.uptime,
              rootDisk: server.facts.rootDisk,
              collectedAt: server.facts.collectedAt,
            }
          : undefined,
      }
    })
  }

  function findTarget(servers, ref) {
    return servers.find((server) => server.id === ref || server.name === ref)
  }

  function logActivity(entry) {
    try {
      activity?.append(entry)
    } catch {
      // activity recording is best effort
    }
  }

  /** Wrap one filesystem operation so failures name the operation and path. */
  async function fileOp(operation, remotePath, action) {
    try {
      return await action()
    } catch (error) {
      throw contextualFileError(operation, remotePath, error)
    }
  }

  /**
   * Local "home" for the files panel: the canonical workspace root.
   *
   * `localFileApi.sftpHome()` is the intended interface (added by the localfs
   * workstream); fall back to `localfs.rootReal()` and finally the lexical
   * `localfs.root()` so this route keeps working while the two land.
   */
  async function localHomeDirectory() {
    const sources = []
    if (typeof localFiles?.sftpHome === 'function') sources.push(() => localFiles.sftpHome())
    if (typeof localfs?.rootReal === 'function') sources.push(() => localfs.rootReal())
    if (typeof localfs?.root === 'function') sources.push(() => localfs.root())
    if (sources.length === 0) throw new Error('local files are unavailable on this host')
    let lastMessage
    for (const source of sources) {
      try {
        const value = await source()
        if (typeof value === 'string' && value.trim()) return value
        lastMessage = 'the local workspace root is empty'
      } catch (error) {
        lastMessage = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`the local workspace root is unavailable${lastMessage ? `: ${lastMessage}` : ''}`)
  }

  async function remoteHomeDirectory(server) {
    if (typeof runtime.sftpHome !== 'function') {
      throw new Error('home directory lookup is unavailable on this host')
    }
    const home = await runtime.sftpHome(server)
    if (typeof home !== 'string' || !home.trim()) throw new Error('the server returned an empty home directory')
    return home
  }

  /** GET/POST /sftp/home → `{ ok:true, result:{ home } }` (U5). */
  async function serveSftpHome(res, ref) {
    if (!ref) return send(res, 400, { ok: false, error: 'ref is required' })
    try {
      if (ref === LOCAL_FILE_REF) {
        const home = await localHomeDirectory()
        return send(res, 200, { ok: true, result: { home } })
      }
      const server = findTarget(loadServers(), ref)
      if (!server) return send(res, 404, { ok: false, error: `unknown server "${ref}"` })
      const home = await remoteHomeDirectory(server)
      return send(res, 200, { ok: true, result: { home } })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return send(res, 502, { ok: false, error: `could not resolve the home directory for "${ref}": ${detail}` })
    }
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    const { pathname, searchParams } = parsePath(req.url)
    const rel = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) || '/' : pathname

    try {
      if (req.method === 'GET' && rel === '/servers') {
        return send(res, 200, { ok: true, servers: loadServers() })
      }
      if (req.method === 'GET' && rel === '/state') {
        return send(res, 200, { ok: true, servers: stateRows(loadServers()), config: publicConfig() })
      }
      if (req.method === 'GET' && rel === '/known-hosts') {
        return send(res, 200, { ok: true, entries: knownHosts.list() })
      }
      if (req.method === 'GET' && rel === '/target') {
        const session = String(searchParams.get('session') ?? '')
        const state = session && typeof targets?.get === 'function' ? targets.get(session) : undefined
        return send(res, 200, {
          ok: true,
          target: state?.active ?? null,
          candidates: state?.candidates ?? [],
          version: state?.version ?? 0,
        })
      }
      if (req.method === 'GET' && rel === '/activity') {
        const entries = typeof activity?.list === 'function' ? activity.list(30) : []
        return send(res, 200, { ok: true, entries })
      }
      if (req.method === 'POST' && rel === '/activity/clear') {
        const cleared = typeof activity?.clear === 'function' ? activity.clear() : false
        return send(res, 200, { ok: true, cleared })
      }

      if (req.method === 'GET' && rel === '/prefs') {
        return send(res, 200, { ok: true, prefs: prefsApi.load() })
      }

      if (req.method === 'GET' && rel === '/terminal/read') {
        const session = String(searchParams.get('session') ?? '')
        if (!session) return send(res, 400, { ok: false, error: 'session is required' })
        if (!terminals) return send(res, 503, { ok: false, error: 'terminals are unavailable on this host' })
        const cursor = Number.parseInt(searchParams.get('cursor') ?? '0', 10)
        const waitMs = Number.parseInt(searchParams.get('wait') ?? '0', 10)
        return send(res, 200, { ok: true, result: await terminals.read(session, { cursor, waitMs }) })
      }

      if (req.method === 'GET' && rel === '/localfs/root') {
        if (!localfs) return send(res, 503, { ok: false, error: 'local files are unavailable on this host' })
        // S3: list()/entry paths are canonicalized through realpath, so the
        // navigation root handed to the client must use the same form.
        const root = typeof localfs.rootReal === 'function'
          ? await localfs.rootReal()
          : await Promise.resolve(localfs.root())
        return send(res, 200, { ok: true, result: { root } })
      }
      if (req.method === 'GET' && rel === '/sftp/home') {
        const ref = resolveRef(searchParams.get('ref') ?? searchParams.get('server') ?? searchParams.get('name'))
        return await serveSftpHome(res, ref)
      }
      if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' })
      const body = await readBody(req)

      if (rel === '/sftp/home') {
        const ref = resolveRef(
          body.ref ?? body.server ?? body.name ?? searchParams.get('ref') ?? searchParams.get('server') ?? searchParams.get('name'),
        )
        return await serveSftpHome(res, ref)
      }

      if (rel === '/prefs') {
        if (typeof body.sidebar !== 'boolean') {
          return send(res, 400, { ok: false, error: 'prefs.sidebar must be a boolean' })
        }
        return send(res, 200, { ok: true, prefs: prefsApi.save({ sidebar: body.sidebar }) })
      }

      if (rel === '/terminal/open') {
        if (!terminals) return send(res, 503, { ok: false, error: 'terminals are unavailable on this host' })
        const kind = body.kind === 'remote' ? 'remote' : 'local'
        let server
        if (kind === 'remote') {
          server = findTarget(loadServers(), body.ref)
          if (!server) return send(res, 404, { ok: false, error: `unknown resource "${String(body.ref ?? '')}"` })
          if (server.enabled === false) return send(res, 400, { ok: false, error: `resource "${server.name}" is disabled` })
        }
        const opened = await terminals.open({
          kind,
          server,
          cols: body.cols,
          rows: body.rows,
          cwd: typeof body.cwd === 'string'
            ? body.cwd
            : (kind === 'local' && localfs ? await Promise.resolve(localfs.root()) : undefined),
        })
        return send(res, 200, { ok: true, result: opened })
      }
      if (rel === '/terminal/input') {
        if (!terminals) return send(res, 503, { ok: false, error: 'terminals are unavailable on this host' })
        const accepted = terminals.input(String(body.session ?? ''), String(body.data ?? ''))
        return send(res, accepted ? 200 : 404, { ok: accepted, accepted })
      }
      if (rel === '/terminal/resize') {
        if (!terminals) return send(res, 503, { ok: false, error: 'terminals are unavailable on this host' })
        const accepted = terminals.resize(String(body.session ?? ''), body.cols, body.rows)
        return send(res, accepted ? 200 : 404, { ok: accepted, accepted })
      }
      if (rel === '/terminal/close') {
        if (!terminals) return send(res, 200, { ok: true, closed: false })
        return send(res, 200, { ok: true, closed: terminals.close(String(body.session ?? '')) })
      }
      if (rel === '/server/create') {
        const record = body.record ?? body
        const saved = saveServers([...loadServers(), record])
        logActivity({ kind: 'server-create', server: String(record.name ?? ''), outcome: 'saved' })
        return send(res, 200, { ok: true, server: saved.find((server) => server.name === record.name) ?? saved.at(-1) })
      }

      // Chunked transfer sessions: the client holds a session id, so these
      // routes do not take a server ref. They must run before ref resolution.
      const sessionId = typeof body.session === 'string' ? body.session : ''
      const localTransfer = localFiles && sessionId.startsWith('loc') ? localFiles : null
      if (rel === '/sftp/write-chunk') {
        if (!sessionId) return send(res, 400, { ok: false, error: 'session is required' })
        // B10: offset used to be silently coerced to 0 by the runtime, which
        // could corrupt a resumed upload; it must be an explicit non-negative
        // integer from the client.
        if (!Number.isInteger(body.offset) || body.offset < 0) {
          return send(res, 400, { ok: false, error: 'offset must be a non-negative integer' })
        }
        if (typeof body.contentBase64 !== 'string' || !body.contentBase64) {
          return send(res, 400, { ok: false, error: 'contentBase64 is required' })
        }
        const buffer = Buffer.from(body.contentBase64, 'base64')
        if (buffer.length > 4 * 1024 * 1024) return send(res, 413, { ok: false, error: 'chunk too large (4 MiB limit)' })
        const api = localTransfer ?? runtime
        const result = await fileOp('write chunk', undefined, () => api.sftpWriteChunk(sessionId, body.offset, buffer))
        return send(res, 200, { ok: true, result })
      }
      if (rel === '/sftp/close-write') {
        if (!sessionId) return send(res, 400, { ok: false, error: 'session is required' })
        const api = localTransfer ?? runtime
        if (body.abort === true) {
          const result = await fileOp('abort upload', undefined, () => api.sftpCloseTransfer(sessionId, { verify: false }))
          return send(res, 200, { ok: true, result })
        }
        const result = await fileOp('finish upload', undefined, () => api.sftpCloseTransfer(sessionId, { verify: true }))
        // F1/B5/B8: the local adapter used to return no `server`, so the dir
        // cache was cleared for `undefined` and the activity log said
        // "unknown". Prefer the reported id, fall back to the synthetic local
        // ref for `loc*` sessions (LOCAL_FILE_REF is the intended value once
        // local-file-api reports it).
        const serverId = typeof result?.server === 'string' && result.server
          ? result.server
          : (localTransfer ? LOCAL_FILE_REF : undefined)
        const inventory = loadServers()
        const serverName = localTransfer
          ? LOCAL_FILE_REF
          : (inventory.find((entry) => entry.id === serverId)?.name ?? serverId ?? 'unknown')
        if (serverId) clearDirCache(serverId)
        logActivity({ kind: 'file-write', server: serverName, summary: `${result?.path ?? ''} (${result?.bytes ?? 0} bytes)`, outcome: 'success' })
        return send(res, 200, { ok: true, result })
      }
      if (rel === '/sftp/read-chunk') {
        if (!sessionId) return send(res, 400, { ok: false, error: 'session is required' })
        if (!Number.isInteger(body.offset) || body.offset < 0) {
          return send(res, 400, { ok: false, error: 'offset must be a non-negative integer' })
        }
        const length = Number.isInteger(body.length) ? body.length : 2 * 1024 * 1024
        if (length <= 0 || length > 4 * 1024 * 1024) return send(res, 400, { ok: false, error: 'length must be 1..4 MiB' })
        const api = localTransfer ?? runtime
        const result = await fileOp('read chunk', undefined, () => api.sftpReadChunk(sessionId, body.offset, length))
        return send(res, 200, { ok: true, result })
      }
      if (rel === '/sftp/close-read') {
        if (!sessionId) return send(res, 400, { ok: false, error: 'session is required' })
        const api = localTransfer ?? runtime
        const result = await fileOp('close download', undefined, () => api.sftpCloseTransfer(sessionId))
        return send(res, 200, { ok: true, result })
      }

      const ref = resolveRef(body.ref ?? body.server ?? body.name)
      const servers = loadServers()
      let target
      let fileApi = runtime
      if (ref === LOCAL_FILE_REF && localFiles) {
        target = localFiles.server
        fileApi = localFiles
      } else {
        target = ref ? findTarget(servers, ref) : undefined
      }
      if (!target) return send(res, 404, { ok: false, error: `unknown server "${ref ?? ''}"` })

      if (rel === '/server/update') {
        const patch = body.patch ?? {}
        const next = servers.map((server) => (server.id === target.id ? { ...server, ...patch, id: target.id } : server))
        const saved = saveServers(next)
        terminals?.closeForServer?.(target.id)
        invalidateServer(target.id)
        logActivity({ kind: 'server-update', server: target.name, outcome: 'saved' })
        return send(res, 200, { ok: true, server: saved.find((server) => server.id === target.id) })
      }
      if (rel === '/server/remove') {
        saveServers(servers.filter((server) => server.id !== target.id))
        terminals?.closeForServer?.(target.id)
        invalidateServer(target.id)
        logActivity({ kind: 'server-remove', server: target.name, outcome: 'removed' })
        return send(res, 200, { ok: true, removed: target.name })
      }

      if (rel === '/server/test') {
        const cached = testCache.get(target.id)
        if (cached && Date.now() - cached.at < TEST_TTL_MS && body.refresh !== true) {
          return send(res, 200, { ok: true, result: { ...cached.result, cached: true } })
        }
        const result = await runtime.test(target)
        if (result.ok) testCache.set(target.id, { at: Date.now(), result })
        // A successful test is a good moment to refresh host facts for the UI.
        let facts
        if (result.ok && typeof refreshFacts === 'function') {
          try {
            facts = await refreshFacts(target)
          } catch {
            // facts are optional metadata
          }
        }
        logActivity({ kind: 'test', server: target.name, outcome: result.ok ? 'ok' : (result.errorCode ?? 'failed') })
        return send(res, 200, { ok: true, result: facts ? { ...result, facts } : result })
      }
      if (rel === '/server/warm') {
        if (target.id === LOCAL_FILE_REF) return send(res, 200, { ok: true, warmed: false })
        const config = typeof publicConfig === 'function' ? publicConfig() : undefined
        if (config && config.prewarm === false) {
          return send(res, 200, { ok: true, warmed: false, skipped: 'prewarm disabled' })
        }
        try {
          runtime.warm?.(target)
        } catch {
          // warm-up is best effort
        }
        return send(res, 200, { ok: true, warmed: target.name })
      }

      if (rel === '/server/trust') {
        if (typeof body.fingerprint !== 'string' || !body.fingerprint) {
          return send(res, 400, { ok: false, error: 'fingerprint is required' })
        }
        knownHosts.trust(target, body.fingerprint)
        logActivity({ kind: 'trust', server: target.name, outcome: 'trusted' })
        return send(res, 200, { ok: true })
      }
      if (rel === '/server/credential') {
        if (typeof body.password === 'string' && body.password) {
          secrets.set(`server:${target.id}:password`, body.password)
          // The explicit "set password" action also selects password auth:
          // otherwise the stored secret would be ignored by a key-auth record.
          if (target.authRef.type !== 'password') {
            saveServers(servers.map((server) => (server.id === target.id ? { ...server, authRef: { type: 'password' } } : server)))
            logActivity({ kind: 'server-update', server: target.name, summary: 'auth -> password', outcome: 'saved' })
          }
          invalidateServer(target.id)
        }
        if (typeof body.passphrase === 'string' && body.passphrase) secrets.set(`server:${target.id}:passphrase`, body.passphrase)
        return send(res, 200, { ok: true })
      }
      if (rel === '/sftp/list') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        const key = dirKey(target, body.path)
        const cached = dirCache.get(key)
        if (body.refresh !== true && cached && Date.now() - cached.at < DIR_TTL_MS) {
          return send(res, 200, { ok: true, result: cached.entries, cached: true })
        }
        const entries = await fileOp('list', body.path, () => fileApi.sftpList(target, body.path))
        dirCache.set(key, { at: Date.now(), entries })
        return send(res, 200, { ok: true, result: entries })
      }
      if (rel === '/sftp/read') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        const wantsBase64 = body.base64 === true
        const result = await fileOp('read', body.path, () => fileApi.sftpRead(target, body.path, {
          maxBytes: Number.isInteger(body.maxBytes) ? body.maxBytes : undefined,
          base64: wantsBase64,
        }))
        if (result.binary && !wantsBase64) return send(res, 200, { ok: true, result: { ...result, content: undefined } })
        return send(res, 200, { ok: true, result })
      }

      if (rel === '/sftp/open-write') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        return send(res, 200, { ok: true, result: await fileOp('open for writing', body.path, () => fileApi.sftpOpenWrite(target, body.path, body.truncate !== false)) })
      }
      if (rel === '/sftp/open-read') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        return send(res, 200, { ok: true, result: await fileOp('open for reading', body.path, () => fileApi.sftpOpenRead(target, body.path)) })
      }


      if (rel === '/sftp/mkdir') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        const result = await fileOp('mkdir', body.path, () => fileApi.sftpMkdir(target, body.path))
        clearDirCache(target.id)
        logActivity({ kind: 'file-mkdir', server: target.name, summary: body.path, outcome: 'success' })
        return send(res, 200, { ok: true, result })
      }
      if (rel === '/sftp/remove') {
        if (typeof body.path !== 'string') return send(res, 400, { ok: false, error: 'path is required' })
        const result = await fileOp('remove', body.path, () => fileApi.sftpRemove(target, body.path, body.isDir === true))
        clearDirCache(target.id)
        logActivity({ kind: 'file-remove', server: target.name, summary: body.path, outcome: 'success' })
        return send(res, 200, { ok: true, result })
      }
      if (rel === '/sftp/rename') {
        if (typeof body.path !== 'string' || typeof body.targetPath !== 'string') {
          return send(res, 400, { ok: false, error: 'path and targetPath are required' })
        }
        const normalize = (value) => String(value).replace(/\/+$/, '') || '/'
        if (normalize(body.path) === normalize(body.targetPath)) {
          return send(res, 400, { ok: false, error: 'source and target path are the same' })
        }
        const result = await fileOp(`rename "${body.path}" to`, body.targetPath, () => fileApi.sftpRename(target, body.path, body.targetPath))
        clearDirCache(target.id)
        logActivity({ kind: 'file-rename', server: target.name, summary: `${body.path} -> ${body.targetPath}`, outcome: 'success' })
        return send(res, 200, { ok: true, result })
      }
      return send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const status = error instanceof HttpStatusError ? error.status : 400
      return send(res, status, errorBody(error))
    }
  }

  return handle
}

/** Wrap one descriptor as an exact Connection Fetch route (Desktop carrier). */
export function connectionRoute(descriptor, handler) {
  return {
    path: `/api${descriptor.path}`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      const chunks = []
      let size = 0
      const reader = request.body?.getReader?.()
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY) {
              await reader.cancel()
              return Response.json({ ok: false, error: 'request body too large' }, { status: 413 })
            }
            chunks.push(Buffer.from(value))
          }
        } finally {
          reader.releaseLock()
        }
      }
      const req = Readable.from(chunks.length ? [Buffer.concat(chunks)] : [])
      req.method = request.method
      req.url = descriptor.path + url.search
      req.headers = Object.fromEntries(request.headers)

      const headers = new Headers()
      let bodyText = ''
      const res = {
        statusCode: 200,
        setHeader(key, value) {
          headers.set(key, value)
        },
        end(text) {
          bodyText = text ?? ''
        },
      }
      await handler(req, res)
      return new Response(bodyText, { status: res.statusCode, headers })
    },
  }
}

/** Register the data plane on whichever carriers the composition provides. */
export function registerRoutes(ctx, handler, { fetchRoutes = FETCH_ROUTES } = {}) {
  if (typeof ctx.inject !== 'function') return () => {}

  const fence = (req, res) => {
    const connection = ctx.get?.('connection')
    const rejection =
      connection && typeof connection.requestRejection === 'function'
        ? connection.requestRejection(req)
        : undefined
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return false
    }
    return true
  }

  ctx.inject(['webServer'], (inner) => {
    const webServer = inner.get('webServer') ?? inner.webServer
    if (!webServer || typeof webServer.register !== 'function') return
    const fenced = (req, res) => (fence(req, res) ? handler(req, res) : undefined)
    inner.effect(
      () => webServer.register({ kind: 'prefix', path: PREFIX, handler: fenced }),
      'dsh-ssh-workbench: web routes',
    )
  })

  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    if (typeof connection?.fetch?.register !== 'function') return
    const registered = []
    for (const descriptor of fetchRoutes) {
      try {
        registered.push(connection.fetch.register(connectionRoute(descriptor, handler)))
      } catch (error) {
        ctx.logger?.warn?.('dsh-ssh-workbench: fetch route not registered', {
          path: descriptor.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    inner.effect(
      () => () => registered.map((dispose) => {
        try {
          return dispose()
        } catch {
          return undefined
        }
      }),
      'dsh-ssh-workbench: fetch routes',
    )
  })

  return () => {}
}


