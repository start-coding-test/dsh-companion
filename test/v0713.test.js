/**
 * v0.7.13（R22-H1 / R22-H2 / R22-M1）：回执出站通道、会话 notice、投递记录与成功态归类。
 *
 * **非真机证据**：dsh-im 服务、宿主 `agent.send` 与子代理 activation 全部是替身。
 * 本机（Windows）没有 dsh-im 插件、没有 user systemd、也没有真实宿主子代理；
 * `ctx.dshIm.send` 的真实送达语义、宿主 notice 的实际排队行为属 50041 云端验收。
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
  deliverSessionNotice,
  initReceiptChannel,
  noticeSummaryOf,
  readReceiptDeliveryRecord,
  recordTaskReceiptDelivery,
  sendReceiptViaIm,
} from '../src/index.js';

const NOW = Date.parse('2026-11-22T10:00:00+08:00');

function makeService(overrides = {}) {
  const calls = [];
  const service = {
    contractVersion: 1,
    calls,
    async send(botId, targetId, text, options) {
      calls.push({ botId, targetId, text, options });
      return { sent: true };
    },
    ...overrides,
  };
  return service;
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

/* ------------------------------------------------------------ R22-H1 配置 */

test('R22-H1：receipt 配置默认值、trim 与 sessionNotice 开关（非真机证据）', () => {
  const base = normalizeConfig({});
  assert.deepEqual(base.receipt.im, { botId: '', targetId: '' }, '默认不猜 bot/target');
  assert.equal(base.receipt.sessionNotice, true, 'notice 默认开启');

  const trimmed = normalizeConfig({ receipt: { im: { botId: ' bot-1 ', targetId: ' tg-1 ' } } });
  assert.deepEqual(trimmed.receipt.im, { botId: 'bot-1', targetId: 'tg-1' });

  const off = normalizeConfig({ receipt: { sessionNotice: false } });
  assert.equal(off.receipt.sessionNotice, false, '显式 false 必须保留');

  // 57 键安装面不变：receipt 是节级扩展（非枚举），不参与 16 键自检。
  assert.equal(Object.keys(base).includes('receipt'), true);
});

/* ------------------------------------------------------- R22-H1 出站通道 */

test('R22-H1：dshIm 可用时 sendReceiptViaIm 走 ctx.dshIm.send（format=plain + AbortSignal）', () => {
  const service = makeService();
  const platform = makePlatform();
  const config = normalizeConfig({ receipt: { im: { botId: 'bot-1', targetId: 'tg-1' } } });
  const state = makeState(platform, config);

  initReceiptChannel(state, { get: (name) => (name === 'dshIm' ? service : undefined) });
  assert.equal(state.im.available, true);
  assert.equal(state.im.contractVersion, 1);
  assert.equal(state.im.botId, 'bot-1');
  assert.equal(state.im.targetId, 'tg-1');
  assert.ok(platform.logs.some((entry) => entry.message === '[dsh-companion] receipt channel'));

  return sendReceiptViaIm(state, '[任务] 状态：成功').then(() => {
    assert.equal(service.calls.length, 1);
    const call = service.calls[0];
    assert.equal(call.botId, 'bot-1');
    assert.equal(call.targetId, 'tg-1');
    assert.equal(call.text, '[任务] 状态：成功');
    assert.equal(call.options.format, 'plain');
    assert.ok(call.options.signal instanceof AbortSignal, '必须带真 AbortSignal');
    assert.equal(state.im.lastDelivery.ok, true);
    assert.equal(platform.prompts.length, 0, '不得退回 platform.prompt');
  });
});

test('R22-H1：dsh-im 缺失 / contractVersion 不符 / 未配置 → 不可用且不退回 prompt', async () => {
  const cases = [
    { name: 'missing', service: undefined, config: { im: { botId: 'b', targetId: 't' } }, reason: 'im-missing' },
    { name: 'contract', service: makeService({ contractVersion: 2 }), config: { im: { botId: 'b', targetId: 't' } }, reason: 'im-contract-version' },
    { name: 'not-configured', service: makeService(), config: { im: { botId: '', targetId: '' } }, reason: 'im-not-configured' },
  ];
  for (const item of cases) {
    const platform = makePlatform();
    const config = normalizeConfig({ receipt: item.config });
    const state = makeState(platform, config);
    initReceiptChannel(state, { get: (name) => (name === 'dshIm' ? item.service : undefined) });
    assert.equal(state.im.available, false, `${item.name} 应不可用`);
    assert.equal(state.im.reason, item.reason);
    await assert.rejects(() => sendReceiptViaIm(state, '[任务] x'), (error) => error.code === item.reason);
    assert.equal(platform.prompts.length, 0, `${item.name} 不得退回 platform.prompt`);
    assert.equal(state.im.lastDelivery.ok, false, '失败必须记录 lastDelivery');
  }
});

test('R22-H1：send 拒绝 / 未确认 {sent:true} → 抛错并记 lastDelivery（不吞）', async () => {
  const platform = makePlatform();
  const config = normalizeConfig({ receipt: { im: { botId: 'b', targetId: 't' } } });
  const rejecting = makeService({
    async send() {
      const error = new Error('target not found');
      error.code = 'target-not-found';
      throw error;
    },
  });
  const state = makeState(platform, config);
  initReceiptChannel(state, { get: () => rejecting });
  await assert.rejects(() => sendReceiptViaIm(state, '[任务] x'), (error) => error.code === 'target-not-found');
  assert.deepEqual(
    { ok: state.im.lastDelivery.ok, code: state.im.lastDelivery.code },
    { ok: false, code: 'target-not-found' },
  );

  const unconfirmed = makeService({ async send() { return { sent: false }; } });
  const state2 = makeState(platform, config);
  initReceiptChannel(state2, { get: () => unconfirmed });
  await assert.rejects(() => sendReceiptViaIm(state2, '[任务] x'), (error) => error.code === 'delivery-unconfirmed');
  assert.equal(state2.im.lastDelivery.code, 'delivery-unconfirmed');
});

/* ---------------------------------------------- R22-H1 分流与 notice */

test('R22-H1：task_report 走 dsh-im 且只发 notice；其它 kind 仍走 platform.prompt', async () => {
  const service = makeService();
  const sent = [];
  const platform = makePlatform({
    agentBySessionId: () => ({ send: (message, target, wakeup) => sent.push({ message, target, wakeup }) }),
  });
  const config = normalizeConfig({ receipt: { im: { botId: 'b', targetId: 't' }, sessionNotice: true } });
  const state = makeState(platform, config);
  initReceiptChannel(state, { get: () => service });

  await deliverProactiveItem(state, { kind: 'task_report', text: '[任务] 状态：成功\n产物：/tmp/a.md', sessionId: 'session-main' });
  assert.equal(service.calls.length, 1);
  assert.equal(platform.prompts.length, 0, 'task_report 不得进 platform.prompt');
  assert.equal(sent.length, 1, '出站成功后必须放一条 notice');
  assert.equal(sent[0].target, 'next-turn');
  assert.equal(sent[0].wakeup, false, 'notice 不得唤醒');
  assert.equal(sent[0].message.role, 'user');
  assert.equal(sent[0].message.source.kind, 'companion-task-receipt');
  assert.equal(sent[0].message.source.form, 'notice');
  assert.ok(sent[0].message.source.summary.length <= 60);
  assert.equal(sent[0].message.source.summary, '状态：成功', 'summary 去掉 [任务] 前缀并取首行');

  await deliverProactiveItem(state, { kind: 'reminder', text: '[提醒] 喝水', requestId: 'companion-reminder:1', sessionId: 'session-main' });
  assert.equal(platform.prompts.length, 1, '其它 kind 保持原通道');
  assert.equal(platform.prompts[0].requestId, 'companion-reminder:1');
  assert.equal(service.calls.length, 1, '提醒不得走 dsh-im');
});

test('R22-H1：dsh-im 失败时抛给 proactive 退避重试；notice 开关关闭则不发 notice', async () => {
  const platform = makePlatform({
    agentBySessionId: () => ({ send: () => { throw new Error('should not send'); } }),
  });
  const config = normalizeConfig({ receipt: { im: { botId: 'b', targetId: 't' }, sessionNotice: false } });
  const failing = makeService({ async send() { const e = new Error('busy'); e.code = 'delivery-failed'; throw e; } });
  const state = makeState(platform, config);
  initReceiptChannel(state, { get: () => failing });
  await assert.rejects(() => deliverProactiveItem(state, { kind: 'task_report', text: '[任务] x', sessionId: 'session-main' }));
  assert.equal(platform.prompts.length, 0);

  // sessionNotice=false：即使出站成功也不放 notice。
  const okService = makeService();
  const state2 = makeState(platform, config);
  initReceiptChannel(state2, { get: () => okService });
  await deliverProactiveItem(state2, { kind: 'task_report', text: '[任务] 状态：成功', sessionId: 'session-main' });
  assert.equal(okService.calls.length, 1);
});

test('R22-H1：notice 取不到主会话 agent 时只 warn，不抛', () => {
  const platform = makePlatform({ agentBySessionId: () => null });
  const config = normalizeConfig({ receipt: { sessionNotice: true } });
  const state = makeState(platform, config);
  deliverSessionNotice(state, '[任务] 状态：成功');
  assert.ok(platform.logs.some((entry) => entry.level === 'warn' && entry.message.includes('notice skipped')));
});

test('R22-H1：noticeSummaryOf 去前缀 / 首行 / 60 字截断', () => {
  assert.equal(noticeSummaryOf('[任务] 状态：成功'), '状态：成功');
  assert.equal(noticeSummaryOf('[任务] 第一行\n第二行'), '第一行');
  const long = `[任务] ${'很长的结论'.repeat(30)}`;
  const summary = noticeSummaryOf(long);
  assert.equal(summary.length, 60);
  assert.ok(summary.endsWith('…'));
});

/* ---------------------------------- R22-H1：outbox 接线（按 kind 分通道） */

test('R22-H1：createProactive 的 deliver 分流让 task_report 不进 platform.prompt', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const delivered = [];
  const config = normalizeConfig({ proactiveDailyCap: 5 });
  const proactive = createProactive({
    store,
    config,
    target: () => 'main',
    clock: () => NOW,
    platform: {
      async prompt() {
        throw new Error('task_report 不应走 platform.prompt');
      },
    },
    deliver: async (item) => { delivered.push(item); },
    deliverKind: (kind) => kind === 'task_report',
  });

  proactive.enqueue({ kind: 'task_report', text: '任务完成', dedupeKey: 'k-1', at: NOW });
  const flushed = await proactive.flush(NOW + 1000);
  assert.equal(flushed.sent, 1);
  assert.equal(delivered.length, 1, '必须交给 deliver 通道');
  assert.equal(delivered[0].kind, 'task_report');
});

/* ------------------------------------------------------ R22-H1 /状态 */

test('R22-H1：/状态 的「回执通道」行（可用 / 不可用 / 最近投递）', (t) => {
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

  const withAvailable = status(
    { available: true, botId: 'bot-1', targetId: 'tg-1', lastDelivery: null },
    { bg: { available: false, reason: 'x', message: 'no systemd' } },
  );
  assert.match(withAvailable, /回执通道：dsh-im 可用（bot bot-1 → tg-1）/u);
  assert.match(withAvailable, /后台任务：不可用/u);

  const failed = status({ available: true, botId: 'b', targetId: 't', lastDelivery: { ok: false, code: 'target-not-found' } });
  assert.match(failed, /最近投递：失败（target-not-found）/u);

  const delivered = status({ available: true, botId: 'b', targetId: 't', lastDelivery: { ok: true } });
  assert.match(delivered, /最近投递：成功/u);

  const unavailable = status({ available: false, reason: 'im-missing', message: 'dsh-im 未安装或未注册 dshIm 服务' });
  assert.match(unavailable, /回执通道：不可用（dsh-im 未安装或未注册 dshIm 服务）/u);

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
