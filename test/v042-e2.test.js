/**
 * v0.4.2 E2-M1 + L2-3：回填独立超时、推理单飞、查询回退 FTS、加载单飞。
 *
 * 全部使用注入的 fake loader（不联网、不依赖可选包），直击 review-code-v0.4.1
 * 里的四个失败模式：
 *   1. 50 条 bge-small int8 在查询的 300ms 超时下必然失败 → 回填改走
 *      backfillTimeoutMs（默认 30s）；
 *   2. Promise.race 超时后底层推理仍在跑，下一次 idle-probe 再叠加 → 单飞；
 *   3. 查询撞上回填占用时排队会把 turn 拖死 → 直接回退 FTS；
 *   4. loadTimeoutMs 后重试并行起第二个加载 → 加载 promise 单飞。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { backfillVectors } from '../src/index.js';
import { retrieve } from '../src/memory/retrieve.js';
import {
  EmbeddingTimeout,
  createEmbedder,
} from '../src/memory/embedders/index.js';
import { createLocalEmbedder } from '../src/memory/embedders/local.js';
import { DEFAULTS } from '../src/config.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;
const DIM = 512;
const MODEL = 'Xenova/bge-small-zh-v1.5';

const timers = new Set();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  });
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

/** 每条文本 20ms 的 fake extractor；返回 { module, calls, texts }，便于断言单飞。 */
function slowModule({ msPerText = 20, gate = null } = {}) {
  const calls = [];
  const perText = typeof msPerText === 'function' ? msPerText : () => msPerText;
  return {
    calls,
    module: {
      pipeline: async () => async (batch) => {
        calls.push(batch.length);
        if (gate !== null) await gate;
        await delay(batch.length * perText());
        return batch.map(() => new Array(DIM).fill(0.25));
      },
    },
  };
}

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v042-e2-'));
  const store = Store.open(join(dir, 'companion.db'));
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function addFact(store, n, objectText = `代号${n}`) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: objectText,
    statement: `项目代号是${objectText}`,
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: NOW_SEC - DAY_SEC,
    last_reinforced_at: NOW_SEC - DAY_SEC,
  });
}

function makeState(store, embedder, vector = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    state: {
      store,
      embedder,
      config: { vector: { enabled: true, ...vector } },
      metrics: {
        inc(name, value = 1) {
          calls.push({ name, value });
        },
        snapshot() {
          const out = {};
          for (const call of calls) out[call.name] = (out[call.name] ?? 0) + call.value;
          return out;
        },
      },
      platform: {
        log(level, message, meta) {
          logs.push({ level, message, meta });
        },
      },
      vectorBackfilled: 0,
    },
  };
}

test('E2-M1：config 默认 backfillTimeoutMs=30s、backfillBatchSize=8', () => {
  assert.equal(DEFAULTS.vector.backfillTimeoutMs, 30_000);
  assert.equal(DEFAULTS.vector.backfillBatchSize, 8);
  const embedder = createEmbedder({
    embedder: 'local',
    embedTimeoutMs: 300,
    backfillTimeoutMs: 45_000,
  });
  assert.equal(embedder.timeoutMs, 300);
  assert.equal(embedder.backfillTimeoutMs, 45_000);
  assert.equal(typeof embedder.embedBackfill, 'function');
  assert.equal(embedder.busy(), false);
});

test('E2-M1：fake extractor 每条 20ms，50 条批量在 30s 回填超时下全部写入', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 50; i += 1) addFact(store, i);
    const fake = slowModule({ msPerText: 20 });
    const embedder = createLocalEmbedder({
      model: MODEL,
      timeoutMs: 300,
      backfillTimeoutMs: 30_000,
      loader: async () => fake.module,
    });
    await embedder.warmup();
    assert.equal(embedder.status(), 'ready');
    store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
    const { state, calls, logs } = makeState(store, embedder, { backfillBatchSize: 50 });

    const started = Date.now();
    const written = await backfillVectors(state);
    const elapsed = Date.now() - started;
    assert.equal(written, 50, '50 条应全部写入，而不是被 300ms 查询超时截断');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0], 50);
    assert.ok(elapsed < 30_000, `50 条推理应在回填超时内完成，实际 ${elapsed}ms`);
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM fact_vectors WHERE embedder_id = ?')
      .get(embedder.id);
    assert.equal(rows.n, 50);
    assert.equal(calls.some((call) => call.name === 'vectorBackfillTimeouts'), false);
    assert.equal(logs.length, 0);
  });
});

test('E2-M1：回填超时记 vectorBackfillTimeouts，且底层结束前不再起新批', async () => {
  await withStore(async (store) => {
    addFact(store, 1, '晨星');
    let perText = 150;
    const fake = slowModule({ msPerText: () => perText });
    const embedder = createLocalEmbedder({
      model: MODEL,
      timeoutMs: 300,
      backfillTimeoutMs: 20,
      loader: async () => fake.module,
    });
    await embedder.warmup();
    store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
    const { state, calls } = makeState(store, embedder, { backfillBatchSize: 8 });

    assert.equal(await backfillVectors(state), 0);
    assert.equal(calls.some((call) => call.name === 'vectorBackfillTimeouts'), true);
    assert.equal(fake.calls.length, 1);

    // 超时只截断等待；底层仍在跑 → 下一次 idle-probe 跳过，不叠加第二批。
    assert.equal(embedder.busy(), true);
    assert.equal(await backfillVectors(state), 0);
    assert.equal(fake.calls.length, 1, 'in-flight 未结束前不得起新批');
    assert.equal(calls.some((call) => call.name === 'vectorEmbedBusy'), true);

    // 等到底层真正结束，占用释放后才允许再回填。
    await delay(250);
    assert.equal(embedder.busy(), false);
    perText = 5;
    assert.equal(await backfillVectors(state), 1);
    assert.equal(fake.calls.length, 2);
  });
});

test('E2-M1：连续两次 idle-probe 只有一个推理，第二次记 vectorEmbedBusy', async () => {
  await withStore(async (store) => {
    addFact(store, 1, '晨星');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fake = slowModule({ msPerText: 5, gate });
    const embedder = createLocalEmbedder({
      model: MODEL,
      timeoutMs: 300,
      backfillTimeoutMs: 30_000,
      loader: async () => fake.module,
    });
    await embedder.warmup();
    store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
    const { state, calls } = makeState(store, embedder, { backfillBatchSize: 8 });

    const first = backfillVectors(state);
    await delay(10);
    assert.equal(embedder.busy(), true);
    const second = await backfillVectors(state);
    assert.equal(second, 0);
    release();
    assert.equal(await first, 1);
    assert.equal(fake.calls.length, 1, '两次 idle-probe 只允许一个推理');
    assert.equal(calls.filter((call) => call.name === 'vectorEmbedBusy').length, 1);
  });
});

test('E2-M1：查询在回填占用时直接回退 FTS（不排队、不等待）', async () => {
  await withStore(async (store) => {
    addFact(store, 1, '晨星');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fake = slowModule({ msPerText: 5, gate });
    const embedder = createLocalEmbedder({
      model: MODEL,
      timeoutMs: 300,
      backfillTimeoutMs: 30_000,
      loader: async () => fake.module,
    });
    await embedder.warmup();
    store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
    const { state } = makeState(store, embedder, { backfillBatchSize: 8 });

    const backfill = backfillVectors(state);
    await delay(10);
    assert.equal(embedder.busy(), true);

    const started = Date.now();
    const result = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: { enabled: true, dim: DIM, embedder: 'local' },
      embedder,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 250, `查询不得等待回填推理，实际 ${elapsed}ms`);
    assert.ok(result.vectorError != null);
    assert.equal(result.vectorError.name, 'EmbeddingBusy');
    assert.equal(result.vectorError.code, 'EMBEDDING_BUSY');
    assert.equal(result.vectorError.transient, true);
    assert.ok(result.items.some((item) => item.text.includes('晨星')), 'FTS 结果照常返回');

    release();
    await backfill;
  });
});

test('L2-3：loadTimeoutMs 只放弃等待，重试复用同一加载 promise', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let loads = 0;
  const embedder = createLocalEmbedder({
    model: MODEL,
    timeoutMs: 300,
    loadTimeoutMs: 20,
    loader: async () => {
      loads += 1;
      await gate;
      return slowModule().module;
    },
  });
  try {
    await assert.rejects(embedder.warmup(), (error) => {
      assert.ok(error instanceof EmbeddingTimeout);
      return true;
    });
    assert.equal(loads, 1);
    assert.equal(embedder.status(), 'loading', '底层加载未被取消，仍是 loading');

    // 第二次重试在 loadTimeoutMs 内再次超时，但绝不并行起第二个加载。
    await assert.rejects(embedder.warmup(), (error) => error instanceof EmbeddingTimeout);
    assert.equal(loads, 1, '重试必须复用未结束的加载 promise');

    release();
    await embedder.warmup();
    assert.equal(embedder.status(), 'ready');
    assert.equal(loads, 1);
  } finally {
    clearTimers();
  }
});
