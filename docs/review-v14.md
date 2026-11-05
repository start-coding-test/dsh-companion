# v0.4.9 独立复审（review-v14）

- **复审人**：reviewer（独立复审，非任一修复任务执行者）
- **日期**：2026-11-05
- **复审对象**：`main` 未推送提交 02f182b（V7-H1）→ b61f013（V7-M1）→ e8f26f9（V7-M3）→ c003b3b（V7-L1/L2）→ 75bea4d（V8-L1/L2）→ d6c1443（集成回归）；仓库 `D:\test\agent-plugin\dsh-companion`
- **方式**：只读源码逐行核验 + 新增测试逐用例抽查 + 亲跑三时区全量 `node --test` / plugin-smoke / 插件门探针
- **结论**：**needs_revision** —— 代码七项修复全部核验通过且亲跑全绿；但 **H=0 / M=1 / L=2**，M 为 living docs 与 V7-H1 新契约直接矛盾，按下述裁定处理后即可转 pass。

## 1. 结论计数表

| 必查项 | 结果 | 证据（实现 + 测试） |
| --- | --- | --- |
| V7-H1 工具调用时判能力 | ✅ | `src/index.js:791-793`/`:819`/`:166`；`test/v049-v7h1.test.js` 4 用例 |
| V7-M1 压缩起点跳过系统节点 | ✅ | `src/session/surface.js:218-232`/`:147`；`test/v049-v7m1.test.js` 7 用例 |
| V7-M3 凭据不落 facts/状态板 | ✅ | `src/memory/govern.js:47`/`:53`；`src/memory/consolidate.js:591`/`:594`/`:711`；`test/v049-v7m3.test.js` 6 用例 |
| V7-L1 round C 两轮 | ✅ | `scripts/probe/run-headless.mjs:788`/`:892-900`；`test/v049-v7l1-l2.test.js`（无凭据 SKIP≠PASS） |
| V7-L2 duration_ms | ✅ | `src/memory/consolidate.js:733-750`/`:173`；`src/index.js:2395-2434` |
| V8-L1 到期表达式索引 | ✅ | `src/memory/store.js:170`/`:1177`；EXPLAIN 命中，v3..v12 旧库幂等补建 |
| V8-L2 到期口径统一 | ✅ | `store.js:180`/`:583`/`:1972`；`src/index.js:3397` 同源 |
| 集成回归 | ✅ | `test/v049-regression.test.js`（d6c1443，498 行 6 用例，只测不改实现） |
| 文档一致性 | ⚠️ | **R1（M）**：see §4 |

**计数：H=0，M=1，L=2 → 按「H=0/M=0 才 pass」判定为 needs_revision，唯一 M 是纯文档改动，修完即可转 pass。**

## 2. 逐项核验

### 1) V7-H1：工具注册改为调用时判能力 ✅

- `src/index.js:791-793`：`registerTools` 不再在 apply 期按 `threadTools` 过滤，10 个工具一律注册（apply 时审计注释在同函数，能力 getter 语义见 `src/index.js:427`/`:440`/`:446`/`:644`/`:696` 审计行）。
- `src/index.js:819`：线程/任务工具注册 execute 内**调用时**读 `platform.capabilities.threadTools`；不为 true 返回 `threadCapabilityMissing()`（`src/index.js:166`，稳定 `{ok:false, reason:'capability_missing', ...}`，空参数不抛 TypeError——由测试覆盖）。
- `/status`（`src/index.js:740` handler）每次实时读能力；文案单一来源 `src/runtime/commands.js:36` `THREADS_UNSUPPORTED_TEXT='线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）'`，`:157`（/线程）与 `:540`（/状态）共用。
- `src/platform/adapter.js:303`：`threadTools` getter 每次调 `hasThreadControl()`，宿主晚挂载后无需重装即恢复。
- 测试 `test/v049-v7h1.test.js`：4 用例覆盖 10 工具全注册、三工具 capability_missing（含空参数）、`attachSessionController` 晚挂载后 `thread_run` 成功且文案恢复、3 轮反复调用不崩；旧断言已同步。d6c1443 集成回归再次从 apply 路径全链验证。

### 2) V7-M1：压缩起点跳过系统节点 ✅

- `src/session/surface.js:218-232`：`firstReplaceableIndex(snapshot, from)` 跳过 `role=system`（`:225`）；节点 0 role unknown（正文缺失）保守跳过（`:226-228`）。
- `surface.js:147-148`：`planRegion` 选定 startIdx 后立即收紧，全部不可替换返回 `{region:null, reason:'no-replaceable-range'}`；`:166-177` 区间中段遇系统节点提前收尾——生成区间的三条路径（常规巩固 / deep-sleep / pending 恢复后的新区间）都不再包含系统节点。
- `src/index.js:2378-2391`：`maybeCompact` 对**旧版本遗留 pending** 也从已定位起点做同一道收紧，`fencedIdx > endIdx` 丢弃并计 `compactionDrops`；系统节点 0 不会被 `compactRegion`（`:2398`）替换。
- S1（显式遗忘）路径经 `src/memory/forget.js:97` → 定向 `consolidate({kind:'forget_flush'})`，不构造 surface region，与 region 压缩无关；全仓 `compactRegion` 唯一调用点即 `maybeCompact`。

### 3) V7-M3：凭据类内容不落 facts / 状态板 / FTS ✅

- `src/memory/govern.js:47` `SENSITIVE_PATTERN`（密码学用负向断言排除、password/验证码/CVV/私钥/卡号/api key/access token/令牌/`sk-` 字面值）；`:53` `CREDENTIAL_FIELD_PATTERN`（弱字段需「字段+是/为/:/=/is+值且值含数字或符号」，`key is abcd` 不误报）；`:34` 导出 `CREDENTIAL_HINT`。
- `src/memory/consolidate.js:591`/`:594`：facts、reminders 落库前过滤（不进 FTS）；`:711` 状态板逐行过滤再兜底 scrub，历史库敏感行也不上板；episode 留对话原文（合理）。
- `src/index.js:1261`/`:1275`：pre-step `privacyHint` 每 turn 一次、不带具体值；`:875`/`:2674`/`:2724` 已入注入排除名单，提示不转录不一致；`:2153` 'credential content skipped' 日志有人推进时钟。
- 测试 `test/v049-v7m3.test.js`：6 用例含正例/误报控制（密码学、tokenizer、`key is abcd`）与端到端「蓝鲸-7788」「sk-abc123」全链不落库；d6c1443 再验「密码学和 tokenizer」不误伤普通事实。

### 4) V7-L1：round C 两轮续跑 ✅

- `scripts/probe/run-headless.mjs:788` `evaluateConsolidationRound` 纯判定：崩溃/未激活→fail；无凭据→**skip（不算 PASS，也不 fail 门）**；有凭据但 `maxTokensIn<=0` 或无 consolidations→fail；`test/v049-v7l1-l2.test.js` 对「有凭据无稳定 token / 无 consolidations」「无凭据 SKIP」「有凭据无 sessionId 判 error」各有一条负路径。
- `:831` `runConsolidationRound` 支持 deps 注入，`--patch` 在 `--json` 前（DSH CLI 解析顺序），第二轮 `--session-id` 续跑（`:892-900`）；测试按真实顺序断言两轮。
- 亲跑插件门（无凭据环境）：round C `turns=1 credentials=missing verdict=skip`，输出 `round C SKIPPED (no model credentials; two-turn consolidation cannot be asserted)`，门结果 **PASS**，与契约一致。

### 5) V7-L2：duration_ms ✅

- `src/memory/consolidate.js:557` 注入毫秒 clock（生产 `platform.now`）；`:733-750` 巩固事件 detail 带 `duration_ms`（回退夹 0）；`:765` sensitive>0 时 notice=CREDENTIAL_HINT。
- `src/index.js:2395-2434`：`maybeCompact` 前后用 `platform.now()` 计时，`:2420-2434` 写 `memory_events`（detail.kind='compaction'，start/end/watermark/duration_ms），写事件失败仅 warn。
- `surface/consolidate.js:173` `eventDurationMs(view)` 兼容 `detail_json` 字符串 / 对象 / 旧行（null）。
- 测试断言精确值：巩固 700ms / 压缩 1234ms（monkeypatch 推进时钟）、回归用例 250ms 精确命中。

### 6) V8-L1：到期表达式索引 ✅

- `src/memory/store.js:170` `REMINDER_DUE_AT_SQL='max(COALESCE(next_fire_at,0), COALESCE(retry_at,0))'`，查询（`:583` `buildDueRemindersQuery`）与索引（`:1177`）共用同一常量；删除失效裸列索引 `ix_rm_fire`。
- `#ensureReminderDueIndex` 在 `migrate()` 幂等段（`:867-871` 顺序 occurrence 列 → retry 列 → due 索引）对 v3..v12 旧库就地补建，`schema_version` 仍 12（`docs/usage.md:697` 已如实记录版本史）。
- 测试对 v11/v12 fixture 复现「索引不能进 SCHEMA_SQL（旧库无 retry_at 列）」的迁移陷阱；`EXPLAIN QUERY PLAN` 断言 `USING INDEX ix_rm_due` 且无 `SCAN reminders`。

### 7) V8-L2：到期口径统一 ✅

- `store.js:180` `reminderDueAt(row)`（双空→null）与 SQL 逐行同值；`src/index.js:3397` onAttempt 改用同源 helper，删除原 `Math.max` 副本。
- `store.js:1972` `rescheduleReminder`：单 UPDATE 清 `retry_at/occurrence_key/last_fire_key`、`delivery_attempts=0`、`closed_at=NULL`，仅 pending/snoozed 生效否则 null，参数校验抛 TypeError；库级触发器 `trg_reminders_reschedule_clear_retry` 兜底裸 SQL 路径（内层 UPDATE 不改 next_fire_at、不递归）。
- 改期后下一 tick 按 `max(next_fire_at, retry_at)` 新时间投递、旧 retry_at 不压制——e2e 与回归双覆盖。

## 3. 亲跑验证

| 项 | 命令 / 工件 | 结果 |
| --- | --- | --- |
| 三时区全量 | `node --test`（TZ=UTC / Asia/Shanghai / America/Los_Angeles） | 均 **859 pass / 0 fail / 0 skipped** |
| plugin-smoke | `test/e2e/plugin-smoke.test.js` | 三时区均 4 pass / 0 fail |
| 插件门 | `node scripts/probe/run-headless.mjs --plugin`（DSH CLI `D:\dsh\resources\runtime\cli\bin\dsh.cmd`） | exit 0：round A/B schedulerStarted=true、didNotActivate=false、round B firstReneedAt 非空、recallCrash=false；round C credentials=missing → verdict=skip；**plugin-gate: PASS**（SKIP 不算 PASS 的契约成立：无凭据不掩盖 fail） |
| worktree | `git status --porcelain` | 探针前后均 **clean**（dirty-lines=0；探针 `.data/` 不入 git） |
| 提交/tag | `git log origin/main..HEAD` / `git tag` | 恰 6 提交未推送；**无 v0.4.9 tag**（最新 v0.4.8）；`package.json` version 0.4.8 属发布提交职责，不算缺陷 |

测试数自检链（各任务自报 + 亲跑末态）：819 → 826 → 832 → 843 → 853 → **859**，闭环一致。

## 4. Findings

**R1（M，文档与契约不一致）** —— V7-H1 改为「恒注册 + 调用时判能力」后，living docs 未随之更新，多处仍描述**相反**的旧契约：

- `docs/usage.md:626`：「无 sessionController：thread_list / thread_run / task_run **不注册**（其余 7 个工具不受影响）…若被旧调用触发，task_run 返回 session-unavailable」 —— 与 `src/index.js:791-793`/`:819`（一律注册、返回 capability_missing）**方向相反**。
- `docs/usage.md:121`、`docs/usage.md:138`：引用旧文案`未注册 thread_run/task_run/thread_*`，而实际输出是 `commands.js:36` 的新文案。
- `docs/platform-api.md:302-320`（§5「能力门槛」）：`threadTools===false` 「不注册 / 模型看不到工具」（:311-313）、「与 v0.4.3 完全一致（工具集合不变）」（:314）、旧文案（:315-316）、「语义固定在能否注册」（:319-320）。

> **problem**：集成者按 docs 处理线程能力会做出与新实现相反的判断（以为模型根本看不到工具、按 session-unavailable 分支编写）。
> **requiredFix**：改 `docs/usage.md:121`、`docs/usage.md:138`、`docs/usage.md:626` 与 `docs/platform-api.md` §5 为：`thread_list/thread_run/task_run` 一律注册，`execute` 调用时读 `platform.capabilities.threadTools`，不可用时返回稳定 `{ok:false, reason:'capability_missing', message:'宿主未提供 sessionController，线程工具暂不可用'}`，能力恢复无需重装；`/status`/`/threads` 用 `commands.js:36` 新文案。CHANGELOG.md 与 review-vN 属历史记录，不需要改。

**V7-M1-L（低，观察项）**：`src/index.js:2378-2391` 的 pending 保护只收紧**起点**；从旧版本库恢复的 pending（`src/state/pending-compact.js:76-99` 读 nap 行 `compaction_start_seq/upto_seq`）若中段恰有 role=system 节点，`compactRegion` 调用（`:2398`）可能跨过它。宿主契约只保护 node 0（`src/session/surface.js:209-212`），实测无报错，且新码生成的 region 已由 `planRegion` 中段收尾（`surface.js:166-177`）保证无系统节点。**requiredFix**（可选）：pending 分支在 `[startIdx..endIdx]` 内向 end 同样做 first-replaceable 扫描，遇 system 提前收尾，与 planRegion 语义完全一致。

**DOC-L（低，文档缺口，不阻断）**：V7-M3 的隐私策略（凭据类内容不落 facts/状态板/FTS、pre-step 提示）与 V7-M1 的「压缩起点跳过系统节点」语义未写进 `docs/usage.md`（V0.4.9 段仅覆盖 V8 与 V7-L，见 `docs/usage.md:499`/`:501`）；`docs/known-debt.md:130-131` 仅记 V7-L1/L2。建议在 usage.md 的「记忆」节补一段隐私过滤说明、known-debt 把 V7-H1/M1/M3 列为已修复。不阻断发布。

## 5. 发布裁定

- 代码层：七项必修全部达标，测试与亲跑全绿，集成回归独立成立（只新增测试、未夹带实现改动）。
- **v0.4.9 现在不能 pass**：R1（M）使 living docs 与 V7-H1 新契约相反；修掉 R1（纯文档 diff，可并入发布提交）并复跑一次三时区全量即可转 pass，无需再开新复审轮次。
- V7-M1-L 为跨版本恢复场景的观察项，DOC-L 为可选补充，均不阻断。
- `package.json` 仍 0.4.8、无 v0.4.9 tag、未 push —— 与「先复审后 releasing」惯例一致，属发布提交职责。
