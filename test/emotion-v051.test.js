/**
 * V50-H1 / V50-M1 回归测试。
 *
 * H1：昼夜节律与安静时段是「目标偏移」，不是每轮增量；状态朝目标指数回归，
 *     事件增量在衰减后叠加。覆盖评审复现的两条无界漂移路径。
 * M1：规则评估区分「冲她来的负面话」（blame）与「用户自述疲惫」（vent），
 *     注入句随事件类型区分；describe 不传第二参时行为不变。
 *
 * 全部使用内存状态替身与固定时钟，不读真实时间/不写真实库；三时区结果一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_TYPES,
  classify,
  describe,
  targetFor,
} from '../src/persona/emotion.js';
import { runEmotionTurn } from '../src/persona/emotion-wiring.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const BASE_50 = Object.freeze({
  pleasure: 50,
  arousal: 50,
  dominance: 50,
  energy: 50,
});

const DIMENSIONS = Object.freeze(['pleasure', 'arousal', 'dominance', 'energy']);

/** 内存版 store：只需要 wiring 用到的三个方法。 */
function makeMemoryStore() {
  const states = new Map();
  const events = [];
  return {
    states,
    events,
    getEmotionState(scope) {
      const state = states.get(scope);
      return state === undefined ? null : { ...state };
    },
    setEmotionState(scope, state) {
      states.set(scope, { ...state });
    },
    appendEmotionEvent(scope, event) {
      events.push({ scope, ...event });
    },
    countEmotionEvents(scope = 'main') {
      return events.filter((event) => event.scope === scope).length;
    },
    listEmotionEvents(scope = 'main', limit = events.length) {
      return events.filter((event) => event.scope === scope).slice(-limit).reverse();
    },
  };
}

/** @param {number} now @param {number} hour @param {number} minute @param {string} text */
function runTurn(store, now, hour, minute, text, quiet = false, scope = 'main') {
  return runEmotionTurn({
    store,
    card: { emotion: { enabled: true, baseline: { ...BASE_50 }, halfLifeHours: 6 } },
    now,
    hour,
    minute,
    quiet,
    scope,
    text,
  });
}

/** 四维与目标值的最大偏差。 */
function maxDeviation(state, target) {
  return Math.max(...DIMENSIONS.map((dim) => Math.abs(state[dim] - target[dim])));
}

// ---------------------------------------------------------------- V50-H1

test('V50-H1：固定 11:00 连发 50 条中性消息，四维稳定在 baseline+节律 ±2', (t) => {
  const store = makeMemoryStore();
  const start = Date.UTC(2026, 0, 5, 3, 0, 0); // 与真实时区无关，hour/minute 由参数给定
  let last = null;
  let maxDuringRun = 0;
  for (let index = 0; index < 50; index += 1) {
    last = runTurn(store, start + index * MINUTE_MS, 11, index, '帮我查下明天天气');
    const target = targetFor({ baseline: BASE_50, hour: 11, minute: index, quiet: false });
    maxDuringRun = Math.max(maxDuringRun, maxDeviation(last.state, target));
  }

  const atStart = targetFor({ baseline: BASE_50, hour: 11, minute: 0, quiet: false });
  const atEnd = targetFor({ baseline: BASE_50, hour: 11, minute: 49, quiet: false });
  const deviationAtStart = maxDeviation(last.state, atStart);
  const deviationAtEnd = maxDeviation(last.state, atEnd);
  t.diagnostic(`50 条后：末轮 ${JSON.stringify({
    pleasure: last.state.pleasure,
    arousal: last.state.arousal,
    dominance: last.state.dominance,
    energy: last.state.energy,
  })}；逐轮相对当轮目标最大偏差 ${maxDuringRun.toFixed(3)}，`
    + `相对 11:00 目标 ${deviationAtStart.toFixed(3)}，相对 11:49 目标 ${deviationAtEnd.toFixed(3)}`);

  assert.ok(maxDuringRun <= 2, `逐轮最大偏差 ${maxDuringRun} 超过 ±2`);
  for (const dim of DIMENSIONS) {
    assert.ok(
      Math.abs(last.state[dim] - atStart[dim]) <= 2,
      `${dim} 相对 11:00 目标偏差 ${last.state[dim] - atStart[dim]} 超过 ±2`,
    );
    assert.ok(
      Math.abs(last.state[dim] - atEnd[dim]) <= 2,
      `${dim} 相对 11:49 目标偏差 ${last.state[dim] - atEnd[dim]} 超过 ±2`,
    );
  }
  // 中性文本不应产生非 ambient 事件（漂移不是靠事件掩掉的）。
  assert.ok(store.events.every((event) => event.type === 'ambient'));
});

test('V50-H1 复现：02:00 quiet 连发 30 条「嗯」，energy 不归零、pleasure 不塌陷', (t) => {
  const store = makeMemoryStore();
  const start = Date.UTC(2026, 0, 5, 18, 0, 0);
  let last = null;
  let maxDuringRun = 0;
  for (let index = 0; index < 30; index += 1) {
    last = runTurn(store, start + index * MINUTE_MS, 2, index, '嗯', true);
    const target = targetFor({ baseline: BASE_50, hour: 2, minute: index, quiet: true });
    maxDuringRun = Math.max(maxDuringRun, maxDeviation(last.state, target));
  }
  t.diagnostic(`02:00 quiet 30 条后：${JSON.stringify({
    pleasure: last.state.pleasure,
    arousal: last.state.arousal,
    dominance: last.state.dominance,
    energy: last.state.energy,
  })}；逐轮最大偏差 ${maxDuringRun.toFixed(3)}`);
  assert.ok(maxDuringRun <= 2);
  assert.ok(last.state.energy > 0);
  assert.ok(last.state.pleasure > 10);
});

test('V50-H1：跨日 72 小时循环（每小时一条）任何一维不越 0/100', (t) => {
  const store = makeMemoryStore();
  const start = Date.UTC(2026, 0, 5, 0, 0, 0);
  const min = Object.fromEntries(DIMENSIONS.map((dim) => [dim, Infinity]));
  const max = Object.fromEntries(DIMENSIONS.map((dim) => [dim, -Infinity]));

  for (let index = 0; index < 72; index += 1) {
    const hour = index % 24;
    const quiet = hour >= 23 || hour < 7;
    const result = runTurn(store, start + index * HOUR_MS, hour, 0, '嗯', quiet);
    for (const dim of DIMENSIONS) {
      const value = result.state[dim];
      assert.ok(value > 0 && value < 100, `第 ${index} 小时 ${dim}=${value} 越界`);
      min[dim] = Math.min(min[dim], value);
      max[dim] = Math.max(max[dim], value);
    }
  }
  t.diagnostic(`72 小时四维极值：min=${JSON.stringify(min)} max=${JSON.stringify(max)}`);
});

test('V50-H1：事件推高 pleasure 后推进一个半衰期，与 target 的距离减半（±2）', (t) => {
  const store = makeMemoryStore();
  const start = Date.UTC(2026, 0, 5, 8, 0, 0);
  const target = targetFor({ baseline: BASE_50, hour: 16, minute: 0, quiet: false });

  const first = runTurn(store, start, 16, 0, '谢谢你');
  assert.equal(first.event.type, 'thanks');
  const before = Math.abs(first.state.pleasure - target.pleasure);
  assert.ok(before > 3, `事件应先拉开距离（实际 ${before}）`);

  const second = runTurn(store, start + 6 * HOUR_MS, 16, 0, '');
  const after = Math.abs(second.state.pleasure - target.pleasure);
  t.diagnostic(`半衰期前距离 ${before.toFixed(3)}，后半衰期距离 ${after.toFixed(3)}，误差 ${Math.abs(after - before / 2).toFixed(3)}`);
  assert.ok(Math.abs(after - before / 2) <= 2, `距离 ${after} 未在半衰期内减半（起点 ${before}）`);
});

test('V50-H1：衰减朝 target 回归；缺省 target 时仍朝 baseline（向后兼容）', () => {
  // 由 decay 的既有用例覆盖缺省路径；这里确认 target 是独立锚点。
  const store = makeMemoryStore();
  const now = Date.UTC(2026, 0, 5, 0, 0, 0);
  store.setEmotionState('main', { ...BASE_50, updatedAt: now - 6 * HOUR_MS });
  const result = runTurn(store, now, 16, 0, '');
  const target = targetFor({ baseline: BASE_50, hour: 16, minute: 0, quiet: false });
  for (const dim of DIMENSIONS) {
    assert.ok(Math.abs(result.state[dim] - target[dim]) < 1e-6);
  }
});

// ---------------------------------------------------------------- V50-M1

test('V50-M1：你好烦判 blame，今天加班好累判 vent，置信度 > 0', () => {
  const blame = classify('你好烦');
  const vent = classify('今天加班好累');
  assert.equal(blame.type, 'blame');
  assert.equal(vent.type, 'vent');
  assert.notEqual(blame.type, vent.type);
  assert.ok(blame.confidence > 0 && vent.confidence > 0);
});

test('V50-M1：混合句「今天加班好累，你也不容易」判 vent', () => {
  assert.equal(classify('今天加班好累，你也不容易').type, 'vent');
  // 「你」不是充分条件：问她累不累仍不算 vent。
  assert.notEqual(classify('你这几天累不累').type, 'vent');
});

test('V50-M1：同一基线分别经过 blame / vent，注入文本不同且 vent 体现关心', (t) => {
  const at = Date.UTC(2026, 0, 5, 8, 0, 0);
  const blameRun = runTurn(makeMemoryStore(), at, 16, 0, '你好烦');
  const ventRun = runTurn(makeMemoryStore(), at, 16, 0, '今天加班好累');

  t.diagnostic(`blame 注入句：${blameRun.line}；vent 注入句：${ventRun.line}`);
  assert.equal(blameRun.event.type, 'blame');
  assert.equal(ventRun.event.type, 'vent');
  // 16:00 中性目标 = 基线；直接比较事件后的实际落差。
  const blameDrop = BASE_50.pleasure - blameRun.state.pleasure;
  const ventDrop = BASE_50.pleasure - ventRun.state.pleasure;
  t.diagnostic(`blame 使 pleasure 降 ${blameDrop.toFixed(3)}；vent 降 ${ventDrop.toFixed(3)}`);
  assert.ok(blameDrop >= 6 && blameDrop <= 8, `blame 的 pleasure 落差 ${blameDrop} 不在 6–8`);
  assert.ok(ventDrop >= 1 && ventDrop <= 2, `vent 的 pleasure 落差 ${ventDrop} 不在 1–2`);
  assert.ok(ventRun.state.dominance >= BASE_50.dominance, 'vent 不应压低 dominance');
  assert.ok(ventRun.state.energy >= BASE_50.energy, 'vent 不应压低 energy');
  assert.notEqual(blameRun.line, ventRun.line, '两种事件的注入句必须不同');
  assert.match(blameRun.line, /扎|委屈|赌气/u);
  assert.match(ventRun.line, /心|累|陪/u, `vent 句应体现关心：${ventRun.line}`);
  assert.doesNotMatch(ventRun.line, /赌气|委屈|扎|责备|烦/u, `vent 句不应含责备：${ventRun.line}`);

  // 直接把事件类型交给 describe 也成立（用运行后的状态，档位与注入时一致）。
  assert.equal(describe(blameRun.state, { eventType: 'blame' }), blameRun.line);
  assert.equal(describe(ventRun.state, { eventType: 'vent' }), ventRun.line);
});

test('V50-M1：describe 不传第二参时与旧行为完全一致', () => {
  const samples = [];
  for (const pleasure of [100, 65, 60, 45, 40, 35, 20, 0]) {
    for (const energy of [100, 65, 50, 45, 20, 0]) {
      samples.push({
        pleasure, arousal: 50, dominance: 50, energy,
      });
    }
  }
  assert.equal(new Set(samples.map((state) => describe(state))).size, 12);
  for (const state of samples) {
    assert.equal(describe(state), describe(state, undefined));
    assert.equal(describe(state), describe(state, null));
    assert.equal(describe(state), describe(state, { eventType: 'share' }));
    assert.equal(describe(state), describe(state, { eventType: 'ambient' }));
  }
  assert.throws(() => describe({ ...BASE_50 }, 'vent'), TypeError);
  assert.throws(() => describe({ ...BASE_50 }, ['vent']), TypeError);
});

// ---------------------------------------------------------------- 规则可达性

const TRIGGERS = Object.freeze({
  greeting: ['你好', '早上好'],
  care: ['你怎么了', '别太累，注意身体'],
  share: ['我刚做了饭', '我跟你说个事'],
  thanks: ['谢谢你', '感谢你一直陪我'],
  reassure: ['你是不是很烦我', '我烦你了吗'],
  cold: ['随便', '行吧'],
  reunion: ['好久不见', '这段时间你去哪了'],
  goodnight: ['晚安', '我先睡了'],
  conflict: ['你错了', '别管我'],
  blame: ['你好烦', '你真讨厌'],
  vent: ['今天加班好累', '我最近压力大'],
  comfort: ['抱抱', '别难过，我在'],
});

const NEUTRAL = Object.freeze(['帮我查下明天天气', '现在几点', '好的']);

test('规则可达性：EVENT_TYPES 每一类至少一句能触发（type + 置信度 > 0）', () => {
  assert.deepEqual([...EVENT_TYPES].sort(), Object.keys(TRIGGERS).sort());
  for (const type of EVENT_TYPES) {
    const sentences = TRIGGERS[type];
    assert.ok(Array.isArray(sentences) && sentences.length >= 1, `${type} 缺少触发句`);
    for (const sentence of sentences) {
      const result = classify(sentence);
      assert.equal(result.type, type, `「${sentence}」应判 ${type}，实际 ${result.type}`);
      assert.ok(result.confidence > 0, `「${sentence}」置信度应 > 0`);
    }
  }
});

test('规则可达性：常见中性句不触发任何事件类型', () => {
  for (const type of EVENT_TYPES) {
    for (const sentence of NEUTRAL) {
      const result = classify(sentence);
      // share 同时是无命中兜底类型；「不触发」以置信度 > 0 为准。
      assert.equal(result.type === type && result.confidence > 0, false, `「${sentence}」不应触发 ${type}`);
    }
  }
  for (const sentence of NEUTRAL) {
    assert.deepEqual(classify(sentence), { type: 'none', confidence: 0 }, sentence);
  }
});
