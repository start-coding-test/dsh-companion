/**
 * V7-M1：压缩区间起点必须跳过 surface 的系统/前导节点。
 *
 * 宿主把 surface 节点 0 的系统提示词视为不可替换，压缩区间覆盖它会直接抛
 * `surface replace: node 0 holds the system prompt ...`。本文件覆盖两层：
 *   1) planRegion / firstReplaceableIndex 的纯函数契约（常规巩固、deep-sleep 共用）；
 *   2) apply 生产路径上 pending 恢复后的 compactRegion 调用点（当前唯一调用点）。
 *
 * S1 定向路径（显式遗忘）走的是 consolidate({kind:'forget_flush'})，
 * 不构造 surface region、也不调用 compactRegion，因此无独立的 region 收紧点；
 * 这里用「无可用节点不压缩」的用例保证任何压缩路径都不会把系统节点带进去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { CONSOLIDATION_TAIL_TOKENS, firstReplaceableIndex, planRegion } from '../src/session/surface.js';

import { TEST_NOW, makeTempStore } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/**
 * 造带 role 的快照。
 * @param {Array<{seq: number, role: string, tokens: number}>} entries
 * @returns {{seqs: number[], nodes: object[], records: object[]}}
 */
function snapshotOf(entries) {
  return {
    seqs: entries.map((entry) => entry.seq),
    nodes: entries.map((entry) => ({ seq: entry.seq, tokens: entry.tokens })),
    records: entries.map((entry) => ({
      seq: entry.seq,
      role: entry.role,
      text: `${entry.role}-${entry.seq}`,
      tokens: entry.tokens,
      missing: false,
    })),
  };
}

test('planRegion：首个节点是 system 且 tokens 很大时，起点推进到其后第一个非系统节点', () => {
  // 系统提示词 9,000 tokens（远超 6,144 尾部预算），后面 4 条 user 各 3,000。
  const snapshot = snapshotOf([
    { seq: 1, role: 'system', tokens: 9000 },
    { seq: 2, role: 'user', tokens: 3000 },
    { seq: 3, role: 'assistant', tokens: 3000 },
    { seq: 4, role: 'user', tokens: 3000 },
    { seq: 5, role: 'assistant', tokens: 3000 },
  ]);
  const plan = planRegion(snapshot, { budgetTokens: CONSOLIDATION_TAIL_TOKENS });

  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 2, '起点不能是系统节点 seq 1');
  assert.notEqual(plan.region.startSeq, 1);
  assert.equal(plan.region.endSeq, 3, '尾部预算与推进后的起点同时生效');
  assert.equal(plan.region.count, 2);
  assert.doesNotMatch(plan.region.text, /system/u);
});

test('planRegion / firstReplaceableIndex：水位指向系统节点时从下一个节点开始', () => {
  const snapshot = snapshotOf([
    { seq: 1, role: 'system', tokens: 100 },
    { seq: 2, role: 'user', tokens: 10 },
    { seq: 3, role: 'assistant', tokens: 10 },
    { seq: 4, role: 'user', tokens: 10 },
  ]);
  assert.equal(firstReplaceableIndex(snapshot, 0), 1);
  assert.equal(firstReplaceableIndex(snapshot, 1), 1);
  assert.equal(firstReplaceableIndex(snapshot, 4), 4);

  const plan = planRegion(snapshot, { afterSeq: 1, budgetTokens: 0 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 2, 'afterSeq 系统节点后仍要跳过系统节点');
});

test('planRegion：区间中间的系统节点不进入 region，区间在其前收尾', () => {
  const snapshot = snapshotOf([
    { seq: 2, role: 'user', tokens: 1000 },
    { seq: 3, role: 'system', tokens: 10 },
    { seq: 4, role: 'user', tokens: 1000 },
  ]);
  const plan = planRegion(snapshot, { budgetTokens: 0 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 2);
  assert.equal(plan.region.endSeq, 2, '系统节点 3 之前的节点收尾');
  assert.doesNotMatch(plan.region.text, /system/u);

  const planNext = planRegion(snapshot, { afterSeq: 2, budgetTokens: 0 });
  assert.equal(planNext.reason, 'ok');
  assert.equal(planNext.region.startSeq, 4, '下一轮跳过系统节点后继续');
});

test('planRegion：整段都不可替换（全系统节点）返回 no-replaceable-range', () => {
  const snapshot = snapshotOf([
    { seq: 1, role: 'system', tokens: 100 },
    { seq: 2, role: 'system', tokens: 100 },
  ]);
  const plan = planRegion(snapshot, { budgetTokens: 0 });
  assert.equal(plan.region, null);
  assert.equal(plan.reason, 'no-replaceable-range');
});

test('planRegion：节点 0 正文缺失（role 未知）也保守跳过，不冒险覆盖系统提示词', () => {
  const snapshot = snapshotOf([
    { seq: 1, role: 'unknown', tokens: 10 },
    { seq: 2, role: 'user', tokens: 10 },
  ]);
  const plan = planRegion(snapshot, { budgetTokens: 0 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.region.startSeq, 2);
});

// -------------------------------------------------- apply 路径（compactRegion 调用点）

/** apply 需要的 commands/tools/llm 桩 + 低 token 总量（避免再触发巩固）。 */
function makeCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW });
  const session = ctx.addSession({ id: 'session-1' });
  ctx.commands = { registrations: [], register() { return () => {}; } };
  ctx.tools = { registrations: [], register() { return () => {}; } };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    // 本文件不期望触发巩固；若意外触发会在这里显式失败。
    async *stream() {
      throw new Error('V7-M1 用例不应调用巩固模型');
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 1000,
    surfaceTokens: 1000,
    nodes: [],
  };
  return { ctx, session };
}

/** @returns {object} 不新增 surface 节点的一轮 pre-step payload */
function payload(session, turn = 1) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续。' }] }],
    turn,
    step: 1,
  };
}

test('apply 生产路径：pending 起点记在系统节点时，compactRegion 从系统节点之后开始', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeCtx();
  const system = ctx.appendEvent(session.id, {
    type: 'system/message',
    data: {
      message: {
        role: 'system',
        content: [{ type: 'text', text: `系统提示词：你是严谨的助手。${'规则。'.repeat(40)}` }],
      },
    },
  });
  const user = ctx.appendEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] },
  });
  // 模拟旧版本/重启恢复留下的错误 pending：起点=系统节点 seq。
  temp.store.insertConsolidation({
    id: 'cs-v7m1',
    scope: 'main',
    session_id: session.id,
    kind: 'nap',
    trigger: 'auto',
    upto_seq: user.seq,
    turn_from: system.seq,
    compaction_start_seq: system.seq,
    status: 'written',
    finished_at: Math.floor(TEST_NOW / 1000),
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  try {
    await ctx.dispatch('agent/pre-step', payload(session, 1), { kind: 'enter', messages: [] });

    const calls = ctx.callsOf('compaction.compactRegion');
    assert.equal(calls.length, 1, '恢复的 pending 应在 turn 头压缩一次');
    const [start, end] = calls[0].args;
    assert.equal(start, user.seq, '压缩起点必须是系统节点之后的节点');
    assert.notEqual(start, system.seq);
    assert.equal(end, user.seq);
    assert.equal(session.surface.nodes[0], system.seq, '系统提示词节点必须留在 surface');
    assert.equal(temp.store.getWatermark('main'), 3, '水位应落在压缩后的替换节点上');
    assert.equal(
      temp.store.db.prepare("SELECT status FROM consolidations WHERE id = 'cs-v7m1'").get().status,
      'compacted',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('apply 生产路径：pending 区间全是系统节点时丢弃且不调用 compactRegion', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeCtx();
  const system = ctx.appendEvent(session.id, {
    type: 'system/message',
    data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示词。'.repeat(20) }] } },
  });
  temp.store.insertConsolidation({
    id: 'cs-v7m1-only-system',
    scope: 'main',
    session_id: session.id,
    kind: 'nap',
    trigger: 'auto',
    upto_seq: system.seq,
    turn_from: system.seq,
    compaction_start_seq: system.seq,
    status: 'written',
    finished_at: Math.floor(TEST_NOW / 1000),
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  try {
    await ctx.dispatch('agent/pre-step', payload(session, 1), { kind: 'enter', messages: [] });
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0, '无可用节点不得调用 compactRegion');
    assert.deepEqual(session.surface.nodes, [system.seq], '系统节点保持不变');
    assert.equal(
      temp.store.db.prepare("SELECT status FROM consolidations WHERE id = 'cs-v7m1-only-system'").get().status,
      'written',
      '未压缩的巩固行保持 written，等待后续轮次',
    );
    assert.equal(temp.store.getWatermark('main'), 1, '水位保持在该巩固行记录的位置，不因丢弃而回退');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
