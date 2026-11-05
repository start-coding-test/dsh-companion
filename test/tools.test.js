/**
 * 模型工具面与运行指标测试（t11）：
 * - 9 个工具描述符的 schema/唯一性；
 * - execute 只走注入依赖（retrieve/store/registry/platform）；
 * - 线程工具与真实 registry、fake platform 的配合；
 * - metrics.snapshot() 的固定字段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { createMetrics } from '../src/runtime/metrics.js';
import * as registry from '../src/thread/registry.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const TOOL_NAMES = [
  'memory_search', 'memory_write', 'memory_forget', 'reminder_add',
  'reminder_done', 'thread_list', 'thread_run', 'cost_report', 'task_run',
];

function makeHarness() {
  const store = Store.open(':memory:');
  const searchCalls = [];
  const retrieve = async (request) => {
    searchCalls.push(request);
    return {
      items: [{ kind: 'fact', id: 'injected-1', text: '注入的检索结果', fidelity: 'full', score: 1, R: 1 }],
      tokens: 3,
      usedIds: ['injected-1'],
      truncated: false,
    };
  };
  const platform = {
    sessions: [],
    prompts: [],
    unarchived: [],
    async createSession(request) {
      this.sessions.push(request);
      return { sessionId: 'sess-created', agent: { id: 'sess-created' } };
    },
    async prompt(request) {
      this.prompts.push(request);
      return { ok: true };
    },
    async unarchiveSession(sessionId) {
      this.unarchived.push(sessionId);
      return { ok: true };
    },
  };
  const tools = createTools({
    store,
    retrieve,
    registry,
    platform,
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-thread',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, retrieve, searchCalls, platform, tools, byName };
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    kind: 'preference',
    subject_text: '我妈',
    predicate: '生日',
    object_text: '五月',
    statement: '我妈生日是五月',
    source_kind: 'user_explicit',
    ...overrides,
  });
}

test('9 个工具描述符：name 唯一，parameters 为合法 JSON Schema', () => {
  const harness = makeHarness();
  try {
    assert.equal(harness.tools.length, 9);
    const names = harness.tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, 9);
    assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());

    for (const tool of harness.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0, `${tool.name} 缺少 description`);
      assert.equal(tool.parameters.type, 'object');
      assert.equal(typeof tool.parameters.properties, 'object');
      assert.ok(!Array.isArray(tool.parameters.properties));
      assert.ok(Array.isArray(tool.parameters.required));
      for (const key of tool.parameters.required) {
        assert.ok(key in tool.parameters.properties, `${tool.name} 必填字段 ${key} 未声明`);
      }
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(tool.parameters)));
      assert.equal(typeof tool.execute, 'function');
    }
  } finally {
    harness.store.close();
  }
});

test('memory_search：走注入的 retrieve，并透传 query/scope/limit', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.byName.memory_search.execute({
      query: '生日',
      scope: 'thread:rent',
      limit: 5,
    });
    assert.equal(result.items[0].id, 'injected-1');
    assert.equal(harness.searchCalls.length, 1);
    assert.equal(harness.searchCalls[0].store, harness.store);
    assert.equal(harness.searchCalls[0].query, '生日');
    assert.equal(harness.searchCalls[0].scope, 'thread:rent');
    assert.equal(harness.searchCalls[0].limit, 5);

    await assert.rejects(() => harness.byName.memory_search.execute({}), /query/);
  } finally {
    harness.store.close();
  }
});

test('memory_write/memory_forget：写入事实并标记遗忘', () => {
  const harness = makeHarness();
  try {
    const written = harness.byName.memory_write.execute({
      statement: '我每天早上跑步',
      kind: 'preference',
      subject: '我',
      predicate: '习惯',
      object: '跑步',
    });
    assert.equal(written.ok, true);
    const row = harness.store.getFact(written.id);
    assert.equal(row.statement, '我每天早上跑步');
    assert.equal(row.source_kind, 'user_explicit');
    assert.throws(() => harness.byName.memory_write.execute({}), /statement/);

    const forgotten = harness.byName.memory_forget.execute({ id: written.id });
    assert.equal(forgotten.ok, true);
    assert.ok(harness.store.getFact(written.id).deleted_at);
    assert.throws(() => harness.byName.memory_forget.execute({}), /id/);
  } finally {
    harness.store.close();
  }
});

test('reminder_add/reminder_done：写入到点提醒并标记完成', () => {
  const harness = makeHarness();
  try {
    const added = harness.byName.reminder_add.execute({
      title: '交房租',
      due_at: NOW_SEC + 3600,
    });
    assert.equal(added.ok, true);
    const reminder = harness.store.getReminder(added.reminder.id);
    assert.equal(reminder.kind, 'todo');
    assert.equal(reminder.status, 'pending');
    assert.equal(reminder.due_at, NOW_SEC + 3600);
    assert.throws(() => harness.byName.reminder_add.execute({}), /title/);

    const done = harness.byName.reminder_done.execute({ id: reminder.id });
    assert.equal(done.ok, true);
    const closed = harness.store.getReminder(reminder.id);
    assert.equal(closed.status, 'done');
    assert.ok(closed.closed_at > 0);
  } finally {
    harness.store.close();
  }
});

test('thread_list：按状态与关键词过滤线程目录', () => {
  const harness = makeHarness();
  try {
    harness.store.upsertThread({
      key: 'rent', name: '租房', session_id: 's-rent',
      description: '找房子', last_active_at: NOW_SEC,
    });
    harness.store.upsertThread({
      key: 'job', name: '换工作', session_id: 's-job',
      description: '准备面试', last_active_at: NOW_SEC - 60,
    });

    const all = harness.byName.thread_list.execute({});
    assert.equal(all.count, 2);
    const filtered = harness.byName.thread_list.execute({ query: '租' });
    assert.equal(filtered.count, 1);
    assert.equal(filtered.items[0].key, 'rent');
  } finally {
    harness.store.close();
  }
});

test('thread_run：新建线程会话、写 threads 行并投递目标', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '租房',
      goal: '帮我找两居室',
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    assert.equal(result.sessionId, 'sess-created');
    assert.equal(result.prompted, true);

    assert.equal(harness.platform.sessions.length, 1);
    // V10-H1：未配置 thread.agentPreset 时不传该参数，走宿主默认 preset。
    assert.equal(Object.hasOwn(harness.platform.sessions[0], 'agentPreset'), false);
    assert.equal(harness.platform.prompts[0].sessionId, 'sess-created');
    assert.equal(harness.platform.prompts[0].content[0].text, '帮我找两居室');

    const thread = harness.store.getThread(result.key);
    assert.equal(thread.session_id, 'sess-created');
    assert.equal(thread.status, 'active');
    await assert.rejects(() => harness.byName.thread_run.execute({}), /key/);
  } finally {
    harness.store.close();
  }
});

test('thread_run：复用归档线程会调用 unarchiveSession 并继续投递', async () => {
  const harness = makeHarness();
  try {
    harness.store.upsertThread({
      key: 'rent', name: '租房', session_id: 's-old',
      description: '找房子', status: 'archived', last_active_at: NOW_SEC - 86400,
    });

    const result = await harness.byName.thread_run.execute({ key: 'rent', goal: '继续找房' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reuse');
    assert.equal(result.reactivated, true);
    assert.deepEqual(harness.platform.unarchived, ['s-old']);
    assert.equal(harness.platform.prompts[0].sessionId, 's-old');
    assert.equal(harness.store.getThread('rent').status, 'active');
  } finally {
    harness.store.close();
  }
});

test('thread_run 与 task_run 共用执行槽（N-M2）', async () => {
  const harness = makeHarness();
  let releaseIdle;
  const idle = new Promise((resolve) => {
    releaseIdle = resolve;
  });
  harness.platform.whenIdle = () => idle;
  let first;

  try {
    first = await harness.byName.thread_run.execute({
      key: 'new', name: '占槽线程', goal: '查一下预算',
    });
    assert.equal(first.ok, true);

    const second = await harness.byName.thread_run.execute({
      key: 'new', name: '第二个线程', goal: '查一下预算',
    });
    assert.deepEqual([second.ok, second.reason], [false, 'busy'], '执行槽被占时应立即 busy');
    assert.equal(harness.platform.sessions.length, 1, 'busy 时不应创建会话');
  } finally {
    releaseIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const third = await harness.byName.thread_run.execute({
    key: first.key, goal: '继续查预算',
  });
  assert.equal(third.ok, true, 'whenIdle 之后槽应释放');
});

test('thread_run：活跃线程达上限时拒绝新建', async () => {
  const harness = makeHarness();
  try {
    for (let i = 1; i <= 6; i += 1) {
      harness.store.upsertThread({
        key: `t${i}`, name: `线程${i}`, session_id: `s-${i}`,
        description: '占位', last_active_at: NOW_SEC - i,
      });
    }
    const result = await harness.byName.thread_run.execute({ key: 'new', name: '第七个' });
    assert.equal(result.ok, false);
    assert.equal(result.action, 'reject');
    assert.equal(result.reason, 'too-many-threads');
    assert.equal(harness.platform.sessions.length, 0);
  } finally {
    harness.store.close();
  }
});

test('cost_report：返回今日/本月 token 汇总', () => {
  const harness = makeHarness();
  try {
    harness.store.appendEvent({
      at: Math.floor(Date.now() / 1000),
      action: 'ADD',
      actor: 'consolidator',
      table_name: 'consolidations',
      row_id: 'cs-1',
      detail_json: { tokensIn: 7, tokensOut: 3 },
    });
    const report = harness.byName.cost_report.execute({});
    assert.equal(report.today.tokensIn, 7);
    assert.equal(report.today.tokensOut, 3);
    assert.equal(report.month.tokensIn, 7);
    assert.equal(report.month.tokensOut, 3);
  } finally {
    harness.store.close();
  }
});

test('metrics：inc/observe/snapshot 固定字段与时钟', () => {
  let clockValue = 1234;
  const metrics = createMetrics({ clock: () => clockValue });
  metrics.inc('tokensIn', 10);
  metrics.inc('tokensOut', 5);
  metrics.inc('overBudget');
  metrics.inc('recalls', 2);
  metrics.observe('tokensIn', 100); // observation 优先

  const snap = metrics.snapshot();
  assert.equal(snap.tokensIn, 100);
  assert.equal(snap.tokensOut, 5);
  assert.equal(snap.overBudget, 1);
  assert.equal(snap.recalls, 2);
  assert.equal(typeof snap.rssMB, 'number');
  assert.ok(snap.rssMB > 0);
  assert.equal(snap.capturedAt, 1234);

  clockValue = 5678;
  assert.equal(metrics.snapshot().capturedAt, 5678);
  assert.throws(() => metrics.inc(''), /name/);
  assert.throws(() => metrics.observe('recalls', Number.NaN), /value/);
});
