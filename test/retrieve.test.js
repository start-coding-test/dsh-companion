import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import {
  DEFAULT_BUDGET_TOKENS,
  fidelityOf,
  forgettingCurve,
  renderItem,
  retrieve,
} from '../src/memory/retrieve.js';

const DAY_MS = 86_400_000;
const DAY_SEC = 86_400;
const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** @param {number} days @returns {number} Unix 秒 */
function daysAgo(days) {
  return NOW_SEC - Math.round(days * DAY_SEC);
}

/**
 * 每个测试用独立临时库，避免用例之间互相污染。
 * @param {(store: Store) => Promise<void>} fn
 */
async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-retrieve-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {Store} store @param {object} [overrides] @returns {object} */
function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '妈妈',
    predicate: '生日',
    object_text: '五月',
    statement: '我妈生日是五月',
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: daysAgo(1),
    last_reinforced_at: daysAgo(1),
    ...overrides,
  });
}

/** @param {Store} store @param {object} [overrides] @returns {object} */
function addEpisode(store, overrides = {}) {
  return store.insertEpisode({
    scope: 'main',
    session_id: 'session-1',
    title: '周末聊天',
    summary: '周末和妈妈聊了生日安排。她提到想一起吃饭。',
    evidence: '她说：今年生日想简单过',
    topics: ['生日', '家人'],
    salience: 'normal',
    started_at: daysAgo(1),
    last_reinforced_at: daysAgo(1),
    ...overrides,
  });
}

test('forgettingCurve：pinned 恒 1，按天指数衰减，非法强度为 0', () => {
  assert.equal(
    forgettingCurve({ strengthDays: null, lastAt: daysAgo(500), now: NOW_MS, pinned: true }),
    1,
  );

  const expected = Math.exp(-0.5);
  const fromMs = forgettingCurve({
    strengthDays: 14,
    lastAt: NOW_MS - 7 * DAY_MS,
    now: NOW_MS,
  });
  assert.ok(Math.abs(fromMs - expected) < 1e-12);

  // 秒/毫秒输入应得到同一个 R。
  const fromSeconds = forgettingCurve({
    strengthDays: 14,
    lastAt: NOW_SEC - 7 * DAY_SEC,
    now: NOW_SEC,
  });
  assert.ok(Math.abs(fromSeconds - expected) < 1e-12);

  assert.equal(forgettingCurve({ strengthDays: 0, lastAt: daysAgo(1), now: NOW_MS }), 0);
  assert.equal(forgettingCurve({ strengthDays: -3, lastAt: daysAgo(1), now: NOW_MS }), 0);
  assert.equal(forgettingCurve({ lastAt: daysAgo(1), now: NOW_MS }), 0);
  assert.equal(forgettingCurve({ strengthDays: 14, lastAt: null, now: NOW_MS }), 0);
});

test('fidelityOf：四档边界', () => {
  assert.equal(fidelityOf(1), 'full');
  assert.equal(fidelityOf(0.5), 'full');
  assert.equal(fidelityOf(0.4999), 'gist');
  assert.equal(fidelityOf(0.2), 'gist');
  assert.equal(fidelityOf(0.1999), 'index');
  assert.equal(fidelityOf(0.05), 'index');
  assert.equal(fidelityOf(0.0499), 'dormant');
  assert.equal(fidelityOf(Number.NaN), 'dormant');
});

test('renderItem：四档渲染', () => {
  const fact = {
    id: 'fact-1',
    statement: '第一句。第二句。第三句。',
    source_excerpt: '她亲口说的',
    observed_at: Date.UTC(2026, 0, 3) / 1000,
  };
  assert.equal(renderItem(fact, 'full'), '第一句。第二句。第三句。');
  assert.equal(renderItem(fact, 'gist'), '第一句。第二句。「她亲口说的」');
  assert.equal(renderItem(fact, 'index'), '[2026-01-03] 第一句。');
  assert.equal(renderItem(fact, 'dormant'), null);

  const episode = {
    id: 'ep-1',
    title: '周末聊天',
    summary: '和妈妈聊了生日。她说过想一起吃饭。还提到蛋糕。',
    evidence: '今年生日想简单过'.repeat(20),
    started_at: Date.UTC(2026, 0, 4) / 1000,
  };
  const gist = renderItem(episode, 'gist');
  assert.ok(gist.startsWith('和妈妈聊了生日。她说过想一起吃饭。'));
  assert.ok(gist.includes('「'));
  assert.ok(!gist.includes('还提到蛋糕'));
  const quoted = gist.slice(gist.indexOf('「') + 1, gist.lastIndexOf('」'));
  assert.ok([...quoted].length <= 120);

  const episodeIndex = renderItem(episode, 'index');
  assert.equal(episodeIndex, '[2026-01-04] 周末聊天');
});

test('retrieve：score 降序、pinned 优先、R 与档位正确', async () => {
  await withStore(async (store) => {
    const pinned = addFact(store, {
      statement: '我的生日是五月一日',
      salience: 'pinned',
      observed_at: daysAgo(500),
      last_reinforced_at: daysAgo(500),
    });
    const fresh = addFact(store, {
      statement: '我妈生日是五月',
      last_reinforced_at: daysAgo(1),
    });
    const gist = addFact(store, {
      statement: '生日聚会定在周日',
      last_reinforced_at: daysAgo(17),
      observed_at: daysAgo(17),
    });
    const index = addFact(store, {
      statement: '生日卡片已经寄出',
      last_reinforced_at: daysAgo(33),
      observed_at: daysAgo(33),
    });
    addFact(store, {
      statement: '生日愿望不能说',
      last_reinforced_at: daysAgo(60),
      observed_at: daysAgo(60),
    });

    const result = await retrieve({ store, query: '生日是五月', now: NOW_MS });
    assert.equal(result.items.length, 4);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.items.map((item) => item.id), [
      pinned.id, fresh.id, gist.id, index.id,
    ]);

    for (let i = 1; i < result.items.length; i += 1) {
      assert.ok(result.items[i - 1].score >= result.items[i].score);
    }
    assert.equal(result.items[0].R, 1);
    assert.ok(Math.abs(result.items[0].score - 1) < 1e-12);
    assert.deepEqual(result.items.map((item) => item.fidelity), [
      'full', 'full', 'gist', 'index',
    ]);
    assert.deepEqual(result.usedIds, result.items.map((item) => item.id));
  });
});

test('retrieve：dormant 与 deleted 行不返回', async () => {
  await withStore(async (store) => {
    const active = addFact(store, {
      statement: '旧事重提的结论记在这里',
      subject_text: '旧事',
      predicate: '结论',
      last_reinforced_at: daysAgo(1),
    });
    const dormant = addFact(store, {
      statement: '旧事重提的草稿',
      subject_text: '旧事',
      predicate: '草稿',
      strength_days: 3,
      last_reinforced_at: daysAgo(100),
      observed_at: daysAgo(100),
    });
    const deleted = addFact(store, {
      statement: '旧事重提的废弃版本',
      subject_text: '旧事',
      predicate: '废弃',
      last_reinforced_at: daysAgo(1),
    });
    store.deleteFact(deleted.id);

    const result = await retrieve({ store, query: '旧事重提', now: NOW_MS });
    assert.deepEqual(result.usedIds, [active.id]);
    assert.ok(!result.items.some((item) => item.id === dormant.id));
    assert.ok(!result.items.some((item) => item.id === deleted.id));
  });
});

test('retrieve：scope 隔离（main 与 thread:key）', async () => {
  await withStore(async (store) => {
    const mainFact = addFact(store, {
      statement: '主线程里的生日安排',
      observed_at: daysAgo(30),
      last_reinforced_at: daysAgo(30),
    });
    const threadFact = addFact(store, {
      scope: 'thread:work',
      statement: '工作线程里的生日安排',
      observed_at: daysAgo(30),
      last_reinforced_at: daysAgo(30),
    });

    const main = await retrieve({ store, query: '生日安排', scope: 'main', now: NOW_MS });
    assert.deepEqual(main.usedIds, [mainFact.id]);

    const thread = await retrieve({
      store, query: '生日安排', scope: 'thread:work', now: NOW_MS,
    });
    assert.deepEqual(thread.usedIds, [threadFact.id]);
  });
});

test('retrieve：gist/index 实际渲染（≤2 句 + 1 引、只留时间标题）', async () => {
  await withStore(async (store) => {
    const gist = addFact(store, {
      statement: '记忆测试第一句。记忆测试第二句。记忆测试第三句。',
      source_excerpt: '原话在此',
      last_reinforced_at: daysAgo(17),
      observed_at: daysAgo(17),
    });
    const index = addFact(store, {
      statement: '记忆测试旧日标题',
      last_reinforced_at: daysAgo(33),
      observed_at: daysAgo(33),
    });

    const result = await retrieve({ store, query: '记忆测试', now: NOW_MS });
    const gistItem = result.items.find((item) => item.id === gist.id);
    const indexItem = result.items.find((item) => item.id === index.id);

    assert.ok(gistItem);
    assert.equal(gistItem.fidelity, 'gist');
    assert.ok(gistItem.text.startsWith('记忆测试第一句。记忆测试第二句。'));
    assert.ok(gistItem.text.includes('「原话在此」'));
    assert.ok(!gistItem.text.includes('第三句'));

    assert.ok(indexItem);
    assert.equal(indexItem.fidelity, 'index');
    assert.match(indexItem.text, /^\[\d{4}-\d{2}-\d{2}\] /);
    assert.ok(indexItem.text.includes('记忆测试旧日标题'));
  });
});

test('retrieve：预算截断，tokens 不超预算且 truncated=true', async () => {
  await withStore(async (store) => {
    const statements = ['甲', '乙', '丙'].map(
      (suffix) => `预算截断测试${suffix}${'内'.repeat(23)}`,
    );
    const ids = statements.map((statement) => addFact(store, {
      statement,
      observed_at: daysAgo(30),
      last_reinforced_at: daysAgo(1),
    }).id);

    const tight = await retrieve({
      store, query: '预算截断', now: NOW_MS, budgetTokens: 25,
    });
    assert.equal(tight.items.length, 1);
    assert.equal(tight.tokens, 15);
    assert.equal(tight.truncated, true);
    assert.equal(tight.usedIds.length, 1);
    assert.ok(ids.includes(tight.usedIds[0]));

    const roomy = await retrieve({
      store, query: '预算截断', now: NOW_MS, budgetTokens: DEFAULT_BUDGET_TOKENS,
    });
    assert.equal(roomy.items.length, 3);
    assert.equal(roomy.tokens, 45);
    assert.equal(roomy.truncated, false);
  });
});

test('retrieve：空查询只回最近 7 天的 top3', async () => {
  await withStore(async (store) => {
    const recent = [
      addFact(store, { statement: '最近第一天', observed_at: daysAgo(1), last_reinforced_at: daysAgo(1) }),
      addFact(store, { statement: '最近第二天', observed_at: daysAgo(2), last_reinforced_at: daysAgo(2) }),
      addFact(store, { statement: '最近第三天', observed_at: daysAgo(3), last_reinforced_at: daysAgo(3) }),
    ];
    const old = addFact(store, {
      statement: '十天前的事',
      observed_at: daysAgo(10),
      last_reinforced_at: daysAgo(10),
    });

    const result = await retrieve({ store, query: '', now: NOW_MS });
    assert.equal(result.items.length, 3);
    assert.deepEqual(
      new Set(result.usedIds),
      new Set(recent.map((row) => row.id)),
    );
    assert.ok(!result.usedIds.includes(old.id));
    assert.equal(result.truncated, false);
  });
});

test('retrieve：查询无命中时不返回 recency 候选（V3-M3 相关性门槛）', async () => {
  await withStore(async (store) => {
    addFact(store, {
      statement: '完全无关的近期记录',
      observed_at: daysAgo(1),
      last_reinforced_at: daysAgo(1),
    });
    const result = await retrieve({ store, query: '今天天气如何', now: NOW_MS });
    assert.deepEqual(result.items, []);
    assert.equal(result.tokens, 0);
    assert.equal(result.truncated, false);
  });
});

test('retrieve：情景（episode）也参与召回与渲染', async () => {
  await withStore(async (store) => {
    const episode = addEpisode(store, {
      title: '生日计划',
      summary: '妈妈说生日想一起吃饭。她还提到蛋糕。',
      started_at: daysAgo(1),
      last_reinforced_at: daysAgo(1),
    });

    const result = await retrieve({ store, query: '生日计划', now: NOW_MS });
    const item = result.items.find((entry) => entry.id === episode.id);
    assert.ok(item);
    assert.equal(item.kind, 'episode');
    assert.equal(item.fidelity, 'full');
    assert.equal(item.text, '妈妈说生日想一起吃饭。她还提到蛋糕。');
  });
});

test('retrieve：默认预算常量为 2050', () => {
  assert.equal(DEFAULT_BUDGET_TOKENS, 2050);
});
