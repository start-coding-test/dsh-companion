/**
 * v0.7.18 L4：强化审计来源；L2/L3：回填批不占 `/状态` 展示面 + 取消受理文案不主张终态。
 *
 * `Store.reinforceFact` 新增 `reason` / `actor` 两个可选入参，**默认保持原值**
 * （`used_in_reply` / `consolidator`）⇒ 巩固与召回强化路径零行为差异；
 * 只有 `memory_write` 的查重强化改记 `dedupe_write` / `user`（用户 2026-11-25 裁决：
 * 计划原文的 `actor='tool'` 被 schema 16 的 `memory_events.actor` CHECK 拒绝，
 * 落到既有 `user` 桶；`reason` 仍区分「查重写入」），便于审计区分来源。
 *
 * 全部为「非真机证据」：只验证审计事件字段，不涉及真实模型裁决或宿主路由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { formatStopTaskReply, handleCommand } from '../src/runtime/commands.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'preference',
    subject_text: '我',
    predicate: '记住',
    object_text: null,
    statement: '一条事实',
    source_kind: 'user_explicit',
    observed_at: NOW_SEC,
    ...overrides,
  });
}

function reinforceEvents(store, id) {
  return store.listEvents({ action: 'REINFORCE', row_id: id });
}

function makeMemoryWrite(store, extra = {}) {
  const tools = createTools({
    store,
    retrieve: () => ({ ok: true, items: [] }),
    platform: { log: () => {}, now: () => NOW_MS, capabilities: {} },
    clock: () => NOW_MS,
    timeZone: 'UTC',
    currentScope: () => 'main',
    ...extra,
  });
  return tools.find((tool) => tool.name === 'memory_write');
}

test('L4（v0.7.18 非真机证据）：reinforceFact 不带新参时审计仍是 used_in_reply/consolidator', (t) => {
  const store = openStore(t);
  const fact = addFact(store);

  const result = store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC });
  assert.equal(result.ok, true);

  const events = reinforceEvents(store, fact.id);
  assert.equal(events.length, 1);
  // 默认保持原值：巩固（consolidate）与召回路径都走这条默认分支，删默认值会立刻红。
  assert.equal(events[0].actor, 'consolidator');
  assert.equal(events[0].reason, 'used_in_reply');

  // 显式传参可用；非字符串/空串回落默认值（只影响审计，不新增抛错路径）。
  assert.equal(store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC, reason: 'dedupe_write', actor: 'user' }).ok, true);
  assert.equal(store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC, reason: '', actor: 7 }).ok, true);

  const all = reinforceEvents(store, fact.id);
  assert.equal(all.length, 3);
  assert.deepEqual([all[1].actor, all[1].reason], ['user', 'dedupe_write']);
  assert.deepEqual([all[2].actor, all[2].reason], ['consolidator', 'used_in_reply']);
});

test('L4（v0.7.18 非真机证据）：memory_write 查重 skip 强化的审计是 dedupe_write/user', async (t) => {
  const store = openStore(t);
  const statement = '青柠计划的代号是蓝鲸。';
  addFact(store, { statement });

  const write = makeMemoryWrite(store);
  const result = await write.execute({ kind: 'preference', statement, salience: 'normal', privacy: 'normal' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'reinforced', '同 kind 高相似走 skip → 强化旧条');
  assert.ok(result.duplicateOf, '返回 duplicateOf');

  const events = reinforceEvents(store, result.duplicateOf);
  assert.equal(events.length, 1);
  // tools.js 的 reinforce helper 一处传参即覆盖 skip 与 ask→same 两条分支。
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].reason, 'dedupe_write');
});

test('L4（v0.7.18 非真机证据）：memory_write ask→same 强化同样记 dedupe_write/user', async (t) => {
  const store = openStore(t);
  const statement = '青柠计划的代号是蓝鲸。';
  addFact(store, { statement: `${statement}（旧版本）` });

  const write = makeMemoryWrite(store, {
    judge: async () => JSON.stringify({ items: [{ index: 1, verdict: 'same' }] }),
    dedupe: { dedupeSkip: 0.99, dedupeAsk: 0.1 },
  });
  const result = await write.execute({ kind: 'preference', statement, salience: 'normal', privacy: 'normal' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'reinforced');

  const events = reinforceEvents(store, result.duplicateOf);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].reason, 'dedupe_write');
});


// ------------------------------------------------------ L2（/状态 最近 job）

test('L2（v0.7.18 非真机证据）：回填批不占「最近 job：」，仍显示正常巩固行', (t) => {
  const store = openStore(t);
  // 正常巩固行较早落库；回填批（kind=forget_flush + trigger=backfill）更晚，
  // 若 SQL 不过滤 trigger，ORDER BY started_at DESC 会选中回填行（删掉过滤即红）。
  store.insertConsolidation({
    scope: 'main',
    kind: 'nap',
    trigger: 'threshold',
    upto_seq: 120,
    session_id: 'session-l2',
    status: 'written',
    started_at: NOW_SEC - 600,
  });
  store.insertConsolidation({
    scope: 'main',
    kind: 'forget_flush',
    trigger: 'backfill',
    upto_seq: 120,
    session_id: 'session-l2',
    status: 'written',
    started_at: NOW_SEC,
  });

  const reply = handleCommand({ text: '/状态', store, now: NOW_MS, timeZone: 'UTC' }).reply;
  assert.match(reply, /最近 job：nap written/u, '应选正常巩固行，实际：' + reply);
  assert.doesNotMatch(reply, /forget_flush/u);
});

// ------------------------------------------------------ L3（取消受理文案）

test('L3（v0.7.18 非真机证据）：取消受理文案不主张终态，两条分支措辞一致', () => {
  // 判别力：把 commands.js 的两处受理文案改回旧版（含「（状态：已取消）」）即红。
  const bg = formatStopTaskReply({ taskId: 'bg-1', kind: 'bg', result: { ok: true, cancelled: 1, taskId: 'bg-1' } });
  const task = formatStopTaskReply({ taskId: 'task-1', result: { ok: true, cancelled: 1, taskId: 'task-1' } });
  for (const [label, text, target] of [
    ['bg', bg, 'bg-1'],
    ['task', task, 'task-1'],
  ]) {
    assert.match(text, /取消中，收尾后回执送达/u, label + ' 应说明取消中而非终态');
    assert.ok(text.includes(target), label + ' 保留任务标识');
    assert.doesNotMatch(text, /已取消/u, label + ' 不应提前主张已取消');
  }
});
