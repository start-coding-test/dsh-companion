/**
 * H3 生产路径 e2e：main / thread / subagent 三类会话走同一个 apply()。
 *
 * 覆盖：main/thread 记忆隔离、thread 巩固只写 thread scope、
 * subagent 零召回零写库且工具拒绝、未知主会话仍按 main。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, waitFor } from './helpers.js';

// C-H1：apply 一律经严格 ctx 代理，未声明 inject 的属性读会像真实 cordis 一样抛错。
const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const DRAFT = {
  episode: {
    title: '预算调整',
    summary: '用户把项目预算调到 8000。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      salience: 'normal',
    },
  ],
  reminders: [],
};

/** @param {Store} store @param {string} scope @param {string} statement */
function seedFact(store, scope, statement) {
  return store.insertFact({
    scope,
    kind: 'knowledge',
    subject_text: statement.slice(0, 2),
    predicate: '是',
    object_text: statement,
    statement,
    source_kind: 'user_explicit',
  });
}

/**
 * @param {{now?: number, tokens?: number, llm?: boolean}} [options]
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeCtx({ now = TEST_NOW, tokens = 0, llm = false } = {}) {
  const ctx = new FakeCtx({ now });
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
  if (llm) {
    ctx.llm = {
      listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
      listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
      async *stream(request) {
        streams.push(request);
        yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
        yield { type: 'finish', reason: { kind: 'ok' } };
      },
    };
  }
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: tokens,
    totalTokens: tokens,
    surfaceTokens: tokens,
    nodes: [],
  };
  return { ctx, streams };
}

/** @param {FakeCtx} ctx @param {object} session @param {number} turn @param {string} text @param {number} [step] */
function payload(ctx, session, turn, text, step = 1) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** @param {object|null|undefined} decision @returns {string} */
function decisionText(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  return messages
    .flatMap((message) => {
      if (Array.isArray(message?.content)) return message.content;
      return message?.type === 'text' ? [message] : [];
    })
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** @param {FakeCtx} ctx @param {string} name */
function toolOf(ctx, name) {
  return ctx.tools.registrations.find((tool) => tool.name === name);
}

test('main/thread 隔离：同一进程内各自召回自己的 facts，线程不串主记忆', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const mainSession = ctx.addSession({ id: 'main-1' });
  const threadSession = ctx.addSession({ id: 'thread-1' });
  temp.store.upsertThread({
    key: 'study',
    name: '研究',
    session_id: 'thread-1',
    description: '线程：研究',
    last_active_at: Math.floor(TEST_NOW / 1000),
    status: 'active',
  });
  seedFact(temp.store, 'main', '蓝鲸是海洋哺乳动物');
  seedFact(temp.store, 'thread:study', '极光出现在高纬度夜空');

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const main = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, mainSession, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.match(decisionText(main), /蓝鲸是海洋哺乳动物/u);

    const thread = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, threadSession, 1, '极光在哪里出现？'),
      { kind: 'enter', messages: [] },
    );
    const threadText = decisionText(thread);
    assert.match(threadText, /极光出现在高纬度夜空/u);
    assert.doesNotMatch(threadText, /蓝鲸是海洋哺乳动物/u);

    // 同一个 turn 号不会因为 main 已经注入而抑制 thread 注入（按 scope 去重）。
    const threadOther = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, threadSession, 2, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.doesNotMatch(decisionText(threadOther), /蓝鲸是海洋哺乳动物/u);

    assert.equal(temp.store.getMeta('main_session_id'), 'main-1');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('thread 巩固只写 thread scope，main 水位与事实不受影响', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx({ tokens: 41_000, llm: true });
  const mainSession = ctx.addSession({ id: 'main-1' });
  const threadSession = ctx.addSession({ id: 'thread-1' });
  temp.store.upsertThread({
    key: 'budget',
    name: '预算',
    session_id: 'thread-1',
    description: '线程：预算',
    last_active_at: Math.floor(TEST_NOW / 1000),
    status: 'active',
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, threadSession, 1, '我下周要把预算调到 8000。'),
      { kind: 'enter', messages: [] },
    );
    // M3：巩固在 step 之后异步执行，等它落地再断言。
    await waitFor(() => temp.store.getWatermark('thread:budget') === 1, { label: 'thread consolidation' });
    assert.equal(streams.length, 1, 'thread 的巩固应调用模型一次');
    assert.equal(temp.store.listFacts({ scope: 'main' }).length, 0);
    const threadFacts = temp.store.listFacts({ scope: 'thread:budget' });
    assert.equal(threadFacts.length, 1);
    assert.match(threadFacts[0].statement, /8000/u);
    assert.equal(temp.store.getWatermark('main'), 0);
    assert.equal(temp.store.getWatermark('thread:budget'), 1);
    assert.ok(temp.store.getBoardState('thread:budget').staged_revision >= 1);
    assert.equal(temp.store.getBoard('main'), '');

    // main 的 turn 1 仍可独立巩固；thread 已写的事实保持一份。
    await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, mainSession, 1, '我下周要把预算调到 9000。'),
      { kind: 'enter', messages: [] },
    );
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'main consolidation' });
    assert.equal(temp.store.listFacts({ scope: 'thread:budget' }).length, 1);
    assert.equal(temp.store.listFacts({ scope: 'main' }).length, 1);
    assert.equal(temp.store.getWatermark('thread:budget'), 1);
    assert.equal(temp.store.getWatermark('main'), 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('subagent：pre-step 直接跳过（零召回、零模型、零写库），记忆工具 scope_denied', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx({ tokens: 41_000, llm: true });
  const mainSession = ctx.addSession({ id: 'main-1' });
  const subSession = ctx.addSession({
    id: 'sub-1',
    header: { version: 4, id: 'sub-1', origin: 'subagent', parentSession: 'main-1', delegationDepth: 1 },
  });
  seedFact(temp.store, 'main', '蓝鲸是海洋哺乳动物');
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const decision = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, subSession, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.equal(decisionText(decision), '');
    assert.equal(streams.length, 0);
    assert.equal(temp.store.listFacts({ scope: 'main' }).length, 1);
    assert.equal(temp.store.getMeta('main_session_id'), null);
    assert.equal(temp.store.getBoard('main'), '');

    const write = toolOf(ctx, 'memory_write');
    assert.ok(write);
    assert.deepEqual(
      await write.execute({ statement: '子会话不该记住' }),
      { ok: false, reason: 'scope_denied', scope: null },
    );

    // 主会话随后仍是 main（subagent 没有抢占 main_session_id）。
    const main = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, mainSession, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.match(decisionText(main), /蓝鲸是海洋哺乳动物/u);
    assert.equal(temp.store.getMeta('main_session_id'), 'main-1');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('未知主会话在收到真实用户输入后重绑 main_session_id（latest-user）', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const first = ctx.addSession({ id: 'main-1' });
  const second = ctx.addSession({ id: 'main-2' });
  seedFact(temp.store, 'main', '蓝鲸是海洋哺乳动物');
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, first, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    const decision = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, second, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.match(decisionText(decision), /蓝鲸是海洋哺乳动物/u);
    // 默认 latest-user：第二个带真实用户输入的会话成为主会话。
    assert.equal(temp.store.getMeta('main_session_id'), 'main-2');
    assert.ok(
      ctx.logs.some((row) => row.level === 'info' && /rebound/iu.test(row.message)),
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('session.mainBinding=first：未知主会话保持只告警不重绑', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const first = ctx.addSession({ id: 'main-1' });
  const second = ctx.addSession({ id: 'main-2' });
  seedFact(temp.store, 'main', '蓝鲸是海洋哺乳动物');
  const handle = apply(ctx, {
    dbPath: temp.dbPath,
    retainTokens: 4,
    session: { mainBinding: 'first' },
  });
  try {
    await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, first, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    const decision = await ctx.dispatch(
      'agent/pre-step',
      payload(ctx, second, 1, '蓝鲸是什么动物？'),
      { kind: 'enter', messages: [] },
    );
    assert.match(decisionText(decision), /蓝鲸是海洋哺乳动物/u);
    assert.equal(temp.store.getMeta('main_session_id'), 'main-1');
    assert.ok(ctx.logs.some((row) => row.level === 'warn' && /main/iu.test(row.message)));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
