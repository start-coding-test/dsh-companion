# dsh-companion

> 珞然：给一个人的长期记忆管家。单主会话 + 少量线程，记忆留在本机，不跨设备同步。

`dsh-companion` 是 DeepSeek Harness（DSH）的私人管家记忆插件：把对话沉淀为事实、提醒与线程，按遗忘曲线检索，并在合适的时间主动提醒。插件通过平台注入的服务工作，不直接依赖 DSH 内部包。

当前状态：**MVP 0.1.0**（2026-11-03），`node --test` 全绿（260 个用例 / 15 个套件），git tag `v0.1.0`。

## 目录结构

```text
dsh-companion/
├─ src/
│  ├─ index.js        # 插件入口：apply/dispose、生产接线、pre-step 主链路
│  ├─ config.js       # 配置默认值与校验
│  ├─ memory/         # store、bigram、retrieve、consolidate、state-board、assemble
│  ├─ persona/        # 人格卡与 system prompt 段
│  ├─ platform/       # DSH 适配层与 PlatformError
│  ├─ runtime/        # commands、tools、metrics、scheduler、proactive
│  ├─ task/           # 任务 worker 与回执
│  └─ thread/         # 线程目录（命名、上限、冻结）
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

token 四档必须满足 `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens`。未知配置键只记警告，不阻断启动。

所有墙上时间判断（安静时段 `quietStart`/`quietEnd`、每日 `03:00`/`03:30`/`04:00` 任务、日界线与备份文件名）一律按 `timezone` 计算，与进程环境变量 `TZ` 无关。

**每日 token 熔断**：按 `timezone` 的本地日界累计每日 token 用量，达到 `3,000,000` 后进入熔断：拒绝新的 `task_run`、暂停主动消息，`/成本` 与 `/状态` 会显示「已熔断」；本地日界翻篇自动复位。该上限固定为 3M，v0.1.1 不提供配置键。

**RSS 三档降级**：每 60 秒检查一次进程 RSS，`≥2.95GiB` 记 warn 指标（不降级）、`≥3.0GiB` 停 `task_run` 与主动消息、`≥3.15GiB` 再停线程创建；恢复后自动解除。阈值固定，v0.1.1 不提供配置键。

## 首次安装自检

默认配置是 32K 工作记忆；机器内存或模型上下文不同，建议先跑一次自检：

```bash
cd dsh-companion
node scripts/calibrate/run.mjs
```

它用临时 `DSH_HOME` 跑一次 headless，写出：

- `.data/calibration.json`：node/electron/dsh 版本、SQLite、CPU、内存、RSS 中位、
  `tokenMeter` 节点数、contextWindow 来源与建议值；
- `.data/config.suggested.yml`：13 个配置键的建议值，头部带 `generated_at` 与
  `source`（node/electron/dsh/rss_median）。

自检**不会**自动合并配置、不会写人格卡或记忆库；核对后把需要的键复制到
`config.yml`。也可以手动把 `scripts/calibrate/calibrate.patch.yml` 叠加到 profile。
公式、告警线（`min(user, totalmem×0.75−512MB)`）、15% 误差口径与平台限制见
[docs/calibration.md](docs/calibration.md)。

示例配置与人格卡见 `config.example.yml`、`persona.example.md`。

## 命令与工具

命令：`/记忆`、`/记忆 忘掉`、`/记忆 置顶`、`/记忆 取消置顶`、`/成本`、`/线程`、`/状态`。

工具：`memory_search`、`memory_write`、`memory_forget`、`reminder_add`、`reminder_done`、`thread_list`、`thread_run`、`task_run`、`cost_report`。

参数、返回与降级行为见 [docs/usage.md](docs/usage.md)。

## 记忆与遗忘

- 工作记忆按 32K 装配；连续两轮超过 24K 触发巩固，40K 为安全阀，压缩保留最近 6,144 token。
- 检索使用 bigram FTS 与遗忘曲线四档（full / gist / index / dormant）；同一轮只注入一次召回，且末条是工具结果时不注入。
- `/记忆 忘掉` 只做标记（S1）；7 天冷静期内仍可恢复，到期由每日 03:30 的清理任务物理删除。
- 被遗忘、被取代或标记为 secret 的内容不会被召回；此时珞然会直接说「不记得了」，不编造。
- 每日 03:00 的 deep-sleep 执行睡眠期巩固（有模型时）、遗忘降级、FTS 孤儿 GC 与状态板 staged 重渲染，并写审计。

## 已知限制

- **FTS 为 bigram 近似**：没有分词器、同义词或语义向量，召回依赖字面 bigram 与时间衰减；同义改写可能召回不到。
- **无向量检索**：MVP 不接 embedding，语义召回留待后续版本。
- **无跨设备备份**：数据库只在本机；backup 任务只在本机按日期滚动保留 7 份。
- 平台管理的会话 JSONL 不在插件控制范围内，插件无法删除。
- **单人模型**：主会话与线程按 `scope` 隔离（线程为 `thread:<key>`），但仍是单人使用，不是多人协作。
- **task_run 串行**：worker 全局单槽、忙时排队至多 2 个；软超时 600s 只告警，硬超时 900s 两段式取消（先中止当前轮、再清空排队）。熔断或 RSS 降级时 `task_run` 会在入队前被拒绝（`daily_budget_exceeded` / `memory_pressure`）。
- **预算/内存保护固定阈值**：每日 3M token 与 RSS 2.95/3.0/3.15GiB 三档不可配置；RSS warn 只记 metric，stop_dispatch 起才停派发；保护读数读取失败时按 `ok` 放行，不会因此中断会话。
- **subagent 仍见全局人格段**：平台的 system prompt 段没有 per-session 文本；插件只能让 subagent 跳过召回、巩固与写库，无法移除人格 / 记忆提示段。
- deep-sleep 的「情景→语义」模型抽取尚未实现，MVP 只做规则子步。

## 隐私

所有记忆存在本机 SQLite，不上传到第三方；主动消息受安静时段、每日上限、同类去重与积压上限约束。平台侧会话记录由 DSH 管理。

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
- [外部评审报告 v1](docs/review-v1.md)
- [变更记录](CHANGELOG.md)
