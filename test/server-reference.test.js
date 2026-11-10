import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TARGET_CONTEXT_KIND,
  buildTargetContextMessage,
  installTargetContext,
  renderTargetContext,
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

function makeHarness({ session = makeSession(), servers = SERVERS, enabled } = {}) {
  const handlers = new Map()
  const logs = []
  const disposers = []
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
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  }
  const targets = createTargetStore({ loadInventory: () => servers })
  installTargetContext(ctx, {
    enabled,
    targets,
    loadInventory: () => servers,
    createUserMessage: undefined,
  })
  const preStep = async ({ messages, step = 1, turn = 1, agent = { session }, decision = { kind: 'enter', messages } }) => {
    const listener = handlers.get('agent/pre-step')?.[0]
    assert.ok(listener, 'pre-step listener should be registered')
    return listener({ agent, turn, step, signal: { aborted: false } }, async () => decision)
  }
  return { handlers, logs, targets, session, preStep, disposers }
}

test('renderTargetContext names the target and the local/remote split', () => {
  const text = renderTargetContext({ active: 'web-1', candidates: ['web-1'] }, SERVERS)
  assert.match(text, /\[ssh-workbench\] Managed server context/)
  assert.match(text, /- web-1 — root@192\.0\.2\.10:22 · posix/)
  assert.match(text, /bash tool runs on web-1/)
  assert.match(text, /read\/write\/edit\/glob\/grep always run on the local DSH host/)
  assert.match(text, /never use write\/edit for remote files/)
  assert.match(text, /ssh_workbench_target/)
  assert.match(text, /"local"/)
  assert.match(text, /remote_exec\(\{ tasks:/)
  assert.match(text, /does not change the active target/)
})

test('renderTargetContext includes fresh facts and operational discipline', () => {
  const servers = [
    {
      ...SERVERS[0],
      facts: {
        hostname: 'iZbp-example',
        kernel: 'Linux 7.0.0-31-generic',
        rootDisk: '/dev/vda3 40G 7.4G 30G 20% /',
        uptime: 'up 6 days',
      },
    },
  ]
  const text = renderTargetContext({ active: 'web-1', candidates: ['web-1'] }, servers)
  assert.match(text, /iZbp-example/)
  assert.doesNotMatch(text, /disk 20%/)
  assert.match(text, /Do not use ssh\/scp inside bash/)
  assert.match(text, /exit code 0 does not prove success/)
})

test('renderTargetContext asks for a choice when several servers are mentioned', () => {
  const text = renderTargetContext({ active: null, candidates: ['web-1', 'db-1'] }, SERVERS)
  assert.match(text, /- web-1 —/)
  assert.match(text, /- db-1 —/)
  assert.match(text, /still runs on the local DSH host/)
  assert.match(text, /ssh_workbench_target/)
  assert.match(text, /remote_exec\(\{ tasks:/)
  assert.match(text, /runs those tasks concurrently/)
})

test('buildTargetContextMessage uses the host factory and a reserved source kind', () => {
  const seen = []
  const message = buildTargetContextMessage({ active: 'web-1', candidates: ['web-1'] }, SERVERS, (input) => {
    seen.push(input)
    return { ...input, role: 'user', id: 'made' }
  })
  assert.equal(message.id, 'made')
  assert.equal(seen[0].source.kind, TARGET_CONTEXT_KIND)
  assert.equal(seen[0].source.form, 'notice')
  const fallback = buildTargetContextMessage({ active: 'web-1', candidates: ['web-1'] }, SERVERS)
  assert.equal(fallback.role, 'user')
  assert.match(fallback.id, /^ssh-workbench-target-/)
})

test('one @mention binds the target and injects context in the same step', async () => {
  const h = makeHarness()
  const decision = await h.preStep({ messages: [human('@web-1 看下磁盘'), context('runtime')] })
  assert.equal(decision.messages.length, 3)
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, TARGET_CONTEXT_KIND)
  assert.match(injected.content[0].text, /bash tool runs on web-1/)
  assert.equal(h.targets.get(h.session).active, 'web-1')
})

test('several @mentions clear the active target and ask for a choice', async () => {
  const h = makeHarness()
  const decision = await h.preStep({ messages: [human('@web-1 @db-1 都看下')] })
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, TARGET_CONTEXT_KIND)
  assert.match(injected.content[0].text, /still runs on the local DSH host/)
  assert.equal(h.targets.get(h.session).active, null)
  assert.deepEqual(h.targets.get(h.session).candidates, ['web-1', 'db-1'])
})

test('no mention and no target means no injection', async () => {
  const h = makeHarness()
  const decision = await h.preStep({ messages: [human('just local work')] })
  assert.equal(decision.messages.length, 1)
})

test('context is injected once per turn, and re-injected when the previous one is gone', async () => {
  const h = makeHarness()
  const first = await h.preStep({ messages: [human('@web-1 df -h')], step: 1, turn: 1 })
  assert.equal(first.messages.length, 2)
  const second = await h.preStep({ messages: [human('@web-1 df -h')], step: 2, turn: 1 })
  assert.equal(second.messages.length, 1, 'same turn later steps must stay quiet')
  const nextTurn = await h.preStep({ messages: [human('df -h again')], step: 1, turn: 2 })
  assert.equal(nextTurn.messages.length, 2, 'a new turn re-injects after compaction dropped the context')
})

test('an already-present target context is not duplicated', async () => {
  const h = makeHarness()
  const first = await h.preStep({ messages: [human('@web-1 df -h')], step: 1, turn: 1 })
  const injected = first.messages.at(-1)
  assert.equal(injected.source.kind, TARGET_CONTEXT_KIND)
  const nextTurn = await h.preStep({ messages: [human('继续看内存'), injected], step: 1, turn: 2 })
  assert.equal(nextTurn.messages.length, 2, 'the previous turn context is still in the step; do not re-add it')
  const laterStep = await h.preStep({ messages: [human('继续看内存'), injected], step: 2, turn: 2 })
  assert.equal(laterStep.messages.length, 2)
})

test('target changes mid-turn are injected on the next step', async () => {
  const h = makeHarness()
  await h.preStep({ messages: [human('@web-1 df -h')], step: 1, turn: 1 })
  // The selector tool changed the target between steps.
  h.targets.setActive(h.session, 'db-1', SERVERS)
  const decision = await h.preStep({ messages: [], step: 2, turn: 1 })
  const injected = decision.messages.at(-1)
  assert.equal(injected.source.kind, TARGET_CONTEXT_KIND)
  assert.match(injected.content[0].text, /bash tool runs on db-1/)
})

test('a resumed session recovers its target from human history', async () => {
  const session = makeSession('s2', () => [human('@db-1 看下内存'), context('@web-1 ignored')])
  const h = makeHarness({ session })
  const decision = await h.preStep({ messages: [human('继续')], step: 1, turn: 1 })
  assert.equal(h.targets.get(session).active, 'db-1')
  assert.match(decision.messages.at(-1).content[0].text, /bash tool runs on db-1/)
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

test('enabled:false disables auto binding and injection', async () => {
  const h = makeHarness({ enabled: false })
  const decision = await h.preStep({ messages: [human('@web-1 df -h')] })
  assert.equal(decision.messages.length, 1)
  assert.equal(h.targets.get(h.session), undefined)
})

test('agent disposal clears the session target', async () => {
  const h = makeHarness()
  await h.preStep({ messages: [human('@web-1 df -h')] })
  assert.equal(h.targets.get(h.session).active, 'web-1')
  const disposed = h.handlers.get('agent/disposed')?.[0]
  assert.ok(disposed)
  disposed({ agent: { session: h.session } })
  assert.equal(h.targets.get(h.session), undefined)
})

test('failures in the inventory or message factory never break the step', async () => {
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
  const targets = createTargetStore({ loadInventory: () => [] })
  installTargetContext(ctx, {
    targets,
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

test('a Windows Host context names remote_bash and keeps pwsh local', () => {
  const text = renderTargetContext({ active: 'web-1', candidates: ['web-1'] }, SERVERS, {
    hostPlatform: 'win32',
    remoteToolName: 'remote_bash',
  })
  assert.match(text, /remote_bash tool runs POSIX shell commands on web-1/)
  assert.match(text, /native pwsh tool always runs on the local DSH host/)
  assert.match(text, /pass remote_bash\.workdir/)
  assert.doesNotMatch(text, /The bash tool runs/)
})

test('a Windows target is described through remote_pwsh, not bash', () => {
  const windows = [{ ...SERVERS[0], platform: 'windows' }]
  const text = renderTargetContext({ active: 'web-1', candidates: ['web-1'] }, windows)
  assert.match(text, /remote_pwsh tool runs PowerShell commands on web-1/)
  assert.match(text, /pass remote_pwsh\.workdir/)
  assert.doesNotMatch(text, /bash tool runs on web-1/)
})

test('a probed facts.dialect overrides the record platform hint', () => {
  const probed = [{ ...SERVERS[0], platform: 'posix', facts: { dialect: 'windows', hostname: 'winlab' } }]
  const text = renderTargetContext({ active: 'web-1', candidates: ['web-1'] }, probed)
  assert.match(text, /web-1 — root@192\.0\.2\.10:22 · windows/)
  assert.match(text, /remote_pwsh tool runs PowerShell commands on web-1/)
})

test('a Windows Host with no active target does not pretend to run remotely', () => {
  const text = renderTargetContext({ active: null, candidates: ['web-1'] }, SERVERS, {
    hostPlatform: 'win32',
    remoteToolName: 'remote_bash',
  })
  assert.match(text, /native pwsh tool runs on the local DSH host/)
  assert.match(text, /remote_bash only runs after you choose a target/)
})

test('no remote execution path means no target context at all', async () => {
  const handlers = new Map()
  const ctx = {
    logger: { warn() {} },
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
  const targets = createTargetStore({ loadInventory: () => SERVERS })
  installTargetContext(ctx, { targets, loadInventory: () => SERVERS, remoteAvailable: false })
  const listener = handlers.get('agent/pre-step')[0]
  const original = { kind: 'enter', messages: [human('@web-1 df -h')] }
  const decision = await listener(
    { agent: { session: { id: 's1' } }, turn: 1, step: 1, signal: { aborted: false } },
    async () => original,
  )
  assert.equal(decision, original)
  assert.equal(targets.get('s1'), undefined, 'without remote execution the @mention must not bind a target')
})
