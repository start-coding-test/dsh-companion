/**
 * V5-L2（v0.4.8）：src/index.js 接线 + 展示侧的新语义。
 *
 * 与 store 级 test/v048-retry-at.test.js 互补，这里覆盖：
 *   1. 状态板提醒行显示原定时间 next_fire_at，退避中附「重试中，下次 HH:MM」
 *      （按传入时区，忽略已过去/空的 retry_at）；
 *   2. e2e：onAttempt 在 retry_at 未到前拒绝（不消耗 attempts、不重复投递），
 *      retry_at 到期后正常重试并成功；原定 next_fire_at 全程不变。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { renderBoard } from '../src/memory/state-board.js';
import { strictCtx } from './helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

const NOW_SECONDS = toEpochSeconds(TEST_NOW); // 2026-11-05T09:00:00Z → Asia/Shanghai 17:00

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

function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

function dueReminder(store, title) {
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: NOW_SECONDS - 60,
    next_fire_at: NOW_SECONDS - 60,
    due_granularity: 'exact',
  });
}

// ------------------------------------------------------------ 展示（状态板）

test('V5-L2 展示：状态板用原定时间并附「重试中，下次 HH:MM」', () => {
  const text = renderBoard({
    now: NOW_SECONDS,
    timeZone: 'Asia/Shanghai',
    reminders: [
      {
        kind: 'todo',
        title: '交房租',
        status: 'pending',
        next_fire_at: NOW_SECONDS - 60, // 16:59 原定
        retry_at: NOW_SECONDS + 120, // 17:02 下次重试
      },
    ],
  });
  const line = text.split('\n').find((row) => row.includes('交房租'));
  assert.ok(line, '提醒行必须存在');
  assert.match(line, /（11-05，重试中，下次 17:02）/u, `原始行：${line}`);
  assert.doesNotMatch(line, /16:59/u, '展示不把原定时间降级成时分，也不显示 retry_at 的日期');
});

test('V5-L2 展示：retry_at 为空或已过去时不附注，只显示原定时间', () => {
  const cases = [
    { retry_at: null, label: '未在重试' },
    { retry_at: NOW_SECONDS - 10, label: '退避已到期' },
  ];
  for (const { retry_at, label } of cases) {
    const text = renderBoard({
      now: NOW_SECONDS,
      timeZone: 'Asia/Shanghai',
      reminders: [
        { kind: 'todo', title: '交房租', status: 'pending', next_fire_at: NOW_SECONDS - 60, retry_at },
      ],
    });
    const line = text.split('\n').find((row) => row.includes('交房租'));
    assert.ok(line);
    assert.match(line, /（11-05）/u, `${label}：应仍显示原定日期`);
    assert.doesNotMatch(line, /重试中/u, `${label}：不应附重试提示`);
  }
});

// ------------------------------------------------------------ e2e：到点守卫

test('V5-L2 e2e：retry_at 未到前 onAttempt 拒绝，到期后正常重试，原定时间不变', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '交房租');
    const t0 = toEpochSeconds(ctx.now()) + 60; // 第一次 tick 的时刻：17:01
    ctx.fail('sessionController.prompt');

    await firstTick(ctx);
    let row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 1);
    assert.equal(row.next_fire_at, NOW_SECONDS - 60, '失败不得改写原定到点时间');
    assert.equal(row.retry_at, t0 + 30, '第一次失败退避 30s');
    assert.equal(promptTexts(ctx).length, 1);

    // 把 retry_at 推到更远的未来：下一个 tick 虽然到点（原定时间早），
    // onAttempt 必须按 max(next_fire_at, retry_at) 拒绝，且不消耗 attempts。
    temp.store.db
      .prepare('UPDATE reminders SET retry_at = ? WHERE id = ?')
      .run(t0 + 300, reminder.id);
    ctx.advance(30_000); // 17:01:30
    await ctx.fireTimers();
    await settle(50);
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending', '退避未到仍 pending');
    assert.equal(row.delivery_attempts, 1, '退避未到不得消耗 attempts');
    assert.equal(promptTexts(ctx).length, 1, '退避未到不得重复投递');
    assert.equal(
      temp.store.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'delivering'").get().n,
      0,
      '拒绝后不得残留 delivering',
    );

    // retry_at 到期：下一次 tick 正常重试并成功。
    ctx.failures.delete('sessionController.prompt');
    temp.store.db
      .prepare('UPDATE reminders SET retry_at = ? WHERE id = ?')
      .run(toEpochSeconds(ctx.now()), reminder.id);
    ctx.advance(30_000); // 17:02:00
    await ctx.fireTimers();
    await settle(50);

    const texts = promptTexts(ctx);
    assert.equal(texts.length, 2, '退避到期后重试一次');
    assert.equal(texts[1], '[提醒] 交房租');
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.equal(row.retry_at, null, '成功后清空 retry_at');
    assert.equal(row.next_fire_at, NOW_SECONDS - 60, '成功后原定时间仍保留');
    assert.equal(row.delivery_attempts, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V5-L2 e2e：同一 occurrence 退避重试仍按「发生时刻+重试时刻」递增 attempts', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '吃药');
    ctx.fail('sessionController.prompt');

    await firstTick(ctx); // 17:01:00 失败
    ctx.advance(30_000); // 17:01:30 退避 30s 到期，再失败
    await ctx.fireTimers();
    await settle(50);

    const row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 2, '每次真正重试都递增 attempts');
    assert.equal(row.next_fire_at, NOW_SECONDS - 60, '两次退避都不动原定时间');
    assert.equal(row.retry_at, toEpochSeconds(ctx.now()) + 60, '第二次退避 60s');
    assert.equal(promptTexts(ctx).length, 2);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
