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

### `/成本`

汇总 `memory_events` 中记录的 token 用量：

```text
/成本
成本：今日 12345 tokens（入 8000 / 出 4345）｜本月 98765 tokens（入 60000 / 出 38765）
```

### `/线程`

列出线程目录（最多 100 条）：

```text
/线程
线程目录（2）：
rent | active | 租房 | 2026-11-03
health | archived | 体检 | 2026-10-20
```

没有线程时返回 `线程目录：暂无。`。

### `/状态`

查看各表计数、FTS 行数、主作用域水位与最近一次定时任务：

```text
/状态
状态：entities 8 / episodes 120 / facts 96 / reminders 4 / state_board 2 / state_board_rev 9 / threads 3 / consolidations 21 / memory_events 310 / fts facts 96/episodes 120 / tokens 本轮 入 8000 出 1200（超预算 0 次）
水位 main：120
最近 job：s2-purge ok upto_seq=0（2026-11-03 03:30）
```

最后一段 `tokens 本轮 …` 是当前轮工作记忆的 token 快照（入 = 上下文总量，出 = 本轮新增）；没有 `tokenMeter` 能力时显示 `tokens 本轮 0`，不影响其它计数。

## 工具

插件向模型注册 8 个工具。必填字段缺失、类型错误或取值越界时，工具抛出 `TypeError`，消息里带工具名与字段名；调用方应修正参数后重试。

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
- `session-unavailable`：宿主没有 `sessionController.createSession`。
- `unarchive-unavailable`：复用已归档线程，但宿主没有 `workspaceRegistry.unarchiveSession`。
- `prompt-unavailable`：宿主没有 `sessionController.prompt`，无法投递目标。

### `cost_report`

无参数，返回今日/本月 token 汇总：

```json
{
  "today": { "tokensIn": 8000, "tokensOut": 4345, "total": 12345 },
  "month": { "tokensIn": 60000, "tokensOut": 38765, "total": 98765 }
}
```

## 配置示例

默认配置即可启动。下面是三个常见调整。

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

完整配置项与默认值见 [README](../README.md#配置)。

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
- 无模型（`ctx.companion.consolidationLlm` 与 `ctx.llm` 都不可用）：巩固跳过并记 debug 日志，不阻塞对话，已有记忆照常检索。
- 无 `unarchiveSession`：复用归档线程返回 `unarchive-unavailable`。

### 工具错误

- 参数非法：抛 `TypeError`，消息带工具名与字段名；调用方修正后重试。
- 业务失败：返回 `ok:false` 加 `reason`（如 `not-found`、`not-active`、`too-many-threads`、`cwd-unavailable`）。
- 检索无命中：返回空列表，不注入、不编造。

### 数据库与文件

- 备份失败：写入 `scheduler_jobs` 审计（`reason=backup_failed`），不影响主流程；成功时按日期滚动保留最近 7 份。
- 遗忘到期清理失败：任务错误记账，下次 03:30 继续；冷静期内的行不会被提前删除。

## 常见问题

### 为什么珞然回复「不记得了」？

说明检索没有找到可用记忆：可能从未写入、已被遗忘（tombstone）、被新事实取代、标记为 `secret`，或遗忘曲线分数低于阈值。插件按设计不编造答案；可以补充说明后重新写入。

### 如何彻底清除一条记忆？

用 `/记忆 忘掉 <id|关键词>` 或工具 `memory_forget` 标记。标记后立即不再召回，但行仍保留 7 天（`purgeAfterDays`，可配 1–30），到期由每日 03:30 的 `s2-purge` 任务物理删除。

当前版本没有跳过冷静期的用户命令。若必须立即清除，只能停止插件后删除数据库文件，这会丢失全部记忆；操作前请先备份。

### 如何导出单条明文？

没有单独的导出命令。用 `memory_search` 找到 id 后，返回的 `text` 就是原文（`/记忆` 只给汇总，不列原文）；需要文件时，可从 `dbPath` 指向的 SQLite 数据库 `facts` 表读取 `statement` 字段，或直接复制整库文件。复制前建议停止插件，避免漏掉 WAL 中的数据。

### 主动消息为什么没来？

依次检查：当前是否处于安静时段（默认 23:00–08:00）、今日是否已达 `proactiveDailyCap`、同类消息是否在去重窗口内、积压是否已达上限。把 `proactiveDailyCap` 设为 `0` 会完全关闭主动消息。

### 线程为什么被拒绝或冻结？

同时活跃的线程最多 6 个（`threadMaxActive`），超过后新建会被拒绝；`key=new` 时必须提供 `name`。线程空闲超过 14 天（`threadIdleDays`）会被归档冻结，再次使用同一 key 时会自动重新激活。

### 数据存在哪里？

默认在插件工作目录的 `.data/companion.db`（可通过 `dbPath` 修改），包含 `-wal`、`-shm` 附属文件。平台自己的会话 JSONL 由 DSH 管理，不在本插件数据库内。
