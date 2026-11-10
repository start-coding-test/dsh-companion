/**
 * P3-c 情绪接线测试：内核 applyDeltas、卡归一化、接线算法、pre-step 注入、
 * /状态 行、遗忘重置、重启保持。
 *
 * 全部使用固定时钟（TEST_NOW），不读真实时间；三时区（默认/UTC/New_York）
 * 结果一致。平台相关用例走 FakeCtx + apply，临时库只落 os.tmpdir()。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Store } from '../src/memory/store.js';
import { forgetMemory } from '../src/memory/forget.js';
import {
  DEFAULT_CARD,
  normalizeCardEmotion,
  parseCardSourceDetailed,
} from '../src/persona/card.js';
import {
  DEFAULT_BASELINE,
  applyDeltas,
  createState,
  describe,
} from '../src/persona/emotion.js';
import {
  EMOTION_PROMPT_PREFIX,
  EMOTION_SOURCE_KIND,
  QUIET_ENERGY_DELTA,
  intensityFor,
  runEmotionTurn,
} from '../src/persona/emotion-wiring.js';
import { formatRelativeTimeCn, handleCommand } from '../src/runtime/commands.js';
import { apply as applyCordis } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, seedMemory, TEST_NOW } from './e2e/helpers.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** 四维都取 50 的测试基线，便于算「向基线走一半」。 */
const BASELINE_50 = Object.freeze({
  pleasure: 50,
  arousal: 50,
  dominance: 50,
  energy: 50,
});

/** @param {object} [overrides] */
function cardWithEmotion(overrides = {}) {
  return {
    emotion: {
      enabled: true,
      baseline: { ...BASELINE_50 },
      halfLifeHours: 6,
      ...overrides,
    },
  };
}

/** @returns {object} */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** @returns {object} */
function turnPayload(session, turnId, messages) {
  return {
    agent: { id: session.id, session },
    messages,
    turn: { id: turnId },
    step: 1,
  };
}

/** @param {FakeCtx} ctx @param {object} session @param {object} message */
function appendMessage(ctx, session, message) {
  ctx.emitSessionEvent(session.id, { type: 'user/message', data: message });
}

/** @param {number} [now] */
function makePluginCtx(now = TEST_NOW) {
  const ctx = new FakeCtx({ now, strict: true });
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  return ctx;
}

/** 把 DSH_HOME 指到临时目录，测试结束恢复，绝不动真实 ~/.dsh。 */
function useTempDshHome(t, dir) {
  const previous = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
    ? process.env.DSH_HOME
    : undefined;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
}

/** @param {string} dir @returns {string} 启用了情绪的人格卡路径 */
function writeEnabledCard(dir) {
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 6,
  };
  const path = join(dir, 'persona.json');
  writeFileSync(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

// ---------------------------------------------------------------- 内核

test('applyDeltas：缺失维按 0、夹取 0–100、round2、updatedAt 不变', () => {
  const state = createState({ nowMs: TEST_NOW, baseline: BASELINE_50 });
  const next = applyDeltas(state, { pleasure: 10, energy: -3 }, BASELINE_50);
  assert.equal(next.pleasure, 60);
  assert.equal(next.arousal, 50);
  assert.equal(next.dominance, 50);
  assert.equal(next.energy, 47);
  assert.equal(next.updatedAt, TEST_NOW);

  const clamped = applyDeltas({ ...state, pleasure: 99, energy: 1 }, { pleasure: 10, energy: -10 }, BASELINE_50);
  assert.equal(clamped.pleasure, 100);
  assert.equal(clamped.energy, 0);
  assert.ok(clamped.energy >= 0 && clamped.energy <= 100);
});

test('applyDeltas：deltas 非对象/含非有限数抛 TypeError', () => {
  const state = createState({ nowMs: TEST_NOW, baseline: BASELINE_50 });
  assert.throws(() => applyDeltas(state, null), TypeError);
  assert.throws(() => applyDeltas(state, []), TypeError);
  assert.throws(() => applyDeltas(state, { pleasure: Number.NaN }), TypeError);
  assert.throws(() => applyDeltas(state, { arousal: '1' }), TypeError);
});

test('intensityFor：置信度映射单调且夹在 [0.5, 1.5]', () => {
  assert.equal(intensityFor(0.62), 1.12);
  assert.equal(intensityFor(0.8), 1.3);
  assert.equal(intensityFor(0.95), 1.45);
  assert.equal(intensityFor(0), 0.5);
  assert.equal(intensityFor(9), 1.5);
  assert.ok(intensityFor(0.7) > intensityFor(0.62));
});

// ---------------------------------------------------------------- 卡归一化

test('normalizeCardEmotion：合法值原样保留；非法值逐项回落并给 warning code', () => {
  const valid = normalizeCardEmotion({
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 24,
  });
  assert.deepEqual(valid.emotion, {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 24,
  });
  assert.deepEqual(valid.warnings, []);

  const invalid = normalizeCardEmotion({
    enabled: 'yes',
    baseline: { pleasure: 101 },
    halfLifeHours: 0,
  });
  assert.equal(invalid.emotion.enabled, false);
  assert.deepEqual(invalid.emotion.baseline, DEFAULT_BASELINE);
  assert.equal(invalid.emotion.halfLifeHours, 6);
  assert.deepEqual(
    invalid.warnings.map((warning) => warning.code),
    ['emotion_enabled_invalid', 'emotion_baseline_invalid', 'emotion_half_life_invalid'],
  );
});

test('parseCardSourceDetailed：非法 emotion 不再让整张卡加载失败，warning 进入现有通道', () => {
  const source = structuredClone(DEFAULT_CARD);
  source.emotion = { enabled: 'yes', baseline: { pleasure: 101 }, halfLifeHours: 500 };
  const parsed = parseCardSourceDetailed(JSON.stringify(source), '/tmp/persona.json');
  assert.equal(parsed.card.emotion.enabled, false);
  assert.deepEqual(parsed.card.emotion.baseline, DEFAULT_BASELINE);
  assert.equal(parsed.card.emotion.halfLifeHours, 6);
  const codes = parsed.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('emotion_enabled_invalid'));
  assert.ok(codes.includes('emotion_baseline_invalid'));
  assert.ok(codes.includes('emotion_half_life_invalid'));
});

// ---------------------------------------------------------------- 接线算法

test('quiet=true：energy 的 deltas 比 quiet=false 少 3，且不越 0–100', () => {
  const temp = makeTempStore();
  try {
    const store = temp.store;
    const card = cardWithEmotion();
    const seed = () => store.setEmotionState('main', {
      ...BASELINE_50,
      updatedAt: TEST_NOW,
    });

    seed();
    const loud = runEmotionTurn({
      store,
      card,
      now: TEST_NOW,
      hour: 12,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '',
    });

    store.resetEmotion('main');
    seed();
    const quiet = runEmotionTurn({
      store,
      card,
      now: TEST_NOW,
      hour: 12,
      minute: 0,
      quiet: true,
      scope: 'main',
      text: '',
    });

    assert.equal(
      quiet.event.deltas.energy,
      loud.event.deltas.energy + QUIET_ENERGY_DELTA,
      '安静时段应额外 −3 energy',
    );
    assert.equal(quiet.state.energy, loud.state.energy - 3);
    for (const value of [loud.state.energy, quiet.state.energy]) {
      assert.ok(value >= 0 && value <= 100);
    }
  } finally {
    temp.cleanup();
  }
});

test('衰减：6 小时前的状态注入后四维各向基线走一半，事件表新增一行', () => {
  const temp = makeTempStore();
  try {
    const store = temp.store;
    store.setEmotionState('main', {
      pleasure: 80,
      arousal: 20,
      dominance: 80,
      energy: 20,
      updatedAt: TEST_NOW - 6 * HOUR_MS,
    });
    const before = store.countEmotionEvents('main');
    const result = runEmotionTurn({
      store,
      card: cardWithEmotion(),
      now: TEST_NOW,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '',
    });

    // 基线 50：(80/20) 向 50 走一半 → 65/35，容差 1e-6。
    const expected = { pleasure: 65, arousal: 35, dominance: 65, energy: 35 };
    for (const dim of Object.keys(expected)) {
      assert.ok(
        Math.abs(result.state[dim] - expected[dim]) < 1e-6,
        `${dim}: ${result.state[dim]} != ${expected[dim]}`,
      );
    }
    assert.equal(result.changed, true);
    assert.equal(result.event.type, 'ambient');
    assert.equal(store.countEmotionEvents('main'), before + 1);
    assert.equal(store.getEmotionState('main').updatedAt, TEST_NOW);
  } finally {
    temp.cleanup();
  }
});

test('事件命中：晚安文本产生 goodnight 事件，deltas 计入安静时段', () => {
  const temp = makeTempStore();
  try {
    const store = temp.store;
    const before = store.countEmotionEvents('main');
    const result = runEmotionTurn({
      store,
      card: cardWithEmotion(),
      now: TEST_NOW,
      hour: 22,
      minute: 30,
      quiet: true,
      scope: 'main',
      text: '晚安，今天先睡了',
    });
    assert.equal(result.event.type, 'goodnight');
    const [event] = store.listEmotionEvents('main', 1);
    assert.equal(event.type, 'goodnight');
    assert.equal(store.countEmotionEvents('main'), before + 1);
    assert.ok(result.event.deltas.energy < 0, '安静时段 + 深夜节律应压低 energy');
  } finally {
    temp.cleanup();
  }
});

test('重启保持：关掉 store 再打开同一库，state 与 updatedAt 仍在', () => {
  const temp = makeTempStore();
  try {
    const result = runEmotionTurn({
      store: temp.store,
      card: cardWithEmotion(),
      now: TEST_NOW,
      hour: 16,
      minute: 0,
      quiet: false,
      scope: 'main',
      text: '你好',
    });
    assert.ok(result.state);
    temp.store.close();

    const reopened = Store.open(temp.dbPath);
    try {
      const saved = reopened.getEmotionState('main');
      assert.ok(saved);
      assert.equal(saved.updatedAt, TEST_NOW);
      assert.equal(saved.pleasure, result.state.pleasure);
      assert.equal(saved.energy, result.state.energy);
    } finally {
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('忘掉：整条遗忘完成后 resetEmotion，getEmotionState 回到 null（口径）', () => {
  const temp = makeTempStore();
  try {
    const { factId } = seedMemory(temp.store, { now: TEST_NOW });
    temp.store.setEmotionState('main', { ...BASELINE_50, updatedAt: TEST_NOW });
    temp.store.appendEmotionEvent('main', {
      at: TEST_NOW,
      type: 'greeting',
      deltas: { pleasure: 1, arousal: 1, dominance: 1, energy: 1 },
    });

    const result = forgetMemory({
      store: temp.store,
      kind: 'fact',
      id: factId,
      at: TEST_NOW,
      logger: { warn() {} },
    });
    assert.equal(result.ok, true);
    assert.equal(temp.store.countEmotionEvents('main'), 0);
    assert.equal(temp.store.getEmotionState('main'), null, '忘掉后口径：无状态行（null）');
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- /状态

test('/状态：未启用输出「情绪：未启用」；旧调用方不传 emotion 时不出现该行', () => {
  const temp = makeTempStore();
  try {
    const disabled = handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      emotion: { enabled: false },
    });
    assert.match(disabled.reply, /^情绪：未启用$/mu);
    assert.doesNotMatch(disabled.reply, /未开始/u);

    const legacy = handleCommand({ text: '/状态', store: temp.store, now: TEST_NOW });
    assert.doesNotMatch(legacy.reply, /情绪：/u);
  } finally {
    temp.cleanup();
  }
});

test('/状态：启用后输出 describe + 最近三条中文相对时间；无状态显示未开始', () => {
  const temp = makeTempStore();
  try {
    const empty = handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      emotion: { enabled: true },
    });
    assert.match(empty.reply, /^情绪：未开始$/mu);

    const state = { ...BASELINE_50, updatedAt: TEST_NOW };
    temp.store.setEmotionState('main', state);
    temp.store.appendEmotionEvent('main', {
      at: TEST_NOW - 30 * HOUR_MS,
      type: 'goodnight',
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
    });
    temp.store.appendEmotionEvent('main', {
      at: TEST_NOW - 2 * HOUR_MS,
      type: 'share',
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
    });
    temp.store.appendEmotionEvent('main', {
      at: TEST_NOW - 5 * MINUTE_MS,
      type: 'greeting',
      deltas: { pleasure: 0, arousal: 0, dominance: 0, energy: 0 },
    });

    const enabled = handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      emotion: { enabled: true },
    });
    const line = enabled.reply.split('\n').find((item) => item.startsWith('情绪：'));
    assert.equal(
      line,
      `情绪：${describe(state)}（最近：问候 5 分钟前 / 分享 2 小时前 / 晚安 昨天）`,
    );
  } finally {
    temp.cleanup();
  }
});

test('formatRelativeTimeCn：刚刚 / 分钟 / 小时 / 昨天 / N 天前，非法输入空串', () => {
  assert.equal(formatRelativeTimeCn(TEST_NOW - 30_000, TEST_NOW), '刚刚');
  assert.equal(formatRelativeTimeCn(TEST_NOW - 5 * MINUTE_MS, TEST_NOW), '5 分钟前');
  assert.equal(formatRelativeTimeCn(TEST_NOW - 2 * HOUR_MS, TEST_NOW), '2 小时前');
  assert.equal(formatRelativeTimeCn(TEST_NOW - 30 * HOUR_MS, TEST_NOW, 'Asia/Shanghai'), '昨天');
  assert.equal(formatRelativeTimeCn(TEST_NOW - 3 * 24 * HOUR_MS, TEST_NOW, 'UTC'), '3 天前');
  assert.equal(formatRelativeTimeCn(Number.NaN, TEST_NOW), '');
  assert.equal(formatRelativeTimeCn(TEST_NOW, TEST_NOW, 'Not/AZone'), '');
});

// ---------------------------------------------------------------- pre-step

test('pre-step：默认未启用 → 不注入 companion-emotion，情绪表零行', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-home-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-disabled' });
  const message = userMessage('你好呀');
  appendMessage(ctx, session, message);
  const payload = turnPayload(session, 'turn-disabled', [message]);
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath });
  try {
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    const injected = (decision?.messages ?? [])
      .filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND);
    assert.equal(injected.length, 0, '默认路径不得注入情绪消息');
    assert.equal(ctx.contexts.length, 0, '默认路径不得注册情绪 context');
    assert.equal(ctx.callsOf('systemPrompt.context').length, 0);
    assert.equal(temp.store.getEmotionState('main'), null);
    assert.equal(temp.store.countEmotionEvents('main'), 0);
  } finally {
    handle.dispose();
  }
});

test('pre-step：启用后注册 context，provider 返回「你此刻：」文本（无数字/花括号），同一 turn 只算一次', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-home-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEnabledCard(home);

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-enabled' });
  const message = userMessage('你好，今天过得还不错');
  appendMessage(ctx, session, message);
  const payload = turnPayload(session, 'turn-enabled', [message]);
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    assert.equal(ctx.callsOf('systemPrompt.context').length, 1, '启用后必须注册一次 context');
    assert.equal(ctx.contexts.length, 1);
    const entry = ctx.contexts[0].context;
    assert.equal(entry.name, 'companion-emotion');
    assert.equal(entry.order, 320);
    assert.equal(entry.interpolate, false);

    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    const injected = (decision?.messages ?? [])
      .filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND);
    assert.equal(injected.length, 0, '不得再注入 companion-emotion 消息');

    const text = entry.text({ agent: payload.agent });
    assert.ok(text.startsWith(EMOTION_PROMPT_PREFIX), `实际文本：${text}`);
    assert.doesNotMatch(text, /[0-9]/u, '情绪文本不得含阿拉伯数字');
    assert.doesNotMatch(text, /[{}]/u, '情绪文本不得含花括号');

    const saved = temp.store.getEmotionState('main');
    assert.ok(saved, '启用后必须落库');
    assert.equal(saved.updatedAt, TEST_NOW);
    assert.equal(temp.store.countEmotionEvents('main'), 1);

    // 同一 turn 的下一步：不重算、不再写库；provider 文本保持不变。
    const secondPayload = {
      ...payload,
      step: 2,
      messages: [message],
    };
    await ctx.dispatch('agent/pre-step', secondPayload, {
      kind: 'enter',
      messages: secondPayload.messages,
    });
    assert.equal(entry.text({ agent: secondPayload.agent }), text, '同一 turn 不得重算');
    assert.equal(temp.store.countEmotionEvents('main'), 1);
  } finally {
    handle.dispose();
  }
});

test('pre-step：6 小时前的状态经计算后四维向基线走一半，事件表新增一行', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-home-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEnabledCard(home);

  temp.store.setEmotionState('main', {
    pleasure: 80,
    arousal: 20,
    dominance: 80,
    energy: 20,
    updatedAt: TEST_NOW - 6 * HOUR_MS,
  });
  const before = temp.store.countEmotionEvents('main');

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-decay' });
  const message = userMessage('嗯嗯');
  appendMessage(ctx, session, message);
  const payload = turnPayload(session, 'turn-decay', [message]);
  // 曼谷 UTC+7：TEST_NOW=09:00Z → 本地 16:00，节律四维恰为 0，隔离出衰减。
  const handle = applyCordis(strictCtx(ctx), {
    dbPath: temp.dbPath,
    persona: { cardPath },
    timezone: 'Asia/Bangkok',
  });
  try {
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    assert.equal(
      (decision?.messages ?? []).filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND).length,
      0,
      '不得再注入 companion-emotion 消息',
    );
    const text = ctx.contexts[0].context.text({ agent: payload.agent });
    assert.ok(text.startsWith(EMOTION_PROMPT_PREFIX), `实际文本：${text}`);

    const saved = temp.store.getEmotionState('main');
    const expected = { pleasure: 65, arousal: 35, dominance: 65, energy: 35 };
    for (const dim of Object.keys(expected)) {
      assert.ok(
        Math.abs(saved[dim] - expected[dim]) < 1e-6,
        `${dim}: ${saved[dim]} != ${expected[dim]}`,
      );
    }
    assert.equal(saved.updatedAt, TEST_NOW);
    assert.equal(temp.store.countEmotionEvents('main'), before + 1);
  } finally {
    handle.dispose();
  }
});

test('pre-step：子代理会话不注入、不写情绪状态', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-home-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEnabledCard(home);

  const ctx = makePluginCtx();
  const session = ctx.addSession({
    id: 'session-subagent',
    header: { origin: 'subagent' },
  });
  const message = userMessage('帮我查一下资料');
  appendMessage(ctx, session, message);
  const payload = turnPayload(session, 'turn-sub', [message]);
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    // adapter 会把 base（payload.messages）合并回来；子代理的关键是「没有情绪注入」。
    const injected = (decision?.messages ?? [])
      .filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND);
    assert.equal(injected.length, 0, '子代理不应注入情绪消息');
    assert.equal(ctx.contexts.length, 1, '启用时 context 仍只注册一次');
    assert.equal(
      ctx.contexts[0].context.text({ agent: payload.agent }),
      '',
      '子代理的 provider 必须返回空串',
    );
    assert.equal(temp.store.getEmotionState('main'), null);
    assert.equal(temp.store.countEmotionEvents('main'), 0);
  } finally {
    handle.dispose();
  }
});
