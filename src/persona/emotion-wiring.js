/**
 * 情绪接线（P3-c）：把「读库 → 朝目标衰减 → 分类事件 → 应用 → 落库 → 描述」
 * 串成可注入依赖的纯逻辑。
 *
 * V50-H1：昼夜节律与安静时段是**目标偏移**（targetFor），不是每轮增量。
 * 状态每轮朝「baseline + 节律 + 安静」指数回归（decay 的 target），
 * 只有分类事件在衰减之后叠加；因此连发消息不会把节律重复累加进状态。
 *
 * 设计约束：
 * - 不读时钟、不读环境变量：now / hour / minute / quiet 全部由调用方算好传入；
 * - 不依赖平台对象：store 只需实现 getEmotionState / setEmotionState /
 *   appendEmotionEvent，便于单测用内存替身；
 * - 事件时间统一用毫秒（与 emotion 内核、store 的 emotion_* 表一致）；
 * - 写库失败向上抛，由接线层（pre-step）捕获并 warn，不影响本轮对话。
 */

import {
  DEFAULT_BASELINE,
  QUIET_ENERGY_OFFSET,
  applyEvent,
  classify,
  createState,
  decay,
  describe,
  targetFor,
} from './emotion.js';

/**
 * 安静时段对 energy 的额外目标偏移（与节律一样属于环境项，由 targetFor 折算，
 * 不再是每轮增量）。数值保持 -3，历史导入名不变。
 */
export const QUIET_ENERGY_DELTA = QUIET_ENERGY_OFFSET;

/** 注入消息的 source.kind；转录/巩固/主会话绑定都按它排除。 */
export const EMOTION_SOURCE_KIND = 'companion-emotion';

/** 注入文本前缀（surface 记录没有 source 时按此前缀兜底排除）。 */
export const EMOTION_PROMPT_PREFIX = '你此刻：';

/** 环境项单独造成的状态变化超过该阈值才落库（事件命中不受此限）。 */
const SIGNIFICANT_DELTA = 0.5;

/** 事件类型白名单之外的「只有环境变化」记录类型。 */
const AMBIENT_EVENT_TYPE = 'ambient';

/** 四维顺序（与内核一致）。 */
const DIMENSIONS = Object.freeze(['pleasure', 'arousal', 'dominance', 'energy']);

/**
 * 低于这个置信度表示「分不出来」：事件仍记一条审计，但不改状态（V52 规则 4）。
 */
export const AMBIGUOUS_CONFIDENCE = 0.5;

/**
 * 读最近的同类事件供重复递减使用；store 不支持时返回空数组（不阻断本轮）。
 *
 * @param {object} store
 * @param {string} scope
 * @returns {Array<{at:number,type:string}>}
 */
function readHistory(store, scope) {
  if (typeof store.listEmotionEvents !== 'function') return [];
  try {
    const rows = store.listEmotionEvents(scope, 20);
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row !== null && typeof row === 'object');
  } catch {
    return [];
  }
}

/**
 * 分类置信度 → applyEvent 的 intensity。
 *
 * 选择：`0.5 + confidence`，夹到 [0.5, 1.5]。理由：
 * - 分类器命中时 confidence 在 0.62–0.95，裸用会让低置信信号太弱、双命中过强；
 * - 加 0.5 后最弱也有 1.12 倍，用户一句话能看见变化；
 * - 上限 1.5 避免同一句话把状态推满，也给 applyEvent 的 0–3 留出余量。
 *
 * @param {number} confidence
 * @returns {number}
 */
export function intensityFor(confidence) {
  const value = 0.5 + confidence;
  if (value < 0.5) return 0.5;
  if (value > 1.5) return 1.5;
  return Math.round(value * 100) / 100;
}

/**
 * 一轮用户输入的情绪接线。
 *
 * @param {object} input
 * @param {{getEmotionState: Function, setEmotionState: Function, appendEmotionEvent: Function}} input.store
 * @param {{emotion?: {enabled?: boolean, baseline?: object, halfLifeHours?: number}}} [input.card]
 * @param {object} [input.config] 注入位；时钟/安静判断已由调用方算好，本模块不读
 * @param {number} input.now 毫秒时间戳
 * @param {number} input.hour 本地小时 0–23
 * @param {number} input.minute 本地分钟 0–59
 * @param {boolean} [input.quiet] 是否处于配置的安静时段
 * @param {string} [input.scope='main']
 * @param {string} [input.text=''] 本轮最后一条用户文本（用于 classify）
 * @returns {{
 *   state: {pleasure:number,arousal:number,dominance:number,energy:number,updatedAt:number},
 *   event: {at:number,type:string,deltas:object}|null,
 *   line: string,
 *   changed: boolean
 * }}
 */
export function runEmotionTurn(input = {}) {
  const {
    store,
    card,
    config,
    now,
    hour,
    minute,
    quiet = false,
    scope = 'main',
    text = '',
    note,
    skipEvent = false,
  } = input;
  void config;

  if (!store || typeof store.getEmotionState !== 'function'
    || typeof store.setEmotionState !== 'function'
    || typeof store.appendEmotionEvent !== 'function') {
    throw new TypeError('[emotion-wiring] store must provide emotion state/event methods');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('[emotion-wiring] now must be a finite millisecond timestamp');
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new TypeError('[emotion-wiring] hour and minute must be finite numbers');
  }

  const emotion = card?.emotion ?? {};
  const baseline = emotion.baseline ?? DEFAULT_BASELINE;
  const halfLifeHours = emotion.halfLifeHours ?? 6;

  // V50-H1：节律 + 安静时段折算成「此刻的平衡目标」，不是本轮增量。
  const target = targetFor({ baseline, hour, minute, quiet: quiet === true });

  const stored = store.getEmotionState(scope);
  // 无历史状态时直接从目标起步（而不是先按 baseline 起步再被节律顶过去），
  // 保证冷启动与上一轮刚写过状态的结果一致；reference 保留 baseline 口径，
  // 用于「环境项变化是否值得记一条 ambient」的审计。
  const reference = stored ?? createState({ nowMs: now, baseline });
  const seed = stored ?? createState({ nowMs: now, baseline: target });
  // 朝目标回归：节律/安静只影响目标位置，不会作为增量写进状态。
  const decayed = decay(seed, { baseline, target, halfLifeHours, nowMs: now });
  // 对照「只朝 baseline 回归」的反事实状态，得到本轮环境项的净贡献，
  // 仅用于 ambient 审计（不参与状态计算）。
  const baselineDecayed = decay(reference, { baseline, halfLifeHours, nowMs: now });

  // V52：名字来自人格卡（不写死），作为「她」的称呼参与对象判定。
  // v0.6-E2：llm 模式下 pre-step 不等判定，只做衰减与描述（skipEvent=true），
  // 事件由后台判定回来后走 applyClassifiedEvent 单独落库，避免同一事件入账两次。
  const classified = skipEvent
    ? { type: 'none', confidence: 0 }
    : classify(typeof text === 'string' ? text : '', { name: card?.name });
  let state = decayed;
  let event = null;
  if (classified.confidence > 0 && classified.confidence < AMBIGUOUS_CONFIDENCE) {
    // 分不出来（例如同一句既有对她的负面又有对她的正面）：只记录、不加增量。
    event = {
      at: now,
      type: classified.type,
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
    };
  } else if (classified.confidence > 0) {
    // V51-L1：最近的同类事件用于「10 分钟内重复递减」，读不到就当没有历史。
    const history = readHistory(store, scope);
    // hour=16 是节律全零的中性时刻：目标值已含环境项，这里只叠加事件固有增量。
    const applied = applyEvent(decayed, {
      type: classified.type,
      intensity: intensityFor(classified.confidence),
      nowMs: now,
      hour: 16,
      minute: 0,
      baseline,
      history,
    });
    state = applied.state;
    event = applied.event;
  }

  // 本轮「事件」的实际增量（相对朝目标衰减后的状态）；环境项另有 environmentDeltas。
  const turnDeltas = {};
  const environmentDeltas = {};
  let changed = false;
  for (const dim of DIMENSIONS) {
    turnDeltas[dim] = round2(state[dim] - decayed[dim]);
    environmentDeltas[dim] = round2(decayed[dim] - baselineDecayed[dim]);
    if (Math.abs(state[dim] - reference[dim]) > SIGNIFICANT_DELTA) changed = true;
  }
  if (event === null && changed) {
    // ambient 只记环境项（节律/安静）的净贡献；纯衰减时 deltas 为 0。
    event = { at: now, type: AMBIENT_EVENT_TYPE, deltas: environmentDeltas };
  } else if (event !== null) {
    event = { at: event.at, type: event.type, deltas: turnDeltas };
  }

  if (event !== null || changed) {
    store.setEmotionState(scope, {
      pleasure: state.pleasure,
      arousal: state.arousal,
      dominance: state.dominance,
      energy: state.energy,
      updatedAt: state.updatedAt,
      lastEventAt: event === null ? undefined : event.at,
    });
    if (event !== null) {
      store.appendEmotionEvent(scope, {
        at: event.at,
        type: event.type,
        deltas: event.deltas,
        ...(typeof note === 'string' && note !== '' ? { note } : {}),
      });
    }
  }

  return {
    state,
    event,
    // V50-M1：把本轮事件类型交给 describe，blame / vent 用各自的专属句；
    // 其余类型（含 ambient）与不传第二参时完全一致。
    line: describe(state, event === null ? undefined : { eventType: event.type }),
    changed,
  };
}

/**
 * 把一次「已经判定好」的情绪事件落库（v0.6-E2 的后台判定路径）。
 *
 * 与 runEmotionTurn 的区别：不调用规则分类器，直接采用传入的
 * `{type, confidence}`；仍做「朝当前目标衰减 → 叠加事件 → 写库 → 描述」，
 * 因此晚到的判定会按到达时刻正确衰减，不会把时间倒流。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} [input.card]
 * @param {string} [input.scope='main']
 * @param {{type: string, confidence: number}} input.classified
 * @param {number} [input.intensity] 省略时按 intensityFor(confidence) 计算
 * @param {string} [input.note] 来源标记（llm / rules / rules:fallback:<原因>）
 * @param {number} input.now
 * @param {number} input.hour
 * @param {number} input.minute
 * @param {boolean} [input.quiet]
 * @returns {{state: object, event: object|null, line: string, changed: boolean}}
 */
export function applyClassifiedEvent(input = {}) {
  const {
    store,
    card,
    scope = 'main',
    classified,
    intensity,
    note,
    now,
    hour,
    minute,
    quiet = false,
  } = input;

  if (!store || typeof store.getEmotionState !== 'function'
    || typeof store.setEmotionState !== 'function'
    || typeof store.appendEmotionEvent !== 'function') {
    throw new TypeError('[emotion-wiring] store must provide emotion state/event methods');
  }
  if (!Number.isFinite(now)) {
    throw new TypeError('[emotion-wiring] now must be a finite millisecond timestamp');
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new TypeError('[emotion-wiring] hour and minute must be finite numbers');
  }
  if (classified === null || typeof classified !== 'object'
    || typeof classified.type !== 'string'
    || !Number.isFinite(classified.confidence)) {
    throw new TypeError('[emotion-wiring] classified must be {type, confidence}');
  }

  const emotion = card?.emotion ?? {};
  const baseline = emotion.baseline ?? DEFAULT_BASELINE;
  const halfLifeHours = emotion.halfLifeHours ?? 6;
  const target = targetFor({ baseline, hour, minute, quiet: quiet === true });

  const stored = store.getEmotionState(scope);
  const reference = stored ?? createState({ nowMs: now, baseline });
  const seed = stored ?? createState({ nowMs: now, baseline: target });
  const decayed = decay(seed, { baseline, target, halfLifeHours, nowMs: now });

  let state = decayed;
  let event = null;

  if (classified.type === 'none' || classified.confidence <= 0) {
    // 判不出事件：只记一条零增量审计，状态不动（口径与 v0.5.2 的模糊档一致）。
    if (typeof note === 'string' && note !== '') {
      store.appendEmotionEvent(scope, {
        at: now,
        type: 'none',
        deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
        note,
      });
    }
  } else if (classified.confidence < AMBIGUOUS_CONFIDENCE) {
    store.appendEmotionEvent(scope, {
      at: now,
      type: classified.type,
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
      ...(typeof note === 'string' && note !== '' ? { note } : {}),
    });
    event = {
      at: now,
      type: classified.type,
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
    };
  } else {
    const history = readHistory(store, scope);
    const applied = applyEvent(decayed, {
      type: classified.type,
      intensity: Number.isFinite(intensity) ? intensity : intensityFor(classified.confidence),
      nowMs: now,
      hour: 16,
      minute: 0,
      baseline,
      history,
    });
    state = applied.state;
    const deltas = {};
    for (const dim of DIMENSIONS) deltas[dim] = round2(state[dim] - decayed[dim]);
    event = { at: applied.event.at, type: applied.event.type, deltas };
    store.appendEmotionEvent(scope, {
      at: event.at,
      type: event.type,
      deltas,
      ...(typeof note === 'string' && note !== '' ? { note } : {}),
    });
  }

  let changed = false;
  for (const dim of DIMENSIONS) {
    if (Math.abs(state[dim] - reference[dim]) > SIGNIFICANT_DELTA) changed = true;
  }

  store.setEmotionState(scope, {
    pleasure: state.pleasure,
    arousal: state.arousal,
    dominance: state.dominance,
    energy: state.energy,
    updatedAt: state.updatedAt,
    lastEventAt: event === null ? undefined : event.at,
  });

  return {
    state,
    event,
    line: describe(state, event === null ? undefined : { eventType: event.type }),
    changed,
  };
}

/**
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
