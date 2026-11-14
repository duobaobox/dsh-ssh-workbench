import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPosixBackgroundCommand,
  parseBackgroundStart,
  renderBackgroundStart,
} from '../lib/core/background.js'

test('parseBackgroundStart reads markers through shell profile noise', () => {
  const started = parseBackgroundStart(
    'Last login: today\n__SDH_BG_PID__4242\n__SDH_BG_LOG__/tmp/dsh-ssh-workbench-bg.A1B2C3\n__SDH_BG_ERR__C:\\Temp\\err.log\n',
  )
  assert.deepEqual(started, { pid: 4242, log: '/tmp/dsh-ssh-workbench-bg.A1B2C3', errLog: 'C:\\Temp\\err.log' })
})

test('parseBackgroundStart reports a launcher that failed before starting', () => {
  assert.deepEqual(parseBackgroundStart('nohup: not found\n'), { pid: undefined, log: undefined, errLog: undefined })
  assert.deepEqual(parseBackgroundStart(''), { pid: undefined, log: undefined, errLog: undefined })
})

test('buildPosixBackgroundCommand detaches through sh -c + nohup and prints markers', () => {
  const command = buildPosixBackgroundCommand("cd -- '/srv/app' && npm run dev")
  assert.match(command, /^sh -c '/)
  assert.match(command, /LOG_DIR=\$\{DSH_SSH_WORKBENCH_LOG_DIR:-\$HOME\/\.dsh\/ssh-workbench\/logs\}/)
  assert.match(command, /mkdir -p "\$LOG_DIR" 2>\/dev\/null \|\| LOG_DIR=\/tmp/)
  assert.match(command, /mktemp "\$LOG_DIR\/dsh-ssh-workbench-bg\.XXXXXX"/)
  assert.match(command, /nohup "\$\{SHELL:-\/bin\/sh\}" -lc/)
  assert.match(command, /__SDH_BG_PID__\$!/)
  assert.match(command, /__SDH_BG_LOG__\$LOG/)
  // The cd-prefixed command is inside the outer sh -c payload.
  assert.match(command, /cd -- /)
  assert.match(command, /\/srv\/app/)
  assert.match(command, /npm run dev/)
})

test('renderBackgroundStart gives dialect-appropriate read/stop hints', () => {
  const posix = renderBackgroundStart({
    pid: 11,
    log: '/tmp/a.log',
    target: 'web-1 (root@10.0.0.5:22)',
    command: 'sleep 99',
    dialect: 'posix',
  })
  assert.match(posix, /background: started on web-1/)
  assert.match(posix, /pid: 11/)
  assert.match(posix, /read output: tail -f '\/tmp\/a\.log'/)
  assert.match(posix, /stop: kill 11/)
  assert.match(posix, /timeoutMs does not apply/)

  const windows = renderBackgroundStart({
    pid: 22,
    log: "C:\\Temp\\it's.log",
    errLog: 'C:\\Temp\\err.log',
    command: 'Start-Sleep 99',
    dialect: 'windows',
  })
  assert.match(windows, /read output: Get-Content -LiteralPath 'C:\\Temp\\it''s\.log' -Wait/)
  assert.match(windows, /stop: Stop-Process -Id 22 -Force/)
  assert.match(windows, /stderr log: C:\\Temp\\err\.log/)
})
