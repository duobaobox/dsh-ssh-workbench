import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createSessionBroker } from '../lib/core/broker.js'

import { FakeClient } from './helpers/fake-client.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeBroker(overrides = {}) {
  FakeClient.reset()
  const secrets = new Map([
    ['server:srv-1:password', 'pw'],
    ['server:srv-2:password', 'pw'],
  ])
  const broker = createSessionBroker({
    getSecret: (key) => secrets.get(key),
    knownHosts: { verify: () => true, has: () => true },
    config: { connectTimeoutMs: 2000, commandTimeoutMs: 2000, ...overrides },
    ClientCtor: FakeClient,
  })
  return { broker, secrets }
}

const server = { id: 'srv-1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', authRef: { type: 'password' } }

test('a per-call connectTimeoutMs clamps the connection ready timeout', async () => {
  const { broker } = makeBroker({ connectTimeoutMs: 15000 })
  await broker.exec(server, 'uname -s', { connectTimeoutMs: 4000 })
  assert.equal(FakeClient.instances[0].connectConfig.readyTimeout, 4000)
  await broker.closeAll()
})

test('broker reuses one connection per server and reports warm calls', async () => {
  const { broker } = makeBroker()
  const first = await broker.exec(server, 'echo one')
  const second = await broker.exec(server, 'echo two')
  assert.equal(first.outcome, 'success')
  assert.equal(first.warm, false)
  assert.equal(second.outcome, 'success')
  assert.equal(second.warm, true)
  assert.equal(FakeClient.instances.length, 1)
  assert.equal(FakeClient.instances[0].execCount, 2)
  await broker.closeAll()
})

test('broker closes exec stdin immediately so stdin readers get EOF', async () => {
  const { broker } = makeBroker()
  await broker.exec(server, 'cat')
  await broker.exec(server, 'echo two')
  const client = FakeClient.instances[0]
  assert.equal(client.streams.length, 2)
  assert.deepEqual(client.streams.map((stream) => stream.stdinEnded), [true, true])
  await broker.closeAll()
})

test('broker rebuilds the connection when server settings change', async () => {
  const { broker, secrets } = makeBroker()
  await broker.exec(server, 'echo one')
  secrets.set('server:srv-1:password', 'rotated')
  await broker.exec(server, 'echo two')
  assert.equal(FakeClient.instances.length, 2)
  assert.equal(FakeClient.instances[0].ended, true)
  await broker.closeAll()
})

test('broker evicts idle connections', async () => {
  const { broker } = makeBroker({ poolIdleMs: 15, sweepIntervalMs: 5 })
  await broker.exec(server, 'echo one')
  assert.equal(FakeClient.instances.length, 1)
  assert.equal(FakeClient.instances[0].ended, false)
  await sleep(60)
  assert.equal(FakeClient.instances[0].ended, true)
  // The evicted connection is gone: the next call opens a fresh one.
  await broker.exec(server, 'echo two')
  assert.equal(FakeClient.instances.length, 2)
  await broker.closeAll()
})

test('broker retries once on a connection-level failure for read-only commands only', async () => {
  const { broker } = makeBroker()
  await broker.exec(server, 'echo warm')
  FakeClient.instances[0].failNextExec = true
  const retried = await broker.exec(server, 'df -h', { readOnly: true })
  assert.equal(retried.outcome, 'success')
  assert.equal(FakeClient.instances.length, 2)

  // A write must never be retried: the remote may have executed it.
  const writeClient = FakeClient.instances.at(-1)
  writeClient.failNextExec = true
  const failed = await broker.exec(server, 'systemctl restart nginx', { readOnly: false })
  assert.equal(failed.outcome, 'failed')
  await broker.closeAll()
})

test('broker maps the remote timeout exit (124) to the timeout outcome', async () => {
  const { broker } = makeBroker()
  FakeClient.outputFor = () => 'partial output'
  FakeClient.codeFor = () => 124
  const timed = await broker.exec(server, 'sleep 5', { timeoutMs: 1000 })
  assert.equal(timed.outcome, 'timeout')
  assert.equal(timed.exitCode, null)
  assert.equal(timed.stdout, 'partial output')
  assert.equal(timed.note, 'remote timeout deadline reached')

  // A command that genuinely exits 124 long before the deadline stays a
  // normal non-zero result.
  FakeClient.codeFor = () => 124
  const exited = await broker.exec(server, 'exit 124', { timeoutMs: 60000 })
  assert.equal(exited.outcome, 'failed')
  assert.equal(exited.exitCode, 124)
  await broker.closeAll()
})

test('broker caps stderr separately from stdout', async () => {
  const { broker } = makeBroker()
  FakeClient.outputFor = () => 'x'.repeat(300)
  FakeClient.stderrFor = () => 'e'.repeat(300)
  const result = await broker.exec(server, 'echo noisy', { cap: 64, stderrCap: 32 })
  assert.equal(result.truncated.stdout, true)
  assert.equal(result.truncated.stderr, true)
  assert.ok(result.stdout.length < 300)
  assert.ok(result.stderr.length < 300)
  await broker.closeAll()
})

test('broker shares one connection across concurrent calls', async () => {
  const { broker } = makeBroker()
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => broker.exec(server, `echo ${index}`)))
  assert.equal(results.every((result) => result.outcome === 'success'), true)
  assert.equal(FakeClient.instances.length, 1)
  await broker.closeAll()
})

test('broker reuses the SFTP subsystem and rejects SFTP errors quickly', async () => {
  const { broker } = makeBroker()
  const entries = await broker.withSftp(server, (sftp) => new Promise((resolve, reject) => {
    sftp.readdir('/tmp', (error, list) => (error ? reject(error) : resolve(list)))
  }))
  assert.equal(entries.length, 1)
  await broker.withSftp(server, (sftp) => new Promise((resolve, reject) => {
    sftp.stat('/tmp/a.txt', (error) => (error ? reject(error) : resolve()))
  }))
  assert.equal(FakeClient.instances[0].sftpCount, 1)

  FakeClient.instances[0].failNextSftp = true
  const started = Date.now()
  await assert.rejects(
    broker.withSftp(server, (sftp) => new Promise((resolve, reject) => {
      sftp.readdir('/missing', (error, list) => (error ? reject(error) : resolve(list)))
    })),
    (error) => {
      assert.equal(error.code, 'SFTP_FAILED')
      return true
    },
  )
  // The old recursive normalizer turned this into a 30s timeout.
  assert.ok(Date.now() - started < 2000, 'SFTP error must reject quickly')
  await broker.closeAll()
})

test('broker test() uses a single handshake and keeps the connection warm', async () => {
  const { broker } = makeBroker()
  const result = await broker.test(server)
  assert.equal(result.ok, true)
  assert.equal(FakeClient.instances.length, 1)
  const again = await broker.test(server)
  assert.equal(again.warm, true)
  assert.equal(FakeClient.instances.length, 1)
  await broker.closeAll()
})

test('connectionPool:false falls back to one connection per call', async () => {
  const { broker } = makeBroker({ connectionPool: false })
  await broker.exec(server, 'echo one')
  await broker.exec(server, 'echo two')
  assert.equal(FakeClient.instances.length, 2)
  await broker.closeAll()
})

test('broker closeAll ends every pooled client', async () => {
  const { broker } = makeBroker()
  await broker.exec(server, 'echo one')
  const second = { ...server, id: 'srv-2', name: 'web-2', host: '10.0.0.6' }
  await broker.exec(second, 'echo two')
  assert.equal(FakeClient.instances.length, 2)
  await broker.closeAll()
  assert.equal(FakeClient.instances.every((client) => client.ended), true)
})
