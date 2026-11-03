# 变更记录

本文件记录 dsh-companion 的用户可见变化。版本号遵循语义化版本；MVP 阶段仍为 `0.x`。

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
