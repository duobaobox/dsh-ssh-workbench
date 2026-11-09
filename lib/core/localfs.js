/**
 * Bounded local-filesystem browser for the workbench's local side.
 *
 * The workbench is a user-driven surface, not a model tool, but it still must
 * not become a privilege escalation around the session sandbox. Every path is
 * resolved inside one root (the Host's default working directory) and escapes
 * (`..`, absolute paths outside the root, symlinks leaving it) are rejected
 * before any filesystem call.
 *
 * Two different notions of "resolve" are needed:
 *  - read/list follow the final component (`resolve`), because following a
 *    symlink inside the root is legitimate for reading;
 *  - remove/rename operate on the directory entry itself (`resolveEntry`), so
 *    they never follow a final symlink (deleting or renaming the link must not
 *    touch its target).
 * Writes/mkdirs are the strictest case: an existing final symlink is refused
 * outright and every existing path component must canonicalize inside the real
 * root, including when the final component does not exist yet.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const MAX_READ_BYTES = 5 * 1024 * 1024
const MAX_WRITE_BYTES = 20 * 1024 * 1024

const OUTSIDE_ERROR = 'path is outside the local workspace root'
const SYMLINK_WRITE_ERROR = 'refusing to write through a symlink'
const ROOT_REMOVE_ERROR = 'refusing to remove the local workspace root'
const ROOT_RENAME_ERROR = 'refusing to rename the local workspace root'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function isMissing(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}

/** Whether `target` is `root` itself or a path below it (handles root === '/'). */
function withinRoot(target, root) {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

/** Whether a canonical `real` path is the root itself or lives under it. */
function isUnder(real, realRoot) {
  // A root that does not exist yet has no canonical form; lexical containment
  // (checked by the caller) is then the strongest guarantee available.
  if (realRoot == null) return true
  return withinRoot(real, realRoot)
}

function assertInside(real, realRoot) {
  if (!isUnder(real, realRoot)) throw new Error(OUTSIDE_ERROR)
}

/** Render the permission bits of a lstat mode as `rwxrwxrwx`. */
function permissionsOf(mode) {
  const bits = []
  for (let shift = 8; shift >= 0; shift -= 1) {
    const bit = 1 << shift
    bits.push(mode & bit ? 'rwx'[(8 - shift) % 3] : '-')
  }
  return bits.join('')
}

/**
 * Synthesize an `ls -l`-style longname. The remote SFTP side gets this string
 * from the server's readdir longname field; locally we build an equivalent so
 * the shared files panel receives the same entry shape.
 */
function longnameOf(info, name) {
  const type = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : '-'
  const when = new Date(info.mtimeMs)
  const day = String(when.getDate()).padStart(2, ' ')
  const hour = String(when.getHours()).padStart(2, '0')
  const minute = String(when.getMinutes()).padStart(2, '0')
  const stamp = `${MONTHS[when.getMonth()]} ${day} ${hour}:${minute}`
  return `${type}${permissionsOf(info.mode)} ${info.nlink ?? 1} ${info.uid ?? 0} ${info.gid ?? 0} ${info.size} ${stamp} ${name}`
}

export function createLocalFs({ getRoot } = {}) {
  /** Configured (lexical) root; kept synchronous for route/config callers. */
  function rootPath() {
    const value = typeof getRoot === 'function' ? getRoot() : undefined
    return path.resolve(value || os.homedir())
  }

  /** Canonical root, or `null` when the configured root does not exist yet. */
  async function rootRealOrNull() {
    try {
      return await fsp.realpath(rootPath())
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  /** Canonical root (`realpath`); falls back to the lexical root if missing. */
  async function rootReal() {
    return (await rootRealOrNull()) ?? rootPath()
  }

  async function lstatOrNull(target) {
    try {
      return await fsp.lstat(target)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  /**
   * Map a caller path onto an absolute lexical candidate.
   *
   * Both the configured root and its canonical realpath are accepted, so the
   * canonical `entry.path` values returned by `list()` remain usable as
   * navigation inputs when the configured root itself contains symlinked
   * components (macOS `/tmp` -> `/private/tmp`, linked homes, etc.).
   */
  function candidateFor(input, realRoot) {
    const lexicalRoot = rootPath()
    const canonicalRoot = realRoot ?? lexicalRoot
    const raw = typeof input === 'string' && input.trim() ? input.trim() : ''
    const candidate =
      raw === '' ? lexicalRoot : path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(lexicalRoot, raw)
    const insideLexical = withinRoot(candidate, lexicalRoot)
    const insideReal = withinRoot(candidate, canonicalRoot)
    if (!insideLexical && !insideReal) throw new Error(OUTSIDE_ERROR)
    return candidate
  }

  /**
   * Canonicalize a path that may not exist yet by walking up to the deepest
   * existing ancestor. That ancestor must canonicalize inside the real root;
   * the missing remainder cannot contain symlinks and is appended lexically.
   *
   * A dangling symlink anywhere in the chain is never silently followed:
   * `dangling: 'propagate'` surfaces ENOENT (read/list semantics) and
   * `dangling: 'reject'` refuses the operation (write/mkdir semantics).
   */
  async function canonicalizeMissing(candidate, realRoot, dangling) {
    let cursor = candidate
    const missing = []
    for (;;) {
      const info = await lstatOrNull(cursor)
      if (info) {
        if (info.isSymbolicLink()) {
          let real
          try {
            real = await fsp.realpath(cursor)
          } catch (error) {
            if (isMissing(error)) {
              if (dangling === 'reject') throw new Error(SYMLINK_WRITE_ERROR)
              throw error
            }
            throw error
          }
          assertInside(real, realRoot)
          return path.join(real, ...missing)
        }
        const real = await fsp.realpath(cursor)
        assertInside(real, realRoot)
        return path.join(real, ...missing)
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new Error(OUTSIDE_ERROR)
      missing.unshift(path.basename(cursor))
      cursor = parent
    }
  }

  /**
   * Resolve a caller path for read/list: symlinks are followed and the result
   * is the canonical real path. Non-existent final components are allowed
   * through (the caller's fs call reports ENOENT) but their existing parent
   * chain must still canonicalize inside the root.
   */
  async function resolveInside(input) {
    const realRoot = await rootRealOrNull()
    const candidate = candidateFor(input, realRoot)
    try {
      const real = await fsp.realpath(candidate)
      assertInside(real, realRoot)
      return real
    } catch (error) {
      if (isMissing(error)) return await canonicalizeMissing(candidate, realRoot, 'propagate')
      throw error
    }
  }

  /**
   * Resolve a caller path as a *directory entry*: parents are followed and
   * canonicalized inside the root, but the final component is not followed.
   * Used by remove/rename so a symlink is operated on as a link, never as its
   * target.
   */
  async function resolveEntry(input) {
    const realRoot = await rootRealOrNull()
    const lexicalRoot = rootPath()
    const candidate = candidateFor(input, realRoot)
    // The root itself has no directory-entry form; hand it back so remove/
    // rename can reject it explicitly (B14) instead of recursing into it.
    if (candidate === lexicalRoot || (realRoot != null && candidate === realRoot)) return candidate
    const realParent = await fsp.realpath(path.dirname(candidate))
    assertInside(realParent, realRoot)
    return path.join(realParent, path.basename(candidate))
  }

  /**
   * Resolve a write/mkdir target.
   *
   * - an existing final symlink is refused (`refusing to write through a
   *   symlink`), even when it points inside the root;
   * - parents are canonicalized through symlinks and must stay inside root;
   * - non-existent targets validate their deepest existing ancestor, so a
   *   symlinked parent plus a brand-new child name cannot escape (S1).
   */
  async function resolveCreateTarget(input) {
    const realRoot = await rootRealOrNull()
    const candidate = candidateFor(input, realRoot)
    const direct = await lstatOrNull(candidate)
    if (direct) {
      if (direct.isSymbolicLink()) throw new Error(SYMLINK_WRITE_ERROR)
      const real = await fsp.realpath(candidate)
      assertInside(real, realRoot)
      return real
    }
    return canonicalizeMissing(candidate, realRoot, 'reject')
  }

  async function list(input) {
    const directory = await resolveInside(input)
    const realRoot = await rootReal()
    const stat = await fsp.stat(directory)
    if (!stat.isDirectory()) throw new Error('not a directory')
    const rows = await fsp.readdir(directory, { withFileTypes: true })
    const entries = []
    for (const row of rows) {
      const full = path.join(directory, row.name)
      // A file removed mid-listing (or an entry we cannot stat) still lists by
      // name, as before; type detection prefers lstat because following a
      // symlink mis-typed link-to-directory entries and enabled S2 data loss.
      let info = null
      try {
        info = await fsp.lstat(full)
      } catch {
        info = null
      }
      const type = info
        ? info.isSymbolicLink()
          ? 'link'
          : info.isDirectory()
            ? 'dir'
            : 'file'
        : row.isSymbolicLink()
          ? 'link'
          : row.isDirectory()
            ? 'dir'
            : 'file'
      entries.push({
        name: row.name,
        path: full,
        type,
        size: info ? (info.isDirectory() ? 0 : info.size) : 0,
        mtime: info ? info.mtimeMs : null,
        atime: info ? info.atimeMs : null,
        mode: info ? info.mode : null,
        uid: info ? info.uid : null,
        gid: info ? info.gid : null,
        longname: info ? longnameOf(info, row.name) : row.name,
      })
    }
    entries.sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === 'dir') return -1
        if (right.type === 'dir') return 1
      }
      return left.name.localeCompare(right.name)
    })
    return {
      root: realRoot,
      path: directory,
      entries,
      parent: directory === realRoot ? null : path.dirname(directory),
    }
  }

  async function read(input, maxBytes = MAX_READ_BYTES) {
    const file = await resolveInside(input)
    const stat = await fsp.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
    const size = stat.size
    const limit = Math.min(Math.max(Number(maxBytes) || MAX_READ_BYTES, 1), MAX_READ_BYTES)
    const handle = await fsp.open(file, 'r')
    try {
      const length = Math.min(size, limit)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      return {
        path: file,
        size,
        mtime: stat.mtimeMs,
        truncated: size > bytesRead,
        base64: buffer.subarray(0, bytesRead).toString('base64'),
      }
    } finally {
      await handle.close()
    }
  }

  async function write(input, contentBase64) {
    if (typeof contentBase64 !== 'string') throw new Error('contentBase64 is required')
    const buffer = Buffer.from(contentBase64, 'base64')
    if (buffer.length > MAX_WRITE_BYTES) throw new Error(`file exceeds ${MAX_WRITE_BYTES} bytes`)
    const file = await resolveCreateTarget(input)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, buffer)
    return { path: file, size: buffer.length }
  }

  async function mkdir(input) {
    const directory = await resolveCreateTarget(input)
    await fsp.mkdir(directory, { recursive: true })
    return { path: directory }
  }

  async function remove(input) {
    const target = await resolveEntry(input)
    const lexicalRoot = rootPath()
    const realRoot = await rootReal()
    // Empty input resolves to the root; deleting it must never be possible.
    if (target === lexicalRoot || target === realRoot) throw new Error(ROOT_REMOVE_ERROR)
    const info = await lstatOrNull(target)
    if (!info) return { path: target, removed: false }
    if (info.isSymbolicLink()) {
      // Unlink the link itself; never follow it (a link can point outside the
      // root and still be safely removable without touching its target, B7).
      await fsp.unlink(target)
    } else if (info.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: true })
    } else {
      await fsp.unlink(target)
    }
    return { path: target, removed: true }
  }

  async function rename(from, to) {
    // Operate on directory entries: a symlink is moved as a link, not as its
    // target (B4), and the destination's parents are canonicalized inside root.
    const source = await resolveEntry(from)
    const destination = await resolveEntry(to)
    const lexicalRoot = rootPath()
    const realRoot = await rootReal()
    for (const target of [source, destination]) {
      if (target === lexicalRoot || target === realRoot) throw new Error(ROOT_RENAME_ERROR)
    }
    // Match the remote SFTP semantics: rename must not silently overwrite.
    const existing = await lstatOrNull(destination)
    if (existing) throw new Error(`destination already exists: ${destination}`)
    await fsp.rename(source, destination)
    return { path: destination }
  }

  return {
    root: rootPath,
    rootReal,
    resolve: resolveInside,
    resolveEntry,
    list,
    read,
    write,
    mkdir,
    remove,
    rename,
  }
}
