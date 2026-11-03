/**
 * 用户命令测试（t11）：/记忆、/记忆 忘掉、/记忆 置顶、/成本、/线程、/状态。
 * 使用真实 Store（内存库）验证 SQL 聚合、S1 标记删除与置顶联动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00 UTC

function makeStore() {
  return Store.open(':memory:');
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

function run(store, text, extra = {}) {
  return handleCommand({ text, store, now: NOW_MS, ...extra });
}

test('非命令/未知命令返回 handled=false', () => {
  const store = makeStore();
  try {
    assert.deepEqual(run(store, '今天天气不错'), { handled: false, reply: '' });
    assert.deepEqual(run(store, '/不存在的命令'), { handled: false, reply: '' });
    assert.deepEqual(run(store, '/记忆 未知子命令'), { handled: false, reply: '' });
  } finally {
    store.close();
  }
});

test('/记忆：按 kind 计数并给出置顶数', () => {
  const store = makeStore();
  try {
    addFact(store, { kind: 'preference' });
    const identity = addFact(store, {
      kind: 'identity',
      subject_text: '我',
      predicate: '名字',
      object_text: '小林',
      statement: '我叫小林',
    });
    store.updateFact(identity.id, { salience: 'pinned', strength_days: null });

    const { handled, reply } = run(store, '/记忆');
    assert.equal(handled, true);
    assert.match(reply, /2 条事实/);
    assert.match(reply, /identity 1/);
    assert.match(reply, /preference 1/);
    assert.match(reply, /置顶 1 条/);
  } finally {
    store.close();
  }
});

test('/记忆 忘掉 <id>：调用 deleteFact 标记删除并提示 7 天', () => {
  const store = makeStore();
  try {
    const fact = addFact(store);
    const { handled, reply } = run(store, `/记忆 忘掉 ${fact.id}`);
    assert.equal(handled, true);
    assert.match(reply, /标记为遗忘/);
    assert.match(reply, /7 天后物理删除/);
    assert.ok(store.getFact(fact.id).deleted_at);
  } finally {
    store.close();
  }
});

test('/记忆 忘掉 <关键词>：只删除命中的事实', () => {
  const store = makeStore();
  try {
    const may = addFact(store, { statement: '我妈生日是五月', object_text: '五月' });
    const june = addFact(store, { statement: '我妈生日是六月', object_text: '六月' });
    const other = addFact(store, {
      kind: 'knowledge',
      subject_text: '我',
      predicate: '喜欢',
      object_text: '跑步',
      statement: '我喜欢跑步',
    });

    const { handled, reply } = run(store, '/记忆 忘掉 生日');
    assert.equal(handled, true);
    assert.match(reply, /已标记为遗忘/);
    assert.ok(store.getFact(may.id).deleted_at);
    assert.ok(store.getFact(june.id).deleted_at);
    assert.equal(store.getFact(other.id).deleted_at, null);
    assert.equal(store.searchBigram('生日').length, 0);
  } finally {
    store.close();
  }
});

test('/记忆 忘掉 无命中：给出没有找到的回复', () => {
  const store = makeStore();
  try {
    addFact(store);
    const { handled, reply } = run(store, '/记忆 忘掉 火星');
    assert.equal(handled, true);
    assert.match(reply, /没有找到可遗忘的事实/);
  } finally {
    store.close();
  }
});

test('/记忆 置顶与取消置顶：一次 updateFact 联动 salience/strength_days', () => {
  const store = makeStore();
  try {
    const fact = addFact(store);

    let result = run(store, `/记忆 置顶 ${fact.id}`);
    assert.equal(result.handled, true);
    assert.match(result.reply, /已置顶/);
    let row = store.getFact(fact.id);
    assert.equal(row.salience, 'pinned');
    assert.equal(row.strength_days, null);

    result = run(store, `/记忆 取消置顶 ${fact.id}`);
    assert.equal(result.handled, true);
    assert.match(result.reply, /已取消置顶/);
    row = store.getFact(fact.id);
    assert.equal(row.salience, 'explicit');
    assert.equal(row.strength_days, 365);
  } finally {
    store.close();
  }
});

test('/成本：今日与本月分别汇总 memory_events 的 token', () => {
  const store = makeStore();
  try {
    const todaySec = Math.floor(NOW_MS / 1000);
    const yesterdaySec = Math.floor(Date.UTC(2026, 10, 2, 12, 0, 0) / 1000);
    store.appendEvent({
      at: todaySec,
      action: 'ADD',
      actor: 'consolidator',
      table_name: 'consolidations',
      row_id: 'cs-today',
      detail_json: { tokensIn: 10, tokensOut: 5 },
    });
    store.appendEvent({
      at: yesterdaySec,
      action: 'ADD',
      actor: 'consolidator',
      table_name: 'consolidations',
      row_id: 'cs-month',
      detail_json: { tokens_in: 100, tokens_out: 50 },
    });

    const { handled, reply } = run(store, '/成本');
    assert.equal(handled, true);
    assert.match(reply, /今日 15 tokens/);
    assert.match(reply, /本月 165 tokens/);
    assert.match(reply, /入 110/);
    assert.match(reply, /出 55/);
  } finally {
    store.close();
  }
});

test('/线程：输出 key/状态/名称表格文本', () => {
  const store = makeStore();
  try {
    store.upsertThread({
      key: 'rent',
      name: '租房',
      session_id: 's-rent',
      description: '找房子',
      last_active_at: Math.floor(NOW_MS / 1000),
    });
    store.upsertThread({
      key: 'job',
      name: '换工作',
      session_id: 's-job',
      description: '准备面试',
      last_active_at: Math.floor(NOW_MS / 1000) - 60,
    });

    const { handled, reply } = run(store, '/线程');
    assert.equal(handled, true);
    assert.match(reply, /线程目录（2）/);
    assert.match(reply, /key \| 状态 \| 名称 \| 最后活跃/);
    assert.match(reply, /rent \| active \| 租房/);
    assert.match(reply, /job \| active \| 换工作/);
  } finally {
    store.close();
  }
});

test('/状态：各表计数、水位与最近 job', () => {
  const store = makeStore();
  try {
    addFact(store);
    store.insertConsolidation({
      id: 'cs-1',
      scope: 'main',
      session_id: 's-main',
      kind: 'nap',
      trigger: 'idle',
      upto_seq: 42,
      status: 'written',
      started_at: Math.floor(NOW_MS / 1000),
    });

    const { handled, reply } = run(store, '/状态');
    assert.equal(handled, true);
    assert.match(reply, /facts 1/);
    assert.match(reply, /水位 main：42/);
    assert.match(reply, /最近 job：nap written upto_seq=42/);
  } finally {
    store.close();
  }
});

test('缺少参数时返回用法而不是吞掉命令', () => {
  const store = makeStore();
  try {
    let result = run(store, '/记忆 忘掉');
    assert.equal(result.handled, true);
    assert.match(result.reply, /用法：\/记忆 忘掉/);

    result = run(store, '/记忆 置顶');
    assert.equal(result.handled, true);
    assert.match(result.reply, /用法：\/记忆 置顶/);
  } finally {
    store.close();
  }
});
