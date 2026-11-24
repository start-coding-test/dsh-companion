/**
 * v0.7.10 真机反馈修复（D21-H2 / H3 / H4 / M1 / M2）单测。
 *
 * **非真机证据**：本机是 Windows 开发机，没有用户级 systemd / polkit / DBus /
 * cgroup；所有 Linux 路径（`systemd-run --user`、`systemctl --user`、polkit 授权、
 * cgroup.controllers）在这里都用替身（注入 `run` / `spawnImpl`）验证参数拼装与
 * 状态机，真实行为属云端 50041（ubuntu uid 1000）验收范围。
 *
 * 覆盖：
 * - D21-H2：task_run 立即返回 started、执行信号与主轮次解耦、硬超时仍出 timeout
 *   回执、onReceipt 恰好一次、工具结果不含回执正文、busy 仍同步返回；
 * - D21-H3：等 systemd-run 客户端退出才判定（exit 1 → launcher-exited、不退出 →
 *   launch-timeout、exit 0 → 成功）、启动失败附 launch.log 末尾；
 * - D21-H4：uid 0 / 非 0 两套参数、user 模式环境补齐、bg.runAs 冲突、自检不可用；
 * - D21-M1：小区间累积合并到门槛、非相邻另起、落库后重启恢复；
 * - D21-M2：sendToSubagent 第 4 参是可用 AbortSignal（throwIfAborted 不抛）。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { normalizeBg, normalizeConfig } from '../src/config.js';
import {
  forgetPendingCompact,
  rememberConsolidatedRegion,
} from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { deliverySignal } from '../src/platform/adapter.js';
import { createTools } from '../src/runtime/tools.js';
import {
  createPendingCompacts,
  peekPendingCompact,
  recoverPendingCompacts,
} from '../src/state/pending-compact.js';
import {
  bgSelfCheck,
  buildSystemdRunArgs,
  currentUid,
  LAUNCH_LOG_NAME,
  resolveSystemdMode,
  startBgProcess,
  userModeEnv,
} from '../src/task/bg-launcher.js';
import { startBgJob } from '../src/task/bg-jobs.js';
import { createTaskRunner } from '../src/task/run.js';

const NOW_MS = 1_700_000_000_000;

/** 统计子串出现次数（回执去重断言用）。 */
function countOccurrences(text, needle) {
  if (typeof text !== 'string' || needle === '') return 0;
  return text.split(needle).length - 1;
}

/** 让出若干事件循环轮次。 */
function tick(times = 2) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => new Promise((resolve) => { setTimeout(resolve, 0); }));
  }
  return chain;
}

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

/** schema_meta 替身（D21-M1 落库断言用）。 */
function makeMetaStore() {
  const meta = new Map();
  return {
    meta,
    setMeta(key, value) {
      meta.set(key, String(value));
    },
    getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },
    deleteMeta(key) {
      meta.delete(key);
    },
    db: {
      prepare(sql) {
        return {
          all() {
            if (!/schema_meta/u.test(sql)) return [];
            return [...meta.entries()]
              .filter(([key]) => key.startsWith('pending_compact:'))
              .map(([key, value]) => ({ key, value }));
          },
        };
      },
    },
  };
}

/** 子代理能力替身：startSubagent 立刻返回一个未结算的 activation。 */
function makeSubagentPlatform() {
  const calls = [];
  let resolvers = null;
  const platform = {
    capabilities: { subagents: true, sessionController: true, subagentMessages: true, compaction: false },
    log() {},
    async startSubagent(spec) {
      calls.push(spec);
      resolvers = Promise.withResolvers();
      return { childId: 'child-1', result: resolvers.promise, dispose: async () => {} };
    },
  };
  return {
    platform,
    calls,
    resolve(result) {
      resolvers.resolve(result);
    },
    reject(error) {
      resolvers.reject(error);
    },
  };
}

/** createTools 的最小公共参数。 */
function toolOptions(store, platform, extra = {}) {
  return {
    store,
    platform,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    clock: () => NOW_MS,
    ...extra,
  };
}

// ------------------------------------------------------------------ D21-H2

test('D21-H2：startTask 立即返回 started，busy 仍同步返回（不再 await 执行）', async () => {
  // **非真机证据**：worker 路径用替身会话控制器。
  const platform = {
    capabilities: {},
    log() {},
    async createSession() {
      return { sessionId: 's-1', agent: { id: 's-1' } };
    },
    async prompt() {
      return 'message-1';
    },
    async whenIdle() {},
  };
  const runner = createTaskRunner({ maxExec: 1, maxQueue: 0 });
  const started = runner.startTask({ platform, goal: '整理会议纪要', title: '纪要' });
  assert.equal(started.ok, true);
  assert.match(started.taskId, /^task-/u);
  assert.equal(started.queued, false);
  assert.equal(typeof started.done.then, 'function');

  const busy = runner.startTask({ platform, goal: '第二个' });
  assert.deepEqual(busy, { ok: false, reason: 'busy', queue: 0 });

  const result = await started.done;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
});

test('D21-H2：task_run 返回 started，onReceipt 恰好一次，主轮次 signal 不传给子代理', async () => {
  const store = makeStore();
  const fake = makeSubagentPlatform();
  const receipts = [];
  let resolveReceipt = () => {};
  const receiptDone = new Promise((resolve) => { resolveReceipt = resolve; });
  const tools = createTools(toolOptions(store, fake.platform, {
    taskReceipt: async (info) => {
      receipts.push(info);
      resolveReceipt();
    },
  }));
  const tool = tools.find((item) => item.name === 'task_run');

  // 主轮次 signal 已经 abort：旧实现会把它转给子代理并被杀。
  const exec = { agent: { id: 'agent-1', name: 'lead' }, signal: AbortSignal.abort() };
  const result = await tool.execute({ goal: '写周报', title: '周报' }, exec);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'started');
  assert.equal(result.title, '周报');
  assert.equal(result.receipt, undefined, '工具结果不含回执正文');

  assert.equal(fake.calls.length, 1);
  const spec = fake.calls[0];
  assert.equal(spec.delivery, 'caller');
  assert.ok(spec.signal instanceof AbortSignal);
  assert.notEqual(spec.signal, exec.signal, '不得复用主轮次 exec.signal');
  assert.equal(spec.signal.aborted, false, '主轮次 abort 不影响子代理');

  assert.equal(receipts.length, 0, '回执要等子代理结算');
  fake.resolve({
    stopReason: 'completed',
    output: [{ type: 'text', text: '周报写完了' }],
    structured: { receipt: '周报已完成，共 3 条要点', status: 'ok' },
  });
  await receiptDone;
  await tick();
  assert.equal(receipts.length, 1, 'onReceipt 恰好一次');
  assert.equal(receipts[0].status, 'done');
});

test('D21-H2：硬超时仍产生 timeout 回执（按宿主契约：只有 dispose 才让 result 结算）', async () => {
  // **非真机证据**：替身按宿主真实契约实现——信号只在创建期生效
  // （dsh-subagent/src/types.ts:42「Cancellation before publication; callers own
  // later cancellation through dispose」），发布后 abort 不结算 result，只有
  // dispose() 才让 activation.result 结算（manager.ts:1039-1116）。
  const store = makeStore();
  const fake = makeSubagentPlatform();
  const receipts = [];
  let resolveReceipt = () => {};
  const receiptDone = new Promise((resolve) => { resolveReceipt = resolve; });
  const tools = createTools(toolOptions(store, fake.platform, {
    taskLimits: { softMs: 10, hardMs: 25 },
    taskReceipt: async (info) => {
      receipts.push(info);
      resolveReceipt();
    },
  }));
  const tool = tools.find((item) => item.name === 'task_run');

  const observed = { abortedSettledResult: false, disposed: 0 };
  fake.platform.startSubagent = async (spec) => {
    fake.calls.push(spec);
    const resolvers = Promise.withResolvers();
    // 发布后 abort：宿主不会因此结算 result——这里显式记录，防止换成假绿。
    spec.signal.addEventListener('abort', () => { observed.abortedSettledResult = false; }, { once: true });
    return {
      childId: 'child-timeout',
      result: resolvers.promise,
      dispose: async () => {
        observed.disposed += 1;
        resolvers.resolve({ stopReason: 'aborted', output: [] });
      },
    };
  };

  const result = await tool.execute({ goal: '慢任务' }, { agent: { id: 'agent-1' } });
  assert.equal(result.status, 'started');
  await receiptDone;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'timeout');
  assert.equal(receipts[0].taskId, result.taskId);
  // 证明超时回执只能由 dispose 路径产生（删掉 disposeActivation 调用该用例必须红）。
  assert.equal(observed.disposed, 1);
  assert.equal(observed.abortedSettledResult, false);
});

test('D21-H2：abortAll() 能中止在跑的子代理（插件卸载路径）', async () => {
  const fake = makeSubagentPlatform();
  const runner = createTaskRunner();
  const started = runner.startTask({
    platform: fake.platform,
    goal: '长任务',
    agent: { id: 'agent-1' },
    subagent: { enabled: true, model: null },
  });
  assert.equal(started.ok, true);
  await tick();
  assert.equal(fake.calls.length, 1);
  const signal = fake.calls[0].signal;
  assert.equal(signal.aborted, false);

  assert.equal(runner.abortAll('test'), 1);
  assert.equal(signal.aborted, true);

  fake.resolve({ stopReason: 'aborted', output: [] });
  const result = await started.done;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'cancelled');
});

// ------------------------------------------------------------------ D21-H3

/** 替身 systemd-run 客户端：按事件序列 emit，支持 kill 观测。**非真机证据**。 */
function fakeClient(events, { stderrText = '' } = {}) {
  return () => {
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
    setImmediate(() => {
      if (stderrText !== '') child.stderr.emit('data', stderrText);
      for (const [name, args] of events) child.emit(name, ...args);
    });
    return child;
  };
}

test('D21-H3：客户端 exit 1 → launcher-exited，且回执附 launch.log 末尾', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-v0710-'));
  test.after?.(() => {});
  try {
    const started = await startBgProcess({
      id: 'bg-exit1',
      argv: ['python3', 'train.py'],
      cwd: logRoot,
      deadlineSec: 60,
      memoryMax: '1G',
      cpuQuota: '100%',
      logRoot,
      platform: 'linux',
      uid: 0,
      launchWaitMs: 1000,
      spawnImpl: fakeClient(
        [['exit', [1, null]]],
        { stderrText: 'Failed to connect to bus: Interactive authentication required\n' },
      ),
    });
    assert.equal(started.failure.reason, 'launcher-exited');
    assert.equal(started.failure.exitCode, 1);
    const launchLogPath = join(logRoot, 'bg-exit1', LAUNCH_LOG_NAME);
    assert.equal(existsSync(launchLogPath), true);
    assert.match(readFileSync(launchLogPath, 'utf8'), /Interactive authentication required/u);
    assert.deepEqual(started.failure.launchLogTail, [
      'Failed to connect to bus: Interactive authentication required',
    ]);
    assert.match(started.failure.message, /systemd-run stderr/u);
    assert.equal(countOccurrences(started.failure.message, 'Failed to connect to bus'), 1, 'tail 只拼一次');
    assert.equal(countOccurrences(started.failure.message, 'systemd-run stderr'), 1, '不重复拼接');
    assert.equal(started.launchLogPath, launchLogPath);
  } finally {
    rmSync(logRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('D21-H3：客户端不退出 → launch-timeout（kill 客户端，不再判成功）', async () => {
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-v0710-'));
  try {
    let client = null;
    const spawnImpl = () => {
      client = fakeClient([])({});
      return client;
    };
    const started = await startBgProcess({
      id: 'bg-hang',
      argv: ['python3', 'train.py'],
      cwd: logRoot,
      deadlineSec: 60,
      memoryMax: '1G',
      cpuQuota: '100%',
      logRoot,
      platform: 'linux',
      uid: 0,
      launchWaitMs: 30,
      spawnImpl,
    });
    assert.equal(started.failure.reason, 'launch-timeout');
    assert.match(started.failure.message, /polkit/u);
    assert.equal(client.killed, true);
    assert.equal(client.killedWith, 'SIGKILL');
  } finally {
    rmSync(logRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('D21-H3 + D21-L1：bg_run 拉起失败的回执带 launch.log 末尾（且不重复拼）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v0710-'));
  const work = join(root, 'work');
  const logRoot = join(root, 'bglog');
  mkdirSync(join(work, 'proj'), { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(join(work, 'proj', 'train.py'), 'print("hi")\n');
  const store = Store.open(':memory:');
  const config = normalizeConfig({ bg: { workRoot: work } });
  const tail = 'Interactive authentication required';
  const run = (failure, nowMs) => startBgJob({
    store,
    config,
    params: {
      argv: ['python3', join(work, 'proj', 'train.py')],
      cwd: 'proj',
      deadlineMin: 5,
      label: '训练',
    },
    origin: { childSessionId: 'child-1', launchedBy: 'bg_run' },
    logRoot,
    nowMs,
    launcher: {
      async startBgProcess(spec) {
        const dir = join(logRoot, spec.id);
        mkdirSync(dir, { recursive: true });
        return {
          unit: `dsh-bg-${spec.id}`,
          pid: null,
          logPath: join(dir, 'output.log'),
          exitPath: join(dir, 'exit'),
          wrapperPath: join(dir, 'run.sh'),
          kind: 'linux',
          failure,
        };
      },
    },
  });
  try {
    // ① launcher 只给 launchLogTail：由 bg-jobs 拼一次。
    const result = await run({
      reason: 'launcher-exited',
      message: 'systemd-run exited with code 1',
      exitCode: 1,
      launchLogTail: [tail],
    }, NOW_MS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'launch-failed');
    assert.match(result.message, /启动日志末尾：/u);
    assert.match(result.message, /Interactive authentication required/u);
    assert.equal(countOccurrences(result.message, '启动日志末尾：'), 1);
    assert.equal(countOccurrences(result.message, tail), 1);

    // ② launcher 已把 tail 拼进 failure.message（真实拉起失败路径）：
    //    回执里不得再拼一遍（v0.7.10 复核发现的测试盲区）。
    const already = `systemd-run exited with code 1\nsystemd-run stderr（末尾 20 行）：\n${tail}`;
    const result2 = await run({
      reason: 'launcher-exited',
      message: already,
      exitCode: 1,
      launchLogTail: [tail],
    }, NOW_MS + 1);
    assert.equal(result2.ok, false);
    assert.equal(countOccurrences(result2.message, tail), 1, 'tail 只出现一次');
    assert.equal(countOccurrences(result2.message, '启动日志末尾：'), 0, '不重复拼接');
    assert.match(result2.message, /systemd-run stderr/u);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ------------------------------------------------------------------ D21-H4

test('D21-H4：uid 0 走系统实例、非 0 走用户级实例；参数与 --uid 冲突', () => {
  assert.equal(resolveSystemdMode(0), 'system');
  assert.equal(resolveSystemdMode(1000), 'user');
  assert.equal(typeof currentUid(), 'number');

  const base = {
    unit: 'dsh-bg-abc',
    deadlineSec: 600,
    memoryMax: '4G',
    cpuQuota: '200%',
    workingDirectory: '/opt/dsh-companion/.data/work/proj',
    wrapperPath: '/opt/dsh-companion/.data/bg-jobs/abc/run.sh',
  };
  const asUser = buildSystemdRunArgs({ ...base, user: true });
  assert.equal(asUser[0], '--user');
  assert.equal(asUser[1], '--no-ask-password');
  assert.equal(asUser.includes('--uid'), false);
  assert.ok(asUser.includes('MemoryMax=4G'));
  assert.ok(asUser.includes('CPUQuota=200%'));
  assert.ok(asUser.includes('RuntimeMaxSec=600'));
  assert.deepEqual(asUser.slice(-2), ['/bin/sh', base.wrapperPath]);

  const asSystem = buildSystemdRunArgs({ ...base, user: false, runAs: 'trainer' });
  assert.equal(asSystem[0], '--no-ask-password', 'system 模式不加 --user');
  assert.equal(asSystem.includes('--user'), false);
  assert.deepEqual(asSystem.slice(asSystem.indexOf('--uid')), ['--uid', 'trainer', '/bin/sh', base.wrapperPath]);

  // user 模式不能切身份：配置层先报错，launcher 再兜一层。
  assert.throws(
    () => buildSystemdRunArgs({ ...base, user: true, runAs: 'trainer' }),
    /user 模式/u,
  );
});

test('D21-H4：user 模式补齐 XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS（已有则沿用）', () => {
  const filled = userModeEnv(1000, {});
  assert.equal(filled.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(filled.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');

  const kept = userModeEnv(1000, {
    XDG_RUNTIME_DIR: '/custom/runtime',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/custom/bus',
  });
  assert.equal(kept.XDG_RUNTIME_DIR, '/custom/runtime');
  assert.equal(kept.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/custom/bus');

  const half = userModeEnv(1000, { XDG_RUNTIME_DIR: '/custom/runtime' });
  assert.equal(half.XDG_RUNTIME_DIR, '/custom/runtime');
  assert.equal(half.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
});

test('D21-H4：bgSelfCheck 按模式跑 systemd-run（portable 直接可用）', async () => {
  // portable（本机 Windows）
  assert.deepEqual(
    await bgSelfCheck({ platform: 'win32' }),
    { ok: true, mode: 'portable', reason: null, message: null, missingControllers: [] },
  );

  // Linux system 模式：参数必须与真实拉起同一组 cgroup 属性。
  const systemCalls = [];
  const system = await bgSelfCheck({
    platform: 'linux',
    uid: 0,
    run: async (command, args, options) => {
      systemCalls.push({ command, args, options });
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(system.ok, true);
  assert.equal(system.mode, 'system');
  assert.equal(systemCalls[0].command, 'systemd-run');
  const args = systemCalls[0].args;
  assert.equal(args[0], '--no-ask-password');
  assert.equal(args.includes('--user'), false);
  assert.ok(args.includes('--wait'));
  assert.ok(args.includes('--collect'));
  assert.ok(args.includes('RuntimeMaxSec=60'));
  assert.ok(args.includes('MemoryMax=4G'));
  assert.ok(args.includes('CPUQuota=200%'));
  assert.deepEqual(args.slice(-1), ['/bin/true']);

  // Linux user 模式：--user + 环境补齐。
  const userCalls = [];
  const user = await bgSelfCheck({
    platform: 'linux',
    uid: 1000,
    run: async (command, callArgs, options) => {
      userCalls.push({ command, args: callArgs, options });
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(user.ok, true);
  assert.equal(user.mode, 'user');
  assert.equal(userCalls[0].args[0], '--user');
  assert.equal(userCalls[0].options.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(userCalls[0].options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.ok(Array.isArray(user.missingControllers));

  // 自检失败 → bg_run 不可用（stderr 原文进 message）。
  const failed = await bgSelfCheck({
    platform: 'linux',
    uid: 1000,
    run: async () => {
      throw Object.assign(new Error('exit 1'), { stderr: 'Failed to connect to bus: No such file or directory' });
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'self-check-failed');
  assert.match(failed.message, /No such file or directory/u);
});

test('v0.7.11 V710-L2：bg.runAs 在 user 模式下只 warn（bg 不可用，插件照常加载），root 下保留', () => {
  const warnings = [];
  const asUser = normalizeBg({ runAs: 'trainer' }, warnings, { uid: 1000 });
  assert.equal(asUser.runAs, 'trainer');
  assert.equal(asUser.unavailableReason, 'runas-unsupported');
  assert.match(asUser.unavailableMessage ?? '', /bg\.runAs/u);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bg\.runAs/u);
  const asRoot = normalizeBg({ runAs: 'trainer' }, [], { uid: 0 });
  assert.equal(asRoot.runAs, 'trainer');
  assert.equal(asRoot.unavailableReason, null);
  assert.equal(asRoot.unavailableMessage, null);
});

test('D21-H4：自检失败 → bg_run 返回 bg-unavailable（不再假装派出）', async () => {
  const store = makeStore();
  const tools = createTools(toolOptions(store, undefined, {
    bgConfig: () => ({ bg: normalizeBg({ workRoot: '/opt/dsh-companion/.data/work' }) }),
    bgAvailability: () => ({
      ok: false,
      mode: 'user',
      reason: 'self-check-failed',
      message: 'systemd 自检失败（user 模式）：Failed to connect to bus',
    }),
  }));
  const tool = tools.find((item) => item.name === 'bg_run');
  const result = await tool.execute({ argv: ['python3', 'train.py'], cwd: 'proj' }, {});
  assert.deepEqual(result, {
    ok: false,
    reason: 'bg-unavailable',
    message: 'systemd 自检失败（user 模式）：Failed to connect to bus',
  });
});

// ------------------------------------------------------------------ D21-M1

test('D21-M1：连续三个 1.5K 区间合并成 4.5K 并解除累积标记', () => {
  const store = makeMetaStore();
  const state = {
    pendingCompact: createPendingCompacts(),
    store,
    config: { compactMinRegionTokens: 4096 },
    platform: { log() {} },
  };
  rememberConsolidatedRegion(state, { scope: 'main', id: 'c1', startSeq: 2, endSeq: 4, tokens: 1500 });
  rememberConsolidatedRegion(state, { scope: 'main', id: 'c2', startSeq: 5, endSeq: 7, tokens: 1500 });
  rememberConsolidatedRegion(state, { scope: 'main', id: 'c3', startSeq: 8, endSeq: 10, tokens: 1500 });

  const pending = peekPendingCompact(state.pendingCompact, 'main');
  assert.equal(pending.startSeq, 2, 'startSeq 取最早起点');
  assert.equal(pending.endSeq, 10);
  assert.equal(pending.tokens, 4500);
  assert.equal(pending.accumulating, undefined, '累计达标后解除累积标记');
  assert.equal(pending.id, 'c3');

  // 落库 + 重启恢复（D21-M1 要求累积状态不丢）。
  assert.equal(store.meta.has('pending_compact:main'), true);
  const recovered = recoverPendingCompacts(store);
  const restored = peekPendingCompact(recovered, 'main');
  assert.equal(restored.startSeq, 2);
  assert.equal(restored.endSeq, 10);
  assert.equal(restored.tokens, 4500);
  assert.equal(restored.accumulating, undefined);
});

test('D21-M1：未达门槛时保持累积，新区间起点在旧区间之后即合并', () => {
  const store = makeMetaStore();
  const state = {
    pendingCompact: createPendingCompacts(),
    store,
    config: { compactMinRegionTokens: 4096 },
    platform: { log() {} },
  };
  rememberConsolidatedRegion(state, { scope: 'main', id: 'c1', startSeq: 2, endSeq: 4, tokens: 1500 });
  const first = peekPendingCompact(state.pendingCompact, 'main');
  assert.equal(first.accumulating, true);
  assert.equal(first.tokens, 1500);

  // 下一段区间起点落在旧区间之后即合并（巩固区间天然连续；中间若有 gap 也不查，
  // 过期 seq 交给 maybeCompact 丢弃）。
  rememberConsolidatedRegion(state, { scope: 'main', id: 'c2', startSeq: 20, endSeq: 22, tokens: 1500 });
  const second = peekPendingCompact(state.pendingCompact, 'main');
  assert.equal(second.startSeq, 2, '起点取最早的旧区间');
  assert.equal(second.endSeq, 22);
  assert.equal(second.tokens, 3000);
  assert.equal(second.accumulating, true);
  assert.equal(second.id, 'c2');

  // 丢弃（区间过期 / 压缩完成）要同时清掉落库状态。
  forgetPendingCompact(state, 'main');
  assert.equal(peekPendingCompact(state.pendingCompact, 'main'), null);
  assert.equal(store.meta.has('pending_compact:main'), false);
});

// ------------------------------------------------------------------ D21-M2

test('D21-M2：deliverySignal 是可用的 AbortSignal（throwIfAborted 不抛）', () => {
  const signal = deliverySignal({ requestId: 'companion-bg-wake:bg-1' });
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.equal(signal.throwIfAborted(), undefined);
  // deliverySignal 把 requestId 附加成 rpcId（宿主 prompt 的旧协议字段）。
  assert.equal(signal.rpcId, 'companion-bg-wake:bg-1');
  assert.equal(signal.kind, 'user');
});

test('D21-M2：sendToSubagent 缺 signal 时自动补真 signal（不再传 {}）', async () => {
  // **非真机证据**：宿主 sendMessage 用替身；真实校验见 dsh-subagent/src/index.ts:368-375。
  const captured = [];
  const ctx = {
    get(name) {
      if (name === 'subagents') {
        return {
          startActivation() { throw new Error('unused'); },
          async sendMessage(sender, targetId, content, options) {
            // 宿主实现会直接调 signal.throwIfAborted()；传 {} 会在这里抛 TypeError。
            options.signal.throwIfAborted();
            captured.push({ sender, targetId, content, options });
            return 'message-1';
          },
        };
      }
      if (name === 'agents') return { get: () => null };
      return undefined;
    },
    get now() { return () => NOW_MS; },
    get cwd() { return process.cwd(); },
    log() {},
    on() {},
    effect() {},
  };
  const { createAdapter } = await import('../src/platform/adapter.js');
  const adapter = createAdapter(ctx);
  const sender = { id: 'agent-1' };
  await adapter.sendToSubagent(sender, 'child-1', [{ type: 'text', text: '醒醒' }], {});
  assert.equal(captured.length, 1);
  assert.ok(captured[0].options.signal instanceof AbortSignal);
  assert.equal(captured[0].targetId, 'child-1');
});
