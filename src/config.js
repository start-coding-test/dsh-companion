/**
 * dsh-companion 配置层：默认值、fail-fast 校验、安静时段判定。
 * 仅使用 Node 内置能力，零第三方依赖。
 */

import { DEFAULT_TIMEZONE, isValidTimeZone, zonedMinutesOfDay } from './time.js';
import { normalizeShadowMode } from './persona/shadow.js';

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
  // V4-M1：查询门的最短有效长度（按码点计，首尾标点不计），统一 2。
  // 2 字节中文实体（「蓝鲸」「生日」）因此可召回；拉丁 2 字母词仍会被
  // 问候词/算术/停用词等规则过滤，见 docs/usage.md「召回相关性门槛」。
  minQueryChars: 2,
  // A8⑥（v0.4.13）：闲聊轮最多带几条生活类记忆。默认 1，0 表示不带。
  chatLimit: 1,
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

// C5-H2：巩固（以及闲聊复用）模型的显式选路。default null 表示运行时探测：
// 依次 listProviders / listModels，跳过模型列表为空的 provider。
// 该节同样不参与 16 键安装自检（与 vector/recall/session 一致）。
const CONSOLIDATION_DEFAULTS = Object.freeze({
  model: null,
});

Object.defineProperty(DEFAULT_VALUES, 'consolidation', {
  value: CONSOLIDATION_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// V10-H1：线程会话的宿主 preset。null 表示交给宿主默认 preset（与 task_run 一致）；
// 非空字符串在创建线程会话时原样传给 createSession。宿主支持哪些 preset 只有运行时
// 才知道，因此这里不枚举校验，未知值由 thread_run 转成 preset_unknown 返回。
// 该节同样不参与 16 键安装自检（与 vector/recall/session/consolidation 一致）。
const THREAD_DEFAULTS = Object.freeze({
  agentPreset: null,
});

Object.defineProperty(DEFAULT_VALUES, 'thread', {
  value: THREAD_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// G0-9（v0.4.11）：压缩/巩固耗时的观测阈值。只用于「超阈值写一条 warn + /状态
// 标注（超阈值）」，不设硬超时、不中止任务；默认值对应真机验收口径
// （压缩 p95 ≤ 20s、巩固 p95 ≤ 60s）。
// 该节同样不参与 16 键安装自检（与 vector/recall/session/consolidation/thread 一致）。
const TIMING_DEFAULTS = Object.freeze({
  compactWarnMs: 20_000,
  consolidateWarnMs: 60_000,
});

Object.defineProperty(DEFAULT_VALUES, 'timing', {
  value: TIMING_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.4.12：人格卡文件路径。默认 null（用内置卡）；相对路径相对 DSH_HOME
// （`DSH_HOME` 否则 ~/.dsh）解析。只在 apply 时加载一次，改卡需重启。
// v0.5.0 P2：shadowDeployment 三态，默认 'off'（完全不注册 assemble 监听）。
// 该节同样不参与 16 键安装自检（与 vector/recall/session/consolidation/thread/timing 一致）。
const PERSONA_DEFAULTS = Object.freeze({
  cardPath: null,
  shadowDeployment: 'off',
});

Object.defineProperty(DEFAULT_VALUES, 'persona', {
  value: PERSONA_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.4.13 A6：压缩迟滞。minIncrementTokens = 压后实测水位之上还要涨多少才值得再压；
// cooldownTurns = 同一 scope 两次 threshold 压缩之间至少隔几轮（hard/idle 不受限）。
// 该节同样不参与 16 键安装自检（与 vector/recall/session/consolidation/thread/timing/persona 一致）。
const COMPACT_DEFAULTS = Object.freeze({
  minIncrementTokens: 4_096,
  cooldownTurns: 3,
});

// v0.4.13 A1：额度与熔断的可配置上限。dailyHardLimit 只防失控（默认 3M，与
// DAILY_TOKEN_LIMIT 一致）；window5hLimit 为 null 表示不设 5 小时窗口线。
// 该节不参与 16 键安装自检（与 quota/compact 等扩展节一致）。
const BUDGET_DEFAULTS = Object.freeze({
  dailyHardLimit: 3_000_000,
  window5hLimit: null,
});

// v0.4.13 A2：额度闸门。quota.source='none' 时完全无副作用；'file' 时读一份外部
// 写好的快照（订阅额度），任一窗口剩余低于预留线就暂停后台任务。插件不登录、
// 不碰 cookie，只读文件。
const QUOTA_DEFAULTS = Object.freeze({
  source: 'none',
  path: null,
  reserve: Object.freeze({ '5h': 0.3, '7d': 0.2, month: 0.1 }),
});

Object.defineProperty(DEFAULT_VALUES, 'quota', {
  value: QUOTA_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

Object.defineProperty(DEFAULT_VALUES, 'compact', {
  value: COMPACT_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

Object.defineProperty(DEFAULT_VALUES, 'budget', {
  value: BUDGET_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.4.13 A3：worker token 预算。tokenWarn/ tokenStop 与 src/task/limits.js 的
// WORKER_WARN_TOKENS / WORKER_STOP_TOKENS 对齐；sampleMs 是等待 idle 期间的采样间隔。
// 该节同样不参与 16 键安装自检（与 vector/recall/session/consolidation/thread/timing/persona/compact 一致）。
const TASK_DEFAULTS = Object.freeze({
  tokenWarn: 60_000,
  tokenStop: 80_000,
  sampleMs: 5_000,
});

Object.defineProperty(DEFAULT_VALUES, 'task', {
  value: TASK_DEFAULTS,
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
 * @returns {Readonly<{minVectorScore: number, skipSmallTalk: boolean, minQueryChars: number}>}
 */
export function normalizeRecall(raw, warnings = []) {
  const defaults = DEFAULTS.recall;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('recall', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['minVectorScore', 'skipSmallTalk', 'minQueryChars', 'chatLimit']);
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
  const minQueryChars = raw.minQueryChars === undefined
    ? defaults.minQueryChars
    : raw.minQueryChars;
  if (typeof minQueryChars !== 'number' || !Number.isInteger(minQueryChars)
    || minQueryChars < 1 || minQueryChars > 64) {
    throw new ConfigError(
      'recall.minQueryChars',
      `must be an integer within 1..64, got ${JSON.stringify(minQueryChars)}`,
    );
  }
  const chatLimit = raw.chatLimit === undefined ? defaults.chatLimit : raw.chatLimit;
  if (typeof chatLimit !== 'number' || !Number.isInteger(chatLimit) || chatLimit < 0 || chatLimit > 5) {
    throw new ConfigError(
      'recall.chatLimit',
      `must be an integer within 0..5, got ${JSON.stringify(chatLimit)}`,
    );
  }
  return Object.freeze({ minVectorScore, skipSmallTalk, minQueryChars, chatLimit });
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
 * 校验 consolidation 配置（C5-H2）。未知子键只 warning；非法值 fail-fast。
 *
 * `model` 缺省为 null，表示运行时探测可用 provider/model；显式配置时必须是
 * `{ provider, model }` 两个非空字符串。该节默认不参与 Object.keys(DEFAULTS)
 * 的 16 键安装自检（与 vector/recall/session 一致）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{model: Readonly<{provider: string, model: string}>|null}>}
 */
export function normalizeConsolidation(raw, warnings = []) {
  const defaults = DEFAULTS.consolidation;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'consolidation',
      `must be a plain object, got ${raw === null ? 'null' : typeof raw}`,
    );
  }
  const allowed = new Set(['model']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "consolidation.${key}" ignored`);
  }
  const model = raw.model === undefined ? null : raw.model;
  if (model === null) return defaults;
  if (typeof model !== 'object' || Array.isArray(model)) {
    throw new ConfigError(
      'consolidation.model',
      `must be { provider, model } with non-empty strings, got ${JSON.stringify(model)}`,
    );
  }
  const nestedAllowed = new Set(['provider', 'model']);
  for (const key of Object.keys(model)) {
    if (!nestedAllowed.has(key)) {
      warnings.push(`unknown config field "consolidation.model.${key}" ignored`);
    }
  }
  for (const field of ['provider', 'model']) {
    const value = model[field];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `consolidation.model.${field}`,
        `must be a non-empty string, got ${JSON.stringify(value)}`,
      );
    }
  }
  return Object.freeze({
    model: Object.freeze({ provider: model.provider.trim(), model: model.model.trim() }),
  });
}

/**
 * 校验 thread 配置（V10-H1）。未知子键只 warning；非法值 fail-fast。
 *
 * `agentPreset` 缺省为 null（不传 preset，走宿主默认）；非空字符串只 trim，
 * 不做枚举校验——宿主支持的 preset 列表运行时才可知，未知值由 thread_run
 * 捕获平台错误后返回 preset_unknown。null / 空串归一为 null。
 *
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与 vector/recall/
 * session/consolidation 一致）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{agentPreset: string|null}>}
 */
export function normalizeThread(raw, warnings = []) {
  const defaults = DEFAULTS.thread;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('thread', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['agentPreset']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "thread.${key}" ignored`);
  }
  const value = raw.agentPreset === undefined ? defaults.agentPreset : raw.agentPreset;
  if (value === null) return defaults;
  if (typeof value !== 'string') {
    throw new ConfigError('thread.agentPreset', `must be a string or null, got ${JSON.stringify(value)}`);
  }
  const agentPreset = value.trim() === '' ? null : value.trim();
  return Object.freeze({ agentPreset });
}

/**
 * 校验 timing 配置（G0-9）：压缩/巩固耗时的观测阈值。
 *
 * 两个字段都是正整数毫秒；缺省取 DEFAULTS.timing（压缩 20000、巩固 60000）。
 * 阈值只用于告警与 /状态 标注，运行时不设硬超时、不中止压缩/巩固。
 *
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与 vector/recall/
 * session/consolidation/thread 一致）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{compactWarnMs: number, consolidateWarnMs: number}>}
 */
export function normalizeTiming(raw, warnings = []) {
  const defaults = DEFAULTS.timing;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('timing', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['compactWarnMs', 'consolidateWarnMs']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "timing.${key}" ignored`);
  }
  const resolved = {
    compactWarnMs: raw.compactWarnMs === undefined ? defaults.compactWarnMs : raw.compactWarnMs,
    consolidateWarnMs: raw.consolidateWarnMs === undefined
      ? defaults.consolidateWarnMs
      : raw.consolidateWarnMs,
  };
  for (const field of ['compactWarnMs', 'consolidateWarnMs']) {
    const value = resolved[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`timing.${field}`, `must be a positive integer (ms), got ${JSON.stringify(value)}`);
    }
  }
  return Object.freeze(resolved);
}

/**
 * 校验 persona 配置（v0.4.12）：人格卡文件路径。
 *
 * `cardPath` 缺省为 null（用内置卡）；非空字符串按 DSH_HOME 相对路径解析
 * （解析规则见 persona/card.js 的 resolveCardPath），trim 后空串归一为 null，
 * 其余非字符串 fail-fast。该路径只在 apply 时加载一次，改卡需重启。
 *
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与 vector/recall/
 * session/consolidation/thread/timing 一致）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{cardPath: string|null}>}
 */
export function normalizePersona(raw, warnings = []) {
  const defaults = DEFAULTS.persona;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('persona', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['cardPath', 'shadowDeployment']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "persona.${key}" ignored`);
  }
  const value = raw.cardPath === undefined ? defaults.cardPath : raw.cardPath;
  let cardPath;
  if (value === null) {
    cardPath = null;
  } else if (typeof value !== 'string') {
    throw new ConfigError('persona.cardPath', `must be a string or null, got ${JSON.stringify(value)}`);
  } else {
    cardPath = value.trim() === '' ? null : value.trim();
  }
  const rawShadow = raw.shadowDeployment === undefined
    ? defaults.shadowDeployment
    : raw.shadowDeployment;
  const shadowDeployment = normalizeShadowMode(rawShadow);
  if (shadowDeployment === null) {
    throw new ConfigError(
      'persona.shadowDeployment',
      `must be "off", "rewrite", "takeover", true, or false, got ${JSON.stringify(rawShadow)}`,
    );
  }
  return Object.freeze({ cardPath, shadowDeployment });
}

/**
 * 校验 quota 配置（v0.4.13 A2，额度闸门）。
 *
 * `source` 只接受 none/file；file 必须给 `path`（读外部快照）。`reserve` 是三个
 * 窗口各自的预留比例（5h/7d/month），0..1，缺省 30%/20%/10%。该节同样不参与
 * 16 键安装自检。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{source: 'none'|'file', path: string|null, reserve: Readonly<Record<string, number>>}>}
 */
export function normalizeQuota(raw, warnings = []) {
  const defaults = DEFAULTS.quota;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('quota', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['source', 'path', 'reserve']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "quota.${key}" ignored`);
  }
  const source = raw.source === undefined ? defaults.source : raw.source;
  if (source !== 'none' && source !== 'file') {
    throw new ConfigError('quota.source', `must be "none" or "file", got ${JSON.stringify(source)}`);
  }
  const pathValue = raw.path === undefined ? defaults.path : raw.path;
  let path = null;
  if (pathValue !== null) {
    if (typeof pathValue !== 'string' || pathValue.trim() === '') {
      throw new ConfigError('quota.path', `must be a non-empty string or null, got ${JSON.stringify(pathValue)}`);
    }
    path = pathValue.trim();
  }
  if (source === 'file' && path === null) {
    throw new ConfigError('quota.path', 'is required when quota.source is "file"');
  }
  const reserveRaw = raw.reserve === undefined ? null : raw.reserve;
  if (reserveRaw !== null && (typeof reserveRaw !== 'object' || Array.isArray(reserveRaw))) {
    throw new ConfigError('quota.reserve', 'must be a plain object');
  }
  const reserve = {};
  for (const name of ['5h', '7d', 'month']) {
    const value = reserveRaw?.[name] === undefined ? defaults.reserve[name] : reserveRaw[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ConfigError(
        `quota.reserve.${name}`,
        `must be a number within 0..1, got ${JSON.stringify(value)}`,
      );
    }
    reserve[name] = value;
  }
  return Object.freeze({ source, path, reserve: Object.freeze(reserve) });
}

/**
 * 校验 compact 配置（v0.4.13 A6，压缩迟滞）。
 *
 * `minIncrementTokens` 是「压后水位之上再涨多少 token 才值得再压一次」，默认 4096；
 * `cooldownTurns` 是同一 scope 两次 threshold 压缩之间的最小回合数，默认 3。
 * 两者只影响 threshold 分支，hard 与 idle 触发不受限制。
 * 该节默认不参与 Object.keys(DEFAULTS) 的 16 键安装自检（与其它扩展节一致）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{minIncrementTokens: number, cooldownTurns: number}>}
 */
/**
 * 校验 budget 配置（v0.4.13 A1，额度上限）。
 *
 * 只放两个「防失控」上限：每日硬线（默认 3M）与可选的 5 小时窗口线。真正的
 * 额度判断交给 A2 的 quota 闸门；这里只保证单日不会因为 bug 或死循环无限烧。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{dailyHardLimit: number, window5hLimit: number|null}>}
 */
export function normalizeBudget(raw, warnings = []) {
  const defaults = DEFAULTS.budget;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('budget', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['dailyHardLimit', 'window5hLimit']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "budget.${key}" ignored`);
  }
  const daily = raw.dailyHardLimit === undefined ? defaults.dailyHardLimit : raw.dailyHardLimit;
  if (!Number.isInteger(daily) || daily < 100_000 || daily > 1_000_000_000_000) {
    throw new ConfigError(
      'budget.dailyHardLimit',
      `must be an integer within 100000..1000000000000, got ${JSON.stringify(daily)}`,
    );
  }
  const window = raw.window5hLimit === undefined ? defaults.window5hLimit : raw.window5hLimit;
  if (window !== null) {
    if (!Number.isInteger(window) || window < 1_000 || window > daily) {
      throw new ConfigError(
        'budget.window5hLimit',
        `must be null or an integer within 1000..dailyHardLimit, got ${JSON.stringify(window)}`,
      );
    }
  }
  return Object.freeze({ dailyHardLimit: daily, window5hLimit: window });
}

export function normalizeCompact(raw, warnings = []) {
  const defaults = DEFAULTS.compact;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('compact', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['minIncrementTokens', 'cooldownTurns']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "compact.${key}" ignored`);
  }
  const minIncrementTokens =
    raw.minIncrementTokens === undefined ? defaults.minIncrementTokens : raw.minIncrementTokens;
  if (!Number.isInteger(minIncrementTokens) || minIncrementTokens < 256 || minIncrementTokens > 1_000_000) {
    throw new ConfigError(
      'compact.minIncrementTokens',
      `must be an integer within 256..1000000, got ${JSON.stringify(minIncrementTokens)}`,
    );
  }
  const cooldownTurns = raw.cooldownTurns === undefined ? defaults.cooldownTurns : raw.cooldownTurns;
  if (!Number.isInteger(cooldownTurns) || cooldownTurns < 0 || cooldownTurns > 50) {
    throw new ConfigError(
      'compact.cooldownTurns',
      `must be an integer within 0..50, got ${JSON.stringify(cooldownTurns)}`,
    );
  }
  return Object.freeze({ minIncrementTokens, cooldownTurns });
}

/**
 * 合并任务 token 预算节并校验；未知子字段 warn，越界抛 ConfigError。
 *
 * 语义：tokenWarn 是「投递一次收尾提示」的软线，tokenStop 是「结束等待」的硬线，
 * 必须 tokenStop > tokenWarn；sampleMs 是等待 idle 期间的采样间隔。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{tokenWarn: number, tokenStop: number, sampleMs: number}>}
 */
export function normalizeTask(raw, warnings = []) {
  const defaults = DEFAULTS.task;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('task', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['tokenWarn', 'tokenStop', 'sampleMs']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "task.${key}" ignored`);
  }
  const tokenWarn = raw.tokenWarn === undefined ? defaults.tokenWarn : raw.tokenWarn;
  if (!Number.isInteger(tokenWarn) || tokenWarn < 1 || tokenWarn > 10_000_000) {
    throw new ConfigError(
      'task.tokenWarn',
      `must be an integer within 1..10000000, got ${JSON.stringify(tokenWarn)}`,
    );
  }
  const tokenStop = raw.tokenStop === undefined ? defaults.tokenStop : raw.tokenStop;
  if (!Number.isInteger(tokenStop) || tokenStop < 2 || tokenStop > 20_000_000) {
    throw new ConfigError(
      'task.tokenStop',
      `must be an integer within 2..20000000, got ${JSON.stringify(tokenStop)}`,
    );
  }
  if (tokenStop <= tokenWarn) {
    throw new ConfigError(
      'task.tokenStop',
      `must be greater than task.tokenWarn, got ${JSON.stringify(tokenStop)}`,
    );
  }
  const sampleMs = raw.sampleMs === undefined ? defaults.sampleMs : raw.sampleMs;
  if (!Number.isInteger(sampleMs) || sampleMs < 100 || sampleMs > 600_000) {
    throw new ConfigError(
      'task.sampleMs',
      `must be an integer within 100..600000, got ${JSON.stringify(sampleMs)}`,
    );
  }
  return Object.freeze({ tokenWarn, tokenStop, sampleMs });
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
  cfg.consolidation = normalizeConsolidation(input.consolidation, warnings);
  cfg.thread = normalizeThread(input.thread, warnings);
  cfg.timing = normalizeTiming(input.timing, warnings);
  cfg.persona = normalizePersona(input.persona, warnings);
  cfg.compact = normalizeCompact(input.compact, warnings);
  cfg.budget = normalizeBudget(input.budget, warnings);
  cfg.quota = normalizeQuota(input.quota, warnings);
  cfg.task = normalizeTask(input.task, warnings);

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
