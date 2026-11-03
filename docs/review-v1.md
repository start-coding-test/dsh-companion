# dsh-companion MVP 独立审查报告（review v1）

- 审查人：reviewer（独立审查，非实现者）
- 审查对象：dsh-companion @ commit `1c4fc9c`（feat(integration): wire plugin entry + full-turn/acceptance e2e）
- 审查日期：2026-11-03 21:20–21:56 (+08:00)；Node v24.9.0；工作区 D:\test\agent-plugin\dsh-companion
- 对照文档：memory/docs/06-记忆系统设计.md（v3.3）、memory/docs/05-架构设计.md（v3.0.2）、memory/开发规划-v2.md
- 方式：只读通读 src/ 全部 20 个模块与 test/ 全部 25 个测试文件；`node --test` 复跑；6 组独立探针（临时脚本，在系统临时目录，不入仓库）手工复现关键断言。

## verdict: needs_revision

核心组件层（store/consolidate/retrieve/assemble/worker/proactive/scheduler）质量良好、测试覆盖充分，
但 **巩固→压缩→状态板发布主链路未接线（H1）**：插件运行时从不调用 consolidate/publishBoard/compactRegion/assemble，
状态板永远为空串，MVP「自动记忆管家」的核心闭环在生产路径上不存在，只有组件测试在证明库能力。
M 级 2 项（召回注入无轮次去重、不走 32K 预算）需随后修复。H=1 → 按"H=0 才 pass"判据给出 needs_revision。

## 一、测试证据

命令：`cd dsh-companion && node --test`
结果：**257 tests / 15 suites，257 pass，0 fail，0 skipped，0 todo**，duration_ms 1026（real ≈ 1.13 s）。exit 0。

独立探针复现（`C:\Users\93488\AppData\Local\Temp\rev-probe.mjs`，全部 PASS）：
- r1 遗忘曲线与 S1 停读：R(normal,100d)=0.0008<0.05（降档截断）、R(normal,0d)=1、R(pinned)=1、tombstone 后 `retrieve` 返回 []。
- r2 装配预算：45,000 token 历史 + 40 条召回 → total=31998≤32000、召回层归零且按 score 升序丢弃、历史保 6144 地板、人格段逐字节不动。
- r3 巩固水位与事务回滚：首次 consolidate skip=f facts=1；同段重复 → llm 不被调用、skipped=true；事务中间 insertFact 抛错 → 四表+memory_events+FTS 与水位全部不变（#atomic 整体回滚）。
- r4 两段式取消：hardMs=400 → status=timeout（durationMs=412、soft 段只 warn 不取消）；调用链 `create|prompt|cancel:s1:{"keepInbox":true}|clean:s1`；2 参 `cancel(sessionId,opts)` 形状兼容。
- r5 主动闸门：安静期 quiet=true 全 deferred；日 cap 硬闸 break（余量计 deferred 不计 suppressed）；dedupeKey 在候选去重（suppressed=1）；静默期消息日出后按序推出。
- r6 purge：facts=1、FTS 无孤儿、PURGED 审计 detail_json 精确等于 `{"salience":"normal"}`（无正文泄漏）。

## 二、七项重点核验

**a) 零第三方依赖 / 无网络 / 无 process.env 泄密 —— 通过**
`package.json` 无 dependencies/devDependencies、engines node>=24；全 src grep 无 `process.env|fetch(|axios|child_process|https?://`、无 fs 目录枚举读文件。仅 node 内置模块（node:crypto 等）。（adapter.js:1-20 只 import node:crypto；全仓 grep 复核 0 命中）

**b) SQL 全参数绑定、无拼接 —— 通过**
store.js 所有语句模板固定，值经 `?` 绑定；动态 where 用数组拼固定片段+参数（listFacts store.js:903-931）；purge 断 FK 的 IN 占位符 `marks` 由 `ids.map(()=>'?').join(',')` 生成并绑定（store.js:1546-1560）。未发现任何把用户内容拼进 SQL 文本的路径。

**c) 遗忘链路 tombstone→7 天→purge —— 通过（框架级），但有未接线差异（见 D-1/D-2）**
- S1 `forgetFact`/`forgetEpisode`：`status='tombstoned', deleted_at=?, purge_payload=?` 幂等（store.js:885-896、736 段）。
- 7 天后 `store.purge`：`#atomic` 单事务；cutoff=at-trunc(days*86400)（store.js:1526-1528）；先断 FK（facts.source_episode_id/reminders.source_episode_id/state_board.ref_episode_id→episodes，facts.superseded_by→facts）；逐行删 FTS+主表；审计 detail_json 只 `{salience}`（store.js:1522-1608、1590）。
- 探针 r1/r6 与 test/e2e/forget.test.js（V2）复核：S1 立即停读、7 天 purge 计数、审计无正文。
- S2 确实由调度器接线：index.js:223-225（s2-purge job → store.purge）。运行时遗忘循环成立。
- 方差：`forgetReminder` 物理删除（store.js:1039-1044），与 06 §7.7「提醒不参与冷却期」一致，store.js 注释已声明。

**d) 装配裁切顺序与 6,144 保留 —— 通过（库级）**
assemble.js:104-121：先丢召回（>boardTokens/2050 → score 升序逐条丢）、再丢召回补总预算、最后裁最早历史且 `layers.history-oldest.tokens < retainTokens(6144) → break` 保留地板；人格段/board/userInput 不裁；召回块拼本轮 user 末尾（assemble.js:123-132、196-200，符合 06「不进 system」）。r2 与 test/e2e/assemble-budget.test.js（V10/V16）复核。
**差异：运行时召回注入不走此函数**（见 M2）。

**e) 巩固「先写库成功才压缩」与水位线 —— 通过（库级），未接线（H1）**
consolidate.js:319-456：`getWatermark` 水位 skip（to<=wm 不调模型不写库）；normalizeDraft 事务前校验（坏草稿不动库）；单事务 insertConsolidation(upto_seq)→episode→facts(key 去重)→reminders→renderBoard+stageBoard→appendEvent，失败整体回滚；提交后返回。水位单调（UNIQUE(scope,upto_seq,kind)）。r3 与 test/e2e/write-fail.test.js（V15）复核：写库成功前不登记 pending_compact、压缩 0 次、恢复后重试成功不重复。
**差异：生产路径无人调用 consolidate/publishBoard/compactRegion（见 H1）**。

**f) worker 两段式取消 —— 通过**
worker.js:38-122 + 167-206：软超时 600s 只 warn 不打断（R-TSK-14）；硬超时 900s `finish({status:'timeout'})`；cancelTask 两段式 `cancel(sessionId,{keepInbox:true})`（兼容 1 参 fake）→`cleanInbox`，错误收集不抛、幂等；回执 ≤300 码点且失败不影响终态（worker.js:131-159、214-236）。r4 复现 timeout 终态与调用链；test/task/worker.test.js（V14 相关，eac44ef）覆盖 interrupt。
（注：worker 全部 timer `unref?.()`，要求宿主持有事件循环——产品上正确，探针曾因此 exit 13，属预期行为，非缺陷。）

**g) 主动消息闸门（安静/≤3/去重/合并）—— 通过**
proactive.js:228-312 两遍循环实现全部 6 道：`isQuietAt` 安静期整批 deferred；`sentToday+candidates>=dailyCap` break（日硬闸）；KIND_CAPS{task_report:1,reminder:2,chat:1} 超限 suppressed；dedupeKey 120min 窗口（含候选内互重）；相邻同类 ≤10min 合并 text 且 dedupeKey 继承；backlog>MAX_BACKLOG(5) 丢最旧；prompt 失败 unshift 回队 break 日内不重试。重启后 seedFromStore 从 proactive 审计行恢复当日计数/dedupe（proactive.js:126-153）。r5 复现安静/cap/dedupe/顺序。
（旁证：fireDueReminders 的 dedupeKey 含秒级时间戳 `reminder:<id>:<seconds>`，index.js:269——每条提醒 fired 后 status 变 'fired' 不再 due，30s 轮询不会重复入队，无实际去重旁路。）

## 三、Findings

### H（阻断级，1 项必须修复后才能 pass）

**[H1] 巩固→压缩→状态板发布主链路未接线；deep-sleep 为空壳；召回注入离开 assemble 预算。**
- 证据（file:line）：
  - 全 src grep `consolidate(|publishBoard|planConsolidation|compactRegion|assemble(`：生产调用 0 处。src/index.js 仅 import retrieve（index.js:15），无 consolidate/state-board/assemble 的任何 import。
  - deep-sleep daily 03:00 job 只打 debug 日志：`index.js:219-220 platform.log('debug','[dsh-companion] deep-sleep tick', metrics.snapshot())`——06 §4.3 的深睡维护（巩固、遗忘曲线重算/淡出降级、GC）完全未发生。
  - 动态状态板段读已发布 rendered：`index.js:95-103 → store.getBoard('main')`（store.js:1064）；只有 `publishBoard`（store.js:1114-1130）能翻 published，而它无生产调用点 → **运行时状态板恒空串**，巩固的 staged 永不呈现。
  - 召回注入：`index.js:119-129` 手拼 `[相关记忆]\n...` 文本块，不经 assemble 的 32K/2050 预算（见 M2）。
  - 组件测试 self-wired 复现闭环（turn.test.js:95/114 直接调 consolidate+publishBoard、write-fail 直接调 consolidate），证明的是库能力而非插件运行时行为——这正是"测试绿但链路未通"的根源。
- 影响：M2/M3 计划的"装配 32K、巩固、状态板发布、压缩、深睡"在真实运行中不会发生；V10/V16 等验收只是组件级。
- 必须修法：把巩固接到真实信号——在 agent/pre-step（turn 开头）调用 `planConsolidation`（用 tokenMeter 度量与 lastHumanAt），触发 `consolidate`；巩固成功后按 06 §4.3 的入口把 `pending_compact` 登记，压缩成功（`platform.compactRegion` 为 adapter.js:217-225 已有包装，需在 open turn 时被调用）后 `publishBoard(store,scope,'compact')`；deep-sleep 03:00 job 里至少执行「巩固 idle 段→遗忘曲线重算（updateFact 强化/到期降级）→GC」。接线处均需幂等与 try/catch，不阻塞 pre-step。
- 验证方法：新增 e2e：FakeCtx 下连续 2 轮对话触发 threshold 巩固 → 断言 consolidations 表 + staged → compactRegion stub 成功后 `store.getBoard('main')` 非空；`/状态` 的 state_board_rev > 0。同时 `grep src/index.js consolidate publishBoard` 应 ≥1 生产调用点。

### M（_medium_，2 项）

**[M1] 召回注入无轮次级去重，多 step 轮可能重复注入。**
- 证据：`index.js:112-131`——onPreStep handler 对每个 pre-step 都执行：query=lastTextBlock(payload.messages)（index.js:320-330），仅靠 `''` 或 `startsWith('[相关记忆]')` 守卫后 return null。06 §16.3 明确「召回注入每轮只一次、只用 enter；inject durable 会随轮累积禁止使用」；adapter 的 patch.inject 会被 mergeDecision 并进当步 enter 批次（adapter.js:33-64、172-186，形式合规），但当 turn 内多 step（工具往返）且进入批次末尾是工具结果等非注入块时，每 step 都会再检索再注入一块；无 payload.turn/step 判定。
- 必须修法：在 listener 闭包维护 `lastTurnId/key`（或用 payload 的 turn 序号），同一轮首个 pre-step 注入一次后置位，轮内后续 step 直接返回 null。
- 验证方法：FakeCtx 连发同一 turn 的 2 个 pre-step（第二批带工具结果尾块），断言 `platform.preStep` 共收到 1 次注入决策 + `metrics.recalls` 只 +1。

**[M2] 运行时召回注入不经 assemble()，无 32K/2050 预算兜底。**
- 证据：`index.js:119-129`——items 直接 `lines.join('\n')` 拼文本；retrieve 自带 budgetTokens=2050（retrieve.js:232-351，已含贪心截断 truncated），但 index.js 未传/未校验，也未对「历史+人格+召回」总量有任何上限控制；06 §5.2 的全局 32K 工作记忆约束在运行时路径上失守（依赖平台 host 把握）。
- 必须修法：注入时对 items 再做预算截断（复用 retrieve 的 budget 结果并向 handler 传 budgetTokens=2050），并考虑把召回块经 assemble 统一排布或至少度量 token 写入 metrics.overBudget。
- 验证方法：50 条高分召回 + retrieve 全量返回时，注入文本按码点估算 tokens ≤ 2050；metrics.snapshot 无超预算负值。

### L（建议级）

- **[L1]** consolidate 事实去重只读最近 500 条（`consolidate.js` facts 去重 `listFacts({scope,limit:500}).map(factKey)`，批次 319-456 内）——事实数超 500 时去重不完整，可能写出重复 fact。修法：按 subject/predicate 建临时内存索引或分页读取。
- **[L2]** 备份不滚动：`index.js:281-290` `copyFileSync(dbPath, dbPath+'.bak')` 单文件覆盖，与 06 §7.8「每日 1 份滚动 7 份」不符；失败仅 log catch 静默。修法：带日期轮转 7 份 + 失败计 scheduler_jobs 审计行。
- **[L3]** tools/commands 使用本地 `Date.now()/process.cwd()` 而非注入时钟/工作目录：tools.js:183,252,297,345；commands.js:25,65,354。测试时钟注入不了这些路径，成本汇总/showCost 的时间窗取宿主时钟。修法：createTools/handleCommand 接收 clock 并下沉。
- **[L4]** memory_forget 工具走 `store.deleteFact`（tools.js:123，仅置 deleted_at），与 `/记忆 忘掉` 命令的 S1 `forgetFact` 语义（status='tombstoned'+purge_payload 材质, commands.js:191/208）不一致；前者审计与冷却语义较弱。修法：tool 改走 forgetFact。
- **[L5]** thread_run 复用已归档线程时 `platform.unarchiveSession` 缺能力则静默跳过（tools.js:260-261），线程行标 active 但真实会话未恢复。修法：缺能力返回 {ok:false,reason:'unarchive 即 unavailable'}。
- **[L6]** 观测面未有生产数据源：metrics REQUIRED_GAUGES（tokensIn/tokensOut/overBudget/recalls）中前三个无生产写点（tokenMeter.measure 未被任何生产路径调用）；/状态 的 tokens 数恒 0。修法随 H1 接线时一并补。

## 四、与设计文档偏差清单

对照 06 v3.3 / 05 v3.0.2 / 开发规划-v2：
1. [偏差|H1 关联] 深睡 job（06 §4.3 §189 §659；01 R-MEM-12）：实现为 daily 03:00 debug 日志空转（index.js:219-220）。
2. [偏差|H1 关联] 状态板 4 发布时机（压缩成功/重启重载/unarchive/人格编辑）：无接线（index.js 无 publishBoard 调用）。
3. [偏差] 备份滚动 7 份（06 §7.8）：单 `.bak` 覆盖（index.js:284-289）。
4. [偏差] 状态板 staged_revision、5 区块 ≤800、固定 5 区顺序（06 §6.3）：与实现一致（store.js:1090-1107、state-board.js renderBoard/stageBoard）——非偏差，记录为已验证吻合。
5. [偏差] 召回注入「每轮一次、只进 enter 批次」（06 §16.3）：形式合规（adapter mergeDecision→enter），但缺轮次级判定（M1）。
6. [偏差] 强化公式 S'=min(3650,S×(1+α(1−R))+β)（06 §遗忘）：updateFact 支持写库，但无生产调用（无强化路径），策略属 G2/P2 可接受，但需在规划中记录。
7. [吻合] 主动 6 道闸门、调度 6 job 时刻表、配置 11 项默认值与校验边界、PRAGMA comfortable（WAL/secure_delete/foreign_keys，探针 r6 前置）、reachability（中文命令→ASCII 名转发 index.js:138-160）——均与设计一致。

## 五、验收覆盖小结

| 域 | 覆盖测试 | 运行时接线 |
|---|---|---|
| V2 遗忘闭环 | test/e2e/forget.test.js 3/3 | ✔ s2-purge 调度接线 |
| V15 写库失败 | test/e2e/write-fail.test.js | ✘ consolidate 无生产调用 |
| V10/V16 装配预算 | test/e2e/assemble-budget.test.js | ✘ 召回注入不走 assemble（M2） |
| V14 中断 | test/task/worker.test.js | ✔ |
| 线程/回执 | test/thread,worker,receipt | ✔ registry freeze 调度接线 |
| 主动闸门 | test/runtime（proactive/scheduler）+ r5 | ✔ |
| 32K 全轮次链路 | test/e2e/turn.test.js（self-wired） | ✘ 未由 apply() 驱动 |
| 琥珀座（Gate-0 tokenMeter+JSONL 实测） | 无 | ✘ |

## 六、总评

代码质量与测试水平在组件层是扎实的（10 表+FTS+purge、巩固事务、两段取消、6 道闸门均有高保真证据）；
问题集中在「接线层」：MVP 未把已验证的组件拼进运行的插件主链路。建议下卡顺序：H1（接线巩固→压缩→发布）
→ M1（轮次去重）→ M2（预算兜底）→ L1–L6。修复后重跑本报告第二节全部七项核验 + 新增 e2e 假绿扫描即可复检。
