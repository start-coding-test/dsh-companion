/**
 * N-H1 回归：水位节点被外部压缩后，巩固不能永久停摆。
 *
 * 场景（真实插件入口）：
 *   turn 1 巩固 seq1，水位 = 1；
 *   平台在插件之外压缩 [1,1] → surface 变成 [2]（替换节点），水位 1 失效；
 *   turn 2 pre-step 应重锚到 2 并写 `watermark_anchor:main`，不静默停摆；
 *   turn 3/4 新消息累积后继续巩固，且不会把替换节点 2 重复写进平台摘要。
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

function turnPayload(ctx, session, turn, text = '我下周要把预算调到 8000。', step = 1) {
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

function measure(overrides = {}) {
  return {
    logRevision: 1, baseline: null, surfaceDeltaTokens: 120,
    totalTokens: 1000, surfaceTokens: 1000, nodes: [],
    ...overrides,
  };
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
