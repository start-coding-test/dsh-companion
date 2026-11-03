/**
 * T9 调度器与主动消息闸门测试。
 *
 * 时钟一律用本地时区构造（new Date(y, m, d, h, min)），避免写死 UTC 偏移；
 * 每个用例独立内存库 + 假 platform，不依赖真实定时器/网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import {
  createScheduler,
  JOB_IDS,
  JOB_SPECS,
} from '../src/runtime/scheduler.js';
import {
  createProactive,
  KIND_CAPS,
  MAX_BACKLOG,
  PROACTIVE_EVENT_TABLE,
} from '../src/runtime/proactive.js';

/** 本地时间（毫秒）。2026-01-15 是周四。 */
function local(day, hour, minute = 0) {
  return new Date(2026, 0, day, hour, minute, 0, 0).getTime();
}

function memoryStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function parseDetail(row) {
  if (typeof row?.detail_json !== 'string' || row.detail_json === '') return null;
  try {
    return JSON.parse(row.detail_json);
  } catch {
    return null;
  }
}

function eventsOf(store, tableName) {
  return store.listEvents({ table_name: tableName, limit: 500 }).map((row) => ({
    row,
    detail: parseDetail(row),
  }));
}

function fakeTimers() {
  const handles = [];
  return {
    handles,
    timer(fn, ms) {
      const handle = { fn, ms, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  };
}

/** @returns {{id: string, at: number, trigger: string}[]} */
function makeJobs() {
  const calls = [];
  const jobs = Object.fromEntries(
    JOB_IDS.map((id) => [id, (at, context) => {
      calls.push({ id, at, trigger: context.trigger });
    }]),
  );
  return { jobs, calls };
}

test('内置 6 个 job：id、节奏与每日本地时刻符合 06 §9', () => {
  assert.deepEqual(JOB_IDS, [
    'idle-probe',
    'reminders',
    'deep-sleep',
    's2-purge',
    'backup',
    'thread-freeze',
  ]);
  const byId = new Map(JOB_SPECS.map((spec) => [spec.id, spec]));
  assert.equal(byId.get('idle-probe').kind, 'interval');
  assert.equal(byId.get('idle-probe').intervalMs, 60_000);
  assert.equal(byId.get('reminders').intervalMs, 30_000);
  assert.deepEqual(
    ['deep-sleep', 's2-purge', 'backup', 'thread-freeze'].map((id) => byId.get(id).at),
    ['03:00', '03:30', '04:00', '03:00'],
  );
});

test('间隔任务按 60s / 30s 触发，手动时钟可复现', (t) => {
  const store = memoryStore(t);
  const { jobs, calls } = makeJobs();
  let now = local(15, 10, 0) + 30_000; // 10:00:30
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs,
  });

  // 10:00:30：间隔任务刚建立基线，每日任务均已超出补扫窗口（>6h）→ 无触发
  assert.deepEqual(scheduler.runDue(now).ran, []);

  now = local(15, 10, 1); // 10:01:00，reminders 满 30s
  assert.deepEqual(scheduler.runDue(now).ran, ['reminders']);

  now = local(15, 10, 2); // 10:02:00，reminders 再满 30s、idle-probe 满 60s
  assert.deepEqual(scheduler.runDue(now).ran.sort(), ['idle-probe', 'reminders']);

  assert.deepEqual(
    calls.map((call) => call.id),
    ['reminders', 'idle-probe', 'reminders'],
  );
});

test('6 个 job 跨日触发，每日任务当天只跑一次', (t) => {
  const store = memoryStore(t);
  const { jobs, calls } = makeJobs();
  let now = local(15, 12, 0);
  const scheduler = createScheduler({ clock: () => now, store, jobs });

  now = local(16, 3, 0); // 次日 03:00
  const first = scheduler.runDue(now);
  assert.ok(first.ran.includes('deep-sleep'));
  assert.ok(first.ran.includes('thread-freeze'));
  assert.ok(!first.ran.includes('s2-purge'));
  assert.ok(!first.ran.includes('backup'));

  now = local(16, 3, 30); // 03:30
  const second = scheduler.runDue(now);
  assert.ok(second.ran.includes('s2-purge'));
  assert.ok(!second.ran.includes('deep-sleep'));

  now = local(16, 4, 0); // 04:00
  const third = scheduler.runDue(now);
  assert.ok(third.ran.includes('backup'));
  assert.ok(!third.ran.includes('s2-purge'));

  const triggered = new Set(calls.map((call) => call.id));
  assert.deepEqual([...triggered].sort(), [...JOB_IDS].sort());
  assert.ok(calls.every((call) => call.trigger === 'schedule'));
});

test('启动补扫：6h 内漏跑的每日任务补跑一次，重启不重复', (t) => {
  const store = memoryStore(t);
  const { jobs, calls } = makeJobs();
  const runAt = local(15, 3, 0);
  store.appendEvent({
    at: Math.floor(runAt / 1000),
    action: 'USED',
    table_name: 'scheduler_jobs',
    row_id: 'deep-sleep',
    actor: 'scheduler',
    reason: 'job_run:deep-sleep',
    detail_json: {
      kind: 'job_run',
      jobId: 'deep-sleep',
      jobKind: 'daily',
      trigger: 'schedule',
      at: Math.floor(runAt / 1000),
    },
  });

  let now = local(16, 4, 30);
  const timers = fakeTimers();
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs,
    timer: timers.timer,
    clearTimer: timers.clearTimer,
  });

  const started = scheduler.start(now);
  assert.deepEqual(
    [...started.catchUp].sort(),
    ['backup', 'deep-sleep', 's2-purge', 'thread-freeze'],
  );
  assert.equal(timers.handles.length, 1);
  assert.equal(timers.handles[0].ms, 30_000);

  const catchUpEvents = eventsOf(store, 'scheduler_jobs')
    .filter((event) => event.detail?.kind === 'job_run' && event.detail.trigger === 'catch-up');
  assert.equal(catchUpEvents.length, 4);
  assert.ok(calls.every((call) => call.trigger === 'catch-up'));

  const again = scheduler.start(now);
  assert.deepEqual(again.catchUp, []);
  assert.equal(timers.handles.length, 1);

  scheduler.stop();
  assert.equal(timers.handles[0].cleared, true);
});

test('启动补扫只覆盖 6h 窗口：超窗的当日任务直接放弃', (t) => {
  const store = memoryStore(t);
  const { jobs } = makeJobs();
  let now = local(16, 10, 30); // 每日任务均已超过 6h 窗口
  const timers = fakeTimers();
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs,
    timer: timers.timer,
    clearTimer: timers.clearTimer,
  });

  assert.deepEqual(scheduler.start(now).catchUp, []);
  const dailyEvents = eventsOf(store, 'scheduler_jobs')
    .filter((event) => event.detail?.jobKind === 'daily');
  assert.equal(dailyEvents.length, 0);

  const deepSleep = scheduler.listJobs(now).find((job) => job.id === 'deep-sleep');
  assert.equal(deepSleep.nextRunAt, local(17, 3, 0)); // 次日 03:00
  scheduler.stop();
});

test('lastRunAt 落库：重启后从 memory_events 恢复，不重复跑每日任务', (t) => {
  const store = memoryStore(t);
  const first = makeJobs();
  let now = local(16, 3, 0);
  const schedulerA = createScheduler({ clock: () => now, store, jobs: first.jobs });
  const ran = schedulerA.runDue(now);
  assert.ok(ran.ran.includes('deep-sleep'));

  now = local(16, 3, 1);
  const second = makeJobs();
  const schedulerB = createScheduler({ clock: () => now, store, jobs: second.jobs });
  const deepSleep = schedulerB.listJobs(now).find((job) => job.id === 'deep-sleep');
  assert.equal(deepSleep.lastRunAt, local(16, 3, 0));

  const next = schedulerB.runDue(now);
  assert.ok(!next.ran.includes('deep-sleep'));
  assert.ok(second.calls.every((call) => call.id !== 'deep-sleep'));

  const runEvents = eventsOf(store, 'scheduler_jobs')
    .filter((event) => event.detail?.kind === 'job_run');
  assert.equal(runEvents.length, 2); // deep-sleep + thread-freeze
});

test('同一 job 不重入：Promise 未 settle 时跳过', async (t) => {
  const store = memoryStore(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let now = local(16, 10, 0);
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs: {
      'idle-probe': () => gate,
      reminders: () => undefined,
    },
  });

  now = local(16, 10, 1);
  const first = scheduler.runDue(now);
  assert.ok(first.ran.includes('idle-probe'));
  assert.equal(scheduler.listJobs(now).find((job) => job.id === 'idle-probe').running, true);

  now = local(16, 10, 2); // 10:02:00，idle-probe 到期但仍在跑
  const second = scheduler.runDue(now);
  assert.deepEqual(second.skipped, [{ id: 'idle-probe', reason: 'running' }]);
  assert.ok(second.ran.includes('reminders'));

  release();
  await gate;
  await Promise.resolve();
  assert.equal(scheduler.listJobs(now).find((job) => job.id === 'idle-probe').running, false);

  now = local(16, 10, 3) + 1_000;
  assert.ok(scheduler.runDue(now).ran.includes('idle-probe'));
});

test('handler 抛错不阻断其他 job，并记录 job_error 事件', (t) => {
  const store = memoryStore(t);
  const { jobs } = makeJobs();
  jobs['deep-sleep'] = () => {
    throw new Error('boom');
  };
  let now = local(16, 3, 0);
  const scheduler = createScheduler({ clock: () => now, store, jobs });

  const report = scheduler.runDue(now);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].id, 'deep-sleep');
  assert.ok(report.ran.includes('thread-freeze'));

  const errors = eventsOf(store, 'scheduler_jobs')
    .filter((event) => event.detail?.kind === 'job_error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.jobId, 'deep-sleep');
  assert.equal(errors[0].detail.message, 'boom');
});

test('createScheduler 参数校验：store 必须提供 appendEvent', () => {
  assert.throws(
    () => createScheduler({ store: {} }),
    /appendEvent/,
  );
});

// ---------------------------------------------------------------------------
// 主动消息闸门
// ---------------------------------------------------------------------------

function makePlatform() {
  const calls = [];
  const state = { mode: 'ok' };
  return {
    calls,
    state,
    prompt(sessionId, text) {
      if (state.mode === 'fail') return Promise.reject(new Error('no main session'));
      calls.push({ sessionId, text });
      return Promise.resolve({ ok: true });
    },
  };
}

function setupProactive(t, { cap = 3 } = {}) {
  const store = memoryStore(t);
  const platform = makePlatform();
  const clockState = { now: local(15, 10, 0) };
  const gate = createProactive({
    store,
    platform,
    config: normalizeConfig({ proactiveDailyCap: cap }),
    clock: () => clockState.now,
  });
  return { store, platform, clockState, gate };
}

test('安静时段 23:00–08:00 不发送，08:00 后把相邻消息合并成一条', async (t) => {
  const { gate, platform } = setupProactive(t);
  gate.enqueue({ kind: 'reminder', text: '该喝水了', at: local(15, 23, 30) });
  const quiet = await gate.flush(local(15, 23, 30));
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.sent, 0);
  assert.equal(platform.calls.length, 0);

  gate.enqueue({ kind: 'reminder', text: '早点休息', at: local(15, 23, 35) });
  assert.equal((await gate.flush(local(15, 23, 40))).sent, 0);

  const morning = await gate.flush(local(16, 8, 0));
  assert.equal(morning.quiet, false);
  assert.equal(morning.sent, 1);
  assert.equal(morning.merged, 1);
  assert.equal(platform.calls.length, 1);
  assert.equal(platform.calls[0].sessionId, 'main');
  assert.match(platform.calls[0].text, /该喝水了/);
  assert.match(platform.calls[0].text, /早点休息/);
});

test('每日硬上限 3 条：超出部分保留 backlog，次日再发', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 3 });
  gate.enqueue({ kind: 'task_report', text: '汇报', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'reminder', text: '提醒一', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'reminder', text: '提醒二', at: local(15, 10, 20) });
  gate.enqueue({ kind: 'chat', text: '闲聊', at: local(15, 10, 25) });

  const report = await gate.flush(local(15, 10, 30));
  assert.equal(report.sent, 3);
  assert.equal(platform.calls.length, 3);
  assert.equal(gate.stats(local(15, 10, 30)).backlog, 1);
  assert.equal(gate.stats(local(15, 10, 30)).sentToday, 3);

  const nextDay = await gate.flush(local(16, 10, 0));
  assert.equal(nextDay.sent, 1);
  assert.equal(platform.calls.length, 4);
  assert.match(platform.calls[3].text, /闲聊/);
});

test('单类上限 task_report 1 / reminder 2 / chat 1', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 10 });
  let sent = 0;

  gate.enqueue({ kind: 'task_report', text: '汇报一', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'task_report', text: '汇报二', at: local(15, 10, 15) });
  const reports = await gate.flush(local(15, 10, 30));
  assert.equal(reports.sent, KIND_CAPS.task_report);
  assert.equal(reports.suppressed, 1);
  sent += reports.sent;

  gate.enqueue({ kind: 'reminder', text: '提醒一', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'reminder', text: '提醒二', at: local(15, 10, 15) });
  gate.enqueue({ kind: 'reminder', text: '提醒三', at: local(15, 10, 30) });
  const reminders = await gate.flush(local(15, 10, 31));
  assert.equal(reminders.sent, KIND_CAPS.reminder);
  assert.equal(reminders.suppressed, 1);
  sent += reminders.sent;

  gate.enqueue({ kind: 'chat', text: '闲聊一', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'chat', text: '闲聊二', at: local(15, 10, 15) });
  const chats = await gate.flush(local(15, 10, 32));
  assert.equal(chats.sent, KIND_CAPS.chat);
  assert.equal(chats.suppressed, 1);
  sent += chats.sent;

  assert.equal(sent, 4);
  assert.equal(platform.calls.length, 4);
  const stats = gate.stats(local(15, 10, 32));
  assert.deepEqual(stats.byKind, { task_report: 1, reminder: 2, chat: 1 });
});

test('dedupeKey 120 分钟内不重发，超过后放行', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 10 });
  gate.enqueue({ kind: 'chat', text: '第一次', dedupeKey: 'weather', at: local(15, 10, 0) });
  assert.equal((await gate.flush(local(15, 10, 0))).sent, 1);

  gate.enqueue({ kind: 'task_report', text: '重复', dedupeKey: 'weather', at: local(15, 11, 0) });
  const duplicate = await gate.flush(local(15, 11, 0));
  assert.equal(duplicate.sent, 0);
  assert.equal(duplicate.suppressed, 1);
  assert.equal(platform.calls.length, 1);

  gate.enqueue({ kind: 'task_report', text: '两小时后', dedupeKey: 'weather', at: local(15, 12, 1) });
  assert.equal((await gate.flush(local(15, 12, 1))).sent, 1);
  assert.equal(platform.calls.length, 2);
});

test('10 分钟合并窗口：同类相邻消息合并，仍只占 1 条预算', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 10 });
  gate.enqueue({ kind: 'reminder', text: 'A', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'reminder', text: 'B', at: local(15, 10, 5) });
  gate.enqueue({ kind: 'reminder', text: 'C', at: local(15, 10, 20) });

  const report = await gate.flush(local(15, 10, 30));
  assert.equal(report.sent, 2);
  assert.equal(report.merged, 1);
  assert.equal(platform.calls.length, 2);
  assert.match(platform.calls[0].text, /A/);
  assert.match(platform.calls[0].text, /B/);
  assert.doesNotMatch(platform.calls[0].text, /C/);
  assert.match(platform.calls[1].text, /C/);
});

test('backlog 超过 5 条丢弃最旧', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 10 });
  for (let index = 1; index <= 7; index += 1) {
    gate.enqueue({ kind: 'chat', text: `m${index}`, at: local(15, 10, 0) });
  }
  const stats = gate.stats(local(15, 10, 0));
  assert.equal(stats.backlog, MAX_BACKLOG);
  assert.equal(stats.dropped, 2);

  await gate.flush(local(15, 10, 0));
  assert.equal(platform.calls.length, 1); // chat 单类上限 1
  assert.equal(platform.calls[0].text, 'm3'); // m1/m2 已被丢弃
});

test('没有 main 会话：投递失败保留积压，恢复后补发', async (t) => {
  const { gate, platform } = setupProactive(t, { cap: 10 });
  gate.enqueue({ kind: 'task_report', text: '汇报', at: local(15, 10, 0) });
  gate.enqueue({ kind: 'chat', text: '闲聊', at: local(15, 10, 0) });

  platform.state.mode = 'fail';
  const failed = await gate.flush(local(15, 10, 0));
  assert.equal(failed.failed, 1);
  assert.equal(failed.sent, 0);
  assert.equal(gate.stats(local(15, 10, 0)).backlog, 2);

  platform.state.mode = 'ok';
  const retried = await gate.flush(local(15, 10, 1));
  assert.equal(retried.sent, 2);
  assert.equal(platform.calls.length, 2);
  assert.equal(gate.stats(local(15, 10, 1)).backlog, 0);
});

test('发送记录写 store（memory_events），重启后恢复当日计数与 dedupe', async (t) => {
  const store = memoryStore(t);
  const platform = makePlatform();
  const clockState = { now: local(15, 10, 0) };
  const config = normalizeConfig({ proactiveDailyCap: 3 });
  const first = createProactive({ store, platform, config, clock: () => clockState.now });

  first.enqueue({ kind: 'chat', text: '你好', dedupeKey: 'greet', at: local(15, 10, 0) });
  await first.flush(local(15, 10, 0));

  const sent = eventsOf(store, PROACTIVE_EVENT_TABLE)
    .filter((event) => event.detail?.kind === 'proactive_sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].row.action, 'USED');
  assert.equal(sent[0].row.actor, 'scheduler');
  assert.equal(sent[0].detail.msgKind, 'chat');
  assert.equal(sent[0].detail.dedupeKey, 'greet');

  // 模拟进程重启：新实例从事件恢复预算与 dedupe
  clockState.now = local(15, 10, 5);
  const second = createProactive({ store, platform, config, clock: () => clockState.now });
  assert.equal(second.stats(local(15, 10, 5)).sentToday, 1);
  assert.equal(second.stats(local(15, 10, 5)).byKind.chat, 1);

  second.enqueue({ kind: 'reminder', text: '重复提醒', dedupeKey: 'greet', at: local(15, 10, 5) });
  const duplicate = await second.flush(local(15, 10, 5));
  assert.equal(duplicate.sent, 0);
  assert.equal(duplicate.suppressed, 1);
});
