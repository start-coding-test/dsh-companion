/**
 * v0.7.7 阶段 1（C120-H1/H2/M1/M2/M3/L1）回归测试。
 *
 * 背景：宿主的压缩只接受「工具配对平衡切口」。宿主实现在
 * `node_modules/@deepseek-ai/dsh-compaction/src/tool-pairing.ts`（dsh-v0.2.2-rc.5，
 * 本机 asar 内扁平布局）：
 *   - `eventDelta` :29-38 —— assistant/message 按 tool-call 块数 +N，tool/result −1，其它 0；
 *   - `extendCache` :41-69 —— 累计和为 0 才是平衡切口，出现负数视为 surface 损坏；
 *   - `toolPairingBalancedBefore/After` :112-126 —— 区间两端都必须落在平衡切口。
 * 宿主**不按 callId 配对**（现网 tool/result 的 callId 是 undefined），只用累计和。
 *
 * 这些用例是**构造数据**：50041 事件量的线上 surface 快照没有随任务提供
 * （任务里说明「没到之前先用构造数据」），真快照到达后应替换 `6122 事件回放` 一节。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alignRegionToToolPairing,
  planRegion,
  toolDeltaOf,
  toolPairingCuts,
} from '../src/session/surface.js';
import { Store } from '../src/memory/store.js';
import { consolidate } from '../src/memory/consolidate.js';
import { FakeCtx, assertBalancedCut, eventToolDelta } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { TEST_NOW, makeTempStore, settle, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

// ---------------------------------------------------------------- 事件构造

/** @param {string} text @param {number} [seq] */
function userEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/** 一条带 N 个 tool-call 的 assistant 消息。 @param {number} calls @param {number} [seq] */
function assistantToolCallEvent(calls = 1, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: Array.from({ length: calls }, (_, index) => ({
          type: 'tool-call',
          id: `call-${index}`,
          name: 'bash',
        })),
      },
    },
  };
}

/** @param {number} [seq] */
function toolResultEvent(seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'tool/result',
    data: { callId: undefined, content: [{ type: 'text', text: 'ok' }] },
  };
}

/** @param {string} text @param {number} [seq] */
function assistantTextEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

/** 把事件序列折成 planRegion 需要的 records（seq 递增、文本按 flattenMessage 口径）。 */
function recordsOf(events) {
  return events.map((event, index) => ({
    seq: Number(event.seq ?? index + 1),
    role: String(event.type).split('/')[0],
    text: event.type === 'assistant/message'
      ? (event.data.message.content.find((block) => block.type === 'text')?.text ?? '[tool call bash]')
      : event.type === 'tool/result'
        ? '[tool result]'
        : (event.data.content?.[0]?.text ?? ''),
    tokens: 1,
    toolDelta: toolDeltaOf(event),
  }));
}

/**
 * planRegion 的尾部预算读 `nodes[index].tokens`（不是 records），平铺 records 时
 * 必须同步造 nodes，否则 tailTokens 恒为 0，整个 surface 都被当成尾部。
 * @param {Array<object>} records
 */
function snapshotOf(records) {
  return {
    seqs: records.map((record) => record.seq),
    records,
    nodes: records.map((record) => ({ seq: record.seq, role: record.role, tokens: record.tokens })),
    tokens: records.map((record) => record.tokens),
  };
}

// ---------------------------------------------------------------- 纯函数

test('toolDeltaOf 与宿主 eventDelta 同口径（tool-call +N / tool/result −1 / 其它 0）', () => {
  assert.equal(toolDeltaOf(assistantToolCallEvent(2)), 2);
  assert.equal(toolDeltaOf(toolResultEvent()), -1);
  assert.equal(toolDeltaOf(userEvent('在吗')), 0);
  assert.equal(toolDeltaOf(assistantTextEvent('收到')), 0);
  // FakeCtx 侧的同口径实现（测试替身的配平校验用）
  assert.equal(eventToolDelta(assistantToolCallEvent(3)), 3);
  assert.equal(eventToolDelta(toolResultEvent()), -1);
});

test('toolPairingCuts：只有累计和为 0 的位置是合法切口', () => {
  const records = recordsOf([
    userEvent('a', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
    assistantTextEvent('done', 4),
  ]);
  assert.deepEqual(toolPairingCuts(records), [true, true, false, true, true]);
});

test('alignRegionToToolPairing：end 落在带 tool-call 的 assistant 上时向前收缩', () => {
  const records = recordsOf([
    userEvent('a', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
  ]);
  // [1,2] 的 end 还是未闭合的 tool-call → 收到 1
  assert.deepEqual(alignRegionToToolPairing(records, 0, 1), { startIdx: 0, endIdx: 0, adjusted: true });
  // [1,3] 两端都闭合成 0 → 原样返回
  assert.deepEqual(alignRegionToToolPairing(records, 0, 2), { startIdx: 0, endIdx: 2, adjusted: false });
});

test('alignRegionToToolPairing：start 落在 tool-result 上时向后跳过', () => {
  const records = recordsOf([
    userEvent('a', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
    assistantTextEvent('done', 4),
  ]);
  // 起点 = tool/result（下标 2）：跳到下标 3 才是平衡切口
  assert.deepEqual(alignRegionToToolPairing(records, 2, 3), { startIdx: 3, endIdx: 3, adjusted: true });
});

test('alignRegionToToolPairing：收缩不出合法区间时返回 null', () => {
  const records = recordsOf([
    userEvent('a', 1),
    assistantToolCallEvent(1, 2),
  ]);
  // 只有 [2,2]：尾部未闭合，向前收缩会越过起点
  assert.equal(alignRegionToToolPairing(records, 1, 1), null);
});

test('planRegion：endSeq 不越过尾部未结束的 tool-call，区间两端都落在平衡切口', () => {
  // 尾部保留区用 retainTokens 卡住最后一条 tool/result，压缩窗口只能收在 assistant tool-call 之前。
  const snapshot = snapshotOf(recordsOf([
    userEvent('开始', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
    assistantTextEvent('继续', 4),
  ]));
  // budgetTokens: 1 → 尾部只留最后一个节点，窗口 [0, 2] 正好卡在 tool/result 上。
  const region = planRegion(snapshot, { afterSeq: 0, budgetTokens: 1 });
  assert.ok(region.region, '应有可压缩区间');
  assert.equal(region.region.endSeq, 3, 'end 收在 tool/result 上，不越过它');
  const cuts = toolPairingCuts(snapshot.records);
  assert.equal(cuts[region.region.startIdx], true, 'start 在平衡切口');
  assert.equal(cuts[region.region.endIdx + 1], true, 'end 之后是平衡切口');
});

test('planRegion：整个窗口都在未闭合 tool-call 上时给出 unbalanced-boundary', () => {
  // 水位停在第 1 条之后，尾部保留最后一条 → 窗口里只剩一个未闭合的 tool-call。
  const snapshot = snapshotOf(recordsOf([
    userEvent('开始', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
  ]));
  const region = planRegion(snapshot, { afterSeq: 1, budgetTokens: 1 });
  assert.equal(region.region, null);
  assert.equal(region.reason, 'unbalanced-boundary');
});

// ---------------------------------------------------------------- 测试替身

test('FakeCtx.compactRegion：不平��切口抛确定性错误（文案含 balanced boundary）', () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({
    id: 'session-pair',
    events: [userEvent('a', 1), assistantToolCallEvent(1, 2), toolResultEvent(3)],
  });
  assert.throws(
    () => ctx.compaction.compactRegion(1, 2, { session }),
    /balanced boundary/u,
  );
  // 两端闭合的区间照常通过
  assert.equal(ctx.compaction.compactRegion(1, 3, { session }).end, 3);
  // 没有 session 的透传调用不校验（adapter 单测语义）
  assert.equal(ctx.compaction.compactRegion(10, 20, {}).start, 10);
});

test('FakeCtx 配平校验与宿主 assertBalancedCut 判定一致', () => {
  const ctx = new FakeCtx();
  const session = ctx.addSession({
    id: 'session-pair-2',
    events: [userEvent('a', 1), assistantToolCallEvent(1, 2), toolResultEvent(3), toolResultEvent(4)],
  });
  // 4 是多余 tool/result → 累计为负，宿主视为 surface 损坏
  assert.throws(() => assertBalancedCut(session, 4, 'end'), /no matching tool-call/u);
});

// ---------------------------------------------------------------- 6122 事件回放

test('构造数据回放：6122 事件 / 596 tool-call / 595 tool-result，尾部一个未结束调用（区间边界合法）', () => {
  // 真快照（50041 surface 事件）未到达，这里按任务给的量级造数据：
  // 先铺 595 组「assistant tool-call + tool/result」，再放尾部一个未闭合的 tool-call。
  const events = [];
  let seq = 1;
  events.push(userEvent('开头：帮我跑一遍构建。', seq));
  seq += 1;
  for (let index = 0; index < 595; index += 1) {
    events.push(assistantToolCallEvent(1, seq));
    seq += 1;
    events.push(toolResultEvent(seq));
    seq += 1;
  }
  // 尾部未闭合的 tool-call（结果还在保留区/还没回来）
  events.push(assistantToolCallEvent(1, seq));
  const trailingSeq = seq;
  const records = recordsOf(events);
  assert.equal(events.filter((event) => event.type === 'assistant/message').length, 596);
  assert.equal(events.filter((event) => event.type === 'tool/result').length, 595);

  // retainTokens = 0：除尾节点外都能进窗口；end 必须收在未闭合调用之前。
  const region = planRegion(snapshotOf(records), { afterSeq: 0, budgetTokens: 1 });
  assert.ok(region.region, '应能选出一个区间');
  assert.ok(
    region.region.endSeq < trailingSeq,
    `end(${region.region.endSeq}) 不能越过未结束的 tool-call(${trailingSeq})`,
  );
  const cuts = toolPairingCuts(records);
  assert.equal(cuts[region.region.endIdx + 1], true, 'end 之后累计为 0');
});

// ---------------------------------------------------------------- maybeCompact 路径

/**
 * @param {{now?: number, totalTokens?: number}} [options]
 */
function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { register: () => () => {} };
  ctx.tools = { register: () => () => {} };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ episode: null, facts: [], reminders: [] }) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return ctx;
}

/**
 * 播种一条「已巩固、可压缩」的 nap 行，作为下次 apply 启动时恢复的 pending。
 * @param {string} dbPath
 * @param {{start: number, end: number}} region
 */
function seedPending(dbPath, { start, end }) {
  const store = Store.open(dbPath);
  try {
    store.insertConsolidation({
      scope: 'main',
      kind: 'nap',
      status: 'written',
      session_id: 'main',
      trigger: 'turn',
      upto_seq: end,
      turn_from: start,
      turn_to: end,
      compaction_start_seq: start,
      started_at: Math.floor(TEST_NOW / 1000),
      finished_at: Math.floor(TEST_NOW / 1000),
    });
  } finally {
    store.close();
  }
}

/**
 * 触发一次 turn 头（pre-step enter）。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {number} turn
 * @param {string} text
 */
async function preStep(ctx, session, turn, text) {
  ctx.emitSessionEvent(session.id, userEvent(text));
  return ctx.dispatch(
    'agent/pre-step',
    {
      agent: { id: session.id, session },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      turn,
      step: 1,
    },
    { kind: 'enter', messages: [] },
  );
}

test('pending 收缩后成功：end 落在 assistant tool-call 上，压缩改到前一个平衡切口', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-shrink',
    events: [userEvent('拉一下日志。', 1), assistantToolCallEvent(1, 2), toolResultEvent(3), assistantTextEvent('构建通过。', 4)],
  });
  // 旧 pending 的 end 指向 assistant tool-call（2）：切在那里会把调用与结果拆开。
  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    const calls = ctx.callsOf('compaction.compactRegion');
    assert.equal(calls.length, 1, '收缩后应成功压缩一次');
    assert.deepEqual(calls[0].args.slice(0, 2), [1, 1], 'end 收到前一个平衡切口');
    await settle();
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('pending 收缩后成功：start 落在 tool-result 上，起点跳到之后的平衡切口', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-start',
    events: [
      userEvent('拉一下日志。', 1),
      assistantToolCallEvent(1, 2),
      toolResultEvent(3),
      assistantTextEvent('构建通过。', 4),
    ],
  });
  seedPending(temp.dbPath, { start: 3, end: 4 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    const calls = ctx.callsOf('compaction.compactRegion');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), [4, 4], 'start 跳到 tool/result 之后的平衡切口');
    await settle();
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('收缩后不再更小：直接丢弃 pending，不调用 compactRegion', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-drop',
    events: [userEvent('拉一下日志。', 1), assistantToolCallEvent(1, 2)],
  });
  // [2,2] 是未闭合的 tool-call：往前收缩会越过起点 → 没有更小的合法区间。
  seedPending(temp.dbPath, { start: 2, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    await settle();
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0, '不应硬压不平衡区间');
    const warned = ctx.logs.find((entry) => /no replaceable node or no balanced boundary/u.test(entry.message));
    assert.ok(warned, '应 warn 说明丢弃原因');
    assert.equal(warned.level, 'warn');
    // pending 已丢弃：下一轮不再尝试
    await preStep(ctx, session, 2, '再继续。');
    await settle();
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0, '丢弃后不应重试同一区间');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('非确定性错误重试 3 次后丢弃，并记录连续失败次数与最后一条错误', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-retry',
    events: [userEvent('第一条足够长的消息，用来让压缩有活干。', 1), userEvent('第二条。', 2)],
  });
  seedPending(temp.dbPath, { start: 1, end: 2 });
  // retainTokens 远大于本次 surface：巩固每一轮都选不出新窗口，pending 始终是播种的
  // 那一个；否则巩固会写新 pending 把区间换掉、重试计数归零。
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 20_000, compactMinRegionTokens: 0 });
  try {
    // 1、2、3 轮：每次都失败，pending 保留并累加 attempts
    let boom = new Error('upstream 502 from platform');
    ctx.failures.set('compaction.compactRegion', boom);
    for (let turn = 1; turn <= 3; turn += 1) {
      await preStep(ctx, session, turn, `第 ${turn} 轮。`);
      await settle();
    }
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 3, '应重试满 3 次');
    const retryLogs = ctx.logs.filter((entry) => /keeping pending_compact|compaction dropped/u.test(entry.message));
    assert.ok(retryLogs.length >= 3, '每次失败都要有记录');

    // 第 4 轮：达到上限 → 丢弃，不再调用
    await preStep(ctx, session, 4, '第四轮。');
    await settle();
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 3, '达到上限后不再重试');
    const dropped = ctx.logs.find((entry) => /compaction dropped after failure/u.test(entry.message));
    assert.ok(dropped, '应记录丢弃');
    assert.equal(dropped.level, 'warn');
    // 原始错误文案不截断地挂在 meta.message 上（C120-L1）
    assert.match(String(dropped.meta?.message), /upstream 502/u);
    assert.equal(dropped.meta?.attempts, 3);
    assert.equal(dropped.meta?.deterministic, false);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('压缩成功后清零连续失败计数与区间重试计数', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-clear',
    events: [userEvent('第一条足够长的消息。', 1), userEvent('第二条。', 2)],
  });
  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    ctx.failures.set('compaction.compactRegion', new Error('temporary glitch'));
    await preStep(ctx, session, 1, '第一轮。');
    await settle();
    assert.equal(temp.store.getMeta('compaction_failures:main'), '1', '失败计数累加');
    assert.match(String(temp.store.getMeta('compaction_last_error:main')), /temporary glitch/u);

    ctx.failures.delete('compaction.compactRegion');
    await preStep(ctx, session, 2, '第二轮。');
    await settle();
    assert.equal(temp.store.getMeta('compaction_failures:main'), null, '成功后清零（删键）');
    assert.equal(temp.store.getMeta('compaction_last_error:main'), null, '成功后删掉错误原文');
    assert.equal(temp.store.getMeta('compaction_attempts:main'), null, '成功后删掉区间计数');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- C120-M1

test('compactMinRegionTokens：区间小于门槛时不登记 pending（默认 4096）', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-gate', events: [userEvent('短短一句。', 1)] });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    await preStep(ctx, session, 1, '再短一句。');
    await waitFor(() => temp.store.getWatermark('main') > 0, { label: 'consolidation' });
    await settle();
    assert.equal(ctx.callsOf('compaction.compactRegion').length, 0, '小区间不该触发压缩');
    assert.equal(temp.store.getMeta('compaction_attempts:main'), null, '没有重试记录');
    const row = temp.store.db.prepare("SELECT status FROM consolidations WHERE kind = 'nap'").get();
    assert.ok(row, '巩固仍然照常写库');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- C120-M3

test('C120-M3：区间只有注入消息与工具往来时记 status=empty，不算失败', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 3,
    now: TEST_NOW,
    // 只有工具占位（surface.flattenMessage 的形态），没有用户/助手正文
    regionText: 'assistant: [tool call bash]\ntool: [tool result]',
    llm: () => {
      throw new Error('不应调用模型');
    },
  });
  assert.equal(result.empty, true);
  assert.equal(result.skipped, false);
  assert.equal(result.facts, 0);
  assert.equal(result.episodeId, null);
  assert.deepEqual(store.consolidationStatusCounts('main'), { empty: 1 });
  assert.equal(store.stats().episodes, 0, '不写占位 episode');
  assert.equal(store.getWatermark('main'), 3, 'empty 也推进游标，后续区间可以压缩');
});

test('C120-M3：模型给空草稿时重试一次，仍空则记 empty（不记 failed）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  let calls = 0;
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    now: TEST_NOW,
    regionText: 'user: 今天挺顺的\nassistant: 那就好',
    llm: () => {
      calls += 1;
      return { episode: null, facts: [], reminders: [] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.empty, true);
  assert.deepEqual(store.consolidationStatusCounts('main'), { empty: 1 });
  assert.equal(store.getWatermark('main'), 2);
});

// ---------------------------------------------------------------- 迁移

test('schema v15 → v16：重建 consolidations 时保留旧行，并接受 status=empty', (t) => {
  // 自己管临时目录：makeTempStore 的 t.after 关闭顺序会让 rm 撞上还开着的句柄。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v16-'));
  const dbPath = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const startedAt = Math.floor(TEST_NOW / 1000);
  const store = Store.open(dbPath);
  let row = null;
  try {
    row = store.insertConsolidation({
      scope: 'main',
      kind: 'nap',
      status: 'written',
      session_id: 'main',
      trigger: 'turn',
      upto_seq: 5,
      started_at: startedAt,
      finished_at: startedAt,
    });
    // 把库退回到 v15 的 consolidations 形态：CHECK 不含 empty。
    store.db.exec('PRAGMA foreign_keys = OFF');
    store.db.exec(`
      CREATE TABLE consolidations_v15 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('nap','deep','forget_flush')),
        trigger TEXT NOT NULL,
        upto_seq INTEGER NOT NULL,
        turn_from INTEGER,
        turn_to INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running','written','compacted','failed')),
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        compaction_start_seq INTEGER
      );
      INSERT INTO consolidations_v15 (
        id, scope, session_id, kind, trigger, upto_seq, turn_from, turn_to,
        tokens_in, tokens_out, status, error, started_at, finished_at, compaction_start_seq
      ) SELECT
        id, scope, session_id, kind, trigger, upto_seq, turn_from, turn_to,
        tokens_in, tokens_out, status, error, started_at, finished_at, compaction_start_seq
      FROM consolidations;
      DROP TABLE consolidations;
      ALTER TABLE consolidations_v15 RENAME TO consolidations;
      CREATE UNIQUE INDEX ux_consolidations_scope_upto ON consolidations(scope, upto_seq, kind);
      CREATE INDEX ix_consolidations_scope ON consolidations(scope, upto_seq);
    `);
    store.setMeta('schema_version', '15');
  } finally {
    store.close();
  }

  const migrated = Store.open(dbPath);
  try {
    assert.equal(migrated.getMeta('schema_version'), '16');
    const kept = migrated.getConsolidation(row.id);
    assert.ok(kept, '旧行必须保留');
    assert.equal(kept.status, 'written');
    assert.equal(kept.upto_seq, 5);
    // 新库形态接受 empty
    const empty = migrated.insertConsolidation({
      scope: 'main',
      kind: 'nap',
      status: 'empty',
      session_id: 'main',
      trigger: 'turn',
      upto_seq: 6,
      started_at: startedAt,
      finished_at: startedAt,
    });
    assert.equal(migrated.getConsolidation(empty.id).status, 'empty');
    assert.equal(migrated.getWatermark('main'), 6, 'empty 也推进巩固水位');
  } finally {
    migrated.close();
  }
});
