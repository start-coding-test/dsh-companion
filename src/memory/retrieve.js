/**
 * 四档记忆检索（T7）。
 *
 * 设计依据：memory/docs/06-记忆系统设计.md v3.3 §6.3 / §7.3 / §8.3。
 * 召回分两条腿：
 *   1) Store.searchBigram 的词法召回（bigram FTS，已按 scope/删除过滤）；
 *   2) 最近 7 天未命中的 top3 作为 recency 候选（空查询时只走这一条）。
 *
 * 打分：rel = 0.5 + 0.5 * (命中 bigram 数 / 查询 bigram 数)
 *       R   = exp(-(now - lastAt) / 86400000 / strengthDays)（pinned 恒 1）
 *       score = 0.6 * rel + 0.4 * R
 * 装入：按 score 降序，累计 Math.ceil(text.length / 2) 个 token，超预算即截断。
 *
 * 时间戳兼容：Store 落库统一为 Unix 秒；本模块对外允许秒或毫秒，
 * 内部归一化到毫秒后再套用卡上的 86400000 常量。
 *
 * 四档渲染（06 §7.3）：
 *   full  -> 原文（fact.statement / episode.summary）
 *   gist  -> 前 2 句 + 1 条引号原话（≤120 字）
 *   index -> [时间] 标题（只留时间与一句话标题）
 *   dormant -> 不返回
 */

import { toBigrams } from './bigram.js';
import { DEFAULT_VECTOR_DIM, hashEmbed, hybridSearch, searchVector } from './vector.js';

const DAY_MS = 86_400_000;
const RECENT_WINDOW_MS = 7 * DAY_MS;
export const MIN_RECALL_R = 0.05;
export const DEFAULT_BUDGET_TOKENS = 2050;
export const DEFAULT_LIMIT = 20;

const FIDELITY_RANK = Object.freeze({ full: 3, gist: 2, index: 1, dormant: 0 });

/**
 * 秒/毫秒时间戳归一化到毫秒。Store 落库是秒，调用方（如 Date.now）常是毫秒。
 * 以 1e11 为界：小于它按秒处理（1e11 秒已远超 5138 年）。
 * @param {unknown} value
 * @returns {number|null}
 */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) < 1e11 ? num * 1000 : num;
}

/**
 * 遗忘曲线。pinned 恒 1；strengthDays <= 0 / 缺失返回 0。
 * @param {{strengthDays?: number|null, lastAt?: number|Date|null,
 *          now?: number|Date, pinned?: boolean}} [input]
 * @returns {number} [0, 1]
 */
export function forgettingCurve({ strengthDays, lastAt, now = Date.now(), pinned = false } = {}) {
  if (pinned) return 1;
  const strength = Number(strengthDays);
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  const at = toMillis(now);
  const last = toMillis(lastAt);
  if (at === null || last === null) return 0;
  const r = Math.exp(-((at - last) / DAY_MS) / strength);
  if (!Number.isFinite(r)) return 0;
  // 时钟回拨/未来时间不应把 R 推过 1。
  return Math.min(1, Math.max(0, r));
}

/**
 * R 到四档：>=0.5 full、>=0.2 gist、>=0.05 index、否则 dormant。
 * @param {number} R
 * @returns {'full'|'gist'|'index'|'dormant'}
 */
export function fidelityOf(R) {
  const r = Number(R);
  if (!Number.isFinite(r)) return 'dormant';
  if (r >= 0.5) return 'full';
  if (r >= 0.2) return 'gist';
  if (r >= 0.05) return 'index';
  return 'dormant';
}

/**
 * 把一行按档位渲染成注入文本。row 可以是 facts 行或 episodes 行
 * （以是否存在 statement 区分）。
 * @param {object} row
 * @param {'full'|'gist'|'index'|'dormant'} fidelity
 * @returns {string|null}
 */
export function renderItem(row, fidelity) {
  if (!row || fidelity === 'dormant') return null;
  const isFact = row.statement !== undefined && row.statement !== null;
  const original = isFact
    ? String(row.statement ?? '')
    : String(row.summary ?? row.title ?? '');
  if (original === '') return null;

  if (fidelity === 'full') return original;

  if (fidelity === 'gist') {
    const gist = firstSentences(original, 2);
    const rawQuote = isFact ? row.source_excerpt : row.evidence;
    const quote = typeof rawQuote === 'string' && rawQuote.trim() !== ''
      ? `「${[...rawQuote.trim()].slice(0, 120).join('')}」`
      : '';
    const text = `${gist}${quote}`;
    return text === '' ? null : text;
  }

  if (fidelity === 'index') {
    const at = row.observed_at ?? row.started_at ?? row.created_at;
    // index 只留「时间 + 一句话标题」：事实取 statement 首句，情景取 title。
    const title = isFact
      ? firstSentences(String(row.statement ?? ''), 1)
      : row.title;
    if (title === null || title === undefined || String(title) === '') return null;
    return `[${formatDate(at)}] ${truncate(String(title), 40)}`;
  }

  return null;
}

/**
 * 取前 n 句（保留句末标点）；整段无标点时退化为前 120 字。
 * @param {string} text
 * @param {number} count
 * @returns {string}
 */
function firstSentences(text, count) {
  const matches = String(text).match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? [];
  const joined = matches
    .slice(0, count)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('');
  if (joined !== '') return joined;
  return truncate(String(text).trim(), 120);
}

/** @param {unknown} value @returns {string} 只保留日期部分（UTC） */
function formatDate(value) {
  const ms = toMillis(value);
  if (ms === null) return '未知';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 按字符（码点）截断，避免切断代理对。
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  const chars = [...String(text)];
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, limit).join('')}…`;
}

/** @param {unknown} value @returns {string[]} */
function splitTokens(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.trim().split(/\s+/).filter(Boolean);
}

/** @param {string|null} json @returns {string[]} */
function parseTopics(json) {
  if (typeof json !== 'string' || json.trim() === '') return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/**
 * 相对相关度：行文本与查询 bigram 的重合比例。
 * 空查询没有查询 bigram，按 0.5 基线处理（让 recency 候选也能排序）。
 * @param {'fact'|'episode'} kind
 * @param {object} row
 * @param {Set<string>} queryTokens
 * @param {number} queryCount
 * @returns {number}
 */
function relativeScore(kind, row, queryTokens, queryCount) {
  if (queryCount === 0) return 0.5;
  const text = kind === 'fact'
    ? [row.statement, row.subject_text, row.predicate, row.object_text]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ')
    : [row.title, row.summary, ...parseTopics(row.topics_json)]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ');
  const rowTokens = new Set(splitTokens(toBigrams(text)));
  let hit = 0;
  for (const token of queryTokens) {
    if (rowTokens.has(token)) hit += 1;
  }
  return 0.5 + 0.5 * (hit / queryCount);
}

/**
 * 取更保守的档位：行内已降级的文本无法凭空恢复，R 现在更低时也不能给高清晰度。
 * @param {string} stored
 * @param {string} fromR
 * @returns {'full'|'gist'|'index'|'dormant'}
 */
function conservativeFidelity(stored, fromR) {
  const left = FIDELITY_RANK[stored] === undefined ? 'dormant' : stored;
  const right = FIDELITY_RANK[fromR] === undefined ? 'dormant' : fromR;
  return FIDELITY_RANK[left] <= FIDELITY_RANK[right] ? left : right;
}

/**
 * 四档检索入口。
 *
 * @param {{
 *   store: import('./store.js').Store,
 *   query?: string,
 *   scope?: string,
 *   now?: number|Date,
 *   budgetTokens?: number,
 *   limit?: number,
 * }} input
 * @returns {Promise<{
 *   items: Array<{kind:'fact'|'episode', id:string, text:string,
 *                 fidelity:'full'|'gist'|'index', score:number, R:number}>,
 *   tokens: number, usedIds: string[], truncated: boolean,
 * }>}
 */
export async function retrieve({
  store,
  query = '',
  scope = 'main',
  now = Date.now(),
  budgetTokens = DEFAULT_BUDGET_TOKENS,
  limit = DEFAULT_LIMIT,
  vector = null,
} = {}) {
  if (!store || typeof store.searchBigram !== 'function'
    || typeof store.getFact !== 'function' || typeof store.getEpisode !== 'function') {
    throw new TypeError('[retrieve] store must be a Store instance');
  }
  const nowMs = toMillis(now);
  if (nowMs === null) throw new TypeError('[retrieve] invalid now');

  const budget = Number.isFinite(Number(budgetTokens))
    ? Math.max(0, Math.trunc(Number(budgetTokens)))
    : DEFAULT_BUDGET_TOKENS;
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.trunc(Number(limit))
    : DEFAULT_LIMIT;
  const textQuery = typeof query === 'string' ? query : String(query ?? '');
  const queryTokens = [...new Set(splitTokens(toBigrams(textQuery)))];
  // P2-b：只有显式开启且嵌入器可用时才走向量；关闭时以下路径与 v0.2.0 一致。
  const vectorEnabled = vector !== null
    && typeof vector === 'object'
    && vector.enabled === true
    && vector.embedder !== 'none';
  const vectorDim = Number.isInteger(vector?.dim) && vector.dim > 0
    ? vector.dim
    : DEFAULT_VECTOR_DIM;

  /** @type {Map<string, {type:'fact'|'episode', id:string}>} */
  const candidates = new Map();
  const searchLimit = Math.max(1, maxItems * 2);
  let vectorScores = new Map();
  if (vectorEnabled) {
    // 单独取一次向量命中，用于 /状态 的「最近命中」统计；融合本身走 hybridSearch。
    vectorScores = new Map(
      searchVector({
        store,
        scope,
        query: textQuery,
        embed: (text) => hashEmbed(text, vectorDim),
        limit: searchLimit,
        now: nowMs,
      }).map((hit) => [hit.factId, hit.score]),
    );
    for (const hit of hybridSearch({
      store,
      scope,
      query: textQuery,
      embed: (text) => hashEmbed(text, vectorDim),
      limit: searchLimit,
      now: nowMs,
    })) {
      if (!hit || (hit.type !== 'fact' && hit.type !== 'episode')) continue;
      candidates.set(`${hit.type}:${hit.id}`, {
        type: hit.type,
        id: hit.id,
        rrf: hit.score,
        vector: hit.type === 'fact' && vectorScores.has(hit.id),
      });
    }
  } else {
    for (const hit of store.searchBigram(textQuery, { scope, limit: searchLimit }) ?? []) {
      if (!hit || (hit.type !== 'fact' && hit.type !== 'episode')) continue;
      candidates.set(`${hit.type}:${hit.id}`, { type: hit.type, id: hit.id });
    }
  }

  // recency 补位：最近 7 天（按发生时间）未命中的 top3。
  const recent = [];
  const listLimit = Math.max(10, maxItems * 2);
  for (const row of store.listFacts({ scope, limit: listLimit }) ?? []) {
    const ts = toMillis(row.observed_at);
    if (ts !== null && ts >= nowMs - RECENT_WINDOW_MS) {
      recent.push({ type: 'fact', id: row.id, ts });
    }
  }
  for (const row of store.listEpisodes({ scope, limit: listLimit }) ?? []) {
    const ts = toMillis(row.started_at);
    if (ts !== null && ts >= nowMs - RECENT_WINDOW_MS) {
      recent.push({ type: 'episode', id: row.id, ts });
    }
  }
  recent.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
  let recentAdded = 0;
  for (const row of recent) {
    if (recentAdded >= 3) break;
    const key = `${row.type}:${row.id}`;
    if (candidates.has(key)) continue;
    candidates.set(key, { type: row.type, id: row.id });
    recentAdded += 1;
  }

  /** @type {Array<{kind:'fact'|'episode', id:string, text:string,
   *   fidelity:'full'|'gist'|'index', score:number, R:number}>} */
  const maxRrf = vectorEnabled
    ? Math.max(0, ...[...candidates.values()].map((candidate) => Number(candidate.rrf) || 0))
    : 0;
  const scored = [];
  for (const candidate of candidates.values()) {
    const row = candidate.type === 'fact'
      ? store.getFact(candidate.id)
      : store.getEpisode(candidate.id);
    if (!row) continue;
    if (row.deleted_at !== null && row.deleted_at !== undefined) continue;
    if (row.status === 'tombstoned' || row.status === 'superseded') continue;
    if (row.privacy === 'secret') continue;

    const pinned = row.salience === 'pinned'
      || row.strength_days === null || row.strength_days === undefined;
    const R = forgettingCurve({
      strengthDays: row.strength_days,
      lastAt: row.last_reinforced_at,
      now: nowMs,
      pinned,
    });
    if (R < MIN_RECALL_R) continue;

    const rel = relativeScore(candidate.type, row, new Set(queryTokens), queryTokens.length);
    const fidelity = conservativeFidelity(row.fidelity ?? 'full', fidelityOf(R));
    const text = renderItem(row, fidelity);
    if (text === null || text === '') continue;

    scored.push({
      kind: candidate.type,
      id: row.id,
      text,
      fidelity,
      score: 0.6 * rel + 0.4 * R
        + (candidate.vector === true && maxRrf > 0 ? 0.1 * (Number(candidate.rrf) / maxRrf) : 0),
      R,
    });
  }

  scored.sort((a, b) => b.score - a.score
    || b.R - a.R
    || Number(b.vector) - Number(a.vector)
    || a.id.localeCompare(b.id));

  const items = [];
  const usedIds = [];
  let tokens = 0;
  let truncated = false;
  for (const item of scored) {
    const cost = Math.ceil(item.text.length / 2);
    if (tokens + cost > budget) {
      truncated = true;
      break;
    }
    items.push({
      kind: item.kind,
      id: item.id,
      text: item.text,
      fidelity: item.fidelity,
      score: item.score,
      R: item.R,
    });
    usedIds.push(item.id);
    tokens += cost;
  }

  const result = { items, tokens, usedIds, truncated };
  if (vectorEnabled) {
    result.vectorHits = usedIds.filter((id) => vectorScores.has(id)).length;
  }
  return result;
}
