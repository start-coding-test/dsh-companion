# V4-L2：召回块经压缩摘要回流（调查与缓解）

> 范围：v0.4.4 评审项 V4-L2。本文只记录调查结论、复现证据、风险与缓解，
> 不改 `memory/` 设计判据；设计边界仍以 `docs/usage.md` §R-L3 与
> `docs/platform-api.md` §2.1.1 为准。
>
> 结论：**问题真实存在，已做低成本缓解；残余风险需监控。风险等级：中低（L2）。**

## 1. 问题链条

1. 召回注入是完整平台消息，`source.kind = 'companion-recall'`，随会话 surface
   保留，直到下一次压缩把所在区间替换掉（`docs/platform-api.md` §2.1.1）。
2. 插件发起的巩固会在选区文本/转录里按 `source.kind` 排除召回块
   （`src/index.js` 的 `withoutRecallRecords`，v0.4.3 起生效），所以
   「注入 → 当轮巩固」本身已不会自我强化。
3. 但外部压缩（用户 `/compact` 或平台自动压缩）不经过插件的排除逻辑：
   `dsh-compaction-basic` 的 `buildSummarizationInput` 把区间内所有消息原样
   交给摘要模型，其中包含尚未巩固的召回块。
4. 摘要提示词要求「保留精确路径、命令、错误串、标识符、数值、函数签名」等，
   摘要模型很可能把召回块正文原样保留或合并进摘要。
5. 压缩后 surface 只剩摘要节点（`source.kind = 'compact-checkpoint'`）。
   surface 索引只保存 `{seq, role, text, tokens}`，`source` 在这一层已丢失；
   `withoutRecallRecords` 只识别「整条以 `[相关记忆]` 开头」的记录，识别不了
   「摘要正文中夹带召回段」的记录。
6. 下一轮巩固把摘要节点当普通用户发言读入提示词，召回内容经
   「摘要 → 巩固」重新写回 episode/facts，形成跨压缩的自我强化。

## 2. 复现证据

### 2.1 平台侧事实（只读检查，来源为安装包内代码）

- `dsh-compaction-basic/lib/index.js`：
  - `COMPACTION_INSTRUCTION`（约 `:245-282`）作为最后一条 user 消息下发，
    明确要求保留数值/标识符等原文；若已有 `<compacted-summary>`，要求
    「保留仍为真的事实、丢弃过期事实、合并新信息」。
  - `buildSummarizationInput`（约 `:686-701`）直接回放
    `systemHead(...)` + `shadowedSeqs.map(seq => deriveEventMessage(eventAt(seq)))`，
    **没有按 `source.kind` 排除任何消息的钩子**。
  - `frameSummary`（约 `:344-352`）用
    `This is an automatically generated checkpoint ...` + `<compacted-summary>`
    包裹摘要。
- `dsh-compaction/lib/index.js:95-121`：替换节点真实来源是
  `{ kind: 'compact-checkpoint', compactionId, … }`。
  `test/fakes/ctx.js` 目前用 `{ kind: 'system', reason: 'compaction' }` 模拟，
  与真实平台不完全一致（不影响本调查的文本链路，但影响「按 source 识别摘要」
  的潜在方案）。
- 公开 API `compactRegion(start, end, agent)` 不支持逐条排除消息。

结论：**无法在压缩前让摘要模型看不到召回块**；只能压缩后按文本特征剔除，
或明确接受摘要复述。

### 2.2 探针（fake compaction harness）

临时探针（不提交）：seed 事实「预算额度 8000」→ turn 1 用户问「预算额度是多少？」
→ 注入含 `8000` 的召回块 → 平台式外部压缩把这两条消息替换为回显式摘要
（checkpoint 外壳 + 原选区）→ turn 2 触发 41K hard 巩固。

结果（修复前）：

- 巩固提示词同时命中 `[相关记忆]` 与 `8000`，摘要节点被当作普通用户消息；
- 巩固草稿写出 episode「摘要里出现预算 8000。」，证明召回内容确实能进入
  episode 表；
- fact 三元组因去重未覆盖原 statement，但这仍证明回流路径存在
  （若摘要改写措辞，会新增一条「来自摘要」的事实）。

对应回归测试：`test/e2e/recall-compaction.test.js`（提交后可直接跑）。

## 3. 缓解（已实现）

### 3.1 成对标记

`src/memory/assemble.js` 的召回块由：

```
[相关记忆]
- (fact #…, 日期) …
```

改为：

```
[相关记忆]
- (fact #…, 日期) …
[/相关记忆]
```

`src/index.js` 新增 `RECALL_END_MARKER = '[/相关记忆]'`。成对标记使「摘要里夹带
召回段」具备可判定的起止边界。

### 3.2 巩固前文本剔除

`src/index.js` 新增 `scrubRecallBlocks(text)`：删除任意文本中完整的
`[相关记忆] … [/相关记忆]` 片段，保留其余摘要正文。
`withoutRecallRecords` 不再只处理「整条以标记开头」的记录，而是：

- 整条召回记录 → 文本置空（原行为）；
- 摘要等混合文本 → 删除夹带的完整召回段；
- 只有开头、没有结束标记 → **保持原文**，不做「删到结尾」的猜测，
  避免误伤摘要后文（有回归测试锁定）。

### 3.3 提示词防线

`src/memory/consolidate.js` 的 `buildConsolidationPrompt` 增加一行：

> 对话里形如 `[相关记忆] … [/相关记忆]` 的段落是历史检索快照，只能作为已知
> 内容的佐证，不得据此新建事实或改写现有结论。

用于兜住「结束标记被摘要模型丢掉、但开头标记还在」的情况。

## 4. 残余风险

缓解依赖「摘要模型至少保留成对标记」。若摘要把标记改写/删除，或把召回内容
改写成普通陈述，文本层无法再区分来源，仍可能回流。已知残留：

- 旧会话中已有的单标记召回块（无结束标记）在摘要里无法安全剔除；
- 摘要模型可能只保留 `[相关记忆]` 而丢弃 `[/相关记忆]`（此时提示词规则兜底，
  但不能保证模型遵守）；
- 摘要模型可能完全去掉标记，把数值并入正文（与 R-L3 的固有限制一致：
  摘要没保留的细节无法恢复，摘要保留的内容也无法区分来源）。

因此本项**不能宣称已根除**；风险从「无边界、必然回流」降为「标记完整时可剔除，
标记丢失时依赖模型与监控」。

## 5. 监控建议

1. **摘要节点抽查**：对 `source.kind = 'compact-checkpoint'` 的节点文本
   `grep '[相关记忆]'`，命中即说明摘要保留了召回段；统计每百次压缩的命中数。
2. **加固后计数**：`scrubRecallBlocks` 命中时可在 debug 日志记一条
   `recallScrubbed`（本次未加指标，避免扩大改动面）；若后续要量化，建议加
   counter 而非每轮日志。
3. **巩固侧信号**：观察 `memory_events` 中 `consolidate` 动作的 facts 去重命中
   （已有 dedupe 计数）与用户纠正/遗忘次数；若某条事实反复由摘要巩固回来、
   且随后被用户纠正，优先检查对应压缩节点。
4. **回归哨兵**：`test/e2e/recall-compaction.test.js` 已锁定「摘要复述召回块 →
   巩固窗口剔除」；平台摘要格式变化导致该测试失效时，应视为需要重新评估。

## 6. 变更文件

| 文件 | 变更 |
| --- | --- |
| `src/memory/assemble.js` | 召回块追加结束标记 |
| `src/index.js` | `RECALL_END_MARKER`、`scrubRecallBlocks`、`withoutRecallRecords` 扩展 |
| `src/memory/consolidate.js` | 巩固提示词增加召回段说明 |
| `test/e2e/recall-compaction.test.js` | 新增 V4-L2 回归（复述剔除 + 标记不完整不越界） |
| `test/e2e/recall-injection.test.js`、`test/v044-regression.test.js` | 断言改为只检查「对话：」后的选区正文（提示词说明行含标记本身） |
| `docs/recall-compaction.md` | 本文 |
