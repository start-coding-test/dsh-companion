/**
 * V74-H1（v0.7.5）：召回候选门的分母回退 + 稀有锚点放行。
 *
 * 回放（50 句真实正文，向量关）：v0.7.3 注入 33 条 / 9 句，v0.7.4 注入 128 条 /
 * 25 句，新增 95 条里 67% 无关。原因是分母改成「库里存在的 bigram」后，小库
 * （~143 条）里 presentTokens 常只有 1–2 个，含它们的条目全部 ≥30% 过门。
 *
 * v0.7.5 的做法：分母回到「查询有效 bigram 数」；只给「稀有且不含功能字」的
 * 单命中 bigram 开一个口子（df ≤ 2、不含我/你/的/了…、拉丁 ≥3 字符），
 * 每次查询最多放行 2 条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { TEST_NOW } from './e2e/helpers.js';

const AT = Math.floor(TEST_NOW / 1000);
const NO_VECTOR = Object.freeze({ enabled: false, dim: 256, embedder: 'hash' });

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function addEpisode(store, title, summary) {
  return store.insertEpisode({
    scope: 'main',
    session_id: 'v075',
    started_at: AT,
    ended_at: AT,
    title,
    summary,
    evidence: summary,
    topics: [],
    salience: 'normal',
    last_reinforced_at: AT,
    fidelity: 'full',
  });
}

async function recall(store, query) {
  return retrieve({ store, query, now: TEST_NOW, vector: NO_VECTOR });
}

test('v0.7.5 四个现场正例仍能召回（靠稀有锚点或原比例门）', async (t) => {
  const store = openStore(t);
  const snack = addEpisode(store, '夜宵的选择', '用户在夜宵和零食之间犹豫。');
  const coffee = addEpisode(store, '饮品偏好', '用户喜欢喝冰美式，不加糖。');
  const birthday = addEpisode(store, '妈妈生日', '用户妈妈生日是 3 月 12 日。');
  const project = addEpisode(store, '项目代号', '用户在做的项目代号青柠。');
  // 少量干扰，保持小库（与现场 ~143 条同量级不必要，10 条足够）。
  addEpisode(store, '周末采购', '用户周末去超市买了洗衣液和纸巾。');
  addEpisode(store, '会议调整', '例会改到周三下午三点。');
  addEpisode(store, '报修空调', '办公室空调坏了，物业周四来修。');
  addEpisode(store, '还书', '借的图书馆书周二到期。');
  addEpisode(store, '体检预约', '体检预约在周五上午，记得空腹。');
  addEpisode(store, '快递代收', '快递放在门口代收点。');

  const cases = [
    ['我上次跟你说我夜宵吃了什么你还记得吗', snack],
    ['你还记得我喜欢喝什么吗', coffee],
    ['之前跟你提过我妈生日是哪天', birthday],
    ['我上回说的那个项目叫啥来着', project],
  ];
  for (const [query, row] of cases) {
    const result = await recall(store, query);
    const ids = result.items.map((item) => item.id);
    assert.ok(ids.includes(row.id), `${query} 应召回 ${row.id}，实际 ${JSON.stringify(ids)}`);
  }
});

test('v0.7.5 回放的三个长句各自最多注入 2 条', async (t) => {
  const store = openStore(t);
  // 10 条都含「用户」「会话」的条目（回放里正是这类高频词把门撑开）。
  for (let i = 0; i < 10; i += 1) {
    addEpisode(store, `会话记录 ${i}`, `用户在这次会话里提到了第 ${i} 件事。`);
  }

  const queries = [
    '还没有呢一会儿去吃饭',
    '要不要我带你打游戏',
    '用gpt-image-2.6-sunburst再画一张对比一下',
  ];
  for (const query of queries) {
    const result = await recall(store, query);
    assert.ok(result.items.length <= 2, `${query} 注入 ${result.items.length} 条，应 ≤2`);
  }
});

test('v0.7.5 稀有锚点按 df 判定：df=3 不放行，df=2 放行', async (t) => {
  const dense = openStore(t);
  addEpisode(dense, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(dense, '咖啡二', '用户下午又喝咖啡。');
  addEpisode(dense, '咖啡三', '用户在咖啡店等人。');
  const blocked = await recall(dense, '嗯我刚才说咖啡什么来着');
  assert.deepEqual(blocked.items, [], 'df=3 的单命中 bigram 不应放行');

  const sparse = openStore(t);
  addEpisode(sparse, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(sparse, '咖啡二', '用户下午又喝咖啡。');
  const passed = await recall(sparse, '嗯我刚才说咖啡什么来着');
  assert.ok(passed.items.length >= 1, 'df=2 的单命中 bigram 应放行');
  assert.ok(passed.items.length <= 2, '稀有锚点每次最多放行 2 条');
});

test('v0.7.5 跨词碎片含功能字时不当锚点（我夜/吃了）', async (t) => {
  const store = openStore(t);
  addEpisode(store, '夜间值班', '用户我夜间值班到很晚。');
  addEpisode(store, '晚饭', '用户吃了面条当晚饭。');
  const result = await recall(store, '我夜宵吃了什么');
  assert.deepEqual(result.items, [], '含功能字的碎片不应放行');
});

test('v0.7.5 稀有锚点条数上限：3 条同时命中同一稀有 bigram 时最多 2 条', async (t) => {
  const store = openStore(t);
  addEpisode(store, '夜宵一', '用户在夜宵摊吃烧烤。');
  addEpisode(store, '夜宵二', '用户昨晚夜宵吃了饺子。');
  addEpisode(store, '夜宵三', '用户夜宵喜欢喝豆浆。');
  const result = await recall(store, '我夜宵吃了什么');
  assert.ok(result.items.length <= 2, `应 ≤2 条，实际 ${result.items.length}`);
  assert.equal(result.rareAnchorPasses, Math.min(2, result.rareAnchorPasses));
});
