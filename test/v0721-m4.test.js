// ⚠️ 非真机证据
/**
 * v0.7.21 M4：遗忘成功行同事务写 TOMBSTONE 审计（非真机证据）。
 *
 * 判别力：全部走生产遗忘入口（src/memory/forget.js 的 forgetMemory /
 * forgetMany → store.forgetFact / forgetEpisode），断言审计与状态迁移同生共死：
 *   1) 成功行必有一条 TOMBSTONE，字段/时间/detail 白名单完整且不含正文；
 *   2) 批量里 already_deleted / not_found / scope_denied 的失败行绝不写事件；
 *   3) 非法 actor 让 appendEvent 抛错时 UPDATE 必须一并回滚——证明用的是
 *      `#atomic` 事务而不是裸 UPDATE；这一条是「同事务」的唯一硬证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { forgetMany, forgetMemory } from '../src/memory/forget.js';
import { TEST_NOW, makeTempStore, seedMemory, toEpochSeconds } from './e2e/helpers.js';

const SECRET = '青柠计划';
const AT = toEpochSeconds(TEST_NOW);

/**
 * 该 row_id 的 TOMBSTONE 事件（按 id 精确取，不受其它用例事件干扰）。
 * @param {import('../src/memory/store.js').Store} store
 * @param {string} rowId
 * @returns {object[]}
 */
function tombstonesFor(store, rowId) {
  return store.listEvents({ action: 'TOMBSTONE', limit: 200 }).filter((event) => event.row_id === rowId);
}

test('M4-001 单条 fact 遗忘成功：TOMBSTONE 字段完整且 detail 只含 kind/salience/scope', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store, { scope: 'work', now: TEST_NOW });

  const result = forgetMemory({ store, kind: 'fact', id: seeded.factId, at: TEST_NOW });
  assert.equal(result.ok, true);

  const events = tombstonesFor(store, seeded.factId);
  assert.equal(events.length, 1, '成功迁移必须且只能写一条 TOMBSTONE');
  const [event] = events;
  assert.equal(event.table_name, 'facts');
  assert.equal(event.actor, 'user', '缺省 actor 必须是 user');
  assert.equal(event.reason, 'forget');
  assert.equal(event.at, AT, 'TOMBSTONE.at 与 deleted_at 同秒');
  assert.deepEqual(
    JSON.parse(event.detail_json),
    { kind: 'project', salience: 'normal', scope: 'work' },
  );

  const row = store.getFact(seeded.factId);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, AT);
  assert.equal(JSON.stringify(event).includes(SECRET), false, '审计不得含正文');
  assert.equal(JSON.stringify(event).includes('蓝鲸'), false, '审计不得含事实内容');
  assert.equal(event.detail_json.includes('蓝鲸'), false);
});

test('M4-002 单条 episode 遗忘成功：detail.kind 为字面量 episode，不含标题/摘要', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store, { scope: 'work', now: TEST_NOW });

  const result = forgetMemory({ store, kind: 'episode', id: seeded.episodeId, at: TEST_NOW });
  assert.equal(result.ok, true);

  const events = tombstonesFor(store, seeded.episodeId);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.table_name, 'episodes');
  assert.equal(event.actor, 'user');
  assert.equal(event.reason, 'forget');
  assert.equal(event.at, AT);
  assert.deepEqual(
    JSON.parse(event.detail_json),
    { kind: 'episode', salience: 'normal', scope: 'work' },
  );

  const row = store.getEpisode(seeded.episodeId);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, AT);
  assert.equal(event.detail_json.includes('分阶段安排'), false, '审计不得含情景标题');
  assert.equal(event.detail_json.includes(SECRET), false, '审计不得含情景正文');
});

test('M4-003 批量混合：already_deleted/not_found/scope_denied 不写 TOMBSTONE，只成功行写', (t) => {
  const { store } = makeTempStore({ t });
  const already = seedMemory(store, { scope: 'work', now: TEST_NOW });
  const ok = seedMemory(store, {
    scope: 'work',
    now: TEST_NOW,
    statement: '工作 scope 的第二条事实。',
    subjectText: '第二条',
  });
  const denied = seedMemory(store, { scope: 'main', now: TEST_NOW });

  // 先删一条，制造 already_deleted（这条自己的 TOMBSTONE 属于单条路径）
  assert.equal(forgetMemory({ store, kind: 'fact', id: already.factId, at: TEST_NOW }).ok, true);
  assert.equal(tombstonesFor(store, already.factId).length, 1);

  const batch = forgetMany({
    store,
    ids: [already.factId, 'fact_m4_missing', ok.factId, denied.factId],
    scope: 'work',
    at: TEST_NOW,
  });
  assert.deepEqual(
    { requested: batch.summary.requested, marked: batch.summary.marked, failed: batch.summary.failed },
    { requested: 4, marked: 1, failed: 3 },
  );
  const reasons = new Map(batch.results.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.get(already.factId), 'already_deleted');
  assert.equal(reasons.get('fact_m4_missing'), 'not_found');
  assert.equal(reasons.get(denied.factId), 'scope_denied');

  // 只有成功行新增 TOMBSTONE；失败行一条都不许有
  assert.equal(tombstonesFor(store, ok.factId).length, 1, '成功行应有且仅有一条');
  assert.equal(tombstonesFor(store, already.factId).length, 1, 'already_deleted 不得再写事件');
  assert.equal(tombstonesFor(store, denied.factId).length, 0, 'scope_denied 不得写事件');
  assert.equal(tombstonesFor(store, 'fact_m4_missing').length, 0, 'not_found 不得写事件');
  assert.equal(store.listEvents({ action: 'TOMBSTONE', limit: 200 }).length, 2);

  // store 层的 already_deleted（单事务复用/直接 API 会真正走到这里）也不得再写
  assert.equal(store.forgetFact(already.factId, { at: TEST_NOW }), false);
  assert.equal(
    tombstonesFor(store, already.factId).length,
    1,
    'store 层 already_deleted 不得补写第二条 TOMBSTONE',
  );

  const batchEvent = tombstonesFor(store, ok.factId)[0];
  assert.equal(batchEvent.actor, 'user');
  assert.equal(batchEvent.reason, 'forget');
  assert.equal(store.getFact(ok.factId).deleted_at, AT);
  assert.equal(store.getFact(denied.factId).status, 'active', '失败行保持 active');
});

test('M4-004 非法 actor 令 appendEvent 抛错，UPDATE 随事务回滚（#atomic 非裸 UPDATE）', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store, { scope: 'work', now: TEST_NOW });

  assert.throws(
    () => forgetMemory({ store, kind: 'fact', id: seeded.factId, at: TEST_NOW, actor: 'tool' }),
    /invalid memory_events\.actor/u,
  );

  const row = store.getFact(seeded.factId);
  assert.equal(row.status, 'active', 'appendEvent 抛错时 UPDATE 必须回滚');
  assert.equal(row.deleted_at, null);
  assert.equal(row.purge_payload, null);
  assert.equal(store.getWatermark('work'), 0);
  assert.equal(store.stats().memory_events, 0, '回滚后不得留下任何审计事件');

  // 同一行随后仍能被合法遗忘：证明回滚没有破坏后续迁移
  assert.equal(forgetMemory({ store, kind: 'fact', id: seeded.factId, at: TEST_NOW }).ok, true);
  assert.equal(tombstonesFor(store, seeded.factId).length, 1);
});

test('M4-005 调用方给定 actor 透传（batch 路径同样生效，不硬编码 user）', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store, { scope: 'work', now: TEST_NOW });

  assert.equal(
    forgetMemory({ store, kind: 'fact', id: seeded.factId, at: TEST_NOW, actor: 'scheduler' }).ok,
    true,
  );
  const [event] = tombstonesFor(store, seeded.factId);
  assert.equal(event.actor, 'scheduler');
  assert.equal(event.reason, 'forget');

  const second = seedMemory(store, {
    scope: 'work',
    now: TEST_NOW,
    statement: '第二条用于批量 actor 透传。',
    subjectText: '批量第二条',
  });
  forgetMany({ store, ids: [second.factId], at: TEST_NOW, actor: 'migrator' });
  assert.equal(tombstonesFor(store, second.factId)[0].actor, 'migrator');
});
