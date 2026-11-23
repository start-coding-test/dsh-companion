/**
 * v0.7.13（R22-H1 / R22-H2 / R22-M1）——**v0.7.15（P1）已把 R22-H1 的回执通道改成
 * 「只交主会话」**，本文件按新语义改写（旧 dsh-im 出站断言改写而非删除）。
 *
 * 覆盖：receipt 配置、主会话 notice 通道（空闲唤醒 / 忙 steer / 失败退避 / 形状）、
 * /状态「回执通道」行、R22-M1 投递记录、R22-H2 成功态归类、startScheduler 生产接线。
 *
 * **非真机证据**：dsh-im 服务、宿主 `agent.send` 与子代理 activation 全部是替身。
 * 本机（Windows）没有 dsh-im 插件、没有 user systemd、也没有真实宿主子代理；
 * 宿主「下一轮 / 下一步」的真实排队行为与唤醒时机属 50041 云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { createProactive } from '../src/runtime/proactive.js';
import { handleCommand } from '../src/runtime/commands.js';
import { runSubagentTask } from '../src/task/subagent-runner.js';
import {
  deliverProactiveItem,
  deliverTaskReceipt,
  deliverSessionNotice,
  initReceiptChannel,
  noticeSummaryOf,
  readReceiptDeliveryRecord,
  recordTaskReceiptDelivery,
  startScheduler,
} from '../src/index.js';

const NOW = Date.parse('2026-11-22T10:00:00+08:00');
const PREAMBLE = '这是后台任务回执，不是用户发言；由你判断是否、何时、怎样告诉用户，不必逐条转述。';

function makeAgent({ status = 'idle', send } = {}) {
  const calls = [];
  return {
    status,
    calls,
    send(message, target, wakeup) {
      calls.push({ message, target, wakeup });
      if (typeof send === 'function') send(message, target, wakeup);
    },
  };
}

function makePlatform(extra = {}) {
  const logs = [];
  const prompts = [];
  return {
    logs,
    prompts,
    now: () => NOW,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    async prompt(request) {
      prompts.push(request);
    },
    agentBySessionId: () => null,
    ...extra,
  };
}

function makeState(platform, config, extra = {}) {
  return {
    platform,
    config,
    store: { getMeta: () => null },
    mainSessionId: 'session-main',
    ...extra,
  };
}

/* ------------------------------------------------------------ P1 配置 */

test('R22-H1：receipt 配置默认值、trim 与 sessionNotice 开关（非真机证据）', () => {
  const base = normalizeConfig({});
  assert.deepEqual(base.receipt.im, { botId: '', targetId: '' }, '默认不猜 bot/target');
  assert.equal(base.receipt.sessionNotice, true, 'sessionNotice 键保留（v0.7.15 起代码不再读）');

  const trimmed = normalizeConfig({ receipt: { im: { botId: ' bot-1 ', targetId: ' tg-1 ' } } });
  assert.deepEqual(trimmed.receipt.im, { botId: 'bot-1', targetId: 'tg-1' });

  const off = normalizeConfig({ receipt: { sessionNotice: false } });
  assert.equal(off.receipt.sessionNotice, false, '显式 false 必须保留');

  // 16 核心键 + 非枚举节扩展：receipt 是节级扩展（非枚举），不参与 16 键自检。
  assert.equal(Object.keys(base).includes('receipt'), true);
});

/* ------------------------------------------- P1 主会话 notice 通道 */

test('P1：主会话空闲时投递 notice（next-turn + wakeup=true，正文带前置说明）（非真机证据）', async () => {
  const agent = makeAgent({ status: 'idle' });
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({}));
  initReceiptChannel(state);
  assert.equal(state.im.available, true);
  assert.equal(state.im.mode, 'session');
  assert.equal(state.im.channel, 'session');
  assert.ok(platform.logs.some((entry) => entry.message === '[dsh-companion] receipt channel'));

  await deliverSessionNotice(state, '[任务] 状态：成功\n产物：/tmp/a.md');

  assert.equal(agent.calls.length, 1, '必须恰好投一次 notice');
  const call = agent.calls[0];
  assert.equal(call.target, 'next-turn', '空闲主会话走下一轮');
  assert.equal(call.wakeup, true, '必须唤醒主会话');
  assert.equal(call.message.role, 'user');
  assert.equal(call.message.source.kind, 'companion-task-receipt');
  assert.equal(call.message.source.form, 'notice');
  assert.equal(call.message.source.summary, '状态：成功', 'summary 去 [任务] 前缀、取首行');
  const body = call.message.content[0].text;
  assert.ok(body.startsWith(PREAMBLE), '正文前必须带一行「不是用户发言」说明');
  assert.match(body, /产物：\/tmp\/a\.md/u);
  assert.equal(state.im.lastDelivery.ok, true);
  assert.equal(state.im.lastDelivery.channel, 'session');
  assert.equal(platform.prompts.length, 0, '不得退回 platform.prompt');
});

test('P1：主会话忙时走 next-step + wakeup=true（steer 语义）（非真机证据）', async () => {
  const agent = makeAgent({ status: 'running' });
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({}));
  initReceiptChannel(state);

  await deliverSessionNotice(state, '[任务] 状态：完成');
  assert.equal(agent.calls[0].target, 'next-step', '忙时应插入下一步');
  assert.equal(agent.calls[0].wakeup, true);
});

test('P1：取不到主会话 agent → 抛 agent-unavailable 并记 lastDelivery（不退回 prompt）（非真机证据）', () => {
  const platform = makePlatform({ agentBySessionId: () => null });
  const state = makeState(platform, normalizeConfig({}));
  initReceiptChannel(state);

  assert.throws(
    () => deliverSessionNotice(state, '[任务] x'),
    (error) => error.code === 'agent-unavailable',
  );
  assert.equal(state.im.lastDelivery.ok, false);
  assert.equal(state.im.lastDelivery.code, 'agent-unavailable');
  assert.equal(platform.prompts.length, 0, '绝不退回 platform.prompt');
});

test('P1：agent.send 抛错 → session-delivery-failed（交给 proactive 退避）（非真机证据）', () => {
  const agent = makeAgent({ send: () => { throw new Error('inbox closed'); } });
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({}));
  initReceiptChannel(state);

  assert.throws(
    () => deliverSessionNotice(state, '[任务] x'),
    (error) => error.code === 'session-delivery-failed' && /inbox closed/u.test(error.message),
  );
  assert.equal(state.im.lastDelivery.code, 'session-delivery-failed');
  assert.equal(platform.prompts.length, 0);
});

test('P1：没有主会话（sessionId 为空）→ session-unavailable（非真机证据）', () => {
  const platform = makePlatform({ agentBySessionId: () => null });
  const state = makeState(platform, normalizeConfig({}), { mainSessionId: null });
  initReceiptChannel(state);

  assert.throws(
    () => deliverSessionNotice(state, '[任务] x'),
    (error) => error.code === 'session-unavailable',
  );
});

test('P1：dsh-im 即使存在也不被调用；配置了 receipt.im 只打「已停用」info（非真机证据）', async () => {
  const imCalls = [];
  const service = {
    contractVersion: 1,
    async send(...args) {
      imCalls.push(args);
      return { sent: true };
    },
  };
  const agent = makeAgent();
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({ receipt: { im: { botId: 'b', targetId: 't' } } }));
  // 旧代码会去 ctx.get('dshIm')；现在即便宿主能给出服务，也不应再取或调用。
  state.host = { get: () => service };
  initReceiptChannel(state);

  await deliverSessionNotice(state, '[任务] 状态：成功');
  assert.equal(agent.calls.length, 1);
  assert.equal(imCalls.length, 0, 'dshIm.send 必须 0 次');
  assert.equal(state.im.imConfigured, true);
  assert.ok(platform.logs.some((entry) => entry.message === '[dsh-companion] receipt channel disabled'
    || String(entry.meta?.message).includes('receipt.im 已停用')
    || String(entry.message).includes('receipt.im 已停用')), '必须记录 receipt.im 已停用');
});

/* ------------------------------------------ P1 分流（task_report 唯一） */

test('P1：task_report 只交主会话；reminder 等其它 kind 仍走 platform.prompt（非真机证据）', async () => {
  const agent = makeAgent();
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({}));
  initReceiptChannel(state);

  await deliverProactiveItem(state, { kind: 'task_report', text: '[任务] 状态：成功\n产物：/tmp/a.md', sessionId: 'session-main' });
  assert.equal(agent.calls.length, 1);
  assert.equal(platform.prompts.length, 0, 'task_report 不得进 platform.prompt');

  await deliverProactiveItem(state, { kind: 'reminder', text: '[提醒] 喝水', requestId: 'companion-reminder:1', sessionId: 'session-main' });
  assert.equal(platform.prompts.length, 1, '其它 kind 保持原通道');
  assert.equal(platform.prompts[0].requestId, 'companion-reminder:1');
  assert.equal(agent.calls.length, 1, '提醒不得走主会话 notice');
});

test('P1：主会话投递失败把错误抛给 proactive 退避重试（非真机证据）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const platform = makePlatform({ agentBySessionId: () => null });
  const config = normalizeConfig({});
  const state = { ...makeState(platform, config), store };
  initReceiptChannel(state);

  const proactive = createProactive({
    store,
    config,
    platform,
    target: () => 'session-main',
    clock: () => NOW,
    deliver: (item) => deliverProactiveItem(state, item),
    deliverKind: (kind) => kind === 'task_report',
  });
  proactive.enqueue({ kind: 'task_report', text: '[任务] 状态：成功', dedupeKey: 'rpt-1', at: NOW });
  const report = await proactive.flush(NOW + 1000);
  assert.equal(report.failed, 1);
  assert.equal(report.sent, 0);
  assert.equal(report.deferred, 1, '回执必须留在 backlog 等退避重试');
  assert.equal(platform.prompts.length, 0, '失败路径绝不退回 platform.prompt');
});

test('P1：noticeSummaryOf 去前缀 / 首行 / 60 字截断', () => {
  assert.equal(noticeSummaryOf('[任务] 状态：成功'), '状态：成功');
  assert.equal(noticeSummaryOf('[任务] 第一行\n第二行'), '第一行');
  const long = `[任务] ${'很长的结论'.repeat(30)}`;
  const summary = noticeSummaryOf(long);
  assert.equal(summary.length, 60);
  assert.ok(summary.endsWith('…'));
});

/* ------------------------------------------------------ P1 /状态 */

test('P1：/状态 的「回执通道」行（主会话 notice / 最近投递 / 不可用）', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const status = (receipt, extra = {}) => handleCommand({
    text: '/状态',
    store,
    now: NOW,
    timeZone: 'Asia/Shanghai',
    receipt,
    ...extra,
  }).reply;

  const withChannel = status(
    { available: true, channel: 'session', mode: 'session', lastDelivery: null },
    { bg: { available: false, reason: 'x', message: 'no systemd' } },
  );
  assert.match(withChannel, /回执通道：主会话（session-notice）/u);
  assert.match(withChannel, /后台任务：不可用/u);

  const imConfigured = status({ available: true, channel: 'session', imConfigured: true, lastDelivery: null });
  assert.match(imConfigured, /receipt\.im 已停用/u);

  const failed = status({ available: true, channel: 'session', lastDelivery: { ok: false, code: 'agent-unavailable' } });
  assert.match(failed, /最近投递：失败（agent-unavailable）/u);

  const delivered = status({ available: true, channel: 'session', lastDelivery: { ok: true } });
  assert.match(delivered, /最近投递：成功/u);

  const unavailable = status({ available: false, reason: 'agent-unavailable', message: '主会话 agent 不可用' });
  assert.match(unavailable, /回执通道：不可用（主会话 agent 不可用）/u);

  // 旧调用方不传 receipt：不出现该行。
  assert.equal(status(undefined).includes('回执通道'), false);
});

/* ---------------------------------------------------------- R22-M1 记录 */

test('R22-M1：新记录 status=投递结果 + task_status=任务终态；旧记录兼容读', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const platform = makePlatform();
  const state = { store, platform };

  recordTaskReceiptDelivery(state, { receiptId: 'task-1', taskId: 'task-1', status: 'done', delivered: true, atSeconds: 100 });
  recordTaskReceiptDelivery(state, { receiptId: 'task-2', taskId: 'task-2', status: 'failed', delivered: false, atSeconds: 101 });

  const events = store.listEvents({ limit: 10 }).filter((row) => {
    const detail = JSON.parse(row.detail_json);
    return detail?.kind === 'task_receipt_delivery';
  });
  assert.equal(events.length, 2);
  const first = JSON.parse(events.find((row) => row.row_id === 'task-1').detail_json);
  assert.equal(first.status, 'delivered', 'status 必须是投递结果');
  assert.equal(first.task_status, 'done', '任务终态必须另记');
  assert.equal(first.channel, 'session', 'v0.7.15 起记录通道为 session');
  const second = JSON.parse(events.find((row) => row.row_id === 'task-2').detail_json);
  assert.equal(second.status, 'failed');
  assert.equal(second.task_status, 'failed');

  assert.deepEqual(readReceiptDeliveryRecord(first), { delivery: 'delivered', taskStatus: 'done', delivered: true });
  assert.deepEqual(readReceiptDeliveryRecord(second), { delivery: 'failed', taskStatus: 'failed', delivered: false });
  // 旧记录（≤v0.7.12）：status 是任务终态，投递结果只有 delivered 布尔。
  assert.deepEqual(
    readReceiptDeliveryRecord({ kind: 'task_receipt_delivery', status: 'done', delivered: true }),
    { delivery: 'delivered', taskStatus: 'done', delivered: true },
  );
  assert.deepEqual(
    readReceiptDeliveryRecord({ kind: 'task_receipt_delivery', status: 'timeout', delivered: false }),
    { delivery: 'failed', taskStatus: 'timeout', delivered: false },
  );
  assert.deepEqual(readReceiptDeliveryRecord(null), { delivery: 'failed', taskStatus: null, delivered: false });
});

/* ---------------------------------------------- R22-H2 成功任务归类 */

function makeSubagentPlatform(result) {
  const started = [];
  return {
    capabilities: { subagents: true },
    calls: { started },
    async startSubagent(spec) {
      started.push(spec);
      return {
        childId: 'child-1',
        result: Promise.resolve(result),
        dispose: async () => {},
      };
    },
  };
}

test('R22-H2：stopReason=completed 且无 structured → ok（不再被 outputSchema 改写成失败）', async () => {
  const platform = makeSubagentPlatform({
    output: [{ type: 'text', text: '周报已完成，产物 /tmp/report.md' }],
    stopReason: 'completed',
  });
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-1', prompt: '写周报' },
    parent: {},
    now: () => NOW,
  });
  assert.equal(platform.calls.started[0].outputSchema, undefined, '不得再声明 outputSchema');
  assert.equal(result.status, 'ok');
  assert.match(result.receipt, /状态：成功/u);
  assert.match(result.receipt, /周报已完成/u);
  assert.equal(result.structured, null, '没有 structured 时显式降级为 null');
});

test('R22-H2：stopReason=error 带正文、无 diagnostic → error 且正文可见', async () => {
  const platform = makeSubagentPlatform({
    output: [{ type: 'text', text: '脚本第 3 行报错' }],
    stopReason: 'error',
  });
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-2', prompt: '跑脚本' },
    parent: {},
    now: () => NOW,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.error, '脚本第 3 行报错');
  assert.match(result.receipt, /状态：失败/u);
});

/* ------------------------------------- P1 生产接线（原 glm M1 判别用例） */

/**
 * **非真机证据**：这是「生产接线层」判别用例 —— 钉住 startScheduler 恒把
 * deliver/deliverKind 注入 createProactive，且 task_report 只投主会话。
 * 若删掉 src/index.js 里的 deliver 注入，task_report 会悄悄退回 platform.prompt，
 * 本用例必须变红。
 */
test('P1 接线：startScheduler 注入 deliver，task_report 只投主会话、不进 platform.prompt', async () => {
  // 10:05 不在安静时段（否则 proactive.flush 会被 quiet 挡住），且已超出 catch-up 窗。
  const at = Date.parse('2026-11-22T10:05:00+08:00');
  const everyCalls = [];
  const prompts = [];
  const agent = makeAgent();
  const imCalls = [];
  const platform = {
    capabilities: { timer: true },
    now: () => at,
    every: (delay, callback) => {
      everyCalls.push({ delay, callback });
      return () => {};
    },
    log: () => {},
    async prompt(request) {
      prompts.push(request);
    },
    agentBySessionId: () => agent,
  };
  const store = Store.open(':memory:');
  try {
    const state = {
      platform,
      store,
      config: normalizeConfig({ receipt: { im: { botId: 'bot-wire', targetId: 'tg-wire' } } }),
      metrics: { snapshot: () => ({}) },
      mainSessionId: 'session-main',
      pendingCompact: new Map(),
      // 旧通道的替身：必须确认它一次都没被调用（v0.7.15 起回执不直发用户）。
      host: { get: () => ({ contractVersion: 1, async send(...args) { imCalls.push(args); return { sent: true }; } }) },
    };

    const stop = startScheduler(state);
    initReceiptChannel(state); // 生产里由 apply 调用；此处直接测接线。
    assert.equal(typeof stop, 'function', 'startScheduler 应返回 stop 句柄');
    assert.ok(state.proactive !== null && state.proactive !== undefined, 'scheduler 必须创建 proactive');
    assert.ok(everyCalls.length >= 1, 'scheduler 必须向 platform.every 注册定时器');

    assert.equal(state.im.channel, 'session');

    const receipt = await deliverTaskReceipt(state, { taskId: 'task-wire-1', receipt: '结论：已跑完' });
    assert.equal(receipt.queued, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.proactive.flush();

    assert.equal(agent.calls.length, 1, 'task_report 必须恰好投一次主会话 notice');
    assert.equal(agent.calls[0].target, 'next-turn');
    assert.equal(agent.calls[0].wakeup, true);
    assert.match(agent.calls[0].message.content[0].text, /结论：已跑完/u);
    assert.equal(imCalls.length, 0, 'dsh-im 通道必须 0 次');

    const viaPrompt = prompts.filter((request) => JSON.stringify(request).includes('结论：已跑完'));
    assert.deepEqual(viaPrompt, [], 'task_report 绝不能退回 platform.prompt');
    assert.ok(
      store.listEvents({ table_name: 'proactive', limit: 10 })
        .some((row) => row.reason === 'proactive:task_report'),
      'proactive_sent 只在投递成功后才写',
    );
    stop();
  } finally {
    store.close();
  }
});
