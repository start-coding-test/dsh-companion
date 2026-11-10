/**
 * v0.5.2 情绪分类与增量递减的验收测试（V52 清单）。
 *
 * 覆盖：
 * - V51-L1 增量递减：连续 10 次「你好烦」后 pleasure ≥ 15；连续 10 次被夸奖后 pleasure ≤ 90；
 *   单次事件在基线上的增量与 v0.5.1 相差不超过 30%；
 * - 分不出来（同一句对她的负面与正面并存）：只记录一条事件、deltas 全零、状态不动；
 * - 新增 reassure：用户在担心「是不是惹到她」→ 被在意，愉悦小升；
 * - 无事件（none）：不写 emotion_events、状态只受环境项影响。
 *
 * 全部使用固定时钟与临时库，不读真实时间。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Store } from '../src/memory/store.js';
import {
  REASSURE_SENTENCES,
  applyEvent,
  createState,
} from '../src/persona/emotion.js';
import { AMBIGUOUS_CONFIDENCE, intensityFor, runEmotionTurn } from '../src/persona/emotion-wiring.js';
import { classify } from '../src/persona/emotion-classify.js';

const MINUTE_MS = 60_000;
const T0 = 1_764_000_000_000; // 固定基准时刻（2025-11-24T…Z），不依赖真实时间
const BASELINE_50 = Object.freeze({ pleasure: 50, arousal: 50, dominance: 50, energy: 50 });

/** 打开一个临时库；`close()` 关库并删目录。 */
function openTempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'emotion-v052-'));
  const store = Store.open(join(dir, 'companion.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const CARD = Object.freeze({
  name: '珞然',
  emotion: Object.freeze({ enabled: true, baseline: BASELINE_50, halfLifeHours: 6 }),
});

/**
 * 连发同一条文本，每 2 分钟一轮，返回最后一轮结果。
 * @param {object} store
 * @param {string} text
 * @param {number} times
 */
function repeatTurns(store, text, times) {
  let last = null;
  for (let index = 0; index < times; index += 1) {
    last = runEmotionTurn({
      store,
      card: CARD,
      now: T0 + index * 2 * MINUTE_MS,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text,
    });
  }
  return last;
}

test('V51-L1：连续 10 次「你好烦」后 pleasure 仍 ≥ 15（不会贴 0）', () => {
  const { store, close } = openTempStore();
  try {
    const last = repeatTurns(store, '你好烦', 10);
    assert.ok(last.state.pleasure >= 15, `pleasure=${last.state.pleasure}`);
    assert.ok(last.state.pleasure < 50, '应当确实降低');
    assert.equal(store.countEmotionEvents('main'), 10);
  } finally {
    close();
  }
});

test('V51-L1：连续 10 次被夸奖后 pleasure 仍 ≤ 90（不会贴 100）', () => {
  const { store, close } = openTempStore();
  try {
    const last = repeatTurns(store, '谢谢你', 10);
    assert.ok(last.state.pleasure <= 90, `pleasure=${last.state.pleasure}`);
    assert.ok(last.state.pleasure > 50, '应当确实抬高');
  } finally {
    close();
  }
});

test('V51-L1：单次事件在基线上的增量与 v0.5.1 相差不超过 30%', () => {
  const state = createState({ nowMs: T0, baseline: BASELINE_50 });
  // 与 v0.5.1 相同：intensity = 0.5 + confidence，本处取最典型的 blame（0.74）。
  const intensity = intensityFor(0.74);
  const withHistory = applyEvent(state, {
    type: 'blame',
    intensity,
    nowMs: T0,
    hour: 16,
    minute: 0,
    baseline: BASELINE_50,
    history: [],
  });
  const baselineDelta = -6.4 * intensity; // v0.5.1 的规则增量
  const actual = withHistory.event.deltas.pleasure;
  const ratio = Math.abs(actual - baselineDelta) / Math.abs(baselineDelta);
  assert.ok(ratio <= 0.3, `actual=${actual} baseline=${baselineDelta} ratio=${ratio}`);
});

test('增量递减：10 分钟内的第 2 次同类事件增量明显小于第 1 次', () => {
  const state = createState({ nowMs: T0, baseline: BASELINE_50 });
  const first = applyEvent(state, {
    type: 'blame', intensity: 1.24, nowMs: T0, hour: 16, minute: 0, baseline: BASELINE_50, history: [],
  });
  const second = applyEvent(first.state, {
    type: 'blame',
    intensity: 1.24,
    nowMs: T0 + MINUTE_MS,
    hour: 16,
    minute: 0,
    baseline: BASELINE_50,
    history: [{ at: T0, type: 'blame' }],
  });
  assert.ok(Math.abs(second.event.deltas.pleasure) < Math.abs(first.event.deltas.pleasure));
});

test('分不出来：对她的负面与正面并存时只记录、deltas 全零、状态不动', () => {
  const { store, close } = openTempStore();
  try {
    const classified = classify('谢谢你，不过你好烦', { name: '珞然' });
    assert.ok(classified.confidence < AMBIGUOUS_CONFIDENCE, String(classified.confidence));

    const result = runEmotionTurn({
      store,
      card: CARD,
      now: T0,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '谢谢你，不过你好烦',
    });
    // 冷启动时状态从目标起步，事件只记录、不产生增量。
    assert.deepEqual(result.event.deltas, { pleasure: 0, arousal: 0, dominance: 0, energy: 0 });
    assert.equal(result.state.pleasure, 50);
    assert.equal(store.countEmotionEvents('main'), 1);
  } finally {
    close();
  }
});

test('reassure：用户在担心惹到她时，情绪回暖并给出安抚句', () => {
  const { store, close } = openTempStore();
  try {
    const result = runEmotionTurn({
      store,
      card: CARD,
      now: T0,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '你是不是很烦我',
    });
    assert.equal(result.event.type, 'reassure');
    assert.ok(result.state.pleasure > 50, `pleasure=${result.state.pleasure}`);
    assert.ok(REASSURE_SENTENCES.includes(result.line), result.line);
    assert.ok(!/[0-9]/u.test(result.line));
  } finally {
    close();
  }
});

test('none：普通提醒不产生事件、不写 emotion_events', () => {
  const { store, close } = openTempStore();
  try {
    const result = runEmotionTurn({
      store,
      card: CARD,
      now: T0,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '哦对了，明天提醒我开会',
    });
    assert.equal(result.event, null);
    assert.equal(store.countEmotionEvents('main'), 0);
    assert.equal(result.state.pleasure, 50);
  } finally {
    close();
  }
});

test('对象判定：卡里的名字由 options.name 传入，接线时用卡名而不是写死', () => {
  const { store, close } = openTempStore();
  try {
    const withCard = runEmotionTurn({
      store,
      card: CARD,
      now: T0,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '珞然真讨厌',
    });
    assert.equal(withCard.event.type, 'blame');
  } finally {
    close();
  }
});
