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

test('apply registers the target selector plus the Windows-target shell on a POSIX Host', () => {
  const h = makeHarness()
  assert.deepEqual(h.tools.map((tool) => tool.name).sort(), ['remote_pwsh', 'ssh_workbench_target'])
  const targetTool = h.tools.find((tool) => tool.name === 'ssh_workbench_target')
  assert.deepEqual(Object.keys(targetTool.parameters), ['server'])
  assert.equal(h.guards.length, 1)
  assert.equal(listen(h, 'tools/execute').length, 1)
  assert.equal(listen(h, 'agent/pre-step').length, 1)
  assert.equal(listen(h, 'agent/disposed').length, 1)
  // No prompt section, no terminal backend, no per-tool approval gate.
  assert.equal(h.injected.some((names) => names.includes('terminals')), false)
})

test('publicConfig exposes only live settings', () => {
  const config = plugin.publicConfig({ ...plugin.APPLY_DEFAULTS })
  assert.equal(config.commandTimeoutMs, 120000)
  assert.equal(config.targetContext, true)
  assert.equal(config.prewarm, true)
  assert.equal('factsTtlMs' in config, false)
  assert.equal('httpProbeAllowedHosts' in config, false)
})

test('an @mention binds the session and bash then executes remotely', async () => {
  const h = makeHarness()
  const [preStep] = listen(h, 'agent/pre-step')
  const session = { id: 's1', deriveMessages: () => [] }
  const decision = await preStep(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [human('@web-1 df -h')] }),
  )
  assert.equal(decision.messages.length, 2)

  const [execute] = listen(h, 'tools/execute')
  const signal = { aborted: false }
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    return { value: 'native' }
  }
  const result = await execute({ name: 'bash', arguments: { command: 'df -h' }, agent: { session }, signal }, next)
  assert.equal(nextCalls, 0)
  assert.equal(result.value.kind, 'foreground')
  assert.equal(h.execCalls.length, 1)
  assert.equal(h.execCalls[0].server.name, 'web-1')
  assert.equal(h.execCalls[0].command, 'df -h')

  // Other tools and local sessions still fall through.
  await execute({ name: 'read', arguments: {}, agent: { session } }, next)
  await execute({ name: 'bash', arguments: { command: 'df -h' }, agent: { session: { id: 'other' } } }, next)
  assert.equal(nextCalls, 2)
})

test('the guard blocks destructive commands only while a remote target is bound', async () => {
  const h = makeHarness()
  const [preStep] = listen(h, 'agent/pre-step')
  const session = { id: 's1', deriveMessages: () => [] }
  const [guard] = h.guards
  assert.equal(guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session } }), undefined)

  await preStep(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [human('@web-1 看下磁盘')] }),
  )
  assert.match(guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session } }), /blacklist|recursive delete/i)
  assert.equal(guard({ name: 'bash', arguments: { command: 'df -h' }, agent: { session } }), undefined)
})

test('the target tool switches and detaches the session target', async () => {
  const h = makeHarness()
  const [tool] = h.tools
  const session = { id: 's1', deriveMessages: () => [] }
  const exec = { agent: { session } }

  const bound = await tool.execute({ server: 'web-1' }, exec)
  assert.match(bound.text, /active target: web-1/)

  const detached = await tool.execute({ server: 'local' }, exec)
  assert.match(detached.text, /active target: local/)

  await assert.rejects(() => tool.execute({ server: 'nope' }, exec), /unknown server/)
  await assert.rejects(() => tool.execute({ server: 'web-2' }, exec), /disabled/)
  await assert.rejects(() => tool.execute({ server: 'web-1' }, {}), /agent session/)
})

test('switching back to local returns bash to the native tool body', async () => {
  const h = makeHarness()
  const [tool] = h.tools
  const [execute] = listen(h, 'tools/execute')
  const session = { id: 's1', deriveMessages: () => [] }
  await tool.execute({ server: 'web-1' }, { agent: { session } })
  await tool.execute({ server: 'local' }, { agent: { session } })
  let nextCalls = 0
  const result = await execute(
    { name: 'bash', arguments: { command: 'df -h' }, agent: { session } },
    async () => {
      nextCalls += 1
      return { value: 'native' }
    },
  )
  assert.deepEqual(result, { value: 'native' })
  assert.equal(nextCalls, 1)
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

test('Windows Hosts register remote_bash instead of a native-bash router', async () => {
  const h = makeHarness({ hostPlatform: 'win32' })
  assert.deepEqual(
    h.tools.map((tool) => tool.name).sort(),
    ['remote_bash', 'remote_pwsh', 'ssh_workbench_target'],
    'win32 has no native bash tool to intercept',
  )
  assert.equal(listen(h, 'tools/execute').length, 0)

  const session = { id: 's1', deriveMessages: () => [] }
  const targetTool = h.tools.find((tool) => tool.name === 'ssh_workbench_target')
  const remoteTool = h.tools.find((tool) => tool.name === 'remote_bash')

  await targetTool.execute({ server: 'web-1' }, { agent: { session } })
  const result = await remoteTool.execute({ command: 'df -h' }, { agent: { session } })
  assert.equal(h.execCalls.length, 1)
  assert.match(result.text, /target: web-1/)
  assert.match(result.text, /exit code: 0/)

  // The fallback blacklist covers the plugin-owned tool too.
  const [guard] = h.guards
  assert.match(
    guard({ name: 'remote_bash', arguments: { command: 'rm -rf /' }, agent: { session } }),
    /blacklist|recursive delete/i,
  )

  // The injected context names the tool the model really has on this Host.
  const preStep = h.listeners.filter((entry) => entry.event === 'agent/pre-step').map((entry) => entry.handler)[0]
  assert.ok(preStep)
  const decision = await preStep(
    { agent: { session }, turn: 1, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [human('@web-1 df -h')] }),
  )
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, 'ssh-workbench-target')
  assert.match(injected.content[0].text, /remote_bash tool runs POSIX shell commands on web-1/)
  assert.match(injected.content[0].text, /The native pwsh tool always runs on the local DSH host/)
})
