/**
 * R-L2：水位锚点 0 的持久化哨兵。
 *
 * 背景：`schema_meta` 的 `watermark_anchor:<scope>` 用 0 表示「清空」，
 * 而重锚到起点时内存水位就是 0。若直接写 0，重启后 `readWatermarkAnchor`
 * 只认 >0，会回退到旧 `upto_seq`，再次 stale、再次归零、重复整段抽取。
 *
 * 修法：有效锚点 0 落库写哨兵 -1；读取时 -1 → 内存水位 0。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { Store } from '../src/memory/store.js';
import { apply, initialWatermark } from '../src/index.js';
import { TEST_NOW, makeTempStore, waitFor } from './e2e/helpers.js';

const DRAFT = {
  episode: {
    title: '旧水位已被压缩',
    summary: '用户确认了预算调整。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [],
  reminders: [],
};

function seedOldWatermark(store, uptoSeq = 9) {
  store.insertConsolidation({
    scope: 'main',
    session_id: 'session-1',
    kind: 'nap',
    trigger: 'idle',
    upto_seq: uptoSeq,
    status: 'written',
    started_at: 1,
  });
}

function memoryStoreWithWatermark(uptoSeq = 9) {
  const store = Store.open(':memory:');
  seedOldWatermark(store, uptoSeq);
  return store;
}

test('R-L2：锚点 -1 是有效锚点，initialWatermark 还原为 0（不看旧 upto_seq）', () => {
  const store = memoryStoreWithWatermark(9);
  try {
    store.setMeta('watermark_anchor:main', '-1');
    assert.equal(initialWatermark(store, 'main'), 0);
    assert.equal(store.getWatermark('main'), 9, '旧巩固行仍在，只是不再决定初始水位');
  } finally {
    store.close();
  }
});

test('R-L2：正数锚点优先于旧 upto_seq', () => {
  const store = memoryStoreWithWatermark(9);
  try {
    store.setMeta('watermark_anchor:main', '2');
    assert.equal(initialWatermark(store, 'main'), 2);
  } finally {
    store.close();
  }
});

test('R-L2：锚点 0 表示已清除，仍回退旧 upto_seq', () => {
  const store = memoryStoreWithWatermark(9);
  try {
    store.setMeta('watermark_anchor:main', '0');
    assert.equal(initialWatermark(store, 'main'), 9);
    store.setMeta('watermark_anchor:main', 'not-a-number');
    assert.equal(initialWatermark(store, 'main'), 9);
  } finally {
    store.close();
  }
});

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
    totalTokens: 1000, surfaceTokens: 1000, nodes: [],
  };
  return { ctx, streams, session };
}

function emitUserText(ctx, session, text) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function turnPayload(session, turn, text) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step: 1,
  };
}

function measure(overrides = {}) {
  return {
    logRevision: 1, baseline: null, surfaceDeltaTokens: 120,
    totalTokens: 1000, surfaceTokens: 1000, nodes: [],
    ...overrides,
  };
}

test('R-L2：无锚点且旧水位失效时，no-history 重锚落库 -1，重启后水位回到 0', async (t) => {
  const temp = makeTempStore(t);
  seedOldWatermark(temp.store, 9);
  const { ctx, session } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    emitUserText(ctx, session, '在吗？');
    await ctx.dispatch('agent/pre-step', turnPayload(session, 1, '在吗？'), { kind: 'enter', messages: [] });

    assert.equal(temp.store.getMeta('watermark_anchor:main'), '-1', '重锚到起点必须写哨兵 -1');
    const reanchors = ctx.logs.filter(
      (entry) => entry.level === 'warn' && String(entry.message).includes('stale watermark re-anchored'),
    );
    assert.equal(reanchors.length, 1);
    assert.equal(reanchors[0].meta.mode, 'no-history');
    assert.equal(reanchors[0].meta.anchor, 0);
  } finally {
    handle.dispose();
  }

  // 模拟重启：新连接只按持久化锚点初始化，不看旧 consolidations.upto_seq。
  const reopened = Store.open(temp.dbPath);
  try {
    assert.equal(reopened.getWatermark('main'), 9);
    assert.equal(initialWatermark(reopened, 'main'), 0);
  } finally {
    reopened.close();
  }
});

test('R-L2：冷启动锚点 -1 不再重锚；巩固成功后清锚点并推进水位', async (t) => {
  const temp = makeTempStore(t);
  seedOldWatermark(temp.store, 9);
  temp.store.setMeta('watermark_anchor:main', '-1');
  const { ctx, streams, session } = makeApplyCtx();
  ctx.returns['tokenMeter.measure'] = measure({
    totalTokens: 41_000, surfaceTokens: 41_000,
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    emitUserText(ctx, session, '我下周要把预算调到 8000。');
    await ctx.dispatch(
      'agent/pre-step',
      turnPayload(session, 1, '我下周要把预算调到 8000。'),
      { kind: 'enter', messages: [] },
    );
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'cold-start consolidation' });

    assert.equal(streams.length, 1);
    assert.equal(
      ctx.logs.some((entry) => entry.level === 'warn' && String(entry.message).includes('stale watermark re-anchored')),
      false,
      '锚点 -1 已说明重锚过，冷启动不应再次重锚',
    );
    assert.equal(temp.store.getMeta('watermark_anchor:main'), '0', '巩固成功后锚点清除');
    assert.equal(temp.store.getWatermark('main'), 1, '推进到新水位，而不是旧 upto_seq 9');
  } finally {
    handle.dispose();
  }
});
