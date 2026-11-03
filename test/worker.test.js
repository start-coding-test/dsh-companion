/**
 * 轻任务 worker 与回执测试（T8）：成功路径、软超时只记录、硬超时两段式取消、
 * 取消抛错不影响终态、取消幂等、回执四要素与 ≤300 字、回执落库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { createAdapter } from '../src/platform/adapter.js';
import { Store } from '../src/memory/store.js';
import {
  cancelTask,
  DEFAULT_HARD_MS,
  DEFAULT_SOFT_MS,
  runTask,
} from '../src/task/worker.js';
import { formatReceipt, RECEIPT_MAX_CHARS, writeReceipt } from '../src/task/receipt.js';

/** 记录回执写入的最小 Store 替身。 */
function makeReceiptStore() {
  return {
    events: [],
    appendEvent(input) {
      this.events.push(input);
      return this.events.length;
    },
  };
}

/**
 * 用 returns 注入一个可控的 agent（whenIdle 由用例决定何时结束）。
 * @param {FakeCtx} ctx
 * @param {{id: string, whenIdle: Function}} agent
 */
function stubCreatedSession(ctx, agent) {
  ctx.returns['sessionController.createSession'] = { agent, agentPreset: null };
}

/** 在 FakeCtx.calls 中按顺序取某方法第一次出现的位置。 */
function indexOfCall(ctx, method) {
  return ctx.calls.findIndex((call) => call.method === method);
}

test('超时常量：软 600s、硬 900s（10 / 15 分钟）', () => {
  assert.equal(DEFAULT_SOFT_MS, 600_000);
  assert.equal(DEFAULT_HARD_MS, 900_000);
});

test('runTask 成功路径：createSession → prompt → whenIdle，并写完回执', async () => {
  const ctx = new FakeCtx();
  const platform = createAdapter(ctx);
  const store = makeReceiptStore();

  const result = await runTask({
    platform,
    task: {
      id: 'task-1',
      scope: 'main',
      prompt: '写一份周报',
      summary: '周报已生成',
      artifacts: ['out/weekly.md'],
    },
    store,
    now: () => ctx.now(),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.sessionId, 'session-fake-1');
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs >= 0);

  // 调用顺序：createSession → prompt → whenIdle
  const created = indexOfCall(ctx, 'sessionController.createSession');
  const prompted = indexOfCall(ctx, 'sessionController.prompt');
  const idled = indexOfCall(ctx, 'agent.whenIdle');
  assert.ok(created >= 0 && prompted >= 0 && idled >= 0, '缺少阶段调用');
  assert.ok(created < prompted && prompted < idled, '调用顺序不对');

  // prompt 请求形状（T2 适配器）：sessionId + text 内容块
  const [promptRequest, promptSource] = ctx.callsOf('sessionController.prompt')[0].args;
  assert.equal(promptRequest.sessionId, 'session-fake-1');
  assert.deepEqual(promptRequest.content, [{ type: 'text', text: '写一份周报' }]);
  assert.equal(promptSource.kind, 'user');

  // 回执已写完：一条 memory_events 审计行
  assert.equal(store.events.length, 1);
  const event = store.events[0];
  assert.equal(event.action, 'USED');
  assert.equal(event.actor, 'scheduler');
  assert.equal(event.table_name, 'threads');
  assert.equal(event.row_id, 'task-1');
  assert.equal(event.reason, 'task_receipt:ok');
  assert.equal(event.detail_json.scope, 'main');
  assert.equal(event.detail_json.kind, 'task_receipt');
  assert.equal(event.detail_json.taskId, 'task-1');
  assert.equal(event.detail_json.status, 'ok');
  const text = event.detail_json.text;
  for (const label of ['状态', '结论', '产物', '耗时']) {
    assert.ok(text.includes(label), `回执缺少「${label}」: ${text}`);
  }
  assert.ok(text.includes('out/weekly.md'), '回执应包含产物');
  assert.ok(text.includes('周报已生成'), '回执应包含结论');
  assert.ok(Array.from(text).length <= RECEIPT_MAX_CHARS, '回执超过 300 字');
});

test('runTask 失败路径：prompt 抛错 → status=error，仍写回执并回收会话', async () => {
  const ctx = new FakeCtx({
    fail: { 'sessionController.prompt': new Error('prompt exploded') },
  });
  const platform = createAdapter(ctx);
  const store = makeReceiptStore();

  const result = await runTask({
    platform,
    task: { id: 'task-2', scope: 'thread:rent', prompt: '继续找房' },
    store,
    now: () => ctx.now(),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.sessionId, 'session-fake-1');
  assert.match(result.error, /prompt exploded/);
  assert.ok(result.durationMs >= 0);

  // 失败也尽力回收会话（先 cancel，再（可选）cleanInbox）
  assert.equal(ctx.callsOf('sessionController.cancel').length, 1);
  assert.deepEqual(ctx.callsOf('sessionController.cancel')[0].args[0], {
    sessionId: 'session-fake-1',
    keepInbox: true,
  });

  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].detail_json.status, 'error');
  assert.match(store.events[0].detail_json.text, /状态：失败/);
});

test('软超时只记录不打断：软超时后 whenIdle 完成 → status=ok', async () => {
  const ctx = new FakeCtx();
  const agent = {
    id: 'session-soft',
    whenIdle: () => new Promise((resolve) => {
      setTimeout(() => resolve({ id: 'session-soft' }), 60);
    }),
  };
  stubCreatedSession(ctx, agent);
  const platform = createAdapter(ctx);
  const store = makeReceiptStore();

  const result = await runTask({
    platform,
    task: { id: 'task-soft', prompt: '慢慢跑' },
    store,
    softMs: 15,
    hardMs: 5_000,
    now: () => ctx.now(),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.sessionId, 'session-soft');
  // 软超时只写 warn 日志，不取消
  const softLogs = ctx.logs.filter(
    (entry) => entry.level === 'warn' && /soft timeout/i.test(entry.message),
  );
  assert.equal(softLogs.length, 1);
  assert.equal(softLogs[0].meta.sessionId, 'session-soft');
  assert.equal(ctx.callsOf('sessionController.cancel').length, 0);
  assert.equal(store.events[0].detail_json.status, 'ok');
});

test('硬超时：两段式取消（先 keepInbox 的 cancel，再 cleanInbox）并返回 timeout', async () => {
  const ctx = new FakeCtx();
  stubCreatedSession(ctx, {
    id: 'session-hard',
    whenIdle: () => new Promise(() => {}),
  });
  const adapter = createAdapter(ctx);
  const order = [];
  const platform = {
    ...adapter,
    cancel(target) {
      order.push('cancel');
      return adapter.cancel(target);
    },
    cleanInbox(sessionId) {
      order.push(`cleanInbox:${sessionId}`);
      return true;
    },
  };
  const store = makeReceiptStore();

  const result = await runTask({
    platform,
    task: { id: 'task-hard', scope: 'thread:rent', prompt: '长任务' },
    store,
    softMs: 10,
    hardMs: 60,
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.sessionId, 'session-hard');
  assert.ok(result.durationMs >= 50, `durationMs=${result.durationMs}`);
  assert.deepEqual(order, ['cancel', 'cleanInbox:session-hard']);

  const cancelArgs = ctx.callsOf('sessionController.cancel')[0].args[0];
  assert.deepEqual(cancelArgs, { sessionId: 'session-hard', keepInbox: true });
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0].detail_json.status, 'timeout');
  assert.match(store.events[0].detail_json.text, /状态：超时/);
});

test('取消抛错：cleanInbox 仍执行，runTask 仍返回 timeout 而不抛错', async () => {
  const ctx = new FakeCtx();
  stubCreatedSession(ctx, {
    id: 'session-cancel-throws',
    whenIdle: () => new Promise(() => {}),
  });
  const adapter = createAdapter(ctx);
  const cleaned = [];
  const platform = {
    ...adapter,
    cancel() {
      throw new Error('cancel exploded');
    },
    cleanInbox(sessionId) {
      cleaned.push(sessionId);
      return true;
    },
  };

  const result = await runTask({
    platform,
    task: { id: 'task-cancel-throws', prompt: 'x' },
    softMs: 5,
    hardMs: 30,
  });

  assert.equal(result.status, 'timeout');
  assert.deepEqual(cleaned, ['session-cancel-throws']);
});

test('cancelTask 两段式且幂等；无 sessionId 时安全返回', async () => {
  const ctx = new FakeCtx();
  const platform = createAdapter(ctx);

  const first = await cancelTask(platform, 'sess-1');
  const second = await cancelTask(platform, 'sess-1');
  assert.equal(first.cancelled, true);
  assert.deepEqual(first.errors, []);
  assert.equal(second.cancelled, true);
  assert.deepEqual(second.errors, []);
  assert.equal(ctx.callsOf('sessionController.cancel').length, 2);
  assert.deepEqual(ctx.callsOf('sessionController.cancel')[0].args[0], {
    sessionId: 'sess-1',
    keepInbox: true,
  });

  const noSession = await cancelTask(platform, '');
  assert.equal(noSession.cancelled, false);
  assert.deepEqual(noSession.errors, []);
});

test('runTask 参数校验：缺 platform / prompt / 超时关系非法时抛 TypeError', async () => {
  await assert.rejects(() => runTask({ task: { prompt: 'x' } }), /platform/);
  await assert.rejects(
    () => runTask({ platform: createAdapter(new FakeCtx()), task: {} }),
    /task\.prompt/,
  );
  await assert.rejects(
    () => runTask({
      platform: createAdapter(new FakeCtx()),
      task: { prompt: 'x' },
      softMs: 100,
      hardMs: 50,
    }),
    /hardMs/,
  );
});

test('formatReceipt：四要素齐全，长结论 + 多产物仍 ≤300 字', () => {
  const short = formatReceipt({
    status: 'ok',
    summary: '完成',
    artifacts: ['a.md'],
    durationMs: 1234,
  });
  for (const label of ['状态', '结论', '产物', '耗时']) {
    assert.ok(short.includes(label), `缺少 ${label}: ${short}`);
  }
  assert.match(short, /状态：成功/);
  assert.match(short, /耗时：1\.2s/);

  assert.match(formatReceipt({ status: 'timeout', summary: 's', durationMs: 0 }), /状态：超时/);
  assert.match(formatReceipt({ status: 'error', summary: 's' }), /状态：失败/);

  const long = formatReceipt({
    status: 'ok',
    summary: '很长的结论'.repeat(200),
    artifacts: Array.from({ length: 40 }, (_, i) => `out/artifact-${i}.md`),
    durationMs: 65_000,
  });
  assert.ok(Array.from(long).length <= RECEIPT_MAX_CHARS, `回执 ${Array.from(long).length} 字`);
  for (const label of ['状态', '结论', '产物', '耗时']) {
    assert.ok(long.includes(label), `长回执缺少 ${label}`);
  }
  assert.ok(long.includes('…'), '截断应补省略号');
  assert.match(long, /耗时：1m5s/);
});

test('writeReceipt：映射到 memory_events（action=USED/actor=scheduler），scope 与正文可回读', () => {
  const store = Store.open(':memory:');
  try {
    const id = writeReceipt(store, {
      scope: 'thread:rent',
      taskId: 'task-9',
      status: 'ok',
      text: formatReceipt({ status: 'ok', summary: '完成', durationMs: 1000 }),
    });
    assert.ok(Number.isInteger(id) && id > 0);

    const [event] = store.listEvents({ table_name: 'threads' });
    assert.equal(event.action, 'USED');
    assert.equal(event.actor, 'scheduler');
    assert.equal(event.row_id, 'task-9');
    assert.equal(event.reason, 'task_receipt:ok');

    const detail = JSON.parse(event.detail_json);
    assert.equal(detail.scope, 'thread:rent');
    assert.equal(detail.kind, 'task_receipt');
    assert.equal(detail.taskId, 'task-9');
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('状态'));

    assert.throws(
      () => writeReceipt(store, { scope: '', taskId: 'x', status: 'ok', text: 't' }),
      /scope/,
    );
    assert.throws(
      () => writeReceipt(store, { scope: 'main', taskId: 'x', status: 'ok', text: '' }),
      /text/,
    );
  } finally {
    store.close();
  }
});
