/**
 * v0.4.6 集成回归（C5-H1a / C5-H1b / C5-H2 / C5-M1 / C5-M2 / C5-L1 全覆盖）。
 *
 * 与各修复自己的专项测试互补：这里全部走真实插件入口 `apply()` +
 * FakeCtx（strict 线程面）+ 真实 adapter + 临时库，把六项修复放回
 * 「调度器 tick → 提醒投递 → 会话面污染 → 线程工具 → 巩固路由 → 命令文案」
 * 同一条链路里，确认它们没有互相踩踏。
 *
 * 覆盖：
 *   C5-H1a 提醒 prompt 第二参是 AbortSignal、requestId 按 occurrence 稳定
 *          （退避重试不换 key）、失败写 delivery_error 并进 /状态「最近失败」、
 *          warn 去重。
 *   C5-H1a 宿主记成 user 的提醒消息不重绑主会话、不进巩固窗口、不喂召回。
 *   C5-H1b strict 宿主无 createSession，线程走 create/resolveAgent，投递带
 *          companion-thread:/companion-task: requestId。
 *   C5-H2  llm 晚注册后巩固成功、/状态 显示自动选取标注；配置 route 优先。
 *   C5-M1  /状态 压缩未开启 / 已开启文案。
 *   C5-L1  无 sessionController 时 /线程 与 /状态 同句提示且不注册线程工具。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';

import { TEST_NOW, makeDraft, makeTempStore, settle, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';
const REMINDER_TEXT = '[提醒] 交房租';
const THREADS_UNSUPPORTED = '线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）';
const COMPACTION_DISABLED = '压缩：宿主未开启（compaction-basic 未启用）';
const COMPACTION_ENABLED = '压缩：宿主已开启（compaction-basic 已启用）';

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
function makeCtx({ now = TEST_NOW, missing = [], strict = false } = {}) {
  const ctx = new FakeCtx({ now, missing, strict });
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

/** prompt 调用 → { request, signal, text }。 */
function promptCalls(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => ({
    request: call.args[0],
    signal: call.args[1],
    text: Array.isArray(call.args[0]?.content)
      ? call.args[0].content.map((part) => part?.text ?? '').join('')
      : '',
  }));
}

/** 巩固模型看到的全部文本。 */
function promptText(request) {
  return (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition;
}

function statusText(ctx) {
  return commandOf(ctx, 'status').handler({ rawInput: '' }).text;
}

function warnLogs(ctx, pattern) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && pattern.test(entry.message));
}

/** 已到期的普通提醒。 */
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

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** 失败事件行（detail_json 解析后）。 */
function deliveryErrorRows(store) {
  return store
    .listEvents({ limit: 200 })
    .filter((row) => row.reason === 'delivery_error')
    .map((row) => ({ row, detail: JSON.parse(row.detail_json) }));
}

/** 一轮用户输入的 pre-step payload。 */
function turnPayload(session, turnId, messages) {
  return {
    agent: { id: session.id, session },
    messages,
    turn: { id: turnId },
    step: 1,
  };
}

/** 复刻平台：宿主在 pre-step 之前已把消息 append 到会话面。 */
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

function hardMeasure() {
  return {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
}

function consolidationRows(store) {
  return store.db.prepare(
    "SELECT id, status FROM consolidations WHERE kind = 'nap' ORDER BY id",
  ).all();
}

// ------------------------------------------------------------ C5-H1a

test('v0.4.6 C5-H1a：提醒投递带 AbortSignal 与稳定 requestId，失败落库、/状态 可见、warn 去重', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '交房租');
  ctx.fail('sessionController.prompt', new TypeError('signal.throwIfAborted is not a function'));

  await firstTick(ctx);

  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1, '失败后不应在同一次 flush 里重复投递');
  // V6-M1：requestId 按 occurrence 稳定（不再随退避改写后的 next_fire_at 变化）。
  const occurrenceKey = temp.store.getReminder(reminder.id).occurrence_key;
  assert.ok(occurrenceKey, '入队前必须生成本次到点的 occurrence_key');
  const firstRequestId = `companion-reminder:${reminder.id}:${occurrenceKey}`;
  assert.equal(calls[0].request.requestId, firstRequestId, '提醒 requestId 必须由 occurrence 决定');
  assert.equal(calls[0].text, REMINDER_TEXT, '正文带 [提醒] 前缀供正文侧排除');
  assert.ok(calls[0].signal instanceof AbortSignal, '第二参必须是 AbortSignal');
  assert.equal(typeof calls[0].signal.throwIfAborted, 'function');
  assert.equal(calls[0].signal.kind, 'user', '旧宿主兼容：signal 上附 kind');
  assert.equal(calls[0].signal.rpcId, firstRequestId, '旧宿主兼容：signal 上附 rpcId');

  const errors = deliveryErrorRows(temp.store);
  assert.equal(errors.length, 1, '每次失败恰好一条 delivery_error');
  assert.equal(errors[0].detail.kind, 'delivery_error');
  assert.equal(errors[0].detail.errorName, 'TypeError');
  assert.equal(errors[0].detail.errorMessage, 'signal.throwIfAborted is not a function');
  assert.equal(errors[0].detail.requestId, firstRequestId);

  assert.match(
    statusText(ctx),
    /最近失败：投递失败：TypeError：signal\.throwIfAborted is not a function/u,
  );

  // 下一次 tick 是同一 occurrence 的退避重试：requestId 不变；失败仍回 pending。
  const failedRow = temp.store.getReminder(reminder.id);
  assert.equal(failedRow.status, 'pending');
  assert.equal(failedRow.delivery_attempts, 1);

  ctx.advance(30_000);
  await ctx.fireTimers();
  await settle(50);

  const retried = promptCalls(ctx);
  assert.equal(retried.length, 2, '退避到期后应重试一次');
  assert.equal(
    retried[1].request.requestId,
    firstRequestId,
    '同一次到点的退避重试必须复用同一个 requestId',
  );
  assert.equal(temp.store.getReminder(reminder.id).occurrence_key, occurrenceKey);
  assert.equal(warnLogs(ctx, /proactive delivery failed/u).length, 1, '同一失败原因只 warn 一次');

  const after = temp.store.getReminder(reminder.id);
  assert.equal(after.status, 'pending', '失败仍回 pending，不异常耗尽');
  assert.equal(after.delivery_attempts, 2);
  assert.equal(deliveryErrorRows(temp.store).length, 2, '每次失败仍各留一条事件');
});

test('v0.4.6 C5-H1a：宿主记成 user 的提醒消息不重绑主会话、不进巩固、不喂召回', async (t) => {
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
      yield { type: 'text-delta', text: JSON.stringify(makeDraft()) };
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
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.returns['tokenMeter.measure'] = hardMeasure();

  const reminderRequestId = 'companion-reminder:rem-1:1700000000';
  const realMessage = userMessage('我下周要把预算调到 8000。');
  const reminderMessage = companionMessage(REMINDER_TEXT, reminderRequestId);
  appendMessage(ctx, session, realMessage);
  appendMessage(ctx, session, reminderMessage);
  const payload = turnPayload(session, 'turn-1', [realMessage, reminderMessage]);
  await ctx.dispatch('agent/pre-step', payload, { kind: 'enter', messages: payload.messages });

  assert.equal(temp.store.getMeta('main_session_id'), 'session-1');

  await waitFor(() => streams.length >= 1, { label: '巩固模型调用' });
  const consolidated = promptText(streams[0]);
  assert.match(consolidated, /8000/u, '真实发言必须进入巩固窗口');
  assert.doesNotMatch(consolidated, /交房租/u, '提醒正文不得作为用户发言进入巩固窗口');
  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '巩固写入' },
  );

  // 另一会话只收到一条提醒（探针场景）：不重绑、不召回、不触发巩固。
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
});

// ------------------------------------------------------------ C5-H1b

test('v0.4.6 C5-H1b：strict 宿主无 createSession，线程走 create/resolveAgent 且 requestId 带 kind', async (t) => {
  const ctx = makeCtx({ strict: true });
  const handle = apply(ctx, { dbPath: ':memory:' }, {
    cwd: '/hooked/cwd',
    now: () => TEST_NOW,
  });
  t.after(() => handle.dispose());

  const controller = ctx.get('sessionController');
  assert.equal(typeof controller.create, 'function');
  assert.equal(typeof controller.resolveAgent, 'function');
  assert.equal(controller.createSession, undefined, '公开服务没有 createSession');

  const adapter = createAdapter(ctx);
  const created = await adapter.createSession({ cwd: '/repo', agentPreset: 'workspace-write' });
  assert.equal(ctx.callsOf('sessionController.createSession').length, 0, '不得调用内部类方法');
  assert.equal(ctx.callsOf('sessionController.create').length, 1);
  assert.equal(created.sessionId, ctx.agents[0].id);
  assert.equal(created.agent, ctx.agents[0]);
  assert.ok(ctx.callsOf('sessionController.resolveAgent').length >= 1);

  await adapter.whenIdle(created.sessionId);
  await adapter.whenIdle(created);
  assert.equal(ctx.callsOf('agent.whenIdle').length, 2);

  const thread = ctx.tools.registrations.find((definition) => definition.name === 'thread_run');
  const task = ctx.tools.registrations.find((definition) => definition.name === 'task_run');
  assert.equal(typeof thread?.execute, 'function');
  assert.equal(typeof task?.execute, 'function');

  const threadResult = await thread.execute({ key: 'new', name: 'v046', goal: '验证公开线程服务' });
  assert.equal(threadResult.ok, true, JSON.stringify(threadResult));
  const createRequest = ctx.callsOf('sessionController.create')[1].args[0];
  assert.equal(createRequest.cwd, '/hooked/cwd');
  assert.equal(
    Object.hasOwn(createRequest, 'agentPreset'),
    false,
    'v0.4.11 起未配置 thread.agentPreset 时不传，走宿主默认',
  );
  const threadRequest = ctx.callsOf('sessionController.prompt')[0].args[0];
  assert.match(threadRequest.requestId, /^companion-thread:.+:run-/);

  const taskResult = await task.execute({ goal: '写一条任务回执', title: 'v046' });
  assert.equal(taskResult.ok, true, JSON.stringify(taskResult));
  const taskRequest = ctx.callsOf('sessionController.prompt')[1].args[0];
  assert.match(taskRequest.requestId, /^companion-task:task-[a-z0-9-]+:claim-/);
});

// ------------------------------------------------------------ C5-H2

test('v0.4.6 C5-H2：apply 时无 llm，稍后注册仍能巩固并显示自动选取 route', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-late-llm',
    events: [
      { seq: 7, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '更早的一轮对话。' }] } },
      { seq: 8, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '再早一点。' }] } },
    ],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await settle(20);
  assert.match(statusText(ctx), /巩固：无可用模型/u);

  ctx.advance(30_000);
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream(request) {
      const prompt = request?.messages?.[0]?.content?.[0]?.text ?? '';
      if (!prompt.includes('记忆巩固器')) {
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'finish', reason: { kind: 'ok' } };
        return;
      }
      yield { type: 'text-delta', text: JSON.stringify(makeDraft()) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };

  ctx.returns['tokenMeter.measure'] = hardMeasure();
  await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-late', [
    { role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] },
  ]), { kind: 'enter', messages: [] });

  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '晚注册 llm 后巩固成功' },
  );
  assert.match(statusText(ctx), /巩固：deepseek-official\/deepseek-chat（自动选取）/u);
});

test('v0.4.6 C5-H2：consolidation.model 配置优先，/状态 标注（配置）且请求走该 route', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const requests = [];
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream(request) {
      requests.push({
        provider: request?.provider,
        model: request?.model,
        prompt: request?.messages?.[0]?.content?.[0]?.text ?? '',
      });
      yield { type: 'text-delta', text: JSON.stringify(makeDraft()) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const session = ctx.addSession({
    id: 'session-config-route',
    events: [
      { seq: 7, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '更早的一轮对话。' }] } },
      { seq: 8, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '再早一点。' }] } },
    ],
  });
  const handle = apply(ctx, {
    dbPath: temp.dbPath,
    retainTokens: 4,
    consolidation: { model: { provider: 'magpie', model: 'main-model' } },
  });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  assert.match(statusText(ctx), /巩固：magpie\/main-model（配置）/u);

  ctx.returns['tokenMeter.measure'] = hardMeasure();
  await ctx.dispatch('agent/pre-step', turnPayload(session, 'turn-config', [
    { role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] },
  ]), { kind: 'enter', messages: [] });

  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '配置 route 巩固成功' },
  );
  const consolidation = requests.find((request) => request.prompt.includes('记忆巩固器'));
  assert.ok(consolidation, '应发起巩固调用');
  assert.equal(consolidation.provider, 'magpie');
  assert.equal(consolidation.model, 'main-model');
});

// ------------------------------------------------------------ C5-M1

test('v0.4.6 C5-M1：/状态 反映宿主压缩开关（未开启 / 已开启）', async (t) => {
  const disabledCtx = makeCtx({ missing: ['compaction'] });
  const disabledHandle = apply(disabledCtx, { dbPath: ':memory:' });
  try {
    const text = statusText(disabledCtx);
    assert.match(text, new RegExp(COMPACTION_DISABLED.replace(/[()]/gu, '\\$&'), 'u'));
    assert.doesNotMatch(text, /压缩：宿主已开启/u);
  } finally {
    disabledHandle.dispose();
  }

  const enabledCtx = makeCtx();
  const enabledHandle = apply(enabledCtx, { dbPath: ':memory:' });
  try {
    assert.match(statusText(enabledCtx), /压缩：宿主已开启（compaction-basic 已启用）/u);
  } finally {
    enabledHandle.dispose();
  }
});

// ------------------------------------------------------------ C5-L1

test('v0.4.6 C5-L1 / V7-H1：无 sessionController 时 /线程 与 /状态 同句提示，线程工具仍注册但返回 capability_missing', async (t) => {
  const ctx = makeCtx({ missing: ['sessionController'], strict: true });
  const handle = apply(ctx, { dbPath: ':memory:' });
  t.after(() => handle.dispose());

  const reply = commandOf(ctx, 'threads').handler({ rawInput: '' }).text;
  assert.equal(reply, THREADS_UNSUPPORTED);
  assert.doesNotMatch(reply, /线程目录/u);
  assert.ok(
    statusText(ctx).includes(THREADS_UNSUPPORTED),
    '/状态 与 /线程 必须共用同一句宿主不支持提示',
  );
  for (const name of ['thread_list', 'thread_run', 'task_run']) {
    const definition = ctx.tools.registrations.find((entry) => entry.name === name);
    assert.ok(definition, `${name} 仍应注册（V7-H1：宿主可能晚挂载）`);
    const result = await definition.execute({ key: 'new', name: 'x', goal: 'y' });
    assert.deepEqual(result, {
      ok: false,
      reason: 'capability_missing',
      message: '宿主未提供 sessionController，线程工具暂不可用',
    });
  }
});
