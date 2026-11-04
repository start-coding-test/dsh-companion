import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { backfillVectors } from '../src/index.js';

const NOW_SEC = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backfill-'));
  const store = Store.open(join(dir, 'companion.db'));
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

function addFact(store, objectText) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: objectText,
    statement: `项目代号是${objectText}`,
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: NOW_SEC,
    last_reinforced_at: NOW_SEC,
  });
}

function makeState(store, embedder, overrides = {}) {
  const metricsCalls = [];
  const logs = [];
  const state = {
    store,
    embedder,
    config: { vector: { enabled: true, backfillBatchSize: 50, ...overrides.vector } },
    metrics: {
      inc(name, value = 1) {
        metricsCalls.push({ name, value });
      },
    },
    platform: {
      log(level, message, meta) {
        logs.push({ level, message, meta });
      },
    },
    vectorBackfilled: 0,
  };
  return { state, metricsCalls, logs };
}

test('backfillVectors：只回填 embedder_id 不匹配的活跃事实，重复调用不再写', async () => {
  await withStore(async (store) => {
    const fact = addFact(store, '晨星');
    store.configureVectors({ id: 'remote:test', dim: 0, embed: null });
    let embedded = 0;
    const embedder = {
      kind: 'remote',
      id: 'remote:test',
      dim: 8,
      async embed(texts) {
        embedded += texts.length;
        return texts.map(() => Float32Array.of(1, 0, 0, 0, 0, 0, 0, 0));
      },
    };
    const { state, metricsCalls } = makeState(store, embedder);
    assert.equal(await backfillVectors(state), 1);
    assert.equal(state.vectorBackfilled, 1);
    assert.equal(embedded, 1);
    const row = store.db.prepare('SELECT embedder_id, dim FROM fact_vectors WHERE fact_id = ?').get(fact.id);
    assert.equal(row.embedder_id, 'remote:test');
    assert.equal(row.dim, 8);
    assert.deepEqual(metricsCalls, [{ name: 'vectorBackfilled', value: 1 }]);

    assert.equal(await backfillVectors(state), 0);
    assert.equal(state.vectorBackfilled, 1);
  });
});

test('backfillVectors：embed 失败只记 metric + warn，不抛出也不阻塞', async () => {
  await withStore(async (store) => {
    addFact(store, '启明');
    store.configureVectors({ id: 'remote:test', dim: 0, embed: null });
    const embedder = {
      kind: 'remote',
      id: 'remote:test',
      dim: 4,
      async embed() {
        const error = new Error('network down');
        error.code = 'EMBEDDING_UNAVAILABLE';
        throw error;
      },
    };
    const { state, metricsCalls, logs } = makeState(store, embedder);
    assert.equal(await backfillVectors(state), 0);
    assert.equal(state.vectorBackfilled, 0);
    assert.deepEqual(metricsCalls, [{ name: 'vectorEmbedFailures', value: 1 }]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.equal(logs[0].meta.code, 'EMBEDDING_UNAVAILABLE');
  });
});

test('backfillVectors：hash/关闭路径不做异步回填', async () => {
  await withStore(async (store) => {
    addFact(store, '晨星');
    let called = 0;
    const embedder = {
      kind: 'hash',
      id: 'hash:256',
      dim: 256,
      async embed(texts) {
        called += 1;
        return texts.map(() => Float32Array.of(1));
      },
    };
    const { state } = makeState(store, embedder);
    assert.equal(await backfillVectors(state), 0);
    assert.equal(called, 0);

    const off = makeState(store, { ...embedder, kind: 'remote', id: 'remote:test' }, {
      vector: { enabled: false },
    });
    assert.equal(await backfillVectors(off.state), 0);
  });
});
