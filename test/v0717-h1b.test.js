// v0.7.17 H1-B：历史回填执行层（独立 pendingBackfill + 两段式压缩 + 水位红线）。
//
// **非真机证据**：本文件全部使用替身 —— 模型、宿主压缩（`platform.compactRegion`）、
// surface 快照、时钟都不是真实宿主。真机行为（宿主每 pre-step 窗口至多一次
// compactRegion、压缩后 seq 重映射的真实形状）无法在本机验证。
//
// 行号/路径引用本机 asar 扁平布局：
// `D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\...`（只有 read 能穿透）。

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  initialWatermark,
  maybeBackfill,
  pendingBackfillOf,
  runBackfillCompaction,
  runBackfillJob,
} from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { normalizeConfig } from '../src/config.js';
import { estimateBackfill, planBackfillChunks } from '../src/session/backfill.js';
import { Store } from '../src/memory/store.js';
import { recoverPendingCompacts } from '../src/state/pending-compact.js';
import { apply as applyCordis } from '../src/index.js';
import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';
import { zonedDayKey } from '../src/time.js';
import { buildWeeklyMemoryReport } from '../src/memory/weekly-report.js';

const SCOPE = 'main';
const DAY_KEY = zonedDayKey(TEST_NOW, 'Asia/Shanghai');
const CURSOR_KEY = `compact_backfill:cursor:${SCOPE}`;
const DAY_META_KEY = `compact_backfill:day:${SCOPE}`;
const FLOOR_KEY = `compact_backfill:floor:${SCOPE}`;
const PENDING_KEY = `compact_backfill:pending:${SCOPE}`;
const ANCHOR_KEY = `watermark_anchor:${SCOPE}`;
// refreshSurface 需要 payload.agent.session（宿主 pre-step 的真实形状）。
const PAYLOAD = { agent: { id: 'agent-main', session: { id: 'session-h1b' } } };

/**
 * 造一个 surface 快照（seqs / nodes / records 三件套与 surface.js 对齐）。
 * @param {Array<{seq: number, role?: string, text?: string, tokens?: number}>} specs
 * @returns {object}
 */
function makeSnapshot(specs) {
  return {
    seqs: specs.map((spec) => Number(spec.seq)),
    nodes: specs.map((spec) => ({
      seq: Number(spec.seq),
      tokens: spec.tokens ?? 600,
      heuristicTokens: spec.tokens ?? 600,
    })),
    records: specs.map((spec) => ({
      seq: Number(spec.seq),
      role: spec.role ?? 'user',
      text: spec.text ?? `第 ${spec.seq} 句`,
      tokens: spec.tokens ?? 600,
      toolDelta: 0,
      sourceKind: null,
      missing: false,
    })),
    missing: 0,
    incomplete: false,
  };
}

/**
 * 造一个最小可用的 wiring state（只实现 H1-B 用到的字段）。
 * @param {object} options
 * @returns {object}
 */
function makeState(options = {}) {
  const store = options.store;
  const logs = [];
  const compactCalls = [];
  const metrics = [];
  const metaWrites = [];
  const originalSetMeta = store.setMeta.bind(store);
  store.setMeta = (key, value) => {
    metaWrites.push({ key, value });
    return originalSetMeta(key, value);
  };
  let current = options.snapshot ?? makeSnapshot([]);
  const llmCalls = [];
  const state = {
    store,
    platform: {
      now: () => TEST_NOW,
      log: (level, message, detail) => logs.push({ level, message, detail }),
      capabilities: { compaction: options.compaction !== false },
      compactRegion: async (start, end, agent) => {
        compactCalls.push({ start, end, agent });
        if (options.compactFails === true) throw new Error('compact boom');
      },
    },
    config: options.config ?? normalizeConfig({
      compact: { backfill: { enabled: true, chunkTokens: 1200, maxPerDay: 6 } },
    }),
    metrics: { inc: (name) => metrics.push(name), observe: () => {} },
    surface: { snapshot: async () => current },
    surfaceSnapshot: current,
    surfaceSnapshotByScope: new Map([[SCOPE, current]]),
    // refreshSurface 需要记录上一次的 seq 列表以判断面是否变化（生产在 createWiringState）。
    prevSurfaceSeqsByScope: new Map(),
    currentScope: SCOPE,
    watermarkByScope: new Map([[SCOPE, options.watermark ?? 0]]),
    pendingBackfillByScope: new Map(),
    pendingCompact: new Map(),
    compactedThisTurn: false,
    transcript: [],
    disposed: false,
    companion: {},
  };
  if (options.llm !== false) {
    // 默认空草稿会触发 consolidate.js:1292-1304 的 C120-M3「再问一次」；需要精确调用次数
    // 的用例可传 `llmResponse` 返回非空草稿。
    const respond = typeof options.llmResponse === 'function'
      ? options.llmResponse
      : () => ({ episode: null, facts: [], reminders: [] });
    state.companion = {
      consolidationLlm: async (input) => {
        llmCalls.push(input);
        return respond(input);
      },
    };
  }
  return {
    state,
    logs,
    compactCalls,
    metrics,
    llmCalls,
    metaWrites,
    setSnapshot(next) {
      current = next;
      state.surfaceSnapshot = next;
      state.surfaceSnapshotByScope.set(SCOPE, next);
    },
  };
}

/**
 * 预置一行已成功巩固的记录（决定 store.getWatermark）。
 * @param {object} store
 * @param {number} uptoSeq
 * @param {number} [startedAt]
 * @returns {object}
 */
function seedConsolidation(store, uptoSeq, startedAt = TEST_NOW / 1000, status = 'written') {
  return store.insertConsolidation({
    scope: SCOPE,
    session_id: 'session-h1b',
    kind: 'nap',
    trigger: 'threshold',
    upto_seq: uptoSeq,
    status,
    started_at: startedAt,
    finished_at: startedAt,
  });
}

/**
 * 造一个 ready 状态的 pending（已巩固、等待本窗口压缩）。
 * @param {object} options
 * @returns {object}
 */
function readyPending(options = {}) {
  return {
    chunk: options.chunk ?? {
      startIdx: 1, endIdx: 4, startSeq: 2, endSeq: 5, tokens: 2400, count: 4,
    },
    stage: 'ready',
    consolidationId: options.consolidationId ?? null,
    nextSeq: options.nextSeq ?? 6,
    atWatermark: options.atWatermark === true,
    snapshot: null,
    transcript: [],
  };
}

// ---------------------------------------------------------------------------
// ① 水位红线（用户裁决方案 E）：回填行是 kind='forget_flush'，按构造不参与水位，
// 重开 Store 后主水位不变
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：回填行落在 forget_flush 桶里，主水位不变且重开 Store 后仍不变', async (t) => {
  const { store, dbPath, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-a-' });
  try {
    const watermarkRow = seedConsolidation(store, 10, TEST_NOW / 1000, 'compacted');
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state, compactCalls } = makeState({ store, snapshot, watermark: 10 });
    const pending = {
      chunk: { startIdx: 1, endIdx: 4, startSeq: 2, endSeq: 5, tokens: 1200, count: 4 },
      stage: 'consolidating',
      consolidationId: null,
      nextSeq: 6,
      atWatermark: false,
      snapshot,
      transcript: [],
    };
    await runBackfillJob(state, SCOPE, pending);
    assert.equal(pending.stage, 'ready', '巩固完成推进到 ready');

    const row = store.db.prepare(
      "SELECT * FROM consolidations WHERE scope = ? AND trigger = 'backfill' ORDER BY started_at DESC LIMIT 1",
    ).get(SCOPE);
    assert.ok(row, '回填批写了巩固行');
    assert.equal(row.kind, 'forget_flush', 'E 口径：回填行用 forget_flush（仓储现成的不参与水位语义桶）');
    assert.equal(row.trigger, 'backfill');
    assert.equal(row.upto_seq, 5, '回填行保留本批 endSeq（E 下不 retarget）');
    assert.ok(['written', 'empty'].includes(row.status), '巩固行记录了本批结果（替身空草稿 → empty）');
    assert.notEqual(row.id, watermarkRow.id);
    assert.equal(store.getWatermark(SCOPE), 10, '低值回填行不影响主水位');

    const done = await runBackfillCompaction(
      state,
      { agent: { id: 'agent-main', session: { id: 'session-h1b' } } },
      SCOPE,
      pending,
    );
    assert.equal(done, true);
    assert.equal(compactCalls.length, 1);
    assert.equal(compactCalls[0].start, 2);
    assert.equal(compactCalls[0].end, 5);
    assert.equal(compactCalls[0].agent?.id, 'agent-main', 'payload.agent 原样透传');
    assert.equal(store.getMeta(CURSOR_KEY), '6', '游标指向区间后第一条未压缩记录');
    assert.equal(store.getMeta(FLOOR_KEY), '4800', '压后实测 tokens');
    assert.equal(Number(JSON.parse(store.getMeta(DAY_META_KEY)).count), 1);
    assert.equal(pendingBackfillOf(state, SCOPE), null, 'pending 收尾清空');
    assert.equal(store.getMeta(ANCHOR_KEY), null, 'E 下回填路径不写水位锚');
    assert.equal(initialWatermark(store, SCOPE), 10);

    store.close();
    const reopened = Store.open(dbPath);
    try {
      assert.equal(initialWatermark(reopened, SCOPE), 10, '重开 Store 主水位不变');
      assert.equal(reopened.getWatermark(SCOPE), 10, '低值回填行永远不会成为可见水位');
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ② 水位语义对照：forget_flush 被排除，nap 参与（E 的构造性依据）
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：forget_flush 行不参与水位，nap 行参与（构造性对照）', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-b-' });
  try {
    seedConsolidation(store, 10, TEST_NOW / 1000, 'compacted');
    const flushRow = store.insertConsolidation({
      scope: SCOPE,
      session_id: 'session-h1b',
      kind: 'forget_flush',
      trigger: 'backfill',
      upto_seq: 5,
      status: 'written',
      started_at: TEST_NOW / 1000 + 4,
      finished_at: TEST_NOW / 1000 + 4,
    });
    assert.ok(flushRow?.id);
    assert.equal(store.getWatermark(SCOPE), 10, '低值 forget_flush 行被 getWatermark 排除');

    // 对照：同值的 nap 行确实会被「最新行赢」选中——这正是 E 必须换 kind 的原因。
    seedConsolidation(store, 5, TEST_NOW / 1000 + 5);
    assert.equal(store.getWatermark(SCOPE), 5, 'nap 低值行确实会带偏水位（对照）');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ③ 空批：region 里没有用户/助手正文，巩固仍写 empty 行并被抬回水位
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：空批（只有工具行）也落 forget_flush 行、游标照推、水位不变', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-c-' });
  try {
    seedConsolidation(store, 10, TEST_NOW / 1000, 'compacted');
    // 全部是 tool 行 → hasConsolidatableText=false → consolidate 记 status='empty'
    const snapshot = makeSnapshot(
      [1, 2, 3, 4, 5, 6].map((seq) => ({ seq, role: 'tool', text: '[tool result]', tokens: 300 })),
    );
    const { state, llmCalls } = makeState({ store, snapshot, watermark: 10 });
    const pending = {
      chunk: { startIdx: 1, endIdx: 4, startSeq: 2, endSeq: 5, tokens: 1200, count: 4 },
      stage: 'consolidating',
      consolidationId: null,
      nextSeq: 6,
      atWatermark: false,
      snapshot,
      transcript: [],
    };
    await runBackfillJob(state, SCOPE, pending);

    assert.equal(llmCalls.length, 0, '空批不调模型');
    assert.equal(pending.stage, 'ready', '空批同样推进到 ready');
    const row = store.db.prepare(
      "SELECT * FROM consolidations WHERE scope = ? AND kind = 'forget_flush' AND trigger = 'backfill' ORDER BY started_at DESC LIMIT 1",
    ).get(SCOPE);
    assert.ok(row, '空批同样写 forget_flush 行');
    assert.equal(row.status, 'empty');
    assert.equal(row.upto_seq, 5, '空批行保留本批 endSeq');
    assert.equal(store.getMeta(PENDING_KEY) !== null, true, 'pending 落库供下一窗口压缩');
    assert.equal(store.getWatermark(SCOPE), 10, '主水位不变');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ④ 跨批游标：两窗口连续执行，不出现 stale-cursor 死锁
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：跨批游标连续推进，第二个窗口不 stale-cursor', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-d-' });
  try {
    seedConsolidation(store, 6, TEST_NOW / 1000);
    const first = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state, compactCalls, logs, setSnapshot } = makeState({
      store,
      snapshot: first,
      watermark: 6,
    });

    // 窗口 1：只选区 + 登记（纯函数部分）
    await maybeBackfill(state, PAYLOAD, SCOPE);
    const pending1 = pendingBackfillOf(state, SCOPE);
    assert.ok(pending1, '窗口 1 登记了 pending');
    assert.deepEqual(pending1.chunk.startSeq, 1);
    assert.deepEqual(pending1.chunk.endSeq, 2);
    assert.equal(pending1.nextSeq, 3, '游标用区间后第一条记录');

    // 巩固完成（替身直接置 ready）
    pending1.stage = 'ready';

    // 窗口 2：压缩
    await maybeBackfill(state, PAYLOAD, SCOPE);
    assert.equal(compactCalls.length, 1);
    assert.equal(compactCalls[0].start, 1);
    assert.equal(compactCalls[0].end, 2);
    assert.equal(compactCalls[0].agent, PAYLOAD.agent, '把 payload.agent 原样交给宿主');
    assert.equal(store.getMeta(CURSOR_KEY), '3');

    // 窗口 3：宿主压缩把 1..2 换成末尾追加的摘要节点
    const second = makeSnapshot([
      { seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }, { seq: 99, role: 'user', text: '<compacted-summary>' },
    ]);
    setSnapshot(second);
    await maybeBackfill(state, PAYLOAD, SCOPE);
    const pending3 = pendingBackfillOf(state, SCOPE);
    assert.ok(pending3, '窗口 3 从游标继续选区');
    assert.equal(pending3.chunk.startSeq, 4, '游标之后的下一批');
    assert.equal(
      logs.some((entry) => entry.message.includes('cursor is stale')),
      false,
      '不该触发 stale-cursor 兜底',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ⑤ 日闸门 / ⑥ enabled=false 短路 / ⑦ 只选水位前
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：日闸门达上限后不再选区，也不压水位前之外的区间', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-e-' });
  try {
    seedConsolidation(store, 6, TEST_NOW / 1000);
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state, logs, compactCalls, llmCalls } = makeState({
      store,
      snapshot,
      watermark: 6,
    });
    store.setMeta(DAY_META_KEY, JSON.stringify({ date: DAY_KEY, count: 6 }));
    await maybeBackfill(state, PAYLOAD, SCOPE);
    assert.equal(pendingBackfillOf(state, SCOPE), null, '达上限不登记');
    assert.equal(store.getMeta(CURSOR_KEY), null);
    assert.equal(compactCalls.length, 0);
    assert.equal(llmCalls.length, 0);
    assert.ok(logs.some((entry) => entry.message.includes('daily cap')), '记 daily cap');

    // 对照：未达上限时只选水位之前的区间
    store.setMeta(DAY_META_KEY, JSON.stringify({ date: DAY_KEY, count: 0 }));
    await maybeBackfill(state, PAYLOAD, SCOPE);
    const pending = pendingBackfillOf(state, SCOPE);
    assert.ok(pending);
    const watermarkIdx = snapshot.seqs.indexOf(6);
    assert.ok(snapshot.seqs.indexOf(pending.chunk.endSeq) < watermarkIdx, '区间严格在水位之前');
  } finally {
    cleanup();
  }
});

test('H1-B 非真机证据：enabled=false 时零 meta / 零后台 / 零模型', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-f-' });
  try {
    seedConsolidation(store, 6, TEST_NOW / 1000);
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const config = normalizeConfig({ compact: { backfill: { enabled: false } } });
    const { state, llmCalls, compactCalls, metaWrites } = makeState({
      store,
      snapshot,
      watermark: 6,
      config,
    });
    await maybeBackfill(state, PAYLOAD, SCOPE);
    assert.equal(pendingBackfillOf(state, SCOPE), null);
    assert.equal(llmCalls.length, 0);
    assert.equal(compactCalls.length, 0);
    assert.equal(
      metaWrites.some((entry) => entry.key.startsWith('compact_backfill:')),
      false,
      'enabled=false 不写任何回填 meta',
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ⑩ 重启恢复：回填行 kind=forget_flush，不被 recoverPendingCompacts 复活
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：重启后回填行不复活成 pending，正常 nap pending 原样', async (t) => {
  const { store, dbPath, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-r-' });
  try {
    const napRow = seedConsolidation(store, 12, TEST_NOW / 1000);
    store.db.prepare('UPDATE consolidations SET compaction_start_seq = ? WHERE id = ?').run(9, napRow.id);
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state } = makeState({ store, snapshot, watermark: 12 });
    const pending = {
      chunk: { startIdx: 1, endIdx: 4, startSeq: 2, endSeq: 5, tokens: 1200, count: 4 },
      stage: 'consolidating',
      consolidationId: null,
      nextSeq: 6,
      atWatermark: false,
      snapshot,
      transcript: [],
    };
    await runBackfillJob(state, SCOPE, pending);
    assert.equal(pending.stage, 'ready');

    store.close();
    const reopened = Store.open(dbPath);
    try {
      const recovered = recoverPendingCompacts(reopened);
      const entry = recovered.get(SCOPE);
      assert.ok(entry, '只从 nap 行恢复正常 pending');
      assert.equal(entry.id, napRow.id, '恢复的是正常 nap pending，不是回填行');
      assert.equal(entry.startSeq, 9);
      assert.equal(entry.endSeq, 12);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});
// ---------------------------------------------------------------------------
// ⑪ 崩溃窗重放：同块已成功巩固过 → UNIQUE 被捕获 → 不重跑模型，直接进压缩相
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：崩溃窗重放同块时捕获 UNIQUE，不再调模型、直接进入压缩相', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-u-' });
  try {
    seedConsolidation(store, 10, TEST_NOW / 1000, 'compacted');
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state, llmCalls, logs } = makeState({ store, snapshot, watermark: 10 });
    const makePending = () => ({
      chunk: { startIdx: 1, endIdx: 4, startSeq: 2, endSeq: 5, tokens: 1200, count: 4 },
      stage: 'consolidating',
      consolidationId: null,
      nextSeq: 6,
      atWatermark: false,
      snapshot,
      transcript: [],
    });

    const first = makePending();
    await runBackfillJob(state, SCOPE, first);
    assert.equal(first.stage, 'ready');
    const row = store.db.prepare("SELECT * FROM consolidations WHERE scope = ? AND kind = 'forget_flush' ORDER BY started_at DESC LIMIT 1").get(SCOPE);
    // 替身模型返回空草稿时 consolidate 记 empty（同键会被就地复用，不撞 UNIQUE）；
    // 这里把行标成 written，构造「成功批 + pending meta 丢失」的崩溃窗。
    store.db.prepare("UPDATE consolidations SET status = 'written' WHERE id = ?").run(row.id);
    const callsAfterFirst = llmCalls.length;

    // 模拟崩溃窗：pending meta 丢失、库里的巩固行还在 → 同块重选必然撞 UNIQUE。
    store.deleteMeta(PENDING_KEY);
    state.pendingBackfillByScope = new Map();
    const replay = makePending();
    await runBackfillJob(state, SCOPE, replay);
    assert.equal(replay.stage, 'ready', '重放按已巩固处理，直接进压缩相');
    assert.equal(llmCalls.length, callsAfterFirst, '重放不再调模型');
    assert.ok(logs.some((entry) => entry.message.includes('already consolidated')), '记下崩溃窗重放');
    assert.equal(store.getMeta(PENDING_KEY) !== null, true, '重放把 pending 重新落库等下一窗口压缩');
  } finally {
    cleanup();
  }
});
// ---------------------------------------------------------------------------
// ⑫ 周报口径：回填行（kind=forget_flush）不进 written/empty 统计
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：周报本周巩固数字不含回填行（只数 nap/deep）', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-wr-' });
  try {
    const within = Math.floor(TEST_NOW / 1000) - 60;
    seedConsolidation(store, 8, within, 'written');
    store.insertConsolidation({
      scope: SCOPE,
      session_id: 'session-h1b',
      kind: 'forget_flush',
      trigger: 'backfill',
      upto_seq: 5,
      status: 'written',
      started_at: within + 1,
      finished_at: within + 1,
    });
    const report = buildWeeklyMemoryReport({ store, scope: SCOPE, now: TEST_NOW });
    assert.match(report.text, /本周巩固：written=1 · empty=0 · failed=0/u, '回填行不计入周报');
  } finally {
    cleanup();
  }
});
// ---------------------------------------------------------------------------
// ⑬ 游标取「本批之后第一条」而不是 plan.nextCursorSeq（多批选区时两者不同）
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：多批选区时 nextSeq 取 chunk 之后的记录，不是 plan.nextCursorSeq', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-cur-' });
  try {
    seedConsolidation(store, 2, Math.floor(TEST_NOW / 1000) - 60, 'compacted');
    const specs = [];
    for (let seq = 1; seq <= 10; seq += 1) specs.push({ seq, role: 'user', tokens: 800 });
    const { state } = makeState({
      store,
      snapshot: makeSnapshot(specs),
      config: { compact: { backfill: { enabled: true, chunkTokens: 1600, maxPerDay: 6 } } },
      watermark: 6,
    });
    await maybeBackfill(state, PAYLOAD);
    const pending = pendingBackfillOf(state, SCOPE);
    await settle();
    assert.ok(pending, '应有 pendingBackfill');
    const plan = planBackfillChunks(state.surfaceSnapshot, {
      watermarkSeq: 6,
      chunkTokens: 1600,
    });
    assert.ok(plan.chunks.length >= 2, `选区应切成多批，实际 ${plan.chunks.length}`);
    assert.notEqual(plan.nextCursorSeq, pending.nextSeq, '两者在多批时必须不同');
    const afterChunk = state.surfaceSnapshot.seqs[pending.chunk.endIdx + 1];
    assert.equal(pending.nextSeq, afterChunk, 'nextSeq 取本批之后的记录 seq');
  } finally {
    cleanup();
  }
});
// ---------------------------------------------------------------------------
// ⑧ H1-A 接口对接 + 正常 pending 不受影响
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：选区形状可被 H1-A 估算消费，且不动正常 pending', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-g-' });
  try {
    seedConsolidation(store, 6, TEST_NOW / 1000);
    const snapshot = makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({ seq })));
    const { state, setSnapshot } = makeState({ store, snapshot, watermark: 6 });

    // 正常（非回填）pending 必须原样保留
    state.pendingCompact = new Map([[SCOPE, { id: null, startSeq: 7, endSeq: 8, scope: SCOPE }]]);
    const before = state.pendingCompact.get(SCOPE);

    await maybeBackfill(state, PAYLOAD, SCOPE);
    const pending = pendingBackfillOf(state, SCOPE);
    assert.ok(pending);
    const plan = planBackfillChunks(snapshot, {
      watermarkSeq: 6,
      cursorSeq: null,
      chunkTokens: 1200,
    });
    assert.deepEqual(
      { startIdx: pending.chunk.startIdx, endIdx: pending.chunk.endIdx },
      { startIdx: plan.chunks[0].startIdx, endIdx: plan.chunks[0].endIdx },
    );
    assert.equal(typeof pending.chunk.startSeq, 'number');
    assert.equal(typeof pending.chunk.tokens, 'number');
    assert.ok(pending.chunk.count > 0);
    assert.notEqual(
      pending.nextSeq,
      plan.nextCursorSeq,
      'pending 游标用区间后第一条记录（≠ plan 的 endSeq）',
    );
    const estimate = estimateBackfill({ snapshot, plan });
    assert.ok(estimate.reclaimableTokens > 0);
    assert.ok(estimate.floorUpperBound >= estimate.reclaimableTokens);
    assert.equal(estimate.modelCalls.total, estimate.chunks * 2);

    assert.deepEqual(state.pendingCompact.get(SCOPE), before, '回填不碰正常 pending');
    setSnapshot(snapshot);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// ⑨ 生产接线：runPreStep 真的调了 maybeBackfill（删挂载行必红）
// ---------------------------------------------------------------------------

test('H1-B 非真机证据：pre-step 生产接线会登记回填 pending（删挂载行必红）', async () => {
  // 这里不用 makeTempStore：apply 之后插件仍持有 DB 连接，Windows 上删目录会 EPERM。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0717-h1b-wire-'));
  const dbPath = join(dir, 'companion.db');
  try {
    const seed = Store.open(dbPath);
    seedConsolidation(seed, 6, TEST_NOW / 1000, 'compacted');
    seed.close();
    const ctx = new FakeCtx({ now: TEST_NOW });
    ctx.commands = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
    ctx.tools = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
    const session = ctx.addSession({
      id: 'session-h1b',
      events: [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => ({
        seq,
        type: 'user/message',
        data: { role: 'user', content: [{ type: 'text', text: `第 ${seq} 句关于青柠计划的讨论` }] },
      })),
    });
    applyCordis(strictCtx(ctx), {
      dbPath,
      compact: { backfill: { enabled: true, chunkTokens: 1200, maxPerDay: 6 } },
    });
    await ctx.dispatch('agent/pre-step', {
      agent: { id: session.id, session },
      messages: [{ role: 'user', content: [{ type: 'text', text: '继续聊青柠计划' }] }],
      turn: 1,
      step: 1,
    }, {});
    await settle();

    // 无模型的宿主里，后台 job 会立刻把 pending 清掉；接线证据取日志（删挂载行即消失）。
    const scheduled = ctx.logs.filter((entry) => entry.message.includes('backfill chunk scheduled'));
    assert.equal(scheduled.length, 1, 'pre-step 生产接线登记了回填 pending');
    assert.equal(scheduled.length, 1);

    const check = Store.open(dbPath);
    try {
      assert.equal(check.getWatermark(SCOPE), 6, '回填不改主水位');
    } finally {
      check.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 插件仍持连接时留下临时目录 */ }
  }
});

// ---------------------------------------------------------------------------
// M1（v0.7.17 复核）：恢复态 pending 不得永久死锁
// ---------------------------------------------------------------------------

/**
 * 持久化一条「恢复形」pending（模拟崩溃/重部署：meta 有 chunk，内存无快照）。
 * @param {object} store
 * @param {object} chunk
 * @param {string} [stage]
 * @returns {void}
 */
function seedRecoveredPending(store, chunk, stage = 'consolidating') {
  store.setMeta(`compact_backfill:pending:${SCOPE}`, JSON.stringify({
    chunk,
    stage,
    consolidationId: null,
    nextSeq: chunk.endSeq + 1,
    atWatermark: false,
  }));
}

test('H1-B 非真机证据（M1）：恢复态且已写行 → 重拉只转 ready，不重复调模型', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-rec1-' });
  try {
    seedConsolidation(store, 6, Math.floor(TEST_NOW / 1000) - 60, 'compacted');
    const specs = [];
    for (let seq = 1; seq <= 10; seq += 1) specs.push({ seq, role: 'user', tokens: 800 });
    const { state, llmCalls, logs } = makeState({ store, snapshot: makeSnapshot(specs), watermark: 6 });
    seedRecoveredPending(store, {
      startIdx: 0,
      endIdx: 1,
      startSeq: 1,
      endSeq: 2,
      tokens: 1600,
      count: 2,
    });
    // 上一轮巩固已成功落行（崩溃发生在压缩前）。
    store.insertConsolidation({
      scope: SCOPE,
      session_id: SCOPE,
      kind: 'forget_flush',
      trigger: 'backfill',
      upto_seq: 2,
      status: 'written',
      started_at: Math.floor(TEST_NOW / 1000) - 30,
      finished_at: Math.floor(TEST_NOW / 1000) - 30,
    });
    // 恢复后内存缓存必须为空，才会走 meta 恢复路径。
    state.pendingBackfillByScope = new Map();
    await maybeBackfill(state, PAYLOAD);
    await settle();
    assert.equal(llmCalls.length, 0, '已写行不得再调模型');
    const pending = pendingBackfillOf(state, SCOPE);
    assert.equal(pending?.stage, 'ready', '重拉后应进入 ready 等待压缩');
    assert.ok(
      logs.some((row) => String(row.message).includes('already consolidated')),
      '应记录「已巩固」日志',
    );
  } finally {
    cleanup();
  }
});

test('H1-B 非真机证据（M1）：恢复态但未写行 → 用当前 surface 重建正文并重新巩固', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-rec2-' });
  try {
    seedConsolidation(store, 6, Math.floor(TEST_NOW / 1000) - 60, 'compacted');
    const specs = [];
    for (let seq = 1; seq <= 10; seq += 1) specs.push({ seq, role: 'user', tokens: 800, text: `第 ${seq} 句正文` });
    const { state, llmCalls, logs } = makeState({
      store,
      snapshot: makeSnapshot(specs),
      watermark: 6,
      // 非空草稿：避免 C120-M3 的重问干扰「恰好重跑一次」的计数。
      llmResponse: () => ({
        episode: null,
        facts: [{
          statement: '回填期间提取的事实',
          subject_text: '历史回填',
          predicate: '提取出',
          object_text: '一条事实',
          kind: 'knowledge',
        }],
        reminders: [],
      }),
    });
    seedRecoveredPending(store, {
      startIdx: 0,
      endIdx: 1,
      startSeq: 1,
      endSeq: 2,
      tokens: 1600,
      count: 2,
    });
    state.pendingBackfillByScope = new Map();
    await maybeBackfill(state, PAYLOAD);
    await settle();
    assert.equal(llmCalls.length, 1, `未写行应重跑一次巩固：${JSON.stringify(llmCalls.map((c) => ({ f: c.seqFrom, t: c.seqTo, len: String(c.regionText ?? '').length })))}`);
    assert.match(String(llmCalls[0]?.regionText ?? ''), /user: 第 1 句正文/u, '注入的快照必须真的切出正文');
    const pending = pendingBackfillOf(state, SCOPE);
    assert.equal(pending?.stage, 'ready', `重新巩固后应进入 ready；logs=${JSON.stringify(logs)}`);
  } finally {
    cleanup();
  }
});

test('H1-B 非真机证据（M1）：恢复态且位置漂移 → 丢弃本批 + 清游标重扫，不死锁', async (t) => {
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0717-h1b-rec3-' });
  try {
    seedConsolidation(store, 6, Math.floor(TEST_NOW / 1000) - 60, 'compacted');
    const specs = [];
    for (let seq = 1; seq <= 10; seq += 1) specs.push({ seq, role: 'user', tokens: 800 });
    const { state, logs } = makeState({ store, snapshot: makeSnapshot(specs), watermark: 6 });
    // 漂移：记录里的 endSeq 在新 surface 的 endIdx 位置上并不存在。
    seedRecoveredPending(store, {
      startIdx: 0,
      endIdx: 1,
      startSeq: 1,
      endSeq: 99,
      tokens: 1600,
      count: 2,
    });
    store.setMeta(`compact_backfill:cursor:${SCOPE}`, '3');
    state.pendingBackfillByScope = new Map();
    await maybeBackfill(state, PAYLOAD);
    await settle();
    assert.equal(store.getMeta(`compact_backfill:pending:${SCOPE}`), null, '漂移的 pending 应被丢弃');
    assert.equal(store.getMeta(`compact_backfill:cursor:${SCOPE}`), null, '游标应被清掉以便重扫');
    assert.ok(
      logs.some((row) => String(row.message).includes('drifted')),
      '应记录位置漂移 warn',
    );
    // 下一窗口必须能重新选批（否则就是死锁）。
    await maybeBackfill(state, PAYLOAD);
    const pending = pendingBackfillOf(state, SCOPE);
    assert.ok(pending !== null, '重扫后应能重新登记一批');
    assert.notEqual(pending.chunk.endSeq, 99, '新批次必须来自当前 surface');
  } finally {
    cleanup();
  }
});
