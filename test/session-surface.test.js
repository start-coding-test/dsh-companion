/**
 * H1：surface 索引与巩固窗口选区的单元测试。
 *
 * 平台事实见 docs/h1-h3-probe.md：`session.surface.nodes` 只有 seq、
 * `measure().nodes` 只有 seq+token、正文只能靠 `session/event` 或 `sessionQuery.readSurface()`。
 * 这里不启动插件，只锁 surface.js 的纯函数与索引行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSOLIDATION_TAIL_TOKENS,
  createSurfaceIndex,
  flattenMessage,
  planRegion,
  surfaceSeqs,
  watermarkAfterCompact,
} from '../src/session/surface.js';
import { FakeCtx } from './fakes/ctx.js';

/** 造一条 user 消息事件。 @param {string} text @returns {object} */
function userEvent(text) {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } };
}

/**
 * 造快照：seqs 与每节点 token 一一对应。
 * @param {Array<[number, number]>} pairs [seq, tokens]
 * @param {{missing?: number[]}} [options]
 * @returns {{seqs: number[], nodes: object[], records: object[]}}
 */
function snapshotOf(pairs, options = {}) {
  const missing = new Set(options.missing ?? []);
  return {
    seqs: pairs.map(([seq]) => seq),
    nodes: pairs.map(([seq, tokens]) => ({ seq, tokens, heuristicTokens: tokens })),
    records: pairs.map(([seq, tokens]) => ({
      seq,
      role: 'user',
      text: missing.has(seq) ? '' : `文本-${seq}`,
      tokens,
      missing: missing.has(seq),
    })),
  };
}

test('flattenMessage 只拼文本块，工具调用/结果保留一行摘要', () => {
  assert.equal(flattenMessage(null), '');
  assert.equal(flattenMessage('裸字符串'), '裸字符串');
  assert.equal(
    flattenMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: '先查一下' },
        { type: 'tool-call', name: 'memory_search' },
        { type: 'tool-result' },
        { type: 'text', text: '再回答' },
      ],
    }),
    '先查一下\n[tool call memory_search]\n[tool result]\n再回答',
  );
  assert.equal(flattenMessage({ content: [{ type: 'image', data: 'x' }] }), '');
});

test('surfaceSeqs 读 session.surface.nodes，忽略非数字与缺失 surface', () => {
  assert.deepEqual(surfaceSeqs({ surface: { nodes: [7, 8, 9] } }), [7, 8, 9]);
  assert.deepEqual(surfaceSeqs({ surface: { nodes: [7, 'x', null, 9] } }), [7, 9]);
  assert.deepEqual(surfaceSeqs({}), []);
  assert.deepEqual(surfaceSeqs(null), []);
});

test('planRegion：空 surface 返回 empty-surface', () => {
  const plan = planRegion(snapshotOf([]));
  assert.equal(plan.region, null);
  assert.equal(plan.reason, 'empty-surface');
});

test('planRegion：seq 不是 log 下标，窗口用 surface seq 表达', () => {
  // seq 从 7 开始（前面 6 条是 system/lifecycle 投影，不在 surface 里）。
  const plan = planRegion(snapshotOf([[7, 10], [8, 10], [9, 10]]), { budgetTokens: 10 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 7);
  assert.equal(plan.region.endSeq, 8, '尾部 10 token（seq 9）应留在 surface 里');
  assert.equal(plan.region.count, 2);
  assert.equal(plan.region.tokens, 20);
  assert.match(plan.region.text, /user: 文本-7/u);
});

test('planRegion：水位按位置比较，压缩后可非单调 seq', () => {
  // 压缩后替换节点追加在末尾，可见 seq 可能非单调（catalog:627-632）。
  const snapshot = snapshotOf([[100, 10], [101, 10], [5, 10]]);
  const plan = planRegion(snapshot, { afterSeq: 101, budgetTokens: 0 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 5);
  assert.equal(plan.region.endSeq, 5);
});

test('planRegion：水位已不在 surface → stale-watermark（不从头重来）', () => {
  const plan = planRegion(snapshotOf([[2, 10], [3, 10]]), { afterSeq: 1, budgetTokens: 0 });
  assert.equal(plan.region, null);
  assert.equal(plan.reason, 'stale-watermark');
});

test('planRegion：尾部预算吞掉全部节点 → inside-tail', () => {
  const plan = planRegion(snapshotOf([[1, 100], [2, 100]]), { budgetTokens: CONSOLIDATION_TAIL_TOKENS });
  assert.equal(plan.region, null);
  assert.equal(plan.reason, 'inside-tail');
  // 跨过预算的节点留在尾部，因此 tailStartIdx 指向它。
  assert.equal(plan.tailStartIdx, 0);
});

test('planRegion：缺正文的节点计入 missing，交由调用方降级', () => {
  const plan = planRegion(snapshotOf([[1, 10], [2, 10]], { missing: [2] }), { budgetTokens: 0 });
  assert.equal(plan.region.count, 2);
  assert.equal(plan.region.missing, 1);
});

test('watermarkAfterCompact：替换节点取最大新 seq，整段重映射按位置，空 surface 归零', () => {
  assert.equal(watermarkAfterCompact({ newSeqs: [2, 3, 4], oldSeqs: [1, 2, 3], startIdx: 0 }), 4);
  assert.equal(watermarkAfterCompact({ newSeqs: [100, 101], oldSeqs: [1, 2, 3], startIdx: 0 }), 101);
  assert.equal(watermarkAfterCompact({ newSeqs: [2, 3], oldSeqs: [1, 2, 3], startIdx: 0 }), 2);
  assert.equal(watermarkAfterCompact({ newSeqs: [], oldSeqs: [1], startIdx: 0 }), 0);
});

test('createSurfaceIndex：session/event 增量记录，snapshot 对齐 seq 并带正文', async () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const index = createSurfaceIndex({ platform: { estimateMessage: (message) => FakeCtx.textOf(message).length } });
  ctx.on('session/event', (emitted, event) => index.record(emitted, event));

  ctx.emitSessionEvent('session-1', userEvent('第一句'));
  assert.equal(index.size(), 1);
  assert.equal(index.sessionIdOf(session), 'session-1');

  const snapshot = await index.snapshot(session);
  assert.deepEqual(snapshot.seqs, [1]);
  assert.equal(snapshot.records[0].text, '第一句');
  assert.equal(snapshot.nodes[0].tokens, 3, 'estimateMessage 覆盖默认的 len/2 估算');
  assert.equal(snapshot.missing, 0);
});

test('createSurfaceIndex：seq 列表优先取 tokenMeter.measure().nodes，缺省回退 surface.nodes', async () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const index = createSurfaceIndex({ platform: {} });
  ctx.on('session/event', (emitted, event) => index.record(emitted, event));
  ctx.emitSessionEvent('session-1', userEvent('实时消息'));

  const measured = await index.snapshot(session, {
    measured: [{ seq: 5, tokens: 40, heuristicTokens: 40 }],
  });
  assert.deepEqual(measured.seqs, [5], '平台计量节点是 seq 的权威来源');
  assert.equal(measured.nodes[0].tokens, 40);
  assert.equal(measured.missing, 1, 'seq 5 没有正文记录，交由调用方降级');

  const fallback = await index.snapshot(session, { allowRebuild: false });
  assert.deepEqual(fallback.seqs, [...session.surface.nodes], '没有计量结果时退回 surface.nodes');
});

test('createSurfaceIndex：冷启动缺正文时用 sessionQuery.readSurface 回填一次', async () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({ id: 'session-1', events: [userEvent('历史一'), userEvent('历史二')] });
  const index = createSurfaceIndex({
    platform: { readSurface: (sessionId) => ctx.sessionQuery.readSurface(sessionId) },
  });

  // 没有任何 session/event 记录 → 缺正文 → 自动回填。
  const snapshot = await index.snapshot(session);
  assert.deepEqual(snapshot.seqs, [1, 2]);
  assert.equal(snapshot.records[1].text, '历史二');
  assert.equal(snapshot.missing, 0);
  assert.equal(ctx.callsOf('sessionQuery.readSurface').length, 1);

  await index.snapshot(session);
  assert.equal(ctx.callsOf('sessionQuery.readSurface').length, 1, '同一会话只回填一次');
});

test('createSurfaceIndex：没有 sessionQuery 时保留 missing，调用方可降级', async () => {
  const ctx = new FakeCtx({ missing: ['sessionQuery'] });
  const session = ctx.addSession({ id: 'session-1', nodes: [9] });
  const index = createSurfaceIndex({ platform: ctx });
  const snapshot = await index.snapshot(session);
  assert.deepEqual(snapshot.seqs, [9]);
  assert.equal(snapshot.missing, 1);
  assert.equal(snapshot.records[0].missing, true);
});

test('createSurfaceIndex：invalidate 丢弃会话索引，record 忽略异常事件', () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const index = createSurfaceIndex({ platform: ctx });
  ctx.on('session/event', (emitted, event) => index.record(emitted, event));
  ctx.emitSessionEvent('session-1', userEvent('hi'));
  assert.equal(index.size(), 1);
  assert.equal(index.record(session, null), null);
  assert.equal(index.record(null, userEvent('x')), null);
  assert.equal(index.invalidate('session-1'), true);
  assert.equal(index.size(), 0);
});
