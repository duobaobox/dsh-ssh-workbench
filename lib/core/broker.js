/**
 * Session broker: one pooled SSH connection per managed server.
 *
 * Why: every `exec`/SFTP call used to pay a full TCP + handshake + auth
 * (~300ms) plus channel/SFTP setup (~150-250ms). The broker keeps one ssh2
 * Client per server (SSH multiplexes channels natively), reuses the SFTP
 * subsystem, enforces bounded concurrency, evicts idle connections, and
 * reconnects once when the connection (not the command) fails.
 *
 * Invariants:
 * - Never fake success: a connection lost mid-command is reported as
 *   `unconfirmed`/failed, never as a clean exit.
 * - Never hang: every operation has a timeout; SFTP errors are always
 *   normalized and rejected (no recursive normalizer).
 * - Never leak: idle sweep + plugin unload (`closeAll`) close every client.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  SshError,
  classifyExecFailure,
  errorResult,
  isBenignReadOnlyExit,
  isConnectionLevelError,
  normalizeError,
  suggestedActionFor,
  toSftpError,
} from './errors.js'
import { effectiveDialect } from './dialect.js'

const BROKER_DEFAULTS = {
  connectTimeoutMs: 15000,
  commandTimeoutMs: 60000,
  sftpTimeoutMs: 30000,
  maxOutputBytes: 100 * 1024,
  // stderr is mostly noise/diagnostics; keeping it well below stdout protects
  // the model context from a single chatty (or failing) command.
  maxStderrBytes: 16 * 1024,
  keepaliveInterval: 30000,
  keepaliveCountMax: 3,
  poolIdleMs: 90000,
  poolMaxServers: 8,
  maxChannelsPerServer: 6,
  sweepIntervalMs: 15000,
}


/** POSIX single-quote escaping for a remote path. */
function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** PowerShell single-quote escaping. */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Wrap a command so it runs inside `cwd` (SSH exec channels have no cwd of
 * their own). POSIX uses `cd -- <dir> && ...`; Windows uses cmd or PowerShell
 * depending on the configured shell.
 */
function withCwd(command, cwd, server = {}) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return command
  if (effectiveDialect(server) === 'windows') {
    if (/powershell/i.test(String(server.defaultShell ?? ''))) {
      return `Set-Location -LiteralPath ${quotePowerShell(dir)}; ${command}`
    }
    return `cd /d "${String(dir).replace(/"/g, '""')}" && ${command}`
  }
  return `cd -- ${quotePosix(dir)} && ${command}`
}

function expandHome(input) {
  if (typeof input !== 'string') return ''
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function createCapture(cap) {
  const headCap = Math.floor(cap / 2)
  let head = ''
  let tail = ''
  let original = 0
  return {
    add(text) {
      original += Buffer.byteLength(text, 'utf8')
      let rest = text
      if (head.length < headCap) {
        const room = headCap - head.length
        if (rest.length <= room) {
          head += rest
          return
        }
        head += rest.slice(0, room)
        rest = rest.slice(room)
      }
      if (rest.length > 0) {
        tail += rest
        if (tail.length > cap) tail = tail.slice(-Math.floor(cap / 2))
      }
    },
    finish() {
      const truncated = original > cap
      const text = truncated ? `${head}\n...[truncated ${original - head.length - tail.length} bytes]...\n${tail}` : head + tail
      return { text, truncated, original }
    },
  }
}


/**
 * @param {object} deps
 * @param {(key: string) => string|undefined} [deps.getSecret]
 * @param {{ verify: Function, has: Function }} [deps.knownHosts]
 * @param {object} [deps.config] plugin config slice
 * @param {(message: string, fields?: object) => void} [deps.log]
 * @param {new () => any} [deps.ClientCtor] test seam (defaults to ssh2.Client)
 */
export function createSessionBroker({ getSecret, knownHosts, config = {}, log = () => {}, ClientCtor } = {}) {
  const settings = { ...BROKER_DEFAULTS, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined)) }
  // Kill switch: `connectionPool: false` restores the old "one connection per
  // call" behaviour without touching the rest of the pipeline.
  const poolEnabled = settings.connectionPool !== false
  const now = () => Date.now()

  let ssh2Promise
  const loadSsh2 = async () => {
    if (ClientCtor) return { Client: ClientCtor }
    if (!ssh2Promise) {
      // ssh2 is vendored (pure JS) so installing the plugin never invokes
      // node-gyp or downloads packages at runtime; see vendor/NOTICE.md.
      ssh2Promise = import('../../vendor/ssh2/lib/index.js').then((module) => {
        // ssh2 is CommonJS: depending on the Node interop the named exports may
        // be absent, leaving the whole module under `default`.
        const lib = module && (module.Client || module.Server) ? module : module?.default
        if (!lib || typeof lib.Client !== 'function') throw new SshError('EXEC_FAILED', 'ssh2 module has no Client export')
        return lib
      })
    }
    return ssh2Promise
  }

  /** @type {Map<string, any>} server.id → entry */
  const entries = new Map()
  function authFor(server) {
    const ref = server.authRef
    if (!ref || ref.type !== 'sshKey') {
      const password = getSecret?.(`server:${server.id}:password`)
      if (!password) throw new SshError('AUTH_MISSING', `no password stored for ${server.name}`)
      return { password }
    }
    const keyPath = expandHome(ref.path)
    let privateKey
    try {
      privateKey = fs.readFileSync(keyPath)
    } catch (error) {
      throw new SshError('AUTH_FAILED', `cannot read private key ${ref.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const passphrase = getSecret?.(`server:${server.id}:passphrase`)
    return { privateKey, ...(passphrase ? { passphrase } : {}) }
  }

  function serverKey(server) {
    const ref = server.authRef ?? {}
    let auth
    if (ref.type === 'sshKey') auth = `key:${ref.path ?? ''}`
    else {
      const secret = getSecret?.(`server:${server.id}:password`) ?? ''
      auth = `pwd:${createHash('sha256').update(secret).digest('hex').slice(0, 16)}`
    }
    return `${server.host}|${server.port}|${server.username}|${auth}`
  }

  function connectOptions(server, state, connectTimeoutMs) {
    const hostKeyMode = settings.hostKeyMode === 'accept-new' ? 'accept-new' : 'strict'
    const readyTimeout = Number.isInteger(connectTimeoutMs) && connectTimeoutMs > 0
      ? Math.min(connectTimeoutMs, settings.connectTimeoutMs)
      : settings.connectTimeoutMs
    return {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout,
      keepaliveInterval: settings.keepaliveInterval,
      keepaliveCountMax: settings.keepaliveCountMax,
      hostHash: 'sha256',
      hostVerifier: (hashedKey) => {
        const fingerprint = Buffer.isBuffer(hashedKey) ? hashedKey.toString('hex') : String(hashedKey)
        state.fingerprint = fingerprint
        return knownHosts ? knownHosts.verify(server, fingerprint, hostKeyMode) : hostKeyMode === 'accept-new'
      },
      ...authFor(server),
    }
  }

  /** Open a fresh client and resolve on `ready`. */
  async function connectClient(server, connectTimeoutMs) {
    const { Client } = await loadSsh2()
    const state = {}
    const client = new Client()
    const started = now()
    return await new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        try {
          client.end()
        } catch {
          // socket may already be gone
        }
        reject(normalizeError(error, state.fingerprint))
      }
      client.once('ready', () => {
        if (settled) return
        settled = true
        resolve({ client, fingerprint: state.fingerprint, connectMs: now() - started })
      })
      client.once('error', fail)
      // Keep a listener after `ready`: ssh2 can emit a second error while the
      // socket tears down, and an unhandled 'error' would crash the host.
      client.on('error', (error) => {
        log('ssh client error', { server: server.name, error: error instanceof Error ? error.message : String(error) })
      })
      try {
        client.connect(connectOptions(server, state, connectTimeoutMs))
      } catch (error) {
        fail(error)
      }
    })
  }

  function markDead(entry, reason = 'connection lost') {
    if (entry.state === 'dead') return
    entry.state = 'dead'
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    try {
      entry.sftp?.end?.()
    } catch {
      // best effort
    }
    try {
      entry.client.end()
    } catch {
      // best effort
    }
    const waiters = entry.waiters.splice(0)
    for (const wake of waiters) wake()
    log('ssh connection marked dead', { server: entry.name, reason })
  }

  function evict(entry, reason = 'evicted') {
    if (!entry) return
    if (entry.state !== 'dead') entry.state = 'dead'
    if (entries.get(entry.id) === entry) entries.delete(entry.id)
    try {
      entry.sftp?.end?.()
    } catch {
      // best effort
    }
    try {
      entry.client.end()
    } catch {
      // best effort
    }
    const waiters = entry.waiters.splice(0)
    for (const wake of waiters) wake()
    log('ssh connection evicted', { server: entry.name, reason })
  }

  function trimIdle() {
    const idle = [...entries.values()].filter((entry) => entry.channels === 0 && entry.state === 'ready')
    while (entries.size > settings.poolMaxServers && idle.length > 0) {
      const oldest = idle.sort((left, right) => left.lastUsed - right.lastUsed)[0]
      idle.shift()
      evict(oldest, 'pool capacity')
    }
  }


  async function acquire(server, options = {}) {
    const id = server.id ?? server.name
    const key = serverKey(server)
    let entry = entries.get(id)
    let warm = false

    if (entry && entry.key !== key) {
      evict(entry, 'server settings changed')
      entry = undefined
    }
    if (entry && entry.state === 'dead') {
      entries.delete(id)
      entry = undefined
    }
    if (entry && entry.state === 'connecting' && entry.pending) {
      const ready = await entry.pending
      return { entry: ready, warm: true }
    }
    if (entry && entry.state === 'ready' && !poolEnabled) {
      evict(entry, 'pool disabled')
      entry = undefined
    }
    if (entry && entry.state === 'ready') {
      entry.lastUsed = now()
      warm = true
      return { entry, warm }
    }

    trimIdle()
    const created = {
      id,
      name: server.name,
      key,
      client: null,
      fingerprint: undefined,
      sftp: null,
      sftpPending: null,
      state: 'connecting',
      pending: null,
      channels: 0,
      waiters: [],
      lastUsed: now(),
      createdAt: now(),
      connectMs: 0,
    }
    created.pending = (async () => {
      try {
        const { client, fingerprint, connectMs } = await connectClient(server, options.connectTimeoutMs)
        created.client = client
        created.fingerprint = fingerprint
        created.connectMs = connectMs
        created.state = 'ready'
        created.pending = null
        created.lastUsed = now()
        client.on('close', () => markDead(created, 'connection closed'))
        return created
      } catch (error) {
        created.state = 'dead'
        created.pending = null
        if (entries.get(id) === created) entries.delete(id)
        throw error
      }
    })()
    entries.set(id, created)
    try {
      const ready = await created.pending
      return { entry: ready, warm: false }
    } catch (error) {
      throw error instanceof SshError ? error : normalizeError(error)
    }
  }

  function acquireChannel(entry) {
    if (entry.channels < settings.maxChannelsPerServer) {
      entry.channels += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      entry.waiters.push(resolve)
    }).then(() => {
      entry.channels += 1
    })
  }

  function releaseChannel(entry) {
    if (entry.channels > 0) entry.channels -= 1
    const wake = entry.waiters.shift()
    if (wake) wake()
  }

  function ensureSftp(entry) {
    if (entry.sftp) return Promise.resolve(entry.sftp)
    if (entry.sftpPending) return entry.sftpPending
    entry.sftpPending = new Promise((resolve, reject) => {
      try {
        entry.client.sftp((error, session) => (error ? reject(toSftpError(error)) : resolve(session)))
      } catch (error) {
        reject(toSftpError(error))
      }
    })
    return entry.sftpPending
      .then((session) => {
        entry.sftp = session
        return session
      })
      .finally(() => {
        entry.sftpPending = null
      })
  }

  /**
   * Run one command on an established entry. Never throws for command-level
   * failures; returns `{ result, retryable }`.
   */
  function runOnEntry(entry, command, options = {}, startedAt = now()) {
    const timeoutMs = options.timeoutMs ?? settings.commandTimeoutMs
    const cap = options.cap ?? settings.maxOutputBytes
    const stderrCap = options.stderrCap ?? settings.maxStderrBytes
    const out = createCapture(cap)
    const err = createCapture(stderrCap)
    const warm = options.warm === true
    const connectMs = entry.connectMs ?? 0
    const channelStarted = now()

    return acquireChannel(entry).then(
      () =>
        new Promise((resolve) => {
          const channelMs = now() - channelStarted
          const commandStarted = now()
          let settled = false
          let exitCode = null
          let exitSignal = null
          let retryable = false
          let stream
          let killTimer
          let firstDataAt = 0

          const finish = (forcedCode, forcedMessage) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (killTimer) clearTimeout(killTimer)
            options.signal?.removeEventListener?.('abort', onAbort)
            releaseChannel(entry)
            const stdout = out.finish()
            const stderr = err.finish()
            const durationMs = now() - startedAt
            const timings = {
              connectMs: Math.round(connectMs),
              channelMs: Math.round(channelMs),
              commandMs: Math.round(now() - commandStarted),
              totalMs: Math.round(durationMs),
            }
            if (forcedCode) {
              resolve({
                result: errorResult(forcedCode, forcedMessage ?? 'operation failed', {
                  stdout: stdout.text,
                  stderr: stderr.text,
                  durationMs,
                  truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
                  warm,
                  timings,
                  ...(firstDataAt ? { firstDataAt: Math.round(firstDataAt - startedAt) } : {}),
                }),
                retryable,
              })
              return
            }
            // An exec channel may close without an explicit exit status (the
            // server called end() instead of exit()). Treat that as success
            // unless a terminating signal was observed.
            const missingCode = exitCode === null || exitCode === undefined
            // The remote `timeout` wrapper exits 124 when its own deadline fired
            // before the client-side timer did (e.g. the host event loop was
            // busy). Report that as a timeout, not as an ordinary exit 124.
            if (!missingCode && exitCode === 124 && now() - commandStarted >= timeoutMs - 1500) {
              resolve({
                result: {
                  outcome: 'timeout',
                  exitCode: null,
                  signal: null,
                  stdout: stdout.text,
                  stderr: stderr.text,
                  durationMs,
                  truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
                  warm,
                  timings,
                  ...(firstDataAt ? { firstDataAt: Math.round(firstDataAt - startedAt) } : {}),
                  note: 'remote timeout deadline reached',
                },
                retryable: false,
              })
              return
            }
            const failed = (!missingCode && exitCode !== 0) || Boolean(exitSignal)
            const benign = failed && isBenignReadOnlyExit({ readOnly: options.readOnly === true, exitCode, stderr: stderr.text, signal: exitSignal })
            resolve({
              result: {
                outcome: failed && !benign ? 'failed' : 'success',
                exitCode,
                signal: exitSignal,
                stdout: stdout.text,
                stderr: stderr.text,
                durationMs,
                truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
                warm,
                timings,
                ...(firstDataAt ? { firstDataAt: Math.round(firstDataAt - startedAt) } : {}),
                ...(benign
                  ? { note: 'exit code 1 with empty stderr is normal for grep/diff (no match or difference); treated as a successful read' }
                  : failed
                    ? (() => {
                        const failureCode = classifyExecFailure({ exitCode, stderr: stderr.text, signal: exitSignal })
                        return { errorCode: failureCode, suggestedAction: suggestedActionFor(failureCode) }
                      })()
                    : {}),
              },
              retryable: false,
            })
          }

          const onAbort = () => {
            finish('CANCELLED', 'operation cancelled')
            closeStream()
          }
          const closeStream = () => {
            try {
              stream?.close?.()
            } catch {
              // channel may already be closed
            }
            try {
              stream?.destroy?.()
            } catch {
              // best effort
            }
            // A command that ignores channel close must not pin the pooled
            // connection forever: evict after a short grace period.
            killTimer = setTimeout(() => {
              if (entry.state === 'ready') markDead(entry, 'timed-out command left the channel open')
            }, 2000)
            if (killTimer.unref) killTimer.unref()
          }

          const timer = setTimeout(() => {
            finish('TIMEOUT', `command timed out after ${timeoutMs}ms`)
            closeStream()
          }, timeoutMs)
          if (timer.unref) timer.unref()

          if (options.signal?.aborted) {
            finish('CANCELLED', 'operation aborted before start')
            return
          }
          options.signal?.addEventListener?.('abort', onAbort, { once: true })

          try {
            entry.client.exec(command, (error, nextStream) => {
              if (error) {
                retryable = isConnectionLevelError(error)
                if (retryable) markDead(entry, 'exec channel failed')
                finish('EXEC_FAILED', error instanceof Error ? error.message : String(error))
                return
              }
              stream = nextStream
              stream.on('data', (chunk) => {
                if (!firstDataAt) firstDataAt = now()
                out.add(chunk.toString('utf8'))
              })
              stream.stderr.on('data', (chunk) => err.add(chunk.toString('utf8')))
              stream.once('close', (code, signal) => {
                exitCode = code === undefined ? null : code
                exitSignal = signal === undefined ? null : signal
                finish()
              })
              stream.once('error', (streamError) => {
                retryable = isConnectionLevelError(streamError)
                if (retryable) markDead(entry, 'exec stream failed')
                finish('EXEC_FAILED', streamError instanceof Error ? streamError.message : String(streamError))
              })
              // The broker never writes to a command's stdin. Sending EOF right
              // away turns stdin-reading commands (`cat`, `read`, interactive
              // installers) into immediate EOF instead of hanging until the
              // timeout; it is equivalent to a remote `</dev/null`.
              try {
                stream.end?.()
              } catch {
                // channel may already be half-closed
              }
            })
          } catch (error) {
            retryable = isConnectionLevelError(error)
            if (retryable) markDead(entry, 'exec threw')
            finish('EXEC_FAILED', error instanceof Error ? error.message : String(error))
          }
        }),
    )
  }

  async function exec(server, command, options = {}) {
    const startedAt = now()
    // SSH exec channels start in the login home directory; `cwd` is applied as
    // a `cd` prefix so callers can keep a working directory per call.
    const remoteCommand = options.cwd ? withCwd(command, options.cwd, server) : command
    let attempt = 0
    for (;;) {
      let acquired
      try {
        acquired = await acquire(server, { connectTimeoutMs: options.connectTimeoutMs })
      } catch (error) {
        const normalized = error instanceof SshError ? error : normalizeError(error)
        const result = errorResult(normalized.code, normalized.message, { durationMs: now() - startedAt })
        if (normalized.fingerprint) result.fingerprint = normalized.fingerprint
        return result
      }
      const { entry, warm } = acquired
      const { result, retryable } = await runOnEntry(entry, remoteCommand, { ...options, warm }, startedAt)
      // Retry once only for idempotent read-only commands whose failure was a
      // connection-level error before any output arrived. Never retry a write:
      // the remote side may already have executed it.
      const canRetry =
        retryable && attempt === 0 && options.readOnly === true && !result.stdout && result.outcome === 'failed'
      if (canRetry) {
        attempt += 1
        evict(entry, 'retry after connection error')
        continue
      }
      if (!poolEnabled) evict(entry, 'pool disabled')
      return result
    }
  }

  async function withSftp(server, handler, options = {}) {
    const timeoutMs = options.timeoutMs ?? settings.sftpTimeoutMs
    let acquired
    try {
      acquired = await acquire(server)
    } catch (error) {
      throw toSftpError(error)
    }
    const { entry } = acquired
    await acquireChannel(entry)
    let timer
    try {
      const sftp = await ensureSftp(entry)
      const work = Promise.resolve().then(() => handler(sftp))
      work.catch(() => {})
      const guarded = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SshError('TIMEOUT', `SFTP operation timed out after ${timeoutMs}ms`)), timeoutMs)
        if (timer.unref) timer.unref()
      })
      return await Promise.race([work, guarded])
    } catch (error) {
      if (isConnectionLevelError(error)) markDead(entry, 'sftp failed')
      throw toSftpError(error)
    } finally {
      clearTimeout(timer)
      releaseChannel(entry)
      if (!poolEnabled) evict(entry, 'pool disabled')
    }
  }

  async function test(server) {
    const started = now()
    let acquired
    try {
      acquired = await acquire(server)
    } catch (error) {
      const normalized = error instanceof SshError ? error : normalizeError(error)
      return {
        ok: false,
        errorCode: normalized.code,
        message: normalized.message,
        latencyMs: now() - started,
        fingerprint: normalized.fingerprint,
      }
    }
    const { entry, warm } = acquired
    const probe = effectiveDialect(server) === 'windows' ? 'cmd /c ver' : 'uname -s'
    const { result } = await runOnEntry(
      entry,
      probe,
      { timeoutMs: Math.min(settings.commandTimeoutMs, 15000), readOnly: true, warm },
      started,
    )
    if (!poolEnabled) evict(entry, 'pool disabled')
    return {
      ok: result.outcome === 'success',
      latencyMs: now() - started,
      platform: effectiveDialect(server),
      hostKey: knownHosts?.has(server) ? 'trusted' : 'unknown',
      probe: String(result.stdout ?? '').trim().split('\n')[0] ?? '',
      errorCode: result.errorCode,
      fingerprint: entry.fingerprint,
      warm,
    }
  }

  /**
   * Interactive PTY shell on a dedicated connection (not pooled): terminals are
   * long-lived and must not share a connection that an idle sweep could close.
   */
  async function shell(server, options = {}) {
    const { client } = await connectClient(server)
    const rows = Number.isInteger(options.rows) ? options.rows : 40
    const cols = Number.isInteger(options.cols) ? options.cols : 120
    let stream
    try {
      stream = await new Promise((resolve, reject) => {
        client.shell({ term: options.term ?? 'xterm-256color', rows, cols }, (error, channel) => {
          if (error) reject(normalizeError(error))
          else resolve(channel)
        })
      })
    } catch (error) {
      try {
        client.end()
      } catch {
        // socket may already be gone
      }
      throw error
    }
    let closed = false
    return {
      stream,
      write(data) {
        if (closed) return
        try {
          stream.write(String(data))
        } catch (error) {
          log('ssh shell write failed', { server: server.name, error: error instanceof Error ? error.message : String(error) })
        }
      },
      onData(handler) {
        stream.on('data', handler)
      },
      resize(cols, rows) {
        if (closed) return
        try {
          stream.setWindow(Number(rows) || 24, Number(cols) || 80)
        } catch (error) {
          log('ssh shell resize failed', { server: server.name, error: error instanceof Error ? error.message : String(error) })
        }
      },
      onClose(handler) {
        stream.once('close', handler)
      },
      onError(handler) {
        stream.once('error', handler)
      },
      async close() {
        if (closed) return
        closed = true
        try {
          stream.end()
        } catch {
          // channel may already be closed
        }
        try {
          client.end()
        } catch {
          // socket may already be closed
        }
      },
    }
  }

  /** Fire-and-forget connection warm-up. */
  function warm(server) {
    acquire(server).catch((error) => {
      log('ssh warm-up failed', { server: server.name, error: error instanceof Error ? error.message : String(error) })
    })
  }

  function invalidate(serverId) {
    const entry = entries.get(serverId)
    if (entry) evict(entry, 'invalidated')
  }



  async function closeAll() {
    clearInterval(sweeper)
    for (const entry of [...entries.values()]) evict(entry, 'plugin unloaded')
    entries.clear()
  }

  async function preload() {
    await loadSsh2()
  }

  /** Dedicated (unpooled) connection for interactive shells and chunked transfers. */
  async function connectDedicated(server) {
    return await connectClient(server)
  }

  const sweeper = setInterval(() => {
    const cutoff = now() - settings.poolIdleMs
    for (const entry of [...entries.values()]) {
      if (entry.state === 'ready' && entry.channels === 0 && entry.lastUsed < cutoff) evict(entry, 'idle')
    }
  }, settings.sweepIntervalMs)
  if (sweeper.unref) sweeper.unref()

  return {
    exec,
    withSftp,
    test,
    shell,
    warm,
    invalidate,
    closeAll,
    preload,
    connectDedicated,
  }
}
