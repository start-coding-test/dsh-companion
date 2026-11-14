/**
 * V72-H1：多块 IM 消息里只要有一块信封就把整条丢掉。
 *
 * dsh-im 的 context-enhancement 在「引用回复 / 带附件」时会把信封拆成独立块，
 * 追加在正文块之前：`[{text:'<dsh_im_source>…</dsh_im_source>'}, {text:'<dsh_im_reply_to>…'}, …原 content]`。
 * 旧逻辑逐块判定，任一信封块剥空就让 `isPluginNotice` 返回 true，`textRows` 随即整条跳过，
 * 正文块一起丢失（现场 2026-11-14 13:10：skippedNotices=1、strippedEnvelopes=2、queryLength=0）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply as applyCordis, captureTranscript, isPluginNotice, lastUserText } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, TEST_NOW } from './e2e/helpers.js';

const SOURCE = '<dsh_im_source>{"channel":"qq","senderId":"qq-1"}</dsh_im_source>';
const REPLY = '<dsh_im_reply_to>{"seq":2103,"content":"改一夜了吧"}</dsh_im_reply_to>';
const FILES = '<dsh_im_files>[{"name":"a.pdf","size":12}]</dsh_im_files>';
const BODY = '没有改一夜啦，早上起来继续改';

/** 多块形态：信封块在前，正文块在最后（dsh-im context-enhancement 的实际形状）。 */
function blockMessage(blocks, source = { kind: 'user', rpcId: 'qq-1' }) {
  return {
    id: 'seq-2104',
    role: 'user',
    content: blocks.map((text) => ({ type: 'text', text })),
    source,
  };
}

function transcriptOf(message) {
  const state = { transcript: [], transcriptByScope: new Map() };
  captureTranscript(state, [message]);
  return state.transcript;
}

// ---------------------------------------------------------------- 多块形态

test('3 块（source / reply_to / 正文）：不是 notice，正文完整保留', () => {
  const message = blockMessage([SOURCE, REPLY, BODY]);
  assert.equal(isPluginNotice(message), false);
  assert.equal(lastUserText([message]), BODY);
  assert.deepEqual(transcriptOf(message), [{ role: 'user', text: BODY }]);
});

test('2 块（信封 + 正文）：同上', () => {
  const message = blockMessage([SOURCE, BODY]);
  assert.equal(isPluginNotice(message), false);
  assert.equal(lastUserText([message]), BODY);
});

test('全是信封块（source + reply_to）：才算 notice，正文为空', () => {
  const message = blockMessage([SOURCE, REPLY]);
  assert.equal(isPluginNotice(message), true);
  assert.equal(lastUserText([message]), '');
  assert.deepEqual(transcriptOf(message), []);
});

test('reply_to 里的被引用原文不得进转录或 lastUserText', () => {
  const message = blockMessage([SOURCE, REPLY, BODY]);
  assert.equal(lastUserText([message]), BODY);
  const transcript = transcriptOf(message);
  assert.equal(transcript.length, 1);
  assert.doesNotMatch(transcript[0].text, /改一夜了吧/u);
  assert.doesNotMatch(transcript[0].text, /dsh_im_/u);
});

test('files 信封块 + 正文：只留正文', () => {
  const message = blockMessage([SOURCE, FILES, BODY]);
  assert.equal(isPluginNotice(message), false);
  assert.equal(lastUserText([message]), BODY);
  assert.deepEqual(transcriptOf(message), [{ role: 'user', text: BODY }]);
});

// ---------------------------------------------------------------- 旧形态回归

test('旧形态：独立 notice 消息仍跳过', () => {
  const notice = {
    id: 'notice-1',
    role: 'user',
    content: [{ type: 'text', text: SOURCE }],
    source: { kind: 'plugin:dsh-im', form: 'notice' },
  };
  assert.equal(isPluginNotice(notice), true);
  assert.equal(lastUserText([notice]), '');
});

test('旧形态：单块「信封\\n\\n正文」仍取到正文', () => {
  const merged = blockMessage([`${SOURCE}\n\n${BODY}`]);
  assert.equal(isPluginNotice(merged), false);
  assert.equal(lastUserText([merged]), BODY);
});

test('旧形态：正文中间出现字面 <dsh_im_ 原样保留', () => {
  const body = '我刚才看到 <dsh_im_source> 这个标签，是什么？';
  const merged = blockMessage([SOURCE, body]);
  assert.equal(lastUserText([merged]), body);
});

// ---------------------------------------------------------------- 排障日志

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

test('mirror debug：多块消息 skippedNotices=0、strippedEnvelopes=2、queryLength>0', async (t) => {
  const temp = makeTempStore({ t });
  const previous = process.env.DSH_COMPANION_MIRROR_DEBUG;
  process.env.DSH_COMPANION_MIRROR_DEBUG = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_COMPANION_MIRROR_DEBUG;
    else process.env.DSH_COMPANION_MIRROR_DEBUG = previous;
  });

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: 'session-v073-mirror' });
  const message = blockMessage([SOURCE, REPLY, BODY]);
  const payload = { agent: { id: session.id, session }, messages: [message], turn: { id: 'turn-v073' }, step: 1 };
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath });
  try {
    await ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages: payload.messages });
    const entry = ctx.logs.filter((item) => String(item.message).includes('mirror debug')).at(-1);
    assert.ok(entry, '必须记录 mirror debug 行');
    assert.equal(entry.meta.skippedNotices, 0);
    assert.equal(entry.meta.strippedEnvelopes, 2);
    assert.ok(entry.meta.queryLength > 0, '合并/多块形态必须取到正文作为查询');
  } finally {
    handle.dispose();
  }
});
