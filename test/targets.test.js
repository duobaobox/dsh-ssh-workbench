import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyMentions,
  createTargetStore,
  extractServerMentions,
  extractUserText,
  findTarget,
  lastHumanMessage,
  replayTargets,
} from '../lib/core/targets.js'

const SERVERS = [
  { id: 'srv_1', name: 'web-1', host: '192.0.2.10', port: 22, username: 'root', platform: 'posix', enabled: true },
  { id: 'srv_2', name: 'db-1', host: '192.0.2.11', port: 2222, username: 'deploy', platform: 'posix', enabled: false },
  { id: 'srv_3', name: 'winbox', host: '192.0.2.12', port: 22, username: 'admin', platform: 'windows', enabled: true },
]

function human(text, id = 'm1') {
  return { role: 'user', id, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] }
}
function context(text, id = 'm2') {
  return { role: 'user', id, source: { kind: 'runtime-context' }, content: [{ type: 'text', text }] }
}

test('extractUserText joins text blocks only', () => {
  assert.equal(extractUserText(human('a\nb')), 'a\nb')
  assert.equal(extractUserText({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }), '')
  assert.equal(extractUserText({ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 't' }] }), 't')
  assert.equal(extractUserText(undefined), '')
})

test('lastHumanMessage ignores injected context sources', () => {
  const messages = [human('old'), context('runtime'), human('@web-1 now'), context('time')]
  assert.equal(extractUserText(lastHumanMessage(messages)), '@web-1 now')
  assert.equal(lastHumanMessage([context('x')]), undefined)
  assert.equal(lastHumanMessage(undefined), undefined)
})

test('extractServerMentions matches names and ids case-insensitively', () => {
  assert.deepEqual(extractServerMentions('@web-1 和 @DB-1 和 @unknown', SERVERS).map((s) => s.name), ['web-1', 'db-1'])
  assert.deepEqual(extractServerMentions('mail a@b.com @web-1', SERVERS).map((s) => s.name), ['web-1'])
  assert.deepEqual(extractServerMentions('@srv_1', SERVERS).map((s) => s.name), ['web-1'])
  assert.deepEqual(extractServerMentions('@web-1 @web-1', SERVERS).map((s) => s.name), ['web-1'])
  assert.deepEqual(extractServerMentions('no mentions', SERVERS), [])
  assert.deepEqual(extractServerMentions(undefined, SERVERS), [])
  assert.deepEqual(extractServerMentions('@web-1', undefined), [])
  assert.deepEqual(extractServerMentions('mail ops@example.com', SERVERS), [], 'email addresses are not mentions')
  assert.deepEqual(extractServerMentions('(@web-1)', SERVERS).map((s) => s.name), ['web-1'])
  assert.deepEqual(extractServerMentions('看下@web-1', SERVERS).map((s) => s.name), ['web-1'], 'CJK text before @ is a boundary')
})

test('non-ASCII server names can be mentioned too', () => {
  const servers = [
    ...SERVERS,
    { id: 'srv_4', name: '测试机', host: '10.0.0.9', port: 22, username: 'root', platform: 'posix', enabled: true },
  ]
  assert.deepEqual(extractServerMentions('@测试机 看下磁盘', servers).map((s) => s.name), ['测试机'])
  assert.deepEqual(extractServerMentions('先用@测试机再看@web-1', servers).map((s) => s.name), ['测试机', 'web-1'])
  assert.deepEqual(extractServerMentions('mail ops@测试机.example', servers), [], 'email-style text is still not a mention')
  assert.deepEqual(extractServerMentions('@测试机2', servers), [], 'a longer token must not match a shorter name')
})

test('applyMentions binds one target, remembers several, and keeps the current one', () => {
  const empty = { candidates: [], active: null, version: 0, injectedVersion: -1, seeded: true }
  const one = applyMentions(empty, [SERVERS[0]])
  assert.equal(one.active, 'web-1')
  assert.deepEqual(one.candidates, ['web-1'])
  assert.equal(one.version, 1)
  const many = applyMentions(one, [SERVERS[0], SERVERS[1]])
  assert.equal(many.active, null, 'several mentions must not guess a target')
  assert.deepEqual(many.candidates, ['web-1', 'db-1'])
  const keep = applyMentions(many, [])
  assert.equal(keep, many, 'no mention leaves state untouched')
  const reselect = applyMentions(many, [SERVERS[2], SERVERS[0]])
  assert.equal(reselect.active, null)
  assert.deepEqual(reselect.candidates, ['winbox', 'web-1'])
})

test('replayTargets rebuilds a resumed session target from human messages', () => {
  const state = replayTargets([human('@web-1 看磁盘'), human('@db-1 看内存'), context('@winbox ignored')], SERVERS)
  assert.equal(state.active, 'db-1')
  assert.deepEqual(state.candidates, ['db-1'])
})

test('findTarget resolves names and ids, and rejects unknown values', () => {
  assert.equal(findTarget(SERVERS, 'web-1').id, 'srv_1')
  assert.equal(findTarget(SERVERS, 'srv_2').name, 'db-1')
  assert.equal(findTarget(SERVERS, 'nope'), undefined)
  assert.equal(findTarget(SERVERS, ''), undefined)
})

test('createTargetStore binds by session and switches targets explicitly', () => {
  const store = createTargetStore({ loadInventory: () => SERVERS })
  const session = { id: 's1' }
  store.bindMentions(session, [SERVERS[0]])
  assert.equal(store.get(session).active, 'web-1')

  const switched = store.setActive(session, 'winbox', SERVERS)
  assert.equal(switched.ok, true)
  assert.equal(store.get(session).active, 'winbox')

  const local = store.setActive(session, 'local', SERVERS)
  assert.equal(local.ok, true)
  assert.equal(store.get(session).active, null)
  assert.deepEqual(store.get(session).candidates, [], 'detaching clears any pending task choice')

  const unknown = store.setActive(session, 'nope', SERVERS)
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /unknown server/)

  const disabled = store.setActive(session, 'db-1', SERVERS)
  assert.equal(disabled.ok, false)
  assert.match(disabled.error, /disabled/)

  store.clear(session)
  assert.equal(store.get(session), undefined)
})

test('createTargetStore seeds a session once from history', () => {
  const store = createTargetStore({ loadInventory: () => SERVERS })
  const session = { id: 's2' }
  const state = store.ensureSeeded(session, [human('@web-1 看看')], SERVERS)
  assert.equal(state.active, 'web-1')
  assert.equal(state.seeded, true)
  // A second seed call must not replay a partial list over the current state.
  const again = store.ensureSeeded(session, [human('@db-1')], SERVERS)
  assert.equal(again.active, 'web-1')
})

test('createTargetStore tracks the router target notice', () => {
  const store = createTargetStore({ loadInventory: () => SERVERS })
  const session = { id: 's4' }
  store.bindMentions(session, [SERVERS[0]])
  const state = store.get(session)
  assert.equal(state.notifiedVersion, -1)
  store.markNotified(session, state.version)
  assert.equal(store.get(session).notifiedVersion, state.version)
  store.setActive(session, 'winbox', SERVERS)
  assert.notEqual(store.get(session).notifiedVersion, store.get(session).version)
})

test('createTargetStore tracks injection versions', () => {
  const store = createTargetStore({ loadInventory: () => SERVERS })
  const session = { id: 's3' }
  store.bindMentions(session, [SERVERS[0]])
  const state = store.get(session)
  assert.notEqual(state.injectedVersion, state.version)
  store.markInjected(session, state.version)
  assert.equal(store.get(session).injectedVersion, state.version)
})
