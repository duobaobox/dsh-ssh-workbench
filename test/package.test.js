import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))

test('package is self-contained: no install-time runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.optionalDependencies, undefined)
  assert.ok(pkg.files.includes('vendor'))
})

test('vendored ssh2 and licence notice ship with the package', () => {
  assert.ok(fs.existsSync(new URL('vendor/ssh2/lib/index.js', root)))
  assert.ok(fs.existsSync(new URL('vendor/ssh2/LICENSE', root)))
  assert.ok(fs.existsSync(new URL('vendor/NOTICE.md', root)))
  for (const dep of ['asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) {
    assert.ok(fs.existsSync(new URL(`vendor/node_modules/${dep}/package.json`, root)), dep)
  }
})

test('vendored ssh2 contains no native build inputs', () => {
  const vendor = fs.readFileSync(new URL('vendor/ssh2/package.json', root), 'utf8').toLowerCase()
  assert.ok(!vendor.includes('cpu-features'))
  assert.ok(!vendor.includes('binding.gyp'))
  assert.ok(!fs.existsSync(new URL('vendor/ssh2/install.js', root)))
  assert.ok(!fs.existsSync(new URL('vendor/ssh2/binding.gyp', root)))
})
