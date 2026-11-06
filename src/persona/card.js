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
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

/** 敏感对象键，深合并时直接忽略，避免原型污染。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 人格卡来源状态（v0.4.12）：内置默认 / 用户卡文件 / 加载失败兜底。 */
export const CARD_STATUS = Object.freeze({
  BUILTIN: 'builtin',
  FILE: 'file',
  FALLBACK: 'fallback',
});

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
 * @deprecated v0.4.12 起生产接线改用 loadPersonaCard()：本函数对不存在的文件
 *   **静默**返回内置卡，无法写「加载失败」warn，调用方也分不清「没配卡」与
 *   「配了但文件丢了」。配置了 persona.cardPath 时不要用 loadCard()。
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

  return parseCardSource(source, path);
}

/**
 * 解析 + 合并 + 校验一份人格卡 JSON 文本，返回深度冻结的卡。
 * loadCard() 与 loadPersonaCard() 共用同一套语义（数组整体替换、必填字段校验）。
 * @param {string} source 文件内容
 * @param {string} [path] 仅用于错误消息
 * @returns {Readonly<object>}
 */
function parseCardSource(source, path = '') {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    // M-2（v0.4.12）：不把 JSON.parse 的原始 message 拼进来——V8 会回显源文件
    // 开头若干字符（姓名、占位符、真实换行），导致 warn / /状态 泄漏卡正文。
    throw new TypeError(
      `loadCard(${path}): invalid JSON（${describeJsonSyntaxError(err, source)}）`,
      { cause: err },
    );
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
 * 解析 DSH 主目录：`DSH_HOME`（trim 后非空）优先，否则 `<用户主目录>/.dsh`。
 * deps 可注入 env/homedir，便于测试；生产路径不读全局单例。
 *
 * `deps.homedir`（字符串或函数）与 `os.homedir()` 语义相同——都是「用户主目录」，
 * 不是 DSH 主目录本身，因此未设置 `DSH_HOME` 时同样要拼 `.dsh`（M-1，v0.4.12）。
 *
 * @param {{env?: Record<string, string|undefined>, homedir?: string|(() => string)}} [deps]
 * @returns {string}
 */
export function resolveDshHome(deps = {}) {
  const env = deps.env ?? process.env;
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return fromEnv;

  const injected = deps.homedir;
  const home = typeof injected === 'function' ? injected() : injected;
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : homedir();
  return join(base, '.dsh');
}

/**
 * 把配置里的人格卡路径解析成绝对路径（v0.4.12）。
 *
 * 规则：`null`/`undefined`/trim 后空串 → null（表示用内置卡）；绝对路径原样使用；
 * 相对路径相对 DSH_HOME（`DSH_HOME` 否则 `~/.dsh`）解析。
 *
 * @param {string|null|undefined} cardPath 配置值 persona.cardPath
 * @param {{env?: Record<string, string|undefined>, homedir?: string|(() => string)}} [deps]
 * @returns {string|null}
 */
export function resolveCardPath(cardPath, deps = {}) {
  if (cardPath === null || cardPath === undefined) return null;
  if (typeof cardPath !== 'string') {
    throw new TypeError('resolveCardPath(cardPath): cardPath must be a string or null');
  }
  const trimmed = cardPath.trim();
  if (trimmed === '') return null;
  if (isAbsolute(trimmed)) return trimmed;
  return resolvePath(resolveDshHome(deps), trimmed);
}

/**
 * 启动时加载一次人格卡，任何失败都回落内置卡（v0.4.12）。
 *
 * 与 loadCard() 的区别（关键）：loadCard 对 ENOENT **静默**返回默认卡，调用方
 * 无法区分「用户没配卡」与「配了但文件丢了」。这里直接读文件并自己区分：
 * - 文件不存在 / 不是普通文件 / 无权限 / 其它读取错误；
 * - JSON 非法、必填字段缺失（validateCard 抛错）。
 * 以上全部 → status='fallback' + 内置卡 + 原因（含解析后路径，不含卡正文）。
 *
 * @param {string|null|undefined} cardPath 配置值 persona.cardPath
 * @param {{env?: Record<string, string|undefined>, homedir?: string|(() => string)}} [deps]
 * @returns {Readonly<{card: Readonly<object>, status: 'builtin'|'file'|'fallback',
 *   path: string|null, reason: string|null}>}
 */
export function loadPersonaCard(cardPath, deps = {}) {
  const resolved = resolveCardPath(cardPath, deps);
  if (resolved === null) {
    return Object.freeze({
      card: cloneFrozen(DEFAULT_CARD),
      status: CARD_STATUS.BUILTIN,
      path: null,
      reason: null,
    });
  }

  let source;
  try {
    source = readFileSync(resolved, 'utf8');
  } catch (err) {
    return Object.freeze({
      card: cloneFrozen(DEFAULT_CARD),
      status: CARD_STATUS.FALLBACK,
      path: resolved,
      reason: describeReadError(err, resolved),
    });
  }

  try {
    return Object.freeze({
      card: parseCardSource(source, resolved),
      status: CARD_STATUS.FILE,
      path: resolved,
      reason: null,
    });
  } catch (err) {
    return Object.freeze({
      card: cloneFrozen(DEFAULT_CARD),
      status: CARD_STATUS.FALLBACK,
      path: resolved,
      reason: describeParseError(err, resolved),
    });
  }
}

/**
 * 人格卡 `proactive.*` 与配置 `proactiveDailyCap/quietStart/quietEnd` 的重复项
 * （v0.4.12）。本版行为以**配置**为准，这里只找出两边不一致的字段用于 warn；
 * `chatPerDay` 在配置里没有对应键，不参与比较。
 *
 * @param {Record<string, any>} card
 * @param {Record<string, any>} [config]
 * @returns {Array<{cardField: string, configField: string}>}
 */
export function personaProactiveConflicts(card, config = {}) {
  const proactive = card?.proactive;
  const conflicts = [];
  if (proactive === null || typeof proactive !== 'object') return conflicts;
  const pairs = [
    ['dailyCap', 'proactiveDailyCap'],
    ['quietStart', 'quietStart'],
    ['quietEnd', 'quietEnd'],
  ];
  for (const [cardField, configField] of pairs) {
    if (!Object.hasOwn(proactive, cardField)) continue;
    if (config === null || config === undefined || !Object.hasOwn(config, configField)) continue;
    if (proactive[cardField] !== config[configField]) {
      conflicts.push({ cardField, configField });
    }
  }
  return conflicts;
}

/**
 * 读取失败的展示原因：带错误码与解析后路径（不含文件正文）。
 * @param {any} err
 * @param {string} resolved
 * @returns {string}
 */
function describeReadError(err, resolved) {
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return `文件不存在（${code}）：${resolved}`;
  if (code === 'EISDIR') return `不是普通文件（EISDIR）：${resolved}`;
  if (code === 'EACCES' || code === 'EPERM') return `没有读取权限（${code}）：${resolved}`;
  return `读取失败${code === '' ? '' : `（${code}）`}：${resolved}`;
}

/**
 * 把 JSON.parse 的 SyntaxError 压成**不含源文本**的诊断（M-2，v0.4.12）：
 * 位置 + 固定类别。V8 的原始 message 会回显源文件开头字符（`"SECRET_BOD"...`），
 * 这里只用它提取位置数字与语法类别，绝不把 message 本身拼进对外 reason。
 *
 * @param {any} err
 * @param {string} source
 * @returns {string} 如 `位置 1:6；意外字符` / `内容提前结束`
 */
function describeJsonSyntaxError(err, source) {
  const message = err instanceof Error ? err.message : String(err);
  const position = syntaxErrorPosition(message, source);
  const reason = syntaxErrorReason(message);
  return position === null ? reason : `位置 ${position}；${reason}`;
}

/**
 * 定位 JSON 语法错误（行:列）。优先用 V8 的 `line/column`；只有 `at position`
 * 时按源文本自行换算（position 为 UTF-16 code unit 下标，逐字符累计行列）。
 * @param {string} message
 * @param {string} source
 * @returns {string|null}
 */
function syntaxErrorPosition(message, source) {
  const lineCol = /line (\d+) column (\d+)/u.exec(message);
  if (lineCol !== null) return `${Number(lineCol[1])}:${Number(lineCol[2])}`;
  const at = /at position (\d+)/u.exec(message);
  if (at === null) return null;
  const index = Number(at[1]);
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else if (source[i] !== '\r') {
      column += 1;
    }
  }
  return `${line}:${column}`;
}

/**
 * JSON 语法错误的安全类别。只映射已知的 V8 短语，未知一律「无法解析」。
 * @param {string} message
 * @returns {string}
 */
function syntaxErrorReason(message) {
  if (/Unexpected end of (?:JSON )?input/u.test(message)) return '内容提前结束';
  if (/Unterminated string/u.test(message)) return '字符串未闭合';
  if (/Bad escaped character/u.test(message)) return '非法转义字符';
  if (/Bad control character/u.test(message)) return '非法控制字符';
  const expected = /Expected ([,:\[\]{}])/u.exec(message);
  if (expected !== null) return `期望 ${expected[1]}`;
  if (/Unexpected token/u.test(message)) return '意外字符';
  if (/Unexpected (?:string|number)/u.test(message)) return '意外 token';
  return '无法解析';
}

/**
 * 解析/校验失败的展示原因：错误消息已含路径时不再重复；单行、≤160 字符，
 * 且剥离控制字符与 V8 的 `"..."` 回显（M-2，v0.4.12：warn 与 /状态 不含卡正文）。
 * @param {any} err
 * @param {string} resolved
 * @returns {string}
 */
function describeParseError(err, resolved) {
  const message = err instanceof Error ? err.message : String(err);
  const text = sanitizeParseReason(message);
  const withPath = text.includes(resolved) ? text : `${text}（${resolved}）`;
  return withPath.length > 160 ? `${withPath.slice(0, 159)}…` : withPath;
}

/**
 * 清理对外 reason：去掉源文件回显片段、控制字符，空白折叠，保证单行。
 * @param {string} message
 * @returns {string}
 */
function sanitizeParseReason(message) {
  return String(message)
    // V8 形状：`, "SECRET_BOD"... is not valid JSON`——引号内是源文件回显，整段剥掉。
    .replace(/,\s*"(?:[^"\\]|\\.)*"(?:\.\.\.)?\s*(?:is not valid JSON)?/gu, '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
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
