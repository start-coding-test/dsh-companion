/**
 * 额度闸门：把外部探针写下的网关额度快照换算成「后台任务是否暂停」的纯逻辑。
 *
 * 设计约束（与 src/runtime/retry.js、budget.js 一致）：
 * - 只读调用方传入的已解析对象，不登录、不读 cookie、不发任何请求；
 * - 不读全局时钟：now 一律由调用方注入（缺省时只做防御性兜底）；
 * - 不读 process.env.TZ：所有墙上时间都显式走 Intl 的 timeZone 参数；
 * - 所有导出函数对 null / 非对象入参安全，不抛异常；
 * - 没有任何第三方依赖。
 *
 * 单位约定（容易踩坑，调用方务必对齐）：
 * - 快照里的 resetAt、updatedAt 是 Unix 秒；
 * - evaluateQuota 的 now 与 QUOTA_STALE_MS 是毫秒，返回的 resumeAt 保持 Unix 秒
 *   （与 resetAt 同口径）；
 * - backoffAfter429 的 now 与返回的 retryAt 是毫秒。
 */

import { DEFAULT_TIMEZONE } from '../time.js';

/** 额度来源：none = 不限制，file = 外部探针文件。 */
export const QUOTA_SOURCES = Object.freeze(['none', 'file']);

/** 契约里已知的额度窗口名（顺序即展示顺序）。 */
export const WINDOW_NAMES = Object.freeze(['5h', '7d', 'month']);

/** 各窗口默认保留余量：剩余比例 <= 该值即视为紧张。 */
export const DEFAULT_RESERVE = Object.freeze({ '5h': 0.3, '7d': 0.2, month: 0.1 });

/** 快照超过 15 分钟未更新即视为过期（毫秒）。 */
export const QUOTA_STALE_MS = 15 * 60 * 1000;

/** @type {Readonly<{ok: false, reason: 'invalid_snapshot'}>} */
const INVALID_SNAPSHOT = Object.freeze({ ok: false, reason: 'invalid_snapshot' });

/**
 * 是否为可当记录使用的对象（排除 null、数组、函数、原始值）。
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 是否是有限整数（Number.isInteger 同时排除 NaN / Infinity / 非数字）。
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 取有限数字，否则回落到默认值。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 解析探针写出的额度快照。
 *
 * 失败一律返回 `{ok:false, reason:'invalid_snapshot'}`；未知窗口名不算失败，
 * 会被跳过并收进 `ignored`（只有出现未知名时才带该字段）。若整个快照只剩
 * 未知窗口，则按契约字面返回 `{ok:true, windows:[], ...}`，由调用方决定
 * 是否把「没有任何已知窗口」当作无额度信息。
 *
 * 严格口径：
 * - `updatedAt` / `resetAt` 缺键或显式 `null` 都表示「没有这个时间」；其它非整数判非法；
 * - resetAt / updatedAt 缺失时在输出里归一为 `null`；
 * - 只有已知窗口参与重名检查，未知名被整体忽略。
 *
 * @param {unknown} input 已 JSON.parse 的对象
 * @returns {{ok: true, windows: Array<{name: string, remaining: number, limit: number, resetAt: number|null}>, updatedAt: number|null, ignored?: string[]}
 *          | {ok: false, reason: 'invalid_snapshot'}}
 */
export function parseQuotaSnapshot(input) {
  if (!isRecord(input)) return INVALID_SNAPSHOT;
  const rawWindows = input.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) return INVALID_SNAPSHOT;

  // M-2：显式 null 表示「没有这个时间」，与缺键等价；只有非整数才判非法。
  const rawUpdatedAt = input.updatedAt;
  if (rawUpdatedAt !== undefined && rawUpdatedAt !== null && !isFiniteInteger(rawUpdatedAt)) {
    return INVALID_SNAPSHOT;
  }
  const updatedAt = rawUpdatedAt === undefined || rawUpdatedAt === null ? null : rawUpdatedAt;

  /** @type {Array<{name: string, remaining: number, limit: number, resetAt: number|null}>} */
  const windows = [];
  /** @type {string[]} */
  const ignored = [];
  const seen = new Set();

  for (const raw of rawWindows) {
    if (!isRecord(raw)) return INVALID_SNAPSHOT;
    const name = raw.name;
    if (typeof name !== 'string') return INVALID_SNAPSHOT;
    if (!WINDOW_NAMES.includes(name)) {
      ignored.push(name);
      continue;
    }
    if (seen.has(name)) return INVALID_SNAPSHOT;
    seen.add(name);

    const remaining = raw.remaining;
    const limit = raw.limit;
    if (!isFiniteInteger(remaining) || remaining < 0) return INVALID_SNAPSHOT;
    if (!isFiniteInteger(limit) || limit <= 0) return INVALID_SNAPSHOT;

    const rawResetAt = raw.resetAt;
    if (rawResetAt !== undefined && rawResetAt !== null && !isFiniteInteger(rawResetAt)) {
      return INVALID_SNAPSHOT;
    }

    windows.push({
      name,
      remaining,
      limit,
      resetAt: rawResetAt === undefined || rawResetAt === null ? null : rawResetAt,
    });
  }

  /** @type {{ok: true, windows: typeof windows, updatedAt: number|null, ignored?: string[]}} */
  const snapshot = { ok: true, windows, updatedAt };
  if (ignored.length > 0) snapshot.ignored = ignored;
  return snapshot;
}

/**
 * 计算单个窗口的剩余比例；手工构造的脏数据按「已用尽」处理，宁可少跑不多跑。
 * @param {{remaining?: unknown, limit?: unknown}} window
 * @returns {number}
 */
function windowRatio(window) {
  const remaining = window.remaining;
  const limit = window.limit;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 1;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 1;
  return remaining / limit;
}

/**
 * 取窗口的保留阈值；缺失/非法时回落默认值，避免自定义 reserve 漏键把闸门关死。
 * @param {Record<string, unknown>} reserve
 * @param {string} name
 * @returns {number}
 */
function thresholdFor(reserve, name) {
  const custom = reserve[name];
  if (typeof custom === 'number' && Number.isFinite(custom)) return custom;
  return DEFAULT_RESERVE[/** @type {'5h'|'7d'|'month'} */ (name)];
}

/**
 * 评估额度状态。
 *
 * 判定顺序（前者优先）：无快照 -> 过期 -> 紧张 -> 充裕。
 * 过期边界：`now - updatedAt*1000 > staleMs` 才算过期，恰好 15 分钟仍按新鲜处理
 * （测试 test/quota.test.js 锁定该口径）；updatedAt 缺失一律算过期。
 * 紧张边界：`remaining/limit <= reserve[name]`（含等号）。
 * resumeAt：紧张窗口 resetAt 的最小值（Unix 秒），全部缺失时为 null。
 *
 * 返回值除契约要求的字段外，额外带 `windows`（全部已知窗口及比例，供
 * formatQuotaLine 拼「充裕」明细）和过期时的 `staleMs`。
 *
 * @param {unknown} snapshot parseQuotaSnapshot 的成功结果
 * @param {{now?: number, reserve?: Record<string, number>, staleMs?: number}} [options]
 * @returns {{state: 'none'|'stale'|'ok'|'tight', paused: boolean,
 *            tightWindows: Array<{name: string, ratio: number, remaining: number, limit: number, resetAt: number|null}>,
 *            resumeAt: number|null,
 *            windows: Array<{name: string, ratio: number, remaining: number, limit: number, resetAt: number|null}>,
 *            staleMs?: number}}
 */
export function evaluateQuota(snapshot, options = {}) {
  const opts = isRecord(options) ? options : {};
  const now = finiteOr(opts.now, Date.now());
  const staleMs = finiteOr(opts.staleMs, QUOTA_STALE_MS);
  const reserve = isRecord(opts.reserve) ? opts.reserve : DEFAULT_RESERVE;

  if (!isRecord(snapshot) || snapshot.ok !== true) {
    return {
      state: /** @type {'none'} */ ('none'),
      paused: false,
      tightWindows: [],
      resumeAt: null,
      windows: [],
    };
  }

  /** @type {Array<{name: string, ratio: number, remaining: number, limit: number, resetAt: number|null}>} */
  const windows = [];
  if (Array.isArray(snapshot.windows)) {
    for (const raw of snapshot.windows) {
      if (!isRecord(raw) || typeof raw.name !== 'string') continue;
      windows.push({
        name: raw.name,
        ratio: windowRatio(raw),
        remaining: finiteOr(raw.remaining, 0),
        limit: finiteOr(raw.limit, 0),
        resetAt: isFiniteInteger(raw.resetAt) ? raw.resetAt : null,
      });
    }
  }

  const updatedAt = isFiniteInteger(snapshot.updatedAt) ? snapshot.updatedAt : null;
  if (updatedAt === null || now - updatedAt * 1000 > staleMs) {
    return {
      state: /** @type {'stale'} */ ('stale'),
      paused: false,
      tightWindows: [],
      resumeAt: null,
      windows,
      staleMs,
    };
  }

  const tightWindows = windows.filter((window) => {
    const threshold = thresholdFor(reserve, window.name);
    return typeof threshold === 'number' && window.ratio <= threshold;
  });

  if (tightWindows.length === 0) {
    return {
      state: /** @type {'ok'} */ ('ok'),
      paused: false,
      tightWindows: [],
      resumeAt: null,
      windows,
    };
  }

  /** @type {number|null} */
  let resumeAt = null;
  for (const window of tightWindows) {
    if (window.resetAt === null) continue;
    if (resumeAt === null || window.resetAt < resumeAt) resumeAt = window.resetAt;
  }

  return {
    state: /** @type {'tight'} */ ('tight'),
    paused: true,
    tightWindows,
    resumeAt,
    windows,
  };
}

/**
 * 合并并校验各窗口的保留余量。
 *
 * 校验口径：0 < r < 1；非数字、NaN/Infinity、越界一律回落默认值并记入
 * warnings（按 WINDOW_NAMES 顺序，便于稳定断言）。未知键忽略、不告警。
 *
 * @param {unknown} [overrides]
 * @returns {Readonly<{'5h': number, '7d': number, month: number, warnings: string[]}>}
 */
export function computeReserve(overrides) {
  const source = isRecord(overrides) ? overrides : {};
  const warnings = [];
  /** @type {{'5h': number, '7d': number, month: number, warnings: string[]}} */
  const reserve = { '5h': DEFAULT_RESERVE['5h'], '7d': DEFAULT_RESERVE['7d'], month: DEFAULT_RESERVE.month, warnings };
  for (const name of WINDOW_NAMES) {
    if (!Object.hasOwn(source, name)) continue;
    const value = source[name];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1) {
      reserve[name] = value;
    } else {
      warnings.push(name);
    }
  }
  return Object.freeze(reserve);
}

/**
 * 429 之后的退避计划。
 *
 * - resetAt 是 Unix 秒；若 `resetAt*1000 > now`，直接按上游恢复时间重试，
 *   attempt 原样返回（不递增）；
 * - 否则指数退避 `min(60, 2**max(0,attempt))` 分钟，返回 now + 该毫秒数，
 *   attempt+1；attempt 缺失/非法按 0 处理。
 *
 * @param {{now?: number, resetAt?: number, attempt?: number}} [options]
 * @returns {{retryAt: number, attempt: number}}
 */
export function backoffAfter429(options = {}) {
  const opts = isRecord(options) ? options : {};
  const now = finiteOr(opts.now, Date.now());
  const attempt = Number.isInteger(opts.attempt) && opts.attempt >= 0 ? opts.attempt : 0;
  const resetAt = opts.resetAt;

  if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt * 1000 > now) {
    return { retryAt: resetAt * 1000, attempt };
  }
  const minutes = Math.min(60, 2 ** Math.max(0, attempt));
  return { retryAt: now + minutes * 60_000, attempt: attempt + 1 };
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const FORMATTERS = new Map();

/**
 * 构造（并缓存）zh-CN 的 MM-DD HH:mm 分区格式化器。
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * 取格式化器；非法时区回落到产品默认时区，绝不让 /status 因配置手滑而抛错。
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterOrFallback(timeZone) {
  try {
    return formatterFor(timeZone);
  } catch {
    return formatterFor(DEFAULT_TIMEZONE);
  }
}

/**
 * Unix 秒 -> `MM-DD HH:mm`（显式时区，不使用 process.env.TZ）。
 * @param {unknown} resumeAt 秒
 * @param {string} timeZone
 * @returns {string|null}
 */
function formatResumeAt(resumeAt, timeZone) {
  if (typeof resumeAt !== 'number' || !Number.isFinite(resumeAt)) return null;
  try {
    const parts = formatterOrFallback(timeZone).formatToParts(new Date(resumeAt * 1000));
    /** @param {string} type */
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
    const month = pick('month');
    const day = pick('day');
    const hour = pick('hour');
    const minute = pick('minute');
    if (month === '' || day === '' || hour === '' || minute === '') return null;
    return `${month}-${day} ${hour}:${minute}`;
  } catch {
    return null;
  }
}

/**
 * 比例转百分比；向下取整，避免把「快用完了」显示得比实际宽裕。
 * @param {unknown} ratio
 * @returns {number}
 */
function percentOf(ratio) {
  const value = typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : 0;
  return Math.max(0, Math.min(100, Math.floor(value * 100 + 1e-9)));
}

/**
 * 拼「5h 剩余 62%，7d 41%，month 33%」这样的明细：只有第一项带「剩余」，
 * 后续沿用中文省略口径；按 WINDOW_NAMES 顺序稳定输出。
 * @param {unknown} windows
 * @returns {string}
 */
function formatRatios(windows) {
  if (!Array.isArray(windows)) return '';
  const order = (/** @type {string} */ name) => {
    const index = WINDOW_NAMES.indexOf(name);
    return index === -1 ? WINDOW_NAMES.length : index;
  };
  return windows
    .filter((window) => isRecord(window) && typeof window.name === 'string')
    .slice()
    .sort((a, b) => order(a.name) - order(b.name))
    .map((window, index) => {
      const ratio = typeof window.ratio === 'number' && Number.isFinite(window.ratio)
        ? window.ratio
        : windowRatio(window);
      const label = index === 0 ? '剩余 ' : '';
      return `${window.name} ${label}${percentOf(ratio)}%`;
    })
    .join('，');
}

/**
 * 为 /status 生成一行中文额度文案。
 *
 * 四种形态：
 * - `额度：不限（quota.source=none）`
 * - `额度：快照过期（updatedAt 超过 15 分钟），按不限处理`
 * - `额度：充裕（5h 剩余 62%，7d 41%，month 33%）`
 * - `额度紧张，后台暂停至 11-14 09:00（5h 剩余 3%，7d 12%）`
 *
 * `timeZone` 非法时回落 Asia/Shanghai。`now` 目前不参与文案（过期阈值写到
 * 文案里即可），保留参数是为了与 evaluateQuota 共用同一个调用上下文。
 *
 * @param {unknown} evaluation evaluateQuota 的结果
 * @param {{now?: number, timeZone?: string}} [options]
 * @returns {string}
 */
export function formatQuotaLine(evaluation, options = {}) {
  const opts = isRecord(options) ? options : {};
  const timeZone = typeof opts.timeZone === 'string' && opts.timeZone.trim() !== ''
    ? opts.timeZone
    : DEFAULT_TIMEZONE;
  const value = isRecord(evaluation) ? evaluation : {};

  if (value.state === 'stale') {
    const staleMs = finiteOr(value.staleMs, QUOTA_STALE_MS);
    const minutes = Math.max(1, Math.round(staleMs / 60_000));
    return `额度：快照过期（updatedAt 超过 ${minutes} 分钟），按不限处理`;
  }

  if (value.state === 'tight') {
    const detail = formatRatios(value.tightWindows);
    const resume = formatResumeAt(value.resumeAt, timeZone);
    const head = resume === null ? '额度紧张，后台暂停' : `额度紧张，后台暂停至 ${resume}`;
    return detail === '' ? head : `${head}（${detail}）`;
  }

  if (value.state === 'ok') {
    const detail = formatRatios(value.windows);
    return detail === '' ? '额度：充裕' : `额度：充裕（${detail}）`;
  }

  return '额度：不限（quota.source=none）';
}
