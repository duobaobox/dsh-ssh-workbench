# 贡献指南

欢迎参与 **SSH Workbench**（中文名「远程工作台」，仓库/包名 `dsh-ssh-workbench`）的开发。

## 开发环境

```bash
git clone <repo>
cd dsh-ssh-workbench
npm test                    # 单元测试（不需要真实 SSH 服务器）
npm run test:ssh            # SSH 传输集成测试（进程内 ssh2.Server）
npm run test:ssh:sftp       # SFTP 集成测试
npm run pack                # 生成 dist/dsh-ssh-workbench-<version>.tgz
```

要求：Node.js 20+（仓库在 Node 26 上验证），npm。单元测试使用本地 stub；集成测试会启动进程内 ssh2 服务器，使用仓库 `vendor/ssh2` 里的副本（可用 `SDH_SSH2_PATH` 覆盖）。

## 目录结构

```
lib/index.js        host 半：插件入口、Config、工具注册（remote_bash / remote_pwsh / remote_exec / remote_* 文件工具）
lib/routes.js       UI 数据面：资源、凭据、连接测试、SFTP、终端、偏好
lib/client.js       client 半：工作台、设置页、侧栏面板、工具卡片、i18n
lib/core/           传输与领域模块：broker/ssh/dialect/shell-adapters/posix-shell/
                    remote-shell-tool/remote-exec-tool/remote-file-tools/managed-context/
                    mentions/execution-stats/live-executions/background/win32-adapter/
                    gate(-pwsh)/guard/store/secrets/known-hosts/activity/terminals/localfs
test/               单元测试、集成测试、基准脚本、真机回归脚本
docs/               用户文档（docs/quickstart.md、docs/architecture.md）
vendor/             随包携带的纯 JS 依赖（ssh2 及 xterm 构建输入）；版本/许可证见 vendor/NOTICE.md
```

## 依赖约定

- 发布包必须保持**零安装运行时依赖**：安装插件不运行 `node-gyp`、不下载 npm 包。需要新增纯 JS 依赖时，把它放到 `vendor/` 并在 `vendor/NOTICE.md` 登记版本与许可证，而不是加进 `dependencies`；原生依赖不要引入。
- `vendor/ssh2` 来自 ssh2 1.17.0，升级步骤见 `vendor/NOTICE.md`；升级后必须跑三套测试（`npm test`、`npm run test:ssh`、`npm run test:ssh:sftp`）。
- **后续所有版本都必须是自包含包**：不新增 `dependencies` / `optionalDependencies`，不引入安装期脚本或原生编译。

## 发布检查

每个版本发布前：

1. 确认 `package.json` 没有 `dependencies` / `optionalDependencies`，`vendor/` 与 `vendor/NOTICE.md` 完整，`npm test` 里的自包含守卫通过；
2. 跑 `npm test`、`npm run test:ssh`、`npm run test:ssh:sftp`；
3. `npm run pack` 后检查 `dist/*.tgz`：包内包含 `vendor/ssh2` 与 `vendor/node_modules`，没有 `install.js`、`binding.gyp`、`.node`；
4. 在干净目录用 DSH 自带 pnpm 执行 `pnpm add <tgz> --offline`，确认没有下载/编译且插件可加载；
5. 安装到本机 DSH profile，重启后确认版本与功能正常，再提交、打 tag、发布 Release。

## 编码约定

- 保持插件是普通 DSH bundle：不 patch 宿主、不另造审批系统。
- 远程命令的安全兜底是 `ctx.tools.guard()` 的机器级黑名单（POSIX 与 PowerShell 两套规则），其余审批跟随 DSH 会话预设。
- 工具输出必须有界（输出上限/截断）且可读；新的远程命令工具走 shell adapter，不在工具体内直接拼方言命令。
- UI 使用 DSH 设计令牌与官方组件；所有用户可见文案在 `lib/client.js` 里补中英文（zh/en key 必须成对）。
- 优先把纯逻辑放进 `lib/core/`，保持可单测；新增方言/传输行为先补测试。

## 提交 Pull Request

1. 行为变更需要补/改测试；
2. 运行 `npm test`（涉及传输时再跑集成测试）；
3. 用户可见行为变化时更新 `README.md` / `CHANGELOG.md`；
4. 提交保持聚焦，说明用户可见的效果；
5. 历史细节写进 `CHANGELOG.md`，不要往维护中文档里堆旧版本内容或过程性报告。
