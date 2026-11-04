# 复审 v7：v0.4.2（S2-M1 / E2-M1 / L2-1 / L2-2 / L2-3）

- 复审人：reviewer-2（独立复审，不产出实现；本卡只新增本文档）
- 日期：2026-11-04
- 基线：`8b62786`（v0.4.1 tag 发布基线）
- 被审提交（`git log 8b62786..HEAD`，均未 push）：
  | 提交 | 卡 | 内容 |
  | --- | --- | --- |
  | `890f028` | t1 | S2-M1 + L2-1：`first_used_at` / `first_used_tier` / `used_same_context`、用上时刻重算 same_context、Δt 用 `observed_at`、schema v9 |
  | `a99de84` | t2 | E2-M1 + L2-3：回填独立超时、推理单飞、查询回退 FTS、批量默认 8、加载单飞 |
  | `b9fd2de` | t3 | v0.4.2 集成/回归测试（`test/v042-regression.test.js` 8 例） |
  | `80cc236` | t4 | 文档：S0 主样本口径、embedding 配置/指标、known-debt、CHANGELOG 计数、README/usage |

## 结论：**needs_revision**

H（阻塞级）= 0，M（需返工）= 1，L（不阻塞）= 4。主路径（用上时刻写入、覆盖一次、recall 对照保留、Δt 用 `observed_at`、回填/查询超时分离、推理与加载单飞、查询立即回退 FTS、L2-2 计数）均与卡片一致并通过三时区实测；但 S2-M1 存在一条**在正常可达路径上把已记录的 `used` 主样本降级成 `recall` 对照样本**的数据完整性问题（M-1），需修复并补回归用例后才能发布。

---

## 1 S2-M1：用上时刻写入与覆盖语义

### 1.1 静态依据（文件:行号）

- `src/index.js:1106` `markUsedReneed(state, id, fact, atSeconds, sample)`：入参 `atSeconds` 是**本轮强化/用上时刻**（`src/index.js:1002` `at = floor(platform.now()/1000)`），不是注入时刻。
- `src/index.js:1109-1112`：档位取本轮注入样本 `sample?.tier`；无样本（index 档注入不建样本）时退回 `fact.fidelity==='gist'?'ambiguous':'clear'`。
- `src/index.js:1113-1118`：`sameContext = isSameContextSample({ at: atSeconds, createdAt: factOriginTime(state, fact), sourceInSurface: sourceStillInSurface(...) })` —— 当场用「用上时刻 + 原话时间 + 来源 episode 是否仍在 surface」重算，**不再沿用注入时的 `sample.sameContext`**。
- `src/index.js:1119`：`store.markReneedUsed(id, { at: atSeconds, tier, sameContext })`。
- `src/index.js:1082-1093` `factOriginTime` → `store.getEpisode(source_episode_id)` → `resolveObservedAt`。
- `src/memory/reneed.js:97-104` `resolveObservedAt` 回退顺序：`fact.observed_at` → `episode.observed_at` → `episode.started_at` → `episode.created_at` → `fact.created_at`；全缺失返回 `null`（`isSameContextSample` 对 `null` 保守按非同会话处理）。
- `src/memory/reneed.js:45-60` `isSameContextSample`：`sourceInSurface===true` 直接同会话；否则 `Δt<6h` 判同会话，时钟回拨（Δt<0）保守非同会话。
- `src/memory/store.js:1343-1366` `markReneedUsed` SQL：
  `SET first_used_at=?, first_used_tier=?, used_same_context=?, reneed_kind='used', updated_at=unixepoch() WHERE id=? AND (reneed_kind IS NULL OR reneed_kind IN ('recall','used')) AND (used_same_context IS NULL OR (used_same_context=1 AND ?=0))`。
  即：NULL 可写；已 `1` 且本次 `0` 可覆盖一次；已 `0` 不再覆盖；`dedupe`/`correction` 不被 used 改写；**不触碰 `first_reneed_*`**。
- `src/index.js:2052-2106` `recordRecalledFacts`：注入时对 full/gist 档重建样本并 `store.markFirstReneed(..., kind:'recall')`（`:2090-2095`，store 侧 `first_reneed_at IS NULL` 幂等，`:1298-1317`）；index 档在 `:2068` 被跳过（不建 recall 样本），但 `:2062-2067` 已把 id 计入 `state.lastRecalledIds`。
- `src/memory/store.js:55` `SCHEMA_VERSION='9'`；`:237-239` facts DDL 三列（`used_same_context` 带 `CHECK(IN (0,1))`）；`:737-771` 迁移事务 + `#ensureFactsReneedColumns` 逐列 ALTER + `CREATE INDEX IF NOT EXISTS ix_facts_used`；`:806-832` v8/v7/v6 只推进版本、列由打开时补齐；`src/memory/export.js` `CURRENT_SCHEMA_VERSION '9'`（`schema_meta` 缺失兜底，必要同步）。

### 1.2 亲自验证

- 单测对应用例全绿（见 §4），重点断言：`test/v042-regression.test.js:121-131`（`first_used_at=at+3d`、`used_same_context=0`、`Δt=(first_used_at-observed_at)/86400=3`、`first_reneed_at` 仍为注入时刻 +1h）、`:148`（第二次用上不覆盖首次）、`:204-206`（首次注入未被用上、第二次才用上 → 用上时刻取第二次之后）、`:256`（same_context 用上保留 + first_reneed_* 不变）、`:548-551`（L2-1：`observed_at` 新鲜但 `created_at` 30 天前 → same_context=1）。
- 我另用 `:memory:` store 直接复现覆盖语义：NULL→写、`same=1`→本次 `same=0` 覆盖、已有 `same=0` 后再写不覆盖、`dedupe` 行不写 —— 与 SQL 一致。
- L2-1 闭环：`docs/s0-calibration.md:108-121` 主样本 SQL 用 `first_used_at - observed_at`、`used_same_context=0`、`reneed_kind='used'`、`observed_at>0`；`docs/s0-calibration.md:83` 与 `reneed.js:97-104` 的回退顺序一致。

### 1.3 发现

**M-1（medium）：已记录的 `used` 主样本会被后续 `recall` 降级，S0 主查询静默丢样本。**

- 位置：`src/memory/store.js:1298-1317`（`markFirstReneed` 以 `WHERE first_reneed_at IS NULL` 为唯一条件，`SET reneed_kind = ?`）+ `src/index.js:2062-2095`（index 档不写 recall 样本但计入 `lastRecalledIds`）+ `src/index.js:1026`。
- 机制：v9 把 `used` 从 `markFirstReneed` 拆出，`markReneedUsed` 不再写 `first_reneed_at`（`store.js:1353-1365`）。因此「只经 index 档注入、随后被复述用上」的事实（`index.js:2068` 明确不为 index 建 recall 样本，`store.js` 允许 `reneed_kind IS NULL` 时写 used）会得到 `reneed_kind='used'`、`first_used_at` 有值、`first_reneed_at=NULL` 的行。之后该事实再以 full/gist 被注入时，`markFirstReneed` 看到 `first_reneed_at IS NULL`，把 `reneed_kind` 改写回 `'recall'` 并写入**晚于** `first_used_at` 的 `first_reneed_at`。
- 后果：S0 主样本 SQL（`reneed_kind='used' AND used_same_context=0`）静默丢弃该 used 样本；同一行又被「只被注入」对照 SQL（`reneed_kind='recall'`）计入，两侧口径同时污染；行内出现 `first_reneed_at > first_used_at` 的自相矛盾。这与 `docs/s0-calibration.md:82`「`used` 只把 `reneed_kind` 升级为 `used`」及 v0.4.1 行为（旧 `markReneedUsed` 用 `COALESCE` 补写 `first_reneed_at`，后续 `markFirstReneed` 自动 no-op）都不一致。
- 实测复现（`Store.open(':memory:')`，临时脚本，复审后已删）：
  ```
  markReneedUsed(id,{at,tier:'clear',sameContext:false})
    → reneed_kind='used', first_reneed_at=null, first_used_at=T, used_same_context=0
  markFirstReneed(id,{at:T+2d,tier:'clear',kind:'recall',sameContext:false})
    → wrote=true, reneed_kind='recall', first_reneed_at=T+2d, first_used_at=T
  S0 主样本行数: 0 | recall 对照行数: 1
  ```
  该顺序在真实链路可达：index 档事实在 `lastRecalledIds` 内（`index.js:2062-2067` 无 fidelity 过滤），复述重叠 ≥0.6（`index.js:1014`）即写 used；强化后强度上升，后续召回更可能以 full/gist 出现，正好触发降级。
- 现有测试只覆盖「无 recall 样本 → 写 used 四列」（`test/reneed.test.js:320+`），没有覆盖「写 used 之后再来 recall」。
- `requiredFix`：
  1. `markFirstReneed` 不得把已经是 `used` 的行改回 `recall`（例如 `reneed_kind = CASE WHEN reneed_kind='used' THEN 'used' ELSE ? END`），保证 kind 单向升级；`first_reneed_*` 是否继续写入需在 `docs/s0-calibration.md` 同步说明（若继续写，需注明该行仍按 used 主样本统计、不进 recall 对照）。
  2. 补一条回归用例：index 档注入 → 复述用上（used 写入、`first_reneed_at` 为 NULL）→ 再以 full 档注入 → 断言 `reneed_kind` 仍为 `used`、`first_used_at` 不变，且 S0 主样本 SQL 命中 1 行、recall 对照 0 行。
  3. 顺带确认 index 档用上时的 `first_used_tier` 口径（见 L-4）。

---

## 2 E2-M1 / L2-3：回填超时、单飞与回退

### 2.1 静态依据（文件:行号）

- `src/config.js:52-58`：`embedTimeoutMs:300`、`backfillTimeoutMs:30_000`、`backfillBatchSize:8`（注释写明查询仍用 300ms、批量硬上限 50）；`:203-221` 校验 `backfillTimeoutMs` 整数 `1..600000`、`backfillBatchSize` 整数 `1..50`；`DEFAULTS` 冻结，返回值与 JSDoc 同步。
- `src/memory/embedders/local.js:439-441`：`embed()` → `embedRaw(timeoutMs, 'inference')`、`embedBackfill()` → `embedRaw(backfillTimeoutMs, 'backfill inference')`、`embedQuery()` → `embedRaw(timeoutMs, 'query inference')`；`embedRaw`（`:373-387`）超时值只由调用方传入。
- `src/index.js:1347`：回填批量取 `config.vector.backfillBatchSize`；`:1349-1353` 优先 `embedder.embedBackfill`，否则回退 `embed`；`:1338-1341` 开跑前 `busy()` → `metrics.inc('vectorEmbedBusy')` 并 `return 0`；`:1330-1337` `status()!=='ready'` 时只续接预热。
- 推理单飞：`local.js:335-341` `inferenceInFlight!==null` → 抛 `EmbeddingBusy`（`errors.js`：`code='EMBEDDING_BUSY'`、`transient:true`）；`:342-347` 挂起 promise，且 `pending.then(clear, clear)` **只在底层 settle 时清空**；`:349-356` `withTimeout` 只截断等待；`:401` `busy()=inferenceInFlight!==null`。
- 查询立即回退：`src/memory/retrieve.js:273-283` 查询 `embedQuery` 的异常**当场 catch**（不排队、不等待），`:433` 返回 `vectorError{name,code,kind,transient,fatal,message}`；`src/index.js:1313-1317` 记录指标并继续用 FTS 结果。
- 加载单飞 L2-3：`local.js:242-275` `beginLoad` 单飞 + settle 清空；`:218-236` `doLoad` 不套 `loadTimeoutMs`；`:283-305` `warmup` 在 `loadInFlight` 非空时 `withTimeout(loadInFlight, loadTimeoutMs)` **复用同一 promise**；`:181-187` `statusOf` 的 `loading` 依据 `loadInFlight`。
- 指标：`src/index.js:1375-1382` 回填 `EMBEDDING_TIMEOUT`→`vectorBackfillTimeouts`、`EMBEDDING_BUSY`→`vectorEmbedBusy`（提前 return，不叠 failures）；`:1420-1421` `budgetInfo` 注入 `backfillTimeouts`/`embedBusy`；`src/runtime/commands.js:562-573` `/状态` 输出 `…·回填超时 N·占用 M`。

### 2.2 亲自验证

- `test/v042-regression.test.js:383`：50 条按默认 8 分 `[8,8,8,8,8,8,2]`，且 `timeoutMs=5` + `backfillTimeoutMs=30000` 下全部写入 → 超时确实分离（若回填仍用 300ms，50 条不可能写完）。
- `test/v042-e2.test.js:187-200`：20ms 回填超时后 `embedder.busy()===true`、`fake.calls.length` 不增、底层结束（`delay(250)`）后才起下一批 → 超时批次未结束不会再起批，单飞真实生效；`:204-231` 两次 idle-probe 只 1 次推理、`vectorEmbedBusy` 恰好 1 次。
- `test/v042-regression.test.js:455-457`：查询撞回填占用 `elapsed<250ms`、`vectorError.code='EMBEDDING_BUSY'`（`transient=true`）、FTS 结果照常返回 → 立即回退，不等待。
- `test/v042-regression.test.js:484-493`：`loadTimeoutMs=20ms` 连续两次超时后 `loads===1` → 复用同一加载 promise；`status()` 从 `loading` 到 `ready`。
- `/状态` 文案：`test/status-vector.test.js` 断言含「回填超时 2·占用 4」，与 `commands.js:570-571` 取值一致。

### 2.3 观察（不阻塞）

- **L-1（low）**：`src/index.js:1314-1316` 查询遇 `EMBEDDING_BUSY` 时同时 `inc('vectorEmbedBusy')` 与 `inc('vectorEmbedFailures')`，而回填遇忙（`:1377-1381`）只记 busy。结果：回填推理占用期间（最长 30s）每轮查询都会虚增一次 `vectorEmbedFailures` 并打一条 `embedding failed; falling back to FTS` 的 warn。`docs/embedding.md:59,113` 明确「占用记 `vectorEmbedBusy`、底层推理失败才记 `vectorEmbedFailures`」，代码与文档口径不一致（仅指标/日志噪声，无行为影响）。建议 busy 分支只记 `vectorEmbedBusy`、日志降为 debug。
- **L-4（low）**：index 档注入被用上时没有 recall 样本，`src/index.js:1110-1112` 用库内 `fact.fidelity` 兜底档位；而注入实际档位在 `retrieve.js:386` 由 `conservativeFidelity(row.fidelity, fidelityOf(R))` 决定，二者可能不同（例如 R 已跌破 0.2 但库内仍为 `full`），会把 index 档用上记成 `first_used_tier='clear'`。与 M-1 同一族边界，建议在修 M-1 时一并用「本次注入档位」而不是库内 fidelity 兜底，或在 `docs/s0-calibration.md` 写明该兜底口径。
- remote 回填仍继承 `vector.remote.timeoutMs`/`embedTimeoutMs`、无单飞 —— `docs/embedding.md:82` 已明确写入设计选择，不计缺陷。

---

## 3 L2-2：CHANGELOG 计数核对（亲自在 tag 上实测）

| tag | 实测 `node --test` | CHANGELOG 声明 | 结论 |
| --- | --- | --- | --- |
| v0.4.0（`git worktree ... v0.4.0 --detach`） | tests 626 / suites 16 / pass 625 / fail 1 | 626 | **一致**（唯一 fail 见下） |
| v0.4.1（`git worktree ... v0.4.1 --detach`） | tests 646 / suites 16 / pass 646 / fail 0 | 646（16 套件） | **一致** |
| HEAD（`80cc236`） | tests 665 / suites 16 / pass 665 / fail 0 | 未预填（发布卡填） | 待 t6 |

- v0.4.0 worktree 的 1 个 fail 是历史环境问题：worktree 检出为 CRLF（`core.autocrlf=true`），v0.4.0 的 `test/calibration.test.js:224` 只认 LF 的 ```json 代码块；v0.4.1 已改为 LF/CRLF 均可解析（`test/calibration.test.js:236-245`）。用例总数仍为 626，与 CHANGELOG「626→646」一致，**不是**计数造假。
- 两个临时 worktree 与复现脚本已在复审结束后删除，未留在仓库工作树。

---

## 4 回归与约束（亲自执行）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 三时区全量测试 | 665/665、16 套件、0 fail × 3 | 在 `80cc236` 上分别以默认（本机 Asia/Shanghai）、`TZ=UTC`、`TZ=America/Los_Angeles` 跑 `node --test` |
| 定向用例 | `test/v042-regression.test.js` 8/8、`test/v042-e2.test.js` 6/6 | 同上批次 |
| 5 条硬断言 → 源码行号抽查 | 全部能落到实现行，见下表 | 逐条对读 |
| 未 push | `git log origin/main..HEAD` = `890f028`/`a99de84`/`b9fd2de`/`80cc236` 4 条；无 `v0.4.2` tag | `git log`/`git tag` |
| 工作树干净 | 复审前 `git status --short` 为空 | `git status` |
| 无新增运行时依赖 | `package.json` 依赖未变（仅 node: 内置 + 可选 transformers） | diff |
| 未动 `memory/` 设计文档、未动用户 DSH profile | `git diff 8b62786..HEAD --stat -- memory/` 为 0 行 | diff |

抽查映射：

| # | 硬断言 | 实现行 |
| --- | --- | --- |
| 1 | `test/v042-regression.test.js:383` 默认批量 8 → `[8,8,8,8,8,8,2]` | `src/config.js:58` + `src/index.js:1347` |
| 2 | `test/v042-e2.test.js:190-192` 回填超时后 `busy()=true` 且不起新批 | `src/memory/embedders/local.js:342-347`、`:349-356`、`src/index.js:1338-1341` |
| 3 | `test/v042-regression.test.js:455-457` 查询撞占用 `<250ms` 且 `EMBEDDING_BUSY` | `local.js:336-341` + `retrieve.js:273-283` + `index.js:1314` |
| 4 | `test/v042-regression.test.js:484-493` 两次加载超时 `loads===1` | `local.js:242-275`、`:283-305` |
| 5 | `test/v042-regression.test.js:121-131` 用上时刻 + `used_same_context=0` + `first_reneed_*` 保留 | `index.js:1106-1119` + `store.js:1343-1366` |

---

## 5 文档诚实性

- `docs/s0-calibration.md`：主样本 SQL（used 且 `used_same_context=0`）、`recall` 仅对照、`dedupe`/`correction` 仅漏率审计、same-context used 可覆盖一次、v8 旧行不可回填、`observed_at>0` 排除 —— 与 `store.js`/`index.js`/`reneed.js` 一致。**但 §2 与 §7 的「kind 只单向升级为 used」在 M-1 路径下不成立**，修 M-1 后需保持该表述并补一句「used 先于 recall 样本时，后续注入不改 kind」。
- `docs/embedding.md`：`backfillTimeoutMs`/批量 8/推理单飞/查询回退/加载单飞/指标/`/状态` 文案/remote 无单飞 —— 与实现逐条一致；仅 L-1 的 failures 计数口径不一致（见 §2.3）。
- `README.md`、`docs/usage.md`：状态 0.4.2 待发布、配置表 `backfillTimeoutMs=30000`/`backfillBatchSize=8`、schema v9 列说明 —— 一致；`package.json` 仍是 0.4.1 属发布卡 t6，不计缺陷。
- `docs/known-debt.md`：L2-1/L2-2/L2-3 关闭（指向 `890f028`/`a99de84`）、D-4 保持 P1 并写明真机未验 —— 无「未修写成已修」。
- `CHANGELOG.md`：v0.4.1 计数改 `626→646` 为实测值；v0.4.2 为草稿、不预填测试数 —— 诚实。
- 越界文件仅 2 处，均属必要：`src/runtime/commands.js:562-573`（`/状态` 展示，需求 4 无此改动无法满足）、`src/memory/export.js` 的 schema 常量 `'9'`（`schema_meta` 缺失兜底）。可接受。

---

## 6 发现清单

| # | 严重度 | 位置 | 问题 | requiredFix |
| --- | --- | --- | --- | --- |
| M-1 | medium | `src/memory/store.js:1298-1317`、`src/index.js:2062-2095`、`:1026` | 先 used（index 档注入、无 recall 样本）后 full/gist 注入时，`markFirstReneed` 把 `reneed_kind` 改回 `recall` 并写入晚于 `first_used_at` 的 `first_reneed_at`；S0 主查询静默丢样本、对照查询误计，行内时间自相矛盾。已用 `:memory:` store 复现（主样本 0、对照 1） | ① `markFirstReneed` 不得把 `used` 降级（`CASE WHEN reneed_kind='used' THEN 'used' ELSE ? END` 或等价守卫），`first_reneed_*` 的语义在 `docs/s0-calibration.md` 同步；② 补「index 档用上 → 再 full 注入」回归用例，断言 kind 仍 `used`、`first_used_at` 不变、主 SQL 命中 1 行。③ 顺带按 L-4 校正 index 档用上的 `first_used_tier` |
| L-1 | low | `src/index.js:1314-1316` | 查询遇 `EMBEDDING_BUSY` 同时记 `vectorEmbedBusy` + `vectorEmbedFailures` 并打 warn，与回填路径及 `docs/embedding.md:59,113` 口径不一致，回填占用期间每轮虚增失败计数 | busy 分支只记 `vectorEmbedBusy`，warn 降为 debug（或文档同步说明 busy 也计入 failures） |
| L-2 | low | `src/memory/store.js` `#ensureReneedKindTriggers` | 触发器 kind 字面量未引用 `RENEED_KINDS`，增删 kind 需两处同步（v6 已提，仍在） | 加注释指向 `reneed.js RENEED_KINDS` |
| L-3 | low | `src/config.js:58` / `docs/embedding.md:54` | 卡片写「batch 8–16」，实现默认 8、允许 1–50；若原文 8–16 指允许区间上限，则需收紧到 16 | 由队长对照 review-code 原文确认；若确为上限 16，改校验范围并同步 config/embedding 文档与测试 |
| L-4 | low | `src/index.js:1110-1112` | index 档用上无样本时用库内 `fact.fidelity` 兜底档位，可能与注入时 `retrieve.js:386` 的实际档位不同，把 index 记成 `clear` | 随 M-1 用本轮注入档位兜底，或在 `docs/s0-calibration.md` 写明兜底口径 |

---

## 7 复核后的裁定

- H=0：无阻塞（默认路径、召回正确性、数据持久化、用户可见行为均未破坏）。
- M=1：M-1 会让 v0.4.2 的核心交付物（S0 主样本）在可达路径上失真，属「必须返工才能发布」。
- 判定：**needs_revision**（`t5` failed）。v0.4.2 的其余交付（E2-M1、L2-1、L2-2、L2-3）已满足卡片，可在 M-1 修复 + 回归后直接复审放行，无需重开其它卡。

---

## 附：复审动作清单（审计轨迹）

1. `git log 8b62786..HEAD`、`git diff --stat 8b62786..HEAD`（26 文件 +1631/−260）全量读。
2. 逐文件读被改 src：`src/index.js`（`recordRecalledFacts`→`reinforceOnUse`→`markUsedReneed`→`retrieveVectors`→`backfillVectors`→`budgetInfo`）、`src/memory/store.js`（schema v9/迁移/`markFirstReneed`/`markReneedUsed`）、`reneed.js`、`embedders/local.js`、`embedders/errors.js`、`retrieve.js`、`config.js`、`runtime/metrics.js`、`runtime/commands.js`、`memory/export.js`。
3. 读 `test/v042-regression.test.js`（8 例）、`test/v042-e2.test.js`（6 例）、`test/reneed.test.js`、`test/status-vector.test.js`、`test/config-vector.test.js`，逐条映射到源码行号。
4. 写临时脚本 `tmp-review-a.mjs`（在 `:memory:` store 上复现 M-1 的 used→recall 降级），复审后删除。
5. 在 HEAD 上跑默认 / `TZ=UTC` / `TZ=America/Los_Angeles` 三时区 `node --test`；用 `git worktree` 在 `v0.4.0`、`v0.4.1` tag 实测用例数（626/646），完成后移除 worktree。
6. 交叉核对 `docs/s0-calibration.md`、`docs/embedding.md`、`docs/known-debt.md`、`README.md`、`docs/usage.md`、`CHANGELOG.md`。
7. 检查 `git status`、`git log origin/main..HEAD`、`git tag`、`memory/` 与 profile 是否被动。
