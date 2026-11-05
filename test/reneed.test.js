/**
 * W5 首次再需要/首次用上埋点（t7，v9 增补 S2-M1）。
 *
 * 覆盖：markFirstReneed 只写一次/非法参数/重启保留、markReneedUsed 只写
 * first_used_* 不动 recall 样本、非 same_context 用上可覆盖 same_context 用上
 * 一次、v6/v7/v8→v9 迁移补列与索引（幂等）、召回写入 full→clear /
 * gist→ambiguous、同会话样本 same_context/used_same_context 可判别并被统计
 * 排除、巩固去重命中沉睡/墓碑写 miss/dedupe 且不复活、用户纠正写
 * miss/correction。
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
  resolveObservedAt,
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

test('migrate：v6 库补 first_reneed/used 七列与索引，旧行保持 NULL', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v6-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.db.exec('DROP INDEX IF EXISTS ix_facts_reneed');
  first.db.exec('DROP INDEX IF EXISTS ix_facts_used');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_ins');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_upd');
  first.db.exec('ALTER TABLE facts DROP COLUMN used_same_context');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_at');
  first.db.exec('ALTER TABLE facts DROP COLUMN same_context');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_at');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_reneed_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN reneed_kind');
  first.setMeta('schema_version', '6');
  first.close();

  const second = Store.open(path);
  try {
    assert.equal(second.getMeta('schema_version'), '13');
    const columns = second.db
      .prepare("PRAGMA table_info('facts')")
      .all()
      .map((column) => column.name);
    for (const name of [
      'first_reneed_at',
      'first_reneed_tier',
      'reneed_kind',
      'same_context',
      'first_used_at',
      'first_used_tier',
      'used_same_context',
    ]) {
      assert.ok(columns.includes(name), `迁移后应补出 ${name}`);
    }
    const row = second.getFact(fact.id);
    assert.equal(row.statement, '青柠计划的代号是蓝鲸。');
    assert.equal(row.first_reneed_at, null);
    assert.equal(row.first_reneed_tier, null);
    assert.equal(row.reneed_kind, null);
    assert.equal(row.same_context, 0);
    assert.equal(row.first_used_at, null, '旧行没有用上记录 → NULL');
    assert.equal(row.first_used_tier, null);
    assert.equal(row.used_same_context, null);
    const index = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_facts_reneed'")
      .get();
    assert.ok(index, '迁移后应建再需要索引');
    const usedIndex = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_facts_used'")
      .get();
    assert.ok(usedIndex, '迁移后应建用上索引');
  } finally {
    second.close();
  }
});

test('migrate：v7 旧库升到 v9 幂等，重复打开不重复加列/触发器', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v7-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_ins');
  first.db.exec('DROP TRIGGER IF EXISTS trg_facts_reneed_kind_upd');
  first.db.exec('DROP INDEX IF EXISTS ix_facts_used');
  first.db.exec('ALTER TABLE facts DROP COLUMN used_same_context');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_at');
  first.db.exec('ALTER TABLE facts DROP COLUMN same_context');
  first.setMeta('schema_version', '7');
  first.close();

  for (let round = 0; round < 2; round += 1) {
    const store = Store.open(path);
    try {
      assert.equal(store.getMeta('schema_version'), '13', `第 ${round + 1} 次打开版本稳定`);
      const columns = store.db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name);
      assert.equal(columns.filter((name) => name === 'same_context').length, 1);
      for (const name of ['first_used_at', 'first_used_tier', 'used_same_context']) {
        assert.equal(columns.filter((column) => column === name).length, 1, `${name} 不得重复`);
      }
      const triggers = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_facts_reneed_kind_%'")
        .all()
        .map((row) => row.name)
        .sort();
      assert.deepEqual(triggers, ['trg_facts_reneed_kind_ins', 'trg_facts_reneed_kind_upd']);
      assert.equal(store.getFact(fact.id).same_context, 0);
      assert.equal(store.getFact(fact.id).reneed_kind, null);
      assert.equal(store.getFact(fact.id).first_used_at, null);
    } finally {
      store.close();
    }
  }
});

test('markReneedUsed：只写 first_used_*，不动 recall 样本；dedupe/correction 不覆盖', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  store.markFirstReneed(fact.id, {
    at: BASE + 10,
    tier: 'clear',
    kind: 'recall',
    sameContext: true,
  });

  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 3 * DAY, tier: 'ambiguous', sameContext: false }),
    true,
  );
  const used = store.getFact(fact.id);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_reneed_at, BASE + 10, 'recall 样本时间不被用上时刻覆盖');
  assert.equal(used.first_reneed_tier, 'clear');
  assert.equal(used.same_context, 1, 'recall 的同会话标记原样保留作对照');
  assert.equal(used.first_used_at, BASE + 3 * DAY, '用上时间取用上那一刻');
  assert.equal(used.first_used_tier, 'ambiguous');
  assert.equal(used.used_same_context, 0);

  const dedupe = addFact(store);
  store.markFirstReneed(dedupe.id, { at: BASE, tier: 'miss', kind: 'dedupe' });
  assert.equal(store.markReneedUsed(dedupe.id, { at: BASE + 1, tier: 'clear' }), false);
  assert.equal(store.getFact(dedupe.id).reneed_kind, 'dedupe');
  assert.equal(store.getFact(dedupe.id).first_used_at, null);
});

test('markReneedUsed：非 same_context 用上覆盖 same_context 用上一次，之后不再覆盖', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  store.markFirstReneed(fact.id, { at: BASE + 3600, tier: 'clear', kind: 'recall', sameContext: true });

  // 第一次用上仍在同会话窗口内：照常记录，但不能作为 S0 主样本。
  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 2 * 3600, tier: 'clear', sameContext: true }),
    true,
  );
  assert.equal(store.getFact(fact.id).used_same_context, 1);
  assert.equal(store.getFact(fact.id).first_used_at, BASE + 2 * 3600);

  // 3 天后真正跨会话用上：覆盖一次。
  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 3 * DAY, tier: 'clear', sameContext: false }),
    true,
  );
  assert.equal(store.getFact(fact.id).used_same_context, 0);
  assert.equal(store.getFact(fact.id).first_used_at, BASE + 3 * DAY);

  // 已有非 same_context 用上：之后的用上（无论是否同会话）都不再覆盖。
  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 4 * DAY, tier: 'ambiguous', sameContext: false }),
    false,
  );
  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 5 * DAY, tier: 'clear', sameContext: true }),
    false,
  );
  const after = store.getFact(fact.id);
  assert.equal(after.first_used_at, BASE + 3 * DAY, '首次跨会话用上保持');
  assert.equal(after.first_used_tier, 'clear');
  assert.equal(after.used_same_context, 0);
  assert.equal(after.first_reneed_at, BASE + 3600, '覆盖 used 不影响 recall 样本');
  assert.equal(after.same_context, 1);
});

test('markReneedUsed：没有 recall 样本时也写 used 四列，legacy dedupe 不退回', (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  assert.equal(
    store.markReneedUsed(fact.id, { at: BASE + 60, tier: 'clear', sameContext: true }),
    true,
  );
  const row = store.getFact(fact.id);
  assert.equal(row.reneed_kind, 'used');
  assert.equal(row.first_reneed_at, null, 'used 不伪造 recall 样本');
  assert.equal(row.first_used_at, BASE + 60);
  assert.equal(row.used_same_context, 1);

  // correction 是不可被 used 改写的历史“漏”样本。
  const correction = addFact(store);
  store.markFirstReneed(correction.id, { at: BASE, tier: 'miss', kind: 'correction' });
  assert.equal(
    store.markReneedUsed(correction.id, { at: BASE + 60, tier: 'clear' }),
    false,
  );
  assert.equal(store.getFact(correction.id).reneed_kind, 'correction');
});

test('migrate：v8 库补 first_used_* 三列，旧行 NULL，重复打开幂等', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reneed-v8-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = Store.open(path);
  const fact = addFact(first);
  first.markFirstReneed(fact.id, { at: BASE + 10, tier: 'clear', kind: 'recall' });
  first.db.exec('DROP INDEX IF EXISTS ix_facts_used');
  first.db.exec('ALTER TABLE facts DROP COLUMN used_same_context');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_tier');
  first.db.exec('ALTER TABLE facts DROP COLUMN first_used_at');
  first.setMeta('schema_version', '8');
  first.close();

  for (let round = 0; round < 2; round += 1) {
    const store = Store.open(path);
    try {
      assert.equal(store.getMeta('schema_version'), '13', `第 ${round + 1} 次打开版本稳定`);
      const columns = store.db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name);
      for (const name of ['first_used_at', 'first_used_tier', 'used_same_context']) {
        assert.equal(columns.filter((column) => column === name).length, 1, `${name} 只加一次`);
      }
      const row = store.getFact(fact.id);
      assert.equal(row.first_reneed_at, BASE + 10, 'v8 的 recall 样本保留');
      assert.equal(row.same_context, 0);
      assert.equal(row.first_used_at, null, '旧行没有用上记录 → NULL');
      assert.equal(row.first_used_tier, null);
      assert.equal(row.used_same_context, null);
      assert.ok(
        store.db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_facts_used'")
          .get(),
        '迁移后应建用上索引',
      );
    } finally {
      store.close();
    }
  }
});

test('resolveObservedAt：优先原话时间，依次退回 episode 时间与 created_at', () => {
  assert.equal(
    resolveObservedAt({ fact: { observed_at: BASE, created_at: BASE - DAY } }),
    BASE,
  );
  assert.equal(
    resolveObservedAt({
      fact: { observed_at: null, created_at: BASE - DAY },
      episode: { observed_at: BASE - 3600, started_at: BASE - 7200 },
    }),
    BASE - 3600,
  );
  assert.equal(
    resolveObservedAt({
      fact: { created_at: BASE - DAY },
      episode: { started_at: BASE - 7200, created_at: BASE - 3 * DAY },
    }),
    BASE - 7200,
  );
  assert.equal(
    resolveObservedAt({ fact: { created_at: BASE - DAY }, episode: { created_at: BASE - 3 * DAY } }),
    BASE - 3 * DAY,
  );
  assert.equal(resolveObservedAt({ fact: { created_at: BASE - DAY } }), BASE - DAY);
  assert.equal(resolveObservedAt({ fact: {}, episode: {} }), null);
  assert.equal(resolveObservedAt(), null);
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
