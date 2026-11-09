import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../lib/core/prefs.js'
import { prefsPath } from '../lib/core/paths.js'

function isolatedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-prefs-'))
  process.env.DSH_SSH_WORKBENCH_DIR = dir
  return dir
}

test('preferences default to an enabled sidebar and persist atomically', () => {
  const dir = isolatedDir()
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS)
  assert.equal(DEFAULT_PREFS.sidebar, true)

  const saved = savePrefs({ sidebar: false })
  assert.deepEqual(saved, { sidebar: false })
  assert.equal(loadPrefs().sidebar, false)

  const stat = fs.statSync(prefsPath())
  assert.equal(stat.mode & 0o777, 0o600)
  assert.match(fs.readFileSync(prefsPath(), 'utf8'), /"sidebar": false/)
  assert.ok(fs.existsSync(dir))
})

test('a corrupt preferences file falls back to defaults and is overwritten', () => {
  isolatedDir()
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true })
  fs.writeFileSync(prefsPath(), '{not json')
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS)

  savePrefs({ sidebar: true })
  assert.equal(loadPrefs().sidebar, true)
})

test('unknown fields and non-boolean values are ignored', () => {
  isolatedDir()
  fs.mkdirSync(path.dirname(prefsPath()), { recursive: true })
  fs.writeFileSync(prefsPath(), JSON.stringify({ sidebar: 'yes', extra: 1 }))
  assert.deepEqual(loadPrefs(), { sidebar: true })

  const saved = savePrefs({ sidebar: false, extra: 'ignored' })
  assert.deepEqual(saved, { sidebar: false })
})
