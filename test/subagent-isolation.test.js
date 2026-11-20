/**
 * SA-H1 / SA-L1（v0.7.7 阶段 3）：子代理消息隔离与线程归属。
 *
 * 非真机证据：消息形状按宿主源码构造，未在真机子代理会话回放。
 * 形状与文案来源（安装路径，asar 扁平布局，dsh-v0.2.2-rc.5）：
 *   D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-subagent\src\continuation-messages.ts
 *   :14-20  AgentMessageSource        → { kind:'agent-message', form:'relay', senderSessionId }
 *   :29-39  SubagentSettledMessageSource → { kind:'subagent-settled', form:'notice', summary, stopReason?, senderSessionId }
 *   :106-129 settlementSummary()      → 通知首行文案（Background subagent <name> finished … / failed before it finished.）
 *   :152-166 createSettlementMessage() → 尾部 closing text / Structured result / diagnostic 拼装
 *
 * 覆盖：
 *   ① settled 通知全链隔离（hasRealUserInput / isInjectedMessage / lastUserText + 行为面）
 *   ② agent-message relay 同构
 *   ③ SA-L1 线程归属：threads 登记优先于 subagent 判定、不重绑 main、遮蔽跳过
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import {
  apply as applyCordis,
  hasRealUserInput,
  isInjectedMessage,
  lastUserText,
} from '../src/index.js';
import { classifySession } from '../src/session/identity.js';
import { createAssembleHandler } from '../src/persona/shadow.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';
const SETTLED_KIND = 'subagent-settled';
const AGENT_MESSAGE_KIND = 'agent-message';
const AT = toEpochSeconds(TEST_NOW);

// ------------------------------------------------------------ 形状构造

/** 子代理结案通知：正文按 continuation-messages.ts:106-129 + :152-166 拼。 */
function settledMessage({
  senderSessionId = 'agent-7',
  stopReason = 'completed',
  closing = '训练日志已存到 D 盘。',
  structured,
} = {}) {
  const content = [
    { type: 'text', text: `Background subagent worker finished. It cannot receive follow-up messages.` },
    ...(closing === ''
      ? [{ type: 'text', text: 'It left no closing message.' }]
      : [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: closing }]),
    ...(structured === undefined
      ? []
      : [{ type: 'text', text: `Structured result: ${JSON.stringify(structured)}` }]),
  ];
  return {
    id: `settled-${senderSessionId}`,
    role: 'user',
    content,
    source: {
      kind: SETTLED_KIND,
      form: 'notice',
      summary: 'Background subagent worker finished. It cannot receive follow-up messages.',
      stopReason,
      senderSessionId,
    },
  };
}

/** agent 间 relay 消息：正文是另一个 agent 自己写的话（continuation-messages.ts:48-55）。 */
function agentMessage({ senderSessionId = 'agent-3', text = '我把预算表更新到 8000 了。' } = {}) {
  return {
    id: `agent-message-${senderSessionId}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: AGENT_MESSAGE_KIND, form: 'relay', senderSessionId },
  };
}

/** 真实用户发言（平台形状）。 */
function userMessage(text) {
  return {
    id: `user-${text.length}-${text.slice(0, 4)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** 助手行：不参与判定，只用来验证「同批里有别的行」也不影响结论。 */
function assistantMessage(text = '好的，我看下。') {
  return { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text }] };
}

// ------------------------------------------------------------ 插件链路夹具

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { registrations: [], register() { return () => {}; } };
  ctx.tools = { registrations: [], register() { return () => {}; } };
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

/** 一条可命中的 knowledge 事实，用来证明「真实发言会触发召回」。 */
function seedRecallable(store) {
  store.insertFact({
    kind: 'knowledge',
    subject_text: '蓝鲸计划',
    predicate: '状态',
    object_text: '下月启动',
    statement: '蓝鲸计划下个月启动。',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
  });
}

/** 一轮 pre-step：返回 decision，便于检查注入面。 */
async function preStep(ctx, session, turnId, messages) {
  const payload = {
    agent: { id: session.id, session },
    messages,
    turn: { id: turnId },
    step: 1,
  };
  return ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages });
}

/** decision 里有没有召回注入。 */
function recallOf(decision) {
  return (decision?.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
}

// ------------------------------------------------------------ ① settled 通知

test('SA-H1 ①：subagent-settled 通知不进用户输入判定、不进召回/情绪 query', async (t) => {
  const settled = settledMessage();
  const real = userMessage('还记得蓝鲸计划吗');

  // 函数面：三处判定。
  assert.equal(hasRealUserInput([assistantMessage(), settled]), false, '只有通知时不算真实输入');
  assert.equal(hasRealUserInput([real, settled]), true, '混入真实用户文本就算');
  assert.equal(hasRealUserInput([settled, assistantMessage()]), false);
  assert.equal(isInjectedMessage(settled), true, '通知必须被当作注入');
  assert.equal(isInjectedMessage(real), false);
  assert.equal(lastUserText([real, settled]), '还记得蓝鲸计划吗', '必须跳过通知行，取真实用户文本');
  assert.equal(lastUserText([settled]), '', '只剩通知时返回空');
  assert.equal(lastUserText([assistantMessage(), settled, assistantMessage()]), '');

  // 行为面：真实插件链路（pre-step）。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const other = ctx.addSession({ id: 'session-2' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    seedRecallable(temp.store);

    // 先用真实发言建立 main 绑定。
    const first = await preStep(ctx, session, 'turn-real', [real]);
    assert.ok(recallOf(first), '真实发言带「蓝鲸」应注入召回');
    const bound = temp.store.getMeta('main_session_id');
    assert.equal(bound, 'session-1');

    // settled-only 轮（另一个会话）：不注入召回，也不抢 main 绑定。
    const noticeOnly = await preStep(ctx, other, 'turn-settled', [assistantMessage(), settled]);
    assert.equal(recallOf(noticeOnly), undefined, '通知正文不得当召回查询，因此不注入');
    assert.equal(
      temp.store.getMeta('main_session_id'),
      bound,
      'latest-user 重绑必须忽略子代理通知（routeSession 的 hasUserInput 走同一判定）',
    );

    // 通知 + 真实发言同批：只按真实发言取 query。
    const mixed = await preStep(ctx, other, 'turn-mixed', [settled, userMessage('蓝鲸计划什么时候启动')]);
    const recall = recallOf(mixed);
    assert.ok(recall, '同批里的真实发言仍应触发召回');
    assert.match(recall.content[0].text, /蓝鲸计划/u);
    await settle(20);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------------ ② agent-message

test('SA-H1 ②：agent-message relay 消息同样不算用户输入', async (t) => {
  const relay = agentMessage();
  const real = userMessage('蓝鲸计划什么时候启动');

  assert.equal(hasRealUserInput([assistantMessage(), relay]), false);
  assert.equal(hasRealUserInput([relay, real]), true);
  assert.equal(isInjectedMessage(relay), true);
  assert.equal(isInjectedMessage(userMessage('随便说说')), false);
  assert.equal(lastUserText([real, relay]), '蓝鲸计划什么时候启动');
  assert.equal(lastUserText([relay]), '');

  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const other = ctx.addSession({ id: 'session-2' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    seedRecallable(temp.store);
    const first = await preStep(ctx, session, 'turn-real', [real]);
    assert.ok(recallOf(first));
    const bound = temp.store.getMeta('main_session_id');

    const relayOnly = await preStep(ctx, other, 'turn-relay', [relay]);
    assert.equal(recallOf(relayOnly), undefined, 'relay 正文不得当召回查询');
    assert.equal(temp.store.getMeta('main_session_id'), bound, 'relay 消息不重绑主会话');
    await settle(20);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------------ ③ SA-L1 线程归属

test('SA-L1 ③：线程登记优先于 subagent 判定，且线程会话不重绑 main、不遮蔽', async (t) => {
  const temp = makeTempStore();
  const { store } = temp;
  try {
    store.upsertThread({
      key: 'deploy',
      name: '部署',
      session_id: 'sess-thread-1',
      description: '部署相关会话',
      status: 'active',
    });

    // 1) 登记过的 session id → thread（即使 header 看起来像子代理）。
    const threadAgent = {
      session: { id: 'sess-thread-1', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'main-sess' } },
    };
    const thread = classifySession(threadAgent, { store, binding: 'latest-user', hasUserInput: true });
    assert.equal(thread.kind, 'thread');
    assert.equal(thread.scope, 'thread:deploy');
    assert.equal(thread.key, 'deploy');

    // 2) 同 id 没有 threads 行 → 仍是 subagent（回归）。
    const sub = classifySession(
      { session: { id: 'sess-other', header: { origin: 'subagent' } } },
      { store, binding: 'latest-user', hasUserInput: true },
    );
    assert.equal(sub.kind, 'subagent');

    // 3) 没有 header、没有 threads 行 → main 路径不变（并写入首次绑定）。
    const main = classifySession({ session: { id: 'sess-main' } }, { store });
    assert.equal(main.kind, 'main');
    assert.equal(main.scope, 'main');
    assert.equal(store.getMeta('main_session_id'), 'sess-main');

    // 4) 线程会话带真实输入也不重绑 main。
    const before = store.getMeta('main_session_id');
    const again = classifySession(threadAgent, { store, binding: 'latest-user', hasUserInput: true });
    assert.equal(again.kind, 'thread');
    assert.equal(store.getMeta('main_session_id'), before, 'thread 会话不允许重绑 main_session_id');

    // 5) 遮蔽：thread 与 subagent 都不触发 onApplied，main 照常。
    const applied = [];
    const handler = createAssembleHandler({
      mode: 'rewrite',
      personaText: '遮蔽后的人格行',
      store,
      onApplied: (info) => applied.push(info),
    });
    const assembly = { sections: [] };
    // rewrite 只替换宿主 deployment:persona-prefix 段（shadow.js:22 / :78-96）。
    const next = () => ({
      sections: [
        { name: 'deployment:persona-prefix', text: '宿主默认人设' },
        { name: 'chat-identity', text: '默认聊天身份' },
      ],
    });

    const threadContext = { agent: threadAgent, scope: threadAgent };
    const threadOut = await handler(assembly, threadContext, next);
    assert.equal(threadOut.sections[0].text, '宿主默认人设', '线程会话不遮蔽');
    assert.equal(applied.length, 0);

    const subAgent = { session: { id: 'sess-other', header: { origin: 'subagent' } } };
    const subOut = await handler(assembly, { agent: subAgent, scope: subAgent }, next);
    assert.equal(subOut.sections[0].text, '宿主默认人设', '子代理仍不遮蔽');
    assert.equal(applied.length, 0);

    const mainAgent = { session: { id: 'sess-main' } };
    const mainOut = await handler(assembly, { agent: mainAgent, scope: mainAgent }, next);
    assert.match(mainOut.sections[0].text, /遮蔽后的人格行/u, '主会话照常遮蔽');
    assert.equal(mainOut.sections[0].interpolate, false, '遮蔽文本必须显式 interpolate:false');
    assert.equal(applied.length, 1);
  } finally {
    temp.cleanup();
  }
});
