/**
 * H4 遗忘闭环 e2e（卡片 t5）。
 *
 * 覆盖生产入口 memory/forget.js：
 *   S1 立即停读 → 状态板清洗 + publish('forget') → 7 天冷静期 / 立即物删；
 *   定向巩固（excludeFactIds）不把被遗忘 statement 写回；
 *   命令层 /记忆 忘掉、/记忆 彻底忘掉 的二次确认；
 *   memory_forget 工具的结构化返回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { forgetMemory } from '../../src/memory/forget.js';
import { retrieve } from '../../src/memory/retrieve.js';
import { renderBoard, PUBLISH_REASONS, publishBoard, stageBoard } from '../../src/memory/state-board.js';
import { handleCommand } from '../../src/runtime/commands.js';
import { createTools } from '../../src/runtime/tools.js';
import {
  DAY_SECONDS,
  TEST_NOW,
  makeDraft,
  makeFakeLlm,
  makeTempStore,
  recallInjection,
  seedMemory,
} from './helpers.js';

const SECRET = '青柠计划的代号是蓝鲸。';

/** 捕获 warn，避免定向巩固失败用例污染测试输出。 */
function makeLogger() {
  const warnings = [];
  return { warnings, warn(...args) { warnings.push(args); } };
}

/**
 * 造一个「目标事实来自已巩固区间」的库：episode 的 consolidation_id 指向
 * 一条 written 的 nap 巩固（turn_from=10, turn_to=12）。这样定向巩固会
 * 重跑同一区间（forget_flush 允许绕过水位）。
 */
function seedConsolidatedFact(store, options = {}) {
  const seeded = seedMemory(store, options);
  const at = Math.floor(TEST_NOW / 1000);
  const consolidation = store.insertConsolidation({
    scope: 'main',
    session_id: 'main',
    kind: 'nap',
    trigger: 'idle',
    upto_seq: 12,
    turn_from: 10,
    turn_to: 12,
    status: 'written',
    started_at: at,
    finished_at: at,
  });
  store.db
    .prepare('UPDATE episodes SET consolidation_id = ? WHERE id = ?')
    .run(consolidation.id, seeded.episodeId);
  return { ...seeded, consolidation };
}

test('forgetMemory：S1 立即停读，冷静期内不物删，满 7 天 purge 归零', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  const result = forgetMemory({ store, kind: 'fact', id: seeded.factId, at: TEST_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.purged, false);
  assert.equal(result.purgeAt, Math.floor(TEST_NOW / 1000) + 7 * DAY_SECONDS);

  // 行仍在，但已 tombstone + deleted_at
  const row = store.getFact(seeded.factId);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, Math.floor(TEST_NOW / 1000));
  assert.deepEqual(JSON.parse(row.purge_payload), { statement: SECRET, kind: 'project', scope: 'main' });

  // 检索 / 召回 / 注入立即归零（episode 也一起忘掉后按 SECRET 查）
  forgetMemory({ store, kind: 'episode', id: seeded.episodeId, at: TEST_NOW });
  assert.deepEqual(store.searchBigram('蓝鲸', { scope: 'main' }), []);
  const recalled = await retrieve({ store, query: '蓝鲸', scope: 'main', now: TEST_NOW });
  assert.equal(recalled.items.length, 0);
  const injection = await recallInjection({ store, query: '蓝鲸', scope: 'main', now: TEST_NOW });
  assert.equal(injection.injected.includes('蓝鲸'), false);

  // 冷静期内 purge 不动（Store 的数字时间参数按 Unix 秒）
  const early = store.purge({ now: Math.floor(TEST_NOW / 1000) + 6 * DAY_SECONDS });
  assert.deepEqual(early, { facts: 0, episodes: 0 });
  assert.ok(store.getFact(seeded.factId), '冷静期内行仍保留');

  // 满 7 天：主表 + FTS 一起清掉
  const late = store.purge({ now: Math.floor(TEST_NOW / 1000) + 7 * DAY_SECONDS + 1 });
  assert.deepEqual(late, { facts: 1, episodes: 1 });
  assert.equal(store.getFact(seeded.factId), null);
  assert.equal(store.getEpisode(seeded.episodeId), null);
  assert.deepEqual(store.searchBigram('蓝鲸', { scope: 'main' }), []);
});

test('forgetMemory：immediate 无 confirm 拒绝，有 confirm 立即物删', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  const refused = forgetMemory({ store, id: seeded.factId, at: TEST_NOW, immediate: true });
  assert.deepEqual(
    { ok: refused.ok, reason: refused.reason },
    { ok: false, reason: 'needs_confirm' },
  );
  assert.equal(store.getFact(seeded.factId).status, 'active', '拒绝时不得改库');

  const purged = forgetMemory({
    store,
    id: seeded.factId,
    at: TEST_NOW,
    immediate: true,
    confirm: true,
  });
  assert.equal(purged.ok, true);
  assert.equal(purged.purged, true);
  assert.equal(purged.purgeAt, Math.floor(TEST_NOW / 1000));
  assert.equal(store.getFact(seeded.factId), null);
  assert.deepEqual(
    store.searchBigram('蓝鲸', { scope: 'main' }).filter((hit) => hit.type === 'fact'),
    [],
    '事实已物删，检索不得再命中 fact',
  );
});

test('forgetMemory：not_found / already_deleted 幂等，purgeIds 不删 active 行', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  assert.equal(forgetMemory({ store, id: 'fact_missing', at: TEST_NOW }).reason, 'not_found');

  assert.equal(forgetMemory({ store, id: seeded.factId, at: TEST_NOW }).ok, true);
  const again = forgetMemory({ store, id: seeded.factId, at: TEST_NOW });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already_deleted');

  // 目标之外的 id 不会被 purgeIds 误删
  assert.deepEqual(
    store.purgeIds({ facts: [seeded.factId, 'other'], at: Math.floor(TEST_NOW / 1000) }),
    { facts: 1, episodes: 0 },
  );
  assert.equal(forgetMemory({ store, id: seeded.factId, at: TEST_NOW }).reason, 'not_found');
});

test('forgetMemory：状态板 rendered/staged/行同步清洗，并以 forget 发布', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  store.replaceBoardLines('main', [
    { section: 'in_progress', line: SECRET },
    { section: 'in_progress', line: '保留：本周整理预算' },
  ]);
  const text = `【当前状态】\n- ${SECRET}\n- 保留：本周整理预算\n`;
  stageBoard(store, 'main', text);
  assert.equal(publishBoard(store, 'main', 'compact'), 1);
  stageBoard(store, 'main', text);
  assert.equal(store.getBoardState('main').staged_revision, 2);

  const result = forgetMemory({ store, id: seeded.factId, at: TEST_NOW });
  assert.equal(result.ok, true);
  assert.equal(result.boardRevision, 2, '遗忘应发布 staged 并推进 revision');

  const state = store.getBoardState('main');
  assert.equal(state.revision, 2);
  assert.equal(state.rendered.includes(SECRET), false, 'rendered 不应保留被遗忘正文');
  assert.equal(state.rendered.includes('蓝鲸'), false);
  assert.equal((state.staged_rendered ?? '').includes(SECRET), false, 'staged 不应保留被遗忘正文');
  assert.equal(
    store.listBoardLines('main').some((row) => row.line.includes('蓝鲸')),
    false,
    '状态板行应同步删除',
  );
});

test('PUBLISH_REASONS：forget 是合法发布原因，非法 reason 仍被拒绝', (t) => {
  const { store } = makeTempStore({ t });
  assert.ok(PUBLISH_REASONS.includes('forget'));
  stageBoard(store, 'main', '遗忘后状态板');
  assert.equal(publishBoard(store, 'main', 'forget'), 1);
  assert.equal(store.getBoard('main'), '遗忘后状态板');
  assert.equal(publishBoard(store, 'main', 'forget'), null);
  assert.equal(publishBoard(store, 'main', 'bogus'), null);
});

test('forgetMemory：episode 遗忘路径停读、清板并按时物删', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  const result = forgetMemory({ store, kind: 'episode', id: seeded.episodeId, at: TEST_NOW });
  assert.equal(result.ok, true);
  assert.equal(store.getEpisode(seeded.episodeId).status, 'tombstoned');

  const state = store.getBoardState('main');
  assert.equal(state.rendered.includes('讨论青柠计划的分阶段安排'), false);

  const hits = store.searchBigram('分阶段安排', { scope: 'main' });
  assert.deepEqual(hits.filter((hit) => hit.type === 'episode'), []);
  const recalled = await retrieve({ store, query: '分阶段安排', scope: 'main', now: TEST_NOW });
  assert.equal(recalled.items.some((item) => item.kind === 'episode'), false);

  assert.deepEqual(
    store.purge({ now: Math.floor(TEST_NOW / 1000) + 7 * DAY_SECONDS + 1 }),
    { facts: 0, episodes: 1 },
  );
  assert.equal(store.getEpisode(seeded.episodeId), null);
});

test('定向巩固：excludeFactIds 不把目标 statement 写回，并记 forget_flush', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedConsolidatedFact(store);
  const draft = makeDraft({
    facts: [
      // 同一 statement，但 key 与目标不同：只能靠 excludeFactIds 拦住
      {
        kind: 'project',
        subject_text: '青柠计划',
        predicate: '别名',
        object_text: '蓝鲸',
        statement: SECRET,
      },
      {
        kind: 'project',
        subject_text: '薄荷项目',
        predicate: '状态',
        object_text: '已立项',
        statement: '薄荷项目已立项。',
      },
    ],
    reminders: [],
  });
  const llm = makeFakeLlm(draft);

  const result = await forgetMemory({
    store,
    id: seeded.factId,
    at: TEST_NOW,
    llm,
    logger: makeLogger(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.consolidation.skipped, false);
  assert.equal(result.consolidation.kind, 'forget_flush');
  assert.equal(result.consolidation.excluded, 1, '目标 statement 对应的草稿事实应被丢弃');
  assert.equal(llm.calls.length, 1);
  assert.deepEqual([llm.calls[0].seqFrom, llm.calls[0].seqTo], [10, 12]);

  const active = store.listFacts({ scope: 'main', status: 'active' });
  assert.equal(active.some((fact) => fact.statement === SECRET), false, '目标不得写回');
  assert.equal(active.some((fact) => fact.statement === '薄荷项目已立项。'), true);
  assert.equal(store.getFact(seeded.factId).status, 'tombstoned');
  assert.equal(store.getWatermark('main'), 12, '重巩固不得把水位推回去');
});

test('定向巩固失败只 warn，不阻断 S1', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedConsolidatedFact(store);
  const logger = makeLogger();
  const llm = async () => {
    throw new Error('llm boom');
  };

  const result = await forgetMemory({
    store,
    id: seeded.factId,
    at: TEST_NOW,
    llm,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.consolidation.reason, 'failed');
  assert.equal(logger.warnings.length, 1);
  const row = store.getFact(seeded.factId);
  assert.equal(row.status, 'tombstoned');
  assert.ok(row.deleted_at);
});

test('PURGED 审计只留 id/档位，不含正文', async (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);

  forgetMemory({ store, id: seeded.factId, at: TEST_NOW, immediate: true, confirm: true });
  const events = store.listEvents({ action: 'PURGED', limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].table_name, 'facts');
  assert.equal(events[0].row_id, seeded.factId);
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].reason, 'forget');
  assert.deepEqual(JSON.parse(events[0].detail_json), { salience: 'normal' });
  const dump = JSON.stringify(events[0]);
  assert.equal(dump.includes('蓝鲸'), false);
  assert.equal(dump.includes('青柠计划'), false);
});

test('命令层：/记忆 忘掉 走 S1，/记忆 彻底忘掉 需「确认」后才物删', (t) => {
  const { store } = makeTempStore({ t });
  const first = seedMemory(store);
  const second = seedMemory(store, {
    title: '薄荷项目立项',
    summary: '用户说薄荷项目已立项。',
    statement: '薄荷项目已立项。',
    subjectText: '薄荷项目',
    predicate: '状态',
    objectText: '已立项',
    reminderTitle: '跟进薄荷项目排期',
  });
  const ctx = { store, now: TEST_NOW, scope: 'main' };

  const s1 = handleCommand({ ...ctx, text: `/记忆 忘掉 ${first.factId}` });
  assert.equal(s1.handled, true);
  assert.match(s1.reply, /标记为遗忘/);
  assert.match(s1.reply, /7 天后物理删除/);
  assert.equal(store.getFact(first.factId).status, 'tombstoned');

  const ask = handleCommand({ ...ctx, text: `/记忆 彻底忘掉 ${second.factId}` });
  assert.equal(ask.handled, true);
  assert.equal(ask.reply, `回复 /记忆 彻底忘掉 ${second.factId} 确认 立即删除`);
  assert.equal(store.getFact(second.factId).status, 'active');

  const confirmed = handleCommand({ ...ctx, text: `/记忆 彻底忘掉 ${second.factId} 确认` });
  assert.equal(confirmed.handled, true);
  assert.match(confirmed.reply, /已彻底遗忘/);
  assert.equal(store.getFact(second.factId), null);

  const usage = handleCommand({ ...ctx, text: '/记忆 完全忘掉' });
  assert.equal(usage.handled, false, '未知子命令不接管');
});

test('memory_forget 工具：immediate/confirm 结构化返回，未知 id 为 not_found', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);
  const tools = createTools({
    store,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    registry: {},
    platform: {},
    clock: () => TEST_NOW,
  });
  const forget = tools.find((tool) => tool.name === 'memory_forget');
  assert.ok(forget);

  const refused = forget.execute({ id: seeded.factId, immediate: true });
  assert.deepEqual(
    { ok: refused.ok, reason: refused.reason },
    { ok: false, reason: 'needs_confirm' },
  );

  const purged = forget.execute({ id: seeded.factId, immediate: true, confirm: true });
  assert.equal(purged.ok, true);
  assert.equal(purged.purged, true);
  assert.equal(store.getFact(seeded.factId), null);

  assert.equal(forget.execute({ id: 'fact_missing' }).reason, 'not_found');
  assert.throws(() => forget.execute({}), /id/);
});

test('scrubStateBoard：行级定位不到时重渲染并写 staged', (t) => {
  const { store } = makeTempStore({ t });
  const seeded = seedMemory(store);
  store.setStagedBoard('main', '【当前状态】\n- 与遗忘无关的旧文本\n');

  const scrubbed = store.scrubStateBoard({ scope: 'main', ids: [seeded.factId], now: TEST_NOW });
  assert.equal(scrubbed.located, false);
  assert.equal(scrubbed.rerendered, true);
  assert.equal(scrubbed.staged.includes('（暂无）') || scrubbed.staged.includes('提醒'), true);
  assert.equal(scrubbed.staged.includes(SECRET), false, '兜底重渲染也要清掉目标正文');
  assert.equal(renderBoard({ facts: [], recent: [], threads: [], reminders: [] }).startsWith('【'), true);
});
