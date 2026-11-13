import { zonedDayKey, zonedMinutesOfDay } from '../time.js';

/**
 * A1（v0.4.13）：模型调用的 token 记账工具。
 *
 * 这里只做「纯换算」——把一次调用的 usage 变成 `store.recordTokenUsage` 需要的行，
 * 以及把聚合结果整理成 `/状态` 能直接展示的形状；不碰数据库、不读时钟。
 */

/** 错峰窗口起点（本地 00:30）。 */
export const OFFPEAK_START_MINUTES = 30;

/** 错峰窗口终点（本地 08:30，不含）。 */
export const OFFPEAK_END_MINUTES = 8 * 60 + 30;

/** 记账来源的中文名（`/状态` 与文档共用）。 */
export const TOKEN_SOURCE_LABELS = Object.freeze({
  main: '主会话',
  consolidate: '巩固',
  smalltalk: '闲聊',
  embedding: '向量',
  task: '任务',
  thread: '线程',
  appraise: '判定',
});

/**
 * 判断某一时刻属于峰时还是错峰（按本地时区）。
 *
 * 口径：本地 00:30–08:30 记 `offpeak`，其余记 `peak`。v0.4.13 只写入不参与
 * 计价；等 v0.4.14 接入错峰价格时可直接复用这一列。
 * @param {number} atMs
 * @param {string} [timeZone]
 * @returns {'peak'|'offpeak'}
 */
export function peakOf(atMs, timeZone) {
  const minutes = zonedMinutesOfDay(atMs, timeZone);
  return minutes >= OFFPEAK_START_MINUTES && minutes < OFFPEAK_END_MINUTES ? 'offpeak' : 'peak';
}

/**
 * 记账日界线：把毫秒时间戳换算成配置时区下的 `YYYY-MM-DD`。
 * @param {number} atMs
 * @param {string} [timeZone]
 * @returns {string}
 */
export function dayKeyOf(atMs, timeZone) {
  return zonedDayKey(atMs, timeZone);
}

/**
 * 把 usage 对象归一化成三个非负整数。
 * @param {{inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *          cacheHitTokens?: number, cacheReadTokens?: number}|null|undefined} usage
 * @returns {{input: number, output: number, cacheHit: number}}
 */
export function normalizeUsage(usage) {
  const clamp = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const input = clamp(usage?.inputTokens);
  let output = clamp(usage?.outputTokens);
  const cacheHit = clamp(usage?.cacheHitTokens ?? usage?.cacheReadTokens);
  if (output === 0 && input === 0) {
    const total = clamp(usage?.totalTokens);
    return { input: total, output: 0, cacheHit: Math.min(cacheHit, total) };
  }
  return { input, output, cacheHit: Math.min(cacheHit, input) };
}

/**
 * 生成一行 `token_usage` 记录。
 * @param {{at: number, timeZone?: string, source: string, scope?: string|null,
 *          usage?: object|null, requestId?: string|null}} input
 * @returns {{at: number, dayKey: string, source: string, scope: string|null,
 *            input: number, output: number, cacheHit: number,
 *            peak: 'peak'|'offpeak', requestId: string|null}}
 */
export function usageRow(input) {
  const at = Number(input.at);
  if (!Number.isFinite(at) || at < 0) throw new TypeError('token ledger: at must be a non-negative number');
  const { input: inputTokens, output, cacheHit } = normalizeUsage(input.usage);
  return {
    at: Math.floor(at),
    dayKey: dayKeyOf(at, input.timeZone),
    source: String(input.source),
    scope: input.scope ?? null,
    input: inputTokens,
    output,
    cacheHit,
    peak: peakOf(at, input.timeZone),
    requestId: input.requestId ?? null,
  };
}

/**
 * 把 `store.aggregateTokenUsage` 的结果整理成展示用摘要。
 * @param {{dayKey: string, total: {input:number, output:number, cacheHit:number, total:number},
 *          bySource: {source:string, total:number, share:number}[]}} aggregate
 * @returns {{dayKey: string, total: number, bySource: {source:string, label:string,
 *            total:number, share:number}[], cacheHit: number}}
 */
export function summarizeUsage(aggregate) {
  if (aggregate === null || typeof aggregate !== 'object') {
    return { dayKey: '', total: 0, bySource: [], cacheHit: 0 };
  }
  const total = Number(aggregate.total?.total) || 0;
  const rows = Array.isArray(aggregate.bySource) ? aggregate.bySource : [];
  return {
    dayKey: String(aggregate.dayKey ?? ''),
    total,
    cacheHit: Number(aggregate.total?.cacheHit) || 0,
    bySource: rows.map((row) => ({
      source: String(row.source),
      label: TOKEN_SOURCE_LABELS[row.source] ?? String(row.source),
      total: Number(row.total) || 0,
      share: Number(row.share) || 0,
    })),
  };
}
