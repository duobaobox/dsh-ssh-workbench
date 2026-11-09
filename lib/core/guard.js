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

/** The plugin-owned POSIX shell tool (Windows Hosts have no native bash). */
export const REMOTE_BASH_TOOL_NAME = 'remote_bash'

/** The plugin-owned PowerShell tool (Windows targets). */
export const REMOTE_PWSH_TOOL_NAME = 'remote_pwsh'

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
 * @param {object} deps
 * @param {object} deps.targets per-session target store
 * @param {(entry: object) => void} [deps.recordActivity]
 * @returns {(exec: object) => string|undefined} a `ctx.tools.guard()` handler
 */
export function createBlacklistGuard({ targets, recordActivity } = {}) {
  return function blacklistGuard(exec) {
    try {
      if (!exec) return undefined
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
