/**
 * 巩固（小睡）编排与状态板暂存（T6，06 v3.3 §4.2 / §8.2 / §16.4）。
 *
 * 核心顺序（卡上强约束，不得颠倒）：
 *   1. 读水位线 watermark = MAX(upto_seq)（written/compacted）；seqTo ≤
 *      watermark 说明这段已经巩固过，直接 skipped，不调模型、不写任何行。
 *   2. 调模型切 episode / 抽 facts / reminders / 状态板增量，并严格校验
 *      草稿；草稿非法抛 ConsolidationError('bad-draft')，此时事务尚未开始，
 *      库内计数不变。
 *   3. 单事务写库：consolidations（status=written，upto_seq=seqTo，这就是
 *      新水位）→ episode → facts（key+value 完全相同跳过）→ reminders →
 *      renderBoard + setStagedBoard（只 staged，不发布）→ memory_events。
 *      任何一步抛错由 Store.transaction 整体 ROLLBACK。
 *   4. 成功才返回；调用方在事务提交后才允许登记「压缩成功」。
 *
 * 本模块只做编排，不直接持有连接、不改 store.js。
 */

import {
  CREDENTIAL_HINT, REDACTED_CREDENTIAL, hasUnredactedCredentialValue, isSensitiveText,
  redactSensitiveValues,
} from './govern.js';
import { decayOf } from './reinforce.js';
import { renderBoard, stageBoard } from './state-board.js';

/** 硬阈值：活跃 turn 中到 40k token 也必须巩固（安全阀）。 */
export const DEFAULT_HARD_TOKENS = 40_000;
/** 阈值：连续 2 次检查超过 24k token 才巩固，避免边界抖动。 */
export const DEFAULT_AT_TOKENS = 24_000;
/** 空闲阈值：距最后一条人类消息 30 分钟。 */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/** 去重扫描的事实分页大小（Store 单页上限远大于此值）。 */
const FACT_PAGE_SIZE = 200;

const FACT_KINDS = new Set([
  'identity', 'relation', 'preference', 'project', 'knowledge', 'other',
]);
const SALIENCE_VALUES = new Set(['trivial', 'normal', 'notable', 'explicit', 'pinned']);
const PRIVACY_VALUES = new Set(['normal', 'sensitive', 'secret']);
const FIDELITY_VALUES = new Set(['full', 'gist', 'index']);
const MOOD_VALUES = new Set(['positive', 'neutral', 'tired', 'anxious', 'low', 'excited']);
const REMINDER_KINDS = new Set(['todo', 'schedule', 'repeat', 'commitment']);
const DUE_GRANULARITIES = new Set(['exact', 'day', 'week', 'month', 'none']);
const REMINDER_STATUSES = new Set([
  'pending', 'fired', 'snoozed', 'done', 'cancelled', 'expired',
]);
const CONSOLIDATION_KINDS = new Set(['nap', 'deep', 'forget_flush']);

/** 语句归一化：去掉空白/标点，供遗忘排除做保守比对。 */
const STATEMENT_NOISE = /[\s\p{P}\p{S}]+/gu;

/** @param {unknown} value @returns {string} */
function normalizeStatement(value) {
  return String(value ?? '').replace(STATEMENT_NOISE, '').toLowerCase();
}

/**
 * 草稿事实是否命中被遗忘语句：相同、包含目标语句、或被目标语句包含都算。
 * 保守策略优先保护遗忘语义；目标已被 tombstone，不会写回。
 * @param {string} statement
 * @param {string[]} excluded 归一化后的目标语句
 * @returns {boolean}
 */
function matchesExcludedStatement(statement, excluded) {
  const normalized = normalizeStatement(statement);
  if (normalized === '') return false;
  return excluded.some(
    (target) => target !== '' && (normalized === target || normalized.includes(target) || target.includes(normalized)),
  );
}

/**
 * 拼接一行里所有用于敏感判定的文本字段。
 * @param {Record<string, unknown>|null|undefined} row
 * @param {string[]} keys
 * @returns {string}
 */
function rowSensitiveText(row, keys) {
  return keys
    .map((key) => row?.[key])
    .filter((value) => typeof value === 'string' && value !== '')
    .join(' ');
}

/**
 * 过滤掉含凭据的行（状态板渲染前的第一道防线）。
 *
 * V7-M3：事实看 statement + subject/object，提醒看 title + detail；episode 看
 * title + summary。被过滤的行不上状态板；事实/提醒另外在落库前就被拦截。
 * @template T
 * @param {T[]} rows
 * @param {string[]} keys
 * @returns {T[]}
 */
function withoutSensitiveRows(rows, keys) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => !isSensitiveText(rowSensitiveText(row, keys)));
}

/**
 * 兜底：按行剔除仍含凭据的状态板行（模型可能把凭据跨字段拼接）。
 * 区块标题行（【…】）始终保留，保证 5 区块结构不破。
 * @param {string} text
 * @returns {string}
 */
function scrubSensitiveLines(text) {
  const lines = String(text ?? '').split('\n');
  const kept = lines.filter((line) => line.startsWith('【') || !isSensitiveText(line));
  return kept.length === lines.length ? text : kept.join('\n');
}

/**
 * 巩固链路的可识别错误。code 目前只有 'bad-draft'（模型产出不合法）；
 * 数据库/事务错误原样向上抛，以便调用方区分「模型问题」与「库问题」。
 */
export class ConsolidationError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options) {
    super(message ?? `[consolidate] ${code}`, options);
    this.name = 'ConsolidationError';
    this.code = code;
  }
}

function badDraft(message) {
  return new ConsolidationError('bad-draft', `[consolidate] bad draft: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

/** 数字（含 bigint）→ 有限数字；其余返回 null。 */
function finiteNumber(value) {
  if (typeof value === 'bigint') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** 毫秒时间戳（Date / epoch ms）→ ms；无法识别返回 null。 */
function epochMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const num = finiteNumber(value);
  return num === null ? null : num;
}

/**
 * 读取 memory_events detail 里的 duration_ms（V7-L2）。
 *
 * 兼容三种入参：detail 对象、detail_json 字符串、store.listEvents 返回的整行；
 * 字段缺失、非数字或负数一律返回 null——旧行（v0.4.8 及更早）没有 duration_ms，
 * 读取方不会因此报错。
 * @param {unknown} value
 * @returns {number|null} 非负整数毫秒；不可读返回 null
 */
export function eventDurationMs(value) {
  let detail = value;
  if (isPlainObject(detail) && 'detail_json' in detail) detail = detail.detail_json;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(detail)) return null;
  const duration = finiteNumber(detail.duration_ms);
  if (duration === null || duration < 0) return null;
  return Math.round(duration);
}

/** 草稿内时间字段 → Unix 秒；非法直接按 bad-draft 处理。 */
function draftEpoch(value, field) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Math.floor(value.getTime() / 1000);
  }
  const num = finiteNumber(value);
  if (num !== null) return Math.trunc(num);
  throw badDraft(`${field} must be a Unix timestamp, Date or null`);
}

/**
 * 计划一次巩固：只负责「现在该不该巩固、归因是什么」，不碰任何状态。
 * 调用方保证当前没有正在跑的 turn。
 *
 * 优先级：hard > idle > threshold。
 * - hard：tokens ≥ hardTokens（40k，安全阀，活跃对话中也必须执行）；
 * - idle：距 lastHumanAt ≥ idleMs（30 分钟无人类消息，最经济的时机）；
 * - threshold：连续 overCount ≥ 2 次检查 tokens ≥ atTokens（24k，防抖）；
 * 同时满足时按上述优先级归因（安全阀最紧急，空闲次之，阈值最后）。
 *
 * @param {{tokens?: number, lastHumanAt?: number|Date|null, now?: number|Date,
 *          overCount?: number, hardTokens?: number, atTokens?: number,
 *          idleMs?: number}} [input]
 * @returns {{trigger: 'idle'|'threshold'|'hard'|null, pending: boolean}}
 */
export function planConsolidation(input = {}) {
  const tokens = Math.max(0, finiteNumber(input.tokens) ?? 0);
  const overCount = Math.max(0, Math.trunc(finiteNumber(input.overCount) ?? 0));
  const hardTokens = finiteNumber(input.hardTokens) ?? DEFAULT_HARD_TOKENS;
  const atTokens = finiteNumber(input.atTokens) ?? DEFAULT_AT_TOKENS;
  const idleMs = finiteNumber(input.idleMs) ?? DEFAULT_IDLE_MS;
  const now = epochMs(input.now) ?? Date.now();
  const lastHumanAt = epochMs(input.lastHumanAt);

  /** @type {'idle'|'threshold'|'hard'|null} */
  let trigger = null;
  if (tokens >= hardTokens) {
    trigger = 'hard';
  } else if (lastHumanAt !== null && now - lastHumanAt >= idleMs) {
    trigger = 'idle';
  } else if (overCount >= 2 && tokens >= atTokens) {
    trigger = 'threshold';
  }
  return { trigger, pending: trigger !== null };
}

// ----------------------------------------------------------- 草稿校验

function normalizeEpisode(raw) {
  if (!isPlainObject(raw)) throw badDraft('episode must be an object');
  const title = nonEmptyString(raw.title);
  const summary = nonEmptyString(raw.summary);
  if (title === null) throw badDraft('episode.title must be a non-empty string');
  if (summary === null) throw badDraft('episode.summary must be a non-empty string');

  const salience = raw.salience ?? 'normal';
  if (!SALIENCE_VALUES.has(salience)) {
    throw badDraft(`episode.salience invalid: ${String(salience)}`);
  }
  const privacy = raw.privacy ?? 'normal';
  if (!PRIVACY_VALUES.has(privacy)) {
    throw badDraft(`episode.privacy invalid: ${String(privacy)}`);
  }
  const fidelity = raw.fidelity ?? 'full';
  if (!FIDELITY_VALUES.has(fidelity)) {
    throw badDraft(`episode.fidelity invalid: ${String(fidelity)}`);
  }
  const mood = raw.mood ?? null;
  if (mood !== null && !MOOD_VALUES.has(mood)) {
    throw badDraft(`episode.mood invalid: ${String(mood)}`);
  }
  return {
    title,
    summary,
    evidence: optionalString(raw.evidence),
    topics: raw.topics ?? raw.topics_json ?? [],
    entities: raw.entities ?? raw.entities_json ?? [],
    mood,
    mood_evidence: optionalString(raw.mood_evidence),
    salience,
    privacy,
    fidelity,
    started_at: draftEpoch(raw.started_at, 'episode.started_at'),
    ended_at: draftEpoch(raw.ended_at, 'episode.ended_at'),
  };
}

function normalizeFact(raw, index) {
  if (!isPlainObject(raw)) throw badDraft(`facts[${index}] must be an object`);
  const statement = nonEmptyString(raw.statement ?? raw.text);
  const subjectText = nonEmptyString(raw.subject_text ?? raw.subject ?? raw.key);
  const predicate = nonEmptyString(raw.predicate);
  if (statement === null) throw badDraft(`facts[${index}].statement must be a non-empty string`);
  if (subjectText === null) throw badDraft(`facts[${index}].subject_text must be a non-empty string`);
  if (predicate === null) throw badDraft(`facts[${index}].predicate must be a non-empty string`);

  const kind = raw.kind ?? 'other';
  if (!FACT_KINDS.has(kind)) throw badDraft(`facts[${index}].kind invalid: ${String(kind)}`);
  const salience = raw.salience ?? 'normal';
  if (!SALIENCE_VALUES.has(salience)) {
    throw badDraft(`facts[${index}].salience invalid: ${String(salience)}`);
  }
  const privacy = raw.privacy ?? 'normal';
  if (!PRIVACY_VALUES.has(privacy)) {
    throw badDraft(`facts[${index}].privacy invalid: ${String(privacy)}`);
  }
  const fidelity = raw.fidelity ?? 'full';
  if (!FIDELITY_VALUES.has(fidelity)) {
    throw badDraft(`facts[${index}].fidelity invalid: ${String(fidelity)}`);
  }
  return {
    kind,
    subject_id: optionalString(raw.subject_id),
    subject_text: subjectText,
    predicate,
    object_text: optionalString(raw.object_text ?? raw.object ?? raw.value),
    statement,
    source_excerpt: optionalString(raw.source_excerpt),
    salience,
    privacy,
    fidelity,
    observed_at: draftEpoch(raw.observed_at, `facts[${index}].observed_at`),
    valid_from: draftEpoch(raw.valid_from, `facts[${index}].valid_from`),
    valid_to: draftEpoch(raw.valid_to, `facts[${index}].valid_to`),
  };
}

function normalizeReminder(raw, index) {
  if (!isPlainObject(raw)) throw badDraft(`reminders[${index}] must be an object`);
  const title = nonEmptyString(raw.title ?? raw.text);
  if (title === null) throw badDraft(`reminders[${index}].title must be a non-empty string`);
  const kind = raw.kind ?? 'todo';
  if (!REMINDER_KINDS.has(kind)) {
    throw badDraft(`reminders[${index}].kind invalid: ${String(kind)}`);
  }
  const dueGranularity = raw.due_granularity ?? null;
  if (dueGranularity !== null && !DUE_GRANULARITIES.has(dueGranularity)) {
    throw badDraft(`reminders[${index}].due_granularity invalid: ${String(dueGranularity)}`);
  }
  const status = raw.status ?? 'pending';
  if (!REMINDER_STATUSES.has(status)) {
    throw badDraft(`reminders[${index}].status invalid: ${String(status)}`);
  }
  return {
    kind,
    title,
    detail: optionalString(raw.detail),
    counterparty: optionalString(raw.counterparty),
    due_at: draftEpoch(raw.due_at, `reminders[${index}].due_at`),
    due_granularity: dueGranularity,
    rrule: optionalString(raw.rrule),
    next_fire_at: draftEpoch(raw.next_fire_at, `reminders[${index}].next_fire_at`),
    status,
  };
}

/**
 * 校验模型草稿：episode{title,summary} + facts[]（每条
 * kind/subject_text/predicate/statement）+ 可选 reminders[]。
 * @param {unknown} draft
 * @returns {{episode: object, facts: object[], reminders: object[]}}
 */
function normalizeDraft(draft) {
  if (!isPlainObject(draft)) throw badDraft('draft must be an object');
  const episode = normalizeEpisode(draft.episode);
  if (!Array.isArray(draft.facts)) throw badDraft('draft.facts must be an array');
  const facts = draft.facts.map((fact, index) => normalizeFact(fact, index));
  if (draft.reminders !== undefined && draft.reminders !== null && !Array.isArray(draft.reminders)) {
    throw badDraft('draft.reminders must be an array when present');
  }
  const reminders = (draft.reminders ?? []).map((reminder, index) => normalizeReminder(reminder, index));
  return { episode, facts, reminders };
}

// ------------------------------------------------------- V9-M1 episode 脱敏

/**
 * V9-M1b：episode 单字段脱敏。
 *
 * 先按值脱敏（保留「用户提到一个密码」这类上下文），只有脱敏后仍残留可识别的
 * 凭据「值」（卡号 / `sk-` / 字段值 / 设备值）时才整段替换为占位符。V9-M1 最初
 * 用 `isSensitiveText` 做兜底，任何提到「密码/口令」的字段都会被整段抹掉，
 * 叙事摘要不可读；这里改用 `hasUnredactedCredentialValue`，词的提及不再触发。
 * 导出以便单测直接覆盖字段级行为。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactEpisodeField(value) {
  if (typeof value !== 'string' || value === '') return value;
  const redacted = redactSensitiveValues(value);
  return hasUnredactedCredentialValue(redacted) ? REDACTED_CREDENTIAL : redacted;
}

/**
 * V9-M1：episode 列表字段（topics/entities）同样脱敏——fts_episodes 会投影
 * topics，模型也可能把凭据值塞进列表项。
 * @param {unknown} values
 * @returns {unknown}
 */
function redactEpisodeList(values) {
  if (!Array.isArray(values)) return values;
  return values.map((item) => redactEpisodeField(item));
}

/**
 * V9-M1：episode 落库前的脱敏副本（title/summary/evidence/mood_evidence +
 * topics/entities）。不改原对象，返回可直接交给 store.insertEpisode 的新对象。
 * @param {object} episode
 * @returns {object}
 */
function redactEpisode(episode) {
  return {
    ...episode,
    title: redactEpisodeField(episode.title),
    summary: redactEpisodeField(episode.summary),
    evidence: redactEpisodeField(episode.evidence),
    mood_evidence: redactEpisodeField(episode.mood_evidence),
    topics: redactEpisodeList(episode.topics),
    entities: redactEpisodeList(episode.entities),
  };
}

// ------------------------------------------------------------ 写库辅助

function requireStore(store) {
  if (!store || typeof store.getWatermark !== 'function' || typeof store.transaction !== 'function') {
    throw new TypeError('[consolidate] store must be a Store instance');
  }
}

function requireScope(scope) {
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new TypeError('[consolidate] scope must be a non-empty string');
  }
  return scope;
}

function requireSeq(value, name) {
  const num = finiteNumber(value);
  if (num === null) {
    throw new TypeError(`[consolidate] ${name} must be a finite number`);
  }
  return Math.trunc(num);
}

function requireNow(now) {
  const num = finiteNumber(now);
  if (num === null) throw new TypeError('[consolidate] now must be a finite Unix timestamp');
  return Math.trunc(num);
}

/**
 * 可选排除 id 列表：缺省为空；非数组或含非空字符串以外元素时抛 TypeError。
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeExcludeIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('[consolidate] excludeFactIds must be an array of strings');
  }
  const seen = new Set();
  const out = [];
  for (const id of value) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('[consolidate] excludeFactIds must be an array of strings');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 去重键：subject_text + predicate + object_text 完全相同视为同一条。 */
function factKey(fact) {
  return `${fact.subject_text}\u0000${fact.predicate}\u0000${fact.object_text ?? ''}`;
}

/**
 * 去重命中的旧行是否已「沉睡/遗忘/墓碑」：这类命中说明事实在需要时已经
 * 掉出可召回档，按 W5「漏·去重」记 first_reneed。active 但 R<0.2 也算
 * （遗忘降级按日跑，可能滞后；口径与 retrieve 的 index 档一致）。
 *
 * @param {object} row
 * @param {number} at Unix 秒
 * @returns {boolean}
 */
function isReneedMissRow(row, at) {
  if (row.deleted_at !== null && row.deleted_at !== undefined) return true;
  if (row.status === 'tombstoned' || row.status === 'dormant') return true;
  if (row.status !== 'active' || row.salience === 'pinned') return false;
  const strengthDays = Number(row.strength_days);
  const lastReinforcedAt = Number(row.last_reinforced_at);
  if (!Number.isFinite(strengthDays) || strengthDays <= 0) return false;
  if (!Number.isFinite(lastReinforcedAt)) return false;
  return decayOf({
    strengthDays,
    lastReinforcedAt,
    now: at,
  }) < 0.2;
}

/**
 * 允许的选区文本：非空字符串才采用；空串/纯空白视为「没有选区文本」。
 * 非字符串（且非 null/undefined）直接报编程错误，避免把对象拼进提示词。
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeRegionText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError('[consolidate] regionText must be a string');
  }
  return value.trim() === '' ? null : value;
}

/**
 * 构造巩固模型提示词。N1：优先使用 surface 选区文本（已含 role 标注），
 * 缺失时回退最近转录；选区文本与 seqFrom/seqTo 的对齐由调用方保证。
 *
 * @param {object} input
 * @param {string} [input.scope='main']
 * @param {number} [input.seqFrom]
 * @param {number} [input.seqTo]
 * @param {{role:string,text:string}[]|null} [input.transcript]
 * @param {string|null} [input.regionText]
 * @returns {string}
 */
export function buildConsolidationPrompt(input = {}) {
  const scope = nonEmptyString(input.scope) ?? 'main';
  const regionText = normalizeRegionText(input.regionText);
  const rows = regionText === null
    ? (Array.isArray(input.transcript) ? input.transcript : [])
      .map((row) => `${row?.role ?? 'unknown'}: ${String(row?.text ?? '')}`)
    : [regionText];
  const body = rows.join('\n');
  return [
    '你是私人管家的记忆巩固器。把下面这段对话压缩成一条情景记忆与若干长期事实。',
    '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。格式：',
    '{"episode":{"title":"...","summary":"..."},',
    ' "facts":[{"kind":"identity|relation|preference|project|knowledge|other",',
    '           "subject_text":"...","predicate":"...","object_text":"...","statement":"..."}],',
    ' "reminders":[{"kind":"todo","title":"..."}]}',
    '对话里形如 [相关记忆] … [/相关记忆] 的段落是历史检索快照，只能作为已知内容的佐证，不得据此新建事实或改写现有结论。',
    '不得复述密码、口令、token、卡号等凭据值；必须提及时写成「用户提到一个密码」这类描述。',
    `scope=${scope} seq=${input.seqFrom}-${input.seqTo}`,
    '对话：',
    body,
  ].join('\n');
}

/**
 * 巩固一段对话（一个 seq 区间）。
 *
 * @param {object} input
 * @param {import('./store.js').Store} input.store
 * @param {string} [input.scope='main']
 * @param {number} input.seqFrom 本段第一条 seq（含）
 * @param {number} input.seqTo 本段最后一条 seq（含，成为新水位）
 * @param {(input: {scope: string, seqFrom: number, seqTo: number,
 *   regionText: string, textSource: 'region'|'transcript',
 *   transcript: object[]}) => Promise<object>|object} input.llm
 *   模型回调：返回 {episode:{title,summary,...}, facts:[...], reminders?:[...]}
 * @param {string} [input.regionText] N1：surface 选区文本（含 role 标注），
 *   非空时优先于 transcript；调用方保证与 seqFrom/seqTo 对齐
 * @param {{role:string,text:string}[]} [input.transcript] 最近转录；选区缺失时兜底
 * @param {number|Date} [input.now] 巩固时刻（Unix 秒）；默认当前时间
 * @param {() => number|Date} [input.clock] 毫秒时钟（V7-L2 duration_ms 计时）；
 *   默认 Date.now；测试可注入假时钟，同一秒内也能区分耗时
 * @param {string} [input.trigger='idle'] 归因，写入 consolidations.trigger
 * @param {string} [input.sessionId] 归属会话；默认同 scope（main 即 'main'）
 * @param {string} [input.kind='nap'] 巩固类型（nap/deep/forget_flush）
 * @param {string[]} [input.excludeFactIds] 定向巩固排除的事实 id：其 statement
 *   相同/包含/被包含的草稿事实一律不写回（遗忘闭环用）
 * @param {boolean} [input.guardWatermark=true] 是否做「段已巩固过」守卫；
 *   index.js 已在 surface 层面选好窗口，传 false 以允许水位从射线外推进
 * @returns {Promise<{skipped: boolean, upto_seq: number, textSource: string,
 *                    episodeId?: string, facts?: number, kind?: string,
 *                    excluded?: number, sensitive?: number, notice?: string|null,
 *                    duration_ms?: number}>}
 */
export async function consolidate(input = {}) {
  const { store, seqFrom, seqTo, llm } = input;
  requireStore(store);
  const scope = requireScope(input.scope ?? 'main');
  const from = requireSeq(seqFrom, 'seqFrom');
  const to = requireSeq(seqTo, 'seqTo');
  const regionText = normalizeRegionText(input.regionText);
  const textSource = regionText === null ? 'transcript' : 'region';
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  // 不校验 seqFrom <= seqTo：surface 位置不等于数值顺序，压缩后的可见 seq
  // 可能非单调（catalog:627-632）。

  const kind = nonEmptyString(input.kind) ?? 'nap';
  if (!CONSOLIDATION_KINDS.has(kind)) {
    throw new TypeError(`[consolidate] invalid kind: ${String(kind)}`);
  }

  // 1) 水位线：这段是否已经巩固过。skipped 路径绝不调用模型、绝不写库。
  // forget_flush 例外：遗忘后的定向重巩固本来就是「同一区间再蒸馏一次」，
  // 新事实会排除被遗忘目标；水位取 MAX，不会被这次重跑推回去。
  const guardWatermark = input.guardWatermark !== false;
  const watermark = Number(store.getWatermark(scope)) || 0;
  if (guardWatermark && to <= watermark && kind !== 'forget_flush') {
    return { skipped: true, upto_seq: watermark, textSource };
  }

  if (typeof llm !== 'function') {
    throw new TypeError('[consolidate] llm must be a function');
  }
  const at = requireNow(input.now ?? Math.floor(Date.now() / 1000));
  const trigger = nonEmptyString(input.trigger) ?? 'idle';
  const sessionId = nonEmptyString(input.sessionId) ?? scope;
  // V7-L2：duration_ms 用注入的毫秒时钟计时，补足 started_at/finished_at 只到
  // 秒、同一秒内多次巩固无法区分耗时的缺口。默认 Date.now，测试可注入假时钟。
  const clock = input.clock === undefined ? Date.now : input.clock;
  if (typeof clock !== 'function') {
    throw new TypeError('[consolidate] clock must be a function returning epoch milliseconds');
  }
  const startedMs = epochMs(clock());
  if (startedMs === null) {
    throw new TypeError('[consolidate] clock must return epoch milliseconds');
  }
  let durationMs = 0;

  // 定向巩固（遗忘闭环）：先把目标事实的 statement 归一化成排除集，
  // 草稿里相同/包含/被包含的事实不写回。目标已 tombstone，getFact 仍可读。
  const excludedStatements = [];
  for (const factId of normalizeExcludeIds(input.excludeFactIds)) {
    const row = typeof store.getFact === 'function' ? store.getFact(factId) : null;
    const normalized = row ? normalizeStatement(row.statement) : '';
    if (normalized !== '') excludedStatements.push(normalized);
  }

  // 2) 模型切分 + 校验。校验失败在事务之前抛出，库内不产生任何行。
  // N1：选区文本优先，transcript 仅作兜底；模型回调原样收到 textSource 便于审计。
  const draft = await llm({
    scope,
    seqFrom: from,
    seqTo: to,
    regionText: regionText ?? '',
    textSource,
    transcript,
  });
  const { episode, facts: draftedFacts, reminders: draftedReminders } = normalizeDraft(draft);
  // V9-M1：episode 四字段（及 topics/entities）落库前逐个脱敏，凭据值不落库；
  // store.insertEpisode 还会再做一次防御性脱敏（任何调用方都不落明文）。
  const safeEpisode = redactEpisode(episode);
  const matchedFacts = draftedFacts.filter(
    (fact) => !matchesExcludedStatement(fact.statement, excludedStatements),
  );
  const facts = matchedFacts.filter(
    (fact) => !isSensitiveText(rowSensitiveText(fact, ['statement', 'subject_text', 'object_text'])),
  );
  const excludedFacts = draftedFacts.length - matchedFacts.length;
  const reminders = draftedReminders.filter(
    (reminder) => !isSensitiveText(rowSensitiveText(reminder, ['title', 'detail'])),
  );
  const sensitiveCount =
    (matchedFacts.length - facts.length) + (draftedReminders.length - reminders.length);

  // 3) 单事务写库（含水位 consolidations.upto_seq）；抛错整体回滚。
  const written = store.transaction(() => {
    const consolidation = store.insertConsolidation({
      scope,
      session_id: sessionId,
      kind,
      trigger,
      upto_seq: to,
      turn_from: from,
      turn_to: to,
      compaction_start_seq: from,
      status: 'written',
      started_at: at,
      finished_at: at,
    });

    const episodeRow = store.insertEpisode({
      scope,
      session_id: sessionId,
      consolidation_id: consolidation.id,
      started_at: safeEpisode.started_at ?? at,
      ended_at: safeEpisode.ended_at ?? at,
      title: safeEpisode.title,
      summary: safeEpisode.summary,
      evidence: safeEpisode.evidence,
      topics: safeEpisode.topics,
      entities: safeEpisode.entities,
      mood: safeEpisode.mood,
      mood_evidence: safeEpisode.mood_evidence,
      salience: safeEpisode.salience,
      privacy: safeEpisode.privacy,
      fidelity: safeEpisode.fidelity,
    });

    // facts：key+value 完全相同的跳过（MVP 的「cos 去重」简化）。
    // 分页读取全量事实（含墓碑），避免 limit=500 截断后重复写入（L1）。
    // W5：命中已沉睡/遗忘/墓碑的旧行时，在同一事务写「漏·去重」埋点；
    // 不插入草稿、不复活旧行。
    const byKey = new Map();
    for (let offset = 0; ; offset += FACT_PAGE_SIZE) {
      const page = store.listFacts({
        scope,
        limit: FACT_PAGE_SIZE,
        offset,
        includeDeleted: true,
      });
      for (const row of page) {
        const key = factKey(row);
        const entry = byKey.get(key) ?? { active: null, miss: null };
        if (isReneedMissRow(row, at)) {
          entry.miss ??= row;
        } else if (
          row.status === 'active'
          && (row.deleted_at === null || row.deleted_at === undefined)
        ) {
          entry.active ??= row;
        }
        byKey.set(key, entry);
      }
      if (page.length < FACT_PAGE_SIZE) break;
    }
    let insertedFacts = 0;
    for (const fact of facts) {
      const key = factKey(fact);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.active === null && existing.miss !== null) {
          store.markFirstReneed?.(existing.miss.id, { at, tier: 'miss', kind: 'dedupe' });
        }
        continue;
      }
      byKey.set(key, { active: null, miss: null });
      store.insertFact({
        scope,
        kind: fact.kind,
        subject_id: fact.subject_id,
        subject_text: fact.subject_text,
        predicate: fact.predicate,
        object_text: fact.object_text,
        statement: fact.statement,
        source_kind: 'consolidated',
        source_episode_id: episodeRow.id,
        source_excerpt: fact.source_excerpt,
        salience: fact.salience,
        privacy: fact.privacy,
        observed_at: fact.observed_at ?? at,
        valid_from: fact.valid_from,
        valid_to: fact.valid_to,
        fidelity: fact.fidelity,
      });
      insertedFacts += 1;
    }

    for (const reminder of reminders) {
      store.insertReminder({
        scope,
        kind: reminder.kind,
        title: reminder.title,
        detail: reminder.detail,
        counterparty: reminder.counterparty,
        due_at: reminder.due_at,
        due_granularity: reminder.due_granularity,
        rrule: reminder.rrule,
        next_fire_at: reminder.next_fire_at,
        status: reminder.status,
        source_episode_id: episodeRow.id,
      });
    }

    // 状态板只写 staged（发布由 publishBoard 在四个时机执行）。
    // V7-M3：历史库里的敏感行（旧的 facts/episodes/threads/reminders）不上板。
    const boardText = scrubSensitiveLines(renderBoard({
      recent: withoutSensitiveRows(
        store.listEpisodes({ scope, limit: 6 }),
        ['title', 'summary'],
      ),
      facts: withoutSensitiveRows(
        store.listFacts({ scope, status: 'active', limit: 10 }),
        ['statement', 'subject_text', 'object_text'],
      ),
      threads: withoutSensitiveRows(
        store.listThreads({ status: 'active', limit: 10 }),
        ['key', 'description', 'last_progress'],
      ),
      reminders: withoutSensitiveRows(
        store.listReminders({ scope, limit: 12 }),
        ['title', 'detail'],
      ),
    }));
    stageBoard(store, scope, boardText);

    // V7-L2：完成时刻用同一注入时钟；夹到非负整数毫秒。detail.kind 让
    // consolidation 与 compaction 两类事件在 memory_events 里可区分。
    const finishedMs = epochMs(clock());
    durationMs = Math.max(0, Math.round((finishedMs ?? startedMs) - startedMs));

    store.appendEvent({
      at,
      action: 'ADD',
      table_name: 'episodes',
      row_id: episodeRow.id,
      actor: 'consolidator',
      reason: trigger,
      detail_json: {
        kind: 'consolidation',
        upto_seq: to,
        facts: insertedFacts,
        reminders: reminders.length,
        duration_ms: durationMs,
      },
    });

    return { episodeId: episodeRow.id, facts: insertedFacts, sensitive: sensitiveCount };
  });

  // 4) 事务已提交，水位推进到 to。
  return {
    skipped: false,
    upto_seq: to,
    textSource,
    kind,
    episodeId: written.episodeId,
    facts: written.facts,
    excluded: excludedFacts,
    sensitive: written.sensitive,
    notice: written.sensitive > 0 ? CREDENTIAL_HINT : null,
    duration_ms: durationMs,
  };
}
