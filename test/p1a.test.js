/**
 * P1-a 命令与工具接线测试：/记忆 列表/改/治理 与 memory_update。
 *
 * 旧 handleCommand 的 /记忆 汇总/忘掉/置顶 仍由 commands.test.js 覆盖；这里
 * 验证 index.js 的拦截层只接管新子命令，且真实 apply() 注册的
 * memory_update 工具能完成「旧条 superseded、新条 active、EDIT 审计」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import {
  editMemoryFact,
  handleMemoryCommand,
  updateMemoryTool,
} from '../src/index.js';
import { apply } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);

function makeStore(t) {
  const store = Store.open(':memory:');
  if (t && typeof t.after === 'function') t.after(() => store.close());
  return store;
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    kind: 'preference',
    subject_text: '我',
    predicate: '习惯',
    object_text: '喝咖啡',
    statement: '我习惯早上喝咖啡',
    source_kind: 'user_explicit',
    observed_at: Math.floor(NOW_MS / 1000),
    ...overrides,
  });
}

function run(store, text, extra = {}) {
  return handleMemoryCommand({ text, store, now: NOW_MS, scope: 'main', timeZone: 'Asia/Shanghai', ...extra });
}

test('/记忆 无参：按 kind 分组列表，含 id/source/日期；关键词过滤', (t) => {
  const store = makeStore(t);
  const preference = addFact(store);
  addFact(store, {
    kind: 'identity',
    subject_text: '我',
    predicate: '名字',
    object_text: '小林',
    statement: '我叫小林',
    source_kind: 'user_explicit',
  });

  const list = run(store, '/记忆');
  assert.match(list, /记忆（共 2 条）/);
  assert.match(list, /\[identity\]/);
  assert.match(list, /\[preference\]/);
  assert.ok(list.includes(preference.id));
  assert.match(list, /user_explicit/);
  assert.match(list, /2026-11-05/);

  const filtered = run(store, '/记忆 名字');
  assert.match(filtered, /匹配「名字」共 1 条/);
  assert.match(filtered, /我叫小林/);
  assert.doesNotMatch(filtered, /早上喝咖啡/);

  const empty = run(store, '/记忆 不存在的关键词');
  assert.match(empty, /没有匹配的记忆/);
});

test('/记忆 列表分页：每页最多 20 条，第二页有剩余提示', (t) => {
  const store = makeStore(t);
  for (let index = 0; index < 25; index += 1) {
    addFact(store, {
      subject_text: `主题${index}`,
      statement: `偏好 ${index}`,
    });
  }
  const first = run(store, '/记忆');
  assert.match(first, /第 1\/2 页/);
  assert.match(first, /还有 5 条/);
  const second = run(store, '/记忆 --page 2');
  assert.match(second, /第 2\/2 页/);
  assert.doesNotMatch(second, /还有/);
});

test('/记忆 改：旧条 superseded_by 新条，新条 active，写 EDIT 事件；缺 id 可读错误', (t) => {
  const store = makeStore(t);
  const old = addFact(store);
  const reply = run(store, `/记忆 改 ${old.id} 我习惯早上喝美式咖啡`);
  assert.match(reply, /已更新记忆/);

  const superseded = store.getFact(old.id);
  assert.equal(superseded.status, 'superseded');
  assert.ok(superseded.superseded_by);
  const updated = store.getFact(superseded.superseded_by);
  assert.equal(updated.status, 'active');
  assert.equal(updated.statement, '我习惯早上喝美式咖啡');
  assert.equal(updated.id === old.id, false);

  const event = store.listEvents({ action: 'EDIT', limit: 1 })[0];
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.from, old.id);
  assert.equal(detail.to, updated.id);
  assert.equal(detail.edited, true, 'V3-M4：EDIT 审计标出这是编辑');
  assert.equal(detail.reextracted, true);

  const missing = run(store, '/记忆 改 fact_missing 新内容');
  assert.match(missing, /修改失败/);
  assert.match(missing, /没有找到/);
  const usage = run(store, '/记忆 改');
  assert.match(usage, /用法/);
});

test('/记忆 治理 --dry-run 不写库，/记忆 治理 应用并回显摘要', (t) => {
  const store = makeStore(t);
  const first = addFact(store, { statement: '重复的偏好一样' });
  const second = addFact(store, { statement: '重复的偏好一样' });

  const dry = run(store, '/记忆 治理 --dry-run');
  assert.match(dry, /dry-run/);
  assert.match(dry, /重复 1 组/);
  assert.equal(store.getFact(first.id).status, 'active');
  assert.equal(store.getFact(second.id).status, 'active');

  const applied = run(store, '/记忆 治理');
  assert.match(applied, /已应用/);
  const statuses = [store.getFact(first.id).status, store.getFact(second.id).status].sort();
  assert.deepEqual(statuses, ['active', 'superseded']);
  assert.equal(store.listEvents({ action: 'govern', limit: 10 }).length, 1);
});

test('/记忆 忘掉/置顶 仍交给旧 handleCommand（拦截层返回 null）', () => {
  const store = Store.open(':memory:');
  try {
    assert.equal(run(store, '/记忆 忘掉 fact_x'), null);
    assert.equal(run(store, '/记忆 彻底忘掉 fact_x'), null);
    assert.equal(run(store, '/记忆 置顶 fact_x'), null);
    assert.equal(run(store, '/记忆 取消置顶 fact_x'), null);
  } finally {
    store.close();
  }
});

test('editMemoryFact/updateMemoryTool：scope 固定当前，subagent 不能写', (t) => {
  const store = makeStore(t);
  const fact = addFact(store);
  const denied = updateMemoryTool({
    store,
    scope: null,
    args: { id: fact.id, statement: '不该写入' },
    now: NOW_MS,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'scope_denied');

  const cross = editMemoryFact({
    store,
    scope: 'thread:budget',
    id: fact.id,
    statement: '跨作用域修改',
    now: NOW_MS,
  });
  assert.equal(cross.ok, false);
  assert.equal(cross.reason, 'scope_denied');

  const normal = updateMemoryTool({
    store,
    scope: 'main',
    args: { id: fact.id, statement: '新偏好内容' },
    now: NOW_MS,
  });
  assert.equal(normal.ok, true);
  assert.equal(store.getFact(fact.id).status, 'superseded');
  assert.equal(store.getFact(normal.id).statement, '新偏好内容');
});

function makePluginCtx() {
  const ctx = new FakeCtx({ now: NOW_MS });
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  return ctx;
}

test('真实 apply 注册 10 个工具；/记忆 拦截与 memory_update 端到端', async () => {
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: ':memory:' });
  try {
    assert.equal(ctx.tools.registrations.length, 10);
    assert.equal(ctx.tools.registrations.some((definition) => definition.name === 'memory_update'), true);

    const write = ctx.tools.registrations.find((definition) => definition.name === 'memory_write');
    const written = write.execute({ statement: '每周五交周报', kind: 'project' });
    assert.equal(written.ok, true);

    const memory = ctx.commands.registrations.find((definition) => definition.name === 'memory');
    const listed = memory.handler({ rawInput: '' });
    assert.equal(listed.kind, 'success');
    assert.match(listed.text, /每周五交周报/);

    const update = ctx.tools.registrations.find((definition) => definition.name === 'memory_update');
    const updated = update.execute({ id: written.id, statement: '每周四交周报' });
    assert.equal(updated.ok, true);
    assert.equal(updated.supersededId, written.id);

    const edited = memory.handler({ rawInput: ` 改 ${updated.id} 每周三交周报` });
    assert.equal(edited.kind, 'success');
    assert.match(edited.text, /已更新记忆/);

    const dry = memory.handler({ rawInput: ' 治理 --dry-run' });
    assert.equal(dry.kind, 'success');
    assert.match(dry.text, /dry-run/);

    await ctx.dispatch(
      'agent/pre-step',
      {
        agent: { session: { id: 'sub-agent-1' }, header: { origin: 'subagent' } },
        messages: [],
        turn: 1,
        step: 1,
      },
      { kind: 'enter', messages: [] },
    );
    const denied = update.execute({ id: updated.id, statement: 'subagent 不应写入' });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'scope_denied');
  } finally {
    handle?.dispose();
  }
});
