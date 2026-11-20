/**
 * L120-H2：巩固抽出的提醒只有 `due_at`、没有 `next_fire_at` 时永远不触发
 * （也永远不过期）——补一次触发点。
 *
 * 为什么需要：`Store.dueReminders` 的查询口径是
 * `max(next_fire_at, retry_at) <= now`（见 `src/memory/store.js` 的
 * `buildDueRemindersQuery` / `REMINDER_DUE_AT_SQL`），`next_fire_at` 与 `retry_at`
 * 都为空的行永远不会被扫到；而巩固草稿里的提醒经常只有 `due_at`（甚至只有
 * `due_granularity: 'day'`），于是「该提醒的事」既不触发也不进过期清理。
 *
 * 补规则（发起时点由粒度决定，全部用**当地时间**，夏令时自适应）：
 * - `exact`  → `next_fire_at = due_at`（原样触发）；
 * - `day`    → 该日当地 09:00（`due_at` 早于今日 09:00 时仍取**当天** 09:00，
 *   即「已经过了就立刻补投」，不推到次日——见回报「13 项默认」第 7 条）；
 * - `week` / `month` → 不补（周期事项交给宿主 schedule 或人工确认），只保留
 *   `due_at` 作为 L120-M3 过期判断的截止时间；
 * - 无 `due_at` → 不补；
 * - 带 `rrule` → 不补（首次触发点必须由规则算，不能拿 `due_at` 冒充）。
 *
 * 本模块纯函数、不读 `process.env.TZ`：时间区由调用方显式传入（`config.timezone`），
 * 测试也按用例显式指定，避免 CI 时区矩阵下行为漂移。
 */

import { zonedParts, zonedTimeToInstant } from '../time.js';

/** `day` 粒度的默认触发小时（当地时间）。 */
export const DAY_GRANULARITY_FIRE_HOUR = 9;

/**
 * @param {unknown} value
 * @returns {number|null} 有限数字原样返回，否则 null
 */
function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * 给一条提醒补 `next_fire_at`。
 *
 * @param {{due_at?: unknown, due_granularity?: unknown, rrule?: unknown,
 *          next_fire_at?: unknown}} reminder 归一化后的提醒（秒级时间戳）
 * @param {{timeZone?: string}} [options] 时间区（默认 Asia/Shanghai，与 config 默认一致）
 * @returns {number|null} 秒级 `next_fire_at`；不补时返回 null
 */
export function backfillNextFireAt(reminder, options = {}) {
  const existing = finiteOrNull(reminder?.next_fire_at);
  if (existing !== null) return existing;
  const dueAt = finiteOrNull(reminder?.due_at);
  if (dueAt === null) return null;
  // 重复规则自带首次触发计算，不能用截止时间冒充触发时间。
  if (typeof reminder?.rrule === 'string' && reminder.rrule.trim() !== '') return null;
  const timeZone = typeof options.timeZone === 'string' && options.timeZone !== ''
    ? options.timeZone
    : 'Asia/Shanghai';
  const granularity = typeof reminder?.due_granularity === 'string'
    ? reminder.due_granularity
    : 'exact';
  if (granularity === 'exact') return dueAt;
  if (granularity === 'day') {
    const parts = zonedParts(dueAt * 1000, timeZone);
    const instantMs = zonedTimeToInstant({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: DAY_GRANULARITY_FIRE_HOUR,
      minute: 0,
      second: 0,
    }, timeZone);
    return Math.floor(instantMs / 1000);
  }
  // week / month / none：只留 due_at 做过期依据。
  return null;
}
