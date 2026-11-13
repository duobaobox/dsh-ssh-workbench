/**
 * Explicit-target remote file tools.
 *
 * Shell-only remote access makes ordinary troubleshooting possible, but a
 * single `cat`/`sed`/`grep` command cannot express "read this file", "replace
 * this unique string" or "list files matching a glob" without brittle shell
 * quoting. These tools add a small, deliberately non-transparent file layer:
 * every call names its managed resource, reads and writes go through SFTP,
 * writes are gated by configuration, and every operation is capped.
 *
 * They are additive conveniences, not a remote IDE: the native local
 * `read/write/edit/glob/grep` tools keep their local semantics.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { describeResultOutcome } from './activity.js'
import { resolveDialect, sessionKeyOf } from './remote-shell-tool.js'
import { requireServerRef } from './server-ref.js'
import { win32Adapter } from './win32-adapter.js'

export const REMOTE_READ_TOOL_NAME = 'remote_read'
export const REMOTE_WRITE_TOOL_NAME = 'remote_write'
export const REMOTE_EDIT_TOOL_NAME = 'remote_edit'
export const REMOTE_GLOB_TOOL_NAME = 'remote_glob'
export const REMOTE_GREP_TOOL_NAME = 'remote_grep'

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

const MAX_READ_HARD_LIMIT = 64 * 1024 * 1024
const MAX_EDIT_HARD_LIMIT = 8 * 1024 * 1024
const MAX_RESULTS_HARD_LIMIT = 2000
const MAX_DEPTH_HARD_LIMIT = 12

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function integerIn(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.max(min, Math.min(value, max)) : fallback
}

function loadServer({ loadInventory, serverRef, toolName }) {
  let servers
  try {
    servers = loadInventory()
  } catch (error) {
    throw new Error(`cannot read the managed server inventory: ${describeError(error)}`)
  }
  return requireServerRef(servers, serverRef, { label: `${toolName} server` })
}

function normalizeRemotePath(value, dialect) {
  let path = String(value ?? '').trim()
  if (!path) throw new Error('path is required')
  if (path.includes('\0')) throw new Error('path must not contain NUL bytes')
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    return { home: true, path: path.slice(1) }
  }
  if (!(path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path))) {
    throw new Error(`path must be absolute or start with ~: ${path}`)
  }
  if (dialect === 'windows') path = path.replace(/\\/g, '/')
  return { home: false, path }
}

async function resolveRemotePath({ runtime, server, rawPath, dialect }) {
  const normalized = normalizeRemotePath(rawPath, dialect)
  let resolved
  if (normalized.home) {
    let home
    try {
      home = await runtime.sftpHome(server)
    } catch (error) {
      throw new Error(`cannot resolve the remote home directory: ${describeError(error)}`)
    }
    resolved = normalized.path ? `${home.replace(/[\\/]+$/, '')}/${normalized.path.replace(/^[\\/]+/, '')}` : home
  } else {
    resolved = normalized.path
  }
  return dialect === 'windows' ? resolved.replace(/\\/g, '/') : resolved
}

function joinRemotePath(parent, child) {
  return `${String(parent ?? '').replace(/[\\/]+$/, '')}/${String(child ?? '').replace(/^[\\/]+/, '')}`
}

function joinRelative(parent, child) {
  return parent ? `${parent}/${child}` : child
}

function globToRegExp(pattern) {
  let source = '^'
  const value = String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === '*') {
      if (value[index + 1] === '*') {
        index += 1
        if (value[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    }
  }
  source += '$'
  return new RegExp(source)
}

function matchesGlob(pattern, relativePath) {
  const normalized = String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  const target = normalized.includes('/') ? relativePath : relativePath.split('/').at(-1)
  return globToRegExp(normalized).test(target)
}

function renderHeader({ server, path, extra = [] }) {
  const target = `${server.username ?? 'root'}@${server.host}:${server.port ?? 22}`
  return [`target: ${server.name} (${target})`, path === undefined ? null : `path: ${path}`, ...extra].filter(
    (line) => line !== null,
  )
}

function describeActivityOutcome(outcome) {
  return typeof outcome === 'string' && outcome.length > 0 ? outcome : 'unknown'
}

function recordFileActivity({ recordActivity, server, sessionId, startedAt, command, outcome }) {
  if (typeof recordActivity !== 'function') return
  try {
    recordActivity({
      kind: 'exec',
      server: server.name,
      command,
      outcome,
      sessionId,
      durationMs: Date.now() - startedAt,
    })
  } catch {
    // Activity is best effort and must never fail a file operation.
  }
}

function assertWritesEnabled(config) {
  if (config?.remoteFileWrite !== true) {
    throw new Error(
      'remote file writes are disabled by configuration (remoteFileWrite=false); enable them in the plugin config before using remote_write or remote_edit',
    )
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

export function createRemoteReadTool({ runtime, config, loadInventory, recordActivity }) {
  return defineTool({
    name: REMOTE_READ_TOOL_NAME,
    description:
      'Read a text file from a managed remote resource through SFTP. The path must be absolute or start with ~. Binary files and files over the read limit are rejected/truncated; use the workbench SFTP panel for large or binary downloads.',
    parameters: {
      server: { type: 'string', required: true, description: 'Managed resource name or id.' },
      path: { type: 'string', required: true, description: 'Absolute remote path, or a path under ~.' },
      maxBytes: { type: 'number', description: 'Optional read cap in bytes (clamped by plugin config).' },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const server = loadServer({ loadInventory, serverRef: args?.server, toolName: 'remote_read' })
      const sessionId = sessionKeyOf(exec)
      try {
        const dialect = await resolveDialect(server, runtime)
        const path = await resolveRemotePath({ runtime, server, rawPath: args?.path, dialect })
        const cap = integerIn(config?.remoteFileReadBytes, 262144, 1024, MAX_READ_HARD_LIMIT)
        const maxBytes = integerIn(args?.maxBytes, cap, 1024, cap)
        const result = await runtime.sftpRead(server, path, { maxBytes })
        if (result?.binary === true) throw new Error(`remote file is binary: ${path}`)
        const lines = renderHeader({
          server,
          path,
          extra: [
            `size: ${result?.size ?? 'unknown'} bytes`,
            `read: ${result?.bytesRead ?? 0} bytes`,
            result?.truncated === true ? '[truncated by the configured read limit]' : null,
          ].filter(Boolean),
        })
        lines.push('content:')
        const content = typeof result?.content === 'string' ? result.content : ''
        lines.push(content.length === 0 ? '(empty)' : content.replace(/\n$/, ''))
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_read ${path}`,
          outcome: 'success',
        })
        return { text: lines.join('\n') }
      } catch (error) {
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_read ${String(args?.path ?? '')}`,
          outcome: `failed (${describeError(error)})`,
        })
        throw error
      }
    },
  })
}

export function createRemoteWriteTool({ runtime, config, loadInventory, recordActivity }) {
  return defineTool({
    name: REMOTE_WRITE_TOOL_NAME,
    description:
      'Write a UTF-8 text file on a managed remote resource through SFTP. Requires remoteFileWrite to be enabled in the plugin config. The parent directory must already exist; the file is created or overwritten.',
    parameters: {
      server: { type: 'string', required: true, description: 'Managed resource name or id.' },
      path: { type: 'string', required: true, description: 'Absolute remote path, or a path under ~.' },
      content: { type: 'string', required: true, description: 'Complete UTF-8 file content.' },
    },
    output: textOut,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertWritesEnabled(config)
      const startedAt = Date.now()
      const server = loadServer({ loadInventory, serverRef: args?.server, toolName: 'remote_write' })
      const sessionId = sessionKeyOf(exec)
      try {
        const dialect = await resolveDialect(server, runtime)
        const path = await resolveRemotePath({ runtime, server, rawPath: args?.path, dialect })
        const content = String(args?.content ?? '')
        const bytes = byteLength(content)
        const cap = integerIn(config?.remoteFileEditBytes, 2097152, 1024, MAX_EDIT_HARD_LIMIT)
        if (bytes > cap) throw new Error(`file content is ${bytes} bytes, over the ${cap}-byte write limit`)
        const result = await runtime.sftpWrite(server, path, content)
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_write ${path}`,
          outcome: 'success',
        })
        return {
          text: renderHeader({
            server,
            path,
            extra: [`wrote: ${result?.bytes ?? bytes} bytes`],
          }).join('\n'),
        }
      } catch (error) {
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_write ${String(args?.path ?? '')}`,
          outcome: `failed (${describeError(error)})`,
        })
        throw error
      }
    },
  })
}

export function createRemoteEditTool({ runtime, config, loadInventory, recordActivity }) {
  return defineTool({
    name: REMOTE_EDIT_TOOL_NAME,
    description:
      'Replace text in a UTF-8 file on a managed remote resource. By default oldText must match exactly once; set replaceAll=true to replace every occurrence. Requires remoteFileWrite to be enabled.',
    parameters: {
      server: { type: 'string', required: true, description: 'Managed resource name or id.' },
      path: { type: 'string', required: true, description: 'Absolute remote path, or a path under ~.' },
      oldText: { type: 'string', required: true, description: 'Exact text to find.' },
      newText: { type: 'string', required: true, description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
    },
    output: textOut,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertWritesEnabled(config)
      const startedAt = Date.now()
      const server = loadServer({ loadInventory, serverRef: args?.server, toolName: 'remote_edit' })
      const sessionId = sessionKeyOf(exec)
      try {
        const dialect = await resolveDialect(server, runtime)
        const path = await resolveRemotePath({ runtime, server, rawPath: args?.path, dialect })
        const oldText = String(args?.oldText ?? '')
        if (!oldText) throw new Error('oldText must not be empty')
        const newText = String(args?.newText ?? '')
        const cap = integerIn(config?.remoteFileEditBytes, 2097152, 1024, MAX_EDIT_HARD_LIMIT)
        const file = await runtime.sftpRead(server, path, { maxBytes: cap })
        if (file?.binary === true) throw new Error(`remote file is binary: ${path}`)
        if (file?.truncated === true) throw new Error(`remote file is larger than the ${cap}-byte edit limit: ${path}`)
        const source = typeof file?.content === 'string' ? file.content : ''
        const occurrences = source.split(oldText).length - 1
        if (occurrences === 0) throw new Error(`oldText was not found in ${path}`)
        if (occurrences > 1 && args?.replaceAll !== true) {
          throw new Error(`oldText occurs ${occurrences} times in ${path}; pass a longer unique string or set replaceAll=true`)
        }
        const next = args?.replaceAll === true ? source.split(oldText).join(newText) : source.replace(oldText, newText)
        if (byteLength(next) > cap) throw new Error(`edited file would exceed the ${cap}-byte write limit`)
        await runtime.sftpWrite(server, path, next)
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_edit ${path}`,
          outcome: 'success',
        })
        return {
          text: renderHeader({
            server,
            path,
            extra: [`replacements: ${args?.replaceAll === true ? occurrences : 1}`],
          }).join('\n'),
        }
      } catch (error) {
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_edit ${String(args?.path ?? '')}`,
          outcome: `failed (${describeError(error)})`,
        })
        throw error
      }
    },
  })
}

async function walkRemote({ runtime, server, root, pattern, maxDepth, maxResults }) {
  const results = []
  const queue = [{ directory: root, relative: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && results.length < maxResults && visited < maxResults * 20) {
    const current = queue.shift()
    let entries
    try {
      entries = await runtime.sftpList(server, current.directory)
    } catch (error) {
      if (current.depth === 0) throw error
      continue
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.type === 'link' || typeof entry.name !== 'string') continue
      visited += 1
      const relative = joinRelative(current.relative, entry.name)
      const path = entry.path ?? joinRemotePath(current.directory, entry.name)
      if (entry.type === 'dir') {
        if (current.depth < maxDepth) queue.push({ directory: path, relative, depth: current.depth + 1 })
      } else if (matchesGlob(pattern, relative)) {
        results.push({ path, relative, type: entry.type })
        if (results.length >= maxResults) break
      }
    }
  }
  return { results, truncated: results.length >= maxResults }
}

export function createRemoteGlobTool({ runtime, config, loadInventory, recordActivity }) {
  return defineTool({
    name: REMOTE_GLOB_TOOL_NAME,
    description:
      'Find files on a managed remote resource by glob through SFTP. Supports *, ? and **. Search path defaults to the remote home; symlinks are not followed; depth and result count are capped.',
    parameters: {
      server: { type: 'string', required: true, description: 'Managed resource name or id.' },
      pattern: { type: 'string', required: true, description: 'Glob pattern, e.g. "**/*.log" or "etc/*.conf".' },
      path: { type: 'string', description: 'Directory to search; defaults to the remote home directory.' },
      maxResults: { type: 'number', description: 'Optional result cap (clamped by plugin config).' },
      maxDepth: { type: 'number', description: 'Optional recursion depth (clamped by plugin config).' },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const server = loadServer({ loadInventory, serverRef: args?.server, toolName: 'remote_glob' })
      const sessionId = sessionKeyOf(exec)
      try {
        const dialect = await resolveDialect(server, runtime)
        const root = args?.path
          ? await resolveRemotePath({ runtime, server, rawPath: args.path, dialect })
          : await resolveRemotePath({ runtime, server, rawPath: '~', dialect })
        const pattern = String(args?.pattern ?? '').trim()
        if (!pattern) throw new Error('pattern is required')
        const maxResults = integerIn(args?.maxResults, config?.remoteGlobMaxResults ?? 200, 1, MAX_RESULTS_HARD_LIMIT)
        const maxDepth = integerIn(args?.maxDepth, config?.remoteGlobMaxDepth ?? 4, 0, MAX_DEPTH_HARD_LIMIT)
        const walked = await walkRemote({ runtime, server, root, pattern, maxDepth, maxResults })
        const lines = renderHeader({
          server,
          path: root,
          extra: [`pattern: ${pattern}`, `matches: ${walked.results.length}`],
        })
        if (walked.results.length === 0) lines.push('(no matches)')
        else for (const match of walked.results) lines.push(match.path)
        if (walked.truncated) lines.push('[results truncated by the configured limit]')
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_glob ${pattern}`,
          outcome: 'success',
        })
        return { text: lines.join('\n') }
      } catch (error) {
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_glob ${String(args?.pattern ?? '')}`,
          outcome: `failed (${describeError(error)})`,
        })
        throw error
      }
    },
  })
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "'\\''")}'`
}

function powershellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

function posixGrepCommand({ path, pattern, ignoreCase, maxResults }) {
  const flags = ['-R', '-I', '-n', '-E']
  if (ignoreCase === true) flags.push('-i')
  return [
    `grep ${flags.join(' ')} --exclude-dir=.git --exclude-dir=node_modules -e ${shellQuote(pattern)} -- ${shellQuote(path)}`,
    `head -n ${maxResults}`,
  ].join(' | ')
}

function windowsGrepScript({ path, pattern, ignoreCase, maxResults }) {
  const caseSwitch = ignoreCase === true ? '' : ' -CaseSensitive'
  return [
    `$path = ${powershellQuote(path)}`,
    `$item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue`,
    `if ($null -eq $item) { Write-Error ('path not found: ' + $path); exit 3 }`,
    `if ($item.PSIsContainer) { $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue) } else { $files = @($item) }`,
    `$files | Select-String -Pattern ${powershellQuote(pattern)}${caseSwitch} | Select-Object -First ${maxResults} | ForEach-Object { "$($_.Path):$($_.LineNumber):$($_.Line)" }`,
  ].join('\n')
}

export function createRemoteGrepTool({ runtime, config, loadInventory, recordActivity }) {
  return defineTool({
    name: REMOTE_GREP_TOOL_NAME,
    description:
      'Search text in files on a managed remote resource. Uses grep on POSIX targets and Select-String on Windows targets; the path may be a file or directory and results are capped. Binary files are skipped on POSIX.',
    parameters: {
      server: { type: 'string', required: true, description: 'Managed resource name or id.' },
      pattern: { type: 'string', required: true, description: 'Pattern to search for (POSIX extended regex / PowerShell regex).' },
      path: { type: 'string', description: 'File or directory to search; defaults to the remote home directory.' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search.' },
      maxResults: { type: 'number', description: 'Optional result cap (clamped by plugin config).' },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const startedAt = Date.now()
      const server = loadServer({ loadInventory, serverRef: args?.server, toolName: 'remote_grep' })
      const sessionId = sessionKeyOf(exec)
      try {
        const dialect = await resolveDialect(server, runtime)
        const path = args?.path
          ? await resolveRemotePath({ runtime, server, rawPath: args.path, dialect })
          : await resolveRemotePath({ runtime, server, rawPath: '~', dialect })
        const pattern = String(args?.pattern ?? '')
        if (!pattern) throw new Error('pattern is required')
        if (pattern.includes('\n') || pattern.includes('\r')) throw new Error('pattern must not contain newlines')
        const maxResults = integerIn(args?.maxResults, config?.remoteGrepMaxResults ?? 200, 1, MAX_RESULTS_HARD_LIMIT)
        let command
        if (dialect === 'windows') {
          const built = win32Adapter.buildCommand(
            windowsGrepScript({ path, pattern, ignoreCase: args?.ignoreCase === true, maxResults }),
            undefined,
            server,
          )
          if (built?.error !== undefined) throw new Error(built.error)
          command = built.command
        } else {
          // Validate the root first so a missing path is an error rather than
          // an empty "no matches" result.
          await runtime.sftpStat(server, path)
          command = posixGrepCommand({ path, pattern, ignoreCase: args?.ignoreCase === true, maxResults })
        }
        const result = await runtime.exec(server, command, {
          timeoutMs: config?.commandTimeoutMs ?? 120000,
          signal: exec?.signal,
          readOnly: true,
          cap: config?.maxOutputBytes ?? 102400,
          stderrCap: config?.maxStderrBytes ?? 16384,
        })
        const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null
        if (exitCode !== null && exitCode > 1 && dialect !== 'windows') {
          throw new Error(`remote grep failed (exit ${exitCode}): ${result?.stderr || 'no stderr'}`)
        }
        const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
        const lines = renderHeader({
          server,
          path,
          extra: [`pattern: ${pattern}`, `matches: ${stdout.trim() ? stdout.trim().split('\n').length : 0}`],
        })
        lines.push(stdout.trim() ? stdout.replace(/\n$/, '') : '(no matches)')
        if (result?.truncated?.stdout === true) lines.push('[stdout truncated by the plugin output cap]')
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_grep ${pattern}`,
          outcome: describeResultOutcome(result),
        })
        return { text: lines.join('\n') }
      } catch (error) {
        recordFileActivity({
          recordActivity,
          server,
          sessionId,
          startedAt,
          command: `remote_grep ${String(args?.pattern ?? '')}`,
          outcome: `failed (${describeError(error)})`,
        })
        throw error
      }
    },
  })
}

/** Build all five definitions in the canonical registration order. */
export function createRemoteFileTools({ runtime, config, loadInventory, recordActivity }) {
  return [
    createRemoteReadTool({ runtime, config, loadInventory, recordActivity }),
    createRemoteWriteTool({ runtime, config, loadInventory, recordActivity }),
    createRemoteEditTool({ runtime, config, loadInventory, recordActivity }),
    createRemoteGlobTool({ runtime, config, loadInventory, recordActivity }),
    createRemoteGrepTool({ runtime, config, loadInventory, recordActivity }),
  ]
}
