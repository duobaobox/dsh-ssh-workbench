/**
 * Security/data-safety regressions for the bounded local filesystem browser.
 *
 * Covers qa/REPORT.md S1/S2/S3 and qa/files/report.md B1/B3/B4/B7/B13/B14:
 *  - S1/B1: a symlinked parent plus a brand-new child name must not write,
 *    mkdir or rename outside the real root;
 *  - S2/B3: symlinks are listed as `link` and deleting one unlinks the link
 *    instead of following it into a real directory tree;
 *  - S3/B2: a root with symlinked components stays navigable through the
 *    canonical paths returned by list();
 *  - B4: rename operates on the entry itself and refuses to overwrite;
 *  - B7: a symlink pointing outside the root can be unlinked safely;
 *  - B14: the workspace root itself can never be removed/renamed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createLocalFs } from '../lib/core/localfs.js'

const b64 = (value) => Buffer.from(value).toString('base64')

function makeRoot(prefix = 'dsh-ssh-workbench-localfs-sec-') {
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

test('S1/B1: write, mkdir and rename cannot escape through a symlinked parent with a new child name', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  fs.symlinkSync(outside, path.join(root, 'link-out'))
  fs.writeFileSync(path.join(root, 'source.txt'), 'source')
  const localfs = createLocalFs({ getRoot: () => root })

  await assert.rejects(() => localfs.write('link-out/escaped.txt', b64('escaped')), /outside the local workspace root/)
  await assert.rejects(
    () => localfs.write('link-out/missing/deep/escaped.txt', b64('escaped')),
    /outside the local workspace root/,
  )
  await assert.rejects(() => localfs.mkdir('link-out/escaped-dir'), /outside the local workspace root/)
  await assert.rejects(() => localfs.mkdir('link-out/missing/escaped-dir'), /outside the local workspace root/)
  await assert.rejects(() => localfs.rename('source.txt', 'link-out/escaped.txt'), /outside the local workspace root/)

  assert.equal(exists(path.join(outside, 'escaped.txt')), false)
  assert.equal(exists(path.join(outside, 'missing')), false)
  assert.equal(exists(path.join(outside, 'escaped-dir')), false)
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'source')
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('S1/B1: an existing final symlink is never written or mkdir-ed through', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(root, 'target.txt'), 'original')
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'file-link'))
  fs.mkdirSync(path.join(root, 'real-dir'))
  fs.symlinkSync(path.join(root, 'real-dir'), path.join(root, 'dir-link'))
  fs.symlinkSync(path.join(outside, 'never-created.txt'), path.join(root, 'dangling-link'))
  const localfs = createLocalFs({ getRoot: () => root })

  await assert.rejects(() => localfs.write('file-link', b64('overwritten')), /refusing to write through a symlink/)
  await assert.rejects(
    () => localfs.write(path.join(root, 'file-link'), b64('overwritten')),
    /refusing to write through a symlink/,
  )
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'original')

  await assert.rejects(() => localfs.mkdir('dir-link'), /refusing to write through a symlink/)
  await assert.rejects(() => localfs.write('dangling-link', b64('x')), /refusing to write through a symlink/)
  assert.equal(exists(path.join(outside, 'never-created.txt')), false)
})

test('S2/B3: list reports symlinks as link and remove unlinks them without touching the target tree', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.mkdirSync(path.join(root, 'real-tree'))
  fs.writeFileSync(path.join(root, 'real-tree', 'important.txt'), 'keep me')
  fs.symlinkSync(path.join(root, 'real-tree'), path.join(root, 'link-tree'))
  fs.writeFileSync(path.join(root, 'target.txt'), 'target')
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link-file'))
  fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'link-broken'))
  const localfs = createLocalFs({ getRoot: () => root })

  const listing = await localfs.list(root)
  const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]))
  assert.equal(byName['link-tree'].type, 'link')
  assert.equal(byName['link-file'].type, 'link')
  assert.equal(byName['link-broken'].type, 'link')

  // Deleting the link-to-directory entry must not recurse into the real tree.
  await localfs.remove(byName['link-tree'].path)
  assert.equal(exists(path.join(root, 'link-tree')), false)
  assert.equal(fs.readFileSync(path.join(root, 'real-tree', 'important.txt'), 'utf8'), 'keep me')

  // Same via a lexical input.
  fs.symlinkSync(path.join(root, 'real-tree'), path.join(root, 'link-tree-2'))
  await localfs.remove('link-tree-2')
  assert.equal(exists(path.join(root, 'link-tree-2')), false)
  assert.equal(fs.readFileSync(path.join(root, 'real-tree', 'important.txt'), 'utf8'), 'keep me')

  // The real directory can still be removed recursively when asked for.
  await localfs.remove('real-tree')
  assert.equal(exists(path.join(root, 'real-tree')), false)
})

test('S2/B3: recursive delete of a real directory never follows symlinks inside it', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(outside, 'precious.txt'), 'precious')
  fs.mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tree', 'sub', 'f.txt'), 'f')
  fs.symlinkSync(outside, path.join(root, 'tree', 'outside-dir-link'))
  fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(root, 'tree', 'outside-file-link'))
  const localfs = createLocalFs({ getRoot: () => root })

  await localfs.remove('tree')
  assert.equal(exists(path.join(root, 'tree')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'precious')
})

test('B4: rename moves the symlink entry itself, not its target', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(root, 'rename-target.txt'), 'target')
  fs.symlinkSync(path.join(root, 'rename-target.txt'), path.join(root, 'rename-link.txt'))
  fs.symlinkSync(path.join(root, 'never-created'), path.join(root, 'broken-link.txt'))
  const localfs = createLocalFs({ getRoot: () => root })

  const result = await localfs.rename('rename-link.txt', 'rename-link-2.txt')
  assert.equal(result.path, path.join(fs.realpathSync(root), 'rename-link-2.txt'))
  assert.equal(exists(path.join(root, 'rename-link.txt')), false)
  assert.equal(fs.lstatSync(path.join(root, 'rename-link-2.txt')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(root, 'rename-target.txt'), 'utf8'), 'target')
  assert.equal(fs.readlinkSync(path.join(root, 'rename-link-2.txt')), path.join(root, 'rename-target.txt'))

  // Broken links can be renamed too (the operation is on the directory entry).
  await localfs.rename('broken-link.txt', 'broken-link-2.txt')
  assert.equal(fs.lstatSync(path.join(root, 'broken-link-2.txt')).isSymbolicLink(), true)
})

test('B4: rename refuses to overwrite an existing destination', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  const localfs = createLocalFs({ getRoot: () => root })
  fs.writeFileSync(path.join(root, 'from.txt'), 'from')
  fs.writeFileSync(path.join(root, 'to.txt'), 'to')

  await assert.rejects(() => localfs.rename('from.txt', 'to.txt'), /destination already exists/)
  assert.equal(fs.readFileSync(path.join(root, 'from.txt'), 'utf8'), 'from')
  assert.equal(fs.readFileSync(path.join(root, 'to.txt'), 'utf8'), 'to')
})

test('B7: a symlink pointing outside the root can be unlinked without following it', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link'))
  fs.symlinkSync(outside, path.join(root, 'outside-dir-link'))
  const localfs = createLocalFs({ getRoot: () => root })

  const listing = await localfs.list(root)
  const fileLink = listing.entries.find((entry) => entry.name === 'outside-link')
  assert.equal(fileLink.type, 'link')

  await localfs.remove(fileLink.path)
  assert.equal(exists(path.join(root, 'outside-link')), false)
  await localfs.remove('outside-dir-link')
  assert.equal(exists(path.join(root, 'outside-dir-link')), false)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('B14: remove and rename refuse to operate on the workspace root itself', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  const localfs = createLocalFs({ getRoot: () => root })
  fs.writeFileSync(path.join(root, 'file.txt'), 'x')

  const realRoot = await localfs.rootReal()
  await assert.rejects(() => localfs.remove(''), /refusing to remove the local workspace root/)
  await assert.rejects(() => localfs.remove('.'), /refusing to remove the local workspace root/)
  await assert.rejects(() => localfs.remove(root), /refusing to remove the local workspace root/)
  await assert.rejects(() => localfs.remove(realRoot), /refusing to remove the local workspace root/)
  await assert.rejects(() => localfs.rename('', 'moved'), /refusing to rename the local workspace root/)
  await assert.rejects(() => localfs.rename(realRoot, 'moved'), /refusing to rename the local workspace root/)
  await assert.rejects(() => localfs.rename('file.txt', ''), /refusing to rename the local workspace root/)
  await assert.rejects(() => localfs.rename('file.txt', root), /refusing to rename the local workspace root/)

  assert.equal(fs.existsSync(root), true)
  assert.equal(fs.existsSync(path.join(root, 'file.txt')), true)
})

test('S3/B2: a root with symlinked components is navigable through canonical list paths', async (t) => {
  const base = makeRoot()
  t.after(() => removeAll(base))
  const realRoot = path.join(base, 'real-root')
  fs.mkdirSync(realRoot)
  fs.mkdirSync(path.join(realRoot, 'sub'))
  fs.writeFileSync(path.join(realRoot, 'sub', 'nested.txt'), 'nested')
  fs.writeFileSync(path.join(realRoot, 'top.txt'), 'top')
  const rootLink = path.join(base, 'root-link')
  try {
    fs.symlinkSync(realRoot, rootLink)
  } catch {
    return t.skip('symlinks unavailable on this platform')
  }
  const localfs = createLocalFs({ getRoot: () => rootLink })
  const canonicalRoot = fs.realpathSync(realRoot)

  assert.equal(localfs.root(), path.resolve(rootLink))
  assert.equal(await localfs.rootReal(), canonicalRoot)

  // list() reports only canonical paths, whether called with the lexical root
  // or the canonical root.
  const top = await localfs.list(rootLink)
  assert.equal(top.root, canonicalRoot)
  assert.equal(top.path, canonicalRoot)
  assert.equal(top.parent, null)
  const topViaCanonical = await localfs.list(canonicalRoot)
  assert.equal(topViaCanonical.path, canonicalRoot)

  const sub = top.entries.find((entry) => entry.name === 'sub')
  assert.equal(sub.path, path.join(canonicalRoot, 'sub'))

  // The client navigates with entry.path; that must work (previously a 400).
  const child = await localfs.list(sub.path)
  assert.equal(child.path, path.join(canonicalRoot, 'sub'))
  assert.deepEqual(child.entries.map((entry) => entry.name), ['nested.txt'])
  assert.equal(child.parent, canonicalRoot)

  // Reading and writing through canonical paths must work as well.
  const nested = child.entries[0]
  assert.equal(Buffer.from((await localfs.read(nested.path)).base64, 'base64').toString('utf8'), 'nested')
  await localfs.write(path.join(sub.path, 'from-canonical.txt'), b64('canonical'))
  assert.equal(fs.readFileSync(path.join(realRoot, 'sub', 'from-canonical.txt'), 'utf8'), 'canonical')

  // Lexical absolute paths under the configured root keep working too.
  await localfs.list(path.join(rootLink, 'sub'))
  assert.equal(Buffer.from((await localfs.read(path.join(rootLink, 'top.txt'))).base64, 'base64').toString('utf8'), 'top')

  // rename/remove via canonical paths operate inside the canonical root.
  await localfs.write(path.join(top.path, 'before.txt'), b64('before'))
  await localfs.rename(path.join(top.path, 'before.txt'), path.join(top.path, 'after.txt'))
  assert.equal(fs.existsSync(path.join(realRoot, 'after.txt')), true)
  await localfs.remove(path.join(top.path, 'after.txt'))
  assert.equal(fs.existsSync(path.join(realRoot, 'after.txt')), false)

  // Escaping via ./../ outside the configured (symlinked) root is still denied.
  await assert.rejects(() => localfs.list(path.join(base, 'outside.txt')), /outside the local workspace root/)
})

test('symlinks that stay inside the root are readable, outside links are not', async (t) => {
  const root = makeRoot()
  const outside = makeRoot()
  t.after(() => removeAll(root, outside))
  if (!symlinksAvailable()) return t.skip('symlinks unavailable on this platform')

  fs.writeFileSync(path.join(root, 'inside.txt'), 'inside')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'x.txt'), 'sub-x')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(path.join(root, 'inside.txt'), path.join(root, 'inside-link'))
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'inside-dir-link'))
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link'))
  fs.symlinkSync(outside, path.join(root, 'outside-dir-link'))
  const localfs = createLocalFs({ getRoot: () => root })

  assert.equal(Buffer.from((await localfs.read('inside-link')).base64, 'base64').toString('utf8'), 'inside')
  const viaDirLink = await localfs.list('inside-dir-link')
  assert.deepEqual(viaDirLink.entries.map((entry) => entry.name), ['x.txt'])
  assert.equal(Buffer.from((await localfs.read('inside-dir-link/x.txt')).base64, 'base64').toString('utf8'), 'sub-x')

  await assert.rejects(() => localfs.read('outside-link'), /outside the local workspace root/)
  await assert.rejects(() => localfs.list('outside-dir-link'), /outside the local workspace root/)
  await assert.rejects(() => localfs.read('outside-dir-link/secret.txt'), /outside the local workspace root/)
  await assert.rejects(() => localfs.resolve('outside-dir-link/secret.txt'), /outside the local workspace root/)
})

test('S1 regression: missing inside-root paths resolve lexically instead of the old unsafe fallback', async (t) => {
  const root = makeRoot()
  t.after(() => removeAll(root))
  const localfs = createLocalFs({ getRoot: () => root })
  const realRoot = fs.realpathSync(root)

  assert.equal(await localfs.resolve('new-file.txt'), path.join(realRoot, 'new-file.txt'))
  assert.equal(await localfs.resolve('missing/deep/file.txt'), path.join(realRoot, 'missing', 'deep', 'file.txt'))
  assert.equal(await localfs.resolveEntry('new-file.txt'), path.join(realRoot, 'new-file.txt'))

  // Writing to a nested new path still creates the parent directories.
  await localfs.write('created/deep/file.txt', b64('deep'))
  assert.equal(fs.readFileSync(path.join(root, 'created', 'deep', 'file.txt'), 'utf8'), 'deep')
})
