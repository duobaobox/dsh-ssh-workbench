import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeExecution } from '../lib/core/target-stats.js'

function entry(overrides) {
  return {
    at: '2026-11-10T08:00:00.000Z',
    kind: 'exec',
    server: 'web-1',
    outcome: 'success',
    sessionId: 's1',
    durationMs: 100,
    ...overrides,
  }
}

test('target stats only count this session and execution entries', () => {
  const summary = summarizeExecution([
    entry({ at: '2026-11-10T08:00:03.000Z', server: 'db-1', durationMs: 250 }),
    entry({ at: '2026-11-10T08:00:02.000Z', server: 'web-1', outcome: 'failed', durationMs: 100 }),
    entry({ sessionId: 'other', durationMs: 900 }),
    entry({ kind: 'file-write', durationMs: 700 }),
    entry({ sessionId: undefined, durationMs: 500 }),
  ], { sessionId: 's1', candidates: ['web-1', 'db-1'] })

  assert.equal(summary.sessionId, 's1')
  assert.equal(summary.count, 2)
  assert.equal(summary.success, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.durationMs, 350)
  assert.equal(summary.averageMs, 175)
  assert.equal(summary.lastAt, '2026-11-10T08:00:03.000Z')
  assert.deepEqual(summary.servers.map((bucket) => bucket.name), ['web-1', 'db-1'])
  assert.deepEqual(summary.servers[0], {
    name: 'web-1',
    count: 1,
    success: 0,
    failed: 1,
    durationMs: 100,
    averageMs: 100,
    lastAt: '2026-11-10T08:00:02.000Z',
  })
})

test('target stats keep mention order and include explicit targets', () => {
  const summary = summarizeExecution([
    entry({ server: 'extra-1', durationMs: 10 }),
    entry({ server: 'web-1', durationMs: 20 }),
  ], { sessionId: 's1', candidates: ['db-1', 'web-1'] })

  assert.deepEqual(summary.servers.map((bucket) => bucket.name), ['db-1', 'web-1', 'extra-1'])
  assert.equal(summary.servers[0].count, 0)
  assert.equal(summary.servers[0].averageMs, 0)
  assert.equal(summary.servers[2].count, 1)
})

test('target stats return a safe empty summary for missing input', () => {
  assert.deepEqual(summarizeExecution(undefined), {
    sessionId: null,
    count: 0,
    success: 0,
    failed: 0,
    durationMs: 0,
    averageMs: 0,
    lastAt: null,
    servers: [],
  })
  assert.equal(summarizeExecution([entry()], { sessionId: '' }).count, 0)
  // Old entries without a duration still count, but contribute zero latency.
  const legacy = summarizeExecution([{ at: '2026-11-10T08:00:00.000Z', kind: 'exec', server: 'web-1', outcome: 'success', sessionId: 's1' }], { sessionId: 's1' })
  assert.equal(legacy.count, 1)
  assert.equal(legacy.durationMs, 0)
})
