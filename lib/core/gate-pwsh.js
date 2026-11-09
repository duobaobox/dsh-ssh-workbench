/**
 * PowerShell blacklist for the Windows remote shell.
 *
 * Same philosophy as the POSIX gate: this is a deterministic accident stop,
 * not a permission boundary. It only catches machine-destroying commands a
 * model might emit by mistake (disk/volume formatting, partition edits, boot
 * configuration edits, whole-drive recursive deletes). Everything else is left
 * to the DSH session approval preset.
 */

const RULES = [
  {
    ruleId: 'format-volume',
    reason: 'formatting a volume (Format-Volume)',
    pattern: /\bformat-volume\b/,
  },
  {
    ruleId: 'disk-management',
    reason: 'disk/partition management (Clear-Disk, Initialize-Disk, Remove-Partition)',
    pattern: /\b(?:clear-disk|initialize-disk|remove-partition|resize-partition)\b/,
  },
  {
    ruleId: 'diskpart',
    reason: 'interactive disk partitioning (diskpart)',
    pattern: /\bdiskpart(?:\.exe)?\b/,
  },
  {
    ruleId: 'format-command',
    reason: 'formatting a drive (format)',
    pattern: /\bformat(?:\.com)?\s+[a-z]:/,
  },
  {
    ruleId: 'boot-config',
    reason: 'boot configuration edit (bcdedit)',
    pattern: /\bbcdedit(?:\.exe)?\b/,
  },
  {
    ruleId: 'wipe-free-space',
    reason: 'wiping free space (cipher /w)',
    pattern: /\bcipher(?:\.exe)?\s+\/w\b/,
  },
  {
    ruleId: 'shadow-delete',
    reason: 'deleting volume shadow copies (vssadmin/wbadmin)',
    pattern: /\b(?:vssadmin|wbadmin)(?:\.exe)?\s+delete\b/,
  },
  {
    ruleId: 'rm-root',
    reason: 'recursive delete of a drive root or system directory',
    pattern:
      /\b(?:remove-item|rm|rd|rmdir|del)\b(?=[^|;]*(?:-recurse|-r\b|\/s)\b)[^|;]*?(?:[a-z]:[\\/]{1,2}(?:windows|users|programdata|program files)\b|[a-z]:[\\/]{0,2}(?:['"]|\s|$)|\$(?:env:)?systemdrive\b|%systemdrive%)/,
  },
  {
    ruleId: 'remove-root-recursive',
    reason: 'recursive delete of a whole drive',
    pattern: /\b(?:remove-item|rm|rd|rmdir|del)\b[^|;]*?['"]?[a-z]:[\\/]?['"]?\s+(?:-recurse|-force|\/s|\/q)/,
  },
]

/** Split one PowerShell command into independently-executed statements. */
export function powerShellStatements(command) {
  return String(command ?? '')
    .split(/[;\r\n]|\|\||&&|\|/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** Lowercase + collapse whitespace, without touching quoted content semantics. */
function normalizeStatement(statement) {
  return statement.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * @param {string} command
 * @returns {{decision: 'deny'|'allow', reason: string, ruleId: string}}
 */
export function classifyPowerShellCommand(command) {
  if (!String(command ?? '').trim()) return { decision: 'allow', reason: 'empty command', ruleId: 'empty' }
  for (const statement of powerShellStatements(command)) {
    const text = normalizeStatement(statement)
    for (const rule of RULES) {
      if (rule.pattern.test(text)) {
        return { decision: 'deny', reason: rule.reason, ruleId: rule.ruleId }
      }
    }
  }
  return { decision: 'allow', reason: 'not on the PowerShell machine-destruction blacklist', ruleId: 'allow' }
}
