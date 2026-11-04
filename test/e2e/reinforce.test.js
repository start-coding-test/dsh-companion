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
  assert.equal(before.first_reneed_at, Math.floor(TEST_NOW / 1000));
  assert.equal(before.first_reneed_tier, 'clear', 'full 档命中记 clear');
  assert.equal(before.reneed_kind, 'recall');

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
  assert.equal(after.first_reneed_at, before.first_reneed_at, '二次注入不覆盖首次样本');
  assert.equal(after.first_reneed_tier, 'clear');
  assert.equal(after.reneed_kind, 'used', '复述命中后首次样本升级为 used');
  assert.equal(after.same_context, 0, '隔天召回不是同会话样本');

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
  assert.equal(
    temp.store.getFact(seeded.factId).first_reneed_at,
    Math.floor(TEST_NOW / 1000),
    '同 turn 后续 step 不覆盖首次样本',
  );
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

test('apply：含「对」的子串（对比一下）不算确认语 → α=2（N-L1）', async (t) => {
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
        ['user', '对比一下，蓝鲸和虎鲸哪个更大？'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  const R = Math.exp(-1 / 14);
  const expected = 14 * (1 + 2 * (1 - R)) + 1;
  assert.equal(after.recall_count, 1);
  assert.ok(Math.abs(after.strength_days - expected) < 1e-6, '「对比一下」不得使用 α=4');
  const events = reinforcementEvents(temp.store, seeded.factId);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.alpha, 2);
});

test('apply：gist 档召回记 ambiguous（R 0.2–0.5）', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: FACT_STATEMENT });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // R = exp(-1.2) ≈ 0.30，落在 gist 档（0.2 ≤ R < 0.5）。
  const at = Math.floor(TEST_NOW / 1000);
  temp.store.db
    .prepare('UPDATE facts SET strength_days = 1, last_reinforced_at = ? WHERE id = ?')
    .run(at - Math.round(1.2 * 86_400), seeded.factId);

  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？'])),
    { kind: 'enter', messages: [] },
  );

  const row = temp.store.getFact(seeded.factId);
  assert.equal(row.first_reneed_at, at);
  assert.equal(row.first_reneed_tier, 'ambiguous', 'gist 档命中记 ambiguous');
  assert.equal(row.reneed_kind, 'recall');
});

test('apply：同会话立即召回标 same_context，统计排除；复述升级 used 仍保留标记', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: FACT_STATEMENT });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // 模拟事实刚刚写入（created_at 与注入同一时刻）。
  const at = Math.floor(TEST_NOW / 1000);
  temp.store.db
    .prepare('UPDATE facts SET created_at = ? WHERE id = ?')
    .run(at, seeded.factId);

  const first = await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？'])),
    { kind: 'enter', messages: [] },
  );
  assert.match(decisionText(first), /蓝鲸/u, '应注入召回块');

  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.reneed_kind, 'recall', '仅注入先记 recall');
  assert.equal(recalled.same_context, 1, '几分钟内立刻召回标同会话');
  const counted = temp.store.db
    .prepare('SELECT COUNT(*) AS n FROM facts WHERE reneed_kind IS NOT NULL AND same_context = 0')
    .get();
  assert.equal(counted.n, 0, '同会话样本不得进入 S0 统计口径');

  // 下一轮复述升级 used，但同会话标记保留，仍然排除。
  ctx.advance(60_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '谢谢。'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_reneed_at, at, '升级不改变首次时间');
  assert.equal(used.same_context, 1);
  assert.equal(
    temp.store.db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE reneed_kind IS NOT NULL AND same_context = 0')
      .get().n,
    0,
  );
});

