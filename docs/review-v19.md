# v0.4.12 独立复审 v2（review-v19）

- 复审人：reviewer（独立复审，与 t8/t9 实现者不同）
- 日期：2026-11-06
- 对象：`08493eb`（v0.4.11）→ `ce0a3ae`（t9 后 HEAD，8 提交）；重点审 `3abc9d3`（t8 修复）与 `ce0a3ae`（t9 门禁）
- 方式：只审不改 `src/`、不 push。4 个仓库外独立探针（自己写、自己跑）+ 一时区全量 `node --test` + 基线 `08493eb` 真实导入 SHA-256 + 静态逐行 diff/grep + 只读核对 team.json 与发布门日志
- 前次结论：`docs/review-v18.md` = `needs_revision`（M-1 `~/.dsh` 回退未实现、M-2 坏 JSON 泄漏卡正文）

## 结论

**verdict = pass（H=0 / M=0 / L=3）** — M-1、M-2 均已按 requiredFix 关闭并经独立探针复现验证；t5 的全部通过项无回归。发布前置条件（H=0 且 M=0）满足：可进入打 tag / 推送环节，但 L-1（round C 未实跑）请 captain 在发布前确认口径。

| 级别 | 计数 | 说明 |
| --- | --- | --- |
| H（阻塞） | 0 | 无 |
| M（必修） | 0 | t5 的 M-1、M-2 已关闭（§2） |
| L（观察/建议） | 3 | round C 无凭据 skip、无 `eval-boundary.md`、`loadCard` 静默 ENOENT 待清理 |

---

## §1 M-1 关闭证据（DSH_HOME 未设置回退 `~/.dsh`）

requiredFix：`resolveDshHome` 两个 fallback 统一拼 `.dsh`；显式 `DSH_HOME` 分支不拼；相对路径落到文档承诺位置。

代码（`src/persona/card.js`）：
- `:124-133` JSDoc 明确「`DSH_HOME` trim 后非空优先，否则 `<用户主目录>/.dsh`」，并说明 `deps.homedir` 与 `os.homedir()` 都是「用户主目录」，同样要拼 `.dsh`。
- `:134-143` `resolveDshHome`：`const env = deps.env ?? process.env;`（:135）、`const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';`（:136）、`if (fromEnv !== '') return fromEnv;`（:137，**显式 DSH_HOME 原样返回，不拼 .dsh**）、`:139-142` `const injected = deps.homedir; … const base = … ? home.trim() : homedir(); return join(base, '.dsh');`（**注入的 homedir 与 os.homedir() 一视同仁都拼 `.dsh`**）。
- `:155-164` `resolveCardPath`：`:162` `if (isAbsolute(trimmed)) return trimmed;`、`:163` `return resolvePath(resolveDshHome(deps), trimmed);`。
- `git grep "join(.*\.dsh" HEAD -- src` → 仅 `src/persona/card.js:142`（唯一拼接点，无旁路）。

独立探针 `.probe-v19/probe1-m1.mjs`（`node` 运行，EXIT=0，`PROBE1 OK`）：
- A 纯函数全分支：unset + 注入 homedir（字符串/函数）→ `join(home,'.dsh')`；unset 不注入 → `join(os.homedir(),'.dsh')`；`DSH_HOME` 设置 → 原样**不**拼 `.dsh`；trim 优先、空白等同 unset；相对路径两落点正确；绝对路径原样；null/空白 → null。
- B 真临时文件：`loadPersonaCard('persona.json',{env:{},homedir:homeA})` 读到 `<homeA>/.dsh/persona.json`（卡 name=复审阿岩）；把诱饵卡放旧位置 `<homeA>/persona.json` → 不生效，`status=fallback` 且 `reason=文件不存在（ENOENT）：<homeC>\.dsh\persona.json`（reason 指向 `.dsh`）；`DSH_HOME` 分支读 `<dsh-home>\persona.json`。
- C 生产 `apply(ctx, config, {personaDeps:{env:{},homedir}})`：unset 分支 core 与 `/状态` 均用 `.dsh` 卡且 0 warn；兜底 reason 指向 `.dsh`；`DSH_HOME` 分支不拼 `.dsh`。

对照 t5：v18 探针 1(e)/6(D) 曾实测「按文档位置放卡 → 静默 fallback + ENOENT」，同形状在 v19 变为读卡成功，M-1 关闭。

## §2 M-2 关闭证据（坏 JSON 不泄漏卡正文）

requiredFix：`parseCardSource` 不拼 `JSON.parse` 原始 message；`describeParseError` 剥离 `"..."` 回显与控制字符、压成单行 ≤160；覆盖 5 种形状。

代码（`src/persona/card.js`）：
- `:96-107` `parseCardSource` 捕获 `JSON.parse` 后抛 `loadCard(${path}): invalid JSON（${describeJsonSyntaxError(err, source)}）`（:103-106），**不引用 `err.message` 原文**。
- `:271-276` `describeJsonSyntaxError` 只产出 `位置 <line:col>；<固定类别>`；`:285-302` `syntaxErrorPosition` 从 V8 `line/column` 或 `at position` 换算行列；`:309-319` `syntaxErrorReason` 白名单短语（内容提前结束 / 字符串未闭合 / 非法转义字符 / 非法控制字符 / `期望 <符号>` / 意外字符 / 意外 token / 无法解析），未知一律「无法解析」。
- `:328-333` `describeParseError` → `:340-347` `sanitizeParseReason`：`.replace(/,\s*"(?:[^"\\]|\\.)*"(?:\.\.\.)?\s*(?:is not valid JSON)?/gu,'')` 剥 V8 `"..."` 回显、剥控制字符、折叠空白、`.trim()`；路径去重后 ≤160 截断。
- `:180-217` `loadPersonaCard` 的 read 失败走 `:254` `describeReadError`（固定 code 文案），parse 失败走 `:215` `describeParseError`；`src/index.js:667-671` warn meta 仅 `{path,reason}`、`src/runtime/commands.js:602-622` `/状态` 复用同一 reason。
- 冲突 warn 由 `src/index.js:678-679` 调 `:702-720` `logProactiveConflicts` 与 `src/persona/card.js:229-246` `personaProactiveConflicts` 产生。

独立探针：
- `.probe-v19/probe2-m2.mjs`（EXIT=0，`PROBE2 OK`）：6 形状（裸 token `V19BARE_SENTINEL_ABCDEFGH` / UTF-8 BOM / 占位符 / YAML / 单引号 JSON / 缺 name+taboos 哨兵）各走生产 `apply` 绝对路径，逐形状断言：恰 1 条 `CARD_LOAD_WARN`、`meta` keys 恰 `['path','reason']`、reason 单行无控制字符 ≤160、`JSON.stringify(warn.meta / warns / ctx.logs)`、`/状态`、`人格卡` 行、reason 本身均**不含**任何哨兵片段、`/状态` 复用同一 reason、core 回落珞然。结果：bare/BOM/占位符/YAML → `loadCard(<path>): invalid JSON（意外字符）`；单引号 → `…（位置 1:2；无法解析）`；缺 name → `persona card: "name" must be a non-empty string（<path>）`。末尾本地对照 V8 原始 message = `Unexpected token 'V', "V19BARE_SE"... is not valid JSON`，证明「修前必泄漏、修后不泄漏」，探针具有鉴别力。
- `.probe-v19/probe4-edge.mjs`（EXIT=0，`PROBE4 OK`）B 段额外 7 形状（unterminated-string / unexpected-string / unexpected-number / bad-control-char / json-is-string / json-is-array / 500 字长正文）全部不泄漏、单行、≤160、恰 1 warn；C 段坏 JSON + 非默认 proactive → 加载 warn 1 条 + 中文冲突 warn 1 条，两条与 `/状态` 都不含哨兵；D 段 EISDIR 兜底正常。

对照 t5：v18 探针 3/6(C)/7 的 `leaked=["SECRET_BOD"]`、占位符 `TODO_put_m`、YAML `隐私姓名` + 真实换行，在 v19 全部消失；`test/v0412-persona-card.test.js` 的假绿灯断言已由 t8 替换为 5 形状矩阵（t9 `test/e2e/persona-card.test.js:561-602`、`:68-95`）。M-2 关闭。

## §3 通过项回归（t5 判过的项无回归）

- **人格四处替换**：`src/index.js:442` `registerSections(..., state.card)`、`:749` `registerSections(..., card)`、`:3839` `followUpText({ card, … })`、`:3937` `llm({ card, … })`、`:3946` `bannedPhrases: card.bannedPhrases`；`:56` import 为 `CARD_STATUS, loadPersonaCard, personaProactiveConflicts`。`git grep DEFAULT_CARD HEAD -- src` 仅 `src/persona/card.js` 8 处（`:29/:72/:82/:119/:184/:196/:212/:447`）。
- **一次加载**：`src/index.js:390` `applyPersonaCard(state, hooks)`、`src/index.js:661-663` `loadPersonaCard(config.persona?.cardPath ?? null, hooks.personaDeps ?? {})`；t8 新增 `hooks.personaDeps` 测试席位，探针 4 A 段验证「不传 hooks + 真实 `process.env.DSH_HOME`」生产默认路径仍读卡成功（未回归）。
- **`/状态` 三形态**（探针 3 C 段，生产 apply）：内置 `人格卡：珞然 v1（内置默认）`、文件 `人格卡：阿岩 v2（<绝对路径>）`、失败 `人格卡：珞然 v1（加载失败，已用内置：文件不存在（ENOENT）：<path>）`；旧调用方 `handleCommand`（`src/runtime/commands.js:124/:138/:178`、`:587-588`、`:602`）不传 persona → 无「人格卡」行、与 `persona:null` 逐字一致（7 行）。
- **proactive 以配置为准**：`src/index.js:3391-3407` `createProactive({store,platform,target,config,clock})` 只传 `config` 不传 card；`src/runtime/proactive.js:119` `dailyCap = settings.proactiveDailyCap ?? DEFAULTS.proactiveDailyCap`、`:128-129` quietStart/quietEnd 全取 settings。探针 3 D 段真实 `createProactive(...).stats()` → `cap=1`（卡 `dailyCap=9` 被忽略）；冲突 warn 由 `src/index.js:678-679/:702` 与 `src/persona/card.js:229-246` 产生。
- **内置卡三段与 `08493eb` 逐字节一致**：`cmd /c "git show 08493eb:src/persona/{sections,card}.js > .probe-v19/v0411/…"` 导出后真实导入，基线 `buildSections()` 与 HEAD `buildSections(DEFAULT_CARD)` 三段 SHA-256 全等于 `test/e2e/persona-card.test.js:102-106` 常量：`persona:safety`=`f6674ce158a44b29d07deebc12393974292b66ac873992fca03d4d1ccd0f1a27`、`persona:core`=`2c2bf0d51048619223580470c27e1ec3ecc3a7c76f9bb57a104a46e82b73d928`、`persona:protocol`=`3583cacf66261008fcc8b91207a8f945dd79de558c61c1d40ec4f48bbc9bc38b`；order 80/90/150；两版 `DEFAULT_CARD` top-level keys 相等；`buildSections(null)` 抛 TypeError（探针 3 A）。
- **schema 仍 v13**：`src/memory/store.js:77 const SCHEMA_VERSION = '13';`、`src/memory/export.js:86 const CURRENT_SCHEMA_VERSION = '13';`。
- **回归面/零依赖**：`git diff --name-only 08493eb..HEAD -- src` 仅 5 文件，对 `memory|remind|thread|proactive|compact|scheduler|govern|export|recall|session` 过滤 0 命中；`0408c04..HEAD -- src` 仅 `src/index.js`（10 行）、`src/persona/card.js`（102 行）。`package.json` 无 `dependencies`/`devDependencies`、`version=0.4.11`；`git diff --check 08493eb..HEAD` EXIT=0。
- **配置校验**：`src/config.js:157-162` `PERSONA_DEFAULTS` 非枚举（16 键不变）、`:601-617` `normalizePersona`（`:605` `ConfigError('persona')`、`:609` 未知键 warning、`:614` `ConfigError('persona.cardPath')`）、`:695` wiring；探针 3 E 段验证 16 键 / trim / 类型校验 / 未知键。
- **四处文档口径**：`README.md:181`（未设置时 `~/.dsh`）、`:198`（数组整体替换/改卡重启/proactive 以配置为准）；`config.example.yml:87`；`docs/usage.md:720/:723`；`persona.example.md:30/:32`；`docs/deploy-v0412.md:38/:49/:58`（明确「不是 `~/persona.json`」）。`运行期使用内置默认卡` 仅 2 命中，都在 `docs/review-v18.md`（复审报告引用旧表述，非文档残留）。代码 JSDoc `src/persona/card.js:124-130/:145-150` 与 `src/config.js:154-155/:590` 与文档一致。
- **三时区全量**：亲跑 `TZ=UTC node --test` → `tests 964 / suites 16 / pass 964 / fail 0 / cancelled 0 / skipped 0 / todo 0`、`duration_ms 5615.77`、EXIT=0（日志 `.probe-v19/node-test-reviewer-TZ-UTC.log`）；另两时区与 t9 日志 `.data/t9-tz-{default,utc,newyork}.log` 对照，三份均 `964/964/0`、`^not ok ` 0 行，与 `docs/review-round-ab-v0412.md:52-102` A1 一致。≥918 满足。

## §4 探针与命令清单

| # | 文件 / 命令 | 用途与结果 |
| --- | --- | --- |
| 1 | `node .probe-v19/probe1-m1.mjs` | M-1：路径三分支纯函数 + 真临时文件 + 生产 apply（`personaDeps`）→ `PROBE1 OK` |
| 2 | `node .probe-v19/probe2-m2.mjs` | M-2：6 形状走生产 apply，warn/meta/`/状态` 脱敏 → `PROBE2 OK` |
| 3 | `node .probe-v19/probe3-regress.mjs` | 通过项回归：基线 SHA-256、四处同源、三形态、proactive、配置 → `PROBE3 OK` |
| 4 | `node .probe-v19/probe4-edge.mjs` | 加固：生产默认（不传 hooks）、7 附加形状、双 warn、EISDIR → `PROBE4 OK` |
| 5 | `TZ=UTC node --test` | 一时区全量 → `964/964/0`，EXIT=0 |
| 6 | `cmd /c "git show 08493eb:src/persona/{sections,card}.js > .probe-v19/v0411/…"` | 基线真实导入逐字节比对（见 §3） |
| 7 | `git diff --check 08493eb..HEAD` / `git diff --name-only … -- src` / `git grep …` / `git status --porcelain` / `git tag --list` | 静态核查，均见 §1–§3 |

探针全部位于仓库外 `D:\test\agent-plugin\.probe-v19\`（父目录非 git 仓库），不污染工作树；仅用 `mkdtempSync(tmpdir())` + `makeTempStore()`，注入 `deps.env/homedir`，**不读写真实 `~/.dsh`**、不动用户 profile。Node v24.9.0。

## §5 Findings / L 项建议（只记录，不改）

- **L-1（round C 未实跑）**：`.data/plugin-gate.log` 尾部 `MISSING_CREDENTIAL: llm-deepseek: no API key …`，`docs/review-round-ab-v0412.md` 记 `credentials=missing → verdict=skip`。按 v0.4.11 既有口径 SKIP 不计 PASS、不阻塞；但打 tag 前请 captain 明确「接受本次 skip」或安排有凭据环境复跑 round C。
- **L-2（无 `eval-boundary.md`）**：`git ls-files` 与 `Test-Path` 均 0。`docs/deploy-v0412.md` 已写明追加「配置变更」条；建议 captain 确认正式记录落在发布环境即可，非本仓库缺失项。
- **L-3（`loadCard` 仍静默 ENOENT）**：v18 的 L-1 已落实 —— `src/persona/card.js:66-69` 标 `@deprecated` 指向 `loadPersonaCard()` 并说明「配置了 cardPath 时不要用 loadCard()」。函数本身仍对 ENOENT 静默返回内置卡（`:70-87`），当前生产不调用它（`git grep loadCard` 仅 card.js 内部 + `test/persona.test.js`）；建议 v0.4.13 清理调用方后再删除，本版不阻塞。

无新增 H/M；未发现 t8 修复引入的回归。

## §6 工作区与验证清单

- 复审范围：`08493eb..HEAD`，HEAD=`ce0a3ae6731875ea50860d4c618e09bc472c0424`，branch `main`，8 提交；tag 仅 `v0.4.1`/`v0.4.10`/`v0.4.11`（**无 v0.4.12**）。
- 本次交付：仅新增本文件 `docs/review-v19.md`，单独 commit `docs(review): v0.4.12 复审 v2（review-v19）`，**不 push、不改 src/**；提交后 `git status --porcelain` 空。
- 探针目录 `.probe-v19/` 在仓库外；`git diff --check` EXIT=0；未写用户 `~/.dsh`、未写 profile、未新增依赖。
- 发布建议：H=0 且 M=0 → 允许进入打 tag `v0.4.12` 与推送；L-1 口径由 captain 确认后执行（延续 t5 的「复审通过后再打 tag」门禁）。
