/**
 * C5-H1a 专项回归：提醒投递签名与用户消息污染隔离。
 *
 * 云端 DSH 0.2.1-rc.5 的 `ApiSessionList.prompt(request, signal)` 第二参是
 * AbortSignal，消息 source 由宿主按 `request.requestId` 构造为
 * `{ kind: 'user', rpcId }`；因此：
 *   1) adapter 必须传 AbortSignal（旧宿主兼容：在 signal 上挂 kind/rpcId）；
 *   2) 每次投递都必须带 requestId，且同一次到点（occurrence）内的退避重试保持一致；
 *   3) 宿主会把这条消息记成 kind:'user'，巩固转录 / 主会话重绑 / 召回查询
 *      三处都必须按 rpcId 前缀或 `[提醒] ` 正文前缀排除；
 *   4) 投递失败写 memory_events(kind='delivery_error')，/状态「最近失败」可见。
 *
 * 全部走真实插件入口 `apply()` + FakeCtx + 真实 adapter + 临时库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { createProactive, DELIVERY_ERROR_KIND } from '../src/runtime/proactive.js';
import { Store } from '../src/memory/store.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';
const REMINDER_REQUEST_PREFIX = 'companion-reminder:';
const REMINDER_TEXT = '[提醒] 交房租';

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

/** prompt 调用 → { request, signal }。 */
function promptCalls(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => ({
    request: call.args[0],
    signal: call.args[1],
    text: Array.isArray(call.args[0]?.content)
      ? call.args[0].content.map((part) => part?.text ?? '').join('')
      : '',
  }));
}

/** 一轮真实用户输入的 pre-step payload。 */
function turnPayload(session, turnId, messages) {
  return {
    agent: { id: session.id, session },
    messages,
    turn: { id: turnId },
    step: 1,
  };
}

/** 复刻平台：把消息 append 到会话面（宿主在 pre-step 之前就已落库）。 */
function appendMessage(ctx, session, message) {
  ctx.emitSessionEvent(session.id, { type: 'user/message', data: message });
}

/** 宿主记录的通知消息：source 由 requestId 构造，kind 仍是 'user'。 */
function companionMessage(text, requestId) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: requestId },
  };
}

/** 用户真消息。 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
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

/** 巩固模型看到的全部文本。 */
function promptText(request) {
  return (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** 失败事件行（detail_json 解析后）。 */
function deliveryErrorRows(store) {
  return store
    .listEvents({ limit: 200 })
    .filter((row) => row.reason === DELIVERY_ERROR_KIND)
    .map((row) => ({ row, detail: JSON.parse(row.detail_json) }));
}

// ---------------------------------------------------- 1. 投递通道单元

test('C5-H1a：requestId 贯穿投递重试，失败写 memory_events', async () => {
  const store = Store.open(':memory:');
  try {
    const calls = [];
    let remainingFailures = 1;
    const clock = () => TEST_NOW;
    const gate = createProactive({
      store,
      platform: {
        now: clock,
        prompt: async (sessionId, text, options = {}) => {
          calls.push({ sessionId, text, options });
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw new TypeError('signal.throwIfAborted is not a function');
          }
        },
      },
      config: { timezone: 'Asia/Shanghai' },
      target: () => 'main-1',
      clock,
    });

    gate.enqueue({
      kind: 'chat',
      text: '今天想聊聊吗',
      dedupeKey: 'chat:1',
      requestId: 'companion-chat:2026-11-05:daily',
      at: TEST_NOW,
    });

    const failed = await gate.flush(TEST_NOW);
    assert.equal(failed.failed, 1);
    assert.equal(failed.sent, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.requestId, 'companion-chat:2026-11-05:daily');

    // 同一次 claim 内的重试必须复用同一个 requestId，否则宿主会重复投递。
    const retried = await gate.flush(TEST_NOW + 60_000);
    assert.equal(retried.sent, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.requestId, calls[0].options.requestId);
    assert.equal(calls[1].text, calls[0].text);

    const rows = deliveryErrorRows(store);
    assert.equal(rows.length, 1, '每次失败恰好一条 delivery_error');
    assert.equal(rows[0].detail.kind, 'delivery_error');
    assert.equal(rows[0].detail.errorName, 'TypeError');
    assert.equal(rows[0].detail.errorMessage, 'signal.throwIfAborted is not a function');
    assert.equal(rows[0].detail.requestId, 'companion-chat:2026-11-05:daily');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------- 2. 真实链路投递

test('C5-H1a：提醒投递带 companion-reminder requestId 与 AbortSignal，失败可见且不耗尽', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '交房租');
    ctx.fail('sessionController.prompt', new TypeError('signal.throwIfAborted is not a function'));

    await firstTick(ctx);

    const calls = promptCalls(ctx);
    assert.equal(calls.length, 1, '失败后不应在同一次 flush 里重复投递');
    // V6-M1：requestId 由本次到点的 occurrence_key 决定（不再用 next_fire_at）。
    const failedRow = temp.store.getReminder(reminder.id);
    const firstRequestId = `companion-reminder:${reminder.id}:${failedRow.occurrence_key}`;
    assert.ok(failedRow.occurrence_key, '入队前必须生成本次到点的 occurrence_key');
    assert.equal(calls[0].request.requestId, firstRequestId, '提醒 requestId 必须由 occurrence 决定');
    assert.equal(calls[0].text, REMINDER_TEXT, '正文带 [提醒] 前缀供正文侧排除');
    assert.ok(calls[0].signal instanceof AbortSignal, '第二参必须是 AbortSignal');
    assert.equal(typeof calls[0].signal.throwIfAborted, 'function');
    assert.equal(calls[0].signal.kind, 'user', '旧宿主兼容：signal 上附 kind');
    assert.equal(calls[0].signal.rpcId, firstRequestId, '旧宿主兼容：signal 上附 rpcId');

    const failed = temp.store.getReminder(reminder.id);
    assert.equal(failed.status, 'pending', '投递失败必须回 pending');
    assert.equal(failed.delivery_attempts, 1, '一次 flush 只算一次尝试');

    const errors = deliveryErrorRows(temp.store);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].detail.errorName, 'TypeError');
    assert.equal(errors[0].detail.errorMessage, 'signal.throwIfAborted is not a function');
    assert.equal(errors[0].detail.requestId, firstRequestId);
    assert.equal(errors[0].detail.kind, 'delivery_error');

    // /状态 的「最近失败」必须显示这条投递失败。
    const status = ctx.commands.registrations.find(
      (registration) => registration.definitionId === 'dsh-companion/command-status',
    );
    assert.ok(status, '必须注册 /状态 命令');
    const reply = status.handler({ rawInput: '' });
    assert.match(reply.text, /最近失败：投递失败：TypeError：signal\.throwIfAborted is not a function/u);

    // 下一次 tick 是同一 occurrence 的重试：occurrence_key 不变，requestId 必须一致。
    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    const retriedCalls = promptCalls(ctx);
    assert.equal(retriedCalls.length, 2, '退避到期后应重试一次');
    assert.equal(
      retriedCalls[1].request.requestId,
      firstRequestId,
      '同一次到点的退避重试必须复用同一个 requestId，宿主才能去重',
    );
    const stillFailing = temp.store.getReminder(reminder.id);
    assert.equal(stillFailing.status, 'pending', '失败仍回 pending，等待下一次退避重试');
    assert.equal(stillFailing.delivery_attempts, 2, '两个 tick 只累计两次尝试，不异常耗尽');
    assert.equal(deliveryErrorRows(temp.store).length, 2, '每次失败都留一条 delivery_error');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------- 3. 用户消息污染隔离

test('C5-H1a：宿主记成 user 的提醒消息不重绑主会话、不进巩固、不喂召回', async () => {
  const temp = makeTempStore();
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
            title: '预算调整',
            summary: '用户说预算调到 8000。',
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
  // 召回库：只要查询用到提醒正文，就会命中这条事实并注入。
  temp.store.insertFact({
    scope: 'main',
    kind: 'other',
    subject_text: '房租',
    predicate: '期限',
    object_text: '周五',
    statement: '房租要在周五前交。',
    source_kind: 'turn',
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    // 强制触发 hard 巩固（config.compactHardTokens 默认 ~40000）。
    ctx.returns['tokenMeter.measure'].totalTokens = 41_000;

    // turn 1：真实发言 + 同一轮里的提醒投递（宿主把两者都记成 user）。
    const reminderRequestId = 'companion-reminder:rem-1:1700000000';
    const realMessage = userMessage('我下周要把预算调到 8000。');
    const reminderMessage = companionMessage(REMINDER_TEXT, reminderRequestId);
    appendMessage(ctx, session, realMessage);
    appendMessage(ctx, session, reminderMessage);
    const payload = turnPayload(session, 'turn-1', [realMessage, reminderMessage]);
    await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });

    // 真实发言仍然建立主会话绑定。
    assert.equal(temp.store.getMeta('main_session_id'), 'session-1');

    await waitFor(() => streams.length >= 1, { label: '巩固模型调用' });
    const consolidated = promptText(streams[0]);
    assert.match(consolidated, /8000/u, '真实发言必须进入巩固窗口');
    assert.doesNotMatch(consolidated, /交房租/u, '提醒正文不得作为用户发言进入巩固窗口');

    // turn 2：另一个会话里只收到一条提醒（探针场景）。
    const probe = ctx.addSession({ id: 'session-2' });
    ctx.returns['tokenMeter.measure'].totalTokens = 1_000;
    const probeMessage = companionMessage(REMINDER_TEXT, reminderRequestId);
    appendMessage(ctx, probe, probeMessage);
    const probePayload = turnPayload(probe, 'turn-2', [probeMessage]);
    const probeDecision = await ctx.dispatch('agent/pre-step', probePayload, {
      kind: 'enter',
      messages: probePayload.messages,
    });
    await settle(50);

    assert.equal(
      temp.store.getMeta('main_session_id'),
      'session-1',
      '提醒消息不能把主会话重绑到探针会话',
    );
    const recall = (probeDecision.messages ?? []).find(
      (message) => message?.source?.kind === RECALL_KIND,
    );
    assert.equal(recall, undefined, '提醒正文不得作为召回查询');
    assert.equal(streams.length, 1, '提醒消息独有的一轮不应触发巩固');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
