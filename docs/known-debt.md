# 已知技术债与真机联调清单（v0.4.0）

> 本文只记录**本轮未做项、已知限制与待真机确认项**，不新增设计判据、不改需求。
> Gate 0 九项直接引用 `memory/docs/07-风险与里程碑.md` §7.5（判据原文以该文档为准）；探针细节见 [gate0-probe.md](gate0-probe.md)，待实测问题见 [h1-h3-probe.md](h1-h3-probe.md)。
> 状态口径：**代码侧已实现，待真机确认** = 单测/e2e 已过，但未在真实 DSH 环境验证；**探针已覆盖，剩真机复测** = 探针或单测已给结论，仍需真机走一遍；**已关闭** = 已有可复现证据，不再跟踪。

## 1. Gate 0 真机联调清单

本表是 `memory/docs/07-风险与里程碑.md` §7.5 的**运行清单，不新增判据**。每行给出一句判据摘要，完整表述以 07 为准。

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
| P-2 | `session/event` 是否在本轮 pre-step 前交付新消息（索引新鲜度） | H2 已确认 `payload.messages` 只含本步新消息，新鲜度未测 | 晚一轮会漏巩固当轮内容 | 两周评测前 | 跑 `npm run probe:headless -- --two-turn`，对比新消息 seq 与 pre-step 入参；缺本轮消息则调整注入点 |
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

### D-4 W4：local embedding 未在真机加载与计量

- **现状**：`local` 通过动态 `import('@huggingface/transformers')` 加载 `Xenova/bge-small-zh-v1.5`（512 维 int8），是可选依赖；测试全部使用注入的 fake loader，未在真实 Electron/Node 上加载模型，也未测首次下载、加载耗时与 RSS 增量。remote 同样只用注入 fetch。
- **影响**：真机上可能因原生 ONNX、网络、内存不足而加载失败；失败会静默退回 FTS，用户以为已开启语义召回；4G 机器上模型内存可能叠加到 RSS 红线。
- **建议排期**：推荐用户开启 `local` 前完成；最迟 P1 前，与 Linux 2C4G 复测一起。
- **验收方式**：在 Windows DSH（Electron）与 Linux 纯 Node 各装一次可选依赖，首次加载 + 批量 embed 10 条；断言 `/状态` 显示 `local:bge-small-zh-v1.5:512`、维度 512、回填计数增长；记录首次下载/加载耗时与 RSS 增量；卸载依赖后确认 `EmbeddingUnavailable` 并回退 FTS，不阻塞召回。

### D-5 Linux 2C4G 内存复测（Gate 0-4 的目标环境）

- **现状**：Gate 0 的预算数据来自 Windows 开发机；RSS 默认三档 2.95/3.0/3.15GiB，4G 机器按自检公式只有 2.5GiB 预算，需手动降到 2.2/2.4/2.6，swap 与 `threadMaxActive` 均未在 Linux 2C4G 上实测。
- **影响**：默认 3.0GiB 的 stop 可能晚于 OOM；不配 swap 时峰值 2.92GiB 已贴近 4G 上限；线程并发高时更容易触发 OOM 而非优雅降级。
- **建议排期**：云端发布前必须；与 D-4 同批做。
- **验收方式**：Linux 2C4G、swap 1–2GB、DSH headless；按 [calibration.md](calibration.md) 配 RSS 2.2/2.4/2.6（`threadMaxActive` 先设 2–3）；跑 24h 混合负载，记录常驻/峰值 RSS、warn/stop/main_only 触发与恢复、无 OOM；再把结果回填 Gate 0-4。

## 5. 关联文档

- [README](../README.md)：配置表、v0.4.0 变更摘要、已知限制
- [使用手册](usage.md)：执行槽、向量召回、外部压缩与水位重锚、FAQ
- [Embedding 可插拔](embedding.md)：三实现、隐私例外、回填
- [S0 标定流程](s0-calibration.md)：`first_reneed_*` 埋点与两周评测
- [Gate 0 探针说明](gate0-probe.md)、[H1–H3 探针](h1-h3-probe.md)：已关闭结论与待实测项
- [安装自检与校准](calibration.md)：RSS 三档公式与 4G 示例
