# v0.4.12 部署清单（人格卡热修）

面向用户侧操作。改动只有人格接线：新增 `persona.cardPath`，启动时读一次卡；schema 仍为 v13，无数据迁移。以下命令假设 `DSH_HOME=/opt/dsh-companion-home`、库为 `${DSH_HOME}/companion.db`；按实际路径替换。

## 1. 备份 v0.4.5 库（含 -wal / -shm）

先停宿主，确保没有写入，再整组复制（三个文件必须同一时刻）：

```bash
cd /opt/dsh-companion-home
stamp=$(date +%Y%m%d-%H%M%S)
cp -p companion.db      "companion.db.bak-$stamp"
cp -p companion.db-wal  "companion.db-wal.bak-$stamp" 2>/dev/null || true
cp -p companion.db-shm  "companion.db-shm.bak-$stamp" 2>/dev/null || true
ls -l companion.db*
```

没有 `-wal`/`-shm` 说明上次已干净关闭，只备份主库即可。不要只拷 `companion.db` 而漏掉 WAL。

## 2. 放人格卡

```bash
cat > /opt/dsh-companion-home/persona.json <<'JSON'
{
  "name": "珞然",
  "address": "你",
  "tone": { "style": "简洁", "warmth": "温和", "structure": "先结论" },
  "version": 2,
  "values": ["诚实：不确定就说不确定"],
  "taboos": ["外貌评价", "收入", "家庭矛盾"]
}
JSON
python3 -m json.tool /opt/dsh-companion-home/persona.json >/dev/null && echo ok
```

只写要覆盖的字段；没写的沿用内置默认，数组整体替换。字段表见 `persona.example.md`。`version` 每次改卡加一，便于 `/status` 核对。

## 3. 配置 cardPath

编辑插件配置（`config.yml`），只加这一项：

```yaml
persona:
  cardPath: persona.json
```

相对路径按 `DSH_HOME` 解析（这里即 `/opt/dsh-companion-home/persona.json`）；也可写绝对路径。不要新增其它键。

## 4. 与宿主模型变更合并成一次重启

把「宿主模型/路由变更」和本次插件升级放在同一次维护窗口：停宿主 → 更新插件到 v0.4.12 → 改配置和卡 → 启动一次。人格卡只在启动时加载，之后改文件不会生效；避免为了卡再单独重启一次。

## 5. 重启后核对

1. 发 `/status`，确认出现：
   `人格卡：<name> v<version>（/opt/dsh-companion-home/persona.json）`
   若显示 `加载失败，已用内置：<原因>`，按原因修文件后重启；失败不会中断对话。
2. 新开一个会话问「你叫什么」，回答应是卡里的 `name`，称呼应是 `address`。
3. 再发一条普通消息，确认召回与状态板正常（人格段与它们同时装配）。

## 6. 评测边界记录

在 `eval-boundary.md` 追加一条「配置变更」：

- 时间：本次重启时刻（与第 4 步同一时间）
- 版本：0.4.12；人格卡路径与 `version`
- 同时发生的宿主模型变更
- 结论：**评测不重新起算**，按该时刻分段统计

## 7. D-5 断点与统计

在 D-5 记录中标注该重启时刻为断点；之后统计按「断点前 / 断点后」分段，不合并解释。

## 回滚

删掉 `persona.cardPath`（或恢复卡文件）后重启即回到内置卡；schema 未变，正常无需回滚数据库。仅在库损坏时用第 1 步备份整组还原（停宿主后同时放回 `companion.db`、`-wal`、`-shm`）。
