import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createLocalFs } from '../lib/core/localfs.js'

const b64 = (value) => Buffer.from(value).toString('base64')

function makeRoot(prefix = 'dsh-ssh-workbench-localfs-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeAll(...targets) {
  for (const target of targets) fs.rmSync(target, { recursive: true, force: true })
}

/** Symlinks may be unavailable (e.g. unprivileged Windows); skip then. */
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

test('local files list, read, write, mkdir, rename and remove inside the root', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
  fs.mkdirSync(path.join(root, 'dir'))
  const localfs = createLocalFs({ getRoot: () => root })

  const listing = await localfs.list(root)
  assert.equal(listing.root, fs.realpathSync(root))
  assert.equal(listing.path, fs.realpathSync(root))
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['a.txt', 'dir'])
  assert.equal(listing.entries[0].type, 'dir', 'directories sort first')
  assert.equal(listing.parent, null)

  const child = await localfs.list(path.join(listing.root, 'dir'))
  assert.deepEqual(child.entries, [])
  assert.equal(child.parent, listing.root)

  const read = await localfs.read(path.join(root, 'a.txt'))
  assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), 'hello')
  assert.equal(read.truncated, false)

  await localfs.write(path.join(root, 'b.txt'), b64('world'))
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'world')

  await localfs.write(path.join(root, 'nested', 'deep', 'file.txt'), b64('deep'))
  assert.equal(fs.readFileSync(path.join(root, 'nested', 'deep', 'file.txt'), 'utf8'), 'deep')

  await localfs.mkdir(path.join(root, 'nested', 'deep'))
  await localfs.mkdir(path.join(root, 'empty-dir'))
  assert.equal(fs.statSync(path.join(root, 'nested', 'deep')).isDirectory(), true)
  assert.equal(fs.statSync(path.join(root, 'empty-dir')).isDirectory(), true)

  await localfs.rename(path.join(root, 'b.txt'), path.join(root, 'c.txt'))
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false)
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), true)

  await localfs.remove(path.join(root, 'c.txt'))
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false)

  // Recursive delete of a real directory inside the root still works.
  await localfs.remove(path.join(root, 'nested'))
  assert.equal(fs.existsSync(path.join(root, 'nested')), false)

  // Removing a path that is already gone keeps the historic silent no-op.
  await localfs.remove(path.join(root, 'never-existed'))
})

test('local files reject lexical and symlink escapes from the root', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope')
  const localfs = createLocalFs({ getRoot: () => root })

  await assert.rejects(() => localfs.read('../secret.txt'), /outside the local workspace/)
  await assert.rejects(() => localfs.read(path.join(outside, 'secret.txt')), /outside the local workspace/)
  await assert.rejects(() => localfs.list('/'), /outside the local workspace/)
  await assert.rejects(() => localfs.list(`${path.resolve(root)}-evil`), /outside the local workspace/)
  await assert.rejects(() => localfs.resolveEntry('../secret.txt'), /outside the local workspace/)
  await assert.rejects(() => localfs.resolveEntry(path.join(outside, 'secret.txt')), /outside the local workspace/)

  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')
  fs.symlinkSync(outside, path.join(root, 'escape'))
  await assert.rejects(() => localfs.list(path.join(root, 'escape')), /outside the local workspace/)
  await assert.rejects(() => localfs.read(path.join(root, 'escape', 'secret.txt')), /outside the local workspace/)
  await assert.rejects(() => localfs.resolveEntry(path.join(root, 'escape', 'secret.txt')), /outside the local workspace/)
})

test('local reads are bounded and report truncation', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  fs.writeFileSync(path.join(root, 'big.txt'), 'abcdef')
  const localfs = createLocalFs({ getRoot: () => root })
  const read = await localfs.read(path.join(root, 'big.txt'), 3)
  assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), 'abc')
  assert.equal(read.truncated, true)
})

test('list entries expose the remote-compatible shape and link type', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(root, 'plain.txt'), 'plain')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested')
  fs.symlinkSync(path.join(root, 'plain.txt'), path.join(root, 'link-file'))
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link-dir'))
  fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'link-broken'))
  fs.symlinkSync(outside, path.join(root, 'link-outside'))
  const localfs = createLocalFs({ getRoot: () => root })

  const listing = await localfs.list(root)
  const realRoot = fs.realpathSync(root)
  assert.equal(listing.root, realRoot)
  assert.equal(listing.path, realRoot)
  assert.equal(listing.parent, null)

  const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]))
  assert.equal(byName['plain.txt'].type, 'file')
  assert.equal(byName.sub.type, 'dir')
  assert.equal(byName['link-file'].type, 'link')
  assert.equal(byName['link-dir'].type, 'link')
  assert.equal(byName['link-broken'].type, 'link')
  assert.equal(byName['link-outside'].type, 'link')

  for (const entry of listing.entries) {
    assert.equal(typeof entry.name, 'string')
    assert.equal(entry.path, path.join(realRoot, entry.name))
    assert.ok(['dir', 'file', 'link'].includes(entry.type), `type ${entry.type}`)
    assert.equal(typeof entry.size, 'number')
    assert.equal(typeof entry.mtime, 'number')
    assert.ok(entry.mtime > 1_000_000_000_000, 'mtime is in milliseconds')
    assert.equal(typeof entry.atime, 'number')
    assert.equal(typeof entry.mode, 'number')
    assert.equal(typeof entry.uid, 'number')
    assert.equal(typeof entry.gid, 'number')
    assert.equal(typeof entry.longname, 'string')
    assert.ok(entry.longname.includes(entry.name), 'longname ends with the name')
  }

  assert.equal(byName['plain.txt'].size, Buffer.byteLength('plain'))
  assert.equal(byName.sub.size, 0, 'directories keep the historic zero size')

  // Dirs sort first, then the rest alphabetically.
  const typeOrder = listing.entries.map((entry) => entry.type)
  const lastDir = typeOrder.lastIndexOf('dir')
  const firstNonDir = typeOrder.findIndex((type) => type !== 'dir')
  assert.ok(lastDir < firstNonDir || firstNonDir === -1)

  // Listing a child directory names it via the canonical parent.
  const sub = await localfs.list(path.join(realRoot, 'sub'))
  assert.equal(sub.path, path.join(realRoot, 'sub'))
  assert.equal(sub.parent, realRoot)
  assert.deepEqual(sub.entries.map((entry) => entry.name), ['nested.txt'])

  await assert.rejects(() => localfs.list(path.join(root, 'plain.txt')), /not a directory/)
  await assert.rejects(() => localfs.list(path.join(root, 'missing')), /ENOENT/)
})

test('resolve follows the final component while resolveEntry never does', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')
  fs.writeFileSync(path.join(root, 'plain.txt'), 'plain')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.symlinkSync(path.join(root, 'plain.txt'), path.join(root, 'plain-link'))
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'sub-link'))
  const localfs = createLocalFs({ getRoot: () => root })
  const realRoot = fs.realpathSync(root)

  assert.equal(await localfs.resolve('plain-link'), path.join(realRoot, 'plain.txt'))
  assert.equal(await localfs.resolveEntry('plain-link'), path.join(realRoot, 'plain-link'))
  assert.equal(await localfs.resolve('sub-link'), path.join(realRoot, 'sub'))
  assert.equal(await localfs.resolveEntry('sub-link'), path.join(realRoot, 'sub-link'))

  // A missing entry resolves to its canonical parent plus the literal name.
  assert.equal(await localfs.resolveEntry('brand-new.txt'), path.join(realRoot, 'brand-new.txt'))
  assert.equal(await localfs.resolveEntry('sub/brand-new.txt'), path.join(realRoot, 'sub', 'brand-new.txt'))
  assert.equal(await localfs.resolve('brand-new/deep.txt'), path.join(realRoot, 'brand-new', 'deep.txt'))
})

test('rootReal canonicalizes the root while root stays lexical', async (t) => {
  const base = makeRoot()
  t.after(() => removeAll(base))
  const realRoot = path.join(base, 'real-root')
  fs.mkdirSync(realRoot)
  const rootLink = path.join(base, 'root-link')
  try {
    fs.symlinkSync(realRoot, rootLink)
  } catch {
    return t.skip('symlinks unavailable on this platform')
  }
  const localfs = createLocalFs({ getRoot: () => rootLink })
  assert.equal(localfs.root(), path.resolve(rootLink))
  assert.equal(await localfs.rootReal(), fs.realpathSync(realRoot))
})

test('write and mkdir may pass through symlinks that stay inside the root', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')
  fs.mkdirSync(path.join(root, 'real-dir'))
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'inside-link'))
  const localfs = createLocalFs({ getRoot: () => root })

  await localfs.write('inside-link/through.txt', b64('ok'))
  assert.equal(fs.readFileSync(path.join(root, 'real-dir', 'through.txt'), 'utf8'), 'ok')

  await localfs.mkdir('inside-link/new-dir')
  assert.equal(fs.statSync(path.join(root, 'real-dir', 'new-dir')).isDirectory(), true)

  // Reading through an inside-root symlink is allowed (follow semantics).
  const read = await localfs.read('inside-link/through.txt')
  assert.equal(Buffer.from(read.base64, 'base64').toString('utf8'), 'ok')
  const viaLink = await localfs.list('inside-link')
  assert.equal(viaLink.path, fs.realpathSync(path.join(root, 'real-dir')))
})
