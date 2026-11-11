/**
 * Per-turn managed-resource context.
 *
 * The composer inserts an `@name` chip as plain text. v2.0 treats that as a
 * hint, not an execution binding: every remote tool call names its own server.
 * This module injects one compact inventory + tool-rules message per human
 * turn, so the model never has to read `servers.json` or switch a hidden
 * session target before acting.
 *
 * The message enters the same step (`agent/pre-step` replaces the messages that
 * enter a step), which `agent.inject()` cannot promise because it splices into
 * the next step.
 *
 * Scope: every agent mode; no preset gating.
 */
import { randomUUID } from 'node:crypto'

import { effectiveDialect } from './dialect.js'
import { loadServers } from './store.js'
import { serverNameList } from './server-ref.js'
import {
  TARGET_CONTEXT_KIND,
  createTargetStore,
  extractServerMentions,
  extractUserText,
  lastHumanMessage,
} from './targets.js'

export { TARGET_CONTEXT_KIND }

const DEFAULT_MAX_CONTEXT_SERVERS = 20

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function serverLine(server) {
  const target = `${server.username ?? 'root'}@${server.host}:${server.port ?? 22}`
  const state = server.enabled === false ? ' · disabled' : ''
  const dialect = effectiveDialect(server)
  return `- ${server.name} — ${target} · ${dialect}${state}${factsSummary(server)}`
}

/** Compact facts summary (hostname only: stable, not a stale capacity snapshot). */
function factsSummary(server) {
  const facts = server?.facts
  if (!facts || typeof facts !== 'object') return ''
  const hostname = typeof facts.hostname === 'string' ? facts.hostname.trim() : ''
  return hostname ? ` · ${hostname}` : ''
}

function localShellName(hostPlatform) {
  return hostPlatform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * Render the model-facing managed-resource context.
 *
 * @param {object[]} servers managed inventory
 * @param {{
 *   candidates?: string[],
 *   lastExecuted?: string|null,
 *   hostPlatform?: 'win32'|'posix',
 *   maxServers?: number,
 * }} [hints]
 */
export function renderManagedContext(servers, hints = {}) {
  const inventory = Array.isArray(servers) ? servers.filter(Boolean) : []
  if (inventory.length === 0) return ''
  const maxServers = Number.isInteger(hints.maxServers) && hints.maxServers > 0
    ? hints.maxServers
    : DEFAULT_MAX_CONTEXT_SERVERS
  const listed = inventory.slice(0, maxServers)
  const lines = [`[ssh-workbench] Managed remote resources (${inventory.length}):`]
  for (const server of listed) lines.push(serverLine(server))
  if (inventory.length > listed.length) {
    lines.push(`- … and ${inventory.length - listed.length} more; call remote_exec with a resource name from the workbench UI.`)
  }
  lines.push('Remote execution rules:')
  lines.push(
    `- The native ${localShellName(hints.hostPlatform)} tool always runs on the local DSH host. Never use it for commands meant for a remote resource.`,
  )
  lines.push(
    '- POSIX resources: remote_bash({ server: "<name>", command: "<command>", workdir?, timeoutMs?, run_in_background? }).',
  )
  lines.push(
    '- Windows resources: remote_pwsh({ server: "<name>", command: "<command>", ... }).',
  )
  lines.push(
    '- Several resources in one step: remote_exec({ tasks: [{ server: "<name>", command: "<command>" }], concurrency? }). Tasks run concurrently and never depend on a remembered target.',
  )
  lines.push(
    '- Pass server explicitly on every call. The resource names above are authoritative; never read ~/.dsh/ssh-workbench/servers.json or other config files to find them.',
  )
  lines.push(
    '- read/write/edit/glob/grep are the native local file tools; they never touch a remote resource.',
  )
  lines.push(
    '- Remote files: remote_read({ server, path, maxBytes? }), remote_glob({ server, pattern, path?, maxResults?, maxDepth? }) and remote_grep({ server, pattern, path?, ignoreCase?, maxResults? }). Use absolute paths or paths under ~.',
  )
  if (hints.remoteFileWrite === true) {
    lines.push(
      '- Remote writes are enabled: remote_write({ server, path, content }) and remote_edit({ server, path, oldText, newText, replaceAll? }). remote_edit requires one exact match unless replaceAll=true.',
    )
  } else {
    lines.push(
      '- Remote writes are disabled by config: remote_write/remote_edit will refuse. Use the workbench SFTP panel for uploads, or ask the user to enable remoteFileWrite.',
    )
  }
  const candidates = Array.isArray(hints.candidates) ? hints.candidates.filter(Boolean) : []
  if (candidates.length > 0) {
    lines.push(
      `- The user mentioned: ${candidates.join(', ')}. Prefer these resources when the request is ambiguous, but still pass server explicitly.`,
    )
  }
  const lastExecuted = typeof hints.lastExecuted === 'string' && hints.lastExecuted.length > 0
    ? hints.lastExecuted
    : null
  if (lastExecuted) lines.push(`- Last remote execution in this conversation: ${lastExecuted}.`)
  lines.push(
    '- If no resource is named and the request does not identify one, ask the user or use the resource named in the request; do not guess silently.',
  )
  return lines.join('\n')
}

/**
 * Build one user-role context message, preferring the host's message factory.
 * `@` symbols are avoided so this message can never be re-matched as a mention.
 */
export function buildManagedContextMessage(servers, hints, createUserMessage) {
  const text = renderManagedContext(servers, hints)
  const source = {
    kind: TARGET_CONTEXT_KIND,
    form: 'notice',
    summary: 'managed remote resources',
  }
  const input = { content: [{ type: 'text', text }], source }
  if (typeof createUserMessage === 'function') return createUserMessage(input)
  return { role: 'user', id: `ssh-workbench-context-${randomUUID()}`, ...structuredClone(input) }
}

/**
 * Install the resource-context provider.
 *
 * @param {object} ctx plugin context
 * @param {{
 *   enabled?: boolean,
 *   remoteAvailable?: boolean,
 *   hostPlatform?: 'win32'|'posix',
 *   targets?: object,
 *   loadInventory?: () => object[],
 *   loadLastExecuted?: (sessionId: string) => string|null,
 *   createUserMessage?: Function,
 * }} [options]
 */
export function installManagedContext(ctx, options = {}) {
  const enabled = options.enabled !== false
  const remoteAvailable = options.remoteAvailable !== false
  const loadInventory = options.loadInventory ?? loadServers
  const targets = options.targets ?? createTargetStore({ loadInventory })
  const maxContextServers = Number.isInteger(options.maxContextServers) && options.maxContextServers > 0
    ? options.maxContextServers
    : DEFAULT_MAX_CONTEXT_SERVERS
  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(`dsh-ssh-workbench: ${message}`)
    } catch {
      // Logging must never fail the plugin.
    }
  }
  if (!ctx || typeof ctx.on !== 'function') return { targets }

  let factory = options.createUserMessage
  const messageFactory = async () => {
    if (factory !== undefined) return factory
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      factory = typeof mod.createUserMessage === 'function' ? mod.createUserMessage : null
    } catch {
      factory = null
    }
    return factory
  }

  const handler = async (payload, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject' || payload?.signal?.aborted) return decision
      if (enabled === false) return decision
      // Never describe a remote world the Host cannot execute in.
      if (!remoteAvailable) return decision
      const agent = payload?.agent
      const session = agent?.session
      const key = session?.id ?? agent?.id
      if (typeof key !== 'string' || key.length === 0) return decision
      let servers
      try {
        servers = loadInventory()
      } catch (error) {
        warn(`inventory unavailable: ${describeError(error)}`)
        return decision
      }
      if (!Array.isArray(servers) || servers.length === 0) return decision
      // Restore resumed-Session mention hints once; deriveMessages() is
      // intentionally skipped on later steps.
      if (targets.get(key)?.seeded !== true) {
        try {
          const history = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
          targets.ensureSeeded(key, history, servers)
        } catch {
          targets.ensureSeeded(key, [], servers)
        }
      }
      const human = lastHumanMessage(decision.messages)
      const mentions = human ? extractServerMentions(extractUserText(human), servers) : []
      const state = targets.bindMentions(key, mentions, human?.id)
      if (!state) return decision
      const changed = state.version !== state.injectedVersion
      const firstStep = payload?.step === 1
      if (!changed) {
        if (!firstStep) return decision
        // One context message per turn is enough while it is still present in
        // the step messages. Re-inject after compaction or a new human turn.
        const hasContext = decision.messages.some((message) => message?.source?.kind === TARGET_CONTEXT_KIND)
        if (hasContext) return decision
      }
      let lastExecuted = null
      try {
        lastExecuted = typeof options.loadLastExecuted === 'function' ? options.loadLastExecuted(key) : null
      } catch {
        lastExecuted = null
      }
      const hints = {
        candidates: state.candidates,
        lastExecuted: typeof lastExecuted === 'string' && lastExecuted.length > 0 ? lastExecuted : null,
        hostPlatform: options.hostPlatform,
        maxServers: maxContextServers,
      }
      const message = buildManagedContextMessage(servers, hints, await messageFactory())
      targets.markInjected(key, state.version)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      warn(`resource context skipped: ${describeError(error)}`)
      return decision
    }
  }

  const offPreStep = ctx.on('agent/pre-step', handler, { prepend: true })
  const offDisposed = ctx.on('agent/disposed', (disposed) => {
    try {
      const session = disposed?.agent?.session
      const key = session?.id ?? disposed?.agent?.id
      if (typeof key === 'string') targets.clear(key)
    } catch {
      // Best effort cleanup.
    }
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        try {
          offPreStep?.()
        } catch {
          // Disposal is best effort.
        }
        try {
          offDisposed?.()
        } catch {
          // Disposal is best effort.
        }
        targets.clearAll?.()
      },
      'dsh-ssh-workbench: resource context',
    )
  }
  return { targets, offPreStep, offDisposed }
}

/** Names that deserve a compact line in the model context. */
export function contextResourceNames(servers) {
  return serverNameList(servers)
}
