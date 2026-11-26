/**
 * 判别力（删接线必红）：L4-001 只走真实两阶段入口 —— 窗口 1 `maybeBackfill` 真正选区，
 * 把 `selectedAtMs` 写进 `schema_meta:compact_backfill:pending:<scope>`；后台巩固落
 * `ready` 后清空内存缓存，强制从 meta 恢复；窗口 2 再 `maybeBackfill` 压缩，时钟在
 * 「选区 → 下一窗口」后推进 100ms、`compactRegion` 内部再推进 150ms（合计 250），
 * 断言生产 `backfill chunk compacted` 日志 `detail.duration_ms === 250`。
 * 删掉选区处的 `selectedAtMs`、`pendingBackfillOf` / `persistPendingBackfill` 的保留
 * 或日志字段任一处，L4-001 立即红（字段缺失或只剩压缩自身的 150）。
 * 若实现改成只测 `compactRegion` 自身耗时，L4-001 也会红（150≠250）。
 *
 * v0.7.21 L4：回填压缩日志记录「上一窗口选区 → 本窗口压缩完成」的端到端耗时
 * （用户字面要求键名 `duration_ms`，零 DDL，旧 pending 无该字段则整条省略）。
 *
 * ⚠️ 非真机证据：宿主 `compactRegion`、surface 快照、时钟、模型全部是替身；真机宿主
 * 两窗口之间的真实间隔与压缩耗时无法在本机验证。本文件只锁生产代码里的时间口径与
 * pending 字段的落库/恢复链路。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { maybeBackfill, pendingBackfillOf } from '../src/index.js';
import { normalizeConfig } from '../src/config.js';
import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const SCOPE = 'main';
const PENDING_KEY = `compact_backfill:pending:${SCOPE}`;
// refreshSurface 需要 payload.agent.session（宿主 pre-step 的真实形状）。
const PAYLOAD = { agent: { id: 'agent-main', session: { id: 'session-l4' } } };

/**
 * 造一个可控时钟（毫秒）。`platform.now()` 是唯一时间来源，测试里显式推进。
 * @param {number} start
 * @returns {{now: () => number, advance: (ms: number) => void, set: (ms: number) => void}}
 */
function makeClock(start) {
  let ms = start;
  return {
    now: () => ms,
    advance(delta) {
      ms += delta;
    },
    set(value) {
      ms = value;
    },
  };
}

/**
 * 造一个 surface 快照（seqs / nodes / records 三件套与 surface.js 对齐）。
 * @param {number[]} seqs
 * @returns {object}
 */
function makeSnapshot(seqs) {
  return {
    seqs: seqs.map(Number),
    nodes: seqs.map((seq) => ({ seq: Number(seq), tokens: 600, heuristicTokens: 600 })),
    records: seqs.map((seq) => ({
      seq: Number(seq),
      role: 'user',
      text: `第 ${seq} 句关于青柠计划的讨论`,
      tokens: 600,
      toolDelta: 0,
      sourceKind: null,
      missing: false,
    })),
    missing: 0,
    incomplete: false,
  };
}

/**
 * 造一个最小可用 wiring state（只实现回填两阶段与 refreshSurface 用到的字段）。
 * @param {object} options
 * @returns {{state: object, logs: object[], compactCalls: object[]}}
 */
function makeState(options) {
  const { store, snapshot, watermark, clock } = options;
  const logs = [];
  const compactCalls = [];
  let current = snapshot;
  const state = {
    store,
    platform: {
      now: () => clock.now(),
      log: (level, message, detail) => logs.push({ level, message, detail }),
      capabilities: { compaction: true },
      compactRegion: async (start, end, agent) => {
        compactCalls.push({ start, end, agent, at: clock.now() });
        // 压缩调用本身耗时（默认 0，L4-001 传 150）。
        clock.advance(Number(options.compactAdvance) || 0);
      },
    },
    config: normalizeConfig({
      compact: { backfill: { enabled: true, chunkTokens: 1200, maxPerDay: 6 } },
    }),
    metrics: { inc: () => {}, observe: () => {} },
    surface: { snapshot: async () => current },
    surfaceSnapshot: current,
    surfaceSnapshotByScope: new Map([[SCOPE, current]]),
    prevSurfaceSeqsByScope: new Map(),
    currentScope: SCOPE,
    watermarkByScope: new Map([[SCOPE, watermark]]),
    pendingBackfillByScope: new Map(),
    pendingCompact: new Map(),
    compactedThisTurn: false,
    transcript: [],
    disposed: false,
    // 空草稿 → 巩固写 empty 行后推进 ready，不依赖真实模型。
    companion: {
      consolidationLlm: async () => ({ episode: null, facts: [], reminders: [] }),
    },
  };
  return { state, logs, compactCalls };
}

/**
 * 预置一行已成功巩固的记录（决定 store.getWatermark）。
 * @param {object} store
 * @param {number} uptoSeq
 * @returns {object}
 */
function seedConsolidation(store, uptoSeq) {
  return store.insertConsolidation({
    scope: SCOPE,
    session_id: 'session-l4',
    kind: 'nap',
    trigger: 'threshold',
    upto_seq: uptoSeq,
    status: 'compacted',
    started_at: Math.floor(TEST_NOW / 1000),
    finished_at: Math.floor(TEST_NOW / 1000),
  });
}

/**
 * 直接落一条旧版（v0.7.20 及以前）形状的 pending：没有 `selectedAtMs`。
 * @param {object} store
 * @param {object} chunk
 * @param {object} [extra] 允许覆盖/追加字段（例如 `selectedAtMs: null`）
 * @returns {void}
 */
function seedLegacyPending(store, chunk, extra = {}) {
  store.setMeta(PENDING_KEY, JSON.stringify({
    chunk,
    stage: 'ready',
    consolidationId: null,
    nextSeq: chunk.endSeq + 1,
    atWatermark: false,
    ...extra,
  }));
}

/**
 * 取本用例里唯一一条生产 `backfill chunk compacted` 日志。
 * @param {object[]} logs
 * @returns {{level: string, message: string, detail: object}}
 */
function compactedLog(logs) {
  const rows = logs.filter(
    (entry) => entry.level === 'info' && String(entry.message).includes('backfill chunk compacted'),
  );
  assert.equal(rows.length, 1, `应恰好一条 backfill chunk compacted 日志：${rows.length}`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// L4-001 真实两阶段：选区 → 后台巩固 → 下一窗口压缩，duration_ms 覆盖整段
// ---------------------------------------------------------------------------

test('L4-001（v0.7.21 非真机证据）：选区→压缩完成跨窗口 250ms，日志 duration_ms===250', async (t) => {
  // 判别力：删选区处的 `selectedAtMs: platform.now()` → meta 无该字段 → 日志省略
  // duration_ms，本用例红；删 pendingBackfillOf/persistPendingBackfill 的保留 → 从
  // meta 恢复后字段丢失，本用例红；日志字段删除或改测 compactRegion 自身耗时（只剩
  // 150）→ 本用例红。
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0721-l4-a-' });
  try {
    seedConsolidation(store, 6);
    const clock = makeClock(TEST_NOW);
    const { state, logs, compactCalls } = makeState({
      store,
      snapshot: makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]),
      watermark: 6,
      clock,
      compactAdvance: 150,
    });

    // —— 阶段 1：真实选区（maybeBackfill 的纯函数部分）——
    await maybeBackfill(state, PAYLOAD, SCOPE);
    const selected = pendingBackfillOf(state, SCOPE);
    assert.ok(selected, '窗口 1 登记了 pending');
    assert.equal(selected.selectedAtMs, TEST_NOW, '选区时刻就是 selectedAtMs');
    assert.equal(
      JSON.parse(store.getMeta(PENDING_KEY)).selectedAtMs,
      TEST_NOW,
      'selectedAtMs 随 pending 写入 schema_meta（现有 JSON 可选字段）',
    );

    // 后台巩固真的把 pending 推进到 ready 并重写 meta（此时时钟还没动）。
    await settle();
    // 强制走 meta 恢复路径：内存缓存清空，证明字段确实持久化了。
    state.pendingBackfillByScope = new Map();
    const ready = pendingBackfillOf(state, SCOPE);
    assert.ok(ready, '恢复出 pending');
    assert.equal(ready.stage, 'ready', '后台巩固已完成');
    assert.equal(ready.selectedAtMs, TEST_NOW, '从 meta 恢复保留 selectedAtMs');
    assert.equal(
      JSON.parse(store.getMeta(PENDING_KEY)).selectedAtMs,
      TEST_NOW,
      '巩固完成重写 pending 后 selectedAtMs 仍在',
    );

    // —— 阶段 2：下一窗口压缩；跨窗口间隔 100ms + 压缩本身 150ms = 250ms ——
    clock.advance(100);
    await maybeBackfill(state, PAYLOAD, SCOPE);
    assert.equal(compactCalls.length, 1, '只压一次');
    const entry = compactedLog(logs);
    assert.equal(entry.detail.duration_ms, 250, '口径是「选区 → 压缩完成」的 250ms，不是压缩自身 150ms');
    assert.equal(entry.detail.durationMs, undefined, '用户字面要求 duration_ms，不是 durationMs');
    assert.equal(entry.detail.scope, SCOPE);
    assert.equal(pendingBackfillOf(state, SCOPE), null, '成功后 pending 正常收尾');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// L4-002 旧 pending 兼容：没有 selectedAtMs 时日志整条省略，不伪造 0
// ---------------------------------------------------------------------------

test('L4-002（v0.7.21 非真机证据）：旧 pending 无 selectedAtMs，压缩日志不含 duration_ms', async (t) => {
  // 判别力：把「无字段」当成 0（例如 `Number(parsed?.selectedAtMs) || 0` 或直接透传 0）
  // → 日志会出现 duration_ms，本用例红；反之正确实现整条省略。
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0721-l4-b-' });
  try {
    seedConsolidation(store, 6);
    const clock = makeClock(TEST_NOW);
    seedLegacyPending(store, {
      startIdx: 0, endIdx: 1, startSeq: 1, endSeq: 2, tokens: 1200, count: 2,
    });
    const { state, logs, compactCalls } = makeState({
      store,
      snapshot: makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]),
      watermark: 6,
      clock,
    });
    clock.advance(250);

    await maybeBackfill(state, PAYLOAD, SCOPE);
    assert.equal(compactCalls.length, 1, '旧 pending 照常压缩');
    const entry = compactedLog(logs);
    assert.equal(
      Object.hasOwn(entry.detail, 'duration_ms'),
      false,
      '旧 pending 没有选区时刻 → 完全省略 duration_ms，不伪造 0',
    );
    assert.equal(entry.detail.durationMs, undefined, '也不该换名写 durationMs');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// L4-003 时钟回拨：duration_ms 夹到 0，不出现负数
// ---------------------------------------------------------------------------

test('L4-003（v0.7.21 非真机证据）：时钟回拨时 duration_ms 夹到 0', async (t) => {
  // 判别力：去掉 Math.max(0, …) → 本用例得到负数，红。
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0721-l4-c-' });
  try {
    seedConsolidation(store, 6);
    const clock = makeClock(TEST_NOW);
    const { state, logs } = makeState({
      store,
      snapshot: makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]),
      watermark: 6,
      clock,
    });

    await maybeBackfill(state, PAYLOAD, SCOPE);
    await settle();
    state.pendingBackfillByScope = new Map();
    // 宿主时钟回拨 1s：选区时刻「晚于」压缩完成时刻。
    clock.set(TEST_NOW - 1000);
    await maybeBackfill(state, PAYLOAD, SCOPE);

    const entry = compactedLog(logs);
    assert.equal(entry.detail.duration_ms, 0, '回拨夹到 0，不写负数');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// L4-004 坏值不冒充时刻：meta 里 selectedAtMs: null 不得被转成 0
// ---------------------------------------------------------------------------

test('L4-004（v0.7.21 非真机证据）：pending 的 selectedAtMs 为 null 时不当作 0', async (t) => {
  // 判别力：用 `Number(parsed?.selectedAtMs)` 判定会把 null 变成 0 → 恢复出
  // selectedAtMs=0 → 日志 duration_ms≈TEST_NOW，本用例红。Number.isFinite 才是对的。
  const { store, cleanup } = makeTempStore({ t, prefix: 'dsh-v0721-l4-d-' });
  try {
    seedConsolidation(store, 6);
    const clock = makeClock(TEST_NOW);
    seedLegacyPending(
      store,
      { startIdx: 0, endIdx: 1, startSeq: 1, endSeq: 2, tokens: 1200, count: 2 },
      { selectedAtMs: null },
    );
    const { state, logs } = makeState({
      store,
      snapshot: makeSnapshot([1, 2, 3, 4, 5, 6, 7, 8]),
      watermark: 6,
      clock,
    });

    const pending = pendingBackfillOf(state, SCOPE);
    assert.ok(pending, 'pending 仍能恢复');
    assert.equal(pending.selectedAtMs, undefined, 'null 不得被保留成 0/null 时刻');
    assert.equal(
      Object.hasOwn(JSON.parse(store.getMeta(PENDING_KEY)), 'selectedAtMs'),
      true,
      '（前置）meta 里确实是 null 而不是缺字段',
    );

    await maybeBackfill(state, PAYLOAD, SCOPE);
    const entry = compactedLog(logs);
    assert.equal(
      Object.hasOwn(entry.detail, 'duration_ms'),
      false,
      'null 时刻同样整条省略，绝不按 0 算成天量耗时',
    );
  } finally {
    cleanup();
  }
});
