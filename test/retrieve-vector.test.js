import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retrieve-vector-'));
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

const ENABLED = Object.freeze({ enabled: true, dim: 256, embedder: 'hash' });
const DISABLED = Object.freeze({ enabled: false, dim: 256, embedder: 'hash' });

test('vector 关闭：返回结构与无 vector 参数一致，且不含 vectorHits', async () => {
  await withStore(async (store) => {
    addFact(store);
    const baseline = await retrieve({ store, query: '项目代号', now: NOW_MS });
    const disabled = await retrieve({
      store, query: '项目代号', now: NOW_MS, vector: DISABLED,
    });
    assert.deepEqual(disabled, baseline);
    assert.equal('vectorHits' in disabled, false);
    assert.ok(disabled.items.length > 0);
  });
});

test('vector 开启：返回 vectorHits，命中数与实际注入一致', async () => {
  await withStore(async (store) => {
    addFact(store);
    const result = await retrieve({
      store, query: '项目代号', now: NOW_MS, vector: ENABLED,
    });
    assert.equal(typeof result.vectorHits, 'number');
    assert.equal(result.vectorHits, 1);
    assert.ok(result.items.some((item) => item.id.startsWith('fact_')));
  });
});

test('vector 开启但 embedder=none：退化为关闭路径', async () => {
  await withStore(async (store) => {
    addFact(store);
    const result = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: { enabled: true, dim: 256, embedder: 'none' },
    });
    assert.equal('vectorHits' in result, false);
  });
});

test('vector 开启：即使 FTS 无结果，向量通道仍可召回', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store,
        query: '项目代号是晨星',
        now: NOW_MS,
        vector: ENABLED,
      });
      assert.ok(result.items.some((item) => item.id === fact.id));
      assert.equal(result.vectorHits, 1);
    } finally {
      store.searchBigram = original;
    }
  });
});

test('vector 关闭且 FTS 无结果：不读向量表，只保留 recency 结果', async () => {
  await withStore(async (store) => {
    addFact(store, {
      salience: 'explicit',
      observed_at: NOW_SEC - 30 * DAY_SEC,
      last_reinforced_at: NOW_SEC - 30 * DAY_SEC,
    });
    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store, query: '项目代号', now: NOW_MS, vector: DISABLED,
      });
      assert.deepEqual(result.items, []);
    } finally {
      store.searchBigram = original;
    }
  });
});

test('vector 开启：sensitive 事实不会从向量通道召回', async () => {
  await withStore(async (store) => {
    addFact(store, {
      id: 'secret-fact',
      privacy: 'sensitive',
      statement: '敏感的项目代号是晨星',
      salience: 'explicit',
      observed_at: NOW_SEC - 30 * DAY_SEC,
      last_reinforced_at: NOW_SEC - 30 * DAY_SEC,
    });
    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store,
        query: '敏感的项目代号是晨星',
        now: NOW_MS,
        vector: ENABLED,
      });
      assert.deepEqual(result.items, []);
    } finally {
      store.searchBigram = original;
    }
  });
});

test('vector 开启：治理标记 sensitive=1 的事实不会从向量通道召回', async () => {
  await withStore(async (store) => {
    const fact = addFact(store, {
      id: 'governed-sensitive',
      statement: '治理后敏感的项目代号是晨星',
      salience: 'explicit',
      observed_at: NOW_SEC - 30 * DAY_SEC,
      last_reinforced_at: NOW_SEC - 30 * DAY_SEC,
    });
    // 模拟 P1-a 治理按需加列并标记敏感。
    store.db.exec('ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
    store.db.prepare('UPDATE facts SET sensitive = 1 WHERE id = ?').run(fact.id);
    const original = store.searchBigram.bind(store);
    store.searchBigram = () => [];
    try {
      const result = await retrieve({
        store,
        query: '治理后敏感的项目代号是晨星',
        now: NOW_MS,
        vector: ENABLED,
      });
      assert.equal(result.vectorHits ?? 0, 0);
      assert.deepEqual(result.items, []);
    } finally {
      store.searchBigram = original;
    }
  });
});
