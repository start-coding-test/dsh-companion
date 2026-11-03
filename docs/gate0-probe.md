# Gate 0 进程内探针（H1 / H2 / H3 / W2）

这套探针用来回答外部评审要求先落实的四个平台事实，避免在 `src/` 里猜测 DSH 行为：

| 编号 | 待回答的问题 |
| --- | --- |
| H1 | `ctx.compaction.compactRegion(start, end, …)` 的 `start`/`end` 是什么 seq？与 `tokenMeter.measure` / `session.surface.nodes` 的关系是什么？ |
| H2 | `agent/pre-step` 的 `payload.messages` 是「本步新消息」还是「整段历史」？`payload` 里有哪些字段？ |
| H3 | 同一进程存在多个会话时，`agent/pre-step` 是否会按会话各自触发？ |
| W2 | 真实 DSH 进程的 Node 版本、`node:sqlite` / `DatabaseSync` 是否可用？ |

探针本身**只读**：不写业务库、不调用 `compactRegion`、不改变 pre-step 决策、不读取或打印任何凭据。采样结果写到仓库 `.data/probe.json`（`.data/` 已在 `.gitignore` 中）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `scripts/probe/probe-plugin.js` | 最小 cordis 插件，导出 `apply(ctx, config)`；启动、首个 `agent/pre-step`、`agent/turn-stopping` 时写 probe.json |
| `scripts/probe/probe.patch.yml` | 临时 overlay：`insert` 一条 `gate0-probe`，`name: ./probe-plugin.js` 会锚定到 patch 文件所在目录 |
| `scripts/probe/run-headless.mjs` | 用临时 `DSH_HOME` 跑 headless 会话并把 probe.json 拷回 `.data/`；`--two-turn` 会续跑同一会话取得第 2 个 turn |
| `docs/gate0-probe.md` | 本文档 |

## 快速跑（推荐，不碰用户 profile）

前置：本机装有 DSH（默认自动查找 `D:\dsh\resources\runtime\cli\bin\dsh.cmd`、`DeepSeek Harness` 安装目录或 `PATH` 上的 `dsh`），Node ≥ 24。

```powershell
cd D:\test\agent-plugin\dsh-companion
npm run probe:headless -- --two-turn
# 等价于：node scripts/probe/run-headless.mjs --two-turn
```

脚本行为：

1. 清空并重建仓库内临时 home：`.data/probe-home`（**不会**读取或写入 `~/.dsh`）；
2. 启动 `dsh --profile headless --patch scripts/probe/probe.patch.yml "<task>"`；
3. 第一轮报告存到 `.data/probe-run1.json`；
4. `--two-turn` 时从第一轮报告取出 session id，用 `--session-id` 续跑同一会话，第二轮报告写到 `.data/probe.json`；
5. 打印摘要，退出码 `0` 表示至少采集到 pre-step / agent 证据，`1` 表示没有证据，`2` 表示 CLI 缺失或参数错误。

没有模型凭据时 headless 会在请求阶段报 `MISSING_CREDENTIAL` 并退出 1，但 `agent/pre-step` 在请求之前触发，探针数据仍然有效；摘要里会明确写出这一点。

常用选项：

```text
--task <text>     第一轮任务（默认 "Reply with exactly: ok"）
--task2 <text>    第二轮任务（配合 --two-turn）
--two-turn        续跑同一会话，采集第 2 个 turn 的 surface/seq
--dsh <path>      指定 DSH CLI
--timeout <ms>    子进程超时（默认 120000）
--keep-home       复用现有 .data/probe-home（默认每次重建）
--help            查看完整帮助
```

## 手动挂到独立 profile

如果不想用 runner，或要在**桌面 / Web** 里观察多会话（H3 需要），用独立 `DSH_HOME` + overlay patch 手动挂载。以下命令都只操作仓库内临时 home。

PowerShell：

```powershell
cd D:\test\agent-plugin\dsh-companion
$env:DSH_HOME = "$PWD\.data\probe-home"
$env:DSH_PROBE_OUT = "$PWD\.data\probe.json"

# 可选：创建一个独立 custom profile（从 shipped headless 模板克隆）
& "D:\dsh\resources\runtime\cli\bin\dsh.cmd" probe --from-default-profile headless --help

# 把探针 patch 叠到该 profile 上跑一次一次性任务
& "D:\dsh\resources\runtime\cli\bin\dsh.cmd" probe --patch "$PWD\scripts\probe\probe.patch.yml" "Reply with exactly: ok"
```

`--patch` 的 insert 项使用 `name: ./probe-plugin.js`。DSH 会把它锚定到 patch 文件所在目录再转成 `file://` URL，因此**不需要**把插件拷贝进 profile，也不需要 `pnpm install`。

要在 GUI 里观察多会话：

1. 保持上面的 `DSH_HOME` / `DSH_PROBE_OUT`；
2. 启动 Web profile：`dsh web --patch <repo>\scripts\probe\probe.patch.yml`（若 profile 未初始化，先 `dsh web --from-default-profile web`）；
3. 打开它输出的本地 URL，分别在两个会话里各发一条消息（凭据缺失时消息会失败，但 pre-step 仍会记录）；
4. 结束进程后读取 `.data/probe.json`，看 `events.preStep.sessions` 是否出现两个不同的 session id。

> 注意：headless 的 shipped profile 禁用了受管凭据库；GUI profile 需要正常配置模型凭据。不要为了跑探针把密钥写进仓库或 `probe.json`。

## probe.json 字段地图

| 路径 | 内容 |
| --- | --- |
| `process.node / electron / v8 / execPath` | 真实宿主运行时（Electron 的 Node，不是命令行 Node） |
| `sqlite.ok / sqlite.DatabaseSync / sqlite.sqliteVersion` | `await import('node:sqlite')` 结果；用内存库 `select sqlite_version()` 探测 |
| `capabilities.services.<key>.present / methods` | 通过 `ctx.get(key)` 探测的 service 面（systemPrompt、tokenMeter、compaction、commands、tools、sessions、subagents、sessionQuery、sessionProjections、agents、timer 等） |
| `capabilities.mixins.on / effect / interval …` | cordis Context mixin 是否可用；未声明 `inject` 时直接读 `ctx.interval` 会抛 `cannot get property "timer" without inject`，探针记录该事实而不是崩溃 |
| `capabilities.direct.events` | `ctx.events` 是 `EventsService`；`intervals` / `timer` / `sessions` 等 service 属性读取受 `inject` 约束 |
| `tokenMeter.measure.arity / prototypeSource` | `measure` 的 arity 与原型链上的真实源码（实例属性是 bind 后的 native 函数） |
| `tokenMeter.measureResult` | 首个 pre-step 时的一次 `measure(session)`：键名、`nodes` 是否为对象数组、`nodes[].seq` 序列、`totalTokens/surfaceTokens/logRevision` |
| `tokenMeter.surfaceMeasurement` | 若 `agent/turn-stopping` 触发，再测一次 surface（成功跑完一轮时使用） |
| `compaction.compactRegion.arity / parameters / prototypeSource` | 只读取签名，**不调用** |
| `preStep.payloadKeys / turn / step / session.id / preset` | 首个 pre-step 的 payload 结构；preset 从 `session.header.agentPreset` 和 `sessionProjections.stateOf(session,'agentPreset')` 读取 |
| `preStep.messages` | 消息条数、角色序列、每条文本长度与前 80 字（截断） |
| `preStep.session.surface` | `surface.nodes`（seq 数组）、`logLength`、`firstLiveSeq`、content/replace generation |
| `events.preStep.sessions[id].count` | **按会话**累计的 pre-step 次数（H3 的关键证据） |
| `events.preStep.occurrences[]` | 最近 20 次 pre-step 的 turn/step/messageCount/surfaceNodeCount |
| `events.turnStopping.registered / fired` | `agent/turn-stopping` 是否可注册、是否触发 |
| `events.agentCreated / agentError` | agent 生命周期与会话错误（错误只保留名称/截断消息） |
| `errors[]` | 探针自身捕获的错误，不影响宿主 |

## Gate 0 判定表

以下是 2026-11 在 `D:\dsh`（DeepSeek Harness，desktop runtime）上实测的观察。换机器后按同一流程重跑即可复核。

### H1：compactRegion 的 seq 语义

**观察**

- `ctx.compaction.compactRegion.length === 4`；原型源码是
  `async compactRegion(start, end, agent, signal) { return compactSurfaceRegion(this.regionDependencies(), agent.session, start, end, agent, { owner: "current-turn", stability: "whole-surface" }, signal); }`
- 两次真实采样：

  | 场景 | `session.surface.nodes` | `session.log.length` | `measure().nodes` |
  | --- | --- | --- | --- |
  | 新会话第 1 个 pre-step | `[]` | 6 | `[]` |
  | 同一会话续跑第 2 个 turn | `[7, 8, 9, 10]` | 22 | `[{seq:7,…},{seq:8,…},{seq:9,…},{seq:10,…}]` |

- `measure()` 返回键固定为 `logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes`；`nodes` 是**对象数组**，每项含 `seq / tokens / heuristicTokens`，`seq` 与 `surface.nodes` 的值一一对应。
- 平台实现 `validateSurfaceRegion(session, start, end)`（`dsh-compaction-basic`）用 `nodes.indexOf(start)` / `nodes.indexOf(end)` 校验，并取 `nodes.slice(startIdx, endIdx + 1)`。

**判定：`start`/`end` 是 surface 节点的 session seq（不是 log 下标、不是数组下标），闭区间。** 取值应来自 `session.surface.nodes` 或 `measure().nodes[].seq`；两者不在 surface 上会直接报 `start seq … not found in surface`。区间还要求工具调用/结果成对（balanced boundary）且处于 open turn。

### H2：pre-step messages 范围

**观察**

- payload 键：`messages, turn, step, signal, agent`。
- 新会话第 1 个 turn：`messages.count = 1`，角色 `["user"]`，就是本次任务文本。
- 续跑同一会话第 2 个 turn：session log 已有 22 条、surface 有 4 个节点，但 `messages.count` 仍是 `1`，且内容是**第二轮的新任务**，不含第一轮历史。
- `agent/pre-step` 的调用点在 `dsh-agent-loop` 的 `preStep()`：`claimed = this.inbox.claim(...)` 之后把 `messages: claimed` 放进 payload。

**判定：`payload.messages` 是本步从 inbox 领取的（新的）用户消息，不是整段会话历史。** `src/` 里若需要历史上下文，不能依赖 pre-step messages；应使用 session/surface 或 tokenMeter 的投影（`docs/platform-api.md` 的 enter 契约也要求先 `await next()` 再整批替换）。

### H3：多会话下 pre-step 是否触发

**观察**

- `ctx.on('agent/pre-step', …)` 可注册（`registered=true`，disposer 为函数）；事件按 agent 派发，payload 带 `payload.agent.session.id`。
- headless 单进程单会话：`events.preStep.sessions` 只有 1 个 key，`count=1`。
- 探针按 `session.id` 维护独立的计数与最近 occurrence，因此同一进程出现多个会话时可直接看出每个会话是否各自触发。
- 事件目录（`dsh-tool-cordis/lib/types/api-catalog.js`）把 `agent/pre-step` 声明为 agent scope 的 waterfall，`this: Scoped<Agent>`；`dsh-agent-loop` 在**每个 Agent 实例**的 `preStep()` 里派发。

**判定：pre-step 是 per-agent（per-session）触发的。** 单会话采样只能证明「会触发」，多会话结论要按上面 GUI 步骤开两个会话复核：`events.preStep.sessions` 应出现两个 id，且各自 `count` 增加；`occurrences[].sessionId` 交替出现。注意这不是「全局只触发一次」，也不能把一次触发的结果复用到其他会话。

### W2：Node 版本与 node:sqlite

**观察**

- `process.versions.node = 24.21.0`，`electron = 44.7.0`，`v8 = 15.2.124.28-electron.0`；
- `process.execPath = D:\dsh\DeepSeek Harness.exe`（`ELECTRON_RUN_AS_NODE=1`，即 Electron 内置 Node）；
- `await import('node:sqlite')` 成功；`DatabaseSync` / `StatementSync` 均为 function；内存库 `select sqlite_version()` 返回 `3.53.4`；
- `package.json` 的 `engines.node >= 24` 与真实运行时一致。

**判定：可以直接依赖 `node:sqlite`（`DatabaseSync`）且不需要 native 依赖；目标运行时是 Node 24.x。** 但注意它是 Electron 内置 Node：CI（纯 Node 24）与桌面（Electron 44）都应覆盖；`node:sqlite` 在两者都可用。

## 已知限制

- **不调用 `compactRegion`**：它会写 surface，违反「探针只读」。H1 的结论来自签名 + 两次真实 surface/measure 采样 + 平台校验函数源码，而不是执行一次压缩。
- **没有模型凭据时**：请求阶段报 `MISSING_CREDENTIAL`，`agent/turn-stopping` 不会触发，`tokenMeter.surfaceMeasurement` 为空；用 `--two-turn` 仍能拿到第 2 个 pre-step 的非空 surface。
- **headless 的 preset 为 null**：`session.header.agentPreset = null` 是 headless 的实际情况；GUI profile 下同一字段会记录 preset id。探针同时读 `sessionProjections.stateOf(session,'agentPreset')` 作为交叉验证。
- 探针不打印环境变量值，输出中的错误消息经过截断；`run-headless.mjs` 另做 `sk-*` / `authorization` / `bearer` 脱敏。

## 排查

| 症状 | 处理 |
| --- | --- |
| `DSH CLI not found` | 用 `--dsh <path>`、`DSH_CLI` 或 `DSH_INSTALL_DIR` 指定安装根目录 |
| 插件未激活（`did not activate`） | 看 DSH stderr 里的插件错误；patch 的 `name` 必须是相对 patch 文件的路径 |
| probe.json 没有更新 | 确认 `DSH_PROBE_OUT` 指向可写路径；插件写失败只记录在 stderr，不影响宿主 |
| 想清理临时数据 | 删除 `.data/probe-home`、`.data/probe*.json`（均在 gitignore 内） |
