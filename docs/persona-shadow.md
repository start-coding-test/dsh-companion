# 遮蔽宿主默认人设（P2，v0.5.0）

本文说明 `persona.shadowDeployment` 的机制、三态语义、影响范围、实测依据与回滚方法。
宿主取证细节（段名、order、`complete` 语义）见 [persona-deployment-host.md](persona-deployment-host.md)。

## 为什么只能走 `system-prompt/assemble` waterfall

宿主 0.4.x 没有 `deployment:persona` 单段：人设本体是全局层注册的
`deployment:persona-prefix`（order 0），收尾段是 `deployment:persona-suffix`（order 10200）。
两个段名是 `@deepseek-ai/dsh-system-prompt` 里的常量，真实默认文本由 profile patch 的
`personaPrefix` 写入（`You are a coding agent powered by the {{model}} model.`）。

插件以 profile 行挂载在**全局层**，而全局层同名 `section()` 会直接抛「段已注册」错误
（`deployment:persona-prefix` 已被宿主占用）。想抢这个名字只能改挂 preset/agent scope，牵动发布形态；改宿主 `config.personaPrefix` 又需要写用户的 `~/.dsh`，
不属于插件职责。因此唯一可行入口是宿主每次装配都会调用的 waterfall：

```text
system-prompt/assemble(assembly, context, next) → PromptPresentation
```

实现不注册任何同名段，只在 `next()` 解析出最终 assembly 后返回一个**新对象**；传入的
sections 数组绝不原地修改（其它监听器可能仍持有引用）。`complete: true` 段在 waterfall
之后会被宿主强制恢复成唯一段，所以本实现完全不用 `complete`。

## 三态语义

配置写在现有 `persona` 可选段里（不参与 16 键安装自检）：

```yaml
persona:
  shadowDeployment: rewrite   # off（默认）| rewrite | takeover
```

| 值 | 行为 |
| --- | --- |
| `off`（默认，也接受 `false`） | **完全不注册** `system-prompt/assemble` 监听器。提示装配路径与旧版本逐字节一致（`/状态` 会多「部署人设：宿主默认」一行）。 |
| `rewrite`（`true` 等价） | 把 `deployment:persona-prefix` 的 `text` 换成人格卡的 `chatIdentity`（先按卡渲染 `{{char}}` / `{{user}}`）。位置与其它属性保留，但 `interpolate` 强制设为 `false`：替换文本来自人格卡、已按 §4 降级，不能再让宿主插值一遍（v0.5.1，见 [persona-card.md](persona-card.md) §4）。其余段原样。 |
| `takeover` | 从 assembly 摘掉 `deployment:persona-prefix`，以及 `text` 为空/纯空白的 `deployment:persona-suffix`。非空 suffix 保留并写一次 warn；非字符串 `text` 无法判定为空，按非空保守保留。 |

非法值（`on`、`1`、对象等）在配置归一化阶段 fail-fast：
`ConfigError('persona.shadowDeployment')`，不会静默回落。

`/状态` 增加一行（旧调用方不传 `shadow` 则不输出）：

```text
部署人设：宿主默认                 # off
部署人设：已替换（人格卡身份）      # rewrite
部署人设：已接管                   # takeover
```

这一行反映**实际注册结果**：宿主缺 `ctx.on`、注册未返回 disposer 等失败会回落 `off` 并写 warn。

## 影响范围

- 只处理 **agent scope**：宿主传给监听器的 `context.scope` 就是当前 agent 实例（实测
  `context.scope === context.agent`），判定条件是 `context.agent != null && context.scope === agent`。
  其它 scope/无 agent 的装配原样放行。
- **子代理不遮蔽**：用现有 `src/session/identity.js` 的 `classifySession(agent)` 判定，命中
  `kind === 'subagent'`（header `origin: 'subagent'`，或带 `delegationDepth` 且有
  `parentSession` 的旧 header）时直接返回 `next()` 结果。子代理有自己的人设/persona 段，
  不应被主会话的卡覆盖。
- **fork 子会话的已知限制**：fork 出来的会话若 header 只有 `parentSession`、没有
  `origin: 'subagent'` 或 `delegationDepth`，会被 `classifySession` 归为 `main`，因此仍会
  被遮蔽。这是沿用现有会话分类口径的结果；要改需先扩展 identity 的 fork 判定，不在本卡范围。
- 遮蔽的是**部署层文本**。preset 里的 `@deepseek-ai/dsh-persona` 如果也在 agent scope 注册同名
  段，宿主会先用近层覆盖全局层，waterfall 看到的就是 preset 文本；`rewrite` 会把它一并换掉，
  `takeover` 会把它摘掉。这是 waterfall 方案的固有影响面，见
  [persona-deployment-host.md](persona-deployment-host.md) §3。
- 不改人格卡加载、不写 `~/.dsh`、不联网；`dispose()` 时经 `track(...)` 注销监听器。

## 探针实测（真实 agent loop，非自造 context）

探针在真实 headless profile 里创建 agent 并触发一次装配，监听器 dump 后 `next()`。
overlay 只关掉 `headless-runner`（不调模型、不要凭据），保留 `tools`（真实 pre-step 会先
`tools.resolve`）。探针文件在仓库外，不进 git。

```text
context.keys = ["agent","modelSelection","scope","signal","toolSet"]
context.scope === context.agent = true
context.agent.id = probe-shadow-context
agent.session.header = {"version":4,"id":"probe-shadow-context","cwd":"...","isSeeded":false}
assembly.keys = ["contexts","sections","variables"]
assembly.sections = ["harness:identity","deployment:persona-prefix",...,"deployment:persona-suffix"]
next.return.keys = ["contexts","sections","variables"]
next.return === assembly = true
```

结论：

- `next()` 解析为完整的 `{ sections, contexts, variables }`，没有其它旁路字段；
- 没有下游监听器时它与传入 assembly 是同一引用，所以实现必须自己 `{ ...resolved, sections }`；
- 主会话 header 没有 `origin` / `parentSession`；子代理 header 的判定字段来自
  `dsh-subagent` 的 `childSessionMeta()`（本次未跑真实子代理装配，子代理口径由现有
  `classifySession` 单测与 header 契约保证）。

## 失败与降级

遮蔽永远不能挡住宿主装配：

- `next()` 自身抛错：继续抛（这是宿主的装配失败，不吞）；
- 段判定/转换抛错：吞掉，写一次 `handler-failed` warn，返回 `next()` 原值；
- 两个宿主段都不存在（宿主改版把段名换掉）：写一次 `missing-sections` warn（含 mode 与两个
  段名），返回原 assembly；
- `rewrite` 但只有 suffix/没有 prefix：写一次 `rewrite-missing-prefix` warn，原样返回；
- 同一原因在一个进程内最多 warn 一次，避免每轮刷日志。

`/状态` 仍显示配置的 mode（注册成功时），不会因为某次装配缺段而动态回退；排障时以日志为准。

## 回滚

把配置改回默认即可，**无需改卡或删数据**：

```yaml
persona:
  shadowDeployment: off
```

`off` 在 `apply` 阶段就不注册监听器，行为与 v0.4.12 一致。配置在 `apply` 时读取，改完需重启
宿主（或重载 profile）；本插件没有热加载。若要彻底移除，删除该子键同样按 `off` 处理。
