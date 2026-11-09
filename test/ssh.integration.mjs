// Integration test: real ssh2 client transport against a local ssh2 server.
// Run with: npm run test:ssh   (test/ssh.register.mjs maps the bare "ssh2"
// specifier to the vendored copy in vendor/ssh2; SDH_SSH2_PATH overrides it).
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const coreSsh = new URL('../lib/core/ssh.js', import.meta.url)
const { createSshRuntime } = await import(coreSsh.href)
const ssh2mod = await import('ssh2')
const ssh2 = ssh2mod.Server ? ssh2mod : ssh2mod.default

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const FACTS_OUT = [
  '__SDH_HOST__', 'test-host', '__SDH_OS__', 'Linux 6.1.0-test',
  '__SDH_UPTIME__', 'up 1 day', '__SDH_MEM__', 'Mem: 100 50 50',
  '__SDH_DISK__', '/dev/vda1 100 20 80 20% /',
].join('\n')

let lastFingerprint
const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      // Minimal interactive shell: prompt, echo every submitted line as
      // "<line>: ok", and exit on "exit".
      session.on('pty', (acceptPty) => {
        acceptPty?.()
      })
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('dsh> ')
        stream.on('data', (data) => {
          const text = data.toString('utf8')
          for (const raw of text.split('\r')) {
            const command = raw.trim()
            if (!command) continue
            if (command === 'exit') {
              stream.exit(0)
              stream.end()
              return
            }
            stream.write(`\r\n${command}: ok\r\ndsh> `)
          }
        })
      })
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        const command = info.command
        if (command.includes('__SDH_HOST__')) {
          stream.exit(0)
          stream.end(FACTS_OUT)
          return
        }
        if (command.includes('sleep')) {
          setTimeout(() => { stream.exit(0); stream.end() }, 1500)
          return
        }
        if (command.includes('huge')) {
          stream.exit(0)
          stream.end('x'.repeat(5000))
          return
        }
        if (command.includes('grep-nomatch')) {
          // grep with no matches: exit 1, empty stdout/stderr.
          stream.exit(1)
          stream.end()
          return
        }
        stream.exit(0)
        stream.end(`hello ${command}\n`)
      })
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log('ssh2 test server on', port)

const secrets = new Map([['server:target:password', 'test']])
const knownHosts = {
  verify(_server, fingerprint, mode) {
    lastFingerprint = fingerprint
    if (mode === 'strict') return false
    return true
  },
  has: () => false,
}
const runtime = createSshRuntime({
  getSecret: (key) => secrets.get(key),
  knownHosts,
  config: { connectTimeoutMs: 3000, commandTimeoutMs: 3000, maxOutputBytes: 1000, hostKeyMode: 'accept-new' },
})
const target = {
  id: 'target', name: 'local-test', host: '127.0.0.1', port, username: 'test',
  platform: 'posix', tags: [], enabled: true, facts: {},
  authRef: { type: 'password' },
}

const results = {}

const assertLossless = (label, value) => {
  const roundTrip = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTrip, value, `${label} must survive a JSON round trip`)
  const walk = (node) => {
    if (Array.isArray(node)) return node.every(walk)
    if (node && typeof node === 'object') {
      if (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) return false
      return Object.entries(node).every(([, entry]) => entry !== undefined && walk(entry))
    }
    return !(typeof node === 'number' && !Number.isFinite(node))
  }
  assert.equal(walk(value), true, `${label} contains a non-JSON value`)
}

const hello = await runtime.exec(target, 'echo hi')
assertLossless('exec success', hello)
results.hello = hello
assert.equal(hello.outcome, 'success', JSON.stringify(hello))
assert.equal(hello.exitCode, 0)
assert.match(hello.stdout, /hello echo hi/)

const huge = await runtime.exec(target, 'huge-output')
results.huge = { outcome: huge.outcome, truncated: huge.truncated.stdout, marker: huge.stdout.includes('[truncated') }
assert.equal(huge.truncated.stdout, true)
assert.match(huge.stdout, /\[truncated \d+ bytes\]/)

const noMatch = await runtime.exec(target, 'grep-nomatch', { readOnly: true })
results.benignExit = { outcome: noMatch.outcome, exitCode: noMatch.exitCode, note: noMatch.note }
assertLossless('exec benign exit', noMatch)
assert.equal(noMatch.outcome, 'success', JSON.stringify(noMatch))
assert.equal(noMatch.exitCode, 1)
assert.match(noMatch.note, /no match/)

const noMatchNonReadonly = await runtime.exec(target, 'grep-nomatch', { readOnly: false })
results.nonBenignExit = { outcome: noMatchNonReadonly.outcome, errorCode: noMatchNonReadonly.errorCode }
assert.equal(noMatchNonReadonly.outcome, 'failed')
assert.equal(noMatchNonReadonly.errorCode, 'EXEC_FAILED')

const slow = await runtime.exec(target, 'sleep 2', { timeoutMs: 200 })
results.timeout = { outcome: slow.outcome, errorCode: slow.errorCode }
assertLossless('exec timeout', slow)
assert.equal(slow.outcome, 'timeout')
assert.equal(slow.errorCode, 'TIMEOUT')

const facts = await runtime.facts(target)
results.facts = { outcome: facts.outcome, facts: facts.facts }
assert.equal(facts.outcome, 'success')
assert.equal(facts.facts.hostname, 'test-host')
assert.match(facts.facts.kernel, /Linux/)
assert.match(facts.facts.rootDisk, /vda1/)

const probe = await runtime.test(target)
results.test = { ok: probe.ok, latencyMs: probe.latencyMs }
assert.equal(probe.ok, true)
assert.equal(typeof probe.latencyMs, 'number')

results.fingerprint = { captured: typeof lastFingerprint === 'string', length: lastFingerprint?.length, hex: /^[0-9a-f]+$/.test(lastFingerprint ?? '') }
assert.equal(typeof lastFingerprint, 'string')
assert.match(lastFingerprint, /^[0-9a-f]{64}$/)

// Interactive PTY shell transport: prompt arrives, writes reach the server and
// the echoed response comes back through the channel.
const shell = await runtime.shell(target, { rows: 24, cols: 80 })
const shellChunks = []
let shellClosed
shell.onClose((code, signal) => {
  shellClosed = { code, signal }
})
shell.onData((chunk) => shellChunks.push(chunk.toString('utf8')))
const waitFor = async (probe, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (probe()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
assert.equal(await waitFor(() => shellChunks.join('').includes('dsh> ')), true, shellChunks.join('').slice(-200))
shell.write('echo hi\r')
assert.equal(await waitFor(() => shellChunks.join('').includes('echo hi: ok')), true, shellChunks.join('').slice(-300))
await shell.close()
assert.equal(await waitFor(() => shellClosed !== undefined), true)
// A plain shell channel closes without an exit-status code; the close event
// itself is the lifecycle signal (exec channels carry the code).
results.shell = { prompt: true, echo: true, closed: shellClosed }
assert.equal(shellClosed.code ?? null, null)

// Wrong password must surface the structured auth error rather than throwing.
secrets.set('server:target:password', 'wrong')
const auth = await runtime.exec(target, 'echo hi')
results.authFailure = { outcome: auth.outcome, errorCode: auth.errorCode }
assert.equal(auth.outcome, 'failed')
assert.equal(auth.errorCode, 'AUTH_FAILED')

console.log(JSON.stringify(results, null, 2))
server.close()
runtime.close?.()
console.log('SSH INTEGRATION OK')
