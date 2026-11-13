# dsh-companion v0.4.13 独立复审报告

- **结论：`needs_revision`**
- 复审对象：`D:\test\agent-plugin\dsh-companion`，分支 `feat/v0413`，`31cf454..HEAD`（HEAD `d3a2245`，26 个提交）
- 复审方式：逐文件读 diff + 独立探针（探针只放在 `D:\test\agent-plugin\_r24\`，不 import 仓库测试、不修改 `src/` 与 `test/`）
- 运行环境：捆绑 Node `v24.21.0`（`C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）；Windows；三个时区分别跑全套测试
- 问题统计：**H（阻断）1 条 / M（重要）3 条 / L（次要）6 条**

## 一、分级问题

### H-1 A5 过期提醒在真实用户消息形状下永远不会注入

**位置**

- `src/reminder/expired-notice.js:101`：`if (typeof message?.source?.kind === 'string' && message.source.kind !== '') continue;`
- 调用点：`src/index.js:1599`（pre-step 中 `injectExpiredNotices(state, payload, messages, turnKey, scope)`）
- 线上消息形状依据：`docs/platform-api.md:25`（宿主按 `requestId` 构造 `{ kind: 'user', rpcId }`）、`src/index.js:3671-3675`（本插件注释也承认宿主把内容记成 `{kind:'user', rpcId}`）、`test/v0413-envelope.test.js:44`（同形状）

**现象**

`lastUserTextOf` 为了「跳过注入消息」，跳过了**所有带非空 `source.kind` 的 user 消息**。但宿主给真实用户正文的 `source.kind` 就是 `'user'`，于是这个函数在真实会话里恒返回空串，`injectExpiredNotices` 在 `src/reminder/expired-notice.js:57-58` 直接返回 `null`。后果：

- 过期提醒一次都不会通知（A5 功能整体失效，不是偶发）；
- `expired_notified_at` 永远不写，重启后仍然不会通知（因为根本没走到标记）；
- `test/v0413-expired-notice.test.js` 用的消息**没有 `source`**，所以测试全绿——这是本报告点名的最关键自证型缺口。

**最小复现（探针 `probe9-a5-source.mjs`，3 通过 / 1 失败）**

```js
// D:\test\agent-plugin\_r24\probe9-a5-source.mjs
import { injectExpiredNotices } from '../dsh-companion/src/reminder/expired-notice.js';
const body = { role: 'user', content: [{ type: 'text', text: '晚上好' }], source: { kind: 'user' } };
// store 中有一条 status='expired' 且 expired_notified_at IS NULL 的提醒
await injectExpiredNotices(state, { agent: { session: { id: 's1' } } }, [body], 't1', 'main');
// → null（预期应返回 { inject: [ … ] }）
```

同一探针里，去掉 `source` 的同文消息会正常注入；只有信封（`<dsh_im_…>`）时返回 `null`（这一条符合预期）。

**建议修法**

- 不要用「有没有 `source.kind`」判断注入；复用 A7 的判定口径：只跳过已知注入 kind（`companion-recall` / `emotion` / `command-hint` / `privacy-hint` / `runtime-context` / `companion-expired` / 插件信封 `plugin:*+form:'notice'`）以及正文以 `<dsh_im_` 开头的消息（`src/index.js:3633-3669`、`5160-5178`）。
- 或者让 `injectExpiredNotices` 接收一个 `lastUserText` 回调，由接线层传入现有实现，避免两套判定继续漂移。
- 把 `state.turnSeen.add(key)`（`expired-notice.js:55`）移到「确认可注入」之后再执行；现在先占 key、后检查正文，某一步没有正文时会在同 turn 内把通知永久吃掉。
- 回归测试必须使用 `source:{kind:'user'}` 的真实形状，并补一条「真实正文 + 召回注入 + 信封」混合排列。

---

### M-1 A2 额度紧张但没有 `resetAt` 时，后台完全不暂停

**位置**

- `src/index.js:2390-2394`：

  ```js
  if (evaluation.paused === true && evaluation.resumeAt !== null) {
    state.quotaPausedUntil = evaluation.resumeAt;
  } else if (evaluation.paused !== true) {
    state.quotaPausedUntil = null;
  }
  ```

- `src/index.js:2349-2363`（`quotaPaused` 只看 `quotaPausedUntil`）
- `src/runtime/quota-gate.js:39-64`（`readQuotaFile` 在缺 `resetAt` 时返回 `ok:true, evaluation.paused:true, resumeAt:null`）
- 文档承诺：`docs/usage-v0413.md:44-47`、`docs/usage.md:233-237`；示例 `docs/usage-v0413.md:36-40` 的 `7d` 窗口就**没有** `resetAt`

**现象**

快照里某个窗口低于预留线、但所有紧张窗口都没有 `resetAt` 时：

- `readQuotaFile` 返回 `evaluation={state:'tight', paused:true, resumeAt:null}`；
- `refreshQuota` 两个分支都不进，`quotaPausedUntil` 保持 `null`；
- `quotaPaused()` 返回 `false`，`proactiveBlocked` / `deferBackground` 全部放行；
- `/状态` 仍显示「额度紧张，后台暂停（5h 剩余 10%）」，但实际没有暂停——**状态文本与执行行为相反**。

`probe11-quota-null-reset.mjs` 用真实 `apply()` 驱动 pre-step，3/3 断言观察到：

| 场景 | 后台巩固行数 | 结论 |
| --- | --- | --- |
| 无 quota | 1 | 对照组，正常触发 |
| tight + resetAt（未来） | 0 | 控制组，确实被挡 |
| tight 无 resetAt | 1 | **应被挡却执行（缺陷）** |

**最小复现**

```json
{
  "updatedAt": 1794550000,
  "windows": [
    { "name": "7d", "remaining": 200000, "limit": 1000000 }
  ]
}
```

把该文件配到 `quota.source=file`，等阈值巩固条件满足；`refreshQuota` 后 `quotaPaused(state) === false`，非 hard 巩固照跑。

**建议修法**

- `paused === true && resumeAt === null` 时给一个保守兜底暂停（例如 `now + staleMs`，15 分钟后随快照刷新重评），或者让 `quotaPaused` 在 `quotaPausedUntil === null` 时回看 `state.quota.evaluation`（同样受 15 分钟新鲜度约束）。
- 增加「文件快照 → refreshQuota → deferBackground/巩固是否执行」的接线测试，而不是只测纯函数。

---

### M-2 A2 显式 `resetAt: null` / `updatedAt: null` 会判整份快照非法，闸门静默 fail-open

**位置**

- `src/runtime/quota.js:85-87`（`updatedAt`）、`:111-112`（`resetAt`）：

  ```js
  if (rawResetAt !== undefined && !isFiniteInteger(rawResetAt)) return INVALID_SNAPSHOT;
  ```

- `src/runtime/quota-gate.js:59-60`：解析失败 → `{ok:false, reason:'snapshot_invalid:invalid_snapshot'}`
- `src/index.js:2384-2386`：读失败时 `state.quota=null`，仅 `file_missing` 保留暂停；`refreshQuota` 对调用方等价于「不紧张」，后台继续跑
- 把该契约锁死的测试：`test/quota.test.js:99`、`:102`

**现象**

很多配额导出器会把「没有重置时间」序列化成 `"resetAt": null`，这是 JSON 的常规形状；但当前实现把显式 `null` 判为非法，导致整份快照被丢弃：

```text
{"updatedAt":1794550000,"windows":[{"name":"5h","remaining":100,"limit":1000,"resetAt":null}]}
→ readQuotaFile = { ok:false, reason:'snapshot_invalid:invalid_snapshot' }
→ refreshQuota 清空 state.quota，后台不暂停
```

而「省略 `resetAt`」是合法的（`test/quota.test.js:67-76`）。同一个语义（没有重置时间）有两种结果：省略 → 紧张但（因 M-1）不暂停；显式 `null` → 整份快照无效。文档没有说明这个区别，只有 debug 日志，用户无感。

**最小复现**

用 `probe4-quota.mjs` 的 `readQuotaFile` 直接读上述 JSON；或用 `refreshQuota` 接线后观察 `state.quota === null`、`quotaPaused() === false`。

**建议修法**

- 把 `null` 与 `undefined` 同义处理（`rawResetAt == null ? null : …`），仍拒绝小数、字符串、负数等非整数；`updatedAt` 同理。
- 允许显式 `null` 后，`test/quota.test.js:99/:102` 的「invalid」断言要改成「归一为 null」；这是**测试锁定了可疑契约**，不是文档要求。
- 增加文件级用例：显式 `null` + tight → `ok:true` 且暂停行为与省略 `resetAt` 一致。

---

### M-3 A4 `reminder_add` 接受 `rrule` 但默认 `kind='todo'`，系列只触发一次后静默结束

**位置**

- `src/runtime/tools.js:396`：`const kind = optionalEnum(args.kind, …) ?? 'todo';`
- `src/runtime/tools.js:408-428`：只要 `rrule` 非空就解析、算首投，不校验 `kind`
- `src/index.js:4382-4387`：`const isSeries = fresh.kind === 'repeat' && rrule !== '';` 只有 `repeat` 才推进
- 文档：`docs/usage-v0413.md:62-68` 只写「`reminder_add` 新增 `rrule` 参数……投递成功后按原定序列推进」，没有要求同时传 `kind=repeat`

**现象**

模型/用户按文档只给 `rrule`（最常见：`{ "title": "每天喝水", "rrule": "FREQ=DAILY" }`）：

- 工具创建成功，`kind='todo'`，首投时间正确；
- 第一次投递成功后 `settleReminderSent` 判定非系列，`markReminderDelivered` → `status='fired'`；
- `next_fire_at` 不再推进，**第二天不会提醒**，且没有任何错误/日志提示系列已结束。

`probe10-rrule-kind.mjs` 5/5 观察到：

| 输入 | 首投后 status | next_fire_at | series_index |
| --- | --- | --- | --- |
| `rrule` + 默认 `kind`（todo） | `fired` | 不变 | 0 |
| `rrule` + `kind='repeat'` | `pending` | +86400 | 1 |

**最小复现**

```js
await tool.execute({ title: '喝水', rrule: 'FREQ=DAILY' }); // kind 缺省 todo
// 走真实 claimReminderDelivery → settleReminderSent
// 断言 status === 'fired' 且 next_fire_at 未变（缺陷）
```

**建议修法**

- `rrule` 出现且 `kind` 未显式给出时自动置为 `repeat`；或显式拒绝 `kind!=='repeat'` 并返回 `rrule_requires_repeat`，不要接受后静默降级。
- `settleReminderSent` 可把「有 `rrule`」本身视为系列（不再要求 kind），但这会改变已有 `todo` 数据的语义，需迁移/兼容说明；优先在写入端修正。
- 增加工具级 + 投递级的联合测试（`probe10` 的形状），不要只测 `nextSeriesFire` 纯函数。

---

### L-1 A6 冷却计数的持久化键只写不读，重启后冷却必然被绕过

**位置**

- `src/index.js:1556-1561`：每个 pre-step 无条件把 `thresholdTurnsByScope` +1（注释明说「每个 pre-step 算一轮」）
- `src/index.js:2450-2452`：`turnsSinceThreshold: state.thresholdTurnsByScope.get(scope) ?? config.compact?.cooldownTurns ?? 3`
- `src/index.js:2957-2964`：`store.setMeta('compact_threshold_turns:' + scope, '0')`

**现象**

- `compact_threshold_turns:<scope>` 全仓库只有写入，没有读取（`grep` 仅此一处）；重启后内存 Map 清空，`scheduleConsolidation` 把「没记录过」当作**冷却已满足**，于是重启即可再次阈值压缩。文档 `docs/usage.md:202-203` 说「只有 threshold 压缩成功后才归零」，与重启后的实际行为不一致。
- 冷却按 pre-step 而非对话 turn 计（文档 `docs/usage.md:202` 承认按 pre-step），一个 turn 内多次工具调用会提前满足 `cooldownTurns`；`docs/usage-v0413.md:54` 的「至少隔几轮」容易被读成对话轮次。

**最小复现**

```powershell
Select-String -Path src/index.js -Pattern 'compact_threshold_turns'   # 仅 2960 一处 setMeta，无读取
# 同一进程内连续两次 threshold 压缩后，第 3 个 pre-step 即可再次满足冷却；
# 重启进程后 Map 为空，scheduleConsolidation 直接走 ?? cooldownTurns ?? 3 的「已满足」分支。
```

**建议修法**

- 二选一：启动时读回该 meta 并初始化 Map；或删掉这条 `setMeta`，在文档里明确「冷却只在进程内有效，重启即视为满足」。
- 若产品意图是「对话轮」，把 +1 移到 `isNewTurn` 分支内（现在 `isNewTurn` 只控制 `recordTokenEvent`）。

---

### L-2 A1 文档称「其余六类都已接线」，实际 `embedding` 没有写入点

**位置**

- `docs/usage-v0413.md:16-20`：「来源分 main / consolidate / smalltalk / embedding / task / thread / appraise……`thread` 尚未入账，其余六类都已接线」
- `src/memory/store.js:219-221`：`TOKEN_USAGE_SOURCES` 声明了 `embedding` / `thread`
- 实际写入点只有 5 个：`src/index.js:2005`（main）、`:3288`（appraise）、`:4034`（consolidate）、`:4999`（smalltalk）、`src/runtime/tools.js:187`（task）；`grep recordModelUsage|recordTokenUsage` 无 `embedding` 写入
- 另：`docs/usage-v0413.md:16` 说「每次模型调用都会落一行」，而 main 是每个 turn 一条 delta（`src/index.js:1992-2008`），并非每次调用一行

**最小复现**

```powershell
Get-ChildItem src -Recurse -Filter *.js |
  Select-String -Pattern "source: 'embedding'|source: 'thread'"
# 无输出；对照 docs/usage-v0413.md:16-20 的「其余六类都已接线」
```

**建议修法**

- 要么在向量回填处接 `embedding` 记账，要么把文档改成「已接线 main / consolidate / smalltalk / task / appraise；thread、embedding 尚未入账」，并修正「每次模型调用一行」的表述。

---

### L-3 A1 `budget.window5hLimit` 可配置、可校验，但没有任何消费点

**位置**

- `src/config.js:185-190`、`:807-835`：默认 `null`，校验 `1000..dailyHardLimit`
- `src/index.js`、`src/runtime/budget.js`：只使用 `dailyHardLimit`；`grep window5hLimit` 仅命中 `src/config.js`
- 文档：`docs/usage-v0413.md:13`「预留 5 小时窗口；null 表示不启用」

**现象**

设置 `budget.window5hLimit: 300000` 后不产生任何限制效果；`sumTokenUsageSince`（`src/memory/store.js`）其实已经具备按时间窗汇总的能力，但没有接线。若意图只是「预留」，应在文档里明确「当前仅解析、不生效」，不要让用户以为打开了一个闸门。

**最小复现**

```powershell
Select-String -Path src -Recurse -Pattern 'window5hLimit'   # 只命中 src/config.js
# 把 config.budget.window5hLimit 设为 300000 后，refreshBudget / budgetTripped 行为不变。
```

**建议修法**

- 接线：`refreshBudget` 里用 `sumTokenUsageSince(now-5h)` 与 `window5hLimit` 比较并置 `budgetTripped`（与日线共用熔断路径）；或明确标为 reserved-only 并从用户文档移除。

---

### L-4 A3/A1 短任务（< `sampleMs`）完全不记 token，其余任务最多滞后一个采样周期

**位置**

- `src/task/worker.js:258-262`：首个采样定时器要等 `sampleMs`（默认 5s）才触发
- `src/task/worker.js:235-243`、`:294-296`：`lastTokens` 只由采样更新，`finish` 直接用它
- `src/task/worker.js:144-147`：`tokensIn` 为 0 时不带出
- `src/runtime/tools.js:182-190`：`reportTaskUsage` 对 `tokensIn<=0` 返回 false，不落账

**现象**

5 秒内完成的任务 `tokensIn` 恒为 0，A1 的 `task` 来源不会产生任何行；5 秒以上的任务至少低估最后不到 5 秒的用量。`probe10` 的短任务场景只验证提醒逻辑，未覆盖记账，但代码路径是确定的。

**最小复现**

```js
// fake platform：createSession 立即成功，prompt 立即 resolve，whenIdle 立即 resolve，
// measure() 返回 { totalTokens: 1000 }；sampleMs=5000。
const result = await runTask({ platform, task: { prompt: 'x' }, sampleMs: 5000 });
// result.tokensIn === undefined（finish 时 lastTokens 仍为 0），reportTaskUsage 返回 false。
```

**建议修法**

- `finish()` 里先同步 `measure(session)` 取一次最终值（失败则忽略），再 resolve；这样短任务也能拿到累计 tokens，长任务的滞后也收敛到最后时刻。

---

### L-5 A4 `UNTIL` 纯日期按 UTC 23:59:59 解释，展示也用 UTC 日期

**位置**

- `src/scheduler/recurrence.js:72-77`：`YYYYMMDD` → `utcSeconds(..., 23, 59, 59)`
- `src/scheduler/recurrence.js:530-531`：`至 ${new Date(rule.until * 1000).toISOString().slice(0, 10)}`

**现象**

配置时区为 `America/New_York` 时，`UNTIL=20261113` 实际截止到当地 11-13 18:59:59（EST），当天 19:00 之后的提醒会被截断；`/状态` 展示的日期在 UTC 与本地不同日时也会差一天。RFC 5545 的 `UNTIL` 本身是 UTC 语义，但工具描述与文档没有说明「纯日期按 UTC 当天末」这一层，用户容易按本地日期理解。

**最小复现**

```js
parseRRule('FREQ=DAILY;UNTIL=20261113')            // until = 2026-11-13T23:59:59Z
// America/New_York 的 20:00 本地提醒 = 次日 01:00Z > until → 被截断
// formatRRule(...) 用 toISOString().slice(0,10) 展示，纽约 11-13 20:00 的序列会显示 11-14
```

**建议修法**

- 在工具描述/文档里明确「纯日期按 UTC 当日 23:59:59；要按本地日请用带 `Z` 的完整时间」；或把纯日期解释为配置时区当天末（需要与 RFC 兼容性权衡后在文档说明）。

---

### L-6 A1 `/状态` 的缓存命中数没有单位

**位置**

- `src/runtime/commands.js:576`：`` `｜缓存命中 ${cacheHit}` ``

**现象**

同一行前面是 `今日用量：1234 tokens（…）｜缓存命中 567`，567 没有 `tokens` 单位；纯展示问题。

**最小复现**

```js
formatTokenUsageLine({ total: 1234, cacheHit: 567, sources: [{ source: 'main', total: 1234, share: 1 }] });
// → '今日用量：1234 tokens（主会话 100%）｜缓存命中 567'（末尾缺单位）
```

**建议修法**

- 改为 `｜缓存命中 ${cacheHit} tokens`，并在 `test/v0413-token-ledger.test.js` 的格式断言里同步。

---

## 二、硬点核实清单（逐条）

### 1. 三时区测试全绿

命令（每个时区独立进程）：

```powershell
cd D:\test\agent-plugin\dsh-companion
$node = 'C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$env:TZ = ''            # 默认
& $node --test
$env:TZ = 'UTC'
& $node --test
$env:TZ = 'America/New_York'
& $node --test
```

实测（三份日志：`D:\test\agent-plugin\_r24\test-__default__.log`、`test-UTC.log`、`test-America_New_York.log`）：

| 时区 | tests | suites | pass | fail | skipped | cancelled | 耗时 | exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 默认（未显式设置 TZ） | 1407 | 51 | 1407 | 0 | 0 | 0 | 7503 ms | 0 |
| UTC | 1407 | 51 | 1407 | 0 | 0 | 0 | 7440 ms | 0 |
| America/New_York | 1407 | 51 | 1407 | 0 | 0 | 0 | 7460 ms | 0 |

### 2. schema v14 → v15 迁移

探针 `probe2-schema.mjs`（20/20）：只用 `test/fixtures/schema-v14.sql` 造库，过滤 FTS5 影子表（`/^CREATE TABLE 'fts_(facts|episodes)_/`，否则 SQLite 报 `object name reserved for internal use`），插入旧事实（`recall_count=7`）、旧 `fact_vectors`、旧 `episodes` 与 v14 合法 `memory_events(ADD)`，再用当前 `Store.open` 打开。

核实结果：

- `SCHEMA_VERSION='15'`；`schema_meta.schema_version='15'`；
- `facts` 新增 `used_count` / `injected_count` / `unused_streak`；
- 回填 `used_count = recall_count = 7`，`injected_count=0`、`unused_streak=0`；
- `fact_vectors` 仍为 1 行（关 FK 重建 `facts` 时没有被级联清空）；
- `PRAGMA foreign_keys=1`；`integrity_check=ok`；`foreign_key_check=[]`；
- `facts.kind` 含 `lifestyle` / `mood` / `other`；`memory_events` CHECK 含 `govern`/`EDIT`/`scrub`，旧 `ADD` 行保留，迁移后 `appendEvent({action:'EDIT'})`、`{action:'scrub'}` 直接成功；
- `token_usage` 表已建；
- 重复 `Store.open` 幂等：version 仍 15、`used_count` 仍 7、`fact_vectors` 仍 1、FK 仍 1、`memory_events` 行数不变（4 行；首次迁移时因有 episode 写了一条 `scrub` 审计，空库路径只写 `episode_scrub_v13` 标记不写事件）；
- 额外补测（`probe12-fts.mjs`）：迁移前写入的 facts FTS bigram 投影在迁移后仍可被 `store.searchBigram('黑咖啡')` 命中（rowid 保留），`PRAGMA foreign_keys=1`。

### 3. 情绪/人格逐字节基线

探针 `probe3-persona.mjs`：用 `git worktree add --detach D:\test\wt-r24 v0.6.1`（`1fdfcbd`）对照，分别 import 当前树与 v0.6.1 树的 `buildSections` / `buildChatPrompt`，输入相同（`DEFAULT_CARD`；`buildChatPrompt` 带 `recentTopics`、`recallSummary`、`messageCount=8`；以及裸卡片），对输出做 SHA-256。

两侧结果完全一致：

| 输出 | SHA-256 |
| --- | --- |
| `buildSections(DEFAULT_CARD)` 文本 | `e55e987368a77df2153a8126ea99666173b69620de9e072d2b0afbef70f07a83` |
| `buildSections` JSON | `1955a6b3058f1efcf6b01cd248575c69fce38a0bcb46c6b020dd18a63e4e1f06` |
| `buildChatPrompt`（带上下文，232 字符） | `fc8d490c630ecc7b61af51d3fbb1dc88c85fafc1725b3610c00934026dd1c560` |
| `buildChatPrompt`（裸卡片，186 字符） | `b720a39d452e332c7cf7ade0888c757d1b9864e9b97f03b4750d9ba92a0825b2` |

`git diff --name-only 31cf454..HEAD` 过滤 `emotion|persona|prompt` 只命中两个测试文件，未发现 `src/persona/*` 或情绪实现被改。

### 4. A2 额度文件与 `deferBackground`

探针 `probe4-quota.mjs`（34/34）覆盖 `readQuotaFile` / `parseQuotaSnapshot` / `evaluateQuota` / `formatQuotaLine` / `backoffAfter429` / `deferBackground` / `isQuotaError`：

- `updatedAt=now-900s` → `state='ok'`（恰好 15 分钟仍新鲜）；`now-901s` → `state='stale'`、`paused=false`、`line='额度：快照过期（updatedAt 超过 15 分钟），按不限处理'`；缺 `updatedAt` → `updatedAt=null` → stale；
- 缺 `resetAt` → 读取成功，`evaluation={state:'tight',paused:true,resumeAt:null}`，`line='额度紧张，后台暂停（5h 剩余 10%）'`（无「至」）；
- 显式 `resetAt:null` / `updatedAt:null` → `{ok:false, reason:'snapshot_invalid:invalid_snapshot'}`（见 M-2）；
- 坏 JSON → `read_failed`；缺文件 → `file_missing`；空 `windows` → `snapshot_invalid`；`nowMs=NaN` → `now_invalid`；无 `path` → `path_missing`；
- 比例恰好 0.3 → tight；0.301 → ok；多窗口 `resumeAt` 取紧张窗口最早的 `resetAt`（**秒**）；未知窗口名忽略；
- `deferBackground({paused:true, trigger:'hard'}) === false`（**hard 必须放行**，通过）；`idle`/`threshold` → true；`paused=false`/`undefined` → false；
- `isQuotaError` 认 `HTTP 429`、`rate limit exceeded`、`insufficient quota`、`insufficient_quota`、字符串 `'gateway: 429'`；`'tool exploded'`/`null` 为 false；
- 429 退避：有未来 `resetAt` 用它（`retryAt=resetAt*1000`，attempt 不变），否则 `2**attempt` 分钟（+1 attempt，上限 60 分钟）。

另用 `probe11-quota-null-reset.mjs`（3/3）在真实 `apply()` + pre-step 上复现 M-1：额度紧张且无 `resetAt` 时后台巩固仍执行。

### 5. A4 系列 DST 与停机补投

探针 `probe5-series.mjs`（14/14）：

- 秋退（`America/New_York`，DAILY 本地 01:30）：`10-31 01:30` offset `-4` → `11-01 01:30` offset `-4`（歧义取较早）→ `11-02 01:30` offset `-5` → `11-03 01:30` offset `-5`，严格递增、本地时刻不漂移；
- 春进（DAILY 本地 02:30）：`2027-03-13 02:30 -5` → `2027-03-14 03:30 -4`（缺口向后归一）→ `03-15 02:30 -4` → `03-16 02:30 -4`；
- 停机错过 3 次：anchor `2027-01-01 09:00 EST`、`afterAt=anchor`、`nowAt=anchor+3d1h` → `nextFireAt=anchor+4d=1799157600`、`missed=3`、`seriesIndex=4`（**只补最近一次**，通过）；
- 迟到 3h 投递不重锚：`next=anchor+1d`；
- `COUNT=2` → 第二次后 `exhausted:true`、`missed=0`；
- `WEEKLY;BYDAY=MO 09:00` → `2027-03-15 09:00 -4`。

另用 `probe10-rrule-kind.mjs`（5/5）发现 M-3。

### 6. A5 过期提醒去重与重启

探针 `probe6-expired.mjs`（11/11，使用测试里的 source-less 消息）：

- 注入文本：`有 N 条提醒未能按时送达：\n- 交房租（原定 01-15 14:00）`；`source.kind='companion-expired'`；
- 同一 `turnKey` 第二次 pre-step → `null`；
- 关闭并重开 `Store`（模拟重启）→ 仍 `null`，`expired_notified_at` 已持久化（`1800000000`）；
- `buildExpiredNotice([])===''`；只有信封（`<dsh_im_…>`）时 `null`；新插入另一条 expired 提醒时只通知新行。

**但真实用户消息形状下不会注入**——见 H-1 / `probe9-a5-source.mjs`（3/4）。

### 7. A6 压缩迟滞纯逻辑

探针 `probe7-compact.mjs`（12/12），参数 `floor=20000`、`compactAtTokens=24000`、`minIncrement=4096`、`overCount=2`、`cooldownTurns=3`：

- `tokens=23000` → `null`（低于阈值）；
- `tokens=24500` → `threshold`；
- `tokens=24096` → `threshold`（`>= floor+minIncrement` 边界）；`24095` → `null`；
- `turnsSinceThreshold=1/2` → `null`；`3` → `threshold`；
- `hard`（40000）→ `hard`，不受 floor/cooldown 限制；`idle` 场景 → `idle`；`hard` 优先于 `idle`；
- `floorTokens=null` 时不设增量门槛；`overCount=1` 时不触发。

接线层另有 L-1（冷却持久化死键、按 pre-step 计数）。

### 8. A7 信封判定

探针 `probe8-envelope.mjs`（10/10）：

- 正文 + 信封 → `lastUserText` 返回正文；信封在前、正文在后 → 正文；只有信封 → `''`；
- `source={kind:'plugin:dsh-im', form:'notice'}` 即使正文**没有** `<dsh_im_` 前缀也被跳过（符合 A7 文档 `docs/usage-v0413.md:102-108`）；
- 裸块形式（无 source、以 `<dsh_im_` 开头）被跳过；
- `<dsh_im_` 出现在句中不会被误判。

---

## 三、测试自证点名

以下用例的断言与实现同源，或没有模拟线上形状；其中前两条直接决定了缺陷没被仓库测试发现：

1. **`test/v0413-expired-notice.test.js:43-49`**：`userMessages` 不带 `source`。线上形状是 `{source:{kind:'user'}}`（`docs/platform-api.md:25`、`test/v0413-envelope.test.js:44`），所以 A5 的 11/11 全绿与真实行为相反——**H-1 的直接原因**。
2. **`test/v0413-series.test.js:58-68`**：用例名写「WEEKLY … 跨 DST 不漂移」，实际 `rrule='FREQ=DAILY'`，且 `anchor=2026-10-26`、`next=2026-10-27` 都在 11-01 秋退之前，根本没跨过转换；断言 `anchor + 86400` 在真正的秋退日会失败。真正的 DST 覆盖只在 `probe5`。
3. **`test/v0413-recur.test.js:27-33`**：`expectedFirst` 用被测的 `parseRRule`/`nextOccurrence` 计算期望值，等于用实现验证实现；`:60` 有硬编码周一日期兜底，但主断言仍是自证。
4. **`test/quota.test.js:99`、`:102`**：把「显式 `null` 判非法」锁成契约；`:387` 的「tight 但缺 resetAt 不写暂停时间」只用 `snapshotOf` 手工对象，文件路径永远到不了。没有 `refreshQuota`/`quotaPaused` 接线测试，因此 M-1/M-2 均未被发现。
5. **`test/v0413-compact.test.js`**：只测 `planConsolidation` 纯函数（13 例），没有 pre-step 计数器、`compact_threshold_turns` 持久化、`compact_floor` 接线的测试；L-1 因此处于未覆盖状态。
6. **`test/v0413-worker-tokens.test.js:135`**：用被测的 `wrapUpPrompt()` 算期望 prompt；`:136` 同时有「剩余预算约 19999 tokens」字面量兜底，影响有限，但仍属同源断言。
7. **`test/store-v15.test.js:198`**：`assert.equal(SCHEMA_VERSION,'15')` 用实现常量做期望值；`:199` 另有一条字面量 `'15'` 兜底，故影响较小，记在此备查。

---

## 四、门禁

```powershell
cd D:\test\agent-plugin\dsh-companion
$node = 'C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/probe/run-headless.mjs --plugin --timeout 180000
```

末行：

```text
plugin-gate: PASS (round A + round B + round C)
```

- round A（smoke）`exit=1`、`schedulerStarted=true`、`didNotActivate=false`，gate 判定通过；
- round B（recall）`exit=1`、`recallCrash=false`、`firstReneedAt=1794555028`，gate 判定通过；
- round C（consolidation）无凭据：`verdict=skip credentials=missing, consolidations=0, tokenEvents=1, maxTokensIn=0`，输出 `round C SKIPPED` 后仍汇总为 PASS（SKIP 符合约定）；
- 日志：`D:\test\agent-plugin\dsh-companion\.data\plugin-gate.log`；本次捕获：`D:\test\agent-plugin\_r24\gate.log`。

---

## 五、复审范围与已核实的其它项

**范围**：`git log 31cf454..HEAD --oneline` 共 26 个提交，覆盖 A1–A8、B1/B2、D-2/D-3。重点文件：

`src/index.js`（+497）、`src/memory/store.js`（+735）、`src/config.js`（+288）、`src/memory/consolidate.js`（+239）、`src/scheduler/recurrence.js`（+535）、`src/runtime/quota.js`（+435）、`src/runtime/quota-gate.js`（+76）、`src/runtime/token-ledger.js`（+121）、`src/task/limits.js`（+172）、`src/task/worker.js`（+230）、`src/reminder/expired-notice.js`（+112）、`src/scheduler/series.js`（+75）、`src/runtime/commands.js`（+102）、`src/runtime/tools.js`（+73）、`src/memory/govern.js`（+46）、`src/memory/retrieve.js`（+10）、`src/task/run.js`（+63）。

**A1 已核实**：

- `normalizeUsage` 对 input/output/cacheHit 的 clamp、`cacheHit <= input`、`totalTokens` 回退；`usageRow` 的 `dayKey`/`peak`（本地 00:30–08:30 为 offpeak）；
- `aggregateTokenUsage` 的 `total=input+output`（cacheHit 是 input 子集，不重复计）、按 total 降序、4 位 share；
- `store.recordTokenUsage` 的 dayKey/枚举/非负校验；`sumTokenUsageSince` 的 `at >=` 口径；
- 五个生产写入点与 `recordUsage` 的 per-session baseline（turn-stopping 与 pre-step 共用基线，不双计）；
- 429 退避与 `quotaBackoffAttempt` 上限（60 分钟）。

**A3 已核实**：

- `nextStage` 的 stop 终态、`stopAt > warnAt` 校验、wrap-up 只投一次；`classifyWorkerOutcome` 的优先级（cancelled > token_limit > timeout > completed）；
- `mergeReceiptStatus` 返回新对象、completed 清空 reason；`run.js` 的 `partial` 映射、`TOKEN_LIMIT_NOTE`、回执 `部分完成`；
- 两段式 `cancelTask`；`tokensIn` 仅有限正数才带出。

**A8 已核实**：

- `markFactsUsed` / `bumpFactInjected` 的 SQL 与 `active AND deleted_at IS NULL` 条件；`noteInjectedFacts` 的旁路 try/catch；
- `retrieve.js:616-627` 的 `unused_streak` 阈值/惩罚（config `normalizeRecall` 校验 1..100 与 0..1）；
- `planConsolidation` 的 floor/cooldown 条件；`selectExistingFactsFromRegion` 对召回快照/压缩摘要的跳过（V4-L2 有意为之，不判缺陷）；
- `normalizeDraft` 的 `episode=null`、`supersedes` 字符串校验、空草稿拒绝；事务内 `superseded_by` 的 scope/active 约束；
- `govern.js:271-276` 的 `used_count ?? recall_count` 比较；D-2 去掉 PRAGMA 绕过；D-3 的 `transcriptByScope`。

**B1/B2 已核实**：

- B1：`#scrubLegacyEpisodes` 空库只写 `episode_scrub_v13` 标记、不写审计事件；重复打开跳过；probe2 覆盖。
- B2：`threadSlotFallback` / `threadSlotTimeout` 指标与 `/线程` 的「线程槽 兜底 N·超时 M」展示；`test/v0413-slot-counters.test.js` 3 例覆盖 0/兜底/仅兜底；未发现缺陷。
- A7：`isPluginNotice` 与 `lastUserText` 的规则、10/10 探针；A5 应复用它而不是另造一套（H-1 的修法）。

---

## 六、建议修复顺序

1. **H-1**：修 `lastUserTextOf` 的 source 过滤，补真实形状测试；同时把 `turnSeen.add` 后移到可注入判定之后。
2. **M-2 / M-1**：先让显式 `null` 合法（否则最常见写法直接丢快照），再补 `resumeAt=null` 的兜底暂停；一起加一条「文件 → refreshQuota → 后台是否执行」的接线测试。
3. **M-3**：`reminder_add` 在 `rrule` 出现时自动 `kind='repeat'` 或显式拒绝；补工具级 + 投递级测试。
4. **L-1 / L-2 / L-3**：清理死键并统一文档口径（冷却持久化、embedding 是否接线、`window5hLimit` 是否生效）；这三项会直接影响用户对 A1/A6 的预期。
5. **L-4 / L-5 / L-6**：任务收尾补一次 measure、`UNTIL` 语义写清、缓存命中单位。

---

## 七、探针与日志索引

| 探针 | 覆盖 | 结果 |
| --- | --- | --- |
| `_r24/probe2-schema.mjs` | v14→v15 迁移、幂等 | 20/20 |
| `_r24/probe3-persona.mjs` | 人设字节基线 | 4 个哈希一致 |
| `_r24/probe4-quota.mjs` | 额度纯逻辑 + 文件读取 + 退避 | 34/34（另记录 M-2 行为） |
| `_r24/probe5-series.mjs` | DST、missed、COUNT、BYDAY | 14/14 |
| `_r24/probe6-expired.mjs` | A5 去重/重启（source-less 形状） | 11/11 |
| `_r24/probe7-compact.mjs` | A6 纯逻辑 | 12/12 |
| `_r24/probe8-envelope.mjs` | A7 信封判定 | 10/10 |
| `_r24/probe9-a5-source.mjs` | A5 真实消息形状 | 3/4（暴露 H-1） |
| `_r24/probe10-rrule-kind.mjs` | A4 `rrule` + 默认 kind | 5/5（暴露 M-3） |
| `_r24/probe11-quota-null-reset.mjs` | A2 接线（无 resetAt） | 3/3（暴露 M-1） |
| `_r24/probe12-fts.mjs` | 迁移后 FTS 检索 | 通过 |

测试日志：`_r24/test-__default__.log`、`_r24/test-UTC.log`、`_r24/test-America_New_York.log`；门禁：`_r24/gate.log`。

---

## 9. 复审（r2，对象 2a48024）

- 复审对象：`2a48024`（`feat/v0413`），未 push；r1 报告为 `1ffaff0`，修复提交为 `e04f407`（H-1/M-1/M-2/M-3）与 `2a48024`（L-1..L-6）。
- **结论：needs_revision。H = 0，M = 1，L = 0。** r1 的 H-1、M-1..M-3 与 L-2..L-6 均已闭环；L-1 只完成“按新轮计数 + 持久化”，但“阈值压缩成功后归零”仍未生效，构成 1 个 M。
- 可发版判断：暂缓。补上 §9.1 的 M-1 并加一条集成测试后即可转 pass；其余改动已具备发版条件。

### 9.1 必须修项（r2，M）

**M-1（对应 r1 的 L-1）：threshold 冷却计数永不归零，`recordCompactionFloor` 的重置分支不可达**

- 位置：
  - `src/state/pending-compact.js:32-37`：`setPendingCompact` 只保留 `id/startSeq/endSeq/scope`，把 `trigger` 丢掉；
  - `src/index.js:2682-2687`、`src/index.js:4216-4221`：两处 `setPendingCompact(...)` 都没有传 `trigger`；
  - `src/index.js:3081`：`recordCompactionFloor(state, payload, scope, pending.trigger)`，实际拿到的永远是 `undefined`；
  - `src/index.js:3006-3013`：`if (trigger === 'threshold')` 才把 `thresholdTurnsByScope` 和 `schema_meta.compact_threshold_turns:<scope>` 归零，该分支不可达。
- 现象：threshold 巩固成功后，`compact_threshold_turns:<scope>` 不会被写成 `'0'`；计数只增不减。重启能读回计数（L-1 的“持久化”部分成立），但此后该 scope 的 `turnsSinceThreshold` 恒大于 `cooldownTurns`，冷却不再限制下一次 threshold 巩固（剩余约束只有 `minIncrementTokens`/floor）。
- 最小复现（直接）：
  ```bash
  cd D:\test\agent-plugin\dsh-companion
  & "C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --input-type=module -e "import('./src/state/pending-compact.js').then(m=>{const map=m.createPendingCompacts();m.setPendingCompact(map,{id:'c1',startSeq:10,endSeq:20,scope:'main',trigger:'threshold'});console.log(m.peekPendingCompact(map,'main'))})"
  # 实际输出：{ id: 'c1', startSeq: 10, endSeq: 20, scope: 'main' }   —— trigger 丢失
  ```
  `_r24/probe20-r2-pending-trigger.mjs` 复验输出 `trigger preserved = false`。
- e2e 观察：`_r24/probe14-r2-cooldown.mjs` 两轮 threshold 巩固后，`compact_threshold_turns:main` 实际为 `'5'`（不是 `'0'`）；重启后 turn4 就出现第 2 条 nap 行（若正常在 turn3 归零，应 turn5 才出现）。`_r24/probe21-r2-cooldown-exact.mjs` 另验证了计数本身：同一 turn 的第二次 pre-step 不推进（4→4），新 turn 推进（4→5→6），说明“按新轮计数”已生效；失败只在“成功后归零”。
- 测试缺口：`test/v0413-compact.test.js` 仍只测 `planConsolidation` 纯函数，没有“巩固成功后 meta=0 / 重启后 N 轮内不再压”的集成用例；这就是该残留没有被测试发现的原因。
- 建议修法（二选一，推荐 1）：
  1. 在 `executeConsolidationJob` 成功分支（`src/index.js:2682` 附近）判断 `job.trigger === 'threshold'`，直接 `state.thresholdTurnsByScope.set(scope, 0)` 并 `store.setMeta('compact_threshold_turns:' + scope, '0')`；
  2. 或把 `trigger` 纳入 pendingCompact 形状（`src/state/pending-compact.js:32-37`），两处调用分别传 `job.trigger` 和 `null`，保留 `recordCompactionFloor` 里的重置。
  并加集成测试：两轮触发 threshold→断言 meta 为 0→重启后再压需等满 `cooldownTurns`。

### 9.2 修复项逐条复验（r2）

| 修复 | 复验方式 | 结果 |
| --- | --- | --- |
| H-1（A5 宿主形状） | `_r24/probe9-a5-source.mjs` 6 例：`source:{kind:'user'}` + rpcId、无 source、仅信封、尾部 companion-expired | 6/6；宿主正文注入 1 条，仅信封不注入，去重仍生效 |
| M-1（无 resetAt 暂停） | `_r24/probe11-quota-null-reset.mjs` + `_r24/probe19-r2-quota-retry.mjs`（t0、+30s、+61s 三轮） | 3/3 + 3/3；t0/+30s/+61s 均被挡 |
| M-2（显式 null） | `_r24/probe13-r2-quota.mjs` 19 例 | 19/19；`resetAt:null` 与缺键等价且 tight/paused，`updatedAt:null` 按缺失→stale，坏类型仍 invalid |
| M-3（rrule 系列） | `_r24/probe10-rrule-kind.mjs` 7 例 | 7/7；`todo`+`rrule` 经 `reminder_add` 后强制 `repeat`，首投后 `next_fire_at=+86400`、`series_index=1` |
| L-1（计数/持久化） | `_r24/probe21-r2-cooldown-exact.mjs` + `_r24/probe14-r2-cooldown.mjs` | 计数按新轮（4→4→5→6，首次从 fallback 3 起算）且重启可读回；但“成功后归零”失败，见 M-1 |
| L-2（文档口径） | 读 `docs/usage-v0413.md:12-20,54-58,62-68` | 五类已接线、`embedding`/`thread` 未入账已明示；window5h 与 UNTIL 语义已更新 |
| L-3（window5hLimit） | `_r24/probe18-r2-window-budget.mjs` 5 例（真实 apply + task_run 闸门） | 5/5；近 5h 1500 触发 `daily_budget_exceeded`，400 放行，6h 前 1500 不计入，无窗口线放行，恰好 1000 触发 |
| L-4（短任务入账） | `_r24/probe17-r2-worker-tokens.mjs` 8 例 | 8/8；无周期采样时终值 `tokensIn=4321`，无 meter/measure 抛错均 fail-open |
| L-5（UNTIL 时区） | `_r24/probe15-r2-until.mjs` 15 例（UTC/NY/Asia_Shanghai） | 15/15；当地日末语义、`20260230` 拒绝、显式 `Z` 仍按 UTC |
| L-6（缓存命中单位） | `_r24/probe16-r2-format.mjs` 6 例（真实 `/状态`） | 6/6；输出 `｜缓存命中 6789 tokens` |

### 9.3 r2 全量复跑数字

- `node --test` 三时区：默认 / `UTC` / `America/New_York` 各 **1409 tests / 51 suites / 1409 pass / 0 fail / 0 cancelled / 0 skipped**，exit 0；耗时 7197.97 / 7213.44 / 7466.09 ms。日志：`_r24/r2-test-default.log`、`_r24/r2-test-UTC.log`、`_r24/r2-test-NY.log`（HEAD `2a48024`）。
- v14→v15 迁移：`_r24/probe2-schema.mjs` **20/20**。仍断言 `schema_version=15`、`recall_count=7 → used_count=7`、`fact_vectors` 未被删、`PRAGMA foreign_keys=1`、`integrity_check=ok`、重复打开幂等；`_r24/probe12-fts.mjs` 复验迁移后 FTS 仍命中。
- 人设字节基线：`_r24/probe3-persona.mjs` 与 `v0.6.1`（`1fdfcbd`）逐字节一致，4 个 SHA-256 均不变（`e55e9873…`、`1955a6b3…`、`fc8d490c…`、`b720a39d…`）。
- 门禁：`plugin-gate: PASS (round A + round B + round C)`；round B `exit=1 firstReneedAt=1794559482`；round C `verdict=skip credentials=missing consolidations=0 tokenEvents=1 maxTokensIn=0`。日志：`_r24/r2-gate.log`、`.data/plugin-gate.log`。
- 探针汇总：probe2 20/20、probe3 4 哈希一致、probe9 6/6、probe10 7/7、probe11 3/3、probe13 19/19、probe15 15/15、probe16 6/6、probe17 8/8、probe18 5/5、probe19 3/3；probe14 2/4、probe21 0/5 的失败项是探针期望问题（均指向 §9.1 M-1，probe21 还因 session 事件不足未触发 region），probe20 直接复现 `trigger` 丢失。

### 9.4 测试自证复核（r2）

- §三 点名的 7 条在 r2 仍成立（未新增同源自证）。
- r2 新增测试用的是字面量契约，不是拿实现算期望：`test/quota.test.js:115-122`（显式 null）、`test/v0413-expired-notice.test.js:88-98`（宿主 `source.kind='user'`）、`test/recurrence.test.js`（UNTIL 三种时区均写死 UTC 期望）。
- 唯一新增覆盖缺口：L-1 的“成功后归零”没有集成测试（`test/v0413-compact.test.js` 仍只测纯函数），与 §9.1 的 M-1 对应。

### 9.5 建议

1. 修 §9.1 M-1，并在 `test/v0413-compact.test.js` 或 e2e 加一条“threshold 成功后 meta=0 + 重启后冷却生效”的用例。
2. 其余项无需改动；修完重跑三时区与门禁即可给 pass/可发版结论。

---

## 10. 复审（r3，对象 a5601b4）

- 复审对象：`a5601b4`（`fix(v0413): reset threshold cooldown after success`，分支 `feat/v0413`，未 push）。
- **结论：pass。H = 0，M = 0，L = 1（文档注释）。** r2 的 M-1 已按推荐方案闭环；无阻断/重要问题，**可发布 v0.7.0**。
- L-1 为非阻断项：`src/index.js:2976-2984` 的 JSDoc 仍写着“记录实测水位并（对 threshold 触发）重置冷却计数”，并声明 `payload`/`trigger` 参数，但这段注释现在挂在 `resetThresholdCooldown(state, scope)` 上方，`recordCompactionFloor` 反而没有注释。建议把原注释移回 `recordCompactionFloor`，给 `resetThresholdCooldown` 补两参数说明；不需要为此重跑。

### 10.1 修复实现核对

- 新增 `resetThresholdCooldown(state, scope)`（`src/index.js:2985-2992`）：清 `state.thresholdTurnsByScope` 并写 `schema_meta` 的 `compact_threshold_turns:<scope>='0'`；写失败只吞掉，不影响压缩流程。
- 成功路径（`src/index.js:2690`）在 `setPendingCompact`（`:2682-2687`）之后、`setWatermark`（`:2691`）之前，按 `job.trigger === 'threshold'` 归零；不再依赖 `pendingCompact.trigger`。
- trigger 传递链已核对：`scheduleConsolidation` 的 `plan.trigger`（`:2487`）→ `pendingConsolidation.trigger`（`:2504`）→ `runConsolidationJob` 的 `job`（`:2530-2535`）→ `executeConsolidationJob` 的 `job.trigger`（`:2690`）。重试任务用 `{...job}`（`:2771`）保留 trigger，重试成功也会归零。
- `recordCompactionFloor` 签名为 `(state, payload, scope)`（`src/index.js:2994`），唯一调用点 `src/index.js:3085` 已同步；全仓库无其它调用点，旧的 `trigger === 'threshold'` 分支已删除。
- `pendingCompact` 仍不保存 trigger（`src/state/pending-compact.js:32-37`），但归零已移到 `job.trigger`，这条路径不再被依赖；属于可接受的设计取舍，不再构成 M。

### 10.2 原缺陷复验（成功归零 + 重启）

- 新增集成测试 `test/e2e/compact-cooldown.test.js`：13K tokens / `compactAtTokens=12000`，两轮后等水位推进，断言 `compact_threshold_turns:main === '0'` 且只有 1 条 nap；重启同一库后第 1/2 轮断言 nap 仍为 1、meta 依次为 `'1'`/`'2'`。20/20 targeted 全绿（含本文件、`test/v0413-compact.test.js`、`test/e2e/apply-turn.test.js`）。
- 自有探针 `_r24/probe14-r2-cooldown.mjs`：**4/4**。输出：`counter persisted as 0 after threshold :: meta=0`、`restart respects persisted cooldown (2 turns -> no compaction) :: napRows=1`、`third new turn after restart compacts :: napRows=2`（r2 时同一探针为 2/4、meta='5'）。
- 归零发生在 `setWatermark` 之前，测试以水位为同步点，不存在“先看到水位再看到归零”的竞态。

### 10.3 全量回归

- `node --test` 三时区：默认 / `UTC` / `America/New_York` 各 **1410 tests / 51 suites / 1410 pass / 0 fail / 0 cancelled / 0 skipped**，exit 0；耗时 7380.759 / 7291.8577 / 7501.5871 ms。日志：`_r24/r3-test-default.log`、`_r24/r3-test-UTC.log`、`_r24/r3-test-NY.log`（HEAD `a5601b4`）。
- targeted：`compact-cooldown` + `v0413-compact` + `e2e/apply-turn` 共 20 tests / 3 suites / 20 pass / 0 fail（748.3862 ms），`_r24/r3-targeted.log`。
- v14→v15 迁移 `_r24/probe2-schema.mjs` 仍 **20/20**；FTS 复验 `_r24/probe12-fts.mjs` 仍命中 `f1`、FK=1；人设 `_r24/probe3-persona.mjs` 与 `v0.6.1` 仍逐字节一致（4 个 SHA-256 不变）。
- 门禁：`plugin-gate: PASS (round A + round B + round C)`；round B `exit=1 firstReneedAt=1794560350`；round C `verdict=skip credentials=missing consolidations=0 tokenEvents=1 maxTokensIn=0`。日志：`_r24/r3-gate.log`、`.data/plugin-gate.log`。

### 10.4 测试自证复核（r3）

- 新增 `test/e2e/compact-cooldown.test.js` 用字面量断言（`'0'`、`'1'`、`'2'`、nap 行数），期望值不是用实现函数现算的；没有新增自证测试。
- 该测试覆盖了“成功后归零 + 重启从 0 起算”的主路径；`probe14` 额外覆盖“重启后第三轮才再次压缩”，两者互补。

### 10.5 结论

- **pass（H=0 / M=0 / L=1 文档注释）**，可发布 v0.7.0。L-1 只是注释错位，建议随版本顺手修，不阻塞发版。
