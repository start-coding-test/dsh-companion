/**
 * v0.4.10 V9-M1：episode 入库前对凭据值脱敏。
 *
 * 背景：V7-M3 只挡住了 facts 与状态板，consolidate 仍把 episode 的
 * title/summary/evidence/mood_evidence 原样写库，store 再投影到 fts_episodes，
 * 「路由器密码 蓝鲸-7788」这类值会随 episode 被召回、注入与导出。
 *
 * 覆盖：
 *   1. govern.redactSensitiveValues：密码/口令、凭据字段名、设备值、`sk-`、
 *      卡号只抹「值」，保留上下文；无命中原文返回、非字符串原样返回、幂等；
 *   2. 巩固提示词新增「不得复述凭据值」约束；
 *   3. consolidate 写库前逐字段脱敏 + 整段兜底，四字段、topics 与
 *      fts_episodes 都不含明文，敏感事实仍按 V7-M3 过滤；
 *   4. store.insertEpisode 防御性脱敏：绕过 consolidate 直接写也不落明文；
 *   5. 纯文本 episode 不被误改（四字段与列表一字不差）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED_CREDENTIAL, isSensitiveText, redactSensitiveValues,
} from '../src/memory/govern.js';
import { buildConsolidationPrompt, consolidate } from '../src/memory/consolidate.js';
import { Store } from '../src/memory/store.js';

const PASSWORD_VALUE = '蓝鲸-7788';

/** episodes 行里会落文本的列拼起来（四字段 + topics/entities）。 */
function episodeText(row) {
  return [
    row.title,
    row.summary,
    row.evidence,
    row.mood_evidence,
    row.topics_json,
    row.entities_json,
  ].filter((value) => typeof value === 'string').join('\n');
}

/** fts_episodes 的 bigram 投影原文。 */
function episodeFtsText(store) {
  return store.db.prepare('SELECT txt FROM fts_episodes').all()
    .map((row) => row.txt)
    .join('\n');
}

// ------------------------------------------------------- 值级脱敏

test('V9-M1：redactSensitiveValues 只抹凭据值，保留上下文', () => {
  const cases = [
    // 密码/口令 + 连接词或空白
    [`路由器密码 ${PASSWORD_VALUE}`, `路由器密码 ${REDACTED_CREDENTIAL}`],
    [`WiFi 密码是 ${PASSWORD_VALUE}`, `WiFi 密码是 ${REDACTED_CREDENTIAL}`],
    ['门禁密码为 8848', `门禁密码为 ${REDACTED_CREDENTIAL}`],
    ['口令：bluewhale', `口令：${REDACTED_CREDENTIAL}`],
    ['password is hunter2', `password is ${REDACTED_CREDENTIAL}`],
    // 凭据字段名 + 连接词
    ['token 是 abc123', `token 是 ${REDACTED_CREDENTIAL}`],
    ['API token：sk-abc123', `API token：${REDACTED_CREDENTIAL}`],
    ['access_token = tok_9f8e7d', `access_token = ${REDACTED_CREDENTIAL}`],
    // 设备/网络名词 + 判断词
    [`WiFi 是 ${PASSWORD_VALUE}`, `WiFi 是 ${REDACTED_CREDENTIAL}`],
    ['热点是 home-5G', `热点是 ${REDACTED_CREDENTIAL}`],
    // 卡号形态 / sk- 字面值没有上下文也要认出来
    ['卡号 6222 0202 0000 1234', `卡号 ${REDACTED_CREDENTIAL}`],
    ['账号 6222020200001234 已绑定', `账号 ${REDACTED_CREDENTIAL} 已绑定`],
    ['用 sk-proj9f8e7d6c5b 调用', `用 ${REDACTED_CREDENTIAL} 调用`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSensitiveValues(input), expected, `脱敏结果不符：${input}`);
  }
});

test('V9-M1：无命中原文返回、非字符串原样返回、幂等', () => {
  const untouched = [
    '用户问起密码学与 tokenizer。',
    '我昨天忘了密码。',
    '用户提到一个密码。',
    '周末去看展览',
    // V9-L1 收窄后的误报面：额度/银行提及/账单都不算凭据值。
    'token 额度 10B',
    '银行卡在招行',
    '信用卡账单已还',
    '',
  ];
  for (const text of untouched) {
    const out = redactSensitiveValues(text);
    assert.equal(out, text, `不应改动：${text}`);
  }
  // 非字符串直接透传（调用方可以无脑套用）。
  assert.equal(redactSensitiveValues(null), null);
  assert.equal(redactSensitiveValues(undefined), undefined);
  assert.equal(redactSensitiveValues(42), 42);
  // 幂等：对已脱敏文本再调用不叠加占位符。
  const once = redactSensitiveValues(`路由器密码 ${PASSWORD_VALUE}`);
  assert.equal(redactSensitiveValues(once), once);
  // 占位符本身不敏感：store 二次脱敏不会把它当凭据再判一次。
  assert.equal(isSensitiveText(REDACTED_CREDENTIAL), false);
});

// ------------------------------------------------------- 提示词约束

test('V9-M1：巩固提示词要求不复述凭据值', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    transcript: [{ role: 'user', text: '嗨' }],
  });
  assert.match(prompt, /不得复述密码、口令、token、卡号等凭据值/u);
  assert.match(prompt, /用户提到一个密码/u);
});

// ------------------------------------------------------- 巩固链路

/** 造一份 episode 四字段都带凭据的草稿。 */
function credentialEpisodeDraft() {
  return {
    episode: {
      title: `路由器密码 ${PASSWORD_VALUE}`,
      summary: `用户把家里路由器密码 ${PASSWORD_VALUE} 告诉了我，想让我记住。`,
      evidence: `用户原话：路由器密码 ${PASSWORD_VALUE}`,
      mood_evidence: `提到密码 ${PASSWORD_VALUE} 时语气有点紧张`,
      topics: ['网络', `路由器密码 ${PASSWORD_VALUE}`],
      entities: ['路由器'],
      mood: 'anxious',
      started_at: 1_700_000_000,
    },
    facts: [
      {
        kind: 'knowledge',
        subject_text: '路由器',
        predicate: '密码',
        object_text: PASSWORD_VALUE,
        statement: `路由器密码是 ${PASSWORD_VALUE}`,
      },
      {
        kind: 'other',
        subject_text: '用户',
        predicate: '住在',
        object_text: '朝阳区',
        statement: '用户住在朝阳区',
      },
    ],
  };
}

test('V9-M1：consolidate 写库前逐字段脱敏，episodes 与 fts_episodes 无明文', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 10,
    llm: async () => credentialEpisodeDraft(),
    now: 1_700_000_300,
    trigger: 'idle',
  });
  assert.equal(result.skipped, false);
  assert.ok(result.episodeId, 'episode 应落库并返回 id');

  const rows = store.listEpisodes({ scope: 'main' });
  assert.equal(rows.length, 1);
  const row = rows[0];

  // 四字段：值被抹掉，且整段仍命中 isSensitiveText 时兜底为占位符。
  for (const field of ['title', 'summary', 'evidence', 'mood_evidence']) {
    assert.equal(row[field], REDACTED_CREDENTIAL, `${field} 应整段兜底`);
  }
  // topics 逐项脱敏（fts_episodes 会投影 topics）。
  assert.deepEqual(JSON.parse(row.topics_json), ['网络', REDACTED_CREDENTIAL]);
  assert.deepEqual(JSON.parse(row.entities_json), ['路由器']);

  // episodes 四字段与列表、整行 JSON 都不含明文。
  assert.doesNotMatch(episodeText(row), /蓝鲸|7788/u);
  assert.doesNotMatch(JSON.stringify(row), /蓝鲸|7788/u);

  // fts_episodes（bigram 投影）同样不含明文；被脱敏的 episode 不能按凭据召回。
  assert.doesNotMatch(episodeFtsText(store), /蓝鲸|7788/u);
  assert.equal(
    store.searchBigram(PASSWORD_VALUE, {}).filter((hit) => hit.type === 'episode').length,
    0,
  );
  // 投影仍然活着：正常词还能召回 episode。
  assert.ok(store.searchBigram('网络', {}).some((hit) => hit.type === 'episode'));

  // facts 侧不受影响：敏感事实照旧过滤，普通事实照常落库。
  assert.equal(result.facts, 1);
  assert.equal(result.sensitive, 1);
  const facts = store.listFacts({ scope: 'main' });
  assert.deepEqual(facts.map((fact) => fact.statement), ['用户住在朝阳区']);
});

test('V9-M1：凭据值被拆成拼接形态时整段兜底', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 3,
    llm: async () => ({
      episode: {
        title: '网络设置',
        summary: '用户说密码 是 蓝鲸 - 7788，回头再改。',
      },
      facts: [],
    }),
    now: 1_700_000_500,
  });

  const row = store.listEpisodes({ scope: 'main' })[0];
  // 值被空格拆开，值级脱敏会漏掉「- 7788」；整段仍敏感 → 整段替换。
  assert.equal(row.summary, REDACTED_CREDENTIAL);
  assert.equal(row.title, '网络设置', '纯文本字段不受牵连');
  assert.doesNotMatch(episodeText(row), /7788/u);
});

test('V9-M1：纯文本 episode 不被误改', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm: async () => ({
      episode: {
        title: '聊了周末安排',
        summary: '用户说周六去看展览，周日在家休息。',
        evidence: '用户：周六想去美术馆。',
        mood_evidence: '用户语气轻快。',
        topics: ['周末', '展览'],
        entities: ['美术馆'],
        mood: 'positive',
      },
      facts: [],
    }),
    now: 1_700_000_400,
  });

  const row = store.listEpisodes({ scope: 'main' })[0];
  assert.equal(row.title, '聊了周末安排');
  assert.equal(row.summary, '用户说周六去看展览，周日在家休息。');
  assert.equal(row.evidence, '用户：周六想去美术馆。');
  assert.equal(row.mood_evidence, '用户语气轻快。');
  assert.deepEqual(JSON.parse(row.topics_json), ['周末', '展览']);
  assert.deepEqual(JSON.parse(row.entities_json), ['美术馆']);
  assert.equal(row.mood, 'positive');
  assert.ok(store.searchBigram('展览', {}).some((hit) => hit.type === 'episode'));
});

// ------------------------------------------------ store 防御性脱敏

test('V9-M1：store.insertEpisode 防御性脱敏，绕过 consolidate 也不落明文', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const row = store.insertEpisode({
    scope: 'main',
    session_id: 'main',
    title: `路由器密码 ${PASSWORD_VALUE}`,
    summary: `明文密码 ${PASSWORD_VALUE}`,
    evidence: 'API token：sk-abc123',
    mood_evidence: '卡号 6222 0202 0000 1234',
    topics: [`路由器密码 ${PASSWORD_VALUE}`, '网络'],
    entities: ['路由器'],
    started_at: 1_700_000_000,
  });

  // store 只做值级脱敏（整段兜底在 consolidate 层）：值被替换、上下文保留。
  assert.equal(row.title, `路由器密码 ${REDACTED_CREDENTIAL}`);
  assert.equal(row.summary, `明文密码 ${REDACTED_CREDENTIAL}`);
  assert.equal(row.evidence, `API token：${REDACTED_CREDENTIAL}`);
  assert.equal(row.mood_evidence, `卡号 ${REDACTED_CREDENTIAL}`);
  assert.deepEqual(
    JSON.parse(row.topics_json),
    [`路由器密码 ${REDACTED_CREDENTIAL}`, '网络'],
  );

  // JSON 字符串形态的 topics 也要脱敏且保持合法 JSON。
  const jsonTopics = store.insertEpisode({
    scope: 'main',
    session_id: 'main',
    title: '网络备注',
    topics: `["路由器密码 ${PASSWORD_VALUE}"]`,
    started_at: 1_700_000_100,
  });
  assert.deepEqual(JSON.parse(jsonTopics.topics_json), [`路由器密码 ${REDACTED_CREDENTIAL}`]);

  // 幂等：已脱敏文本再写一次不会叠加占位符。
  const again = store.insertEpisode({
    scope: 'main',
    session_id: 'main',
    title: row.title,
    started_at: 1_700_000_200,
  });
  assert.equal(again.title, `路由器密码 ${REDACTED_CREDENTIAL}`);

  // fts_episodes 由 store 从主表投影，自动跟着干净。
  assert.doesNotMatch(episodeFtsText(store), /蓝鲸|7788|6222|sk-abc123/u);
  assert.equal(
    store.searchBigram(PASSWORD_VALUE, {}).filter((hit) => hit.type === 'episode').length,
    0,
  );
  assert.equal(
    store.searchBigram('sk-abc123', {}).filter((hit) => hit.type === 'episode').length,
    0,
  );
});
