/**
 * Per-session remote target binding.
 *
 * A session owns at most one *active* target: the managed server its native
 * `bash` tool runs on. `@name` mentions in a human message are the primary
 * input; the `ssh_workbench_target` tool switches the active target explicitly so a
 * conversation that mentions several servers stays unambiguous.
 *
 * State is process-local and keyed by Session id. It is a derived cache, not a
 * source of truth: the durable input is the human messages in the Session log,
 * which `replayTargets()` folds back in when a Session resumes.
 */
import { loadServers } from './store.js'

/** Tool name the model calls to switch targets. */
export const TARGET_TOOL_NAME = 'ssh_workbench_target'

/** Source kind recorded on the injected target-context message. */
export const TARGET_CONTEXT_KIND = 'ssh-workbench-target'

/** The sentinel that detaches the session from any remote target. */
export const LOCAL_TARGET = 'local'

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

function freshState() {
  return { candidates: [], active: null, version: 0, injectedVersion: -1, notifiedVersion: -1, seeded: false }
}

/**
 * Fold the mention rules over one session state.
 *
 * - one mention       → that server becomes the active target;
 * - several mentions  → candidates are remembered, active target is cleared;
 * - no mention        → state is unchanged (a follow-up keeps its target).
 */
export function applyMentions(state, mentions) {
  if (!Array.isArray(mentions) || mentions.length === 0) return state
  const names = mentions.map((server) => server.name)
  if (mentions.length === 1) {
    if (state.active === names[0] && sameList(state.candidates, names)) return state
    return { ...state, candidates: names, active: names[0], version: state.version + 1 }
  }
  // Several mentions never pick a target by guesswork; the model must call the
  // selector tool. The previous active target is dropped for the same reason.
  const active = null
  if (active === state.active && sameList(state.candidates, names)) return state
  return { ...state, candidates: names, active, version: state.version + 1 }
}

/** Replay the mention rules over a Session's historical messages. */
export function replayTargets(messages, servers) {
  let state = freshState()
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message?.role !== 'user' || message.source?.kind !== 'user') continue
      state = applyMentions(state, extractServerMentions(extractUserText(message), servers))
    }
  }
  return state
}

/** Resolve one target reference against the inventory (name or id). */
export function findTarget(servers, ref) {
  const value = String(ref ?? '').trim()
  if (!value) return undefined
  return servers.find((server) => server.id === value || server.name === value)
}

/**
 * Create the per-session target store.
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
    const next = {
      ...state,
      candidates: replayed.candidates,
      active: replayed.active,
      version: replayed.version,
      seeded: true,
    }
    sessions.set(sessionKey(key), next)
    return next
  }

  function bindMentions(key, mentions) {
    const state = ensure(key)
    if (state === undefined) return undefined
    const next = { ...applyMentions(state, mentions), seeded: true }
    if (next !== state) sessions.set(sessionKey(key), next)
    return next
  }

  /** Switch the active target explicitly. `local` detaches. */
  function setActive(key, ref, servers = loadInventory()) {
    const state = ensure(key)
    if (state === undefined) return { ok: false, error: 'session is not addressable' }
    if (String(ref).trim().toLowerCase() === LOCAL_TARGET) {
      // Detaching also clears any pending @a @b ambiguity, so bash is plainly
      // local again instead of staying blocked on "choose a target".
      const next = { ...state, active: null, candidates: [], version: state.version + 1, seeded: true }
      sessions.set(sessionKey(key), next)
      return { ok: true, state: next }
    }
    const server = findTarget(servers, ref)
    if (server === undefined) {
      return { ok: false, error: `unknown server "${String(ref)}"`, state }
    }
    if (server.enabled === false) {
      return { ok: false, error: `server "${server.name}" is disabled`, state }
    }
    const next = {
      ...state,
      active: server.name,
      candidates: state.candidates.includes(server.name) ? state.candidates : [server.name],
      version: state.version + 1,
      seeded: true,
    }
    sessions.set(sessionKey(key), next)
    return { ok: true, state: next, server }
  }

  function markInjected(key, version) {
    const state = get(key)
    if (state === undefined) return
    if (state.injectedVersion === version) return
    sessions.set(sessionKey(key), { ...state, injectedVersion: version })
  }

  /**
   * Remember that the bash router already showed the target to the model/UI
   * (one stderr line after each target change), so it is not repeated per call.
   */
  function markNotified(key, version) {
    const state = get(key)
    if (state === undefined) return
    if (state.notifiedVersion === version) return
    sessions.set(sessionKey(key), { ...state, notifiedVersion: version })
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

  return { get, ensure, ensureSeeded, bindMentions, setActive, markInjected, markNotified, clear, clearAll, size, loadInventory }
}
