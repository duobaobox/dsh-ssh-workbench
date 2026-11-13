import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_PREFS, loadPrefs, resolveRemoteFileWrite, resolveSystemFileHierarchy, savePrefs } from '../lib/core/prefs.js'
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
  assert.equal(DEFAULT_PREFS.remoteFileWrite, null)
  assert.equal(DEFAULT_PREFS.systemFileHierarchy, null)

  const saved = savePrefs({ sidebar: false })
  assert.deepEqual(saved, { sidebar: false, remoteFileWrite: null, systemFileHierarchy: null })
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
  assert.deepEqual(loadPrefs(), { sidebar: true, remoteFileWrite: null, systemFileHierarchy: null })

  const saved = savePrefs({ sidebar: false, extra: 'ignored' })
  assert.deepEqual(saved, { sidebar: false, remoteFileWrite: null, systemFileHierarchy: null })
})

test('the write override is tri-state and falls back to the config', () => {
  isolatedDir()
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: false }, loadPrefs()), false)
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: true }, loadPrefs()), true)

  savePrefs({ remoteFileWrite: true })
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: false }, loadPrefs()), true)

  savePrefs({ remoteFileWrite: false })
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: true }, loadPrefs()), false)

  savePrefs({ remoteFileWrite: null })
  assert.equal(loadPrefs().remoteFileWrite, null)
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: true }, loadPrefs()), true)
  assert.equal(resolveRemoteFileWrite({ remoteFileWrite: false }, loadPrefs()), false)
})

test('the system file hierarchy override is tri-state and falls back to the config', () => {
  isolatedDir()
  assert.equal(resolveSystemFileHierarchy({ systemFileHierarchy: true }, loadPrefs()), true)
  assert.equal(resolveSystemFileHierarchy({ systemFileHierarchy: false }, loadPrefs()), false)

  savePrefs({ systemFileHierarchy: true })
  assert.equal(resolveSystemFileHierarchy({ systemFileHierarchy: false }, loadPrefs()), true)

  savePrefs({ systemFileHierarchy: false })
  assert.equal(resolveSystemFileHierarchy({ systemFileHierarchy: true }, loadPrefs()), false)

  savePrefs({ systemFileHierarchy: null })
  assert.equal(loadPrefs().systemFileHierarchy, null)
  assert.equal(resolveSystemFileHierarchy({ systemFileHierarchy: true }, loadPrefs()), true)
})
