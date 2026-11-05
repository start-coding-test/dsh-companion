/**
 * v0.4.9 V8-L1/L2：提醒到期索引与「唯一到期口径」。
 *
 * V8-L1（索引）：
 *   1. 新库只建表达式索引 ix_rm_due(status, max(...))，不再有裸列 ix_rm_fire；
 *   2. 旧库（v11 无 retry_at / v12 有 retry_at，两者都带 ix_rm_fire）打开时
 *      就地补建新索引并删除旧索引，重复打开幂等；
 *   3. EXPLAIN QUERY PLAN 断言 dueReminders 的查询命中 ix_rm_due。
 *
 * V8-L2（口径）：
 *   4. 到期时刻统一为 max(next_fire_at, retry_at)：store 的 SQL、导出的
 *      reminderDueAt（index.js 的 onAttempt 用它）对同一行给出同一答案；
 *   5. 改期（rescheduleReminder）清空 retry_at 等「上一次到点」残留，改期后
 *      按新时间到期，旧 retry_at 不再压过新时间；
 *   6. 绕过 store 的裸 SQL 改期由库级触发器兜底清空 retry_at；
 *   7. 失败退避仍只写 retry_at，退避未到不投递。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { apply as applyCordis } from '../src/index.js';
import {
  REMINDER_DUE_AT_SQL,
  Store,
  buildDueRemindersQuery,
  reminderDueAt,
} from '../src/memory/store.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const NOW = toEpochSeconds(TEST_NOW);
const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

/** 提醒索引名（reminders 表的普通索引）。 */
function reminderIndexes(store) {
  return store.db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'")
    .all();
}

/** 插入一条提醒，直接指定 next_fire_at / retry_at。 */
function insertReminder(store, title, { nextFireAt = null, retryAt = undefined } = {}) {
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nextFireAt,
    due_granularity: nextFireAt === null ? 'none' : 'exact',
    next_fire_at: nextFireAt,
    ...(retryAt === undefined ? {} : { retry_at: retryAt }),
  });
}

/** 用裸 SQL 改期/退避（模拟旧代码或手工维护）。 */
function rawSet(store, id, sql, value) {
  store.db.prepare(`UPDATE reminders SET ${sql} = ? WHERE id = ?`).run(value, id);
}

// ---------------------------------------------------------------- V8-L1 索引

test('V8-L1：新库只有表达式索引 ix_rm_due，旧的 ix_rm_fire 不再创建', () => {
  const temp = makeTempStore();
  try {
    const indexes = reminderIndexes(temp.store);
    const names = indexes.map((row) => row.name);
    assert.ok(names.includes('ix_rm_due'), `索引：${names.join(',')}`);
    assert.ok(!names.includes('ix_rm_fire'), '裸列索引不得再建');
    assert.ok(names.includes('ix_rm_done'), 'ix_rm_done 不受影响');

    const due = indexes.find((row) => row.name === 'ix_rm_due');
    const sql = String(due.sql).replace(/\s+/gu, ' ');
    assert.match(sql, /ON reminders\(status, max\(COALESCE\(next_fire_at, 0\), COALESCE\(retry_at, 0\)\)\)/u);
    assert.match(sql, /WHERE status IN \('pending','snoozed'\)/u, '保持 partial index');
  } finally {
    temp.cleanup();
  }
});

test('V8-L1：v11 旧库（无 retry_at、带 ix_rm_fire）打开时就地补建新索引', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v049-v11-'));
  const dbPath = join(dir, 'companion.db');
  // v11 的真实形态：没有 retry_at，有 delivery_attempts / occurrence_key。
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11');
    CREATE TABLE reminders (
      id                TEXT PRIMARY KEY,
      scope             TEXT NOT NULL DEFAULT 'main',
      kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
      title             TEXT NOT NULL,
      detail            TEXT,
      counterparty      TEXT,
      due_at            INTEGER,
      due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
      rrule             TEXT,
      next_fire_at      INTEGER,
      last_fire_key     TEXT,
      occurrence_key    TEXT,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
      closed_at         INTEGER,
      source_episode_id TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at        INTEGER
    );
    CREATE INDEX ix_rm_fire ON reminders(status, next_fire_at) WHERE status IN ('pending','snoozed');
    CREATE INDEX ix_rm_done ON reminders(closed_at) WHERE status IN ('done','cancelled');
  `);
  legacy
    .prepare(
      "INSERT INTO reminders (id, kind, title, status, next_fire_at) VALUES ('old-11', 'todo', '旧提醒', 'pending', 1000)",
    )
    .run();
  legacy.close();

  for (const pass of [1, 2]) {
    const store = Store.open(dbPath);
    try {
      const names = reminderIndexes(store).map((row) => row.name);
      assert.ok(names.includes('ix_rm_due'), `第 ${pass} 次打开应有 ix_rm_due：${names.join(',')}`);
      assert.ok(!names.includes('ix_rm_fire'), `第 ${pass} 次打开后旧索引必须已删除`);
      assert.equal(store.getMeta('schema_version'), '12', '不因索引迁移提升版本');
      const columns = store.db
        .prepare("PRAGMA table_info('reminders')")
        .all()
        .map((column) => column.name);
      assert.ok(columns.includes('retry_at'), 'v12 仍需补 retry_at');
      assert.deepEqual(
        store.dueReminders({ now: 1000 }).map((row) => row.id),
        ['old-11'],
        '旧行按 next_fire_at 正常到期',
      );
    } finally {
      store.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test('V8-L1：已是 v12 但还留着 ix_rm_fire 的库，重开时只换索引不动数据', () => {
  const temp = makeTempStore();
  const reminder = insertReminder(temp.store, '交房租', { nextFireAt: NOW - 60 });
  rawSet(temp.store, reminder.id, 'retry_at', NOW + 300);
  // 模拟 0.4.8 建出来的库：版本已是 12，但索引还是裸列的 ix_rm_fire。
  temp.store.db.exec(
    "CREATE INDEX ix_rm_fire ON reminders(status, next_fire_at) WHERE status IN ('pending','snoozed')",
  );
  temp.store.close();

  const reopened = Store.open(temp.dbPath);
  try {
    const names = reminderIndexes(reopened).map((row) => row.name);
    assert.ok(names.includes('ix_rm_due'));
    assert.ok(!names.includes('ix_rm_fire'));
    const row = reopened.getReminder(reminder.id);
    assert.equal(row.next_fire_at, NOW - 60, '迁移不得改写数据');
    assert.equal(row.retry_at, NOW + 300, '迁移不得清空已有的 retry_at');
    assert.equal(reopened.getMeta('schema_version'), '12');
  } finally {
    reopened.close();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test('V8-L1：EXPLAIN QUERY PLAN 命中 ix_rm_due（含 scope 过滤）', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    assert.equal(store.getMeta('schema_version'), '12');
    insertReminder(store, '到期项', { nextFireAt: NOW - 60 });

    for (const options of [{ now: NOW }, { now: NOW, scope: 'main' }]) {
      const { sql, args } = buildDueRemindersQuery(options);
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map((row) => String(row.detail));
      const text = plan.join(' | ');
      assert.match(text, /USING INDEX ix_rm_due/u, `计划：${text}`);
      assert.doesNotMatch(text, /SCAN reminders/u, `不得全表扫：${text}`);
      // SQLite 把表达式索引用到的条件渲染成 `<expr>`：status 等值 + 到期表达式范围。
      assert.match(plan[0], /ix_rm_due \(status=\? AND <expr><\?\)/u, `索引按表达式匹配：${plan[0]}`);
    }
    // 查询与索引共用同一表达式常量，杜漂移。
    assert.ok(buildDueRemindersQuery({ now: NOW }).sql.includes(REMINDER_DUE_AT_SQL));
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------------ V8-L2 唯一口径

test('V8-L2：reminderDueAt 与 SQL 的 max 口径逐行一致，边界同一', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const cases = [
      { title: '只有原定时间', next: NOW - 100, retry: null },
      { title: '只有退避', next: null, retry: NOW - 50 },
      { title: '退避晚于原定', next: NOW - 200, retry: NOW - 10 },
      { title: '退避早于原定（旧数据）', next: NOW - 20, retry: NOW - 500 },
      { title: '两者都没有', next: null, retry: null },
      { title: '都在未来', next: NOW + 100, retry: NOW + 200 },
    ];
    const rows = cases.map((item) => ({
      ...item,
      row: insertReminder(store, item.title, { nextFireAt: item.next, retryAt: item.retry }),
    }));

    const sqlDueAt = store.db.prepare(
      `SELECT ${REMINDER_DUE_AT_SQL} AS due_at FROM reminders WHERE id = ?`,
    );
    for (const item of rows) {
      const stored = store.getReminder(item.row.id);
      const expected = item.next === null && item.retry === null
        ? null
        : Math.max(item.next ?? 0, item.retry ?? 0);
      assert.equal(reminderDueAt(stored), expected, `${item.title}：reminderDueAt 口径`);
      const fromSql = sqlDueAt.get(item.row.id).due_at;
      if (expected === null) {
        assert.equal(store.getReminder(item.row.id).next_fire_at, null);
        assert.equal(store.getReminder(item.row.id).retry_at, null);
      } else {
        assert.equal(reminderDueAt(stored), Number(fromSql), `${item.title}：SQL 与 JS 同值`);
        // 调度（SQL）与投递守卫（reminderDueAt）对「是否已到期」结论一致。
        const atBoundary = store.dueReminders({ now: expected }).map((row) => row.id);
        const beforeBoundary = store.dueReminders({ now: expected - 1 }).map((row) => row.id);
        assert.ok(atBoundary.includes(item.row.id), `${item.title}：到期时刻当秒应到期`);
        assert.ok(!beforeBoundary.includes(item.row.id), `${item.title}：早一秒不得到期`);
      }
    }

    // 两个时间都空的行永不到期，也不会被 max 里 NULL 当 0 的语义误判成到期。
    const never = rows.find((item) => item.title === '两者都没有');
    assert.equal(reminderDueAt(store.getReminder(never.row.id)), null);
    assert.ok(
      !store.dueReminders({ now: NOW + 10_000, limit: 500 }).some((item) => item.id === never.row.id),
      '没有到期时间的行永不出现',
    );
  } finally {
    temp.cleanup();
  }
});

test('V8-L2：改期清空 retry_at 等残留，并按新时间到期', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertReminder(store, '改期一次', { nextFireAt: NOW - 600 });
    assert.equal(store.claimReminderDelivery(reminder.id, `${NOW - 600}@1`), true);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW }), true);
    let row = store.getReminder(reminder.id);
    const staleRetry = row.retry_at;
    assert.equal(staleRetry, NOW + 30);

    // 旧 retry_at 在未来：此刻不到期。
    assert.deepEqual(store.dueReminders({ now: NOW }), []);

    const moved = store.rescheduleReminder(reminder.id, {
      next_fire_at: NOW - 10,
      due_at: NOW - 10,
      status: 'snoozed',
    });
    assert.ok(moved, '改期应返回更新后的行');
    assert.equal(moved.next_fire_at, NOW - 10);
    assert.equal(moved.retry_at, null, '改期必须清空旧 retry_at');
    assert.equal(moved.occurrence_key, null, '改期开启新 occurrence');
    assert.equal(moved.last_fire_key, null);
    assert.equal(moved.delivery_attempts, 0, '退避预算重置');
    assert.equal(moved.closed_at, null);
    assert.equal(moved.status, 'snoozed');
    assert.equal(reminderDueAt(moved), NOW - 10, '到期口径只认新时间');

    // 新时间已过：立刻到期；旧 retry_at 不再压过新时间。
    assert.deepEqual(store.dueReminders({ now: NOW }).map((item) => item.id), [reminder.id]);
    assert.equal(store.dueReminders({ now: NOW - 11 }).length, 0);

    // 改到未来：同样按新时间，旧 retry_at 不能让它提前到期。
    const later = store.rescheduleReminder(reminder.id, { next_fire_at: NOW + 600 });
    assert.equal(later.retry_at, null);
    assert.deepEqual(store.dueReminders({ now: NOW }), []);
    assert.deepEqual(store.dueReminders({ now: NOW + 600 }).map((item) => item.id), [reminder.id]);
  } finally {
    temp.cleanup();
  }
});

test('V8-L2：rescheduleReminder 参数校验与不可改期状态', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertReminder(store, '校验', { nextFireAt: NOW + 100 });
    assert.throws(
      () => store.rescheduleReminder(reminder.id, {}),
      (error) => error instanceof TypeError && /requires next_fire_at/u.test(error.message),
    );
    assert.throws(
      () => store.rescheduleReminder(reminder.id, { next_fire_at: NOW, status: 'fired' }),
      (error) => error instanceof TypeError && /pending or snoozed/u.test(error.message),
    );
    assert.equal(store.rescheduleReminder('rm_missing', { next_fire_at: NOW }), null);

    // 已结束（fired）的提醒不再改期，避免复活旧 occurrence。
    store.db
      .prepare("UPDATE reminders SET status = 'fired', closed_at = ? WHERE id = ?")
      .run(NOW, reminder.id);
    assert.equal(store.rescheduleReminder(reminder.id, { next_fire_at: NOW }), null);
    assert.equal(store.getReminder(reminder.id).status, 'fired');
  } finally {
    temp.cleanup();
  }
});

test('V8-L2：裸 SQL 改期由触发器兜底清空 retry_at，只写 retry_at 不触发', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertReminder(store, '手工改期', { nextFireAt: NOW - 600 });
    rawSet(store, reminder.id, 'retry_at', NOW + 999);
    assert.equal(store.getReminder(reminder.id).retry_at, NOW + 999);

    // 只改 next_fire_at：残留的 retry_at 必须被库级不变量清掉。
    rawSet(store, reminder.id, 'next_fire_at', NOW - 30);
    let row = store.getReminder(reminder.id);
    assert.equal(row.next_fire_at, NOW - 30);
    assert.equal(row.retry_at, null, '触发器清空旧 retry_at');
    assert.deepEqual(store.dueReminders({ now: NOW }).map((item) => item.id), [reminder.id]);

    // 反过来：只写 retry_at（失败退避）不得影响 next_fire_at，也不触发清空。
    rawSet(store, reminder.id, 'retry_at', NOW + 120);
    row = store.getReminder(reminder.id);
    assert.equal(row.next_fire_at, NOW - 30, '写入退避不得改写原定时间');
    assert.equal(row.retry_at, NOW + 120, '退避值必须保留');
    assert.deepEqual(store.dueReminders({ now: NOW }), [], '退避未到不到期');

    // next_fire_at 改成同值：不算改期，不动 retry_at。
    rawSet(store, reminder.id, 'next_fire_at', NOW - 30);
    assert.equal(store.getReminder(reminder.id).retry_at, NOW + 120);
  } finally {
    temp.cleanup();
  }
});

test('V8-L2：失败退避仍只写 retry_at，退避到期才允许重试', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertReminder(store, '吃药', { nextFireAt: NOW - 60 });
    assert.equal(store.claimReminderDelivery(reminder.id, `${NOW - 60}@0`), true);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW }), true);
    const row = store.getReminder(reminder.id);
    assert.equal(row.next_fire_at, NOW - 60, '失败不改原定时间');
    assert.equal(row.retry_at, NOW + 30, '失败写退避时刻');
    assert.equal(reminderDueAt(row), NOW + 30, '到期口径取 max');

    assert.deepEqual(store.dueReminders({ now: NOW }), []);
    assert.deepEqual(store.dueReminders({ now: NOW + 29 }), []);
    assert.deepEqual(store.dueReminders({ now: NOW + 30 }).map((item) => item.id), [reminder.id]);
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------- e2e：改期后正常投递

function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
  ctx.tools = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return ctx;
}

function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

test('V8-L2 e2e：旧 retry_at 在未来的提醒，改期到已到点后下一个 tick 投递', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = insertReminder(temp.store, '交房租', { nextFireAt: NOW - 600 });
    // 残留一个很远的 retry_at：改期前不可能到期。
    temp.store.db.prepare('UPDATE reminders SET retry_at = ? WHERE id = ?').run(NOW + 100_000, reminder.id);

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).length, 0, '旧 retry_at 未到：不得投递');
    assert.equal(temp.store.getReminder(reminder.id).status, 'pending');

    // 改期到「已经到点」：清空 retry_at 后应立刻在下一个 tick 投递。
    const moved = temp.store.rescheduleReminder(reminder.id, { next_fire_at: NOW - 10 });
    assert.equal(moved.retry_at, null);
    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);

    const texts = promptTexts(ctx);
    assert.deepEqual(texts, ['[提醒] 交房租']);
    const row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.equal(row.next_fire_at, NOW - 10, '按新时间投递');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
