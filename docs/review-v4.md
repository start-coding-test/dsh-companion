# review-v4 — dsh-companion P2 批（v0.3.0-rc）独立复审

- 复审对象：`5996785`（`test(p2): export and vector e2e`），链条 `bce215c`(v0.2.0 release) → `4f9b403`(P2-a 导出与恢复) → `8969f48`(P2-b 可选向量召回) → `5996785`(P2-c e2e)。diff：20 files，+3810/−20。
- 方法：只读审查（未改 src）；`src/memory/export.js`（664 行）与 `src/memory/vector.js`（308 行）全文阅读，scripts 与关键 diff 逐项核验；全仓测试本地实跑。
- **结论：pass（H=0，M=0，L=3）。**

## 1. 回归实测（判据基础）

实测（后台 job `bash-7d6a5616a8444886`，exit 0）：

- `node --test`：**538 tests / 16 suites / 0 fail**（3741ms）。
- `TZ=UTC node --test`：**538 tests / 16 suites / 0 fail**（3825ms）。

新增 75 tests（v0.2.0 基线 465 → 538）：export.test.js 13 + export-more.test.js 14 + vector.test.js 13 + store-vector.test.js 10 + retrieve-vector.test.js 7 + config-vector.test.js 9 + status-vector.test.js 3 + e2e p2.test.js 7（另有 3 处既有版本断言随 SCHEMA_VERSION '4'→'5' 更新，属卡要求）。新文件 `node --check` 全过。

## 2. 重点①：导出过滤与恢复一致性

`src/memory/export.js`：

- `readFacts`（:116-128）：只取 `scope=? AND status='active' AND deleted_at IS NULL AND privacy NOT IN ('sensitive','secret')` + `sensitive` 动态列过滤（PRAGMA `table_info` 探测，兼容 P1-a 之前的旧库）+ `isPrivateText(statement)` 文本级兜底；**superseded/dormant 经 `status='active'` 条件排除**，墓碑经 `deleted_at IS NULL` 排除。
- `readEpisodes`（:136-148）：排除 tombstoned/deleted/privacy 敏感 + title/summary/evidence/mood_evidence 拼接的敏感文本过滤。
- `readReminders`（:150-167）：排除已删除 + title/detail/counterparty 敏感文本过滤。
- 状态板专门防泄漏：`scrubBoard`（:201-208）把「未导出事实的 statement」从渲染行里行级剔除（:224-236 收集 excludedStatements），避免 facts 过滤了但 board 泄漏。
- 恢复一致性：e2e `test/e2e/p2.test.js:256-344` 导出→fresh 恢复，facts/episodes/reminders/threads/board 逐项相等且 FTS 可检索；单测 `export.test.js:236`、`export-more.test.js:204`（observed_at/strength_days/source_excerpt 等字段逐值保留）。
- scope 隔离：`export-more.test.js:119`；空库计数 0（:132）；threads 归档保留（:176）；md 格式不泄漏敏感（export.test.js:184）。

## 3. 重点②：fresh 空库约束、merge 去重、事务零落库

- `isTargetEmpty`（export.js:364-376）：facts/episodes/reminders/threads/state_board 五表 COUNT>0 即拒绝；容忍空状态板占位行；**目标库非空时拒绝且不写入**（export.test.js:260）。
- 合法性前置：version 必须 `EXPORT_VERSION=1`、data 结构校验（export.test.js:284）。
- merge：按主键 `skipIfExists` 跳过（facts.id / threads.key / reminders.id），threads 冲突保留目标内容（export-more.test.js:224）、同 id reminder 不覆盖 active（:268）、已有非空状态板时不覆盖目标 revision（:249）；episodes 先于 facts 写以满足 FK；导出集中未导出的巩固/墓碑引用经 `existingReference` 置 null（consolidation_id/source_episode_id/superseded_by，export.js:400-404）。
- 事务：import 在 `store.transaction` 内单事务，任一行失败整体回滚（export.js 注释 + `export.test.js:333` 事务失败零落库）。
- FTS 恢复：逐行 `rebuildFactFts`/`rebuildEpisodeFts`（export.js:421-440 起），e2e 断言恢复后 bigram 可检索。

## 4. 重点③：加密导出的 KDF/IV/认证标签与口令安全

`encryptJson/decryptJson`（export.js）：

- AES-256-GCM + scrypt（`SCRYPT_N=2^14, r=8, p=1`，maxmem 64MB，常量公开于 :33-35）；salt(16B)/iv(12B) 每次 `randomBytes` 随机，同明文两次加密密文不同但均可解（export-more.test.js:288）；tag 随明文 JSON header 存储（version/cipher/kdf/N/r/p/salt/iv/tag/id/created_at），magic `DSH-COMPANION-EXPORT-1`；decrypt 校验 magic 与 header 算法白名单，错口令统一报「解密失败（口令错误或文件损坏）」（export.test.js:349）。
- 口令安全：两个 CLI（scripts/export-encrypted.mjs / decrypt-encrypted.mjs）口令**只从 stdin 读取**，TTY 时关闭回显（setRawMode），错误口令非零退出；**空口令/缺 --out/缺 fact 退出 1**；解密先 decryptJson 成功后才写 --out（不产生明文半文件，e2e p2.test.js:346-390）；代码无任何打印/记录口令路径；命令层回显只有 counts + path，无语料与口令。
- 残余（L1）：header 字段未参与认证（无 AAD），详见 §8。

## 5. 重点④：向量表迁移幂等、schema v5 兼容 v4

- `SCHEMA_VERSION='5'`；`fact_vectors(fact_id PK REFERENCES facts ON DELETE CASCADE, dim, vec BLOB, updated_at)` + `ix_fact_vectors_dim`，DDL `CREATE TABLE/INDEX IF NOT EXISTS`——**Store.open 对 v5 库重复执行幂等**；`#migrateFrom('4')` 只 UPDATE schema_meta 版本，不动数据（旧事实向量留待下次写入/编辑重建，属卡设计且被 e2e ⑦「恢复后向量缺失不崩溃、updateFact 后重建可用」覆盖，p2.test.js:676-723）。
- 兼容性测试：`store-vector.test.js:123`（v4 库升级到 v5，只建 fact_vectors 并保留既有事实与 FTS）、`:145`（未知版本仍抛 `unsupported schema_version`）；v3→v4 原迁移逻辑保留。
- `setVectorDim`（store.js:524-545）：越界 TypeError，dim 变化清旧维投影、新写入用新维度（store-vector.test.js:109）。

## 6. 重点⑤：hybrid RRF 去重、关闭不变、dim 校验

- `hybridSearch`（vector.js）：FTS 与向量两路按 `type:id` 融合 Map 累加 `1/(k+rank)`，**同一 fact 只留一条**（vector.test.js:151/:195）；空路各自退化、无命中返回空（:169）。
- `searchVector`：只召回 active+normal+未删+sensitive=0+R≥0.05 的行，dim 参数化 JOIN（vector.test.js:104/:123/:137）。
- `cosine`：dim 不符 TypeError、零向量 0（:58/:65）；`hashEmbed` 确定性、L2 归一、代码注释明确「非生产质量」。
- **关闭路径不变**：config 默认 `vector.enabled=false`；retrieve.js 关闭分支为原 searchBigram 原路径，`retrieve-vector.test.js:44/:102` 断言返回结构与 v0.2.0 一致且不读向量表，e2e p2.test.js:391「与 v0.2.0 完全一致（无 vectorHits）」；`embedder='none'` 同样退化（:69）。
- config 校验面：dim 8..4096 边界、embedder 白名单 hash/none、未知子键 warning、`DEFAULTS.vector` 不可枚举保持既有 13 键自检（config-vector.test.js 9 例）。
- /状态 展示「向量：关 / 开·dim X·最近命中 N」（status-vector.test.js 3 例）。

## 7. 重点⑥：向量索引与删除/编辑/治理的同步

`#syncFactVector` 在 insertFact / updateFact / forgetFact(墓碑) / reinforce(USE) / #purgeRows 全链挂钩；保留条件 `deleted_at IS NULL AND status='active' AND privacy='normal' AND (sensitive IS NULL OR sensitive=0)`，否则 DELETE 投影：

- 写入/更新重建：`store-vector.test.js:44/:64`；status→superseded/tombstoned 删投影（:80/:88）；deleteFact 软删同步删向量（:99）；sensitive/secret 事实不写向量（:55）。
- **治理联动**：governance 走 `updateFact` 标 superseded → 向量删除；标 sensitive=1 → 向量删除且不再从向量通道召回（store-vector.test.js:64/:80、retrieve-vector.test.js:148、e2e p2.test.js:499「治理后再导出：superseded 与敏感条目不进导出，也不进向量索引」）。
- purge 物理删行（先断外键引用）时 fact_vectors 因 `ON DELETE CASCADE` 同步清理。

## 8. Finding 表（新增发现）

| id | 严重级 | 摘要 | 证据 | requiredFix（可选改进，不阻塞） |
| --- | --- | --- | --- | --- |
| L1 | low | encryptJson 的 JSON header（含 salt/iv/tag/kdf 参数）不参与认证（未用 setAAD）；篡改 KDF 参数只会导致解密失败（tag 不匹配），不泄密文，但 id/created_at 可被伪造且鲁棒性依赖 magic+白名单校验 | src/memory/export.js encryptJson/decryptJson | 后续 P3 用 setAAD 绑定 header（或把 header 字段并入 GCM 关联数据） |
| L2 | low | exportAll 的 schema_version 读取对 store 无 getMeta 时兜底误标 '4'（当前实际只可能是 '5'）；仅影响文档性字段准确性 | src/memory/export.js:342-349 | 兜底改为未知时置 null 或直接读库内实际 meta |
| L3 | low | 文件名时间戳精度到分钟（memory-YYYY-MM-DD-HHmm.<fmt>），同一分钟内重复导出会静默覆盖同名文件 | src/memory/export.js:73-78/:343 | 加秒粒度或目标存在时追加序号；不影响恢复语义 |

- H=0；M=0。Open objectives：无。

## 9. 重点⑦与⑧：依赖/$DSH_HOME 与实跑

- **依赖**：`package.json` dependencies/devDependencies/peerDependencies/optionalDependencies 全为 {}；export.js/vector.js import 仅 `node:` builtins 与仓库内相对模块，无新增第三方依赖。
- **$DSH_HOME**：全 grep 仅命中注释与 calibrate/probe 脚本（把 DSH_HOME 指向**仓库内 .data 临时目录**，属 P2 之前既有行为）；src 无任何写 $DSH_HOME 的代码。
- **实跑**：`node --test` 与 `TZ=UTC node --test` 双实跑全绿（§1）；P2-c 阶段另验 `TZ=America/New_York` 538/538（依赖结果）。

## 10. 残余风险（不阻塞）

1. L3 的分钟粒度覆盖：自动备份场景若每分钟>1 次导出，只保留最后一份；建议在 PATCH 时加秒或存在即后缀。
2. hashEmbed 是字符 bigram FNV-1a 语义近似向量，明确标注非生产质量；对中文语义召回效果有限（bench 输出 100%/100%/100% 属该项目自评口径）；未来可换真 embedding provider，embedder 白名单已留接口。
3. CI 仍无常驻 TZ 矩阵（沿 review-v2/v3 建议项）；本地双 TZ 实跑已覆盖本次审查。

## 11. 命令复现

```bash
cd dsh-companion
node --test                 # 538/538, 16 suites, 0 fail
TZ=UTC node --test          # 538/538, 16 suites, 0 fail
node --check src/memory/export.js src/memory/vector.js scripts/export-encrypted.mjs scripts/decrypt-encrypted.mjs scripts/bench-vector.mjs
git status --porcelain      # clean
```

复审人：reviewer（t24 / P2-d），2026-11-04。
