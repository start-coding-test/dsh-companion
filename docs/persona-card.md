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
| 原生卡 | 顶层直接写字段（见 §2） | 支持 `{{char}}` / `{{user}}`；其它占位符降级、HTML 注释剥离（§4） |
| CCv2 / CCv3 卡 | `{ "spec": "chara_card_v2", "data": { … } }` | 按 §3 映射；`character_book` 忽略并记一条 warning |

原生字段**深合并**（只写要改的子键），**数组整体替换**（`values` / `taboos` / `bannedPhrases`），
所以想保留默认项要自己复制进去。

## 2. 原生字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 角色名，非空字符串 |
| `address` | 是 | 对用户的称呼，非空字符串（常用「你」） |
| `version` | 否 | 整数，`/状态` 里显示 |
| `description` | 否 | 身份 / 背景 / 形象，进 `persona:core`；用户卡还会以「人设要点」进闲聊提示词（内置卡不追加） |
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
| `emotion` | 否 | 见 §5 |

## 3. CCv2 / CCv3 映射

`data.description` → `description`，`data.personality` → `personality`，`data.scenario` → `scenario`，
`data.mes_example` → `mes_example`，`data.first_mes` → `first_mes`，
`data.post_history_instructions` → `post_history_instructions`，
`data.name` → `name`，`data.address`（可选，优先）或 `data.extensions.address`（可选）→ `address`，缺省「你」。

`{{char}}` / `{{user}}` 在**渲染输出时**替换成 `name` / `address`，卡内原文保留；凡进入提示词的字段都走这一步（含 `tone.style` / `tone.warmth` / `tone.structure` / `tone.voice` / `tone.notes` / `values` / `taboos` / `bannedPhrases` / `description` / `personality` / `scenario` / `mes_example` / `chatIdentity`）。
`character_book` 不读、不打印，只记 `character_book_ignored` warning。

其余 `{{...}}` 占位符与卡里的 HTML 注释怎么处理，见 §4。

## 4. 模板占位符与 HTML 注释

**只认两个占位符**：`{{char}}` → `name`、`{{user}}` → `address`，在**渲染输出时**替换，
卡内原文保留。

其余 `{{...}}`（酒馆 / SillyTavern 扩展，例如 `{{random:a,b}}`、`{{time}}`、`{{original}}`、
`{{model}}`）**不支持**：

- **渲染期降级**：渲染时把残留的 `{{...}}` 改写成单花括号 `{...}`（`{{time}}` → `{time}`、
  `{{random:a,b}}` → `{random:a,b}`），保证进提示词的文本里没有 `{{`。原因是宿主
  dsh-system-prompt 的插值器对未注册变量**整轮抛错**（不是忽略），未知占位符原样交出去
  会让当轮装配直接失败。半截 `{{`（后面没有 `}}`）也会兜底成 `{`。
- **加载期告警**：卡加载时若发现会被降级的占位符，记一条 `template_placeholder_downgraded`
  warning；`detail` 里只有占位符**名字**（去重、按出现顺序），不含正文——warning 会进日志，
  不能把卡内容带出去。
- **宿主不二次插值**：`persona:*` 段注册时带 `interpolate: false`，宿主原样使用这些文本；
  `persona.shadowDeployment: rewrite` 替换后的段同样标记为不插值（见 [persona-shadow.md](persona-shadow.md)）。

**HTML 注释**：`<!-- ... -->`（非贪婪、可跨行、可多处）在**卡加载时**从所有文本字段剥离，
不进上下文。覆盖 `description` / `personality` / `scenario` / `mes_example` / `first_mes` /
`post_history_instructions` / `chatIdentity`、`tone.*`、`values[]` / `taboos[]` /
`bannedPhrases[]`。渲染函数里还有一层兜底剥离，防止运行期拼进来的文本带注释。

- 未闭合的 `<!--` **保守原样保留**（宁可留下注释，也不吞掉后面的正文），并记一条
  `html_comment_unterminated` warning；`detail` 是字段路径（如 `["description"]`）。
- 注释剥完为空、而该字段本身必填（如 `tone.style`）时，按空字段报错——别把必填内容整段
  写进注释。
- 内置卡既没有多余占位符也没有注释，所以 v0.5.1 的渲染输出与 v0.5.0 逐字节一致。

**不支持的酒馆扩展**：`character_book`（世界书）直接忽略，只记 `character_book_ignored`；
`{{random}}` / `{{pick}}` / `{{time}}` / `{{time_UTC}}` / `{{original}}` 等都不会真的求值，
只会被降级成字面量 `{random}` / `{pick}` / `{time}` …… 模型看到的是普通文本。

## 5. 情绪（默认关闭）

```json
"emotion": {
  "enabled": true,
  "baseline": { "pleasure": 62, "arousal": 38, "dominance": 45, "energy": 55 },
  "halfLifeHours": 6
}
```

- `enabled` 默认 `false`。关闭时**不读也不写**情绪表，注入与 `/状态` 行都保持原样。
- 四个维度 0–100；`halfLifeHours` 取值 0.5–168（默认 6），按半衰期向 `baseline` 回归。`baseline` 缺省继承内置卡 `{50,50,50,60}`；写了但不合法（非对象 / 任一维非 0–100 有限数）时回落**同一组值**并给 `emotion_baseline_invalid` warning。
- 启用后每轮在**用户消息尾部**注入一句「你此刻：……」——只影响语气，不写进 system，
  也不出现任何数字；它不进记忆、不进摘要。
- 非法值不会让整张卡加载失败：逐项回落默认并记 warning
  （`emotion_invalid` / `emotion_enabled_invalid` / `emotion_baseline_invalid` / `emotion_half_life_invalid`）。

「忘掉」会把该会话的情绪状态与事件一起清掉。

### 5.1 情绪怎么判定（v0.5.2）

规则、不调模型、不升 schema。一句话先判**对象**再判**极性**：

| 对象 | 判定方式 | 负面话落到 |
| --- | --- | --- |
| 她 | `你` / `您` / 卡里的 `name`（从卡读，不写死） | `blame`（轻度指责 `你怎么又忘了` 置信度更低）、`conflict` |
| 用户自己 | `我` / `俺` / 无主语 | `vent`（用户诉苦，她不跟着低落） |
| 第三方 | `他` / `她` / `这个人` / `老板`… | `vent` |
| 事物 | `这破…` / `工作` / `加班` / 天气… | `vent` |

- **否定与疑问守卫**：负面词前 5 字内有「不/没/别/甭」时极性反转（`你一点都不烦` → 关心）；
  `不过`/`不但`/`不仅` 是连词不算否定（`谢谢你，不过你好烦` 仍是指责）。
  `你是不是…烦我`、`我…你了吗` 是用户在担心，走 **`reassure`**（被在意，愉悦小升）。
- **边界词收紧**：`辛苦` 只有「你辛苦了 / 辛苦你 / 辛苦啦」算谢谢；`哦/行吧/随便/算了`
  只在整句 ≤ 4 码点时算冷淡；`睡了` 只认句末（`睡了一下午` 不算晚安）；`烦不烦` 遇
  「不烦不烦」不算冲突。
- **分不出来**：同一句里既有对她的负面又有对她的正面时，置信度降到 `0.45`——**记一条事件
  但不改状态**（`emotion_events` 里能看到，`/状态` 的最近事件也会显示）。
- **增量递减（V51-L1）**：离边界越近推得越轻（往上乘 `(100−x)/50`、往下乘 `x/50`），
  10 分钟内同类事件第 k 次再乘 `0.7^(k−1)`。连续十条「你好烦」不会把愉悦推到 0，
  连续十次夸奖也不会贴到 100；单次事件在基线上的增量与 v0.5.1 相同（±30% 内）。
- 新增 `reassure` 类型；`complain` 退役并入 `vent`（旧库里的历史事件仍可读）。

标注集与混淆矩阵见 [`docs/emotion-report.md`](emotion-report.md)。

## 6. 长度与截断

| 段 | order | 上限（码点） | 内容 |
| --- | --- | --- | --- |
| `persona:safety` | 80 | 250 | 安全底线，**卡片无法修改** |
| `persona:core` | 90 | 1200 | 身份 / 性格 / 关系 / 语气 / 价值观 / 禁区 |
| `persona:voice` | 95 | 1200 | 说话方式 + 示例对话（两者都非空时都在） |
| `persona:protocol` | 150 | 400 | 记忆协议，`memoryCitation='natural'` 时只换第二行 |

超长按码点截断，并写一条 `section_truncated` warning（含段名、实际长度与上限，不含正文），
在插件日志里能看到。

四段注册时都带 `interpolate: false`（v0.5.1）：段文本是卡内容渲染后的产物，宿主不再对它们
做 `{{...}}` 插值，详见 §4。

`persona:state_board` 是唯一例外：它的文本来自记忆里的状态板，不是卡内容，所以既不做
占位符降级也不剥注释；它同样带 `interpolate: false`，宿主不会把它当提示词变量解析。

## 7. 完整示例

`examples/persona-lan.json` 是一张可直接用的「温柔大姐姐」卡：把
`description` / `personality` / `scenario` / `mes_example` / `first_mes` /
`post_history_instructions` / `tone.voice` / `emotion` 都填满了，`memoryCitation` 用 `natural`。
复制成 `persona.json`、配上 `persona.cardPath` 就能用。

## 8. 出错时

`/状态` 会显示三种来源之一：

```text
人格卡：珞然 v1（内置默认）
人格卡：岚 v2（/opt/dsh-companion-home/persona.json）
人格卡：珞然 v1（加载失败，已用内置：文件不存在（ENOENT）：/opt/dsh-companion-home/persona.json）
```

加载失败不退出：回落内置卡 + 一条 warn。JSON 语法错误只报告**位置与类别**
（例如「第 3 行第 12 列：字符串未闭合」），不会把卡正文回显到日志或 `/状态`。
