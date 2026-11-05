/**
 * C5-H2：巩固模型解析回归。
 *
 * 覆盖 05 必修：
 *   - apply 时 llm 服务尚未注册，之后出现仍能解析成功（否定结果不缓存）；
 *   - provider 的模型列表为空时跳过，取第一个有模型的 provider；
 *   - consolidation.model 配置优先于运行时探测；
 *   - 闲聊与巩固共用同一 route；
 *   - 无可用模型时 /状态 文案为「巩固：无可用模型」并写可观察失败。
 *
 * 只走真实 apply() + FakeCtx + 临时库 + 手动时钟；不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis, inject } from '../src/index.js';
import { ConfigError, DEFAULTS, normalizeConfig } from '../src/config.js';
import { strictCtx } from './helpers/strict-ctx.js';

import { TEST_NOW, makeDraft, makeTempStore, settle, waitFor } from './e2e/helpers.js';

// C-H1：apply 一律经严格 ctx 代理，未声明 inject 的属性读会像真实 cordis 一样抛错。
const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const FIVE_SENTENCES = '今天天气不错。路上看到一棵银杏。中午吃了面。下午把桌子收拾了。晚上准备早点休息。';

/** 触发 hard 巩固的 token 计量返回值。 */
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

function userEvent(text, seq) {
  return {
    seq,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function makeCtx(now = TEST_NOW) {
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
  return ctx;
}

function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition;
}

function statusText(ctx) {
  return commandOf(ctx, 'status').handler({ rawInput: '' }).text;
}

function preStepPayload(session, turn, text, step = 1) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** 记录每次 stream 调用的 provider/model/prompt。 */
function recordingLlm({ providers, models, stream }) {
  const requests = [];
  return {
    requests,
    listProviders: () => providers,
    listModels: (provider) => models(provider),
    async *stream(request) {
      requests.push({
        provider: request?.provider,
        model: request?.model,
        prompt: request?.messages?.[0]?.content?.[0]?.text ?? '',
      });
      yield* stream(request);
    },
  };
}

function draftStream() {
  return (async function* stream() {
    yield { type: 'text-delta', text: JSON.stringify(makeDraft()) };
    yield { type: 'finish', reason: { kind: 'ok' } };
  })();
}

function consolidationRows(store) {
  return store.db.prepare(
    "SELECT id, status FROM consolidations WHERE kind = 'nap' ORDER BY id",
  ).all();
}

test('C5-H2：apply 时 llm 不存在，稍后注册仍能完成巩固', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({
    id: 'session-late-llm',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // apply 时还没有 llm 服务：能力位为 false，/状态 不得显示"解析中"以外的假路由。
  assert.equal(inject.includes('llm'), false, 'llm 不是 inject 服务，必须运行时探活');
  await settle(20);
  assert.match(statusText(ctx), /巩固：无可用模型/u);

  // 约 30 秒后 dsh-llm 才挂载。
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
  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });

  const rows = await waitFor(
    () => {
      const written = consolidationRows(temp.store).filter((row) => row.status === 'written');
      return written.length > 0 ? written : null;
    },
    { label: '晚注册 llm 后巩固成功' },
  );
  assert.equal(rows[0].status, 'written');
  assert.match(statusText(ctx), /巩固：deepseek-official\/deepseek-chat（运行时）/u);
});

test('C5-H2：跳过模型列表为空的 provider，取第一个有模型的', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const llm = recordingLlm({
    providers: [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'magpie', name: 'Magpie' },
    ],
    models: (provider) => (provider === 'deepseek-official'
      ? []
      : [{ id: 'magpie-main', name: 'Magpie Main' }]),
    stream: draftStream,
  });
  ctx.llm = llm;
  const session = ctx.addSession({
    id: 'session-route',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.returns['tokenMeter.measure'] = hardMeasure();
  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '跳过空模型 provider' },
  );

  const consolidation = llm.requests.find((request) => request.prompt.includes('记忆巩固器'));
  assert.ok(consolidation, '应发起巩固调用');
  assert.equal(consolidation.provider, 'magpie');
  assert.equal(consolidation.model, 'magpie-main');
});

test('C5-H2：consolidation.model 配置优先，配置非法值抛 ConfigError', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const llm = recordingLlm({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    stream: draftStream,
  });
  ctx.llm = llm;
  const session = ctx.addSession({
    id: 'session-config-model',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
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
  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '配置 model 生效' },
  );

  const consolidation = llm.requests.find((request) => request.prompt.includes('记忆巩固器'));
  assert.equal(consolidation.provider, 'magpie');
  assert.equal(consolidation.model, 'main-model');

  // 16 键安装自检不受新增非枚举段影响。
  assert.equal(Object.keys(DEFAULTS).length, 16);
  assert.equal(Object.hasOwn(DEFAULTS, 'consolidation'), true);
  assert.equal(Object.keys(DEFAULTS).includes('consolidation'), false);
  assert.throws(
    () => normalizeConfig({ consolidation: { model: { provider: '', model: 'x' } } }),
    (error) => error instanceof ConfigError,
  );
  assert.throws(
    () => normalizeConfig({ consolidation: { model: { provider: 'p', model: 3 } } }),
    (error) => error instanceof ConfigError,
  );
  assert.throws(
    () => normalizeConfig({ consolidation: 'magpie' }),
    (error) => error instanceof ConfigError,
  );
});

test('C5-H2：闲聊与巩固共用同一 route，空模型 provider 同样跳过', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const llm = recordingLlm({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'magpie', name: 'Magpie' }],
    models: (provider) => (provider === 'deepseek-official'
      ? []
      : [{ id: 'shared-model', name: 'Shared' }]),
    stream(request) {
      if ((request?.messages?.[0]?.content?.[0]?.text ?? '').includes('轻量闲聊')) {
        return (async function* chatStream() {
          yield { type: 'text-delta', text: FIVE_SENTENCES };
          yield { type: 'finish', reason: { kind: 'ok' } };
        })();
      }
      return draftStream();
    },
  });
  ctx.llm = llm;
  const session = ctx.addSession({ id: 'session-shared-route' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // 先触发一次闲聊：当日有互动 + 非安静时段。
  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '今天有点累'), {
    kind: 'enter',
    messages: [],
  });
  ctx.advance(60_000);
  await ctx.fireTimers();
  await waitFor(
    () => llm.requests.some((request) => request.prompt.includes('轻量闲聊')),
    { label: '闲聊调用' },
  );

  // 再触发巩固：清掉当日闲聊记录，hard 计量让窗口可巩固。
  temp.store.setMeta('p1b.chat.enabled', '0');
  ctx.returns['tokenMeter.measure'] = hardMeasure();
  const sessions = ctx.sessions.get('session-shared-route');
  ctx.emitSessionEvent('session-shared-route', userEvent('更早的一轮对话。', 7));
  ctx.emitSessionEvent('session-shared-route', userEvent('再早一点。', 8));
  assert.ok(sessions);
  await ctx.dispatch('agent/pre-step', preStepPayload(session, 2, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(
    () => consolidationRows(temp.store).some((row) => row.status === 'written'),
    { label: '共用 route 的巩固调用' },
  );

  const chat = llm.requests.find((request) => request.prompt.includes('轻量闲聊'));
  const consolidation = llm.requests.find((request) => request.prompt.includes('记忆巩固器'));
  assert.ok(chat, '应有闲聊调用');
  assert.ok(consolidation, '应有巩固调用');
  assert.deepEqual(
    { provider: chat.provider, model: chat.model },
    { provider: consolidation.provider, model: consolidation.model },
  );
  assert.equal(chat.provider, 'magpie');
  assert.equal(chat.model, 'shared-model');
});

test('C5-H2：无可用模型时 /状态 显示「巩固：无可用模型」并写失败事件', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [],
    async *stream() {
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await settle(50);
  assert.match(statusText(ctx), /巩固：无可用模型/u);
  const events = temp.store.listEvents({ table_name: 'consolidations', limit: 50 })
    .filter((row) => row.reason === 'consolidation_failed');
  const noModel = events.find((row) => {
    try {
      return JSON.parse(row.detail_json ?? '{}').kind === 'consolidation_no_model';
    } catch {
      return false;
    }
  });
  assert.ok(noModel, '应写 consolidation_no_model 失败事件');
});
