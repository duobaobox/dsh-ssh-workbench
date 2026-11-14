import test from 'node:test'
import assert from 'node:assert/strict'

import { createSshRuntime } from '../lib/core/ssh.js'
import { FakeClient } from './helpers/fake-client.js'

const server = {
  id: 'srv-1',
  name: 'web-1',
  host: '10.0.0.5',
  port: 22,
  username: 'root',
  platform: 'posix',
  authRef: { type: 'password' },
}

function makeRuntime(overrides = {}) {
  FakeClient.reset()
  const secrets = new Map([['server:srv-1:password', 'pw']])
  const runtime = createSshRuntime({
    getSecret: (key) => secrets.get(key),
    knownHosts: { verify: () => true, has: () => true },
    config: { connectTimeoutMs: 2000, commandTimeoutMs: 2000, factsTtlMs: 60000, ...overrides },
    ClientCtor: FakeClient,
  })
  return { runtime, secrets }
}

test('runtime exec reports warm/cold and timing breakdown', async () => {
  const { runtime } = makeRuntime()
  const cold = await runtime.exec(server, 'echo hi')
  assert.equal(cold.outcome, 'success')
  assert.equal(cold.warm, false)
  assert.equal(typeof cold.timings.totalMs, 'number')
  const warm = await runtime.exec(server, 'echo hi')
  assert.equal(warm.warm, true)
  await runtime.close()
})

test('exec applies cwd as a quoted cd prefix', async () => {
  const { runtime } = makeRuntime()
  await runtime.exec(server, 'echo hi', { cwd: "/opt/my app's dir" })
  const command = FakeClient.instances[0].commands[0]
  assert.match(command, /^cd -- '\/opt\/my app'\\''s dir' && echo hi$/)
  await runtime.exec(server, 'pwd')
  assert.equal(FakeClient.instances[0].commands[1], 'pwd')
  await runtime.close()
})

test('facts are cached for factsTtlMs and refresh bypasses the cache', async () => {
  const { runtime } = makeRuntime()
  FakeClient.outputFor = () => [
    '__SDH_HOST__', 'web-1',
    '__SDH_OS__', 'Linux test',
    '__SDH_UPTIME__', 'up 1 day',
    '__SDH_MEM__', 'Mem: 1 1 1',
    '__SDH_DISK__', '/dev/vda1 1 1 1 1% /',
  ].join('\n')
  const first = await runtime.facts(server)
  assert.equal(first.cached, false)
  assert.equal(first.facts.hostname, 'web-1')
  const callsAfterFirst = FakeClient.instances[0].execCount
  const second = await runtime.facts(server)
  assert.equal(second.cached, true)
  assert.equal(second.facts.hostname, 'web-1')
  assert.equal(FakeClient.instances[0].execCount, callsAfterFirst, 'cached facts must not re-run the remote script')
  const refreshed = await runtime.facts(server, { refresh: true })
  assert.equal(refreshed.cached, false)
  assert.equal(FakeClient.instances[0].execCount, callsAfterFirst + 1)
  await runtime.close()
})

test('facts cache is invalidated when the server record changes', async () => {
  const { runtime } = makeRuntime()
  FakeClient.outputFor = () => '__SDH_HOST__\nweb-1\n'
  await runtime.facts(server)
  const moved = { ...server, host: '10.0.0.9' }
  const again = await runtime.facts(moved)
  assert.equal(again.cached, false)
  await runtime.close()
})

test('runtime detects the remote timeout flavour, shell and caches the probe', async () => {
  const { runtime } = makeRuntime()
  FakeClient.outputFor = () => 'kill|/usr/bin/zsh'
  assert.deepEqual(await runtime.timeoutGuard(server), { mode: 'kill', shell: '/usr/bin/zsh' })
  const execCount = FakeClient.instances[0].execCount
  assert.deepEqual(await runtime.timeoutGuard(server), { mode: 'kill', shell: '/usr/bin/zsh' })
  assert.equal(FakeClient.instances[0].execCount, execCount, 'the capability probe must be cached')
  await runtime.close()
})

test('runtime timeout probe caches executed probes and degrades to none safely', async () => {
  const basic = makeRuntime()
  FakeClient.outputFor = () => 'basic|/bin/csh'
  assert.deepEqual(await basic.runtime.timeoutGuard(server), { mode: 'basic', shell: '/bin/csh' })
  await basic.runtime.close()

  // A probe that ran but failed (e.g. fish/csh cannot parse POSIX, or `sh` is
  // missing) still gives a stable answer: cache `none` and stop re-probing.
  const failing = makeRuntime()
  FakeClient.outputFor = () => ''
  FakeClient.codeFor = () => 2
  assert.deepEqual(await failing.runtime.timeoutGuard(server), { mode: 'none', shell: '/bin/sh' })
  const execCount = FakeClient.instances[0].execCount
  assert.deepEqual(await failing.runtime.timeoutGuard(server), { mode: 'none', shell: '/bin/sh' })
  assert.equal(FakeClient.instances[0].execCount, execCount)
  await failing.runtime.close()

  // Garbled output must never be interpreted as a usable wrapper.
  const garbled = makeRuntime()
  FakeClient.outputFor = () => 'garbage'
  assert.deepEqual(await garbled.runtime.timeoutGuard(server), { mode: 'none', shell: '/bin/sh' })
  await garbled.runtime.close()
})

test('concurrent timeout probes share one in-flight probe', async () => {
  const { runtime } = makeRuntime()
  FakeClient.outputFor = () => 'kill|/bin/bash'
  const [first, second] = await Promise.all([runtime.timeoutGuard(server), runtime.timeoutGuard(server)])
  assert.deepEqual(first, { mode: 'kill', shell: '/bin/bash' })
  assert.deepEqual(second, first)
  assert.equal(FakeClient.instances[0].execCount, 1)
  await runtime.close()
})

test('windows targets never run the timeout probe', async () => {
  const { runtime } = makeRuntime()
  assert.deepEqual(await runtime.timeoutGuard({ ...server, platform: 'windows' }), { mode: 'none', shell: '/bin/sh' })
  assert.equal(FakeClient.instances.length, 0)
  await runtime.close()
})

test('chunked upload verifies the remote size on explicit close', async () => {
  const { runtime } = makeRuntime()
  const opened = await runtime.sftpOpenWrite(server, '/tmp/out.bin', true)
  await runtime.sftpWriteChunk(opened.session, 0, Buffer.from('abcd'))
  await runtime.sftpWriteChunk(opened.session, 4, Buffer.from('efgh'))
  const closed = await runtime.sftpCloseTransfer(opened.session, { verify: true })
  assert.equal(closed.verified, true)
  assert.equal(closed.bytes, 8)
  await runtime.close()
})

test('chunked upload fails fast when a chunk stalls', async () => {
  const { runtime } = makeRuntime({ transferChunkTimeoutMs: 100 })
  FakeClient.hangSftpWrites = true
  const opened = await runtime.sftpOpenWrite(server, '/tmp/stall.bin', true)
  await assert.rejects(runtime.sftpWriteChunk(opened.session, 0, Buffer.from('data')), (error) => {
    assert.equal(error.code, 'SFTP_TIMEOUT')
    return true
  })
  await assert.rejects(runtime.sftpWriteChunk(opened.session, 0, Buffer.from('data')), (error) => {
    assert.equal(error.code, 'TRANSFER_SESSION')
    return true
  })
  await runtime.close()
})

test('transfer sessions can be closed for one server', async () => {
  const { runtime } = makeRuntime()
  const opened = await runtime.sftpOpenWrite(server, '/tmp/a.bin', true)
  await runtime.sftpWriteChunk(opened.session, 0, Buffer.from('x'))
  const closed = await runtime.closeTransferSessionsForServer(server.id)
  assert.equal(closed, 1)
  await assert.rejects(runtime.sftpWriteChunk(opened.session, 0, Buffer.from('x')), (error) => error.code === 'TRANSFER_SESSION')
  await runtime.close()
})

test('SFTP errors are normalized and reject fast (no recursive normalizer)', async () => {
  const { runtime } = makeRuntime()
  const listed = await runtime.sftpList(server, '/tmp')
  assert.equal(listed.length, 1)
  FakeClient.instances[0].failNextSftp = true
  const started = Date.now()
  await assert.rejects(runtime.sftpList(server, '/missing'), (error) => {
    assert.equal(error.code, 'SFTP_FAILED')
    return true
  })
  assert.ok(Date.now() - started < 2000)
  await runtime.close()
})

test('runtime test() detects Windows even when the record says posix', async () => {
  const { runtime } = makeRuntime()
  const windowsServer = { ...server, name: 'win-1', platform: 'posix', facts: {} }
  FakeClient.outputFor = (command) => (command.includes('ver') ? 'Microsoft Windows [Version 10.0.26100.1]' : "'uname' is not recognized")
  FakeClient.codeFor = (command) => (command.includes('ver') ? 0 : 1)
  const result = await runtime.test(windowsServer)
  assert.equal(result.ok, true)
  assert.equal(result.platform, 'windows')
  assert.equal(result.dialect, 'windows')
  await runtime.close()
})

test('runtime test() uses one handshake and returns latency', async () => {
  const { runtime } = makeRuntime()
  const result = await runtime.test(server)
  assert.equal(result.ok, true)
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(FakeClient.instances.length, 1)
  await runtime.close()
})
