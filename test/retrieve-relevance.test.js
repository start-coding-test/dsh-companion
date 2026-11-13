/**
 * V3-M3 召回相关性门槛（v0.4.4）。
 *
 * 背景：v0.4.3 的打分是 0.6*rel + 0.4*R，R 高的事实即使 rel≈0 也能进前列；
 * hash 向量对任意查询都有非零余弦，于是问「1+1」也会注入 [相关记忆]，
 * 既浪费预算又污染 W5「注入→用上」统计。
 *
 * 本文件锁住四条语义：
 *   1) 候选门：非空查询的候选必须命中 FTS/bigram，或向量余弦 ≥
 *      recall.minVectorScore（默认 0.35）；两者都没有就丢弃。
 *   2) 查询门：长度 <4、纯算术/符号、常见问候词直接跳过（skipSmallTalk）。
 *   3) 过滤后为空时不返回任何项（调用方据此不注入、不写召回样本）。
 *   4) vectorHits 只数真正过门的向量命中，不因 hash 向量虚增。
 *
 * 约束：只用内存库，不联网、不读真实时钟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { ConfigError, DEFAULTS, normalizeConfig, normalizeRecall } from '../src/config.js';
import { MIN_QUERY_CHARS, isTrivialQuery, retrieve } from '../src/memory/retrieve.js';
import { TEST_NOW } from './e2e/helpers.js';

const AT = Math.floor(TEST_NOW / 1000);
const VECTOR_ON = Object.freeze({ enabled: true, dim: 256, embedder: 'hash' });

/** 一条「青柠计划代号」事实，向量投影由 Store 同步维护。 */
function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function addFact(store) {
  return store.insertFact({
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement: '青柠计划的代号是蓝鲸。',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
  });
}

// ---------------------------------------------------------------- 查询门

test('V4-M1 isTrivialQuery：短查询/纯算术/问候词/纯符号判为小聊，2 字实体放行', () => {
  assert.equal(MIN_QUERY_CHARS, 2);
  for (const query of ['hi', '你好', '1+1', '12 * 3 = ?', '？？', '  ', '\n\t', 'ok', 'Thanks!']) {
    assert.equal(isTrivialQuery(query), true, `${JSON.stringify(query)} 应被判为小聊查询`);
  }
  // V4-M1：中文 2 字实体（生日/蓝鲸）与 2-3 字短查询不再被长度门拦下。
  for (const query of ['生日', '蓝鲸', '吃药没', '青柠计划的代号是什么？', '项目代号', '明天要开会吗']) {
    assert.equal(isTrivialQuery(query), false, `${JSON.stringify(query)} 不应被判为小聊查询`);
  }
  // minChars 可配置：收紧后 2 字查询被拦下；放宽到 1 后单个 CJK 字也放行。
  assert.equal(isTrivialQuery('蓝鲸', { minChars: 3 }), true);
  assert.equal(isTrivialQuery('鲸', { minChars: 1 }), false);
});

test('V4-M1 查询门：问候/算术不召回也不读库，2 字实体查询可召回', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const originalSearch = store.searchBigram;
  let searchCalls = 0;
  store.searchBigram = (...args) => {
    searchCalls += 1;
    return originalSearch.apply(store, args);
  };
  try {
    for (const query of ['你好', '1+1', 'hi']) {
      const result = await retrieve({ store, query, now: TEST_NOW, vector: VECTOR_ON });
      assert.deepEqual(result.items, [], `${JSON.stringify(query)} 不应召回`);
      assert.deepEqual(result.usedIds, []);
      assert.equal(result.tokens, 0);
      assert.equal(result.truncated, false);
    }
    assert.equal(searchCalls, 0, '查询门应在读库之前生效');
    // V4-M1：2 字实体查询不再被查询门拦下，词法命中可召回。
    for (const query of ['蓝鲸', '青柠']) {
      const result = await retrieve({ store, query, now: TEST_NOW, vector: VECTOR_ON });
      assert.ok(
        result.items.some((item) => item.id === fact.id),
        `${JSON.stringify(query)} 应召回该事实`,
      );
    }
    assert.ok(searchCalls > 0);
    assert.ok(store.getFact(fact.id), '事实本身不应被动过');
  } finally {
    store.searchBigram = originalSearch;
  }
  // skipSmallTalk=false 时问候词也照常走召回。
  const kept = await retrieve({
    store,
    query: '蓝鲸',
    now: TEST_NOW,
    recall: { skipSmallTalk: false },
  });
  assert.ok(kept.items.some((item) => item.id === fact.id), '关闭 skipSmallTalk 后短查询应召回');
});

// ---------------------------------------------------------------- 候选门

test('V3-M3 无关查询返回空：hash 向量非零也不得注入', async (t) => {
  const store = openStore(t);
  addFact(store);
  // 这条查询与事实的 hash 余弦为 0.3024（< 0.35），旧行为会命中。
  const unrelated = await retrieve({
    store,
    query: '帮我写一首诗',
    now: TEST_NOW,
    vector: VECTOR_ON,
  });
  assert.deepEqual(unrelated.items, [], '低于 minVectorScore 的向量命中不应进结果');
  assert.equal(unrelated.vectorHits, 0);

  const noVector = await retrieve({ store, query: '今天天气怎么样', now: TEST_NOW });
  assert.deepEqual(noVector.items, [], '既无词法命中也无向量的查询必须返回空');
  assert.equal(noVector.tokens, 0);
});

test('V3-M3 相关查询保留：词法命中优先于向量阈值', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  for (const query of ['青柠计划的代号是什么？', '青柠计划', '项目代号']) {
    const result = await retrieve({ store, query, now: TEST_NOW });
    assert.ok(
      result.items.some((item) => item.id === fact.id),
      `${JSON.stringify(query)} 应召回该事实`,
    );
  }
  // 向量分数只有 0.2760（低于默认阈值），但词法命中已足以保留。
  const lexical = await retrieve({ store, query: '蓝鲸是什么动物', now: TEST_NOW, vector: VECTOR_ON });
  assert.ok(lexical.items.some((item) => item.id === fact.id), '词法命中不应被向量阈值连坐');
  assert.equal(lexical.vectorHits, 0, 'vectorHits 只数过阈值（≥0.35）的命中');
});

test('V3-M3 minVectorScore 边界：默认 0.35 正好卡在 0.3024 / 0.7135 之间', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);

  // 0.3024 < 0.35：默认丢弃；阈值降到 0.30 后保留（纯向量命中，无词法命中）。
  const below = await retrieve({ store, query: '帮我写一首诗', now: TEST_NOW, vector: VECTOR_ON });
  assert.deepEqual(below.items, []);
  const lowered = await retrieve({
    store,
    query: '帮我写一首诗',
    now: TEST_NOW,
    vector: VECTOR_ON,
    recall: { minVectorScore: 0.3 },
  });
  assert.ok(lowered.items.some((item) => item.id === fact.id), '阈值 0.30 时 0.3024 应过门');
  assert.equal(lowered.vectorHits, 1);

  // 阈值 1：连 0.7135 的相关查询也过不了向量门，但词法命中仍保留。
  const strict = await retrieve({
    store,
    query: '青柠计划的代号是什么？',
    now: TEST_NOW,
    vector: VECTOR_ON,
    recall: { minVectorScore: 1 },
  });
  assert.ok(strict.items.some((item) => item.id === fact.id), '词法命中不应被阈值 1 拦下');
  assert.equal(strict.vectorHits, 0, '没有向量达到 1，vectorHits 应为 0');

  // 纯向量路径下阈值 1 直接清空（把词法腿遮掉以隔离变量）。
  const originalSearch = store.searchBigram;
  store.searchBigram = () => [];
  try {
    const strictVectorOnly = await retrieve({
      store,
      query: '青柠计划的代号是什么？',
      now: TEST_NOW,
      vector: VECTOR_ON,
      recall: { minVectorScore: 1 },
    });
    assert.deepEqual(strictVectorOnly.items, []);
    const permissive = await retrieve({
      store,
      query: '青柠计划的代号是什么？',
      now: TEST_NOW,
      vector: VECTOR_ON,
      recall: { minVectorScore: Number.MIN_VALUE },
    });
    assert.ok(permissive.items.some((item) => item.id === fact.id), '阈值趋 0 时向量命中应保留');
    assert.equal(permissive.vectorHits, 1);
  } finally {
    store.searchBigram = originalSearch;
  }
});

test('V3-M3 minVectorScore=0：任何非零向量命中都算相关（边界语义）', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const result = await retrieve({
    store,
    query: '帮我写一首诗',
    now: TEST_NOW,
    vector: VECTOR_ON,
    recall: { minVectorScore: 0 },
  });
  assert.ok(result.items.some((item) => item.id === fact.id));
});

// ---------------------------------------------------------------- 配置

test('V4-M1 recall 配置：默认值、minQueryChars 覆盖、非法值抛 ConfigError', () => {
  assert.deepEqual(normalizeRecall(undefined), {
    minVectorScore: 0.35,
    skipSmallTalk: true,
    minQueryChars: 2,
    chatLimit: 1,
  });
  assert.deepEqual(normalizeRecall({}), {
    minVectorScore: 0.35,
    skipSmallTalk: true,
    minQueryChars: 2,
    chatLimit: 1,
  });
  assert.deepEqual(
    normalizeRecall({ minVectorScore: 0.5, skipSmallTalk: false, minQueryChars: 4 }),
    { minVectorScore: 0.5, skipSmallTalk: false, minQueryChars: 4, chatLimit: 1 },
  );
  // 0 与 1 都是合法边界。
  assert.equal(normalizeRecall({ minVectorScore: 0 }).minVectorScore, 0);
  assert.equal(normalizeRecall({ minVectorScore: 1 }).minVectorScore, 1);
  // minQueryChars 边界：1..64 的整数。
  assert.equal(normalizeRecall({ minQueryChars: 1 }).minQueryChars, 1);
  assert.equal(normalizeRecall({ minQueryChars: 64 }).minQueryChars, 64);

  for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
    assert.throws(
      () => normalizeRecall({ minVectorScore: bad }),
      (error) => error instanceof ConfigError && /minVectorScore/.test(error.field ?? ''),
      `minVectorScore=${String(bad)} 应抛 ConfigError`,
    );
  }
  for (const bad of [0, -1, 1.5, 65, Number.NaN, '2', null]) {
    assert.throws(
      () => normalizeRecall({ minQueryChars: bad }),
      (error) => error instanceof ConfigError && /minQueryChars/.test(error.field ?? ''),
      `minQueryChars=${String(bad)} 应抛 ConfigError`,
    );
  }
  // chatLimit（A8⑥）：0..5 整数，默认 1。
  assert.equal(normalizeRecall({ chatLimit: 0 }).chatLimit, 0);
  assert.equal(normalizeRecall({ chatLimit: 5 }).chatLimit, 5);
  for (const bad of [-1, 6, 1.5, Number.NaN, '1', null]) {
    assert.throws(
      () => normalizeRecall({ chatLimit: bad }),
      (error) => error instanceof ConfigError && /chatLimit/.test(error.field ?? ''),
      `chatLimit=${String(bad)} 应抛 ConfigError`,
    );
  }
  assert.throws(
    () => normalizeRecall({ skipSmallTalk: 'yes' }),
    (error) => error instanceof ConfigError && /skipSmallTalk/.test(error.field ?? ''),
  );
  assert.throws(
    () => normalizeRecall([]),
    (error) => error instanceof ConfigError && error.field === 'recall',
  );

  // 未知子键只 warning，不失败（与 vector 段同口径）。
  const warnings = [];
  normalizeRecall({ minVectorScore: 0.4, futureKey: true }, warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recall\.futureKey/);

  // 经 normalizeConfig 也生效；recall 与 vector 一样不进 DEFAULTS 的 16 键安装面。
  const cfg = normalizeConfig({ recall: { minVectorScore: 0.6, minQueryChars: 3 } });
  assert.equal(cfg.recall.minVectorScore, 0.6);
  assert.equal(cfg.recall.minQueryChars, 3);
  assert.equal(Object.keys(DEFAULTS).includes('recall'), false, 'recall 应是 DEFAULTS 的非枚举键');
  assert.equal(Object.keys(DEFAULTS).includes('vector'), false, 'vector 先例保持不变');
  assert.equal(Object.keys(DEFAULTS).length, 16, '安装面仍应保持 16 键');
});

test('V3-M3 retrieve 接受 config.recall，非法配置在检索时 fail-fast', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const viaConfig = await retrieve({
    store,
    query: '帮我写一首诗',
    now: TEST_NOW,
    vector: VECTOR_ON,
    config: { recall: { minVectorScore: 0.3 } },
  });
  assert.ok(viaConfig.items.some((item) => item.id === fact.id), 'config.recall 应被采纳');

  await assert.rejects(
    () => retrieve({ store, query: '青柠计划的代号是什么？', now: TEST_NOW, recall: { minVectorScore: 2 } }),
    (error) => error instanceof ConfigError,
  );
});

// ---------------------------------------------------------------- W5 统计

test('V3-M3 W5：过滤后为空不产生召回项，命中项才计入 recalls/vectorHits', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);

  // 过滤后为空：没有 items → 调用方（index.injectRecall）不注入、不写样本。
  const empty = await retrieve({ store, query: '帮我写一首诗', now: TEST_NOW, vector: VECTOR_ON });
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.usedIds, []);
  assert.equal(empty.vectorHits, 0);
  assert.equal(store.getFact(fact.id).first_reneed_at, null, '空结果不得写 W5 召回样本');

  // 命中项：vectorHits 与真实过门数一致，不因 hash 向量虚增。
  const hit = await retrieve({ store, query: '青柠计划的代号是什么？', now: TEST_NOW, vector: VECTOR_ON });
  assert.equal(hit.items.length, 1);
  assert.equal(hit.vectorHits, 1);
  assert.equal(hit.usedIds.length, 1, 'usedIds 只含真正返回的项');

  const lexicalOnly = await retrieve({ store, query: '蓝鲸是什么动物', now: TEST_NOW, vector: VECTOR_ON });
  assert.ok(lexicalOnly.items.length >= 1);
  assert.equal(lexicalOnly.vectorHits, 0, '未过向量阈值的候选不计入 vectorHits');
});

test('V3-M3 空查询仍保留 recency-only 通道（查询门不拦空查询）', async (t) => {
  const store = openStore(t);
  const fact = addFact(store);
  const result = await retrieve({ store, query: '', now: TEST_NOW });
  assert.ok(result.items.some((item) => item.id === fact.id), '空查询应走 recency 补位');
});
