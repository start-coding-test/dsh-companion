# v0.4.8 独立复审（review-v13）

- 复审人：reviewer（独立审查者，未参与 V5-L2 实现）
- 复审日期：2026-11-05
- 复审对象：v0.4.7 发布提交 `4478a1c` 之后、t3 集成回归后的 HEAD `4da8065`，含 3 个提交：
  `795f83d`（t1，schema v12 + retry_at 存储/调度，13 文件）/ `1024482`（t2，index 接线与状态板展示，9 文件）/ `4da8065`（t3，集成回归，仅新增 test/v048-regression.test.js）。
  三个依赖提交均在 HEAD 祖先链内。
- 复审方式：逐行读三个提交的 19 文件 diff（src 4 + test 15）、grep 全部 `next_fire_at` / `retry_at` 读写点逐处判定、读三份新测试与七份旧断言改写、亲跑三时区全量 `node --test`、`test/e2e/plugin-smoke.test.js` 与 `scripts/probe/run-headless.mjs --plugin`；确认 worktree clean、无 v0.4.8 tag、未 push（`main` ahead 3）。
- 结论：**verdict = pass**（H=0 / M=0 / L=2）。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议） | 2 | 见 §4，均不阻断发布 |

发布前置条件（H=0 且 M=0）满足，复审通过。

## 2. 逐项核验（任务卡必查项 → 证据）

### 1) schema v12：retry_at 列、DDL/重建/PRAGMA 迁移/export 版本一致、v11→v12 幂等 ✅

- **双 DDL 同步**：`SCHEMA_VERSION = '12'`（`src/memory/store.js:64`）；SCHEMA_SQL 的 reminders 新表含 `retry_at INTEGER`（`store.js:294`，位于 `next_fire_at` 与 `last_fire_key` 之间）；v10 整表重建路径（`#ensureRemindersDeliveryColumns` 重建 DDL，`store.js:1008`）同样含 `retry_at`——但重建仅在源表缺 `delivery_attempts` 列（v9 及更早）时触发，源表不可能已有 `retry_at`，重建不损失任何 retry 数据；重建后 `#ensureReminderOccurrenceColumn`（`store.js:1045-1052`）与 `#ensureReminderRetryColumn`（`store.js:1061-1068`）按 PRAGMA 逐列检测补列，幂等。
- **迁移入口顺序正确**：`migrate()` 先跑 SCHEMA_SQL 幂等建表 → `INSERT OR IGNORE schema_version='12'`（新库直接登记 12）→ `#migrateFrom` bump-only 分支把 `'11'` 与 6..10 并入同一 `UPDATE schema_meta`（`store.js:931-937`），随后统一补列（`store.js:779-783`）。升级路径整段包在 `BEGIN IMMEDIATE` 单事务（`store.js:774`），崩溃不留半迁移。
- **export 兜底版本同步**：`src/memory/export.js:86` `CURRENT_SCHEMA_VERSION = '12'`，与 SCHEMA_VERSION 一致（仅 schema_meta 缺失时的兜底）。
- **幂等实证**：`test/v048-retry-at.test.js:182-267`（v11 真实 DDL 旧库 → 升 12 → 旧行 retry_at NULL → COALESCE 回退 `next_fire_at=1` 正常到期 → claim/失败写退避/成功清空 → 重开仍 12）；`test/v048-regression.test.js:300-390`（v11 旧库经 `apply()` 迁移，含到点投递全链路）；v041/v045/v047/reneed/store/export 各迁移断言改写为 `'12'` 且幂等双重打开（`test/reneed.test.js:225-236` 等）。

### 2) next_fire_at 在任何失败路径都不被改写 ✅

store.js 中 `next_fire_at` 的全部写点只有两处 INSERT：`createReminder` 复用的插入（`store.js:1784-1798`，`INSERT INTO reminders (... next_fire_at, retry_at ...)`）与 v10 整表重建的数据回拷（`store.js:1022-1026`）；另有 `src/memory/consolidate.js:275/615`（新草稿酝酿的提醒创建，值来自模型草稿）与 `src/runtime/tools.js:375`（工具新建提醒）。**全部 9 条 `UPDATE reminders`（grep 逐条核对：occurrence 生成 `:1871`、claim `:1914`、成功 `:1941`、失败超限 `:1986`、失败退避 `:2006`、启动回收 recovered/expired `:2031/:2038`、expireReminder `:2066`、清 source_episode_id `:2832`）没有任何一条写 `next_fire_at`**。
失败退避现在只写 `retry_at`：`markReminderDeliveryFailed` 退避分支 `SET status='pending', retry_at=?`（`store.js:2004-2013`），退避 30/60/120s 由 `REMINDER_RETRY_BACKOFF_SECONDS` 按 `delivery_attempts` 取档（`store.js:1998-2003`）。用例锁死：`test/v048-retry-at.test.js:50/68/80`（三连失败后原定时间仍为 `ORIGINAL_FIRE`）、`test/v048-index-retry.test.js:134`、`test/v048-regression.test.js:131/147/161`、e2e/reminder-delivery 与 v045/v047 旧断言全部改写为「原定时间不变 + retry_at 退避」且逐值精确断言。

### 3) 调度 COALESCE 到期；成功/expired 清 retry_at ✅

- `dueReminders` 到期与排序均按 `COALESCE(retry_at, next_fire_at)`（`store.js:1828-1844`，排序也用它，重试项不会因原定时间早而抢队，`test/v048-retry-at.test.js:129-154` 锁死排序与未到期过滤）。
- `onAttempt` 二次守卫用 `max(next_fire_at, retry_at ?? 0)`（`src/index.js:3237-3243`），与 SQL 到期口径一致。
- 清空收口四路 + expire 全覆盖：成功 `markReminderDelivered`（`store.js:1941-1948`：occurrence/last_fire_key/retry_at 置 NULL、attempts=0）；失败超限 expired 分支（`store.js:1984-1996`）；`recoverReminderDeliveries` expired 分支（`store.js:2037-2046`）；`expireReminder`（`store.js:2064-2073`），全部 `retry_at = NULL`。启动 recovered 分支（`store.js:2029-2035`）保留 retry_at 是正确的：处于 delivering 的行其 retry_at 必为过去值（正是它触发了本次 claim），保留即立刻到期重试，无悬挂。
- 用例：`test/v048-retry-at.test.js:88-127`（成功/超限 expired 清空）、`:156-180`（recover-expired 与 expireReminder 清空）。

### 4) attempts 递增正确（含同 tick 双 flush）、fireKey 契约 ✅

- fireKey 改为调用方拼「发生时刻+本次重试时刻」：`src/index.js:3246` `fireKey = `${fresh.next_fire_at}:${fresh.retry_at ?? 0}``。`claimReminderDelivery` 仅在 `last_fire_key` 不同于新 key 时 `attempts+1`（`store.js:1917-1918` CASE），且 `WHERE status IN ('pending','snoozed')` 天然挡住同 tick 内已 delivering 的重复 claim。
- 每次**真**重试：退避后 retry_at 变化 → fireKey 变化 → +1。同 tick 双 flush：flush A 失败回 pending 并写 retry_at=now+30（未来）→ flush B 被 onAttempt 的 max 守卫拒绝在 claim 之前，不消耗 attempts、不留 delivering（`test/v048-index-retry.test.js:139-154` 四重断言：pending/attempts=1/prompt 数不变/delivering 数 0）。store 级：同 fireKey 重复 claim 不再加 1（`test/v048-retry-at.test.js:73-77`）。
- 用例：`test/v048-index-retry.test.js:179-203`（17:01 失败 → 17:01:30 到期重试 attempts=2、retry_at=+60s、原定时间不动）；t3 回归 `:111-187`（fail→fail→成功全链路 3 次 prompt 中 1 次成功送达，文本恒为「[提醒] 交房租」，requestId 全程同一）；`test/v047-occurrence.test.js` / v047-regression 旧「next_fire_at 被改写」断言全部改写为新语义且值域自洽（retry_at +60）。

### 5) 展示：原定时间 +「重试中，下次 HH:MM」，时区正确 ✅

- `mapReminder` 改为原定时间优先（`next_fire_at ?? due_at`，`src/memory/state-board.js:187-188`），`retry_at` 非空且 **> now** 才附「重试中，下次 HH:MM」（`state-board.js:190-198`；已过去/空/过期回收后不附注——`test/v048-index-retry.test.js:98-116` 两分支、`test/v048-regression.test.js:255-296` 退出重试后附注消失）；todo 与 schedule 两个区块共用 `mapReminder`（`state-board.js:231-239`）。
- 时区：`formatDay`/`formatClock` 新增 timeZone 参数（`state-board.js:86-107`），`renderBoard` 从 `input.timeZone` 取（缺省产品默认时区，`state-board.js:310-318`）；主路径 `runDeepSleep` 显式传 `now: Math.floor(now/1000)` 与 `config.timezone`（`src/index.js:2926-2928`）。`TZ=America/New_York` 全量套件全绿（重试标注用例对时区敏感）。不显示原定时间的时分、不显示 retry_at 的日期（`v048-index-retry.test.js:95` 反向断言）。

### 6) 亲跑验证与仓库状态 ✅

见 §3；worktree clean、无 tag、未 push 均亲自复核。

## 3. 亲跑验证

- 三时区 `node --test`（cwd=仓库根，无参自动发现）：
  - 默认 TZ：**815 pass / 0 fail**（tests 815, suites 16）
  - TZ=UTC：**815 pass / 0 fail**（suites 16）
  - TZ=America/New_York：**815 pass / 0 fail**（suites 16）
- `node --test test/e2e/plugin-smoke.test.js`：**4 pass / 0 fail**。
- `node scripts/probe/run-headless.mjs --plugin`：round A（smoke）/ B（recall）/ C（consolidation，缺模型凭据按设计 SKIP）全 PASS；scheduler started=true、didNotActivate=false、recallCrash=false、firstReneedAt 非空。
- `git status --porcelain` 无输出（复审前后两次复核，探针写入均在 .data/，无污染）；`git diff --check HEAD` 无输出；`git tag` 最新为 v0.4.7（无 v0.4.8）；`git log origin/main..HEAD` 恰为上述 3 个提交（未 push）；HEAD = `4da806551cc27a0c137843d0ec74b5f1c7b6021c`。
- 测试数闭环：v0.4.7 799 → t1 804（+5，v048-retry-at）→ t2 808（+4，v048-index-retry）→ t3 815（+7，v048-regression），与各阶段汇报一致，亲跑复核一致。

## 4. Low 清单（不阻断发布）

- **V48-L1**（低）：遗忘清洗/巩固触发的状态板重渲染仍按产品默认时区渲染重试附注。`src/memory/forget.js:141`、`src/memory/store.js:2280`（#renderBoardText）与 `src/memory/consolidate.js:622-627` 的 `renderBoard(...)` 均未传 `now`/`timeZone`，重试中的提醒会显示「重试中，下次 HH:MM」且 HH:MM 按 DEFAULT_TIMEZONE 而非 `config.timezone` 格式化，与主路径（`src/index.js:2926-2928`）可能相差数小时。属既有行为（v0.4.7 及以前所有状态板都按 DEFAULT_TIMEZONE 渲染日期，三处该口径未变），非本轮引入；但 v0.4.8 新增的可见 HH:MM 附注放大了该不一致。requiredFix：后续版本给三处调用统一透传 `config.timezone`（与 runDeepSleep 同法），或把时区解析下沉到 store/board 层。建议随下一个迭代顺手处理。
- **V48-L2**（低）：fireKey 拼接格式文档与实现可选形态不一致。`src/memory/store.js:1898` 示例写 `<next_fire_at>@<retry_at>`，实际接线用 `:`（`src/index.js:3246`），两份 v048 测试又各用 `@`（retry-at）与 `:`（index/regression）——fireKey 只要求「同一次尝试内字符串相等」，无格式契约，行为无影响。requiredFix：把 store.js JSDoc 示例改成与实现一致的 `<next_fire_at>:<retry_at>`，或注明「示例仅为拼法示意、格式由调用方自定」。纯文档精度问题。

## 5. 发布裁定

V5-L2 三项（retry_at 存储/调度、index 接线与防重计数、状态板展示）实现 + 测试 + 文档三处咬合：`docs/usage.md` 失败退避、requestId、schema_version 三段与新「展示口径」段均已更新并给出示例；README 增加 v0.4.8 变更摘要并把 v0.4.5 段的旧退避语义补了注。H=0、M=0，满足 v0.4.8 发布门，**建议发布提交**（package.json 0.4.7 → 0.4.8、CHANGELOG v0.4.8 条目、README「当前状态/用例数」行随发布提交刷新、tag v0.4.8、push，并入本复审文档）照例进行；当前 package.json 仍为 0.4.7、CHANGELOG 未动、README 仍标「v0.4.7 已发布 / 799 用例」，与上一轮 releasing 约定相同，属发布提交职责，不算缺陷。
