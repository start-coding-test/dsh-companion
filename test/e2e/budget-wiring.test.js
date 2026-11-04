/**
 * M4 e2e：走真实 apply() 接线，验证每日 token 熔断与 RSS 降级。
 *
 * 不联网、不读真实时钟；token 读数通过覆盖 FakeCtx.tokenMeter.measure 注入，
 * RSS 通过 ctx.rssReader 注入。scheduler 的 tick 由 ctx.fireTimers 驱动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { makeTempStore, settle, waitFor } from './helpers.js';

const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DAILY_LIMIT = 3_000_000;
// 2026-01-02 00:30 +08:00：避开每日 03:00/03:30/04:00 的 catch-up 窗口。
const NOW = Date.parse('2026-01-02T00:30:00+08:00');

/** apply 需要的 commands/tools/llm 三个平台服务。 */
function makeApplyCtx({ now = NOW } = {}) {
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
    listProviders: () => [],
    listModels: () => [],
    async *stream() {
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  return ctx;
}

/** @param {FakeCtx} ctx @param {string} name */
function command(ctx, name) {
  const registration = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(registration, `command ${name} should be registered`);
  return registration.handler({ rawInput: '' });
}

/** @param {FakeCtx} ctx @param {string} name */
function tool(ctx, name) {
  const registration = ctx.tools.registrations.find((entry) => entry.name === name);
  assert.ok(registration, `tool ${name} should be registered`);
  return registration;
}

/** @param {FakeCtx} ctx @param {object} session @param {number} turn */
function preStepPayload(ctx, session, turn) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text: `turn ${turn}` }] }],
    turn,
    step: 1,
  };
}

/** @param {object} session @param {number} turn */
function turnStoppingPayload(session, turn) {
  return { agent: { id: session.id, session }, turn };
}

test('每日 token 熔断：拒绝 task_run、停主动、命令展示、跨日复位', async (t) => {
  const temp = makeTempStore();
  const ctx = makeApplyCtx();
  const session = ctx.addSession({ id: 'session-budget', nodes: [] });
  let total = 0;
  ctx.tokenMeter.measure = () => ({
    totalTokens: total,
    surfaceDeltaTokens: 0,
    nodes: [],
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // 首步只建基线（0 token），不应触发熔断。
  await ctx.dispatch('agent/pre-step', preStepPayload(ctx, session, 1), {
    kind: 'enter',
    messages: [],
  });
  assert.doesNotMatch(command(ctx, 'cost').text, /已熔断/u);

  // turn 结束：本会话累计 3.1M，越过 3M 日配额。
  total = DAILY_LIMIT + 100_000;
  await ctx.dispatch('agent/turn-stopping', turnStoppingPayload(session, 1));

  const cost = command(ctx, 'cost');
  assert.match(cost.text, /今日配额 3100000 \/ 3000000/u);
  assert.match(cost.text, /已熔断/u);

  const status = command(ctx, 'status');
  assert.match(status.text, /今日 3100000\/3000000（已熔断）/u);
  assert.match(status.text, /RSS ok 0MB/u);

  const taskRun = tool(ctx, 'task_run');
  assert.deepEqual(await taskRun.execute({ goal: '整理今天的记录' }), {
    ok: false,
    reason: 'daily_budget_exceeded',
  });

  // 熔断期间主动任务不投递：到点提醒保持 pending。
  const reminder = temp.store.insertReminder({
    scope: 'main',
    kind: 'todo',
    title: '熔断期提醒',
    next_fire_at: Math.floor(NOW / 1000),
  });
  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  assert.equal(temp.store.getReminder(reminder.id).status, 'pending');

  // 跨本地日界：自动复位，提醒恢复投递。
  ctx.advance(DAY_MS);
  await ctx.fireTimers(1);
  await waitFor(() => temp.store.getReminder(reminder.id).status === 'fired', {
    label: 'reminder fired after daily reset',
  });
  const recovered = command(ctx, 'cost');
  assert.doesNotMatch(recovered.text, /已熔断/u);
  assert.match(recovered.text, /今日配额 0 \/ 3000000/u);

  // 熔断解除后任务入口恢复：不再因日预算被拒。
  const recoveredTask = await tool(ctx, 'task_run').execute({ goal: '跨日恢复后的任务' });
  assert.notEqual(recoveredTask.reason, 'daily_budget_exceeded');
});

test('RSS main_only：停 task_run/线程创建，恢复后自动解除', async (t) => {
  const temp = makeTempStore();
  const ctx = makeApplyCtx();
  let rss = 3.2 * GIB;
  ctx.rssReader = () => rss;

  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);

  const status = command(ctx, 'status');
  assert.match(status.text, /RSS main_only 3276\.8MB/u);

  const taskRun = tool(ctx, 'task_run');
  assert.deepEqual(await taskRun.execute({ goal: '整理今天的记录' }), {
    ok: false,
    reason: 'memory_pressure',
  });

  const threadRun = tool(ctx, 'thread_run');
  const blocked = await threadRun.execute({ key: 'new', name: '压力测试线程' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'memory_main_only');

  // 内存回落后下一轮 60s 检查自动解除 main_only。
  rss = 100 * 1024 ** 2;
  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  assert.match(command(ctx, 'status').text, /RSS ok 100MB/u);

  const unblocked = await threadRun.execute({ key: 'new', name: '恢复后的线程' });
  assert.notEqual(unblocked.reason, 'memory_main_only');
});

test('RSS 三档可配置：2.2/2.4/2.6 驱动 warn→stop_dispatch→main_only', async (t) => {
  const temp = makeTempStore();
  const ctx = makeApplyCtx();
  let rss = 2.25 * GIB;
  ctx.rssReader = () => rss;

  const handle = apply(ctx, {
    dbPath: temp.dbPath,
    threadIdleDays: 14,
    rssWarnGiB: 2.2,
    rssStopGiB: 2.4,
    rssMainOnlyGiB: 2.6,
  });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  const warned = command(ctx, 'status').text;
  assert.match(warned, /RSS warn 2304MB/u);
  assert.match(warned, /RSS 阈值：warn 2\.2GiB \/ stop 2\.4GiB \/ main_only 2\.6GiB/u);

  // 2.45GiB 在默认阈值下还是 ok；配置后已是 stop_dispatch，task_run 被拒。
  rss = 2.45 * GIB;
  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  assert.match(command(ctx, 'status').text, /RSS stop_dispatch 2508\.8MB/u);
  assert.deepEqual(await tool(ctx, 'task_run').execute({ goal: '云端 stop 档任务' }), {
    ok: false,
    reason: 'memory_pressure',
  });

  rss = 2.65 * GIB;
  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  assert.match(command(ctx, 'status').text, /RSS main_only 2713\.6MB/u);
  const blocked = await tool(ctx, 'thread_run').execute({ key: 'new', name: '云端小内存线程' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'memory_main_only');

  // 回落到 warn 以下自动恢复 ok。
  rss = 2.1 * GIB;
  ctx.advance(MINUTE_MS);
  await ctx.fireTimers(1);
  await settle(50);
  assert.match(command(ctx, 'status').text, /RSS ok 2150\.4MB/u);
});
