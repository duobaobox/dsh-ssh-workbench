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

/**
 * Classify one dialect probe output. Both probes are single, shell-native
 * commands, so a wrong guess only costs one failed SSH exec — never a
 * command against the wrong dialect.
 */
export function dialectFromProbe(stdout, exitCode) {
  if (exitCode !== 0) return undefined
  const text = String(stdout ?? '').trim()
  if (!text) return undefined
  if (/Microsoft Windows/i.test(text)) return DIALECTS.WINDOWS
  if (/^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD|DragonFly|SunOS|AIX|HP-UX|CYGWIN|MINGW|MSYS|GNU)/im.test(text)) {
    return DIALECTS.POSIX
  }
  return undefined
}

