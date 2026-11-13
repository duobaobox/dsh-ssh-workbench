/**
 * Small user-visible UI preferences that are not part of the server inventory.
 *
 * Kept in the same private data directory as the inventory so a profile export
 * carries them, and so the plugin manager's settings form can change them
 * without rewriting the profile's cordis.patch.yml.
 *
 * `remoteFileWrite` is deliberately tri-state: `null` means "follow the plugin
 * config", a boolean means the user overrode it from the settings UI. Keeping
 * the override separate from the config lets the plugin detail page show a
 * switch without making the config file the only way in.
 */
import { prefsPath, readTextFile, writePrivateFile } from './paths.js'

export const DEFAULT_PREFS = Object.freeze({ sidebar: true, remoteFileWrite: null, systemFileHierarchy: null })

/** Coerce a stored document into the current preference shape. */
function normalizePrefs(raw) {
  const prefs = { ...DEFAULT_PREFS }
  if (!raw || typeof raw !== 'object') return prefs
  if (typeof raw.sidebar === 'boolean') prefs.sidebar = raw.sidebar
  if (typeof raw.remoteFileWrite === 'boolean') prefs.remoteFileWrite = raw.remoteFileWrite
  if (typeof raw.systemFileHierarchy === 'boolean') prefs.systemFileHierarchy = raw.systemFileHierarchy
  return prefs
}

export function loadPrefs() {
  const text = readTextFile(prefsPath(), '')
  if (!text.trim()) return { ...DEFAULT_PREFS }
  try {
    return normalizePrefs(JSON.parse(text))
  } catch {
    // A corrupt preferences file must never make the plugin unusable; fall
    // back to the defaults and let the next save rewrite it.
    return { ...DEFAULT_PREFS }
  }
}

/** Merge one patch into the stored preferences and persist the result. */
export function savePrefs(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('prefs patch must be an object')
  const next = normalizePrefs({ ...loadPrefs(), ...patch })
  writePrivateFile(prefsPath(), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/**
 * Resolve the write switch the tools and the model context should honour.
 *
 * A stored override wins; otherwise the plugin config decides. Anything that
 * is neither `true` nor `false` falls back to the config, so a corrupt prefs
 * file can never silently enable remote writes.
 */
export function resolveRemoteFileWrite(config, prefs) {
  const override = prefs?.remoteFileWrite
  if (override === true || override === false) return override
  return config?.remoteFileWrite === true
}

/**
 * Resolve the hierarchical system file browser switch.
 *
 * Same tri-state contract as the write switch: a settings-page override wins,
 * otherwise the plugin config decides. Defaults to off so the native files tab
 * is untouched unless the user explicitly asks for the hierarchical browser.
 */
export function resolveSystemFileHierarchy(config, prefs) {
  const override = prefs?.systemFileHierarchy
  if (override === true || override === false) return override
  return config?.systemFileHierarchy === true
}
