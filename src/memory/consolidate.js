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

import { renderBoard, stageBoard } from './state-board.js';

/** 硬阈值：活跃 turn 中到 40k token 也必须巩固（安全阀）。 */
export const DEFAULT_HARD_TOKENS = 40_000;
/** 阈值：连续 2 次检查超过 24k token 才巩固，避免边界抖动。 */
export const DEFAULT_AT_TOKENS = 24_000;
/** 空闲阈值：距最后一条人类消息 30 分钟。 */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

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

/** 去重键：subject_text + predicate + object_text 完全相同视为同一条。 */
function factKey(fact) {
  return `${fact.subject_text}\u0000${fact.predicate}\u0000${fact.object_text ?? ''}`;
}

/**
 * 巩固一段对话（一个 seq 区间）。
 *
 * @param {object} input
 * @param {import('./store.js').Store} input.store
 * @param {string} [input.scope='main']
 * @param {number} input.seqFrom 本段第一条 seq（含）
 * @param {number} input.seqTo 本段最后一条 seq（含，成为新水位）
 * @param {(input: {scope: string, seqFrom: number, seqTo: number}) => Promise<object>|object} input.llm
 *   模型回调：返回 {episode:{title,summary,...}, facts:[...], reminders?:[...]}
 * @param {number|Date} [input.now] 巩固时刻（Unix 秒）；默认当前时间
 * @param {string} [input.trigger='idle'] 归因，写入 consolidations.trigger
 * @param {string} [input.sessionId] 归属会话；默认同 scope（main 即 'main'）
 * @returns {Promise<{skipped: boolean, upto_seq: number, episodeId?: string, facts?: number}>}
 */
export async function consolidate(input = {}) {
  const { store, seqFrom, seqTo, llm } = input;
  requireStore(store);
  const scope = requireScope(input.scope ?? 'main');
  const from = requireSeq(seqFrom, 'seqFrom');
  const to = requireSeq(seqTo, 'seqTo');
  if (to < from) {
    throw new RangeError('[consolidate] seqTo must be greater than or equal to seqFrom');
  }

  // 1) 水位线：这段是否已经巩固过。skipped 路径绝不调用模型、绝不写库。
  const watermark = Number(store.getWatermark(scope)) || 0;
  if (to <= watermark) {
    return { skipped: true, upto_seq: watermark };
  }

  if (typeof llm !== 'function') {
    throw new TypeError('[consolidate] llm must be a function');
  }
  const at = requireNow(input.now ?? Math.floor(Date.now() / 1000));
  const trigger = nonEmptyString(input.trigger) ?? 'idle';
  const sessionId = nonEmptyString(input.sessionId) ?? scope;

  // 2) 模型切分 + 校验。校验失败在事务之前抛出，库内不产生任何行。
  const draft = await llm({ scope, seqFrom: from, seqTo: to });
  const { episode, facts, reminders } = normalizeDraft(draft);

  // 3) 单事务写库（含水位 consolidations.upto_seq）；抛错整体回滚。
  const written = store.transaction(() => {
    const consolidation = store.insertConsolidation({
      scope,
      session_id: sessionId,
      kind: 'nap',
      trigger,
      upto_seq: to,
      turn_from: from,
      turn_to: to,
      status: 'written',
      started_at: at,
      finished_at: at,
    });

    const episodeRow = store.insertEpisode({
      scope,
      session_id: sessionId,
      consolidation_id: consolidation.id,
      started_at: episode.started_at ?? at,
      ended_at: episode.ended_at ?? at,
      title: episode.title,
      summary: episode.summary,
      evidence: episode.evidence,
      topics: episode.topics,
      entities: episode.entities,
      mood: episode.mood,
      mood_evidence: episode.mood_evidence,
      salience: episode.salience,
      privacy: episode.privacy,
      fidelity: episode.fidelity,
    });

    // facts：key+value 完全相同的跳过（MVP 的「cos 去重」简化）。
    const seen = new Set(
      store.listFacts({ scope, limit: 500 }).map((row) =>
        factKey({ subject_text: row.subject_text, predicate: row.predicate, object_text: row.object_text }),
      ),
    );
    let insertedFacts = 0;
    for (const fact of facts) {
      const key = factKey(fact);
      if (seen.has(key)) continue;
      seen.add(key);
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
    const boardText = renderBoard({
      recent: store.listEpisodes({ scope, limit: 6 }),
      facts: store.listFacts({ scope, status: 'active', limit: 10 }),
      threads: store.listThreads({ status: 'active', limit: 10 }),
      reminders: store.listReminders({ scope, limit: 12 }),
    });
    stageBoard(store, scope, boardText);

    store.appendEvent({
      at,
      action: 'ADD',
      table_name: 'episodes',
      row_id: episodeRow.id,
      actor: 'consolidator',
      reason: trigger,
      detail_json: { upto_seq: to, facts: insertedFacts, reminders: reminders.length },
    });

    return { episodeId: episodeRow.id, facts: insertedFacts };
  });

  // 4) 事务已提交，水位推进到 to。
  return {
    skipped: false,
    upto_seq: to,
    episodeId: written.episodeId,
    facts: written.facts,
  };
}
