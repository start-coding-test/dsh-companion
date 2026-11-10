# v0.5.0 独立复审（review-v20）

- 复审人：独立审查（未参与实现）
- 日期：2026-11-10
- 对象：`f391fe7`（`main`）。复审开始时 HEAD 为 `5714b1d`；期间只前进了 `f391fe7 docs: v0.5.0 changelog and readme summary`，`5714b1d..f391fe7` 仅改 `CHANGELOG.md`（+26）与 `README.md`（+11/−1），代码与 `5714b1d` 相同。
- 上一版：`v0.4.12` = `6eedde9`
- 环境：捆绑 Node `v24.21.0`（`C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）；本机无模型凭据，round C 的 `MISSING_CREDENTIAL` 属预期。
- 方式：只读源码/测试/文档；仓库外 worktree 对比 v0.4.12；仓库外探针；真文件 SQLite 迁移/导出/重启；三时区全量 `node --test`；仅只读比对宿主装配源码。未改源码/既有测试，未 push。
- 前次结论：review-v19 为 pass（H=0 / M=0 / L=3）。

## 结论

**verdict = needs_revision**（H=0 / M=3 / L=8）。

核心行为大部分通过：内置卡 + 情绪关与 v0.4.12 逐字节一致；情绪默认零副作用、注入不进 system、同 turn 去重、真文件重启/忘掉/迁移/导出均成立；遮蔽三态、非原地改写、异常回落也成立；三时区 1103/28/0。阻塞发布的是两处用户可踩的功能/文档不一致（M-1、M-2）和一处 P1 的明确残留（M-3）。M>0，按本次口径不能判 pass。

| 级别 | 数量 | 条目 |
| --- | --- | --- |
| H | 0 | — |
| M | 3 | M-1 CCv2 address 文档/实现不一致；M-2 `tone`/`bannedPhrases` 占位符未渲染；M-3 巩固提示词仍写死「私人管家」 |
| L | 8 | L-1..L-8，见 §3 |

## 1. 通过项与证据

### 1.1 P1 硬要求：内置卡 + 情绪关与 v0.4.12 逐字节一致

做了独立 worktree，不只把仓库内 fixture 当作依据：

```powershell
git worktree add --detach D:\test\agent-plugin\.probe-v20\wt-v0412 6eedde9
& $NODE D:\test\agent-plugin\.probe-v20\dump.mjs D:\test\agent-plugin\dsh-companion\.probe-v20\wt-v0412 base.json
& $NODE D:\test\agent-plugin\.probe-v20\dump.mjs D:\test\agent-plugin\dsh-companion head.json
```

`dump.mjs` 只 import 目标 root 的 `src/persona/card.js` / `sections.js` / `chat.js`，输出：

- `buildSections(DEFAULT_CARD)` 的每段 `name/order/text`；
- `buildChatPrompt({ card, recentTopics: [...], recallSummary: '...', messageCount: 8 })`；
- 只传卡、不带话题/召回的 `buildChatPrompt({ card })`。

实际比较结果：

```text
sections true chatCtx true chatBare true
fixture sections true chatCtx true chatBare true
```

即两组渲染文本逐 UTF-16 码元相等（UTF-8 下即逐字节相等）。仓库内 `test/fixtures/persona-v0412.json` 同时与真实 v0.4.12 输出相等，因此该 fixture 不是自证。

v0.4.12 侧的硬编码原文（`wt-v0412/src/persona/sections.js:90-92`）：

```js
你是${card.name}，用户的私人管家。称呼用户为“${card.address}”。
身份是 AI 助手；关系以管家为主、朋友为辅，保持可靠与克制。
语气${tone.style}、${tone.warmth}，${tone.structure}；不堆铺垫，不夸张感叹，不用亲密称呼。
```

v0.4.12 的闲聊首句在 `wt-v0412/src/persona/chat.js:116`：

```js
你是用户的私人助手${name}，称呼用户为「${address}」。
```

HEAD 用 `DEFAULT_CARD.description` / `chatIdentity` + `renderTemplate` 还原同一文本（`src/persona/card.js:41`、`:77`、`:102-107`；`src/persona/sections.js:143-152`；`src/persona/chat.js:116-118`），实测相等。

回归断言没有改松：`test/e2e/persona-card.test.js:409` 是 `lines.length === V0411_STATUS_LINES.length + 3`；`:411-418` 过滤「人格卡：/部署人设：/情绪：」三类新行后，首行与基线逐字相等，`slice(1)` 与基线 `deepEqual`。其余行没有改成“只查前缀”。

### 1.2 P1 卡片字段、voice 段、上限与 taboos

探针 `probe2.mjs` / `probe3.mjs` 的实际输出：

- CCv2：`data.address='您'` → `card.address='您'`；`version:7`、`first_mes`、`post_history_instructions` 保存；`character_book` 只产生 `character_book_ignored` warning，正文不进入 sections。
- 原生卡：description/personality/scenario 进 core；personality 前缀「性格：」、scenario 前缀「场景：」；`tone.notes` 接在语气行；`values` 逐条 `-`；`taboos` 非空才出现「禁区：」整行，空数组时整行省略。
- voice：`tone.voice` 与 `mes_example` 同时非空时两段都进入，顺序为 voice 在前；顶部固定 `[说话方式]\n（模仿口吻，不照抄内容）`；`<START>` 被换成换行；voice 段 order=95。
- 上限：description 1500 码点、`tone.voice` 1500 码点 → 实测两段各截到 1200 码点，warnings 恰为：

```text
[['section_truncated','persona:core',1200],
 ['section_truncated','persona:voice',1200]]
```

- `memoryCitation:'natural'` 只替换协议第 3 行；`explicit` 与 v0.4.12 相同。
- `first_mes` / `post_history_instructions` 只保存不渲染，与文档「预留」一致（已定口径）。
- `chatIdentity` 为空时回落内置句；非内置卡的 `description` 以「人设要点：…」进闲聊，压成一行、≤200 码点。

### 1.3 P2 遮蔽宿主默认人设

`functional.mjs` 对纯函数和真实 apply 都做了验证：

- 默认 `off`：`ctx.listeners` 只有 session/event、agent/pre-step、agent/turn-stopping、dispose，**没有** `system-prompt/assemble`；`/状态` 有 `部署人设：宿主默认`。
- `rewrite`：返回新数组，只把 prefix 换成新对象 `{...section, text: personaText}`，`order`/`cacheable` 保留；其它段仍是原引用；传入的 sections 数组 JSON 前后不变（未原地改）。apply 后 prefix 文本为 `你是用户的私人助手珞然，称呼用户为「你」。`（默认卡渲染后）。
- `takeover`：摘掉 prefix；空/纯空白 suffix 删除；非空 suffix 保留并 warn `non-empty-suffix`；非字符串 suffix 保守保留。
- 两段都缺失 → warn `missing-sections`；rewrite 但无 prefix → warn `rewrite-missing-prefix`。
- `next()` 抛错会向上冒（`const resolved = await next()` 在 try 外，`src/persona/shadow.js:147`）；handler 内异常返回 `next()` 原对象并只 warn 一次 `handler-failed`。
- 子代理、非 agent scope 原样返回；宿主 `assembleContextFor` 返回的 `context.scope === context.agent`（只读比对 `dsh-agent/lib/index.js:291-296`），该判定对真实宿主成立。
- 配置非法值：`ConfigError`，message 为 `persona.shadowDeployment: must be "off", "rewrite", "takeover", true, or false, got "bogus"`，`path='persona.shadowDeployment'`；`true` 等同 rewrite；`off` 时完全不注册。

### 1.4 P3 情绪：默认零副作用、注入、持久化

默认路径（内置卡、情绪关）：

- 情绪两表 0 行；pre-step 注入 0 条；没有 `companion-emotion` 消息；`/状态` 只有 `情绪：未启用`，没有「未开始」；sections 只有 safety/core/protocol/state_board，没有 emotion 段。

启用卡（`name='珞然'`、`address='你'`、`emotion.enabled=true`）：

- 用户「晚安，今天先睡了」→ 注入一条独立 user 消息：

```text
你此刻：现在心情平稳，精神一般，说到哪算哪，不用急着回应
```

- 无阿拉伯数字、无花括号、无维度名；不在 system（实测 sections 无 emotion）。
- state：`{pleasure:57.38, arousal:38.6, dominance:51.19, energy:53.51, updatedAt:1793869200000, lastEventAt:1793869200000}`；event `goodnight`，deltas `{pleasure:2.38, arousal:-6.4, dominance:1.19, energy:3.51}`。
- 同一 turn 回灌注入消息再跑一次 pre-step：仍 1 条、id 相同、events 仍 1。
- 关库重开（真文件）：state 四维/`updatedAt` 保留，events 仍 1；重启 +30 分钟后 `/状态` 显示 `（最近：晚安 30 分钟前）`，新一轮再注入后 events=2。
- 情绪纯函数：`src/persona/emotion.js` 无 import、无 `Date.now`、无 `Math.random`；`describe` 的 12 句描述全无阿拉伯数字；6h 半衰期、昼夜节律、安静时段 `-3` 均有单测/探针覆盖。
- 存储：schema 14 两表；55 条事件只保留最近 50；`resetEmotion` 清 state+events；`purge` 按 cutoff 清旧事件并清这些 scope 的 state，审计只记 `{emotionEvents, emotionStates}` 条数。
- 迁移：真文件 v13→v14、v12→v14 均自动补建两表，旧 facts 仍可用。
- 导出/导入：敏感 note 置 null 并计 warning；fresh 导入 `{state:2, events:2, trimmed:0}`；旧文件无 `emotion` 导入为 `{state:0, events:0, trimmed:0}`。
- `/状态`：状态句 + 最近最多 3 条白名单事件；实测 `（最近：问候 1 分钟前 / 关心 2 小时前 / 谢谢 3 小时前）`，ambient 不显示。

### 1.5 配置、测试与发布门

```text
Object.keys(DEFAULTS).length === 16
package.json: version 0.4.12; dependencies/devDependencies/peerDependencies 均不存在
```

三时区全量（当前 HEAD）：

| 时区 | tests | suites | pass | fail | duration_ms | 日志 |
| --- | --- | --- | --- | --- | --- | --- |
| 默认 | 1103 | 28 | 1103 | 0 | 6791.2079 | `.probe-v20/review-tz-default.log` |
| `TZ=UTC` | 1103 | 28 | 1103 | 0 | 6948.0551 | `.probe-v20/review-tz-UTC.log` |
| `TZ=America/New_York` | 1103 | 28 | 1103 | 0 | 6820.2213 | `.probe-v20/review-tz-America_New_York.log` |

`git diff --stat v0.4.12..HEAD -- test` = 30 files, +3186/−38；删除的 38 行全部是 schema 13→14 常量、`DEFAULT_CARD.tone` 新增 notes/voice 的期望、e2e persona 的 +1→+3 行与过滤前缀，没有删用例或放宽阈值。

发布门 `.data/plugin-gate.log`（2026-11-10T11:47Z）：

- round A：`schedulerStarted=true didNotActivate=false`；
- round B：`recallCrash=false seededFact=fact_d328… firstReneedAt=1794311241`；
- round C：`credentialsMissing=true consolidations=0 tokenEvents=1 verdict=skip`。

与 CHANGELOG 的 round A/B PASS、round C SKIP 一致；无凭据导致的 skip 属预期。

## 2. Findings（M）

### M-1 CCv2 `address` 文档与实现不一致（用户按文档写会被静默忽略）

**证据**

- 文档：`docs/persona-card.md:49`

```text
`data.name` → `name`，`data.extensions.address`（可选）→ `address`，缺省「你」。
```

- 实现：`src/persona/card.js:317-319`

```js
mapped.address = typeof data.address === 'string' && data.address.trim() !== ''
  ? data.address
  : '你';
```

实现完全没读 `data.extensions.address`。全仓仅该文档出现 `extensions.address`；`test/persona-ccv2.test.js` 与 fixtures 均用 `data.address`。

**最小复现**

```powershell
@'
import { parseCardSourceDetailed } from '../dsh-companion/src/persona/card.js';
const source = JSON.stringify({
  spec: 'chara_card_v2',
  data: { name: '岚', extensions: { address: '先生' } },
});
const { card } = parseCardSourceDetailed(source);
console.log(card.address); // 你
'@ | Set-Content -Encoding utf8 D:\test\agent-plugin\.probe-v20\repro-m1.mjs
& $NODE D:\test\agent-plugin\.probe-v20\repro-m1.mjs
```

实际输出：

```text
你
```

`probe2.mjs` 用同结构卡片（另加 `data.address` 对照）输出：

```text
EXTENSIONS.ADDRESS => "你"
CCV2_DATA_ADDRESS = "先生"
```

即按文档写 `extensions.address='先生'`，加载后 address 仍是「你」；只有写 `data.address='先生'` 才得到「先生」。

**影响**：用户按唯一字段文档导入酒馆卡，称呼会被静默改成「你」，且没有 warning；这与 P1「支持直接加载 CCv2/V3」的预期不符。

**建议**：二选一并对齐测试/文档——(a) 文档改为 `data.address`；或 (b) 实现同时接受 `data.address ?? data.extensions?.address`，并补 CCv2/V3 各一条 fixture。若项目希望兼容现有文档写法，选 (b) 并写明优先级。

### M-2 `{{char}}` / `{{user}}` 在 `tone` 与 `bannedPhrases` 中未渲染

**证据**

- 文档：`docs/persona-card.md:51` 承诺「`{{char}}` / `{{user}}` 在**渲染输出时**替换成 `name` / `address`」。
- 实现只对部分字段调用了 `renderTemplate`：
  - core 语气行直接拼：`src/persona/sections.js:152`
    ```js
    lines.push(`语气${tone.style}、${tone.warmth}，${tone.structure}${toneTail(card, tone)}`);
    ```
  - 闲聊语气行直接拼：`src/persona/chat.js:134`
    ```js
    `语气：${style}、${warmth}、${structure}。`,
    ```
  - 闲聊禁用表达直接 join：`src/persona/chat.js:138`
    ```js
    banned === '' ? '' : `禁用表达：${banned}。`,
    ```
- description/personality/scenario/notes/values/taboos/voice/chatIdentity/mes_example 均已渲染；缺口只在 `tone.style/warmth/structure` 与 `bannedPhrases`。

**最小复现**

用原生卡（name=岚、address=老板）：

```json
{
  "name": "岚",
  "address": "老板",
  "tone": {
    "style": "像{{char}}一样简洁",
    "warmth": "对{{user}}温和",
    "structure": "先给{{user}}结论"
  },
  "bannedPhrases": ["叫{{user}}老大"]
}
```

用 `parseCardSourceDetailed` / `buildSections` / `buildChatPrompt` 跑该 JSON，实际输出：

```text
warnings []
语气像{{char}}一样简洁、对{{user}}温和，先给{{user}}结论；不堆铺垫，不夸张感叹，不用亲密称呼。
语气：像{{char}}一样简洁、对{{user}}温和、先给{{user}}结论。
禁用表达：叫{{user}}老大。
```

`probe3.mjs` 实际输出（节选）：

```text
CORE >>>
[身份与口吻]
你是岚，老板的旅伴。
...
语气像{{char}}一样简洁、对{{user}}温和，先给{{user}}结论；...
...
CHAT >>>
...
语气：像{{char}}一样简洁、对{{user}}温和、先给{{user}}结论。
...
禁用表达：叫{{user}}老大。
...
RAW_PLACEHOLDER_IN_CORE = true
RAW_PLACEHOLDER_IN_VOICE = false
RAW_PLACEHOLDER_IN_CHAT = true
```

**影响**：自定义卡的 system 与闲聊提示词会把字面量 `{{char}}` / `{{user}}` 送给模型；用户以为已替换，实际身份/称呼提示被污染。这是 P1 的直接功能缺口，不只是文档问题。

**建议**：在 `coreText` 的语气行、`buildChatPrompt` 的语气行与 `bannedPhrases` join 前统一 `renderTemplate(..., {name, address})`；补一条覆盖所有含占位符字段的回归测试（至少 description/personality/scenario/tone.notes/tone.voice/values/taboos/bannedPhrases/chatIdentity/mes_example）。

### M-3 巩固提示词仍写死「私人管家」（P1 残留）

**证据**

```powershell
Select-String -Path src\memory\consolidate.js -Pattern '私人管家'
# src\memory\consolidate.js:532:'你是私人管家的记忆巩固器。把下面这段对话压缩成一条情景记忆与若干长期事实。',
```

`git diff v0.4.12..HEAD -- src/memory/consolidate.js` 为空，这一行从 v0.4.12 原样保留。P1 要求「删掉写死的『私人管家/私人助手』，身份/性格/关系全从卡读取」；`src/` 内其余出现位置是卡数据（`card.js:41`、`:77`）与安全底线「你是 AI 助手」（`sections.js:29`），只有这处是遗留的写死身份。

**最小复现**

```powershell
Select-String -Path src\memory\consolidate.js -Pattern '私人管家' -Context 0,0
git diff v0.4.12..HEAD -- src/memory/consolidate.js
# 无输出
```

**影响**：这是内部巩固模型的提示词，不是用户可见 persona，所以不判 H；但它会偏置模型对「identity/relation」事实的抽取，且与「身份全从卡读取」直接冲突。按 M 计，修复成本很低。

**建议**：改为中性表述（「你是记忆巩固器」），或在 `buildConsolidationPrompt` 接收卡身份并渲染；同时加一条 grep/单测，避免「私人管家」再进入非卡数据代码。

## 3. L 观察（不阻塞，但发布前宜修）

- **L-1 导出文档漏掉情绪两表**：`docs/usage.md:89` 只列「活跃事实、情景、提醒、线程与状态板」，`:397` / `:414` 同口径；但 `src/memory/export.js:306-333` 的 `readEmotion` 会导出全部 scope 的 state + 每 scope 最近 50 事件。用户会以为导出不含情绪，恢复时却多出 `emotion` 段。
- **L-2 merge 文档没说明 emotion 例外**：`docs/usage.md:424` 说「按主键跳过已存在的行……不覆盖本地已有内容」；`src/memory/export.js:851-889` 对 emotion 事件是无条件 INSERT、state 是 upsert 覆盖，`test/emotion-export.test.js:212-240` 也明确期望追加/覆盖。应补充「emotion 段例外」。
- **L-3 CHANGELOG 的 rewrite 文案错误**：`CHANGELOG.md:12` 写「已遮蔽（rewrite）」；代码与实际 `/状态` 是 `部署人设：已替换（人格卡身份）`（`src/runtime/commands.js:646-652`；`docs/persona-shadow.md:46-48`、`docs/deploy-v050.md:52`、`docs/usage.md:810-812` 均正确）。发布说明会误导用户。
- **L-4 多处仍是 v0.4.13 标签**：`src/persona/card.js:30`、`src/persona/sections.js:12`、`src/config.js:157`、`docs/persona-shadow.md:1`、`docs/usage.md:785` 等写「v0.4.13」，而发布目标是 v0.5.0。属功能批次改名残留。
- **L-5 README/package/tag 的「已发布」口径**：`README.md:7` 称「v0.5.0 已发布」，但 `git tag` 最新仍是 `v0.4.12`，`package.json` version 仍 0.4.12。v19 有打 tag 前不 bump 的先例，故不按 M 计；发布时需同步 tag/版本号，或把 README 改成「待发布」。
- **L-6 基线命名仍是 v0.4.11**：`CHANGELOG.md:28` 写「逐行等值 v0.4.11」，`test/e2e/persona-card.test.js` 的常量名/注释也是 `V0411_*`；实际 fixture 是 `persona-v0412.json`，复审也与 v0.4.12 对比通过。行为无误，但名称会让人误以为基线没更新。
- **L-7 两处 baseline 默认值不一致**：`src/persona/card.js:80` 内置卡是 `{50,50,50,60}`；`src/persona/emotion.js:33-38` 的 `DEFAULT_BASELINE` 是 `{55,45,50,50}`。深合并时缺省 baseline 继承内置卡，非法 baseline 则回落 55/45/50/50（`src/persona/card.js:239-243`）。当前测试未覆盖这个差异，文档也没写；建议统一或明确「非法值回落」与「缺省继承」的区别。
- **L-8 部署验收文案不够精确**：`docs/deploy-v050.md:54` 写「闲聊首句……不是『私人助手』」，但内置卡 `chatIdentity` 本身就含「私人助手」（`src/persona/card.js:77`）；`:55` 写「`/状态` 的情绪句变化，且不出现数字」，实测 `/状态` 的「最近：1 分钟前」有数字，只有注入句无数字。建议改成「自定义卡不出现内置句」「情绪句本体不出现数字」。

## 4. 用户验收清单

图例：✅ 通过；⚠️ 通过但有文档/口径问题；❌ 未通过。

| # | 验收项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 内置卡 + 情绪关，system 三段与闲聊提示词逐字节等于 v0.4.12 | ✅ | `dump.mjs` 输出 `sections true chatCtx true chatBare true`；fixture 同样为 true |
| 2 | 身份/性格/关系由卡的 description/personality/scenario 驱动 | ✅ | `sections.js:143-152`；probe3 core 输出 |
| 3 | 支持 CCv2/V3 直接加载，标准字段映射 | ✅ | `probe2.mjs`：data.address、version、first_mes/post_history 保存 |
| 4 | CCv2 address 字段按文档可用 | ⚠️ | M-1：文档写 extensions.address，实现只读 data.address |
| 5 | `{{char}}`/`{{user}}` 在渲染输出替换 | ❌ | M-2：tone/bannedPhrases 仍原样泄漏 |
| 6 | `character_book` 忽略并 warn | ✅ | `character_book_ignored`，正文不进 sections |
| 7 | `persona:core` / `persona:voice`(95) 分工、顶部「模仿口吻，不照抄内容」、core/voice 各 1200、空 taboos 省略禁区 | ✅ | probe2：两段 1200、warnings、voice 两段都进、空 taboos 无禁区行 |
| 8 | 删除写死「私人管家/私人助手」 | ❌ | M-3：`consolidate.js:532` 仍在；卡数据/安全底线除外 |
| 9 | 遮蔽默认 off、off 不注册监听 | ✅ | `functional.mjs`：listeners 无 assemble；`/状态` 宿主默认 |
| 10 | rewrite 只改 prefix text、不原地改、他段引用不变 | ✅ | 新数组/新对象，入参数组 JSON 不变 |
| 11 | takeover 摘 prefix、空 suffix 删、非空 suffix 保留并 warn | ✅ | `non-empty-suffix`；纯空白删除 |
| 12 | 只处理主会话，子代理不遮蔽 | ✅ | `classifySession` 放行；测试/探针原样返回 |
| 13 | handler 异常/assembly 异常返回 `next()` 原值 | ✅ | handler 异常 warn 一次并返回 resolved；next 抛错向上冒 |
| 14 | 非法 `persona.shadowDeployment` 抛 ConfigError | ✅ | message/path 实测 |
| 15 | 情绪默认关，零读零写、无 emotion 消息、`/状态` 只显示「未启用」 | ✅ | 两表 0 行、注入 0、sections 无 emotion |
| 16 | PAD+精力、6h 半衰期、昼夜节律、安静时段、纯函数无 Date.now/随机 | ✅ | `emotion.js` grep；单测/探针 |
| 17 | 每轮一句人话在 user 尾部、不进 system、无数字/花括号、同 turn 只一条 | ✅ | `你此刻：…`；same id；sections 仅四段 |
| 18 | 重启不丢、忘掉/ purge 清两表、导出导入覆盖两表 | ✅ | 真文件关库重开、forget、v13/v12 迁移、roundtrip |
| 19 | `/状态` 显示自然语言状态 + 最近 3 条 | ✅ | `status3.mjs` 输出（3 条，ambient 不显示） |
| 20 | `memoryCitation:'explicit' / 'natural'` | ✅ | `probe2` 的 natural 协议行；explicit 与基线一致 |
| 21 | 闲聊用卡 description + 第一组 mes_example；情绪启用带状态句 | ✅ | `probe2` CHAT 输出；`functional` 末尾状态句 |
| 22 | 快照测试（内置卡+情绪关） | ✅ | `persona-baseline` 与 `dump.mjs` 双重验证 |
| 23 | 酒馆卡 V2/V3 导入测试 | ⚠️ | 标准字段/测试通过；address 文档错误见 M-1 |
| 24 | 情绪纯函数/跨重启/无数字/忘掉重置 | ✅ | 单测 + 真文件探针 |
| 25 | 三时区全绿 | ✅ | 默认/UTC/NY 均 1103 / 28 / 0 |
| 26 | 发布门 round A/B PASS、round C SKIP 属预期 | ✅ | `.data/plugin-gate.log`；C `credentialsMissing=true` |
| 27 | 16 键安装自检不变、零运行时依赖 | ✅ | `Object.keys(DEFAULTS).length===16`；package 无依赖字段 |
| 28 | 复审只新增报告、不改源码/既有测试、不 push | ✅ | 工作树仅 `docs/review-v20.md`；提交信息见 §6 |

## 5. 复跑命令与探针

所有探针在仓库外 `D:\test\agent-plugin\.probe-v20\`，不提交；下列命令均用捆绑 Node：

```powershell
$NODE = 'C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
cd D:\test\agent-plugin\dsh-companion

# 三时区
& $NODE --test 2>&1 | Tee-Object .probe-v20\review-tz-default.log
$env:TZ='UTC'; & $NODE --test 2>&1 | Tee-Object .probe-v20\review-tz-UTC.log
$env:TZ='America/New_York'; & $NODE --test 2>&1 | Tee-Object .probe-v20\review-tz-America_New_York.log
Remove-Item Env:TZ

# 逐字节基线（先建 worktree）
git worktree add --detach .probe-v20\wt-v0412 6eedde9
& $NODE .probe-v20\dump.mjs .probe-v20\wt-v0412 .probe-v20\base.json
& $NODE .probe-v20\dump.mjs . .probe-v20\head.json

# 功能/存储/字段探针
& $NODE .probe-v20\functional.mjs
& $NODE .probe-v20\probe2.mjs
& $NODE .probe-v20\probe3.mjs
& $NODE .probe-v20\status3.mjs
```

测试 diff 与文档核对：

```powershell
git diff --stat v0.4.12..HEAD
git diff --stat v0.4.12..HEAD -- test
git diff v0.4.12..HEAD -- src/memory/consolidate.js
Select-String -Path src\persona\sections.js -Pattern 'tone\.style'
Select-String -Path src\persona\chat.js -Pattern 'tone|banned'
Select-String -Path docs\persona-card.md -Pattern 'extensions\.address|\{\{char\}\}'
```

## 6. 工作区与提交

- 复审开始与结束时 `git status --short` 均为空（除本报告外）。
- 本报告为唯一新增文件：`docs/review-v20.md`。
- 提交信息：`docs(review): v0.5.0 复审`。
- 未修改 `src/`、`test/`、`CHANGELOG.md`、`README.md`；未 push。
- 复审对象是 `f391fe7`；`5714b1d..f391fe7` 仅 CHANGELOG/README 两文件，代码与 `5714b1d` 相同，故上述所有代码级证据对两者都成立。
- 上一版基线 worktree 为 `D:\test\agent-plugin\.probe-v20\wt-v0412`（detached `6eedde9`），仅用于对比，不提交。
