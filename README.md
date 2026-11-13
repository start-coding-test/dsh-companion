# dsh-companion

> 珞然：给一个人的长期记忆管家。单主会话 + 少量线程，记忆留在本机，不跨设备同步。

`dsh-companion` 是 DeepSeek Harness（DSH）的私人管家记忆插件：把对话沉淀为事实、提醒与线程，按遗忘曲线检索，并在合适的时间主动提醒。插件通过平台注入的服务工作，不直接依赖 DSH 内部包。

当前状态：**v0.7.0 已发布**（2026-11-13，tag `v0.7.0`，清单代号 v0.4.13）。`node --test` 全绿：1410 个用例 / 51 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三时区）。

## v0.7.0 变更摘要

- **每一分 token 都记账了**：模型调用按宿主的 usage 结算，六类来源分开入账、落库持久化，
  `/状态` 直接看今日用量与占比；日上限与 5 小时滑窗都可配。
- **额度紧张只停后台**：`quota.source: file` 读一份本地快照，低于预留线就暂停闲聊、非 hard 巩固与向量回填，
  主会话与你手动触发的压缩照常；429 也会退避而不是反复刷。
- **提醒不再是「说完就没了」**：支持每日/每周（含 INTERVAL/COUNT/UNTIL），送到后按原定序列推进，
  跨夏令时不漂移；过期没送到的，会在你下次说话时说一句。
- **压缩不再每轮空转**：记住「压缩底」并按轮次冷却，压不下去时在 `/状态` 明确告警并建议 calibrate。
- **记忆更克制**：注入与「真正用上」分开计数，召回了没用会降权；纯工具区间不再编造情景记忆；
  同主题的旧事实可以被新事实整条取代，而不是堆成一串同义句。
- **IM 信封不再冒充你说的话**：`<dsh_im_*>` 与插件通知会被识别并跳过，交互日、隐私提示、情绪判定与召回查询都用真实正文。
- **schema v15**：新增 `token_usage`，`facts`/`reminders` 补列，`kind` 与事件白名单扩容；迁移在 v14 fixture 上验证通过。

## v0.6.1 变更摘要

- **llm 模式的专属句能出现了**：判定成功后记下类型，下一轮借用一次（10 分钟内有效），说完即清；
  不在判定回调里改本轮情绪句，装配不会竞态。
- **情绪句不再指错人**：`REASSURE` 等句子用「对方」而不是「你」，四组句子都不含第二/第三人称。
- **llm 有单独入账阈值**：卡里 `emotion.appraiseMinConfidence`（默认 0.65，只影响 llm 来源）；
  规则路径仍是 0.5。判不出（`none`）不再写事件表，只进 `/状态` 统计。
- **预算按码点算，报告脚本能过网关**：优先用宿主 usage，缺失时码点 × 1.0；
  `emotion-report.mjs` 支持 `EMOTION_APPRAISE_SESSION` / `EMOTION_APPRAISE_HEADERS`。

## v0.6.0 变更摘要

- **判定交给模型、物理量留给代码**：卡里 `emotion.appraiser: "llm"` 时，情绪事件由一次严格的 JSON 判定产生（`{target,type,intensity,confidence}`），代码只负责衰减、节律、写库与那句话。默认仍是 `rules`，行为与 v0.5.2 一致。
- **不阻塞对话**：pre-step 只做衰减与描述就返回，判定在后台进行，结果下一轮生效；每个作用域最多 1 个在途 + 1 个排队，新句覆盖旧句。
- **失败有兜底**：非 JSON、枚举外、越界、超时、预算拒绝、没有模型，全回落 v0.5.2 规则；同一事件只入账一次。
- **可观测**：`emotion_events.note` 记 `llm` / `rules` / `rules:fallback:<原因>`，`/状态` 增「判定器」行（来源占比、平均与 p95 延迟、最近失败）。
- **评测**：`node scripts/emotion-report.mjs --appraiser llm --input test/fixtures/emotion-golden.jsonl`（端点 / 密钥 / 模型取环境变量），模型门槛 准确率 ≥80% / blame 误报 0 / 中性 ≤2/13 / 判定失败 0。



## v0.5.2 变更摘要

- **先判对象再判极性**：`src/persona/emotion-classify.js` 把负面话分成「冲着她」「用户自己在诉苦」「说第三方」「说事情」四类，只有第一类才可能是 `blame` / `conflict`。
- **`reassure`（被在意）**：「你是不是很烦我」「我烦你了吗」这类担心不再被判成指责或抱怨。
- **增量递减（V51-L1）**：越接近 0/100 推得越轻，10 分钟内同类事件第 2 次起再乘 `0.7^(k−1)`。
- **标注集与混淆矩阵**：207 句人工标注 + `emotion-report.mjs --confusion`；门槛 ≥85% / blame 误报 ≤2 / 中性误触发 ≤10%，当前 99.52% / 0 / 0%（样本内）。

## v0.5.1 变更摘要

- **节律不再每轮累加（V50-H1）**：昼夜节律与安静时段改为「目标偏移」——每轮按 `基线 + 节律 + 安静偏移` 衰减回归，只有事件增量才叠加。实测 11:00 连发 50 条中性消息，各维相对当轮目标最大偏差 0.555（验收线 ±2）；跨 72 小时每小时一条全程 38–52，不贴 0 也不贴 100。
- **区分「冲着她」与「用户诉苦」（V50-M1）**：事件类型 10 → 12，新增 `blame`（「你好烦」）与 `vent`（「今天加班好累」）；后者只小幅下调她自己的愉悦、下沉精力与掌控，并把状态句换成「有点心疼，先接住这份累」。
- **卡里的模板占位符与注释（V50-M2 / V50-L2）**：酒馆卡残留的 `{{random:…}}` / `{{time}}` 等一律降级为 `{random:…}` / `{time}`，HTML 注释在渲染前剥离；插件所有段统一 `interpolate: false`，避免宿主把卡文本当提示词变量插值导致整轮注入失败。
- **情绪句改走 `systemPrompt.context`（V50-M3）**：文本不变时宿主不再重复注入，情绪关闭或无该能力时不注册；旧快照只被 supersede、平台不删，已写进 `docs/emotion-injection.md`。
- **`/状态` 增「最近一次装配」（V50-L3）**：时间、部署人设状态、prefix 是否改写、各段字数与 8 位短哈希；只存内存、只记哈希不存正文。
- **一致性**：情绪关闭且卡里没有占位符与注释时，`persona:*` 三段与闲聊提示词与 v0.5.0 **逐字节一致**（独立 worktree 对比：三段 section 与两段闲聊提示词逐字节相等，长度 202/246/189）。schema 仍 **v14**。完整条目见 [CHANGELOG](CHANGELOG.md)（0.5.1 段），证据见 [docs/host-prompt-internals.md](docs/host-prompt-internals.md)、[docs/emotion-injection.md](docs/emotion-injection.md)。

## v0.5.0 变更摘要

- **P1 身份由人格卡驱动**：人格段不再写死「私人管家」，身份 / 性格 / 关系 / 说话方式全从卡读取；支持直接加载 Character Card V2/V3 的 JSON（`{{char}}` / `{{user}}` 只在渲染输出替换，`character_book` 忽略并 warn）。新增 `persona:voice`（order 95），core / voice 上限各 1200 码点，超长截断并返回诊断；`taboos` 为空时省略「禁区」整行。
- **P2 遮蔽宿主默认人设**：新增 `persona.shadowDeployment`（`off` 默认 / `rewrite` / `takeover`）。宿主 0.4.x 只有 `deployment:persona-prefix`(order 0) 与 `deployment:persona-suffix`(10200)，只能经 `system-prompt/assemble` 改写；`off` 时不注册监听。`/状态` 增「部署人设」行。
- **P3 情绪状态（默认关闭）**：卡里 `emotion.enabled=true` 才启用；PAD + 精力纯函数，半衰期默认 6h 回归基线、昼夜节律、安静时段联动；第一版规则评估（中文词典 + 10 类事件）不调模型；每轮注入一句「你此刻：…」（独立 user 消息、不含数字、不进 system）；schema **v14** 两表，重启不丢，「忘掉」重置，导出 / 导入覆盖两表。
- **P4 语气细节**：`memoryCitation`（`explicit` / `natural`）；闲聊提示词使用卡里的 `description`（非内置卡）与 `mes_example`；情绪启用时带状态句。
- **一致性**：内置卡 + 情绪关时，`persona:*` 三段与闲聊提示词与 v0.4.12 **逐字节一致**（基线 `test/fixtures/persona-v0412.json`，另有独立 worktree 对比复核）。
- **范围**：schema v14；记忆 / 提醒 / 线程行为未改；零新增运行时依赖。完整条目见 [CHANGELOG](CHANGELOG.md)（0.5.0 段），字段与部署见 [docs/persona-card.md](docs/persona-card.md)、[docs/persona-shadow.md](docs/persona-shadow.md)、[docs/deploy-v050.md](docs/deploy-v050.md)。

## v0.4.12 变更摘要

- **人格卡接上运行时（V11-P1）**：新增可选配置 `persona.cardPath`（默认 `null`，非枚举、不参与 16 键安装自检），相对路径相对 `DSH_HOME`（`DSH_HOME` trim 后非空优先，未设置时 `~/.dsh`）。`apply` 时**加载一次**，人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词四处共用同一张卡（`DEFAULT_CARD` 只剩 `src/persona/card.js`），改卡需重启。加载失败（文件不存在 / 非法 JSON / 必填字段缺失 / 读取错误）不阻断启动：回落内置卡并写**一条** warn（仅 `path` 与 `reason`，不含卡正文），`/状态` 增加「人格卡：<name> v<version>（内置默认 | <绝对路径> | 加载失败，已用内置：<原因>）」。
- **proactive 冲突以配置为准**：卡里的 `proactive.dailyCap` / `quietStart` / `quietEnd` 与配置同名项不一致时只写一条 warn（列出字段与两边取值，内置默认卡也参与比较）；运行时行为不变，合并方案留 v0.4.13。
- **复审修复**：review-v18 的 M-1（未设置 `DSH_HOME` 时回退 `<home>/.dsh`，而不是裸 `~`）、M-2（坏 JSON 的诊断不再把 V8 的源文件回显写进 warn / `/状态`，剥引号片段与控制字符、单行 ≤160）。
- **复审与发布门**：发布前独立复审 [review-v19](docs/review-v19.md)（pass，H=0 / M=0 / L=3）；发布门 round A/B PASS，round C 无模型凭据按 v0.4.11 口径 **SKIP（不计 PASS）**。
- **范围**：仅人格接线；schema 仍 v13，记忆 / 提醒 / 线程行为未改；零新增运行时依赖。完整条目见 [CHANGELOG](CHANGELOG.md)（0.4.12 段）。

## v0.4.11 变更摘要

- **thread preset 可配置（V10-H1）**：新增可选配置 `thread.agentPreset`（默认 `null`）；未配置时 `thread_run` 不传 `agentPreset`、走宿主默认，配置后传入该值。宿主报未知 preset 时返回 `{ ok: false, reason: 'preset_unknown', message }`，不抛异常、不写 `threads` 行；`/状态` 显示「线程 preset：宿主默认 / <name>（配置：thread.agentPreset）」。
- **压缩/巩固耗时阈值（G0-9）**：新增可选配置 `timing.compactWarnMs`（默认 `20000`）与 `timing.consolidateWarnMs`（默认 `60000`）；成功/失败都采样最近耗时，超阈值同类每进程只 warn 一次、**不设硬超时、不中止**；`/状态` 增加「最近压缩耗时」「最近巩固耗时」（无样本 `—`，超阈值标「（超阈值）」）。
- **存量 episode 脱敏 scrub（V10-L1，schema v13）**：打开 v12 及更早（或无标记）的库时，对存量 episodes 的六个文本/JSON 字段一次性重跑值级脱敏并重建 `fts_episodes`；只改变化行，写 `schema_meta` 标记 `episode_scrub_v13` 与一条 `action=scrub` 审计（仅 `{scanned,changed}`），重复打开幂等。
- **round C 常驻口径（V10-M1）**：round C 改为**常驻实例 8 次巩固成功**；headless / one-shot turn 结束进程即退出，`setImmediate` 排后的巩固不执行属正常（云端 `tokenMeter` 有值、`consolidations=0`），headless 门只作 A/B 冒烟、SKIP 不计 PASS；三种门改造登记为推迟项 D-10。
- **复审**：发布前独立复审 [review-v17](docs/review-v17.md)（pass，H=0 / M=0 / L=3，均为不阻塞观察）。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.10 变更摘要

- **episode 落库前凭据值脱敏（V9-M1）**：`consolidate` 对 `title` / `summary` / `evidence` / `mood_evidence` 与 `topics` / `entities` 逐字段脱敏，只把凭据值换成 `[凭据已省略]`、保留「路由器密码 …」这类上下文；`store.insertEpisode` 再做一次防御性值级脱敏（含 `topics_json` 字符串形态），`fts_episodes` 由主表投影故自动无明文。兜底判定改用 `hasUnredactedCredentialValue`，只对残留值整段替换，「用户提到一个密码」这类叙事不再被误抹；巩固提示词要求不得复述密码、口令、token、卡号等凭据值。
- **token / 银行卡误报收窄（V9-L1）**：`SENSITIVE_PATTERN` 去掉裸 `token` 与裸「银行卡 / 信用卡」，「token 额度 10B」「银行卡在招行」不再误报；token 仍由「字段名 + 连接词 + 含数字或符号的值」命中（`token 是 abc123`、`API token：sk-…`），银行卡只拦卡号形态（12 位以上数字，允许 4 位分组的空格或连字符）。
- **「口令」与设备值补漏（V9-L2）**：强模式补「口令」，新增设备值模式（WiFi / wi-fi / 路由器 / 路由 / 门禁 / 门锁 / 热点 + 是/为/`:`/`=` + 含数字或符号的值），「路由器口令是 …」「WiFi 是 …」不再漏报，并在 episode 落库前脱敏。
- **复审**：发布前独立复审 [review-v16](docs/review-v16.md)（pass，H=0 / M=0 / L=0）。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.9 变更摘要

- **工具注册改为调用时判能力（V7-H1）**：`apply()` 不再按 `threadTools` 过滤，10 个工具一律注册；`thread_list` / `thread_run` / `task_run` 在注册的 `execute` 内实时读能力，宿主没有 `sessionController` 时返回 `{ ok: false, reason: 'capability_missing' }` 而不是不注册，能力晚挂载后无需重装插件即可用；`/状态` 与 `/线程` 同步改为运行时判断。
- **压缩起点跳过系统节点（V7-M1）**：`planRegion` 与 `maybeCompact` 共用 `firstReplaceableIndex`，人格/平台系统段永远不会被压进摘要；区间全是系统节点时返回 `no-replaceable-range`，恢复的 pending 区间收紧后为空则直接丢弃。
- **凭据类内容不落库（V7-M3）**：敏感判定扩到 password/验证码/CVV/私钥/卡号/api key/access token/`sk-` 等（`密码学` 等负向排除），巩固前过滤敏感事实与提醒（不写 facts/FTS/reminders），状态板逐行过滤并对历史行兜底；命中时每 turn 注入一次不含具体值的隐私提示并回 `CREDENTIAL_HINT`。
- **发布门 round C 两轮（V7-L1）**：同一会话两轮续跑（`--patch` 在 `--json` 之前，第二轮 `--session-id`），`compactHardTokens` 降到 120；无凭据 → SKIP 且明确不算 PASS，有凭据但 tokenMeter 为零或无 consolidations 行 → fail。
- **`duration_ms`（V7-L2）**：巩固事件与压缩事件都写入非负整数毫秒耗时（同秒内可区分），`eventDurationMs` 兼容旧行/坏 JSON。
- **到期索引与口径统一（V8-L1/L2）**：`ix_rm_fire` 换成表达式索引 `ix_rm_due(status, max(...))`（旧库幂等补建、删除旧索引，`schema_version` 仍 12）；到期口径统一为 `max(next_fire_at, retry_at)`，`dueReminders` 与 `onAttempt` 同源；改期走 `rescheduleReminder` 并清空 `retry_at`/occurrence，裸 SQL 改期由触发器兜底。
- **复审**：发布前独立复审链路 review-v14（needs_revision，唯一 M 为文档契约）→ 文档修复 `d14e2b2` → [review-v15](docs/review-v15.md)（pass，H=0 / M=0 / L=0）。发布门 round C 因本机无模型凭据为 **SKIP（未计 PASS）**；v0.4.11 起 round C 不再要求在 headless 门内完成，改以常驻实例 8 次巩固成功为通过口径。完整条目见 [CHANGELOG](CHANGELOG.md)（0.4.11 段）。

## v0.4.8 变更摘要

- **提醒失败退避不再覆盖原定时间（V5-L2）**：`reminders` 新增 `retry_at`（schema v12；v11 及更早旧库按列检测自动幂等迁移，旧行 NULL、`COALESCE` 回退到 `next_fire_at`，升级后到点行为不变）。失败退避只写 `retry_at`（第 1 次 30s、第 2 次 60s），`next_fire_at` 始终是原定到点时间；调度按 `COALESCE(retry_at, next_fire_at)` 到期，成功或置 `expired` 时清空 `retry_at`。状态板提醒行显示原定日期，重试期间附「重试中，下次 HH:MM」（按 `config.timezone` 格式化）；requestId 仍按 `occurrence_key` 稳定。完整条目见 [CHANGELOG](CHANGELOG.md)。
- **复审**：发布前独立复审 pass（H=0 / M=0 / L=2，均为不阻断发布的建议项），见 [docs/review-v13.md](docs/review-v13.md)。

## v0.4.7 变更摘要

- **提醒 requestId 按 occurrence 稳定（V6-M1）**：`reminders` 新增 `occurrence_key`（schema v11），requestId 固定为 `companion-reminder:<id>:<occurrence_key>`；失败退避改写 `next_fire_at` 重试时 rpcId 不变，成功或 `expired` 后清空 occurrence/last_fire_key 并把 `delivery_attempts` 归零，下一次到点换新 key、attempts 从 0 起。v10 旧库自动幂等迁移。
- **`/状态` 巩固模型标注（V6-L1）**：运行时解析出的路由标「（自动选取）」，配置来源「（配置）」，宿主注入「（宿主注入）」，不再出现「（运行时）」。
- **llm 发现失败 warn 去重（V6-L3）**：`listProviders` / 各 provider `listModels` 失败由 `debug` 升为 `warn`，按 `providers` / `models:<providerId>` 各只 warn 一次；发现成功后清键，成功解析出路由后整体清空，之后再失败可再次 warn。
- **复审**：发布前独立复审 pass（H=0 / M=0 / L=0），见 [docs/review-v12.md](docs/review-v12.md)。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.6 变更摘要

- **提醒投递签名与用户消息污染（C5-H1a）**：`prompt(request, signal)` 第二参固定为 `AbortSignal.timeout(30000)`；提醒/承诺/闲聊带稳定 `requestId`，同一 claim 重试复用。被宿主记成 `user/message` 的提醒按 `rpcId` 前缀或 `[提醒]` 前缀识别，不重绑主会话、不进巩固、不喂召回查询；投递失败写 `delivery_error`，`/状态` 显示「最近失败：投递失败：…」，同一原因只 warn 一次。
- **线程服务改用公开方法名（C5-H1b）**：适配层改用 `sessionController.create` / `resolveAgent`，不再调用内部 `createSession`；能力探测、`thread_run` / `task_run` 投递与 `whenIdle` 同步到公开面。
- **巩固模型解析（C5-H2）**：不再永久缓存首次 `null`；每次重新确认动态能力位，成功路由缓存 5 分钟、失败不缓存，llm 晚注册后巩固可恢复。`/状态` 显示「巩固：<provider>/<model>（配置|自动选取）」/「宿主注入模型（宿主注入）」/「无可用模型」，无模型时按 60s 节流记失败事件；provider/model 发现失败升为 `warn` 并按原因去重；发布门新增 round C。
- **压缩开关、日志与 `/线程` 提示（C5-M1/M2/L1）**：`/状态` 明确显示压缩是否开启与待压缩区间数，文档给出 `compaction-basic` 的 `disabled: false` + `auto: false` 写法；巩固跳过由 `debug` 升为 `warn` 并去重；宿主无 `sessionController` 时 `/线程` 直接返回「线程：宿主不支持」。
- **复审**：发布前独立复审 pass（H=0 / M=0 / L=1，Low 项已随发布修完），见 [docs/review-v11.md](docs/review-v11.md)。完整条目见 [CHANGELOG](CHANGELOG.md)。

## v0.4.5 变更摘要

- **提醒投递不再卡 `delivering`（V4-H1）**：队列键固定为 `reminder:<id>`，安静时段/日上限/退避期间不会堆出多份；提醒不参与文本合并，投递前逐份判定；失败按 30s → 60s 退避（第 1/2 次），第 3 次才 `expired`，启动回收崩溃残留的 `delivering`。v0.4.8 起退避只写 `retry_at`，原定 `next_fire_at` 不再被改写。
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
| `persona.cardPath` | `null` | 人格卡 JSON 路径（v0.4.12）；相对路径相对 `DSH_HOME`（未设置时 `~/.dsh`） | 字符串或 `null`；`null` / 空串用内置卡 |

token 四档必须满足 `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens`；RSS 三档必须满足 `0 < rssWarnGiB < rssStopGiB < rssMainOnlyGiB`。未知配置键只记警告，不阻断启动。v0.3.0 起新增可选的 `vector.*`（默认关闭），v0.4.0 扩展为 `hash` / `local` / `remote` / `none` 与 remote 端点配置，v0.4.2 新增 `vector.backfillTimeoutMs` 并把 `backfillBatchSize` 默认降到 8；`DEFAULTS.vector` 不可枚举，首次安装自检仍按 16 个基础键输出（含 RSS 三档）。v0.4.4 起新增非枚举的 `recall.*` 与 `session.mainBinding`，同样不参与 16 键安装自检；v0.4.11 起新增非枚举的 `thread.agentPreset`（默认 `null`）与 `timing.compactWarnMs` / `timing.consolidateWarnMs`（默认 `20000` / `60000`），同样不参与 16 键安装自检；v0.4.12 起新增非枚举的 `persona.cardPath`（默认 `null`），同样不参与 16 键安装自检。治理/编辑、承诺跟进、轻闲聊与失败自愈仍由既有配置与固定阈值控制。

**宿主压缩能力（compaction-basic）**：插件通过宿主的 `compaction.compactRegion` 服务压缩上下文，压缩后由水位重锚接管。DSH web-app 默认把 `compaction-basic` 设为 `disabled: true`，插件拿不到该能力，`/状态` 会显示「压缩：宿主未开启（compaction-basic 未启用）」：巩固照常写库，但 `pending_compact` 只保留区间，surface 不会真正缩小。云端已验证的开启写法（写进 `cordis.patch.yml`，不是本插件的 config）：

```yaml
- id: compaction-basic
  disabled: false
  config:
    auto: false
```

`auto: false` 表示宿主不再每轮自动压缩，只由插件在空闲边界（`idleMs`，默认 30 分钟）调用 `compactRegion`，避免与巩固抢时机。开启后 `/状态` 显示「压缩：宿主已开启（compaction-basic 已启用）」，有待压缩区间时附「，待压缩 N 个区间」。

**主会话绑定（v0.4.4）**：默认 `session.mainBinding: 'latest-user'`——只有当**线程外**会话出现真实用户输入时才把 `main_session_id` 重绑到该会话，并记一条 info 日志（旧/新 id）；runtime-context、召回注入与中文命令提示都不算用户输入，不会触发重绑。`'first'` 保持原主会话不变。提醒投递到当前主会话，`/状态` 会显示「主会话：<id>（绑定 <mode>）」。

**人格卡（v0.4.12）**：`persona.cardPath` 指向一份 JSON 人格卡（结构见 [persona.example.md](persona.example.md)），插件在 `apply` 时**加载一次**，人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词过滤共用同一张卡；默认 `null` 用内置「珞然」卡。绝对路径原样使用，相对路径相对 `DSH_HOME`（`DSH_HOME` trim 后非空优先，否则 `~/.dsh`）。对象字段逐层深合并，数组字段（`values` / `taboos` / `bannedPhrases`）**整体替换**、不与默认项合并。**改卡后需重启宿主**（无热加载）。加载失败不会阻断启动：回落到内置卡并写一条 warn（`[dsh-companion] persona card load failed; using built-in card`，带 `path` 与 `reason`），`/状态` 显示「加载失败，已用内置：<原因>」。卡里的 `proactive.dailyCap` / `quietStart` / `quietEnd` 本版**不生效**，主动节奏以配置为准（不一致只写一条 warn、内置默认卡也参与比较；`chatPerDay` 无配置对应键），合并方案留到 v0.4.13。详见[人格卡（V11-P1，v0.4.12）](docs/usage.md#人格卡v11-p1v0412)。

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

`/status`（`/状态`）会显示人格卡来源：`人格卡：<name> v<version>（内置默认 | <绝对路径> | 加载失败，已用内置：<原因>）`，三态示例与切换方式见 [docs/usage.md 的人格卡一节](docs/usage.md#人格卡v11-p1v0412)。

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
