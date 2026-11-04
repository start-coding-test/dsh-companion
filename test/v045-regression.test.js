/**
 * v0.4.5 集成回归（V4-H1 / V4-L1 / V4-M1 / V4-L2 全覆盖）。
 *
 * 与各修复自己的单元/专项测试互补：这里全部走真实插件入口 `apply()` +
 * FakeCtx + 临时库，把四项修复放回「调度器 tick → 提醒两阶段投递 →
 * 召回注入 → 平台压缩 → 巩固」的真实链路里，确认它们没有互相踩踏。
 *
 * 覆盖：
 *   V4-H1 提醒失败一次后下一次 tick 只送达一条、正文不重复、无 delivering
 *          残留；连续 3 个 tick 的重试退避不会把提醒耗成 expired。
 *   V4-L1 注入消息缺 id / source.kind 时适配层抛 TypeError；合法召回消息通过。
 *   V4-M1 52 条混合库里短查询/寒暄不注入，2-3 字实体查询仍能命中。
 *   V4-L2 压缩摘要夹带召回段时整段剔除、真实发言保留；标记不完整时不越界删除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';
const AT = toEpochSeconds(TEST_NOW);

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
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

/** 带会话与假 LLM 的 ctx（召回 / 巩固链路）。 */
function makeMemoryCtx() {
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (
      providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []
    ),
    async *stream(request) {
      streams.push(request);
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          episode: {
            title: '预算问答',
            summary: '用户询问预算额度。',
            topics: ['预算'],
            salience: 'normal',
            fidelity: 'full',
          },
          facts: [],
          reminders: [],
        }),
      };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  return { ctx, session, streams };
}

/** 主动消息正文（FakeCtx 把 prompt 记成 content 数组）。 */
function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** 插入一条已到期的普通提醒。 */
function dueReminder(store, title, nowMs = TEST_NOW) {
  const nowSeconds = toEpochSeconds(nowMs);
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nowSeconds - 60,
    next_fire_at: nowSeconds - 60,
    due_granularity: 'exact',
  });
}

/** 一轮真实用户输入的 pre-step payload（完整平台消息）。 */
function turnPayload(session, turnId, text) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
  return {
    agent: { id: session.id, session },
    messages: [message],
    turn: { id: turnId },
    step: 1,
  };
}

/** 复刻平台：runtime-context 之外的 decision.messages 全部 append。 */
function appendDecision(ctx, session, decision) {
  for (const message of decision?.messages ?? []) {
    if (message?.source?.kind === 'runtime-context') continue;
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: message });
  }
}

/** 摘要桩：平台式 checkpoint 外壳 + 回显选区。 */
function checkpointEcho(regionText) {
  return [
    'This is an automatically generated checkpoint condensing an earlier span of the conversation.',
    'Treat the captured context as established background when continuing.',
    '',
    '<compacted-summary>',
    '## Critical Context',
    '- [pasted conversation]',
    regionText,
    '</compacted-summary>',
  ].join('\n');
}

/** 巩固模型看到的全部文本。 */
function promptText(request) {
  return request.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

// ------------------------------------------------------------ V4-H1

test('V4-H1 集成：提醒失败一次后下一 tick 只送达一条，无重复文本与 delivering 残留', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '交房租');
    ctx.fail('sessionController.prompt');

    await firstTick(ctx);
    const failed = temp.store.getReminder(reminder.id);
    assert.equal(failed.status, 'pending', '投递失败必须释放回 pending');
    assert.equal(failed.delivery_attempts, 1);
    assert.equal(
      failed.next_fire_at,
      toEpochSeconds(TEST_NOW) + 60 + 30,
      '失败后应退避 30s（下一次 tick 不立即重试）',
    );
    assert.equal(
      temp.store.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'delivering'").get().n,
      0,
      '失败后不得残留 delivering 行',
    );

    ctx.failures.delete('sessionController.prompt');
    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);

    const texts = promptTexts(ctx).filter((text) => text.includes('交房租'));
    assert.equal(texts.length, 2, '一次失败 + 一次成功，共两次 prompt');
    assert.equal(texts[1], '提醒：交房租', '重试必须是单条提醒原文');
    assert.equal((texts[1].match(/交房租/gu) ?? []).length, 1, '同一提醒不得重复拼接');
    assert.equal(texts[1].includes('\n\n'), false, '单条提醒不得与其它提醒合并');

    const delivered = temp.store.getReminder(reminder.id);
    assert.equal(delivered.status, 'fired');
    assert.equal(delivered.delivery_attempts, 2);
    assert.equal(
      temp.store.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'delivering'").get().n,
      0,
    );

    // 成功后再走 3 个 tick：不补发、不换状态。
    for (let i = 0; i < 3; i += 1) {
      ctx.advance(30_000);
      await ctx.fireTimers();
      await settle(20);
    }
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交房租')).length, 2);
    assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V4-H1 集成：连续 3 个 tick 失败重试不会把提醒提前耗成 expired，退避到期后只送达一次', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '吃药');
    ctx.fail('sessionController.prompt');

    await firstTick(ctx); // 17:01:00 失败 → 退避 30s
    let row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 1);

    ctx.advance(30_000); // 17:01:30 失败 → 退避 60s
    await ctx.fireTimers();
    await settle(50);
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.delivery_attempts, 2);

    ctx.advance(30_000); // 17:02:00 退避未到：第三个 tick 不得 claim
    await ctx.fireTimers();
    await settle(50);
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'pending', '3 个 tick 后仍应 pending');
    assert.notEqual(row.status, 'expired', '3 个 tick 不得提前 expired');
    assert.equal(row.delivery_attempts, 2, '退避未到不消耗 attempts');
    assert.equal(
      temp.store.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'delivering'").get().n,
      0,
    );

    // 恢复投递：退避 60s 到期后仅送达一条，且正文只出现一次标题。
    ctx.failures.delete('sessionController.prompt');
    ctx.advance(60_000); // 17:03:00 ≥ next_fire_at(17:02:30)
    await ctx.fireTimers();
    await settle(50);
    const texts = promptTexts(ctx).filter((text) => text.includes('吃药'));
    assert.equal(texts.length, 3, '两次失败 + 一次成功');
    assert.equal(texts[2], '提醒：吃药');
    assert.equal((texts[2].match(/吃药/gu) ?? []).length, 1);
    row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.equal(row.delivery_attempts, 3);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------------ V4-L1

const AGENT = { id: 'agent-1' };

/** 适配层直接注入一批消息，返回 dispatch 的 promise。 */
function dispatchInject(ctx, inject) {
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ inject }));
  return ctx.dispatch(
    'agent/pre-step',
    { agent: AGENT, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [] }),
  );
}

test('V4-L1 集成：inject 缺 id 或 source.kind 抛 TypeError，合法召回消息通过', async () => {
  const valid = {
    id: 'recall-1',
    role: 'user',
    content: [{ type: 'text', text: '[相关记忆]\n- 预算 8000\n[/相关记忆]' }],
    source: { kind: RECALL_KIND, form: 'snapshot', sections: [{ name: 'recall', text: '...' }] },
  };

  // 缺 id：必须在插件侧抛 TypeError，错误点名字段。
  await assert.rejects(
    () => dispatchInject(new FakeCtx(), [{ ...valid, id: undefined }]),
    (error) => error instanceof TypeError && /"id"/u.test(error.message),
  );
  // 缺 source.kind：平台读 message.source.kind 会崩，必须在插件侧拦截。
  await assert.rejects(
    () => dispatchInject(new FakeCtx(), [{ ...valid, source: { form: 'snapshot' } }]),
    (error) => error instanceof TypeError && /"source\.kind"/u.test(error.message),
  );

  // 合法召回消息原样追加。
  const decision = await dispatchInject(new FakeCtx(), [valid]);
  assert.equal(decision.messages.length, 1);
  assert.equal(decision.messages[0], valid);
  assert.equal(decision.messages[0].source.kind, RECALL_KIND);
});

// ------------------------------------------------------------ V4-M1

/**
 * 52 条事实的混合库：蓝鲸/生日/吃药三个实体簇 + 46 条无关档案。
 * 与 test/v045-m1-recall-quality.test.js 的种子一致，放在真实插件链路里验证。
 */
function seedMixedLibrary(store) {
  const insert = (fields) => store.insertFact({
    kind: 'knowledge',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
    ...fields,
  });
  insert({
    kind: 'knowledge',
    subject_text: '蓝鲸',
    predicate: '含义',
    object_text: '一种海洋哺乳动物',
    statement: '蓝鲸是一种海洋哺乳动物。',
  });
  insert({
    kind: 'project',
    subject_text: '蓝鲸计划',
    predicate: '状态',
    object_text: '下月启动',
    statement: '蓝鲸计划下个月启动。',
  });
  insert({
    kind: 'knowledge',
    subject_text: '蓝鲸鱼',
    predicate: '别名',
    object_text: '小蓝鲸',
    statement: '蓝鲸鱼也被叫作小蓝鲸。',
  });
  insert({
    kind: 'relation',
    subject_text: '妈妈',
    predicate: '生日',
    object_text: '五月三日',
    statement: '妈妈的生日是五月三日。',
  });
  insert({
    kind: 'other',
    subject_text: '生日会',
    predicate: '地点',
    object_text: '家里',
    statement: '今年的生日会在家里办。',
  });
  insert({
    kind: 'other',
    subject_text: '吃药',
    predicate: '提醒',
    object_text: '晚饭后',
    statement: '记得吃药没，晚饭后吃。',
  });
  for (let i = 0; i < 46; i += 1) {
    insert({
      kind: 'other',
      subject_text: `档案${i}`,
      predicate: '备注',
      object_text: `第${i}条`,
      statement: `档案编号${i}的备注是第${i}条流水。`,
    });
  }
}

test('V4-M1 集成：52 条混合库里短查询/寒暄不注入，2-3 字实体仍命中', async () => {
  const temp = makeTempStore();
  const { ctx, session } = makeMemoryCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    seedMixedLibrary(temp.store);
    assert.equal(temp.store.listFacts({ scope: 'main', limit: 100 }).length, 52);

    const recallOf = (decision) => (decision.messages ?? [])
      .find((message) => message?.source?.kind === RECALL_KIND);

    for (const query of ['1+1', '今天怎么样', '我们什么时候可以', '你好', '谢谢']) {
      const payload = turnPayload(session, `small-${query}`, query);
      const decision = await ctx.dispatch('agent/pre-step', payload, {
        kind: 'enter',
        messages: payload.messages,
      });
      assert.equal(recallOf(decision), undefined, `${JSON.stringify(query)} 不应注入召回`);
      assert.equal(decision.messages.length, 1, '只应保留用户消息');
    }

    const bluePayload = turnPayload(session, 'turn-blue', '蓝鲸');
    const blueDecision = await ctx.dispatch('agent/pre-step', bluePayload, {
      kind: 'enter',
      messages: bluePayload.messages,
    });
    const blue = recallOf(blueDecision);
    assert.ok(blue, '「蓝鲸」应注入召回');
    assert.match(blue.content[0].text, /蓝鲸/u);
    assert.match(blue.content[0].text, /海洋哺乳动物/u);
    assert.match(blue.content[0].text, /\[\/相关记忆\]/u, '召回块必须带成对标记');
    assert.equal(blue.source.kind, RECALL_KIND);
    assert.equal(typeof blue.id, 'string');
    assert.ok(blue.id.length > 0);

    for (const [query, expected] of [['生日', /五月三日/u], ['吃药没', /晚饭后/u]]) {
      const payload = turnPayload(session, `turn-${query}`, query);
      const decision = await ctx.dispatch('agent/pre-step', payload, {
        kind: 'enter',
        messages: payload.messages,
      });
      const recall = recallOf(decision);
      assert.ok(recall, `${JSON.stringify(query)} 应注入召回`);
      assert.match(recall.content[0].text, expected);
      assert.doesNotMatch(recall.content[0].text, /档案编号/u, '不得带出无关档案事实');
    }
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------------ V4-L2

test('V4-L2 集成：压缩摘要夹带的召回段在巩固前剔除，真实发言保留', async () => {
  const temp = makeTempStore();
  const { ctx, session, streams } = makeMemoryCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      source_kind: 'turn',
    });

    // turn 1：召回注入（带成对标记），平台把用户消息与召回块都 append。
    const firstPayload = turnPayload(session, 'turn-1', '预算额度是多少？');
    const first = await ctx.dispatch('agent/pre-step', firstPayload, {
      kind: 'enter',
      messages: firstPayload.messages,
    });
    const recall = (first.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
    assert.ok(recall, 'turn 1 应有召回注入');
    const recallText = recall.content[0].text;
    assert.match(recallText, /\[相关记忆\]/u);
    assert.match(recallText, /\[\/相关记忆\]/u);
    appendDecision(ctx, session, first);

    // 插件之外：平台压缩 [1,2]，摘要回显了含召回段的选区。
    const compacted = ctx.compactSession(session.id, 1, 2, {
      text: checkpointEcho(`user: 预算额度是多少？\n${recallText}`),
    });
    assert.deepEqual(compacted.nodes, [3]);

    // turn 2：触发 hard 巩固，窗口只剩摘要节点（source.kind 已丢失）。
    const secondPayload = turnPayload(session, 'turn-2', '继续。');
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: secondPayload.messages[0] });
    ctx.returns['tokenMeter.measure'] = {
      ...ctx.returns['tokenMeter.measure'],
      totalTokens: 41_000,
      surfaceTokens: 41_000,
    };
    await ctx.dispatch('agent/pre-step', secondPayload, {
      kind: 'enter',
      messages: secondPayload.messages,
    });

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const prompt = promptText(streams[0]);
    const body = prompt.slice(prompt.indexOf('对话：\n') + '对话：\n'.length);
    assert.match(body, /预算额度是多少/u, '摘要里的真实用户发言必须保留');
    assert.doesNotMatch(body, /\[相关记忆\]/u, '摘要正文不得把召回块喂回巩固模型');
    assert.doesNotMatch(body, /\[\/相关记忆\]/u, '结束标记也不得残留');
    assert.doesNotMatch(prompt, /8000/u, '召回正文（8000）不得进入巩固窗口');

    await waitFor(() => temp.store.listEpisodes('main').length === 1, { label: 'episode written' });
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V4-L2 集成：摘要只保留开头标记时不做越界删除，后文仍进巩固窗口', async () => {
  const temp = makeTempStore();
  const { ctx, session, streams } = makeMemoryCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const firstPayload = turnPayload(session, 'turn-1', '先聊天气。');
    const first = await ctx.dispatch('agent/pre-step', firstPayload, {
      kind: 'enter',
      messages: firstPayload.messages,
    });
    appendDecision(ctx, session, first);

    ctx.compactSession(session.id, 1, 1, {
      text: checkpointEcho('user: 先聊天气。\n[相关记忆]\n- 摘要里只有开头标记，后文是真正的对话。'),
    });

    const secondPayload = turnPayload(session, 'turn-2', '继续。');
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: secondPayload.messages[0] });
    ctx.returns['tokenMeter.measure'] = {
      ...ctx.returns['tokenMeter.measure'],
      totalTokens: 41_000,
      surfaceTokens: 41_000,
    };
    await ctx.dispatch('agent/pre-step', secondPayload, {
      kind: 'enter',
      messages: secondPayload.messages,
    });

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const body = promptText(streams[0]).split('对话：\n').pop();
    assert.match(body, /后文是真正的对话/u, '找不到结束标记时不得吞掉摘要后文');
    assert.match(body, /先聊天气/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
