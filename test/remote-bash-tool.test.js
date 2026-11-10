import test from 'node:test'
import assert from 'node:assert/strict'

import { createRemoteShellTool, renderRemoteResult, resolveExplicitTarget } from '../lib/core/remote-bash-tool.js'
import { posixAdapter } from '../lib/core/shell-adapters.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, facts: {} },
  { id: 'srv_2', name: 'winbox', host: '10.0.0.6', port: 2222, username: 'admin', platform: 'windows', enabled: true, facts: {} },
  { id: 'srv_3', name: 'off', host: '10.0.0.7', port: 22, username: 'ops', platform: 'posix', enabled: false, facts: {} },
]

const CONFIG = {
  commandTimeoutMs: 1500,
  maxCommandTimeoutMs: 5000,
  maxOutputBytes: 4096,
  maxStderrBytes: 1024,
  timeoutKillAfterMs: 5000,
}

function makeRuntime(overrides = {}) {
  const execCalls = []
  const runtime = {
    async timeoutGuard() {
      return 'none'
    },
    async exec(server, command, options) {
      execCalls.push({ server, command, options })
      return {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: 'ok\n',
        stderr: '',
        durationMs: 1,
        truncated: { stdout: false, stderr: false },
      }
    },
    ...overrides,
  }
  return { runtime, execCalls }
}

function makeHarness({ runtime, servers = SERVERS } = {}) {
  const { runtime: rt, execCalls } = makeRuntime(runtime ?? {})
  const activities = []
  const tool = createRemoteShellTool({
    runtime: rt,
    config: CONFIG,
    loadInventory: () => servers,
    recordActivity: (entry) => activities.push(entry),
  })
  const exec = (sessionId = 's1') => ({ agent: { session: { id: sessionId } }, signal: { aborted: false } })
  return { tool, execCalls, activities, exec }
}

test('remote_bash is an explicit-target tool with command/workdir/timeout parameters', () => {
  const h = makeHarness()
  assert.equal(h.tool.name, 'remote_bash')
  assert.deepEqual(Object.keys(h.tool.parameters), ['server', 'command', 'workdir', 'timeoutMs', 'run_in_background'])
  assert.equal(h.tool.parameters.server.required, true)
  assert.equal(h.tool.parameters.command.required, true)
  const rendered = h.tool.output.render({}, { text: 'hello' })
  assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }])
})

test('without a server the tool fails and never touches the runtime', async () => {
  const h = makeHarness()
  await assert.rejects(() => h.tool.execute({ command: 'df -h' }, h.exec()), /server is required/)
  assert.equal(h.execCalls.length, 0)
})

test('a POSIX server runs over SSH and returns server/cwd/exit/stdout', async () => {
  const h = makeHarness()
  const result = await h.tool.execute({ server: 'web-1', command: 'df -h', workdir: '~' }, h.exec())
  assert.equal(h.execCalls.length, 1)
  assert.equal(h.execCalls[0].server.name, 'web-1')
  assert.equal(h.execCalls[0].command, 'cd -- "$HOME" && df -h')
  assert.equal(h.execCalls[0].options.timeoutMs, CONFIG.commandTimeoutMs)
  assert.equal(h.execCalls[0].options.readOnly, false)
  assert.match(result.text, /target: web-1 \(root@10\.0\.0\.5:22\)/)
  assert.match(result.text, /command: df -h/)
  assert.match(result.text, /cwd: ~/)
  assert.match(result.text, /exit code: 0/)
  assert.match(result.text, /stdout:\nok/)
  assert.doesNotMatch(result.text, /\[remote\] target:/)
  assert.equal(h.activities.length, 1)
  assert.equal(h.activities[0].server, 'web-1')
  assert.equal(h.activities[0].sessionId, 's1')
  assert.equal(typeof h.activities[0].durationMs, 'number')
})

test('remote_bash run_in_background returns pid + log and does not wait', async () => {
  const calls = []
  const h = makeHarness({
    runtime: {
      async exec(server, command, options) {
        calls.push({ server, command, options })
        return {
          outcome: 'success',
          exitCode: 0,
          signal: null,
          stdout: '__SDH_BG_PID__777\n__SDH_BG_LOG__/tmp/sdh-bg.log\n',
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      },
    },
  })
  const result = await h.tool.execute({ server: 'web-1', command: 'sleep 60', run_in_background: true }, h.exec())
  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /nohup/)
  assert.match(result.text, /pid: 777/)
  assert.match(result.text, /tail -f '\/tmp\/sdh-bg\.log'/)
  assert.match(result.text, /stop: kill 777/)
})

test('a non-zero exit is a normal result, not an error', async () => {
  const h = makeHarness({
    runtime: {
      async timeoutGuard() {
        return 'none'
      },
      async exec() {
        return {
          outcome: 'failed',
          exitCode: 2,
          signal: null,
          stdout: '',
          stderr: 'boom\n',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      },
    },
  })
  const result = await h.tool.execute({ server: 'web-1', command: 'false' }, h.exec())
  assert.match(result.text, /exit code: 2/)
  assert.match(result.text, /stderr:\nboom/)
})

test('a Windows server is rejected with a dialect explanation', async () => {
  const h = makeHarness()
  await assert.rejects(() => h.tool.execute({ server: 'winbox', command: 'Get-Location' }, h.exec()), /Windows server.*POSIX/)
  assert.equal(h.execCalls.length, 0)
})

test('disabled and unknown servers and invalid workdirs fail before SSH', async () => {
  const h = makeHarness()
  await assert.rejects(() => h.tool.execute({ server: 'off', command: 'df -h' }, h.exec()), /disabled/)
  await assert.rejects(() => h.tool.execute({ server: 'nope', command: 'df -h' }, h.exec()), /unknown/)
  await assert.rejects(() => h.tool.execute({ server: 'web-1', command: 'df -h', workdir: 'a\nb' }, h.exec()), /newlines/)
  assert.equal(h.execCalls.length, 0)
})

test('the remote timeout wrapper uses the probed capability', async () => {
  const h = makeHarness({
    runtime: {
      async timeoutGuard() {
        return 'kill'
      },
      async exec(server, command) {
        h.execCalls.push({ server, command, options: {} })
        return {
          outcome: 'timeout',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      },
    },
  })
  const result = await h.tool.execute({ server: 'web-1', command: 'sleep 99', timeoutMs: 3000 }, h.exec())
  assert.match(h.execCalls[0].command, /^timeout -k 5 3 /)
  assert.match(result.text, /outcome: timed out/)
  assert.match(result.text, /\[remote\] timeout/)
})

test('a transport failure becomes a tool error with the SSH detail', async () => {
  const h = makeHarness({
    runtime: {
      async timeoutGuard() {
        return 'none'
      },
      async exec() {
        return {
          outcome: 'failed',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
          errorCode: 'SSH_CONNECT_FAILED',
          suggestedAction: 'check the network',
        }
      },
    },
  })
  await assert.rejects(() => h.tool.execute({ server: 'web-1', command: 'df -h' }, h.exec()), /SSH_CONNECT_FAILED.*check the network/s)
})

test('resolveExplicitTarget rejects Windows targets for the POSIX adapter', async () => {
  await assert.rejects(
    () =>
      resolveExplicitTarget({
        exec: { agent: { session: { id: 's1' } } },
        loadInventory: () => SERVERS,
        adapter: posixAdapter,
        runtime: {},
        serverRef: 'winbox',
      }),
    /Windows server/,
  )
})

test('renderRemoteResult marks truncation and empty stdout explicitly', () => {
  const text = renderRemoteResult({
    server: SERVERS[0],
    command: 'cat big',
    cwd: '/tmp',
    result: { exitCode: 0, stdout: '', stderr: '', truncated: { stdout: true, stderr: false }, outcome: 'success' },
    notices: ['[remote] note'],
  }).text
  assert.match(text, /stdout:\n\(empty\)/)
  assert.match(text, /\[stdout truncated/)
  assert.match(text, /\[remote\] note/)
})
