/**
 * L 级收尾 + M3 的回归测试（卡片 t10）。
 *
 * 覆盖：
 *   - memory_search 的 scope 校验与默认当前 scope；
 *   - thread_run / task_run 的 goal 长度上限（≤2000 码点）；
 *   - thread-unarchive 只发布线程自己的状态板；
 *   - README 链接落回仓库内文档、CHANGELOG 表计数；
 *   - 同一 turn 召回只注入一次，tool 尾巴不再重复注入；
 *   - 线程短名 24 码点边界；
 *   - M3：pre-step 不等待巩固，模型慢也不阻塞本轮回执；
 *   - 巩固失败只 warn，不影响本轮召回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { normalizeThreadName, THREAD_NAME_MAX } from '../../src/thread/registry.js';
import { TEST_NOW, makeTempStore, seedMemory, settle, waitFor } from './helpers.js';

// C-H1：apply 一律经严格 ctx 代理，未声明 inject 的属性读会像真实 cordis 一样抛错。
const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

/**
 * apply 需要的 commands/tools/llm 服务；llm 可延迟或失败。
 * @param {{now?: number, totalTokens?: number, llm?: boolean,
 *          gate?: Promise<void>, failModel?: boolean}} [options]
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeCtx({ now = TEST_NOW, totalTokens = 1000, llm = false, gate = null, failModel = false } = {}) {
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
      listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
      async *stream(request) {
        streams.push(request);
        if (failModel) throw new Error('model down');
        if (gate !== null) await gate;
        yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
        yield { type: 'finish', reason: { kind: 'ok' } };
      },
    };
  }
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
  return { ctx, streams };
}

/**
 * 一轮 pre-step 的 payload；session 可为 null（无会话的旧调用）。
 * @param {object|null} session
 * @param {number} turn
 * @param {object[]} messages
 * @param {number} [step]
 * @returns {object}
 */
function turnPayload(session, turn, messages, step = 1) {
  return {
    ...(session === null ? {} : { agent: { id: session.id, session } }),
    messages,
    turn,
    step,
  };
}

/** 拼出 pre-step 决策里的文本。 */
function decisionText(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  return messages
    .flatMap((message) => {
      if (Array.isArray(message?.content)) return message.content;
      return message?.type === 'text' ? [message] : [];
    })
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\\n');
}

/** 找到注册过的工具。 */
function toolOf(ctx, name) {
  return ctx.tools.registrations.find((tool) => tool.name === name);
}

test('memory_search：显式跨 scope 返回 scope_denied，未传时用当前 thread scope', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const threadSession = ctx.addSession({ id: 'thread-1' });
  temp.store.upsertThread({
    key: 'study',
    name: '研究',
    session_id: 'thread-1',
    description: '线程：研究',
    last_active_at: Math.floor(TEST_NOW / 1000),
    status: 'active',
  });
  seedMemory(temp.store, { now: TEST_NOW, scope: 'main', statement: '蓝鲸是海洋哺乳动物。' });
  seedMemory(temp.store, { now: TEST_NOW, scope: 'thread:study', statement: '极光出现在高纬度夜空。' });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await ctx.dispatch(
      'agent/pre-step',
      turnPayload(threadSession, 1, [{ role: 'user', content: [{ type: 'text', text: '极光在哪里？' }] }]),
      { kind: 'enter', messages: [] },
    );
    const search = toolOf(ctx, 'memory_search');

    const own = await search.execute({ query: '极光' });
    assert.ok(own.items.some((item) => /极光/u.test(item.text)), '默认应检索当前 thread scope');

    const denied = await search.execute({ query: '极光', scope: 'main' });
    assert.deepEqual(denied, { ok: false, reason: 'scope_denied', scope: 'main' });
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('thread_run：goal 超过 2000 码点返回 goal_too_long，恰好 2000 通过', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, cwd: REPO_ROOT });
  try {
    const threadRun = toolOf(ctx, 'thread_run');
    assert.ok(threadRun);

    const tooLong = await threadRun.execute({ key: 'new', name: '长目标', goal: '好'.repeat(2001) });
    assert.deepEqual(tooLong, { ok: false, reason: 'goal_too_long' });

    temp.store.upsertThread({
      key: 'study-goal',
      name: '研究目标',
      session_id: 'thread-goal',
      description: '线程：研究目标',
      last_active_at: Math.floor(TEST_NOW / 1000),
      status: 'active',
    });
    const accepted = await threadRun.execute({ key: 'study-goal', goal: '好'.repeat(2000) });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.action, 'reuse');
    assert.equal(accepted.prompted, true);
    assert.equal(Array.from(ctx.callsOf('sessionController.prompt').at(-1).args[0].content[0].text).length, 2000);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('task_run：沿用执行器的 2000 码点上限（超限抛 TypeError）', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, cwd: REPO_ROOT });
  try {
    const taskRun = toolOf(ctx, 'task_run');
    await assert.rejects(() => taskRun.execute({ goal: '嗯'.repeat(2001) }), TypeError);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('thread-unarchive 只发布线程自己的状态板，不动 main 板', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  ctx.workspaceRegistry.unarchiveSession = async (sessionId) => ({ sessionId, archived: false });
  const handle = apply(ctx, { dbPath: temp.dbPath, cwd: REPO_ROOT });
  try {
    temp.store.upsertThread({
      key: 'study',
      name: '研究',
      session_id: 'thread-archived',
      description: '线程：研究',
      last_active_at: Math.floor(TEST_NOW / 1000),
      status: 'archived',
    });
    const at = Math.floor(TEST_NOW / 1000);
    temp.store.setStagedBoard('thread:study', '线程板内容', { now: at });
    temp.store.setStagedBoard('main', '主板内容', { now: at });

    const result = await toolOf(ctx, 'thread_run').execute({ key: 'study' });
    assert.equal(result.ok, true);
    assert.equal(result.reactivated, true);

    const threadBoard = temp.store.getBoardState('thread:study');
    assert.equal(threadBoard.revision, 1, '应发布线程自己的板');
    assert.equal(temp.store.getBoard('thread:study'), '线程板内容');
    assert.equal(temp.store.getBoardState('main').revision, 0, 'main 板不应被发布');
    assert.equal(temp.store.getBoard('main'), '');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('README 链接全部落在仓库内且目标存在，不再引用 ../memory', () => {
  const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\.\.\/memory\//u);
  const links = [...readme.matchAll(/\]\(([^)#]+\.md)\)/gu)].map((match) => match[1]);
  assert.ok(links.length >= 4, 'README 应保留设计文档索引');
  for (const link of links) {
    if (/^https?:/u.test(link)) continue;
    const target = resolve(REPO_ROOT, link);
    assert.equal(existsSync(target), true, `README 链接目标不存在：${link}`);
  }
});

test('CHANGELOG 表计数为 8 业务表 + state_board_rev + schema_meta + 2 FTS', () => {
  const changelog = readFileSync(resolve(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /8 业务表 \+ state_board_rev \+ schema_meta \+ 2 FTS/u);
});

test('同一 turn 只注入一次召回；tool 尾巴与后续 step 都不重复注入', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  seedMemory(temp.store, { now: TEST_NOW, statement: '蓝鲸是海洋哺乳动物。' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const user = { role: 'user', content: [{ type: 'text', text: '蓝鲸是什么动物？' }] };
    const first = await ctx.dispatch('agent/pre-step', turnPayload(session, 1, [user]), { kind: 'enter', messages: [] });
    assert.match(decisionText(first), /\[相关记忆\]/u);

    const second = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 1, [user, { role: 'assistant', content: [{ type: 'text', text: '蓝鲸是哺乳动物。' }] }], 2),
      { kind: 'enter', messages: [] },
    );
    assert.doesNotMatch(decisionText(second), /\[相关记忆\]/u, '同一 turn 的后续 step 不应重复注入');

    const toolTail = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 2, [user, { role: 'assistant', content: [{ type: 'text', text: '查询中。' }] }, { role: 'tool', content: [{ type: 'text', text: '结果' }] }]),
      { kind: 'enter', messages: [] },
    );
    assert.doesNotMatch(decisionText(toolTail), /\[相关记忆\]/u, 'tool 尾巴不注入');

    const afterTool = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 2, [user, { role: 'assistant', content: [{ type: 'text', text: '查询完成。' }] }], 2),
      { kind: 'enter', messages: [] },
    );
    assert.doesNotMatch(decisionText(afterTool), /\[相关记忆\]/u, 'tool 尾巴所在 turn 已标记为已注入');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('线程短名边界：25 码点截到 24，24 码点保持原样', () => {
  const name = '研'.repeat(THREAD_NAME_MAX + 1);
  assert.equal(Array.from(normalizeThreadName(name)).length, THREAD_NAME_MAX);
  assert.equal(normalizeThreadName('研'.repeat(THREAD_NAME_MAX)), '研'.repeat(THREAD_NAME_MAX));
});

test('M3：pre-step 不等待巩固，慢模型不阻塞本轮回执', async () => {
  const temp = makeTempStore();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { ctx, streams } = makeCtx({ totalTokens: 41_000, llm: true, gate });
  const session = ctx.addSession({ id: 'session-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // 平台语义：user 消息在 pre-step 前已 commit 进 session surface。
    ctx.emitSessionEvent(session.id, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] },
    });
    const started = Date.now();
    const decision = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 1, [{ role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] }]),
      { kind: 'enter', messages: [] },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `pre-step 不应等待模型，实际 ${elapsed}ms`);
    assert.equal(typeof decision, 'object');

    await waitFor(() => streams.length === 1, { label: 'background model call' });
    release();
    await waitFor(() => temp.store.getWatermark('main') > 0, { label: 'background consolidation' });
    assert.equal(temp.store.listFacts({ scope: 'main', status: 'active' }).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('M3：巩固失败只 warn，本轮召回与回执不受影响', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx({ totalTokens: 41_000, llm: true, failModel: true });
  const session = ctx.addSession({ id: 'session-1' });
  seedMemory(temp.store, { now: TEST_NOW, statement: '蓝鲸是海洋哺乳动物。' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    ctx.emitSessionEvent(session.id, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '蓝鲸是什么动物，它们生活在哪里？' }] },
    });
    const decision = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 1, [{ role: 'user', content: [{ type: 'text', text: '蓝鲸是什么动物，它们生活在哪里？' }] }]),
      { kind: 'enter', messages: [] },
    );
    assert.match(decisionText(decision), /蓝鲸/u, '巩固失败不能影响本轮召回');
    await settle(150);
    await waitFor(() => streams.length === 1, { label: 'failed model call' });
    const warn = await waitFor(
      () => ctx.logs.find((entry) => entry.level === 'warn' && /consolidation failed/u.test(entry.message)),
      { label: 'consolidation failure warn' },
    );
    assert.match(String(warn.meta?.message ?? ''), /model down/u);
    assert.equal(temp.store.getWatermark('main'), 0);
    await settle();
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
