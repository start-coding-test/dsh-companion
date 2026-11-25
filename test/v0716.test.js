/**
 * v0.7.16 N1–N5 回归用例。
 *
 * **非真机证据**：Windows 开发机没有用户级 systemd / polkit / cgroup，也没有真的
 * dsh-im 或宿主 Agent；这里全部用替身注入（probe / unitResult / signal / wake /
 * agent.send / proactive.enqueue），真机时序（RuntimeMaxSec → TERM → trap → exit
 * 143、systemctl --user stop、notice 送达）属云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { createTaskRunner } from '../src/task/run.js';
import { cancelBgJob, monitorBgJobs, BG_JOB_STATES } from '../src/task/bg-jobs.js';
import { normalizeConfig } from '../src/config.js';
import { createTools } from '../src/runtime/tools.js';
import { formatStopTaskReply } from '../src/runtime/commands.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import {
  deliverBgFallback,
  readReceiptDeliveryRecord,
  wakeBgJob,
  apply as applyCordis,
} from '../src/index.js';

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function tick(times = 2) {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => undefined);
  return chain;
}

/** 最小 state 替身：wakeBgJob 只用到 store/platform/proactive。 */
function makeState(overrides = {}) {
  const events = [];
  const updates = [];
  const enqueued = [];
  const state = {
    store: {
      events,
      updates,
      appendEvent(input) {
        events.push(input);
        return events.length;
      },
      updateBgJob(id, patch) {
        updates.push({ id, patch });
        return true;
      },
    },
    platform: {
      now: () => NOW_MS,
      log() {},
      sendToSubagent: async () => 'sent',
      agentBySessionId: () => ({ id: 'agent-main' }),
      ...overrides.platform,
    },
    proactive: {
      enqueue: (item) => {
        enqueued.push(item);
        if (typeof item.onSent === 'function') item.onSent();
        return { queued: true, dropped: false, duplicate: false };
      },
      flush: async () => ({}),
    },
    config: { receipt: { im: { botId: '', targetId: '' }, sessionNotice: true } },
    im: { available: true, mode: 'session', channel: 'session' },
    mainSessionId: 's-main',
  };
  return { state, events, updates, enqueued };
}

// ---------------------------------------------------------------- N1

const N1_CASES = [
  {
    name: 'N1 非真机证据：exit 143 且已过 deadline → timeout',
    exitCode: 143,
    deadline: NOW_S - 60,
    unitResult: null,
    expectState: BG_JOB_STATES.timeout,
    expectTimedOut: true,
  },
  {
    name: 'N1 非真机证据：exit 143、未过 deadline、Result 查不到 → 正常结束',
    exitCode: 143,
    deadline: NOW_S + 600,
    unitResult: null,
    expectState: BG_JOB_STATES.woken,
    expectTimedOut: false,
  },
  {
    name: 'N1 非真机证据：exit 0（非 143/137）→ 正常结束',
    exitCode: 0,
    deadline: NOW_S - 60,
    unitResult: 'timeout',
    expectState: BG_JOB_STATES.woken,
    expectTimedOut: false,
  },
];

for (const item of N1_CASES) {
  test(item.name, async () => {
    const store = Store.open(':memory:');
    store.insertBgJob({
      id: 'bg-1',
      label: '训练',
      argv: ['python3', '/opt/work/train.py'],
      cwd: '/opt/work',
      child_session_id: 'child-1',
      pid_or_unit: 'dsh-bg-1',
      started_at: NOW_S - 10,
      deadline: item.deadline,
      log_path: '/opt/logs/bg-1/output.log',
    });
    const wakes = [];
    const summary = await monitorBgJobs({
      store,
      config: normalizeConfig({}),
      wake: async (info) => {
        wakes.push(info);
        return { delivered: true };
      },
      nowMs: NOW_MS,
      launcher: {
        probeBgProcess: async () => ({ running: false, exited: true, exitCode: item.exitCode }),
        signalBgProcess: async () => true,
        unitResult: async () => item.unitResult,
        readExitCode: () => item.exitCode,
        tailLog: () => 'tail',
        capLogFile: () => false,
      },
    });
    const job = store.getBgJob('bg-1');
    store.close();
    assert.equal(job.state, item.expectState, '终态');
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].timedOut, item.expectTimedOut, 'wake.timedOut');
    assert.equal(summary.timedOut + summary.woken, 1);
  });
}

// ---------------------------------------------------------------- N2

test('N2 非真机证据：取消 → 终态 cancelled（不再是 failed），回执「状态：已取消」', async () => {
  const platform = {
    capabilities: { subagents: true },
    log() {},
    async startSubagent() {
      const resolvers = Promise.withResolvers();
      return {
        childId: 'child-cancel',
        result: resolvers.promise,
        dispose: async () => {
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
    title: '长任务',
    agent: { id: 'agent-1' },
    subagent: { enabled: true, label: '长任务' },
    onReceipt: async (info) => { receipts.push(info); },
  });
  assert.equal(started.ok, true);
  await tick();
  assert.equal(runner.stopTaskById(started.taskId), true);
  const result = await started.done;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'cancelled', '取消是独立终态，不落 failed');
  assert.equal(result.reason, 'cancelled');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'cancelled');
  assert.match(receipts[0].receipt, /^状态：已取消/u);
  assert.equal(readReceiptDeliveryRecord({ status: 'cancelled' }).taskStatus, 'cancelled');
});

// ---------------------------------------------------------------- N3

test('N3 非真机证据：唤醒成功 → 子代理 1 次 + 主会话恰好 1 条回执，且不改 woken-fallback', async () => {
  const sends = [];
  const { state, updates, enqueued } = makeState({
    platform: {
      sendToSubagent: async (sender, target, content, options) => {
        sends.push({ sender, target, content, options });
        return 'message-1';
      },
    },
  });
  const job = { id: 'bg-1', label: '训练', child_session_id: 'child-1', log_path: '/opt/logs/bg-1/output.log' };
  const info = {
    job,
    message: '[后台任务] bg-1 训练 已结束\n退出码：0\n日志：/opt/logs/bg-1/output.log',
    exitCode: 0,
    timedOut: false,
    lost: false,
    allowWake: true,
    state: BG_JOB_STATES.woken,
  };
  const result = await wakeBgJob(state, info);
  assert.equal(result.channel, 'subagent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.signal instanceof AbortSignal, true);
  assert.equal(enqueued.length, 1, '唤醒成功也要给主会话一条');
  assert.match(enqueued[0].text, /已唤醒发起它的子代理继续处理/u);
  assert.match(enqueued[0].text, /已结束/u);
  assert.equal(enqueued[0].dedupeKey, 'task-receipt:bg-1');
  assert.equal(updates.length, 0, '成功路径不得把状态改成 woken-fallback');
});

test('L2 非真机证据：兜底投递只在 woken 行降级 woken-fallback（timeout/lost/failed/cancelled 保持终态）', async () => {
  const arms = [
    { settled: 'woken', allowWake: false, downgrade: true },
    { settled: 'woken', allowWake: true, wakeFails: true, downgrade: true },
    { settled: 'timeout', allowWake: false, downgrade: false },
    { settled: 'lost', allowWake: false, downgrade: false },
    { settled: 'failed', allowWake: false, downgrade: false },
    { settled: 'cancelled', allowWake: false, downgrade: false },
  ];
  for (const arm of arms) {
    const sends = [];
    const { state, updates, enqueued } = makeState({
      platform: {
        sendToSubagent: async () => {
          sends.push(1);
          if (arm.wakeFails === true) throw new Error('UNAUTHORIZED');
          return 'sent';
        },
      },
    });
    state.store.getBgJob = () => ({ id: 'bg-2', state: arm.settled });
    const info = {
      job: { id: 'bg-2', label: '训练', child_session_id: 'child-2', log_path: '/opt/logs/bg-2/output.log' },
      message: '[后台任务] bg-2 训练 已结束\n退出码：1',
      exitCode: 1,
      timedOut: false,
      lost: false,
      allowWake: arm.allowWake,
      state: arm.settled,
    };
    const result = await wakeBgJob(state, info);
    assert.equal(result.channel, 'main');
    assert.equal(sends.length, arm.allowWake ? 1 : 0, `${arm.settled}/${arm.allowWake} 唤醒调用次数`);
    assert.equal(enqueued.length, 1, `${arm.settled}/${arm.allowWake} 只投一条`);
    assert.equal(updates.length, arm.downgrade ? 1 : 0, `${arm.settled}/${arm.allowWake} 状态写入次数`);
    if (arm.downgrade) {
      assert.equal(updates[0].patch.state, 'woken-fallback');
    } else {
      assert.doesNotMatch(JSON.stringify(updates), /woken-fallback/u, `${arm.settled} 不得被兜底抹掉`);
    }
  }
});

test('N3 非真机证据：兜底回执的 task_status 按终态映射（不再恒 ok）', async () => {
  const cases = [
    [{ timedOut: true }, 'timeout'],
    [{ lost: true }, 'lost'],
    [{ exitCode: 2 }, 'failed'],
    [{ exitCode: 0 }, 'ok'],
    [{ cancelled: true }, 'cancelled'],
  ];
  for (const [outcome, expected] of cases) {
    const { state, enqueued } = makeState();
    deliverBgFallback(state, { id: 'bg-3', label: 'x', log_path: '/l' }, '正文', 'reason', outcome);
    assert.equal(enqueued.length, 1);
    const record = state.store.events.find((event) => event.detail_json?.kind === 'task_receipt_delivery');
    assert.equal(record.detail_json.task_status, expected, JSON.stringify(outcome));
  }
});

// ---------------------------------------------------------------- N4

test('N4 非真机证据：cancelBgJob 按同一模式 systemctl stop，状态原子迁到 cancelled', async () => {
  const store = Store.open(':memory:');
  store.insertBgJob({
    id: 'bg-c1',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    pid_or_unit: 'dsh-bg-c1',
    started_at: NOW_S - 10,
    deadline: NOW_S + 3600,
    log_path: '/opt/logs/bg-c1/output.log',
  });
  const calls = [];
  const result = await cancelBgJob({
    store,
    jobId: 'bg-c1',
    // 钉死 uid，与运行平台身份解耦：Linux（uid≠0）会走用户级 systemd，
    // 若不传参，期望值会随 currentUid() 漂移（Windows 0 / Linux 1000）。
    uid: 0,
    nowMs: NOW_MS,
    launcher: {
      signal: async (args) => {
        calls.push(args);
        return true;
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    unit: 'dsh-bg-c1',
    pid: null,
    kind: 'linux',
    signal: 'TERM',
    user: false,
    uid: 0,
  });
  const job = store.getBgJob('bg-c1');
  // L1（v0.7.17）：cancelBgJob 只受理（claim cancelling + TERM），收敛与回执由 monitor 负责。
  assert.equal(job.state, BG_JOB_STATES.cancelling);
  const requestAudit = store.listEvents({}).find((event) => event.reason === 'bg_job_cancel_requested');
  assert.ok(requestAudit, '取消受理要留审计');

  // 同一用例第二臂：uid 1000（50041 ubuntu 生产实态）必须走用户级实例的 stop 形状。
  const userStore = Store.open(':memory:');
  userStore.insertBgJob({
    id: 'bg-c2',
    label: '训练2',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-2',
    pid_or_unit: 'dsh-bg-c2',
    started_at: NOW_S - 10,
    deadline: NOW_S + 3600,
    log_path: '/opt/logs/bg-c2/output.log',
  });
  const userCalls = [];
  const userResult = await cancelBgJob({
    store: userStore,
    jobId: 'bg-c2',
    nowMs: NOW_MS,
    uid: 1000,
    launcher: {
      signal: async (args) => { userCalls.push(args); return true; },
    },
  });
  userStore.close();
  assert.equal(userResult.ok, true);
  assert.deepEqual(userCalls[0], {
    unit: 'dsh-bg-c2',
    pid: null,
    kind: 'linux',
    signal: 'TERM',
    user: true,
    uid: 1000,
  });
  // L1 收敛：probe 报「已退出 143」→ monitor 把 cancelling 收敛成 cancelled，
  // 恰好一条取消回执（deliverCancel）且零 wake（判别是否误走 woken 收敛）。
  const wakes = [];
  const delivered = [];
  const launcher = {
    probeBgProcess: async () => ({ running: false, exited: true, exitCode: 143 }),
    signalBgProcess: async () => true,
    unitResult: async () => null,
    readExitCode: () => 143,
    tailLog: () => '',
    capLogFile: () => false,
  };
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async (info) => { wakes.push(info); return { delivered: true }; },
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: NOW_MS,
    launcher,
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(delivered.length, 1);
  assert.equal(wakes.length, 0);
  assert.equal(store.getBgJob('bg-c1').state, BG_JOB_STATES.cancelled);
  const finalAudit = store.listEvents({}).find((event) => event.reason === 'bg_job_cancelled');
  assert.ok(finalAudit, '收敛要留审计');
  const againSummary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async () => ({ delivered: true }),
    nowMs: NOW_MS,
    launcher,
  });
  assert.equal(againSummary.checked, 0);
  assert.equal(delivered.length, 1);

  const again = await cancelBgJob({ store: { getBgJob: () => null }, jobId: 'bg-c1', nowMs: NOW_MS });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'not-found');
});

test('N4 非真机证据：systemctl stop 抛错 → stop-failed（不假装成功）', async () => {
  const store = Store.open(':memory:');
  store.insertBgJob({
    id: 'bg-c2',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    pid_or_unit: 'dsh-bg-c2',
    started_at: NOW_S - 10,
    deadline: NOW_S + 3600,
    log_path: '/opt/logs/bg-c2/output.log',
  });
  const result = await cancelBgJob({
    store,
    jobId: 'bg-c2',
    nowMs: NOW_MS,
    launcher: { signal: async () => { throw new Error('Failed to connect to bus'); } },
  });
  const job = store.getBgJob('bg-c2');
  store.close();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stop-failed');
  assert.match(result.message, /Failed to connect to bus/u);
  assert.equal(job.state, BG_JOB_STATES.running, '停失败不能改状态');
});

test('N4 非真机证据：task_cancel 对 bg 任务走 cancelBgJob 并回执 cancelled', async () => {
  const store = Store.open(':memory:');
  store.insertBgJob({
    id: 'bg-t1',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    pid_or_unit: 'dsh-bg-t1',
    started_at: NOW_S - 10,
    deadline: NOW_S + 3600,
    log_path: '/opt/logs/bg-t1/output.log',
  });
  const receipts = [];
  const signals = [];
  const tools = createTools({
    store,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    registry: {},
    platform: { log() {} },
    clock: () => NOW_MS,
    cwd: '/tmp',
    taskReceipt: async (info) => { receipts.push(info); },
    bgLauncher: {
      signal: async (args) => {
        signals.push(args);
        return true;
      },
    },
  });
  const cancel = tools.find((tool) => tool.name === 'task_cancel');
  assert.match(cancel.description, /不要用 kill \/ pgrep \/ systemctl/u);
  const result = await cancel.execute({ taskId: 'bg-t1' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'bg');
  assert.equal(result.state, 'cancelling');
  assert.equal(signals.length, 1);
  // L1（v0.7.17）：工具只受理；回执由 monitor 收敛后发一次（避免双回执），此刻零回执。
  assert.equal(receipts.length, 0);
  assert.equal(store.getBgJob('bg-t1').state, BG_JOB_STATES.cancelling);
  const second = await cancel.execute({ taskId: 'bg-t1' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-cancelling');
  const missing = await cancel.execute({ taskId: 'bg-nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
  store.close();
});

test('N4：/停止任务 文案区分 task_run 与后台任务（含 label）', () => {
  const usage = formatStopTaskReply({
    usage: true,
    active: ['task-1', { id: 'bg-1', label: '训练', kind: 'bg' }],
  });
  assert.match(usage, /task-1/u);
  assert.match(usage, /bg-1（训练，后台任务）/u);
  const bgReply = formatStopTaskReply({
    taskId: 'bg-1',
    kind: 'bg',
    result: { ok: true, cancelled: 1, taskId: 'bg-1' },
  });
  assert.match(bgReply, /后台任务 bg-1/u);
  assert.match(bgReply, /取消中，收尾后回执送达/u);
});

// ---------------------------------------------------------------- S1（复核增量）

test('S1 非真机证据：/停止任务 <bg id> 走生产接线，回执为「已请求中止后台任务」', async () => {
  // 判别力：删掉 /停止任务 的 bg 分支或 requestCancelBgJob 调用，回执会退回「没有在跑的任务」而非本断言。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0716-s1-'));
  const dbPath = join(dir, 'store.db');
  try {
    const ctx = new FakeCtx({ now: NOW_MS });
    ctx.commands = {
      registrations: [],
      register(definition) { this.registrations.push(definition); return () => {}; },
    };
    ctx.tools = {
      registrations: [],
      register(definition) { this.registrations.push(definition); return () => {}; },
    };
    applyCordis(strictCtx(ctx), { dbPath });
    const seed = Store.open(dbPath);
    seed.insertBgJob({
      id: 'bg-dispatch-1',
      label: '训练分发',
      argv: ['python3', '/opt/work/train.py'],
      cwd: '/opt/work',
      child_session_id: 'child-s1',
      pid_or_unit: 'dsh-bg-dispatch-1',
      started_at: NOW_S - 10,
      deadline: NOW_S + 3600,
      log_path: '/opt/logs/bg-dispatch-1/output.log',
    });
    assert.equal(seed.getBgJob('bg-dispatch-1').state, BG_JOB_STATES.running);
    seed.close();

    const stop = ctx.commands.registrations.find((entry) => entry.name === 'stop-task');
    assert.ok(stop, 'stop-task 应已注册');
    const reply = stop.handler({ rawInput: 'bg-dispatch-1' });
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /已请求中止后台任务 bg-dispatch-1/u);
    assert.match(reply.text, /收尾后回执送达/u);
    // 生产接线判别：handler 同步返回后 requestCancelBgJob 会异步调 cancelBgJob。
    // 成功会投回执（dedupeKey task-receipt:<id>），失败（本机/容器没有可停的 unit）会留 warn；
    // 两者任一出现都证明接线被走到。删掉 requestCancelBgJob 调用即无任何痕迹。
    let wired = false;
    for (let i = 0; i < 100 && wired === false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      wired = ctx.logs.some((entry) => String(entry.message).includes('bg job cancel'));
    }
    if (wired === false) {
      const check = Store.open(dbPath);
      wired = [BG_JOB_STATES.cancelling, BG_JOB_STATES.cancelled].includes(check.getBgJob('bg-dispatch-1')?.state);
      check.close();
    }
    assert.equal(wired, true, '命令必须触发 requestCancelBgJob（生产接线）');
  } finally {
    // 插件的 Store 句柄仍开在 dbPath 上（测试里不跑宿主 dispose），Windows 删不掉临时目录；
    // 这里尽力清理即可，清理失败不影响断言。
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 保留临时目录 */ }
  }
});
