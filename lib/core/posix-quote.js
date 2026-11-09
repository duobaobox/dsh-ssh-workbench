/** POSIX single-quote escaping for a remote shell word. */
export function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
