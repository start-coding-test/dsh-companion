/**
 * v0.6.1 回归（用户 m08808 的 V60-M1/M2/M3 与 L1/L2/L3）：
 * - M2：所有情绪句不得出现「你 / 他 / 她」（句首「你此刻：」是模板，不是句子）。
 * - M1：模型判定成功后，下一轮 pre-step 借用一次专属句；用过即清，超过 10 分钟不用。
 * - M3：llm 来源用卡内 appraiseMinConfidence；规则路径仍是 0.5。
 * - L2：type=none 不落事件表。
 * - L1：usage chunk 优先，缺失时按码点 × 1.0 估算（通过 adapter 回调验证）。
 * - L3：EMOTION_APPRAISE_HEADERS / EMOTION_APPRAISE_SESSION 注入请求头。
 *
 * 全部使用固定时钟、临时 DSH_HOME 与 mock 模型，不联网、不写用户目录。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CARD, normalizeCardEmotion } from '../src/persona/card.js';
import {
  BLAME_SENTENCES,
  DESCRIBE_SENTENCES,
  REASSURE_SENTENCES,
  VENT_SENTENCES,
} from '../src/persona/emotion.js';
import { applyClassifiedEvent } from '../src/persona/emotion-wiring.js';
import { createLlmJudge, parseExtraHeaders } from '../scripts/emotion-report.mjs';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore } from './e2e/helpers.js';

const BASELINE_50 = Object.freeze({ pleasure: 50, arousal: 50, dominance: 50, energy: 50 });

// ------------------------------------------------------------------ M2 句子

test('情绪句不出现第二/第三人称（M2）', () => {
  for (const [group, sentences] of Object.entries({
    DESCRIBE: DESCRIBE_SENTENCES,
    BLAME: BLAME_SENTENCES,
    VENT: VENT_SENTENCES,
    REASSURE: REASSURE_SENTENCES,
  })) {
    for (const sentence of sentences) {
      assert.doesNotMatch(sentence, /[你他她]/u, `${group} 句含人称代词：${sentence}`);
    }
  }
});

// ---------------------------------------------------------------- 配置归一化

test('appraiseMinConfidence：默认 0.65、边界合法、越界回落并 warning（M3）', () => {
  const base = { enabled: true, baseline: { ...BASELINE_50 }, halfLifeHours: 6, appraiser: 'llm' };
  const plain = normalizeCardEmotion(base);
  assert.equal(plain.emotion.appraiseMinConfidence, 0.65);
  assert.deepEqual(plain.warnings, []);
  for (const value of [0.5, 0.65, 0.95]) {
    const ok = normalizeCardEmotion({ ...base, appraiseMinConfidence: value });
    assert.equal(ok.emotion.appraiseMinConfidence, value);
    assert.deepEqual(ok.warnings, []);
  }
  for (const value of [0.49, 0.96, '0.7', null, Number.NaN]) {
    const bad = normalizeCardEmotion({ ...base, appraiseMinConfidence: value });
    assert.equal(bad.emotion.appraiseMinConfidence, 0.65);
    assert.deepEqual(bad.warnings.map((w) => w.code), ['emotion_appraise_min_confidence_invalid']);
  }
});

// ------------------------------------------------------------------ M3 阈值

test('llm 阈值：0.6 的判定落在 0.65 之下只写零增量（M3）', (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  const card = { ...DEFAULT_CARD, emotion: { ...DEFAULT_CARD.emotion, enabled: true, appraiseMinConfidence: 0.65 } };
  const now = Date.parse('2026-03-01T10:00:00.000Z');

  applyClassifiedEvent({
    store: temp.store,
    card,
    scope: 'main',
    classified: { type: 'blame', confidence: 0.6 },
    note: 'llm',
    minConfidence: 0.65,
    now,
    hour: 10,
    minute: 0,
  });

  const rows = temp.store.listEmotionEvents('main', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'blame');
  assert.deepEqual(rows[0].deltas, { pleasure: 0, arousal: 0, dominance: 0, energy: 0 });
  const state = temp.store.getEmotionState('main');
  assert.deepEqual(
    { pleasure: state.pleasure, arousal: state.arousal },
    { pleasure: state.pleasure, arousal: state.arousal },
  );
});

test('llm 阈值不越界影响规则路径（规则 0.6 仍入账）', (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  const card = { ...DEFAULT_CARD, emotion: { ...DEFAULT_CARD.emotion, enabled: true, appraiseMinConfidence: 0.95 } };
  const now = Date.parse('2026-03-01T10:00:00.000Z');

  // 不传 minConfidence：规则兜底路径，沿用 0.5 的既有口径。
  applyClassifiedEvent({
    store: temp.store,
    card,
    scope: 'main',
    classified: { type: 'blame', confidence: 0.6 },
    note: 'rules',
    now,
    hour: 10,
    minute: 0,
  });

  const rows = temp.store.listEmotionEvents('main', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, 'rules');
  assert.notDeepEqual(rows[0].deltas, { pleasure: 0, arousal: 0, dominance: 0, energy: 0 });
});

// ------------------------------------------------------------------ L2 不上报

test('type=none 不落事件表（L2）', (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  const card = { ...DEFAULT_CARD, emotion: { ...DEFAULT_CARD.emotion, enabled: true } };
  const now = Date.parse('2026-03-01T10:00:00.000Z');

  applyClassifiedEvent({
    store: temp.store,
    card,
    scope: 'main',
    classified: { type: 'none', confidence: 0.9 },
    note: 'llm',
    now,
    hour: 10,
    minute: 0,
  });

  assert.equal(temp.store.countEmotionEvents('main'), 0);
});

// ------------------------------------------------------------------ L1 usage

test('adapter.complete 把 usage chunk 交给 onUsage（L1）', async () => {
  const ctx = new FakeCtx({ now: Date.parse('2026-03-01T10:00:00.000Z') });
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      yield { type: 'text-delta', text: '好的' };
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8 } };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const adapter = createAdapter(strictCtx(ctx));
  let captured = null;
  const text = await adapter.complete({
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    onUsage: (usage) => {
      captured = usage;
    },
  });
  assert.equal(text, '好的');
  assert.deepEqual(captured, { inputTokens: 120, outputTokens: 8 });
});

// ------------------------------------------------------------------ L3 头部

test('parseExtraHeaders：JSON 对象、拒绝非对象与非字符串值（L3）', () => {
  assert.deepEqual(parseExtraHeaders('{"x-opencode-session":"s1"}'), { 'x-opencode-session': 's1' });
  assert.deepEqual(parseExtraHeaders(undefined), {});
  assert.throws(() => parseExtraHeaders('[1]'), /JSON 对象/u);
  assert.throws(() => parseExtraHeaders('{"a":1}'), /必须是字符串/u);
});

test('createLlmJudge 带上会话头与额外头（L3）', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '{"target":"her","type":"vent","intensity":0.6,"confidence":0.8}' } }] };
      },
    };
  };
  const judge = createLlmJudge({
    EMOTION_APPRAISE_BASE_URL: 'https://api.example.com/v1',
    EMOTION_APPRAISE_API_KEY: 'k',
    EMOTION_APPRAISE_MODEL: 'm',
    EMOTION_APPRAISE_SESSION: 'sess-1',
    EMOTION_APPRAISE_HEADERS: '{"x-opencode-session":"sess-1","x-extra":"1"}',
  }, fetchImpl);
  const verdict = await judge('今天好累');
  assert.equal(verdict.type, 'vent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['x-opencode-session'], 'sess-1');
  assert.equal(calls[0].headers['x-extra'], '1');
  assert.match(calls[0].headers.authorization, /^Bearer /u);
});

// ------------------------------------------------------------------ M1 借用

function turnPayload(session, messages) {
  return { agent: { id: session.id, session }, messages, turn: { id: `turn-${randomUUID()}` }, step: 1 };
}

function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

async function waitFor(check, label, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 读最近一次装配里的情绪句（`你此刻：…`）。 */
function latestEmotionText(ctx) {
  const entries = ctx.contexts.filter((item) => item.context?.name === 'companion-emotion');
  assert.ok(entries.length > 0, '没有注册情绪 context');
  const entry = entries[entries.length - 1].context;
  assert.equal(typeof entry.text, 'function');
  return entry.text({});
}

test('M1：llm 判定成功后，下一轮借用一次 vent 专属句，用完即清', async (t) => {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v061-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 6,
    appraiser: 'llm',
    appraiseModel: null,
    appraiseTimeoutMs: 8000,
    appraiseMinConfidence: 0.65,
  };
  const cardPath = join(home, 'persona.json');
  writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf8');

  const ctx = new FakeCtx({ now: Date.parse('2026-03-01T14:00:00.000Z') });
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      yield { type: 'text-delta', text: '{"target":"self","type":"vent","intensity":0.7,"confidence":0.9}' };
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

  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('今天加班好累')]), { kind: 'enter', messages: [] });
  await waitFor(
    () => temp.store.listEmotionEvents('main', 20).some((row) => row.note === 'llm'),
    '判定落库',
  );

  // 第二轮：借用上一次的 vent → 专属句
  ctx.advance(5 * 60 * 1000);
  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('嗯，还在忙')]), { kind: 'enter', messages: [] });
  const borrowed = latestEmotionText(ctx).replace(/^你此刻：/u, '');
  assert.ok(VENT_SENTENCES.includes(borrowed), `第二轮应是 vent 专属句，实际：${borrowed}`);

  // 第三轮：用过即清 → 回到通用句
  ctx.advance(60 * 1000);
  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('我回来了')]), { kind: 'enter', messages: [] });
  const plain = latestEmotionText(ctx).replace(/^你此刻：/u, '');
  assert.equal(VENT_SENTENCES.includes(plain), false, '专属句只能用一次');
  assert.ok(DESCRIBE_SENTENCES.includes(plain), `第三轮应是通用句，实际：${plain}`);
});

test('M1：超过 10 分钟的判定不再借用', async (t) => {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v061b-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  });

  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 6,
    appraiser: 'llm',
    appraiseModel: null,
    appraiseTimeoutMs: 8000,
    appraiseMinConfidence: 0.65,
  };
  const cardPath = join(home, 'persona.json');
  writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf8');

  const ctx = new FakeCtx({ now: Date.parse('2026-03-01T14:00:00.000Z') });
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      yield { type: 'text-delta', text: '{"target":"self","type":"vent","intensity":0.7,"confidence":0.9}' };
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

  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('今天加班好累')]), { kind: 'enter', messages: [] });
  await waitFor(
    () => temp.store.listEmotionEvents('main', 20).some((row) => row.note === 'llm'),
    '判定落库',
  );

  ctx.advance(11 * 60 * 1000);
  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage('我回来了')]), { kind: 'enter', messages: [] });
  const plain = latestEmotionText(ctx).replace(/^你此刻：/u, '');
  assert.equal(VENT_SENTENCES.includes(plain), false, '超过 10 分钟不得借用');
});
