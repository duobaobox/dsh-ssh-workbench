import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BASH_TOOL_NAME,
  applyWorkdir,
  createErrorResult,
  isTransportFailure,
  quotePosix,
  resolveTimeoutMs,
  toBashValue,
  wrapRemoteTimeout,
} from '../lib/core/remote-bash.js'

const CONFIG = { commandTimeoutMs: 120000, maxCommandTimeoutMs: 600000, timeoutKillAfterMs: 5000 }

test('BASH_TOOL_NAME still identifies the native tool name', () => {
  assert.equal(BASH_TOOL_NAME, 'bash')
})

test('quotePosix escapes single quotes', () => {
  assert.equal(quotePosix("it's"), "'it'\\''s'")
  assert.equal(quotePosix('/tmp/a b'), "'/tmp/a b'")
})

test('applyWorkdir anchors relative and home paths at the login home', () => {
  assert.deepEqual(applyWorkdir('df -h', ''), { command: 'df -h', cwd: '~' })
  assert.deepEqual(applyWorkdir('df -h', '~'), { command: 'cd -- "$HOME" && df -h', cwd: '~' })
  assert.deepEqual(applyWorkdir('df -h', '~/logs'), { command: `cd -- "$HOME"'/logs' && df -h`, cwd: '~/logs' })
  assert.deepEqual(applyWorkdir('df -h', '/var/log'), { command: "cd -- '/var/log' && df -h", cwd: '/var/log' })
  assert.deepEqual(applyWorkdir('df -h', 'logs'), { command: `cd -- "$HOME"/'logs' && df -h`, cwd: '~/logs' })
  assert.match(applyWorkdir('df -h', 'a\nb').error, /newlines/)
})

test('resolveTimeoutMs clamps the requested value', () => {
  assert.equal(resolveTimeoutMs({}, CONFIG), 120000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 10 }, CONFIG), 1000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 999999 }, CONFIG), 600000)
})

test('wrapRemoteTimeout uses the probed capability', () => {
  assert.equal(wrapRemoteTimeout('df -h', 3000, 'none'), 'df -h')
  assert.match(wrapRemoteTimeout('df -h', 3000, { mode: 'kill', shell: '/bin/bash' }), /^timeout -k 5 3 '\/bin\/bash' -c /)
  assert.match(wrapRemoteTimeout('df -h', 3000, { mode: 'basic', shell: '/bin/bash' }), /^timeout 3 '\/bin\/bash' -c /)
})

test('toBashValue maps the native shell result shape', () => {
  const value = toBashValue({ outcome: 'success', exitCode: 0, signal: null, stdout: 'ok', stderr: '', truncated: { stdout: true, stderr: false } }, { cwd: '~', timeoutMs: 1000 })
  assert.equal(value.kind, 'foreground')
  assert.equal(value.stdout.text, 'ok')
  assert.equal(value.stdout.truncated, true)
  assert.equal(value.timedOut, false)
})

test('isTransportFailure only treats the never-ran cases as transport errors', () => {
  assert.equal(isTransportFailure({ outcome: 'failed', exitCode: null }), true)
  assert.equal(isTransportFailure({ outcome: 'failed', exitCode: 2 }), false)
  assert.equal(isTransportFailure({ outcome: 'timeout', exitCode: null }), false)
  assert.equal(isTransportFailure(undefined), true)
})

test('createErrorResult is a structured tool error', () => {
  const result = createErrorResult('boom', 'SSH_FAILED')
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /SSH_FAILED: boom/)
  assert.equal(result.error.info.code, 'SSH_FAILED')
})
