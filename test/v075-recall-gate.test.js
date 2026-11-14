/**
 * 召回候选门的两轮修正：
 *
 * V74-H1（v0.7.5）：分母回退 + 稀有锚点放行。
 * 回放（50 句真实正文，向量关）：v0.7.3 注入 33 条 / 9 句，v0.7.4 注入 128 条 /
 * 25 句，新增 95 条里 67% 无关。原因是分母改成「库里存在的 bigram」后，小库
 * （~143 条）里 presentTokens 常只有 1–2 个，含它们的条目全部 ≥30% 过门。
 * v0.7.5 的做法：分母回到「查询有效 bigram 数」；只给「稀有且不含功能字」的
 * 单命中 bigram 开一个口子（df ≤ 2、不含我/你/的/了…、拉丁 ≥3 字符），
 * 每次查询最多放行 2 条。
 *
 * V75-H1（v0.7.6）：这个口子只对「问回忆」的查询开——否则「这是一个网关文档」
 * 这类陈述句也会因为撞上一个稀有 bigram 而放行。判定见 RECALL_INTENT_RE。
 *
 * 注：命中数/命中比例门（V4-M1）是另一条路径，与稀有锚点无关；本文件只断言
 * 稀有锚点的开/关与放行上限，不去替 V4-M1 定行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { retrieve, RECALL_INTENT_RE } from '../src/memory/retrieve.js';
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

async function recall(store, query, options = {}) {
  return retrieve({ store, query, now: TEST_NOW, vector: NO_VECTOR, ...options });
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
    assert.equal(result.recallIntent, true, `${query} 应判成回忆意图`);
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
  // 查询用空格分隔，保证分母固定为 4 个有效 bigram（咖啡/桌子/椅子/窗户），
  // 命中只有「咖啡」1 个 → 25% 过不了比例门，只剩稀有锚点这一条路。
  const query = '记得 咖啡 桌子 椅子 窗户';

  const dense = openStore(t);
  addEpisode(dense, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(dense, '咖啡二', '用户下午又喝咖啡。');
  addEpisode(dense, '咖啡三', '用户在咖啡店等人。');
  const blocked = await recall(dense, query);
  assert.equal(blocked.recallIntent, true);
  assert.deepEqual(blocked.items, [], 'df=3 的单命中 bigram 不应放行');
  assert.equal(blocked.rareAnchorPasses, 0);

  const sparse = openStore(t);
  addEpisode(sparse, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(sparse, '咖啡二', '用户下午又喝咖啡。');
  const passed = await recall(sparse, query);
  assert.ok(passed.items.length >= 1, 'df=2 的单命中 bigram 应放行');
  assert.ok(passed.items.length <= 2, '稀有锚点每次最多放行 2 条');
  assert.ok(passed.rareAnchorPasses >= 1);
});

test('v0.7.5 跨词碎片含功能字时不当锚点（我夜/吃了）', async (t) => {
  const store = openStore(t);
  addEpisode(store, '夜间值班', '用户我夜间值班到很晚。');
  addEpisode(store, '晚饭', '用户吃了面条当晚饭。');
  const result = await recall(store, '记得 夜宵 桌子 椅子 窗户');
  assert.deepEqual(result.items, [], '含功能字的碎片不应放行');
  assert.equal(result.rareAnchorPasses, 0);
});

test('v0.7.5 稀有锚点条数上限：多个稀有 bigram 同时命中时最多 2 条', async (t) => {
  const store = openStore(t);
  addEpisode(store, '夜宵一', '用户在夜宵摊吃烧烤。');
  addEpisode(store, '夜宵二', '用户昨晚夜宵吃了饺子。');
  addEpisode(store, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(store, '咖啡二', '用户下午又喝咖啡。');
  // 分母 5 个有效 bigram，两组候选各命中 1 个（20%），全部靠稀有锚点放行。
  const result = await recall(store, '记得 夜宵 咖啡 桌子 椅子');
  assert.equal(result.recallIntent, true);
  assert.ok(result.items.length <= 2, `应 ≤2 条，实际 ${result.items.length}`);
  assert.equal(result.rareAnchorPasses, 2);
});

test('V75-H1 无回忆意图时不开稀有锚点', async (t) => {
  const store = openStore(t);
  addEpisode(store, '夜宵一', '用户在夜宵摊吃烧烤。');
  addEpisode(store, '夜宵二', '用户昨晚夜宵吃了饺子。');

  const plain = await recall(store, '夜宵 桌子 椅子 窗户');
  assert.equal(plain.recallIntent, false);
  assert.equal(plain.rareAnchorPasses, 0);
  assert.deepEqual(plain.items, [], '没有回忆意图时，单命中稀有 bigram 也不应放行');

  const asked = await recall(store, '记得 夜宵 桌子 椅子 窗户');
  assert.equal(asked.recallIntent, true);
  assert.ok(asked.items.length >= 1, '带回忆意图时应能召回');
});

test('V75-H1 回放的三句非回忆陈述不被判成回忆意图', async (t) => {
  const store = openStore(t);
  // 每句都配一条含其稀有 bigram 的干扰条目（回放里正是这样被放行的）。
  addEpisode(store, '网关文档', '用户在网关文档里补了超时说明。');
  addEpisode(store, '改好', '用户说改好之后要回归一遍。');
  addEpisode(store, '一夜', '用户熬了一夜改代码。');

  const statements = [
    '这是一个网关文档，你帮我把它做成一个skill',
    '好了、已经开始改了、应该明早就能改好了',
    '没有改一夜啦，早上起来继续改',
  ];
  for (const query of statements) {
    const result = await recall(store, query);
    assert.equal(result.recallIntent, false, `${query} 不应被判成回忆意图`);
    assert.equal(result.rareAnchorPasses, 0, `${query} 不应放行稀有锚点`);
  }
  // 判定口径单测：回忆意图只认明确的回忆措辞，不认陈述句。
  assert.equal(RECALL_INTENT_RE.test('这是一个网关文档，你帮我把它做成一个skill'), false);
  assert.equal(RECALL_INTENT_RE.test('好了、已经开始改了、应该明早就能改好了'), false);
  assert.equal(RECALL_INTENT_RE.test('没有改一夜啦，早上起来继续改'), false);
  assert.equal(RECALL_INTENT_RE.test('你还记得我夜宵吃了什么吗'), true);
  assert.equal(RECALL_INTENT_RE.test('我上回说的那个项目叫啥来着'), true);
});

test('V75-L1 limit=1 时 df=3 的 bigram 仍能数到 3（不被搜索上限截断）', async (t) => {
  const store = openStore(t);
  addEpisode(store, '咖啡一', '用户早上一杯咖啡。');
  addEpisode(store, '咖啡二', '用户下午又喝咖啡。');
  addEpisode(store, '咖啡三', '用户在咖啡店等人。');
  const result = await recall(store, '记得 咖啡 桌子 椅子 窗户', { limit: 1 });
  assert.equal(result.recallIntent, true);
  assert.equal(result.rareAnchorPasses, 0, 'df=3 不应按稀有锚点放行');
  assert.deepEqual(result.items, []);
});
