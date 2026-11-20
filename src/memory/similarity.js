/**
 * L120-H1：文本近似相似度（bigram 集合 Jaccard）。
 *
 * 现网 `vector.enabled=false`、`embedder=hash`——哈希特征没有语义，故「同一件事
 * 换了说法」只能用字面近似衡量：把两段文本按 {@link toBigrams} 同一套规则切成
 * bigram 集合，再算集合 Jaccard（交集 / 并集）。中文按重叠二元组切分，英文按整词，
 * 与 FTS 索引口径一致，避免「匹配口径」和「打分口径」两套。
 *
 * 与 `govern.js` 的私有 `jaccard` 同算法；这里独立导出，供巩固去重（H1）、
 * 提醒去重（M2）与治理（M1）复用。纯函数、零依赖、无 I/O。
 */

import { toBigrams } from './bigram.js';

/**
 * 文本 → bigram 集合。空文本返回空 Set。
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function textBigrams(text) {
  const raw = toBigrams(text);
  if (raw === '') return new Set();
  return new Set(raw.split(' ').filter((token) => token !== ''));
}

/**
 * 两个 bigram 集合的 Jaccard 相似度；任一为空集时返回 0（无法证明相似）。
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {number} 0..1
 */
export function jaccard(left, right) {
  const a = left instanceof Set ? left : new Set(left ?? []);
  const b = right instanceof Set ? right : new Set(right ?? []);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  if (shared === 0) return 0;
  return shared / (a.size + b.size - shared);
}

/**
 * 便捷封装：直接比较两段文本。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number} 0..1
 */
export function textSimilarity(left, right) {
  return jaccard(textBigrams(left), textBigrams(right));
}
