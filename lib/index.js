/**
 * dsh-ssh-workbench host half.
 *
 * Remote execution is deliberately not a second toolbox: on POSIX Hosts the
 * plugin gives DSH's own `bash` tool a remote execution world, and when a
 * Session has no active managed target every tool behaves exactly as shipped.
 * Windows Hosts ship no `bash` tool at all (DSH disables it by platform), so
 * there the plugin registers the standalone `remote_bash` tool instead. A
 * single `ssh_workbench_target` tool switches the active target, and a synchronous
 * `ctx.tools.guard()` blacklist is the fallback safety net.
 */
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { loadServers, saveServers } from './core/store.js'
import { loadPrefs, savePrefs } from './core/prefs.js'
import { createTerminalHub } from './core/terminals.js'
import { createLocalFs } from './core/localfs.js'
import { createSecretStore } from './core/secrets.js'
import { createKnownHosts } from './core/known-hosts.js'
import { createSshRuntime } from './core/ssh.js'
import { createActivityStore } from './core/activity.js'
import { createTargetStore, TARGET_TOOL_NAME, LOCAL_TARGET } from './core/targets.js'
import { createBlacklistGuard } from './core/guard.js'
import { createRemoteBashRouter } from './core/remote-bash.js'
import { createRemoteShellTool } from './core/remote-bash-tool.js'
import { createRemoteExecTool } from './core/remote-exec-tool.js'
import { posixAdapter, win32Adapter } from './core/shell-adapters.js'
import { effectiveDialect } from './core/dialect.js'
import { hostPlatform } from './core/shell-adapters.js'
import { installTargetContext } from './core/server-reference.js'
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
  // Inject the `@server` target context into the step and bind the session's
  // remote target. Disable to keep every native tool strictly local.
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
export function publicConfig(config) {
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
    transferChunkTimeoutMs: config.transferChunkTimeoutMs,
    connectionPool: config.connectionPool !== false,
    poolIdleMs: config.poolIdleMs,
    prewarm: config.prewarm !== false,
    targetContext: config.targetContext !== false,
  }
}

/**
 * The only model-facing tool this plugin registers. It never executes a
 * command; it selects the managed server the native `bash` tool runs on.
 */
export function createTargetTool({
  targets,
  loadInventory,
  onActivated,
  remoteToolName = 'bash',
  windowsToolName = 'remote_pwsh',
  hostPlatform: hostOs = 'posix',
}) {
  const description =
    hostOs === 'win32'
      ? `Select the managed remote resource (server or VM) that this session's remote shell tools run on. Pass a managed resource name or id, or "local" to return to the local DSH host. Only one target is active at a time; the native pwsh tool and read/write/edit/glob/grep always run on the local DSH host. Remote POSIX targets run through ${remoteToolName}; Windows targets run through ${windowsToolName}. For several resources in one step, call remote_exec with an explicit server per task instead of switching this target.`
      : `Select the managed remote resource (server or VM) that this session's remote shell runs on. Pass a managed resource name or id, or "local" to return to the local DSH host. Only one target is active at a time; read/write/edit/glob/grep always run on the local DSH host. POSIX targets run through the native ${remoteToolName} tool; Windows targets run through ${windowsToolName}. For several resources in one step, call remote_exec with an explicit server per task instead of switching this target.`
  return defineTool({
    name: TARGET_TOOL_NAME,
    description,
    parameters: {
      server: { type: 'string', required: true, description: `Managed resource name or id, or "${LOCAL_TARGET}" to detach` },
    },
    output: textOut,
    async execute(args, exec) {
      const session = exec?.agent?.session
      const key = session?.id ?? exec?.agent?.id
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('ssh_workbench_target requires an agent session')
      }
      const servers = loadInventory()
      const outcome = targets.setActive(key, String(args.server ?? '').trim(), servers)
      if (!outcome.ok) {
        const available = servers
          .filter((server) => server.enabled !== false)
          .slice(0, 20)
          .map((server) => server.name)
          .join(', ')
        throw new Error(`${outcome.error}. Available targets: ${available || '(none)'}; or "${LOCAL_TARGET}".`)
      }
      const state = outcome.state
      if (!state.active) {
        return { text: `active target: ${LOCAL_TARGET} — ${localShellSentence(hostOs)}.` }
      }
      const server = servers.find((entry) => entry.name === state.active)
      const target = server ? `${server.username}@${server.host}:${server.port}` : state.active
      // Probing the dialect before answering makes the next injected context
      // name the right tool. It is bounded: a slow/unreachable host must not
      // stall target selection.
      let dialect = server ? effectiveDialect(server) : undefined
      if (server && typeof onActivated === 'function') {
        try {
          const facts = await Promise.race([
            Promise.resolve().then(() => onActivated(server)),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 4000)
              timer.unref?.()
            }),
          ])
          if (facts?.dialect) dialect = facts.dialect
        } catch {
          // Keep the record hint.
        }
      }
      if (dialect === 'windows') {
        return {
          text: `active target: ${state.active} (${target}); ${windowsToolName} runs PowerShell commands there; read/write/edit/glob/grep run on the local DSH host.`,
        }
      }
      return {
        text: `active target: ${state.active} (${target}); ${remoteToolName} runs remotely on this resource; read/write/edit/glob/grep run on the local DSH host.`,
      }
    },
  })
}

/** One sentence describing where the native shell tool runs on this Host. */
function localShellSentence(hostOs) {
  return hostOs === 'win32'
    ? 'the native pwsh tool runs on the local DSH host; no remote target is selected'
    : 'bash runs on the local DSH host'
}

/** Expand a configured `~` prefix; relative/invalid values are left for the caller. */
export function expandLocalRoot(value) {
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
  // Hosts ship different native shell tools: DSH disables `bash` on win32 and
  // `pwsh` elsewhere. The remote tool therefore depends on the Host, not on a
  // global assumption; tests can pin it through deps.hostPlatform.
  const hostOs = hostPlatform(deps.hostPlatform ?? process.platform)
  const isWindowsHost = hostOs === 'win32'
  const remoteToolName = isWindowsHost ? 'remote_bash' : 'bash'
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

  // ── model-facing tools: target selector + dialect-specific remote shells ───
  if (typeof ctx.tools?.register === 'function') {
    const targetTool = createTargetTool({
      targets,
      loadInventory,
      onActivated: (server) => refreshServerFacts(server),
      remoteToolName,
      windowsToolName: 'remote_pwsh',
      hostPlatform: hostOs,
    })
    const offTool = ctx.tools.register(targetTool)
    if (typeof offTool === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => offTool, 'dsh-ssh-workbench: target tool')
    }

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

    // Multi-resource fan-out: every task carries its own target, so this
    // tool does not read or change the session's active target. It is present
    // on both Hosts and is safe to run concurrently with the shell tools.
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

    // Windows targets are not covered by any native tool on either Host.
    remoteAvailable =
      registerRemote(
        createRemoteShellTool({
          runtime,
          targets,
          config,
          loadInventory,
          recordActivity,
          adapter: win32Adapter,
          localShellName: isWindowsHost ? 'pwsh' : 'bash',
        }),
        'remote pwsh tool',
      ) || remoteAvailable
    // Windows Hosts also have no native bash, so POSIX targets need the
    // plugin-owned tool there; POSIX Hosts keep the native bash router below.
    if (isWindowsHost) {
      remoteAvailable =
        registerRemote(
          createRemoteShellTool({
            runtime,
            targets,
            config,
            loadInventory,
            recordActivity,
            adapter: posixAdapter,
            localShellName: 'pwsh',
          }),
          'remote bash tool',
        ) || remoteAvailable
    }
  }

  // ── fallback blacklist: deny-only, synchronous, monotonic ──────────────────
  if (typeof ctx.tools?.guard === 'function') {
    const offGuard = ctx.tools.guard(createBlacklistGuard({ targets, recordActivity, loadInventory }))
    if (typeof offGuard === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => offGuard, 'dsh-ssh-workbench: blacklist guard')
    }
  } else {
    ctx.logger?.warn?.('dsh-ssh-workbench: ctx.tools.guard() is unavailable; the destructive-command blacklist is disabled')
  }

  // ── route the native bash tool to the active managed target (POSIX Hosts) ──
  if (!isWindowsHost && typeof ctx.on === 'function') {
    const router = createRemoteBashRouter({ runtime, targets, config, loadInventory, recordActivity })
    const offExecute = ctx.on('tools/execute', router)
    if (typeof offExecute === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => offExecute, 'dsh-ssh-workbench: remote bash router')
    }
    remoteAvailable = true
  }

  // ── @server → session target + one compact context message per turn ────────
  // The context is only injected when this Host really has a remote execution
  // path; otherwise it would tell the model that a tool runs remotely when no
  // such tool exists (the Windows-without-remote_bash failure mode).
  if (config.targetContext !== false) {
    installTargetContext(ctx, {
      targets,
      loadInventory,
      createUserMessage: deps.createUserMessage,
      remoteAvailable,
      hostPlatform: hostOs,
      remoteToolName,
      windowsToolName: 'remote_pwsh',
      ensureDialect: (server) => refreshServerFacts(server),
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
      refreshFacts: (server) => refreshServerFacts(server),
      activity,
      prefs: { load: () => loadPrefs(), save: (patch) => savePrefs(patch) },
      terminals,
      localfs,
      publicConfig: () => publicConfig(config),
    }),
  )
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeRoutes, 'dsh-ssh-workbench: routes')
  }
}
