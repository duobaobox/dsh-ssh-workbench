/**
 * Local-filesystem implementation of the files-panel API.
 *
 * The workbench reuses the very same files component for remote SFTP and the
 * local workspace. This adapter gives the local side the same method surface
 * as the SSH runtime (`sftpHome`, `sftpList`, `sftpRead`, chunked open/read/
 * write sessions, mkdir/remove/rename), so the panel and the file viewer stay
 * provider-blind. Every path is resolved through the scoped local filesystem
 * browser.
 */
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const LOCAL_FILE_REF = '__local__'

const SYMLINK_WRITE_ERROR = 'refusing to write through a symlink'

export function createLocalFileApi(localfs) {
  const server = { id: LOCAL_FILE_REF, name: LOCAL_FILE_REF, platform: 'local' }
  const sessions = new Map()

  const sessionFor = (id, kind) => {
    const session = sessions.get(id)
    if (!session || session.kind !== kind) throw new Error('local transfer session not found')
    return session
  }

  async function lstatOrNull(target) {
    try {
      return await fsp.lstat(target)
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
      throw error
    }
  }

  /**
   * Open a local path for a transfer session.
   *
   * Write sessions resolve the path as a directory entry (parents followed and
   * bounded by the root, final component not followed) and refuse to write
   * through a final symlink, so an uploaded file cannot escape via a link.
   * Read sessions keep follow semantics (a symlink inside the root is readable;
   * one leaving the root is rejected by `localfs.resolve`).
   */
  async function openLocal(target, flags, { noFollowFinal = false } = {}) {
    const resolved = noFollowFinal
      ? await localfs.resolveEntry(target)
      : await localfs.resolve(target)
    if (noFollowFinal) {
      const info = await lstatOrNull(resolved)
      if (info && info.isSymbolicLink()) throw new Error(SYMLINK_WRITE_ERROR)
    }
    const handle = await fsp.open(resolved, flags)
    return { resolved, handle }
  }

  /** Canonical local workspace root, mirroring the remote login home. */
  async function sftpHome(_server) {
    return await localfs.rootReal()
  }

  async function sftpList(_server, remotePath) {
    const target = typeof remotePath === 'string' && remotePath.trim() ? remotePath : await localfs.rootReal()
    const result = await localfs.list(target)
    return result.entries
  }

  async function sftpRead(_server, remotePath, options = {}) {
    const result = await localfs.read(remotePath, options.maxBytes)
    const buffer = Buffer.from(result.base64, 'base64')
    const binary = buffer.includes(0)
    const formatted = {
      path: result.path,
      size: result.size,
      bytesRead: buffer.length,
      truncated: result.truncated,
      binary,
      content: binary ? undefined : buffer.toString('utf8'),
    }
    if (options.base64 === true) formatted.base64 = result.base64
    return formatted
  }

  async function sftpOpenWrite(_server, remotePath, truncate = true) {
    let opened
    try {
      opened = await openLocal(remotePath, truncate === false ? 'r+' : 'w', { noFollowFinal: true })
    } catch (error) {
      if (truncate === false && error && error.code === 'ENOENT') {
        opened = await openLocal(remotePath, 'w', { noFollowFinal: true })
      } else throw error
    }
    const id = `locw_${randomUUID()}`
    sessions.set(id, { kind: 'write', path: opened.resolved, handle: opened.handle })
    return { session: id, path: opened.resolved }
  }

  async function sftpWriteChunk(sessionId, offset, buffer) {
    const session = sessionFor(sessionId, 'write')
    await session.handle.write(buffer, 0, buffer.length, offset)
    return { session: sessionId, bytes: buffer.length, offset }
  }

  async function sftpOpenRead(_server, remotePath) {
    const opened = await openLocal(remotePath, 'r')
    const info = await opened.handle.stat()
    if (!info.isFile()) {
      await opened.handle.close()
      throw new Error('not a file')
    }
    const id = `locr_${randomUUID()}`
    sessions.set(id, { kind: 'read', path: opened.resolved, handle: opened.handle, size: info.size })
    return { session: id, path: opened.resolved, size: info.size }
  }

  async function sftpReadChunk(sessionId, offset, length) {
    const session = sessionFor(sessionId, 'read')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await session.handle.read(buffer, 0, length, offset)
    return { session: sessionId, bytesRead, base64: buffer.subarray(0, bytesRead).toString('base64') }
  }

  async function sftpCloseTransfer(sessionId) {
    const session = sessions.get(sessionId)
    // The server ref lets routes invalidate the local directory cache and log
    // local activity under the right resource instead of "unknown" (B5/B8).
    if (!session) return { session: sessionId, path: null, server: LOCAL_FILE_REF }
    sessions.delete(sessionId)
    let bytes
    try {
      if (session.kind === 'write') bytes = (await session.handle.stat()).size
    } catch {
      // A failed stat still closes the descriptor below.
    }
    await session.handle.close()
    return { session: sessionId, path: session.path, bytes, server: LOCAL_FILE_REF }
  }

  async function sftpMkdir(_server, remotePath) {
    return await localfs.mkdir(remotePath)
  }

  async function sftpRemove(_server, remotePath) {
    return await localfs.remove(remotePath)
  }

  async function sftpRename(_server, fromPath, toPath) {
    return await localfs.rename(fromPath, toPath)
  }

  async function dispose() {
    for (const session of [...sessions.values()]) {
      try { await session.handle.close() } catch { /* already closed */ }
    }
    sessions.clear()
  }

  return {
    server,
    sftpHome,
    sftpList,
    sftpRead,
    sftpOpenWrite,
    sftpWriteChunk,
    sftpOpenRead,
    sftpReadChunk,
    sftpCloseTransfer,
    sftpMkdir,
    sftpRemove,
    sftpRename,
    dispose,
  }
}
