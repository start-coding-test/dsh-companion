/**
 * v0.4.8 集成回归（V5-L2：`retry_at` 退避不覆盖原定时间 + schema v12）。
 *
 * 与 store 级 `test/v048-retry-at.test.js`、接线级 `test/v048-index-retry.test.js`
 * 互补：这里全部走真实插件入口 `apply()` + FakeCtx + 真实 Store / 临时库，把
 * 新语义放回同一条链路里，确认它和既有行为（安静时段、日上限、线程作用域）
 * 没有互相踩踏：
 *   1. 失败两次后成功：`next_fire_at` 全程不变、requestId 全程不变、只送达一次；
 *      成功后 `retry_at` / `occurrence_key` 清空且 `delivery_attempts=0`；
 *   2. `retry_at` 未到时 `onAttempt` 拒绝：不投递、不消耗 attempts；到期后重试成功；
 *   3. 状态板提醒行用原定时间，重试中附「重试中，下次 HH:MM」，退出重试后消失；
 *   4. v11 旧库经 apply() 迁到 v12：`retry_at` 为 NULL，到点照常投递；
 *   5. 三条冒烟：安静时段、日上限、线程作用域隔离。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { renderBoard } from '../src/memory/state-board.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** 2026-11-05T09:00:00Z → Asia/Shanghai 17:00。 */
const NOW_SECONDS = toEpochSeconds(TEST_NOW);
const REMINDER_TEXT = '[提醒] 交房租';

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
function makeCtx(now = TEST_NOW) {
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

/** sessionController.prompt 的请求/文本快照（失败注入的调用同样被记录）。 */
function promptCalls(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const request = call.args[0];
    const content = request?.content;
    return {
      request,
      text: Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '',
    };
  });
}

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** 再过一个调度周期（30s）。 */
async function nextTick(ctx, ms = 30_000) {
  ctx.advance(ms);
  await ctx.fireTimers();
  await settle(50);
}

/** 插入一条已到期的普通提醒（原定 16:59）。 */
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

function countDelivering(store) {
  return store.db
    .prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'delivering'")
    .get().n;
}

// ------------------------------------------------- 1. 失败两次后成功

test('V5-L2 回归：失败两次后成功，next_fire_at 与 requestId 全程不变、只送达一次', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '交房租');
  const expectedFireAt = NOW_SECONDS - 60;
  const t0 = toEpochSeconds(TEST_NOW + 60_000); // 第一次 tick：17:01:00
  ctx.fail('sessionController.prompt');

  // 第一次失败 → 30s 退避；原定时间与 occurrence 均不动。
  await firstTick(ctx);
  let row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 1);
  assert.equal(row.next_fire_at, expectedFireAt, '失败退避不得改写原定 next_fire_at');
  assert.equal(row.retry_at, t0 + 30);
  const occurrence = row.occurrence_key;
  assert.ok(occurrence, '到点入队必须生成 occurrence_key');

  let calls = promptCalls(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, REMINDER_TEXT);
  const requestId = calls[0].request.requestId;
  assert.equal(requestId, `companion-reminder:${reminder.id}:${occurrence}`);

  // 第二次失败（17:01:30）→ 60s 退避；原定时间、requestId 仍不变。
  await nextTick(ctx);
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 2);
  assert.equal(row.next_fire_at, expectedFireAt, '第二次失败也不得改写原定时间');
  assert.equal(row.retry_at, t0 + 30 + 60);
  assert.equal(row.occurrence_key, occurrence, '同一 occurrence 内的退避不换 key');

  calls = promptCalls(ctx);
  assert.equal(calls.length, 2, '每次真重试各产生一次 prompt 尝试');
  assert.equal(calls[1].text, REMINDER_TEXT);
  assert.equal(calls[1].request.requestId, requestId, '重试必须复用同一 requestId 供宿主去重');

  // 第三次（17:02:30，退避到期）成功。
  ctx.failures.delete('sessionController.prompt');
  await nextTick(ctx, 60_000);
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'fired');
  assert.equal(row.next_fire_at, expectedFireAt, '成功投递后原定时间仍是原定时间');
  assert.equal(row.retry_at, null, '成功必须清空 retry_at');
  assert.equal(row.occurrence_key, null, '成功必须清空 occurrence_key');
  assert.equal(row.last_fire_key, null);
  assert.equal(row.delivery_attempts, 0, '成功必须把 attempts 归零');

  calls = promptCalls(ctx);
  assert.equal(calls.length, 3, '2 次失败尝试 + 1 次成功投递');
  assert.deepEqual(
    calls.map((call) => call.text),
    [REMINDER_TEXT, REMINDER_TEXT, REMINDER_TEXT],
    '每次尝试的提醒正文必须一致且不重复叠加',
  );
  assert.ok(calls.every((call) => call.request.requestId === requestId));
  assert.equal(
    calls.filter((call) => call.request.requestId === requestId).length,
    3,
    '同一 occurrence 的 3 次尝试共用同一 requestId',
  );

  // 成功后再过一个周期：不得重复送达。
  await nextTick(ctx);
  assert.equal(promptCalls(ctx).length, 3, '成功后再 tick 不得再次投递');
  assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
  assert.equal(temp.store.dueReminders({ now: Math.floor(ctx.now() / 1000) }).length, 0);
});

// ------------------------------------------------- 2. onAttempt 守卫

test('V5-L2 回归：retry_at 未到时 onAttempt 拒绝且不消耗 attempts，到期后重试成功', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  // 安静时段把队列项留在 proactive backlog 里，制造「已入队、稍后 flush」的窗口，
  // 这样下一轮 flush 真正走到 onAttempt，而不是被 dueReminders 的 SQL 过滤挡掉。
  const handle = apply(ctx, { dbPath: temp.dbPath, quietStart: '17:00', quietEnd: '17:10' });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '交房租');
  const expectedFireAt = NOW_SECONDS - 60;
  const firstTickAt = toEpochSeconds(TEST_NOW + 60_000); // 17:01:00
  ctx.fail('sessionController.prompt');

  // 17:01 处于安静时段：入队并生成 occurrence，但 flush 不投递、不 claim。
  await firstTick(ctx);
  let row = temp.store.getReminder(reminder.id);
  const occurrence = row.occurrence_key;
  assert.ok(occurrence);
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 0);
  assert.equal(row.retry_at, null);
  assert.equal(promptCalls(ctx).length, 0, '安静时段不投递');

  // 模拟「退避时刻排到未来」：队列项还在，但 onAttempt 看到的 dueAt 未到。
  const retryAt = firstTickAt + 1200; // 17:21
  temp.store.db.prepare('UPDATE reminders SET retry_at = ? WHERE id = ?').run(retryAt, reminder.id);

  // 17:10 安静结束：SQL 层 COALESCE 不到期（不重新入队），但 flush 会处理旧队列项，
  // 必须由 onAttempt 拒绝；拒绝路径不得消耗 attempts、不得留下 delivering。
  await nextTick(ctx, 540_000);
  row = temp.store.getReminder(reminder.id);
  assert.equal(promptCalls(ctx).length, 0, 'retry_at 未到不得投递');
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 0, '守卫拒绝不得消耗 attempts');
  assert.equal(row.retry_at, retryAt, '被拒绝后 retry_at 保持原样');
  assert.equal(row.next_fire_at, expectedFireAt, '被拒绝后原定时间不变');
  assert.equal(row.occurrence_key, occurrence);
  assert.equal(countDelivering(temp.store), 0, '不得留下 delivering 残留');

  // 退避到期（把 retry_at 调整到当前秒）：下一次 tick 正常重试并成功。
  temp.store.db
    .prepare('UPDATE reminders SET retry_at = ? WHERE id = ?')
    .run(Math.floor(ctx.now() / 1000), reminder.id);
  ctx.failures.delete('sessionController.prompt');
  await nextTick(ctx);

  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1, 'retry_at 到期后只投递一次');
  assert.equal(calls[0].text, REMINDER_TEXT);
  assert.equal(calls[0].request.requestId, `companion-reminder:${reminder.id}:${occurrence}`);

  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'fired');
  assert.equal(row.retry_at, null);
  assert.equal(row.occurrence_key, null);
  assert.equal(row.delivery_attempts, 0);
  assert.equal(row.next_fire_at, expectedFireAt);
});

// ------------------------------------------------- 3. 展示口径

test('V5-L2 回归：状态板用原定时间并附「重试中，下次 HH:MM」，退出重试后消失', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '交房租');
  ctx.fail('sessionController.prompt');
  await firstTick(ctx); // 17:01 失败 → retry_at 17:01:30

  let row = temp.store.getReminder(reminder.id);
  assert.ok(row.retry_at > Math.floor(ctx.now() / 1000), '失败后处于退避中');

  const board = renderBoard({
    now: Math.floor(ctx.now() / 1000),
    timeZone: 'Asia/Shanghai',
    reminders: [row],
  });
  const line = board.split('\n').find((entry) => entry.includes('交房租'));
  assert.ok(line, '状态板必须包含提醒行');
  assert.match(line, /（11-05，重试中，下次 17:01）/u, `原始行：${line}`);
  assert.doesNotMatch(line, /16:59/u, '展示日期必须取原定 next_fire_at，不显示退避时刻的日期');

  // 退避到期后成功：附注消失，原定日期保留。
  ctx.failures.delete('sessionController.prompt');
  await nextTick(ctx);
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.retry_at, null);
  const after = renderBoard({
    now: Math.floor(ctx.now() / 1000),
    timeZone: 'Asia/Shanghai',
    reminders: [row],
  });
  const afterLine = after.split('\n').find((entry) => entry.includes('交房租'));
  assert.ok(afterLine);
  assert.match(afterLine, /（11-05）/u, `原始行：${afterLine}`);
  assert.doesNotMatch(afterLine, /重试中/u, '退出重试后不得再标注');
});

// ------------------------------------------------- 4. v11 → v12 迁移

test('V5-L2 回归：v11 旧库经 apply 迁到 v12，retry_at 为 NULL 且到点正常投递', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v11-regress-'));
  const dbPath = join(dir, 'companion.db');
  const dueAt = toEpochSeconds(TEST_NOW) - 60;

  // v11 的真实形态：有 occurrence_key 与 delivery_attempts，status 已含 delivering，
  // 但没有 retry_at。
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
    INSERT INTO schema_meta (key, value) VALUES ('main_session_id', 'main-1');
  `);
  legacy.exec(V11_REMINDERS_DDL);
  legacy
    .prepare(`
      INSERT INTO reminders (id, kind, title, due_at, due_granularity, next_fire_at, status)
      VALUES ('old-11', 'todo', '旧提醒', ?, 'exact', ?, 'pending')
    `)
    .run(dueAt, dueAt);
  legacy.close();

  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath });
  t.after(() => {
    handle.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // apply 打开 Store 时已完成迁移：补列、版本升到 12、旧行 retry_at 为 NULL。
  const migratedStore = Store.open(dbPath);
  try {
    const columns = migratedStore.db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes('retry_at'), 'v12 必须补 retry_at');
    assert.equal(migratedStore.getMeta('schema_version'), '14');
    const migrated = migratedStore.getReminder('old-11');
    assert.equal(migrated.status, 'pending');
    assert.equal(migrated.retry_at, null, 'v11 旧行的 retry_at 必须为 NULL');
    assert.equal(migrated.next_fire_at, dueAt);
  } finally {
    migratedStore.close();
  }

  // 到点照常生成 occurrence 并完成投递（COALESCE 回落 next_fire_at）。
  await firstTick(ctx);
  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1, 'v11 旧行的到期提醒应正常投递');
  assert.equal(calls[0].text, '[提醒] 旧提醒');
  assert.match(calls[0].request.requestId, /^companion-reminder:old-11:.+$/u);

  handle.dispose();
  const reopened = Store.open(dbPath);
  try {
    assert.equal(reopened.getMeta('schema_version'), '14');
    const row = reopened.getReminder('old-11');
    assert.equal(row.status, 'fired');
    assert.equal(row.retry_at, null);
    assert.equal(row.next_fire_at, dueAt, '迁移后的旧行原定时间也不得被改写');
    assert.equal(row.occurrence_key, null);
    assert.equal(row.delivery_attempts, 0);
  } finally {
    reopened.close();
  }
});

// ------------------------------------------------- 5a. 安静时段冒烟

test('V5-L2 回归冒烟：安静时段的提醒积压到时段结束只发一条', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, quietStart: '17:01', quietEnd: '17:10' });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '早点休息');
  await firstTick(ctx); // 17:01 安静时段：入队不投递
  assert.equal(promptCalls(ctx).length, 0);

  await nextTick(ctx);
  await nextTick(ctx);
  assert.equal(promptCalls(ctx).length, 0);
  assert.equal(temp.store.getReminder(reminder.id).delivery_attempts, 0);

  await nextTick(ctx, 480_000); // 17:10:00，安静时段结束（end 为开区间）
  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1, '解除安静后只补发一条');
  assert.equal(calls[0].text, '[提醒] 早点休息');
  const row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'fired');
  assert.equal(row.retry_at, null);
  assert.equal(row.delivery_attempts, 0);
});

// ------------------------------------------------- 5b. 日上限冒烟

test('V5-L2 回归冒烟：日上限 1 时只发最早到点的一条，其余留 pending', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, proactiveDailyCap: 1 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const first = dueReminder(temp.store, '交周报');
  const second = dueReminder(temp.store, '开会');
  // 让「交周报」严格早于「开会」：否则同时到点时顺序不稳定。
  const secondDueAt = NOW_SECONDS - 30;
  temp.store.db
    .prepare('UPDATE reminders SET due_at = ?, next_fire_at = ? WHERE id = ?')
    .run(secondDueAt, secondDueAt, second.id);

  await firstTick(ctx);
  let calls = promptCalls(ctx);
  assert.equal(calls.length, 1, '日上限 1：本轮只发一条');
  assert.equal(calls[0].text, '[提醒] 交周报');
  assert.equal(temp.store.getReminder(first.id).status, 'fired');
  assert.equal(temp.store.getReminder(second.id).status, 'pending');

  await nextTick(ctx);
  calls = promptCalls(ctx);
  assert.equal(calls.length, 1, '日上限用尽后不得再发');
  assert.equal(temp.store.getReminder(second.id).status, 'pending');
  assert.equal(temp.store.getReminder(second.id).retry_at, null, '未投递的行不得写 retry_at');
});

// ------------------------------------------------- 5c. 线程作用域冒烟

test('V5-L2 回归冒烟：提醒的线程作用域与主作用域互不串数据', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const main = dueReminder(temp.store, '主线程提醒');
  const threadAt = NOW_SECONDS + 3600;
  const thread = temp.store.insertReminder({
    scope: 'thread:rent',
    kind: 'todo',
    title: '线程提醒',
    due_at: threadAt,
    next_fire_at: threadAt,
    due_granularity: 'exact',
  });

  await firstTick(ctx);
  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '[提醒] 主线程提醒');
  assert.equal(temp.store.getReminder(main.id).status, 'fired');

  const threadRow = temp.store.getReminder(thread.id);
  assert.equal(threadRow.status, 'pending', '未来到点的线程提醒不得被提前投递');
  assert.equal(threadRow.next_fire_at, threadAt, '线程提醒的原定时间不得被主线程 tick 改写');
  assert.equal(threadRow.retry_at, null);

  const mainRows = temp.store.listReminders({ scope: 'main' });
  assert.deepEqual(mainRows.map((row) => row.id), [main.id], '主作用域只应看到主提醒');
  const threadRows = temp.store.listReminders({ scope: 'thread:rent' });
  assert.deepEqual(threadRows.map((row) => row.id), [thread.id], '线程作用域只应看到线程提醒');

  const threadDue = temp.store.dueReminders({ scope: 'thread:rent', now: threadAt + 60 });
  assert.deepEqual(threadDue.map((row) => row.id), [thread.id]);
  assert.equal(
    temp.store.dueReminders({ scope: 'main', now: threadAt + 60 }).length,
    0,
    '已 fired 的主提醒不应再回到到期列表',
  );
});
