/**
 * t17：/状态 展示最近失败、重试与 job 失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';

const NOW = Date.parse('2026-01-05T09:00:00+08:00');

test('/状态 汇总 lastError / lastRetry / lastJobFailed', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const at = Math.floor(NOW / 1000);

  store.appendEvent({
    at,
    action: 'UPDATE',
    table_name: 'consolidations',
    row_id: 'cs-1',
    actor: 'consolidator',
    reason: 'consolidation_failed',
    detail_json: {
      kind: 'consolidation_failure',
      trigger: 'idle',
      message: 'model temporarily unavailable',
      attempts: 1,
    },
  });
  store.appendEvent({
    at: at + 1,
    action: 'UPDATE',
    table_name: 'consolidations',
    row_id: 'cs-1',
    actor: 'consolidator',
    reason: 'retry',
    detail_json: {
      kind: 'retry',
      trigger: 'idle',
      attempts: 2,
      nextRetryAt: at + 60,
    },
  });
  store.appendEvent({
    at: at + 2,
    action: 'USED',
    table_name: 'scheduler_jobs',
    row_id: 'backup',
    actor: 'scheduler',
    reason: 'job_error:backup',
    detail_json: {
      kind: 'job_error',
      jobId: 'backup',
      message: 'disk full',
      last_error: 'disk full',
      attempts: 1,
    },
  });

  const result = handleCommand({ text: '/状态', store, now: NOW });
  assert.equal(result.handled, true);
  assert.match(result.reply, /最近失败：巩固失败：model temporarily unavailable/u);
  assert.match(result.reply, /最近重试：第 2 次重试 →/u);
  assert.match(result.reply, /最近 job 失败：job 失败：disk full/u);
});

test('/状态 无失败事件时显示「无」', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const result = handleCommand({ text: '/状态', store, now: NOW });
  assert.match(result.reply, /最近失败：无/u);
  assert.match(result.reply, /最近重试：无/u);
  assert.match(result.reply, /最近 job 失败：无/u);
});
