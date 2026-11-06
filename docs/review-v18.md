# v0.4.12 独立复审（review-v18）

- 复审人：reviewer（独立审查者，未参与 t1–t4 实现）
- 复审日期：2026-11-06
- 复审对象：v0.4.11（`08493eb`）→ HEAD `0408c04b0641f733fb3e967d6aafa41a8dd14aa8`，共 5 个提交：
  `6625158`（t1 接线）/ `90e3383`（内置卡参与 proactive 告警）/ `cedb439`（t3 文档）/
  `0c3464e`（t2 单测）/ `0408c04`（t4 集成回归 + 发布门 round A/B）。
- 复审方式：逐文件读 `08493eb..HEAD` 的实现、测试与文档（行号级证据见下）；独立写 7 个探针
  （`D:\test\agent-plugin\.probe-v18\probe{0..7}-*.mjs`，目录在**仓库外**，父目录不是 git 仓库，
  不进工作树；全部写入 OS 临时目录，不读写真实 `~/.dsh`，`~/.dsh` 分支只用 `deps.homedir`
  注入临时目录）；亲跑三时区全量 `node --test`；交叉 grep 接线/常量/文档；用
  `git show 08493eb:src/persona/{sections,card}.js` 在仓库外重建 v0.4.11 基线并真实导入比对
  三段 SHA-256；只读核对团队原始任务卡（`.agent-teams/dsh-companion-r15/team.json`）与宿主
  DSH_HOME 语义（`D:\dsh\resources\app.asar`）。
- 结论：**verdict = needs_revision**（H=0 / M=2 / L=3）。发布前置条件（H=0 且 M=0）**不满足**，
  **不得打 `v0.4.12` tag、不得 push**。两项 M 均为可复现、且违反本次硬验收口径的缺陷，
  修复面很小（各 1 处代码 + 补测试/文档），见 §6。

---

## 1. 结论与计数

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| H（阻断） | 0 | 无崩溃、无数据丢失、无启动失败 |
| M（必修，阻断发布） | 2 | M-1 `~/.dsh` 回退未实现；M-2 坏 JSON 时 warn 泄漏卡正文 |
| L（建议/风险观察） | 3 | 见 §6；不要求本版修复 |

其余全部通过：六条用户要求中 ①②④⑤⑥ 成立，③ 的「四类加载失败均兜底 + warn」成立但
「warn 不含卡正文」被 M-2 破坏；路径三分支中绝对/相对 `DSH_HOME` 成立，未设置回退被 M-1 破坏；
回归面（逐字节等价 / schema 13 / 记忆提醒线程未动 / 零依赖 / 三时区全绿）全部成立。

## 2. 用户六条要求逐条对照

### ① `persona.cardPath` 配置与校验 ✅

- `src/config.js:157-159` `PERSONA_DEFAULTS = Object.freeze({ cardPath: null })`；
  `src/config.js:161-166` 用 `Object.defineProperty(DEFAULT_VALUES, 'persona', { enumerable:false, writable:false, configurable:false })`
  挂到默认值对象，安装面仍是 16 键（探针 5 实测 `Object.keys(DEFAULTS).length === 16`）。
- `src/config.js:601-617` `normalizePersona(raw, warnings=[])`：`undefined` → 默认；`null`/数组/非对象
  → `ConfigError('persona')`（`src/config.js:605`）；未知子键 → warning
  `unknown config field "persona.<key>" ignored`（`:609`）；`cardPath` 非字符串 →
  `ConfigError('persona.cardPath')`（`:614`）；trim、空串 → `null`（`:616`）；
  `src/config.js:695` 接入 `normalizeConfig`。
- 探针 5 独立验证：`'  C:\cards\p.json  '` → `C:\cards\p.json`；`cardPath=42/true` → `ConfigError`；
  `persona=null/[]` → `ConfigError('persona')`；未知键 warning 文案如上。

### ② apply 一次加载 + 四处全改 `state.card` + `DEFAULT_CARD` 只剩 `card.js` ✅

- 一次加载：`src/index.js:389-390` `createWiringState(...)` 后紧跟 `applyPersonaCard(state)`；
  `src/index.js:659-686` `applyPersonaCard` 只调用 `loadPersonaCard(config.persona?.cardPath ?? null)`
  一次，结果写入 `state.card` / `state.cardSource`（`:662-663`），运行期无热加载。
  `src/index.js:533-536` state 新增 `card:null` / `cardSource:null`。
- 四处替换（逐行核对 `git diff -U0 08493eb..HEAD -- src/index.js`）：
  - 人格段：`src/index.js:442` `registerSections(platform, store, track, state.card)`；
    `:747-752` `for (const section of buildSections(card))`；`src/persona/sections.js:53-62`
    `buildSections(card)` 必须显式传卡，null/undefined/非对象抛
    `buildSections(card): card is required (got ...)`，且已删 `DEFAULT_CARD` import。
  - 承诺跟进：`src/index.js:3803` 解构 `card`，`:3837`
    `followUpText({ card, reminder: row, overdueDays })`（基线是 `card: DEFAULT_CARD`）。
  - 闲聊：`src/index.js:3872` 解构 `card`，`:3935` `llm({ card, recentTopics, recallSummary, messageCount: 8 })`。
  - 违禁词：`src/index.js:3944` `bannedPhrases: card.bannedPhrases`。
- `git grep -n DEFAULT_CARD HEAD -- src` 仅 `src/persona/card.js` 8 处
  （`:29/:69/:79/:111/:173/:185/:201/:361`），其余 src 文件 0 命中。
- 独立探针 2：临时文件 + 相对 `persona.json` + `process.env.DSH_HOME` 走生产 `apply`，
  apply 后立刻把盘上卡改成 v9，四处仍用启动时那份（core 含「你是阿岩」「称呼用户为『老板』」、
  `/状态` 行、`chatLlm` 入参 `card`、`[提醒] 老板，昨天说好的…`），`loadFailureWarns=0`。

### ③ 四类加载失败兜底内置卡 + warn ⚠️（兜底成立，正文不泄漏被 M-2 破坏）

- 兜底实现：`src/persona/card.js:169-207` `loadPersonaCard` 自行 `readFileSync`
  （绕开 `loadCard` 的 ENOENT 静默默认，见 `:158` 注释），读取失败 →
  `describeReadError`（`:243-249`），解析/校验失败 → `describeParseError`（`:257-261`），
  一律 `status:'fallback'` + 内置卡 + `reason`，绝不抛给 `apply`。
- warn 一次：`src/index.js:665-669`，`meta` 仅 `{ path, reason }`（探针 3/6 实测
  `Object.keys(meta).sort() === ['path','reason']`）；`platform.log` 不 `return`，继续比较 proactive。
- 四类实测（探针 3 + 探针 6(B)）：`nope.json` → `文件不存在（ENOENT）：<path>`；
  路径是目录 → `不是普通文件（EISDIR）：<path>`；JSON 非法 → `loadCard(<path>): invalid JSON: …`；
  必填字段缺失 → `persona card: "name" must be a non-empty string（<path>）`。
  四次 `apply` 均不抛、恰 1 条 warn、core 回落「珞然」、`/状态` 显示失败行。
  `describeReadError` 另覆盖 ENOTDIR / EACCES / EPERM / 其它 code（`:243-249`）。
- **但是**：JSON 非法这一类里，V8 `JSON.parse` 的 `err.message` 对「裸 token 开头」的输入会
  回显文件正文片段，被 `src/persona/card.js:98` 原样拼进 reason，再经 `describeParseError`
  （只截 160 字符、不去正文）进入 `warn.meta.reason` 和 `/状态`。详见 M-2。

### ④ `/status` 三种形态 ✅

- `src/runtime/commands.js:138` 新增解构 `persona`，`:178` 传入 options；
  `src/runtime/commands.js:587-588` `formatPersonaLine(options.persona)` 非空才 `lines.push`；
  `src/runtime/commands.js:602-622` 三分支：`status==='fallback'` →
  `加载失败，已用内置：<reason>`；`status==='file'` → 路径；其余 → `内置默认`。
  `src/index.js:726-736` `personaStatus(state)` 未加载卡返回 `undefined`，
  `:864` 传给命令注册，所以旧调用方不输出该行。
- 探针 5 三态全通过：`人格卡：珞然 v1（内置默认）` / `人格卡：阿岩 v2（<绝对路径>）` /
  `人格卡：珞然 v1（加载失败，已用内置：loadCard(<path>): invalid JSON: …）`。
  探针 6(A) 直调 `handleCommand` 不传 `persona` 与显式 `persona:null`：两者逐字相同，
  均无「人格卡」行（7 行），旧格式不变。

### ⑤ proactive 冲突 warn 且行为以配置为准 ✅

- 只告警不改行为（硬证据）：`src/index.js:3389-3405`
  `createProactive({ store, platform: { prompt }, target, config, clock: platform.now })` ——
  实参里**没有 card**；`src/runtime/proactive.js:119` `dailyCap = settings.proactiveDailyCap ?? DEFAULTS.proactiveDailyCap`，
  `:128-129` `quietStart/quietEnd` 同取 settings。卡对象完全不进调度器。
- 冲突检测 `src/persona/card.js:218-235` `personaProactiveConflicts(card, config)` 只比
  `dailyCap↔proactiveDailyCap` / `quietStart↔quietStart` / `quietEnd↔quietEnd`；
  `src/index.js:700-718` 文件卡用英文文案 `... conflict with config; config wins` +
  `meta.fields=['proactive.dailyCap≠proactiveDailyCap', …]`，内置/兜底卡用中文文案带两边取值。
  `src/index.js:679-684` `chatPerDay` 无配置对应键时只打 debug（文档已声明留 v0.4.13）。
- 探针 5(3)：卡含 `proactive:{dailyCap:9,quietStart:'01:00',quietEnd:'02:00'}` 且配置
  `proactiveDailyCap=1` → 恰 1 条冲突 warn、fields 三项齐全、生效值是配置 1。
  `test/persona-proactive.test.js:84/:101/:119/:147` 另覆盖内置卡 + 非默认配置告警一次。

### ⑥ 文档（数组整体替换、重启生效、删旧表述）✅

- 数组整体替换：`README.md:198`、`config.example.yml:91`、`docs/usage.md:739`、
  `persona.example.md:38/:90`；实现侧 `src/persona/card.js:317-330` `mergeInto` 对数组整体替换。
- 重启生效（无热加载）：`README.md:198`、`config.example.yml:85`、`docs/usage.md:743`、
  `persona.example.md:16/:140`、`docs/deploy-v0412.md:51`；实现侧见 ②。
- 删旧表述：`git grep -n 运行期使用内置默认卡 HEAD` 0 命中；`persona.example.md` 已全文重写
  为「怎么用 + 9 字段表 + 兜底 reason + /状态 三态」。
- 以配置为准：`README.md:198`、`config.example.yml:92-93`、`docs/usage.md:733/:769-781`、
  `persona.example.md:53/:59-66`。
- ⚠️ 文档本身内容正确且互相一致，但其声明的「否则 `~/.dsh`」与实现不符 —— 该矛盾计入 M-1。

## 3. 路径解析三分支（含 M-1 证据）

| 分支 | 期望 | 实测 | 结论 |
| --- | --- | --- | --- |
| 绝对路径 | 原样 | `resolveCardPath('C:\\...\\abs.json', {env:{}}) === 'C:\\...\\abs.json'` | ✅ |
| 相对 `DSH_HOME` | trim 后拼 `DSH_HOME` | `DSH_HOME='  <A>  '` + `cards/persona.json` → `<A>\cards\persona.json`；真临时文件 `loadPersonaCard('persona.json', {env:{DSH_HOME:<B>}})` → `status:'file'`、读到 `<B>\persona.json` | ✅ |
| 未设置回退 `~/.dsh` | `join(homedir(), '.dsh')` | `resolveDshHome({env:{}}) === 'C:\Users\93488'`，`resolveCardPath('persona.json',{env:{}}) === 'C:\Users\93488\persona.json'`；把卡放在 `<C>\.dsh\persona.json` 且 `DSH_HOME` 未设置 → `status:'fallback'`，`文件不存在（ENOENT）：<C>\persona.json` | ❌ M-1 |

M-1 的五方冲突证据：

1. **原始硬验收**（只读核对 `.agent-teams/dsh-companion-r15/team.json`）：t1 任务原文
   「规则为 `process.env.DSH_HOME`（trim 后非空）否则 `path.join(os.homedir(), '.dsh')`」；
   t1 acceptance `"criterion": "resolveCardPath(cardPath, deps?) 纯函数：绝对路径原样，相对相对 DSH_HOME（DSH_HOME 否则 homedir/.dsh），可注入 env/homedir"`；
   t2 卡第 4 条「`DSH_HOME` 未设置时回退 `~/.dsh`」；builder-3 卡第 2 条要求文档写「否则 `~/.dsh`」。
   即 `~/.dsh` 是原始口径，不是复审自行加码。
2. **代码自身 JSDoc / 注释**：`src/persona/card.js:117`「否则 `~/.dsh`」、`:138`、`:155-162`；
   `src/config.js:154-155`、`:590`。实现却 `src/persona/card.js:131` `return homedir();`、
   `:130` `return home.trim();` —— 两处都返回**裸用户主目录**；
   `git grep -n -E "\.dsh|DSH_HOME|homedir" HEAD -- src/*.js` 全 src 无 `join(homedir(), '.dsh')`。
3. **五处用户文档**：`README.md:181/:198`、`docs/usage.md:720-723`（「未设置 `DSH_HOME` 时
   指向 `~/.dsh/persona.json`」）、`persona.example.md:30-32`、`config.example.yml:86-87`、
   `docs/deploy-v0412.md:3`（显式 `DSH_HOME` 示例）。
4. **宿主 DSH 语义**（`D:\dsh\resources\app.asar`）：`DSH_HOME_DIR_NAME = ".dsh"`、
   `defaultDshHome() { return join(homedir(), DSH_HOME_DIR_NAME); }`、
   `resolveDshHome(configured, env = process.env) { return resolveRoot(configured, env, DSH_HOME_ENV, defaultDshHome); }`；
   宿主内 Liveshare 插件亦为
   `join(nonEmpty(process.env.DSH_HOME) ?? join(homedir(), ".dsh"), "liveshare", "owner-shares.json")`。
   宿主注册表文档另注明「shell 执行器丢弃继承的 `DSH_*` 值、`process.env` 永不被修改」——
   即插件所在进程 `process.env.DSH_HOME` 可能为空，该回退分支**可能真实触发**，不是纯理论分支。
5. **测试掩盖**：`test/v0412-persona-card.test.js:223` 测试名写「未设置或空白时回退注入的
   `~/.dsh`（不读真实用户目录）」，但 `:240-241` 断言
   `resolveDshHome({env:{}}) === osHomedir()`、
   `resolveCardPath('persona.json',{env:{}}) === resolve(osHomedir(),'persona.json')`，
   把注入的 `homedir` 当成 `.dsh` 目录本身，把偏差固化成绿灯。
   `test/e2e/persona-card.test.js:125-134` 与 `:263` 的集成用例一律显式注入 `DSH_HOME`，
   没有覆盖 unset 分支。

## 4. 回归面

- **内置卡人格段与 v0.4.11 逐字节一致**（探针 4）：把
  `git show 08493eb:src/persona/sections.js` / `:src/persona/card.js` 导出到
  `.probe-v18/v0411/` 后真实 `import()`，基线 `buildSections()` 与当前
  `buildSections(DEFAULT_CARD)` 三段 SHA-256 全部相等，且与
  `test/e2e/persona-card.test.js:65-69` 的 `V0411_SECTION_SHA256` 常量一致：
  `persona:safety` = `f6674ce158a44b29d07deebc12393974292b66ac873992fca03d4d1ccd0f1a27`、
  `persona:core` = `2c2bf0d51048619223580470c27e1ec3ecc3a7c76f9bb57a104a46e82b73d928`、
  `persona:protocol` = `3583cacf66261008fcc8b91207a8f945dd79de558c61c1d40ec4f48bbc9bc38b`；
  order 80/90/150；两版 `DEFAULT_CARD` 顶层键集合相同。
- **schema 仍 13**：`src/memory/store.js:77` `const SCHEMA_VERSION = '13';`，
  `src/memory/export.js:86` `const CURRENT_SCHEMA_VERSION = '13';`，两文件均不在 diff 内。
- **记忆/提醒/线程逻辑未改**：`git diff --name-only 08493eb..HEAD -- src` 仅 5 个文件
  （`config.js` / `index.js` / `persona/card.js` / `persona/sections.js` / `runtime/commands.js`）；
  对 `memory|remind|thread|proactive|compact|scheduler|govern|export` 过滤 **0 命中**。
  `src/index.js` diff 为 +105/−9，13 个 hunk 的函数上下文全部落在
  `apply` / `createWiringState` / `registerSections` / `registerCommands` /
  `runCommitmentFollowups` / `runLightChat`，与四处替换一一对应（见 ②）；
  `runCommitmentFollowups` / `runLightChat` 其余语句未动。
- **三时区全绿**：`TZ=DEFAULT` / `TZ=UTC` / `TZ=America/New_York` 三次 `node --test`
  均为 `tests 953 / suites 16 / pass 953 / fail 0 / skipped 0 / todo 0`，
  `^not ok ` 0 行；日志在仓库外 `.probe-v18/node-test-*.log`。≥918 满足。
- **工作树与依赖**：复审起点 `git status --porcelain` 空、`main...origin/main [ahead 5]`、
  无 `v0.4.12` tag；`git diff --check 08493eb..HEAD` exit 0；`package.json` 无
  `dependencies` / `devDependencies` 键（零第三方依赖），`node --version` = v24.9.0
  （`engines.node >=24` 满足）。
- **无写用户 profile**：所有探针写入都在 `os.tmpdir()` 下 `mkdtemp`；`DSH_HOME` unset 分支
  用 `deps.homedir` 注入临时目录，未触碰真实 `os.homedir()` 下的文件（只读过其返回值用于比对）；
  未读写 `C:\Users\93488\.dsh`。`src/persona/card.js` 全文无 `writeFile` / `mkdir` /
  `appendFile` / `rename` / `unlink`。

## 5. 独立探针与命令

探针目录 `D:\test\agent-plugin\.probe-v18\`（父目录非 git 仓库，不进提交），工作目录
`D:\test\agent-plugin\dsh-companion`，Node v24.9.0。均写成 `.mjs` 文件后 `node <file>`
（`-e` 内联引号经 pwsh 传参会被吞，改用文件）。

| 探针 | 命令 | 结果要点 |
| --- | --- | --- |
| `probe0-json-errors.mjs` | `node .probe-v18/probe0-json-errors.mjs` | V8 `JSON.parse` 错误消息形状普查：裸 token 开头 → `Unexpected token 'S', "SECRET_BOD"... is not valid JSON`（回显正文前 10 字符）；位置型错误只给 position |
| `probe1-paths.mjs` | `node .probe-v18/probe1-paths.mjs` | 绝对/相对 `DSH_HOME`/unset 三分支；真临时文件读到卡；`MATCH host ~/.dsh convention? = false`；按文档位置放卡 → `fallback` + ENOENT |
| `probe2-apply.mjs` | `node .probe-v18/probe2-apply.mjs` | 生产 `apply` + 临时 `DSH_HOME` + 相对路径；四处同源；apply 后改盘上文件不生效；`/状态` 文件行；0 条加载 warn |
| `probe3-fallback.mjs` | `node .probe-v18/probe3-fallback.mjs` | 走生产 `apply` 的三类兜底；warn 恰 1 条、`meta={path,reason}`；**裸 token 分支 `leaked=["SECRET_BOD"]`** |
| `probe4-baseline.mjs` | `node .probe-v18/probe4-baseline.mjs` | 导入 `git show 08493eb` 重建的基线，三段 SHA-256 与 HEAD 及集成测试常量三方相等 |
| `probe5-config-status.mjs` | `node .probe-v18/probe5-config-status.mjs` | 16 键/校验/`/状态` 三态/proactive 冲突+bannedPhrases/旧调用方；`proactiveDailyCap=1` 生效 |
| `probe6-extra.mjs` | `node .probe-v18/probe6-extra.mjs` | (A) 旧调用方 `handleCommand` 无「人格卡」行且 `persona:null` 逐字相同；(B) EISDIR 第四类兜底；(C) 裸 token 泄漏同时进 warn 与 `/状态`；(D) 文档默认位置放卡 → fallback |
| `probe7-bom.mjs` | `node .probe-v18/probe7-bom.mjs` | 现实误写形状：UTF-8 BOM、纯文本占位符 `TODO_put_my_persona_here`、误写成 YAML `name: 隐私姓名`、单引号 JSON；其中占位符与 YAML 两种把卡正文（含换行）带进 reason |

关键命令：

```
git -C D:\test\agent-plugin\dsh-companion log --oneline --reverse 08493eb..HEAD
git -C ... diff --check 08493eb..HEAD
git -C ... diff --name-only 08493eb..HEAD -- src
git -C ... diff -U0 08493eb..HEAD -- src/index.js
git -C ... grep -n DEFAULT_CARD HEAD -- src
git -C ... grep -n -E "~\/\.dsh|数组整体|重启|以配置为准|运行期使用内置默认卡" HEAD -- README.md config.example.yml docs/usage.md persona.example.md docs/deploy-v0412.md
git -C ... show 08493eb:src/persona/sections.js > .probe-v18\v0411\sections.js   # 基线重建
node --test                                                        # ×3 时区，各 953/953
```

## 6. Findings

### M-1（必修，阻断发布）`DSH_HOME` 未设置时未回退 `~/.dsh`

- **文件/行号**：`src/persona/card.js:123-132`（`:130` `return home.trim();`、`:131` `return homedir();`）、
  `src/persona/card.js:144-153`（`:152` `resolvePath(resolveDshHome(deps), trimmed)`）；
  对照 `src/persona/card.js:117/:138` 的 JSDoc、五处文档（§3 第 3 条）、
  `test/v0412-persona-card.test.js:223/:240-241`。
- **问题**：`DSH_HOME` trim 后为空时，相对 `cardPath` 被解析到 `~/persona.json` 而不是
  `~/.dsh/persona.json`。按 `README.md:181/:198`、`docs/usage.md:720-723`、
  `persona.example.md:30-32` 把卡放进 `~/.dsh/` 的用户，会静默拿到内置「珞然」卡 +
  一条 ENOENT warn；且代码、JSDoc、文档、宿主 `defaultDshHome()` 四方互相矛盾。
  探针 1(e)、6(D) 用临时目录完整复现：`status='fallback'`，
  `reason='文件不存在（ENOENT）：<home>\persona.json'`。测试名声称覆盖 `~/.dsh` 但断言的是裸 `~`，
  使全量测试与 t4 发布门 A/B 全绿却漏掉该分支。
- **requiredFix**：`resolveDshHome` 的 fallback 改为 `join(homedir(), '.dsh')`；注入的
  `deps.homedir`（函数或字符串）同样先拼 `.dsh`（保持「可注入 os.homedir」语义，不要把它当成
  DSH 主目录本身）；`src/persona/card.js:117/:138/:155-162` JSDoc 与代码对齐；
  修正 `test/v0412-persona-card.test.js:223-242` 的断言与命名，并新增一条「在
  `<injectedHome>/.dsh/` 放真卡 → 读到卡」的单测；补一条 unset `DSH_HOME` 的生产 `apply`
  集成用例。若团队决定改口径为「未设置则用 `~/`」，必须同步改五处文档 + 原始验收条目，
  不能只留代码。

### M-2（必修，阻断发布）坏 JSON 时 warn 与 `/状态` 泄漏卡正文

- **文件/行号**：`src/persona/card.js:98`
  `throw new TypeError(\`loadCard(${path}): invalid JSON: ${err.message}\`, { cause: err });`；
  `src/persona/card.js:257-261` `describeParseError`（仅按长度截 160 字符、不清洗正文）；
  `src/index.js:665-669`（reason 进 `warn.meta.reason`）；
  `src/runtime/commands.js:609-613`（reason 进 `/状态` 行）；
  对照 `src/index.js:654-655`「不含卡正文」与 `src/runtime/commands.js:597`「卡正文永不进 /状态」。
- **问题**：V8 对「裸 token 开头」的非法 JSON 会把源文件前 10 字符回显在 `err.message` 里。
  探针 3：`'SECRET_BODY_SENTINEL_B'` → reason
  `loadCard(<path>): invalid JSON: Unexpected token 'S', "SECRET_BOD"... is not valid JSON`，
  `leaked=["SECRET_BOD"]`；探针 6(C) 确认该片段同时出现在 `warn.meta.reason` 与 `/状态` 文本。
  探针 7 的现实误写形状：纯文本占位符 → `"TODO_put_m"...`；误写成 YAML →
  `"name: 隐私姓名\n"...`（**卡正文里的姓名 + 一个真实换行符**被写进日志与单行 `/状态`）。
  这直接违反本次硬要求「warn 不含卡正文」。
  `test/v0412-persona-card.test.js:308-319` 只测了位置型错误
  （`'{"name":"秘卡正文勿外泄","address":"你",'` → `Expected double-quoted property name …`），
  该形状恰好不回显正文，因此负向断言 `doesNotMatch(/秘卡正文勿外泄/)` 恒真、形成假绿灯。
- **requiredFix**：`parseCardSource` 不要把原始 `err.message` 拼进对外 reason；改为固定文案 +
  只保留不含正文的诊断（如 `position` 数字 / `err.name`），或统一为
  `loadCard(<path>): invalid JSON（JSON 解析失败）`。`describeParseError` 额外剥离
  `"..."` 回显片段与控制字符（换行/制表符至少转义或移除），保证 reason 单行且不含正文。
  新增回归用例覆盖裸 token / BOM / 纯文本占位符 / YAML / 单引号 JSON 五种形状，
  断言 `JSON.stringify(warns)` 与 `/状态` 文本都不含预埋的哨兵串；t2 的现有负向断言改成
  对多种形状都成立。

### L 级观察（不阻塞）

- **L-1**：`src/persona/card.js:67-84` 的旧 `loadCard(path)` 仍对 ENOENT 静默返回内置卡
  （`:158` 注释已说明 `loadPersonaCard` 刻意绕开它）。当前只有 `test/persona.test.js` 调用，
  生产接线不经过它；建议加 `@deprecated` 标注，避免后续新调用方绕过 warn 契约。
- **L-2**：t4 的 `docs/review-round-ab-v0412.md` 记 round C 因凭据缺失 `skip`（不计 PASS），
  且仓库无 `eval-boundary.md`。按 v0.4.11 口径沿用，本复审未重跑 round C（无凭据），
  打 tag 前请 captain 确认该项仍为已接受风险。
- **L-3**：本轮发布门 round A/B 全 PASS 却漏掉 M-1/M-2，说明 A 类检查里缺
  「unset `DSH_HOME` 分支」与「JSON 错误消息形状矩阵」两项。建议补进 round A 清单，
  避免同类偏差再次靠全绿测试蒙混过关。

## 7. 工作区与验证清单

- 复审起点：`HEAD=0408c04`、`main`、`git status --porcelain` 空、`ahead 5`、无 `v0.4.12` tag。
- 本复审只新增 `docs/review-v18.md`（本报告），不改 `src/` / `test/` / 其它文档；commit **不 push**。
- 探针与三时区日志全在仓库外 `D:\test\agent-plugin\.probe-v18\`，未进工作树。
- 未写用户 `~/.dsh` / profile；未安装依赖；`git diff --check` exit 0；未打 tag、未 push。

### 复审后建议

M-1、M-2 修复 → 补上面要求的单测/集成用例 → 重跑三时区 `node --test` 与 round A/B →
**重新独立复审**（新报告，不得复用本 verdict）→ H=0 且 M=0 后再打 `v0.4.12` tag 并推送。
本次 `needs_revision` 期间不要进入打 tag 步骤。
