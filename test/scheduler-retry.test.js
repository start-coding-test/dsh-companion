/**
 * t17：调度任务失败可观测、可恢复，并在下一次到期时重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import {
  JOB_IDS,
  createScheduler,
} from '../src/runtime/scheduler.js';

const DAY_MS = 86_400_000;

function local(day, hour, minute = 0) {
  const dd = String(day).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return Date.parse(`2026-01-${dd}T${hh}:${mm}:00+08:00`);
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

function eventsOf(store, kind) {
  return store.listEvents({ table_name: 'scheduler_jobs', limit: 500 })
    .map((row) => ({ row, detail: parseDetail(row) }))
    .filter((entry) => entry.detail?.kind === kind);
}

function makeJobs(overrides = {}) {
  const jobs = Object.fromEntries(JOB_IDS.map((id) => [id, () => undefined]));
  return { ...jobs, ...overrides };
}

test('job 失败写 attempts/last_error 与 job_retry，listJobs 可观察', (t) => {
  const store = memoryStore(t);
  let now = local(16, 3, 0);
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs({ 'deep-sleep': () => { throw new Error('boom'); } }),
  });

  const report = scheduler.runDue(now);
  assert.equal(report.errors.length, 1);

  const errors = eventsOf(store, 'job_error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.message, 'boom');
  assert.equal(errors[0].detail.last_error, 'boom');
  assert.equal(errors[0].detail.attempts, 1);

  const retries = eventsOf(store, 'job_retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].detail.attempts, 1);
  assert.equal(retries[0].detail.nextRetryAt, local(17, 3, 0));

  const job = scheduler.listJobs(now).find((entry) => entry.id === 'deep-sleep');
  assert.equal(job.attempts, 1);
  assert.equal(job.lastError, 'boom');
  assert.equal(job.lastErrorAt, now);
});

test('下一次成功执行清空连续失败状态', (t) => {
  const store = memoryStore(t);
  let now = local(16, 3, 0);
  let fail = true;
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs({
      'deep-sleep': () => {
        if (fail) throw new Error('boom');
      },
    }),
  });

  scheduler.runDue(now);
  assert.equal(scheduler.listJobs(now).find((entry) => entry.id === 'deep-sleep').attempts, 1);

  fail = false;
  now = local(17, 3, 0);
  scheduler.runDue(now);
  const job = scheduler.listJobs(now).find((entry) => entry.id === 'deep-sleep');
  assert.equal(job.attempts, 0);
  assert.equal(job.lastError, null);
});

test('新建 scheduler 从 job_error 恢复 attempts 与 lastError', (t) => {
  const store = memoryStore(t);
  const now = local(16, 3, 0);
  const first = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs({ 'deep-sleep': () => { throw new Error('persisted failure'); } }),
  });
  first.runDue(now);

  const second = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs(),
  });
  const job = second.listJobs(now).find((entry) => entry.id === 'deep-sleep');
  assert.equal(job.attempts, 1);
  assert.equal(job.lastError, 'persisted failure');
});

test('异步 rejection 同样记录失败与重试事件', async (t) => {
  const store = memoryStore(t);
  const now = local(16, 3, 0);
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs({ 'deep-sleep': () => Promise.reject(new Error('async boom')) }),
  });

  scheduler.runDue(now);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const errors = eventsOf(store, 'job_error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].detail.message, 'async boom');
  assert.equal(errors[0].detail.attempts, 1);
  assert.equal(eventsOf(store, 'job_retry').length, 1);
});

test('连续失败累计 attempts，interval job 在下一 tick 重试并最终清零', (t) => {
  const store = memoryStore(t);
  let now = local(16, 3, 0);
  let fail = true;
  const scheduler = createScheduler({
    clock: () => now,
    store,
    jobs: makeJobs({
      'idle-probe': () => {
        if (fail) throw new Error('probe boom');
      },
    }),
  });

  now += 60_000;
  scheduler.runDue(now);
  let job = scheduler.listJobs(now).find((entry) => entry.id === 'idle-probe');
  assert.equal(job.attempts, 1);
  const retry = eventsOf(store, 'job_retry').at(-1);
  assert.equal(retry.detail.nextRetryAt, now + 60_000);

  now += 60_000;
  scheduler.runDue(now);
  job = scheduler.listJobs(now).find((entry) => entry.id === 'idle-probe');
  assert.equal(job.attempts, 2);

  fail = false;
  now += 60_000;
  scheduler.runDue(now);
  job = scheduler.listJobs(now).find((entry) => entry.id === 'idle-probe');
  assert.equal(job.attempts, 0);
  assert.equal(job.lastError, null);
});
