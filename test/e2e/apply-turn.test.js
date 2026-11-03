/**
 * apply 驱动的生产路径 e2e（t23 H1 + 队长 m00911 / m00915）：
 * 直接调用插件的 `apply()`，用 FakeCtx + 手动时钟 + 假模型验证
 *   turn 1：pre-step 触发 planConsolidation/consolidate → 写库、登记 pending_compact；
 *   turn 2：turn 头在 open turn 内 compactRegion(1,1) → 成功后 publishBoard('compact')；
 *   同轮召回经 assemble 预算裁切注入新事实；同一 turn 第二次 step 不重复注入；
 *   同一 ctx 二次 apply 幂等；dispose 关闭 Store、清掉 interval。
 *
 * 与 turn.test.js / acceptance.test.js 的区别：那两个文件是「组件级 self-wired」，
 * 本文件走的是真实插件入口，用于锁住接线本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { TEST_NOW, makeTempStore } from './helpers.js';

/** 巩固模型返回的草稿（预算事实，便于召回断言）。 */
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
 * FakeCtx + commands/tools/llm 三个平台服务；tokenMeter 返回值可由测试改写。
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
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
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  // 41K tokens：hard 巩固阈值；turn 2 前测试会改回 1K，避免重复巩固。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return { ctx, streams };
}

/**
 * 一轮 pre-step 的标准 payload（role 消息形态）。
 * @param {number} turn
 * @param {string} text
 * @param {number} [step]
 * @returns {object}
 */
function turnPayload(turn, text, step = 1) {
  return {
    agent: { id: 'agent-1', session: { id: 'session-1' } },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** @param {{messages: object[]}|null|undefined} decision @returns {string} */
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

test('apply 生产路径：巩固 → 下一轮 turn 头压缩 → 发布状态板 → 召回新事实', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  try {
    assert.equal(typeof handle?.dispose, 'function');
    // FakeCtx 的 FakeCtx 默认 now 是手动时钟；apply 的 restart 发布在空 staged 上返回 null。
    assert.equal(temp.store.getBoard('main'), '');

    // ---------------- turn 1：pre-step 触发巩固 ----------------
    const first = await ctx.dispatch('agent/pre-step', turnPayload(1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    assert.equal(temp.store.getWatermark('main'), 1);
    const facts = temp.store.listFacts({ scope: 'main', status: 'active' });
    assert.equal(facts.length, 1);
    assert.match(facts[0].statement, /8000/u);
    assert.equal(streams.length, 1, '巩固模型应被调用一次');
    // 只 staged，不发布。
    assert.equal(temp.store.getBoard('main'), '');
    assert.ok(temp.store.getBoardState('main').staged_revision >= 1);

    // turn 1 的第二步：不再重复巩固/注入。
    const second = await ctx.dispatch('agent/pre-step', turnPayload(1, '补充一句，下周一执行。', 2), {
      kind: 'enter',
      messages: [],
    });
    assert.equal(streams.length, 1, '同一 turn 不应重复巩固');
    assert.doesNotMatch(decisionText(second), /\[相关记忆\]/u);

    // ---------------- turn 2：turn 头压缩并发布 ----------------
    ctx.returns['tokenMeter.measure'] = {
      logRevision: 2,
      baseline: null,
      surfaceDeltaTokens: 10,
      totalTokens: 1000,
      surfaceTokens: 1000,
      nodes: [],
    };
    const compactCalls = ctx.callsOf('compaction.compactRegion');
    assert.equal(compactCalls.length, 0);

    const third = await ctx.dispatch('agent/pre-step', turnPayload(2, '现在预算额度是多少？'), {
      kind: 'enter',
      messages: [],
    });

    const afterCompact = ctx.callsOf('compaction.compactRegion');
    assert.equal(afterCompact.length, 1, 'pending_compact 应在 turn 头压缩一次');
    assert.deepEqual(afterCompact[0].args.slice(0, 2), [1, 1]);
    const state = temp.store.getBoardState('main');
    assert.ok(state.revision >= 1, '压缩成功后应发布状态板');
    assert.match(temp.store.getBoard('main'), /8000/u);
    const status = temp.store.db
      .prepare("SELECT status FROM consolidations WHERE scope = 'main' AND upto_seq = 1 AND kind = 'nap'")
      .get();
    assert.equal(status.status, 'compacted', '压缩成功后巩固行应标记 compacted');
    assert.match(decisionText(third), /\[相关记忆\]/u, '下一轮应召回新事实');
    assert.match(decisionText(third), /8000/u);

    // 第二轮之后的 step 不再注入。
    const fourth = await ctx.dispatch('agent/pre-step', turnPayload(2, '谢谢。', 2), {
      kind: 'enter',
      messages: [],
    });
    assert.doesNotMatch(decisionText(fourth), /\[相关记忆\]/u);
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('同一 ctx 二次 apply 幂等，dispose 关闭 Store 并清掉 interval', () => {
  const { ctx } = makeApplyCtx();
  const first = apply(ctx, { dbPath: ':memory:' });
  const second = apply(ctx, { dbPath: ':memory:' });

  assert.equal(first, second, '二次 apply 应返回同一个句柄');
  assert.equal(ctx.commands.registrations.length, 4);
  assert.equal(ctx.tools.registrations.length, 8);
  assert.equal((ctx.listeners.get('agent/pre-step') ?? []).length, 1);
  assert.equal(ctx.callsOf('interval').length, 1);
  assert.equal(ctx.callsOf('interval')[0].args[1], 30_000);
  assert.equal(ctx.sections.length, 4);

  first.dispose();
  assert.equal(ctx.timers[0].disposed, true, 'dispose 必须清掉 30s tick');
  assert.equal(ctx.listeners.get('agent/pre-step').every((entry) => entry.disposed !== false), true);
  assert.doesNotThrow(() => first.dispose(), 'dispose 必须幂等');
});

test('apply 生产路径：deep-sleep 每日补跑执行降级/FTS GC 并写 consolidations 与审计', async () => {
  // 本地 2026-11-04 04:30（构造器按本地时区解释）：deep-sleep 计划时刻 03:00
  // 落在 6h 补扫窗口内，且窗口判断与运行环境时区无关。
  const deepNow = new Date(2026, 10, 4, 4, 30, 0, 0).getTime();
  const nowSec = Math.floor(deepNow / 1000);
  const temp = makeTempStore();
  const stale = temp.store.insertFact({
    kind: 'knowledge',
    subject_text: '旧闻',
    predicate: '状态',
    object_text: '过期',
    statement: '旧闻已经过期。',
    source_kind: 'turn',
    observed_at: nowSec - 30 * 86_400,
    last_reinforced_at: nowSec - 30 * 86_400,
    salience: 'normal',
  });
  // 造一条 FTS 孤儿行：深睡 GC 应把它清掉。
  temp.store.db.prepare('INSERT INTO fts_facts (rowid, txt) VALUES (?, ?)').run(999_999, '孤儿记忆');

  const { ctx } = makeApplyCtx({ now: deepNow });
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(temp.store.getFact(stale.id).status, 'dormant', '超过强度天数的 active 事实应降级');
    assert.equal(
      temp.store.db.prepare('SELECT COUNT(*) AS n FROM fts_facts WHERE rowid = ?').get(999_999).n,
      0,
      '深睡应清掉 FTS 孤儿行',
    );

    const run = temp.store.db
      .prepare("SELECT kind, trigger, session_id FROM consolidations WHERE trigger = 'deep-sleep' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(run, '深睡应写一条 consolidations 审计行');
    assert.equal(run.kind, 'deep');
    assert.match(run.session_id, /^deep:\d{4}-\d{2}-\d{2}$/u);

    const event = temp.store.db
      .prepare("SELECT detail_json FROM memory_events WHERE reason = 'deep-sleep' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(event, '深睡应写 memory_events 审计');
    const detail = JSON.parse(event.detail_json);
    assert.match(detail.day, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(detail.dormant >= 1);
    assert.ok(detail.gc >= 1);
    assert.ok(temp.store.getBoardState('main').staged_revision >= 1, '深睡后应 stage 状态板');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
