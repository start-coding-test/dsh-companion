/**
 * v0.4.4 / V3-M4：编辑记忆后按新 statement 重抽内容字段，并重建 FTS/向量。
 *
 * 真机问题：`/记忆 改` 只替换 statement，subject_text/predicate/object_text
 * 沿用旧行，于是旧值仍能被搜到、治理分组与索引对着旧值工作。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { scan } from '../src/memory/govern.js';
import { editMemoryFact, reextractFactFields } from '../src/index.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;
const ENABLED = Object.freeze({ enabled: true, dim: 256, embedder: 'hash' });

function makeStore(t) {
  const store = Store.open(':memory:');
  if (t && typeof t.after === 'function') t.after(() => store.close());
  return store;
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '行程',
    predicate: '计划',
    object_text: '杭州出差',
    statement: '下周四去杭州出差',
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: NOW_SEC - DAY_SEC,
    last_reinforced_at: NOW_SEC - DAY_SEC,
    ...overrides,
  });
}

function ftsCount(store, id) {
  return store.db
    .prepare('SELECT COUNT(*) AS n FROM fts_facts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)')
    .get(id).n;
}

test('reextractFactFields：去前缀得到新 object，subject/predicate 保守沿用', () => {
  const fields = reextractFactFields(
    { statement: '下周四去杭州出差', subject_text: '行程', predicate: '计划', object_text: '杭州出差' },
    '下周四去杭州',
  );
  assert.equal(fields.subject_text, '行程');
  assert.equal(fields.predicate, '计划');
  assert.equal(fields.object_text, '杭州');
  assert.equal(fields.extracted, true);

  const birthday = reextractFactFields(
    { statement: '我的生日是五月一日', subject_text: '我', predicate: '生日', object_text: '五月一日' },
    '我的生日是六月一日。',
  );
  assert.equal(birthday.object_text, '六月一日', '句尾标点不进入值');
  assert.equal(birthday.subject_text, '我');

  const template = reextractFactFields(
    { statement: '记住要买牛奶', subject_text: '我', predicate: '记住', object_text: '要买牛奶' },
    '记住要买酸奶',
  );
  assert.equal(template.predicate, '记住');
  assert.equal(template.object_text, '要买酸奶');

  const unchanged = reextractFactFields(
    { statement: '下周四去杭州出差', subject_text: '行程', predicate: '计划', object_text: '杭州出差' },
    '下周四去杭州出差',
  );
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.object_text, '杭州出差', '原句没变时不清空旧值');

  const miss = reextractFactFields(
    { statement: '下周四去杭州出差', subject_text: '行程', predicate: '计划', object_text: '杭州出差' },
    '完全换了一种说法',
  );
  assert.equal(miss.extracted, false);
  assert.equal(miss.object_text, null);
});

test('editMemoryFact：旧值搜不到、新值能搜到，FTS 按新行重建', (t) => {
  const store = makeStore(t);
  const old = addFact(store);
  assert.ok(store.searchBigram('杭州出差', {}).some((hit) => hit.id === old.id));

  const edited = editMemoryFact({ store, id: old.id, statement: '下周四去杭州', now: NOW_MS });
  assert.equal(edited.ok, true);
  assert.equal(edited.reextracted, true);

  const row = store.getFact(edited.id);
  assert.equal(row.object_text, '杭州');
  assert.equal(row.subject_text, '行程');
  assert.equal(row.fidelity, 'full');
  assert.ok(ftsCount(store, edited.id) > 0, '新行必须有 FTS 投影');

  const oldHits = store.searchBigram('杭州出差', {});
  assert.equal(oldHits.some((hit) => hit.id === old.id), false, '旧行不再可检索');
  assert.equal(oldHits.some((hit) => hit.id === edited.id), false, '旧值不应命中新行');
  assert.ok(store.searchBigram('杭州', {}).some((hit) => hit.id === edited.id), '新值可检索');
});

test('editMemoryFact：向量投影按新值重建，旧向量不再命中', async (t) => {
  const store = makeStore(t);
  store.setVectorDim(256);
  const old = addFact(store);
  const edited = editMemoryFact({ store, id: old.id, statement: '下周四去杭州', now: NOW_MS });

  const vectors = store.db.prepare('SELECT fact_id FROM fact_vectors ORDER BY fact_id').all();
  assert.deepEqual(vectors.map((row) => row.fact_id), [edited.id], '只保留新行的向量');

  const result = await retrieve({
    store, query: '下周四去杭州', now: NOW_MS, vector: ENABLED,
  });
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes(edited.id), '新内容应被召回');
  assert.equal(ids.includes(old.id), false, '旧行不再召回');
});

test('editMemoryFact：抽不出新值时 object_text=NULL，EDIT 审计标 edited/reextracted=false', (t) => {
  const store = makeStore(t);
  const old = addFact(store);
  const edited = editMemoryFact({ store, id: old.id, statement: '完全换了一种说法', now: NOW_MS });
  assert.equal(edited.ok, true);
  assert.equal(edited.reextracted, false);
  assert.equal(edited.objectText, null);

  const row = store.getFact(edited.id);
  assert.equal(row.object_text, null);
  assert.equal(row.statement, '完全换了一种说法');
  assert.equal(row.subject_text, '行程');

  const event = store.listEvents({ action: 'EDIT', limit: 1 })[0];
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.edited, true);
  assert.equal(detail.reextracted, false);
  assert.equal(detail.from, old.id);
  assert.equal(detail.to, edited.id);
});

test('editMemoryFact：治理冲突分组用新值（旧 id 退出，新 id 进入）', (t) => {
  const store = makeStore(t);
  const first = addFact(store, {
    subject_text: '预算',
    predicate: '金额',
    object_text: '8000',
    statement: '预算金额是 8000',
  });
  addFact(store, {
    subject_text: '预算',
    predicate: '金额',
    object_text: '12000',
    statement: '预算金额是 12000',
  });

  const edited = editMemoryFact({ store, id: first.id, statement: '预算金额是 9000', now: NOW_MS });
  assert.equal(edited.ok, true);
  assert.equal(store.getFact(edited.id).object_text, '9000');

  const report = scan({ store, scope: 'main', now: NOW_MS });
  const group = report.conflicts.find((item) => item.subject === '预算' && item.predicate === '金额');
  assert.ok(group, '同 subject+predicate 不同 object 仍应分组');
  assert.ok(group.factIds.includes(edited.id), '新行参与分组');
  assert.equal(group.factIds.includes(first.id), false, '旧行已 superseded，不再参与');

  const objects = store.db
    .prepare("SELECT object_text FROM facts WHERE subject_text = '预算' AND predicate = '金额' AND status = 'active'")
    .all()
    .map((row) => row.object_text)
    .sort();
  assert.deepEqual(objects, ['12000', '9000'], '分组读到的 object 是新值');
});
