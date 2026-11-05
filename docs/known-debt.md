# 已知技术债与真机联调清单（v0.4.2）

> 本文只记录**本轮未做项、已知限制与待真机确认项**，不新增设计判据、不改需求。
> Gate 0 九项直接引用 `memory/docs/07-风险与里程碑.md` §7.5（判据原文以该文档为准）；探针细节见 [gate0-probe.md](gate0-probe.md)，待实测问题见 [h1-h3-probe.md](h1-h3-probe.md)。
> 状态口径：**代码侧已实现，待真机确认** = 单测/e2e 已过，但未在真实 DSH 环境验证；**探针已覆盖，剩真机复测** = 探针或单测已给结论，仍需真机走一遍；**已关闭** = 已有可复现证据，不再跟踪。

## 1. Gate 0 真机联调清单

本表是 `memory/docs/07-风险与里程碑.md` §7.5 的**运行清单，不新增判据**。每行给出一句判据摘要，完整表述以 07 为准。

> **C-H1 激活口径（2026-11-04）**：v0.4.2 及以前，本插件在真实 cordis 宿主上**从未激活过**——缺少 `export const inject`，`apply()` 的第一个属性读（`ctx.rssReader`）就抛 `cannot get property "rssReader" without inject`，下表所有「代码侧已实现」都只代表 mock 环境通过（旧 mock 是普通对象，读属性不抛，667 个用例因此没覆盖宿主约束）。
> C-H1 已补 inject 声明、去掉 Context 属性直读、加严格 mock，并给 `run-headless.mjs` 增加 `--plugin` 发布门。2026-11-04 本机已跑通该门（退出码 0，stderr 出现 `[dsh-companion] scheduler started {"jobs":6,…}`，无 `did not activate`，完整输出见 `.data/plugin-gate.log`）；**C-H1 由此进入真机确认**——下表各行的「代码侧已实现」仍需按 07 §7.5 在真机逐项复测，手册 §6.2 通过后才算关闭。

| Gate | 判据（一句） | 状态 | 证据来源 | 真机命令或观察点 |
| --- | --- | --- | --- | --- |
| G0-1 人格默认值 | 名字/称呼/语气已拍板；不通过只用中性默认 | 代码侧已实现，待真机确认 | `test/persona.test.js`；07 §7.5 | 全新 profile 首条消息看称呼与语气；检查 system prompt 段 |
| G0-2 压缩参数 | 主触发 24,000（连续两轮）、安全阀 40,000、保留 6,144、只用 `compactRegion`、`auto:false` | 代码侧已实现，待真机确认 | `test/config.test.js`、`test/e2e/apply-turn.test.js`、`test/e2e/surface-seq.test.js`；07 §7.5 | 长会话触发压缩，确认区间与保留尾部；`auto:false` 属 DSH/profile 配置，真机核对 |
| G0-3 熔断 | 单轮 40K / 单任务 300K / 单日 3M / 月 46M 告警、90M 熔断 | 代码侧已实现，待真机确认 | `test/budget.test.js`、`test/e2e/budget-wiring.test.js`；07 §7.5 | `/成本`、`/状态` 看「已熔断」与日用量；插件固定日 3M，单轮/单任务/月线需在宿主/profile 侧核对 |
| G0-4 2C4G 预算 | 常驻 1.30 ≤1.3、峰值 2.92 ≤3.0、红线 3.2、执行态恒 1 | 代码侧已实现，待真机确认 | `test/e2e/budget-wiring.test.js`；07 §7.5 | Linux 2C4G 上采 RSS 曲线与执行态计数；配合 `rssWarnGiB/rssStopGiB/rssMainOnlyGiB` |
| G0-5 平台实测 | 05 §10 V1–V6 有结论（createSession/prompt/cancel/whenIdle/注入点/压缩触发） | 探针已覆盖，剩真机复测 | `docs/gate0-probe.md`、`test/platform.test.js`；07 §7.5 | H1/H2/W2 已关闭；剩 H3 GUI 双会话分流，见 §2 |
| G0-6 备份与删除 | 备份 7 份滚动、删除 7+7 天、对外三句已确认 | 代码侧已实现，待真机确认 | `test/e2e/acceptance.test.js`、`test/e2e/forget-pipeline.test.js`、`test/scheduler.test.js`；07 §7.5 | 连续运行 8 天看 `.data/backups` 只留 7 份；S1 后 7 天物理删除、备份再留 7 天 |
| G0-7 线程隔离 | `scope` 下推 SQL、跨 thread 召回 0（V7） | 代码侧已实现，待真机确认 | `test/e2e/session-scope.test.js`、`test/session-identity.test.js`、`test/p1a.test.js`；07 §7.5 | 两个线程各自写事实后互搜，确认 0 命中；N-L4 见 §3 |
| G0-8 状态板跨天 | 跨天版本连续、在办不丢、≤800 token（V8） | 代码侧已实现，待真机确认 | `test/assemble.test.js`、`test/e2e/acceptance.test.js`、`test/e2e/p2.test.js`；07 §7.5 | 跨本地日界观察 `state_board_rev` 连续、在办项保留、装配 token ≤800 |
| G0-9 记忆实测 | G-M1 enter 召回不重复、G-M4 压缩≤4s/S1≤10s、G-M5 水位不重复切、G-M6 staged 四时机全过 | 探针已覆盖，剩真机复测 | `test/e2e/turn.test.js`、`test/e2e/apply-turn.test.js`、`test/e2e/external-compaction.test.js`、`test/e2e/acceptance.test.js`、`test/e2e/surface-seq.test.js`；07 §7.5 | 真机看压缩耗时 ≤4s、S1 ≤10s；staged 的四个时机（启动/日切/巩固后/手动）各走一次 |

已关闭的探针子项：H1（surface seq 来源与闭区间）、H2（`payload.messages` 只含本步新消息）、W2（Node 24.21.0 / Electron 44.7.0 / node:sqlite 3.53.4）；H3（GUI 双会话分流）仍未关闭，随 G0-5 真机复测，相关问题见 §2。

## 2. 探针待实测（`docs/h1-h3-probe.md` §4）

| 编号 | 待测问题 | 现状 | 影响 | 建议排期 | 验收方式 |
| --- | --- | --- | --- | --- | --- |
| P-1 | `sessionQuery.readSurface(session.id)` 在长会话 pre-step 的耗时 | H1 已确认 seq 来源与区间，未测长会话耗时 | 会话节点多时 pre-step 变慢，可能拖慢每轮 | 两周评测前 | 构造 1k/5k 节点会话，记录 p50/p95；若随节点数线性增长则加缓存或索引 |
| P-2 | `session/event` 是否在本轮 pre-step 前交付新消息（索引新鲜度） | H2 已确认 `payload.messages` 只含本步新消息，新鲜度未测；L-3（平台摘要节点身份）并入本项，**L-3 保持 P1，随本项真机确认** | 晚一轮会漏巩固当轮内容；摘要节点归属不清会重复/漏算 surface | 两周评测前 | 跑 `npm run probe:headless -- --two-turn`，对比新消息 seq 与 pre-step 入参；同时核对平台摘要节点的 `agent`/`session` 归属与 seq 口径；缺本轮消息则调整注入点 |
| P-3 | 线程会话 `header.agentPreset` 是否持久化 | 未测 | 重启后线程可能丢人格/preset | 线程功能真机验收前 | 建带 preset 的线程，重启 DSH，读 thread session header 确认仍在 |
| P-4 | subagent pre-step 的 payload 是否带 `origin==='subagent'` 且 `parentSession` 指向父会话 | 未测（headless 只能模拟单会话） | subagent 识别失败会误召回/误写库 | GUI 联调时 | GUI 派一个 subagent，抓 pre-step payload，断言两个字段；不满足则改子会话识别 |

## 3. G0-7 子项：执行槽真机行为（N-L4）

R-M2 已修，代码侧单测见 `test/thread-slot.test.js`；下面两条仍需真机确认，作为 G0-7 的子项跟踪。

### N-L4a `thread_run` 带 `goal` 时持有执行槽

- **现状**：`thread_run` 带 `goal` 会取执行槽并等线程 `whenIdle`；create 分支直接传会话句柄，reuse 反查失败写 `warn` + `threadSlotFallback`，900s 兜底写 `warn` + `threadSlotTimeout`。单测覆盖，真机未复测。
- **影响**：若宿主 `whenIdle` 语义与 mock 不一致，槽可能提前释放（并发）或长期不释放（饿死 `task_run`）。
- **建议排期**：v0.4.0 发布后第一次真机联调，优先于 P1。
- **验收方式**：真机发一个带 `goal` 的 `thread_run`，在其运行期间调用 `task_run` 与 `/状态`；确认槽被占、`threadSlotFallback`/`threadSlotTimeout` 计数符合预期、线程空闲后槽释放。

### N-L4b `task_run` 在 `whenIdle` 前返回 busy 或排队

- **现状**：执行槽全局 1 个，`task_run` 排队上限 2，队列满返回 `busy`；`runTask` 会等待 `acquire()`，因此槽被占时表现为排队/忙，不会并发进入执行态。
- **影响**：主会话若把「排队」误判为「失败」会重复派发；用户侧需要明确话术。
- **建议排期**：v0.4.0 发布后第一次真机联调。
- **验收方式**：`thread_run` 持槽期间连发 3 个 `task_run`；前 2 个应排队、第 3 个返回 `busy`；`whenIdle` 后队列按序执行，无并发执行态；主会话回话使用「正在执行上一个任务，稍后继续」。

## 4. 本轮未做项（技术债）

按处理阶段分两类：**P1 前必须**（会影响两周评测结论或 P1 功能）、**真机阶段**（需真实 DSH/目标机器才能确认）。未列出的旧债保持原状；E-M1/S-M1/L-2 已在 v0.4.1 修复，S2-M1/E2-M1/L2-1/L2-2/L2-3 已在 v0.4.2 修复，见 §5。

**P1 项保持**：review-code-v0.4.1 的 L-1（remote 查询侧无敏感过滤，D-6）、L-3（平台摘要节点身份，随 P-2 真机）、L-4（RSS 单位待 07 明确，D-8）、L-5（remote 无调用上限/熔断，D-7）本轮均未做，排期与优先级不变。

### P1 前必须

### D-1 N-M4 / W1：worker 没有 token 上限（P1 前必须）

- **现状**：`src/task/worker.js` 只有软超时 600s（告警）与硬超时 900s（两段式取消）：`DEFAULT_SOFT_MS` / `DEFAULT_HARD_MS`。没有按估算 token 的软/硬阈值，回执也没有 `status=partial`；preset 中未发现 `auto:false`。评审 v0.3.2 将 N-M4/W1 与 N-L1 列为两周评测前置，N-M4 必须在 P1 前完成（N-L1 已在 v0.4.0 完成）。
- **影响**：长任务可能在不知情时撑爆上下文；硬超时截断与「正常完成」在回执上不可区分，调用方无法决定是否重派；成本与上下文风险不可控。
- **建议排期**：P1 开始前必须；建议与 W1 合并为一次 worker 改造。
- **验收方式**：按评审建议加软 60K（估算）注入收尾提示、硬 80K 结束；回执增加 `status=partial` 并让调用方可重派；单测覆盖软/硬阈值、partial 回执、正常路径不回归；真机跑一个长任务确认收到收尾提示且可在 partial 后继续。

### D-2 N-L2：治理/编辑绕过 `memory_events` CHECK

- **现状**：`src/memory/govern.js` 的 `appendEventWithAction` 在写入 `govern`/`EDIT` 动作时执行 `PRAGMA ignore_check_constraints = ON`，写完后恢复（`src/memory/govern.js:246-293`，读取/开启/恢复分别在 `:269`、`:272`、`:289`）。原因是 `memory_events.action` 的 CHECK 白名单没有这两个动作，schema v7 仍在绕过。
- **影响**：PRAGMA 是连接级开关，绕过期间其他 CHECK 也失效；一旦异常路径未恢复连接，后续写入可能落进非法动作；审计表的约束形同虚设，迁移/排障时容易误判。
- **建议排期**：低优先级补丁，P1 前与 schema 迁移一起做。
- **验收方式**：迁移中重建 `memory_events` 的 CHECK 白名单，加入 `govern`/`EDIT`（保留旧动作）；删除 `ignore_check_constraints` 开关；单测直接写两个动作不报错、非法动作仍被 CHECK 拒绝；`grep -R ignore_check_constraints src/` 无结果；用 v7 旧库跑一次迁移与治理命令。

### D-3 N-L3：`deepConsolidate` 用错 transcript 判断主会话是否有新内容

- **现状**：`src/index.js` 的 `deepConsolidate` 以 `state.transcript.length === 0` 作为「主会话没有新内容」的闸门；`state.transcript` 会在 pre-step 按当前 scope 切换（`activateScopeTranscript`），如果最后活跃的是线程，这里读到的是线程 transcript，而快照又取主会话的 `surfaceSnapshotByScope.get(SCOPE)`。主会话自己的 transcript 实际存在 `state.transcriptByScope.get(SCOPE)`。
- **影响**：最后活跃为线程时，主会话可能被误判为「有内容」而白跑一次 deep-sleep，或主会话确有新内容却被线程状态掩盖；表现为巩固延迟/重复与不必要的模型调用。
- **建议排期**：低优先级补丁，P1 前；与 deep-sleep 其他规则改动一起测。
- **验收方式**：`deepConsolidate` 改为读主会话自己的 transcript（或同时校验主会话快照）；单测覆盖「主空/线程非空」不写、「主非空/线程空」写入、「两者都有」按主会话写；回归现有 deep-sleep 用例。

### D-6 L-1：remote 查询侧没有敏感过滤（P1）

- **现状**：隐私过滤只作用在**事实行**上——`store.listVectorBackfill` 只取 active + normal + 未删除 + 非 `sensitive`，`govern` 命中敏感词的事实也不会进入 embedder（[remote.js](../src/memory/embedders/remote.js) 顶部注释）。但召回查询是用户当前输入（`retrieve.js:273` 调 `embedder.embedQuery([textQuery])`），查询文本不经 `isSensitiveText`，开启 remote 时会原样 POST 到第三方 endpoint。
- **影响**：用户在对话里提到秘密/敏感内容时，即使事实行被过滤，查询原文仍会出境；「敏感事实不发送」的承诺只覆盖写侧，不覆盖读侧。
- **建议排期**：P1 前；与 remote 正式开放同时。
- **验收方式**：在 remote 路径加查询侧过滤/开关（命中敏感词则跳过向量查询、只走 FTS，并记 metric），单测覆盖「敏感查询不调 fetch」「普通查询照常」；文档与 `/状态` 说明查询也会发送；用一个含敏感词的输入抓 fetch 断言 0 请求。

### D-7 L-5：remote 调用没有上限/熔断（P1）

- **现状**：remote 每次召回发一次查询请求、回填每批一次；失败只 `throw EmbeddingUnavailable/EmbeddingTimeout`，由 `retrieveVectors` 记 `vectorEmbedFailures` 并回退 FTS，下一轮继续尝试。没有每轮/每日调用次数上限，也没有 local 那样的退避/长冷却（E-M1 只加在 local）。
- **影响**：endpoint 故障或计费接口被频繁触发时会持续产生请求与费用；用户无法用配置封顶。
- **建议排期**：P1 前；在 remote 正式开放前完成。
- **验收方式**：加可配置的调用上限（如每轮 1 次、每日 N 次）与失败退避/熔断，超限直接走 FTS 并记 metric；单测覆盖超限不 fetch、冷却后恢复、正常路径不回归；文档补配置项与 `/状态` 观测。

### 真机阶段

### D-4 W4：local embedding 未在真机加载与计量，回填超时/批量待实测校准

- **现状**：`local` 通过动态 `import('@huggingface/transformers')` 加载 `Xenova/bge-small-zh-v1.5`（512 维 int8），是可选依赖；测试全部使用注入的 fake loader，未在真实 Electron/Node 上加载模型，也未测首次下载、加载耗时与 RSS 增量。remote 同样只用注入 fetch。E-M1（v0.4.1）已给加载/推理加超时与异步预热、失败分类与退避；E2-M1（v0.4.2）已拆出回填超时（默认 30s）、批量默认降到 8、推理单飞与加载单飞，但 `backfillTimeoutMs` / `backfillBatchSize` 仍是估计值，**真实加载路径、首次下载、单条/批量推理耗时与内存增量仍未在真机验证**。
- **影响**：真机上可能因原生 ONNX、网络、内存不足而加载失败；失败会静默退回 FTS，用户以为已开启语义召回；4G 机器上模型内存可能叠加到 RSS 红线。回填超时或批量设得不当，会让回填长期超时（向量填不满、实际一直退化 FTS）或单批占用过久；这些参数目前没有 2C 实测依据。
- **建议排期**：推荐用户开启 `local` 前完成；最迟 P1 前，与 Linux 2C4G 复测一起。
- **验收方式**：在 Windows DSH（Electron）与 Linux 纯 Node 各装一次可选依赖，首次加载 + 批量 embed 10 条；断言 `/状态` 显示 `local:bge-small-zh-v1.5:512`、维度 512、回填计数增长，并显示「回填超时 / 占用」计数；**在 2C 目标机器上实测单条与批量推理耗时，据此校准 `backfillTimeoutMs` 与 `backfillBatchSize`**；记录首次下载/加载耗时与 RSS 增量；卸载依赖后确认 `EmbeddingUnavailable` 并回退 FTS，不阻塞召回。

### D-5 Linux 2C4G 内存复测（Gate 0-4 的目标环境）

- **现状**：Gate 0 的预算数据来自 Windows 开发机；RSS 默认三档 2.95/3.0/3.15GiB，4G 机器按自检公式只有 2.5GiB 预算，需按自检值下调（例如 3.64GiB 对应 1.96/2.14/2.32），swap 与 `threadMaxActive` 均未在 Linux 2C4G 上实测。
- **影响**：默认 3.0GiB 的 stop 可能晚于 OOM；不配 swap 时峰值 2.92GiB 已贴近 4G 上限；线程并发高时更容易触发 OOM 而非优雅降级。
- **建议排期**：云端发布前必须；与 D-4 同批做。
- **验收方式**：Linux 2C4G、swap 1–2GB、DSH headless；按 [calibration.md](calibration.md) 的自检值配 RSS（例如 3.64GiB 对应 1.96/2.14/2.32；`threadMaxActive` 先设 2–3）；跑 24h 混合负载，记录常驻/峰值 RSS、warn/stop/main_only 触发与恢复、无 OOM；再把结果回填 Gate 0-4。

### D-8 L-4：RSS 默认值与 3.2GB 红线的单位待 07 明确（P1 / 真机）

- **现状**：代码默认三档 `2.95/3.0/3.15`（GiB），Gate 0-4 与 07 §7.5 的红线写作 **3.2GB**；GiB 与 GB 差约 7%（3.2GB ≈ 2.98GiB），按默认 stop 3.0GiB 实际已越过按 GB 解释的红线。07 未写明单位，也没说明默认三档是否应随目标机器 4G 下调。本文不新增判据，只记录待澄清点。
- **影响**：单位解释不同会改变 Gate 0-4 的通过/不通过判定；真机按 3.0GiB stop 运行时可能先触红线而未触发告警。
- **建议排期**：P1 前由 07 明确单位与默认值口径；真机复测（D-5）按明确后的数值执行。
- **验收方式**：07 补一句单位（GB 或 GiB）并给出 4G 机器的推荐默认；代码/文档/自检表三处数值一致；D-5 的复测记录引用该口径。

### D-9 V3-H2 提醒投递的 store 故障属 best-effort（接受现状）

- **现状**：队列钩子 `onAttempt` / `onSent` / `onFailed` 里的异常只记入该次投递的 `report.error`，不会中断投递本身。若 `claimReminderDelivery` 因 store 故障抛错，投递仍会进行、行保持 `pending`，重启后可能再发一次（同一 fireKey 的成功标记也未能落库）。
- **影响**：仅在 SQLite 写失败等极端情况下出现一次重复提醒；正常路径两阶段投递与 `fired` 幂等已由 `test/e2e/reminder-delivery.test.js` 覆盖。
- **建议排期**：本版不修；后续强化提醒状态机时，把 store 写失败视为投递失败并走 `onFailed`（同时累计 `delivery_attempts`）。
- **验收方式**：构造 store 写失败（注入抛错的 `claimReminderDelivery`），断言提醒不重复发送或明确置 `expired`。

## 5. 已关闭（本轮修复）

- **V9-M1 episode 落库前仍保留凭据原文**：v0.4.10 修复，commit `a4fe4e0`，字段级兜底口径由 `6e1ade8` 补齐。`consolidate` 写 episode 前对 `title` / `summary` / `evidence` / `mood_evidence` 与 `topics` / `entities` 逐字段脱敏，只把凭据值换成 `[凭据已省略]`、保留「路由器密码 …」这类上下文（不是整段丢弃）；`store.insertEpisode` 再做一次防御性值级脱敏（含 `topics_json` 字符串形态），`fts_episodes` 由主表投影故自动无明文。跨会话召回、注入、状态板与 JSON 导出经 `test/e2e/v0910-privacy.test.js` 验证均无明文；巩固提示词同时要求「不得复述密码、口令、token、卡号等凭据值」。
- **V9-L1 token / 银行卡误报**：v0.4.10 修复，commit `a6de86d`。`SENSITIVE_PATTERN` 移除裸 `token` 与裸「银行卡 / 信用卡」：「token 额度 10B」「银行卡在招行」不再判敏感；token 仍由「字段名 + 连接词 + 含数字或符号的值」兜底（`token 是 abc123`、`API token：sk-…` 仍命中），银行卡收窄为卡号形态（12 位以上数字，允许 4 位分组的空格或连字符），`卡号` / `card number` 字段名要求后跟数字（旧用例「银行卡号 + 卡号数字」仍命中）。
- **V9-L2 口令 / WiFi 漏报**：v0.4.10 修复，commit `a6de86d`。强模式补「口令」（「密码学」负向断言不变）；新增设备值模式（WiFi / 路由器 / 路由 / 门禁 / 门锁 / 热点 + 是/为/`:`/`=` + 值，值须含数字或符号），「路由器口令是 …」「WiFi 是 …」这类表述现在会被识别，并在 episode 落库前脱敏。

- **V7-M1 压缩起点可能落在系统提示词节点**：v0.4.9 修复。`src/session/surface.js` 的 `planRegion` 选定起点后调用导出的 `firstReplaceableIndex(snapshot, from)` 跳过 `role: 'system'` 节点（节点 0 正文缺失、`role` 未知时保守跳过），区间中途再遇系统节点则提前收尾，全部不可替换返回 `region: null, reason: 'no-replaceable-range'`；`src/index.js` 的 `maybeCompact` 在恢复历史 `pending_compact` 时用同一 helper 收紧起点，收紧后区间为空则丢弃 pending 并计 `compactionDrops`，不调用 `compactRegion`。常规巩固、deep-sleep 与 pending 恢复压缩共用同一道起点收紧。**观察项（终点 fence 未做）**：恢复的 pending 只收紧起点、未收紧终点；平台只保护 node 0（系统提示词），跨版本旧 pending 的中段系统节点仍可能被跨过。文档已补记于 [usage.md](usage.md) 的「压缩起点跳过系统节点」与「隐私与凭据」两节。
- **V7-L1 发布门 round C 只跑单轮、tokenMeter=0**：v0.4.9 修复（与 V7-L2 同提交）。round C 改为同一会话两轮：第一轮 `--json` 取 `sessionId`，第二轮 `--session-id` 续跑（overlay 的 `compactHardTokens` 降到 120，两轮输入才过阈值）。判定要求 scheduler started 标记、tokenMeter 观测到非零 token（`tokens` 事件 `maxTokensIn > 0`）、`consolidations` 至少一行；无模型凭据时 SKIP（明确不算 PASS），有凭据而断言失败时发布门 exit 1。为可测试性导出 `parseSessionId` / `readConsolidationEvidence` / `evaluateConsolidationRound`，`runConsolidationRound` 接受 runner 与证据读取注入。
- **V7-L2 巩固/压缩事件只有秒级 started_at/finished_at**：v0.4.9 修复（与 V7-L1 同提交）。巩固在 `consolidate({ clock })` 事务收尾用注入毫秒时钟算 `duration_ms`（生产传 `platform.now`），写进 episodes 事件 detail（`kind: 'consolidation'`）；压缩在 `compactRegion` 前后用 `platform.now()` 计时，成功后写 `memory_events`（`table_name: 'compactions'`、`action: 'UPDATE'`、`detail.kind: 'compaction'`）；新增 `eventDurationMs` 读取 helper，旧行没有该字段时返回 null（不影响读取）。

- **S2-M1 `used` 升级锁死首次注入时间/档位/same_context**：v0.4.2 修复，commit `890f028`。新增 `first_used_at` / `first_used_tier` / `used_same_context`（schema v9），用上那一刻写入并按 `observed_at` 重新判定 same_context；「首次」指首次非 same_context 用上，same_context 的 used 可被后续非 same_context used 覆盖一次，reverse 不覆盖；`first_reneed_*` 保留为 recall 对照样本。SQL 与口径见 [s0-calibration.md](s0-calibration.md)。
- **E2-M1 回填共用 300ms 超时且推理/加载叠加**：v0.4.2 修复，commit `a99de84`。回填独立 `vector.backfillTimeoutMs`（默认 30s）、`backfillBatchSize` 默认 8；推理单飞，超时批次未结束前不再起新批；查询遇忙立即回退 FTS；加载单飞复用同一 promise。真机参数校准仍见 D-4（未关闭）。
- **L2-1 same_context / Δt 以 `created_at` 计时**：v0.4.2 修复，commit `890f028`。same_context 判定与 Δt 统一从 `observed_at`（原话时间）起算，取不到时按 episode 时间回退，代码注释与 SQL 同步说明。
- **L2-2 CHANGELOG 用例数口径不一致**：v0.4.2 修正。核对 v0.4.0 tag 实测 626、v0.4.1 tag 实测 646，v0.4.1 的「639 → 646」改为真实口径「626 → 646」（+20）；v0.4.2 按发布时实测为 646 → 667（+21，16 个套件）。
- **L2-3 `loadTimeoutMs` 超时后重试可能并行加载**：v0.4.2 修复，commit `a99de84`。`loadInFlight` 只在底层 settle 后清空，`doLoad` 不再自套超时，重试复用未结束的 promise，`status=loading` 依据该 promise。
- **E-M1 local embedding 无超时、首次加载阻塞 turn**：v0.4.1 修复，commit `7270417`。加载等待与推理都受 `vector.embedTimeoutMs`（默认 300ms）约束；启动/idle-probe 异步预热，加载期间本轮走纯 FTS；缺依赖 fatal 停用，网络/超时/初始化 transient 退避（1/2/4/8s，第 5 次失败后 60s 长冷却，不永久停用）。测试与文档见 [embedding.md](embedding.md)。
- **S-M1 W5 把「被注入」当「被需要」、未排除同会话即时召回**：v0.4.1 修复，commit `39addbb`。`reneed_kind` 增加 `used`（复述重叠 ≥0.6 升级，保留首次时间/档位）；新增 `same_context`（Δt<6h 或来源 episode 仍在 surface），统计排除。schema v8。v0.4.2 的 S2-M1 进一步改为用上时单独记录，见上。
- **L-2 确认词长度上限**：v0.4.1 修复，同 commit `39addbb`。`isConfirmation` 去标点/空白后超过 `CONFIRM_MAX_CHARS=10` 直接不算确认。

## 6. 关联文档

- [README](../README.md)：配置表、v0.4.2 变更摘要、已知限制
- [使用手册](usage.md)：执行槽、向量召回、外部压缩与水位重锚、FAQ
- [Embedding 可插拔](embedding.md)：三实现、超时/单飞/回填、隐私例外
- [S0 标定流程](s0-calibration.md)：`first_used_*` / `first_reneed_*` 埋点与两周评测
- [Gate 0 探针说明](gate0-probe.md)、[H1–H3 探针](h1-h3-probe.md)：已关闭结论与待实测项
- [安装自检与校准](calibration.md)：RSS 三档公式与 4G 示例
