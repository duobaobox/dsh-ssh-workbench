# SSH Workbench（dsh-ssh-workbench）安全说明

## 报告漏洞

请通过 GitHub 的 **Security → Report a vulnerability** 私下报告（或直接联系维护者），不要在公开 issue 中披露未修复的安全问题。

## 设计说明

- **凭据**：使用 AES-256-GCM 加密存储在 `$DSH_HOME/ssh-workbench/secrets.json`，密钥在 `secrets.key`（0600）；纳管资源清单不存明文密码。
- **主机指纹**：插件维护自己的 `known_hosts`，默认 `strict`（未知指纹拒绝）；UI 显示 SHA256 指纹并询问是否信任，由用户决定；信任后保存。指纹变化时连接会被拒绝并提示「服务器主机密钥已变化」，用户核对后可显式「更新信任」。
- **审批**：插件不是权限边界，只硬阻断机器级黑名单；其余远程命令是否弹审批完全由 DSH 会话预设决定（ask / never）。当前不提供命令分级、AI 风险解释或审计。
- **批量执行**：`remote_exec` 对每个 task 按其目标方言单独跑黑名单，任一 task 命中即整批拒绝；批量工具不读取也不改变会话 active target，但每个 task 都必须是已纳管的远程资源（`server: "local"` 被拒绝）。它仅前台执行，并受 `maxBatchTasks` / `batchConcurrency` / `maxBatchOutputBytes` 限制；这些限制不是安全边界。
- **黑名单是 best-effort**：`;`、`&&`、`|`、单个 `&`、换行都会逐段检查；每段会先按 shell 语义还原（去掉引号/反斜杠、剥离 `sudo`/`timeout`/`env`/`!`/赋值等包装、路径词法规范化/glob 前缀、`$()`/反引号/`eval` 递归），所以 `"mkfs.ext4"`、`\rm -rf /`、`rm -rf /etc/`、`cat > "/dev/sda"`、`echo "$(mkfs...)"` 都会命中。但 `bash -c`、base64、脚本文件、解释器 heredoc 正文不会被解析，真正的安全边界仍是 SSH 最小权限 + host-key 固定 + 网络隔离 + DSH 审批。
- **本地↔远端传输**（右侧栏文件面板的 SFTP 上传/下载）以 DSH 宿主进程的 OS 权限读写本地文件；请把宿主账号视为可信。
- **用户终端**：远程工作台的终端是用户主动输入，不经过 agent 的审批、沙箱或黑名单；远程终端使用同一份 SSH 凭据与主机校验，本地终端以 Host 进程权限运行。终端会话随页签/页面关闭而结束，并受空闲回收约束。
- **本地文件管理**：工作台的本地文件浏览默认限制在宿主用户主目录内（插件配置 `localRoot` 可改为其他绝对路径），解析真实路径后拒绝越界与符号链接逃逸；它不是模型工具，也不暴露给 agent。
- **远程 shell 绕过本地沙箱**：远程命令在服务器上执行，不受 DSH 本地文件沙箱约束（macOS/Linux 宿主的 POSIX 目标经原生 `bash` 路由，Windows 宿主的 POSIX 目标经 `remote_bash`，Windows 目标在任一宿主上都经 `remote_pwsh`）；请用最小权限 SSH 账号并保持 host-key `strict`。
- **依赖**：发布包没有安装期运行时依赖；SSH 传输使用随包携带的纯 JS `ssh2` 1.17.0 及其依赖（版本与许可证见 `vendor/NOTICE.md`）。这样做避免了插件安装时执行第三方原生构建脚本，但意味着 ssh2 的安全更新需要随插件版本一起发布；维护者应定期跟进上游安全公告并升级 vendor 副本。
- **Windows 目标黑名单**：`remote_pwsh` 使用单独的 PowerShell 规则集（`Format-Volume`、`Clear-Disk`、`diskpart`、`bcdedit`、`cipher /w`、卷影删除、整盘递归删除等）；同样只是防误操作的 best-effort，不是权限边界。

## 运维建议

- 给插件使用独立的最小权限 SSH 账号；host-key 保持 `strict`。
- 生产服务器优先使用 `ask` / 自动审查预设；`完全权限` 只在受控环境使用。
- 重要变更前先备份；黑名单不能替代备份。
- 不要提交 `servers.json`、`secrets.json`、`secrets.key`、`known_hosts` 或活动日志。
