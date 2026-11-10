# dsh-companion 使用手册

本文面向使用者，说明插件提供的命令、工具与配置。设计细节见 [平台 API 摘录](platform-api.md) 与仓库外的设计文档。

## 命令

命令由宿主转发给插件；输入以 `/` 开头且命中下列命令时，插件直接回复，不进入模型。未知命令或未识别的 `/记忆` 子命令会原样交回模型。

### `/记忆`

查看记忆概况，不搜索、不写入：

```text
/记忆
记忆：12 条事实（identity 2 / knowledge 3 / preference 4 / project 3），置顶 1 条。
```

没有事实时返回 `记忆：暂无事实（置顶 0 条）。`。搜索请用工具 `memory_search`，写入请用 `memory_write`。

### `/记忆 列表 [关键词] [--page N]`

按 kind 分组分页列出活跃事实（每页 20 条），可用关键词过滤 statement / subject / predicate / object：

```text
/记忆 列表 生日
记忆（匹配「生日」共 2 条） · 第 1/1 页

[identity]
- 12 · user · 2026-06-01
  生日是 5 月 20 日
```

没有匹配时返回 `没有匹配的记忆。`；还有剩余条目时提示「用关键词或 --page 继续查看」。

### `/记忆 改 <id> <新内容>`

用新 id 生效新内容，旧条标记为 `superseded` 并通过 `superseded_by` 指向新条（保留审计，不物理删除）：

```text
/记忆 改 12 生日是 5 月 21 日
已更新记忆：12 → 97
```

失败时返回 `修改失败：<原因>`（如 `not_found`、`not_active`）。同一语义的模型工具是 `memory_update`。

### `/记忆 治理 [--dry-run]`

扫描重复（Jaccard ≥ 0.92）、冲突（同 subject + predicate）、过期（R < 0.05）与敏感条目。`--dry-run` 只出报告、不写库；去掉参数才真正应用：

```text
/记忆 治理 --dry-run
记忆治理（dry-run，不写库）
重复 1 组 · 冲突 0 组 · 过期 2 条 · 敏感 0 条
重复（保留 ← 降级）：
- 31 ← 64（0.95）
```

应用时**只降级、不物理删除**：重复项标 `superseded`，敏感命中标 `sensitive=1` 并从 FTS 召回中移除；两类操作都写审计事件。

### `/记忆 忘掉 <id|关键词>`

把一条事实标记为遗忘（S1，软删除），7 天后物理删除。参数可以是事实 id，也可以是关键词；关键词最多命中 5 条。

```text
/记忆 忘掉 生日
已标记为遗忘：12（7 天后物理删除）
```

没有命中时返回 `没有找到可遗忘的事实：<关键词>`。缺参数时返回用法提示。想立即清除见 [常见问题](#常见问题)。

### `/记忆 置顶 <id>`

```text
/记忆 置顶 12
已置顶：12
```

未找到时返回 `未找到事实：12`。

### `/记忆 取消置顶 <id>`

```text
/记忆 取消置顶 12
已取消置顶：12
```

### `/记忆 导出 [md|json]`

把活跃事实、情景、提醒、线程、状态板与情绪（开启时：当前状态 + 每个作用域最近 50 条事件）导出到 `.data/export/memory-YYYY-MM-DD-HHmmss.<fmt>`（缺省 `json`，文件名为 UTC 秒级时间戳；同一秒内重复导出自动追加 `-2`、`-3`，不覆盖已有文件），并在回复里给出各表条数与路径：

```text
/记忆 导出 md
已导出记忆（md）：facts=96 · episodes=120 · reminders=4 · threads=3
文件：.data/export/memory-2026-11-04-091233.md
```

默认**不导出** `secret` / `sensitive`、墓碑（tombstone）、`superseded` 条目；状态板里引用了未导出事实原文的行会被剔除。格式非 `md` / `json` 时返回用法提示。恢复与加密见 [导出、恢复与加密](#导出恢复与加密)。

### `/成本`

汇总 `memory_events` 中记录的 token 用量：

```text
/成本
成本：今日 12345 tokens（入 8000 / 出 4345）｜本月 98765 tokens（入 60000 / 出 38765）｜今日配额 12345 / 3000000
```

达到每日 3M token 后追加「（已熔断）」，并在本地日界翻篇时自动复位。

### `/线程`

列出线程目录（最多 100 条）：

```text
/线程
线程目录（2）：
rent | active | 租房 | 2026-11-03
health | archived | 体检 | 2026-10-20
```

没有线程时返回 `线程目录：暂无。`；宿主没有 `sessionController` 时不返回空目录，而是与 `/状态` 一致返回 `线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）`。两者都是**调用时实时判断**：能力晚挂载后无需重装插件，下一次调用即恢复。

### `/状态`

查看各表计数、FTS 行数、主作用域水位与最近一次定时任务：

```text
/状态
状态：entities 8 / episodes 120 / facts 96 / reminders 4 / state_board 2 / state_board_rev 9 / threads 3 / consolidations 21 / memory_events 310 / fts facts 96/episodes 120 / tokens 本轮 入 8000 出 1200（超预算 0 次）｜今日 0/3000000｜RSS ok 128MB｜向量：关
RSS 阈值：warn 2.95GiB / stop 3GiB / main_only 3.15GiB
最近压缩耗时：12.3s
最近巩固耗时：31.0s
主会话：main-3f2a（绑定 latest-user）
人格卡：珞然 v1（内置默认）
水位重锚：2 次
未巩固被压缩：1 个节点
水位 main：120
最近 job：s2-purge ok upto_seq=0（2026-11-03 03:30）
```

最后一段 `tokens 本轮 …` 是当前轮工作记忆的 token 快照（入 = 上下文总量，出 = 本轮新增）；没有 `tokenMeter` 能力时显示 `tokens 本轮 0`，不影响其它计数。`向量` 段在开启可选向量召回后变为「向量：开·dim 256·hash:256·已回填 N·最近命中 N·回填超时 N·占用 N」（local/remote 显示各自 id 与回填计数）。第二行「RSS 阈值」是当前生效的三档值，来自 `rssWarnGiB`/`rssStopGiB`/`rssMainOnlyGiB`（默认 2.95/3/3.15GiB，4G 机器建议 2.2/2.4/2.6，见[配置示例](#配置示例)）。「水位重锚」与「未巩固被压缩」只在实际发生外部压缩后出现，含义见[外部压缩与水位重锚](#外部压缩与水位重锚v040)。「主会话：<id>（绑定 <mode>）」是当前提醒投递目标与绑定策略（`latest-user` 会跟随最新真实用户会话，`first` 保持首个，见[主会话绑定](#主会话绑定v044)）；宿主没有 `sessionController` 时多一行「线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）」（每次执行 `/状态` 时实时读取能力）。v0.4.12 起还会多一行「人格卡：<name> v<version>（内置默认 | <绝对路径> | 加载失败，已用内置：<原因>）」，来源、切换与兜底行为见[人格卡](#人格卡v11-p1v0412)。

「最近压缩耗时」「最近巩固耗时」是 G0-9 的观测行：前者取最近一次实际压缩（`compactRegion` 调用及其后的重读 surface / 写库 / 发布看板），后者取最近一次实际巩固执行（从巩固任务入口到 `consolidate()` 返回，含选区与模型解析）；失败样本也记录，但成功/失败不进 `/状态`、只用于日志。没有样本时显示 `—`；超过 `timing.compactWarnMs`（默认 20000ms）/`timing.consolidateWarnMs`（默认 60000ms）时在值后标注「（超阈值）」，同时写一条 warn（同类在同一进程内只告警一次，出现一次不超阈值的样本后重置）。阈值只用于观测与告警，**没有硬超时、不会中止**压缩或巩固，详见[压缩/巩固耗时观测](#压缩巩固耗时观测g0-9v0411)。

`/状态` 末尾还会给出自愈观测（无事件时显示「无」）：

```text
最近失败：巩固失败：provider 超时（2026-11-04 09:12）
最近重试：重试 第 2 次（2026-11-04 09:13）
最近 job 失败：s2-purge job_error：database is locked（2026-11-04 03:30）
```

### 最近一次装配（V50-L3，v0.5.1）

启用情绪或人格卡后，`/状态` 会在自愈观测之后多一行「最近一次装配」，用来核对**这一轮实际装配进了什么**：

```text
最近一次装配：3 分钟前；部署人设 宿主默认；prefix 未改写；段 safety 202/3f9a1c07、core 246/8b2d4e51、protocol 189/77c0aa93
```

- 时间取最近一次静态段注册（插件的 `apply` 阶段），情绪启用时同时记录最近一次情绪句的生成时间，整行按较新者显示。
- 「部署人设」与「prefix 是否改写」取自 `persona.shadowDeployment` 的实际执行结果：`off` → 「宿主默认 / 未改写」，`rewrite` → 「已替换（人格卡身份） / 已改写」，`takeover` → 「已接管 / 已改写」。
- 「段 <名字> <字数>/<短哈希>」覆盖插件自建的静态段（正常情况下是 `safety` / `core` / `protocol`，配置了 `tone.voice` 或 `mes_example` 时还有 `voice`）；状态板等**动态段**（`text` 是函数、内容每轮变）按设计不记录，避免把实时内容误当成固定段。
- 字数按 Unicode 码点计，短哈希是段文本 SHA-256 的前 8 位十六进制——**只记哈希，不存正文**，卡里的内容不会因此进入日志或 `/状态` 输出。哈希可用于人工核对：把段文本喂给同一算法即可比对。
- 记录只存在进程内存里，重启后清空；没有任何记录时整行省略（例如直接调用 `handleCommand('/状态')` 的测试场景）。

### 判定器（v0.6）

情绪启用时，`/状态` 还会有一行「判定器」，说明这一轮的情绪事件是谁判的：

```text
判定器：模型（近 24h 模型 7，规则兜底 3，平均 412ms，p95 900ms，最近失败 timeout）
判定器：规则（近 24h 无判定）
```

- 规则模式（卡里 `emotion.appraiser` 缺省或写 `"rules"`）只显示「规则」；有样本时统计的是本进程内
  规则判定的次数。
- 模型模式把「模型判定成功」与「规则兜底」分开计数，另给平均耗时与 p95（只取成功样本）；
  「最近失败」是最近一次兜底的原因码（`invalid` / `timeout` / `error` / `budget` / `superseded` / `nollm`）。
- 统计窗口是近 24 小时、最多 500 个样本，存在进程内存里，重启后清零。
- 判定 token 计入每日预算；预算熔断时不再发判定请求，直接走规则兜底。

### `/别闲聊` 与 `/恢复闲聊`

关闭 / 恢复低频主动闲聊。开关写入 `schema_meta`，跨重启持久化：

```text
/别闲聊
已关闭主动闲聊。
```

关闭后不再产生闲聊消息，提醒与其它主动消息不受影响。闲聊的完整闸门（安静时段、当日互动、周末、冷却与频次上限）见 [README](../README.md#承诺跟进与轻闲聊)。

## 工具

插件向模型注册 10 个工具。必填字段缺失、类型错误或取值越界时，工具抛出 `TypeError`，消息里带工具名与字段名；调用方应修正参数后重试。

### `memory_search`

按关键词检索长期记忆，结果按 2,050 token 预算裁切，并带四档保真度。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | 是 | 检索关键词 |
| `scope` | string | 否 | 作用域，默认 `main` |
| `limit` | integer | 否 | 最多返回条数，1–50，默认 20 |

返回：

```json
{
  "items": [
    {
      "kind": "fact",
      "id": "12",
      "text": "生日是 5 月 20 日",
      "fidelity": "full",
      "score": 0.82,
      "R": 0.91
    }
  ],
  "tokens": 18,
  "usedIds": ["12"],
  "truncated": false
}
```

`fidelity` 为 `full` / `gist` / `index` / `dormant`；`truncated=true` 表示命中内容超出预算被截断。

### `memory_write`

写入一条用户明确给出的事实，返回落库后的 id 与摘要。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `statement` | string | 是 | 自然语言事实，如「我妈生日是五月」 |
| `subject` | string | 否 | 主体，默认「我」 |
| `predicate` | string | 否 | 谓语/关系，默认「记住」 |
| `object` | string | 否 | 客体 |
| `kind` | enum | 否 | `identity` / `relation` / `preference` / `project` / `knowledge` / `other`，默认 `other` |
| `salience` | enum | 否 | `trivial` / `normal` / `notable` / `explicit` / `pinned`，默认 `normal` |
| `privacy` | enum | 否 | `normal` / `sensitive` / `secret`，默认 `normal` |
| `scope` | string | 否 | 作用域，默认 `main` |
| `source_excerpt` | string | 否 | 原话摘录 |

返回：

```json
{ "ok": true, "id": "97", "statement": "我妈生日是五月", "scope": "main", "salience": "normal" }
```

### `memory_update`

修改一条已有记忆：新内容以新 id 生效，旧条标记 `superseded` 并保留审计。语义与 `/记忆 改` 相同。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 要修改的事实 id |
| `statement` | string | 是 | 修改后的完整陈述 |

返回 `{ "ok": true, "id": "97", "supersededId": "12" }`；失败返回 `{ "ok": false, "reason": "not_found" | "not_active" | "invalid_id" | "scope_denied" }`。`subagent` 会话调用返回 `scope_denied`。

### `memory_forget`

按 id 标记遗忘（S1，软删除），7 天后物理删除。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 事实 id |

返回：

```json
{ "ok": true, "id": "97", "alreadyDeleted": false, "tombstoned": true }
```

`ok` 表示这次调用是否成功把行转为 tombstone；`tombstoned=true` 表示本次确实完成了标记。不存在时返回 `{ "ok": false, "id": "97", "reason": "not-found" }`；已删除时返回 `{ "ok": true, "id": "97", "alreadyDeleted": true, "deletedAt": 1793600000 }`；行存在但不是 `active`（如已降级为 `dormant`）时返回 `{ "ok": false, "id": "97", "alreadyDeleted": false, "tombstoned": false, "reason": "not-active" }`。

### `reminder_add`

新增一条提醒。提醒不参与遗忘曲线，到点由调度器触发。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 提醒标题 |
| `kind` | enum | 否 | `todo` / `schedule` / `repeat` / `commitment`，默认 `todo` |
| `due_at` | integer | 否 | 到期时间（Unix 秒） |
| `detail` | string | 否 | 补充说明 |
| `counterparty` | string | 否 | 相关的人或方 |
| `scope` | string | 否 | 作用域，默认 `main` |

返回 `{ "ok": true, "reminder": { ... } }`，`reminder` 是完整提醒行，含 `id`、`kind`、`title`、`status`、`due_at` 等字段。

### `reminder_done`

把一条提醒标记为完成。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 提醒 id |

返回：

```json
{ "ok": true, "id": "5", "changed": true, "reminder": { "status": "done" } }
```

不存在返回 `reason: "not-found"`；已完成返回 `alreadyDone: true`；已取消返回 `ok:false`、`reason:"cancelled"`。

### `thread_list`

列出线程目录。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | enum | 否 | `active` / `archived` / `retired` |
| `query` | string | 否 | 按 key、名称、描述过滤 |
| `limit` | integer | 否 | 1–50，默认 50 |

返回 `{ "items": [...], "count": 2 }`，每项含 `key`、`name`、`status`、`description`、`session_id`、`last_active_at` 等。

### `thread_run`

复用或新建线程会话，并把目标投递进去。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 线程 key；新建时传 `new` |
| `name` | string | 否 | 线程名，`key=new` 时必填 |
| `goal` | string | 否 | 投递给线程的目标/任务 |
| `cwd` | string | 否 | 新会话工作目录；由接线层从宿主注入，插件不读 `process.cwd()`。宿主未提供时新建返回 `reason: "cwd-unavailable"` |

复用返回：

```json
{ "ok": true, "action": "reuse", "key": "rent", "sessionId": "session-...", "reactivated": false, "prompted": true }
```

新建返回：

```json
{ "ok": true, "action": "create", "key": "rent-2", "sessionId": "session-...", "prompted": true, "thread": { ... } }
```

拒绝返回 `{ "ok": false, "action": "reject", "key": "new", "reason": "too-many-threads" }`；常见原因还有 `name-required`。

能力缺失时返回 `ok:false`，不会写入半成品：

- `cwd-unavailable`：宿主未提供工作目录（新建分支）。
- `session-unavailable`：宿主没有 `sessionController.createSession`。这是工具集脱离插件能力门单独构造时的返回；在插件注册路径上，宿主缺 `sessionController` 时 `execute` 会先返回 `capability_missing`（见[宿主能力缺失](#宿主能力缺失)）。
- `unarchive-unavailable`：复用已归档线程，但宿主没有 `workspaceRegistry.unarchiveSession`。
- `prompt-unavailable`：宿主没有 `sessionController.prompt`，无法投递目标。
- `preset_unknown`：配置了 `thread.agentPreset`，但宿主不认识该 preset（v0.4.11 起）。
  返回 `{ "ok": false, "action": "create", "key": "...", "reason": "preset_unknown", "message": "宿主原始错误文本" }`，
  不抛异常、不写 `threads` 行；按提示改用宿主实际存在的 preset，或删除配置走宿主默认。

#### 执行槽：`thread_run` 与 `task_run` 共用

`thread_run`（带 `goal`）和 `task_run` 共用同一个执行槽（全局 1 个），但忙时行为
不同，这是有意的差异：

- `thread_run`：槽被占用时立即返回 `{ "ok": false, "reason": "busy" }`，不排队。
- `task_run`：槽被占用时排队（最多 2 个），队列满才返回 `busy`。

`thread_run` 会一直持槽到该线程会话空闲（宿主 `whenIdle`；900s 兜底强制释放），
期间 `task_run` 只能排队或返回 `busy`，不会并发进入执行态。

主会话收到 `thread_run` 的 `busy` 时，应告诉用户「正在执行上一个任务，稍后继续」，
不要立刻重试或改用其他工具抢占执行槽。`task_run` 因队列满返回 `busy` 时也用同一句话术；
正常排队无需向用户报错，等前一个执行结束后会自动开始。

### `task_run`

把一件独立任务交给串行 worker 执行。worker 是独立会话（不注入长期记忆），
产出只有 ≤300 字回执。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `goal` | string | 是 | 任务目标，1–2000 码点；必须自包含（worker 不读记忆） |
| `title` | string | 否 | 任务标题，≤80 码点；只用于回执与审计 |

返回：

```json
{
  "ok": true,
  "taskId": "task-m4x2-1",
  "status": "done",
  "receipt": "状态：成功｜结论：周报已生成｜产物：无｜耗时：12.3s",
  "sessionId": "session-...",
  "durationMs": 12345
}
```

`status` 为 `done` / `timeout` / `failed`；执行失败不回滚成异常，而是返回
`status:"failed"` 并在回执里写「失败」。

并发与超时：

- **全局单槽**：同一时刻只有 1 个 worker；忙时最多再排队 2 个。
  队列满时立即返回 `{ "ok": false, "reason": "busy", "queue": 2 }`，不建会话。
- **软超时 600s**：只写一条 `warn` 日志与耗时，不打断 worker。
- **硬超时 900s**：两段式回收——先 `cancel({sessionId, keepInbox:true})` 只中止
  当前轮，再 `cleanInbox(sessionId)` 清空排队；终态 `timeout`，回执写「超时」。
- 宿主没有 `sessionController` 时，插件注册路径返回 `{ "ok": false, "reason": "capability_missing", "message": "宿主未提供 sessionController，线程工具暂不可用" }`（工具集单独构造时才是 `session-unavailable`）。能力晚挂载后同一注册项直接可用，无需重装插件。
- 每日 token 达到 3M 时返回 `{ "ok": false, "reason": "daily_budget_exceeded" }`；
  RSS 达到降级线时返回 `{ "ok": false, "reason": "memory_pressure" }`（入队前拒绝）。
  降级线由 `rssStopGiB`/`rssMainOnlyGiB` 配置（默认 3.0/3.15GiB；4G 机器建议 2.4/2.6）。

审计：收尾写两条 `memory_events`（append-only）：`USED` + `kind:"task_receipt"`
（回执正文）与 `USED` + `kind:"task_run"`（任务生命周期）。`action` 词表里没有
`TASK`，所以用后者表达，避免为内部事件升级 schema。

### `cost_report`

无参数，返回今日/本月 token 汇总：

```json
{
  "today": { "tokensIn": 8000, "tokensOut": 4345, "total": 12345 },
  "month": { "tokensIn": 60000, "tokensOut": 38765, "total": 98765 }
}
```

## 导出、恢复与加密

导出覆盖 facts / episodes / reminders / threads / 状态板；情绪启用时另含 `emotion.state` 与 `emotion.events`（每作用域最近 50 条，敏感 `note` 置 null 并计入 `warnings`）。文件里的 `version` 恒为 1，`scope` 记录导出所用作用域。

### 导出

```text
/记忆 导出 json
/记忆 导出 md
```

也可以直接调 API（脚本或测试）：

```js
import { exportAll } from './src/memory/export.js';
const result = exportAll({ store, scope: 'main', format: 'json' });
// → { path, format, exported_at, scope, counts, bytes }
```

文件名形如 `memory-2026-11-04-091233.json`（UTC 秒级时间戳；同名时依次加 `-2`、`-3` 后缀，绝不覆盖），默认目录 `<cwd>/.data/export`，可用 `dir` / `now` 覆盖。导出 JSON 的 `schema_version` 从库中真实读取（`getMeta` → `schema_meta` 表 → 当前版本兜底）。默认**不导出** `sensitive` / `secret`、墓碑与 `superseded`；状态板按「未导出事实的 statement」行级剔除，避免板面泄漏。

### 恢复

```js
import { importAll } from './src/memory/export.js';
importAll({ store, file: '.data/export/memory-2026-11-04-091233.json', mode: 'fresh' });
```

- `fresh`：目标库五张表必须为空（`Store.open` 建出的空状态板占位行不算；情绪两表有条目也算非空），适合新机器或重建。
- `merge`：按主键跳过已存在的行（facts.id / threads.key / reminders.id 等），不覆盖本地已有内容；**情绪段例外**——`emotion.state` 按作用域 upsert 覆盖，`emotion.events` 追加后每作用域只留最近 50 条（返回 `emotionImported.state / events / trimmed`）。
- 整个导入在单事务内，任一行失败整体回滚；导出集中缺失的引用（`consolidation_id` / `source_episode_id` / `superseded_by`）置 null；恢复后逐行重建 facts / episodes FTS。

### 加密（单条事实）

```bash
node scripts/export-encrypted.mjs .data/companion.db 12 --out secret.enc
node scripts/decrypt-encrypted.mjs secret.enc --out fact.json
```

- 口令只从 stdin 读取（TTY 下关闭回显）；空口令、缺 `--out`、事实不存在都以退出码 1 失败。
- 解密先校验再写文件，错误口令、损坏文件或认证失败不会留下明文半文件；错误统一为「解密失败（口令错误、文件损坏或认证失败）」。
- 格式：AES-256-GCM + scrypt（N=2^14、r=8、p=1），随机 salt(16B) / iv(12B)，magic `DSH-COMPANION-EXPORT-1` + JSON header 保存 KDF 参数与 tag。`header.format = "v2"` 起 header 与 magic 行一起作为 AAD 认证，篡改 header / 密文 / tag 都会失败；`v1` 旧文件仍可解，新导出建议用 v2。

### 隐私与凭据（V7-M3，v0.4.9；V9-M1/L1/L2，v0.4.10；V10-L1，v0.4.11）

凭据类内容不进长期记忆。巩固落地前会逐条识别并跳过：

- 密码 / password / passwd（明确是密码语义时）、口令、验证码 / verification code、CVV/CVC、私钥 / 密钥、API key / apikey、access token / 令牌，以及 `sk-` 开头的字面值；
- 银行卡只拦卡号形态：12 位以上数字（允许 4 位分组的空格或连字符）；`卡号` / `card number` 字段名要求后跟数字，纯提及不拦；
- 设备 / 网络值：WiFi / 路由器 / 门禁 / 门锁 / 热点 + 是/为/`:`/`=` + 值（值须含数字或符号，`WiFi 是 公司网络` 不拦）；
- 「字段名 + 是/为/`:`/`=` + 值」形式（如 `api key = …`、`token: …`）；弱字段名要求值里含数字或符号，避免把普通技术讨论误判成凭据。

被跳过的内容不写 `facts`（也不进 facts 的 FTS 索引）、不写 `reminders`，状态板渲染前还会逐行过滤，历史库里已有的敏感行同样不会显示。episode 在落库前会对凭据值逐字段脱敏：只把值替换成 `[凭据已省略]`、保留上下文（例如「路由器密码 [凭据已省略]」），不是整段丢弃；脱敏后仍残留可识别凭据值时才整段替换。原文仅存于会话，跨会话召回、注入、状态板与导出都不会出现明文。命中时巩固结果带 `sensitive` 计数与提示，日志记 `credential content skipped`。

v0.4.10 之前落库的存量 episode 不受写入路径保护，可能仍带明文（并已投影进 `fts_episodes`）。v0.4.11 起打开旧库时（schema v13）会按上述同一口径对 `title` / `summary` / `evidence` / `mood_evidence` / `topics_json` / `entities_json` 一次性重跑脱敏，只更新真正变化的行并重建其 FTS 投影；完成后写 `schema_meta` 标记 `episode_scrub_v13`，重复打开直接跳过，审计只记一条计数事件（`action=scrub`，`detail={scanned,changed}`），不记录任何正文。

此外，每轮用户消息命中凭据时，插件会给模型一次固定提示（同一轮只注入一次，不转录、不参与巩固）：不复述具体值、不调用记忆工具，并回复「这类信息建议放环境变量或文件里，我不代为保存。」

### 向量召回（可选）

默认 `vector.enabled=false`：检索与 v0.2.0 逐字节一致，不读 `fact_vectors`。开启后 `hybridSearch` 用 RRF（`1/(60+rank)`）融合 FTS 与向量，同一 fact 去重；向量路只召回 active、normal、未删除、非 `sensitive`/`secret` 且 R ≥ 0.05 的事实。`vector.embedder` 支持 `hash`（默认，字符 bigram 哈希投影）、`local`（可选安装 `@huggingface/transformers`，默认 bge-small-zh-v1.5 512 维）、`remote`（默认关闭，显式 `vector.remote.enabled: true` 才启用；隐私例外见 [embedding.md](embedding.md)）与 `none`（等价关闭）。三种实现怎么选：

- `hash`：零依赖、离线、测试与低配机器首选；只做字符 bigram 投影，不是语义向量，同义改写召回有限。
- `local`：中文语义最好；需可选安装 `@huggingface/transformers`，首次要联网下载模型，占内存与首次加载时间。
- `remote`：复用已有 embedding 服务、不占本地算力；必须显式开启，事实原文与查询会离开本机（隐私例外），端点不可达或超时会自动退回 FTS。
- 任一实现失败/超时都只记 `vectorEmbedFailures` 并回退纯 FTS，不影响主流程；回填超时另记 `vectorBackfillTimeouts`，查询/回填遇推理占用记 `vectorEmbedBusy` 并本轮跳过或回退 FTS。不同 `embedder_id` 的向量互不召回，换实现后旧向量等写入或 idle-probe 回填。

离线对比可跑：

```bash
node scripts/bench-vector.mjs --dim 256 --json
```

schema v9 对向量表本身没有新改动：v0.3.0（schema 5）新建 `fact_vectors`；v0.4.0 的 v6 迁移给 `fact_vectors` 增加 `embedder_id` 并把旧行标成 `hash:<dim>`，hash 在下次写入 / 编辑 / 强化时重建，local/remote 的缺失向量由 idle-probe 每批 ≤ `vector.backfillBatchSize`（默认 8）回填、回填推理用 `vector.backfillTimeoutMs`（默认 30s），期间开启向量只是暂时召回不到它们，不会报错。v6→v7 给 `facts` 增加 `first_reneed_at` / `first_reneed_tier` / `reneed_kind` 三列（旧行 NULL）；v7→v8 增加 `same_context`；v8→v9 增加 `first_used_at` / `first_used_tier` / `used_same_context`，用于 S0 标定（见 [s0-calibration.md](s0-calibration.md)）。

### 宿主压缩开关（compaction-basic，v0.4.6）

插件通过宿主的 `compaction.compactRegion` 服务真正压缩 surface，压缩后按[外部压缩与水位重锚](#外部压缩与水位重锚v040)重锚水位。DSH web-app 默认把 `compaction-basic` 设为 `disabled: true`，此时 `/状态` 显示：

```text
压缩：宿主未开启（compaction-basic 未启用）
```

巩固与写库照常进行，`pending_compact` 只保留待压缩区间，不会真的缩小上下文。云端已验证的开启写法（写在 `cordis.patch.yml` 的插件列表里，不是本插件的 `config.yml`）：

```yaml
- id: compaction-basic
  disabled: false
  config:
    auto: false
```

`auto: false` 表示宿主不在每轮自动压缩，只让插件在空闲边界（`idleMs`，默认 30 分钟）调用 `compactRegion`，避免与巩固抢时机。开启后 `/状态` 显示「压缩：宿主已开启（compaction-basic 已启用）」，有待压缩区间时附「，待压缩 N 个区间」。

### 外部压缩与水位重锚（v0.4.0）

平台或用户执行 `/compact` 后，DSH 会把被压缩区间替换成一个追加在 surface 末尾的摘要节点（seq 变大），旧节点从 `session.surface.nodes` 消失。插件下一次 pre-step 会：

1. 按 surface 中的**位置**找到替换节点（不是取最小新 seq），正常情况下把水位重锚到替换节点之后；
2. 如果压缩区间越过了旧水位（有尚未巩固的节点被吞掉），把锚点前挪到替换节点之前，让平台摘要进入下一次巩固，并累加 `compactionLostUnconsolidated`；
3. 重锚值写入 `schema_meta`；锚到起点时写哨兵 `-1`，重启后不会回退到旧水位再重锚一次；
4. `/状态` 的「水位重锚：N 次」与「未巩固被压缩：N 个节点」分别对应重锚次数和被摘要吞掉的未巩固节点数。

**边界（R-L3）**：被压缩区间里尚未巩固的原始对话已经从 surface 消失，只能以平台摘要的形式进入记忆库；摘要没有保留的细节无法恢复。不要把「之后再巩固」当成丢失内容的兜底，重要信息应在压缩前写入记忆，或不要依赖外部压缩来保存。

### 压缩起点跳过系统节点（V7-M1，v0.4.9）

宿主 surface 的节点 0 通常是系统提示词（`role: 'system'`），平台不允许替换。插件在选压缩区间时：

- 起点落在系统节点上时，`firstReplaceableIndex` 推进到其后第一个非系统节点；节点 0 正文缺失、`role` 未知时保守跳过；
- 区间中途再遇到系统节点则提前收尾，系统节点不会被包进 region；
- 整段都不可替换时返回 `no-replaceable-range`；恢复历史 `pending_compact` 时同样收紧起点，收紧后区间为空就丢弃 pending、计入内部指标 `compactionDrops` 并记 warn 日志（`no replaceable node` / `region expired`），不会调用 `compactRegion`。

因此常规巩固、deep-sleep 与 pending 恢复压缩共用同一道起点收紧，系统提示词节点永不被压缩进 region。

**边界**：收紧只作用于区间起点。平台侧只保证 node 0 不被替换，跨版本旧 pending 的中段系统节点仍可能被跨过（见 [known-debt.md](known-debt.md) §5 的 V7-M1 观察项）。

### 主会话绑定（v0.4.4）

提醒要投到「当前主会话」，而桌面端可能先后开过多个会话。默认 `session.mainBinding: 'latest-user'`：

- 只有**线程外**会话出现真实用户输入时，才把 `main_session_id` 重绑到该会话，并记一条 info 日志（旧/新 id）；
- runtime-context、召回注入与中文命令提示都不算用户输入，不会触发重绑；
- `'first'` 保持首个主会话不变（多开但想固定投递目标时用）；
- `/状态` 显示「主会话：<id>（绑定 <mode>）」，提醒投递到该会话；取不到主会话 id 时按投递失败处理，留在 backlog 等下个 tick。

```yaml
session:
  # latest-user（默认）：跟随最新真实用户会话；first：保持首个主会话。
  mainBinding: latest-user
```

### 提醒投递队列与失败退避（v0.4.5）

提醒（`kind: reminder`）走独立的两阶段投递队列，不再和别的提醒拼成一条，失败后按退避重试：

- **入队去重按提醒 id**：队列键固定为 `reminder:<id>`（不含 tick 秒）。安静时段、日上限或退避期间，调度器每个 tick 重新扫描到同一条提醒时会直接跳过已有队列项，不会堆出多份副本；早上解除安静时段后只发一条。
- **提醒不参与文本合并**：不同提醒各自独立投递。即使合并逻辑将来用于其它类别，投递前钩子也逐份判定——只有被取消的那一份被剔除，其余照常送达；被剔除的份会回调 `onFailed`，不会留下「已 claim 未投递」的 `delivering` 行。
- **失败退避（v0.4.8 起语义调整）**：`onAttempt` 把行从 `pending` 置 `delivering` 并累加 `delivery_attempts`；投递失败或本轮放弃时 `onFailed` 把行放回 `pending`，并把退避时刻写入 `retry_at`：第 1 次失败退避 30s，第 2 次失败退避 60s；第 3 次失败不再重试、直接置 `expired`（退避表第 3 档 120s 在当前上限下不可达，仅调高 `REMINDER_MAX_DELIVERY_ATTEMPTS` 后才会用到）。`next_fire_at` 始终是**原定到点时间**，失败重试不改写它；投递成功或置 `expired` 时清空 `retry_at`。
- **到期口径唯一（v0.4.9 起）**：调度扫描（`store.dueReminders`）与投递守卫（`index.js` 的 `onAttempt`）统一按 **`max(next_fire_at, retry_at)`** 判断是否到期，两边共用 `src/memory/store.js` 导出的 `REMINDER_DUE_AT_SQL` / `reminderDueAt`，不再各写一份 `COALESCE` 与 `Math.max`。取 `max` 而不是「`retry_at` 优先」是为了让旧数据里 `retry_at` 早于 `next_fire_at` 的情形也只有一个答案：原定时间未到就不会因为一条过早的退避记录提前投递。
- **改期必须清空 `retry_at`**：唯一写入口是 `store.rescheduleReminder(id, { next_fire_at, ... })`，它在更新原定时间的同时清空 `retry_at` / `occurrence_key` / `last_fire_key`，把 `delivery_attempts` 归零，让改期后的到点算新的一次 occurrence。绕过 store 的裸 SQL 改期由库级触发器 `trg_reminders_reschedule_clear_retry` 兜底（`next_fire_at` 变化时清空残留 `retry_at`），所以导入备份、手工维护 SQL 也不会留下「旧退避时刻压过新时间」的脏状态。
- **到期索引（v0.4.9 起）**：`reminders` 上的到期索引改为表达式索引 `ix_rm_due(status, max(COALESCE(next_fire_at,0), COALESCE(retry_at,0))) WHERE status IN ('pending','snoozed')`，与查询表达式逐字对应，`EXPLAIN QUERY PLAN` 命中 `ix_rm_due`。旧的 `ix_rm_fire(status, next_fire_at)` 建在裸列上，任何到期查询都走不到，已删除（保留只会增加提醒写入时的 B 树维护成本，并给查询计划器一个不会被选中的候选）。索引与触发器都在 `migrate()` 里幂等补建，旧库打开即就地升级，**不提升 `schema_version`**。
- **requestId 按 occurrence 稳定（v0.4.7）**：每次真正到点入队前，先取（或惰性生成）`reminders.occurrence_key`，requestId 固定为 `companion-reminder:<id>:<occurrence_key>`。失败退避只写 `retry_at`、不改 `next_fire_at`，重试仍复用同一个 occurrence_key，因此 rpcId 不变，宿主能按 rpcId 去重；投递成功或置 `expired` 时清空 occurrence_key/last_fire_key 与 retry_at，并把 `delivery_attempts` 归零，下一次到点生成新 key、attempts 从 0 重新计数。提醒展示与 `/状态` 始终使用原定时间，重试期间额外标注「重试中，下次 HH:MM」（取 `retry_at`）。
- **上限与回收**：`delivery_attempts` 达到 3 次才置 `expired`；连续 3 个 30s tick 不会把一条刚失败的提醒直接耗成过期。进程崩溃残留的 `delivering` 行在启动时统一回收为 `pending` 并补发；回收时已超上限的行置 `expired`，同样清空 occurrence/计数。
- **展示口径**：状态板的提醒行始终用 `next_fire_at`（原定到点时间）显示日期；退避期间在同一条后追加「重试中，下次 HH:MM」（`retry_at`，按 `config.timezone` 格式化），例如 `- 交房租（11-05，重试中，下次 17:02）`。退出重试（成功/过期/过期回收）后附注自动消失，原定时间仍保留。
- 投递失败、取不到主会话或安静时段内，消息留在 backlog，下个 tick 继续尝试；`/状态` 的积压数与当日计数照常反映这些排队项。

## 配置示例

默认配置即可启动。下面是几个常见调整。

安静时段改为 22:30–07:30，并把每日主动消息上限降到 1 条：

```yaml
quietStart: "22:30"
quietEnd: "07:30"
proactiveDailyCap: 1
```

完全关闭主动消息：

```yaml
proactiveDailyCap: 0
```

把数据库放到独立目录（目录需已存在或有写权限）：

```yaml
dbPath: "D:/dsh-data/companion.db"
```

开启可选向量召回（默认关闭；`hash` 为零依赖字符哈希投影）：

```yaml
vector:
  enabled: true
  dim: 256
  embedder: hash
```

用本地真实 embedding（可选依赖，不装则自动退回 FTS）：

```bash
npm i @huggingface/transformers
```

```yaml
vector:
  enabled: true
  embedder: local
  localModel: Xenova/bge-small-zh-v1.5
  prefixQuery: true
  backfillBatchSize: 8
  backfillTimeoutMs: 30000
```

接入远程 embedding（默认关闭；会把事实原文与查询发到第三方，敏感/secret/墓碑不回填）：

```yaml
vector:
  enabled: true
  embedder: remote
  embedTimeoutMs: 300
  remote:
    enabled: true
    endpoint: https://embed.example.com/v1/embeddings
    apiKeyEnv: DSH_EMBED_API_KEY
```

调整召回相关性门槛（v0.4.4 起默认启用；与 `vector` 一样是可选段，不参与 16 键安装自检）：

```yaml
recall:
  # 向量余弦低于该值且没有足够词法命中的候选直接丢弃（0..1）。
  minVectorScore: 0.35
  # 短于该长度的查询、纯算术/符号、常见问候词直接跳过召回，避免「1+1」「你好」注入记忆。
  # v0.4.5 起默认 2（此前写死 4）：按码点计，CJK 2 字实体（「蓝鲸」「生日」「吃药没」）可召回。
  minQueryChars: 2
  skipSmallTalk: true
```

`minVectorScore` 取 0 表示任何非零向量命中都算相关，取 1 表示只认完全一致的向量；
`skipSmallTalk: false` 可关掉短查询/小聊过滤（此时仍受 `minVectorScore` 与词法命中的约束）。
`minQueryChars` 必须是 1..64 的整数，非法值抛 `ConfigError`（`recall.minQueryChars`）。

v0.4.5 起，非空查询的词法命中要「够相关」才算证据（不再任意一个 bigram 命中就放行）：

- 停用 bigram（今天/明天/我们/你们/一下/一个/什么/怎么/可以/这个/那个/就是/因为…）
  不计入命中，也不计入命中比例的分母；与停用 bigram 位置重叠的跨词 bigram 一并剔除。
  纯停用词查询（「今天怎么样」）因此没有任何有效 bigram，不会注入。
- 一个候选需命中 ≥2 个不同有效 bigram，或命中比例 ≥30%（命中数 ÷ 查询有效 bigram 数），
  或者向量余弦不低于 `minVectorScore`；都不满足就丢弃。
- 打分排序仍是 `0.6×相对相关度 + 0.4×时间新鲜度`，其中相对相关度按查询的全部 bigram 计算。

2C4G 云端把 RSS 三档下调到预算 2.5GiB 以内（公式 `min(userLimit, totalmem×0.75−512MiB)`；
三档须递增且不超过总内存 75%，4GiB 即 3.0GiB）：

```yaml
rssWarnGiB: 2.2
rssStopGiB: 2.4
rssMainOnlyGiB: 2.6
```

完整配置项与默认值见 [README](../README.md#配置)。

### 线程会话 preset（V10-H1，v0.4.11）

`thread_run` 新建线程会话时使用宿主 preset。默认不配置（`thread.agentPreset: null`），
此时插件**不传** `agentPreset`，由宿主使用默认 preset；`/状态` 显示「线程 preset：宿主默认」。

首次安装时，由安装 agent 读取宿主的实际 preset 列表（例如 DSH 0.2.1-rc.5 为
`read-only` / `workspace-write` / `danger-full-access`），按「够用的最小权限」选一个写入：

```yaml
thread:
  agentPreset: workspace-write
```

安装 agent 的约束：

- 线程会话需要读写工作目录并调用工具，通常 `workspace-write` 即够用；
  **不得选 `danger-full-access`**。
- 无法确认宿主 preset 列表或所选值不存在时，不要猜测：先留空走宿主默认，
  或按宿主报错改成实际存在的值。配置了宿主不认识的 preset 时，`thread_run`
  返回 `reason: "preset_unknown"` 并附宿主原错误文本，不会抛异常、不会写半截线程行。
- 配置后 `/状态` 显示「线程 preset：<name>（配置：thread.agentPreset）」；
  该节是可选段，不参与 16 键安装自检。

### 压缩/巩固耗时观测（G0-9，v0.4.11）

`/状态` 展示最近一次实际执行的压缩/巩固耗时，用于真机核对「压缩 p95 ≤ 20s、
巩固 p95 ≤ 60s」的验收口径：

```text
最近压缩耗时：12.3s
最近巩固耗时：31.0s
```

超过阈值时在值后标注「（超阈值）」，例如 `最近巩固耗时：72.4s（超阈值）`；
还没有样本时显示 `—`。

口径：

- **压缩**：`platform.compactRegion(...)` 调用开始 → 重读 surface、写
  compaction 事件、发布状态板完成（`maybeCompact` 的成功路径整段）。
- **巩固**：`executeConsolidationJob` 入口 → `consolidate()` 返回（含选区规划
  与模型解析）；失败样本同样记录耗时，但成功/失败不展示，只用于日志。

阈值可配置（正整数毫秒；默认值对应验收口径）：

```yaml
timing:
  compactWarnMs: 20000
  consolidateWarnMs: 60000
```

单次超过阈值时写一条 warn（如 `[dsh-companion] consolidation took 72.4s (>60s)`），
同类（压缩/巩固）在同一进程内只告警一次，直到出现一次不超阈值的样本后重置。
阈值只用于观测与告警，**不设硬超时、不会中止任务**；现有压缩/巩固流程与
线程/任务超时逻辑都不变。该节是可选段，不参与 16 键安装自检。

### 人格卡（V11-P1，v0.4.12）

v0.4.12 起，人格卡是运行时唯一的人格数据源：人格段、承诺跟进的称呼、轻闲聊提示词与
闲聊违禁词过滤都读同一张卡。插件在 `apply` 时**加载一次**，整个进程生命周期内不再读文件。

**配置键**（可选段，不参与 16 键安装自检）：

```yaml
persona:
  # 人格卡 JSON 文件路径（结构见 persona.example.md）。
  # 不写或 null = 内置「珞然」卡；未知子键只写 warning。
  cardPath: persona.json
```

取值与校验：

- `null`、不写、或 trim 后空串：使用内置默认卡，不读文件；
- 非空字符串：按下面的规则解析成绝对路径；
- `persona` 不是普通对象、或 `cardPath` 不是字符串（也不是 `null`）：与其它配置键一致，
  fail-fast 抛 `ConfigError`（`persona` / `persona.cardPath`），不会静默回落。

**路径解析**：

- 绝对路径：原样使用；
- 相对路径：相对 `DSH_HOME`——环境变量 `DSH_HOME`（trim 后非空）优先，否则 `~/.dsh`。
  例如 `DSH_HOME=/opt/dsh-companion-home` 时 `cardPath: persona.json` 指向
  `/opt/dsh-companion-home/persona.json`；未设置 `DSH_HOME` 时指向
  `~/.dsh/persona.json`。相对路径**不是**相对工作目录或配置文件所在目录。

**字段**（文件内容与内置默认值逐层深合并；`name` / `address` / `tone` 必须显式写在文件里）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | `珞然` | 助手自称；人格段与轻闲聊提示词都会用 |
| `address` | `你` | 对用户的称呼；人格段、承诺跟进、轻闲聊都会用 |
| `tone` | 简洁 / 温和 / 先结论 | `style` / `warmth` / `structure` 三子键，进人格段与轻闲聊提示词 |
| `relation` | 管家 0.7 / 朋友 0.3 | 关系配比；本版只保留字段，不参与提示词渲染 |
| `proactive` | 每日 3 条 / 聊天 1 条 / 安静 23:00–08:00 | 本版**不生效**，主动节奏以配置为准（见下） |
| `bannedPhrases` | 5 条 | 轻闲聊的提示词与输出过滤都会用 |
| `values` | 4 条 | 行为准则，进人格段 |
| `taboos` | 6 条 | 不主动触碰的话题，进人格段 |
| `version` | `1` | 人格卡版本号，只用于 `/状态` 展示 |

**数组合并语义**：`values` / `taboos` / `bannedPhrases` 是**整体替换**，不是追加。
只写一条就只剩一条；想保留默认项，必须把需要的项完整复制进 `persona.json`。
对象字段（`tone` / `relation` / `proactive`）才是逐层深合并，可只写要改的子键。

**改完需重启**：人格卡只在 `apply` 时加载一次，没有热加载；修改 `persona.json` 后要重启
宿主（或重载 profile）才生效。字段校验（必填字段、字符串数组、`version` 正整数）也在
加载时做一次。

**加载失败兜底**：文件不存在、不是普通文件、无读取权限、JSON 非法、必填字段缺失等任何
加载错误都**不会阻断启动**，也不会让 `apply` 抛错——插件回落到内置默认卡继续运行，
并写一条 warn：

```text
[dsh-companion] persona card load failed; using built-in card
  path=/opt/dsh-companion-home/persona.json
  reason=文件不存在（ENOENT）：/opt/dsh-companion-home/persona.json
```

日志里搜 `[dsh-companion]` + `persona card`；`reason` 会带绝对路径，常见如
`loadCard(<path>): invalid JSON: ...`（JSON 非法）或
`persona card: "name" must be a non-empty string（<path>）`（必填字段缺失）。

**`/状态` 来源行**：加载结果有三种，`/状态` 对应三态：

```text
人格卡：珞然 v1（内置默认）
人格卡：阿岩 v2（/opt/dsh-companion-home/persona.json）
人格卡：珞然 v1（加载失败，已用内置：文件不存在（ENOENT）：/opt/dsh-companion-home/persona.json）
```

**主动节奏以配置为准**：卡的 `proactive.dailyCap` / `quietStart` / `quietEnd` 与配置的
`proactiveDailyCap` / `quietStart` / `quietEnd` 重复。本版运行时以配置为准，卡里的这三个值
不生效；两边不一致时启动写一条 warn 提醒去重：

- 文件卡：`[dsh-companion] persona card proactive settings conflict with config; config wins`，
  `fields` 形如 `proactive.dailyCap≠proactiveDailyCap`；
- 内置默认卡（含加载失败后的兜底）：`[dsh-companion] 人格卡（内置默认）的
  proactive.dailyCap=3 与配置 proactiveDailyCap=1 不一致，以配置为准`。

内置卡也参与比较：内置 proactive 值等于默认配置，只有你改过 `proactiveDailyCap` /
`quietStart` / `quietEnd` 才会触发；此时使用内置卡看到这条提示属正常（提醒字段重复），
可忽略。`proactive.chatPerDay` 在配置里没有对应键，文件卡只记一条 debug 说明、不告警
（内置卡不记）。卡的 proactive 与配置的合并方案留到后续版本。

完整 JSON 示例与复制模板见 [persona.example.md](../persona.example.md)。

### 遮蔽宿主人设（P2，v0.5.0）

宿主 0.4.x 的默认人设来自全局层 `deployment:persona-prefix`（人设本体）与
`deployment:persona-suffix`（收尾）。插件以 profile 行挂载，**不能**注册同名段；唯一入口是
`system-prompt/assemble` waterfall。配置仍在 `persona` 可选段里：

```yaml
persona:
  cardPath: persona.json
  # off（默认，也接受 false）/ rewrite（true 等价）/ takeover
  shadowDeployment: rewrite
```

- `off`：完全不注册 assemble 监听，提示装配路径与旧版一致（`/状态` 多一行「宿主默认」）；
- `rewrite`：只把 prefix 的文本换成人格卡的 `chatIdentity`（`{{char}}` / `{{user}}` 已渲染），
  其它段与位置不变；
- `takeover`：摘掉 prefix 与空/纯空白的 suffix；非空 suffix 保留并写一次 warn；
- 非法值 fail-fast：`ConfigError('persona.shadowDeployment')`。

只影响 agent scope；子代理按现有 `classifySession()` 判定为 `subagent` 时**不遮蔽**（fork 子会话
若 header 只有 `parentSession` 会被当作主会话继续遮蔽，见
[persona-shadow.md](persona-shadow.md)）。遮蔽失败只写 warn 并放行原 assembly，不挡装配；
宿主两段都缺失（改版）时同样只 warn 一次。`/状态` 增加：

```text
部署人设：宿主默认
部署人设：已替换（人格卡身份）
部署人设：已接管
```

回滚：把 `shadowDeployment` 改回 `off` 并重启，无需改卡或清数据。机制、探针实测与影响面见
[persona-shadow.md](persona-shadow.md)。

### headless 一次性运行与 round C 口径（V10-M1，v0.4.11）

**headless / one-shot 不会发生巩固。** headless（`--profile headless`）、one-shot
bundle 与 SDK 单次调用都在 turn 结束后让进程退出；巩固由插件在 turn 收尾时用
`setImmediate` 排到后台（`src/index.js` 的 `scheduleConsolidation` /
`runConsolidationJob`，pre-step 只做同步判断），进程退出后没有后续 tick，不会真正
执行 `consolidate()`。云端实测 headless 会话 `tokenMeter` 有值、`consolidations=0`
属正常现象，不是巩固失败，也不代表记忆丢失；需要巩固时让进程常驻（desktop /
常驻 headless 服务），巩固会在 turn 收尾后的后台 tick 执行。

**round C 的通过口径（v0.4.11 起）**：在**常驻实例**上连续运行并观察到
**8 次巩固成功**（`consolidations` 成功行累计 8 条，且没有重试耗尽/最终失败）即判
round C 通过；不再要求 headless 门内完成。headless 发布门
（`node scripts/probe/run-headless.mjs --plugin`）仍保留 round A/B（插件激活、
召回注入）的冒烟断言；其 round C 在无模型凭据时显示 `SKIP`（未计 PASS），有凭据
时也只断言门内可观测到的部分，**不作为 round C 的通过依据**。

以下三种「让 headless 门内完成巩固」的改造均**未实现，属推迟项**：

1. `DSH_COMPANION_GATE_SYNC` 环境变量：让门在进程退出前等待已排队的巩固跑完；
2. 常驻版门脚本：启动一个常驻实例，累计统计到 8 次成功巩固后判定 PASS；
3. dispose 限时等待：`dispose()` 时给在飞/已排队的巩固一个有限等待窗口。

因此发布时 round C 要在常驻实例上人工或由外部脚本验收；headless 门只证明插件能
激活、能注入召回，不证明巩固。门槛改造与验收方式见
[known-debt.md](known-debt.md) 的 D-10。

## 错误与降级

### 启动与配置

- 配置非法：`apply` 前校验，抛 `ConfigError`（带出错字段名），插件不加载；修正后重载 profile。未知配置键只记警告。
- 数据库只读或不可写：`Store.open` 失败（如 `SQLITE_READONLY`、`SQLITE_CANTOPEN`），`apply` 抛错且不会注册任何命令/工具。请把 `dbPath` 指向可写目录（WAL 需要同目录写权限），或修正文件权限后重启。
- 同一 ctx 二次 `apply`：返回同一个 `{ dispose }` 句柄，不重复注册；`dispose()` 关闭 Store 并清掉 interval，可安全重复调用。

### 宿主能力缺失

插件按能力降级，不因宿主缺服务而崩溃：

- 无 `systemPrompt`：不注册人格段。
- 无 `preStep`：不注册召回注入，主对话不受影响。
- 无 `compaction`：巩固成功但 pending 保留，直到有压缩能力；记忆已落库，不丢数据。
- 无 `commands` / `tools`：对应命令或工具不注册。
- 无 `timer`：不启动调度器，提醒与主动消息不推送。
- 无 `tokenMeter`：`/状态` 的 tokens 段显示 0，其余计数正常。
- 无 main 会话或 `prompt` 不可用：主动消息发送失败会留在队列等待下个 tick；`thread_run` 返回 `prompt-unavailable`。召回只影响注入，不影响原始对话。
- 无模型（`ctx.companion.consolidationLlm` 与 `ctx.llm` 都不可用）：巩固跳过并记 `warn` 日志（同一原因只告警一次），不阻塞对话，已有记忆照常检索。provider/model 发现失败（`listProviders` 或某个 provider 的 `listModels` 抛错）同样记 `warn`，按「provider 发现失败」「provider X 模型发现失败」去重，成功发现后重置，不会每 5 分钟刷屏；`/状态` 仍显示「巩固：无可用模型」。
- 无 `unarchiveSession`：复用归档线程返回 `unarchive-unavailable`。
- 无 `sessionController`：**10 个工具一律注册**（`thread_list` / `thread_run` / `task_run` 也在内）；线程/任务工具在 `execute` 时读 `platform.capabilities.threadTools`，不可用返回稳定 `{ "ok": false, "reason": "capability_missing", "message": "宿主未提供 sessionController，线程工具暂不可用" }`，不抛异常、不写半成品。`/状态` 与 `/线程` 每次调用都实时判断，统一显示「线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）」；能力晚挂载后无需重装插件，同一注册项即可用。`/记忆 导出` 仍可用（只读库）。headless / one-shot / SDK profile 属于正常降级；desktop profile 组合 web-app，能力齐全。
- `vector.embedder: none`、`enabled: false` 或 remote 未显式 `remote.enabled: true`：检索退化为 bigram FTS，与旧版一致；`/状态` 显示「向量：关」。

### 工具错误

- 参数非法：抛 `TypeError`，消息带工具名与字段名；调用方修正后重试。
- 业务失败：返回 `ok:false` 加 `reason`（如 `not-found`、`not-active`、`too-many-threads`、`cwd-unavailable`、`preset_unknown`）。
- 检索无命中：返回空列表，不注入、不编造。

### 自愈与重试

- **巩固失败**：写 `consolidations` 失败行，按 1/2/4 tick 退避重试，最多 3 次；重试复用同一行，成功后清空 `error` 并推进水位，最终失败写 `consolidation_failed_final`。`MISSING_CREDENTIAL` 不重试。
- **定时任务失败**：写 `job_error`（含 attempts 与 last_error），并在次日 17:03 重试（`job_retry`）；重启后会从历史失败态恢复计数。
- **数据库繁忙**：事务入口对 `SQLITE_BUSY` 最多重试 3 次（5–25ms 线性抖动，上限 50ms），其它错误原样抛出。
- **降级期间顺延**：每日 3M 熔断或 RSS ≥ stop_dispatch 时，巩固重试与闲聊会被顺延到恢复之后；失败态与计数保留，不会丢失。

### 数据库与文件

- 备份失败：写 `USED/scheduler_jobs/backup_failed` 审计并抛给调度器记 `job_error`，次日重试；成功时按日期滚动保留最近 7 份。
- 导出失败（如目录不可写）：命令层抛出错误并在回复里显示原因，不会写半截文件；`fresh` 恢复在目标库非空时直接拒绝，不写入任何行。
- 导出文件默认落在 `<cwd>/.data/export/`，文件名精确到秒（同一秒重复导出依次追加 `-2`、`-3`，不会覆盖已有文件）。
- 遗忘到期清理失败：任务错误记账，下次 03:30 继续；冷静期内的行不会被提前删除。

## 常见问题

### 为什么珞然回复「不记得了」？

说明检索没有找到可用记忆：可能从未写入、已被遗忘（tombstone）、被新事实取代、标记为 `secret`，或遗忘曲线分数低于阈值。插件按设计不编造答案；可以补充说明后重新写入。

### 如何彻底清除一条记忆？

用 `/记忆 忘掉 <id|关键词>` 或工具 `memory_forget` 标记。标记后立即不再召回，但行仍保留 7 天（`purgeAfterDays`，可配 1–30），到期由每日 03:30 的 `s2-purge` 任务物理删除。

需要立即删除时用二次确认：`/记忆 彻底忘掉 <id>` 先返回提示，再回复 `/记忆 彻底忘掉 <id> 确认` 跳过冷静期物删（审计只留 id，不含正文）。工具侧对应 `memory_forget` 的 `immediate` + `confirm` 参数。

### 如何导出单条明文？

整库视图用 `/记忆 导出 md|json`（默认剔除 `sensitive`/`secret`、墓碑与被取代项，状态板按行 scrub）；单条事实的加密导出用 `node scripts/export-encrypted.mjs <db> <fact-id> --out <file>`，口令从 stdin 读、不落盘。只想看明文时，`memory_search` 返回的 `text` 就是原文。

### 如何迁移到新机器？

1. 旧机器：`/记忆 导出 json`（或 `md` 仅作阅读），把 `.data/export/memory-*.json` 拷走；
2. 新机器：`importAll({ store, file, mode: 'fresh' })` 导入空库（已有数据时用 `merge`，按主键跳过已存在行）；
3. 导入是单事务，失败零落库；恢复后 FTS 自动重建。旧事实不会立刻有向量：hash 在下一次写入 / 编辑 / 强化时重建，local/remote 由 idle-probe 分批回填。

### 向量召回为什么没效果？

先确认 `vector.enabled: true`（默认关闭）且 `/状态` 显示「向量：开·dim X·<embedder id>·已回填 N·最近命中 N·回填超时 N·占用 N」。`hash` 只是字符 bigram 哈希投影，不是语义 embedding，中文同义改写召回有限；`local` 需要可选安装 `@huggingface/transformers` 并首次联网下载模型；`remote` 需要显式 `remote.enabled: true` 且 endpoint 可达。旧库升级到 schema v9 后旧向量按 `embedder_id` 隔离，等待写入或 idle-probe 回填；embedding 失败会在日志里出现 `embedding failed; falling back to FTS`。

### 主动消息为什么没来？

依次检查：当前是否处于安静时段（默认 23:00–08:00）、今日是否已达 `proactiveDailyCap`、同类消息是否在去重窗口内、积压是否已达上限。把 `proactiveDailyCap` 设为 `0` 会完全关闭主动消息。

**承诺跟进**：只跟进 `kind=commitment` 且未完成、`due_at` 已到的提醒，每天至多 1 次；安静时段内只积压，时段结束后补发一次。**轻闲聊**另有独立闸门：需开启闲聊、当日有过互动、非周末、距上次 ≥ 3 天、当日 ≤ 1 条、7 天内 ≤ 3 条；任一条不满足都不会发。可用 `/别闲聊` 关闭、`/恢复闲聊` 恢复。

### 治理会删除记忆吗？

不会。`/记忆 治理` 只把重复项降级为 `superseded`（可用 `/记忆 列表` 看到保留条）、把敏感项标为 `sensitive` 并移出召回；物理删除仍只走遗忘路径（S1 墓碑 + `purgeAfterDays` 冷静期，或确认后的立即删除）。

### 线程为什么被拒绝或冻结？

同时活跃的线程最多 6 个（`threadMaxActive`），超过后新建会被拒绝；`key=new` 时必须提供 `name`。线程空闲超过 14 天（`threadIdleDays`）会被归档冻结，再次使用同一 key 时会自动重新激活。

### 巩固和压缩用的是哪个 seq？（v0.1.1 起）

`consolidations.upto_seq` / `compaction_start_seq` 记的是**会话 surface 节点的 seq**（`session.surface.nodes`），
不再是插件自增的轮次计数。压缩会把区间替换成追加在日志末尾的新节点（seq 变大），
插件随后按新 surface 重写水位（`retargetConsolidation`），因此水位只在「当前可见 surface」内自洽，
历史行只作审计。升级到 v0.1.1 时旧库会迁移到 `schema_version=4`：清空 `consolidations`
（开发期约定，旧值语义不可比）、把 `episodes.consolidation_id` 置空；facts/episodes 不受影响。
v0.3.0 起 `schema_version=5`：只新增 `fact_vectors`（向量投影）表，既有数据不动。
v0.4.0 起 `schema_version=7`：v5→v6 先给 `fact_vectors` 增加 `embedder_id`，旧向量行回填为 `hash:<dim>`；v6→v7 再给 `facts` 增加 `first_reneed_at` / `first_reneed_tier` / `reneed_kind` 三列（旧行 NULL）和 `(scope, first_reneed_at)` 索引，用于 S0 首次再需要标定（见 [s0-calibration.md](s0-calibration.md)）。v0.4.1 起 `schema_version=8`：增加 `same_context` 与 `used` 升级口径，排除同会话即时召回。v0.4.2 起 `schema_version=9`：增加 `first_used_at` / `first_used_tier` / `used_same_context` 与 `(scope, first_used_at)` 索引，用上那一刻单独记录，recall 样本保留对照（旧行新列为 NULL）。旧库按列检测逐级推进，无需手工改版本。v0.4.4 起 `schema_version=10`：`reminders` 的 `status` CHECK 增加 `delivering`，新增 `delivery_attempts` 列（旧行 `0`），幂等重建表并重建两个索引，兼容 v3..v9。v0.4.7 起 `schema_version=11`：`reminders` 新增 `occurrence_key`（旧行 NULL，按列检测补列），用于让提醒 requestId 在同一次到点的退避重试中保持不变。v0.4.8 起 `schema_version=12`：`reminders` 新增 `retry_at`（退避时刻，旧行 NULL，按列检测补列）；失败退避只写 `retry_at`，`next_fire_at` 保持原定到点时间，成功/过期清空 `retry_at`。v0.4.9 起到期口径统一为 `max(next_fire_at, retry_at)`（调度与投递守卫同源，见上），`reminders` 的到期索引换成表达式索引 `ix_rm_due`、删除失效的 `ix_rm_fire`，并加 `trg_reminders_reschedule_clear_retry` 在改期时清空残留 `retry_at`；这些索引/触发器由 `migrate()` 幂等补建，`schema_version` 仍为 12，旧库打开即升级、无需手工操作。v0.4.11 起 `schema_version=13`：纯数据迁移，无新列。v0.4.10 之前落库的存量 episode 可能仍有明文凭据值（`title` / `summary` / `evidence` / `mood_evidence` / `topics_json` / `entities_json`，并已投影进 `fts_episodes`），打开旧库时按写入路径同口径重跑一次脱敏（值级替换，漏网且仍残留值形态的整段替换为 `[凭据已省略]`），只更新真正变化的行并重建其 FTS；成功后写 `schema_meta` 标记 `episode_scrub_v13`，重复打开直接跳过，审计只记一条 `memory_events`（`action=scrub`，`detail={scanned,changed}`，不含正文）。

### 数据存在哪里？

默认在插件工作目录的 `.data/companion.db`（可通过 `dbPath` 修改），包含 `-wal`、`-shm` 附属文件。平台自己的会话 JSONL 由 DSH 管理，不在本插件数据库内。
