import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { apply as applyGovern, appendEventWithAction } from '../src/memory/govern.js';
import { noteInjectedFacts } from '../src/index.js';

const dirs = [];
const opened = [];
after(() => {
  for (const entry of opened) {
    try { entry.close(); } catch { /* 已关闭 */ }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-counters-'));
  dirs.push(dir);
  const store = Store.open(join(dir, 'memory.db'));
  opened.push(store);
  return { dir, store };
}

function insertFact(store, id, statement, { usedCount = 0 } = {}) {
  store.insertFact({
    id,
    scope: 'main',
    statement,
    subject_text: '咖啡',
    predicate: '喜欢',
    object_text: '美式',
    kind: 'preference',
    source_kind: 'user_explicit',
    source_rpc_id: 'rpc-1',
    salience: 'normal',
    privacy: 'normal',
    observed_at: 1_790_000_000,
  });
  if (usedCount > 0) {
    store.db.prepare('UPDATE facts SET used_count = ? WHERE id = ?').run(usedCount, id);
  }
  return store.getFact(id);
}

test('A8①：noteInjectedFacts 把注入写回库（injected_count / unused_streak）', () => {
  const { store } = tempStore();
  insertFact(store, 'fact_a', '用户喜欢美式咖啡。');
  insertFact(store, 'fact_b', '用户不喜欢加糖。');

  const state = { store, platform: { log() {} } };
  assert.equal(noteInjectedFacts(state, ['fact_a', 'fact_b'], 1_790_000_100), true);

  const a = store.getFact('fact_a');
  const b = store.getFact('fact_b');
  assert.equal(a.injected_count, 1);
  assert.equal(a.unused_streak, 1);
  assert.equal(b.injected_count, 1);

  // 空清单 / 缺 store：不写、不抛。
  assert.equal(noteInjectedFacts(state, [], 1_790_000_100), false);
  assert.equal(noteInjectedFacts({}, ['fact_a'], 1_790_000_100), false);
  const broken = { store: { bumpFactInjected() { throw new Error('boom'); } }, platform: { log() {} } };
  assert.equal(noteInjectedFacts(broken, ['fact_a'], 1), false);
});

test('A8①：治理去重按 used_count 保留更常用的一条', () => {
  const { store } = tempStore();
  insertFact(store, 'fact_low', '用户喜欢美式咖啡。', { usedCount: 0 });
  insertFact(store, 'fact_high', '用户喜欢美式咖啡。', { usedCount: 5 });

  const report = applyGovern({ store, scope: 'main', now: 1_790_001_000, dryRun: false });
  assert.ok(report.duplicates.length >= 1, JSON.stringify(report.counts));

  const high = store.getFact('fact_high');
  const low = store.getFact('fact_low');
  assert.equal(high.status, 'active', 'used_count 高的一条应当保留');
  assert.equal(low.status, 'superseded');

});

test('D-2：appendEventWithAction 不再临时关闭 CHECK 约束', () => {
  const { store } = tempStore();
  const before = store.db.prepare('PRAGMA ignore_check_constraints').get();
  const id = appendEventWithAction(store, {
    action: 'govern',
    tableName: 'facts',
    rowId: 'fact_x',
    actor: 'user',
    at: 1_790_000_200,
  });
  const after = store.db.prepare('PRAGMA ignore_check_constraints').get();
  assert.ok(id > 0);
  assert.equal(after.ignore_check_constraints, before.ignore_check_constraints);
  const row = store.db.prepare('SELECT action FROM memory_events WHERE id = ?').get(id);
  assert.equal(row.action, 'govern');
  store.close();
});
