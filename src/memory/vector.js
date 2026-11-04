/**
 * P2-b：可选向量召回（离线版）。
 *
 * 本模块刻意保持零依赖、零网络：
 *   - `hashEmbed` 用字符 bigram 的 32-bit FNV-1a 哈希落到固定桶，再做 L2 归一。
 *     它只是可复现的离线/测试嵌入，**不是生产 embedding，也不承诺语义质量**；
 *     真实 embedding（P3）应通过外部 embed 函数注入。
 *   - `searchVector` 直接读 `fact_vectors`，只召回 active、normal、未墓碑且
 *     R ≥ 0.05 的事实；sensitive / secret 永不出现在向量通道。
 *   - `hybridSearch` 把 FTS 与向量两路用 RRF（reciprocal rank fusion）合并，
 *     同一 fact/episode 只保留一条，分数相加；任一路为空时自然退化为另一路。
 *
 * 该模块不持有 Store 单例，也不读全局时钟：store/now/embed 全部由调用方注入。
 */

import { decayOf } from './reinforce.js';

/** 默认向量维度（与 config.vector.dim 的默认值一致）。 */
export const DEFAULT_VECTOR_DIM = 256;
/** RRF 的平滑常数，论文常用 60。 */
export const DEFAULT_RRF_K = 60;
/** 向量召回的最低遗忘曲线阈值，与 retrieve 的 MIN_RECALL_R 一致。 */
export const MIN_VECTOR_R = 0.05;
/** 与 retrieve.js 一致：秒/毫秒以 1e11 为界。 */
const EPOCH_THRESHOLD = 1e11;

/**
 * 32-bit FNV-1a。对 UTF-16 code unit 逐位混合，结果确定且跨平台一致。
 * @param {string} text
 * @returns {number} 0..2^32-1
 */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** @param {unknown} value @returns {number|null} */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) < EPOCH_THRESHOLD ? num * 1000 : num;
}

/**
 * 转为 Float32Array；接受 Float32Array / number[] 等。
 * @param {unknown} value
 * @returns {Float32Array}
 */
function toVector(value) {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const array = Float32Array.from(value);
    for (const item of array) {
      if (!Number.isFinite(item)) throw new TypeError('[vector] vector contains non-finite values');
    }
    return array;
  }
  throw new TypeError('[vector] vector must be a Float32Array or number[]');
}

/**
 * 把 SQLite BLOB 还原为 Float32Array。
 *
 * node:sqlite 返回 Uint8Array；若按普通数组转 Float32 会把字节当分量，
 * 余弦值会趋近 0 而不是真实分数。这里按 little-endian 字节序重解释。
 * @param {unknown} value
 * @returns {Float32Array}
 */
function fromBlob(value) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('[vector] stored vector must be a BLOB');
  }
  if (value.byteLength % 4 !== 0) {
    throw new TypeError('[vector] stored vector has invalid byte length');
  }
  // slice 会复制到新的 ArrayBuffer（offset 0），因此不要求源 byteOffset 4 对齐。
  return new Float32Array(
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
  );
}

/**
 * 余弦相似度。维度不一致抛 TypeError；零向量返回 0（不产生 NaN）。
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} -1..1
 */
export function cosine(a, b) {
  const left = toVector(a);
  const right = toVector(b);
  if (left.length === 0 || right.length === 0) {
    throw new TypeError('[vector] cosine requires non-empty vectors');
  }
  if (left.length !== right.length) {
    throw new TypeError(`[vector] dimension mismatch: ${left.length} !== ${right.length}`);
  }
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index];
    const y = right[index];
    dot += x * y;
    normLeft += x * x;
    normRight += y * y;
  }
  if (normLeft === 0 || normRight === 0) return 0;
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

/**
 * 确定性离线嵌入：字符 bigram → FNV-1a → 桶累加 → L2 归一。
 *
 * **仅用于离线/测试**，不是生产 embedding；空文本返回全零向量（检索时无命中）。
 * @param {string} text
 * @param {number} [dim=256] 向量维度
 * @returns {Float32Array}
 */
export function hashEmbed(text, dim = DEFAULT_VECTOR_DIM) {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new TypeError(`[vector] dim must be a positive integer, got ${String(dim)}`);
  }
  const vec = new Float32Array(dim);
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase();
  const chars = Array.from(normalized);
  if (chars.length === 0) return vec;

  const add = (gram) => {
    vec[fnv1a(gram) % dim] += 1;
  };
  if (chars.length === 1) {
    add(chars[0]);
  } else {
    for (let index = 0; index < chars.length - 1; index += 1) {
      add(chars[index] + chars[index + 1]);
    }
  }

  let norm = 0;
  for (const value of vec) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let index = 0; index < vec.length; index += 1) vec[index] /= norm;
  return vec;
}

/**
 * 从 fact_vectors 读候选并做余弦排序。
 *
 * @param {{
 *   store: import('./store.js').Store,
 *   scope?: string,
 *   query?: string,
 *   embed?: (text: string) => Float32Array|number[],
 *   limit?: number,
 *   now?: number|Date,
 * }} input
 * @returns {Array<{factId: string, score: number}>}
 */
export function searchVector({
  store,
  scope = 'main',
  query = '',
  embed = hashEmbed,
  embedderId = null,
  limit = 20,
  now = Date.now(),
} = {}) {
  if (!store || typeof store.db?.prepare !== 'function') {
    throw new TypeError('[vector] store must expose a sqlite db');
  }
  if (typeof embed !== 'function') {
    throw new TypeError('[vector] embed must be a function');
  }
  const nowMs = toMillis(now);
  if (nowMs === null) throw new TypeError('[vector] invalid now');
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.trunc(Number(limit))
    : 20;
  const text = String(query ?? '').trim();
  if (text === '') return [];
  const queryVec = toVector(embed(text));
  if (queryVec.length === 0) return [];
  if (!queryVec.some((value) => value !== 0)) return [];

  // P1-a 治理按需添加的 sensitive 列不在基础 schema；存在时也要排除。
  const hasSensitive = store.db
    .prepare("SELECT 1 AS present FROM pragma_table_info('facts') WHERE name = 'sensitive'")
    .get() !== undefined;
  const sensitiveFilter = hasSensitive
    ? " AND (f.sensitive IS NULL OR f.sensitive = 0)"
    : '';
  // W4：只有当前 embedder 写入的向量参与召回；旧库/迁移前行为（不传 id）保持全量。
  const embedderFilter = typeof embedderId === 'string' && embedderId !== ''
    ? ' AND fv.embedder_id = ?'
    : '';

  const params = embedderFilter === '' ? [scope, queryVec.length] : [scope, embedderId, queryVec.length];
  const rows = store.db
    .prepare(
      `SELECT fv.fact_id, fv.vec, fv.dim, f.strength_days,
              f.last_reinforced_at, f.salience
         FROM fact_vectors fv
         JOIN facts f ON f.id = fv.fact_id
        WHERE f.scope = ?
          AND f.status = 'active'
          AND f.deleted_at IS NULL
          AND f.privacy = 'normal'
          ${sensitiveFilter}
          ${embedderFilter}
          AND fv.dim = ?`,
    )
    .all(...params);

  const scored = [];
  for (const row of rows) {
    const R = decayOf({
      strengthDays: row.strength_days,
      lastReinforcedAt: row.last_reinforced_at,
      now: nowMs,
      pinned: row.salience === 'pinned',
    });
    if (R < MIN_VECTOR_R) continue;
    let vec;
    try {
      vec = fromBlob(row.vec);
    } catch {
      continue;
    }
    if (vec.length !== queryVec.length) continue;
    const score = cosine(queryVec, vec);
    if (!Number.isFinite(score)) continue;
    scored.push({ factId: row.fact_id, score });
  }

  scored.sort((a, b) => b.score - a.score || a.factId.localeCompare(b.factId));
  return scored.slice(0, maxItems);
}

/**
 * FTS + 向量 RRF 混合召回。
 *
 * 每个列表内 rank 从 1 开始，单路贡献 `1 / (k + rank)`；同一 key 去重后相加。
 * 返回按 RRF 分数降序的 `{type, id, score}`；任一路为空时另一路照常返回。
 *
 * @param {{
 *   store: import('./store.js').Store,
 *   scope?: string,
 *   query?: string,
 *   embed?: (text: string) => Float32Array|number[],
 *   limit?: number,
 *   k?: number,
 *   now?: number|Date,
 * }} input
 * @returns {Array<{type: 'fact'|'episode', id: string, score: number}>}
 */
export function hybridSearch({
  store,
  scope = 'main',
  query = '',
  embed = hashEmbed,
  embedderId = null,
  limit = 20,
  k = DEFAULT_RRF_K,
  now = Date.now(),
} = {}) {
  if (!store || typeof store.searchBigram !== 'function') {
    throw new TypeError('[vector] store must expose searchBigram');
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new TypeError(`[vector] k must be a non-negative integer, got ${String(k)}`);
  }
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.trunc(Number(limit))
    : 20;
  const searchLimit = Math.max(1, maxItems * 2);

  const lexical = store.searchBigram(query, { scope, limit: searchLimit }) ?? [];
  const semantic = searchVector({
    store,
    scope,
    query,
    embed,
    embedderId,
    limit: searchLimit,
    now,
  });

  /** @type {Map<string, {type: 'fact'|'episode', id: string, score: number}>} */
  const fused = new Map();
  const add = (type, id, rank) => {
    if (type !== 'fact' && type !== 'episode') return;
    if (typeof id !== 'string' || id === '') return;
    const key = `${type}:${id}`;
    const current = fused.get(key) ?? { type, id, score: 0 };
    current.score += 1 / (k + rank);
    fused.set(key, current);
  };

  lexical.forEach((row, index) => add(row.type, row.id, index + 1));
  semantic.forEach((row, index) => add('fact', row.factId, index + 1));

  return [...fused.values()]
    .sort((a, b) => b.score - a.score
      || a.type.localeCompare(b.type)
      || a.id.localeCompare(b.id))
    .slice(0, maxItems);
}
