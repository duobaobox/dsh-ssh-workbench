/**
 * Fallback blacklist for remote bash.
 *
 * Registered through `ctx.tools.guard()`: synchronous, monotonic, and checked
 * after DSH's own pre-execute policy and approval, so no later listener can
 * turn a denial back into a permission. It only inspects commands that will
 * actually run on a managed server (the session has an active target and the
 * tool is a POSIX remote shell: the native `bash` tool on POSIX Hosts, the
 * plugin-owned `remote_bash` tool on Windows Hosts); local bash, file tools and
 * every other tool are untouched.
 */
import { classifyCommand } from './gate.js'
import { classifyPowerShellCommand } from './gate-pwsh.js'
import { findTarget } from './targets.js'

/** The plugin-owned POSIX shell tool (Windows Hosts have no native bash). */
export const REMOTE_BASH_TOOL_NAME = 'remote_bash'

/** The plugin-owned PowerShell tool (Windows targets). */
export const REMOTE_PWSH_TOOL_NAME = 'remote_pwsh'

/** Explicit-target batch tool: every task names its own server. */
export const REMOTE_EXEC_TOOL_NAME = 'remote_exec'

/** Tools whose command argument runs in a POSIX shell on a managed target. */
const POSIX_REMOTE_TOOL_NAMES = new Set(['bash', REMOTE_BASH_TOOL_NAME])

export const BLOCK_REASON_PREFIX = 'dsh-ssh-workbench blocked this command: '

/** Read the session key off one tool execution, tolerating test doubles. */
export function sessionKeyOf(exec) {
  const agent = exec?.agent
  const session = agent?.session
  const id = session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}


/**
 * Pick the gate for an explicit batch task. A record's `platform` is only a
 * hint: the executor probes the real dialect before running. When facts are
 * not collected yet, run both blacklists so a stale hint cannot hide a
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

/**
 * @param {object} deps
 * @param {object} deps.targets per-session target store
 * @param {(entry: object) => void} [deps.recordActivity]
 * @returns {(exec: object) => string|undefined} a `ctx.tools.guard()` handler
 */
export function createBlacklistGuard({ targets, recordActivity, loadInventory } = {}) {
  /** Check every task independently; one denied task denies the whole batch. */
  function guardBatch(exec) {
    if (typeof loadInventory !== 'function') return undefined
    const tasks = exec.arguments?.tasks
    if (!Array.isArray(tasks) || tasks.length === 0) return undefined
    let servers
    try {
      servers = loadInventory()
    } catch {
      return undefined
    }
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]
      if (!task || typeof task !== 'object') continue
      const serverRef = typeof task.server === 'string' ? task.server.trim() : ''
      if (!serverRef || serverRef.toLowerCase() === 'local') continue
      const server = findTarget(servers, serverRef)
      if (server === undefined) continue
      const command = typeof task.command === 'string' ? task.command : ''
      if (!command.trim()) continue
      const classification = classifyForServer(server, command)
      if (classification.decision !== 'deny') continue
      try {
        recordActivity?.({
          kind: 'exec',
          server: server.name,
          summary: `[task ${index + 1}] ${command.slice(0, 180)}`,
          outcome: `blocked: ${classification.ruleId}`,
        })
      } catch {
        // Activity recording is best effort and must never change the decision.
      }
      return `${BLOCK_REASON_PREFIX}task ${index + 1} (${server.name}): ${classification.reason}`
    }
    return undefined
  }

  return function blacklistGuard(exec) {
    try {
      if (!exec) return undefined
      if (exec.name === REMOTE_EXEC_TOOL_NAME) return guardBatch(exec)
      const isPosix = POSIX_REMOTE_TOOL_NAMES.has(exec.name)
      const isPowerShell = exec.name === REMOTE_PWSH_TOOL_NAME
      if (!isPosix && !isPowerShell) return undefined
      const key = sessionKeyOf(exec)
      if (key === undefined || !targets) return undefined
      const binding = targets.get(key)
      if (!binding || !binding.active) return undefined
      const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
      if (!command.trim()) return undefined
      const classification = isPowerShell ? classifyPowerShellCommand(command) : classifyCommand(command)
      if (classification.decision !== 'deny') return undefined
      try {
        recordActivity?.({
          kind: 'exec',
          server: binding.active,
          summary: command.slice(0, 200),
          outcome: `blocked: ${classification.ruleId}`,
        })
      } catch {
        // Activity recording is best effort and must never change the decision.
      }
      return `${BLOCK_REASON_PREFIX}${classification.reason}`
    } catch {
      // A guard must never turn its own failure into a denial of unrelated tools.
      return undefined
    }
  }
}
