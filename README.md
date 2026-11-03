# dsh-companion

> 珞然：给一个人的长期记忆管家。单主会话 + 少量线程，记忆留在本机，不跨设备同步。

`dsh-companion` 是 DeepSeek Harness（DSH）的私人管家记忆插件：把对话沉淀为事实、提醒与线程，按遗忘曲线检索，并在合适的时间主动提醒。插件通过平台注入的服务工作，不直接依赖 DSH 内部包。

当前状态：**MVP 0.3.0**（2026-11-04），`node --test` 全绿（538 个用例 / 16 个套件），git tag `v0.3.0`。

## 目录结构

```text
dsh-companion/
├─ src/
│  ├─ index.js        # 插件入口：apply/dispose、生产接线、pre-step 主链路
│  ├─ config.js       # 配置默认值与校验
│  ├─ memory/         # store、bigram、retrieve、consolidate、state-board、assemble、govern、export、vector
│  ├─ persona/        # 人格卡、system prompt 段与轻闲聊
│  ├─ platform/       # DSH 适配层与 PlatformError
│  ├─ runtime/        # commands、tools、metrics、scheduler、proactive、retry
│  ├─ scheduler/      # 承诺跟进（commitment follow-up）
│  ├─ session/        # 会话身份（main/thread/subagent）与 surface 索引
│  ├─ task/           # worker、串行执行槽与回执
│  └─ thread/         # 线程目录（命名、上限、冻结）
├─ scripts/           # 校准、探针、加密导出/解密与向量 bench
├─ test/              # node:test 单测与 e2e（含 apply 驱动的生产路径）
├─ docs/              # usage、platform-api、review 报告
├─ .data/             # 运行期数据库（git 忽略）
├─ package.json
├─ CHANGELOG.md
└─ README.md
```

## 环境要求与零依赖

- Node.js `>= 24`，使用内置 `node:sqlite`（启动时会打印 ExperimentalWarning，属正常现象）。
- **零第三方运行时依赖**：`package.json` 没有 `dependencies` / `devDependencies`，不需要 `npm install`，也不需要构建步骤；测试只用 `node:test`。
- 数据默认写入工作区 `.data/companion.db`，可用 `dbPath` 改到有写权限的目录。

## 加载方式

把本仓库放进 DSH 工作区，在所用 profile 的 `cordis.patch.yml` 中加入插件行（配置文件位置以本机 DSH 安装为准）：

```yaml
- insert:
    - id: dsh-companion
      name: 'dsh-companion'
      config:
        dbPath: ./.data/companion.db
```

> 以上仅为示例，**尚未写入用户 profile**。本地开发时 `name` 可指向本目录的绝对路径；改完重载 profile 生效。

## 配置

| 配置键 | 默认值 | 含义 | 范围 / 约束 |
| --- | --- | --- | --- |
| `workingMemoryTokens` | `32000` | 工作记忆装配上限（token） | 正整数 |
| `compactAtTokens` | `24000` | 连续两轮超过后触发巩固 | 正整数 |
| `compactHardTokens` | `40000` | 安全阀阈值 | 正整数 |
| `idleMs` | `1800000` | 距最后一条人类消息多久后允许「空闲巩固」（毫秒） | 正整数 |
| `retainTokens` | `6144` | 压缩时保留的最近对话尾部 | 正整数 |
| `threadIdleDays` | `14` | 线程空闲多少天后冻结 | `>= 1` |
| `threadMaxActive` | `6` | 同时活跃的线程上限 | `>= 1` |
| `proactiveDailyCap` | `3` | 每日主动消息上限 | `>= 0`，`0` 关闭主动 |
| `quietStart` | `"23:00"` | 安静时段开始 | `HH:MM` |
| `quietEnd` | `"08:00"` | 安静时段结束 | `HH:MM` |
| `timezone` | `"Asia/Shanghai"` | 墙上时间所用 IANA 时区（安静时段、每日任务、日界线、备份文件名） | 合法 IANA 时区名 |
| `purgeAfterDays` | `7` | 遗忘冷静期，到期物理删除 | `1`–`30` |
| `dbPath` | `"./.data/companion.db"` | SQLite 数据库路径 | 非空字符串 |
| `vector.enabled` | `false` | 是否启用可选向量召回 | 布尔；默认关闭 |
| `vector.dim` | `256` | 向量维度（`hashEmbed` 桶数） | 整数 `8`–`4096` |
| `vector.embedder` | `"hash"` | 向量化实现 | `hash`（字符 bigram 哈希，非生产质量）/ `none`（退化） |

token 四档必须满足 `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens`。未知配置键只记警告，不阻断启动。v0.3.0 新增可选的 `vector.*`（默认关闭；`DEFAULTS.vector` 不可枚举，首次安装自检仍按 13 个键输出）；治理/编辑、承诺跟进、轻闲聊与失败自愈仍由既有配置与固定阈值控制。

所有墙上时间判断（安静时段 `quietStart`/`quietEnd`、每日 `03:00`/`03:30`/`04:00` 任务、日界线与备份文件名）一律按 `timezone` 计算，与进程环境变量 `TZ` 无关。

**每日 token 熔断**：按 `timezone` 的本地日界累计每日 token 用量，达到 `3,000,000` 后进入熔断：拒绝新的 `task_run`、暂停主动消息，`/成本` 与 `/状态` 会显示「已熔断」；本地日界翻篇自动复位。该上限固定为 3M，v0.3.0 不提供配置键。

**RSS 三档降级**：每 60 秒检查一次进程 RSS，`≥2.95GiB` 记 warn 指标（不降级）、`≥3.0GiB` 停 `task_run` 与主动消息、`≥3.15GiB` 再停线程创建；恢复后自动解除。阈值固定，v0.3.0 不提供配置键。

## 首次安装自检

默认配置是 32K 工作记忆；机器内存或模型上下文不同，建议先跑一次自检：

```bash
cd dsh-companion
node scripts/calibrate/run.mjs
```

它用临时 `DSH_HOME` 跑一次 headless，写出：

- `.data/calibration.json`：node/electron/dsh 版本、SQLite、CPU、内存、RSS 中位、
  `tokenMeter` 节点数、contextWindow 来源与建议值；
- `.data/config.suggested.yml`：13 个基础配置键的建议值（不含默认关闭的 `vector.*`），头部带 `generated_at` 与
  `source`（node/electron/dsh/rss_median）。

自检**不会**自动合并配置、不会写人格卡或记忆库；核对后把需要的键复制到
`config.yml`。也可以手动把 `scripts/calibrate/calibrate.patch.yml` 叠加到 profile。
公式、告警线（`min(user, totalmem×0.75−512MB)`）、15% 误差口径与平台限制见
[docs/calibration.md](docs/calibration.md)。

示例配置与人格卡见 `config.example.yml`、`persona.example.md`。

## 命令与工具

命令：`/记忆`（`列表 [关键词]`、`忘掉`、`改 <id> <内容>`、`治理 [--dry-run]`、`导出 [md|json]`、`置顶`、`取消置顶`）、`/成本`、`/线程`、`/状态`、`/别闲聊`、`/恢复闲聊`。

工具（10 个）：`memory_search`、`memory_write`、`memory_update`、`memory_forget`、`reminder_add`、`reminder_done`、`thread_list`、`thread_run`、`task_run`、`cost_report`。

参数、返回与降级行为见 [docs/usage.md](docs/usage.md)。

## 记忆治理与编辑

- `/记忆 列表 [关键词]` 按 kind 分组分页列出活跃事实（每页 20 条）；`/记忆 改 <id> <内容>` 用新 id 生效新内容，旧条标记 `superseded` 并保留审计。
- `/记忆 治理 --dry-run` 只出报告：重复（Jaccard ≥ 0.92）、冲突（同 subject + predicate）、过期（R < 0.05）、敏感条目；去掉 `--dry-run` 才真正应用。
- 应用**只降级、不物理删除**：重复项标 `superseded`（保留可回溯），敏感命中标 `sensitive=1` 并移出 FTS 召回；治理与编辑都写审计事件。
- 模型侧用 `memory_update` 修改记忆，语义与 `/记忆 改` 相同；`subagent` 会话不可写。

## 承诺跟进与轻闲聊

- 到期且未完成的 **commitment** 提醒，会在 reminders tick 内每天至多跟进 1 次；安静时段只积压，时段结束后补发一次（不会丢），已完成/已删除的不再打扰。
- **轻闲聊**是低频主动消息：需同时满足「闲聊开启、非安静时段、当日有过互动、非周末、距上次 ≥ 3 天、当日 ≤ 1 条、最近 7 天 ≤ 3 条」，内容限定为 5–10 句陈述句且经过违禁词过滤；任一条不满足就不发送。
- `/别闲聊` 关闭、`/恢复闲聊` 恢复，开关写入数据库，重启后仍生效。闲聊与提醒共用 `proactiveDailyCap` 与安静时段。

## 失败自愈

- **巩固失败**：写入 `consolidations` 失败行并按 1/2/4 tick 退避重试，最多 3 次；重试复用同一行，成功后正常推进水位，最终失败写 `consolidation_failed_final`。凭据缺失（`MISSING_CREDENTIAL`）不重试，避免无意义调用。
- **定时任务失败**：写 `job_error` 并在次日 17:03 重试（`job_retry`）；重启后会从历史失败态恢复。备份失败不再被吞掉，交由调度器记账并在次日重试。
- **数据库繁忙**：事务入口对 `SQLITE_BUSY` 最多重试 3 次（5–25ms 线性抖动、上限 50ms），非 BUSY 错误原样抛出。
- `/状态` 末尾会显示「最近失败 / 最近重试 / 最近 job 失败」，便于判断自愈是否在推进。

## 导出、恢复与加密

- `/记忆 导出 [md|json]` 把活跃事实、情景、提醒、线程与状态板写到 `.data/export/memory-YYYY-MM-DD-HHmm.<fmt>`（UTC 时间戳），回显各表条数与路径。默认**不导出** `secret`/`sensitive`、墓碑与被取代条目；状态板若引用了未导出事实的原文，会按行剔除。
- 恢复用 `importAll({ store, file, mode })`：`fresh` 要求目标库五表为空（适合换机器或重建），`merge` 按主键跳过已存在行、不覆盖本地内容；整个导入在单事务内，失败零落库；恢复后自动重建 FTS。
- 加密导出面向单条事实：`node scripts/export-encrypted.mjs <db> <fact-id> --out <file>`；解密用 `node scripts/decrypt-encrypted.mjs <file> [--out <json>]`。口令**只从 stdin 读取**（TTY 关闭回显），不会出现在命令行、日志或文件名里；空口令、缺参数直接退出 1，解密成功后才写目标文件。
- 加密格式为 AES-256-GCM + scrypt（N=2^14、r=8、p=1），每次随机 salt/iv，magic `DSH-COMPANION-EXPORT-1`；错误口令与损坏文件统一报「解密失败（口令错误或文件损坏）」。
- 细节与示例见 [docs/usage.md](docs/usage.md#导出恢复与加密)。

## 向量召回（可选）

- 默认关闭（`vector.enabled: false`），检索走 v0.2.0 的 bigram FTS 路径，结果与旧版逐字节一致，且不读向量表。
- 开启后 `hybridSearch` 用 RRF（`1/(60+rank)`）融合 FTS 与向量两路并去重；向量路只召回 active、normal、未删除、非 `sensitive/secret` 且 R ≥ 0.05 的事实。
- `vector.embedder` 目前只有 `hash`（字符 bigram → FNV-1a → 桶 → L2 归一）与 `none`（退化）。**`hash` 是语义近似，不是真实 embedding**，中文同义改写召回有限；真实 embedding 留待 P3。
- 开启后 `/状态` 显示「向量：开·dim 256·最近命中 N」；离线对比可跑 `node scripts/bench-vector.mjs`。
- 旧库升级到 schema v5 不会自动补向量：旧事实在下一次写入 / 编辑 / 强化时重建投影，期间开启向量只是召回不到它们，不会报错。

## 记忆与遗忘

- 工作记忆按 32K 装配；连续两轮超过 24K 触发巩固，40K 为安全阀，压缩保留最近 6,144 token。
- 检索使用 bigram FTS 与遗忘曲线四档（full / gist / index / dormant）；开启 `vector.enabled` 时再融合可选的哈希向量召回（见上节）；同一轮只注入一次召回，且末条是工具结果时不注入。
- `/记忆 忘掉` 只做标记（S1）；7 天冷静期内仍可恢复，到期由每日 03:30 的清理任务物理删除。
- 被遗忘、被取代或标记为 secret 的内容不会被召回；此时珞然会直接说「不记得了」，不编造。
- 每日 03:00 的 deep-sleep 执行睡眠期巩固（有模型时）、遗忘降级、FTS 孤儿 GC 与状态板 staged 重渲染，并写审计。

## 已知限制

- **FTS 为 bigram 近似**：没有分词器或同义词，召回依赖字面 bigram 与时间衰减；同义改写可能召回不到（可选向量召回可缓解，但见下条）。
- **向量召回非生产质量（默认关闭）**：`hashEmbed` 是字符 bigram 哈希投影，不是真实 embedding，中文语义召回有限；仓库 bench 的 100%/100%/100% 属合成数据自评口径。离线环境无真实 embedding，`vector.embedder` 仅支持 `hash`/`none`，接入真实 provider 留待 P3。
- **加密导出 header 未参与认证（L1）**：JSON header（含 KDF 参数、salt/iv/tag）未用 `setAAD` 绑定；篡改 KDF 参数只会导致解密失败，但 `id`/`created_at` 可被伪造，鲁棒性依赖 magic 与算法白名单。计划在 P3 用 AAD 加固。
- **导出文件同分钟覆盖（L3）**：文件名时间戳精确到分钟，同一分钟内重复导出会覆盖同名文件；不影响恢复语义。
- **导出 schema_version 兜底（L2）**：store 没有 `getMeta` 时导出文件会标注 `'4'`（当前实际为 `'5'`），仅影响文档性字段。
- **无跨设备备份**：数据库只在本机；backup 任务只在本机按日期滚动保留 7 份。需要搬移时用 `/记忆 导出` 与 `importAll`（见「导出、恢复与加密」）。
- 平台管理的会话 JSONL 不在插件控制范围内，插件无法删除。
- **单人模型**：主会话与线程按 `scope` 隔离（线程为 `thread:<key>`），但仍是单人使用，不是多人协作。
- **task_run 串行**：worker 全局单槽、忙时排队至多 2 个；软超时 600s 只告警，硬超时 900s 两段式取消（先中止当前轮、再清空排队）。熔断或 RSS 降级时 `task_run` 会在入队前被拒绝（`daily_budget_exceeded` / `memory_pressure`）。
- **预算/内存保护固定阈值**：每日 3M token 与 RSS 2.95/3.0/3.15GiB 三档不可配置；RSS warn 只记 metric，stop_dispatch 起才停派发；保护读数读取失败时按 `ok` 放行，不会因此中断会话。
- **自愈重试受调度 tick 约束**：巩固重试与轻闲聊都挂在 idle-probe（60s）上；熔断或 RSS ≥ stop_dispatch 期间重试会被顺延（事件与失败态保留，只是延后），恢复后继续推进。
- **subagent 仍见全局人格段**：平台的 system prompt 段没有 per-session 文本；插件只能让 subagent 跳过召回、巩固与写库，无法移除人格 / 记忆提示段。
- **schema v4 迁移清空 consolidations**：seq 语义切换为 surface 位置序时，开发期迁移会清空 `consolidations` 并重置 `episodes.consolidation_id`；事实、提醒与状态板不受影响。
- **schema v5 不补旧向量**：v4→v5 只推进版本并建 `fact_vectors`，不动数据；旧事实在下次写入 / 编辑 / 强化前不会被向量召回（不报错）。
- deep-sleep 的「情景→语义」模型抽取尚未实现，MVP 只做规则子步。

## 隐私

所有记忆存在本机 SQLite，不上传到第三方；主动消息受安静时段、每日上限、同类去重与积压上限约束。导出默认剔除 `secret`/`sensitive` 与墓碑；加密导出用 AES-256-GCM，口令只在本机从 stdin 读取、不落盘。平台侧会话记录由 DSH 管理。

## 开发与测试

```bash
cd dsh-companion
node --test            # 全量：单测 + e2e
node --test test/e2e   # 只跑端到端
```

插件入口为 `src/index.js`：`apply(ctx, config)` 注册人格段、`agent/pre-step` 记忆管线、命令、工具与调度器，返回 `{ dispose }`；同一 ctx 重复 apply 幂等。

## 设计与评审文档

- [使用手册](docs/usage.md)
- [平台 API 摘录](docs/platform-api.md)
- [Gate 0 探针说明](docs/gate0-probe.md)
- [安装自检与校准](docs/calibration.md)
- [外部评审报告 v1](docs/review-v1.md)
- [v0.1.1 关闭核验](docs/review-v2.md)
- [P1 批复审（v0.2.0）](docs/review-v3.md)
- [P2 批复审（v0.3.0）](docs/review-v4.md)
- [变更记录](CHANGELOG.md)
