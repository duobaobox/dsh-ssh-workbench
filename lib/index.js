/**
 * dsh-ssh-workbench host half.
 *
 * Local and remote execution are two separate worlds. The native shell tools
 * always run on the local DSH Host; remote work always names its target on the
 * tool call (`remote_bash`, `remote_pwsh`, `remote_exec`). There is no
 * session-scoped target state and no native shell interception, so a follow-up
 * without a new `@mention` can never move a command silently to a different
 * machine. A synchronous `ctx.tools.guard()` blacklist is the fallback safety
 * net for every explicit remote target.
 */
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { loadServers, saveServers } from './core/store.js'
import { loadPrefs, savePrefs, resolveRemoteFileWrite, resolveSystemFileHierarchy } from './core/prefs.js'
import { createTerminalHub } from './core/terminals.js'
import { createLocalFs } from './core/localfs.js'
import { createSecretStore } from './core/secrets.js'
import { createKnownHosts } from './core/known-hosts.js'
import { createSshRuntime } from './core/ssh.js'
import { createActivityStore } from './core/activity.js'
import { createTargetStore } from './core/mentions.js'
import { createBlacklistGuard } from './core/guard.js'
import { createRemoteShellTool } from './core/remote-shell-tool.js'
import { createRemoteExecTool } from './core/remote-exec-tool.js'
import { createRemoteFileTools } from './core/remote-file-tools.js'
import { createLiveExecutions } from './core/live-executions.js'
import { posixAdapter, win32Adapter, hostPlatform } from './core/shell-adapters.js'
import { installManagedContext } from './core/managed-context.js'
import { createRoutes, registerRoutes } from './routes.js'

export const name = 'dsh-ssh-workbench'

/** Hard dependencies only; optional services are resolved lazily. */
export const inject = ['tools']

export const Config = z.object({
  connectTimeoutMs: z.natural().default(15000),
  // Default timeout for one remote bash command. The model may override it per
  // call through bash's own `timeoutMs` parameter, up to maxCommandTimeoutMs.
  commandTimeoutMs: z.natural().default(120000),
  maxCommandTimeoutMs: z.natural().default(1800000),
  // How long the remote `timeout -k` wrapper waits after SIGTERM before
  // SIGKILL. 0 disables the hard kill (TERM only).
  timeoutKillAfterMs: z.natural().default(5000),
  maxOutputBytes: z.natural().default(102400),
  // stderr is capped separately so one chatty failing command cannot flood the
  // model context (stdout keeps maxOutputBytes).
  maxStderrBytes: z.natural().default(16384),
  // `remote_exec` fan-out: tasks per call, concurrent SSH channels, and the
  // total stdout/stderr budget for one batch (shared across all tasks).
  maxBatchTasks: z.natural().default(8),
  batchConcurrency: z.natural().default(4),
  maxBatchOutputBytes: z.natural().default(262144),
  // Explicit remote file tools: read/glob/grep are always available; write and
  // edit stay disabled until an operator opts in. All sizes are bytes.
  remoteFileReadBytes: z.natural().default(262144),
  remoteFileEditBytes: z.natural().default(2097152),
  remoteFileWrite: z.boolean().default(false),
  // Replaces the native right-sidebar files page with the hierarchical local
  // browser when enabled. Off by default so DSH's own file page is untouched.
  systemFileHierarchy: z.boolean().default(false),
  remoteGlobMaxResults: z.natural().default(200),
  remoteGlobMaxDepth: z.natural().default(4),
  remoteGrepMaxResults: z.natural().default(200),
  // A stalled SFTP chunk (half-open connection) fails after this long instead
  // of hanging the file panel; the client can resume from its offset.
  transferChunkTimeoutMs: z.natural().default(30000),
  hostKeyMode: z.string().default('strict'),
  connectionPool: z.boolean().default(true),
  poolIdleMs: z.natural().default(90000),
  poolMaxServers: z.natural().default(8),
  maxChannelsPerServer: z.natural().default(6),
  // Warm a server connection when the user selects it in the UI.
  prewarm: z.boolean().default(true),
  // Inject the managed-resource context into every human turn. Disable only
  // for a deliberately remote-blind session.
  targetContext: z.boolean().default(true),
  // Root of the workbench's local side (local terminal cwd + local file
  // panel). Empty = the OS user home directory, matching the local pane of
  // regular SSH clients. Set an absolute path (or `~/...`) to pin another
  // directory; it is still confined to that root by localfs.
  localRoot: z.string().default(''),
})

const APPLY_DEFAULTS = {
  connectTimeoutMs: 15000,
  commandTimeoutMs: 120000,
  maxCommandTimeoutMs: 1800000,
  timeoutKillAfterMs: 5000,
  maxOutputBytes: 102400,
  maxStderrBytes: 16384,
  maxBatchTasks: 8,
  batchConcurrency: 4,
  maxBatchOutputBytes: 262144,
  remoteFileReadBytes: 262144,
  remoteFileEditBytes: 2097152,
  remoteFileWrite: false,
  systemFileHierarchy: false,
  remoteGlobMaxResults: 200,
  remoteGlobMaxDepth: 4,
  remoteGrepMaxResults: 200,
  transferChunkTimeoutMs: 30000,
  hostKeyMode: 'strict',
  connectionPool: true,
  poolIdleMs: 90000,
  poolMaxServers: 8,
  maxChannelsPerServer: 6,
  prewarm: true,
  targetContext: true,
  localRoot: '',
}

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

export { APPLY_DEFAULTS }

/** Public settings safe to show in the Client settings/state page. */
export function publicConfig(config, prefs) {
  return {
    hostKeyMode: config.hostKeyMode,
    connectTimeoutMs: config.connectTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    maxCommandTimeoutMs: config.maxCommandTimeoutMs,
    timeoutKillAfterMs: config.timeoutKillAfterMs,
    maxOutputBytes: config.maxOutputBytes,
    maxStderrBytes: config.maxStderrBytes,
    maxBatchTasks: config.maxBatchTasks,
    batchConcurrency: config.batchConcurrency,
    maxBatchOutputBytes: config.maxBatchOutputBytes,
    remoteFileReadBytes: config.remoteFileReadBytes,
    remoteFileEditBytes: config.remoteFileEditBytes,
    remoteFileWrite: resolveRemoteFileWrite(config, prefs),
    systemFileHierarchy: resolveSystemFileHierarchy(config, prefs),
    remoteGlobMaxResults: config.remoteGlobMaxResults,
    remoteGlobMaxDepth: config.remoteGlobMaxDepth,
    remoteGrepMaxResults: config.remoteGrepMaxResults,
    transferChunkTimeoutMs: config.transferChunkTimeoutMs,
    connectionPool: config.connectionPool !== false,
    poolIdleMs: config.poolIdleMs,
    prewarm: config.prewarm !== false,
    targetContext: config.targetContext !== false,
  }
}

/** Expand a configured `~` prefix; relative/invalid values are left for the caller. */
function expandLocalRoot(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  return raw === '~'
    ? os.homedir()
    : raw.startsWith('~/') || raw.startsWith('~' + path.sep)
      ? path.join(os.homedir(), raw.slice(2))
      : raw
}

/** Workbench local root: configured absolute path (or `~/...`), else user home. */
export function resolveLocalRoot(config = {}) {
  const expanded = expandLocalRoot(config?.localRoot)
  if (!expanded || !path.isAbsolute(expanded)) return os.homedir()
  return path.normalize(expanded)
}

/**
 * @param {object} ctx Cordis plugin context
 * @param {object} [config] plugin Config
 * @param {{
 *   runtime?: object,
 *   secrets?: object,
 *   knownHosts?: object,
 *   targets?: object,
 *   loadInventory?: () => object[],
 *   createUserMessage?: Function,
 *   hostPlatform?: 'win32'|'posix',
 * }} [deps] explicit seams used by tests
 */
export function apply(ctx, config, deps = {}) {
  config = { ...APPLY_DEFAULTS, ...(config ?? {}) }
  // The native shell tool differs per Host, but remote tools are explicit:
  // both dialect tools are registered on both Hosts.
  const hostOs = hostPlatform(deps.hostPlatform ?? process.platform)
  const isWindowsHost = hostOs === 'win32'
  const localShellName = isWindowsHost ? 'pwsh' : 'bash'
  let remoteAvailable = false
  if (config.hostKeyMode !== 'strict' && config.hostKeyMode !== 'accept-new') {
    ctx.logger?.warn?.('dsh-ssh-workbench: unknown hostKeyMode value, falling back to strict', { value: config.hostKeyMode })
    config.hostKeyMode = 'strict'
  }

  const loadInventory = deps.loadInventory ?? (() => loadServers())
  const secrets = deps.secrets ?? createSecretStore()
  const knownHosts = deps.knownHosts ?? createKnownHosts()
  const ownedRuntime = deps.runtime === undefined
  const runtime = deps.runtime ?? createSshRuntime({
    getSecret: (key) => secrets.get(key),
    knownHosts,
    config,
    log: (message, fields) => ctx.logger?.debug?.(message, fields),
  })
  if (ownedRuntime && typeof runtime.preload === 'function') {
    // Warm the optional native binding at load instead of paying it on the
    // first remote call.
    void runtime.preload().catch(() => {})
  }
  if (ownedRuntime && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void runtime.close?.()
    }, 'dsh-ssh-workbench: pooled ssh connections')
  }

  // Bounded local activity log for the overview page (not an audit log).
  const activity = deps.activity ?? createActivityStore()
  const recordActivity = (entry) => {
    try {
      activity.append(entry)
    } catch {
      // Activity recording is best effort and must never fail an operation.
    }
  }

  const targets = deps.targets ?? createTargetStore({ loadInventory })
  const liveExecutions = deps.liveExecutions ?? createLiveExecutions()

  /**
   * Collect a host's facts once and persist them on the server record.
   * Used by connection test / explicit refresh / target selection: the UI and
   * the injected target context can then show hostname and disk without a new
   * SSH round trip. Never throws (facts are optional metadata).
   */
  const refreshServerFacts = async (server) => {
    if (!server || typeof runtime.facts !== 'function') return undefined
    try {
      const result = await runtime.facts(server, { refresh: true })
      const facts = result?.facts
      if (!facts || typeof facts !== 'object') return undefined
      const merged = {
        ...(server.facts && typeof server.facts === 'object' ? server.facts : {}),
        ...facts,
        collectedAt: result.collectedAt ?? new Date().toISOString(),
      }
      const inventory = loadInventory()
      if (!inventory.some((entry) => entry.id === server.id)) return merged
      saveServers(inventory.map((entry) => (entry.id === server.id ? { ...entry, facts: merged } : entry)))
      return merged
    } catch {
      return undefined
    }
  }

  // ── model-facing tools: explicit-target remote shells + fan-out ────────────
  if (typeof ctx.tools?.register === 'function') {
    const registerRemote = (definition, label) => {
      try {
        const off = ctx.tools.register(definition)
        if (typeof off === 'function' && typeof ctx.effect === 'function') {
          ctx.effect(() => off, `dsh-ssh-workbench: ${label}`)
        }
        return true
      } catch (error) {
        ctx.logger?.warn?.(
          `dsh-ssh-workbench: ${definition?.name ?? label} could not be registered (${error instanceof Error ? error.message : String(error)}); remote execution for that dialect is unavailable`,
        )
        return false
      }
    }

    remoteAvailable =
      registerRemote(
        createRemoteExecTool({
          runtime,
          config,
          loadInventory,
          recordActivity,
        }),
        'remote exec tool',
      ) || remoteAvailable

    remoteAvailable =
      registerRemote(
        createRemoteShellTool({
          runtime,
          config,
          loadInventory,
          recordActivity,
          adapter: posixAdapter,
          localShellName,
        }),
        'remote bash tool',
      ) || remoteAvailable

    remoteAvailable =
      registerRemote(
        createRemoteShellTool({
          runtime,
          config,
          loadInventory,
          recordActivity,
          adapter: win32Adapter,
          localShellName,
        }),
        'remote pwsh tool',
      ) || remoteAvailable

    for (const tool of createRemoteFileTools({ runtime, config, loadInventory, recordActivity })) {
      remoteAvailable = registerRemote(tool, `remote file tool: ${tool.name}`) || remoteAvailable
    }
  }

  // ── live execution indicator: display-only, never selects a target ─────────
  if (remoteAvailable) {
    const offLive = ctx.on?.('tools/execute', async (exec, next) => {
      const token = liveExecutions.begin(exec)
      try {
        return await next()
      } finally {
        liveExecutions.end(token)
      }
    })
    if (typeof offLive === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => offLive, 'dsh-ssh-workbench: live execution indicator')
    }
  }

  // ── fallback blacklist: deny-only, synchronous, monotonic ──────────────────
  if (typeof ctx.tools?.guard === 'function') {
    const offGuard = ctx.tools.guard(createBlacklistGuard({ recordActivity, loadInventory }))
    if (typeof offGuard === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => offGuard, 'dsh-ssh-workbench: blacklist guard')
    }
  } else {
    ctx.logger?.warn?.('dsh-ssh-workbench: ctx.tools.guard() is unavailable; the destructive-command blacklist is disabled')
  }

  // ── managed-resource context: one compact inventory + tool rules per turn ──
  // The context is only injected when this Host really has a remote execution
  // path; otherwise it would tell the model that a tool runs remotely when no
  // such tool exists.
  const loadLastExecuted = (sessionId) => {
    try {
      const entries = activity.list(200)
      const last = entries.find((entry) => entry?.kind === 'exec' && entry.sessionId === sessionId)
      return typeof last?.server === 'string' && last.server.length > 0 ? last.server : null
    } catch {
      return null
    }
  }
  if (config.targetContext !== false) {
    installManagedContext(ctx, {
      targets,
      loadInventory,
      loadLastExecuted,
      createUserMessage: deps.createUserMessage,
      remoteAvailable,
      hostPlatform: hostOs,
      maxContextServers: 20,
      loadRemoteFileWrite: () => resolveRemoteFileWrite(config, loadPrefs()),
    })
  }

  // ── UI data plane: inventory, credentials, connection test, SFTP panel ─────
  // Local workbench services: the terminal hub needs the Host PTY provider,
  // and the local file browser / terminal cwd share one root. The default is
  // the OS user home (what users expect from the local pane of an SSH client);
  // `localRoot` can pin another directory. All access stays confined by localfs.
  let subprocessService = null
  if (typeof ctx.inject === 'function') {
    ctx.inject(['subprocess'], (inner) => {
      subprocessService = inner.get('subprocess') ?? null
    })
  }
  const expandedLocalRoot = expandLocalRoot(config.localRoot)
  if (expandedLocalRoot && !path.isAbsolute(expandedLocalRoot)) {
    ctx.logger?.warn?.('dsh-ssh-workbench: localRoot is not an absolute path, falling back to the user home directory', {
      localRoot: config.localRoot,
    })
  }
  const localRoot = () => resolveLocalRoot(config)
  const terminals = deps.terminals ?? createTerminalHub({
    runtime,
    getSubprocess: () => subprocessService,
    getLocalCwd: localRoot,
  })
  const localfs = deps.localfs ?? createLocalFs({ getRoot: localRoot })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => terminals.dispose(), 'dsh-ssh-workbench: terminals')
  }

  const disposeRoutes = registerRoutes(
    ctx,
    createRoutes({
      loadServers: () => loadInventory(),
      saveServers: (servers) => saveServers(servers),
      runtime,
      secrets,
      knownHosts,
      targets,
      liveExecutions,
      refreshFacts: (server) => refreshServerFacts(server),
      activity,
      prefs: { load: () => loadPrefs(), save: (patch) => savePrefs(patch) },
      terminals,
      localfs,
      publicConfig: () => publicConfig(config, loadPrefs()),
    }),
  )
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeRoutes, 'dsh-ssh-workbench: routes')
  }
}
