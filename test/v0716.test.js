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

import { Store } from '../src/memory/store.js';
import { createTaskRunner } from '../src/task/run.js';
import { cancelBgJob, monitorBgJobs, BG_JOB_STATES } from '../src/task/bg-jobs.js';
import { normalizeConfig } from '../src/config.js';
import { createTools } from '../src/runtime/tools.js';
import { formatStopTaskReply } from '../src/runtime/commands.js';
import {
  deliverBgFallback,
  readReceiptDeliveryRecord,
  wakeBgJob,
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

test('N3 非真机证据：唤醒失败 / 预算耗尽 → 只有兜底一条，子代理 0 次', async () => {
  for (const [allowWake, reason] of [[true, 'wake-failed'], [false, 'wake-budget-exhausted']]) {
    const sends = [];
    const { state, updates, enqueued } = makeState({
      platform: {
        sendToSubagent: async () => {
          sends.push(1);
          throw new Error('UNAUTHORIZED');
        },
      },
    });
    const job = { id: 'bg-2', label: '训练', child_session_id: 'child-2', log_path: '/opt/logs/bg-2/output.log' };
    const info = {
      job,
      message: '[后台任务] bg-2 训练 已结束\n退出码：1',
      exitCode: 1,
      timedOut: false,
      lost: false,
      allowWake,
      state: BG_JOB_STATES.woken,
    };
    const result = await wakeBgJob(state, info);
    assert.equal(result.channel, 'main');
    assert.equal(enqueued.length, 1, `allowWake=${allowWake} 只投一条`);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.state, 'woken-fallback');
    assert.equal(reason === 'wake-failed' ? sends.length : 0, allowWake ? 1 : 0);
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
  assert.equal(job.state, BG_JOB_STATES.cancelled);
  const audit = store.listEvents({}).find((event) => event.reason === 'bg_job_cancelled');
  assert.ok(audit, '取消要留审计');
  // 监视器只扫 running：cancelled 行不会再被二次投递。
  const wakes = [];
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async (info) => { wakes.push(info); return { delivered: true }; },
    nowMs: NOW_MS,
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: false, exitCode: null }),
      signalBgProcess: async () => true,
      unitResult: async () => null,
      readExitCode: () => null,
      tailLog: () => '',
      capLogFile: () => false,
    },
  });
  store.close();
  assert.equal(summary.checked, 0);
  assert.equal(wakes.length, 0);

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
  assert.equal(signals.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'cancelled');
  assert.match(receipts[0].receipt, /已取消（用户主动停止）/u);
  assert.equal(store.getBgJob('bg-t1').state, BG_JOB_STATES.cancelled);

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
  assert.match(bgReply, /状态：已取消/u);
});
