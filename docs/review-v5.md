# Review v5 — v0.3.2 修复项关闭核验（v0.4.0 发布前）

- 审查基线：`review-code-v0.3.2.md` 七类问题（R-M1/R-M2/R-L1/R-L2/N-L1/N-M3 + W4/W5 并入项）。
- 审查对象：HEAD `2d2982c`（提交链 `9380a61`→`bd0bcf9`→`33a7294`→`4b9b2a4`→`f05265e`→`c68d11e`→`bb7e547`→`2d2982c`，共 8 个功能/文档提交）。
- 审查方式：只读代码审查 + 仓库外并发探针亲自验证（task_run/thread_run 真共享执行槽）、`node --test` 三时区全量回归、文档与 schema/07 §7.5 交叉核对。审查期间未改任何 `src/` 实现。
- **结论：pass**（H=0，M=0，L=2）。允许进入 v0.4.0 发布流程（打 tag / 升版本由发布卡处理）。

---

## 1. 结论

| 项 | 状态 | 核心依据 |
| --- | --- | --- |
| R-M1 外部压缩吞掉未巩固内容 | **关闭** | `src/index.js:723-742` `resolveReanchor` 按位置取替换节点 + lost 前挪锚点；`runPreStep` 生产接线；指标与 e2e 场景 B 齐 |
| R-L1 锚点按位置取 | **关闭** | 同上（替换候选 `fresh[0]`，不再 `Math.min`）；全仓库残留 `Math.min` 仅 `src/index.js:3016`（分页，无关） |
| R-M2 thread_run 持槽真机退化 | **关闭** | `src/runtime/tools.js:58-124` 句柄直传/warn+metric/900s 兜底；并发探针 21/21 实测两工具互斥真共享单槽 |
| R-L2 冷启动锚点哨兵 | **关闭** | `src/index.js:653/773-774` -1 哨兵，`initialWatermark(:696-702)` -1→0；`test/watermark-anchor.test.js` 5 例含冷启动 |
| N-L1 确认词边界+否定守卫 | **关闭** | `src/memory/reinforce.js:31-98` 纯函数 `isConfirmation`，整句/小句边界/句首短尾 + 否定左卫 |
| N-M3 RSS 三档可配置 | **关闭** | `src/config.js:35-37/319-323` 三键+严格递增校验；`budget.js:26/42`、`index.js:1259`、`commands.js:419` `/状态` 展示；默认值与 v0.3.2 硬编码一致 |
| W4 embedding 可插拔 | **关闭** | `src/memory/embedders/*` 三实现+统一接口；schema v6 `embedder_id` 隔离；remote 双闸（配置+`frontend` 后置校验）；**`package.json` 无 `dependencies`** |
| W5 S0 首次再需要埋点 | **关闭** | schema v7 三列+列检测迁移；`store.js:1233-1253` `first_reneed_at IS NULL` 幂等；三接线（recall/dedupe/correction）齐；`docs/s0-calibration.md` SQL 与实际列一致 |
| 文档收口（t8） | **关闭** | `docs/known-debt.md` 与 `memory/docs/07-风险与里程碑.md` §7.5 九项一一对应，无「待实测」写成「已通过」 |
| 回归 | **通过** | 默认配置路径同 v0.3.2；`node --test` 默认 TZ / `TZ=UTC` / `TZ=America/New_York` 均 **626 pass / 0 fail**（16 suites）；`git status` 干净 |

## 2. 逐项核验（文件:行号）

### 2.1 R-M1 + R-L1（t1，`9380a61`）

- **位置算法**：`src/index.js:723` `resolveReanchor(previous,current,watermark)` 纯函数。替换节点候选取按位置得到的 `fresh[0]`（`:741`；lost>0 时锚点回退到 `seqs[replacementIdx-1]`，`:742`），把平台摘要节点纳入 `(anchor,end]` 巩固窗口；不再比较 seq 值取 `Math.min`。四分支 no-history→0 / remapped→`current[0]` / replacement / replacement-lost 均有单测（`test/reanchor.test.js` 6 例）。
- **lost 统计与指标**：lost = previous 水位之后不在 current 的未巩固节点数；`ensureWatermark` `inc('watermarkReanchors')`（`src/index.js:775`）、`inc('compactionLostUnconsolidated', lost)`（`:776`）并 warn 带 mode/lost。`/状态` 显示两计数（`src/runtime/commands.js:518-524` 区域）。
- **生产接线（pre-step 驱动，非 self-wired）**：`runPreStep` 在重锚非 0 变更后 `forceRebuild:true` 刷新 surface 并二次 `ensureWatermark`（`src/index.js:877-889`）——外部压缩新增的替换节点（无正文）会因 missing>0 被强制走巩固，实测接线真实。
- **e2e 场景 B**：`test/e2e/external-compaction.test.js:158` 起——turn 内巩固 → 外部 `compactSession` 生成 `[compacted]` 替换节点 → 下一轮断言：推断水位≥4、巩固输入含 `[compacted]`、`upto_seq:[1,4]`、episodes=2、warn meta `mode=replacement-lost` 且 lost=2（`:209-213`）、`/状态` 显示 2、锚点清除。场景走 runPreStep/巩固管线（非直接调 helper），非 self-wired。
- `test/fakes/ctx.js` 的 `readSurface` 改为按 `session.surface.nodes` 逐位 1:1 返回，消除了压缩后事件/正文错位——fixture 修正方向正确。

### 2.2 R-M2（t2，`bd0bcf9`）+ 亲自并发探针

- `src/runtime/tools.js:58` `holdExecSlotUntilIdle(platform,target,{sessionId,action,key,metrics,timers})`：create 分支直传 `createdHandle`（`tools.js:527/574`，不再靠 ctx.agents 反查）；whenIdle reject → warn（含 action/key/sessionId/reason）+ `threadSlotFallback` + **槽确实释放**（`:107-124`）；注入定时器 900s（`THREAD_SLOT_HOLD_MAX_MS=900_000, :36`）→ warn 带 maxMs + `threadSlotTimeout` + 释放（`:108-119`）。timers 可注入、unref 语义不变。
- `src/task/run.js:249` `defaultRunner` 单例：`task_run` 与 `thread_run` 走同一 `tryAcquireExecSlot/releaseExecSlot`（`:268/:273`）——真共享 1 槽 + 2 队列，非两套槽。
- **并发探针（本次复审亲自执行，仓库外 `D:\test\agent-plugin\_probe-t9\probe-slot.mjs`；fake platform+store、真实 `createTools`+registry 单例）：21/21 PASS**
  - A：`thread_run` 持槽后 `active=1`；同刻发起 `task_run` → queued，且 250ms 观察窗内不提前完成；线程 `whenIdle` resolve 后 task_run 才执行、stats 清零 → **互斥真实，无并发进入执行态**。
  - B：reuse 反查失败（ctx.agents 缺项）→ warn meta {action:'create', reason:'resolveAgent failed: …'}、`threadSlotFallback=1`、槽释放后可再取。
  - C：reuse 分支正确传 sessionId 挂 whenIdle。
  - D：注入假定时器立即触发 → `threadSlotTimeout=1`、warn 带 maxMs=900000、槽可复用。
- 文档：`docs/usage.md` 新增执行槽小节（busy/排队差异 + 主会话话术），与 `docs/known-debt.md` §3 N-L4a/b 一致。

### 2.3 R-L2 + N-L1（t4，`4b9b2a4`）

- **R-L2**：`src/index.js:640` `watermark_anchor:` 前缀 meta；`readWatermarkAnchor(:653)` 只认 >0 或 `-1`；`writeWatermarkAnchor(:673)` 以 0/null 清空；`ensureWatermark(:773-774)` 重锚起点（anchor=0）落库 `-1`；`initialWatermark(:696-702)` 将 -1 还原为内存水位 0、正数按值、null 走旧 upto_seq——冷启动不再把哨兵误判为「有锚点=重锚过」而跳过整段抽取。`clearWatermarkAnchor(:682)` 在巩固完成（:1504）与重启路径（:1757、:2095）清除。`test/watermark-anchor.test.js` 5 例（含 -1 还原 0、no-history 落 -1、重启后不重锚）。
- **N-L1**：`src/memory/reinforce.js:31` `CONFIRMATION_WORDS` 常量 + `:67-98` `isConfirmation(text)` 纯函数：trim、去句末标点后按整句 / 独立小句（前后边界）/ 句首 + ≤2 个语气短尾三位置条件匹配；命中片段自身字符剔除后再跑否定正则 `:40` `/不|没|别|错|未必/`——「没错吧？」正确命中（句首短尾），「好像不太对」被否定守卫拦截，「对比一下」不再误判。`test/confirm.test.js` 6 例 + e2e「对比一下」α=2 保留「对/记住了」α=4。`src/index.js` 本地子串判定已删除，`reinforceOnUse` 走纯函数。

### 2.4 N-M3（t3，`33a7294`）

- `src/config.js:35-37` 三个默认键 `rssWarnGiB=2.95 / rssStopGiB=3 / rssMainOnlyGiB=3.15`（与 v0.3.2 硬编码三档完全一致 → 默认路径回归）；`:319-323` `requirePositiveNumber` + 严格递增校验（warn<stop<mainOnly，坏值 `ConfigError('rssWarnGiB'|'rssStopGiB')`）。
- `src/runtime/budget.js:26` `DEFAULT_RSS_GIB`、`:42` `rssLimitsFromConfig`（缺失/非法/乱序退默认值，`RSS_*_BYTES` 兼容导出）；`src/index.js:1259` `runRssCheck` 用配置换算 bytes，`:1212` `budgetInfo` 暴露三档 GiB；`src/runtime/commands.js:419` `/状态` 新增 `RSS 阈值：warn XGiB / stop YGiB / main_only ZGiB`（无 rssLimits 保持旧格式）。
- 自检公式：`src/calibrate/formula.js:81` `suggestRssLimits(memoryBudgetBytes)` warn=min(2.95,0.88B)、stop=min(3,0.96B)、mainOnly=min(3.15,1.04B)，强制递增；4GiB→预算 2.5GiB→建议 2.2/2.4/2.6，64GiB→封顶默认值。`docs/calibration.md`、`README`、`docs/usage.md`、`config.example.yml` 同步。

### 2.5 W4（t5，`f05265e`）

- **接口与三实现**：`src/memory/embedders/index.js` `createEmbedder(vectorConfig,deps)` → `{id,dim,kind,embed(texts)->Float32Array[]}`；`hash`（默认，零依赖）/ `local`（动态 import `@huggingface/transformers`，可选依赖，未装抛 `EmbeddingUnavailable`）/ `remote`（POST 批量、Bearer 从 `process.env[apiKeyEnv]`、AbortController 超时→`EmbeddingTimeout`）。
- **remote 默认关 + 双闸**：`src/config.js:56-61` `remote.enabled:false`；`embedders/index.js` 仅 `remote.enabled===true` 才装配 remote，否则 null。启动时 `src/index.js:209-211` 显式 warn「memory text will be sent to a third party」。**隐私过滤在 store 侧**：`src/memory/store.js:663-697` `listVectorBackfill` 只取 `status='active' AND deleted_at IS NULL AND privacy='normal'`（+治理 sensitive 列存在时过滤）——墓碑/superseded/secret 不进 embedder，前提成立。
- **embedder_id 迁移与召回隔离**：schema v5→v6 ` ALTER fact_vectors ADD embedder_id NOT NULL` 并回填 `'hash:'||dim`（`store.js:819-827`）；写入路径带 id；检索/hybrid 只召回当前 id 的向量（v5/v6 行不会混用）。
- **超时/失败降级**：`src/index.js:1137-1140` `vectorConfig`——embedder 未装配（关/none/remote 未启/local 未装）强制 `enabled=false` 退纯 FTS；`:1149-1156` `retrieveVectors` 收 `vectorError` → `inc('vectorEmbedFailures')` + warn，不阻塞 turn；`:1164-1199` `backfillVectors`（idle-probe `:2197` 调用，每批 `backfillBatchSize≤50`）失败仅 metric+warn。`/状态` 显示 `向量：开·dim·id·已回填 N`。
- **主包零依赖**：`package.json` `dependencies` 为空（无任何依赖），`local` 的 `@huggingface/transformers` 未被列入，符合要求；version 仍 0.3.2（发布卡处理）。

### 2.6 W5（t7，`bb7e547`；t6 文档 `c68d11e`）

- **schema v7 迁移**：`src/memory/store.js:47` `SCHEMA_VERSION='7'`；v7 按列检测 ALTER `facts` 增 `first_reneed_at/first_reneed_tier/reneed_kind`（nullable，旧行 NULL）+ `ix_facts_reneed(scope,first_reneed_at)`（`:225-227/733-734/778-782`）；`docs/usage.md:620` 与 README:176 均同步为 v7（含 v5→v6 向量、v6→v7 facts 两段描述，与代码一致；t7 遗留的 usage.md:596/embedding.md:59 旧 v6 表述已在 t8 改正为 v7）。
- **幂等 + 只记首次**：`store.markFirstReneed`（`store.js:1233-1253`）`UPDATE ... WHERE first_reneed_at IS NULL`，tier/kind 白名单校验（`:62-64`）；覆盖率/e2e 断言「二次不覆盖、不得复活」。
- **三接线（生产路径）**：①召回 full/gist → `tier=clear/ambiguous, kind=recall`（`src/index.js:1872-1876`，dropped/pinned/墓碑不入集）；②巩固去重命中沉睡/墓碑/已删/active-but-R<0.2 旧行 → **同一事务**写 `miss/dedupe` 且不插入草稿不复活（`consolidate.js:547-580`，判定 `isReneedMissRow :364-377`）；③用户纠正 → supersede 前写 `miss/correction`（`src/index.js:3125-3126`），首样本不覆盖。
- **文档 SQL 与实际列一致**：`docs/s0-calibration.md:86-110` SQL 用到 `first_reneed_at/first_reneed_tier/reneed_kind/recall_count/created_at/source_kind/salience/deleted_at` 全部存在于 `facts` DDL（`store.js:198-227`）；「`recall_count` 只在强化 +1」与代码一致（`store.js:1416` 唯一自增点；recall 注入不写）；S0 表 `SALIENCE_STRENGTH_DAYS`（`store.js:52-58`，3/14/60/365/∞）与 01 §5.6 一致；§9 变更表留空、分位数标注「起始值，待定」，未编造数据。
- **不自动调 S0**：全仓库无读 `first_reneed_*` 参与调参的代码路径，埋点只写不读。

### 2.7 文档收口与 known-debt（t8，`2d2982c`）

- `docs/known-debt.md` §1 九项 G0 与 `memory/docs/07-风险与里程碑.md:451-463` §7.5 **逐项一致**（G0-2 24000/40000/6144/compactRegion/`auto:false`；G0-3 40K/300K/3M/46M/90M；G0-4 1.30/2.92/红线 3.2；G0-6 7 份滚动/7+7 天；G0-7 V7；G0-8 V8 ≤800；G0-9 G-M1/M4/M5/M6），并明确「运行清单，不新增判据」。
- **诚实性抽查通过**：没有把「待实测」写成「已通过」。真机依赖项全部保留状态：G0-1/2/3/4/6/7/8 为「代码侧已实现，待真机确认」；G0-5/G0-9 与探针项为「探针已覆盖，剩真机复测」；H3（GUI 双会话分流）明确「仍未关闭」。技术债 D-1（worker 无 token 上限，P1 前必须）、D-2（`govern.js:269-289` PRAGMA `ignore_check_constraints` 绕过 CHECK——代码属实）、D-3（`deepConsolidate` `src/index.js:2059` 用 `state.transcript.length` 判主会话、`:2871-2874` scope 切换——问题属实）、D-4（local 真机加载未测）、D-5（Linux 2C4G 复测）均给出现状/影响/排期/验收方式，与代码现状核对相符。
- `docs/known-debt.md` N-L4a/b 描述与 t2 实测行为一致（含 900s 兜底与 busy/排队语义）。

## 3. 新增发现（分级）

- **L-1**（口径微差，无需本版修复）：`consolidate.js:364-377` `isReneedMissRow` 对 active 旧条的判定是 `decayOf(...) < 0.2`，即包含 R<0.05（连 index 档都召不回）的样本；而 `docs/s0-calibration.md:15/128` 把「漏·去重」写成「0.05≤R<0.2」。两者在「该条已不该期待召回」的判定上等价偏宽（R<0.05 也可记 miss，方向合理），但文档口径未写明 R<0.05 部分。建议下次改文档时补一句「active 但 R<0.05 一并记 miss（召回本已不可达）」。
- **L-2**（记录性）：`docs/s0-calibration.md:95` SQL 依赖「recall 注入不写 `recall_count`」这一不变量（当前 `recordRecalledFacts` `src/index.js:1855-1884` 确实不写，唯一自增在 `store.js:1416` 强化路径）。该不变量没有任何测试显式钉住，若后续有人把 recall_count 从「用上才强化」移到「注入即计」会静默污染 S0 统计。建议在 S0 计时启动前的改动评审里把这条加入关注清单（或加一条断言测试）。

无 H 级、无 M 级发现。

## 4. 对 v0.4.0 发布的前置条件

1. **发布卡负责**：升 `package.json` 版本到 0.4.0、打 tag、push（本次复审未做，保持不动）。
2. **不需要阻塞发布**：`known-debt` D-1/D-2/D-3/D-4/D-5 与 G0 真机项已在文档中明确排期（D-1 为 P1 前必须、D-5 为云端前必须、D-4 为用户开启 local 前必须），均非 v0.4.0 tag 的前置。
3. **发布说明需包含**：schema v5→v7 迁移（旧库升级后旧行 `first_reneed_*` 为 NULL、旧向量行 `embedder_id='hash:<dim>'`）；remote embedding 显式开启才会外发记忆文本（启动 warn）；RSS 三档默认值不变（2.95/3/3.15），4G 机器按 `docs/calibration.md` 公式降为 2.2/2.4/2.6。

## 5. 本次复审验证记录

| 验证 | 结果 |
| --- | --- |
| `node --test`（默认时区） | 626 pass / 0 fail（16 suites） |
| `TZ=UTC node --test` | 626 pass / 0 fail |
| `TZ=America/New_York node --test` | 626 pass / 0 fail |
| 并发探针（task_run × thread_run 单槽互斥 / fallback / 900s 兜底） | 21/21 PASS |
| `git status` | 干净（复审期间未改 `src/`） |
| 文档链接与 schema 版本交叉核对 | README/usage/embedding/known-debt/s0-calibration 全部指 schema v7，无残留 v6 权威表述 |
