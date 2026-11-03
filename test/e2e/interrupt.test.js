/**
 * V14 端到端：线程复用/冻结与任务打断（T11e）。
 *
 * 覆盖：
 * 1. 线程目录：同一 key 二次判定复用、归档线程复用并标记解冻、6 个活跃上限、
 *    `new` 缺名拒绝、重名 -2/-3 且不超过 24 码点、14 天冻结边界；
 * 2. 任务打断：软超时 600s 只告警，硬超时 900s 两段式取消并返回 timeout；
 * 3. 幂等与回执：cancelTask 连续两次安全、回执四要素且 ≤300 码点、审计事件可读回；
 * 4. 失败注入：cleanInbox 抛错不向外抛、whenIdle 抛错仍返回 error 并写回执。
 *
 * 依赖真实 Store（:memory:）与 FakeCtx；不依赖调度器/命令层，不改 src/。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/memory/store.js';
import {
  freezeIdleThreads,
  NEW_THREAD_KEY,
  planThreadRun,
  THREAD_NAME_MAX,
} from '../../src/thread/registry.js';
import { cancelTask, runTask } from '../../src/task/worker.js';
import {
  formatReceipt,
  RECEIPT_MAX_CHARS,
  writeReceipt,
} from '../../src/task/receipt.js';
import { createAdapter } from '../../src/platform/adapter.js';
import { FakeCtx } from '../fakes/ctx.js';

const DAY = 86_400;
const BASE_SECONDS = 1_700_000_000;

/** @param {Store} store @param {string} key @param {object} [overrides] */
function addThread(store, key, overrides = {}) {
  return store.upsertThread({
    key,
    name: overrides.name ?? key,
    session_id: `session-${key}`,
    description: `${key} 线程`,
    ...overrides,
  });
}

/** 让 worker 的 createSession/prompt 微任务与软/硬计时器注册完成。 */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** FakeCtx 的 createSession 覆盖：返回指定 id 与永不 settle 的 whenIdle。 */
function stubRunningSession(ctx, id) {
  ctx.returns['sessionController.createSession'] = {
    agent: { id, whenIdle: () => new Promise(() => {}) },
    agentPreset: null,
  };
}

test('V14 线程：同一 key 二次 planThreadRun 复用，归档线程返回 reactivate-archived', () => {
  const store = Store.open(':memory:');
  try {
    const first = planThreadRun({ store, key: 'rent', name: '租房' });
    assert.equal(first.action, 'create');
    assert.equal(first.key, 'rent');
    assert.equal(first.reason, 'explicit-key');

    // 上层按 plan 落库后，再判定应复用同一行。
    addThread(store, 'rent', { name: '租房' });
    const second = planThreadRun({ store, key: 'rent' });
    assert.equal(second.action, 'reuse');
    assert.equal(second.key, 'rent');
    assert.equal(second.reason, 'active-thread');
    assert.equal(store.listThreads().length, 1);

    const third = planThreadRun({ store, key: 'rent' });
    assert.equal(third.action, 'reuse');
    assert.equal(third.reason, 'active-thread');

    store.freezeThread('rent');
    const archived = planThreadRun({ store, key: 'rent' });
    assert.equal(archived.action, 'reuse');
    assert.equal(archived.reason, 'reactivate-archived');
    assert.equal(store.getThread('rent').status, 'archived');
  } finally {
    store.close();
  }
});

test('V14 线程：6 个活跃线程后拒绝第 7 个，key=new 缺名拒绝', () => {
  const store = Store.open(':memory:');
  try {
    for (let i = 1; i <= 6; i += 1) {
      addThread(store, `k${i}`);
    }
    assert.equal(store.listThreads({ status: 'active' }).length, 6);

    const seventh = planThreadRun({ store, key: 'k7' });
    assert.equal(seventh.action, 'reject');
    assert.equal(seventh.reason, 'too-many-threads');

    const viaNew = planThreadRun({ store, key: NEW_THREAD_KEY, name: '第七个' });
    assert.equal(viaNew.action, 'reject');
    assert.equal(viaNew.reason, 'too-many-threads');

    const missing = planThreadRun({ store, key: NEW_THREAD_KEY });
    assert.equal(missing.action, 'reject');
    assert.equal(missing.reason, 'name-required');

    const blank = planThreadRun({ store, key: NEW_THREAD_KEY, name: '   ' });
    assert.equal(blank.action, 'reject');
    assert.equal(blank.reason, 'name-required');

    // 冻结一个后腾出名额，显式 key 可以新建。
    store.freezeThread('k1');
    const freed = planThreadRun({ store, key: 'k7' });
    assert.equal(freed.action, 'create');
    assert.equal(freed.reason, 'explicit-key');
  } finally {
    store.close();
  }
});

test('V14 线程：重名生成 -2/-3 且始终不超过 24 码点', () => {
  const store = Store.open(':memory:');
  try {
    const longName = '长'.repeat(30); // normalize 后 24 码点
    const first = planThreadRun({ store, key: NEW_THREAD_KEY, name: longName });
    assert.equal(first.action, 'create');
    assert.equal(Array.from(first.key).length, THREAD_NAME_MAX);
    addThread(store, first.key, { name: longName });

    const second = planThreadRun({ store, key: NEW_THREAD_KEY, name: longName });
    assert.equal(second.action, 'create');
    assert.ok(second.key.endsWith('-2'), `期望 -2 后缀：${second.key}`);
    assert.equal(Array.from(second.key).length, THREAD_NAME_MAX);
    addThread(store, second.key, { name: longName });

    const third = planThreadRun({ store, key: NEW_THREAD_KEY, name: longName });
    assert.equal(third.action, 'create');
    assert.ok(third.key.endsWith('-3'), `期望 -3 后缀：${third.key}`);
    assert.ok(Array.from(third.key).length <= THREAD_NAME_MAX);
    addThread(store, third.key, { name: longName });
    assert.equal(store.listThreads({ status: 'active' }).length, 3);
  } finally {
    store.close();
  }
});

test('V14 线程：空闲恰好 14 天不冻结，14 天 + 1 秒冻结', () => {
  const store = Store.open(':memory:');
  try {
    addThread(store, 'edge', { last_active_at: BASE_SECONDS - 14 * DAY });
    addThread(store, 'stale', { last_active_at: BASE_SECONDS - 14 * DAY - 1 });
    addThread(store, 'fresh', { last_active_at: BASE_SECONDS - 13 * DAY });
    addThread(store, 'already', {
      status: 'archived',
      last_active_at: BASE_SECONDS - 30 * DAY,
    });

    const frozen = freezeIdleThreads(store, BASE_SECONDS * 1000);
    assert.equal(frozen, 1);
    assert.equal(store.getThread('edge').status, 'active');
    assert.equal(store.getThread('fresh').status, 'active');
    assert.equal(store.getThread('stale').status, 'archived');

    // 幂等：第二次没有新的可冻结行。
    assert.equal(freezeIdleThreads(store, BASE_SECONDS * 1000), 0);
  } finally {
    store.close();
  }
});

test('V14 打断：软超时 600s 只 warn，硬超时 900s 两段式取消并返回 timeout', async (t) => {
  const ctx = new FakeCtx();
  stubRunningSession(ctx, 'session-hard');
  const adapter = createAdapter(ctx);
  const order = [];
  const cleaned = [];
  const platform = {
    ...adapter,
    cancel(request) {
      order.push('cancel');
      return adapter.cancel(request);
    },
    cleanInbox(sessionId) {
      order.push(`cleanInbox:${sessionId}`);
      cleaned.push(sessionId);
      return true;
    },
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = runTask({
    platform,
    task: { id: 'task-hard', prompt: '这个任务会一直被 whenIdle 挂住' },
    now: () => ctx.now(),
    softMs: 600_000,
    hardMs: 900_000,
  });
  await flushMicrotasks();

  assert.equal(ctx.callsOf('sessionController.createSession').length, 1);
  assert.equal(ctx.callsOf('sessionController.prompt').length, 1);
  assert.equal(ctx.callsOf('sessionController.cancel').length, 0);

  // 软超时：只告警，不打断。
  ctx.advance(600_000);
  t.mock.timers.tick(600_000);
  const softWarns = ctx.logs.filter(
    (entry) => entry.level === 'warn' && entry.message.includes('soft timeout'),
  );
  assert.equal(softWarns.length, 1);
  assert.match(softWarns[0].message, /still running, not interrupted/);
  assert.equal(ctx.callsOf('sessionController.cancel').length, 0);
  assert.deepEqual(order, []);

  // 再推进 300s 到硬超时：先 cancel({sessionId,keepInbox:true})，再 cleanInbox。
  ctx.advance(300_000);
  t.mock.timers.tick(300_000);
  const result = await pending;

  assert.equal(result.status, 'timeout');
  assert.equal(result.sessionId, 'session-hard');
  assert.equal(result.durationMs, 900_000);
  assert.deepEqual(order, ['cancel', 'cleanInbox:session-hard']);
  assert.deepEqual(cleaned, ['session-hard']);
  assert.deepEqual(ctx.callsOf('sessionController.cancel')[0].args[0], {
    sessionId: 'session-hard',
    keepInbox: true,
  });

  t.mock.timers.reset();
});

test('V14 幂等与回执：cancelTask 两次安全，回执四要素 ≤300 码点且可按 USED 读回', async () => {
  const store = Store.open(':memory:');
  try {
    const ctx = new FakeCtx();
    const adapter = createAdapter(ctx);
    const cleaned = [];
    const platform = {
      ...adapter,
      cleanInbox(sessionId) {
        cleaned.push(sessionId);
        return true;
      },
    };

    const first = await cancelTask(platform, 'sess-1');
    const second = await cancelTask(platform, 'sess-1');
    for (const result of [first, second]) {
      assert.equal(result.cancelled, true);
      assert.deepEqual(result.errors, []);
    }
    assert.equal(ctx.callsOf('sessionController.cancel').length, 2);
    assert.deepEqual(ctx.callsOf('sessionController.cancel')[0].args[0], {
      sessionId: 'sess-1',
      keepInbox: true,
    });
    // 第二段可重复执行且安全。
    assert.deepEqual(cleaned, ['sess-1', 'sess-1']);

    assert.equal(formatReceipt({ status: 'ok', summary: '完成', durationMs: 1000 })
      .includes('状态：成功'), true);

    const text = formatReceipt({
      status: 'ok',
      summary: '很长的结论'.repeat(200),
      artifacts: Array.from({ length: 40 }, (_, i) => `out/artifact-${i}.md`),
      durationMs: 65_000,
    });
    assert.ok(Array.from(text).length <= RECEIPT_MAX_CHARS, `回执 ${Array.from(text).length} 字`);
    for (const label of ['状态', '结论', '产物', '耗时']) {
      assert.ok(text.includes(label), `回执缺少 ${label}`);
    }
    assert.ok(text.includes('…'), '长回执应截断并补省略号');

    const id = writeReceipt(store, {
      scope: 'thread:rent',
      taskId: 'task-9',
      status: 'ok',
      text,
    });
    assert.ok(Number.isInteger(id) && id > 0);

    const [event] = store.listEvents({ action: 'USED' });
    assert.equal(event.action, 'USED');
    assert.equal(event.actor, 'scheduler');
    assert.equal(event.table_name, 'threads');
    assert.equal(event.row_id, 'task-9');
    assert.equal(event.reason, 'task_receipt:ok');
    const detail = JSON.parse(event.detail_json);
    assert.equal(detail.scope, 'thread:rent');
    assert.equal(detail.kind, 'task_receipt');
    assert.equal(detail.taskId, 'task-9');
    assert.equal(detail.status, 'ok');
    assert.ok(detail.text.includes('状态：成功'));
  } finally {
    store.close();
  }
});

test('V14 失败注入：cleanInbox 抛错不抛，whenIdle 抛错返回 error 且回执仍写', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  const platform = {
    ...adapter,
    cleanInbox() {
      throw new Error('cleanInbox exploded');
    },
  };

  const cancelled = await cancelTask(platform, 'sess-fail');
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.sessionId, 'sess-fail');
  assert.equal(cancelled.errors.length, 1);
  assert.match(cancelled.errors[0], /cleanInbox: cleanInbox exploded/);

  const store = Store.open(':memory:');
  try {
    const idleCtx = new FakeCtx();
    idleCtx.returns['sessionController.createSession'] = {
      agent: {
        id: 'session-error',
        whenIdle() {
          throw new Error('idle exploded');
        },
      },
      agentPreset: null,
    };
    const result = await runTask({
      platform: createAdapter(idleCtx),
      task: { id: 'task-error', scope: 'main', prompt: '会失败的任务' },
      store,
      softMs: 600_000,
      hardMs: 900_000,
    });

    assert.equal(result.status, 'error');
    assert.equal(result.sessionId, 'session-error');
    assert.match(result.error, /idle exploded/);

    const events = store.listEvents({ action: 'USED' });
    assert.equal(events.length, 1);
    const detail = JSON.parse(events[0].detail_json);
    assert.equal(detail.taskId, 'task-error');
    assert.equal(detail.status, 'error');
    assert.match(detail.text, /状态：失败/);
  } finally {
    store.close();
  }
});
