/**
 * M4：每日 token 熔断 + RSS 三档降级。
 *
 * 设计约束：
 * - 纯函数/可注入时钟与内存读数，便于单测；模块本身不读全局单例；
 * - 日界按配置 IANA 时区（与 M1 的日键语义一致），不读 process.env.TZ；
 * - RSS 只做保护性降级，不主动 GC、不杀进程；读不到内存读数时按 ok 处理，
 *   绝不让保护逻辑自己变成故障源；
 * - RSS 三档阈值默认 2.95/3.0/3.15GiB，可由 config 的
 *   rssWarnGiB/rssStopGiB/rssMainOnlyGiB 覆盖（N-M3/W4-10：4G 云端按
 *   `min(userLimit, totalmem×0.75−512MiB)` 预算下调到约 2.2/2.4/2.6）；
 * - 阈值单位按二进制 GiB（源码注释写作 GB，节点里常用 1024^3 口径）。
 */

import os from 'node:os';
import { DEFAULT_TIMEZONE, zonedDayKey } from '../time.js';

/** GiB，阈值口径与 `process.memoryUsage().rss` 一致（字节）。 */
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** 每日 token 熔断线：3M。 */
export const DAILY_TOKEN_LIMIT = 3_000_000;

/**
 * 从配置读取每日硬线（v0.4.13 A1）。配置缺失/非法时退回 DAILY_TOKEN_LIMIT，
 * 保护逻辑不能因为配置错误而失效。
 * @param {{budget?: {dailyHardLimit?: unknown}}|null} [config]
 * @returns {number}
 */
export function dailyLimitFromConfig(config) {
  const value = config !== null && typeof config === 'object'
    ? config.budget?.dailyHardLimit
    : undefined;
  return Number.isInteger(value) && value >= 100_000 ? value : DAILY_TOKEN_LIMIT;
}

/** RSS 三档默认阈值（GiB）：2.95 / 3.0 / 3.15。 */
export const DEFAULT_RSS_GIB = Object.freeze({ warn: 2.95, stop_dispatch: 3, main_only: 3.15 });

/** RSS 三档默认阈值（字节）；N-M3/W4-10 起可被 config 的 rss*GiB 覆盖。 */
export const RSS_WARN_BYTES = Math.round(DEFAULT_RSS_GIB.warn * GIB);
export const RSS_STOP_DISPATCH_BYTES = Math.round(DEFAULT_RSS_GIB.stop_dispatch * GIB);
export const RSS_MAIN_ONLY_BYTES = Math.round(DEFAULT_RSS_GIB.main_only * GIB);

/**
 * 从配置读取 RSS 三档阈值，换算成 `checkMemory` 需要的字节口径。
 *
 * 配置层 `normalizeConfig` 已校验 `0 < rssWarnGiB < rssStopGiB < rssMainOnlyGiB`；
 * 这里对缺失/非法/乱序的值退回默认阈值——保护逻辑不能自己变成故障源。
 * @param {{rssWarnGiB?: unknown, rssStopGiB?: unknown, rssMainOnlyGiB?: unknown}} [config]
 * @returns {{bytes: {warn: number, stop_dispatch: number, main_only: number},
 *            gib: {warn: number, stop_dispatch: number, main_only: number}}}
 */
export function rssLimitsFromConfig(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const warn = toPositive(source.rssWarnGiB);
  const stop = toPositive(source.rssStopGiB);
  const mainOnly = toPositive(source.rssMainOnlyGiB);
  const ordered = warn !== null && stop !== null && mainOnly !== null
    && warn < stop && stop < mainOnly;
  const gib = ordered ? Object.freeze({ warn, stop_dispatch: stop, main_only: mainOnly }) : DEFAULT_RSS_GIB;
  return Object.freeze({
    gib,
    bytes: Object.freeze({
      warn: Math.round(gib.warn * GIB),
      stop_dispatch: Math.round(gib.stop_dispatch * GIB),
      main_only: Math.round(gib.main_only * GIB),
    }),
  });
}

/** 数值化档位，便于写进 metrics（0=ok ... 3=main_only）。 */
export const RSS_LEVELS = Object.freeze({
  ok: 0,
  warn: 1,
  stop_dispatch: 2,
  main_only: 3,
});

/** 工具层拒绝原因；保持稳定字符串，模型/命令可以直接展示。 */
export const BUDGET_REASONS = Object.freeze({
  daily: 'daily_budget_exceeded',
  memory: 'memory_pressure',
  mainOnly: 'memory_main_only',
});

/** @typedef {'ok'|'warn'|'stop_dispatch'|'main_only'} RssLevel */

/**
 * 建一个可变的每日用量状态。
 * @param {{dailyTokens?: number, dailyDayKey?: string|null, tokens?: number, dayKey?: string|null}} [initial]
 * @returns {{dailyTokens: number, dailyDayKey: string|null}}
 */
export function createBudgetState(initial = {}) {
  const input = initial !== null && typeof initial === 'object' ? initial : {};
  const tokens = toNonNegative(input.dailyTokens ?? input.tokens);
  const dayKey = typeof input.dailyDayKey === 'string' && input.dailyDayKey !== ''
    ? input.dailyDayKey
    : (typeof input.dayKey === 'string' && input.dayKey !== '' ? input.dayKey : null);
  return { dailyTokens: tokens ?? 0, dailyDayKey: dayKey };
}

/**
 * 把毫秒/Date/注入 clock 统一成毫秒时间戳。
 * @param {number|Date|undefined} at
 * @param {(() => number)|undefined} clock
 * @returns {number}
 */
function resolveNow(at, clock) {
  if (at instanceof Date) {
    const ms = at.getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof clock === 'function') {
    try {
      const value = clock();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    } catch {
      // 注入时钟异常时退回系统时钟，保护逻辑不能因此中断。
    }
  }
  return Date.now();
}

/**
 * 计算分区日键；时区非法时退回默认时区（配置层已校验，这里只兜底）。
 * @param {number} ms
 * @param {string} timeZone
 * @returns {string}
 */
function dayKeyOf(ms, timeZone) {
  try {
    return zonedDayKey(ms, timeZone);
  } catch {
    return zonedDayKey(ms, DEFAULT_TIMEZONE);
  }
}

/**
 * 跨日则清零。仅在调用方明确提供 at/clock 时执行，避免纯比较函数改状态。
 * @param {{dailyTokens:number, dailyDayKey:string|null}} state
 * @param {number} ms
 * @param {string} timeZone
 * @returns {boolean} 是否发生了跨日复位
 */
function rolloverIfNeeded(state, ms, timeZone) {
  const key = dayKeyOf(ms, timeZone);
  if (state.dailyDayKey === key) return false;
  state.dailyDayKey = key;
  state.dailyTokens = 0;
  return true;
}

/**
 * 记一轮 token 用量：先按本地日键复位，再累加。
 * @param {{dailyTokens:number, dailyDayKey:string|null}} state
 * @param {number} deltaTokens 本轮新增 token（负数/非有限值忽略）
 * @param {{at?: number|Date, timezone?: string, clock?: () => number}} [options]
 * @returns {number} 累加后的当日总量
 */
export function recordTurnUsage(state, deltaTokens, options = {}) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return 0;
  const { at, timezone = DEFAULT_TIMEZONE, clock } = options;
  const ms = resolveNow(at, clock);
  rolloverIfNeeded(state, ms, timezone);

  const delta = toNonNegative(deltaTokens);
  if (delta !== null && delta > 0) {
    const current = toNonNegative(state.dailyTokens) ?? 0;
    state.dailyTokens = current + delta;
  }
  return state.dailyTokens;
}

/**
 * 当日是否已到/超过熔断线。
 *
 * 传 at/clock 时顺带处理跨日复位（每日自动解除）；不传则只读比较，
 * 避免调用方只想知道状态却意外改掉累计值。
 * @param {{dailyTokens:number, dailyDayKey:string|null}} state
 * @param {number} [limit=DAILY_TOKEN_LIMIT]
 * @param {{at?: number|Date, timezone?: string, clock?: () => number}} [options]
 * @returns {boolean}
 */
export function overDailyBudget(state, limit = DAILY_TOKEN_LIMIT, options = {}) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  if (options.at !== undefined || typeof options.clock === 'function') {
    const ms = resolveNow(options.at, options.clock);
    rolloverIfNeeded(state, ms, options.timezone ?? DEFAULT_TIMEZONE);
  }
  const threshold = toPositive(limit) ?? DAILY_TOKEN_LIMIT;
  return (toNonNegative(state.dailyTokens) ?? 0) >= threshold;
}

/**
 * 读 RSS 并给出降级档位。
 *
 * `rss`/`totalmem` 优先；缺失时用 `rssReader`（默认 process.memoryUsage）与
 * os.totalmem()。任何读取/类型异常都按 ok 处理。
 * @param {{
 *   rss?: number,
 *   totalmem?: number,
 *   limits?: {warn?: number, warnBytes?: number,
 *             stop_dispatch?: number, stopDispatch?: number, stopDispatchBytes?: number,
 *             main_only?: number, mainOnly?: number, mainOnlyBytes?: number},
 *   rssReader?: () => number
 * }} [input]
 * @returns {{level: RssLevel, code: number, rssBytes: number, rssMB: number,
 *            totalmemBytes: number, ratio: number,
 *            limits: {warn: number, stop_dispatch: number, main_only: number}}}
 */
export function checkMemory(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const limits = resolveLimits(source.limits);

  let rssBytes = toNonNegative(source.rss);
  if (rssBytes === null) {
    try {
      const reader = typeof source.rssReader === 'function'
        ? source.rssReader
        : () => process.memoryUsage().rss;
      rssBytes = toNonNegative(reader()) ?? 0;
    } catch {
      rssBytes = 0;
    }
  }

  let totalmemBytes = toPositive(source.totalmem);
  if (totalmemBytes === null) {
    try {
      totalmemBytes = toPositive(os.totalmem()) ?? 0;
    } catch {
      totalmemBytes = 0;
    }
  }

  /** @type {RssLevel} */
  let level = 'ok';
  if (rssBytes >= limits.main_only) level = 'main_only';
  else if (rssBytes >= limits.stop_dispatch) level = 'stop_dispatch';
  else if (rssBytes >= limits.warn) level = 'warn';

  return {
    level,
    code: rssLevelCode(level),
    rssBytes,
    rssMB: round(rssBytes / MIB, 1),
    totalmemBytes,
    ratio: totalmemBytes > 0 ? round(rssBytes / totalmemBytes, 4) : 0,
    limits,
  };
}

/**
 * 档位转数值。
 * @param {string} level
 * @returns {number}
 */
export function rssLevelCode(level) {
  return RSS_LEVELS[level] ?? 0;
}

/**
 * 当前档位是否达到/超过给定档位（ok < warn < stop_dispatch < main_only）。
 * @param {string} level
 * @param {string} threshold
 * @returns {boolean}
 */
export function levelAtLeast(level, threshold) {
  return rssLevelCode(level) >= rssLevelCode(threshold);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toPositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {{warn?: number, warnBytes?: number, stop_dispatch?: number, stopDispatch?: number,
 *          stopDispatchBytes?: number, main_only?: number, mainOnly?: number,
 *          mainOnlyBytes?: number}|undefined} limits
 * @returns {{warn: number, stop_dispatch: number, main_only: number}}
 */
function resolveLimits(limits) {
  const input = limits !== null && typeof limits === 'object' ? limits : {};
  return {
    warn: toPositive(input.warn)
      ?? toPositive(input.warnBytes)
      ?? RSS_WARN_BYTES,
    stop_dispatch: toPositive(input.stop_dispatch)
      ?? toPositive(input.stopDispatch)
      ?? toPositive(input.stopDispatchBytes)
      ?? RSS_STOP_DISPATCH_BYTES,
    main_only: toPositive(input.main_only)
      ?? toPositive(input.mainOnly)
      ?? toPositive(input.mainOnlyBytes)
      ?? RSS_MAIN_ONLY_BYTES,
  };
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
