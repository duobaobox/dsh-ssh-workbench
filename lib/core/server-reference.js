/**
 * Target context for @server mentions.
 *
 * The composer inserts an `@name` chip as plain text, so the model can read it
 * as a teammate mention. This module turns matches against the managed
 * inventory into (a) the session's active remote target and (b) one compact
 * user-role context message that tells the model where `bash` runs and how to
 * switch targets.
 *
 * The injected message enters the same step (`agent/pre-step` replaces the
 * messages that enter a step), which `agent.inject()` cannot promise because it
 * splices into the next step. The decision is spread so fields such as
 * `startsRequestSeries` survive.
 *
 * Scope: every agent mode; no preset gating.
 */
import { randomUUID } from 'node:crypto'

import { effectiveDialect } from './dialect.js'
import { loadServers } from './store.js'
import {
  LOCAL_TARGET,
  TARGET_CONTEXT_KIND,
  TARGET_TOOL_NAME,
  createTargetStore,
  extractServerMentions,
  extractUserText,
  lastHumanMessage,
} from './targets.js'

export { TARGET_CONTEXT_KIND, TARGET_TOOL_NAME }

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

/**
 * Resolve the copy dialect for one Host.
 *
 * `remoteToolName` is the tool that actually executes on the target: the native
 * `bash` tool on POSIX Hosts, the plugin-owned `remote_bash` tool on Windows
 * Hosts (where DSH ships no bash). The context must describe the tool the model
 * really has, never a tool name that cannot exist on this Host.
 */
function contextOptions(options = {}) {
  const hostOs = options.hostPlatform === 'win32' ? 'win32' : 'posix'
  const remoteToolName =
    typeof options.remoteToolName === 'string' && options.remoteToolName.length > 0
      ? options.remoteToolName
      : hostOs === 'win32'
        ? 'remote_bash'
        : 'bash'
  const windowsToolName =
    typeof options.windowsToolName === 'string' && options.windowsToolName.length > 0 ? options.windowsToolName : 'remote_pwsh'
  return { hostOs, remoteToolName, windowsToolName }
}

/**
 * Render the model-facing target context.
 * @param {{ active: string|null, candidates: string[] }} state
 * @param {object[]} servers managed inventory
 * @param {{ hostPlatform?: 'win32'|'posix', remoteToolName?: string, windowsToolName?: string }} [options]
 */
export function renderTargetContext(state, servers, options = {}) {
  const { hostOs, remoteToolName, windowsToolName } = contextOptions(options)
  const byName = new Map()
  for (const server of servers ?? []) byName.set(server.name, server)
  const lines = ['[ssh-workbench] Managed server context:']
  if (typeof state?.active === 'string' && state.active.length > 0) {
    const server = byName.get(state.active)
    lines.push(server ? serverLine(server) : `- ${state.active}`)
    const activeDialect = effectiveDialect(server)
    if (activeDialect === 'windows') {
      lines.push(
        `The ${windowsToolName} tool runs PowerShell commands on ${state.active} over SSH; pass ${windowsToolName}.workdir to change its working directory.`,
      )
      lines.push(`The native ${hostOs === 'win32' ? 'pwsh' : 'bash'} tool always runs on the local DSH host: never use it for commands meant for ${state.active}.`)
      lines.push(
        `read/write/edit/glob/grep always run on the local DSH host: never use write/edit for remote files — change them through ${windowsToolName} or the GUI SFTP panel.`,
      )
      lines.push(`Do not use ssh/scp inside ${windowsToolName} to reach other servers; switch targets with ${TARGET_TOOL_NAME}.`)
      lines.push('After a state change, verify the result before reporting; exit code 0 does not prove success.')
      lines.push(`Switch target: ${TARGET_TOOL_NAME}({ server: "<name>" }); detach: server: "${LOCAL_TARGET}".`)
      return lines.join('\n')
    }
    if (hostOs === 'win32') {
      lines.push(
        `The ${remoteToolName} tool runs POSIX shell commands on ${state.active} over SSH; pass ${remoteToolName}.workdir to change its working directory.`,
      )
      lines.push(`The native pwsh tool always runs on the local DSH host: never use it for commands meant for ${state.active}.`)
      lines.push(
        `read/write/edit/glob/grep always run on the local DSH host: never use write/edit for remote files — change them through ${remoteToolName} (heredoc, sed -i) or the GUI SFTP panel.`,
      )
      lines.push(`Do not use ssh/scp inside ${remoteToolName} to reach other servers; switch targets with ${TARGET_TOOL_NAME}.`)
    } else {
      lines.push(`The ${remoteToolName} tool runs on ${state.active}; pass ${remoteToolName}.workdir to change its working directory.`)
      lines.push(
        `read/write/edit/glob/grep always run on the local DSH host: never use write/edit for remote files — change them through ${remoteToolName} (heredoc, sed -i) or the GUI SFTP panel.`,
      )
      lines.push(`Do not use ssh/scp inside ${remoteToolName} to reach other servers; switch targets with ${TARGET_TOOL_NAME}.`)
    }
    lines.push('After a state change, verify the result before reporting; exit code 0 does not prove success.')
    lines.push(`Switch target: ${TARGET_TOOL_NAME}({ server: "<name>" }); detach: server: "${LOCAL_TARGET}".`)
    return lines.join('\n')
  }
  const candidates = Array.isArray(state?.candidates) ? state.candidates : []
  const listed = candidates.map((name) => byName.get(name)).filter(Boolean)
  for (const server of listed) lines.push(serverLine(server))
  if (listed.length === 0) lines.push(`- (unresolved: ${candidates.join(', ')})`)
  if (hostOs === 'win32') {
    lines.push(
      `The native pwsh tool runs on the local DSH host; ${remoteToolName} only runs after you choose a target with ${TARGET_TOOL_NAME}({ server: "<name>" }).`,
    )
    lines.push(
      `read/write/edit/glob/grep always run on the local DSH host: remote files are only reachable through ${remoteToolName}.`,
    )
  } else {
    lines.push(
      `${remoteToolName} still runs on the local DSH host until you choose a target with ${TARGET_TOOL_NAME}({ server: "<name>" }).`,
    )
    lines.push(`read/write/edit/glob/grep always run on the local DSH host: remote files are only reachable through ${remoteToolName}.`)
  }
  return lines.join('\n')
}

/**
 * Build one user-role context message, preferring the host's message factory.
 * `@` symbols are avoided so this message can never be re-matched as a mention.
 */
export function buildTargetContextMessage(state, servers, createUserMessage, options = {}) {
  const text = renderTargetContext(state, servers, options)
  const source = {
    kind: TARGET_CONTEXT_KIND,
    form: 'notice',
    summary: state?.active ? `remote target: ${state.active}` : 'remote target not selected',
  }
  const input = { content: [{ type: 'text', text }], source }
  if (typeof createUserMessage === 'function') return createUserMessage(input)
  return { role: 'user', id: `ssh-workbench-target-${randomUUID()}`, ...structuredClone(input) }
}

/**
 * Install the target binding + context provider.
 *
 * @param {object} ctx plugin context
 * @param {{
 *   enabled?: boolean,
 *   remoteAvailable?: boolean,
 *   hostPlatform?: 'win32'|'posix',
 *   remoteToolName?: string,
 *   windowsToolName?: string,
 *   ensureDialect?: (server: object) => Promise<string|undefined>,
 *   targets?: object,
 *   loadInventory?: () => object[],
 *   createUserMessage?: Function,
 * }} [options]
 */
export function installTargetContext(ctx, options = {}) {
  const enabled = options.enabled !== false
  const remoteAvailable = options.remoteAvailable !== false
  const contextOptions = {
    hostPlatform: options.hostPlatform,
    remoteToolName: options.remoteToolName,
    windowsToolName: options.windowsToolName,
  }
  const loadInventory = options.loadInventory ?? loadServers
  const targets = options.targets ?? createTargetStore({ loadInventory })
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
      // Never describe a remote world the Host cannot execute in: without a
      // working remote tool the model must keep treating every tool as local.
      if (!remoteAvailable) return decision
      const agent = payload?.agent
      const session = agent?.session
      const key = session?.id ?? agent?.id
      if (typeof key !== 'string' || key.length === 0) return decision
      let servers = loadInventory()
      // Restore a resumed Session's target from its durable human messages once;
      // deriveMessages() is intentionally skipped on every later step.
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
      const state = targets.bindMentions(key, mentions)
      if (!state) return decision
      // Describe the target in its real dialect. A fresh record may not have a
      // probe result yet; probing here (bounded) avoids telling the model to
      // use a POSIX shell against a Windows host for the whole first turn.
      const activeServer = state.active ? servers.find((entry) => entry.name === state.active) : undefined
      if (activeServer && typeof options.ensureDialect === 'function' && !activeServer.facts?.dialect) {
        try {
          await Promise.race([
            Promise.resolve().then(() => options.ensureDialect(activeServer)),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 2500)
              timer.unref?.()
            }),
          ])
          servers = loadInventory()
        } catch {
          // Keep the record hint when probing fails.
        }
      }
      const needsChoice = state.candidates.length > 1 && !state.active
      if (!state.active && !needsChoice) return decision
      const changed = state.version !== state.injectedVersion
      const firstStep = payload?.step === 1
      if (!changed) {
        if (!firstStep) return decision
        // One context message per turn is enough while it is still present in
        // the step messages (it is committed to the session like other runtime
        // context). Re-inject after compaction or when the target changed.
        const hasContext = decision.messages.some((message) => message?.source?.kind === TARGET_CONTEXT_KIND)
        if (hasContext) return decision
      }
      const message = buildTargetContextMessage(state, servers, await messageFactory(), contextOptions)
      targets.markInjected(key, state.version)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      warn(`target context skipped: ${describeError(error)}`)
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
      'dsh-ssh-workbench: target context',
    )
  }
  return { targets, offPreStep, offDisposed }
}
