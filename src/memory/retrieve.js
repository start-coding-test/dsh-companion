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
 * v0.4.4 / V4-M1 相关性门槛（全部在打分之前完成）：
 *   1) 查询门：skipSmallTalk 开启时，长度 <recall.minQueryChars（默认 2）、
 *      纯算术/符号、常见问候词直接跳过（返回空结果，不读库、不算向量）。
 *      空查询仍走 recency-only 通道。
 *   2) 候选门：非空查询的候选必须有「有效词法命中」或向量余弦 ≥ minVectorScore；
 *      有效命中 = 去掉停用 bigram（今天/我们/一下/什么/怎么…）及其相邻跨词
 *      bigram 后，命中 ≥2 个不同 bigram，或命中比例 ≥30%；两者都没有的
 *      候选（例如旧行为里补位的 recency 项）直接丢弃。
 *   3) 统计：过滤后为空时调用方不会注入、不写召回样本；vectorHits 只数真正
 *      达到阈值且进入注入的向量命中。
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
import { DEFAULTS, normalizeRecall } from '../config.js';

const DAY_MS = 86_400_000;
const RECENT_WINDOW_MS = 7 * DAY_MS;
export const MIN_RECALL_R = 0.05;
export const DEFAULT_BUDGET_TOKENS = 2050;
export const DEFAULT_LIMIT = 20;
/** V4-M1：查询门的最短有效长度（按码点计；可被 recall.minQueryChars 覆盖）。 */
export const MIN_QUERY_CHARS = 2;
/** V4-M1：判定词法命中「够相关」所需的最少不同 bigram 数。 */
export const LEXICAL_MIN_HITS = 2;
/** V4-M1：或按查询有效 bigram 数的命中比例判定（≥30%）。 */
export const LEXICAL_MIN_HIT_RATIO = 0.3;
/**
 * V74-H1：稀有锚点放行。
 *
 * 回放发现 v0.7.4 把分母改成「库里存在的 bigram」后，小库（~143 条）里
 * presentTokens 常只有 1–2 个，任何含它们的条目都 ≥30% 过门：50 句真实正文
 * 新增 95 条注入、其中 67% 无关。分母退回查询有效 bigram 数之后，单命中的
 * 长句会重新被挡掉；这里只对「真的稀有」的锚点开口子——该 bigram 在本 scope
 * 命中条数 ≤ RARE_ANCHOR_MAX_DF，且不含功能字（我/你/的/了…），拉丁 token
 * 另要求长度 ≥3 且不是停用词。每次查询最多放行 RARE_ANCHOR_MAX_ITEMS 条。
 */
export const RARE_ANCHOR_MAX_DF = 2;
/** V74-H1：单次查询经稀有锚点放行的候选上限（按 score 取前 N）。 */
export const RARE_ANCHOR_MAX_ITEMS = 2;
/** V74-H1：功能字——单个 bigram 含这些字时不足以当锚点（跨词碎片多半含它们）。 */
const FUNCTION_CHARS = new Set([
  '我', '你', '他', '她', '它', '的', '了', '吗', '呢', '吧', '啊', '是', '在',
  '和', '就', '也', '都', '有', '这', '那', '个', '一', '不', '要', '会', '说',
  '着', '过', '得', '地', '把', '被', '给', '让', '呀', '嘛', '么',
]);
/** V3-M3：纯算术/符号查询（卡上给定的形态）。 */
const ARITHMETIC_ONLY_RE = /^[\d\s+\-*/=？?]+$/u;
/** V3-M3：常见问候/客套词（归一化后整串匹配）。 */
const GREETING_WORDS = new Set([
  '你好', '您好', '大家好', '嗨', '哈喽', '哈啰', '在吗', '在么', '在不在',
  '早安', '早上好', '午安', '晚安', '谢谢', '多谢', '感谢', '好的', '好',
  '收到', '再见', '拜拜', '辛苦了',
  'hi', 'hey', 'hello', 'yo', 'ok', 'okay', 'thanks', 'thank you', 'thankyou',
  'bye', 'goodbye', 'good morning', 'good afternoon', 'good night',
]);
const EDGE_SYMBOL_RE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
/** V3-M3：OR 词法检索的 token 上限（每个 token 一次 FTS 查询）。 */
const LEXICAL_TOKEN_LIMIT = 12;
/** V3-M3：参与 OR 词法检索的 token 至少要含一个字母/数字/CJK 字符。 */
const LEXICAL_TOKEN_RE = /[\p{L}\p{N}]/u;

/**
 * V4-M1：停用 bigram（功能词/寒暄词）。
 *
 * 这些 bigram 在自然语句里几乎必然出现，命中它们不能证明候选相关；它们既
 * 不计入命中数，也不计入命中比例的分母。与停用 bigram 相邻的跨词 bigram
 * （如「蓝鲸是什么动物」里的「是什」「么动」）同样是噪声，在
 * contentQueryBigrams 中按出现位置一并剔除。
 */
export const STOP_BIGRAMS = new Set([
  '今天', '明天', '昨天', '现在', '刚才', '以前', '以后', '时候',
  '我们', '你们', '他们', '她们', '它们', '咱们', '大家', '自己',
  '一下', '一些', '一点', '一个', '一样',
  '什么', '怎么', '怎么样', '怎样', '如何', '为什么', '是不是', '有没有',
  '可以', '可能', '应该', '需要', '知道', '觉得',
  '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里', '哪个', '哪些',
  '就是', '还是', '但是', '因为', '所以', '如果', '已经', '然后', '而且', '或者',
  '不过', '其实', '真的', '非常', '比较', '有点', '帮我', '请问', '谢谢', '你好',
  '没有', '不是',
  // V73-M1：回忆类元语句（「你还记得…吗」「上次跟你说过…」）。这些 bigram 在
  // 提问里必然出现、在记忆里几乎不出现，留着只会把命中比例压到阈值以下。
  '上次', '上回', '之前', '记得', '还记', '记不', '说过', '提过',
  '跟你', '和你', '你说', '我说', '告诉', '得吗',
]);

/**
 * V4-M1：拉丁停用词按「整 token」匹配（不做子串覆盖，避免把 java 里的 a
 * 之类误伤）。这些词常见于英文问句，单独命中不构成相关性证据。
 */
const STOP_LATIN_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'my', 'your', 'our', 'their',
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'this', 'that',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'about', 'and', 'or', 'not',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'please', 'thanks', 'thank', 'hello', 'hi', 'hey', 'ok', 'okay',
]);

/**
 * V75-H1：回忆意图。
 *
 * 稀有锚点（见 RARE_ANCHOR_MAX_DF）本来是给「用户主动问回忆」用的：现场案例是
 * 「我上次跟你说我夜宵吃了什么你还记得吗」——整句只有「夜宵」一个有效 bigram
 * 能撞上。但同一句话里的「这是」「好了」「继续改」这类非回忆陈述，也常常只撞
 * 一个稀有 bigram，于是被一起放进来（v0.7.5 回放：新增 10 条里 6 条无关，全部
 * 来自三句非回忆陈述）。
 *
 * 所以稀有锚点放行只在查询确实在问回忆时启用；未命中时行为等同 v0.7.3，只走
 * 原来的命中数/命中比例门。匹配对象是归一化后（NFKC）的原始查询，在停用 bigram
 * 剔除之前——「记得」「上次」这类词本身会被停用词表剔掉，不能拿剔除后的结果判。
 */
export const RECALL_INTENT_RE = /(?:记得|记不记得|还记得|上次|上回|之前|以前|说过|提过|聊过|讲过|告诉过|来着|忘了)/u;

/**
 * V4-M1：把查询切成「有效 bigram」，用于词法命中质量判定。
 *
 * 1) 与 toBigrams 同一套归一化（NFKC + 小写）后切 bigram；
 * 2) 停用 bigram 及其覆盖的字符位置上的跨词 bigram 全部剔除；
 * 3) 拉丁停用词按整 token 剔除；
 * 4) 只保留含字母/数字/CJK 的 token。
 *
 * 结果既用于 OR 词法检索（少查无意义的 token），也作为命中比例的分母。
 * 查询全是停用词时返回空数组——这类查询（「今天怎么样」）不会产生任何
 * 词法候选，也就不会注入。
 *
 * @param {unknown} query
 * @returns {string[]} 去重后的有效 bigram 列表（保持首次出现顺序）
 */
export function contentQueryBigrams(query) {
  if (typeof query !== 'string') return [];
  const text = query.normalize('NFKC').toLowerCase();
  if (text.trim() === '') return [];
  const tokens = [...new Set(splitTokens(toBigrams(text)))];
  if (tokens.length === 0) return [];

  // 标记停用 bigram 在原文中占用的码元位置。
  const covered = new Uint8Array(text.length);
  for (const stop of STOP_BIGRAMS) {
    for (let at = text.indexOf(stop); at !== -1; at = text.indexOf(stop, at + 1)) {
      const end = Math.min(at + stop.length, text.length);
      for (let i = at; i < end; i += 1) covered[i] = 1;
    }
  }

  const kept = [];
  for (const token of tokens) {
    if (!LEXICAL_TOKEN_RE.test(token)) continue;
    if (STOP_LATIN_WORDS.has(token)) continue;
    if (STOP_BIGRAMS.has(token)) continue;
    // 只要 token 在原文中有一次出现不与停用 bigram 重叠，就算有效。
    let free = false;
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      let blocked = false;
      const end = Math.min(at + token.length, text.length);
      for (let i = at; i < end; i += 1) {
        if (covered[i] === 1) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        free = true;
        break;
      }
    }
    if (free) kept.push(token);
  }
  return kept;
}

/**
 * V3-M3 查询门：判断查询是否属于「不值得召回」的小聊/符号/短查询。
 *
 * 归一化会去掉首尾空白与标点符号，再做四项判断：
 * 归一化后为空（纯符号）、长度 < minChars、纯算术、常见问候词。
 * 空查询不经过本函数（调用方保留 recency-only 语义）。
 *
 * @param {unknown} query
 * @param {{minChars?: number}} [options]
 * @returns {boolean}
 */
export function isTrivialQuery(query, { minChars = MIN_QUERY_CHARS } = {}) {
  if (typeof query !== 'string') return true;
  const text = query.trim();
  if (text === '') return true;
  const core = text.replace(EDGE_SYMBOL_RE, '');
  if (core === '') return true;
  if ([...core].length < minChars) return true;
  if (ARITHMETIC_ONLY_RE.test(core)) return true;
  const greeting = core.replace(/\p{P}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
  return GREETING_WORDS.has(greeting);
}

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
 * V4-M1：词法命中是否达到相关性门槛。
 *
 * 命中 ≥2 个不同有效 bigram，或命中数 / 查询有效 bigram 数 ≥30% 即算过门。
 * 命中集合为空、分母为 0（查询全是停用词）时一律不放行。
 *
 * V74-H1：分母回到「查询有效 bigram 数」。v0.7.4 曾把它改成「库里存在的
 * bigram 数」，在小库里会让 1/1 直接过门，回放新增 95 条注入中 67% 无关；
 * 单命中的长句改由 isRareAnchorToken 放行，见 RARE_ANCHOR_MAX_DF。
 * @param {{tokens: Set<string>}|undefined} hit
 * @param {number} queryBigramCount 查询的有效 bigram 数
 * @returns {boolean}
 */
function lexicalHitQualifies(hit, queryBigramCount) {
  if (hit === undefined) return false;
  const hits = hit.tokens.size;
  if (hits === 0) return false;
  if (hits >= LEXICAL_MIN_HITS) return true;
  return queryBigramCount > 0 && hits / queryBigramCount >= LEXICAL_MIN_HIT_RATIO;
}

/**
 * V74-H1：单个 bigram 能否作为「稀有锚点」放行一个候选。
 *
 * 三个条件同时成立：
 *   1) 该 bigram 在本 scope 的命中条数（df）在 1..RARE_ANCHOR_MAX_DF 之间；
 *   2) 不是拉丁 token，或拉丁 token 长度 ≥3 且不在 STOP_LATIN_WORDS；
 *   3) 两个字符都不是功能字（我/你/的/了/吗…），否则多半是跨词碎片。
 *
 * df 直接取 OR 检索循环里该 token 返回的条数，不额外查库。
 * @param {string} token
 * @param {Map<string, number>} tokenDf
 * @returns {boolean}
 */
function isRareAnchorToken(token, tokenDf) {
  const df = tokenDf.get(token) ?? 0;
  if (df === 0 || df > RARE_ANCHOR_MAX_DF) return false;
  if (/^[a-z0-9][a-z0-9._-]*$/u.test(token)) {
    return token.length >= 3 && !STOP_LATIN_WORDS.has(token);
  }
  const chars = [...token];
  if (chars.length < 2) return false;
  return chars.every((char) => !FUNCTION_CHARS.has(char));
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
  embedder = null,
  recall = null,
  config = null,
} = {}) {
  if (!store || typeof store.searchBigram !== 'function'
    || typeof store.getFact !== 'function' || typeof store.getEpisode !== 'function') {
    throw new TypeError('[retrieve] store must be a Store instance');
  }
  const nowMs = toMillis(now);
  if (nowMs === null) throw new TypeError('[retrieve] invalid now');

  // V3-M3：门槛配置优先级 recall 参数 → 完整 config.recall → DEFAULTS.recall；
  // 非法值在这里抛 ConfigError（与 normalizeConfig 同一口径）。
  const recallCfg = normalizeRecall(recall ?? config?.recall ?? DEFAULTS.recall);
  const budget = Number.isFinite(Number(budgetTokens))
    ? Math.max(0, Math.trunc(Number(budgetTokens)))
    : DEFAULT_BUDGET_TOKENS;
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.trunc(Number(limit))
    : DEFAULT_LIMIT;
  const textQuery = typeof query === 'string' ? query : String(query ?? '');
  const hasQuery = textQuery.trim() !== '';
  // V75-H1：稀有锚点只在「问回忆」时启用。这里用 NFKC 归一化后的原始查询匹配，
  // 不能等 contentQueryBigrams 把「记得/上次」当停用 bigram 剔掉之后再判。
  const recallIntent = hasQuery && RECALL_INTENT_RE.test(textQuery.normalize('NFKC'));
  // 查询门在算查询向量、读库之前，避免为「1+1」这类查询做任何召回工作。
  // 空查询不走查询门（保留 recency-only 通道）；门槛长度由 recall.minQueryChars 控制。
  if (hasQuery && recallCfg.skipSmallTalk
    && isTrivialQuery(textQuery, { minChars: recallCfg.minQueryChars })) {
    return { items: [], tokens: 0, usedIds: [], truncated: false };
  }
  // 打分（rel）仍用全部 bigram；词法候选与命中质量只看有效 bigram（V4-M1）。
  const queryTokens = [...new Set(splitTokens(toBigrams(textQuery)))];
  const lexicalTokens = hasQuery ? contentQueryBigrams(textQuery) : [];
  // P2-b：只有显式开启且嵌入器可用时才走向量；关闭时以下路径与 v0.2.0 一致。
  const vectorEnabled = vector !== null
    && typeof vector === 'object'
    && vector.enabled === true
    && vector.embedder !== 'none';
  const vectorDim = Number.isInteger(vector?.dim) && vector.dim > 0
    ? vector.dim
    : DEFAULT_VECTOR_DIM;
  // W4：有 embedder 时先异步算查询向量；失败（未安装/超时/网络）不阻塞 turn，
  // 本轮退化为纯 FTS，并把错误带回给调用方计数。embedder=null 保留 v0.3.2 的
  // hashEmbed 路径（单测/关闭向量时的兼容行为）。
  let queryVec = null;
  let embeddingError = null;
  if (vectorEnabled && embedder !== null && typeof embedder.embed === 'function') {
    try {
      const embedded = typeof embedder.embedQuery === 'function'
        ? await embedder.embedQuery([textQuery])
        : await embedder.embed([textQuery]);
      const candidate = Array.isArray(embedded) ? embedded[0] : null;
      if (!(candidate instanceof Float32Array) || candidate.length === 0) {
        throw new Error('[retrieve] embedder returned no query vector');
      }
      queryVec = candidate;
    } catch (error) {
      embeddingError = error;
    }
  }
  const useVector = vectorEnabled && (embedder === null || queryVec !== null);
  const embedderId = embedder !== null
    && typeof embedder.id === 'string' && embedder.id !== ''
    ? embedder.id
    : null;
  const embed = queryVec !== null
    ? () => queryVec
    : (text) => hashEmbed(text, vectorDim);

  /** @type {Map<string, {type:'fact'|'episode', id:string, rrf?:number, vector?:boolean}>} */
  const candidates = new Map();
  const searchLimit = Math.max(1, maxItems * 2);
  // V4-M1：词法命中单独留一份，记录每个候选命中的「有效 bigram」集合，
  // 作为「候选有没有足够相关性证据」的判据（任意一个常见 bigram 命中不再放行）。
  /** @type {Map<string, {type:'fact'|'episode', id:string, tokens:Set<string>}>} */
  const lexicalHits = new Map();
  // V74-H1：每个有效 bigram 在本 scope 的命中条数（df）。稀有锚点判定用它，
  // 直接来自下面 OR 检索循环的返回，不额外查库。
  /** @type {Map<string, number>} */
  const tokenDf = new Map();
  if (hasQuery) {
    // Store.searchBigram 的 MATCH 是 AND 语义（toMatchQuery 把每个 bigram 用
    // AND 连接），自然语句「青柠计划的代号是什么」几乎不可能全中；所以这里
    // 逐 token OR 查，得到候选集合，再按命中质量过门。token 数封顶，避免长句
    // 退化成全表扫描。
    //
    // V75-L1：稀有锚点要判「df ≤ RARE_ANCHOR_MAX_DF」。搜索上限若只有
    // searchLimit（= maxItems*2，闲聊路径 maxItems=1 → 2），df=3 会被截断成 2
    // 而误判为稀有。这里至少多取一条，让 df 能数到 RARE_ANCHOR_MAX_DF+1。
    // 代价：maxItems=1 时候选池可能多出 1 条（limit 2→3），但多出来的那条仍要
    // 过同样的门槛，不会因此注入无关条目。
    const dfSearchLimit = Math.max(searchLimit, RARE_ANCHOR_MAX_DF + 1);
    for (const token of lexicalTokens.slice(0, LEXICAL_TOKEN_LIMIT)) {
      if (!LEXICAL_TOKEN_RE.test(token)) continue;
      let df = 0;
      for (const hit of store.searchBigram(token, { scope, limit: dfSearchLimit }) ?? []) {
        if (!hit || (hit.type !== 'fact' && hit.type !== 'episode')) continue;
        df += 1;
        const key = `${hit.type}:${hit.id}`;
        let entry = lexicalHits.get(key);
        if (entry === undefined) {
          entry = { type: hit.type, id: hit.id, tokens: new Set() };
          lexicalHits.set(key, entry);
        }
        entry.tokens.add(token);
      }
      if (df > 0) tokenDf.set(token, df);
    }
  }
  let vectorScores = new Map();
  if (useVector) {
    // 单独取一次向量命中，用于 /状态 的「最近命中」统计；融合本身走 hybridSearch。
    vectorScores = new Map(
      searchVector({
        store,
        scope,
        query: textQuery,
        embed,
        embedderId,
        limit: searchLimit,
        now: nowMs,
      }).map((hit) => [hit.factId, hit.score]),
    );
    for (const hit of hybridSearch({
      store,
      scope,
      query: textQuery,
      embed,
      embedderId,
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
    // OR 词法命中可能多于 hybridSearch 的 AND 命中，合并进来供打分。
    for (const [key, hit] of lexicalHits) {
      if (candidates.has(key)) continue;
      candidates.set(key, {
        type: hit.type,
        id: hit.id,
        rrf: 0,
        vector: hit.type === 'fact' && vectorScores.has(hit.id),
      });
    }
  } else {
    for (const [key, hit] of lexicalHits) {
      candidates.set(key, { type: hit.type, id: hit.id });
    }
  }

  // recency 补位：仅空查询时保留「最近 7 天的 top3」。
  // 非空查询不再用 recency 硬凑候选——那正是 V3-M3 之前「任意查询都注入」
  // 的来源；无关候选在打分前就会被相关性门槛丢掉，这里提前省掉读库开销。
  if (!hasQuery) {
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
  }

  /** @type {Array<{kind:'fact'|'episode', id:string, text:string,
   *   fidelity:'full'|'gist'|'index', score:number, R:number}>} */
  const maxRrf = useVector
    ? Math.max(0, ...[...candidates.values()].map((candidate) => Number(candidate.rrf) || 0))
    : 0;
  const scored = [];
  // V74-H1：本次查询里走稀有锚点放行的候选（key 集合 + 条数上限）。
  const rareAnchors = new Set();
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

    // V4-M1 候选门：非空查询必须有「有效词法命中」（≥2 个不同 bigram，或
    // 命中比例 ≥30%），或向量余弦 ≥ minVectorScore。
    if (hasQuery) {
      const key = `${candidate.type}:${candidate.id}`;
      const vectorScore = candidate.type === 'fact' ? vectorScores.get(candidate.id) : undefined;
      const vectorQualified = Number.isFinite(vectorScore)
        && vectorScore >= recallCfg.minVectorScore;
      if (!vectorQualified) {
        const hit = lexicalHits.get(key);
        if (!lexicalHitQualifies(hit, lexicalTokens.length)) {
          // V74-H1：单命中未过门时，只有「稀有且不含功能字」的锚点能放行；
          // V75-H1：且只在查询确实在问回忆时（否则普通陈述句也会被开口子）。
          let anchor = false;
          if (recallIntent && hit !== undefined && hit.tokens.size === 1) {
            const [only] = hit.tokens;
            anchor = isRareAnchorToken(only, tokenDf);
          }
          if (!anchor) continue;
          rareAnchors.add(key);
        }
      }
    }

    const rel = relativeScore(candidate.type, row, new Set(queryTokens), queryTokens.length);
    const fidelity = conservativeFidelity(row.fidelity ?? 'full', fidelityOf(R));
    const text = renderItem(row, fidelity);
    if (text === null || text === '') continue;

    // A8②（v0.4.13）：连续注入多次仍没用上的事实降权（默认 3 次后 ×0.85）。
    const unusedStreak = candidate.type === 'fact' ? Number(row.unused_streak ?? 0) : 0;
    const unusedThreshold = Number.isFinite(recallCfg?.unusedThreshold) ? recallCfg.unusedThreshold : 3;
    const unusedPenalty = Number.isFinite(recallCfg?.unusedPenalty) ? recallCfg.unusedPenalty : 0.85;
    const unusedFactor = unusedStreak >= unusedThreshold ? Math.max(0, Math.min(1, unusedPenalty)) : 1;

    scored.push({
      kind: candidate.type,
      id: row.id,
      text,
      fidelity,
      rare: rareAnchors.has(`${candidate.type}:${candidate.id}`),
      score: (0.6 * rel + 0.4 * R
        + (candidate.vector === true && maxRrf > 0 ? 0.1 * (Number(candidate.rrf) / maxRrf) : 0)) * unusedFactor,
      R,
    });
  }

  scored.sort((a, b) => b.score - a.score
    || b.R - a.R
    || Number(b.vector) - Number(a.vector)
    || a.id.localeCompare(b.id));

  // V74-H1：稀有锚点每次查询最多放行 RARE_ANCHOR_MAX_ITEMS 条——按 score 取前 N。
  let rareAnchorPasses = 0;
  const capped = [];
  for (const item of scored) {
    if (item.rare === true) {
      if (rareAnchorPasses >= RARE_ANCHOR_MAX_ITEMS) continue;
      rareAnchorPasses += 1;
    }
    capped.push(item);
  }

  const items = [];
  const usedIds = [];
  let tokens = 0;
  let truncated = false;
  for (const item of capped) {
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
  if (hasQuery) {
    result.rareAnchorPasses = rareAnchorPasses;
    // V75-H1：只在问回忆时开稀有锚点；caller 的 mirror debug 用它区分
    // 「关着没开」和「开了但没放行」。
    result.recallIntent = recallIntent;
  }
  if (useVector) {
    // V3-M3：只有真正过门（≥ minVectorScore）的向量命中才计入，避免
    // hash 向量对任意查询的非零相似度把 /状态 的 vectorHits 虚增。
    result.vectorHits = usedIds.filter((id) => {
      const score = vectorScores.get(id);
      return Number.isFinite(score) && score >= recallCfg.minVectorScore;
    }).length;
  }
  if (embeddingError !== null) {
    result.vectorError = {
      name: embeddingError?.name ?? 'Error',
      code: embeddingError?.code ?? null,
      // E-M1：transient（超时/网络/初始化中）与 fatal（依赖未安装）可判别，
      // 调用方据此记指标，但本轮一律已退回 FTS，不向用户抛错。
      kind: embeddingError?.kind ?? null,
      transient: embeddingError?.transient === true,
      fatal: embeddingError?.fatal === true,
      message: embeddingError?.message ?? String(embeddingError),
    };
  }
  return result;
}
