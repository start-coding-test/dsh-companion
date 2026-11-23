/**
 * v0.7.14（V713-M1 / V713-L1 / V713-L2）：
 *   M1 dsh-im 重载换实例后回执仍走新实例；
 *   L1 无主会话时只有「需要会话」的候选回队，回执照常走 dsh-im；
 *   L2 同一回执的投递日志只在状态变化时写一条。
 *
 * **非真机证据**：本机（Windows）没有 dsh-im 插件、没有真实宿主，`ctx.dshIm` 的
 * 重载/热更新语义、宿主 `agent.send`、`platform.prompt` 全部用替身模拟；真实行为
 * 属 50041 云端验收。
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
  sendReceiptViaIm,
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

function makePlatform(extra = {}) {
  const prompts = [];
  return {
    prompts,
    now: () => NOW,
    log: () => {},
    async prompt(request) {
      prompts.push(request);
    },
    ...extra,
  };
}

function makeState(platform, config) {
  return {
    platform,
    config,
    store: { getMeta: () => null },
    mainSessionId: 'session-main',
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

/* --------------------------------------------------------- V713-M1 重载 */

test('V713-M1：dsh-im 换实例后投递现取新实例，旧实例不再被调用（非真机证据）', async () => {
  const platform = makePlatform();
  const config = normalizeConfig({ receipt: { im: { botId: 'bot-1', targetId: 'tg-1' } } });
  const state = makeState(platform, config);
  const first = makeService();
  const second = makeService(); // 必须是不同对象、独立 calls 数组，同引用即假绿
  let current = first;
  const host = { get: (name) => (name === 'dshIm' ? current : undefined) };

  initReceiptChannel(state, host);
  assert.equal(state.im.available, true);
  assert.equal(state.im.service, first, '启动时先接管 A');
  await sendReceiptViaIm(state, 'first');
  assert.equal(first.calls.length, 1);

  // 模拟 dsh-im 重载：服务换成一个新实例。
  current = second;
  await sendReceiptViaIm(state, 'second');
  assert.equal(second.calls.length, 1, '必须用现取到的新实例投递');
  assert.equal(first.calls.length, 1, '旧实例必须冻结在 1 次');
  assert.equal(state.im.service, second);
  assert.equal(state.im.lastDelivery.ok, true);
  assert.equal(platform.prompts.length, 0, '不得退回 platform.prompt');

  // 再模拟重载间隙：新实例也不在注册表里。
  current = undefined;
  await assert.rejects(
    () => sendReceiptViaIm(state, 'third'),
    (error) => error.code === 'im-missing',
  );
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assert.equal(state.im.available, false);
  assert.equal(state.im.reason, 'im-missing');
  assert.equal(platform.prompts.length, 0, '不可用时绝不退回 platform.prompt');
});

/**
 * **非真机证据**：生产接线层孪生用例——startScheduler 注入 deliver 后，dsh-im 重载
 * 换实例，第二次回执必须走新实例。缓存旧实例的实现会让第二次仍打 A，本用例必红。
 */
test('V713-M1 接线：startScheduler 之后 dsh-im 换实例，第二条回执走新实例（非真机证据）', async () => {
  // 10:05 不在安静时段（否则 proactive.flush 会被 quiet 挡住），且已超出 catch-up 窗。
  const at = Date.parse('2026-11-23T10:05:00+08:00');
  const everyCalls = [];
  const prompts = [];
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
    agentBySessionId: () => null,
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
    };
    const stop = startScheduler(state);
    assert.equal(typeof stop, 'function');
    assert.ok(everyCalls.length >= 1);

    initReceiptChannel(state, { get: (name) => (name === 'dshIm' ? current : undefined) });
    assert.equal(state.im.available, true);

    deliverTaskReceipt(state, { taskId: 'task-wire-1', receipt: '结论：第一件已跑完' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.proactive.flush();
    assert.equal(serviceA.calls.length, 1, '第一条走 A');

    current = serviceB; // dsh-im 重载
    deliverTaskReceipt(state, { taskId: 'task-wire-2', receipt: '结论：第二件已跑完' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await state.proactive.flush();

    assert.equal(serviceB.calls.length, 1, '第二条必须走现取到的 B');
    assert.equal(serviceA.calls.length, 1, 'A 不得再被调用');
    assert.equal(prompts.length, 0, '回执不得退回 platform.prompt');
  } finally {
    store.close();
  }
});

test('V713-M1：服务消失后回执不可用，proactive 只退避、绝不退回 prompt（非真机证据）', async (t) => {
  const platform = makePlatform();
  const config = normalizeConfig({ receipt: { im: { botId: 'bot-1', targetId: 'tg-1' } } });
  const state = makeState(platform, config);
  let current = makeService();
  const host = { get: (name) => (name === 'dshIm' ? current : undefined) };

  initReceiptChannel(state, host);
  assert.equal(state.im.available, true);

  // 服务被卸载/重载间隙取不到。
  current = undefined;
  await assert.rejects(
    () => sendReceiptViaIm(state, '[任务] x'),
    (error) => error.code === 'im-missing',
  );
  assert.equal(state.im.available, false, '/状态 应显示不可用');
  assert.equal(state.im.reason, 'im-missing');
  assert.equal(statusOf(platform), 0, '不得退回 platform.prompt');

  // 走真实接线：proactive 失败后把回执留在队列，不调用 platform.prompt。
  const store = Store.open(':memory:');
  t.after(() => store.close());
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

  assert.deepEqual(delivered, ['task_report'], '回执必须走 dsh-im 通道投出去');
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

/**
 * **非真机证据**：走真实接线（deliverTaskReceipt 的 onFailed 钩子 + proactive 退避）
 * 验证「不可用通道下 flush ×3 只写 1 条失败日志」，以及转可用后新增 1 条 delivered。
 */
test('V713-L2 接线：不可用通道 flush ×3 只写 1 条 failed，转可用后 +1 条 delivered（非真机证据）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const platform = makePlatform();
  const config = normalizeConfig({ receipt: { im: { botId: 'bot-l2', targetId: 'tg-l2' }, sessionNotice: false } });
  const state = {
    ...makeState(platform, config),
    store,
  };
  let current;
  const host = { get: (name) => (name === 'dshIm' ? current : undefined) };
  initReceiptChannel(state, host); // 通道不可用（im-missing）

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

  // dsh-im 重载/恢复后投成 → 只新增 1 条 delivered。
  current = makeService();
  await proactive.flush(NOW + 10_000);
  events = deliveryEvents(store);
  assert.equal(events.length, 2, '失败→成功必须新增 1 条');
  const statuses = events.map((row) => JSON.parse(row.detail_json).status).sort();
  assert.deepEqual(statuses, ['delivered', 'failed']);
  assert.equal(platform.prompts.length, 0, '任何阶段都不得退回 platform.prompt');
});

function statusOf(platform) {
  return platform.prompts.length;
}
