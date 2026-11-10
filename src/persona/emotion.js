/**
 * 情绪状态内核（P3-a）：愉悦 / 唤醒 / 掌控（PAD）+ 精力 四维纯函数。
 *
 * 契约与约束（改动前先读）：
 * 1) 纯函数：同一输入永远同一输出。时间戳（nowMs / updatedAt）、基线、半衰期全部由
 *    调用方传入；本模块不读时钟、不读环境变量、不写文件、不用随机数。
 * 2) 状态形如 { pleasure, arousal, dominance, energy, updatedAt }，四维取值 0–100，
 *    updatedAt 是毫秒时间戳。
 * 3) 零依赖：不 import 任何模块（含 node: 内置）。
 *
 * 接线方（后续卡片）负责：从存储读状态、决定 baseline、提供 nowMs 与本地小时。
 */

/** 四维顺序固定，便于遍历与快照比对。 */
const DIMENSIONS = Object.freeze(['pleasure', 'arousal', 'dominance', 'energy']);

const VALUE_MIN = 0;
const VALUE_MAX = 100;
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
const MAX_HALF_LIFE_HOURS = 168;
const MAX_INTENSITY = 3;

/** 单次事件对单维的固有增量上限（节律偏移另计，见 circadian）。 */
const MAX_EVENT_DELTA = Object.freeze({
  pleasure: 8,
  arousal: 8,
  dominance: 8,
  energy: 6,
});

/** 缺省基线：略偏正面的闲聊默认值，接线时可整体覆盖。 */
export const DEFAULT_BASELINE = Object.freeze({
  pleasure: 55,
  arousal: 45,
  dominance: 50,
  energy: 50,
});

/** 事件类型白名单（顺序即文档顺序）。 */
export const EVENT_TYPES = Object.freeze([
  'greeting',
  'care',
  'share',
  'thanks',
  'complain',
  'cold',
  'reunion',
  'goodnight',
  'conflict',
  'comfort',
]);

/**
 * 各事件类型在 intensity=1 时的四维固有增量（正负即语义方向）。
 * 绝对值均在上限内：PAD ≤ 8、energy ≤ 6。
 */
const EVENT_DELTAS = Object.freeze({
  greeting: Object.freeze({ pleasure: 4, arousal: 1, dominance: 0.5, energy: 0.5 }),
  care: Object.freeze({ pleasure: 5, arousal: 1.5, dominance: 1, energy: 1.5 }),
  share: Object.freeze({ pleasure: 4, arousal: 2, dominance: 1, energy: 1 }),
  thanks: Object.freeze({ pleasure: 5, arousal: 1, dominance: 1, energy: 0.5 }),
  complain: Object.freeze({ pleasure: -5, arousal: 3, dominance: -1, energy: -1 }),
  cold: Object.freeze({ pleasure: -4, arousal: -0.5, dominance: -3, energy: -0.5 }),
  reunion: Object.freeze({ pleasure: 6, arousal: 4, dominance: 1, energy: 1 }),
  goodnight: Object.freeze({ pleasure: 1, arousal: -5, dominance: 0.5, energy: 2 }),
  conflict: Object.freeze({ pleasure: -6, arousal: 4, dominance: -4, energy: -1 }),
  comfort: Object.freeze({ pleasure: 5, arousal: -2, dominance: 1, energy: -1 }),
});

/**
 * 昼夜节律控制点（0–24 整点，末点 24 与 0 取值相同，保证跨零点连续）。
 * 相邻整点线性插值；四个维度各自独立。
 *
 * 规律：深夜（23–5）精力明显低；清晨（6–8）精力回升；上午（9–12）愉悦略高；
 * 午后（13–15）唤醒略低；傍晚（18–21）愉悦略高。hour=16 是四维全零的中性时刻，
 * 便于测试把「事件固有增量」与「节律偏移」分开。所有偏移量都在
 * PAD ±5 / energy ±12 之内。
 */
const CIRCADIAN_POINTS = Object.freeze({
  pleasure: Object.freeze([
    Object.freeze([0, -2]),
    Object.freeze([3, -1.5]),
    Object.freeze([6, 0.5]),
    Object.freeze([9, 2]),
    Object.freeze([11, 3]),
    Object.freeze([13, 1.5]),
    Object.freeze([16, 0]),
    Object.freeze([19, 3]),
    Object.freeze([21, 1.5]),
    Object.freeze([23, -1]),
    Object.freeze([24, -2]),
  ]),
  arousal: Object.freeze([
    Object.freeze([0, -3]),
    Object.freeze([3, -3.5]),
    Object.freeze([6, -2]),
    Object.freeze([8, 0.5]),
    Object.freeze([10, 2.5]),
    Object.freeze([12, 1]),
    Object.freeze([14, -2.5]),
    Object.freeze([15, -2]),
    Object.freeze([16, 0]),
    Object.freeze([18, 1]),
    Object.freeze([20, 1]),
    Object.freeze([22, -1]),
    Object.freeze([24, -3]),
  ]),
  dominance: Object.freeze([
    Object.freeze([0, -2]),
    Object.freeze([4, -2.5]),
    Object.freeze([7, -1]),
    Object.freeze([9, 1]),
    Object.freeze([11, 2]),
    Object.freeze([13, 0.5]),
    Object.freeze([16, 0]),
    Object.freeze([18, 1]),
    Object.freeze([20, 1.5]),
    Object.freeze([22, 0]),
    Object.freeze([24, -2]),
  ]),
  energy: Object.freeze([
    Object.freeze([0, -8]),
    Object.freeze([3, -10]),
    Object.freeze([5, -10]),
    Object.freeze([6, -7]),
    Object.freeze([8, -2]),
    Object.freeze([11, 2]),
    Object.freeze([13, 1]),
    Object.freeze([16, 0]),
    Object.freeze([18, 1.5]),
    Object.freeze([20, 0.5]),
    Object.freeze([22, -4]),
    Object.freeze([23, -7]),
    Object.freeze([24, -8]),
  ]),
});

/**
 * 中文关键词规则：顺序即优先级（更「硬」的信号在前）。
 * 置信度只由命中规则的基线与命中次数决定，确定性可复算。
 */
const CLASSIFY_RULES = Object.freeze([
  {
    type: 'conflict',
    base: 0.78,
    pattern: /(?:你错了|别管我|烦不烦|闭嘴|少管我|你根本不懂|不想跟你说话|你听不懂|别说了)/,
  },
  {
    type: 'goodnight',
    base: 0.8,
    pattern: /(?:晚安|准备睡了|要去睡了|睡了|睡啦|先睡|明天见)/,
  },
  {
    type: 'thanks',
    base: 0.75,
    pattern: /(?:谢谢|谢啦|感谢|多谢|辛苦)/,
  },
  {
    type: 'cold',
    base: 0.62,
    pattern: /(?:随便|算了|不想说|呵呵|哦|行吧)/,
  },
  {
    type: 'care',
    base: 0.72,
    pattern: /(?:你怎么了|你怎么啦|还好吗|注意身体|别太累|别熬夜|早点休息|多喝|照顾好自己|没事吧|要不要紧)/,
  },
  {
    type: 'complain',
    base: 0.66,
    pattern: /(?:烦|累死|气死|难受|压力|崩溃|郁闷|好累|太累|心累|不开心|堵得慌)/,
  },
  {
    type: 'reunion',
    base: 0.74,
    pattern: /(?:好久不见|好久没|很久没|这段时间|多少年没)/,
  },
  {
    type: 'greeting',
    base: 0.7,
    pattern: /(?:早安|早上好|早啊|早呀|晚上好|午安|在吗|在不在|嗨|哈喽|你好|hello|hi(?=\b|[！!，,。\s]))|(?:^早(?:上)?[！!。，,~～\s]*$)/i,
  },
  {
    type: 'comfort',
    base: 0.7,
    pattern: /(?:抱抱|抱一下|别难过|我在|陪着你|会好的|别担心|有我在)/,
  },
  {
    type: 'share',
    base: 0.64,
    pattern: /(?:给你说|我跟你说|和你说|我刚|今天.{0,8}(?:做|干)了?什么|今天发生|分享一个|说个事)/,
  },
]);

/**
 * describe 的 12 种表述：pleasure 四档 × energy 三档。
 * 硬约束：不含任何阿拉伯数字、不含四维状态名、不超过 40 码点。
 */
export const DESCRIBE_SENTENCES = Object.freeze([
  '现在心情不错，精神也足，说话可以放松些，多聊两句',
  '现在心情不错，精神一般，聊轻松点的话题就好',
  '现在心情不错，精神有点低，说话放松些，回应短一点',
  '现在心情平稳，精神也足，正常聊天就好，别太用力',
  '现在心情平稳，精神一般，说到哪算哪，不用急着回应',
  '现在心情平稳，精神偏低，回应短一点，稳重些就好',
  '现在心情有点闷，精神头还足，少抬杠，给对方留点空间',
  '现在心情有点闷，精神一般，话少一点，先听着',
  '现在心情有点闷，精神也不旺，回应短些，今天稳一点',
  '现在心情低落，精神倒还足，说话轻一点，别追问',
  '现在心情低落，精神一般，先别急着劝，陪着就好',
  '现在心情低落，精神也低，回应短一点，今天稳一点',
]);

/** 分档边界（写死，勿改）：pleasure ≥65 不错 / 45–64 平稳 / 35–44 有点闷 / <35 低落。 */
const PLEASURE_BANDS = Object.freeze([65, 45, 35]);
/** 分档边界（写死，勿改）：energy ≥65 足 / 45–64 还行 / <45 偏低。 */
const ENERGY_BANDS = Object.freeze([65, 45]);

/**
 * 夹到闭区间。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 保留两位小数（统一处理 -0，避免快照出现 -0 与 0 不等）。
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 解析基线：缺省/非数值按 DEFAULT_BASELINE 逐维回落，数值夹到 0–100。
 * @param {object|null|undefined} baseline
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number}}
 */
function resolveBaseline(baseline) {
  if (baseline === undefined || baseline === null) return DEFAULT_BASELINE;
  if (typeof baseline !== 'object') {
    throw new TypeError(`baseline must be an object (got ${typeof baseline})`);
  }
  const resolved = {};
  for (const dim of DIMENSIONS) {
    const raw = baseline[dim];
    const fallback = DEFAULT_BASELINE[dim];
    resolved[dim] = Number.isFinite(raw) ? clamp(raw, VALUE_MIN, VALUE_MAX) : fallback;
  }
  return resolved;
}

/**
 * 只读四维并做基线回落（不含 updatedAt 校验），供 normalizeState 与渲染类函数共用。
 * @param {object} state
 * @param {object} [baseline] 非数值时的回落基线（缺省 DEFAULT_BASELINE）
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number}}
 */
function readDimensions(state, baseline = DEFAULT_BASELINE) {
  if (state === null || typeof state !== 'object') {
    throw new TypeError(
      `state must be an object with four dimensions (got ${state === null ? 'null' : typeof state})`,
    );
  }
  const dimensions = {};
  for (const dim of DIMENSIONS) {
    const raw = state[dim];
    dimensions[dim] = Number.isFinite(raw)
      ? clamp(raw, VALUE_MIN, VALUE_MAX)
      : baseline[dim];
  }
  return dimensions;
}

/**
 * 规范化状态：四维夹到 0–100，非数值回落 baseline，updatedAt 必须有限。
 * 返回新对象，不修改入参。
 *
 * @param {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}} state
 * @param {object} [baseline] 四维回落基线
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
export function normalizeState(state, baseline) {
  const resolved = resolveBaseline(baseline);
  const dimensions = readDimensions(state, resolved);
  if (!Number.isFinite(state.updatedAt)) {
    throw new TypeError(
      `normalizeState(state): state.updatedAt must be a finite millisecond timestamp `
      + `(got ${String(state.updatedAt)})`,
    );
  }
  return {
    pleasure: dimensions.pleasure,
    arousal: dimensions.arousal,
    dominance: dimensions.dominance,
    energy: dimensions.energy,
    updatedAt: state.updatedAt,
  };
}

/**
 * 以基线为初值创建状态。
 *
 * @param {{baseline?:object, nowMs:number}} options
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
export function createState(options) {
  const opts = options === null || options === undefined ? {} : options;
  if (typeof opts !== 'object') {
    throw new TypeError(`createState(options): options must be an object (got ${typeof options})`);
  }
  if (!Number.isFinite(opts.nowMs)) {
    throw new TypeError(
      `createState(options): options.nowMs must be a finite millisecond timestamp `
      + `(got ${String(opts.nowMs)})`,
    );
  }
  const resolved = resolveBaseline(opts.baseline);
  return {
    pleasure: resolved.pleasure,
    arousal: resolved.arousal,
    dominance: resolved.dominance,
    energy: resolved.energy,
    updatedAt: opts.nowMs,
  };
}

/**
 * 向基线指数回归：v' = b + (v - b) * 0.5 ** (dtHours / halfLifeHours)。
 * 四维共用同一半衰期（简单、可复算）；dt 为负视为 0；dt 为 0 时逐值恒等，
 * 不引入浮点漂移。半衰期合法区间 (0, 168] 小时。
 *
 * @param {object} state
 * @param {{baseline?:object, nowMs:number, halfLifeHours:number}} options
 * @returns {object} 新状态，updatedAt = nowMs
 */
export function decay(state, options) {
  const opts = options === null || options === undefined ? {} : options;
  if (typeof opts !== 'object') {
    throw new TypeError(`decay(state, options): options must be an object (got ${typeof options})`);
  }
  const halfLifeHours = opts.halfLifeHours;
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0 || halfLifeHours > MAX_HALF_LIFE_HOURS) {
    throw new TypeError(
      `decay(state, options): halfLifeHours must be a finite number in (0, ${MAX_HALF_LIFE_HOURS}] `
      + `(got ${String(halfLifeHours)})`,
    );
  }
  if (!Number.isFinite(opts.nowMs)) {
    throw new TypeError(
      `decay(state, options): options.nowMs must be a finite millisecond timestamp `
      + `(got ${String(opts.nowMs)})`,
    );
  }

  const resolved = resolveBaseline(opts.baseline);
  const current = normalizeState(state, resolved);
  const dtHours = Math.max(0, (opts.nowMs - current.updatedAt) / HOUR_MS);
  if (dtHours === 0) return { ...current, updatedAt: opts.nowMs };

  const factor = 0.5 ** (dtHours / halfLifeHours);
  const next = {};
  for (const dim of DIMENSIONS) {
    const base = resolved[dim];
    next[dim] = clamp(base + (current[dim] - base) * factor, VALUE_MIN, VALUE_MAX);
  }
  next.updatedAt = opts.nowMs;
  return next;
}

/**
 * 控制点分段线性插值（控制点小时单调递增，末点为 24）。
 * @param {ReadonlyArray<ReadonlyArray<number>>} points
 * @param {number} hourOfDay 0 ≤ hourOfDay < 24
 * @returns {number}
 */
function interpolate(points, hourOfDay) {
  for (let index = 1; index < points.length; index += 1) {
    const [rightHour, rightValue] = points[index];
    if (hourOfDay <= rightHour) {
      const [leftHour, leftValue] = points[index - 1];
      if (rightHour === leftHour) return rightValue;
      const ratio = (hourOfDay - leftHour) / (rightHour - leftHour);
      return leftValue + (rightValue - leftValue) * ratio;
    }
  }
  return points[points.length - 1][1];
}

/**
 * 昼夜节律偏移量：只依赖时刻，确定性、无随机。
 * hour 为 0–23（允许小数，如 23.5；minute 参与插值）。
 * 第二个参数保留给后续按人格标定幅度，当前不参与计算（契约要求只依赖时刻）。
 *
 * @param {{hour:number, minute?:number}} timeOfDay
 * @param {object} [_state] 保留参数
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number}}
 */
export function circadian(timeOfDay, _state) {
  const clock = timeOfDay === null || timeOfDay === undefined ? {} : timeOfDay;
  if (typeof clock !== 'object') {
    throw new TypeError(
      `circadian(timeOfDay): timeOfDay must be an object (got ${typeof timeOfDay})`,
    );
  }
  const hour = clock.hour;
  const minute = clock.minute === undefined ? 0 : clock.minute;
  if (!Number.isFinite(hour) || hour < 0 || hour >= 24) {
    throw new TypeError(
      `circadian(timeOfDay): timeOfDay.hour must be a finite number in [0, 24) `
      + `(got ${String(hour)})`,
    );
  }
  if (!Number.isFinite(minute) || minute < 0 || minute >= 60) {
    throw new TypeError(
      `circadian(timeOfDay): timeOfDay.minute must be a finite number in [0, 60) `
      + `(got ${String(minute)})`,
    );
  }

  const raw = hour + minute / 60;
  const hourOfDay = raw >= 24 ? raw - 24 : raw;
  const offsets = {};
  for (const dim of DIMENSIONS) {
    offsets[dim] = round2(interpolate(CIRCADIAN_POINTS[dim], hourOfDay));
  }
  return offsets;
}

/**
 * 由毫秒时间戳推 UTC 时刻（本模块不读时区）：接线方可用 hour/minute 覆盖成本地时间。
 * @param {number} nowMs
 * @returns {{hour:number, minute:number}}
 */
function utcClock(nowMs) {
  const totalMinutes = Math.floor(nowMs / MINUTE_MS);
  const hour = ((Math.floor(totalMinutes / 60) % 24) + 24) % 24;
  const minute = ((totalMinutes % 60) + 60) % 60;
  return { hour, minute };
}

/**
 * 施加一次对话事件：事件固有增量（按 intensity 缩放并夹到单维上限）+ 当前节律偏移，
 * 叠加到状态后整体夹到 0–100。
 *
 * 语义方向：greeting/share/thanks/comfort 抬愉悦；care 抬愉悦与唤醒、精力略升；
 * complain 降愉悦抬唤醒；cold 降愉悦与掌控；reunion 抬愉悦与唤醒；
 * goodnight 降唤醒、精力略升（被安慰感）；conflict 降愉悦与掌控、抬唤醒。
 *
 * intensity 只缩放事件固有部分；节律偏移是环境项，不随 intensity 变化。
 * hour/minute 可显式传入本地时刻；缺省按 nowMs 的 UTC 时刻计算（纯函数不读时区）。
 *
 * @param {object} state
 * @param {object} options {type, intensity?, nowMs, hour?, minute?, baseline?}
 * @returns {{state:object, event:{at:number,type:string,deltas:object}}}
 */
export function applyEvent(state, options) {
  const opts = options === null || options === undefined ? {} : options;
  if (typeof opts !== 'object') {
    throw new TypeError(`applyEvent(state, options): options must be an object (got ${typeof options})`);
  }
  const { type } = opts;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_DELTAS, type)) {
    throw new TypeError(
      `applyEvent(state, options): unknown event type ${String(type)}; `
      + `expected one of ${EVENT_TYPES.join(', ')}`,
    );
  }
  const intensity = opts.intensity === undefined ? 1 : opts.intensity;
  if (typeof intensity !== 'number' || Number.isNaN(intensity)) {
    throw new TypeError(
      `applyEvent(state, options): intensity must be a number in [0, ${MAX_INTENSITY}] `
      + `(got ${String(opts.intensity)})`,
    );
  }
  if (!Number.isFinite(opts.nowMs)) {
    throw new TypeError(
      `applyEvent(state, options): options.nowMs must be a finite millisecond timestamp `
      + `(got ${String(opts.nowMs)})`,
    );
  }

  const level = clamp(intensity, 0, MAX_INTENSITY);
  const current = normalizeState(state, opts.baseline);

  const fallbackClock = utcClock(opts.nowMs);
  const clock = {
    hour: Number.isFinite(opts.hour) ? opts.hour : fallbackClock.hour,
    minute: Number.isFinite(opts.minute) ? opts.minute : fallbackClock.minute,
  };
  const rhythm = circadian(clock);
  const rule = EVENT_DELTAS[type];

  const next = {};
  const deltas = {};
  for (const dim of DIMENSIONS) {
    const cap = MAX_EVENT_DELTA[dim];
    const intrinsic = clamp(rule[dim] * level, -cap, cap);
    const target = clamp(current[dim] + intrinsic + rhythm[dim], VALUE_MIN, VALUE_MAX);
    next[dim] = target;
    deltas[dim] = round2(target - current[dim]);
  }
  next.updatedAt = opts.nowMs;

  return {
    state: next,
    event: { at: opts.nowMs, type, deltas },
  };
}

/**
 * 统计正则命中次数（用副本另加 g 标志，不改动规则里的正则）。
 * @param {RegExp} pattern
 * @param {string} text
 * @returns {number}
 */
function countMatches(pattern, text) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  let count = 0;
  let matched = global.exec(text);
  while (matched !== null) {
    count += 1;
    if (matched[0].length === 0) global.lastIndex += 1;
    matched = global.exec(text);
  }
  return count;
}

/**
 * 中文关键词分类（不调模型、无随机）。规则按优先级顺序匹配，首个命中即返回；
 * 命中次数越多置信度略高（上限 0.95）。都不匹配 → share / 0（低置信度，调用方可跳过）。
 *
 * @param {string} text
 * @returns {{type:string, confidence:number}}
 */
export function classify(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`classify(text): text must be a string (got ${typeof text})`);
  }
  const trimmed = text.trim();
  if (trimmed === '') return { type: 'share', confidence: 0 };

  for (const rule of CLASSIFY_RULES) {
    const hits = countMatches(rule.pattern, trimmed);
    if (hits > 0) {
      const confidence = round2(Math.min(0.95, rule.base + 0.08 * (hits - 1)));
      return { type: rule.type, confidence };
    }
  }
  return { type: 'share', confidence: 0 };
}

/**
 * 四维分档下标（0 为最高档）。
 * @param {number} value
 * @param {ReadonlyArray<number>} bands 递减的档位下界
 * @returns {number}
 */
function bandIndex(value, bands) {
  for (let index = 0; index < bands.length; index += 1) {
    if (value >= bands[index]) return index;
  }
  return bands.length;
}

/**
 * 用一句中文人话描述当前状态：无阿拉伯数字、无百分比、无四维状态名，≤40 码点。
 * 句式由 pleasure 四档 × energy 三档决定（共 12 种，见 DESCRIBE_SENTENCES）。
 * 四维缺失/非数值按 DEFAULT_BASELINE 回落，不要求 updatedAt。
 *
 * @param {object} state
 * @returns {string}
 */
export function describe(state) {
  const dimensions = readDimensions(state);
  const pleasureTier = bandIndex(dimensions.pleasure, PLEASURE_BANDS);
  const energyTier = bandIndex(dimensions.energy, ENERGY_BANDS);
  return DESCRIBE_SENTENCES[pleasureTier * 3 + energyTier];
}

/**
 * 存储前序列化：严格校验四维与 updatedAt（缺失/非数值/越界一律 TypeError），
 * 只输出五个字段的纯对象，便于 JSON 落库。
 *
 * @param {object} state
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
export function serialize(state) {
  return validateStoredShape(state, 'serialize(state)');
}

/**
 * 反序列化：接受 JSON 字符串或对象，严格校验后返回新对象。
 *
 * @param {string|object} raw
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
export function deserialize(raw) {
  if (typeof raw === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TypeError('deserialize(raw): raw is not valid JSON');
    }
    return validateStoredShape(parsed, 'deserialize(raw)');
  }
  return validateStoredShape(raw, 'deserialize(raw)');
}

/**
 * 严格校验存储形状并返回新对象（只含五个字段）。
 * @param {unknown} raw
 * @param {string} label
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
function validateStoredShape(raw, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${label}: expected a plain object (got ${raw === null ? 'null' : typeof raw})`);
  }
  const shaped = {};
  for (const dim of DIMENSIONS) {
    const value = raw[dim];
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label}: ${dim} must be a finite number (got ${String(value)})`);
    }
    if (value < VALUE_MIN || value > VALUE_MAX) {
      throw new TypeError(`${label}: ${dim} must be within 0-100 (got ${String(value)})`);
    }
    shaped[dim] = value;
  }
  if (!Number.isFinite(raw.updatedAt)) {
    throw new TypeError(
      `${label}: updatedAt must be a finite millisecond timestamp (got ${String(raw.updatedAt)})`,
    );
  }
  shaped.updatedAt = raw.updatedAt;
  return shaped;
}
