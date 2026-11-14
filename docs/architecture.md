# SSH Workbench（dsh-ssh-workbench）架构（v1.7.9）

> 产品定位与用法见 [README.md](../README.md)；本文只讲实现分层。

## 分层

```
lib/
├── index.js                 插件入口：Config、apply、工具注册（remote_exec + remote_bash + remote_pwsh + remote 文件工具）
├── routes.js                UI 数据面：资源管理 / 连接测试 / SFTP 文件面板 / 侧边栏偏好
├── client.js                Client 半片：左侧导航远程工作台、设置页、@ 引用 chip、右侧栏文件面板
└── core/
    ├── mentions.js          每会话 @ 提示：mention 解析、去重、历史恢复（不绑定执行目标）
    ├── managed-context.js   agent/pre-step：每轮注入资源清单与 @ 提示上下文
    ├── posix-shell.js       POSIX 远程 shell 辅助：workdir、超时包装
    ├── remote-shell-tool.js 显式 server 的 remote_bash / remote_pwsh 工具
    ├── remote-exec-tool.js  插件自有 remote_exec：显式目标、一轮 fan-out、并发池、逐任务 guard/超时/输出
    ├── remote-file-tools.js 远程文件工具：remote_read/write/edit/glob/grep（SFTP + 方言 grep；写开关）
    ├── execution-stats.js   按 Session 聚合 activity 中的远程执行次数（composer dock）
    ├── live-executions.js   进行中的远程调用（内存 in-flight，供 composer pill 实时显示，不参与执行）
    ├── server-ref.js        资源名/ID 解析与 requireServerRef 错误
    ├── shell-adapters.js    方言适配器入口：POSIX 适配器、按方言选择、宿主平台判断
    ├── win32-adapter.js     Windows 适配器：PowerShell -EncodedCommand、UTF-8、退出码、workdir
    ├── dialect.js           目标方言：facts.dialect 优先、platform 仅作提示
    ├── guard.js             ctx.tools.guard：危险命令黑名单（只 deny，按工具路由规则集）
    ├── gate.js              POSIX 命令黑名单规则与分类
    ├── gate-pwsh.js         PowerShell 命令黑名单规则与分类
    ├── background.js        后台任务：POSIX nohup / Windows Start-Process 启动器、pid/日志标记解析与展示
    ├── posix-quote.js       POSIX 单引号转义（路由与后台启动器共用）
    ├── store.js             服务器清单与持久化
    ├── secrets.js           密码/私钥口令（0600，本机密钥加密）
    ├── known-hosts.js       主机身份校验与信任记录
    ├── broker.js            连接池、通道池、超时/取消/输出截断
    ├── ssh.js               runtime 门面：exec / test / warm / SFTP
    ├── errors.js            错误分类与建议
    ├── activity.js          UI 概览用本地操作记录（非审计）
    ├── prefs.js             侧边栏等 UI 偏好（~/.dsh/ssh-workbench/prefs.json，0600）
    ├── terminals.js         交互终端会话：远程 SSH shell + 本地 PTY，缓冲/轮询/空闲回收
    ├── local-file-api.js    本地文件 API：以合成 __local__ 资源复用同一条 /sftp/* 路由面
    ├── localfs.js           本地根目录（默认用户主目录，可用 localRoot 配置）内的文件浏览与写入（realpath 规范化；越界/符号链接写入与删除防穿透）
    └── paths.js             数据目录与私有文件写入

vendor/
├── xterm.js                 终端渲染构建输入（xterm.js UMD，MIT；实际已内联进 lib/client.js，无运行时路由）
├── ssh2/                    纯 JS SSH 传输实现（MIT，随包携带；broker.js 直接 import）
└── node_modules/            ssh2 的纯 JS 运行时依赖（asn1 / bcrypt-pbkdf / safer-buffer / tweetnacl）
```

`ssh2` 不通过 `dependencies` 安装，而是以纯 JS 形式 vendor 进发布包（`vendor/ssh2` + `vendor/node_modules/`）；broker 用相对路径动态 import。这样插件安装不触发 `node-gyp`、不需要本机编译工具链、也不依赖 npm 网络，代价是包体积略大。ssh2 的可选原生模块（`cpu-features`、`nan`、`sshcrypto.node`）全部未携带，ssh2 会回退到纯 JS 实现。

## 一次远程工具执行的完整路径

1. 用户消息进入 `agent/pre-step`。
2. `managed-context.js`：
   - 从宿主消息里提取 `@名字`，匹配服务器清单；
   - 仅记录为 @ 提示（candidates），不产生 active target；每轮注入资源清单与显式 server 工具规则，模型自行选择目标；
   - 注入一条 user-role 资源上下文（source kind `ssh-workbench-target`），并 spread 下游 decision。
3. 模型选择一个远程工具并显式传 `server`：`remote_bash` / `remote_pwsh` / `remote_exec`，或远程文件工具 `remote_read` / `remote_glob` / `remote_grep`（写入需在插件管理里打开「允许远程写入」，对应 prefs 覆盖或 `remoteFileWrite` 配置）。原生 `bash` / `pwsh` 不经过插件，始终本地执行。
4. DSH 审批（本插件不参与）。
5. `ctx.tools.guard()`（`guard.js`）：从 `arguments.server`（或 `remote_exec.tasks[]` 的每个 server）解析目标，按对应方言检查黑名单 → 命中直接拒绝。`gate.js` 先把每段还原成 argv words（去引号/转义、剥 `sudo`/`timeout` 等包装、路径规范化、重定向按 token、`$()`/`eval` 递归）再匹配。
6. 工具实现（`remote-shell-tool.js` / `remote-exec-tool.js` / `remote-file-tools.js`）：
   - `remote_bash` / `remote_pwsh` 处理 `workdir`（绝对路径 / `~` / 相对路径 → `$HOME` 前缀）；
   - 逐 server 解析方言与 `timeout` 能力（`kill`/`basic`/`none` + 登录 shell 路径；`remote_exec` 的 `probe:false` 跳过探测）；
   - 可用时把命令包成 `timeout [-k N] <秒> '<shell>' -c '<命令>'`，让客户端超时同时终止远端进程组；
   - `runtime.exec(server, command, { timeoutMs, signal, cap, stderrCap, connectTimeoutMs })`；broker 建通道后立即关闭 stdin（等价 `</dev/null`），把远端 `timeout` 的 exit 124 映射回 timeout 结果，并对 stdout/stderr 分别限长；
   - 返回带 server / dialect / cwd / 退出码 / stdout / stderr 的文本结果；超时/取消说明远端是否已终止。
7. `remote_exec` 的多个 task 在同一个 assistant step 内并发执行（最多 `batchConcurrency`），结果按输入顺序渲染；`isConcurrencySafe` 让 DSH 的并行调度器可以真正重叠调用。

## 多资源并行

`remote_exec({ tasks: [{ server, command, workdir?, timeoutMs?, run_in_background? }], concurrency? })` 是插件自有的 `defineTool`，不走 `tools/execute`：

- **显式目标**：每个 task 自己带 `server`，不依赖也不修改任何会话目标状态；`server: "local"` 被拒绝，任务只能落在纳管资源上。
- **全量预检**：先解析全部 server、方言、workdir、timeout；任一 task 非法则整批拒绝，不会执行一半。
- **真正并发**：工具声明 `isConcurrencySafe: () => true`，DSH 的 batch 调度会把它和其他 parallel-safe 调用一起放进有界并发池；工具内部再按 `batchConcurrency`（默认 4，最大 8）跨服务器并发。单台服务器仍受 `maxChannelsPerServer` 约束。
- **逐任务隔离**：每个 task 按自己的 `facts.dialect` 选择 POSIX/Windows 适配器与 guard 规则；超时、传输失败、非零退出码只影响该任务，结果按输入顺序渲染。
- **输出预算**：一次 batch 共享 `maxBatchOutputBytes`（默认 256 KiB），每个 task 先取 `maxOutputBytes` 与均分预算的较小值，避免一次 fan-out 撑爆上下文。
- **后台任务**：每个 task 可单独设置 `run_in_background`；启动后该任务立即返回远端 pid 与日志，其余 task 继续并发执行。
- **UI**：composer 下方 pill 是执行账本的只读投影，结构对齐 DSH 内置 Token 用量弹窗：标题行「远程执行」+ 本 Session 总次数、0.5px 分隔线、目标名 → 执行次数。不显示成功/失败、用时或模型指标，也不承担切换或打开工作台；它只反映工具调用的开始/结束，后台任务启动后 pill 消失不代表远端进程结束。终端/文件从左侧工作台进入。弹层通过 `react-dom.createPortal` 挂到 `document.body`，避免被 composer 的 stacking context 裁切。没有执行记录时不显示，因此不存在“切本地后残留”。

## 多宿主与多方言

DSH 的内置 shell 工具按宿主平台二选一：POSIX 宿主有 `bash`、没有 `pwsh`；Windows 宿主有 `pwsh`、没有 `bash`。远程执行不依赖宿主自带的 shell——三种远程工具在**两种宿主上都注册**，按目标方言分派：

| 目标方言 | 工具 | 执行器 |
|---|---|---|
| POSIX | `remote_bash` | `posixAdapter` + 可选远端 `timeout` 包装 |
| Windows | `remote_pwsh` | `win32Adapter`（UTF-16LE `-EncodedCommand`） |
| 混合（多目标） | `remote_exec` | 逐 task 按各自方言选适配器 |

- 目标方言由连接后的探测决定（`uname -s` 成功 → posix；否则 `cmd /c ver` 成功 → windows），写入 `facts.dialect`；`platform` 字段只作探测前提示。`effectiveDialect()` 是唯一读取入口。
- 方言决定命令构造：POSIX 用 `cd -- ... && ...` + 可选 `timeout` 包装；Windows 用 UTF-16LE base64 的 `powershell -EncodedCommand` 脚本（内含 UTF-8 输出、`Set-Location`、显式退出码），没有远端 `timeout`。
- `remote_bash` 与 `remote_pwsh` 互相拒绝错误方言并给出改用建议；即使 `platform` 手填错误，探测结果也会纠正。
- `ctx.tools.guard()` 按每个显式 server 的方言选择 POSIX 或 PowerShell 规则集；facts 缺失时两套都跑。

## 后台任务

`run_in_background: true` 不再报错，而是启动一个**脱离 SSH 会话**的远端进程：

- POSIX：`sh -c '<脚本>'` 内用 `nohup "$SHELL" -lc` 启动命令，stdout/stderr 重定向到 `~/.dsh/ssh-workbench/logs` 下 `mktemp` 生成的日志（`DSH_SSH_WORKBENCH_LOG_DIR` 可覆盖，目录不可写时回退 `/tmp`）；启动器打印 `__SDH_BG_PID__` / `__SDH_BG_LOG__` 标记。
- Windows：外层 PowerShell 用 `Start-Process -RedirectStandardOutput/-RedirectStandardError -WindowStyle Hidden -PassThru` 启动内层编码脚本，输出 `__SDH_BG_PID__` / `__SDH_BG_LOG__` / `__SDH_BG_ERR__`。
- 工具/路由解析标记后返回 pid、日志路径与读取/停止命令；`remote_exec` 的每个 task 各自解析并返回自己的 pid/日志；启动失败（没有 pid）返回 `REMOTE_BACKGROUND_FAILED`（原生 bash 路由）或该 task 的 `background start failed` 错误。
- 远端进程不在 DSH 本地 `job_*` 注册表里：`job_output` 看不到它，模型用 `tail` / `Get-Content` 取输出、`kill` / `Stop-Process` 停止；`timeoutMs` 与取消只作用于启动调用。

## 关键契约（来自 DSH，非本插件发明）

- `tools/execute`：`(exec, next) => ToolExecutionResult`，返回 `{ value }` 替换执行；官方插件 `dsh-tool-call-timeout-policy` 同款用法。
- `agent/pre-step`：返回 `{ kind: 'enter', messages }`，改写必须 spread。
- `ctx.tools.guard()`：同步、单调的拒绝；在审批之后执行。
- 原生 `bash` 输出值：`{ kind:'foreground', cwd, exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr }`。
- 模型可见工具：`remote_exec`、`remote_bash`、`remote_pwsh`、`remote_read`、`remote_glob`、`remote_grep`、`remote_write`、`remote_edit` 在两种宿主上都注册；默认只读工具可用，写工具在写入开关打开前明确拒绝；开关来自插件管理里的「允许远程写入」，未设置时回落到 `remoteFileWrite` 配置。原生 `bash` / `pwsh` / `read` / `write` / `edit` / `glob` / `grep` 保持本地语义。`remote_exec` 与只读文件工具声明 `isConcurrencySafe:true`，shell 与写文件工具保持 exclusive。

## @ 提示生命周期

- 存储：进程内 `Map<sessionId, {candidates, version, injectedVersion, seeded}>`；只有 @ 提示，没有执行绑定。
- 来源：人类消息里的 `@名字`，由 `mentions.js` 解析并匹配清单；`managed-context.js` 每轮把它连同资源清单写进上下文。
- 恢复：会话恢复后首次 `agent/pre-step` 用 `session.deriveMessages()` 回放历史人类消息。
- 清理：`agent/disposed` 或插件卸载。

## 执行账本

- `activity.js` 记录每次远程调用（`server` / `sessionId` / `durationMs` / `outcome`），是 composer pill 的唯一数据源。
- `execution-stats.js` 按 Session 聚合出 `{count, servers:[{name,count}]}`；`live-executions.js` 只保存进行中的调用，两者都不参与执行决策，也不写入 Session。

## 降级行为

| 情况 | 行为 |
|---|---|
| 没有 @ 提示 | 原生工具完全本地，零开销 |
| `targetContext:false` | 不注入资源清单/`@` 提示；显式 server 工具仍可用 |
| `ctx.tools.guard` 不可用（旧 DSH） | 记录 warning，黑名单关闭，其余功能不变 |
| 目标被删除/禁用/方言不匹配 | 返回结构化错误，提示重新选择目标或改用另一种 remote 工具 |
| 远端没有 `timeout` 工具 | 命令不加包装；超时只停止等待，stderr 提示远端可能仍在运行 |
| 非 ASCII 服务器名 | host/client 两侧都支持 Unicode 名称；`@测试机` 可直接绑定 |
| host facts 采集失败 | 只影响 UI/上下文摘要，不影响执行；下次测试/选中目标时重试 |
| SFTP 分块卡死 | `transferChunkTimeoutMs` 到点关闭会话并报 `SFTP_TIMEOUT`，UI 可从 offset 续传 |
| 远程 home 解析失败 | `/sftp/home` 返回可读错误，工作台文件面板回退到 `/` |
| 多个 `@` | 模型按资源清单选择目标，或直接发 `remote_exec` 并行；没有可切换的 active target，不会静默跑本地 |
| 服务器清单损坏 | 路由返回错误结果，不影响本地工具 |

## 安全边界

- 黑名单只拦机器毁灭类命令，不是权限边界。`remote_exec` 的每个 task 都会按目标方言过 guard，但批量并发不改变权限边界。
- 远程命令不受 DSH 本地沙箱约束；是否审批由 DSH 会话预设决定。
- 凭据与主机身份：见 `secrets.js` / `known-hosts.js`；未知指纹不会被静默信任。
- 插件不写 Session 事件、不做审计日志；`activity.json` 只是 UI 概览。
