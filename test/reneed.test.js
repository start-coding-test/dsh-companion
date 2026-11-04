/**
 * W5 首次再需要埋点（t7）。
 *
 * 覆盖：markFirstReneed 只写一次/非法参数/重启保留、v6→v7 迁移补列与索引、
 * 召回写入 full→clear / gist→ambiguous、巩固去重命中沉睡/墓碑写
 * miss/dedupe 且不复活、用户纠正写 miss/correction。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editMemoryFact } from '../src/index.js';
import { consolidate } from '../src/memory/consolidate.js';
import { Store } from '../src/memory/store.js';

const BASE = 1_700_000_000;
const DAY = 86_400;

/** 一条可复用的普通事实。 */
function addFact(store, overrides = {}) {
  return store.insertFact({
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement: '青柠计划的代号是蓝鲸。',
    source_kind: 'user_explicit',
    observed_at: BASE,
    last_reinforced_at: BASE,
    ...overrides,
  });
}

/** 与 addFact 同 key 的巩固草稿。 */
function sameKeyDraft() {
  return {
    episode: {
      title: '青柠计划同步',
      summary: '用户再次提到青柠计划的代号。',
      started_at: BASE,
    },
    facts: [{
      kind: 'project',
      subject_text: '青柠计划',
      predicate: '代号',
      object_text: '蓝鲸',
      statement: '用户再次确认青柠计划的代号是蓝鲸。',
    }],
    reminders: [],
  };
}

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

test('markFirstReneed：只写一次，后到样本不覆盖首次', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  assert.equal(fact.first_reneed_at, null);

  assert.equal(
    store.markFirstReneed(fact.id, { at: BASE + 10, tier: 'clear', kind: 'recall' }),
    true,
  );
  const first = store.getFact(fact.id);
  assert.equal(first.first_reneed_at, BASE + 10);
  assert.equal(first.first_reneed_tier, 'clear');
  assert.equal(first.reneed_kind, 'recall');

  assert.equal(
    store.markFirstReneed(fact.id, { at: BASE + 20, tier: 'miss', kind: 'correction' }),
    false,
  );
  const after = store.getFact(fact.id);
  assert.equal(after.first_reneed_at, BASE + 10, '首次样本不能被纠正覆盖');
  assert.equal(after.first_reneed_tier, 'clear');
  assert.equal(after.reneed_kind, 'recall');
});

test('markFirstReneed：非法档位/来源抛 TypeError，缺行返回 false', (t) => {
  const store = openStore(t);
  const fact = addFact(store);

  assert.throws(
    () => store.markFirstReneed(fact.id, { tier: 'full', kind: 'recall' }),
    /invalid first_reneed\.tier/u,
  );
  assert.throws(
    () => store.markFirstReneed(fact.id, { tier: 'clear', kind: 'used' }),
    /invalid first_reneed\.kind/u,
  );
  assert.equal(
    store.markFirstReneed('fact_missing', { at: BASE, tier: 'clear', kind: 'recall' }),
    false,
  );
});

test('markFirstReneed：重启后保留首次样本，不再重复写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  assert.equal(
    first.markFirstReneed(fact.id, { at: BASE + 7, tier: 'ambiguous', kind: 'recall' }),
    true,
  );
  first.close();

  const second = Store.open(path);
  try {
    const row = second.getFact(fact.id);
    assert.equal(row.first_reneed_at, BASE + 7);
    assert.equal(row.first_reneed_tier, 'ambiguous');
    assert.equal(row.reneed_kind, 'recall');
    assert.equal(
      second.markFirstReneed(fact.id, { at: BASE + 8, tier: 'miss', kind: 'correction' }),
      false,
    );
    assert.equal(second.getFact(fact.id).first_reneed_at, BASE + 7);
  } finally {
    second.close();
  }
});

test('migrate：v6 库补 first_reneed 三列与索引，旧行保持 NULL', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v6-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.db.exec('DROP INDEX IF EXISTS ix_facts_reneed');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_at');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN reneed_kind');
  first.setMeta('schema_version', '6');
  first.close();

  const second = Store.open(path);
  try {
    assert.equal(second.getMeta('schema_version'), '7');
    const columns = second.db
      .prepare("PRAGMA table_info('facts')")
      .all()
      .map((column) => column.name);
    for (const name of ['first_reneed_at', 'first_reneed_tier', 'reneed_kind']) {
      assert.ok(columns.includes(name), `迁移后应补出 ${name}`);
    }
    const row = second.getFact(fact.id);
    assert.equal(row.statement, '青柠计划的代号是蓝鲸。');
    assert.equal(row.first_reneed_at, null);
    assert.equal(row.first_reneed_tier, null);
    assert.equal(row.reneed_kind, null);
    const index = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_facts_reneed'")
      .get();
    assert.ok(index, '迁移后应建再需要索引');
  } finally {
    second.close();
  }
});

test('consolidate：去重命中 dormant 旧行记 miss/dedupe，不复活、不新增', async (t) => {
  const store = openStore(t);
  const old = addFact(store, {
    observed_at: BASE - 30 * DAY,
    last_reinforced_at: BASE - 30 * DAY,
    strength_days: 14,
  });
  store.updateFact(old.id, { status: 'dormant' });

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 5,
    llm: async () => sameKeyDraft(),
    now: BASE,
  });

  assert.equal(result.facts, 0);
  const rows = store.listFacts({ scope: 'main', includeDeleted: true });
  assert.equal(rows.length, 1, '不得为同 key 再插一行');
  const row = store.getFact(old.id);
  assert.equal(row.status, 'dormant', '旧行不应被复活');
  assert.equal(row.first_reneed_at, BASE);
  assert.equal(row.first_reneed_tier, 'miss');
  assert.equal(row.reneed_kind, 'dedupe');
});

test('consolidate：去重命中墓碑记 miss/dedupe，墓碑保持墓碑', async (t) => {
  const store = openStore(t);
  const old = addFact(store);
  store.forgetFact(old.id, { at: BASE - DAY });

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 5,
    llm: async () => sameKeyDraft(),
    now: BASE,
  });

  assert.equal(result.facts, 0);
  const rows = store.listFacts({ scope: 'main', includeDeleted: true });
  assert.equal(rows.length, 1);
  const row = store.getFact(old.id);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, BASE - DAY);
  assert.equal(row.first_reneed_at, BASE);
  assert.equal(row.first_reneed_tier, 'miss');
  assert.equal(row.reneed_kind, 'dedupe');
});

test('consolidate：活跃旧行去重不写漏样本', async (t) => {
  const store = openStore(t);
  const old = addFact(store, { observed_at: BASE - DAY, last_reinforced_at: BASE });

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 5,
    llm: async () => sameKeyDraft(),
    now: BASE,
  });

  assert.equal(result.facts, 0);
  assert.equal(store.getFact(old.id).first_reneed_at, null);
});

test('editMemoryFact：纠正写 miss/correction，不覆盖先前的命中样本', (t) => {
  const store = openStore(t);
  const hit = addFact(store);
  store.markFirstReneed(hit.id, { at: BASE + 5, tier: 'clear', kind: 'recall' });
  const edited = editMemoryFact({
    store,
    id: hit.id,
    statement: '青柠计划的代号是虎鲸。',
    now: BASE * 1000,
  });
  assert.equal(edited.ok, true);
  const old = store.getFact(hit.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.first_reneed_at, BASE + 5, '命中样本优先于纠正');
  assert.equal(old.first_reneed_tier, 'clear');
  assert.equal(old.reneed_kind, 'recall');
  assert.equal(store.getFact(edited.id).first_reneed_at, null);
});

test('editMemoryFact：无命中样本时写 miss/correction', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const edited = editMemoryFact({
    store,
    id: fact.id,
    statement: '青柠计划的代号是虎鲸。',
    now: BASE * 1000,
  });
  assert.equal(edited.ok, true);
  const old = store.getFact(fact.id);
  assert.equal(old.first_reneed_at, BASE);
  assert.equal(old.first_reneed_tier, 'miss');
  assert.equal(old.reneed_kind, 'correction');
});
