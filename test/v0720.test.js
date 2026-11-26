/**
 * H1（v0.7.20）：裁剪与选区顺序、seq 锚点重映射。
 *
 * ## ⚠️ 非真机证据
 *
 * 本文件全部是**测试替身**（自建 `pruneSession` / `compactRegion` mock），断言的是：
 * 插件在「宿主裁剪真的把 surface 里的端点 seq 换成新 seq」之后的顺序与锚点语义。
 * 它不证明真机宿主（0.2.2-rc.5）下的压缩量、字符收益或阈值行为。
 *
 * ## 被测语义（对应任务书要求 1 / 要求 2）
 *
 * 1. `maybeCompact` / `runBackfillCompaction` 必须**先裁再选区**：宿主
 *    `pruneSession` 用 surfaceOp replace 把超阈值 tool/result 换成新 seq，原 seq
 *    离开 surface；宿主 `validateSurfaceRegion` 要求两端点都在 surface。先选区
 *    再裁剪时，终点常落在 tool/result 上 → `compactRegion` 抛 not found → 压缩失败
 *    → 下个窗口走「pending compaction region expired; dropping」，已巩固区间永不
 *    再压缩。
 * 2. 每次 `pruneSession` 之后，插件必须用返回的
 *    `pruned[].originalSeq → replacementSeq` 把本 scope 的持久化 seq 锚点就地
 *    重映射（内存 + 库内），否则 `ensureWatermark` 会把水位前挪（`replacement-lost`），
 *    引发大段重复巩固。
 *
 * ## 断言手段
 *
 * - mock `pruneSession` **真实改写** surface：把某位置的 seq 换成新 seq、把
 *   `bySeq` 的键搬过去、并像宿主那样把替换节点的事件通知给插件的 surface 索引；
 * - mock `compactRegion` 先校验 `start` / `end` 都在**裁剪后**的 surface 里，再真实
 *   替换区间（不在就抛 `not found`，与宿主 `validateSurfaceRegion` 同形）；
 * - 「水位不前挪」用三条独立证据：`stale watermark re-anchored` warn 不出现、
 *   `schema_meta:watermark_anchor:<scope>` 跟随新 seq、`store.getWatermark` 跟随新 seq。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

const SCOPE = 'main';

/**
 * 巩固草稿：**非空**（空草稿会被 consolidate 再问一次模型，见
 * src/memory/consolidate.js:1292-1305 的 empty-draft 重试，会污染「只巩固一次」的计数）。
 */
const DRAFT = {
  episode: {
    title: '聊了新话题',
    summary: '用户提到新话题甲。',
    topics: ['新话题'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'knowledge',
      subject_text: '新话题',
      predicate: '又叫',
      object_text: '新话题甲',
      statement: '新话题又叫新话题甲。',
      source_kind: 'consolidated',
      source_excerpt: '用户：新话题甲',
      salience: 'normal',
    },
  ],
  reminders: [],
};

// ---------------------------------------------------------------- 事件构造（照 v0719）

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
    data: { callId: 'call-0', content: [{ type: 'text', text: 'ok' }] },
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

/**
 * 一条能通过配平校验的区间：user(1) / assistant tool-call(2) / tool result(3) / assistant text(4)。
 * 终点是 tool/result —— 正是「先选区再裁剪」会踩雷的形状。
 */
function pairedEvents() {
  return [
    userEvent('拉一下日志。', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
    assistantTextEvent('构建通过。', 4),
  ];
}

// ---------------------------------------------------------------- 接线骨架

/**
 * @param {{now?: number, totalTokens?: number}} [options]
 */
function makeCtx({ now = TEST_NOW, totalTokens = 41_000 } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { register: () => () => {} };
  ctx.tools = { register: () => () => {} };
  /** 巩固请求（用来断言「没有把已巩固的旧内容再喂一遍」）。 */
  const llmRequests = [];
  ctx.llmRequests = llmRequests;
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream(request) {
      llmRequests.push(request);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
  return ctx;
}

/**
 * 把宿主「替换节点」的事件通知给插件索引（宿主真实路径里是 platform 发 `session/event`）。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {object} event
 */
function notifySurfaceIndex(ctx, session, event) {
  for (const entry of ctx.listeners.get('session/event') ?? []) {
    if (!entry.disposed) entry.listener(session, event);
  }
}

/**
 * 可控的 `pruneSession` 替身：**真实**把表面上的 seq 换成新 seq（不是空操作）。
 *
 * `plans[n]` 是第 n 次调用的裁剪计划；用数组而不是固定行为，才能分别命中
 * 「bootstrap 裁一次」「压缩/回填路径再裁一次」两个时机。
 *
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {Array<Array<{originalSeq: number, replacementSeq: number}>>} plans
 */
function makePruner(ctx, session, plans) {
  const calls = [];
  return {
    calls,
    pruneSession(target) {
      const plan = plans[calls.length] ?? [];
      const pruned = [];
      for (const step of plan) {
        const position = session.surface.nodes.indexOf(step.originalSeq);
        if (position < 0) continue;
        const event = session.bySeq.get(step.originalSeq) ?? null;
        // 平台语义：surfaceOp replace —— 同一位置换成新 seq，旧 seq 离开 surface。
        session.surface.nodes[position] = step.replacementSeq;
        session.bySeq.delete(step.originalSeq);
        const replacement = {
          ...(event ?? {}),
          seq: step.replacementSeq,
          type: event?.type ?? 'tool/result',
          data: { callId: 'call-0', content: [{ type: 'text', text: '[pruned]' }] },
        };
        session.bySeq.set(step.replacementSeq, replacement);
        notifySurfaceIndex(ctx, session, replacement);
        pruned.push({
          originalSeq: step.originalSeq,
          replacementSeq: step.replacementSeq,
          callId: 'call-0',
          charsBefore: 9000,
          charsAfter: 12,
        });
      }
      calls.push({ target, plan, pruned });

      return { pruned, charsRemoved: pruned.length * 8988 };
    },
  };
}

/**
 * `compactRegion` 替身：先按宿主 `validateSurfaceRegion` 的语义校验端点**在当前
 * （裁剪后）surface 里**，再真实替换区间。
 *
 * 端点不在就抛 `start/end seq N not found in surface` —— 与宿主同形，这样「先裁后选」
 * 一旦回退成本用例立刻红。
 *
 * @param {FakeCtx} ctx
 * @param {object} session
 */
function makeCompaction(ctx, session) {
  const attempts = [];
  const accepted = [];
  return {
    attempts,
    accepted,
    compactRegion(start, end) {
      attempts.push({ start, end, surface: [...session.surface.nodes] });
      if (!session.surface.nodes.includes(start)) {
        throw new Error(`compactRegion: start seq ${start} not found in surface`);
      }
      if (!session.surface.nodes.includes(end)) {
        throw new Error(`compactRegion: end seq ${end} not found in surface`);
      }
      const replaced = ctx.compactSession(session.id, start, end);
      accepted.push({ start, end, replacementSeq: replaced.replacement?.seq ?? null });
      return { compactionId: `fake-compaction-${accepted.length}`, start, end };
    },
  };
}

/**
 * 播种巩固行（用独立连接写库，apply 之前调用）。
 * @param {string} dbPath
 * @param {{start: number, end: number, status?: string, kind?: string}} row
 * @returns {number} 行 id
 */
function seedConsolidation(dbPath, { start, end, status = 'written', kind = 'nap' }) {
  const store = Store.open(dbPath);
  try {
    const inserted = store.insertConsolidation({
      scope: SCOPE,
      kind,
      status,
      session_id: SCOPE,
      trigger: 'turn',
      upto_seq: end,
      turn_from: start,
      turn_to: end,
      compaction_start_seq: start,
      started_at: Math.floor(TEST_NOW / 1000),
      finished_at: Math.floor(TEST_NOW / 1000),
    });
    return inserted?.id ?? inserted;
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
 * @param {number} [seq] 本轮 user 事件的显式 seq（不给就用 max+1）。
 *
 * 显式 seq 很重要：宿主把裁剪替换节点 append 到日志末尾，replacementSeq 一定大于
 * 当前所有 seq。用例里若让 emit 自动取 max+1，替换 seq 可能与本轮 user 事件撞号，
 * 于是「旧 seq 已离开 surface」这件事被撞号掩盖，判别力失效。
 */
async function preStep(ctx, session, turn, text, seq) {
  ctx.emitSessionEvent(session.id, userEvent(text, seq));
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

/** @param {Store} store */
function pruneStats(store) {
  const raw = store.getMeta(`prune_stats:${SCOPE}`);
  return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null;
}

/**
 * 读 consolidations 的一行（用独立连接读，避免依赖插件的句柄）。
 * @param {Store} store
 * @param {string} id
 */
function consolidationRow(store, id) {
  const row = store.db
    .prepare('SELECT id, status, upto_seq FROM consolidations WHERE id = ?')
    .get(id);
  return row ?? null;
}

/** @param {FakeCtx} ctx */
function reanchorWarns(ctx) {
  return ctx.logs.filter(
    (entry) => entry.level === 'warn' && /stale watermark re-anchored/u.test(String(entry.message)),
  );
}

/** @param {FakeCtx} ctx */
function warnsMatching(ctx, pattern) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && pattern.test(String(entry.message)));
}

// ---------------------------------------------------------------- H1-001 区间终点被裁

test('H1-001（v0.7.20 非真机证据）：区间终点被裁后仍能压缩，且 compactRegion 收到重映射后的 end', async () => {
  // 判别力：删掉 src/index.js 里 pruneBeforeCompact 末尾的 `remapPrunedSeqs(state, scope, pruned);`
  // → pending.endSeq 仍是被裁掉的旧 seq → maybeCompact 走「pending compaction region expired;
  // dropping」→ 本用例（压缩成功 / end=5 / 行 status='compacted'）红。
  const temp = makeTempStore();
  const ctx = makeCtx({ totalTokens: 1_000 });
  const session = ctx.addSession({ id: 'session-h1-001', events: pairedEvents() });
  // 第 1 次（bootstrap）不裁；第 2 次（maybeCompact 里、选区之前）把终点 3 换成 5。
  const pruner = makePruner(ctx, session, [[], [{ originalSeq: 3, replacementSeq: 5 }]]);
  ctx.toolResultPruner = pruner;
  const compaction = makeCompaction(ctx, session);
  ctx.compaction.compactRegion = compaction.compactRegion.bind(compaction);

  // pending 区间正好以 tool/result(3) 收尾。
  const rowId = seedConsolidation(temp.dbPath, { start: 1, end: 3 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。', 101);
    await settle();

    assert.equal(pruner.calls.length, 2, `应恰好裁两次（bootstrap + 压缩前）：${pruner.calls.length}`);
    assert.deepEqual(
      pruner.calls[1].pruned.map((row) => [row.originalSeq, row.replacementSeq]),
      [[3, 5]],
      '第二次裁剪必须真的把 3 换成 5',
    );
    // surface 在压缩后只剩替换节点，所以要看「压缩前那一刻」的 surface 快照。
    const prunedSurface = compaction.attempts[0]?.surface ?? session.surface.nodes;
    assert.ok(!prunedSurface.includes(3), `旧 seq 3 必须离开 surface：${prunedSurface}`);
    assert.ok(prunedSurface.includes(5), `新 seq 5 必须在裁剪后的 surface：${prunedSurface}`);

    assert.equal(
      warnsMatching(ctx, /pending compaction region expired/u).length,
      0,
      '终点被重映射后不该再走「区间过期丢弃」',
    );
    assert.equal(compaction.attempts.length, 1, `应尝试压缩一次：${compaction.attempts.length}`);
    assert.deepEqual(
      compaction.accepted.map((call) => [call.start, call.end]),
      [[1, 5]],
      'compactRegion 必须收到「裁剪后 surface 里的端点」——end 是重映射后的 5，不是旧 3',
    );
    const row = consolidationRow(temp.store, rowId);
    assert.equal(row?.status, 'compacted', '压缩成功必须把巩固行标成 compacted（pending 不是被丢弃）');
    assert.equal(temp.store.getMeta(`pending_compact:${SCOPE}`), null, '成功后 pending_compact 正常清空');
    const watermark = temp.store.getWatermark(SCOPE);
    assert.ok(
      Number.isInteger(watermark) && watermark >= 6,
      `水位必须落在压缩替换节点上（>=6），实际 ${watermark}`,
    );
    assert.notEqual(
      temp.store.getMeta(`watermark_anchor:${SCOPE}`),
      '3',
      '成功后水位锚点不得还停在旧 seq 3（清掉或 -1 都可以）',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- H1-002 水位节点被裁

test('H1-002（v0.7.20 非真机证据）：水位节点被裁后不前挪、不触发 reanchor', async () => {
  // 判别力：删掉 remapPrunedSeqs 里「内存水位 + watermark_anchor meta + consolidations.upto_seq」
  // 三段重映射 → 水位仍是已被裁掉的 3 → ensureWatermark 走 resolveReanchor 前挪到 0，
  // 打 'stale watermark re-anchored' → 本用例（warn=0 / 水位=5 / 锚点=5）红。
  const temp = makeTempStore();
  const ctx = makeCtx({ totalTokens: 1_000 });
  const session = ctx.addSession({ id: 'session-h1-002', events: pairedEvents() });
  const pruner = makePruner(ctx, session, [[{ originalSeq: 3, replacementSeq: 5 }]]);
  ctx.toolResultPruner = pruner;
  const compaction = makeCompaction(ctx, session);
  ctx.compaction.compactRegion = compaction.compactRegion.bind(compaction);

  // 水位恰好落在 tool/result(3)：内存锚点、库内 upto_seq 都是 3。
  const rowId = seedConsolidation(temp.dbPath, { start: 1, end: 3, status: 'compacted' });
  temp.store.setMeta(`watermark_anchor:${SCOPE}`, '3');
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。', 101);
    await settle();

    assert.equal(pruner.calls.length, 1, `bootstrap 裁一次：${pruner.calls.length}`);
    assert.ok(session.surface.nodes.includes(5), `新 seq 5 必须在 surface：${session.surface.nodes}`);

    assert.equal(
      reanchorWarns(ctx).length,
      0,
      `水位节点被裁后不得触发 reanchor，实际 warn：${reanchorWarns(ctx).map((row) => row.message)}`,
    );
    assert.equal(
      temp.store.getMeta(`watermark_anchor:${SCOPE}`),
      '5',
      'watermark_anchor 必须就地重映射到替换节点（3 → 5），而不是被清成 -1',
    );
    assert.equal(temp.store.getWatermark(SCOPE), 5, '库内 upto_seq 必须重映射到 5');
    assert.equal(consolidationRow(temp.store, rowId)?.upto_seq, 5, '巩固行 upto_seq 必须重映射（零 DDL）');
    assert.equal(
      warningsForMessage(ctx, /compaction/u).length,
      0,
      `不该有压缩相关告警：${warningsForMessage(ctx, /compaction/u).map((row) => row.message)}`,
    );
    assert.equal(compaction.attempts.length, 0, '没有 pending compact 时不应压缩');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

/**
 * @param {FakeCtx} ctx
 * @param {RegExp} pattern
 */
function warningsForMessage(ctx, pattern) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && pattern.test(String(entry.message)));
}

// ---------------------------------------------------------------- H1-003 回填 pending 端点被裁

test('H1-003（v0.7.20 非真机证据）：回填 pending chunk 端点被裁后仍能回填，pending 不丢', async () => {
  // 判别力：删掉 runBackfillCompaction 里「先 pruneBeforeCompact 再 indexOf」的顺序
  // （或删掉 remapPrunedSeqs 对 compact_backfill:pending 的 chunk 端点重映射）→
  // indexOf(chunk.endSeq=3) 失败 → 'backfill region expired; dropping pending' → 本用例红。
  const temp = makeTempStore();
  const ctx = makeCtx({ totalTokens: 1_000 });
  const session = ctx.addSession({ id: 'session-h1-003', events: pairedEvents() });
  // 第 1 次（bootstrap）不裁；第 2 次（runBackfillCompaction 里、选区之前）裁掉 chunk 终点 3。
  const pruner = makePruner(ctx, session, [[], [{ originalSeq: 3, replacementSeq: 5 }]]);
  ctx.toolResultPruner = pruner;
  const compaction = makeCompaction(ctx, session);
  ctx.compaction.compactRegion = compaction.compactRegion.bind(compaction);

  // 主水位 1（>0 才允许回填），回填 pending 是一个已 ready 的 chunk：[1, 3]。
  seedConsolidation(temp.dbPath, { start: 1, end: 1, status: 'compacted' });
  temp.store.setMeta(
    `compact_backfill:pending:${SCOPE}`,
    JSON.stringify({
      chunk: { startIdx: 0, endIdx: 2, startSeq: 1, endSeq: 3, tokens: 40, count: 2 },
      stage: 'ready',
      consolidationId: null,
      nextSeq: 3,
      atWatermark: false,
    }),
  );
  const handle = apply(ctx, {
    dbPath: temp.dbPath,
    retainTokens: 4,
    compactMinRegionTokens: 0,
    compact: { backfill: { enabled: true, chunkTokens: 1200, maxPerDay: 6 } },
  });
  try {
    await preStep(ctx, session, 1, '继续。', 101);
    await settle();

    assert.equal(pruner.calls.length, 2, `bootstrap + 回填前各裁一次：${pruner.calls.length}`);
    assert.equal(
      warnsMatching(ctx, /backfill region expired/u).length,
      0,
      'chunk 端点被重映射后不该再「丢弃 pending」',
    );
    assert.deepEqual(
      compaction.accepted.map((call) => [call.start, call.end]),
      [[1, 5]],
      '回填压缩必须收到裁剪后 surface 里的端点（end=5）',
    );
    assert.equal(
      temp.store.getMeta(`compact_backfill:pending:${SCOPE}`),
      null,
      '回填成功后 pending 正常清空（不是被「过期」扔掉）',
    );
    assert.equal(
      temp.store.getMeta(`compact_backfill:cursor:${SCOPE}`),
      '5',
      '回填成功后游标推进到重映射后的 nextSeq（3 → 5），不是旧 3',
    );
    assert.equal(
      ctx.logs.filter((entry) => entry.level === 'info' && /backfill chunk compacted/u.test(String(entry.message))).length,
      1,
      '应有一条回填成功日志',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- H1-004 存量裁剪后首次巩固

test('H1-004（v0.7.20 非真机证据）：存量裁剪一次换掉大量节点后锚点全部跟进，首次巩固不重复旧内容', async () => {
  // 判别力：删掉 remapPrunedSeqs 的调用（或只留下顺序修正）→ 水位 3 被裁后 reanchor 到 0
  // → 下一 turn 的巩固选区从 surface 起点开始，把水位之前的旧内容再喂一遍模型 →
  // 本用例（prompt 不含「第一段问题」/ 水位=6）红。
  const temp = makeTempStore();
  const ctx = makeCtx({ totalTokens: 1_000 });
  const session = ctx.addSession({
    id: 'session-h1-004',
    events: [
      userEvent('第一段问题', 1),
      assistantTextEvent('第二段回答', 2),
      userEvent('第三段问题', 3),
    ],
  });
  // 存量裁剪：一次把 1/2/3 全部换成 5/6/7（模拟「启动后一次性替换大量节点」）。
  // 替换 seq 取「当前最大 seq + 1 起」，与宿主 append 语义一致；pre-step 随后追加的
  // 用户消息拿到 4，所以 surface 顺序是 [5, 6, 7, 4]（替换节点在末尾，位置不变）。
  const pruner = makePruner(ctx, session, [
    [
      { originalSeq: 1, replacementSeq: 5 },
      { originalSeq: 2, replacementSeq: 6 },
      { originalSeq: 3, replacementSeq: 7 },
    ],
    [],
  ]);
  ctx.toolResultPruner = pruner;
  const compaction = makeCompaction(ctx, session);
  ctx.compaction.compactRegion = compaction.compactRegion.bind(compaction);

  seedConsolidation(temp.dbPath, { start: 1, end: 3, status: 'compacted' });
  temp.store.setMeta(`watermark_anchor:${SCOPE}`, '3');
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '第四段问题');
    await settle();

    assert.equal(pruner.calls.length, 1, `turn 1 只做一次存量裁剪：${pruner.calls.length}`);
    assert.equal(pruner.calls[0].pruned.length, 3, '存量裁剪一次替换三个节点');
    assert.deepEqual(pruneStats(temp.store), { count: 3, charsRemoved: 26_964 }, '累计口径仍按 pruned 条数与 charsRemoved 记');
    assert.deepEqual(
      session.surface.nodes,
      [5, 6, 7, 4],
      `surface 里旧 seq 全部被换掉：${session.surface.nodes}`,
    );

    // 锚点全部跟进：内存/库/锚点 meta 都指向替换节点 7。
    assert.equal(reanchorWarns(ctx).length, 0, `存量裁剪不得触发 reanchor：${reanchorWarns(ctx).map((row) => row.message)}`);
    assert.equal(temp.store.getMeta(`watermark_anchor:${SCOPE}`), '7', '水位锚点必须重映射到替换节点');
    assert.equal(temp.store.getWatermark(SCOPE), 7, '库内 upto_seq 必须重映射到 7');
    assert.equal(temp.store.getMeta(`pending_compact:${SCOPE}`), null, 'turn 1 不产生 pending compact');
    assert.equal(compaction.attempts.length, 0, 'turn 1 没有可压区间');
    assert.equal(ctx.llmRequests.length, 0, 'turn 1 token 低于阈值，不应发起巩固');

    // turn 2：水位 7 之后才有新内容，巩固选区必须只含新内容。
    const before = temp.store.getMeta(`watermark_anchor:${SCOPE}`);
    ctx.returns['tokenMeter.measure'].totalTokens = 41_000;
    ctx.emitSessionEvent(session.id, userEvent('新话题甲', 8));
    ctx.emitSessionEvent(session.id, assistantTextEvent('新话题乙回答', 9));
    await preStep(ctx, session, 2, '新话题丙');
    await settle();

    // turn 2 开始前的锚点必须还是替换节点 7（不是旧 3、也不是被前挪的 0/4）；巩固成功后
    // 由 clearWatermarkAnchor 正常清掉，所以这里只断言进入 turn 2 时的状态。
    assert.equal(before, '7', 'turn 2 开始前水位锚点仍是替换节点 7');
    assert.equal(reanchorWarns(ctx).length, 0, 'turn 2 也不得 reanchor');
    assert.equal(ctx.llmRequests.length, 1, `应发起一次巩固：${ctx.llmRequests.length}`);

    const promptText = JSON.stringify(ctx.llmRequests[0]?.messages ?? []);
    for (const stale of ['第一段问题', '第二段回答', '第三段问题']) {
      assert.ok(
        !promptText.includes(stale),
        `水位(7)之前、已经巩固过的旧内容不该再进选区：命中「${stale}」\n${promptText}`,
      );
    }
    // 选区 = 水位(7) 之后已完成的轮次：seq 4（turn 1 的用户消息）与 seq 8/9；本 turn 自己
    // 那条「新话题丙」还没被回答，选区收口在它之前（不压半轮）。
    for (const fresh of ['第四段问题', '新话题甲', '新话题乙回答']) {
      assert.ok(promptText.includes(fresh), `水位之后的新内容必须进选区：缺「${fresh}」\n${promptText}`);
    }
    const watermark = temp.store.getWatermark(SCOPE);
    assert.ok(
      Number.isInteger(watermark) && watermark > 7,
      `巩固成功应把水位推到选区终点（>7），实际 ${watermark}`,
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- T1 存量裁剪只在主会话

const THREAD_KEY = 'deploy';
const THREAD_SCOPE = `thread:${THREAD_KEY}`;
const THREAD_SESSION_ID = 'sess-thread-t1';

/** 只计数的 `pruneSession` 替身（不替换 surface）：用来证明「裁了没有 / 裁了几次」。 */
function makeCountingPruner() {
  const calls = [];
  return {
    calls,
    pruneSession(target) {
      calls.push(target);
      return { pruned: [], charsRemoved: 0 };
    },
  };
}

/**
 * 播种一条线程 scope 的「已巩固、可压缩」nap 行（独立连接，apply 之前调用）。
 * `recoverPendingCompacts` 会按 consolidations 兜底为 `thread:<key>` 建 pending。
 *
 * @param {string} dbPath
 * @param {{start: number, end: number}} region
 */
function seedThreadConsolidation(dbPath, { start, end }) {
  const store = Store.open(dbPath);
  try {
    store.insertConsolidation({
      scope: THREAD_SCOPE,
      kind: 'nap',
      status: 'written',
      session_id: THREAD_SESSION_ID,
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

test('T1-001（v0.7.20 非真机证据）：首个 pre-step 是线程会话时不裁存量、不置 done，主会话随后仍兜底裁一次', async () => {
  // 判别力：删掉 src/index.js `runPreStep` 里 `if (scope === SCOPE && payload?.agent !== null …)`
  // 的 `scope === SCOPE` 条件，**并**删掉 `maybeBootstrapPrune` 开头的
  // `if (state.currentScope !== SCOPE) return;`（两处是同一语义的纵深防线，只删一处会被
  // 另一处遮蔽）→ 线程会话的首个 pre-step 就会裁存量并把 done 置位，本用例的
  // prunes===0 / prune_stats:thread:deploy 为 null / 随后主会话仍裁一次 三条全红。
  const temp = makeTempStore();
  const ctx = makeCtx();
  temp.store.upsertThread({
    key: THREAD_KEY,
    name: '部署',
    description: '部署线程',
    session_id: THREAD_SESSION_ID,
    status: 'active',
  });
  const threadSession = ctx.addSession({ id: THREAD_SESSION_ID, events: pairedEvents() });
  const mainSession = ctx.addSession({ id: 'sess-main-t1', events: pairedEvents() });
  const pruner = makeCountingPruner();
  ctx.toolResultPruner = pruner;
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 20_000, compactMinRegionTokens: 0 });
  try {
    // 1) 线程 scope 的首个 pre-step：不得触发启动存量裁剪（清的是线程 surface）。
    await preStep(ctx, threadSession, 1, '线程里继续。');
    await settle();
    assert.equal(pruner.calls.length, 0, `线程 scope 的 pre-step 不得触发存量裁剪，实际 ${pruner.calls.length} 次`);
    assert.equal(
      temp.store.getMeta(`prune_stats:${THREAD_SCOPE}`),
      null,
      '线程 scope 不该留下 prune_stats（证明没在 thread scope 下裁）',
    );
    assert.deepEqual(
      temp.store.listEvents({ table_name: 'tool_prune' }),
      [],
      '线程 scope 不该留下 tool_prune 审计行',
    );

    // 2) 线程 pre-step 不得把 pruneBootstrapDone 置位：主会话首个 pre-step 仍要兜底裁一次。
    await preStep(ctx, mainSession, 1, '主会话继续。');
    await settle();
    assert.equal(pruner.calls.length, 1, `主会话首个 pre-step 必须兜底裁一次，实际 ${pruner.calls.length} 次`);
    assert.equal(pruner.calls[0], mainSession, '存量裁剪必须裁主会话的 session，而不是线程的');

    // 3) done 已置位：主会话第二个 pre-step 不再裁。
    await preStep(ctx, mainSession, 2, '主会话第二问。');
    await settle();
    assert.equal(pruner.calls.length, 1, `done 置位后不得再裁，实际 ${pruner.calls.length} 次`);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('T1-002（v0.7.20 非真机证据）：主会话首个 pre-step 的存量裁剪恰好一次，审计落 main scope', async () => {
  // 判别力：删掉 `runPreStep` 里的 `maybeBootstrapPrune(state);` → 本用例 prunes===0 红；
  // 删掉 `maybeBootstrapPrune` 里的 `if (state.pruneBootstrapDone === true) return;` →
  // 第二个 pre-step 又裁一次，本用例第二次/第三次的 prunes===1 红。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'sess-main-once', events: pairedEvents() });
  // 真实替换一个节点（tool/result seq 3 → 100），让「裁在哪个 scope」有落库证据；
  // 第二次起无计划（returns 空），反复调用也只会被计数，不会重复动 surface。
  const pruner = makePruner(ctx, session, [
    [{ originalSeq: 3, replacementSeq: 100 }],
  ]);
  ctx.toolResultPruner = pruner;
  const compaction = makeCompaction(ctx, session);
  ctx.compaction.compactRegion = compaction.compactRegion.bind(compaction);
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 20_000, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '第一问。');
    await settle();
    assert.equal(pruner.calls.length, 1, `主会话首个 pre-step 只裁一次存量，实际 ${pruner.calls.length} 次`);
    assert.equal(pruner.calls[0].target, session, '裁的必须是当前主会话的 session');

    const events = temp.store.listEvents({ table_name: 'tool_prune' });
    assert.equal(events.length, 1, `非空裁剪只写一条审计，实际 ${events.length} 条`);
    assert.equal(events[0].row_id, SCOPE, '存量裁剪必须记在 main scope 名下');
    assert.deepEqual(pruneStats(temp.store), { count: 1, charsRemoved: 8988 }, '累计口径按 pruned 条数记账');

    // 第二个 turn：done 已置位，不再裁。
    await preStep(ctx, session, 2, '第二问。');
    await settle();
    assert.equal(pruner.calls.length, 1, `第二个 pre-step 不得再裁，实际 ${pruner.calls.length} 次`);

    // idle 窗口也不再裁（v0.7.20 删除了 idle-probe 的存量裁剪臂）。
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(pruner.calls.length, 1, `idle 窗口不得触发存量裁剪，实际 ${pruner.calls.length} 次`);
    assert.deepEqual(pruneStats(temp.store), { count: 1, charsRemoved: 8988 }, '累计值保持原样');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('T1-003（v0.7.20 非真机证据）：线程会话在各自压缩前照常裁（主会话限定不波及线程压缩路径）', async () => {
  // 判别力：把主会话限定错误地下推到 `pruneBeforeCompact`（例如在它开头加
  // `if (state.currentScope !== SCOPE) return;`）→ 线程压缩前不再裁，本用例的
  // 序列 'prune → compact' 变成 'compact'，红。
  const temp = makeTempStore();
  const ctx = makeCtx();
  temp.store.upsertThread({
    key: THREAD_KEY,
    name: '部署',
    description: '部署线程',
    session_id: THREAD_SESSION_ID,
    status: 'active',
  });
  const session = ctx.addSession({ id: THREAD_SESSION_ID, events: pairedEvents() });
  const sequence = [];
  const pruner = makeCountingPruner();
  const pushPrune = pruner.pruneSession.bind(pruner);
  ctx.toolResultPruner = {
    pruneSession(target) {
      sequence.push('prune');
      return pushPrune(target);
    },
  };
  const compaction = makeCompaction(ctx, session);
  const compactRegion = compaction.compactRegion.bind(compaction);
  ctx.compaction.compactRegion = function patched(start, end, agent, signal) {
    sequence.push('compact');
    return compactRegion(start, end, agent, signal);
  };
  // 线程 scope 的 pending 压缩区间：end 落在 assistant tool-call(2) 上 → 收缩到 1 才平衡，
  // 压缩一定发生（与 v0719 T1-001 同一手法，只是 scope 换成 thread:<key>）。
  seedThreadConsolidation(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '线程继续。');
    await settle();

    assert.equal(
      sequence.join(' → '),
      'prune → compact',
      `线程压缩路径仍必须先裁再压（且只有压缩前那一次，没有主会话专属的存量裁剪），实际序列：${sequence.join(' → ')}`,
    );
    assert.equal(compaction.accepted.length, 1, '线程区间应真的被压缩');
    assert.equal(pruner.calls.length, 1, '线程压缩前恰好裁一次');
    assert.equal(pruner.calls[0], session, '裁的是线程自己的 session');
    assert.deepEqual(pruneStats(temp.store), null, '线程裁剪不得记到 main scope 名下');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
