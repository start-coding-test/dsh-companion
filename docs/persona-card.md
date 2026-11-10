# 人格卡（persona card）

角色由人格卡定义；内置卡「珞然」只是出厂默认。卡是纯 JSON（UTF-8，无注释、无尾逗号），
放在 `DSH_HOME` 下或用绝对路径，配置 `persona.cardPath` 指向它。

```yaml
persona:
  cardPath: persona.json
```

插件只在 `apply` 时读一次，**改完要重启宿主**。

## 1. 两种来源

| 来源 | 形状 | 说明 |
| --- | --- | --- |
| 原生卡 | 顶层直接写字段（见 §2） | 支持 `{{char}}` / `{{user}}` 占位符 |
| CCv2 / CCv3 卡 | `{ "spec": "chara_card_v2", "data": { … } }` | 按 §3 映射；`character_book` 忽略并记一条 warning |

原生字段**深合并**（只写要改的子键），**数组整体替换**（`values` / `taboos` / `bannedPhrases`），
所以想保留默认项要自己复制进去。

## 2. 原生字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 角色名，非空字符串 |
| `address` | 是 | 对用户的称呼，非空字符串（常用「你」） |
| `version` | 否 | 整数，`/状态` 里显示 |
| `description` | 否 | 身份 / 背景 / 形象，进 `persona:core` |
| `personality` | 否 | 性格要点，进 `persona:core` |
| `scenario` | 否 | 关系与场景，进 `persona:core` |
| `mes_example` | 否 | 示例对话；`<START>` 当分隔符（替换为空行），进 `persona:voice` |
| `first_mes` | 否 | 预留，当前不渲染 |
| `post_history_instructions` | 否 | 预留，当前不渲染 |
| `chatIdentity` | 否 | 闲聊提示词首句，默认「你是用户的私人助手{{char}}，称呼用户为「{{user}}」。」 |
| `tone` | 是 | `{style, warmth, structure, notes?, voice?}`；`voice` 是说话方式，进 `persona:voice` |
| `relation` | 否 | `{butler, friend}`，0–1 |
| `proactive` | 否 | `{dailyCap, chatPerDay, quietStart, quietEnd}`；与配置重复时**以配置为准**并 warn |
| `values` / `taboos` / `bannedPhrases` | 否 | 字符串数组；`taboos` 为空时「禁区」整行省略 |
| `memoryCitation` | 否 | `explicit`（默认，引用记忆说来源与时间）/ `natural`（日常自然化用） |
| `emotion` | 否 | 见 §4 |

## 3. CCv2 / CCv3 映射

`data.description` → `description`，`data.personality` → `personality`，`data.scenario` → `scenario`，
`data.mes_example` → `mes_example`，`data.first_mes` → `first_mes`，
`data.post_history_instructions` → `post_history_instructions`，
`data.name` → `name`，`data.extensions.address`（可选）→ `address`，缺省「你」。

`{{char}}` / `{{user}}` 在**渲染输出时**替换成 `name` / `address`，卡内原文保留。
`character_book` 不读、不打印，只记 `character_book_ignored` warning。

## 4. 情绪（默认关闭）

```json
"emotion": {
  "enabled": true,
  "baseline": { "pleasure": 62, "arousal": 38, "dominance": 45, "energy": 55 },
  "halfLifeHours": 6
}
```

- `enabled` 默认 `false`。关闭时**不读也不写**情绪表，注入与 `/状态` 行都保持原样。
- 四个维度 0–100；`halfLifeHours` 取值 0.5–168（默认 6），按半衰期向 `baseline` 回归。
- 启用后每轮在**用户消息尾部**注入一句「你此刻：……」——只影响语气，不写进 system，
  也不出现任何数字；它不进记忆、不进摘要。
- 非法值不会让整张卡加载失败：逐项回落默认并记 warning
  （`emotion_invalid` / `emotion_enabled_invalid` / `emotion_baseline_invalid` / `emotion_half_life_invalid`）。

「忘掉」会把该会话的情绪状态与事件一起清掉。

## 5. 长度与截断

| 段 | order | 上限（码点） | 内容 |
| --- | --- | --- | --- |
| `persona:safety` | 80 | 250 | 安全底线，**卡片无法修改** |
| `persona:core` | 90 | 1200 | 身份 / 性格 / 关系 / 语气 / 价值观 / 禁区 |
| `persona:voice` | 95 | 1200 | 说话方式 + 示例对话（两者都非空时都在） |
| `persona:protocol` | 150 | 400 | 记忆协议，`memoryCitation='natural'` 时只换第二行 |

超长按码点截断，并写一条 `section_truncated` warning（含段名、实际长度与上限，不含正文），
在插件日志里能看到。

## 6. 完整示例

`examples/persona-lan.json` 是一张可直接用的「温柔大姐姐」卡：把
`description` / `personality` / `scenario` / `mes_example` / `first_mes` /
`post_history_instructions` / `tone.voice` / `emotion` 都填满了，`memoryCitation` 用 `natural`。
复制成 `persona.json`、配上 `persona.cardPath` 就能用。

## 7. 出错时

`/状态` 会显示三种来源之一：

```text
人格卡：珞然 v1（内置默认）
人格卡：岚 v2（/opt/dsh-companion-home/persona.json）
人格卡：珞然 v1（加载失败，已用内置：文件不存在（ENOENT）：/opt/dsh-companion-home/persona.json）
```

加载失败不退出：回落内置卡 + 一条 warn。JSON 语法错误只报告**位置与类别**
（例如「第 3 行第 12 列：字符串未闭合」），不会把卡正文回显到日志或 `/状态`。
