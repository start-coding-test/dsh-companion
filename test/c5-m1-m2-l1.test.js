/**
 * C5-M1 / C5-M2 / C5-L1 专项回归。
 *
 * - C5-M1：/状态 三种压缩态文案（宿主未开启 / 已开启 / 已开启且有带压缩区间）；
 * - C5-M2：投递失败与巩固跳过升到 warn，且同一原因只打一次（fake logger 计数）；
 * - C5-L1：宿主不支持线程时 /线程 给出与 /状态 一致的提示，不返回空目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { handleCommand } from '../src/runtime/commands.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const THREADS_UNSUPPORTED = '线程：宿主不支持（无 sessionController，未注册 thread_run/task_run/thread_*）';

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
function makeCtx({ now = TEST_NOW } = {}) {
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

function dueReminder(store, title, nowMs = TEST_NOW) {
  const nowSeconds = toEpochSeconds(nowMs);
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nowSeconds - 60,
    next_fire_at: nowSeconds - 60,
    due_granularity: 'exact',
  });
}

async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

function warnLogs(ctx, pattern) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && pattern.test(entry.message));
}

function statusText(ctx) {
  const definition = ctx.commands.registrations.find((entry) => entry.definitionId === 'dsh-companion/command-status');
  assert.ok(definition, 'status 命令应已注册');
  return definition.handler({ rawInput: '' }).text;
}

function hardMeasure() {
  return {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
}

function userEvent(text, seq) {
  return {
    seq,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

// --------------------------------------------------------------- C5-M1

test('C5-M1：/状态 三种压缩态文案', () => {
  const temp = makeTempStore();
  try {
    const base = {
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      timeZone: 'Asia/Shanghai',
    };
    const disabled = handleCommand({ ...base, compactionSupported: false }).reply;
    assert.match(disabled, /压缩：宿主未开启（compaction-basic 未启用）/u);
    assert.doesNotMatch(disabled, /压缩：宿主已开启/u);

    const enabled = handleCommand({ ...base, compactionSupported: true, pendingCompactions: 0 }).reply;
    assert.match(enabled, /压缩：宿主已开启（compaction-basic 已启用）/u);
    assert.doesNotMatch(enabled, /待压缩/u);

    const pending = handleCommand({ ...base, compactionSupported: true, pendingCompactions: 3 }).reply;
    assert.match(pending, /压缩：宿主已开启（compaction-basic 已启用），待压缩 3 个区间/u);

    // 未提供能力位（旧调用方）时不显示这一行，保持旧快照兼容。
    const unknown = handleCommand(base).reply;
    assert.doesNotMatch(unknown, /压缩：/u);
  } finally {
    temp.cleanup();
  }
});

// --------------------------------------------------------------- C5-L1

test('C5-L1：宿主不支持线程时 /线程 与 /状态 用同一句提示', () => {
  const temp = makeTempStore();
  try {
    const result = handleCommand({
      text: '/线程',
      store: temp.store,
      now: TEST_NOW,
      timeZone: 'Asia/Shanghai',
      threadsSupported: false,
    });
    assert.equal(result.handled, true);
    assert.equal(result.reply, THREADS_UNSUPPORTED);
    assert.doesNotMatch(result.reply, /线程目录/u);

    // 有线程数据时也一样：不支持就直接说明原因，不查库、不返回空目录。
    temp.store.upsertThread({
      key: 'rent',
      name: '租房',
      session_id: 's-rent',
      description: '找房子',
      last_active_at: Math.floor(TEST_NOW / 1000),
    });
    const again = handleCommand({
      text: '/线程',
      store: temp.store,
      now: TEST_NOW,
      timeZone: 'Asia/Shanghai',
      threadsSupported: false,
    });
    assert.equal(again.reply, THREADS_UNSUPPORTED);
  } finally {
    temp.cleanup();
  }
});

// --------------------------------------------------------------- C5-M2

test('C5-M2：投递失败 warn 只打一次（同一原因）', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  dueReminder(temp.store, '交房租');
  ctx.fail('sessionController.prompt', new TypeError('signal.throwIfAborted is not a function'));

  await firstTick(ctx);
  await firstTick(ctx);

  const warns = warnLogs(ctx, /proactive delivery failed/u);
  assert.equal(warns.length, 1, '连续两个 tick 同一失败原因只 warn 一次');
  assert.match(warns[0].meta?.reason ?? '', /TypeError: signal\.throwIfAborted is not a function/u);
  // 事件表仍按每次失败记录，/状态「最近失败」不受日志去重影响。
  const errors = temp.store
    .listEvents({ limit: 200 })
    .filter((row) => row.reason === 'delivery_error');
  assert.equal(errors.length, 2);
});

test('C5-M2：巩固跳过（无可用模型）warn 只打一次，且 /状态 仍显示无可用模型', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-no-llm',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.returns['tokenMeter.measure'] = hardMeasure();
  const dispatch = () => ctx.dispatch(
    'agent/pre-step',
    {
      agent: { id: session.id, session },
      messages: [{ role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] }],
      turn: { id: `turn-${Math.random()}` },
      step: 1,
    },
    { kind: 'enter', messages: [] },
  );

  await dispatch();
  await waitFor(
    () => warnLogs(ctx, /consolidation skipped: no model available/u).length > 0,
    { label: 'consolidation no-model warn' },
  );
  await settle(50);
  await dispatch();
  await settle(80);

  const warns = warnLogs(ctx, /consolidation skipped: no model available/u);
  assert.equal(warns.length, 1, '同一 skip 原因只 warn 一次');
  assert.match(statusText(ctx), /巩固：无可用模型/u);
});
