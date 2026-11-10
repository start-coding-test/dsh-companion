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

import { DEFAULT_BASELINE } from './emotion.js';
import { APPRAISAL_TIMEOUT_DEFAULT as APPRAISE_TIMEOUT_DEFAULT } from './emotion-appraise.js';

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
 *
 * v0.5.0（P1）起身份由卡驱动：description / personality / scenario 进 core 段，
 * tone.notes 取代原先写死在 sections.js 的尾句，chatIdentity 取代 chat.js 的
 * 硬编码开场白；mes_example / first_mes / post_history_instructions / memoryCitation
 * 与 emotion 只做**存储 + 结构校验**（emotion 逻辑由其它任务卡实现）。
 *
 * 缺省值刻意让渲染结果与 v0.4.12 逐字节一致（test/fixtures/persona-v0412.json 锁定）。
 * `{{char}}` 渲染为 name、`{{user}}` 渲染为 address；卡里存的原文保持不变，便于 diff。
 */
export const DEFAULT_CARD = deepFreeze({
  name: '珞然',
  address: '你',
  description: '你是{{char}}，用户的私人管家。称呼用户为“{{user}}”。\n身份是 AI 助手；关系以管家为主、朋友为辅，保持可靠与克制。',
  personality: '',
  scenario: '',
  tone: {
    style: '简洁',
    warmth: '温和',
    structure: '先结论',
    notes: '不堆铺垫，不夸张感叹，不用亲密称呼',
    voice: '',
  },
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
  mes_example: '',
  first_mes: '',
  post_history_instructions: '',
  memoryCitation: 'explicit',
  chatIdentity: '你是用户的私人助手{{char}}，称呼用户为「{{user}}」。',
  emotion: {
    enabled: false,
    baseline: { pleasure: 50, arousal: 50, dominance: 50, energy: 60 },
    halfLifeHours: 6,
    appraiser: 'rules',
    appraiseModel: null,
    appraiseTimeoutMs: APPRAISE_TIMEOUT_DEFAULT,
  },
  version: 1,
});

/** memoryCitation 的两个合法取值（v0.5.0 P1）。 */
export const MEMORY_CITATION_MODES = Object.freeze(['explicit', 'natural']);

/** emotion.baseline 的四个维度（结构校验用；不实现情绪逻辑）。 */
const EMOTION_BASELINE_KEYS = Object.freeze(['pleasure', 'arousal', 'dominance', 'energy']);

/**
 * 渲染卡里的模板占位符（v0.5.1）：
 * 1. 先剥 HTML 注释（`<!-- ... -->`，兜底卡加载后运行期拼进来的文本）；
 * 2. `{{char}}` → name，`{{user}}` → address；
 * 3. 其余 `{{...}}` 一律降级成单花括号 `{...}`（`{{time}}` → `{time}`），保证输出里
 *    **没有** `{{`：宿主 dsh-system-prompt 的插值器遇到未注册变量会整轮抛错，
 *    未知占位符不能原样进提示词（V50-M2）。
 *
 * 只做一次替换（不递归），非字符串原样返回；生产卡已校验，这里对部分字段缺失的
 * 旧调用方保持宽松（缺失按空串处理）。内置卡只含 `{{char}}`/`{{user}}`，输出与
 * v0.5.0 逐字节一致。
 *
 * @param {string} text
 * @param {{name?: string, address?: string}} context
 * @returns {string}
 */
export function renderTemplate(text, context) {
  if (typeof text !== 'string') return text;
  const name = typeof context?.name === 'string' ? context.name : '';
  const address = typeof context?.address === 'string' ? context.address : '';
  const body = stripHtmlComments(text);
  const substituted = body.split('{{char}}').join(name).split('{{user}}').join(address);
  return downgradePlaceholders(substituted);
}

/** `{{...}}` 里不含花括号（与宿主 GROUP_AT 同口径）；配合 replace 使用，无 lastIndex 状态。 */
const PAIRED_PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/gu;

/**
 * 把残留的 `{{...}}` 降级成 `{...}`（v0.5.1 V50-M2）。
 *
 * 分组口径与宿主 `GROUP_AT`（`/^\{\{([^{}]*)\}\}/`）一致，保证「宿主会认出来的」
 * 引用一定先被降级；随后极端的半截 `{{`（宿主当成普通散文）也逐字符兜底成 `{`，
 * 让「输出里没有 `{{`」成为硬保证，而不是依赖宿主的具体解析细节。
 *
 * @param {string} text
 * @returns {string}
 */
function downgradePlaceholders(text) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  const paired = text.replace(PAIRED_PLACEHOLDER_PATTERN, (_match, inner) => `{${inner}}`);
  return paired.includes('{{') ? paired.split('{{').join('{') : paired;
}

/**
 * 剥离 HTML 注释（v0.5.1 V50-L2）：`<!-- ... -->` 非贪婪、跨行、可多处。
 *
 * 未闭合的 `<!--` 保守原样保留（不吞掉后续正文）；需要诊断时用
 * stripHtmlCommentsDetailed()。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripHtmlComments(text) {
  return stripHtmlCommentsDetailed(text).text;
}

/**
 * stripHtmlComments() 的带诊断版本：`unterminated` 为 true 表示存在未闭合的
 * `<!--`（此时整段原样返回，不做半截剥离）。
 *
 * @param {string} text
 * @returns {{text: string, unterminated: boolean}}
 */
function stripHtmlCommentsDetailed(text) {
  if (typeof text !== 'string' || !text.includes('<!--')) {
    return { text, unterminated: false };
  }
  let out = '';
  let index = 0;
  let open = text.indexOf('<!--');
  while (open >= 0) {
    // 注释紧贴正文时直接拼接（`a<!--x-->b` → `ab`），不额外插入分隔符。
    out += text.slice(index, open);
    const close = text.indexOf('-->', open + 4);
    if (close < 0) {
      // 未闭合：保守原样保留，宁可留下注释也不吞掉后面的正文。
      return { text, unterminated: true };
    }
    index = close + 3;
    open = text.indexOf('<!--', index);
  }
  out += text.slice(index);
  return { text: out, unterminated: false };
}

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
export function parseCardSource(source, path = '') {
  return parseCardSourceDetailed(source, path).card;
}

/**
 * 同 parseCardSource()，但额外返回导入期诊断（都不含卡正文）：
 * - v0.5.0 P1：CCv2/v3 的 `character_book` 被忽略 → `{code:'character_book_ignored'}`；
 * - v0.5.1 V50-L2：文本字段里有未闭合的 `<!--` →
 *   `{code:'html_comment_unterminated', detail:[字段路径...]}`（整段保守原样保留）；
 * - v0.5.1 V50-M2：卡里用了会被降级的模板占位符（`{{time}}`、`{{random:a,b}}` 等）→
 *   `{code:'template_placeholder_downgraded', detail:[占位符名字...]}`。
 *
 * @param {string} source
 * @param {string} [path]
 * @returns {Readonly<{card: Readonly<object>,
 *   warnings: ReadonlyArray<{code: string, detail?: ReadonlyArray<string>}>}>}
 */
export function parseCardSourceDetailed(source, path = '') {
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

  const { input, warnings } = normalizeCardSource(parsed);
  // v0.5.1：加载期净化文本字段（剥 HTML 注释 + 指出会被降级的模板占位符），
  // 让卡里的注释/占位符在进入渲染之前就被处理，而不是带进上下文。
  const cardInput = sanitizeCardText(input, warnings);
  if (!isCcCardSource(parsed)) {
    // 原生卡：必填字段必须在卡文件里显式给出；其余字段才走默认值深合并。
    requireText(parsed, 'name');
    requireText(parsed, 'address');
    if (!isPlainObject(parsed.tone)) {
      throw new TypeError('persona card: "tone" must be an object');
    }
  } else {
    // CCv2/v3：其它字段缺失用默认值，但 name 仍必须非空（不能静默变成内置名）。
    requireText(cardInput, 'name');
  }

  const merged = mergeInto(DEFAULT_CARD, cardInput);
  // P3-c：emotion 的运行期归一化。校验函数仍对直接调用保持严格（P1 契约），
  // 但卡文件里的非法值不再让整张卡加载失败：回落默认值并记一条 warning。
  const normalized = normalizeCardEmotion(merged.emotion);
  merged.emotion = normalized.emotion;
  warnings.push(...normalized.warnings);
  validateCard(merged);
  return Object.freeze({
    card: deepFreeze(merged),
    warnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
  });
}

/** emotion.halfLifeHours 的允许区间（含端点）；区间外回落 6。 */
const EMOTION_HALF_LIFE_MIN = 0.5;
const EMOTION_HALF_LIFE_MAX = 168;
const EMOTION_HALF_LIFE_DEFAULT = 6;

/**
 * 归一化 `card.emotion`（P3-c），供 `parseCardSourceDetailed` 在 validateCard
 * 之前调用。合法值原样保留（含未知键），非法值逐项回落默认并给出 warning：
 * - `enabled` 非布尔 → false；
 * - `baseline` 非对象/任维非 0–100 有限数 → `DEFAULT_BASELINE`；
 * - `halfLifeHours` 非 `[0.5, 168]` 有限数 → 6；
 * - `emotion` 本身非对象 → 整块默认值。
 *
 * @param {any} emotion
 * @returns {{emotion: object, warnings: Array<{code: string}>}}
 */
export function normalizeCardEmotion(emotion) {
  const warnings = [];
  if (emotion === null || typeof emotion !== 'object' || Array.isArray(emotion)) {
    return {
      emotion: {
        enabled: false,
        baseline: { ...DEFAULT_BASELINE },
        halfLifeHours: EMOTION_HALF_LIFE_DEFAULT,
        appraiser: 'rules',
        appraiseModel: null,
        appraiseTimeoutMs: APPRAISE_TIMEOUT_DEFAULT,
      },
      warnings: [{ code: 'emotion_invalid' }],
    };
  }

  const normalized = { ...emotion };

  if (emotion.enabled === undefined) {
    normalized.enabled = false;
  } else if (typeof emotion.enabled !== 'boolean') {
    normalized.enabled = false;
    warnings.push({ code: 'emotion_enabled_invalid' });
  }

  if (emotion.baseline === undefined) {
    normalized.baseline = { ...DEFAULT_BASELINE };
  } else if (!isValidBaseline(emotion.baseline)) {
    normalized.baseline = { ...DEFAULT_BASELINE };
    warnings.push({ code: 'emotion_baseline_invalid' });
  }

  if (emotion.halfLifeHours === undefined) {
    normalized.halfLifeHours = EMOTION_HALF_LIFE_DEFAULT;
  } else if (!isValidHalfLife(emotion.halfLifeHours)) {
    normalized.halfLifeHours = EMOTION_HALF_LIFE_DEFAULT;
    warnings.push({ code: 'emotion_half_life_invalid' });
  }

  // v0.6-E3：判定器模式与路由。默认 'rules'，行为与 v0.5.2 完全一致。
  if (emotion.appraiser === undefined) {
    normalized.appraiser = 'rules';
  } else if (emotion.appraiser !== 'rules' && emotion.appraiser !== 'llm') {
    normalized.appraiser = 'rules';
    warnings.push({ code: 'emotion_appraiser_invalid' });
  }

  if (emotion.appraiseModel === undefined || emotion.appraiseModel === null) {
    normalized.appraiseModel = null;
  } else if (!isPlainObject(emotion.appraiseModel)
    || typeof emotion.appraiseModel.provider !== 'string' || emotion.appraiseModel.provider.trim() === ''
    || typeof emotion.appraiseModel.model !== 'string' || emotion.appraiseModel.model.trim() === '') {
    normalized.appraiseModel = null;
    warnings.push({ code: 'emotion_appraise_model_invalid' });
  } else {
    normalized.appraiseModel = {
      provider: emotion.appraiseModel.provider.trim(),
      model: emotion.appraiseModel.model.trim(),
    };
  }

  if (emotion.appraiseTimeoutMs === undefined) {
    normalized.appraiseTimeoutMs = APPRAISE_TIMEOUT_DEFAULT;
  } else if (typeof emotion.appraiseTimeoutMs !== 'number'
    || !Number.isFinite(emotion.appraiseTimeoutMs)
    || emotion.appraiseTimeoutMs < 100
    || emotion.appraiseTimeoutMs > 60000) {
    normalized.appraiseTimeoutMs = APPRAISE_TIMEOUT_DEFAULT;
    warnings.push({ code: 'emotion_appraise_timeout_invalid' });
  }

  return { emotion: normalized, warnings };
}

/**
 * @param {any} baseline
 * @returns {boolean}
 */
function isValidBaseline(baseline) {
  if (!isPlainObject(baseline)) return false;
  return EMOTION_BASELINE_KEYS.every((key) => {
    const value = baseline[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  });
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isValidHalfLife(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= EMOTION_HALF_LIFE_MIN
    && value <= EMOTION_HALF_LIFE_MAX;
}

/**
 * 是否为 CCv2/v3 包装（`{spec, spec_version, data:{...}}`）。
 * 只认这两种 spec，避免把任意带 data 的 JSON 误当角色卡。
 * @param {Record<string, any>} parsed
 * @returns {boolean}
 */
function isCcCardSource(parsed) {
  return (parsed.spec === 'chara_card_v2' || parsed.spec === 'chara_card_v3')
    && isPlainObject(parsed.data);
}

/**
 * 归一化卡来源（v0.5.0 P1）：
 * - 原生卡：原样返回；
 * - `spec` 为 `chara_card_v2` / `chara_card_v3` 且顶层有 `data` 对象：把 CCv2/v3
 *   字段映射到本卡结构。缺失字段不报错（合并时用默认值），`address` 缺失用 `你`，
 *   `version` 缺失用 `1`。
 * - `character_book` 一律忽略，只返回 `{code:'character_book_ignored'}`，不读不打印书内容。
 *
 * @param {Record<string, any>} parsed
 * @returns {{input: Record<string, any>, warnings: Array<{code: string}>}}
 */
function normalizeCardSource(parsed) {
  if (!isCcCardSource(parsed)) return { input: parsed, warnings: [] };

  const data = parsed.data;
  const mapped = {};
  for (const key of [
    'name',
    'description',
    'personality',
    'scenario',
    'mes_example',
    'first_mes',
    'post_history_instructions',
  ]) {
    if (Object.hasOwn(data, key)) mapped[key] = data[key];
  }
  // CCv2/v3 的 `data.address` 不是规范字段，酒馆卡习惯把它放 `data.extensions.address`；
  // 两者都接受，`data.address` 优先（显式写在顶层时以它为准）。
  const extensions = data.extensions !== null && typeof data.extensions === 'object' ? data.extensions : {};
  const address = typeof data.address === 'string' && data.address.trim() !== ''
    ? data.address
    : (typeof extensions.address === 'string' ? extensions.address : '');
  mapped.address = address.trim() !== '' ? address : '你';
  mapped.version = Number.isInteger(data.version) && data.version >= 1 ? data.version : 1;

  const warnings = [];
  if (data.character_book !== undefined && data.character_book !== null) {
    warnings.push({ code: 'character_book_ignored' });
  }
  return { input: mapped, warnings };
}

/** 参与渲染的卡文本字段（v0.5.1 V50-L2：加载期统一剥 HTML 注释）。 */
const CARD_TEXT_FIELDS = Object.freeze([
  'address',
  'chatIdentity',
  'description',
  'first_mes',
  'mes_example',
  'name',
  'personality',
  'post_history_instructions',
  'scenario',
]);

/** tone 下的文本字段（同样剥注释）。 */
const CARD_TONE_TEXT_FIELDS = Object.freeze(['notes', 'structure', 'style', 'voice', 'warmth']);

/** 字符串数组字段（逐项剥注释；非字符串项原样保留，交给校验报错）。 */
const CARD_TEXT_LIST_FIELDS = Object.freeze(['bannedPhrases', 'taboos', 'values']);

/** 渲染期唯一保留的占位符；其余 `{{...}}` 会被降级成 `{...}`。 */
const SUPPORTED_PLACEHOLDERS = Object.freeze(['{{char}}', '{{user}}']);

/** warning.detail 里占位符名字的长度上限（防止把一整段正文当名字写进日志）。 */
const PLACEHOLDER_NAME_MAX = 60;

/**
 * 加载期文本净化（v0.5.1，V50-L2 + V50-M2）：
 * - 剥掉 HTML 注释；存在未闭合的 `<!--` 时该字段整段保守保留，并记一条
 *   `html_comment_unterminated`（detail 是字段路径，不是正文）；
 * - 收集会被降级的模板占位符名字，记一条 `template_placeholder_downgraded`
 *   （detail 只有名字，不含正文——warning 会进日志，不能泄漏卡内容）。
 *
 * 不修改入参：返回浅拷贝，只替换涉及的字符串字段/数组/tone 对象。
 *
 * @param {Record<string, any>} input
 * @param {Array<{code: string, detail?: ReadonlyArray<string>}>} warnings 收集器
 * @returns {Record<string, any>}
 */
function sanitizeCardText(input, warnings) {
  if (!isPlainObject(input)) return input;
  const out = { ...input };
  const unterminated = [];
  const placeholders = [];

  const clean = (value, field) => {
    const stripped = stripHtmlCommentsDetailed(value);
    if (stripped.unterminated) unterminated.push(field);
    collectDowngradedPlaceholders(stripped.text, placeholders);
    return stripped.text;
  };

  for (const field of CARD_TEXT_FIELDS) {
    if (typeof out[field] === 'string') out[field] = clean(out[field], field);
  }
  if (isPlainObject(out.tone)) {
    const tone = { ...out.tone };
    for (const field of CARD_TONE_TEXT_FIELDS) {
      if (typeof tone[field] === 'string') {
        tone[field] = clean(tone[field], `tone.${field}`);
      }
    }
    out.tone = tone;
  }
  for (const field of CARD_TEXT_LIST_FIELDS) {
    if (!Array.isArray(out[field])) continue;
    out[field] = out[field].map((item) => (typeof item === 'string'
      ? clean(item, field)
      : item));
  }

  if (unterminated.length > 0) {
    warnings.push({ code: 'html_comment_unterminated', detail: Object.freeze(unterminated) });
  }
  if (placeholders.length > 0) {
    warnings.push({ code: 'template_placeholder_downgraded', detail: Object.freeze(placeholders) });
  }
  return out;
}

/**
 * 收集会被 renderTemplate() 降级的占位符名字（去重、保序、带上限）。
 * `{{char}}`/`{{user}}` 会被正常替换，不算降级。
 *
 * @param {string} text
 * @param {string[]} into
 */
function collectDowngradedPlaceholders(text, into) {
  if (typeof text !== 'string' || !text.includes('{{')) return;
  const pattern = /\{\{([^{}]*)\}\}/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (SUPPORTED_PLACEHOLDERS.includes(match[0])) continue;
    const chars = [...match[1]];
    const label = chars.length > PLACEHOLDER_NAME_MAX
      ? `${chars.slice(0, PLACEHOLDER_NAME_MAX - 1).join('')}…`
      : match[1];
    if (!into.includes(label)) into.push(label);
  }
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
 * v0.5.0（P1）：新增 `warnings`（导入期诊断，如 CCv2/v3 的 `character_book_ignored`），
 * 由 index.js 在 apply 时各记一条 warn；不含卡正文。
 *
 * @param {string|null|undefined} cardPath 配置值 persona.cardPath
 * @param {{env?: Record<string, string|undefined>, homedir?: string|(() => string)}} [deps]
 * @returns {Readonly<{card: Readonly<object>, status: 'builtin'|'file'|'fallback',
 *   path: string|null, reason: string|null, warnings: ReadonlyArray<{code: string}>}>}
 */
export function loadPersonaCard(cardPath, deps = {}) {
  const resolved = resolveCardPath(cardPath, deps);
  if (resolved === null) {
    return Object.freeze({
      card: cloneFrozen(DEFAULT_CARD),
      status: CARD_STATUS.BUILTIN,
      path: null,
      reason: null,
      warnings: Object.freeze([]),
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
      warnings: Object.freeze([]),
    });
  }

  try {
    const parsed = parseCardSourceDetailed(source, resolved);
    return Object.freeze({
      card: parsed.card,
      status: CARD_STATUS.FILE,
      path: resolved,
      reason: null,
      warnings: parsed.warnings,
    });
  } catch (err) {
    return Object.freeze({
      card: cloneFrozen(DEFAULT_CARD),
      status: CARD_STATUS.FALLBACK,
      path: resolved,
      reason: describeParseError(err, resolved),
      warnings: Object.freeze([]),
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
 * 校验人格卡字段；失败抛 TypeError（含字段名/字段路径）。
 *
 * v0.5.0（P1）新增字段全部**可选**：卡里没写就不校验（合并后由默认值补齐）；
 * 写了就必须是对的类型，避免把数字/对象渲染进 system 段。
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
  optionalString(card, 'description');
  optionalString(card, 'personality');
  optionalString(card, 'scenario');
  optionalString(card, 'mes_example');
  optionalString(card, 'first_mes');
  optionalString(card, 'post_history_instructions');
  optionalString(card, 'chatIdentity');
  optionalString(card.tone, 'notes', 'tone.');
  optionalString(card.tone, 'voice', 'tone.');
  requireStringArray(card, 'bannedPhrases');
  requireStringArray(card, 'values');
  requireStringArray(card, 'taboos');
  if (card.memoryCitation !== undefined && !MEMORY_CITATION_MODES.includes(card.memoryCitation)) {
    throw new TypeError(
      'persona card: "memoryCitation" must be "explicit" or "natural"',
    );
  }
  validateEmotion(card.emotion);
  if (!Number.isInteger(card.version) || card.version < 1) {
    throw new TypeError('persona card: "version" must be a positive integer');
  }
  return card;
}

/**
 * 字段存在时必须是字符串（v0.5.0 P1）。空串合法（表示「不渲染这一段」）。
 * @param {Record<string, any>} holder
 * @param {string} key
 * @param {string} [prefix]
 */
function optionalString(holder, key, prefix = '') {
  if (!Object.hasOwn(holder, key) || holder[key] === undefined) return;
  if (typeof holder[key] !== 'string') {
    throw new TypeError(`persona card: "${prefix}${key}" must be a string`);
  }
}

/**
 * emotion 结构校验（v0.5.0 P1）。
 *
 * 本卡**只校验 + 透传**，不实现情绪演化逻辑（由另一张任务卡实现）。字段存在时：
 * `enabled` 布尔；`baseline` 四维数在 0–100；`halfLifeHours` 在 (0, 168]。
 * 缺省字段（旧卡）直接跳过。
 * @param {any} emotion
 */
function validateEmotion(emotion) {
  if (emotion === undefined) return;
  if (!isPlainObject(emotion)) {
    throw new TypeError('persona card: "emotion" must be an object');
  }
  if (Object.hasOwn(emotion, 'enabled') && typeof emotion.enabled !== 'boolean') {
    throw new TypeError('persona card: "emotion.enabled" must be a boolean');
  }
  if (emotion.baseline !== undefined) {
    if (!isPlainObject(emotion.baseline)) {
      throw new TypeError('persona card: "emotion.baseline" must be an object');
    }
    for (const key of EMOTION_BASELINE_KEYS) {
      const value = emotion.baseline[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new TypeError(
          `persona card: "emotion.baseline.${key}" must be a number between 0 and 100`,
        );
      }
    }
  }
  if (emotion.halfLifeHours !== undefined) {
    const value = emotion.halfLifeHours;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 168) {
      throw new TypeError(
        'persona card: "emotion.halfLifeHours" must be a number greater than 0 and at most 168',
      );
    }
  }
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
