# v0.4.12 发布门 round A / B 报告

- 范围：`persona.cardPath` 热修（t1 `6625158` + proactive 内置卡告警 `90e3383` + t2 单测 `0c3464e` + t3 文档 `cedb439`）。
- 本轮改动：新增 `test/e2e/persona-card.test.js`（5 个集成用例）与 `docs/deploy-v0412.md`；**未改 `src/`、未改已定稿文档结论、未 push**。
- 结论：**A1–A7 全 PASS；B1–B4 全 PASS**。round C 无凭据按 v0.4.11 口径 SKIP，不作通过依据。

## round A（静态与契约）

| # | 检查 | 命令 / 证据 | 结果 |
| --- | --- | --- | --- |
| A1 | 三时区全量测试 ≥948 | `node --test`（默认 / `TZ=UTC` / `TZ=America/New_York`） | **PASS**：三次均 `tests 953 / pass 953 / fail 0 / skipped 0 / todo 0` |
| A2 | `DEFAULT_CARD` 只在 `src/persona/card.js` | `git grep -n DEFAULT_CARD -- src` | **PASS**：8 处，全部在 `src/persona/card.js`（29/69/79/111/173/185/201/361），无其它源文件使用 |
| A3 | 安装自检 16 键不变 | `node --test test/calibration.test.js` | **PASS**：`tests 10 / pass 10 / fail 0`；`config.example.yml` 未新增生效键（persona 段为注释示例） |
| A4 | schema 仍 v13、无新迁移 | `git grep -n SCHEMA_VERSION -- src/memory/store.js` | **PASS**：`src/memory/store.js:77: const SCHEMA_VERSION = '13';`；本轮 diff 只有 test/docs |
| A5 | 零运行时依赖 | `node -e "…package.json…"` | **PASS**：`dependencies=null`、`devDependencies=null` |
| A6 | README/usage 内链无死链 | 按所在目录解析 75 条 Markdown 链接（README 57 / usage 18，其中 9 条同页锚点） | **PASS**：66 条文件链接全部存在，死链 0 |
| A7 | 工作树干净、CHANGELOG 未预填 v0.4.12 | `git status --porcelain`；`CHANGELOG.md` 头部 | **PASS**：提交后空；CHANGELOG 顶部仍 `[0.4.11] … 918 个用例`，无 v0.4.12 测试数预填 |

## round B（生产路径）

| # | 检查 | 证据 | 结果 |
| --- | --- | --- | --- |
| B1 | `apply` + pre-step 一轮，人格段/召回/状态板/`/状态` 同时可见 | 集成用例「B1 生产装配」：预置状态板 `- 周报周五交。` + fact「周报/周五」→ `decision.messages.length === 2`，注入消息 `source.kind='companion-recall'` 且以 `[相关记忆]` 开头、含「周报」；状态板段返回 `[状态板]\n- 周报周五交。`；core 为「你是珞然」；`/状态` 含「人格卡：珞然 v1（内置默认）」 | **PASS** |
| B2 | 文件卡链路端到端（配置→加载→段文本→`/状态` 绝对路径） | 集成用例「文件卡相对路径」：`DSH_HOME=<tmp>` + `cardPath: persona.json`（相对）→ 人格段「你是阿岩/老板/干练、克制、先给行动项」；`/状态` 为 `人格卡：阿岩 v2（<tmp>/persona.json）`；闲聊 llm 入参 `card.name=阿岩`、`bannedPhrases=['收到啦','好哒']`；承诺跟进文案为「老板，昨天说好的…」 | **PASS** |
| B3 | 失败兜底端到端 | 集成用例「失败兜底」：坏 JSON + `proactiveDailyCap:5`/`quietEnd:'07:30'` → `apply` 不抛，恰 1 条加载 warn + 1 条内置卡 proactive 冲突 warn；`/状态` 为 `人格卡：珞然 v1（加载失败，已用内置：…invalid JSON…）`；pre-step 返回 `messages` 数组、闲聊照常投递一次 | **PASS** |
| B4 | 落盘 `docs/deploy-v0412.md`（≤80 行，用户侧操作） | 备份 v0.4.5 库（含 `-wal`/`-shm`）→ 卡放 `/opt/dsh-companion-home/persona.json` → 配 `persona.cardPath: persona.json` → 与宿主模型变更合并成一次重启 → 重启后核对 `/status` 人格卡行 + 新会话问「你叫什么」→ `eval-boundary.md` 追加「配置变更」条（时间/0.4.12/卡路径与 version/模型变更，评测不重新起算）→ D-5 标断点 → 统计按该时刻前后分段；附回滚 | **PASS**（文件 76 行） |

## 单次加载 / 重启语义（集成用例补充）

- apply 后立刻把盘上 `persona.json` 换成另一张卡：人格段、`/状态`、闲聊入参、承诺跟进仍全部来自启动时那份 → 证明只加载一次，不是各使用点各读一次。
- 运行期把文件改成坏 JSON：不重读、不追加 warn，段文本与 `/状态` 不变；重新 apply 才读到坏文件（恰 1 条 warn + 内置卡）；修好文件后再次 apply 恢复新卡（`人格卡：重启后 v3`）。
- v0.4.11 等价：未配置卡时人格三段 SHA-256 与 `08493eb` 基线一致（`persona:safety` / `persona:core` / `persona:protocol`）；`/状态` 只多「人格卡」一行，其余 14 行逐行等于 v0.4.11 输出。

## 发布门（round A/B/C）

命令：`node scripts/probe/run-headless.mjs --plugin --timeout 180000`（DSH CLI `D:\dsh\resources\runtime\cli\bin\dsh.cmd`）。

- 退出码 **0**，末行 `plugin-gate: PASS (round A + round B + round C)`；日志 `.data/plugin-gate.log`。
- round A：`round A: exit=1 schedulerStarted=true didNotActivate=false`；stderr 含 `[dsh-companion] scheduler started {"jobs":6,…}`。
- round B：`round B: exit=1 schedulerStarted=true didNotActivate=false recallCrash=false seededFact=fact_e7d6… firstReneedAt=1793948651`（非空）。
- round C：`credentials=missing … consolidations=0 tokenEvents=1 maxTokensIn=0 … verdict=skip`；按 v0.4.11 口径 **SKIP，不计 PASS**。
- 无凭据时各轮 `exit=1` 来自 `MISSING_CREDENTIAL`，插件已在错误前完成激活；门判定以 scheduler/recall 断言与最终 PASS 行为准。

## 遗留问题

| 级别 | 事项 | 说明 |
| --- | --- | --- |
| low | round C 未执行 | 本机无模型凭据，`credentials=missing → verdict=skip`；需在有凭据环境复跑，确认 `consolidations ≥ 1` 且 tokenMeter 非零。 |
| low | 仓库无 `eval-boundary.md` | 全仓搜索未找到该文件（仅 `docs/known-debt.md`、`docs/review-v5.md` 提到 D-5）；部署清单已写明部署时追加「配置变更」条，正式记录在发布环境完成。 |
| low | 集成测试的重启语义用 `:memory:` | 不校验跨重启持久化（该行为由现有 store 测试覆盖），只校验加载时机与 warn 次数。 |
