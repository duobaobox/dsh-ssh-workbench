import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { workbenchDir } from '../lib/core/paths.js'

test('storage directory migrates from the pre-1.6.4 name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-home-'))
  const legacy = path.join(home, 'ssh-ops')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'servers.json'), '[]')
  const previousHome = process.env.DSH_HOME
  const previousDir = process.env.DSH_SSH_WORKBENCH_DIR
  delete process.env.DSH_SSH_WORKBENCH_DIR
  process.env.DSH_HOME = home
  try {
    const dir = workbenchDir()
    assert.equal(dir, path.join(home, 'ssh-workbench'))
    assert.ok(fs.existsSync(path.join(dir, 'servers.json')))
    assert.ok(!fs.existsSync(legacy))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDir === undefined) delete process.env.DSH_SSH_WORKBENCH_DIR
    else process.env.DSH_SSH_WORKBENCH_DIR = previousDir
    fs.rmSync(home, { recursive: true, force: true })
  }
})
