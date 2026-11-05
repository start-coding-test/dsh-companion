/**
 * C5-H1b 专项回归：线程服务方法名必须是公开的 ApiSessionList 契约。
 *
 * 云端 DSH 的 `sessionController` 服务对象是 `ApiSessionList`，公开方法为
 * `create` / `prompt` / `cancel` / `resolveAgent` 等；`createSession` 属于内部类
 * `ApiSessionAgentController`，不在服务对象上。因此：
 *   1) 能力探测只看 create + prompt + cancel；
 *   2) adapter.createSession 转发 create(request)，并用 resolveAgent 归一 agent；
 *   3) whenIdle 接受会话 id / create 返回值，经 resolveAgent 反查；
 *   4) thread_run / task_run 投递带 companion-thread:/companion-task: requestId。
 *
 * strict FakeCtx 只模拟真实宿主公开面（无 createSession），从 apply 入口验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { runTask as runWorkerTask } from '../src/task/worker.js';

import { TEST_NOW } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** strict FakeCtx：只有真实宿主公开的线程服务方法。 */
function makeStrictCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now, strict: true });
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

test('C5-H1b：strict FakeCtx 只暴露 create/resolveAgent/prompt/cancel', () => {
  const ctx = makeStrictCtx();
  const controller = ctx.get('sessionController');

  assert.equal(typeof controller.create, 'function');
  assert.equal(typeof controller.resolveAgent, 'function');
  assert.equal(typeof controller.prompt, 'function');
  assert.equal(typeof controller.cancel, 'function');
  assert.equal(controller.createSession, undefined, '公开服务没有 createSession');
});

test('C5-H1b：adapter.createSession 走 create，并用 resolveAgent 归一 agent', async () => {
  const ctx = makeStrictCtx();
  const adapter = createAdapter(ctx);
  const request = { cwd: '/repo', agentPreset: 'workspace-write' };

  const created = await adapter.createSession(request);
  assert.deepEqual(ctx.callsOf('sessionController.create')[0].args[0], request);
  assert.equal(ctx.callsOf('sessionController.createSession').length, 0);
  assert.equal(created.sessionId, ctx.agents[0].id);
  assert.equal(created.agent, ctx.agents[0]);
  assert.equal(created.agentPreset, null);
  assert.equal(
    ctx.callsOf('sessionController.resolveAgent')[0].args[0],
    created.sessionId,
  );

  // 字符串 / create 返回值都经 resolveAgent 后再 whenIdle。
  await adapter.whenIdle(created.sessionId);
  await adapter.whenIdle(created);
  assert.equal(ctx.callsOf('agent.whenIdle').length, 2);
});

test('C5-H1b：apply 注册线程工具；create 参数/返回值与 resolveAgent 生效', async () => {
  const ctx = makeStrictCtx();
  const handle = apply(ctx, { dbPath: ':memory:' }, {
    cwd: '/hooked/cwd',
    now: () => TEST_NOW,
  });
  try {
    const registrations = ctx.tools.registrations;
    const thread = registrations.find((definition) => definition.name === 'thread_run');
    const task = registrations.find((definition) => definition.name === 'task_run');
    assert.equal(typeof thread?.execute, 'function');
    assert.equal(typeof task?.execute, 'function');

    const result = await thread.execute({ key: 'new', name: 'C5-H1b', goal: '验证公开线程服务' });
    assert.equal(result.ok, true, JSON.stringify(result));

    // V10-H1：未配置 thread.agentPreset 时 create 请求不带该字段。
    assert.deepEqual(ctx.callsOf('sessionController.create')[0].args[0], {
      cwd: '/hooked/cwd',
    });
    assert.equal(ctx.callsOf('sessionController.createSession').length, 0);
    assert.equal(result.sessionId, ctx.agents[0].id);
    assert.ok(ctx.callsOf('sessionController.resolveAgent').length >= 1);
    // thread_run 的收尾 whenIdle 由 create 返回值归一后定位到同一个 agent。
    assert.ok(ctx.callsOf('agent.whenIdle').length >= 1);

    const prompt = ctx.callsOf('sessionController.prompt')[0].args[0];
    assert.match(prompt.requestId, /^companion-thread:.+:run-/);
  } finally {
    handle.dispose();
  }
});

test('C5-H1b：task_run 投递携带 companion-task requestId；worker 重投不换 id', async () => {
  const ctx = makeStrictCtx();
  const handle = apply(ctx, { dbPath: ':memory:' }, {
    cwd: '/hooked/cwd',
    now: () => TEST_NOW,
  });
  try {
    const tool = ctx.tools.registrations.find((definition) => definition.name === 'task_run');
    const result = await tool.execute({ goal: '写一条任务回执', title: 'C5-H1b' });
    assert.equal(result.ok, true, JSON.stringify(result));

    const delivered = ctx.callsOf('sessionController.prompt')[0].args[0];
    assert.match(delivered.requestId, /^companion-task:task-[a-z0-9-]+:claim-/);
  } finally {
    handle.dispose();
  }

  // 同一份投递重试：worker 原样转发 task.requestId，不生成新的用户消息。
  const retryCtx = makeStrictCtx();
  const platform = createAdapter(retryCtx);
  const requestId = 'companion-task:task-x:claim-y';
  const task = { id: 'task-x', prompt: '同一份投递', requestId };
  await runWorkerTask({ platform, task });
  await runWorkerTask({ platform, task });
  const requestIds = retryCtx.callsOf('sessionController.prompt')
    .map((call) => call.args[0].requestId);
  assert.deepEqual(requestIds, [requestId, requestId]);
});
