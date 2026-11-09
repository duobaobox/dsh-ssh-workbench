/**
 * Live P0 regression against a real managed server.
 *
 * Usage: node --import ./test/register.mjs test/regression/live-p0.mjs [server-name]
 *
 * Covers the v1.0 remote-execution path end to end against a real host:
 * runtime exec (cwd, timeout), the tools/execute bash router, the blacklist
 * guard, and an SFTP write/read round-trip. Uses the plugin's own encrypted
 * credential store, so it must run on the DSH host machine and cleans up its
 * remote temp dir.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createSshRuntime } from '../../lib/core/ssh.js'
import { createSecretStore } from '../../lib/core/secrets.js'
import { createKnownHosts } from '../../lib/core/known-hosts.js'
import { loadServers } from '../../lib/core/store.js'
import { createTargetStore } from '../../lib/core/targets.js'
import { createBlacklistGuard } from '../../lib/core/guard.js'
import { createRemoteBashRouter } from '../../lib/core/remote-bash.js'

const serverName = process.argv[2]
if (!serverName) {
  console.error('usage: npm run test:live -- <managed-server-name>')
  process.exit(2)
}
const servers = loadServers()
const server = servers.find((entry) => entry.name === serverName || entry.id === serverName)
if (!server) {
  console.error(`unknown server "${serverName}"; managed: ${servers.map((entry) => entry.name).join(', ')}`)
  process.exit(2)
}

const runtime = createSshRuntime({
  getSecret: (key) => createSecretStore().get(key),
  knownHosts: createKnownHosts(),
  config: { connectTimeoutMs: 15000, commandTimeoutMs: 60000 },
})

const config = { commandTimeoutMs: 60000, maxCommandTimeoutMs: 600000, maxOutputBytes: 102400 }
const targets = createTargetStore({ loadInventory: () => servers })
const session = { id: 'live-p0' }
targets.setActive(session, server.name, servers)
const router = createRemoteBashRouter({ runtime, targets, config, loadInventory: () => servers })
const guard = createBlacklistGuard({ targets })

const remoteDir = '/tmp/dsh-ssh-workbench-p0-regression'
const localFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-p0-live-')), 'probe.txt')
const results = []

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    console.log(`FAIL  ${name}: ${results.at(-1).error}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const exec = (command, options = {}) =>
  router({ name: 'bash', arguments: { command, ...options }, agent: { session }, signal: AbortSignal.timeout(60000) }, async () => ({ value: 'native' }))

console.log(`target: ${server.name} (${server.username}@${server.host}:${server.port})`)

await check('plain bash runs on the target', async () => {
  const result = await exec('echo dsh-ssh-workbench-ok')
  assert(result.value?.kind === 'foreground', `unexpected result: ${JSON.stringify(result)}`)
  assert(result.value.exitCode === 0, `exit ${result.value.exitCode}`)
  assert(result.value.stdout.text.includes('dsh-ssh-workbench-ok'), 'stdout missing marker')
})

await check('absolute workdir is applied', async () => {
  const result = await exec('pwd', { workdir: '/tmp' })
  assert(result.value.cwd === `${server.name}:/tmp`, `cwd ${result.value.cwd}`)
  assert(result.value.stdout.text.trim() === '/tmp', `pwd ${result.value.stdout.text}`)
})

await check('relative workdir is anchored at the login home', async () => {
  const result = await exec('pwd', { workdir: '.' })
  assert(result.value.exitCode === 0, `exit ${result.value.exitCode}`)
  assert(result.value.cwd === `${server.name}:~/.`, `cwd label ${result.value.cwd}`)
})

await check('non-zero exit is a normal result', async () => {
  const result = await exec('exit 7')
  assert(result.value, 'expected a value')
  assert(result.value.exitCode === 7, `exit ${result.value.exitCode}`)
})

await check('timeout is reported as timedOut', async () => {
  const result = await exec('sleep 5', { timeoutMs: 1000 })
  assert(result.value?.timedOut === true, `expected timedOut, got ${JSON.stringify(result)}`)
})

await check('blacklist blocks destructive commands', async () => {
  const reason = guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: { session } })
  assert(typeof reason === 'string' && /recursive delete/.test(reason), `reason: ${reason}`)
  const allowed = guard({ name: 'bash', arguments: { command: 'df -h' }, agent: { session } })
  assert(allowed === undefined, `df -h should be allowed, got ${allowed}`)
})

await check('SFTP write/read round-trip', async () => {
  await runtime.sftpMkdir(server, remoteDir).catch(() => {})
  const remotePath = `${remoteDir}/probe.txt`
  await runtime.sftpWrite(server, remotePath, 'hello sftp\n')
  const read = await runtime.sftpRead(server, remotePath)
  assert(read.content === 'hello sftp\n', `content: ${JSON.stringify(read.content)}`)
  fs.writeFileSync(localFile, 'local')
})

await check('cleanup remote temp dir', async () => {
  await runtime.sftpRemove(server, `${remoteDir}/probe.txt`).catch(() => {})
  await runtime.sftpRemove(server, remoteDir, true)
  await runtime.close()
  fs.rmSync(path.dirname(localFile), { recursive: true, force: true })
})

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
