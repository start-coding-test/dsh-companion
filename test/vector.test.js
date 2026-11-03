import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import {
  DEFAULT_RRF_K,
  DEFAULT_VECTOR_DIM,
  cosine,
  hashEmbed,
  hybridSearch,
  searchVector,
} from '../src/memory/vector.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;

function daysAgo(days) {
  return NOW_SEC - Math.round(days * DAY_SEC);
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vector-'));
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
    observed_at: daysAgo(1),
    last_reinforced_at: daysAgo(1),
    ...overrides,
  });
}

function normOf(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

test('cosine：相同向量为 1，正交为 0，维度不一致抛 TypeError', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /dimension mismatch/);
  assert.throws(() => cosine([], []), /non-empty/);
});

test('cosine：零向量返回 0 而不是 NaN', () => {
  const value = cosine([0, 0], [1, 1]);
  assert.equal(value, 0);
  assert.ok(Number.isFinite(value));
});

test('hashEmbed：确定性、L2 归一、固定维度', () => {
  const a = hashEmbed('项目代号晨星', 64);
  const b = hashEmbed('项目代号晨星', 64);
  assert.equal(a.length, 64);
  assert.equal(a instanceof Float32Array, true);
  assert.deepEqual([...a], [...b]);
  assert.ok(Math.abs(normOf(a) - 1) < 1e-5);
  assert.notDeepEqual([...a], [...hashEmbed('完全不同的文本', 64)]);
});

test('hashEmbed：空文本全零，单字符也能得到非零向量', () => {
  const empty = hashEmbed('', 32);
  assert.equal(empty.length, 32);
  assert.ok([...empty].every((value) => value === 0));
  const single = hashEmbed('甲', 32);
  assert.ok([...single].some((value) => value !== 0));
});

test('searchVector：按余弦召回 active 事实，并记录 factId/score', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    const hits = searchVector({
      store,
      query: '项目代号是晨星',
      limit: 10,
      now: NOW_MS,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].factId, fact.id);
    assert.ok(hits[0].score > 0.5);
  });
});

test('searchVector：sensitive/secret/墓碑/其他 scope 不召回', async () => {
  await withStore(async (store) => {
    addFact(store, { id: 'ok', statement: '公开的事实甲' });
    addFact(store, { id: 'sensitive', Privacy: 'normal', privacy: 'sensitive', statement: '敏感的事实乙' });
    addFact(store, { id: 'secret', privacy: 'secret', statement: '秘密的事实丙' });
    addFact(store, { id: 'gone', statement: '已经遗忘的事实丁' });
    store.forgetFact('gone', { at: NOW_SEC, payload: { reason: 'test' } });
    addFact(store, { id: 'thread', scope: 'thread:rent', statement: '线程内的事实戊' });

    const ids = searchVector({
      store,
      query: '公开的事实甲 敏感的事实乙 秘密的事实丙 已经遗忘的事实丁 线程内的事实戊',
      limit: 20,
      now: NOW_MS,
    }).map((hit) => hit.factId);
    assert.deepEqual(ids, ['ok']);
  });
});

test('searchVector：遗忘曲线低于 0.05 的事实不召回', async () => {
  await withStore(async (store) => {
    addFact(store, {
      id: 'stale',
      statement: '很久以前的事实',
      strength_days: 3,
      last_reinforced_at: daysAgo(30),
      observed_at: daysAgo(30),
    });
    const hits = searchVector({ store, query: '很久以前的事实', limit: 10, now: NOW_MS });
    assert.deepEqual(hits, []);
  });
});

test('searchVector：空查询/零向量返回空数组，维度不符不会抛错', async () => {
  await withStore(async (store) => {
    addFact(store);
    assert.deepEqual(searchVector({ store, query: '   ', now: NOW_MS }), []);
    const mismatch = searchVector({
      store,
      query: '项目代号是晨星',
      embed: (text) => hashEmbed(text, 8),
      now: NOW_MS,
    });
    assert.deepEqual(mismatch, []);
  });
});

test('hybridSearch：RRF 合并同一 fact 只留一条并累加分数', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    const hits = hybridSearch({
      store,
      query: '项目代号是晨星',
      limit: 10,
      k: 60,
      now: NOW_MS,
    });
    const facts = hits.filter((hit) => hit.type === 'fact');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].id, fact.id);
    assert.equal(hits[0].id, fact.id);
    assert.ok(Math.abs(hits[0].score - 2 / (DEFAULT_RRF_K + 1)) < 1e-9);
  });
});

test('hybridSearch：无命中时返回空数组；limit 生效且分数降序', async () => {
  await withStore(async (store) => {
    for (let index = 0; index < 5; index += 1) {
      addFact(store, {
        id: `f${index}`,
        statement: `共同前缀 事实编号 ${index} 独特后缀${index}`,
        object_text: `对象${index}`,
      });
    }
    const hits = hybridSearch({
      store,
      query: '共同前缀 事实编号',
      limit: 3,
      now: NOW_MS,
    });
    assert.equal(hits.length, 3);
    for (let index = 1; index < hits.length; index += 1) {
      assert.ok(hits[index - 1].score >= hits[index].score);
    }
    assert.deepEqual(
      hybridSearch({ store, query: '', now: NOW_MS }),
      [],
    );
  });
});

test('hybridSearch：默认 k 与常量一致；向量/ FTS 结果去重', async () => {
  await withStore(async (store) => {
    addFact(store);
    const hits = hybridSearch({ store, query: '项目代号是晨星', now: NOW_MS });
    const keys = hits.map((hit) => `${hit.type}:${hit.id}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(DEFAULT_RRF_K, 60);
    assert.equal(DEFAULT_VECTOR_DIM, 256);
  });
});
