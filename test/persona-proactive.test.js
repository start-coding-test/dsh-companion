/**
 * V11-P1b（v0.4.12）：内置默认卡也参与 proactive 配置冲突告警。
 *
 * 背景：t1 只对用户卡（persona.cardPath）做 `proactive.*` 与配置的重复项告警；
 * 用户清单第 ⑤ 条要求「两边不一致时写一条 warn」，未排除内置卡。内置卡
 * proactive 值等于默认配置（dailyCap 3 / quietStart 23:00 / quietEnd 08:00），
 * 因此只有用户改过配置才会不一致——此时正需要提醒卡里的同名字段被配置覆盖。
 *
 * 覆盖：
 *   a) 未配置 persona 且配置为默认 → 无 proactive 冲突告警（回归保护）；
 *   b) 未配置 persona 但 proactiveDailyCap=2 → 恰好一条 warn，含「内置默认」与两边取值；
 *   c) persona.cardPath 指向 dailyCap=5 的卡而配置 proactiveDailyCap=2 → 沿用文件卡文案、
 *      meta 带解析后路径；
 *   d) quietStart/quietEnd 不一致同样告警，字段名与两边取值可读。
 *
 * 本文件只验证告警，不重复 t1 的加载/兜底与 /状态 用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { normalizeConfig } from '../src/config.js';
import { DEFAULT_CARD, personaProactiveConflicts } from '../src/persona/card.js';
import { TEST_NOW, makeTempStore } from './e2e/helpers.js';

/** 文件卡沿用既有英文事件文案，内置卡用中文说明；两者都含 proactive 字段名。 */
function conflictWarns(ctx) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && /proactive/u.test(entry.message));
}

/**
 * apply 所需的最小 FakeCtx：commands/tools 记录器 + llm + tokenMeter 返回值。
 * 本文件不驱动 turn，只需 apply 成功完成人格卡接线。
 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
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
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream() {
      throw new Error('proactive 冲突告警测试不应调用模型');
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

/**
 * @param {object} config 额外配置项（persona/proactiveDailyCap/quietStart/quietEnd）
 * @returns {{temp: {dbPath: string, cleanup: () => void}, ctx: FakeCtx, handle: {dispose: () => void}}}
 */
function applyWithConfig(config) {
  const temp = makeTempStore();
  const ctx = makeApplyCtx();
  const handle = applyCordis(ctx, { dbPath: temp.dbPath, ...config });
  return { temp, ctx, handle };
}

test('V11-P1b 内置卡 + 默认配置：proactive 完全一致时不告警', () => {
  const normalized = normalizeConfig({});
  assert.deepEqual(
    personaProactiveConflicts(DEFAULT_CARD, normalized),
    [],
    '内置卡 proactive 值与默认配置一致，不应被判为冲突',
  );

  const { temp, ctx, handle } = applyWithConfig({});
  try {
    assert.deepEqual(conflictWarns(ctx), [], '默认配置下不应出现 proactive 冲突告警');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V11-P1b 内置卡 + proactiveDailyCap=2：一条 warn 含「内置默认」与两边取值', () => {
  const { temp, ctx, handle } = applyWithConfig({ proactiveDailyCap: 2 });
  try {
    const warns = conflictWarns(ctx);
    assert.equal(warns.length, 1, `应恰好一条 proactive 冲突告警，实际 ${JSON.stringify(ctx.logs)}`);
    assert.match(warns[0].message, /人格卡（内置默认）/u);
    assert.match(warns[0].message, /proactive\.dailyCap=3/u);
    assert.match(warns[0].message, /proactiveDailyCap=2/u);
    assert.match(warns[0].message, /以配置为准/u);
    assert.equal(warns[0].meta.path, null, '内置卡没有文件路径');
    assert.equal(warns[0].meta.source, 'builtin');
    assert.deepEqual(warns[0].meta.fields, ['proactive.dailyCap≠proactiveDailyCap']);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V11-P1b 用户卡 + 配置不一致：沿用文件卡文案且 meta 带解析后路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-persona-proactive-'));
  const cardPath = join(dir, 'card.json');
  writeFileSync(cardPath, JSON.stringify({
    name: '阿岩',
    address: '您',
    tone: { style: '简洁', warmth: '温和', structure: '先结论' },
    proactive: { dailyCap: 5 },
  }), 'utf8');

  const { temp, ctx, handle } = applyWithConfig({ persona: { cardPath }, proactiveDailyCap: 2 });
  try {
    const warns = conflictWarns(ctx);
    assert.equal(warns.length, 1, `应恰好一条 proactive 冲突告警，实际 ${JSON.stringify(ctx.logs)}`);
    assert.equal(
      warns[0].message,
      '[dsh-companion] persona card proactive settings conflict with config; config wins',
      '文件卡应沿用既有英文事件文案',
    );
    assert.equal(warns[0].meta.path, cardPath);
    assert.deepEqual(warns[0].meta.fields, ['proactive.dailyCap≠proactiveDailyCap']);
  } finally {
    handle.dispose();
    temp.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V11-P1b quietStart/quietEnd 不一致：字段名与两边取值可读', () => {
  const { temp, ctx, handle } = applyWithConfig({ quietStart: '22:00', quietEnd: '07:30' });
  try {
    const warns = conflictWarns(ctx);
    assert.equal(warns.length, 1, `应恰好一条 proactive 冲突告警，实际 ${JSON.stringify(ctx.logs)}`);
    const message = warns[0].message;
    assert.match(message, /proactive\.quietStart=23:00/u);
    assert.match(message, /quietStart=22:00/u);
    assert.match(message, /proactive\.quietEnd=08:00/u);
    assert.match(message, /quietEnd=07:30/u);
    assert.deepEqual(warns[0].meta.fields, [
      'proactive.quietStart≠quietStart',
      'proactive.quietEnd≠quietEnd',
    ]);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
