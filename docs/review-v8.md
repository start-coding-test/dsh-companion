# 复审 v8：v0.4.2 M-1 降级守卫与 L-1/L-2/L-4 修复

- 复审人：reviewer-2（独立复审，不产出实现；本卡只新增本文档）
- 日期：2026-11-04
- 基线：`2253025`（review-v7 提交，main 上 v0.4.2 待发布状态）
- 被审提交（`git log 2253025..HEAD`，未 push）：
  | 提交 | 卡 | 内容 |
  | --- | --- | --- |
  | `bda75e9` | t7 | M-1：`markFirstReneed` 对 `used` 行整体跳过（不降级、不补写 `first_reneed_at`）；L-4：used tier 取本轮实际注入档位；L-1：查询遇占用只记 `vectorEmbedBusy`、日志降 `debug`；L-2：触发器 kind 字面量由 `RENEED_KINDS` 生成；文档同步 |

## 结论：**pass**

H（阻塞级）= 0，M（需返工）= 0，L（不阻塞）= 1（文档列语义一处不精确）+ 1 条队长已知遗留（L-3）。

review-v7 的 M-1 已在正常可达路径上修复并经独立复现：`used` 行此后无论再以何种档位注入、或再触发 dedupe/correction，`reneed_kind` 都保持 `used`、`first_used_at` 不被改写、`first_reneed_at` 不会被补写；S0 主样本 SQL 命中 1 行、recall 对照仍为 0。L-1/L-2/L-4 的修复与代码、测试、文档三方一致。三时区全量 `node --test` 均为 667/667，工作区干净、无 push、无 v0.4.2 tag。

---

## 1 M-1：`used` 行不被后续 recall 降级

### 1.1 静态依据（文件:行号）

- `src/memory/store.js:1306-1328` `markFirstReneed` 的 SQL 现在是：
  `UPDATE facts SET first_reneed_at=?, first_reneed_tier=?, reneed_kind=?, same_context=?, updated_at=unixepoch() WHERE id=? AND first_reneed_at IS NULL AND (reneed_kind IS NULL OR reneed_kind <> 'used')`（守卫在 `:1323-1324`）。
  即：`used` 行**所有列**都不再被 recall/dedupe/correction 触碰——不写 `first_reneed_at`、不改 `reneed_kind`、不覆盖 `same_context`；返回 `false` 表示跳过。
- `src/memory/store.js:1352` 起 `markReneedUsed` 仍只写 `first_used_at`/`first_used_tier`/`used_same_context` 并升级 `reneed_kind='used'`，覆盖条件不变（`NULL` 或「已有 `1`、本次 `0`」；已有 `0` 不再覆盖）；不写 `first_reneed_*`。
- 三条写入口径互不打架：`src/index.js:2124`（recall）、`src/index.js:3382`（correction）、`src/memory/consolidate.js:578`（dedupe）都走 `markFirstReneed`，因此都被同一守卫拦在 `used` 行之外；`markReneedUsed` 只在 `src/index.js:1135` 被调用。
- 与 v0.4.1 对比：v0.4.1 的 `markReneedUsed` 写 `first_reneed_at = COALESCE(first_reneed_at, ?)`，所以当时「先 used 后 recall」是 no-op；v0.4.2 把两组列分账后一度丢掉该保护，现由 `reneed_kind <> 'used'` 守卫恢复且更严格（连 `same_context` 也不动）。

### 1.2 独立复现（不复用 t7 的测试）

用 `Store.open(':memory:')` 直接复现原文场景（临时脚本已删除）：

1. 插入 fact 后 `markReneedUsed(id, { at: now, tier: 'miss', sameContext: false })` → 返回 `true`；行状态 `reneed_kind='used'`、`first_reneed_at=NULL`、`first_used_at=now`、`first_used_tier='miss'`、`used_same_context=0`（index 档注入不被写成 recall 样本）。
2. 之后 `markFirstReneed(id, { at: now+2d, tier:'clear', kind:'recall' })` → 返回 `false`；行仍 `reneed_kind='used'`、`first_used_at` 不变、`first_reneed_at=NULL`。
3. 之后 `markFirstReneed(..., kind:'dedupe')` → 返回 `false`；行仍 `reneed_kind='used'`、`first_reneed_at=NULL`（审计事件同样不覆盖主样本，与「一个字段只能有一个 kind」的取舍一致）。
4. S0 主样本 SQL（`reneed_kind='used' AND used_same_context=0 AND first_used_at IS NOT NULL AND observed_at>0`）命中 1 行；`reneed_kind='recall'` 对照 0 行。
5. 非法 kind（`'nonsense'`）仍被触发器拒绝：`invalid facts.reneed_kind`——守卫没有绕开 L-2 的校验。

### 1.3 集成回归

`test/v042-regression.test.js:558-641` 用 `apply` 全链路复现：t0+6d index 档注入（`R≈0.135`）断言无 recall 样本（`:582-584`）→ 下一轮复述用上（`:602-606`：`kind='used'`、`first_used_at=at+6d`、`first_used_tier='miss'`、`used_same_context=0`、`first_reneed_at` 仍 `null`）→ 抬高强度后 t0+7d 以 full 档再次注入（`:624-627`：kind 仍 `used`、`first_used_at` 不变、`first_reneed_at` 仍 `null`）→ S0 主样本 1 行 / recall 对照 0 行（`:629-640`）。该用例方向与我的独立复现一致，且覆盖了「index 档 → 用上 → full 注入」这条 review-v7 指出的可达路径。

**M-1 判定：已修复，closed。**

## 2 L-4：`first_used_tier` 取本轮实际注入档位

- `src/index.js:390` 新增 `lastRecallTiers: new Map()`；`:982`、`:997` 在 `reinforceOnUse` 的两处 `isNewTurn` 早退路径清空；`:1006-1007` 消费后立即清空；`:1035` 调用改为 `markUsedReneed(state, id, fact, at, samples.get(id), tiers.get(id))`——档位与样本同源、同批。
- `src/index.js:2096-2102`：`recordRecalledFacts` 对**每个**进入本轮的 fact 写 `tiers.set(id, full→'clear' / gist→'ambiguous' / 其余→'miss')`，且这行在 `if (item.fidelity !== 'full' && item.fidelity !== 'gist') continue` 之前，index 档不会漏记；index 档仍不写 recall 样本（`:2102`），与「recall 对照只收 full/gist」一致。
- `src/index.js:1117-1128`：`markUsedReneed(..., sample, injectionTier)` 优先 `injectionTier`，非法值退 `sample?.tier`，再退 `fact.fidelity==='gist'?'ambiguous':'clear'`，并单独把 `fact.fidelity==='index'` 兜底为 `'miss'`；注释写明「取不到才用库内 fidelity 猜」。tier 在 `src/memory/store.js:1309` 按 `RENEED_TIERS={clear,ambiguous,miss}` 校验，`miss` 合法。
- 回归断言：`test/v042-regression.test.js:604`（index 档用上 → `first_used_tier='miss'`，不能用库内 `fidelity=full` 猜成 `clear`），`:626`（后续 full 注入不改写已记录的 tier）。

**L-4 判定：closed。** 残留的是文档表述（见 §5）。

## 3 L-1：占用只记 busy

- `src/index.js:1332-1341`：查询侧 `EMBEDDING_BUSY` 分支只 `inc('vectorEmbedBusy')` 并 `log('debug', ...)`；其余 `vectorError` 才 `inc('vectorEmbedFailures')` + `log('warn', ...)`。回填侧 `src/index.js:1364`（开跑前 `busy()` 跳过）与 `:1404-1407`（catch 分支：`EMBEDDING_TIMEOUT→vectorBackfillTimeouts`、`EMBEDDING_BUSY→vectorEmbedBusy`、其余→`vectorEmbedFailures`）口径一致。
- 回归断言：`test/v042-regression.test.js:643-690`——回填占住推理后连续两次 `retrieveVectors`：`code='EMBEDDING_BUSY'`、FTS 结果照常返回（`:675-676`）、`snapshot.vectorEmbedBusy===2`（`:679`）、`snapshot.vectorEmbedFailures===undefined`（`:680`）、`warn`/`embedding failed` 日志 0 条（`:681-685`）。
- 文档一致性：`docs/embedding.md:113` 明确「查询或回填遇到已有推理在跑（`EMBEDDING_BUSY`）是占用而非失败：只记 `vectorEmbedBusy`，不计 `vectorEmbedFailures`，查询立即回退 FTS 且日志降为 `debug`」，与代码一致；`/状态` 的「占用 N」来自 `src/index.js:1446` 的 `metricsSnapshot.vectorEmbedBusy`（`src/runtime/commands.js:570-571` 消费），未见双计。

**L-1 判定：closed。**

## 4 L-2：触发器 kind 单一来源

- `src/memory/store.js:34` `import { RENEED_KINDS } from './reneed.js'`；`:844-857` `#ensureReneedKindTriggers` 用 `RENEED_KINDS.map(...)` 拼出 `NOT IN (...)`，insert/update 两个触发器同源；注释说明 `CREATE TRIGGER IF NOT EXISTS` 不会更新既有触发器、将来增删 kind 需显式 DROP 重建（当前 kind 集未变，不需要）。`:72` 的 `RENEED_KIND_SET` 也由同一常量构造，校验/触发器/文档（`docs/s0-calibration.md:76`）三处不再各写一遍字面量。
- 测试：`test/reneed.test.js:156-157`、`:215-216` 显式 DROP 后重建，`:238-242` 断言两个触发器存在；`test/reneed.test.js` 迁移/非法 kind 用例全绿（触发器仍抛 `invalid facts.reneed_kind`）。
- 观察（不计缺陷）：因为 `IF NOT EXISTS`，旧库（已有 v8 触发器）升级到 v9 时不会重建触发器；kind 集自 v8 起未变，行为等价，注释已记录该前提，可接受。

**L-2 判定：closed。**

## 5 亲自验证（本机实测）

| 命令 | 结果 |
| --- | --- |
| `node --test`（默认 TZ=Asia/Shanghai，HEAD `bda75e9`） | tests 667 / suites 16 / pass 667 / fail 0（~5.5s） |
| `TZ=UTC node --test` | tests 667 / pass 667 / fail 0 |
| `TZ=America/Los_Angeles node --test` | tests 667 / pass 667 / fail 0 |
| `node --test test/v042-regression.test.js` | 10/10 pass（含新增 M-1、L-1 两例） |
| `git status --short` | 空（工作区干净） |
| `git log origin/main..HEAD --oneline` | 审查时 6 条未 push：`bda75e9`/`2253025`/`80cc236`/`b9fd2de`/`a99de84`/`890f028`；加入本文档提交后共 7 条 |
| `git tag --list \| tail` | 到 `v0.4.1` 为止，无 `v0.4.2` |
| `git diff --name-only 8b62786..HEAD \| grep -E '^memory/\|USER.md\|MEMORY.md\|profile'` | 无匹配（设计文档与用户 profile 未改） |

抽查 5 条硬断言 ↔ 源码行：

| 断言（测试:行） | 源码依据 |
| --- | --- |
| `test/v042-regression.test.js:624` 后续 recall 不降级 used | `src/memory/store.js:1323-1324` 守卫 `reneed_kind <> 'used'` |
| `test/v042-regression.test.js:604` index 档用上 tier=`miss` | `src/index.js:2098-2102` tiers 表 + `src/index.js:1120` 优先 `injectionTier` |
| `test/v042-regression.test.js:680` busy 不计 failures | `src/index.js:1333-1341` 分支互斥 |
| `test/v042-e2.test.js` 回填期间不起新批 | `src/memory/embedders/local.js` `inferenceInFlight` 只在 settle 清空 + `src/index.js:1364` `busy()` 跳过 |
| `test/v042-regression.test.js:471-493` 加载复用同一 promise | `src/memory/embedders/local.js:242-305` `loadInFlight` 单飞、`warmup` 复用 |

用例数变化与 t7 交付摘要一致：665（review-v7 实测）→ 667（+2：M-1、L-1）。

## 6 文档诚实性与遗留

### L-5（low，文档精确性，不阻塞）

- `docs/s0-calibration.md:79` 列语义仍写 `first_used_tier` = `clear` / `ambiguous`，而 L-4 后 index 档用上会写 `miss`（同文件 `:82` 已写「index 档记为 `miss`」，`:21-22` 的「结果」表也没有「用上·沉睡档」行）。列定义表与写入口径自相矛盾，按列定义读会以为 `miss` 不可能出现。
  - requiredFix：`:79` 改为 `clear` / `ambiguous` / `miss`，并在 `:19-26` 的结果表补一行「用上·沉睡档（index 注入，0.05≤R<0.2）→ `first_used_tier = miss`，`reneed_kind = used`」；顺带把「用上时 R」措辞改为「注入时 R」（L-4 后档位在注入时确定）。
  - 影响：仅标定手册表述，代码与 SQL 主样本口径不受影响（主样本不筛 tier）。

### 遗留（队长已知，未在 t8 范围）

- **L-3**（review-v7 low）：`backfillBatchSize` 默认 8 但允许 1–50，卡片字面是「batch 8–16」。t7 明确未改（`src/config.js:58` 默认 8、`:213-221` 校验 1..50），属规格解释问题而非实现缺陷；若原文指上限 16，需在发布前收紧并同步 `docs/embedding.md` / README 的「允许 1–50」。
- 观察：`src/index.js:1314-1318` 的 JSDoc 把「导出仅供回归测试」插在 `@param state` 与 `@param input` 之间，排版小瑕疵（不影响文档渲染语义），可随手整理。
- `package.json` version 仍 `0.4.1`：发布卡（t6）负责 bump 并打 tag，不算本卡缺陷。

## 7 审计动作

- 只读审查：未改 `src/`、`test/`、`docs/s0-calibration.md`、`docs/embedding.md`；本卡唯一新增即本文档。
- 临时复现脚本 `tmp-review-m1-check.mjs` 已删除；未创建 worktree、未改 `.agent-teams/`、未改 `memory/` 设计文档与用户 DSH profile。
- 本次提交只含 `docs/review-v8.md`，不 push、不打 tag；推送与发布由队长/发布卡执行。
