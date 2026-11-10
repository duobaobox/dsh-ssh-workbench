import test from 'node:test'
import assert from 'node:assert/strict'

import { BLOCK_REASON_PREFIX, createBlacklistGuard, sessionKeyOf } from '../lib/core/guard.js'

function makeGuard({ active = 'web-1', recorded = [] } = {}) {
  const targets = {
    get(sessionId) {
      return sessionId === 's1' ? { active } : undefined
    },
  }
  return {
    guard: createBlacklistGuard({ targets, recordActivity: (entry) => recorded.push(entry) }),
    recorded,
  }
}

function bashExec(command, sessionId = 's1') {
  return { name: 'bash', arguments: { command }, agent: { session: { id: sessionId } } }
}

test('sessionKeyOf tolerates agent/session test doubles', () => {
  assert.equal(sessionKeyOf(bashExec('df -h')), 's1')
  assert.equal(sessionKeyOf({ agent: { id: 'a1' } }), 'a1')
  assert.equal(sessionKeyOf({}), undefined)
  assert.equal(sessionKeyOf(undefined), undefined)
})

test('guard denies machine-destroying commands on the remote target', () => {
  const { guard, recorded } = makeGuard()
  for (const command of ['rm -rf /', 'mkfs.ext4 /dev/sdb1', ':(){ :|:& };:', 'dd if=/dev/zero of=/dev/sda']) {
    const reason = guard(bashExec(command))
    assert.equal(typeof reason, 'string', command)
    assert.match(reason, new RegExp(BLOCK_REASON_PREFIX.trim()))
  }
  assert.equal(recorded.length, 4)
  assert.match(recorded[0].outcome, /^blocked: /)
  assert.equal(recorded[0].server, 'web-1')
})

test('guard leaves ordinary remote commands alone', () => {
  const { guard, recorded } = makeGuard()
  for (const command of ['df -h', 'systemctl restart nginx', 'rm -rf /tmp/upload-1', 'cat /etc/os-release']) {
    assert.equal(guard(bashExec(command)), undefined, command)
  }
  assert.equal(recorded.length, 0)
})

test('guard does not touch local bash or other tools', () => {
  const { guard } = makeGuard()
  assert.equal(guard(bashExec('rm -rf /', 'no-target-session')), undefined)
  assert.equal(guard({ name: 'bash', arguments: { command: 'rm -rf /' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's1' } } }), undefined)
  assert.equal(guard(undefined), undefined)
})

test('guard is a no-op without a target store', () => {
  const guard = createBlacklistGuard({})
  assert.equal(guard(bashExec('rm -rf /')), undefined)
})

test('guard never throws into the tool pipeline', () => {
  const guard = createBlacklistGuard({
    targets: {
      get() {
        throw new Error('boom')
      },
    },
    recordActivity() {
      throw new Error('activity boom')
    },
  })
  assert.equal(guard(bashExec('df -h')), undefined)
  const denyGuard = createBlacklistGuard({
    targets: {
      get() {
        return { active: 'web-1' }
      },
    },
    recordActivity() {
      throw new Error('activity boom')
    },
  })
  // A failing activity recorder must not swallow the denial.
  assert.match(denyGuard(bashExec('rm -rf /')), /recursive delete/)
})

const BATCH_SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, facts: { dialect: 'posix' } },
  { id: 'srv_2', name: 'winbox', host: '10.0.0.6', port: 2222, username: 'admin', platform: 'windows', enabled: true, facts: { dialect: 'windows' } },
]

function batchExec(tasks) {
  return { name: 'remote_exec', arguments: { tasks }, agent: { session: { id: 's1' } } }
}

test('remote_exec guard checks every explicit task without an active target', () => {
  const recorded = []
  const guard = createBlacklistGuard({
    targets: { get: () => ({ active: null, candidates: ['web-1', 'winbox'] }) },
    loadInventory: () => BATCH_SERVERS,
    recordActivity: (entry) => recorded.push(entry),
  })
  const reason = guard(batchExec([
    { server: 'web-1', command: 'df -h' },
    { server: 'web-1', command: 'rm -rf /' },
  ]))
  assert.match(reason, /task 2 \(web-1\)/)
  assert.match(reason, /recursive delete/)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].server, 'web-1')
  assert.match(recorded[0].summary, /^\[task 2\]/)
  assert.equal(recorded[0].outcome.startsWith('blocked: '), true)
})

test('remote_exec guard uses the Windows rules for Windows tasks', () => {
  const guard = createBlacklistGuard({
    loadInventory: () => BATCH_SERVERS,
  })
  assert.match(guard(batchExec([{ server: 'winbox', command: 'Format-Volume -DriveLetter D' }])), /disk|volume|Format-Volume/i)
  assert.equal(guard(batchExec([{ server: 'winbox', command: 'Get-Volume' }])), undefined)
})

test('remote_exec guard leaves safe, unknown and malformed tasks alone', () => {
  const guard = createBlacklistGuard({ loadInventory: () => BATCH_SERVERS })
  assert.equal(guard(batchExec([{ server: 'web-1', command: 'df -h' }])), undefined)
  assert.equal(guard(batchExec([{ server: 'missing', command: 'rm -rf /' }])), undefined)
  assert.equal(guard(batchExec([])), undefined)
  assert.equal(guard({ name: 'remote_exec', arguments: {} }), undefined)
  assert.equal(guard({ name: 'remote_exec', arguments: { tasks: [] }, agent: { session: { id: 's1' } } }), undefined)
})

test('remote_exec guard swallows inventory and recorder failures', () => {
  const guard = createBlacklistGuard({
    loadInventory() {
      throw new Error('inventory boom')
    },
  })
  assert.equal(guard(batchExec([{ server: 'web-1', command: 'rm -rf /' }])), undefined)
  const denyGuard = createBlacklistGuard({
    loadInventory: () => BATCH_SERVERS,
    recordActivity() {
      throw new Error('activity boom')
    },
  })
  // A failing recorder must not turn the denial into a permission.
  assert.match(denyGuard(batchExec([{ server: 'web-1', command: 'rm -rf /' }])), /recursive delete/)
})

test('remote_exec guard runs both gates when the dialect facts are missing', () => {
  const stale = [{ id: 'srv_9', name: 'stale', host: '10.0.0.9', port: 22, username: 'ops', platform: 'posix', enabled: true, facts: {} }]
  const guard = createBlacklistGuard({ loadInventory: () => stale })
  // The record says POSIX, but the executor will probe before running. A
  // Windows-only destructive command must not slip through while facts are old.
  assert.match(guard(batchExec([{ server: 'stale', command: 'Format-Volume -DriveLetter D' }])), /format/i)
})
