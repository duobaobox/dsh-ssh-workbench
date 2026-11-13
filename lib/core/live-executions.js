/**
 * In-flight remote executions, for the composer's "current target" indicator.
 *
 * This is a display-only projection. It never selects a target, never reaches
 * a tool, and disappears as soon as the dispatch settles. Every remote tool is
 * explicit-server, so this map is the only place where the UI can learn what a
 * running tool is touching.
 */
import { sessionKeyOf } from './remote-shell-tool.js'
import {
  REMOTE_EDIT_TOOL_NAME,
  REMOTE_GLOB_TOOL_NAME,
  REMOTE_GREP_TOOL_NAME,
  REMOTE_READ_TOOL_NAME,
  REMOTE_WRITE_TOOL_NAME,
} from './remote-file-tools.js'
import { REMOTE_EXEC_TOOL_NAME } from './remote-exec-tool.js'

const SINGLE_SERVER_TOOLS = new Set([
  'remote_bash',
  'remote_pwsh',
  REMOTE_READ_TOOL_NAME,
  REMOTE_WRITE_TOOL_NAME,
  REMOTE_EDIT_TOOL_NAME,
  REMOTE_GLOB_TOOL_NAME,
  REMOTE_GREP_TOOL_NAME,
])

/** Extract the explicit server names a remote tool call will touch. */
export function serversOf(exec) {
  const name = exec?.name
  const args = exec?.arguments
  if (!name || !args || typeof args !== 'object') return []
  if (name === REMOTE_EXEC_TOOL_NAME) {
    const tasks = Array.isArray(args.tasks) ? args.tasks : []
    const names = []
    for (const task of tasks) {
      if (task && typeof task.server === 'string' && task.server.length > 0 && !names.includes(task.server)) {
        names.push(task.server)
      }
    }
    return names
  }
  if (!SINGLE_SERVER_TOOLS.has(name)) return []
  return typeof args.server === 'string' && args.server.length > 0 ? [args.server] : []
}

/** @param {{ now?: () => number }} [options] */
export function createLiveExecutions(options = {}) {
  const now = options.now ?? Date.now
  let nextToken = 0
  /** @type {Map<number, { sessionId: string, tool: string, servers: string[], startedAt: number }>} */
  const active = new Map()

  /** Register one dispatch; returns undefined when this is not a remote call. */
  function begin(exec) {
    const servers = serversOf(exec)
    if (servers.length === 0) return undefined
    const sessionId = sessionKeyOf(exec)
    if (!sessionId) return undefined
    const token = ++nextToken
    active.set(token, {
      sessionId,
      tool: typeof exec.name === 'string' ? exec.name : '',
      servers,
      startedAt: now(),
    })
    return token
  }

  function end(token) {
    if (token !== undefined) active.delete(token)
  }

  /** @returns {{ count: number, servers: { name: string, count: number, startedAt: number }[] }} */
  function snapshot(sessionId) {
    const byName = new Map()
    let calls = 0
    for (const entry of active.values()) {
      if (entry.sessionId !== sessionId) continue
      calls += 1
      for (const name of entry.servers) {
        const previous = byName.get(name)
        byName.set(name, {
          name,
          count: (previous?.count ?? 0) + 1,
          startedAt: previous ? Math.min(previous.startedAt, entry.startedAt) : entry.startedAt,
        })
      }
    }
    return { count: calls, servers: [...byName.values()] }
  }

  function clear(sessionId) {
    for (const [token, entry] of active) {
      if (sessionId === undefined || entry.sessionId === sessionId) active.delete(token)
    }
  }

  return { begin, end, snapshot, clear, size: () => active.size }
}
