/**
 * V6-M1（含 V5-L2）：提醒 requestId 按 occurrence 稳定。
 *
 * 真机反馈：requestId 原本取自 `next_fire_at`，而失败退避会改写 `next_fire_at`
 * （30s/60s），于是每次重试 rpcId 都变，宿主去重失效；同时成功投递不重置
 * delivery_attempts，下一次到点可能继承旧计数被提前 expired。
 *
 * 覆盖：
 *   1. store 语义：occurrence_key 惰性生成、同一次到点内稳定、成功/过期清空并
 *      把 attempts 归零，下一次到点换新 key；
 *   2. e2e：同一 occurrence 连续失败两次 requestId 完全相同且 attempts 递增，
 *      成功投递后下一次到点 requestId 变化且 attempts 从 0 开始；
 *   3. v10 → v11 迁移：旧行 occurrence_key 为 NULL，claim/投递路径照常可用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { strictCtx } from './helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** @param {{now?: number}} [options] */
function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
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

/** sessionController.prompt 的正文/requestId 快照。 */
function promptCalls(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return {
      text: Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '',
      requestId: call.args[0]?.requestId,
      rpcId: call.args[1]?.rpcId,
    };
  });
}

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** 插入一条已到期的普通提醒。 */
function dueReminder(store, title, nowMs = TEST_NOW) {
  const nowSeconds = toEpochSeconds(nowMs);
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nowSeconds - 60,
    next_fire_at: nowSeconds - 60,
    due_granularity: 'exact',
  });
}

test('V6-M1 store：occurrence_key 到点内稳定，成功/过期清空并归零 attempts', () => {
  const temp = makeTempStore();
  try {
    const now = toEpochSeconds(TEST_NOW);
    const reminder = temp.store.insertReminder({
      kind: 'todo',
      title: '喝水',
      next_fire_at: now - 60,
    });
    assert.equal(
      temp.store.getReminder(reminder.id).occurrence_key,
      null,
      '插入提醒时不生成 occurrence_key（只有到点入队才惰性生成）',
    );
    assert.equal(temp.store.ensureReminderOccurrence('rm_missing', now), null);

    const first = temp.store.ensureReminderOccurrence(reminder.id, now);
    assert.ok(first, '活跃提醒必须返回 occurrence_key');
    assert.ok(first.startsWith(`${now}-`), 'key 带本次到点秒，便于排查');
    assert.equal(
      temp.store.ensureReminderOccurrence(reminder.id, now + 30),
      first,
      '同一次到点的退避重试复用同一个 key',
    );

    // 失败一次（同一个 key），再成功：occurrence 结束，计数/键全部复位。
    assert.equal(temp.store.claimReminderDelivery(reminder.id, String(now - 60)), true);
    assert.equal(temp.store.getReminder(reminder.id).delivery_attempts, 1);
    assert.equal(temp.store.markReminderDelivered(reminder.id), true);
    const fired = temp.store.getReminder(reminder.id);
    assert.equal(fired.status, 'fired');
    assert.equal(fired.occurrence_key, null);
    assert.equal(fired.last_fire_key, null);
    assert.equal(fired.delivery_attempts, 0);

    // 下一次到点：新 key（即使同一个 next_fire_at 也不可能复用已清空的 key）。
    temp.store.db
      .prepare("UPDATE reminders SET status = 'pending', next_fire_at = ? WHERE id = ?")
      .run(now + 3600, reminder.id);
    const second = temp.store.ensureReminderOccurrence(reminder.id, now + 3600);
    assert.ok(second);
    assert.notEqual(second, first, '下一次到点必须换新 key');

    // 失败达到上限：expired 同样清空 occurrence/last_fire_key 并归零 attempts。
    temp.store.db
      .prepare(
        "UPDATE reminders SET status = 'delivering', delivery_attempts = 3, last_fire_key = 'stale' WHERE id = ?",
      )
      .run(reminder.id);
    assert.equal(temp.store.markReminderDeliveryFailed(reminder.id, { now }), true);
    const expired = temp.store.getReminder(reminder.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.occurrence_key, null);
    assert.equal(expired.last_fire_key, null);
    assert.equal(expired.delivery_attempts, 0);

    // expireReminder 路径同样清理；之后非活跃行不再返回 key。
    temp.store.db
      .prepare("UPDATE reminders SET status = 'pending', next_fire_at = ? WHERE id = ?")
      .run(now + 7200, reminder.id);
    assert.ok(temp.store.ensureReminderOccurrence(reminder.id, now + 7200));
    assert.equal(temp.store.expireReminder(reminder.id), true);
    const expiredAgain = temp.store.getReminder(reminder.id);
    assert.equal(expiredAgain.occurrence_key, null);
    assert.equal(expiredAgain.delivery_attempts, 0);
    assert.equal(temp.store.ensureReminderOccurrence(reminder.id, now + 7200), null);

    // 非 pending/snoozed 的活跃行也不返回 key。
    const done = dueReminder(temp.store, '已完成的提醒');
    temp.store.db.prepare("UPDATE reminders SET status = 'done' WHERE id = ?").run(done.id);
    assert.equal(temp.store.ensureReminderOccurrence(done.id, now), null);
  } finally {
    temp.cleanup();
  }
});

test('V6-M1 e2e：同一 occurrence 连续失败 requestId 不变，成功换代后 attempts 从 0 开始', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  // 本用例一天内要投 4 条（3 次同一 occurrence + 1 次下一 occurrence），放宽日上限。
  const handle = apply(ctx, { dbPath: temp.dbPath, proactiveDailyCap: 10 });
  try {
    const reminder = dueReminder(temp.store, '交房租');
    ctx.fail('sessionController.prompt');

    // 第一次失败：入队前生成 occurrence，requestId 由它决定。
    await firstTick(ctx);
    let calls = promptCalls(ctx);
    assert.equal(calls.length, 1, '失败后不应在同一次 flush 里重复投递');
    const firstRequestId = calls[0].requestId;
    assert.equal(calls[0].rpcId, firstRequestId, '旧宿主兼容：signal 上附 rpcId');
    let row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 1);
    const occurrence = row.occurrence_key;
    const originalFireAt = row.next_fire_at;
    const firstRetryAt = row.retry_at;
    assert.ok(occurrence, '入队前必须生成 occurrence_key');
    assert.equal(firstRequestId, `companion-reminder:${reminder.id}:${occurrence}`);

    // 退避 30s 后第二次失败：只改写 retry_at，但 requestId 必须完全一致。
    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    calls = promptCalls(ctx);
    assert.equal(calls.length, 2, '退避到期后应重试一次');
    assert.equal(calls[1].requestId, firstRequestId, '同一 occurrence 的重试 rpcId 不得变化');
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 2, 'attempts 仍按尝试递增');
    assert.equal(row.occurrence_key, occurrence);
    assert.equal(row.next_fire_at, originalFireAt, '失败退避不得改写原定到点时间');
    assert.equal(row.retry_at, firstRetryAt + 60, '退避 60s 改写的是一次性 retry_at');

    // 退避 60s 后第三次成功：fired，occurrence/计数全部复位。
    ctx.failures.delete('sessionController.prompt');
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    calls = promptCalls(ctx);
    assert.equal(calls.length, 3, '第三次应投递成功');
    assert.equal(calls[2].requestId, firstRequestId, '同一次到点内成功投递仍用同一 requestId');
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.equal(row.occurrence_key, null);
    assert.equal(row.last_fire_key, null);
    assert.equal(row.delivery_attempts, 0);

    // 模拟下一个到点（重复提醒再次进入 pending），间隔跨过 proactive 去重窗口。
    const nextFire = toEpochSeconds(ctx.now()) + 60;
    temp.store.db
      .prepare("UPDATE reminders SET status = 'pending', next_fire_at = ? WHERE id = ?")
      .run(nextFire, reminder.id);
    ctx.advance(3 * 60 * 60 * 1000);
    ctx.fail('sessionController.prompt');
    await ctx.fireTimers();
    await settle(50);

    calls = promptCalls(ctx);
    assert.equal(calls.length, 4, '下一个到点应重新入队投递一次');
    assert.notEqual(calls[3].requestId, firstRequestId, '下一次到点必须换新 requestId');
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending', '失败 1 次仍 pending');
    assert.equal(row.delivery_attempts, 1, 'attempts 从 0 重新计，不继承上一次到点的计数');
    assert.ok(row.occurrence_key);
    assert.notEqual(row.occurrence_key, occurrence);
    assert.equal(calls[3].requestId, `companion-reminder:${reminder.id}:${row.occurrence_key}`);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V6-M1：v10 → v11 迁移补 occurrence_key，旧行为 NULL 且 claim 可用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v10-'));
  const dbPath = join(dir, 'companion.db');
  // v10 的真实形态：status 已含 delivering，有 delivery_attempts，没有 occurrence_key。
  const V10_REMINDERS_DDL = `
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
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '10');
  `);
  legacy.exec(V10_REMINDERS_DDL);
  legacy
    .prepare(
      "INSERT INTO reminders (id, kind, title, status, next_fire_at) VALUES ('old-10', 'todo', '旧提醒', 'pending', 1)",
    )
    .run();
  legacy.close();

  const store = Store.open(dbPath);
  try {
    assert.equal(store.getMeta('schema_version'), '12');
    const columns = store.db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes('occurrence_key'), 'v11 必须补 occurrence_key');
    assert.equal(columns.includes('delivery_attempts'), true, '不得丢掉 v10 的列');

    const migrated = store.getReminder('old-10');
    assert.equal(migrated.title, '旧提醒');
    assert.equal(migrated.occurrence_key, null, '旧行 occurrence_key 必须是 NULL');

    // 旧行可直接进入两阶段投递：先取 occurrence，再 claim/成功。
    const occurrence = store.ensureReminderOccurrence('old-10', 1);
    assert.ok(occurrence);
    assert.equal(store.claimReminderDelivery('old-10', '1'), true);
    assert.equal(store.getReminder('old-10').status, 'delivering');
    assert.equal(store.getReminder('old-10').delivery_attempts, 1);
    assert.equal(store.markReminderDelivered('old-10'), true);
    assert.equal(store.getReminder('old-10').status, 'fired');
    assert.equal(store.getReminder('old-10').occurrence_key, null);
  } finally {
    store.close();
  }

  // 重开：已是最新版本，补列幂等。
  const reopened = Store.open(dbPath);
  try {
    assert.equal(reopened.getMeta('schema_version'), '12');
    assert.equal(reopened.getReminder('old-10').status, 'fired');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
