# review-v3 — dsh-companion P1 批（v0.2.0-rc）独立复审

- 复审对象：`b71a286`（`test(p1): e2e integration`），链条 `7105c57`(v0.1.1 release) → `45c7cd7`(P1-a 治理/记忆编辑) → `3032183`(P1-b 承诺跟进+闲聊) → `34bb1ca`(P1-c 失败自愈) → `b71a286`(P1-d e2e 联调)。diff：20 files，+4956/−78。
- 方法：只读审查（未改 src），逐条对照 P1-a..d 验收卡；全仓测试 locally 实跑（默认 TZ 与 TZ=UTC 各一遍）。
- **结论：pass（H=0，M=0，L=3）。** 四张卡全部达到验收线；五项重点审查（apply 不物删、闸门不可绕过、自愈不吞错/不无限重试、编辑不破坏 FTS/水位/状态板、无写 $DSH_HOME/无新增依赖）逐条给出证据。

## 1. 回归实测（判据基础）

实测（后台 job `bash-f48585498fef463c`，exit 0，已在结果中留存）：

- `node --test`：**465 tests / 16 suites / 0 fail**（3332ms）。
- `TZ=UTC node --test`：**465 tests / 16 suites / 0 fail**（3479ms）。

对照验收线：P1-a ≥400 ✓、P1-b ≥420 ✓、P1-c ≥440 ✓、P1-d ≥460 ✓（当前 465）。另外：`package.json` 无 dependencies/devDependencies/peer/optional（P1/p1 新增 import 全部零依赖，仅走现有相对路径模块，未引入 `@deepseek-ai/*`——该字样仅以注释形式出现在 src/index.js:6 与 scripts/calibrate/run.mjs:127、scripts/probe/run-headless.mjs:143,156 用于定位宿主 CLI 的路径提示）。

## 2. 重点①：治理 apply 只 supersede/标记，不物删

`src/memory/govern.js`（452 行，全读）：

- `scan`（govern.js:145-224）纯读：Jaccard≥0.92 判重，保留规则 salience→recall→strength→observed 日期→id 总序；pinned 不会被列为 drop；sensitive 只统计不进建议；stale（R<0.05）只报告。
- `apply`（govern.js:301-378）默认 `dryRun:true`；只有显式 `dryRun:false` 才在 `store.transaction` 内执行且**没有任何 DELETE FROM facts**——降级动作是 `store.updateFact(drop.id,{status:'superseded',superseded_by:keep.id})`（govern.js:333），sensitive 命中只标 `sensitive=1` 并同步删除 `fts_facts` 投影行（govern.js:341-345）；写 `action='govern'` 审计事件记录 counts 与 supersededIds 列表。
- FTS 同步由 `deleteFactFts`（govern.js:239-243）成对删投影行；`sensitive` 列经 `ensureSensitiveColumn`（govern.js:231-236）幂等 ALTER TABLE 按需追加。
- 审计事件 `action='govern'`（及 EDIT）不在 events CHECK 白名单内，用 `PRAGMA ignore_check_constraints=ON` 局部绕过并在 **finally 中恢复**（govern.js:256-291）；`test/govern.test.js:284-305` 验证恢复后 CHECK 仍生效（回归保障见 §6 L1）。
- `exportMirror`（govern.js:390-452）过滤 secret 字样/墓碑/sensitive/敏感词，`maxLines≤200`，只在显式调用时写 `<dir>/MEMORY.md`；不读不写 `$DSH_HOME` 该路径仅出现在注释中（govern.js:383）。
- 测试：`test/govern.test.js`（12 例）——scan 只读不建列（:164）、apply dry-run 不写库（:178）、真执行降级+FTS 剔除+govern 事件 detail 精确（:191）、**重复 apply 幂等不物删**（:241 行数不变）、镜像脱敏含墓碑/身份证（:253）、敏感编辑新条不进 FTS/mirror（:136）；e2e `test/e2e/p1.test.js:248-332` dry-run/真执行双路径。

## 3. 重点②：闲聊/承诺闸门不可绕过

**闲聊**（src/persona/chat.js `chatEligibility` :54-86，闸门按序：disabled→quiet→当日互动→周末→3 天冷却→每日 1 条→ 7 天窗口内 ≤3 条；`normalizeChatText` :133-158 只接受 5..10 条陈述句、剔除问句与违禁词）：

- 接线（src/index.js）：meta 键 `p1b.chat.enabled/last_at/sent/last_try_day` 与 `p1b.interaction.day`（index.js:111-117）；idle-probe job 顺序 `maybeRetryConsolidation → runRssCheck → proactiveBlocked? → runLightChat → proactive.flush → recordChatDelivery`（index.js:1857-1866）。
- `runLightChat`（index.js:2141-2242）：同日 `last_try_day` 只调一次模型（含失败）；`chatEligibility` 不过直接 return；成功投递才 enqueue `{kind:'chat',dedupeKey:'chat:<dayKey>'}` 并写 lastTryDay。
- `recordChatDelivery`（index.js:2250-2269）只统计 proactive 实际投出的 chat 才更新 last_at/sent，7 天窗口常量 `CHAT_HISTORY_SECONDS=7*86_400`（index.js:123）。
- `/别闲聊`/`/恢复闲聊`：写 meta 跨重启持久化（测试 p1b.test.js:293-320 用第二个 ctx 复开同一 db 验证关闭态被读到；e2e p1.test.js:710-738 双 ctx 持久化+恢复）。命令注册名是 ASCII（`chat-off/chat-on` 等，p1b.test.js 接线断言 names=['chat-off','chat-on','cost','memory','status','threads']），无硬编码中文命令。
- 测试覆盖：无互动不发（465-490/573-584）、安静不发（607-627）、周末不发（629-643/477-490）、3 天冷却（645-666）、每日 1 条（668-686/567-586）、每周 3 条（688-708/492-517）、不合规输出不发送且当日不再调模型（519-545，calls=1）、无模型只 warn（547-565/605-620 doesNotReject 不冒泡调度器）、真实时间戳写 /状态（441-463）。

**承诺**（src/scheduler/commitments.js）：`isCommitmentDue` 只认 kind=commitment、status pending/snoozed、due_at≤now、未删；`followedToday` 兼容 ISO 日键与旧 Unix 秒；排序逾期降序；`COMMITMENT_MAX_FOLLOWUPS=20` 上限。

- `runCommitmentFollowups`（index.js:2074-2133）：**安静时段直接 return 0**，行保持 pending，注释明确「等安静结束后的 reminders tick 补发」（index.js:2089-2096）；入队后立刻 `UPDATE last_fire_key=dayKey`（2099-2112）保证**每天至多 1 次**；写 `USED/commitment_followup` 审计。
- reminders job 的执行顺序：proactiveBlocked 先挡 → commitment 跟进 → fireDueReminders（index.js:1867-1874）。
- 敏感标题退化为「那件事」，不进消息正文与审计 detail（测试 p1b.test.js:412-439、e2e p1.test.js:540-569 双覆盖）。
- e2e：到期跟进 1 次+同日不重复+done 不再跟进（438-476/510-538）；安静保持 pending、早上补发一次并写 last_fire_key（478-508/381-410）。

## 4. 重点③：自愈不吞错、不无限重试

- **巩固重试链**（index.js 1202-1259 + 1357-1387）：consolidate 抛错 → `recordFailedConsolidation`（1319-1354，写/复用 failed 行，**绝不回退已 written 行**）→ `appendEvent('consolidation_failed')` → 非凭据错误才设 `state.consolidationRetry`，delay=`retryDelayMs(attempts)`（1/2/4 tick）；`maybeRetryConsolidation`（1362-1387）到点且无在飞/无 pending 才放回 `pendingConsolidation`；到点前水位已越过 retryEnd 则**丢弃**（superseded 保护，1368-1378）。重试 3 次封顶后写 `consolidation_failed_final` 并 warn（attempts=4、credential=false）。
- `src/runtime/retry.js`（108 行）：常量 3 次、退避 1/2/4 tick；`errorCode`穿透 `Error.cause`；`MISSING_CREDENTIAL` 不重试。
- 测试：`test/e2e/consolidation-retry.test.js`（2 例）——失败写 failed 行 + 60s 后 idle 重试**复用同一 consolidations 行**（length=1、status failed→written、error 清 null、calls=2、水位到 7，:79-130）；MISSING_CREDENTIAL 不重试（calls=1、0 retry 事件、failed 行保留 error、consolidation_failed_final+warn「failed permanently」，:132-179）。全景 `p1.test.js:742-788`（4 次 consolidation_failed + 3 次 retry + final attempts=4 + 水位 0 + 板不写）、:790-821（凭据缺失首次即永久失败）、:823-860（重试成功推进水位并停止重试，成功后不再调模型）。
- **调度器**：job 失败写 `job_error`（attempts/last_error）+ `job_retry`（nextRetryAt=次日本地 17:03）；新建调度器从历史 job_error 恢复失败态；异步 rejection 同样记录；interval 连续失败 attempts 累计（test/scheduler-retry.test.js:48/77/102/122/140）。
- **Store BUSY**：`transaction` 入口对 SQLITE_BUSY 重试 ≤3 次 + `sleepSync` 抖动（注释 5–25ms 线性、≤50ms），非 BUSY 原样抛（store.js:617-657）；测试 store-busy.test.js（3 次 busy 后提交 begins=3；4 次后抛原 SQLITE_BUSY；非 BUSY 原样抛）。
- `/状态` 失败可见：`formatFailureStatus`（commands.js:431-457）从 listEvents(limit:200) 扫最近失败/最近重试/最近 job 失败；status-failure.test.js 断言三行文案与无事件时「无」。
- **backup 失败可观测**：audit `USED/scheduler_jobs/backup_failed` 后**throw 让 scheduler 记 job_error**（index.js:2324-2382，注释 2357-2359 明确不能吞）；rotation 失败仅 warn（设计允许）。

## 5. 重点④：记忆编辑不破坏 FTS/水位/状态板

- `/记忆 改`（`editMemoryFact`，index.js:2758-2830）：事务内 新 insertFact(active, recall_count=0, pinned 不继承 strength) + 旧 updateFact(superseded, superseded_by) + `deleteFactFtsRow(旧)` + 敏感联动（新条标 sensitive 且删其 FTS 投影）+ `action='EDIT'` 事件 detail{from,to}；失败返回结构化错误不抛。scope_denied/not_found/not_active 校验齐全（p1a.test.js:144 双路径）。
- e2e：改完后下一轮召回注入新内容、旧内容不再注入（p1.test.js:407-434）；治理后召回只命中保留条（334-370）。
- 水位/状态板不受编辑路径触碰；V15 证明巩固失败全事务回滚零落库、水位 0、板 revision 不变（p1.test.js:975-1014）。

## 6. 重点⑤：无写 $DSH_HOME / 无新增依赖

- 依赖：`package.json` 四类依赖均为空 {}；新增模块（govern/chat/commitments/retry）import 全零依赖。`@deepseek-ai` 字样仅出现在注释与 scripts 定位字符串，非 import。
- `$DSH_HOME`：全仓 grep 只命中注释（src/memory/govern.js:383「不读不写」声明、scripts/probe/probe-plugin.js:6 临时 profile 注释）；无任何代码写该目录。
- 新文件均落仓库内路径：`docs/calibration.md`、`.data/*` 由校准脚本写临时 home / 工作区（不进版本库）。

## 7. Finding 表（新增发现）

| id | 严重级 | 摘要 | 证据 | requiredFix（可选改进，不阻塞） |
| --- | --- | --- | --- | --- |
| L1 | low | events CHECK 白名单不含 `govern`/`EDIT`，govern/edit 用 `PRAGMA ignore_check_constraints=ON` 局部绕过，finally 恢复；回归测试保证恢复后 CHECK 生效 | src/memory/govern.js:256-291；test/govern.test.js:284-305 | 后续把新动作名纳入 schema CHECK 白名单，消灭 bypass 语义 |
| L2 | low | Store BUSY 重试用 `sleepSync` 在事务入口同步阻塞事件循环（5–25ms 线性、≤50ms 抖动，重试 3 次） | src/memory/store.js:617-657；test/store-busy.test.js | 可改成异步 backoff；当前抖动上限可控，不阻塞 |
| L3 | low | 闲聊/巩固重试均挂在 idle-probe 60s tick 上；预算熔断或 RSS≥stop_dispatch 期间重试会被顺延（事件/状态仍在，只是延后） | src/index.js:1857-1866 | 可在文档标注顺延语义 |

- H：0；M：0（open objectives：无）。

## 8. P1 各卡逐条验收对照

| 卡 | 要求 | 验收证据 | 结果 |
| --- | --- | --- | --- |
| P1-a | src/memory/govern.js scan/apply/exportMirror、/记忆 列表\|改\|治理、memory_update 工具，test ≥400 | govern.js 452 行 §2；tools 注册数 10 含 memory_update（p1a.test.js:196-201）；/记忆 拦截层 handleMemoryCommand（index.js:2838-2859）、每页 20 关键词过滤（p1a.test.js:45-88）；全仓 465≥400 | ✓ |
| P1-b | 承诺提醒（kind=commitment、每天≤1、安静 backlog、done 不再跟进）+ 闲聊（当日互动/非安静/周末关/≥3 天/≤1 日/≤3 周、/别闲聊+/恢复闲聊持久化），test ≥420 | §3 全链路证据；e2e p1.test.js 438-738 双域覆盖；465≥420 | ✓ |
| P1-c | 自愈（巩固 retry 3 次退避 1/2/4、MISSING_CREDENTIAL 不重试、调度失败记次、BUSY 重试≤3 抖≤50ms、/状态 失败可见），不吞错且 test ≥440 | §4 全链路证据；465≥440 | ✓ |
| P1-d | test/e2e/p1.test.js 全景 + v0.1.1 回归（V2/V10/V16/V14/V15），test ≥460 | e2e p1.test.js 1014 行 22 例：治理/编辑 5（248-434）、承诺 4（438-569）、闲聊 8（573-738）、自愈 3（742-860）、回归 5（864-1014）；465≥460 | ✓ |
| P1-e（本卡） | 独立复审，verdict 只读、不改 src、findings 带 文件:行号 | 本文件；全程未改 src，只新增 docs/review-v3.md | ✓ |

## 9. 残余风险（不阻塞）

1. CI 工作流无显式 `TZ=UTC` job（沿用 review-v2 的建议项）：Windows 本地实跑已双 TZ 验证，但 CI 上若 runner 默认时区变动，时区相关断言（如 `America/New_York` 用例）依赖 tzdata 数据一致性。建议后续在 workflow 中显式 `env: TZ: UTC`。
2. L1 的 CHECK 白名单 bypass 属于实现细节债，国际上无行为风险，但长期看应并入 schema。
3. 闲聊 7 天窗口的 `p1b.chat.sent` 每次整串 rewrite JSON 数组，未来 sent 频次上限提高时需留意数组增长（当前每日 1 条、无风险）。

## 10. 命令复现

```bash
cd dsh-companion
node --test                 # 465/465, 16 suites, 0 fail
TZ=UTC node --test          # 465/465, 16 suites, 0 fail
node --check src/index.js && node --check src/memory/govern.js
git -C . status --porcelain # clean（review-v3.md 为产出，不计入 src 修改）
```

复审人：reviewer（t19 / P1-e），2026-11-04。
