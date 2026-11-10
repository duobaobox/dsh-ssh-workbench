# SSH Workbench（远程工作台）— 快速上手

## 1. 安装

在 DSH 的 **设置 → 插件** 里搜索 `dsh-ssh-workbench` 安装。也可以从源码构建：

```bash
cd dsh-ssh-workbench
npm test
npm run pack
```

然后安装 `dist/dsh-ssh-workbench-1.7.5.tgz`。安装后重启/重载插件。

发布包自带纯 JS 的 SSH 依赖，安装过程不需要编译（不需要 Xcode Command Line Tools）、也不额外下载 npm 包，离线机器同样可以安装。

## 2. 添加纳管资源

**设置 → 远程工作台**：

- 手动添加：名称、目标地址、SSH 端口、登录用户名、默认 Shell、认证方式（密码 / 私钥）、描述、是否启用；
- 密码类认证在表单里设置密码（存本机加密文件）；私钥认证填本机私钥路径；
- 首次连接会显示主机指纹并询问是否信任；信任后保存该指纹，以后若主机密钥变化会拒绝连接。
- 建议先点「测试连接」确认连通。

## 3. 开始使用

在对话里先 `@资源名`，再正常描述任务：

```
@web-1 看下磁盘和内存
@web-1 把 /etc/nginx/nginx.conf 的 worker_connections 改成 2048，然后 nginx -t
```

模型会调用原生 `bash`（Windows 宿主上是 `remote_bash`），命令实际在 web-1 上执行；POSIX 宿主的结果卡片与本地 bash 一致（退出码、超时、截断）。

## 4. 多目标

```
@web-1 @db-1 各自看下磁盘
```

模型会优先用 `remote_exec` 一次并行执行：

```
remote_exec({ tasks: [
  { server: "web-1", command: "df -h" },
  { server: "db-1", command: "df -h" }
] })
```

每个 task 自己指定目标，命令在各自服务器上并发执行，结果按任务顺序返回；这不会改变当前 active target。如果模型仍直接调用 `bash`，一次提到多个资源后当前目标会先被清空，在调用 `ssh_workbench_target` 选择之前会返回 `TARGET_NOT_SELECTED` 错误（不会静默在本机执行）。资源名支持中文/非 ASCII（如 `@测试机`）。

composer 下方的目标 pill 在单/多目标时都可以点开：卡片标题显示本会话总次数，下面按目标列出执行次数。它是只读统计，不负责切换 active 或打开工作台；切换目标用 `ssh_workbench_target` 或重新 `@` 资源，终端/文件从左侧「远程工作台」进入。

## 5. 远程工作台

**左侧导航 → 远程工作台** 是一个独立页面：左边终端，右边文件管理，中间分隔条可拖动。

- 终端：点「+」新建 **本地终端** 或选择一台远程资源开 **远程 SSH 终端**；每个页签一个会话，关闭页签即结束会话。只有活动页签在后台读取输出，切回其他页签时会从上次位置补齐，不会丢输出。
- 文件：跟着当前终端页签走 —— 本地终端时显示 **本地用户主目录文件**（默认 `$HOME`，可用插件配置 `localRoot` 指定其他绝对目录），远程终端时显示该资源的 **SFTP 文件**（远程默认打开登录用户的 home）。两类文件都支持浏览/**在工作台内直接单击预览**/下载/上传/重命名/删除/新建文件夹，远程文件还有传输记录与续传。
- 本地文件范围限定在 `localRoot`（默认用户主目录）及其子目录，面包屑显示真实路径；越界路径与指向外部的符号链接会被拒绝，需要操作根目录以外的本地路径时用本地终端。
- 页面刷新/关闭会尽力关闭终端会话；进程异常退出时服务端会话会在空闲 30 分钟后回收。

如果不想在左侧导航看到它：**插件管理 → 远程工作台** 页面里关闭「在侧边栏显示远程工作台」。关闭后左侧导航不再出现入口，右侧栏的「远程工作台 / 远程文件」页签、`@资源名` 远程执行、设置页与模型工具都不受影响。

## 6. 常见问题

**为什么 `read` / `write` / `edit` 读不到远程文件？**
这些文件工具始终作用于 DSH 主机（POSIX 宿主上的原生 `bash` 或远程 shell 工具都不会改变这一点），误用 `write` 会写到本机。远程文件用对应的远程 shell 工具操作（POSIX 目标：`cat`、`tee`、`sed`；Windows 目标：`Get-Content`、`Set-Content`），或用右侧栏 SFTP 面板。

**命令很慢/超时？**
远程命令默认 120s，可用远程 shell 工具的 `timeoutMs` 参数（原生 `bash` / `remote_bash` / `remote_pwsh`）或插件配置 `commandTimeoutMs` 调整。连接池会复用连接，第一次会稍慢。超时后如果远端有 `timeout`，整个远端进程组会被终止（TERM 后按 `timeoutKillAfterMs` 再补 KILL）；没有 `timeout` 的服务器（如 macOS）只能停止等待，命令可能还在跑，结果 stderr 会提示这一点。**取消（Esc）不会立即杀远端**，远端仍会计时到自己的 deadline。

**为什么 `cat` / `read` 这类命令立刻结束了？**
远程命令的 stdin 在启动后立即关闭（等价 `</dev/null`），读 stdin 的命令会立刻得到 EOF，不会挂到超时。

**怎么确认命令跑在哪台机器？**
目标切换后的第一条远程命令会带有目标提示（原生 bash 卡片显示 stderr 行与 cwd 前缀，如 `[remote] target: web-1 (...)`、`web-1:/var/log`；远程 shell 工具在结果文本里带 target/cwd）；composer 下方参数行常驻显示当前目标。也可以点 `ssh_workbench_target` 选 `local` 回到本机。

**能不能一次让多个资源并行执行？**
可以，让模型调用 `remote_exec`：每个 task 显式带 `server`，默认并发 4、最多 8，单次最多 8 个 task；每个任务独立超时、独立输出、互不污染，结果按输入顺序返回。它只支持前台命令，长任务仍走后台工具。直接调用 `bash` / `remote_bash` / `remote_pwsh` 时仍受单 active target 限制，需要先切换目标。

**怎么跑长时间任务 / 后台服务？**
让模型带 `run_in_background: true` 调用远程 shell 工具（`remote_bash` / `remote_pwsh`，POSIX 宿主上的原生 `bash` 路由同样支持）。工具会立刻返回远端 pid 和日志路径：
- POSIX：`tail -f <log>` 看输出，`kill <pid>` 停止；
- Windows：`Get-Content -LiteralPath '<log>' -Wait` 看输出，`Stop-Process -Id <pid> -Force` 停止。
后台进程与本次工具调用脱离，调用返回后继续运行；`timeoutMs` 只约束启动调用本身。它不是 DSH 本地 job，`job_*` 工具看不到它。

**资源列表里的 Linux / Windows 徽标是什么？**
连接后自动探测到的目标平台（`uname -s` / `cmd /c ver`），不是表单里手填的 `platform`；测试连接的结果里也会显示。旧资源第一次连接前显示的是提示值，探测完成后自动更新。

**危险命令被拒？**
`rm -rf /`、`mkfs`、`dd of=/dev/*`、分区工具、改根目录权限等会被黑名单直接拦截；引号/反斜杠、路径变体（尾斜杠、`//`、`..`）、`$()`/`eval` 都会先还原再判断。这是兜底，不是权限边界；`bash -c`、base64、脚本文件等仍可能绕过，其他命令由 DSH 审批预设决定是否询问。

**服务器重装了 / 主机密钥变了，连不上？**
连接会被拒绝并显示「服务器主机密钥已变化」，同时给出原指纹和新指纹。确认是你自己重装、迁移或更换了服务器后，点「更新信任」即可；如果不是你做的变更，先别信任，可能是中间人攻击或误连了别的机器。

**Windows 服务器？**
需要先在 Windows 目标上启用 OpenSSH Server（系统可选功能，管理员 PowerShell：`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`，然后 `Start-Service sshd`、`Set-Service -Name sshd -StartupType Automatic`）。插件连接后会探测方言，Windows 目标经 `remote_pwsh` 执行 PowerShell 命令；建议把默认 shell 设为 PowerShell。文件面板/连接测试/SSH 终端不受影响。

**方言（POSIX / Windows）要手动填吗？**
不用。连接测试或选中目标时会执行 `uname -s`（POSIX）和 `cmd /c ver`（Windows）探测，结果写入 `facts.dialect`，之后自动选择 `remote_bash` / `remote_pwsh` 与对应上下文。清单里的 `platform` 字段只是探测前的提示值。

**Windows 上的 DSH 宿主？**
Windows 版 DSH 没有内置 `bash`（DSH 按平台禁用），插件会在该宿主上注册自有的 `remote_bash` 工具用于 POSIX 目标；用法与 POSIX 宿主上的原生 `bash` 路由一致（`@资源名`、`workdir`、`timeoutMs`），原生的 `pwsh` 始终保持本机语义。Windows 目标在两种宿主上都走 `remote_pwsh`。
