/**
 * V4-M1 召回词法门槛与短查询配置化（v0.4.5）。
 *
 * 背景：v0.4.4 的召回相关性门槛只看「是否命中任意一个 bigram」，而
 * 「今天/我们/一下/什么」这类功能词 bigram 几乎出现在任何自然句里，于是
 * 「今天怎么样」也能把无关事实带进注入；同时 MIN_QUERY_CHARS=4 写死，
 * 「蓝鲸」「生日」「吃药没」这类 2-3 字中文实体查询被整条跳过。
 *
 * 本文件锁住 V4-M1 的语义：
 *   1) 查询门长度默认 2（recall.minQueryChars 可配置），2-3 字实体可召回；
 *      「1+1」等算术/问候词仍然不读库。
 *   2) 词法命中要「够相关」：≥2 个不同有效 bigram，或命中比例 ≥30%；
 *      停用 bigram（今天/我们/一下/什么/怎么…）不计入命中。
 *   3) 纯停用词查询没有任何有效 bigram → 不注入。
 *   4) 混合库（52 条事实、含相似实体）里不会因为相似实体互相带出无关事实。
 *
 * 约束：只用内存库，不联网、不读真实时钟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { DEFAULTS, normalizeRecall } from '../src/config.js';
import {
  MIN_QUERY_CHARS,
  contentQueryBigrams,
  retrieve,
} from '../src/memory/retrieve.js';
import { TEST_NOW } from './e2e/helpers.js';

const AT = Math.floor(TEST_NOW / 1000);

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function insert(store, fields) {
  return store.insertFact({
    kind: 'knowledge',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
    ...fields,
  });
}

/**
 * 52 条事实的混合库：三个实体簇（蓝鲸 / 生日 / 吃药）＋ 46 条无关记录。
 * 相似实体的目的是：只命中一个 bigram 时不能把簇里的无关成员带出来。
 * @param {Store} store
 */
function seedMixedLibrary(store) {
  const blue = insert(store, {
    kind: 'knowledge',
    subject_text: '蓝鲸',
    predicate: '含义',
    object_text: '一种海洋哺乳动物',
    statement: '蓝鲸是一种海洋哺乳动物。',
  });
  const blueProject = insert(store, {
    kind: 'project',
    subject_text: '蓝鲸计划',
    predicate: '状态',
    object_text: '下月启动',
    statement: '蓝鲸计划下个月启动。',
  });
  const blueFish = insert(store, {
    kind: 'knowledge',
    subject_text: '蓝鲸鱼',
    predicate: '别名',
    object_text: '小蓝鲸',
    statement: '蓝鲸鱼也被叫作小蓝鲸。',
  });
  const birthday = insert(store, {
    kind: 'relation',
    subject_text: '妈妈',
    predicate: '生日',
    object_text: '五月三日',
    statement: '妈妈的生日是五月三日。',
  });
  const birthdayParty = insert(store, {
    kind: 'other',
    subject_text: '生日会',
    predicate: '地点',
    object_text: '家里',
    statement: '今年的生日会在家里办。',
  });
  const medicine = insert(store, {
    kind: 'other',
    subject_text: '吃药',
    predicate: '提醒',
    object_text: '晚饭后',
    statement: '记得吃药没，晚饭后吃。',
  });
  // 46 条 filler：词语与上面的查询不重叠，保证不是词法命中来源。
  for (let i = 0; i < 46; i += 1) {
    insert(store, {
      kind: 'other',
      subject_text: `档案${i}`,
      predicate: '备注',
      object_text: `第${i}条`,
      statement: `档案编号${i}的备注是第${i}条流水。`,
    });
  }
  return { blue, blueProject, blueFish, birthday, birthdayParty, medicine };
}

test('V4-M1 混合库（52 条）：算术/纯停用词查询不注入也不读库', async (t) => {
  const store = openStore(t);
  seedMixedLibrary(store);
  assert.equal(store.listFacts({ scope: 'main', limit: 100 }).length, 52);

  const originalSearch = store.searchBigram;
  let searchCalls = 0;
  store.searchBigram = (...args) => {
    searchCalls += 1;
    return originalSearch.apply(store, args);
  };
  try {
    for (const query of ['1+1', '12 * 3 = ?', '今天怎么样', '我们什么时候可以', '？？']) {
      const result = await retrieve({ store, query, now: TEST_NOW });
      assert.deepEqual(result.items, [], `${JSON.stringify(query)} 不应注入任何记忆`);
      assert.deepEqual(result.usedIds, []);
      assert.equal(result.tokens, 0);
    }
    assert.equal(searchCalls, 0, '查询门/空词法应在读库之前生效');
  } finally {
    store.searchBigram = originalSearch;
  }
});

test('V4-M1 2-3 字实体查询可命中（蓝鲸/生日/吃药没）', async (t) => {
  const store = openStore(t);
  const { blue, blueProject, blueFish, birthday, birthdayParty, medicine } = seedMixedLibrary(store);

  const blueHits = await retrieve({ store, query: '蓝鲸', now: TEST_NOW });
  const blueIds = blueHits.items.map((item) => item.id);
  assert.ok(blueIds.includes(blue.id), '「蓝鲸」应命中蓝鲸事实');
  assert.ok(blueIds.includes(blueProject.id), '同簇事实也可命中');
  assert.ok(blueIds.includes(blueFish.id), '同簇事实也可命中');
  assert.equal(blueIds.length, 3, '不应带出同簇以外的事实');

  const birthdayHits = await retrieve({ store, query: '生日', now: TEST_NOW });
  const birthdayIds = birthdayHits.items.map((item) => item.id);
  assert.ok(birthdayIds.includes(birthday.id), '「生日」应命中妈妈生日事实');
  assert.ok(birthdayIds.includes(birthdayParty.id));
  assert.equal(birthdayIds.length, 2);

  const medicineHits = await retrieve({ store, query: '吃药没', now: TEST_NOW });
  assert.ok(
    medicineHits.items.some((item) => item.id === medicine.id),
    '「吃药没」应命中吃药提醒',
  );
});

test('V4-M1 词法门槛：1 个 bigram 只在命中比例 ≥30% 时放行', async (t) => {
  const store = openStore(t);
  const { blue } = seedMixedLibrary(store);

  // 3 个有效 bigram 里命中 1 个 = 33.3% ≥30%，放行。
  const pass = await retrieve({ store, query: '蓝鲸 苹果 香蕉', now: TEST_NOW });
  assert.ok(pass.items.some((item) => item.id === blue.id), '1/3 命中应过门');

  // 4 个有效 bigram 里命中 1 个 = 25% <30%，且不足 2 个不同 bigram，丢弃。
  const fail = await retrieve({ store, query: '蓝鲸 苹果 香蕉 橘子', now: TEST_NOW });
  assert.deepEqual(fail.items, [], '1/4 命中不应过门');
});

test('V4-M1 停用 bigram 不计入命中：今天/我们/一下/什么 不提供证据', async (t) => {
  const store = openStore(t);
  seedMixedLibrary(store);
  // 停用 bigram 覆盖的跨词 bigram（如「天怎」「么样」）同样被剔除。
  for (const query of ['今天', '我们', '一下', '什么', '怎么', '今天怎么样', '这个那个']) {
    assert.deepEqual(contentQueryBigrams(query), [], `${JSON.stringify(query)} 应没有有效 bigram`);
    const result = await retrieve({ store, query, now: TEST_NOW });
    assert.deepEqual(result.items, [], `${JSON.stringify(query)} 不应注入`);
  }
  // 有效内容词保留，停用词不进入分母。
  // 「是什」「么动」被停用 bigram 覆盖；「鲸是」不与停用词重叠，保留在分母里。
  assert.deepEqual(contentQueryBigrams('蓝鲸是什么动物'), ['蓝鲸', '鲸是', '动物']);
  assert.deepEqual(contentQueryBigrams('蓝鲸'), ['蓝鲸']);
  // 拉丁停用词按整 token 剔除。
  assert.deepEqual(contentQueryBigrams('what is the plan'), ['plan']);
});

test('V4-M1 minQueryChars：默认 2，可配置，非法值拒绝', async (t) => {
  const store = openStore(t);
  const { birthday } = seedMixedLibrary(store);

  assert.equal(MIN_QUERY_CHARS, 2);
  assert.equal(normalizeRecall(undefined).minQueryChars, 2);
  assert.equal(normalizeRecall({ minQueryChars: 3 }).minQueryChars, 3);
  for (const bad of [0, -1, 1.5, 65, '2', null, Number.NaN]) {
    assert.throws(() => normalizeRecall({ minQueryChars: bad }), /recall\.minQueryChars/);
  }
  assert.equal(Object.keys(DEFAULTS).length, 16, '安装面仍应保持 16 键');

  // 默认门槛下 2 字实体可召回。
  const defaults = await retrieve({ store, query: '生日', now: TEST_NOW });
  assert.ok(defaults.items.some((item) => item.id === birthday.id));
  // 收紧到 4 后同一查询被查询门跳过，且不读库。
  const originalSearch = store.searchBigram;
  let searchCalls = 0;
  store.searchBigram = (...args) => {
    searchCalls += 1;
    return originalSearch.apply(store, args);
  };
  try {
    const strict = await retrieve({
      store,
      query: '生日',
      now: TEST_NOW,
      recall: { minQueryChars: 4 },
    });
    assert.deepEqual(strict.items, []);
    assert.equal(searchCalls, 0, '收紧后的查询门应在读库之前生效');
  } finally {
    store.searchBigram = originalSearch;
  }
});
