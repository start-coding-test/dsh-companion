/**
 * M4 纯函数测试：每日 token 配额与 RSS 降级阈值。
 *
 * 所有时间都显式传入，不读真实时钟；时区固定 Asia/Shanghai 以验证
 * 「本地日界」而非 UTC 日界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUDGET_REASONS,
  DAILY_TOKEN_LIMIT,
  RSS_LEVELS,
  RSS_MAIN_ONLY_BYTES,
  RSS_STOP_DISPATCH_BYTES,
  RSS_WARN_BYTES,
  checkMemory,
  createBudgetState,
  levelAtLeast,
  overDailyBudget,
  recordTurnUsage,
  rssLevelCode,
  rssLimitsFromConfig,
} from '../src/runtime/budget.js';

const GIB = 1024 ** 3;
const TZ = 'Asia/Shanghai';
// 2026-11-04 23:59:59 +08:00 与 2026-11-05 00:00:00 +08:00。
const DAY_END = Date.parse('2026-11-04T15:59:59.000Z');
const NEXT_DAY = Date.parse('2026-11-04T16:00:00.000Z');

test('createBudgetState：默认归零，兼容 tokens/dayKey 别名', () => {
  assert.deepEqual(createBudgetState(), { dailyTokens: 0, dailyDayKey: null });
  assert.deepEqual(
    createBudgetState({ tokens: 120, dayKey: '2026-11-04' }),
    { dailyTokens: 120, dailyDayKey: '2026-11-04' },
  );
});

test('recordTurnUsage：同一天累加并写日键', () => {
  const state = createBudgetState();
  assert.equal(recordTurnUsage(state, 100, { at: DAY_END, timezone: TZ }), 100);
  assert.equal(recordTurnUsage(state, 250, { at: DAY_END, timezone: TZ }), 350);
  assert.equal(state.dailyDayKey, '2026-11-04');
});

test('recordTurnUsage：跨本地日界先清零再累加', () => {
  const state = createBudgetState();
  recordTurnUsage(state, 900, { at: DAY_END, timezone: TZ });
  const total = recordTurnUsage(state, 50, { at: NEXT_DAY, timezone: TZ });
  assert.equal(total, 50);
  assert.equal(state.dailyTokens, 50);
  assert.equal(state.dailyDayKey, '2026-11-05');
});

test('recordTurnUsage：非法/负 delta 忽略，不抛错', () => {
  const state = createBudgetState();
  for (const delta of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined]) {
    assert.doesNotThrow(() => recordTurnUsage(state, delta, { at: DAY_END, timezone: TZ }));
  }
  assert.equal(state.dailyTokens, 0);
  assert.equal(recordTurnUsage(null, 10, { at: DAY_END, timezone: TZ }), 0);
});

test('recordTurnUsage：可用 clock 注入当前时间', () => {
  const state = createBudgetState();
  const clock = () => NEXT_DAY;
  recordTurnUsage(state, 77, { timezone: TZ, clock });
  assert.equal(state.dailyTokens, 77);
  assert.equal(state.dailyDayKey, '2026-11-05');
});

test('overDailyBudget：3M 边界与自定义 limit', () => {
  const state = createBudgetState({ tokens: DAILY_TOKEN_LIMIT - 1, dayKey: '2026-11-04' });
  assert.equal(overDailyBudget(state, DAILY_TOKEN_LIMIT, { at: DAY_END, timezone: TZ }), false);
  state.dailyTokens = DAILY_TOKEN_LIMIT;
  assert.equal(overDailyBudget(state, DAILY_TOKEN_LIMIT, { at: DAY_END, timezone: TZ }), true);
  assert.equal(overDailyBudget(state, 10, { at: DAY_END, timezone: TZ }), true);

  const small = createBudgetState({ tokens: 5, dayKey: '2026-11-04' });
  assert.equal(overDailyBudget(small, 10, { at: DAY_END, timezone: TZ }), false);
});

test('overDailyBudget：跨日自动复位并解除熔断', () => {
  const state = createBudgetState({ tokens: DAILY_TOKEN_LIMIT, dayKey: '2026-11-04' });
  assert.equal(overDailyBudget(state, DAILY_TOKEN_LIMIT, { at: NEXT_DAY, timezone: TZ }), false);
  assert.equal(state.dailyTokens, 0);
  assert.equal(state.dailyDayKey, '2026-11-05');
});

test('checkMemory：四档阈值精确命中', () => {
  assert.equal(checkMemory({ rss: RSS_WARN_BYTES - 1, totalmem: 8 * GIB }).level, 'ok');
  assert.equal(checkMemory({ rss: RSS_WARN_BYTES, totalmem: 8 * GIB }).level, 'warn');
  assert.equal(checkMemory({ rss: RSS_STOP_DISPATCH_BYTES, totalmem: 8 * GIB }).level, 'stop_dispatch');
  assert.equal(checkMemory({ rss: RSS_MAIN_ONLY_BYTES, totalmem: 8 * GIB }).level, 'main_only');
});

test('checkMemory：返回字节/MB/占比与 code', () => {
  const memory = checkMemory({ rss: 1.5 * GIB, totalmem: 6 * GIB });
  assert.equal(memory.level, 'ok');
  assert.equal(memory.code, RSS_LEVELS.ok);
  assert.equal(memory.rssBytes, 1.5 * GIB);
  assert.equal(memory.rssMB, Math.round(1.5 * 1024));
  assert.equal(memory.totalmemBytes, 6 * GIB);
  assert.equal(memory.ratio, 0.25);
  assert.equal(memory.limits.warn, RSS_WARN_BYTES);
});

test('checkMemory：limits 逐项覆盖', () => {
  const limits = { warn: 100, stop_dispatch: 200, main_only: 300 };
  assert.equal(checkMemory({ rss: 50, totalmem: 1000, limits }).level, 'ok');
  assert.equal(checkMemory({ rss: 150, totalmem: 1000, limits }).level, 'warn');
  assert.equal(checkMemory({ rss: 250, totalmem: 1000, limits }).level, 'stop_dispatch');
  assert.equal(checkMemory({ rss: 350, totalmem: 1000, limits }).level, 'main_only');
});

test('rssLimitsFromConfig：默认三档与 4G 云端覆盖', () => {
  const defaults = rssLimitsFromConfig();
  assert.equal(defaults.gib.warn, 2.95);
  assert.equal(defaults.gib.stop_dispatch, 3);
  assert.equal(defaults.gib.main_only, 3.15);
  assert.equal(defaults.bytes.warn, RSS_WARN_BYTES);
  assert.equal(defaults.bytes.stop_dispatch, RSS_STOP_DISPATCH_BYTES);
  assert.equal(defaults.bytes.main_only, RSS_MAIN_ONLY_BYTES);

  const cloud = rssLimitsFromConfig({ rssWarnGiB: 2.2, rssStopGiB: 2.4, rssMainOnlyGiB: 2.6 });
  assert.deepEqual(cloud.gib, { warn: 2.2, stop_dispatch: 2.4, main_only: 2.6 });
  assert.equal(cloud.bytes.warn, Math.round(2.2 * GIB));
  assert.equal(cloud.bytes.stop_dispatch, Math.round(2.4 * GIB));
  assert.equal(cloud.bytes.main_only, Math.round(2.6 * GIB));

  // 缺失/非法/乱序一律退回默认阈值，保护逻辑不能因配置坏掉而失效。
  const badInputs = [
    null,
    {},
    { rssWarnGiB: -1, rssStopGiB: 2.4, rssMainOnlyGiB: 2.6 },
    { rssWarnGiB: 2.2, rssStopGiB: 2.6, rssMainOnlyGiB: 2.4 },
    { rssWarnGiB: 3, rssStopGiB: 2.4, rssMainOnlyGiB: 2.6 },
  ];
  for (const bad of badInputs) {
    assert.deepEqual(rssLimitsFromConfig(bad).gib, { warn: 2.95, stop_dispatch: 3, main_only: 3.15 });
  }
});

test('checkMemory：注入 2.2/2.4/2.6 的云端阈值逐档命中', () => {
  const { bytes } = rssLimitsFromConfig({ rssWarnGiB: 2.2, rssStopGiB: 2.4, rssMainOnlyGiB: 2.6 });
  assert.equal(checkMemory({ rss: bytes.warn - 1, totalmem: 4 * GIB, limits: bytes }).level, 'ok');
  assert.equal(checkMemory({ rss: bytes.warn, totalmem: 4 * GIB, limits: bytes }).level, 'warn');
  assert.equal(checkMemory({ rss: bytes.stop_dispatch, totalmem: 4 * GIB, limits: bytes }).level, 'stop_dispatch');
  assert.equal(checkMemory({ rss: bytes.main_only, totalmem: 4 * GIB, limits: bytes }).level, 'main_only');

  // 2.45GiB：默认阈值还是 ok，云端配置已到 stop_dispatch——保护更早生效。
  assert.equal(checkMemory({ rss: 2.45 * GIB, totalmem: 4 * GIB }).level, 'ok');
  assert.equal(checkMemory({ rss: 2.45 * GIB, totalmem: 4 * GIB, limits: bytes }).level, 'stop_dispatch');
});

test('checkMemory：rssReader 注入与异常安全', () => {
  let calls = 0;
  const injected = checkMemory({
    totalmem: 8 * GIB,
    rssReader: () => {
      calls += 1;
      return RSS_MAIN_ONLY_BYTES + 1;
    },
  });
  assert.equal(calls, 1);
  assert.equal(injected.level, 'main_only');

  const broken = checkMemory({
    totalmem: 8 * GIB,
    rssReader: () => {
      throw new Error('rss unavailable');
    },
  });
  assert.equal(broken.level, 'ok');
  assert.equal(broken.rssBytes, 0);
  assert.equal(broken.rssMB, 0);
});

test('checkMemory：不传读数时回退 process/os，且不抛', () => {
  const memory = checkMemory();
  assert.ok(Object.values(RSS_LEVELS).includes(memory.code));
  assert.ok(Number.isFinite(memory.rssBytes));
  assert.ok(memory.rssBytes >= 0);
  assert.ok(Number.isFinite(memory.totalmemBytes));
});

test('rssLevelCode / levelAtLeast', () => {
  assert.equal(rssLevelCode('ok'), 0);
  assert.equal(rssLevelCode('warn'), 1);
  assert.equal(rssLevelCode('stop_dispatch'), 2);
  assert.equal(rssLevelCode('main_only'), 3);
  assert.equal(rssLevelCode('unknown'), 0);

  assert.equal(levelAtLeast('warn', 'warn'), true);
  assert.equal(levelAtLeast('warn', 'stop_dispatch'), false);
  assert.equal(levelAtLeast('main_only', 'stop_dispatch'), true);
  assert.equal(levelAtLeast(undefined, 'warn'), false);
});

test('预算原因常量与每日上限固定值', () => {
  assert.equal(DAILY_TOKEN_LIMIT, 3_000_000);
  assert.deepEqual(BUDGET_REASONS, {
    daily: 'daily_budget_exceeded',
    memory: 'memory_pressure',
    mainOnly: 'memory_main_only',
  });
});
