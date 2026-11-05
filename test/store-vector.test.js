import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { DEFAULT_VECTOR_DIM, searchVector } from '../src/memory/vector.js';

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

test('W4：insertFact 写入当前 embedder_id（默认 hash:256）', async () => {
  await withStore(async (store) => {
    const fact = addFact(store);
    assert.equal(store.vectorEmbedderId, 'hash:256');
    assert.equal(vectorRow(store, fact.id).embedder_id, 'hash:256');
  });
});

test('W4：configureVectors 换代清旧投影；异步 embedder 写入路径不投影，回填补齐', async () => {
  await withStore(async (store) => {
    const a = addFact(store, { id: 'fact-a', statement: '项目代号是晨星' });
    const b = addFact(store, { id: 'fact-b', statement: '项目负责人是林舟' });
    store.configureVectors({ id: 'local:test:8', dim: 8, embed: null });
    assert.equal(store.vectorEmbedderId, 'local:test:8');
    assert.equal(store.vectorDim, 8);
    assert.equal(vectorRow(store, a.id), null, '换 embedder 应清掉 hash 投影');
    assert.equal(vectorRow(store, b.id), null);

    // 异步 embedder 没有同步向量函数：写入只保留事实，不写半成品向量。
    const c = addFact(store, { id: 'fact-c', statement: '项目里程碑在下周' });
    assert.equal(vectorRow(store, c.id), null);

    const pending = store.listVectorBackfill({ embedderId: 'local:test:8', dim: 8, limit: 50 });
    assert.deepEqual(pending.map((row) => row.id).sort(), ['fact-a', 'fact-b', 'fact-c']);
    assert.equal(pending.find((row) => row.id === 'fact-a').text, '项目代号是晨星 项目 代号 晨星');

    for (const row of pending) {
      const saved = store.upsertFactVector({
        factId: row.id,
        vec: new Float32Array([0.1, 0.2, 0.3, 0, 0, 0, 0, 0]),
        embedderId: 'local:test:8',
      });
      assert.deepEqual(saved, { factId: row.id, embedderId: 'local:test:8', dim: 8 });
      assert.equal(vectorRow(store, row.id).embedder_id, 'local:test:8');
      assert.equal(vectorRow(store, row.id).dim, 8);
    }
    assert.deepEqual(store.listVectorBackfill({ embedderId: 'local:test:8', dim: 8 }), []);
  });
});

test('W4：listVectorBackfill 排除 sensitive/secret/墓碑/删除事实，且只收不匹配行', async () => {
  await withStore(async (store) => {
    const normal = addFact(store, { id: 'keep', statement: '可回填的事实' });
    addFact(store, { id: 'sensitive', privacy: 'sensitive', statement: '敏感事实' });
    addFact(store, { id: 'secret', privacy: 'secret', statement: '秘密事实' });
    const tomb = addFact(store, { id: 'tomb', statement: '将被遗忘' });
    store.forgetFact(tomb.id, { at: NOW_SEC, payload: { reason: 'test' } });
    const gone = addFact(store, { id: 'gone', statement: '将被删除' });
    store.deleteFact(gone.id);

    const owner = addFact(store, { id: 'hash-row', statement: '已有 hash 向量' });

    store.configureVectors({ id: 'local:test:8', dim: 8, embed: null });
    // configureVectors 清掉全部旧 id；再手动写一条当前 id 的行验证“已回填跳过”。
    store.upsertFactVector({
      factId: owner.id,
      vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      embedderId: 'local:test:8',
    });

    const rows = store.listVectorBackfill({ embedderId: 'local:test:8', dim: 8 });
    assert.deepEqual(rows.map((row) => row.id), [normal.id]);
    assert.equal(store.upsertFactVector({
      factId: 'sensitive',
      vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      embedderId: 'local:test:8',
    }), null);
    assert.equal(vectorRow(store, 'sensitive'), null);
  });
});

test('W4：searchVector 只召回 embedder_id 匹配的投影', async () => {
  await withStore(async (store) => {
    const a = addFact(store, { id: 'fact-a', statement: '项目代号是晨星' });
    const b = addFact(store, { id: 'fact-b', statement: '项目负责人是林舟' });
    store.configureVectors({ id: 'local:test:8', dim: 8, embed: null });
    store.upsertFactVector({
      factId: a.id, vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), embedderId: 'local:test:8',
    });
    store.upsertFactVector({
      factId: b.id, vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), embedderId: 'hash:8',
    });

    const matched = searchVector({
      store,
      query: '项目',
      embed: () => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      embedderId: 'local:test:8',
      now: NOW_SEC * 1000,
    });
    assert.deepEqual(matched.map((hit) => hit.factId), [a.id]);

    const legacy = searchVector({
      store,
      query: '项目',
      embed: () => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]),
      now: NOW_SEC * 1000,
    });
    assert.deepEqual(legacy.map((hit) => hit.factId).sort(), [a.id, b.id], '未传 embedderId 时保持 v0.3.2 行为');
  });
});

test('migrate：v4 库升级到 v7，补建 fact_vectors 并保留既有事实', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-v7-'));
  const path = join(dir, 'companion.db');
  try {
    const first = Store.open(path);
    const fact = addFact(first);
    first.setMeta('schema_version', '4');
    first.close();

    const second = Store.open(path);
    assert.equal(second.getMeta('schema_version'), '11');
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

test('migrate：v5 库补 embedder_id、升级到 v7 并把旧行回填为 hash:<dim>', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-v5-'));
  const path = join(dir, 'companion.db');
  try {
    const first = Store.open(path);
    const fact = addFact(first);
    first.db.exec('DROP INDEX IF EXISTS ix_fact_vectors_embedder');
    first.db.exec('ALTER TABLE fact_vectors DROP COLUMN embedder_id');
    first.setMeta('schema_version', '5');
    first.close();

    const second = Store.open(path);
    try {
      assert.equal(second.getMeta('schema_version'), '11');
      const columns = second.db
        .prepare("PRAGMA table_info('fact_vectors')")
        .all()
        .map((column) => column.name);
      assert.ok(columns.includes('embedder_id'), '迁移后应补出 embedder_id 列');
      assert.equal(vectorRow(second, fact.id).embedder_id, 'hash:256');
      const index = second.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_fact_vectors_embedder'")
        .get();
      assert.ok(index, '迁移后应建 embedder 索引');
    } finally {
      second.close();
    }
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
