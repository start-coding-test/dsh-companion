/**
 * v0.4.2 集成/回归测试（S2-M1 + L2-1）。
 *
 * 覆盖评审 review-code-v0.4.1 指出的四个口径问题：
 *   1) 「刚写入就被注入、几天后真被用上」：same_context 与 Δt 取用上那一刻，
 *      不能被 1 小时前的注入样本吞掉（first_used_at=+3d、used_same_context=0、
 *      Δt=3d）；
 *   2) 首次注入未用、第二次注入才用上：取第二次「用上」的时刻；
 *   3) 非 same_context 用上覆盖同会话用上一次，之后不再覆盖；
 *   4) observed_at 口径：created_at 很旧但原话时间新鲜时仍判同会话（来源不在
 *      surface 也一样）。
 *
 * 全部使用临时库与 FakeCtx 手动时钟/转录，不联网、不读真实时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { TEST_NOW, makeTempStore, seedMemory } from './e2e/helpers.js';

const DAY_SEC = 86_400;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** apply 需要的 commands/tools/llm 平台服务（只走 pre-step）。 */
function makeApplyCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW });
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

function messages(...rows) {
  return rows.map(([role, text]) => ({ role, content: [{ type: 'text', text }] }));
}

function turnPayload(turn, msgs, session = { id: 'session-1' }, step = 1) {
  return {
    agent: { id: 'agent-1', session },
    messages: msgs,
    turn,
    step,
  };
}

test('S2-M1 集成：1h 前的注入样本不得吞掉 3 天后的真实用上', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // t0+1h：首次注入（recall 样本，Δt<6h → same_context=1，统计时排除）。
  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.reneed_kind, 'recall');
  assert.equal(recalled.first_reneed_at, at + 3600);
  assert.equal(recalled.same_context, 1, '注入时仍在同会话窗口内');
  assert.equal(recalled.first_used_at, null, '尚未被用上');

  // t0+3d：assistant 复述 → 真正用上；同一份 1h 前的注入样本不能让这次算
  // 同会话，Δt 也必须从 observed_at 起算 3 天。
  ctx.advance(3 * DAY_MS - HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '谢谢。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );

  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 3 * DAY_SEC, '用上时间取用上那一刻');
  assert.equal(used.first_used_tier, 'clear');
  assert.equal(used.used_same_context, 0, '跨会话用上，不得沿用注入时的 same_context=1');
  assert.equal(used.first_reneed_at, at + 3600, 'recall 样本保持首次注入时间作对照');
  assert.equal(used.same_context, 1, 'recall 的同会话标记不被改写');
  assert.equal(
    used.first_used_at - used.observed_at,
    3 * DAY_SEC,
    'Δt 用 observed_at 口径应为 3 天',
  );

  // 再来一次用上：已有非 same_context 记录，不再覆盖。
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      3,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '知道了。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const again = temp.store.getFact(seeded.factId);
  assert.equal(again.first_used_at, at + 3 * DAY_SEC, '首次跨会话用上保持不被覆盖');
  assert.equal(again.used_same_context, 0);
});

test('S2-M1 集成：首次注入未用、第二次注入才用上 → 取第二次用上时刻', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // 第 1 次注入（t0+1h）：用户只问不确认，assistant 也没有复述该事实。
  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  assert.equal(temp.store.getFact(seeded.factId).first_used_at, null);

  // 第 2 次注入（t0+2d）：仍未用上，但注入样本会更新为本次时刻。
  ctx.advance(2 * DAY_MS - HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(['user', '青柠计划的代号是？'], ['assistant', '我先查一下。'], ['user', '好']),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const secondRecall = temp.store.getFact(seeded.factId);
  assert.equal(secondRecall.first_reneed_at, at + 3600, 'first_reneed_* 仍是首次注入');
  assert.equal(secondRecall.first_used_at, null);

  // t0+3d：复述该事实 → 用上；时间必须是这次用上，而不是第 1/2 次注入。
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      3,
      messages(
        ['user', '青柠计划的代号是？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '好。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 3 * DAY_SEC, '首次用上取第二次之后的实际用上时刻');
  assert.equal(used.used_same_context, 0);
  assert.equal(used.first_used_at - used.observed_at, 3 * DAY_SEC);
});

test('L2-1 集成：created_at 很旧但 observed_at 新鲜 → 仍判同会话（来源不在 surface）', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  // 模拟延迟巩固：事实 30 天前写入，但原话发生在 1 小时前；来源 episode 没有
  // 关联巩固 → 不走「仍在 surface」路径，只能靠 observed_at 判定。
  temp.store.db
    .prepare(
      'UPDATE facts SET created_at = ?, observed_at = ?, last_reinforced_at = ?, strength_days = 365 WHERE id = ?',
    )
    .run(at - 30 * DAY_SEC, at, at, seeded.factId);

  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.same_context, 1, 'Δt 应相对 observed_at 的 1h，而不是 created_at 的 30d');

  // 同一会话内 10 分钟后就复述用上：按 observed_at 仍是同会话样本。
  ctx.advance(10 * 60_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '好。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.used_same_context, 1, '用上时按 observed_at 重算仍为同会话');
  assert.equal(
    used.first_used_at,
    at + 4200,
    '用上时间取实际复述时刻',
  );
});
