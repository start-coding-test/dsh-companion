/**
 * P1-b 承诺提醒（R-PRO-05）。
 *
 * commitment 类提醒不是「到点播报」，而是「到点后每天最多跟进一次」：
 * - 只看 status pending/snoozed、due_at 已过、未删除的行；
 * - last_fire_key 记录今天已跟进过（ISO 日键，兼容旧版写入的 Unix 秒）；
 * - 逾期越久越靠前（调用方按此顺序入 proactive backlog，保证逾期承诺先发）；
 * - 正文只用 title，不碰 detail；title 命中敏感词时退化为「那件事」，
 *   审计 detail 也不写 title，避免回执泄露。
 *
 * 仅使用 Node 内置能力，零第三方依赖。
 */

import { isSensitiveText } from '../memory/govern.js';
import { DEFAULT_TIMEZONE, zonedDayKey } from '../time.js';

/** reminders.kind 里的承诺类型。 */
export const COMMITMENT_KIND = 'commitment';

/** memory_events 里承诺跟进的 reason。 */
export const COMMITMENT_FOLLOWUP_REASON = 'commitment_followup';

/** 单次扫描上限（listReminders 单页上限 500，这里再收紧）。 */
export const COMMITMENT_SCAN_LIMIT = 100;

const DAY_SECONDS = 86_400;

/** @param {unknown} value @returns {number} */
function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return Date.now();
  return Math.abs(num) < 1e11 ? num * 1000 : num;
}

/** @param {unknown} value @returns {number} Unix 秒 */
function toSeconds(value) {
  return Math.floor(toMillis(value) / 1000);
}

/**
 * 今天是否已经跟进过这条承诺。
 * @param {object} row reminders 行
 * @param {{now?: number|Date, timeZone?: string}} [options]
 * @returns {boolean}
 */
export function followedToday(row, { now = Date.now(), timeZone = DEFAULT_TIMEZONE } = {}) {
  if (row === null || typeof row !== 'object') return false;
  const key = row.last_fire_key;
  if (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(key)) {
    return key === zonedDayKey(now, timeZone);
  }
  const seconds = Number(key);
  if (Number.isFinite(seconds) && seconds > 0) {
    return zonedDayKey(seconds * 1000, timeZone) === zonedDayKey(now, timeZone);
  }
  return false;
}

/**
 * 是否是一条「到期且未完成」的承诺。
 * @param {object} row
 * @param {{now?: number|Date}} [options]
 * @returns {boolean}
 */
export function isCommitmentDue(row, { now = Date.now() } = {}) {
  if (row === null || typeof row !== 'object') return false;
  if (row.kind !== COMMITMENT_KIND) return false;
  if (row.deleted_at !== null && row.deleted_at !== undefined) return false;
  if (row.status !== 'pending' && row.status !== 'snoozed') return false;
  if (row.due_at === null || row.due_at === undefined) return false;
  return Number(row.due_at) <= toSeconds(now);
}

/**
 * 逾期天数（0 = 今天到点）。
 * @param {object} row
 * @param {{now?: number|Date}} [options]
 * @returns {number}
 */
export function commitmentOverdueDays(row, { now = Date.now() } = {}) {
  if (!isCommitmentDue(row, { now })) return 0;
  return Math.max(0, Math.floor((toSeconds(now) - Number(row.due_at)) / DAY_SECONDS));
}

/**
 * 生成跟进文案：人格卡地址 + 「昨天/前几天说好」 + title；敏感 title 不出现。
 * @param {{card?: object, reminder: object, overdueDays?: number}} input
 * @returns {string}
 */
export function followUpText({ card, reminder, overdueDays = 0 } = {}) {
  const address = typeof card?.address === 'string' && card.address.trim() !== ''
    ? card.address.trim()
    : '你';
  const rawTitle = typeof reminder?.title === 'string' ? reminder.title.trim() : '';
  const safeTitle = rawTitle !== '' && !isSensitiveText(rawTitle);
  const when = overdueDays >= 1 ? '前几天说好' : '昨天说好';
  if (!safeTitle) return `${address}，${when}的那件事，今天方便推进一下吗？`;
  return `${address}，${when}的「${rawTitle}」，今天要不要推进一下？`;
}

/**
 * 扫描今天应跟进的承诺，按逾期天数降序、due_at 升序排列。
 *
 * @param {{store: object, now?: number|Date, timeZone?: string, scope?: string,
 *          limit?: number}} input
 * @returns {object[]} reminders 行（附 overdue_days）
 */
export function scanCommitmentFollowups({
  store,
  now = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
  scope = 'main',
  limit = COMMITMENT_SCAN_LIMIT,
} = {}) {
  if (store === null || typeof store !== 'object' || typeof store.listReminders !== 'function') {
    throw new TypeError('scanCommitmentFollowups(store): store.listReminders is required');
  }
  const pageSize = Math.max(1, Math.min(500, Number(limit) || COMMITMENT_SCAN_LIMIT));
  const rows = store.listReminders({ scope, limit: pageSize });
  return rows
    .filter((row) => isCommitmentDue(row, { now }) && !followedToday(row, { now, timeZone }))
    .map((row) => ({ ...row, overdue_days: commitmentOverdueDays(row, { now }) }))
    .sort((a, b) => b.overdue_days - a.overdue_days
      || Number(a.due_at) - Number(b.due_at)
      || String(a.id).localeCompare(String(b.id)));
}

/**
 * memory_events detail：只放 id/title 元数据；敏感 title 不落库。
 * @param {object} row
 * @returns {{kind: string, id: string, title?: string}}
 */
export function commitmentAuditDetail(row) {
  const detail = { kind: COMMITMENT_FOLLOWUP_REASON, id: String(row?.id ?? '') };
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  if (title !== '' && !isSensitiveText(title)) detail.title = title;
  return detail;
}
