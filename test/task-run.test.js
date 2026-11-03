/**
 * task_run 执行器测试（H6）：全局单槽、排队与忙拒绝、软/硬超时、回执与审计、
 * 工具 schema 校验、adapter 的 cleanInbox/whenIdle(sessionId) 兼容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { createAdapter } from '../src/platform/adapter.js';
import { createTools } from '../src/runtime/tools.js';
import {
  DEFAULT_HARD_MS,
  DEFAULT_SOFT_MS,
  GOAL_MAX_CHARS,
  MAX_QUEUE,
  TITLE_MAX_CHARS,
  createTaskRunner,
} from '../src/task/run.js';
import { RECEIPT_MAX_CHARS } from '../src/task/receipt.js';

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

/** 让出若干个事件循环轮次，等待异步链路推进。 */
function tick(times = 2) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  }
  return chain;
}

function makePlatform(ctx, overrides = {}) {
  return { ...createAdapter(ctx), ...overrides };
}

test('超时与队列常量：软 600s、硬 900s、队列 2、goal 2000、title 80', () => {
  assert.equal(DEFAULT_SOFT_MS, 600_000);
  assert.equal(DEFAULT_HARD_MS, 900_000);
  assert.equal(MAX_QUEUE, 2);
  assert.equal(GOAL_MAX_CHARS, 2000);
  assert.equal(TITLE_MAX_CHARS, 80);
});

test('成功路径：createSession → prompt → whenIdle，返回 done 与 ≤300 字回执', async () => {
  const ctx = new FakeCtx();
  const platform = makePlatform(ctx);
  const store = makeStore();
  const runner = createTaskRunner();

  const result = await runner.runTask({
    platform,
    store,
    goal: '写一份周报',
    title: '周报',
    at: Date.UTC(2026, 10, 4, 9, 0, 0),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.equal(result.sessionId, 'session-fake-1');
  assert.match(result.taskId, /^task-/);
  assert.match(result.receipt, /^状态：成功/);
  assert.match(result.receipt, /周报/);
  assert.ok(Array.from(result.receipt).length <= RECEIPT_MAX_CHARS);

  // 调用顺序：createSession → prompt → whenIdle
  const order = ctx.calls.map((call) => call.method);
  const created = order.indexOf('sessionController.createSession');
  const prompted = order.indexOf('sessionController.prompt');
  const idled = order.indexOf('agent.whenIdle');
  assert.ok(created >= 0 && prompted > created && idled > prompted, `order=${order.join(',')}`);

  // prompt 形状：sessionId + 单个 text 块，内容是 goal
  const [promptRequest] = ctx.callsOf('sessionController.prompt')[0].args;
  assert.deepEqual(promptRequest.content, [{ type: 'text', text: '写一份周报' }]);

  // 两条审计：回执（task_receipt）+ 生命周期（task_run）
  assert.equal(store.events.length, 2);
  const receiptEvent = store.events.find((event) => event.detail_json.kind === 'task_receipt');
  const runEvent = store.events.find((event) => event.detail_json.kind === 'task_run');
  assert.equal(receiptEvent.action, 'USED');
  assert.equal(receiptEvent.actor, 'scheduler');
  assert.equal(receiptEvent.detail_json.status, 'ok');
  assert.equal(runEvent.reason, 'task_run:done');
  assert.equal(runEvent.detail_json.status, 'done');
  assert.equal(runEvent.detail_json.title, '周报');
  assert.equal(runEvent.detail_json.taskId, result.taskId);
  assert.deepEqual(runner.stats(), { active: 0, queued: 0, finished: 1, maxExec: 1, maxQueue: 2 });
});

test('全局单槽：忙时排队，不并发创建第二个 worker', async () => {
  const ctx = new FakeCtx({ deferIdle: true });
  const platform = makePlatform(ctx);
  const runner = createTaskRunner();

  const first = runner.runTask({ platform, goal: '任务一' });
  await tick();
  assert.equal(ctx.callsOf('sessionController.createSession').length, 1);

  const second = runner.runTask({ platform, goal: '任务二' });
  await tick();
  // 第二件还在队列里：没有创建新会话
  assert.equal(ctx.callsOf('sessionController.createSession').length, 1);
  assert.equal(runner.stats().queued, 1);

  ctx.releaseIdle('session-fake-1');
  const firstResult = await first;
  assert.equal(firstResult.status, 'done');

  await tick();
  assert.equal(ctx.callsOf('sessionController.createSession').length, 2);
  ctx.releaseIdle('session-fake-2');
  const secondResult = await second;
  assert.equal(secondResult.status, 'done');
  assert.equal(runner.stats().active, 0);
  assert.equal(runner.stats().finished, 2);
});

test('队列上限 2：第 4 个请求直接 busy，不建会话', async () => {
  const ctx = new FakeCtx({ deferIdle: true });
  const platform = makePlatform(ctx);
  const runner = createTaskRunner();

  const running = runner.runTask({ platform, goal: '运行中' });
  await tick();
  const queuedA = runner.runTask({ platform, goal: '排队 A' });
  const queuedB = runner.runTask({ platform, goal: '排队 B' });
  await tick();
  assert.equal(runner.stats().queued, 2);

  const rejected = await runner.runTask({ platform, goal: '被拒绝' });
  assert.deepEqual(rejected, { ok: false, reason: 'busy', queue: 2 });
  assert.equal(ctx.callsOf('sessionController.createSession').length, 1);

  // 收尾：依次放行，避免悬挂的 promise。
  ctx.releaseIdle('session-fake-1');
  await running;
  await tick();
  ctx.releaseIdle('session-fake-2');
  await queuedA;
  await tick();
  ctx.releaseIdle('session-fake-3');
  await queuedB;
});

test('软超时：到点只写 warn，不取消，任务照常完成', async () => {
  const ctx = new FakeCtx({ deferIdle: true });
  const platform = makePlatform(ctx);
  const store = makeStore();
  const runner = createTaskRunner();

  const promise = runner.runTask({
    platform,
    store,
    goal: '慢任务',
    limits: { softMs: 10, hardMs: 2000 },
  });
  await tick();
  setTimeout(() => ctx.releaseIdle('session-fake-1'), 40);
  const result = await promise;

  assert.equal(result.status, 'done');
  const softLogs = ctx.logs.filter(
    (entry) => entry.level === 'warn' && /soft timeout/i.test(entry.message),
  );
  assert.equal(softLogs.length, 1);
  assert.equal(ctx.callsOf('sessionController.cancel').length, 0);
});

test('硬超时：先 cancel(keepInbox) 再 cleanInbox，返回 timeout 与超时回执', async () => {
  const ctx = new FakeCtx({ deferIdle: true });
  const base = createAdapter(ctx);
  const order = [];
  const platform = {
    ...base,
    cancel(target) {
      order.push('cancel');
      return base.cancel(target);
    },
    cleanInbox(sessionId) {
      order.push(`cleanInbox:${sessionId}`);
      return base.cleanInbox(sessionId);
    },
  };
  const store = makeStore();
  const runner = createTaskRunner();

  const result = await runner.runTask({
    platform,
    store,
    goal: '永远不会完成的任务',
    limits: { softMs: 5, hardMs: 30 },
  });

  assert.equal(result.status, 'timeout');
  assert.deepEqual(order, ['cancel', 'cleanInbox:session-fake-1']);
  const cancelArgs = ctx.callsOf('sessionController.cancel')[0].args[0];
  assert.deepEqual(cancelArgs, { sessionId: 'session-fake-1', keepInbox: true });
  assert.equal(ctx.agents[0].inbox.cleared, 1);
  assert.match(result.receipt, /^状态：超时/);
  const runEvent = store.events.find((event) => event.detail_json.kind === 'task_run');
  assert.equal(runEvent.detail_json.status, 'timeout');
});

test('失败注入：prompt 抛错 → status=failed 且回执写「失败」，不向上抛', async () => {
  const ctx = new FakeCtx();
  ctx.fail('sessionController.prompt', new Error('prompt exploded'));
  const platform = makePlatform(ctx);
  const store = makeStore();
  const runner = createTaskRunner();

  const result = await runner.runTask({ platform, store, goal: '会失败的任务' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /prompt exploded/);
  assert.match(result.receipt, /^状态：失败/);
  assert.match(result.receipt, /prompt exploded/);
  const receiptEvent = store.events.find((event) => event.detail_json.kind === 'task_receipt');
  assert.equal(receiptEvent.detail_json.status, 'error');
});

test('taskId 唯一：连续任务拿到不同 id，审计行按 id 对齐', async () => {
  const ctx = new FakeCtx();
  const platform = makePlatform(ctx);
  const store = makeStore();
  const runner = createTaskRunner();

  const first = await runner.runTask({ platform, store, goal: '一' });
  const second = await runner.runTask({ platform, store, goal: '二' });
  assert.notEqual(first.taskId, second.taskId);

  const ids = store.events
    .filter((event) => event.detail_json.kind === 'task_run')
    .map((event) => event.detail_json.taskId);
  assert.deepEqual(ids, [first.taskId, second.taskId]);
});

test('回执 ≤300 码点：长 title 与长错误都截断在预算内', async () => {
  const ctx = new FakeCtx();
  ctx.fail('sessionController.prompt', new Error('x'.repeat(500)));
  const platform = makePlatform(ctx);
  const store = makeStore();
  const runner = createTaskRunner();

  const result = await runner.runTask({
    platform,
    store,
    goal: '长任务',
    title: '标'.repeat(TITLE_MAX_CHARS),
  });
  assert.ok(Array.from(result.receipt).length <= RECEIPT_MAX_CHARS,
    `receipt=${Array.from(result.receipt).length}`);
});

test('参数校验：goal 空/超长、title 超长、limits 非法都抛 TypeError', async () => {
  const ctx = new FakeCtx();
  const platform = makePlatform(ctx);
  const runner = createTaskRunner();

  await assert.rejects(() => runner.runTask({ platform }), TypeError);
  await assert.rejects(() => runner.runTask({ platform, goal: '   ' }), TypeError);
  await assert.rejects(
    () => runner.runTask({ platform, goal: 'g'.repeat(GOAL_MAX_CHARS + 1) }),
    TypeError,
  );
  await assert.rejects(
    () => runner.runTask({ platform, goal: 'x', title: 't'.repeat(TITLE_MAX_CHARS + 1) }),
    TypeError,
  );
  await assert.rejects(
    () => runner.runTask({ platform, goal: 'x', limits: { softMs: 100, hardMs: 10 } }),
    TypeError,
  );
  assert.equal(ctx.callsOf('sessionController.createSession').length, 0);
});

test('adapter：whenIdle(sessionId) 与 cleanInbox(sessionId) 走 agent.inbox', async () => {
  const ctx = new FakeCtx({ deferIdle: true });
  const platform = createAdapter(ctx);
  const created = await platform.createSession({ cwd: '/tmp' });
  const sessionId = created.agent.id;

  let idleResolved = false;
  const idle = platform.whenIdle(sessionId).then(() => { idleResolved = true; });
  await tick();
  assert.equal(idleResolved, false);
  ctx.releaseIdle(sessionId);
  await idle;
  assert.equal(idleResolved, true);

  assert.equal(await platform.cleanInbox(sessionId), true);
  assert.equal(ctx.agents[0].inbox.cleared, 1);
  assert.equal(await platform.cleanInbox('missing-session'), false);
  assert.equal(platform.capabilities.inbox, true);
  assert.equal(platform.capabilities.sessionController, true);
});

test('task_run 工具：schema 合法、9 个工具、execute 走执行器并返回结构化结果', async () => {
  const ctx = new FakeCtx();
  const platform = makePlatform(ctx);
  const store = makeStore();
  const tools = createTools({
    store,
    platform,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    clock: () => Date.UTC(2026, 10, 4, 9, 0, 0),
  });
  const tool = tools.find((item) => item.name === 'task_run');

  assert.ok(tool, '缺少 task_run 工具');
  assert.equal(tools.length, 9);
  assert.deepEqual(tool.parameters.required, ['goal']);
  assert.equal(tool.parameters.properties.goal.maxLength, GOAL_MAX_CHARS);
  assert.equal(tool.parameters.properties.title.maxLength, TITLE_MAX_CHARS);
  assert.equal(tool.parameters.additionalProperties, false);

  const result = await tool.execute({ goal: '整理会议纪要', title: '纪要' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.match(result.receipt, /^状态：成功/);
  assert.equal(store.events.length, 2);

  await assert.rejects(() => tool.execute({}), TypeError);
  await assert.rejects(() => tool.execute({ goal: 'g'.repeat(GOAL_MAX_CHARS + 1) }), TypeError);
});

test('task_run 工具：宿主没有会话能力时返回 session-unavailable', async () => {
  const store = makeStore();
  const tools = createTools({
    store,
    platform: undefined,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
  });
  const tool = tools.find((item) => item.name === 'task_run');
  const result = await tool.execute({ goal: '无法执行' });
  assert.deepEqual(result, { ok: false, reason: 'session-unavailable' });
});
