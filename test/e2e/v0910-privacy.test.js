/**
 * v0.4.10 隐私回归（V9-M1/L1/L2 的跨会话验收）。
 *
 * 场景与验收口径（用户 v0.4.10 清单）：
 *   1. 会话 A 里用户说出「路由器密码 蓝鲸-7788」，经过真实巩固链路落库；
 *   2. 换一个新会话（同一 main scope，latest-user 绑定）问「路由器密码是什么」，
 *      召回、注入、状态板、episodes、fts_episodes、json 导出里都不得出现明文；
 *   3. 同一段对话里的普通事实（极光展）仍能被召回——防「一刀切误杀」；
 *   4. 巩固 prompt 自带「不得复述」约束（模型能看到原文，但被要求不复述）。
 *
 * 本文件走生产路径：FakeCtx → apply() → agent/pre-step → 后台巩固 → retrieve。
 * 不直接调用 consolidate，避免只测到单元而漏掉接线（V9-M1 正是接线缺口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { exportAll } from '../../src/memory/export.js';
import { publishBoard } from '../../src/memory/state-board.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, recallInjection, waitFor } from './helpers.js';

// C-H1：apply 一律经严格 ctx 代理，未声明 inject 的属性读会像真实 cordis 一样抛错。
const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** 明文凭据值：只允许出现在测试文件里（`git grep 蓝鲸-7788` 的验收口径）。 */
const SECRET = '蓝鲸-7788';
const SECRET_RE = /蓝鲸-7788/u;
/** 同段对话里的普通事实，用来证明脱敏没有把整段 episode 一起丢掉。 */
const NORMAL = '极光展';

/**
 * 模型巩固草稿：episode 四字段与 topics 都带凭据值，另含一条敏感事实
 * （应被 V7-M3 过滤）和一条普通事实（应正常落库并可召回）。
 */
const DRAFT = {
  episode: {
    title: `路由器密码 ${SECRET}`,
    summary: `用户把家里路由器密码 ${SECRET} 告诉了我，还说周末要去看${NORMAL}。`,
    evidence: `用户原话：路由器密码 ${SECRET}`,
    mood_evidence: `提到密码 ${SECRET} 时语气有点紧张`,
    topics: ['网络', `路由器密码 ${SECRET}`],
    entities: ['路由器'],
    mood: 'anxious',
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'knowledge',
      subject_text: '路由器',
      predicate: '密码',
      object_text: SECRET,
      statement: `路由器密码是 ${SECRET}。`,
      salience: 'normal',
    },
    {
      kind: 'other',
      subject_text: '用户',
      predicate: '周末安排',
      object_text: NORMAL,
      statement: `用户周末要去看${NORMAL}。`,
      salience: 'normal',
    },
  ],
  reminders: [],
};

/** FakeCtx + commands/tools/llm；tokenMeter 返回值可由测试逐轮改写。 */
function makeCtx({ totalTokens = 1000 } = {}) {
  const ctx = new FakeCtx({ now: TEST_NOW });
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  setTokens(ctx, totalTokens);
  return { ctx, streams };
}

/** 改写 tokenMeter.measure 的返回值（保持平台字段形状）。 */
function setTokens(ctx, totalTokens) {
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
}

/**
 * 造 turn payload：先把用户消息写进 surface（真实平台在 pre-step 后才落库，
 * session-scope 的 e2e 同样用这种「先 emit 再 dispatch」模拟）。
 */
function payload(ctx, session, turn, text) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step: 1,
  };
}

/** decision.messages 里所有文本块拼起来（注入块、隐私提示都算）。 */
function decisionText(decision) {
  return (decision?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** 取本轮召回注入块的正文；没有注入时返回 ''。 */
function recallText(decision) {
  return (decision?.messages ?? [])
    .filter((message) => message?.source?.kind === 'companion-recall')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** episodes 行里所有会落文本的列。 */
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

test('v0.4.10：跨会话问路由器密码不召回明文，普通事实照常召回', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx();
  const sessionA = ctx.addSession({ id: 'privacy-session-a' });
  const sessionB = ctx.addSession({ id: 'privacy-session-b' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // ---------------------------------------------------- 会话 A：写入并巩固
    // turn-1 只是普通对话（token 未过阈值，不触发巩固）。
    const first = payload(ctx, sessionA, { id: 'a-turn-1' },
      `记一下，我家路由器密码 ${SECRET}，周末还要去看${NORMAL}。`);
    const firstDecision = await ctx.dispatch('agent/pre-step', first, {
      kind: 'enter',
      messages: first.messages,
    });
    // 新库里还没有 episode，会话 A 第一轮不应召回凭据（也证明查询发生在写入前）。
    assert.equal(recallText(firstDecision), '');

    // turn-2 跨过硬阈值（40K），后台跑巩固；模型能看到原文，但被要求不复述。
    setTokens(ctx, 41_000);
    const second = payload(ctx, sessionA, { id: 'a-turn-2' }, '密码的事回头再改。');
    await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    await waitFor(() => temp.store.getWatermark('main') > 0, { label: 'main watermark' });

    const prompt = streams[0].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');
    // 模型输入确有原文（脱敏发生在落库，而不是把对话藏起来）。
    assert.match(prompt, SECRET_RE);
    // 巩固 prompt 自带「不得复述」约束（V9-M1 的提示词侧防线）。
    assert.match(prompt, /不得复述密码、口令、token、卡号等凭据值/u);
    assert.match(prompt, /用户提到一个密码/u);

    // ---------------------------------------------------- 落库面：无明文
    const episodes = temp.store.listEpisodes({ scope: 'main' });
    assert.equal(episodes.length, 1, '巩固应写入一条 episode');
    const episode = episodes[0];
    assert.doesNotMatch(episodeText(episode), SECRET_RE, 'episodes 列不得含明文');
    assert.doesNotMatch(JSON.stringify(episode), SECRET_RE, 'episodes 整行 JSON 不得含明文');
    // 值级脱敏保留上下文：不是整段丢弃（V9-M1b 口径），叙述仍可读。
    assert.match(episodeText(episode), /路由器密码/u);
    assert.match(episodeText(episode), /\[凭据已省略\]/u);

    assert.doesNotMatch(episodeFtsText(temp.store), SECRET_RE, 'fts_episodes 不得含明文');
    assert.equal(
      temp.store.searchBigram(SECRET, { scope: 'main' }).filter((hit) => hit.type === 'episode').length,
      0,
      '被脱敏的 episode 不能按凭据值召回',
    );

    // 敏感事实仍被 V7-M3 挡在事实库外，普通事实正常落库。
    const facts = temp.store.listFacts({ scope: 'main' });
    assert.deepEqual(facts.map((fact) => fact.statement), [`用户周末要去看${NORMAL}。`]);

    // ---------------------------------------------------- 状态板：无明文
    const staged = temp.store.getBoardState('main');
    assert.ok(staged, '状态板版本行应存在');
    assert.doesNotMatch(String(staged.staged_rendered ?? ''), SECRET_RE, '暂存状态板不得含明文');
    // 按真实发布时机（restart）翻进 rendered，再读用户可见状态板。
    publishBoard(temp.store, 'main', 'restart');
    const board = temp.store.getBoard('main');
    assert.match(board, /【最近进展】/u, '状态板应已发布');
    assert.doesNotMatch(board, SECRET_RE, '状态板不得含明文');

    // ---------------------------------------------------- 导出（json）：无明文
    const exported = exportAll({
      store: temp.store,
      scope: 'main',
      format: 'json',
      dir: temp.dir,
      now: TEST_NOW,
    });
    const raw = readFileSync(exported.path, 'utf8');
    assert.doesNotMatch(raw, SECRET_RE, 'json 导出不得含明文');
    const payloadJson = JSON.parse(raw);
    // 导出侧本来就会按敏感正文过滤 episode（V7-M3 的导出口径）；无论它被整体
    // 过滤还是保留为脱敏文本，都不能出现明文。
    assert.ok(payloadJson.counts.episodes <= 1);
    for (const row of payloadJson.data.episodes) {
      assert.doesNotMatch(JSON.stringify(row), SECRET_RE, '导出的 episode 不得含明文');
    }
    assert.match(raw, new RegExp(NORMAL, 'u'), '普通事实应出现在导出里');

    // ---------------------------------------------------- 召回面：无明文
    const recall = await recallInjection({
      store: temp.store,
      query: '路由器密码是什么',
      scope: 'main',
      now: TEST_NOW,
    });
    assert.ok(
      recall.recalled.items.some((item) => item.kind === 'episode'),
      '脱敏后的 episode 仍应能按上下文召回（值没了，标题还在）',
    );
    assert.doesNotMatch(JSON.stringify(recall.recalled.items), SECRET_RE, '召回结果不得含明文');
    assert.doesNotMatch(recall.injected, SECRET_RE, '召回注入文本不得含明文');
    assert.match(recall.injected, /路由器密码/u, '召回注入应保留可用上下文');

    // ---------------------------------------------------- 新会话：注入无明文
    // 新会话带真实用户输入，latest-user 绑定会把它重绑到 main（scope 仍是 main）。
    setTokens(ctx, 1_000);
    const ask = payload(ctx, sessionB, { id: 'b-turn-1' }, '路由器密码是什么？');
    const askDecision = await ctx.dispatch('agent/pre-step', ask, {
      kind: 'enter',
      messages: ask.messages,
    });
    const askRecall = recallText(askDecision);
    assert.match(askRecall, /路由器密码/u, '新会话应召回脱敏后的 episode');
    assert.doesNotMatch(decisionText(askDecision), SECRET_RE, '新会话注入/提示文本不得含明文');

    // ---------------------------------------------------- 防误杀：普通事实可召回
    const normalAsk = payload(ctx, sessionB, { id: 'b-turn-2' }, `${NORMAL}是什么时候？`);
    const normalDecision = await ctx.dispatch('agent/pre-step', normalAsk, {
      kind: 'enter',
      messages: normalAsk.messages,
    });
    assert.match(recallText(normalDecision), new RegExp(NORMAL, 'u'), '普通事实仍应可召回');
    assert.doesNotMatch(decisionText(normalDecision), SECRET_RE);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
