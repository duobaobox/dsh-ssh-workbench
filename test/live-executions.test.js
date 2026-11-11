import test from 'node:test'
import assert from 'node:assert/strict'

import { createLiveExecutions, serversOf } from '../lib/core/live-executions.js'

function exec(name, args, session = 's1') {
  return { name, arguments: args, agent: { session: { id: session } } }
}

test('serversOf understands shells, file tools, and remote_exec fan-out', () => {
  assert.deepEqual(serversOf(exec('remote_bash', { server: 'web-1', command: 'uptime' })), ['web-1'])
  assert.deepEqual(serversOf(exec('remote_read', { server: 'db-1', path: '/etc/hosts' })), ['db-1'])
  assert.deepEqual(serversOf(exec('remote_write', { server: 'db-1', path: '/tmp/a', content: 'x' })), ['db-1'])
  assert.deepEqual(serversOf(exec('remote_grep', { server: 'db-1', pattern: 'x' })), ['db-1'])
  assert.deepEqual(serversOf(exec('remote_exec', { tasks: [{ server: 'web-1' }, { server: 'db-1' }, { server: 'web-1' }] })), ['web-1', 'db-1'])
  assert.deepEqual(serversOf(exec('bash', { command: 'pwd' })), [])
  assert.deepEqual(serversOf(exec('remote_bash', { command: 'pwd' })), [])
})

test('live executions track concurrent calls per session and server', () => {
  const live = createLiveExecutions({ now: () => 1000 })
  const first = live.begin(exec('remote_bash', { server: 'web-1' }))
  const second = live.begin(exec('remote_read', { server: 'web-1' }, 's2'))
  const third = live.begin(exec('remote_exec', { tasks: [{ server: 'web-1' }, { server: 'db-1' }] }))
  assert.notEqual(first, undefined)
  const one = live.snapshot('s1')
  assert.equal(one.count, 2)
  assert.deepEqual(one.servers.map((entry) => entry.name), ['web-1', 'db-1'])
  assert.equal(one.servers.find((entry) => entry.name === 'web-1').count, 2)
  assert.equal(live.snapshot('s2').count, 1)
  live.end(third)
  assert.equal(live.snapshot('s1').count, 1)
  live.end(first)
  live.end(second)
  assert.deepEqual(live.snapshot('s1'), { count: 0, servers: [] })
  assert.deepEqual(live.snapshot('s2'), { count: 0, servers: [] })
})

test('a dispatch without a session or explicit server is ignored', () => {
  const live = createLiveExecutions()
  assert.equal(live.begin({ name: 'remote_bash', arguments: { server: 'web-1' } }), undefined)
  assert.equal(live.begin({ name: 'bash', arguments: { command: 'pwd' }, agent: { session: { id: 's1' } } }), undefined)
  assert.deepEqual(live.snapshot('s1'), { count: 0, servers: [] })
})
