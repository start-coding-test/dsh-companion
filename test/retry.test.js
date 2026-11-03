/**
 * t17：失败分类与巩固重试退避的纯函数测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CONSOLIDATION_RETRIES,
  RETRY_BACKOFF_MS,
  canRetry,
  errorCode,
  errorMessage,
  isCredentialError,
  isRetryableError,
  planRetry,
  retryDelayMs,
} from '../src/runtime/retry.js';

test('retry 常量：最多 3 次，退避 1/2/4 个 tick', () => {
  assert.equal(MAX_CONSOLIDATION_RETRIES, 3);
  assert.deepEqual([...RETRY_BACKOFF_MS], [60_000, 120_000, 240_000]);
});

test('errorCode / errorMessage 兼容 Error、cause、字符串和空值', () => {
  const coded = new Error('outer');
  coded.code = 'SQLITE_BUSY';
  assert.equal(errorCode(coded), 'SQLITE_BUSY');
  const caused = new Error('wrapper', { cause: { code: 'MISSING_CREDENTIAL' } });
  assert.equal(errorCode(caused), 'MISSING_CREDENTIAL');
  assert.equal(errorCode('plain'), null);
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('text'), 'text');
  assert.equal(errorMessage(null), '');
});

test('isCredentialError 识别 MISSING_CREDENTIAL 与 API key 文案', () => {
  const coded = new Error('nope');
  coded.code = 'MISSING_CREDENTIAL';
  assert.equal(isCredentialError(coded), true);
  assert.equal(isCredentialError(new Error('llm: no API key for provider')), true);
  assert.equal(isCredentialError(new Error('missing credentials')), true);
  assert.equal(isCredentialError(new Error('temporary outage')), false);
  assert.equal(isRetryableError(new Error('temporary outage')), true);
  assert.equal(isRetryableError(coded), false);
});

test('retryDelayMs 只接受 1..3，其余返回 null', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(3), 240_000);
  assert.equal(retryDelayMs(0), null);
  assert.equal(retryDelayMs(4), null);
  assert.equal(retryDelayMs('1'), 60_000);
});

test('planRetry 计算下一次重试时刻；非法 at 抛 TypeError', () => {
  assert.deepEqual(planRetry(1_000, 2), {
    attempt: 2,
    delayMs: 120_000,
    nextAt: 121_000,
  });
  assert.equal(planRetry(1_000, 4), null);
  assert.throws(() => planRetry(Number.NaN, 1), TypeError);
});

test('canRetry：可重试错误且次数未超限才为 true', () => {
  assert.equal(canRetry(new Error('temporary'), 1), true);
  assert.equal(canRetry(new Error('temporary'), 3), true);
  assert.equal(canRetry(new Error('temporary'), 4), false);
  const credential = new Error('missing');
  credential.code = 'MISSING_CREDENTIAL';
  assert.equal(canRetry(credential, 1), false);
});

test('canRetry 识别包装在 cause 里的凭据错误', () => {
  const wrapped = new Error('request failed', { cause: { code: 'MISSING_CREDENTIAL' } });
  assert.equal(isCredentialError(wrapped), true);
  assert.equal(canRetry(wrapped, 1), false);
});
