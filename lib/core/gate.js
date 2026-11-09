/**
 * Remote-command safety net for the DSH approval pipeline.
 *
 * The plugin has full SSH credentials for every managed server, so it is not a
 * permission boundary and does not pretend to be one. Its only deterministic
 * job is to stop a small set of machine-destroying accidents. Everything else
 * is allowed: whether a command is reviewed is decided by the DSH session
 * approval preset (`ask` / Auto review ask every command, `never` lets them
 * run), never by a plugin-side allowlist or ask list.
 *
 * Design notes (v4, v1.0.2):
 * - Shell syntax is normalized before matching. Each segment is tokenized into
 *   words with quoting and backslash escapes removed, wrappers (`sudo`,
 *   `timeout`, `env`, `!`, assignments, ...) are skipped, and rules inspect the
 *   resulting argv. So `"mkfs.ext4"`, `\rm`, `sudo -u root mkfs...` and
 *   `timeout 5 mkfs...` are classified like their plain forms.
 * - Redirects are detected as tokens, not by substring: `cat > "/dev/sda"` is
 *   a device write, while `grep "> /dev/sda" file` is just text.
 * - Paths are lexically canonicalized (trailing slashes, `//`, `.`/`..`,
 *   `~`/`${HOME}`) and glob/brace patterns are reduced to their literal
 *   prefix, so `rm -rf /etc/`, `rm -rf /etc/../`, `rm -rf //` and
 *   `rm -rf /etc/*` hit the same rule as `rm -rf /etc`.
 * - Command substitutions (`$(...)`, backticks) and `eval` bodies are
 *   classified recursively, so `echo "$(mkfs.ext4 /dev/sdb1)"` is denied.
 * - The blacklist remains best-effort: `bash -c`, base64, script files and
 *   heredoc bodies passed to an interpreter are deliberately left to the
 *   caller. The real boundary is SSH least privilege + host-key pinning.
 */

const DEVICE_PATTERN =
  '(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\\d|mmcblk\\d|md\\d|dm-\\d|' +
  'mapper|disk|loop\\d|nbd\\d|ram\\d|zram\\d|ubi\\d|mtdblock\\d|sr\\d|fd\\d|dasd[a-z]+|root)'
const DEVICE_RE = new RegExp(`^/dev/${DEVICE_PATTERN}`)

const SYSTEM_DIRS = new Set([
  '/etc', '/root', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/home', '/opt', '/srv', '/sys', '/proc', '/dev',
])

/** Home/root spellings that point at a whole user (or root) home directory. */
const HOME_ROOT_TOKENS = new Set([
  '~', '~/', '~root', '~root/', '$HOME', '$HOME/', '${HOME}', '${HOME}/',
])

/** Relative spellings that mean "the whole current or parent directory". */
const RELATIVE_ROOT_TOKENS = new Set(['.', './', '..', '../'])

const PARTITION_TOOLS = new Set(['fdisk', 'parted', 'wipefs', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'cgdisk'])
const ERASE_TOOLS = new Set(['blkdiscard'])
const COPY_TOOLS = new Set(['cp', 'mv', 'install'])
const REDIRECT_OPS = new Set(['>', '>>', '&>', '&>>', '>&'])

const SUDO_ARG_FLAGS = new Set([
  '-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-r', '--role',
  '-t', '--type', '-U', '--other-user', '-C', '--close-from',
])
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nice', 'time', 'nohup', 'exec', 'setsid', 'builtin'])
const WRAPPER_VALUE_FLAGS = {
  sudo: SUDO_ARG_FLAGS,
  doas: new Set(['-u']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set(['-f', '--format', '-o', '--output']),
  exec: new Set(['-a']),
}
const TIMEOUT_ARG_FLAGS = new Set(['-s', '--signal', '-k', '--kill-after'])
const DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/

/**
 * Split on top-level shell separators, respecting quotes:
 * `;` `|` `||` `&&`, a single `&` (command backgrounding), and newlines —
 * models routinely emit multi-line shell scripts, and a newline is as much a
 * command boundary as `;`. Redirection operators that contain `&` (`2>&1`,
 * `&>file`, `&>>file`) are kept in the segment instead of being split.
 */
function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      current += char
      if (quote === '"' && char === '\\' && index + 1 < command.length) {
        current += command[index + 1]
        index += 1
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += char
      if (index + 1 < command.length) {
        current += command[index + 1]
        index += 1
      }
      continue
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === '&') {
      const next = command[index + 1]
      const previous = command[index - 1]
      if (next === '&') {
        segments.push(current)
        current = ''
        index += 1
        continue
      }
      if (next !== '>' && previous !== '>') {
        segments.push(current)
        current = ''
        continue
      }
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Tokenize one shell segment into words and operators, removing quoting and
 * backslash escapes: `cat > "/dev/sda"` → `['cat', '>', '/dev/sda']`.
 * Inside quotes operators stay part of the word, so quoted text keeps its
 * literal meaning.
 */
function tokenize(segment) {
  const tokens = []
  let word = ''
  let index = 0
  const pushWord = () => {
    if (word.length > 0) {
      tokens.push(word)
      word = ''
    }
  }
  while (index < segment.length) {
    const char = segment[index]
    if (char === "'") {
      index += 1
      while (index < segment.length && segment[index] !== "'") {
        word += segment[index]
        index += 1
      }
      index += 1
      continue
    }
    if (char === '"') {
      index += 1
      while (index < segment.length && segment[index] !== '"') {
        const inner = segment[index]
        if (inner === '\\' && index + 1 < segment.length && '$`"\\\n'.includes(segment[index + 1])) {
          word += segment[index + 1]
          index += 2
          continue
        }
        word += inner
        index += 1
      }
      index += 1
      continue
    }
    if (char === '\\') {
      if (index + 1 < segment.length) {
        word += segment[index + 1]
        index += 2
      } else {
        index += 1
      }
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      pushWord()
      index += 1
      continue
    }
    if (char === '&') {
      pushWord()
      if (segment[index + 1] === '>') {
        if (segment[index + 2] === '>') {
          tokens.push('&>>')
          index += 3
        } else {
          tokens.push('&>')
          index += 2
        }
        continue
      }
      tokens.push('&')
      index += 1
      continue
    }
    if (char === '>' || char === '<') {
      pushWord()
      if (segment[index + 1] === '&') {
        tokens.push(`${char}&`)
        index += 2
        continue
      }
      if (segment[index + 1] === char) {
        if (char === '<' && segment[index + 2] === '<') {
          tokens.push('<<<')
          index += 3
          continue
        }
        tokens.push(char + char)
        index += 2
        continue
      }
      tokens.push(char)
      index += 1
      continue
    }
    if (char === '|' || char === ';') {
      pushWord()
      tokens.push(char)
      index += 1
      continue
    }
    word += char
    index += 1
  }
  pushWord()
  return tokens
}

/**
 * Skip leading assignments, shell wrappers and their arguments so rules see the
 * actual command word. Works on unquoted tokens, so `sudo -u root "mkfs.ext4"`
 * reduces to `['mkfs.ext4']`.
 */
function stripWrappers(tokens) {
  let index = 0
  for (let guard = 0; guard < 24 && index < tokens.length; guard += 1) {
    const head = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      index += 1
      continue
    }
    if (head === '!') {
      index += 1
      continue
    }
    if (head === 'timeout') {
      index += 1
      while (index < tokens.length && tokens[index].startsWith('-') && tokens[index] !== '-') {
        const inline = tokens[index].includes('=')
        const flag = tokens[index].split('=')[0]
        index += 1
        if (!inline && TIMEOUT_ARG_FLAGS.has(flag) && index < tokens.length) index += 1
      }
      if (index < tokens.length && DURATION_RE.test(tokens[index])) index += 1
      continue
    }
    if (WRAPPERS.has(head)) {
      index += 1
      const valueFlags = WRAPPER_VALUE_FLAGS[head] ?? new Set()
      while (index < tokens.length && tokens[index].startsWith('-') && tokens[index] !== '-') {
        const inline = tokens[index].includes('=')
        const flag = tokens[index].split('=')[0]
        index += 1
        if (!inline && valueFlags.has(flag) && index < tokens.length) index += 1
      }
      continue
    }
    break
  }
  return tokens.slice(index)
}

/** Last path component of a command word (`/bin/rm` → `rm`). */
function basenameOf(word) {
  const trimmed = String(word).replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** POSIX lexical path normalization: `/etc//../` → `/`. */
function canonicalizePath(value) {
  if (value === '' || !value.startsWith('/')) return { absolute: false, value }
  const stack = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return { absolute: true, value: `/${stack.join('/')}` }
}

/** Expand simple `{a,b}` alternatives (no nesting, bounded). */
function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]*)\}/)
  if (!match) return [pattern]
  const results = []
  for (const alternative of match[1].split(',')) {
    results.push(...expandBraces(pattern.slice(0, match.index) + alternative + pattern.slice(match.index + match[0].length)))
  }
  return results.slice(0, 16)
}

/** Literal prefix of a glob/brace pattern (`/etc/*` → `/etc`). */
function literalPrefix(pattern) {
  const meta = pattern.search(/[*?\[]/)
  return meta === -1 ? pattern : pattern.slice(0, meta)
}

function isProtectedPath(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  if (HOME_ROOT_TOKENS.has(target) || RELATIVE_ROOT_TOKENS.has(target)) return true
  for (const pattern of expandBraces(target)) {
    const prefix = literalPrefix(pattern)
    if (prefix === '') continue
    const normalized = canonicalizePath(prefix)
    if (!normalized.absolute) continue
    if (normalized.value === '/' || SYSTEM_DIRS.has(normalized.value)) return true
  }
  return false
}

function isRootFilesystemPath(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  for (const pattern of expandBraces(target)) {
    const prefix = literalPrefix(pattern)
    if (prefix === '') continue
    const normalized = canonicalizePath(prefix)
    if (normalized.absolute && (normalized.value === '/' || SYSTEM_DIRS.has(normalized.value))) return true
  }
  return false
}

function isDevicePath(word) {
  if (typeof word !== 'string' || word.length === 0) return false
  const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : word
  return DEVICE_RE.test(value)
}

/** Deny rule for `dd ... of=/dev/<device>`. */
function ddRule(words) {
  if (basenameOf(words[0]) !== 'dd') return undefined
  for (const word of words.slice(1)) {
    if (word.startsWith('of=') && isDevicePath(word)) {
      return { reason: 'raw disk write (dd of=/dev/...)', ruleId: 'disk-write' }
    }
  }
  return undefined
}

/** Deny rule for recursive delete of a root/system path. */
function rmRule(words) {
  if (basenameOf(words[0]) !== 'rm') return undefined
  const rest = words.slice(1)
  const flags = rest.filter((word) => word.startsWith('-')).join('')
  if (!/[rR]/.test(flags)) return undefined
  const targets = rest.filter((word) => !word.startsWith('-'))
  if (targets.some(isProtectedPath)) {
    return { reason: 'recursive delete of a root/system path', ruleId: 'rm-root' }
  }
  return undefined
}

function chmodRule(words) {
  if (basenameOf(words[0]) !== 'chmod') return undefined
  const positional = words.slice(1).filter((word) => !word.startsWith('-'))
  if (positional.length < 2) return undefined
  const mode = positional[0]
  const numeric = /^[0-7]{3,4}$/.test(mode)
  const symbolic = /^[ugoa]*[-+=][rwxXst]*([,][ugoa]*[-+=][rwxXst]*)*$/.test(mode)
  if (!numeric && !symbolic) return undefined
  if (positional.slice(1).some(isRootFilesystemPath)) {
    return { reason: 'permission change on the root filesystem', ruleId: 'chmod-root' }
  }
  return undefined
}

function chownRule(words) {
  if (basenameOf(words[0]) !== 'chown') return undefined
  const positional = words.slice(1).filter((word) => !word.startsWith('-'))
  if (positional.length < 2) return undefined
  if (positional.slice(1).some(isRootFilesystemPath)) {
    return { reason: 'ownership change on the root filesystem', ruleId: 'chown-root' }
  }
  return undefined
}

function deviceWriteRule(words) {
  const head = basenameOf(words[0])
  const rest = words.slice(1)
  if (PARTITION_TOOLS.has(head)) {
    return { reason: 'partition table editing', ruleId: 'partition' }
  }
  if (ERASE_TOOLS.has(head)) {
    return { reason: 'raw disk erase (blkdiscard)', ruleId: 'device-write' }
  }
  if (head === 'shred') {
    if (rest.filter((word) => !word.startsWith('-')).some(isDevicePath)) {
      return { reason: 'raw disk wipe (shred)', ruleId: 'device-write' }
    }
    return undefined
  }
  if (head === 'badblocks') {
    const flags = rest.filter((word) => word.startsWith('-')).join('')
    if (/[wn]/.test(flags) && rest.filter((word) => !word.startsWith('-')).some(isDevicePath)) {
      return { reason: 'destructive disk test (badblocks -w/-n)', ruleId: 'device-write' }
    }
    return undefined
  }
  if (COPY_TOOLS.has(head)) {
    const positional = rest.filter((word) => !word.startsWith('-'))
    if (positional.length > 0 && isDevicePath(positional[positional.length - 1])) {
      return { reason: 'writing a file onto a block device', ruleId: 'device-write' }
    }
    return undefined
  }
  if (head === 'tee') {
    if (rest.filter((word) => !word.startsWith('-')).some(isDevicePath)) {
      return { reason: 'writing output onto a block device', ruleId: 'device-write' }
    }
  }
  return undefined
}

/** Deny when a redirect operator is followed by a block device. */
function redirectRule(tokens) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (REDIRECT_OPS.has(tokens[index]) && isDevicePath(tokens[index + 1])) {
      return { reason: 'redirecting output onto a block device', ruleId: 'device-redirect' }
    }
  }
  return undefined
}

/** Extract `$(...)` and backtick bodies that the shell would execute. */
function collectSubstitutions(command) {
  const bodies = []
  let quote = null
  let index = 0
  const readParen = (start) => {
    let depth = 0
    for (let cursor = start; cursor < command.length; cursor += 1) {
      const char = command[cursor]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) return { body: command.slice(start + 1, cursor), end: cursor }
      }
    }
    return undefined
  }
  while (index < command.length) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = null
      index += 1
      continue
    }
    if (char === '\\') {
      index += 2
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
        index += 1
        continue
      }
      if (char === '$' && command[index + 1] === '(') {
        const found = readParen(index + 1)
        if (found && found.body.trim() && bodies.length < 16) bodies.push(found.body)
        index = found ? found.end + 1 : index + 2
        continue
      }
      if (char === '`') {
        const end = command.indexOf('`', index + 1)
        if (end > index) {
          const body = command.slice(index + 1, end)
          if (body.trim() && bodies.length < 16) bodies.push(body)
          index = end + 1
          continue
        }
      }
      index += 1
      continue
    }
    if (char === "'") {
      quote = "'"
      index += 1
      continue
    }
    if (char === '"') {
      quote = '"'
      index += 1
      continue
    }
    if (char === '$' && command[index + 1] === '(') {
      const found = readParen(index + 1)
      if (found && found.body.trim() && bodies.length < 16) bodies.push(found.body)
      index = found ? found.end + 1 : index + 2
      continue
    }
    if (char === '`') {
      const end = command.indexOf('`', index + 1)
      if (end > index) {
        const body = command.slice(index + 1, end)
        if (body.trim() && bodies.length < 16) bodies.push(body)
        index = end + 1
        continue
      }
    }
    index += 1
  }
  return bodies
}

/** Classify the words of one segment. Returns a deny decision or undefined. */
function classifySegmentWords(segment, depth) {
  if (/^:\s*\(\s*\)\s*\{/.test(segment.trim())) {
    return { reason: 'fork bomb pattern', ruleId: 'fork-bomb' }
  }
  const tokens = tokenize(segment)
  const redirect = redirectRule(tokens)
  if (redirect) return redirect
  const words = stripWrappers(tokens)
  if (words.length === 0) return undefined
  const head = basenameOf(words[0])
  // `eval` re-parses its argument, so classify it like a nested command.
  if (head === 'eval' && depth < 2) {
    const nested = classifyCommand(words.slice(1).join(' '), depth + 1)
    if (nested.decision === 'deny') {
      return { reason: `inside eval: ${nested.reason}`, ruleId: nested.ruleId }
    }
    return undefined
  }
  if (/^mkfs(\.\w+)?$/.test(head)) {
    return { reason: 'filesystem formatting (mkfs)', ruleId: 'mkfs' }
  }
  return ddRule(words) ?? deviceWriteRule(words) ?? rmRule(words) ?? chmodRule(words) ?? chownRule(words)
}

/**
 * Classify one raw command string.
 * @returns {{decision: 'deny'|'allow', reason: string, ruleId: string}}
 */
export function classifyCommand(raw, depth = 0) {
  const command = String(raw ?? '').trim()
  if (!command) return { decision: 'deny', reason: 'empty command', ruleId: 'empty' }
  if (depth < 2) {
    for (const body of collectSubstitutions(command)) {
      const nested = classifyCommand(body, depth + 1)
      if (nested.decision === 'deny') {
        return { decision: 'deny', reason: `inside command substitution: ${nested.reason}`, ruleId: nested.ruleId }
      }
    }
  }
  for (const segment of splitSegments(command)) {
    const denied = classifySegmentWords(segment, depth)
    if (denied) return { decision: 'deny', ...denied }
  }
  return { decision: 'allow', reason: 'not on the machine-destruction blacklist', ruleId: 'allow' }
}
