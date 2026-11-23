/**
 * v0.7.14（V713-M1 / V713-L1 / V713-L2）——**V713-M1 已被 v0.7.15（P1）取代**：
 * 回执不再经 dsh-im 直发用户，而是只投主会话 notice。本文件按新语义改写
 * （旧「换实例 / 服务消失」断言改写而非删除）。
 *
 * 覆盖：
 *   - dsh-im 即使存在、即使换实例，也不被调用（回执只走主会话）；
 *   - 主会话通道失败 → proactive 退避，连续失败只记 1 条（L2）；
 *   - L1 无主会话时只有「需要会话」的候选回队（语义不变，仍保留）；
 *   - L2 同一回执的投递日志只在状态变化时写一条。
 *
 * **非真机证据**：本机（Windows）没有 dsh-im 插件、没有真实宿主；dsh-im 服务、
 * 宿主 `agent.send`、`platform.prompt` 全部用替身模拟，真实行为属 50041 云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { createProactive } from '../src/runtime/proactive.js';
import {
  deliverProactiveItem,
  deliverTaskReceipt,
  initReceiptChannel,
  recordTaskReceiptDelivery,
  startScheduler,
} from '../src/index.js';

const NOW = Date.parse('2026-11-23T10:00:00+08:00');

function makeService() {
  const calls = [];
  return {
    contractVersion: 1,
    calls,
    async send(botId, targetId, text, options) {
      calls.push({ botId, targetId, text, options });
      return { sent: true };
    },
  };
}

function makeAgent({ status = 'idle' } = {}) {
  const calls = [];
  return {
    status,
    calls,
    send(message, target, wakeup) {
      calls.push({ message, target, wakeup });
    },
  };
}

function makePlatform(extra = {}) {
  const prompts = [];
  const logs = [];
  return {
    prompts,
    logs,
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

function deliveryEvents(store) {
  return store.listEvents({ limit: 20 }).filter((row) => {
    try {
      return JSON.parse(row.detail_json)?.kind === 'task_receipt_delivery';
    } catch {
      return false;
    }
  });
}

/* ------------------- P1 取代 V713-M1：dsh-im 服务存在/换实例都不再被用 */

test('P1 取代 V713-M1：dsh-im 存在且换实例也不被调用，回执仍走主会话（非真机证据）', async () => {
  const agent = makeAgent();
  const platform = makePlatform({ agentBySessionId: () => agent });
  const state = makeState(platform, normalizeConfig({ receipt: { im: { botId: 'bot-1', targetId: 'tg-1' } } }));
  const first = makeService();
  const second = makeService();
  let current = first;
  // 旧实现会在每次投递前现取 dshIm；新实现完全不读 host。
  state.host = { get: (name) => (name === 'dshIm' ? current : undefined) };

  initReceiptChannel(state);
  assert.equal(state.im.channel, 'session');
  await deliverProactiveItem(state, { kind: 'task_report', text: '[任务] 状态：成功', sessionId: 'session-main' });
  assert.equal(agent.calls.length, 1);

  // 模拟 dsh-im 重载：换实例、随后消失，都不应影响主会话投递。
  current = second;
  await deliverProactiveItem(state, { kind: 'task_report', text: '[任务] 状态：成功（二）', sessionId: 'session-main' });
  current = undefined;
  await deliverProactiveItem(state, { kind: 'task_report', text: '[任务] 状态：成功（三）', sessionId: 'session-main' });

  assert.equal(first.calls.length, 0, '旧实例不得被调用');
  assert.equal(second.calls.length, 0, '新实例也不得被调用');
  assert.equal(agent.calls.length, 3, '三次回执都应投到主会话');
  assert.equal(platform.prompts.length, 0, '不得退回 platform.prompt');
});

test('P1 取代 V713-M1 接线：startScheduler 之后 dsh-im 换实例仍被忽略（非真机证据）', async () => {
  // 10:05 不在安静时段（否则 proactive.flush 会被 quiet 挡住），且已超出 catch-up 窗。
  const at = Date.parse('2026-11-23T10:05:00+08:00');
  const everyCalls = [];
  const prompts = [];
  const agent = makeAgent();
  const serviceA = makeService();
  const serviceB = makeService();
  let current = serviceA;
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
      host: { get: (name) => (name === 'dshIm' ? current : undefined) },
    };
    const stop = startScheduler(state);
    initReceiptChannel(state); // 生产里由 apply 调用；此处直接测接线。
    assert.equal(typeof stop, 'function');
    assert.ok(everyCalls.length >= 1);
    assert.equal(state.im.channel, 'session');

    deliverTaskReceipt(state, { taskId: 'task-wire-1', receipt: '结论：第一件已跑完' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.proactive.flush();

    current = serviceB; // dsh-im 重载
    deliverTaskReceipt(state, { taskId: 'task-wire-2', receipt: '结论：第二件已跑完' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.proactive.flush();

    assert.equal(agent.calls.length, 2, '两条回执都应投主会话');
    assert.equal(serviceA.calls.length, 0, 'A 不得被调用');
    assert.equal(serviceB.calls.length, 0, 'B 不得被调用');
    assert.equal(prompts.length, 0, '回执不得退回 platform.prompt');
  } finally {
    store.close();
  }
});

test('P1：主会话不可用时回执留在队列退避，连续失败只记 1 条，恢复后补投（非真机证据）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const platform = makePlatform();
  const config = normalizeConfig({});
  const state = {
    ...makeState(platform, config),
    store,
  };
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
  state.proactive = proactive;

  deliverTaskReceipt(state, { taskId: 'task-l2', receipt: '结论：已跑完', status: 'done' });
  for (let round = 0; round < 3; round += 1) {
    await proactive.flush(NOW + 1000 * (round + 1));
  }
  let events = deliveryEvents(store);
  assert.equal(events.length, 1, '同一回执连续失败必须只写 1 条');
  assert.equal(JSON.parse(events[0].detail_json).status, 'failed');
  assert.equal(JSON.parse(events[0].detail_json).task_status, 'done');
  assert.equal(platform.prompts.length, 0, '失败路径绝不退回 platform.prompt');

  // 主会话恢复后在退避窗口外补投 → 只新增 1 条 delivered。
  const agent = makeAgent();
  platform.agentBySessionId = () => agent;
  await proactive.flush(NOW + 10_000);
  events = deliveryEvents(store);
  assert.equal(events.length, 2, '失败→成功必须新增 1 条');
  const statuses = events.map((row) => JSON.parse(row.detail_json).status).sort();
  assert.deepEqual(statuses, ['delivered', 'failed']);
  assert.equal(agent.calls.length, 1, '恢复后应补投主会话一次');
});

/* ------------------------------------------------------- V713-L1 会话分区 */

test('V713-L1：无主会话时 task_report 照常出站，只有需会话的提醒回队（非真机证据）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const delivered = [];
  const failed = [];
  const sent = [];
  const prompts = [];
  const proactive = createProactive({
    store,
    config: normalizeConfig({}),
    platform: {
      now: () => NOW,
      log: () => {},
      async prompt(request) {
        prompts.push(request);
      },
    },
    target: () => null, // 无主会话
    clock: () => NOW,
    deliver: async (item) => {
      delivered.push(item.kind);
    },
    deliverKind: (kind) => kind === 'task_report',
  });

  proactive.enqueue({
    kind: 'reminder',
    text: '提醒：交周报',
    dedupeKey: 'rem-1',
    at: NOW,
    onSent: () => sent.push('reminder'),
    onFailed: () => failed.push('reminder'),
  });
  proactive.enqueue({
    kind: 'task_report',
    text: '[任务] 状态：成功',
    dedupeKey: 'rpt-1',
    at: NOW,
    onSent: () => sent.push('task_report'),
    onFailed: () => failed.push('task_report'),
  });

  const report = await proactive.flush(NOW + 1000);

  assert.deepEqual(delivered, ['task_report'], '回执必须走主会话通道投出去');
  assert.equal(report.sent, 1);
  assert.equal(report.deferred, 1, '提醒回队等主会话');
  assert.deepEqual(failed, ['reminder'], 'onFailed 只对需要会话的份调用');
  assert.deepEqual(sent, ['task_report']);
  assert.equal(prompts.length, 0, 'reminder 不应被无会话投递');
});

test('V713-L1：纯回执批（无主会话）全部出站，不因缺会话被挡（非真机证据）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const delivered = [];
  const progressive = createProactive({
    store,
    config: normalizeConfig({}),
    platform: { now: () => NOW, log: () => {}, prompt: async () => { throw new Error('不应走 prompt'); } },
    target: () => null,
    clock: () => NOW,
    deliver: async (item) => { delivered.push(item.text); },
    deliverKind: (kind) => kind === 'task_report',
  });
  // 间隔 11 分钟，避开 10 分钟合并窗口：两条都必须各自出站。
  progressive.enqueue({ kind: 'task_report', text: '[任务] 甲', dedupeKey: 'rpt-a', at: NOW });
  progressive.enqueue({ kind: 'task_report', text: '[任务] 乙', dedupeKey: 'rpt-b', at: NOW + 11 * 60_000 });

  const report = await progressive.flush(NOW + 12 * 60_000);
  assert.deepEqual(delivered, ['[任务] 甲', '[任务] 乙']);
  assert.equal(report.sent, 2);
  assert.equal(report.deferred, 0);
  assert.equal(report.failed, 0);
});

/* ------------------------------------------------------- V713-L2 日志去重 */

test('V713-L2：同一回执连续失败只记一条，状态变化才新增（非真机证据）', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const platform = makePlatform();
  const state = { store, platform };
  const base = { receiptId: 'task-9', taskId: 'task-9', status: 'done', title: '纪要' };

  recordTaskReceiptDelivery(state, { ...base, delivered: false, atSeconds: 200 });
  recordTaskReceiptDelivery(state, { ...base, delivered: false, atSeconds: 201 });
  recordTaskReceiptDelivery(state, { ...base, delivered: false, atSeconds: 202 });
  let events = deliveryEvents(store);
  assert.equal(events.length, 1, '失败→失败不得重复写');
  assert.equal(JSON.parse(events[0].detail_json).status, 'failed');

  recordTaskReceiptDelivery(state, { ...base, delivered: true, atSeconds: 203 });
  events = deliveryEvents(store);
  assert.equal(events.length, 2, '失败→成功必须写 delivered');
  assert.equal(JSON.parse(events.find((row) => JSON.parse(row.detail_json).status === 'delivered').detail_json).status, 'delivered');

  recordTaskReceiptDelivery(state, { ...base, delivered: true, atSeconds: 204 });
  assert.equal(deliveryEvents(store).length, 2, '成功→成功不得重复写');

  recordTaskReceiptDelivery(state, { ...base, delivered: false, atSeconds: 205 });
  events = deliveryEvents(store);
  assert.equal(events.length, 3, '成功→失败必须写 failed');
  assert.equal(JSON.parse(events[0].detail_json).status, 'failed');
  // 任务终态字段仍按 R22-M1 写入。
  assert.equal(JSON.parse(events[0].detail_json).task_status, 'done');
});
