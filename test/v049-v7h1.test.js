/**
 * v0.4.9 V7-H1：线程/任务工具改为**调用时**判能力。
 *
 * 背景：sessionController 由宿主在 apply 之后才挂载（adapter.capabilities 是
 * getter），旧实现在 apply 时按 threadTools 快照过滤，真宿主上 thread_list /
 * thread_run / task_run 永远不会注册。现在一律注册 10 个工具，execute 内读
 * 能力位：缺失返回 {ok:false, reason:'capability_missing'}，不抛异常。
 *
 * 覆盖：
 *   1. apply 时无 sessionController（strict 宿主）仍注册全部 10 个工具；
 *   2. 能力缺失时三个线程/任务工具都返回稳定错误对象，/status 与 /threads
 *      共用同一句「线程：宿主不支持」；
 *   3. 宿主晚挂载（attachSessionController）后同一次注册的工具调用成功，
 *      /status 与 /threads 不再提示不支持（不需要重装插件）；
 *   4. 服务始终缺失时反复调用不崩（含空参数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';

import { TEST_NOW } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

const CAPABILITY_MISSING = {
  ok: false,
  reason: 'capability_missing',
  message: '宿主未提供 sessionController，线程工具暂不可用',
};

const THREADS_UNSUPPORTED = '线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）';

const THREAD_TOOL_NAMES = ['thread_list', 'thread_run', 'task_run'];

const ALL_TOOL_NAMES = [
  'cost_report',
  'memory_forget',
  'memory_search',
  'memory_update',
  'memory_write',
  'reminder_add',
  'reminder_done',
  'task_run',
  'thread_list',
  'thread_run',
];

/** strict FakeCtx：先按「宿主还没挂 sessionController」构造。 */
function makeCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW, strict: true, missing: ['sessionController'] });
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

function toolOf(ctx, name) {
  const definition = ctx.tools.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `工具 ${name} 应已注册`);
  return definition;
}

function commandText(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition.handler({ rawInput: '' }).text;
}

test('V7-H1：apply 时无 sessionController 也注册全部 10 个工具', (t) => {
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  assert.equal(ctx.tools.registrations.length, 10);
  assert.deepEqual(
    ctx.tools.registrations.map((entry) => entry.name).sort(),
    ALL_TOOL_NAMES,
  );
  for (const name of THREAD_TOOL_NAMES) {
    assert.equal(typeof toolOf(ctx, name).execute, 'function', `${name} 应可调用`);
  }
});

test('V7-H1：能力缺失时线程工具返回 capability_missing，/status 与 /threads 文案一致', async (t) => {
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  const status = commandText(ctx, 'status');
  const threads = commandText(ctx, 'threads');
  assert.match(status, /线程：宿主不支持/);
  assert.ok(status.includes(THREADS_UNSUPPORTED), '/status 应包含统一提示');
  assert.equal(threads, THREADS_UNSUPPORTED);

  for (const name of THREAD_TOOL_NAMES) {
    const result = await toolOf(ctx, name).execute({ key: 'new', name: 'V7-H1', goal: '不应执行' });
    assert.deepEqual(result, CAPABILITY_MISSING, `${name} 应返回 capability_missing`);
  }
  // 能力判断先于参数校验：空参数也只返回错误对象，不抛 TypeError。
  const empty = await toolOf(ctx, 'thread_run').execute();
  assert.deepEqual(empty, CAPABILITY_MISSING);
});

test('V7-H1：宿主晚挂载后同一次注册的 thread_run 成功，/status 与 /threads 恢复', async (t) => {
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  // 挂载前：能力缺失。
  const before = await toolOf(ctx, 'thread_run').execute({ key: 'new', name: 'V7-H1', goal: '晚挂载' });
  assert.deepEqual(before, CAPABILITY_MISSING);

  // 宿主晚挂载服务（能力 getter 随之变 true），不重新 apply。
  assert.equal(ctx.attachSessionController(), true);
  assert.equal(ctx.get('sessionController') !== undefined, true);

  const after = await toolOf(ctx, 'thread_run').execute({ key: 'new', name: 'V7-H1', goal: '晚挂载后执行' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.action, 'create');
  assert.ok(ctx.callsOf('sessionController.create').length >= 1);
  assert.ok(ctx.callsOf('sessionController.prompt').length >= 1);

  const status = commandText(ctx, 'status');
  const threads = commandText(ctx, 'threads');
  assert.doesNotMatch(status, /宿主不支持/u);
  assert.doesNotMatch(threads, /宿主不支持/u);
  assert.match(threads, /线程目录/u);
});

test('V7-H1：服务始终缺失时反复调用不崩', async (t) => {
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  for (let round = 0; round < 3; round += 1) {
    for (const name of THREAD_TOOL_NAMES) {
      const result = await toolOf(ctx, name).execute();
      assert.deepEqual(result, CAPABILITY_MISSING, `第 ${round + 1} 轮 ${name}`);
    }
  }
  assert.equal(ctx.callsOf('sessionController.create').length, 0);
  assert.equal(ctx.callsOf('sessionController.prompt').length, 0);
});
