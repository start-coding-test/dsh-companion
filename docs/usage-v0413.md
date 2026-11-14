## v0.4.13 新增能力（开发分支，未发布）

这一节只列 v0.4.13 新增、需要手动配置或会改变可观测行为的项。默认配置下行为与
v0.6.1 一致；schema 从 v14 升到 v15，首次启动会自动迁移（旧库请先备份）。

### token 账本（A1）

配置（可选，均可省略）：

```yaml
budget:
  dailyHardLimit: 3000000   # 每日硬上限，只防失控；100000..1e12
  window5hLimit: null       # 5 小时滑窗硬上限；null 表示不启用
```

每次模型调用都会落一行 `token_usage`：来源分 `main` / `consolidate` / `smalltalk` /
`embedding` / `task` / `thread` / `appraise`，并记录峰值/谷值（本地 00:30–08:30 记
`offpeak`）。`/状态` 会多一行「今日用量：… （主会话 a% / 巩固 b% / …）｜缓存命中 M tokens」。

`budget.window5hLimit` 非空时，另外用 `token_usage` 表按 5 小时滑窗求和；任一条到线上都会点亮 `budgetTripped`（与日上限同一套后台闸门）。
计数写库，重启不清零。当前已接线五类：`main` / `consolidate` / `smalltalk` / `task` /
`appraise`；`embedding` 与 `thread` 尚未入账（本地 embedding 不产生模型结算，
`thread_run` 没有可采样的会话对象），落库时这两类为空是预期行为。

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

冷却计数只在**新轮**推进（工具尾的 pre-step 不算），写进 `schema_meta` 的
`compact_threshold_turns:<scope>`，重启后继续生效，不会因重启绕过。
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
`COUNT`/`UNTIL` 耗尽后系列自然结束。`UNTIL=YYYYMMDD` 按**配置时区**当地日末解释（`20261120` = 当地 11-20 23:59:59），时刻形态 `...T081500Z` 仍按 UTC。状态板与 `/线程` 列表会显示「每天 08:00」这类节奏。

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

dsh-im 有两种形态，插件都要处理：

1. **独立 notice 消息**：`source.kind` 以 `plugin:` 开头且 `form: 'notice'`，正文只有信封；
2. **合并消息**（V71-H1）：信封和正文在同一条 `user` 消息里，`source.kind='user'`，正文形如
   `<dsh_im_source>{…}</dsh_im_source>\n\n我在`。

选取「用户正文」时，先按同名闭合标签**逐个剥掉开头**的 `<dsh_im_*>` 信封（source、reply_to
等），剩下的才是用户说的话；只有剥完为空才算 notice。这样合并消息不会再把正文一起丢掉，
交互日、隐私提示、命令提示、确认强化、情绪判定、过期通知与召回查询都读得到正文；转录
（`captureTranscript`）记录的也是剥掉信封后的正文。正文中间出现的字面 `<dsh_im_` 不受影响。

排查时可设 `DSH_COMPANION_MIRROR_DEBUG=1`，每轮多一行日志：消息条数、被跳过的 notice 条数、
被剥掉的信封块数、查询长度与来源 id，不记正文。

### v14 → v15 迁移

新表 `token_usage`；`facts` 增 `injected_count` / `used_count` / `unused_streak`（旧
`recall_count` 迁入 `used_count`）；`reminders` 增 `expired_notified_at` / `series_index`；
`facts.kind` 扩 `lifestyle` / `mood`，`memory_events.action` 扩 `govern` / `EDIT` / `scrub`
（两张表都会重建并保留 rowid，`fact_vectors` 不会被级联删除）。迁移在同一个事务里完成，
失败会回滚到 v14。升级前请备份 `companion.db` 连同 `-wal`、`-shm` 文件。

### v0.7.1 修复（V70-M1 / V70-M2 / V70-L2）

- **过期通知的正文判定**：`injectExpiredNotices` 不再自己解析消息形状，改由 `src/index.js` 传入
  `lastUserText` 的结果。于是 runtime-context 快照、`companion-*` 注入、以及插件自己投递的
  `[提醒] …`（`source.kind='user'` + `rpcId=companion-*`）都不算用户正文；没有正文时也不会
  占用本轮 `turnSeen`，投递回合不会把过期提醒标成已告知。
- **同义偏好去重**：`preference` / `lifestyle` 类事实按 kind 取最近 N 条活跃事实作为候选，
  不再要求 `subject_text` 在对话里字面出现（用户说「我」、库里写「用户」）；同一 subject 的多条
  全部交给模型，由它选一条带 `supersedes` 整条改写。N 由 `consolidate.existingFactsLimit`
  控制（默认 12，合法 1..50）：

  ```yaml
  consolidate:
    existingFactsLimit: 12
  ```

  其它 kind（`project` / `identity` 等）仍按「subject_text 字面出现在本段对话里」挑选；
  召回快照与压缩摘要段的排除规则不变。
- **排障日志**：`DSH_COMPANION_MIRROR_DEBUG=1` 的日志位置前移到 query 之后，召回为空也有记录。

### v0.7.2 热修（V71-H1）

IM 合并消息（信封 + 正文同一条 `user` 消息）此前被整条当成信封丢弃：召回查询为空、情绪判定
与过期通知都不触发。现在改为「剥离信封后取正文」，规则见上一节；`source` 判定保持原样。

- 新增 `stripImEnvelopes(text)`：反复剥离开头的 `<dsh_im_xxx>…</dsh_im_xxx>` 块及其后空白；
  开头是 `<dsh_im_` 但找不到闭合标签时视为整段信封；正文中间出现的标签不动。
- `isPluginNotice` 的文本兜底改为「剥离后为空才算信封」；`source` 判定不变。
- `textRows` 对 user 文本块先剥离再入行；`lastUserText` 不再按 `<dsh_im_` 前缀跳过整条。
- mirror debug 增 `strippedEnvelopes`（本批被剥掉的信封块数）。

行为不变：只有信封的消息仍然跳过；转录继续不含信封（V70-L1 的决定未变）。

### v0.7.3 热修（V72-H1）

dsh-im 在「引用回复 / 带附件」时会把信封拆成独立块，追加在正文块之前，例如一条 user 消息有
三个文本块：`<dsh_im_source>…</dsh_im_source>`、`<dsh_im_reply_to>…</dsh_im_reply_to>`、正文。
旧逻辑逐块判定，任一信封块剥空就整条判为 notice，正文一起丢失。

现在的判定是「整条消息」：所有文本块（以及 `message.text`）逐个剥离后全部为空，且至少剥掉
一个信封，才算 notice；只要有一块留下正文，这条消息就按用户发言处理。`textRows` 仍逐块剥离，
因此多块形态下只有正文块进入召回查询、情绪判定、过期通知与转录；`reply_to` 里的被引用原文
属于信封内容，不会进入转录。

旧形态完全不变：独立 notice 消息（`source.kind='plugin:dsh-im'` + `form:'notice'`）、单块
「信封\n\n正文」、以及正文中间出现的字面 `<dsh_im_` 都按原样处理。
