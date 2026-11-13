/**
 * 额度闸门的纯函数测试。
 *
 * 时间口径：快照 resetAt/updatedAt 是 Unix 秒，now / staleMs / retryAt 是毫秒。
 * 时区断言只用 Asia/Shanghai，避免受运行环境 TZ 影响（本文件在 TZ=UTC /
 * America/New_York 下也应全绿）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RESERVE,
  QUOTA_SOURCES,
  QUOTA_STALE_MS,
  WINDOW_NAMES,
  backoffAfter429,
  computeReserve,
  evaluateQuota,
  formatQuotaLine,
  parseQuotaSnapshot,
} from '../src/runtime/quota.js';

/** 固定 now：2025-11-13T04:00:00Z（上海 12:00）。 */
const NOW_MS = Date.UTC(2025, 10, 13, 4, 0, 0);
const NOW_SECONDS = NOW_MS / 1000;

/** 固定恢复时间：2025-11-14T01:00:00Z（上海 11-14 09:00）。 */
const RESET_SECONDS = Date.UTC(2025, 10, 14, 1, 0, 0) / 1000;

/** 构造合法的 parse 成功结果，默认 updatedAt 为 1 分钟前。 */
function snapshotOf(windows, updatedAt = NOW_SECONDS - 60) {
  return { ok: true, windows, updatedAt };
}

function windowOf(name, remaining, limit, resetAt) {
  return { name, remaining, limit, resetAt };
}

test('常量：来源、窗口、默认保留量、过期阈值', () => {
  assert.deepEqual([...QUOTA_SOURCES], ['none', 'file']);
  assert.deepEqual([...WINDOW_NAMES], ['5h', '7d', 'month']);
  assert.deepEqual({ ...DEFAULT_RESERVE }, { '5h': 0.3, '7d': 0.2, month: 0.1 });
  assert.equal(Object.isFrozen(DEFAULT_RESERVE), true);
  assert.equal(QUOTA_STALE_MS, 15 * 60 * 1000);
});

test('parseQuotaSnapshot：合法快照被完整归一', () => {
  const parsed = parseQuotaSnapshot({
    windows: [
      { name: '5h', remaining: 123456, limit: 1000000, resetAt: 1762900000 },
      { name: '7d', remaining: 2000000, limit: 10000000, resetAt: 1763300000 },
      { name: 'month', remaining: 50000000, limit: 100000000, resetAt: 1764500000 },
    ],
    updatedAt: 1762899000,
  });
  assert.deepEqual(parsed, {
    ok: true,
    windows: [
      { name: '5h', remaining: 123456, limit: 1000000, resetAt: 1762900000 },
      { name: '7d', remaining: 2000000, limit: 10000000, resetAt: 1763300000 },
      { name: 'month', remaining: 50000000, limit: 100000000, resetAt: 1764500000 },
    ],
    updatedAt: 1762899000,
  });
});

test('parseQuotaSnapshot：resetAt / updatedAt 缺失归一为 null', () => {
  const parsed = parseQuotaSnapshot({
    windows: [{ name: '5h', remaining: 1, limit: 5 }],
  });
  assert.deepEqual(parsed, {
    ok: true,
    windows: [{ name: '5h', remaining: 1, limit: 5, resetAt: null }],
    updatedAt: null,
  });
});

test('parseQuotaSnapshot：非对象 / 空 windows / 字段形状非法一律 invalid_snapshot', () => {
  const invalidInputs = [
    null,
    undefined,
    42,
    'quota',
    [],
    {},
    { windows: [] },
    { windows: '5h' },
    { windows: [null] },
    { windows: [{ name: 5, remaining: 1, limit: 2 }] },
    { windows: [{ name: '5h', limit: 2 }] },
    { windows: [{ name: '5h', remaining: -1, limit: 2 }] },
    { windows: [{ name: '5h', remaining: 1.5, limit: 2 }] },
    { windows: [{ name: '5h', remaining: '1', limit: 2 }] },
    { windows: [{ name: '5h', remaining: 1, limit: 0 }] },
    { windows: [{ name: '5h', remaining: 1, limit: -2 }] },
    { windows: [{ name: '5h', remaining: 1, limit: 2.5 }] },
    { windows: [{ name: '5h', remaining: 1, limit: 2, resetAt: 1.5 }] },
    { windows: [{ name: '5h', remaining: 1, limit: 2, resetAt: '123' }] },
    { windows: [{ name: '5h', remaining: 1, limit: 2 }], updatedAt: 1.5 },
    { windows: [{ name: '5h', remaining: 1, limit: 2 }], updatedAt: '1' },
    {
      windows: [
        { name: '5h', remaining: 1, limit: 2 },
        { name: '5h', remaining: 3, limit: 4 },
      ],
    },
  ];
  for (const input of invalidInputs) {
    const parsed = parseQuotaSnapshot(input);
    assert.equal(parsed.ok, false, `应判非法：${JSON.stringify(input)}`);
    assert.equal(parsed.reason, 'invalid_snapshot');
  }
});

test('parseQuotaSnapshot：resetAt / updatedAt 显式 null 与缺键等价（M-2）', () => {
  const withNullReset = parseQuotaSnapshot({ windows: [{ name: '5h', remaining: 1, limit: 2, resetAt: null }] });
  assert.equal(withNullReset.ok, true);
  assert.equal(withNullReset.windows[0].resetAt, null);
  const withNullUpdated = parseQuotaSnapshot({ updatedAt: null, windows: [{ name: '5h', remaining: 1, limit: 2 }] });
  assert.equal(withNullUpdated.ok, true);
  assert.equal(withNullUpdated.updatedAt, null);
});

test('parseQuotaSnapshot：未知窗口忽略并记入 ignored，不算失败', () => {
  const parsed = parseQuotaSnapshot({
    windows: [
      { name: '5h', remaining: 1, limit: 2 },
      // 未知名整体跳过，内部字段再脏也不影响结果
      { name: '3d', remaining: -1, limit: 0 },
    ],
    updatedAt: 100,
  });
  assert.deepEqual(parsed, {
    ok: true,
    windows: [{ name: '5h', remaining: 1, limit: 2, resetAt: null }],
    updatedAt: 100,
    ignored: ['3d'],
  });
  assert.equal('ignored' in parseQuotaSnapshot({ windows: [{ name: '5h', remaining: 1, limit: 2 }] }), false);
});

test('parseQuotaSnapshot：全部是未知名时仍按契约返回成功（无已知窗口）', () => {
  const parsed = parseQuotaSnapshot({
    windows: [{ name: '3d', remaining: 1, limit: 2 }],
    updatedAt: 100,
  });
  assert.deepEqual(parsed, { ok: true, windows: [], updatedAt: 100, ignored: ['3d'] });
});

test('evaluateQuota：无快照一律 none / paused=false', () => {
  const inputs = [null, undefined, 42, 'x', { ok: false, reason: 'invalid_snapshot' }];
  for (const input of inputs) {
    const evaluation = evaluateQuota(input, { now: NOW_MS });
    assert.equal(evaluation.state, 'none', `应判 none：${JSON.stringify(input)}`);
    assert.equal(evaluation.paused, false);
    assert.deepEqual(evaluation.tightWindows, []);
    assert.equal(evaluation.resumeAt, null);
  }
});

test('evaluateQuota：过期边界——恰好 15 分钟算新鲜，超过 1 秒算过期', () => {
  // 口径锁定：now - updatedAt*1000 > staleMs 才过期（严格大于）；
  // 恰好 900000ms 仍按新鲜处理，避免临界抖动导致后台任务反复启停。
  const exactly15 = evaluateQuota(
    snapshotOf([windowOf('5h', 900000, 1000000, RESET_SECONDS)], NOW_SECONDS - 900),
    { now: NOW_MS },
  );
  assert.equal(exactly15.state, 'ok');
  assert.equal(exactly15.paused, false);

  const over15 = evaluateQuota(
    snapshotOf([windowOf('5h', 900000, 1000000, RESET_SECONDS)], NOW_SECONDS - 901),
    { now: NOW_MS },
  );
  assert.equal(over15.state, 'stale');
  assert.equal(over15.paused, false);
  assert.equal(over15.resumeAt, null);
});

test('evaluateQuota：updatedAt 缺失按过期处理，且过期优先于紧张', () => {
  const missing = evaluateQuota(
    { ok: true, windows: [windowOf('5h', 1, 1000000, RESET_SECONDS)] },
    { now: NOW_MS },
  );
  assert.equal(missing.state, 'stale');
  assert.equal(missing.paused, false);

  const staleTight = evaluateQuota(
    snapshotOf([windowOf('5h', 1, 1000000, RESET_SECONDS)], NOW_SECONDS - 3600),
    { now: NOW_MS },
  );
  assert.equal(staleTight.state, 'stale');
  assert.equal(staleTight.paused, false);
  assert.deepEqual(staleTight.tightWindows, []);
});

test('evaluateQuota：staleMs 可覆盖', () => {
  const evaluation = evaluateQuota(
    snapshotOf([windowOf('5h', 900000, 1000000)], NOW_SECONDS - 6),
    { now: NOW_MS, staleMs: 5000 },
  );
  assert.equal(evaluation.state, 'stale');
  assert.equal(evaluation.staleMs, 5000);
});

test('evaluateQuota：紧张边界用 <=（等于保留量即暂停）', () => {
  const atBoundary = evaluateQuota(
    snapshotOf([windowOf('5h', 300000, 1000000, RESET_SECONDS)]),
    { now: NOW_MS },
  );
  assert.equal(atBoundary.state, 'tight');
  assert.equal(atBoundary.paused, true);
  assert.equal(atBoundary.tightWindows.length, 1);
  assert.equal(atBoundary.tightWindows[0].name, '5h');
  assert.equal(atBoundary.tightWindows[0].ratio, 0.3);

  const justAbove = evaluateQuota(
    snapshotOf([windowOf('5h', 300001, 1000000, RESET_SECONDS)]),
    { now: NOW_MS },
  );
  assert.equal(justAbove.state, 'ok');
  assert.equal(justAbove.paused, false);
});

test('evaluateQuota：多个紧张窗口取最小 resetAt，缺失 resetAt 则 null', () => {
  const evaluation = evaluateQuota(
    snapshotOf([
      windowOf('5h', 30000, 1000000, 3000),
      windowOf('7d', 100000, 1000000, 2000),
      windowOf('month', 50000000, 100000000, 1000),
    ]),
    { now: NOW_MS },
  );
  assert.equal(evaluation.state, 'tight');
  assert.deepEqual(evaluation.tightWindows.map((window) => window.name), ['5h', '7d']);
  assert.equal(evaluation.resumeAt, 2000);

  const withoutReset = evaluateQuota(
    snapshotOf([
      windowOf('5h', 30000, 1000000),
      windowOf('7d', 100000, 1000000),
    ]),
    { now: NOW_MS },
  );
  assert.equal(withoutReset.state, 'tight');
  assert.equal(withoutReset.resumeAt, null);
});

test('evaluateQuota：自定义 reserve（computeReserve 结果）生效且缺键回落默认', () => {
  const reserve = computeReserve({ '5h': 0.5 });
  assert.deepEqual([...reserve.warnings], []);
  const evaluation = evaluateQuota(
    snapshotOf([windowOf('5h', 400000, 1000000), windowOf('7d', 250000, 1000000)]),
    { now: NOW_MS, reserve },
  );
  // 5h 40% <= 自定义 50% -> 紧张；7d 25% > 默认 20% -> 不紧张
  assert.equal(evaluation.state, 'tight');
  assert.deepEqual(evaluation.tightWindows.map((window) => window.name), ['5h']);
});

test('computeReserve：默认值、冻结、非法覆盖回落并告警', () => {
  const defaults = computeReserve();
  assert.deepEqual({ ...defaults }, { ...DEFAULT_RESERVE, warnings: [] });
  assert.equal(Object.isFrozen(defaults), true);

  const mixed = computeReserve({
    '5h': 0.5,
    '7d': 1,
    month: '0.2',
    bogus: 0.3,
  });
  assert.equal(mixed['5h'], 0.5);
  assert.equal(mixed['7d'], DEFAULT_RESERVE['7d']);
  assert.equal(mixed.month, DEFAULT_RESERVE.month);
  assert.deepEqual([...mixed.warnings], ['7d', 'month']);
  assert.equal('bogus' in mixed, false);

  for (const value of [0, 1, -0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.4', null]) {
    const result = computeReserve({ '5h': value });
    assert.equal(result['5h'], DEFAULT_RESERVE['5h'], `非法值应回落：${String(value)}`);
    assert.deepEqual([...result.warnings], ['5h']);
  }

  for (const value of [0.0001, 0.9999]) {
    assert.equal(computeReserve({ '5h': value })['5h'], value);
  }

  assert.deepEqual({ ...computeReserve(null) }, { ...DEFAULT_RESERVE, warnings: [] });
  assert.deepEqual({ ...computeReserve(42) }, { ...DEFAULT_RESERVE, warnings: [] });
});

test('backoffAfter429：有效的未来 resetAt 直接采用，attempt 不递增', () => {
  const now = 1_700_000_000_000;
  const result = backoffAfter429({ now, resetAt: 1_700_000_120, attempt: 3 });
  assert.deepEqual(result, { retryAt: 1_700_000_120_000, attempt: 3 });
});

test('backoffAfter429：resetAt 等于/早于 now 或非法时走指数退避', () => {
  const now = 1_700_000_000_000;
  const equal = backoffAfter429({ now, resetAt: 1_700_000_000, attempt: 0 });
  assert.deepEqual(equal, { retryAt: now + 60_000, attempt: 1 });

  const past = backoffAfter429({ now, resetAt: 1_600_000_000, attempt: 1 });
  assert.deepEqual(past, { retryAt: now + 120_000, attempt: 2 });

  for (const resetAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '1700000120']) {
    const result = backoffAfter429({ now, resetAt, attempt: 2 });
    assert.deepEqual(result, { retryAt: now + 240_000, attempt: 3 });
  }
});

test('backoffAfter429：attempt 递增与 60 分钟封顶', () => {
  const now = 1_700_000_000_000;
  const expectedMinutes = [1, 2, 4, 8, 16, 32, 60];
  expectedMinutes.forEach((minutes, attempt) => {
    const result = backoffAfter429({ now, attempt });
    assert.deepEqual(result, { retryAt: now + minutes * 60_000, attempt: attempt + 1 });
  });

  assert.deepEqual(backoffAfter429({ now, attempt: 10 }), {
    retryAt: now + 60 * 60_000,
    attempt: 11,
  });
});

test('backoffAfter429：attempt 缺失/非法按 0 处理，入参安全', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(backoffAfter429({ now }), { retryAt: now + 60_000, attempt: 1 });
  assert.deepEqual(backoffAfter429({ now, attempt: -3 }), { retryAt: now + 60_000, attempt: 1 });
  assert.deepEqual(backoffAfter429({ now, attempt: 1.5 }), { retryAt: now + 60_000, attempt: 1 });

  const safe = backoffAfter429(null);
  assert.equal(safe.attempt, 1);
  assert.equal(Number.isFinite(safe.retryAt), true);
});

test('formatQuotaLine：none / 空入参', () => {
  const expected = '额度：不限（quota.source=none）';
  assert.equal(formatQuotaLine({ state: 'none' }, { now: NOW_MS, timeZone: 'Asia/Shanghai' }), expected);
  assert.equal(formatQuotaLine(null, { now: NOW_MS }), expected);
  assert.equal(formatQuotaLine(undefined, null), expected);
  assert.equal(formatQuotaLine(42, { timeZone: 'Asia/Shanghai' }), expected);
});

test('formatQuotaLine：stale 文案（默认 15 分钟 / 自定义阈值）', () => {
  const evaluation = evaluateQuota(
    snapshotOf([windowOf('5h', 900000, 1000000)], NOW_SECONDS - 3600),
    { now: NOW_MS },
  );
  assert.equal(
    formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    '额度：快照过期（updatedAt 超过 15 分钟），按不限处理',
  );
  assert.equal(
    formatQuotaLine({ state: 'stale', staleMs: 5 * 60_000 }, { now: NOW_MS }),
    '额度：快照过期（updatedAt 超过 5 分钟），按不限处理',
  );
});

test('formatQuotaLine：ok 明细按窗口顺序显示剩余百分比', () => {
  const evaluation = evaluateQuota(
    snapshotOf([
      windowOf('month', 330000, 1000000),
      windowOf('5h', 620000, 1000000),
      windowOf('7d', 410000, 1000000),
    ]),
    { now: NOW_MS },
  );
  assert.equal(evaluation.state, 'ok');
  assert.equal(
    formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    '额度：充裕（5h 剩余 62%，7d 41%，month 33%）',
  );
});

test('formatQuotaLine：tight 文案含最小 resumeAt 的上海墙上时间', () => {
  // 7d 的 resetAt 更早 -> resumeAt 取 7d；上海时间 11-14 09:00。
  const evaluation = evaluateQuota(
    snapshotOf([
      windowOf('5h', 30000, 1000000, RESET_SECONDS + 7200),
      windowOf('7d', 120000, 1000000, RESET_SECONDS),
      windowOf('month', 50000000, 100000000, RESET_SECONDS + 86400),
    ]),
    { now: NOW_MS },
  );
  assert.equal(evaluation.state, 'tight');
  assert.equal(evaluation.resumeAt, RESET_SECONDS);
  assert.equal(
    formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    '额度紧张，后台暂停至 11-14 09:00（5h 剩余 3%，7d 12%）',
  );
});

test('formatQuotaLine：tight 但缺 resetAt 时不写暂停时间', () => {
  const evaluation = evaluateQuota(
    snapshotOf([windowOf('5h', 30000, 1000000)]),
    { now: NOW_MS },
  );
  assert.equal(evaluation.resumeAt, null);
  assert.equal(
    formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    '额度紧张，后台暂停（5h 剩余 3%）',
  );
});

test('formatQuotaLine：非法时区回落 Asia/Shanghai，空 timeZone 同样回落', () => {
  const evaluation = {
    state: 'tight',
    paused: true,
    tightWindows: [{ name: '5h', ratio: 0.03, remaining: 3, limit: 100, resetAt: RESET_SECONDS }],
    resumeAt: RESET_SECONDS,
  };
  const expected = '额度紧张，后台暂停至 11-14 09:00（5h 剩余 3%）';
  assert.equal(formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Mars/Olympus' }), expected);
  assert.equal(formatQuotaLine(evaluation, { now: NOW_MS, timeZone: '' }), expected);
  assert.equal(formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'UTC' }), '额度紧张，后台暂停至 11-14 01:00（5h 剩余 3%）');
});

test('formatQuotaLine：脏 evaluation 不抛异常', () => {
  const cases = [
    { state: 'tight', tightWindows: null, resumeAt: 'soon' },
    { state: 'tight', tightWindows: [{ name: '5h' }] },
    { state: 'ok', windows: [{ name: 'x', ratio: Number.NaN }] },
    { state: 'anything' },
  ];
  for (const evaluation of cases) {
    const line = formatQuotaLine(evaluation, { now: NOW_MS, timeZone: 'Asia/Shanghai' });
    assert.equal(typeof line, 'string');
    assert.notEqual(line, '');
  }
});
