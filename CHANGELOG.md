# 变更记录

本文件记录 dsh-companion 的用户可见变化。版本号遵循语义化版本；MVP 阶段仍为 `0.x`。

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
