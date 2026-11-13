/**
 * Fallback blacklist for remote commands.
 *
 * Registered through `ctx.tools.guard()`: synchronous, monotonic, and checked
 * after DSH's own pre-execute policy and approval, so no later listener can
 * turn a denial back into a permission.
 *
 * There is no session-scoped target state: every remote tool names its own
 * `server`, so the guard resolves that explicit reference. The native local
 * `bash`/`pwsh` tools are never inspected — local work is outside this
 * plugin's remote-command boundary.
 */
import { classifyCommand } from './gate.js'
import { classifyPowerShellCommand } from './gate-pwsh.js'
import { findServerRef } from './server-ref.js'

/** The plugin-owned POSIX shell tool. */
const REMOTE_BASH_TOOL_NAME = 'remote_bash'

/** The plugin-owned PowerShell tool (Windows targets). */
const REMOTE_PWSH_TOOL_NAME = 'remote_pwsh'

/** Explicit-target batch tool: every task names its own server. */
const REMOTE_EXEC_TOOL_NAME = 'remote_exec'

export const BLOCK_REASON_PREFIX = 'dsh-ssh-workbench blocked this command: '

/** Read the session key off one tool execution, tolerating test doubles. */
export function sessionKeyOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  const id = session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Pick the gate for one explicit server. A record's `platform` is only a hint:
 * the executor probes the real dialect before running. When facts are not
 * collected yet, run both blacklists so a stale hint cannot hide a
 * Windows-only destructive command (and vice versa).
 */
function classifyForServer(server, command) {
  const dialect = server?.facts?.dialect
  if (dialect === 'windows') return classifyPowerShellCommand(command)
  if (dialect === 'posix') return classifyCommand(command)
  const posix = classifyCommand(command)
  if (posix.decision === 'deny') return posix
  return classifyPowerShellCommand(command)
}

function summaryOf(prefix, command) {
  const text = `${prefix}${command}`.slice(0, 200)
  return text
}

/**
 * @param {object} deps
 * @param {(entry: object) => void} [deps.recordActivity]
 * @param {() => object[]} [deps.loadInventory]
 * @returns {(exec: object) => string|undefined} a `ctx.tools.guard()` handler
 */
export function createBlacklistGuard({ recordActivity, loadInventory } = {}) {
  function inventory() {
    if (typeof loadInventory !== 'function') return undefined
    try {
      const servers = loadInventory()
      return Array.isArray(servers) ? servers : undefined
    } catch {
      return undefined
    }
  }

  function guardOne(exec, serverRef, command, label = '') {
    const ref = typeof serverRef === 'string' ? serverRef.trim() : ''
    if (!ref || ref.toLowerCase() === 'local') return undefined
    if (!command.trim()) return undefined
    const servers = inventory()
    if (servers === undefined) return undefined
    const server = findServerRef(servers, ref)
    if (server === undefined) return undefined
    const classification = classifyForServer(server, command)
    if (classification.decision !== 'deny') return undefined
    try {
      recordActivity?.({
        kind: 'exec',
        server: server.name,
        sessionId: sessionKeyOf(exec),
        summary: summaryOf(label, command),
        outcome: `blocked: ${classification.ruleId}`,
      })
    } catch {
      // Activity recording is best effort and must never change the decision.
    }
    return `${BLOCK_REASON_PREFIX}${label}${classification.reason}`
  }

  /** Check every task independently; one denied task denies the whole batch. */
  function guardBatch(exec) {
    const tasks = exec.arguments?.tasks
    if (!Array.isArray(tasks) || tasks.length === 0) return undefined
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]
      if (!task || typeof task !== 'object') continue
      const command = typeof task.command === 'string' ? task.command : ''
      const denied = guardOne(exec, task.server, command, `task ${index + 1}: `)
      if (denied !== undefined) return denied
    }
    return undefined
  }

  return function blacklistGuard(exec) {
    try {
      if (!exec) return undefined
      if (exec.name === REMOTE_EXEC_TOOL_NAME) return guardBatch(exec)
      if (exec.name !== REMOTE_BASH_TOOL_NAME && exec.name !== REMOTE_PWSH_TOOL_NAME) return undefined
      const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
      return guardOne(exec, exec.arguments?.server, command)
    } catch {
      // A guard must never turn its own failure into a denial of unrelated tools.
      return undefined
    }
  }
}
