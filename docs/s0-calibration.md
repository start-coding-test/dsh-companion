# S0 标定流程（W5：首次再需要埋点）

> 状态：**流程已定义，尚未执行校准**。文中分位数与目标 S 都是「起始值，待定」，不是实测数据。
> 本文是 `dsh-companion` 仓库内的实现说明，只写「怎么量、怎么算、怎么调」，**不改 `memory/` 设计文档**；
> 口径以 `memory/docs/01-需求与约束.md` §5.6、`memory/docs/06-记忆系统设计.md` §10（:677）与 M-Q2 为准；与 `docs/calibration.md`（首次安装自检）无关。

## 1. 结果定义

以「记忆在某一轮被召回注入」作为「再被需要」的代理信号；被注入不等于被回复用上，但它是目前唯一能逐条打时间戳的观测点（局限见 §10）。每条记忆只判一次首次再需要，写入后不覆盖。

| 结果 | 判定 | `first_reneed_tier` | `reneed_kind` |
| --- | --- | --- | --- |
| 命中·清晰 | 召回且 `R ≥ 0.5`（`full`） | `clear` | `recall` |
| 命中·模糊 | 召回且 `0.2 ≤ R < 0.5`（`gist`） | `ambiguous` | `recall` |
| 漏·去重 | 巩固去重命中同一 key 的旧行，而旧行已 `index`（0.05≤R<0.2，沉睡）/ `dormant`（遗忘）/ 墓碑 | `miss` | `dedupe` |
| 漏·纠正 | 用户明说「你又忘了」或指出旧事实记错，且能定位到旧 fact | `miss` | `correction` |
| 白存 | 观测满 14 天仍无 `first_reneed_at` | — | — |

- 不计入样本：`pinned`（不衰减）；用户显式遗忘的墓碑（除非后续去重命中，按「漏·去重」记）；已被强化过的样本（S 已不是 S0）。
- 白存只作删除/容量候选，**不是漏**，也不能反推 S0 太长（两周窗口会删失，见 §4）。
- 同一事实先命中后又被纠正：保留首次样本，纠正只进审计，不改写 `first_reneed_*`。

## 2. 目标与公式

本系统 `R = exp(−Δt / S)`。要求在该档「再次被需要间隔」的 P80–P90 处仍有 `R ≥ 0.2`（至少还能以模糊档、靠强线索召回）：

    R(Δt_P90) = exp(−Δt_P90 / S) ≥ 0.2
    ⇒ S ≥ Δt_P90 / ln 5 ≈ Δt_P90 / 1.61

- P80 自动满足（P80 ≤ P90），约束实际由 P90 决定；取等号作为新 S0，向上取整：`S0_new = ceil(Δt_P90 / 1.61)`（天）。
- 反查默认值能覆盖的 P90 上限（由设计值推导，不是实测）：`trivial 3 天 → ≤4.8 天`；`normal 14 天 → ≤22.5 天`。实测 P90 超过上限即 S0 偏短。
- 单轮只动一档，幅度限制在旧值 `0.5×–2×`，且不小于 1 天，避免两周小样本把参数拉飞。
- **P50/P80/P90 与目标 S 均为「起始值，待定」**：每档非删失样本 `n ≥ 30` 才按 P90 定值；`n < 10` 只看方向（调长/调短），不改默认；`10 ≤ n < 30` 可微调但标注样本不足。
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

## 5. 埋点字段（schema v7 已落地）

`facts` 增三列，均 nullable；旧行迁移后为 `NULL`（历史样本只能当删失，不回填）：

| 列 | 类型 | 语义 |
| --- | --- | --- |
| `first_reneed_at` | INTEGER | 首次再需要的 Unix 秒；`UPDATE ... WHERE first_reneed_at IS NULL`，只写一次 |
| `first_reneed_tier` | TEXT | `clear` / `ambiguous` / `miss` |
| `reneed_kind` | TEXT | `recall` / `dedupe` / `correction` |

- 索引 `(scope, first_reneed_at)`；入口 `store.markFirstReneed(id, {at, tier, kind})`，幂等。
- 去重命中旧条目必须在**同一事务**写旧行埋点，且**不得复活**旧记录（t7 验收）。
- `episodes` 本轮不加埋点；标定主样本只用 `facts`。
- **推断类单独统计**：推断事实的 S0 设计上降一档（`memory/docs/06-记忆系统设计.md` §5:244），混进主分布会拉低均值。当前 `facts` 没有 `confidence`/inferred 标记（`source_kind` 虽允许 `'inferred'`，但巩固路径一律写 `'consolidated'`；`store.js` 迁移注记也写明「无 confidence」），标定前只能人工抽样剔除；不要用 `source_kind <> 'inferred'` 假装已经分开。
- 不要复用 `memory_events.action='USED'`：`tokens` 指标、提醒跟进、备份失败也写 `USED`（`src/index.js` 三处），统计会被污染；首次再需要只用上面三列。

## 6. 前置条件（不满足就不要开始计时）

1. **N-L1 已修**：v0.3.2 的确认词用 `String.includes` 匹配，单独的「对」会命中「对比」「对话」「对不起」「不对」，把普通复述误判成确认，α 从 2 抬到 4（`CONFIRM_ALPHA`），S 被系统性抬高，再需要间隔就不可信。等 t4 的边界/否定守卫与回归测试落地后再计时；同时抽查「复述重叠 ≥0.6」判定（`USE_OVERLAP_THRESHOLD`），避免无关事实被当成用上。
2. **salience 分档抽样核对**：随机抽 50 条（覆盖各档），按 `memory/docs/06-记忆系统设计.md` §5 的判据人工复核。若错档 >20%（经验阈值）、某档 <5 条、或 >80% 都判成 `normal`，先改巩固 prompt 再标定；否则是在拟合噪声。
3. **埋点先于评测**：先升级 schema、确认三列为 `NULL`，再开始计时；历史行不回填。
4. **环境稳定**：同一 persona、模型、使用强度；主动提醒、线程消息、任务回执**不算**「被需要」。
5. **样本量预期**：单用户两周只定方向（§4）；要定值，先攒到每档 n≥30。

## 7. 操作流程

1. **上埋点**：升级 schema v7，确认旧行三列为 `NULL`；手工造一次召回，验证只写一次、二次不覆盖。
2. **计时**：记下 `:from`（上线后第一条新事实的时间），跑满 14 天；冻结 S0/α/prompt/模型，期间不做手工记忆编辑；异常事件（出差、冲刺）记备注。
3. **导出**：用下面 SQL（schema v7；`:from/:to/:scope` 由脚本注入）；同时 `VACUUM INTO` 备份一份 DB，保证分位数可复算。

```sql
-- 首次再需要样本：未强化、非 pinned；Δt 从写入起算
WITH s AS (
  SELECT f.id, f.salience, f.first_reneed_tier, f.reneed_kind,
         (f.first_reneed_at - f.created_at) / 86400.0 AS dt_days
  FROM facts f
  WHERE f.scope = :scope
    AND f.created_at >= :from AND f.created_at < :to
    AND f.first_reneed_at IS NOT NULL
    AND f.first_reneed_at <= :to
    AND f.recall_count = 0          -- 只在强化时 +1（store.reinforceFact）
    AND f.salience <> 'pinned'
    AND f.source_kind <> 'inferred' -- 当前巩固路径不写此值；历史遗留若有则排除，见 §5
)
SELECT * FROM s ORDER BY salience, dt_days;
```

```sql
-- 白存/删失：窗口内创建、观测满 14 天仍未被需要
SELECT salience, COUNT(*) AS total,
       SUM(first_reneed_at IS NULL) AS unused,
       SUM(first_reneed_at IS NULL AND created_at <= :to - 14 * 86400) AS white_14d
FROM facts
WHERE scope = :scope AND created_at >= :from AND created_at < :to
  AND deleted_at IS NULL AND salience <> 'pinned'
GROUP BY salience;
```

4. **算分位**（nearest-rank，零依赖）：

```js
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : NaN; };
// 按 salience 分组：n、p50、p80、p90、miss 率、kind 分布
```

5. **判读**：`n<10` 只看方向；`n≥30` 按 §2 算 `S0_new`；白存率高只影响删除/容量，不动 S0；推断类单列，不并入。
6. **只调 trivial/normal**：改 `src/memory/store.js` 的 `SALIENCE_STRENGTH_DAYS` 两行（只影响新写入事实；旧行保留原 `strength_days`），跑测试，填 §9 变更表并提交。下一窗口复测；连续两窗口 `n≥30` 且估值变化 ≤25% 视为稳定。
7. **2–3 个月后**：用同一 SQL 补标 `notable`/`explicit`，再决定是否调整。

## 8. 交叉引用与边界

- `memory/docs/01-需求与约束.md` §5.6：`R=e^(−Δt/S)`、四档 0.5/0.2/0.05、S0 表（3/14/60/365/∞）、推断降一档。
- `memory/docs/06-记忆系统设计.md` §10（:677）：S0 参数总表；同文 §12（:704）：评测计划。
- M-Q2（`01` 决策记录）：接受分档线与 S0 默认值，作为「起始值」。
- 实现落点：`src/memory/store.js` 顶部 `SALIENCE_STRENGTH_DAYS`（S0）、`reinforce.js`（α 与强化）、`retrieve.js`（0.5/0.2/0.05 分档）。
- **本文不改 `memory/` 设计文档**，只是仓库内可执行说明；实现与设计冲突时以设计为准并提 review。
- `docs/calibration.md` 是安装自检，与本文无关。

## 9. 变更记录

评测开始后逐行追加；**未跑之前本表为空，不得预填或编造**。

| 日期 | 档位 | 旧 S0 | 新 S0 | n | P50 | P80 | P90 | 依据/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 10. 局限（写进 review，不藏）

- 召回命中是「被需要」的乐观代理：注入但没用上也计命中；漏只统计可发现的失败（精确 key 去重、显式纠正），同义改写会漏掉，漏率是下界。反过来，S0 过短会让事实在需要前掉出召回，表现为白存而非漏。
- `index`（沉睡）档召回不写 `recall`（t7 只记 full/gist），这类「该召回但已太弱」的样本只能靠去重/纠正发现，否则会被误记白存。
- 每条只记首次需要；「第 N 次才漏」不在三列里，后续可另加 append-only 事件，不阻塞本轮。
- 去重只认 `factKey(subject_text, predicate, object_text)` 完全相同；换说法的事实重复不进 `dedupe`。
- 两周单用户样本小，P90 不稳；结论只定方向，定值需更长窗口和更多样本。
- 改 S0 只影响新行；历史行按旧 S 衰减，复测时不要混窗口。
