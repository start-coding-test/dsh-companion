/**
 * V3-H2 + V3-M2 生产路径 e2e：提醒两阶段投递 + 主会话重绑。
 *
 * 全部走真实插件入口 `apply()` + FakeCtx + 临时库 + 手动时钟：
 *   1. 投递失败（prompt 抛错）→ 行仍 pending，重启后补发成功转 fired；
 *   2. 投递成功 → fired，之后 tick 不重复提醒；
 *   3. 崩溃残留 delivering → 启动回收成 pending 后补发；超过重试上限转 expired；
 *   4. 提醒投递到「最近一次真实用户输入」的主会话，探针会话不改绑定；
 *   5. v9 → v10 迁移：reminders 增加 delivering 与 delivery_attempts，幂等可重开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { Store } from '../../src/memory/store.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './helpers.js';

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

/** 主动消息正文（FakeCtx 把 prompt 记成 content 数组）。 */
function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

/** 一轮真实用户输入的 pre-step payload。 */
function turnPayload(ctx, session, turn, text) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step: 1,
  };
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

test('prompt 抛错：行保持 pending，重启后补发成功转 fired', async () => {
  const temp = makeTempStore();
  // 模拟上一轮用户已绑定主会话（currentMainSessionId 从 meta 读取）。
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  let reminder;
  try {
    reminder = dueReminder(temp.store, '交房租');
    ctx.fail('sessionController.prompt');

    await firstTick(ctx);

    const failed = temp.store.getReminder(reminder.id);
    assert.equal(failed.status, 'pending', '投递失败必须回 pending，不能停在 fired/delivering');
    assert.equal(failed.delivery_attempts, 1);
    assert.ok(failed.last_fire_key, 'last_fire_key 保留供重试幂等');
    assert.ok(ctx.callsOf('sessionController.prompt').length >= 1, '确实尝试过投递');
  } finally {
    handle.dispose();
  }

  // 重启：使用同一 dbPath（模拟进程重启），这次 prompt 正常。
  const ctx2 = makeCtx();
  const handle2 = apply(ctx2, { dbPath: temp.dbPath });
  try {
    // 重启后调度器从 memory_events 恢复 lastRunAt，需再过一个 interval 才到期。
    await firstTick(ctx2);
    ctx2.advance(30_000);
    await ctx2.fireTimers();
    await settle(50);
    const texts = promptTexts(ctx2).filter((text) => text.includes('交房租'));
    assert.equal(texts.length, 1);
    const delivered = temp.store.getReminder(reminder.id);
    assert.equal(delivered.status, 'fired');
    assert.equal(delivered.delivery_attempts, 2);
  } finally {
    handle2.dispose();
    temp.cleanup();
  }
});

test('投递成功：转 fired，后续 tick 不重复提醒', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '给妈妈打电话');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('给妈妈打电话')).length, 1);
    const row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.ok(row.last_fire_key);

    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('给妈妈打电话')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('崩溃残留 delivering：启动回收为 pending 并补发', async () => {
  const temp = makeTempStore();
  const reminder = dueReminder(temp.store, '交水电费');
  temp.store.db
    .prepare(
      "UPDATE reminders SET status = 'delivering', delivery_attempts = 1, last_fire_key = 'stale' WHERE id = ?",
    )
    .run(reminder.id);

  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    assert.equal(temp.store.getReminder(reminder.id).status, 'pending');
    assert.ok(
      ctx.logs.some(
        (row) => row.level === 'info' && /reminder deliveries recovered/iu.test(row.message),
      ),
    );
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交水电费')).length, 1);
    assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
    assert.equal(temp.store.getReminder(reminder.id).delivery_attempts, 2);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('重试耗尽：delivering 且 attempts 已达上限，启动回收为 expired 不再投递', async () => {
  const temp = makeTempStore();
  const reminder = dueReminder(temp.store, '过期提醒');
  temp.store.db
    .prepare(
      "UPDATE reminders SET status = 'delivering', delivery_attempts = 3, last_fire_key = 'stale' WHERE id = ?",
    )
    .run(reminder.id);

  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    assert.equal(temp.store.getReminder(reminder.id).status, 'expired');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('过期提醒')).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('提醒投递到最近一次真实用户输入的主会话，探针会话不改绑定', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const first = ctx.addSession({ id: 'main-1' });
  const second = ctx.addSession({ id: 'main-2' });
  const probe = ctx.addSession({ id: 'probe-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, first, 1, '蓝鲸是什么动物？'), {
      kind: 'enter',
      messages: [],
    });
    assert.equal(temp.store.getMeta('main_session_id'), 'main-1');

    await ctx.dispatch('agent/pre-step', turnPayload(ctx, second, 1, '极光在哪里出现？'), {
      kind: 'enter',
      messages: [],
    });
    assert.equal(temp.store.getMeta('main_session_id'), 'main-2');

    // 探针：没有真实用户输入（runtime-context 注入不算）。
    await ctx.dispatch(
      'agent/pre-step',
      {
        agent: { id: probe.id, session: probe },
        messages: [
          {
            role: 'user',
            source: { kind: 'runtime-context' },
            content: [{ type: 'text', text: '[运行时上下文] 探针' }],
          },
        ],
        turn: 1,
        step: 1,
      },
      { kind: 'enter', messages: [] },
    );
    assert.equal(temp.store.getMeta('main_session_id'), 'main-2', '探针不得抢占主会话');

    const reminder = dueReminder(temp.store, '周五交周报');
    await firstTick(ctx);
    const calls = ctx.callsOf('sessionController.prompt');
    const target = calls.find((call) =>
      String(call.args[0]?.content?.map((part) => part?.text ?? '').join('') ?? '').includes('周五交周报'),
    );
    assert.ok(target, '应投递一条提醒');
    assert.equal(target.args[0]?.sessionId, 'main-2');
    assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('v9 → v10 迁移：reminders 支持 delivering 与 delivery_attempts，重开幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v9-'));
  const dbPath = join(dir, 'companion.db');
  const OLD_REMINDERS_DDL = `
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
                        CHECK (status IN ('pending','fired','snoozed','done','cancelled','expired')),
      closed_at         INTEGER,
      source_episode_id TEXT,
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
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '9');
  `);
  legacy.exec(OLD_REMINDERS_DDL);
  legacy
    .prepare(
      "INSERT INTO reminders (id, kind, title, status, next_fire_at) VALUES ('old-1', 'todo', '旧提醒', 'pending', 1)",
    )
    .run();
  legacy.close();

  const store = Store.open(dbPath);
  try {
    const columns = store.db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes('delivery_attempts'), 'v10 必须补 delivery_attempts');
    assert.equal(store.getMeta('schema_version'), '10');

    const migrated = store.getReminder('old-1');
    assert.equal(migrated.title, '旧提醒');
    assert.equal(migrated.delivery_attempts, 0);

    // 旧 CHECK 已放开 delivering：两阶段流程可写占位态。
    assert.equal(store.claimReminderDelivery('old-1', 'k1'), true);
    assert.equal(store.getReminder('old-1').status, 'delivering');
    assert.equal(store.getReminder('old-1').delivery_attempts, 1);
    assert.equal(store.markReminderDelivered('old-1'), true);
    assert.equal(store.getReminder('old-1').status, 'fired');
  } finally {
    store.close();
  }

  // 重开：已是最新版本时不再重建，迁移幂等。
  const reopened = Store.open(dbPath);
  try {
    assert.equal(reopened.getMeta('schema_version'), '10');
    assert.equal(reopened.getReminder('old-1').status, 'fired');
    const indexes = reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('ix_rm_fire'));
    assert.ok(indexes.includes('ix_rm_done'));
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
