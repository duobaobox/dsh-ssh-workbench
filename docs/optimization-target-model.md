# 目标模型与远程执行优化方案（v2.0）

> 状态：已实现（2.0.0）  
> 日期：2026-11-10  
> 适用版本：2.0.0  
> 范围：`remote_exec`、`remote_bash` / `remote_pwsh`、目标上下文、执行统计、状态类查询性能  
> 不在本方案主线：SSH 传输层重写、终端/SFTP 功能扩展、DSH 宿主指标采集

## 0. 摘要

当前插件的核心问题不是某一个 UI 或某一句提示词，而是**“目标”同时承担了执行绑定、上下文状态和 UI 状态三种职责**，并且无目标时上下文注入存在缺口。

本方案把目标模型拆成四层：

```text
用户输入 @        →  TurnContext（本轮目标提示，只读）
工具调用           →  ExecutionRequest（必须显式 server）
执行结果           →  ExecutionLedger（追加式记录）
底部 Dock / 统计   →  Projection（从 Ledger 派生，不反向驱动执行）
```

目标：

1. 用户主动 `@` 指定目标的行为保留，并变成最短路径。
2. 无 `@` 的追问能从上下文推断；不确定时先问，不静默猜。
3. 多目标并行不再依赖切 target。
4. 切本地不再需要清理远程状态。
5. 统计口径固定为“每次任务一条记录”，总数等于各行之和。
6. 无目标时也能拿到纳管资源清单，不再让模型读取本地配置文件。
7. 状态类批量查询快路径，避免不可达主机的长时间握手。

这是一次目标模型重构，不是 TargetDock 的单点修补。

## 1. 背景与实测

### 1.1 多目标执行被串行化

实测会话中，用户 `@web-1 @db-1` 后，模型需要：

```text
ssh_workbench_target(web-1)
bash(...)
ssh_workbench_target(db-1)
bash(...)
```

这不是 SSH 慢，而是模型必须通过单例 active target 反复切换。`remote_exec` 已经可以显式指定 server 并并行，但上下文仍在引导模型先选 target。

另一条实测会话中，`remote_exec` 本身只花了约 3.1 秒（三轮分别约 1.17s / 1.75s / 0.14s），整个 turn 约 29 秒，其余时间主要是模型 reasoning/生成。说明并行执行能力没有问题，瓶颈在“模型分几步调用”和“目标状态切换”。

### 1.2 无目标时上下文缺失

另一个实测会话中，用户只说“远程看一下我的纳管资源状态”，没有 `@`：

- 模型连续 4 个 `bash` step 去查环境变量、`~/.dsh`、`servers.json`；
- 第 5 步才用 `remote_exec` 查询 6 台资源；
- 整个 turn 约 95 秒，其中发现资源本身就花了约 11 秒；
- 更严重的是，模型读取了本地 `servers.json`，这既慢又不应发生。

根因不是模型不聪明，而是插件没有在无目标时告诉它“纳管资源有哪些”。

### 1.3 本地切换与 lite 模式

实测轻量模式会话中：

- `ssh_workbench_target` 被 lite 的 deny 名单隐藏；
- 用户先 `@web-1 @db-1`，随后问“本机配置”；
- 模型连续调用 `bash` 得到 `TARGET_NOT_SELECTED`；
- `remote_exec({server:"local"})` 被拒绝；
- 模型最后 spawn 了一个本地子代理去采本机信息。

这不是 TargetDock“显示固定”的问题，而是目标工具不可用 + 本地语义不清 + 错误信息没有给出可执行路径的叠加。该 deny 已修正，但目标模型本身的耦合仍在。

### 1.4 TargetDock 反复返工

TargetDock 经历了：

```text
多目标菜单
→ 目标选择 + 统计卡
→ 只读统计卡
→ Token 用量风格卡
→ 本地隐藏 / active 优先
```

反复返工的根因是它同时被要求承担“选目标、看统计、打开工作台”三种职责。产品上应明确：**Dock 只做执行摘要，不做目标选择器。**

## 2. 用户任务与成功标准

| 任务 | 用户表达 | 成功标准 |
|---|---|---|
| 明确指定一台 | `@web-1 看看配置` | 一次工具调用完成，不需要先切 target |
| 对比多台 | `@web-1 @db-1 对比` | 一次批量并行，结果按目标聚合 |
| 连续追问同一台 | “再看看它的磁盘” | 从上下文命中上一台；不确定时询问 |
| 临时看本机 | “看看本机配置” | 直接本地执行，不影响远程状态 |
| 查看全部纳管资源 | “纳管资源状态” | 直接基于清单查询，不读本地配置 |
| 查看执行情况 | 点底部 Dock | 只看到执行次数，不承担切换语义 |

## 3. 问题清单

| ID | 严重度 | 问题 | 根因 | 证据 |
|---|---|---|---|---|
| T1 | P0 | 多目标需要反复切 target | 会话级单 active target；`bash` 没有 server 参数 | 多目标会话出现多次 `ssh_workbench_target` |
| T2 | P0 | 无 `@` 时模型不知道纳管资源 | 无 active/candidates 时上下文注入被跳过 | 实测 4 个 `bash` 步骤读取 `servers.json` |
| T3 | P0 | 无目标/目标不清晰时直接开干 | 上下文没有歧义处理策略；模型默认“全部” | “纳管资源状态”直接跑 6 台 |
| T4 | P0 | 切本地后远程工具被锁 / 状态残留 | local 是状态变更，不是执行路径选择 | lite 会话出现 `TARGET_NOT_SELECTED` + 本地子代理 |
| T5 | P0 | lite 模式隐藏 target 工具 | lite 的 `channel.config.deny` 含 `ssh_workbench_target` | 已删除该 deny，但说明工具依赖过重 |
| T6 | P1 | 统计总数与行数对不上 | 总数统计全部执行，行只渲染 candidates/active | 多目标一次 2 task 时总数 +2、每行 +1 |
| T7 | P1 | Dock 在切本地后仍显示 | 历史 stats.servers 被并入显示名单 | 1.7.4 实测；1.7.6 已改为 active/candidates 驱动 |
| T8 | P1 | 4 秒轮询常驻 | Dock 依赖 active 变化，只能轮询 | `/target?session=` 每 4 秒请求 |
| T9 | P1 | `Linux` 标签不准确 | 标签实际是“非 Windows 方言”，macOS/BSD 被误标 | 1.7.x 截图 |
| T10 | P1 | 状态查询慢：6 台约 45–51 秒 | `timeoutGuard` 探测 15s + 只读重试 + 不可达主机握手 15s | 实测 `remote_exec` 单步墙钟 |
| T11 | P1 | 模型读取本地 `servers.json` | 上下文没有清单，也没有“禁止读配置”的约束 | 实测会话 step 2–4 |
| T12 | P2 | `ssh_workbench_target` 不能列出资源 | 工具 schema 只有 `server`，没有 list 能力 | 模型只能用 bash 找配置 |
| T13 | P2 | DSH 模型指标不可得 | TTFT/TPS/轮次是宿主私有数据 | 插件只能统计远程执行 |
| T14 | P2 | lite 的 skill 目录常驻 | `dsh-tool-skill` 注入完整目录，无官方“按需目录”开关 | 关联问题，非主线 |
| T15 | P2 | 目标工具与执行工具语义重叠 | `remote_bash`/`remote_pwsh` 依赖 active，`remote_exec` 显式 server | 两套模型并存 |
| T16 | P1 | Dock 曾承担目标切换/打开工作台 | 产品职责未定，UI 反复返工 | 用户反馈“打开工作台没必要，选中没意义” |
| T17 | P2 | TargetDock 点击无效 | 弹层挂在 composer 的 stacking context 内被裁剪 | 1.7.3 修复：`createPortal` 到 `document.body` |

## 4. 根因分析

### 4.1 三种职责耦合

当前 `active target` 同时承担：

1. 执行绑定：原生 `bash` 跑哪台服务器；
2. 上下文状态：模型这一轮该看哪台；
3. UI 状态：底部 pill 显示谁。

三者耦合导致：

- 多目标必须切换；
- 切本地必须清状态；
- 统计无法按执行记录独立；
- UI 必须轮询；
- lite 模式必须额外放行 target 工具。

### 4.2 上下文注入的缺口

`lib/core/server-reference.js` 当前逻辑：

```js
const needsChoice = state.candidates.length > 1 && !state.active
if (!state.active && !needsChoice) return decision
```

无 `@` 时 `candidates` 为空，`needsChoice` 为 false，整个 context message 不注入。模型因此没有任何纳管资源清单。

### 4.3 统计口径错误

`target-stats` 的 `count` 是“本会话全部执行任务”，但 Dock 的行来自 candidates/active。多目标 `remote_exec` 一次两个 task 时：

```text
总数 +2
每行 +1
```

总数和行数必然不一致。正确做法是全部从 ExecutionLedger 派生。

### 4.4 状态查询走错了路径

“纳管资源状态”本质是批量可达性/负载查询，但当前走：

```text
模型发现资源
→ remote_exec 每台
→ 每台先做 timeoutGuard 探测
→ 不可达主机等 15s，只读失败再重试一次
→ 再等命令握手 15s
```

发现资源 + 不可达主机等待，合计把 6 台资源的查询拖到约 45–51 秒。

## 5. 目标架构

### 5.1 四层模型

```text
┌──────────────────────────────────────────────┐
│ 用户输入                                      │
│  @web-1 @db-1  /  不 @                       │
└──────────────────┬───────────────────────────┘
                   ↓
┌──────────────────────────────────────────────┐
│ TurnContext（本轮，只读）                      │
│  - 本轮 @ 的目标                              │
│  - 最近执行目标                                │
│  - 纳管资源清单（截断）                        │
└──────────────────┬───────────────────────────┘
                   ↓
┌──────────────────────────────────────────────┐
│ ExecutionRequest（每次工具调用）               │
│  - server 必填                                 │
│  - command / workdir / timeout / background   │
└──────────────────┬───────────────────────────┘
                   ↓
┌──────────────────────────────────────────────┐
│ ExecutionLedger（追加式）                      │
│  - sessionId / server / taskId / duration     │
│  - outcome / tool                             │
└──────────────────┬───────────────────────────┘
                   ↓
┌──────────────────────────────────────────────┐
│ Projection（UI）                              │
│  - Dock：标题 + 总量 + 每目标次数              │
│  - 终端/文件面板：UI 自己维护的选中项          │
└──────────────────────────────────────────────┘
```

### 5.2 设计原则

1. **执行不依赖会话状态**：任何远程执行都必须从调用参数拿到 `server`。
2. **`@` 是提示，不是状态**：它只影响本轮上下文和默认推荐，不写全局 active。
3. **统计只认 Ledger**：不把 candidates、active、历史 servers 混在一起。
4. **UI 不反向驱动执行**：Dock 只读；终端/文件面板的“当前服务器”是 UI 偏好，不是执行状态。
5. **不确定就问**：目标不清晰时 `ask_user_question`，不静默猜。
6. **兼容旧行为**：1.x 保留 target 工具和 bash 路由，2.0 再移除。

## 6. 工具契约

### 6.1 目标工具矩阵

| 工具 | 宿主 | 目标 | 说明 |
|---|---|---|---|
| `bash` | POSIX | 本地 | 2.0 起只跑本地；1.x 兼容“有 active 时远程” |
| `pwsh` | Windows | 本地 | 保持本地 |
| `remote_bash({server,command})` | 所有 | POSIX | 显式目标，不依赖 active |
| `remote_pwsh({server,command})` | 所有 | Windows | 显式目标，不依赖 active |
| `remote_exec({tasks})` | 所有 | 多目标 | 批量并行，每 task 显式 server |
| `ssh_workbench_target` | 所有 | UI/兼容 | 1.x 保留；2.0 从模型工具移除或仅 UI 使用 |

### 6.2 参数

```text
remote_bash({
  server: string,          // 必填
  command: string,
  workdir?: string,
  timeoutMs?: number,
  run_in_background?: boolean
})

remote_pwsh({ ...same })

remote_exec({
  tasks: [{ server, command, workdir?, timeoutMs? }],
  concurrency?: number
})
```

### 6.3 server 解析

- 支持 name / id / 唯一别名；
- 大小写不敏感；
- 禁用资源返回 `SERVER_DISABLED`；
- 未知资源返回错误并附可用名称（最多 N 个）；
- `server:"local"` 对 `remote_*` 一律拒绝，提示用本地 `bash`/`pwsh`；
- 方言不匹配返回明确错误（`remote_bash` 对 Windows、`remote_pwsh` 对 POSIX）。

### 6.4 错误码

| 错误码 | 场景 | 模型下一步 |
|---|---|---|
| `SERVER_UNKNOWN` | 名字不存在 | 从上下文清单重选 |
| `SERVER_DISABLED` | 资源被禁用 | 提示用户启用 |
| `SERVER_AMBIGUOUS` | 别名冲突 | 询问用户 |
| `DIALECT_MISMATCH` | 工具与目标方言不符 | 改用另一个工具 |
| `TARGET_REQUIRED` | 缺 server | 重新提供 |
| `REMOTE_TIMEOUT` | 任务超时 | 可重试或缩短命令 |
| `REMOTE_UNREACHABLE` | 连接失败 | 可跳过/提示离线 |

## 7. 上下文与 `@` 策略

### 7.1 每轮注入资源清单

只要 `remoteAvailable` 且存在纳管资源，就注入一条紧凑清单；不再只在 active/多候选时注入。

```text
[ssh-workbench] Managed resources: 6
- web-1 — 192.0.2.11 · posix
- db-1 — 192.0.2.12 · posix
- win-1 — 192.0.2.13 · windows
...
No target selected.

Rules:
- One named resource: call remote_exec with that server explicitly.
- User says "all / managed resources / everything": use remote_exec across the listed resources.
- Target unclear and not "all": ask before executing.
- Never read ~/.dsh/ssh-workbench/servers.json; use this context.
```

资源多时：

- 最多列 20 个；
- 超出显示 `... and N more`；
- 不把完整凭据、密码、密钥放进上下文；
- 只放名称、host、platform、启用状态。

### 7.2 请求类型策略

| 用户表达 | 行为 |
|---|---|
| `@web-1 看看配置` | 直接用 `remote_exec({server:"web-1"})`；不需要 target |
| `@web-1 @db-1 对比` | 一次 `remote_exec` 两个 task |
| “再看看 db-1” | 从本轮/最近上下文命中 db-1 |
| “看看状态”且有多台 | 先问范围，不直接跑全部 |
| “所有/纳管资源/全部” | 允许全量；超过阈值可先确认 |
| “本机配置” | 本地 `bash`；不触发远程 |
| 名字未知 | 问用户或列可用名称 |

### 7.3 `@` 的实现

- composer 的 `@` chip 不变；
- 解析后写入 `TurnContext.mentions`；
- 单 mention：注入“推荐 server”，模型仍显式传给工具；
- 多 mention：注入“建议 remote_exec”，不设置 active；
- 无 mention：参考 `lastExecutedServer`，但不强制；
- 会话恢复：从人类消息回放 mentions，不恢复 active。

### 7.4 P0 修复设计（最小改动）

先不改执行层，只补上下文缺口：

1. 在 `renderTargetContext` 增加“无目标但有纳管资源”的分支，输出截断后的清单与策略。
2. 放开当前 `if (!state.active && !needsChoice) return decision` 的 early return：
   - 无 active、无 candidates，但存在启用资源时，也生成一条 context；
   - 同一 turn 只注入一次，复用现有 `version` / `injectedVersion` / `firstStep` 逻辑；
   - 有 active 或 candidates 时保持现有分支。
3. 增加一条硬约束：“不要读取 `~/.dsh/ssh-workbench/servers.json`，使用本上下文”。
4. 清单上限 20 个；超出时只列前 20 + `... and N more`，并提示“需要具体资源时让用户选择”。
5. 新增测试：
   - 无 `@`、无 active、有 6 台资源 → 注入清单；
   - 无 `@`、无资源 → 不注入；
   - 资源 30 台 → 只列 20 个 + 总数；
   - 同一 turn 不重复注入；
   - 上下文不包含密码/密钥字段。

代码示意：

```js
const inventory = (servers ?? []).filter((s) => s.enabled !== false)
const hasRemoteContext = Boolean(state.active) || state.candidates.length > 0
if (!hasRemoteContext && inventory.length === 0) return decision
// ...注入 active / candidates / inventory 三种分支
```

### 7.5 为什么不是只改 system prompt

用户问过“是不是插件层的系统提示词没写好”。结论：**方向对，但不能只改静态 system prompt。**

- 纳管资源是动态的，每个用户、每个会话都可能不同；静态 prompt 无法列出。
- 工具描述也是静态的，不能为每个用户生成“可用资源列表”。
- 正确层是 `agent/pre-step` 注入的**动态上下文**；当前 bug 是这个上下文在无目标时被跳过。
- 因此修复点在 `server-reference.js` 的上下文分支，不是改全局 prompt 文案。
- 同时要在上下文里加硬约束（不要读 `servers.json`）和请求类型策略（明确/全部/不明确）。

## 8. 统计与 Dock

### 8.1 Ledger

每条记录：

```json
{
  "sessionId": "...",
  "server": "web-1",
  "taskId": "...",
  "tool": "remote_exec",
  "startedAt": "...",
  "durationMs": 69,
  "outcome": "success"
}
```

规则：

- 一个 task 一条记录；
- `remote_exec` 两个 task 产生两条；
- 失败 task 也记录，`outcome:"failed"`；
- 总数 = 所有记录数；
- 行数 = 按 server 聚合后的组数；
- 总数 = 各行之和，不再出现不一致。

### 8.2 Dock 视觉

采用 DSH Token 用量弹窗同构：

```text
┌──────────────────────────────┐
│  远程执行                4 次 │
├──────────────────────────────┤
│  web-1                   3 次 │
│  db-1                    1 次 │
└──────────────────────────────┘
```

- 只读，没有切换、没有“打开工作台”、没有 active 勾选；
- 不显示成功/失败、总用时、平均、最近；
- 不显示 DSH 模型指标；
- Windows 目标可选小徽章；
- 纯本地会话隐藏；
- 本会话有远程执行记录时显示。

### 8.3 刷新

- 打开 Dock 时拉一次；
- 每个 turn 结束后刷新；
- 如果客户端拿不到工具事件，保留 10 秒低频兜底；
- 删除 4 秒常驻轮询；
- 最终可以删除 `/target` 端点，改为 `/context` 或 `/activity?session=`。

## 9. 状态类查询性能

### 9.1 问题拆分

实测 6 台资源、3 台不可达：

- 4 个 `bash` 步骤找资源：约 11s；
- `remote_exec` 单步：约 45–51s；
- ping/网关检查：约 21s；
- 总 turn：约 95s。

`remote_exec` 慢的原因：

1. `resolveTasks` 对没有 `facts.dialect` 的目标调用 `resolveDialect`，会先试 `uname -s`，失败再试 `cmd /c ver`；每次探测都可能先等满 `connectTimeoutMs`（15s），最多 30s；
2. `resolveCapabilities` 对 POSIX 目标调用 `timeoutGuard`，又是一次连接，最多 15s；
3. 真正执行命令时还要再建立一次连接，最多 15s；
4. 连接建立失败后再次进入 `runOne` 时，当前实现没有“短连接超时”概念，仍按全局 15s 等待；
5. 并发默认 4，6 台可能分两波。

理论上限约 60s，实测 45–51s，取决于不可达主机是立即拒绝还是等满握手超时。关键点：`remote_exec` 的 `timeoutMs` 是在**连接成功、拿到 channel 之后**才开始的；它管不到连接建立阶段。

### 9.2 目标

| 指标 | 现在 | 目标 |
|---|---|---|
| 6 台（3 台离线）状态查询 | 45–51s | < 10s |
| 资源发现 | 4 个 bash step | 0（上下文直接提供） |
| 不可达目标等待 | 15s × 重试 | 3–5s 快速失败 |
| 状态查询并发 | 4 | 8 |

### 9.3 方案

1. **无目标也注入清单**：消除发现步骤。
2. **`remote_exec` 增加 `probe:false`**：
   - 跳过 `resolveDialect` 的网络探测，直接用 `effectiveDialect(server)`（`facts.dialect` → `platform`）；
   - 跳过 `resolveCapabilities` 的 `timeoutGuard` 探测，使用 `{mode:'none'}`；
   - 守卫仍按同一套 `effectiveDialect` 规则执行，不跳过安全检查。
3. **短连接超时**：新增 per-call / per-task `connectTimeoutMs`，一路传到 broker 的 `acquire`；`timeoutMs` 只管命令，不管连接。状态查询建议 `connectTimeoutMs:4000`、`timeoutMs:5000`。
4. **并发 8**：6 台一波完成。
5. **可选 `remote_status`**：只做连通性/短探测，返回统一结构；如果后续发现 `probe:false` 在未知方言目标上误判过多，再单独做这个工具。
6. **连接失败快速返回**：broker 对 `EHOSTDOWN`/`ECONNREFUSED` 立即失败，不等待握手超时。

### 9.4 `probe:false` 能做到什么

单独加 `probe:false`：

- 去掉了最多 30s 的方言探测 + 15s 的 `timeoutGuard`；
- 但真正执行时仍会尝试连接，最坏还是 15s；
- 所以只能从 45–51s 降到约 15s，**不能稳定 < 10s**。

`probe:false` + `connectTimeoutMs:4000`：

- 不可达目标约 4–5s 返回；
- 6 台并发 8，一波完成，稳定 < 10s；
- 可达目标仍能正常执行，且连接成功后不再受短超时影响（连接已建立）。

已知边界：

- `probe:false` 依赖 `facts.dialect` 或 `platform`。如果两者都缺失/错误，Windows 目标可能被当 POSIX 执行；
- 因此它只适合“只读状态查询”这类可接受失败/重试的场景，不适合写操作；
- `remote_status` 仍可作为后续更干净的方案，但不是 P0 必需项。

### 9.5 不做

- 不把“所有目标”做成隐式默认；
- 不在用户没要求时自动后台扫描；
- 不为了快而跳过 guard。

## 10. 安全边界

- `remote_exec` 每个 task 逐条过 guard，按 server 方言选择规则；
- 显式 server 不能绕过 guard；
- 批量任务逐条检查，任一 deny 整批拒绝；
- 上下文不放密码/密钥/完整凭据；
- 禁止模型读取 `~/.dsh/ssh-workbench/servers.json` 等本地配置；
- 输出仍受 `maxOutputBytes` / `maxBatchOutputBytes` 限制；
- 权限边界仍是最小权限 SSH 账号 + DSH 审批，插件不宣称自己是权限边界。

## 11. 兼容与迁移

| 阶段 | 版本 | 行为 |
|---|---|---|
| 兼容期 | 1.8 | 让 `remote_bash` 在所有宿主可见，并给 `remote_bash` / `remote_pwsh` 增加显式 `server`；保留 `ssh_workbench_target` 和 bash 远程路由；上下文注入资源清单 |
| 迁移期 | 1.9 | 新路径默认显式 server；target 工具标记 deprecated；Dock 改 Ledger；去掉 4s 轮询 |
| 清理期 | 2.0 | `bash` 只跑本地；移除 target store/replay/POST；移除模型可见的 `ssh_workbench_target`；更新文档与迁移说明 |

旧会话：

- 已有 active target 的会话继续可读；
- 不做数据迁移；
- 升级后首次执行给出一次性提示：“远程命令请显式指定 server”；
- 旧 target 工具在 2.0 移除，保留 UI 终端/文件面板的独立选择。

### 11.1 优先级与工作量估算

| 阶段 | 内容 | 估算 |
|---|---|---|
| P0 | 无目标上下文注入、清单截断、禁止读配置 | 0.5–1 人日 |
| P1 | `remote_bash` 全宿主可见 + 显式 server；`remote_pwsh` 显式 server；guard/activity 跟随 | 2–3 人日 |
| P2 | `@` / 无 `@` / 歧义策略与上下文改造 | 1–2 人日 |
| P3 | ExecutionLedger、Dock 投影、去掉 4s 轮询 | 1–2 人日 |
| P4 | 状态查询快路径（短超时、跳过探测、并发 8） | 1–2 人日 |
| P5 | 2.0 清理 target store/replay/POST、文档迁移 | 1–2 人日 |

总计约 6–10 人日；单人开发含测试约 1.5–2 周。P0 和 P4 可以并行，且不依赖 target 2.0 清理。

## 12. 验收标准

### 12.1 功能场景

1. `@web-1 状态` → 1 次工具调用，无 target 切换。
2. `@web-1 @db-1 对比` → 1 次 `remote_exec`，2 个 task 并发。
3. 无 `@` 追问“再看看 db-1” → 命中 db-1。
4. 无 `@` 只说“看看状态”且有 6 台 → 先问范围。
5. “所有纳管资源状态” → 全量查询，不读本地配置。
6. “本机配置” → 本地 `bash`，Dock 不显示远程。
7. 未知 server → 错误中列出可用名称。
8. 6 台 3 台离线 → 状态查询 < 10s。
9. Dock 总数 = 各行次数之和。
10. 纯本地会话 → Dock 隐藏。

### 12.2 测试

- 单元：server 解析、guard、ledger 聚合、上下文截断；
- 集成：mock SSH、并发池、超时/取消/输出截断；
- UI：headless 真实页面，单/多目标、隐藏/显示、点击开合；
- 行为：用固定 prompt 跑 10 次，检查工具选择、是否读配置、是否先问；
- 回归：`npm test` 全绿，旧 target 路径仍可用。

### 12.3 指标

- `TARGET_NOT_SELECTED` 出现次数 → 0；
- 每个远程任务的平均 target 切换次数 → 0；
- 无目标状态查询的工具调用数 → ≤ 1；
- 6 台状态查询 p95 → < 10s；
- 统计总数与行数不一致 → 0；
- 读取本地配置文件的次数 → 0。

## 13. 关联问题（不在本方案主线）

| 问题 | 状态 | 建议 |
|---|---|---|
| lite 模式 deny `ssh_workbench_target` | 已删除该 deny | 新模型下不再依赖 target，问题自然消失 |
| lite 模式 deny `remote_pwsh` | 已删除 | 保留 Windows 场景 |
| lite 是否需要插件 | 待定 | 纯 YAML 无法表达 `tools.restrict` deny 和 `{{channel_rules}}`；保留小插件更稳 |
| skill 目录常驻 | 待定 | 官方无“按需目录”开关；可隐藏 `skill` 工具或保持现状 |
| IM 工具 deny | 不做 | 用户已卸载 IM |
| agent-team 工具不受 deny | 已知 | 会话作用域工具，保留现状 |

## 14. 待决问题

1. `bash` 在 1.x 是否继续兼容“有 active 时远程”，还是 1.8 就改本地 only？
   - 建议：1.x 兼容，1.9 默认显式，2.0 移除。
2. `ssh_workbench_target` 是否保留为 UI-only？
   - 建议：保留，但不再作为模型执行前置；2.0 从模型工具移除。
3. 状态查询新增 `remote_status`，还是给 `remote_exec` 加 `probe:false`？
   - 建议：先给 `remote_exec` 加 `probe:false` + `connectTimeoutMs`；`probe:false` 单独只能降到约 15s，必须配合短连接超时才 < 10s。`remote_status` 作为后续可选工具。
4. 资源数量超过多少时先问？
   - 建议：> 8 台且用户未明确说“所有”时先问。
5. 端口/polling 是否降到 10s 或完全事件驱动？
   - 建议：先移除 4s，改为打开时 + turn 结束；有事件再接。
6. lite 的 skill 体验是否单独立项？
   - 建议：与目标模型解耦，单独评估。

## 15. 附录：代码位置

- `lib/core/server-reference.js`：目标上下文注入与缺口
- `lib/core/targets.js`：active/candidates 状态机
- `lib/core/remote-exec-tool.js`：批量执行
- `lib/core/remote-bash-tool.js`：`remote_bash` / `remote_pwsh`
- `lib/core/remote-bash.js`：原生 `bash` 路由与 `TARGET_NOT_SELECTED`
- `lib/core/target-stats.js`：统计聚合
- `lib/core/activity.js`：sessionId / durationMs 记录
- `lib/client.js`：TargetDock
- `lib/routes.js`：`/target`、`/servers`、`/activity`
- `lib/core/broker.js`、`lib/core/ssh.js`：连接池、握手超时、timeoutGuard

## 16. 结论

当前问题可以归纳为一句话：

> **目标不是一个会话状态，而是一次执行的参数；统计不是 UI 的附属品，而是执行记录的投影。**

按本方案分阶段落地，可以同时解决：

- 多目标切换；
- 无 `@` 目标识别；
- 切本地；
- 统计不一致；
- Dock 反复返工；
- 无目标状态查询慢；
- 模型读取本地配置；
- lite 模式依赖 target 工具。

建议先做第 7 节的上下文注入（P0）和第 9 节的状态查询快路径（P1），再进入 2.0 的 target 状态清理。
