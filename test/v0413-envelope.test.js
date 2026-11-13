/**
 * A7（U13-H1）：IM 信封不得被当作用户正文。
 *
 * 线上形状（2026-11-13 12:02:56）：正文 seq 1967，来源信封 seq 1968
 * （`<dsh_im_source>{…}`，source = {kind:'plugin:dsh-im', form:'notice'}），
 * 召回注入 seq 1969 只命中了两条字段名类技术事实。dsh-im 把信封作为独立
 * user 消息排在正文之后，而 `lastUserText` 从末尾取第一条 user 文本。
 *
 * 覆盖：
 *   1. `isPluginNotice` 的 source 判定、正文前缀兜底与负例；
 *   2. `lastUserText` 在三种排列下都拿到正文，只有信封时返回空串；
 *   3. e2e：IM 形状下发一句生活话，召回不得命中两条技术事实。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis, isPluginNotice, lastUserText } from '../src/index.js';

import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);
const RECALL_KIND = 'companion-recall';

function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  ctx.tools = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return ctx;
}

function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

function imEnvelope(kind, payload) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `<dsh_im_${kind}>${JSON.stringify(payload)}` }],
    source: { kind: 'plugin:dsh-im', form: 'notice' },
  };
}

function turnPayload(session, turnId, messages) {
  return { agent: { id: session.id, session }, messages, turn: { id: turnId }, step: 1 };
}

function appendMessage(ctx, session, message) {
  ctx.emitSessionEvent(session.id, { type: 'user/message', data: message });
}

// ------------------------------------------------------------------ 单元

test('A7：isPluginNotice 认 source 与正文前缀', () => {
  assert.equal(isPluginNotice(imEnvelope('source', { channel: 'wechat' })), true);
  assert.equal(isPluginNotice(imEnvelope('reply_to', { seq: 12 })), true);
  // source 丢失时按正文兜底（旧宿主 / 回放）。
  assert.equal(isPluginNotice({ role: 'user', content: [{ type: 'text', text: '<dsh_im_source>{}' }] }), true);
  // 裸 text 形态也一样。
  assert.equal(isPluginNotice({ role: 'user', text: '<dsh_im_source>{}' }), true);
  // 普通用户消息、别的插件通知、召回注入都不是信封。
  assert.equal(isPluginNotice(userMessage('周五了，可以休息了')), false);
  // 任何插件以 form:'notice' 注入的通知都算信封（口径比 dsh-im 宽）。
  assert.equal(isPluginNotice({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:other', form: 'notice' } }), true);
  assert.equal(isPluginNotice({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:other' } }), false);
  assert.equal(isPluginNotice({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin:dsh-im' } }), false);
  assert.equal(isPluginNotice({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: RECALL_KIND } }), false);
  assert.equal(isPluginNotice(null), false);
  assert.equal(isPluginNotice('text'), false);
});

test('A7：lastUserText 跳过各种排列里的信封', () => {
  const body = userMessage('周五了，可以休息了');
  const reply = imEnvelope('reply_to', { seq: 1966 });
  const source = imEnvelope('source', { channel: 'wechat', senderName: '老板' });

  assert.equal(lastUserText([body, reply, source]), '周五了，可以休息了');
  assert.equal(lastUserText([reply, body, source]), '周五了，可以休息了');
  assert.equal(lastUserText([body]), '周五了，可以休息了');
  // 只有信封：没有正文，召回与情绪都不该动。
  assert.equal(lastUserText([reply, source]), '');
  assert.equal(lastUserText([source]), '');
  assert.equal(lastUserText([]), '');
  assert.equal(lastUserText(null), '');
  // 无 source 的旧信封仍按正文前缀跳过。
  const legacy = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: '<dsh_im_source>{"channel":"wechat"}' }] };
  assert.equal(lastUserText([body, legacy]), '周五了，可以休息了');
  // assistant 文本不算用户正文。
  const assistant = { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: '好的' }] };
  assert.equal(lastUserText([body, assistant, source]), '周五了，可以休息了');
});

// ------------------------------------------------------------------ e2e

test('A7：IM 形状下召回不拿信封当查询（技术事实不得因信封被召回）', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();

  // 两条字段名类技术事实（12:02 那轮实际被召回的就是这类）。
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: 'SESSION_CHANNEL_LABELS',
    predicate: '包含',
    object_text: '微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix、AI Office 等频道标签',
    statement: 'SESSION_CHANNEL_LABELS 包含微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix、AI Office 等频道标签。',
    source_kind: 'turn',
  });
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: '上下文增强模块',
    predicate: '字段',
    object_text: 'channel, conversationType, senderId, senderName, conversationTitle, chatId, threadId, botId, sentAt',
    statement: '上下文增强模块的字段有 channel、conversationType、senderId、senderName、conversationTitle、chatId、threadId、botId、sentAt。',
    source_kind: 'turn',
  });
  // 一条生活事实：这才是「周五了，可以休息了」该命中的。
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: '作息',
    predicate: '偏好',
    object_text: '周五晚上想休息',
    statement: '用户周五晚上通常想休息，不想聊工作。',
    source_kind: 'turn',
  });

  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const session = ctx.addSession({ id: 'session-im' });
  const body = userMessage('周五了，可以休息了');
  const source = imEnvelope('source', {
    channel: 'wechat',
    conversationType: 'group',
    senderId: 'wxid_1',
    senderName: '张三',
    conversationTitle: '项目群',
  });
  appendMessage(ctx, session, body);
  appendMessage(ctx, session, source);
  const payload = turnPayload(session, 'turn-im', [body, source]);
  const decision = await ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages: payload.messages });
  await settle(30);

  const recall = (decision?.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
  assert.ok(recall, '生活话应当有召回注入（否则这条回归没意义）');
  const text = recall.content.map((part) => part?.text ?? '').join('');
  assert.match(text, /作息|休息/u, '必须命中生活事实');
  assert.doesNotMatch(text, /SESSION_CHANNEL_LABELS/u, '不得因信封召回字段名类技术事实');
  assert.doesNotMatch(text, /上下文增强模块/u, '不得因信封召回字段名类技术事实');
});

test('A7：只有信封时召回不触发', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: 'SESSION_CHANNEL_LABELS',
    predicate: '包含',
    object_text: '微信、飞书、钉钉',
    statement: 'SESSION_CHANNEL_LABELS 包含微信、飞书、钉钉。',
    source_kind: 'turn',
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const session = ctx.addSession({ id: 'session-im-only' });
  const source = imEnvelope('source', { channel: 'wechat', senderName: '张三' });
  appendMessage(ctx, session, source);
  const payload = turnPayload(session, 'turn-env-only', [source]);
  const decision = await ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages: payload.messages });
  await settle(30);

  const recall = (decision?.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
  assert.equal(recall, undefined, '只有信封时不得召回');
});

test('A7：网页形状（没有信封）行为不变', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: '作息',
    predicate: '偏好',
    object_text: '周五晚上想休息',
    statement: '用户周五晚上通常想休息。',
    source_kind: 'turn',
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const session = ctx.addSession({ id: 'session-web' });
  const body = userMessage('周五了，可以休息了');
  appendMessage(ctx, session, body);
  const payload = turnPayload(session, 'turn-web', [body]);
  const decision = await ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages: payload.messages });
  await settle(30);

  const recall = (decision?.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
  assert.ok(recall, '网页形状仍应召回');
  const text = recall.content.map((part) => part?.text ?? '').join('');
  assert.match(text, /休息/u);
});
