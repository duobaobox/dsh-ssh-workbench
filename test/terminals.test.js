import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createTerminalHub } from '../lib/core/terminals.js'

function remoteHandle() {
  const events = new EventEmitter()
  const writes = []
  const resizes = []
  return {
    events,
    writes,
    resizes,
    closed: false,
    write: (data) => writes.push(data),
    resize: (cols, rows) => resizes.push([cols, rows]),
    onData(handler) { events.on('data', handler) },
    onClose(handler) { events.once('close', handler) },
    onError(handler) { events.once('error', handler) },
    close() { this.closed = true },
    emitData(data) { events.emit('data', Buffer.from(data)) },
    emitClose() { events.emit('close') },
  }
}

function localHandle() {
  const output = new EventEmitter()
  const writes = []
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  return {
    output,
    writes,
    done,
    terminated: false,
    write: (data) => writes.push(data),
    resize: () => {},
    terminate() { this.terminated = true },
    emitData(data) { output.emit('data', Buffer.from(data)) },
    exit(code = 0) { resolveDone({ exitCode: code, signal: null }) },
  }
}

test('remote terminals stream output, accept input and resize, and close', async () => {
  const handle = remoteHandle()
  const server = { id: 'srv_1', name: 'web-1' }
  const hub = createTerminalHub({
    runtime: { shell: async () => handle },
  })
  const opened = await hub.open({ kind: 'remote', server, cols: 90, rows: 30 })
  assert.equal(opened.kind, 'remote')
  assert.equal(opened.title, 'web-1')
  assert.equal(opened.cols, 90)

  const empty = await hub.read(opened.session, { cursor: 0 })
  assert.equal(empty.data, '')
  assert.equal(empty.exited, false)

  handle.emitData('hello')
  const read = await hub.read(opened.session, { cursor: 0 })
  assert.equal(read.data, 'hello')
  assert.equal(read.cursor, 5)

  const tail = await hub.read(opened.session, { cursor: read.cursor })
  assert.equal(tail.data, '')

  assert.equal(hub.input(opened.session, 'ls\n'), true)
  assert.deepEqual(handle.writes, ['ls\n'])
  assert.equal(hub.resize(opened.session, 120, 40), true)
  assert.deepEqual(handle.resizes, [[120, 40]])

  handle.emitClose()
  const exited = await hub.read(opened.session, { cursor: 5 })
  assert.equal(exited.exited, true)
  assert.equal(hub.close(opened.session), true)
  assert.equal(handle.closed, true)
  hub.dispose()
})

test('a slow reader receives output that arrives during its wait', async () => {
  const handle = remoteHandle()
  const hub = createTerminalHub({ runtime: { shell: async () => handle } })
  const opened = await hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } })
  const pending = hub.read(opened.session, { cursor: 0, waitMs: 1000 })
  setTimeout(() => handle.emitData('later'), 10)
  const result = await pending
  assert.equal(result.data, 'later')
  hub.dispose()
})

test('local terminals use the Host PTY and surface their exit', async () => {
  const handle = localHandle()
  const hub = createTerminalHub({
    getSubprocess: () => ({
      terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/zsh' }),
      spawnTerminal: async (spec) => {
        assert.deepEqual(spec.argv, ['/bin/zsh', '-i'])
        assert.equal(spec.terminalType, 'xterm-256color')
        return handle
      },
    }),
    getLocalCwd: () => '/workspace',
  })
  const opened = await hub.open({ kind: 'local' })
  assert.equal(opened.kind, 'local')
  handle.emitData('prompt$ ')
  const read = await hub.read(opened.session, { cursor: 0 })
  assert.equal(read.data, 'prompt$ ')
  assert.equal(hub.input(opened.session, 'echo hi\n'), true)
  assert.deepEqual(handle.writes, ['echo hi\n'])
  handle.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const exited = await hub.read(opened.session, { cursor: read.cursor })
  assert.equal(exited.exited, true)
  assert.equal(exited.exitCode, 0)
  hub.dispose()
  assert.equal(handle.terminated, true)
})

test('terminal sessions are reclaimed with their resource and on dispose', async () => {
  const first = remoteHandle()
  const second = remoteHandle()
  let calls = 0
  const hub = createTerminalHub({
    runtime: { shell: async () => (calls++ === 0 ? first : second) },
  })
  const one = await hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } })
  await hub.open({ kind: 'remote', server: { id: 'srv_2', name: 'web-2' } })
  assert.equal(hub.closeForServer('srv_1'), 1)
  assert.equal(first.closed, true)
  await assert.rejects(() => hub.read(one.session, { cursor: 0 }), /not found/)
  hub.dispose()
  assert.equal(second.closed, true)
})

test('512K scrollback truncation never splits a surrogate pair', async () => {
  const handle = remoteHandle()
  const hub = createTerminalHub({ runtime: { shell: async () => handle } })
  const opened = await hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } })

  // 525289 code units: drop = 1001 would land exactly on the low half of the
  // emoji surrogate pair, so the buffer must advance to the next boundary.
  const payload = `${'a'.repeat(1000)}😀${'b'.repeat(524287)}`
  handle.emitData(payload)
  const snapshot = await hub.read(opened.session, { cursor: 0 })

  assert.equal(snapshot.reset, true)
  assert.ok(snapshot.data.length <= 512 * 1024)
  assert.equal(snapshot.data.startsWith('b'), true, 'buffer must start after the split emoji, not inside it')
  const first = snapshot.data.charCodeAt(0)
  assert.equal(first >= 0xdc00 && first <= 0xdfff, false, 'buffer must not start with a lone low surrogate')
  assert.equal(snapshot.cursor, payload.length)
  hub.dispose()
})

test('concurrent opens cannot overshoot the MAX_SESSIONS cap', async () => {
  const handles = []
  const hub = createTerminalHub({
    runtime: {
      shell: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const handle = remoteHandle()
        handles.push(handle)
        return handle
      },
    },
  })
  for (let index = 0; index < 11; index += 1) {
    await hub.open({ kind: 'remote', server: { id: `srv_${index}`, name: `web-${index}` } })
  }
  const results = await Promise.allSettled([
    hub.open({ kind: 'remote', server: { id: 'srv_a', name: 'web-a' } }),
    hub.open({ kind: 'remote', server: { id: 'srv_b', name: 'web-b' } }),
  ])
  assert.equal(hub.count(), 12, 'the hub must never exceed the cap')
  assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 1)
  const rejected = results.find((entry) => entry.status === 'rejected')
  assert.match(rejected.reason.message, /too many terminals \(12\)/)
  hub.dispose()
})

test('a failed open releases its reserved slot', async () => {
  let attempts = 0
  const hub = createTerminalHub({
    runtime: {
      shell: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connection refused')
        return remoteHandle()
      },
    },
  })
  await assert.rejects(
    () => hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } }),
    /connection refused/,
  )
  assert.equal(hub.count(), 0)
  const opened = await hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } })
  assert.equal(opened.kind, 'remote')
  hub.dispose()
})

test('closing a session wakes a pending read with an exited snapshot', async () => {
  const handle = remoteHandle()
  const hub = createTerminalHub({ runtime: { shell: async () => handle } })
  const opened = await hub.open({ kind: 'remote', server: { id: 'srv_1', name: 'web-1' } })
  const startedAt = Date.now()
  const pending = hub.read(opened.session, { cursor: 0, waitMs: 5000 })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(hub.close(opened.session), true)
  const snapshot = await pending
  assert.equal(snapshot.exited, true)
  assert.equal(snapshot.exitCode, null)
  assert.equal(snapshot.signal, null)
  assert.ok(Date.now() - startedAt < 1000, 'the pending read must wake on close instead of waiting for its wait timeout')
  await assert.rejects(() => hub.read(opened.session, { cursor: 0 }), /not found/)
  assert.equal(handle.closed, true)
  hub.dispose()
})

test('Windows local terminals spawn the preferred shell without the POSIX -i flag', async () => {
  const handle = localHandle()
  const hub = createTerminalHub({
    getSubprocess: () => ({
      terminalEnvironment: async () => ({ platform: 'windows', defaultShell: 'C:\\Windows\\System32\\cmd.exe' }),
      spawnTerminal: async (spec) => {
        assert.deepEqual(spec.argv, ['C:\\Windows\\System32\\cmd.exe'])
        assert.equal(spec.cwd, 'C:\\Users\\alice')
        assert.equal(spec.terminalType, 'xterm-256color')
        return handle
      },
    }),
    getLocalCwd: () => 'C:\\Users\\alice',
  })
  const opened = await hub.open({ kind: 'local' })
  assert.equal(opened.kind, 'local')
  handle.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  hub.dispose()
  assert.equal(handle.terminated, true)
})
