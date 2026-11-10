/**
 * V5-L2（schema v12）：提醒失败退避只写 retry_at，next_fire_at 保持原定时间。
 *
 * 覆盖：
 *   1. store 语义：失败两次后 next_fire_at 不变、retry_at 依次 +30s/+60s，
 *      dueReminders 在 retry_at 之前不到期；
 *   2. 成功投递清空 retry_at；attempts 达上限置 expired 时同样清空；
 *   3. dueReminders 的到期判断与排序都按 COALESCE(retry_at, next_fire_at)；
 *   4. v11 → v12 迁移：旧行 retry_at 为 NULL，dueReminders 回退到 next_fire_at，
 *      旧行仍可正常 claim/投递。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/memory/store.js';
import { TEST_NOW, makeTempStore, toEpochSeconds } from './e2e/helpers.js';

const NOW = toEpochSeconds(TEST_NOW);
const ORIGINAL_FIRE = NOW - 60;

/** 插入一条已到期的普通提醒（手动指定原定到点时间）。 */
function insertDue(store, title, nextFireAt = ORIGINAL_FIRE) {
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nextFireAt,
    due_granularity: 'exact',
    next_fire_at: nextFireAt,
  });
}

test('V5-L2 store：失败退避写 retry_at，next_fire_at 保持原定时间', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertDue(store, '交房租');
    assert.equal(store.getReminder(reminder.id).retry_at, null, '新行 retry_at 为 NULL');

    // 第一次失败：retry_at = now + 30s，原定时间不动。
    assert.equal(store.claimReminderDelivery(reminder.id, `${ORIGINAL_FIRE}@first`), true);
    assert.equal(store.getReminder(reminder.id).delivery_attempts, 1);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW }), true);
    let row = store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.next_fire_at, ORIGINAL_FIRE, '失败不得改写原定到点时间');
    assert.equal(row.retry_at, NOW + 30, '第 1 次失败退避 30s');

    // 退避未到：dueReminders 不得提前到期。
    assert.deepEqual(store.dueReminders({ now: NOW }), []);
    assert.deepEqual(store.dueReminders({ now: NOW + 29 }), []);
    assert.deepEqual(
      store.dueReminders({ now: NOW + 30 }).map((item) => item.id),
      [reminder.id],
      'retry_at 到期后才允许重试',
    );

    // 第二次失败：retry_at 变成 now + 30 + 60，next_fire_at 仍然不动。
    assert.equal(store.claimReminderDelivery(reminder.id, `${ORIGINAL_FIRE}@${NOW + 30}`), true);
    assert.equal(store.getReminder(reminder.id).delivery_attempts, 2);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW + 30 }), true);
    row = store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.next_fire_at, ORIGINAL_FIRE, '第二次失败仍不改原定时间');
    assert.equal(row.retry_at, NOW + 90, '第 2 次失败退避 60s');
    assert.deepEqual(store.dueReminders({ now: NOW + 89 }), []);
    assert.equal(store.dueReminders({ now: NOW + 90 }).length, 1);

    // 同一 fireKey 的重复 claim 不重复累加 attempts（同 tick 两次 flush）。
    assert.equal(store.claimReminderDelivery(reminder.id, `${ORIGINAL_FIRE}@${NOW + 90}`), true);
    assert.equal(store.getReminder(reminder.id).delivery_attempts, 3);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW + 90 }), true);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW + 90 }), false);
    row = store.getReminder(reminder.id);
    assert.equal(row.status, 'expired', '第 3 次失败直接过期');
    assert.equal(row.next_fire_at, ORIGINAL_FIRE, '过期也不改原定时间');
    assert.equal(row.retry_at, null, 'expired 不残留 retry_at');
    assert.equal(row.delivery_attempts, 0);
  } finally {
    temp.cleanup();
  }
});

test('V5-L2 store：成功投递清空 retry_at，原定时间保留', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const reminder = insertDue(store, '吃药');
    assert.equal(store.claimReminderDelivery(reminder.id, `${ORIGINAL_FIRE}@a`), true);
    assert.equal(store.markReminderDeliveryFailed(reminder.id, { now: NOW }), true);
    assert.equal(store.getReminder(reminder.id).retry_at, NOW + 30);

    assert.equal(store.claimReminderDelivery(reminder.id, `${ORIGINAL_FIRE}@${NOW + 30}`), true);
    assert.equal(store.markReminderDelivered(reminder.id), true);
    const fired = store.getReminder(reminder.id);
    assert.equal(fired.status, 'fired');
    assert.equal(fired.retry_at, null, '成功后必须清空 retry_at');
    assert.equal(fired.next_fire_at, ORIGINAL_FIRE);
    assert.equal(fired.occurrence_key, null);
    assert.equal(fired.delivery_attempts, 0);

    // attempt 达上限后置 expired 的分支同样清空 retry_at。
    insertDue(store, '复查');
    const second = store.insertReminder({
      kind: 'todo',
      title: '复查2',
      next_fire_at: ORIGINAL_FIRE,
      retry_at: NOW + 120,
      status: 'delivering',
      // insertReminder 不直接写 attempts；用 SQL 模拟崩溃前已耗尽的尝试。
    });
    store.db
      .prepare('UPDATE reminders SET delivery_attempts = 3 WHERE id = ?')
      .run(second.id);
    assert.equal(store.markReminderDeliveryFailed(second.id, { now: NOW }), true);
    const expired = store.getReminder(second.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.retry_at, null, 'expired 分支清空 retry_at');
    assert.equal(expired.next_fire_at, ORIGINAL_FIRE);
  } finally {
    temp.cleanup();
  }
});

test('V5-L2 store：dueReminders 按 COALESCE(retry_at, next_fire_at) 到期与排序', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const plain = insertDue(store, '原定更早', NOW - 600);
    const retried = insertDue(store, '原定较晚但已在重试', NOW - 300);
    store.db
      .prepare("UPDATE reminders SET retry_at = ? WHERE id = ?")
      .run(NOW - 100, retried.id);
    const waiting = insertDue(store, '退避还没到', NOW - 200);
    store.db
      .prepare("UPDATE reminders SET retry_at = ? WHERE id = ?")
      .run(NOW + 500, waiting.id);

    const due = store.dueReminders({ now: NOW });
    assert.deepEqual(
      due.map((item) => item.id),
      [plain.id, retried.id],
      '未重试的按原定时间，重试中的按 retry_at 排序；未到期的不出现',
    );
    assert.equal(due[1].next_fire_at, NOW - 300, '展示侧仍能拿到原定时间');
    assert.equal(due[1].retry_at, NOW - 100);
  } finally {
    temp.cleanup();
  }
});

test('V5-L2 store：recover/expire 的结束态清空 retry_at', () => {
  const temp = makeTempStore();
  try {
    const { store } = temp;
    const delivering = insertDue(store, '崩溃残留');
    store.db
      .prepare(
        "UPDATE reminders SET status = 'delivering', delivery_attempts = 3, retry_at = ? WHERE id = ?",
      )
      .run(NOW - 10, delivering.id);
    const recovered = store.recoverReminderDeliveries();
    assert.equal(recovered.expired, 1);
    const expired = store.getReminder(delivering.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.retry_at, null);
    assert.equal(expired.delivery_attempts, 0);

    const pending = insertDue(store, '手动结束');
    store.db.prepare('UPDATE reminders SET retry_at = ? WHERE id = ?').run(NOW + 30, pending.id);
    assert.equal(store.expireReminder(pending.id), true);
    assert.equal(store.getReminder(pending.id).retry_at, null);
  } finally {
    temp.cleanup();
  }
});

test('V5-L2：v11 → v12 迁移补 retry_at，旧行 NULL 且能正常 claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v11-'));
  const dbPath = join(dir, 'companion.db');
  // v11 的真实形态：有 delivery_attempts / occurrence_key，没有 retry_at。
  const V11_REMINDERS_DDL = `
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
  `;
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11');
  `);
  legacy.exec(V11_REMINDERS_DDL);
  legacy
    .prepare(
      "INSERT INTO reminders (id, kind, title, status, next_fire_at) VALUES ('old-11', 'todo', '旧提醒', 'pending', 1)",
    )
    .run();
  legacy.close();

  const store = Store.open(dbPath);
  try {
    assert.equal(store.getMeta('schema_version'), '14');
    const columns = store.db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes('retry_at'), 'v12 必须补 retry_at');
    assert.ok(columns.includes('occurrence_key'), '不得丢掉 v11 的 occurrence_key');
    assert.ok(columns.includes('delivery_attempts'), '不得丢掉 v10 的 delivery_attempts');

    const migrated = store.getReminder('old-11');
    assert.equal(migrated.title, '旧提醒');
    assert.equal(migrated.retry_at, null, '旧行 retry_at 必须是 NULL');
    // 旧行没有 retry_at，COALESCE 回退到 next_fire_at，仍能正常到期。
    assert.deepEqual(store.dueReminders({ now: 1 }).map((item) => item.id), ['old-11']);

    // 旧行可直接进入两阶段投递：claim → 失败写 retry_at → 重试成功清空。
    assert.equal(store.claimReminderDelivery('old-11', '1@1'), true);
    assert.equal(store.getReminder('old-11').delivery_attempts, 1);
    assert.equal(store.markReminderDeliveryFailed('old-11', { now: 100 }), true);
    assert.equal(store.getReminder('old-11').retry_at, 130);
    assert.equal(store.getReminder('old-11').next_fire_at, 1);
    assert.equal(store.claimReminderDelivery('old-11', '1@130'), true);
    assert.equal(store.getReminder('old-11').delivery_attempts, 2);
    assert.equal(store.markReminderDelivered('old-11'), true);
    assert.equal(store.getReminder('old-11').status, 'fired');
    assert.equal(store.getReminder('old-11').retry_at, null);
  } finally {
    store.close();
  }

  // 重开：已是最新版本，补列幂等。
  const reopened = Store.open(dbPath);
  try {
    assert.equal(reopened.getMeta('schema_version'), '14');
    assert.equal(reopened.getReminder('old-11').status, 'fired');
    assert.equal(reopened.getReminder('old-11').retry_at, null);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
