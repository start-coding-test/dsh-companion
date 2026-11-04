/**
 * V3-H1 真机形态回归：召回注入必须是「完整平台消息」。
 *
 * v0.4.3 上含 active fact 且召回非空的一轮必崩：
 * `Cannot read properties of undefined (reading 'kind')`。
 * 根因：injectRecall 返回裸内容块 `{type:'text',text}`，adapter 原样拼进
 * `decision.messages`；`dsh-agent-loop/lib/index.js:1067` 逐条读
 * `message.source.kind`，裸块没有 source。
 *
 * 本文件用 FakeCtx 复刻平台的两段行为：
 *   1) fake loop 逐条消费 decision.messages（runtime-context 走平台分支，
 *      其余必须能当平台消息 append）；
 *   2) 冷读：把 append 的消息落成 JSONL，再按行解析并复验
 *      id/role/source/content（对应 dsh-session/lib/index.js:1186-1219）。
 *
 * 另外锁住下游排除：巩固窗口文本不得把召回块当用户发言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, waitFor } from './helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';

/** 巩固草稿：本文件只关心喂给模型的窗口文本，草稿本身不写事实。 */
const DRAFT = {
  episode: { title: '预算问答', summary: '用户问预算额度。', topics: ['预算'], salience: 'normal', fidelity: 'full' },
  facts: [],
  reminders: [],
};

/**
 * FakeCtx + commands/tools/llm；tokenMeter 返回值由测试逐轮改写。
 * @param {{totalTokens?: number}} [options]
 * @returns {{ctx: FakeCtx, session: object, streams: object[]}}
 */
function makeCtx({ totalTokens = 1000 } = {}) {
  const ctx = new FakeCtx({ now: TEST_NOW });
  const session = ctx.addSession({ id: 'session-1' });
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
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  setTokens(ctx, totalTokens);
  return { ctx, session, streams };
}

/**
 * 改写 tokenMeter.measure 的返回值（保持平台字段形状）。
 * @param {FakeCtx} ctx
 * @param {number} totalTokens
 * @returns {void}
 */
function setTokens(ctx, totalTokens) {
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
}

/**
 * 造 turn payload。`messages` 是进入批次：平台在 pre-step 返回后才逐条 append
 * （dsh-agent-loop:1067），所以这里不提前写 surface，调用方用 appendDecision 落库。
 * user 消息本身也是完整平台消息（真实平台带 id/source）。
 * @param {object} session
 * @param {object} turn
 * @param {string} text
 * @param {number} [step]
 * @param {object[]} [messages]
 * @returns {object}
 */
function turnPayload(session, turn, text, step = 1, messages) {
  const batch = messages ?? [
    {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
  ];
  return { agent: { id: session.id, session }, messages: batch, turn, step };
}

/**
 * 复刻 `dsh-agent-loop/lib/index.js:1067`：逐条消费 decision.messages。
 * `source.kind === 'runtime-context'` 的条目走平台分支（被吞），其余每条都
 * 必须能按 `dsh-session/lib/index.js:1186-1219` 的规则 append。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {object} decision
 * @returns {object[]} 追加到会话的事件
 */
function appendDecision(ctx, session, decision) {
  const appended = [];
  for (const message of decision?.messages ?? []) {
    if (message?.source?.kind === 'runtime-context') continue; // 平台自己的 context 分支
    assertPlatformMessage(message);
    appended.push(ctx.emitSessionEvent(session.id, { type: 'user/message', data: message }));
  }
  return appended;
}

/**
 * `dsh-session/lib/index.js:1186-1219` 的消息形状校验（user/message）。
 * @param {unknown} message
 * @returns {void}
 */
function assertPlatformMessage(message) {
  assert.ok(message !== null && typeof message === 'object', '消息必须是对象');
  assert.equal(typeof message.id, 'string', '消息必须带 id（否则冷读报 lacks an identified message）');
  assert.ok(message.id.length > 0, 'id 必须是非空字符串');
  assert.equal(message.role, 'user', 'user/message 的 role 必须是 "user"');
  assert.ok(message.source !== null && typeof message.source === 'object', '消息必须带 source 对象');
  assert.equal(typeof message.source.kind, 'string', 'source.kind 必须是非空字符串');
  assert.ok(message.source.kind.length > 0, 'source.kind 不能为空');
  assert.ok(Array.isArray(message.content), '消息 content 必须是数组');
}

/**
 * 冷读：消息落成 JSONL 再逐行解析、复验形状并还原召回正文。
 * @param {object[]} events
 * @returns {object[]} 解析后的行
 */
function coldRead(events) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-recall-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
    return lines.map((line) => {
      const event = JSON.parse(line);
      assert.equal(event.type, 'user/message');
      assertPlatformMessage(event.data);
      return event;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('召回非空的一轮：注入完整平台消息，fake loop 逐条消费且冷读通过', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '周报',
      predicate: '提交时间',
      object_text: '周五',
      statement: '每周五要交周报。',
      source_kind: 'turn',
    });

    const payload = turnPayload(session, { id: 'turn-1' }, '周报什么时候交？');
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, 2, '用户消息 + 一条召回消息');
    const recall = decision.messages[1];
    assert.equal(recall.role, 'user');
    assert.equal(recall.source.kind, RECALL_KIND, '召回消息必须带可识别的 source.kind');
    assert.equal(recall.source.form, 'snapshot');
    assert.deepEqual(recall.source.sections.map((section) => section.name), ['recall']);
    assert.equal(typeof recall.source.sections[0].text, 'string');
    assert.match(recall.content[0].text, /\[相关记忆\]/u);
    assert.match(recall.content[0].text, /周报/u);
    assert.match(recall.id, /^[0-9a-f-]{36}$/u, 'id 必须是 randomUUID');

    // 平台 fake loop：两个消息都按 user/message append（无 TypeError）。
    const appended = appendDecision(ctx, session, decision);
    assert.equal(appended.length, 2);
    assert.equal(appended[1].seq, 2);

    // 冷读（reopen）：落盘 → 重新解析 → 形状复验 + 召回正文可还原。
    const rows = coldRead(appended);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].data.id, recall.id);
    assert.equal(rows[1].data.source.kind, RECALL_KIND);
    assert.match(rows[1].data.content[0].text, /\[相关记忆\]/u);

    // 同一 turn 的第二步：收到的 messages 已含召回块，不再重复注入。
    const second = turnPayload(session, { id: 'turn-1' }, '谢谢。', 2, decision.messages);
    const again = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    const recalls = (again.messages ?? []).filter((message) => message?.source?.kind === RECALL_KIND);
    assert.equal(recalls.length, 1, '同一 turn 不应重复注入');
    assert.equal(recalls[0].id, recall.id, '不得换新 id 重注入');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('巩固层不把召回块当用户发言：窗口文本只含真实用户消息', async () => {
  const temp = makeTempStore();
  const { ctx, session, streams } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      source_kind: 'turn',
    });

    // turn 1：召回命中，平台把「用户消息 + 召回消息」都 append 进 surface。
    const first = turnPayload(session, { id: 'turn-1' }, '预算额度是多少？');
    const decision = await ctx.dispatch('agent/pre-step', first, {
      kind: 'enter',
      messages: first.messages,
    });
    const recall = decision.messages[1];
    assert.equal(recall.source.kind, RECALL_KIND);
    assert.match(recall.content[0].text, /8000/u);
    appendDecision(ctx, session, decision);

    // turn 2：41K tokens 触发 hard 巩固；窗口应覆盖 turn 1 的用户消息与召回块。
    setTokens(ctx, 41_000);
    const second = turnPayload(session, { id: 'turn-2' }, '继续。');
    const third = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    appendDecision(ctx, session, third);

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const prompt = streams[0].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');

    assert.match(prompt, /预算额度是多少/u, '真实用户发言必须进入巩固窗口');
    assert.doesNotMatch(prompt, /\[相关记忆\]/u, '召回块不得作为用户发言进入巩固窗口');
    assert.doesNotMatch(prompt, /8000/u, '召回块正文不得进入巩固窗口（否则会自我巩固）');
    // 召回块仍在 surface 上（随会话保留到压缩），只是被巩固层排除。
    // 不断言节点总数：后续 turn 是否再召回取决于检索实现（recency 兜底等）。
    const recallEvents = session.events.filter(
      (event) => event.type === 'user/message' && event.data?.source?.kind === RECALL_KIND,
    );
    assert.ok(recallEvents.some((event) => event.data.id === recall.id), '召回声明的召回块必须仍在 surface 上');
    assert.ok(session.surface.nodes.includes(recallEvents[0].seq));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
