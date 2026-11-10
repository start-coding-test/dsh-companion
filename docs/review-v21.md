# dsh-companion v0.5.1 独立复审

- 复审结论：**pass**
- 发现计数：**H = 0，M = 0，L = 5**（L 均不阻塞发版，其中 L-4 为设计口径观察）
- 复审对象：`main` @ `45c3b45`（`docs(release): v0.5.1 changelog and README summary`）
- 基线：`121f2c8`（v0.5.0）
- 复审环境：Windows，捆绑 Node **v24.21.0**
  `C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 复审方式：独立 worktree + 独立探针；未改任何源码、未 push。

> 范围说明：任务给的区间到 `ec8c9b6` 为止；实际 `main` 在之后又多了 `fcc759c`（V50-L3 使用文档）与 `45c3b45`（发版文档）两个提交。本复审以当前 HEAD `45c3b45` 为准，`121f2c8..HEAD` 共 **12 个提交 / 32 文件 / +2844 −127**。

---

## 1. 逐条验收

| 验收项 | 结论 | 证据（源码 + 独立探针） |
|---|---|---|
| **V50-H1** 节律/安静不按每轮增量写状态 | **通过** | `src/persona/emotion.js:503-517`（`targetFor` = baseline + circadian + quietOffset）；`:398-432`（`decay` 的 `anchor = target`）；`src/persona/emotion-wiring.js:118-130`（目标先算、状态朝目标衰减）、`:150-163`（事件增量与 `environmentDeltas` 分离）。探针：11:00 50 条中性最大偏差 **0**；02:00 quiet 30 条「嗯」最大偏差 **0**；72h 每小时一条全程无 0/100；事件推高后 6h 恰为半衰距离。 |
| **V50-M1** 区分「冲她」与「用户自述疲惫」 | **通过** | `src/persona/emotion.js:190`（blame 第二人称/名字 + 负面词）、`:197`（vent 第一人称/今天… + 疲惫词，且排除「你累不累」）、`:249-261`（两套专属句）、`:704-716`（`describe` 按 `eventType` 选句）。探针：「你好烦」→ `blame 0.74`，pleasure −7.94；「今天加班好累」→ `vent 0.68`，pleasure −1.77、dominance +0.59、energy 0；混合句仍 `vent`；四句注入句均正确。 |
| **V50-M2** 未注册占位符降级、注释剥离、`interpolate:false` | **通过（主路径）**，边界见 **L-2** | `src/persona/card.js:108-114`（先剥注释、替换 char/user、再降级）、`:130-134`（`{{x}}`→`{x}`，残余 `{{`→`{`）、`:446-485`（加载期清洗字段）、`src/persona/sections.js:271`（所有自建段 `interpolate:false`）、`:118-124`（状态板也 `interpolate:false`）、`src/persona/shadow.js:87-95`（rewrite 段 `interpolate:false`）。探针：含 `{{random:a,b}}`/`{{time}}`/`<!-- -->` 的卡 5 段全部 `interpolate:false`，卡段与闲聊提示词无 `{{`、无注释；rewrite 段也带标记。 |
| **V50-M3** 情绪句改 `systemPrompt.context()` | **通过** | `src/index.js:461-478`（仅 `emotion.enabled===true` 注册 `companion-emotion`，order 320，`interpolate:false`）；`:2814-2832`（路由、子代理返回空串、记录最近一句）；`src/persona/assembly-record.js:101-106`。探针：关闭时 context 注册 **0**、`emotion_state` 无行；开启时同句连续三轮 projector 快照 **1** 条，文本变化后 **2** 条；子代理 provider 文本 **空串**。append/supersede 限制已在 `docs/emotion-injection.md:82-95`、`:219-221` 如实写明。 |
| **V50-L1** takeover 不处理 `harness:identity`，文档写理由 | **通过** | `docs/persona-shadow.md:121-128` 明确写出 order −1000、宿主自述、移除会破坏环境/工具契约、完整自毁论证；`src/persona/shadow.js:58-119` 的 takeover 只摘 prefix 与非空 suffix，未触碰 identity。 |
| **V50-L2** 卡文本 HTML 注释在渲染前剥离 | **通过（常规闭合注释）**，边界见 **L-2** | `src/persona/card.js:108-114`、`:145-176`；闭合注释在 `description`/tone/list 中均被剥离；探针 `你是{{char}}<!-- 备注 -->，现在是{{time}}。` → `你是{{char}}，现在是{{time}}。`。name/address 与未闭合注释是边界。 |
| **V50-L3** `/status` 最近一次装配 | **功能通过**；时间字段见 **L-1**，段范围见 **L-4** | `src/runtime/commands.js:672-692`；`:607-609` 追加到 `/状态`；`src/persona/assembly-record.js:63-79`、`:87-93`、`:101-106`。探针：段字数/hash 与 `ctx.sections` 前 8 位一致（core 218/`3db1a9a3`）；卡正文哨兵未出现；模式/prefix 正确。shadow 实际发生在 now，行却显示「1 小时前」。 |
| **发版门：三时区全绿** | **通过** | 默认 / `TZ=UTC` / `TZ=America/New_York` 均 **1162 tests / 33 suites / 1162 pass / 0 fail**。 |
| **发版门：round A/B** | **通过（结构核对）** | `.data/plugin-gate.log` 22:21:43：A `schedulerStarted=true didNotActivate=false`；B 同前且 `recallCrash=false`、`firstReneedAt=1794320501`；C 无凭据 `verdict=skip`。门脚本 `scripts/probe/run-headless.mjs:562-568`、`:586-605`、`:635`。 |
| **发版门：逐字节基线** | **通过** | 同脚本两侧：`total=41bb0145…`、`chatBare=1904ed77…`、`chatCtx=ecd5a198…` 全部相等；分 段 hash 也相等。详见 §2.1。 |
| **发版门：schema 不升** | **通过** | `src/memory/store.js:81` 与 `src/memory/export.js:87` 均为 `'14'`。 |

---

## 2. 关键探针与结果

### 2.1 逐字节基线

基线 worktree：

```powershell
git -C D:\test\agent-plugin\dsh-companion worktree add --detach D:\test\wt-r21-v050 121f2c8
```

同一脚本分别 import 两侧源码，dump：

- `buildSections(DEFAULT_CARD)` 的 `{name, order, text}` 数组 JSON 的 SHA-256；
- `buildChatPrompt` 两个用例的 SHA-256。

```text
base  total=41bb0145b4b9d0f10fea0165b6421843bdfa1e581708371ce30e41f3efeff91d
head  total=41bb0145b4b9d0f10fea0165b6421843bdfa1e581708371ce30e41f3efeff91d
base  chatBare=1904ed77a2cf9445e003e444a1cacae1ee39e30078779e63546e6d45b78f0df1
head  chatBare=1904ed77a2cf9445e003e444a1cacae1ee39e30078779e63546e6d45b78f0df1
base  chatCtx=ecd5a198ec2d6184becbcce83c441250df863673bde9340c5394c1fb98e9bc6c
head  chatCtx=ecd5a198ec2d6184becbcce83c441250df863673bde9340c5394c1fb98e9bc6c
```

分段（两侧完全相同）：

| 段 | chars | SHA-256 |
|---|---:|---|
| `persona:safety` | 202 | `f6674ce158a44b29d07deebc12393974292b66ac873992fca03d4d1ccd0f1a27` |
| `persona:core` | 246 | `2c2bf0d51048619223580470c27e1ec3ecc3a7c76f9bb57a104a46e82b73d928` |
| `persona:protocol` | 189 | `3583cacf66261008fcc8b91207a8f945dd79de558c61c1d40ec4f48bbc9bc38b` |

`chatCtx` 参数（与 `docs/review-v20.md:512-514` 的旧脚本一致）：

```js
buildChatPrompt({
  card: DEFAULT_CARD,
  recentTopics: [{ title: '交周报', summary: '周五前交' }],
  recallSummary: '- [事实] 周报周五交（2026-11-01）',
  messageCount: 8,
})
```

`chatBare` 参数为 `{ card: DEFAULT_CARD }`。

> **口径说明（不判缺陷）**：船长给出的 `total=b853a0bd…`、`chatB=2a02092a…` 在本脚本/参数下无法复现；我的 `chatBare` 正好等于船长 `chatA=1904ed77…`，`chatCtx/chatBare/total` 与 review-v20 的旧记录一致。两侧逐字节相等这一结论不受影响；若要核对船长引用的具体值，需要船长提供那一次的脚本或参数。未据此判 H/M。

### 2.2 V50-H1 漂移

脚本：`D:\test\agent-plugin\.probe-v21\h1.mjs`、`h1-positive2.mjs`（临时 Store，固定时钟，Asia/Shanghai）。

```text
11:00 targetFor = {pleasure:53, arousal:51.75, dominance:52, energy:62}
50 条中性「帮我查下明天天气」
maxDeviation = {pleasure:0, arousal:0, dominance:0, energy:0}
末状态 = target（完全相等）

02:00 quiet targetFor = {pleasure:48.33, arousal:46.67, dominance:47.75, energy:47.67}
30 条「嗯」
maxDeviation = 0；末状态 = target

72h 每小时一条中性「嗯」
min = 48.228635469494186
max = 60.3066578456111
任一一维 <= 0 或 >= 100：false
```

事件后回目标（11:00，`谢谢你`，半衰期 6h）：

```text
before        {pleasure:53, arousal:51.75, dominance:52, energy:62}
event deltas  {pleasure:+6.25, arousal:+1.25, dominance:+1.25, energy:+0.63}
peak          {pleasure:59.25, arousal:53, dominance:53.25, energy:62.625}
6h 后         {pleasure:56.125, arousal:52.375, dominance:52.625, energy:62.3125}
```

6h 后每维 = target + (peak − target) / 2，误差 0.000，符合半衰期验收。

> H1 备注：冷启动首轮会写一条 `ambient` 事件（`environmentDeltas = target − baseline`，`src/persona/emotion-wiring.js:158-160`），这是既有审计设计（`test/emotion-context.test.js:322-342` 也把中性轮的 event 类型断言为 `ambient`），**不会逐轮累加**，状态偏差仍为 0；不构成验收失败。

### 2.3 V50-M1 分类

脚本：`D:\test\agent-plugin\.probe-v21\m1.mjs`（16:00，事件增量与节律分离）。

| 输入 | classify | 状态 | 事件增量（P/A/D/E） | 注入句 |
|---|---|---|---|---|
| `你好烦` | `blame` 0.74 | `42.064 / 51.86 / 48.76 / 58.76` | `−7.94 / +1.86 / −1.24 / −1.24` | 现在心里被扎了一下，先稳住，别赌气，话少一点 |
| `今天加班好累` | `vent` 0.68 | `48.23 / 49.41 / 50.59 / 60` | `−1.77 / −0.59 / +0.59 / 0` | 现在有点心疼，先接住这份累，陪着就好 |
| `今天加班好累，你也不容易` | `vent` 0.68 | 同 vent | 同 vent | 同 vent |
| `你这几天累不累` | `share` 0 | 无事件 | 0 | 默认 `DESCRIBE`（非 vent） |

结论：blame 的 pleasure 下调明显，vent 只小幅下调 pleasure 且 dominance 反向、energy 不下沉；`describe` 两套句子与事件类型对齐。混合句仍判 vent，符合清单。

### 2.4 V50-M2 占位符与注释

脚本：`D:\test\agent-plugin\.probe-v21\m2.mjs`、`m2-edge.mjs`。

主路径卡：

```text
description = 描述<!-- 隐藏注释 -->{{char}}今天{{time}}，还有{{random:a,b}}。
tone.voice  = 说话慢{{time}}
```

结果：

```text
warnings.detail = ["time","random:a,b","random:c,d","random:v1,v2"]
sections = safety 202 / core 112 / voice 39 / protocol 189 / board 29
all sections interpolate:false = true
card sections contain "{{"      = false
card sections contain "<!--"    = false
chat prompt contain "{{"         = false
chat prompt contain "<!--"       = false

renderTemplate('甲<!--x-->乙 {{random:a,b}} {{time}} {{char}} {{user}} 半截{{')
  = '甲乙 {random:a,b} {time} N U 半截{'

rewrite shadow: {text:'卡{{time}}', interpolate:false}
original array unchanged = true
```

`test/v051-template.test.js:212-222` 的严格宿主 mock 也验证了「注册 buildSections 输出 → 渲染不抛错」；本次聚焦运行该测试与情绪上下文测试：**26 tests / 2 suites / 26 pass / 0 fail**。

边界（见 L-2）：

```text
name = '珞然<!--secret-->'
parse warnings = []
buildSections/chat 仍含 '<!--secret-->'（hasHtml=true）
description 的注释正常剥离

name = '珞然<!--secret'         → 无 warning，注释残留
description = '描述<!--secret'  → warning html_comment_unterminated，文本保留
```

`boardSection` 是另一个边界：`src/persona/sections.js:118-124` 只设置 `interpolate:false`，不剥注释/不降级；探针把 `状态板{{time}}<!--board-->` 直接喂给 `boardSection` 时仍原样保留。卡本身不经过这条路径，因此不判 M2 失败；见 L-4。

### 2.5 V50-M3 注入

脚本：`D:\test\agent-plugin\.probe-v21\m3l3.mjs`，严格 FakeCtx + 临时 Store/DSH_HOME，卡 `emotion.enabled=true`，正文含哨兵 `卡正文哨兵-7f3a-不要出现在状态里`。

```text
M3_ON {
  contextRegistrations: 1,
  entry: {name:'companion-emotion', order:320, interpolate:false, textType:'function'},
  neutralText: '你此刻：现在心情平稳，精神一般，说到哪算哪，不用急着回应',
  neutralSnapshotCounts: [1,1,1],
  afterConflictText: '你此刻：现在心情有点闷，精神一般，话少一点，先听着',
  afterConflictSnapshotCount: 2,
  subagentText: '',
  emotionRows: {pleasure:42.32, arousal:55.12, dominance:44.88, energy:48.72},
  eventRows: 1,
  assemblyLine: '最近一次装配：刚刚；部署人设 宿主默认；prefix 未改写；段 safety 202/f6674ce1、core 218/3db1a9a3、protocol 189/3583cacf；情绪句「你此刻：现在心情有点闷，精神一般，话少一点，先听着」',
  lineHasSentinel: false,
  core: {chars:218, hash:'3db1a9a3'}
}

M3_OFF {
  contexts: 0, calls: 0, state: null, events: 0, contextCalls: 0
}
```

说明：

- 关闭时 `systemPrompt.context` 注册 0 次，且 `emotion_state` 没有行；
- 同句连续三轮只产生 1 条 `runtime-context` 快照，文本变化后第 2 条；
- 子代理 provider 返回空串；主会话返回 `你此刻：…`；
- 旧快照不删除、只被 supersede 的宿主限制已在 `docs/emotion-injection.md:82-95`、`:219-221` 写明，文档要求通过。

### 2.6 V50-L3 装配记录

同一脚本在 apply 后推进 1 小时，再直接触发 rewrite listener：

```text
{
  "now": 1794304800000,
  "line": "最近一次装配：1 小时前；部署人设 已替换（rewrite）；prefix 已改写；段 safety 202/f6674ce1、core 218/3db1a9a3、protocol 189/3583cacf",
  "hasSentinel": false,
  "core": {"chars":218, "hash":"3db1a9a3"}
}
```

- 段字数与 `ctx.sections` 的真实 core 文本一致：218 字符，SHA-256 前 8 位 `3db1a9a3`；
- 卡正文哨兵不出现在整行；
- 模式/prefix 正确；
- **时间字段错误**：rewrite 发生在 now，行却显示「1 小时前」，因为 `src/runtime/commands.js:675` 的 `sectionsAt ?? shadowAt ?? emotionAt` 让 apply 时的 `sectionsAt` 永远压过更晚的 `shadowAt`。见 L-1。
- 动态状态板段按 `src/index.js:836-837` 的注释被设计性跳过；`/状态` 只显示 3 个静态段。见 L-4。

`/状态` 原有行未被改动：`formatStatus` `src/runtime/commands.js:543-612`，只在末尾 `:607-609` 追加一行；diff 未改旧行。

---

## 3. 回归与命令记录

### 3.1 三时区

```powershell
$node = 'C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd D:\test\agent-plugin\dsh-companion

& $node --test
$env:TZ='UTC'; & $node --test
$env:TZ='America/New_York'; & $node --test
```

结果：

| 时区 | tests | suites | pass | fail | duration |
|---|---:|---:|---:|---:|---:|
| 默认 | 1162 | 33 | 1162 | 0 | 7164ms |
| UTC | 1162 | 33 | 1162 | 0 | 7020ms |
| America/New_York | 1162 | 33 | 1162 | 0 | 6937ms |

日志：`.probe-v21/test-default.log`、`test-utc.log`、`test-ny.log`（在仓库外，不入库）。

聚焦回归：

```powershell
& $node --test test\v051-template.test.js test\emotion-context.test.js
# tests 26 / suites 2 / pass 26 / fail 0
```

### 3.2 测试是否被放宽

```powershell
git diff 121f2c8..HEAD -- test/
Select-String -Path (Get-ChildItem test -Recurse -Filter *.js).FullName -Pattern '\.skip\b|\.only\b'
Select-String -Path src\persona\emotion.js -Pattern 'Date\.now|new Date|Math\.random'
```

结果：

- 无 `.skip` / `.only`；
- `src/persona/emotion.js` 无 `Date.now` / `new Date` / `Math.random`；
- `test/emotion-wiring.test.js` 删除的是旧「quiet 直接写 energy 增量」「每轮注入独立 user 消息」断言，替换成目标偏差、context 注册/路由断言，属 H1/M3 的正常改写；
- `test/emotion-v051.test.js:199-202` 对「你这几天累不累」只断言 `type !== 'vent'`（不强制 share），与清单「不能同判 vent」一致；
- diff 新增约 281 条断言，未发现把 `assert.equal` 改成无意义 `assert.match` 的放水。

### 3.3 其他核对

```powershell
git status --short                 # 空
git log -1 --oneline               # 45c3b45 docs(release): v0.5.1 changelog and README summary
git tag --list                     # 仅到 v0.5.0
```

- `SCHEMA_VERSION = '14'`（`src/memory/store.js:81`），导出 `CURRENT_SCHEMA_VERSION = '14'`（`src/memory/export.js:87`）；
- `package.json` 仍是 `"version": "0.5.0"`，tag 无 `v0.5.1`（见 L-5，发布流程项）；
- `.data/plugin-gate.log` 里没有最终 `plugin-gate: PASS` 字符串，因为脚本在打印 PASS 前先写日志（`scripts/probe/run-headless.mjs:622` 与 `:635`）；A/B 结构条件均满足，C 无凭据 SKIP，与船长结论一致。

---

## 4. 发现清单

### H（阻塞）

无。

### M（应修）

无。

### L（低优先 / 观察）

#### L-1 `最近一次装配` 时间不随 shadow/emotion 更新

- 位置：`src/runtime/commands.js:675`
- 代码：

  ```js
  const at = snapshot.sectionsAt ?? snapshot.shadowAt ?? snapshot.emotionAt;
  ```

- 最小复现：正常 apply（`recordSections` 写入 `sectionsAt`）→ 推进 1 小时 → 触发一次 rewrite（`recordShadow` 写入 `shadowAt`）→ `/状态`。
- 实际：`最近一次装配：1 小时前`（apply 时间）。
- 期望：显示 rewrite 发生的「刚刚」，或至少不早于 `shadowAt`/`emotionAt`。
- 影响：L3 的时间字段对「最近一次装配」失真；模式、prefix、段 hash 不受影响。低优先项内的展示缺陷，不阻塞发版。

#### L-2 `name`/`address` 未参与注释清洗；未闭合注释保留

- 位置：`src/persona/card.js:446-485`（只清洗 `CARD_TEXT_FIELDS`/tone/list）、`:156-176`（未闭合注释保留原文并只给 warning）。
- 最小复现：

  ```js
  // 卡 name
  { name: '珞然<!--secret-->', ... }
  // parseCardSourceDetailed -> warnings []；buildSections/chat 文本仍含 '<!--secret-->'
  ```

  未闭合 `name: '珞然<!--secret'` 无 warning；未闭合 `description` 有 `html_comment_unterminated` 但原文保留。
- 影响：L2 的「卡文本注释在渲染前剥离」在 name/address 与 malformed 注释上不完整；不会导致宿主插值抛错（注释不是 `{{`），但会把注释带进 system/chat 文本。低优先边界。

#### L-3 文档计数/行号/函数名漂移

- `docs/emotion-injection.md:197-198` 仍写 **1120 tests / 28 suites**；当前实际 **1162 tests / 33 suites**。
- `docs/emotion-injection.md:166-167` 的 `src/index.js:164`、`:3018` 与当前实际 `:170`、`:3043-3051` 不一致。
- `docs/host-prompt-internals.md:61` 称 `registerEmotionContext` 是 `src/index.js` 的函数；实际没有该函数，逻辑内联在 `apply` 的 `src/index.js:461-478`。
- README/CHANGELOG 也写 28 个套件（实际 33）。纯文档漂移，不影响代码行为。

#### L-4 L3「各段」不含动态状态板；状态板文本本身未降级

- 位置：`src/index.js:836-837`（只 `recordSections(record, sections)`，状态板动态段不记录）；`src/runtime/commands.js:682-689` 只输出 `snapshot.sections`。
- 现状：`/状态` 只显示 safety/core/protocol 三个静态段；`persona:state_board` 不出现。注释写明「按设计跳过」。
- 另：`boardSection`（`src/persona/sections.js:118-124`）只设 `interpolate:false`，不清洗 `{{...}}`/`<!-- -->`；宿主不会插值（flag 保护），但段文本可含这些字面量。
- 判定：若「persona 各段」按字面理解为包含状态板，则 L3 不完整；若按「静态人格段」理解则符合设计。标为观察，不据此判 M。

#### L-5 发版元数据未同步

- `package.json` 仍为 `"version": "0.5.0"`；`git tag --list` 无 `v0.5.1`；README:7 却写「v0.5.1 已发布（2026-11-11，tag v0.5.1）」。
- 这是发版流程/元数据问题，不是 v0.5.1 代码缺陷；在打 tag/改版本前不应把 README 的「已发布」当既成事实。

---

## 5. 复审结论

- **H = 0，M = 0**：三条必修（H1/M1/M2）与 M3 均通过独立探针；L1 文档、L2 主路径、L3 功能与哈希/哨兵检查通过。
- 5 条 L 均为低优先展示、边界、文档或发布元数据问题，未触及状态漂移、分类、宿主插值抛错或注入路由。
- 因此按任务口径判 **pass**；建议在下一个补丁顺手修 L-1/L-2/L-3，L-4/L-5 在发版流程中确认口径。

本报告未修改任何源码；只新增并提交 `docs/review-v21.md`。
