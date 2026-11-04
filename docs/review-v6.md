# 复审 v6：E-M1 / S-M1+L-2 修复与 v0.4.1 准备（t5）

- 复审人：reviewer（独立复审，不产出实现）
- 日期：2026-11-04
- 基线：`7578fc9`（v0.4.0 发布基线）
- 被审提交（`git log 7578fc9..HEAD`，均未 push）：
  | 提交 | 卡 | 内容 |
  | --- | --- | --- |
  | `7270417` | t1 | E-M1：local embedding 加载/推理超时与异步预热 |
  | `39addbb` | t2 | S-M1+L-2：used 口径 / same_context / schema v8 / 确认词长度上限 |
  | `6ec092e` | 队长 | 1 行注释 |
  | `2e21c6e` | t3 | 集成/回归测试 + 退避竞态与 CRLF 稳定化 |
  | `b60e4a0` | t4 | 文档；**附带**：并发 amend 带入 2 行测试计时余量 100/120→300ms（`test/embedding-local-timeout.test.js`、`test/v041-regression.test.js`），与文档改动同提交但不属 t4，属良性附带（避免并发窗口内丢测试改动），已核实其内容仅放宽计时余量、不改断言语义 |

## 结论：**pass**

H（阻塞级）= 0，M（需返工）= 0。5 张候选 L 级发现均不阻塞发布，逐条列在 §6。`docs/known-debt.md` 剩余项与实现状态一致，无「未修写成已修」「待真机写成已验证」的失实表述。

---

## 1 E-M1：local embedding 超时、预热与失败分类

### 1.1 静态依据（文件:行号）

- `src/memory/embedders/local.js:107-119`：ensureExtractor 用 `withTimeout(pending, timeoutMs)` 限制「等待加载完成」，超时抛 `EmbeddingTimeout`；`local.js:139-146`：推理同样被 `withTimeout(timeoutMs)` 包裹。加载与推理**都**受 `embedTimeoutMs`（默认 300ms，`DEFAULT_TIMEOUT_MS`）约束。
- `local.js:14-24`：`DEFAULT_TIMEOUT_MS=300`、`DEFAULT_RETRY_BASE_MS=1000`、`DEFAULT_RETRY_MAX_MS=60_000`、`DEFAULT_MAX_LOAD_ATTEMPTS=5`。
- `local.js:63-66`：后台加载硬上限 `loadTimeoutMs = max(timeoutMs*20, 180s)`，非配置键，符合「被审代码不得新增配置键」。
- `local.js:71-95`：`classifyLoadFailure` —— 缺依赖（`ERR_MODULE_NOT_FOUND`/`MODULE_NOT_FOUND`/`Cannot find module`，递归查 `cause`）→ `fatal`；页面/初始化失败（`EmbeddingUnavailable`）→ `transient`；其余网络/超时 → `transient`。
- `local.js:97-105`：`warmup()` 在退避窗口内直接 reject `lastError`，不发起新 import（防重试风暴）。
- `local.js:120-129`：退避 `nextRetryAt = now + min(retryBaseMs * 2**(failures-1), retryMaxMs)`，`failures>=5` 后进入 `retryMaxMs`（60s）长冷却；`maxLoadAttempts` 达到后不再把 failures 重置，但 `disabled` 仍为 false → **不会永久停用**（与 fatal 停用路径互斥）。
- `src/index.js:222`（apply 内）：`prewarmEmbedder(state)` 不 `await`，turn 路径不等它。
- `src/index.js:2373`（idle-probe scheduler）：每轮空闲探针都调 `prewarmEmbedder` → 加载完后下一轮可走向量。
- `src/index.js:1282-1292`（retrieveVectors）：`embedder.disabled` 时以 `vector.enabled=false` 调 retrieve → 纯 FTS 且不再触发 import；`src/index.js:1303-1310`（backfillVectors）：`embedder.status()!=='ready'` 时只预热并 return 0 → 回填不阻塞、不加压。
- `src/memory/retrieve.js:436-439`：`vectorError` 增加 `kind`/`transient`/`fatal` 字段，记入指标 `vectorEmbedLoadFailures` / `vectorEmbedFatal` / `vectorEmbedFailures`，日志按 `embedderWarmupState` 键去重。
- `errors.js:31-40`：`EmbeddingUnavailable` 携带 `fatal`/`kind`（`'transient'|'fatal'|'unavailable'`），默认由 fatal 推导 → 上层可判别。
- 默认路径（`vector.enabled=false` 或 embedder 非 local）未触碰 import 逻辑：`src/index.js:1282` 只在 embedder 存在且非 disabled 时走向量分支，与 v0.4.0 行为一致（在探针 A 中亦验证 recall 在本机无 `@huggingface/transformers` 时不报错、不超时）。

### 1.2 亲自验证（探针 + 真实调用链，非仅看单测）

写探针 `.t5-probe.mjs`（复审后已删除）在干净构建产物上跑：

- **探针 A（真实 apply() 全链路）**：本机未安装 `@huggingface/transformers`，`vector.embedder=local`。结果：`apply()` 全流程 ~20ms；诊断显示首轮 pre-step 仅 9-12ms（< embedTimeoutMs=300ms）→ **首次加载不再阻塞 turn**；真实召回注入 `[相关记忆]`（蓝鲸等示例条目）由 FTS 返回，**无异常抛出**；`warn` 日志含 `kind=fatal, reason=not installed` → fatal 停用路径生效。
- **探针 B1（慢 loader / 慢 extractor）**：注入 loader 使加载耗时 >400ms。结果：等待 202-205ms 后抛 `EmbeddingTimeout`（`errorName=EMBEDDING_TIMEOUT`，`transient=true`），`status()=='loading'`（后台仍在加载）→ 符合设计「超时不中断、后台继续」。加载完成后用慢 extractor 触发推理，超时 203-209ms 抛出同类型 transient。推理失败（`boom`）→ `EmbeddingUnavailable, kind=transient`。
- **探针 B2（缺依赖 fatal vs 网络 transient+退避）**：缺依赖场景 `fatalLoads=1` 且之后不再 import（fatal 停用）；网络错误场景：窗口内再调 `warmup()` **立即** reject（不打网络，`netLoads` 保持 1），过窗口后重试 `netLoads=2`、`attempts=2`、`nextRetryAt` 按 2^n 从 1.1s 递增到 1.31s（探针注入 `retryBaseMs=100` 以缩短时间）→ 退避曲线与文档一致。
- 任务 t3 的 `test/v041-regression.test.js`（7 条）与 `test/embedding-local-timeout.test.js` 也覆盖同场景（首载超时回退 FTS → 下一轮走上向量 / fatal vs transient 分类 / 重试竞态），探针结论与之互相印证。

---

## 2 S-M1：used 只统计「用上」+ same_context 排除

### 2.1 静态依据（文件:行号）

- `src/index.js:1010`（reinforceOnUse 内）：`if (overlapRatio(fact.statement, assistantText) < USE_OVERLAP_THRESHOLD) continue;` —— 重叠 <0.6 时**不写** used、不计 `reinforcements` 指标；重叠 ≥0.6 才走 `state.metrics.inc('reinforcements')` + `markUsedReneed`。**used 只在强化路径写**。
- `src/memory/reneed.js:1-15`：`RENEED_KINDS=['recall','dedupe','correction','used']`；`SAME_CONTEXT_MIN_INTERVAL_SECONDS=6*60*60`。
- `reneed.js:24-42`（isSameContextSample）：`sourceInSurface=true` 即同会话（episode 来源仍在 surface）；否则按 `Δt < 6h` 判定；`Δt<0`（时钟回拨）保守 `false`（不当同会话）。
- `reneed.js:47-64`（episodeSourceInSurface）：用 `consolidations.upto_seq` 与当前 `snapshot.seqs` 判断「来源 episode 还在 surface」，避免已被巩固移出 surface 的旧记忆误判同会话。
- `src/memory/store.js`（S-M1 相关）：
  - `SCHEMA_VERSION='8'`；`facts.same_context INTEGER NOT NULL DEFAULT 0 CHECK(same_context IN (0,1))`。
  - 迁移整体 `BEGIN IMMEDIATE/COMMIT/ROLLBACK`（`#migrate` 顶层单事务，`#migrateFrom` 各分支不再嵌套 BEGIN）；v7→v8 只补列+建触发器，v3-v7 各路径幂等。
  - `#ensureReneedKindTriggers`：`CREATE TRIGGER IF NOT EXISTS trg_facts_reneed_kind_ins/upd … RAISE(ABORT,'invalid facts.reneed_kind')` → 非法 kind 在 SQL 层不可写入。
  - `markReneedUsed` SQL：`UPDATE facts SET reneed_kind='used', first_reneed_at=COALESCE(first_reneed_at,?) WHERE id=? AND (first_reneed_at IS NULL OR reneed_kind='recall')` → 只升级 `recall` 或从 NULL 起步；`dedupe`/`correction` 不被 used 覆盖；`used` 不被二次刷新。
  - `markFirstReneed`：`WHERE first_reneed_at IS NULL` → 幂等，樣本首次时刻不可被复述覆盖。
- `src/index.js:1042-1056`（recordRecalledFacts + lastRecallSamples）：召回注入时 `markFirstReneed(kind='recall', sameContext=isSameContextSample(...))`，并把样本存入 `state.lastRecallSamples`（Map，in-memory）。`markUsedReneed(state,id,fact,at,samples.get(id))` —— 有样本时沿用其 tier/sameContext；无样本时 `tier` 退化为 `fact.fidelity`，`sameContext` 用 `isSameContextSample` 重算并保留 SQL 里已有的 `first_reneed_at`（COALESCE）。
- export：`src/memory/export.js` `CURRENT_SCHEMA_VERSION='8'`。

**「被注入」不再被当成 used 的机制链**：注入只写 `recall` + `same_context`，不入主样本；复述重叠 ≥0.6 才升级为 `used`，升级时的 `same_context`/tier **沿用首次注入样本**，不由「升级时刻」重算，因此「同会话即时复述」的样本仍保留 `same_context=1`，被主查询排除。

### 2.2 亲自验证

- **探针 C（store v8 / used / same_context / 迁移幂等 / 触发器 / L-2 边界）**：
  - `markFirstReneed` 第二次调用返回 `again=false`，首次时刻 `at=100` 保持、`kind='recall'` 保持；
  - `markReneedUsed` 升级后 `reneed_kind='used'`、`first_reneed_at` 仍为 100、`same_context=0` 保留；
  - 已是 `dedupe` 的行不被 `markReneedUsed` 覆盖；
  - 直接 `UPDATE facts SET reneed_kind='nonsense'` 被 `'invalid facts.reneed_kind'` 触发器拒绝；
  - `getMeta('schema_version')=='8'`；重开库后 `used` 与时间戳保留 → 持久化正常。
  - L-2 边界：`['对','没错','嗯，对。'] isConfirmation==true`，两条长确认语 false；5/5。
- **真实 v7 fixture 迁移**：`test/v041-regression.test.js:477` 用裸 `DatabaseSync` 直接造 v7 库（模拟真实旧数据）、连续打开两次（验证幂等）→ 升到 v8，旧行 `first_reneed_at=1_700_000_100`/tier/kind 保留、`same_context=0`、触发器生效。
- **e2e 同会话链路**：`test/v041-regression.test.js` 的 S-M1 集成用例（来源 episode 仍在 surface → `same_context=1` + excluded；复述升级 used；L-2 长确认句 + α=2）覆盖。

### 2.3 统计口径与 s0-calibration.md 一致性

`docs/s0-calibration.md`：
- §1 表述「用上为主（used）、注入仅对照（recall）」，与实现一致：主查询 `reneed_kind IN ('used','dedupe','correction') AND same_context=0`（`docs/s0-calibration.md:110-111`），**没有**再用 `recall_count=0` 过滤（有专门段落明确指出不要保留该过滤条件，否则会把全部 `used` 样本误杀——`docs/s0-calibration.md:118`），避免照抄旧口径把新 used 样本全部剔除。
- recall 仅作为对照查询单独列出（`:126`）；附 kind×same_context 审计查询，可事后核查主查询不会把 `same_context=1` 的 used 重新算进 S0。
- 主查询 `same_context=0` 与 store `same_context` 布尔语义一致；「同会话即时召回被排除」没有被推翻。

→ **没有把「被注入」重新算进 S0**；反例（老口径误过滤 used）文档已显式纠正。

---

## 3 L-2：确认词长度上限

- 实现：`isConfirmation`（`src/memory/confirm.js` 相应函数）去掉标点后文本长度 >10 → 直接 `false`；句首仍要求确认词开头。
- 单测：`test/confirm.test.js:50-62` —— 「对，我明天要去北京开会，顺便……」「没错，明天上午十点在北京南站集合再出发去会场。」「是的，我已经把方案发给客户了，等他们回复。」「对，记得把上次说的那三个问题一起带过去。」均为 false；短确认「对」「没错」「对。」「是的！」「嗯，对。」「确实，我记住了。」均为 true。
- 探针 C 独立复核 same 5/5。

## 4 回归 / 约束

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 三时区全绿 | 646 tests / 646 pass / 0 fail | 探针记录（本机默认 / `TZ=UTC` / `TZ=America/New_York` 各跑一次 node --test） |
| 弱稳定性复查 | `test/embedding-local-timeout.test.js` + `test/calibration.test.js` 连跑 5 轮 16 pass/0 fail；`test/v041-regression.test.js` 连跑 3 轮 7 pass/0 fail — 复发敏感的退避竞态与 CRLF 用例**无 flapping** | 连跑记录 |
| 零新增运行时依赖 | `package.json` 的 dependencies/devDependencies 均无 diff（imports 仍只有 node: 内置 + 可选 `@huggingface/transformers`，仍为**可选**，v0.4.0 也是如此） | `git diff 7578fc9..HEAD -- package.json package-lock.json` 为空 |
| 未动 memory/ 设计文档 | `git diff 7578fc9..HEAD --stat -- memory/` 为 0 行 | diff |
| 未动 DSH profile | 同上，无 profile 相关文件改动 | diff |
| 未 push | `origin/main..HEAD` 共 5 提交，remote 无此提交 | `git log origin/main..HEAD` |

## 5 文档诚实性

- `docs/embedding.md`：新增小节「local 的超时与异步预热（E-M1）」—— 超时抛错、本轮纯 FTS、不重试、预热不 await、退避序列 1/2/4/8s、5 次后 60s 冷却、`loadTimeoutMs=max(20×timeoutMs,180s)`、指标名 `vectorEmbedLoadFailures`/`vectorEmbedFailures`/`vectorEmbedFatal` —— 逐项与 `local.js:14-129`、`src/index.js:1282-1310` 对照**一致**；remote 超时对齐已有说明。
- `docs/s0-calibration.md`：used 为主/注入为对照、`same_context` 排除、kind×same_context 审计查询、v8 列说明 —— 与 §2.3 校验一致。
- `docs/known-debt.md`：标题 v0.4.1；新增 D-6（L-1 remote 无查询侧敏感过滤）、D-7（L-5 remote 无调用上限/熔断）、把 L-4 归 D-8（RSS GiB 单位待 07 明确）、D-4 更新为「E-M1 已限时但真实加载路径/内存增量仍未在真机验证」；§5 记 E-M1/S-M1/L-2 已关闭并指向提交号。剩余项（D-1/D-2/D-3/piâ¸）未删、未把「待真机」写成「已通过」。
- `README.md`：已把两处过时的「schema v7 埋点」改 v8+same_context，已知限制新增 E-M1 一句（含退避与 FTS 回退）；**遗留**：README 顶部仍写「v0.4.0 已发布、626 用例」、变更摘要未提 v0.4.1、`CHANGELOG.md` 未写 v0.4.1 条目 —— 按 t4 卡面「README 顶部/CHANGELOG 由发布卡处理」，属 **L-5**，不阻塞本复盘但 t6 必须处理（见 §6）。
- 实现注释、日志、指标名与文档一致；未见「未实现却写已实现」或「已实现却写待做」的反向失实。

---

## 6 L 级遗留（不阻塞，需登记或由下游卡处理）

| # | 位置 | 内容 | 建议最小修法案 |
| --- | --- | --- | --- |
| L-1 | `src/index.js:1042-1056` (`recordRecalledFacts`/`markUsedReneed`) | 无内存样本（进程在注入与复述之间重启 → `lastRecallSamples` Map 消失）时，`markUsedReneed` 用「强化时刻 atSeconds」而非「首次注入的 first_reneed_at」重算 `sameContext`，极端情况下可能把首次已是 same_context=1 的 sample 翻成 0，进入主统计 | 已写入 `docs/known-debt.md` §5 或由 t6 后续小卡跟踪：无样本时 `at = fact.first_reneed_at`（若存在）再调 `isSameContextSample`，保留样本口径不漂移 |
| L-2 | `src/memory/store.js` `#ensureReneedKindTriggers` | 触发器里的 kind 值列表是字面量（'recall','dedupe','correction','used'），未引用 `RENEED_KINDS`；今后增删 kind 需两处同步，易漏 | 在触发器定义处加一行注释「同 `reneed.js RENEED_KINDS`」或改为由常量生成 SQL（保守做法：注释） |
| L-3 | `README.md` 顶部 / `docs/usage.md`(若涉及) / `CHANGELOG.md` | v0.4.1 版本号、用例数（646）、变更条目未更新；README 的「变更摘要」与「当前版本」描述仍是 v0.4.0 | 由发布卡 t6 处理：CHANGELOG 写 v0.4.1 条目 + README 顶部更新到 v0.4.1/646 |
| L-4 | 远程/网络退避 (`docs/embedding.md` / `local.js`) | remote 的 min/max 退避参数在文档中被提「同样退避」，但 remote 的 `warmup` 不受网络退避所约束（remote 走 fetch，超时对齐 300ms 已写明，但 remote 的重试节奏未与 local 完全对齐表述）——是**文档表述精度**问题，不是行为缺陷 | t6 发布前在 docs/embedding.md 用一行澄清「remote 不走 local 的退避状态机，仅共享 embedTimeoutMs」避免过度承诺 |
| L-5 | 本复审所遇两个工作面 | E-M1/S-M1 修复均尚未真机验证（探针是本机 Node）；known-debt D-4 已如实登记，属待真机项而非本次实施缺口 | 保持 known-debt 登记不变，随 Gate 0 真机阶段验证 |

## 7 复核后的裁定

- H=0：无阻塞（未发现会破坏召回正确性 / 数据完整性 / 默认路径行为 / 用户外观的缺陷）。
- M=0：无「必须返工才能发布」的实现问题；测试与文档与实现口径**互相贴合**，including 反例（`recall_count=0` 误杀 used）已有显式澄清。
- 判定：**pass**。E-M1、S-M1+L-2 修复符合 v0.4.0 评审补丁预期，v0.4.1 的发布前提（`review-v6.md`）满足。

---

## 附：复审动作清单（审计轨迹）

1. `git log 7578fc9..HEAD` / `git diff 7578fc9..HEAD --stat` 全量读。
2. 逐文件读被改 src：`local.js`、`errors.js`、`src/index.js`（apply→retrieve→backfill→reinforce→recordRecalledFacts 调用链）、`reneed.js`、`store.js` schema/迁移/markReneedUsed/markFirstReneed、`export.js`、`confirm.js`。
3. 写探针 `.t5-probe.mjs`（真实 loader/真实 apply()/真实 store），跑通探针 A/B1/B2/C；复审后删除，不留工作树垃圾。
4. 三时区 `node --test`；两个敏感测试文件重复连跑。
5. 交叉核对 `docs/embedding.md`、`docs/s0-calibration.md`、`docs/known-debt.md`、`README.md` 与实现。
6. `git log origin/main..HEAD`、`git diff 7578fc9..HEAD -- package.json`、`memory/`、profile —— 全部通过约束。
