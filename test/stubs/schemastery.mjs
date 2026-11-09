function chain() {
  const node = {
    default: () => node,
    description: () => node,
  }
  return node
}

export default {
  object: (schema) => ({ type: 'object', schema }),
  string: chain,
  number: chain,
  natural: chain,
  boolean: chain,
}
