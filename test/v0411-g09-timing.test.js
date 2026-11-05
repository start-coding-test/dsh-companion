/**
 * G0-9（v0.4.11）：压缩/巩固耗时阈值、超阈值告警去重与 /状态 展示。
 *
 * 验收口径：压缩 p95 ≤ 20s、巩固 p95 ≤ 60s；阈值只做观测与告警，
 * **不设硬超时、不中止任务**。本文件覆盖：
 *   1) config.timing 默认值/校验（正整数毫秒，非法抛 ConfigError）；
 *   2) timing.js 的计时、格式化与告警去重/重置（含失败样本）；
 *   3) 直接调用 handleCommand 时 /状态 的两行耗时；
 *   4) 真实 apply() 路径：慢巩固 / 慢压缩仍成功、只告警一次、无中止；
 *      压缩失败也记录耗时并保持 pending_compact。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ConfigError, DEFAULTS, normalizeConfig } from '../src/config.js';
import {
  TIMING_KINDS,
  elapsedMs,
  formatSeconds,
  formatThresholdSeconds,
  formatTimingLines,
  formatTimingValue,
  nowMs,
  recordTimingSample,
} from '../src/runtime/timing.js';
import { handleCommand } from '../src/runtime/commands.js';
import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { TEST_NOW, makeTempStore, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** 巩固模型返回的草稿（与 apply-turn e2e 相同，便于断言写库成功）。 */
const DRAFT = {
  episode: {
    title: '预算调整',
    summary: '用户把项目预算调到 8000。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      salience: 'normal',
    },
  ],
  reminders: [],
};

/**
 * FakeCtx + commands/tools/llm；手动时钟可被巩固/压缩过程推进。
 * settings.streamDelayMs：巩固模型流开始前推进假时钟，模拟慢巩固。
 * @returns {{ctx: FakeCtx, streams: object[], session: object, settings: {streamDelayMs: number}}}
 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  const session = ctx.addSession({ id: 'session-1' });
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
  const streams = [];
  const settings = { streamDelayMs: 0 };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      if (settings.streamDelayMs > 0) ctx.advance(settings.streamDelayMs);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  // 41K tokens：hard 巩固阈值；需要避免重复巩固时测试再改回 1K。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return { ctx, streams, session, settings };
}

/** @param {FakeCtx} ctx @param {object} session @param {number} turn @param {string} text @param {number} [step] */
function turnPayload(ctx, session, turn, text, step = 1) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** @param {FakeCtx} ctx */
function statusOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  return registration.handler({ rawInput: '' }).text;
}

/** @param {FakeCtx} ctx @param {string} needle */
function warnLogs(ctx, needle) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && entry.message.includes(needle));
}

// ---------------------------------------------------------------- 配置

test('G0-9 配置：timing 默认压缩 20000ms / 巩固 60000ms，且不改变 16 键安装面', () => {
  assert.deepEqual({ ...DEFAULTS.timing }, { compactWarnMs: 20_000, consolidateWarnMs: 60_000 });
  assert.equal(Object.hasOwn(DEFAULTS, 'timing'), true, 'timing 应是 DEFAULTS 的隐藏节');
  assert.equal(Object.keys(DEFAULTS).includes('timing'), false, 'timing 不应进入 16 键安装面');
  assert.equal(Object.keys(DEFAULTS).length, 16);
  assert.equal(Object.isFrozen(DEFAULTS.timing), true);

  const config = normalizeConfig({});
  assert.equal(config.timing, DEFAULTS.timing, '未配置时应复用默认（冻结）节');
  assert.equal(config.timing.compactWarnMs, 20_000);
  assert.equal(config.timing.consolidateWarnMs, 60_000);
});

test('G0-9 配置：timing 可单独覆盖，未知子键只告警', () => {
  const config = normalizeConfig({ timing: { compactWarnMs: 5_000, extra: true } });
  assert.equal(config.timing.compactWarnMs, 5_000);
  assert.equal(config.timing.consolidateWarnMs, 60_000, '未覆盖的字段取默认');
  assert.equal(Object.isFrozen(config.timing), true);
  assert.ok(
    config.warnings.some((text) => text === 'unknown config field "timing.extra" ignored'),
    `应提示未知子键，实际 warnings=${JSON.stringify(config.warnings)}`,
  );
});

test('G0-9 配置：timing 非法值 fail-fast，字段名精确到 timing.*', () => {
  const cases = [
    [null, 'timing'],
    ['timing', 'timing'],
    [[], 'timing'],
    [{ compactWarnMs: 0 }, 'timing.compactWarnMs'],
    [{ compactWarnMs: -1 }, 'timing.compactWarnMs'],
    [{ compactWarnMs: 1.5 }, 'timing.compactWarnMs'],
    [{ compactWarnMs: '20000' }, 'timing.compactWarnMs'],
    [{ consolidateWarnMs: null }, 'timing.consolidateWarnMs'],
    [{ consolidateWarnMs: Number.NaN }, 'timing.consolidateWarnMs'],
  ];
  for (const [raw, field] of cases) {
    assert.throws(
      () => normalizeConfig({ timing: raw }),
      (error) => {
        assert.ok(error instanceof ConfigError, `应抛 ConfigError，实际 ${error?.name}`);
        assert.equal(error.field, field);
        return true;
      },
      `timing=${JSON.stringify(raw)} 应抛 ${field}`,
    );
  }
});

test('G0-9 配置：config.example.yml 只以注释形式给出 timing（不破坏 16 键自检）', () => {
  const example = readFileSync(new URL('../config.example.yml', import.meta.url), 'utf8');
  assert.match(example, /# timing:/u);
  assert.match(example, /# {3}compactWarnMs: 20000/u);
  assert.match(example, /# {3}consolidateWarnMs: 60000/u);
});

// ---------------------------------------------------------------- timing.js

test('G0-9 timing：秒级格式化、阈值与「（超阈值）」标注', () => {
  assert.equal(formatSeconds(null), '—');
  assert.equal(formatSeconds(12_340), '12.3s');
  assert.equal(formatSeconds(72_400), '72.4s');
  assert.equal(formatSeconds(70_000), '70.0s');

  assert.equal(formatThresholdSeconds(20_000), '20s');
  assert.equal(formatThresholdSeconds(60_000), '60s');
  assert.equal(formatThresholdSeconds(500), '0.5s');

  assert.equal(formatTimingValue(null, 60_000), '—');
  assert.equal(formatTimingValue(12_300, 60_000), '12.3s');
  assert.equal(formatTimingValue(72_400, 60_000), '72.4s（超阈值）');
  assert.equal(formatTimingValue(60_000, 60_000), '60.0s', '等于阈值不算超');
  assert.equal(formatTimingValue(72_400, undefined), '72.4s', '无阈值时只展示耗时');

  assert.deepEqual(
    formatTimingLines({
      lastCompactMs: 24_100,
      compactWarnMs: 20_000,
      lastConsolidateMs: 31_000,
      consolidateWarnMs: 60_000,
    }),
    ['最近压缩耗时：24.1s（超阈值）', '最近巩固耗时：31.0s'],
  );
  assert.deepEqual(formatTimingLines({}), ['最近压缩耗时：—', '最近巩固耗时：—']);
  assert.deepEqual(formatTimingLines(), ['最近压缩耗时：—', '最近巩固耗时：—']);
});

test('G0-9 timing：elapsedMs/nowMs 异常安全，坏时钟返回 null', () => {
  assert.equal(nowMs(() => 1_000), 1_000);
  assert.equal(nowMs(2_500), 2_500);
  assert.equal(nowMs(() => Number.NaN), null);
  assert.equal(nowMs(() => {
    throw new Error('clock boom');
  }), null);

  assert.equal(elapsedMs(() => 1_000, 250), 750);
  assert.equal(elapsedMs(() => 100, 250), 0, '时钟回拨时钳到 0');
  assert.equal(elapsedMs(() => 1_000, null), null);
  assert.equal(elapsedMs(() => {
    throw new Error('clock boom');
  }, 0), null);
});

test('G0-9 timing：超阈值同类只告警一次，低阈值样本后重置再次告警', () => {
  const logs = [];
  const state = { platform: { log: (...args) => logs.push(args) } };

  // 第一次超阈值：写一条 warn，记录最近耗时。
  const first = recordTimingSample(state, 'consolidate', 72_400, { warnMs: 60_000 });
  assert.deepEqual(first, { kind: 'consolidate', durationMs: 72_400, ok: true, over: true, warned: true });
  assert.equal(state.lastConsolidateMs, 72_400);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  assert.equal(logs[0][1], '[dsh-companion] consolidation took 72.4s (>60s)');
  assert.deepEqual(logs[0][2], { kind: 'consolidate', durationMs: 72_400, warnMs: 60_000, ok: true });

  // 同类再次超阈值：去重，不再刷屏，但最近耗时仍更新。
  const second = recordTimingSample(state, 'consolidate', 71_000, { warnMs: 60_000 });
  assert.equal(second.warned, false);
  assert.equal(second.over, true);
  assert.equal(logs.length, 1);
  assert.equal(state.lastConsolidateMs, 71_000);

  // 低于阈值的一次样本：重置去重标记（等于阈值也算重置）。
  const fast = recordTimingSample(state, 'consolidate', 31_000, { warnMs: 60_000 });
  assert.equal(fast.warned, false);
  assert.equal(fast.over, false);
  assert.equal(state.consolidateSlowWarned, false);

  // 再次超阈值：重新告警。
  const third = recordTimingSample(state, 'consolidate', 65_000, { warnMs: 60_000 });
  assert.equal(third.warned, true);
  assert.equal(logs.length, 2);
  assert.equal(logs[1][1], '[dsh-companion] consolidation took 65.0s (>60s)');

  // 等于阈值不告警，但同样重置。
  recordTimingSample(state, 'consolidate', 66_000, { warnMs: 60_000 });
  const atThreshold = recordTimingSample(state, 'consolidate', 60_000, { warnMs: 60_000 });
  assert.equal(atThreshold.over, false);
  assert.equal(state.consolidateSlowWarned, false);
});

test('G0-9 timing：压缩/巩固去重标记互相独立，失败样本带 ok:false 仍算耗时', () => {
  const logs = [];
  const state = { platform: { log: (...args) => logs.push(args) } };

  recordTimingSample(state, 'consolidate', 70_000, { warnMs: 60_000 });
  assert.equal(logs.length, 1);

  const compact = recordTimingSample(state, 'compact', 25_000, { ok: false, warnMs: 20_000 });
  assert.deepEqual(compact, { kind: 'compact', durationMs: 25_000, ok: false, over: true, warned: true });
  assert.equal(state.lastCompactMs, 25_000);
  assert.equal(state.lastConsolidateMs, 70_000);
  assert.equal(logs.length, 2);
  assert.equal(logs[1][1], '[dsh-companion] compaction took 25.0s (>20s)');
  assert.deepEqual(logs[1][2], { kind: 'compact', durationMs: 25_000, warnMs: 20_000, ok: false });
});

test('G0-9 timing：采样异常安全（坏 state/耗时/日志都不影响主流程）', () => {
  assert.equal(recordTimingSample(null, 'compact', 1_000, { warnMs: 1 }), null);
  assert.equal(recordTimingSample({}, 'unknown-kind', 1_000, { warnMs: 1 }), null);
  assert.equal(recordTimingSample({}, 'compact', Number.NaN, { warnMs: 1 }), null);
  assert.equal(recordTimingSample({}, 'compact', -1, { warnMs: 1 }), null);

  // 没有 platform.log 时不抛错，只记录耗时。
  const bare = {};
  const result = recordTimingSample(bare, 'compact', 25_000, { warnMs: 20_000 });
  assert.equal(result.warned, true);
  assert.equal(bare.lastCompactMs, 25_000);

  // 日志本身抛错也不影响采样结果。
  const broken = { platform: { log: () => { throw new Error('log boom'); } } };
  assert.doesNotThrow(() => recordTimingSample(broken, 'consolidate', 70_000, { warnMs: 60_000 }));
  assert.equal(broken.lastConsolidateMs, 70_000);

  assert.deepEqual(TIMING_KINDS.compact, {
    label: 'compaction',
    lastField: 'lastCompactMs',
    warnedField: 'compactSlowWarned',
  });
});

// ---------------------------------------------------------------- /状态

test('G0-9 /状态：传入 timing 时追加两行；未传时保持旧格式', () => {
  const temp = makeTempStore();
  try {
    const withTiming = handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      timing: {
        lastCompactMs: 24_100,
        lastConsolidateMs: 31_000,
        compactWarnMs: 20_000,
        consolidateWarnMs: 60_000,
      },
    });
    assert.equal(withTiming.handled, true);
    assert.match(withTiming.reply, /最近压缩耗时：24\.1s（超阈值）/u);
    assert.match(withTiming.reply, /最近巩固耗时：31\.0s/u);
    assert.match(withTiming.reply, /水位 main：/u);

    const withoutTiming = handleCommand({ text: '/状态', store: temp.store, now: TEST_NOW });
    assert.doesNotMatch(withoutTiming.reply, /最近压缩耗时/u);
    assert.doesNotMatch(withoutTiming.reply, /最近巩固耗时/u);
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- e2e

test('G0-9 e2e：慢巩固只写一条 warn、/状态 标注超阈值，巩固照常成功且不中止', async () => {
  const temp = makeTempStore();
  const { ctx, streams, session, settings } = makeApplyCtx();
  // 巩固模型耗时 70s：超过默认 60s 阈值，但不设硬超时。
  settings.streamDelayMs = 70_000;
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14, retainTokens: 4 });
  try {
    const decision = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'),
      { kind: 'enter', messages: [] },
    );
    assert.ok(decision, '慢巩固不应中止 pre-step');
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'slow consolidation' });

    // 巩固仍成功：事实落库、状态板 staged、无失败事件。
    const facts = temp.store.listFacts({ scope: 'main', status: 'active' });
    assert.equal(facts.length, 1);
    assert.match(facts[0].statement, /8000/u);
    assert.ok(temp.store.getBoardState('main').staged_revision >= 1);
    assert.equal(streams.length, 1);

    const warns = warnLogs(ctx, 'consolidation took');
    assert.equal(warns.length, 1, `只应告警一次，实际 ${JSON.stringify(warns)}`);
    assert.equal(warns[0].message, '[dsh-companion] consolidation took 70.0s (>60s)');
    assert.deepEqual(warns[0].meta, { kind: 'consolidate', durationMs: 70_000, warnMs: 60_000, ok: true });

    const status = statusOf(ctx);
    assert.match(status, /最近巩固耗时：70\.0s（超阈值）/u);
    assert.match(status, /最近压缩耗时：—/u, '还没有压缩样本时应显示 —');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('G0-9 e2e：慢压缩只写一条 warn、/状态 标注超阈值，压缩照常完成', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14, retainTokens: 4 });
  try {
    // turn 1：正常巩固，登记 pending_compact。
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'consolidation' });

    // turn 2 不再触发巩固；让 compactRegion 走 25s（超过默认 20s 阈值）。
    ctx.returns['tokenMeter.measure'] = {
      logRevision: 2,
      baseline: null,
      surfaceDeltaTokens: 10,
      totalTokens: 1_000,
      surfaceTokens: 1_000,
      nodes: [],
    };
    const original = ctx.compaction.compactRegion;
    let compactCalls = 0;
    ctx.compaction.compactRegion = (start, end, agent, signal) => {
      compactCalls += 1;
      ctx.advance(25_000);
      return original(start, end, agent, signal);
    };

    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '现在预算额度是多少？'), {
      kind: 'enter',
      messages: [],
    });

    // 压缩仍成功：区间被替换、水位改写、状态板发布。
    // 本用例只在 turn1 发过一条消息，压缩前 surface 为 [1,2]；替换节点 seq=3。
    assert.equal(compactCalls, 1);
    assert.deepEqual(session.surface.nodes, [2, 3]);
    assert.equal(temp.store.getWatermark('main'), 3);
    assert.ok(temp.store.getBoardState('main').revision >= 1);
    assert.match(temp.store.getBoard('main'), /8000/u);

    const warns = warnLogs(ctx, 'compaction took');
    assert.equal(warns.length, 1, `只应告警一次，实际 ${JSON.stringify(warns)}`);
    assert.equal(warns[0].message, '[dsh-companion] compaction took 25.0s (>20s)');
    assert.deepEqual(warns[0].meta, { kind: 'compact', durationMs: 25_000, warnMs: 20_000, ok: true });

    const status = statusOf(ctx);
    assert.match(status, /最近压缩耗时：25\.0s（超阈值）/u);
    assert.match(status, /最近巩固耗时：0\.0s/u, '正常巩固样本不标超阈值');
    assert.doesNotMatch(status, /最近巩固耗时：0\.0s（超阈值）/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('G0-9 e2e：压缩失败也记录耗时并保持 pending_compact，不中止后续 pre-step', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14, retainTokens: 4 });
  try {
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'consolidation' });

    ctx.returns['tokenMeter.measure'] = {
      logRevision: 2,
      baseline: null,
      surfaceDeltaTokens: 10,
      totalTokens: 1_000,
      surfaceTokens: 1_000,
      nodes: [],
    };
    let compactCalls = 0;
    ctx.compaction.compactRegion = () => {
      compactCalls += 1;
      ctx.advance(25_000);
      throw new Error('compact boom');
    };

    // 失败不抛出到 pre-step（无 abort）：dispatch 正常返回。
    await assert.doesNotReject(
      ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '现在预算额度是多少？'), {
        kind: 'enter',
        messages: [],
      }),
      '压缩失败必须被吞掉，不能中止本轮',
    );

    assert.equal(compactCalls, 1);
    assert.equal(temp.store.getBoard('main'), '', '失败时不应发布状态板');
    const status = statusOf(ctx);
    assert.match(status, /最近压缩耗时：25\.0s（超阈值）/u);
    assert.match(status, /待压缩 1 个区间/u, '失败后应保留 pending_compact');

    const warns = warnLogs(ctx, 'compaction took');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].meta.ok, false, '失败样本只影响日志标注');
    assert.equal(warns[0].meta.durationMs, 25_000);
    assert.ok(
      warnLogs(ctx, 'compactRegion failed; keeping pending_compact').length >= 1,
      '原失败日志仍应保留',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
