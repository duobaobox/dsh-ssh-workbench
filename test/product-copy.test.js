import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (relative) => fs.readFileSync(new URL(relative, root), 'utf8')

const clientSource = read('lib/client.js')
const pkg = JSON.parse(read('package.json'))
const zhLocale = JSON.parse(read('locale/zh.json'))
const enLocale = JSON.parse(read('locale/en.json'))
const readme = read('README.md')
const quickstart = read('docs/quickstart.md')

/** Product identity used by every user-facing surface. */
const NAME_ZH = '远程工作台'
const NAME_EN = 'SSH Workbench'
const WORKBENCH_ZH = '远程工作台'
const WORKBENCH_EN = 'SSH Workbench'
const TAGLINE_ZH = 'SSH 终端、本地与远程文件、@服务器 对话执行，Windows 宿主和目标都能用。'
const TAGLINE_EN = 'SSH terminals, local and remote files, and @server command execution — on Windows hosts and Windows targets.'

function dictBlock(start, end) {
  const from = clientSource.indexOf(start)
  const to = from < 0 ? -1 : clientSource.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `missing dictionary boundary: ${start}`)
  return clientSource.slice(from, to)
}

function entries(block) {
  return [...block.matchAll(/^\s+'([^']+)': '(.*)',$/gm)].map((match) => [match[1], match[2]])
}

const zhEntries = entries(dictBlock('const zh = {', 'const en = {'))
const enEntries = entries(dictBlock('const en = {', '// The official Electron shell'))
const toMap = (list) => Object.fromEntries(list)

test('locale metadata carries the product name and tagline', () => {
  assert.equal(zhLocale.meta.title, NAME_ZH)
  assert.equal(zhLocale.meta.description, TAGLINE_ZH)
  assert.equal(enLocale.meta.title, NAME_EN)
  assert.equal(enLocale.meta.description, TAGLINE_EN)
})

test('client dictionaries keep zh/en parity without duplicate keys', () => {
  const zhKeys = zhEntries.map(([key]) => key)
  const enKeys = enEntries.map(([key]) => key)
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh/en keys drifted apart')
  assert.equal(new Set(zhKeys).size, zhKeys.length, 'duplicate zh key')
  assert.equal(new Set(enKeys).size, enKeys.length, 'duplicate en key')
})

test('user-facing surfaces use the unified product name', () => {
  const zh = toMap(zhEntries)
  const en = toMap(enEntries)
  assert.equal(zh['settings.title'], NAME_ZH)
  assert.equal(zh['guide.title'], NAME_ZH)
  assert.equal(zh['workbench.title'], WORKBENCH_ZH)
  assert.equal(zh['panel.title'], NAME_ZH)
  assert.equal(zh['source.section'], '纳管资源')
  assert.equal(zh['settings.tabServers'], '纳管资源')
  assert.equal(zh['guide.description'], '纳管资源与远程文件')
  assert.equal(en['settings.title'], NAME_EN)
  assert.equal(en['guide.title'], NAME_EN)
  assert.equal(en['workbench.title'], WORKBENCH_EN)
  assert.equal(en['panel.title'], NAME_EN)
  assert.equal(en['source.section'], 'Managed resources')
  assert.equal(en['settings.tabServers'], 'Managed resources')
  assert.equal(en['guide.description'], 'Resources and remote files')
})

test('retired product names never come back to the user-facing copy', () => {
  const retired = ['SSH 管理', 'SSH 运维', 'SSH Ops', 'SSH Management', '服务器管理与远程文件', 'Servers and remote files']
  for (const [key, value] of [...zhEntries, ...enEntries]) {
    for (const phrase of retired) {
      assert.ok(!value.includes(phrase), `${key} still contains retired copy: ${phrase}`)
    }
  }
})

test('the vendored terminal renderer is embedded and its license ships', () => {
  assert.match(clientSource, /function installXtermVendor\(\)/, 'xterm must be bundled into the client script')
  assert.match(clientSource, /window\.__SdhXterm/, 'the bundled renderer must expose the xterm table')
  assert.ok(fs.existsSync(new URL('vendor/XTERM-LICENSE', root)), 'xterm license is missing')
  assert.ok(pkg.files.includes('vendor'), 'package files must ship the vendor directory and its licenses')
})

test('README carries the canonical product tagline', () => {
  assert.ok(readme.includes(NAME_ZH), 'README must name the product')
  assert.ok(readme.includes(TAGLINE_ZH), 'README must carry the canonical tagline')
  assert.ok(readme.includes('远程资源'), 'README must use the resource vocabulary')
})

test('README and quickstart use the product name and current install path', () => {
  assert.match(readme, /^# SSH Workbench（dsh-ssh-workbench）$/m)
  assert.match(readme, new RegExp(`dsh-ssh-workbench-${pkg.version.replaceAll('.', '\\.')}\\.tgz`))
  assert.match(quickstart, /设置 → 远程工作台/)
  assert.match(quickstart, new RegExp(`dsh-ssh-workbench-${pkg.version.replaceAll('.', '\\.')}\\.tgz`))
  for (const doc of [readme, quickstart]) {
    assert.ok(!doc.includes('SSH 运维'), 'documentation still points at the retired settings section')
    assert.ok(!doc.includes('SSH 管理'), 'documentation still uses the retired settings title')
    assert.ok(!doc.includes('~/.ssh/config'), 'documentation still advertises the removed ssh config import')
  }
  assert.ok(!readme.includes('浏览并编辑'), 'README still claims in-place file editing')
})
