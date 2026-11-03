# 平台 API 摘录与适配层（dsh-companion）

本文固定 `dsh-companion` 依赖的 DSH 平台能力、调用形状与源码证据，并说明
`src/platform/adapter.js` 如何把这些能力收口成唯一入口。

- 证据根：`memory/_research/dsh-src/dsh/node_modules/@deepseek-ai`（下文记作 `PKG`）。
- 表中「证据」均为相对 `PKG` 的 `文件:行号`，行号以当前快照为准；改动平台源码后需要重新核对。
- 设计口径来自 `memory/docs/01-需求与约束.md`、`memory/docs/05-摘录供终稿用.md`、
  `memory/docs/07`（v3.1）与 `memory/开发规划-v2.md`。

## 1. 能力清单

| # | 能力 | 签名 / 契约 | 本插件用途 | 证据（PKG/…:行号） |
| --- | --- | --- | --- | --- |
| 1 | system prompt 服务 | `ctx.systemPrompt` | 注册人格与记忆提示段 | `dsh-system-prompt/lib/index.js:226` |
| 2 | `systemPrompt.section` | `ctx.systemPrompt.section({ name, order, text }) → Disposer`；`order` 必须有限，`text` 可为 `string` 或 `(context) => string` | 人格装配、记忆注入段 | `dsh-system-prompt/lib/index.js:253-255`、`:383-385` |
| 3 | `agent/pre-step` 监听 | `ctx.on('agent/pre-step', async (payload, next) => Decision)`；payload = `{ agent, messages, turn, step, signal }`；`ctx.on` 返回 disposer | 每轮检索注入、压缩窗口选择 | `dsh-agent-loop/lib/index.js:909`；`dsh-agent-instructions/lib/index.js:1406`；`dsh-agent/README.md:67` |
| 4 | `enter` 决策 | `{ kind: 'enter', messages }`；`messages` 整体替换本批进入消息，返回时应 `...decision` 保留上游字段（如 `startsRequestSeries`） | 检索注入、过滤/改写本批消息 | `dsh-agent-loop/lib/index.js:914-920`；真实写法 `dsh-time-context/lib/index.js:215-234` |
| 5 | `agent.inject`（agent 句柄） | `agent.inject(input)`；写入 next-step、**不唤醒** driver，下一次被准入的 step 才生效 | 空闲期被动补充模型可见上下文（检索主路径仍走 pre-step） | `dsh-agent-loop/lib/index.js:812`；`dsh-agent/README.md:47` |
| 6 | `ctx.interval` | `ctx.interval(callback, delay) → Disposer`；另支持 `ctx.interval(delay)` 异步迭代器 | 30s 调度 tick、每日 03:00 归档扫描 | `cordis-plugin-timer/lib/index.js:48,53`；`cordis-plugin-timer/README.md:30` |
| 7 | compaction 服务 | `ctx.compaction`（抽象后端，三操作 `compactIfNeeded` / `compactNow` / `compactRegion`） | 只用 `compactRegion` | `dsh-compaction/lib/index.js:171`；`dsh-compaction/README.md:78` |
| 8 | `compaction.compactRegion` | `ctx.compaction.compactRegion(start, end, agent, signal)`；`start`/`end` 为 surface 节点 seq 闭区间，边界必须存在且 tool call/result 配对均衡 | 两段式压缩的阶段 2 | `dsh-compaction-basic/lib/index.js:971`；参数校验 `:554-558`；必须存在 open turn `:460` |
| 9 | `compaction.compactNow`（不用） | `ctx.compaction.compactNow(agent, signal, sourceCommandId)`；要求 idle agent，无区间参数 | 用户手动 `/compact` 语义，不满足保留尾部与先写库要求 | `dsh-compaction-basic/lib/index.js:985-1009`；range 选择 `:992` |
| 10 | `sessionController.createSession` | `ctx.sessionController.createSession(request) → { agent, agentPreset }`；request 可带 `{ sessionId, cwd, agentPreset, reusable }` | 线程 worker 会话语义 | `dsh-api-session-controller/lib/index.js:264`、`:502-507`；服务名 `:2952` |
| 11 | `sessionController.prompt` | `ctx.sessionController.prompt(request, source)`；request = `{ sessionId, content, requestId, mode?: 'queue'\|'steer' }`；source 形如 `{ kind: 'user', rpcId }`，`rpcId === requestId` 时平台按请求去重 | 向 worker 投递消息、重试幂等 | `dsh-api-session-controller/lib/index.js:925`；source `:3225-3233`；去重 `:1124-1136` |
| 12 | `sessionController.cancel` | `ctx.sessionController.cancel({ sessionId })` | 线程取消/回收 | `dsh-api-session-controller/lib/index.js:1061` |
| 13 | `agent.whenIdle` | `agent.whenIdle() → Promise`；属于 agent 句柄，不在 sessionController 上 | 回执前等待线程静默 | `dsh-agent-loop/lib/index.js:870`；`dsh-agent/README.md:47` |
| 14 | `workspaceRegistry.archiveSession` | `ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity })`；不带 `stopActivity` 时若有活动会抛 `WorkspaceActiveSessionError`；`stopActivity: true` 先写归档集再停活动 | 空闲 14 天的线程冻结 | `dsh-workspace/lib/index.js:526,540`；`stopSessionActivity` `:621-623`；错误类 `:303-305` |
| 15 | `workspaceRegistry.unarchiveSession` | `ctx.workspaceRegistry.unarchiveSession(sessionId)` | 线程重新激活（当前适配层未封装，见 §3） | `dsh-workspace/lib/index.js:553` |
| 16 | `tokenMeter.measure` | `ctx.tokenMeter.measure(session, requestHeader) → { totalTokens, surfaceTokens, nodes, ... }` | 读取会话 token 用量（阈值判断） | `dsh-token-meter/lib/index.js:692,722` |
| 17 | `ctx.logger` | `ctx.logger.info/warn/error/debug(message, meta?)`；也可 `ctx.logger()` 取命名 logger | 插件观测 | `cordis/lib/index.js:579-582`；用法 `dsh-agent/lib/index.js:258` |
| 18 | `session/event` | `ctx.on('session/event', (session, event) => void)`（post-commit，emit）；`event.seq` 为该事件的 session seq，`event.type ∈ {system,developer,user,assistant}/message`、`tool/result` | H1 surface 索引的增量正文来源 | api-catalog `dsh-tool-cordis/lib/types/api-catalog.js:4379-4384` |
| 19 | `sessionQuery.readSurface` | `ctx.sessionQuery.readSurface(sessionId) → { session, inheritedEventCount, capturedThroughSeq, events }`；`events` 与 `session.surface.nodes` 逐位 1:1，含正文；每次 O(整段 log) | 索引冷启动/压缩后全量回填（每会话至多一次） | api-catalog `:2383-2386`；实现 `dsh-session-query/lib/index.js:1167-1175` |
| 20 | `tokenMeter.estimateMessage` | `ctx.tokenMeter.estimateMessage(message) → number`；单条消息的启发式 token 估算 | surface 索引里实时事件的 token 计价 | api-catalog `:3297-3320`；内部 `dsh-token-meter/lib/index.js:531-551` |

### 1.1 pre-step 的两个关键细节

1. **`enter` 是整批替换，不是追加。** fallback 的 enter 决策已经带上平台组装结果
   （`messages: context === void 0 ? claimed : [...claimed, context]`，
   `dsh-agent-loop/lib/index.js:914-920`）；监听器返回 `{ kind: 'enter', messages }`
   会替换整个批次。因此要先 `await next()`，再在 `decision.messages` 上做增删，
   并 `{ ...decision, messages }` 保留 `startsRequestSeries` 等字段
   （参考 `dsh-agent-instructions/lib/index.js:1406-1421`、`dsh-time-context/lib/index.js:215-234`）。
2. **平台 `inject` 与 pre-step 注入不是同一层。** `agent.inject(input)`
   （`dsh-agent-loop/lib/index.js:812`）把内容放进 next-step inbox 且不唤醒 driver；
   适配层的 `onPreStep` 补丁 `{ inject: [...] }` 则是在本轮 step 已获准入、平台 fallback
   之后，把内容追加到本批 `decision.messages`。后者不会唤醒任何东西，是检索注入使用的路径，
   语义等价于「模型可见的下一批上下文」，但**不写回 inbox**。

### 1.2 为什么不用 `compactNow`

- `compactNow` 走 `agent.runMaintenance(...)`，要求 agent 空闲且没有排队唤醒的工作，
  否则抛 `ManualCompactionError('busy', ...)`（`dsh-compaction-basic/lib/index.js:985-1009`）。
  本插件在空闲期需要先写库再压缩，`compactNow` 的入口时序不受我们控制。
- 它没有区间参数，内部用 `selectCompactableRange(..., 0)` 自选范围
  （`dsh-compaction-basic/lib/index.js:992`），第三参为 0 表示不留最近对话尾部；
  而 R-SES-07 要求保留尾部 6,144 tokens。
- 它产生 `owner: null`、`turn: null`、`stability: 'selected-span'` 的手动压缩
  bracket（`dsh-compaction-basic/lib/index.js:995-996`），与本插件「turn 内、
  whole-surface 稳定性、两段式（written → compacted）」的自动压缩语义不一致。
- 结论：只用 `compactRegion(start, end, agent, signal)`；由于它要求 open turn
  （`:460`），阶段 1（空闲写库 `status=written`）可以发生在 turn 外，
  阶段 2（选区间并 `compactRegion`）顺延到下一次 `agent/pre-step`，在 open turn 内执行。
  没有下一次 turn 时压缩保持 pending，由 40K 安全阀在下一轮优先处理。

## 2. 适配层契约

`src/platform/adapter.js` 只依赖 Node 内置模块与 `./errors.js`，不 import 任何
`@deepseek-ai/*` 包；所有平台调用都经传入的 `ctx`（或调用方传入的 agent 句柄）。

```js
import { createAdapter } from './src/platform/adapter.js';

const platform = createAdapter(ctx, { now: () => Date.now() });
```

| 方法 | 转发目标 | 说明 |
| --- | --- | --- |
| `now()` | `opts.now` → `ctx.now()` → `Date.now()` | 可注入时钟；测试用 FakeCtx 手动推进 |
| `log(level, message, meta?)` | `ctx.logger[level]` | 无 logger 时安静返回 `false`；非法 level 抛 `TypeError` |
| `section(spec)` | `ctx.systemPrompt.section(spec)` | 返回平台 disposer |
| `onPreStep(handler)` | `ctx.on('agent/pre-step', listener)` | 返回 disposer；handler 在 fallback 之后执行，补丁见下 |
| `every(ms, callback)` | `ctx.interval(callback, ms)` | 返回 disposer；`ms` 必须为正有限数 |
| `compactRegion(start, end, agent, signal?)` | `ctx.compaction.compactRegion(...)` | 闭区间，调用方负责 open turn 时序 |
| `createSession(request)` | `ctx.sessionController.createSession(request)` | 返回 `{ agent, agentPreset }` |
| `prompt(request, source?)` | `ctx.sessionController.prompt(request, source)` | source 缺省为 `{ kind: 'user', rpcId: request.requestId }`；无 `requestId` 时生成 `companion-<uuid>` |
| `cancel(sessionIdOrRequest)` | `ctx.sessionController.cancel(request)` | 字符串自动包成 `{ sessionId }` |
| `whenIdle(agentOrCreated)` | `agent.whenIdle()` | 接受 agent 句柄或 `createSession` 返回值 `{ agent }` |
| `archiveSession(sessionId, options?)` | `ctx.workspaceRegistry.archiveSession(...)` | 归档线程；冻结场景应传 `{ stopActivity: true }` |
| `measure(session, requestHeader?)` | `ctx.tokenMeter.measure(...)` | 返回平台计量对象 |
| `estimateMessage(message)` | `ctx.tokenMeter.estimateMessage(...)` | 单条消息的启发式 token（surface 索引计价） |
| `onSessionEvent(handler)` | `ctx.on('session/event', (session, event) => …)` | 返回 disposer；handler 异常被吞掉，不打断事件流 |
| `readSurface(sessionId)` | `ctx.sessionQuery.readSurface(...)` | O(整段 log)：仅冷启动/漏事件回填用 |

### 2.1 `onPreStep` 补丁

`handler(payload, decision)` 的返回值：

| 返回值 | 效果 |
| --- | --- |
| `undefined` / `null` | 不修改平台决策 |
| `{ inject: ContentBlock[] }` | 追加到 `decision.messages` 尾部（检索注入） |
| `{ messages: ContentBlock[] }` | 整体替换本批进入消息 |
| `{ reject: true }` / `{ kind: 'reject' }` | 拒绝本步 |
| `{ kind: 'enter', messages }` | 同 `messages` 替换 |

上游已经 `reject` 时适配层直接透传，不再调用 handler；返回时展开原决策以保留
`startsRequestSeries` 等字段。同时返回 `messages` 与 `inject`、或字段类型错误，
会抛 `TypeError`（编程错误，不做降级）。

### 2.2 能力探测与 `PlatformError`

适配器对象上有只读的 `capabilities`（getter，随宿主服务装载实时变化）：
`systemPrompt`、`preStep`、`timer`、`compaction`、`sessionController`、`archive`、
`tokenMeter`、`tokenEstimator`、`sessionEvent`、`sessionQuery`、`logger`。调用缺失能力时抛 `PlatformError`：

| code | 触发方法 |
| --- | --- |
| `no-system-prompt` | `section` |
| `no-pre-step` | `onPreStep` |
| `no-timer` | `every` |
| `no-compaction` | `compactRegion` |
| `no-session` | `createSession` / `prompt` / `cancel` |
| `no-archive` | `archiveSession` |
| `no-token-meter` | `measure` |
| `no-token-estimator` | `estimateMessage` |
| `no-session-event` | `onSessionEvent` |
| `no-session-query` | `readSurface` |
| `no-when-idle` | `whenIdle`（传入对象没有 `whenIdle()`） |

`PlatformError` 定义在 `src/platform/errors.js`：`new PlatformError(code, message?)`，
带 `name = 'PlatformError'` 与稳定 `code`；`message` 缺省回退为 `code`。
`log` 在无 logger 时不抛错（日志不应阻断业务）。

## 3. 未纳入本期适配层的能力

- `workspaceRegistry.unarchiveSession(sessionId)`（`dsh-workspace/lib/index.js:553`）：
  线程重新激活需要先取消归档。当前卡只封装归档；线程卡实现激活流程时再补，
  或由调用方经 `ctx` 直接调用。
- `systemPrompt.context()`、`systemPrompt.variables()` 等提示装配扩展点：本期
  人格与记忆统一走 `section()`，不额外封装。
- `compaction.compactIfNeeded` / 配置项 `retainTokens`：本插件自算阈值与保留尾部，
  不使用 compaction-basic 的自动策略（见 §1.2）。

## 4. FakeCtx（`test/fakes/ctx.js`）

`FakeCtx` 覆盖适配层用到的平台面：
`now`、`logger`、`systemPrompt.section`、`on`、`interval`、`compaction.compactRegion`、
`sessionController.createSession`、`sessionController.prompt`、`sessionController.cancel`、
`workspaceRegistry.archiveSession`、`tokenMeter.measure`、`tokenMeter.estimateMessage`、
`sessionQuery.readSurface`，以及用真实 session 形态模拟的 `session/event` 源。

```js
import { FakeCtx } from './test/fakes/ctx.js';

const ctx = new FakeCtx({
  now: Date.parse('2026-01-01T00:00:00Z'), // 手动时钟起点
  missing: ['compaction'],                  // 缺失能力，用于测 PlatformError
  fail: { 'agent.whenIdle': new Error('boom') }, // 失败注入
  returns: { 'tokenMeter.measure': { totalTokens: 31000 } },
});

ctx.advance(60_000);              // 推进手动时钟
await ctx.fireTimers(2);          // 触发 every 注册的回调（已 dispose 的跳过）
await ctx.dispatch('agent/pre-step', payload, fallback); // 模拟 waterfall
ctx.callsOf('sessionController.prompt'); // 调用记录 { method, args, at }

// 带 surface 的会话（H1：seq 来自 surface.nodes，不是 log 下标）
const session = ctx.addSession({ id: 'session-1', events: [userEvent('...', 7)] });
ctx.emitSessionEvent(session.id, userEvent('新消息', 8)); // 触发 session/event
ctx.compactSession(session.id, 7, 8, { remap: [100] });    // 模拟压缩后的 seq 重映射
```

- `calls` 记录 `{ method, args, at }`，断言转发参数用 `callsOf(method)`。
- `missing` 支持服务名（`compaction` / `sessionController` / …）以及
  `sessionController.prompt` 这类单个方法粒度。
- `fail` / `fail(key, error)` 的 key 用点号路径；`whenIdle` 的 key 为 `agent.whenIdle`。
- `dispatch(event, payload, fallback)` 按注册顺序执行 waterfall，供 `onPreStep` 测试使用。
