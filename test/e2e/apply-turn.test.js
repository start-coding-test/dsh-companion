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
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
 * 会话带 surface（H1：巩固窗口按 surface seq 选区），user 消息在 dispatch 前先 commit。
 * @returns {{ctx: FakeCtx, streams: object[], session: object}}
 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
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
  // 41K tokens：hard 巩固阈值；turn 2 前测试会改回 1K，避免重复巩固。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return { ctx, streams, session };
}

/**
 * 一轮 pre-step 的标准 payload（role 消息形态）。
 * 平台语义：user 消息在 pre-step 之前已经 commit 进 session surface，
 * 因此这里先 emit `user/message`，再返回带 `agent.session` 的 payload。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {number} turn
 * @param {string} text
 * @param {number} [step]
 * @returns {object}
 */
function turnPayload(ctx, session, turn, text, step = 1) {
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
  const { ctx, streams, session } = makeApplyCtx();
  // retainTokens 同时是巩固窗口的尾部保留区（H1）；测试用 8 让短消息也能落到窗口内。
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14, retainTokens: 4 });
  try {
    assert.equal(typeof handle?.dispose, 'function');
    // FakeCtx 的 FakeCtx 默认 now 是手动时钟；apply 的 restart 发布在空 staged 上返回 null。
    assert.equal(temp.store.getBoard('main'), '');

    // ---------------- turn 1：pre-step 触发巩固 ----------------
    const first = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
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
    const second = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '补充一句，下周一执行。', 2), {
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

    const third = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '现在预算额度是多少？'), {
      kind: 'enter',
      messages: [],
    });

    const afterCompact = ctx.callsOf('compaction.compactRegion');
    assert.equal(afterCompact.length, 1, 'pending_compact 应在 turn 头压缩一次');
    assert.deepEqual(afterCompact[0].args.slice(0, 2), [1, 1]);
    const state = temp.store.getBoardState('main');
    assert.ok(state.revision >= 1, '压缩成功后应发布状态板');
    assert.match(temp.store.getBoard('main'), /8000/u);
    // H1：压缩后旧 seq 被替换节点顶替（本 fake 追加 seq=4），水位在新 seq 空间内自洽。
    assert.deepEqual(session.surface.nodes, [2, 3, 4]);
    assert.equal(temp.store.getWatermark('main'), 4, '水位应改写为压缩后的新 seq');
    const status = temp.store.db
      .prepare("SELECT status, upto_seq, compaction_start_seq FROM consolidations WHERE scope = 'main' AND kind = 'nap'")
      .get();
    assert.equal(status.status, 'compacted', '压缩成功后巩固行应标记 compacted');
    assert.equal(status.upto_seq, 4, '巩固行的 upto_seq 应随水位重定目标');
    assert.equal(status.compaction_start_seq, 1, '巩固行应记录压缩区间起点 seq');
    assert.match(decisionText(third), /\[相关记忆\]/u, '下一轮应召回新事实');
    assert.match(decisionText(third), /8000/u);

    // 第二轮之后的 step 不再注入。
    const fourth = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '谢谢。', 2), {
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
  // Asia/Shanghai 2026-11-04 04:30（默认 config.timezone）：deep-sleep 计划时刻 03:00
  // 落在 6h 补扫窗口内，且窗口判断与运行环境时区无关。
  const deepNow = Date.parse('2026-11-04T04:30:00+08:00');
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
  // retainTokens 同时是巩固窗口的尾部保留区（H1）；测试用 8 让短消息也能落到窗口内。
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14, retainTokens: 4 });
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

// ------------------------------------------------ M2：配置项立即生效（生产路径）

/**
 * 用同一套 turn 序列量一次「是否巩固」，便于对比不同 compactAtTokens。
 * @param {Record<string, unknown>} overrides
 * @returns {Promise<{consolidations: number, streams: number}>}
 */
async function countConsolidations(overrides) {
  const temp = makeTempStore();
  const { ctx, streams, session } = makeApplyCtx();
  // 13K：高于覆盖值 12000，低于默认 24000；idle 不会触发（时钟不前进）。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 5,
    totalTokens: 13_000,
    surfaceTokens: 13_000,
    nodes: [],
  };
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, ...overrides });
  try {
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '记录一下这个决定。'), { kind: 'enter', messages: [] });
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '继续。'), { kind: 'enter', messages: [] });
    const row = temp.store.db
      .prepare("SELECT COUNT(*) AS n FROM consolidations WHERE scope = 'main' AND kind = 'nap'")
      .get();
    return { consolidations: Number(row.n), streams: streams.length };
  } finally {
    handle.dispose();
    temp.cleanup();
  }
}

test('apply 生产路径：override compactAtTokens=12000 后行为改变', async () => {
  const overridden = await countConsolidations({ compactAtTokens: 12_000 });
  assert.equal(overridden.consolidations, 1, '覆盖阈值 12000 后，13K token 应触发巩固');
  assert.equal(overridden.streams, 1, '巩固模型应被调用一次');

  const defaults = await countConsolidations({});
  assert.equal(defaults.consolidations, 0, '默认阈值 24000 时，13K token 不应触发巩固');
  assert.equal(defaults.streams, 0);
});

test('apply 生产路径：备份文件名用 config.timezone 的本地日期（跨 UTC 日界）', async () => {
  // 上海 2026-11-04 04:30 = UTC 2026-11-03 20:30：本地日期与 UTC 日期不同。
  const now = Date.parse('2026-11-04T04:30:00+08:00');
  const temp = makeTempStore();
  const { ctx } = makeApplyCtx({ now });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));

    const dir = dirname(temp.dbPath);
    const base = basename(temp.dbPath);
    assert.equal(
      existsSync(join(dir, `${base}.2026-11-04.bak`)),
      true,
      '备份文件名应使用配置时区的本地日期 2026-11-04',
    );
    assert.equal(
      existsSync(join(dir, `${base}.2026-11-03.bak`)),
      false,
      '不应使用 UTC 日期 2026-11-03',
    );

    const run = temp.store.db
      .prepare("SELECT session_id FROM consolidations WHERE trigger = 'deep-sleep' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(run.session_id, 'deep:2026-11-04', 'deep-sleep 的 session_id 也用本地日期');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
