# Vendored dependencies

This directory ships the pure-JS runtime for the SSH transport inside the plugin
package. It is **not** installed from npm at plugin-install time: keeping the
dependency graph in-tree means installing `dsh-ssh-workbench` never runs `node-gyp`,
never needs Xcode Command Line Tools / a C++ toolchain, and never downloads
packages. This intentionally trades a slightly larger tarball for an
out-of-the-box install on any machine.

| Component | Version | License | Upstream |
|---|---|---|---|
| ssh2 | 1.17.0 | MIT | https://github.com/mscdex/ssh2 |
| asn1 | 0.2.6 | MIT | https://github.com/joyent/node-asn1 |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause | https://github.com/joyent/node-bcrypt-pbkdf |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| tweetnacl | 0.14.5 | Unlicense | https://github.com/dchest/tweetnacl-js |
| xterm.js (browser bundle) | see `XTERM-LICENSE` / `xterm.js` | MIT | https://github.com/xtermjs/xterm.js |

Licence texts are kept next to each component (`vendor/ssh2/LICENSE`,
`vendor/node_modules/<name>/LICENSE`, ...).

## Layout

```
vendor/ssh2/                    ssh2 package (lib/, package.json, LICENSE)
vendor/node_modules/asn1/       runtime deps resolved by Node from vendor/ssh2
vendor/node_modules/bcrypt-pbkdf/
vendor/node_modules/safer-buffer/
vendor/node_modules/tweetnacl/
```

`vendor/ssh2/install.js`, tests, examples and the optional native crypto
binding sources have been removed: ssh2 falls back to its pure-JS crypto
implementation when the native binding is absent. `cpu-features` and `nan`
(ssh2's optional native dependencies) are intentionally not vendored; ssh2
guards both requires with `try/catch`.

## Updating the vendored copy

The tree is generated from the npm packages listed above. To refresh it:

1. Install the target versions in a scratch directory, e.g.
   `npm install --no-save ssh2@1.17.0`.
2. Copy `ssh2/lib` + `ssh2/package.json` + `ssh2/LICENSE` to `vendor/ssh2/`;
   remove `lib/protocol/crypto/src` and `lib/protocol/crypto/binding.gyp`.
3. Copy `asn1`, `bcrypt-pbkdf`, `safer-buffer` and `tweetnacl` (only the files
   their `package.json` entry points need, plus `LICENSE`) to
   `vendor/node_modules/<name>/`.
4. Run `npm test`, `npm run test:ssh` and `npm run test:ssh:sftp`; all three
   suites exercise the vendored transport.
