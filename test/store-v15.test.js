/**
 * v0.4.13 store v15：迁移 + 新 API。
 *
 * 覆盖任务卡的每一块：
 *   1. 从 test/fixtures/schema-v14.sql 的真实 v14 库迁移到 v15：版本号、facts
 *      计数回填、kind 枚举重建（显式保留 rowid，fts_facts 旧行仍可命中）、
 *      fact_vectors 不被 DROP facts 级联清空、memory_events 保留 id 且追加
 *      govern/EDIT/scrub、reminders 两列、token_usage 表；
 *   2. token_usage 入账/按天聚合/窗口求和与参数校验；
 *   3. facts injected_count / used_count / unused_streak 的批量语义；
 *   4. reminders 过期通知与系列推进；
 *   5. B1：空库也写 episode_scrub_v13 标记，但不写审计事件；
 *   6. 重复打开幂等（used_count 不被二次回填、不重复写 scrub 事件）。
 *
 * 注意：fixture 是 `sqlite3 .schema` 的完整导出，含 FTS5 的 shadow 表（SQLite
 * 保留名，直接 exec 会报 `object name reserved for internal use`）。这里按行
 * 过滤掉 shadow 表 DDL，让 `CREATE VIRTUAL TABLE` 自己建。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { toBigrams } from '../src/memory/bigram.js';
import {
  EVENT_ACTIONS,
  FACT_KINDS,
  SCHEMA_VERSION,
  Store,
  TOKEN_USAGE_SOURCES,
} from '../src/memory/store.js';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/schema-v14.sql', import.meta.url));
const LEGACY_NOW = 1_700_000_000;
const SCRUB_MARKER = 'episode_scrub_v13';

/** @type {Map<string, (() => void)[]>} */
const STORE_CLOSERS = new Map();

/**
 * 临时目录 + 关闭钩子：Windows 上 WAL 文件未释放时 rmSync 会 EPERM，所以先关
 * store 再删目录（node:test 的 after 按注册顺序执行，只能由 tempDir 统一收口）。
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v15-'));
  STORE_CLOSERS.set(dir, []);
  if (t && typeof t.after === 'function') {
    t.after(() => {
      const closers = STORE_CLOSERS.get(dir) ?? [];
      STORE_CLOSERS.delete(dir);
      for (const close of closers.reverse()) {
        try {
          close();
        } catch {
          // 测试体已手动关闭
        }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
  }
  return dir;
}

/** 登记在 tempDir 清理前关闭的 store。 */
function track(dir, store) {
  STORE_CLOSERS.get(dir)?.push(() => store.close());
  return store;
}

/** fixture 里 FTS5 shadow 表不能手动建（保留名）。 */
function fixtureDdl() {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => !/^CREATE TABLE 'fts_(facts|episodes)_/.test(line))
    .join('\n');
}

/**
 * 建一个真实 v14 库并塞样例行。
 * @param {string} dir
 * @returns {string} db 路径
 */
function makeV14Db(dir) {
  const dbPath = join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(fixtureDdl());
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '14')").run();
    db.prepare(
      `INSERT INTO facts (
         id, scope, kind, subject_text, predicate, object_text, statement,
         source_kind, salience, observed_at, strength_days, last_reinforced_at,
         recall_count, status
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'fact-v14',
      'main',
      'project',
      '用户',
      '偏好',
      '黑咖啡',
      '用户喜欢喝黑咖啡',
      'turn',
      'normal',
      LEGACY_NOW,
      30,
      LEGACY_NOW,
      7,
      'active',
    );
    db.prepare(
      "INSERT INTO fts_facts (rowid, txt) SELECT rowid, ? FROM facts WHERE id = 'fact-v14'",
    ).run(toBigrams('用户喜欢喝黑咖啡'));
    // fact_vectors 是 facts 的子表：迁移 DROP facts 时若 FK 没关会被级联清空。
    db.prepare(
      `INSERT INTO fact_vectors (fact_id, dim, vec, embedder_id, updated_at)
       VALUES (?,?,?,?,?)`,
    ).run('fact-v14', 2, Buffer.from(new Float32Array([0.5, 0.25]).buffer), 'hash:2', LEGACY_NOW);
    db.prepare(
      `INSERT INTO episodes (
         id, scope, session_id, started_at, ended_at, title, summary, salience,
         strength_days, last_reinforced_at, status
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'ep-v14',
      'main',
      'sess-v14',
      LEGACY_NOW,
      LEGACY_NOW,
      '日常',
      '普通叙事，没有凭据值',
      'normal',
      30,
      LEGACY_NOW,
      'active',
    );
    db.prepare(
      "INSERT INTO fts_episodes (rowid, txt) SELECT rowid, ? FROM episodes WHERE id = 'ep-v14'",
    ).run(toBigrams('日常 普通叙事'));
    // 提醒：一条已过期（A5 通知）、一条 fired（A4 推进）。
    db.prepare(
      `INSERT INTO reminders (
         id, scope, kind, title, due_at, next_fire_at, status, delivery_attempts
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('rm-expired', 'main', 'schedule', '交房租', LEGACY_NOW - 3600, LEGACY_NOW - 3600, 'expired', 0);
    db.prepare(
      `INSERT INTO reminders (
         id, scope, kind, title, due_at, next_fire_at, retry_at, status,
         delivery_attempts, closed_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run('rm-series', 'main', 'repeat', '每日站会', LEGACY_NOW, LEGACY_NOW, LEGACY_NOW + 60, 'fired', 2, LEGACY_NOW + 120);
    // memory_events：显式 id 1 / 3（留空洞），验证重建后 id 与自增序列都保留。
    db.prepare(
      `INSERT INTO memory_events (id, at, action, table_name, row_id, actor, reason)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(1, LEGACY_NOW, 'ADD', 'facts', 'fact-v14', 'consolidator', 'seed');
    db.prepare(
      `INSERT INTO memory_events (id, at, action, table_name, row_id, actor, reason)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(3, LEGACY_NOW + 1, 'EXPORT', 'facts', 'fact-v14', 'user', 'seed-export');
  } finally {
    db.close();
  }
  return dbPath;
}

function makeFact(store, overrides = {}) {
  return store.insertFact({
    kind: 'other',
    subject_text: '用户',
    predicate: '偏好',
    statement: '默认事实',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: LEGACY_NOW,
    last_reinforced_at: LEGACY_NOW,
    ...overrides,
  });
}

function columnsOf(store, table) {
  return store.db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

// ------------------------------------------------------------ v14 迁移

test('v14 fixture → v15：版本、facts 计数回填、向量与 FTS rowid 都保留', (t) => {
  const dir = tempDir(t);
  const dbPath = makeV14Db(dir);
  const store = Store.open(dbPath);
  track(dir, store);

  assert.equal(SCHEMA_VERSION, '15');
  assert.equal(store.getMeta('schema_version'), '15');

  const fact = store.getFact('fact-v14');
  assert.equal(fact.recall_count, 7, 'v14 遗留列保留');
  assert.equal(fact.used_count, 7, 'used_count 由 recall_count 回填');
  assert.equal(fact.injected_count, 0);
  assert.equal(fact.unused_streak, 0);
  assert.equal(fact.statement, '用户喜欢喝黑咖啡');

  // DROP facts 若在 FK ON 下执行会级联删掉 fact_vectors。
  const vector = store.db.prepare('SELECT * FROM fact_vectors WHERE fact_id = ?').get('fact-v14');
  assert.ok(vector, 'fact_vectors 未被级联删除');
  assert.equal(vector.embedder_id, 'hash:2');

  // fts_facts 按 facts.rowid 关联；重建表必须显式保留 rowid。
  const hits = store.searchBigram('黑咖啡');
  assert.ok(hits.some((row) => row.type === 'fact' && row.id === 'fact-v14'), '旧行仍能全文命中');

  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('v14 fixture → v15：memory_events 保留 id，新 action 可用，append-only 不变', (t) => {
  const dir = tempDir(t);
  const store = Store.open(makeV14Db(dir));
  track(dir, store);

  const ids = store.db.prepare('SELECT id FROM memory_events ORDER BY id ASC').all().map((r) => r.id);
  assert.deepEqual(ids.slice(0, 2), [1, 3], '重建显式保留 rowid/id 与空洞');
  // 升级时 episodes 有行 → scrub 事件占 id 4（不重新编号旧行）。
  assert.deepEqual(ids.slice(2), [4]);

  const governId = store.appendEvent({
    action: 'govern',
    table_name: 'facts',
    row_id: 'fact-v14',
    actor: 'migrator',
    reason: 'govern-test',
  });
  assert.equal(governId, 5, 'AUTOINCREMENT 从旧 max 续上');
  assert.equal(
    store.appendEvent({ action: 'EDIT', table_name: 'facts', row_id: 'fact-v14', actor: 'user' }),
    6,
  );
  assert.equal(
    store.appendEvent({ action: 'scrub', table_name: 'episodes', row_id: 'ep-v14', actor: 'migrator' }),
    7,
  );
  assert.throws(() => store.appendEvent({ action: 'NOPE', table_name: 'facts', actor: 'user' }), TypeError);

  assert.throws(
    () => store.db.prepare("UPDATE memory_events SET reason = 'x' WHERE id = 1").run(),
    /append-only/,
  );
  assert.throws(() => store.db.prepare('DELETE FROM memory_events WHERE id = 1').run(), /append-only/);
  const index = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_ev_row'")
    .get();
  assert.ok(index, 'ix_ev_row 重建');
});

test('v14 fixture → v15：facts.kind 新枚举可用，旧值保留', (t) => {
  const dir = tempDir(t);
  const store = Store.open(makeV14Db(dir));
  track(dir, store);

  assert.deepEqual([...FACT_KINDS], [
    'identity', 'relation', 'preference', 'project', 'knowledge', 'lifestyle', 'mood', 'other',
  ]);
  assert.equal(store.getFact('fact-v14').kind, 'project');

  const lifestyle = makeFact(store, { kind: 'lifestyle', statement: '用户每天 7 点起床' });
  assert.equal(lifestyle.kind, 'lifestyle');
  const mood = makeFact(store, { kind: 'mood', statement: '今天有点低落' });
  assert.equal(mood.kind, 'mood');

  assert.throws(
    () => makeFact(store, { kind: 'hobby', statement: '不在枚举内' }),
    /invalid facts\.kind: hobby/,
  );
  assert.throws(() => store.updateFact('fact-v14', { kind: 'hobby' }), /invalid facts\.kind/);
  assert.equal(store.updateFact('fact-v14', { kind: 'lifestyle' }).kind, 'lifestyle');

  // 重建后 4 个 facts 索引仍在。
  for (const name of ['ix_facts_key', 'ix_facts_scope', 'ix_facts_decay', 'ix_facts_purge']) {
    assert.ok(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
      `${name} 重建`,
    );
  }
});

test('v14 fixture → v15：reminders 两列 + 过期通知/系列推进', (t) => {
  const dir = tempDir(t);
  const store = Store.open(makeV14Db(dir));
  track(dir, store);

  const columns = columnsOf(store, 'reminders');
  assert.ok(columns.includes('expired_notified_at'));
  assert.ok(columns.includes('series_index'));
  assert.equal(store.getReminder('rm-expired').series_index, 0, '旧行默认 0');

  const expired = store.listUnnotifiedExpired('main');
  assert.deepEqual(expired.map((row) => row.id), ['rm-expired']);
  assert.deepEqual(Object.keys(expired[0]).sort(), ['due_at', 'id', 'kind', 'rrule', 'title']);
  assert.deepEqual(store.listUnnotifiedExpired('other'), []);

  assert.deepEqual(store.markExpiredNotified(['rm-expired', 'missing']), { updated: 1 });
  assert.deepEqual(store.markExpiredNotified(['rm-expired']), { updated: 0 }, '幂等');
  assert.equal(store.listUnnotifiedExpired('main').length, 0);
  assert.equal(typeof store.getReminder('rm-expired').expired_notified_at, 'number');

  const advanced = store.advanceReminderOccurrence('rm-series', {
    nextFireAt: LEGACY_NOW + 86_400,
    occurrenceKey: 'occ-next',
    seriesIndex: 3,
  });
  assert.deepEqual(advanced, { ok: true });
  const row = store.getReminder('rm-series');
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 0);
  assert.equal(row.retry_at, null);
  assert.equal(row.closed_at, null);
  assert.equal(row.next_fire_at, LEGACY_NOW + 86_400);
  assert.equal(row.occurrence_key, 'occ-next');
  assert.equal(row.series_index, 3);

  assert.deepEqual(store.advanceReminderOccurrence('missing', { nextFireAt: 1 }), { ok: false });
  assert.throws(() => store.advanceReminderOccurrence('rm-series', {}), /requires nextFireAt/);
  assert.throws(
    () => store.advanceReminderOccurrence('rm-series', { nextFireAt: 1, seriesIndex: -1 }),
    TypeError,
  );

  const inserted = store.insertReminder({
    kind: 'repeat',
    title: '系列',
    next_fire_at: LEGACY_NOW,
    series_index: 2,
    occurrence_key: 'occ-inserted',
  });
  assert.equal(inserted.series_index, 2);
  assert.equal(inserted.occurrence_key, 'occ-inserted');
});

test('v14 fixture → v15：token_usage 表就位且可入账', (t) => {
  const dir = tempDir(t);
  const store = Store.open(makeV14Db(dir));
  track(dir, store);

  assert.ok(columnsOf(store, 'token_usage').includes('day_key'));
  const { id } = store.recordTokenUsage({
    at: LEGACY_NOW * 1000,
    dayKey: '2023-11-14',
    source: 'main',
    input: 10,
    output: 5,
    cacheHit: 2,
  });
  assert.equal(typeof id, 'number');
  const agg = store.aggregateTokenUsage('2023-11-14');
  assert.equal(agg.total.total, 15);
  assert.equal(agg.bySource.length, 1);
});

test('v14 fixture → v15：重复打开幂等，不二次回填、不重复 scrub', (t) => {
  const dir = tempDir(t);
  const dbPath = makeV14Db(dir);
  const first = Store.open(dbPath);
  const eventsAfterFirst = first.listEvents({ limit: 100 }).length;
  const scrubEvents = first
    .listEvents({ action: 'scrub', limit: 100 })
    .filter((event) => event.table_name === 'episodes').length;
  assert.equal(scrubEvents, 1, '有 episode 行时写一次 scrub 事件');
  assert.equal(first.getFact('fact-v14').used_count, 7);
  first.close();

  const second = Store.open(dbPath);
  track(dir, second);
  assert.equal(second.getMeta('schema_version'), '15');
  assert.equal(second.getFact('fact-v14').used_count, 7, 'used_count 不被二次回填');
  assert.equal(second.listEvents({ limit: 100 }).length, eventsAfterFirst, '不重复写 scrub 事件');
  assert.equal(second.searchBigram('黑咖啡').length, 1);
});

// ------------------------------------------------------------ token_usage

test('token_usage：recordTokenUsage 校验与缺省 at', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  assert.deepEqual([...TOKEN_USAGE_SOURCES], [
    'main', 'consolidate', 'smalltalk', 'embedding', 'task', 'thread',
  ]);

  const before = Date.now();
  const { id } = store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main' });
  const row = store.db.prepare('SELECT * FROM token_usage WHERE id = ?').get(id);
  assert.ok(Number(row.at) >= before && Number(row.at) <= Date.now(), 'at 缺省取当前毫秒');
  assert.equal(row.input_tokens, 0);
  assert.equal(row.output_tokens, 0);
  assert.equal(row.cache_hit_tokens, 0);
  assert.equal(row.peak, null);
  assert.equal(row.request_id, null);
  assert.equal(row.scope, null);

  const full = store.recordTokenUsage({
    at: 1_700_000_000_000,
    dayKey: '2023-11-14',
    source: 'task',
    scope: 'main',
    input: 100,
    output: 20,
    cacheHit: 30,
    peak: 'offpeak',
    requestId: 'req-1',
  });
  const fullRow = store.db.prepare('SELECT * FROM token_usage WHERE id = ?').get(full.id);
  assert.equal(fullRow.peak, 'offpeak');
  assert.equal(fullRow.request_id, 'req-1');
  assert.equal(fullRow.cache_hit_tokens, 30);

  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'cron' }), /invalid token_usage\.source/);
  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main', input: -1 }), TypeError);
  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main', output: 1.5 }), TypeError);
  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main', cacheHit: '3' }), TypeError);
  assert.throws(() => store.recordTokenUsage({ dayKey: '13/11/2026', source: 'main' }), /day_key/);
  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main', peak: 'day' }), /invalid token_usage\.peak/);
  assert.throws(() => store.recordTokenUsage({ dayKey: '2026-11-13', source: 'main', at: -5 }), TypeError);
  assert.throws(() => store.recordTokenUsage({ dayKey: '', source: 'main' }), TypeError);
});

test('token_usage：aggregateTokenUsage 形状、share、排序与空日', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  assert.deepEqual(store.aggregateTokenUsage('2026-11-13'), {
    dayKey: '2026-11-13',
    total: { input: 0, output: 0, cacheHit: 0, total: 0 },
    bySource: [],
  });

  const day = '2026-11-13';
  store.recordTokenUsage({ dayKey: day, source: 'main', input: 100, output: 50, cacheHit: 20 });
  store.recordTokenUsage({ dayKey: day, source: 'main', input: 10, output: 0, cacheHit: 5 });
  store.recordTokenUsage({ dayKey: day, source: 'task', input: 30, output: 10 });
  store.recordTokenUsage({ dayKey: day, source: 'embedding', input: 4, output: 0 });
  store.recordTokenUsage({ dayKey: '2026-11-12', source: 'main', input: 999, output: 999 });

  const agg = store.aggregateTokenUsage(day);
  assert.deepEqual(agg.total, { input: 144, output: 60, cacheHit: 25, total: 204 });
  assert.deepEqual(agg.bySource.map((row) => row.source), ['main', 'task', 'embedding']);
  assert.deepEqual(agg.bySource[0], {
    source: 'main',
    input: 110,
    output: 50,
    cacheHit: 25,
    total: 160,
    share: 0.7843,
  });
  assert.deepEqual(agg.bySource[1], {
    source: 'task', input: 30, output: 10, cacheHit: 0, total: 40, share: 0.1961,
  });
  assert.equal(agg.bySource[2].share, 0.0196);
  const sum = agg.bySource.reduce((acc, row) => acc + row.total, 0);
  assert.equal(sum, agg.total.total);
  for (const row of agg.bySource) {
    assert.ok(row.share >= 0 && row.share <= 1);
  }

  // 有行但全 0：share 取 0，不做 0/0。
  store.recordTokenUsage({ dayKey: '2026-11-11', source: 'thread' });
  const zeros = store.aggregateTokenUsage('2026-11-11');
  assert.equal(zeros.total.total, 0);
  assert.equal(zeros.bySource.length, 1);
  assert.equal(zeros.bySource[0].share, 0);

  assert.throws(() => store.aggregateTokenUsage(''), TypeError);
});

test('token_usage：sumTokenUsageSince 按毫秒窗口求和', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  const base = 1_700_000_000_000;
  store.recordTokenUsage({ at: base - 1000, dayKey: '2023-11-13', source: 'main', input: 1, output: 1 });
  store.recordTokenUsage({ at: base, dayKey: '2023-11-14', source: 'main', input: 10, output: 5, cacheHit: 2 });
  store.recordTokenUsage({ at: base + 3600_000, dayKey: '2023-11-14', source: 'task', input: 20, output: 7 });

  assert.deepEqual(store.sumTokenUsageSince(base), {
    input: 30, output: 12, cacheHit: 2, total: 42,
  });
  assert.deepEqual(store.sumTokenUsageSince(base + 3600_000), {
    input: 20, output: 7, cacheHit: 0, total: 27,
  });
  assert.deepEqual(store.sumTokenUsageSince(base + 1), {
    input: 20, output: 7, cacheHit: 0, total: 27,
  });
  assert.deepEqual(store.sumTokenUsageSince(0), {
    input: 31, output: 13, cacheHit: 2, total: 44,
  });
  assert.throws(() => store.sumTokenUsageSince(-1), TypeError);
  assert.throws(() => store.sumTokenUsageSince('0'), TypeError);
});

// --------------------------------------------------------- facts counters

test('facts：bumpFactInjected / markFactsUsed 批量、过滤、跳过未知 id', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  const a = makeFact(store, { statement: 'A' });
  const b = makeFact(store, { statement: 'B' });
  const dormant = makeFact(store, { statement: 'C', status: 'dormant' });
  const deleted = makeFact(store, { statement: 'D' });
  store.deleteFact(deleted.id);

  assert.deepEqual(store.bumpFactInjected([]), { updated: 0 });
  assert.deepEqual(store.bumpFactInjected([a.id, b.id, a.id, 'missing', dormant.id, deleted.id]), {
    updated: 2,
  });
  assert.equal(store.getFact(a.id).injected_count, 1, '重复 id 只累加一次');
  assert.equal(store.getFact(a.id).unused_streak, 1);
  assert.equal(store.getFact(b.id).injected_count, 1);
  assert.equal(store.getFact(dormant.id).injected_count, 0, '只作用于 active');
  assert.equal(store.getFact(deleted.id).injected_count, 0, '只作用于未删除');

  store.bumpFactInjected([a.id]);
  assert.equal(store.getFact(a.id).injected_count, 2);
  assert.equal(store.getFact(a.id).unused_streak, 2);

  assert.deepEqual(store.markFactsUsed([a.id, 'missing']), { updated: 1 });
  assert.equal(store.getFact(a.id).used_count, 1);
  assert.equal(store.getFact(a.id).unused_streak, 0, '用上后清零连击');
  assert.equal(store.getFact(a.id).recall_count, 0, '新 API 不写 v14 遗留列');
  assert.deepEqual(store.markFactsUsed([]), { updated: 0 });

  // 时间参数接受秒/Date，非法值抛 TypeError；空数组也不放过非法时间。
  assert.deepEqual(store.markFactsUsed([b.id], LEGACY_NOW), { updated: 1 });
  assert.deepEqual(store.markFactsUsed([b.id], new Date(LEGACY_NOW * 1000)), { updated: 1 });
  assert.throws(() => store.markFactsUsed([], 'bad'), TypeError);
  assert.throws(() => store.bumpFactInjected('not-array'), TypeError);
});

// ------------------------------------------------------------- reminders

test('reminders：listUnnotifiedExpired 只取未通知的 expired，mark 幂等', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  const e1 = store.insertReminder({ kind: 'schedule', title: '早的', due_at: LEGACY_NOW - 100, status: 'expired' });
  const e2 = store.insertReminder({ kind: 'todo', title: '晚的', due_at: LEGACY_NOW, status: 'expired' });
  store.insertReminder({ kind: 'todo', title: '待办', due_at: LEGACY_NOW, status: 'pending' });
  store.insertReminder({ kind: 'todo', title: '别的 scope', due_at: LEGACY_NOW, status: 'expired', scope: 'other' });
  const removed = store.insertReminder({ kind: 'todo', title: '已删', due_at: LEGACY_NOW, status: 'expired' });
  store.forgetReminder(removed.id);

  const rows = store.listUnnotifiedExpired('main');
  assert.deepEqual(rows.map((row) => row.id), [e1.id, e2.id], '按 due_at 升序');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['due_at', 'id', 'kind', 'rrule', 'title']);

  assert.deepEqual(store.markExpiredNotified([e1.id, 'missing']), { updated: 1 });
  assert.deepEqual(store.markExpiredNotified([e1.id]), { updated: 0 });
  assert.deepEqual(store.listUnnotifiedExpired('main').map((row) => row.id), [e2.id]);
  assert.equal(typeof store.getReminder(e1.id).expired_notified_at, 'number');
  assert.deepEqual(store.markExpiredNotified([e2.id], LEGACY_NOW), { updated: 1 });
  assert.equal(store.getReminder(e2.id).expired_notified_at, LEGACY_NOW);
  assert.deepEqual(store.markExpiredNotified([], LEGACY_NOW), { updated: 0 });
  assert.throws(() => store.listUnnotifiedExpired(''), TypeError);
});

// ------------------------------------------------------------------ B1

test('B1：新建空库也写 episode_scrub_v13 标记，但不写 scrub 事件', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  const marker = store.getMeta(SCRUB_MARKER);
  assert.ok(marker !== null, '空库也写标记');
  assert.ok(Number(marker) > 0, '标记值是秒级时间戳');
  assert.equal(store.listEvents({ action: 'scrub', limit: 10 }).length, 0, '空库不写审计事件');
  assert.equal(store.stats().token_usage, 0);
});

// -------------------------------------------------------------- 白名单

test('导出的枚举白名单与库内 CHECK 一致', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  track(dir, store);

  for (const action of ['govern', 'EDIT', 'scrub']) {
    assert.ok(EVENT_ACTIONS.has(action), `EVENT_ACTIONS 含 ${action}`);
  }
  for (const kind of ['lifestyle', 'mood']) {
    assert.ok(FACT_KINDS.includes(kind), `FACT_KINDS 含 ${kind}`);
  }
  assert.equal(FACT_KINDS.length, 8);
});
