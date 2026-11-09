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
