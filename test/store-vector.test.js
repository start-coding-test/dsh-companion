import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { DEFAULT_VECTOR_DIM } from '../src/memory/vector.js';

const NOW_SEC = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const DAY_SEC = 86_400;

function withStore(fn, dirName = 'dsh-store-vector-') {
  const dir = mkdtempSync(join(tmpdir(), dirName));
  const store = Store.open(join(dir, 'companion.db'));
  return Promise.resolve()
    .then(() => fn(store, dir))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
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

function vectorRow(store, id) {
  return store.db.prepare('SELECT * FROM fact_vectors WHERE fact_id = ?').get(id) ?? null;
}

test('insertFact：active/normal 事实自动写入默认维度向量', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    const row = vectorRow(store, fact.id);
    assert.ok(row);
    assert.equal(row.dim, DEFAULT_VECTOR_DIM);
    assert.equal(row.vec.byteLength, DEFAULT_VECTOR_DIM * 4);
    assert.ok(Number.isInteger(row.updated_at));
  });
});

test('insertFact：sensitive/secret 事实不写向量', async () => {
  await withStore(async (store) => {
    const sensitive = addFact(store, { id: 'sensitive', privacy: 'sensitive' });
    const secret = addFact(store, { id: 'secret', privacy: 'secret' });
    assert.equal(vectorRow(store, sensitive.id), null);
    assert.equal(vectorRow(store, secret.id), null);
  });
});

test('updateFact：改文本会重建向量，改 sensitive 会删除向量', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    const before = vectorRow(store, fact.id).vec;
    store.updateFact(fact.id, { statement: '项目代号改为长庚', object_text: '长庚' });
    const after = vectorRow(store, fact.id).vec;
    assert.notDeepEqual([...after], [...before]);

    store.updateFact(fact.id, { privacy: 'sensitive' });
    assert.equal(vectorRow(store, fact.id), null);

    store.updateFact(fact.id, { privacy: 'normal' });
    assert.ok(vectorRow(store, fact.id));
  });
});

test('updateFact：status 改为 superseded/tombstoned 会删除向量', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    store.updateFact(fact.id, { status: 'superseded' });
    assert.equal(vectorRow(store, fact.id), null);
  });
});

test('forgetFact：墓碑化后删除向量，行仍保留', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    store.forgetFact(fact.id, { at: NOW_SEC, payload: { reason: 'test' } });
    assert.equal(vectorRow(store, fact.id), null);
    const row = store.getFact(fact.id);
    assert.equal(row.status, 'tombstoned');
    assert.ok(row.deleted_at);
  });
});

test('deleteFact：软删除事实时同步删除向量', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    assert.ok(vectorRow(store, fact.id));
    store.deleteFact(fact.id);
    assert.equal(vectorRow(store, fact.id), null);
    assert.ok(store.getFact(fact.id).deleted_at);
  });
});

test('setVectorDim：维度变化清旧投影，新写入使用新维度', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    assert.equal(store.vectorDim, 256);
    store.setVectorDim(32);
    assert.equal(store.vectorDim, 32);
    assert.equal(vectorRow(store, fact.id), null);
    store.updateFact(fact.id, { statement: '项目代号是晨星（重建）' });
    assert.equal(vectorRow(store, fact.id).dim, 32);
    assert.throws(() => store.setVectorDim(4), /vector dim/);
    assert.throws(() => store.setVectorDim(8192), /vector dim/);
  });
});

test('migrate：v4 库升级到 v5，只建 fact_vectors 并保留既有事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-v5-'));
  const path = join(dir, 'companion.db');
  try {
    const first = Store.open(path);
    const fact = addFact(first);
    first.setMeta('schema_version', '4');
    first.close();

    const second = Store.open(path);
    assert.equal(second.getMeta('schema_version'), '5');
    assert.ok(second.getFact(fact.id));
    const table = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fact_vectors'")
      .get();
    assert.ok(table);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrate：未知 schema_version 仍抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-vbad-'));
  const path = join(dir, 'companion.db');
  try {
    const first = Store.open(path);
    first.setMeta('schema_version', '99');
    first.close();
    assert.throws(() => Store.open(path), /unsupported schema_version/);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上 Store.open 失败时 sqlite 句柄可能来不及释放；临时目录留给系统清理。
    }
  }
});
