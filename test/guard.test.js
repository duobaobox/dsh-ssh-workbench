import test from 'node:test'
import assert from 'node:assert/strict'

import { BLOCK_REASON_PREFIX, createBlacklistGuard, sessionKeyOf } from '../lib/core/guard.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, facts: { dialect: 'posix' } },
  { id: 'srv_2', name: 'winbox', host: '10.0.0.6', port: 2222, username: 'admin', platform: 'windows', enabled: true, facts: { dialect: 'windows' } },
]

function makeGuard({ recorded = [], inventory = SERVERS } = {}) {
  return {
    guard: createBlacklistGuard({ loadInventory: () => inventory, recordActivity: (entry) => recorded.push(entry) }),
    recorded,
  }
}

function remoteExec(command, server = 'web-1', sessionId = 's1') {
  return { name: 'remote_bash', arguments: { server, command }, agent: { session: { id: sessionId } } }
}

function batchExec(tasks) {
  return { name: 'remote_exec', arguments: { tasks }, agent: { session: { id: 's1' } } }
}

test('sessionKeyOf tolerates agent/session test doubles', () => {
  assert.equal(sessionKeyOf(remoteExec('df -h')), 's1')
  assert.equal(sessionKeyOf({ agent: { id: 'a1' } }), 'a1')
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(undefined), undefined)
})

test('guard denies machine-destroying commands on an explicit remote server', () => {
  const { guard, recorded } = makeGuard()
  for (const command of ['rm -rf /', 'mkfs.ext4 /dev/sdb1', ':(){ :|:& };:', 'dd if=/dev/zero of=/dev/sda']) {
    const reason = guard(remoteExec(command))
    assert.equal(typeof reason, 'string', command)
    assert.match(reason, new RegExp(BLOCK_REASON_PREFIX.trim()))
  }
  assert.equal(recorded.length, 4)
  assert.match(recorded[0].outcome, /^blocked: /)
  assert.equal(recorded[0].server, 'web-1')
  assert.equal(recorded[0].sessionId, 's1')
})

test('guard leaves ordinary remote commands alone', () => {
  const { guard, recorded } = makeGuard()
  for (const command of ['df -h', 'systemctl restart nginx', 'rm -rf /tmp/upload-1', 'cat /etc/os-release']) {
    assert.equal(guard(remoteExec(command)), undefined, command)
  }
  assert.equal(recorded.length, 0)
})

test('guard does not touch local bash, unknown tools, or unknown servers', () => {
  const { guard } = makeGuard()
  assert.equal(guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's1' } } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's1' } } }), undefined)
  assert.equal(guard(remoteExec('rm -rf /', 'missing')), undefined)
  assert.equal(guard(undefined), undefined)
})

test('guard is a no-op without an inventory', () => {
  const guard = createBlacklistGuard({})
  assert.equal(guard(remoteExec('rm -rf /')), undefined)
})

test('guard never throws into the tool pipeline', () => {
  const guard = createBlacklistGuard({
    loadInventory() {
      throw new Error('boom')
    },
    recordActivity() {
      throw new Error('activity boom')
    },
  })
  assert.equal(guard(remoteExec('df -h')), undefined)
  const denyGuard = createBlacklistGuard({
    loadInventory: () => SERVERS,
    recordActivity() {
      throw new Error('activity boom')
    },
  })
  // A failing activity recorder must not swallow the denial.
  assert.match(denyGuard(remoteExec('rm -rf /')), /recursive delete/)
})

test('remote_exec guard checks every explicit task', () => {
  const { guard, recorded } = makeGuard()
  const reason = guard(batchExec([
    { server: 'web-1', command: 'df -h' },
    { server: 'web-1', command: 'rm -rf /' },
  ]))
  assert.match(reason, /task 2/)
  assert.match(reason, /recursive delete/)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].server, 'web-1')
  assert.match(recorded[0].summary, /^task 2: /)
  assert.equal(recorded[0].outcome.startsWith('blocked: '), true)
})

test('remote_exec guard uses the Windows rules for Windows tasks', () => {
  const { guard } = makeGuard()
  assert.match(guard(batchExec([{ server: 'winbox', command: 'Format-Volume -DriveLetter D' }])), /disk|volume|Format-Volume/i)
  assert.equal(guard(batchExec([{ server: 'winbox', command: 'Get-Volume' }])), undefined)
})

test('remote_exec guard leaves safe, unknown and malformed tasks alone', () => {
  const { guard } = makeGuard()
  assert.equal(guard(batchExec([{ server: 'web-1', command: 'df -h' }])), undefined)
  assert.equal(guard(batchExec([{ server: 'missing', command: 'rm -rf /' }])), undefined)
  assert.equal(guard(batchExec([])), undefined)
  assert.equal(guard({ name: 'remote_exec', arguments: {} }), undefined)
  assert.equal(guard({ name: 'remote_exec', arguments: { tasks: [] }, agent: { session: { id: 's1' } } }), undefined)
})

test('remote_exec guard runs both gates when the dialect facts are missing', () => {
  const stale = [{ id: 'srv_9', name: 'stale', host: '10.0.0.9', port: 22, username: 'ops', platform: 'posix', enabled: true, facts: {} }]
  const guard = createBlacklistGuard({ loadInventory: () => stale })
  assert.match(guard(batchExec([{ server: 'stale', command: 'Format-Volume -DriveLetter D' }])), /format/i)
})
