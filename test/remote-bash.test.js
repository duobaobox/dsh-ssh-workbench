import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyWorkdir,
  createErrorResult,
  createRemoteBashRouter,
  isTransportFailure,
  quotePosix,
  resolveTimeoutMs,
  toBashValue,
  wrapRemoteTimeout,
} from '../lib/core/remote-bash.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true },
  { id: 'srv_2', name: 'off-1', host: '10.0.0.6', port: 22, username: 'root', platform: 'posix', enabled: false },
  { id: 'srv_3', name: 'win-1', host: '10.0.0.7', port: 22, username: 'admin', platform: 'windows', enabled: true },
]

const CONFIG = { commandTimeoutMs: 120000, maxCommandTimeoutMs: 600000, maxOutputBytes: 102400 }

function okResult(overrides = {}) {
  return {
    outcome: 'success',
    exitCode: 0,
    signal: null,
    stdout: 'ok',
    stderr: '',
    durationMs: 3,
    truncated: { stdout: false, stderr: false },
    ...overrides,
  }
}

function makeRouter({ targets, exec, servers = SERVERS, config = CONFIG, timeoutGuard } = {}) {
  const calls = []
  const activities = []
  const runtime = {
    async exec(server, command, options) {
      calls.push({ server, command, options })
      return typeof exec === 'function' ? exec(server, command, options) : okResult()
    },
    ...(timeoutGuard === undefined
      ? {}
      : {
          async timeoutGuard(server) {
            return typeof timeoutGuard === 'function' ? timeoutGuard(server) : timeoutGuard
          },
        }),
  }
  const router = createRemoteBashRouter({
    runtime,
    targets: targets ?? { get: () => ({ active: 'web-1' }) },
    config,
    loadInventory: () => servers,
    recordActivity: (entry) => activities.push(entry),
  })
  return { router, calls, activities }
}

function agentFor(sessionId = 's1') {
  return { session: { id: sessionId } }
}

test('quotePosix escapes embedded single quotes', () => {
  assert.equal(quotePosix("/tmp/a b"), "'/tmp/a b'")
  assert.equal(quotePosix("/tmp/it's"), `'/tmp/it'\\''s'`)
})

test('wrapRemoteTimeout gives the remote side the same deadline', () => {
  assert.equal(
    wrapRemoteTimeout('df -h', 120000, { mode: 'kill', shell: '/bin/bash' }),
    `timeout -k 5 120 ${quotePosix('/bin/bash')} -c ${quotePosix('df -h')}`,
  )
  assert.equal(
    wrapRemoteTimeout("echo 'hi'", 1500, { mode: 'basic', shell: '/bin/sh' }),
    `timeout 1.5 ${quotePosix('/bin/sh')} -c ${quotePosix("echo 'hi'")}`,
  )
  // The kill-after grace is configurable; 0 falls back to a TERM-only wrapper.
  assert.equal(
    wrapRemoteTimeout('df -h', 3000, 'kill', { killAfterMs: 2000 }),
    `timeout -k 2 3 ${quotePosix('/bin/sh')} -c ${quotePosix('df -h')}`,
  )
  assert.equal(
    wrapRemoteTimeout('df -h', 1000, 'kill', { killAfterMs: 0 }),
    `timeout 1 ${quotePosix('/bin/sh')} -c ${quotePosix('df -h')}`,
  )
  // Non-absolute shell paths fall back to /bin/sh instead of being injected.
  assert.equal(
    wrapRemoteTimeout('df -h', 1000, { mode: 'kill', shell: 'bash' }),
    `timeout -k 5 1 ${quotePosix('/bin/sh')} -c ${quotePosix('df -h')}`,
  )
  assert.equal(wrapRemoteTimeout('df -h', 1000, 'none'), 'df -h')
  assert.equal(wrapRemoteTimeout('df -h', 1000, undefined), 'df -h')
  // A malformed capability must never wrap the command.
  assert.equal(wrapRemoteTimeout('df -h', 1000, true), 'df -h')
  assert.equal(wrapRemoteTimeout('df -h', 1000, { mode: 'weird' }), 'df -h')
})

test('applyWorkdir anchors absolute, home and relative paths', () => {
  assert.deepEqual(applyWorkdir('df -h', undefined), { command: 'df -h', cwd: '~' })
  assert.deepEqual(applyWorkdir('df -h', '/var/log'), { command: "cd -- '/var/log' && df -h", cwd: '/var/log' })
  assert.deepEqual(applyWorkdir('df -h', '~'), { command: 'cd -- "$HOME" && df -h', cwd: '~' })
  assert.deepEqual(applyWorkdir('df -h', '~/logs'), { command: 'cd -- "$HOME"\'/logs\' && df -h', cwd: '~/logs' })
  assert.deepEqual(applyWorkdir('df -h', 'logs'), { command: 'cd -- "$HOME"/\'logs\' && df -h', cwd: '~/logs' })
  assert.match(applyWorkdir('df -h', 'a\nb').error, /newlines/)
  assert.match(applyWorkdir('df -h', '~/../x').command, /\$HOME/)
})

test('resolveTimeoutMs clamps to the configured ceiling', () => {
  assert.equal(resolveTimeoutMs({}, CONFIG), 120000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 5000 }, CONFIG), 5000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 1 }, CONFIG), 1000)
  assert.equal(resolveTimeoutMs({ timeoutMs: 10_000_000 }, CONFIG), 600000)
})

test('toBashValue maps a normal command result onto the native foreground value', () => {
  const value = toBashValue(
    okResult({ stdout: 'hi', stderr: 'warn', truncated: { stdout: true, stderr: false } }),
    { cwd: '/var/log', timeoutMs: 5000 },
  )
  assert.deepEqual(value, {
    kind: 'foreground',
    cwd: '/var/log',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 5000,
    stdout: { text: 'hi', truncated: true },
    stderr: { text: 'warn', truncated: false },
  })
})

test('toBashValue matches the native foreground contract exactly', () => {
  // Mirrors the foreground branch of the built-in bash output schema
  // (additionalProperties:false): an extra or missing key would fail schema
  // validation inside the tool pipeline.
  const value = toBashValue(okResult(), { cwd: '~', timeoutMs: 120000 })
  assert.deepEqual(Object.keys(value).sort(), [
    'aborted',
    'cwd',
    'exitCode',
    'kind',
    'signal',
    'stderr',
    'stdout',
    'timedOut',
    'timeoutMs',
  ])
  assert.deepEqual(Object.keys(value.stdout).sort(), ['text', 'truncated'])
  assert.deepEqual(Object.keys(value.stderr).sort(), ['text', 'truncated'])
  assert.equal(typeof value.cwd, 'string')
  assert.equal(typeof value.timeoutMs, 'number')
  assert.equal(typeof value.timedOut, 'boolean')
  assert.equal(typeof value.aborted, 'boolean')
})

test('toBashValue keeps a non-zero exit as a normal result', () => {
  const value = toBashValue(okResult({ outcome: 'failed', exitCode: 2, stderr: 'boom' }), { cwd: '~', timeoutMs: 1000 })
  assert.equal(value.exitCode, 2)
  assert.equal(value.timedOut, false)
  assert.equal(isTransportFailure(okResult({ outcome: 'failed', exitCode: 2 })), false)
})

test('toBashValue marks timeout, abort and signal outcomes', () => {
  assert.equal(toBashValue(okResult({ outcome: 'timeout', exitCode: null }), { cwd: '~', timeoutMs: 1 }).timedOut, true)
  assert.equal(toBashValue(okResult({ outcome: 'cancelled', exitCode: null }), { cwd: '~', timeoutMs: 1 }).aborted, true)
  const killed = toBashValue(okResult({ outcome: 'failed', exitCode: null, signal: 'SIGKILL' }), { cwd: '~', timeoutMs: 1 })
  assert.equal(killed.signal, 'SIGKILL')
  assert.equal(isTransportFailure(okResult({ outcome: 'failed', exitCode: null, signal: 'SIGKILL' })), false)
})

test('isTransportFailure only covers "the command never ran"', () => {
  assert.equal(isTransportFailure(okResult({ outcome: 'failed', exitCode: null, errorCode: 'AUTH_FAILED' })), true)
  assert.equal(isTransportFailure(okResult({ outcome: 'timeout', exitCode: null })), false)
  assert.equal(isTransportFailure(okResult({ outcome: 'cancelled', exitCode: null })), false)
  assert.equal(isTransportFailure(okResult()), false)
})

test('createErrorResult is a structured tool error', () => {
  const result = createErrorResult('nope', 'AUTH_FAILED')
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /AUTH_FAILED/)
  assert.equal(result.error.info.code, 'AUTH_FAILED')
})

test('router leaves every other tool and every local session untouched', async () => {
  const { router, calls } = makeRouter()
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return { value: 'native' }
  }
  assert.deepEqual(await router({ name: 'read', agent: agentFor() }, next), { value: 'native' })
  assert.deepEqual(await router({ name: 'bash', agent: { session: { id: 'other' } } }, next), { value: 'native' })
  assert.deepEqual(await router({ name: 'bash' }, next), { value: 'native' })
  const localTargets = { get: () => ({ active: null }) }
  const local = makeRouter({ targets: localTargets })
  assert.deepEqual(await local.router({ name: 'bash', agent: agentFor() }, next), { value: 'native' })
  assert.equal(nextCalls, 4)
  assert.equal(calls.length, 0)
})

test('router runs bash on the active server and returns the native value', async () => {
  const { router, calls, activities } = makeRouter()
  const signal = { aborted: false }
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor(), signal },
    async () => ({ value: 'native' }),
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].server.name, 'web-1')
  assert.equal(calls[0].command, 'df -h')
  assert.equal(calls[0].options.timeoutMs, 120000)
  assert.equal(calls[0].options.signal, signal)
  assert.equal(result.value.kind, 'foreground')
  assert.equal(result.value.stdout.text, 'ok')
  assert.equal(activities.length, 1)
  assert.equal(activities[0].server, 'web-1')
})

test('router applies workdir and reports the matching cwd label', async () => {
  const { router, calls } = makeRouter()
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h', workdir: '/var/log' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(calls[0].command, "cd -- '/var/log' && df -h")
  assert.equal(result.value.cwd, 'web-1:/var/log')
})

test('router wraps the remote command with the timeout guard when available', async () => {
  const capability = { mode: 'kill', shell: '/bin/bash' }
  const guarded = makeRouter({ timeoutGuard: () => capability })
  await guarded.router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(guarded.calls.length, 1)
  assert.equal(guarded.calls[0].command, wrapRemoteTimeout('df -h', 120000, capability))
  assert.equal(guarded.calls[0].options.timeoutMs, 120000)

  const basic = makeRouter({ timeoutGuard: () => ({ mode: 'basic', shell: '/bin/sh' }) })
  await basic.router(
    { name: 'bash', arguments: { command: 'df -h', timeoutMs: 3000 }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(basic.calls[0].command, wrapRemoteTimeout('df -h', 3000, { mode: 'basic', shell: '/bin/sh' }))

  // A failed capability probe must never break the call: fall back to the raw command.
  const broken = makeRouter({
    timeoutGuard: () => {
      throw new Error('probe failed')
    },
  })
  const result = await broken.router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(broken.calls[0].command, 'df -h')
  assert.equal(result.value.kind, 'foreground')
})

test('router refuses to guess when several servers were mentioned', async () => {
  const ambiguous = makeRouter({ targets: { get: () => ({ active: null, candidates: ['web-1', 'db-1'] }) } })
  const result = await ambiguous.router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'TARGET_NOT_SELECTED')
  assert.match(result.content[0].text, /ssh_workbench_target/)
  assert.equal(ambiguous.calls.length, 0)

  // Once a target is chosen the router runs remotely again.
  const chosen = makeRouter({ targets: { get: () => ({ active: 'web-1', candidates: ['web-1', 'off-1'] }) } })
  await chosen.router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(chosen.calls.length, 1)

  // A plain local session (no candidates) still falls through untouched.
  const local = makeRouter({ targets: { get: () => ({ active: null, candidates: [] }) } })
  let nextCalls = 0
  await local.router({ name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() }, async () => {
    nextCalls += 1
    return { value: 'native' }
  })
  assert.equal(nextCalls, 1)
})

test('router explains the remote fate of a timed-out command', async () => {
  const timeoutResult = async () => okResult({ outcome: 'timeout', exitCode: null, stdout: 'partial' })
  const guarded = await makeRouter({ timeoutGuard: () => ({ mode: 'kill', shell: '/bin/bash' }), exec: timeoutResult }).router(
    { name: 'bash', arguments: { command: 'sleep 100', timeoutMs: 5000 }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(guarded.value.timedOut, true)
  assert.match(guarded.value.stderr.text, /remote command group was terminated \(SIGTERM, KILL after the remote deadline\)/)

  const noGuard = await makeRouter({ timeoutGuard: () => ({ mode: 'none', shell: '/bin/sh' }), exec: timeoutResult }).router(
    { name: 'bash', arguments: { command: 'sleep 100', timeoutMs: 5000 }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(noGuard.value.timedOut, true)
  assert.match(noGuard.value.stderr.text, /may still be running/)
})

test('router starts a detached remote command and reports pid + log', async () => {
  const startResult = () => okResult({ stdout: '__SDH_BG_PID__4242\n__SDH_BG_LOG__/tmp/sdh-bg.log\n' })
  const { router, calls } = makeRouter({ exec: startResult })
  const started = await router(
    { name: 'bash', arguments: { command: 'sleep 100', run_in_background: true }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /^sh -c '/)
  assert.match(calls[0].command, /nohup/)
  assert.match(calls[0].command, /__SDH_BG_PID__/)
  assert.equal(started.value.kind, 'foreground')
  assert.match(started.value.stdout.text, /pid: 4242/)
  assert.match(started.value.stdout.text, /\/tmp\/sdh-bg\.log/)
  assert.match(started.value.stdout.text, /tail -f/)
})

test('router reports a background launcher that never produced a pid', async () => {
  const { router } = makeRouter({ exec: () => okResult({ stdout: 'nohup: not found\n' }) })
  const failed = await router(
    { name: 'bash', arguments: { command: 'sleep 100', run_in_background: true }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(failed.isError, true)
  assert.equal(failed.error.info.code, 'REMOTE_BACKGROUND_FAILED')
  assert.match(failed.content[0].text, /never produced|nohup: not found/)
})

test('router refuses unsupported targets', async () => {
  const missing = await makeRouter({ targets: { get: () => ({ active: 'gone' }) } }).router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(missing.error.info.code, 'TARGET_NOT_FOUND')

  const disabled = await makeRouter({ targets: { get: () => ({ active: 'off-1' }) } }).router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(disabled.error.info.code, 'TARGET_DISABLED')

  const windows = await makeRouter({ targets: { get: () => ({ active: 'win-1' }) } }).router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(windows.error.info.code, 'TARGET_PLATFORM_UNSUPPORTED')
})

test('router maps transport failures to a structured error', async () => {
  const { router } = makeRouter({
    exec: async () =>
      okResult({
        outcome: 'failed',
        exitCode: null,
        stderr: 'authentication failed',
        errorCode: 'AUTH_FAILED',
        suggestedAction: 'check the key',
      }),
  })
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'AUTH_FAILED')
  assert.match(result.content[0].text, /authentication failed/)
  assert.match(result.content[0].text, /check the key/)
})

test('router maps timeout and cancellation to native flags', async () => {
  const timed = await makeRouter({
    exec: async () => okResult({ outcome: 'timeout', exitCode: null, stdout: 'partial', stderr: 'timed out' }),
  }).router(
    { name: 'bash', arguments: { command: 'sleep 100', timeoutMs: 5000 }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(timed.value.timedOut, true)
  assert.equal(timed.value.timeoutMs, 5000)
  assert.equal(timed.value.stdout.text, 'partial')

  const cancelled = await makeRouter({
    exec: async () => okResult({ outcome: 'cancelled', exitCode: null }),
  }).router(
    { name: 'bash', arguments: { command: 'sleep 100' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(cancelled.value.aborted, true)
})

test('router notes that sandbox escalation does not apply remotely', async () => {
  const { router } = makeRouter()
  const result = await router(
    {
      name: 'bash',
      arguments: { command: 'systemctl restart nginx', sandbox_permissions: 'danger-full-access', justification: 'ops' },
      agent: agentFor(),
    },
    async () => ({ value: 'native' }),
  )
  assert.match(result.value.stderr.text, /sandbox_permissions does not apply/)
})

test('router explains that a cancelled command may still run remotely', async () => {
  const cancelledResult = async () => okResult({ outcome: 'cancelled', exitCode: null })
  const noGuard = await makeRouter({ timeoutGuard: () => ({ mode: 'none' }), exec: cancelledResult }).router(
    { name: 'bash', arguments: { command: 'sleep 100' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(noGuard.value.aborted, true)
  assert.match(noGuard.value.stderr.text, /cancelled: the SSH channel was closed, but this server has no usable `timeout`/)

  const guarded = await makeRouter({ timeoutGuard: () => ({ mode: 'kill', shell: '/bin/bash' }), exec: cancelledResult }).router(
    { name: 'bash', arguments: { command: 'sleep 100' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.match(guarded.value.stderr.text, /cancelled: the SSH channel was closed; the remote wrapper terminates/)
})

test('router announces the target once after a target change', async () => {
  const marked = []
  const targets = {
    get: () => ({ active: 'web-1', candidates: ['web-1'], version: 3, notifiedVersion: 2 }),
    markNotified: (_key, version) => marked.push(version),
  }
  const { router } = makeRouter({ targets })
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.match(result.value.stderr.text, /\[remote\] target: web-1 \(root@10\.0\.0\.5:22\)/)
  assert.deepEqual(marked, [3])
})

test('router forwards the stderr budget to the runtime', async () => {
  const { router, calls } = makeRouter({ config: { ...CONFIG, maxStderrBytes: 4096 } })
  await router({ name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() }, async () => ({ value: 'native' }))
  assert.equal(calls[0].options.stderrCap, 4096)
})

test('router rejects a workdir containing newlines', async () => {
  const { router } = makeRouter()
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h', workdir: 'a\nb' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(result.error.info.code, 'INVALID_WORKDIR')
})

test('router returns an error result when the runtime throws', async () => {
  const { router } = makeRouter({
    exec: async () => {
      throw new Error('socket closed')
    },
  })
  const result = await router(
    { name: 'bash', arguments: { command: 'df -h' }, agent: agentFor() },
    async () => ({ value: 'native' }),
  )
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'SSH_EXEC_FAILED')
  assert.match(result.content[0].text, /socket closed/)
})
