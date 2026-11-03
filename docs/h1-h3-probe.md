# H1 / H3 平台 API 可行性探查（seq 迁移 · 会话分流）

本文只回答「能不能做、证据在哪、怎么做最稳」，不改 `src/`，也不改 `memory/` 设计文档。

- 证据根：`memory/_research/dsh-src/dsh/node_modules/@deepseek-ai`（下文记作 `PKG`）。
- 行号以当前快照为准；表中「公开度」按平台**生成的公开类型声明**（`*.d.ts` / `api-catalog`）判定，
  不按运行时对象形状判定。
- 与 `docs/gate0-probe.md` 的实测结论互相印证：H1 的 `start`/`end` 确实是 surface 节点 seq
  （闭区间），H2 的 `payload.messages` 只是本步新消息，H3 的 pre-step 是 per-agent 触发。

## 0. 结论先行

| # | 问题 | 结论 | 公开度 | 风险 |
| --- | --- | --- | --- | --- |
| Q1 | pre-step 里能拿 surface 节点列表吗？ | **能拿 seq，拿不到文本**。`payload.agent.session.surface.nodes` 是 `readonly SessionSeq[]`（纯数字）。文本要走 `sessionQuery.readSurface()`、`session/event` 增量索引或 `session.deriveMessages()` | `surface.nodes` 公开；`agent.session` 公开（但 `Agent` 的完整声明不在核心 catalog 里） | 低 |
| Q2 | 能读「水位之后、尾部 6,144 之前」正文吗？ | **能**。推荐 `session/event` 增量维护 `seq → {role, text, tokens}`，冷启动用 `sessionQuery.readSurface()` 回填；`readSurface().events` 与 `surface.nodes` **逐位 1:1** | `session/event` 公开（emit）；`readSurface` 公开 | 低（注意 `readSurface` 是 O(整段 log)） |
| Q3 | 会话身份能区分主会话 / 线程 / subagent 吗？ | **header 里没有 `kind` 字段**；**subagent 能**（`header.origin === 'subagent'` + `header.parentSession`）；**我们自己创建的线程会话在 header 上与主会话无法区分**（`sessionController.createSession` 不写 lineage）→ 必须靠插件自己的注册表 + 约定 | `SessionHeader` 全部字段公开 | 中（线程标记需自建） |
| Q4 | `section({text})` 能按会话给不同文本吗？ | **能，两种路径**。① 全局注册 + `text(context)` 里用 `context.scope`（运行期就是 `agent`）取会话；② 对每个 agent 用 `agent.ctx.systemPrompt.section()` 覆盖（平台自己的做法）。注意：prompt 组装在 pre-step **之前**，pre-step 里注册只影响**下一个** step | `PromptSection.text` 的函数签名公开；`AssembleContext` **不含 `agent`**（只有 `scope?: ScopeKey`） | 中（`scope` 是 agent 属运行期约定，需防御式读取） |
| Q5 | pre-step 对 subagent 触发吗？lineage 怎么取？ | **触发**（subagent 与主会话共用同一个 agent-loop 工厂，pre-step 由 `agentEvents` 注入 `payload.agent`）。lineage 取 `payload.agent.session.header.parentSession` / `origin` / `delegationDepth` | 同 Q3 | 低 |
| Q6 | 是否只依赖公开面？ | 本文用到的字段**都能在平台生成的公开类型里找到**（`agent.session` 见 `dsh-agent-preset-registry` 的 host typert，略偏离核心 catalog）；唯一没有类型依据的是 `context.scope === agent` 这条**运行期约定**（Q4 路径①，已标中风险）。`platform-api.md` 目前**一条都没收录**，实现时要补表。要避开的三个：`session.log`、`appendPluginRecord`、`eventAt/snapshotEvents/ownEvents` | — | 见 §3 |

一句话：**H1 可做（seq 侧），H3 可做但「我们的线程」必须自带身份**。

## 1. 证据表

### Q1：surface 节点 = 只有 seq

| 事实 | 证据（`PKG/…:行号`） |
| --- | --- |
| pre-step payload 只有 `{ agent, messages, turn, step, signal }`，**没有 surface 字段** | `dsh-tool-cordis/lib/types/api-catalog.js:4004-4006` |
| `SessionSurface` 声明只有 `nodes` / `replaceGeneration` / `contentGeneration`，`nodes` 是 `readonly SessionSeq[]` | `dsh-tool-cordis/lib/types/api-catalog.js:7403-7404` |
| `Session` 公开声明含 `get surface(): SessionSurface`、`header`、`deriveMessages()`、`deriveEventMessage(event)` | `dsh-api-session-controller/lib/typert.host.js:2730-2731` |
| `SurfaceManager.get nodes()` 直接返回内部 seq 数组（无文本） | `dsh-session/lib/index.js:502-598` |
| `Session.deriveMessages()` 按 `surface.nodes` 顺序投影，**空 content 的节点投影为 `null` 被跳过** → 返回数组与 `nodes` 不保证 index 对齐；但它是 O(新增节点) 增量缓存 | `dsh-session/lib/index.js:1672-1690`；`dsh-session/lib/index.js:217-230` |
| `Message` 形状：`{ id, content: ContentBlock[], source }`，角色 map `system/developer/user/assistant/tool`，文本块 `{ type: 'text', text }` | `dsh-llm/lib/typert.host.js:459-461`、`:315-317`、`:603-605` |
| `tokenMeter.measure(session)` 的 `nodes` 每项固定 `{ seq, tokens, heuristicTokens }` —— **只有 seq 和 token** | `dsh-tool-cordis/lib/types/api-catalog.js:3302-3303`；`dsh-token-meter/lib/index.js:600-663`、`:531-551` |

### Q2：正文从哪来

| 事实 | 证据 |
| --- | --- |
| `sessionQuery.readSurface(sessionId) → { session, inheritedEventCount, capturedThroughSeq, events: SurfaceEvent[] }`，`events` 是**带 `data` 的完整 surface 事件** | `dsh-tool-cordis/lib/types/api-catalog.js:2383`、`:7407-7408`；`dsh-session-query/lib/index.js:1168-1175` |
| `events` 与 `surface.nodes` **逐位对齐**：`currentSeqs.map(seq => snapshotSessionEvent(events[seq]))` | `dsh-session-query/lib/index.js:856-863` |
| 但对 live 会话是 `snapshotEvents()` + 逐事件 `structuredClone` + 整段 `analyzeEventLog` fold → **每次 O(整段 log)** | `dsh-session-query/lib/index.js:302-308`、`:846-861` |
| `ctx.sessionQuery` 是公开服务（`key: 'sessionQuery'`，`summary: 'Unified live-preferred session query service.'`） | `dsh-tool-cordis/lib/types/api-catalog.js:2311-2312` |
| `session/event` 是公开 emit，post-commit 逐条投递；`this: Scoped<Session>`，catalog 只说「agent-scoped 监听器只收该 agent 上下文进入的会话」⇒ 根 `ctx` 的监听器收全部 | `dsh-tool-cordis/lib/types/api-catalog.js:4379-4382` |
| `deriveEventMessage(event)`：`user/message` 的 `data` 就是消息；`assistant/message`/`system`/`developer` 取 `data.message`（空 content → `null`）；`tool/result` 取 `data.message` | `dsh-session/lib/index.js:217-230` |
| `tokenMeter` 自己就是靠 `ctx.on('session/event', …)` 增量同步 surface 再 `priceSurface` | `dsh-token-meter/lib/index.js:697-699`、`:722` |
| **不要用**：`eventAt`/`snapshotEvents`/`ownEvents` 在 README 里已声明 deprecated（"new production calls are prohibited"）；`session.log` 不在公开声明里 | `dsh-session/README.md`；`dsh-api-session-controller/lib/typert.host.js:2731` |

### Q3/Q5：会话身份

| 事实 | 证据 |
| --- | --- |
| `SessionHeader` 公开字段：`version,id,createdAt,cwd?,parentSession?,isSeeded,origin?:'subagent',delegationDepth?,agentPreset?` | `dsh-tool-cordis/lib/types/api-catalog.js:7143-7144`、`dsh-agent-preset-registry/lib/typert.host.js:753` |
| subagent 的 header 由 `childSessionMeta()` 生成：`{ cwd?, agentPreset?, parentSession: parent.id, isSeeded, origin: 'subagent', delegationDepth }` | `dsh-subagent/lib/index.js:346-357` |
| 本地子 agent 走 `ctx.agents.create({ sessionId, parentAgent, meta: create.meta, … })` → **与主会话同一个 agent-loop 工厂**，因此同样触发 pre-step | `dsh-subagent/lib/index.js:1815-1823`；`dsh-agent-loop/lib/index.js:907-915` |
| pre-step 的 `payload.agent` 由平台注入（`agentEvents` 的 `fused = payload => ({ ...payload, agent })`） | `dsh-agent/lib/index.js:242-278`、`:291-297` |
| `ctx.sessionController.createAgent()` 只传 `meta: { cwd, …agentPreset? }` —— **不写 `parentSession` / `origin` / `delegationDepth`** | `dsh-api-session-controller/lib/index.js:513-528`；`createSession` `:264` |
| `Agent` 完整声明含 `session`、`options`、`ctx`、`whenIdle()`；核心 catalog 只声明 `{ id }` | `dsh-agent-preset-registry/lib/typert.host.js:277`；`dsh-tool-cordis/lib/types/api-catalog.js:4643-4644` |
| 运行时归属与持久 lineage 是两回事：`roots()`、`isOwnedBy(id, owner)` | `dsh-tool-cordis/lib/types/api-catalog.js:157-236` |
| 深度：`delegationDepthOf(agent) = max(header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)` | `dsh-subagent/lib/index.js:111-118` |

### Q4：prompt section 的按会话能力

| 事实 | 证据 |
| --- | --- |
| `PromptSection.text: string \| ((context: AssembleContext) => string)` | `dsh-tool-cordis/lib/types/api-catalog.js:6500` |
| `AssembleContext = { scope?: ScopeKey; signal?: AbortSignal }`（**没有 `agent`**；`ScopeKey = object`） | `dsh-tool-cordis/lib/types/api-catalog.js:4783-4784` |
| 但运行期由 `assembleContextFor(agent, signal)` 组装成 `{ agent, scope: agent, … }`，注释明确要求 agent 与 scope 一起设，以免 agent 作用域贡献被静默丢弃 | `dsh-agent/lib/index.js:291-297` |
| 因此 `text(context)` 里 `context.scope` 就是当前 agent（可取 `scope.session.header`） | 同上 + `dsh-agent-loop/lib/index.js:907` |
| 平台自己就是「per-agent 注册同名 section 覆盖」：`childCtx.systemPrompt.section({ name, order, text })` | `dsh-subagent/lib/index.js:390-393`、`:934-938` |
| 同名 section 全局重复会报错并提示走 `agent.ctx`；scoped section 会 shadow 全局；`complete: true` 会整段替换 prompt（多个同时存在会 throw） | `dsh-system-prompt/lib/index.js:204-208`、`:252-258`、`:363-437` |
| **时序**：`preStep()` 先 `systemPrompt.assemble()`（:907），再 `agent/pre-step`（:909）→ pre-step 内注册只影响下一个 step | `dsh-agent-loop/lib/index.js:896-915` |

### H1：`compactRegion` 的区间语义（补充 gate0 结论）

| 事实 | 证据 |
| --- | --- |
| `start`/`end` 是 **surface 位置区间**（含两端），不是数值 seq 序：替换后可见 seq 可能非单调 | `dsh-tool-cordis/lib/types/api-catalog.js:627-632` |
| 校验：seq 必须在 `session.surface.nodes` 里找到；`startIdx > endIdx` 报错；两端必须 `toolPairingBalancedBefore/After` | `dsh-compaction-basic/lib/index.js:550-566` |
| 汇总前用 `measure(session).nodes.slice(startIdx, endIdx+1)` 与选中 seq 逐一比对，变了就 `SurfaceChangedError` | `dsh-compaction-basic/lib/index.js:568-572` |
| 平衡检查函数从 `@deepseek-ai/dsh-compaction` 具名导入（可复用，但要新增包依赖） | `dsh-compaction-basic/lib/index.js:2` |

## 2. 推荐实现（5 条）

### R1（H1）—— seq 一律按「surface 位置」处理，不假设单调

1. `const nodes = payload.agent.session.surface.nodes`（`readonly`，不要改）。
2. `const measured = ctx.tokenMeter.measure(agent.session).nodes`；用 `node.seq` 与 `nodes` 逐位对齐（两者都描述当前 surface），
   拿到每节点 `tokens`。
3. 选区间：`startIdx = nodes.indexOf(watermarkSeq) + 1`（水位节点本身已巩固）；`indexOf` 返回 `-1`
   （水位节点已被压缩替换掉）时退化为从位置 0 起算，并只接受「两端都能在 `nodes` 里找到」的区间。
   `endIdx` = 从尾部向前累加 `tokens` 达到 6,144 的位置再 -1。
4. 两端做**自己的平衡检查**（查该 seq 的 role / 是否有未闭合的 tool call），失败就退一格；
   工具函数 `toolPairingBalancedBefore/After` 只在我们愿意新增 `@deepseek-ai/dsh-compaction` 依赖时才用。
5. `compactRegion(nodes[startIdx], nodes[endIdx], agent, signal)`；把它的 `throw` 当作「本轮跳过、下轮重试」，
   不要当作崩溃（区间可能被别的压缩/注入改动）。

### R2（Q1/Q2）—— 建自己的 `seq → {role, text, tokens}` 索引

1. 插件 `apply()` 里 `ctx.on('session/event', (session, event) => …)`（未 scoped ⇒ 收到所有会话）。
2. 每条事件：`const msg = session.deriveEventMessage(event)`；`msg === null` 跳过；否则
   `index.set(event.seq, { role: msg.role, text: flatten(msg.content), tokens: ctx.tokenMeter.estimateMessage(msg) })`。
   `flatten` 只取 `type === 'text'` 的块，tool 块留 `toolName` 摘要。
3. 冷启动 / 漏事件：对目标会话 `await ctx.sessionQuery.readSurface(sessionId)`，用
   `events[i].seq === session.surface.nodes[i]` 的 1:1 关系回填；**每会话最多一次**（O(整段 log)）。
4. 只索引我们关心的会话（主会话 + 注册表里的线程），其它会话直接跳过，避免无谓内存。

### R3（Q2）—— 「水位之后、尾部 6,144 之前」的取法

1. 位置集合 = `surface.nodes`；水位 = 我们库里已巩固到的最后一个 seq（按位置比较，不按数值）。
2. 尾部 6,144 用 R1 的 `measured.tokens` 从尾向前累加切出 `tailStartIdx`。
3. 窗口 = `nodes` 中 `watermarkIdx < i < tailStartIdx` 的节点；正文从 R2 索引取，索引缺失的节点
   **整段降级为 readSurface 回填一次**，仍缺失则该轮放弃巩固（宁可不写，不写半截）。
4. 注入/压缩都只消费这个窗口，不要碰 `payload.messages`（它只有本步新消息，见 gate0 H2）。

### R4（H3）—— 会话分流用「注册表优先」，header 只认 subagent

判定顺序（第一个命中即返回）：

1. `sessionId` 命中我们自己的线程注册表（`src/thread/registry.js` 已有，持久化在本地库）→ `thread`；
2. `agent.session.header.origin === 'subagent'` → `subagent`（可再取 `parentSession`、
   `max(header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)`）；
3. 其余 → `main`。

配套约定（因为 `sessionController.createSession` 不写 lineage）：

- 创建线程会话时**显式**传一个专用 `agentPreset`（`createSession({ agentPreset })` 会写入
  `header.agentPreset`），作为注册表丢失时的兜底信号；**不要**指望 `parentSession`。
- 注册表读不到时默认 `main`——主会话才注入记忆，误判为 main 最多多注入一次，误判为 thread 会漏记忆。
- 生命周期：`ctx.agents.get(id)` 为空即视为会话不在内存（归档/退出），清理索引；不要用
  `ctx.agents.roots()` 判持久 lineage（它只看运行时归属）。

### R5（Q4）—— 按会话的 prompt 文本

- 线程会话：创建后立刻 `created.agent.ctx.systemPrompt.section({ name: 'companion:session-memory', order, text })`，
  平台自己的 subagent 就这么做；销毁时 dispose。
- 主会话：全局注册一次，`text: (context) => { const agent = context?.scope; const sid = agent?.session?.header?.id; return sid ? render(stateFor(sid)) : '' }`，
  `agent?.session?.header?.id` 全链路防御式读取（`scope` 的公开类型只是 `object`，`agent` 甚至不在类型里）。
- 若不想依赖 `scope`：全局注册 + `pre-step` 里按会话维护 `Map<sessionId, string>`，`text` 只读该 map，
  代价是**滞后一步**（assemble 在 pre-step 之前）。
- 需要「本 step 立即生效」的文本只能走 pre-step 的 `{ kind: 'enter', messages }` 改写，不要指望 section。

## 3. 断点风险与降级

| 依赖 | 公开度 | 风险 | 降级 |
| --- | --- | --- | --- |
| `agent.session`（Agent 完整声明不在核心 catalog，只在 `dsh-agent-preset-registry` 的 host typert 里；运行期 `ReactLoopAgent.session` 是普通字段） | 生成类型可查，但被拆在两个包 | **中** | 只用 `payload.agent.session`，不假设 `agent` 上还有别的字段；缺失时本轮跳过 |
| `session.surface.nodes` / `header.*` / `deriveMessages()` | `Session` 类公开声明 + `SessionHeader` 类型 | 低 | `nodes` 不在预期形状 → 本轮跳过 |
| `sessionQuery.readSurface` | catalog 公开方法 | 低 | 依赖整段 log，只做冷启动回填；失败则用 R2 索引（可能缺历史） |
| `session/event` 全局监听 | catalog 公开 emit | 低 | 事件丢失用 `readSurface` 兜底；再失败放弃本轮 |
| `context.scope === agent`（Q4 路径①） | `AssembleContext` 只声明 `scope?: object` | **中** | 退回路径②（`agent.ctx.systemPrompt.section`）或 map 滞后方案 |
| `session.log` | **不在公开声明** | 高 | 禁止使用 |
| `appendPluginRecord` | 已导出，但注释限定只有 `packages/experimental/` 生产代码可调，`verify-plugin-record-callers` 门禁会拒 | 高 | 用注册表/事件替代 |
| `eventAt` / `snapshotEvents` / `ownEvents` | 在类声明里但 README 标 deprecated | 高 | 用投影面（`surface` + `deriveEventMessage` + `readSurface`） |

需要在 `docs/platform-api.md` §1 补的行（实现时一起做）：
`session.surface.nodes`、`session.header`、`session.deriveEventMessage` / `deriveMessages`、
`ctx.sessionQuery.readSurface`、`ctx.on('session/event')`、`systemPrompt.section` 的 per-agent 作用域，
以及 `Agent.session` 的调用形状。

## 4. 没验证 / 怎么验证

- 本文的**类型与实现**证据均为静态阅读；运行时行为沿用 `docs/gate0-probe.md` 的实测
  （`surface.nodes` 为 `[]` 起步、第二个 turn 为 `[7,8,9,10]`、`measure().nodes` 同 seq）。
- 待实测（扩展 `scripts/probe/probe-plugin.js` 即可，不必新增 patch）：
  1. pre-step 里 `sessionQuery.readSurface(session.id)` 的耗时（长会话 O(log) 是否可接受）；
  2. `session/event` 是否在 pre-step 之前把本轮新消息投递完（决定索引是否最新）；
  3. 线程会话（`sessionController.createSession`）的 `header.agentPreset` 是否如预期落盘；
  4. subagent 会话的 pre-step payload 是否 `origin === 'subagent'` 且 `parentSession` 指向父会话。
- 复现方式与门禁同 `docs/gate0-probe.md`：`npm run probe:headless -- --two-turn`，只写仓库内
  `.data/probe-home`，**不要**读写 `~/.dsh`。
