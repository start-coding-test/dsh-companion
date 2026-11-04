/**
 * V4-L2：召回块经压缩摘要回流的回归。
 *
 * 场景：
 *   turn 1 注入 `[相关记忆] … [/相关记忆]` 块（完整平台消息，随会话留存）；
 *   插件之外发生平台压缩（用户 `/compact` 或平台自动），把「用户消息 + 召回块」
 *   压成一个摘要节点；摘要模型按平台提示词保留数值/标记，复述了召回段。
 *   turn 2 触发 hard 巩固，巩固窗口里只剩摘要节点——source.kind 已丢失，
 *   若不做文本剔除，召回内容会被当用户发言再次写回记忆（自我强化）。
 *
 * 本用例锁住缓解：
 *   - 召回块带成对标记，summary 复述后仍可定位边界；
 *   - `withoutRecallRecords` 不只清「整条以标记开头」的记录，也剔除摘要正文里
 *     夹带的完整召回段；
 *   - 摘要里的真实用户发言仍进入巩固窗口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, waitFor } from './helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';

const DRAFT = {
  episode: {
    title: '预算问答',
    summary: '用户询问预算额度。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [],
  reminders: [],
};

function makeCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW });
  const session = ctx.addSession({ id: 'session-1' });
  ctx.commands = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  ctx.tools = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
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
  setTokens(ctx, 1000);
  return { ctx, session, streams };
}

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

function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function turnPayload(session, turnId, message) {
  return {
    agent: { id: session.id, session },
    messages: [message],
    turn: { id: turnId },
    step: 1,
  };
}

/** 复刻 dsh-agent-loop 的逐条 append（runtime-context 之外全部落 surface）。 */
function appendDecision(ctx, session, decision) {
  for (const message of decision?.messages ?? []) {
    if (message?.source?.kind === 'runtime-context') continue;
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: message });
  }
}

/**
 * 平台摘要桩：按真实的 checkpoint 外壳 + 常见「保留原文」策略回显选区。
 * @param {string} regionText
 * @returns {string}
 */
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

function promptText(request) {
  return request.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

test('V4-L2：外部压缩摘要复述召回块时，巩固窗口整段剔除', async () => {
  const temp = makeTempStore();
  const { ctx, session, streams } = makeCtx();
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

    // turn 1：召回命中，注入块带成对标记；平台把用户消息与召回消息都 append。
    const firstMessage = userMessage('预算额度是多少？');
    const first = await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-1', firstMessage), {
      kind: 'enter',
      messages: [firstMessage],
    });
    const recall = (first.messages ?? []).find((message) => message?.source?.kind === RECALL_KIND);
    assert.ok(recall, '本轮应有召回注入');
    const recallText = recall.content[0].text;
    assert.match(recallText, /\[相关记忆\]/u);
    assert.match(recallText, /\[\/相关记忆\]/u, '召回块必须带结束标记，摘要后才能定位边界');
    appendDecision(ctx, session, first);

    // 插件之外：平台压缩 [1,2]，摘要桩回显了选区（含召回段）。
    const compacted = ctx.compactSession(session.id, 1, 2, {
      text: checkpointEcho(`user: 预算额度是多少？\n${recallText}`),
    });
    assert.deepEqual(compacted.nodes, [3], '压缩后 surface 只剩摘要节点');

    // turn 2：新用户消息 + 41K 触发 hard 巩固；窗口覆盖摘要节点。
    const secondMessage = userMessage('继续。');
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: secondMessage });
    setTokens(ctx, 41_000);
    await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-2', secondMessage), {
      kind: 'enter',
      messages: [secondMessage],
    });

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const prompt = promptText(streams[0]);
    const body = prompt.slice(prompt.indexOf('对话：\n') + '对话：\n'.length);

    assert.match(body, /预算额度是多少/u, '摘要里的真实用户发言必须保留');
    assert.doesNotMatch(body, /\[相关记忆\]/u, '摘要正文不得把召回块喂回巩固模型');
    assert.doesNotMatch(body, /\[\/相关记忆\]/u, '结束标记也不得残留');
    assert.doesNotMatch(prompt, /8000/u, '召回块正文（8000）不得进入巩固窗口');

    // 依然正常产出 episode，证明剔除没有把摘要整段丢掉。
    await waitFor(() => temp.store.listEpisodes('main').length === 1, { label: 'episode written' });
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V4-L2：摘要只保留标题、标记不完整时不做越界删除', async () => {
  // 摘要模型可能丢掉结束标记；此时无法确定边界，保留原文交给提示词规则，
  // 但不能把摘要后文一起删掉。
  const temp = makeTempStore();
  const { ctx, session, streams } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const firstMessage = userMessage('先聊天气。');
    const first = await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-1', firstMessage), {
      kind: 'enter',
      messages: [firstMessage],
    });
    appendDecision(ctx, session, first);

    ctx.compactSession(session.id, 1, 1, {
      text: checkpointEcho('user: 先聊天气。\n[相关记忆]\n- 摘要里只有开头标记，后文是真正的对话。'),
    });

    const secondMessage = userMessage('继续。');
    ctx.emitSessionEvent(session.id, { type: 'user/message', data: secondMessage });
    setTokens(ctx, 41_000);
    await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-2', secondMessage), {
      kind: 'enter',
      messages: [secondMessage],
    });

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const body = promptText(streams[0]).split('对话：\n').pop();
    assert.match(body, /后文是真正的对话/u, '找不到结束标记时不得吞掉摘要后文');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
