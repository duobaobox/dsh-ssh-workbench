export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stubs/dsh-tools.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: new URL('./stubs/schemastery.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
