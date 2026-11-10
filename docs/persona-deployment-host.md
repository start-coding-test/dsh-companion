# 人格卡接管宿主默认人设：`deployment:persona` 取证与遮蔽方案

取证对象：本机 DSH 桌面版 0.4.x 安装包（asar，代码只读）+ `dsh-companion@0.4.12`（6eedde9）。
路径记号：`$D = D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai`。`app.asar` 是**文件**，普通 shell 读不到内部目录，取证时用
`$env:ELECTRON_RUN_AS_NODE='1'; & 'D:\dsh\DeepSeek Harness.exe' <script.cjs>` 读 asar 内路径；行号即该 asar 内文件的行号。

## §1 结论摘要

1. 宿主**没有** `deployment:persona` 这个段。它注册的是 `deployment:persona-prefix`（order **0**，人设本体）与 `deployment:persona-suffix`（order **10200**，收尾），名字是常量、不可配。`deployment:persona` 是旧版宿主的单段名，xilin3 的 README 记录了上游的这次拆分（`deployment:persona` → prefix/suffix，见 §5）。
2. 段文本**不是 i18n**：`dsh-system-prompt` 自己的 Config 默认 `personaPrefix: ""`，真实默认人设由分发 profile 的 bundle patch 写进 `personaPrefix`；桌面预设 `standard` 又用 `@deepseek-ai/dsh-persona` 在 agent scope 里同名遮蔽一次。所以"宿主默认人设"有两个来源，要分别处理。
3. **全局层同名注册必抛**（同层重复 = 错，跨层同名 = 覆盖）。`dsh-companion` 现在以 profile 行挂载（`.data/plugin-gate.patch.yml` 直接 insert `../src/index.js`），落在全局层，`section({name:'deployment:persona-prefix'})` 只会在 apply 阶段抛错，不可能抢到这个名字。错误文案本身指出唯一出路：`register through that agent's \`agent.ctx\``。
4. 从 profile 行能改写的**唯一**口子是 `system-prompt/assemble` waterfall：探针实测可把 `deployment:persona-prefix` 从最终 sections 里删掉（§4 S4）。但 `complete: true` 的段在 waterfall 之后被**强制恢复为唯一段**（L410），所以 `complete` 既能顶掉所有段，也挡不住别人把段塞回来——不是"只关一段"的工具。
5. `section()` 只在注册时校验 `order` 是有限数字（实测 `TypeError`）；`text` 允许 `string | (context) => string`（实测函数形式），运行时不校验 `text` 类型（实测 `text: 42` 注册成功，到渲染才炸）。`assemble()` 产出的 section 对象**丢掉 `order`**，只剩 `{name, text, interpolate?}`——按 order 排序只能发生在注册表内部。

## §2 证据表

| 问题 | 文件:行号 | 原文/代码 |
| --- | --- | --- |
| Q1 名字常量 | `$D/dsh-system-prompt/lib/index.js:61,63` | `const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";` / `const PERSONA_SUFFIX_SECTION = "deployment:persona-suffix";` |
| Q1 order 数值 | 同上 `:10-45` | `SECTION_ORDERS = { HARNESS_IDENTITY: -1e3, DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500, …, WEB_SURFACE: 10100, DEPLOYMENT_PERSONA_SUFFIX: 10200 }` |
| Q1 注册点 | 同上 `:235-239` | `this.section({ name: PERSONA_PREFIX_SECTION, order: this.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"), text: config.personaPrefix ?? "" })` |
| Q1 注册点（suffix） | 同上 `:240-244` | 同构，`name: PERSONA_SUFFIX_SECTION`，`text: config.personaSuffix ?? ""` |
| Q1 默认原文 | 同上 `:216-222` | `static Config = z.object({ includeHarnessIdentity: ….default(true), includeRuntimeContext: ….default(true), personaPrefix: z.string().default(""), personaSuffix: z.string().default(""), toolOrder: ….default(void 0) })` |
| Q1 实际部署文本 | `$D/dsh-web-app/cordis.patch.yml:17-20` | `- id: system-prompt` / `config:` / `personaPrefix: >-` / `You are a coding agent powered by the {{model}} model.`（同文本见 `$D/dsh-headless/cordis.patch.yml:12`） |
| Q1 预设层再遮蔽 | `$D/dsh-web-app/presets/standard.patch.yml:11-14` | 预设里挂 `@deepseek-ai/dsh-persona`，`prefix: You are a coding agent powered by the {{model}} model.` |
| Q2 装配时机（每 step） | `$D/dsh-agent-loop/lib/index.js:679`（`preStep` 内），`:742`（`turn()` 调 `preStep`） | `const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet });` |
| Q2 assemble 早于 agent/pre-step | 同上 `:685,691` | `const decision = await this.dispatch.waterfall("agent/pre-step", {...})`；其 `next` 里才 `renderContextSections(assembly)` |
| Q2 调用方传的 scope | `$D/dsh-agent/lib/index.js:407` | `assembleContextFor` 返回 `{ agent, scope: agent, ...signal }` —— scope key 就是 agent 实例 |
| Q2 注册先后 | `.probe-dump-config.yml:366` vs `:395`（探针实测 composition） | `- id: system-prompt` 在前，插件行（`- id: probe-persona-deployment`）在后；`SystemPrompt` 构造函数 apply 时就注册两段，插件 apply 时同名已存在 → 见下一条错误 |
| Q2 重名=替换/追加/报错 | `$D/dsh-system-prompt/lib/index.js:204-207` + `$D/dsh-scope/lib/index.js:27-38` | 全局错误：`prompt section "${name}" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)`；scope 内：`… is already registered in this scope`；`insert()` 里 `if (data.has(name)) throw this.duplicateError(name)` |
| Q2 跨层=替换（非追加） | `$D/dsh-scope/lib/index.js:177-181` | `merge(scope, pick) { const merged = new Map(pick(this.global).entries()); for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value); return merged; }` |
| Q2 scope 链方向 | 同上 `:162-169` | `chainLayers(scope)`: `scopeChainOf(scope).reverse()` —— 远祖先在前、最近 scope 最后，故近者胜 |
| Q3 `text` 类型 | `$D/dsh-tool-cordis/lib/types/api-catalog.js:7610` | `PromptSection { readonly name: string; readonly order: number; readonly text: string \| ((context: AssembleContext) => string); readonly interpolate?: boolean; readonly complete?: boolean; }` |
| Q3 唯一性校验 | `$D/dsh-system-prompt/lib/index.js:255-258` | 仅 `if (!Number.isFinite(section.order)) throw new TypeError(\`prompt section "${section.name}" order must be a finite number\`)`，再 `layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section))` —— 没有别的 name 校验，`text` 不做类型检查 |
| Q3 语义说明 | `$D/…/api-catalog.js:3729-3730` | `section(section: PromptSection): () => void`，描述：`…A scoped section shadows a global section with the same name; duplicates within one layer and non-finite orders throw…` |
| Q3 assemble 丢 order | `$D/dsh-system-prompt/lib/index.js:386-394` | `const assembled = { name: section.name, text: …, ...section.interpolate !== void 0 ? { interpolate } : {} }`（无 `order`）；排序在 `:382` `[...sectionByName.values()].sort(comparePromptSections)`，`:103-105` 比较 `a.order - b.order \|\| compareNames(…)` |
| Q3 assemble 入口 | 同上 `:358-365` | `async assemble(context = {}) { const scope = context.scope; … const sectionByName = this.layers.merge(scope, (layer) => layer.sections);` —— 不传 `scope` 就只看全局层 |
| Q3 空文本丢弃 | 同上 `:119-121` | `renderPrompt`：`…filter((text) => text.length > 0).join("\n\n")` —— `text: ""` 的段存在但不会进 prompt |
| Q3 complete 强制恢复 | 同上 `:383-384,401,410` | 多个 complete → `throw new Error(\`multiple complete prompt sections are active: …\`)`；waterfall 后 `sections: completeSection === void 0 ? transformed.sections : [completeSection]` |
| Q3 waterfall 签名 | `$D/…/api-catalog.js:5188` | `'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptPresentation, context: AssembleContext, next: () => Promise<PromptPresentation>): Promise<PromptPresentation>` |
| Q4b 官方同类做法 | `$D/dsh-persona/lib/index.js:36-47` | 在 **agent scope** 里 `section({ name: PERSONA_PREFIX_SECTION, order: childCtx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"), text: config.prefix, ...config.complete ? { complete: true } : {} })`；文件头 `:7-11`：`this row is scope-only … mounted globally it collides with the registry's own registration and fails loud.` |
| Q4a 子代理先例 | `$D/dsh-subagent/lib/index.js:391-395` | `name: "deployment:persona-prefix", order: childCtx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"), text: composition.persona` |
| Q4a scope 从哪来 | `$D/dsh-agent-preset-registry/lib/index.js:511-513` | `const key = {}; const scope = createScope(this.owner, key);`（preset 挂载即 scope）；`$D/dsh-scope/lib/index.js:296-299` `createScope` = `ctx.plugin(scope)` + `fiber.ctx.extend({ [kScope]: key })` |
| Q4c config 开关 | `$D/dsh-system-prompt/lib/index.js:216-222` | Config 只有 `personaPrefix`/`personaSuffix` 两个**字符串**，没有 `includePersona` 之类布尔开关 —— 想关只能把文本置空 |
| Q4c patch 语义 | `.probe-schema.json:148`（`--dump-config-schema` 输出） | `An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged.` |

## §3 遮蔽方案对比

| 方案 | 做法 | 证据 | 风险/副作用 |
| --- | --- | --- | --- |
| a) 同名 section 覆盖 | 在 **agent scope**（agent.ctx、agent preset、子 agent）里 `section({ name: 'deployment:persona-prefix', order: 0, text })` | `dsh-scope:177-181`（近层 `Map.set` 覆盖）、`api-catalog:3730`（"A scoped section shadows a global section with the same name"）、`dsh-persona:7-11`、`dsh-subagent:391-395` | 只影响**该 scope**；profile 行拿不到 scope，除非把 dsh-companion 改挂进 preset（牵动发布形态）。同一 scope 内二次注册即抛错。宿主 `harness:identity`/`persona:suffix` 不受影响 |
| b) waterfall 改写 | profile 行 `ctx.on('system-prompt/assemble', async (assembly, context, next) => …)`，过滤或替换 `deployment:persona-prefix` | `system-prompt:401`（waterfall 调用）、`api-catalog:5188`（签名）、探针 S4（实测删除成功） | 影响**所有 scope**（除非自己按 `context.scope` 过滤），会盖掉 preset/子代理的 persona；`complete` 段在之后被强制恢复（L410），所以对 complete 场景要么一起接管 complete，要么放弃；必须 `await next()` 再返回新对象，误改原数组会污染其它监听器 |
| c) config 关闭 | 在用户 home 的 `cordis.patch.yml` 里 `- id: system-prompt` + `config: { personaPrefix: '' }` | `system-prompt:216-222`（只有字符串字段）、`.probe-schema.json:148`（config wholesale 替换） | 只能改"部署层"那一份，preset 里的 dsh-persona 仍会注册默认人设；改的是部署配置（不属于插件职责，且本任务禁止插件写 `~/.dsh`）；`config` 整块替换，别的字段（`includeRuntimeContext`/`toolOrder`）会回落到默认值 |

## §4 探针（真跑通，无需凭据）

探针文件在**仓库外**，不进 git：`.probe-persona\probe-plugin.js`、`.probe-persona\persona-probe.patch.yml`、临时 home `.probe-persona-home\`。

```powershell
$env:DSH_HOME='D:\test\agent-plugin\.probe-persona-home'
& 'D:\dsh\resources\runtime\cli\bin\dsh.cmd' --profile headless `
  --patch D:\test\agent-plugin\.probe-persona\persona-probe.patch.yml
```

overlay 只做三件事：关掉 `headless-runner`（不调模型、不要凭据）、关掉 `tools`（本组合没有 tool executor，否则工具段 provider 抛 `ToolExecutorUnavailableError`）、追加只读探针行。

实际输出（`exit=0`，完整在 `.probe-persona\probe-out.txt`）：

```
HARNESS_IDENTITY = -1000 / DEPLOYMENT_PERSONA_PREFIX = 0 / DEPLOYMENT_PERSONA_SUFFIX = 10200 / PLAN_POLICY = 500
S2: Error: prompt section "deployment:persona-prefix" is already registered (for a per-agent override, register through that agent's `agent.ctx` instead)
S3 order="0": TypeError: prompt section "probe:bad-order" order must be a finite number
S3 text=42: no throw (registered; type is not checked at runtime)
-- S1: assemble({}) global layers: 3 section(s)
   harness:identity = "You are an AI agent powered by DeepSeek Harness."
   deployment:persona-prefix = "You are a coding agent powered by the {{model}} model."
   deployment:persona-suffix = ""
-- S4: after waterfall filter: 2 section(s)      ← prefix 被监听器删掉
-- S5: complete active: 1 section(s)             ← complete 段把被删的列表整个顶掉
   probe:complete = "PROBE-COMPLETE"
S5: complete is the only section: true
-- S6: disposed back to host default: 3 section(s)   ← disposer 全部还原
```

结论：段名/order/默认文本如上；全局同名注册必抛且错误文案点明 `agent.ctx`；waterfall 删段可行；`complete` 段在 waterfall 之后仍然独占；`section.order` 在装配结果里是 `undefined`（数组顺序才是排序结果）。

## §5 参考实现摘要（GitHub，经 `127.0.0.1:7897` 代理只读抓取）

- **`xilin3/dsh-prompt-persona`**（main，取到）：正是本问题的完整解。`lib/index.js:127-137` 在 `system-prompt/assemble` 里改段：
  `const disposeAssembly = ctx.on('system-prompt/assemble', async (assembly, _context, next) => { const assembled = await next(); … const current = assembled.sections.find((section) => section.name === PERSONA_PREFIX_SECTION) … return sections === assembled.sections ? assembled : { ...assembled, sections } })`。
  `lib/index.js:94-104` 的 `applyPersona` 支持 `replace` / `append` / `off` 三态；`lib/index.js:81-85` 的 `deploymentPersonaPrefix(ctx)` 通过 `loader.entries()` 找 `entry.options.name === '@deepseek-ai/dsh-system-prompt'` 再读 `config.personaPrefix`，用来判断"这段还是不是部署层原文"——被更高 scope 遮蔽时不动它（`README.md:75`）。`cordis.patch.yml:12-14` 把插件作为 **profile 行**插入，即与 dsh-companion 同一层。
  其 README 与本次取证一致：`README.md:55-59` 明确 `deployment:persona` 已拆成 `deployment:persona-prefix`（order 0，身份）与 `-suffix`（order 10200，收尾）。
- **`yyh-001/dsh-companion`**（main，取到，但是旧命名）：`index.js:159-164` 注册 `name: 'deployment:persona', order: 0, text: () => cache || '# 你是谁…'`（函数文本，印证 `text` 可为函数）。它用的是**旧名**，在 0.4.x 上既不会撞车也不会遮蔽——只会作为 order 0 的第四段并排出现（同为 order 0，按段名比较时紧挨 `deployment:persona-prefix`）。`README.md:47` 的建议反而是对的："从 `standard` 预设拷贝一份、删掉 `persona` 行——人设由本插件接管，同一作用域不能注册两个同名段"。

## §6 对 dsh-companion 的实现建议

**开关挂哪层**：`persona.shadowDeployment: 'off' | 'rewrite' | 'takeover'`（默认 `off`）。

- `rewrite`：profile 行注册一个 `system-prompt/assemble` 监听器，只替换 `deployment:persona-prefix` 的 `text`（人格卡正文），保留 `order`/`interpolate` 语义，其余段原样返回。落点：`src/platform/adapter.js` 新增 `onAssemble(handler)`（紧邻 `onPreStep`，`src/platform/adapter.js:389-402` 同款 `ctx.on` 守卫），在 `src/index.js:749-764` `registerSections` 之后接线，`track(...)` 接 disposer。
- `takeover`：同上但 `sections: [只留 persona:core 与 harness:identity]`，显式关掉 `deployment:persona-prefix` **和** `-suffix`；此时**不要**用 `complete: true`——`complete` 会顺带顶掉工具段与 runtime context（探针 S5），副作用不可控。
- 不要试图在 profile 行用同名 `section()` 抢名（必抛）；也不要改 preset（发布形态改动大）。
- 需要判断"当前文本还是不是部署层原文"时用 §5 的办法读 loader entry config，避免把 preset/子代理的人设也踩掉。

**mock 需要校验的参数与时序**（`platform.section` 语义在 `src/platform/adapter.js:375-381`，`text` 已是 `string|Function`）：

1. `section({order: '0'})` → 抛 `TypeError`，且错误消息带段名（对齐宿主 `:255-258`）。
2. 同一层重复 `name` → 抛 `Error`（文案含 `already registered`），不得静默覆盖。
3. `text` 传函数时，`assemble(context)` 会以 **assemble context** 调用它（`:{agent, scope, signal, modelSelection, toolSet}`），断言函数收到的参数、以及返回 `Promise` 时的行为（宿主不做 await，返回 Promise 会变成 `[object Promise]`）。
4. `assemble` 产出的 section 只有 `{name, text, interpolate?}`：断言实现**不依赖 `section.order`**（宿主 :386-394 已丢弃）。
5. waterfall 监听器签名 `(assembly, context, next)`，断言 `await next()` 被调用一次；返回对象不得复用入参数组（`sections` 必须新数组）。
6. 不传 `scope` 时只看全局层（宿主 :358-359）：断言 mock 的 `assemble({})` 与 `assemble({scope})` 走不同分支。
7. `complete` 段：注册两个 → 抛 `multiple complete prompt sections are active`；注册一个 → 断言最终只剩它（宿主 :410）。`rewrite` 模式必须**不**设置 `complete`。

**测试怎么造**：优先纯函数单测——把改写逻辑抽成 `applyDeploymentShadow(sections, {mode, personaText})`（形如 xilin3 的 `applyPersona`），直接喂 `[{name:'deployment:persona-prefix', text:'…'}, {name:'harness:identity'}]`，断言名字命中时替换、未命中时**返回原数组引用**（便于上游做 `sections === input` 短路）；再接一个假 `ctx` 的接线测试：`ctx.on` 记录 `(event, listener)`，手工 `await listener(assembly, {}, () => Promise.resolve(assembly))`，断言事件名是 `system-prompt/assemble`、disposer 被 `track` 收走。测试风格沿用 `test/persona.test.js`（`node:test` + `node:assert/strict`），host 侧真实行为别 mock，直接用本文件 §4 的探针命令做冒烟。
