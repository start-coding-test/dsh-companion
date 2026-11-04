/**
 * W5 S0 埋点口径（v0.4.1，S-M1）：把「被注入」和「真的被用上」分开。
 *
 * - `reneed_kind='recall'` 仍是注入侧的观测，但只作对照；
 * - `reneed_kind='used'` 由强化路径（复述重叠 ≥ USE_OVERLAP_THRESHOLD）写入，
 *   是 S0 标定的主样本；
 * - 同会话即时召回（写入后很快又注入）不算有效样本：原文多半还在上下文里，
 *   Δt 只有几分钟到几小时，会把低分位堆满并系统性压低 S0。这类样本照常
 *   落库，但标 `same_context=1`，统计时排除。
 *
 * 判定阈值 6h 是估计值（review-code-v0.4.0 S-M1），不是实测结论；调整只
 * 影响新样本的标记，不改已经写入的 first_reneed_*。
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
 * 1. 首次再需要距事实写入（created_at）不足 `minIntervalSeconds`；
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
