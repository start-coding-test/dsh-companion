# dsh-companion v0.6.1 发布前复审（review-v23）

- 复审基线：`d824b37`（tag `v0.6.0`）
- 复审对象：`6d296e6`（`fix(emotion): borrowed appraisal type, pronoun-free sentences and v0.6.1 review items`）
- 复审工作树：`D:\test\wt-review-v061`（detached `6d296e6`）；基线对照树：`D:\test\wt-v060`（`d824b37`）
- 运行环境：捆绑 Node `v24.21.0`；默认时区、`TZ=UTC`、`TZ=America/New_York`
- 复审方式：只读代码/历史，测试、门禁与独立探针均在上述工作树或 `D:\test\review-artifacts` 中执行；未修改被审仓库的 `src/`、`test/`、`CHANGELOG.md`、`README.md`

## 1. 结论

**needs_revision**：**H 0 / M 1 / L 4**。

六项用户要求在代码与行为层面均已关闭，没有发现 H 级问题。唯一 M 级问题是发布口径与实测不一致：三时区实际均为 **1218 用例 / 33 套件 / 0 失败**，而 `README.md:7` 与 `CHANGELOG.md:35` 写的是 **34 个套件**；任务给定的验收口径也是 34。该问题不影响运行时行为，但会让“发布说明是否真实”这一验收项失败。若团队确认 33 才是正确数字，修正文档并把验收口径改为 33 后，本项即可关闭，结论可转为 `pass`（其余 L 项不阻塞发布）。

## 2. 复审（r2，对象 1fdfcbd）

> 本节是 r2 的当前结论；§1 是对 `6d296e6` 的 r1 原始结论，按要求原样保留。

- r2 对象：`1fdfcbd`（`fix(review): strict borrow window, real M3 assertion, suite counts and LF docs`，未 push）；父提交 `63fa07b`（r1 报告提交）。
- 工作树：`D:\test\wt-review-v061-r2`（detached `1fdfcbd`）；基线对照树仍为 `D:\test\wt-v060`（`d824b37`）。
- **结论：pass（H 0 / M 0 / L 1），可发版。** r1 的 M-1 与 L-2/L-3/L-4 已关闭；唯一残留是流程性 L-1：本地 tag `v0.6.1` 仍未创建，而 `README.md:7` 已写「已发布（2026-11-11，tag `v0.6.1`）」。push 后补 tag 即闭环；若发布规范要求 tag 先于「已发布」文案，则应在 push 前修正 README 或补 tag。

### 2.1 r1 问题复核

| r1 项 | 结论 | r2 证据 |
|---|---|---|
| M-1：发布口径 34 套件 vs 实测 33 | **关闭** | `README.md:7`、`CHANGELOG.md:35` 已改为 `1219 个用例 / 33 个套件`；r2 三时区实测均为 **1219 / 33 / 0**（见 2.3） |
| L-1：tag `v0.6.1` 不存在 | **未关闭（L，流程）** | `git tag --list 'v0.6*'` 仍只有 `v0.6.0`；`README.md:7` 仍写「已发布……tag `v0.6.1`」 |
| L-2：M3 状态断言恒真 | **关闭** | `test/v061-fixes.test.js:90-112`：低置信度断言事件行、零增量和 `state.updatedAt === now`；另建 fresh store 以 0.9 置信度对照，断言 `pushed.pleasure < state.pleasure - 1`。若阈值失效，低置信度会同样压低 pleasure，对照失败；`node --test test/v061-fixes.test.js` 10/10 通过 |
| L-3：`known-debt.md` 整文件 CRLF | **关闭** | `git show 1fdfcbd:docs/known-debt.md`：33,749 bytes，CRLF 0 / LF 231 / CR 0；`git diff --check 63fa07b..1fdfcbd` 退出 0；`git diff --numstat 63fa07b..1fdfcbd -- docs/known-debt.md` 为 231/231，属一次性 EOL 归一化 |
| L-4：10 分钟边界 `<=` | **关闭** | `src/index.js:2880` 已改为 `now - pending.at < BORROWED_APPRAISAL_TTL_MS`；r2 探针 `boundary 10m: isVent=false isDescribe=true`，`boundary 10m+1ms` 同样通用句 |

### 2.2 六项用户要求回归

r2 用同一套独立探针（`probe-v061-r2.mjs`、`probe-m1-three-r2.mjs`、`probe-m3-config-r2.mjs`，日志在 `D:\test\review-artifacts`）重跑，六项仍全部关闭：

- **M1**：blame/vent/reassure 三种 llm 判定下一轮分别命中对应专属句；vent 第二轮专属、第三轮通用、11 分钟通用；阈值下 0.6 只写一条全零 llm 事件且下一轮不借；`type=none` 的 `note=llm` 行数为 0 且下一轮通用句。r2 边界额外验证：恰好 10 分钟已不借。
- **M2**：DESCRIBE 12 / BLAME 2 / VENT 2 / REASSURE 4；`/[你他她]/u` 命中 0。
- **M3**：llm 0.6/min 0.65 只写零增量；规则 0.6 仍写非零 `{pleasure:-7.04,arousal:1.57,dominance:-1.1,energy:-1.1}`；配置默认 0.65，0.5/0.65/0.95 接受，0.49/0.96/0.4/1/`"0.7"`/null/NaN/Infinity 均回落 0.65 并带 `emotion_appraise_min_confidence_invalid`；提示词含「type=none 时 target 必须也是 none」。
- **L1**：usage chunk `{inputTokens:120,outputTokens:8,totalTokens:999}` 被 `onUsage` 原样捕获；无 chunk 时 null；宿主是否每次发 usage 仍按 D-15 写「未核实」。
- **L2**：50 条种子 + 100 次 `type=none` 后仍 50 条、最旧不变；追加真实事件后仍 50 条并裁掉最旧；`/状态` 样例仍为 `判定器：模型（近 24h 模型 7（70%），规则兜底 3（30%），平均 430ms，p95 460ms，最近失败 timeout）`。
- **L3**：`sess-1` → `x-opencode-session: sess-1`；`x-extra:1` 合并；authorization/content-type 不被覆盖；`[1]`/null 与非字符串值按预期报错。宿主侧结论仍是「provider wrapper 支持，但 `ctx.llm.stream` 是否透传 sessionId 未核实」，文档 D-15 已写明，符合要求。

### 2.3 r2 数字

- 三时区全量：默认 `Asia/Shanghai`、`TZ=UTC`、`TZ=America/New_York` 均为 **1219 tests / 33 suites / pass 1219 / fail 0**；日志 `D:\test\review-artifacts\r2-test-default.log`、`r2-test-utc.log`、`r2-test-ny.log`。
- 逐字节基线（r2 重跑）：`buildSections(DEFAULT_CARD)` 2001 B / `e55e987368a77df2153a8126ea99666173b69620de9e072d2b0afbef70f07a83`；`buildChatPrompt` 带上下文 640 B / `ecd5a198ec2d6184becbcce83c441250df863673bde9340c5394c1fb98e9bc6c`；裸卡 540 B / `1904ed77a2cf9445e003e444a1cacae1ee39e30078779e63546e6d45b78f0df1`；三例均与 v0.6.0 完全一致。
- 门禁：`node scripts/probe/run-headless.mjs --plugin --timeout 180000 --dsh D:\dsh\resources\runtime\cli\bin\dsh.cmd` 退出 0；round A/B 通过，round C `verdict=skip`（无凭据），末行 `plugin-gate: PASS (round A + round B + round C)`；日志 `plugin-gate-r2.log`。严格按「SKIP 不计 PASS」只算 A/B。
- `git diff --check 63fa07b..1fdfcbd` 退出 0；`known-debt.md` 已无 CRLF。
- tag：`git tag --list 'v0.6*'` 仍只有 `v0.6.0`。

### 2.4 可留债/发布注意

- D-15（宿主 `x-opencode-session`/usage 端到端）与 D-10（round C skip）与 r1 相同，均已在文档写明，可留债。
- L-1 是发布流程项而非代码缺陷：当前对象未 push，tag 可在 push 后补；但 README 的「已发布」文案应在 tag 真正存在后再保留，避免发布说明先行。
- 除 L-1 外，r2 未引入新的 H/M/L；`package.json` 仍 `0.6.1`、零依赖，`schema` 仍 v14，默认 `appraiser: "rules"` 未变。

## 3. 用户要求逐条核对

| # | 要求 | 结论 | 证据 |
|---|---|---|---|
| V60-M1 | llm 模式下 `BLAME`/`VENT`/`REASSURE` 专属句不再死代码；判定落库时记 `lastAppraisal{scope,type,at}`，下一轮 <10 分钟且未用过才借用，用完清除；不得在 apply 回调里直接改 `emotionTextByScope`；零增量/none 不外借 | **关闭** | `src/index.js:679` 建 `lastAppraisalByScope`；`:3008` 仅 llm 传 `minConfidence`；`:3011-3015` 仅 `moved` 且 `source==='llm'` 时 `set({type,at})`；`:2876-2883` `takeBorrowedAppraisal` 先删后判，`:2886` TTL `10*60*1000`；`:2842` 把借用类型传入 `runEmotionTurn`，`:2845` 只在 pre-step 写 `emotionTextByScope`，apply 回调（`:2986-3017`）不写它；`src/persona/emotion-wiring.js:231`、`:244-248` 把借用类型交给 `describe`，`src/persona/emotion.js:671-673` 分别命中 blame/vent/reassure。独立探针：blame/vent/reassure 三种判定下一轮分别得到三组专属句（见 4.4）；vent 第二轮为专属句、第三轮回落通用句、11 分钟后不再借用；llm confidence 0.6（<0.65）只产生一条全零增量事件且下一轮不借 blame；`type=none` 不产生 `note=llm` 事件且下一轮不借句 |
| V60-M2 | `REASSURE_SENTENCES` 不用「你」指她本人；四组句子都不得出现「你/他/她」（`describe` 外层模板 `你此刻：` 不算） | **关闭** | `src/persona/emotion.js:169` DESCRIBE、`:188` BLAME、`:197` VENT、`:203` REASSURE；REASSURE 已把指她本人的「你」改为「对方」。独立探针逐句遍历四组：DESCRIBE 12、BLAME 2、VENT 2、REASSURE 4，`/[你他她]/u` 命中 **0**。`你此刻：` 来自 `src/index.js` 的 `EMOTION_PROMPT_PREFIX`，不属于四组句子 |
| V60-M3 | 卡内 `emotion.appraiseMinConfidence` 默认 0.65、合法 0.5–0.95、越界回落并 warning（`emotion_appraise_min_confidence_invalid`）；只对 llm 来源生效，规则路径仍用 `AMBIGUOUS_CONFIDENCE=0.5`；低于阈值只写一条零增量事件；补「type=none 时 target 必须也是 none」；测试 0.6 llm 零增量、0.6 规则照常入账 | **关闭** | `src/persona/emotion-appraise.js:32/34/35` 默认/下限/上限；`src/persona/card.js:91` 默认卡、`:367-374` 缺省补 0.65、非法/越界回落并推 `emotion_appraise_min_confidence_invalid`；`:3008` 只在 `source==='llm'` 传卡值，规则传 `undefined`，`src/persona/emotion-wiring.js:317-324` 回落 `AMBIGUOUS_CONFIDENCE=0.5` 并在低于阈值时走零增量；`src/persona/emotion-appraise.js:78` 补了 `3.1 type=none 时 target 必须也是 none（不能出现 target=her、type=none）。`，`:173-177` 双向校验。配置探针：0.5/0.65/0.95 原样接受；0.49/0.96/0.4/1/`"0.7"`/null/NaN/Infinity 均回落 0.65 并带该 warning code；行为探针：llm 0.6 只写一条全零 blame，规则 0.6 写一条非零事件 `{pleasure:-7.04,arousal:1.57,dominance:-1.1,energy:-1.1}` |
| V60-L1 | `recordAppraisalUsage` 宿主 `{type:"usage"}` chunk 优先（`totalTokens`，否则 input+output），缺失时按 system+user+输出码点 ×1.0 估算；查证宿主 usage 类型声明；无法确认实际发出则写「未核实」 | **关闭（实际发出来源未核实，已按 D-15 留债）** | `src/index.js:2914-2946`：`totalTokens` → `ceil`；否则 `inputTokens+outputTokens`；否则遍历 messages 的 text 部分加 reply，按码点 ×1.0、`ceil`。`src/index.js:2979-2983` 通过 `onUsage` 接收；`src/platform/adapter.js:927-933` 消费 `chunk.type==='usage'` 并调用 `onUsage`。探针：`{inputTokens:120,outputTokens:8,totalTokens:999}` 被原样捕获；无 usage chunk 时回调为 null。宿主类型声明见 `D:\test\agent-plugin\.dsh-src\dsh-tool-cordis\lib\types\api-catalog.js:9073-9074` 的 `StreamChunk` 联合类型与 `:9441-9442` 的 `TokenUsage`；同一声明也内嵌在 `dsh-agent-preset-registry\lib\typert.host.js`、`dsh-subagent\lib\typert.host.js`。宿主 provider 是否每次真的发 usage，**未核实**（文档已有 D-15） |
| V60-L2 | `type=none` 不落 `emotion_events`（只进 `/状态` 统计）；每 scope 50 条保留窗口不被闲聊挤掉 | **关闭（type=none 口径；ambient 另见说明）** | `src/persona/emotion-wiring.js:321-323`：`type==='none'` 或 confidence≤0 时 `event=null`，不 append；`src/memory/store.js:93` `EMOTION_EVENT_RETENTION=50`，`:3382-3394` 插入后按 `at DESC,id DESC` 删除第 51 条以后。探针：先种 50 条，再调 100 次 `type=none`，仍为 50 条、最旧 id 不变；追加一条真实事件后仍为 50 条、最旧 id 被裁掉。补充：完整 pre-step 的首个 llm 闲聊轮次会因环境变化写 1 条 `ambient`（不是 `type=none`），随后 59 轮 none 未再追加；若验收把 ambient 也算“闲聊挤占”，需另立规则。`/状态` 样例见 4.5 |
| V60-L3 | `scripts/emotion-report.mjs` 的 `createLlmJudge` 支持 `EMOTION_APPRAISE_SESSION`→`x-opencode-session` 与 `EMOTION_APPRAISE_HEADERS`（JSON 合并，拒绝非对象/非字符串值，忽略 authorization/content-type）；宿主 `ctx.llm.stream` 是否自带该头必须给结论或写未核实 | **关闭（端到端未核实，已按 D-15 留债）** | `scripts/emotion-report.mjs:501-508`：trim 后注入 session 头；额外头合并，`authorization`/`content-type` 大小写不敏感跳过；`:532-545` 解析 JSON 对象、拒绝数组/null/非字符串值。探针：`sess-1` → `x-opencode-session: sess-1`；`x-extra:1` 合并；`authorization: Bearer ***` 与 `content-type: application/json` 未被覆盖；`[1]`/null 报 `EMOTION_APPRAISE_HEADERS 必须是 JSON 对象`，`{"a":1}` 报 `...a 必须是字符串`。宿主侧：`app.asar` 内有 `withOpenCodeSessionHeader`/`withSessionHeader`，在 `options.sessionId` 存在时补 `x-opencode-session`；`dsh-agent-loop\lib\index.js:1090` 把 `sessionId: this.session.id` 放进请求，`:877` 调 `ctx.llm.stream`。但 LLM runtime 是否把 `request.sessionId` 作为 `options.sessionId` 透传给 provider，**未核实**；`docs/emotion-appraiser.md:146-149` 与 `docs/known-debt.md:209-222`（D-15）已明确写「未核实」 |

## 4. 我实际跑出的数字

### 4.1 三时区全量

命令（每个工作树/时区单独执行）：

```text
C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --test
```

| 时区 | tests | suites | pass | fail |
|---|---:|---:|---:|---:|
| 默认（Asia/Shanghai） | 1218 | **33** | 1218 | 0 |
| `TZ=UTC` | 1218 | **33** | 1218 | 0 |
| `TZ=America/New_York` | 1218 | **33** | 1218 | 0 |

- 日志：`D:\test\review-artifacts\test-default.log`、`test-utc.log`、`test-ny.log`
- 基线 `d824b37`：1209 用例 / 33 套件 / 0 失败（`test-v060-default.log`）；v0.6.1 新增 9 个测试，未新增顶层 `describe`，所以套件数仍是 33
- **与要求的差异**：要求/发布说明写 34 套件；实际 33。仓库中 `test/**/*.test.js` 的顶层 `describe(` 计数为 **33**，不是 34。详见 M-1

### 4.2 逐字节基线

独立脚本 `D:\test\review-artifacts\probe-baseline.mjs` 同时从 `D:/test/wt-v060`（0.6.0）与 `D:/test/wt-review-v061`（0.6.1）导入并比较：

| 用例 | 一致 | 字节数 | SHA-256 |
|---|---|---:|---|
| `buildSections(DEFAULT_CARD)` | true | 2001 | `e55e987368a77df2153a8126ea99666173b69620de9e072d2b0afbef70f07a83` |
| `buildChatPrompt`（带上下文） | true | 640 | `ecd5a198ec2d6184becbcce83c441250df863673bde9340c5394c1fb98e9bc6c` |
| `buildChatPrompt`（裸卡） | true | 540 | `1904ed77a2cf9445e003e444a1cacae1ee39e30078779e63546e6d45b78f0df1` |

三个哈希在 0.6.0 与 0.6.1 上完全相同；不是只依赖 `test/persona-baseline.test.js` 的 fixture 断言。

### 4.3 门禁

命令（在 `D:\test\wt-review-v061`，捆绑 Node）：

```text
node scripts/probe/run-headless.mjs --plugin --timeout 180000 \
  --dsh D:\dsh\resources\runtime\cli\bin\dsh.cmd
```

退出码 0，末尾输出：

```text
plugin-gate: round A (smoke) exit=1 schedulerStarted=true didNotActivate=false
plugin-gate: round B (recall) exit=1 schedulerStarted=true didNotActivate=false recallCrash=false firstReneedAt=1794375762
plugin-gate: round C (consolidation) turns=1 exit=1 schedulerStarted=true didNotActivate=false consolidations=0 tokenEvents=1 maxTokensIn=0 credentials=missing session=session-03160308-b638-4e13-9790-26489da5bcb0 verdict=skip
plugin-gate: round C SKIPPED (no model credentials; two-turn consolidation cannot be asserted)
plugin-gate: PASS (round A + round B + round C)
```

严格按「SKIP 不计 PASS」口径：round A/B 通过，round C 因本机无模型凭据 **verdict=skip**，不能算 C 通过；脚本仍按现有实现打印总 `PASS`。日志：`D:\test\review-artifacts\plugin-gate-run.log`。门禁使用临时 `DSH_HOME=D:\test\wt-review-v061\.data\plugin-gate-home`。

### 4.4 M1 三组专属句与边界

独立脚本 `D:\test\review-artifacts\probe-m1-three.mjs`（日志 `probe-m1-three.log`）输出：

```text
blame: 现在心里被扎了一下，先稳住，别赌气，话少一点 | matches=true
vent: 现在有点心疼，先接住这份累，陪着就好 | matches=true
reassure: 有点想笑，其实没生气，想好好跟对方说一句没事 | matches=true
boundary 10m: isVent=true isDescribe=false
boundary 10m+1ms: isVent=false isDescribe=true
M1_THREE_OK
```

- 三组专属句都确实被下一轮借用，不是只有 vent 能工作
- 恰好 10 分钟仍借用（`<=`）；10 分钟 +1ms 才回通用句，与用户写的「<10 分钟」有边界差异，见 L-4

主探针 `probe-v061.mjs` 的 M1 结果：第二轮 VENT、第三轮 DESCRIBE、11 分钟 DESCRIBE；llm 0.6 只有一条 `note=llm` 全零 blame 且下一轮不借；`type=none` 的 `note=llm` 行数为 0 且下一轮通用句。

### 4.5 `/状态` 判定器行样例

用真实 `createAppraisalStats` + `handleCommand('/状态')` 生成（llm 模式，7 条 llm 样本 400–460ms，3 条 fallback timeout）：

```text
判定器：模型（近 24h 模型 7（70%），规则兜底 3（30%），平均 430ms，p95 460ms，最近失败 timeout）
```

对应实现：`src/runtime/commands.js:712-728`。来源占比按样本数统计，`type=none` 只进判定器统计，不落 `emotion_events`。

### 4.6 usage 头/来源样例

- adapter 收到的 usage chunk：`{inputTokens:120,outputTokens:8,totalTokens:999}`，`onUsage` 原样捕获；无 usage chunk 时 `captured=null`
- 宿主类型：`StreamChunk` 在 `D:\test\agent-plugin\.dsh-src\dsh-tool-cordis\lib\types\api-catalog.js:9073-9074` 含 `{ type: 'usage'; usage: TokenUsage }`；`TokenUsage` 在 `:9441-9442` 定义为 `inputTokens` / `outputTokens` / 可选 `totalTokens`
- 是否每次真实调用都由宿主 provider 发出 usage：**未核实**；代码已按「有则优先、无则码点估算」实现，属于 D-15 可留债项
- session 头：探针已验证脚本侧会注入 `x-opencode-session`；宿主侧 `withOpenCodeSessionHeader` 支持该头，但 `ctx.llm.stream` 到 provider 的 `sessionId` 透传仍**未核实**（D-15）

## 5. 新增问题清单

> 以下为 r1 对 `6d296e6` 的原始问题清单，保留以便追溯；r2 复核状态见 §2。M-1 与 L-2/L-3/L-4 已在 `1fdfcbd` 关闭，L-1 仍未关闭。

### M-1（M）发布口径的 34 套件与实测 33 不符

- 位置：`README.md:7`、`CHANGELOG.md:35`
- 事实：两处都写「1218 个用例 / 34 个套件」；三时区实测均为 1218 / **33** / 0
- 最小复现：

  ```text
  node --test
  # ℹ tests 1218
  # ℹ suites 33
  # ℹ pass 1218
  # ℹ fail 0
  ```

- 影响：发布说明与验收口径不真实；不影响运行时行为
- 建议：把 README/CHANGELOG 的 34 改为 33（并把任务验收口径同步为 33）；如果团队确实要 34 个套件，则给 `test/v061-fixes.test.js` 增加一个顶层 `describe`，再重跑三时区。修正后本项可关闭

### L-1（L）本地 tag `v0.6.1` 不存在，但 README 已写「已发布」

- 位置：`README.md:7`（`v0.6.1 已发布（2026-11-11，tag v0.6.1）`）
- 复现：

  ```text
  git tag --list 'v0.6*'
  # v0.6.0
  ```

- 建议：发布流程真正打 tag 后再保留「已发布」；或在当前未打 tag 阶段改为「待发布/候选」。若 tag 会在 push 后补打，可降为流程备注

### L-2（L）M3 测试的状态断言是恒真式

- 位置：`test/v061-fixes.test.js:75-78`
- 代码：

  ```js
  const state = temp.store.getEmotionState('main');
  assert.deepEqual(
    { pleasure: state.pleasure, arousal: state.arousal },
    { pleasure: state.pleasure, arousal: state.arousal },
  );
  ```

- 问题：左右两边读取同一对象，永远相等，不能证明「低于阈值不改状态」；真正有效的只有 `:74` 的事件行零增量断言
- 建议：在调用前后用同一 `FakeCtx` 时钟读取完整四维状态并比较，或断言 `state` 与仅衰减的期望值一致；至少不要用同一表达式自比

### L-3（L）`docs/known-debt.md` 整文件 LF→CRLF，制造 231 行 whitespace 噪音

- 位置：`docs/known-debt.md`（`d824b37..6d296e6`）
- 复现：

  ```text
  git diff --check d824b37..6d296e6
  # exit 2；231 条 trailing whitespace（输出 462 行，每条两行）
  ```

  `git diff --ignore-space-at-eol` 只剩 +15 行真实内容（D-15）。文件从 LF 整体改成 CRLF，增加 231 行假改动
- 建议：把该文件转回 LF 后只保留 D-15 的 +15 行；可加 `.gitattributes`（如 `*.md text eol=lf`）防止再次发生

### L-4（L）10 分钟边界用 `<=`，与「<10 分钟」不完全一致

- 位置：`src/index.js:2880`
- 代码：`now - pending.at <= BORROWED_APPRAISAL_TTL_MS`；TTL 为 `10 * 60 * 1000`（`:2886`）
- 复现：`probe-m1-three.mjs` 中把第二轮推进到恰好 10 分钟，仍得到 VENT 专属句；推进到 10 分钟 +1ms 才回 DESCRIBE
- 影响：只在「恰好整 10 分钟」这一瞬间多借一次，影响很小
- 建议：把 `<=` 改成 `<` 以严格匹配需求；若产品口径本来就是「10 分钟内（含）」，则在文档/注释里写明，不必改代码

## 6. 可留债项

- **D-15（宿主 `x-opencode-session` 与 `usage` chunk 端到端）**：本次只能确认脚本侧注入、宿主 provider wrapper 支持该头、宿主请求带 `sessionId`；无法确认 LLM runtime 是否把 `sessionId` 透传给 provider，也无法确认真实 provider 每次发 usage。文档已明确写「未核实」，符合用户要求，可留债；建议后续用真实宿主做一次端到端记录。
- **D-10（round C skip）**：本机无模型凭据，consolidation 无法断言；门禁输出已明确 `verdict=skip`，按「SKIP 不计 PASS」口径只能算 A/B 通过，可留债。
- **llm 闲聊轮次的 `ambient` 审计行**：完整 pre-step 的首个 llm 轮次可能写 1 条环境审计 `ambient`（本次 60 轮只出现 1 条），会占 50 条窗口 1 格；它不是 `type=none`，属于既有环境审计设计。若要求“任何闲聊轮次都绝不挤占事件窗口”，需另立规则；当前可按既有设计留债。
- **M3 内部阈值的防御宽度**：`applyClassifiedEvent` 接受 `0 < minConfidence <= 1`，而卡面只允许 0.5–0.95；正常入口已经由 `normalizeCardEmotion` 卡住，非用户可达，可不改。
- **`parseExtraHeaders` 未做 CR/LF 校验**：需求只要求拒绝非对象/非字符串值并忽略 authorization/content-type；当前实现满足，若未来接受不可信环境变量再补 header 注入防护。
- **额外头可覆盖 `x-opencode-session`**：当前合并顺序允许 `EMOTION_APPRAISE_HEADERS` 覆盖 session 头；需求未禁止，若希望 session 优先可调整合并顺序。

## 7. 其他核对

- 版本：`git show 6d296e6:package.json` 为 `"version": "0.6.1"`；`dependencies`/`devDependencies` 均不存在，零第三方依赖
- schema：`src/memory/store.js:81` `const SCHEMA_VERSION = '14';`，仍为 v14
- 默认 appraiser：`src/persona/card.js:88` `appraiser: 'rules'`；规则路径在 `src/index.js:3008` 传 `minConfidence: undefined`，`src/persona/emotion-wiring.js:317-319` 回落 `AMBIGUOUS_CONFIDENCE=0.5`。与 v0.5.2 的 `AMBIGUOUS_CONFIDENCE=0.5` 静态对齐；本次未单独跑 v0.5.2 行为探针
- 用户 `~/.dsh`：代码写入目标为配置的 store db/备份目录、显式 export/govern 输出；测试与门禁均把 `DSH_HOME` 指向临时目录，未发现直接写用户 `~/.dsh` 的路径
- CI：`.github/workflows/test.yml` 仅跑 `node --test`，矩阵为 UTC / America/New_York，没有 whitespace/diff 门禁；因此 L-3 不会让 CI 变红，但会给 review 制造噪音

复审基线 `d824b37` → 对象 `6d296e6`；三时区 1218/34/0（任务口径；实测 1218/33/0，见 M-1）。

复审基线 `d824b37` → r2 对象 `1fdfcbd`；三时区 1219/33/0（H0 / M0 / L1，pass）。
