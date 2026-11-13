## v0.4.13 新增能力（开发分支，未发布）

这一节只列 v0.4.13 新增、需要手动配置或会改变可观测行为的项。默认配置下行为与
v0.6.1 一致；schema 从 v14 升到 v15，首次启动会自动迁移（旧库请先备份）。

### token 账本（A1）

配置（可选，均可省略）：

```yaml
budget:
  dailyHardLimit: 3000000   # 每日硬上限，只防失控；100000..1e12
  window5hLimit: null       # 预留 5 小时窗口；null 表示不启用
```

每次模型调用都会落一行 `token_usage`：来源分 `main` / `consolidate` / `smalltalk` /
`embedding` / `task` / `thread` / `appraise`，并记录峰值/谷值（本地 00:30–08:30 记
`offpeak`）。`/状态` 会多一行「今日用量：… （主会话 a% / 巩固 b% / …）｜缓存命中 M」。
计数写库，重启不清零。`thread` 来源当前尚未入账（`thread_run` 没有可采样的会话对象），
其余六类都已接线。

### 后台额度闸门（A2）

```yaml
quota:
  source: file             # none（默认）| file
  path: /opt/dsh-companion-home/quota.json
  reserve: { '5h': 0.30, '7d': 0.20, month: 0.10 }
```

快照文件格式（时间戳都是 **Unix 秒**）：

```json
{
  "updatedAt": 1794373643,
  "windows": [
    { "name": "5h", "remaining": 120000, "limit": 400000, "resetAt": 1794380000 },
    { "name": "7d", "remaining": 900000, "limit": 5000000 },
    { "name": "month", "remaining": 3000000, "limit": 12000000, "resetAt": 1797000000 }
  ]
}
```

`updatedAt` 超过 15 分钟没更新视为过期，闸门退回 `none`。任一窗口剩余低于预留线时
只暂停后台（非 hard 巩固、闲聊、向量回填），主会话、hard 巩固与压缩不受影响；`/状态`
显示「额度紧张，后台暂停至 HH:MM」。模型返回 429 或额度类错误时按 `resetAt` 退避，
没有 `resetAt` 就指数退避，不做高频重试。

### 压缩迟滞（A6）

```yaml
compact:
  minIncrementTokens: 4096  # 压完之后至少再涨这么多才允许下一次阈值压缩
  cooldownTurns: 3          # 两次阈值压缩之间至少隔几轮（hard/idle 不受限）
```

压缩成功后会把「压完的实际 token 数」记到 `schema_meta` 的 `compact_floor:<scope>`。
阈值压缩要同时满足：超阈值计数 ≥2、`tokens >= compactAtTokens`、`tokens >= floor +
minIncrementTokens`、距上次阈值压缩 ≥ `cooldownTurns` 轮。`/状态` 会显示压缩底；
如果压缩底本身就高于 `compactAtTokens`，会追加「压后仍超目标，建议 calibrate」。

### 重复提醒（A4）

`reminder_add` 新增 `rrule` 参数，支持 `FREQ=DAILY`、`FREQ=WEEKLY;BYDAY=MO,TH`
（可带 `INTERVAL`）、`COUNT`、`UNTIL`；其它（如 `BYMONTHDAY`）返回
`{ "ok": false, "reason": "rrule_unsupported" }`。投递成功后按**原定序列**推进到下一次
（不按投递时间顺延），跨 DST 不漂移；停机错过多次只补最近一次，其余计入 missed。
`COUNT`/`UNTIL` 耗尽后系列自然结束。状态板与 `/线程` 列表会显示「每天 08:00」这类节奏。

### 过期提醒通知（A5）

重试用尽被置为 `expired` 的提醒，会在你下一次说话时收到一条一次性说明：

```
有 2 条提醒未能按时送达：
- 交电费（原定 11-13 09:00）
- 拿快递（原定 11-12 18:30）
```

每条只告知一次（写 `expired_notified_at`），重启不会重复；重复提醒系列里某一次失败
只告知那一次，系列继续。

### 记忆质量：注入/使用计数与降权（A8①②）

```yaml
recall:
  unusedThreshold: 3   # 连续注入多少次还没被用上就降权（1..100）
  unusedPenalty: 0.85  # 降权系数（0..1），默认打八五折
```

注入记 `injected_count`、被复述命中记 `used_count`（治理去重按 `used_count` 比较质量）。
连续注入未用满 `unusedThreshold` 次的事实，召回分数乘 `unusedPenalty`。老库迁移时
`recall_count` 会并入 `used_count`。

### 闲聊轮生活类召回条数（A8⑥）

```yaml
recall:
  chatLimit: 1   # 闲聊轮最多注入几条生活类事实（0..5）
```

### IM 信封不算用户正文（A7）

dsh-im 会把 `<dsh_im_source>` / `<dsh_im_reply_to>` 作为独立 `user` 消息注入，现已在
选取「用户正文」时统一跳过（`source.kind` 以 `plugin:` 开头且 `form: 'notice'`，或正文
以 `<dsh_im_` 开头）。这样交互日、隐私提示、命令提示、确认强化、情绪判定与召回查询都
不会把信封当成人说的话。排查时可设 `DSH_COMPANION_MIRROR_DEBUG=1`，每轮会多一行日志，
只记消息 id / 长度 / 是否跳过信封，不记正文。

### v14 → v15 迁移

新表 `token_usage`；`facts` 增 `injected_count` / `used_count` / `unused_streak`（旧
`recall_count` 迁入 `used_count`）；`reminders` 增 `expired_notified_at` / `series_index`；
`facts.kind` 扩 `lifestyle` / `mood`，`memory_events.action` 扩 `govern` / `EDIT` / `scrub`
（两张表都会重建并保留 rowid，`fact_vectors` 不会被级联删除）。迁移在同一个事务里完成，
失败会回滚到 v14。升级前请备份 `companion.db` 连同 `-wal`、`-shm` 文件。
