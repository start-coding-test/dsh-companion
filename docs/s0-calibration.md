# S0 标定流程（W5：首次再需要埋点）

> 状态：**流程已定义，尚未执行校准**。文中分位数与目标 S 都是「起始值，待定」，不是实测数据。
> 本文是 `dsh-companion` 仓库内的实现说明，只写「怎么量、怎么算、怎么调」，**不改 `memory/` 设计文档**；
> 口径以 `memory/docs/01-需求与约束.md` §5.6、`memory/docs/06-记忆系统设计.md` §10（:677）与 M-Q2 为准；与 `docs/calibration.md`（首次安装自检）无关。

## 1. 结果定义

「再被需要」分两层观测（v0.4.2 / S2-M1）：

- **用上（主信号）**：记忆被召回注入后，下一轮 assistant 复述与事实原文重叠 ≥ `USE_OVERLAP_THRESHOLD`（0.6），强化路径把 `reneed_kind` 升级为 `used`。这是 S0 标定的主样本。
- **只被注入（对照）**：召回注入本身（`reneed_kind='recall'`）只说明它进了上下文，不等于被回复用上；保留作对照与诊断，**不进主分布**。
- **漏**：去重命中沉睡/墓碑旧行（`dedupe`）或用户显式纠正（`correction`），仍按 miss 计。

「用上」与「只被注入」分开记录：`used` 在**用上那一刻**写入 `first_used_at` / `first_used_tier` / `used_same_context`；`recall` 样本的 `first_reneed_at` / `first_reneed_tier` / `same_context` 原样保留，供对照，不因后续升级而被覆盖。`dedupe` / `correction` 是更早的「漏」样本，不会被后续「用上」覆盖。

「首次用上」指**首次非 same_context 的用上**：same_context 的 `used` 照常记录，但之后出现非 same_context 的 `used` 时允许覆盖一次；已经是非 same_context 的 `used` 不再被后续用上覆盖。

| 结果 | 判定 | 时间/档位字段 | `reneed_kind` |
| --- | --- | --- | --- |
| 用上·清晰 | 召回注入且下一轮复述重叠 ≥0.6；用上时 `R ≥ 0.5`（`full`） | `first_used_tier = clear` | `used` |
| 用上·模糊 | 同上；用上时 `0.2 ≤ R < 0.5`（`gist`） | `first_used_tier = ambiguous` | `used` |
| 漏·去重 | 巩固去重命中同一 key 的旧行，而旧行已 `index`（0.05≤R<0.2，沉睡）/ `dormant`（遗忘）/ 墓碑 | `first_reneed_tier = miss` | `dedupe` |
| 漏·纠正 | 用户明说「你又忘了」或指出旧事实记错，且能定位到旧 fact | `first_reneed_tier = miss` | `correction` |
| 仅注入（对照） | 召回注入但下一轮未见复述用上 | `first_reneed_tier` = `clear` / `ambiguous` | `recall` |
| 白存 | 观测满 14 天仍无 `first_reneed_at` 且无 `first_used_at`（从未被召回、用上，也未被去重/纠正命中） | — | — |

- **同会话即时召回不算有效样本**：`recall` 样本写入时若 `first_reneed_at - observed_at < 6h`，或来源 episode 仍在当前 surface（原文尚未被压缩掉），标 `same_context=1`；`used` 则在**用上那一刻**用 `first_used_at - observed_at < 6h` 或「来源 episode 的 `upto_seq` 仍在 surface」重新判定，写入 `used_same_context=1`，统计时排除。6h 是 review-code-v0.4.0 S-M1 的估计值，不是实测结论；调整只影响新样本的标记。
- **曾经即时召回，不等于这个事实永远被排除**：v0.4.1 把 `same_context=1` 沿用到 `used` 上，导致「几小时内被注入过、几天后真被用上」的主样本大量流失。v0.4.2 改为用上时重点判定：首次用上是 same_context 的样本先记录，之后出现非 same_context 的用上可覆盖一次，该事实仍可进入主样本。
- 不计入样本：`pinned`（不衰减）；用户显式遗忘的墓碑（除非后续去重命中，按「漏·去重」记）；`used_same_context=1`；`recall` 对照样本。
- 白存只作删除/容量候选，**不是漏**，也不能反推 S0 太长（两周窗口会删失，见 §4）。
- 同一事实先命中后又被纠正：保留首次 `recall`/`used` 样本，纠正只进审计，不改写 `first_reneed_*` 或 `first_used_*`。
- **`used` 样本必然走过强化**（`recall_count ≥ 1`），强化是测量事件本身；不要再用「已强化」把 `used` 样本剔除，样本强度取事件发生前的 S0。

## 2. 目标与公式

本系统 `R = exp(−Δt / S)`。要求在该档「再次被需要间隔」的 P80–P90 处仍有 `R ≥ 0.2`（至少还能以模糊档、靠强线索召回）：

    R(Δt_P90) = exp(−Δt_P90 / S) ≥ 0.2
    ⇒ S ≥ Δt_P90 / ln 5 ≈ Δt_P90 / 1.61

- P80 自动满足（P80 ≤ P90），约束实际由 P90 决定；取等号作为新 S0，向上取整：`S0_new = ceil(Δt_P90 / 1.61)`（天）。
- 反查默认值能覆盖的 P90 上限（由设计值推导，不是实测）：`trivial 3 天 → ≤4.8 天`；`normal 14 天 → ≤22.5 天`。实测 P90 超过上限即 S0 偏短。
- 单轮只动一档，幅度限制在旧值 `0.5×–2×`，且不小于 1 天，避免两周小样本把参数拉飞。
- **P50/P80/P90 与目标 S 均为「起始值，待定」**：每档非删失样本 `n ≥ 30` 才按 P90 定值；`n < 10` 只看方向（调长/调短），不改默认；`10 ≤ n < 30` 可微调但标注样本不足。
- **样本过滤后的口径**：S0 的 Δt 分位数只在**主样本**（`reneed_kind = 'used'` 且 `used_same_context = 0`）上计算；`dedupe` / `correction` 只用于漏率审计，不并入 Δt 分位（它们记录的是「直到漏掉」的时长，不是再需要间隔）；只被注入的 `recall` 样本、同会话即时召回样本都不参与，避免把「原文还在上下文里」的几分钟间隔堆进低分位、系统性压低 S0。
- `notable` / `explicit` / `pinned` 本轮不动（§4）。

## 3. 与 FSRS 的关系：只借方法，不搬数值

| | FSRS | 本系统 |
| --- | --- | --- |
| 曲线 | 幂律：`R=(1+19t/(81S))^(−1/2)` | 指数：`R=e^(−t/S)` |
| `S` 的含义 | `R=0.9` 时的间隔 | 指数时间常数；`t=S` 时 `R≈0.37` |
| 目标保持率 | 常用 0.9 | 分档线 0.5 / 0.2 / 0.05；本标定要求 P90 处 ≥0.2 |

- 借的只有方法：用真实再需要间隔的分位数反推强度，而不是拍一个天数。
- 不搬 FSRS 的 `w` 参数、初始/默认 S 值、0.9 目标保持率，也不把幂律硬套到本系统；两套 `S` 数值不可互换。
- 若实测显示指数曲线明显不合（例如危险率不恒定），那是设计变更：单独评审并记入 review，不在标定中偷偷换曲线。

## 4. 窗口与档位约束

- **两周窗口只标定 `trivial` / `normal`**：`notable`=60 天、`explicit`=365 天，两周内 P80–P90 几乎必然删失（观测不到 >14 天的间隔），保留默认值；等 2–3 个月真实日志再按同一流程补标。
- 两周窗口内 Δt ≤14 天；`normal` 的 P90 若贴近 14 天，只是下界，应延长到 28 天再判，而不是直接加倍 S0。
- **伪造时钟只验证公式**：注入 `now` 可验证 `t=S→R≈0.37`、`R=0.2→t≈1.61S`、`R=0.5→t≈0.69S` 以及四档边界；它不产生「什么时候被需要」——那是用户行为，只能等真实日志。
- 只用窗口内已观测的再需要样本算 P90，会因右删失偏低；叠加单用户、单场景、两周，结论只定方向，定值要更长窗口。

## 5. 埋点字段（schema v9 已落地）

`facts` 在 v7/v8 的 `first_reneed_at` / `first_reneed_tier` / `reneed_kind` / `same_context` 之外，v9 再增三列 `first_used_at` / `first_used_tier` / `used_same_context`（均可空）；v3–v8 旧库可打开并幂等迁移，旧行新增三列为 `NULL`（历史样本无法回填「用上」时间）。

| 列 | 类型 | 语义 |
| --- | --- | --- |
| `first_reneed_at` | INTEGER | 首次**再需要事件**（recall / dedupe / correction）的 Unix 秒；只写一次，作为 recall 对照与漏样本时间 |
| `first_reneed_tier` | TEXT | 对应事件的 `clear` / `ambiguous` / `miss` |
| `reneed_kind` | TEXT | `recall`（仅注入，对照）/ `used`（用上，主样本）/ `dedupe` / `correction` |
| `same_context` | INTEGER | `1` = 首次再需要事件发生在同会话即时上下文（Δt<6h 或来源 episode 仍在 surface）；只约束 recall/dedupe/correction 对照 |
| `first_used_at` | INTEGER | 首次「用上」的 Unix 秒：same_context 的 `used` 先记录，之后首次非 same_context 用上覆盖一次；已有非 same_context 不再覆盖 |
| `first_used_tier` | TEXT | 用上时的档位 `clear` / `ambiguous` |
| `used_same_context` | INTEGER | `1` = 该次用上仍是同会话即时上下文；`0` = 主样本 |

- **写入口径**：`recall` / `dedupe` / `correction` 关注首次再需要，走 `store.markFirstReneed(id, {at, tier, kind, sameContext})`，`first_reneed_at` 只写一次；`used` 走 `store.markReneedUsed(id, {at, tier, sameContext})`，写 `first_used_at = 当前用上时刻`、`first_used_tier = 本轮实际注入档位`（index 档记为 `miss`，不用库内 `fidelity` 反猜）、`used_same_context = 当场重新判定的 same_context`，并只把 `reneed_kind` 升级为 `used`，不改 `first_reneed_*`。`used_same_context` 的覆盖条件是 `NULL` 或「已有 `1`、本次 `0`」；已有 `0` 不再覆盖；`dedupe` / `correction` 不会被 `used` 改写。
- **`used` 行允许没有 recall 样本**：index 档注入不写 `first_reneed_at`（只进本轮注入记录），若下一轮就被复述用上，`used` 行的 `first_reneed_at` 保持 `NULL` 是合法状态。此后即使 full/gist 档再次注入，`markFirstReneed` 也会因 `reneed_kind='used'` 整体跳过：不得补写晚于 `first_used_at` 的对照时间，也不得把 `reneed_kind` 降级回 `recall`。因此 `first_reneed_*` 始终只是「recall 对照样本」，主样本（`used`）只依赖 `first_used_*` / `used_same_context`。
- **Δt 与 same_context 用 `observed_at`（L2-1）**：用上时间 `first_used_at` 记录的是真实用上时刻，Δt 从**原话时间** `facts.observed_at` 起算，而不是巩固时刻 `created_at`；same_context 的 6h 判定同样以 `observed_at` 为起点。取不到 `observed_at` 时，`index.js` 的 `factOriginTime` / `resolveObservedAt` 依次退回来源 episode 的 `observed_at`、`started_at`、`created_at`，最后才用 `fact.created_at`；该回退顺序写在代码注释里。SQL 侧以 `observed_at` 为准，并把 `observed_at = 0` 的历史异常行排除。
- schema 演进：v7 增加 `first_reneed_*`；v8 增加 `same_context` 并把 `reneed_kind` 合法值扩为含 `used`（幂等触发器校验，不重建表）；v9 增加 `first_used_*` / `used_same_context`，v8→v9 只推进版本、列由打开时检测补齐；重复打开幂等。
- 索引 `(scope, first_reneed_at)` 与 `(scope, first_used_at)`（`ix_facts_used`）。
- `used_same_context` 的判定实现在 `src/memory/reneed.js`：`isSameContextSample({at, createdAt, sourceInSurface})`（Δt<6h）与 `episodeSourceInSurface`（来源 episode 的 `consolidations.upto_seq` 仍在当前 surface）。`src/index.js` 的 `markUsedReneed` 用 `resolveObservedAt` 得到的原话时间作 `createdAt` 传入。
- **历史 v8 及更早样本没有 `first_used_*`**：升级后旧行新列为 `NULL`，无法事后补判「何时真正用上」；两周评测应从 v9 上线后开始计时，旧样本只可作 `recall` 对照，不能混入主分布。
- 去重命中旧条目必须在**同一事务**写旧行埋点，且**不得复活**旧记录（t7 验收）。
- `episodes` 本轮不加埋点；标定主样本只用 `facts`。
- **推断类单独统计**：推断事实的 S0 设计上降一档（`memory/docs/06-记忆系统设计.md` §5:244），混进主分布会拉低均值。当前 `facts` 没有 `confidence`/inferred 标记（`source_kind` 虽允许 `'inferred'`，但巩固路径一律写 `'consolidated'`；`store.js` 迁移注记也写明「无 confidence」），标定前只能人工抽样剔除；不要用 `source_kind <> 'inferred'` 假装已经分开。
- 不要复用 `memory_events.action='USED'`：`tokens` 指标、提醒跟进、备份失败也写 `USED`（`src/index.js` 三处），统计会被污染；首次再需要只用上面的埋点列。

## 6. 前置条件（不满足就不要开始计时）

1. **N-L1 / L-2 已修（v0.4.0 / v0.4.1）**：v0.3.2 的确认词用 `String.includes` 匹配，单独的「对」会命中「对比」「对话」「对不起」「不对」，把普通复述误判成确认，α 从 2 抬到 4（`CONFIRM_ALPHA`），S 被系统性抬高，再需要间隔就不可信。v0.4.0 的边界/否定守卫与回归测试已落地；v0.4.1 再给确认词加长度上限（去掉标点/空白后超过 10 字直接不算确认，`CONFIRM_MAX_CHARS`），避免「对，我明天要去北京开会，顺便……」被当成确认。可开始计时；同时抽查「复述重叠 ≥0.6」判定（`USE_OVERLAP_THRESHOLD`），避免无关事实被当成用上。
2. **salience 分档抽样核对**：随机抽 50 条（覆盖各档），按 `memory/docs/06-记忆系统设计.md` §5 的判据人工复核。若错档 >20%（经验阈值）、某档 <5 条、或 >80% 都判成 `normal`，先改巩固 prompt 再标定；否则是在拟合噪声。
3. **埋点先于评测**：先升级 schema v9，确认新事实的 `first_used_at` / `used_same_context` 为 `NULL`、`first_reneed_*` 在首次召回时写入；历史行不回填。v0.4.2 埋点改完前开始计时的数据不能与之后混用。
4. **环境稳定**：同一 persona、模型、使用强度；主动提醒、线程消息、任务回执**不算**「被需要」。
5. **样本量预期**：单用户两周只定方向（§4）；要定值，先攒到每档 n≥30。

## 7. 操作流程

1. **上埋点**：升级 schema v9，确认旧行 `first_used_*` / `used_same_context` 为 `NULL`；手工造一次召回，验证 `first_reneed_*` 只写一次、二次不覆盖；再造一次复述用上，验证 `first_used_at` 等于用上时刻、`first_reneed_*` 不变；最后造一次 same_context 用上后再造一次非 same_context 用上，验证 `used_same_context` 从 1 覆盖为 0、且不会反向覆盖。
2. **计时**：记下 `:from`（上线后第一条新事实的时间），跑满 14 天；冻结 S0/α/prompt/模型，期间不做手工记忆编辑；异常事件（出差、冲刺）记备注。
3. **导出**：用下面 SQL（schema v9；`:from/:to/:scope` 由脚本注入）。主样本只用 `used` 且 `used_same_context=0`；`recall` 只作对照；`dedupe` / `correction` 只算漏率审计；同时 `VACUUM INTO` 备份一份 DB，保证分位数可复算。

```sql
-- 主样本：首次非 same_context 的「用上」；Δt 从原话 observed_at 起算（L2-1）
WITH s AS (
  SELECT f.id, f.salience, f.first_used_tier, f.reneed_kind,
         f.used_same_context,
         (f.first_used_at - f.observed_at) / 86400.0 AS dt_days
  FROM facts f
  WHERE f.scope = :scope
    AND f.created_at >= :from AND f.created_at < :to
    AND f.reneed_kind = 'used'
    AND f.first_used_at IS NOT NULL
    AND f.first_used_at <= :to
    AND f.used_same_context = 0     -- 用上那一刻仍是同会话即时上下文的不算主样本
    AND f.observed_at > 0           -- 历史异常行没有原话时间，不能算 Δt
    AND f.salience <> 'pinned'
    AND f.source_kind <> 'inferred' -- 当前巩固路径不写此值；历史遗留若有则排除，见 §5
)
SELECT * FROM s ORDER BY salience, dt_days;
```

> `used` 样本由强化路径写入，必然 `recall_count ≥ 1`。不要再用旧口径的 `recall_count = 0` 过滤，否则会把主信号全部剔掉；`dedupe` / `correction` 也不按 `recall_count` 过滤（迟到纠正可能发生在强化之后）。

```sql
-- 对照：只被注入、未被用上（不进主分布）
SELECT f.salience, f.same_context, COUNT(*) AS injected_only
FROM facts f
WHERE f.scope = :scope
  AND f.created_at >= :from AND f.created_at < :to
  AND f.reneed_kind = 'recall' AND f.same_context = 0
  AND f.salience <> 'pinned'
GROUP BY f.salience, f.same_context;
```

```sql
-- 漏样本：只算 miss 率，不并入 Δt 分位
SELECT f.reneed_kind, COUNT(*) AS n
FROM facts f
WHERE f.scope = :scope
  AND f.created_at >= :from AND f.created_at < :to
  AND f.reneed_kind IN ('dedupe', 'correction')
  AND f.same_context = 0
  AND f.salience <> 'pinned'
GROUP BY f.reneed_kind;
```

```sql
-- 口径审计：used 的 used_same_context 与 recall 的 same_context 各多少
SELECT reneed_kind,
       SUM(CASE WHEN used_same_context = 1 THEN 1 ELSE 0 END) AS used_same_1,
       SUM(CASE WHEN used_same_context = 0 THEN 1 ELSE 0 END) AS used_same_0,
       SUM(CASE WHEN same_context = 1 THEN 1 ELSE 0 END) AS reneed_same_1,
       COUNT(*) AS n
FROM facts
WHERE scope = :scope AND created_at >= :from AND created_at < :to
  AND (first_used_at IS NOT NULL OR first_reneed_at IS NOT NULL)
GROUP BY reneed_kind
ORDER BY reneed_kind;
```

```sql
-- 白存/删失：窗口内创建、观测满 14 天仍无任何再需要事件
SELECT salience, COUNT(*) AS total,
       SUM(first_reneed_at IS NULL AND first_used_at IS NULL) AS unused,
       SUM(first_reneed_at IS NULL AND first_used_at IS NULL
           AND created_at <= :to - 14 * 86400) AS white_14d
FROM facts
WHERE scope = :scope AND created_at >= :from AND created_at < :to
  AND deleted_at IS NULL AND salience <> 'pinned'
GROUP BY salience;
```

4. **算分位**（nearest-rank，零依赖）：

```js
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : NaN; };
// 按 salience 分组：n、p50、p80、p90；recall 只单列为对照，dedupe/correction 单列算漏率
```

5. **判读**：`n<10` 只看方向；`n≥30` 按 §2 算 `S0_new`；白存率高只影响删除/容量，不动 S0；推断类单列，不并入。
6. **只调 trivial/normal**：改 `src/memory/store.js` 的 `SALIENCE_STRENGTH_DAYS` 两行（只影响新写入事实；旧行保留原 `strength_days`），跑测试，填 §9 变更表并提交。下一窗口复测；连续两窗口 `n≥30` 且估值变化 ≤25% 视为稳定。
7. **2–3 个月后**：用同一 SQL 补标 `notable`/`explicit`，再决定是否调整。

## 8. 交叉引用与边界

- `memory/docs/01-需求与约束.md` §5.6：`R=e^(−Δt/S)`、四档 0.5/0.2/0.05、S0 表（3/14/60/365/∞）、推断降一档。
- `memory/docs/06-记忆系统设计.md` §10（:677）：S0 参数总表；同文 §12（:704）：评测计划。
- M-Q2（`01` 决策记录）：接受分档线与 S0 默认值，作为「起始值」。
- 实现落点：`src/memory/store.js` 顶部 `SALIENCE_STRENGTH_DAYS`（S0）、`reinforce.js`（α 与强化）、`retrieve.js`（0.5/0.2/0.05 分档）、`store.markReneedUsed`（`first_used_*` 覆盖规则）。
- 仓库内相关文档：[README](../README.md)（评测埋点摘要）、[使用手册](usage.md#巩固和压缩用的是哪个-seqv011-起)（schema 演进）、[Embedding 可插拔](embedding.md)（向量表与 `first_used_*` / `first_reneed_*` 无关）。
- **本文不改 `memory/` 设计文档**，只是仓库内可执行说明；实现与设计冲突时以设计为准并提 review。
- `docs/calibration.md` 是安装自检，与本文无关。

## 9. 变更记录

评测开始后逐行追加；**未跑之前本表为空，不得预填或编造**。

| 日期 | 档位 | 旧 S0 | 新 S0 | n | P50 | P80 | P90 | 依据/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 10. 局限（写进 review，不藏）

- 「用上」以「下一轮复述重叠 ≥0.6」判定，仍是文本相似度代理：改写、同义复述可能被判成「仅注入」，所以 `used` 是下界；但它不再把「注入即命中」算进来，方向比 v0.4.0 口径保守。`recall` 只作对照，不进主分布。
- **选择偏差**：主样本只包含「被召回且真被用上」的事实；从未被召回、召回失败（`dedupe` / `correction`）或始终没被需要（白存）的事实不进入 Δt 分位。`used` 又必然经过强化，样本条件在「召回成功」上，因此 P90 是存活样本的再需要间隔，不是所有事实的无条件间隔。v0.4.2 用「用上时重新判定 same_context、允许非 same_context 用上覆盖」减轻了 v0.4.1 把「曾经即时召回」整条排除的偏差，但不能消除上述条件化。
- **Δt 起点**：v0.4.2 统一以 `observed_at`（原话时间）起算，避免深睡/延迟巩固把 Δt 算短；若 `observed_at` 缺失而回退到 episode 或 `created_at`，仍有偏差，SQL 用 `observed_at > 0` 排除这类行。`same_context` 的 6h 阈值是估计值（review-code-v0.4.0 S-M1），不是实测结论；来源 episode 是否仍在 surface 依当前压缩进度判定，阈值调整只影响新样本。
- `used_same_context=1` 的首次用上被排除是**按事件**排除；之后若出现非 same_context 用上会覆盖为 0，因此不会像 v0.4.1 那样把整条事实永久排除。反过来，若某事实只有在同会话即时上下文里被用上，它对 S0 没有信息，排除是正确的。
- 漏只统计可发现的失败（精确 key 去重、显式纠正），同义改写会漏掉，漏率是下界。反过来，S0 过短会让事实在需要前掉出召回，表现为白存而非漏。
- `index`（沉睡）档召回不写 `recall`（t7 只记 full/gist），这类「该召回但已太弱」的样本只能靠去重/纠正发现，否则会被误记白存。
- 每条只记首次用上（非 same_context）；「第 N 次才漏」不在这些列里，后续可另加 append-only 事件，不阻塞本轮。
- 去重只认 `factKey(subject_text, predicate, object_text)` 完全相同；换说法的事实重复不进 `dedupe`。
- 两周单用户样本小，P90 不稳；结论只定方向，定值需更长窗口和更多样本。
- 改 S0 只影响新行；历史行按旧 S 衰减，复测时不要混窗口。
