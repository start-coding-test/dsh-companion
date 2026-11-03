# dsh-companion v0.1.1 独立复审（review v2，评审关闭核验）

- 审查人：reviewer（独立复审，非实现者）
- 审查对象：dsh-companion @ commit `e36f45e`（feat(budget): daily token fuse and rss degradation），A 批修复全部合入后的候选
- 审查日期：2026-11-04 01:32–01:55 (+08:00)；工作区 D:\test\agent-plugin\dsh-companion
- 方式：只读通读 src/ 与 test/（不改 src，唯一写点为本文档）；逐条 grep + file:line 核验；全量回归复跑（见 §回归）。

## verdict: pass（H=0，M=1，L=2）

A 批修复逐条关闭：H1–H6 全部通过（附 file:line 证据与反例测试）；M1–M4 全部通过；首批 L 项与 W3 已落地。新增 1 项 M 级发现 [N1]（巩固模型提示词文本仍取 transcript 窗口，与 surface 选区存在截断错位风险——选区/水位已与 transcript 解耦，仅模型输入文本未对齐；按「H=0 且 M≤2 → pass」判据不阻塞 v0.1.1，建议随下批修复）与 2 项 L 级备查 [N2][N3]。

## 一、回归证据

| 命令 | 结果 |
|---|---|
| `node --test` | **376 tests / 16 suites，376 pass，0 fail，0 skipped**（exit 0，duration ≈1412ms） |
| `TZ=UTC node --test` | **376/376 pass，0 fail**（exit 0，duration ≈1396ms） |
| `node --check src/**/*.js scripts/**/*.js` | 全部通过（fail=0） |
| `git status` | 写文档前 working tree clean（HEAD e36f45e） |

CI `.github/workflows/test.yml`：`runs-on: ubuntu-latest` + `node --test` 且无时区依赖路径（M1 联查，实际等价 UTC 环境）。

## 二、逐条 finding 表（外部评审 A 批 → 本轮核验）

| id | 严重级 | 状态 | 核验证据（文件:行号 / 命令输出） |
|---|---|---|---|
| H1：巩固/压缩/水位全部改用 surface seq | H | ✔ 关闭 | `grep turnSeq`、`grep lastCompactedSeq` 全 src **0 命中**。巩固窗口 = `planRegion({afterSeq: watermark, budgetTokens: config.retainTokens})`（src/index.js:962-965），`consolidate({seqFrom: region.startSeq, seqTo: region.endSeq, guardWatermark:false})`（index.js:993-1004）；pendingCompact 记 `{id,startSeq,endSeq}` surface seq（index.js:1017-1023）；区间失效丢弃并计 `compactionDrops`（index.js:1089-1101，测试 test/e2e/surface-seq.test.js:149-170）；`platform.compactRegion(start, end)` 入参是区间 seq（index.js:1103-1106）；压缩后 `forceRebuild` surface → `watermarkAfterCompact` → `setWatermark` + `retargetConsolidation(uptoSeq)`（index.js:1114-1121；src/memory/store.js:1632-1641，upto_seq 原位重写）；`getWatermark` 改「最新 written/compacted 且 kind≠forget_flush」语义（store.js:1614-1624），规避压缩后非单调 seq 的 MAX 误读。反例测试存在：`surface-seq.test.js:108-147`「seq 从 7 开始也不当成 log 下标」断言 turn_from=7、compactRegion args=[7,9]、压缩后水位改写为替换节点 seq 11 且 `compaction_start_seq=7`；库级反例 test/session-surface.test.js:79-104（seq 非 log 下标 / 水位按位置比较 / stale-watermark 不从头重来 / watermarkAfterCompact 三分支 :119）。 |
| H2：巩固不再依赖 captureTranscript 40 条/6000 字符窗口 | H | ✔ 关闭 | 选区与水位不读转录：`planRegion` 由 surface `seqs/nodes/records` 计算，尾部预算自后向前累计（src/session/surface.js:126-184），`CONSOLIDATION_TAIL_TOKENS=6144`（surface.js:20），尾部保留测试 test/e2e/surface-seq.test.js:224；正文缺失计 missing 并降级跳过（surface.js:162-180、index.js:974-980；测试 surface-seq.test.js:202-210「降级跳过，不写半截 episode」）。冷启动回填：`sessionQuery.readSurface()` 每会话一次（src/session/surface.js:235-245 段），测试 test/session-surface.test.js:161-176（只回填一次断言）与 e2e surface-seq.test.js:179。索引经 `session/event` 增量 + `deriveEventMessage` 投影 + `estimateMessage` 计价（surface.js:255-282）。残留（见 N1）：captureTranscript 仍存在（index.js:74-75、529、1861-1879）但只服务模型提示词文本与强化判定，已不参与水位/选区/压缩目标。 |
| H3：main/thread/subagent 分流与 scope 隔离 | H | ✔ 关闭 | `routeSession` 于 pre-step 顶部分流（index.js:444-471），subagent 直接 return null 且计 `subagentSkips`（index.js:508、455-461）；分类器 src/session/identity.js：`threads.session_id` 命中 → thread（scope=`thread:<key>`）、未知 main 告警仍按 main；线程唯一索引 `ux_threads_session`（store.js:235-236）；thread_run 落库 `session_id`（tools.js:416-424）；工具 scope 闸门 `resolveScope`：当前 scope 为 null（subagent）→ `scope_denied`，显式 scope 不符 → `scope_denied`（tools.js:98-108）；跨 scope 水位/转录/巩固隔离（index.js:479-497、519-530；watermarkByScope/transcriptByScope/surfaceSnapshotByScope）。测试 test/session-identity.test.js（9 例）+ test/e2e/session-scope.test.js（123 main/thread 隔离、172 thread 巩固不写 main、222 subagent 零召回零模型零写库+工具 scope_denied、265 未知 main 告警）；l-m3.test.js:130（memory_search scope_denied / thread 默认 scope）。 |
| H4：遗忘闭环（S1 + 定向巩固 + 立即物删 + 状态板清洗） | H | ✔ 关闭 | src/memory/forget.js：S1 tombstone+deleted_at+purge_payload；定向巩固 `consolidate({kind:'forget_flush', excludeFactIds:[id]})`（forget.js:105-107；consolidate.js 过滤 statement 相等/互相包含并返回 excluded 计数）；非立即返回 `purgeAt=at+7d`（forget.js:156-157），立即经 `store.purgeIds`（forget.js:164-169；store.js:1829-1837，只删 deleted_at 非空行，actor='user'/reason='forget'）；遗忘后重渲染→`scrubBoardText`→stage→`publishBoard('forget')`（forget.js:141、156 段）。purge 清扫：`#purgeRows` 先断 FK（facts/reminders/state_board→episodes、facts.superseded_by→facts，store.js:1868-1900），再删 FTS+主表（store.js:1902-1917），PURGED 审计 `detail_json:{salience}` 无正文（store.js:1905-1926）。测试 test/e2e/forget-pipeline.test.js 12 例覆盖：S1 停读/冷静期/满 7 天 purge（:62）、immediate+confirm（:98、命令层 :297-324）、幂等且不误删 active（:127）、板清洗+publish('forget')（:146）、定向巩固不写回（:209）、PURGED 无正文（:280）、工具结构化返回（:331）。 |
| H5：用上才强化（REINFORCE、α=2/4、pinned/墓碑跳过、每轮一次） | H | ✔ 关闭 | 导出 `DEFAULT_ALPHA=2.0 / CONFIRM_ALPHA=4.0 / USE_OVERLAP_THRESHOLD=0.6`（src/memory/reinforce.js:19-25）；`reinforceOnUse` 在 pre-step 中先于本轮注入调用（index.js:531-533），跳过 pinned（index.js:651）、墓碑/已删（:650）、非 active（:652），重叠 <0.6 跳过（:653），强化走 `applyReinforcement` 写 REINFORCE 审计（:655-669）；失败仅 warn 不阻断（:670-677）。测试 test/memory/../reinforce.test.js 单测 7 例（pinned 不加、墓碑/已删/非 active 不炸）；e2e reinforce.test.js:83 复述→α=2 公式精确匹配 + **同一 turn 后续 step 不重复强化**（recall_count=1、事件长度=1）；:145 确认词→α=4 精确匹配。 |
| H6：task_run 工具 | H | ✔ 关闭 | src/task/run.js：`MAX_EXEC_SLOTS=1`、`MAX_QUEUE=2`（run.js:32-36）、Goal/Title 码点上限 2000/80（:38-42）；软 600s / 硬 900s 复用 worker 常量 `DEFAULT_SOFT_MS=10*60*1000`、`DEFAULT_HARD_MS=15*60*1000`（src/task/worker.js:20-23，经 run.js:25-28 导入并透传 :170-171），硬超时两段式 `cancel({keepInbox:true})`→`cleanInbox`（worker.js 取消链，测试 test/task-run.test.js「硬超时：两段式取消」）；回执 ≤300 字（test/task-run.test.js「formatReceipt…仍 ≤300 字」）；两审计 `USED/task_receipt` + `USED/task_run`（run.js:257-268）。工具面：tools.js:451 `task_run` 与其余 8 工具一并注册（registerTools → platform.registerTool，index.js:408-433）。测试 test/task-run.test.js 13 例全绿。 |
| M1：时区/CI | M | ✔ 关闭 | 全部「墙上时间」走 src/time.js 的 Intl 分区字段（time.js 注释与实现），不读 `process.env.TZ`（grep 0 命中）；配置校验 IANA（config.js:134-138）；安静时段 `zonedMinutesOfDay`（config.js:149-166）；调度日键 `zonedDayKey`（scheduler.js:61、90）；M4 日键 `zonedDayKey(ms, config.timezone)`（budget.js:88-92）。时区覆盖测试 test/scheduler.test.js:512-542（America/New_York 的 03:00 与安静时段）；test/budget.test.js 固定 Asia/Shanghai 验证跨日清零。`TZ=UTC node --test` 本地 376/376；CI ubuntu-latest 等价 UTC。全 src 唯二 `toISOString` 见 N3（均为展示/时间戳字段，非日键）。 |
| M2：阈值全部读 config | M | ✔ 关闭 | 13 键 DEFAULTS 集中 src/config.js:14-27（含 timezone/idleMs/purgeAfterDays）；调用点全部经 `state.config/config.*`：compactAtTokens/compactHardTokens/idleMs（index.js:888-896）、retainTokens（index.js:964、1189、1424）、workingMemoryTokens（index.js:1188）、timezone（index.js:380、417、748、770、1375、1577、1627）。spot-check 运行路径无散落硬编码阈值；唯一常量 `DAILY_TOKEN_LIMIT=3_000_000`（budget.js:20）为 M4 设计固定值（导出并被 /成本 展示）。`grep "= 数字"` 阈值级命中仅 assemble.js:282 一处为 ≤0 防御校验，非阈值。 |
| M3：pre-step 不阻塞巩固 | M | ✔ 关闭 | `scheduleConsolidation` 只做同步 trigger 判断并登记 `pendingConsolidation`（快照在 pre-step 已固定），`setImmediate` 排后台、单飞锁、完成后自动补排（index.js:885-949）；`executeConsolidationJob` 负责窗口/模型/写库（index.js:957-1065），异常仅 warn+审计，下一轮 pre-step 消费 `lastConsolidationResult`（index.js:512-517）；dispose 后不再碰 store（index.js:886、921-924）。非阻塞测试：l-m3.test.js:301「pre-step 不等待巩固，慢模型不阻塞本轮回执（elapsed<1000ms）」、:336「巩固失败只 warn，召回/回执不受影响」。 |
| M4：成本熔断与 RSS 降级 | M | ✔ 关闭 | `DAILY_TOKEN_LIMIT=3_000_000`（budget.js:20），按 `config.timezone` 的 zonedDayKey 累计/跨日清零（budget.js:88-105）；RSS 三档 2.95/3.0/3.15 GiB（budget.js:22-28），读不到内存按 ok 且绝不抛（t11 报告、budget.js 注释）；接线层 `budgetInfo`/`toolBudgetGate`/`runRssCheck`/`proactiveBlocked`（index.js:794-870）。命令展示：/成本 追加「今日配额 X / 3000000（已熔断）」（commands.js:377-388）、/状态 展示每日用量+熔断+RSS 档位（commands.js:424-445）。工具闸门：task_run 熔断/stop_dispatch 拒绝、thread_run main_only 拒绝（tools budgetGate）。e2e test/e2e/budget-wiring.test.js:77（熔断→拒绝 task_run/停主动/命令展示/跨日复位）、:142（RSS main_only 降级与恢复）。 |
| L 项（首批） | L | ✔ 关闭 | README 链接全部仓库内并 fs 存在性测试（l-m3.test.js:241-251，README.md:95/105/143-146 实查无 `../memory/`）；CHANGELOG 表计数「8 业务表 + state_board_rev + schema_meta + 2 FTS」（CHANGELOG.md:12，测试 l-m3.test.js:253）；thread_run goal ≤2000 码点（tools.js 校验，测试 l-m3.test.js:165-202 边界 + task_run TypeError 回归 :195）；线程名 24 码点截断边界（l-m3.test.js:295）；thread-unarchive 只发布线程自己 state_board_rev、main 板 revision 不动（l-m3.test.js:208）。另 L1–L6（上一轮 round-2 已关）未见回归：巩固分页去重（d20e2b3 后未改坏，consolidate.test.js 白名单断言更新）、备份轮转 index.js:9711027 段、注入注入 clock/cwd（index.js:415-416）、memory_forget 改走 forgetMemory（tools.js:209）。 |
| W3：MVP 示例配置与安装自检 | L | ✔ 关闭 | config.example.yml 13 键全量示例（顶层键实测 13，含 timezone/idleMs，中文注释）；persona.example.md 与 DEFAULT_CARD 一致性测试（test/calibration.test.js 9/9）；scripts/calibrate/* 进程内测量与 `.data/config.suggested.yml` 生成，docs/calibration.md + README「首次安装自检」（README.md:95）。 |
| 回归与交付卫生 | — | ✔ | 见 §一；工作区在文档提交前 clean；未改 memory/ 设计文档（本次仅写 docs/review-v2.md）。 |

## 三、新增发现

### [N1] M 级｜巩固模型提示词文本仍取 transcript 窗口，与 surface 选区间存在截断错位风险

- 现象：巩固窗口（选区+水位）已完全由 surface 决定（见 H1/H2 证据），但默认平台 LLM 路径的提示词文本由 `buildConsolidationPrompt(state.transcript, …)` 生成——即 `captureTranscript` 的「最近 40 条 / 6000 字符」窗口（index.js:74-75、1295-1310）；`consolidate.js:415` 与宿主注入的 `companion.consolidationLlm` hook 均只收到 `{scope, seqFrom, seqTo}`，`planRegion` 辛苦拼好的 `region.text`（surface.js:178、index.js:974 区间内文本）**无任何消费者**（grep `region.text` 0 生产命中）。
- 影响：surface 窗口可超过 6000 字符（6,144 tokens ≈ 12K+ 字符），此时模型看不到区间开头部分却把整段标成已巩固（upto_seq 推进），旧尾部内容有被「静默跳过巩固」的上界风险;反向方向 transcript 也可能包含已巩固段，但事实层 `factKey` 去重 + consolidate 分页去重保护重复写库。升级错位只影响草稿质量/覆盖完整性，不影响水位/压缩/状态板的正确性。
- requiredFix（建议列入下批）：把 `planRegion` 的 `region.text` 传递到 LLM 调用（consolidate 的 llm 参数加 `text`，或 buildConsolidationPrompt 改收窗口文本），transcript 仅作兜底。
- 定级理由：选择/水位/压缩链路（用户可见行为与数据完整性）已闭环且被反例测试锁定；文本对齐属模型输入保真度问题，有事实去重兜底，非阻断。

### [N2] L 级｜版本与计数文案过期（交付一致性，非实现问题）

- README.md 第 7 行仍写「MVP 0.1.0（2026-11-03），260 个用例 / 15 个套件」——当前实况 376/16；package.json `version` 仍 `0.1.0`。建议随 v0.1.1 tag 一并更新（属发布任务，不在本复审修改范围）。

### [N3] L 级（信息）｜toISOString 残留两处均为展示/时间戳字段，非日键

- src/memory/retrieve.js:145 `formatDate` 用 UTC 日期渲染记忆来源行（纯展示，无调度语义）；src/calibrate/formula.js:197 为 YAML provenance 生成时间戳。两者不构成 M1 回归，记录在案以免下轮误判。

## 四、残余风险与建议

1. **N1** 文本对齐：建议 v0.1.2 优先修复（改动小、收益直接）。
2. 巩固默认 LLM 路径选第一条 provider/model（index.js:1280-1286），宿主注入缺失时静默跳过巩固（:983-989 仅 debug 一次）。当前为 MVP 设计口径，行为已在日志与 metrics 可见。
3. deep-sleep 情景→语义抽取仍为规则子步（MVP 口径，代码/CHANGELOG 已声明），维持上一轮复审结论。
4. 测试基线 376/16 在两套 TZ 下一致；CI 无 TZ 显式设置，依赖 ubuntu-latest 的 UTC 默认，建议 CI 显式 `TZ=UTC` 以消除宿主环境差异（L 级建议）。

## 五、结论

按判据「H=0 且 M≤2 → pass」：**pass**。A 批（H1–H6、M1–M4、L、W3）全部提供可核对证据后关闭；不设新的阻断项。若后续 N1 升级为必修，可执行 requiredFix 为：consolidate llm 调用透传 `planRegion().region.text`，`buildConsolidationPrompt` 优先使用窗口文本、transcript 作兜底，并补一个「窗口文本与 [startSeq..endSeq] 对齐」的 e2e 断言。
