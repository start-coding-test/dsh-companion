/**
 * 时区工具（M1）：所有「墙上时间」判断都经过这里，只看显式时区，不读
 * process.env.TZ、不写死 UTC 偏移。
 *
 * 实现只用 Intl.DateTimeFormat 的分区字段（year/month/day/hour/minute/second），
 * 因此跨夏令时也由 ICU 负责；Node 自带 ICU，零第三方依赖。
 *
 * 约定：
 * - 时间戳一律是 Unix 毫秒（number）或 Date；分区字段一律是 1..12 月；
 * - 默认时区是产品面向用户的 Asia/Shanghai，可在配置里覆盖；
 * - 分区 → 时间戳用「偏移反解」迭代：先按 UTC 猜一个瞬时，再按该瞬时在
 *   目标分区的墙上时间与目标值的差修正，最多迭代 6 次（时区偏移在一天内
 *   至多变一次，正常 1..2 次收敛）。
 */

/** 产品默认时区（与 README / 设计文档一致）。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();

/**
 * 取（并缓存）分区格式化器；非法时区由 Intl 抛 RangeError。
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 用 Intl 判断时区是否可用（等价于 Intl.DateTimeFormat 能否接受它）。
 * @param {unknown} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {number} 毫秒时间戳
 */
function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RangeError('[time] invalid Date');
    return ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`[time] expected epoch ms or Date, got ${typeof value}`);
}

/**
 * 取某个瞬时在指定分区的墙上时间字段。
 * @param {number|Date} value Unix 毫秒或 Date
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 */
export function zonedParts(value, timeZone = DEFAULT_TIMEZONE) {
  const ms = toMillis(value);
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  /** @type {Record<string, string>} */
  const fields = {};
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value;
  }
  // 个别 ICU 版本在 hourCycle=h23 下仍把午夜输出成 24；统一折叠到 0。
  const hour = Number(fields.hour) % 24;
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour,
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}

/**
 * 分区日期键 `YYYY-MM-DD`（「当日只跑一次」「备份文件名」都用它）。
 * @param {number|Date} value
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {string}
 */
export function zonedDayKey(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  const mm = String(parts.month).padStart(2, '0');
  const dd = String(parts.day).padStart(2, '0');
  return `${parts.year}-${mm}-${dd}`;
}

/**
 * 分区当天分钟数（0..1439），供安静时段/每日任务做分钟比较。
 * @param {number|Date} value
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {number}
 */
export function zonedMinutesOfDay(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  return parts.hour * 60 + parts.minute;
}

/**
 * 解析 `YYYY-MM-DD`；格式或日期非法时抛 RangeError。
 * @param {string} dayKey
 * @returns {{year: number, month: number, day: number}}
 */
export function dayKeyToParts(dayKey) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey));
  if (!matched) throw new RangeError(`[time] invalid day key "${String(dayKey)}"`);
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`[time] invalid day key "${String(dayKey)}"`);
  }
  return { year, month, day };
}

/**
 * 日期键加减天数（纯日历运算，不受时区/夏令时影响）。
 * @param {string} dayKey
 * @param {number} days 可为负
 * @returns {string}
 */
export function addDaysToDayKey(dayKey, days) {
  const { year, month, day } = dayKeyToParts(dayKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + Math.trunc(Number(days) || 0)));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 分区墙上时间 → Unix 毫秒。偏移反解迭代，跨夏令时也能落在正确的瞬时；
 * 不存在的墙上时间（春季跳变缺口）返回 ICU 归一化后的邻近瞬时。
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number}} parts
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {number}
 */
export function zonedTimeToInstant(parts, timeZone = DEFAULT_TIMEZONE) {
  const {
    year, month, day,
    hour = 0, minute = 0, second = 0,
  } = parts ?? {};
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wall = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    const delta = target - asUtc;
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

/**
 * 分区当天 00:00 的瞬时。
 * @param {number|Date} value
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {number}
 */
export function zonedStartOfDay(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  return zonedTimeToInstant({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
}

/**
 * 分区当月 1 日 00:00 的瞬时。
 * @param {number|Date} value
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {number}
 */
export function zonedStartOfMonth(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(value, timeZone);
  return zonedTimeToInstant({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
}
