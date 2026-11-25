/**
 * v0.7.19 T3.1：reminder_add 同 scope「待触发」提醒 50 条上限护栏。
 *
 * 口径（lead 定）：同 scope 且 `status IN ('pending','snoozed','delivering')`
 * 且 `deleted_at IS NULL` 的行数；`count >= 50` 时拒绝本次新增。`fired` 已触发、
 * `done`/`cancelled`/`expired` 都是终态，与软删行一样不计入。
 *
 * 全部为「非真机证据」：只验证工具侧返回结构与落库行数，不涉及真实调度器投递。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';

const NOW_MS = Date.UTC(2026, 10, 25, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function setup(t, scope) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const tools = createTools({
    store,
    retrieve: () => ({ ok: true, items: [] }),
    platform: { log: () => {}, now: () => NOW_MS, capabilities: {} },
    clock: () => NOW_MS,
    timeZone: 'UTC',
    currentScope: () => scope,
  });
  const add = tools.find((tool) => tool.name === 'reminder_add');
  assert.ok(add, 'reminder_add 必须注册');
  return { store, add };
}

/** 直接落库造数（绕过护栏），只用来准备前置条件。 */
function seed(store, count, { scope = 'main', status = 'pending', deleted = false } = {}) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const row = store.insertReminder({
      scope,
      kind: 'todo',
      title: `积压提醒 ${scope}-${status}-${i}`,
      due_at: NOW_SEC + 60 + i,
      next_fire_at: NOW_SEC + 60 + i,
      status,
      deleted_at: deleted ? NOW_SEC : null,
    });
    ids.push(row.id);
  }
  return ids;
}

test('T3-001（v0.7.19 非真机证据）：同 scope 恰好 50 条待触发提醒时第 51 条被拒、49 条时放行', (t) => {
  // 判别力：删掉 src/runtime/tools.js 的 `activeCount >= REMINDER_ACTIVE_LIMIT`
  // 拒绝分支（或删掉 store.countActiveReminders 调用）→ 本用例红。
  const { store, add } = setup(t, 'main');
  seed(store, 49);

  const allowed = add.execute({ title: '第 50 条' });
  assert.equal(allowed.ok, true, '49 条时新增第 50 条仍应成功');
  assert.equal(store.countActiveReminders('main'), 50);

  const blocked = add.execute({ title: '第 51 条' });
  assert.equal(blocked.ok, false, '已有 50 条时新增必须被拒（边界是 >= 50）');
  assert.equal(blocked.reason, 'reminder_cap');
  assert.equal(blocked.count, 50);
  assert.equal(blocked.limit, 50);
});

test('T3-002（v0.7.19 非真机证据）：拒绝时 reason=reminder_cap、message 提示先清理且不落新行', (t) => {
  // 判别力：删掉 src/runtime/tools.js:645 之前的护栏 return（含 message 文案）→ 本用例红；
  // 把护栏挪到 store.insertReminder 之后 → 「没有插入新行」断言红。
  const { store, add } = setup(t, 'main');
  seed(store, 50);
  const before = store.listReminders({ scope: 'main' });
  assert.equal(before.length, 50);

  const result = add.execute({ title: '溢出的一条', due_at: NOW_SEC + 3600 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reminder_cap');
  assert.match(result.message, /清理/u, 'message 必须提示先清理');
  assert.match(result.message, /50/u, 'message 带上限便于用户判断');

  const after = store.listReminders({ scope: 'main' });
  assert.equal(after.length, 50, '被拒时不得插入新行');
  assert.equal(store.countActiveReminders('main'), 50);
  assert.ok(!after.some((row) => row.title === '溢出的一条'));
});

test('T3-003（v0.7.19 非真机证据）：按 scope 隔离，且终态与软删行不计入上限', (t) => {
  // 判别力：删掉 src/memory/store.js countActiveReminders 的 `scope = ?` →
  // 「其它 scope 50 条不挡本 scope」断言红；删掉 `status IN (...)` 或
  // `deleted_at IS NULL` → 「终态/软删不计数」断言红。
  const isolated = setup(t, 'thread:work');
  seed(isolated.store, 50, { scope: 'main' });
  assert.equal(isolated.store.countActiveReminders('main'), 50);
  assert.equal(isolated.store.countActiveReminders('thread:work'), 0);
  const allowed = isolated.add.execute({ title: '其它 scope 积压不影响我' });
  assert.equal(allowed.ok, true, 'main 的 50 条待触发不影响 thread:work');
  assert.equal(isolated.store.countActiveReminders('thread:work'), 1);

  // 终态（fired/done/cancelled/expired）与软删的 pending 行都不算「待触发」。
  const { store, add } = setup(t, 'main');
  for (const status of ['fired', 'done', 'cancelled', 'expired']) {
    seed(store, 13, { status });
  }
  seed(store, 50, { deleted: true });
  assert.equal(store.countActiveReminders('main'), 0);
  const result = add.execute({ title: '终态不挡新增' });
  assert.equal(result.ok, true, '终态/软删行不计入 50 条上限');
  assert.equal(store.countActiveReminders('main'), 1);
});
