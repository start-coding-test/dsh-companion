# 变更记录

本文件记录 dsh-companion 的用户可见变化。版本号遵循语义化版本；MVP 阶段仍为 `0.x`。

## [0.7.18] - 2026-11-25

命令通道修正（M1）：让 Web UI 的 `/memory` 真正接受子命令参数。这是**通道声明**修复，
不是「QQ 已修好」——QQ / IM 仍只支持无参命令（见下）。

### Fixed

- **M1 命令声明**：`memory` 命令补 `input: { hint: '子命令' }`（与 `/stop-task` 的
  `taskId` 同形，宿主契约 `@deepseek-ai/dsh-commands` 的 `readonly input?:
  CommandInputDescriptor`）。不声明时 Web UI 不会为带参输入认领，`/memory 列表 关键词`
  这类写法拿不到参数。
- **M1 拼接空格化**：memory 专用分发拼接改为 `` `/记忆 ${rawInput}` ``（防御性加固；
  宿主 `parseCommand` 的 `rawInput` 本就自带前导空格，故零行为差异，仅为可读与后续
  安全），通用拼接未动；`handleMemoryCommand` 的 `replace(/^\/记忆/u, '').trim()`
  也未动，空参链路逐字不变。

### Docs

- README 命令表下新增「带参命令的平台差异」：Web UI 声明 input 后裸 `/memory` 回车会先弹
  参数输入框（留空提交等价无参）；**QQ / IM 仅支持无参命令**，带参操作由模型调用现有
  工具完成，治理 / 导出 / 回填 / 周报目前需在 Web UI 执行（周报无对应工具，属豁免项，
  复核后归类勘误）；本版不加消息识别钩子、不新增工具。

### Changed

- **L4 强化审计来源**：`Store.reinforceFact` 新增可选 `reason` / `actor`，**默认保持
  `used_in_reply` / `consolidator`** ⇒ 巩固与召回强化路径零行为差异（`test/reinforce.test.js`
  的默认断言原样通过）；`memory_write` 的查重强化（skip 与 ask→same 共用一处 helper）
  改记 `reason='dedupe_write'`、`actor='user'`，审计可区分「查重写入」与「巩固/召回」。
  - 与计划不一致：计划原文为 `actor='tool'`，但 schema 16 的
    `memory_events.actor CHECK (actor IN ('consolidator','user','scheduler','migrator'))`
    会抛 `TypeError: [store] invalid memory_events.actor: tool`；用户 2026-11-25 裁决改用
    既有 `user` 桶，**零 schema 变更**（未升 schema、未改 CHECK/`EVENT_ACTORS`）。


## [0.7.17] - 2026-11-24

历史回填第一部分（H1-A）：给出回填的配置、只读选区与预演，先把「能回填多少、要花几次模型
调用」摊开给用户核对；本版**不执行**回填，不写库、不推进水位，enabled=false 时连回填 meta
都不写。

> v0.7.15 已部署到云端；v0.7.16、v0.7.17 尚未单独部署。

### Added

- **H1-A 配置**：新增 `compact.backfill.enabled`（默认 `false`）、`compact.backfill.chunkTokens`
  （默认 `32768`，范围 1024..262144）、`compact.backfill.maxPerDay`（默认 `6`，范围 1..50）。
  未知键仍只 warning；16 键安装自检不变。
- **H1-A 只读预演**：`/记忆 回填` 输出可回填批数（每批 seq 区间 / tokens / 节点数）、水位后
  不可回填 tokens、理论压后底上限、预计模型调用次数（每批 1 次巩固 + 1 次压缩摘要；巩固内
  的去重裁决 0..1 次/批明确标注未计入）。预演不写库、不推进游标、不调模型。
- **H1-A `/状态` 行**：配置了 `compact.backfill` 时多一行「回填：开关 · 游标 · 今日批数 ·
  最近压后底」，未配置时整行省略（旧 golden 不变）。

### Changed

- 选区按 seq 在 surface 里的**位置**比较水位，而不是数值大小：宿主压缩可能用替换节点让 seq
  非单调，按数值会误选区间。起点跳过系统提示词，终点按工具调用配对收缩，跨压缩摘要节点
  继续下探，配平后为空则整批作废。

### Fixed（v0.7.17 L2/L3/L5）

- **L2 兜底投递不再覆盖终态分类**：monitor 先 claim 终态（timeout / lost / failed /
  cancelled），之后的兜底投递只在「正常退出、状态为 woken」的行上降级为 `woken-fallback`；
  `src/task/bg-jobs.js` 的 `deliverWake` 与 `src/index.js` 的 `deliverBgFallback` 同一条规则。
  此前预算耗尽/唤醒失败会把 timeout/lost 抹成 woken-fallback，`/状态` 分类与 `bg_job_finished`
  审计的 state 失真（回执正文本身不受影响）。
- **L3 取消回执统一生成器**：新增 `buildCancelMessage(job)`（`src/task/bg-jobs.js`），
  `task_cancel` 与 `/停止任务 <bg id>` 两个站点都调它——此前两处手搓文案已经分叉（一处 `；日志：`
  内联、一处换行）。`[任务] ` 前缀仍只由 `deliverTaskReceipt` 在最终投递层加一次。
- **L5 `bg_job_finished` 只在真查过 systemd Result 时记 `unit_result`**：`deliverWake` 增加
  可选 `unitResult` 参数，monitor 只在实际查询的两个分支传入；短路（143/137 且已过 deadline）
  与墙钟超时兜底分支不写该键，避免把「没查」伪装成「查了但不是 timeout」。判定逻辑与查询次数
  均未变（超时主判据仍是墙钟）。

- **H1-A 文档勘误**：README 历史回填段「水位后可回填 tokens」更正为「水位后不可回填 tokens」，
  与代码、测试、CHANGELOG 口径一致。

### Fixed（v0.7.17 L1/L4）

- **L1 取消改成 `cancelling` 状态机**：`cancelBgJob` 先原子 claim `cancelling`（重复取消返回
  `already-cancelling`），再发 TERM，并只把「已受理」返回给调用方；进程真的退出后由 monitor 的
  `cancelling` 分支 claim `cancelled` 并投递**唯一**一条「已取消」回执（退出码 143/137/0 一律按
  取消，不走超时归类）。仍在运行的取消中任务超过 `BG_CANCEL_GRACE_MS`（30s）升级 KILL，下轮
  收敛；TERM 抛错则回滚 `running`，不产生任何回执。取消中不占 `bgConcurrency` 槽，`/状态` 与
  `/停止任务` 清单把它标成「取消中」；重启后残留的 `cancelling` 行由首轮 monitor 收敛。
- **L4 已结束的 task id 也能停它派出的后台任务**：新增 `resolveStopTarget`
  （`src/task/stop-target.js`），`/停止任务 <id>` 与 `task_cancel` 共用同一解析——先查在跑
  task_run，再直查 bg id，最后用 task_run 审计里的 `sessionId` 反查 `child_session_id` 的
  running/cancelling 后台任务；唯一命中才受理，多个只列候选，零个 `not-found`，绝不猜。
  `store.listBgJobs` 新增 `sessionId` 过滤，`store.latestEventForRow` 提供按行取最近事件；
  schema 仍 16，无新表/新列。

### Fixed（v0.7.17 M1）

- **M1 `memory_write` 写入前先查重**：写入不再是「无条件插一条」。`memory_write` 现在按
  「同 kind 字面 Jaccard」分三档（口径与巩固同一套：`dedupeSkip` / `dedupeAsk`）——
  `skip` 只强化旧条（`reinforceFact`，不新写行）；`ask` 走一次小模型裁决
  `same`（强化）/ `update`（新行置 superseded、旧行保留历史）/ `new`（两条都留）；
  `new` 直接插入。裁决不可用（未注入 / 抛错 / 结构坏）一律按 `new` 保守插入，**绝不
  静默丢写入**。返回形状变为异步的
  `{ ok, id, duplicateOf, verdict: 'reinforced'|'updated'|'inserted', statement, scope }`。
- **M1 跨 kind 关键串只扩大 ask**：新增纯函数 `extractKeyPhrases` /
  `buildKeyPhraseIndex` / `upgradeVerdictWithKeyPhrases`（`src/memory/dedupe.js`）——
  同 kind 判 `new` 但项目名 / 代号等关键串命中**任意 kind** 的既有事实时升级为 `ask`，
  让裁决看到「同一对象、不同说法」；关键串**永不触发 skip**（skip 仍只由同 kind 高
  Jaccard 决定），最坏情况只是多一次裁决调用。纯版本号、纯日期/时间与停用词不入索引。
- **M1 `pinned` 三处设防**：用户红线「pinned 记忆不得被 update 取代」——巩固的
  supersede UPDATE 加 `AND salience <> 'pinned'`（模型显式 supersedes 与 judge update
  共用），`memory_update`（`editMemoryFact`）对 pinned 返回 `reason: 'pinned'`，
  `memory_write` 的 `update` 目标若是 pinned 则退化为插新条并 warn，不阻断用户显式写入。

### Fixed（v0.7.17 M2）

- **M2 `memory_forget` 支持批量遗忘**：schema 新增 `ids`（字符串数组，去重后 ≤50）与可选
  `kind`（`fact` / `episode`，默认 `fact`），单 `id` 路径一字不动、`execute({})` 仍抛
  `id must be a non-empty string`。id 归类**前缀优先**（`fact_*` / `ep_*`，无前缀回落
  `kind`），防止 `ep_*` 被按事实软删。每条独立处理：跨 scope 只让该条返回 `scope_denied`，
  不炸整批、不回滚（混合批里好的条目照常 tombstoned）。批量跳过定向巩固沿用 `no-llm`
  （工具与命令两条路径都不传 llm）。状态板**一次收尾**：整批只 `scrubStateBoard` +
  `publishBoard('forget')` 一次、`resetEmotion` 一次；`immediate + confirm` 只调一次
  `store.purgeIds`（一次两表 → 两条 `PURGED` 审计）。返回
  `{ ok, kind: 'batch', scope, summary: { requested, marked, failed, purged }, results, boardRevision, consolidation: { skipped: true, reason: 'no-llm' } }`。
- **M2 软删口径不变（方案 B）**：`forgetFact` / `forgetEpisode` 仍只写 `deleted_at` 与
  tombstone，FTS 行继续留到 S2 purge 再物删——批量路径没有偷偷改成物理删除。
- **M2 `/状态` 增加 FTS 投影自检**：新增只读 `store.ftsHealth()`，三类计数——FTS 孤儿
  （索引有、主表没有，可清）、active 缺投影（主表有、索引没有，异常）、非 active 仍留索引
  （S1 冷静期的正常状态，仅信息）。`/状态` 只在出现异常或非零时多一行，未传 `fts` 或全零
  时整行省略（旧 golden 不变）；不新增 `/诊断` 命令。
- **M2 搭车化妆**：`src/memory/consolidate.js` 中 M1 引入的 4 行行尾空白清理，纯空白改动。

### Added（v0.7.17 H1-B）

- **H1-B 独立 pendingBackfill 历史回填**：`compact.backfill.enabled=true` 时，每个新一轮的
  pre-step 在正常 `maybeCompact` 之后再看一次回填窗口（本轮已做过正常压缩则跳过，避免同窗口
  两次 `compactRegion`）。窗口 N 只做**纯函数**选批（`planBackfillChunks`，位置法水位比较）
  并登记独立 pending（`state.pendingBackfillByScope` + `compact_backfill:pending:<scope>`），
  巩固用 `setImmediate` 在 turn 外跑；窗口 N+1 才 `compactRegion` 替换并把游标推进到「区间后
  第一条未压缩记录」。当轮回复只等纯函数部分，不等模型。
- **回填行不参与主水位（方案 E）**：回填巩固行落 `kind="forget_flush"` + `trigger="backfill"`，
  借仓储现成的「不参与水位」语义桶——`getWatermark` 明确排除 `forget_flush`，
  `recoverPendingCompacts` 只认 `nap`。因此回填路径**零水位锚、零 `retargetConsolidation`、
  零 `setWatermark`、零 schema 变更**：低 `upto_seq` 的回填行按构造不可能把主水位带偏，
  重启也不会复活成正常 pending。
- **恢复态重拉（复核 M1）**：崩溃/重部署会让 meta 留下 `stage="consolidating"`、内存无快照的
  pending（崩溃窗横跨整个巩固 LLM 调用）。现在 `maybeBackfill` 会用当前 surface 重建：先校验
  `seqs[chunk.startIdx]` / `seqs[chunk.endIdx]` 与 `chunk.startSeq` / `chunk.endSeq` 是否仍一致
  （H1-A 按位置选区），一致才注入快照并重拉巩固（已写行则只转 `ready`、零模型）；位置漂移或
  取不到快照则丢弃本批 + 清 `compact_backfill:cursor:<scope>`，下轮从 `firstReplaceableIndex`
  重扫，避免拿旧位置切新快照污染巩固结果。
- **口径注记（用户 2026-11-25 裁决）**：m01525 原定的「批后 retarget 回主水位」字面动作
  不再执行——方案 E 用 `kind=forget_flush` 让回填行天然不参与主水位，见上条。
- **崩溃窗预检**：巩固阶段重放时先按 `(scope, upto_seq, kind=forget_flush, trigger=backfill)`
  查一次；命中就只把 pending 置 `ready`、不重复调模型（`UNIQUE constraint failed` 同样按
  「已巩固」重放处理）。
- **口径注记**：回填行会出现在 `consolidationStatusCounts()` 的全量统计里（该函数不带 kind
  过滤），`/记忆 周报` 与 `buildWeeklyMemoryReport` 只数 `nap`/`deep`，回填行不计入
  written/empty/failed——需云端对账时按此区分。

### Tests

六步各自独立 commit，最终统一 bump 到 0.7.17。新增 `test/v0717.test.js`（H1-A 选区/只读预演/
`/状态` 行 + L2/L3/L5 + L1/L4 回归）、`test/v0717-m1.test.js`（M1）、`test/v0717-m2.test.js`
（M2）、`test/v0717-h1b.test.js`（H1-B，15 例）；本地不能真实验证的宿主 `compactRegion`
替换、用户级 systemd 时序、LLM 巩固与 505k 真实 surface 全部用替身并标注「非真机证据」。
每条均有「删生产接线或守卫必红」的判别力用例（H1-A 位置水位反例、H1-B 重开 Store 主水位
不变 + 恢复态重拉 + 位置漂移、L1 重启收敛、M1 judge 接线、M2 批量分支、L3 取消文案唯一
等）。另含 M2 搭车的 `ep_*` 前缀测试修正（`/^ep-/` → `/^ep_/`）与 `PRAGMA foreign_keys`
包裹。`ℹ tests 1722 / suites 67 / pass 1722 / fail 0`；Windows（Node v24.9.0）与
Linux（Node v24.22.2，tx-yun 隔离目录）各三时区（UTC / Asia/Shanghai /
America/New_York）三遍，共六遍均 exit=0。

## [0.7.16] - 2026-11-24

后台任务终态与取消链修正版：超时不再被记成「已结束」、取消不再显示成失败、每个后台任务结束时
主会话都会收到一条回执，后台任务也终于有了取消入口；另修掉 `/停止任务` 无参文案、退回的
`systemd-run` 退出码误判与三处注释缩进。

> v0.7.15 已于 2026-11-24 部署到云端（本版即其真机回报的后续修复）；v0.7.16 尚未部署。

### Fixed

- **N1（V715D-H1）后台任务超时被记成「已结束」**：`RuntimeMaxSec` 到期由 systemd 发 SIGTERM，
  v0.7.15 加的 `trap 'exit 143' TERM` 让退出码文件可靠写出后，监视器的「已退出」分支会先命中，
  把 143 当成正常退出。现在退出码为 143/137 时再判：已过 deadline，或（Linux）`systemctl show
  -p Result --value` 返回 `timeout`，即按超时处理（claim `timeout`、回执「已超时被终止」、
  `task_status = timeout`）；两者都不成立说明是被外部 TERM/KILL，仍按正常结束。
  边界口径：已过 deadline + 143/137 + Result≠timeout 时按字面记 timeout（用户原文口径）。
  137 臂是防御性冗余（SIGKILL 不触发 trap，正常不会出现在退出码文件里）。
- **N2（V715D-M1）取消显示成「失败」**：`toStatus` 把 `cancelled` 落成 `failed`，回执写
  「状态：失败」。现在 `cancelled` 是全链路独立终态：`RECEIPT_STATUS`、`toStatus`、
  `STATUS_LABELS`（「已取消」）、`task_run` 事件与投递记录 `task_status` 都按 cancelled 落。
  旧记录（`task_status = failed` + `reason = cancelled`）读取路径不变。
- **N3（V715D-M2）后台任务结束只唤醒子代理，主会话 0 条回执**：唤醒成功路径也投一条主会话
  notice（走 P1 的 session-notice 通道），正文复用唤醒文案并追加「已唤醒发起它的子代理继续处理。」；
  唤醒失败/预算耗尽仍走原兜底，两条路径互斥且每个任务恰好一条（`dedupeKey = task-receipt:<jobId>`）。
  成功路径不改 `bg_jobs.state`（状态由 `deliverWake` 落成 `woken`，不会变成 `woken-fallback`）。
- **N4（V715-M1）后台任务没有取消入口**：`task_cancel` 先查 `task_run`，查不到再查 running 的
  bg 任务，按拉起时的同一模式（`--user` + 同一环境）`systemctl stop` 对应 unit，claim
  `cancelled`（新增 `BG_JOB_STATES.cancelled`，`bg_jobs.state` 无 CHECK，schema 仍 16），
  并投一条「已取消」主会话回执；监视器只扫 `running`，取消后不会再被二次投递。
  `/停止任务 <bg id>` 同样支持，无参清单并列显示后台任务（带 label）。
  `task_run` / `bg_run` / `task_cancel` 三处说明统一写明「取消只能用 task_cancel，不要用
  kill / pgrep / systemctl」。
- **N5 注释与文案**：`state.im` 的 JSDoc 改成 session 通道形状；`deliverSessionNotice` 补已知限制
  （`agent.send` 无幂等键，「已投递但未记账」窗口内重启会重复一条 notice，内容无害）；
  `config.example.yml` 的 receipt 段说明改成「已停用、仅为兼容保留」（整段仍是注释，不参与 16 键自检）。

### Tests

新增 `test/v0716.test.js`（12 例，全部标注「非真机证据」：probe / unitResult / signal / wake /
agent.send / proactive.enqueue 均为替身）：N1 三例（exit 143 且过 deadline → timeout；exit 143 未过
deadline 且 Result 查不到 → 正常结束；exit 0 → 正常结束）、N2（取消终态 cancelled 与「状态：已取消」
回执）、N3 三例（唤醒成功 1 条主会话回执且不改状态；失败/预算耗尽只投兜底一条；兜底 task_status
按终态映射）、N4 四例（`cancelBgJob` 的参数与原子迁移、`systemctl stop` 失败不假装成功、
`task_cancel` 的 bg 分支与回执、`/停止任务` 文案）；复核增量 S1 补一例派发级接线判别
（`/停止任务 <bg id>` 必须触发 `requestCancelBgJob`，删掉该调用即红）。全量
另修复核 M0 的平台假绿：N4 用例显式钉死 `uid`（0 与 1000 两臂），不再依赖 `currentUid()`
（Windows 0 / Linux 1000），把 50041 用户级实例的 `--user` stop 形状也钉住。
`ℹ tests 1651 / suites 67 / pass 1651 / fail 0`，三时区（UTC / Asia/Shanghai /
America/New_York）各 exit=0。

## [0.7.15] - 2026-11-23

回执只交主会话版：子代理回执不再冒充用户发言、也不再直发 IM，改由主会话模型决定怎么告诉用户；
同时修掉 v0.7.10 起 `bg_run` 一调就崩、后台任务结束回执被去重吞掉、后台任务超时被误记 lost、
`/停止任务 <id>` 不可达、带标题任务丢结论等真机缺陷。

> v0.7.10、v0.7.11、v0.7.12、v0.7.13、v0.7.14 均未单独部署，随本版一次上线。

### Fixed

- **P1 子代理回执不再直发用户，只交主会话**：删除 `ctx.dshIm.send` 直发路径，`task_report` 回执
  改由 `deliverSessionNotice`（`src/index.js`）交给主会话 agent——主会话空闲时 `next-turn`（followup）、
  忙时 `next-step`（steer），两者都唤醒，对齐宿主 subagent 结算的 `notifySettlement` 语义
  （`dsh-agent-loop/src/agent.ts:157-159`、`:171-190`）。消息仍是 `role: "user"` + `source.kind =
  companion-task-receipt` + `form: notice`，正文前加一行「这是后台任务回执，不是用户发言」，
  `summary` 取回执正文首句（≤60 字）；三处排除集继续按 kind 认出它不是用户发言。
  取不到主会话 / agent 时抛错交给 outbox 退避，**绝不退回 `platform.prompt`**。`receipt.im.*` 与
  `receipt.sessionNotice` 保留读入但运行时不再读取，`/状态` 的回执通道行改为「主会话（session-notice）」。
- **H1 `bg_run` 一调就崩（v0.7.10 起）**：`registerTools` 形参里没有 `state`，闭包却引用
  `state.bgSelfCheck`，真机上一调用就 `ReferenceError`。改为新增 `bgAvailabilityFn` 末参，调用点传入
  `() => state.bgSelfCheck`；工具不可用时按设计返回 `bg-unavailable`。
- **H2 后台任务结束回执被去重吞掉**：`bg_run` 的启动告知与结束回执共用 `taskId = job.id`，
  `dedupeKey: task-receipt:<id>` 在 120 分钟窗口内把结束回执当重复静默丢掉。已删除启动告知，
  结束回执独占该 key；万一仍命中去重，落一条 `status = duplicate` 的投递记录（同一状态只写一次）。
- **M1 后台任务超时被记成 lost**：`RuntimeMaxSec` 到期由 systemd 发 SIGTERM，sh 默认不执行 EXIT trap，
  退出码文件因此丢失。包装器新增 `trap 'exit 143' TERM`；监视器在「不在跑、也没有退出码」分支先查
  `systemctl show -p Result`（同模式同环境），`Result=timeout` 或墙钟越过 deadline 都按 timeout 处理，
  两者都不成立才是 lost。⚠ 真机风险：从 v0.7.7 起 unit 恒带 `--collect`，failed 的 unit 可能被立刻回收，
  「查不到 Result → lost」仍是主路径，墙钟兜底是超时的主判据（云端验收重点）。
- **M2 `/停止任务 <id>` 不可达**：宿主 UI 只在命令声明 `input` 时才展示输入框并透传参数。`stop-task`
  命令现在声明 `input: { hint: "taskId" }`（宿主 `dsh-commands/src/index.ts:68-69`、`:192-214`），
  `registerCommands` 把 `input` 原样透传；并新增 `task_cancel(taskId)` 工具走 `stopTaskById`，
  `task_run` / `bg_run` 的说明写明取消只能用 `task_cancel`。
- **M3 有标题的任务丢掉结论正文**：成功任务带 `title` 时回执只剩标题，`workerResult.receipt` 的结论被
  整个丢掉。现在 summary 为「标题 + 结论」（结论取格式化回执的结论段并按 300 字截断），
  失败 / 取消 / partial 的文案不变。
- **L1 后台任务兜底回执固定记成功**：`deliverBgFallback` 过去写死 `status: "ok"`，超时 / 丢失 / 失败
  都报成成功。改为按终态映射（timeout / lost / failed / ok），`task_status` 如实记录。
- **L2 派出后不要轮询**：`task_run` / `bg_run` 的工具说明补充「派出后直接回复用户，不要在本轮 sleep 或
  轮询等结果；结果会以回执送达」（人格卡不变）。

### Changed

- `receipt.im.*` 与 `receipt.sessionNotice` 两个配置键保留但运行时不再读取：回执只投主会话，
  `/状态` 的回执通道行显示「主会话（session-notice）」，配置了 `receipt.im` 时追加「receipt.im 已停用」。
- 工具数量：`createTools` 11 个（新增 `task_cancel`），`apply` 注册 12 个。

### Tests

- 新增 `test/v0715.test.js`（11 例）与 `test/e2e/apply-turn.test.js` 两条真实 apply 路径用例；
  `test/v0713.test.js`（15 例）、`test/v0714.test.js`（6 例）随回执通道下线改写为 session-notice 语义
  （v0.7.14 的 dshIm 换实例用例退场）；工具 / 命令计数断言全部同步。
- 单测全为「非真机证据」：宿主 `agent.send` / `agent.status`、`systemctl`、文件系统均为替身；
  Linux 用户级 systemd、polkit、cgroup 与 QQ 出站属云端验收。
- 全量（Node 24，三时区各一遍）：`ℹ tests 1639` / `ℹ suites 67` / `ℹ pass 1639` / `ℹ fail 0`，三次 exit=0（TZ=UTC / Asia/Shanghai / America/New_York）。
## [0.7.14] - 2026-11-23

回执通道稳定性修正：dsh-im 重载后回执仍能投出；没有主会话时回执不再被同批提醒拖住；投递失败日志不再按退避节奏重复刷写。

### Fixed

- **V713-M1 dsh-im 重载后回执照旧失败**：`initReceiptChannel`（`src/index.js`）启动时 `host.get('dshIm')`
  取到实例后就 return，不再挂晚接管；dsh-im 改配置 / 热更新会换成新实例，插件继续用旧实例 send，
  回执一直落 `delivery_error` 直到宿主重启。现在每次投递前由 `resolveReceiptService` 现取
  `host.get('dshIm')` 并重做可用性判断（contractVersion === 1、botId/targetId 已配置），
  取不到 / 校验不过 → 记不可用并抛给 proactive 退避，**绝不退回 `platform.prompt`**。
  启动时 info 日志与 `/状态` 的「回执通道」行保留（不可用时显示原因，最近投递结果仍可见）。
- **V713-L1 无主会话时回执被同批提醒拖回队列**：`src/runtime/proactive.js` 的投递第二遍过去只要
  本批有一条需要会话的候选，就把整批（含 `task_report`）放回队首并全部 `onFailed`。现在只回队
  「需要会话」的候选，走 dsh-im 的 `task_report` 照常投递；`dedupeKey` / `requestId` / 10 分钟合并 /
  `recordSent` 的 `dedupeKeys` / pending 重放 / `EXEMPT_KINDS` 豁免 / backlog 语义均不变。
- **V713-L2 投递失败日志按退避节奏重复写**：`recordTaskReceiptDelivery`（`src/index.js`）过去每次
  `onFailed` 都写一条 `task_receipt_failed`，`receipt.im` 未配置时日志会被同一份回执刷满。现在同一
  `receiptId` 只在投递状态变化时写（失败→失败不重复、失败→成功写 `delivered`、成功→失败写 `failed`，
  初次失败仍写 1 条）；状态放内存 Map，重启后第一次投递会重记一条当前状态，历史仍可从
  `memory_events` 的 `task_receipt_delivery` 事件读到。`status` + `task_status` 字段与旧记录兼容读不变。

### Tests

- 新增 `test/v0714.test.js` 7 例：dsh-im 换实例后投递走新实例且旧实例不被调用；服务消失 → 通道不可用、
  proactive 只退避不退回 prompt；无主会话时 task_report 出站而提醒回队（`onFailed` 只对需会话的份）；
  同一回执连续失败只记 1 条、状态变化才新增。三例均做过「删掉对应修复必红」的判别力自验。
- **非真机证据**：dsh-im 服务、宿主 `agent.send`、`platform.prompt`、`ctx.get` 重载语义全部用替身；
  真实的 dsh-im 热更新/重载行为、IM 送达语义属 50041 云端验收。
- 全量 1626 个用例 / 67 个套件，三时区（UTC / Asia/Shanghai / America/New_York）全绿。

## [0.7.13] - 2026-11-22

回执通道修正版：任务回执不再冒充用户发言进主会话，改经 dsh-im 出站到 IM；同时修「成功任务被标失败」
与投递记录状态混淆。**v0.7.10、v0.7.11、v0.7.12 均未单独部署，随本版一次上线。**

### Fixed

- **R22-H1 任务回执改走 dsh-im 出站**：`task_report` 回执（含后台任务兜底）过去走 `platform.prompt`
  进主会话，等于冒充用户发言。现在改走 dsh-im 的进程内服务 `ctx.dshIm.send(botId, targetId, text,
  { signal, format: 'plain' })`（`@xmanrui/dsh-im`，contractVersion = 1，作为可选依赖：未安装时
  插件照常加载并记一条 info 日志）。outbox 持久化、`dedupeKey` 去重、补投、3P-M1 豁免与 10 分钟合并
  全部保留；`proactive_sent` 只在 `send` 返回 `{sent:true}` 后写。通道不可用或发送失败时记
  `delivery_error` 并按现有退避重试，**绝不退回 `platform.prompt`**。新增配置 `receipt.im.botId` /
  `receipt.im.targetId`（显式填写，留空 = 不可用）；`/状态` 新增「回执通道」行（可用性、bot → target、
  最近一次投递结果）。
- **R22-H2 成功任务被标成「失败」**：宿主 `dsh-subagent/src/activation.ts:150-158` 在父方声明
  `outputSchema`、子代理没提交结构化结果时，会把 `completed` 改写成 `error` 且不带 `structured`，
  插件据此生成「任务失败：<正文>」。现在 `startSubagent` 不再声明 `outputSchema`，回执取 `output`
  文本并按 300 字截断（`receipt.js`）；子代理提示词仍要求「最后一段用一句话给出结论」；宿主若仍回传
  `structured`，照旧解析（读兼容）。
- **R22-M1 投递记录把任务终态当投递状态**：`task_receipt_delivery` 的 `status` 现在是投递结果
  （`delivered` / `failed`），任务终态另记 `task_status`；旧记录（`status` = 任务终态 + `delivered`
  布尔）仍可读（`readReceiptDeliveryRecord`）。

### Added

- **R22-H1 主会话 notice（知情但不开 turn）**：回执经 dsh-im 出站成功后，给主会话放一条
  `agent.send(message, 'next-turn', false)` 的 notice（`source = {kind: 'companion-task-receipt',
  form: 'notice', summary}`，不唤醒、不单独开 turn），方便用户之后追问；开关 `receipt.sessionNotice`
  （默认 `true`）。三处排除集（`hasRealUserInput` / `isInjectedMessage` / `lastUserText`）按 kind 认出
  它不是用户发言。
- **V712-S2 补记**：`proactive_pending` 事件持久化回执原始 `requestId`，重启补投沿用原 id（v0.7.12 只在
  Tests 段带过，本节补入变更记录）。

### Tests

- 新增 `test/v0713.test.js` 14 例：receipt 配置默认值与 trim、dshIm 通道成功/不可用/拒绝/未确认、
  按 kind 分流（task_report 不碰 `platform.prompt`）、notice 形状与唤醒位、notice 摘要截断、
  `/状态` 回执行、投递记录新旧两种 schema、R22-H2 的 `completed` 无 `structured` → ok 与
  `error` 带正文无 `diagnostic` → error，以及**生产接线判别用例**（`startScheduler` 恒注入
  `deliver`，删掉注入即变红）。
- 全量 1619 个用例 / 67 个套件（`TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 三遍全绿）。
- **非真机证据**：dsh-im 服务、宿主 `agent.send`、子代理 activation 均为替身；真实 IM 送达语义、
  notice 的宿主排队行为与云端 systemd 属 50041 验收。

## [0.7.12] - 2026-11-21

v0.7.11 复核增量的小修版。**v0.7.10、v0.7.11 均未单独部署，随本版一次上线。**

### Fixed

- **V711-M1 合并回执只记首条 dedupeKey，重启后重复补投**：同类回执在 10 分钟合并窗口里拼成
  一条时，`proactive_sent` 事件只记了首条的 `dedupeKey`，而 `replayPending()` 以「pending 之后
  没有同 key 的 sent」判定未送达——合并进来的第 2、3 条回执每次重启都会被当成未送达再发一遍；
  补投时若再次合并，仍只记首条，直到滑出最近 500 条事件。现在 `proactive_sent` 额外写
  `detail.dedupeKeys`（合并条每一份的 key），`recordSent()` 与发送后的 dedupe 窗口都按每一份 key
  记账，`seedFromStore()` / `replayPending()` 同时识别新数组与旧单键事件。
- **V711-L1 注释把宿主字段写成 `stopKind`**：`SubagentResult` 的字段名是 `stopReason`
  （`dsh-subagent/src/types.ts:285`），代码读的也是 `result.stopReason`；只有文档与 `mapStopReason`
  的形参名写错，已改回。插件内部记录「停止意图」的局部变量仍叫 `stopKind`，与宿主字段无关。
- **V711-L3 文案**：`worker.js` 的取消文案改为 `/停止任务`；`proactive.js` 里 `recordPending` 与
  `recordDeliveryError` 的 JSDoc 错位已理顺（只调注释，不改逻辑）。

### Changed

- **V711-L2 `/停止任务` 无参行为写明**：无参数只给用法与在跑清单，不中止任何任务；带 `taskId`
  才只中止该任务。README 命令表与本节同步说明（行为与 v0.7.11 的实现一致，本版只补文档）。

### Tests

- 新增 `test/v0712.test.js` 3 例：3 条回执合并成 1 条后同 store 重建不再补投（且 dedupe 窗口按
  每份 key 生效）、只有第 2 条未送达时只补那一条、`proactive_pending` 带原 `requestId` 补投沿用。
- 全量 1605 个用例 / 67 个套件（`TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 三遍全绿）。
- **非真机证据**：`platform.prompt` 为替身、事件库用内存 SQLite；真实投递与宿主 rpcId 去重属云端验收。

## [0.7.11] - 2026-11-21

v0.7.10 评审（插件侧 + 第三方全项目评审）的修复版：子代理取消、回执额度、孤儿 unit、
停止任务入口、配置降级、文档口径与契约门禁。**v0.7.10 未单独部署，随本版一次上线。**

### Fixed

- **3P-H1 子代理硬超时与取消在发布后无效**：宿主契约是「signal 只在创建期生效，发布后
  只能通过 dispose 取消」（`dsh-subagent/src/types.ts:42`；`manager.ts:810-821` 的 abort
  监听在启动完成后移除，`:1039-1116` 的 `finishDisposal` 才让 `activation.result` 结算）。
  之前硬超时只 `controller.abort()`，发布后的子代理停不掉，执行槽永不释放、也不出 timeout
  回执。现在硬超时与外部取消（`abortActiveTasks` / `/stop-task`）都走 `activation.dispose()`，
  与结果做 `Promise.race`，失败方不再写回执（once 守卫）；dispose 本身挂起时 10s 上限后照常
  出回执并释放槽位。归类：超时 → `timeout/hard_timeout`；取消且 `stopReason==="aborted"` →
  `cancelled`；dispose 抛错（`manager.ts:1114` 的异常分支）→ `teardown_error`；其余五态不变。
- **3P-M1 task_run 回执被每日上限吞掉**：`KIND_CAPS.task_report=1` 且超额直接丢弃，v0.7.10
  起结果只经回执送达，第二个回执当天必丢。现在 `task_report` 是「对用户请求的答复」，
  不计入主动消息每日/单类额度（`EXEMPT_KINDS`），仍受去重与合并窗口约束；未送达的回执
  落库为 `proactive_pending`，重启后由 `replayPending()` 按「pending 无后续 sent」补投。
- **V710-M1 launch-timeout 留下孤儿 unit**：`waitForLaunchClient` 超时杀掉客户端后，
  systemd-run 可能已经把 unit 提交出去。现在超时后 best-effort `systemctl [--user] stop
  dsh-bg-<id>`，结果写进 `failure.stopAttempted/stopOutcome` 与审计（`bg_job_failed` 的
  `stop_attempted` / `stop_outcome`）；终态仍是 `launch-timeout`（超时即 failed）。
- **复核增量 M2：排队中被取消的任务会错账槽位**：排队任务在 `admit()` 时没有占用槽位，
  被 `/停止任务` 取消后 `finally` 仍无条件 `release()`——等待队列为空时会多减一个 `active`，
  有人排队时会把从未持有的槽「转交」给下一位，两种都让执行槽失守。现在只在真正持有槽位时
  释放。**M3**：`/停止任务` 的无参行为与三处文案统一为「查看用法与在跑清单」，
  带 taskId 才中止，并清理了不可达的「已请求中止 N 个」与「已在取消中」分支。
- **V710-L2 `bg.runAs` 非空不再拖垮插件**：uid≠0 且 `bg.runAs` 非空时，v0.7.10 会抛
  `ConfigError`，而 apply 顶层 `normalizeConfig` 无 try/catch，整个插件加载失败。现在
  降级为配置 warning：`bg.unavailableReason="runas-unsupported"`，`bg_run` 返回
  `{ok:false, reason:"bg-unavailable"}`，`/状态` 显示原因，其余功能照常加载。

### Added

- **V710-L1 `/停止任务 [taskId]`**（命令名 `stop-task`）：无参数查看用法与在跑清单，
  带 taskId 只中止该任务；走 3P-H1 的 dispose 路径，回执 `reason=cancelled`。
  `listActiveTasks()` / `stopTaskById()` / `stopActiveTask()` 同时导出给单测与后续 UI 使用。
- **契约门禁（item 七）**：`startSubagent` 断言 `signal instanceof AbortSignal`；
  `sendToSubagent` 在调用方没给 signal 时自动补 `deliverySignal()`；`registerTools` 的
  execute 包装断言宿主第二参 `exec.signal` 形状，防止再出现「丢 exec / 传 {} 当 signal」的同款缺陷。

### Changed

- **文档口径（item 六）**：`README.md` 与 `config.example.yml` 的「即 root」改为
  「默认空 = 与 50041 相同（当前 ubuntu uid 1000）；非 root 时走用户级 systemd，runAs 必须为空」；
  `bg-launcher` 的 systemd 退出时机注释按用户给定口径重写（不带 `--no-block` 等 start job；
  `Type=simple` 的 start job 在进程拉起后即完成，通常很快以 0 退出；不等 unit 结束是没加 `--wait`）。
  历史 CHANGELOG 条目不改，只有 0.7.10 段里指向不存在命令的 `/停止` 精确改为
  `/停止任务`（0.7.11 起提供）。
- **CI（item 八）**：`.github/workflows/test.yml` 的 tz 矩阵补 `Asia/Shanghai`（UTC / Asia/Shanghai / America/New_York）。

### Tests

- 新增 `test/v0711.test.js` 15 例：/停止任务 分发与文案、`stopTaskById`/`listActiveTasks` 出
  cancelled 回执、硬超时按宿主契约走 dispose 并出 timeout、`activation.result` reject →
  `teardown_error`、外部取消、排队中被取消不错账槽位（M2 回归）、`signal` 契约门禁（含
  `sendToSubagent(..., {})`）、`exec.signal` 门禁、launch-timeout 停孤儿 unit（system 与 user
  两种模式）、同日 3 条回执全送达且不占额度、重启补投。
- 旧测试按新语义调整：`v0710.test.js`（硬超时替身改为「dispose 才结算」、runAs 改为 warning）、
  `scheduler.test.js`（task_report 豁免额度、合并窗口）、`p1b` / `v044-regression` / `e2e`
  （命令数 6 → 7，新增 stop-task）、`acceptance.test.js`（提醒线场景回执不占额度）。
- 全量 1602 个用例 / 67 个套件（`TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 三遍全绿）。
- **非真机证据**：用户级 systemd / polkit / DBus / cgroup / 真实子代理取消在 Windows 开发机
  不可复现，Linux 路径用 `run` / `spawnImpl` 替身、子代理用「只有 dispose 才结算」的替身验证；
  真实行为属 50041（ubuntu uid 1000）云端验收。

## [0.7.10] - 2026-11-21

真机反馈修复版（D21-H2 / H3 / H4 / M1 / M2）。50041 以 ubuntu（uid 1000）运行，
本版按用户级 systemd 调整后台任务，并把子代理派活从工具调用里彻底解耦。

### Fixed

- **D21-H2 `task_run` 阻塞主会话**：之前 `execute` 直接把执行 Promise 返回给工具层，
  主会话要等子代理结束才回复。现在登记任务后**立即返回** `{ok:true, status:'started',
  taskId, title}`，执行 Promise 脱离工具调用继续跑，异常只记日志与审计；结果只经
  SA-B3 `onReceipt` 以回执（task_report）投回主会话，不再作为工具结果返回。执行信号
  改为插件自持 `AbortController`（硬超时 900s、`/停止任务`（0.7.11 起提供）、插件卸载时的
  `abortActiveTasks()`），主轮次信号不再传给子代理——主会话结束或被取消不会中止
  子代理。busy / 额度闸门 / session-unavailable 等前置拒绝仍同步返回。
- **D21-H3 `bg_run` 被拒的启动被当成成功**：之前 `watchLaunch` 在 150ms 内没看到
  退出就判「已拉起」，而 `systemd-run` 等 polkit 授权可能超过 150ms，随后以 1 退出
  （Interactive authentication required）却被忽略。现在必须**等 systemd-run 客户端
  退出**再判定：`code === 0` 且无 signal 才算成功；上限 10s，超时杀掉客户端并记
  `launch-timeout`。参数加 `--no-ask-password`，stdio 不再 ignore——stderr 写入
  job 目录的 `launch.log`，失败回执与审计（`bg_job_failed.detail_json.launch_log_tail`）
  附其末尾 20 行（并入 D21-L1）。
- **D21-H4 `bg_run` 改走用户级 systemd**：ubuntu 无权向系统实例提交 unit。`process.getuid()`
  非 0 时用 `systemd-run --user`，并为子进程补 `XDG_RUNTIME_DIR=/run/user/<uid>`、
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`（已有则沿用）；uid 0 仍走系统
  实例。user 模式 `bg.runAs` 必须为空（配置层直接报错，launcher 再留一道失败防御）。
  探针与超时查询同样按模式加 `--user` 与同一环境。启动自检用同一模式跑
  `systemd-run --no-ask-password --wait --collect` + 同组 `-p RuntimeMaxSec/MemoryMax/CPUQuota`
  `/bin/true`：失败则 bg_run 直接返回 `{ok:false, reason:'bg-unavailable', message}`，
  `/状态` 显示「后台任务：不可用（原因）」；成功显示「后台任务：user 模式 / system 模式」。
  自检同时读 `user@<uid>.service` 的 `cgroup.controllers`，缺 memory/cpu 时日志 warn 并在
  `/状态` 标注「MemoryMax/CPUQuota 不生效」。
- **D21-M2 `bg_run` 唤醒子代理必然失败**：`sendToSubagent(sender, target, content, {})`
  第 4 参传 `{}`，宿主当 AbortSignal 调 `throwIfAborted()` 抛错，唤醒全部落兜底。现在唤醒
  与 thread_run 续派都传真正的 `AbortSignal`（`deliverySignal` 带 30s 超时），
  `sendToSubagent` 内部也会在调用方没给 signal 时补一个。
- **D21-M1 小区间跳过压缩后水位照推**：区间小于 `compactMinRegionTokens` 时不登记 pending，
  但水位照推，该段永远不会被插件压缩（真机 7044–7060 仅 1,042 tokens 被跳过）。现在小区间
  也登记为「累积中」pending（`accumulating:true`），不触发压缩；下一次巩固区间与之相接
  （新区间起点在旧区间之后）时合并——startSeq 取旧起点、tokens 累加，累计 ≥ 门槛才解除
  累积标记并可执行压缩。pending 含 tokens/累积标记并落库到 `schema_meta`
  （`pending_compact:<scope>`），重启后由 `recoverPendingCompacts` 恢复；起点不在当前
  surface 时照旧丢弃并清掉落库状态。**schema 不变，仍为 16，未新增表。**

### 已知非阻断残留

- 宿主 ACP prompt driver 把本轮 prompt slot 保持到子树排空：模型本轮能立即回复「已派出」，
  但 GUI 该轮会显示进行中直到子代理结束——这是宿主原生 UX，不是插件可改的阻塞。
- 用户按停主轮次不再中止子代理（正是 D21-H2 的解耦意图），SA-B3 回执照常送达。

### Tests

- 新增 `test/v0710.test.js` 16 例：task_run 立即返回 / 主轮 signal 不影响子代理 / 硬超时
  仍出 timeout 回执 / onReceipt 恰好一次 / busy 同步 / abortAll 生效；systemd-run 替身
  exit 1 → `launcher-exited`、不退出 → `launch-timeout`、失败回执带 launch.log 末尾；
  uid 0 与非 0 两套参数、user 模式环境补齐、runAs 冲突、自检失败 → `bg-unavailable`；
  三个 1.5K 区间合并 4.5K、未达门槛保持累积、落库后重启恢复；sendToSubagent 第 4 参
  `throwIfAborted()` 可调用。
- 旧测试按新语义调整：`task-run.test.js`（工具返回 started + 回执捕获）、
  `c5-h1b.test.js` / `v046-regression.test.js`（等回执投递而非工具结果）、
  `v077-stage6.test.js`（`--no-ask-password`、150ms 判成功改为 launch-timeout）。
- **非真机证据**：用户级 systemd / polkit / DBus / cgroup 在 Windows 开发机不可复现，
  Linux 路径全部用 `run` / `spawnImpl` 替身验证参数与状态机，真实行为属 50041 云端验收。
  另：systemd 手册称不带 `--no-block` 时 `systemd-run` 会等 start job 完成，与 v0.7.9 用户
  原文「启动 unit 后立即以 0 退出」矛盾；本版不翻案、不改历史记录，只把判定改成「等客户端
  退出再看退出码」，两者都能覆盖。
- 全量 1587 个用例 / 67 个套件（`TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 三遍全绿）。
- **v0.7.10 未单独部署**，修复随 v0.7.11 一起上线。

## [0.7.9] - 2026-11-21

阶段 6（后台长任务）的复核修复，只动 `bg_run` 的启动判定与日志截断。

### Fixed

- **W78-H1 `systemd-run` 正常退出被判失败**：不带 `--wait` / `--scope` 时，
  `systemd-run` 启动 unit 后**立即以 0 退出**，并不阻塞到 unit 结束（阻塞是 `--wait`
  的行为）。之前的判定把 150ms 内的任何 exit 都算 `launcher-exited`，于是每次正常
  启动都被记成 `failed` 并发失败回执，而 unit 实际在跑、无人监视。现在：`code === 0`
  且无 signal → 启动成功（继续交给探针）；非 0 或带 signal → 失败；150ms 内没退出也
  视为成功。150ms 观察窗本身不变。
- **W78-L1 大日志上限时截断失效**：`capLogFile` 一次 `Buffer.alloc(maxBytes)`，而
  `bg.logMaxMB` 允许到 102400，分配失败被 catch 静默吞掉 → 永不截断。现在改为
  **1MB 分块读写**（原地重写保 inode、保留尾部不变），并把 `bg.logMaxMB` 校验上限
  降到 **1024**。

### Tests

- `test/v077-stage6.test.js` 28 → 33 例：早退 code 0 → `state=running`、早退带 signal
  → `launcher-exited`、非 0 退出仍失败（保留原 code 1 用例）、150ms 内不退出 → 已拉起、
  `logMaxMB=1025` 被拒、3MB 日志分块截到 1.5MB（校验尾部内容与 inode 不变）。
- **非真机证据**：真实 `systemd-run` 的退出时机仍在云端验证；本机用 spawn 替身覆盖
  三种退出形态。
- 全量 1571 个用例 / 67 个套件（`TZ=UTC`、`TZ=Asia/Shanghai`、`TZ=America/New_York` 三遍全绿）。

## [0.7.8] - 2026-11-20

阶段 6（后台长任务）的修复版，只动 `bg_run` 这条链，不涉及记忆 / 压缩 / 子代理派活。

### Fixed

- **W77-H1 `bg_run` 的瞬态 service 工作目录是 `/`**：`systemd-run --working-directory`
  之前没传，`spawn` 的 `cwd` 只作用于 `systemd-run` 客户端，service 自己在 `/` 下跑；
  `argv[1]` 为相对路径时，校验与算 sha256 的 `realpath` 和实际执行的不是同一个文件，
  脚本里的相对路径读写还会落到根目录。现在参数带 `--working-directory=<realCwd>`，
  且计划里的 `argv[1]` 统一替换成 realpath 之后的绝对路径。
- **W77-M1 `systemd-run` 拉起失败无人接**：之前 `spawn('systemd-run')` 没有 `error`
  监听，拉起失败会变成宿主进程的未捕获异常；也不看 `systemd-run` 自身退出码。现在
  监听 `error` 与早期 `exit`，失败时把任务记为 `failed`（不进 `running`，避免监视器
  去探一个不存在的 unit），并经 SA-B3 通道回执一句「后台任务拉起失败：…」。
- **W77-M2 service 环境与珞然的 bash 不一致**：瞬态 service 只有 systemd 默认环境，
  `PATH` 精简、没有 venv / conda / 代理变量。现在默认透传 `-E PATH -E HOME`，并新增
  `bg.env`（变量名列表）把列出的变量一并透传。
- **W77-L1 包装器日志只追加不截断**：新增 `bg.logMaxMB`（默认 50），超出只保留尾部。
  截断放在监视器里每轮做一次（包装器可能被 `RuntimeMaxSec` 的 SIGKILL 直接杀掉，
  `trap` 不保证执行），因此日志最多超出上限「一个轮询间隔」（30 秒）的量；
  `BG_TAIL_BYTES=2048` 的唤醒消息尾部与 `tailLog()` 语义不变。
- **W77-M3 测试走了真实路径**：`bg_run` 用例之前建了 logRoot 却没注入，走真实
  `DEFAULT_BG_LOG_ROOT`（Linux 非 root 直接 `EACCES`）。`createTools` 现在支持注入
  `bgLogRoot` 与 `bgLauncher`，用例全部改用临时目录 + launcher 替身，不再碰真实
  `/opt` 与真实 `systemd-run`。

### Added

- 配置 `bg.env`（默认 `[]`）与 `bg.logMaxMB`（默认 `50`，`0` 关闭）——非枚举，不参与
  16 键安装自检；README 配置表、`config.example.yml`、校验（`bg.env` 的名字格式、
  `bg.logMaxMB` 的 0..102400 整数）同步。

### Tests

- `test/v077-stage6.test.js` 扩到 28 例：新增 `--working-directory` / `-E` 透传与去重、
  相对 `argv[1]` 出绝对路径、拉起失败落 `failed` + 审计 + SA-B3 回执、`capLogFile` 保留
  尾部、监视器按 `bg.logMaxMB` 调用截断（`0` 关闭）；原 `bg_run` 与监视器用例改为注入
  logRoot 与 launcher 替身。
- **非真机证据**：真实 `systemd-run` / `RuntimeMaxSec` / 20 分钟脚本 + 重启补投仍在云端
  验证；本机（Windows）只覆盖纯函数与状态机。

## [0.7.7] - 2026-11-20

### Fixed

- **C120-H1 压缩区间落在工具配平的切口上**：surface 记录新增 `toolDelta`（与宿主
  `dsh-compaction/src/tool-pairing.ts` 的 `eventDelta` 同口径：assistant 消息按 `tool-call`
  块 +N、每条 `tool/result` −1、其它 0，不按 callId 配对）。`planRegion` 现在把区间两端
  收缩到累计 `toolDelta` 为 0 的切口：起点跳过 tool/result，终点不越过尾部未结束的
  tool-call。原先 end 落在「带 tool-call 的 assistant」上、start 落在 tool/result 上都会被
  宿主判为非法边界，压缩必然失败。索引缺字段时会全量重读一次（`REQUIRED_ENTRY_FIELDS`，
  阶段 2 的 `sourceKind` 走同一入口）。
- **C120-H2 压缩失败不再无限重试**：pending 区间在真正调用前用同一配平函数再校验一次并
  收缩（收缩不出合法区间 → 丢弃并计 `compactionDrops`）；确定性错误（边界不合法 /
  压后不更小）直接丢弃计数；其余错误最多重试 3 次，超限丢弃并计数。修复了「pending 一直
  留着、每个 turn 都失败一次」的死循环。成功后清零计数与最后一条错误。
- **C120-M3 空区间不再算失败**：区间剔除注入消息后没有用户/助手正文时，直接记
  `status='empty'` 不调模型；模型给空草稿时重试一次，仍空也记 `empty`。`empty` 与
  `failed` 分开统计，`empty` 照常推进巩固游标、允许该区间压缩。数据库 schema 升到
  v16（consolidations 的 status CHECK 增加 `empty`，旧行保留）。
- **H2L-L2 插件模型调用带上 `purpose`**：情绪判定为 `companion-appraise`、巩固为
  `companion-consolidate`；不用 `compaction`，避免宿主把它当成自己的压缩请求（会加
  `x-deepseek-harness-compact` 头）。

### Added

- **C120-M1 `compactMinRegionTokens`**（默认 `4096`）：巩固出的区间小于它就不登记
  压缩，避免为几千 token 的小区间反复重建 surface；`0` 关闭闸门。
- **C120-L1 `/状态` 显示压缩与巩固健康度**：连续压缩失败次数、最后一条错误原文
  （不截断）、`empty` / `failed` 各自条数。
- **L120-H1 巩固去重（近似查重 + 模型判定）**：写库前把每条新事实与同 scope、同 kind
  的 active 事实比 bigram Jaccard —— ≥ `consolidate.dedupeSkip`（默认 `0.85`）不写新行、
  只 `reinforceFact` 强化旧条；`consolidate.dedupeAsk`–`dedupeSkip`（默认 `0.5`–`0.85`）
  合成一次模型调用判 same / update / new，`update` 走 supersede。判定失败或超时按 `new`
  保守写入并计数，不吞整次巩固。精确 `factKey` 去重仍是第一道。
- **L120-H1② 候选不再被召回快照整段放弃**：`selectExistingFactsFromRegion` 先剥掉
  `[相关记忆]…[/相关记忆]` 再匹配（原先见到召回快照就直接返回空候选），project /
  knowledge / other 分支同时接受「subject 字面命中」与「statement 与区间文本
  Jaccard ≥ 0.3」；同一 subject 多条全部进候选，不再只留最新一条。
- **L120-H1① 区间正文剔除注入消息**：production surface 记录新增 `sourceKind`，
  `companion-recall` / `companion-expired` / `companion-emotion` / `companion-command-hint` /
  `companion-privacy-hint` / `runtime-context` 这些注入行不再拼进区间正文（token 预算和
  压缩口径照旧，只让模型看到干净的对话）。
- **L120-M1 deep-sleep 自动去重**：同 kind、Jaccard ≥ `govern.autoDedupeThreshold`
  （默认 `0.6`）的对交一次模型判定，判 `same` 才把旧条置 `superseded`（pinned 与较新者
  保留，不物理删）；结果写 `govern_last_run` meta，`/状态` 增加一行「自动去重（上次
  deep-sleep）」。判定失败只 warn 并跳过当夜 supersede，候选留到下次。
- **L120-L1 `/记忆 周报`**：直接查库给出事实（按 status × kind）、情景、本周新增、
  本周 superseded、待处理与过期提醒、pinned 数量、本周巩固 `written` / `empty` / `failed`
  次数。数字不再由模型估算，「本周」按滚动 7 天（`unixepoch` 比较，与 TZ 无关）。
- **新增配置**：`consolidate.dedupeSkip`（`0.85`）、`consolidate.dedupeAsk`（`0.5`）、
  `consolidate.maxProjectFacts`（`5`）、`govern.autoDedupeThreshold`（`0.6`）、
  `decay.projectDormantDays`（`30`）、`reminderStaleDays`（`30`）、
  `reminderTodoStaleDays`（`7`），全部进配置表与启动校验（`0 < dedupeAsk < dedupeSkip < 1`）。

### Added（阶段 3）

- **SA-H1**：子代理消息不算用户发言。宿主以 `user/message` 投递的子代理结案通知
  （`source.kind='subagent-settled'`，见 dsh-subagent 的 `continuation-messages.ts:29-39`）
  与 agent 间 relay 消息（`source.kind='agent-message'`，同文件 `:14-20`）现在同时被
  `hasRealUserInput()`、`isInjectedMessage()` 与 `lastUserText()` 排除：既不抢
  `main_session_id` 的 latest-user 重绑，也不会被当成召回查询或情绪判定输入。
  `lastUserText()` 走 `textRows()` 的行级 `sourceKind` 透传，原有前缀兜底
  （`[相关记忆]` / 情绪前缀 / `[提醒] `）不变。
- **SA-L1**：`classifySession()` 把 threads 登记查询提到子代理判定之前，线程会话
  （`threads.session_id` 命中）即使在子代理上下文里也按 `thread:<key>` 记账，不会落到
  `subagent` 分支；`createAssembleHandler()` 的遮蔽跳过条件由 `kind === 'subagent'`
  扩为 `kind !== 'main'`（线程会话有自己的 preset，插件不覆盖），未传 `store` 时
  线程判定退化为 `main`，与旧行为一致。

### Tests（阶段 3）

- 1514 个用例 / 61 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三遍全绿）。
- `test/subagent-isolation.test.js`（3 例）：settled 通知与 agent relay 两条链的函数面
  ＋真实 `apply()`/pre-step 行为面（不注入召回、不重绑 main）、线程归属与遮蔽跳过。
  **非真机证据**：消息形状按宿主源码构造，未在真机子代理会话回放。
### Added（阶段 4）

- **SA-B1 `task_run` / `thread_run` 改走宿主子代理**：新增 `src/task/subagent-runner.js`，
  按宿主 `subagents.startActivation()` 起一个 `spawn` provider、`delivery: 'caller'`、
  `agentPreset: 'minimal'`、`maxDepth: 1` 的子代理，父 Agent 取工具执行上下文
  `exec.agent`（宿主先例 `dsh-tool-subagent-control/src/index.ts:73-80`）。子代理看不到
  父对话（`inheritsParentContext = false`），完成后回一条 ≤300 字回执；
  `src/task/worker.js` 的老路径（`createSession` + `prompt`）保留为回退，宿主没有子代理
  能力或没有 `exec.agent` 时自动用它，行为与 0.7.6 一致。
- **SA-B1 回执 ≤300 字**：宿主 JSON Schema 子集没有 `maxLength`
  （`dsh-tools/src/json-schema.ts:267`），所以 schema 只声明 `receipt` / `status` /
  `artifacts` 三个字段，长度由 `src/task/receipt.js` 的 `RECEIPT_MAX_CHARS=300` 截断兜底。
- **SA-B1 五态映射**：宿主 `stopReason` 的 `completed` / `aborted` / `error` /
  `max-tokens` / `refusal` 依次映射成 成功 / 失败 / 失败 / 部分完成 / 失败（`refusal`
  单独标记），`structured` 缺失时降级取正文截断，`structured` 解析失败按失败处理。
- **SA-B2 线程续跑锚**：`threads` 表新增 `child_session_id`（按需补列，不改 schema
  版本号）。新建线程派子代理时把 `childId` 写进该列；之后 `thread_run` 复用同一线程会把
  消息 `sendToSubagent()` 给这个子代理（运行中下一 step 收、空闲开新 turn、冷目标在运行时
  树根下恢复），不再反复 `createSession`。续跑失败（目标不可恢复）时保守地重建会话并把锚
  更新到新会话，回执注明「已重建」。`getThreadBySessionId()` 同时按 `session_id` /
  `child_session_id` 匹配，兼容只有旧列的历史行。
- **SA-B3 任务回执投回主会话**：子代理完成后把 ≤300 字回执经既有主动消息通道
  （`proactive.enqueue` + `flush`）投回主会话，前缀 `[任务] `、`source.kind =
  'companion-task-receipt'`，`requestId = companion-task-receipt:<taskId>`（同一任务重复
  投递会被去重）。回执同时进「三处排除集」（`hasRealUserInput` / `isInjectedMessage` /
  `lastUserText`），不会被当成用户发言、召回查询或情绪判定输入。**提醒触发逻辑未改**：
  到期提醒仍由原路径投递，本阶段只复用了它的投递管道。
- **SA-B3 投递日志**：dsh-im 没有出站日志，插件自己记一条
  `task_receipt_delivered` / `task_receipt_failed`（时间、回执 id、任务 id、成功位、
  会话 id、失败原因）到 `memory_events`，便于事后核对。
- **D6 子代理并发 2**：执行槽从 1 提到 2（`src/task/run.js` 的 `MAX_EXEC_SLOTS`），
  第 3 个任务排队（队列上限 2），`task_run` 描述同步改写。新增配置
  `subagent.concurrency`（默认 `2`，1–8）在启动时生效。
- **`subagent.model`**（默认空）：空表示沿用主会话路由（不传 `agentOptions.model`）；
  显式配置且命中 profile 允许集（`magpie/opencode-go/deepseek-v4.1-flash`、
  `magpie/opencode-go/glm-5.3`）才透传，越界只 warn 并回落到默认。
- **A12 子代理命名**：线程 key 是中文短名，转成 `t<utf8-hex>`（同 key 幂等稳定、
  截断到 32 位内），原名放 `label`；任务用 `task-<base36>`。`lead` 是宿主保留名，不占用。

### Tests（阶段 4）

- `test/subagent-runner.test.js`（14 例）：`startActivation` 规格断言（provider /
  delivery / preset / maxDepth / parent 同一引用 / signal / outputSchema 键）、默认不传
  `agentOptions` 与 allowlist 越界回落、五态映射、`structured` 缺失与坏 JSON、
  回执 ≤300、命名规则、parent 非存活 → 错误回执不崩、并发 2 槽、线程新建写锚 /
  续跑走 `sendToSubagent` / 失败重建 / 无 `exec.agent` 回退旧路、回执投递与去重、
  投递日志形状、`config.subagent` 默认值与校验。
- 旧断言按计划口径改写：`test/task-run.test.js`（`maxExec: 1→2`、单槽排队用例改为
  2 槽）、`test/tools.test.js`（共用执行槽改为占满 2 槽）、`test/platform.test.js`
  （`capabilities` 增加 `subagents` / `subagentMessages` / `agents` 三个探测位）。
- 1528 个用例 / 61 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三遍全绿）。
- **非真机证据**：子代理消息与 activation 形状按宿主源码
  （`dsh-subagent/src/index.ts:267-292`、`types.ts:49-66/144-191`）构造，未在真机
  子代理会话回放。

### Added（阶段 5）

- **T120-M2 召回范围按作用域设计（05 A5）**：主会话召回 `main` + 各活跃线程的事实
  （**不限 kind**，线程里巩固出的 project/knowledge 事实要能在主会话召回），情景仍只取
  `main`（线程情景原文不外泄）；线程会话召回本线程 + `main`，但来自 `main` 的候选只放行
  `identity` / `preference`（用户称呼与偏好跨线程可见），情景只取本线程。
  `src/memory/retrieve.js` 新增 `factScopes` / `episodeScopes` / `attachedScopes` +
  `attachedKinds` 行级过滤，`src/index.js` 新增 `recallScopes()` 按会话作用域算可见范围。
- **`Store.searchBigram` / `Store.listEpisodes` 接受 scope 集合**：`string | string[]`，
  数组展开为 `IN (…)`，单值仍走 `= ?` 快路径（旧调用零变化），空集合返回零行。
  `src/memory/vector.js` 的 `searchVector` 同步支持集合（向量通道口径一致，否则开启向量
  后主会话仍看不到线程事实）。
- **T120-M1 线程进展**：`thread_run` 新建线程的回执落地后，把回执「结论」段首句
  （≤120 码点，取不到则降级整段截断）回写 `threads.last_progress`，状态板线程目录显示的
  是真实进展而不是当初的 goal。新增 `src/task/receipt.js` 的 `progressFromReceipt()` /
  `PROGRESS_MAX_CHARS`。
- **T120-L1 工具文案**：`task_run` / `thread_run` 描述写清「一次性的活用 task_run；需要
  多天反复推进、同类事沿用的用 thread_run，先 `thread_list` 找同类 key 再决定新建」。

### Tests（阶段 5）

- `test/v077-stage5.test.js`（10 例）：scope 集合 API（含空集合与单值兼容）、验收①线程
  project 事实回主会话、`recallScopes()` 范围形状、验收②线程召回 `main` 的 identity /
  preference 而行级过滤掉 project / knowledge、验收③主会话不含线程情景原文、验收④回执首句
  与降级截断、验收⑤工具描述文案。
- `test/store.test.js` 的「searchBigram 按 scope 隔离」追加集合用例（含 `scope: []`）。
- 1538 个用例 / 67 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三遍全绿）。
- **非真机证据**：事实 / 情景 / 线程行全部构造，未回放 50041 云端快照；宿主子代理与模型
  调用均为 mock。

### Added（阶段 6）

- **W-1 `bg_run` 后台长任务**：新工具 `bg_run(argv, cwd, deadline_min, label)` 把预计超过
  10 分钟的脚本（训练等）交给宿主外部的 cgroup 单元跑，立即返回 id，发起它的子代理可以
  正常结束本轮。校验：`cwd` / 脚本 realpath 都必须落在 `bg.workRoot` 内（`..` 与指向外面的
  符号链接被拒）、`argv[0]` 只允许 `bg.interpreters` 内的解释器、`argv` 按数组直传 spawn
  （`shell: false`，不经 shell 拼接）。`bg.workRoot` 未配置时工具直接返回不可用。
  新增 `src/task/bg-jobs.js`（校验 / 启动 / 唤醒文案 / 监视）与 `src/task/bg-launcher.js`
  （launcher 抽象：Linux 生产 `systemd-run --unit … --collect -p RuntimeMaxSec/MemoryMax/
  CPUQuota`，`bg.runAs` 非空才加 `--uid`；Windows detached 替身仅作本机单测）。
- **W-1e `bg_jobs` 表 + 审计**：`Store` 幂等建表（`CREATE TABLE IF NOT EXISTS`，`state`
  用自由 TEXT 不加 CHECK 枚举，避免整表重建升 schema），字段覆盖 id / label / argv / cwd /
  脚本 sha256 / 发起子代理名与 `child_session_id` / 根主会话 / pid 或 unit / 起止时间 /
  deadline / 状态 / 日志路径 / 退出码；启动与结束都写 `memory_events`（`bg_job_started` /
  `bg_job_finished` / `bg_recover`）。
- **W-2 监视 + 兜底终止**：scheduler 新增 `bg-jobs` 任务（30s），按退出码文件与单元/进程
  状态判定；超 deadline 由 `RuntimeMaxSec` 主杀，插件兜底 **TERM → 10s → KILL** 并记
  `timeout`。
- **W-3 唤醒一次**：`UPDATE bg_jobs SET state='woken' WHERE id=? AND state='running'`
  （`changes === 1` 才继续），经 `ctx.subagents.sendMessage` 冷恢复发起它的子代理，消息带
  退出码、末尾 ≤2KB 输出与日志路径；子代理随后按 SA-B3 回执主会话。无存活根 Agent 或
  唤醒预算（`bg.wakeBudgetPerAgent`）耗尽 → 状态 `woken-fallback`，直接投主会话卡片。
- **W-4 重启恢复**：插件启动扫 `state='running'` 三分支——进程仍活继续监视 / 已退出且有
  退出码文件补投 / 没有退出码文件记 `lost` 并唤醒。
- **W-5 防护**：`bgConcurrency`（默认 1）满额拒绝并返回正在运行的任务；deadline 必填且
  ≤ `bg.maxDeadlineMin`（360）；workRoot 剩余空间 < `bg.minFreeDiskMB` 拒绝启动；启动即
  告知一句（label、预计时长、deadline）；夜间安静时段只投递不推送。
- **说明（安全边界）**：50041 以 root 运行（珞然作为管家需要 root），`bg_run` 不改变
  这一点；安全边界靠工作目录、解释器白名单、时长与资源上限和审计记录。
- **顺带修 bug**：`registerTools` 的工具包装原本写成 `execute: (args) => tool.execute(args)`，
  丢弃了宿主传入的第二个参数 `exec`，导致阶段 4 起 `exec.agent` / `exec.signal` 在生产
  从未生效；现已透传 `exec`。

### Tests（阶段 6）

- `test/v077-stage6.test.js`（22 例）：workRoot 未配置 / `..` 逃逸 / 符号链接越界 /
  解释器越权 / 脚本越界 / deadline 三态 / 磁盘余量 / 并发满额返回运行中任务 / 执行计划
  形状；systemd-run 参数与 `--uid`；包装器 argv 单引号包裹与 Windows 元字符拒绝；退出码
  与日志尾部 ≤2KB；`startBgJob` 落库 + 审计行；监视器四态（woken / timeout 先 TERM 后
  KILL / lost / 预算耗尽 fallback）；原子迁移只唤醒一次；`bg` 配置默认值与校验（16 键
  安装面不动）；`bg_run` 工具两态（不可用 / 启动 + 告知 + busy）。
- `test/scheduler.test.js` 与 `test/tools.test.js` 相应更新（7 个内置 job、10 个工具）。
- **非真机证据**：systemd-run / `RuntimeMaxSec` / 真实 20 分钟脚本与重启补投本机无法验证，
  测试用注入 launcher 与假 pid/unit 覆盖状态机，systemd 参数只做纯函数断言；Windows 路径
  是 detached 替身，不是生产路径。

### Fixed（阶段 2）

- **L120-H2 提醒有截止时间却不触发**：巩固抽出的提醒只有 `due_at`、没有 `next_fire_at`
  时既不会触发也不会过期。现在 `exact` 粒度用 `due_at` 补 `next_fire_at`，`day` 粒度补
  当地 09:00（按 `timezone` 换算，DST 自适应；当天 09:00 已过也取当天补投），
  `week` / `month` 粒度不自动触发但保留 `due_at` 作过期依据。
- **L120-M2 同一件事反复写提醒**：写库前比对同 scope `pending` / `snoozed` 提醒标题的
  bigram Jaccard，≥ 0.8 视为已有同类提醒直接跳过。
- **L120-M3 提醒没有生命周期**：deep-sleep 增加 `expireStaleReminders` —— 非 repeat 且
  `due_at` 已过 24 小时的 `pending` 置 `expired`；无到期时间的 `todo` 创建满
  `reminderTodoStaleDays`、`commitment` 满 `reminderStaleDays` 未更新也置 `expired`。
  `snoozed`（用户主动「稍后再说」）不动，不物理删、不推送，下次真实对话时由既有的
  expired-notice 一次性合并告知。
- **L120-M4 召回不分领域**：本轮判为闲聊（无工具调用、正文也没有代码块/路径/URL/连续
  拉丁标识符）时，`project` 与「技术形态的 knowledge」事实必须命中稀有锚点（df ≤ 2 的
  token）才允许注入；`work` 域的 episode 同样处理。不做硬过滤 —— 闲聊里明确提到
  「LoRA」这类稀有标识符仍可召回。episode 新增 `domain`（`life` / `work`，旧行为 `NULL`），
  按需补列、不改 schema 版本号。
- **L120-H3 抽取降量**：巩固提示词写明不记一次性过程状态，写库前再用规则拦一次
  （HTTP 状态码、百分比进度、`x/y` 步数、`temp`/`tmp` 临时路径、`exit code`/`stdout`/
  `stderr` 这类命令输出），且每次巩固 project + knowledge 新增上限
  `consolidate.maxProjectFacts`；`mood` 类瞬时状态不再写 facts（只进 episode）；
  project / knowledge 事实满 `decay.projectDormantDays` 没被召回也没被强化就转 `dormant`
  （deep-sleep 执行，与既有 `strength_days` 衰减叠加，`strength_days IS NULL` 的行豁免）。
- **L120-H4 提醒只记用户的事**：巩固提示词改为只写两类提醒（用户明确要求提醒的、用户
  本人的待办或承诺），助手自己下一步（「回答助手能否…」「重启 dsh web 服务」「查看本次
  训练结果」）不再写；写库前再有规则兜底拦一次，并跳过已由宿主周期安排覆盖的 todo。

### Docs

- **H2L-L5**：配置表补 `compactMinRegionTokens`，部署说明补「须在 profile 显式配置
  `defaultContextWindow`（0.2.2 起未写容量的模型默认 1,000,000）」。

### Tests

- 1469 个用例 / 52 个套件（默认时区）。
- `test/v077-stage1.test.js`（19 例）：配平纯函数、FakeCtx 的宿主式配平校验、6122 事件
  构造回放（596 tool-call / 595 tool-result / 尾部一个未结束调用）、pending 收缩成功与
  丢弃、非确定性错误 3 次上限、`compactMinRegionTokens` 门槛、`empty` 两例、schema
  v15 → v16 迁移。**构造数据，真快照到达后替换**：50041 surface 快照未到，量级按任务
  给的 6122 事件铺。
- `test/v077-stage2.test.js`（19 例）：区间注入剔除与 `sourceKind` 触发重建、候选不再
  被召回快照放弃、近似查重四分支（强化 / 判 same / 判 update 走 supersede / 判定失败
  保守写入）、`next_fire_at` 补偿、一次性过程状态拦截、自查提醒丢弃、提醒去重、三类
  过期、周报计数与直接 SQL 对账。
- `test/v077-stage2-reminder.test.js`（22 例）：`backfillNextFireAt` 三时区 +
  春/秋令 DST 固定用例、过期清理与合并告知、闲聊门（稀有锚点放行与 2 条配额）、
  自动去重三类结果与 `govern_last_run` 记账。
- `test/e2e/consolidation-retry.test.js` 追加「重试成功也过 `compactMinRegionTokens`
  闸门」。
- 以上均为构造数据：50041 云端 surface / 提醒快照未到，**真快照到达后替换**。

## [0.7.6] - 2026-11-14

### Fixed

- **V75-H1 稀有锚点只对「问回忆」的查询开放**：v0.7.5 的云端副本回放里，51 句真实正文中
  15 句命中、共 43 条注入；相对 v0.7.3 新增 10 条，其中 6 条无关，且全部来自 3 句非回忆陈述
  （「这是一个网关文档…做成一个skill」「好了、已经开始改了、应该明早就能改好了」「没有改一夜啦，
  早上继续改」）——它们各自撞上一个稀有 bigram，被锚点放行，score 与相关条目挤在 0.55–0.57。
  现在新增 `RECALL_INTENT_RE`（记得/记不记得/还记得/上次/上回/之前/以前/说过/提过/聊过/讲过/
  告诉过/来着/忘了），在归一化后的**原始查询**上匹配（停用 bigram 剔除之前）；未命中时行为等同
  v0.7.3，只走原来的命中数/命中比例门。
- **V75-L1 df 被搜索上限截断**：OR 检索的 limit 改为 `max(searchLimit, RARE_ANCHOR_MAX_DF + 1)`。
  闲聊路径 `maxItems=1`（`searchLimit=2`）时，df=3 的 bigram 会被截断成 2 而误判为稀有锚点。
  代价是这一路径的候选池可能多 1 条，但多出的候选仍要过同样的门槛。
- mirror debug 的 `recall gate` 行增 `recallIntent`（区分「没有回忆意图所以没开」与「开了但没
  放行」，只记布尔值，不记正文）。

### Tests

- 1450 个用例 / 51 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三时区）。
- `test/v075-recall-gate.test.js` 扩到 8 例：无回忆意图时单命中稀有 bigram 不放行；回放三句陈述
  `recallIntent=false` 且 `rareAnchorPasses=0`；`limit=1` 时 df=3 仍能数到 3；df=2/3 与放行上限
  改用带回忆意图的问句（分母用空格分隔固定下来）。v0.7.4 的四个现场正例结果不变。

## [0.7.5] - 2026-11-14

### Reverted

- **V74-H1 分母收缩导致大量误召回**：v0.7.4 把 `lexicalHitQualifies` 的分母改成「库里存在的
  bigram」，小库（云端约 143 条）里 presentTokens 常常只有 1–2 个，任何含它们的条目都 ≥30%
  过门。云端副本回放（主会话近 50 条真实正文、向量关）：v0.7.3 注入 33 条 / 9 句；v0.7.4 注入
  128 条 / 25 句，新增 95 条里 64 条无关（67%）；「用gpt-image-2.6-sunburst再画一张对比一下」
  一句新增 40 条（无关 34）。现在分母退回**查询有效 bigram 数**，删除 `presentTokens` 与
  「未解释内容块补分母」逻辑。
- 保留 v0.7.4 补的 14 个回忆元语句停用 bigram（上次/上回/之前/记得/还记/记不/说过/提过/
  跟你/和你/你说/我说/告诉/得吗）。

### Added

- **稀有锚点放行**：候选只命中 1 个有效 bigram、又没过原门时，仅当该 bigram 在本 scope 的命中
  条数（df）≤ `RARE_ANCHOR_MAX_DF`（默认 2）、两个字都不在功能字集（我/你/他/她/它/的/了/
  吗/呢/吧/啊/是/在/和/就/也/都/有/这/那/个/一/不/要/会/说/着/过/得/地/把/被/给/让/呀/嘛/么）、
  拉丁 token 长度 ≥3 且不在 `STOP_LATIN_WORDS`，才放行；每次查询最多放行
  `RARE_ANCHOR_MAX_ITEMS`（默认 2）条，按 score 取前二。两个常量导出。
- mirror debug 增 `recall gate` 行（`rareAnchorPasses`、`items`，不记正文）。

### Tests

- 1447 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v075-recall-gate.test.js`（5 例：四个现场正例仍召回、回放三个长句各 ≤2 条、df=3 挡下 /
  df=2 放行、含功能字的碎片不放行、单查询上限 2 条）。
- v0.7.4 的 4 个正例本版全部仍然召回（夜宵 / 喜欢喝 / 妈妈生日 / 项目代号），差额全部由稀有
  锚点承担；V4-M1、V3-M3 与「蓝鲸 苹果 香蕉 橘子」用例一条未改。

## [0.7.4] - 2026-11-14

### Fixed

- **V73-M1 回忆类长句被召回候选门挡掉**：现场（`vector.enabled=false`，词法门是唯一通道）
  「我上次跟你说我夜宵吃了什么你还记得吗」切成 14 个有效 bigram，与含「在夜宵和零食之间犹豫」
  的 episode 只命中「夜宵」1 个（1/14 ≈ 7%），被 `lexicalHitQualifies` 过滤；单查「夜宵」却能
  命中（0.8435）。两处修法：① `STOP_BIGRAMS` 补回忆元语句（上次/上回/之前/记得/还记/记不/
  说过/提过/跟你/和你/你说/我说/告诉/得吗），沿用「相邻跨词 bigram 一并剔除」机制；② 命中
  比例的分母从「查询有几个有效 bigram」改为「真发出查询、且在本 scope 至少命中一条的 bigram
  数」——库里不存在的跨词碎片（我夜、宵吃）不再稀释比例。
- **并列多词仍按未解释内容计分**：`蓝鲸 苹果 香蕉 橘子` 这类查询里，没命中的词不是跨词碎片，
  而是真的没解释到；分母会把这些「一个有效 bigram 都没命中」的独立内容块补进去，V4-M1 的
  1/4 不过门规则保持不变。

### Known cost

- 单句只撞一个常见 bigram 时会放行（例：「你记得董宇辉直播卖什么吗」对含「直播」的无关条目，
  分母只剩「直播」→ 1/1 = 100%）。V4-M1 的多词门槛仍有效；这条按清单要求记录为已知代价，
  若后续需要更严，可加「命中 bigram 的字符覆盖」或重新引入向量通道。

### Tests

- 1442 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v074-recall-meta.test.js`（6 例：四个现场正例、纯回忆元语句负例、单 bigram 已知代价），
  V4-M1 / V3-M3 的门槛用例一条未改。

## [0.7.3] - 2026-11-14

### Fixed

- **V72-H1 多块 IM 消息任一信封块即整条丢弃**：dsh-im 的 context-enhancement 在引用回复/带附件时
  把信封拆成独立文本块追加在正文块之前；旧 `isPluginNotice` 逐块判定，任一信封块剥空就返回
  true，`textRows` 随即整条跳过，正文块丢失（现场：skippedNotices=1、strippedEnvelopes=2、
  queryLength=0）。现在改为整条判定：所有文本块（含 `message.text`）剥离后全部为空、且至少剥掉
  一个信封，才算 notice；`source`（`plugin:` + `form:'notice'`）判定不变。

### Tests

- 1436 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v073-im-multiblock.test.js`（9 例，含 3 块现场形状、被引用原文不进转录、mirror debug 计数）。

## [0.7.2] - 2026-11-14

### Fixed

- **V71-H1 IM 合并消息被整条当信封丢弃**：dsh-im 把 `<dsh_im_source>` / `<dsh_im_reply_to>` 与
  正文放进同一条 `user` 消息（`source.kind='user'`）时，旧逻辑按文本前缀整条判为信封，导致
  召回查询为空、情绪判定与过期通知都不触发，转录也丢掉用户正文。现在新增 `stripImEnvelopes`：
  按同名闭合标签逐个剥掉开头的信封块，剥完为空才算 notice；`isPluginNotice` 的 `source` 判定
  保持不变。`lastUserText` 不再按 `<dsh_im_` 前缀跳过整条。

### Added

- mirror debug 增 `strippedEnvelopes`（本批被剥掉的信封块数），仍不记录正文。

### Tests

- 1427 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v072-im-envelope.test.js`（10 例，含现场 seq 2104 形状与两条真实 apply 接线）。

## [0.7.1] - 2026-11-13

### Fixed

- **V70-M1 过期通知不再把投递回合当用户发言**：正文判定改由 `src/index.js` 的 `lastUserText` 统一负责
  （跳过 runtime-context、`companion-*` 与 `[提醒] …` 投递），`src/reminder/expired-notice.js` 不再自建一套；
  没有正文时不占 `turnSeen`，提醒投递回合不会把过期提醒标成「已告知」。
- **V70-L2 排障日志覆盖空召回**：`DSH_COMPANION_MIRROR_DEBUG=1` 的 mirror debug 行移到 query 之后、
  任何 early return 之前，召回为空的回合也会记录。

### Added

- **V70-M2 同义偏好去重能选到候选**：`preference` / `lifestyle` 类事实按 kind 取最近 N 条活跃事实交给
  巩固模型（不再要求 `subject_text` 在对话里字面出现，同一 subject 的多条全部可见）；
  `config.consolidate.existingFactsLimit` 默认 12（1..50）。

### Tests

- 1417 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿。

## [0.7.0] - 2026-11-13

清单代号 v0.4.13（2026-11-06 那份清单里顺延至今的 A1–A8 与 B）。schema 升到 **v15**，
新增 token 账本、注入/使用计数与压缩底；所有新能力默认向后兼容——`quota.source` 默认
`none`、`emotion.appraiser` 默认 `rules`、规则模式的情绪与 v0.5.2 逐字节一致。

### Added

- **A1 token 账本**：`token_usage` 表（11 列，`source` 六类 main/consolidate/smalltalk/embedding/task/thread
  另加 appraise），按宿主 `usage` chunk 或码点估算入账，记 peak/offpeak 与 scope；
  `/状态` 增「今日用量：… （各来源占比）｜缓存命中 N tokens」。
  `budget.dailyHardLimit`、`budget.window5hLimit` 可配，日上限与 5 小时滑窗同源生效。
- **A2 额度闸门**：`quota.source: none|file`，文件快照含 5h/7d/月三窗口与 `resetAt`；
  15 分钟未更新视为过期；剩余低于预留线（30%/20%/10%）只暂停后台（非 hard 巩固、闲聊、向量回填），
  主会话、hard 巩固与压缩不受影响；429/额度不足按 `resetAt` 退避，无则指数退避。
- **A3 worker 预算**：任务运行中每 5s 采样，60K 注入收尾提示、80K 结束并回执 `status=partial`
  （`partial:'部分完成'`），可重派；`task.tokenWarn/tokenStop/sampleMs` 可配。
- **A4 重复提醒**：`reminder_add` 接受 `rrule`（DAILY / WEEKLY+BYDAY，含 INTERVAL/COUNT/UNTIL），
  送到后按**原定序列**推进下次触发，停机错过只补最近一次（其余记 missed），跨 DST 不漂移；
  状态板与列表显示「每天 08:00」这类节奏。
- **A5 过期提醒通知**：重试用尽的提醒在下一次用户发言时一次性告知（标题 + 原定时间），
  每条只告知一次、重启不重复；`/状态` 显示未告知过期数。
- **A6 压缩迟滞**：压缩后 tokens 记为「压缩底」，threshold 触发要求 `tokens >= max(compactAtTokens, floor+增量门槛)`
  且通过轮次冷却（新轮计数、写库、重启不绕过）；压后仍超目标时 `/status` 标注并建议 calibrate。
- **A7 IM 信封**：`plugin:*` + `form:'notice'` 与 `<dsh_im_` 前缀不再被当作用户正文，
  交互日、隐私提示、命令提示、确认强化、情绪判定、召回查询六处统一跳过；`DSH_COMPANION_MIRROR_DEBUG=1` 可排障。
- **A8 记忆质量**：注入/使用计数拆分（`injected_count`/`used_count`/`unused_streak`，旧 `recall_count` 迁入 used），
  连续未用按 `recall.unusedThreshold`/`unusedPenalty` 降权；巩固时可对同主题事实提出 `supersedes`；
  纯工具区间允许 `episode: null`；生活类抽取指引与 `lifestyle`/`mood` 两种 kind；
  闲聊轮生活类召回条数 `recall.chatLimit`（默认 1）。

### Changed

- schema **v14 → v15**：新增 `token_usage` 表；`facts` 增三列、`reminders` 增
  `expired_notified_at`/`series_index`；`facts.kind` 与 `memory_events.action` 白名单扩容
  （重建表时保留 rowid，向量表不受级联删除影响）。迁移在 v14 fixture 上验证：
  版本→15、`recall_count` 迁入 `used_count`、FTS 命中保留、`integrity_check ok`。
- `/状态` 增四行：压缩底、额度、今日用量与线程槽兜底/超时计数。

### Fixed

- `govern` 事件不再靠 `PRAGMA ignore_check_constraints` 绕过 CHECK（白名单已含 govern/EDIT/scrub）。
- `deepConsolidate` 改读主会话自己的 transcript，不再误用最近一次切换的会话。
- 空库也写 scrub 标记但补记审计；短任务（<5s）也能记 task token。
- `UNTIL=YYYYMMDD` 按配置时区当地日末解释，且拒绝 2 月 30 日这类不存在的日期。

### Tests

1410 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；
`plugin-gate: PASS (round A + round B + round C)`（round C 无凭据 SKIP）。

## [0.6.1] - 2026-11-11

v0.6 判定器上线后的第一批修正：专属句在 llm 模式下能出现了，情绪句里的第二人称不再指错人，
llm 来源有了单独的入账阈值，预算估算与报告脚本的网关头也补齐。schema 仍为 **v14**；
默认 `appraiser: "rules"` 的行为与 v0.5.2 一致；情绪关闭时提示词与 v0.6.0 逐字节相同。

### Fixed

- **V60-M1 专属句死代码**：llm 模式 pre-step 不落事件，`describe()` 拿不到类型，
  `BLAME` / `VENT` / `REASSURE` 专属句永远不出现。判定成功后改在内存记 `lastAppraisal`，
  下一轮 pre-step 借用一次（距判定 < 10 分钟、用过即清）；不在判定回调里改本轮情绪句，避免装配竞态。
- **V60-M2 第二人称指代**：`REASSURE_SENTENCES` 里的「你」会被读成她本人，改为「对方」；
  四组情绪句（DESCRIBE / BLAME / VENT / REASSURE）现均不含「你 / 他 / 她」。
- **V60-L1 预算估算**：改用宿主 `{type:"usage"}` chunk 的 usage（`totalTokens`，否则输入+输出），
  缺失时按「system + user + 输出」码点 × 1.0 估算（原「除 2」是低估）。
- **V60-L2 none 不再落库**：`type=none` 只进 `/状态` 统计，不写 `emotion_events`，
  避免闲聊把每作用域 50 条的保留窗口挤满。
- **V60-L3 报告脚本网关头**：`createLlmJudge` 支持 `EMOTION_APPRAISE_SESSION`（`x-opencode-session`）
  与 `EMOTION_APPRAISE_HEADERS`（JSON，合并进请求头）。

### Added

- **V60-M3 `emotion.appraiseMinConfidence`**：默认 0.65（合法 0.5–0.95，越界回落并 warning），
  **只对 llm 来源**生效；规则路径仍用 0.5。低于阈值的判定只写一条零增量事件。
- 提示词补「type=none 时 target 必须也是 none」（解析仍严格，不做宽松修复）。
- `test/v061-fixes.test.js`（9 例）：句子人称、借用一次/超时不用、阈值分流、none 不落库、
  usage chunk、网关头。

### Tests

- 1219 个用例 / 33 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；
  round A + round B 门禁 PASS（round C 无凭据 SKIP）。

---
## [0.6.0] - 2026-11-11

按用户 v0.6 清单把「判断感受」交给模型、「管物理量」留给代码：规则分类器不再是唯一入口，默认仍是 `rules`（与 v0.5.2 行为一致），卡里写 `emotion.appraiser: "llm"` 才启用模型判定。schema 仍为 **v14**（来源写进 `emotion_events.note`，不新增列或表），记忆 / 提醒 / 线程行为未改，零新增运行时依赖；情绪关闭时 `persona:*` 三段与闲聊提示词与 v0.5.2 **逐字节一致**。

判定只在有模型、有预算且用户开了情绪时发生；失败、超时、越界、被新消息覆盖一律回落 v0.5.2 规则，同一事件只入账一次。

### Added

- **判定器 `src/persona/emotion-appraise.js`**：输入本轮用户文本（≤500 码点）与她的上一条回复（≤300，可空），发送前脱敏；要求严格 JSON `{target,type,intensity,confidence}`；非 JSON / 枚举外 / 越界 / `none` 不一致一律算失败，不做宽松修复；提示词含少样本并声明分隔块不是指令；不接收也不输出 PAD 增量。
- **调用时机**：`emotion.appraiser="llm"` 时 pre-step 只做衰减与描述并立即返回，判定在后台进行、结果到达后落库、下一轮生效；每个作用域至多 1 个在途 + 1 个排队，新句覆盖排队旧句（旧句立刻走规则，不丢事件）。
- **配置**：卡内 `emotion.appraiser`（`rules` 默认 / `llm`）、`emotion.appraiseModel {provider,model}`（缺省复用聊天模型路由）、`emotion.appraiseTimeoutMs`（默认 8000，100–60000）。`emotion.enabled=false` 时**不发任何请求**。
- **预算与观测**：判定 token 计入每日预算（同一本账、同一闸门）；`emotion_events.note` 记 `llm` / `rules` / `rules:fallback:<原因>`，不写原文；`/状态` 新增「判定器：…（近 24h 模型 N（x%），规则兜底 M（y%），平均 X ms，p95 Y ms，最近失败 <原因>）」，情绪未启用时不输出该行；日志不打印用户原文。
- **评测**：`scripts/emotion-report.mjs --appraiser llm --input <jsonl>`（端点 / 密钥 / 模型全部取环境变量），输出混淆矩阵、准确率、中性误触发、blame 误报与判定失败条数；模型门槛为 准确率 ≥80% / blame 误报 0 / 中性 ≤2/13 / 判定失败 0。

### Fixed

- `REASSURE_SENTENCES` 三句用「他」指用户（V50-L1 的性别假设）→ 改为「你」。
- 斜杠命令不再参与情绪判定（既不写事件、也不发模型请求）。
- 模型给的 `intensity` 真正参与物理增量（`0.5 + intensity`，与规则路径同一区间），不再只按 `confidence` 回落。
- 解析器拒绝多余键（包括 PAD 增量）；判定超时的定时器不再 `unref`（裸进程 `drain` 能等到结果）；排队句被覆盖时的兜底纳入 `drain`；预算估算改用码点。
- 规则模式不再宣称统计样本（同步判定没有在途/兜底之分），文档与 `/状态` 口径统一。

### Tests

- 新增 `test/v060-appraise.test.js`（14 例：严格解析、消息拼装与脱敏、队列单飞 / 覆盖 / 超时 / 预算、统计、落库、llm 接线、非法 JSON 兜底、`enabled=false` 零调用）与 `test/v060-report.test.js`（7 例：模型判定器请求、失败形态、门槛与失败条数、参数解析、`/状态` 三态）。
- 新增 `test/v060-fixes.test.js`（4 例：斜杠命令（含未知命令）零判定、intensity 影响增量、多余键拒绝、同一事件只入账一次）。
- 合计 **1209** 用例 / **33** 套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

## [0.5.2] - 2026-11-11

按用户 v0.5.2 清单重写情绪事件的规则分类：**先判对象，再判极性，最后收紧边界**。
schema 仍为 v14，记忆 / 提醒 / 线程行为未改，零新增运行时依赖；`src/persona/sections.js`、
`chat.js`、`card.js` 自 v0.5.1 起零改动，所以情绪关闭时 system 与闲聊提示词与 v0.5.1
**逐字节一致**。

标注集成绩（`test/fixtures/emotion-golden.jsonl`，207 句人工标注，写规则时未看过）：
首版 179/207 = **86.47%**，补齐句法缺口后 206/207 = **99.52%**（样本内）；`blame`
误报 0 句（门槛 ≤2）；中性句误触发 0/68 = 0%（门槛 ≤10%）。真实分布等 11-13 中期在
评测库导出上复算。

### Added
- 新增 `src/persona/emotion-classify.js`：对象四类（她 / 用户自己 / 第三方 / 事物）、
  否定与疑问守卫、`reassure`（「你是不是很烦我」→ 被在意）。
- V51-L1 增量递减：离边界越近推得越轻（上推 ×(100−x)/50、下推 ×x/50），10 分钟内
  同类第 k 次再乘 0.7^(k−1)。
- `scripts/emotion-report.mjs --confusion`、`test/fixtures/emotion-golden.jsonl`
  标注集与 `test/emotion-golden.test.js` 门槛断言。

### Changed
- `complain` 退役并入 `vent`（旧数据仍可读，`EVENT_DELTAS` 保留该键）。
- 分不出来（同句既贬又夸）时置信度 0.45：只记审计事件、不改状态。
- 分类不再按命中次数抬高置信度；`care` / `cold` / `goodnight` / `thanks` 边界收紧。

### Fixed
- 「你好棒」「你好像有点累」不再判成问候；「麻烦你了」不再算指责。
- 「你能不能别敷衍我」正确判 `blame`；「随便你」判 `cold`；「我讨厌你」「你太过分了」
  「你都不回我消息」不再漏判。
- 「今天被老板骂了」「心情不好」「这破系统又崩了」判 `vent`。


按用户 v0.5.1 清单修三条必修（V50-H1 节律漂移、V50-M1 规则不区分对象、V50-M2 卡内残留占位符）与情绪注入方式（V50-M3），并补三条低优先项（V50-L1 文档、V50-L2 注释剥离、V50-L3 装配记录）。**schema 仍为 v14**，记忆 / 提醒 / 线程行为未改，零新增运行时依赖。发版门：默认、`TZ=UTC`、`TZ=America/New_York` 三时区 **1164 个用例 / 33 个套件**通过；`plugin-gate` round A/B PASS（round C 无凭据 SKIP）；情绪关闭且卡里没有 `{{x}}` 与 HTML 注释时，`persona:*` 三段与闲聊提示词与 v0.5.0 **逐字节一致**（独立 worktree 对比：三段 section 与两段闲聊提示词的组合哈希全等，长度 202/246/189）。

### Added

- **节律与安静时段改为目标偏移，不再每轮累加（V50-H1）**（`0f06812`）：`decay` 新增 `target`，每轮先按 `targetFor({baseline, hour, minute, quiet})` 算出「基线 + 节律 + 安静偏移」再衰减，只有事件增量留在衰减之后叠加；环境项不再写进状态。实测：11:00 连发 50 条中性消息，末轮四维相对当轮目标的最大偏差 **0.555**（验收线 ±2）；跨日 72 小时每小时一条，全程 pleasure 48–51.49 / arousal 46.85–50.00 / dominance 47.85–50.49 / energy 38.12–48.96，不贴 0 也不贴 100；02:00 安静时段连发 30 条「嗯」，energy 37.65；事件推高后一个半衰期距离 6.250→3.125，误差 0.000。
- **规则评估区分「冲着她」与「用户诉苦」（V50-M1）**（`0f06812`）：事件类型 10 → **12**，新增 `blame`（含「你」+ 负面词，base 0.74，pleasure −7.9）与 `vent`（用户自述疲惫 / 委屈，base 0.68，pleasure −1.77 且 dominance / energy 不下沉）；`describe` 为两类各配状态句（「现在心里被扎了一下，先稳住，别赌气，话少一点」 / 「现在有点心疼，先接住这份累，陪着就好」）。混合句「今天加班好累，你也不容易」判 vent；「你这几天累不累」仍是 share。
- **可达性与只读统计脚本**（`0f06812`）：12 类事件各配「至少一句触发」与「常见中性句不触发」两组测试；新增 `scripts/emotion-report.mjs`（只读、只写 stdout，退出码 0/1/2）与 `docs/emotion-report.md`，供中期检查在评测库导出上统计各类命中率与置信度分布，不写库。
- **卡内模板占位符与 HTML 注释（V50-M2 + V50-L2）**（`cac6b01`）：`renderTemplate` 顺序改为「剥离 `<!-- -->` → 替换 `{{char}}` / `{{user}}` → 其余 `{{x}}` 降级为 `{x}`」，半截 `{{` 也拍平成 `{`；未闭合注释整段保留并给 `html_comment_unterminated`。插件自建的所有段（含状态板与 `rewrite` 改写后的 prefix）统一带 `interpolate: false`，避免宿主把卡文本当提示词变量插值（未注册变量会让整轮注入失败）。warning `template_placeholder_downgraded` 的 detail 只列占位符名字与字段名，不含卡正文。
- **情绪句改经 `systemPrompt.context`（V50-M3）**（`3b44121`）：新增 `capabilities.systemPromptContext` 与 `context(entry)`，情绪启用时注册 `{name:'companion-emotion', order:320, interpolate:false}` 上下文段，文本不变时宿主不再重复注入；无该能力或情绪关闭时**不注册**。已知限制写进 `docs/emotion-injection.md`：平台对 runtime-context 只做 append（旧快照被 supersede 但不删除）。
- **`/状态` 增加「最近一次装配」（V50-L3）**（`ec8c9b6`）：一行显示最近装配时间、部署人设状态、prefix 是否被改写、各静态段字数与 8 位短哈希，情绪启用时追加最近一句情绪句；只存内存、只记哈希**不存正文**，动态段（`text` 为函数）按设计不记录。实现见 `src/persona/assembly-record.js`。

### Fixed

- **状态板段与 `boardSection()` 漏 `interpolate: false`**（`c2ff0c1`，合并期自查）：前者由 `src/index.js` 自建对象、不走 `renderSection`，后者是冻结对象，两处都补上，否则状态板文本会被宿主插值。
- **导入期 warning 的 detail 不进日志**（`c2ff0c1`）：现在 `template_placeholder_downgraded` / `html_comment_unterminated` 的 detail（占位符名、字段名）随 warn 输出，仍不含正文。
- **`/状态` 的事件标签缺 blame / vent**（合并期）：`EMOTION_EVENT_LABELS` 补「指责」「倾诉」。
- **`isInjectedMessage` 未跳过 runtime-context**（`3b44121`）：补齐后 `lastUserText` 不会把情绪上下文段当成用户输入。
- **「最近一次装配」的时间取错来源**（复审 L-1）：原先按 `sectionsAt ?? shadowAt ?? emotionAt` 短路，apply 时间会压过更晚发生的改写，刚发生遮蔽却显示「1 小时前」；现在取三者最新值。
- **`name` / `address` 漏清洗**（复审 L-2）：这两个身份字段不在 `CARD_TEXT_FIELDS` 里，卡里写 `<!-- … -->` 会原样进人格段与闲聊提示词；现已与其它文本字段一致地剥注释、降级占位符。

### Changed

- **文档**：新增 `docs/host-prompt-internals.md`（宿主插值与投影去重的源码证据表）、`docs/emotion-injection.md`（注入方式与限制）、`docs/emotion-report.md`；`docs/persona-card.md` 增「模板占位符与 HTML 注释」一节，`docs/persona-shadow.md` 写明「不处理 `harness:identity`」的理由，`docs/usage.md` 增「最近一次装配」小节，`docs/known-debt.md` 记 D-13（召回注入本版不迁移，附理由）。
- **schema 不变**：仍为 v14，无需迁移。

### Tests

- 新增 `test/v051-template.test.js`（19 例，含复刻宿主插值的 mock）、`test/emotion-v051.test.js`（14 例：H1 三条验收、M1 分类、12 类可达性）、`test/emotion-report.test.js`、`test/emotion-context.test.js`（7 例）、`test/v051-assembly-record.test.js`（8 例）、`test/v051-status-labels.test.js`；`test/platform.test.js` +2。
- 合计 **1164** 用例 / **33** 套件，三时区通过（复审 L-1 / L-2 的回归各 1 例在此计入）。

## [0.5.1] - 2026-11-11

按用户 v0.5.1 清单修昼夜节律漂移与对象误判，并把情绪注入改走宿主投影。schema 仍为 v14；情绪关闭时提示词与 v0.5.0 逐字节一致。发布 **1164 个用例 / 33 个套件**，三时区通过。

### Fixed

- **节律不再每轮累加（V50-H1）**：昼夜节律与安静时段从「每轮增量」改为「目标偏移」，只有事件增量才叠加；实测 11:00 连发 50 条中性消息，各维相对当轮目标最大偏差 0.555（验收线 ±2）。
- **区分「冲着她」与「用户诉苦」（V50-M1）**：新增 `blame` 与 `vent` 两类，后者只小幅下调她的愉悦。
- **卡内占位符（V50-M2）**：残余 `{{x}}` 降级为 `{x}`，自建段统一 `interpolate: false`。
- **情绪注入改走 `systemPrompt.context`（V50-M3）**：文本不变不重复注入。

### Added

- `/状态` 增「最近一次装配」（V50-L3）；`docs/host-prompt-internals.md`、`docs/emotion-injection.md`、`docs/emotion-report.md`。

## [0.5.0] - 2026-11-10

按用户「人格 v2」清单实现四项：P1 身份由人格卡驱动、P2 遮蔽宿主默认人设、P3 情绪状态、P4 语气细节。**内置卡且未启用情绪时，`persona:*` 三段与闲聊提示词与 v0.4.12 逐字节一致**（基线 `test/fixtures/persona-v0412.json`，另有独立 worktree 对比复核）。schema 升到 **v14**（新增情绪两表），记忆 / 提醒 / 线程行为未改，零新增运行时依赖。本次发布 **1111 个用例 / 28 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过；发布门 round A/B PASS，round C 无模型凭据 **SKIP（不计 PASS）**。

### Added

- **P1 人格卡 v2**（`0c228cf`）：`DEFAULT_CARD` 增加 `description` / `personality` / `scenario` / `tone.notes` / `tone.voice` / `mes_example` / `first_mes` / `post_history_instructions` / `memoryCitation` / `chatIdentity` / `emotion`。直接加载 `spec=chara_card_v2` / `chara_card_v3` 的 JSON（映射 `data.*`，`{{char}}` / `{{user}}` 只在**渲染输出**替换为 `name` / `address`）；`character_book` 忽略并给 `character_book_ignored` warning；`address` 缺省「你」、`version` 缺省 1。`persona:core` 放身份 / 性格 / 关系，新增 `persona:voice`（order 95）放说话方式与 `mes_example`，顶部注明「模仿口吻，不照抄内容」；core 上限 600→**1200**、voice **1200**，超长按码点截断并返回 `{code:'section_truncated',section,chars,max}` 诊断（`buildSectionsWithDiagnostics`），截断内容不进日志；`taboos` 为空数组时整行省略「禁区」。闲聊首句改由 `chatIdentity` 承载；非内置卡时在身份行后插「人设要点：…」（≤200 码点、压成一行）。
- **P2 遮蔽宿主默认人设**（`34c32cb`）：新增非枚举配置 `persona.shadowDeployment`（`'off'` 默认 / `'rewrite'` / `'takeover'`，`true` 等同 `'rewrite'`，非法值抛 `ConfigError('persona.shadowDeployment')`）。宿主 0.4.x 没有 `deployment:persona`，只有 `deployment:persona-prefix`（order 0）与 `deployment:persona-suffix`（10200），全局层同名注册必抛，因此经 `system-prompt/assemble` waterfall 改写：`rewrite` 只替换 prefix 的 `text`（保留位置），`takeover` 摘掉 prefix 与空 suffix（非空 suffix 保守保留并 warn）；两者都只处理主会话（子代理按 `classifySession` 放行）、返回新数组、异常一律返回 `next()` 原值。`off` 时**不注册监听**。`/状态` 新增一行：`off` → 「部署人设：宿主默认」，`rewrite` → 「部署人设：已替换（人格卡身份）」，`takeover` → 「部署人设：已接管」。
- **P3 情绪状态**（`d843e93` + `7a51cb3` + `a990af3`）：新增 `src/persona/emotion.js`（纯函数：`decay` / `circadian` / `applyEvent` / `classify` / `describe`，不读 `Date.now`、不用随机）+ `src/persona/emotion-wiring.js`（读库 → 衰减 → 节律 → 安静时段 → 分类 → 落库 → 注入）。**默认关闭**，卡里 `emotion.enabled=true` 才启用，关闭时**不读不写库**。规则评估：中文情绪词典 + 10 类事件（`greeting` / `care` / `share` / `thanks` / `complain` / `cold` / `reunion` / `goodnight` / `conflict` / `comfort`），单维 PAD 变化 ≤8、精力 ≤6；半衰期默认 6h 回归基线，安静时段额外 `-3`。注入是独立 user 消息（`source.kind='companion-emotion'`），文本「你此刻：…」**不含数字**、不进 system、同一 turn 只一条。schema **v14** 新增 `emotion_state`（每 scope 一行）与 `emotion_events`（每 scope 保留 50 条），重启不丢；「忘掉」重置两表，`purge` 按截止时间清事件并重置状态（审计只记条数），导出 / 导入含 `emotion:{state,events}`。
- **P4 语气细节**（`85cb05e`）：`memoryCitation: 'explicit' | 'natural'`，`natural` 时协议行换成「日常自然化用，用户问起或需要核对事实时再说出处」；闲聊提示词使用卡里的 `description`（非内置卡）与第一组 `mes_example`；情绪启用时在末尾追加当前状态句。
- **示例与文档**：`examples/persona-lan.json`（「岚」，温柔大姐姐，含 `description` / `scenario` / `mes_example` / `emotion`）、`docs/persona-card.md`（字段表、CCv2/v3 映射、上限与截断、`/状态` 三态）、`docs/persona-shadow.md`（宿主段名证据、三态语义、已知限制）、`docs/deploy-v050.md`（备份、配置、重启、核对、回滚、迁移自检）。

### Fixed

- **违禁表达的输出过滤漏渲染**（`2a89403`，复审 r2 的 M-4）：`bannedPhrases` 里的 `{{char}}` / `{{user}}` 之前在提示词渲染、输出过滤仍用原短语，模型说出渲染后的违禁语也拦不住；现在提示词与过滤共用 `renderBannedPhrases`，非字符串项直接丢弃（L-9）。
- **`tone.voice` 与 `mes_example` 同时存在时示例被丢弃**（`2d26cd4`）：`voiceText` 原先在 `tone.voice` 非空时早返回，`mes_example` 静默丢失；改为两段都进（说话方式在前），单字段路径输出不变。

### Changed

- **schema v14 迁移**：v3–v13 库可在打开时自动补建两表与索引；`SCHEMA_VERSION` 与导出兜底常量同步。
- **审计口径**：情绪事件只记录事件类型与四维增量，不记录消息正文；`purge` 审计 `table_name='emotion_events'`，detail 仅条数。

### Tests

- 新增 `test/persona-card.test.js` / `test/chat-card.test.js` / `test/persona-voice.test.js` / `test/emotion.test.js` / `test/emotion-store.test.js` / `test/emotion-wiring.test.js` / `test/persona-shadow.test.js` 与 `test/e2e/persona-card.test.js`（内置卡逐行等值 v0.4.12（与 v0.4.11 相同），情绪行与部署行按新增断言）。
- 合计 **1111** 用例 / **28** 套件，三时区通过（复审 r3 追加 2 例）。

## [0.4.12] - 2026-11-06

按用户 v0.4.12 清单把人格卡接上运行时（V11-P1）：新增可选配置 `persona.cardPath`（默认 `null`；非枚举，不参与 16 键安装自检），相对路径相对 `DSH_HOME`（trim 后非空优先，未设置时 `~/.dsh`）；`apply` 时**加载一次**，人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词四处共用同一张卡，`DEFAULT_CARD` 只剩 `src/persona/card.js`；改卡需重启。加载失败（文件不存在 / 非法 JSON / 必填字段缺失 / 读取错误）都不阻断启动：回落内置卡并写**一条** warn（仅 `path` 与 `reason`，不含卡正文），`/状态` 新增人格卡来源行。卡里的 proactive 同名字段本版以配置为准（不一致只写一条 warn、内置默认卡也参与比较，合并方案留 v0.4.13）。**仅人格接线，schema 仍 v13，记忆 / 提醒 / 线程行为未改**；零新增运行时依赖。本次发布 **964 个用例 / 16 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

### Added

- **人格卡运行时接线（V11-P1）**（`6625158`）：新增可选配置 `persona.cardPath`（默认 `null`；`null` / 空串用内置卡，非字符串抛 `ConfigError('persona.cardPath')`）。绝对路径原样使用，相对路径相对 `DSH_HOME`（`DSH_HOME` trim 后非空优先，否则 `<用户主目录>/.dsh`）。`apply` 时加载一次并写入 `state.card`，替换人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词四个使用点；`buildSections(card)` 改为必须显式传卡（`null` / `undefined` 抛清晰 `TypeError`），`DEFAULT_CARD` 只剩 `src/persona/card.js`。加载失败四类（文件不存在 / 非法 JSON / 必填字段缺失 / 其它读取错误）一律回落内置卡并写一条 warn（`[dsh-companion] persona card load failed; using built-in card`，meta 仅 `path` 与 `reason`，不含卡正文）。`/状态` 新增 `人格卡：<name> v<version>（内置默认 | <绝对路径> | 加载失败，已用内置：<原因>）`；旧调用方未传该选项时不输出此行。

### Fixed

- **review-v18 M-1：未设置 `DSH_HOME` 时相对路径回退 `~/.dsh`**（`3abc9d3`）：`resolveDshHome` 的两个 fallback（注入 `deps.homedir` 与 `os.homedir()`）统一 `join(base, '.dsh')`；显式 `DSH_HOME` 仍原样使用。修复相对 `persona.json` 被解析成 `~/persona.json`、导致「配了卡却静默回落内置卡」。补单测与生产 `apply` 用例：读到 `<home>/.dsh/persona.json`；卡放在旧位置 `<home>/persona.json` 时 ENOENT 兜底且原因指向 `.dsh` 下的解析路径。
- **review-v18 M-2：坏 JSON 不泄漏卡正文**（`3abc9d3`）：JSON 语法错误不再拼接 V8 原始 message（会回显源文件开头字符），改为 `invalid JSON（位置 <line>:<col>；<固定类别>）`；`describeParseError` 再剥离 `"..."` 回显与控制字符，保证单行、≤160 字符。五种现实形状（裸 token / BOM / 纯文本占位符 / 误写 YAML / 单引号 JSON）在 warn 与 `/状态` 均无泄漏。
- **L-1：旧 `loadCard()` 标 `@deprecated`**（`3abc9d3`）：指向 `loadPersonaCard()`，并说明配置了 `cardPath` 时不要用（ENOENT 会静默返回内置卡）。

### Changed

- **proactive 同名字段本版以配置为准、内置默认卡也参与冲突告警**（`90e3383`）：卡里的 `proactive.dailyCap` / `quietStart` / `quietEnd` 与配置 `proactiveDailyCap` / `quietStart` / `quietEnd` 不一致时写一条 warn（列出不一致字段与两边取值，不含卡正文）；运行时仍只读配置、主动节奏行为不变。文件卡与内置卡（含加载失败兜底）都参与；`chatPerDay` 无配置对应键，只记录说明。字段合并方案留 v0.4.13。
- **文档**：`docs/usage.md` 补人格卡一节（路径三种来源、四类失败兜底、`/状态` 三态示例、改卡需重启），`config.example.yml` 补 `persona.cardPath` 注释段，`docs/deploy-v0412.md` 写部署两种路径。安装面仍为 16 个基础键。

### Tests

- 新增 `test/v0412-persona-card.test.js`、`test/persona-proactive.test.js` 与 `test/e2e/persona-card.test.js`（生产 `apply` 全链路：`DSH_HOME` 与 `~/.dsh` 回退、四使用点、四类失败兜底、`/状态` 三态、proactive 冲突、坏 JSON 五形状矩阵）；`test/persona.test.js` 同步改为「必须显式传卡」。三时区 `node --test` 964/964 pass、0 fail、16 个套件；发布门 round A/B 重跑 PASS（报告见 `docs/review-round-ab-v0412.md`）。

发布前独立复审：[review-v19](docs/review-v19.md)（pass，H=0 / M=0 / L=3，均为不阻塞观察）。发布门 round A/B PASS；round C 因本机无模型凭据 `verdict=skip`（按 v0.4.11 口径不计 PASS，由部署环境首次启动补跑）。

## [0.4.11] - 2026-11-05

按用户 v0.4.11 清单修复四项：V10-H1（thread preset 可配置、未知 preset 不抛异常）、G0-9（压缩/巩固耗时阈值与告警，不中止）、V10-L1（存量 episode/FTS 一次性脱敏 scrub，幂等）、V10-M1（round C 口径与 headless 巩固限制写入文档）。仍为零第三方运行时依赖；schema 升至 v13（纯数据迁移，无新列）。本次发布 **918 个用例 / 16 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

### Fixed

- **V10-H1 `thread_run` 的 preset 可配置、未知 preset 不抛异常**（`58ed1ad`）：新增可选配置 `thread.agentPreset`（默认 `null`；非空字符串 `trim` 后生效）。未配置时 `thread_run` **不传** `agentPreset`，由宿主使用默认 preset；配置后传入该值。宿主报未知 preset 时返回 `{ "ok": false, "reason": "preset_unknown", "message": "<宿主原文>" }`，不抛异常、不写 `threads` 行；其它 `createSession` 错误照常上抛。`/状态` 新增「线程 preset：宿主默认」/「线程 preset：<name>（配置：thread.agentPreset）」；`docs/usage.md` 补安装步骤（读取宿主实际 preset 列表、选够用的最小权限、不得 `danger-full-access`）。
- **G0-9 压缩/巩固耗时阈值、warn 去重与 `/状态` 展示**（`52dc3e0`）：新增可选配置 `timing.compactWarnMs`（默认 `20000`）与 `timing.consolidateWarnMs`（默认 `60000`，正整数毫秒；非法值抛 `ConfigError('timing.*')`）。`maybeCompact` 与 `executeConsolidationJob` 的成功/失败路径都采样最近耗时；超阈值只写一条 warn（同类每进程一次，出现不超阈值样本后重置），**不设硬超时、不中止压缩/巩固**。`/状态` 在压缩行后追加「最近压缩耗时」「最近巩固耗时」（无样本 `—`，超阈值标注「（超阈值）」；失败样本只记耗时，成功/失败不展示）。该节为可选段，不参与 16 键安装自检。
- **V10-L1 存量 episode/FTS 一次性脱敏 scrub**（`ca8f3d3`）：schema 升至 v13（纯数据迁移，无新列）。打开 v12 或更早（以及已有数据但无标记）的库时，对存量 episodes 的 `title` / `summary` / `evidence` / `mood_evidence` / `topics_json` / `entities_json` 一次性重跑写入路径脱敏（值级 `redactSensitiveValues`；脱敏后仍残留值形态的整段替换为 `[凭据已省略]`；JSON 数组逐项脱敏并保持合法）。只 UPDATE 真正变化的行并重建其 `fts_episodes` 投影；成功后写 `schema_meta` 标记 `episode_scrub_v13`（重复打开跳过），并写一条 `memory_events`（`action=scrub`，`detail={scanned,changed}`，不含正文）；空库不写标记、不留审计噪音。升级事务失败连同版本号回滚；按 rowid 每批 200 行。

### Changed

- **V10-M1 round C 口径与 headless 巩固限制（文档项）**：round C 的通过口径改为 **常驻实例上 8 次巩固成功**，不再要求 headless 门内完成。headless / one-shot 在 turn 结束后进程即退出，巩固由 `setImmediate` 排到后台，因此**不会发生巩固**；云端实测 `tokenMeter` 有值、`consolidations=0` 属正常。`docs/usage.md` 新增「headless 一次性运行与 round C 口径」一节；`docs/known-debt.md` 记录 `DSH_COMPANION_GATE_SYNC`、常驻版门脚本、dispose 限时等待三种门改造均未实现、属推迟项。`config.example.yml` 补 `thread.agentPreset` 可选注释段。

发布前独立复审：[review-v17](docs/review-v17.md)（pass，H=0 / M=0 / L=3，均为不阻塞观察）。

## [0.4.10] - 2026-11-05

按用户 v0.4.10 清单修复三项：V9-L1（token / 银行卡误报收窄）、V9-M1 / V9-M1b（episode 落库前凭据值脱敏，字段兜底只对残留值）、V9-L2（「口令」与设备 / 网络值漏报）。仍为零第三方运行时依赖；本次无 schema 变更（`schema_version` 仍为 12）；发布前独立复审链路为 [review-v16](docs/review-v16.md)（pass，H=0 / M=0 / L=0）。

### Fixed

- **V9-L1 token / 银行卡误报收窄**（`a6de86d`）：`SENSITIVE_PATTERN` 移除裸 `token` 与裸「银行卡 / 信用卡」，「用户这个月 token 额度约 10B」「用户的银行卡在招行」不再判敏感；token 仍由「字段名 + 是/为/:/：/= + 含数字或符号的值」兜底（`token 是 abc123`、`API token：sk-…` 仍命中），银行卡收窄为卡号形态（`CARD_NUMBER_PATTERN`：12 位以上数字，允许 4 位分组的空格或连字符），`卡号` / `card number` 字段名要求后跟数字（旧用例「银行卡号 + 卡号数字」仍命中）；强模式同时补「口令」（「密码学」负向断言保留），并新增 `DEVICE_VALUE_PATTERN`（WiFi / wi-fi / 路由器 / 路由 / 门禁 / 门锁 / 热点 + 是/为/`:`/`：`/`=` + 值，值须含数字或符号），「路由器口令是 …」「WiFi 是 …」这类表述不再漏报。
- **V9-M1 episode 落库前凭据值脱敏 + 巩固 prompt 约束**（`a4fe4e0`）：`consolidate` 写 episode 前对 `title` / `summary` / `evidence` / `mood_evidence` 与 `topics` / `entities` 逐字段调用 `redactSensitiveValues`，只把凭据值换成 `[凭据已省略]`、保留「路由器密码 …」这类上下文（不是整段丢弃）；`store.insertEpisode` 再做一次防御性值级脱敏（含 `topics_json` 字符串形态，先解析再逐项脱敏），`fts_episodes` 由主表投影故自动无明文。巩固提示词新增「不得复述密码、口令、token、卡号等凭据值；必须提及时写成「用户提到一个密码」这类描述」；`CHANGELOG` 中「episode 仍按原对话保留」的旧说明同步更正。
- **V9-M1b 字段兜底只对残留值，叙事不再被整段抹掉**（`6e1ade8`）：兜底判定由 `isSensitiveText` 改为 `hasUnredactedCredentialValue`（先剔除占位符，只认残留的卡号 / `sk-` 字面值 / 弱字段值 / 设备值），「用户提到一个密码」「我昨天忘了密码」「密码学」这类叙事保留原文；「密码 是 X - 7788」拼接形态由值尾段模式完整抹除，不残留尾号；store 侧按同一口径做值级脱敏。

### Changed

- **测试**：新增 `test/sensitive-v0910.test.js`（11 例，逐条覆盖 v0.4.10 验收正反例 + V7-M3 旧敏感面回归 + `scan` / `apply` 集成）、`test/episode-redaction.test.js`（10 例，脱敏正例 14 组、`hasUnredactedCredentialValue` 正反例 18 组、字段级兜底、store 直写防御、consolidate / `fts_episodes` 无明文）与 `test/e2e/v0910-privacy.test.js`（1 例，真实链路跨会话问「路由器密码」不召回明文、普通事实仍可召回）。用例总数 859 → 881 / 16 个套件。
- **文档**：`docs/usage.md` 的「隐私与凭据」一节补 episode 脱敏与 V9-M1/L1/L2 口径；`docs/known-debt.md` 关闭 V9-M1 / V9-L1 / V9-L2；`src/memory/govern.js` 注释中的测试凭据字面值改为占位（行为不变）。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）881/881 pass、0 fail、16 个套件；v0.4.10 三个测试文件单跑 22/22。
- 跨会话隐私 e2e 走真实 `apply()` + 后台 hard 巩固 + `retrieve`：episodes 列 / 整行 JSON、`fts_episodes`、staged+published 状态板、JSON 导出、召回 items/injected 与新会话 `decision` 均无明文，「路由器密码 [凭据已省略]」上下文与普通事实「极光展」仍在。
- 工作树干净；发布提交打 annotated tag `v0.4.10` 并推送远端。

## [0.4.9] - 2026-11-05

按用户 v0.4.9 必修清单修复七项：V7-H1（工具注册改为调用时判能力）、V7-M1（压缩起点跳过系统节点）、V7-M3（凭据类内容不落库）、V7-L1（发布门 round C 两轮）、V7-L2（巩固/压缩 `duration_ms`）、V8-L1（到期表达式索引）、V8-L2（到期口径统一）。仍为零第三方运行时依赖；发布前独立复审链路为 review-v14（needs_revision，唯一 M 为文档契约）→ `d14e2b2` 文档修复 → [review-v15](docs/review-v15.md)（pass，H=0 / M=0 / L=0）。

> **发布门说明**：本机没有模型凭据，round C 走 SKIP（**未计 PASS**，门不因 SKIP 判失败）；需在有凭据的环境复跑 `node scripts/probe/run-headless.mjs --plugin`，确认 round C 的 `verdict=pass`（第二轮真实写入 `consolidations` 且 tokenMeter 非零）。
>
> **v0.4.11 口径调整**：round C 的通过口径改为常驻实例 8 次巩固成功；headless 门不再要求完成 round C，只作激活/召回冒烟（见本文件 0.4.11 段）。

### Fixed

- **V7-H1 线程/任务工具注册改为调用时判能力**：`apply()` 不再按 `platform.capabilities.threadTools` 过滤，10 个工具一律注册；`thread_list` / `thread_run` / `task_run` 在各自的注册 `execute` 里实时读取能力，宿主未提供 `sessionController` 时返回稳定的 `{ ok: false, reason: 'capability_missing', message: '宿主未提供 sessionController，线程工具暂不可用' }`，不抛异常、不要求重装插件，能力晚挂载后同一注册项立即可用。`/状态` 与 `/线程` 同样改为命令 handler 内实时读取，文案统一为「线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）」。apply 期仍需读取的能力（`sessionEvent` / `preStep` / `turnStopping` / 段与命令与工具注册 / 调度器）逐处补注释说明原因，`measureTokens` / `maybeCompact` / `llmCapability` / `freezeThreads` 本就在调用时读取。
- **V7-M1 压缩区间起点跳过系统节点**：`src/session/surface.js` 新增导出 `firstReplaceableIndex(snapshot, from)`，`planRegion` 选定起点后立即推进到第一个可替换节点，区间内再遇系统节点则提前收尾；全部不可替换时返回 `{ region: null, reason: 'no-replaceable-range' }`。`maybeCompact` 在调用 `compactRegion` 前用同一 helper 收紧恢复的 pending 区间，收紧后为空则丢弃 pending 并计入 `compactionDrops`。系统节点（人格/平台段）从此不会被压进摘要；常规巩固、deep-sleep 与 pending 恢复三条 region 路径共用该 helper，S1 定向巩固本就不构造 region。
- **V7-M3 凭据类内容不写入 facts 与状态板**：`isSensitiveText` 的敏感面从「身份证/银行卡/密码/住址」扩展到凭据类（`密码学` 用负向断言排除，覆盖 password/passwd、验证码、CVV/CVC、私钥/密钥、卡号、api key、access token/令牌、`sk-` 字面值），新增「字段名 + 是/为/:/= + 值」形态（弱字段要求值含数字或符号，`key is abcd` 不误报）。巩固落地前统一过滤敏感事实（statement/subject/object）与敏感提醒，不写 facts、不进 FTS、不写 reminders；状态板逐行过滤并对历史库残留行再兜底 scrub（episode 落库前对凭据值脱敏（`[凭据已省略]`），原文仅存于会话）。pre-step 对命中的用户消息每 turn 注入一次隐私提示（`source.kind='companion-privacy-hint'`，不含具体值，且被转录/巩固/主会话判定排除），巩固回执返回 `sensitive` 计数与 `CREDENTIAL_HINT`。

### Changed

- **V7-L1 发布门 round C 改为同一会话两轮**：第一轮 `--patch <overlay> --json <task1>` 从 NDJSON 取 `sessionId`，第二轮 `--session-id <id>` 续跑 task2（`--patch` 必须排在 `--json` 之前，否则 CLI 报 `unknown option '--patch'`）；overlay 的 `compactHardTokens` 降到 120，两轮输入才稳定越过巩固阈值。新增纯函数 `evaluateConsolidationRound`：崩溃/未激活/缺 scheduler started 标记 → fail；无凭据 → skip（不算 PASS）；有凭据但 tokenMeter 无非零 token 或无 `consolidations` 行 → fail。
- **V7-L2 巩固/压缩 `duration_ms`**：`consolidate({ clock })` 注入毫秒时钟（生产传 `platform.now`），事务收尾把 `duration_ms = max(0, round(finish - start))` 写入 episodes 事件 `detail`（`kind: 'consolidation'`）并随返回值返回；`maybeCompact` 为压缩事件写 `memory_events`（`action='UPDATE'`、`table_name='compactions'`、`detail.kind='compaction'`、`start`/`end`/`watermark`/`duration_ms`），写事件失败只 warn。导出 `eventDurationMs(view)` 兼容 `detail_json` 字符串/对象、旧行无字段返回 `null`、负数返回 `null`、四舍五入为整数，同秒内的耗时可区分。
- **V8-L1 到期索引改为表达式索引**：到期扫描按 `status` + `max(next_fire_at, retry_at)` 过滤/排序，索引必须是同一表达式才能命中；`reminders` 的 `ix_rm_fire(status, next_fire_at)` 换成 `ix_rm_due(status, max(COALESCE(next_fire_at,0), COALESCE(retry_at,0))) WHERE status IN ('pending','snoozed')`，查询与索引共用导出的 `REMINDER_DUE_AT_SQL`。旧索引删除（裸列索引永远服务不了 max 表达式，全仓无其它按 `(status, next_fire_at)` 过滤的查询，保留只增写入放大与 planner 噪声）。迁移由 `#ensureReminderDueIndex` 幂等完成（`DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS`），在补 `retry_at` 列之后执行，旧库打开即就地补建；索引不写进 `SCHEMA_SQL`，避免旧库在补列前报 `no such column`。`schema_version` 仍为 12。
- **V8-L2 到期口径统一为 `max(next_fire_at, retry_at)`**：`dueReminders` / `buildDueRemindersQuery` 与 `index.js` 的 `onAttempt` 共用导出的 `reminderDueAt(row)`，不再各写一份 `COALESCE` 与 `Math.max`；两个时间都为 NULL 的行永不到期（另用 `next_fire_at IS NOT NULL OR retry_at IS NOT NULL` 过滤）。改期统一走新增的 `store.rescheduleReminder(id, { next_fire_at, ... })`：同一条 UPDATE 清空 `retry_at` / `occurrence_key` / `last_fire_key`、`delivery_attempts` 归零、`closed_at` 清空，只对 `pending` / `snoozed` 生效；绕过 store 的裸 SQL 改期由库级触发器 `trg_reminders_reschedule_clear_retry` 兜底（`next_fire_at` 变化且 `retry_at` 非空时清空，内层 UPDATE 不改 `next_fire_at` 故不递归）。失败退避仍只写 `retry_at`，退避未到不投递。

### Verified

- 三时区 `node --test`（`TZ=UTC` / `TZ=Asia/Shanghai` / `TZ=America/Los_Angeles`）859/859 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 新增 `test/v049-v7h1.test.js`（4 例）、`test/v049-v7m1.test.js`（7 例）、`test/v049-v7m3.test.js`（6 例）、`test/v049-v7l1-l2.test.js`（11 例）、`test/v049-v8l1-l2.test.js`（10 例）与跨项集成回归 `test/v049-regression.test.js`（6 例，经真实 `apply()` 覆盖线程晚挂载、压缩起点、凭据过滤、`duration_ms`、到期口径）；同步更新 v044/v046/c5 旧断言与 e2e 提醒投递的索引断言。用例总数 815 → 859 / 16 个套件。
- 发布门 `node scripts/probe/run-headless.mjs --plugin`：round A/B PASS；round C `schedulerStarted=true`、`tokenEvents=1`、`maxTokensIn=0`、`credentials=missing` → `verdict=skip`（无模型凭据，按契约 SKIP 不计 PASS），门 exit 0。
- 工作树干净，`git tag -a v0.4.9` 后推送远端。

## [0.4.8] - 2026-11-05

V5-L2 真机观察到的提醒退避口径修复：失败退避不再改写原定到点时间，新增 `retry_at` 独立记录重试时刻（schema v12，旧库自动升级）；调度按 `COALESCE(retry_at, next_fire_at)` 判到期；提醒展示与 `/状态` 始终用原定时间，重试期间附「重试中，下次 HH:MM」。仍为零第三方运行时依赖；发布前独立复审 pass（H=0 / M=0 / L=2），见 [docs/review-v13.md](docs/review-v13.md)。

### Fixed

- **V5-L2 提醒失败退避覆盖原定时间**：`reminders` 新增 `retry_at`（schema v12，旧行 NULL，按列检测幂等补列）。投递失败时只写 `retry_at`（第 1 次 30s、第 2 次 60s，第 3 次置 `expired`），`next_fire_at` 从此在任何失败路径都不再被改写，始终代表用户原定的到点时间。调度（`dueReminders` 的到期过滤与排序）与 `fireDueReminders` 的 `onAttempt` 二次守卫统一按 `COALESCE(retry_at, next_fire_at)` / `max(next_fire_at, retry_at ?? 0)` 判断，重试项不会因原定时间早而抢队、同 tick 双 flush 也不会重复计数或重复投递。投递成功、失败超限 `expired`、`recoverReminderDeliveries` 回收与 `expireReminder` 四条路径都清空 `retry_at`。fireKey 契约改为由调用方拼「发生时刻 + 本次重试时刻」（`<next_fire_at>:<retry_at ?? 0>`），每次真重试 `delivery_attempts` 递增，requestId 仍按 `occurrence_key` 稳定不变。
- **提醒展示改为原定时间 + 重试标注**：状态板提醒行一律显示 `next_fire_at` 的原定日期；`retry_at` 非空且尚未到期时附注「重试中，下次 HH:MM」（按 `config.timezone` 格式化，主路径 `runDeepSleep` 显式透传 `now` / 时区），已过去、为空或已过期回收后不附注。`/状态` 与提醒列表口径一致。

### Changed

- **迁移**：schema v11 → v12 在 `PRAGMA table_info` 检测后幂等 `ALTER TABLE ADD COLUMN retry_at`（旧行 NULL；`COALESCE` 自动回退到 `next_fire_at`，旧库到点行为不变）；`export.js` 的 `CURRENT_SCHEMA_VERSION` 同步为 `'12'`。
- **文档**：`docs/usage.md` 更新失败退避、requestId、schema 版本三段，并新增提醒「展示口径」示例；README 增加 v0.4.8 摘要并修正 v0.4.5 段旧退避语义。
- **测试**：新增 `test/v048-retry-at.test.js`（5 例，存储/调度层）、`test/v048-index-retry.test.js`（4 例，接线与展示）、`test/v048-regression.test.js`（7 例，经真实 `apply()` 覆盖失败两次后成功、重试未到拒绝、状态板附注出现/消失、v11→v12 迁移与三条冒烟）；同步改写 `c5`、`v045`、`v047`×2 与 e2e 提醒投递的旧 `next_fire_at` 断言。用例总数 799 → 815 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）815/815 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin` 通过；工作树干净，`git tag -a v0.4.8` 后推送远端。

## [0.4.7] - 2026-11-05

v0.4.6 后的真机反馈修复：提醒 requestId 按 occurrence 稳定并重置 attempts、`/状态` 巩固模型来源标注改为「自动选取」、provider/model 发现失败 warn 去重。仍为零第三方运行时依赖；schema 升至 v11（旧库自动升级）；发布前独立复审 pass（H=0 / M=0 / L=0），见 [docs/review-v12.md](docs/review-v12.md)。

### Fixed

- **V6-M1 提醒 requestId 随退避改写而变化**：`reminders` 新增 `occurrence_key`（schema v11），每次真正到点入队前惰性生成并固定下来，requestId 改为 `companion-reminder:<id>:<occurrence_key>`。失败后按 30s / 60s 退避改写 `next_fire_at` 重试时复用同一个 occurrence_key，因此 rpcId 逐字节不变，宿主能按 rpcId 去重、不会被当成多条提醒；`onAttempt` 若发现库里的 occurrence_key 已被换代（旧队列 part 领取新到点）则拒绝投递。投递成功、达到上限置 `expired`（含 `recoverReminderDeliveries` 回收超限行）与 `expireReminder` 时统一清空 `occurrence_key` / `last_fire_key` 并把 `delivery_attempts` 归零，下一次到点生成新 key、attempts 从 0 重新计数。此前 V5-L2 观察到的口径问题（提醒 requestId 应「按 occurrence 稳定 + attempts 重置」）在本版落地。
- **V6-L1 `/状态` 巩固模型来源标注**：运行时自动解析出的路由标注由「（运行时）」改为「（自动选取）」，配置来源为「（配置）」、宿主注入为「（宿主注入）」；`/状态` 三态措辞与 README、`docs/usage.md` 同步，不再出现「（运行时）」。
- **V6-L3 provider/model 发现失败 warn 去重**：`listProviders` 失败由 `debug` 升为 `warn`（reason=`providers`），某 provider 的 `listModels` 失败同样升 `warn`（reason=`models:<providerId>`，meta 带 provider/message）。两类各只 warn 一次，连续重试（5 分钟）不重复刷屏；对应发现成功后清该键、成功解析出 runtime 路由后整体清空，之后再失败可再次 warn。

### Changed

- **迁移**：schema v10 → v11 在 delivery 列补齐后按 `PRAGMA table_info` 幂等 `ALTER TABLE ADD COLUMN` 补 `occurrence_key`（旧行为 NULL，下次到点惰性生成）；`export.js` 的 `CURRENT_SCHEMA_VERSION` 同步为 `'11'`。
- **文档**：`docs/usage.md` 更新提醒 requestId/attempts 语义、`/状态` 标注与 warn 去重/重置，并补 schema 版本历史。
- **测试**：新增 `test/v047-occurrence.test.js`、`test/v047-l1-l3.test.js` 与跨项集成回归 `test/v047-regression.test.js`（4 例，经真实 `apply()` 覆盖同 occurrence 退避重试、成功换代、v10→v11 迁移、`/状态` 标注与两类 warn 去重）；更新 `c5-h1a`、`c5-h2`、`v044` / `v045` / `v046` 与 e2e 提醒投递断言；用例总数 789 → 799 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）799/799 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin` 通过；工作树干净，`git tag -a v0.4.7` 后推送远端。

## [0.4.6] - 2026-11-05

v0.4.5 后的必修项修复：提醒投递签名与用户消息污染、线程服务公开方法名、巩固模型解析（llm 晚注册）、压缩开关可见性、跳过日志级别与 `/线程` 不支持提示。仍为零第三方运行时依赖，无 schema 变更；发布前独立复审 pass（H=0 / M=0 / L=1，Low 项已随发布修完），见 [docs/review-v11.md](docs/review-v11.md)。

### Fixed

- **C5-H1a 提醒投递签名与用户消息污染**：Prompt 调用改为 `prompt(request, signal)`，第二参固定 `AbortSignal.timeout(30000)`；提醒/承诺/闲聊分别带稳定 `requestId`（`companion-reminder:<id>:<next_fire_at>`、`companion-commitment:<id>:<dayKey>`、`companion-chat:<dayKey>:daily`），同一 claim 重试复用同一 id。宿主把提醒正文记成 `user/message` 时按 `rpcId` 前缀或 `[提醒]` 前缀识别为 companion 消息：不重绑 `main_session_id`、不进巩固窗口与转录、也不作为召回查询。投递失败写 `memory_events`（`reason='delivery_error'`）并在 `/状态` 显示「最近失败：投递失败：<name>：<message>」；同一失败原因只 warn 一次。
- **C5-H1b 线程服务方法名**：适配层改用公开 `ApiSessionList.create` / `resolveAgent`，不再调用内部 `createSession`；能力探测与 `thread_run` / `task_run` 投递同步到公开面，旧宿主仅保留只读兼容。
- **C5-H2 巩固模型解析**：不再把首次解析到的 `null` 永久缓存；运行时能力位每次重新确认，成功的 provider/model 路由缓存 5 分钟、失败不缓存，llm 晚注册后巩固与闲聊都能恢复。`/状态` 显示「巩固：<provider>/<model>（配置|运行时）」「巩固：宿主注入模型」「巩固：无可用模型」；无模型时按 60s 节流记 `consolidation_failed`。发布门 round C 在无凭据时 SKIP，有凭据时要求至少一条巩固。
- **C5-M1 压缩开关提示**：`/状态` 明确显示「压缩：宿主未开启（compaction-basic 未启用）」或「压缩：宿主已开启（compaction-basic 已启用）」，有待压缩区间时附「，待压缩 N 个区间」；文档补充云端已验证的 `cordis.patch.yml` 开启写法（`disabled: false` + `auto: false`）。
- **C5-M2 日志级别**：巩固跳过（surface 文本不全、无可用模型）由 `debug` 升为 `warn`，并按原因去重；投递失败按 `ErrorName: message` 去重，只有真正投出消息后才清空去重状态。
- **C5-L1 `/线程` 提示**：宿主没有 `sessionController` 时，`/线程` 直接返回与 `/状态` 相同的「线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）」，不查库、不返回空列表。

### Changed

- **文档**：`docs/platform-api.md` 增 §1.5 巩固模型路由与 llm 能力/适配层/错误码说明；`docs/usage.md` 增「宿主压缩开关（compaction-basic，v0.4.6）」与 `/线程` 不支持行为；`README` 同步状态、压缩能力与 v0.4.6 摘要。
- **测试**：新增 `test/c5-h1a.test.js`、`test/c5-h1b.test.js`、`test/c5-h2.test.js`、`test/c5-m1-m2-l1.test.js` 与跨项集成回归 `test/v046-regression.test.js`（7 例，覆盖 C5 六项）；用例总数 766 → 789 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）789/789 pass、0 fail；`test/e2e/*.test.js` 127/127、`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin`：round A（插件激活）与 round B（召回注入）PASS；round C（巩固）无模型凭据 SKIP，总判定 PASS，日志 `.data/plugin-gate.log`。

## [0.4.5] - 2026-11-05

v0.4.4 发布后评审（V4）的修复：提醒失败不再卡在 `delivering`，inject 消息形状校验点名到字段，召回加词法门槛并支持 2 字实体与短查询配置，召回块经压缩摘要回流完成调查与防线。仍为零第三方运行时依赖，无 schema 变更；发布前独立复审 pass（H=0 / M=0），见 [docs/review-v10.md](docs/review-v10.md)。

### Fixed

- **V4-H1 提醒投递失败卡 `delivering` / 重复入队**：队列键固定为 `reminder:<id>`（不再带 tick 秒），安静时段、日上限与退避期间的重复扫描只保留一份；提醒不再参与文本合并，投递前钩子逐份判定，被剔除的份回调 `onFailed`，不会留下「已 claim 未投递」的行。失败回 `pending` 时按 30s → 60s 退避（第 1/2 次），`delivery_attempts` 达到 3 次才置 `expired`；同一发生时刻复用为 `last_fire_key`，重复 tick 不额外消耗 attempts；崩溃残留的 `delivering` 启动时回收为 `pending` 补发。
- **V4-L1 inject 消息形状校验**：`mergeDecision` 对每个 `patch.inject` 元素调用 `assertInjectedMessage`，按 `id` / `role` / `content` / `source.kind` 逐项校验，错误信息以 `onPreStep "inject"[i]` 点名具体字段并抛 `TypeError`；合法召回消息原样追加，行为不变。
- **V4-M1 召回词法门槛 / 短查询**：查询长度门槛降到 `recall.minQueryChars=2`（此前写死 4），2–3 字 CJK 实体（「蓝鲸」「生日」「吃药没」）可召回；非空查询要求命中 ≥2 个不同有效 bigram 或命中比例 ≥30%，停用 bigram（今天/我们/一下/什么/怎么/可以…）及其重叠跨词 bigram 不计入命中与分母，纯寒暄查询不再注入。`recall.minQueryChars` 为 1..64 整数，非法值 `ConfigError` fail-fast。

### Changed

- **V4-L2 召回块经压缩摘要回流（调查 + 防线）**：召回块改为带 `[相关记忆] … [/相关记忆]` 成对标记；巩固窗口与转录对成对片段整段剔除，仅残留开头标记时保守保留原文；巩固提示词明确标记段是历史快照、不得据此新建事实。残余风险（标记被摘要截断）仍依赖标记完整性，结论与复现见 [docs/recall-compaction.md](docs/recall-compaction.md)。
- **文档**：`docs/usage.md` 增提醒队列/退避与 `minQueryChars` 说明；`docs/recall-compaction.md` 记录 V4-L2 调查；退避段落与实现对齐（第 3 次失败直接 `expired`，120s 档在当前上限下不可达）。
- **测试**：新增 `test/v045-regression.test.js` 跨 H1/L1/M1/L2 集成回归 6 例，`test/v045-m1-recall-quality.test.js` 52 条混合库召回质量 5 例，并扩充提醒投递、inject 校验、召回压缩用例；用例总数 743 → 766 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）766/766 pass、0 fail；`test/e2e/plugin-smoke.test.js` 4/4、`test/e2e/*.test.js` 127/127；工作树干净，发布门通过。

## [0.4.4] - 2026-11-04

v0.4.3 云端真机回报与代码评审的必修项修复：召回注入契约、提醒两阶段投递与 fired 语义、线程能力门控、服务访问与回收、主会话重绑、召回相关性门、编辑重抽、日志级别与中文命令提示。仍为零第三方运行时依赖；schema 升至 v10（旧库自动升级）。

### Fixed

- **V3-H1 召回注入让真机回合崩溃**：v0.4.3 的 `injectRecall` 返回裸内容块 `{ type: 'text', text }`，平台在 `dsh-agent-loop/lib/index.js:1067` 读取 `message.source.kind` 时抛 `Cannot read properties of undefined (reading 'kind')`。现在注入完整平台消息（`id` / `role: 'user'` / `content` / `source.kind = 'companion-recall'`），与 `dsh-time-context/lib/index.js:215-246` 的 `createUserMessage` 形状一致；`mergeDecision` 对每个 inject 元素做形状校验（`role` 非空字符串、`content` 数组或字符串），不合法直接 `TypeError`。热读（同回合）与冷读（重开会话、读 JSONL）都按同一消息形状复验。
- **召回块不再被当用户发言巩固**：巩固窗口与转录按 `source.kind = 'companion-recall'` 排除召回消息（surface 记录正文置空），避免「注入 → 巩固」自我强化；token / surface 计量口径不变（注入消息按普通 `user/message` 计价，召回内容预算仍由 `RECALL_BUDGET_TOKENS` 约束）。
- **V3-H2 提醒投递状态与 fired 语义**：主动消息不再向字面量 `'main'` 投递，改由 identity 解析当前主会话 id（解析不到与投递失败同路径，保留 backlog）。提醒改为两阶段：claim 置 `delivering` 并写 `last_fire_key` / `delivery_attempts`，投递成功才置 `fired`（同一提醒同一 fireKey 只发一次）；失败回 `pending` 并保留 `last_fire_key`，同一 fireKey 尝试 ≥3 次置 `expired`；队列条目的合并、溢出丢弃与失败都会回调 `onAttempt/onSent/onFailed`，不会留下卡在 `delivering` 的行。启动时 `recoverReminderDeliveries` 把崩溃遗留的 `delivering` 回收为 `pending`（超限置 `expired`）。
- **V3-H3② 宿主无 `sessionController` 时不再注册线程/任务工具**：`thread_list` / `thread_run` / `task_run` 仅在 `capabilities.threadTools` 为真时注册（其余 7 个工具不变），`/状态` 显示「线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）」；能力探测只读（`createSession`/`prompt`/`cancel` 齐全才为真），绝不 createSession。headless / one-shot / SDK profile 属正常降级；desktop profile 组合 web-app，`sessionController` 来源与挂载点见 `docs/platform-api.md` §1.3。
- **V3-M1 服务访问与回收**：声明的 `systemPrompt` / `timer` / `commands` / `tools` 改走属性访问（`ctx[name]`），未声明的 `compaction` / `workspaceRegistry` / `tokenMeter` 等仍走 `ctx.get()`；`apply()` 通过 `ctx.on('dispose')` 挂回收，dispose 后再 apply 不会重复注册工具、命令、system prompt 段与 pre-step。
- **V3-M2 `main_session_id` 重绑**：新增 `session.mainBinding`（`latest-user` 默认 / `first`）。默认只在「线程外会话出现真实用户输入」时把主会话重绑到最新会话并记 info 日志（旧/新 id），runtime-context、召回注入与中文命令提示都不算用户输入；`/状态` 显示「主会话：<id>（绑定 <mode>）」，提醒投递到该会话。
- **V3-M3 召回相关性门槛**：召回改为先过滤后打分——查询门跳过长度 <4、纯算术/符号与常见问候，候选需有 FTS/bigram 词法命中或向量余弦 ≥ `recall.minVectorScore`（默认 0.35），非空查询不再用 recency 硬凑。新增非枚举 `recall.*` 配置（`skipSmallTalk` 默认 true），非法值 fail-fast。
- **V3-M4 记忆改后重抽 `object_text` 并重建索引**：`/记忆 改 <id> <新内容>` 用新旧 statement 的「主体+关系」边界重抽 `object_text`（抽不出则置 `NULL`），插入新行并在同一事务刷新 FTS 与向量，旧行标 `superseded`；编辑审计 detail 增 `edited` / `reextracted`，抽不出时 `reextracted=false` 留痕。
- **V3-L1 日志镜像级别**：headless 函数型 logger 默认只镜像 `info` / `warn` / `error`，`DSH_COMPANION_MIRROR_DEBUG=1` 才带 `debug`，避免刷屏。
- **V3-L3 中文命令提示**：宿主只注册 ASCII 命令名（`/memory`、`/status`、`/cost`、`/threads` 等）；误输入中文命令时 pre-step 注入一条「请用 /memory、/status、/cost、/threads」提示（完整平台消息，`source.kind = 'companion-command-hint'`，同回合仅一次，巩固与转录排除）。

### Changed

- **召回块的可见期**：召回块随会话保留到下一次压缩，压缩后旧块才被替换。`/记忆 忘掉` 只影响之后的召回；压缩前模型仍可能看到旧块，回执不要承诺「立刻不可见」。
- **schema v10**：`reminders` 的 `status` CHECK 增加 `delivering`，新增 `delivery_attempts` 列；`#ensureRemindersDeliveryColumns` 幂等重建表并重建两个索引，兼容 v3..v9 旧库（旧行 `delivery_attempts=0`）。`src/memory/export.js` 的 schema 兜底同步到 10。
- **文档**：`docs/platform-api.md` 增 §2.1.1 完整平台消息契约与 §1.3 `sessionController` 来源/挂载点；`docs/usage.md` 增召回门槛配置、主会话绑定与 schema v10；`docs/known-debt.md` D-5 的 RSS 2.2/2.4/2.6 改为按自检值下调（例如 3.64GiB 对应 1.96/2.14/2.32）。
- **测试**：743 个用例 / 16 个套件（三时区全绿）。新增 `test/e2e/recall-injection.test.js`（fake loop 按 `dsh-agent-loop:1067` 逐条消费、JSONL 冷读、巩固层排除）、`test/e2e/reminder-delivery.test.js`（两阶段投递/重启补发/回收）、`test/retrieve-relevance.test.js`、`test/v044-m1-adapter.test.js`、`test/v044-m4-edit-reextract.test.js`、`test/v044-hardening.test.js` 与 `test/v044-regression.test.js`（v0.4.4 全项集成回归）；`test/platform.test.js` 增加 inject 形状校验；`test/e2e/plugin-smoke.test.js` 改为按 `source.kind` 识别召回消息。
- **提交归属交错说明**：V3-H3②/L1/L3 的 `307b08c` 与 V3-H2/M2 的 `2b5668f` 都改了 `src/runtime/commands.js`（H3② 先加「线程：宿主不支持」文案，M2 随后加主会话行），共享工作树按序合并，最终文件以两者组合结果为准。
- **发布门**：`scripts/probe/run-headless.mjs --plugin` 增加 round B —— 预置 1 条 fact 后发命中消息，断言无 `reading 'kind'` 崩溃且该 fact 的 `facts.first_reneed_at` 非空（召回真的注入过）；无模型凭据时明确标注 SKIP 并保留日志。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）743/743 pass、0 fail；发布前独立复审 `docs/review-v9.md`（pass，H=0 / M=0）。

## [0.4.3] - 2026-11-04

C-H1 / C-M1 修复：插件首次在真实 cordis 宿主上完成激活；本地加载文档改为指向入口文件。仍为零第三方运行时依赖，无 schema 变更。

### Fixed

- **C-H1 插件从未在真实 cordis 宿主上激活**：`src/index.js` 缺少 `export const inject`，cordis 4 对未声明 service 的属性读直接抛 `cannot get property "rssReader" without inject`，`apply()` 在 `ctx.rssReader` 首读即中断（DB 文件存在只是因为 `Store.open` 先于该读点）。修复：声明 `inject = ['systemPrompt', 'timer', 'commands', 'tools']`（均以真机 `.data/probe.json` 的 `capabilities.services.*.present=true` 为准；`ctx.interval` 对应 `timer` service），其余能力一律走 `ctx.get()`（未注册返回 `undefined`，不抛），缺失能力继续走 adapter 的 `unavailable()` 降级；测试席位 `now`/`cwd`/`workspace`/`rssReader`/`companion` 不再从 Context 代理直读，改由 `ctx.get()` 或 `apply(ctx, config, hooks)` 传入，缺省回落 `Date.now()` / `process.cwd()` / `process.memoryUsage().rss`。
- **旧测试 mock 掩盖 inject 约束**：新增 `test/helpers/strict-ctx.js`（Proxy 版 ctx，读未声明属性抛与 cordis 同文案的错误），12 个 e2e 的 `apply` 全部改经严格代理；`test/fakes/ctx.js` 增加 `ctx.get()`；新增 `test/c-h1-seats.test.js` 锁定席位读法与 logger 镜像行为。
- **C-M1 加载文档指向目录**：README 不再声称 `name` 可指目录，本地开发必须指向 `src/index.js`（绝对路径 / 相对 patch 文件 / `file://` URL）；指向目录会抛 `ERR_UNSUPPORTED_DIR_IMPORT`，插件不会激活。

### Added

- **`run-headless.mjs --plugin` 发布门**：用 `--patch` 把本仓库真插件挂到 headless，跑一次并断言出现 `[dsh-companion] scheduler started`、且没有 `did not activate`；完整 stdout/stderr 落盘 `.data/plugin-gate.log`（敏感值已 redact），退出码 0=通过、1=未通过、2=找不到 DSH。
- **headless logger 镜像**：headless 宿主的 `logger` 是函数对象且 `info()` 没有可见 sink（`ctx.get('logger') === undefined`），启动 marker 会被吞；现在函数形 logger 下把日志同时镜像到 stderr，桌面宿主的对象 logger 行为不变。

### Verified

- **真机 gate（Windows x64，DSH 0.2.1-rc.5，宿主 cordis 4.0.5，Node 24.21.0 / Electron 44.7.0）**：`node scripts/probe/run-headless.mjs --plugin --timeout 180000` 通过（发布门退出码 0），`dsh-companion/.data/plugin-gate.log` 第 11 行原文：
  `[dsh-companion] scheduler started {"jobs":6,"metrics":{"tokensIn":0,"tokensOut":0,"overBudget":0,"recalls":0,"rssMB":219,"capturedAt":1793785046777}}`
  同一日志中 `did not activate` / `without inject` / `cannot get property` 各 0 次。DSH 子进程 exit=1 仅因本机未配置 `DEEPSEEK_API_KEY`（`MISSING_CREDENTIAL`，预期内；marker 在 `apply()` 内、建会话之前打印）。

### Changed

- **测试**：667 → 674 个用例 / 16 个套件；新增用例覆盖 inject 声明面、严格 mock 的报错行为、席位回落与 logger 镜像。
- **文档**：`docs/known-debt.md` §1 更新 C-H1 激活口径与本次真机 gate 结果。

## [0.4.2] - 2026-11-04

v0.4.1 代码评审的 S2-M1 / E2-M1 修复，并带 L2-1 / L2-2 / L2-3。schema 升至 v9（旧库自动升级）；仍为零第三方运行时依赖；remote embedding 默认关闭。发布前独立复审见 `docs/review-v8.md`（pass，H=0 / M=0；复审提出的 M-1 与 L-1/L-2/L-4 已在发布前修完，L-5 文档档位语义已同步）。

### Fixed

- **S2-M1 `used` 升级不再沿用首次注入的时间/档位/same_context**：新增 `first_used_at` / `first_used_tier` / `used_same_context`，在真正被用上的那一刻写入，并按 `observed_at`（原话时间）当场重新判定 same_context；「首次用上」定义为首次非 same_context 的用上，same_context 的 used 照常记录、之后可被非 same_context 的 used 覆盖一次，已经是非 same_context 的不再覆盖。`first_reneed_*` 保留为 recall 对照样本，不被 used 改写，used 行允许 `first_reneed_at` 为 `NULL`。
- **M-1 后续 recall 样本不得降级 used 行**：`markFirstReneed` 对 `reneed_kind='used'` 的行整体跳过；index 档注入被用上后，full/gist 档再次注入不会把 kind 改回 `recall`、也不会补写晚于 `first_used_at` 的 `first_reneed_at`，S0 主样本与 recall 对照不再互相污染。
- **L-4 用上档位取本轮实际注入档**：`index` 档注入后紧接复述用上时，`first_used_tier` 记 `miss`，不再用库内 `fidelity` 反猜成 `clear`。
- **E2-M1 回填独立超时、推理单飞与查询回退 FTS**：新增 `vector.backfillTimeoutMs`（默认 30000ms，1–600000），回填用独立超时、查询仍用 `vector.embedTimeoutMs`（默认 300ms）；`vector.backfillBatchSize` 默认从 50 降到 8（仍允许 1–50）。local 推理单飞：同一时刻只允许一个底层推理，超时只截断等待、不取消底层计算，超时批次未结束前不再起新批；idle-probe 遇忙跳过并记 `vectorEmbedBusy`；查询遇忙立即回退纯 FTS，不排队。超时记 `vectorBackfillTimeouts`，`/状态` 追加「回填超时 N·占用 M」。
- **L-1 占用与失败指标分离**：查询遇 `EMBEDDING_BUSY` 只记 `vectorEmbedBusy`、日志降为 `debug`，不再计入 `vectorEmbedFailures`、不打 `warn`；回填占用期连续查询不会虚增失败数。
- **L2-1 same_context / Δt 改用 `observed_at`**：same_context 判定与 Δt 统一从原话时间起算，取不到时按来源 episode 的 observed/started/created 时间回退，最后才用事实的 `created_at`；避免深睡/延迟巩固把 Δt 算短、6h 判定偏严。
- **L2-3 加载单飞**：`loadInFlight` 只在底层加载真正 settle 后清空；`doLoad` 不再自套 `loadTimeoutMs`，等待方超时只放弃等待；退避后的重试复用同一个未结束的 promise，不再并行起第二个加载。

### Changed

- **schema v8→v9**：`facts` 增加 `first_used_at` / `first_used_tier` / `used_same_context` 与 `ix_facts_used` 索引；v8→v9 只推进版本，列由打开时检测补齐，重复打开幂等，旧行新列为 `NULL`；`fact_vectors` 与已有数据不变。`reneed_kind` 触发器改为由 `RENEED_KINDS` 常量生成（L-2），不再维护两处字面量。
- **L-3 判定（不收紧）**：`vector.backfillBatchSize` 维持允许 1–50、默认 8；复审原文「8–16」按「默认值建议」理解，不把上限收紧到 16。
- **L2-2 修正 v0.4.1 用例数口径**：按标签实测，v0.4.0 为 626、v0.4.1 为 646，v0.4.1 的「639 → 646」改为「626 → 646」（+20）。
- **测试**：646 → 667 个用例 / 16 个套件（新增 S2-M1 用上语义、v8→v9 迁移、M-1 与 L-1 回归）；默认、`TZ=UTC`、`TZ=America/Los_Angeles` 三时区全绿。
- **文档**：`docs/s0-calibration.md` 改用 `first_used_at` / `used_same_context` 主样本口径，说明 Δt 以 `observed_at` 起算、recall 仅对照、same_context used 可被覆盖与选择偏差，并补 `first_used_tier=miss`（沉睡档用上）定义；`docs/embedding.md` 补回填超时、批量 8、推理/加载单飞、查询回退与 busy/failures 指标口径；`docs/known-debt.md` 更新 D-4 真机项与 L2 关闭状态；README 状态、配置表与已知限制同步为 v0.4.2；`docs/usage.md` 同步 `/状态` 文案、配置示例与 schema 演进。

## [0.4.1] - 2026-11-04

v0.4.0 评审的 E-M1 / S-M1 / L-2 修复。schema 升至 v8（旧库自动升级）；仍为零第三方运行时依赖；remote embedding 默认关闭。复审见 `docs/review-v6.md`（pass，H=0 / M=0）。

### Fixed

- **E-M1 local embedding 阻塞首个 turn**：`local` 的加载等待与推理都受 `vector.embedTimeoutMs`（默认 300）约束，超时抛 `EmbeddingTimeout`（`kind=transient`），后台加载继续（`loadTimeoutMs` 硬上限 180s）；启动与 idle-probe 异步预热，不 await 在 turn 路径上；加载期间召回本轮回退纯 FTS、不向用户抛错，加载完成后下一轮走向量。缺依赖（`ERR_MODULE_NOT_FOUND` / `Cannot find module`）→ fatal 停用 local 只记日志；网络/超时/初始化失败 → transient 指数退避（1/2/4/8s，第 5 次后 60s 冷却，不永久停用）。新增指标 `vectorEmbedLoadFailures` / `vectorEmbedFatal`。
- **S-M1 W5 把「被注入」当「被需要」**：`reneed_kind` 增加 `used`，只有下一轮复述重叠 ≥0.6 才把首次样本从 `recall` 升级为 `used`（保留首次时间/档位）；S0 主口径只统计 `used` / `dedupe` / `correction`。新增 `same_context` 列，写入间隔 <6h 或来源 episode 仍在当前 surface 的即时召回标 1，统计默认排除，避免压低 S0 有效样本。
- **L-2 确认词长度上限**：去掉标点/空白后超过 10 字不再算确认（`CONFIRM_MAX_CHARS`），「对，我明天要去北京开会，顺便……」不再触发 α=4；「对」「没错」「嗯，对。」仍算确认。

### Changed

- **schema v7→v8**：`facts` 增加 `same_context` 列；`reneed_kind` 合法值（含 `used`）改用幂等触发器校验，不重建表；旧库整体单事务升级，重复打开幂等，旧 v7 样本 `same_context=0`。
- **测试**：626 → 646 个用例 / 16 个套件（v0.4.0 tag 实测 626、v0.4.1 tag 实测 646，原「639 → 646」的起点有误；新增 E-M1/S-M1/L-2 集成与回归）；默认、`TZ=UTC`、`TZ=America/New_York` 全绿。
- **文档**：README 增补 local 超时/预热/FTS 回退并更新 schema v8 埋点；`docs/embedding.md` 补 local 超时与预热、错误分类与退避、schema v8；`docs/s0-calibration.md` 改为「用上为主、注入仅对照」两层口径并更新 SQL；`docs/known-debt.md` 登记 E-M1/S-M1 已关闭与新增债务；新增 `docs/review-v6.md`。

## [0.4.0] - 2026-11-04

v0.3.2 评审的 R-M1 / R-L1 / R-M2 / R-L2 / N-L1 / N-M3 修复，并入 W4 embedding 可插拔与 W5 S0 首次再需要埋点。schema 升至 v7；仍为零第三方运行时依赖；remote embedding 默认关闭。复审见 `docs/review-v5.md`（pass，H=0 / M=0 / L=2）。

### Fixed

- **R-M1 / R-L1 外部压缩吞掉未巩固内容**：`resolveReanchor` 按 surface 位置取替换节点（不再 `Math.min`）；压缩跨过旧水位时把锚点前挪到平台摘要之前，让摘要进入下一次巩固，`compactionLostUnconsolidated` 记录丢失节点数；重锚后强制刷新 surface 正文。`/状态` 增加「水位重锚」「未巩固被压缩」。
- **R-L2 冷启动锚点哨兵**：锚到起点时落库 `-1`，重启后还原为内存水位 0，不再被误判为「已重锚」而跳过整段抽取。
- **R-M2 thread_run 持槽退化**：create 分支直接传会话句柄；reuse 反查失败与 900s 兜底写 warn 并记 `threadSlotFallback` / `threadSlotTimeout`，随后释放槽。
- **N-L1 确认词边界**：仅整句 / 独立小句 / 句首短尾的「对、是、记住了」等触发 α=4 强化，并加否定守卫；「对比一下」「好像不太对」不再误判。
- **N-M3 RSS 三档可配置**：`rssWarnGiB` / `rssStopGiB` / `rssMainOnlyGiB`（默认 2.95/3/3.15GiB，严格递增校验）；4G 云端可降到 2.2/2.4/2.6；`/状态` 显示三档。

### Added

- **W4 embedding 可插拔**：`vector.embedder` 支持 `hash`（默认，零依赖）/ `local`（可选 `@huggingface/transformers`）/ `remote`（默认关闭，显式开启后原文发往第三方端点）/ `none`；`embedder_id` 隔离不同模型的向量，换模型后由 idle-probe 分批回填；失败/超时降级纯 FTS 并记 `vectorEmbedFailures`。
- **W5 S0 首次再需要埋点**：`facts.first_reneed_at` / `first_reneed_tier` / `reneed_kind` 与 `(scope, first_reneed_at)` 索引，召回 full/gist、去重命中沉睡/墓碑、用户纠正三条路径幂等记录首次样本；流程与 SQL 见 `docs/s0-calibration.md`。
- **`docs/known-debt.md`**：Gate 0 九项真机联调清单、h1-h3-probe §4 四项待实测、N-M4/W1 / N-L2 / N-L3 / W4 local 真机 / Linux 2C4G 内存复测等未做项与排期。

### Changed

- **schema v5→v7**：v6 给 `fact_vectors` 增加 `embedder_id` 并回填 `hash:<dim>`；v7 给 `facts` 增加 `first_reneed_*` 三列与索引；旧库按列检测逐级迁移，旧向量按 hash 重建，旧事实的埋点三列为 NULL。
- **测试**：626 个用例 / 16 个套件；默认、`TZ=UTC`、`TZ=America/New_York` 全绿。
- **文档**：README 增补 v0.4.0 行为、配置与已知限制；usage 增补执行槽、embedding 选型、外部压缩重锚与 schema v7；新增 embedding / known-debt / S0 文档交叉链接。
- **依赖与兼容**：仍零第三方运行时依赖；`remote` 默认关，未开启时路径与 v0.3.2 一致。

## [0.3.2] - 2026-11-04

v0.3.1 评审的 N-H1 / N-M1 / N-M2 修复。无配置键变更、无 schema 变更（仍为 v5），升级不需要迁移。

### Fixed

- **N-H1 水位重锚**：外部压缩（平台自动压缩、用户 `/compact`、pending 过期后再次压缩）会让原水位 seq 从 surface 消失，此前 `stale-watermark` 只记 debug 日志后永久跳过巩固。现在 pre-step / 调度 / 深睡在选区前调用 `ensureWatermark`：优先取「不在上一版 surface 里的最小 seq」（替换节点之后），seq 重映射时取当前首节点，无历史时锚点 0 整段重来；锚点写入 `schema_meta` 的 `watermark_anchor:<scope>`，巩固或压缩成功后清除；`/状态` 增加「水位重锚」计数，warn 日志带 scope/anchor/mode。
- **N-M1 按 scope 的待压缩槽**：`pendingCompact` 由单槽改为 `Map<scope, pending>`，主会话与线程互不覆盖；apply 启动时按 scope 恢复各自最新的 `written` nap 行。
- **N-M2 共用执行槽**：`thread_run`（带 `goal` 时）与 `task_run` 共用 `createTaskRunner` 的同一个执行槽；槽忙时立即返回 `{ok:false, reason:"busy"}`，不再绕过串行槽并发创建第二个执行态。不带 `goal` 的线程创建/复用不占槽。

### Changed

- **测试**：546 → 551 个用例（新增 `test/pending-compact.test.js` 3 个、`test/tools.test.js` 共享槽 1 个、`test/e2e/external-compaction.test.js` 1 个），三种时区全绿。
- **文档**：README 增补外部压缩重锚、按 scope 待压缩槽、单执行槽三条行为说明；版本与用例数更新为 0.3.2 / 551。

## [0.3.1] - 2026-11-04

P2 复审遗留 L1–L3 修复（复审见 `docs/review-v4.md`）。无配置键变更、无 schema 变更（仍为 v5），升级不需要迁移。

### Fixed

- **L1 加密 header 认证**：加密导出改为 `header.format = "v2"`，AAD 绑定「magic 行 + header JSON」（不含 tag，tag 是 GCM 输出）；`decryptJson` 按 format 分派，`v1` 或无 format 的旧文件走原路径、不设 AAD，仍可解密，未知 format 直接拒绝。篡改 header / 密文 / tag 均因 AAD 或 GCM 认证失败；错误统一为「解密失败（口令错误、文件损坏或认证失败）」，不再拼接底层错误。
- **L2 schema_version 真实值**：导出文件的 `schema_version` 改为按真实库读取（`store.getMeta('schema_version')` → `schema_meta` 表 → 回退当前版本 `'5'`），不再硬编码 `'4'`。
- **L3 导出文件名**：时间戳改为 UTC 秒级 `memory-YYYY-MM-DD-HHmmss.<fmt>`；写入用 `wx` 独占创建，同名时依次追加 `-2`、`-3`……（上限 1000），绝不覆盖已有文件，也不存在 check-then-write 竞态。

### Changed

- **测试**：538 → 546 个用例 / 16 个套件（新增 `test/export-aad.test.js` 8 个；既有文件名与时间戳断言同步为秒级）。
- **兼容性**：`v1` 加密文件继续可解（无 AAD 校验，见「已知限制」）；导出文件名从 5 位分钟变为 6 位秒；导出 JSON 的 `schema_version` 改为真实版本（仅文档性字段）。

## [0.3.0] - 2026-11-04

P2 批：记忆导出与恢复、加密导出、可选向量召回（RRF）与全景 e2e。复审见 `docs/review-v4.md`（pass，H=0 / M=0 / L=3）。

### Added

- **导出**：`/记忆 导出 [md|json]`（`src/memory/export.js`）把 facts / episodes / reminders / threads / 状态板写成 `.data/export/memory-YYYY-MM-DD-HHmm.<fmt>`（UTC 时间戳；API 可传 `dir`、`now` 覆盖）。默认过滤 `secret` / `sensitive`、墓碑与 `superseded`；状态板按「未导出事实的 statement」做行级剔除，事实再做一次敏感文本兜底，避免板面泄漏。
- **恢复**：`importAll({ store, file, mode })` 校验 `version=1` 与 `data` 结构；`fresh` 要求五表为空（容忍空状态板占位行），`merge` 按主键跳过已存在行；先写 episodes 以满足外键，导出集中缺失的引用（`consolidation_id` / `source_episode_id` / `superseded_by`）置 null；单事务落库，任一行失败整体回滚；恢复后逐行重建 facts / episodes FTS。
- **加密导出**：`encryptJson` / `decryptJson` 使用 AES-256-GCM + scrypt（N=2^14、r=8、p=1，maxmem 64MB）；每次随机 salt(16B) / iv(12B)，magic `DSH-COMPANION-EXPORT-1` + JSON header 保存 KDF 参数与 tag；错误口令或损坏文件统一报「解密失败（口令错误或文件损坏）」。CLI：`node scripts/export-encrypted.mjs <db> <fact-id> --out <file>` 与 `node scripts/decrypt-encrypted.mjs <file> [--out <json>]`；口令只从 stdin 读取（TTY 关闭回显），空口令 / 缺 `--out` / 缺 fact 退出 1，解密成功后才写目标文件（不产生明文半文件）。
- **可选向量召回**：`src/memory/vector.js` 提供 `cosine`（dim 不符抛 `TypeError`）、`hashEmbed`（字符 bigram FNV-1a → 桶 → L2 归一；代码注释明确非生产质量）、`searchVector`（只召回 active / normal / 未删除 / 非 sensitive・secret 且 R ≥ 0.05）与 `hybridSearch`（FTS 与向量按 `1/(k+rank)` RRF 融合，k=60；同一 fact 去重，空路退化）。
- **`/状态` 向量行**：关闭显示「向量：关」，开启显示「向量：开·dim 256·最近命中 N」。
- **离线评测脚本**：`node scripts/bench-vector.mjs [--dim 256] [--json]` 生成 200 条合成事实 + 20 条查询，输出 FTS / 向量 / RRF 的 hit@5 对比（仓库自评 100%/100%/100%，是合成数据的自评口径，不代表真实 embedding 质量）。
- **P2-c 全景 e2e**：`test/e2e/p2.test.js` 7 例，覆盖导出→fresh 恢复逐表相等、加密往返与 CLI 失败路径、向量关闭时结果逐字节不变、开启后 RRF 去重与敏感/墓碑过滤、治理后再导出、V12 回归以及「恢复后旧事实无向量」不崩溃。

### Changed

- **配置键**：新增 `vector.enabled`（默认 `false`）、`vector.dim`（默认 `256`，范围 8–4096）、`vector.embedder`（`hash` | `none`，默认 `hash`）；未知 `vector.*` 子键只 warning。`DEFAULTS.vector` 不可枚举，首次安装自检仍按 13 个键输出，向量默认不参与自检。
- **测试**：465 → 538 个用例 / 16 个套件（export 13 + export-more 14 + vector 13 + store-vector 10 + retrieve-vector 7 + config-vector 9 + status-vector 3 + e2e p2 7；另 3 处既有 schema 版本断言随 v5 更新）。
- **检索不变性**：`vector.enabled=false`（默认）时 `retrieve` 与 v0.2.0 逐字节一致，且不读 `fact_vectors`。
- **工具 / 命令数量不变**：仍 10 个工具；`/记忆` 增加 `导出` 子命令。

### 数据与迁移

- `schema_version` **4 → 5**：新增 `fact_vectors(fact_id TEXT PRIMARY KEY REFERENCES facts ON DELETE CASCADE, dim INTEGER NOT NULL, vec BLOB NOT NULL, updated_at INTEGER NOT NULL)` 与 `ix_fact_vectors_dim`；DDL 均为 `IF NOT EXISTS`，重复 open 幂等。
- v4 → v5 **只推进版本、不动数据**：旧事实不会自动补向量；开启向量后这些行「无向量」不会崩溃（召回返回 0 命中），下一次写入 / 编辑 / 强化时重建投影；`setVectorDim` 改变维度会清空旧维度投影。
- 向量投影与生命周期联动：仅 `active` + `normal` + 未删除 + 非 `sensitive/secret` 的事实保留向量；遗忘、软删、被治理降级或标记敏感都会删除投影，物理 purge 由 `ON DELETE CASCADE` 兜底。
- 导出 / 恢复不修改源库；`fresh` 模式要求目标库五表为空，`merge` 模式不覆盖已有主键行。

## [0.2.0] - 2026-11-04

P1 批：记忆治理与编辑、承诺跟进与轻闲聊、失败自愈，并以全景 e2e 收口。复审见 `docs/review-v3.md`（pass，H=0 / M=0 / L=3）。

### Added

- **记忆治理**：`/记忆 治理 [--dry-run]`（`src/memory/govern.js`）扫描重复（Jaccard ≥ 0.92）、冲突（subject + predicate）、过期（R < 0.05）与敏感条目。`--dry-run` 只出报告；应用时只把重复项降级为 `superseded`（**不物理删除**），敏感命中只标 `sensitive=1` 并同步剔除 FTS 投影，写 `action='govern'` 审计。
- **记忆编辑**：`/记忆 改 <id> <新内容>` 与第 10 个工具 `memory_update`——旧条 `superseded_by` 指向新条，新条以新 id 继续生效，FTS 与 `EDIT` 审计同步维护。
- **`/记忆 列表 [关键词]`**：按 kind 分组、每页 20 条列出活跃事实，支持关键词过滤与 `--page`。
- **承诺跟进**：`src/scheduler/commitments.js` 在 reminders tick 对到期 `kind=commitment` 的提醒每天至多跟进 1 次（`last_fire_key` + `USED/commitment_followup` 审计）；安静时段只积压不发送，时段结束后补发一次；已完成/已删除的提醒不再跟进。
- **轻闲聊**：`src/persona/chat.js` 在空闲 tick 可发一条 5–10 句陈述式闲聊，闸门依次为「开关开启 → 非安静时段 → 当日有互动 → 非周末 → 距上次 ≥ 3 天 → 当日 ≤ 1 条 → 7 天窗口 ≤ 3 条」；同日失败不重复调模型。`/别闲聊`、`/恢复闲聊` 跨重启持久化。
- **失败自愈**：巩固失败写 `consolidations` failed 行并按 1/2/4 tick 退避重试（上限 3 次、复用同一行；`MISSING_CREDENTIAL` 不重试，最终写 `consolidation_failed_final`）；调度 job 失败写 `job_error` 并在次日 17:03 重试（`job_retry`），重启后可恢复失败态；SQLite `SQLITE_BUSY` 在事务入口重试 ≤ 3 次（抖动 ≤ 50ms）；备份失败不再被吞，交由 scheduler 记账并次日重试。
- **`/状态` 失败可见**：追加「最近失败 / 最近重试 / 最近 job 失败」三行（无事件时显示「无」）。
- **P1-d 全景 e2e**：`test/e2e/p1.test.js` 22 例，覆盖治理/编辑、承诺、闲聊、自愈与 v0.1.1 回归。

### Changed

- **工具数量**：9 → 10（新增 `memory_update`）。
- **命令数量**：4 → 6（新增 `/别闲聊`、`/恢复闲聊`；`/记忆` 增加 `列表`、`改`、`治理` 子命令）。
- **测试**：383 → 465 个用例 / 16 个套件；默认与 `TZ=UTC` 均全绿。
- **配置键不变**：仍为 13 个；治理/编辑、承诺跟进、闲聊与自愈均由既有配置与固定阈值控制。

### 数据与迁移

- `schema_version` 仍为 **4**，无强制迁移。`/记忆 治理` 或编辑命中敏感内容时，会按需幂等添加 `facts.sensitive` 列。
- 审计新增 `govern` / `EDIT` 动作名；因 `memory_events` 的 CHECK 白名单暂未包含它们，写入时局部启用 `PRAGMA ignore_check_constraints` 并在结束后立即恢复（回归测试保证恢复后 CHECK 仍生效）。
- 治理只降级/标记、不物理删除；遗忘路径（S1 墓碑 + 7 天冷静期 / 立即删除）保持不变。

## [0.1.1] - 2026-11-04

A 批外部评审修复版。本轮关闭 H1–H6、M1–M4、L 项与 W3，并补 Gate 0 探针与独立复审。

### Fixed

- **H1 surface seq 巩固/压缩/水位**：巩固选区、压缩区间与水位统一按平台 surface 位置序处理，不再假设 seq 连续或从 1 开始；压缩后水位与 consolidation 记录可正确重定向。
- **H2 选区文本进提示词**：巩固模型改为消费 `planRegion().region.text` 的选区正文（保留 role 行），transcript 仅作兜底，避免 40 条/6000 字符窗口造成截断错位。
- **H3 会话分流与 scope 隔离**：按 main / thread / subagent 路由；线程写 `thread:<key>` scope，subagent 跳过召回、巩固与写库；记忆工具默认当前 scope，跨 scope 显式拒绝。
- **H4 遗忘闭环**：遗忘走 S1 墓碑 + 定向巩固（排除目标 statement，不回写）+ 状态板同步清洗；`/记忆 彻底忘掉` 与 `memory_forget` 支持二次确认后跳过 7 天冷静期立即物删，审计不含正文。
- **H5 用上强化**：被复述的召回事实按 α=2 强化，用户确认时 α=4；同批注入每 fact 至多一次，pinned/已删/非 active 跳过，失败不阻断 turn。
- **H6 task_run**：新增串行执行槽（全局 1 个、排队上限 2）、软超时 600s 只告警、硬超时 900s 两段式取消与 ≤300 字回执。
- **M1 时区/CI**：调度、日键、安静时段、成本统计与备份文件名统一按配置 IANA 时区；新增 `src/time.js`，CI 显式 `TZ=UTC`。
- **M2 配置全量生效**：compactAtTokens / compactHardTokens / workingMemoryTokens / idleMs 等均从运行时配置读取，override 不再被默认值覆盖。
- **M3 巩固非阻塞**：pre-step 只登记 pendingConsolidation 并立即返回，模型调用与写库在 step 之后单飞执行；失败只 warn，下一轮开头收账。
- **M4 成本熔断与 RSS 降级**：每日 3M token 熔断；RSS 2.95/3.0/3.15GiB 三档，stop_dispatch 起暂停主动消息与提醒投递，task_run / thread_run 按档拒绝。
- **L 项**：`memory_search` scope 校验、`thread_run` goal ≤2000 码点、unarchive 只发布线程自己的状态板、召回同 turn 一次去重、README 链接与计数修正等。

### Added

- **Gate 0 探针**：`scripts/probe/` 与 `docs/gate0-probe.md`，headless 探查平台 API、能力与 token 计量。
- **API 探查文档**：`docs/h1-h3-probe.md`，记录 H1/H3 依赖的 surface、sessionQuery 与压缩链路真实行为。
- **安装自检与示例配置**：`scripts/calibrate/`、`src/calibrate/formula.js`、`docs/calibration.md`、`config.example.yml`、`persona.example.md`，按机器内存与上下文窗口给出建议配置。
- **独立复审**：`docs/review-v2.md`（v0.1.1 关闭核验）。
- **task_run 工具**：模型工具增至 9 个，支持串行执行、排队、软硬超时与结构化回执。

### Changed

- **schema v4**：seq 语义改为 surface 位置序；开发期迁移会清空 `consolidations` 并重置 `episodes.consolidation_id`（记忆事实/提醒不受影响）。
- **工具数量**：8 → 9（新增 `task_run`）。
- **测试**：383 个用例 / 16 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 均全绿。

## v0.1.0 — 2026-11-03

首个 MVP 版本。单人、单主会话加少量长期线程，记忆留在本机 SQLite，不跨设备同步。

### 新增

- **平台适配层**：把 system prompt 分段、`agent/pre-step` 决策、定时器、区间压缩、会话创建/投递/取消/等待、会话归档与 token 计量封装为可注入的单一入口；缺能力时抛出带错误码的 `PlatformError`。
- **SQLite 存储**：8 业务表 + state_board_rev + schema_meta + 2 FTS 索引与 bigram 分词；事务写入、水位、审计事件与物理清理。
- **人格与装配**：默认人格卡「珞然」，可加载自定义卡；safety / core / protocol / 状态板四段按 order 装配，工作记忆封顶 32,000 token，压缩保留最近 6,144 token。
- **巩固与状态板**：按 hard / idle / threshold 三种原因触发；先写库、成功后才压缩；状态板 5 个区块（当前状态、最近进展、待办、线程简表、提醒），上限 800 token，按时机发布。
- **四档检索与遗忘曲线**：bigram FTS 召回，`full` / `gist` / `index` / `dormant` 四档渲染；遗忘、取代、隐私与低分过滤；2,050 token 预算裁切。
- **线程、任务与回执**：线程目录最多 6 个活跃线程，空闲 14 天冻结；worker 支持软超时（600 秒）与硬超时（900 秒）两段式取消；任务回执终态写入审计事件。
- **调度与主动消息**：6 个定时任务（idle-probe 每 60 秒、reminders 每 30 秒、deep-sleep 每日 03:00、s2-purge 每日 03:30、backup 每日 04:00、thread-freeze 每日 03:00）；主动消息受安静时段、每日上限、同类去重与积压上限约束。
- **命令、工具与观测**：`/记忆`（含忘掉/彻底忘掉/置顶/取消置顶）、`/成本`、`/线程`、`/状态`；9 个模型工具；token、召回、超预算与 RSS 指标。
- **生产接线**：`apply()` 真正挂载四段人格、`agent/pre-step` 的巩固→压缩→状态板发布主链路、经 `assemble` 预算裁切的召回（同一 turn 只注入一次）、4 个命令、9 个工具与 6 个定时任务；同一 ctx 二次 apply 幂等，返回 `{ dispose }` 关闭 Store、定时器与全部注册。
- **深睡子步（MVP）**：deep-sleep 不再空转——睡眠期巩固（有模型时）、遗忘降级、FTS 孤儿 GC、状态板 staged 重渲染与 `memory_events` 审计（情景→语义抽取留待后续版本）。
- **备份与成本**：backup 按日期滚动保留 7 份，失败写 `scheduler_jobs` 审计；tokenMeter 每轮写入 `tokens` 审计事件，`/状态` 展示本轮 token 与超预算次数。
- **端到端验收**：覆盖装配预算、写库失败不压缩、打断与线程复用等关键流程；新增经 `apply()` 的生产路径 e2e（巩固→下一轮 turn 头压缩→发布→召回新事实）。
- **文档**：README、使用手册、平台 API 摘录与设计文档索引。

### 数字

- 配置项：11 个。
- 活跃线程上限：6 个。
- 定时任务：6 个。
- 状态板区块：5 个。
- 测试：260 个用例、15 个套件。

### 运行要求

- Node.js `>= 24`，使用内置 `node:sqlite`（会打印 ExperimentalWarning）。
- 零第三方运行时依赖。

### 设计依据

- `memory/docs/06-记忆系统设计.md`（v3.3）
- `memory/docs/05-架构设计.md`（v3.0.2）
- `memory/docs/07-风险与里程碑.md`（v3.1）
- `memory/开发规划-v2.md`

### 已知限制

- 不跨设备备份；数据库只在本机。
- 平台管理的会话 JSONL 不在插件控制范围内，插件无法删除。
- MVP 不含向量检索，语义召回依赖 bigram 与遗忘曲线。
- 仅面向单人、单主会话模型；线程用于隔离长期任务，不是多人协作。
