import test from 'node:test'
import assert from 'node:assert/strict'

import { dialectFromProbe, parseFacts } from '../lib/core/ssh.js'
import { effectiveDialect, normalizeDialect } from '../lib/core/dialect.js'

test('dialectFromProbe recognizes both probe families', () => {
  assert.equal(dialectFromProbe('Linux\n', 0), 'posix')
  assert.equal(dialectFromProbe('Darwin\n', 0), 'posix')
  assert.equal(dialectFromProbe('FreeBSD\n', 0), 'posix')
  assert.equal(dialectFromProbe('Microsoft Windows [Version 10.0.26100.2314]\r\n', 0), 'windows')
  assert.equal(dialectFromProbe('uname: not found', 1), undefined)
  assert.equal(dialectFromProbe('', 0), undefined)
  assert.equal(dialectFromProbe('garbled', 0), undefined)
})

test('effectiveDialect prefers the probe result over the record hint', () => {
  assert.equal(effectiveDialect({ platform: 'posix' }), 'posix')
  assert.equal(effectiveDialect({ platform: 'windows' }), 'windows')
  assert.equal(effectiveDialect({ platform: 'win32' }), 'windows')
  assert.equal(effectiveDialect({ platform: 'posix', facts: { dialect: 'windows' } }), 'windows')
  assert.equal(effectiveDialect({ platform: 'windows', facts: { dialect: 'posix' } }), 'posix')
  assert.equal(effectiveDialect(undefined), 'posix')
})

test('normalizeDialect is total', () => {
  assert.equal(normalizeDialect('windows'), 'windows')
  assert.equal(normalizeDialect('win32'), 'windows')
  assert.equal(normalizeDialect('posix'), 'posix')
  assert.equal(normalizeDialect('anything'), 'posix')
})

test('parseFacts records the detected dialect in both fields', () => {
  const posix = parseFacts('__SDH_HOST__\nbox\n__SDH_OS__\nLinux 6.1\n')
  assert.equal(posix.dialect, 'posix')
  assert.equal(posix.platform, 'posix')
  const windows = parseFacts('__SDH_HOST__\nwinlab\n', 'windows')
  assert.equal(windows.dialect, 'windows')
  assert.equal(windows.platform, 'windows')
})
