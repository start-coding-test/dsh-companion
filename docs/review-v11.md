# v0.4.6 独立复审（review-v11）

- 复审人：reviewer（独立审查者，未参与 C5 修复实现）
- 复审日期：2026-11-05
- 复审对象：v0.4.5（968c587）之后、t5 集成回归后的 HEAD `bc2b717`，含 5 个提交：
  `35a0747`（C5-H1a）/ `9b71496`（C5-H1b）/ `96290f7`（C5-H2）/ `040a4a3`（C5-M1/M2/L1）/ `bc2b717`（集成回归）。
  四个依赖提交（t1=35a0747、t2=9b71496、t3=96290f7、t4=040a4a3）均在 HEAD 祖先链内。
- 复审方式：逐文件读实现与五份 C5 测试与 v046-regression、grep 交叉核对文档/接线/常量、亲跑三时区全量 `node --test`；确认 worktree clean、无 v0.4.6 tag、未 push（`main` ahead 5）。未复跑真机发布门（采信 t5 回执：round A exit=1 schedulerStarted=true、round B firstReneedAt、round C 无凭据 SKIP、总判定 PASS，日志 `.data/plugin-gate.log`）。
- 结论：**verdict = pass**（H=0 / M=0 / L=1）。1 条 Low 不阻塞发布：遗留旧命名断言（worker.test.js `promptSource` 变量名），断言本身在新语义下仍成立，建议下次测试整理顺带更名。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议） | 1 | L-1 旧测试变量名未随 C5-H1a 语义更名（非阻断） |

发布前置条件（H=0 且 M=0）满足，复审通过。

## 2. 逐项核验（C5 卡点 → 证据）

### C5-H1a prompt(request, signal) 签名 / requestId / 污染隔离 / 失败上报 ✅

- **第二参确为 AbortSignal**：`src/platform/adapter.js:137-148` `deliverySignal(request)` 用 `AbortSignal.timeout(30_000)`（`:122`），并 best-effort 在 signal 上挂 `kind:'user'`/`rpcId=request.requestId`（`defineProperty` 失败静默吞掉，兼容旧宿主）——新宿主语义（宿主自己 `signal.throwIfAborted()`）与旧宿主兼容（signal 兼作 source 对象）双成立。`prompt()` 在 `adapter.js:507-521` 末行 `impl.prompt(normalized, deliverySignal(normalized))`，唯一调用形即两参签名。
- **requestId 必达**：`adapter.js:513-518` 调用方缺 requestId 时补一次性 `companion-${randomUUID()}`（`:518`）。
- **requestId 稳定且同 claim 复用**：提醒 `src/index.js:3166` `companion-reminder:${row.id}:${String(row.next_fire_at)}`（与 claim fireKey 同源）；承诺 `index.js:3468` `companion-commitment:${row.id}:${dayKey}`；闲聊 `index.js:3589` `companion-chat:${dayKey}:daily`；`src/task/run.js:168` `companion-task:${taskId}:${claimKey}`；`src/runtime/tools.js:479` 线程 requestId 以 `companion-` 前缀加 `${plan.key}:${runId}` 固定（reuse/create 共用）。`test/c5-h1a.test.js:184-189` 断言同 claim 重试同 id、`:244-258` 断言新 claim 换 fire key 且 `delivery_attempts=2` 不异常耗尽。
- **promptSource 已删**：全仓 grep `promptSource` 仅剩 `test/worker.test.js:80` 的**局部变量名**（见 L-1），实现与适配层无这旧概念。
- **失败写 memory_events**：`src/index.js:186` `DELIVERY_ERROR_KIND='delivery_error'`；proactive 失败落 `reason='delivery_error'`（含 errorName/errorMessage/requestId，`test/c5-h1a.test.js:192-196` 断言 `detail.errorName='TypeError'`、`errorMessage='signal.throwIfAborted is not a function'`）；`/状态` 只在投递失败比巩固失败更新时替换「最近失败」行（`index.js:3372-3423` `withDeliveryFailure`，且 no-model 事件不遮真实投递失败 `:3393-3407`）。FakeCtx prompt 抛 TypeError 时 attempts 每 tick 仅 +1、保持 pending（`c5-h1a.test.js:226-234`）。
- **companion-* 三处排除有测试**：①`hasRealUserInput` 排除（`index.js:828`，不抢 main_session_id 绑定）；②`isInjectedMessage` → `isCompanionMessage`（`index.js:2517-2545`，rpcId `companion-` 前缀或 `[提醒] ` 正文兜底，转录排除）；③`withoutRecallRecords` → `isCompanionRecord`（`index.js:2553-2557` + `:2620-2627`，surface 记录清空）。三个用例齐全（`c5-h1a.test.js:268-354`：不重绑、不进巩固窗口、不喂召回、独有轮不触发巩固），v046-regression 再锁一遍（`test/v046-regression.test.js:244`）。

### C5-H1b 线程服务方法名 create/resolveAgent ✅

- **能力探测**：`src/platform/adapter.js:268-273` `hasThreadControl` 只认公开服务 `create+prompt+cancel` 齐全，**不调 createSession**，注释点名内部类 `ApiSessionAgentController`（`:264-265`）。
- **createSession 归一**：`adapter.js:479-494` 转发 `impl.create(request)`（缺 create 抛 `no-session` `:481-483`），返回 `{sessionId, agentPreset?}` 归一成 `{agent, agentPreset, sessionId?}`，agent 用 `resolveAgent(sessionId)` 反查；`sessionIdOf`（`:545-556`）兼容 string/对象/嵌套形状。`resolveAgent`（`:597-609`）字符串走公开 `resolveAgent`，失败回落 `ctx.agents`（`agentBySessionId` `:564-586`）；`whenIdle`（`:617-624`）接受 agent/会话 id/create 返回值，先归一再 whenIdle。
- **顺手接线（t2 追加授权项）**：thread_run 稳定 runId → 线程 requestId（`tools.js:479`）；task_run claimKey → `run.js:123,168` 组 id 传入 worker，`src/task/worker.js:85-88` 透传 `task.requestId`；`test/c5-h1b.test.js:134,142` 断言 `companion-task:task-*:claim-*` 且重投不换 id。
- **strict FakeCtx 无 createSession**：`test/fakes/ctx.js` strict 模式只有公开面；`c5-h1b.test.js:56-64` 断言 `controller.createSession === undefined`，`:67-89` 断言走 `create`+`resolveAgent`（`callsOf('sessionController.createSession').length === 0`），`:89-116` 从 apply 入口验证线程工具注册与端到端投递。
- **文档同步**：`docs/platform-api.md:24`（能力清单第 10 行改 create/resolveAgent 与返回形状）、`:96-100`（§1.3 内部类区分）、`:159`（§2 表：adapter.createSession → create + resolveAgent 归一）、`:162`（whenIdle 归一）。§2 能力门槛表述自洽（`:225-252` `no-session` 覆盖 createSession/prompt/cancel）。

### C5-H2 巩固模型解析 ✅

- **不缓存 null、晚注册可恢复**：`src/index.js:2695-2759` `resolveLlmRoute(state)` 每次重读动态能力位（`llmCapability` `:2664-2670` 是 getter 读取），成功路由才写入（`setLlmRoute:2678-2686` 带 version/resolvedAt 冻结对象），runtime 缓存有 TTL（`:2711-2716`，`LLM_ROUTE_TTL_MS`）、null/失败不缓存；并发共享同一 Promise（`:2718,2750-2758`）。旧 `llmResolved` 永久负缓存已不存在。`apply` 时非阻塞预热一次（`:377`）。
- **选路顺序 hook → 配置 → 运行时**：`resolveConsolidationLlm`（`:2795` 起）先宿主 hook；`configuredLlmModel` 命中即 `source:'config'`（`:2704-2709`）；运行时探测 `platform.listProviders()`（await 兼容同步/异步）跳过模型列表为空/无模型 id 的 provider（`:2729-2745`）。`src/config.js:420-461,543` 校验 `consolidation.model` 必须为 `{provider,model}` 两个非空字符串否则 ConfigError，`consolidation` 段非枚举、默认 `model:null`（`:116`）。
- **/status 显示 route**：`formatConsolidationStatus`（`index.js:3332-3358`）：注入 →「巩固：宿主注入模型」；配置 →「巩固：provider/model（配置）」(`:3347`)；运行时 →「巩固：provider/model（运行时）」(`:3344`)；无 →「巩固：无可用模型」+ `reportNoModelFailure`（`:2767-2787`）按 `LLM_NO_MODEL_RETRY_MS` 60s 节流写 `consolidation_failed{kind:'consolidation_no_model'}`，且不遮挡更新的投递失败（`withDeliveryFailure:3393-3407`）。解析中态与节流后台重探（`:3349-3355`）。
- **chat 同源**：`resolveChatLlm`（`:3672-3693`）复用同一 `resolveLlmRoute`，独立负缓存已删；`test/c5-h2.test.js:266` 断言闲聊与巩固同 route。
- **测试**：晚注册恢复（`:117`）、空模型 provider 跳过（`:169`）、配置优先+ConfigError（`:209`）、同 route（`:266`）、无模型文案+事件（`:332`）；v046-regression 再锁（`test/v046-regression.test.js:371,418`）。
- **探针与 round C**：`scripts/probe/probe-plugin.js:629` `llmSnapshot`（启动与首个 pre-step 各采样，`:700,802`）；`scripts/probe/run-headless.mjs:600-637` round C：无凭据（`MISSING_CREDENTIAL|no API key` `:593,759`）SKIP、有凭据 `consolidations≥1` PASS、有凭据 0 行 FAIL；体量门 HELP/PASS 文案改 round A+B+C（`:62,637`）。文档 §1.5（`platform-api.md:114`）与 §2 llm 行（`:168`）、错误码行（`:245`）齐全。

### C5-M1 压缩开关 / M2 warn 去重 / L1 /threads 提示 ✅

- **M1 三态文案**：`src/runtime/commands.js:36-40` 常量；缺失能力位不显示、false →「压缩：宿主未开启（compaction-basic 未启用）」、true →「压缩：宿主已开启（compaction-basic 已启用）」+ pending>0 时「，待压缩 N 个区间」（`commands.js:541-549`）。`src/index.js:707` 传入能力位与 `state.pendingCompact.size`。测试三态锁死（`test/c5-m1-m2-l1.test.js:98-116`、`v046-regression.test.js:471-485`）。
- **M2 去重**：巩固跳过 debug→warn，`warnSkipOnce`（`index.js:1919-1923`）按原因去重（`state.skipWarnReason:590`），真正继续才清空（`:1999`）；投递失败 `logDeliveryReport`（`:3646-3664`）按 `ErrorName: message`（`describeDeliveryFailure:3634-3640`）去重（`state.deliveryWarnReason:592`），仅 `sent>0` 清键（`:3651`，另一队列空 flush 不误清）；每次失败仍逐条写 delivery_error。测试：投递 warn 两 tick 仅 1 次（`c5-m1-m2-l1.test.js:165`）、无模型 warn 仅 1 次且 /状态 仍显示无可用模型（`:191`）。
- **L1 /threads**：`threadsSupported=false` 时 `/线程` 直接返回与 /状态 同句 `THREADS_UNSUPPORTED_TEXT`（`commands.js:36,156,538-540` 共用常量），不查库不返回空列表；不注册 thread_run/task_run（`v046-regression.test.js:493`）。
- **文档**：README `:139-148`、`docs/usage.md:447-464`（含 /线程 不支持行为）、`config.example.yml:63-77`（cordis.patch.yml 写法 `disabled:false + auto:false`，注明不写进 config.yml）均与实现一致。

## 3. 亲跑验证

- 三时区 `node --test`（Node v24.9.0，cwd=仓库根，自动发现）：
  - TZ=UTC：tests 789 / pass 789 / fail 0
  - TZ=Asia/Shanghai：tests 789 / pass 789 / fail 0
  - TZ=America/New_York：tests 789 / pass 789 / fail 0
- 备注：显式目录入参 `node --test test` 在该 Node 下报 `Cannot find module …\test`（Node 对目录入参的解析问题，非插件回归）；规范调用为无参自动发现。
- `git status --porcelain` clean 复核两次（复审前后）；`git tag` 无 v0.4.6；`main` ahead 5 未 push；t5 仅新增 1 文件（`test/v046-regression.test.js`，513 行），未改实现。
- 发布门：本轮未复跑真机命令，采信 t5 依赖回执（round A exit=1 schedulerStarted=true didNotActivate=false；round B firstReneedAt=1793853370；round C consolidations=0 credentials=missing → SKIP；总判定 PASS，日志 `.data/plugin-gate.log`）。

## 4. Low 清单（不阻塞发布）

| id | 级别 | 问题 | 修复建议 | 位置 |
| --- | --- | --- | --- | --- |
| L-1 | low | `test/worker.test.js:80-83` 仍把 prompt 第二参解构为 `promptSource` 并断言 `kind==='user'`。C5-H1a 后第二参语义是 AbortSignal（`kind` 为 best-effort 附加属性），断言恰好通过但变量名与用意均已过时，且该用例未顺带断言 `assert.ok(arg instanceof AbortSignal)`。 | 更名为 `promptSignal` 并补一条 `instanceof AbortSignal` 断言（或直接复用 c5-h1a 的锁）。 | `test/worker.test.js:80-83` |

## 5. 发布裁定

六项 C5 卡点全部关闭且有测试+文档双落点；H=0、M=0，满足 v0.4.6 发布门。建议发布提交（版本号 0.4.6、tag、push）照例进行；L-1 可随发布提交顺带修正，或留待 0.4.7。
