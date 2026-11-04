# v0.4.4 发布前独立复审（review-v9）

- 复审人：reviewer（独立审查者，未参与 t1–t6 实现）
- 复审日期：2026-11-04
- 复审对象：`v0.4.3`（18f7ee2）之后至 `bd7fa4a` 的 8 个提交（f6ac4af / c8624b9 / 0212924 / 307b08c / 2b5668f / dd2e2c6 / 95108ea / bd7fa4a），44 files，+4217/−188（src 9 files +1265/−98）
- 复审方式：逐文件读实现与测试、亲跑三时区全量测试、grep 交叉核对文档与接线；未复跑真机 DSH 发布门（headless round B），该项采信 t1 依赖回执中的真机证据。
- 结论：**verdict = pass**（H=0 / M=0 / L=3）。3 条 Low 均不阻塞发布，其中 L-1/L-2 建议并入发布提交。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议） | 3 | L-1 文档、L-2 文档（发布时统合）、L-3 已知边界（无需本版修复） |

发布前置条件（H=0 且 M=0）满足，复审通过。

## 2. 逐项核验（V3 卡点 → 证据）

### V3-H1 召回注入契约 ✅

- 注入形状：`src/index.js:264-267` `recallMessage()` 返回完整平台消息 `{ id: randomUUID(), role: 'user', content: [{type:'text',text}], source: { kind: 'companion-recall', form: 'snapshot', sections: [...] } }`；`source.kind` 与 `dsh-agent-loop/lib/index.js:1067` 的消费点一致。
- 平台侧防线：`src/platform/adapter.js` `mergeDecision` 对每个 inject 元素做形状校验，非法即 `TypeError` 留在插件侧；`test/platform.test.js:389-432` 断言裸内容块（v0.4.3 事故形状）与缺 `id`/`role`/`content` 的注入均被拒绝。
- 不落盘污染：`isInjectedMessage`（`src/index.js:2464-2468`）按 `source.kind` 识别注入；`textRows`（`src/index.js:3404`）跳过注入消息，`lastUserText` 按 `RECALL_MARKER` 兜底；转录跳过 `RECALL_MARKER` 行；surface 记录经 `isRecallRecord` 前缀兜底、`withoutRecallRecords` 仅置空正文，seqs/token 计量口径不变（`src/index.js:2477-2501`，调用点 1810/1906）。
- 巩固排除：巩固窗口进出均过滤召回块（`src/index.js:1810`、`1906`）。
- 冷读与真实 loop 形状：`test/e2e/recall-injection.test.js` 以 fake loop 按 `dsh-agent-loop:1067` 的消费方式逐条断言 `id/role/content/source.kind`，并做 JSONL 冷读复验与巩固窗口排除。
- 真机形态：`scripts/probe/run-headless.mjs:521-560,579-637` round B 预置 1 条 fact 后发命中消息，断言无 `reading 'kind'` 崩溃且 `facts.first_reneed_at` 非空；无凭据时如实标 SKIP。t1 回执真机 round A+B PASS、`firstReneedAt=1793795831`（复审环境无法重跑真机，采信为 source material）。

### V3-H2 提醒两阶段投递与 fired 语义 ✅

- 目标是真实会话：`createProactive` 强制 `target` 为函数（`src/runtime/proactive.js:93-95`），接线传 `target: () => currentMainSessionId(state)`（`src/index.js:2770-2782`），meta 持久化优先、内存兜底（`src/index.js:806-814`）；仓库内已无字面量 `'main'` 投递路径。
- fired 只在成功后写：`onSent → markReminderDelivered`（`delivering → fired`，`src/memory/store.js:1814-1823`）；失败回 pending 且保留 `last_fire_key`（`store.js:1830-1839`）；claim 幂等计数 `delivery_attempts + (CASE WHEN last_fire_key IS ? THEN 0 ELSE 1 END)` 且 `delivery_attempts < max` 门（`store.js:1787-1807`，`REMINDER_MAX_DELIVERY_ATTEMPTS=3`）。
- delivering 恢复：启动时 `recoverReminderDeliveries`（`src/index.js:341`，实现 `store.js:1850-1872`）`delivering → pending`（<max）/ `expired`（≥max），幂等。
- 重启不丢：`last_fire_key` 落库；`src/index.js:2852-2885` `fireDueReminders` attempts≥3 → `expireReminder`+warn；dedupeKey 含秒级时间戳，重试 tick 产生新 fireKey → attempts 正确 +1，同一 tick 重复入队不重复计数。
- 降级路径：`reminders` tick 在 `proactiveBlocked` 时直接返回，不把提醒标 fired（`src/index.js:2800-2807`）。
- schema v10：`store.js:54-58,278,281,757,898,953-992`，`#ensureRemindersDeliveryColumns` 幂等重建 reminders 表并重建索引，旧行 `delivery_attempts=0`。
- 测试：`test/e2e/reminder-delivery.test.js`（6 例）覆盖失败回 pending→重启后成功 fired、delivering 崩溃恢复、3 次后 expired 不再 prompt、主会话重绑后投递到最新会话、探针会话不改绑定、v9→v10 迁移幂等。

### V3-M2 main_session_id 重绑 ✅

- `src/session/identity.js:156-300`：`latest-user`（默认）仅当 `hasUserInput` 为真才重绑并打 info 日志（含旧/新 id，223-252）；无真实输入的会话（探针/发布门）`pendingRebind` 且 warn 经 `firstWarningFor` 限流（255-278）；`first` 保持旧行为只告警（280-291）；非法绑定值抛错（`normalizeMainBinding`，32-40）。
- 探针隔离：`hasRealUserInput`（`src/index.js:777`）排除 runtime-context / companion-recall / companion-command-hint / `RECALL_MARKER`。
- 配置与可见性：`config.js` `session.mainBinding` 默认 `latest-user`，非法值 ConfigError；`/状态` 显示「主会话：<id>（绑定 <mode>）」（`src/runtime/commands.js:522-529`）。
- 多会话行为：e2e 覆盖 main-1 → main-2 重绑后提醒投递到最新主会话、探针会话（仅 runtime-context）不改绑定。

### V3-M3 召回相关性门槛 ✅

- 查询门：`src/memory/retrieve.js:70-80` `isTrivialQuery`（<4 字/纯算术/问候词），314-316 在读库与算向量之前短路，空查询保留 recency-only 通道（423-447，且仅空查询补位）。
- 候选门：非空查询必须命中 FTS/bigram（逐 token OR，365-372）或向量余弦 ≥ `minVectorScore`（474-481）；`vectorHits` 只数过门命中（530-533）。
- 配置：`recall.minVectorScore=0.35`、`skipSmallTalk=true`，`normalizeRecall` 非法值 ConfigError；优先级 recall 参数 → `config.recall` → 默认（`retrieve.js:303`）；接线由 `retrieveVectors` 透传（`src/index.js:1577-1592`，t5 补齐）。
- 亲跑验证：全量三时区通过（见 §4）；`test/retrieve-relevance.test.js` 10 例断言小聊不召回、无关候选被丢、过门候选正常注入。
- 文档：`docs/usage.md:522-530` 同步两个配置项语义。

### V3-M4 记忆改后重抽 object_text 并重建索引 ✅

- `reextractFactFields`（`src/index.js:3722` 起）：unchanged 保留旧值；边界优先「旧 statement 中旧 object_text 之前的前缀」> subject > predicate，取最长可匹配前缀并去两端标点；抽不出 → `extracted:false`、`object_text=NULL`。
- `editMemoryFact`：新 id 插行继承 salience/kind/sensitive 等字段，旧 id `superseded` + `superseded_by`；FTS 与向量在同一事务内随 insertFact 重建；EDIT 审计带 `edited/reextracted/from/to`；返回值带 `reextracted/objectText`。
- 亲跑验证：`test/v044-m4-edit-reextract.test.js` 5 例——旧行不可搜、新行可搜、`fact_vectors` 只留新行且 `retrieve` 只召回新内容、抽不出置 NULL、治理冲突分组读新值（旧 id 退出）。

### V3-H3①/H3② 能力探测与注册门 ✅

- H3① 结论已入文档：`docs/platform-api.md:67-79`（§1.3）——`sessionController` 来自 `@deepseek-ai/dsh-api-session-controller`（lib/index.js:2952），唯一挂载点 `dsh-web-app/cordis.patch.yml:121-122`；desktop profile present=true，headless/one-shot/SDK 没有，发布门跑 headless 故 present=false，不在 headless 补 patch。
- H3② 探测：`src/platform/adapter.js:232-237,264-266` `hasThreadControl` 只读 `get('sessionController')` 并校验 `createSession/prompt/cancel` 三方法，探测绝不创建会话（`test/v044-hardening.test.js:104-132` 断言 `callsOf(...).length === 0`）。
- 注册门：`threadTools === false` 时 `registerTools` 跳过 `thread_list/thread_run/task_run`（`src/index.js:726`）；`/状态` 显示「线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）」（`commands.js:519-521` + 接线传 `threadsSupported`）。

### V3-M1 服务访问与回收 ✅

- 属性访问：`src/platform/adapter.js:164-172` `declaredService` 先属性读、undefined 才回落 `ctx.get()`；`systemPrompt/timer/commands/tools` 四项能力与 `section/every/registerCommand/registerTool` 全部改走属性访问（`adapter.js:239-302,621-649`）；未声明的 `compaction/workspaceRegistry/tokenMeter` 仍走 `ctx.get()` 且缺失时 capability=false 不抛。
- 回收：`onDispose`（`adapter.js:662-674`，宿主无 `on` 返回 null）；apply 末尾挂 `platform.onDispose(() => handle.dispose())`。
- 测试：`test/v044-m1-adapter.test.js` 5 例——四个声明服务不再出现在 `get()` 调用记录、strictCtx 下能力可用、dispose 后注册数清零且二次 apply 不累加、未 dispose 重复 apply 复用同一 handle。

### V3-L1 日志级别 ✅

- `src/platform/adapter.js:196-197,311-329`：仅函数型 logger 且 stderr 可写时镜像，`MIRROR_LEVELS = {info, warn, error}`，debug 默认不镜像，`DSH_COMPANION_MIRROR_DEBUG=1` 显式开启。
- 测试：`test/v044-hardening.test.js:67-100` 三例（默认不含 debug、显式开关含 debug、对象型 logger 不镜像）。

### V3-L2 RSS 文档 ✅

- `docs/known-debt.md:107-109`（D-5）改为「按自检值下调（3.64GiB 对应 1.96/2.14/2.32）」，与 `docs/usage.md:532-533` 公式口径一致。

### V3-L3 中文命令提示 ✅

- `src/runtime/commands.js:42,53,72-84`：`chineseCommandHint` 识别 `/记忆 /状态 /成本 /线程` 前缀（含空白），`commandHintMessage` 返回完整平台消息（唯一 id、`source.kind = 'companion-command-hint'`）。
- 接线：pre-step 对中文命令输入注入 hint（同 turn 一次，`src/index.js:1146-1175`），并从 `textRows/hasRealUserInput/巩固窗口` 排除。
- 测试：`test/v044-hardening.test.js:171-198`（识别正例/反例、消息形状与 id 唯一性）。

## 3. Findings

| id | 级别 | 位置 | 问题 | requiredFix | resolved |
| --- | --- | --- | --- | --- | --- |
| L-1 | low | `docs/usage.md:632-635` | schema 演进段落止于 v9，未提 v10（reminders 增加 `delivering` 状态与 `delivery_attempts`，幂等重建表） | 在该段落补一行 v0.4.4/v10 说明（旧行 `delivery_attempts=0`、按列检测幂等迁移） | no |
| L-2 | low | `README.md:7` | 状态行仍写「v0.4.2 已发布…667 个用例」，落后当前实际（v0.4.4 待发布、743 用例；v0.4.3 发布时即漏更） | 发布提交（版本号 bump 到 0.4.4）时一并更新 README 状态行与用例数 | no |
| L-3 | low | `src/runtime/proactive.js:236-250` | `runHooks` 把钩子异常仅记入 `report.error`：若 `onAttempt` 内 `claimReminderDelivery` 因 store 故障抛错，投递仍会进行而行保持 pending，重启后可能重复投递一次（文档已声明 best-effort 语义，且 store 故障本身极罕见） | 本版无需修复；若后续加强提醒状态机，考虑把 store 写失败视为投递失败并走 `onFailed` | no（接受现状） |

## 4. 验证记录（复审亲跑）

- 三时区全量：`node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）各 **743/743 pass、0 fail**（`ℹ tests 743 / pass 743 / fail 0`）。
- 变更范围核对：`git diff --name-only v0.4.3..HEAD` 44 files；src 仅 9 个文件（config/index/export/retrieve/store/adapter/commands/proactive/identity）；`memory/`、`profile` 无改动；`src/memory/export.js:86` 仅 `CURRENT_SCHEMA_VERSION '9' → '10'` 兜底同步。
- 版本一致性：`package.json` 仍 0.4.3、`test/smoke.test.js` 断言 0.4.3、CHANGELOG 已有 `[0.4.4]` 段——版本号 bump 按流程留给发布提交，自洽。
- 工作树：clean（复审自产的 3 个 `test-*.log` 未追踪文件在提交报告前删除）。
- 真机发布门（headless round B）：未在本环境复跑；采信 t1 依赖回执（round A+B PASS、`recallCrash=false`、`firstReneedAt=1793795831`），gate 脚本与判定逻辑（含 SKIP 不假 PASS）已逐行核读。
