/**
 * 情绪接线（P3-c）：把「读库 → 衰减 → 节律 → 安静时段 → 分类事件 → 应用 →
 * 落库 → 描述」串成可注入依赖的纯逻辑。
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
  applyDeltas,
  applyEvent,
  circadian,
  classify,
  createState,
  decay,
  describe,
} from './emotion.js';

/** 安静时段对 energy 的额外环境增量（与节律增量相加后一并计入事件 deltas）。 */
export const QUIET_ENERGY_DELTA = -3;

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

  const stored = store.getEmotionState(scope) ?? createState({ nowMs: now, baseline });
  const decayed = decay(stored, { baseline, halfLifeHours, nowMs: now });

  // 节律 + 安静时段作为「本轮环境项」并入；安静时段只额外压 energy。
  const rhythm = circadian({ hour, minute });
  const environment = {};
  for (const dim of DIMENSIONS) environment[dim] = rhythm[dim];
  environment.energy += quiet === true ? QUIET_ENERGY_DELTA : 0;
  const ambient = applyDeltas(decayed, environment, baseline);

  const classified = classify(typeof text === 'string' ? text : '');
  let state = ambient;
  let event = null;
  if (classified.confidence > 0) {
    // hour=16 是节律全零的中性时刻：环境项已经单独并入，这里只取事件固有增量。
    const applied = applyEvent(ambient, {
      type: classified.type,
      intensity: intensityFor(classified.confidence),
      nowMs: now,
      hour: 16,
      minute: 0,
      baseline,
    });
    state = applied.state;
    event = applied.event;
  }

  // 本轮「环境 + 事件」的实际增量（相对衰减后的状态），用于事件表。
  const turnDeltas = {};
  let changed = false;
  for (const dim of DIMENSIONS) {
    turnDeltas[dim] = round2(state[dim] - decayed[dim]);
    if (Math.abs(state[dim] - stored[dim]) > SIGNIFICANT_DELTA) changed = true;
  }
  if (event === null && changed) {
    event = { at: now, type: AMBIENT_EVENT_TYPE, deltas: turnDeltas };
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
      });
    }
  }

  return {
    state,
    event,
    line: describe(state),
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
