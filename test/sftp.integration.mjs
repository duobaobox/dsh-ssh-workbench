// SFTP integration test: real ssh2 client transport against a local in-memory
// ssh2.Server SFTP subsystem. Run with: npm run test:ssh:sftp
// The "ssh2" specifier is mapped to vendor/ssh2 by test/ssh.register.mjs.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

const { createSshRuntime } = await import(new URL('../lib/core/ssh.js', import.meta.url).href)
const ssh2mod = await import('ssh2')
const ssh2 = ssh2mod.Server ? ssh2mod : ssh2mod.default

const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, FAILURE: 4 }
const normalizePath = (value) => {
  const text = String(value).replace(/\\/g, '/')
  const parts = text.split('/').filter(Boolean)
  return `/${parts.join('/')}` === '' ? '/' : `/${parts.join('/')}`
}

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const files = new Map()
const dirs = new Set(['/'])

function attrsFor(p) {
  if (dirs.has(p)) return { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: Math.floor(Date.now() / 1000) }
  const content = files.get(p)
  if (content === undefined) return undefined
  return { mode: 0o100644, uid: 0, gid: 0, size: content.length, atime: 0, mtime: Math.floor(Date.now() / 1000) }
}

function nameRow(p) {
  const attrs = attrsFor(p)
  const base = p === '/' ? '/' : p.split('/').pop()
  const isDir = attrs && (attrs.mode & 0o170000) === 0o040000
  return {
    filename: base,
    longname: `${isDir ? 'd' : '-'}rw-r--r-- 1 root root ${attrs?.size ?? 0} Jan 1 00:00 ${base}`,
    attrs: attrs ?? {},
  }
}

function childrenOf(dir) {
  const prefix = dir === '/' ? '/' : `${dir}/`
  const names = new Set()
  for (const file of files.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) names.add(file)
  for (const sub of dirs) if (sub.startsWith(prefix) && sub !== dir && !sub.slice(prefix.length).includes('/')) names.add(sub)
  return [...names].sort().map(nameRow)
}

// The sftpHome() fallback is exercised by changing this mode between calls:
// 'home' → REALPATH "." answers; 'tilde-only' → only "~" answers;
// 'all-fail' → neither answers (readable SFTP_FAILED error expected).
let realpathMode = 'home'

const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        const handles = new Map()
        let nextHandle = 1
        const addHandle = (value) => {
          const id = nextHandle++
          handles.set(id, value)
          return Buffer.from(String(id))
        }
        const decode = (handle) => handles.get(Number(handle.toString()))
        sftp.on('REALPATH', (reqid, path) => {
          const raw = String(path ?? '')
          if ((raw === '.' || raw === '~') && realpathMode === 'all-fail') return sftp.status(reqid, STATUS.NO_SUCH_FILE)
          if (raw === '.' && realpathMode === 'tilde-only') return sftp.status(reqid, STATUS.NO_SUCH_FILE)
          const p = normalizePath(raw)
          sftp.name(reqid, [{ filename: p, longname: p, attrs: attrsFor(p) ?? {} }])
        })
        sftp.on('OPEN', (reqid, filename) => {
          const p = normalizePath(filename)
          const handle = addHandle({ kind: 'file', path: p, buffer: Buffer.from(files.get(p) ?? Buffer.alloc(0)), dirty: false })
          sftp.handle(reqid, handle)
        })
        sftp.on('READ', (reqid, handle, offset, length) => {
          const entry = decode(handle)
          if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE)
          if (offset >= entry.buffer.length) return sftp.status(reqid, STATUS.EOF)
          sftp.data(reqid, entry.buffer.subarray(offset, Math.min(offset + length, entry.buffer.length)))
        })
        sftp.on('WRITE', (reqid, handle, offset, data) => {
          const entry = decode(handle)
          if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS.FAILURE)
          const end = offset + data.length
          if (end > entry.buffer.length) {
            const grown = Buffer.alloc(end)
            entry.buffer.copy(grown, 0, 0, entry.buffer.length)
            entry.buffer = grown
          }
          data.copy(entry.buffer, offset)
          entry.dirty = true
          sftp.status(reqid, STATUS.OK)
        })
        sftp.on('CLOSE', (reqid, handle) => {
          const entry = decode(handle)
          if (entry?.kind === 'file' && entry.dirty) files.set(entry.path, entry.buffer)
          handles.delete(Number(handle.toString()))
          sftp.status(reqid, STATUS.OK)
        })
        sftp.on('OPENDIR', (reqid, path) => {
          const p = normalizePath(path)
          const handle = addHandle({ kind: 'dir', path: p, entries: childrenOf(p), sent: false })
          sftp.handle(reqid, handle)
        })
        sftp.on('READDIR', (reqid, handle) => {
          const entry = decode(handle)
          if (!entry || entry.kind !== 'dir') return sftp.status(reqid, STATUS.FAILURE)
          if (entry.sent) return sftp.status(reqid, STATUS.EOF)
          entry.sent = true
          sftp.name(reqid, entry.entries)
        })
        sftp.on('STAT', (reqid, path) => {
          const attrs = attrsFor(normalizePath(path))
          if (!attrs) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
          sftp.attrs(reqid, attrs)
        })
        sftp.on('LSTAT', (reqid, path) => {
          const attrs = attrsFor(normalizePath(path))
          if (!attrs) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
          sftp.attrs(reqid, attrs)
        })
        sftp.on('FSTAT', (reqid, handle) => {
          const entry = decode(handle)
          const attrs = entry ? attrsFor(entry.path) : undefined
          if (!attrs) return sftp.status(reqid, STATUS.NO_SUCH_FILE)
          sftp.attrs(reqid, attrs)
        })
        sftp.on('MKDIR', (reqid, path) => {
          dirs.add(normalizePath(path))
          sftp.status(reqid, STATUS.OK)
        })
        sftp.on('RMDIR', (reqid, path) => {
          dirs.delete(normalizePath(path))
          sftp.status(reqid, STATUS.OK)
        })
        sftp.on('REMOVE', (reqid, path) => {
          files.delete(normalizePath(path))
          sftp.status(reqid, STATUS.OK)
        })
        sftp.on('RENAME', (reqid, from, to) => {
          const source = normalizePath(from)
          const target = normalizePath(to)
          if (files.has(source)) {
            files.set(target, files.get(source))
            files.delete(source)
          } else if (dirs.has(source)) {
            dirs.add(target)
            dirs.delete(source)
          }
          sftp.status(reqid, STATUS.OK)
        })
      })
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('sftp test server on', port)

const runtime = createSshRuntime({
  getSecret: (key) => (key === 'server:target:password' ? 'test' : undefined),
  knownHosts: { verify: () => true, has: () => false },
  config: { connectTimeoutMs: 3000, commandTimeoutMs: 3000, maxOutputBytes: 1000, hostKeyMode: 'accept-new' },
})
const target = {
  id: 'target', name: 'local-sftp', host: '127.0.0.1', port, username: 'test', platform: 'posix',
  tags: [], enabled: true, facts: {}, authRef: { type: 'password' },
}

const results = {}

// sftpHome(): REALPATH "." resolves the login home; "~" is the fallback and a
// readable SFTP_FAILED is returned when neither works (never a silent "/").
const home = await runtime.sftpHome(target)
results.home = home
assert.equal(home, '/')
realpathMode = 'tilde-only'
const tildeHome = await runtime.sftpHome(target)
results.tildeHome = tildeHome
assert.equal(tildeHome, '/~')
realpathMode = 'all-fail'
await assert.rejects(
  () => runtime.sftpHome(target),
  (error) => {
    results.homeError = { code: error?.code, message: error?.message }
    return error?.code === 'SFTP_FAILED' && /login home directory/.test(error.message) && /local-sftp/.test(error.message)
  },
)
realpathMode = 'home'

const written = await runtime.sftpWrite(target, '/tmp/a.txt', 'hello sftp')
results.write = written
assert.equal(written.bytes, 10)

const read = await runtime.sftpRead(target, '/tmp/a.txt')
results.read = { size: read.size, content: read.content, truncated: read.truncated }
assert.equal(read.content, 'hello sftp')
const readBase64 = await runtime.sftpRead(target, '/tmp/a.txt', { base64: true })
assert.equal(Buffer.from(readBase64.base64, 'base64').toString('utf8'), 'hello sftp')
assert.equal(read.truncated, false)

const listed = await runtime.sftpList(target, '/tmp')
results.list = listed.map((entry) => ({ name: entry.name, type: entry.type, size: entry.size }))
assert.ok(listed.some((entry) => entry.name === 'a.txt' && entry.type === 'file'))

const stat = await runtime.sftpStat(target, '/tmp/a.txt')
results.stat = { size: stat.size }
assert.equal(stat.size, 10)

await runtime.sftpMkdir(target, '/tmp/sub')
const afterMkdir = await runtime.sftpList(target, '/tmp')
results.afterMkdir = afterMkdir.map((entry) => `${entry.type}:${entry.name}`).sort()
assert.ok(afterMkdir.some((entry) => entry.name === 'sub' && entry.type === 'dir'))

await runtime.sftpRename(target, '/tmp/a.txt', '/tmp/b.txt')
const renamed = await runtime.sftpRead(target, '/tmp/b.txt')
results.renamed = renamed.content
assert.equal(renamed.content, 'hello sftp')

// chunked transfer sessions: out-of-order writes by offset, then read chunks
const writeSession = await runtime.sftpOpenWrite(target, '/tmp/chunk.bin', true)
results.writeSession = { session: writeSession.session }
await runtime.sftpWriteChunk(writeSession.session, 6, Buffer.from('world'))
await runtime.sftpWriteChunk(writeSession.session, 0, Buffer.from('hello '))
const closed = await runtime.sftpCloseTransfer(writeSession.session)
results.writeSession.closedBytes = closed.bytes
const chunked = await runtime.sftpRead(target, '/tmp/chunk.bin')
assert.equal(chunked.content, 'hello world')

const readSession = await runtime.sftpOpenRead(target, '/tmp/chunk.bin')
results.readSession = { size: readSession.size }
const first = await runtime.sftpReadChunk(readSession.session, 0, 5)
const second = await runtime.sftpReadChunk(readSession.session, 6, 5)
assert.equal(Buffer.from(first.base64, 'base64').toString('utf8'), 'hello')
assert.equal(Buffer.from(second.base64, 'base64').toString('utf8'), 'world')
await runtime.sftpCloseTransfer(readSession.session)
await runtime.sftpRemove(target, '/tmp/chunk.bin')

await runtime.sftpRemove(target, '/tmp/b.txt')
const afterRemove = await runtime.sftpList(target, '/tmp')
results.afterRemove = afterRemove.map((entry) => entry.name)
assert.ok(!afterRemove.some((entry) => entry.name === 'b.txt'))

console.log(JSON.stringify(results, null, 2))
server.close()
console.log('SFTP INTEGRATION OK')
