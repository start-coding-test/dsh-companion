/**
 * L120-H1：巩固写库前的近似查重（同一件事换了说法就不该再写一条）。
 *
 * 为什么不能用向量：50041 现网 `vector.enabled=false`、`embedder=hash`（哈希特征
 * 不是语义向量），所以「同义」只能靠字面近似 + 一次小模型裁决：
 *
 * 1. **高相似（Jaccard ≥ dedupeSkip，默认 0.85）**：判定为同一条事实，不新写，
 *    只强化旧条（`store.reinforceFact`）——同一句话换个时间再说一遍的典型情形。
 * 2. **中等相似（dedupeAsk ≤ J < dedupeSkip，默认 0.5..0.85）**：字面拿不准，
 *    把所有这类候选**合成一次**模型调用批量裁决 same / update / new。
 *    - same   → 同高相似：不写，强化旧条；
 *    - update → 写新行并把旧行置 superseded（保留历史，不物理删）；
 *    - new    → 照常插入（两条都留）。
 * 3. **低相似**：直接新写。
 *
 * 判定调用失败/超时/返回不可解析时，该批一律按 new 保守写入并计数：宁可多写一条
 * （下次巩固/治理还能收敛），也不能因为一次判定失败丢掉整段巩固结果。
 *
 * 纯函数 + 一次注入的 judge 回调，无 I/O、无模型依赖，便于单测。
 */

import { textBigrams, jaccard } from './similarity.js';

/** 高相似直接视为同一条事实（不新写，只强化）。 */
export const DEFAULT_DEDUPE_SKIP = 0.85;

/** 中等相似的下界：低于它直接新写，不进模型裁决。 */
export const DEFAULT_DEDUPE_ASK = 0.5;

/** 分页拉 active 事实的页大小（与 store.listFacts 的 clamp 相容）。 */
const FACT_PAGE_SIZE = 500;

/**
 * 把某 scope 下全部 active 事实按 kind 分桶，并预先算好 bigram 集合。
 *
 * 只读一次库（分页），供一次巩固的全部草稿事实复用，避免每条事实都全表扫描。
 * @param {object} store
 * @param {string} scope
 * @returns {Map<string, {id: string, statement: string, tokens: Set<string>,
 *          last_reinforced_at: number}[]>}
 */
export function collectActiveFactsByKind(store, scope) {
  const byKind = new Map();
  if (!store || typeof store.listFacts !== 'function') return byKind;
  for (let offset = 0; ; offset += FACT_PAGE_SIZE) {
    const page = store.listFacts({ scope, status: 'active', limit: FACT_PAGE_SIZE, offset });
    for (const row of page) {
      const kind = typeof row.kind === 'string' ? row.kind : '';
      let bucket = byKind.get(kind);
      if (bucket === undefined) {
        bucket = [];
        byKind.set(kind, bucket);
      }
      bucket.push({
        id: row.id,
        statement: typeof row.statement === 'string' ? row.statement : '',
        tokens: textBigrams(row.statement),
        last_reinforced_at: Number(row.last_reinforced_at ?? 0) || 0,
      });
    }
    if (page.length < FACT_PAGE_SIZE) break;
  }
  return byKind;
}

/**
 * 一条草稿事实与同 kind 既有事实的最高相似度。
 * @param {{tokens: Set<string>}} candidate
 * @param {Array<{id: string, tokens: Set<string>}>} rows
 * @returns {{row: object|null, score: number}}
 */
function bestMatch(candidate, rows) {
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = jaccard(candidate.tokens, row.tokens);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return { row: best, score: bestScore };
}

/**
 * 给一条草稿事实定性。
 *
 * @param {{kind: string, statement: string}} fact 归一化后的草稿事实
 * @param {Map<string, object[]>} byKind {@link collectActiveFactsByKind} 的结果
 * @param {{dedupeSkip?: number, dedupeAsk?: number}} [options]
 * @returns {{verdict: 'skip'|'ask'|'new', match: object|null, score: number}}
 */
export function classifyDraftFact(fact, byKind, options = {}) {
  const skip = Number.isFinite(options.dedupeSkip) ? options.dedupeSkip : DEFAULT_DEDUPE_SKIP;
  const ask = Number.isFinite(options.dedupeAsk) ? options.dedupeAsk : DEFAULT_DEDUPE_ASK;
  const kind = typeof fact?.kind === 'string' ? fact.kind : '';
  const rows = byKind.get(kind) ?? [];
  if (rows.length === 0) return { verdict: 'new', match: null, score: 0 };
  const candidate = { tokens: textBigrams(fact?.statement) };
  if (candidate.tokens.size === 0) return { verdict: 'new', match: null, score: 0 };
  const { row, score } = bestMatch(candidate, rows);
  if (row !== null && score >= skip) return { verdict: 'skip', match: row, score };
  if (row !== null && score >= ask) return { verdict: 'ask', match: row, score };
  return { verdict: 'new', match: null, score };
}

/**
 * 拼「same / update / new」批量裁决的提示词。
 *
 * 只给必要文本（新事实 + 最相似的旧事实），并要求严格 JSON 输出，方便解析。
 * @param {Array<{fact: string, existing: string}>} pairs
 * @returns {string}
 */
export function buildDedupeJudgePrompt(pairs) {
  const lines = [
    '你在做记忆事实查重。下面每一组是「新抽出的事实」与「库里已有的相似事实」。',
    '判断每组是不是同一件事的不同说法，只输出 JSON，不要解释。',
    'verdict 取值：same（完全是同一件事，只是措辞不同）/ update（旧事实被新事实取代或需要更新数值、状态）/ new（不同的事）。',
    '输出格式：{"items":[{"index":1,"verdict":"same"}]}（index 从 1 开始，必须覆盖每一组）。',
  ];
  pairs.forEach((pair, index) => {
    lines.push('');
    lines.push(`[${index + 1}]`);
    lines.push(`新事实：${pair.fact}`);
    lines.push(`已有事实：${pair.existing}`);
  });
  return lines.join('\n');
}

/**
 * 解析裁决结果；任何结构问题都返回 null（调用方按 new 保守处理）。
 * @param {unknown} payload 已解析的 JSON
 * @param {number} expected 需要覆盖的组数
 * @returns {Array<'same'|'update'|'new'>|null}
 */
export function parseDedupeVerdicts(payload, expected) {
  const items = Array.isArray(payload?.items) ? payload.items : null;
  if (items === null || !Number.isInteger(expected) || expected <= 0) return null;
  const verdicts = new Array(expected).fill(null);
  for (const item of items) {
    const index = Number(item?.index ?? item?.i);
    const verdict = typeof item?.verdict === 'string' ? item.verdict.trim().toLowerCase() : '';
    if (!Number.isInteger(index) || index < 1 || index > expected) continue;
    if (verdict !== 'same' && verdict !== 'update' && verdict !== 'new') continue;
    verdicts[index - 1] = verdict;
  }
  // 缺项按 new 保守补：宁可多写一条，也不误删/误合并。
  return verdicts.map((verdict) => verdict ?? 'new');
}

// ---------------------------------------------------------------- M1（v0.7.17）
// memory_write 的「关键串」升级。
//
// 同 kind 的 bigram Jaccard 只衡量**措辞**；跨 kind 的实体串（项目名、人名、
// 代号）才说明「同一对象」。口径（用户 m01525 裁决）：
// - 关键串**只扩大 ask**，永不触发 skip —— skip 仍只由同 kind 高 Jaccard 决定，
//   所以最坏情况只是多一次 judge 调用，不会误合并两条事实；
// - 抽取是纯字符串处理：拉丁标识符（dsh-companion / Node / 50041）与 CJK 短段，
//   排除纯版本号、纯日期/时间与停用词，最多取 KEY_PHRASE_MAX 个；
// - 倒排索引在 collectActiveFactsByKind 的结果上现算，不新增任何 DB 查询。

/** 单条事实最多参与升级的关键串数量。 */
export const KEY_PHRASE_MAX = 5;
/** 关键串的字符数下界。 */
export const KEY_PHRASE_MIN_LENGTH = 2;
/** 关键串的字符数上界（超过它基本是整句，不做跨事实比较）。 */
export const KEY_PHRASE_MAX_LENGTH = 24;

/** 已知停用词：出现频率高但不指向任何实体。 */
const KEY_PHRASE_STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '因为', '所以',
  '但是', '然后', '已经', '可以', '就是', '还是', '不是', '没有', '一个',
  '一些', '现在', '今天', '明天', '昨天', '以后', '之前', '需要', '应该',
  'the', 'and', 'for', 'with', 'that', 'this',
]);

const VERSION_ONLY = /^\d+(?:\.\d+)+$/u;
const DATE_TIME_ONLY = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}月\d{1,2}[日号])$/u;

/**
 * 从一条事实里抽关键串（纯函数，无 I/O）。
 * @param {string} statement
 * @returns {string[]} 按出现顺序去重，最多 {@link KEY_PHRASE_MAX} 个
 */
export function extractKeyPhrases(statement) {
  const text = typeof statement === 'string' ? statement : '';
  if (text === '') return [];
  const phrases = [];
  const seen = new Set();
  const push = (raw) => {
    const phrase = typeof raw === 'string' ? raw.trim() : '';
    if (phrase.length < KEY_PHRASE_MIN_LENGTH || phrase.length > KEY_PHRASE_MAX_LENGTH) return;
    if (VERSION_ONLY.test(phrase) || DATE_TIME_ONLY.test(phrase)) return;
    const key = phrase.toLowerCase();
    if (KEY_PHRASE_STOPWORDS.has(key) || seen.has(key)) return;
    seen.add(key);
    phrases.push(phrase);
  };
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9._+-]{1,23}/gu)) push(match[0]);
  // CJK 段常带着虚词边界（「项目在」「上用」），先削掉首尾的功能字再当关键串。
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,24}/gu)) {
    const trimmed = match[0]
      .replace(/^[在的了是和与把被给对从到就也还很都又再更最上下中里]+/u, '')
      .replace(/[在的了是和与把被给对从到就也还很都又再更最上下中里]+$/u, '');
    push(trimmed);
  }
  return phrases.slice(0, KEY_PHRASE_MAX);
}

/**
 * 把 active 事实建成「关键串 → 命中行」倒排（跨 kind）。
 * @param {Map<string, {id: string, statement: string}[]>} byKind
 * @returns {Map<string, {id: string, kind: string, statement: string}[]>}
 */
export function buildKeyPhraseIndex(byKind) {
  const index = new Map();
  if (byKind === null || typeof byKind?.forEach !== 'function') return index;
  byKind.forEach((rows, kind) => {
    for (const row of rows ?? []) {
      for (const phrase of extractKeyPhrases(row?.statement)) {
        const key = phrase.toLowerCase();
        const hit = {
          id: typeof row?.id === 'string' ? row.id : String(row?.id ?? ''),
          kind: typeof kind === 'string' ? kind : '',
          statement: typeof row?.statement === 'string' ? row.statement : '',
        };
        const bucket = index.get(key);
        if (bucket === undefined) index.set(key, [hit]);
        else bucket.push(hit);
      }
    }
  });
  return index;
}

/**
 * classifyDraftFact 判 new 时，用关键串把它升级成 ask（不升级 skip）。
 * @param {{kind: string, statement: string}} fact
 * @param {{verdict: string, match: object|null, score: number}} verdict
 * @param {Map<string, object[]>} index {@link buildKeyPhraseIndex} 的结果
 * @returns {{verdict: string, match: object|null, score: number, keyPhrase?: string}}
 */
export function upgradeVerdictWithKeyPhrases(fact, verdict, index) {
  if (verdict === null || typeof verdict !== 'object' || verdict.verdict !== 'new') return verdict;
  if (index === null || typeof index?.get !== 'function') return verdict;
  for (const phrase of extractKeyPhrases(fact?.statement)) {
    const hits = index.get(phrase.toLowerCase());
    if (!Array.isArray(hits) || hits.length === 0) continue;
    return { verdict: 'ask', match: hits[0], score: verdict.score, keyPhrase: phrase };
  }
  return verdict;
}
