import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERIES_MAX_CATCHUP, nextSeriesFire } from '../src/scheduler/series.js';
import { settleReminderSent } from '../src/index.js';
import { renderBoard } from '../src/memory/state-board.js';

const TZ = 'Asia/Shanghai';

/** 2026-11-13 08:00 Asia/Shanghai（周五）。 */
const ANCHOR = Date.UTC(2026, 10, 13, 0, 0, 0) / 1000;

test('nextSeriesFire：DAILY 返回次日同刻', () => {
  const plan = nextSeriesFire({ rrule: 'FREQ=DAILY', anchorAt: ANCHOR, afterAt: ANCHOR, timeZone: TZ });
  assert.equal(plan.ok, true);
  assert.equal(plan.nextFireAt, ANCHOR + 86_400);
  assert.equal(plan.missed, 0);
  assert.equal(plan.seriesIndex, 1);
});

test('nextSeriesFire：停机错过多次时只补最近一次并计数', () => {
  // 三天后才恢复：只应补第 3 次之后的下一次，missed=2。
  const now = ANCHOR + 86_400 * 3 + 60;
  const plan = nextSeriesFire({
    rrule: 'FREQ=DAILY',
    anchorAt: ANCHOR,
    afterAt: ANCHOR,
    nowAt: now,
    timeZone: TZ,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.nextFireAt, ANCHOR + 86_400 * 4);
  assert.equal(plan.missed, 3);
  assert.equal(plan.seriesIndex, 4);
});

test('nextSeriesFire：COUNT 用尽返回 exhausted', () => {
  const plan = nextSeriesFire({
    rrule: 'FREQ=DAILY;COUNT=1',
    anchorAt: ANCHOR,
    afterAt: ANCHOR,
    timeZone: TZ,
  });
  assert.deepEqual(plan, { ok: true, exhausted: true, missed: 0, seriesIndex: 0 });
});

test('nextSeriesFire：UNTIL 之后返回 exhausted', () => {
  const until = new Date((ANCHOR + 3600) * 1000).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
  const plan = nextSeriesFire({
    rrule: `FREQ=DAILY;UNTIL=${until}`,
    anchorAt: ANCHOR,
    afterAt: ANCHOR,
    timeZone: TZ,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.exhausted, true);
});

test('nextSeriesFire：WEEKLY 按原序列前进，跨 DST 不漂移', () => {
  const anchor = Date.UTC(2026, 9, 26, 12, 0, 0) / 1000; // 2026-10-26 20:00 +08
  const plan = nextSeriesFire({
    rrule: 'FREQ=DAILY',
    anchorAt: anchor,
    afterAt: anchor,
    timeZone: 'America/New_York',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.nextFireAt, anchor + 86_400);
});

test('nextSeriesFire：缺失/非法输入返回稳定错误', () => {
  assert.deepEqual(nextSeriesFire({ rrule: '', anchorAt: ANCHOR, afterAt: ANCHOR }),
    { ok: false, reason: 'rrule_required' });
  assert.equal(nextSeriesFire({ rrule: 'FREQ=DAILY', anchorAt: NaN, afterAt: ANCHOR }).ok, false);
  const bad = nextSeriesFire({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', anchorAt: ANCHOR, afterAt: ANCHOR, timeZone: TZ });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'rrule_unsupported');
});

test('nextSeriesFire：catchup 上限是有限值', () => {
  assert.equal(SERIES_MAX_CATCHUP, 1000);
});

function fakeState(row, { nowAt = ANCHOR } = {}) {
  const calls = { delivered: [], advanced: [], logs: [] };
  const state = {
    config: { timezone: TZ },
    platform: {
      now: () => nowAt * 1000,
      log: (level, message, meta) => calls.logs.push({ level, message, meta }),
    },
    store: {
      getReminder: () => row,
      markReminderDelivered: (id) => { calls.delivered.push(id); return { ok: true }; },
      advanceReminderOccurrence: (id, options) => { calls.advanced.push({ id, options }); return { ok: true }; },
    },
  };
  return { state, calls };
}

test('settleReminderSent：普通提醒仍一次性完成', () => {
  const row = { id: 'r1', kind: 'once' };
  const { state, calls } = fakeState(row);
  settleReminderSent(state, row);
  assert.deepEqual(calls.delivered, ['r1']);
  assert.equal(calls.advanced.length, 0);
});

test('settleReminderSent：repeat 推进到原序列下一次并重置现场', () => {
  const row = { id: 'r2', kind: 'repeat', rrule: 'FREQ=DAILY', due_at: ANCHOR, next_fire_at: ANCHOR, series_index: 0 };
  const { state, calls } = fakeState(row);
  settleReminderSent(state, row);
  assert.equal(calls.advanced.length, 1);
  assert.deepEqual(calls.advanced[0], { id: 'r2', options: { nextFireAt: ANCHOR + 86_400, seriesIndex: 1 } });
  assert.equal(calls.delivered.length, 0);
});

test('settleReminderSent：系列 COUNT 用尽时收尾', () => {
  const row = { id: 'r3', kind: 'repeat', rrule: 'FREQ=DAILY;COUNT=1', due_at: ANCHOR, next_fire_at: ANCHOR, series_index: 0 };
  const { state, calls } = fakeState(row);
  settleReminderSent(state, row);
  assert.deepEqual(calls.delivered, ['r3']);
  assert.equal(calls.advanced.length, 0);
});

test('settleReminderSent：规则失效时退回一次性完成并 warn', () => {
  const row = { id: 'r4', kind: 'repeat', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', due_at: ANCHOR, next_fire_at: ANCHOR, series_index: 0 };
  const { state, calls } = fakeState(row);
  settleReminderSent(state, row);
  assert.deepEqual(calls.delivered, ['r4']);
  assert.equal(calls.logs[0].level, 'warn');
});

test('settleReminderSent：停机错过多次时只补最近一次并记 missed', () => {
  const row = { id: 'r5', kind: 'repeat', rrule: 'FREQ=DAILY', due_at: ANCHOR, next_fire_at: ANCHOR, series_index: 0 };
  const { state, calls } = fakeState(row, { nowAt: ANCHOR + 86_400 * 2 + 30 });
  settleReminderSent(state, row);
  assert.deepEqual(calls.advanced[0].options, { nextFireAt: ANCHOR + 86_400 * 3, seriesIndex: 3 });
  assert.equal(calls.logs.at(-1).meta.missed, 2);
});

test('renderBoard：重复提醒在板上显示节奏', () => {
  const due = ANCHOR;
  const text = renderBoard({
    reminders: [{ title: '晨会', kind: 'schedule', next_fire_at: due, rrule: 'FREQ=DAILY', status: 'pending' }],
    now: due,
    timeZone: TZ,
  });
  assert.match(text, /晨会/u);
  assert.match(text, /每天/u);
  assert.match(text, /08:00/u);
});
