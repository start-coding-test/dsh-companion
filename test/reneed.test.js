/**
 * W5 首次再需要埋点（t7）。
 *
 * 覆盖：markFirstReneed 只写一次/非法参数/重启保留、v6→v8 与 v7→v8 迁移补列与
 * 索引（幂等）、召回写入 full→clear / gist→ambiguous、强化复述命中升级
 * used、同会话样本 same_context 可判别并被统计排除、巩固去重命中沉睡/墓碑写
 * miss/dedupe 且不复活、用户纠正写 miss/correction。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { editMemoryFact } from '../src/index.js';
import { consolidate } from '../src/memory/consolidate.js';
import {
  SAME_CONTEXT_MIN_INTERVAL_SECONDS,
  episodeSourceInSurface,
  isSameContextSample,
} from '../src/memory/reneed.js';
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
    () => store.markFirstReneed(fact.id, { tier: 'clear', kind: 'bogus' }),
    /invalid first_reneed\.kind/u,
  );
  // v8：used 是合法分类（由强化路径升级写入，非首次注入）。
  assert.equal(
    store.markFirstReneed(fact.id, { at: BASE, tier: 'clear', kind: 'used' }),
    true,
  );
  assert.equal(store.getFact(fact.id).reneed_kind, 'used');
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

test('migrate：v6 库补 first_reneed 四列与索引，旧行保持 NULL', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v6-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.db.exec('DROP INDEX IF EXISTS ix_facts_reneed');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_ins');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_upd');
  first.db.exec('ALTER TABLE facts DROP COLUMN same_context');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_at');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN reneed_kind');
  first.setMeta('schema_version', '6');
  first.close();

  const second = Store.open(path);
  try {
    assert.equal(second.getMeta('schema_version'), '8');
    const columns = second.db
      .prepare("PRAGMA table_info('facts')")
      .all()
      .map((column) => column.name);
    for (const name of ['first_reneed_at', 'first_reneed_tier', 'reneed_kind', 'same_context']) {
      assert.ok(columns.includes(name), `迁移后应补出 ${name}`);
    }
    const row = second.getFact(fact.id);
    assert.equal(row.statement, '青柠计划的代号是蓝鲸。');
    assert.equal(row.first_reneed_at, null);
    assert.equal(row.first_reneed_tier, null);
    assert.equal(row.reneed_kind, null);
    assert.equal(row.same_context, 0);
    const index = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_facts_reneed'")
      .get();
    assert.ok(index, '迁移后应建再需要索引');
  } finally {
    second.close();
  }
});

test('migrate：v7 旧库升到 v8 幂等，重复打开不重复加列/触发器', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v7-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_ins');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_upd');
  first.db.exec('ALTER TABLE facts DROP COLUMN same_context');
  first.setMeta('schema_version', '7');
  first.close();

  for (let round = 0; round < 2; round += 1) {
    const store = Store.open(path);
    try {
      assert.equal(store.getMeta('schema_version'), '8', `第 ${round + 1} 次打开版本稳定`);
      const columns = store.db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name);
      assert.equal(columns.filter((name) => name === 'same_context').length, 1);
      const triggers = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_facts_reneed_kind_%'")
        .all()
        .map((row) => row.name)
        .sort();
      assert.deepEqual(triggers, ['trg_facts_reneed_kind_ins', 'trg_facts_reneed_kind_upd']);
      assert.equal(store.getFact(fact.id).same_context, 0);
      assert.equal(store.getFact(fact.id).reneed_kind, null);
    } finally {
      store.close();
    }
  }
});

test('markReneedUsed：recall 升级 used 保留首次时间，dedupe/correction 不覆盖', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  store.markFirstReneed(fact.id, { at: BASE + 10, tier: 'clear', kind: 'recall' });

  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 999, tier: 'ambiguous', sameContext: false }),
    true,
  );
  const used = store.getFact(fact.id);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_reneed_at, BASE + 10, '首次样本时间不被强化时刻覆盖');
  assert.equal(used.first_reneed_tier, 'clear');
  assert.equal(used.same_context, 0);

  const dedupe = addFact(store);
  store.markFirstReneed(dedupe.id, { at: BASE, tier: 'miss', kind: 'dedupe' });
  assert.equal(store.markReneedUsed(dedupe.id, { at: BASE + 1, tier: 'clear' }), false);
  assert.equal(store.getFact(dedupe.id).reneed_kind, 'dedupe');
});

test('markFirstReneed：same_context 判定 (Δt<6h / 来源仍在 surface) 可写入并被统计排除', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const other = addFact(store, {
    subject_text: '白鹭项目',
    object_text: '灰鲸',
    statement: '白鹭项目的代号是灰鲸。',
  });
  assert.equal(
    store.markFirstReneed(fact.id, {
      at: BASE + 60,
      tier: 'clear',
      kind: 'recall',
      sameContext: true,
    }),
    true,
  );
  assert.equal(store.getFact(fact.id).same_context, 1, '同会话样本应标记 same_context=1');
  store.markFirstReneed(other.id, { at: BASE + 7 * DAY, tier: 'clear', kind: 'recall' });
  assert.equal(store.getFact(other.id).same_context, 0);
  // SQL 口径由 t4 更新；这里钉住排除后可判别的聚合结果。
  const counted = store.db
    .prepare('SELECT COUNT(*) AS n FROM facts WHERE reneed_kind IS NOT NULL AND same_context = 0')
    .get();
  assert.equal(counted.n, 1, '同会话 recall 不得计入 S0 主样本');
});

test('isSameContextSample：Δt<6h 或来源仍在 surface 记为同会话', () => {
  assert.equal(SAME_CONTEXT_MIN_INTERVAL_SECONDS, 6 * 3600);
  assert.equal(isSameContextSample({ at: BASE, createdAt: BASE - 60 }), true);
  assert.equal(isSameContextSample({ at: BASE, createdAt: BASE - 6 * 3600 + 1 }), true);
  assert.equal(isSameContextSample({ at: BASE, createdAt: BASE - 6 * 3600 }), false);
  assert.equal(isSameContextSample({ at: BASE, createdAt: BASE - 30 * DAY }), false);
  assert.equal(
    isSameContextSample({ at: BASE, createdAt: BASE - 30 * DAY, sourceInSurface: true }),
    true,
    '来源 episode 仍在 surface 时即使隔很久也算同会话',
  );
  // 缺时间或时钟回拨 → 不判定为同会话（避免误伤有效样本）。
  assert.equal(isSameContextSample({ at: BASE, createdAt: null }), false);
  assert.equal(isSameContextSample({ at: BASE, createdAt: BASE + 10 }), false);
});

test('episodeSourceInSurface：consolidation.upto_seq 仍在 surface 才为真', () => {
  const episode = { consolidation_id: 'con_1' };
  assert.equal(
    episodeSourceInSurface({ seqs: [1, 2, 3], episode, consolidation: { upto_seq: 2 } }),
    true,
  );
  assert.equal(
    episodeSourceInSurface({ seqs: [3, 4], episode, consolidation: { upto_seq: 2 } }),
    false,
  );
  assert.equal(
    episodeSourceInSurface({ seqs: [1, 2], episode, consolidation: { upto_seq: 0 } }),
    false,
  );
  assert.equal(episodeSourceInSurface({ seqs: null, episode, consolidation: { upto_seq: 2 } }), false);
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
