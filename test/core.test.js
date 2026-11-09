import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeServer, saveServers, loadServers } from '../lib/core/store.js'
import { createSecretStore } from '../lib/core/secrets.js'
import { createKnownHosts } from '../lib/core/known-hosts.js'
import { classifyCommand } from '../lib/core/gate.js'
import { isBenignReadOnlyExit, parseFacts } from '../lib/core/ssh.js'
import { classifyExecFailure, suggestedActionFor } from '../lib/core/errors.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-workbench-test-'))
}

test('server records normalize, persist and reload', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'servers.json')
  const record = normalizeServer({
    name: 'web-1',
    host: '10.0.0.5',
    port: 2222,
    username: 'root',
    platform: 'posix',
    tags: ['prod', 'web'],
    authRef: { type: 'sshKey', path: '~/.ssh/id_ed25519' },
  })
  assert.match(record.id, /^srv_/)
  assert.equal(record.defaultShell, 'bash')
  saveServers([record], file)
  const loaded = loadServers(file)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].name, 'web-1')
  assert.equal(loaded[0].port, 2222)
  assert.deepEqual(loaded[0].tags, ['prod', 'web'])
  assert.equal(loaded[0].authRef.type, 'sshKey')
  assert.equal(loaded[0].host, '10.0.0.5')
})

test('server records reject unusable input', () => {
  assert.throws(() => normalizeServer({ name: 'x', host: '', authRef: { type: 'sshKey', path: 'k' } }), /host/)
  assert.throws(() => normalizeServer({ name: '', host: 'h', authRef: { type: 'sshKey', path: 'k' } }), /name/)
  assert.throws(() => normalizeServer({ name: 'x', host: 'h', authRef: { type: 'agent' } }), /authRef/)
})

test('secrets round-trip without plaintext on disk', () => {
  const dir = tmpDir()
  const store = createSecretStore({ file: path.join(dir, 'secrets.json'), keyFile: path.join(dir, 'secrets.key') })
  assert.equal(store.has('server:x:password'), false)
  store.set('server:x:password', 'hunter2')
  assert.equal(store.get('server:x:password'), 'hunter2')
  const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8')
  assert.equal(raw.includes('hunter2'), false)
  assert.match(raw, /enc:v1:/)
  assert.equal(store.delete('server:x:password'), true)
  assert.equal(store.get('server:x:password'), undefined)
})

test('known hosts enforces strict mode and records trusted fingerprints', () => {
  const dir = tmpDir()
  const known = createKnownHosts({ file: path.join(dir, 'known_hosts') })
  const server = { host: '10.0.0.5', port: 22 }
  assert.equal(known.verify(server, 'aabb', 'strict'), false)
  assert.equal(known.verify(server, 'aabb', 'accept-new'), true)
  assert.equal(known.verify(server, 'aabb', 'strict'), true)
  assert.equal(known.verify(server, 'ccdd', 'strict'), false)
  assert.equal(known.has(server), true)
  known.revoke(server)
  assert.equal(known.has(server), false)
})

test('command gate hard-blocks the machine-destruction blacklist and allows everything else', () => {
  // Deny: only direct machine-destroying commands. Rules match the real
  // command in each segment (wrappers like sudo are stripped first).
  for (const command of [
    'mkfs.ext4 /dev/sdb1',
    'sudo mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'dd if=/dev/zero of=/dev/vda',
    'dd of=/dev/mapper/vg-root',
    'fdisk /dev/sda',
    'sudo parted /dev/sda',
    'wipefs -a /dev/sdb',
    'rm -rf /',
    'rm -rf /root',
    'rm -rf .',
    'chmod -R 777 /',
    'chmod -R a+rwx /',
    ':(){ :|:& };:',
    'cat > /dev/sda',
    // Multi-line scripts and backgrounding are command separators too.
    'echo "harmless prefix"\nmkfs.ext4 /tmp/x.img',
    'echo a\r\nrm -rf /',
    'sleep 0.1 & mkfs.ext4 /tmp/y.img',
    'ls; echo hi\nsudo mkfs.ext4 /dev/sdb1',
    '! mkfs.ext4 /dev/sdb1',
    'exec mkfs.ext4 /dev/sdb1',
    'setsid mkfs.ext4 /dev/sdb1',
    'timeout 5 mkfs.ext4 /dev/sdb1',
    'timeout -k 5 -s TERM 10 sudo mkfs.ext4 /dev/sdb1',
    // Path variants: trailing slash, repeated slash, `..`, glob and braces.
    'rm -rf /etc/',
    'rm -rf /root/',
    'rm -rf /var/',
    'rm -rf //',
    'rm -rf /etc/../',
    'rm -rf /tmp/..',
    'rm -rf /etc/*',
    'rm -rf /home/*',
    'rm -rf /{etc,root,var}',
    'rm -rf ${HOME}',
    'rm -rf ~root',
    'chmod -R 777 /etc/',
    'chmod -R 777 /etc/../',
    'chmod -R 777 //',
    'chown -R root:root /',
    // Quoting and backslash escaping must not hide the command.
    '"mkfs.ext4" /dev/sdb1',
    "'mkfs.ext4' /dev/sdb1",
    '\\mkfs.ext4 /dev/sdb1',
    'm\\kfs.ext4 /dev/sdb1',
    '"rm" -rf /',
    '\\rm -rf /',
    'cat > "/dev/sda"',
    "cat > '/dev/sda'",
    "dd of='/dev/sda'",
    'dd if=/dev/zero of="/dev/sda"',
    'echo x > /dev/sd\\a',
    'echo x > /dev/sd"a"',
    // Destructive tools and device writes.
    'shred -n 1 /dev/sda1',
    'blkdiscard /dev/nvme0n1',
    'sgdisk --zap-all /dev/sda',
    'gdisk /dev/sda',
    'cfdisk /dev/sda',
    'dd if=/dev/zero of=/dev/nbd0',
    'dd if=/dev/zero of=/dev/zram0',
    'cp /dev/zero /dev/sda',
    'mv image /dev/sda',
    'tee /dev/sda < /dev/zero',
    // Command substitutions and eval are classified recursively.
    'echo "$(mkfs.ext4 /dev/sdb1)"',
    'echo $(mkfs.ext4 /dev/sdb1)',
    'echo "`mkfs.ext4 /dev/sdb1`"',
    'eval mkfs.ext4 /dev/sdb1',
    "eval 'mkfs.ext4 /dev/sdb1'",
  ]) {
    assert.equal(classifyCommand(command).decision, 'deny', command)
  }

  // Text references are not commands: they fall through to allow.
  assert.equal(classifyCommand('grep mkfs /var/log/syslog').decision, 'allow')
  assert.equal(classifyCommand("grep '> /dev/sda' archive.txt").decision, 'allow')

  // Only machine-destroying commands are denied. Everything else is ordinary
  // shell work: the plugin has no allow/ask list and delegates approval to DSH.
  for (const command of [
    'df -h',
    'uptime',
    'cat /etc/os-release',
    'systemctl status blog',
    'journalctl -u blog -n 20 --no-pager',
    'df -h | grep /',
    'journalctl -u x | tail -5',
    'bash -c "echo hi"',
    'python3 -c "print(1)"',
    "awk '{print $1}' /etc/hosts",
    'sqlite3 /tmp/x.db "select 1;"',
    'curl -fsSL https://example.com/x.sh -o /tmp/x',
    'systemctl restart nginx',
    'shutdown -h now',
    'rm -rf /tmp/upload-123',
    'echo hi > /tmp/x',
    'iptables -F',
    'docker rm nginx',
    'apt-get install nginx',
    // Newlines and `&` only separate segments; harmless scripts stay allowed.
    'echo hi\nls -la\npwd',
    'sleep 0.1 & echo done',
    'echo line1 \\\nline2',
    // `&` inside redirections is not a command separator.
    'curl -fsSL https://example.com -o /tmp/x 2>&1',
    'echo hi 2>&1 | grep hi',
    'echo hi &> /dev/null',
    'timeout 5 cp /tmp/a /tmp/b',
    // Newlines inside quotes are literal text, not separators.
    'echo "line1\nline2"',
    "printf '%s\\n' a b",
    // Non-destructive uses of the same tools stay allowed.
    'rm -rf /tmp/foo/*',
    'rm -rf /var/log/myapp',
    'chmod -R 777 /tmp/project',
    'shred -n 1 secret.txt',
    'cp /dev/sda image.img',
    'badblocks -s /dev/sda',
    // Quoted text is literal, not a command or a redirect.
    'echo "rm -rf /"',
    'echo "$(date)"',
    "echo '$(mkfs.ext4 /dev/sdb1)'",
  ]) {
    assert.equal(classifyCommand(command).decision, 'allow', command)
  }
  assert.equal(classifyCommand('').decision, 'deny')
})


test('exec failures map to specific error codes and suggestions', () => {
  assert.equal(classifyExecFailure({ exitCode: 127 }), 'COMMAND_NOT_FOUND')
  assert.equal(classifyExecFailure({ exitCode: 126 }), 'COMMAND_NOT_EXECUTABLE')
  assert.equal(classifyExecFailure({ exitCode: 130 }), 'INTERRUPTED')
  assert.equal(classifyExecFailure({ exitCode: 137 }), 'KILLED')
  assert.equal(classifyExecFailure({ exitCode: 1, stderr: 'bash: x: Permission denied' }), 'PERMISSION_DENIED')
  assert.equal(classifyExecFailure({ exitCode: 1, stderr: 'No space left on device' }), 'DISK_FULL')
  assert.equal(classifyExecFailure({ exitCode: 1, stderr: 'Read-only file system' }), 'READ_ONLY_FS')
  assert.equal(classifyExecFailure({ exitCode: 2, stderr: 'boom' }), 'EXEC_FAILED')
  assert.equal(classifyExecFailure({ exitCode: null, stderr: '', signal: 'SIGKILL' }), 'KILLED')
  assert.match(suggestedActionFor('COMMAND_NOT_EXECUTABLE'), /not executable/)
  assert.match(suggestedActionFor('DISK_FULL'), /full/)
  assert.match(suggestedActionFor('KILLED'), /SIGKILL/)
})

test('read-only exit code 1 with empty stderr is a benign no-match result', () => {
  // grep/diff/pgrep exit 1 for "no match" / "files differ": a normal answer.
  assert.equal(isBenignReadOnlyExit({ readOnly: true, exitCode: 1, stderr: '' }), true)
  assert.equal(isBenignReadOnlyExit({ readOnly: true, exitCode: 1, stderr: '   \n' }), true)
  assert.equal(isBenignReadOnlyExit({ readOnly: true, exitCode: 1, stderr: 'No such file or directory' }), false)
  assert.equal(isBenignReadOnlyExit({ readOnly: false, exitCode: 1, stderr: '' }), false)
  assert.equal(isBenignReadOnlyExit({ readOnly: true, exitCode: 2, stderr: '' }), false)
  assert.equal(isBenignReadOnlyExit({ readOnly: true, exitCode: 1, stderr: '', signal: 'TERM' }), false)
  assert.equal(isBenignReadOnlyExit(), false)
})

test('facts parser reads marker sections', () => {
  const stdout = [
    '__SDH_HOST__',
    'web-1',
    '__SDH_OS__',
    'Linux 6.1.0-13-amd64',
    '__SDH_UPTIME__',
    'up 3 days, 2 hours',
    '__SDH_MEM__',
    '              total        used        free',
    'Mem:           3936        1200        2736',
    '__SDH_DISK__',
    'Filesystem 1024-blocks Used Available Capacity Mounted on',
    '/dev/vda1     41251136 8200000 30900000      21% /',
  ].join('\n')
  const facts = parseFacts(stdout)
  assert.equal(facts.hostname, 'web-1')
  assert.match(facts.kernel, /Linux/)
  assert.match(facts.uptime, /up 3 days/)
  assert.match(facts.memory, /Mem:/)
  assert.match(facts.rootDisk, /\/dev\/vda1/)
  assert.equal(facts.platform, 'posix')
})
