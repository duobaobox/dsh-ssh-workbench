import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createLocalFs } from '../lib/core/localfs.js'
import { createLocalFileApi, LOCAL_FILE_REF } from '../lib/core/local-file-api.js'

const b64 = (value) => Buffer.from(value).toString('base64')

function makeRoot(prefix = 'dsh-ssh-workbench-localapi-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeAll(...targets) {
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true })
}

function symlinksAvailable() {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-symlink-probe-'))
  try {
    fs.symlinkSync(probe, path.join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

function exists(target) {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

test('the local file API mirrors the SFTP surface for the shared panel', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
  const localfs = createLocalFs({ getRoot: () => root })
  const api = createLocalFileApi(localfs)
  t.after(() => api.dispose())
  assert.equal(api.server.id, LOCAL_FILE_REF)
  assert.equal(api.server.platform, 'local')

  // Remote transfer sessions start in the login home; the local adapter
  // reports the canonical workspace root in the same shape.
  assert.equal(await api.sftpHome(api.server), fs.realpathSync(root))

  const entries = await api.sftpList(api.server, root)
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt'])

  const read = await api.sftpRead(api.server, path.join(root, 'a.txt'))
  assert.equal(read.content, 'hello')
  assert.equal(read.binary, false)

  const write = await api.sftpOpenWrite(api.server, path.join(root, 'b.txt'), true)
  await api.sftpWriteChunk(write.session, 0, Buffer.from('hello '))
  await api.sftpWriteChunk(write.session, 6, Buffer.from('world'))
  const closed = await api.sftpCloseTransfer(write.session)
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'hello world')
  assert.equal(closed.bytes, 11)
  assert.equal(closed.server, LOCAL_FILE_REF, 'close-transfer reports the local server ref (B5/B8)')

  const opened = await api.sftpOpenRead(api.server, path.join(root, 'b.txt'))
  const first = await api.sftpReadChunk(opened.session, 0, 5)
  assert.equal(Buffer.from(first.base64, 'base64').toString('utf8'), 'hello')
  const closedRead = await api.sftpCloseTransfer(opened.session)
  assert.equal(closedRead.server, LOCAL_FILE_REF)

  await api.sftpMkdir(api.server, path.join(root, 'dir'))
  await api.sftpRename(api.server, path.join(root, 'b.txt'), path.join(root, 'dir', 'c.txt'))
  assert.equal(fs.existsSync(path.join(root, 'dir', 'c.txt')), true)
  await api.sftpRemove(api.server, path.join(root, 'dir'), true)
  assert.equal(fs.existsSync(path.join(root, 'dir')), false)
})

test('sftpList defaults to the canonical root and close-transfer reports the server ref', async (t) => {
  const base = makeRoot()
  t.after(() => removeAll(base))
  const realRoot = path.join(base, 'real-root')
  fs.mkdirSync(path.join(realRoot, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(realRoot, 'sub', 'nested.txt'), 'nested')
  const rootLink = path.join(base, 'root-link')
  try {
    fs.symlinkSync(realRoot, rootLink)
  } catch {
    return t.skip('symlinks unavailable on this platform')
  }
  const api = createLocalFileApi(createLocalFs({ getRoot: () => rootLink }))
  t.after(() => api.dispose())

  assert.equal(await api.sftpHome(api.server), fs.realpathSync(realRoot))

  const entries = await api.sftpList(api.server)
  assert.deepEqual(entries.map((entry) => entry.name), ['sub'])
  assert.equal(entries[0].path, path.join(fs.realpathSync(realRoot), 'sub'))
  // Navigation with the canonical entry path must work (S3).
  const nested = await api.sftpList(api.server, entries[0].path)
  assert.deepEqual(nested.map((entry) => entry.name), ['nested.txt'])

  const missing = await api.sftpCloseTransfer('loc-does-not-exist')
  assert.equal(missing.path, null)
  assert.equal(missing.server, LOCAL_FILE_REF)
})

test('the local file API cannot escape the workspace root', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  const api = createLocalFileApi(createLocalFs({ getRoot: () => root }))
  t.after(() => api.dispose())
  await assert.rejects(() => api.sftpRead(api.server, path.join(outside, 'secret.txt')), /outside the local workspace/)
  await assert.rejects(() => api.sftpList(api.server, '/'), /outside the local workspace/)
})

test('open-write cannot follow a symlink out of the root or write through a final link', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.symlinkSync(outside, path.join(root, 'link-out'))
  fs.mkdirSync(path.join(outside, 'sub'))
  fs.writeFileSync(path.join(root, 'target.txt'), 'original')
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'file-link'))
  fs.symlinkSync(path.join(outside, 'never-created.txt'), path.join(root, 'dangling-link'))
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const api = createLocalFileApi(createLocalFs({ getRoot: () => root }))
  t.after(() => api.dispose())

  await assert.rejects(
    () => api.sftpOpenWrite(api.server, 'link-out/escaped.txt', true),
    /outside the local workspace root/,
  )
  await assert.rejects(
    () => api.sftpOpenWrite(api.server, 'link-out/sub/escaped.txt', true),
    /outside the local workspace root/,
  )
  // A missing parent under the escaping link fails closed without writing.
  await assert.rejects(() => api.sftpOpenWrite(api.server, 'link-out/missing/escaped.txt', true), /ENOENT/)
  assert.equal(exists(path.join(outside, 'escaped.txt')), false)
  assert.equal(exists(path.join(outside, 'sub', 'escaped.txt')), false)
  assert.equal(exists(path.join(outside, 'missing')), false)

  await assert.rejects(
    () => api.sftpOpenWrite(api.server, 'file-link', true),
    /refusing to write through a symlink/,
  )
  await assert.rejects(
    () => api.sftpOpenWrite(api.server, 'file-link', false),
    /refusing to write through a symlink/,
  )
  await assert.rejects(
    () => api.sftpOpenWrite(api.server, 'dangling-link', true),
    /refusing to write through a symlink/,
  )
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'original')
  assert.equal(exists(path.join(outside, 'never-created.txt')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('open-write may pass through a symlink that stays inside the root', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')
  fs.mkdirSync(path.join(root, 'real-dir'))
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'inside-link'))
  const api = createLocalFileApi(createLocalFs({ getRoot: () => root }))
  t.after(() => api.dispose())

  const opened = await api.sftpOpenWrite(api.server, 'inside-link/upload.txt', true)
  await api.sftpWriteChunk(opened.session, 0, Buffer.from('uploaded'))
  await api.sftpCloseTransfer(opened.session)
  assert.equal(fs.readFileSync(path.join(root, 'real-dir', 'upload.txt'), 'utf8'), 'uploaded')
})

test('sftpRemove unlinks symlinks instead of following them (S2/B3/B7)', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.mkdirSync(path.join(root, 'real-tree'))
  fs.writeFileSync(path.join(root, 'real-tree', 'important.txt'), 'keep me')
  fs.symlinkSync(path.join(root, 'real-tree'), path.join(root, 'link-tree'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link'))
  const api = createLocalFileApi(createLocalFs({ getRoot: () => root }))
  t.after(() => api.dispose())

  await api.sftpRemove(api.server, 'link-tree', false)
  assert.equal(exists(path.join(root, 'link-tree')), false)
  assert.equal(fs.readFileSync(path.join(root, 'real-tree', 'important.txt'), 'utf8'), 'keep me')

  // A link leaving the root is removable; its target must stay untouched.
  await api.sftpRemove(api.server, 'outside-link', false)
  assert.equal(exists(path.join(root, 'outside-link')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('sftpRename moves the symlink entry itself and refuses to overwrite (B4)', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(root, 'rename-target.txt'), 'target')
  fs.symlinkSync(path.join(root, 'rename-target.txt'), path.join(root, 'rename-link.txt'))
  fs.writeFileSync(path.join(root, 'from.txt'), 'from')
  fs.writeFileSync(path.join(root, 'to.txt'), 'to')
  const api = createLocalFileApi(createLocalFs({ getRoot: () => root }))
  t.after(() => api.dispose())

  await api.sftpRename(api.server, 'rename-link.txt', 'rename-link-2.txt')
  assert.equal(exists(path.join(root, 'rename-link.txt')), false)
  assert.equal(fs.lstatSync(path.join(root, 'rename-link-2.txt')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(root, 'rename-target.txt'), 'utf8'), 'target')

  await assert.rejects(
    () => api.sftpRename(api.server, 'from.txt', 'to.txt'),
    /destination already exists/,
  )
  assert.equal(fs.readFileSync(path.join(root, 'from.txt'), 'utf8'), 'from')
  assert.equal(fs.readFileSync(path.join(root, 'to.txt'), 'utf8'), 'to')
})

test('sftpRemove refuses to delete the workspace root (B14)', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  fs.writeFileSync(path.join(root, 'file.txt'), 'x')
  const localfs = createLocalFs({ getRoot: () => root })
  const api = createLocalFileApi(localfs)
  t.after(() => api.dispose())

  await assert.rejects(() => api.sftpRemove(api.server, ''), /refusing to remove the local workspace root/)
  await assert.rejects(() => api.sftpRemove(api.server, root), /refusing to remove the local workspace root/)
  const canonicalRoot = await localfs.rootReal()
  await assert.rejects(
    () => api.sftpRemove(api.server, canonicalRoot),
    /refusing to remove the local workspace root/,
  )
  assert.equal(fs.existsSync(root), true)
  assert.equal(fs.existsSync(path.join(root, 'file.txt')), true)
})
