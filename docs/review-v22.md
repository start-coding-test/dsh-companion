# v0.6 情绪判定改造 发版前复审（review-v22）

- 复审对象：`D:\test\agent-plugin\dsh-companion`，分支 `main`，HEAD **20d4d01**（`20d4d016636829ce4bc2647b136f786750fb8080`，工作树干净、未 push）。
  - 任务下发时 HEAD 为 `1f44d08`；复审期间上游追加了 `0673e96`（/状态 占比与失败分类）和 `20d4d01`（文档），据 parent 指示以 **20d4d01** 为准。`1f44d08` 仍是主体实现，两个追加提交只改 `src/runtime/commands.js`、`scripts/emotion-report.mjs`、`test/v060-report.test.js` 与两份文档。
- 基线：标签 `v0.5.2` = `6e1130c`；对照 worktree `D:\test\wt-v052`（detached）。
- 评审在独立干净 worktree `D:\test\wt-review-head`（detached 20d4d01）中进行，避免污染待提交仓库；自写探针放在仓库外 `D:\test\review-probes\`。
- 运行时：捆绑 Node 24 `C:\Users\93488\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；未使用 PATH 中的 Node 18。
- 方法：逐行读 `6e1130c..20d4d01` diff；自己写脚本做逐字节基线、mock LLM 接线、队列、/状态、E5 CLI 与本地 OpenAI 兼容端点；跑三时区全量测试与 headless 门禁。未使用仓库里已删除的临时脚本，也未改 `src/` 或测试。

## 结论

**needs_revision**（H 0 / M 2 / L 8）。

主体设计与大部分要求已落地：判定器文件、严格 JSON 解析、500/300 截断、脱敏、13 个少样本、pre-step 不等待、每 scope 1 在途 + 1 排队、覆盖旧句走规则、超时/非法/无模型/预算兜底、note 来源码、schema 仍为 14、E5 报告脚本、L1 称呼，均通过核对与实测。

但有两项必须修复后才能发版：

1. **M1 斜杠命令仍会被送去模型判定**（与 `docs/emotion-appraiser.md:62` 及 E2 明确要求相反；实测 `/状态` 触发 1 次模型请求并落一条 `note=llm` 事件）。
2. **M2 模型返回的 `intensity` 字段没有接线**：`src/index.js:2900-2911` 调 `applyClassifiedEvent` 时只传 `classified`，`src/persona/emotion-wiring.js:324` 回落到 `intensityFor(confidence)`；实测同一 confidence 下 intensity 0.1 与 0.9 写入的四维增量完全相同，模型 intensity 实际被丢弃。

其余 L 级问题不单独阻塞发版，但建议至少修 L1/L5/L6 的文档与严格性，并在修复 M1/M2 时补上对应回归测试。

## 逐条核对表

### E1 判定器

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| E1.1 | 新文件 `src/persona/emotion-appraise.js`；输入仅本轮用户文本、上一条回复、卡 name，不送整段历史 | 通过 | `src/persona/emotion-appraise.js:109-130`；探针请求固定 2 条消息（system + user），回复块只含上一条 assistant，最后一条回复 9 码点，无历史数组。 |
| E1.2 | 用户文本截断 500 码点、回复截断 300 码点 | 通过 | 同文件 `:110-111`；探针 600 码点文本 → 分隔块内 500 码点，400 码点回复 → 300 码点；`truncateCodepoints('😀'*600,500)` = 500 码点 / 1000 UTF-16。 |
| E1.3 | 发送前走现有凭据脱敏 | 通过 | 同文件 `:110-111`（先脱敏再截断）、`:119`（分隔块声明）；`api_key=sk-reviewFAKE123456` 在消息中变为 `api_key=[凭据已省略]`，secret 未出现在请求里。 |
| E1.4 | 输出严格 JSON，target/type/intensity/confidence 四字段，枚举外、越界、非 JSON 一律失败 | 部分通过（L1） | `:138-176`；valid 通过，代码块/枚举外/越界均 `invalid`。但 `:154-173` 只解构四字段，**额外键被静默接受**：`{"...","pleasure":99,"arousal":-99}` 仍成功返回四字段（L1）。 |
| E1.5 | 模型不得输出 PAD 增量；提示词为代码常量，含 12–15 个少样本；用户文本放分隔块并声明不是指令 | 通过（严格性见 L1） | `APPRAISE_SYSTEM_PROMPT` 常量，`用户这句话：` 计数 = 13；分隔标记 `<<<用户这句话开始>>>` / `<<<用户这句话结束>>>` 与「不是指令」声明均在；提示词规则 4 明确「不要输出 PAD 数值」（`:72`），规则 5 声明分隔块不是指令（`:73`）。 |
| E1.6 | confidence < 0.5 只记事件不加增量 | 通过 | `src/persona/emotion-wiring.js:298-319`；探针 confidence=0.49 → 四维增量全 0、库中 note=llm；0.5 → 增量非零。 |

### E2 调用时机

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| E2.1 | pre-step 照常衰减与描述并立即返回，不等模型；后台判定，结果到达后 applyEvent，下一轮生效 | 通过 | `src/index.js:2782-2839`；mock 延迟 200ms 时 preStep=10ms，模型返回前非 ambient 事件=0；成功路径请求 1 次、消息 2 条，结果到达后写库。 |
| E2.2 | 每 scope 至多 1 在途 + 1 排队；新句覆盖排队旧句，旧句改走规则且事件不丢 | 通过 | `src/persona/emotion-appraise.js:251-384`；队列探针 submit A/B/C → `B:rules:fallback:superseded`、`A:llm`、`C:llm`，judgeCalls=2，inflightMax=1，最终 3 条事件都在。 |
| E2.3 | 超时（默认 8000）/失败/无模型/预算拒绝走 v0.5.2 规则 classify 兜底 | 通过（L2 见下） | 超时探针 apply `rules:fallback:timeout`；非 JSON `rules:fallback:invalid`；无模型 `rules:fallback:nollm`；`canCall:()=>false` 时 judgeCalls=0、apply `rules:fallback:budget`（`src/index.js:2882`）。 |
| E2.4 | 同一事件只入账一次（不得规则先加、模型再加） | 行为通过，测试缺口 L8 | llm 模式 `skipEvent`（`src/index.js:2817`、`emotion-wiring.js` skipEvent 分支）；成功路径非 ambient 事件=1、总事件=2（仅含 ambient）；兜底路径非 ambient=1。接线测试只断言 `events[0]`，未断言 `length===1`。 |
| E2.5 | 路由优先 `emotion.appraiseModel`，未配置复用既有 LLM 路由 | 通过 | `src/index.js:2847-2855`；卡内 `{provider:'card-provider',model:'card-model'}` 实测请求 provider/model 均为 card-*，优先于环境路由。 |
| E2.6 | 斜杠命令、工具尾、空文本、子代理不判定 | **部分失败（M1）** | 工具尾、纯空白、subagent 均 requests=0、事件=0（`src/index.js:2791-2796` + `:1449` 子代理早退）。但 `/状态` 在 llm 模式下 requests=1、落 `note=llm` 事件；`injectEmotion` 无任何 `/` 判断。详见 M1。 |

### E3 配置

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| E3.1 | 卡内 `emotion.appraiser: "rules"（默认）|"llm"` | 通过 | `src/persona/card.js:337-343`；`{}` → rules；`"llm"` → llm；非法值 → rules + `emotion_appraiser_invalid` 警告。 |
| E3.2 | 默认值下行为与 v0.5.2 一致 | 通过（/状态 多一行，见 L6） | `enabled` 默认 false、appraiser 默认 rules；默认不发请求；三时区全量测试通过；基线逐字节一致（见下）。 |
| E3.3 | `emotion.enabled=false` 不发请求，单测断言调用 0 | 通过 | 接线探针 requests=0、事件 0；`test/v060-appraise.test.js:376-406` 明确断言 `requests===0`、`countEmotionEvents===0`。 |
| E3.4 | `appraiseModel` / `appraiseTimeoutMs` 校验 | 通过 | `src/persona/card.js:345-367`；非法 model → null + 警告；timeout 99/60001 → 8000 + 警告；合法值 trim 保留。 |

### E4 预算与可观测

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| E4.1 | 判定 token 计入每日预算（与 recordTurnUsage 同一本账），受同类闸门约束，超额走规则 | 通过（测试覆盖 L8） | `src/index.js:2861-2869` 调同一个 `recordTurnUsage(state.budget, ...)`（对话路径在 `:1885`）；`refreshBudget` 后更新 `budgetTripped`；`canCall` 在 `:2882`。队列级预算拒绝实测走 `rules:fallback:budget`；未做端到端熔断注入（state 未暴露）。 |
| E4.2 | 不改 schema（仍 v14） | 通过 | `src/memory/store.js:81` `SCHEMA_VERSION='14'`；`store.js` 不在 `6e1130c..HEAD` diff 中。 |
| E4.3 | note 写 `llm` / `rules` / `rules:fallback:<原因>`，不写原文 | 通过（通用 error 未实测） | 探针实测 `llm`、`rules`、`rules:fallback:invalid`、`rules:fallback:timeout`、`rules:fallback:budget`、`rules:fallback:nollm`、`rules:fallback:superseded`；note 与日志均不含用户原文。`error` 分支由代码 `catch` 覆盖，未单独造模型异常。 |
| E4.4 | `/状态` 加一行：模式、近 24h 来源占比、平均延迟与 p95、最近失败原因 | 部分通过（L5） | `src/runtime/commands.js:613-615`、`:712-729`；llm 三态实测见下。**rules 模式在 `:716-717` 直接短路成「近 24h 无判定」**，永远不显示来源占比/延迟/失败，与 `docs/usage.md:176-177` 的「规则模式有样本时统计规则次数」不符（L5）。 |
| E4.5 | 日志不打印用户原文 | 通过 | 成功路径日志与 note 不含原文；`submitAppraisal`/queue 的日志只带原因码与 message（`src/index.js:2936-2939`、队列 log 分支）。 |

### E5 评测

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| E5.1 | `scripts/emotion-report.mjs` 支持 `--input <jsonl>` 与 `--appraiser llm|rules` | 通过 | `parseArgs` 实测；未知参数/多输入/缺文件均报错；`--appraiser rules` exit=0。 |
| E5.2 | llm 模式走 OpenAI 兼容端点，地址/key 从环境变量读 | 通过 | 本地 mock 端点：207 次 POST `/v1/chat/completions`，`Authorization: Bearer review-key`，model `review-model`，temperature=0，max_tokens=200，messages=2，system 含 13 个少样本；缺 env exit=2 且提示三个变量。 |
| E5.3 | 输出准确率、混淆矩阵、中性误触发、blame 误报、错误类别 | 通过 | mock 实测输出准确率、混淆矩阵、`blame 误报 151`、`中性句误触发率 55/68`、`判定失败 41 句，按原因：invalid 41`；`errorKinds` 已接入（0673e96）。 |
| E5.4 | 单测用 mock 模型覆盖成功、非 JSON、枚举外、超时、排队覆盖、预算拒绝、enabled=false 零调用、同一事件不重复入账 | 基本通过（L8） | `test/v060-appraise.test.js` 覆盖 parse 枚举越界、队列成功、非法 JSON、超时、预算、覆盖、enabled=false；`test/v060-report.test.js` 覆盖 judge 请求/失败、阈值、/状态。**没有斜杠命令测试；接线成功测试未断言事件总数恰好 1**（L8）。 |

### L1 称呼

| # | 要求 | 结论 | 证据（文件:行号 + 实测） |
| --- | --- | --- | --- |
| L1.1 | `REASSURE_SENTENCES` 不用「他」指用户，改「你」或卡内 address | 通过 | `src/persona/emotion.js:203-208`：四条全部用「你」，无「他/她」。 |
| L1.2 | 其余情绪句一并检查，不写死性别 | 通过 | `src/persona/emotion.js:169-208` 四组句表；grep `src/persona`、`src/runtime` 后「他/她」只出现在注释、分类词表、对「她」（人设）的第三人称，不指用户性别。卡内 address 替换未实现，但需求允许用「你」。 |

## 亲自跑的探针与数字

### 1. 三时区全量 `node --test`

在 `D:\test\wt-review-head`（20d4d01）用捆绑 Node 24 跑三次，日志分别在 `D:\test\review-probes\test-default.log`、`test-UTC.log`、`test-America-New_York.log`：

| TZ | tests | suites | pass | fail | exit | duration_ms |
| --- | --- | --- | --- | --- | --- | --- |
| 默认 | 1205 | 33 | 1205 | 0 | 0 | 6665.1681 |
| `UTC` | 1205 | 33 | 1205 | 0 | 0 | 6613.6698 |
| `America/New_York` | 1205 | 33 | 1205 | 0 | 0 | 6708.2319 |

结果与要求的 1205/1205/0 一致。Windows 上 Node 24 确认响应 `TZ`（`new Date(0)` 在 New York 下为 GMT-0500）。

### 2. 逐字节基线（自写脚本 `baseline-compare.mjs`）

以 `v0.5.2` 的 `D:\test\wt-v052` 与 HEAD 的 `D:\test\wt-review-head` 对照；两边的 `DEFAULT_CARD` 都是 `emotion.enabled=false`。用例取自仓库自己的 `test/persona-baseline.test.js:67-89`（带上下文 / 裸提示词），不是仓库临时脚本：

| 对象 | v0.5.2 长度 / sha | HEAD 长度 / sha | 结果 |
| --- | --- | --- | --- |
| `JSON.stringify(buildSections(DEFAULT_CARD))` | 861 / `e55e987368a7` | 861 / `e55e987368a7` | 一致 |
| `buildChatPrompt`（带 recentTopics/recallSummary/messageCount） | 232 / `ecd5a198ec2d` | 232 / `ecd5a198ec2d` | 一致 |
| `buildChatPrompt`（裸 card） | 186 / `1904ed77a2cf` | 186 / `1904ed77a2cf` | 一致 |

`BASELINE: PASS (3/3 byte-identical)`。HEAD 的 sections 只有 `persona:safety`、`persona:core`、`persona:protocol`，没有 voice/emotion 段；情绪关闭且卡中无 `{{x}}`/注释时基线未漂移。

### 3. E1 / E2 mock LLM 探针（`probe-e2.mjs`）

- **E1 消息**：2 条；`systemChars=1717`；`用户这句话：` 13 个；用户文本 500 码点、回复 300 码点；分隔块与「不是指令」声明均存在；卡 name「珞然」出现。
- **脱敏**：`api_key=sk-reviewFAKE123456` → `api_key=[凭据已省略]`，请求中不含 secret。
- **parse**：valid 通过；代码块、枚举外、越界均 `invalid`；额外 `pleasure=99/arousal=-99` 被接受（L1）；confidence 0.49 被接受并走零增量。
- **成功路径**：mock 延迟 200ms，preStep=10ms；模型返回前非 ambient 事件=0；requests=1、provider/model=`env-provider/env-model`、messages=2；事件 type=vent、note=`llm`、非 ambient=1、总事件=2；deltas=`{pleasure:-2.1,arousal:-0.7,dominance:0.69,energy:0}`；日志/note 无用户原文。
- **非 JSON**：requests=1，type=blame，note=`rules:fallback:invalid`，非 ambient=1。
- **enabled=false**：requests=0，事件总数=0。
- **斜杠命令 `/状态`**：requests=1、note=`llm`、非 ambient=1 → **M1 复现**。
- **工具尾 / 纯空白 `   ` / subagent**：requests=0、事件=0。
- **无可用模型**：requests=0，note=`rules:fallback:nollm`，type=blame。
- **路由**：卡内 `appraiseModel` 实测生效（card-provider/card-model）。
- **队列预算拒绝**：`canCall:()=>false` → judgeCalls=0，apply `rules:fallback:budget`。
- **队列覆盖**：最终 `B:rules:fallback:superseded, A:llm, C:llm`；judgeCalls=2；inflightMax=1；3 条事件都在。
- **低置信度**：0.49 → deltas 全 0、note=llm；0.5 → 非零（pleasure -4.48 等）。
- **超时**：timeoutMs=40 + 永不 resolve 的 judge → apply `rules:fallback:timeout`；第一次裸进程 `await drain()` 出现 `Warning: Detected unsettled top-level await`、EXIT=13，原因是 `src/persona/emotion-appraise.js:315` 的 `timer.unref?.()`；加 keepAlive 后通过（L2）。

### 4. `/状态` 判定器行（三态实测）

通过已注册的 `status` 命令 handler 取实际输出：

1. llm 混合（2 次成功 + 1 次非 JSON）：
   `判定器：模型（近 24h 模型 2（67%），规则兜底 1（33%），平均 0ms，p95 0ms，最近失败 invalid）`
2. rules 模式（库中已有 `note=rules` 事件）：
   `判定器：规则（近 24h 无判定）`
3. llm 模式无样本：
   `判定器：模型（近 24h 无判定）`

说明：前三项占比/延迟/失败在 llm 模式可见；rules 模式与要求中的「近 24h 来源占比、平均延迟、p95、最近失败」不一致，见 L5。测试 `test/v060-report.test.js:122-147` 还覆盖了 7/3 占比、412ms、900ms、timeout 的格式。

### 5. E5 CLI 与本地 OpenAI 兼容端点（`probe-report.mjs`）

- `--input test/fixtures/emotion-golden.jsonl --appraiser llm`：exit=1；207 条请求全部符合上述 OpenAI 兼容形状；输出 `总体准确率：28/207 = 13.53%（门槛 ≥ 80.00%，未通过）`、`blame 误报：151 句`、`中性句误触发率：55/68 = 80.88%`、`判定失败：41 句，按原因：invalid 41`、`结论：未通过（退出码 1）`。
  - 该 mock 只返回固定的简单内容，13.53% **只证明统计/门槛/退出码生效，不代表真实模型质量**。
- 缺环境变量：exit=2，stderr 明确列出 `EMOTION_APPRAISE_BASE_URL|OPENAI_BASE_URL`、`EMOTION_APPRAISE_API_KEY|OPENAI_API_KEY`、`EMOTION_APPRAISE_MODEL|OPENAI_MODEL`。
- `--appraiser rules`：exit=0；`总体准确率：206/207 = 99.52%（门槛 ≥ 85.00%，通过）`；blame 0；中性 0/68。
- 阈值实际值：`scripts/emotion-report.mjs:26-33` 为 accuracy 0.85 / blameFP 2 / neutral 0.1；`THRESHOLDS_LLM` 在 `:36-40` 为 0.8 / 0 / 2/13。

### 6. headless 门禁

在 20d4d01 实跑：

```
node scripts/probe/run-headless.mjs --plugin --timeout 180000
...
plugin-gate: PASS (round A + round B + round C)
```

EXIT=0。round A/B 内部 exit=1 但门禁判定 PASS；round C `verdict=skip`（无凭据，预期）。日志：`D:\test\review-probes\gate.log`。

## 问题清单

### H（阻断）

无。

### M1（必须修）斜杠命令仍被送去判定

- 位置：`src/index.js:2782-2839`（`injectEmotion`），`:2791-2797` 只排除工具尾和空文本，`:2821-2830` 无条件 `submitAppraisal`，全函数没有 `/` 判断。
- 与要求冲突：E2 明确「斜杠命令不判定」；`docs/emotion-appraiser.md:62` 也写「斜杠命令、工具尾消息、空文本、子代理会话都不判定」。
- 实测：llm 卡下 dispatch 用户文本 `/状态` → `ctx.llm.stream` 调用 1 次、事件 type 非 none、note=`llm`、非 ambient=1。
- 最小复现：在 `test/v060-appraise.test.js` 的 `makePluginCtx` 场景中，把 `userMessage('/状态')` 作为 `agent/pre-step` 的 messages，等待队列 drain；断言 `requests===0` 且 `countEmotionEvents('main')===0`，当前实现会得到 1 和 1（或至少 1 条 llm 事件）。
- 建议修法：在取 `text` 后、`runEmotionTurn`/`submitAppraisal` 前判断 `text.trimStart().startsWith('/')` 并直接返回（是否记录 turnSeen 可按现有语义决定）；同时补已知命令与未知 `/foo` 两条测试。

### M2（必须修）模型 `intensity` 被丢弃，实际按 confidence 推导

- 位置：`src/index.js:2900-2911` 的 `apply` 只传 `classified: verdict`，没有传 `intensity`；`src/persona/emotion-wiring.js:322-330` 因此走 `Number.isFinite(intensity) ? intensity : intensityFor(classified.confidence)`，而 `intensityFor` 是 `clamp(0.5+confidence,0.5,1.5)`（`:83-88`）。模型 JSON 中合法的 `intensity` 从未被读取。
- 实测（直接调 `applyClassifiedEvent`，只改 `classified.intensity`）：
  - intensity=0.1、confidence=0.9 → `{pleasure:-2.1,arousal:-0.7,dominance:0.68,energy:0}`
  - intensity=0.9、confidence=0.9 → **完全相同**
  - intensity=0.1、confidence=0.5 → `{pleasure:-1.5,arousal:-0.5,dominance:0.49,energy:0}`
  - intensity=1.0、confidence=0.5 → **完全相同**
  - 接线路径中 confidence=0.9 实际按 1.4 的强度写库，而不是模型给的 0.4/0.1。
- 影响：E1 要求模型输出 intensity，E2 要求据此 applyEvent；现在该字段只是摆设，模型判定的力度完全由 confidence 重新推导，同一 confidence 下不同的情绪强度无法区分。
- 最小复现：直接调用两次 `applyClassifiedEvent`，传相同的 `classified:{target:'her',type:'vent',confidence:0.9}`，只把 `classified.intensity` 从 0.1 改成 0.9，比较 `store.listEmotionEvents` 的 deltas；当前完全相同。
- 建议修法：在 `src/index.js` 的 `apply` 中传 `intensity: verdict.intensity`（或让 `applyClassifiedEvent` 优先取 `classified.intensity`）；若产品希望保留 v0.5.2 的 0.5–1.5 力度区间，需明确映射（例如 `0.5 + intensity`）并补测试。修完同时覆盖「模型 intensity 不同 → deltas 不同」和「低置信度仍零增量」。

### L1 `parseAppraisal` 接受 schema 外字段（PAD 等）而不报错

- 位置：`src/persona/emotion-appraise.js:154-173` 只读取/校验四个字段，额外键被忽略。
- 实测：`{"target":"her","type":"vent","intensity":0.5,"confidence":0.9,"pleasure":99,"arousal":-99}` 解析成功，返回仍只有四字段。
- 影响：不会把 PAD 写库，但与「输出严格 JSON、字段恰好四个、非 JSON/越界一律失败、不做宽松修复」的边界有张力；模型若把 PAD 放进 JSON，当前不会提示。
- 建议：要么显式拒绝未知键（`Object.keys(parsed)` 仅允许四个），要么在文档里明确「额外键忽略」；前者更符合 E1 的严格口径。

### L2 超时 timer `unref` 导致裸进程 `drain()` 等不到超时

- 位置：`src/persona/emotion-appraise.js:313-316`，`timer.unref?.()`。
- 实测：队列 timeoutMs=40 + 永不 resolve 的 judge，在没有其它 handle 的独立进程里 `await queue.drain()` 触发 `Warning: Detected unsettled top-level await` 并以 13 退出；加一个 keepAlive interval 后正常得到 `rules:fallback:timeout`。
- 影响：插件进程通常有宿主 handle，线上影响小；但单测/独立脚本/宿主刚卸载时的 drain 可测试性差，且注释 `:363` 说 drain 供 dispose 用。
- 建议：测试里显式保留 timer，或 `drain()` 在等待超时期间使用 `setTimeout` 而非仅依赖被 unref 的 timer；至少补一条裸进程回归测试。

### L3 `superseded` 兜底是 fire-and-forget，dispose 也不 drain 队列

- 位置：`src/persona/emotion-appraise.js:354-359` 用 `void fallback(...)`；`:366-378` 的 `drain()` 只等 inflight/queued，不等这个 promise。`src/index.js:535-558` 的 `dispose()` 直接 `store.close()`，没有 `state.appraiserQueue?.drain()`。
- 影响：极端时序下（覆盖旧句后立即 dispose/关闭 store）被覆盖句的规则事件可能来不及写，或写到已关闭的 store 被 catch 吞掉，表现为「事件不丢」的边界不成立。正常运行时探针的 3 条事件都在。
- 建议：`drain()` 跟踪并等待 superseded promise；dispose 前 await 队列 drain（或至少停止接收并等待当前 apply）。若认为关闭时丢最后一条可接受，应在文档里写明，而不是注释宣称 dispose 使用。

### L4 `appraiserRoute` 死字段

- 位置：`src/index.js:594` 声明 `appraiserRoute: null`，全仓库无其它读写。
- 影响：无害但误导，说明路由缓存设计未完成。
- 建议：删除，或真正用于缓存 `resolveAppraiserRoute` 结果并处理失效。

### L5 rules 模式的 `/状态` 统计与文档不符

- 位置：`src/runtime/commands.js:716-717` 在 `mode==='规则'` 时直接返回 `判定器：规则（近 24h 无判定）`，不读 stats；`src/index.js:2885-2887` 的 `onSample` 只在判定队列里，rules 模式根本不进队列。
- 实测：rules 模式下即使库中已有 `note=rules` 事件，仍显示「近 24h 无判定」。
- 文档冲突：`docs/usage.md:176-177` 声称「规则模式…有样本时统计的是本进程内规则判定的次数」；`docs/emotion-appraiser.md:84-86` 的示例又写规则「无判定」，两份文档自相矛盾。
- 影响：默认配置（rules）下 E4 要求的来源占比、平均延迟、p95、最近失败不可见；这不是模型链路 bug，但可观测性要求未完整覆盖。
- 建议：要么 rules 模式也记录样本（source=rules，延迟为 0/不适用）并在状态行展示「规则 N（100%）」；要么把 `docs/usage.md` 改成与实现一致，并明确 rules 模式不展示延迟。二选一，别让文档继续矛盾。

### L6 `emotion.enabled=false` 时 `/状态` 仍显示判定器行

- 位置：`src/index.js:1007-1010` 无条件把 `{mode, stats}` 传给 `handleCommand`；`src/runtime/commands.js:613-615` 只要 `appraiser` 非 null 就 push，`formatAppraiserLine` 不检查 `emotion.enabled`。
- 实测：默认卡（enabled=false）下 `/状态` 同时输出 `情绪：未启用` 和 `判定器：规则（近 24h 无判定）`；`docs/usage.md:169` 写的是「情绪启用时」才有一行。
- 影响：默认 `/状态` 输出相对 v0.5.2 多一行，与 E3「默认值下行为与 v0.5.2 一致」的广义理解有出入；功能上无大碍。
- 建议：要么在 `enabled=false` 时不传 `appraiser`（保持旧输出），要么把文档改成「无论是否启用都显示判定器模式」；推荐前者，除非产品明确要常驻展示。

### L7 预算估算用 UTF-16 `.length`，文档写「码点」

- 位置：`src/index.js:2861-2862` 用 `promptText.length + replyText.length`；`docs/emotion-appraiser.md:79` 写「输入 + 输出码点 / 2」。
- 影响：BMP 中文无差异；emoji/增补平面字符会按 2 个 UTF-16 单元计，估算偏高（偏安全，不会低估预算），但与文档不一致。
- 建议：改用 `[...text].length` 或把文档改为「UTF-16 长度」；同时补一条非 BMP 的预算单测。

### L8 测试缺口：斜杠命令、接线层「只入账一次」

- 位置：`test/v060-appraise.test.js:301-406` 的接线测试只取 `events[0]`，没有 `assert.equal(events.length, 1)` 或 `countEmotionEvents`；全文件没有 `/状态` / `/foo` 的判定跳过用例。
- 影响：M1 正是因为没有这条测试而漏过；E2「同一事件只入账一次」目前只有 `applyClassifiedEvent` 单测（`:185-206`）间接覆盖，接线层没有计数断言。
- 建议：在修 M1 时补斜杠命令用例；在成功与兜底接线用例各加 `countEmotionEvents('main')===1`（或过滤 ambient 后的非 ambient 计数）。

## 发版建议

1. **先修 M1、M2**，并各补一条会失败的回归测试（斜杠命令零请求；模型 intensity 改变会改变 deltas）。
2. 修完重跑：三时区 `node --test`（应仍 1205/1205/0，新增测试后总数按实际记录）+ 逐字节基线 + `run-headless.mjs --plugin --timeout 180000`，确认末行仍为 `plugin-gate: PASS (...)`。
3. **M1/M2 修好前不建议发版**。L1/L2/L3/L5/L6 建议同批处理；L4/L7/L8 可随后续小版本清理。
4. E5 的 llm 模式目前只用 mock 端点验证了管线；真实模型上线前应使用真实 key 跑一次 golden，确认 80% / blame 0 / 中性 2/13 的门槛是否有现实可达性（本次 mock 的 13.53% 不可作为质量结论）。
5. 文档需要同步三处：斜杠命令（修好后即成立）、rules 模式统计（L5）、enabled=false 的状态行（L6）。`docs/emotion-appraiser.md:62` 当前是「说了但没做」，属于用户明确点名的「看起来实现了但其实没接线」，必须与代码一起修。

## 评审过程备注

- 任务下发时 HEAD 为 1f44d08；复审期间上游追加 0673e96/20d4d01，按 parent 指示改以 20d4d01 为准。20d4d01 的 `/状态` 占比与 E5 `errorKinds` 已实测生效；`test/v060-report.test.js` 的 7 个用例在 20d4d01 通过。
- 主仓库在复审结束时 HEAD=20d4d01、`git status --porcelain` 为空；本报告只新增 `docs/review-v22.md`，不改 `src/` 与测试。
- 探针与日志均在仓库外：`D:\test\review-probes\probe-e2.mjs`、`probe-report.mjs`、`probe-intensity.mjs`、`baseline-compare.mjs`、`probe-e2.log`、`probe-report.log`、`gate.log`、`test-*.log`。
