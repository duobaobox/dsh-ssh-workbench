import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Keep plugin persistence out of the real harness home.
process.env.DSH_SSH_WORKBENCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-apply-'))

const plugin = await import('../lib/index.js')
const { publicConfig } = plugin

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '10.0.0.5', port: 22, username: 'root', platform: 'posix', enabled: true, tags: [], facts: {} },
  { id: 'srv_2', name: 'web-2', host: '10.0.0.6', port: 22, username: 'root', platform: 'posix', enabled: false, tags: [], facts: {} },
]

const CONFIG = {
  connectTimeoutMs: 15000,
  commandTimeoutMs: 120000,
  maxCommandTimeoutMs: 600000,
  maxOutputBytes: 102400,
  hostKeyMode: 'strict',
}

function human(text, id = 'm1') {
  return { role: 'user', id, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] }
}

function makeHarness({ runtime, config = CONFIG, hostPlatform } = {}) {
  const tools = []
  const guards = []
  const listeners = []
  const effects = []
  const injected = []
  const execCalls = []
  const fakeRuntime = runtime ?? {
    async exec(server, command, options) {
      execCalls.push({ server, command, options })
      return {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        durationMs: 2,
        truncated: { stdout: false, stderr: false },
      }
    },
    preload: async () => {},
    close: async () => {},
  }
  const ctx = {
    logger: { debug() {}, warn() {}, info() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      guard(handler) {
        guards.push(handler)
        return () => {
          const index = guards.indexOf(handler)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((entry) => entry.event === event && entry.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    inject(names, callback) {
      injected.push([...names])
      callback({
        get() {
          return undefined
        },
        effect(fn) {
          const dispose = fn()
          effects.push(dispose)
          return dispose
        },
      })
    },
    get() {
      return undefined
    },
  }
  plugin.apply(ctx, config, {
    runtime: fakeRuntime,
    loadInventory: () => SERVERS,
    secrets: { get: () => undefined, set() {}, has: () => false },
    knownHosts: { verify: () => true, has: () => false, trust() {}, list: () => [], revoke: () => true, invalidate() {} },
    createUserMessage: (input) => ({ ...input, role: 'user', id: 'ctx-message' }),
    hostPlatform,
  })
  return { ctx, tools, guards, listeners, effects, injected, execCalls }
}

function listen(h, event) {
  return h.listeners.filter((entry) => entry.event === event).map((entry) => entry.handler)
}

test('plugin exports the cordis contract', () => {
  assert.equal(plugin.name, 'dsh-ssh-workbench')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'object')
})

test('apply registers explicit-target remote tools on both Hosts', () => {
  const h = makeHarness()
  assert.deepEqual(h.tools.map((tool) => tool.name).sort(), ['remote_bash', 'remote_exec', 'remote_pwsh'])
  const remoteBash = h.tools.find((tool) => tool.name === 'remote_bash')
  assert.deepEqual(Object.keys(remoteBash.parameters), ['server', 'command', 'workdir', 'timeoutMs', 'run_in_background'])
  const remoteExec = h.tools.find((tool) => tool.name === 'remote_exec')
  assert.deepEqual(Object.keys(remoteExec.parameters), ['tasks', 'concurrency', 'probe', 'connectTimeoutMs'])
  assert.equal(remoteExec.isConcurrencySafe({}), true)
  assert.equal(h.guards.length, 1)
  assert.equal(listen(h, 'tools/execute').length, 0, 'native bash is no longer intercepted')
  assert.equal(listen(h, 'agent/pre-step').length, 1)
  assert.equal(listen(h, 'agent/disposed').length, 1)
})

test('publicConfig exposes only live settings', () => {
  const config = plugin.publicConfig({ ...plugin.APPLY_DEFAULTS })
  assert.equal(config.commandTimeoutMs, 120000)
  assert.equal(config.targetContext, true)
  assert.equal(config.prewarm, true)
  assert.equal(config.maxBatchTasks, 8)
  assert.equal(config.batchConcurrency, 4)
  assert.equal(config.maxBatchOutputBytes, 262144)
  assert.equal('factsTtlMs' in config, false)
  assert.equal('httpProbeAllowedHosts' in config, false)
})

test('pre-step injects the resource context without an @mention', async () => {
  const h = makeHarness()
  const [preStep] = listen(h, 'agent/pre-step')
  const session = { id: 's1', deriveMessages: () => [] }
  const decision = await preStep(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [human('看看磁盘')] }),
  )
  assert.equal(decision.messages.length, 2)
  const text = decision.messages[1].content.map((block) => block.text ?? '').join('\n')
  assert.match(text, /Managed remote resources/)
  assert.match(text, /remote_bash/)
  assert.match(text, /remote_exec/)
  assert.match(text, /web-1/)
})

test('remote_bash executes on its explicit server and leaves local work alone', async () => {
  const h = makeHarness()
  const remoteBash = h.tools.find((tool) => tool.name === 'remote_bash')
  const session = { id: 's1' }
  const result = await remoteBash.execute(
    { server: 'web-1', command: 'df -h' },
    { agent: { session }, signal: { aborted: false } },
  )
  assert.match(result.text, /web-1/)
  assert.equal(h.execCalls.length, 1)
  assert.equal(h.execCalls[0].server.name, 'web-1')
  assert.equal(h.execCalls[0].command, 'df -h')
  await assert.rejects(
    () => remoteBash.execute({ server: 'nope', command: 'df -h' }, { agent: { session }, signal: { aborted: false } }),
    /unknown .*server/,
  )
})

test('the guard resolves the explicit server, never the local shell', () => {
  const h = makeHarness()
  const [guard] = h.guards
  const session = { id: 's1' }
  assert.match(
    guard({ name: 'remote_bash', arguments: { server: 'web-1', command: 'rm -rf /' }, agent: { session } }),
    /blocked/,
  )
  assert.equal(guard({ name: 'remote_bash', arguments: { server: 'web-1', command: 'df -h' }, agent: { session } }), undefined)
  assert.equal(guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session } }), undefined)
})

test('remote_exec validates every task before executing', async () => {
  const h = makeHarness()
  const remoteExec = h.tools.find((tool) => tool.name === 'remote_exec')
  await assert.rejects(
    () => remoteExec.execute({ tasks: [{ server: 'web-1', command: 'df -h' }, { server: 'nope', command: 'x' }] }, { agent: { session: { id: 's1' } } }),
    /unknown .*server/,
  )
  assert.equal(h.execCalls.length, 0)
})

test('workbench local root defaults to the user home and supports an override', () => {
  assert.equal(plugin.resolveLocalRoot({}), os.homedir())
  assert.equal(plugin.resolveLocalRoot({ localRoot: '' }), os.homedir())
  assert.equal(plugin.resolveLocalRoot({ localRoot: '   ' }), os.homedir())
  const custom = path.join(os.homedir(), 'qa-workbench-root')
  assert.equal(plugin.resolveLocalRoot({ localRoot: custom }), custom)
  assert.equal(plugin.resolveLocalRoot({ localRoot: '~/qa-workbench-root' }), custom)
  assert.equal(plugin.resolveLocalRoot({ localRoot: '~' }), os.homedir())
  // A relative value is rejected instead of silently rooting at process.cwd().
  assert.equal(plugin.resolveLocalRoot({ localRoot: 'relative/path' }), os.homedir())
})

test('Windows Hosts register the same explicit-target tools', () => {
  const h = makeHarness({ hostPlatform: 'win32' })
  assert.deepEqual(h.tools.map((tool) => tool.name).sort(), ['remote_bash', 'remote_exec', 'remote_pwsh'])
  assert.equal(listen(h, 'tools/execute').length, 0)
})
