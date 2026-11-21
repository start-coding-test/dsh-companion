/**
 * v0.7.11 修复单测（3P-H1 / 3P-M1 / V710-M1 / V710-L1 / V710-L2 / 契约门禁）。
 *
 * **非真机证据**：本机是 Windows 开发机，没有用户级 systemd / polkit / DBus /
 * cgroup；`systemd-run` / `systemctl` 全部用替身（注入 `run` / `spawnImpl`）
 * 验证参数、调用序列与状态机，真实行为属云端 50041（ubuntu uid 1000）验收。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { createAdapter } from '../src/platform/adapter.js';
import { formatStopTaskReply } from '../src/runtime/commands.js';
import { createProactive } from '../src/runtime/proactive.js';
import { normalizeConfig } from '../src/config.js';
import { signalBgProcess, startBgProcess } from '../src/task/bg-launcher.js';
import { createTaskRunner } from '../src/task/run.js';
import { runSubagentTask } from '../src/task/subagent-runner.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const NOW_MS = 1_700_000_000_000;

function tick(times = 2) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  }
  return chain;
}

/** 插件级 FakeCtx（commands / tools 注册桩）。 */
function makePluginCtx() {
  const ctx = new FakeCtx({ now: NOW_MS });
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
  return ctx;
}

function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `${name} 命令应已注册`);
  return definition;
}

function toolOf(ctx, name) {
  const definition = ctx.tools.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `${name} 工具应已注册`);
  return definition;
}

// ---------------------------------------------------------------- V710-L1

test('V710-L1：/停止任务 无参数时给出用法与在跑清单', async () => {
  // **非真机证据**：只验证命令分发到执行器入口，不启动真实子代理。
  const ctx = makePluginCtx();
  apply(ctx, { dbPath: ':memory:' });
  const stop = commandOf(ctx, 'stop-task');
  assert.match(stop.description, /\/停止任务/u);

  // 宿主把命令名之后的文本作为 rawInput 传入（与 /记忆 的约定一致）。
  const reply = stop.handler({ rawInput: '' });
  assert.equal(reply.kind, 'success');
  assert.match(reply.text, /\/stop-task/u);
  assert.match(reply.text, /当前没有在跑的 task_run/u);
});

test('V710-L1：/停止任务 带未知 taskId → 没有在跑的任务', async () => {
  const ctx = makePluginCtx();
  apply(ctx, { dbPath: ':memory:' });
  const stop = commandOf(ctx, 'stop-task');
  const reply = stop.handler({ rawInput: 'task-nope-1' });
  assert.match(reply.text, /没有在跑的任务：task-nope-1/u);
});

test('V710-L1：formatStopTaskReply 覆盖用法 / 命中 / 未命中', () => {
  assert.match(formatStopTaskReply({ usage: true, active: [] }), /没有在跑的 task_run/u);
  assert.match(formatStopTaskReply({ usage: true, active: ['task-a', 'task-b'] }), /task-a、task-b/u);
  assert.match(
    formatStopTaskReply({ taskId: 'task-a', result: { ok: true, cancelled: 1, taskId: 'task-a' } }),
    /已请求中止 task-a/u,
  );
  assert.match(
    formatStopTaskReply({ taskId: 'task-a', result: { ok: false, cancelled: 0, reason: 'not-found' } }),
    /没有在跑的任务：task-a/u,
  );
});

test('V710-L1：stopTaskById / listActiveTasks 中止在跑任务并出 cancelled 回执', async () => {
  // **非真机证据**：子代理按宿主真实契约实现——只有 dispose() 让 result 结算。
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent(spec) {
      const resolvers = Promise.withResolvers();
      let disposed = 0;
      platform.observed = { spec, disposed: () => disposed };
      return {
        childId: 'child-cancel',
        result: resolvers.promise,
        dispose: async () => {
          disposed += 1;
          resolvers.resolve({ stopReason: 'aborted', output: [] });
        },
      };
    },
  };
  const receipts = [];
  const runner = createTaskRunner({ maxExec: 1, maxQueue: 0 });
  const started = runner.startTask({
    platform,
    goal: '长任务',
    agent: { id: 'agent-1' },
    subagent: { enabled: true, label: '长任务' },
    onReceipt: async (info) => { receipts.push(info); },
  });
  assert.equal(started.ok, true);
  await tick();
  assert.deepEqual(runner.listActiveTasks(), [started.taskId]);
  assert.equal(runner.stopTaskById(started.taskId), true);
  assert.equal(runner.stopTaskById(started.taskId), false, '重复中止返回 false');

  const result = await started.done;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'cancelled');
  assert.equal(platform.observed.disposed(), 1, '取消必须走 dispose（signal 停不掉运行中的子代理）');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].reason, 'cancelled');
});

// ---------------------------------------------------------------- 3P-H1

test('3P-H1：硬超时走 dispose，产出 timeout 回执（signal abort 不结算 result）', async () => {
  // **非真机证据**：替身严格按 dsh-subagent/src/types.ts:42「Cancellation before
  // publication; callers own later cancellation through dispose」实现。
  const observed = { abortedResolved: false, disposed: 0 };
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent(spec) {
      const resolvers = Promise.withResolvers();
      spec.signal.addEventListener('abort', () => { observed.abortedResolved = false; }, { once: true });
      return {
        childId: 'child-hang',
        result: resolvers.promise,
        dispose: async () => {
          observed.disposed += 1;
          resolvers.resolve({ stopReason: 'aborted', output: [] });
        },
      };
    },
  };
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-hang', scope: 'main', prompt: '慢任务' },
    parent: { id: 'agent-1' },
    label: '慢任务',
    hardMs: 30,
    now: NOW_MS,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.reason, 'hard_timeout');
  assert.equal(observed.disposed, 1);
  assert.match(result.error ?? '', /did not finish within/u);
});

test('3P-H1：外部取消（AbortController）→ dispose + cancelled 回执', async () => {
  const observed = { disposed: 0 };
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent() {
      const resolvers = Promise.withResolvers();
      return {
        childId: 'child-c2',
        result: resolvers.promise,
        dispose: async () => {
          observed.disposed += 1;
          resolvers.resolve({ stopReason: 'aborted', output: [] });
        },
      };
    },
  };
  const controller = new AbortController();
  const pending = runSubagentTask({
    platform,
    task: { id: 'task-c2', scope: 'main', prompt: '可取消' },
    parent: { id: 'agent-1' },
    label: '可取消',
    signal: controller.signal,
    now: NOW_MS,
  });
  await tick();
  controller.abort('user');
  const result = await pending;
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'cancelled');
  assert.equal(observed.disposed, 1);
});

// ---------------------------------------------------------------- 契约门禁

test('契约门禁：startSubagent 的 signal 必须是 AbortSignal', async () => {
  const ctx = new FakeCtx({ now: NOW_MS });
  ctx.subagents = {
    async startActivation() {
      return { childId: 'c-1', result: Promise.resolve({}), dispose: async () => {} };
    },
  };
  const adapter = createAdapter(ctx);
  await assert.rejects(
    adapter.startSubagent({
      provider: 'spawn',
      parent: { id: 'a' },
      prompt: [{ type: 'text', text: 'hi' }],
      signal: {},
    }),
    /signal must be an AbortSignal/u,
  );
});

test('契约门禁：sendToSubagent 调用方传 {} 也会被补成真 AbortSignal', async () => {
  // **非真机证据**：替身按宿主实现对第 4 参调 throwIfAborted（传 {} 会 TypeError）。
  const captured = [];
  const ctx = new FakeCtx({ now: NOW_MS });
  ctx.subagents = {
    async sendMessage(sender, targetId, content, options) {
      options.signal.throwIfAborted();
      captured.push({ sender, targetId, options });
      return 'message-1';
    },
  };
  const adapter = createAdapter(ctx);
  await adapter.sendToSubagent({ id: 'parent' }, 'child-1', [{ type: 'text', text: '醒醒' }], {});
  assert.equal(captured.length, 1);
  assert.ok(captured[0].options.signal instanceof AbortSignal);
});

test('契约门禁：registerTools 的 exec.signal 不是 AbortSignal 时抛 TypeError', async () => {
  const ctx = makePluginCtx();
  apply(ctx, { dbPath: ':memory:' });
  const tool = toolOf(ctx, 'task_run');
  await assert.rejects(
    (async () => tool.execute({ goal: '测试' }, { agent: { id: 'a' }, signal: {} }))(),
    /exec\.signal must be an AbortSignal/u,
  );
});

// ---------------------------------------------------------------- V710-M1

/** 替身 systemd-run 客户端：永不退出，支持 kill 观测。**非真机证据**。 */
function hangingClient() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.killed = false;
  child.unref = () => {};
  child.kill = (signal) => {
    child.killed = true;
    child.killedWith = signal;
    return true;
  };
  return child;
}

test('V710-M1：launch-timeout 时 best-effort 停孤儿 unit，并写进 failure', async () => {
  // **非真机证据**：`systemctl stop` 用替身 run 记录调用序列。
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-v0711-'));
  try {
    const calls = [];
    const run = async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    };
    const started = await startBgProcess({
      id: 'bg-orphan',
      argv: ['python3', 'train.py'],
      cwd: logRoot,
      deadlineSec: 60,
      memoryMax: '1G',
      cpuQuota: '100%',
      logRoot,
      platform: 'linux',
      uid: 0,
      launchWaitMs: 30,
      spawnImpl: () => hangingClient(),
      run,
    });
    assert.equal(started.failure.reason, 'launch-timeout');
    assert.equal(started.failure.stopAttempted, true);
    assert.equal(started.failure.stopOutcome, true);
    assert.match(started.failure.message, /systemctl stop dsh-bg-bg-orphan/u);
    assert.deepEqual(
      calls.map((call) => [call.cmd, ...call.args]),
      [['systemctl', 'stop', 'dsh-bg-bg-orphan']],
      '超时后应按同一模式停一次 unit',
    );
  } finally {
    rmSync(logRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('V710-M1：user 模式下停 unit 带 --user 与用户环境', async () => {
  const calls = [];
  const ok = await signalBgProcess({
    unit: 'dsh-bg-x',
    pid: null,
    kind: 'linux',
    signal: 'TERM',
    user: true,
    uid: 1000,
    run: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].args, ['--user', 'stop', 'dsh-bg-x']);
  assert.equal(calls[0].options.env.XDG_RUNTIME_DIR, '/run/user/1000');
});

// ---------------------------------------------------------------- 3P-M1

test('3P-M1：同一天 3 个 task_run 回执全部送达，不占主动消息额度', async () => {
  const store = Store.open(':memory:');
  const prompts = [];
  const now = Date.parse('2026-11-05T10:00:00+08:00');
  const proactive = createProactive({
    store,
    config: normalizeConfig({ proactiveDailyCap: 3 }),
    target: () => 'main',
    clock: () => now,
    platform: { async prompt(sessionId, text) { prompts.push(text); } },
  });
  proactive.enqueue({ kind: 'chat', text: '闲聊一句', dedupeKey: 'c-1', at: now });
  const first = await proactive.flush(now);
  assert.equal(first.sent, 1);

  for (let i = 1; i <= 3; i += 1) {
    proactive.enqueue({ kind: 'task_report', text: `任务完成 ${i}`, dedupeKey: `t-${i}`, at: now });
  }
  const capped = await proactive.flush(now);
  const joined = prompts.join('\n');
  for (let i = 1; i <= 3; i += 1) {
    assert.match(joined, new RegExp(`任务完成 ${i}`, 'u'), `第 ${i} 条回执必须送达`);
  }
  assert.equal(capped.deferred, 0, '回执不得因额度被丢弃或留在队列');
  assert.equal(proactive.stats(now).remainingToday, 2, '回执不计入每日额度，只剩闲聊那 1 条');
  // 合并窗口内同 kind 可能合并成一条 prompt（合并条按 1 条计），仍不得少于 1 条。
  assert.ok(capped.sent >= 1);
});

test('3P-M1：重启后按 pending 无后续 sent 补投回执', async () => {
  const store = Store.open(':memory:');
  const now = Date.parse('2026-11-05T10:00:00+08:00');
  store.appendEvent({
    at: Math.floor(now / 1000) - 5,
    action: 'USED',
    table_name: 'proactive',
    row_id: null,
    actor: 'scheduler',
    reason: 'proactive:pending',
    detail_json: {
      kind: 'proactive_pending',
      msgKind: 'task_report',
      dedupeKey: 't-lost',
      text: '任务完成（重启前未送达）',
    },
  });
  const prompts = [];
  const proactive = createProactive({
    store,
    config: normalizeConfig({}),
    target: () => 'main',
    clock: () => now,
    platform: { async prompt(sessionId, text) { prompts.push(text); } },
  });
  const flushed = await proactive.flush(now);
  assert.equal(flushed.sent, 1);
  assert.match(prompts[0], /重启前未送达/u);
});

// ---------------------------------------------------------------- 复核增量

test('M2：排队中被取消不会错账槽位（over-admission 回归）', async () => {
  // **非真机证据**：子代理替身按宿主契约实现——只有 dispose() 让 result 结算。
  const handles = [];
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent() {
      const resolvers = Promise.withResolvers();
      const handle = {
        childId: `child-${handles.length}`,
        result: resolvers.promise,
        dispose: async () => { resolvers.resolve({ stopReason: 'aborted', output: [] }); },
      };
      handles.push(handle);
      return handle;
    },
  };
  const runner = createTaskRunner({ maxExec: 1, maxQueue: 1 });
  const receipts = [];
  const onReceipt = async (info) => { receipts.push(info); };

  const first = runner.startTask({
    platform, goal: '占槽任务', agent: { id: 'agent-1' }, subagent: { enabled: true, label: '占槽任务' }, onReceipt,
  });
  await tick();
  const second = runner.startTask({
    platform, goal: '排队任务', agent: { id: 'agent-1' }, subagent: { enabled: true, label: '排队任务' }, onReceipt,
  });
  assert.equal(second.queued, true);
  assert.equal(runner.stats().active, 1);
  assert.equal(runner.stats().queued, 1);

  // 停掉排队者：它从未持有槽位，不能把在跑者的槽减掉或转交出去。
  assert.equal(runner.stopTaskById(second.taskId), true);
  const secondResult = await second.done;
  assert.equal(secondResult.status, 'failed');
  assert.equal(secondResult.reason, 'cancelled');
  assert.equal(runner.stats().active, 1, '在跑任务仍占 1 个槽');
  assert.equal(runner.stats().queued, 0, '排队队列必须清空');

  // 后续 admit 仍受 slots 约束（错账会让这里直接 grant 成 2 个在跑任务）。
  const third = runner.startTask({
    platform, goal: '第二个排队', agent: { id: 'agent-1' }, subagent: { enabled: true, label: '第二个排队' }, onReceipt,
  });
  assert.equal(third.queued, true, '槽仍被占槽任务持有，新任务只能排队');
  assert.equal(runner.stats().active, 1);
  assert.ok(runner.stats().active <= runner.stats().maxExec);
  assert.equal(runner.listActiveTasks().length, 2, '在跑 + 排队各 1 个');

  runner.stopTaskById(first.taskId);
  const firstResult = await first.done;
  assert.equal(firstResult.reason, 'cancelled');
  // 第一个释放后，排队者应被转交并开始执行；这里同样停掉它，验证槽位仍守恒。
  await tick();
  assert.equal(runner.stats().active, 1);
  assert.equal(runner.stopTaskById(third.taskId), true);
  const thirdResult = await third.done;
  assert.equal(thirdResult.reason, 'cancelled');
  assert.ok(runner.stats().active <= runner.stats().maxExec);
  assert.equal(runner.stats().queued, 0);
  assert.equal(receipts.length, 3, '三个任务各出一次回执');
});

test('3P-H1：activation.result reject（teardown 抛错）→ teardown_error', async () => {
  // **非真机证据**：宿主 manager.ts:1113 正常 dispose 是 resolve，reject 只在
  // :1068-1075 的 teardown 异常分支（:1114）。这里专测 reject 臂的归类。
  const observed = { disposed: 0 };
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent() {
      const rejected = Promise.reject(new Error('teardown boom'));
      rejected.catch(() => {}); // 只防测试进程的 unhandledRejection 噪音
      return {
        childId: 'child-teardown',
        result: rejected,
        dispose: async () => { observed.disposed += 1; },
      };
    },
  };
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-teardown', scope: 'main', prompt: '坏 teardown' },
    parent: { id: 'agent-1' },
    label: '坏 teardown',
    now: NOW_MS,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'teardown_error');
  assert.match(result.error ?? '', /teardown boom/u);
  assert.equal(observed.disposed, 1, 'reject 臂同样释放宿主资源');
});
