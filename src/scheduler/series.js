/**
 * A4（v0.4.13）：重复提醒的「下一次到点」计算。
 *
 * 交付成功后的推进规则与投递重试完全解耦：
 * - 只在**原始序列**上前进，不因为这次晚了就以「现在」为新锚点；
 * - 停机期间错过多次时只补最近一次，其余只计数（missed），不再逐条补发；
 * - COUNT/UNTIL 耗尽返回 `exhausted: true`，由调用方把这条提醒收尾。
 */
import { nextOccurrence, parseRRule } from './recurrence.js';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../time.js';

/** 一次推进最多跳过多少个错过的到点（防止坏规则把循环拖死）。 */
export const SERIES_MAX_CATCHUP = 1000;

/**
 * 计算重复提醒交付成功后的下一次到点。
 *
 * @param {object} input
 * @param {string} input.rrule 规则原文
 * @param {number} input.anchorAt 序列锚点（首次到点，Unix 秒）
 * @param {number} input.afterAt 刚交付的那次到点（Unix 秒）
 * @param {number} [input.nowAt] 当前时间（Unix 秒）；给了才会跳过错过的次数
 * @param {number} [input.seriesIndex] 当前序号（从 0 开始）
 * @param {string} [input.timeZone] IANA 时区
 * @returns {{ok: true, nextFireAt: number, missed: number, seriesIndex: number}
 *   | {ok: true, exhausted: true, missed: number, seriesIndex: number}
 *   | {ok: false, reason: string, detail?: string}}
 */
export function nextSeriesFire(input = {}) {
  const {
    rrule,
    anchorAt,
    afterAt,
    nowAt,
    seriesIndex,
    timeZone = DEFAULT_TIMEZONE,
  } = input ?? {};

  if (typeof rrule !== 'string' || rrule.trim() === '') {
    return { ok: false, reason: 'rrule_required' };
  }
  if (!Number.isFinite(anchorAt) || !Number.isFinite(afterAt)) {
    return { ok: false, reason: 'rrule_invalid', detail: 'anchorAt/afterAt required' };
  }

  const parsed = parseRRule(rrule, { timeZone });
  if (parsed.ok !== true) {
    return { ok: false, reason: parsed.reason ?? 'rrule_invalid', detail: parsed.detail };
  }

  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const base = Number.isFinite(seriesIndex) && seriesIndex >= 0 ? Math.floor(seriesIndex) : 0;

  let cursor = afterAt;
  let missed = 0;
  for (;;) {
    const step = nextOccurrence({ rule: parsed.rule, anchorAt, afterAt: cursor, timeZone: zone });
    if (step.ok !== true) {
      return { ok: false, reason: step.reason ?? 'rrule_invalid' };
    }
    if (step.exhausted === true) {
      return { ok: true, exhausted: true, missed, seriesIndex: base + missed };
    }
    // 没有 nowAt：不跳过错过的到点，直接返回序列上的下一次。
    if (!Number.isFinite(nowAt) || step.at > nowAt) {
      return { ok: true, nextFireAt: step.at, missed, seriesIndex: base + missed + 1 };
    }
    // 这一次也已经错过：计入 missed，继续沿原序列找最近一次尚未错过的。
    missed += 1;
    cursor = step.at;
    if (missed >= SERIES_MAX_CATCHUP) {
      return { ok: true, nextFireAt: step.at, missed, seriesIndex: base + missed };
    }
  }
}
