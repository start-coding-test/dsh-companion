/**
 * H5 e2e：走真实插件入口 apply()，验证「注入 → assistant 复述 → 下一轮强化」。
 *
 * 覆盖：
 *   1) 普通复述 → α=2，strength_days 上升、recall_count=1、REINFORCE 审计；
 *   2) 用户确认词（对/记住了）→ α=4；
 *   3) 未用上（assistant 回复无关）→ 强度与 recall_count 都不变。
 *
 * 复用 e2e/helpers 的固定时钟与 seedMemory；不联网、不读真实时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { TEST_NOW, makeTempStore, seedMemory } from './helpers.js';

const DAY_MS = 86_400_000;
const FACT_STATEMENT = '青柠计划的代号是蓝鲸。';

/** apply 需要的 commands/tools/llm 三个平台服务（不实际使用）。 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
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
  ctx.llm = {
    listProviders: () => [],
    listModels: () => [],
    async *stream() {
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  return ctx;
}

/** 构造 role 消息数组。 */
function messages(...rows) {
  return rows.map(([role, text]) => ({ role, content: [{ type: 'text', text }] }));
}

/** 一轮 pre-step 的标准 payload。 */
function turnPayload(turn, msgs, step = 1) {
  return {
    agent: { id: 'agent-1', session: { id: 'session-1' } },
    messages: msgs,
    turn,
    step,
  };
}

/** 把 pre-step 决策里的注入文本拼出来。 */
function decisionText(decision) {
  const list = Array.isArray(decision?.messages) ? decision.messages : [];
  return list
    .flatMap((message) => {
      if (Array.isArray(message?.content)) return message.content;
      return message?.type === 'text' ? [message] : [];
    })
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** 读该 fact 的 REINFORCE 事件并解析 detail。 */
function reinforcementEvents(store, factId) {
  return store
    .listEvents({ action: 'REINFORCE', row_id: factId })
    .map((event) => ({ ...event, detail: JSON.parse(event.detail_json) }));
}

test('apply：注入 → assistant 复述 → 下一轮强化 α=2，recall_count=1 且写 REINFORCE', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: FACT_STATEMENT });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // turn 1：问题触发召回，注入 fact（此时不应强化）。
  const first = await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？'])),
    { kind: 'enter', messages: [] },
  );
  assert.match(decisionText(first), /\[相关记忆\]/u, '应注入召回块');
  assert.match(decisionText(first), /蓝鲸/u, '应召回命中的 fact');
  const before = temp.store.getFact(seeded.factId);
  assert.equal(before.recall_count, 0);
  assert.equal(before.strength_days, 14);

  // 一天后：assistant 复述了 fact，用户只回了「谢谢」（无确认词）→ α=2。
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸，我记住了。'],
        ['user', '谢谢。'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  const R = Math.exp(-1 / 14);
  const expected = 14 * (1 + 2 * (1 - R)) + 1;
  assert.equal(after.recall_count, 1, '用上一次只强化一次');
  assert.ok(after.strength_days > before.strength_days, '强度应上升');
  assert.ok(Math.abs(after.strength_days - expected) < 1e-6, 'S′ 应匹配 α=2 公式');
  assert.equal(after.last_reinforced_at, Math.floor(ctx.now() / 1000));

  const events = reinforcementEvents(temp.store, seeded.factId);
  assert.equal(events.length, 1, '应写一条 REINFORCE 审计');
  assert.equal(events[0].table_name, 'facts');
  assert.equal(events[0].detail.alpha, 2);
  assert.ok(Math.abs(events[0].detail.to - expected) < 1e-6);

  // 同一 turn 的后续 step 不得重复强化同一条 fact。
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸，我记住了。'],
        ['user', '谢谢。'],
      ),
      2,
    ),
    { kind: 'enter', messages: [] },
  );
  assert.equal(temp.store.getFact(seeded.factId).recall_count, 1, '每轮最多强化一次');
  assert.equal(reinforcementEvents(temp.store, seeded.factId).length, 1);
});

test('apply：用户确认词 + assistant 复述 → α=4', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: FACT_STATEMENT });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '我是不是说过青柠计划的代号？'])),
    { kind: 'enter', messages: [] },
  );
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '我是不是说过青柠计划的代号？'],
        ['assistant', '是的，青柠计划的代号是蓝鲸。'],
        ['user', '对，就是蓝鲸，记住了。'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  const R = Math.exp(-1 / 14);
  const expected = 14 * (1 + 4 * (1 - R)) + 1;
  assert.equal(after.recall_count, 1);
  assert.ok(Math.abs(after.strength_days - expected) < 1e-6, '确认词应使用 α=4');

  const events = reinforcementEvents(temp.store, seeded.factId);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.alpha, 4);
  assert.ok(Math.abs(events[0].detail.to - expected) < 1e-6);
});

test('apply：assistant 未复述（回复无关）→ 强度与 recall_count 不变、不写事件', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: FACT_STATEMENT });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const first = await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？'])),
    { kind: 'enter', messages: [] },
  );
  assert.match(decisionText(first), /蓝鲸/u, '先确保本轮确实注入了该 fact');

  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '今天天气不错，我们出去走走吧。'],
        ['user', '好。'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  assert.equal(after.strength_days, 14, '未被用上不得强化');
  assert.equal(after.recall_count, 0);
  assert.equal(reinforcementEvents(temp.store, seeded.factId).length, 0);
});
