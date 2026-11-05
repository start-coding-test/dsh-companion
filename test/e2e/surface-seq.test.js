/**
 * H1：巩固/压缩/水位全部走 surface seq 的生产路径 e2e。
 *
 * 覆盖点（任务 t6）：
 *   - seq 是 surface 位置，不是 log 下标（这里故意从 7 开始）；
 *   - 尾部保留区（retainTokens，默认 6,144）内的消息不进入巩固窗口；
 *   - 水位是 seq，压缩后旧 seq 消失、水位改写为新 seq 空间里的位置；
 *   - pending 区间被外部压缩替换掉时丢弃，不重试旧 seq；
 *   - 冷启动靠 sessionQuery.readSurface() 回填正文；
 *   - 正文不可得时降级跳过，不写半截 episode。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle, waitFor } from './helpers.js';

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

/**
 * @param {{now?: number, totalTokens?: number}} [options]
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeCtx({ now = TEST_NOW, totalTokens = 41_000, missing = [] } = {}) {
  const ctx = new FakeCtx({ now, missing });
  ctx.commands = { register: () => () => {} };
  ctx.tools = { register: () => () => {} };
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream(request) {
      streams.push(request);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  // 只改总量，surface 节点仍由假会话真实计算。
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
 * 造一条 user 事件（可指定 seq，模拟 surface 位置 ≠ log 下标）。
 * @param {string} text
 * @param {number} [seq]
 * @returns {object}
 */
function userEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/**
 * dispatch 一个含 agent.session 的 pre-step。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {number} turn
 * @param {string} text
 * @param {number} [step]
 * @returns {Promise<object>}
 */
async function preStep(ctx, session, turn, text, step = 1) {
  ctx.emitSessionEvent(session.id, userEvent(text));
  return ctx.dispatch(
    'agent/pre-step',
    {
      agent: { id: session.id, session },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      turn,
      step,
    },
    { kind: 'enter', messages: [] },
  );
}

test('巩固/压缩按 surface seq 选区：seq 从 7 开始也不当成 log 下标', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const session = ctx.addSession({
    id: 'session-1',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // turn 1：窗口 = 水位之后到 tail 起点，全部按 surface seq。
    await preStep(ctx, session, 1, '我下周要把预算调到 8000。');
    // M3：巩固在 step 之后异步执行，等它落地再断言。
    await waitFor(() => temp.store.getWatermark('main') === 9, { label: 'consolidation' });
    const row = temp.store.db
      .prepare("SELECT turn_from, turn_to, upto_seq FROM consolidations WHERE kind = 'nap'")
      .get();
    assert.ok(row, '应写入一条巩固行');
    assert.equal(row.turn_from, 7, '窗口起点取 surface seq，不是 1');
    assert.equal(row.turn_to, 9, '窗口一直取到当前 surface 末尾（跨过预算的节点留在窗口内）');
    assert.equal(row.upto_seq, 9);

    // turn 2：压缩 [7,9] → 平台追加替换节点 seq 10，水位在新空间里重定目标。
    await preStep(ctx, session, 2, '现在额度是多少？');
    const calls = ctx.callsOf('compaction.compactRegion');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), [7, 9]);
    assert.deepEqual(session.surface.nodes, [10, 11]);
    assert.equal(temp.store.getWatermark('main'), 11, '水位应改写为新 surface 里的替换节点 seq');
    const retargeted = temp.store.db
      .prepare("SELECT upto_seq, compaction_start_seq, status FROM consolidations WHERE kind = 'nap'")
      .get();
    assert.equal(retargeted.status, 'compacted');
    assert.equal(retargeted.upto_seq, 11);
    assert.equal(retargeted.compaction_start_seq, 7);
    await settle();
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('pending 区间被外部压缩替换后丢弃，不重试旧 seq', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const session = ctx.addSession({ id: 'session-1', events: [userEvent('更早的一条长消息，足够进入巩固窗口。', 1)] });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await preStep(ctx, session, 1, '第一条消息，用来触发巩固窗口。');
    await waitFor(() => temp.store.getWatermark('main') === 2, { label: 'consolidation' });
    const pending = temp.store.db
      .prepare("SELECT status FROM consolidations WHERE kind = 'nap'")
      .get();
    assert.equal(pending.status, 'written');
    assert.deepEqual(session.surface.nodes, [1, 2]);

    // 外部（别的窗口/别的压缩器）把起点替换成 seq 100：旧水位 seq 1 消失。
    ctx.compactSession(session.id, 1, 1, { remap: [100] });
    assert.deepEqual(session.surface.nodes, [100]);

    await preStep(ctx, session, 2, '第二条。');
    await settle();
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0, '旧区间不应再调用 compactRegion');
    const warned = ctx.logs.find((entry) => /pending compaction region expired/u.test(entry.message));
    assert.ok(warned, '应 warn 丢弃过期 pending');
    assert.equal(warned.level, 'warn');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('冷启动：索引为空时用 sessionQuery.readSurface 回填正文后照常巩固', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx();
  // 直接造 surface + 事件，不触发 session/event ⇒ 索引里没有任何记录。
  const session = ctx.addSession({
    id: 'session-1',
    events: [userEvent('历史对话一。', 3), userEvent('历史对话二。', 4)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await preStep(ctx, session, 1, '新的一轮。');
    assert.equal(ctx.callsOf('sessionQuery.readSurface').length, 1, '冷启动应回填一次');
    await waitFor(() => streams.length === 1, { label: 'consolidation stream' });
    assert.equal(streams.length, 1, '回填后应照常巩固');
    const row = temp.store.db.prepare("SELECT turn_from, turn_to FROM consolidations WHERE kind = 'nap'").get();
    assert.equal(row.turn_from, 3);
    assert.equal(row.turn_to, 4);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('正文不可得时降级跳过，不写半截 episode', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx({ missing: ['sessionQuery'] }); // 既没有实时事件，也没有回填通道
  const session = ctx.addSession({ id: 'session-1', events: [userEvent('历史。', 1), userEvent('历史二。', 2)] });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await preStep(ctx, session, 1, '新的一轮。');
    const warn = await waitFor(
      () => ctx.logs.find((entry) => /surface text incomplete/u.test(entry.message)),
      { label: 'surface text incomplete log' },
    );
    assert.equal(streams.length, 0, '正文缺失时不应调用巩固模型');
    const count = temp.store.db.prepare("SELECT COUNT(*) AS n FROM consolidations WHERE kind = 'nap'").get();
    assert.equal(Number(count.n), 0);
    assert.ok(warn, '应 warn 说明跳过原因');
    assert.equal(warn.level, 'warn', 'web 宿主只看 info+，跳过原因必须是 warn');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('默认尾部保留区 6,144 tokens：超出部分留在 surface', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const big = (label) => `${label}${'细节'.repeat(4000)}`; // 约 4,000 tokens/节点
  const session = ctx.addSession({
    id: 'session-1',
    events: [userEvent(big('一'), 1), userEvent(big('二'), 2), userEvent(big('三'), 3)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath }); // 默认 retainTokens = 6,144
  try {
    await preStep(ctx, session, 1, '收个尾。');
    await waitFor(() => temp.store.getWatermark('main') > 0, { label: 'consolidation' });
    const row = temp.store.db.prepare("SELECT turn_from, turn_to FROM consolidations WHERE kind = 'nap'").get();
    assert.ok(row, '应巩固');
    assert.equal(row.turn_from, 1);
    // 尾部从后往前累：seq 4(新消息) + seq 3 已经超预算，窗口止于 seq 2。
    assert.equal(row.turn_to, 2, '最后 6,144 tokens 不应进入巩固窗口');
    const kept = session.surface.nodes.slice(-2);
    assert.deepEqual(kept, [3, 4]);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
