/**
 * t17 e2e：巩固失败可观测、可重试，凭据错误不重试。
 *
 * 走真实 apply() 与后台 setImmediate 巩固链路；LLM 第一次抛可重试错误，
 * 60s 后的 idle tick 用同一 consolidations 行重试并写回 written。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { TEST_NOW, makeTempStore, settle, waitFor } from './helpers.js';

const DRAFT = {
  episode: {
    title: '预算调整',
    summary: '用户把项目预算调到 8000。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      salience: 'normal',
    },
  ],
  reminders: [],
};

function userEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function makeApplyCtx(stream) {
  const ctx = new FakeCtx({ now: TEST_NOW });
  ctx.commands = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
  ctx.tools = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    stream,
  };
  // 与 surface-seq 测试一致：用总 token 触发巩固窗口（tail 之外有可巩固内容）。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return ctx;
}

function preStepPayload(session, turn, text) {
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step: 1,
  };
}

function consolidationRows(store) {
  return store.db.prepare(
    "SELECT id, status, error, upto_seq FROM consolidations WHERE kind = 'nap' ORDER BY id",
  ).all();
}

test('巩固失败写 failed 行与事件，60s 后 idle 重试成功', async (t) => {
  const temp = makeTempStore();
  let calls = 0;
  const ctx = makeApplyCtx(async function* stream(request) {
    const prompt = request?.messages?.[0]?.content?.[0]?.text ?? '';
    if (!prompt.includes('记忆巩固器')) {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish', reason: { kind: 'ok' } };
      return;
    }
    calls += 1;
    if (calls === 1) throw new Error('temporary model outage');
    yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
    yield { type: 'finish', reason: { kind: 'ok' } };
  });
  const session = ctx.addSession({
    id: 'session-1',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });

  await waitFor(() => consolidationRows(temp.store).length === 1, { label: 'failed row' });
  const failed = consolidationRows(temp.store)[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /temporary model outage/u);

  const failureEvents = temp.store.listEvents({ table_name: 'consolidations', limit: 50 })
    .filter((row) => row.reason === 'consolidation_failed');
  assert.equal(failureEvents.length, 1);
  const retryEvents = temp.store.listEvents({ table_name: 'consolidations', limit: 50 })
    .filter((row) => row.reason === 'retry');
  assert.equal(retryEvents.length, 1);

  ctx.advance(60_000);
  await ctx.fireTimers(1);
  await waitFor(() => temp.store.getWatermark('main') === 7, { label: 'retry consolidation' });

  const recovered = consolidationRows(temp.store);
  assert.equal(recovered.length, 1, '重试复用同一行，不重复插入');
  assert.equal(recovered[0].status, 'written');
  assert.equal(recovered[0].error, null);
  assert.equal(calls, 2);
});

test('MISSING_CREDENTIAL 不重试，失败永久可观察', async (t) => {
  const temp = makeTempStore();
  let calls = 0;
  const ctx = makeApplyCtx(async function* stream(request) {
    const prompt = request?.messages?.[0]?.content?.[0]?.text ?? '';
    if (!prompt.includes('记忆巩固器')) {
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish', reason: { kind: 'ok' } };
      return;
    }
    calls += 1;
    const error = new Error('llm-deepseek: no API key for provider route "deepseek-official"');
    error.code = 'MISSING_CREDENTIAL';
    throw error;
  });
  const session = ctx.addSession({
    id: 'session-1',
    events: [userEvent('更早的一轮对话。', 7), userEvent('再早一点。', 8)],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', preStepPayload(session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(() => consolidationRows(temp.store).length === 1, { label: 'failed row' });

  ctx.advance(5 * 60_000);
  await ctx.fireTimers(3);
  await settle(50);

  assert.equal(calls, 1, '凭据错误不应重试');
  assert.equal(temp.store.getWatermark('main'), 0);
  const failed = consolidationRows(temp.store)[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /no API key/u);
  const retryEvents = temp.store.listEvents({ table_name: 'consolidations', limit: 50 })
    .filter((row) => row.reason === 'retry');
  assert.equal(retryEvents.length, 0);
  const permanent = temp.store.listEvents({ table_name: 'consolidations', limit: 50 })
    .filter((row) => row.reason === 'consolidation_failed_final');
  assert.equal(permanent.length, 1);
  assert.ok(ctx.logs.some((entry) => /failed permanently/u.test(entry.message)));
});
