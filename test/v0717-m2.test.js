/**
 * v0.7.17 第 5 步 M2：批量 memory_forget + FTS 自检。
 *
 * **非真机证据**：每条用例都在 `:memory:`（或临时文件）SQLite 上跑真实 store
 * 代码，但 dsh 宿主侧全部缺失 —— 这里验证的是插件自己的遗忘链与 FTS 投影
 * 统计口径，不是云端 50041 的真机行为。
 *
 * 覆盖：
 *   - `forgetMany`（memory/forget.js）：逐条独立、不回滚、状态板一次收尾、
 *     immediate+confirm 单次 purgeIds、前缀优先归类、参数上限；
 *   - `memory_forget` 工具：`ids` 批量分流、单 `id` 路径一字不动（`{}` 仍抛 /id/）；
 *   - `store.ftsHealth()` + `/状态` 的 `formatFtsLine`：孤儿 / 缺投影 / 仅信息三档。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { forgetMany } from '../src/memory/forget.js';
import { createTools } from '../src/runtime/tools.js';
import { handleCommand } from '../src/runtime/commands.js';
import { makeTempStore, seedMemory, TEST_NOW } from './e2e/helpers.js';

// ---------------------------------------------------------------- 工具/存储

function countBoardPublishes(store) {
  const counter = { calls: 0 };
  const original = store.publishBoard.bind(store);
  store.publishBoard = (scope) => {
    counter.calls += 1;
    return original(scope);
  };
  return counter;
}

function countPurgeCalls(store) {
  const counter = { calls: 0, facts: 0, episodes: 0 };
  const original = store.purgeIds.bind(store);
  store.purgeIds = (options = {}) => {
    counter.calls += 1;
    const rows = original(options);
    counter.facts += rows?.facts ?? 0;
    counter.episodes += rows?.episodes ?? 0;
    return rows;
  };
  return counter;
}

function eventCount(store, action) {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE action = ?').get(action);
  return row?.n ?? 0;
}

function makeForgetTool(store) {
  const tools = createTools({
    store,
    retrieve: async () => [],
    registry: null,
    platform: null,
    clock: () => TEST_NOW,
    cwd: '/tmp/dsh-companion-m2',
  });
  const tool = tools.find((entry) => entry.name === 'memory_forget');
  assert.ok(tool, 'memory_forget tool must exist');
  return tool;
}

/** 造一条孤立 FTS 行（主表已无该 rowid）。fts_facts 只有一列 `txt`（fts5 unicode61）。 */
function insertOrphanFtsRow(store, rowid = 999_999) {
  store.db.prepare('INSERT INTO fts_facts (rowid, txt) VALUES (?, ?)').run(rowid, '孤儿投影');
}

/** 删掉某条 active 事实的 FTS 投影（模拟漏投影）。 */
function dropFtsRow(store, table, id) {
  const row = store.db.prepare(`SELECT rowid AS rid FROM ${table} WHERE id = ?`).get(id);
  assert.ok(row, `row ${id} must exist`);
  store.db
    .prepare(`DELETE FROM ${table === 'facts' ? 'fts_facts' : 'fts_episodes'} WHERE rowid = ?`)
    .run(row.rid);
}

// ---------------------------------------------------------------- forgetMany

test('M2 forgetMany：混合批 1 坏 + 2 好 —— 2 条 tombstoned、summary 正确、状态板只发布 1 次', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const first = seedMemory(store, { statement: '批一：代号是蓝鲸。' });
    const second = seedMemory(store, { statement: '批二：预算待定。' });
    const publishes = countBoardPublishes(store);

    const result = forgetMany({
      store,
      ids: [first.factId, 'fact-missing-1', second.factId],
      at: TEST_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'batch');
    assert.deepEqual(result.summary, { requested: 3, marked: 2, failed: 1, purged: 0 });
    assert.equal(publishes.calls, 1, '批量收尾只允许 publish 一次');
    const byId = new Map(result.results.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(first.factId).ok, true);
    assert.equal(byId.get(second.factId).ok, true);
    assert.equal(byId.get('fact-missing-1').reason, 'not_found');
    assert.equal(store.getFact(first.factId).status, 'tombstoned');
    assert.equal(store.getFact(second.factId).status, 'tombstoned');
    assert.deepEqual(result.consolidation, { skipped: true, reason: 'no-llm' });
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：id 前缀优先 —— `ep-*` 即使 kind=fact 也按 episode 遗忘', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const seeded = seedMemory(store);
    const result = forgetMany({ store, ids: [seeded.episodeId], kind: 'fact', at: TEST_NOW });
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].kind, 'episode');
    assert.equal(store.getEpisode(seeded.episodeId).status, 'tombstoned');
    assert.equal(store.getFact(seeded.factId).status, 'active');
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：无前缀 id 回落 kind 参数；顺序与去重保持不变', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const seeded = seedMemory(store);
    const bareEpisodeId = seeded.episodeId.replace(/^ep-/, 'x-');
    store.db
      .prepare('UPDATE episodes SET id = ? WHERE id = ?')
      .run(bareEpisodeId, seeded.episodeId);
    const result = forgetMany({
      store,
      ids: [bareEpisodeId, bareEpisodeId],
      kind: 'episode',
      at: TEST_NOW,
    });
    assert.equal(result.summary.requested, 1, '重复 id 去重后只算一条');
    assert.equal(result.results[0].kind, 'episode');
    assert.equal(store.getEpisode(bareEpisodeId).status, 'tombstoned');
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：空数组 / 非数组 / 非字符串 / 超 50 条均抛 TypeError', () => {
  const { store, cleanup } = makeTempStore();
  try {
    assert.throws(() => forgetMany({ store, ids: [] }), /ids must not be empty/u);
    assert.throws(() => forgetMany({ store, ids: 'fact-1' }), /ids must be an array/u);
    assert.throws(() => forgetMany({ store, ids: [42] }), /non-empty strings/u);
    const tooMany = Array.from({ length: 51 }, (_unused, index) => `fact-${index}`);
    assert.throws(() => forgetMany({ store, ids: tooMany }), /at most 50/u);
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：immediate 无 confirm 逐条 needs_confirm 且不软删', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const seeded = seedMemory(store);
    const result = forgetMany({
      store,
      ids: [seeded.factId, seeded.episodeId],
      at: TEST_NOW,
      immediate: true,
    });
    assert.equal(result.summary.marked, 0);
    assert.deepEqual(
      result.results.map((entry) => entry.reason),
      ['needs_confirm', 'needs_confirm'],
    );
    assert.equal(store.getFact(seeded.factId).status, 'active');
    assert.equal(store.getEpisode(seeded.episodeId).status, 'active');
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：immediate+confirm 只调用一次 purgeIds，且 PURGED 审计只有一条', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const seeded = seedMemory(store);
    const purges = countPurgeCalls(store);
    const result = forgetMany({
      store,
      ids: [seeded.factId, seeded.episodeId],
      at: TEST_NOW,
      immediate: true,
      confirm: true,
    });
    assert.equal(purges.calls, 1, '批量物删只允许一次 purgeIds');
    assert.equal(purges.facts, 1);
    assert.equal(purges.episodes, 1);
    assert.equal(result.summary.purged, 2);
    assert.equal(result.results.every((entry) => entry.purged === true), true);
    assert.equal(store.getFact(seeded.factId), null);
    assert.equal(store.getEpisode(seeded.episodeId), null);
    // purgeIds 的审计是「每表一条」（一次调用 facts + episodes → 2 条 PURGED），
    // 逐条路径会变成 4 条；因此 2 条正是「只物删一次」的证据。
    assert.equal(eventCount(store, 'PURGED'), 2);
  } finally {
    cleanup();
  }
});

test('M2 forgetMany：跨 scope 的条目逐条拒绝，不影响同批其它条目', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const inScope = seedMemory(store, { scope: 'main', statement: '主作用域：代号蓝鲸。' });
    const outScope = seedMemory(store, { scope: 'other', statement: '其它作用域：代号白鲸。' });
    const result = forgetMany({
      store,
      ids: [inScope.factId, outScope.factId],
      scope: 'main',
      at: TEST_NOW,
    });
    const byId = new Map(result.results.map((entry) => [entry.id, entry]));
    assert.equal(byId.get(inScope.factId).ok, true);
    assert.equal(byId.get(outScope.factId).reason, 'scope_denied');
    assert.equal(store.getFact(outScope.factId).status, 'active');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- 工具层

test('M2 工具：ids 批量分流；execute({}) 仍抛 /id/（单条路径一字不动）', async () => {
  const { store, cleanup } = makeTempStore();
  try {
    const tool = makeForgetTool(store);
    assert.throws(() => tool.execute({}), /id/u);

    const seeded = seedMemory(store);
    const result = await tool.execute({ ids: [seeded.factId, seeded.episodeId] });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'batch');
    assert.equal(result.summary.marked, 2);

    const single = await tool.execute({ id: seedMemory(store).factId });
    assert.equal(single.ok, true);
    assert.equal(single.kind, 'fact');
    assert.equal(single.tombstoned, true);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------- FTS 自检

test('M2 ftsHealth：干净库全零；孤儿 / 缺投影 / 软删仍留索引三档各自命中', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const clean = store.ftsHealth();
    assert.equal(clean.orphans, 0);
    assert.equal(clean.missing, 0);
    assert.equal(clean.inactiveWithFts, 0);

    const seeded = seedMemory(store);
    insertOrphanFtsRow(store);
    dropFtsRow(store, 'facts', seeded.factId);
    forgetMany({ store, ids: [seeded.episodeId], kind: 'episode', at: TEST_NOW });

    const health = store.ftsHealth();
    assert.equal(health.orphans, 1);
    assert.equal(health.missing, 1);
    assert.ok(health.inactiveWithFts >= 1, 'tombstoned episode 的 FTS 行应留到 S2 purge');
    assert.equal(health.orphans, health.factOrphans + health.episodeOrphans);
    assert.equal(health.missing, health.factMissing + health.episodeMissing);
  } finally {
    cleanup();
  }
});

function statusReply(options = {}) {
  const temp = makeTempStore();
  try {
    return handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      timeZone: 'Asia/Shanghai',
      ...options,
    }).reply;
  } finally {
    temp.cleanup();
  }
}

test('M2 /状态：未传 fts 或全零时省行；孤儿 / 缺投影 / 仅信息三档文案', () => {
  assert.doesNotMatch(statusReply(), /FTS 自检/u);
  assert.doesNotMatch(statusReply({ fts: { orphans: 0, missing: 0, inactiveWithFts: 0 } }), /FTS 自检/u);

  assert.match(statusReply({ fts: { orphans: 2 } }), /FTS 自检：FTS 孤儿 2/u);
  assert.match(statusReply({ fts: { missing: 3 } }), /FTS 自检：缺投影 3/u);
  assert.match(
    statusReply({ fts: { inactiveWithFts: 4 } }),
    /FTS 自检：已遗忘仍留索引 4（S2 清理）/u,
  );
  assert.match(
    statusReply({ fts: { orphans: 1, missing: 2, inactiveWithFts: 3 } }),
    /FTS 自检：FTS 孤儿 1 · 缺投影 2 · 已遗忘仍留索引 3（S2 清理）/u,
  );
});
