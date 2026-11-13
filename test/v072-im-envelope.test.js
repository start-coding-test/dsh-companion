/**
 * V71-H1：IM 合并消息（信封 + 正文同一条 user 消息）不能被整条当成信封丢掉。
 *
 * 现场（2026-11-14 01:14 QQ，seq 2104）：`source={kind:'user', rpcId:'qq-…'}`，
 * content 只有一个 text 块，内容是
 *   `<dsh_im_source>{"channel":"qq"…}</dsh_im_source>\n\n我在`
 * 旧逻辑按 `<dsh_im_` 前缀把整条判为信封，召回、情绪、过期通知都读不到正文。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CARD,
  normalizeCardEmotion,
} from '../src/persona/card.js';
import { apply as applyCordis, captureTranscript, isPluginNotice, lastUserText, stripImEnvelopes } from '../src/index.js';
import { EXPIRED_SOURCE_KIND } from '../src/reminder/expired-notice.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, TEST_NOW } from './e2e/helpers.js';

const SOURCE_ENVELOPE = '<dsh_im_source>{"channel":"qq","senderId":"qq-1"}</dsh_im_source>';
const REPLY_ENVELOPE = '<dsh_im_reply_to>{"seq":1967,"sender":"小明"}</dsh_im_reply_to>';

/** 现场原始形状：信封与正文在同一块文本里。 */
function mergedMessage(body, envelopes = [SOURCE_ENVELOPE]) {
  const text = [...envelopes, body].join('\n\n');
  return {
    id: 'seq-2104',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: 'qq-1' },
  };
}

/** 独立的 notice 消息（source 可判定，正文只有信封）。 */
function noticeMessage(text = SOURCE_ENVELOPE) {
  return {
    id: 'notice-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-im', form: 'notice' },
  };
}

// ---------------------------------------------------------------- 纯函数

test('stripImEnvelopes：合并形态只留正文，计数为 1', () => {
  const merged = mergedMessage('我在');
  const { text, stripped } = stripImEnvelopes(merged.content[0].text);
  assert.equal(text, '我在');
  assert.equal(stripped, 1);
  assert.equal(stripImEnvelopes('我在，`<dsh_im_source>` 只是字面量').stripped, 0);
});

test('lastUserText：合并形态返回「我在」（现场 seq 2104）', () => {
  const messages = [mergedMessage('我在')];
  assert.equal(lastUserText(messages), '我在');
  assert.equal(isPluginNotice(messages[0]), false);
});

test('lastUserText：source + reply_to 两个信封在前，只留正文', () => {
  const messages = [mergedMessage('晚点到', [SOURCE_ENVELOPE, REPLY_ENVELOPE])];
  assert.equal(lastUserText(messages), '晚点到');
  assert.equal(isPluginNotice(messages[0]), false);
  assert.equal(stripImEnvelopes(messages[0].content[0].text).stripped, 2);
});

test('只有信封（有闭合 / 无闭合）算 notice，不当正文', () => {
  const closed = { role: 'user', content: [{ type: 'text', text: SOURCE_ENVELOPE }], source: { kind: 'user' } };
  assert.equal(isPluginNotice(closed), true);
  assert.equal(lastUserText([closed]), '');

  const unclosed = { role: 'user', content: [{ type: 'text', text: '<dsh_im_source>{"channel":"qq"' }], source: { kind: 'user' } };
  assert.equal(isPluginNotice(unclosed), true);
  assert.equal(lastUserText([unclosed]), '');
  assert.equal(stripImEnvelopes(unclosed.content[0].text).text, '');
});

test('独立 notice 消息在正文前、后，仍取到正文', () => {
  assert.equal(lastUserText([noticeMessage(), mergedMessage('在的')]), '在的');
  assert.equal(lastUserText([mergedMessage('在的'), noticeMessage()]), '在的');
  assert.equal(lastUserText([noticeMessage()]), '');
});

test('正文中间出现的字面 <dsh_im_source> 原样保留', () => {
  const body = '我刚才看到 <dsh_im_source> 这个标签，是什么？';
  const messages = [mergedMessage(body)];
  assert.equal(lastUserText(messages), body);
});

test('captureTranscript：合并形态记录「我在」', () => {
  const state = { transcript: [], transcriptByScope: new Map() };
  captureTranscript(state, [mergedMessage('我在')]);
  assert.deepEqual(state.transcript, [{ role: 'user', text: '我在' }]);
});

// ---------------------------------------------------------------- 接线（真实 apply）

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

/** 启用了情绪的人格卡（基线四维 50，半衰期 6h）。 */
function writeEmotionCard(dir) {
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { pleasure: 50, arousal: 50, dominance: 50, energy: 50 },
    halfLifeHours: 6,
  };
  const path = join(dir, 'persona.json');
  writeFileSync(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

function turnPayload(session, turnId, messages) {
  return { agent: { id: session.id, session }, messages, turn: { id: turnId }, step: 1 };
}

test('过期通知：合并形态下能读出正文并注入一次', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-v072-home-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const dueAt = Math.floor(TEST_NOW / 1000) - 3600;
  const row = temp.store.insertReminder({
    scope: 'main',
    title: '交电费',
    kind: 'todo',
    due_at: dueAt,
    next_fire_at: dueAt,
    status: 'pending',
  });
  temp.store.expireReminder(row.id);

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-v072-expired' });
  const message = mergedMessage('我在');
  const payload = turnPayload(session, 'turn-v072-expired', [message]);
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath });
  try {
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    const injected = (decision?.messages ?? []).filter(
      (item) => item?.source?.kind === EXPIRED_SOURCE_KIND,
    );
    assert.equal(injected.length, 1, '合并形态必须触发过期通知');
    const text = injected[0].content[0].text;
    assert.match(text, /有 1 条提醒未能按时送达/u);
    assert.match(text, /交电费/u);
  } finally {
    handle.dispose();
  }
});

test('情绪判定：合并形态下能读到正文并落一条事件', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-v072-emotion-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEmotionCard(home);

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-v072-emotion' });
  const message = mergedMessage('今天好累，晚安');
  const payload = turnPayload(session, 'turn-v072-emotion', [message]);
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    assert.equal(temp.store.countEmotionEvents('main'), 1, '合并形态必须触发情绪判定');
    const saved = temp.store.getEmotionState('main');
    assert.ok(saved, '情绪状态必须落库');
  } finally {
    handle.dispose();
  }
});

test('默认卡片归一化不受影响（V71 不碰人格）', () => {
  const card = normalizeCardEmotion(DEFAULT_CARD.emotion);
  assert.equal(card.emotion.enabled, false);
  assert.equal(card.warnings.length, 0);
});
