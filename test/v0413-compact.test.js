/**
 * v0.4.13 A6：压缩迟滞。
 *
 * 三件事必须同时成立才算「值得再压一次」：token 越过 compactAtTokens、比上次
 * 压后的实测水位（floor）又涨够 minIncrementTokens、且距上次 threshold 压缩已经
 * 隔了 cooldownTurns 轮。hard 与 idle 不受这两条限制——安全阀与闲置时机不该被
 * 冷却挡住。这里走公开入口：planConsolidation、normalizeConfig、handleCommand。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DEFAULT_AT_TOKENS, planConsolidation } from '../src/memory/consolidate.js';
import { normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';

const NOW = Date.UTC(2026, 10, 13, 6, 0, 0);

describe('planConsolidation：floor 与冷却（A6）', () => {
  const base = { overCount: 2, atTokens: 24_000, hardTokens: 40_000, now: NOW, lastHumanAt: null };

  test('越过阈值但还没涨够 floor + 增量门槛：不压', () => {
    const plan = planConsolidation({ ...base, tokens: 26_000, floorTokens: 24_000, minIncrementTokens: 4_096 });
    assert.equal(plan.trigger, null);
  });

  test('涨够增量门槛：允许 threshold', () => {
    const plan = planConsolidation({ ...base, tokens: 28_096, floorTokens: 24_000, minIncrementTokens: 4_096 });
    assert.equal(plan.trigger, 'threshold');
  });

  test('没有 floor 样本时不受增量门槛限制', () => {
    const plan = planConsolidation({ ...base, tokens: 24_500 });
    assert.equal(plan.trigger, 'threshold');
  });

  test('冷却未满足：threshold 被挡，hard 仍放行', () => {
    const cooling = planConsolidation({
      ...base,
      tokens: 30_000,
      turnsSinceThreshold: 1,
      cooldownTurns: 3,
    });
    assert.equal(cooling.trigger, null);
    const hot = planConsolidation({
      ...base,
      tokens: 41_000,
      turnsSinceThreshold: 1,
      cooldownTurns: 3,
    });
    assert.equal(hot.trigger, 'hard');
  });

  test('idle 不受冷却与 floor 限制', () => {
    const plan = planConsolidation({
      ...base,
      tokens: 24_100,
      lastHumanAt: NOW - 31 * 60_000,
      floorTokens: 24_000,
      turnsSinceThreshold: 0,
      cooldownTurns: 5,
    });
    assert.equal(plan.trigger, 'idle');
  });

  test('默认门槛仍是 24000，不传参也不炸', () => {
    const plan = planConsolidation({ tokens: DEFAULT_AT_TOKENS, overCount: 2, now: NOW });
    assert.equal(plan.trigger, 'threshold');
  });
});

describe('config.compact（A6）', () => {
  test('默认 4096 / 3 轮', () => {
    const cfg = normalizeConfig({});
    assert.equal(cfg.compact.minIncrementTokens, 4_096);
    assert.equal(cfg.compact.cooldownTurns, 3);
  });

  test('覆盖与越界', () => {
    const cfg = normalizeConfig({ compact: { minIncrementTokens: 1_024, cooldownTurns: 0 } });
    assert.equal(cfg.compact.minIncrementTokens, 1_024);
    assert.equal(cfg.compact.cooldownTurns, 0);
    assert.throws(() => normalizeConfig({ compact: { minIncrementTokens: 10 } }), /compact\.minIncrementTokens/);
    assert.throws(() => normalizeConfig({ compact: { cooldownTurns: -1 } }), /compact\.cooldownTurns/);
    assert.throws(() => normalizeConfig({ compact: { cooldownTurns: 51 } }), /compact\.cooldownTurns/);
    assert.throws(() => normalizeConfig({ compact: [] }), /compact/);
  });

  test('未知键只 warning，不阻断', () => {
    const cfg = normalizeConfig({ compact: { minIncrementTokens: 512, nope: 1 } });
    assert.equal(cfg.compact.minIncrementTokens, 512);
    assert.equal(
      cfg.warnings.some((w) => w.includes('compact.nope')),
      true,
    );
  });

  test('DEFAULTS 仍是 16 键安装自检口径', async () => {
    const { DEFAULTS } = await import('../src/config.js');
    assert.equal(Object.keys(DEFAULTS).length, 16);
  });
});

describe('/状态 的压缩底行（A6）', () => {
  let dir;
  let store;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-compact-line-'));
    store = Store.open(join(dir, 'companion.db'));
  });

  after(() => {
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = (compact) => {
    const result = handleCommand({
      text: '/状态',
      store,
      now: NOW,
      timeZone: 'Asia/Shanghai',
      compact,
    });
    return result.reply;
  };

  test('没有压过（无样本）时不输出该行', () => {
    assert.equal(ask({ floor: null, target: 24_000 }).includes('压缩底'), false);
    assert.equal(ask(undefined).includes('压缩底'), false);
  });

  test('有样本时给出水位、目标、门槛与冷却', () => {
    const reply = ask({
      floor: 38_800,
      target: 40_000,
      minIncrementTokens: 4_096,
      cooldownTurns: 3,
      over: null,
    });
    assert.match(reply, /压缩底：38800 tokens/);
    assert.match(reply, /目标 40000/);
    assert.match(reply, /增量门槛 4096/);
    assert.match(reply, /冷却 3 轮/);
    assert.equal(reply.includes('calibrate'), false);
  });

  test('压后仍超目标时给 calibrate 提示', () => {
    const reply = ask({
      floor: 41_000,
      target: 40_000,
      minIncrementTokens: 4_096,
      cooldownTurns: 3,
      over: { floor: 41_000, target: 40_000 },
    });
    assert.match(reply, /压后仍超目标，建议 calibrate/);
  });
});
