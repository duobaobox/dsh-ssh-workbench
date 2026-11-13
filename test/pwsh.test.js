import test from 'node:test'
import assert from 'node:assert/strict'

import { createBlacklistGuard } from '../lib/core/guard.js'
import { classifyPowerShellCommand } from '../lib/core/gate-pwsh.js'
import {
  buildPowerShellInvocation,
  normalizeWindowsWorkdir,
  quotePowerShell,
  win32Adapter,
} from '../lib/core/win32-adapter.js'
import { createRemoteShellTool } from '../lib/core/remote-shell-tool.js'
import { posixAdapter } from '../lib/core/shell-adapters.js'

const CONFIG = {
  commandTimeoutMs: 1500,
  maxCommandTimeoutMs: 5000,
  maxOutputBytes: 4096,
  maxStderrBytes: 1024,
  timeoutKillAfterMs: 5000,
}

const SERVERS = [
  {
    id: 'srv_win',
    name: 'winbox',
    host: '10.0.0.6',
    port: 22,
    username: 'admin',
    platform: 'windows',
    defaultShell: 'powershell',
    enabled: true,
    facts: { dialect: 'windows' },
  },
  {
    id: 'srv_posix',
    name: 'web-1',
    host: '10.0.0.5',
    port: 22,
    username: 'root',
    platform: 'posix',
    enabled: true,
    facts: { dialect: 'posix' },
  },
]

function decodeScript(command) {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)\s*$/.exec(command)
  assert.ok(match, `not an encoded PowerShell invocation: ${command}`)
  return Buffer.from(match[1], 'base64').toString('utf16le')
}

function makeHarness({ runtime, servers = SERVERS, adapter = win32Adapter } = {}) {
  const execCalls = []
  const baseRuntime = {
    async timeoutGuard() {
      throw new Error('Windows targets must not probe the POSIX timeout utility')
    },
    async exec(server, command, options) {
      execCalls.push({ server, command, options })
      return {
        outcome: 'success',
        exitCode: 0,
        signal: null,
        stdout: 'ok\r\n',
        stderr: '',
        durationMs: 1,
        truncated: { stdout: false, stderr: false },
      }
    },
  }
  const merged = { ...baseRuntime, ...(runtime ?? {}) }
  const tool = createRemoteShellTool({
    runtime: merged,
    config: CONFIG,
    loadInventory: () => servers,
    adapter,
    localShellName: 'pwsh',
  })
  const exec = (sessionId = 's1') => ({ agent: { session: { id: sessionId } }, signal: { aborted: false } })
  return { tool, execCalls, runtime: merged, exec }
}

test('the PowerShell adapter builds an encoded script command', () => {
  const built = win32Adapter.buildCommand('Get-ChildItem', 'C:\\Users\\alice', SERVERS[0])
  assert.match(built.command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /)
  assert.equal(built.cwd, 'C:\\Users\\alice')
  const script = decodeScript(built.command)
  assert.match(script, /Set-Location -LiteralPath 'C:\\Users\\alice' -ErrorAction Stop/)
  assert.match(script, /\[Console\]::OutputEncoding/)
  assert.match(script, /exit 0/)
  assert.match(script, /Get-ChildItem/)
})

test('the PowerShell adapter picks pwsh.exe for pwsh default shells', () => {
  const server = { ...SERVERS[0], defaultShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }
  const built = win32Adapter.buildCommand('Get-Date', '', server)
  assert.match(built.command, /^pwsh\.exe /)
  const invocation = buildPowerShellInvocation('Write-Output ok', server)
  assert.match(invocation, /^pwsh\.exe -NoProfile -NonInteractive -EncodedCommand /)
})

test('Windows workdirs normalize to safe PowerShell location expressions', () => {
  assert.deepEqual(normalizeWindowsWorkdir(''), { kind: 'none', label: '~' })
  assert.deepEqual(normalizeWindowsWorkdir('~'), { kind: 'home', label: '~' })
  assert.deepEqual(normalizeWindowsWorkdir('~/logs'), { kind: 'relative', path: 'logs', label: '~/logs' })
  assert.deepEqual(normalizeWindowsWorkdir('logs\\today'), { kind: 'relative', path: 'logs\\today', label: '~/logs/today' })
  assert.equal(normalizeWindowsWorkdir('C:\\Users\\alice').kind, 'absolute')
  assert.equal(normalizeWindowsWorkdir('\\\\server\\share').kind, 'absolute')
  assert.match(normalizeWindowsWorkdir('C:\\Program Files\\x').path, /Program Files/)
  assert.deepEqual(normalizeWindowsWorkdir('a\nb'), { error: 'workdir must not contain newlines' })

  const relative = win32Adapter.buildCommand('dir', 'logs\\today', SERVERS[0])
  assert.match(decodeScript(relative.command), /Join-Path \$HOME 'logs\\today'/)
  const home = win32Adapter.buildCommand('dir', '~', SERVERS[0])
  assert.match(decodeScript(home.command), /Set-Location -LiteralPath \$HOME/)
  const quoted = win32Adapter.buildCommand('dir', "C:\\Users\\O'Brien", SERVERS[0])
  assert.match(decodeScript(quoted.command), /'C:\\Users\\O''Brien'/)
})

test('PowerShell quoting doubles single quotes', () => {
  assert.equal(quotePowerShell("C:\\it's"), "'C:\\it''s'")
})

test('remote_pwsh runs a Windows target and reports target/cwd/exit/stdout', async () => {
  const h = makeHarness()
  assert.equal(h.tool.name, 'remote_pwsh')
  const exec = h.exec()
  const result = await h.tool.execute({ server: 'winbox', command: 'Get-ChildItem', workdir: 'C:\\Users\\alice', timeoutMs: 5000 }, exec)
  assert.equal(h.execCalls.length, 1)
  assert.equal(h.execCalls[0].options.timeoutMs, 5000)
  assert.match(result.text, /target: winbox \(admin@10\.0\.0\.6:22\)/)
  assert.match(result.text, /cwd: C:\\Users\\alice/)
  assert.match(result.text, /exit code: 0/)
  assert.match(result.text, /stdout:\nok/)
})

test('the PowerShell adapter starts a detached script with redirected logs', () => {
  const built = win32Adapter.buildBackgroundCommand('Start-Sleep 99', 'C:\\Temp', SERVERS[0])
  assert.equal(built.cwd, 'C:\\Temp')
  assert.match(built.command, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /)
  const outer = decodeScript(built.command)
  assert.match(outer, /Start-Process -FilePath \$__sdhExe/)
  assert.match(outer, /-RedirectStandardOutput \$__sdhLog/)
  assert.match(outer, /-RedirectStandardError \$__sdhErr/)
  assert.match(outer, /__SDH_BG_PID__\$\(\$__sdhProc\.Id\)/)
  assert.match(outer, /__SDH_BG_LOG__\$__sdhLog/)
  assert.match(outer, /-WindowStyle Hidden -PassThru/)
  const innerMatch = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)
  assert.ok(innerMatch, 'outer script must carry the encoded inner script')
  const inner = Buffer.from(innerMatch[1], 'base64').toString('utf16le')
  assert.match(inner, /Set-Location -LiteralPath 'C:\\Temp'/)
  assert.match(inner, /Start-Sleep 99/)
})

test('remote_pwsh run_in_background returns the pid and Windows log hints', async () => {
  const calls = []
  const h = makeHarness({
    runtime: {
      async exec(server, command, options) {
        calls.push({ server, command, options })
        return {
          outcome: 'success',
          exitCode: 0,
          signal: null,
          stdout: '__SDH_BG_PID__31\n__SDH_BG_LOG__C:\\Temp\\bg.log\n__SDH_BG_ERR__C:\\Temp\\bg.log.err\n',
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      },
    },
  })
  const exec = h.exec()
  const result = await h.tool.execute({ server: 'winbox', command: 'Start-Sleep 99', run_in_background: true }, exec)
  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /^powershell\.exe .*-EncodedCommand /)
  assert.match(result.text, /pid: 31/)
  assert.match(result.text, /Get-Content -LiteralPath 'C:\\Temp\\bg\.log' -Wait/)
  assert.match(result.text, /Stop-Process -Id 31 -Force/)
})

test('remote_pwsh refuses POSIX targets instead of sending PowerShell', async () => {
  const h = makeHarness()
  const exec = h.exec()
  await assert.rejects(() => h.tool.execute({ server: 'web-1', command: 'Get-ChildItem' }, exec), /POSIX server/)
  assert.equal(h.execCalls.length, 0)
})

test('remote_bash refuses Windows targets and points at remote_pwsh', async () => {
  const h = makeHarness({ adapter: posixAdapter })
  const exec = h.exec()
  await assert.rejects(() => h.tool.execute({ server: 'winbox', command: 'uname -s' }, exec), /Windows server/)
  assert.equal(h.execCalls.length, 0)
})

test('a probe result overrides a wrong platform hint for the tool choice', async () => {
  const servers = [{ ...SERVERS[1], facts: {}, platform: 'posix' }]
  const h = makeHarness({
    servers,
    runtime: {
      async probeDialect() {
        return 'windows'
      },
    },
  })
  const exec = h.exec()
  const result = await h.tool.execute({ server: 'web-1', command: 'Get-Date' }, exec)
  assert.match(result.text, /target: web-1/)
  assert.match(decodeScript(h.execCalls[0].command), /Get-Date/)
})

test('a Windows timeout is reported as client-side only', async () => {
  const h = makeHarness({
    runtime: {
      async timeoutGuard() {
        throw new Error('must not probe')
      },
      async exec() {
        return {
          outcome: 'timeout',
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 1,
          truncated: { stdout: false, stderr: false },
        }
      },
    },
  })
  const exec = h.exec()
  const result = await h.tool.execute({ server: 'winbox', command: 'Start-Sleep 99', timeoutMs: 1000 }, exec)
  assert.match(result.text, /outcome: timed out/)
  assert.match(result.text, /no POSIX `timeout` wrapper/)
})

test('the PowerShell blacklist blocks disk destruction and allows reads', () => {
  for (const command of [
    'Format-Volume -DriveLetter D',
    'Clear-Disk -Number 1 -RemoveData',
    'Initialize-Disk -Number 0',
    'diskpart',
    'bcdedit /set {default} safeboot minimal',
    'cipher /w:C:',
    'vssadmin delete shadows /all',
    'Remove-Item C:\\Windows -Recurse -Force',
    'rm -r C:\\ -Force',
  ]) {
    assert.equal(classifyPowerShellCommand(command).decision, 'deny', command)
  }
  for (const command of ['Get-ChildItem C:\\', 'Get-Volume', 'Write-Output ok', 'Remove-Item .\\tmp.log -Force']) {
    assert.equal(classifyPowerShellCommand(command).decision, 'allow', command)
  }
})

test('the guard routes remote_pwsh through the PowerShell rules', () => {
  const guard = createBlacklistGuard({ loadInventory: () => SERVERS })
  const session = { id: 's1' }
  assert.match(
    guard({ name: 'remote_pwsh', arguments: { server: 'winbox', command: 'Format-Volume -DriveLetter C' }, agent: { session } }),
    /blacklist|format/i,
  )
  assert.equal(guard({ name: 'remote_pwsh', arguments: { server: 'winbox', command: 'Get-ChildItem C:\\' }, agent: { session } }), undefined)
  assert.match(guard({ name: 'remote_bash', arguments: { server: 'web-1', command: 'rm -rf /' }, agent: { session } }), /blacklist|recursive delete/i)
})
