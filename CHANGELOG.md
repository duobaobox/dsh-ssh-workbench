# 更新日志

记录 `dsh-ssh-workbench` 的重要变更。版本号遵循语义化版本。

> 产品对外名称：**SSH Workbench / 远程工作台**（v1.6.4 起统一）。包名 `dsh-ssh-workbench`、数据目录 `~/.dsh/ssh-workbench`。历史条目中的旧标识已统一为当前名称，便于检索。

## [1.7.1] - 2026-11-13

### 新增

- 插件管理页新增「允许远程写入」开关：`remote_write` / `remote_edit` 不必再改配置文件，直接在「插件 → 远程工作台」里打开或关闭。开关存在本地偏好（`~/.dsh/ssh-workbench/prefs.json`），未设置时回落到 `remoteFileWrite` 配置，因此既可以用 UI 临时启用，也可以用配置文件做默认值。
- `GET /state` 的 `config.remoteFileWrite` 现在返回**实际生效**的值（偏好优先、配置兜底），设置页、模型上下文与工具拒绝逻辑共用同一判定。
- 写开关变化会立即生效：工具执行时按调用解析，模型上下文每轮重新读取，不需要重启 DSH。

### 变更

- 写工具与上下文里「写入已关闭」的提示不再指向裸配置项，改为提示在插件设置里打开开关。
- `POST /dsh-ssh-workbench/prefs` 现在同时接受 `sidebar` 与 `remoteFileWrite`，返回体带上生效后的 `config`；只传 `sidebar` 仍然兼容。

## [1.7.0] - 2026-11-13

以 1.6.4 为基线的一个中版本：远程执行改为「每次调用显式带目标」，并补齐远程文件工具、多资源并行与执行指示。

### 执行模型：每个远程调用显式带目标

- 移除会话级 active target、`ssh_workbench_target` 工具和原生 `bash` 的远程拦截。原生 `bash` / `pwsh` 现在始终只在本机运行；远程工作只有一条路：显式指定 `server`。
- 工具矩阵统一为 `remote_bash({ server, command })`（POSIX 目标）、`remote_pwsh({ server, command })`（Windows 目标）、`remote_exec({ tasks: [{ server, command }] })`（多目标并行）；两种宿主都注册全部远程工具。
- `@资源名` 不再改变执行状态，只作为本轮目标提示进入上下文；后续无 `@` 的追问不会把命令静默带走。切回本机不需要任何「切换目标」动作。
- 每轮上下文始终注入纳管资源清单（名称 / 平台 / 状态）与显式 server 工具规则；无 `@` 时模型也能直接选目标，并明确禁止读取 `servers.json` 猜配置。
- 删除旧的 `TARGET_NOT_SELECTED`、target store replay/POST `/target`、native bash router 及其测试。

### 远程文件工具

- 新增 `remote_read`、`remote_glob`、`remote_grep`：远程文件读取/查找/搜索，全部显式 `server`，通过 SFTP（read/glob）或目标方言命令（grep）执行，并受结果/输出上限约束。
- 新增 `remote_write`、`remote_edit`：默认关闭，需在配置中显式设置 `remoteFileWrite: true`；`remote_edit` 默认要求 oldText 唯一匹配，可用 `replaceAll: true` 覆盖。
- 原生 `read`/`write`/`edit`/`glob`/`grep` 仍只作用于本地；远程文件能力是显式的 `remote_*` 工具，不做 SSHFS 或透明重定向。
- 新增配置：`remoteFileReadBytes`（262144）、`remoteFileEditBytes`（2097152）、`remoteFileWrite`（false）、`remoteGlobMaxResults`（200）、`remoteGlobMaxDepth`（4）、`remoteGrepMaxResults`（200）。

### 多资源并行

- `remote_exec({ tasks: [{ server, command, workdir?, timeoutMs? }], concurrency? })` 一次调用跨多台服务器并行采集；不读取也不改变任何会话目标状态。
- 全量预检后再执行：任一 task 的目标/命令/目录/超时非法时整批拒绝，不会执行一半；单任务失败、传输错误或超时只影响该任务，结果按输入顺序返回。
- 声明 `isConcurrencySafe: true`，由 DSH 工具批处理调度并行；工具内部再按 `batchConcurrency`（默认 4，上限 8）跨服务器并发，并受单连接 `maxChannelsPerServer` 约束。
- 配置新增 `maxBatchTasks`、`batchConcurrency`、`maxBatchOutputBytes`；输出预算按任务均分，避免一次 fan-out 撑爆上下文。

### 状态查询性能

- `remote_exec` 新增 `probe:false`：跳过方言探测和 `timeoutGuard` 能力探测，直接用 `facts.dialect` / 记录平台判断。
- 新增 `connectTimeoutMs`：按调用限制 SSH 建连时间，一路透传到 broker 的 `readyTimeout`；状态类批量查询可用 `probe:false + connectTimeoutMs: 4000`，避免不可达目标拖满 15–30 秒。

### 执行指示（composer pill）

- 底部 pill 是执行账本的只读投影，结构对齐 DSH Token 用量卡：标题「远程执行」+ 总次数、分隔线、目标名 → 次数；不显示成功/失败或用时，不承担切换目标或打开工作台。
- 远程调用进行中显示实时目标：单目标 `host165 · 执行中`，多目标 `2 个目标 · 执行中`；结束后回退为本会话次数（`远程执行 · N 次`）。1.5 秒轮询。
- 通过 around-dispatch 的 `tools/execute` 钩子维护内存 in-flight 记录，覆盖全部 `remote_*` 工具；不恢复 active target，不改变执行语义。

### 安全

- 黑名单 guard 从工具参数解析显式 `server`；`remote_exec` 逐 task 校验，任一 task 命中则整批拒绝；方言事实缺失时同时跑 POSIX 与 PowerShell 规则。
- 原生 `bash` / `pwsh` 是本地工具，不再经过远程黑名单。

### 整理

- 模块按当前职责重命名：`mentions.js`（@ 提示）、`posix-shell.js`（POSIX 命令构造）、`remote-shell-tool.js`（远程 shell 工具）、`managed-context.js`（每轮上下文注入）、`execution-stats.js`（执行统计）。
- 删除遗留死代码与过时注释，统一文档与代码中的执行模型表述。
- 测试 220/220，SSH/SFTP 集成测试通过。

## [1.6.4] - 2026-11-09

### 品牌统一：SSH Workbench / 远程工作台

- 插件、npm 包、GitHub 仓库与文档从 `sdh-ssh-ops` 改名为 `dsh-ssh-workbench`；中文名统一为「远程工作台」，英文名 **SSH Workbench**。
- 模型工具 `ssh_ops_target` 改名为 `ssh_workbench_target`；Web 数据面路由 `/sdh-ssh-ops/*` 改为 `/dsh-ssh-workbench/*`；Client 模块 id、localStorage key、CSS 命名空间同步更新。
- 数据目录从 `~/.dsh/ssh-ops` 迁移到 `~/.dsh/ssh-workbench`，旧目录在首次启动时自动迁移；仍可用 `DSH_SSH_WORKBENCH_DIR` 覆盖。
- 安装包继续零运行时依赖、自包含；README 增加 npm 安装方式，并补充远程工作台定位与差异化说明。

## [1.6.3] - 2026-11-09

### 自包含安装：不再需要原生编译

- 移除 npm 运行时依赖 `ssh2`，把 ssh2 1.17.0 和它的纯 JS 依赖（`asn1` / `bcrypt-pbkdf` / `safer-buffer` / `tweetnacl`）vendor 到 `vendor/`；`broker.js` 直接动态 import 包内副本。
- 修复在未安装 Xcode Command Line Tools 的 Mac 上安装时，`cpu-features` 的 `node-gyp` 编译失败或被 DSH 安装器 60 秒无输出看门狗终止、界面显示「未能获取安装结果 / exit code 1」的问题。
- 安装插件不再需要编译工具链，也不额外下载依赖，离线机器可安装；发布包约 515 KB（解压约 2.1 MB），随包附带 `vendor/NOTICE.md` 及各组件 LICENSE。ssh2 的可选原生模块（`cpu-features` / `nan` / `sshcrypto.node`）不随包携带，自动回退纯 JS 实现。
- 集成测试改用 `vendor/ssh2`，不再依赖本机 DSH profile 中安装的 ssh2；CI 增加 SSH/SFTP 集成测试步骤。

## [1.6.2] - 2026-11-08

### 开源文档收敛

- 删除仓库中的过程性文档：v1.3 QA 报告/修复记录/证据截图与脚本、旧设计文档（design-v1.0）、命名计划、产品文案内部文档；仓库只保留 README、quickstart、architecture、CONTRIBUTING、SECURITY、CHANGELOG。
- 测试与示例数据脱敏：真实服务器地址/主机名/用户名替换为文档专用地址（`192.0.2.0/24` 等）与通用占位符，不再包含个人目录路径。
- 文档链接收敛：README/CONTRIBUTING/architecture 只链接当前维护文档；`package.json` 的发布清单同步精简。
- 无用户可见行为变化；`npm test` 213/213。

## [1.6.1] - 2026-11-08

### 收尾：死代码清理 + 文档归档

- 移除已下线/未使用代码：`~/.ssh/config` 导入器（`parseSshConfig` / `importSshConfig` / `readSshConfig`）及测试、`selectServers`/`serverSummary`/`findServer`、`collectMentions`、`dialectLabel`、`adapterForDialect`、`createRemoteBashTool` 兼容别名、`/server/refresh-facts` 死路由，以及 client 端 6 个未引用函数与 5 个未使用图标常量。
- 文档清理：移除 v1.3 实测/修复/证据记录、旧设计文档与产品文案内部文档；仓库只保留用户文档（README/quickstart/architecture）与贡献者文档。
- 文档校正：README/CONTRIBUTING/quickstart/architecture 与当前实现对齐（方言探测、`remote_bash`/`remote_pwsh`、后台任务、平台徽标、测试命令与目录结构）。
- 权限分级（readonly/write/full）确认不做；安全定位保持“黑名单 best-effort + DSH 审批 + 最小权限 SSH 账号”。
- 无用户可见行为变化；`npm test` 213/213，SSH/SFTP 集成测试通过。

## [1.6.0] - 2026-11-08

### 后台任务 + Windows 本地文件面板/平台徽标

- **后台任务统一**：`run_in_background: true` 从“直接报不支持”改为真正启动远端后台进程。POSIX 目标用 `nohup "$SHELL" -lc` 启动并把 stdout/stderr 重定向到 `/tmp` 日志；Windows 目标用 `Start-Process -RedirectStandardOutput/-RedirectStandardError -WindowStyle Hidden -PassThru` 启动内层 PowerShell 脚本。启动器输出 pid/日志标记，工具返回 pid、日志路径以及 `tail -f` / `kill`（POSIX）或 `Get-Content -Wait` / `Stop-Process`（Windows）提示；没有产生 pid 时返回 `REMOTE_BACKGROUND_FAILED`。原生 bash 路由（POSIX 宿主）同样支持。
- 后台进程与工具调用脱离，调用返回后继续运行；它不在 DSH 本地 `job_*` 注册表里，`timeoutMs`/取消只作用于启动调用。POSIX 日志生成在 `/tmp`，可能被系统清理。
- **Windows 本地文件面板**：面包屑、上级目录、路径拼接、预览文件名全部改为按根路径识别分隔符（`C:\` / UNC 用 `\`，其余用 `/`）；修复 Windows 上 `C:\Users\...` 被当成一个路径段、混合分隔符导航的问题。
- **平台徽标**：资源列表/设置页新增 Linux / Windows 徽标，取自连接后探测的 `facts.dialect`；连接测试结果显示探测到的平台；`/servers`、`/state` 与 `serverSummary` 都返回 `dialect`。
- 后台任务的 PowerShell 启动脚本同样经过 `-EncodedCommand`，无本地 shell 依赖；POSIX 启动器在 `sh -c` 内运行，fish/csh 登录 shell 只需要解析外层简单命令。

## [1.5.0] - 2026-11-08

### 目标方言自动探测 + Windows 目标 `remote_pwsh`

- **方言探测**：连接测试/选中目标时执行 `uname -s`（POSIX）和 `cmd /c ver`（Windows）探测目标真实方言，写入 `facts.dialect`；清单里的 `platform` 降级为探测前的提示值。原生 bash 路由、`remote_bash`、`remote_pwsh`、超时包装、broker 的 cwd 前缀与连接探针、目标上下文统一读取 `effectiveDialect()`，不再相信手填字段。
- **`remote_pwsh`（Windows 目标）**：macOS/Linux 与 Windows 宿主都注册。命令包装成 UTF-16LE base64 的 `powershell -NoProfile -NonInteractive -EncodedCommand`，不依赖 sshd 默认 shell 是 `cmd.exe` 还是 PowerShell，也避免引号转义；脚本内强制 UTF-8 输出、`workdir` 用 `Set-Location -LiteralPath`、显式回传 `$LASTEXITCODE` / `$?`。Windows 没有 POSIX `timeout`，超时/取消只停止客户端等待，结果文本会明确提示进程可能仍在运行。
- **PowerShell 黑名单**：`ctx.tools.guard()` 按工具名路由规则集，新增 `Format-Volume`、`Clear-Disk`、`Initialize-Disk`、`Remove-Partition`、`diskpart`、`bcdedit`、`cipher /w`、`vssadmin/wbadmin delete`、整盘/系统目录递归删除等（仍是 best-effort，不是权限边界）。
- **工具矩阵**：POSIX 宿主 = 原生 `bash`（POSIX 目标）+ `remote_pwsh`（Windows 目标）；Windows 宿主 = `remote_bash`（POSIX 目标）+ `remote_pwsh`（Windows 目标）。`remote_bash` 与 `remote_pwsh` 会互相拒绝错误方言并给出改用建议，即使 `platform` 提示填错也能靠探测纠正。
- `ssh_workbench_target` 的描述/返回与目标上下文按方言给出正确工具名（`bash` / `remote_bash` / `remote_pwsh`）和 `workdir` 参数写法；连接测试结果返回探测到的平台。

## [1.4.0] - 2026-11-08

### Windows 宿主可远程执行：插件自有 `remote_bash` + 条件式目标上下文

- **根因**：Windows 版 DSH 按平台禁用内置 `bash`（`dsh-web-app` 的 preset 里 `tool-bash` 带 `disabled: process.platform === 'win32'`，同时只启用 `pwsh`）。插件此前通过 `tools/execute` 拦截名为 `bash` 的工具调用，因此在 Windows 宿主上永远不命中：远程执行静默失效，但 `@资源` 注入的上下文仍写着“bash 在远端执行”。
- **Windows 宿主**上现在注册插件自有工具 `remote_bash`（POSIX 目标）：参数 `command` / `workdir` / `timeoutMs`，复用现有 SSH 运行时、远端 `timeout` 包装、输出截断、危险命令黑名单与活动记录；原生 `pwsh` 不再被拦截，始终只在本机执行。
- **POSIX 宿主**（macOS/Linux）行为不变：继续复用原生 `bash` 路由，保留原生终端卡片与全部参数语义。顺带修复了“目标被标成 Windows 时，上下文仍声称 bash 可远程执行”的误导。
- **目标上下文条件化**：只有宿主确实存在远程执行通道时才注入；文案按宿主平台使用正确的工具名（`bash` / `remote_bash`）与 `workdir` 参数写法；`ssh_workbench_target` 的描述、成功返回和 detach 返回同步更新。
- 黑名单 guard 同时覆盖 `bash` 与 `remote_bash`。
- **修复 Windows 上工作台“本机”终端**：此前固定给本地 shell 传 POSIX 的 `-i`（`cmd.exe`/`pwsh` 不接受），现在按 `terminalEnvironment().platform` 分支，Windows 直接启动首选 shell（ComSpec）。
- 本版本尚未包含 Windows 目标执行（`remote_pwsh`）；Windows 目标暂由上下文明确提示不可用。

## [1.3.14] - 2026-11-08

### 工作台顶栏按钮与 DSH 窗口控件对齐

- macOS 侧边栏收起后，工作台顶栏与 DSH 的「展开侧边栏 / 新会话」窗口控件同排；此前两组的图标尺寸（14 vs 16）、按钮间距（2px vs 8px）和垂直基线（48px 居中 vs leading 控件 top 11px）不一致，看起来一排按钮不齐。
- 现在统一为官方 `HeaderLeadingControls` 规格：28×28 命中区、**16px 图标**、按钮之间 **8px** 间距；顶栏内容下移 2px，与窗口控件中心线对齐；左侧从 `--dsh-frame-leading-clearance` 处开始，和官方控件保持同一节奏。
- 「+」按钮外层菜单容器改为 flex 居中，避免因行盒高度让两个图标按钮差 1px；顶栏内按钮现在处于同一水平线上。
- 只影响 macOS 桌面顶栏；Web/Windows 的 38px 顶栏与既有布局不变。

## [1.3.12] - 2026-11-08

### 主机密钥变化时提供显式“更新信任”

- 修复：服务器重装/迁移导致主机密钥变化时，连接虽然会失败，但界面此前只在“首次未信任”时给出信任入口，已信任过的地址无法在 UI 里更新指纹。
- 现在测试连接如果发现**已知地址的指纹与保存值不同**，会展示「服务器主机密钥已变化」：同时给出原指纹与新指纹、风险提示（若非本人变更需警惕中间人攻击），并提供「更新信任」按钮；确认后覆盖保存新指纹。
- 首次连接仍是「是否信任」的 TOFU 确认；后续正常连接不做任何变动。英文文案同步。
- README / quickstart / SECURITY 增加设备更换/重装后的处理说明。

## [1.3.11] - 2026-11-08

### 主机指纹首次信任文案改为“是否信任”

- 首次连接出现未知主机密钥时，不再要求用户先去服务器控制台/云平台核对指纹，改为简单的信任确认：
  - 标题：是否信任该服务器的主机密钥？
  - 说明：信任后会保存该指纹；以后若主机密钥变化，连接会被拒绝。
  - 按钮：信任 / 取消。
- 这是标准的 TOFU（首次使用即信任）语义：是否信任由用户自己决定；安全兜底仍是保存指纹并在后续指纹变化时拒绝连接。英文文案同步。
- README / quickstart / SECURITY 的说明同步调整。

## [1.3.10] - 2026-11-08

### 工作台顶栏适配 macOS 桌面窗口 chrome

- macOS 桌面下 DSH 使用 hiddenInset 标题栏：工作台顶栏现在占据 48px 窗口顶带（`--dsh-frame-top-clearance`），并在左侧导航收起时用 `--dsh-frame-leading-clearance` 在左侧避让红绿灯与「展开侧边栏 / 新会话」控件；不再与窗口按钮重叠，图标与官方页签/页头基线对齐。
- Web GUI、Windows 及非 macOS 载体保持原来的 38px 顶栏，不受影响。

## [1.3.9] - 2026-11-08

### 工作台本地根目录改为本地用户主目录

- 本地文件面板与本地终端的默认根目录，从 DSH Host 默认工作目录（Desktop 下通常是 `~/.dsh/profiles/desktop`）改为**操作系统用户主目录**（`$HOME`），与常见 SSH 客户端的「本地」面板习惯一致；`~/.dsh` 等目录仍在主目录下，可直接浏览。
- 新增插件配置 `localRoot`：填绝对路径或 `~/...` 可固定工作台本地根目录；相对/非法值回退用户主目录并记 warning。
- 本地文件访问仍严格限制在该 root 内，越界路径与指向外部的符号链接继续拒绝；面包屑显示真实路径。
- 文档同步（README 能力/限制/配置表、quickstart、architecture、product-copy）。

## [1.3.8] - 2026-11-08

### 远程工作台实测修复（安全 / 数据 / 体验 / 性能）

本版本修复了 v1.3.7 远程工作台实测中确认的问题（实测记录未随仓库发布）。

**本地文件安全与数据（localfs）**

- **修复符号链接越界写**：`write` / `mkdir` / `rename` 目标如果经由 root 内符号链接指向 root 外（包括「链接目录 + 新文件名」这种尚不存在的子路径），现在一律拒绝；此前会被写到工作区外。
- **修复删除「链接→目录」导致数据丢失**：删除符号链接现在只 unlink 链接本身，绝不 follow 到目标；此前会递归删掉真实目录树。指向 root 外的链接也可以安全删除。
- **修复 root 含符号链接组件时无法导航**：`/localfs/root` 与 `list` 返回的路径统一 realpath 规范化，macOS `/tmp`、`/var/folders` 或软链工作区下可以正常进入子目录、读取/预览文件。
- **local rename 语义对齐远端**：rename 符号链接只移动链接本身，目标已存在时明确报错（不再静默覆盖）。
- `remove('')` 不再能删除工作区根；本地 list 用 lstat 区分 `dir/file/link`，并补齐 `longname/mode/uid/gid/atime` 等字段。

**工作台客户端**

- **工作台内文件预览**：右栏单击文件现在直接在工作台里打开预览（文本/图片/二进制提示，可关闭回到原目录）；此前必报「当前宿主不支持打开预览页签」。
- **进入工作台不再自动多开本地终端**：空态与「+」菜单是唯一入口，行为与文档一致。
- **页签焦点**：新建/切换/关闭页签后自动聚焦对应终端，切过去直接打字即可。
- **仅活动页签轮询**：非活动页签暂停长轮询并中止在途请求，切回时按 cursor 续读；修复 ≥6 个页签占满连接池导致输入回显 >15s 的问题。
- **输入顺序**：按键输入改为串行队列，单飞发送，避免慢链路下乱序/丢字（失败不阻塞后续按键）。
- **关闭/刷新会话回收**：卸载时继续 fetch 关闭，另加 `pagehide/beforeunload` 的 `sendBeacon` 兜底，并对「open 尚未返回时页面已卸载」的会话补发关闭，减少 12 槽位被历史会话占满的问题。
- 目录列表加请求序号，避免快速导航时旧响应覆盖新目录；终端主题初始化、分栏拖拽监听清理与比例持久化、本地根标签显示真实路径。
- 终端打开错误本地化：页签上限、资源不存在/已禁用、无法连接等映射为可操作文案；远程文件面板默认打开登录用户的 home（通过新增 `/sftp/home` 获取，失败回退 `/`）。

**终端与数据面**

- 终端滚动缓冲按 UTF-16 码点边界截断；12 会话上限的并发竞态修复；`close()` 立即唤醒挂起的长轮询并返回 `exited:true`。
- 新增 `runtime.sftpHome()` 与 `GET/POST /sftp/home`；SFTP 错误补充「操作 + 路径」上下文；请求体超限返回 413；`write-chunk/read-chunk` 的 `offset` 必须为非负整数。
- 本地上传完成后目录缓存会失效（此前最长 5s 看不到新文件），activity 不再记 `unknown`。

**文档**

- 更新 README / quickstart / architecture / product-copy：工作台预览、远程默认 home、本地根目录真实路径、终端生命周期（刷新/关闭尽力回收，异常退出仍依赖 30 分钟空闲回收）、xterm 内联说明。

## [1.3.7] - 2026-11-08

### 修复：终端/文件分栏出现两条竖线

- 终端与右侧文件管理之间的 5px 拖拽分隔条原来左右各描了一条 hairline，浅色终端下看起来是两条多余的竖线；现在只在分隔条正中保留**一条** hairline，拖拽热区不变。

## [1.3.6] - 2026-11-08

### 修复：工作台「+」弹窗位置与顶栏垂直居中

- **修复新标签页弹窗位置**：「+」的下拉菜单改为锚定在按钮正下方展开（此前沿用文件面板下拉菜单的 `position:fixed` + 视口坐标，会跑到窗口左上角并盖住左侧导航）。点击菜单外部仍可关闭。
- **顶栏按钮与页签上下居中**：去掉 tab strip 顶部的 10px 内边距，38px 顶栏内 28px 的按钮/页签上下各留 5px，不再贴顶。
- **终端容器底色跟随终端主题**：深色/浅色主题下容器与终端同色，顶栏与终端之间不再出现一条白色缝隙。

## [1.3.5] - 2026-11-08

### 工作台顶栏对齐侧边栏 tab strip 规范

- 终端明暗切换、新标签页两个按钮移到终端页签**之前**（左侧），页签随后排列。
- 页签完全按 DSH 侧边栏 tab strip 规格：38px 条（28px tab + 10px 上内边距）、tab 高 28px / 最小 80 / 最大 170 / 圆角 `--dsw-radius-sm` / 13px；选中背景 `--dsw-alias-markdown-tag`，hover 用 `--dsw-alias-interactive-bg-hover`。
- 关闭按钮改为 20×20、绝对定位在 tab 右上，仅 hover/选中显示；`+` 按钮 28×28。
- 顶栏高度与右侧文件面板头部（38px）对齐。

## [1.3.4] - 2026-11-08

### 工作台顶栏按侧边栏规范重做

- 顶栏恢复白色页面表面（不再用终端深色底），与 DSH 右侧栏 tab strip 一致。
- 终端页签复用侧边栏页签样式：前缀图标 + 标题 + 关闭、28px 高、选中态 hairline；不再自造独立样式。
- 右侧操作改为：**终端明暗切换**按钮（太阳/月亮）和 **新标签页**「+」按钮，复用侧边栏的 icon button 与 tooltip 规范。
- 终端明暗是工作台自己的偏好（默认深色），存 localStorage，与 DSH 主题独立；切换只影响终端屏幕。
- 清理工作台不再使用的文案 key。

## [1.3.3] - 2026-11-08

### 工作台 UI 收口（按截图反馈）

- 去掉工作台页顶部预留的空白带（不再为窗口 clearance 留白），打开后终端/文件直接贴顶。
- 顶栏去掉「返回对话」按钮和「远程工作台」标题，只保留终端页签与「+」，名字由左侧导航行表达。
- 顶栏改用终端主题深色：通过插件主题 token（`--dsh-ssh-workbench-term-*`）定义浅色/深色两套，终端屏幕、顶栏、页签选中态共用同一套颜色；页签改为深色 hairline 选中态。
- xterm 主题色优先从 body/root 的 CSS 变量读取，回退到内置终端色。

## [1.3.2] - 2026-11-08

### 修复：终端加载失败与工作台 UI

- **xterm 改为随客户端 bundle 内置**：不再通过动态 `<script>` 从插件路由加载，避免宿主 CSP/路由导致 `xterm script failed to load`；Desktop 载体也不再受脚本路由限制。
- **文件管理统一**：右侧文件管理不再单独实现本地面板，本地与远程复用同一个文件面板与文件预览组件；本地侧通过 `__local__` 伪目标实现与 SFTP 相同的分块读写/上传下载/续传接口，工作区根目录与越界校验保持不变。
- **工作台 UI**：头部增加「返回对话」、标题与页签分隔；页签改用带 hairline 的选中态；终端加载/失败状态居中提示；左右分栏与远程文件面板视觉对齐。
- 本地终端启动参数改为通用 `-i`；终端输出按 UTF-8 边界解码。

## [1.3.1] - 2026-11-08

### 修正（打包前自测）

- 本地终端启动参数兼容更多 shell；终端输出按 UTF-8 边界解码，避免中文被 TCP 分块截断。
- 工作台页签在关闭/打开失败后的选中态修正；本地文件下载超过读取上限时明确提示改用终端。
- 文档与安装包版本同步。

## [1.3.0] - 2026-11-08

### 修正：远程工作台改为左侧导航的独立页面

- 1.2.0 把工作台做成了右侧栏页签，方向不对；1.3.0 改为 **左侧导航独立入口 + 全页工作台**：左侧终端、右侧文件管理，中间分隔条可拖动，本地与远程都支持。
- 终端：远程会话走现有 ssh2 broker 的交互 shell 通道；本地会话走 Host 的 PTY 服务（`ctx.subprocess.spawnTerminal`）。客户端用随包分发的 xterm.js 渲染，会话输入/输出通过已认证的插件路由轮询，关闭页签或离开页面即结束会话。
- 文件：远程侧复用 SFTP 面板；本地侧新增受工作区根目录约束的本地文件浏览器（浏览、预览、下载、上传、重命名、删除、新建文件夹）。
- 右侧栏恢复 1.1.0 形态：「远程工作台」（资源管理）+「远程文件」+ 引导卡，不再受工作台开关影响。
- 插件管理开关改为控制 **左侧导航的远程工作台入口**；关闭后左侧导航不出现入口，右侧栏、`@资源名` 远程执行、设置页与模型工具不受影响。
- 新增 `lib/core/terminals.js`、`lib/core/localfs.js`、`GET/POST /terminal/*` 与 `/localfs/*` 路由、`vendor/xterm.js`（MIT，随包分发）及对应单测。
- 已知限制：终端会话不做跨页面保活/重连恢复；本地文件管理限定在默认工作目录内；终端为用户主动操作，不经过 agent 审批与黑名单。

## [1.2.0] - 2026-11-08

> 注：本版把工作台放在右侧栏，方向已被 1.3.0 取代。

### 新增：右侧栏「远程工作台」（P1）

- 右侧栏合并为单一「远程工作台」页签：引导卡与页签同名，顶部切换「文件 / 资源」。
  - 文件视图复用现有 SFTP 浏览器（面包屑、上传/下载、重命名、删除、新建文件夹、预览、传输记录与续传），并按工作台顶部的资源选择器切换目标；
  - 资源视图复用设置页同一套资源增删改查与连接测试；
  - 右上角齿轮直接打开 设置 → 远程工作台。
- 旧「远程工作台」「远程文件」页签仍保留注册，避免已保存的侧边栏布局丢失内容，但不再出现在引导卡中。

### 新增：插件管理里的侧边栏开关

- 插件管理 → 远程工作台 → 配置 新增「在侧边栏显示远程工作台」开关，持久化到 `~/.dsh/ssh-workbench/prefs.json`（0600）。
- 关闭后不再注册任何右侧栏页签、引导卡与 better-sidebar 入口；`@资源名` 的远程执行、设置页、模型工具和 target pill 均不受影响。
- 保存后当前窗口立即生效（重新注册/注销 slot 与 tab type），其他窗口在下一次加载时读取同一 Host 偏好；已打开的旧页签刷新页面后消失。
- 新增 `GET/POST /dsh-ssh-workbench/prefs` 路由、`lib/core/prefs.js` 与单测；配置页同时提供 `view: 'summary'` 摘要。

### 后续（P2）

- 交互式 SSH 终端（ssh2 PTY + xterm 渲染）将在下一阶段接入同一工作台，本期不引入新的终端依赖。

## [1.1.0] - 2026-11-08

### 产品命名与描述统一
- 产品名统一为「远程工作台」（英文 `SSH Workbench`），覆盖插件管理元数据、设置导航/页面标题、右侧栏引导卡与页签；同一位置不再出现 `SSH 运维` / `SSH 管理` / `SSH` / `服务器` 等旧名。
- 描述统一为：**SSH 终端、本地与远程文件、@服务器 对话执行，Windows 宿主和目标都能用。** 设置页 intro 使用长描述，引导卡使用「纳管资源与远程文件」。
- 侧边栏页签、引导卡、设置页三处同名「远程工作台」；设置页资源页签改为「纳管资源」；@ 菜单分组、chip 提示、目标 pill 提示、文件面板资源选择统一使用「纳管资源 / 资源」；协议字段（SSH 端口/密码/主机密钥）保留 `SSH` 前缀。
- 新增内部产品文案规范文档（于 1.6.2 随过程性文档一并移除）。
- `ssh_workbench_target` 工具描述措辞对齐为 managed remote resource；工具名、参数名、上下文标签、黑名单前缀等技术标识不变。

### 文档事实修复
- README/quickstart：移除已无 UI 入口的 `~/.ssh/config` 导入说明；设置路径改为「设置 → 远程工作台」；安装版本更新为 1.1.0；文件面板能力改为“浏览、只读预览、上传/下载、重命名、删除、新建文件夹、传输续传”，不再声称在线编辑；quickstart 补充“远程文件”章节与当前表单字段。
- 删除 ssh config 导入的客户端死函数与 `/import/ssh-config` 路由；`importSshConfig` 解析保留为内部能力与单测。
- 设计文档与安全说明同步产品名；文档中的旧版本号同步到 v1.1。

### i18n
- 补齐英文缺失 key（`files.transferUploading` / `files.transferDownloading`）。
- 清除 zh 16 组、en 14 组重复 key，以及 61 个无引用死 key（zh/en 各 61 个）。
- 新增 `test/product-copy.test.js`：检查 locale 元数据、zh/en key 对齐、重复 key、旧产品名回流，以及 README/quickstart 的产品名、设置路径与安装版本。

## [1.0.8] - 2026-11-08

### 变更
- 去掉设置页「导入系统 known_hosts」：实际使用中导入结果为 0 台（冲突 1 / 未找到 1），且系统 known_hosts 与插件自有信任库重复，收益低。后端的导入解析、路由、测试与文档一并删除；主机信任仍走插件自己的 known_hosts + UI 指纹确认。
- 设置页主按钮改用 DSH 官方 Button primitive（`@deepseek-ai/dsh-client-ui-primitives` 的 `Button`）：primary 使用 `--dsw-alias-button-primary-fill/-hover` 与 `--dsw-alias-label-primary-foreground`，默认 md 规格（36px 高、14px 字号、`--dsw-radius-md`、左右 14px 内边距），不再用自造的蓝色 `button-info-fill` 样式。受影响：添加纳管资源、保存/信任/文件确认等 primary 按钮。无 primitives 时回退样式也按官方规格实现。

## [1.0.7] - 2026-11-08

### 修复
- composer 参数行的目标指示没有真正继承同排“统计 pill”的样式，导致字号偏大、颜色偏深。按 DSH `StatsPills.module.css` 的实际规格重做：外层 anchor `font-size: calc(var(--dsh-content-font-size-secondary,13px) - 1px)`、`line-height: calc(20px + var(--dsh-content-font-delta-secondary,0))`；按钮 `color: var(--dsw-alias-label-tertiary)`、`font: inherit`、`font-variant-numeric: tabular-nums`、`gap: 6px`、`padding: 1px 8px`、`border-radius: var(--dsw-radius-sm)`；图标 `14x14`；hover 背景 `--dsw-alias-interactive-bg-hover`、文字变 secondary。现在四项读数视觉完全一致。

## [1.0.6] - 2026-11-08

### 修复
- 设置页「SSH 管理 → 服务器」与侧边栏对齐：去掉服务器行上的 hostname chip 和手动“刷新主机信息”图标。上一版只清理了侧边栏的内核/磁盘，设置页仍显示 hostname 等连接快照，两个入口不一致。facts 仍会在连接测试/选中目标时自动采集（hostname 仅用于目标上下文，不在列表展示）。

## [1.0.5] - 2026-11-08

### 调整
- composer 参数行的目标指示与同排参数统一：去掉绿色圆点，改为同样式的灰色线性图标（服务器机架 glyph，14px、currentColor、随行字体/颜色），点击行为保留。
- 目标指示固定排在参数行最后（`conversation.composer.dock` 注册 order 100）：有远程目标时出现在末尾，切到 local 后整条消失，不占位。

## [1.0.4] - 2026-11-08

### 变更（UI 收敛，来自真机截图反馈）
- 当前目标指示从 composer 工具行的按钮 chip 移到 **composer 下方参数行**（`conversation.composer.dock`，与“轮次/步数、tok/s、上下文占用”同级），去掉边框/按钮外观，改成与参数行一致的小字号文本 + 状态圆点；点击仍可打开右侧服务器面板。
- 服务器卡片（侧边栏与设置页）不再显示 **内核版本**（如 `7.0.2-6-pve`）与 **磁盘占用**（如 `磁盘 20%`）：这两项是连接时采集的快照，不连服务器时会过期。facts 仍保留在 servers.json（hostname 继续用于目标上下文），设置页仍可手动“刷新主机信息”。
- 目标上下文注入只再附加 hostname，不再放磁盘百分比，避免把过期容量写进模型上下文。

## [1.0.3] - 2026-11-08

### 新增（借鉴 luminax SSH 插件的可迁移能力）
- **取消结果说明远端状态**：`Esc`/abort 取消后，stderr 明确提示“通道已关闭”，并按远端是否有 `timeout` 能力说明远端进程是“可能仍在运行”还是“会在 deadline 被终止”，与 timeout 的提示口径一致。
- **目标可见性**：目标切换后的首条远程命令在 stderr 追加一行 `[remote] target: <name> (<user>@<host>:<port>)`；原生 bash 卡片的 cwd 标签带服务器前缀（如 `web-1:/var/log`）；输入框活动区常驻“目标: <name>”chip。DSH 的 bash 卡片是官方渲染且没有装饰插槽，因此不替换卡片，用这三处保证可知。
- **主机信息（facts）**：连接测试、`ssh_workbench_target` 选中目标、或手动刷新时采集 hostname/内核/uptime/根分区并写入 servers.json；服务器列表显示 hostname、内核、磁盘百分比；目标上下文注入也带一行摘要。修复了 routes/client 早已读取但从未填充的 hostname chip 死代码。
- **系统 known_hosts 导入**：设置页新增“导入系统 known_hosts”，解析 `~/.ssh/known_hosts` 与 `/etc/ssh/ssh_known_hosts`（支持非默认端口、`|1|salt|hash` 哈希主机名、`@revoked`、多 key 类型），只做显式导入；与插件已有指纹冲突时报告而不覆盖（`overwrite` 可强制）。
- **配置变更生命周期**：修改/删除服务器或变更凭据时主动关闭该目标的 SFTP 传输会话，避免旧连接继续向旧主机写入。
- **SFTP 可靠性**：分块读写增加 30s 看门狗（`transferChunkTimeoutMs`），卡死时关闭会话并让 UI 可从 offset 续传；上传显式 `close-write` 后用远端 `stat` 校验 size（不匹配报 `SFTP_SIZE_MISMATCH`）。
- **上下文纪律**：目标上下文注入增加两条约束（不要用 bash 里的 ssh/scp 绕到其他服务器；变更后先验证，exit 0 不等于完成）。
- **stderr 独立上限**：新增 `maxStderrBytes`（默认 16KB），stdout 仍用 `maxOutputBytes`，避免异常命令刷屏吃掉模型上下文；顺带修复了 broker 捕获头部在单块大输出时可能超过 cap 的旧问题。

## [1.0.2] - 2026-11-08

### 修复（黑名单加固：把 shell 语义还原后再匹配）
- **引号/转义绕过**：`"mkfs.ext4"`、`'mkfs.ext4'`、`\rm -rf /`、`m\kfs.ext4`、`cat > "/dev/sda"`、`dd of='/dev/sda'` 之前都能绕过。现在每个分段先按 shell 规则切成 argv words（去掉引号和反斜杠），`sudo`/`timeout`/`env`/`!`/赋值等包装在 words 层剥离，再做规则匹配。
- **路径变体**：`rm -rf /etc/`（尾斜杠）、`/root/`、`//`、`/etc/../`、`/tmp/..`、`/etc/*`、`/{etc,root}`、`${HOME}`、`~root`、`chmod -R 777 /etc/` 之前都会放行；现在路径做词法规范化（折叠 `//`、去尾斜杠、消解 `..`、展开 `~`/`${HOME}`），glob/brace 取字面前缀后再判断，`chmod`/`chown` 也对根文件系统目标生效。
- **设备写入缺口**：`shred`/`blkdiscard`/`sgdisk`/`gdisk`/`cfdisk`、`dd of=/dev/nbd0|zram0`、`cp`/`mv`/`tee` 写块设备之前未覆盖；重定向改为 token 级检测（`2>&1` 不会被误判，引号内的 `"> /dev/sda"` 也不会误报）。
- **命令替换/`eval`**：`echo "$(mkfs.ext4 /dev/sdb1)"`、反引号、`eval 'mkfs...'` 之前能绕过；现在 `$()`/反引号/`eval` 内容递归分类（深度上限 2）。
- 仍未覆盖（声明为 best-effort）：`bash -c`、base64、脚本文件、解释器 heredoc 正文。安全边界仍是 SSH 最小权限 + host-key + DSH 审批。

### 修复（@ 目标与选择）
- **非 ASCII 服务器名无法 @ 绑定**：`@测试机` 之前不匹配（host 与 client 正则都是 ASCII），会在无提示的情况下把 bash 留在本地/旧目标。现在 host 端按清单别名做 Unicode 前缀匹配（支持 `@测试机看下磁盘` 这种紧跟中文的写法，同时保持邮箱不误判），client 端 chip 正则同步。
- **多目标未选择时不再静默本地执行**：`@a @b` 后 active 为空，模型若不先调 `ssh_workbench_target` 直接 bash，现在返回 `TARGET_NOT_SELECTED` 错误；`ssh_workbench_target({ server: "local" })` 会同时清空待选目标。

### 修复（超时兜底）
- 超时能力探测改为 `sh -c '...'` 执行，fish/csh 登录 shell 也能跑；探测同时返回登录 shell 路径，wrapper 改为 `timeout ... '<shell>' -c '<cmd>'`，不再依赖 POSIX `${SHELL:-...}` 展开（fish/csh 不支持）。
- 探测失败/非零退出也按"实际执行过"缓存为 `none`，避免这类服务器**每条命令都多一次探测 RTT**；首次并发调用共享同一个 in-flight 探测。
- 远端 `timeout` 先于客户端计时到期（返回 exit 124）时，现在映射为 `timedOut: true`，不再表现为普通失败。
- 新增配置 `timeoutKillAfterMs`（默认 5000）：`timeout -k` 的宽限时间，0 表示只用 TERM。

### 变更
- 目标上下文注入去重：上一条 `ssh-workbench-target` 消息仍在本次 step 的消息里时，不再每个 turn 重复追加；仅在被压缩掉或目标变化时重新注入。
- 文档补充：黑名单仍属 best-effort、heredoc 正文按可执行文本检查（fail-closed）、取消不会立即杀远端（等到远端 deadline）、stdout/stderr 顺序丢失等已知边界。

## [1.0.1] - 2026-11-07

### 修复
- **黑名单可被换行符和单个 `&` 绕过**：`gate.js` 的分段只识别 `;`/`|`/`&&`，模型生成的多行脚本（`echo x\nmkfs ...`）或后台分隔（`sleep 0.1 & mkfs ...`）会整段放过。现在 `\n`、`\r`、单个 `&` 都是分段符；`2>&1`、`&>file` 等重定向不会被误切；`!`、`exec`、`setsid`、`timeout` 包装也会被剥离后再匹配规则。
- **超时后远端进程不被杀死**：客户端超时只关闭 SSH channel，`nohup`/后台化的远端进程会继续执行。`remote-bash` 现在先探测远端 `timeout` 能力（`kill`/`basic`/`none`，按服务器缓存），可用时把命令包成 `timeout -k 5 <秒> "$SHELL" -c '<命令>'`，让远端在同一个 deadline 终止整个进程组；超时结果会在 stderr 里说明远端是"已终止"还是"可能仍在运行"。
- **远程 bash 的 stdin 永不 EOF**：`broker` 只监听 stdout/stderr，从未关闭 stdin，`cat`、`read`、交互式安装脚本会一直挂到超时。现在 exec 通道建立后立即关闭 stdin（等价 `</dev/null`），读 stdin 的命令会立刻拿到 EOF。

### 变更
- 目标上下文注入加强提示：`read/write/edit/glob/grep` 永远在本地 DSH 主机执行，远程文件必须通过 `bash`（heredoc、`sed -i`）或 GUI SFTP 面板修改；`working_directory` 只影响本地工具。
- 文档补充已知限制：stdout/stderr 交错顺序丢失（与原生 value 契约一致）、远端无 `timeout` 时超时仅停止等待、同轮 bash 调用并发由 DSH 调度层决定。

## [1.0.0] - 2026-11-07

### 破坏性重构：插件从「远程工作台箱」变成「远程执行能力层」

需求：agent 自己的 `bash` / `read` / `write` / `edit` 已经够用，插件只需要补上「SSH 到服务器」这一项能力，再加一道危险命令黑名单；审批、UI、提示词、会话全部用 DSH 原生的。

### 移除
- 删除全部 14 个模型工具：`ssh_workbench_server_list`、`ssh_workbench_server_exec`、`ssh_workbench_server_facts`、`ssh_workbench_server_connect`、`ssh_workbench_diagnose`、`ssh_workbench_batch_exec`、`ssh_workbench_http_probe`、`ssh_workbench_files`、`ssh_workbench_terminal_open/send/read/signal/close/list`。
- 删除诊断包（`packs.js`）、HTTP 探测（`probe.js`）、SSH 终端（`terminal.js`）及 `tools/pre-execute` 审批闸门、系统提示词段。
- 删除精简模式 preset 残留与相关文档。

### 新增
- **原生 bash 透明远程执行**：会话 `@服务器` 后，DSH 原生 `bash` 工具经 `tools/execute` waterfall 重定向到 SSH；返回值按原生 bash 输出契约构造，由 DSH 校验并用原生 renderer 渲染。未绑定目标时行为零变化。
- **目标绑定**：`@名字` 自动绑定；多个 `@` 置空并要求模型选择；`ssh_workbench_target`（唯一新增模型工具）切换/回到 `local`；会话恢复时从历史人类消息回放目标。
- **目标上下文注入**：每个 turn 首步或目标变化时注入一条紧凑 user-role 上下文，说明 bash 在远程、文件工具在本地、如何切换。
- **黑名单**：改用 `ctx.tools.guard()`（同步、单调），只对「有 active 目标的 bash」生效；命中 `rm -rf /`、`mkfs`、`dd of=/dev/*`、分区工具、根目录 chmod、fork bomb 等直接拒绝。
- `targetContext` 配置开关；`commandTimeoutMs` 默认 120s、`maxCommandTimeoutMs` 上限。

### 保留
- 服务器清单 / `~/.ssh/config` 导入 / 加密凭据 / known_hosts 严格校验 / 连接池 / 连接测试 / SFTP 文件面板 / `@` 引用 chip / 本地 activity 概览。

### 兼容性
- 旧版本会话中对已删除工具的调用记录只会退回通用渲染；旧的自定义 preset（lean）不再提供，相关会话无法恢复该模式。
- 依赖 DSH `tools/execute` 扩展点（0.2.1-rc.1 起可用，官方 timeout 插件同款用法）。

## [0.2.30] - 2026-11-07

### 修复
- 精简模式工具掩码从 allow 改为 deny（0.2.26 起存在的问题）：preset 组合内的工具（`bash`/`read`/`write`/`edit`/`read_image`/`ask_user_question`）同样注册在可被 `ctx.tools.restrict()` 限制的继承作用域，之前 allow 只放行 `ssh_workbench_*` + `working_directory`，导致精简模式实际只剩 SSH 工具、本地命令与文件能力全部丢失（实测会话工具列表只剩 24 个且不含任何 preset 工具）。
  - 现改为 deny 列表：只隐藏会话检索、本地终端、ralph、worktree、依赖发现与团队工具等无关全局工具，preset 自带工具不再受影响。
  - 说明：Agent Teams 的工具注册在 agent 自身作用域（`agent.ctx`），`restrict` 无法移除；彻底隐藏需要从 profile 去掉对应 bundle。

## [0.2.29] - 2026-11-07

### 变更
- 精简模式补齐文件工具（21 个工具，对齐 Lumina 的默认工具哲学）：
  - 开启 `edit` 与 `read_image`（`tool-fs` 配置 `edit: true` / `readImage: true`）。此前只能整文件 `write`，改一个片段成本高；图片也无法查看。
  - persona 增加 Local tools 用法：搜索/列目录用 bash 的 `rg`/`find`/`ls`（本模式没有 glob/grep 工具）；改文件前先 read，精确替换用 edit，write 只用于新建或整文件重写，图片用 read_image。
  - `glob`/`grep`/`web`/`todo` 仍不挂载：Lumina 默认集同样没有这些工具（`grep`/`find`/`ls` 代码存在但默认不激活），搜索交给 bash；需要查文档等能力时使用 standard 模式。

## [0.2.28] - 2026-11-06

### 修复
- 精简模式的工具行为修正，保持 19 个工具的定位不变：
  - `tool-bash` / `tool-pwsh` 在精简 preset 里关闭 `enableRunInBackground` 与 `promoteOnTimeout`。jobs 注册表是部署级全局的，但该 preset 没有挂 `job_*` 控制工具，此前模型可能起一个后台任务却无法读取或停止；现在超时命令直接按 deadline 结束，不再产生失控 job id。
  - persona 增加一条：忽略运行时上下文里的 team-lead / teammate 指令（profile 的 Agent Teams bundle 会注入"You are the Team Lead named lead…use list_agents"，而精简模式没有队友也没有团队工具，属于必需上下文，压不掉，只能中和）。
- 模式描述改为「SSH 插件自带的精简模式」，明确该模式的产品定位。

## [0.2.27] - 2026-11-06

### 新增
- 精简模式的 `@服务器` 确定性解析：`agent/pre-step`（prepend）在每轮第一步扫描 human 用户消息里的 `@名字`，命中纳管清单（名称或 id，大小写不敏感）时追加一条 `source.kind = ssh-workbench-reference` 的 user 上下文，写明名称、`user@host:port`、平台与启用状态，并重申"@名字 是纳管服务器，不是队友"。未命中不注入、零 token；每轮最多一次。
  - 优先用 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 构造消息，解析不到时退回同构的本地消息对象；任何异常只记 warn，不阻断该轮。
  - 仅对绑定 `lean` preset 的 agent 生效；新增配置 `serverReference`（默认 `true`）可关闭。

## [0.2.26] - 2026-11-06

### 新增
- 精简模式工具面收敛：插件对绑定 `lean` preset 的 agent 应用 `ctx.tools.restrict({ allow })`，只保留 14 个 `ssh_workbench_*` + preset 本地工具 + `working_directory`（约 19 个），隐藏团队、会话检索、本地终端、ralph、worktree、依赖发现等 24 个全局工具；首次请求工具 schema 约 7.4K → 3.8K token。
  - 通过 `agent/created` 与 `agent-preset/selected` 两个钩子应用掩码（覆盖空白会话切换 preset 的路径），切走 `lean` 时自动解除，agent dispose 自动清理。
  - allow 掩码按实际存在的全局工具名计算，避免 `restrict()` 对不存在的工具名抛错；任何失败只记 warn，不影响 preset 与工具。
  - 新增配置 `leanToolScope`（默认 `true`），置 `false` 可关闭收敛。

## [0.2.25] - 2026-11-06

### 变更
- Agent 模式由「SSH 运维」改名为「精简模式」（preset id `ssh-workbench` → `lean`，preset 行 `preset-ssh-workbench` → `preset-lean`）。开发阶段无历史会话依赖，id 直接切换。
  - persona 重写为英文闭环方法论：Goal & boundaries / Observe & execute / Verify & recover / Report；精简模式同时可作为通用精简 agent 使用，`@服务器` 时进入 SSH 运维上下文。
  - 展示名与描述更新为「精简模式」。
- 插件系统提示段按同一方法论重组：Goal & boundaries / Observe & execute / Verify & report，删除通用远程开发噪音（测试管道、.gitignore、pkill 等），体积约 2.8KB → 1.7KB。
- 工具描述对齐精简语义：`ssh_workbench_server_list` 改为“目标缺失/歧义时才用，用户给的名字优先”；`ssh_workbench_server_exec` 去掉“先调 server_list”的表述；`ssh_workbench_batch_exec` 明确“短只读检查、避免长复合一行”；`ssh_workbench_diagnose` 描述收敛。

## [0.2.24] - 2026-11-06

### 新增
- 插件自带 Agent 模式「SSH 运维」（preset id `ssh-workbench`）：以 bundle 补丁 `preset.patch.yml` 声明，装插件即多一个可选的会话模式，不修改 DSH 安装、profile bundle 列表或内置 preset。
  - 直接工具调用（`native`，钉死不继承部署默认的 PTC 呈现）。
  - `persona complete: true` + 精简运维提示词，去掉 PTC 的 SDK 声明块与基础提示噪音；不注入运行时上下文。
  - 工具面收敛为 ssh_workbench_*（profile 全局注册自动可见）+ bash/pwsh + read/write + ask_user_question + 压缩，不挂团队/子代理/计划/Web 等编码类工具。
  - 不想用时在 profile 补丁里加 `- id: preset-ssh-workbench` + `disabled: true` 即可关闭。

## [0.2.23] - 2026-11-05

### 优化
- 模型指引调整，减少无效轮次与过度调查：
  - 目标已被用户点名时直接使用该名称执行，不再要求先调用 `ssh_workbench_server_list`；仅当目标缺失或有歧义时才列清单。
  - `ssh_workbench_batch_exec` 收敛为「多条短只读检查 / 跨目标同命令」；探索性诊断建议一次一条 `ssh_workbench_server_exec`，避免复合命令失败后触发连锁排查。
  - 新增诊断范围纪律：用最小证据集回答问题，结论先行、证据精简。

## [0.2.22] - 2026-11-05

### 文档
- 文档体系改为**中文为主**：README、CHANGELOG、CONTRIBUTING、SECURITY、架构说明全部中文化；quickstart 与两份 cookbook 校对版本号、安装路径与链接。
- README 重写为中文开源首页（定位、特性、安装、上手、审批模型、工具、配置、开发、文档索引）。

## [0.2.21] - 2026-11-05

### 变更
- 开源整理：删除内部过程文档与验证截图，新增 LICENSE / CHANGELOG / CONTRIBUTING / SECURITY / 架构文档。
- 清理代码注释中的内部引用；测试与文档中的个人服务器名/域名改为通用示例。
- 包元数据整理：移除 `private`，补充 `keywords`/`author`，`files` 纳入 LICENSE、CHANGELOG、CONTRIBUTING、SECURITY 与架构文档。
- 新增 GitHub Actions CI（单测 + 打包）。

## [0.2.20] - 2026-11-05

### 修复
- 补齐 `ssh_workbench_diagnose`、`ssh_workbench_batch_exec`、`ssh_workbench_server_list` 的工具卡片与中英文标签。
- 工具卡片摘要支持批量的 `commands` 与诊断包的 `pack`。
- upload 的本地文件不存在时返回更友好的错误。

### 新增
- `npm run test:live -- <server>` 真机回归脚本（cwd / patch / upload-download / 错误分类）。

## [0.2.19] - 2026-11-05

### 新增
- `ssh_workbench_server_exec`、`ssh_workbench_batch_exec` 新增 `cwd` 参数（POSIX `cd --`，Windows `cd /d` / PowerShell）。
- `ssh_workbench_files` 新增 `patch`（片段替换、唯一命中校验、`replaceAll`、`dryRun`、行号/行数统计）与 `upload` / `download`（二进制安全、64MiB 上限、sha256 校验）。
- exec 失败按 126/127/130/137、权限不足、磁盘满、只读文件系统给出具体错误码与建议。
- systemPrompt 增补远程开发指引；新增 quickstart、远程开发 cookbook、运维 cookbook。

## [0.2.17] - 2026-11-05

### 变更
- 审批模型简化：插件只硬阻断机器级黑名单，其余命令完全跟随 DSH 会话预设（ask / 自动审查 / 完全权限）；移除插件侧 ask 清单、只读白名单、`autoApprove` 与服务器 `trustLevel`。

## [0.2.16] - 2026-11-05

### 变更
- 恢复「黑名单 + DSH 审批」模型，移除临时的只读白名单、`autoApprove` 与服务器 `trustLevel`。

## [0.2.15] - 2026-11-05

### 修复
- 活动日志区分 `success` / `exit N` / `failed (CODE)` / `partial (N of M)`，不再把命令非零退出一律显示为失败。
- 操作日志增加「清空记录」。

## [0.2.13] – [0.2.14] - 2026-11-05

### 新增
- 连接 broker：每台服务器复用一条 SSH 连接、SFTP 子系统复用、空闲回收、连接预热、facts 缓存。
- 诊断包（system/service/logs/disk/network/http/docker/cert）、批量执行、专用 HTTP 探测。
- 活动日志、更清晰的执行结果、文件面板分块传输。

### 移除
- 旧数据面路由与未使用的传输辅助代码。

## [0.2.11] - 2026-11-05

### 变更
- UI 对齐 DSH 设计规范；服务器表单改为插件自绘下拉；危险按钮改为 ghost danger 样式。

## [0.2.8] – [0.2.10] - 2026-11-04

### 新增
- 专用 `ssh_workbench_http_probe`（GET/HEAD、host 白名单）；更清晰的审批拒绝提示。

## [0.1.x] - 2026-11-02

### 新增
- 初始版本：服务器清单、加密凭据、host-key 固定、`@` 引用、exec/facts 工具、SFTP 文件面板、交互式 SSH 终端、设置页与右侧栏面板。
