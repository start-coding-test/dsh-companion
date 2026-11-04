import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { EmbeddingUnavailable } from '../src/memory/embedders/index.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;
const DIM = 8;
const EIGHT = Object.freeze([1, 0, 0, 0, 0, 0, 0, 0]);

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retrieve-embedder-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: '晨星',
    statement: '项目代号是晨星',
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: NOW_SEC - DAY_SEC,
    last_reinforced_at: NOW_SEC - DAY_SEC,
    ...overrides,
  });
}

function localVector() {
  return Object.freeze({ enabled: true, dim: DIM, embedder: 'local' });
}

test('retrieve：async embedder 先算查询向量，再只召回 embedder_id 匹配的投影', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    store.configureVectors({ id: 'local:test:8', dim: DIM, embed: null });
    store.upsertFactVector({
      factId: fact.id,
      vec: new Float32Array(EIGHT),
      embedderId: 'local:test:8',
    });
    const queries = [];
    const embedder = {
      id: 'local:test:8',
      dim: DIM,
      async embed(texts) {
        queries.push({ kind: 'embed', texts });
        return texts.map(() => new Float32Array(EIGHT));
      },
      async embedQuery(texts) {
        queries.push({ kind: 'embedQuery', texts });
        return texts.map(() => new Float32Array(EIGHT));
      },
    };

    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store,
        query: '项目代号',
        now: NOW_MS,
        vector: localVector(),
        embedder,
      });
      assert.equal(result.vectorHits, 1);
      assert.ok(result.items.some((item) => item.id === fact.id));
      assert.equal(queries.length, 1);
      assert.equal(queries[0].kind, 'embedQuery');
      assert.deepEqual(queries[0].texts, ['项目代号']);
    } finally {
      store.searchBigram = original;
    }
  });
});

test('retrieve：embedder 抛 EmbeddingUnavailable 时回退纯 FTS，并带 vectorError', async () => {
  await withStore(async (store) => {
    addFact(store);
    const embedder = {
      id: 'local:test:8',
      dim: DIM,
      async embed() {
        throw new EmbeddingUnavailable('model missing');
      },
    };
    const result = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal('vectorHits' in result, false);
    assert.equal(result.vectorError.code, 'EMBEDDING_UNAVAILABLE');
    assert.match(result.vectorError.message, /model missing/u);
    assert.ok(result.items.some((item) => item.text.includes('晨星')), 'FTS 召回不受影响');
  });
});

test('retrieve：embedder_id 不一致的旧投影不参与召回', async () => {
  await withStore(async (store) => {
    const fact = addFact(store, {
      salience: 'explicit',
      observed_at: NOW_SEC - 30 * DAY_SEC,
      last_reinforced_at: NOW_SEC - 30 * DAY_SEC,
    });
    store.configureVectors({ id: 'local:test:8', dim: DIM, embed: null });
    store.upsertFactVector({
      factId: fact.id,
      vec: new Float32Array(EIGHT),
      embedderId: 'hash:8',
    });
    const embedder = {
      id: 'local:test:8',
      dim: DIM,
      async embed() {
        return [new Float32Array(EIGHT)];
      },
    };
    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store,
        query: '项目代号',
        now: NOW_MS,
        vector: localVector(),
        embedder,
      });
      assert.equal(result.vectorHits, 0);
      assert.deepEqual(result.items, []);
    } finally {
      store.searchBigram = original;
    }
  });
});

test('retrieve：只有 embed() 的嵌入器也可用（hash/remote 无 embedQuery）', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    store.configureVectors({ id: 'remote:test', dim: DIM, embed: null });
    store.upsertFactVector({
      factId: fact.id,
      vec: new Float32Array(EIGHT),
      embedderId: 'remote:test',
    });
    let calls = 0;
    const embedder = {
      id: 'remote:test',
      dim: DIM,
      async embed() {
        calls += 1;
        return [new Float32Array(EIGHT)];
      },
    };
    const result = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(calls, 1);
    assert.equal(result.vectorHits, 1);
  });
});
