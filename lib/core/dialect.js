/**
 * Target dialect helpers.
 *
 * A server record keeps a hand-maintained `platform` hint (`posix`/`windows`)
 * for the UI and for pre-probe compatibility, but the only trustworthy source
 * is a live probe. `facts.dialect` stores that probe result; every decision
 * that changes the command syntax (which remote shell tool to use, how to
 * wrap a timeout) reads it through `effectiveDialect()`.
 */

/** The dialect values this plugin understands. */
const DIALECTS = Object.freeze({ POSIX: 'posix', WINDOWS: 'windows' })

/** Normalize one raw dialect/platform value. */
export function normalizeDialect(value) {
  return value === DIALECTS.WINDOWS || value === 'win32' ? DIALECTS.WINDOWS : DIALECTS.POSIX
}

/**
 * The dialect to build commands for.
 * A probed value wins; the record's `platform` is only a fallback hint.
 */
export function effectiveDialect(server) {
  const probed = server?.facts?.dialect
  if (probed === DIALECTS.WINDOWS || probed === DIALECTS.POSIX) return probed
  return normalizeDialect(server?.platform)
}

