/**
 * Per-session resource hints for the composer and the injected context.
 *
 * v2.0 has no session-scoped active target: every remote tool call carries its
 * own `server`. This store only remembers which managed resources the human
 * mentioned with `@name` in the current conversation. It is a hint for the
 * model and the UI, never an execution binding. The durable input is still the
 * Session log, which `replayTargets()` folds back in after a resume.
 */
import { loadServers } from './store.js'
import { findServerRef } from './server-ref.js'

/** Source kind recorded on the injected resource-context message. */
export const TARGET_CONTEXT_KIND = 'ssh-workbench-target'

/** Concatenate the text blocks of one message. */
export function extractUserText(message) {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Find the latest human-authored user message in a step's messages. */
export function lastHumanMessage(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'user' && message.source?.kind === 'user') return message
  }
  return undefined
}

/**
 * Match `@name` tokens against the managed inventory (name or id,
 * case-insensitive). Returns matched server records in mention order, without
 * duplicates. Unknown tokens are ignored.
 */
export function extractServerMentions(text, servers) {
  if (typeof text !== 'string' || !Array.isArray(servers) || servers.length === 0) return []
  const byAlias = new Map()
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || server.name.length === 0) continue
    byAlias.set(server.name.toLowerCase(), server)
    if (typeof server.id === 'string' && server.id.length > 0) byAlias.set(server.id.toLowerCase(), server)
  }
  // Match known aliases directly instead of a generic `@token` regex: a CJK
  // server name is often followed immediately by CJK text (`@测试机看下磁盘`),
  // so only the known name length tells us where the mention ends.
  const aliases = [...byAlias.keys()].sort((left, right) => right.length - left.length)
  const seen = new Set()
  const matched = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    // Like an email address: `ops@example.com` is not a mention.
    const previous = index > 0 ? text[index - 1] : ''
    if (previous && /[A-Za-z0-9._-]/.test(previous)) continue
    for (const alias of aliases) {
      if (text.slice(index + 1, index + 1 + alias.length).toLowerCase() !== alias) continue
      const tail = text[index + 1 + alias.length] ?? ''
      // `@web-12` is a different token than `@web-1`; CJK continuation is fine.
      if (tail && /[A-Za-z0-9._-]/.test(tail)) break
      const server = byAlias.get(alias)
      if (server && !seen.has(server.id ?? server.name)) {
        seen.add(server.id ?? server.name)
        matched.push(server)
      }
      break
    }
  }
  return matched
}

function sameList(left, right) {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function mentionNames(mentions) {
  const names = []
  for (const server of Array.isArray(mentions) ? mentions : []) {
    const name = typeof server?.name === 'string' ? server.name : ''
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function freshState() {
  return { candidates: [], lastHumanId: null, version: 0, injectedVersion: -1, seeded: false }
}

/** Remember the latest @mentions. No target is selected or cleared. */
export function applyMentions(state, mentions) {
  const names = mentionNames(mentions)
  if (names.length === 0) return state
  if (sameList(state.candidates, names)) return state
  return { ...state, candidates: names, version: state.version + 1 }
}

/** Replay the mention hints over a Session's historical messages. */
export function replayTargets(messages, servers) {
  let state = freshState()
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message?.role !== 'user' || message.source?.kind !== 'user') continue
      const mentions = extractServerMentions(extractUserText(message), servers)
      if (mentions.length > 0) state = applyMentions(state, mentions)
    }
  }
  return state
}

/** Resolve one resource reference against the inventory (name or id). */
export function findTarget(servers, ref) {
  return findServerRef(servers, ref)
}

/**
 * Create the per-session resource-hint store.
 * @param {{ loadInventory?: () => object[] }} [options]
 */
export function createTargetStore(options = {}) {
  const loadInventory = options.loadInventory ?? loadServers
  /** @type {Map<string, object>} */
  const sessions = new Map()

  function sessionKey(session) {
    if (session === undefined || session === null) return undefined
    if (typeof session === 'string') return session
    const id = session.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  function get(key) {
    const sessionId = sessionKey(key)
    if (sessionId === undefined) return undefined
    return sessions.get(sessionId)
  }

  function ensure(key) {
    const sessionId = sessionKey(key)
    if (sessionId === undefined) return undefined
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = freshState()
      sessions.set(sessionId, state)
    }
    return state
  }

  /** Seed one session once from its historical messages (resume support). */
  function ensureSeeded(key, messages, servers = loadInventory()) {
    const state = ensure(key)
    if (state === undefined || state.seeded) return state
    const replayed = replayTargets(messages, servers)
    const history = Array.isArray(messages) ? messages : []
    const lastHuman = [...history].reverse().find(
      (message) => message?.role === 'user' && message.source?.kind === 'user',
    )
    const next = {
      ...state,
      candidates: replayed.candidates,
      lastHumanId: typeof lastHuman?.id === 'string' ? lastHuman.id : state.lastHumanId,
      version: replayed.candidates.length > 0 ? 1 : 0,
      seeded: true,
    }
    sessions.set(sessionKey(key), next)
    return next
  }

  /**
   * Fold one human message into the hint state.
   * A new human message always bumps `version` so the per-turn resource
   * context is injected even when the message contains no @mention.
   */
  function bindMentions(key, mentions, humanId) {
    const state = ensure(key)
    if (state === undefined) return undefined
    const newHuman = typeof humanId === 'string' && humanId.length > 0 && humanId !== state.lastHumanId
    const names = mentionNames(mentions)
    const changedMentions = names.length > 0 && !sameList(state.candidates, names)
    if (!newHuman && !changedMentions) return state
    const next = {
      ...state,
      candidates: names.length > 0 ? names : state.candidates,
      lastHumanId: typeof humanId === 'string' && humanId.length > 0 ? humanId : state.lastHumanId,
      version: state.version + 1,
      seeded: true,
    }
    sessions.set(sessionKey(key), next)
    return next
  }

  function markInjected(key, version) {
    const state = get(key)
    if (state === undefined) return
    if (state.injectedVersion === version) return
    sessions.set(sessionKey(key), { ...state, injectedVersion: version })
  }

  function clear(key) {
    const sessionId = sessionKey(key)
    if (sessionId !== undefined) sessions.delete(sessionId)
  }

  function clearAll() {
    sessions.clear()
  }

  function size() {
    return sessions.size
  }

  return { get, ensure, ensureSeeded, bindMentions, markInjected, clear, clearAll, size, loadInventory }
}
