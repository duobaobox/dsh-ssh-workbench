/**
 * Remote latency benchmark.
 *
 * Runs the same operations twice against one real managed server:
 *   1. `connectionPool: false` — the old "one connection per call" behaviour
 *   2. pooled (default)       — one pooled connection per server + SFTP reuse
 *
 * Run:
 *   node --import ./test/ssh.register.mjs test/bench/latency.mjs --server <name>
 *   node --import ./test/ssh.register.mjs test/bench/latency.mjs --server <name> --json
 *
 * The script reads the server inventory + secrets from ~/.dsh/ssh-workbench (override
 * with DSH_SSH_WORKBENCH_DIR / DSH_HOME). It is read-only against the remote host.
 */
import { createSecretStore } from '../../lib/core/secrets.js'
import { createKnownHosts } from '../../lib/core/known-hosts.js'
import { createSshRuntime } from '../../lib/core/ssh.js'
import { loadServers } from '../../lib/core/store.js'

const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')
const serverIndex = args.indexOf('--server')
const wanted = serverIndex >= 0 ? args[serverIndex + 1] : undefined
const iterations = 5

const servers = loadServers()
const server = wanted ? servers.find((entry) => entry.name === wanted || entry.id === wanted) : servers[0]
if (!server) {
  console.error(`no managed server found${wanted ? ` for "${wanted}"` : ''}`)
  process.exit(1)
}

const secrets = createSecretStore()
const knownHosts = createKnownHosts()

function makeRuntime(connectionPool) {
  return createSshRuntime({
    getSecret: (key) => secrets.get(key),
    knownHosts,
    config: { connectionPool, hostKeyMode: 'strict', factsTtlMs: 60000 },
    log: () => {},
  })
}

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}
const round = (value) => Math.round(value)

async function measure(label, fn, count = iterations) {
  const samples = []
  let last
  for (let index = 0; index < count; index += 1) {
    const started = Date.now()
    last = await fn()
    samples.push(Date.now() - started)
  }
  return { label, samples, p50: round(median(samples)), min: round(Math.min(...samples)), max: round(Math.max(...samples)), last }
}

async function runMode(connectionPool) {
  const runtime = makeRuntime(connectionPool)
  const rows = []
  try {
    rows.push(await measure('exec (first call, cold)', () => runtime.exec(server, 'true'), 1))
    rows.push(await measure('exec (warm)', () => runtime.exec(server, 'true'), iterations))
    rows.push(await measure('exec hostname', () => runtime.exec(server, 'hostname'), iterations))
    rows.push(await measure('facts (first)', () => runtime.facts(server), 1))
    rows.push(await measure('facts (cached)', () => runtime.facts(server), 1))
    rows.push(await measure('sftp list /opt/blog', () => runtime.sftpList(server, '/opt/blog'), 3))
    rows.push(await measure('sftp stat blog.db-wal', () => runtime.sftpStat(server, '/opt/blog/data/blog.db-wal'), 3))
    rows.push(await measure('sftp read Caddyfile (103B)', () => runtime.sftpRead(server, '/etc/caddy/Caddyfile'), 3))
    rows.push(await measure('sftp list missing path (error)', () => runtime.sftpList(server, '/definitely-missing-sdh').catch((error) => error), 3))
    rows.push(await measure('connect test', () => runtime.test(server), 3))
  } finally {
    await runtime.close()
  }
  return rows
}

const before = await runMode(false)
const after = await runMode(true)

if (jsonOutput) {
  console.log(JSON.stringify({ server: server.name, before, after }, null, 2))
} else {
  console.log(`\nbenchmark target: ${server.name} (${server.username}@${server.host}:${server.port})\n`)
  console.log('| operation | before p50 (ms) | after p50 (ms) | speedup |')
  console.log('|---|---:|---:|---:|')
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index]
    const right = after[index]
    const speedup = right.p50 > 0 ? `${(left.p50 / right.p50).toFixed(1)}x` : '—'
    console.log(`| ${left.label} | ${left.p50} | ${right.p50} | ${speedup} |`)
  }
  console.log('')
}
