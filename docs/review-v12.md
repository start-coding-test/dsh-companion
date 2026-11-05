# v0.4.7 独立复审（review-v12）

- 复审人：reviewer（独立审查者，未参与 V6-M1/L1/L3 实现）
- 复审日期：2026-11-05
- 复审对象：v0.4.6（334b3de）之后、t3 集成回归后的 HEAD `cf831a5`，含 3 个提交：
  `da8396e`（V6-M1，schema v11）/ `3bc246f`（V6-L1/L3）/ `cf831a5`（集成回归，仅新增 test/v047-regression.test.js）。
  三个依赖提交（t1=da8396e、t2=3bc246f、t3=cf831a5）均在 HEAD 祖先链内。
- 复审方式：逐文件读三个提交的实现 diff 与三份新测试（v047-occurrence / v047-l1-l3 / v047-regression）及 c5-h1a、v046 断言改写、grep 交叉核对实现/文档/常量、亲跑三时区全量 `node --test` 与 plugin-smoke；确认 worktree clean、无 v0.4.7 tag、未 push（`main` ahead 3）。
- 结论：**verdict = pass**（H=0 / M=0 / L=0）。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议） | 0 | — |

发布前置条件（H=0 且 M=0）满足，复审通过。上一轮（review-v11）遗留的 L-1（`test/worker.test.js:80` `promptSource` 旧命名/缺 AbortSignal 断言）已随本轮修完：现为 `promptSignal` 且补了 `assert.ok(promptSignal instanceof AbortSignal)`（`test/worker.test.js:80-85`）。

## 2. 逐项核验（任务卡必查项 → 证据）

### V6-M1 提醒 requestId 按 occurrence 稳定、到点结束重置 attempts ✅

- **schema v11 双 DDL 同步**：`src/memory/store.js:57` 版本注释、`:287` 开始的 SCHEMA_SQL 与 `:987-1015` 重建表 DDL（`#ensureRemindersDeliveryColumns` 内）均含 `occurrence_key TEXT`；构建时 `:774-775` 在 delivery 列补齐后调用 `#ensureReminderOccurrenceColumn()`（`:1027-1040`，PRAGMA 逐列检测 + `ALTER TABLE ADD COLUMN`，幂等，新库命中「列已存在」）。旧行保持 NULL、惰性生成，不需要回填——与 `:916-919` 的迁移说明一致。
- **bump-only 分支**：`#migrateFrom`（`:921`）把 `'10'` 与 v6..v9 并入同一 `UPDATE schema_meta SET value SCHEMA_VERSION` 分支；`store.js:54-58` `SCHEMA_VERSION = '11'`，与 `src/memory/export.js:86` `CURRENT_SCHEMA_VERSION = '11'` 一致（兜底常量同步）。
- **occurrence 语义**：`store.ensureReminderOccurrence`（`store.js:1826-1847`）`UPDATE … SET occurrence_key = COALESCE(occurrence_key, ?)` 且 `WHERE status IN ('pending','snoozed') AND deleted_at IS NULL`，每次生成 `${at}-occ_<uuid>` 新 key 仅在 DB 无旧 key 时生效（同一次到点反复调用稳定复用）；不存在/非活跃/已删除返回 null。同长度测试锁死（`test/v047-occurrence.test.js:82-103`）。
- **入队接线**：`src/index.js:3215-3216` 入队前 `ensureReminderOccurrence(row.id, seconds)`，null 直接 `continue`（不动旧 rpcId）；`:3224` `requestId = companion-reminder:<id>:<occurrenceKey>`——退避改写 `next_fire_at` 后重试仍复用同一 key，rpcId 不变（真机 V6-M1 的根因即 requestId 原取 `next_fire_at` 而退避会改写它，旧取值已删）。
- **旧队列 part 防换代**：`onAttempt`（`index.js:3226-3236`）复核 fresh 行后增加 `fresh.occurrence_key !== occurrenceKey → return false`（`:3230`），防止旧 occurrence 的队列 part 领到已换代的新到点；claim 仍以 `String(fresh.next_fire_at)` 作 fireKey（同一 occurrence 内 fireKey 不变，attempts 不重复计）。
- **四个收口清空 + 归零**：`markReminderDelivered`（`store.js:1892-1905`，delivering→fired）、`markReminderDeliveryFailed` 超限 expired 分支（`:1929-1943`）、`recoverReminderDeliveries` expired 分支（`:1983-1993`）、`expireReminder`（`:2008-2020`）一律 `SET occurrence_key = NULL, last_fire_key = NULL, delivery_attempts = 0`；putative 旧行为（fired/expired 不清 key/不归零）已全部消除。`claimReminderDelivery` 本身不动 occurrences（`:1862-1882`），退避 pending 释放路径保留 key（`:1951-1960`），语义「一次 occurrence 结束才清」自洽。
- **测试**：`test/v047-occurrence.test.js`（store 语义含 expired/expireReminder/非活跃行 `:104-161`；e2e 连续两次失败 requestId 逐字节相等且 attempts 1→2、成功后全复位、下一到点换 key 且 attempts 从 0 起 `:167-241`；v10 旧库建真 DDL 迁移→旧行 NULL→补列→claim/deliver 照常→重开幂等 `:243-321`）。c5-h1a 与 v046-regression 的断言已从「新 claim 换 key」改为「同 occurrence 退避重试 requestId 相等」（`test/c5-h1a.test.js:214-260`、`test/v046-regression.test.js:197-240`）。t3 的 v047-regression 再锁一遍同链路（`:122-207`、`:209-281`）。
- **文档**：`docs/usage.md` 更新 v0.4.7 requestId/attempts 语义。

### V6-L1 /status 自动选取标注 ✅

- `src/index.js:3395` 宿主注入 →「巩固：宿主注入模型（宿主注入）」；`:3404` runtime →「巩固：<provider>/<model>（自动选取）」；`:3407` 配置 →「巩固：<provider>/<model>（配置）」；「无可用模型」「解析中」不变（`:3401` 及探测中分支）。doc comment（`:3383-3390`）同步描述三态标注。
- 测试：`test/v047-l1-l3.test.js:65-105`（三态逐字断言，含「无可用模型」），`test/v047-regression.test.js:290-306`（真 apply + runtime route，断言含「（自动选取）」且 `doesNotMatch /（运行时）/`）。全仓 grep「（运行时）」仅剩 review-v11 历史文档与测试注释/反向断言，无残留实现。
- 文档：README C5-H2 条目、`docs/usage.md` 节流描述同步新措辞（README `:13`、usage `:620`）。

### V6-L3 发现失败 warn 去重、成功清空 ✅

- `warnLlmDiscoveryOnce`（`index.js:2702-2710`）按 reason 去重后才 `platform.log('warn', …, { reason, …meta })`；`state.llmDiscoveryWarnReasons` 挂 wiring state（`:589`）。`resolveLlmRoute`：`listProviders` 失败 debug→warn（reason `'providers'`，`:2766-2769`）；某 provider `listModels` 失败升 warn（reason `models:<providerId>`，meta 带 provider/message 元数据，`:2778-2788`）并 `continue` 不选该 provider。
- 清空双路：单键清 — listProviders 成功清 `'providers'`（`:2764`）、对应 provider 的 listModels 成功清 `models:<id>`（`:2776`）；整体清 — 成功解析出 runtime 路由后 `clearLlmDiscoveryWarnings`（`:2793`），之后任一类再失败可重新 warn 一次。每 5 分钟重试期间连续失败不重复（Set 去重即达成）。
- 测试：`test/v047-l1-l3.test.js` provider 类（warn 一次 → 61s 后不重复 → 成功 [] 后再次失败第二次 warn、reason='providers'）与 model 类（reason='models:deepseek-official'）齐全；`test/v047-regression.test.js:312-367` 覆盖 provider/model 两类去重 + 发现成功重置 + 再失败重新 warn（meta.reason 逐值断言）。
- 文档：`docs/usage.md:620` 记录 warned 语义（「provider 发现失败」「provider X 模型发现失败」两类去重，成功发现后重置）与 `/状态` 仍显示「巩固：无可用模型」。

### 集成回归（t3）复核 ✅

- `cf831a5` 仅新增 `test/v047-regression.test.js`（387 行，4 用例：同 occurrence 两连失败 rpcId 不变/成功换代/`v10 apply()` 迁移/L1 文案 + L3 去重计数），全部经真实 `apply()` + FakeCtx + 临时库，与 t1/t2 的单测覆盖不同层，无重复堆叠。
- 测试数闭环：t1 792 → t2 795（+3，v047-l1-l3）→ t3 799（+4，v047-regression），本轮亲跑复核一致。

## 3. 亲跑验证

- 三时区 `node --test`（cwd=仓库根，无参自动发现）：
  - 默认 TZ：163 tests → 799 pass / 0 fail（含 suites 16）
  - TZ=UTC：16 suites / 799 pass / 0 fail / 0 skipped
  - TZ=America/New_York：16 suites / 799 pass / 0 fail / 0 skipped
- `node --test test/e2e/plugin-smoke.test.js`：fail 0。
- `git status --porcelain` 干净（复审前后复核）；`git tag` 无 v0.4.7（最新 v0.4.6）；`git log origin/main..HEAD` 恰为 3 个提交（未 push）；`git diff --check HEAD` 无输出；HEAD = `cf831a56a914f2bcfce48c214d611957504b52dc`。

## 4. Low 清单

无（本轮未发现值得立项的 Low 项）。

## 5. 发布裁定

V6-M1 / V6-L1 / V6-L3 三项修复均落在实现 + 测试 + 文档三处且互相咬合，H=0、M=0、L=0，满足 v0.4.7 发布门。建议发布提交（package.json 版本号 0.4.6 → 0.4.7、tag v0.4.7、push，含本复审文档）照例进行；当前 package.json 仍为 0.4.6，属发布提交职责，不算缺陷。
