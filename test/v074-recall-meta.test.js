/**
 * V73-M1（v0.7.4）：回忆类长句不再被召回候选门挡掉。
 *
 * 现场（50041，vector.enabled=false）：查询「我上次跟你说我夜宵吃了什么你还记得吗」
 * 被切成 14 个有效 bigram，与「在夜宵和零食之间犹豫」只命中「夜宵」1 个，
 * 1/14 ≈ 7% < 30% 被 lexicalHitQualifies 丢弃；单查「夜宵」却能命中（0.8435）。
 *
 * 两个根因：
 *   1) STOP_BIGRAMS 缺回忆元语句（上次/记得/跟你说…）；
 *   2) 比例分母把库里根本不存在的跨词碎片（我夜、宵吃）也算进去。
 *
 * 约束：内存库、无向量（与现场一致）、不读真实时钟。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { TEST_NOW } from './e2e/helpers.js';

const AT = Math.floor(TEST_NOW / 1000);
/** 现场是 vector.enabled=false，词法门是唯一通道。 */
const NO_VECTOR = Object.freeze({ enabled: false, dim: 256, embedder: 'hash' });

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function addEpisode(store, title, summary) {
  return store.insertEpisode({
    scope: 'main',
    session_id: 'v074',
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

function addFact(store, { subjectText, statement, kind = 'preference' }) {
  return store.insertFact({
    scope: 'main',
    kind,
    subject_text: subjectText,
    predicate: '偏好',
    object_text: statement,
    statement,
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
  });
}

/** 10 条无关干扰：不含下面四类正例的关键词。 */
function addDistractors(store) {
  const rows = [
    ['周末采购', '用户周末去超市买了洗衣液和纸巾。'],
    ['会议调整', '例会改到周三下午三点，会议室在三层。'],
    ['出行安排', '下个月去杭州出差，车票已经订好。'],
    ['报修空调', '办公室空调坏了，物业说周四来修。'],
    ['还书', '借的图书馆书周二到期，需要还掉。'],
    ['体检预约', '体检预约在周五上午，记得空腹。'],
    ['宠物驱虫', '猫的驱虫药还剩两次，月底前用完。'],
    ['账单单据', '水电账单已缴，纸质单据放在抽屉。'],
    ['快递代收', '快递放在门口代收点，取件码 4321。'],
    ['课程报名', '想报的课程下周一开放报名。'],
  ];
  return rows.map(([title, summary]) => addEpisode(store, title, summary));
}

async function recall(store, query) {
  return retrieve({ store, query, now: TEST_NOW, vector: NO_VECTOR });
}

function seed(store) {
  const snack = addEpisode(store, '夜宵的选择', '用户在夜宵和零食之间犹豫。');
  const coffee = addFact(store, {
    subjectText: '饮品偏好',
    statement: '用户喜欢喝冰美式，不加糖。',
  });
  const birthday = addEpisode(store, '妈妈生日', '用户妈妈生日是 3 月 12 日。');
  const project = addFact(store, {
    subjectText: '项目代号',
    statement: '用户在做的项目代号青柠。',
    kind: 'project',
  });
  const distractors = addDistractors(store);
  return { snack, coffee, birthday, project, distractors };
}

test('V73-M1 长句「我上次跟你说我夜宵吃了什么你还记得吗」召回夜宵 episode', async (t) => {
  const store = openStore(t);
  const { snack } = seed(store);
  const result = await recall(store, '我上次跟你说我夜宵吃了什么你还记得吗');
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes(snack.id), `应召回夜宵 episode，实际：${JSON.stringify(ids)}`);
});

test('V73-M1 「你还记得我喜欢喝什么吗」召回饮品偏好', async (t) => {
  const store = openStore(t);
  const { coffee } = seed(store);
  const result = await recall(store, '你还记得我喜欢喝什么吗');
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes(coffee.id), `应召回饮品偏好，实际：${JSON.stringify(ids)}`);
});

test('V73-M1 「之前跟你提过我妈生日是哪天」召回生日', async (t) => {
  const store = openStore(t);
  const { birthday } = seed(store);
  const result = await recall(store, '之前跟你提过我妈生日是哪天');
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes(birthday.id), `应召回生日，实际：${JSON.stringify(ids)}`);
});

test('V73-M1 「我上回说的那个项目叫啥来着」召回项目代号', async (t) => {
  const store = openStore(t);
  const { project } = seed(store);
  const result = await recall(store, '我上回说的那个项目叫啥来着');
  const ids = result.items.map((item) => item.id);
  assert.ok(ids.includes(project.id), `应召回项目代号，实际：${JSON.stringify(ids)}`);
});

test('V73-M1 纯回忆元语句（全停用）不召回任何条', async (t) => {
  const store = openStore(t);
  seed(store);
  for (const query of ['你还记得吗', '我上次说的', '之前跟你说过']) {
    const result = await recall(store, query);
    assert.deepEqual(result.items, [], `${JSON.stringify(query)} 不应召回`);
  }
});

test('V73-M1 单命中稀有 bigram 仍放行（v0.7.5 起走稀有锚点，不再是 1/1）', async (t) => {
  const store = openStore(t);
  addEpisode(store, '带货直播', '董宇辉直播带货销量很高。');
  seed(store);
  const result = await recall(store, '你记得董宇辉直播卖什么吗');
  const ids = result.items.map((item) => item.id);
  // v0.7.5：分母回到查询有效 bigram 数（董宇/宇辉/辉直/直播/播卖 → 1/5 不过门），
  // 「直播」df=1 且不含功能字，走稀有锚点放行——单点稀有证据仍能召回，
  // 高频词（df>2）则被 RARE_ANCHOR_MAX_DF 挡住。
  assert.equal(ids.length, 1, `只应召回 1 条，实际：${JSON.stringify(ids)}`);
});
