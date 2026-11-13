import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createRoutes, connectionRoute, FETCH_ROUTES } from '../lib/routes.js'
import { normalizeServer } from '../lib/core/store.js'

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.body = text ?? ''
    },
  }
}

function makeReq(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:61019' }
  return req
}

function makeDeps() {
  const state = {
    servers: [normalizeServer({ name: 'web-1', host: '10.0.0.5', tags: ['prod'], authRef: { type: 'sshKey', path: '~/.ssh/id_ed25519' } })],
    trusted: [],
    imported: 0,
    sftpListCalls: 0,
    testCalls: 0,
    warmed: [],
    invalidated: [],
    closedTransfers: [],
    targetState: { candidates: [], version: 0 },
    running: { count: 0, servers: [] },
    prefs: { sidebar: true },
    terminals: [],
    localfsCalls: [],
    sftpHomeCalls: [],
    sftpHomeError: null,
    sftpErrors: {},
  }
  const deps = {
    loadServers: () => state.servers,
    saveServers: (servers) => {
      state.servers = servers.map((server) => normalizeServer(server))
      return state.servers
    },
    runtime: {
      test: async (server) => {
        state.testCalls += 1
        return { ok: true, latencyMs: 12, platform: server.platform, hostKey: 'trusted' }
      },
      sftpList: async (_server, remotePath) => {
        if (state.sftpErrors.list) throw state.sftpErrors.list
        state.sftpListCalls += 1
        return [{ name: 'hello.txt', path: `${remotePath}/hello.txt`, type: 'file', size: 10, mtime: 1700000000 }]
      },
      sftpRead: async (_server, remotePath, options = {}) => {
        if (state.sftpErrors.read) throw state.sftpErrors.read
        const buffer = Buffer.from('hello sftp')
        return {
          path: remotePath,
          size: buffer.length,
          bytesRead: buffer.length,
          truncated: false,
          binary: false,
          content: buffer.toString('utf8'),
          ...(options.base64 === true ? { base64: buffer.toString('base64') } : {}),
        }
      },
      sftpHome: async (server) => {
        if (state.sftpHomeError) throw state.sftpHomeError
        state.sftpHomeCalls.push(server.name)
        return `/home/${server.name}`
      },
      sftpMkdir: async (_server, remotePath) => {
        if (state.sftpErrors.mkdir) throw state.sftpErrors.mkdir
        return { path: remotePath }
      },
      sftpRemove: async (_server, remotePath) => {
        if (state.sftpErrors.remove) throw state.sftpErrors.remove
        return { path: remotePath, removed: true }
      },
      sftpRename: async (_server, fromPath, toPath) => {
        if (state.sftpErrors.rename) throw state.sftpErrors.rename
        return { from: fromPath, to: toPath }
      },
      sftpOpenWrite: async (_server, remotePath) => ({ session: 'w-1', path: remotePath }),
      sftpWriteChunk: async (session, offset, buffer) => ({ session, bytes: buffer.length, offset }),
      sftpOpenRead: async (_server, remotePath) => ({ session: 'r-1', path: remotePath, size: 11 }),
      sftpReadChunk: async (session, offset, length) => ({ session, bytesRead: Math.min(length, 11 - offset), base64: Buffer.from('hello world').subarray(offset, offset + length).toString('base64') }),
      closeTransferSessionsForServer: async (serverId) => {
        state.closedTransfers.push(serverId)
        return 1
      },
      sftpCloseTransfer: async (session, options = {}) => ({ session, path: '/tmp/a.bin', bytes: 11, server: 'id', ...(options.verify ? { verified: true } : {}) }),
      warm: (server) => state.warmed.push(server.name),
      invalidate: (serverId) => state.invalidated.push(serverId),
    },
    secrets: { has: () => true, set() {} },
    activity: {
      entries: [],
      append(entry) {
        this.entries.unshift(entry)
        return entry
      },
      list(limit = 20) {
        return this.entries.slice(0, limit)
      },
      clear() {
        this.entries = []
        return true
      },
    },
    liveExecutions: { snapshot: () => state.running },
    targets: {
      get: () => state.targetState,
    },
    refreshFacts: async () => ({
      hostname: 'web-1',
      kernel: 'Linux test',
      rootDisk: '/dev/vda1 1 1 1 20% /',
      collectedAt: '2026-11-08T00:00:00.000Z',
    }),
    knownHosts: {
      has: () => false,
      list: () => state.trusted,
      trust: (server, fingerprint) => state.trusted.push({ address: `${server.host}:${server.port}`, fingerprint }),
      revoke: () => true,
    },
    publicConfig: () => ({ hostKeyMode: 'strict', remoteFileWrite: state.prefs.remoteFileWrite === true }),
    prefs: {
      load: () => state.prefs,
      save: (patch) => {
        state.prefs = { ...state.prefs, ...patch }
        return state.prefs
      },
    },
    terminals: {
      open: async (request) => {
        state.terminals.push(request)
        return { session: 'term_1', kind: request.kind, title: request.server?.name ?? 'local', cols: 80, rows: 24 }
      },
      read: async (session, options) => ({ session, cursor: 5, data: `read:${session}:${options.cursor}:${options.waitMs}` }),
      input: (session, data) => { state.terminals.push({ input: session, data }); return true },
      resize: (session, cols, rows) => { state.terminals.push({ resize: session, cols, rows }); return true },
      close: (session) => { state.terminals.push({ close: session }); return true },
      closeForServer: (serverId) => { state.terminals.push({ closeForServer: serverId }); return 0 },
    },
    localfs: {
      root: () => '/workspace',
      rootReal: async () => '/workspace',
      resolve: async (path) => path,
      resolveEntry: async (path) => path,
      list: async (path) => { state.localfsCalls.push(['list', path]); return { root: '/workspace', path: path ?? '/workspace', entries: [], parent: null } },
      read: async (path) => { state.localfsCalls.push(['read', path]); return { path, size: 3, truncated: false, base64: 'aGk=' } },
      write: async (path) => { state.localfsCalls.push(['write', path]); return { path, size: 3 } },
      mkdir: async (path) => { state.localfsCalls.push(['mkdir', path]); return { path } },
      remove: async (path) => { state.localfsCalls.push(['remove', path]); return { path } },
      rename: async (from, to) => { state.localfsCalls.push(['rename', from, to]); return { path: to } },
    },
  }
  return { deps, state }
}

async function call(handler, method, url, body) {
  const res = makeRes()
  await handler(makeReq(method, url, body), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined }
}

test('routes serve inventory, state and known hosts', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const servers = await call(handler, 'GET', '/dsh-ssh-workbench/servers')
  assert.equal(servers.status, 200)
  assert.equal(servers.json.servers.length, 1)
  assert.equal(servers.json.servers[0].name, 'web-1')

  const state = await call(handler, 'GET', '/dsh-ssh-workbench/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.servers[0].credentialConfigured, true)
  assert.equal(state.json.servers[0].hostKeyKnown, false)
  assert.equal(state.json.config.hostKeyMode, 'strict')

  const known = await call(handler, 'GET', '/dsh-ssh-workbench/known-hosts')
  assert.equal(known.status, 200)

  const activity = await call(handler, 'GET', '/dsh-ssh-workbench/activity')
  assert.equal(activity.status, 200)
  assert.ok(Array.isArray(activity.json.entries))
})

test('routes read and write the sidebar preference', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const read = await call(handler, 'GET', '/dsh-ssh-workbench/prefs')
  assert.equal(read.status, 200)
  assert.equal(read.json.prefs.sidebar, true)

  const saved = await call(handler, 'POST', '/dsh-ssh-workbench/prefs', { sidebar: false })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.prefs.sidebar, false)
  assert.equal(state.prefs.sidebar, false)

  const invalid = await call(handler, 'POST', '/dsh-ssh-workbench/prefs', { sidebar: 'no' })
  assert.equal(invalid.status, 400)
  assert.equal(state.prefs.sidebar, false)
})

test('routes expose and toggle the remote write preference', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const opened = await call(handler, 'POST', '/dsh-ssh-workbench/prefs', { remoteFileWrite: true })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.prefs.remoteFileWrite, true)
  assert.equal(opened.json.config.remoteFileWrite, true)
  assert.equal(state.prefs.remoteFileWrite, true)

  const closed = await call(handler, 'POST', '/dsh-ssh-workbench/prefs', { remoteFileWrite: false })
  assert.equal(closed.status, 200)
  assert.equal(closed.json.config.remoteFileWrite, false)
  assert.equal(state.prefs.remoteFileWrite, false)

  const empty = await call(handler, 'POST', '/dsh-ssh-workbench/prefs', {})
  assert.equal(empty.status, 400)
})

test('routes expose terminal sessions and the local workbench filesystem', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const read = await call(handler, 'GET', '/dsh-ssh-workbench/terminal/read?session=term_1&cursor=3&wait=10')
  assert.equal(read.status, 200)
  assert.equal(read.json.result.data, 'read:term_1:3:10')

  const opened = await call(handler, 'POST', '/dsh-ssh-workbench/terminal/open', { kind: 'local', cols: 90, rows: 30 })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.result.session, 'term_1')
  assert.equal(state.terminals.at(-1).kind, 'local')
  assert.equal(state.terminals.at(-1).cols, 90)

  const remote = await call(handler, 'POST', '/dsh-ssh-workbench/terminal/open', { kind: 'remote', ref: 'web-1' })
  assert.equal(remote.status, 200)
  assert.equal(state.terminals.at(-1).server.name, 'web-1')

  const unknown = await call(handler, 'POST', '/dsh-ssh-workbench/terminal/open', { kind: 'remote', ref: 'nope' })
  assert.equal(unknown.status, 404)

  assert.equal((await call(handler, 'POST', '/dsh-ssh-workbench/terminal/input', { session: 'term_1', data: 'ls\n' })).status, 200)
  assert.equal((await call(handler, 'POST', '/dsh-ssh-workbench/terminal/resize', { session: 'term_1', cols: 100, rows: 40 })).status, 200)
  assert.equal((await call(handler, 'POST', '/dsh-ssh-workbench/terminal/close', { session: 'term_1' })).status, 200)

  assert.equal((await call(handler, 'GET', '/dsh-ssh-workbench/localfs/root')).json.result.root, '/workspace')

  // The files panel reuses the same /sftp/* surface with a synthetic local ref.
  const localList = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: '__local__', path: '/workspace' })
  assert.equal(localList.status, 200)
  const localRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read', { ref: '__local__', path: '/workspace/a.txt' })
  assert.equal(localRead.status, 200)
  const localWarm = await call(handler, 'POST', '/dsh-ssh-workbench/server/warm', { ref: '__local__' })
  assert.equal(localWarm.status, 200)
  assert.equal(localWarm.json.warmed, false)
})

test('routes create, update, test, trust and delete servers', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const created = await call(handler, 'POST', '/dsh-ssh-workbench/server/create', {
    record: {
      name: 'db-1',
      host: '10.0.0.6',
      port: 22,
      username: 'root',
      platform: 'posix',
      authRef: { type: 'sshKey', path: '~/.ssh/id_ed25519' },
    },
  })
  assert.equal(created.status, 200)
  assert.equal(state.servers.length, 2)

  const patched = await call(handler, 'POST', '/dsh-ssh-workbench/server/update', { ref: 'db-1', patch: { tags: ['prod', 'db'] } })
  assert.equal(patched.status, 200)
  assert.deepEqual(patched.json.server.tags, ['prod', 'db'])

  const tested = await call(handler, 'POST', '/dsh-ssh-workbench/server/test', { ref: 'db-1' })
  assert.equal(tested.status, 200)
  assert.equal(tested.json.result.latencyMs, 12)

  const trusted = await call(handler, 'POST', '/dsh-ssh-workbench/server/trust', { ref: 'db-1', fingerprint: 'sha256:abcd' })
  assert.equal(trusted.status, 200)
  assert.equal(state.trusted.length, 1)

  const credential = await call(handler, 'POST', '/dsh-ssh-workbench/server/credential', { ref: 'db-1', password: 'secret' })
  assert.equal(credential.status, 200)
  // Setting a password also switches the record to password auth, otherwise the
  // stored secret would be ignored by a key-auth record.
  const afterCredential = await call(handler, 'GET', '/dsh-ssh-workbench/state')
  const dbRow = afterCredential.json.servers.find((entry) => entry.name === 'db-1')
  assert.equal(dbRow.authType, 'password')
  assert.equal(dbRow.dialect, 'posix', 'state rows expose the effective dialect')
  const raw = await call(handler, 'GET', '/dsh-ssh-workbench/servers')
  assert.equal(raw.json.servers.find((entry) => entry.name === 'db-1').authRef.type, 'password')

  const removed = await call(handler, 'POST', '/dsh-ssh-workbench/server/remove', { ref: 'db-1' })
  assert.equal(removed.status, 200)
  assert.equal(state.servers.length, 1)

  const missing = await call(handler, 'POST', '/dsh-ssh-workbench/server/remove', { ref: 'nope' })
  assert.equal(missing.status, 404)
})

test('routes validate bodies and unknown paths', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const bad = await call(handler, 'POST', '/dsh-ssh-workbench/server/create', { record: { name: '', host: '' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.ok, false)
  const missing = await call(handler, 'GET', '/dsh-ssh-workbench/unknown')
  assert.equal(missing.status, 404)
})

test('connection fetch adapter serves the Desktop carrier contract', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const descriptor = FETCH_ROUTES.find((route) => route.path.endsWith('/servers') && route.methods.includes('GET'))
  const route = connectionRoute(descriptor, handler)
  assert.equal(route.path, '/api/dsh-ssh-workbench/servers')
  assert.equal(route.requestBody, 'buffered')

  const getResponse = await route.fetch(new Request('http://localhost/api/dsh-ssh-workbench/servers'))
  assert.equal(getResponse.status, 200)
  const listed = await getResponse.json()
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].name, 'web-1')

  const createDescriptor = FETCH_ROUTES.find((item) => item.path.endsWith('/server/create'))
  const createRoute = connectionRoute(createDescriptor, handler)
  const postResponse = await createRoute.fetch(new Request('http://localhost/api/dsh-ssh-workbench/server/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ record: {
      name: 'edge-1',
      host: '10.0.0.9',
      port: 22,
      username: 'root',
      authRef: { type: 'sshKey', path: '~/.ssh/id_ed25519' },
    } }),
  }))
  assert.equal(postResponse.status, 200)
  const created = await postResponse.json()
  assert.equal(created.server.name, 'edge-1')
})

test('the target route exposes mention hints without an active target', async () => {
  const { deps, state } = makeDeps()
  state.targetState = { candidates: ['web-1'], version: 4 }
  deps.activity.entries = [
    { at: '2026-11-10T08:00:03.000Z', kind: 'exec', server: 'web-1', sessionId: 's1', outcome: 'success', durationMs: 250 },
  ]
  const handler = createRoutes(deps)

  const target = await call(handler, 'GET', '/dsh-ssh-workbench/target?session=s1')
  assert.equal(target.status, 200)
  assert.equal('target' in target.json, false)
  assert.deepEqual(target.json.candidates, ['web-1'])
  assert.equal(target.json.lastExecuted, 'web-1')
  assert.equal(target.json.version, 4)
})

test('target routes include this session execution stats', async () => {
  const { deps, state } = makeDeps()
  state.targetState = { candidates: ['web-1', 'db-1'], version: 2 }
  deps.activity.entries = [
    { at: '2026-11-10T08:00:03.000Z', kind: 'exec', server: 'db-1', sessionId: 's1', outcome: 'success', durationMs: 250 },
    { at: '2026-11-10T08:00:02.000Z', kind: 'exec', server: 'web-1', sessionId: 's1', outcome: 'failed', durationMs: 100 },
    { at: '2026-11-10T08:00:04.000Z', kind: 'exec', server: 'web-1', sessionId: 'other', outcome: 'success', durationMs: 900 },
  ]
  const handler = createRoutes(deps)

  const target = await call(handler, 'GET', '/dsh-ssh-workbench/target?session=s1')
  assert.equal(target.status, 200)
  assert.equal(target.json.stats.count, 2)
  assert.equal(target.json.stats.success, 1)
  assert.equal(target.json.stats.failed, 1)
  assert.equal(target.json.stats.durationMs, 350)
  assert.equal(target.json.stats.averageMs, 175)
  assert.equal(target.json.stats.lastAt, '2026-11-10T08:00:03.000Z')
  assert.deepEqual(target.json.stats.servers.map((bucket) => bucket.name), ['db-1', 'web-1'])
  assert.deepEqual(target.json.running, { count: 0, servers: [] })
})

test('the target route exposes live remote calls', async () => {
  const { deps, state } = makeDeps()
  state.running = { count: 1, servers: [{ name: 'web-1', count: 1, startedAt: 1 }] }
  const handler = createRoutes(deps)
  const target = await call(handler, 'GET', '/dsh-ssh-workbench/target?session=s1')
  assert.equal(target.status, 200)
  assert.deepEqual(target.json.running, state.running)
})

test('server update closes the target transfer sessions', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)
  const updated = await call(handler, 'POST', '/dsh-ssh-workbench/server/update', { ref: 'web-1', patch: { description: 'updated' } })
  assert.equal(updated.status, 200)
  assert.deepEqual(state.closedTransfers, [state.servers[0].id])
})

test('legacy data-plane routes are removed', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const paths = FETCH_ROUTES.map((route) => route.path)
  for (const legacy of ['/dsh-ssh-workbench/exec', '/dsh-ssh-workbench/server/facts', '/dsh-ssh-workbench/known-hosts/import', '/dsh-ssh-workbench/sftp/stat', '/dsh-ssh-workbench/sftp/upload', '/dsh-ssh-workbench/sftp/write', '/dsh-ssh-workbench/metrics']) {
    assert.equal(paths.includes(legacy), false, `${legacy} must not be registered`)
    const response = await call(handler, 'POST', legacy, { ref: 'web-1', command: 'uptime', path: '/tmp/a' })
    assert.equal(response.status, 404, `${legacy} must 404`)
  }
})

test('routes expose SFTP read and base64 read', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)

  const read = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read', { ref: 'web-1', path: '/tmp/hello.txt' })
  assert.equal(read.json.result.content, 'hello sftp')

  const base64 = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read', { ref: 'web-1', path: '/tmp/hello.txt', base64: true })
  assert.equal(Buffer.from(base64.json.result.base64, 'base64').toString('utf8'), 'hello sftp')

  const sameRename = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/rename', { ref: 'web-1', path: '/tmp/a', targetPath: '/tmp/a/' })
  assert.equal(sameRename.status, 400)

  const paths = FETCH_ROUTES.map((route) => route.path)
  assert.ok(paths.includes('/dsh-ssh-workbench/sftp/read'))
})

test('routes expose chunked transfer sessions', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)

  const openWrite = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/open-write', { ref: 'web-1', path: '/tmp/a.bin' })
  assert.equal(openWrite.json.result.session, 'w-1')
  const write = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', {
    session: 'w-1',
    offset: 0,
    contentBase64: Buffer.from('hello world').toString('base64'),
  })
  assert.equal(write.status, 200)
  assert.equal(write.json.result.bytes, 11)
  const closeWrite = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/close-write', { session: 'w-1' })
  assert.equal(closeWrite.status, 200)

  const openRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/open-read', { ref: 'web-1', path: '/tmp/a.bin' })
  assert.equal(openRead.json.result.size, 11)
  const read = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read-chunk', { session: 'r-1', offset: 0, length: 5 })
  assert.equal(Buffer.from(read.json.result.base64, 'base64').toString('utf8'), 'hello')
  const closeRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/close-read', { session: 'r-1' })
  assert.equal(closeRead.status, 200)

  assert.equal((await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', { offset: 0, contentBase64: 'aGk=' })).status, 400)
  assert.equal((await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read-chunk', { session: 'r-1', offset: 0, length: 0 })).status, 400)

  const paths = FETCH_ROUTES.map((route) => route.path)
  assert.ok(paths.includes('/dsh-ssh-workbench/sftp/open-write'))
  assert.ok(paths.includes('/dsh-ssh-workbench/sftp/read-chunk'))
})

test('routes warm connections on request', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const warm = await call(handler, 'POST', '/dsh-ssh-workbench/server/warm', { ref: 'web-1' })
  assert.equal(warm.status, 200)
  assert.equal(warm.json.warmed, 'web-1')
  assert.deepEqual(state.warmed, ['web-1'])
  assert.ok(FETCH_ROUTES.some((route) => route.path === '/dsh-ssh-workbench/server/warm'))
})

test('routes cache directory listings and connection tests briefly', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const firstList = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: 'web-1', path: '/tmp' })
  assert.equal(firstList.status, 200)
  const secondList = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: 'web-1', path: '/tmp' })
  assert.equal(secondList.json.cached, true)
  assert.equal(state.sftpListCalls, 1, 'second listing must come from the cache')
  await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: 'web-1', path: '/tmp', refresh: true })
  assert.equal(state.sftpListCalls, 2, 'refresh must bypass the cache')

  const firstTest = await call(handler, 'POST', '/dsh-ssh-workbench/server/test', { ref: 'web-1' })
  assert.equal(firstTest.status, 200)
  const secondTest = await call(handler, 'POST', '/dsh-ssh-workbench/server/test', { ref: 'web-1' })
  assert.equal(secondTest.json.result.cached, true)
  assert.equal(state.testCalls, 1, 'second connection test must come from the cache')

  // A server update invalidates the cached test and any directory listing.
  const updated = await call(handler, 'POST', '/dsh-ssh-workbench/server/update', { ref: 'web-1', patch: { description: 'updated' } })
  assert.equal(updated.status, 200)
  assert.equal(state.invalidated.length, 1)
  await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: 'web-1', path: '/tmp' })
  assert.equal(state.sftpListCalls, 3)
})

test('routes list and clear the local activity log', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  deps.activity.append({ kind: 'exec', server: 'web-1', summary: 'uptime', outcome: 'success' })

  const listed = await call(handler, 'GET', '/dsh-ssh-workbench/activity')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.entries.length, 1)

  const cleared = await call(handler, 'POST', '/dsh-ssh-workbench/activity/clear', {})
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.cleared, true)
  const after = await call(handler, 'GET', '/dsh-ssh-workbench/activity')
  assert.deepEqual(after.json.entries, [])
})

test('localfs root uses the canonical realpath when available (S3)', async () => {
  const { deps } = makeDeps()
  deps.localfs.root = () => '/workspace'
  deps.localfs.rootReal = async () => '/private/workspace'
  const handler = createRoutes(deps)
  const response = await call(handler, 'GET', '/dsh-ssh-workbench/localfs/root')
  assert.equal(response.status, 200)
  assert.equal(response.json.result.root, '/private/workspace')
})

test('routes expose the server home directory for local and remote refs', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)

  const local = await call(handler, 'GET', '/dsh-ssh-workbench/sftp/home?ref=__local__')
  assert.equal(local.status, 200)
  // localFileApi.sftpHome() is not part of the current adapter yet, so this
  // exercises the rootReal()/root() fallback chain.
  assert.deepEqual(local.json, { ok: true, result: { home: '/workspace' } })

  const remote = await call(handler, 'GET', '/dsh-ssh-workbench/sftp/home?ref=web-1')
  assert.equal(remote.status, 200)
  assert.deepEqual(remote.json, { ok: true, result: { home: '/home/web-1' } })
  assert.deepEqual(state.sftpHomeCalls, ['web-1'])

  const byId = await call(handler, 'GET', `/dsh-ssh-workbench/sftp/home?ref=${state.servers[0].id}`)
  assert.equal(byId.status, 200)
  assert.equal(byId.json.result.home, '/home/web-1')

  const posted = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/home', { ref: 'web-1' })
  assert.equal(posted.status, 200)
  assert.equal(posted.json.result.home, '/home/web-1')

  const missing = await call(handler, 'GET', '/dsh-ssh-workbench/sftp/home')
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /ref is required/)

  const unknown = await call(handler, 'GET', '/dsh-ssh-workbench/sftp/home?ref=nope')
  assert.equal(unknown.status, 404)
  assert.match(unknown.json.error, /unknown server "nope"/)

  assert.ok(
    FETCH_ROUTES.some(
      (route) => route.path === '/dsh-ssh-workbench/sftp/home' && route.methods.includes('GET') && route.methods.includes('POST'),
    ),
  )

  state.sftpHomeError = new Error('realpath failed')
  const failed = await call(handler, 'GET', '/dsh-ssh-workbench/sftp/home?ref=web-1')
  assert.equal(failed.status, 502)
  assert.match(failed.json.error, /home directory/)
  assert.match(failed.json.error, /web-1/)
  assert.match(failed.json.error, /realpath failed/)
})

test('local upload completion invalidates the local directory cache and logs a readable server', async () => {
  const { deps, state } = makeDeps()
  // The local adapter opens real file descriptors: point it at a scratch dir.
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdh-routes-local-'))
  const resolveScratch = async (value) => (path.isAbsolute(value) ? value : path.join(temp, value))
  deps.localfs.resolve = resolveScratch
  deps.localfs.resolveEntry = resolveScratch
  const handler = createRoutes(deps)
  try {
    const firstList = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: '__local__', path: temp })
    assert.equal(firstList.status, 200)
    const cachedList = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: '__local__', path: temp })
    assert.equal(cachedList.json.cached, true)
    const listCalls = () => state.localfsCalls.filter(([operation]) => operation === 'list').length
    assert.equal(listCalls(), 1)

    const opened = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/open-write', {
      ref: '__local__',
      path: path.join(temp, 'upload.bin'),
    })
    assert.equal(opened.status, 200)
    const session = opened.json.result.session
    assert.match(session, /^locw_/)
    const chunk = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', {
      session,
      offset: 0,
      contentBase64: Buffer.from('hello local').toString('base64'),
    })
    assert.equal(chunk.status, 200)
    const closed = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/close-write', { session })
    assert.equal(closed.status, 200)
    assert.equal(closed.json.result.bytes, 11)

    const afterUpload = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: '__local__', path: temp })
    assert.equal(afterUpload.status, 200)
    assert.equal(afterUpload.json.cached, undefined, 'local uploads must clear the stale directory cache')
    assert.equal(listCalls(), 2, 'the listing after a local upload must go to the filesystem again')
    assert.equal(deps.activity.entries[0].kind, 'file-write')
    assert.equal(deps.activity.entries[0].server, '__local__')
    assert.equal(await fsp.readFile(path.join(temp, 'upload.bin'), 'utf8'), 'hello local')
  } finally {
    await fsp.rm(temp, { recursive: true, force: true })
  }
})

test('chunk transfer routes reject missing or invalid offsets', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const contentBase64 = Buffer.from('hello').toString('base64')

  const missing = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', { session: 'w-1', contentBase64 })
  assert.equal(missing.status, 400)
  assert.match(missing.json.error, /offset must be a non-negative integer/)

  for (const offset of [-1, 1.5, '3', null]) {
    const invalid = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', { session: 'w-1', offset, contentBase64 })
    assert.equal(invalid.status, 400, `offset ${String(offset)} must be rejected`)
    assert.match(invalid.json.error, /offset must be a non-negative integer/)
  }

  const valid = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/write-chunk', { session: 'w-1', offset: 7, contentBase64 })
  assert.equal(valid.status, 200)
  assert.equal(valid.json.result.offset, 7)

  const missingRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read-chunk', { session: 'r-1', length: 5 })
  assert.equal(missingRead.status, 400)
  assert.match(missingRead.json.error, /offset must be a non-negative integer/)
  const negativeRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read-chunk', { session: 'r-1', offset: -2, length: 5 })
  assert.equal(negativeRead.status, 400)
  const validRead = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read-chunk', { session: 'r-1', offset: 0, length: 5 })
  assert.equal(validRead.status, 200)
})

test('oversized request bodies return 413', async () => {
  const { deps } = makeDeps()
  const handler = createRoutes(deps)
  const res = makeRes()
  const req = Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1, 0x78)])
  req.method = 'POST'
  req.url = '/dsh-ssh-workbench/server/create'
  req.headers = { host: '127.0.0.1:61019' }
  await handler(req, res)
  assert.equal(res.statusCode, 413)
  const json = JSON.parse(res.body)
  assert.equal(json.ok, false)
  assert.match(json.error, /request body too large/)

  // Both carriers must agree (B12): the Desktop Connection Fetch adapter too.
  const route = connectionRoute({ path: '/dsh-ssh-workbench/server/create', methods: ['POST'] }, handler)
  const response = await route.fetch(new Request('http://localhost/api/dsh-ssh-workbench/server/create', {
    method: 'POST',
    body: Buffer.alloc(8 * 1024 * 1024 + 1, 0x78),
  }))
  assert.equal(response.status, 413)
  assert.match((await response.json()).error, /request body too large/)
})

test('filesystem failures name the operation and the path', async () => {
  const { deps, state } = makeDeps()
  const handler = createRoutes(deps)
  state.sftpErrors.remove = new Error('Failure')
  state.sftpErrors.mkdir = new Error('Permission denied')
  state.sftpErrors.rename = new Error('No such file')
  state.sftpErrors.list = new Error('No such file')
  state.sftpErrors.read = new Error('Permission denied')

  const removed = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/remove', { ref: 'web-1', path: '/tmp/not-empty', isDir: true })
  assert.equal(removed.status, 400)
  assert.equal(removed.json.ok, false)
  assert.match(removed.json.error, /remove "\/tmp\/not-empty" failed: Failure/)

  const mkdir = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/mkdir', { ref: 'web-1', path: '/root/nope' })
  assert.match(mkdir.json.error, /mkdir "\/root\/nope" failed: Permission denied/)

  const renamed = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/rename', { ref: 'web-1', path: '/tmp/a', targetPath: '/tmp/b' })
  assert.match(renamed.json.error, /rename "\/tmp\/a" to "\/tmp\/b" failed: No such file/)

  const listed = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: 'web-1', path: '/missing' })
  assert.match(listed.json.error, /list "\/missing" failed: No such file/)

  const read = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/read', { ref: 'web-1', path: '/etc/shadow' })
  assert.match(read.json.error, /read "\/etc\/shadow" failed: Permission denied/)

  // The local adapter keeps its Node error text but gains the same context.
  deps.localfs.list = async () => {
    throw new Error('ENOENT: no such file or directory')
  }
  const localListed = await call(handler, 'POST', '/dsh-ssh-workbench/sftp/list', { ref: '__local__', path: '/workspace/missing' })
  assert.equal(localListed.status, 400)
  assert.match(localListed.json.error, /list "\/workspace\/missing" failed: ENOENT: no such file or directory/)
})
