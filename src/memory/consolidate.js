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
import {
  DEFAULT_DEDUPE_ASK, DEFAULT_DEDUPE_SKIP, buildDedupeJudgePrompt,
  classifyDraftFact, collectActiveFactsByKind, parseDedupeVerdicts,
} from './dedupe.js';
import { decayOf } from './reinforce.js';
import { textBigrams, jaccard } from './similarity.js';
import { FACT_KINDS as STORE_FACT_KINDS } from './store.js';
import { renderBoard, stageBoard } from './state-board.js';
import { backfillNextFireAt } from '../reminder/next-fire.js';
import { INJECTED_SOURCE_KINDS } from '../session/surface.js';

/** 硬阈值：活跃 turn 中到 40k token 也必须巩固（安全阀）。 */
export const DEFAULT_HARD_TOKENS = 40_000;
/** 阈值：连续 2 次检查超过 24k token 才巩固，避免边界抖动。 */
export const DEFAULT_AT_TOKENS = 24_000;
/** 空闲阈值：距最后一条人类消息 30 分钟。 */
export const DEFAULT_IDLE_MS = 30 * 60 * 1000;

// A6（v0.4.13）：压缩迟滞的两个默认值；config.compact 可覆盖。
export const DEFAULT_FLOOR_INCREMENT_TOKENS = 4_096;
export const DEFAULT_THRESHOLD_COOLDOWN_TURNS = 3;

/** 去重扫描的事实分页大小（Store 单页上限远大于此值）。 */
const FACT_PAGE_SIZE = 200;

/** L120-M2：提醒查重的分页大小（Store.listReminders 的 limit clamp 是 100）。 */
const REMINDER_PAGE_SIZE = 100;

/** v0.7.1 V70-M2：按 kind 取候选的「偏好/生活」类（同义说法多、subject 多为「用户」）。 */
const PREFERENCE_KINDS = new Set(['preference', 'lifestyle']);

/** v0.7.1 V70-M2：偏好类候选的默认上限（可由 config.consolidate.existingFactsLimit 覆盖）。 */
export const DEFAULT_EXISTING_FACTS_LIMIT = 12;

/**
 * L120-H1②：`statement` 与选区文本的 bigram 相似度下限——达到它就把旧事实当作
 * 可改写候选交给模型（字面 subject 命中之外的补充路径）。计划未给键名，按保守
 * 常量处理（待用户裁决；见回报「13 项默认」第 10 条）。
 */
export const REGION_SIMILARITY_THRESHOLD = 0.3;

/** L120-M2：提醒标题 bigram 相似度达到它就视为同一件事，跳过重复写入。 */
export const REMINDER_DEDUPE_SKIP = 0.8;

/** L120-H3b：单次巩固 project + knowledge 类事实的新增上限默认值。 */
export const DEFAULT_MAX_PROJECT_FACTS = 5;

/** L120-H3c：project / knowledge 事实多久没被召回/强化就算 dormant（天）。 */
export const DEFAULT_PROJECT_DORMANT_DAYS = 30;

/** L120-H3a：一次性过程状态（状态码/进度/临时路径/命令结果）的特征。 */
const EPHEMERAL_PERCENT = /\d+(?:\.\d+)?\s*[%％]/u;
const EPHEMERAL_STEP_COUNT = /\b\d+\s*\/\s*\d+\b/u;
const EPHEMERAL_TEMP_PATH = /(?:[A-Za-z]:)?[\\/](?:temp|tmp)[\\/]/iu;
const EPHEMERAL_COMMAND_OUTPUT = /\b(?:exit\s*code|stdout|stderr|traceback)\b/iu;
const EPHEMERAL_HTTP = /\b(?:http|https)\b|\bstatus\b|状态码/iu;
const EPHEMERAL_HTTP_CODE = /\b(?:[1-5]\d{2})\b/u;

/** L120-H4：助手自己「接下来要做的事」的常见起手式。 */
const ASSISTANT_SELF_ACTION_VERB = /^(?:回答|重启|查看|检查|验证|确认|整理|继续|处理|跟踪|修复|部署|更新|排查|统计|生成|导出)/u;
const ASSISTANT_SELF_ACTION_CONTEXT = /助手|能否|是否|结果|服务|dsh|插件|构建|测试/iu;

const FACT_KINDS = new Set(STORE_FACT_KINDS);
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

/** L120-M4：情景领域（life / work）；旧行为 NULL，不门控。 */
const EPISODE_DOMAINS = new Set(['life', 'work']);

/** 语句归一化：去掉空白/标点，供遗忘排除做保守比对。 */
const STATEMENT_NOISE = /[\s\p{P}\p{S}]+/gu;

/**
 * L120-H3a：这条草稿事实是不是「一次性过程状态」（不该进长期记忆）。
 *
 * 只对 project / knowledge 生效：生活类事实里出现百分比（「体脂率 18%」）是正当
 * 内容，不能一刀切。判定都要求有上下文词，避免把「这是第 3 步」之外的正常数字
 * （版本号 0.7.7、端口 8080）误杀——状态码必须同时出现 HTTP/状态码字样。
 *
 * @param {{kind?: string, statement?: string, object_text?: string}} fact
 * @returns {boolean}
 */
export function isEphemeralFactText(fact) {
  const kind = typeof fact?.kind === 'string' ? fact.kind : '';
  if (kind !== 'project' && kind !== 'knowledge') return false;
  const text = `${fact?.statement ?? ''}\n${fact?.object_text ?? ''}`;
  if (text.trim() === '') return false;
  if (EPHEMERAL_PERCENT.test(text)) return true;
  if (EPHEMERAL_STEP_COUNT.test(text)) return true;
  if (EPHEMERAL_TEMP_PATH.test(text)) return true;
  if (EPHEMERAL_COMMAND_OUTPUT.test(text)) return true;
  if (EPHEMERAL_HTTP.test(text) && EPHEMERAL_HTTP_CODE.test(text)) return true;
  return false;
}

/**
 * L120-H4：这条草稿提醒是不是「助手自己接下来要做的事」。
 *
 * 现网 52 条 pending 里大量是助手自己的下一步（「回答助手能否区分 QQ 和微信消息」
 * 「重启 dsh web 服务」「查看本次训练结果」），与用户无关。只记两类：用户明确
 * 要求提醒的；用户本人的待办/承诺。
 *
 * 首版保守：宁可漏拦（多写一条会被 M2 去重/M3 过期兜底），不可误拦用户的真事。
 * 因此要求「起手动词 + 助手语境词」同时命中，或「我 + 助手动作动词」。
 *
 * @param {{title?: string, detail?: string}} reminder
 * @returns {boolean}
 */
export function isAssistantSelfActionReminder(reminder) {
  const title = String(reminder?.title ?? '').trim();
  const detail = String(reminder?.detail ?? '').trim();
  const head = title === '' ? detail : title;
  if (head === '') return false;
  if (ASSISTANT_SELF_ACTION_VERB.test(head) && ASSISTANT_SELF_ACTION_CONTEXT.test(`${title}\n${detail}`)) {
    return true;
  }
  if (/^我(?:去|来|得|要)?(?:回答|重启|查看|检查|验证|确认|整理|继续|处理|跟进|排查|修复)/u.test(head)) {
    return true;
  }
  return false;
}

/**
 * L120-M3 / H3b：把配置里「天数」类阈值夹到合法区间。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeDays(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

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
  // A6（v0.4.13）：压缩迟滞。floorTokens 是上次压缩后的实测水位（不可压底），
  // 涨不够 minIncrementTokens 就不值得再压；同一 scope 两次 threshold 之间还要
  // 隔够 cooldownTurns 轮。hard 与 idle 分支不受这两条限制。
  const floorTokens = finiteNumber(input.floorTokens);
  const minIncrementTokens = Math.max(
    0,
    finiteNumber(input.minIncrementTokens) ?? DEFAULT_FLOOR_INCREMENT_TOKENS,
  );
  const cooldownTurns = Math.max(
    0,
    Math.trunc(finiteNumber(input.cooldownTurns) ?? DEFAULT_THRESHOLD_COOLDOWN_TURNS),
  );
  const turnsSinceThreshold = Math.max(
    0,
    Math.trunc(finiteNumber(input.turnsSinceThreshold) ?? cooldownTurns),
  );

  /** @type {'idle'|'threshold'|'hard'|null} */
  let trigger = null;
  if (tokens >= hardTokens) {
    trigger = 'hard';
  } else if (lastHumanAt !== null && now - lastHumanAt >= idleMs) {
    trigger = 'idle';
  } else if (
    overCount >= 2 &&
    tokens >= atTokens &&
    (floorTokens === null || tokens >= floorTokens + minIncrementTokens) &&
    turnsSinceThreshold >= cooldownTurns
  ) {
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
  // L120-M4：情景记忆也分领域（life / work），供召回在闲聊时不带出工程内容。
  // 模型偶尔写别的词：不抛 bad-draft（一处小瑕疵不该让整段巩固失败），落 null。
  const rawDomain = typeof raw.domain === 'string' ? raw.domain.trim().toLowerCase() : '';
  const domain = EPISODE_DOMAINS.has(rawDomain) ? rawDomain : null;
  return {
    title,
    summary,
    evidence: optionalString(raw.evidence),
    topics: raw.topics ?? raw.topics_json ?? [],
    entities: raw.entities ?? raw.entities_json ?? [],
    mood,
    mood_evidence: optionalString(raw.mood_evidence),
    domain,
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
/**
 * A8③：把选区/转录文本拼成用于「同主题」匹配的一段纯文本。
 * @param {string|null} regionText
 * @param {object[]} transcript
 * @returns {string}
 */
/**
 * A8③：从选区/转录里取出召回快照文本（用于把「历史快照」排除出同主题匹配）。
 * @param {string} text
 * @returns {string}
 */
function recallSnapshotText(text) {
  if (typeof text !== 'string' || text === '') return '';
  const matched = text.match(/\[相关记忆\][\s\S]*?\[\/相关记忆\]/gu);
  return matched === null ? '' : matched.join('\n');
}

/**
 * A8③ / L120-H1：选区优先、转录兜底；召回快照只是「历史回显」，匹配前先剥掉。
 *
 * V4-L2 时代只要段内出现召回快照就整段不给候选，理由是「无法区分用户又提到 vs
 * 召回带进来」。但召回在主会话几乎每段都注入，于是「同主题改写」提示永远缺席，
 * 模型只能不停新写——这正是 L120-H1 的第一个成因。现在改为**只剔除快照正文本身**
 * （`[相关记忆]…[/相关记忆]` 标记块由 surface 层 `isInjectedRecord` 先行去掉，
 * 这里再兜一层，兼容旧 transcript 与外部拼装文本），其余用户发言照常匹配。
 *
 * @param {object} store
 * @param {string} scope
 * @param {string|null} regionText
 * @param {object[]} transcript
 * @returns {{id: string, subject_text: string, statement: string}[]}
 */
export function selectExistingFactsFromRegion(store, scope, regionText, transcript, options = {}) {
  const body = stripRecallSnapshots(promptBody(regionText, transcript));
  if (body === '') return [];
  // 压缩摘要（宿主或平台生成的历史跨度）里的事实无从判断新旧，仍然不注入候选。
  if (/<compacted-summary>/u.test(body) || /automatically generated checkpoint/u.test(body)) {
    return [];
  }
  const recallText = recallSnapshotText(promptBody(regionText, transcript));
  return selectExistingFacts(store, scope, body, recallText === '' ? options : { ...options, recallText });
}

/**
 * L120-H1：剥掉 `[相关记忆]…[/相关记忆]` 块，只留用户真实发言。
 * @param {string} text
 * @returns {string}
 */
function stripRecallSnapshots(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(/\[相关记忆\][\s\S]*?\[\/相关记忆\]/gu, ' ');
}

function promptBody(regionText, transcript) {
  if (typeof regionText === 'string' && regionText !== '') return regionText;
  const rows = Array.isArray(transcript) ? transcript : [];
  return rows.map((row) => String(row?.text ?? '')).join('\n');
}

/**
 * A8③（v0.4.13）/ L120-H1：挑出「本段对话里提到过」的既有活跃事实，交给模型
 * 做整条改写（supersede）而不是再写一条同义事实。
 *
 * 只做字面匹配（不调 embedder、不做余弦），符合 v0.4.13 的「embedder=hash
 * 时不引入余弦」约束。L120-H1 两处修正：
 * - 同一 subject 的多条活跃事实**全部**进候选（原先只留最近强化的一条，同 subject
 *   一旦有两条旧值，模型就只能看到一条，改写另一条时必然留下孤儿事实）；
 * - 除 subject 字面命中外，`statement` 与选区文本的 bigram Jaccard ≥
 *   {@link REGION_SIMILARITY_THRESHOLD} 也算候选——同一件事换个主语写法
 *   （「用户」写给「我」、「项目 A」写成「A 项目」）时字面匹配必然漏。
 *
 * @param {object} store
 * @param {string} scope
 * @param {string} text
 * @param {{limit?: number, recallText?: string}} [options]
 * @returns {{id: string, subject_text: string, statement: string}[]}
 */
export function selectExistingFacts(store, scope, text, options = {}) {
  if (!store || typeof store.listFacts !== 'function') return [];
  // 召回块是「历史快照」，不是本段对话；匹配前先剔除，避免把召回内容当新话题。
  const recallText = typeof options.recallText === 'string' ? options.recallText : '';
  const body = typeof text === 'string' ? text.toLowerCase() : '';
  if (body === '') return [];
  const bodyTokens = textBigrams(body);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 12;
  const preferenceLimit = Number.isInteger(options.preferenceLimit) && options.preferenceLimit > 0
    ? options.preferenceLimit
    : limit;
  const rows = [];
  for (let offset = 0; ; offset += FACT_PAGE_SIZE) {
    const page = store.listFacts({ scope, limit: FACT_PAGE_SIZE, offset });
    rows.push(...page);
    if (page.length < FACT_PAGE_SIZE) break;
  }
  const literal = [];
  const preferences = [];
  for (const row of rows) {
    if (row.status !== 'active') continue;
    // 若这条事实的正文只出现在召回快照里，视为「旧内容」而非本段对话，不当作改写候选。
    if (recallText !== '' && typeof row.statement === 'string'
      && recallText.toLowerCase().includes(row.statement.toLowerCase())) continue;
    // V70-M2：偏好/生活类按 kind 取候选——用户说「我」，subject 写「用户」，字面永远
    // 命中不了；同一 subject 的多条也要全部交给模型，才能让它选一条改写。
    const kind = typeof row.kind === 'string' ? row.kind : '';
    if (PREFERENCE_KINDS.has(kind)) {
      preferences.push(row);
      continue;
    }
    const subject = typeof row.subject_text === 'string' ? row.subject_text : '';
    const subjectHit = subject !== '' && body.includes(subject.toLowerCase());
    if (!subjectHit) {
      // L120-H1：主体写法不同但内容高度重合时同样要给模型改写机会。
      if (bodyTokens.size === 0) continue;
      if (jaccard(textBigrams(row.statement), bodyTokens) < REGION_SIMILARITY_THRESHOLD) continue;
    }
    literal.push(row);
  }
  const literalRows = literal
    .sort((a, b) => Number(b.last_reinforced_at) - Number(a.last_reinforced_at))
    .slice(0, limit);
  const preferred = preferences
    .sort((a, b) => Number(b.last_reinforced_at) - Number(a.last_reinforced_at))
    .slice(0, preferenceLimit);
  const seen = new Set();
  const merged = [];
  for (const row of [...literalRows, ...preferred].sort(
    (a, b) => Number(b.last_reinforced_at) - Number(a.last_reinforced_at),
  )) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged.map((row) => ({ id: row.id, subject_text: row.subject_text, statement: row.statement }));
}

/**
 * v0.7.1 V70-M2：把 config.consolidate.existingFactsLimit 夹到合法区间。
 * @param {unknown} value
 * @returns {number}
 */
function normalizeExistingFactsLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 50) return DEFAULT_EXISTING_FACTS_LIMIT;
  return value;
}

/**
 * A8③：校验草稿里的 supersedes 目标（缺省/空串 → null；非字符串 → bad-draft）。
 * @param {object} fact
 * @param {number} index
 * @returns {string|null}
 */
function normalizeSupersedesTarget(fact, index) {
  const raw = fact?.supersedes;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw badDraft(`facts[${index}].supersedes must be a string`);
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeDraft(draft) {
  if (!isPlainObject(draft)) throw badDraft('draft must be an object');
  // A8④（v0.4.13）：纯工具/命令区间可以没有情景记忆，episode 允许为 null；
  // 但不能整段空手而归——那样说明模型没读懂，按 bad-draft 重试更安全。
  const episode = draft.episode === undefined || draft.episode === null
    ? null
    : normalizeEpisode(draft.episode);
  if (!Array.isArray(draft.facts)) throw badDraft('draft.facts must be an array');
  const facts = draft.facts.map((fact, index) => ({
    ...normalizeFact(fact, index),
    supersedes: normalizeSupersedesTarget(fact, index),
  }));
  if (draft.reminders !== undefined && draft.reminders !== null && !Array.isArray(draft.reminders)) {
    throw badDraft('draft.reminders must be an array when present');
  }
  const reminders = (draft.reminders ?? []).map((reminder, index) => normalizeReminder(reminder, index));
  if (episode === null && facts.length === 0 && reminders.length === 0) {
    throw badDraft('draft is empty (episode, facts and reminders are all absent)');
  }
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

/** C120-M3：空草稿（normalizeDraft 报的 `draft is empty …`）不是失败，是「没内容可写」。 */
function isEmptyDraftError(error) {
  return error instanceof ConsolidationError
    && error.code === 'bad-draft'
    && /draft is empty/u.test(String(error.message));
}

/** 选区文本里 surface 给工具调用/结果留的占位行（见 src/session/surface.js flattenMessage）。 */
const TOOL_PLACEHOLDER_LINE = /^\[tool (?:call|result)[^\]]*\]$/u;

/**
 * L120-H1（阶段 2 收口）：插件注入行的**正文特征**。
 *
 * surface 层现在按 `source.kind`（`src/session/surface.js` 的 `isInjectedRecord`，
 * 六 kind 与 `src/index.js` `isInjectedMessage` 一致）直接不把注入消息拼进选区，
 * 所以这里的匹配主要是兜底：外部拼装的区间文本、旧 transcript、以及绕过 surface
 * 的调用方仍可能把注入正文当作「用户说过的话」，让本来空的区间白跑 1–2 次模型。
 *
 * 只匹配插件自己写死的前缀措辞，避免误杀用户真的说「提醒我」这类句子。
 */
const INJECTED_LINE_PATTERNS = [
  // src/index.js recallMessage：召回快照整块（正常已被剥掉，这里兜底）
  /^\[相关记忆\]/u,
  /^\[\/相关记忆\]/u,
  // src/reminder/expired-notice.js：过期提醒合并告知
  /^\[提醒\]/u,
  // src/persona/emotion-wiring.js：情绪判定的注入句
  /^\[情绪\]/u,
  // src/runtime/commands.js：命令提示
  /^\[命令提示\]/u,
  // src/index.js：运行环境 / 隐私提示注入
  /^\[运行环境\]/u,
  /^\[隐私提示\]/u,
];

/**
 * C120-M3：把一行「role: text」判定为「有实质对话正文」。
 *
 * 不算正文的：空/纯空白、工具调用与结果的占位（`[tool call …]` / `[tool result]`）、
 * 召回快照残留、以及插件注入行的已知前缀（见 {@link INJECTED_LINE_PATTERNS}）。
 * 只有 user / assistant 两个角色算「用户与助手正文」——system、tool 都不算。
 *
 * @param {string} role
 * @param {string} body
 * @returns {boolean}
 */
function lineHasUserOrAssistantText(role, body) {
  const normalizedRole = String(role ?? '').trim().toLowerCase();
  if (normalizedRole !== 'user' && normalizedRole !== 'assistant') return false;
  const text = String(body ?? '').trim();
  if (text === '') return false;
  if (TOOL_PLACEHOLDER_LINE.test(text)) return false;
  if (INJECTED_LINE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return true;
}

/**
 * C120-M3 / L120-H1：这一段有没有值得交给模型的「用户与助手正文」。
 *
 * 注入消息（召回快照、情绪句、过期提醒、运行环境提示等）不是对话内容：全是注入
 * 或只有工具往来的区间巩固出来必然是空草稿，直接记 `status='empty'` 更准确，
 * 也不该计入失败。调用方若给出带 `sourceKind` 的 row，直接按 kind 判定。
 *
 * @param {{regionText?: string|null, transcript?: object[]}} input
 * @returns {boolean}
 */
export function hasConsolidatableText(input = {}) {
  const regionText = normalizeRegionText(input.regionText);
  if (regionText !== null) {
    const stripped = regionText.replace(/\[相关记忆\][\s\S]*?\[\/相关记忆\]/gu, '');
    for (const line of stripped.split('\n')) {
      const match = /^\s*([A-Za-z_-]+)\s*:\s*([\s\S]*)$/u.exec(line);
      if (match === null) continue;
      if (lineHasUserOrAssistantText(match[1], match[2])) return true;
    }
  }
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  for (const row of transcript) {
    // 带 sourceKind 的行（surface snapshot 的记录）直接按注入判定。
    if (isInjectedSourceKind(row?.sourceKind)) continue;
    if (lineHasUserOrAssistantText(row?.role, row?.text)) return true;
  }
  return false;
}

/**
 * L120-H1：这个 source.kind 是不是插件注入（与 surface.js 的白名单同源）。
 * @param {unknown} kind
 * @returns {boolean}
 */
function isInjectedSourceKind(kind) {
  return typeof kind === 'string' && INJECTED_SOURCE_KINDS.has(kind);
}

/**
 * C120-M3：调用方到底有没有给「可判定的文本来源」。
 *
 * 两个来源都缺（既没有选区文本，也没有转录）时不能断定区间为空——那只是没有证据，
 * 照旧交给模型判断；只有拿到来源且里面没有任何用户/助手正文，才算真正的空区间。
 * @param {{regionText?: string|null, transcript?: object[]}} input
 * @returns {boolean}
 */
export function hasTextSource(input = {}) {
  if (normalizeRegionText(input.regionText) !== null) return true;
  return Array.isArray(input.transcript) && input.transcript.length > 0;
}

/**
 * 构造巩固模型提示词。N1：优先使用 surface 选区文本（已含 role 标注），
 * 缺失时回退最近转录；选区文本与 seqFrom/seqTo 的对齐由调用方保证。
 * * @param {object} input
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
  const existing = Array.isArray(input.existingFacts) ? input.existingFacts : [];
  const existingLines = existing.length === 0
    ? []
    : [
      '同主题已有事实（如需整条改写，在该 fact 上加 "supersedes":"<id>"；否则只输出新增或变化的部分）：',
      // 只给 id 与主题：正文可能来自召回快照，复述会把「历史检索内容」带进巩固窗口。
      ...existing.map((row) => `- id=${row.id}｜${row.subject_text ?? ''}`),
    ];
  return [
    '你是记忆巩固器。把下面这段对话压缩成一条情景记忆与若干长期事实。',
    '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。格式：',
    '{"episode":{"title":"...","summary":"..."} 或 null,',
    ' "facts":[{"kind":"identity|relation|preference|project|lifestyle|mood|knowledge|other",',
    '           "subject_text":"...","predicate":"...","object_text":"...","statement":"..."}],',
    ' "reminders":[{"kind":"todo","title":"..."}]}',
    '对话里形如 [相关记忆] … [/相关记忆] 的段落是历史检索快照，只能作为已知内容的佐证，不得据此新建事实或改写现有结论。',
    '不得复述密码、口令、token、卡号等凭据值；必须提及时写成「用户提到一个密码」这类描述。',
    '这一段如果只是工具调用、命令与它们的输出，没有值得记住的对话内容，"episode" 写 null，不要编造情景。',
    '生活类信息也要抽：作息（几点睡/起）、饮食（口味/忌口/常吃）、兴趣（最近在看/在玩/在读）、情绪事件（为什么高兴或低落）、人际关系（家人朋友同事的近况），分别用 lifestyle / mood / relation / preference 等 kind。',
    '同一对象（例如「咖啡」）已有事实时，subject_text 保持一致（用同一个词），只输出这次新增或变化的部分，不要换词重写同一条。',
    '不要记录一次性的过程状态：HTTP 状态码、训练进度与步数（如 45/100）、临时文件路径、命令的输出或退出码、「已完成某一步」。这些不是长期事实。',
    'project 与 knowledge 类事实最多 5 条，只留真正长期有效的结论；一条事实换个说法重复出现时，只输出一次。',
    '此刻的瞬时状态（当下心情、此刻想聊轻松一点）只写进 episode 的情绪字段，不要写成 facts。',
    '只为两类记 reminders：用户明确要求提醒的；用户本人的待办或承诺。助手自己接下来要做的动作（如「回答某问题」「重启服务」「查看结果」「继续排查」）不要写提醒；已经由日程或周期安排覆盖的事项，也不要写 todo。',
    'episode 的 domain 标 "life"（生活、情绪、人际）或 "work"（工作、项目、技术）。',
    `scope=${scope} seq=${input.seqFrom}-${input.seqTo}`,
    ...existingLines,
    '对话：',
    body,
  ].join('\n');
}

/**
 * L120-H1/H3：把草稿事实整理成「写库决策」。
 *
 * 顺序即计划顺序：先按 H3a/H3d 丢一次性过程状态与瞬时情绪，再按 H3b 卡 project
 * +knowledge 的新增条数上限，最后做 H1 近似查重（同 kind active 事实比 bigram
 * Jaccard）：≥ dedupeSkip 直接强化旧条；dedupeAsk..dedupeSkip 之间**合成一次**
 * 模型裁决；低于 dedupeAsk 或没有同类事实就新写。
 *
 * 裁决调用失败（抛错/超时/不可解析）时该批按 new 保守写入并计数：宁可多一条，
 * 也不能因为一次判定失败丢掉整段巩固。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {string} input.scope
 * @param {object[]} input.facts 已过敏感/遗忘过滤的草稿事实
 * @param {{dedupeSkip?: number, dedupeAsk?: number, maxProjectFacts?: number,
 *          judge?: Function}} [input.options] `judge(prompt)` 契约：返回**已解析对象**
 *          （`{items:[{index,verdict}]}`），不是 JSON 字符串；`parseDedupeVerdicts` 直接消费对象。
 * @returns {Promise<{plans: object[], dropped: object, judged: object}>}
 */
async function planFactWrites(input) {
  const { store, scope, facts } = input;
  const options = input.options ?? {};
  const dedupeSkip = Number.isFinite(options.dedupeSkip) ? options.dedupeSkip : DEFAULT_DEDUPE_SKIP;
  const dedupeAsk = Number.isFinite(options.dedupeAsk) ? options.dedupeAsk : DEFAULT_DEDUPE_ASK;
  const maxProjectFacts = Number.isFinite(options.maxProjectFacts) && options.maxProjectFacts >= 0
    ? Math.trunc(options.maxProjectFacts)
    : DEFAULT_MAX_PROJECT_FACTS;

  const dropped = { ephemeral: 0, mood: 0, capped: 0 };
  const kept = [];
  for (const fact of facts) {
    // L120-H3d：瞬时情绪只进 episode，不进 facts。
    if (fact.kind === 'mood') {
      dropped.mood += 1;
      continue;
    }
    // L120-H3a：状态码/进度/临时路径/命令输出不是长期事实。
    if (isEphemeralFactText(fact)) {
      dropped.ephemeral += 1;
      continue;
    }
    kept.push(fact);
  }
  // L120-H3b：单次巩固的 project+knowledge 新增上限（超出丢尾部）。
  const allowed = [];
  let projectCount = 0;
  for (const fact of kept) {
    if (fact.kind === 'project' || fact.kind === 'knowledge') {
      // 0 = 一条都不写（  关闭工程类事实写入）。
    if (maxProjectFacts >= 0 && projectCount >= maxProjectFacts) {
        dropped.capped += 1;
        continue;
      }
      projectCount += 1;
    }
    allowed.push(fact);
  }

  const byKind = collectActiveFactsByKind(store, scope);
  const plans = [];
  const askIndexes = [];
  for (const fact of allowed) {
    const verdict = classifyDraftFact(fact, byKind, { dedupeSkip, dedupeAsk });
    if (verdict.verdict === 'skip') {
      plans.push({
        fact,
        mode: 'reinforce',
        targetId: verdict.match.id,
        score: verdict.score,
      });
      continue;
    }
    if (verdict.verdict === 'ask') {
      plans.push({
        fact,
        mode: 'ask',
        targetId: verdict.match.id,
        targetStatement: verdict.match.statement,
        score: verdict.score,
      });
      askIndexes.push(plans.length - 1);
      continue;
    }
    plans.push({ fact, mode: 'insert', targetId: null, score: verdict.score });
  }

  const judged = {
    asked: askIndexes.length, same: 0, update: 0, repl: 0, failed: 0,
  };
  if (askIndexes.length > 0) {
    let verdicts = null;
    if (typeof options.judge === 'function') {
      try {
        const prompt = buildDedupeJudgePrompt(askIndexes.map((planIndex) => ({
          fact: plans[planIndex].fact.statement,
          existing: plans[planIndex].targetStatement ?? '',
        })));
        verdicts = parseDedupeVerdicts(await options.judge(prompt), askIndexes.length);
      } catch {
        verdicts = null;
      }
    }
    if (verdicts === null) {
      // 判定不可用：全部按 new 保守写入，只计数（不影响整次巩固）。
      judged.failed = askIndexes.length;
      for (const planIndex of askIndexes) plans[planIndex].mode = 'insert';
    } else {
      askIndexes.forEach((planIndex, offset) => {
        const verdict = verdicts[offset];
        if (verdict === 'same') {
          plans[planIndex].mode = 'reinforce';
          judged.same += 1;
        } else if (verdict === 'update') {
          plans[planIndex].mode = 'supersede';
          judged.update += 1;
        } else {
          plans[planIndex].mode = 'insert';
          judged.repl += 1;
        }
      });
    }
  }

  return { plans, dropped, judged };
}

/**
 * L120-H4/M2/H2：提醒的去重、过滤与触发点补齐。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {string} input.scope
 * @param {object[]} input.reminders 已过敏感过滤的草稿提醒
 * @param {string} [input.timeZone] 用于 day 粒度补当地 09:00
 * @returns {{kept: object[], dropped: object}}
 */
function planReminderWrites(input) {
  const { store, scope, reminders } = input;
  const dropped = { selfAction: 0, duplicate: 0 };
  // M2：同 scope 的 pending / snoozed 标题做近似查重（一次分页拉全，避免每条提醒查库）。
  const existing = [];
  for (const status of ['pending', 'snoozed']) {
    for (let offset = 0; ; offset += REMINDER_PAGE_SIZE) {
      const page = store.listReminders({ scope, status, limit: REMINDER_PAGE_SIZE, offset });
      for (const row of page) existing.push({ id: row.id, tokens: textBigrams(row.title) });
      if (page.length < REMINDER_PAGE_SIZE) break;
    }
  }
  const kept = [];
  for (const reminder of reminders) {
    // H4：助手自己的下一步不该变成用户的待办。
    if (isAssistantSelfActionReminder(reminder)) {
      dropped.selfAction += 1;
      continue;
    }
    const tokens = textBigrams(reminder.title);
    if (tokens.size > 0
      && existing.some((row) => jaccard(tokens, row.tokens) >= REMINDER_DEDUPE_SKIP)) {
      dropped.duplicate += 1;
      continue;
    }
    if (tokens.size > 0) existing.push({ id: null, tokens });
    // H2：只有 due_at 没有 next_fire_at 的提醒永远扫不到，补触发点。
    kept.push({
      ...reminder,
      next_fire_at: reminder.next_fire_at ?? backfillNextFireAt(reminder, { timeZone: input.timeZone }),
    });
  }
  return { kept, dropped };
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

  /**
   * C120-M3：把本区间记为 `status='empty'` 并返回统一结果。
   *
   * 空不是失败：区间里确实没有可写的内容（只有注入消息/工具往来，或模型两次都判空），
   * 记一行 empty 让水位正常推进、区间允许后续压缩，不再计入 failed 与失败重试。
   * @returns {object}
   */
  const writeEmpty = () => {
    const settledMs = epochMs(clock());
    durationMs = settledMs === null ? 0 : Math.max(0, settledMs - startedMs);
    store.transaction(() => {
      store.insertConsolidation({
        scope,
        session_id: sessionId,
        kind,
        trigger,
        upto_seq: to,
        turn_from: from,
        turn_to: to,
        compaction_start_seq: from,
        status: 'empty',
        started_at: at,
        finished_at: at,
      });
    });
    return {
      skipped: false,
      empty: true,
      upto_seq: to,
      textSource,
      kind,
      episodeId: null,
      facts: 0,
      excluded: 0,
      sensitive: 0,
      notice: null,
      duration_ms: durationMs,
    };
  };

  // C120-M3：区间里没有用户/助手正文（全是注入消息或工具往来）时，模型无论怎么问
  // 都只会给空草稿。直接记 status='empty'：不算失败、不调模型，游标照常推进，
  // 于是这一区间之后可以正常压缩，也不会计入失败统计。
  // 只有在拿到文本来源时才敢这么判定；两个来源都缺是「没证据」，照旧交给模型。
  if (hasTextSource({ regionText, transcript }) && !hasConsolidatableText({ regionText, transcript })) {
    return writeEmpty();
  }

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
  const existingFacts = selectExistingFactsFromRegion(store, scope, regionText, transcript, {
    preferenceLimit: normalizeExistingFactsLimit(input.existingFactsLimit),
  });
  const draftInput = {
    scope,
    seqFrom: from,
    seqTo: to,
    regionText: regionText ?? '',
    textSource,
    transcript,
    existingFacts,
  };
  // C120-M3：空草稿不抛错给调用方，也不当失败——先按同一选区再问一次模型，
  // 仍然为空就记 status='empty'（见 writeEmpty）。
  let parsed;
  try {
    parsed = normalizeDraft(await llm(draftInput));
  } catch (error) {
    if (!isEmptyDraftError(error)) throw error;
    try {
      parsed = normalizeDraft(await llm(draftInput));
    } catch (retryError) {
      if (!isEmptyDraftError(retryError)) throw retryError;
      return writeEmpty();
    }
  }
  const { episode, facts: draftedFacts, reminders: draftedReminders } = parsed;
  // V9-M1：episode 四字段（及 topics/entities）落库前逐个脱敏，凭据值不落库；
  // store.insertEpisode 还会再做一次防御性脱敏（任何调用方都不落明文）。
  const safeEpisode = episode === null ? null : redactEpisode(episode);
  const matchedFacts = draftedFacts.filter(
    (fact) => !matchesExcludedStatement(fact.statement, excludedStatements),
  );
  const facts = matchedFacts.filter(
    (fact) => !isSensitiveText(rowSensitiveText(fact, ['statement', 'subject_text', 'object_text'])),
  );
  const excludedFacts = draftedFacts.length - matchedFacts.length;
  const safeReminders = draftedReminders.filter(
    (reminder) => !isSensitiveText(rowSensitiveText(reminder, ['title', 'detail'])),
  );
  const sensitiveCount =
    (matchedFacts.length - facts.length) + (draftedReminders.length - safeReminders.length);

  // L120-H1/H3：写库前的过滤链（H3a 一次性过程状态、H3d 瞬时情绪、H3b 上限、
  // H1 近似查重）与 L120-H2/M2/H4 的提醒处理。模型裁决必须在事务外完成。
  const factPlan = await planFactWrites({
    store,
    scope,
    facts,
    options: {
      dedupeSkip: input.dedupeSkip,
      dedupeAsk: input.dedupeAsk,
      maxProjectFacts: input.maxProjectFacts,
      judge: input.judge,
    },
  });
  const reminderPlan = planReminderWrites({
    store,
    scope,
    reminders: safeReminders,
    timeZone: input.timeZone,
  });
  const reminders = reminderPlan.kept;

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

    // A8④：episode 为 null 时（纯工具/命令区间）不写占位情景记忆。
    const episodeRow = safeEpisode === null
      ? null
      : store.insertEpisode({
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
        domain: safeEpisode.domain,
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
    let supersededFacts = 0;
    let reinforcedFacts = 0;
    // A8③：只允许改写本段候选中出现过的旧事实。
    const candidateIds = new Set(existingFacts.map((row) => row.id));
    for (const plan of factPlan.plans) {
      const { fact } = plan;
      // L120-H1：高相似 / 模型判 same —— 不新写一行，只强化旧条（used_count 与
      // last_reinforced_at 前进，召回排序跟着涨），保持「一条事实只有一个正本」。
      if (plan.mode === 'reinforce') {
        if (plan.targetId && typeof store.reinforceFact === 'function') {
          store.reinforceFact({ id: plan.targetId, scope, at });
          reinforcedFacts += 1;
        }
        continue;
      }
      const key = factKey(fact);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.active === null && existing.miss !== null) {
          store.markFirstReneed?.(existing.miss.id, { at, tier: 'miss', kind: 'dedupe' });
        }
        continue;
      }
      byKey.set(key, { active: null, miss: null });
      const inserted = store.insertFact({
        scope,
        kind: fact.kind,
        subject_id: fact.subject_id,
        subject_text: fact.subject_text,
        predicate: fact.predicate,
        object_text: fact.object_text,
        statement: fact.statement,
        source_kind: 'consolidated',
        source_episode_id: episodeRow?.id ?? null,
        source_excerpt: fact.source_excerpt,
        salience: fact.salience,
        privacy: fact.privacy,
        observed_at: fact.observed_at ?? at,
        valid_from: fact.valid_from,
        valid_to: fact.valid_to,
        fidelity: fact.fidelity,
      });
      // 需要被新行取代的旧事实有两类来源：
      // - A8③（v0.4.13）：模型按 prompt 里的 id 指定 supersedes（只接受本段候选）；
      // - L120-H1：近似查重判定 update，把最相似的旧行整条取代。
      const targets = new Set();
      if (plan.mode === 'supersede' && plan.targetId) targets.add(plan.targetId);
      if (fact.supersedes !== null && candidateIds.has(fact.supersedes)) targets.add(fact.supersedes);
      for (const targetId of targets) {
        // M1（v0.7.17）：用户红线——pinned 记忆不得被任何 update 路（模型显式
        // supersedes 与 judge 判 update 共用同一条 UPDATE）整条取代；命不中
        // 即改变 0 行，supersededFacts 计数自然不增。
        const info = store.db
          .prepare(
            `UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = ?
              WHERE id = ? AND scope = ? AND status = 'active' AND salience <> 'pinned'`,
          )
          .run(inserted.id, at, targetId, scope);
        supersededFacts += Number(info.changes) || 0;
      }
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
        source_episode_id: episodeRow?.id ?? null,
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

    // A8④：episode 为 null 时审计挂在 consolidations 行上（没有 episode 可指）。
    store.appendEvent({
      at,
      action: 'ADD',
      table_name: episodeRow === null ? 'consolidations' : 'episodes',
      row_id: episodeRow === null ? consolidation.id : episodeRow.id,
      actor: 'consolidator',
      reason: trigger,
      detail_json: {
        kind: 'consolidation',
        upto_seq: to,
        facts: insertedFacts,
        reminders: reminders.length,
        // L120-H1/H3/H4/M2：写库前的取舍全部可查（审计 + 云端对账口径）。
        dedupe: {
          reinforced: reinforcedFacts,
          superseded: supersededFacts,
          asked: factPlan.judged.asked,
          judgedSame: factPlan.judged.same,
          judgedUpdate: factPlan.judged.update,
          judgedNew: factPlan.judged.repl,
          judgeFailed: factPlan.judged.failed,
        },
        dropped: {
          ephemeral: factPlan.dropped.ephemeral,
          mood: factPlan.dropped.mood,
          capped: factPlan.dropped.capped,
          reminderSelfAction: reminderPlan.dropped.selfAction,
          reminderDuplicate: reminderPlan.dropped.duplicate,
        },
        duration_ms: durationMs,
      },
    });

    return {
      episodeId: episodeRow === null ? undefined : episodeRow.id,
      facts: insertedFacts,
      reinforced: reinforcedFacts,
      superseded: supersededFacts,
      sensitive: sensitiveCount,
    };
  });

  // 4) 事务已提交，水位推进到 to。
  return {
    skipped: false,
    empty: false,
    upto_seq: to,
    textSource,
    kind,
    episodeId: written.episodeId,
    facts: written.facts,
    reminders: reminderPlan.kept.length,
    reinforced: written.reinforced,
    superseded: written.superseded,
    excluded: excludedFacts,
    sensitive: written.sensitive,
    // L120-H1/H3/H4/M2：本次巩固的取舍计数（结果透出，便于 /状态 与审计对账）。
    dedupe: factPlan.judged,
    dropped: { ...factPlan.dropped, ...reminderPlan.dropped },
    notice: written.sensitive > 0 ? CREDENTIAL_HINT : null,
    duration_ms: durationMs,
  };
}
