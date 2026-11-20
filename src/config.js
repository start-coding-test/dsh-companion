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
  // A8②：连续注入这么多次仍未用上，就开始按 unusedPenalty 降权。
  unusedThreshold: 3,
  // A8②：降权系数（乘在 score 上）；0 表示不再召回、1 表示不降权。
  unusedPenalty: 0.85,
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

// v0.7.1 V70-M2：同义偏好去重。preference / lifestyle 类事实按 kind 取最近 N 条活跃
// 事实交给模型改写（不再要求 subject_text 在对话里字面出现）；该节同样不参与 16 键
// 安装自检（与 compact/quota/budget/task 一致）。
//
// v0.7.7 L120-H1/H3：写库前的近似查重与降量阈值。
// - dedupeSkip：同 kind 事实 bigram Jaccard ≥ 它即视为同一条，不新写只强化；
// - dedupeAsk ：≥ 它且 < dedupeSkip 的交模型裁决 same/update/new；
// - maxProjectFacts：单次巩固 project + knowledge 的新增上限（超出的丢尾部）。
const CONSOLIDATE_DEFAULTS = Object.freeze({
  existingFactsLimit: 12,
  dedupeSkip: 0.85,
  dedupeAsk: 0.5,
  maxProjectFacts: 5,
});

Object.defineProperty(DEFAULT_VALUES, 'consolidate', {
  value: CONSOLIDATE_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 L120-M1：deep-sleep 自动去重的候选门槛（同 kind 事实两两 bigram Jaccard）。
// 比治理/手动路径的 0.92 宽：自动步骤只对「明显换说法」的对子交模型判定，判 same
// 才 supersede，其余原样保留，所以门槛可以放低。
const GOVERN_DEFAULTS = Object.freeze({
  autoDedupeThreshold: 0.6,
});

Object.defineProperty(DEFAULT_VALUES, 'govern', {
  value: GOVERN_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 L120-H3c：衰减阈值。project / knowledge 事实连续 projectDormantDays 天
// 既没被召回也没被强化 → dormant（不删）。与既有 strength_days 规则叠加。
const DECAY_DEFAULTS = Object.freeze({
  projectDormantDays: 30,
});

Object.defineProperty(DEFAULT_VALUES, 'decay', {
  value: DECAY_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 L120-M3：提醒生命周期（平键，按计划字面命名）。
// - reminderStaleDays：commitment 类、无到期时间、这么久没更新 → expired；
// - reminderTodoStaleDays：todo 类、无到期时间、这么久没更新 → expired。
const DEFAULT_REMINDER_STALE_DAYS = 30;
const DEFAULT_REMINDER_TODO_STALE_DAYS = 7;

Object.defineProperty(DEFAULT_VALUES, 'reminderStaleDays', {
  value: DEFAULT_REMINDER_STALE_DAYS,
  enumerable: false,
  writable: false,
  configurable: false,
});

Object.defineProperty(DEFAULT_VALUES, 'reminderTodoStaleDays', {
  value: DEFAULT_REMINDER_TODO_STALE_DAYS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 SA-B1/SA-B4（阶段 4）：子代理派活。
// - model：默认空 = 沿用主会话路由（计划原文「模型可配（默认沿用主会话路由）」）；
//   只有显式配置且命中插件 allowlist 才经 agentOptions 传给宿主；
// - concurrency：task_run 执行槽上限（D6 把「全局单槽」改成 2）。
const SUBAGENT_DEFAULTS = Object.freeze({
  model: '',
  concurrency: 2,
});

Object.defineProperty(DEFAULT_VALUES, 'subagent', {
  value: SUBAGENT_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 W-1..W-5（阶段 6）：后台长任务（bg_run）。
// 口径来自用户《修订一》/《修订二》原文：
// - workRoot：脚本与工作目录根；空 = bg_run 工具不可用（不猜路径）；
// - interpreters：argv[0] 白名单（python3/bash/node），不做 shell 拼接；
// - runAs：进程运行身份，**默认空 = 与 50041 相同（root）**；非空时 Linux 侧
//   systemd-run 加 --uid=<runAs>（《修订二》W-1c 原文保留该控制项）；
// - maxDeadlineMin：deadline 上限（分钟，默认 360）；
// - memoryMax / cpuQuota：systemd-run 的 MemoryMax / CPUQuota 取值（用户裁决 4G / 200%）；
// - minFreeDiskMB：workRoot 剩余空间下限（默认 1024）；
// - wakeBudgetPerAgent：每个发起子代理的唤醒预算（默认 3，超预算只投主会话）。
const BG_DEFAULTS = Object.freeze({
  workRoot: '',
  interpreters: Object.freeze(['python3', 'bash', 'node']),
  runAs: '',
  // W77-M2：额外从 50041 进程透传给瞬态 service 的环境变量名（PATH/HOME 恒透传）。
  env: Object.freeze([]),
  // W77-L1（方案甲）：output.log 保留上限（MB），超出保留尾部。
  logMaxMB: 50,
  maxDeadlineMin: 360,
  memoryMax: '4G',
  cpuQuota: '200%',
  minFreeDiskMB: 1_024,
  wakeBudgetPerAgent: 3,
});

Object.defineProperty(DEFAULT_VALUES, 'bg', {
  value: BG_DEFAULTS,
  enumerable: false,
  writable: false,
  configurable: false,
});

// W-5：同一时刻允许运行的后台任务数（训练脚本占资源，默认 1，不并行）。
const DEFAULT_BG_CONCURRENCY = 1;

Object.defineProperty(DEFAULT_VALUES, 'bgConcurrency', {
  value: DEFAULT_BG_CONCURRENCY,
  enumerable: false,
  writable: false,
  configurable: false,
});

// v0.7.7 C120-M1：低于该 token 数的巩固区间不登记 pending_compact。
// 小片段压缩收益低于一次surface replace 的成本，而且更容易踩到宿主「压后不更小」
// 的确定性失败；保留默认 4096（与 retainTokens 的尾部预算同量级）。
// 与其它扩展项一致：非枚举，不参与 16 键安装自检。
const DEFAULT_COMPACT_MIN_REGION_TOKENS = 4_096;

Object.defineProperty(DEFAULT_VALUES, 'compactMinRegionTokens', {
  value: DEFAULT_COMPACT_MIN_REGION_TOKENS,
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
  const allowed = new Set([
    'minVectorScore',
    'skipSmallTalk',
    'minQueryChars',
    'chatLimit',
    'unusedThreshold',
    'unusedPenalty',
  ]);
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
  // A8②（v0.4.13）：连续多次注入却没用上的 fact 在召回里降权。
  const unusedThreshold = raw.unusedThreshold === undefined ? defaults.unusedThreshold : raw.unusedThreshold;
  if (typeof unusedThreshold !== 'number' || !Number.isInteger(unusedThreshold) || unusedThreshold < 1 || unusedThreshold > 100) {
    throw new ConfigError(
      'recall.unusedThreshold',
      `must be an integer within 1..100, got ${JSON.stringify(unusedThreshold)}`,
    );
  }
  const unusedPenalty = raw.unusedPenalty === undefined ? defaults.unusedPenalty : raw.unusedPenalty;
  if (typeof unusedPenalty !== 'number' || !Number.isFinite(unusedPenalty) || unusedPenalty < 0 || unusedPenalty > 1) {
    throw new ConfigError(
      'recall.unusedPenalty',
      `must be a finite number within 0..1, got ${JSON.stringify(unusedPenalty)}`,
    );
  }
  return Object.freeze({ minVectorScore, skipSmallTalk, minQueryChars, chatLimit, unusedThreshold, unusedPenalty });
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
 * 校验 consolidate 节：existingFactsLimit 必须是 1..50 的整数。
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{existingFactsLimit: number}>}
 */
export function normalizeConsolidate(raw, warnings = []) {
  const defaults = DEFAULTS.consolidate;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('consolidate', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['existingFactsLimit', 'dedupeSkip', 'dedupeAsk', 'maxProjectFacts']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "consolidate.${key}" ignored`);
  }
  const existingFactsLimit = raw.existingFactsLimit === undefined
    ? defaults.existingFactsLimit
    : raw.existingFactsLimit;
  if (!Number.isInteger(existingFactsLimit) || existingFactsLimit < 1 || existingFactsLimit > 50) {
    throw new ConfigError(
      'consolidate.existingFactsLimit',
      `must be an integer within 1..50, got ${JSON.stringify(existingFactsLimit)}`,
    );
  }
  // v0.7.7 L120-H1：近似查重两档阈值。数域 0 < dedupeAsk < dedupeSkip < 1——
  // 区间为空会让「交模型裁决」永远不触发，退化回精确去重，所以按错误处理而不是静默。
  const dedupeSkip = raw.dedupeSkip === undefined ? defaults.dedupeSkip : raw.dedupeSkip;
  const dedupeAsk = raw.dedupeAsk === undefined ? defaults.dedupeAsk : raw.dedupeAsk;
  if (typeof dedupeSkip !== 'number' || !Number.isFinite(dedupeSkip) || dedupeSkip <= 0 || dedupeSkip >= 1) {
    throw new ConfigError(
      'consolidate.dedupeSkip',
      `must be a number within (0,1), got ${JSON.stringify(dedupeSkip)}`,
    );
  }
  if (typeof dedupeAsk !== 'number' || !Number.isFinite(dedupeAsk) || dedupeAsk <= 0 || dedupeAsk >= 1) {
    throw new ConfigError(
      'consolidate.dedupeAsk',
      `must be a number within (0,1), got ${JSON.stringify(dedupeAsk)}`,
    );
  }
  if (!(dedupeAsk < dedupeSkip)) {
    throw new ConfigError(
      'consolidate.dedupeAsk',
      `must be strictly below consolidate.dedupeSkip (${dedupeSkip}), got ${dedupeAsk}`,
    );
  }
  const maxProjectFacts = raw.maxProjectFacts === undefined
    ? defaults.maxProjectFacts
    : raw.maxProjectFacts;
  if (!Number.isInteger(maxProjectFacts) || maxProjectFacts < 0 || maxProjectFacts > 100) {
    throw new ConfigError(
      'consolidate.maxProjectFacts',
      `must be an integer within 0..100, got ${JSON.stringify(maxProjectFacts)}`,
    );
  }
  return Object.freeze({ existingFactsLimit, dedupeSkip, dedupeAsk, maxProjectFacts });
}

/**
 * 合并自动去重节（v0.7.7 L120-M1）并校验；未知子字段 warn，越界抛 ConfigError。
 *
 * 只放「deep-sleep 自动去重」的候选门槛；治理手动路径的 0.92 仍写死在
 * `govern.js` 的 `DUPLICATE_THRESHOLD`，两者语义不同不能共用。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{autoDedupeThreshold: number}>}
 */
export function normalizeGovern(raw, warnings = []) {
  const defaults = DEFAULTS.govern;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('govern', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['autoDedupeThreshold']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "govern.${key}" ignored`);
  }
  const autoDedupeThreshold = raw.autoDedupeThreshold === undefined
    ? defaults.autoDedupeThreshold
    : raw.autoDedupeThreshold;
  if (
    typeof autoDedupeThreshold !== 'number'
    || !Number.isFinite(autoDedupeThreshold)
    || autoDedupeThreshold <= 0
    || autoDedupeThreshold >= 1
  ) {
    throw new ConfigError(
      'govern.autoDedupeThreshold',
      `must be a number within (0,1), got ${JSON.stringify(autoDedupeThreshold)}`,
    );
  }
  return Object.freeze({ autoDedupeThreshold });
}

/**
 * 合并衰减节（v0.7.7 L120-H3c）并校验。
 *
 * `projectDormantDays` 是 project / knowledge 事实「连续未被召回且未被强化」
 * 多少天后转 dormant 的阈值；0 表示关闭这条规则（仍受 strength_days 约束）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{projectDormantDays: number}>}
 */
export function normalizeDecay(raw, warnings = []) {
  const defaults = DEFAULTS.decay;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('decay', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['projectDormantDays']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "decay.${key}" ignored`);
  }
  const projectDormantDays = raw.projectDormantDays === undefined
    ? defaults.projectDormantDays
    : raw.projectDormantDays;
  if (!Number.isInteger(projectDormantDays) || projectDormantDays < 0 || projectDormantDays > 3650) {
    throw new ConfigError(
      'decay.projectDormantDays',
      `must be an integer within 0..3650, got ${JSON.stringify(projectDormantDays)}`,
    );
  }
  return Object.freeze({ projectDormantDays });
}

/**
 * 合并子代理节（v0.7.7 SA-B1/SA-B4，阶段 4）并校验。
 *
 * `model` 默认空字符串 = 沿用主会话路由（计划原文口径）；非空值只是候选，
 * 还需命中工具层的 allowlist 才会真正传给宿主，否则 warn 后回落。
 * `concurrency` 是 task_run 的执行槽上限：1..8，默认 2（D6）。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{model: string, concurrency: number}>}
 */
export function normalizeSubagent(raw, warnings = []) {
  const defaults = DEFAULTS.subagent;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('subagent', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set(['model', 'concurrency']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "subagent.${key}" ignored`);
  }
  const model = raw.model === undefined ? defaults.model : raw.model;
  if (typeof model !== 'string') {
    throw new ConfigError('subagent.model', `must be a string, got ${typeof model}`);
  }
  const concurrency = raw.concurrency === undefined ? defaults.concurrency : raw.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new ConfigError(
      'subagent.concurrency',
      `must be an integer within 1..8, got ${JSON.stringify(concurrency)}`,
    );
  }
  return Object.freeze({ model: model.trim(), concurrency });
}

/**
 * 合并后台长任务节（bg）并校验；未知子字段 warn，越界抛 ConfigError。
 *
 * 语义见 DEFAULT_VALUES.bg 的注释：workRoot 空表示工具不可用；runAs 空表示
 * 与主进程同身份（root）；interpreters 是 argv[0] 白名单，必须非空且元素非空串。
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 * @returns {Readonly<{workRoot: string, interpreters: ReadonlyArray<string>, runAs: string,
 *   maxDeadlineMin: number, memoryMax: string, cpuQuota: string,
 *   minFreeDiskMB: number, wakeBudgetPerAgent: number}>}
 */
export function normalizeBg(raw, warnings = []) {
  const defaults = DEFAULTS.bg;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('bg', `must be a plain object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const allowed = new Set([
    'workRoot',
    'interpreters',
    'runAs',
    'env',
    'logMaxMB',
    'maxDeadlineMin',
    'memoryMax',
    'cpuQuota',
    'minFreeDiskMB',
    'wakeBudgetPerAgent',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) warnings.push(`unknown config field "bg.${key}" ignored`);
  }

  const workRoot = raw.workRoot === undefined ? defaults.workRoot : raw.workRoot;
  if (typeof workRoot !== 'string') {
    throw new ConfigError('bg.workRoot', `must be a string, got ${typeof workRoot}`);
  }

  const interpreters = raw.interpreters === undefined ? defaults.interpreters : raw.interpreters;
  if (!Array.isArray(interpreters) || interpreters.length === 0) {
    throw new ConfigError('bg.interpreters', 'must be a non-empty array of program names');
  }
  for (const entry of interpreters) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError('bg.interpreters', `entries must be non-empty strings, got ${JSON.stringify(entry)}`);
    }
  }

  const runAs = raw.runAs === undefined ? defaults.runAs : raw.runAs;
  if (typeof runAs !== 'string') {
    throw new ConfigError('bg.runAs', `must be a string, got ${typeof runAs}`);
  }

  // W77-M2：额外透传的环境变量名（PATH/HOME 由 launcher 恒透传，这里只列附加项）。
  const env = raw.env === undefined ? defaults.env : raw.env;
  if (!Array.isArray(env)) {
    throw new ConfigError('bg.env', `must be an array of variable names, got ${typeof env}`);
  }
  for (const entry of env) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError('bg.env', `entries must be non-empty strings, got ${JSON.stringify(entry)}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.trim())) {
      throw new ConfigError('bg.env', `entries must be environment variable names, got ${JSON.stringify(entry)}`);
    }
  }

  // W77-L1（方案甲）：日志保留上限（MB），0 表示不截断。
  const logMaxMB = raw.logMaxMB === undefined ? defaults.logMaxMB : raw.logMaxMB;
  if (!Number.isInteger(logMaxMB) || logMaxMB < 0 || logMaxMB > 102_400) {
    throw new ConfigError('bg.logMaxMB', `must be an integer within 0..102400, got ${JSON.stringify(logMaxMB)}`);
  }

  const maxDeadlineMin = raw.maxDeadlineMin === undefined ? defaults.maxDeadlineMin : raw.maxDeadlineMin;
  if (!Number.isInteger(maxDeadlineMin) || maxDeadlineMin < 1 || maxDeadlineMin > 10_080) {
    throw new ConfigError('bg.maxDeadlineMin', `must be an integer within 1..10080, got ${JSON.stringify(maxDeadlineMin)}`);
  }

  const memoryMax = raw.memoryMax === undefined ? defaults.memoryMax : raw.memoryMax;
  if (typeof memoryMax !== 'string' || memoryMax.trim() === '') {
    throw new ConfigError('bg.memoryMax', 'must be a non-empty systemd size string (e.g. 4G)');
  }

  const cpuQuota = raw.cpuQuota === undefined ? defaults.cpuQuota : raw.cpuQuota;
  if (typeof cpuQuota !== 'string' || cpuQuota.trim() === '') {
    throw new ConfigError('bg.cpuQuota', 'must be a non-empty systemd CPUQuota string (e.g. 200%)');
  }

  const minFreeDiskMB = raw.minFreeDiskMB === undefined ? defaults.minFreeDiskMB : raw.minFreeDiskMB;
  if (!Number.isInteger(minFreeDiskMB) || minFreeDiskMB < 0 || minFreeDiskMB > 10_000_000) {
    throw new ConfigError('bg.minFreeDiskMB', `must be an integer within 0..10000000, got ${JSON.stringify(minFreeDiskMB)}`);
  }

  const wakeBudgetPerAgent = raw.wakeBudgetPerAgent === undefined
    ? defaults.wakeBudgetPerAgent
    : raw.wakeBudgetPerAgent;
  if (!Number.isInteger(wakeBudgetPerAgent) || wakeBudgetPerAgent < 0 || wakeBudgetPerAgent > 100) {
    throw new ConfigError('bg.wakeBudgetPerAgent', `must be an integer within 0..100, got ${JSON.stringify(wakeBudgetPerAgent)}`);
  }

  return Object.freeze({
    workRoot: workRoot.trim(),
    interpreters: Object.freeze(interpreters.map((entry) => entry.trim())),
    runAs: runAs.trim(),
    env: Object.freeze(env.map((entry) => entry.trim())),
    logMaxMB,
    maxDeadlineMin,
    memoryMax: memoryMax.trim(),
    cpuQuota: cpuQuota.trim(),
    minFreeDiskMB,
    wakeBudgetPerAgent,
  });
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

  // v0.7.7 C120-M1：非枚举标量（不在 16 键安装自检里），单独取值与校验。
  // 0 表示关闭「小片段不登记 pending」的闸门，便于用户回到旧行为。
  cfg.compactMinRegionTokens = input.compactMinRegionTokens === undefined
    ? DEFAULTS.compactMinRegionTokens
    : input.compactMinRegionTokens;
  requireInteger(cfg, 'compactMinRegionTokens', 0, MAX);

  // v0.7.7 L120-M3：提醒生命周期的两个平键（同为非枚举标量，按计划字面命名）。
  cfg.reminderStaleDays = input.reminderStaleDays === undefined
    ? DEFAULTS.reminderStaleDays
    : input.reminderStaleDays;
  requireInteger(cfg, 'reminderStaleDays', 1, MAX);
  cfg.reminderTodoStaleDays = input.reminderTodoStaleDays === undefined
    ? DEFAULTS.reminderTodoStaleDays
    : input.reminderTodoStaleDays;
  requireInteger(cfg, 'reminderTodoStaleDays', 1, MAX);

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
  cfg.consolidate = normalizeConsolidate(input.consolidate, warnings);
  cfg.govern = normalizeGovern(input.govern, warnings);
  cfg.decay = normalizeDecay(input.decay, warnings);
  cfg.subagent = normalizeSubagent(input.subagent, warnings);
  cfg.bg = normalizeBg(input.bg, warnings);

  // W-5：非枚举标量，与 bg 节同批；默认 1 = 训练脚本不并行。
  cfg.bgConcurrency = input.bgConcurrency === undefined
    ? DEFAULTS.bgConcurrency
    : input.bgConcurrency;
  requireInteger(cfg, 'bgConcurrency', 1, 16);

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
