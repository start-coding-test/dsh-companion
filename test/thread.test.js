/**
 * 线程目录测试（T8）：命名兜底、复用/新建/拒绝判定、第 7 个线程拒绝、
 * 14 天空闲冻结与边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import {
  freezeIdleThreads,
  MAX_ACTIVE_THREADS,
  NEW_THREAD_KEY,
  normalizeThreadName,
  planThreadRun,
  THREAD_IDLE_DAYS,
  THREAD_NAME_MAX,
} from '../src/thread/registry.js';

const DAY = 86_400;

/** 每个用例一个独立内存库，避免线程行互相干扰。 */
function makeStore() {
  return Store.open(':memory:');
}

/**
 * @param {Store} store
 * @param {string} key
 * @param {object} [overrides]
 */
function addThread(store, key, overrides = {}) {
  return store.upsertThread({
    key,
    name: overrides.name ?? key,
    session_id: `session-${key}`,
    description: `${key} 线程`,
    ...overrides,
  });
}

test('normalizeThreadName：去空白/控制字符、空白转 -、24 码点上限、空名抛错', () => {
  assert.equal(normalizeThreadName('  租房  攻略  '), '租房-攻略');
  assert.equal(normalizeThreadName('a\tb\nc'), 'a-b-c');
  assert.equal(normalizeThreadName('租\u0000房\u001f'), '租房');
  assert.equal(normalizeThreadName('  多  个   空格  '), '多-个-空格');
  assert.equal(normalizeThreadName('已-存在'), '已-存在');
  assert.equal(normalizeThreadName('x'.repeat(30)), 'x'.repeat(THREAD_NAME_MAX));
  assert.equal(
    Array.from(normalizeThreadName('长'.repeat(30))).length,
    THREAD_NAME_MAX,
  );
  // 24 个码点边界：不截断
  assert.equal(normalizeThreadName('y'.repeat(24)), 'y'.repeat(24));

  assert.throws(() => normalizeThreadName('   '), /non-empty string/);
  assert.throws(() => normalizeThreadName(''), /non-empty string/);
  assert.throws(() => normalizeThreadName('\u0000\u0001'), /non-empty string/);
  assert.throws(() => normalizeThreadName(null), /non-empty string/);
  assert.throws(() => normalizeThreadName(42), /non-empty string/);
});

test('planThreadRun：已有 active key 复用且不新建行', () => {
  const store = makeStore();
  try {
    addThread(store, 'rent', { name: '租房' });
    const before = store.listThreads().length;

    const plan = planThreadRun({ store, key: 'rent', now: Date.now() });
    assert.equal(plan.action, 'reuse');
    assert.equal(plan.key, 'rent');
    assert.equal(plan.reason, 'active-thread');
    // plan 只读：行数与内容都不变
    assert.equal(store.listThreads().length, before);
    assert.equal(store.getThread('rent').name, '租房');
  } finally {
    store.close();
  }
});

test('planThreadRun：已冻结的 key 返回 reuse 让上层解冻', () => {
  const store = makeStore();
  try {
    addThread(store, 'old', { name: '旧线程' });
    store.freezeThread('old');
    const plan = planThreadRun({ store, key: 'old' });
    assert.equal(plan.action, 'reuse');
    assert.equal(plan.key, 'old');
    assert.equal(plan.reason, 'reactivate-archived');
  } finally {
    store.close();
  }
});

test('planThreadRun：显式 key 不存在时 create，且不写库', () => {
  const store = makeStore();
  try {
    const plan = planThreadRun({ store, key: 'coding', name: '写代码' });
    assert.equal(plan.action, 'create');
    assert.equal(plan.key, 'coding');
    assert.equal(plan.reason, 'explicit-key');
    assert.equal(store.getThread('coding'), null);
  } finally {
    store.close();
  }
});

test("planThreadRun：key='new' 由中文短名生成 key，重名加 -2", () => {
  const store = makeStore();
  try {
    const first = planThreadRun({ store, key: NEW_THREAD_KEY, name: '租房 攻略' });
    assert.equal(first.action, 'create');
    assert.equal(first.key, '租房-攻略');
    assert.equal(first.reason, 'new-thread');

    addThread(store, first.key, { name: '租房 攻略' });
    const second = planThreadRun({ store, key: NEW_THREAD_KEY, name: '租房 攻略' });
    assert.equal(second.action, 'create');
    assert.equal(second.key, '租房-攻略-2');

    addThread(store, second.key);
    const third = planThreadRun({ store, key: NEW_THREAD_KEY, name: '租房 攻略' });
    assert.equal(third.key, '租房-攻略-3');
  } finally {
    store.close();
  }
});

test('planThreadRun：24 码点名字加后缀后仍不超长', () => {
  const store = makeStore();
  try {
    const base = normalizeThreadName('长'.repeat(30));
    assert.equal(Array.from(base).length, THREAD_NAME_MAX);
    addThread(store, base);
    const plan = planThreadRun({ store, key: NEW_THREAD_KEY, name: '长'.repeat(30) });
    assert.equal(plan.action, 'create');
    assert.ok(plan.key.endsWith('-2'), `期望 -2 后缀，实际 ${plan.key}`);
    assert.ok(Array.from(plan.key).length <= THREAD_NAME_MAX, 'key 超长');
  } finally {
    store.close();
  }
});

test("planThreadRun：key='new' 缺 name / name 无内容时拒绝", () => {
  const store = makeStore();
  try {
    const missing = planThreadRun({ store, key: NEW_THREAD_KEY });
    assert.equal(missing.action, 'reject');
    assert.equal(missing.reason, 'name-required');

    const blank = planThreadRun({ store, key: NEW_THREAD_KEY, name: '   ' });
    assert.equal(blank.action, 'reject');
    assert.equal(blank.reason, 'name-required');
    assert.equal(store.listThreads().length, 0);
  } finally {
    store.close();
  }
});

test('planThreadRun：第 7 个活跃线程被拒绝（maxActive=6）', () => {
  const store = makeStore();
  try {
    assert.equal(MAX_ACTIVE_THREADS, 6);
    for (let i = 1; i <= 6; i += 1) {
      addThread(store, `k${i}`);
    }
    const seventh = planThreadRun({ store, key: 'k7' });
    assert.equal(seventh.action, 'reject');
    assert.equal(seventh.reason, 'too-many-threads');

    const viaNew = planThreadRun({ store, key: NEW_THREAD_KEY, name: '第七个' });
    assert.equal(viaNew.action, 'reject');
    assert.equal(viaNew.reason, 'too-many-threads');

    // 冻结一个后腾出名额
    store.freezeThread('k1');
    const afterFreeze = planThreadRun({ store, key: 'k7' });
    assert.equal(afterFreeze.action, 'create');
    assert.equal(afterFreeze.key, 'k7');

    // maxActive 可被配置覆盖
    const custom = planThreadRun({ store, key: 'k7', maxActive: 2 });
    assert.equal(custom.action, 'reject');
    assert.equal(custom.reason, 'too-many-threads');
  } finally {
    store.close();
  }
});

test('freezeIdleThreads：15 天未活跃冻结、13 天保留、恰好 14 天不冻结', () => {
  const store = makeStore();
  const base = 1_700_000_000; // 秒
  try {
    addThread(store, 'stale', { last_active_at: base - 15 * DAY });
    addThread(store, 'edge', { last_active_at: base - 14 * DAY });
    addThread(store, 'fresh', { last_active_at: base - 13 * DAY });
    addThread(store, 'archived-stale', {
      status: 'archived',
      last_active_at: base - 30 * DAY,
    });

    assert.equal(THREAD_IDLE_DAYS, 14);
    // now 支持毫秒时间戳
    const frozen = freezeIdleThreads(store, base * 1000);
    assert.equal(frozen, 1);
    assert.equal(store.getThread('stale').status, 'archived');
    assert.equal(store.getThread('edge').status, 'active');
    assert.equal(store.getThread('fresh').status, 'active');

    // 幂等：第二次没有可冻结的行
    assert.equal(freezeIdleThreads(store, base * 1000), 0);
    // now 支持秒与 Date
    assert.equal(freezeIdleThreads(store, base), 0);
    assert.equal(freezeIdleThreads(store, new Date(base * 1000)), 0);
  } finally {
    store.close();
  }
});

test('freezeIdleThreads：idleDays 可配置，非法参数抛错', () => {
  const store = makeStore();
  const base = 1_700_000_000;
  try {
    addThread(store, 'one-day', { last_active_at: base - 2 * DAY });
    assert.equal(freezeIdleThreads(store, base * 1000, 3), 0);
    assert.equal(freezeIdleThreads(store, base * 1000, 1), 1);
    assert.equal(store.getThread('one-day').status, 'archived');
    assert.throws(() => freezeIdleThreads(store, base * 1000, -1), /idleDays/);
    assert.throws(() => freezeIdleThreads(null, base), /store/);
  } finally {
    store.close();
  }
});
