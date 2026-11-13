/**
 * v0.4.13 A3：worker token 预算接线（known-debt D-1 / N-M4 / W1）。
 *
 * 覆盖：
 * - 等待 idle 期间周期性采样；软线只投递一次收尾提示且继续等待；
 * - 硬线结束等待、两段式回收、reason=token_limit、回执 status=partial；
 * - 采样抛错不打断任务；硬超时与 token 截断 reason 不混淆；
 * - tokenMeter 能力缺失时零采样、零额外 prompt（与基线一致）；
 * - run.js 的 partial 对外映射与审计 reason；
 * - config.task 节默认值/覆盖/越界。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { createAdapter } from '../src/platform/adapter.js';
import {
  DEFAULT_SAMPLE_MS,
  createTaskRunner,
} from '../src/task/run.js';
import {
  DEFAULT_HARD_MS,
  DEFAULT_SAMPLE_MS as WORKER_SAMPLE_MS,
  DEFAULT_SOFT_MS,
  TOKEN_LIMIT_NOTE,
  runTask as runWorkerTask,
} from '../src/task/worker.js';
import {
  WORKER_STOP_TOKENS,
  WORKER_WARN_TOKENS,
  wrapUpPrompt,
} from '../src/task/limits.js';
import {
  ConfigError,
  DEFAULTS,
  normalizeConfig,
  normalizeTask,
} from '../src/config.js';

// ---------------------------------------------------------------- 测试辅助

/** 记录审计事件的最小 Store 替身。 */
function makeStore() {
  return {
    events: [],
    appendEvent(input) {
      this.events.push(input);
      return this.events.length;
    },
  };
}

/** 真实定时器下的短等待（采样间隔都很小，几十毫秒足够跑多轮）。 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 防止实现回归导致 await 永久挂起。 */
function withTimeout(promise, ms = 2_000) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test timed out')), ms);
      timer.unref?.();
    }),
  ]);
}

/** FakeCtx → adapter，并把 cancel/cleanInbox 包一层记录两段式顺序。 */
function makePlatform(ctx, order = []) {
  const base = createAdapter(ctx);
  return {
    ...base,
    cancel: (...args) => {
      order.push('cancel');
      return base.cancel(...args);
    },
    cleanInbox: (sessionId) => {
      order.push(`cleanInbox:${sessionId}`);
      return base.cleanInbox(sessionId);
    },
  };
}

/** 平台收到的全部 prompt 请求体。 */
function promptsOf(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => call.args[0]);
}

/** 回执事件（kind === 'task_receipt'）。 */
function receiptEventOf(store) {
  return store.events.find((event) => event.detail_json?.kind === 'task_receipt');
}

/** task_run 生命周期事件（kind === 'task_run'）。 */
function runEventOf(store) {
  return store.events.find((event) => event.detail_json?.kind === 'task_run');
}

// ---------------------------------------------------------------- worker 采样

describe('worker token sampling', () => {
  test('软线 60001：只投递一次收尾提示且继续等待', async () => {
    const ctx = new FakeCtx({
      deferIdle: true,
      returns: { 'tokenMeter.measure': { totalTokens: 60_001 } },
    });
    const platform = makePlatform(ctx);

    let settled = false;
    const running = runWorkerTask({
      platform,
      task: { id: 'task-token-warn', prompt: '把当前工作做到最小可交付' },
      softMs: 10_000,
      hardMs: 10_000,
      sampleMs: 2,
    });
    running.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await delay(60);

    // 采样确实在周期性发生（不止一次）。
    assert.ok(ctx.callsOf('tokenMeter.measure').length >= 2);
    // 任务还没结束：软线只是提醒。
    assert.equal(settled, false);

    const prompts = promptsOf(ctx);
    const wrapUps = prompts.filter((request) => String(request.content?.[0]?.text ?? '').includes('剩余预算约'));
    assert.equal(wrapUps.length, 1);
    assert.deepEqual(wrapUps[0].content, [{ type: 'text', text: wrapUpPrompt(80_000 - 60_001) }]);
    assert.match(String(wrapUps[0].content[0].text), /剩余预算约 19999 tokens/u);

    // 放行 idle：原任务照常完成，且没有第二次收尾提示。
    assert.equal(ctx.releaseIdle('session-fake-1'), true);
    const result = await withTimeout(running);
    assert.equal(result.status, 'ok');
    assert.equal(promptsOf(ctx).length, 2);
  });

  test('硬线 80001：两段式 cancel、reason=token_limit、回执部分完成', async () => {
    const ctx = new FakeCtx({
      deferIdle: true,
      returns: { 'tokenMeter.measure': { totalTokens: 80_001 } },
    });
    const order = [];
    const platform = makePlatform(ctx, order);
    const store = makeStore();

    const result = await withTimeout(runWorkerTask({
      platform,
      store,
      task: { id: 'task-token-stop', prompt: '做事', summary: '写了一半的方案' },
      softMs: 10_000,
      hardMs: 10_000,
      sampleMs: 2,
    }));

    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'token_limit');
    assert.equal(result.sessionId, 'session-fake-1');
    // 两段式回收：先 cancel 当前轮，再清空排队。
    assert.deepEqual(order, ['cancel', 'cleanInbox:session-fake-1']);
    // 硬线优先于软线：不投递收尾提示。
    assert.equal(promptsOf(ctx).length, 1);

    const receipt = receiptEventOf(store);
    assert.equal(receipt.detail_json.status, 'partial');
    assert.match(receipt.detail_json.text, /^状态：部分完成/u);
    assert.match(receipt.detail_json.text, /写了一半的方案/u);
    assert.ok(receipt.detail_json.text.includes(TOKEN_LIMIT_NOTE));
    assert.ok(Array.from(receipt.detail_json.text).length <= 300);
  });

  test('采样抛错：只记 debug，不影响完成', async () => {
    const ctx = new FakeCtx({ deferIdle: true });
    ctx.fail('tokenMeter.measure', new Error('meter down'));
    const platform = makePlatform(ctx);

    const running = runWorkerTask({
      platform,
      task: { id: 'task-token-broken', prompt: '做事' },
      softMs: 10_000,
      hardMs: 10_000,
      sampleMs: 2,
    });

    await delay(40);
    assert.ok(ctx.callsOf('tokenMeter.measure').length >= 1);
    assert.ok(ctx.logs.some((entry) => (
      entry.level === 'debug' && entry.message.includes('task token sample failed')
    )));

    assert.equal(ctx.releaseIdle('session-fake-1'), true);
    const result = await withTimeout(running);
    assert.equal(result.status, 'ok');
    // 采样失败不补发任何 prompt。
    assert.equal(promptsOf(ctx).length, 1);
  });

  test('硬超时与 token 上限 reason 不混淆', async () => {
    const timeoutCtx = new FakeCtx({ deferIdle: true });
    const timeoutResult = await withTimeout(runWorkerTask({
      platform: makePlatform(timeoutCtx),
      task: { id: 'task-timeout', prompt: '做事' },
      softMs: 5,
      hardMs: 25,
      sampleMs: 2,
    }));
    assert.equal(timeoutResult.status, 'timeout');
    assert.equal(timeoutResult.reason, 'timeout');

    const stopCtx = new FakeCtx({
      deferIdle: true,
      returns: { 'tokenMeter.measure': { totalTokens: 80_001 } },
    });
    const stopResult = await withTimeout(runWorkerTask({
      platform: makePlatform(stopCtx),
      task: { id: 'task-stop', prompt: '做事' },
      softMs: 5,
      hardMs: 25,
      sampleMs: 2,
    }));
    assert.equal(stopResult.status, 'partial');
    assert.equal(stopResult.reason, 'token_limit');
    assert.notEqual(timeoutResult.reason, stopResult.reason);
  });

  test('tokenMeter 能力缺失：零采样、零额外 prompt（基线行为）', async () => {
    const ctx = new FakeCtx({ deferIdle: true, missing: ['tokenMeter'] });
    const platform = makePlatform(ctx);
    assert.equal(platform.capabilities.tokenMeter, false);

    const running = runWorkerTask({
      platform,
      task: { id: 'task-no-meter', prompt: '做事' },
      softMs: 10_000,
      hardMs: 10_000,
      sampleMs: 2,
    });

    await delay(40);
    assert.equal(ctx.callsOf('tokenMeter.measure').length, 0);
    assert.equal(promptsOf(ctx).length, 1);

    assert.equal(ctx.releaseIdle('session-fake-1'), true);
    const result = await withTimeout(running);
    assert.equal(result.status, 'ok');
    assert.equal(result.reason, undefined);
  });

  test('默认参数来自 limits.js 与 5000ms 采样间隔', () => {
    assert.equal(WORKER_SAMPLE_MS, 5_000);
    assert.equal(DEFAULT_SAMPLE_MS, 5_000);
    assert.equal(WORKER_WARN_TOKENS, 60_000);
    assert.equal(WORKER_STOP_TOKENS, 80_000);
    assert.equal(DEFAULT_SOFT_MS, 600_000);
    assert.equal(DEFAULT_HARD_MS, 900_000);
  });

  test('非法 token 预算参数被拒绝', async () => {
    const ctx = new FakeCtx({ deferIdle: true });
    const platform = makePlatform(ctx);
    const task = { id: 'task-bad', prompt: '做事' };

    await assert.rejects(
      runWorkerTask({ platform, task, tokenWarn: 90_000, tokenStop: 80_000 }),
      RangeError,
    );
    await assert.rejects(
      runWorkerTask({ platform, task, tokenWarn: -1 }),
      TypeError,
    );
    await assert.rejects(
      runWorkerTask({ platform, task, sampleMs: 0 }),
      TypeError,
    );
    // 参数校验发生在建会话之前。
    assert.equal(ctx.callsOf('sessionController.create').length, 0);
  });
});

// ---------------------------------------------------------------- run.js 映射

describe('run.js partial 映射', () => {
  test('token 硬线 → status=partial、partial:true、reason、审计带 reason', async () => {
    const ctx = new FakeCtx({
      deferIdle: true,
      returns: { 'tokenMeter.measure': { totalTokens: 80_001 } },
    });
    const store = makeStore();
    const runner = createTaskRunner();

    const result = await withTimeout(runner.runTask({
      platform: makePlatform(ctx),
      store,
      goal: '把方案写到最小可交付',
      title: '半成品方案',
      limits: { softMs: 10_000, hardMs: 10_000, sampleMs: 2 },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'partial');
    assert.equal(result.partial, true);
    assert.equal(result.reason, 'token_limit');
    assert.match(result.receipt, /^状态：部分完成/u);
    assert.match(result.receipt, /半成品方案/u);
    assert.ok(result.receipt.includes(TOKEN_LIMIT_NOTE));

    const receipt = receiptEventOf(store);
    assert.equal(receipt.detail_json.status, 'partial');
    const runEvent = runEventOf(store);
    assert.equal(runEvent.reason, 'task_run:partial');
    assert.equal(runEvent.detail_json.status, 'partial');
    assert.equal(runEvent.detail_json.reason, 'token_limit');
  });

  test('默认成功路径字段形状不变（无 partial/reason）', async () => {
    const ctx = new FakeCtx();
    const store = makeStore();
    const runner = createTaskRunner();

    const result = await withTimeout(runner.runTask({
      platform: makePlatform(ctx),
      store,
      goal: '普通任务',
    }));

    assert.equal(result.status, 'done');
    assert.equal(Object.hasOwn(result, 'partial'), false);
    assert.equal(Object.hasOwn(result, 'reason'), false);
    assert.match(result.receipt, /^状态：成功/u);

    const runEvent = runEventOf(store);
    assert.equal(Object.hasOwn(runEvent.detail_json, 'reason'), false);
    assert.equal(store.events.length, 2);
  });

  test('limits 校验：tokenStop 必须大于 tokenWarn', async () => {
    const runner = createTaskRunner();
    await assert.rejects(
      runner.runTask({
        platform: makePlatform(new FakeCtx()),
        goal: '做事',
        limits: { tokenWarn: 90_000, tokenStop: 80_000 },
      }),
      /limits\.tokenStop must be greater than limits\.tokenWarn/u,
    );
  });
});

// ---------------------------------------------------------------- config

describe('config.task 节', () => {
  test('默认值与非枚举扩展节', () => {
    assert.equal(Object.keys(DEFAULTS).length, 16);
    assert.equal(Object.hasOwn(DEFAULTS, 'task'), true);
    assert.equal(Object.propertyIsEnumerable.call(DEFAULTS, 'task'), false);
    assert.deepEqual(Object.keys(DEFAULTS).includes('task'), false);

    const cfg = normalizeConfig({});
    assert.deepEqual(cfg.task, { tokenWarn: 60_000, tokenStop: 80_000, sampleMs: 5_000 });
    assert.equal(Object.isFrozen(cfg.task), true);
  });

  test('覆盖单个字段，其余走默认', () => {
    const cfg = normalizeConfig({ task: { tokenWarn: 70_000 } });
    assert.deepEqual(cfg.task, { tokenWarn: 70_000, tokenStop: 80_000, sampleMs: 5_000 });

    const full = normalizeTask({ tokenWarn: 10_000, tokenStop: 20_000, sampleMs: 1_000 });
    assert.deepEqual(full, { tokenWarn: 10_000, tokenStop: 20_000, sampleMs: 1_000 });
    assert.equal(normalizeTask(undefined), DEFAULTS.task);
  });

  test('越界抛 ConfigError 且字段名可定位', () => {
    const fieldError = (pattern) => (error) => (
      error instanceof ConfigError && pattern.test(error.message)
    );
    assert.throws(
      () => normalizeConfig({ task: { tokenWarn: 0 } }),
      fieldError(/^task\.tokenWarn: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { tokenWarn: 10_000_001 } }),
      fieldError(/^task\.tokenWarn: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { tokenStop: 1 } }),
      fieldError(/^task\.tokenStop: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { tokenWarn: 80_000, tokenStop: 80_000 } }),
      fieldError(/^task\.tokenStop: must be greater than task\.tokenWarn/u),
    );
    assert.throws(
      () => normalizeConfig({ task: { sampleMs: 0 } }),
      fieldError(/^task\.sampleMs: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { sampleMs: 99 } }),
      fieldError(/^task\.sampleMs: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { sampleMs: 600_001 } }),
      fieldError(/^task\.sampleMs: /u),
    );
    assert.throws(
      () => normalizeConfig({ task: { tokenWarn: 1.5 } }),
      fieldError(/^task\.tokenWarn: /u),
    );
  });

  test('task 节必须是 plain object；未知子字段只 warn', () => {
    const shapeError = (error) => (
      error instanceof ConfigError && /^task: must be a plain object/u.test(error.message)
    );
    assert.throws(() => normalizeConfig({ task: null }), shapeError);
    assert.throws(() => normalizeConfig({ task: [] }), shapeError);
    assert.throws(() => normalizeConfig({ task: 1 }), shapeError);

    const cfg = normalizeConfig({ task: { tokenWarn: 61_000, futureKnob: true } });
    assert.equal(cfg.task.tokenWarn, 61_000);
    assert.ok(cfg.warnings.includes('unknown config field "task.futureKnob" ignored'));
  });
});
