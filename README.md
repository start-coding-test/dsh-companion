# dsh-companion

> 珞然：给一个人的长期记忆管家。单主会话 + 少量线程，记忆留在本机，不跨设备同步。

`dsh-companion` 是 DeepSeek Harness（DSH）的私人管家记忆插件：把对话沉淀为事实、提醒与线程，按遗忘曲线检索，并在合适的时间主动提醒。插件通过平台注入的服务工作，不直接依赖 DSH 内部包。

当前状态：**v0.4.6 已发布**（2026-11-05）。`node --test` 全绿：789 个用例 / 16 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三时区）。

## v0.4.6 变更摘要

- **提醒投递签名与用户消息污染（C5-H1a）**：`prompt(request, signal)` 第二参固定为 `AbortSignal.timeout(30000)`；提醒/承诺/闲聊带稳定 `requestId`，同一 claim 重试复用。被宿主记成 `user/message` 的提醒按 `rpcId` 前缀或 `[提醒]` 前缀识别，不重绑主会话、不进巩固、不喂召回查询；投递失败写 `delivery_error`，`/状态` 显示「最近失败：投递失败：…」，同一原因只 warn 一次。
- **线程服务改用公开方法名（C5-H1b）**：适配层改用 `sessionController.create` / `resolveAgent`，不再调用内部 `createSession`；能力探测、`thread_run` / `task_run` 投递与 `whenIdle` 同步到公开面。
- **巩固模型解析（C5-H2）**：不再永久缓存首次 `null`；每次重新确认动态能力位，成功路由缓存 5 分钟、失败不缓存，llm 晚注册后巩固可恢复。`/状态` 显示「巩固：<provider>/<model>（配置|自动选取）」/「宿主注入模型（宿主注入）」/「无可用模型」，无模型时按 60s 节流记失败事件；provider/model 发现失败升为 `warn` 并按原因去重；发布门新增 round C。
- **压缩开关、日志与 `/线程` 提示（C5-M1/M2/L1）**：`/状态` 明确显示压缩是否开启与待压缩区间数，文档给出 `compaction-basic` 的 `disabled: false` + `auto: false` 写法；巩固跳过由 `debug` 升为 `warn` 并去重；宿主无 `sessionController` 时 `/线程` 直接返回「线程：宿主不支持」。
- **复审**：发布前独立复审 pass（H=0 / M=0 / L=1，Low 项已随发布修完），见 [docs/review-v11.md](docs/review-v11.md)。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.5 变更摘要

- **提醒投递不再卡 `delivering`（V4-H1）**：队列键固定为 `reminder:<id>`，安静时段/日上限/退避期间不会堆出多份；提醒不参与文本合并，投递前逐份判定；失败按 30s → 60s 退避（第 1/2 次），第 3 次才 `expired`，启动回收崩溃残留的 `delivering`。
- **inject 形状校验点名到字段（V4-L1）**：`patch.inject` 的每个元素校验 `id` / `role` / `content` / `source.kind`，不合法抛 `TypeError` 并以 `onPreStep "inject"[i]` 点名；合法召回消息原样通过。
- **召回词法门槛与 2 字实体（V4-M1）**：`recall.minQueryChars` 默认 2（此前写死 4），2–3 字 CJK 实体可召回；非空查询需 ≥2 个有效 bigram 命中或 ≥30% 命中比例，停用 bigram 不计入；纯寒暄/短查询在读库前短路。
- **召回块经压缩摘要回流（V4-L2）**：召回块带 `[相关记忆] … [/相关记忆]` 成对标记，巩固窗口与转录整段剔除、标记不全时保守保留；提示词明确不得据此新建事实，残余风险与结论见 [docs/recall-compaction.md](docs/recall-compaction.md)。
- **复审**：发布前独立复审 pass（H=0 / M=0 / L=2，Low 项已随发布修完），见 [docs/review-v10.md](docs/review-v10.md)。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.4 变更摘要

- **召回注入改为完整平台消息（V3-H1）**：带 `id` / `role: 'user'` / `content` / `source.kind='companion-recall'`，修复真机 `reading 'kind'` 崩溃；`mergeDecision` 校验形状，巩固与转录排除召回块。召回块随会话保留到下一次压缩，忘掉后压缩前仍可能可见（见 [docs/platform-api.md](docs/platform-api.md) §2.1.1）。
- **提醒两阶段投递（V3-H2）**：claim → `delivering`，成功才 `fired` 且同一 fireKey 只发一次；失败回 `pending` 保留 `last_fire_key`，≥3 次 `expired`；启动回收 `delivering`。schema 升至 v10（旧库自动升级）。
- **主会话重绑（V3-M2）**：新增 `session.mainBinding`（默认 `latest-user`）；只有线程外会话出现真实用户输入才重绑，runtime-context / 召回 / 命令提示不算输入；`/状态` 显示「主会话：<id>（绑定 <mode>）」，提醒投递到该会话。
- **线程能力门控（V3-H3②）**：宿主没有 `sessionController`（headless / one-shot / SDK）时不注册 `thread_list` / `thread_run` / `task_run`，`/状态` 显示「线程：宿主不支持」；desktop profile 组合 web-app，能力齐全。
- **服务访问与回收（V3-M1）**：声明服务改走属性访问，未声明服务仍 `ctx.get()`；dispose 后再 apply 不会重复注册。
- **召回相关性门槛（V3-M3）**：短查询/小聊跳过，候选需 FTS/bigram 命中或向量 ≥ `recall.minVectorScore`（默认 0.35）；新增非枚举 `recall.*` 配置（见 [docs/usage.md](docs/usage.md)）。
- **编辑重抽（V3-M4）**：`/记忆 改` 重抽 `object_text` 并在同一事务重建 FTS/向量，旧行 `superseded`。
- **日志与中文命令提示（V3-L1/L3）**：headless 镜像默认只到 `info/warn/error`（`DSH_COMPANION_MIRROR_DEBUG=1` 带 debug）；宿主只注册 ASCII 命令名，误输入中文命令时回一句 ASCII 提示。RSS 文档档位改为按自检值下调（V3-L2）。
- **复审**：发布前独立复审 pass（H=0 / M=0），见 [docs/review-v9.md](docs/review-v9.md)。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.2 变更摘要

- **S0 只按「真正用上」标定（S2-M1 / L2-1）**：`used` 在用上那一刻单独记录 `first_used_at` / `first_used_tier` / `used_same_context`，不再沿用首次注入的时间与标记；same_context 在用上时重新判定，same_context 的 used 可被后续非 same_context used 覆盖一次；`first_reneed_*` 保留为 recall 对照。Δt 与 6h 判定统一用 `observed_at`（原话时间）。schema 升至 v9（见 [docs/s0-calibration.md](docs/s0-calibration.md)）。
- **回填独立超时与单飞（E2-M1 / L2-3）**：新增 `vector.backfillTimeoutMs`（默认 30000），查询仍用 `vector.embedTimeoutMs`（默认 300）；`vector.backfillBatchSize` 默认 8；推理单飞，超时批次未结束前不再起新批；查询遇忙立即回退 FTS；加载单飞复用同一 promise。`/状态` 增加「回填超时 / 占用」计数（见 [docs/embedding.md](docs/embedding.md)）。
- **v0.4.1 用例数修正（L2-2）**：按标签实测 v0.4.0 为 626、v0.4.1 为 646，CHANGELOG 的「639 → 646」更正为「626 → 646」。
- **复审**：v0.4.2 发布前独立复审 pass（H=0 / M=0），见 [docs/review-v8.md](docs/review-v8.md)；复审提出的 M-1 与 L-1/L-2/L-4 已在发布前修完。v0.4.1 及更早变更见 [CHANGELOG](CHANGELOG.md)，未做项与真机联调清单见 [docs/known-debt.md](docs/known-debt.md)。

## v0.4.1 变更摘要

- **local embedding 限时与异步预热（E-M1）**：加载等待与推理都受 `vector.embedTimeoutMs`（默认 300）约束，超时本轮回退纯 FTS、不向用户抛错；启动与 idle-probe 异步预热，不阻塞首个 turn；缺依赖（`Cannot find module`）fatal 停用 local，网络/超时/初始化失败 transient 指数退避（见 [docs/embedding.md](docs/embedding.md)）。
- **S0 只统计「用上」（S-M1）**：`reneed_kind` 增加 `used`（下一轮复述重叠 ≥0.6 才从 `recall` 升级），`same_context=1` 的同会话即时召回默认排除，避免把「被注入」当「被需要」；schema 升至 v8，旧库自动升级（见 [docs/s0-calibration.md](docs/s0-calibration.md)）。
- **确认词长度上限（L-2）**：去掉标点/空白后超过 10 字不再算确认，「对，我明天要去北京开会，顺便……」不再触发 α=4 强化。
- **复审**：v0.4.1 发布前复审 pass，见 [docs/review-v6.md](docs/review-v6.md)；v0.4.0 及更早变更见 [CHANGELOG](CHANGELOG.md)，本轮未做项与真机联调清单见 [docs/known-debt.md](docs/known-debt.md)。

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

> 以上仅为示例，**尚未写入用户 profile**；`name: 'dsh-companion'` 走包名解析，只在插件已作为包安装、能被 Node 解析到时成立。改完重载 profile 生效。

本地开发直接引用仓库时，`name` 必须指到**入口文件 `src/index.js`**，不能只指仓库目录：

```yaml
- insert:
    - id: dsh-companion
      # 绝对路径；也可写相对 patch 文件所在目录的路径（./dsh-companion/src/index.js）或 file:// URL
      name: 'D:/path/to/dsh-companion/src/index.js'
      config:
        dbPath: ./.data/companion.db
```

DSH 会把 `name` 转成 `file://` URL 再动态 import：绝对路径按 `pathToFileURL` 转换，`./` 开头按 `cordis.patch.yml` 所在目录锚定，`file://` URL 原样使用，三种写法指向同一个入口文件即可。**不要指向目录**（如 `D:/path/to/dsh-companion`）：ESM 不做目录解析，会抛 `ERR_UNSUPPORTED_DIR_IMPORT`（`Directory import '...' is not supported resolving ES modules`），插件不激活；`package.json` 的 `main`/`exports` 只对包名解析生效，不能把目录变成可导入的入口。入口注册内容见「开发与测试」。

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
| `rssWarnGiB` | `2.95` | RSS warn 阈值（GiB），只记指标 | `> 0` 且 `< rssStopGiB` |
| `rssStopGiB` | `3` | RSS 停 `task_run`/主动消息的阈值（GiB） | `> rssWarnGiB` 且 `< rssMainOnlyGiB` |
| `rssMainOnlyGiB` | `3.15` | RSS 仅主会话的阈值（GiB） | `> rssStopGiB` |
| `vector.enabled` | `false` | 是否启用可选向量召回 | 布尔；默认关闭 |
| `vector.dim` | `256` | 向量维度（`hashEmbed` 桶数） | 整数 `8`–`4096` |
| `vector.embedder` | `"hash"` | 向量化实现 | `hash` / `local` / `remote` / `none`；详见 [docs/embedding.md](docs/embedding.md) |
| `vector.localModel` | `"Xenova/bge-small-zh-v1.5"` | local 模型 id（需可选安装 `@huggingface/transformers`） | 非空字符串 |
| `vector.prefixQuery` | `true` | local 查询是否加中文检索指令前缀 | 布尔 |
| `vector.embedderId` | `""` | remote 的向量 id；空则用 `remote:<host>` | 非空字符串或空串 |
| `vector.embedTimeoutMs` | `300` | 查询侧 embedding 超时（毫秒）；local 同时覆盖「等待加载」与查询推理 | 整数 `1`–`60000` |
| `vector.backfillTimeoutMs` | `30000` | 回填推理的独立超时（毫秒），不影响查询 | 整数 `1`–`600000` |
| `vector.remote.enabled` | `false` | remote 必须显式开启；开启后原文会发到第三方 | 布尔 |
| `vector.remote.endpoint` | `""` | remote embedding 端点 | 开启时必须是 `http(s)` URL |
| `vector.remote.apiKeyEnv` | `""` | 读取 API key 的环境变量名 | 非空字符串或空串 |
| `vector.remote.timeoutMs` | `300` | remote 超时；缺省继承 `embedTimeoutMs` | 整数 `1`–`60000` |
| `vector.backfillBatchSize` | `8` | idle-probe 每批回填条数 | 整数 `1`–`50` |
| `recall.minVectorScore` | `0.35` | 向量候选的相关性下限；低于且无 FTS/bigram 命中即丢弃 | 数字 `0`–`1` |
| `recall.skipSmallTalk` | `true` | 长度 <4、纯算术/符号与常见问候跳过召回 | 布尔 |
| `session.mainBinding` | `"latest-user"` | 主会话绑定策略：`latest-user` 跟随最新真实用户会话，`first` 保持首个主会话 | `latest-user` / `first` |

token 四档必须满足 `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens`；RSS 三档必须满足 `0 < rssWarnGiB < rssStopGiB < rssMainOnlyGiB`。未知配置键只记警告，不阻断启动。v0.3.0 起新增可选的 `vector.*`（默认关闭），v0.4.0 扩展为 `hash` / `local` / `remote` / `none` 与 remote 端点配置，v0.4.2 新增 `vector.backfillTimeoutMs` 并把 `backfillBatchSize` 默认降到 8；`DEFAULTS.vector` 不可枚举，首次安装自检仍按 16 个基础键输出（含 RSS 三档）。v0.4.4 起新增非枚举的 `recall.*` 与 `session.mainBinding`，同样不参与 16 键安装自检。治理/编辑、承诺跟进、轻闲聊与失败自愈仍由既有配置与固定阈值控制。

**宿主压缩能力（compaction-basic）**：插件通过宿主的 `compaction.compactRegion` 服务压缩上下文，压缩后由水位重锚接管。DSH web-app 默认把 `compaction-basic` 设为 `disabled: true`，插件拿不到该能力，`/状态` 会显示「压缩：宿主未开启（compaction-basic 未启用）」：巩固照常写库，但 `pending_compact` 只保留区间，surface 不会真正缩小。云端已验证的开启写法（写进 `cordis.patch.yml`，不是本插件的 config）：

```yaml
- id: compaction-basic
  disabled: false
  config:
    auto: false
```

`auto: false` 表示宿主不再每轮自动压缩，只由插件在空闲边界（`idleMs`，默认 30 分钟）调用 `compactRegion`，避免与巩固抢时机。开启后 `/状态` 显示「压缩：宿主已开启（compaction-basic 已启用）」，有待压缩区间时附「，待压缩 N 个区间」。

**主会话绑定（v0.4.4）**：默认 `session.mainBinding: 'latest-user'`——只有当**线程外**会话出现真实用户输入时才把 `main_session_id` 重绑到该会话，并记一条 info 日志（旧/新 id）；runtime-context、召回注入与中文命令提示都不算用户输入，不会触发重绑。`'first'` 保持原主会话不变。提醒投递到当前主会话，`/状态` 会显示「主会话：<id>（绑定 <mode>）」。

所有墙上时间判断（安静时段 `quietStart`/`quietEnd`、每日 `03:00`/`03:30`/`04:00` 任务、日界线与备份文件名）一律按 `timezone` 计算，与进程环境变量 `TZ` 无关。

**外部压缩自动重锚**：平台或用户 `/compact` 压缩掉当前水位节点后，下一次 pre-step 会按 surface 位置把水位重锚到替换节点之后；如果压缩越过了旧水位（有尚未巩固的内容被平台摘要吞掉），锚点会前挪到替换节点之前，让这段摘要进入下一次巩固，不会静默停摆、也不会永久丢掉未巩固内容。重锚值写入 `schema_meta`（锚到起点时写哨兵 `-1`，避免重启后回退旧水位）；`/状态` 显示「水位重锚：N 次」与「未巩固被压缩：N 个节点」。**R-L3 边界**：被压缩区间里尚未巩固的原始对话已经从 surface 消失，只能以平台摘要的形式进入记忆库；摘要没有保留的细节无法恢复，重要内容不要依赖外部压缩来保存。

**按 scope 的待压缩槽**：主会话与各线程各自持有待压缩区间（`pending_compact`），线程巩固不再覆盖主会话的待压缩目标。

**单执行槽**：`task_run` 与带 `goal` 的 `thread_run` 共用同一个执行槽；`thread_run` 会持槽到线程 `whenIdle`（900s 兜底），期间 `task_run` 只排队或返回 `busy`，不会并发出第二个执行态。create 分支直接使用会话句柄，reuse 反查失败与 900s 兜底都会写 `warn`，并记 `threadSlotFallback` / `threadSlotTimeout` 便于真机定位。

**每日 token 熔断**：按 `timezone` 的本地日界累计每日 token 用量，达到 `3,000,000` 后进入熔断：拒绝新的 `task_run`、暂停主动消息，`/成本` 与 `/状态` 会显示「已熔断」；本地日界翻篇自动复位。该上限固定为 3M，v0.4.0 仍不提供配置键。

**RSS 三档降级**：每 60 秒检查一次进程 RSS；三档阈值可配置（`rssWarnGiB` / `rssStopGiB` / `rssMainOnlyGiB`，默认 `2.95` / `3.0` / `3.15`GiB，须满足 `0 < warn < stop < mainOnly`）。`≥warn` 只记指标（不降级）、`≥stop` 停 `task_run` 与主动消息、`≥mainOnly` 再停线程创建；恢复后自动解除。4G 云端按自检公式 `min(userLimit, totalmem×0.75−512MiB)` 预算只有 2.5GiB，默认 3.0GiB 的 stop 可能晚于 OOM，建议把三档降到 `2.2` / `2.4` / `2.6`，**同时开 1–2GB swap**；不要超过总内存 75%（4GiB 即 3.0GiB）。公式与 4G 示例见 [docs/calibration.md](docs/calibration.md)，`/状态` 会显示当前生效的三档值。

## 首次安装自检

默认配置是 32K 工作记忆；机器内存或模型上下文不同，建议先跑一次自检：

```bash
cd dsh-companion
node scripts/calibrate/run.mjs
```

它用临时 `DSH_HOME` 跑一次 headless，写出：

- `.data/calibration.json`：node/electron/dsh 版本、SQLite、CPU、内存、RSS 中位、
  `tokenMeter` 节点数、contextWindow 来源与建议值；
- `.data/config.suggested.yml`：16 个基础配置键的建议值（含按内存预算缩放的 RSS 三档；不含默认关闭的 `vector.*`），头部带 `generated_at` 与
  `source`（node/electron/dsh/rss_median）。

自检**不会**自动合并配置、不会写人格卡或记忆库；核对后把需要的键复制到
`config.yml`。也可以手动把 `scripts/calibrate/calibrate.patch.yml` 叠加到 profile。
公式、告警线（`min(user, totalmem×0.75−512MB)`）、15% 误差口径与平台限制见
[docs/calibration.md](docs/calibration.md)。

示例配置与人格卡见 `config.example.yml`、`persona.example.md`。

## 命令与工具

命令：`/记忆`（`列表 [关键词]`、`忘掉`、`改 <id> <内容>`、`治理 [--dry-run]`、`导出 [md|json]`、`置顶`、`取消置顶`）、`/成本`、`/线程`、`/状态`、`/别闲聊`、`/恢复闲聊`。

**宿主只注册 ASCII 命令名。** DSH 的命令名正则只接受 `^[a-z][a-z0-9_-]*$`，所以插件实际注册的是 `memory`、`cost`、`threads`、`status`、`chat-off`、`chat-on`；`/记忆`、`/状态`、`/成本`、`/线程` 只是同一功能的别名提示，直接输入中文命令**不会**被执行。误输入时 pre-step 会回一句「请用 /memory、/status、/cost、/threads」，请改用 ASCII 命令名（参数写法不变，例如 `/memory 忘掉 <id>`）。

工具（宿主提供 `sessionController` 时 10 个）：`memory_search`、`memory_write`、`memory_update`、`memory_forget`、`reminder_add`、`reminder_done`、`thread_list`、`thread_run`、`task_run`、`cost_report`。宿主没有 `sessionController`（例如 headless / one-shot bundle）时**不注册** `thread_list`、`thread_run`、`task_run`，`/状态` 会显示「线程：宿主不支持」；其余工具不受影响。

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

- `/记忆 导出 [md|json]` 把活跃事实、情景、提醒、线程与状态板写到 `.data/export/memory-YYYY-MM-DD-HHmmss.<fmt>`（UTC 秒级时间戳），回显各表条数与路径；同一秒内重复导出自动追加 `-2`、`-3`，不会覆盖已有文件。默认**不导出** `secret`/`sensitive`、墓碑与被取代条目；状态板若引用了未导出事实的原文，会按行剔除。
- 恢复用 `importAll({ store, file, mode })`：`fresh` 要求目标库五表为空（适合换机器或重建），`merge` 按主键跳过已存在行、不覆盖本地内容；整个导入在单事务内，失败零落库；恢复后自动重建 FTS。
- 加密导出面向单条事实：`node scripts/export-encrypted.mjs <db> <fact-id> --out <file>`；解密用 `node scripts/decrypt-encrypted.mjs <file> [--out <json>]`。口令**只从 stdin 读取**（TTY 关闭回显），不会出现在命令行、日志或文件名里；空口令、缺参数直接退出 1，解密成功后才写目标文件。
- 加密格式为 AES-256-GCM + scrypt（N=2^14、r=8、p=1），每次随机 salt/iv，magic `DSH-COMPANION-EXPORT-1`；`header.format = "v2"` 起 header 与 magic 一起参与 AAD 认证，改任一项都解密失败；`v1` 旧文件仍可解（不校验 AAD）。错误口令、损坏文件与认证失败统一报「解密失败（口令错误、文件损坏或认证失败）」。
- 细节与示例见 [docs/usage.md](docs/usage.md#导出恢复与加密)。

## 向量召回（可选）

- 默认关闭（`vector.enabled: false`），检索走 v0.2.0 的 bigram FTS 路径，结果与旧版逐字节一致，且不读向量表。
- 开启后 `hybridSearch` 用 RRF（`1/(60+rank)`）融合 FTS 与向量两路并去重；向量路只召回 active、normal、未删除、非 `sensitive/secret` 且 R ≥ 0.05 的事实。
- `vector.embedder` 支持 `hash`（默认，字符 bigram 哈希，零依赖但非语义）、`local`（可选依赖 `@huggingface/transformers`，默认 `Xenova/bge-small-zh-v1.5` 512 维 int8）、`remote`（默认关闭，显式 `vector.remote.enabled: true` 才启用；会把原文发到第三方，见 [docs/embedding.md](docs/embedding.md#remote)）与 `none`（等价关闭）。
- 向量按 `embedder_id` 隔离：换模型后旧向量不再参与召回；local/remote 的缺失向量由 idle-probe 分批回填（每批 ≤ `vector.backfillBatchSize`，默认 8；回填推理用独立的 `vector.backfillTimeoutMs`，默认 30s，查询仍用 300ms；同一 embedder 只允许一个推理在跑，遇忙跳过/回退 FTS）。
- 开启后 `/状态` 显示「向量：开·dim 256·hash:256·已回填 N·最近命中 N·回填超时 N·占用 N」；embedding 超时/未安装时退回 FTS 并记 `vectorEmbedFailures`，回填超时与推理占用分别记 `vectorBackfillTimeouts` / `vectorEmbedBusy`。
- 旧库升级到 schema v9 会补 `facts.first_reneed_*` 三列、`same_context` 与 `first_used_at` / `first_used_tier` / `used_same_context`（旧行相应为 NULL / 0）；v6 的向量迁移仍把旧向量行标成 `hash:<dim>`，hash 在下次写入/编辑/强化时重建，local/remote 由空闲回填补齐。

## 记忆与遗忘

- 工作记忆按 32K 装配；连续两轮超过 24K 触发巩固，40K 为安全阀，压缩保留最近 6,144 token。
- 检索使用 bigram FTS 与遗忘曲线四档（full / gist / index / dormant）；开启 `vector.enabled` 时再融合可选向量召回（见上节）；同一轮只注入一次召回，且末条是工具结果时不注入。
- 召回块以**平台消息**进入本批上下文并写进会话 surface（`source.kind = 'companion-recall'`）；它会随会话保留到下一次压缩，压缩后旧块才被替换。`/记忆 忘掉` 只影响之后的召回：**压缩前**模型仍可能看到旧块，回执不要说「已经彻底看不见」。
- `/记忆 忘掉` 只做标记（S1）；7 天冷静期内仍可恢复，到期由每日 03:30 的清理任务物理删除。
- 被遗忘、被取代或标记为 secret 的内容不会被召回；此时珞然会直接说「不记得了」，不编造。
- 每日 03:00 的 deep-sleep 执行睡眠期巩固（有模型时）、遗忘降级、FTS 孤儿 GC 与状态板 staged 重渲染，并写审计。
- **评测埋点**：`facts.first_reneed_at` / `first_reneed_tier` / `reneed_kind` / `same_context` 记录首次再需要事件（召回 full/gist、去重命中沉睡/墓碑、用户纠正），作为 recall 对照与漏样本；`first_used_at` / `first_used_tier` / `used_same_context` 在用上那一刻单独记录「首次非 same_context 的用上」，same_context 的 used 可被后续非 same_context used 覆盖一次。Δt 与 same_context 均以 `observed_at` 起算。schema v9 起写入，流程见 [S0 标定](docs/s0-calibration.md)。

## 已知限制

- **FTS 为 bigram 近似**：没有分词器或同义词，召回依赖字面 bigram 与时间衰减；同义改写可能召回不到（可选向量召回可缓解，但见下条）。
- **向量召回默认关闭且效果取决于 embedder**：`hash` 只是字符 bigram 哈希投影，不是语义 embedding；`local` 需要可选安装 `@huggingface/transformers` 并首次联网下载模型；`remote` 会把原文发到第三方（隐私例外见 [docs/embedding.md](docs/embedding.md)）。`vector.embedder` 已支持 `hash`/`local`/`remote`/`none`，任一实现失败都会退回 FTS。
- **local 查询受 `vector.embedTimeoutMs`、回填受 `vector.backfillTimeoutMs` 约束**：查询与首次加载等待每轮最多 300ms，超时即本轮退回纯 FTS、不向用户报错；回填默认每批 8 条、最多等 30s，超时只截断等待、底层推理未结束前不会再起新批。模型在启动与 idle-probe 异步预热，加载与推理都单飞，重试复用同一加载 promise；查询遇回填占用立即回退 FTS。缺可选依赖会停用 local（fatal），网络/初始化等临时失败按 1/2/4/8s 退避、第 5 次后冷却 60s 再试，不会永久关闭（见 [docs/embedding.md](docs/embedding.md#local-的超时与异步预热e-m1)）。
- **旧加密文件（v1）不认证 header**：v0.3.0 及更早版本导出的密文没有 AAD 绑定，`id`/`created_at` 等 header 字段仍可被伪造；新文件（`format: "v2"`）已认证。需要时可解密后用同一口令重新导出。
- **无跨设备备份**：数据库只在本机；backup 任务只在本机按日期滚动保留 7 份。需要搬移时用 `/记忆 导出` 与 `importAll`（见「导出、恢复与加密」）。
- 平台管理的会话 JSONL 不在插件控制范围内，插件无法删除。
- **单人模型**：主会话与线程按 `scope` 隔离（线程为 `thread:<key>`），但仍是单人使用，不是多人协作。
- **task_run 串行**：worker 全局单槽、忙时排队至多 2 个；软超时 600s 只告警，硬超时 900s 两段式取消（先中止当前轮、再清空排队）。熔断或 RSS 降级时 `task_run` 会在入队前被拒绝（`daily_budget_exceeded` / `memory_pressure`）。
- **预算/内存保护**：每日 3M token 上限固定；RSS 三档可配置（`rssWarnGiB`/`rssStopGiB`/`rssMainOnlyGiB`，默认 2.95/3.0/3.15GiB，4G 机器建议 2.2/2.4/2.6 并开 1–2GB swap，公式见 [docs/calibration.md](docs/calibration.md)）。RSS warn 只记 metric，stop 起才停派发；保护读数读取失败时按 `ok` 放行，不会因此中断会话。
- **自愈重试受调度 tick 约束**：巩固重试与轻闲聊都挂在 idle-probe（60s）上；熔断或 RSS ≥ stop_dispatch 期间重试会被顺延（事件与失败态保留，只是延后），恢复后继续推进。
- **subagent 仍见全局人格段**：平台的 system prompt 段没有 per-session 文本；插件只能让 subagent 跳过召回、巩固与写库，无法移除人格 / 记忆提示段。
- **schema v4 迁移清空 consolidations**：seq 语义切换为 surface 位置序时，开发期迁移会清空 `consolidations` 并重置 `episodes.consolidation_id`；事实、提醒与状态板不受影响。
- **schema v5→v6 不丢向量**：v5→v6 只给 `fact_vectors` 增加 `embedder_id` 并把旧行标成 `hash:<dim>`，不删数据；换 embedder 后旧向量按 id 隔离，由写入或空闲回填重建。
- deep-sleep 的「情景→语义」模型抽取尚未实现，MVP 只做规则子步。

## 隐私

所有记忆存在本机 SQLite，不上传到第三方；主动消息受安静时段、每日上限、同类去重与积压上限约束。导出默认剔除 `secret`/`sensitive` 与墓碑；加密导出用 AES-256-GCM，口令只在本机从 stdin 读取、不落盘。平台侧会话记录由 DSH 管理。**例外**：显式开启 `vector.embedder: remote` 后，回填的事实原文与召回查询会发往配置的第三方 embedding 端点；敏感/secret/墓碑事实不会进入回填批次，但第三方侧的留存不受本插件 7 天删除约束。

## 开发与测试

```bash
cd dsh-companion
node --test            # 全量：单测 + e2e
node --test test/e2e   # 只跑端到端
```

插件入口为 `src/index.js`：`apply(ctx, config)` 注册人格段、`agent/pre-step` 记忆管线、命令、工具与调度器，返回 `{ dispose }`；同一 ctx 重复 apply 幂等。

## 设计与评审文档

- [使用手册](docs/usage.md)
- [Embedding 可插拔（W4）](docs/embedding.md)
- [S0 标定流程](docs/s0-calibration.md)
- [已知技术债与真机联调清单](docs/known-debt.md)
- [平台 API 摘录](docs/platform-api.md)
- [Gate 0 探针说明](docs/gate0-probe.md)
- [安装自检与校准](docs/calibration.md)
- [外部评审报告 v1](docs/review-v1.md)
- [v0.1.1 关闭核验](docs/review-v2.md)
- [P1 批复审（v0.2.0）](docs/review-v3.md)
- [P2 批复审（v0.3.0）](docs/review-v4.md)
- [v0.4.0 发布前复审（v0.3.2 修复核验）](docs/review-v5.md)
- [v0.4.1 发布前复审（E-M1 / S-M1+L-2 修复核验）](docs/review-v6.md)
- [v0.4.2 发布前复审（S2-M1 / E2-M1 / L2 修复核验）](docs/review-v8.md)
- [变更记录](CHANGELOG.md)
