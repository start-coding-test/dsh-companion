# 情绪句注入：从自建 user 消息到 systemPrompt.context

V50-M3 把「你此刻：…」这句情绪描述从插件自建的 user 消息，改成宿主
`systemPrompt.context()` 注册的动态上下文。插件仍然负责算情绪、写事件、生成一句话，
但「怎么出现在模型上下文里」交给宿主；重复文本的去重也由宿主的 runtime-context
投影负责，插件不再每轮追加一条假 user 消息。

## 1. 为什么不再自建 user 消息

旧实现（v0.5.0）在 `runPreStep` 里调用 `injectEmotion`，后者用 `emotionMessage()`
造一条完整的 `user/message`：

```js
{
  role: 'user',
  content: [{ type: 'text', text: '你此刻：…' }],
  source: { kind: 'companion-emotion', form: 'snapshot', sections: [...] },
}
```

这条消息并不是用户说的话，却占用了 user 角色。为了不让它污染会话，插件不得不在
多个地方额外排除它：

- `hasRealUserInput()` 跳过 `source.kind === 'companion-emotion'`；
- `isInjectedMessage()` / `textRows()` 跳过同一 kind；
- `lastUserText()` 还要按 `EMOTION_PROMPT_PREFIX` 前缀再挡一次；
- 转录捕获也要跳过同一前缀。

这些排除规则本身没有错，但它们说明了一个问题：插件在模拟宿主已经提供的机制。
每轮都 append 一条 user 消息，还会让「同一句话连续出现」变成历史里的重复节点；
旧实现只能靠 `turnSeen` 在插件侧按 turn 去重，换会话、换 scope 或进程重启后
并没有宿主级的文本级去重。

宿主从 0.5.x 起提供 `systemPrompt.context()`：插件注册一个 provider，宿主在每次
装配（以及每次请求前）重新解析文本，只有文本变化时才把新的 runtime-context
快照写进历史。情绪句正好是「一段会变、但不需要每轮重复的附加上下文」，适合这个
机制。

## 2. 宿主侧机制与投影语义

以下行号来自本机宿主源码 `D:\test\agent-plugin\.dsh-src`，实现时已逐条核对。

### 2.1 注册与渲染

- `dsh-system-prompt/lib/index.js:281-284`：`context(context)` 注册动态上下文；
  `order` 必须是有限数字，否则抛
  `prompt context "<name>" order must be a finite number`。
- `dsh-system-prompt/lib/index.js:398`：装配时 `assembly.contexts` 按 `order`
  升序排列。
- `dsh-system-prompt/lib/index.js:143-158`：`renderContextSections()` 对每个条目
  取 `text`；只有 `interpolate !== false` 的条目才做 `{{var}}` 插值，未知变量会
  抛错；`text.length === 0` 的 section 在渲染时被过滤掉。

因此插件注册时使用：

```js
{
  name: 'companion-emotion',
  order: 320,          // 宿主 CONTEXT_ORDERS 已占 100–210，320 留给插件
  interpolate: false,  // 情绪句是普通中文，不做 {{var}} 插值
  text: (context) => emotionContextText(state, context),
}
```

`order` 只影响同一份系统提示词里的段落顺序，不影响消息历史。

### 2.2 投影去重：相同文本不产生消息

- `dsh-agent-loop/lib/index.js:333-348`：`RuntimeContextProjection.project(current, sections)`
  比较「本次渲染出的文本」与「上一版保留的文本」。两者完全相同则返回
  `undefined`，**不产生任何消息**；只有变化时才创建一条 `user/message`，
  其 `source.kind = 'runtime-context'`、`form = 'snapshot'`、`sections` 记录各
  context 的 `{name, text}`。
- `dsh-agent-loop/lib/index.js:843-847`：每次请求前调用
  `systemPrompt.refreshContext(assembly, …)` 重新解析 context provider，再执行
  `project()`。所以 pre-step 里刚更新的情绪文本，在同一步的请求里就能被取到。
- `dsh-agent-loop/lib/index.js:862`：新快照以 `surfaceOp: 'append'` 追加到会话。

这条去重是**文本级**的：同一 scope 连续多轮算出同一句「你此刻：现在心情平稳……」
时，只有第一轮会产生快照，后续轮次一条都不追加。情绪句变化后才出现新快照。

### 2.3 旧快照不会被替换

必须明确一个事实：**平台没有替换旧快照**。新快照只是 append，旧快照仍留在消息
历史里。宿主依赖快照正文的第一行让模型忽略旧版本：

- `dsh-system-prompt/lib/index.js:140-141`：

  ```text
  Current runtime context. This snapshot supersedes earlier runtime-context snapshots.
  ```

  也就是说，「旧句被替换」不是平台行为；平台只是追加新快照，并在新快照开头声明
  它取代更早的 runtime-context 快照。插件的去重只能减少重复快照的数量，不能
  删除历史里的旧快照。文档与验收断言都不应声称旧快照会被替换或消失。

## 3. 插件侧实现

### 3.1 适配层

`src/platform/adapter.js`：

- `capabilities.systemPromptContext` 判断宿主是否声明了
  `systemPrompt.context` 函数；
- `context(entry)` 转发到 `ctx.systemPrompt.context(entry)`，缺少能力时抛
  `unavailable('no-system-prompt', 'ctx.systemPrompt.context()')`。

平台测试对「有 context」「只有 section、没有 context」两种能力面都做了覆盖。

### 3.2 注册时机与降级

`src/index.js:455-472`，在 `registerSections()` 之后、同一段 `apply` try 块里：

```js
if (state.card?.emotion?.enabled === true) {
  try {
    track(platform.context({
      name: 'companion-emotion',
      order: 320,
      interpolate: false,
      text: (context) => emotionContextText(state, context),
    }));
  } catch (error) {
    platform.log('warn', '[dsh-companion] emotion context unavailable; emotion line disabled', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- 情绪关闭时**完全不注册**，默认路径不读库、不写库、不产生 context；
- 宿主缺 `context()` 时只 warn 一次（这一段只执行一次），降级为不注入，不挡装配；
- 注册返回的 disposer 交给 `track`，插件卸载时自动注销。

### 3.3 provider 与 scope

`src/index.js:2794` 的 `emotionContextText(state, context)`：

1. 用 `routeSession(state, { agent: context?.agent })` 解析当前会话；
2. 解析失败只 warn，返回 `''`，provider 本身绝不抛错；
3. `kind === 'subagent'` 直接返回 `''`；
4. 其它会话返回 `state.emotionTextByScope.get(scope) ?? ''`；未算过的 scope
   自然得到空串。

`routeSession`（`src/index.js:1170` 起）为此做了防御性加固：`state` 不是对象、
`classifySession` 抛错时都兜底成主会话；日志与 metrics 改为可选调用。

### 3.4 只算不注入

`injectEmotion(state, payload, messages, turnKey, scope = SCOPE)`
（`src/index.js:2742`）保留原有的 turn 去重、工具尾跳过、`lastUserText` 取文本、
`runEmotionTurn` 计算与 try/catch 口径，但不再返回 `{ inject: [...] }`：

- 情绪启用且计算成功：`state.emotionTextByScope.set(scope, '你此刻：' + result.line)`，
  返回 `null`；
- 情绪关闭：`state.emotionTextByScope.delete(scope)`，返回 `null`，不读也不写库；
- 计算失败：沿用原来的 warn
  `[dsh-companion] emotion injection failed`，返回 `null`。

`runPreStep` 不再读取 `emotion?.inject`，只把 command hint、privacy hint 和
recall 结果合并成 `inject`。`emotionMessage()` 已删除；`EMOTION_SOURCE_KIND`
常量保留，用于继续排除旧转录里的 `companion-emotion` 消息。

### 3.5 runtime-context 不再被当作用户输入

宿主快照的 `source.kind` 是 `runtime-context`。`src/index.js:170` 新增
`RUNTIME_CONTEXT_SOURCE_KIND`，并让 `isInjectedMessage()`（`src/index.js:3043`
起）识别它。`textRows()` / `lastUserText()` 因此会跳过快照，取到真正的用户文本；
`hasRealUserInput()` 原本就已有同一判断。

这也修掉了一个潜在问题：如果宿主把上一轮的情绪快照放在消息列表里，而插件又把它
当用户输入去分类，就会把「你此刻：…」反过来当成新事件。现在不会。

## 4. 行为对照

| 场景 | context 注册 | provider | 库读写 | 消息注入 |
| --- | --- | --- | --- | --- |
| 情绪关闭（默认） | 否 | 不会调用 | 否 | 无 |
| 情绪启用，主会话 | 一次 | `你此刻：…` | 每 turn 至多一次 | 由宿主投影决定 |
| 情绪启用，线程会话 | 一次 | 该线程 scope 的句子或 `''` | 同上 | 由宿主投影决定 |
| 子代理 | 一次（同插件） | `''` | 否 | 无 |
| 宿主缺 `context()` | 尝试一次后 warn | 无 | 照旧（若启用） | 无 |

## 5. 验证

- `test/emotion-context.test.js`（7 个用例）覆盖：注册一次且 `name/order/interpolate`
  正确、关闭时不注册、缺能力时只 warn 一次、主会话前缀、子代理空串、未算过的线程
  空串、投影 mock 去重、无 `companion-emotion` 消息、`lastUserText` 跳过
  `runtime-context`。
- 去重 mock 完全按宿主 `project()` 语义实现：相同文本返回 `undefined`，变化才追加
  一条 `runtime-context` 快照。固定时钟、连续三轮同一句时只产出 **1 条**；第 4 轮
  换成会改变情绪档位的冲突文本后产出第 **2 条**。
- `test/emotion-wiring.test.js` 的旧断言已从「找到一条注入消息」改为「context 注册
  一次 + provider 文本」，默认用例额外断言 `ctx.contexts.length === 0` 且没有
  `systemPrompt.context` 调用。
- 全套测试在默认时区、`TZ=UTC`、`TZ=America/New_York` 下均为
  **1164 tests / 33 suites / 1164 pass / 0 fail**（旧基线 1111；v0.5.1 新增 7 个情绪
  上下文用例、2 个 platform 能力面用例，其余用例来自 H1 / M1 / M2 / L3 的补充）。

## 6. 对召回注入（injectRecall）的评估

`injectRecall`（`src/index.js:2818` 起）目前仍走「插件构造 user 消息」的旧路径。
本版**不迁移**，理由：

1. **召回文本几乎每轮都变**。召回结果带本轮查询、预算裁切和来源片段，文本随用户
   输入变化；宿主投影的「同文本才去重」几乎不会命中，迁移后仍会每轮追加快照，
   去重收益接近于零。
2. **召回必须紧跟本轮用户消息**。召回的语义是「回答这句话时参考这些事实」，它需要
   出现在本轮用户消息之后、模型回复之前；统一放进 systemPrompt.context 会改变它
   在上下文中的位置与优先级，可能削弱「这一轮该用这条记忆」的提示。
3. **迁移收益只出现在极少数重复查询**。只有用户连续重复同一句话、且召回结果完全
   一致时，投影去重才省下一条快照；为这个边缘场景改动召回主路径，风险大于收益。

后续若宿主的 context 机制支持「按位置注入」或「每轮强制刷新但不落历史」，可以
重新评估召回迁移；当前版本保持现状，并由 `docs/known-debt.md` 的 D-13 跟踪。

## 7. 限制

- 旧 runtime-context 快照仍留在历史里，插件无法删除；这是宿主 append 语义决定的。
- 情绪句变化频率低时，历史中的快照数量会明显少于旧实现（旧实现每轮一条）,但并非
  恒定为一条。
- `order: 320` 是当前宿主未占用的区间；宿主若新增同区间段，需要重新选值。
- 情绪关闭时连注册都不发生，因此宿主侧不会出现空的 `companion-emotion` section。
