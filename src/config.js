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
  // N-M3/W4-10：RSS 三档阈值（GiB）；4G 云端可下调到 2.2/2.4/2.6。
  rssWarnGiB: 2.95,
  rssStopGiB: 3,
  rssMainOnlyGiB: 3.15,
};

// P2-b：可选向量召回；默认关闭，关闭时检索与 v0.2.0 完全一致。
// 不参与 Object.keys(DEFAULTS) 的 16 键安装自检/示例配置输出（仍是可访问的默认值），
// 避免改变既有配置面的语义；用户显式配置 vector 时照常校验。
const VECTOR_DEFAULTS = Object.freeze({
  enabled: false,
  dim: 256,
  // W4：hash（零依赖）/ local（可选动态加载 @huggingface/transformers）/ remote（显式开启）。
  embedder: 'hash',
  localModel: 'Xenova/bge-small-zh-v1.5',
  prefixQuery: true,
  // remote 的 id 由用户指定；空字符串时回退 remote:<host>。
  embedderId: '',
  // 全局默认超时；vector.remote.timeoutMs 可单独覆盖。
  embedTimeoutMs: 300,
  // E2-M1：回填推理的独立超时。默认 30s，覆盖 2C 上 bge-small int8
  // 单批几十条的推理耗时；查询仍用 embedTimeoutMs（默认 300ms）。
  backfillTimeoutMs: 30_000,
  // 空闲回填每批条数，硬上限 50；默认 8，避免单批推理撑爆前台超时窗口。
  backfillBatchSize: 8,
  remote: Object.freeze({
    enabled: false,
    endpoint: '',
    apiKeyEnv: '',
    timeoutMs: 300,
  }),
});

Object.defineProperty(DEFAULT_VALUES, 'vector', {
  value: VECTOR_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// V3-M3：召回相关性门槛。同样不参与 16 键安装自检/示例配置输出（与 vector 一致），
// 但用户显式配置 recall.* 时照常校验。
const RECALL_DEFAULTS = Object.freeze({
  // 向量通道的最低余弦相似度；低于它的候选只靠 FTS/bigram 命中才有资格进召回。
  minVectorScore: 0.35,
  // 查询门：短查询、纯符号/算术、常见问候词一律跳过召回。
  skipSmallTalk: true,
});

Object.defineProperty(DEFAULT_VALUES, 'recall', {
  value: RECALL_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// V3-M2：main_session_id 绑定模式。同样不参与 16 键安装自检/示例配置输出，
// 但用户显式配置 session.* 时照常校验。
const SESSION_DEFAULTS = Object.freeze({
  // latest-user：最近一次真实用户输入的非线程会话成为主会话（探针/发布门不抢占）。
  // first：首个非线程会话钉死（旧行为，排障用）。
  mainBinding: 'latest-user',
});

Object.defineProperty(DEFAULT_VALUES, 'session', {
  value: SESSION_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

export const DEFAULTS = Object.freeze(DEFAULT_VALUES);

const ORDERING_RULE = '0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens';
const RSS_ORDERING_RULE = '0 < rssWarnGiB < rssStopGiB < rssMainOnlyGiB';

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
 * 校验 GiB 正数字段（RSS 三档阈值）：必须是 > 0 的有限数，不接受字符串/NaN/Infinity。
 * @param {Record<string, unknown>} cfg
 * @param {string} field
 */
function requirePositiveNumber(cfg, field) {
  const value = cfg[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(field, `must be a finite number (GiB), got ${JSON.stringify(value)}`);
  }
  if (!(value > 0)) {
    throw new ConfigError(field, `must be greater than 0, got ${value}`);
  }
}

/**
 * 校验 vector 配置。未知子键只 warning；非法值 fail-fast。
 * @param {unknown} raw
 * @param {string[]} warnings
 * @returns {Readonly<{
 *   enabled: boolean, dim: number, embedder: 'hash'|'local'|'remote'|'none',
 *   localModel: string, prefixQuery: boolean, embedderId: string,
 *   embedTimeoutMs: number, backfillTimeoutMs: number, backfillBatchSize: number,
 *   remote: Readonly<{enabled: boolean, endpoint: string, apiKeyEnv: string, timeoutMs: number}>,
 * }>}
 */
function normalizeVector(raw, warnings) {
  const defaults = DEFAULTS.vector;
  if (raw === undefined) {
    return Object.freeze({ ...defaults, remote: Object.freeze({ ...defaults.remote }) });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('vector', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set([
    'enabled', 'dim', 'embedder', 'localModel', 'prefixQuery', 'embedderId',
    'embedTimeoutMs', 'backfillTimeoutMs', 'backfillBatchSize', 'remote',
  ]);
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
  if (embedder !== 'hash' && embedder !== 'local' && embedder !== 'remote' && embedder !== 'none') {
    throw new ConfigError(
      'vector.embedder',
      `must be "hash", "local", "remote" or "none", got ${JSON.stringify(embedder)}`,
    );
  }
  const localModel = raw.localModel === undefined ? defaults.localModel : raw.localModel;
  if (typeof localModel !== 'string' || localModel.trim() === '') {
    throw new ConfigError('vector.localModel', `must be a non-empty string, got ${JSON.stringify(localModel)}`);
  }
  const prefixQuery = raw.prefixQuery === undefined ? defaults.prefixQuery : raw.prefixQuery;
  if (typeof prefixQuery !== 'boolean') {
    throw new ConfigError('vector.prefixQuery', `must be a boolean, got ${JSON.stringify(prefixQuery)}`);
  }
  const embedderId = raw.embedderId === undefined ? defaults.embedderId : raw.embedderId;
  if (typeof embedderId !== 'string') {
    throw new ConfigError('vector.embedderId', `must be a string, got ${JSON.stringify(embedderId)}`);
  }
  const embedTimeoutMs = raw.embedTimeoutMs === undefined ? defaults.embedTimeoutMs : raw.embedTimeoutMs;
  if (typeof embedTimeoutMs !== 'number' || !Number.isInteger(embedTimeoutMs)
    || embedTimeoutMs < 1 || embedTimeoutMs > 60_000) {
    throw new ConfigError(
      'vector.embedTimeoutMs',
      `must be an integer within 1..60000, got ${JSON.stringify(embedTimeoutMs)}`,
    );
  }
  const backfillTimeoutMs = raw.backfillTimeoutMs === undefined
    ? defaults.backfillTimeoutMs
    : raw.backfillTimeoutMs;
  if (typeof backfillTimeoutMs !== 'number' || !Number.isInteger(backfillTimeoutMs)
    || backfillTimeoutMs < 1 || backfillTimeoutMs > 600_000) {
    throw new ConfigError(
      'vector.backfillTimeoutMs',
      `must be an integer within 1..600000, got ${JSON.stringify(backfillTimeoutMs)}`,
    );
  }
  const backfillBatchSize = raw.backfillBatchSize === undefined
    ? defaults.backfillBatchSize
    : raw.backfillBatchSize;
  if (typeof backfillBatchSize !== 'number' || !Number.isInteger(backfillBatchSize)
    || backfillBatchSize < 1 || backfillBatchSize > 50) {
    throw new ConfigError(
      'vector.backfillBatchSize',
      `must be an integer within 1..50, got ${JSON.stringify(backfillBatchSize)}`,
    );
  }
  const remoteRaw = raw.remote === undefined ? defaults.remote : raw.remote;
  if (remoteRaw === null || typeof remoteRaw !== 'object' || Array.isArray(remoteRaw)) {
    throw new ConfigError(
      'vector.remote',
      `must be a plain object, got ${remoteRaw === null ? 'null' : typeof remoteRaw}`,
    );
  }
  const remoteAllowed = new Set(['enabled', 'endpoint', 'apiKeyEnv', 'timeoutMs']);
  for (const key of Object.keys(remoteRaw)) {
    if (!remoteAllowed.has(key)) warnings.push(`unknown config field "vector.remote.${key}" ignored`);
  }
  const remoteEnabled = remoteRaw.enabled === undefined ? defaults.remote.enabled : remoteRaw.enabled;
  if (typeof remoteEnabled !== 'boolean') {
    throw new ConfigError('vector.remote.enabled', `must be a boolean, got ${JSON.stringify(remoteEnabled)}`);
  }
  const endpoint = remoteRaw.endpoint === undefined ? defaults.remote.endpoint : remoteRaw.endpoint;
  if (typeof endpoint !== 'string') {
    throw new ConfigError('vector.remote.endpoint', `must be a string, got ${JSON.stringify(endpoint)}`);
  }
  if (remoteEnabled) {
    let validUrl = false;
    try {
      const parsed = new URL(endpoint);
      validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      validUrl = false;
    }
    if (!validUrl) {
      throw new ConfigError(
        'vector.remote.endpoint',
        `must be an http(s) URL when vector.remote.enabled=true, got ${JSON.stringify(endpoint)}`,
      );
    }
  }
  const apiKeyEnv = remoteRaw.apiKeyEnv === undefined ? defaults.remote.apiKeyEnv : remoteRaw.apiKeyEnv;
  if (typeof apiKeyEnv !== 'string') {
    throw new ConfigError('vector.remote.apiKeyEnv', `must be a string, got ${JSON.stringify(apiKeyEnv)}`);
  }
  const remoteTimeout = remoteRaw.timeoutMs === undefined ? embedTimeoutMs : remoteRaw.timeoutMs;
  if (typeof remoteTimeout !== 'number' || !Number.isInteger(remoteTimeout)
    || remoteTimeout < 1 || remoteTimeout > 60_000) {
    throw new ConfigError(
      'vector.remote.timeoutMs',
      `must be an integer within 1..60000, got ${JSON.stringify(remoteTimeout)}`,
    );
  }
  return Object.freeze({
    enabled,
    dim,
    embedder,
    localModel,
    prefixQuery,
    embedderId,
    embedTimeoutMs,
    backfillTimeoutMs,
    backfillBatchSize,
    remote: Object.freeze({
      enabled: remoteEnabled,
      endpoint,
      apiKeyEnv,
      timeoutMs: remoteTimeout,
    }),
  });
}

/**
 * 校验 recall 配置（V3-M3）。未知子键只 warning；非法值 fail-fast。
 *
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与 vector 一致），
 * 但 retrieve() 会用它给召回设默认门槛。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{minVectorScore: number, skipSmallTalk: boolean}>}
 */
export function normalizeRecall(raw, warnings = []) {
  const defaults = DEFAULTS.recall;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('recall', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['minVectorScore', 'skipSmallTalk']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "recall.${key}" ignored`);
  }
  const minVectorScore = raw.minVectorScore === undefined
    ? defaults.minVectorScore
    : raw.minVectorScore;
  if (typeof minVectorScore !== 'number' || !Number.isFinite(minVectorScore)
    || minVectorScore < 0 || minVectorScore > 1) {
    throw new ConfigError(
      'recall.minVectorScore',
      `must be a finite number within 0..1, got ${JSON.stringify(minVectorScore)}`,
    );
  }
  const skipSmallTalk = raw.skipSmallTalk === undefined
    ? defaults.skipSmallTalk
    : raw.skipSmallTalk;
  if (typeof skipSmallTalk !== 'boolean') {
    throw new ConfigError(
      'recall.skipSmallTalk',
      `must be a boolean, got ${JSON.stringify(skipSmallTalk)}`,
    );
  }
  return Object.freeze({ minVectorScore, skipSmallTalk });
}

/**
 * 校验 session 配置（V3-M2）。未知子键只 warning；非法值 fail-fast。
 *
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与 vector/recall 一致），
 * routeSession 用它决定 main_session_id 的重绑策略。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{mainBinding: 'latest-user'|'first'}>}
 */
export function normalizeSession(raw, warnings = []) {
  const defaults = DEFAULTS.session;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('session', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['mainBinding']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "session.${key}" ignored`);
  }
  const mainBinding = raw.mainBinding === undefined ? defaults.mainBinding : raw.mainBinding;
  if (mainBinding !== 'latest-user' && mainBinding !== 'first') {
    throw new ConfigError(
      'session.mainBinding',
      `must be "latest-user" or "first", got ${JSON.stringify(mainBinding)}`,
    );
  }
  return Object.freeze({ mainBinding });
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

  requirePositiveNumber(cfg, 'rssWarnGiB');
  requirePositiveNumber(cfg, 'rssStopGiB');
  requirePositiveNumber(cfg, 'rssMainOnlyGiB');
  if (!(cfg.rssWarnGiB < cfg.rssStopGiB)) {
    throw new ConfigError('rssWarnGiB', `must be less than rssStopGiB (expected ${RSS_ORDERING_RULE})`);
  }
  if (!(cfg.rssStopGiB < cfg.rssMainOnlyGiB)) {
    throw new ConfigError('rssStopGiB', `must be less than rssMainOnlyGiB (expected ${RSS_ORDERING_RULE})`);
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
  cfg.recall = normalizeRecall(input.recall === undefined ? DEFAULTS.recall : input.recall, warnings);
  cfg.session = normalizeSession(input.session, warnings);

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
