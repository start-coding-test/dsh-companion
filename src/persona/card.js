/**
 * 人格卡：唯一人格数据源（09-人格系统.md §2）。
 *
 * 设计约束（R-PER-14/15/25）：
 * - 一个版本化 JSON 对象，不是一段提示词；单字段可改、可 diff、可回滚。
 * - 默认卡即用户已拍板值：珞然 / 你 / 简洁·温和·先结论 / 主动 ≤3 条/日 / 安静 23:00–08:00。
 * - 只读使用：loadCard() 返回深度冻结对象，调用方无法在运行期改掉人格。
 * - 仅使用 Node 内置能力，零第三方依赖。
 */

import { readFileSync } from 'node:fs';

/** 敏感对象键，深合并时直接忽略，避免原型污染。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 默认人格卡。
 * 字段与任务卡一致：name/address/tone/relation/proactive/bannedPhrases/values/taboos/version。
 */
export const DEFAULT_CARD = deepFreeze({
  name: '珞然',
  address: '你',
  tone: { style: '简洁', warmth: '温和', structure: '先结论' },
  relation: { butler: 0.7, friend: 0.3 },
  proactive: {
    dailyCap: 3,
    chatPerDay: 1,
    quietStart: '23:00',
    quietEnd: '08:00',
  },
  bannedPhrases: ['当然可以！', '太好了！', '亲爱的', '宝', '我一直都在'],
  values: [
    '诚实：不确定就说不确定，没记到就说没记到',
    '不谄媚：不同意就直说，不为了顺耳而附和',
    '尊重隐私：不主动复述用户没让提的私事',
    '不替用户做重大决定：给信息、给选项、给利弊',
  ],
  taboos: [
    '外貌评价',
    '收入',
    '家庭矛盾',
    '心理诊断',
    '劝酒赌博',
    '医疗与法律与投资的结论性建议',
  ],
  version: 1,
});

/**
 * 读取人格卡；不存在则使用默认卡。
 *
 * 合并语义：对象逐层深合并，数组整体替换（用户改 values/taboos 时不应残留默认项）。
 * 校验：name、address 必须是非空字符串；tone 必须是含 style/warmth/structure 的对象。
 *
 * @param {string} [path] 人格卡 JSON 路径
 * @returns {Readonly<object>} 深度冻结的人格卡
 */
export function loadCard(path) {
  if (path === undefined || path === null || path === '') {
    return cloneFrozen(DEFAULT_CARD);
  }
  if (typeof path !== 'string') {
    throw new TypeError('loadCard(path): path must be a string');
  }

  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return cloneFrozen(DEFAULT_CARD);
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new TypeError(`loadCard(${path}): invalid JSON: ${err.message}`, { cause: err });
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError(`loadCard(${path}): card must be a JSON object`);
  }

  // 必填字段必须在卡文件里显式给出；其余字段才走默认值深合并。
  requireText(parsed, 'name');
  requireText(parsed, 'address');
  if (!isPlainObject(parsed.tone)) {
    throw new TypeError('persona card: "tone" must be an object');
  }

  const merged = mergeInto(DEFAULT_CARD, parsed);
  validateCard(merged);
  return deepFreeze(merged);
}

/**
 * 校验人格卡必填字段；失败抛 TypeError（含字段名）。
 * @param {Record<string, any>} card
 */
export function validateCard(card) {
  if (!isPlainObject(card)) {
    throw new TypeError('persona card: must be an object');
  }
  requireText(card, 'name');
  requireText(card, 'address');
  if (!isPlainObject(card.tone)) {
    throw new TypeError('persona card: "tone" must be an object');
  }
  requireText(card.tone, 'style', 'tone.');
  requireText(card.tone, 'warmth', 'tone.');
  requireText(card.tone, 'structure', 'tone.');
  requireStringArray(card, 'bannedPhrases');
  requireStringArray(card, 'values');
  requireStringArray(card, 'taboos');
  if (!Number.isInteger(card.version) || card.version < 1) {
    throw new TypeError('persona card: "version" must be a positive integer');
  }
  return card;
}

/**
 * @param {Record<string, any>} holder
 * @param {string} key
 * @param {string} [prefix]
 */
function requireText(holder, key, prefix = '') {
  const value = holder[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`persona card: "${prefix}${key}" must be a non-empty string`);
  }
}

/**
 * @param {Record<string, any>} holder
 * @param {string} key
 */
function requireStringArray(holder, key) {
  const value = holder[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`persona card: "${key}" must be an array of strings`);
  }
}

/**
 * 深合并：base 提供默认值，override 逐层覆盖；数组整体替换。
 * @param {any} base
 * @param {any} override
 * @returns {any}
 */
function mergeInto(base, override) {
  if (!isPlainObject(override) || !isPlainObject(base)) {
    return clone(override);
  }
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = clone(base[key]);
  }
  for (const key of Object.keys(override)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = isPlainObject(override[key]) && isPlainObject(base[key])
      ? mergeInto(base[key], override[key])
      : clone(override[key]);
  }
  return out;
}

/**
 * @param {any} value
 * @returns {any}
 */
function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = clone(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * @param {any} value
 * @returns {any}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** 冻结副本，避免调用方通过默认卡引用改到 DEFAULT_CARD。 */
function cloneFrozen(value) {
  return deepFreeze(clone(value));
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
