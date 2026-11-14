import test from 'node:test'
import assert from 'node:assert/strict'

import { createRemoteExecTool, REMOTE_EXEC_TOOL_NAME } from '../lib/core/remote-exec-tool.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, facts: { dialect: 'posix' } },
  { id: 'srv_2', name: 'winbox', host: '10.0.0.6', port: 2222, username: 'admin', platform: 'windows', enabled: true, facts: { dialect: 'windows' } },
  { id: 'srv_3', name: 'off', host: '10.0.0.7', port: 22, username: 'ops', platform: 'posix', enabled: false, facts: { dialect: 'posix' } },
]

const CONFIG = {
  commandTimeoutMs: 1500,
  maxCommandTimeoutMs: 5000,
  maxOutputBytes: 4096,
  maxStderrBytes: 1024,
  timeoutKillAfterMs: 5000,
  maxBatchTasks: 8,
  batchConcurrency: 4,
  maxBatchOutputBytes: 16384,
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeHarness({ exec } = {}) {
  const calls = []
  let active = 0
  let maxActive = 0
  const activities = []
  const runtime = {
    async timeoutGuard() {
      return { mode: 'kill', shell: '/bin/bash' }
    },
    async exec(server, command, options) {
      calls.push({ server, command, options })
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        if (exec) return await exec(server, command, options)
        await delay(server.name === 'web-1' ? 20 : 1)
        return {
          outcome: 'success',
          exitCode: 0,
          signal: null,
          stdout: `${server.name}:ok\n`,
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      } finally {
        active -= 1
      }
    },
  }
  const tool = createRemoteExecTool({
    runtime,
    config: CONFIG,
    loadInventory: () => SERVERS,
    recordActivity: (entry) => activities.push(entry),
  })
  return { tool, runtime, calls, activities, getMaxActive: () => maxActive }
}

test('remote_exec exposes array tasks and a concurrency hint', () => {
  const { tool } = makeHarness()
  assert.equal(tool.name, REMOTE_EXEC_TOOL_NAME)
  assert.deepEqual(Object.keys(tool.parameters), ['tasks', 'concurrency', 'probe', 'connectTimeoutMs'])
  assert.equal(tool.parameters.tasks.required, true)
  assert.equal(tool.parameters.tasks.items.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.tasks.items.properties), ['server', 'command', 'workdir', 'timeoutMs', 'run_in_background'])
  assert.equal(tool.parameters.tasks.items.properties.server.required, true)
  assert.equal(tool.parameters.tasks.items.properties.command.required, true)
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(tool.output.render({}, { text: 'hello' }), [{ type: 'text', text: 'hello' }])
})

test('each task runs on its own explicit server and results keep task order', async () => {
  const h = makeHarness()
  const result = await h.tool.execute({
    tasks: [
      { server: 'web-1', command: 'uname -s', workdir: '~' },
      { server: 'winbox', command: 'Get-Host', workdir: 'C:\\temp' },
    ],
    concurrency: 2,
  })
  assert.equal(h.calls.length, 2)
  const posix = h.calls.find((call) => call.server.name === 'web-1')
  const windows = h.calls.find((call) => call.server.name === 'winbox')
  assert.match(posix.command, /^timeout -k 5 1\.5 '\/bin\/bash' -c /)
  assert.match(posix.command, /cd -- "\$HOME" && uname -s/)
  assert.match(windows.command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /)
  assert.equal(posix.options.timeoutMs, 1500)
  assert.equal(windows.options.timeoutMs, 1500)
  assert.ok(result.text.indexOf('[1] web-1') >= 0)
  assert.ok(result.text.indexOf('[1] web-1') < result.text.indexOf('[2] winbox'))
  assert.match(result.text, /web-1:ok/)
  assert.match(result.text, /winbox:ok/)
  assert.equal(h.getMaxActive(), 2)
  assert.equal(h.activities.length, 2)
  assert.deepEqual(h.activities.map((entry) => entry.server).sort(), ['web-1', 'winbox'])
})

test('a bad task rejects the whole batch before any command starts', async () => {
  const h = makeHarness()
  await assert.rejects(
    () => h.tool.execute({
      tasks: [
        { server: 'web-1', command: 'uname -s' },
        { server: 'missing', command: 'uname -s' },
      ],
    }),
    /remote_exec validation failed:[\s\S]*unknown .*server "missing"/,
  )
  assert.equal(h.calls.length, 0)
  assert.equal(h.activities.length, 0)
})

test('remote_exec refuses local, disabled and empty tasks', async () => {
  const h = makeHarness()
  await assert.rejects(() => h.tool.execute({ tasks: [] }), /at least one task/)
  await assert.rejects(
    () => h.tool.execute({ tasks: [{ server: 'local', command: 'pwd' }] }),
    /not a remote resource/,
  )
  await assert.rejects(
    () => h.tool.execute({ tasks: [{ server: 'off', command: 'pwd' }] }),
    /server "off" is disabled/,
  )
  await assert.rejects(
    () => h.tool.execute({ tasks: [{ server: 'web-1', command: '   ' }] }),
    /command must not be empty/,
  )
  assert.equal(h.calls.length, 0)
})

test('one failed task does not discard the other task results', async () => {
  const h = makeHarness({
    exec: async (server) => {
      if (server.name === 'winbox') throw new Error('connection reset')
      return {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: 'linux\n',
        stderr: '',
        durationMs: 1,
        truncated: { stdout: false, stderr: false },
      }
    },
  })
  const result = await h.tool.execute({
    tasks: [
      { server: 'web-1', command: 'uname -s' },
      { server: 'winbox', command: 'Get-Host' },
    ],
  })
  assert.match(result.text, /\[1\] web-1[\s\S]*stdout:\nlinux/)
  assert.match(result.text, /\[2\] winbox[\s\S]*error: connection reset/)
})

test('activity records a per-task outcome', async () => {
  const h = makeHarness({
    exec: async () => ({
      outcome: 'failed',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: 'permission denied',
      errorCode: 'SSH_CHANNEL_FAILED',
      durationMs: 1,
      truncated: { stdout: false, stderr: false },
    }),
  })
  const result = await h.tool.execute({ tasks: [{ server: 'web-1', command: 'cat /root/secret' }] })
  assert.match(result.text, /SSH_CHANNEL_FAILED: permission denied/)
  assert.equal(h.activities.length, 1)
  assert.equal(h.activities[0].outcome, 'failed (SSH_CHANNEL_FAILED)')
})

test('probe:false skips dialect and timeout probes and passes the connection deadline', async () => {
  const h = makeHarness()
  let probes = 0
  h.runtime.probeDialect = async () => { probes += 1; return 'posix' }
  h.runtime.timeoutGuard = async () => { probes += 1; return 'kill' }
  const result = await h.tool.execute({
    tasks: [{ server: 'web-1', command: 'uname -s' }],
    probe: false,
    connectTimeoutMs: 4000,
  })
  assert.equal(probes, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].options.connectTimeoutMs, 4000)
  assert.doesNotMatch(h.calls[0].command, /^timeout /)
  assert.match(result.text, /web-1:ok/)
})

test('the requested concurrency is capped by the configured batch limit', async () => {
  const h = makeHarness()
  const result = await h.tool.execute({
    tasks: [
      { server: 'web-1', command: 'uname -s' },
      { server: 'web-1', command: 'id' },
      { server: 'winbox', command: 'Get-Host' },
      { server: 'winbox', command: 'Get-Date' },
    ],
    concurrency: 8,
  })
  assert.match(result.text, /concurrency 4/)
  assert.ok(h.getMaxActive() <= 4)
})

test('a large task output is truncated at the plugin cap and says so', async () => {
  const h = makeHarness({
    exec: async () => ({
      outcome: 'success',
      exitCode: 0,
      signal: null,
      stdout: `${'x'.repeat(20000)}\n`,
      stderr: '',
      durationMs: 1,
      truncated: { stdout: false, stderr: false },
    }),
  })
  // The tool is constructed with maxBatchOutputBytes 16384.
  const result = await h.tool.execute({ tasks: [{ server: 'web-1', command: 'cat big.log' }] })
  assert.match(result.text, /\[stdout truncated by the plugin output cap\]/)
  assert.equal(result.text.length <= 16384 + 120, true)
})

test('remote_exec starts a background task and reports the pid and log', async () => {
  const h = makeHarness({
    exec: async () => ({
      outcome: 'success',
      exitCode: 0,
      signal: null,
      stdout: '__SDH_BG_PID__4242\n__SDH_BG_LOG__/home/demo/.dsh/ssh-workbench/logs/bg.A1\n',
      stderr: '',
      durationMs: 1,
      truncated: { stdout: false, stderr: false },
    }),
  })
  const result = await h.tool.execute({
    tasks: [{ server: 'web-1', command: 'sleep 99', run_in_background: true }],
  })
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].command, /^sh -c /)
  assert.doesNotMatch(h.calls[0].command, /^timeout /)
  assert.match(result.text, /background: started/)
  assert.match(result.text, /pid: 4242/)
  assert.match(result.text, /read output: tail -f/)
  assert.match(result.text, /timeoutMs does not apply/)
  assert.equal(h.activities[0].outcome, 'success')
})

test('remote_exec reports a background task that never started', async () => {
  const h = makeHarness({
    exec: async () => ({
      outcome: 'success',
      exitCode: 0,
      signal: null,
      stdout: 'nohup: not found\n',
      stderr: '',
      durationMs: 1,
      truncated: { stdout: false, stderr: false },
    }),
  })
  const result = await h.tool.execute({
    tasks: [{ server: 'web-1', command: 'sleep 99', run_in_background: true }],
  })
  assert.match(result.text, /error: background start failed: nohup: not found/)
  assert.equal(h.activities[0].outcome, 'failed')
})
