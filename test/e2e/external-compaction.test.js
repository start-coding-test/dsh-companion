/**
 * N-H1/R-M1 回归：水位节点被外部压缩后，巩固不能永久停摆，也不能静默吞掉
 * 尚未巩固的内容。
 *
 * 场景 A（N-H1）：
 *   turn 1 巩固 seq1，水位 = 1；
 *   平台在插件之外压缩 [1,1] → surface 变成 [2]（替换节点），水位 1 失效；
 *   turn 2 pre-step 应重锚到 2 并写 `watermark_anchor:main`，不静默停摆；
 *   turn 3/4 新消息累积后继续巩固，且不会把替换节点 2 重复写进平台摘要。
 *
 * 场景 B（R-M1）：
 *   turn 1 巩固 seq1，水位 = 1；随后写入 seq2、seq3 但未触发巩固；
 *   平台压缩 [1,3] → surface 只剩替换节点 [4]（文本 '[compacted]'）；
 *   下一轮重锚必须把锚点前挪到替换节点之前，让平台摘要进入巩固窗口，
 *   否则 2–3 的内容只剩摘要且被永久跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { TEST_NOW, makeTempStore, waitFor } from './helpers.js';

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

function makeApplyCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW });
  const session = ctx.addSession({ id: 'session-1' });
  ctx.commands = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  ctx.tools = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
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
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1, baseline: null, surfaceDeltaTokens: 120,
    totalTokens: 41_000, surfaceTokens: 41_000, nodes: [],
  };
  return { ctx, streams, session };
}

function emitUserText(ctx, session, text) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
}

/** 不额外写 surface 事件，只构造 pre-step payload（surface 由调用方先行铺好）。 */
function payloadFor(session, turn, text, step = 1) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

function turnPayload(ctx, session, turn, text = '我下周要把预算调到 8000。', step = 1) {
  emitUserText(ctx, session, text);
  return payloadFor(session, turn, text, step);
}

function measure(overrides = {}) {
  return {
    logRevision: 1, baseline: null, surfaceDeltaTokens: 120,
    totalTokens: 1000, surfaceTokens: 1000, nodes: [],
    ...overrides,
  };
}

function promptText(request) {
  return request.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

test('N-H1：外部压缩后重锚并继续巩固，不重复写平台摘要', async () => {
  const temp = makeTempStore();
  const { ctx, streams, session } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // turn 1：正常巩固，水位 = 1。
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1), { kind: 'enter', messages: [] });
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'turn1 consolidation' });
    assert.equal(streams.length, 1);
    assert.equal(Number(temp.store.getMeta('watermark_anchor:main') ?? 0), 0, '初始锚点视为无');

    // 插件之外：平台压缩 [1,1]，追加替换节点 seq=2。
    const compacted = ctx.compactSession(session.id, 1, 1);
    assert.deepEqual(compacted.nodes, [2]);

    // turn 2：低于激活阈值，只重锚，不巩固。
    ctx.returns['tokenMeter.measure'] = measure();
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '收到，先记下。'), {
      kind: 'enter', messages: [],
    });
    assert.equal(temp.store.getMeta('watermark_anchor:main'), '2', '应把新锚点写进 schema_meta');
    assert.equal(temp.store.getWatermark('main'), 1, '重锚只改内存水位，不伪造巩固行');
    assert.equal(streams.length, 1, '低于阈值不应触发巩固');

    // turn 3/4：连续两轮越过阈值 → 从锚点之后继续巩固。
    ctx.returns['tokenMeter.measure'] = measure({ totalTokens: 41_000, surfaceTokens: 41_000 });
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 3, '下周一执行。'), {
      kind: 'enter', messages: [],
    });
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 4, '预算能再确认一下吗？'), {
      kind: 'enter', messages: [],
    });
    await waitFor(() => temp.store.getWatermark('main') >= 4, { label: 'post-reanchor consolidation' });

    assert.equal(streams.length, 2, '重锚后应恢复巩固（一次模型调用）');
    const watermark = temp.store.getWatermark('main');
    assert.ok(watermark >= 4, `水位应推进到新消息，实际 ${watermark}`);
    const rows = temp.store.db
      .prepare("SELECT upto_seq, compaction_start_seq FROM consolidations WHERE scope = 'main' AND kind = 'nap' ORDER BY upto_seq")
      .all();
    assert.ok(!rows.some((row) => row.upto_seq === 2), '替换节点不应被重复巩固');
    assert.equal(rows.at(-1).upto_seq, watermark);

    // 巩固成功后锚点清除。
    assert.equal(Number(temp.store.getMeta('watermark_anchor:main') ?? 0), 0, '锚点清除');
    // 插件自身不应触碰平台压缩（外部压缩除外）。
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('R-M1：外部压缩越过水位时，替换节点（平台摘要）进入巩固', async () => {
  const temp = makeTempStore();
  const { ctx, streams, session } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // turn 1：巩固 seq1，水位 = 1。
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1), { kind: 'enter', messages: [] });
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'turn1 consolidation' });
    assert.equal(streams.length, 1);

    // 写入 seq2、seq3；然后跑同一个 turn 的第二步 pre-step：只刷新 surface 快照，
    // 不开新 turn（避免插件自己的 pending 压缩先把 [1,1] 换成新节点）。
    emitUserText(ctx, session, '第二句要记住。');
    emitUserText(ctx, session, '第三句也要记住。');
    ctx.returns['tokenMeter.measure'] = measure();
    await ctx.dispatch('agent/pre-step', payloadFor(session, 1, '先记一下。', 2), {
      kind: 'enter', messages: [],
    });
    assert.deepEqual(session.surface.nodes, [1, 2, 3], '快照应包含未巩固的 seq2、seq3');
    assert.equal(temp.store.getWatermark('main'), 1, '低于阈值不巩固');
    assert.equal(streams.length, 1);

    // 插件之外：平台压缩 [1,3]（越过水位 1），2–3 未巩固，只剩替换节点 seq=4。
    const compacted = ctx.compactSession(session.id, 1, 3);
    assert.deepEqual(compacted.nodes, [4]);
    assert.equal(compacted.replacement?.data?.content?.[0]?.text, '[compacted]');

    // 下一轮：重锚前挪到替换节点之前，让 '[compacted]' 进入巩固窗口。
    ctx.returns['tokenMeter.measure'] = measure({ totalTokens: 41_000, surfaceTokens: 41_000 });
    await ctx.dispatch('agent/pre-step', payloadFor(session, 2, '刚才聊到哪了？'), {
      kind: 'enter', messages: [],
    });
    await waitFor(() => temp.store.getWatermark('main') >= 4, { label: 'post-lost consolidation' });

    assert.equal(streams.length, 2, '压缩后应继续巩固（一次模型调用）');
    const prompt = promptText(streams[1]);
    assert.match(prompt, /\[compacted\]/u, '替换节点（平台摘要）必须进入巩固输入');

    const rows = temp.store.db
      .prepare("SELECT upto_seq, compaction_start_seq FROM consolidations WHERE scope = 'main' AND kind = 'nap' ORDER BY upto_seq")
      .all();
    assert.deepEqual(rows.map((row) => row.upto_seq), [1, 4], '只巩固新窗口，不重复旧区间');
    assert.equal(rows[1].compaction_start_seq, 4, '巩固窗口从替换节点开始');

    const episodes = temp.store.db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE scope = 'main'")
      .get();
    assert.equal(episodes.n, 2, '每次巩固一条 episode，不重复写入');

    // metrics 可观测：warn 日志带 compactionLostUnconsolidated，/状态 展示丢失量。
    const warn = ctx.logs.find(
      (entry) => entry.level === 'warn' && /compactionLostUnconsolidated/u.test(entry.message),
    );
    assert.ok(warn, '应记录 warn 日志');
    assert.equal(warn.meta.mode, 'replacement-lost');
    assert.equal(warn.meta.lost, 2, 'seq2、seq3 未巩固即被压掉');
    const statusDefinition = ctx.commands.registrations.find((entry) => entry.name === 'status');
    assert.ok(statusDefinition, '/状态 应已注册');
    assert.match(statusDefinition.handler({ rawInput: '' }).text, /未巩固被压缩：2 个节点/u);

    // 巩固成功后锚点清除。
    assert.equal(Number(temp.store.getMeta('watermark_anchor:main') ?? 0), 0, '锚点清除');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
