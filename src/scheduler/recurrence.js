/**
 * 重复提醒的 rrule 子集与展开（纯模块，零依赖）。
 *
 * 只支持 `FREQ=DAILY` / `FREQ=WEEKLY` 两种规则；INTERVAL、COUNT、UNTIL 与
 * WEEKLY 的 BYDAY 是仅有的可选键，其余键一律按「不支持」处理。
 *
 * 展开口径：
 * - anchorAt（Unix 秒）是系列基准，取它在配置时区的**本地时刻**（时:分:秒）
 *   作为每次触发的墙上时间；DAILY 本地日 +INTERVAL 天，WEEKLY 按本地
 *   BYDAY 在周内推进（周一为一周第一天）。因此跨夏令时不会漂移：
 *   America/New_York 01:30 的日更序列在春进/秋退当天仍是本地 01:30。
 * - 墙上时间 → 瞬时一律交给 `time.js` 的 `zonedTimeToInstant`（偏移反解）。
 *   歧义时间（秋退重复的 01:30）取**较早**的那个瞬时（与 time.js 一致）；
 *   不存在的墙上时间（春进缺口）取**跨过缺口之后**的瞬时（向后归一化），
 *   这一点与 time.js 直接调用时的向后/向前摇摆不同，目的是让日更序列
 *   保持严格递增（见 resolveWallInstant 注释）。
 * - 序列从 anchorAt 起算：anchorAt 落在规则格点上时它就是 index 0；
 *   WEEKLY 的 BYDAY 不含锚点星期时，锚点周内早于锚点的格点不算数，
 *   index 0 是锚点之后第一个格点（这种输入口径下没有「锚点本身」可计入
 *   COUNT）。COUNT 计入 anchorAt 本身。
 * - 候选时刻严格大于 afterAt 才算「下一次」；afterAt 传实际送达时刻
 *   （晚于原定时刻）时，序列仍按原 anchorAt 展开，不产生漂移。
 * - 展开有 MAX_RRULE_ITERATIONS 次安全上限，超过返回 rrule_overflow。
 *
 * 时区只接受显式 IANA 名（缺省用 DEFAULT_TIMEZONE），不读 process.env.TZ，
 * 也不写死任何 UTC 偏移。
 */

import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  zonedParts,
  zonedTimeToInstant,
} from '../time.js';

/** 单次展开最多生成的候选数，防止无限循环。 */
export const MAX_RRULE_ITERATIONS = 10_000;

const DAY_MS = 86_400_000;

/** 周内顺序（周一为一周第一天）。 */
const WEEKDAY_NAMES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** @type {Map<string, number>} */
const WEEKDAY_ORDINALS = new Map(WEEKDAY_NAMES.map((name, ordinal) => [name, ordinal]));

/** 支持的键（大小写不敏感）。 */
const SUPPORTED_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']);

/**
 * @param {string} detail
 * @returns {{ok: false, reason: 'rrule_invalid', detail: string}}
 */
function invalid(detail) {
  return { ok: false, reason: 'rrule_invalid', detail };
}

/**
 * @param {string} detail
 * @returns {{ok: false, reason: 'rrule_unsupported', detail: string}}
 */
function unsupported(detail) {
  return { ok: false, reason: 'rrule_unsupported', detail };
}

/**
 * 解析 `YYYYMMDD` 或 `YYYYMMDDTHHMMSSZ`；失败返回 null。
 * 日期形态按「UTC 当日 23:59:59」折算成秒（包含当天），时刻形态按 UTC。
 * @param {string} value
 * @returns {number|null}
 */
function parseUntilValue(value) {
  const utcMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(value);
  const dayMatch = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (dayMatch !== null) {
    return utcSeconds(Number(dayMatch[1]), Number(dayMatch[2]), Number(dayMatch[3]), 23, 59, 59);
  }
  if (utcMatch !== null) {
    return utcSeconds(
      Number(utcMatch[1]), Number(utcMatch[2]), Number(utcMatch[3]),
      Number(utcMatch[4]), Number(utcMatch[5]), Number(utcMatch[6]),
    );
  }
  return null;
}

/**
 * 日历字段 → UTC 秒；字段越界（如 2 月 30 日、25 时）返回 null。
 * @returns {number|null}
 */
function utcSeconds(year, month, day, hour, minute, second) {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(ms);
  if (probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
    || probe.getUTCHours() !== hour
    || probe.getUTCMinutes() !== minute
    || probe.getUTCSeconds() !== second) {
    return null;
  }
  return Math.floor(ms / 1000);
}

/**
 * 解析 rrule 文本。
 *
 * @param {unknown} text
 * @returns {{ok: true, rule: {freq: 'DAILY'|'WEEKLY', interval: number,
 *   byDay: string[]|null, count: number|null, until: number|null}}
 *   | {ok: false, reason: 'rrule_unsupported'|'rrule_invalid', detail: string}}
 */
export function parseRRule(text) {
  if (typeof text !== 'string') return invalid('rrule must be a string');
  const trimmed = text.trim();
  if (trimmed === '') return invalid('rrule is empty');

  /** @type {Map<string, string>} */
  const fields = new Map();
  for (const rawSegment of trimmed.split(';')) {
    const segment = rawSegment.trim();
    if (segment === '') return invalid('empty rrule segment');
    const equalsAt = segment.indexOf('=');
    if (equalsAt <= 0) return invalid(`segment "${segment}" is not key=value`);
    const key = segment.slice(0, equalsAt).trim().toUpperCase();
    const value = segment.slice(equalsAt + 1).trim();
    if (key === '' || value === '') return invalid(`empty key or value in "${segment}"`);
    if (!SUPPORTED_KEYS.has(key)) return unsupported(`unsupported key ${key}`);
    // 同一键重复出现时取第一个；后续同名键整体忽略。
    if (!fields.has(key)) fields.set(key, value);
  }

  const freqText = fields.get('FREQ');
  if (freqText === undefined) return invalid('missing FREQ');
  const freq = freqText.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return unsupported(`unsupported FREQ=${freqText}`);

  let interval = 1;
  if (fields.has('INTERVAL')) {
    const rawInterval = fields.get('INTERVAL');
    if (!/^\d+$/u.test(rawInterval)) return invalid(`invalid INTERVAL=${rawInterval}`);
    interval = Number(rawInterval);
    if (!Number.isSafeInteger(interval) || interval < 1) {
      return invalid(`invalid INTERVAL=${rawInterval}`);
    }
  }

  let count = null;
  if (fields.has('COUNT')) {
    const rawCount = fields.get('COUNT');
    if (!/^\d+$/u.test(rawCount)) return invalid(`invalid COUNT=${rawCount}`);
    count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 1) return invalid(`invalid COUNT=${rawCount}`);
  }

  let until = null;
  if (fields.has('UNTIL')) {
    const rawUntil = fields.get('UNTIL');
    until = parseUntilValue(rawUntil);
    if (until === null) return invalid(`invalid UNTIL=${rawUntil}`);
  }

  /** @type {string[]|null} */
  let byDay = null;
  if (fields.has('BYDAY')) {
    if (freq !== 'WEEKLY') return unsupported('BYDAY is only supported with FREQ=WEEKLY');
    const tokens = fields.get('BYDAY').split(',').map((token) => token.trim().toUpperCase());
    if (tokens.length === 0 || tokens.some((token) => token === '')) {
      return invalid(`invalid BYDAY=${fields.get('BYDAY')}`);
    }
    /** @type {Set<string>} */
    const seen = new Set();
    for (const token of tokens) {
      if (!WEEKDAY_ORDINALS.has(token)) return invalid(`invalid BYDAY=${token}`);
      seen.add(token);
    }
    byDay = [...seen].sort((a, b) => WEEKDAY_ORDINALS.get(a) - WEEKDAY_ORDINALS.get(b));
  }

  return { ok: true, rule: { freq, interval, byDay, count, until } };
}

/**
 * 把 Date / 毫秒 / 秒统一成 Unix 秒；无效返回 null。
 * @param {unknown} value
 * @returns {number|null}
 */
function toUnixSeconds(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // 约定是 Unix 秒；兼容调用方直接给毫秒（1e11 秒在未来很远，不会误判）。
  const seconds = Math.abs(value) < 1e11 ? value : value / 1000;
  return Math.floor(seconds);
}

/**
 * 校验并规范化 rule（允许直接传 rrule 文本）。
 * @param {unknown} rule
 * @returns {{freq: 'DAILY'|'WEEKLY', interval: number, byDay: string[]|null,
 *   count: number|null, until: number|null}|null}
 */
function normalizeRule(rule) {
  if (typeof rule === 'string') {
    const parsed = parseRRule(rule);
    return parsed.ok ? parsed.rule : null;
  }
  if (rule === null || typeof rule !== 'object') return null;
  const { freq } = rule;
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return null;

  const rawInterval = rule.interval ?? 1;
  if (!Number.isSafeInteger(rawInterval) || rawInterval < 1) return null;

  /** @type {string[]|null} */
  let byDay = rule.byDay ?? null;
  if (byDay !== null) {
    if (!Array.isArray(byDay) || byDay.length === 0) return null;
    /** @type {Set<string>} */
    const seen = new Set();
    for (const token of byDay) {
      if (typeof token !== 'string') return null;
      const name = token.trim().toUpperCase();
      if (!WEEKDAY_ORDINALS.has(name)) return null;
      seen.add(name);
    }
    if (freq !== 'WEEKLY') return null;
    byDay = [...seen].sort((a, b) => WEEKDAY_ORDINALS.get(a) - WEEKDAY_ORDINALS.get(b));
  }

  let count = null;
  if (rule.count !== null && rule.count !== undefined) {
    if (!Number.isSafeInteger(rule.count) || rule.count < 1) return null;
    count = rule.count;
  }

  let until = null;
  if (rule.until !== null && rule.until !== undefined) {
    until = toUnixSeconds(rule.until);
    if (until === null) return null;
  }

  return { freq, interval: rawInterval, byDay, count, until };
}

/**
 * @param {unknown} timeZone
 * @returns {string|null} 合法 IANA 名或 null；undefined/null 取默认时区。
 */
function normalizeTimeZone(timeZone) {
  if (timeZone === undefined || timeZone === null) return DEFAULT_TIMEZONE;
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) return null;
  return timeZone;
}

/**
 * @param {number} year @param {number} month @param {number} day
 * @returns {{year: number, month: number, day: number}}
 */
function buildDate(year, month, day) {
  return { year, month, day };
}

/**
 * 本地日历日平移（纯日历运算，不受时区影响）。
 * @param {{year: number, month: number, day: number}} date
 * @param {number} days
 * @returns {{year: number, month: number, day: number}}
 */
function shiftDate(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return buildDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * 周一为 0 的周内序号。
 * @param {{year: number, month: number, day: number}} date
 * @returns {number}
 */
function mondayOrdinal(date) {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

/** @param {object} a @param {object} b @returns {boolean} */
function sameWallTime(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * 某瞬时在时区内的 UTC 偏移（毫秒）。
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
function offsetMsAt(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * 墙上时间 → 瞬时（毫秒）。
 *
 * 先用 time.js 的 zonedTimeToInstant（大多数情况一次命中）：
 * - 普通时间直接返回；
 * - 秋退歧义时间 time.js 已确定返回较早的那个瞬时；
 * - 春进缺口 time.js 的迭代会落在缺口一侧且不稳定，因此这里显式取缺口
 *   **之后**的瞬时（等价于把墙上时间向前平移缺口长度），保证 DAILY 序列
 *   严格递增；这是本模块对「不存在墙上时间」的确定口径。
 *
 * @param {{year: number, month: number, day: number, hour: number,
 *   minute: number, second: number}} wall
 * @param {string} timeZone
 * @returns {number} Unix 毫秒
 */
function resolveWallInstant(wall, timeZone) {
  const guess = zonedTimeToInstant(wall, timeZone);
  if (sameWallTime(zonedParts(guess, timeZone), wall)) return guess;

  const wallMs = Date.UTC(
    wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second,
  );
  const offsets = new Set();
  for (const delta of [-DAY_MS, 0, DAY_MS]) {
    offsets.add(offsetMsAt(wallMs + delta, timeZone));
  }
  let earliest = null;
  let latest = null;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (earliest === null || candidate < earliest) earliest = candidate;
    if (latest === null || candidate > latest) latest = candidate;
  }
  // 二次校验：若存在对得上墙上时间的候选，取较早的那个（歧义时间口径）。
  let earliestMatch = null;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (!sameWallTime(zonedParts(candidate, timeZone), wall)) continue;
    if (earliestMatch === null || candidate < earliestMatch) earliestMatch = candidate;
  }
  if (earliestMatch !== null) return earliestMatch;
  return latest ?? earliest ?? guess;
}

/**
 * @param {{year: number, month: number, day: number, hour: number,
 *   minute: number, second: number}} wall
 * @param {string} timeZone
 * @returns {number} Unix 秒
 */
function resolveWallSeconds(wall, timeZone) {
  return Math.floor(resolveWallInstant(wall, timeZone) / 1000);
}

/**
 * 生成按序列顺序排列的候选时刻（Unix 秒）。返回的函数每次调用给出下一个。
 *
 * @param {{freq: 'DAILY'|'WEEKLY', interval: number, byDay: string[]|null}} rule
 * @param {number} anchorAt Unix 秒
 * @param {string} timeZone
 * @returns {() => number}
 */
function createWalker(rule, anchorAt, timeZone) {
  const anchorParts = zonedParts(anchorAt * 1000, timeZone);
  const anchorDate = buildDate(anchorParts.year, anchorParts.month, anchorParts.day);
  const timeOfDay = {
    hour: anchorParts.hour,
    minute: anchorParts.minute,
    second: anchorParts.second,
  };

  if (rule.freq === 'DAILY') {
    let generated = 0;
    return () => {
      const index = generated;
      generated += 1;
      if (index === 0) return anchorAt;
      const date = shiftDate(anchorDate, index * rule.interval);
      return resolveWallSeconds({ ...date, ...timeOfDay }, timeZone);
    };
  }

  const anchorOrdinal = mondayOrdinal(anchorDate);
  const names = rule.byDay ?? [WEEKDAY_NAMES[anchorOrdinal]];
  const offsets = names
    .map((name) => WEEKDAY_ORDINALS.get(name))
    .sort((a, b) => a - b);
  const anchorWeekStart = shiftDate(anchorDate, -anchorOrdinal);
  // 锚点周内早于锚点的格点不属于「从 anchorAt 开始」的序列。
  const firstWeekOffsets = offsets.filter((offset) => offset >= anchorOrdinal);
  let week = 0;
  let slot = 0;

  return () => {
    for (;;) {
      const weekOffsets = week === 0 ? firstWeekOffsets : offsets;
      if (slot < weekOffsets.length) {
        const offset = weekOffsets[slot];
        slot += 1;
        if (week === 0 && offset === anchorOrdinal) return anchorAt;
        const date = shiftDate(anchorWeekStart, week * 7 * rule.interval + offset);
        return resolveWallSeconds({ ...date, ...timeOfDay }, timeZone);
      }
      week += 1;
      slot = 0;
    }
  };
}

/**
 * 下一次触发时刻。
 *
 * @param {{rule: object|string, anchorAt: number, afterAt: number,
 *   timeZone?: string}} input anchorAt/afterAt 为 Unix 秒
 * @returns {{ok: true, at: number, index: number, exhausted: false}
 *   | {ok: true, at: null, index: null, exhausted: true}
 *   | {ok: false, reason: string}}
 */
export function nextOccurrence({ rule, anchorAt, afterAt, timeZone } = {}) {
  const normalized = normalizeRule(rule);
  if (normalized === null) return { ok: false, reason: 'rrule_invalid' };
  const zone = normalizeTimeZone(timeZone);
  if (zone === null) return { ok: false, reason: 'invalid_time_zone' };
  const anchor = toUnixSeconds(anchorAt);
  const after = toUnixSeconds(afterAt);
  if (anchor === null || after === null) return { ok: false, reason: 'rrule_invalid' };

  const next = createWalker(normalized, anchor, zone);
  for (let index = 0; index < MAX_RRULE_ITERATIONS; index += 1) {
    if (normalized.count !== null && index >= normalized.count) {
      return { ok: true, at: null, index: null, exhausted: true };
    }
    const at = next();
    if (normalized.until !== null && at > normalized.until) {
      return { ok: true, at: null, index: null, exhausted: true };
    }
    if (at > after) return { ok: true, at, index, exhausted: false };
  }
  return { ok: false, reason: 'rrule_overflow' };
}

/**
 * 统计 `fromAt < at <= toAt` 的触发次数（停机错过多条时用）。
 *
 * @param {{rule: object|string, anchorAt: number, fromAt: number, toAt: number,
 *   timeZone?: string}} input anchorAt/fromAt/toAt 为 Unix 秒
 * @returns {{ok: true, count: number} | {ok: false, reason: string}}
 */
export function countOccurrencesBetween({ rule, anchorAt, fromAt, toAt, timeZone } = {}) {
  const normalized = normalizeRule(rule);
  if (normalized === null) return { ok: false, reason: 'rrule_invalid' };
  const zone = normalizeTimeZone(timeZone);
  if (zone === null) return { ok: false, reason: 'invalid_time_zone' };
  const anchor = toUnixSeconds(anchorAt);
  const from = toUnixSeconds(fromAt);
  const to = toUnixSeconds(toAt);
  if (anchor === null || from === null || to === null) {
    return { ok: false, reason: 'rrule_invalid' };
  }
  if (to <= from) return { ok: true, count: 0 };

  const next = createWalker(normalized, anchor, zone);
  let count = 0;
  for (let index = 0; index < MAX_RRULE_ITERATIONS; index += 1) {
    if (normalized.count !== null && index >= normalized.count) {
      return { ok: true, count };
    }
    const at = next();
    if (normalized.until !== null && at > normalized.until) {
      return { ok: true, count };
    }
    if (at > to) return { ok: true, count };
    if (at > from) count += 1;
  }
  return { ok: false, reason: 'rrule_overflow' };
}

/** 人话里的星期名。 */
const WEEKDAY_LABELS = {
  MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日',
};

/**
 * @param {unknown} anchorAt
 * @param {string} timeZone
 * @returns {string|null} 本地 HH:MM
 */
function formatAnchorClock(anchorAt, timeZone) {
  const seconds = toUnixSeconds(anchorAt);
  if (seconds === null) return null;
  const parts = zonedParts(seconds * 1000, timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/**
 * rrule 文本 → 人话。
 *
 * 形如「每天 08:00」「每 2 天 08:00」「每周一、周三 09:00」「每周 09:00」。
 * 时间来自可选的 anchorAt（Unix 秒；系列基准的本地墙上时间）；不传时只输出
 * 频率部分（rrule 本身不含时刻）。末尾附 `（共 N 次）` / `（至 YYYY-MM-DD）`。
 *
 * @param {unknown} text
 * @param {{timeZone?: string, anchorAt?: number|Date}} [options]
 * @returns {string}
 */
export function formatRRule(text, { timeZone, anchorAt } = {}) {
  const parsed = parseRRule(text);
  if (!parsed.ok) return '重复规则无效';
  const rule = parsed.rule;
  const zone = normalizeTimeZone(timeZone) ?? DEFAULT_TIMEZONE;

  let label;
  if (rule.freq === 'DAILY') {
    label = rule.interval === 1 ? '每天' : `每 ${rule.interval} 天`;
  } else if (rule.byDay === null) {
    label = rule.interval === 1 ? '每周' : `每 ${rule.interval} 周`;
  } else {
    const days = rule.byDay.map((name) => `周${WEEKDAY_LABELS[name]}`).join('、');
    label = rule.interval === 1 ? `每${days}` : `每 ${rule.interval} 周的${days}`;
  }

  const clock = formatAnchorClock(anchorAt, zone);
  const extras = [];
  if (rule.count !== null) extras.push(`共 ${rule.count} 次`);
  if (rule.until !== null) {
    extras.push(`至 ${new Date(rule.until * 1000).toISOString().slice(0, 10)}`);
  }
  const suffix = extras.length > 0 ? `（${extras.join('，')}）` : '';
  return `${label}${clock === null ? '' : ` ${clock}`}${suffix}`;
}
