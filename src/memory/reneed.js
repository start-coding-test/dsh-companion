/**
 * W5 S0 埋点口径（v0.4.2，S2-M1 + L2-1）：把「被注入」和「真的被用上」分开。
 *
 * - `reneed_kind='recall'` 仍是注入侧的观测（`first_reneed_*` / `same_context`），
 *   只作对照；后续「用上」不改写这组 recall 样本；
 * - 「用上」由强化路径（复述重叠 ≥ USE_OVERLAP_THRESHOLD）写入
 *   `first_used_at` / `first_used_tier` / `used_same_context`，并以 `reneed_kind='used'`
 *   标记为 S0 标定的主样本。首次语义 = 首次「非 same_context 的用上」：
 *   same_context 的 used 照常记录，之后出现非 same_context 的 used 可覆盖一次；
 * - 同会话即时召回（写入后很快又注入）不算有效样本：原文多半还在上下文里，
 *   Δt 只有几分钟到几小时，会把低分位堆满并系统性压低 S0。这类样本照常
 *   落库，但标 `same_context=1` / `used_same_context=1`，统计时排除。
 *
 * 判定时间统一用事实的 `observed_at`（原话时间，L2-1），取不到时依次退回
 * 来源 episode 的时间与 `created_at`，见 `resolveObservedAt`。
 *
 * 判定阈值 6h 是估计值（review-code-v0.4.0 S-M1），不是实测结论；调整只
 * 影响新样本的标记，不改已经写入的 first_reneed_* / first_used_*。
 */

/** 同会话即时召回的最小间隔（秒）：Δt 小于它视为「来源还在上下文里」。 */
export const SAME_CONTEXT_MIN_INTERVAL_SECONDS = 6 * 60 * 60;

/**
 * `facts.reneed_kind` 的合法取值。`used` 是本版新增：强化路径判定「用上」
 * （assistant 复述重叠 ≥ 0.6）时写入。
 */
export const RENEED_KINDS = Object.freeze(['recall', 'dedupe', 'correction', 'used']);

/**
 * 是否属于「同会话即时召回」样本。
 *
 * 满足任一条件即算：
 * 1. 样本时刻距事实「原话时间」不足 `minIntervalSeconds`（调用方必须传
 *    observed_at 口径，见 `resolveObservedAt`）；
 * 2. 来源 episode 仍在当前 surface（原文还没被压缩掉）。
 *
 * 时间缺失/回拨时保守返回 false：宁可多算一个可疑样本，也不凭猜测把
 * 真实再需要排除掉。
 *
 * @param {{at?: number|Date|null, createdAt?: number|Date|null,
 *          sourceInSurface?: boolean, minIntervalSeconds?: number}} [input]
 * @returns {boolean}
 */
export function isSameContextSample({
  at = null,
  createdAt = null,
  sourceInSurface = false,
  minIntervalSeconds = SAME_CONTEXT_MIN_INTERVAL_SECONDS,
} = {}) {
  if (sourceInSurface === true) return true;
  const sampleAt = Number(at);
  const bornAt = Number(createdAt);
  if (!Number.isFinite(sampleAt) || !Number.isFinite(bornAt)) return false;
  const delta = sampleAt - bornAt;
  if (delta < 0) return false; // 时钟回拨：不臆测同会话
  let limit = Number(minIntervalSeconds);
  if (!Number.isFinite(limit) || limit <= 0) limit = SAME_CONTEXT_MIN_INTERVAL_SECONDS;
  return delta < limit;
}

/**
 * 来源 episode 是否仍在当前 surface。
 *
 * 巩固写入 episode 时记录了 `consolidations.upto_seq`（该窗口最后一个平台
 * 节点）。如果这个 seq 还在当前 surface，说明该段原文尚未被压缩替换，
 * 事实的来源上下文仍在眼前——此时召回属于「同会话即时召回」。
 *
 * @param {{seqs?: number[]|null, episode?: object|null,
 *          consolidation?: object|null}} [input]
 * @returns {boolean}
 */
export function episodeSourceInSurface({ seqs = null, episode = null, consolidation = null } = {}) {
  if (episode === null || typeof episode !== 'object') return false;
  if (consolidation === null || typeof consolidation !== 'object') return false;
  const upto = Number(consolidation.upto_seq);
  if (!Number.isFinite(upto) || upto <= 0) return false;
  return Array.isArray(seqs) && seqs.includes(upto);
}

/**
 * 事实「原话时间」口径（v0.4.2 / L2-1）：same_context 判定与 Δt 统一用
 * `observed_at`，而不是巩固写入时刻 `created_at`。
 *
 * 深睡/延迟巩固时 `created_at` 可能比原话晚几个小时，拿它计时会把 Δt 算短、
 * 6h 判定偏严（review-code-v0.4.1 L2-1）。取值顺序：
 * 1. `fact.observed_at`（原话时间，正常路径）；
 * 2. 来源 episode 的 `observed_at`（防御性：旧库/导入行可能没有该列）；
 * 3. episode 的 `started_at`，再退 `created_at`（情景发生时刻）；
 * 4. 最后才退 `fact.created_at`（巩固时刻）。确实拿不到原话时间时只能接受
 *    这一偏差：用迟到的巩固时刻计算，会更容易判成同会话（保守排除），
 *    而不是把可疑样本算进主分布。
 *
 * @param {{fact?: object|null, episode?: object|null}} [input]
 * @returns {number|null} Unix 秒；全部缺失时 null
 */
export function resolveObservedAt({ fact = null, episode = null } = {}) {
  const candidates = [
    fact?.observed_at,
    episode?.observed_at,
    episode?.started_at,
    episode?.created_at,
    fact?.created_at,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
