/**
 * A2（v0.4.13）：额度闸门的纯逻辑部分。
 *
 * 这一层只做三件事：把「额度类错误」认出来、把配额文件读成一次评估、决定某个
 * 后台触发该不该因为额度而推迟。真正的暂停计时、状态缓存与日志在接线层
 * （`src/index.js`），这样这里可以完全脱离 ctx 单测。
 *
 * 设计红线（见 m09124 A2）：额度紧张只挡后台（闲聊、主动消息、回填、非 hard
 * 巩固）；主会话、hard 巩固与压缩永远不受影响——用户当面说的话优先于配额。
 */
import { readFileSync } from 'node:fs';

import { evaluateQuota, formatQuotaLine, parseQuotaSnapshot } from './quota.js';

/** 认得出 429 / 限流 / 额度不足的说法（各网关措辞不一，宁可多认一类）。 */
const QUOTA_ERROR_PATTERN = /(\b429\b|too many requests|rate limit|rate-limit|quota|insufficient)/iu;

/**
 * @param {unknown} error 错误对象或字符串
 * @returns {boolean} 是否为额度类错误
 */
export function isQuotaError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return QUOTA_ERROR_PATTERN.test(message);
}

/**
 * 读一次配额文件并评估。读不到、JSON 非法、结构不合法一律返回 `ok:false`——
 * 闸门是降级装置，读不到配额就当「不紧张」，不能反过来卡住后台。
 *
 * @param {object} input
 * @param {string} input.path 配额 JSON 路径
 * @param {number} input.nowMs 当前时刻（毫秒）
 * @param {Record<string, number>} [input.reserve] 各窗口预留比例
 * @param {number} [input.staleMs] 快照过期阈值（毫秒）
 * @param {(path: string, encoding: string) => string} [input.readFile] 可注入读取（测试用）
 * @returns {{ok: true, evaluation: object, line: string} | {ok: false, reason: string}}
 */
export function readQuotaFile(input) {
  const {
    path,
    nowMs,
    reserve,
    staleMs,
    readFile = readFileSync,
    timeZone,
  } = input ?? {};
  if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'path_missing' };
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'now_invalid' };

  let raw;
  try {
    raw = JSON.parse(readFile(path, 'utf8'));
  } catch (error) {
    const code = error instanceof Error && typeof error.code === 'string' ? error.code : null;
    return { ok: false, reason: code === 'ENOENT' ? 'file_missing' : 'read_failed' };
  }

  const parsed = parseQuotaSnapshot(raw);
  if (parsed.ok !== true) return { ok: false, reason: `snapshot_invalid:${parsed.reason}` };

  const evaluation = evaluateQuota(parsed, { now: nowMs, reserve, staleMs });
  return { ok: true, evaluation, line: formatQuotaLine(evaluation, { timeZone, now: nowMs }) };
}

/**
 * 后台触发是否因额度紧张而推迟。hard 巩固是安全阀，任何时候都放行。
 *
 * @param {{paused?: unknown, trigger?: unknown}} input
 * @returns {boolean} true = 推迟本次后台任务
 */
export function deferBackground(input) {
  const { paused, trigger } = input ?? {};
  if (paused !== true) return false;
  return trigger !== 'hard';
}
