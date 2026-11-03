/**
 * dsh-companion 配置层：默认值、fail-fast 校验、安静时段判定。
 * 仅使用 Node 内置能力，零第三方依赖。
 */

import { DEFAULT_TIMEZONE, isValidTimeZone, zonedMinutesOfDay } from './time.js';

export class ConfigError extends Error {
  /**
   * @param {string} field 出错的配置字段（或参数）名
   * @param {string} message 具体原因
   */
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'ConfigError';
    this.field = field;
  }
}

const DEFAULT_VALUES = {
  workingMemoryTokens: 32000,
  compactAtTokens: 24000,
  compactHardTokens: 40000,
  idleMs: 30 * 60 * 1000,
  retainTokens: 6144,
  threadIdleDays: 14,
  threadMaxActive: 6,
  proactiveDailyCap: 3,
  quietStart: '23:00',
  quietEnd: '08:00',
  timezone: DEFAULT_TIMEZONE,
  purgeAfterDays: 7,
  dbPath: './.data/companion.db',
};

// P2-b：可选向量召回；默认关闭，关闭时检索与 v0.2.0 完全一致。
// 不参与 Object.keys(DEFAULTS) 的 13 键安装自检/示例配置输出（仍是可访问的默认值），
// 避免改变既有 13 键配置面的语义；用户显式配置 vector 时照常校验。
Object.defineProperty(DEFAULT_VALUES, 'vector', {
  value: Object.freeze({ enabled: false, dim: 256, embedder: 'hash' }),
  enumerable: false,
  writable: false,
  configurable: false,
});

export const DEFAULTS = Object.freeze(DEFAULT_VALUES);

const ORDERING_RULE = '0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens';

/**
 * 把 "HH:MM" 解析为当天分钟数（0..1439），非法值抛 ConfigError。
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function parseClockField(value, field) {
  if (typeof value !== 'string') {
    throw new ConfigError(field, `must be an "HH:MM" string, got ${value === null ? 'null' : typeof value}`);
  }
  const matched = /^(\d{2}):(\d{2})$/.exec(value);
  if (!matched) {
    throw new ConfigError(field, `invalid time "${value}", expected "HH:MM"`);
  }
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (hours > 23 || minutes > 59) {
    throw new ConfigError(field, `invalid time "${value}", must be within 00:00-23:59`);
  }
  return hours * 60 + minutes;
}

/**
 * 解析 "HH:MM" 为分钟数；非法抛 ConfigError(field='clock')。
 * @param {string} str
 * @returns {number}
 */
export function parseClock(str) {
  return parseClockField(str, 'clock');
}

/**
 * 校验整数字段并带上下界。
 * @param {Record<string, unknown>} cfg
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function requireInteger(cfg, field, min, max) {
  const value = cfg[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(field, `must be an integer, got ${JSON.stringify(value)}`);
  }
  if (value < min || value > max) {
    throw new ConfigError(field, `must be within ${min}..${max}, got ${value}`);
  }
}

/**
 * 校验 vector 配置。未知子键只 warning；非法值 fail-fast。
 * @param {unknown} raw
 * @param {string[]} warnings
 * @returns {Readonly<{enabled: boolean, dim: number, embedder: 'hash'|'none'}>}
 */
function normalizeVector(raw, warnings) {
  const defaults = DEFAULTS.vector;
  if (raw === undefined) return Object.freeze({ ...defaults });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('vector', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['enabled', 'dim', 'embedder']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "vector.${key}" ignored`);
  }
  const enabled = raw.enabled === undefined ? defaults.enabled : raw.enabled;
  if (typeof enabled !== 'boolean') {
    throw new ConfigError('vector.enabled', `must be a boolean, got ${JSON.stringify(enabled)}`);
  }
  const dim = raw.dim === undefined ? defaults.dim : raw.dim;
  if (typeof dim !== 'number' || !Number.isInteger(dim) || dim < 8 || dim > 4096) {
    throw new ConfigError('vector.dim', `must be an integer within 8..4096, got ${JSON.stringify(dim)}`);
  }
  const embedder = raw.embedder === undefined ? defaults.embedder : raw.embedder;
  if (embedder !== 'hash' && embedder !== 'none') {
    throw new ConfigError('vector.embedder', `must be "hash" or "none", got ${JSON.stringify(embedder)}`);
  }
  return Object.freeze({ enabled, dim, embedder });
}

/**
 * 合并默认值并校验配置；未知字段只产生 warning，不阻断。
 * @param {Record<string, unknown>} [raw]
 * @returns {Readonly<Record<string, unknown>>} 冻结后的配置（含 warnings 数组）
 */
export function normalizeConfig(raw = {}) {
  let input = raw;
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('config', `must be a plain object, got ${Array.isArray(input) ? 'array' : typeof input}`);
  }

  const warnings = [];
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      warnings.push(`unknown config field "${key}" ignored`);
    }
  }

  const cfg = {};
  for (const key of Object.keys(DEFAULTS)) {
    cfg[key] = input[key] === undefined ? DEFAULTS[key] : input[key];
  }

  const MAX = Number.MAX_SAFE_INTEGER;
  requireInteger(cfg, 'workingMemoryTokens', 1, MAX);
  requireInteger(cfg, 'compactAtTokens', 1, MAX);
  requireInteger(cfg, 'compactHardTokens', 1, MAX);
  requireInteger(cfg, 'idleMs', 1, MAX);
  requireInteger(cfg, 'retainTokens', 1, MAX);
  requireInteger(cfg, 'threadIdleDays', 1, MAX);
  requireInteger(cfg, 'threadMaxActive', 1, MAX);
  requireInteger(cfg, 'proactiveDailyCap', 0, MAX);
  requireInteger(cfg, 'purgeAfterDays', 1, 30);

  if (!(cfg.retainTokens < cfg.compactAtTokens)) {
    throw new ConfigError('retainTokens', `must be less than compactAtTokens (expected ${ORDERING_RULE})`);
  }
  if (!(cfg.compactAtTokens < cfg.workingMemoryTokens)) {
    throw new ConfigError('compactAtTokens', `must be less than workingMemoryTokens (expected ${ORDERING_RULE})`);
  }
  if (!(cfg.workingMemoryTokens < cfg.compactHardTokens)) {
    throw new ConfigError('workingMemoryTokens', `must be less than compactHardTokens (expected ${ORDERING_RULE})`);
  }

  parseClockField(cfg.quietStart, 'quietStart');
  parseClockField(cfg.quietEnd, 'quietEnd');

  if (typeof cfg.timezone !== 'string' || cfg.timezone.trim() === '') {
    throw new ConfigError('timezone', `must be a non-empty IANA time zone, got ${JSON.stringify(cfg.timezone)}`);
  }
  if (!isValidTimeZone(cfg.timezone)) {
    throw new ConfigError('timezone', `unknown IANA time zone "${cfg.timezone}"`);
  }

  if (typeof cfg.dbPath !== 'string' || cfg.dbPath.trim() === '') {
    throw new ConfigError('dbPath', 'must be a non-empty string');
  }

  cfg.vector = normalizeVector(input.vector === undefined ? DEFAULTS.vector : input.vector, warnings);

  return Object.freeze({ ...cfg, warnings });
}

/**
 * 判断给定时刻是否处于安静时段（按 config.timezone 取分区分钟比较，支持跨午夜；
 * start == end 视为全天安静）。不依赖进程本地时区。
 * @param {Date} date
 * @param {{quietStart?: string, quietEnd?: string, timezone?: string}} [cfg]
 * @returns {boolean}
 */
export function isQuietAt(date, cfg = DEFAULTS) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ConfigError('date', 'must be a valid Date instance');
  }
  const source = cfg ?? DEFAULTS;
  const start = parseClockField(source.quietStart ?? DEFAULTS.quietStart, 'quietStart');
  const end = parseClockField(source.quietEnd ?? DEFAULTS.quietEnd, 'quietEnd');
  const timeZone = source.timezone ?? DEFAULTS.timezone;
  if (!isValidTimeZone(timeZone)) {
    throw new ConfigError('timezone', `unknown IANA time zone "${String(timeZone)}"`);
  }
  const now = zonedMinutesOfDay(date.getTime(), timeZone);

  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}
