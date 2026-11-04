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

把活跃事实、情景、提醒、线程与状态板导出到 `.data/export/memory-YYYY-MM-DD-HHmmss.<fmt>`（缺省 `json`，文件名为 UTC 秒级时间戳；同一秒内重复导出自动追加 `-2`、`-3`，不覆盖已有文件），并在回复里给出各表条数与路径：

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

没有线程时返回 `线程目录：暂无。`。

### `/状态`

查看各表计数、FTS 行数、主作用域水位与最近一次定时任务：

```text
/状态
状态：entities 8 / episodes 120 / facts 96 / reminders 4 / state_board 2 / state_board_rev 9 / threads 3 / consolidations 21 / memory_events 310 / fts facts 96/episodes 120 / tokens 本轮 入 8000 出 1200（超预算 0 次）｜今日 0/3000000｜RSS ok 128MB｜向量：关
RSS 阈值：warn 2.95GiB / stop 3GiB / main_only 3.15GiB
水位 main：120
最近 job：s2-purge ok upto_seq=0（2026-11-03 03:30）
```

最后一段 `tokens 本轮 …` 是当前轮工作记忆的 token 快照（入 = 上下文总量，出 = 本轮新增）；没有 `tokenMeter` 能力时显示 `tokens 本轮 0`，不影响其它计数。`向量` 段在开启可选向量召回后变为「向量：开·dim 256·hash:256·已回填 N·最近命中 N」（local/remote 显示各自 id 与回填计数）。第二行「RSS 阈值」是当前生效的三档值，来自 `rssWarnGiB`/`rssStopGiB`/`rssMainOnlyGiB`（默认 2.95/3/3.15GiB，4G 机器建议 2.2/2.4/2.6，见[配置示例](#配置示例)）。

`/状态` 末尾还会给出自愈观测（无事件时显示「无」）：

```text
最近失败：巩固失败：provider 超时（2026-11-04 09:12）
最近重试：重试 第 2 次（2026-11-04 09:13）
最近 job 失败：s2-purge job_error：database is locked（2026-11-04 03:30）
```

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
- `session-unavailable`：宿主没有 `sessionController.createSession`。
- `unarchive-unavailable`：复用已归档线程，但宿主没有 `workspaceRegistry.unarchiveSession`。
- `prompt-unavailable`：宿主没有 `sessionController.prompt`，无法投递目标。

#### 执行槽：`thread_run` 与 `task_run` 共用

`thread_run`（带 `goal`）和 `task_run` 共用同一个执行槽（全局 1 个），但忙时行为
不同，这是有意的差异：

- `thread_run`：槽被占用时立即返回 `{ "ok": false, "reason": "busy" }`，不排队。
- `task_run`：槽被占用时排队（最多 2 个），队列满才返回 `busy`。

主会话收到 `thread_run` 的 `busy` 时，应告诉用户「正在执行上一个任务，稍后继续」，
不要立刻重试或改用其他工具抢占执行槽。

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
- 宿主没有 `sessionController` 时返回 `{ "ok": false, "reason": "session-unavailable" }`。
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

导出覆盖 facts / episodes / reminders / threads / 状态板；文件里的 `version` 恒为 1，`scope` 记录导出所用作用域。

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

- `fresh`：目标库五张表必须为空（`Store.open` 建出的空状态板占位行不算），适合新机器或重建。
- `merge`：按主键跳过已存在的行（facts.id / threads.key / reminders.id 等），不覆盖本地已有内容。
- 整个导入在单事务内，任一行失败整体回滚；导出集中缺失的引用（`consolidation_id` / `source_episode_id` / `superseded_by`）置 null；恢复后逐行重建 facts / episodes FTS。

### 加密（单条事实）

```bash
node scripts/export-encrypted.mjs .data/companion.db 12 --out secret.enc
node scripts/decrypt-encrypted.mjs secret.enc --out fact.json
```

- 口令只从 stdin 读取（TTY 下关闭回显）；空口令、缺 `--out`、事实不存在都以退出码 1 失败。
- 解密先校验再写文件，错误口令、损坏文件或认证失败不会留下明文半文件；错误统一为「解密失败（口令错误、文件损坏或认证失败）」。
- 格式：AES-256-GCM + scrypt（N=2^14、r=8、p=1），随机 salt(16B) / iv(12B)，magic `DSH-COMPANION-EXPORT-1` + JSON header 保存 KDF 参数与 tag。`header.format = "v2"` 起 header 与 magic 行一起作为 AAD 认证，篡改 header / 密文 / tag 都会失败；`v1` 旧文件仍可解，新导出建议用 v2。

### 向量召回（可选）

默认 `vector.enabled=false`：检索与 v0.2.0 逐字节一致，不读 `fact_vectors`。开启后 `hybridSearch` 用 RRF（`1/(60+rank)`）融合 FTS 与向量，同一 fact 去重；向量路只召回 active、normal、未删除、非 `sensitive`/`secret` 且 R ≥ 0.05 的事实。`vector.embedder` 支持 `hash`（默认，字符 bigram 哈希投影）、`local`（可选安装 `@huggingface/transformers`，默认 bge-small-zh-v1.5 512 维）与 `remote`（默认关闭，显式 `vector.remote.enabled: true` 才启用；隐私例外见 [embedding.md](embedding.md)）。离线对比可跑：

```bash
node scripts/bench-vector.mjs --dim 256 --json
```

旧库升级到 schema v6 会给 `fact_vectors` 增加 `embedder_id` 并把旧行标成 `hash:<dim>`；hash 在下次写入 / 编辑 / 强化时重建，local/remote 的缺失向量由 idle-probe 每批 ≤ `vector.backfillBatchSize`（默认 50）回填，期间开启向量只是暂时召回不到它们，不会报错。

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

2C4G 云端把 RSS 三档下调到预算 2.5GiB 以内（公式 `min(userLimit, totalmem×0.75−512MiB)`；
三档须递增且不超过总内存 75%，4GiB 即 3.0GiB）：

```yaml
rssWarnGiB: 2.2
rssStopGiB: 2.4
rssMainOnlyGiB: 2.6
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
- 无 `sessionController`：`task_run` 返回 `session-unavailable`；`/记忆 导出` 仍可用（只读库）。
- `vector.embedder: none`、`enabled: false` 或 remote 未显式 `remote.enabled: true`：检索退化为 bigram FTS，与旧版一致；`/状态` 显示「向量：关」。

### 工具错误

- 参数非法：抛 `TypeError`，消息带工具名与字段名；调用方修正后重试。
- 业务失败：返回 `ok:false` 加 `reason`（如 `not-found`、`not-active`、`too-many-threads`、`cwd-unavailable`）。
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

先确认 `vector.enabled: true`（默认关闭）且 `/状态` 显示「向量：开·dim X·<embedder id>·已回填 N·最近命中 N」。`hash` 只是字符 bigram 哈希投影，不是语义 embedding，中文同义改写召回有限；`local` 需要可选安装 `@huggingface/transformers` 并首次联网下载模型；`remote` 需要显式 `remote.enabled: true` 且 endpoint 可达。旧库升级到 schema v6 后旧向量按 `embedder_id` 隔离，等待写入或 idle-probe 回填；embedding 失败会在日志里出现 `embedding failed; falling back to FTS`。

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
v0.4.0 起 `schema_version=6`：`fact_vectors` 增加 `embedder_id`，旧向量行回填为 `hash:<dim>`（v4→v6 会在建表后直接推进版本）。

### 数据存在哪里？

默认在插件工作目录的 `.data/companion.db`（可通过 `dbPath` 修改），包含 `-wal`、`-shm` 附属文件。平台自己的会话 JSONL 由 DSH 管理，不在本插件数据库内。
