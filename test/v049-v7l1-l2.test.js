/**
 * V7-L1 / V7-L2：发布门 round C 必须真的跑两轮，巩固/压缩事件必须带毫秒 duration_ms。
 *
 * V7-L1：旧 round C 只跑单轮，headless 下 tokenMeter 永远是 0，巩固从不触发，
 *   发布门却把「没有巩固」当 PASS。本文件锁住两轮续跑协议与证据判定。
 * V7-L2：started_at/finished_at 只到秒，同秒内多次巩固/压缩无法区分耗时；
 *   现在由注入时钟在 detail_json 写 duration_ms，且旧行（无该字段）读取兼容。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { Store } from '../src/memory/store.js';
import { consolidate, eventDurationMs } from '../src/memory/consolidate.js';

import { TEST_NOW, makeTempStore, waitFor } from './e2e/helpers.js';
import {
  evaluateConsolidationRound,
  parseSessionId,
  readConsolidationEvidence,
  runConsolidationRound,
} from '../scripts/probe/run-headless.mjs';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** 巩固草稿：普通事实，不含敏感内容（避免 V7-M3 过滤改变计数）。 */
function draftOf(overrides = {}) {
  return {
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
    ...overrides,
  };
}

/** @returns {object[]} 某张表的事件行（listEvents 按 id DESC） */
function eventsOf(store, table) {
  return store.listEvents({ table_name: table, limit: 50 });
}

// -------------------------------------------------- V7-L2：注入时钟计毫秒

test('V7-L2：注入时钟跨 450ms 时 duration_ms=450，同秒内的 started_at/finished_at 仍相等', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const base = 1_700_000_000;
  let calls = 0;
  const clock = () => {
    calls += 1;
    return calls === 1 ? base * 1000 : base * 1000 + 450;
  };
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm: async () => draftOf(),
    now: base,
    trigger: 'idle',
    clock,
  });

  assert.equal(result.skipped, false);
  assert.equal(result.duration_ms, 450);
  assert.ok(Number.isInteger(result.duration_ms) && result.duration_ms >= 0);

  const row = store.db
    .prepare("SELECT started_at, finished_at FROM consolidations WHERE scope = 'main' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(row.started_at, base, 'started_at 仍是秒');
  assert.equal(row.finished_at, base, 'finish 与 start 同秒');

  const event = eventsOf(store, 'episodes')[0];
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.kind, 'consolidation', '事件 detail 必须能区分 consolidation 类');
  assert.equal(detail.duration_ms, 450);
  assert.equal(eventDurationMs(event), 450, '读取 helper 应还原毫秒数');
});

test('V7-L2：时钟回退时 duration_ms 夹到 0（非负整数）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const base = 1_700_000_000;
  let calls = 0;
  const clock = () => {
    calls += 1;
    return calls === 1 ? base * 1000 + 1000 : base * 1000 + 100;
  };
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm: async () => draftOf(),
    now: base,
    trigger: 'idle',
    clock,
  });

  assert.equal(result.duration_ms, 0);
  assert.ok(Number.isInteger(result.duration_ms) && result.duration_ms >= 0);
});

test('V7-L2：旧版本事件行没有 duration_ms 时读取返回 null，不抛错', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const base = 1_700_000_000;
  store.db
    .prepare(
      "INSERT INTO memory_events (at, action, table_name, row_id, actor, reason, detail_json) VALUES (?, 'ADD', 'episodes', NULL, 'consolidator', 'idle', ?)",
    )
    .run(base, JSON.stringify({ upto_seq: 2, facts: 1 }));

  const oldRow = eventsOf(store, 'episodes')[0];
  assert.equal(eventDurationMs(oldRow), null, '旧行无该字段 → null');

  assert.equal(eventDurationMs({ detail_json: '{"duration_ms": 12}' }), 12, '字符串 detail 也兼容');
  assert.equal(eventDurationMs('not json'), null);
  assert.equal(eventDurationMs({ duration_ms: -1 }), null);
  assert.equal(eventDurationMs({ duration_ms: 3.6 }), 4, '返回整数毫秒');
});

// -------------------------------------------------- V7-L2：生产路径（apply）

/** apply 需要的 commands/tools/llm 桩；tokenMeter 41K 触发 hard 巩固。 */
function makeApplyCtx({ now = TEST_NOW, advanceOnStream = 0 } = {}) {
  const ctx = new FakeCtx({ now });
  const session = ctx.addSession({ id: 'session-1' });
  ctx.commands = { registrations: [], register() { return () => {}; } };
  ctx.tools = { registrations: [], register() { return () => {}; } };
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream(request) {
      streams.push(request);
      if (advanceOnStream > 0) ctx.advance(advanceOnStream);
      yield { type: 'text-delta', text: JSON.stringify(draftOf()) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return { ctx, session, streams };
}

/** 一轮 pre-step payload；user 消息先 commit 进 surface（平台语义）。 */
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

test('V7-L2：apply 生产路径的巩固事件带 duration_ms（模型耗时 700ms）', async (t) => {
  const temp = makeTempStore();
  const { ctx, session } = makeApplyCtx({ advanceOnStream: 700 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'consolidation' });

  const event = eventsOf(temp.store, 'episodes')[0];
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.kind, 'consolidation');
  assert.equal(detail.duration_ms, 700, '巩固耗时来自注入的 platform.now 毫秒时钟');
  assert.equal(eventDurationMs(event), 700);
});

test('V7-L2：apply 生产路径的压缩事件带 duration_ms（compactRegion 耗时 1234ms）', async (t) => {
  const temp = makeTempStore();
  const { ctx, session } = makeApplyCtx();
  // 关掉 41K 的巩固触发：本轮只验证压缩事件。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 1000,
    surfaceTokens: 1000,
    nodes: [],
  };
  const user = ctx.appendEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '继续。' }] },
  });
  temp.store.insertConsolidation({
    id: 'cs-v7l2',
    scope: 'main',
    session_id: session.id,
    kind: 'nap',
    trigger: 'auto',
    upto_seq: user.seq,
    turn_from: user.seq,
    compaction_start_seq: user.seq,
    status: 'written',
    finished_at: Math.floor(TEST_NOW / 1000),
  });

  const original = ctx.compaction.compactRegion;
  ctx.compaction.compactRegion = (start, end, agent, signal) => {
    ctx.advance(1234);
    return original(start, end, agent, signal);
  };

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '继续。'), {
    kind: 'enter',
    messages: [],
  });

  const calls = ctx.callsOf('compaction.compactRegion');
  assert.equal(calls.length, 1, '恢复的 pending 应在 turn 头压缩一次');

  const event = eventsOf(temp.store, 'compactions')[0];
  assert.ok(event, '压缩成功必须写 memory_events（table_name=compactions）');
  assert.equal(event.action, 'UPDATE');
  assert.equal(event.actor, 'consolidator');
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.kind, 'compaction');
  assert.equal(detail.duration_ms, 1234);
  assert.equal(eventDurationMs(event), 1234);
  assert.equal(detail.start, user.seq);
  assert.equal(detail.end, user.seq);
  assert.equal(typeof detail.watermark, 'number');
  assert.equal(
    temp.store.db.prepare("SELECT status FROM consolidations WHERE id = 'cs-v7l2'").get().status,
    'compacted',
  );
});

// -------------------------------------------------- V7-L1：round C 两轮与证据判定

const SESSION_LINE = '{"type":"session","sessionId":"session-r1","cwd":"/tmp"}\n';
const STATUS_LINE = '{"type":"status","phase":"running"}\n';
const STARTED_STDERR = '[dsh-companion] scheduler started\n';

/**
 * 造假 runHeadless：按轮次返回固定输出并记录参数。
 * @param {{first?: object, second?: object}} turns
 * @returns {{calls: string[][], runHeadless: Function}}
 */
function fakeRunner(turns = {}) {
  const calls = [];
  const first = turns.first ?? { exitCode: 0, stdout: SESSION_LINE, stderr: STARTED_STDERR };
  const second = turns.second ?? { exitCode: 0, stdout: '{"type":"final","sessionId":"session-r1"}\n', stderr: '' };
  return {
    calls,
    runHeadless: async (launch, env, args) => {
      calls.push(args);
      return { timedOut: false, ...(calls.length === 1 ? first : second) };
    },
  };
}

test('V7-L1：round C 第一轮取 sessionId，第二轮 --session-id 续跑，证据齐全才 PASS', async () => {
  const { calls, runHeadless } = fakeRunner();
  const result = await runConsolidationRound(
    { prefixArgs: [], command: 'dsh' },
    {},
    { timeoutMs: 1000 },
    {
      prepare: () => 'overlay.yml',
      runHeadless,
      readEvidence: () => ({ count: 1, tokenEvents: 2, maxTokensIn: 321 }),
    },
  );

  assert.equal(calls.length, 2, 'round C 必须跑两轮');
  assert.equal(result.turns, 2);
  assert.ok(calls[0].includes('--json'), '第一轮要用 --json 才拿得到 sessionId');
  assert.ok(
    calls[0].indexOf('--patch') >= 0 && calls[0].indexOf('--patch') < calls[0].indexOf('--json'),
    '--patch 必须排在 --json 之前（DSH JSON 模式的解析器不认识 patch 选项）',
  );
  assert.equal(calls[0].includes('--session-id'), false);
  assert.ok(calls[1].includes('--json'));
  const resumeAt = calls[1].indexOf('--session-id');
  assert.ok(resumeAt >= 0, '第二轮必须续跑同一会话');
  assert.equal(calls[1][resumeAt + 1], 'session-r1');
  assert.equal(result.sessionId, 'session-r1');
  assert.equal(result.count, 1);
  assert.equal(result.maxTokensIn, 321);
  assert.equal(result.verdict, 'pass');
});

test('V7-L1：round C 无凭据只跑一轮并 SKIP（不算 PASS）', async () => {
  const { calls, runHeadless } = fakeRunner({
    first: {
      exitCode: 1,
      // 真实 headless：插件先激活、scheduler 打标记，随后首个 LLM 调用才报缺凭据。
      stdout: '{"type":"final","reason":{"kind":"error","error":{"code":"MISSING_CREDENTIAL"}}}\n',
      stderr: STARTED_STDERR,
    },
  });
  const result = await runConsolidationRound(
    { prefixArgs: [], command: 'dsh' },
    {},
    { timeoutMs: 1000 },
    {
      prepare: () => 'overlay.yml',
      runHeadless,
      readEvidence: () => ({ count: 0, tokenEvents: 0, maxTokensIn: 0 }),
    },
  );

  assert.equal(calls.length, 1, '无凭据不应再跑第二轮');
  assert.equal(result.turns, 1);
  assert.equal(result.credentialsMissing, true);
  assert.equal(result.verdict, 'skip');
});

test('V7-L1：有凭据但首轮拿不到 sessionId 时判失败（error），不会伪装成 PASS/SKIP', async () => {
  const { runHeadless } = fakeRunner({ first: { exitCode: 0, stdout: STATUS_LINE, stderr: STARTED_STDERR } });
  const result = await runConsolidationRound(
    { prefixArgs: [], command: 'dsh' },
    {},
    { timeoutMs: 1000 },
    {
      prepare: () => 'overlay.yml',
      runHeadless,
      readEvidence: () => ({ count: 0, tokenEvents: 0, maxTokensIn: 0 }),
    },
  );

  assert.equal(result.verdict, null);
  assert.match(result.error, /no session id/u);
});

test('V7-L1：parseSessionId 从 NDJSON 里取第一个 sessionId，忽略坏行', () => {
  assert.equal(parseSessionId(`${STATUS_LINE}${SESSION_LINE}${STATUS_LINE}`), 'session-r1');
  assert.equal(parseSessionId('{"type":"final","sessionId":"s-last"}\n'), 's-last');
  assert.equal(parseSessionId('not json\n{"type":"status"}\n'), null);
  assert.equal(parseSessionId(''), null);
  assert.equal(parseSessionId(undefined), null);
});

test('V7-L1：evaluateConsolidationRound 的证据判定（tokenMeter 非零、scheduler、consolidations）', () => {
  const ok = {
    started: true,
    inactive: false,
    crash: false,
    credentialsMissing: false,
    maxTokensIn: 321,
    tokenEvents: 2,
    count: 1,
  };
  assert.equal(evaluateConsolidationRound(ok).verdict, 'pass');

  assert.equal(evaluateConsolidationRound({ ...ok, credentialsMissing: true }).verdict, 'skip');
  assert.equal(evaluateConsolidationRound({ ...ok, maxTokensIn: 0 }).verdict, 'fail', 'tokenMeter=0 是 V7-L1 的根因');
  assert.match(evaluateConsolidationRound({ ...ok, maxTokensIn: 0 }).reason, /tokenMeter/u);
  assert.equal(evaluateConsolidationRound({ ...ok, count: 0 }).verdict, 'fail');
  assert.equal(evaluateConsolidationRound({ ...ok, started: false }).verdict, 'fail');
  assert.equal(evaluateConsolidationRound({ ...ok, inactive: true }).verdict, 'fail');
  assert.equal(evaluateConsolidationRound({ ...ok, crash: true }).verdict, 'fail');
  assert.equal(evaluateConsolidationRound({ ...ok, error: new Error('boom') }).verdict, 'fail');
});

test('V7-L1：readConsolidationEvidence 读 consolidations 与 tokens 事件（旧库无事件也能读）', (t) => {
  const temp = makeTempStore({ t });
  temp.store.insertConsolidation({
    id: 'cs-round-c',
    scope: 'main',
    session_id: 'session-1',
    kind: 'nap',
    trigger: 'hard',
    upto_seq: 2,
    turn_from: 1,
    compaction_start_seq: 1,
    status: 'written',
    finished_at: Math.floor(TEST_NOW / 1000),
  });
  temp.store.appendEvent({
    at: Math.floor(TEST_NOW / 1000),
    action: 'USED',
    table_name: 'tokens',
    actor: 'consolidator',
    reason: 'turn_metrics',
    detail_json: { tokensIn: 456, tokensOut: 12 },
  });
  temp.store.appendEvent({
    at: Math.floor(TEST_NOW / 1000),
    action: 'USED',
    table_name: 'tokens',
    actor: 'consolidator',
    reason: 'turn_metrics',
    detail_json: { tokensIn: 0, tokensOut: 0 },
  });

  const evidence = readConsolidationEvidence(temp.dbPath);
  assert.equal(evidence.count, 1);
  assert.equal(evidence.tokenEvents, 2);
  assert.equal(evidence.maxTokensIn, 456);

  assert.deepEqual(
    readConsolidationEvidence(`${temp.dir}/missing.db`),
    { count: 0, tokenEvents: 0, maxTokensIn: 0 },
    '库不存在时返回零证据而不是抛错',
  );
});
