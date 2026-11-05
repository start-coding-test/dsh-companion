import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdapter } from '../src/platform/adapter.js';
import { PlatformError } from '../src/platform/errors.js';
import { FakeCtx } from './fakes/ctx.js';

const agent = { id: 'agent-1' };

test('PlatformError 带 name、code，并回退 message', () => {
  const error = new PlatformError('no-compaction', 'missing backend');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PlatformError');
  assert.equal(error.code, 'no-compaction');
  assert.equal(error.message, 'missing backend');

  const fallback = new PlatformError('only-code');
  assert.equal(fallback.message, 'only-code');
});

test('now 转发注入时钟，并随手动时钟推进', () => {
  const ctx = new FakeCtx({ now: 1_700_000_000_000 });
  const adapter = createAdapter(ctx);
  assert.equal(adapter.now(), 1_700_000_000_000);
  ctx.advance(250);
  assert.equal(adapter.now(), 1_700_000_000_250);

  const overridden = createAdapter(ctx, { now: () => 42 });
  assert.equal(overridden.now(), 42);
});

test('log 转发级别、消息与 meta', () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  assert.equal(adapter.log('warn', 'hello', { attempt: 1 }), true);
  adapter.log('info', 'plain');
  assert.deepEqual(ctx.logs, [
    { level: 'warn', message: 'hello', meta: { attempt: 1 } },
    { level: 'info', message: 'plain', meta: undefined },
  ]);
  assert.throws(() => adapter.log('trace', 'nope'), TypeError);
});

test('宿主无 logger 时 log 安静跳过', () => {
  const ctx = new FakeCtx({ missing: ['logger'] });
  const adapter = createAdapter(ctx);
  assert.equal(adapter.capabilities.logger, false);
  assert.equal(adapter.log('error', 'ignored'), false);
});

test('section 原样转发并返回平台 disposer', () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  const spec = { name: 'dsh-companion', order: 40, text: () => 'memory' };
  const disposer = adapter.section(spec);

  assert.equal(ctx.callsOf('systemPrompt.section').length, 1);
  assert.equal(ctx.callsOf('systemPrompt.section')[0].args[0], spec);
  assert.equal(typeof disposer, 'function');
  assert.equal(ctx.sections[0].disposed, false);
  disposer();
  assert.equal(ctx.sections[0].disposed, true);
});

test('onPreStep 注入：追加到进入批次并保留决策字段', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  let received;
  // V4-L1：注入项必须是完整平台消息（id/role/content/source.kind）。
  const injected = {
    id: 'recall-1',
    role: 'user',
    content: [{ type: 'text', text: '<memory/>' }],
    source: { kind: 'companion-recall', form: 'snapshot', sections: [] },
  };
  adapter.onPreStep((payload, decision) => {
    received = { payload, decision };
    return { inject: [injected] };
  });

  const payload = {
    agent,
    messages: [{ role: 'user', content: 'hi' }],
    turn: 1,
    step: 0,
    signal: undefined,
  };
  const fallback = () => ({
    kind: 'enter',
    messages: [{ role: 'user', content: 'hi' }],
    startsRequestSeries: true,
  });
  const decision = await ctx.dispatch('agent/pre-step', payload, fallback);

  assert.equal(decision.kind, 'enter');
  assert.deepEqual(decision.messages, [
    { role: 'user', content: 'hi' },
    injected,
  ]);
  assert.equal(decision.startsRequestSeries, true, '必须保留上游决策字段');
  assert.equal(received.payload, payload);
  assert.equal(received.decision.kind, 'enter');
});

test('onPreStep 替换：messages 整体替换进入批次', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ messages: [{ role: 'user', content: 'only' }] }));

  const decision = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [{ role: 'user', content: 'a' }], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [{ role: 'user', content: 'a' }], startsRequestSeries: false }),
  );

  assert.deepEqual(decision, {
    kind: 'enter',
    messages: [{ role: 'user', content: 'only' }],
    startsRequestSeries: false,
  });
});

test('onPreStep 支持原生 enter 决策', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ kind: 'enter', messages: [{ role: 'user', content: 'raw' }] }));

  const decision = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [] }),
  );
  assert.deepEqual(decision.messages, [{ role: 'user', content: 'raw' }]);
});

test('onPreStep 拒绝：reject 透传且不再调用 handler', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  let handlerCalled = false;
  adapter.onPreStep(() => {
    handlerCalled = true;
    return { reject: true };
  });

  const rejected = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'reject' }),
  );
  assert.deepEqual(rejected, { kind: 'reject' });
  assert.equal(handlerCalled, false, '上游已 reject 时 handler 不应执行');

  const rejectedByHandler = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(rejectedByHandler.kind, 'reject');
  assert.equal(handlerCalled, true);
});

test('onPreStep 返回 undefined 时不修改决策', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => undefined);
  const original = { kind: 'enter', messages: [{ role: 'user', content: 'hi' }], startsRequestSeries: true };

  const decision = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => original,
  );
  assert.equal(decision, original);
});

test('onPreStep disposer 注销监听器', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  let calls = 0;
  const dispose = adapter.onPreStep(() => {
    calls += 1;
  });
  dispose();

  await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(calls, 0);
  assert.equal(ctx.listeners.get('agent/pre-step')[0].disposed, true);
});

test('onPreStep 拒绝 messages 与 inject 同时出现', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ messages: [], inject: [] }));

  await assert.rejects(
    () => ctx.dispatch('agent/pre-step', { agent, messages: [], turn: 1, step: 0 }, () => ({
      kind: 'enter',
      messages: [],
    })),
    TypeError,
  );
});

test('every 转发 callback/delay，触发有效且 dispose 后停止', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  let ticks = 0;
  const dispose = adapter.every(30_000, () => {
    ticks += 1;
  });

  assert.equal(ctx.callsOf('interval').length, 1);
  assert.equal(ctx.callsOf('interval')[0].args[1], 30_000);
  await ctx.fireTimers(2);
  assert.equal(ticks, 2);

  dispose();
  await ctx.fireTimers(1);
  assert.equal(ticks, 2);
  assert.equal(ctx.timers[0].disposed, true);
  assert.throws(() => adapter.every(0, () => {}), TypeError);
});

test('compactRegion 原样转发参数与返回值', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  const signal = new AbortController().signal;

  const result = await adapter.compactRegion(10, 20, agent, signal);
  const call = ctx.callsOf('compaction.compactRegion')[0];
  assert.deepEqual(call.args, [10, 20, agent, signal]);
  assert.equal(result.start, 10);
  assert.equal(result.end, 20);
});

test('createSession/whenIdle 转发：公开 create + resolveAgent 归一', async () => {
  const ctx = new FakeCtx({ strict: true });
  const adapter = createAdapter(ctx);
  const request = { cwd: 'D:/work' };

  const created = await adapter.createSession(request);
  // C5-H1b：转发到公开服务 create()（不是内部类 createSession）。
  assert.equal(ctx.callsOf('sessionController.create')[0].args[0], request);
  assert.equal(ctx.callsOf('sessionController.createSession').length, 0);
  // 归一成历史约定 {agent, agentPreset, sessionId}，agent 由 resolveAgent 反查。
  assert.ok(created.agent);
  assert.equal(created.sessionId, created.agent.id);
  assert.equal(ctx.callsOf('sessionController.resolveAgent')[0].args[0], created.sessionId);

  const first = await adapter.whenIdle(created.agent);
  assert.deepEqual(first, { id: created.agent.id });
  await adapter.whenIdle(created);
  assert.equal(ctx.callsOf('agent.whenIdle').length, 2);

  await assert.rejects(
    () => adapter.whenIdle({}),
    (error) => error instanceof PlatformError && error.code === 'no-when-idle',
  );
  // 支持直接传会话 id：经 resolveAgent 反查后 whenIdle。
  await adapter.whenIdle(created.sessionId);
  assert.equal(ctx.callsOf('agent.whenIdle').length, 3);
});

test('prompt 第二个参数是 AbortSignal，requestId 稳定可去重', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  const request = {
    sessionId: 's-1',
    requestId: 'req-1',
    content: [{ type: 'text', text: 'hi' }],
  };

  await adapter.prompt(request);
  const call = ctx.callsOf('sessionController.prompt')[0];
  assert.deepEqual(call.args[0], request);
  const signal = call.args[1];
  assert.ok(signal instanceof AbortSignal);
  assert.equal(typeof signal.throwIfAborted, 'function');
  // 旧宿主兼容：signal 上尽量附加 kind/rpcId。
  assert.equal(signal.kind, 'user');
  assert.equal(signal.rpcId, 'req-1');

  await adapter.prompt({ sessionId: 's-2', content: [] });
  const fallback = ctx.callsOf('sessionController.prompt')[1];
  assert.ok(fallback.args[1] instanceof AbortSignal);
  assert.match(fallback.args[0].requestId, /^companion-/);
  assert.equal(fallback.args[1].rpcId, fallback.args[0].requestId);
});

test('cancel 接受 sessionId 字符串或 request 对象', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);

  await adapter.cancel('s-1');
  assert.deepEqual(ctx.callsOf('sessionController.cancel')[0].args[0], { sessionId: 's-1' });

  const request = { sessionId: 's-2' };
  await adapter.cancel(request);
  assert.equal(ctx.callsOf('sessionController.cancel')[1].args[0], request);
});

test('archiveSession 转发 sessionId 与 stopActivity 选项', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);

  await adapter.archiveSession('s-9', { stopActivity: true });
  assert.deepEqual(ctx.callsOf('workspaceRegistry.archiveSession')[0].args, [
    's-9',
    { stopActivity: true },
  ]);

  await adapter.archiveSession('s-10');
  assert.deepEqual(ctx.callsOf('workspaceRegistry.archiveSession')[1].args, ['s-10', {}]);
});

test('measure 转发 session 与 requestHeader', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  const session = { id: 'session-1' };
  const header = { provider: 'magpie', model: 'commandcode/deepseek/deepseek-v4.1-flash' };

  const measured = await adapter.measure(session, header);
  assert.deepEqual(ctx.callsOf('tokenMeter.measure')[0].args, [session, header]);
  assert.equal(measured.totalTokens, 1000);
});

test('capabilities 反映宿主能力', () => {
  const full = createAdapter(new FakeCtx());
  assert.deepEqual({ ...full.capabilities }, {
    systemPrompt: true,
    preStep: true,
    turnStopping: true,
    timer: true,
    compaction: true,
    sessionController: true,
    threadTools: true,
    archive: true,
    tokenMeter: true,
    tokenEstimator: true,
    sessionEvent: true,
    sessionQuery: true,
    inbox: true,
    logger: true,
    commands: false,
    tools: false,
    unarchive: false,
    llm: false,
  });

  const partial = createAdapter(new FakeCtx({ missing: ['compaction', 'tokenMeter'] }));
  assert.equal(partial.capabilities.compaction, false);
  assert.equal(partial.capabilities.tokenMeter, false);
  assert.equal(partial.capabilities.sessionController, true);
  // V3-H3②：线程/任务工具门槛与 sessionController 同源；缺失时为 false。
  assert.equal(partial.capabilities.threadTools, true);
  const noSession = createAdapter(new FakeCtx({ missing: ['sessionController'] }));
  assert.equal(noSession.capabilities.sessionController, false);
  assert.equal(noSession.capabilities.threadTools, false);
});

const missingCases = [
  ['systemPrompt', 'no-system-prompt', (adapter) => adapter.section({ name: 'x', order: 1, text: 'x' })],
  ['on', 'no-pre-step', (adapter) => adapter.onPreStep(() => undefined)],
  ['timer', 'no-timer', (adapter) => adapter.every(1_000, () => {})],
  ['compaction', 'no-compaction', (adapter) => adapter.compactRegion(1, 2, agent)],
  ['sessionController.create', 'no-session', (adapter) => adapter.createSession({ cwd: '.' })],
  ['sessionController.prompt', 'no-session', (adapter) => adapter.prompt({ sessionId: 's', content: [] })],
  ['sessionController.cancel', 'no-session', (adapter) => adapter.cancel('s')],
  ['workspaceRegistry', 'no-archive', (adapter) => adapter.archiveSession('s')],
  ['tokenMeter', 'no-token-meter', (adapter) => adapter.measure({ id: 's' })],
];

for (const [missing, code, invoke] of missingCases) {
  test(`缺少 ${missing} 时抛 PlatformError(${code})`, () => {
    const ctx = new FakeCtx({ missing: [missing] });
    const adapter = createAdapter(ctx);
    assert.throws(
      () => invoke(adapter),
      (error) => error instanceof PlatformError && error.code === code,
    );
  });
}

test('FakeCtx 可注入平台失败并原样冒泡', async () => {
  const boom = new Error('boom');
  const ctx = new FakeCtx({ fail: { 'compaction.compactRegion': boom } });
  const adapter = createAdapter(ctx);
  assert.throws(() => adapter.compactRegion(1, 2, agent), (error) => error === boom);

  const idleCtx = new FakeCtx({ fail: { 'agent.whenIdle': boom } });
  const idleAdapter = createAdapter(idleCtx);
  const created = await idleAdapter.createSession({ cwd: '.' });
  await assert.rejects(() => idleAdapter.whenIdle(created.agent), (error) => error === boom);
});

test('createAdapter 拒绝非对象 ctx', () => {
  assert.throws(() => createAdapter(null), TypeError);
  assert.throws(() => createAdapter('ctx'), TypeError);
});

// ------------------------------------------------- V3-H1：inject 必须是平台消息

test('onPreStep 注入裸内容块：TypeError，不再把 undefined source 留给平台', async () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ inject: [{ type: 'text', text: '[相关记忆]\n- 旧块' }] }));

  await assert.rejects(
    () =>
      ctx.dispatch(
        'agent/pre-step',
        { agent, messages: [{ role: 'user', content: 'hi' }], turn: 1, step: 0 },
        () => ({ kind: 'enter', messages: [] }),
      ),
    // V4-L1：裸块最先缺的是 id（平台的必填字段），错误必须点名字段。
    (error) => error instanceof TypeError && /"id"/u.test(error.message),
  );
});

test('onPreStep 注入形状校验：role 与 content 非法都抛 TypeError', async () => {
  const cases = [
    [{ id: 'm1', content: [] }, /"role"/u],
    [{ id: 'm1', role: 42, content: [] }, /"role"/u],
    [{ id: 'm1', role: 'user' }, /"content"/u],
    [{ id: 'm1', role: 'user', content: 42 }, /"content"/u],
    [null, /platform message object/u],
    [[], /platform message object/u],
  ];

  for (const [inject, pattern] of cases) {
    const ctx = new FakeCtx();
    const adapter = createAdapter(ctx);
    adapter.onPreStep(() => ({ inject: [inject] }));
    await assert.rejects(
      () =>
        ctx.dispatch(
          'agent/pre-step',
          { agent, messages: [], turn: 1, step: 0 },
          () => ({ kind: 'enter', messages: [] }),
        ),
      (error) => error instanceof TypeError && pattern.test(error.message),
      `inject=${JSON.stringify(inject)} 应被拒绝`,
    );
  }
});

// ------------------------------------------------- V4-L1：id 与 source.kind 必填

/** 合法注入消息（形状对齐 src/index.js 的 recallMessage）。 */
function validInject(overrides = {}) {
  return {
    id: 'recall-1',
    role: 'user',
    content: [{ type: 'text', text: '[相关记忆]\\n- 预算 8000' }],
    source: {
      kind: 'companion-recall',
      form: 'snapshot',
      sections: [{ name: 'recall', text: '...' }],
    },
    ...overrides,
  };
}

test('onPreStep 注入缺 id 或 id 非法：TypeError 点名字段', async () => {
  const cases = [
    [{ id: undefined }, /"id"/u],
    [{ id: '' }, /"id"/u],
    [{ id: 42 }, /"id"/u],
  ];
  for (const [overrides, pattern] of cases) {
    const ctx = new FakeCtx();
    const adapter = createAdapter(ctx);
    const message = validInject(overrides);
    if (overrides.id === undefined) delete message.id;
    adapter.onPreStep(() => ({ inject: [message] }));
    await assert.rejects(
      () =>
        ctx.dispatch(
          'agent/pre-step',
          { agent, messages: [], turn: 1, step: 0 },
          () => ({ kind: 'enter', messages: [] }),
        ),
      (error) => error instanceof TypeError && pattern.test(error.message)
        && error.message.includes('"id"'),
      `inject.id=${JSON.stringify(overrides.id)} 应被拒绝`,
    );
  }
});

test('onPreStep 注入缺 source 或 source.kind 非法：TypeError 点名字段', async () => {
  const cases = [
    [{ source: undefined }, /"source"/u],
    [{ source: null }, /"source"/u],
    [{ source: 'companion-recall' }, /"source"/u],
    [{ source: [] }, /"source"/u],
    [{ source: {} }, /"source\.kind"/u],
    [{ source: { kind: '' } }, /"source\.kind"/u],
    [{ source: { kind: 42 } }, /"source\.kind"/u],
  ];
  for (const [overrides, pattern] of cases) {
    const ctx = new FakeCtx();
    const adapter = createAdapter(ctx);
    const message = validInject(overrides);
    if (overrides.source === undefined) delete message.source;
    adapter.onPreStep(() => ({ inject: [message] }));
    await assert.rejects(
      () =>
        ctx.dispatch(
          'agent/pre-step',
          { agent, messages: [], turn: 1, step: 0 },
          () => ({ kind: 'enter', messages: [] }),
        ),
      (error) => error instanceof TypeError && pattern.test(error.message),
      `inject.source=${JSON.stringify(overrides.source)} 应被拒绝`,
    );
  }
});

test('onPreStep 注入 role/content 不合规：TypeError 点名字段', async () => {
  const cases = [
    [{ role: 'assistant' }, /"role"/u],
    [{ role: 'system' }, /"role"/u],
    [{ role: '' }, /"role"/u],
    [{ content: [] }, /"content"/u],
    [{ content: 'text' }, /"content"/u],
    [{ content: undefined }, /"content"/u],
  ];
  for (const [overrides, pattern] of cases) {
    const ctx = new FakeCtx();
    const adapter = createAdapter(ctx);
    const message = validInject(overrides);
    if (overrides.content === undefined) delete message.content;
    adapter.onPreStep(() => ({ inject: [message] }));
    await assert.rejects(
      () =>
        ctx.dispatch(
          'agent/pre-step',
          { agent, messages: [], turn: 1, step: 0 },
          () => ({ kind: 'enter', messages: [] }),
        ),
      (error) => error instanceof TypeError && pattern.test(error.message),
      `inject=${JSON.stringify(overrides)} 应被拒绝`,
    );
  }
});

test('onPreStep 注入真实召回消息形状：通过且原样追加', async () => {
  const message = validInject();
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ inject: [message] }));

  const decision = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [] }),
  );
  assert.deepEqual(decision.messages, [message]);
  assert.equal(decision.messages[0], message);
});

test('onPreStep 注入完整平台消息：原样追加，不被改写', async () => {
  const message = {
    id: 'recall-1',
    role: 'user',
    content: [{ type: 'text', text: '[相关记忆]\n- 预算 8000' }],
    source: {
      kind: 'companion-recall',
      form: 'snapshot',
      sections: [{ name: 'recall', text: '...' }],
    },
  };
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  adapter.onPreStep(() => ({ inject: [message] }));

  const base = { role: 'user', content: 'hi' };
  const decision = await ctx.dispatch(
    'agent/pre-step',
    { agent, messages: [base], turn: 1, step: 0 },
    () => ({ kind: 'enter', messages: [base] }),
  );

  assert.equal(decision.messages.length, 2);
  assert.equal(decision.messages[0], base);
  assert.equal(decision.messages[1], message, '必须原样交给平台，不做拷贝/改写');
});
