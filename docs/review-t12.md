# t12 集成接线专项审查（review-t12）

- 审查对象：commit `1c4fc9c` 中原卡 inScope 外的 4 个接线/同步文件 + 新增 e2e（队长 m00034 指定 4 项）。
- 审查人：reviewer；日期 2026-11-03；verdict 依据 H=0 判据。
- 相关总报告：docs/review-v1.md（本文件只覆盖 t12 专项，不重复全量结论）。

## verdict: pass_with_findings（专项无 H；M1/M2 记录，其中 M2 与总量报告 H1 同根）

## 1) src/index.js 接线审计

**注册顺序与能力门卫 —— 通过。** apply(ctx,rawConfig)：normalizeConfig fail-fast → logger.info('config ok',{warnings}) → host null 早退 → createAdapter → Store.open → metrics。六组注册全部先查能力再注册：`index.js:91 systemPrompt、113 preStep、139 commands、169 tools、198 timer`、archive 见 `index.js:301`——FakeCtx/部分能力宿主不会踩 PlatformError。

**命令中文转发 —— 通过。** 平台 name 仅收 `/^[a-z][a-z0-9_-]*$/`（host 限制），4 条 ASCII 名 cost/memory/threads/status 各挂 definitionId `dsh-companion/command-*`，handler 把 `invocation?.rawInput ?? ''` 重组为 `prefix+rawInput` 交给中文前缀的 handleCommand（index.js:138-160）；handled=false 回 error 用法提示。README 四条别名与实现一致。plugin-smoke 用 handler({rawInput:''}) 实测 kind=success，非 postman 假冒。

**8 工具注册形状 —— 通过。** 每条 platform.registerTool({name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:...}})，execute 注入式转发（index.js:168-188）；裸 ctx.tools.register（registerTool 仅缺能力抛 no-tools PlatformError）。

**动态 state_board 段 order 160 读库 —— 形式通过。** `index.js:95-103`：text() 只读 `store.getBoard('main')`（已发布 rendered，store.js:1064），不触碰 staged；每次渲染读库会破坏宿主 KV 前缀缓存的前提需宿主层保证（06 未禁止；记录为已知成本，不判定缺陷）。

**M1 apply 无幂等守卫/无 shutdown（建议级→本报告升 M1）。** index.js:68 `apply` 无防重复调用位：宿主若二次 apply 会重复挂 preStep listener、重复 registerCommand/registerTool、重复 startScheduler（scheduler.start 内部 started flag 幂等，但 jobs/proactive 实例会再建一套）；且无 close/dispose，Store 不关闭、定时器 unref 后无泄漏但也无显式断链。修法：模块级 `let installed=false` 短路，或返回带 dispose 的句柄，由宿主在卸载时调用。

**召回 pre-step 注入 —— M2（与 review-v1 M1/M2 同根，此处仅判 t12 侧责任）。** registerMemoryPipeline（index.js:112-131）确实用 `{inject:[...]}`（adapter mergeDecision 合成 enter 批次，adapter.js:33-64）而非 durable inject，形式上满足 06 §16.3「只用 enter」；但无轮次级判定、不走 assemble 预算，见总量报告 M1/M2。

**scheduler 只 start 一次 —— 通过。** index.js:197-245 内 createScheduler→scheduler.start(platform.now()) 仅在 apply 尾执行一次；cloud smoke 断言 30s interval 仅 1 个 tick（plugin-smoke.test.js:95-98）。

## 2) src/platform/adapter.js 审计

- 零 `@deepseek-ai` import：全文件仅 node:crypto + 本地模块（grep 0 命中，adapter.js:1-20）。
- registerCommand/registerTool 缺能力抛 `PlatformError('no-commands'/'no-tools')`，存在时透传 ctx 服务（adapter.js 新增段）。
- FakeCtx 兼容：capabilities 为动态 getter（adapter.js:100-133），registerX 门卫在 index.js 侧先拦截。
- mergeDecision/onPreStep 语义核验：reject 透传；messages 替换 enter 批次、inject 追加进当步进入批次（enter 语义，非 durable）；messages+inject 同给抛 TypeError（adapter.js:33-64、172-186）——与 06 §16.3 的「禁 inject」约束在适配层闭环。
- 结论：通过。

## 3) test/config.test.js、test/platform.test.js 旧断言同步

- config.test.js：`'不做任何平台注册'` → `'只经平台服务注册，不调用旧式 registerCommand/registerTool 钩子'`（git show 1c4fc9c）。对比原断言（touched.length===1）——新断言**更强**：额外断言 `on('agent/pre-step')` 已注册、旧式 registerCommand/registerTool 0 次调用。未削弱保护，实为升级。
- platform.test.js：capabilities 期望对象补 `commands:false, tools:false` 两行——纯增量，未削弱。
- 结论：通过。

## 4) e2e 假绿排查

- plugin-smoke.test.js：**真接线**。FakeCtx 补 commands/tools 后走完整 apply()：EXPECTED_COMMANDS 4 个 ASCII 名、definitionId 正则、每工具含 output.schema+render、人格 4 段顺序、preStep 1 listener、interval 1 个 30s tick；第二次 smoke 用 handler({rawInput:''}) 验证真实可达。无假绿。
- turn.test.js / acceptance.test.js：**组件级 self-wired**，直接调 consolidate/publishBoard/compactRegion（turn.test.js:95、114），不经 apply() 驱动——作为 e2e 证明「库闭环」正确，但读者容易误读成「插件运行时已闭环」。它掩盖不了 review-v1 H1（生产路径无调用）。这不是测试 bug，是表述风险；建议在测试头注释里明确「self-wired 组件级，不证明 apply 接线」。
- acceptance.test.js：4 场景顺序复跑 V2/V10/V16/V15+提醒线，同样 self-wired；输出 PASS 行后 exit code 与场景数强相关（须逐项断言才打印），未见假绿。
- scenarios.js 抽取后 assemble-budget/write-fail 改 import，断言语义未变（diff -37/-48 为删除重复定义）。
- e2e/index.js：目录模式 argv 检测防 `node --test` 目录发现重复执行（index.js:12-23），机制已复核：`node --test test/e2e` 与全量发现各自计一次，共 257/15 无重复计数（m00165 基线与 m00248 复跑一致）。
- 日志泄密：`config ok` 只落 warnings（字段名），deep-sleep debug 只落 metrics 计数；无 secret/正文旧行（grep process.env 0 命中）。
- 结论：无假绿；存在的风险只是 turn/acceptance 为组件级语义（记录为 M2 注记）。

## Findings 汇总

- **M1** src/index.js:68 apply 无幂等守卫、无 shutdown：二次 apply 会重复注册/监听。修法：installed 守卫或 dispose 句柄。验证：对同一 FakeCtx apply 两次，断言 preStep listener 数、interval tick 数、命令注册数均为 1 套。
- **M2** turn.test.js / acceptance.test.js 组件级 self-wired 的表述风险（同 review-v1 H1）：加头注释即可；真正的修复随总量报告 H1 接线卡。

（L 级不列入本专项；总量报告 L1–L6 维持。）

## 测试证据

`cd dsh-companion && node --test` → 257 tests / 15 suites / 257 pass / 0 fail / 0 skipped，duration_ms 1026（real ≈1.13s，Node v24.9.0）。`git status --short` 复跑前工作区干净（bot commit 1c4fc9c，除本报告新增 docs 外无其它改动）。
