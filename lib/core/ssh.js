/**
 * SSH transport facade.
 *
 * The actual connection lifecycle lives in `broker.js` (one pooled connection
 * per server). This module keeps the stable `createSshRuntime` surface the
 * remote-bash router and the routes data plane use, and adds:
 * - facts TTL cache (low-level helper; no longer exposed as a model tool),
 * - SFTP helpers on top of the pooled connection,
 * - chunked transfer sessions on dedicated connections (long-lived by design).
 */
import { createSessionBroker } from './broker.js'
import { SshError, isBenignReadOnlyExit, suggestedActionFor, toSftpError } from './errors.js'
import path from 'node:path'
import { effectiveDialect, normalizeDialect } from './dialect.js'

export { isBenignReadOnlyExit, suggestedActionFor }

const DEFAULT_FACTS_TTL_MS = 60000

export function dialectFromProbe(stdout, exitCode) {
  if (exitCode !== 0) return undefined
  const text = String(stdout ?? '').trim()
  if (!text) return undefined
  if (/Microsoft Windows/i.test(text)) return 'windows'
  if (/^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|DragonFly|SunOS|AIX|HP-UX|CYGWIN|MINGW|MSYS|GNU)/im.test(text)) return 'posix'
  return undefined
}



function serverCacheKey(server) {
  const ref = server.authRef ?? {}
  return `${server.host}|${server.port}|${server.username}|${ref.type ?? ''}|${ref.path ?? ''}`
}

export function createSshRuntime({ getSecret, knownHosts, config = {}, log = () => {}, ClientCtor } = {}) {
  const broker = createSessionBroker({ getSecret, knownHosts, config, log, ClientCtor })
  const factsTtlMs = Number.isInteger(config.factsTtlMs) ? config.factsTtlMs : DEFAULT_FACTS_TTL_MS
  const factsCache = new Map()
  const dialectCache = new Map()
  const timeoutGuardCache = new Map()
  const TIMEOUT_GUARD_TTL_MS = 5 * 60 * 1000
  const DEFAULT_TIMEOUT_GUARD = Object.freeze({ mode: 'none', shell: '/bin/sh' })
  // The probe runs under `sh -c`, so it works no matter what the remote login
  // shell is (fish/csh cannot parse POSIX `if ...; then`). It reports both the
  // timeout flavour and the login shell path, so the wrapper can reference the
  // shell as a literal instead of relying on POSIX `${SHELL:-...}` expansion.
  const TIMEOUT_GUARD_PROBE =
    `sh -c 'SH=\${SHELL:-/bin/sh}; ` +
    'if command -v timeout >/dev/null 2>&1; then ' +
    'if timeout -k 1 1 true >/dev/null 2>&1; then printf "kill|%s" "$SH"; ' +
    'else printf "basic|%s" "$SH"; fi; ' +
    'else printf "none|%s" "$SH"; fi\''

  /**
   * Parse the one-line probe response (`kill|/bin/bash`, `none|/bin/sh`, ...).
   * Unknown/garbled output degrades to `none` (no wrapper), never to a wrapper.
   */
  function parseTimeoutGuard(stdout) {
    const line = String(stdout ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1)
    if (!line) return { ...DEFAULT_TIMEOUT_GUARD }
    const [mode, shell] = line.split('|')
    if (mode !== 'kill' && mode !== 'basic' && mode !== 'none') return { ...DEFAULT_TIMEOUT_GUARD }
    const candidateShell = typeof shell === 'string' ? shell.trim() : ''
    return { mode, shell: candidateShell.startsWith('/') ? candidateShell : DEFAULT_TIMEOUT_GUARD.shell }
  }

  /**
   * Detect remote timeout support once per server (TTL-cached) so a timed-out
   * command can stop the remote process group. An `exitCode` of any value means
   * the probe actually ran on the remote, so even a "no timeout here" answer is
   * cached; only transport failures skip the cache. Concurrent first calls
   * share one in-flight probe.
   *
   * @returns {Promise<{mode: 'kill'|'basic'|'none', shell: string}>}
   */
  function timeoutGuard(server) {
    if (!server || effectiveDialect(server) === 'windows') return Promise.resolve({ ...DEFAULT_TIMEOUT_GUARD })
    const cacheKey = serverCacheKey(server)
    const cached = timeoutGuardCache.get(server.id)
    if (cached && cached.cacheKey === cacheKey) {
      if (cached.pending) return cached.pending
      if (Date.now() - cached.at < TIMEOUT_GUARD_TTL_MS) return Promise.resolve(cached.value)
    }
    const pending = (async () => {
      let value = { ...DEFAULT_TIMEOUT_GUARD }
      let cacheable = false
      try {
        const result = await broker.exec(server, TIMEOUT_GUARD_PROBE, {
          timeoutMs: 15000,
          readOnly: true,
          cap: 4096,
        })
        if (result.exitCode !== null && result.exitCode !== undefined) {
          value = parseTimeoutGuard(result.stdout)
          cacheable = true
        }
      } catch {
        // Transport failure says nothing about the remote: retry next time.
      }
      const current = timeoutGuardCache.get(server.id)
      if (current && current.pending === pending) {
        if (cacheable) timeoutGuardCache.set(server.id, { cacheKey, value, at: Date.now() })
        else timeoutGuardCache.delete(server.id)
      }
      return value
    })()
    timeoutGuardCache.set(server.id, { cacheKey, pending, at: Date.now() })
    return pending
  }

  const DIALECT_TTL_MS = 10 * 60 * 1000
  const DIALECT_PROBE_TIMEOUT_MS = 8000
  const POSIX_PROBE = 'uname -s'
  const WINDOWS_PROBE = 'cmd /c ver'

  /**
   * Classify one dialect probe output. Both probes are single, shell-native
   * commands, so a wrong guess only costs one failed SSH exec — never a
   * command against the wrong dialect.
   */
  /**
   * Detect the target dialect once per server (TTL-cached) instead of trusting
   * the hand-maintained `platform` hint. `uname -s` answers on POSIX targets;
   * `cmd /c ver` answers on Windows targets regardless of whether sshd's
   * default shell is `cmd.exe` or PowerShell.
   *
   * @returns {Promise<'posix'|'windows'|undefined>}
   */
  function probeDialect(server) {
    if (!server) return Promise.resolve(undefined)
    const cacheKey = serverCacheKey(server)
    const cached = dialectCache.get(server.id)
    if (cached && cached.cacheKey === cacheKey) {
      if (cached.pending) return cached.pending
      if (Date.now() - cached.at < DIALECT_TTL_MS) return Promise.resolve(cached.dialect)
    }
    const pending = (async () => {
      let dialect
      try {
        const posix = await broker.exec(server, POSIX_PROBE, {
          timeoutMs: DIALECT_PROBE_TIMEOUT_MS,
          readOnly: true,
          cap: 4096,
        })
        dialect = dialectFromProbe(posix?.stdout, posix?.exitCode ?? null)
      } catch {
        // Transport failure: try the other probe? No — a dead connection is a
        // dead connection; fall through to the last-known/record hint.
      }
      if (!dialect) {
        try {
          const windows = await broker.exec(server, WINDOWS_PROBE, {
            timeoutMs: DIALECT_PROBE_TIMEOUT_MS,
            readOnly: true,
            cap: 4096,
          })
          dialect = dialectFromProbe(windows?.stdout, windows?.exitCode ?? null)
        } catch {
          dialect = undefined
        }
      }
      const current = dialectCache.get(server.id)
      if (current && current.pending === pending) {
        if (dialect) dialectCache.set(server.id, { cacheKey, dialect, at: Date.now() })
        else dialectCache.delete(server.id)
      }
      return dialect
    })()
    dialectCache.set(server.id, { cacheKey, pending, at: Date.now() })
    return pending
  }

  async function facts(server, options = {}) {
    const cacheKey = serverCacheKey(server)
    const cached = factsCache.get(server.id)
    if (
      options.refresh !== true &&
      cached &&
      cached.cacheKey === cacheKey &&
      cached.facts?.dialect &&
      Date.now() - cached.at < factsTtlMs
    ) {
      return {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: { stdout: false, stderr: false },
        facts: cached.facts,
        cached: true,
        collectedAt: cached.collectedAt,
        warm: true,
        timings: { connectMs: 0, channelMs: 0, commandMs: 0, totalMs: 0 },
      }
    }
    // Probe before collecting: the facts script itself is dialect-specific.
    let dialect = options.dialect
    if (dialect !== 'posix' && dialect !== 'windows') {
      try {
        dialect = await probeDialect(server)
      } catch {
        dialect = undefined
      }
    }
    dialect = dialect === 'windows' ? 'windows' : dialect === 'posix' ? 'posix' : normalizeDialect(server.platform)
    const script =
      dialect === 'windows'
        ? 'echo __SDH_HOST__ & hostname & echo __SDH_OS__ & ver & echo __SDH_UPTIME__ & echo n/a & echo __SDH_MEM__ & wmic OS get FreePhysicalMemory /value 2>nul & echo __SDH_DISK__ & wmic logicaldisk get DeviceID,Size,FreeSpace 2>nul'
        : "echo __SDH_HOST__; hostname 2>/dev/null; echo __SDH_OS__; uname -sr 2>/dev/null; echo __SDH_UPTIME__; (uptime -p 2>/dev/null || uptime 2>/dev/null); echo __SDH_MEM__; (free -m 2>/dev/null | sed -n '1,2p' || vm_stat 2>/dev/null | head -5); echo __SDH_DISK__; df -Pk / 2>/dev/null | tail -n 2"
    const result = await broker.exec(server, script, {
      timeoutMs: options.timeoutMs ?? 20000,
      signal: options.signal,
      readOnly: true,
      cap: options.cap,
    })
    const parsed = parseFacts(result.stdout, dialect)
    if (result.outcome === 'success') {
      factsCache.set(server.id, {
        cacheKey,
        facts: parsed,
        collectedAt: new Date().toISOString(),
        at: Date.now(),
      })
    }
    return { ...result, facts: parsed, cached: false, collectedAt: new Date().toISOString() }
  }

  // ── SFTP on the pooled connection ─────────────────────────────────────────
  function withSftp(server, handler, options = {}) {
    return broker.withSftp(server, handler, options)
  }

  function statOf(attrs) {
    return {
      size: attrs.size,
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid,
      atime: attrs.atime,
      mtime: attrs.mtime,
    }
  }

  async function sftpList(server, remotePath) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (error, entries) => {
        if (error) return reject(toSftpError(error))
        resolve(entries.map((entry) => ({
          name: entry.filename,
          path: `${remotePath.replace(/\/+$/, '')}/${entry.filename}`.replace(/^\/+/, remotePath.startsWith('/') ? '/' : ''),
          type: entry.longname.startsWith('d') ? 'dir' : entry.longname.startsWith('l') ? 'link' : 'file',
          longname: entry.longname,
          ...statOf(entry.attrs),
        })))
      })
    }))
  }

  async function sftpStat(server, remotePath) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.stat(remotePath, (error, attrs) => (error ? reject(toSftpError(error)) : resolve({ path: remotePath, ...statOf(attrs) })))
    }))
  }

  function clampReadBytes(value, fallback) {
    const hardCap = 64 * 1024 * 1024
    return Number.isInteger(value) ? Math.max(1024, Math.min(value, hardCap)) : fallback
  }

  /** Read a remote file into a Buffer (binary-safe, bounded by maxBytes). */
  async function readRemoteBuffer(server, remotePath, maxBytes) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      try {
        sftp.stat(remotePath, (error, attrs) => {
          if (error) return reject(toSftpError(error))
          const chunks = []
          let size = 0
          let truncated = false
          const stream = sftp.createReadStream(remotePath)
          stream.on('data', (chunk) => {
            const remaining = maxBytes - size
            if (remaining > 0) {
              chunks.push(chunk.subarray(0, Math.min(chunk.length, remaining)))
              size += Math.min(chunk.length, remaining)
            }
            if (chunk.length > remaining) {
              truncated = true
              stream.destroy()
            }
          })
          stream.once('error', (error2) => reject(toSftpError(error2)))
          stream.once('close', () => {
            const buffer = Buffer.concat(chunks)
            resolve({
              path: remotePath,
              size: attrs.size,
              bytesRead: buffer.length,
              buffer,
              truncated: truncated || attrs.size > buffer.length,
            })
          })
        })
      } catch (error) {
        reject(toSftpError(error))
      }
    }))
  }

  async function sftpRead(server, remotePath, options = {}) {
    // 64 MiB hard cap covers downloads/previews while keeping one JSON response bounded.
    const maxBytes = clampReadBytes(options.maxBytes, 262144)
    const result = await readRemoteBuffer(server, remotePath, maxBytes)
    const binary = result.buffer.includes(0)
    const formatted = {
      path: result.path,
      size: result.size,
      bytesRead: result.bytesRead,
      truncated: result.truncated,
      binary,
      content: binary ? undefined : result.buffer.toString('utf8'),
    }
    if (options.base64 === true) formatted.base64 = result.buffer.toString('base64')
    return formatted
  }

  /** Binary-safe read used by agent upload/download flows. */
  async function sftpReadBuffer(server, remotePath, options = {}) {
    const maxBytes = clampReadBytes(options.maxBytes, 64 * 1024 * 1024)
    return await readRemoteBuffer(server, remotePath, maxBytes)
  }

  async function sftpWrite(server, remotePath, content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, buffer, (error) => (error ? reject(toSftpError(error)) : resolve({ path: remotePath, bytes: buffer.length })))
    }))
  }

  async function sftpMkdir(server, remotePath) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (error) => (error ? reject(toSftpError(error)) : resolve({ path: remotePath })))
    }))
  }

  async function sftpRemove(server, remotePath, isDir = false) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      const done = (error) => (error ? reject(toSftpError(error)) : resolve({ path: remotePath, removed: true }))
      if (isDir) sftp.rmdir(remotePath, done)
      else sftp.unlink(remotePath, done)
    }))
  }

  async function sftpRename(server, fromPath, toPath) {
    return await withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.rename(fromPath, toPath, (error) => (error ? reject(toSftpError(error)) : resolve({ from: fromPath, to: toPath })))
    }))
  }

  // ── chunked transfer sessions (dedicated connection, idle-closed) ─────────
  const transferSessions = new Map()
  let transferSessionSeq = 0
  const TRANSFER_IDLE_MS = 60000
  const MAX_TRANSFER_SESSIONS = 8
  const MAX_TRANSFER_CHUNK = 4 * 1024 * 1024
  const TRANSFER_CHUNK_TIMEOUT_MS = Number.isInteger(config.transferChunkTimeoutMs)
    ? Math.max(100, config.transferChunkTimeoutMs)
    : 30000

  /** Accept only an absolute home path; `~`/`.` are not real answers. */
  function normalizeSftpHome(value) {
    if (typeof value !== 'string') return undefined
    let trimmed = value.trim()
    if (!trimmed || trimmed === '.' || trimmed === '~') return undefined
    if (trimmed.startsWith('/')) {
      // Some SFTP servers answer REALPATH "." with "/." or a trailing slash.
      trimmed = path.posix.normalize(trimmed)
      if (trimmed === '.' || trimmed === '/.') return undefined
      return trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '')
    }
    // Windows servers may report a drive-letter path.
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.replace(/[\\/]+$/, '') || '/'
    return undefined
  }

  /**
   * Resolve a server's login home directory.
   *
   * SFTP sessions start in the login home, so `realpath('.')` is the canonical
   * home (e.g. `/root` for web-1). A few SFTP servers reject relative paths in
   * REALPATH; fall back to `realpath('~')` (OpenSSH expands the tilde) and then
   * to a readable `SFTP_FAILED` error. Never silently answer `/`: on a chrooted
   * or restricted account that would point the file panel at a directory the
   * user cannot list (U5).
   *
   * @param {object} server normalized inventory record
   * @returns {Promise<string>} absolute home directory
   */
  async function sftpHome(server) {
    const label = server?.name ?? server?.id ?? 'server'
    let lastError
    for (const candidate of ['.', '~']) {
      try {
        const resolved = await withSftp(
          server,
          (sftp) =>
            new Promise((resolve, reject) => {
              try {
                sftp.realpath(candidate, (error, resolvedPath) => {
                  if (error) return reject(toSftpError(error))
                  resolve(resolvedPath)
                })
              } catch (error) {
                reject(toSftpError(error))
              }
            }),
          { timeoutMs: TRANSFER_CHUNK_TIMEOUT_MS },
        )
        const home = normalizeSftpHome(resolved)
        if (home) return home
        lastError = new Error(`realpath("${candidate}") returned ${JSON.stringify(resolved)}`)
      } catch (error) {
        lastError = toSftpError(error)
      }
    }
    throw new SshError(
      'SFTP_FAILED',
      `could not resolve the login home directory for "${label}": ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }

  /**
   * Guard one SFTP chunk callback with a timeout. A half-open connection must
   * not leave the file panel stuck at "uploading" forever; on timeout the
   * session is closed so the client can resume from its last contiguous offset.
   */
  async function withTransferWatchdog(operation, label, onTimeout) {
    let timer
    try {
      return await Promise.race([
        operation,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              onTimeout?.()
            } catch {
              // closing a broken session is best effort
            }
            reject(new SshError('SFTP_TIMEOUT', `${label} timed out after ${TRANSFER_CHUNK_TIMEOUT_MS}ms`))
          }, TRANSFER_CHUNK_TIMEOUT_MS)
          // Keep the watchdog referenced while the chunk is in flight: an
          // unref'd timer lets a test/host process exit before the timeout
          // can fire, which both hides the error and leaks the pending promise.
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  function armTransferIdle(session) {
    if (session.timer) clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      void closeTransferSession(session.id, true)
    }, TRANSFER_IDLE_MS)
    if (session.timer && typeof session.timer.unref === 'function') session.timer.unref()
  }

  async function openTransferConnection(server) {
    const { client } = await broker.connectDedicated(server)
    try {
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((error, session) => (error ? reject(toSftpError(error)) : resolve(session)))
      })
      return { connection: { client }, sftp }
    } catch (error) {
      try {
        client.end()
      } catch {
        // already closed
      }
      throw error instanceof SshError ? error : new SshError('SFTP_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  function openRemoteHandle(sftp, remotePath, flags) {
    return new Promise((resolve, reject) => {
      sftp.open(remotePath, flags, (error, handle) => (error ? reject(toSftpError(error)) : resolve(handle)))
    })
  }

  async function closeTransferSession(id, silent = false, options = {}) {
    const session = transferSessions.get(id)
    if (!session) {
      if (silent) return undefined
      throw new SshError('TRANSFER_SESSION', `unknown transfer session ${id}`)
    }
    transferSessions.delete(id)
    if (session.timer) clearTimeout(session.timer)
    try {
      if (session.handle) {
        await new Promise((resolve) => session.sftp.close(session.handle, () => resolve()))
      }
    } catch {
      // closing a broken handle is best effort
    }
    let verified = false
    try {
      // An explicit close of an upload verifies the remote size, so a dropped
      // final chunk cannot be reported as a successful transfer.
      if (!silent && options.verify !== false && session.kind === 'write' && session.bytes > 0) {
        const attrs = await new Promise((resolve, reject) => {
          try {
            session.sftp.stat(session.path, (error, value) => (error ? reject(toSftpError(error)) : resolve(value)))
          } catch (error) {
            reject(toSftpError(error))
          }
        })
        if (Number.isInteger(attrs?.size) && attrs.size !== session.bytes) {
          throw new SshError(
            'SFTP_SIZE_MISMATCH',
            `remote size ${attrs.size} does not match the ${session.bytes} bytes written to ${session.path}`,
          )
        }
        verified = true
      }
    } finally {
      try {
        session.connection.client.end()
      } catch {
        // already closed
      }
    }
    return { session: id, path: session.path, bytes: session.bytes ?? 0, server: session.server, ...(verified ? { verified: true } : {}) }
  }

  async function sftpOpenWrite(server, remotePath, truncate = true) {
    const { connection, sftp } = await openTransferConnection(server)
    try {
      // 'w' truncates; 'r+' keeps the existing .part bytes for resume.
      const handle = await openRemoteHandle(sftp, remotePath, truncate ? 'w' : 'r+')
      const id = `sftp-write-${++transferSessionSeq}`
      const session = {
        id,
        kind: 'write',
        server: server.id,
        path: remotePath,
        sftp,
        connection,
        handle,
        bytes: 0,
        touchedAt: Date.now(),
      }
      transferSessions.set(id, session)
      if (transferSessions.size > MAX_TRANSFER_SESSIONS) {
        const oldest = [...transferSessions.values()]
          .filter((entry) => entry.id !== id)
          .sort((left, right) => left.touchedAt - right.touchedAt)[0]
        if (oldest) await closeTransferSession(oldest.id, true)
      }
      armTransferIdle(session)
      return { session: id, path: remotePath }
    } catch (error) {
      try {
        connection.client.end()
      } catch {
        // already closed
      }
      throw error instanceof SshError ? error : new SshError('SFTP_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async function sftpWriteChunk(id, offset, buffer) {
    const session = transferSessions.get(id)
    if (!session || session.kind !== 'write') throw new SshError('TRANSFER_SESSION', `write session '${id}' is not open`)
    if (!Buffer.isBuffer(buffer)) throw new SshError('TRANSFER_FAILED', 'write chunk must be a Buffer')
    if (buffer.length > MAX_TRANSFER_CHUNK) throw new SshError('TRANSFER_FAILED', `chunk exceeds ${MAX_TRANSFER_CHUNK} bytes`)
    const position = Number.isInteger(offset) && offset >= 0 ? offset : 0
    await withTransferWatchdog(
      new Promise((resolve, reject) => {
        session.sftp.write(session.handle, buffer, 0, buffer.length, position, (error) => (error ? reject(toSftpError(error)) : resolve()))
      }),
      'SFTP write chunk',
      () => {
        void closeTransferSession(id, true)
      },
    )
    session.bytes = Math.max(session.bytes, position + buffer.length)
    session.touchedAt = Date.now()
    armTransferIdle(session)
    return { session: id, bytes: buffer.length }
  }

  async function sftpOpenRead(server, remotePath) {
    const { connection, sftp } = await openTransferConnection(server)
    try {
      const handle = await openRemoteHandle(sftp, remotePath, 'r')
      const attrs = await new Promise((resolve, reject) => {
        sftp.fstat(handle, (error, value) => (error ? reject(toSftpError(error)) : resolve(value)))
      })
      const id = `sftp-read-${++transferSessionSeq}`
      const session = {
        id,
        kind: 'read',
        server: server.id,
        path: remotePath,
        sftp,
        connection,
        handle,
        size: attrs.size,
        mtime: attrs.mtime,
        touchedAt: Date.now(),
      }
      transferSessions.set(id, session)
      if (transferSessions.size > MAX_TRANSFER_SESSIONS) {
        const oldest = [...transferSessions.values()]
          .filter((entry) => entry.id !== id)
          .sort((left, right) => left.touchedAt - right.touchedAt)[0]
        if (oldest) await closeTransferSession(oldest.id, true)
      }
      armTransferIdle(session)
      return { session: id, path: remotePath, size: attrs.size, mtime: attrs.mtime }
    } catch (error) {
      try {
        connection.client.end()
      } catch {
        // already closed
      }
      throw error instanceof SshError ? error : new SshError('SFTP_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async function sftpReadChunk(id, offset, length) {
    const session = transferSessions.get(id)
    if (!session || session.kind !== 'read') throw new SshError('TRANSFER_SESSION', `read session '${id}' is not open`)
    const position = Number.isInteger(offset) && offset >= 0 ? offset : 0
    const wanted = Number.isInteger(length) && length > 0 ? Math.min(length, MAX_TRANSFER_CHUNK) : 256 * 1024
    const buffer = Buffer.alloc(wanted)
    const bytesRead = await withTransferWatchdog(
      new Promise((resolve, reject) => {
        session.sftp.read(session.handle, buffer, 0, wanted, position, (error, value) => (error ? reject(toSftpError(error)) : resolve(value)))
      }),
      'SFTP read chunk',
      () => {
        void closeTransferSession(id, true)
      },
    )
    session.touchedAt = Date.now()
    armTransferIdle(session)
    return { session: id, bytesRead, base64: buffer.subarray(0, bytesRead).toString('base64') }
  }



  /** Close every chunked transfer session that belongs to one server (config change/removal). */
  async function closeTransferSessionsForServer(serverId) {
    let closed = 0
    for (const [id, session] of [...transferSessions.entries()]) {
      if (session.server !== serverId) continue
      try {
        await closeTransferSession(id, true)
        closed += 1
      } catch {
        // best effort: the server record is already being replaced/removed
      }
    }
    return closed
  }

  async function close() {
    for (const id of [...transferSessions.keys()]) {
      try {
        await closeTransferSession(id, true)
      } catch {
        // best effort
      }
    }
    await broker.closeAll()
  }

  return {
    preload: () => broker.preload(),
    exec: (server, command, options) => broker.exec(server, command, options),
    test: async (server) => {
      const result = await broker.test(server)
      if (!result?.ok) return result
      // Report the probed dialect, not the record hint: the UI and the target
      // context both use this value to pick the command syntax.
      let dialect
      try {
        dialect = await probeDialect(server)
      } catch {
        dialect = undefined
      }
      return dialect ? { ...result, platform: dialect, dialect } : result
    },
    facts,
    probeDialect,
    timeoutGuard,
    shell: (server, options) => broker.shell(server, options),
    withSftp,
    sftpList,
    sftpStat,
    sftpHome,
    sftpRead,
    sftpReadBuffer,
    sftpWrite,
    sftpMkdir,
    sftpRemove,
    sftpRename,
    sftpOpenWrite,
    sftpWriteChunk,
    sftpOpenRead,
    sftpReadChunk,
    sftpCloseTransfer: (id, options) => closeTransferSession(id, false, options),
    closeTransferSessionsForServer,
    warm: (server) => broker.warm(server),
    invalidate: (serverId) => {
      factsCache.delete(serverId)
      dialectCache.delete(serverId)
      timeoutGuardCache.delete(serverId)
      broker.invalidate(serverId)
    },
    close,
  }
}

export function parseFacts(stdout, platform = 'posix') {
  const sections = {}
  let current = null
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const marker = /^__SDH_([A-Z]+)__$/.exec(line.trim())
    if (marker) {
      current = marker[1].toLowerCase()
      sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }
  const clean = (key) => (sections[key] ?? []).map((line) => line.trim()).filter(Boolean).join(' | ')
  const dialect = normalizeDialect(platform)
  const facts = {
    platform: dialect,
    dialect,
    collectedAt: new Date().toISOString(),
  }
  if (clean('host')) facts.hostname = clean('host')
  if (clean('os')) facts.kernel = clean('os')
  if (clean('uptime')) facts.uptime = clean('uptime')
  if (clean('mem')) facts.memory = clean('mem').slice(0, 500)
  if (clean('disk')) facts.rootDisk = clean('disk').slice(0, 500)
  return facts
}


