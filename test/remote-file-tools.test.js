import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createRemoteEditTool,
  createRemoteGlobTool,
  createRemoteGrepTool,
  createRemoteReadTool,
  createRemoteWriteTool,
} from '../lib/core/remote-file-tools.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, facts: { dialect: 'posix' } },
  { id: 'srv_2', name: 'winbox', host: '10.0.0.6', port: 22, username: 'admin', platform: 'windows', enabled: true, facts: { dialect: 'windows' }, defaultShell: 'powershell.exe' },
]

const CONFIG = {
  remoteFileReadBytes: 1024,
  remoteFileEditBytes: 1024,
  remoteFileWrite: true,
  remoteGlobMaxResults: 20,
  remoteGlobMaxDepth: 3,
  remoteGrepMaxResults: 10,
  commandTimeoutMs: 1500,
  maxOutputBytes: 4096,
  maxStderrBytes: 1024,
}

/** Keep the write-override prefs out of the developer's real data directory. */
function isolatedPrefs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-files-'))
  process.env.DSH_SSH_WORKBENCH_DIR = dir
  return dir
}

function makeHarness({ config = CONFIG, files = {}, execResult = null } = {}) {
  isolatedPrefs()
  const store = new Map(Object.entries(files))
  const execCalls = []
  const chmodCalls = []
  const activities = []
  const runtime = {
    async sftpHome() {
      return '/home/demo'
    },
    async sftpRead(_server, path, { maxBytes } = {}) {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`)
      const content = store.get(path)
      const cap = maxBytes ?? 262144
      return {
        path,
        size: Buffer.byteLength(content),
        bytesRead: Math.min(Buffer.byteLength(content), cap),
        truncated: Buffer.byteLength(content) > cap,
        binary: content.includes('\0'),
        content: content.slice(0, cap),
      }
    },
    async sftpWrite(_server, path, content) {
      store.set(path, content)
      return { path, bytes: Buffer.byteLength(content) }
    },
    async sftpLstat(_server, path) {
      if (path === '/home/demo/link') return { path, size: 0, mode: 0o120777, type: 'link' }
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`)
      return { path, size: Buffer.byteLength(store.get(path)), mode: 0o100644 }
    },
    async sftpChmod(_server, path, mode) {
      chmodCalls.push({ path, mode })
      return { path, mode }
    },
    async sftpRename(_server, from, to) {
      if (!store.has(from)) throw new Error(`ENOENT: ${from}`)
      store.set(to, store.get(from))
      store.delete(from)
      return { from, to }
    },
    async sftpRemove(_server, path) {
      store.delete(path)
      return { path }
    },
    async sftpStat(_server, path) {
      if (store.has(path)) return { path, size: Buffer.byteLength(store.get(path)) }
      if (path === '/home/demo' || path === '/home/demo/configs') return { path, size: 0 }
      throw new Error(`ENOENT: ${path}`)
    },
    async sftpList(_server, path) {
      if (path === '/home/demo') {
        return [
          { name: 'app.log', path: '/home/demo/app.log', type: 'file' },
          { name: 'configs', path: '/home/demo/configs', type: 'dir' },
          { name: 'link', path: '/home/demo/link', type: 'link' },
        ]
      }
      if (path === '/home/demo/configs') {
        return [{ name: 'nginx.conf', path: '/home/demo/configs/nginx.conf', type: 'file' }]
      }
      throw new Error(`ENOENT: ${path}`)
    },
    async exec(server, command, options) {
      execCalls.push({ server, command, options })
      return execResult ?? {
        outcome: 'success',
        exitCode: 0,
        stdout: '/home/demo/app.log:3:listen 80\n',
        stderr: '',
        truncated: { stdout: false, stderr: false },
      }
    },
  }
  const make = (create) => create({
    runtime,
    config,
    loadInventory: () => SERVERS,
    recordActivity: (entry) => activities.push(entry),
  })
  return {
    read: make(createRemoteReadTool),
    write: make(createRemoteWriteTool),
    edit: make(createRemoteEditTool),
    glob: make(createRemoteGlobTool),
    grep: make(createRemoteGrepTool),
    store,
    execCalls,
    activities,
    chmodCalls,
    exec: { agent: { session: { id: 's1' } }, signal: { aborted: false } },
  }
}

test('remote_read reads an absolute path and rejects binary files', async () => {
  const h = makeHarness({ files: { '/home/demo/app.log': 'line1\nline2\n', '/home/demo/bin.dat': 'a\0b' } })
  const result = await h.read.execute({ server: 'web-1', path: '/home/demo/app.log' }, h.exec)
  assert.match(result.text, /target: web-1/)
  assert.match(result.text, /line1\nline2/)
  assert.equal(h.activities[0].server, 'web-1')
  assert.equal(h.activities[0].sessionId, 's1')
  await assert.rejects(
    () => h.read.execute({ server: 'web-1', path: '/home/demo/bin.dat' }, h.exec),
    /binary/,
  )
})

test('remote_read expands ~ and rejects relative paths', async () => {
  const h = makeHarness({ files: { '/home/demo/app.log': 'ok\n' } })
  const result = await h.read.execute({ server: 'web-1', path: '~/app.log' }, h.exec)
  assert.match(result.text, /path: \/home\/demo\/app\.log/)
  await assert.rejects(
    () => h.read.execute({ server: 'web-1', path: 'relative.txt' }, h.exec),
    /absolute or start with ~/,
  )
})

test('remote_write and remote_edit are disabled until remote writes are on', async () => {
  const h = makeHarness({ config: { ...CONFIG, remoteFileWrite: false }, files: { '/home/demo/app.log': 'a\nb\n' } })
  await assert.rejects(
    () => h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'x' }, h.exec),
    /remote file writes are disabled/,
  )
  await assert.rejects(
    () => h.edit.execute({ server: 'web-1', path: '/home/demo/app.log', oldText: 'a', newText: 'x' }, h.exec),
    /remote file writes are disabled/,
  )
  assert.equal(h.activities.length, 0)
})

test('the settings override enables writes without touching the config', async () => {
  const h = makeHarness({ config: { ...CONFIG, remoteFileWrite: false }, files: { '/home/demo/app.log': 'a\n' } })
  const { savePrefs } = await import('../lib/core/prefs.js')
  savePrefs({ remoteFileWrite: true })
  const written = await h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'z\n' }, h.exec)
  assert.match(written.text, /wrote: 2 bytes/)
  assert.equal(h.store.get('/home/demo/app.log'), 'z\n')
})

test('the settings override can also close writes the config opened', async () => {
  const h = makeHarness({ config: { ...CONFIG, remoteFileWrite: true }, files: { '/home/demo/app.log': 'a\n' } })
  const { savePrefs } = await import('../lib/core/prefs.js')
  savePrefs({ remoteFileWrite: false })
  await assert.rejects(
    () => h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'z\n' }, h.exec),
    /remote file writes are disabled/,
  )
  assert.equal(h.store.get('/home/demo/app.log'), 'a\n')
})

test('remote_write writes content and remote_edit enforces unique matches', async () => {
  const h = makeHarness({ files: { '/home/demo/app.log': 'a\nb\na\n' } })
  const written = await h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'new\n' }, h.exec)
  assert.match(written.text, /wrote: 4 bytes/)
  assert.equal(h.store.get('/home/demo/app.log'), 'new\n')
  await h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'a\nb\na\n' }, h.exec)
  await assert.rejects(
    () => h.edit.execute({ server: 'web-1', path: '/home/demo/app.log', oldText: 'a', newText: 'x' }, h.exec),
    /occurs 2 times/,
  )
  const edited = await h.edit.execute(
    { server: 'web-1', path: '/home/demo/app.log', oldText: 'a', newText: 'x', replaceAll: true },
    h.exec,
  )
  assert.match(edited.text, /replacements: 2/)
  assert.equal(h.store.get('/home/demo/app.log'), 'x\nb\nx\n')
})

test('remote_glob walks directories and skips symlinks', async () => {
  const h = makeHarness({ files: { '/home/demo/configs/nginx.conf': 'x' } })
  const result = await h.glob.execute({ server: 'web-1', pattern: '**/*.conf', path: '/home/demo' }, h.exec)
  assert.match(result.text, /matches: 1/)
  assert.match(result.text, /\/home\/demo\/configs\/nginx\.conf/)
  assert.doesNotMatch(result.text, /\/home\/demo\/link/)
})

test('remote_grep uses grep on POSIX and Select-String on Windows', async () => {
  const posix = makeHarness({ files: { '/home/demo/app.log': 'x' } })
  const p = await posix.grep.execute({ server: 'web-1', pattern: 'listen', path: '/home/demo/app.log' }, posix.exec)
  assert.match(p.text, /listen 80/)
  assert.match(posix.execCalls[0].command, /^grep -R -I -n -E/)
  assert.equal(posix.execCalls[0].options.readOnly, true)

  const windows = makeHarness({ files: { '/home/demo/app.log': 'x' } })
  const w = await windows.grep.execute({ server: 'winbox', pattern: 'listen', path: '/home/demo/app.log' }, windows.exec)
  assert.match(w.text, /listen 80/)
  assert.match(windows.execCalls[0].command, /powershell\.exe .*EncodedCommand/)
})

test('remote_write replaces a POSIX file atomically and keeps its mode', async () => {
  const h = makeHarness({ files: { '/home/demo/app.log': 'old\n' } })
  const result = await h.write.execute({ server: 'web-1', path: '/home/demo/app.log', content: 'new\n' }, h.exec)
  assert.match(result.text, /wrote: 4 bytes \(atomic replace\)/)
  assert.equal(h.store.get('/home/demo/app.log'), 'new\n')
  assert.equal(
    [...h.store.keys()].some((key) => key.includes('.sdh-tmp-')),
    false,
  )
  assert.equal(h.chmodCalls.length, 1)
  assert.equal(h.chmodCalls[0].mode, 0o644)
})

test('remote_write writes through a symlink instead of replacing it', async () => {
  const h = makeHarness({ files: { '/home/demo/app.log': 'old\n' } })
  const result = await h.write.execute({ server: 'web-1', path: '/home/demo/link', content: 'new\n' }, h.exec)
  assert.match(result.text, /\(written through symlink\)/)
  assert.equal(h.store.get('/home/demo/link'), 'new\n')
  assert.equal(h.chmodCalls.length, 0)
})
