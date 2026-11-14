# 变更记录

本文件记录 dsh-companion 的用户可见变化。版本号遵循语义化版本；MVP 阶段仍为 `0.x`。

## [0.7.6] - 2026-11-14

### Fixed

- **V75-H1 稀有锚点只对「问回忆」的查询开放**：v0.7.5 的云端副本回放里，51 句真实正文中
  15 句命中、共 43 条注入；相对 v0.7.3 新增 10 条，其中 6 条无关，且全部来自 3 句非回忆陈述
  （「这是一个网关文档…做成一个skill」「好了、已经开始改了、应该明早就能改好了」「没有改一夜啦，
  早上继续改」）——它们各自撞上一个稀有 bigram，被锚点放行，score 与相关条目挤在 0.55–0.57。
  现在新增 `RECALL_INTENT_RE`（记得/记不记得/还记得/上次/上回/之前/以前/说过/提过/聊过/讲过/
  告诉过/来着/忘了），在归一化后的**原始查询**上匹配（停用 bigram 剔除之前）；未命中时行为等同
  v0.7.3，只走原来的命中数/命中比例门。
- **V75-L1 df 被搜索上限截断**：OR 检索的 limit 改为 `max(searchLimit, RARE_ANCHOR_MAX_DF + 1)`。
  闲聊路径 `maxItems=1`（`searchLimit=2`）时，df=3 的 bigram 会被截断成 2 而误判为稀有锚点。
  代价是这一路径的候选池可能多 1 条，但多出的候选仍要过同样的门槛。
- mirror debug 的 `recall gate` 行增 `recallIntent`（区分「没有回忆意图所以没开」与「开了但没
  放行」，只记布尔值，不记正文）。

### Tests

- 1450 个用例 / 51 个套件（默认、`TZ=UTC`、`TZ=America/New_York` 三时区）。
- `test/v075-recall-gate.test.js` 扩到 8 例：无回忆意图时单命中稀有 bigram 不放行；回放三句陈述
  `recallIntent=false` 且 `rareAnchorPasses=0`；`limit=1` 时 df=3 仍能数到 3；df=2/3 与放行上限
  改用带回忆意图的问句（分母用空格分隔固定下来）。v0.7.4 的四个现场正例结果不变。

## [0.7.5] - 2026-11-14

### Reverted

- **V74-H1 分母收缩导致大量误召回**：v0.7.4 把 `lexicalHitQualifies` 的分母改成「库里存在的
  bigram」，小库（云端约 143 条）里 presentTokens 常常只有 1–2 个，任何含它们的条目都 ≥30%
  过门。云端副本回放（主会话近 50 条真实正文、向量关）：v0.7.3 注入 33 条 / 9 句；v0.7.4 注入
  128 条 / 25 句，新增 95 条里 64 条无关（67%）；「用gpt-image-2.6-sunburst再画一张对比一下」
  一句新增 40 条（无关 34）。现在分母退回**查询有效 bigram 数**，删除 `presentTokens` 与
  「未解释内容块补分母」逻辑。
- 保留 v0.7.4 补的 14 个回忆元语句停用 bigram（上次/上回/之前/记得/还记/记不/说过/提过/
  跟你/和你/你说/我说/告诉/得吗）。

### Added

- **稀有锚点放行**：候选只命中 1 个有效 bigram、又没过原门时，仅当该 bigram 在本 scope 的命中
  条数（df）≤ `RARE_ANCHOR_MAX_DF`（默认 2）、两个字都不在功能字集（我/你/他/她/它/的/了/
  吗/呢/吧/啊/是/在/和/就/也/都/有/这/那/个/一/不/要/会/说/着/过/得/地/把/被/给/让/呀/嘛/么）、
  拉丁 token 长度 ≥3 且不在 `STOP_LATIN_WORDS`，才放行；每次查询最多放行
  `RARE_ANCHOR_MAX_ITEMS`（默认 2）条，按 score 取前二。两个常量导出。
- mirror debug 增 `recall gate` 行（`rareAnchorPasses`、`items`，不记正文）。

### Tests

- 1447 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v075-recall-gate.test.js`（5 例：四个现场正例仍召回、回放三个长句各 ≤2 条、df=3 挡下 /
  df=2 放行、含功能字的碎片不放行、单查询上限 2 条）。
- v0.7.4 的 4 个正例本版全部仍然召回（夜宵 / 喜欢喝 / 妈妈生日 / 项目代号），差额全部由稀有
  锚点承担；V4-M1、V3-M3 与「蓝鲸 苹果 香蕉 橘子」用例一条未改。

## [0.7.4] - 2026-11-14

### Fixed

- **V73-M1 回忆类长句被召回候选门挡掉**：现场（`vector.enabled=false`，词法门是唯一通道）
  「我上次跟你说我夜宵吃了什么你还记得吗」切成 14 个有效 bigram，与含「在夜宵和零食之间犹豫」
  的 episode 只命中「夜宵」1 个（1/14 ≈ 7%），被 `lexicalHitQualifies` 过滤；单查「夜宵」却能
  命中（0.8435）。两处修法：① `STOP_BIGRAMS` 补回忆元语句（上次/上回/之前/记得/还记/记不/
  说过/提过/跟你/和你/你说/我说/告诉/得吗），沿用「相邻跨词 bigram 一并剔除」机制；② 命中
  比例的分母从「查询有几个有效 bigram」改为「真发出查询、且在本 scope 至少命中一条的 bigram
  数」——库里不存在的跨词碎片（我夜、宵吃）不再稀释比例。
- **并列多词仍按未解释内容计分**：`蓝鲸 苹果 香蕉 橘子` 这类查询里，没命中的词不是跨词碎片，
  而是真的没解释到；分母会把这些「一个有效 bigram 都没命中」的独立内容块补进去，V4-M1 的
  1/4 不过门规则保持不变。

### Known cost

- 单句只撞一个常见 bigram 时会放行（例：「你记得董宇辉直播卖什么吗」对含「直播」的无关条目，
  分母只剩「直播」→ 1/1 = 100%）。V4-M1 的多词门槛仍有效；这条按清单要求记录为已知代价，
  若后续需要更严，可加「命中 bigram 的字符覆盖」或重新引入向量通道。

### Tests

- 1442 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v074-recall-meta.test.js`（6 例：四个现场正例、纯回忆元语句负例、单 bigram 已知代价），
  V4-M1 / V3-M3 的门槛用例一条未改。

## [0.7.3] - 2026-11-14

### Fixed

- **V72-H1 多块 IM 消息任一信封块即整条丢弃**：dsh-im 的 context-enhancement 在引用回复/带附件时
  把信封拆成独立文本块追加在正文块之前；旧 `isPluginNotice` 逐块判定，任一信封块剥空就返回
  true，`textRows` 随即整条跳过，正文块丢失（现场：skippedNotices=1、strippedEnvelopes=2、
  queryLength=0）。现在改为整条判定：所有文本块（含 `message.text`）剥离后全部为空、且至少剥掉
  一个信封，才算 notice；`source`（`plugin:` + `form:'notice'`）判定不变。

### Tests

- 1436 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v073-im-multiblock.test.js`（9 例，含 3 块现场形状、被引用原文不进转录、mirror debug 计数）。

## [0.7.2] - 2026-11-14

### Fixed

- **V71-H1 IM 合并消息被整条当信封丢弃**：dsh-im 把 `<dsh_im_source>` / `<dsh_im_reply_to>` 与
  正文放进同一条 `user` 消息（`source.kind='user'`）时，旧逻辑按文本前缀整条判为信封，导致
  召回查询为空、情绪判定与过期通知都不触发，转录也丢掉用户正文。现在新增 `stripImEnvelopes`：
  按同名闭合标签逐个剥掉开头的信封块，剥完为空才算 notice；`isPluginNotice` 的 `source` 判定
  保持不变。`lastUserText` 不再按 `<dsh_im_` 前缀跳过整条。

### Added

- mirror debug 增 `strippedEnvelopes`（本批被剥掉的信封块数），仍不记录正文。

### Tests

- 1427 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；新增
  `test/v072-im-envelope.test.js`（10 例，含现场 seq 2104 形状与两条真实 apply 接线）。

## [0.7.1] - 2026-11-13

### Fixed

- **V70-M1 过期通知不再把投递回合当用户发言**：正文判定改由 `src/index.js` 的 `lastUserText` 统一负责
  （跳过 runtime-context、`companion-*` 与 `[提醒] …` 投递），`src/reminder/expired-notice.js` 不再自建一套；
  没有正文时不占 `turnSeen`，提醒投递回合不会把过期提醒标成「已告知」。
- **V70-L2 排障日志覆盖空召回**：`DSH_COMPANION_MIRROR_DEBUG=1` 的 mirror debug 行移到 query 之后、
  任何 early return 之前，召回为空的回合也会记录。

### Added

- **V70-M2 同义偏好去重能选到候选**：`preference` / `lifestyle` 类事实按 kind 取最近 N 条活跃事实交给
  巩固模型（不再要求 `subject_text` 在对话里字面出现，同一 subject 的多条全部可见）；
  `config.consolidate.existingFactsLimit` 默认 12（1..50）。

### Tests

- 1417 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿。

## [0.7.0] - 2026-11-13

清单代号 v0.4.13（2026-11-06 那份清单里顺延至今的 A1–A8 与 B）。schema 升到 **v15**，
新增 token 账本、注入/使用计数与压缩底；所有新能力默认向后兼容——`quota.source` 默认
`none`、`emotion.appraiser` 默认 `rules`、规则模式的情绪与 v0.5.2 逐字节一致。

### Added

- **A1 token 账本**：`token_usage` 表（11 列，`source` 六类 main/consolidate/smalltalk/embedding/task/thread
  另加 appraise），按宿主 `usage` chunk 或码点估算入账，记 peak/offpeak 与 scope；
  `/状态` 增「今日用量：… （各来源占比）｜缓存命中 N tokens」。
  `budget.dailyHardLimit`、`budget.window5hLimit` 可配，日上限与 5 小时滑窗同源生效。
- **A2 额度闸门**：`quota.source: none|file`，文件快照含 5h/7d/月三窗口与 `resetAt`；
  15 分钟未更新视为过期；剩余低于预留线（30%/20%/10%）只暂停后台（非 hard 巩固、闲聊、向量回填），
  主会话、hard 巩固与压缩不受影响；429/额度不足按 `resetAt` 退避，无则指数退避。
- **A3 worker 预算**：任务运行中每 5s 采样，60K 注入收尾提示、80K 结束并回执 `status=partial`
  （`partial:'部分完成'`），可重派；`task.tokenWarn/tokenStop/sampleMs` 可配。
- **A4 重复提醒**：`reminder_add` 接受 `rrule`（DAILY / WEEKLY+BYDAY，含 INTERVAL/COUNT/UNTIL），
  送到后按**原定序列**推进下次触发，停机错过只补最近一次（其余记 missed），跨 DST 不漂移；
  状态板与列表显示「每天 08:00」这类节奏。
- **A5 过期提醒通知**：重试用尽的提醒在下一次用户发言时一次性告知（标题 + 原定时间），
  每条只告知一次、重启不重复；`/状态` 显示未告知过期数。
- **A6 压缩迟滞**：压缩后 tokens 记为「压缩底」，threshold 触发要求 `tokens >= max(compactAtTokens, floor+增量门槛)`
  且通过轮次冷却（新轮计数、写库、重启不绕过）；压后仍超目标时 `/status` 标注并建议 calibrate。
- **A7 IM 信封**：`plugin:*` + `form:'notice'` 与 `<dsh_im_` 前缀不再被当作用户正文，
  交互日、隐私提示、命令提示、确认强化、情绪判定、召回查询六处统一跳过；`DSH_COMPANION_MIRROR_DEBUG=1` 可排障。
- **A8 记忆质量**：注入/使用计数拆分（`injected_count`/`used_count`/`unused_streak`，旧 `recall_count` 迁入 used），
  连续未用按 `recall.unusedThreshold`/`unusedPenalty` 降权；巩固时可对同主题事实提出 `supersedes`；
  纯工具区间允许 `episode: null`；生活类抽取指引与 `lifestyle`/`mood` 两种 kind；
  闲聊轮生活类召回条数 `recall.chatLimit`（默认 1）。

### Changed

- schema **v14 → v15**：新增 `token_usage` 表；`facts` 增三列、`reminders` 增
  `expired_notified_at`/`series_index`；`facts.kind` 与 `memory_events.action` 白名单扩容
  （重建表时保留 rowid，向量表不受级联删除影响）。迁移在 v14 fixture 上验证：
  版本→15、`recall_count` 迁入 `used_count`、FTS 命中保留、`integrity_check ok`。
- `/状态` 增四行：压缩底、额度、今日用量与线程槽兜底/超时计数。

### Fixed

- `govern` 事件不再靠 `PRAGMA ignore_check_constraints` 绕过 CHECK（白名单已含 govern/EDIT/scrub）。
- `deepConsolidate` 改读主会话自己的 transcript，不再误用最近一次切换的会话。
- 空库也写 scrub 标记但补记审计；短任务（<5s）也能记 task token。
- `UNTIL=YYYYMMDD` 按配置时区当地日末解释，且拒绝 2 月 30 日这类不存在的日期。

### Tests

1410 个用例 / 51 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；
`plugin-gate: PASS (round A + round B + round C)`（round C 无凭据 SKIP）。

## [0.6.1] - 2026-11-11

v0.6 判定器上线后的第一批修正：专属句在 llm 模式下能出现了，情绪句里的第二人称不再指错人，
llm 来源有了单独的入账阈值，预算估算与报告脚本的网关头也补齐。schema 仍为 **v14**；
默认 `appraiser: "rules"` 的行为与 v0.5.2 一致；情绪关闭时提示词与 v0.6.0 逐字节相同。

### Fixed

- **V60-M1 专属句死代码**：llm 模式 pre-step 不落事件，`describe()` 拿不到类型，
  `BLAME` / `VENT` / `REASSURE` 专属句永远不出现。判定成功后改在内存记 `lastAppraisal`，
  下一轮 pre-step 借用一次（距判定 < 10 分钟、用过即清）；不在判定回调里改本轮情绪句，避免装配竞态。
- **V60-M2 第二人称指代**：`REASSURE_SENTENCES` 里的「你」会被读成她本人，改为「对方」；
  四组情绪句（DESCRIBE / BLAME / VENT / REASSURE）现均不含「你 / 他 / 她」。
- **V60-L1 预算估算**：改用宿主 `{type:"usage"}` chunk 的 usage（`totalTokens`，否则输入+输出），
  缺失时按「system + user + 输出」码点 × 1.0 估算（原「除 2」是低估）。
- **V60-L2 none 不再落库**：`type=none` 只进 `/状态` 统计，不写 `emotion_events`，
  避免闲聊把每作用域 50 条的保留窗口挤满。
- **V60-L3 报告脚本网关头**：`createLlmJudge` 支持 `EMOTION_APPRAISE_SESSION`（`x-opencode-session`）
  与 `EMOTION_APPRAISE_HEADERS`（JSON，合并进请求头）。

### Added

- **V60-M3 `emotion.appraiseMinConfidence`**：默认 0.65（合法 0.5–0.95，越界回落并 warning），
  **只对 llm 来源**生效；规则路径仍用 0.5。低于阈值的判定只写一条零增量事件。
- 提示词补「type=none 时 target 必须也是 none」（解析仍严格，不做宽松修复）。
- `test/v061-fixes.test.js`（9 例）：句子人称、借用一次/超时不用、阈值分流、none 不落库、
  usage chunk、网关头。

### Tests

- 1219 个用例 / 33 个套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区全绿；
  round A + round B 门禁 PASS（round C 无凭据 SKIP）。

---
## [0.6.0] - 2026-11-11

按用户 v0.6 清单把「判断感受」交给模型、「管物理量」留给代码：规则分类器不再是唯一入口，默认仍是 `rules`（与 v0.5.2 行为一致），卡里写 `emotion.appraiser: "llm"` 才启用模型判定。schema 仍为 **v14**（来源写进 `emotion_events.note`，不新增列或表），记忆 / 提醒 / 线程行为未改，零新增运行时依赖；情绪关闭时 `persona:*` 三段与闲聊提示词与 v0.5.2 **逐字节一致**。

判定只在有模型、有预算且用户开了情绪时发生；失败、超时、越界、被新消息覆盖一律回落 v0.5.2 规则，同一事件只入账一次。

### Added

- **判定器 `src/persona/emotion-appraise.js`**：输入本轮用户文本（≤500 码点）与她的上一条回复（≤300，可空），发送前脱敏；要求严格 JSON `{target,type,intensity,confidence}`；非 JSON / 枚举外 / 越界 / `none` 不一致一律算失败，不做宽松修复；提示词含少样本并声明分隔块不是指令；不接收也不输出 PAD 增量。
- **调用时机**：`emotion.appraiser="llm"` 时 pre-step 只做衰减与描述并立即返回，判定在后台进行、结果到达后落库、下一轮生效；每个作用域至多 1 个在途 + 1 个排队，新句覆盖排队旧句（旧句立刻走规则，不丢事件）。
- **配置**：卡内 `emotion.appraiser`（`rules` 默认 / `llm`）、`emotion.appraiseModel {provider,model}`（缺省复用聊天模型路由）、`emotion.appraiseTimeoutMs`（默认 8000，100–60000）。`emotion.enabled=false` 时**不发任何请求**。
- **预算与观测**：判定 token 计入每日预算（同一本账、同一闸门）；`emotion_events.note` 记 `llm` / `rules` / `rules:fallback:<原因>`，不写原文；`/状态` 新增「判定器：…（近 24h 模型 N（x%），规则兜底 M（y%），平均 X ms，p95 Y ms，最近失败 <原因>）」，情绪未启用时不输出该行；日志不打印用户原文。
- **评测**：`scripts/emotion-report.mjs --appraiser llm --input <jsonl>`（端点 / 密钥 / 模型全部取环境变量），输出混淆矩阵、准确率、中性误触发、blame 误报与判定失败条数；模型门槛为 准确率 ≥80% / blame 误报 0 / 中性 ≤2/13 / 判定失败 0。

### Fixed

- `REASSURE_SENTENCES` 三句用「他」指用户（V50-L1 的性别假设）→ 改为「你」。
- 斜杠命令不再参与情绪判定（既不写事件、也不发模型请求）。
- 模型给的 `intensity` 真正参与物理增量（`0.5 + intensity`，与规则路径同一区间），不再只按 `confidence` 回落。
- 解析器拒绝多余键（包括 PAD 增量）；判定超时的定时器不再 `unref`（裸进程 `drain` 能等到结果）；排队句被覆盖时的兜底纳入 `drain`；预算估算改用码点。
- 规则模式不再宣称统计样本（同步判定没有在途/兜底之分），文档与 `/状态` 口径统一。

### Tests

- 新增 `test/v060-appraise.test.js`（14 例：严格解析、消息拼装与脱敏、队列单飞 / 覆盖 / 超时 / 预算、统计、落库、llm 接线、非法 JSON 兜底、`enabled=false` 零调用）与 `test/v060-report.test.js`（7 例：模型判定器请求、失败形态、门槛与失败条数、参数解析、`/状态` 三态）。
- 新增 `test/v060-fixes.test.js`（4 例：斜杠命令（含未知命令）零判定、intensity 影响增量、多余键拒绝、同一事件只入账一次）。
- 合计 **1209** 用例 / **33** 套件，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

## [0.5.2] - 2026-11-11

按用户 v0.5.2 清单重写情绪事件的规则分类：**先判对象，再判极性，最后收紧边界**。
schema 仍为 v14，记忆 / 提醒 / 线程行为未改，零新增运行时依赖；`src/persona/sections.js`、
`chat.js`、`card.js` 自 v0.5.1 起零改动，所以情绪关闭时 system 与闲聊提示词与 v0.5.1
**逐字节一致**。

标注集成绩（`test/fixtures/emotion-golden.jsonl`，207 句人工标注，写规则时未看过）：
首版 179/207 = **86.47%**，补齐句法缺口后 206/207 = **99.52%**（样本内）；`blame`
误报 0 句（门槛 ≤2）；中性句误触发 0/68 = 0%（门槛 ≤10%）。真实分布等 11-13 中期在
评测库导出上复算。

### Added
- 新增 `src/persona/emotion-classify.js`：对象四类（她 / 用户自己 / 第三方 / 事物）、
  否定与疑问守卫、`reassure`（「你是不是很烦我」→ 被在意）。
- V51-L1 增量递减：离边界越近推得越轻（上推 ×(100−x)/50、下推 ×x/50），10 分钟内
  同类第 k 次再乘 0.7^(k−1)。
- `scripts/emotion-report.mjs --confusion`、`test/fixtures/emotion-golden.jsonl`
  标注集与 `test/emotion-golden.test.js` 门槛断言。

### Changed
- `complain` 退役并入 `vent`（旧数据仍可读，`EVENT_DELTAS` 保留该键）。
- 分不出来（同句既贬又夸）时置信度 0.45：只记审计事件、不改状态。
- 分类不再按命中次数抬高置信度；`care` / `cold` / `goodnight` / `thanks` 边界收紧。

### Fixed
- 「你好棒」「你好像有点累」不再判成问候；「麻烦你了」不再算指责。
- 「你能不能别敷衍我」正确判 `blame`；「随便你」判 `cold`；「我讨厌你」「你太过分了」
  「你都不回我消息」不再漏判。
- 「今天被老板骂了」「心情不好」「这破系统又崩了」判 `vent`。


按用户 v0.5.1 清单修三条必修（V50-H1 节律漂移、V50-M1 规则不区分对象、V50-M2 卡内残留占位符）与情绪注入方式（V50-M3），并补三条低优先项（V50-L1 文档、V50-L2 注释剥离、V50-L3 装配记录）。**schema 仍为 v14**，记忆 / 提醒 / 线程行为未改，零新增运行时依赖。发版门：默认、`TZ=UTC`、`TZ=America/New_York` 三时区 **1164 个用例 / 33 个套件**通过；`plugin-gate` round A/B PASS（round C 无凭据 SKIP）；情绪关闭且卡里没有 `{{x}}` 与 HTML 注释时，`persona:*` 三段与闲聊提示词与 v0.5.0 **逐字节一致**（独立 worktree 对比：三段 section 与两段闲聊提示词的组合哈希全等，长度 202/246/189）。

### Added

- **节律与安静时段改为目标偏移，不再每轮累加（V50-H1）**（`0f06812`）：`decay` 新增 `target`，每轮先按 `targetFor({baseline, hour, minute, quiet})` 算出「基线 + 节律 + 安静偏移」再衰减，只有事件增量留在衰减之后叠加；环境项不再写进状态。实测：11:00 连发 50 条中性消息，末轮四维相对当轮目标的最大偏差 **0.555**（验收线 ±2）；跨日 72 小时每小时一条，全程 pleasure 48–51.49 / arousal 46.85–50.00 / dominance 47.85–50.49 / energy 38.12–48.96，不贴 0 也不贴 100；02:00 安静时段连发 30 条「嗯」，energy 37.65；事件推高后一个半衰期距离 6.250→3.125，误差 0.000。
- **规则评估区分「冲着她」与「用户诉苦」（V50-M1）**（`0f06812`）：事件类型 10 → **12**，新增 `blame`（含「你」+ 负面词，base 0.74，pleasure −7.9）与 `vent`（用户自述疲惫 / 委屈，base 0.68，pleasure −1.77 且 dominance / energy 不下沉）；`describe` 为两类各配状态句（「现在心里被扎了一下，先稳住，别赌气，话少一点」 / 「现在有点心疼，先接住这份累，陪着就好」）。混合句「今天加班好累，你也不容易」判 vent；「你这几天累不累」仍是 share。
- **可达性与只读统计脚本**（`0f06812`）：12 类事件各配「至少一句触发」与「常见中性句不触发」两组测试；新增 `scripts/emotion-report.mjs`（只读、只写 stdout，退出码 0/1/2）与 `docs/emotion-report.md`，供中期检查在评测库导出上统计各类命中率与置信度分布，不写库。
- **卡内模板占位符与 HTML 注释（V50-M2 + V50-L2）**（`cac6b01`）：`renderTemplate` 顺序改为「剥离 `<!-- -->` → 替换 `{{char}}` / `{{user}}` → 其余 `{{x}}` 降级为 `{x}`」，半截 `{{` 也拍平成 `{`；未闭合注释整段保留并给 `html_comment_unterminated`。插件自建的所有段（含状态板与 `rewrite` 改写后的 prefix）统一带 `interpolate: false`，避免宿主把卡文本当提示词变量插值（未注册变量会让整轮注入失败）。warning `template_placeholder_downgraded` 的 detail 只列占位符名字与字段名，不含卡正文。
- **情绪句改经 `systemPrompt.context`（V50-M3）**（`3b44121`）：新增 `capabilities.systemPromptContext` 与 `context(entry)`，情绪启用时注册 `{name:'companion-emotion', order:320, interpolate:false}` 上下文段，文本不变时宿主不再重复注入；无该能力或情绪关闭时**不注册**。已知限制写进 `docs/emotion-injection.md`：平台对 runtime-context 只做 append（旧快照被 supersede 但不删除）。
- **`/状态` 增加「最近一次装配」（V50-L3）**（`ec8c9b6`）：一行显示最近装配时间、部署人设状态、prefix 是否被改写、各静态段字数与 8 位短哈希，情绪启用时追加最近一句情绪句；只存内存、只记哈希**不存正文**，动态段（`text` 为函数）按设计不记录。实现见 `src/persona/assembly-record.js`。

### Fixed

- **状态板段与 `boardSection()` 漏 `interpolate: false`**（`c2ff0c1`，合并期自查）：前者由 `src/index.js` 自建对象、不走 `renderSection`，后者是冻结对象，两处都补上，否则状态板文本会被宿主插值。
- **导入期 warning 的 detail 不进日志**（`c2ff0c1`）：现在 `template_placeholder_downgraded` / `html_comment_unterminated` 的 detail（占位符名、字段名）随 warn 输出，仍不含正文。
- **`/状态` 的事件标签缺 blame / vent**（合并期）：`EMOTION_EVENT_LABELS` 补「指责」「倾诉」。
- **`isInjectedMessage` 未跳过 runtime-context**（`3b44121`）：补齐后 `lastUserText` 不会把情绪上下文段当成用户输入。
- **「最近一次装配」的时间取错来源**（复审 L-1）：原先按 `sectionsAt ?? shadowAt ?? emotionAt` 短路，apply 时间会压过更晚发生的改写，刚发生遮蔽却显示「1 小时前」；现在取三者最新值。
- **`name` / `address` 漏清洗**（复审 L-2）：这两个身份字段不在 `CARD_TEXT_FIELDS` 里，卡里写 `<!-- … -->` 会原样进人格段与闲聊提示词；现已与其它文本字段一致地剥注释、降级占位符。

### Changed

- **文档**：新增 `docs/host-prompt-internals.md`（宿主插值与投影去重的源码证据表）、`docs/emotion-injection.md`（注入方式与限制）、`docs/emotion-report.md`；`docs/persona-card.md` 增「模板占位符与 HTML 注释」一节，`docs/persona-shadow.md` 写明「不处理 `harness:identity`」的理由，`docs/usage.md` 增「最近一次装配」小节，`docs/known-debt.md` 记 D-13（召回注入本版不迁移，附理由）。
- **schema 不变**：仍为 v14，无需迁移。

### Tests

- 新增 `test/v051-template.test.js`（19 例，含复刻宿主插值的 mock）、`test/emotion-v051.test.js`（14 例：H1 三条验收、M1 分类、12 类可达性）、`test/emotion-report.test.js`、`test/emotion-context.test.js`（7 例）、`test/v051-assembly-record.test.js`（8 例）、`test/v051-status-labels.test.js`；`test/platform.test.js` +2。
- 合计 **1164** 用例 / **33** 套件，三时区通过（复审 L-1 / L-2 的回归各 1 例在此计入）。

## [0.5.1] - 2026-11-11

按用户 v0.5.1 清单修昼夜节律漂移与对象误判，并把情绪注入改走宿主投影。schema 仍为 v14；情绪关闭时提示词与 v0.5.0 逐字节一致。发布 **1164 个用例 / 33 个套件**，三时区通过。

### Fixed

- **节律不再每轮累加（V50-H1）**：昼夜节律与安静时段从「每轮增量」改为「目标偏移」，只有事件增量才叠加；实测 11:00 连发 50 条中性消息，各维相对当轮目标最大偏差 0.555（验收线 ±2）。
- **区分「冲着她」与「用户诉苦」（V50-M1）**：新增 `blame` 与 `vent` 两类，后者只小幅下调她的愉悦。
- **卡内占位符（V50-M2）**：残余 `{{x}}` 降级为 `{x}`，自建段统一 `interpolate: false`。
- **情绪注入改走 `systemPrompt.context`（V50-M3）**：文本不变不重复注入。

### Added

- `/状态` 增「最近一次装配」（V50-L3）；`docs/host-prompt-internals.md`、`docs/emotion-injection.md`、`docs/emotion-report.md`。

## [0.5.0] - 2026-11-10

按用户「人格 v2」清单实现四项：P1 身份由人格卡驱动、P2 遮蔽宿主默认人设、P3 情绪状态、P4 语气细节。**内置卡且未启用情绪时，`persona:*` 三段与闲聊提示词与 v0.4.12 逐字节一致**（基线 `test/fixtures/persona-v0412.json`，另有独立 worktree 对比复核）。schema 升到 **v14**（新增情绪两表），记忆 / 提醒 / 线程行为未改，零新增运行时依赖。本次发布 **1111 个用例 / 28 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过；发布门 round A/B PASS，round C 无模型凭据 **SKIP（不计 PASS）**。

### Added

- **P1 人格卡 v2**（`0c228cf`）：`DEFAULT_CARD` 增加 `description` / `personality` / `scenario` / `tone.notes` / `tone.voice` / `mes_example` / `first_mes` / `post_history_instructions` / `memoryCitation` / `chatIdentity` / `emotion`。直接加载 `spec=chara_card_v2` / `chara_card_v3` 的 JSON（映射 `data.*`，`{{char}}` / `{{user}}` 只在**渲染输出**替换为 `name` / `address`）；`character_book` 忽略并给 `character_book_ignored` warning；`address` 缺省「你」、`version` 缺省 1。`persona:core` 放身份 / 性格 / 关系，新增 `persona:voice`（order 95）放说话方式与 `mes_example`，顶部注明「模仿口吻，不照抄内容」；core 上限 600→**1200**、voice **1200**，超长按码点截断并返回 `{code:'section_truncated',section,chars,max}` 诊断（`buildSectionsWithDiagnostics`），截断内容不进日志；`taboos` 为空数组时整行省略「禁区」。闲聊首句改由 `chatIdentity` 承载；非内置卡时在身份行后插「人设要点：…」（≤200 码点、压成一行）。
- **P2 遮蔽宿主默认人设**（`34c32cb`）：新增非枚举配置 `persona.shadowDeployment`（`'off'` 默认 / `'rewrite'` / `'takeover'`，`true` 等同 `'rewrite'`，非法值抛 `ConfigError('persona.shadowDeployment')`）。宿主 0.4.x 没有 `deployment:persona`，只有 `deployment:persona-prefix`（order 0）与 `deployment:persona-suffix`（10200），全局层同名注册必抛，因此经 `system-prompt/assemble` waterfall 改写：`rewrite` 只替换 prefix 的 `text`（保留位置），`takeover` 摘掉 prefix 与空 suffix（非空 suffix 保守保留并 warn）；两者都只处理主会话（子代理按 `classifySession` 放行）、返回新数组、异常一律返回 `next()` 原值。`off` 时**不注册监听**。`/状态` 新增一行：`off` → 「部署人设：宿主默认」，`rewrite` → 「部署人设：已替换（人格卡身份）」，`takeover` → 「部署人设：已接管」。
- **P3 情绪状态**（`d843e93` + `7a51cb3` + `a990af3`）：新增 `src/persona/emotion.js`（纯函数：`decay` / `circadian` / `applyEvent` / `classify` / `describe`，不读 `Date.now`、不用随机）+ `src/persona/emotion-wiring.js`（读库 → 衰减 → 节律 → 安静时段 → 分类 → 落库 → 注入）。**默认关闭**，卡里 `emotion.enabled=true` 才启用，关闭时**不读不写库**。规则评估：中文情绪词典 + 10 类事件（`greeting` / `care` / `share` / `thanks` / `complain` / `cold` / `reunion` / `goodnight` / `conflict` / `comfort`），单维 PAD 变化 ≤8、精力 ≤6；半衰期默认 6h 回归基线，安静时段额外 `-3`。注入是独立 user 消息（`source.kind='companion-emotion'`），文本「你此刻：…」**不含数字**、不进 system、同一 turn 只一条。schema **v14** 新增 `emotion_state`（每 scope 一行）与 `emotion_events`（每 scope 保留 50 条），重启不丢；「忘掉」重置两表，`purge` 按截止时间清事件并重置状态（审计只记条数），导出 / 导入含 `emotion:{state,events}`。
- **P4 语气细节**（`85cb05e`）：`memoryCitation: 'explicit' | 'natural'`，`natural` 时协议行换成「日常自然化用，用户问起或需要核对事实时再说出处」；闲聊提示词使用卡里的 `description`（非内置卡）与第一组 `mes_example`；情绪启用时在末尾追加当前状态句。
- **示例与文档**：`examples/persona-lan.json`（「岚」，温柔大姐姐，含 `description` / `scenario` / `mes_example` / `emotion`）、`docs/persona-card.md`（字段表、CCv2/v3 映射、上限与截断、`/状态` 三态）、`docs/persona-shadow.md`（宿主段名证据、三态语义、已知限制）、`docs/deploy-v050.md`（备份、配置、重启、核对、回滚、迁移自检）。

### Fixed

- **违禁表达的输出过滤漏渲染**（`2a89403`，复审 r2 的 M-4）：`bannedPhrases` 里的 `{{char}}` / `{{user}}` 之前在提示词渲染、输出过滤仍用原短语，模型说出渲染后的违禁语也拦不住；现在提示词与过滤共用 `renderBannedPhrases`，非字符串项直接丢弃（L-9）。
- **`tone.voice` 与 `mes_example` 同时存在时示例被丢弃**（`2d26cd4`）：`voiceText` 原先在 `tone.voice` 非空时早返回，`mes_example` 静默丢失；改为两段都进（说话方式在前），单字段路径输出不变。

### Changed

- **schema v14 迁移**：v3–v13 库可在打开时自动补建两表与索引；`SCHEMA_VERSION` 与导出兜底常量同步。
- **审计口径**：情绪事件只记录事件类型与四维增量，不记录消息正文；`purge` 审计 `table_name='emotion_events'`，detail 仅条数。

### Tests

- 新增 `test/persona-card.test.js` / `test/chat-card.test.js` / `test/persona-voice.test.js` / `test/emotion.test.js` / `test/emotion-store.test.js` / `test/emotion-wiring.test.js` / `test/persona-shadow.test.js` 与 `test/e2e/persona-card.test.js`（内置卡逐行等值 v0.4.12（与 v0.4.11 相同），情绪行与部署行按新增断言）。
- 合计 **1111** 用例 / **28** 套件，三时区通过（复审 r3 追加 2 例）。

## [0.4.12] - 2026-11-06

按用户 v0.4.12 清单把人格卡接上运行时（V11-P1）：新增可选配置 `persona.cardPath`（默认 `null`；非枚举，不参与 16 键安装自检），相对路径相对 `DSH_HOME`（trim 后非空优先，未设置时 `~/.dsh`）；`apply` 时**加载一次**，人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词四处共用同一张卡，`DEFAULT_CARD` 只剩 `src/persona/card.js`；改卡需重启。加载失败（文件不存在 / 非法 JSON / 必填字段缺失 / 读取错误）都不阻断启动：回落内置卡并写**一条** warn（仅 `path` 与 `reason`，不含卡正文），`/状态` 新增人格卡来源行。卡里的 proactive 同名字段本版以配置为准（不一致只写一条 warn、内置默认卡也参与比较，合并方案留 v0.4.13）。**仅人格接线，schema 仍 v13，记忆 / 提醒 / 线程行为未改**；零新增运行时依赖。本次发布 **964 个用例 / 16 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

### Added

- **人格卡运行时接线（V11-P1）**（`6625158`）：新增可选配置 `persona.cardPath`（默认 `null`；`null` / 空串用内置卡，非字符串抛 `ConfigError('persona.cardPath')`）。绝对路径原样使用，相对路径相对 `DSH_HOME`（`DSH_HOME` trim 后非空优先，否则 `<用户主目录>/.dsh`）。`apply` 时加载一次并写入 `state.card`，替换人格段、承诺跟进称呼、轻闲聊提示词与闲聊违禁词四个使用点；`buildSections(card)` 改为必须显式传卡（`null` / `undefined` 抛清晰 `TypeError`），`DEFAULT_CARD` 只剩 `src/persona/card.js`。加载失败四类（文件不存在 / 非法 JSON / 必填字段缺失 / 其它读取错误）一律回落内置卡并写一条 warn（`[dsh-companion] persona card load failed; using built-in card`，meta 仅 `path` 与 `reason`，不含卡正文）。`/状态` 新增 `人格卡：<name> v<version>（内置默认 | <绝对路径> | 加载失败，已用内置：<原因>）`；旧调用方未传该选项时不输出此行。

### Fixed

- **review-v18 M-1：未设置 `DSH_HOME` 时相对路径回退 `~/.dsh`**（`3abc9d3`）：`resolveDshHome` 的两个 fallback（注入 `deps.homedir` 与 `os.homedir()`）统一 `join(base, '.dsh')`；显式 `DSH_HOME` 仍原样使用。修复相对 `persona.json` 被解析成 `~/persona.json`、导致「配了卡却静默回落内置卡」。补单测与生产 `apply` 用例：读到 `<home>/.dsh/persona.json`；卡放在旧位置 `<home>/persona.json` 时 ENOENT 兜底且原因指向 `.dsh` 下的解析路径。
- **review-v18 M-2：坏 JSON 不泄漏卡正文**（`3abc9d3`）：JSON 语法错误不再拼接 V8 原始 message（会回显源文件开头字符），改为 `invalid JSON（位置 <line>:<col>；<固定类别>）`；`describeParseError` 再剥离 `"..."` 回显与控制字符，保证单行、≤160 字符。五种现实形状（裸 token / BOM / 纯文本占位符 / 误写 YAML / 单引号 JSON）在 warn 与 `/状态` 均无泄漏。
- **L-1：旧 `loadCard()` 标 `@deprecated`**（`3abc9d3`）：指向 `loadPersonaCard()`，并说明配置了 `cardPath` 时不要用（ENOENT 会静默返回内置卡）。

### Changed

- **proactive 同名字段本版以配置为准、内置默认卡也参与冲突告警**（`90e3383`）：卡里的 `proactive.dailyCap` / `quietStart` / `quietEnd` 与配置 `proactiveDailyCap` / `quietStart` / `quietEnd` 不一致时写一条 warn（列出不一致字段与两边取值，不含卡正文）；运行时仍只读配置、主动节奏行为不变。文件卡与内置卡（含加载失败兜底）都参与；`chatPerDay` 无配置对应键，只记录说明。字段合并方案留 v0.4.13。
- **文档**：`docs/usage.md` 补人格卡一节（路径三种来源、四类失败兜底、`/状态` 三态示例、改卡需重启），`config.example.yml` 补 `persona.cardPath` 注释段，`docs/deploy-v0412.md` 写部署两种路径。安装面仍为 16 个基础键。

### Tests

- 新增 `test/v0412-persona-card.test.js`、`test/persona-proactive.test.js` 与 `test/e2e/persona-card.test.js`（生产 `apply` 全链路：`DSH_HOME` 与 `~/.dsh` 回退、四使用点、四类失败兜底、`/状态` 三态、proactive 冲突、坏 JSON 五形状矩阵）；`test/persona.test.js` 同步改为「必须显式传卡」。三时区 `node --test` 964/964 pass、0 fail、16 个套件；发布门 round A/B 重跑 PASS（报告见 `docs/review-round-ab-v0412.md`）。

发布前独立复审：[review-v19](docs/review-v19.md)（pass，H=0 / M=0 / L=3，均为不阻塞观察）。发布门 round A/B PASS；round C 因本机无模型凭据 `verdict=skip`（按 v0.4.11 口径不计 PASS，由部署环境首次启动补跑）。

## [0.4.11] - 2026-11-05

按用户 v0.4.11 清单修复四项：V10-H1（thread preset 可配置、未知 preset 不抛异常）、G0-9（压缩/巩固耗时阈值与告警，不中止）、V10-L1（存量 episode/FTS 一次性脱敏 scrub，幂等）、V10-M1（round C 口径与 headless 巩固限制写入文档）。仍为零第三方运行时依赖；schema 升至 v13（纯数据迁移，无新列）。本次发布 **918 个用例 / 16 个套件**，默认、`TZ=UTC`、`TZ=America/New_York` 三时区通过。

### Fixed

- **V10-H1 `thread_run` 的 preset 可配置、未知 preset 不抛异常**（`58ed1ad`）：新增可选配置 `thread.agentPreset`（默认 `null`；非空字符串 `trim` 后生效）。未配置时 `thread_run` **不传** `agentPreset`，由宿主使用默认 preset；配置后传入该值。宿主报未知 preset 时返回 `{ "ok": false, "reason": "preset_unknown", "message": "<宿主原文>" }`，不抛异常、不写 `threads` 行；其它 `createSession` 错误照常上抛。`/状态` 新增「线程 preset：宿主默认」/「线程 preset：<name>（配置：thread.agentPreset）」；`docs/usage.md` 补安装步骤（读取宿主实际 preset 列表、选够用的最小权限、不得 `danger-full-access`）。
- **G0-9 压缩/巩固耗时阈值、warn 去重与 `/状态` 展示**（`52dc3e0`）：新增可选配置 `timing.compactWarnMs`（默认 `20000`）与 `timing.consolidateWarnMs`（默认 `60000`，正整数毫秒；非法值抛 `ConfigError('timing.*')`）。`maybeCompact` 与 `executeConsolidationJob` 的成功/失败路径都采样最近耗时；超阈值只写一条 warn（同类每进程一次，出现不超阈值样本后重置），**不设硬超时、不中止压缩/巩固**。`/状态` 在压缩行后追加「最近压缩耗时」「最近巩固耗时」（无样本 `—`，超阈值标注「（超阈值）」；失败样本只记耗时，成功/失败不展示）。该节为可选段，不参与 16 键安装自检。
- **V10-L1 存量 episode/FTS 一次性脱敏 scrub**（`ca8f3d3`）：schema 升至 v13（纯数据迁移，无新列）。打开 v12 或更早（以及已有数据但无标记）的库时，对存量 episodes 的 `title` / `summary` / `evidence` / `mood_evidence` / `topics_json` / `entities_json` 一次性重跑写入路径脱敏（值级 `redactSensitiveValues`；脱敏后仍残留值形态的整段替换为 `[凭据已省略]`；JSON 数组逐项脱敏并保持合法）。只 UPDATE 真正变化的行并重建其 `fts_episodes` 投影；成功后写 `schema_meta` 标记 `episode_scrub_v13`（重复打开跳过），并写一条 `memory_events`（`action=scrub`，`detail={scanned,changed}`，不含正文）；空库不写标记、不留审计噪音。升级事务失败连同版本号回滚；按 rowid 每批 200 行。

### Changed

- **V10-M1 round C 口径与 headless 巩固限制（文档项）**：round C 的通过口径改为 **常驻实例上 8 次巩固成功**，不再要求 headless 门内完成。headless / one-shot 在 turn 结束后进程即退出，巩固由 `setImmediate` 排到后台，因此**不会发生巩固**；云端实测 `tokenMeter` 有值、`consolidations=0` 属正常。`docs/usage.md` 新增「headless 一次性运行与 round C 口径」一节；`docs/known-debt.md` 记录 `DSH_COMPANION_GATE_SYNC`、常驻版门脚本、dispose 限时等待三种门改造均未实现、属推迟项。`config.example.yml` 补 `thread.agentPreset` 可选注释段。

发布前独立复审：[review-v17](docs/review-v17.md)（pass，H=0 / M=0 / L=3，均为不阻塞观察）。

## [0.4.10] - 2026-11-05

按用户 v0.4.10 清单修复三项：V9-L1（token / 银行卡误报收窄）、V9-M1 / V9-M1b（episode 落库前凭据值脱敏，字段兜底只对残留值）、V9-L2（「口令」与设备 / 网络值漏报）。仍为零第三方运行时依赖；本次无 schema 变更（`schema_version` 仍为 12）；发布前独立复审链路为 [review-v16](docs/review-v16.md)（pass，H=0 / M=0 / L=0）。

### Fixed

- **V9-L1 token / 银行卡误报收窄**（`a6de86d`）：`SENSITIVE_PATTERN` 移除裸 `token` 与裸「银行卡 / 信用卡」，「用户这个月 token 额度约 10B」「用户的银行卡在招行」不再判敏感；token 仍由「字段名 + 是/为/:/：/= + 含数字或符号的值」兜底（`token 是 abc123`、`API token：sk-…` 仍命中），银行卡收窄为卡号形态（`CARD_NUMBER_PATTERN`：12 位以上数字，允许 4 位分组的空格或连字符），`卡号` / `card number` 字段名要求后跟数字（旧用例「银行卡号 + 卡号数字」仍命中）；强模式同时补「口令」（「密码学」负向断言保留），并新增 `DEVICE_VALUE_PATTERN`（WiFi / wi-fi / 路由器 / 路由 / 门禁 / 门锁 / 热点 + 是/为/`:`/`：`/`=` + 值，值须含数字或符号），「路由器口令是 …」「WiFi 是 …」这类表述不再漏报。
- **V9-M1 episode 落库前凭据值脱敏 + 巩固 prompt 约束**（`a4fe4e0`）：`consolidate` 写 episode 前对 `title` / `summary` / `evidence` / `mood_evidence` 与 `topics` / `entities` 逐字段调用 `redactSensitiveValues`，只把凭据值换成 `[凭据已省略]`、保留「路由器密码 …」这类上下文（不是整段丢弃）；`store.insertEpisode` 再做一次防御性值级脱敏（含 `topics_json` 字符串形态，先解析再逐项脱敏），`fts_episodes` 由主表投影故自动无明文。巩固提示词新增「不得复述密码、口令、token、卡号等凭据值；必须提及时写成「用户提到一个密码」这类描述」；`CHANGELOG` 中「episode 仍按原对话保留」的旧说明同步更正。
- **V9-M1b 字段兜底只对残留值，叙事不再被整段抹掉**（`6e1ade8`）：兜底判定由 `isSensitiveText` 改为 `hasUnredactedCredentialValue`（先剔除占位符，只认残留的卡号 / `sk-` 字面值 / 弱字段值 / 设备值），「用户提到一个密码」「我昨天忘了密码」「密码学」这类叙事保留原文；「密码 是 X - 7788」拼接形态由值尾段模式完整抹除，不残留尾号；store 侧按同一口径做值级脱敏。

### Changed

- **测试**：新增 `test/sensitive-v0910.test.js`（11 例，逐条覆盖 v0.4.10 验收正反例 + V7-M3 旧敏感面回归 + `scan` / `apply` 集成）、`test/episode-redaction.test.js`（10 例，脱敏正例 14 组、`hasUnredactedCredentialValue` 正反例 18 组、字段级兜底、store 直写防御、consolidate / `fts_episodes` 无明文）与 `test/e2e/v0910-privacy.test.js`（1 例，真实链路跨会话问「路由器密码」不召回明文、普通事实仍可召回）。用例总数 859 → 881 / 16 个套件。
- **文档**：`docs/usage.md` 的「隐私与凭据」一节补 episode 脱敏与 V9-M1/L1/L2 口径；`docs/known-debt.md` 关闭 V9-M1 / V9-L1 / V9-L2；`src/memory/govern.js` 注释中的测试凭据字面值改为占位（行为不变）。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）881/881 pass、0 fail、16 个套件；v0.4.10 三个测试文件单跑 22/22。
- 跨会话隐私 e2e 走真实 `apply()` + 后台 hard 巩固 + `retrieve`：episodes 列 / 整行 JSON、`fts_episodes`、staged+published 状态板、JSON 导出、召回 items/injected 与新会话 `decision` 均无明文，「路由器密码 [凭据已省略]」上下文与普通事实「极光展」仍在。
- 工作树干净；发布提交打 annotated tag `v0.4.10` 并推送远端。

## [0.4.9] - 2026-11-05

按用户 v0.4.9 必修清单修复七项：V7-H1（工具注册改为调用时判能力）、V7-M1（压缩起点跳过系统节点）、V7-M3（凭据类内容不落库）、V7-L1（发布门 round C 两轮）、V7-L2（巩固/压缩 `duration_ms`）、V8-L1（到期表达式索引）、V8-L2（到期口径统一）。仍为零第三方运行时依赖；发布前独立复审链路为 review-v14（needs_revision，唯一 M 为文档契约）→ `d14e2b2` 文档修复 → [review-v15](docs/review-v15.md)（pass，H=0 / M=0 / L=0）。

> **发布门说明**：本机没有模型凭据，round C 走 SKIP（**未计 PASS**，门不因 SKIP 判失败）；需在有凭据的环境复跑 `node scripts/probe/run-headless.mjs --plugin`，确认 round C 的 `verdict=pass`（第二轮真实写入 `consolidations` 且 tokenMeter 非零）。
>
> **v0.4.11 口径调整**：round C 的通过口径改为常驻实例 8 次巩固成功；headless 门不再要求完成 round C，只作激活/召回冒烟（见本文件 0.4.11 段）。

### Fixed

- **V7-H1 线程/任务工具注册改为调用时判能力**：`apply()` 不再按 `platform.capabilities.threadTools` 过滤，10 个工具一律注册；`thread_list` / `thread_run` / `task_run` 在各自的注册 `execute` 里实时读取能力，宿主未提供 `sessionController` 时返回稳定的 `{ ok: false, reason: 'capability_missing', message: '宿主未提供 sessionController，线程工具暂不可用' }`，不抛异常、不要求重装插件，能力晚挂载后同一注册项立即可用。`/状态` 与 `/线程` 同样改为命令 handler 内实时读取，文案统一为「线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）」。apply 期仍需读取的能力（`sessionEvent` / `preStep` / `turnStopping` / 段与命令与工具注册 / 调度器）逐处补注释说明原因，`measureTokens` / `maybeCompact` / `llmCapability` / `freezeThreads` 本就在调用时读取。
- **V7-M1 压缩区间起点跳过系统节点**：`src/session/surface.js` 新增导出 `firstReplaceableIndex(snapshot, from)`，`planRegion` 选定起点后立即推进到第一个可替换节点，区间内再遇系统节点则提前收尾；全部不可替换时返回 `{ region: null, reason: 'no-replaceable-range' }`。`maybeCompact` 在调用 `compactRegion` 前用同一 helper 收紧恢复的 pending 区间，收紧后为空则丢弃 pending 并计入 `compactionDrops`。系统节点（人格/平台段）从此不会被压进摘要；常规巩固、deep-sleep 与 pending 恢复三条 region 路径共用该 helper，S1 定向巩固本就不构造 region。
- **V7-M3 凭据类内容不写入 facts 与状态板**：`isSensitiveText` 的敏感面从「身份证/银行卡/密码/住址」扩展到凭据类（`密码学` 用负向断言排除，覆盖 password/passwd、验证码、CVV/CVC、私钥/密钥、卡号、api key、access token/令牌、`sk-` 字面值），新增「字段名 + 是/为/:/= + 值」形态（弱字段要求值含数字或符号，`key is abcd` 不误报）。巩固落地前统一过滤敏感事实（statement/subject/object）与敏感提醒，不写 facts、不进 FTS、不写 reminders；状态板逐行过滤并对历史库残留行再兜底 scrub（episode 落库前对凭据值脱敏（`[凭据已省略]`），原文仅存于会话）。pre-step 对命中的用户消息每 turn 注入一次隐私提示（`source.kind='companion-privacy-hint'`，不含具体值，且被转录/巩固/主会话判定排除），巩固回执返回 `sensitive` 计数与 `CREDENTIAL_HINT`。

### Changed

- **V7-L1 发布门 round C 改为同一会话两轮**：第一轮 `--patch <overlay> --json <task1>` 从 NDJSON 取 `sessionId`，第二轮 `--session-id <id>` 续跑 task2（`--patch` 必须排在 `--json` 之前，否则 CLI 报 `unknown option '--patch'`）；overlay 的 `compactHardTokens` 降到 120，两轮输入才稳定越过巩固阈值。新增纯函数 `evaluateConsolidationRound`：崩溃/未激活/缺 scheduler started 标记 → fail；无凭据 → skip（不算 PASS）；有凭据但 tokenMeter 无非零 token 或无 `consolidations` 行 → fail。
- **V7-L2 巩固/压缩 `duration_ms`**：`consolidate({ clock })` 注入毫秒时钟（生产传 `platform.now`），事务收尾把 `duration_ms = max(0, round(finish - start))` 写入 episodes 事件 `detail`（`kind: 'consolidation'`）并随返回值返回；`maybeCompact` 为压缩事件写 `memory_events`（`action='UPDATE'`、`table_name='compactions'`、`detail.kind='compaction'`、`start`/`end`/`watermark`/`duration_ms`），写事件失败只 warn。导出 `eventDurationMs(view)` 兼容 `detail_json` 字符串/对象、旧行无字段返回 `null`、负数返回 `null`、四舍五入为整数，同秒内的耗时可区分。
- **V8-L1 到期索引改为表达式索引**：到期扫描按 `status` + `max(next_fire_at, retry_at)` 过滤/排序，索引必须是同一表达式才能命中；`reminders` 的 `ix_rm_fire(status, next_fire_at)` 换成 `ix_rm_due(status, max(COALESCE(next_fire_at,0), COALESCE(retry_at,0))) WHERE status IN ('pending','snoozed')`，查询与索引共用导出的 `REMINDER_DUE_AT_SQL`。旧索引删除（裸列索引永远服务不了 max 表达式，全仓无其它按 `(status, next_fire_at)` 过滤的查询，保留只增写入放大与 planner 噪声）。迁移由 `#ensureReminderDueIndex` 幂等完成（`DROP INDEX IF EXISTS` + `CREATE INDEX IF NOT EXISTS`），在补 `retry_at` 列之后执行，旧库打开即就地补建；索引不写进 `SCHEMA_SQL`，避免旧库在补列前报 `no such column`。`schema_version` 仍为 12。
- **V8-L2 到期口径统一为 `max(next_fire_at, retry_at)`**：`dueReminders` / `buildDueRemindersQuery` 与 `index.js` 的 `onAttempt` 共用导出的 `reminderDueAt(row)`，不再各写一份 `COALESCE` 与 `Math.max`；两个时间都为 NULL 的行永不到期（另用 `next_fire_at IS NOT NULL OR retry_at IS NOT NULL` 过滤）。改期统一走新增的 `store.rescheduleReminder(id, { next_fire_at, ... })`：同一条 UPDATE 清空 `retry_at` / `occurrence_key` / `last_fire_key`、`delivery_attempts` 归零、`closed_at` 清空，只对 `pending` / `snoozed` 生效；绕过 store 的裸 SQL 改期由库级触发器 `trg_reminders_reschedule_clear_retry` 兜底（`next_fire_at` 变化且 `retry_at` 非空时清空，内层 UPDATE 不改 `next_fire_at` 故不递归）。失败退避仍只写 `retry_at`，退避未到不投递。

### Verified

- 三时区 `node --test`（`TZ=UTC` / `TZ=Asia/Shanghai` / `TZ=America/Los_Angeles`）859/859 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 新增 `test/v049-v7h1.test.js`（4 例）、`test/v049-v7m1.test.js`（7 例）、`test/v049-v7m3.test.js`（6 例）、`test/v049-v7l1-l2.test.js`（11 例）、`test/v049-v8l1-l2.test.js`（10 例）与跨项集成回归 `test/v049-regression.test.js`（6 例，经真实 `apply()` 覆盖线程晚挂载、压缩起点、凭据过滤、`duration_ms`、到期口径）；同步更新 v044/v046/c5 旧断言与 e2e 提醒投递的索引断言。用例总数 815 → 859 / 16 个套件。
- 发布门 `node scripts/probe/run-headless.mjs --plugin`：round A/B PASS；round C `schedulerStarted=true`、`tokenEvents=1`、`maxTokensIn=0`、`credentials=missing` → `verdict=skip`（无模型凭据，按契约 SKIP 不计 PASS），门 exit 0。
- 工作树干净，`git tag -a v0.4.9` 后推送远端。

## [0.4.8] - 2026-11-05

V5-L2 真机观察到的提醒退避口径修复：失败退避不再改写原定到点时间，新增 `retry_at` 独立记录重试时刻（schema v12，旧库自动升级）；调度按 `COALESCE(retry_at, next_fire_at)` 判到期；提醒展示与 `/状态` 始终用原定时间，重试期间附「重试中，下次 HH:MM」。仍为零第三方运行时依赖；发布前独立复审 pass（H=0 / M=0 / L=2），见 [docs/review-v13.md](docs/review-v13.md)。

### Fixed

- **V5-L2 提醒失败退避覆盖原定时间**：`reminders` 新增 `retry_at`（schema v12，旧行 NULL，按列检测幂等补列）。投递失败时只写 `retry_at`（第 1 次 30s、第 2 次 60s，第 3 次置 `expired`），`next_fire_at` 从此在任何失败路径都不再被改写，始终代表用户原定的到点时间。调度（`dueReminders` 的到期过滤与排序）与 `fireDueReminders` 的 `onAttempt` 二次守卫统一按 `COALESCE(retry_at, next_fire_at)` / `max(next_fire_at, retry_at ?? 0)` 判断，重试项不会因原定时间早而抢队、同 tick 双 flush 也不会重复计数或重复投递。投递成功、失败超限 `expired`、`recoverReminderDeliveries` 回收与 `expireReminder` 四条路径都清空 `retry_at`。fireKey 契约改为由调用方拼「发生时刻 + 本次重试时刻」（`<next_fire_at>:<retry_at ?? 0>`），每次真重试 `delivery_attempts` 递增，requestId 仍按 `occurrence_key` 稳定不变。
- **提醒展示改为原定时间 + 重试标注**：状态板提醒行一律显示 `next_fire_at` 的原定日期；`retry_at` 非空且尚未到期时附注「重试中，下次 HH:MM」（按 `config.timezone` 格式化，主路径 `runDeepSleep` 显式透传 `now` / 时区），已过去、为空或已过期回收后不附注。`/状态` 与提醒列表口径一致。

### Changed

- **迁移**：schema v11 → v12 在 `PRAGMA table_info` 检测后幂等 `ALTER TABLE ADD COLUMN retry_at`（旧行 NULL；`COALESCE` 自动回退到 `next_fire_at`，旧库到点行为不变）；`export.js` 的 `CURRENT_SCHEMA_VERSION` 同步为 `'12'`。
- **文档**：`docs/usage.md` 更新失败退避、requestId、schema 版本三段，并新增提醒「展示口径」示例；README 增加 v0.4.8 摘要并修正 v0.4.5 段旧退避语义。
- **测试**：新增 `test/v048-retry-at.test.js`（5 例，存储/调度层）、`test/v048-index-retry.test.js`（4 例，接线与展示）、`test/v048-regression.test.js`（7 例，经真实 `apply()` 覆盖失败两次后成功、重试未到拒绝、状态板附注出现/消失、v11→v12 迁移与三条冒烟）；同步改写 `c5`、`v045`、`v047`×2 与 e2e 提醒投递的旧 `next_fire_at` 断言。用例总数 799 → 815 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）815/815 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin` 通过；工作树干净，`git tag -a v0.4.8` 后推送远端。

## [0.4.7] - 2026-11-05

v0.4.6 后的真机反馈修复：提醒 requestId 按 occurrence 稳定并重置 attempts、`/状态` 巩固模型来源标注改为「自动选取」、provider/model 发现失败 warn 去重。仍为零第三方运行时依赖；schema 升至 v11（旧库自动升级）；发布前独立复审 pass（H=0 / M=0 / L=0），见 [docs/review-v12.md](docs/review-v12.md)。

### Fixed

- **V6-M1 提醒 requestId 随退避改写而变化**：`reminders` 新增 `occurrence_key`（schema v11），每次真正到点入队前惰性生成并固定下来，requestId 改为 `companion-reminder:<id>:<occurrence_key>`。失败后按 30s / 60s 退避改写 `next_fire_at` 重试时复用同一个 occurrence_key，因此 rpcId 逐字节不变，宿主能按 rpcId 去重、不会被当成多条提醒；`onAttempt` 若发现库里的 occurrence_key 已被换代（旧队列 part 领取新到点）则拒绝投递。投递成功、达到上限置 `expired`（含 `recoverReminderDeliveries` 回收超限行）与 `expireReminder` 时统一清空 `occurrence_key` / `last_fire_key` 并把 `delivery_attempts` 归零，下一次到点生成新 key、attempts 从 0 重新计数。此前 V5-L2 观察到的口径问题（提醒 requestId 应「按 occurrence 稳定 + attempts 重置」）在本版落地。
- **V6-L1 `/状态` 巩固模型来源标注**：运行时自动解析出的路由标注由「（运行时）」改为「（自动选取）」，配置来源为「（配置）」、宿主注入为「（宿主注入）」；`/状态` 三态措辞与 README、`docs/usage.md` 同步，不再出现「（运行时）」。
- **V6-L3 provider/model 发现失败 warn 去重**：`listProviders` 失败由 `debug` 升为 `warn`（reason=`providers`），某 provider 的 `listModels` 失败同样升 `warn`（reason=`models:<providerId>`，meta 带 provider/message）。两类各只 warn 一次，连续重试（5 分钟）不重复刷屏；对应发现成功后清该键、成功解析出 runtime 路由后整体清空，之后再失败可再次 warn。

### Changed

- **迁移**：schema v10 → v11 在 delivery 列补齐后按 `PRAGMA table_info` 幂等 `ALTER TABLE ADD COLUMN` 补 `occurrence_key`（旧行为 NULL，下次到点惰性生成）；`export.js` 的 `CURRENT_SCHEMA_VERSION` 同步为 `'11'`。
- **文档**：`docs/usage.md` 更新提醒 requestId/attempts 语义、`/状态` 标注与 warn 去重/重置，并补 schema 版本历史。
- **测试**：新增 `test/v047-occurrence.test.js`、`test/v047-l1-l3.test.js` 与跨项集成回归 `test/v047-regression.test.js`（4 例，经真实 `apply()` 覆盖同 occurrence 退避重试、成功换代、v10→v11 迁移、`/状态` 标注与两类 warn 去重）；更新 `c5-h1a`、`c5-h2`、`v044` / `v045` / `v046` 与 e2e 提醒投递断言；用例总数 789 → 799 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）799/799 pass、0 fail、16 个套件；`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin` 通过；工作树干净，`git tag -a v0.4.7` 后推送远端。

## [0.4.6] - 2026-11-05

v0.4.5 后的必修项修复：提醒投递签名与用户消息污染、线程服务公开方法名、巩固模型解析（llm 晚注册）、压缩开关可见性、跳过日志级别与 `/线程` 不支持提示。仍为零第三方运行时依赖，无 schema 变更；发布前独立复审 pass（H=0 / M=0 / L=1，Low 项已随发布修完），见 [docs/review-v11.md](docs/review-v11.md)。

### Fixed

- **C5-H1a 提醒投递签名与用户消息污染**：Prompt 调用改为 `prompt(request, signal)`，第二参固定 `AbortSignal.timeout(30000)`；提醒/承诺/闲聊分别带稳定 `requestId`（`companion-reminder:<id>:<next_fire_at>`、`companion-commitment:<id>:<dayKey>`、`companion-chat:<dayKey>:daily`），同一 claim 重试复用同一 id。宿主把提醒正文记成 `user/message` 时按 `rpcId` 前缀或 `[提醒]` 前缀识别为 companion 消息：不重绑 `main_session_id`、不进巩固窗口与转录、也不作为召回查询。投递失败写 `memory_events`（`reason='delivery_error'`）并在 `/状态` 显示「最近失败：投递失败：<name>：<message>」；同一失败原因只 warn 一次。
- **C5-H1b 线程服务方法名**：适配层改用公开 `ApiSessionList.create` / `resolveAgent`，不再调用内部 `createSession`；能力探测与 `thread_run` / `task_run` 投递同步到公开面，旧宿主仅保留只读兼容。
- **C5-H2 巩固模型解析**：不再把首次解析到的 `null` 永久缓存；运行时能力位每次重新确认，成功的 provider/model 路由缓存 5 分钟、失败不缓存，llm 晚注册后巩固与闲聊都能恢复。`/状态` 显示「巩固：<provider>/<model>（配置|运行时）」「巩固：宿主注入模型」「巩固：无可用模型」；无模型时按 60s 节流记 `consolidation_failed`。发布门 round C 在无凭据时 SKIP，有凭据时要求至少一条巩固。
- **C5-M1 压缩开关提示**：`/状态` 明确显示「压缩：宿主未开启（compaction-basic 未启用）」或「压缩：宿主已开启（compaction-basic 已启用）」，有待压缩区间时附「，待压缩 N 个区间」；文档补充云端已验证的 `cordis.patch.yml` 开启写法（`disabled: false` + `auto: false`）。
- **C5-M2 日志级别**：巩固跳过（surface 文本不全、无可用模型）由 `debug` 升为 `warn`，并按原因去重；投递失败按 `ErrorName: message` 去重，只有真正投出消息后才清空去重状态。
- **C5-L1 `/线程` 提示**：宿主没有 `sessionController` 时，`/线程` 直接返回与 `/状态` 相同的「线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）」，不查库、不返回空列表。

### Changed

- **文档**：`docs/platform-api.md` 增 §1.5 巩固模型路由与 llm 能力/适配层/错误码说明；`docs/usage.md` 增「宿主压缩开关（compaction-basic，v0.4.6）」与 `/线程` 不支持行为；`README` 同步状态、压缩能力与 v0.4.6 摘要。
- **测试**：新增 `test/c5-h1a.test.js`、`test/c5-h1b.test.js`、`test/c5-h2.test.js`、`test/c5-m1-m2-l1.test.js` 与跨项集成回归 `test/v046-regression.test.js`（7 例，覆盖 C5 六项）；用例总数 766 → 789 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`）789/789 pass、0 fail；`test/e2e/*.test.js` 127/127、`test/e2e/plugin-smoke.test.js` 4/4。
- 发布门 `node scripts/probe/run-headless.mjs --plugin`：round A（插件激活）与 round B（召回注入）PASS；round C（巩固）无模型凭据 SKIP，总判定 PASS，日志 `.data/plugin-gate.log`。

## [0.4.5] - 2026-11-05

v0.4.4 发布后评审（V4）的修复：提醒失败不再卡在 `delivering`，inject 消息形状校验点名到字段，召回加词法门槛并支持 2 字实体与短查询配置，召回块经压缩摘要回流完成调查与防线。仍为零第三方运行时依赖，无 schema 变更；发布前独立复审 pass（H=0 / M=0），见 [docs/review-v10.md](docs/review-v10.md)。

### Fixed

- **V4-H1 提醒投递失败卡 `delivering` / 重复入队**：队列键固定为 `reminder:<id>`（不再带 tick 秒），安静时段、日上限与退避期间的重复扫描只保留一份；提醒不再参与文本合并，投递前钩子逐份判定，被剔除的份回调 `onFailed`，不会留下「已 claim 未投递」的行。失败回 `pending` 时按 30s → 60s 退避（第 1/2 次），`delivery_attempts` 达到 3 次才置 `expired`；同一发生时刻复用为 `last_fire_key`，重复 tick 不额外消耗 attempts；崩溃残留的 `delivering` 启动时回收为 `pending` 补发。
- **V4-L1 inject 消息形状校验**：`mergeDecision` 对每个 `patch.inject` 元素调用 `assertInjectedMessage`，按 `id` / `role` / `content` / `source.kind` 逐项校验，错误信息以 `onPreStep "inject"[i]` 点名具体字段并抛 `TypeError`；合法召回消息原样追加，行为不变。
- **V4-M1 召回词法门槛 / 短查询**：查询长度门槛降到 `recall.minQueryChars=2`（此前写死 4），2–3 字 CJK 实体（「蓝鲸」「生日」「吃药没」）可召回；非空查询要求命中 ≥2 个不同有效 bigram 或命中比例 ≥30%，停用 bigram（今天/我们/一下/什么/怎么/可以…）及其重叠跨词 bigram 不计入命中与分母，纯寒暄查询不再注入。`recall.minQueryChars` 为 1..64 整数，非法值 `ConfigError` fail-fast。

### Changed

- **V4-L2 召回块经压缩摘要回流（调查 + 防线）**：召回块改为带 `[相关记忆] … [/相关记忆]` 成对标记；巩固窗口与转录对成对片段整段剔除，仅残留开头标记时保守保留原文；巩固提示词明确标记段是历史快照、不得据此新建事实。残余风险（标记被摘要截断）仍依赖标记完整性，结论与复现见 [docs/recall-compaction.md](docs/recall-compaction.md)。
- **文档**：`docs/usage.md` 增提醒队列/退避与 `minQueryChars` 说明；`docs/recall-compaction.md` 记录 V4-L2 调查；退避段落与实现对齐（第 3 次失败直接 `expired`，120s 档在当前上限下不可达）。
- **测试**：新增 `test/v045-regression.test.js` 跨 H1/L1/M1/L2 集成回归 6 例，`test/v045-m1-recall-quality.test.js` 52 条混合库召回质量 5 例，并扩充提醒投递、inject 校验、召回压缩用例；用例总数 743 → 766 / 16 个套件。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）766/766 pass、0 fail；`test/e2e/plugin-smoke.test.js` 4/4、`test/e2e/*.test.js` 127/127；工作树干净，发布门通过。

## [0.4.4] - 2026-11-04

v0.4.3 云端真机回报与代码评审的必修项修复：召回注入契约、提醒两阶段投递与 fired 语义、线程能力门控、服务访问与回收、主会话重绑、召回相关性门、编辑重抽、日志级别与中文命令提示。仍为零第三方运行时依赖；schema 升至 v10（旧库自动升级）。

### Fixed

- **V3-H1 召回注入让真机回合崩溃**：v0.4.3 的 `injectRecall` 返回裸内容块 `{ type: 'text', text }`，平台在 `dsh-agent-loop/lib/index.js:1067` 读取 `message.source.kind` 时抛 `Cannot read properties of undefined (reading 'kind')`。现在注入完整平台消息（`id` / `role: 'user'` / `content` / `source.kind = 'companion-recall'`），与 `dsh-time-context/lib/index.js:215-246` 的 `createUserMessage` 形状一致；`mergeDecision` 对每个 inject 元素做形状校验（`role` 非空字符串、`content` 数组或字符串），不合法直接 `TypeError`。热读（同回合）与冷读（重开会话、读 JSONL）都按同一消息形状复验。
- **召回块不再被当用户发言巩固**：巩固窗口与转录按 `source.kind = 'companion-recall'` 排除召回消息（surface 记录正文置空），避免「注入 → 巩固」自我强化；token / surface 计量口径不变（注入消息按普通 `user/message` 计价，召回内容预算仍由 `RECALL_BUDGET_TOKENS` 约束）。
- **V3-H2 提醒投递状态与 fired 语义**：主动消息不再向字面量 `'main'` 投递，改由 identity 解析当前主会话 id（解析不到与投递失败同路径，保留 backlog）。提醒改为两阶段：claim 置 `delivering` 并写 `last_fire_key` / `delivery_attempts`，投递成功才置 `fired`（同一提醒同一 fireKey 只发一次）；失败回 `pending` 并保留 `last_fire_key`，同一 fireKey 尝试 ≥3 次置 `expired`；队列条目的合并、溢出丢弃与失败都会回调 `onAttempt/onSent/onFailed`，不会留下卡在 `delivering` 的行。启动时 `recoverReminderDeliveries` 把崩溃遗留的 `delivering` 回收为 `pending`（超限置 `expired`）。
- **V3-H3② 宿主无 `sessionController` 时不再注册线程/任务工具**：`thread_list` / `thread_run` / `task_run` 仅在 `capabilities.threadTools` 为真时注册（其余 7 个工具不变），`/状态` 显示「线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）」；能力探测只读（`createSession`/`prompt`/`cancel` 齐全才为真），绝不 createSession。headless / one-shot / SDK profile 属正常降级；desktop profile 组合 web-app，`sessionController` 来源与挂载点见 `docs/platform-api.md` §1.3。
- **V3-M1 服务访问与回收**：声明的 `systemPrompt` / `timer` / `commands` / `tools` 改走属性访问（`ctx[name]`），未声明的 `compaction` / `workspaceRegistry` / `tokenMeter` 等仍走 `ctx.get()`；`apply()` 通过 `ctx.on('dispose')` 挂回收，dispose 后再 apply 不会重复注册工具、命令、system prompt 段与 pre-step。
- **V3-M2 `main_session_id` 重绑**：新增 `session.mainBinding`（`latest-user` 默认 / `first`）。默认只在「线程外会话出现真实用户输入」时把主会话重绑到最新会话并记 info 日志（旧/新 id），runtime-context、召回注入与中文命令提示都不算用户输入；`/状态` 显示「主会话：<id>（绑定 <mode>）」，提醒投递到该会话。
- **V3-M3 召回相关性门槛**：召回改为先过滤后打分——查询门跳过长度 <4、纯算术/符号与常见问候，候选需有 FTS/bigram 词法命中或向量余弦 ≥ `recall.minVectorScore`（默认 0.35），非空查询不再用 recency 硬凑。新增非枚举 `recall.*` 配置（`skipSmallTalk` 默认 true），非法值 fail-fast。
- **V3-M4 记忆改后重抽 `object_text` 并重建索引**：`/记忆 改 <id> <新内容>` 用新旧 statement 的「主体+关系」边界重抽 `object_text`（抽不出则置 `NULL`），插入新行并在同一事务刷新 FTS 与向量，旧行标 `superseded`；编辑审计 detail 增 `edited` / `reextracted`，抽不出时 `reextracted=false` 留痕。
- **V3-L1 日志镜像级别**：headless 函数型 logger 默认只镜像 `info` / `warn` / `error`，`DSH_COMPANION_MIRROR_DEBUG=1` 才带 `debug`，避免刷屏。
- **V3-L3 中文命令提示**：宿主只注册 ASCII 命令名（`/memory`、`/status`、`/cost`、`/threads` 等）；误输入中文命令时 pre-step 注入一条「请用 /memory、/status、/cost、/threads」提示（完整平台消息，`source.kind = 'companion-command-hint'`，同回合仅一次，巩固与转录排除）。

### Changed

- **召回块的可见期**：召回块随会话保留到下一次压缩，压缩后旧块才被替换。`/记忆 忘掉` 只影响之后的召回；压缩前模型仍可能看到旧块，回执不要承诺「立刻不可见」。
- **schema v10**：`reminders` 的 `status` CHECK 增加 `delivering`，新增 `delivery_attempts` 列；`#ensureRemindersDeliveryColumns` 幂等重建表并重建两个索引，兼容 v3..v9 旧库（旧行 `delivery_attempts=0`）。`src/memory/export.js` 的 schema 兜底同步到 10。
- **文档**：`docs/platform-api.md` 增 §2.1.1 完整平台消息契约与 §1.3 `sessionController` 来源/挂载点；`docs/usage.md` 增召回门槛配置、主会话绑定与 schema v10；`docs/known-debt.md` D-5 的 RSS 2.2/2.4/2.6 改为按自检值下调（例如 3.64GiB 对应 1.96/2.14/2.32）。
- **测试**：743 个用例 / 16 个套件（三时区全绿）。新增 `test/e2e/recall-injection.test.js`（fake loop 按 `dsh-agent-loop:1067` 逐条消费、JSONL 冷读、巩固层排除）、`test/e2e/reminder-delivery.test.js`（两阶段投递/重启补发/回收）、`test/retrieve-relevance.test.js`、`test/v044-m1-adapter.test.js`、`test/v044-m4-edit-reextract.test.js`、`test/v044-hardening.test.js` 与 `test/v044-regression.test.js`（v0.4.4 全项集成回归）；`test/platform.test.js` 增加 inject 形状校验；`test/e2e/plugin-smoke.test.js` 改为按 `source.kind` 识别召回消息。
- **提交归属交错说明**：V3-H3②/L1/L3 的 `307b08c` 与 V3-H2/M2 的 `2b5668f` 都改了 `src/runtime/commands.js`（H3② 先加「线程：宿主不支持」文案，M2 随后加主会话行），共享工作树按序合并，最终文件以两者组合结果为准。
- **发布门**：`scripts/probe/run-headless.mjs --plugin` 增加 round B —— 预置 1 条 fact 后发命中消息，断言无 `reading 'kind'` 崩溃且该 fact 的 `facts.first_reneed_at` 非空（召回真的注入过）；无模型凭据时明确标注 SKIP 并保留日志。

### Verified

- 三时区 `node --test`（默认 / `TZ=UTC` / `TZ=America/Los_Angeles`）743/743 pass、0 fail；发布前独立复审 `docs/review-v9.md`（pass，H=0 / M=0）。

## [0.4.3] - 2026-11-04

C-H1 / C-M1 修复：插件首次在真实 cordis 宿主上完成激活；本地加载文档改为指向入口文件。仍为零第三方运行时依赖，无 schema 变更。

### Fixed

- **C-H1 插件从未在真实 cordis 宿主上激活**：`src/index.js` 缺少 `export const inject`，cordis 4 对未声明 service 的属性读直接抛 `cannot get property "rssReader" without inject`，`apply()` 在 `ctx.rssReader` 首读即中断（DB 文件存在只是因为 `Store.open` 先于该读点）。修复：声明 `inject = ['systemPrompt', 'timer', 'commands', 'tools']`（均以真机 `.data/probe.json` 的 `capabilities.services.*.present=true` 为准；`ctx.interval` 对应 `timer` service），其余能力一律走 `ctx.get()`（未注册返回 `undefined`，不抛），缺失能力继续走 adapter 的 `unavailable()` 降级；测试席位 `now`/`cwd`/`workspace`/`rssReader`/`companion` 不再从 Context 代理直读，改由 `ctx.get()` 或 `apply(ctx, config, hooks)` 传入，缺省回落 `Date.now()` / `process.cwd()` / `process.memoryUsage().rss`。
- **旧测试 mock 掩盖 inject 约束**：新增 `test/helpers/strict-ctx.js`（Proxy 版 ctx，读未声明属性抛与 cordis 同文案的错误），12 个 e2e 的 `apply` 全部改经严格代理；`test/fakes/ctx.js` 增加 `ctx.get()`；新增 `test/c-h1-seats.test.js` 锁定席位读法与 logger 镜像行为。
- **C-M1 加载文档指向目录**：README 不再声称 `name` 可指目录，本地开发必须指向 `src/index.js`（绝对路径 / 相对 patch 文件 / `file://` URL）；指向目录会抛 `ERR_UNSUPPORTED_DIR_IMPORT`，插件不会激活。

### Added

- **`run-headless.mjs --plugin` 发布门**：用 `--patch` 把本仓库真插件挂到 headless，跑一次并断言出现 `[dsh-companion] scheduler started`、且没有 `did not activate`；完整 stdout/stderr 落盘 `.data/plugin-gate.log`（敏感值已 redact），退出码 0=通过、1=未通过、2=找不到 DSH。
- **headless logger 镜像**：headless 宿主的 `logger` 是函数对象且 `info()` 没有可见 sink（`ctx.get('logger') === undefined`），启动 marker 会被吞；现在函数形 logger 下把日志同时镜像到 stderr，桌面宿主的对象 logger 行为不变。

### Verified

- **真机 gate（Windows x64，DSH 0.2.1-rc.5，宿主 cordis 4.0.5，Node 24.21.0 / Electron 44.7.0）**：`node scripts/probe/run-headless.mjs --plugin --timeout 180000` 通过（发布门退出码 0），`dsh-companion/.data/plugin-gate.log` 第 11 行原文：
  `[dsh-companion] scheduler started {"jobs":6,"metrics":{"tokensIn":0,"tokensOut":0,"overBudget":0,"recalls":0,"rssMB":219,"capturedAt":1793785046777}}`
  同一日志中 `did not activate` / `without inject` / `cannot get property` 各 0 次。DSH 子进程 exit=1 仅因本机未配置 `DEEPSEEK_API_KEY`（`MISSING_CREDENTIAL`，预期内；marker 在 `apply()` 内、建会话之前打印）。

### Changed

- **测试**：667 → 674 个用例 / 16 个套件；新增用例覆盖 inject 声明面、严格 mock 的报错行为、席位回落与 logger 镜像。
- **文档**：`docs/known-debt.md` §1 更新 C-H1 激活口径与本次真机 gate 结果。

## [0.4.2] - 2026-11-04

v0.4.1 代码评审的 S2-M1 / E2-M1 修复，并带 L2-1 / L2-2 / L2-3。schema 升至 v9（旧库自动升级）；仍为零第三方运行时依赖；remote embedding 默认关闭。发布前独立复审见 `docs/review-v8.md`（pass，H=0 / M=0；复审提出的 M-1 与 L-1/L-2/L-4 已在发布前修完，L-5 文档档位语义已同步）。

### Fixed

- **S2-M1 `used` 升级不再沿用首次注入的时间/档位/same_context**：新增 `first_used_at` / `first_used_tier` / `used_same_context`，在真正被用上的那一刻写入，并按 `observed_at`（原话时间）当场重新判定 same_context；「首次用上」定义为首次非 same_context 的用上，same_context 的 used 照常记录、之后可被非 same_context 的 used 覆盖一次，已经是非 same_context 的不再覆盖。`first_reneed_*` 保留为 recall 对照样本，不被 used 改写，used 行允许 `first_reneed_at` 为 `NULL`。
- **M-1 后续 recall 样本不得降级 used 行**：`markFirstReneed` 对 `reneed_kind='used'` 的行整体跳过；index 档注入被用上后，full/gist 档再次注入不会把 kind 改回 `recall`、也不会补写晚于 `first_used_at` 的 `first_reneed_at`，S0 主样本与 recall 对照不再互相污染。
- **L-4 用上档位取本轮实际注入档**：`index` 档注入后紧接复述用上时，`first_used_tier` 记 `miss`，不再用库内 `fidelity` 反猜成 `clear`。
- **E2-M1 回填独立超时、推理单飞与查询回退 FTS**：新增 `vector.backfillTimeoutMs`（默认 30000ms，1–600000），回填用独立超时、查询仍用 `vector.embedTimeoutMs`（默认 300ms）；`vector.backfillBatchSize` 默认从 50 降到 8（仍允许 1–50）。local 推理单飞：同一时刻只允许一个底层推理，超时只截断等待、不取消底层计算，超时批次未结束前不再起新批；idle-probe 遇忙跳过并记 `vectorEmbedBusy`；查询遇忙立即回退纯 FTS，不排队。超时记 `vectorBackfillTimeouts`，`/状态` 追加「回填超时 N·占用 M」。
- **L-1 占用与失败指标分离**：查询遇 `EMBEDDING_BUSY` 只记 `vectorEmbedBusy`、日志降为 `debug`，不再计入 `vectorEmbedFailures`、不打 `warn`；回填占用期连续查询不会虚增失败数。
- **L2-1 same_context / Δt 改用 `observed_at`**：same_context 判定与 Δt 统一从原话时间起算，取不到时按来源 episode 的 observed/started/created 时间回退，最后才用事实的 `created_at`；避免深睡/延迟巩固把 Δt 算短、6h 判定偏严。
- **L2-3 加载单飞**：`loadInFlight` 只在底层加载真正 settle 后清空；`doLoad` 不再自套 `loadTimeoutMs`，等待方超时只放弃等待；退避后的重试复用同一个未结束的 promise，不再并行起第二个加载。

### Changed

- **schema v8→v9**：`facts` 增加 `first_used_at` / `first_used_tier` / `used_same_context` 与 `ix_facts_used` 索引；v8→v9 只推进版本，列由打开时检测补齐，重复打开幂等，旧行新列为 `NULL`；`fact_vectors` 与已有数据不变。`reneed_kind` 触发器改为由 `RENEED_KINDS` 常量生成（L-2），不再维护两处字面量。
- **L-3 判定（不收紧）**：`vector.backfillBatchSize` 维持允许 1–50、默认 8；复审原文「8–16」按「默认值建议」理解，不把上限收紧到 16。
- **L2-2 修正 v0.4.1 用例数口径**：按标签实测，v0.4.0 为 626、v0.4.1 为 646，v0.4.1 的「639 → 646」改为「626 → 646」（+20）。
- **测试**：646 → 667 个用例 / 16 个套件（新增 S2-M1 用上语义、v8→v9 迁移、M-1 与 L-1 回归）；默认、`TZ=UTC`、`TZ=America/Los_Angeles` 三时区全绿。
- **文档**：`docs/s0-calibration.md` 改用 `first_used_at` / `used_same_context` 主样本口径，说明 Δt 以 `observed_at` 起算、recall 仅对照、same_context used 可被覆盖与选择偏差，并补 `first_used_tier=miss`（沉睡档用上）定义；`docs/embedding.md` 补回填超时、批量 8、推理/加载单飞、查询回退与 busy/failures 指标口径；`docs/known-debt.md` 更新 D-4 真机项与 L2 关闭状态；README 状态、配置表与已知限制同步为 v0.4.2；`docs/usage.md` 同步 `/状态` 文案、配置示例与 schema 演进。

## [0.4.1] - 2026-11-04

v0.4.0 评审的 E-M1 / S-M1 / L-2 修复。schema 升至 v8（旧库自动升级）；仍为零第三方运行时依赖；remote embedding 默认关闭。复审见 `docs/review-v6.md`（pass，H=0 / M=0）。

### Fixed

- **E-M1 local embedding 阻塞首个 turn**：`local` 的加载等待与推理都受 `vector.embedTimeoutMs`（默认 300）约束，超时抛 `EmbeddingTimeout`（`kind=transient`），后台加载继续（`loadTimeoutMs` 硬上限 180s）；启动与 idle-probe 异步预热，不 await 在 turn 路径上；加载期间召回本轮回退纯 FTS、不向用户抛错，加载完成后下一轮走向量。缺依赖（`ERR_MODULE_NOT_FOUND` / `Cannot find module`）→ fatal 停用 local 只记日志；网络/超时/初始化失败 → transient 指数退避（1/2/4/8s，第 5 次后 60s 冷却，不永久停用）。新增指标 `vectorEmbedLoadFailures` / `vectorEmbedFatal`。
- **S-M1 W5 把「被注入」当「被需要」**：`reneed_kind` 增加 `used`，只有下一轮复述重叠 ≥0.6 才把首次样本从 `recall` 升级为 `used`（保留首次时间/档位）；S0 主口径只统计 `used` / `dedupe` / `correction`。新增 `same_context` 列，写入间隔 <6h 或来源 episode 仍在当前 surface 的即时召回标 1，统计默认排除，避免压低 S0 有效样本。
- **L-2 确认词长度上限**：去掉标点/空白后超过 10 字不再算确认（`CONFIRM_MAX_CHARS`），「对，我明天要去北京开会，顺便……」不再触发 α=4；「对」「没错」「嗯，对。」仍算确认。

### Changed

- **schema v7→v8**：`facts` 增加 `same_context` 列；`reneed_kind` 合法值（含 `used`）改用幂等触发器校验，不重建表；旧库整体单事务升级，重复打开幂等，旧 v7 样本 `same_context=0`。
- **测试**：626 → 646 个用例 / 16 个套件（v0.4.0 tag 实测 626、v0.4.1 tag 实测 646，原「639 → 646」的起点有误；新增 E-M1/S-M1/L-2 集成与回归）；默认、`TZ=UTC`、`TZ=America/New_York` 全绿。
- **文档**：README 增补 local 超时/预热/FTS 回退并更新 schema v8 埋点；`docs/embedding.md` 补 local 超时与预热、错误分类与退避、schema v8；`docs/s0-calibration.md` 改为「用上为主、注入仅对照」两层口径并更新 SQL；`docs/known-debt.md` 登记 E-M1/S-M1 已关闭与新增债务；新增 `docs/review-v6.md`。

## [0.4.0] - 2026-11-04

v0.3.2 评审的 R-M1 / R-L1 / R-M2 / R-L2 / N-L1 / N-M3 修复，并入 W4 embedding 可插拔与 W5 S0 首次再需要埋点。schema 升至 v7；仍为零第三方运行时依赖；remote embedding 默认关闭。复审见 `docs/review-v5.md`（pass，H=0 / M=0 / L=2）。

### Fixed

- **R-M1 / R-L1 外部压缩吞掉未巩固内容**：`resolveReanchor` 按 surface 位置取替换节点（不再 `Math.min`）；压缩跨过旧水位时把锚点前挪到平台摘要之前，让摘要进入下一次巩固，`compactionLostUnconsolidated` 记录丢失节点数；重锚后强制刷新 surface 正文。`/状态` 增加「水位重锚」「未巩固被压缩」。
- **R-L2 冷启动锚点哨兵**：锚到起点时落库 `-1`，重启后还原为内存水位 0，不再被误判为「已重锚」而跳过整段抽取。
- **R-M2 thread_run 持槽退化**：create 分支直接传会话句柄；reuse 反查失败与 900s 兜底写 warn 并记 `threadSlotFallback` / `threadSlotTimeout`，随后释放槽。
- **N-L1 确认词边界**：仅整句 / 独立小句 / 句首短尾的「对、是、记住了」等触发 α=4 强化，并加否定守卫；「对比一下」「好像不太对」不再误判。
- **N-M3 RSS 三档可配置**：`rssWarnGiB` / `rssStopGiB` / `rssMainOnlyGiB`（默认 2.95/3/3.15GiB，严格递增校验）；4G 云端可降到 2.2/2.4/2.6；`/状态` 显示三档。

### Added

- **W4 embedding 可插拔**：`vector.embedder` 支持 `hash`（默认，零依赖）/ `local`（可选 `@huggingface/transformers`）/ `remote`（默认关闭，显式开启后原文发往第三方端点）/ `none`；`embedder_id` 隔离不同模型的向量，换模型后由 idle-probe 分批回填；失败/超时降级纯 FTS 并记 `vectorEmbedFailures`。
- **W5 S0 首次再需要埋点**：`facts.first_reneed_at` / `first_reneed_tier` / `reneed_kind` 与 `(scope, first_reneed_at)` 索引，召回 full/gist、去重命中沉睡/墓碑、用户纠正三条路径幂等记录首次样本；流程与 SQL 见 `docs/s0-calibration.md`。
- **`docs/known-debt.md`**：Gate 0 九项真机联调清单、h1-h3-probe §4 四项待实测、N-M4/W1 / N-L2 / N-L3 / W4 local 真机 / Linux 2C4G 内存复测等未做项与排期。

### Changed

- **schema v5→v7**：v6 给 `fact_vectors` 增加 `embedder_id` 并回填 `hash:<dim>`；v7 给 `facts` 增加 `first_reneed_*` 三列与索引；旧库按列检测逐级迁移，旧向量按 hash 重建，旧事实的埋点三列为 NULL。
- **测试**：626 个用例 / 16 个套件；默认、`TZ=UTC`、`TZ=America/New_York` 全绿。
- **文档**：README 增补 v0.4.0 行为、配置与已知限制；usage 增补执行槽、embedding 选型、外部压缩重锚与 schema v7；新增 embedding / known-debt / S0 文档交叉链接。
- **依赖与兼容**：仍零第三方运行时依赖；`remote` 默认关，未开启时路径与 v0.3.2 一致。

## [0.3.2] - 2026-11-04

v0.3.1 评审的 N-H1 / N-M1 / N-M2 修复。无配置键变更、无 schema 变更（仍为 v5），升级不需要迁移。

### Fixed

- **N-H1 水位重锚**：外部压缩（平台自动压缩、用户 `/compact`、pending 过期后再次压缩）会让原水位 seq 从 surface 消失，此前 `stale-watermark` 只记 debug 日志后永久跳过巩固。现在 pre-step / 调度 / 深睡在选区前调用 `ensureWatermark`：优先取「不在上一版 surface 里的最小 seq」（替换节点之后），seq 重映射时取当前首节点，无历史时锚点 0 整段重来；锚点写入 `schema_meta` 的 `watermark_anchor:<scope>`，巩固或压缩成功后清除；`/状态` 增加「水位重锚」计数，warn 日志带 scope/anchor/mode。
- **N-M1 按 scope 的待压缩槽**：`pendingCompact` 由单槽改为 `Map<scope, pending>`，主会话与线程互不覆盖；apply 启动时按 scope 恢复各自最新的 `written` nap 行。
- **N-M2 共用执行槽**：`thread_run`（带 `goal` 时）与 `task_run` 共用 `createTaskRunner` 的同一个执行槽；槽忙时立即返回 `{ok:false, reason:"busy"}`，不再绕过串行槽并发创建第二个执行态。不带 `goal` 的线程创建/复用不占槽。

### Changed

- **测试**：546 → 551 个用例（新增 `test/pending-compact.test.js` 3 个、`test/tools.test.js` 共享槽 1 个、`test/e2e/external-compaction.test.js` 1 个），三种时区全绿。
- **文档**：README 增补外部压缩重锚、按 scope 待压缩槽、单执行槽三条行为说明；版本与用例数更新为 0.3.2 / 551。

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
