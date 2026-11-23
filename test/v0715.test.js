/**
 * v0.7.15 真机反馈修复测试（P1 / H1 / H2 / M1 / M2 / M3 / L1 / L2）。
 *
 * **非真机证据**：宿主 agent.send / agent.status、systemd-run/systemctl、Windows
 * 侧文件系统都替换为替身；Linux 用户级 systemd、polkit、cgroup 与 QQ 出站属云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { normalizeConfig } from '../src/config.js';
import { createTools } from '../src/runtime/tools.js';
import { createTaskRunner, startTask, taskRunnerStats } from '../src/task/run.js';
import { buildPosixWrapper, DEFAULT_BG_LOG_ROOT, systemdUnitResult } from '../src/task/bg-launcher.js';
import { BG_JOB_STATES, monitorBgJobs } from '../src/task/bg-jobs.js';
import {
  bgFallbackTaskStatus,
  deliverBgFallback,
  deliverSessionNotice,
  deliverTaskReceipt,
  hasRealUserInput,
  isInjectedMessage,
  lastUserText,
  TASK_RECEIPT_SOURCE_KIND,
} from '../src/index.js';

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

/** 最小 Store 替身：审计事件 + bg job 读写。 */
function makeStore() {
  return {
    events: [],
    jobs: new Map(),
    appendEvent(input) {
      this.events.push(input);
      return this.events.length;
    },
    updateBgJob(id, patch) {
      const job = this.jobs.get(id);
      if (job) this.jobs.set(id, { ...job, ...patch });
      return true;
    },
  };
}

/** 记录发出的 notice。 */
function makeAgent(status = 'idle') {
  return {
    status,
    sent: [],
    send(message, target, wakeup) {
      this.sent.push({ message, target, wakeup });
    },
  };
}

function makeState(overrides = {}) {
  const store = overrides.store ?? makeStore();
  return {
    store,
    platform: {
      now: () => NOW_MS,
      log() {},
      ...overrides.platform,
    },
    config: overrides.config ?? { receipt: { im: { botId: '', targetId: '' }, sessionNotice: true } },
    proactive: overrides.proactive ?? {
      enqueue: () => ({ queued: true, dropped: false }),
      flush: async () => ({}),
    },
    im: overrides.im ?? null,
    receiptDeliveryLog: overrides.receiptDeliveryLog,
    mainSessionId: overrides.mainSessionId === undefined ? 's-main' : overrides.mainSessionId,
  };
}

// ---------------------------------------------------------------------------
// P1：回执只交主会话（notice + 唤醒），绝不当用户发言
// ---------------------------------------------------------------------------

test('P1 非真机证据：空闲唤醒 next-turn、忙 steer，notice 形状正确且三处排除集认得出', async () => {
  for (const [status, target] of [['idle', 'next-turn'], ['running', 'next-step']]) {
    const agent = makeAgent(status);
    const state = makeState({ platform: { agentBySessionId: () => agent } });
    const channel = { mode: 'session', channel: 'session', available: true, lastDelivery: null };
    state.im = channel;

    await deliverSessionNotice(state, '状态：成功\n写完了周报。');

    assert.equal(agent.sent.length, 1, `${status} 应投递一次`);
    const [{ message, target: actualTarget, wakeup }] = agent.sent;
    assert.equal(actualTarget, target);
    assert.equal(wakeup, true, '唤醒由宿主 status 决定：两种目标都 wakeup=true');
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, TASK_RECEIPT_SOURCE_KIND);
    assert.notEqual(message.source.kind, 'user', '绝不能冒充用户发言');
    assert.equal(message.source.form, 'notice');
    assert.ok(Array.from(message.source.summary).length <= 60);
    assert.match(message.content[0].text, /^这是后台任务回执，不是用户发言/u);
    assert.match(message.content[0].text, /状态：成功/u);
    assert.equal(channel.lastDelivery.ok, true);
    assert.equal(channel.lastDelivery.channel, 'session');

    // 三处排除集：不当用户发言参与巩固/重绑/召回。
    assert.equal(isInjectedMessage(message), true);
    assert.equal(hasRealUserInput([message]), false);
    assert.equal(lastUserText([message]), '');
  }
});

test('P1 非真机证据：取不到主会话 / 取不到 agent 都抛错交给 outbox 退避，不静默成功', async () => {
  const noSession = makeState({ store: { ...makeStore(), getMeta: () => null }, mainSessionId: null });
  noSession.im = { mode: 'session', lastDelivery: null };
  assert.throws(() => deliverSessionNotice(noSession, 'x'), (error) => error.code === 'session-unavailable');
  assert.equal(noSession.im.lastDelivery.ok, false);

  const noAgent = makeState({ platform: { agentBySessionId: () => undefined } });
  noAgent.im = { mode: 'session', lastDelivery: null };
  assert.throws(() => deliverSessionNotice(noAgent, 'x'), (error) => error.code === 'agent-unavailable');

  const broken = makeState({
    platform: { agentBySessionId: () => ({ status: 'idle', send: () => { throw new Error('inbox closed'); } }) },
    currentMainSessionId: () => 's-main',
  });
  broken.im = { mode: 'session', lastDelivery: null };
  assert.throws(() => deliverSessionNotice(broken, 'x'), (error) => error.code === 'session-delivery-failed');
});

// ---------------------------------------------------------------------------
// H2：结束回执独占 dedupeKey；被去重时留 status=duplicate 一行
// ---------------------------------------------------------------------------

test('H2 非真机证据：结束回执 dedupeKey 独占 jobId；enqueue 判重时落 status=duplicate', () => {
  const store = makeStore();
  const enqueueCalls = [];
  const state = makeState({
    store,
    proactive: {
      enqueue(item) {
        enqueueCalls.push(item);
        return { queued: false, dropped: false, duplicate: true };
      },
      flush: async () => ({}),
    },
  });

  deliverTaskReceipt(state, {
    taskId: 'bg-mw1-9f2',
    status: 'ok',
    receipt: '训练完成，loss=0.09',
    title: '训练',
    sessionId: 'child-1',
  });

  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].dedupeKey, 'task-receipt:bg-mw1-9f2', '结束回执独占该 key（启动告知已删除）');
  assert.ok(enqueueCalls[0].text.startsWith('[任务] '));

  const delivery = store.events.filter((event) => event.detail_json.kind === 'task_receipt_delivery');
  assert.equal(delivery.length, 1, '被判重也必须留一条证据');
  assert.equal(delivery[0].detail_json.status, 'duplicate');
  assert.equal(delivery[0].reason, 'task_receipt_duplicate');
  assert.equal(delivery[0].detail_json.task_status, 'ok');

  // 同一状态不再重复写（H2 的 duplicate 与 V713-L2 状态机共用一套 Map）。
  deliverTaskReceipt(state, {
    taskId: 'bg-mw1-9f2', status: 'ok', receipt: '训练完成，loss=0.09', title: '训练', sessionId: 'child-1',
  });
  assert.equal(store.events.filter((event) => event.detail_json.kind === 'task_receipt_delivery').length, 1);
});

// ---------------------------------------------------------------------------
// M2：task_cancel 工具取消在跑任务并释放槽位
// ---------------------------------------------------------------------------

test('M2 非真机证据：task_cancel 命中在跑 task_run → cancelled 终态、槽位释放；未知 id → not-found', async () => {
  const receipts = [];
  const specRef = { spec: null };
  const platform = {
    capabilities: { subagents: true },
    now: () => NOW_MS,
    log() {},
    startSubagent(spec) {
      specRef.spec = spec;
      return {
        childId: 'child-cancel-1',
        // 宿主真实行为：signal 只在创建期生效，运行中不结算（activation.ts:41-42）。
        result: new Promise(() => {}),
        dispose: async () => {},
      };
    },
  };

  const started = startTask({
    platform,
    goal: '长时间训练',
    title: '训练',
    at: NOW_MS,
    agent: { id: 'agent-main' },
    subagent: { enabled: true, name: 'trainer', label: '训练', model: null },
    onReceipt: async (info) => receipts.push(info),
  });
  assert.equal(started.ok, true);
  assert.ok(specRef.spec, '执行已启动');

  const tools = createTools({
    store: makeStore(),
    retrieve: async () => ({ items: [] }),
    registry: {},
    platform,
    clock: () => NOW_MS,
  });
  const cancelTool = tools.find((tool) => tool.name === 'task_cancel');
  assert.ok(cancelTool, 'v0.7.15 M2 新增 task_cancel 工具');

  const cancelled = await cancelTool.execute({ taskId: started.taskId }, {});
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.taskId, started.taskId);

  const done = await started.done;
  assert.equal(done.reason, 'cancelled');
  assert.match(done.receipt, /已取消/u);
  assert.equal(receipts.length, 1, '取消也要给一次回执');
  assert.equal(receipts[0].reason, 'cancelled');
  assert.equal(taskRunnerStats().active, 0, 'cancelled 终态释放执行槽');

  const missing = await cancelTool.execute({ taskId: 'task-not-exist' }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'not-found');
});

// ---------------------------------------------------------------------------
// M3：有 title 时保留结论正文
// ---------------------------------------------------------------------------

test('M3 非真机证据：标题 + 结论都进 summary（结论 ≤300 字）', async () => {
  const runner = createTaskRunner();
  const platform = {
    capabilities: { subagents: true },
    now: () => NOW_MS,
    log() {},
    startSubagent: () => ({
      childId: 'child-m3',
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '周报已写好：/opt/work/report.md' }] }),
      dispose: async () => {},
    }),
  };
  const result = await runner.runTask({
    platform,
    store: makeStore(),
    goal: '写一份周报',
    title: '周报',
    at: NOW_MS,
    agent: { id: 'agent-m3' },
    subagent: { enabled: true, name: 'writer', label: '周报', model: null },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.match(result.receipt, /状态：成功/u);
  // M3：标题与结论都在回执里。formatReceipt 会把 summary 里的换行压成空格，
  // 所以验收点不是「真的换行」，而是结论正文不再被标题吃掉。
  assert.match(result.receipt, /结论：周报 .*report\.md/u, '标题 + 子代理结论正文');
});

/** 复用 task_run 的 worker 路径：createSession → prompt → whenIdle。 */
function makeWorkerPlatform() {
  let seq = 0;
  return {
    capabilities: { compaction: false },
    now: () => NOW_MS,
    log() {},
    async createSession() {
      seq += 1;
      return { id: `s-${seq}` };
    },
    async prompt() {},
    async whenIdle() {
      return { status: 'idle' };
    },
    async cleanInbox() {},
    async cancelTask() {},
  };
}

// ---------------------------------------------------------------------------
// M1：SIGTERM 也要写退出码；超时判定优先看 systemctl Result 与 deadline
// ---------------------------------------------------------------------------

test('M1 非真机证据：wrapper 先 trap TERM 再 trap EXIT', () => {
  const wrapper = buildPosixWrapper({
    logPath: '/opt/logs/bg-1/output.log',
    exitPath: '/opt/logs/bg-1/exit',
    argv: ['python3', '/opt/work/train.py'],
  });
  const termIndex = wrapper.indexOf(`trap 'exit 143' TERM`);
  const exitIndex = wrapper.indexOf('trap ');
  assert.ok(termIndex >= 0, 'wrapper 必须在 EXIT trap 之前处理 SIGTERM');
  assert.ok(exitIndex >= 0);
  assert.ok(termIndex > exitIndex === false, 'TERM trap 先声明');
  assert.match(wrapper, /exit 143/u);
});

test('M1 非真机证据：unit Result=timeout → timeout；查不到但越过 deadline → timeout；否则 lost', async (t) => {
  const cases = [
    { unitResult: 'timeout', deadline: NOW_S + 600, expect: BG_JOB_STATES.timeout },
    { unitResult: null, deadline: NOW_S - 1, expect: BG_JOB_STATES.timeout },
    { unitResult: null, deadline: NOW_S + 600, expect: BG_JOB_STATES.lost },
  ];
  for (const item of cases) {
    const store = Store.open(':memory:');
    t.after(() => store.close());
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
    const summary = await monitorBgJobs({
      store,
      config: normalizeConfig({}),
      wake: async () => ({ delivered: true }),
      nowMs: NOW_MS,
      launcher: {
        probeBgProcess: async () => ({ running: false, exited: false, exitCode: null }),
        signalBgProcess: async () => true,
        unitResult: async () => item.unitResult,
        readExitCode: () => null,
        tailLog: () => 'tail',
        capLogFile: () => false,
      },
    });
    const job = store.getBgJob('bg-1');
    assert.equal(job.state, item.expect, `unitResult=${item.unitResult} deadline=${item.deadline}`);
    assert.equal(summary.lost + summary.timedOut, 1);
  }
});

// ---------------------------------------------------------------------------
// L1：bg 兜底回执按终态记 task_status
// ---------------------------------------------------------------------------

test('L1 非真机证据：bg 兜底不再固定 ok（timeout/lost/failed/ok 如实）', () => {
  assert.equal(bgFallbackTaskStatus({ timedOut: true }), 'timeout');
  assert.equal(bgFallbackTaskStatus({ lost: true }), 'lost');
  assert.equal(bgFallbackTaskStatus({ exitCode: 2 }), 'failed');
  assert.equal(bgFallbackTaskStatus({ exitCode: 0 }), 'ok');
  assert.equal(bgFallbackTaskStatus(null), 'ok');

  const store = makeStore();
  const state = makeState({
    store,
    proactive: {
      // outbox 成功投递时 proactive 会回调 onSent；替身直接同步触发。
      enqueue(item) {
        item.onSent();
        return { queued: true, dropped: false };
      },
      flush: async () => ({}),
    },
  });
  const job = { id: 'bg-9', label: '训练', child_session_id: 'child-9' };
  deliverBgFallback(state, job, '已超时被终止', 'wake-failed', { timedOut: true, exitCode: null });
  const event = store.events.find((item) => item.detail_json.kind === 'task_receipt_delivery');
  assert.ok(event, '兜底投递也要留投递记录');
  assert.equal(event.detail_json.task_status, 'timeout');
});

// ---------------------------------------------------------------------------
// L2：工具说明要求派出后直接回复、不要轮询
// ---------------------------------------------------------------------------

test('L2 非真机证据：task_run / bg_run 说明写明不要 sleep 或轮询', () => {
  const tools = createTools({
    store: makeStore(),
    retrieve: async () => ({ items: [] }),
    registry: {},
    platform: { capabilities: {}, now: () => NOW_MS, log() {} },
    clock: () => NOW_MS,
    bgConfig: () => ({ bg: normalizeConfig({}).bg }),
  });
  for (const name of ['task_run', 'bg_run']) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} 存在`);
    assert.match(tool.description, /不要在本轮 sleep 或轮询/u);
    assert.match(tool.description, /回执/u);
  }
  // task_run 的取消指引指向 task_cancel。
  assert.match(tools.find((item) => item.name === 'task_run').description, /task_cancel/u);
});

test('M1 非真机证据：DEFAULT_BG_LOG_ROOT 未变，wrapper 仍重定向到 output.log', () => {
  assert.equal(DEFAULT_BG_LOG_ROOT, '/opt/dsh-companion/.data/bg-jobs');
  const wrapper = buildPosixWrapper({
    logPath: '/opt/logs/bg-1/output.log', exitPath: '/opt/logs/bg-1/exit', argv: ['sleep', '5'],
  });
  assert.match(wrapper, /exec >> '\/opt\/logs\/bg-1\/output\.log' 2>&1/u);
});

test('M1 非真机证据：systemdUnitResult 的默认实现把 unit 拼进 systemctl 参数（不再是 [object Object]）', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: 'timeout\n' };
  };
  // 生产调用方是 `unitResultOf({ unit, user, uid })`（对象形状），这里必须走同一条。
  assert.equal(await systemdUnitResult({ unit: 'dsh-bg-abc' }, run), 'timeout');
  assert.deepEqual(calls[0].args, ['show', '-p', 'Result', '--value', 'dsh-bg-abc']);
  assert.equal(calls[0].command, 'systemctl');
  assert.equal(calls[0].options, undefined);

  // user 模式：加 --user 并带上同一套 XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS。
  assert.equal(await systemdUnitResult({ unit: 'dsh-bg-def', user: true, uid: 1000 }, run), 'timeout');
  assert.deepEqual(calls[1].args, ['--user', 'show', '-p', 'Result', '--value', 'dsh-bg-def']);
  assert.equal(calls[1].options.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(calls[1].options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');

  // 查询失败 / 空 unit 一律 null（宁可走 deadline 兜底，也不要抛给监视器）。
  assert.equal(await systemdUnitResult({ unit: 'dsh-bg-xyz' }, async () => { throw new Error('no bus'); }), null);
  assert.equal(await systemdUnitResult({}, run), null);
});
