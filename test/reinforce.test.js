/**
 * H5 记忆强化：纯函数公式 + Store.reinforceFact 能力约定 + REINFORCE 审计。
 *
 * 口径（卡片 t3 / 06 §遗忘）：
 *   R  = exp(−Δt / 86400 / S)
 *   S' = min(3650, S×(1+α×(1−R)) + 1)
 * 强化只发生在「被回复用上」时，pinned / 墓碑 / 非 active 一律跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRM_ALPHA,
  DEFAULT_ALPHA,
  MAX_STRENGTH_DAYS,
  USE_OVERLAP_THRESHOLD,
  applyReinforcement,
  decayOf,
  overlapRatio,
  reinforce,
} from '../src/memory/reinforce.js';
import { makeTempStore } from './e2e/helpers.js';

const T0 = Math.floor(Date.UTC(2026, 10, 5, 9, 0, 0) / 1000);
const DAY = 86_400;

/** 最小可用事实。 */
function makeFact(overrides = {}) {
  return {
    kind: 'other',
    subject_text: '测试',
    predicate: '是',
    statement: '测试事实',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: T0,
    last_reinforced_at: T0,
    ...overrides,
  };
}

test('decayOf：R=1 起点、按天指数衰减、时钟回拨按 1、pinned 恒 1', () => {
  assert.equal(decayOf({ strengthDays: 10, lastReinforcedAt: T0, now: T0 }), 1);

  const afterOneDay = decayOf({ strengthDays: 10, lastReinforcedAt: T0, now: T0 + DAY });
  assert.ok(Math.abs(afterOneDay - Math.exp(-0.1)) < 1e-12, 'R=exp(−1/10)');

  const afterTenDays = decayOf({ strengthDays: 10, lastReinforcedAt: T0, now: T0 + 10 * DAY });
  assert.ok(Math.abs(afterTenDays - Math.exp(-1)) < 1e-12, 'R=exp(−10/10)');
  assert.ok(afterTenDays < afterOneDay, '越久越接近遗忘');

  // 时钟回拨（now < last）按 R=1，避免反向放大。
  assert.equal(decayOf({ strengthDays: 10, lastReinforcedAt: T0, now: T0 - DAY }), 1);
  // 毫秒时间戳也接受。
  assert.equal(decayOf({ strengthDays: 10, lastReinforcedAt: T0 * 1000, now: T0 * 1000 }), 1);
  // 缺强度 / 缺上次强化时间 → 视为已遗忘（R=0），由调用方按最大强化处理。
  assert.equal(decayOf({ strengthDays: null, lastReinforcedAt: T0, now: T0 }), 0);
  assert.equal(decayOf({ strengthDays: 0, lastReinforcedAt: T0, now: T0 }), 0);
  assert.equal(decayOf({ strengthDays: 10, lastReinforcedAt: null, now: T0 }), 0);
  // pinned 没有强度，但保留度恒为 1。
  assert.equal(decayOf({ pinned: true, strengthDays: null, lastReinforcedAt: T0, now: T0 + 99 * DAY }), 1);
});

test('reinforce：R=0/R=1、α 默认值、S_max=3650 封顶', () => {
  // 完全遗忘（R=0）：S' = S×(1+α)+1
  assert.equal(reinforce({ strengthDays: 10, R: 0, alpha: 2 }), 31);
  assert.equal(reinforce({ strengthDays: 10, R: 0, alpha: 4 }), 51);
  // 完全保留（R=1）：只加 1 天，避免自我膨胀。
  assert.equal(reinforce({ strengthDays: 10, R: 1, alpha: 2 }), 11);
  // α 缺省 = DEFAULT_ALPHA。
  assert.equal(DEFAULT_ALPHA, 2.0);
  assert.equal(CONFIRM_ALPHA, 4.0);
  assert.equal(reinforce({ strengthDays: 10, R: 0 }), 31);
  // 封顶。
  assert.equal(MAX_STRENGTH_DAYS, 3650);
  assert.equal(reinforce({ strengthDays: 3640, R: 0, alpha: 4 }), MAX_STRENGTH_DAYS);
  assert.equal(reinforce({ strengthDays: 3650, R: 0, alpha: 4 }), MAX_STRENGTH_DAYS);
  // R 越界按 [0,1] 收敛；α 非法退回默认。
  assert.equal(reinforce({ strengthDays: 10, R: -1, alpha: 2 }), 31);
  assert.equal(reinforce({ strengthDays: 10, R: 2, alpha: 2 }), 11);
  assert.equal(reinforce({ strengthDays: 10, R: 0, alpha: Number.NaN }), 31);
});

test('overlapRatio：复述正例 ≥ 阈值、无关负例为 0、标点空白不敏感', () => {
  assert.equal(USE_OVERLAP_THRESHOLD, 0.6);

  const fact = '青柠计划的代号是蓝鲸。';
  const paraphrase = '明白，青柠计划的代号是蓝鲸，我记住了。';
  assert.equal(overlapRatio(fact, paraphrase), 1, '完整复述应完全覆盖');

  assert.equal(overlapRatio(fact, '今天天气不错，出去走走。'), 0, '无关回复不应命中');
  assert.ok(overlapRatio(fact, '青柠计划') < USE_OVERLAP_THRESHOLD, '只提到开头不足以算用上');

  // 空白/标点归一化后等价。
  assert.equal(overlapRatio('预算额度调整为 8000。', '预算额度调整为8000！'), 1);
  assert.equal(overlapRatio('', paraphrase), 0);
  assert.equal(overlapRatio(fact, ''), 0);
  // 单字 fact 退化为字符覆盖。
  assert.equal(overlapRatio('鲸', '代号是鲸。'), 1);
});

test('Store.reinforceFact：active 事实单事务强化并写 REINFORCE 事件', (t) => {
  const temp = makeTempStore({ t });
  const store = temp.store;
  const fact = store.insertFact(makeFact({ statement: '青柠计划的代号是蓝鲸。', strength_days: 14 }));
  const at = T0 + 7 * DAY;

  const result = store.reinforceFact({ id: fact.id, scope: 'main', at, alpha: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.id, fact.id);
  assert.equal(result.alpha, 2);
  assert.equal(result.recallCount, 1);
  const R = Math.exp(-7 / 14);
  const expected = Math.min(MAX_STRENGTH_DAYS, 14 * (1 + 2 * (1 - R)) + 1);
  assert.ok(Math.abs(result.strengthDays - expected) < 1e-9, 'S′ 应匹配公式');

  const row = store.getFact(fact.id);
  assert.ok(row.strength_days > 14, '强度应上升');
  assert.ok(Math.abs(row.strength_days - expected) < 1e-9);
  assert.equal(row.recall_count, 1, 'recall_count +1');
  assert.equal(row.last_reinforced_at, at, 'last_reinforced_at 记强化时刻');

  const events = store.listEvents({ action: 'REINFORCE', row_id: fact.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].table_name, 'facts');
  assert.equal(events[0].actor, 'consolidator');
  assert.equal(events[0].reason, 'used_in_reply');
  const detail = JSON.parse(events[0].detail_json);
  assert.equal(detail.alpha, 2);
  assert.ok(Math.abs(detail.from - 14) < 1e-9);
  assert.ok(Math.abs(detail.to - expected) < 1e-9, 'detail.to 与落库值一致');

  // 再强化一次：recall_count 累加、事件追加（append-only）。
  const again = store.reinforceFact({ id: fact.id, scope: 'main', at: at + DAY, alpha: 4 });
  assert.equal(again.ok, true);
  assert.equal(again.recallCount, 2);
  assert.equal(store.listEvents({ action: 'REINFORCE', row_id: fact.id }).length, 2);
});

test('Store.reinforceFact：pinned 不加、不写事件、不抛错', (t) => {
  const temp = makeTempStore({ t });
  const store = temp.store;
  const fact = store.insertFact(makeFact({ salience: 'pinned', statement: '用户对花生过敏。' }));

  const result = store.reinforceFact({ id: fact.id, at: T0 + DAY, alpha: 2 });
  assert.deepEqual(result, { ok: false, reason: 'pinned' });

  const row = store.getFact(fact.id);
  assert.equal(row.recall_count, 0);
  assert.equal(row.strength_days, null, 'pinned 无强度，不应被写入');
  assert.equal(store.listEvents({ action: 'REINFORCE', row_id: fact.id }).length, 0);
});

test('Store.reinforceFact：墓碑（forget）/ 已删（delete）/ 非 active / 缺行都返回 reason 不抛', (t) => {
  const temp = makeTempStore({ t });
  const store = temp.store;

  const tombstoned = store.insertFact(makeFact({ statement: '青柠计划的代号是蓝鲸。' }));
  assert.equal(store.forgetFact(tombstoned.id, { at: T0, payload: { statement: 'x' } }), true);
  assert.deepEqual(
    store.reinforceFact({ id: tombstoned.id, at: T0 + DAY }),
    { ok: false, reason: 'deleted' },
  );

  const deleted = store.insertFact(makeFact({ statement: '预算额度调整为 8000。' }));
  assert.ok(store.deleteFact(deleted.id, { now: T0 }));
  assert.deepEqual(
    store.reinforceFact({ id: deleted.id, at: T0 + DAY }),
    { ok: false, reason: 'deleted' },
  );

  const superseded = store.insertFact(makeFact({ statement: '旧代号是鲸鱼。' }));
  store.updateFact(superseded.id, { status: 'superseded' });
  assert.deepEqual(
    store.reinforceFact({ id: superseded.id, at: T0 + DAY }),
    { ok: false, reason: 'inactive' },
  );
  assert.equal(store.getFact(superseded.id).recall_count, 0);

  assert.deepEqual(
    store.reinforceFact({ id: 'fact_missing', at: T0 + DAY }),
    { ok: false, reason: 'not_found' },
  );
  assert.equal(store.listEvents({ action: 'REINFORCE' }).length, 0);
});

test('applyReinforcement：转调 store.reinforceFact，能力缺失/异常不炸穿调用方', (t) => {
  const temp = makeTempStore({ t });
  const store = temp.store;
  const fact = store.insertFact(makeFact({ strength_days: 14 }));

  const result = applyReinforcement(store, { scope: 'main', factId: fact.id, at: T0 + DAY, alpha: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.alpha, 2);

  const missed = applyReinforcement(store, { factId: 'fact_missing', at: T0 + DAY });
  assert.equal(missed.ok, false);
  assert.equal(missed.reason, 'not_found');

  // 存储层抛错时收敛成 {ok:false, reason:'error'}，由接线层只记 warn。
  const broken = {
    reinforceFact() {
      throw new Error('disk full');
    },
  };
  const failed = applyReinforcement(broken, { factId: 'fact_x' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'error');
  assert.match(failed.message, /disk full/u);

  assert.throws(() => applyReinforcement({}, { factId: 'fact_x' }), /reinforceFact/u);
  assert.throws(() => applyReinforcement(store, { factId: '' }), /factId/u);
});
