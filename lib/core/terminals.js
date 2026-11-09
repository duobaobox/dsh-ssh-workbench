/**
 * Interactive terminal sessions for the workbench.
 *
 * Remote sessions run on the existing ssh2 broker shell channel; local ones use
 * the Host subprocess service's PTY (`spawnTerminal`). The browser renders them
 * with xterm and polls `read`, so the transport needs no new socket protocol
 * and stays on the plugin's authenticated routes.
 *
 * Sessions are process-local, buffered (bounded) and reclaimed after a period
 * of inactivity or when their server/plugin goes away. Closing a session ends
 * the remote channel or the local PTY; nothing survives a Host restart.
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const MAX_BUFFER_CHARS = 512 * 1024
const MAX_SESSIONS = 12
const MAX_WAIT_MS = 20000
const DEFAULT_IDLE_MS = 30 * 60 * 1000

function clampDimension(value, fallback, max) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(Math.max(Math.floor(number), 1), max)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createTerminalHub({ runtime, getSubprocess, getLocalCwd, log = () => {} } = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map()
  // Slots reserved by opens that are still waiting for their transport. The
  // cap must be checked atomically: `open()` awaits the transport, so counting
  // only inserted sessions lets concurrent calls all pass the same check.
  let pendingOpens = 0
  let disposed = false

  function notify(session) {
    for (const wake of [...session.waiters]) {
      session.waiters.delete(wake)
      try { wake() } catch { /* a waiter must never break the session */ }
    }
  }

  function append(session, text) {
    if (!text) return
    session.text += text
    if (session.text.length > MAX_BUFFER_CHARS) {
      let drop = session.text.length - MAX_BUFFER_CHARS
      // Never cut a UTF-16 surrogate pair in half: a slice starting on the low
      // half would leave an orphan surrogate that the client renders as U+FFFD.
      const first = session.text.charCodeAt(drop)
      if (first >= 0xdc00 && first <= 0xdfff) drop += 1
      session.text = session.text.slice(drop)
      session.base += drop
    }
    notify(session)
  }

  function finish(session, exitCode, signal) {
    if (session.exited) return
    append(session, session.decoder.end())
    session.exited = true
    session.exitCode = Number.isInteger(exitCode) ? exitCode : null
    session.signal = typeof signal === 'string' ? signal : null
    notify(session)
  }

  function snapshot(session, cursor) {
    let offset = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
    let reset = false
    if (offset < session.base) {
      reset = true
      offset = session.base
    }
    return {
      session: session.id,
      cursor: session.base + session.text.length,
      data: session.text.slice(offset - session.base),
      reset,
      exited: session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
      title: session.title,
      kind: session.kind,
    }
  }

  function publicSession(session) {
    return {
      session: session.id,
      kind: session.kind,
      title: session.title,
      server: session.server?.name ?? null,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
    }
  }

  function closeSession(session, reason) {
    if (!session || session.closed) return
    session.closed = true
    sessions.delete(session.id)
    // Mark the session exited *before* waking readers so a suspended
    // `/terminal/read` long-poll returns `exited:true` immediately instead of
    // holding the request until its wait timeout (or reporting the stale
    // "not found" of a removed session).
    session.exited = true
    session.exitCode = null
    session.signal = null
    notify(session)
    session.waiters.clear()
    const handle = session.handle
    session.handle = null
    if (handle) {
      try {
        if (typeof handle.close === 'function') handle.close()
        else if (typeof handle.terminate === 'function') handle.terminate()
      } catch (error) {
        log(`terminal close failed (${reason ?? 'close'})`, { error: describe(error) })
      }
    }
  }

  async function open({ kind, server, cols, rows, cwd } = {}) {
    if (disposed) throw new Error('terminal hub is disposed')
    // Reserve the slot synchronously, before the first await, so two concurrent
    // opens cannot both pass the cap check and overshoot MAX_SESSIONS.
    if (sessions.size + pendingOpens >= MAX_SESSIONS) {
      throw new Error(`too many terminals (${MAX_SESSIONS}); close one first`)
    }
    pendingOpens += 1
    const session = {
      id: `term_${randomUUID()}`,
      kind: kind === 'remote' ? 'remote' : 'local',
      title: kind === 'remote' ? (server?.name ?? 'remote') : 'local',
      server: server ?? null,
      cwd: typeof cwd === 'string' ? cwd : undefined,
      cols: clampDimension(cols, 80, 500),
      rows: clampDimension(rows, 24, 300),
      text: '',
      base: 0,
      waiters: new Set(),
      exited: false,
      exitCode: null,
      signal: null,
      closed: false,
      decoder: new StringDecoder('utf8'),
      handle: null,
      lastUsed: Date.now(),
    }
    try {
      if (session.kind === 'remote') {
        if (!server) throw new Error('remote terminal needs a managed resource')
        const handle = await runtime.shell(server, { cols: session.cols, rows: session.rows })
        session.handle = handle
        session.title = server.name
        handle.onData((data) => {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
          append(session, session.decoder.write(buffer))
        })
        handle.onClose(() => finish(session, null, null))
        handle.onError((error) => {
          append(session, `\r\n[remote shell error: ${describe(error)}]\r\n`)
          finish(session, null, null)
        })
      } else {
        const subprocess = getSubprocess?.()
        if (!subprocess || typeof subprocess.spawnTerminal !== 'function') {
          throw new Error('local terminals are unavailable on this host')
        }
        const environment = await subprocess.terminalEnvironment?.()
        // The Host PTY provider names its platform (`windows` on win32) and the
        // preferred shell (ComSpec on Windows, $SHELL/login shell on POSIX).
        // `-i` is a POSIX login-shell flag: cmd.exe/pwsh reject it, so only
        // POSIX shells get it.
        const localPlatform = environment?.platform === 'windows' || (environment?.platform === undefined && process.platform === 'win32')
          ? 'windows'
          : 'posix'
        const shell = environment?.defaultShell || (localPlatform === 'windows' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh')
        const argv = localPlatform === 'windows' ? [shell] : [shell, '-i']
        const handle = await subprocess.spawnTerminal({
          argv,
          cwd: typeof cwd === 'string' && cwd ? cwd : getLocalCwd?.(),
          cols: session.cols,
          rows: session.rows,
          terminalType: 'xterm-256color',
          graceMs: 1000,
        })
        session.handle = {
          write: (data) => handle.write(data),
          resize: (nextCols, nextRows) => handle.resize(nextCols, nextRows),
          close: () => handle.terminate(),
        }
        handle.output.on('data', (data) => {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
          append(session, session.decoder.write(buffer))
        })
        handle.done.then(
          (outcome) => finish(session, outcome?.exitCode, outcome?.signal),
          (error) => {
            append(session, `\r\n[local terminal error: ${describe(error)}]\r\n`)
            finish(session, null, null)
          },
        )
      }
      // The hub may have been disposed while the transport was connecting: do
      // not leak a session (or a PTY) into a torn-down hub.
      if (disposed) throw new Error('terminal hub is disposed')
    } catch (error) {
      closeSession(session, 'open failed')
      throw error
    } finally {
      pendingOpens -= 1
    }
    sessions.set(session.id, session)
    session.lastUsed = Date.now()
    return publicSession(session)
  }

  function input(id, data) {
    const session = sessions.get(id)
    if (!session || session.exited || !session.handle) return false
    session.lastUsed = Date.now()
    session.handle.write(String(data ?? ''))
    return true
  }

  function resize(id, cols, rows) {
    const session = sessions.get(id)
    if (!session || session.exited || !session.handle) return false
    session.lastUsed = Date.now()
    session.cols = clampDimension(cols, session.cols, 500)
    session.rows = clampDimension(rows, session.rows, 300)
    try {
      session.handle.resize(session.cols, session.rows)
    } catch (error) {
      log('terminal resize failed', { error: describe(error) })
    }
    return true
  }

  async function read(id, { cursor = 0, waitMs = 0 } = {}) {
    const session = sessions.get(id)
    if (!session) throw new Error('terminal session not found')
    session.lastUsed = Date.now()
    const initial = snapshot(session, cursor)
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MAX_WAIT_MS)
    if (initial.data || initial.exited || wait === 0) return initial
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        session.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, wait)
      timer.unref?.()
      session.waiters.add(wake)
    })
    return snapshot(session, cursor)
  }

  function close(id) {
    const session = sessions.get(id)
    if (!session) return false
    closeSession(session, 'requested')
    return true
  }

  function closeForServer(serverId) {
    let closed = 0
    for (const session of [...sessions.values()]) {
      if (session.server?.id !== serverId) continue
      closeSession(session, 'server changed')
      closed += 1
    }
    return closed
  }

  function dispose() {
    disposed = true
    for (const session of [...sessions.values()]) closeSession(session, 'plugin unloaded')
    if (cleanup) clearInterval(cleanup)
  }

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - DEFAULT_IDLE_MS
    for (const session of [...sessions.values()]) {
      if (session.waiters.size > 0) continue
      if (session.lastUsed < cutoff) closeSession(session, 'idle')
    }
  }, 60 * 1000)
  cleanup.unref?.()

  return { open, read, input, resize, close, closeForServer, dispose, count: () => sessions.size }
}
