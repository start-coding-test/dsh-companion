# v0.4.11 独立复审（review-v17）

- 复审人：reviewer（独立审查者，未参与 t1–t5 实现）
- 复审日期：2026-11-05
- 复审对象：v0.4.10（`8f61f60`）之后的 HEAD `11cdb59`，含 5 个提交：
  `58ed1ad`（V10-H1 preset）/ `52dc3e0`（G0-9 timing）/ `ca8f3d3`（V10-L1 scrub）/ `a311d06`（V10-M1 docs）/ `11cdb59`（t5 集成回归）。
  四个依赖提交（t1/t2/t3/t4）均在 HEAD 祖先链内。
- 复审方式：逐文件读五个提交的实现与测试（行号级证据如下）；独立写三个探针
  （`.probe-t6/probe1-timing.mjs` 假时钟、`probe2-scrub.mjs` 自建 v12 明文库、
  `probe3-preset.mjs` 独立 fixture 直跑生产 `thread_run`，探针目录在仓库外，不进工作树）；
  亲跑三时区全量 `node --test`；交叉 grep 文档/常量/接线；121 个 Markdown 内链逐一
  按链接所在目录解析验证。确认 worktree clean（复审提交除外）、未 push（`main` ahead 6）。
- 结论：**verdict = pass**（H=0 / M=0 / L=3，均为已接受的风险观察，不阻塞发布）。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | — |
| M（必修） | 0 | — |
| L（建议/风险观察） | 3 | 见 §6；均不要求本版修复 |

发布前置条件（H=0 且 M=0）满足，复审通过。

## 2. V10-H1：thread preset 可配置、未知 preset 不抛异常 ✅

- **配置层**：`src/config.js:123-146` 新增 `THREAD_DEFAULTS={agentPreset:null}`
  （`enumerable:false`，不进 16 键安装面）；`normalizeThread` 对未知子键打 warning，
  非布尔字符串型 preset 抛 `ConfigError('thread.agentPreset')`，合法值 trim、空串归 null。
- **工具层独立探针验证（probe3，独立 fixture，非引用 t5 断言）**：
  - 未配置 → `createSession` 实参**无 `agentPreset` 键**（`src/runtime/tools.js:551-568`
    仅在 `threadPreset!==null` 时加 `request.agentPreset`；`:197-200` trim/空→null）；
  - 配置 `'workspace-write'` / `'  workspace-write  '` → 透传/trim 后透传；
  - 宿主报 `Unknown agent preset: X`（`isUnknownAgentPresetError`，`tools.js:772-782`）→
    返回 `{ok:false,action:'create',key,reason:'preset_unknown',message:<宿主原文>}`，
    **不抛异常**、`upsertThread`（`tools.js:575`）与 prompt（`:587`）都未执行；
  - 其它宿主错误（TypeError 'unreachable'）照常上抛，不被吞成 preset_unknown。
- **接线**：`src/index.js:822` tools 层接 `threadAgentPreset`；无任何硬编码 preset
  （`git grep "agentPreset: 'companion-thread'"` 0 命中，全仓 `companion-thread` 字面量
  仅剩 requestId 前缀与测试 cwd 路径）。
- **/状态 来源行**：`src/runtime/commands.js:560-583` 在 mainSession 行后 push
  「线程 preset：宿主默认 / `<name>（配置：thread.agentPreset）」。
- **文档安全要求**：`docs/usage.md` install 节含读宿主 preset 列表、最小权限、
  不得 danger-full-access 三点（usage.md 线程 preset 节）。

## 3. G0-9：压缩/巩固耗时阈值、warn 去重、/状态 展示 ✅

- **配置**：`src/config.js:135-155` `TIMING_DEFAULTS={compactWarnMs:20000,consolidateWarnMs:60000}`
  （非枚举可选段，16 键不变），`normalizeTiming` 正整数校验，非法抛 `ConfigError('timing.*')`。
- **独立探针验证（probe1，假时钟步进 73s，不依赖真实耗时）**：
  - 超阈值同类每进程只 warn 一次，出现不超阈值样本后重置（可再次 warn）；
  - 失败路径同样被采样（`ok:false`），且不因失败样本绕过去重；
  - 日志器抛错时采样仍然吞错、不破坏原流程（情绪上 abort 不存在：
    全部只观测，无 setTimeout/abort，`src/runtime/timing.js` 无计时器）；
  - `formatTimingValue` 边界：等于阈值不标「（超阈值）」，严格大于才标。
- **采样点在真实路径**：`src/index.js:2046` 巩固入口记起点，成功 `:2136` 与
  catch `:2190` 都 `recordTimingSample('consolidate',…)`；`maybeCompact` 成功 `:2455`
  （用压制层给的 durationMs）与 catch `:2492` 采样 `'compact'`。
- **/状态 两行**：`src/runtime/timing.js` `formatTimingLines` 产出
  「最近压缩耗时：…」「最近巩固耗时：…」（无样本 `—`，超阈值带「（超阈值）」）；
  `commands.js` 仅在接线层传入 timing 时输出（旧调用形式不破坏）。
- 无硬超时/无中止路径：压缩与巩固的既有超时逻辑未改动（diff 核对）。

## 4. V10-L1：存量 episode/FTS 一次性脱敏 scrub ✅

- **独立探针验证（probe2，自建 v12 明文库 + raw SQL 造脏行）**：
  - v12 明文库打开 → 升 v13，`episodes.title/summary/evidence/mood_evidence/topics_json/entities_json`
    值级脱敏保留叙事（如「在路由器配置页面」保留、「门禁口令：8848」→ 凭据值省略）；
  - JSON 数组字段逐项脱敏后仍是合法 JSON，未命中的数组保持原文本不重排
    （`src/memory/store.js:566-591` `scrubEpisodeJsonText`）；
  - 坏 JSON 行退化为整段替换不崩溃；
  - FTS 一致：变更行 `#refreshEpisodesFts`（`store.js:1539-1549`）重建投影，
    rowid join 后 fts_episodes 无明文；未变更行不重写（探针中 raw 插入第三节证实
    干净行 FTS 原样未动）；
  - 幂等：`schema_meta` 标记 `episode_scrub_v13`，二次打开 episodes/FTS/
    memory_events/meta 四张快照 `deepEqual` 全等，scrub 事件仍 1 条
    （`detail={scanned,changed}` 不含正文）；
  - 空库不写标记、无 scrub 事件（无审计噪音）；v9 空库直接打开也能走到 v13。
- **实现结构**：`store.js:938-984` migrate 在 `BEGIN IMMEDIATE` 内完成
  `#migrateFrom`（`:1111` 接受 from=12..6）→ 补列 → `#scrubLegacyEpisodes`
  （`:1163-1263`，批 200 行游标 `EPISODE_SCRUB_BATCH`），失败整体 ROLLBACK
  连同版本号回滚；非升级补齐路径自开事务（`atomic: !upgrading`）。
- **17 处既有 schema 断言已全部随升版改 13**（export-aad/export/reneed/
  store-vector/v0411-regression 等测试逐一 grep，残留 `'12'` 仅是测试**故意把库
  退回 v12 造旧库**的 setup 行，非断言残留）；`export.js` `CURRENT_SCHEMA_VERSION=13`。
- 审计入口 `appendEventWithAction`（`src/memory/govern.js:405-440`）先
  `PRAGMA ignore_check_constraints` 绕 CHECK——这是 known-debt **D-2 已登记**的既有债务
  （memory_events 白名单缺 govern/EDIT/scrub 三个动作），scrub 只复用同一入口，
  不新增债务面（t4 已在 D-2 补记这三个动作名）。

## 5. V10-M1 与回归口径 ✅

- **round C 口径文档一致**：`README.md:24`、`docs/usage.md`（headless 节）、
  `docs/known-debt.md` D-10 三处口径一致——round C = 常驻实例 8 次巩固成功；
  headless/one-shot turn 结束进程退出、`setImmediate` 排后的巩固不执行属**正常**
  （云端 tokenMeter 有值、consolidations=0）；headless 门只作 A/B 冒烟，
  round C SKIP 不计 PASS；三种门改造（DSH_COMPANION_GATE_SYNC / 常驻版门脚本 /
  dispose 限时等待）明确登记为**推迟项（D-10）**。
- `CHANGELOG.md` [0.4.11] 段收 4 卡提交号，**未写最终用例数**（留给 t7 发布提交）；
  0.4.9 段补口径调整引注；`config.example.yml` 补 `thread.agentPreset` 注释段与 timing 段。
- `docs/review-v11.md` 两处 requestId 描述行去掉旧 `companion-thread` 字面量
  （事实不变，仅为满足 docs grep=0）。
- **回归**：三时区全量 `node --test` 均 **918 pass / 0 fail**（默认时区、TZ=UTC、
  TZ=America/New_York 各 918/918；基线 v0.4.10 913 + t5 新增 5）。
  `package.json` version 仍 0.4.10——版本号与最终用例数按计划归 t7。

## 6. Findings（均为 L，无阻塞）

- **L-1 迁移持锁时长**（观察，可接受）：v12→v13 升级的脱敏全部在一个
  `BEGIN IMMEDIATE` 事务内完成（分批 200 行只分摊内存/CPU，不释放写锁）。存量库很大时
  打开期间会独占写锁更久。属一次性成本、失败可整体回滚、无网络/计时调用，
  接受为设计权衡；如未来出现超大存量库再考虑分事务+断点续跑。
- **L-2 preset 误配失败模式**（观察，符合预期）：`thread.agentPreset` 配错合法格式但
  宿主不认识时，每次新建线程都得到 `preset_unknown`（不抛、不写库），用户需看
  /状态行或错误 message 排查。已有文档（usage.md 错误清单）给出对应指引，行为
  与「宿主判定合法性」的设计一致，无需改代码。
- **L-3 timing 观测只进 warn meta**（观察，按卡要求）：`lastCompactMs/lastConsolidateMs`
  只出现在 warn 的 meta 与 /状态两行，成功失败都不落库。若未来需要按天统计
  巩固耗时 P95，需要另行持久化。当前卡范围（阈值+告警+展示）不受影响。

另：`memory_events` CHECK 白名单绕行是既有 D-2 债务（非本次新增），已由 t4 在
known-debt 记账，不计入本复审新 finding。

## 7. 工作区与验证清单

- HEAD `11cdb59`，复审提交 docs/review-v17.md 后 main ahead 6，未 push。
- 复审探针：`node probe1-timing.mjs` / `node probe2-scrub.mjs` / `node probe3-preset.mjs` 全部断言通过（目录 `.probe-t6`，仓库外）。
- `git grep "agentPreset: 'companion-thread'"`、docs/README/CHANGELOG/config.example 的 `companion-thread` 字面量均 0 命中。
- Markdown 内链 121 条按所在目录解析：0 死链。
- 三时区 `node --test`：918/918 ×3。
