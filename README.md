# dsh-companion

> 珞然：给一个人的长期记忆管家。单主会话 + 少量线程，记忆留在本机，不跨设备同步。

`dsh-companion` 是 DeepSeek Harness（DSH）的私人管家记忆插件。它把对话沉淀为事实、提醒与线程，按遗忘曲线检索，并在合适的时间主动提醒。当前版本 `0.1.0`，覆盖 MVP 范围。

## 环境要求

- Node.js `>= 24`（使用内置 `node:sqlite`，会打印 ExperimentalWarning）
- 零第三方依赖，不需要 `npm install`
- 数据默认写入工作区 `.data/companion.db`

## 安装与启用

把本仓库放进 DSH 工作区，在所用 profile 的 `cordis.patch.yml` 中加入插件行（配置文件位置以本机 DSH 安装为准）：

```yaml
- insert:
    - id: dsh-companion
      name: 'dsh-companion'
      config:
        dbPath: ./.data/companion.db
```

本地开发时，`name` 可指向本目录的绝对路径。改完重载 profile 生效。

## 配置

| 配置键 | 默认值 | 含义 | 范围 / 约束 |
| --- | --- | --- | --- |
| `workingMemoryTokens` | `32000` | 工作记忆装配上限（token） | 正整数 |
| `compactAtTokens` | `24000` | 连续两轮超过后触发巩固 | 正整数 |
| `compactHardTokens` | `40000` | 安全阀阈值 | 正整数 |
| `retainTokens` | `6144` | 压缩时保留的最近对话尾部 | 正整数 |
| `threadIdleDays` | `14` | 线程空闲多少天后冻结 | `>= 1` |
| `threadMaxActive` | `6` | 同时活跃的线程上限 | `>= 1` |
| `proactiveDailyCap` | `3` | 每日主动消息上限 | `>= 0`，`0` 关闭主动 |
| `quietStart` | `"23:00"` | 安静时段开始 | `HH:MM` |
| `quietEnd` | `"08:00"` | 安静时段结束 | `HH:MM` |
| `purgeAfterDays` | `7` | 遗忘冷静期，到期物理删除 | `1`–`30` |
| `dbPath` | `"./.data/companion.db"` | SQLite 数据库路径 | 非空字符串 |

token 四档必须满足 `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens`。未知配置键只记警告，不阻断启动。

## 命令与工具

命令：`/记忆`、`/记忆 忘掉`、`/记忆 置顶`、`/记忆 取消置顶`、`/成本`、`/线程`、`/状态`。

工具：`memory_search`、`memory_write`、`memory_forget`、`reminder_add`、`reminder_done`、`thread_list`、`thread_run`、`cost_report`。

参数、示例与返回见 [docs/usage.md](docs/usage.md)。

## 记忆与遗忘

- 工作记忆按 32K 装配；超过 24K 连续两轮触发巩固，40K 为安全阀，压缩保留最近 6,144 token。
- 检索使用 bigram FTS 与遗忘曲线四档（full / gist / index / dormant），MVP 不含向量检索。
- `/记忆 忘掉` 只做标记；7 天冷静期内仍可恢复，到期由每日 03:30 的清理任务物理删除。
- 被遗忘、被取代或标记为 secret 的内容不会被召回；此时珞然会直接说「不记得了」，不编造。

## 隐私与限制

- 所有记忆存在本机 SQLite，不跨设备备份，也不上传到第三方。
- 平台管理的会话 JSONL 由 DSH 负责，插件无法删除；插件只清理自己的数据库。
- 主动消息受安静时段、每日上限、同类去重与积压上限约束。
- 单人、单主会话模型；线程是隔离的长期任务空间，不是多人协作。

## 开发与测试

```bash
cd dsh-companion
node --test
```

当前测试：250 个用例、15 个套件。插件入口为 `src/index.js`。

## 设计文档

- [记忆系统设计](../memory/docs/06-记忆系统设计.md)
- [架构设计](../memory/docs/05-架构设计.md)
- [人格系统](../memory/docs/09-人格系统.md)
- [主动性与轻任务](../memory/docs/10-主动性与轻任务.md)
- [平台 API 摘录](docs/platform-api.md)
- [开发规划](../memory/开发规划-v2.md)
- [变更记录](CHANGELOG.md)
