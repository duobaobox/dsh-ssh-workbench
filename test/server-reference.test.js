import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TARGET_CONTEXT_KIND,
  buildManagedContextMessage,
  installManagedContext,
  renderManagedContext,
} from '../lib/core/server-reference.js'
import { createTargetStore } from '../lib/core/targets.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '192.0.2.10', port: 22, username: 'root', platform: 'posix', enabled: true },
  { id: 'srv_2', name: 'db-1', host: '192.0.2.11', port: 2222, username: 'deploy', platform: 'posix', enabled: true },
]

function human(text, id = 'm1') {
  return { role: 'user', id, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] }
}
function context(text, id = 'm2') {
  return { role: 'user', id, source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }
}
function makeSession(id = 's1', deriveMessages = () => []) {
  return { id, deriveMessages }
}
function makeHarness({ session = makeSession(), servers = SERVERS, enabled, remoteAvailable, hostPlatform } = {}) {
  const handlers = new Map()
  const logs = []
  const ctx = {
    logger: { warn: (message) => logs.push(message) },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn) {
      fn()
    },
  }
  const targets = createTargetStore({ loadInventory: () => servers })
  installManagedContext(ctx, {
    enabled,
    targets,
    loadInventory: () => servers,
    loadLastExecuted: () => 'web-1',
    createUserMessage: undefined,
    remoteAvailable,
    hostPlatform,
  })
  const preStep = async ({ messages, step = 1, turn = 1, agent = { session }, decision = { kind: 'enter', messages } }) => {
    const listener = handlers.get('agent/pre-step')?.[0]
    assert.ok(listener, 'pre-step listener should be registered')
    return listener({ agent, turn, step, signal: { aborted: false } }, async () => decision)
  }
  return { handlers, logs, targets, session, preStep }
}

test('renderManagedContext lists inventory and explicit-target tools', () => {
  const text = renderManagedContext(SERVERS, { hostPlatform: 'darwin' })
  assert.match(text, /Managed remote resources \(2\)/)
  assert.match(text, /- web-1 — root@192\.0\.2\.10:22 · posix/)
  assert.match(text, /native bash tool always runs on the local DSH host/)
  assert.match(text, /remote_bash\(\{ server: "<name>", command:/)
  assert.match(text, /remote_pwsh/)
  assert.match(text, /remote_exec\(\{ tasks:/)
  assert.match(text, /never read .*servers\.json/)
})

test('renderManagedContext carries candidates and last execution as hints', () => {
  const text = renderManagedContext(SERVERS, { candidates: ['db-1'], lastExecuted: 'web-1' })
  assert.match(text, /The user mentioned: db-1/)
  assert.match(text, /Last remote execution in this conversation: web-1/)
})

test('renderManagedContext uses the Windows local shell name', () => {
  const text = renderManagedContext(SERVERS, { hostPlatform: 'win32' })
  assert.match(text, /native pwsh tool always runs on the local DSH host/)
})

test('renderManagedContext shows probed facts and disabled state', () => {
  const servers = [
    { ...SERVERS[0], facts: { hostname: 'iZbp-example', dialect: 'posix' } },
    { ...SERVERS[1], enabled: false },
  ]
  const text = renderManagedContext(servers)
  assert.match(text, /iZbp-example/)
  assert.match(text, /db-1 — deploy@192\.0\.2\.11:2222 · posix · disabled/)
})

test('buildManagedContextMessage uses the host factory and a reserved source kind', () => {
  const seen = []
  const message = buildManagedContextMessage(SERVERS, {}, (input) => {
    seen.push(input)
    return { ...input, role: 'user', id: 'made' }
  })
  assert.equal(message.id, 'made')
  assert.equal(seen[0].source.kind, TARGET_CONTEXT_KIND)
  assert.equal(seen[0].source.form, 'notice')
  const fallback = buildManagedContextMessage(SERVERS, {})
  assert.equal(fallback.role, 'user')
  assert.match(fallback.id, /^ssh-workbench-context-/)
})

test('context is injected even without an @mention', async () => {
  const h = makeHarness()
  const decision = await h.preStep({ messages: [human('看看磁盘')] })
  assert.equal(decision.messages.length, 2)
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, TARGET_CONTEXT_KIND)
  assert.match(injected.content[0].text, /Managed remote resources/)
})

test('an @mention is recorded as a hint, not a target binding', async () => {
  const h = makeHarness()
  const decision = await h.preStep({ messages: [human('@web-1 看下磁盘'), context('runtime')] })
  assert.equal(decision.messages.length, 3)
  assert.deepEqual(h.targets.get(h.session).candidates, ['web-1'])
  assert.equal('active' in h.targets.get(h.session), false)
  assert.match(decision.messages.at(-1).content[0].text, /The user mentioned: web-1/)
})

test('several @mentions are all remembered as hints', async () => {
  const h = makeHarness()
  await h.preStep({ messages: [human('@web-1 @db-1 都看下')] })
  assert.deepEqual(h.targets.get(h.session).candidates, ['web-1', 'db-1'])
})

test('context is injected once per turn and re-injected when it is gone', async () => {
  const h = makeHarness()
  const first = await h.preStep({ messages: [human('看看磁盘')], step: 1, turn: 1 })
  assert.equal(first.messages.length, 2)
  const second = await h.preStep({ messages: [human('看看磁盘')], step: 2, turn: 1 })
  assert.equal(second.messages.length, 1, 'same turn later steps stay quiet')
  const nextTurn = await h.preStep({ messages: [human('看看磁盘')], step: 1, turn: 2 })
  assert.equal(nextTurn.messages.length, 2, 'a new human turn re-injects')
})

test('an already-present context is not duplicated', async () => {
  const h = makeHarness()
  const first = await h.preStep({ messages: [human('看看磁盘')], step: 1, turn: 1 })
  const injected = first.messages.at(-1)
  const nextTurn = await h.preStep({ messages: [human('继续'), injected], step: 1, turn: 2 })
  assert.equal(nextTurn.messages.length, 2)
})

test('a resumed session recovers @mention hints from history', async () => {
  const session = makeSession('s2', () => [human('@db-1 看下内存'), context('@web-1 ignored')])
  const h = makeHarness({ session })
  await h.preStep({ messages: [human('继续')], step: 1, turn: 1 })
  assert.deepEqual(h.targets.get(session).candidates, ['db-1'])
})

test('reject decisions pass through untouched', async () => {
  const h = makeHarness()
  const reject = { kind: 'reject', reason: 'busy' }
  const decision = await h.preStep({ messages: [human('@web-1 df -h')], decision: reject })
  assert.equal(decision, reject)
})

test('the injected decision spreads the downstream decision', async () => {
  const h = makeHarness()
  const decision = await h.preStep({
    messages: [human('@web-1 df -h')],
    decision: { kind: 'enter', messages: [human('@web-1 df -h')], startsRequestSeries: true, extra: 'kept' },
  })
  assert.equal(decision.startsRequestSeries, true)
  assert.equal(decision.extra, 'kept')
})

test('enabled:false disables injection and hint binding', async () => {
  const h = makeHarness({ enabled: false })
  const decision = await h.preStep({ messages: [human('@web-1 df -h')] })
  assert.equal(decision.messages.length, 1)
  assert.equal(h.targets.get(h.session), undefined)
})

test('agent disposal clears the session hints', async () => {
  const h = makeHarness()
  await h.preStep({ messages: [human('@web-1 df -h')] })
  const disposed = h.handlers.get('agent/disposed')?.[0]
  assert.ok(disposed)
  disposed({ agent: { session: h.session } })
  assert.equal(h.targets.get(h.session), undefined)
})

test('no remote execution path means no context at all', async () => {
  const h = makeHarness({ remoteAvailable: false })
  const original = { kind: 'enter', messages: [human('@web-1 df -h')] }
  const decision = await h.preStep({ messages: original.messages, decision: original })
  assert.equal(decision, original)
  assert.equal(h.targets.get(h.session), undefined)
})

test('failures in the inventory never break the step', async () => {
  const handlers = new Map()
  const ctx = {
    logger: { warn: () => {} },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    effect(fn) {
      fn()
    },
  }
  installManagedContext(ctx, {
    targets: createTargetStore({ loadInventory: () => [] }),
    loadInventory: () => {
      throw new Error('inventory boom')
    },
  })
  const listener = handlers.get('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [human('@web-1 df -h')] }
  const decision = await listener(
    { agent: { session: { id: 's9' } }, turn: 1, step: 1, signal: { aborted: false } },
    async () => original,
  )
  assert.equal(decision, original)
})
