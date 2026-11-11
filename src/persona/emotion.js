/**
 * 情绪状态内核（P3-a）：愉悦 / 唤醒 / 掌控（PAD）+ 精力 四维纯函数。
 *
 * 契约与约束（改动前先读）：
 * 1) 纯函数：同一输入永远同一输出。时间戳（nowMs / updatedAt）、基线、半衰期全部由
 *    调用方传入；本模块不读时钟、不读环境变量、不写文件、不用随机数。
 * 2) 状态形如 { pleasure, arousal, dominance, energy, updatedAt }，四维取值 0–100，
 *    updatedAt 是毫秒时间戳。
 * 3) 零依赖：只 import 同目录下的纯函数模块（v0.5.2 起分类器拆到 emotion-classify.js），
 *    不 import 任何 node: 内置模块。
 *
 * 接线方（后续卡片）负责：从存储读状态、决定 baseline、提供 nowMs 与本地小时。
 */

/** 四维顺序固定，便于遍历与快照比对。 */
import { classify } from './emotion-classify.js';

// 对外仍从本模块导出分类器：接线方长期 `import { classify } from "./emotion.js"`。
export { classify };

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

/**
 * 缺省基线：与内置人格卡 `emotion.baseline` **保持一致**（{50,50,50,60}），
 * 避免「缺省继承卡里的值」与「非法值回落 DEFAULT_BASELINE」出现两套默认
 * （review-v20 L-7）。改动这里必须同步 `DEFAULT_CARD.emotion.baseline`。
 */
export const DEFAULT_BASELINE = Object.freeze({
  pleasure: 50,
  arousal: 50,
  dominance: 50,
  energy: 60,
});

/** 事件类型白名单（顺序即文档顺序）。 */
// `complain` 已在 v0.5.2 退役（并入 vent）：仍保留在 EVENT_DELTAS 里读旧数据，
// 但不再属于分类器可产出的类型集合。
export const EVENT_TYPES = Object.freeze([
  'greeting',
  'care',
  'share',
  'thanks',
  'cold',
  'reunion',
  'goodnight',
  'conflict',
  'blame',
  'vent',
  'comfort',
  'reassure',
]);

/**
 * 安静时段对 energy 的额外目标偏移（与昼夜节律一样属于环境项，不是每轮增量）。
 * wiring 里以 `QUIET_ENERGY_DELTA` 的历史名字导出，数值保持不变。
 */
export const QUIET_ENERGY_OFFSET = -3;

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
  // 冲着她来的负面话：愉悦明显掉、唤醒略升、精力略降（不迁怒状态句）。
  blame: Object.freeze({ pleasure: -6.4, arousal: 1.5, dominance: -1, energy: -1 }),
  // 用户在担心「是不是惹到她了」：她收到的是被在意，轻轻回暖而不是被指责。
  reassure: Object.freeze({ pleasure: 2, arousal: -1, dominance: 0.5, energy: 0.5 }),
  // 用户自述疲惫：只小幅压愉悦，掌控/精力不下沉（避免把诉苦读成对她的不满）。
  vent: Object.freeze({ pleasure: -1.5, arousal: -0.5, dominance: 0.5, energy: 0 }),
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

/**
 * V50-M1：针对「冲她来的负面话」的专属表述（事件类型 blame）。
 * 与 DESCRIBE_SENTENCES 同口径：无阿拉伯数字、≤40 码点；按愉悦档位二选一。
 */
export const BLAME_SENTENCES = Object.freeze([
  '现在心里被扎了一下，先稳住，别赌气，话少一点',
  '现在有点委屈又有点气，回应短些，别把话顶回去',
]);

/**
 * V50-M1：针对「用户自述疲惫」的专属表述（事件类型 vent）。
 * 只体现关心与心疼，不含责备；与 DESCRIBE_SENTENCES 同口径。
 */
export const VENT_SENTENCES = Object.freeze([
  '现在心软下来，先问问累在哪，别急着讲道理',
  '现在有点心疼，先接住这份累，陪着就好',
]);

/** reassure 的专属表述：被在意、心软下来，不指责也不得意。 */
export const REASSURE_SENTENCES = Object.freeze([
  '被这么小心地问一句，心里软了下来，想让对方放心',
  '有点想笑，其实没生气，想好好跟对方说一句没事',
  '心口松了一下，想认真告诉对方：没有烦，也不会烦',
  '被在意着，气消了大半，只想把话说柔和些',
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
 * 向目标值指数回归：v' = t + (v - t) * 0.5 ** (dtHours / halfLifeHours)。
 * 四维共用同一半衰期（简单、可复算）；dt 为负视为 0；dt 为 0 时逐值恒等，
 * 不引入浮点漂移。半衰期合法区间 (0, 168] 小时。
 *
 * `target` 是可选的目标状态（V50-H1）：昼夜节律 + 安静时段等环境项由接线方
 * 折算成目标偏移传入，状态朝目标回归，**不会**把环境项当成每轮增量反复叠加。
 * 缺省（不传 target）时沿用 baseline，与旧调用完全兼容。
 *
 * @param {object} state
 * @param {{baseline?:object, target?:object, nowMs:number, halfLifeHours:number}} options
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
  // 目标缺省 = 基线（旧行为）；显式传 target 时朝目标回归。
  const anchor = opts.target === undefined ? resolved : resolveBaseline(opts.target);
  const current = normalizeState(state, resolved);
  const dtHours = Math.max(0, (opts.nowMs - current.updatedAt) / HOUR_MS);
  if (dtHours === 0) return { ...current, updatedAt: opts.nowMs };

  const factor = 0.5 ** (dtHours / halfLifeHours);
  const next = {};
  for (const dim of DIMENSIONS) {
    const base = anchor[dim];
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
 * 某时刻的平衡目标（V50-H1）：baseline + 昼夜节律 + 安静时段偏移，逐维夹到 0–100。
 *
 * 这是「状态该停在哪里」而不是「本轮该加多少」：接线方把它传给 `decay`，
 * 状态朝目标指数回归，因此节律/安静不会被当成增量每轮重复叠加。
 * 安静时段只额外压 energy（沿用 wiring 的 QUIET_ENERGY_DELTA = QUIET_ENERGY_OFFSET）。
 *
 * @param {{baseline?:object, hour:number, minute?:number, quiet?:boolean}} options
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number}}
 */
export function targetFor(options) {
  const opts = options === null || options === undefined ? {} : options;
  if (typeof opts !== 'object') {
    throw new TypeError(`targetFor(options): options must be an object (got ${typeof options})`);
  }
  const resolved = resolveBaseline(opts.baseline);
  const offsets = circadian({ hour: opts.hour, minute: opts.minute });
  const quiet = opts.quiet === true;
  const target = {};
  for (const dim of DIMENSIONS) {
    const quietOffset = quiet && dim === 'energy' ? QUIET_ENERGY_OFFSET : 0;
    target[dim] = round2(clamp(resolved[dim] + offsets[dim] + quietOffset, VALUE_MIN, VALUE_MAX));
  }
  return target;
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
 * 事件增量的递减因子（V51-L1）：
 * - 离边界越近推得越轻：往上推乘 (100−x)/50，往下推乘 x/50，最大 1；
 * - 10 分钟内同类事件第 k 次再乘 0.7^(k−1)。
 * 单次事件在基线上（50 分附近）因子为 1，与 v0.5.1 的增量保持不变。
 *
 * @param {object|undefined} history 最近的 {at,type} 列表（可省略）
 * @param {string} type
 * @param {number} nowMs
 * @returns {number}
 */
function repeatDecay(history, type, nowMs) {
  if (history === undefined || history === null) return 1;
  if (!Array.isArray(history)) {
    throw new TypeError(`applyEvent(state, options): options.history must be an array (got ${typeof history})`);
  }
  let repeats = 0;
  for (const item of history) {
    if (item === null || typeof item !== 'object') continue;
    if (item.type !== type) continue;
    if (!Number.isFinite(item.at)) continue;
    const gap = nowMs - item.at;
    if (gap >= 0 && gap < 10 * MINUTE_MS) repeats += 1;
  }
  return 0.7 ** repeats;
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
 * @param {object} options {type, intensity?, nowMs, hour?, minute?, baseline?, history?}
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

  const repeatFactor = repeatDecay(opts.history, type, opts.nowMs);
  const next = {};
  const deltas = {};
  for (const dim of DIMENSIONS) {
    const cap = MAX_EVENT_DELTA[dim];
    const raw = rule[dim] * level;
    // 距离缩放：越高越难再往上推，越低越难再往下推（不改变语义方向）。
    const room = raw > 0
      ? Math.min(1, (VALUE_MAX - current[dim]) / 50)
      : raw < 0
        ? Math.min(1, current[dim] / 50)
        : 1;
    const intrinsic = clamp(raw * room * repeatFactor, -cap, cap);
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
 * 把四维增量并入状态（P3-c 接线用）：节律与安静时段等环境项统一走这里，
 * 避免外层手写四维相加导致夹取/舍入口径不一致。
 *
 * - 缺失的维度按 0；出现但不是有限数 → TypeError；
 * - 相加后夹到 0–100 并保留两位小数；
 * - `updatedAt` 原样保留（环境项不推进状态时钟，由调用方决定）。
 * - 返回新对象，不修改入参。
 *
 * @param {object} state
 * @param {{pleasure?:number,arousal?:number,dominance?:number,energy?:number}} deltas
 * @param {object} [baseline] 四维缺失/非法时的回落基线（与 normalizeState 同口径）
 * @returns {{pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number}}
 */
export function applyDeltas(state, deltas, baseline) {
  if (deltas === null || typeof deltas !== 'object' || Array.isArray(deltas)) {
    throw new TypeError(
      `applyDeltas(state, deltas): deltas must be an object (got ${deltas === null ? 'null' : typeof deltas})`,
    );
  }
  const current = normalizeState(state, baseline);
  const next = {};
  for (const dim of DIMENSIONS) {
    const delta = deltas[dim] === undefined ? 0 : deltas[dim];
    if (!Number.isFinite(delta)) {
      throw new TypeError(
        `applyDeltas(state, deltas): deltas.${dim} must be a finite number (got ${String(deltas[dim])})`,
      );
    }
    next[dim] = round2(clamp(current[dim] + delta, VALUE_MIN, VALUE_MAX));
  }
  next.updatedAt = current.updatedAt;
  return next;
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
 * 可选第二参 `context.eventType` 用于区分「冲她来的负面话」与「用户自述疲惫」：
 * blame / vent 走各自的专属句（BLAME_SENTENCES / VENT_SENTENCES），
 * 其余类型或省略第二参时与原行为完全一致。
 *
 * @param {object} state
 * @param {{eventType?:string}} [context]
 * @returns {string}
 */
export function describe(state, context) {
  const dimensions = readDimensions(state);
  const pleasureTier = bandIndex(dimensions.pleasure, PLEASURE_BANDS);
  const energyTier = bandIndex(dimensions.energy, ENERGY_BANDS);
  if (context !== undefined && context !== null) {
    if (typeof context !== 'object' || Array.isArray(context)) {
      throw new TypeError(`describe(state, context): context must be an object (got ${typeof context})`);
    }
    if (context.eventType === 'blame') return BLAME_SENTENCES[pleasureTier % BLAME_SENTENCES.length];
    if (context.eventType === 'vent') return VENT_SENTENCES[pleasureTier % VENT_SENTENCES.length];
    if (context.eventType === 'reassure') return REASSURE_SENTENCES[pleasureTier % REASSURE_SENTENCES.length];
  }
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
