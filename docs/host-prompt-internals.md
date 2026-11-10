# 宿主 prompt 内部机制取证（v0.5.1）

本文记录 v0.5.1 两项修改（V50-M2 模板占位符、V50-M3 情绪注入）所依据的宿主行为，
每条都带**文件:行号**。宿主版本：DSH 0.4.x（Electron 44.7.0 / Node 24.21.0），
源码取自 `D:\dsh\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\`（与
`.dsh-src` 解包副本一致）。

## 1. 片段与上下文的插值是「严格模式」，未知变量直接抛错

`@deepseek-ai/dsh-system-prompt/lib/index.js`

| 事实 | 位置 | 说明 |
| --- | --- | --- |
| 只有 `interpolate === false` 才跳过插值 | `:120`（`renderPrompt`）、`:156`（`renderContextSections`） | 其余一律调用 `interpolate()` |
| 插值实现 | `:160-184` | 扫描 `{{...}}`；组内容不匹配 `/^[a-z][a-z0-9_]*$/` → 抛 `malformed prompt variable reference`（`:167,173`） |
| 未注册变量 | `:174-177` | 抛 `unknown prompt variable "{{time}}"; registered variables: …` |
| 变量值为 `undefined` | `:178-179` | 抛 `prompt variable "{{time}}" has no value for this assembly` |
| 半截 `{{`（无后续 `}}`） | `:164-171` | 视为普通文本，不抛 |
| 段对象保留 `interpolate` | `:386-394` | 注册时传什么就原样带进 assembly |
| `section()` 只校验 order 有限 | `:255-258` | `interpolate` 不校验类型，`false` 即关闭 |
| `context()` 同样支持 `interpolate` | `:281-284` | 与段同构 |
| 装配 waterfall | `:401` | `system-prompt/assemble`，参数 `(assembly, context, next)` |
| `complete` 段会被强制恢复为唯一段 | `:383-384,401-410` | 多个 `complete` 直接抛错；装配后只剩它一段 |

**结论**：酒馆卡里的 `{{random:晴,雨}}`、`{{time}}`、`{{original}}` 不是被忽略，而是让
整轮渲染失败。我方必须在渲染期把它们降级（`{{x}}` → `{x}`），并对自建段显式
`interpolate: false`。v0.5.0 的 `renderTemplate` 只替换 `{{char}}`/`{{user}}`，剩下的会原样
进入提示词——这是 V50-M2 的真实故障点，已用严格复刻宿主的 mock 复现
（`test/v051-template.test.js` 的 `hostInterpolate()`）。

**我方注册面**：`src/platform/adapter.js:375-382` 的 `section()` 原样转发对象，因此
`src/persona/sections.js` 产出的四段与 `persona:state_board` 都带 `interpolate: false`；
`src/persona/shadow.js` 的 rewrite 分支也强制 `interpolate: false`（替换文本来自卡，
不能被宿主再插值一遍，否则残余花括号会炸）。

## 2. 动态上下文（`systemPrompt.context`）的投影语义

`@deepseek-ai/dsh-agent-loop/lib/index.js`

| 事实 | 位置 | 说明 |
| --- | --- | --- |
| 快照投影类 | `:297` `RuntimeContextProjection` | 跟踪「最后一条仍在 surface 上的运行时上下文快照」 |
| 去重 | `:333-348` `project(current, sections)` | `this.retained?.text === snapshot` → 返回 `undefined`，**不产消息** |
| 新快照形状 | `:337-347` | `user/message`，`source.kind='runtime-context'`、`form:'snapshot'`、`sections` 带各 context 的 `{name,text}` |
| 变化后的写入方式 | `:862` | `surfaceOp: "append"` —— **追加，不替换** |
| 旧快照如何失效 | `:213` 的 `CLEARED` 文案与快照首行 | 靠「This snapshot supersedes earlier runtime-context snapshots.」让模型忽略；平台没有替换旧节点的 API |
| 何时重新解析 provider | `:843-847` | 请求前 `refreshContext(assembly, …)` 重新调用 `text(context)`，所以 pre-step 里更新的文本当步生效 |
| 首次装配早于 pre-step | `:679-696` | `assemble()` 在 `agent/pre-step` waterfall 之前；只有 fallback 决策才用首次装配的上下文 |
| 被替换（压缩）时才清空 | `:318-325` | `isReplacementSurfaceEvent` 覆盖旧 seq 时 `retained = null` |

**结论**：改成 `systemPrompt.context` 能拿到「文本不变就不重复注入」这个真实收益，
但「变化后历史里不残留旧句」**做不到**——平台是追加 + supersede 语义，只有压缩才会把旧快照
从 surface 上换掉。插件层没有 surface 替换 API，强行实现需要改宿主核心。v0.5.1 采用宿主
机制，并在 `docs/emotion-injection.md` 如实写明这一点。

## 3. 我方接线点

| 目标 | 位置 |
| --- | --- |
| 注册段 | `src/index.js` `registerSections`（`persona:safety/core/voice/protocol`、`persona:state_board`） |
| 注册上下文 | `src/index.js` `registerEmotionContext`（`companion-emotion`，order **320**，`interpolate: false`） |
| `system-prompt/assemble` 监听 | `src/platform/adapter.js:438` `onAssemble`；`src/index.js:806-835` |
| pre-step | `src/index.js:1367` `runPreStep` |

CONTEXT_ORDERS 已被宿主占用 100–210（`dsh-system-prompt/lib/index.js:46-54`），故本插件取 320，
排在所有内建上下文之后。

## 4. 复现与验证

- 严格 mock（复刻 `interpolate()` 与 `renderPrompt()`）：`test/v051-template.test.js`。
  含 `{{random:晴,雨}}`/`{{time}}`/`{{original}}` 的卡在 v0.5.0 算法下抛
  `unknown prompt variable "{{time}}"`，v0.5.1 下渲染为 `{time}`/`{random:晴,雨}` 且无 `{{`。
- 投影去重：`test/emotion-context.test.js` 用 mock 复刻 `project()`，同一文本连续三轮只产
  1 条消息；文本变化后产新条。
- 真机门禁：`node scripts/probe/run-headless.mjs --plugin` 的 round A/B 见
  `docs/review-round-ab-v0412.md` 的口径；v0.5.1 发布前重跑。
