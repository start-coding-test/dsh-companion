# v0.4.10 R1 复审（review-v16）：V9-M1 / V9-L1 / V9-L2 关闭核验

- **复审人**：reviewer（独立复审）
- **日期**：2026-11-05
- **复审对象**：基线 `40c510d`(v0.4.9) → `a6de86d`(t1, V9-L1/L2) → `a4fe4e0`(t2, V9-M1) → `6e1ade8`(t6, V9-M1b) → `6b2c7e4`(t7, 注释字面值清理) → `d891b2a`(t3, 集成回归 + 文档收口, HEAD)
- **方式**：只读 diff/源码逐行核验 + 41 例独立探针（临时目录，直跑生产 `src/memory/govern.js`，无 :memory: 脏文件）+ 亲跑三时区全量与 v0.4.10 三测试文件 + 残留字面值全库扫描
- **结论**：**pass（H=0 / M=0 / L=0）** —— V9-M1（episode 凭据脱敏）、V9-L1（token/银行卡误报）、V9-L2（口令/WiFi 漏报）全部关闭且有可复现证据，**v0.4.10 复审链路通过，可进入发布（版本号 0.4.10 + tag + push 归 t5）**。

## 1. 结论计数表

| 必查项 | 结果 | 关键证据 |
| --- | --- | --- |
| V9-L1 误报收窄（实跑，非断言转述） | ✅ | 探针：token 额度 10B / 银行卡在招行 / 信用卡账单已还 = false；token 是 abc123 / API token：sk-xxxxxx / 银行卡 6222 0202 0000 1234 = true；`govern.js:57/:70/:76/:92-101` |
| V9-L2 漏报补齐 | ✅ | 探针：路由器口令是蓝鲸-7788 / WiFi 是 蓝鲸-7788 / 门禁口令：8848 / 热点 是 shark-2026 = true；WiFi 是 公司网络 = false；`govern.js:57（口令强词）/:76（DEVICE_VALUE_PATTERN）` |
| V9-M1 落库面全景无明文 | ✅ | `consolidate.js:404-414/:642/:672-688` + `store.js:548-552/:1429-1435`；e2e `test/e2e/v0910-privacy.test.js:210-294` 覆盖 episodes 列/整行 JSON、fts_episodes、searchBigram、状态板 staged+published、JSON 导出、召回 items/injected、跨会话 decision |
| V9-M1b 不过度（叙事保留） | ✅ | 探针 + `consolidate.js:381-385` + `store.js:522-540`：hasUnredactedCredentialValue 只认残留值，纯词提及 false（41 例探针中 M1 段 8 例、M1b 段 10 例） |
| store.insertEpisode 防御性脱敏 | ✅ | `store.js:1429-1435` 六处 `redactEpisodeInput`（含 topics/entities JSON 字符串解析路径 `store.js:526-534`）；fts 由 `#refreshEpisodesFts` 主表投影 `store.js:1446` |
| 巩固 prompt「不得复述」约束 | ✅ | `consolidate.js:539`；e2e `test/e2e/v0910-privacy.test.js:207` 断言 prompt 含约束文本，`test/e2e/v0910-privacy.test.js:199-205` 确认模型仍见原文 |
| e2e 走生产路径且不可被空实现骗过 | ✅ | FakeCtx → `apply()`（strict ctx）→ `agent/pre-step` 后台巩固 → `retrieve`+`assemble` 真实链路（`helpers.js:343-351`）；正负断言成对（episode 存在且含 `[凭据已省略]` 且无明文、召回须命中「路由器密码」又不得含 SECRET、普通事实「极光展」必须仍可召回），整体清空即 fail |
| CHANGELOG 旧措辞移除 | ✅ | CHANGELOG.md:15 新措辞「episode 落库前对凭据值脱敏（`[凭据已省略]`），原文仅存于会话」；`git grep 'episode 仍按原对话保留'` exit 1（0 命中） |
| known-debt 三项关闭措辞 | ✅ | `docs/known-debt.md:130-132` §5 逐条关闭 V9-M1/L1/L2，commit 号与实现口径与源码一致 |
| 回归（三时区亲跑） | ✅ | 默认 / TZ=UTC / TZ=America/Los_Angeles 各 881 pass / 0 fail / 16 suites；v0.4.10 三测试文件单跑 22/22 pass |
| 字面值残留扫描 | ✅ | `git grep '蓝鲸-7788' -- src docs/known-debt.md docs/usage.md CHANGELOG.md README.md` exit 1（0 命中）；剩余命中仅在 test/（用例原文，预期）与 docs/review-v14.md（历史评审） |
| 范围 / 依赖 / 发布状态 | ✅ | diff 白名单 9 文件（CHANGELOG/docs×2/src/memory×3/test×3）；package.json dependencies/devDependencies 实测 null；memory/ 与 user profile 未动；`git status` 干净；`git tag` 最新 v0.4.9；`main...origin/main [ahead 5]` 未 push |

## 2. 逐项核验

### 1) V9-L1 误报收窄 ✅

- `src/memory/govern.js:57` `SENSITIVE_PATTERN` 已无裸 `\btoken\b`、无裸「银行卡|信用卡」；「卡号」只允许「字段名 + 数字」（`卡号\s*(?:是|为|:|：|=)?\s*\d`），纯提及「卡号」不再命中。
- 卡号形态收口在 `govern.js:70` `CARD_NUMBER_PATTERN = /\d{12,}|\d{4}(?:[\s-]\d{4}){2}(?:[\s-]\d{1,4})?/u`。
- token 的误报防线改由 `govern.js:63` `CREDENTIAL_FIELD_PATTERN`（值须含数字/符号）兜底：探针「用户这个月 token 额度约 10B」→ false、「token 是 abc123」→ true。
- 探针覆盖：银行卡在招行 / 信用卡账单已还 = false；连号、空格、连字符三种卡号 + 「银行卡号 6222」= true；「我的卡号忘了」= false。
- 测试层 `test/sensitive-v0910.test.js`（11 例）另有 V7-M3 旧敏感面回归与 scan/apply 集成（sensitive 计数不把 token 额度事实计入），亲跑 pass。

### 2) V9-L2 漏报补齐 ✅

- `govern.js:57` 新增「口令」强词；`govern.js:76` `DEVICE_VALUE_PATTERN = /(?:wi-?fi|路由器|路由|门禁|门锁|热点)\s*(?:是|为|:|：|=)\s*([^\s，。；,;]{2,})/iu`；`govern.js:100` 要求值含数字/符号（`/[\d\p{P}\p{S}]/u`）。
- 探针：「路由器口令是蓝鲸-7788」「WiFi 是 蓝鲸-7788」「门禁口令：8848」「热点 是 shark-2026」均 true（修复验收正例）；「WiFi 是 公司网络」「路由器坏了」false（不误报）。回归面「密码学」「keyboard is broken」仍 false。

### 3) V9-M1 脱敏落库全景 ✅

- **分层一致且双保险**：
  - 巩固层：`consolidate.js:642` 经 `redactEpisode` 写前逐字段（title/summary/evidence/mood_evidence/topics/entities）→ `redactEpisodeField`（`consolidate.js:381-385`）值级替换 + 残留值整段兜底；调用点 `consolidate.js:672-688` 全部传 `safeEpisode`。
  - 存储层：`store.js:1406-1445` `insertEpisode` 六处 `redactEpisodeInput`，`topics_json` 字符串先 JSON.parse 再逐项脱敏保持 JSON 合法（`store.js:526-534`，含坏 JSON 退化整段脱敏）；兜底口径 `store.js:548-552` 与 consolidate 同为 `hasUnredactedCredentialValue`。
  - `fts_episodes` 无独立写入面，由 `store.js:1446` `#refreshEpisodesFts(id)` 从主表再投影——主表无明文则 FTS 无明文。
- **值级 vs 整段分层的分工与规格一致**：值级脱敏在 store 侧也适用，整段兜底只在 consolidate 层；探针验证 `redactSensitiveValues` 幂等、非字符串原样、占位符不再二次脱敏。
- **e2e 全景（生产路径）**：`test/e2e/v0910-privacy.test.js` 经 FakeCtx → strict ctx `apply()` → `agent/pre-step`（41K token 跨阈）→ 后台 hard 巩固（真实 LLM stub 流回 DRAFT）→ `publishBoard(restart)` → `exportAll(json)` → `retrieve+assemble` → 新会话 `agent/pre-step`，六面断言（episodes 列/整行 JSON/fts/searchBigram/状态板 staged+published/导出/召回 items/injected/新会话 decision）均 `doesNotMatch /蓝鲸-7788/`，同时正向断言 `路由器密码` 与 `[凭据已省略]` 仍在、普通事实「极光展」跨会话仍可召回（防一刀切误杀）。
- **空实现免疫**：若脱敏被删，`SECRET_RE` 命中即 fail；若整段 episode 被丢，`episodes.length===1`、召回 kind==='episode'、注入 match「路由器密码」即 fail。正负断言成对，无单边 tautology。
- **提示词确认**：巩固 prompt 侧约束在 `consolidate.js:539`（文案含「不得复述密码、口令、token、卡号等凭据值；必须提及时写成「用户提到一个密码」这类描述」），e2e :207/:208 同时断言 prompt 含约束与「用户提到一个密码」示例——提示词与现行行为（叙事不再被整段抹掉）一致。

### 4) V9-M1b 不过度 ✅

- `govern.js:184-194` `hasUnredactedCredentialValue`：剔占位符后只认四类残留值（卡号 / `\bsk-[A-Za-z0-9]{6,}/iu` / `CREDENTIAL_FIELD_PATTERN` 值含数字·符号 / `DEVICE_VALUE_PATTERN` 值含数字·符号）。
- 探针：「用户提到一个密码」「我昨天忘了密码。」「用户问起密码学」原样（redact 原文返回、hasUnredacted=false）；「路由器密码 蓝鲸-7788」→「路由器密码 [凭据已省略]」不整段；「密码 是 蓝鲸 - 7788」拼接形态值尾段完整抹除、不残 7788；「卡号 6222020200001234」「key 是 sk-proj9f8e7d6c5b」仍残留判定 true。
- 测试层 `test/episode-redaction.test.js`（10 例）含 hasUnredactedCredentialValue 正反 18 组、字段级、consolidate e2e 内联脱敏期望、store 直写叙事保留，亲跑 pass。

### 5) 注释字面值清理（t7）✅

- `src/memory/govern.js` 注释示例 10 行已改占位（蓝鲸-7788→蓝鲸-****、6222 →****、abc123→abc***、sk-xxxxxx→sk-****** 等），再扫描 `git grep '蓝鲸-7788|6222 0202|sk-proj9f8e7d6c5b|hunter2|8848|abc123' -- src docs/known-debt.md docs/usage.md CHANGELOG.md README.md`：src 0 命中。
- 已知存活：`docs/known-debt.md:131` 唯一命中 `abc123`——为验收用例转述（「`token 是 abc123` 仍命中」），属文档示例值而非凭据字面值；`test/` 与 `docs/review-v14.md` 按历史约定保留。不构成 finding。

### 6) 文档口径 ✅

- `docs/known-debt.md:130-132` 三条关闭记录与源码口径一致（episode 逐字段脱敏 + 防御层 + FTS 投影 + e2e 证明；SENSITIVE_PATTERN 收窄细节；口令/设备值模式判定条件）。
- `docs/usage.md:430-441` 隐私节改口径：「银行卡只拦卡号形态…纯提及不拦」「设备/网络值…值须含数字或符号，`WiFi 是 公司网络` 不拦」「episode 落库前逐字段脱敏…不是整段丢弃；脱敏后仍残留可识别凭据值时才整段替换。原文仅存于会话」——与 `govern.js:57/:70/:76/:92-101/:184`、`consolidate.js:381-414`、`store.js:522-552` 行为逐点一致。

### 7) 回归 / 范围 / 发布状态 ✅

- 三时区亲跑（默认 / TZ=UTC / TZ=America/Los_Angeles）：各 **881 tests / 881 pass / 0 fail / 16 suites**。v0.4.10 三测试文件（sensitive 11 + episode-redaction 10 + e2e 1）单跑 **22/22 pass**。
- `git diff 40c510d..HEAD --name-status`：仅白名单 9 文件（CHANGELOG.md、docs/known-debt.md、docs/usage.md、src/memory/{govern,consolidate,store}.js、test/{sensitive-v0910,episode-redaction}.js、test/e2e/v0910-privacy.js），无 package.json / memory/ / profile 改动；运行时依赖实测 `null`（零新增依赖）。
- `git status --porcelain` 干净；`git tag` 最新 v0.4.9（无 v0.4.10 tag）；`main...origin/main [ahead 5]` 未 push；package.json 版本仍 0.4.9 归 t5 发布提交。

## 3. 复审裁定

- t1/t2/t3/t6/t7 五份依赖结果的验收口径全部复现：本复审另用 41 例独立探针直跑生产 `src/memory/govern.js`（不经测试脚手架）复核判定函数行为，未发现与断言不符之处。
- 未发现 H/M findings；标记 L 级观察 0 项（`docs/known-debt.md:131` 的 `abc123` 为验收用例转述，见 §2.5，不计 finding）。
- **v0.4.10 复审结论：pass（H=0 / M=0 / L=0），可进入发布提交**（版本号 0.4.10、CHANGELOG 版本段、tag、push 按发布流程由 t5 执行）。
