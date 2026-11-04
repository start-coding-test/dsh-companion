# v0.4.5 独立复审（review-v10）

- 复审人：reviewer（独立审查者，未参与 V4 修复实现）
- 复审日期：2026-11-05
- 复审对象：v0.4.4（c648d65）之后、t5 集成回归后的 HEAD `8fbc16a`，含 5 个提交：
  `9ec725c`（V4-H1）/ `e6bb07a`（V4-L1）/ `4c0a184`（V4-M1）/ `c82aebd`（V4-L2）/ `8fbc16a`（集成回归）。
  四个依赖提交（t1=9ec725c、t3=4c0a184、t4=c82aebd、t8=e6bb07a）经 `git merge-base --is-ancestor` 均确认在 HEAD 祖先内。
- 审查过程记录：t6 曾按 captain 指令暂缓（当时 HEAD 仍为 v0.4.4、V4 修复未落地），未写本稿、未出 verdict；收到「go」后按本卡全量复验。
- 复审方式：逐文件读实现与测试、亲跑三时区全量 `node --test`、对 V4 修复做定向单测与独立代码探针（`isTrivialQuery`/`contentQueryBigrams`/注入 TypeError 直跑）、grep 交叉核对文档与接线；未复跑真机 DSH 发布门（采信 t8 依赖回执的真机证据）。
- 结论：**verdict = pass**（H=0 / M=0 / L=2）。2 条 Low 均不阻塞发布：L-1 是文档措辞与实现的一次不一致，建议在发布提交顺带修正；L-2 是 README 状态行随发布提交照例更新。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议） | 2 | L-1 文档措辞（建议发布提交顺带修）、L-2 README 状态行（发布提交照例更新） |

发布前置条件（H=0 且 M=0）满足，复审通过。

## 2. 逐项核验（V4 卡点 → 证据）

### V4-H1 提醒失败卡 delivering ✅

- **入队去重**：`src/index.js:2939` 队列键固定 `dedupeKey: reminder:${row.id}`（不含 tick 秒）；`src/runtime/proactive.js:229-244` `enqueue` 对同 `dedupeKey` 直接回 `{duplicate:true}` 跳过，安静时段/日上限/退避期每个 tick 重复入队不堆副本（`queued` 计数也按 duplicate 排除，`src/index.js:2951-2953`）。
- **提醒不参与合并、逐份判定**：`src/runtime/proactive.js:46` `MERGE_EXCLUDED_KINDS = {'reminder'}`（323-330 跳过合并分支）；投递前钩子逐 part 判定（393-406）：`onAttempt` 返回 false 的份（被取消/退避未到/已删）单独 `onFailed`，其余照常投递；prompt 抛错时把已 claim 的份放回 pending（419-434），不误伤同批候选。
- **fireKey 不再 3 tick 过期**：`src/index.js:2903-2914` `fireDueReminders` 文档契约与实现一致——`onAttempt` 复核最新行后 `claimReminderDelivery(fresh.id, String(fresh.next_fire_at))`（`src/memory/store.js:1797-1815`），`delivery_attempts + (CASE WHEN last_fire_key IS ? THEN 0 ELSE 1 END)` 只在 fireKey 变化时 +1；失败后 `markReminderDeliveryFailed`（`store.js:1829-1885`）把 `next_fire_at` 按 `REMINDER_RETRY_BACKOFF_SECONDS=[30,60,120]`（`store.js:73`）推后，attempt 内退避未到的重复 tick:`onAttempt` 直接 false，不消耗 attempts。
- **无 delivering 卡死**：失败 → pending + 退避（仅对 `delivering` 行生效，对 pending 是空操作）；attempts≥3 才置 `expired`（`store.js:1858-1865`）；崩溃残留 `delivering` 由启动回收 `recoverReminderDeliveries`（`store.js:1887-1910`，接线 `src/index.js:835`）收 pending/<max 或 expired/≥max。
- **安静时段跨夜**：`firstTick` 在安静窗口内多次 tick 只保留一份队列项，解除后单条送达（dedupeKey 稳定 + 队列保留项在 quiet 分支不取）、跨夜同一提醒不重复入队。
- **合并/部分取消不误伤**：日上限 1 场景下第一条 fired、第二条留 backlog；第二条被取消后该 part `onAttempt=false` 单独剔除并 `onFailed`（cancel 行是空操作），其余照常送达，全表无 `delivering` 残留。
- **测试亲跑**：`test/e2e/reminder-delivery.test.js` 10 例全过，V4-H1 四条分别锁失败一次→下一 tick 单条、文本不重复、`delivery_attempts=2`、零 `delivering` 残留（349-388）；安静时段跨夜一条（390-423）；30s→60s→120s 退避、3 个 tick 内不提前耗 attempts、第 3 次失败才 expired（425-467）；部分取消不误伤、无 delivering 残留（469-540）。

### V4-L1 inject 形状校验 ✅

- `src/platform/adapter.js:37-64` `assertInjectedMessage`：非对象/数组 → `TypeError(where) must be a platform message object`；缺/空 `id` → 点名 `id`；`role !== 'user'` → 点名 `role`；空/非数组 `content` → 点名 `content`；`source` 非对象或 `source.kind` 空 → 点名 `source.kind`。
- `mergeDecision`（`adapter.js:102-115`）对 `patch.inject` 逐项校验后才追加进 `messages`；`messages`/`reject` 分支行为不变；裸内容块注解（110-114 注释）明确承接 V3-H1。
- 合法召回消息通过：`src/index.js:2346-2357` `recallMessage()` 生成 `id=randomUUID()/role:user/content 非空/source.kind='companion-recall'`，形状完全合规；`test/platform.test.js` "注入真实召回消息形状：通过且原样追加" 直接锁此路径，`test/e2e/recall-injection.test.js`（过线）验证真实 loop 消费。
- 测试亲跑：`test/platform.test.js` 38 例全过，覆盖缺 id / id 空串 / 缺 source / source.kind 空串 / role / content 六类 TypeError 点名字段；`node --test test/v045-regression.test.js` L1 集成两条过。

### V4-M1 召回词法门槛 / 短查询 ✅

- **查询门**：`src/memory/retrieve.js:427-430` 在算向量、读库之前短路；`isTrivialQuery`（167-188）按 `recall.minQueryChars`（默认 2，`retrieve.js:44`）判长 + 纯算术 + 问候词。亲跑探针：`isTrivialQuery('1+1')===true`、`isTrivialQuery('蓝鲸')===false`。
- **候选词法门槛**：`contentQueryBigrams`（99-183）剔除停用 bigram（`STOP_BIGRAMS`，69-93）及其覆盖位置的跨词 bigram 与拉丁停用词；`lexicalHitQualifies`（369-377）要求命中 ≥2 个不同有效 bigram 或命中比例 ≥30%（`LEXICAL_MIN_HITS=2`/`LEXICAL_MIN_HIT_RATIO=0.3`，47-49）。
- **≥50 fact 混合库**：`test/v045-m1-recall-quality.test.js` 52 条库（蓝鲸/生日/吃药三簇 + 46 条 filler）亲跑全过：「1+1」「12 * 3 = ?」「今天怎么样」「我们什么时候可以」「？？」注入为空且 `searchBigram` 调用数 = 0（读库前生效）；「蓝鲸/生日/吃药没」分别命中对应簇且不含簇外；「今天/我们/一下/什么/怎么/今天怎么样/这个那个」`contentQueryBigrams` 为空、不注入；停用 bigram 不进分母（「蓝鲸是什么动物」→ `['蓝鲸','鲸是','动物']`）。
- **minQueryChars 可配置且 fail-fast**：`RECALL_DEFAULTS.minQueryChars=2`（`src/config.js:84`）、`normalizeRecall`（`config.js:333-373`）整数 1..64 之外抛 `ConfigError('recall.minQueryChars', ...)`；亲跑探针确认 `normalizeRecall({minQueryChars:3})` 生效，测试覆盖 0/-1/1.5/65/'2'/null/NaN 全部拒绝；`retrieve` 内部同样走 `normalizeRecall`（`retrieve.js:414-416`）非法值 fail-fast；接线经 `retrieveVectors`（`src/index.js:1592,1597`）透传 `state.config.recall`。
- 文档：`docs/usage.md:553-559` 与 `docs/usage.md:131` 段同步配置语义。

### V4-L2 召回块经压缩摘要回流 ✅

- 机制：`src/memory/assemble.js:201` 渲染成对标记 `[相关记忆] … [/相关记忆]`；`src/index.js:165-171` `RECALL_MARKER`/`RECALL_END_MARKER`；`scrubRecallBlocks`（`src/index.js:2502-2534`）整段剔除完整片段、标记不全时保守不删；`withoutRecallRecords`（2537-2551）既清空整条召回注入记录，又对「摘要夹带召回段（标记夹在正文中）」的记录 scrub；两处巩固窗口取 surface 快照均包此过滤（`src/index.js:1816`、`1912`）。
- 巩固提示词防线：`src/memory/consolidate.js:420` 明示 `[相关记忆]` 段落是历史快照、不得据此新建/改写事实。
- 证据文档：`docs/recall-compaction.md` 完整记录事故复盘、修复方案、边界（摘要只保留开头标记时提示词兜底）与回归探针口径。
- 测试亲跑：`test/e2e/recall-compaction.test.js` 2 例全过（整段剔除、标记不完整不越界删除）；运行时兜底路径（整条注入记录清空/夹带片段 scrub）有 sink 侧联合用例覆盖。

### 集成回归与仓库状态 ✅

- `test/v045-regression.test.js`（8fbc16a，536 行）跨 H1/L1/M1/L2 六条集成用例亲跑全过。
- 全量 `node --test` 亲跑：默认时区 `766/766 pass`、`TZ=UTC` `766/766 pass`、`TZ=America/Los_Angeles` `766/766 pass`，0 fail / 0 skipped，`node --test test/` 三时区一致。
- 仓库状态：`git status --porcelain` 干净（本稿写出前已确认 clean；commit 后仍不含其他改动）；`git log origin/main..HEAD` 仅 5 个提交未推送（符合卡上"未 push"）；`git tag` 最新 `v0.4.4`，无 v0.4.5 tag（tag/push 属发布人员职责，复审确认现状还未执行）。

## 3. Findings

| id | level | file:line | problem | requiredFix | blockRelease |
| --- | --- | --- | --- | --- | --- |
| L-1 | low | `docs/usage.md:479` | 「30s → 60s → 120s（第 1/2/3 次失败分别对应，之后再失败保持 120s）」与实现不符：第 3 次失败时 `delivery_attempts=3 ≥ REMINDER_MAX_DELIVERY_ATTEMPTS`，`markReminderDeliveryFailed`（`src/memory/store.js:1858-1865`）直接置 `expired`、不再退避，故退避表第 3 档（120s）在当前常量下不可达；同文件 :480 的「达到 3 次才置 expired」与测试（`test/e2e/reminder-delivery.test.js:455-467` 第 3 次失败即 expired）一致，是 :479 一处措辞过宽 | 把 :479 改为「第 1/2 次失败分别退避 30s/60s；第 3 次失败不再重试、直接置 expired」，或注明 120s 档仅在调高 `REMINDER_MAX_DELIVERY_ATTEMPTS` 后启用 | no |
| L-2 | low | `README.md:7` | 状态行仍为「v0.4.4 已发布…743 个用例」，落后当前 HEAD（v0.4.5 待发布、766 用例）；这是 v9 复审 L-2 的同款发布提交义务、尚未随 v0.4.5 发布完成 | 发布 v0.4.5 的提交内一并更新版本号、日期与用例数（766） | no |

（v9 复审的 L-1 已在 t5 链路顺带解决：`docs/usage.md:673` schema 演进段已补 v10 说明；v9 L-3 维持"接受现状"不变。）

## 4. 验证记录（复审亲跑）

- `node --test test/e2e/reminder-delivery.test.js` → 10/10 pass（V4-H1 四条 + 两阶段/恢复/迁移七条）。
- `node --test test/platform.test.js` → 38/38 pass（含六类 inject TypeError 与真实召回形状通过）。
- `node --test test/v045-m1-recall-quality.test.js` → 5/5 pass（52 条库、门槛/停用词/minQueryChars）。
- `node --test test/e2e/recall-compaction.test.js` → 2/2 pass（V4-L2）。
- `node --test test/e2e/recall-injection.test.js test/scheduler.test.js` → 29 pass。
- `node --test test/v045-regression.test.js` → 6/6 pass。
- `node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）→ 各 766 tests / 16 suites / 766 pass，0 fail。
- 独立代码探针：`isTrivialQuery('1+1')===true`、`isTrivialQuery('蓝鲸')===false`、`contentQueryBigrams('今天怎么样')===[]`；`mergeDecision` 经单测证据核验（内部函数，无导出面）。
- `git merge-base --is-ancestor 9ec725c/4c0a184/c82aebd/e6bb07a HEAD` → 全部通过；`git log --all` 无遗漏分支；worktree 仅本工作目录一个。

## 5. 复审方式与范围声明

- 本稿为独立复审，复审人深度参与既往 v0.3.x/v0.4.4 审查但未参与本批 V4 修复编码；证据全部来自 HEAD `8fbc16a` 的代码、测试与亲跑输出。
- 真机发布门（headless round B）未在复审环境重跑，采信 t8 依赖回执的真机证据作 source material。
- 不改动 src/ 与 test/；本稿仅提交 `docs/review-v10.md`，不 push、不打 tag。
