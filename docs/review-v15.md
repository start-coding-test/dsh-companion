# v0.4.9 R1 文档修复复审（review-v15）

- **复审人**：reviewer（独立复审）
- **日期**：2026-11-05
- **复审对象**：d14e2b2「docs(v0.4.9): 对齐 V7-H1 契约，补隐私与压缩起点说明」（基于 d6c1443 + 85717d1 review-v14）
- **方式**：只读 diff 逐行核验 + 残留语句全库扫描 + 亲跑三时区全量 / plugin-smoke
- **结论**：**pass（H=0 / M=0 / L=0）** —— review-v14 的 R1（M）与 DOC-L 两条文档项全部关闭，实现零改动，测试全绿，**v0.4.9 复审链路通过，可进入发布提交**。

## 1. 结论计数表

| 必查项 | 结果 | 证据 |
| --- | --- | --- |
| R1 关闭：docs 与 V7-H1 新契约一致 | ✅ | usage.md:121/:138/:315/:367/:649 + platform-api.md §5 重写 |
| L 关闭：隐私/压缩起点段 + known-debt 观察项 | ✅ | usage.md:430-439 / :488-498 + known-debt.md:130 |
| 实现零改动（相对 d6c1443 仅 docs） | ✅ | `git diff d6c1443..HEAD --stat`：4 个 docs 文件 +142/−17（含 review-v14.md 本身）；无 src/scripts 改动 |
| 三时区全量 | ✅ | 859 pass / 0 fail（UTC、Asia/Shanghai、America/Los_Angeles） |
| plugin-smoke | ✅ | 三时区均 4 pass / 0 fail |
| worktree clean / 无 v0.4.9 tag / 未 push | ✅ | dirty=0；`git tag` 无 v0.4.9；origin/main..HEAD 未推送 |

## 2. 逐项核验

### 1) R1 关闭 ✅

- `docs/usage.md:121`：/线程 不支持文案改为新文案，并补「两者都是调用时实时判断：能力晚挂载后无需重装插件，下一次调用即恢复」。
- `docs/usage.md:138`：/状态 线程行改为新文案 +「每次执行 /状态 时实时读取能力」。
- `docs/usage.md:315`：thread_run 的 `session-unavailable` 说明正确定性——工具集脱离插件能力门单独构造时的返回；插件注册路径先返回 `capability_missing`（内链「宿主能力缺失」锚点）。
- `docs/usage.md:367`：task_run 插件注册路径返回 `{ok:false, reason:'capability_missing', message:'宿主未提供 sessionController，线程工具暂不可用'}`，与 `src/index.js:166`/`:819` 逐字段一致。
- `docs/usage.md:636-649`（宿主能力缺失节）：「10 个工具一律注册 / execute 时读 `platform.capabilities.threadTools` / 稳定返回体 / /状态 与 /线程 每次调用实时判断 / 晚挂载免重装」全部到位。
- `docs/platform-api.md:309-317`（§5）：整段重写为「一律注册、调用时判能力（运行时 getter 非 apply 期快照）、不抛异常（空参数也是该对象）、晚挂载恢复、/status 与 /threads 实时判断、单一常量文案、`threadTools` 语义=此刻能否执行」——与实现（`src/index.js:791-793`/`:819`、`src/runtime/commands.js:36`/`:157`/`:540`、`src/platform/adapter.js:303`）方向完全一致。
- 残留扫描：全库按「不注册 thread_run / 未注册 / thread_run/task_run/thread_\*」grep，living docs（usage/platform-api/known-debt）零命中；剩余命中只有历史记录（review-v9/v11、review-v14 引用原文），符合「历史不动」约定。`session-unavailable` 在 usage.md 仅剩两处，且都是正确限定的「工具集单独构造时」语义，不是旧契约残留。

### 2) L 关闭 ✅

- `docs/usage.md:430-439`（隐私与凭据，V7-M3）：覆盖识别范围（密码/passwd/验证码/CVV/CVC/私钥/卡号/API key/access token/令牌/`sk-` 字面值 + 字段名+值形式）、不写 facts（含 FTS）与 reminders、状态板逐行过滤含历史敏感行、episode 保留、每轮一次固定提示与建议句「这类信息建议放环境变量或文件里，我不代为保存。」——与 `govern.js:34` `CREDENTIAL_HINT` 原文一致。
- `docs/usage.md:488-498`（压缩起点跳过系统节点，V7-M1）：firstReplaceableIndex 起点收紧、节点 0 角色未知保守跳过、中途系统节点提前收尾、`no-replaceable-range`、pending 丢弃 + `compactionDrops` + warn 日志、三条路径共用收紧、边界说明与 known-debt 互链——与 `surface.js:218-232`/`:147`/`:166-177`、`index.js:2378-2391` 行为一致。
- `docs/known-debt.md:130`（§5 已关闭顶部新增 V7-M1 条目）：含复审要求的「观察项（终点 fence 未做）：恢复的 pending 只收紧起点、未收紧终点；平台只保护 node 0，跨版本旧 pending 中段系统节点仍可能被跨过」，并注明两处文档已补记。

### 3) 实现零改动 + 亲跑 ✅

- `git diff d6c1443..HEAD --stat`：仅 `docs/known-debt.md`（+1）、`docs/platform-api.md`（19 行改）、`docs/review-v14.md`（+106，复审文档提交本身）、`docs/usage.md`（+33）——无任何 `src/`、`scripts/`、`test/` 改动。
- 三时区全量 `node --test` 亲跑：**859 pass / 0 fail** × 3。
- `test/e2e/plugin-smoke.test.js` 三时区亲跑：4 pass / 0 fail × 3。
- 复测后 `git status --porcelain`：dirty=0。
- `git tag` 无 v0.4.9（最新仍 v0.4.8）；`git log origin/main..HEAD` 未推送（6 修复提交 + 2 文档提交），`package.json` 仍 0.4.8 属发布提交职责。

## 3. 发布裁定

- review-v14 判定 needs_revision 的唯一 M（R1 docs 契约不一致）与两条 L（终点 fence 观察项、文档缺口）全部关闭且经亲跑确认；findings 零残留。
- **v0.4.9 复审结论：pass（H=0 / M=0 / L=0），可进入发布提交**（version bump + CHANGELOG + tag + push 按发布流程执行）。��版本 pending 中段系统节点已登记为 known-debt 观察项，不阻断发布。
