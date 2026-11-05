/**
 * v0.4.9 V7-M3：凭据类内容不写入 facts 与状态板。
 *
 * 背景：旧实现只把「身份证/银行卡/密码/住址」视为敏感，且过滤只发生在
 * memory_write / 编辑事实的路径上；巩固（consolidate）把模型草稿直接写库，
 * 「wifi 密码是 xxx」「API key 是 sk-xxx」会原样落进 facts、FTS 与状态板。
 *
 * 覆盖：
 *   1. isSensitiveText 扩充后的判定 + 误报控制（密码学 / tokenizer / keyboard）；
 *   2. 巩固入口统一过滤：敏感事实不写 facts、不进 FTS、不进状态板，
 *      敏感提醒也不落库；返回 sensitive 计数与 CREDENTIAL_HINT 回执；
 *   3. pre-step 在用户消息命中凭据时注入一句提示（每 turn 一次、不含具体值），
 *      且该注入消息带独立 source.kind，不会被当作真实用户发言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { CREDENTIAL_HINT, isSensitiveText } from '../src/memory/govern.js';
import { consolidate } from '../src/memory/consolidate.js';
import { Store } from '../src/memory/store.js';

import { TEST_NOW } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

const PASSWORD_VALUE = '蓝鲸-7788';
const API_KEY_VALUE = 'sk-abc123';

const PRIVACY_KIND = 'companion-privacy-hint';

// --------------------------------------------------------- 敏感判定

test('V7-M3：isSensitiveText 命中常见凭据写法', () => {
  const hits = [
    `我的 wifi 密码是 ${PASSWORD_VALUE}`,
    `密码：${PASSWORD_VALUE}`,
    'password 是 hunter2',
    'passwd = 1234',
    `API key 是 ${API_KEY_VALUE}`,
    'apikey: abc123xyz',
    'access token 是 abc123',
    '这个 token 是 abc123',
    '验证码 123456',
    'verification code 778899',
    '卡号 6222 0000 1111',
    'card number 4111-1111',
    'CVV 123',
    '私钥放在文件里',
    'secret: hunter2',
    'pwd=1234',
    '身份证 110101199001011234',
    '银行卡密码要改',
    '我家住址在朝阳区',
  ];
  for (const text of hits) {
    assert.equal(isSensitiveText(text), true, `应命中：${text}`);
  }
});

test('V7-M3：误报控制——学科词 / 分词器 / 普通英文不误伤', () => {
  const misses = [
    '密码学很有趣',
    'tokenizer 怎么用',
    'keyboard 坏了',
    'key is abcd',
    '我喜欢喝咖啡',
    '',
    null,
    undefined,
  ];
  for (const text of misses) {
    assert.equal(isSensitiveText(text), false, `不应命中：${String(text)}`);
  }
});

// --------------------------------------------------------- 巩固过滤

/** 造一份含凭据的草稿。 */
function credentialDraft() {
  return {
    episode: {
      title: '聊了网络设置',
      summary: '用户确认了家里网络和 API 配置。',
      topics: ['网络'],
      started_at: 1_700_000_000,
    },
    facts: [
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '密码是',
        object_text: PASSWORD_VALUE,
        statement: `用户 wifi 密码是 ${PASSWORD_VALUE}`,
      },
      {
        kind: 'knowledge',
        subject_text: 'API',
        predicate: 'key 是',
        object_text: API_KEY_VALUE,
        statement: `API key 是 ${API_KEY_VALUE}`,
      },
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '喜欢',
        object_text: '喝咖啡',
        statement: '用户喜欢喝咖啡',
      },
    ],
    reminders: [
      { kind: 'todo', title: `把 wifi 密码改成 ${PASSWORD_VALUE}` },
      { kind: 'todo', title: '订展览票' },
    ],
  };
}

test('V7-M3：巩固时敏感事实/提醒不落库，状态板与 FTS 不含凭据', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  let draft = credentialDraft();
  const llm = async () => draft;
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 10,
    llm,
    now: 1_700_000_300,
    trigger: 'idle',
  });

  assert.equal(result.skipped, false);
  assert.equal(result.facts, 1, '只应写入普通事实');
  assert.equal(result.sensitive, 3, '两条敏感事实 + 一条敏感提醒');
  assert.equal(result.notice, CREDENTIAL_HINT, '回执应带建议句');

  // facts 表：只有普通事实，凭据串不出现。
  const facts = store.listFacts({ scope: 'main' });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].statement, '用户喜欢喝咖啡');
  for (const fact of facts) {
    assert.doesNotMatch(JSON.stringify(fact), /蓝鲸-7788|sk-abc123/u);
  }

  // FTS 投影：凭据检索不到（普通事实可以）。
  assert.equal(store.searchBigram(PASSWORD_VALUE, {}).filter((row) => row.type === 'fact').length, 0);
  assert.equal(store.searchBigram(API_KEY_VALUE, {}).filter((row) => row.type === 'fact').length, 0);
  assert.ok(store.searchBigram('咖啡').some((row) => row.type === 'fact'));

  // reminders：敏感提醒不落库，普通提醒保留。
  const reminders = store.listReminders({ scope: 'main' });
  assert.deepEqual(reminders.map((row) => row.title), ['订展览票']);

  // 状态板（staged）：不含凭据串。
  const board = store.getBoardState('main').staged_rendered;
  assert.doesNotMatch(board, /蓝鲸-7788|sk-abc123/u);
  assert.match(board, /用户喜欢喝咖啡/u);
  assert.match(board, /订展览票/u);
});

test('V7-M3：历史库里的敏感行渲染状态板前也会被剔除', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  // 模拟旧版本已经写进库的敏感事实（绕过 consolidate 过滤）。
  store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: '用户',
    predicate: '密码是',
    object_text: PASSWORD_VALUE,
    statement: `用户密码是 ${PASSWORD_VALUE}`,
    source_kind: 'consolidated',
  });

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm: async () => credentialDraft(),
    now: 1_700_000_300,
  });
  assert.equal(result.skipped, false);

  const board = store.getBoardState('main').staged_rendered;
  assert.doesNotMatch(board, /蓝鲸-7788|sk-abc123/u);
  // 敏感事实仍在库里（不物理删除），但不能出现在状态板。
  assert.ok(store.listFacts({ scope: 'main' }).some((row) => row.statement.includes(PASSWORD_VALUE)));
});

// --------------------------------------------------------- pre-step 提示

function makeCtx() {
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
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return ctx;
}

function preStepPayload(session, turn, text, step = 1) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

function injectedPrivacy(decision) {
  return (decision?.messages ?? []).filter((message) => message?.source?.kind === PRIVACY_KIND);
}

test('V7-M3：用户消息含凭据时注入一次提示，正文不含具体值', async (t) => {
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-privacy', events: [] });
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  const decide = (payload) => ctx.dispatch('agent/pre-step', payload, {
    kind: 'enter',
    messages: payload.messages,
  });

  const first = await decide(preStepPayload(session, 1, `我的 wifi 密码是 ${PASSWORD_VALUE}`));
  const hints = injectedPrivacy(first);
  assert.equal(hints.length, 1, '同一 turn 第一次 pre-step 应注入一句提示');
  const hintText = hints[0].content[0].text;
  assert.ok(hintText.includes(CREDENTIAL_HINT), '提示应包含固定建议句');
  assert.doesNotMatch(hintText, /蓝鲸-7788/u);
  assert.equal(hints[0].role, 'user');

  // 同一 turn 的后续 step 会回灌 payload，不能重复注入。
  const second = await decide(preStepPayload(session, 1, `我的 wifi 密码是 ${PASSWORD_VALUE}`, 2));
  assert.equal(injectedPrivacy(second).length, 0);

  // 新 turn 的普通消息不注入。
  const third = await decide(preStepPayload(session, 2, '今天想喝咖啡'));
  assert.equal(injectedPrivacy(third).length, 0);
});

test('V7-M3：普通技术讨论不触发凭据提示', async (t) => {
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-privacy-normal', events: [] });
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  const decision = await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '密码学和 tokenizer 有什么区别'), {
    kind: 'enter',
    messages: [],
  });
  assert.equal(injectedPrivacy(decision).length, 0);
});
