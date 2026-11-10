# v0.5.0 部署到 50041（人格 v2 + 情绪）

本版只改「人格/情绪」层：`schema` 由 **v13 自动升到 v14**（新增 `emotion_state` / `emotion_events`
两表，旧数据不动），记忆、提醒、线程、压缩逻辑未改。

- 卡格式与字段：`docs/persona-card.md`
- 遮蔽宿主人设：`docs/persona-shadow.md`
- 完整示例卡：`examples/persona-lan.json`

## 1. 备份（必做）

```bash
cd /opt/dsh-companion-home
sqlite3 companion.db ".backup 'companion.pre-v050.db'"   # 或直接 cp，但要连 -wal/-shm 一起
ls -l companion.db*                                       # 确认 .db / .db-wal / .db-shm 都在
```

## 2. 配置

```yaml
persona:
  cardPath: persona.json        # 相对 DSH_HOME；也可写绝对路径
  shadowDeployment: off         # off（默认）/ rewrite / takeover，见 docs/persona-shadow.md
```

要启用情绪，在**卡里**写：

```json
"emotion": { "enabled": true, "baseline": { "pleasure": 62, "arousal": 38, "dominance": 45, "energy": 55 }, "halfLifeHours": 6 }
```

不写或 `enabled: false` 时行为与 v0.4.12 完全一致（不读也不写情绪表）。

## 3. 升级与重启

和宿主默认模型的改动**合并成一次重启**，避免两次行为变更难以归因：

```bash
systemctl restart dsh-50041        # 按实际单元名
journalctl -u dsh-50041 -n 80 --no-pager | grep dsh-companion
```

首次启动会把库迁到 v14；日志里应能看到 `[dsh-companion] config ok` 与 `scheduler started {"jobs":6,…}`。
迁移不覆盖原库（`Store.open` 就地升级，靠 §1 的备份兜底）。

## 4. 重启后核对

| 检查 | 期望 |
| --- | --- |
| `/状态` 人格卡行 | `人格卡：<name> v<version>（<路径>）`，路径是绝对路径 |
| `/状态` 情绪行 | 启用时：`情绪：<一句自然语言>` + 最近三条；未启用：`情绪：未启用` |
| `/状态` 部署人设行 | `部署人设：宿主默认` / `已替换（人格卡身份）` / `已接管` |
| 新会话问「你叫什么」 | 回 <name>，不是「珞然」或宿主的 coding agent 口吻 |
| 闲聊首句 | 用卡里的 `chatIdentity`，不是「私人助手」 |
| 情绪是否真的在动 | 过一两轮问候/关心后，`/状态` 的情绪句变化，且**不出现数字** |

## 5. 评测断点（必记）

启用情绪会改变语气与提示词，属于**行为变更**：

1. `eval-boundary.md` 追加一条「配置变更」：时间、版本 `0.5.0`、卡路径与 `version`、`emotion.enabled`、
   `shadowDeployment`、以及同批的宿主默认模型变更；注明「评测不重新起算」。
2. `D-5`（评测断点）标记一次，统计按该时刻**前后分段**对比。
3. 若同批还改了模型，两个断点写在同一行，注明「不可分离归因」。

## 6. 回滚

| 现象 | 动作 |
| --- | --- |
| 情绪让语气跑偏 | 卡里 `emotion.enabled` 改回 `false`，重启（不删表，数据留着） |
| 遮蔽宿主人设后模型能力下降 | `persona.shadowDeployment: off`，重启 |
| 人格/情绪整体异常 | 换回上一张卡（或删 `persona.cardPath` 用内置卡），重启；库不用回滚 |
| 库损坏 | 停服 → 用 §1 的 `companion.pre-v050.db` 覆盖 `companion.db` 并删 `-wal`/`-shm` → 启服 |

`emotion_state` / `emotion_events` 是新增表，回滚到 v0.4.12 时会被忽略（旧版本不认识这两张表），
但**不要**在旧版本上再写库，否则新表数据会落后。

## 7. 迁移自检（可选）

```bash
sqlite3 companion.db "select key, value from schema_meta where key='schema_version';"   # 期望 14
sqlite3 companion.db "select count(*) from emotion_state; select count(*) from emotion_events;"
```

情绪未启用时两表应为 0 行；启用后每轮最多 +1 条事件（每 scope 保留最近 50 条）。
