/**
 * T11a / V2 显式遗忘闭环 e2e（卡片 t15）。
 *
 * 链路（06 v3.3 §7.8）：
 *   S1 立即停读：tombstone + deleted_at，检索/注入/提醒立刻查不到；
 *   冷静期：7 天内不物理删除，行仍在（status=tombstoned, deleted_at 已写）；
 *   S2 到期清理：store.purge 物理删除 facts/episodes + FTS 投影，并落
 *      action='PURGED' 审计；其它 scope 不受影响；
 *   清理后再过 30 天检索仍为 0；重复 purge 幂等。
 *
 * 生产命令层尚未实现，S1 由 test/e2e/helpers.js 的 forgetMemory 按上述语义
 * 模拟（该函数里注明了一处缺失的 Store 公开方法）；本文件只读 src、不改 src。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { consolidate } from '../../src/memory/consolidate.js';
import {
  DAY_SECONDS,
  TEST_NOW,
  createClock,
  forgetMemory,
  makeFakeLlm,
  makeTempStore,
  recallInjection,
  seedMemory,
  toEpochSeconds,
} from './helpers.js';

const SECRET = '青柠计划';
const OTHER = '薄荷项目';

/**
 * 某张带 scope 列的表里该 scope 的行数。
 * @param {import('../../src/memory/store.js').Store} store
 * @param {string} table
 * @param {string} scope
 * @returns {number}
 */
function countScope(store, table, scope) {
  return Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE scope = ?`).get(scope).n);
}

/** FTS 投影中的孤儿行数（主表已删、投影残留）。 */
function countOrphans(store, ftsTable, sourceTable) {
  return Number(
    store.db
      .prepare(`SELECT COUNT(*) AS n FROM ${ftsTable} WHERE rowid NOT IN (SELECT rowid FROM ${sourceTable})`)
      .get().n,
  );
}

test('S1 立即停读：tombstone + deleted_at 后检索/注入/提醒立刻归零，冷静期内不物删', async (t) => {
  const { store } = makeTempStore({ t });
  const clock = createClock();
  const seeded = seedMemory(store, { scope: 'work', now: clock.now() });

  // 遗忘前：三条检索腿都能看到它
  const before = await recallInjection({ store, query: SECRET, scope: 'work', now: clock.now() });
  assert.ok(before.recalled.items.length >= 1, '遗忘前检索应命中');
  assert.ok(before.injected.includes(SECRET), '遗忘前注入应包含正文');
  assert.deepEqual(
    store.searchBigram(SECRET, { scope: 'work' }).map((hit) => hit.type).sort(),
    ['episode', 'fact'],
    '遗忘前 fact 与 episode 都应命中',
  );
  const dueAt = clock.seconds() + DAY_SECONDS;
  assert.equal(store.dueReminders({ scope: 'work', now: dueAt }).length, 1);

  const result = forgetMemory(store, {
    scope: 'work',
    factId: seeded.factId,
    episodeId: seeded.episodeId,
    reminderId: seeded.reminderId,
    now: clock.now(),
  });
  assert.equal(result.at, toEpochSeconds(TEST_NOW));

  // 立即停读：bigram、召回、注入、提醒全部归零
  assert.deepEqual(store.searchBigram(SECRET, { scope: 'work' }), []);
  const after = await recallInjection({ store, query: SECRET, scope: 'work', now: clock.now() });
  assert.deepEqual(after.recalled.items, []);
  assert.ok(!after.injected.includes(SECRET), '遗忘后注入不得包含正文');
  assert.equal(store.dueReminders({ scope: 'work', now: dueAt }).length, 0);
  assert.deepEqual(store.listReminders({ scope: 'work' }), []);

  // 冷静期：只软删，行仍在、状态为 tombstoned、deleted_at 已写
  const seconds = toEpochSeconds(TEST_NOW);
  const fact = store.getFact(seeded.factId);
  assert.ok(fact, '冷静期内 fact 行必须仍在');
  assert.equal(fact.status, 'tombstoned');
  assert.equal(fact.deleted_at, seconds);
  const episode = store.getEpisode(seeded.episodeId);
  assert.ok(episode, '冷静期内 episode 行必须仍在');
  assert.equal(episode.status, 'tombstoned');
  assert.equal(episode.deleted_at, seconds);

  // deleted 行默认不出现在列表里，但 includeDeleted 能读到
  assert.equal(store.listFacts({ scope: 'work' }).length, 0);
  assert.equal(store.listEpisodes({ scope: 'work' }).length, 0);
  assert.equal(store.listFacts({ scope: 'work', includeDeleted: true }).length, 1);
  assert.equal(store.listEpisodes({ scope: 'work', includeDeleted: true }).length, 1);

  // 不满 7 天：purge 不物理删除，也不产生 PURGED 审计
  clock.advanceDays(6);
  assert.deepEqual(store.purge({ now: clock.seconds() }), { facts: 0, episodes: 0 });
  assert.ok(store.getFact(seeded.factId));
  assert.ok(store.getEpisode(seeded.episodeId));
  assert.equal(store.listEvents({ limit: 100 }).length, 0, '冷静期内不应有任何审计事件');
});

test('满 7 天 purge：业务表与 FTS 清零、只留 PURGED 审计、scope 隔离、幂等', async (t) => {
  const { store } = makeTempStore({ t });
  const clock = createClock();

  // work scope：待遗忘；main scope：必须完全不受影响
  const work = seedMemory(store, { scope: 'work', now: clock.now() });
  const main = seedMemory(store, {
    scope: 'main',
    now: clock.now(),
    title: '记一下薄荷项目的里程碑',
    summary: '薄荷项目定在十二月发布。',
    statement: '薄荷项目定在十二月发布。',
    subjectText: OTHER,
    predicate: '发布时间',
    objectText: '十二月',
    reminderTitle: '确认薄荷项目发布时间',
  });

  forgetMemory(store, {
    scope: 'work',
    factId: work.factId,
    episodeId: work.episodeId,
    reminderId: work.reminderId,
    now: clock.now(),
  });

  // 第 6 天仍在冷静期
  clock.advanceDays(6);
  assert.deepEqual(store.purge({ now: clock.seconds() }), { facts: 0, episodes: 0 });
  assert.ok(store.getFact(work.factId), '不满 7 天不得物理删除 fact');

  // 第 7 天整：物理删除 fact + episode
  clock.advanceDays(1);
  assert.deepEqual(store.purge({ now: clock.seconds() }), { facts: 1, episodes: 1 });
  assert.equal(store.getFact(work.factId), null);
  assert.equal(store.getEpisode(work.episodeId), null);
  assert.equal(store.getReminder(work.reminderId), null);

  // 8 张业务表在 work scope 清零（entities/threads 无 scope 列，按全局断言）
  for (const table of [
    'consolidations',
    'episodes',
    'facts',
    'reminders',
    'state_board',
    'state_board_rev',
  ]) {
    assert.equal(countScope(store, table, 'work'), 0, `${table} 不应残留 work 行`);
  }
  const stats = store.stats();
  assert.equal(stats.entities, 0);
  assert.equal(stats.threads, 0);

  // FTS：无孤儿投影，且投影总数与主表一致
  assert.equal(countOrphans(store, 'fts_facts', 'facts'), 0);
  assert.equal(countOrphans(store, 'fts_episodes', 'episodes'), 0);
  assert.equal(stats.fts_facts, stats.facts);
  assert.equal(stats.fts_episodes, stats.episodes);
  assert.deepEqual(store.searchBigram(SECRET), []);

  // 审计：只留 PURGED，且 detail_json 不含正文
  const events = store.listEvents({ limit: 100 });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.table_name).sort(), ['episodes', 'facts']);
  for (const event of events) {
    assert.equal(event.action, 'PURGED');
    assert.equal(event.actor, 'scheduler');
    assert.equal(event.reason, 'purge');
    assert.deepEqual(JSON.parse(event.detail_json), { salience: 'normal' });
    assert.ok(!event.detail_json.includes(SECRET), '审计 detail 不得含正文');
    assert.ok(!event.detail_json.includes('蓝鲸'), '审计 detail 不得含事实内容');
  }
  assert.deepEqual(
    new Set(events.map((event) => event.row_id)),
    new Set([work.factId, work.episodeId]),
  );

  // 其它 scope 完全不受影响
  assert.equal(store.listFacts({ scope: 'main' }).length, 1);
  assert.equal(store.listEpisodes({ scope: 'main' }).length, 1);
  assert.equal(store.listReminders({ scope: 'main' }).length, 1);
  assert.equal(store.searchBigram(OTHER, { scope: 'main' }).length, 2, 'main 的 fact 与 episode 都应命中');
  const other = await recallInjection({ store, query: OTHER, scope: 'main', now: clock.now() });
  assert.ok(other.recalled.items.length >= 1, '其它 scope 仍应可检索');
  assert.ok(other.injected.includes(OTHER));
  assert.equal(main.factId, store.listFacts({ scope: 'main' })[0].id);

  // 清理后再推进 30 天：检索仍为 0，审计不增长
  clock.advanceDays(30);
  assert.deepEqual(store.purge({ now: clock.seconds() }), { facts: 0, episodes: 0 });
  assert.deepEqual(store.searchBigram(SECRET), []);
  const gone = await recallInjection({ store, query: SECRET, scope: 'work', now: clock.now() });
  assert.deepEqual(gone.recalled.items, []);
  assert.ok(!gone.injected.includes(SECRET));
  assert.equal(store.listEvents({ limit: 100 }).length, 2);

  // 幂等：重复 purge 不报错、计数不变
  assert.deepEqual(store.purge({ now: clock.seconds() }), { facts: 0, episodes: 0 });
  assert.equal(store.stats().facts, 1);
  assert.equal(store.stats().episodes, 1);
  assert.equal(store.listEvents({ limit: 100 }).length, 2);
});

test('helpers：假模型草稿合法，可被巩固链路消费且同段不重复调用（不联网）', async (t) => {
  const { store } = makeTempStore({ t });
  const clock = createClock();
  const llm = makeFakeLlm();

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm,
    now: clock.seconds(),
    trigger: 'idle',
    sessionId: 'e2e-session',
  });

  assert.equal(result.skipped, false);
  assert.equal(result.upto_seq, 2);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0], { scope: 'main', seqFrom: 1, seqTo: 2 });
  assert.ok(store.getEpisode(result.episodeId));
  assert.equal(store.listFacts({ scope: 'main' }).length, 1);
  assert.equal(store.listReminders({ scope: 'main' }).length, 1);
  assert.equal(store.listEvents({ limit: 10 })[0].action, 'ADD');

  // 水位线已覆盖同一段：skipped，且不再调模型
  const again = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    llm,
    now: clock.seconds(),
  });
  assert.equal(again.skipped, true);
  assert.equal(llm.calls.length, 1);
});
