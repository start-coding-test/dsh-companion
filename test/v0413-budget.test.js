/**
 * v0.4.13 A1（配置与硬线部分）：额度上限可配置。
 *
 * 覆盖 `budget.dailyHardLimit` / `budget.window5hLimit` 的归一化与
 * `dailyLimitFromConfig` 的兜底；持久化入账（token_usage 表、来源占比）等
 * store v15 合并后在接线层覆盖。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULTS, normalizeConfig } from '../src/config.js';
import { DAILY_TOKEN_LIMIT, dailyLimitFromConfig } from '../src/runtime/budget.js';

describe('budget 配置（A1）', () => {
  test('默认 3M，且不启用 5h 窗口', () => {
    const cfg = normalizeConfig({});
    assert.equal(cfg.budget.dailyHardLimit, DAILY_TOKEN_LIMIT);
    assert.equal(cfg.budget.window5hLimit, null);
  });

  test('可下调 / 上调每日硬线', () => {
    assert.equal(normalizeConfig({ budget: { dailyHardLimit: 800_000 } }).budget.dailyHardLimit, 800_000);
    assert.equal(normalizeConfig({ budget: { dailyHardLimit: 5_000_000 } }).budget.dailyHardLimit, 5_000_000);
  });

  test('非法值报 ConfigError，字段名可定位', () => {
    assert.throws(() => normalizeConfig({ budget: { dailyHardLimit: 99_999 } }), /budget\.dailyHardLimit/u);
    assert.throws(() => normalizeConfig({ budget: { dailyHardLimit: 1.5 } }), /budget\.dailyHardLimit/u);
    assert.throws(() => normalizeConfig({ budget: { dailyHardLimit: '3000000' } }), /budget\.dailyHardLimit/u);
  });

  test('5h 窗口线必须为 null 或不大于每日硬线', () => {
    assert.equal(
      normalizeConfig({ budget: { dailyHardLimit: 1_000_000, window5hLimit: 300_000 } }).budget.window5hLimit,
      300_000,
    );
    assert.throws(
      () => normalizeConfig({ budget: { dailyHardLimit: 1_000_000, window5hLimit: 2_000_000 } }),
      /budget\.window5hLimit/u,
    );
    assert.throws(
      () => normalizeConfig({ budget: { window5hLimit: 999 } }),
      /budget\.window5hLimit/u,
    );
  });

  test('未知键只 warning，安装自检仍 16 键', () => {
    const cfg = normalizeConfig({ budget: { dailyHardLimit: 1_000_000, nope: 1 } });
    assert.equal(cfg.warnings.some((w) => w.includes('budget.nope')), true);
    assert.equal(Object.keys(DEFAULTS).length, 16);
  });

  test('dailyLimitFromConfig 对缺失/非法配置回落 3M', () => {
    assert.equal(dailyLimitFromConfig(undefined), DAILY_TOKEN_LIMIT);
    assert.equal(dailyLimitFromConfig({}), DAILY_TOKEN_LIMIT);
    assert.equal(dailyLimitFromConfig({ budget: { dailyHardLimit: 'x' } }), DAILY_TOKEN_LIMIT);
    assert.equal(dailyLimitFromConfig({ budget: { dailyHardLimit: 1 } }), DAILY_TOKEN_LIMIT);
    assert.equal(dailyLimitFromConfig({ budget: { dailyHardLimit: 500_000 } }), 500_000);
  });
});
