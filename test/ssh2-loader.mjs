import { fileURLToPath, pathToFileURL } from 'node:url'

/** Resolve the vendored ssh2 copy; SDH_SSH2_PATH can override it for testing. */
const DEFAULT = fileURLToPath(new URL('../vendor/ssh2/lib/index.js', import.meta.url))

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ssh2') return { url: pathToFileURL(process.env.SDH_SSH2_PATH || DEFAULT).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
