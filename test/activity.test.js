import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createActivityStore, describeResultOutcome, MAX_ACTIVITY_ENTRIES } from '../lib/core/activity.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-activity-'))
  return path.join(dir, 'activity.json')
}

test('activity store appends newest-first and lists a bounded page', () => {
  const file = tempFile()
  const store = createActivityStore({ file })
  store.append({ kind: 'exec', server: 'web-1', summary: 'uptime', outcome: 'success' })
  store.append({ kind: 'exec', servers: ['web-1', 'web-2'], summary: 'df -h', outcome: '2/2 ok' })

  const rows = store.list()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'exec')
  assert.deepEqual(rows[0].servers, ['web-1', 'web-2'])
  assert.equal(rows[1].kind, 'exec')
  assert.equal(rows[1].server, 'web-1')
  assert.match(rows[1].at, /^\d{4}-\d{2}-\d{2}T/)

  const page = store.list(1)
  assert.equal(page.length, 1)
  assert.equal(page[0].kind, 'exec')

  // Entries are persisted in the private JSON file.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.length, 2)
})

test('activity store caps entries and tolerates a corrupt file', () => {
  const file = tempFile()
  const store = createActivityStore({ file, maxEntries: 3 })
  for (let index = 0; index < 6; index += 1) {
    store.append({ kind: 'exec', server: `web-${index}`, outcome: 'success' })
  }
  const rows = store.list(10)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].server, 'web-5')
  assert.equal(rows[2].server, 'web-3')

  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(store.list(), [])
  store.append({ kind: 'test', server: 'web-1', outcome: 'ok' })
  assert.equal(store.list().length, 1)
  assert.equal(MAX_ACTIVITY_ENTRIES, 200)
  assert.equal(store.clear(), true)
  assert.deepEqual(store.list(), [])
})

test('activity outcome distinguishes command exit codes from transport failures', () => {
  assert.equal(describeResultOutcome({ outcome: 'success', exitCode: 0 }), 'success')
  assert.equal(describeResultOutcome({ outcome: 'failed', exitCode: 1, errorCode: 'EXEC_FAILED' }), 'exit 1')
  assert.equal(describeResultOutcome({ outcome: 'failed', exitCode: 127, errorCode: 'COMMAND_NOT_FOUND' }), 'exit 127 (COMMAND_NOT_FOUND)')
  assert.equal(describeResultOutcome({ outcome: 'failed', exitCode: null, errorCode: 'CONNECT_TIMEOUT' }), 'failed (CONNECT_TIMEOUT)')
  assert.equal(describeResultOutcome({ outcome: 'timeout', exitCode: null, errorCode: 'TIMEOUT' }), 'timeout (TIMEOUT)')
  assert.equal(describeResultOutcome({ outcome: 'cancelled', exitCode: null, errorCode: 'CANCELLED' }), 'cancelled (CANCELLED)')
  assert.equal(describeResultOutcome({ outcome: 'failed' }), 'failed')
  assert.equal(describeResultOutcome(undefined), 'unknown')
})
