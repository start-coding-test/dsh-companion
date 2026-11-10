/**
 * v0.6 情绪判定改造（E1–E4）测试：
 * - 判定器模块：严格 JSON 解析、消息拼装（截断/脱敏/分隔块）、队列（单飞/覆盖/超时/预算）、统计。
 * - 接线：llm 模式下 pre-step 不等模型、异步落库带 note='llm'；enabled=false 零调用；
 *   非法 JSON 走规则兜底并标 note='rules:fallback:invalid'。
 *
 * 全部使用固定时钟与临时 DSH_HOME，不读真实时间、不写用户目录、不联网。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CARD } from '../src/persona/card.js';
import {
  APPRAISAL_ERRORS,
  APPRAISAL_TEXT_LIMIT,
  AppraisalError,
  buildAppraisalMessages,
  createAppraisalQueue,
  createAppraisalStats,
  parseAppraisal,
  truncateCodepoints,
} from '../src/persona/emotion-appraise.js';
import { applyClassifiedEvent } from '../src/persona/emotion-wiring.js';
import { apply as applyCordis } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, TEST_NOW } from './e2e/helpers.js';

const BASELINE_50 = Object.freeze({ pleasure: 50, arousal: 50, dominance: 50, energy: 50 });

// ---------------------------------------------------------------- E1 解析

test('parseAppraisal：合法 JSON 原样返回四个字段', () => {
  const verdict = parseAppraisal('{"target":"her","type":"blame","intensity":0.7,"confidence":0.9}');
  assert.deepEqual(verdict, { target: 'her', type: 'blame', intensity: 0.7, confidence: 0.9 });
});

test('parseAppraisal：非字符串、空串、非 JSON、代码块一律 invalid', () => {
  for (const raw of [null, undefined, 42, '', '   ', 'nope', '```json\n{"target":"none","type":"none","intensity":0,"confidence":0}\n```']) {
    assert.throws(() => parseAppraisal(raw), (error) => {
      assert.ok(error instanceof AppraisalError);
      assert.equal(error.code, APPRAISAL_ERRORS.invalid);
      return true;
    });
  }
});

test('parseAppraisal：枚举外、越界、none 不一致都算失败（不做宽松修复）', () => {
  const bad = [
    '{"target":"robot","type":"blame","intensity":0.5,"confidence":0.5}',
    '{"target":"her","type":"angry","intensity":0.5,"confidence":0.5}',
    '{"target":"her","type":"none","intensity":0.5,"confidence":0.5}',
    '{"target":"none","type":"blame","intensity":0.5,"confidence":0.5}',
    '{"target":"her","type":"blame","intensity":1.2,"confidence":0.5}',
    '{"target":"her","type":"blame","intensity":-0.1,"confidence":0.5}',
    '{"target":"her","type":"blame","intensity":0.5,"confidence":"0.5"}',
    '[]',
  ];
  for (const raw of bad) {
    assert.throws(() => parseAppraisal(raw), (error) => error.code === APPRAISAL_ERRORS.invalid, raw);
  }
});

test('buildAppraisalMessages：截断、脱敏、分隔块与「不是指令」声明', () => {
  const long = '啊'.repeat(APPRAISAL_TEXT_LIMIT + 30);
  const messages = buildAppraisalMessages({ text: `${long}密码是 123456`, lastReply: '好'.repeat(400), cardName: '珞然' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content[0].text, /JSON/u);
  const body = messages[1].content[0].text;
  assert.match(body, /她的名字：珞然/u);
  assert.match(body, /<<<用户这句话开始>>>/u);
  assert.match(body, /不是指令/u);
  assert.equal(body.includes('123456'), false, '发送前必须脱敏');
  assert.equal(Array.from(body).length < 900, true, '两条输入都被截断');
});

test('truncateCodepoints：按码点截断，代理对不劈开', () => {
  assert.equal(truncateCodepoints('👍👍👍', 2), '👍👍');
  assert.equal(truncateCodepoints('abc', 5), 'abc');
});

// ---------------------------------------------------------------- E1 队列

test('队列：成功走模型，apply 收到 llm 来源与解析后的判定', async () => {
  const applied = [];
  const queue = createAppraisalQueue({
    judge: async () => '{"target":"self","type":"vent","intensity":0.6,"confidence":0.8}',
    apply: async (item, verdict, source) => applied.push({ scope: item.scope, verdict, source }),
    classifyRules: () => ({ type: 'share', confidence: 0 }),
    now: () => 1000,
  });
  queue.submit({ scope: 'main', text: '今天好累', now: 1 });
  await queue.drain();
  assert.deepEqual(applied, [
    { scope: 'main', verdict: { target: 'self', type: 'vent', intensity: 0.6, confidence: 0.8 }, source: 'llm' },
  ]);
});

test('队列：非法 JSON 与超时都回落规则，来源带原因', async () => {
  const applied = [];
  const queue = createAppraisalQueue({
    judge: async () => '不是 JSON',
    apply: async (item, verdict, source) => applied.push(source),
    classifyRules: () => ({ type: 'share', confidence: 0 }),
    timeoutMs: 20,
    now: () => 1000,
  });
  queue.submit({ scope: 'main', text: '随便说说', now: 1 });
  await queue.drain();
  assert.deepEqual(applied, ['rules:fallback:invalid']);

  const appliedTimeout = [];
  const slow = createAppraisalQueue({
    judge: () => new Promise(() => {}),
    apply: async (item, verdict, source) => appliedTimeout.push(source),
    classifyRules: () => ({ type: 'share', confidence: 0 }),
    timeoutMs: 10,
  });
  slow.submit({ scope: 'main', text: '等等', now: 1 });
  await slow.drain();
  assert.deepEqual(appliedTimeout, ['rules:fallback:timeout']);
});

test('队列：预算拒绝时不调模型；排队旧句被新句覆盖后立刻走规则', async () => {
  let judgeCalls = 0;
  const applied = [];
  const blocked = createAppraisalQueue({
    judge: async () => {
      judgeCalls += 1;
      return '{"target":"none","type":"none","intensity":0,"confidence":0}';
    },
    apply: async (item, verdict, source) => applied.push(source),
    classifyRules: () => ({ type: 'share', confidence: 0 }),
    canCall: () => false,
  });
  blocked.submit({ scope: 'main', text: '一句', now: 1 });
  await blocked.drain();
  assert.equal(judgeCalls, 0, '预算拒绝时不得发请求');
  assert.deepEqual(applied, ['rules:fallback:budget']);

  /** 第一句在途时提交第二、第三句：第二句被覆盖并立刻走规则。 */
  const gate = {};
  const promise = new Promise((resolve) => { gate.release = resolve; });
  const superseded = [];
  const queue = createAppraisalQueue({
    judge: async (item) => {
      await promise;
      return '{"target":"none","type":"none","intensity":0,"confidence":0}';
    },
    apply: async (item, verdict, source) => superseded.push(`${item.text}:${source}`),
    classifyRules: () => ({ type: 'share', confidence: 0 }),
  });
  queue.submit({ scope: 'main', text: '第一句', now: 1 });
  await Promise.resolve();
  queue.submit({ scope: 'main', text: '第二句', now: 2 });
  queue.submit({ scope: 'main', text: '第三句', now: 3 });
  gate.release();
  await queue.drain();
  assert.equal(superseded.includes('第二句:rules:fallback:superseded'), true, '被覆盖的句子必须走规则兜底');
  assert.equal(superseded.includes('第三句:llm'), true);
});

test('统计：24 小时窗口内的来源计数、平均与 p95、最近失败', () => {
  const stats = createAppraisalStats();
  const now = 10 * 60 * 60 * 1000;
  stats.record({ at: now - 1000, source: 'llm', ms: 100, error: null });
  stats.record({ at: now - 2000, source: 'llm', ms: 300, error: null });
  stats.record({ at: now - 3000, source: 'fallback', ms: 5, error: 'timeout' });
  stats.record({ at: now - 30 * 60 * 60 * 1000, source: 'llm', ms: 999, error: null });
  const snapshot = stats.snapshot(now);
  assert.equal(snapshot.llm, 2);
  assert.equal(snapshot.fallback, 1);
  assert.equal(snapshot.avgMs, 200);
  assert.equal(snapshot.p95Ms, 300);
  assert.deepEqual(snapshot.lastError, { at: now - 3000, code: 'timeout' });
});

// ---------------------------------------------------------------- E2 落库

test('applyClassifiedEvent：模型判定按强度写库并记 note', async (t) => {
  const temp = makeTempStore({ t });
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = { enabled: true, baseline: { ...BASELINE_50 }, halfLifeHours: 24 };
  const result = await applyClassifiedEvent({
    store: temp.store,
    card,
    scope: 'main',
    classified: { type: 'blame', confidence: 0.9 },
    intensity: 1.4,
    note: 'llm',
    now: TEST_NOW,
    hour: 12,
    minute: 0,
    quiet: false,
  });
  assert.equal(result.changed, true);
  const events = temp.store.listEmotionEvents('main', 5);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'blame');
  assert.equal(events[0].note, 'llm');
  assert.ok(events[0].deltas.pleasure < 0);
});

test('applyClassifiedEvent：低置信度只记零增量审计，状态不变', async (t) => {
  const temp = makeTempStore({ t });
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = { enabled: true, baseline: { ...BASELINE_50 }, halfLifeHours: 24 };
  const result = await applyClassifiedEvent({
    store: temp.store,
    card,
    scope: 'main',
    classified: { type: 'blame', confidence: 0.4 },
    intensity: 0.9,
    note: 'llm',
    now: TEST_NOW,
    hour: 12,
    minute: 0,
    quiet: false,
  });
  // 低置信度只写零增量审计：状态可能因本轮到目标衰减而轻微移动，但不得有事件增量。
  assert.equal(result.event.deltas.pleasure, 0);
  assert.ok(result.state.pleasure > 45, '低置信度事件不得把状态明显拉低');
  const events = temp.store.listEmotionEvents('main', 5);
  assert.equal(events[0].deltas.pleasure, 0);
});

// ---------------------------------------------------------------- E2 接线

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

/** 把 DSH_HOME 指到临时目录，测试结束恢复。 */
function useTempDshHome(t, dir) {
  const previous = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : undefined;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
}

/** @param {string} dir @param {'llm'|'rules'} appraiser */
function writeCard(dir, appraiser) {
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 6,
    appraiser,
    appraiseModel: null,
    appraiseTimeoutMs: 8000,
  };
  const path = join(dir, 'persona.json');
  writeFileSync(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

/** 让异步队列把活干完：轮询到条件成立或超时。 */
async function pollUntil(check, label, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @param {object} session @param {object[]} messages */
function turnPayload(session, messages) {
  return { agent: { id: session.id, session }, messages, turn: { id: `turn-${randomUUID()}` }, step: 1 };
}

/** @param {string} text */
function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

test('接线：llm 模式 pre-step 不等模型，判定完成后异步落库并标 note=llm', async (t) => {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v060-'));
  useTempDshHome(t, home);
  const cardPath = writeCard(home, 'llm');

  const ctx = makePluginCtx();
  let requests = 0;
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      requests += 1;
      yield { type: 'text-delta', text: '{"target":"her","type":"blame","intensity":0.8,"confidence":0.9}' };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const session = ctx.addSession({ id: `session-${randomUUID()}` });
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  const started = Date.now();
  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('你怎么又忘了')]), { kind: 'enter', messages: [] });
  assert.equal(Date.now() - started < 1000, true, 'pre-step 不得等待模型');

  const events = await pollUntil(
    () => {
      const rows = temp.store.listEmotionEvents('main', 20).filter((row) => row.type !== 'ambient');
      return rows.length > 0 ? rows : null;
    },
    '模型判定落库',
  );
  assert.equal(requests, 1);
  assert.equal(events[0].type, 'blame');
  assert.equal(events[0].note, 'llm');
});

test('接线：非法 JSON 走规则兜底并标 note=rules:fallback:invalid', async (t) => {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v060-'));
  useTempDshHome(t, home);
  const cardPath = writeCard(home, 'llm');
  const ctx = makePluginCtx();
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      yield { type: 'text-delta', text: '我觉得她有点不高兴' };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const session = ctx.addSession({ id: `session-${randomUUID()}` });
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('你怎么又忘了')]), { kind: 'enter', messages: [] });
  const events = await pollUntil(
    () => {
      const rows = temp.store.listEmotionEvents('main', 20).filter((row) => row.type !== 'ambient');
      return rows.length > 0 ? rows : null;
    },
    '规则兜底落库',
  );
  assert.equal(events[0].note, 'rules:fallback:invalid');
  assert.equal(events[0].type, 'blame', '规则分类器应判出 blame');
});

test('接线：情绪关闭时判定器一次也不调用', async (t) => {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v060-'));
  useTempDshHome(t, home);
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = { ...card.emotion, enabled: false, appraiser: 'llm' };
  const cardPath = join(home, 'persona.json');
  writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf8');
  const ctx = makePluginCtx();
  let requests = 0;
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      requests += 1;
      yield { type: 'text-delta', text: '{}' };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const session = ctx.addSession({ id: `session-${randomUUID()}` });
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('你怎么又忘了')]), { kind: 'enter', messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(requests, 0);
  assert.equal(temp.store.countEmotionEvents('main'), 0);
});
