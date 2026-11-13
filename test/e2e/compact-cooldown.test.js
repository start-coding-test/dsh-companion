/**
 * A6 冷却的端到端回归（r2 复审 M-1）：
 * threshold 巩固成功后 `compact_threshold_turns:<scope>` 必须归零；
 * 重启后再压同一库，冷却仍从 0 起算，不会刚重启就又压一次。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { makeTempStore, settle, waitFor } from './helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const MEASURE_13K = {
  logRevision: 1,
  baseline: null,
  surfaceDeltaTokens: 5,
  totalTokens: 13_000,
  surfaceTokens: 13_000,
  nodes: [],
};

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

/** 建一个可用的 apply ctx（命令/工具/llm 都最小化）。 */
function makeCtx(now) {
  const ctx = new FakeCtx({ now });
  const session = ctx.addSession({ id: 'session-1' });
  ctx.commands = { register: () => () => {} };
  ctx.tools = { register: () => () => {} };
  ctx.returns['tokenMeter.measure'] = MEASURE_13K;
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  return { ctx, session };
}

/** 推进一步用户轮。 */
function turnPayload(ctx, session, turn, text) {
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

test('A6：threshold 巩固成功后冷却归零，重启仍从 0 起算', async () => {
  const temp = makeTempStore();
  const napCount = () =>
    Number(
      temp.store.db
        .prepare("SELECT COUNT(*) AS n FROM consolidations WHERE scope = 'main' AND kind = 'nap'")
        .get().n,
    );

  // 第一段：两轮 13K token，覆盖阈值 12000 → threshold 巩固一次。
  const first = makeCtx(Date.parse('2026-11-13T10:00:00+08:00'));
  let handle = apply(first.ctx, { dbPath: temp.dbPath, retainTokens: 4, compactAtTokens: 12_000 });
  try {
    await first.ctx.dispatch(
      'agent/pre-step',
      turnPayload(first.ctx, first.session, 1, '记录一下这个决定。'),
      { kind: 'enter', messages: [] },
    );
    await first.ctx.dispatch('agent/pre-step', turnPayload(first.ctx, first.session, 2, '继续。'), {
      kind: 'enter',
      messages: [],
    });
    // 巩固行在 consolidate() 内先落库；水位在冷却归零之后才推进，等水位可避免竞态。
    await waitFor(() => temp.store.getWatermark('main') > 0, { label: 'first consolidation' });
    assert.equal(napCount(), 1);
    assert.equal(
      temp.store.getMeta('compact_threshold_turns:main'),
      '0',
      'threshold 巩固成功后冷却计数必须归零',
    );
  } finally {
    handle.dispose();
  }

  // 第二段：重启后再压同一个库，冷却应从 0 恢复，前三轮都不该再压。
  const second = makeCtx(Date.parse('2026-11-13T10:30:00+08:00'));
  handle = apply(second.ctx, { dbPath: temp.dbPath, retainTokens: 4, compactAtTokens: 12_000 });
  try {
    await second.ctx.dispatch('agent/pre-step', turnPayload(second.ctx, second.session, 3, '继续。'), {
      kind: 'enter',
      messages: [],
    });
    await settle();
    assert.equal(napCount(), 1, '重启后第 1 轮仍在冷却');
    assert.equal(temp.store.getMeta('compact_threshold_turns:main'), '1', '重启后计数从 0 继续累加');

    await second.ctx.dispatch('agent/pre-step', turnPayload(second.ctx, second.session, 4, '继续。'), {
      kind: 'enter',
      messages: [],
    });
    await settle();
    assert.equal(napCount(), 1, '重启后第 2 轮仍在冷却');
    assert.equal(temp.store.getMeta('compact_threshold_turns:main'), '2', '计数持续累加');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
