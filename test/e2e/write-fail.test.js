/**
 * V15 端到端：巩固写库失败时零落库、不触发压缩、不推进水位。
 *
 * 场景链：
 *   1. 正常路径：合法草稿（1 episode + 2 facts + 1 reminder）→ written，
 *      facts/episodes/reminders 入库，状态板只 staged、不发布。
 *   2. 失败路径：第 2 条 fact 插入抛错 → 单事务整体回滚，四张表计数为 0，
 *      水位停在旧值，状态板 revision/rendered/staged_* 全部不动，事件表为空。
 *   3. 压缩解耦：compact 仅在 consolidate 成功后才由调用方执行；失败时
 *      compact 0 次、假 adaptor 的 pending_compact 也未登记。
 *   4. 重试：恢复插入后重跑同一 seq 区间成功，水位只到本次 upto_seq，
 *      facts 不重复；再次重复同段直接 skipped。
 *
 * 只改测试；失败注入是实例级桩，不改 store.js / consolidate.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../../src/memory/store.js';
import { consolidate } from '../../src/memory/consolidate.js';
import { publishBoard, stageBoard } from '../../src/memory/state-board.js';
import {
  WRITE_FAIL_BASE as BASE,
  WRITE_FAIL_DAY as DAY,
  WRITE_FAIL_SEQ_FROM as SEQ_FROM,
  WRITE_FAIL_SEQ_TO as SEQ_TO,
  makeWriteFailDraft as makeDraft,
} from '../helpers/scenarios.js';

/** 每个测试独立内存库，t.after 关闭。 */
function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

/** 假 llm：记录调用参数，固定返回合法草稿。 */
function fakeLlm(draft = makeDraft()) {
  const calls = [];
  const llm = async (args) => {
    calls.push(args);
    return draft;
  };
  llm.calls = calls;
  return llm;
}

/** 巩固会写到的表 + 审计事件计数。 */
function counts(store) {
  const stats = store.stats();
  return {
    episodes: stats.episodes,
    facts: stats.facts,
    reminders: stats.reminders,
    consolidations: stats.consolidations,
    memory_events: stats.memory_events,
    state_board: stats.state_board,
  };
}

/** 状态板快照：已发布版本与暂存区。 */
function boardSnapshot(store, scope = 'main') {
  const board = store.getBoardState(scope);
  return {
    revision: board.revision,
    rendered: board.rendered,
    staged_revision: board.staged_revision,
    staged_rendered: board.staged_rendered,
    staged_at: board.staged_at,
  };
}

/** 假 adaptor：记录压缩相关调用，便于断言「失败不登记 pending_compact」。 */
function fakeAdaptor() {
  return {
    pending_compact: null,
    calls: [],
    markPendingCompact(meta) {
      this.calls.push(['markPendingCompact', meta]);
      this.pending_compact = meta;
    },
    async compact(args) {
      this.calls.push(['compact', args]);
    },
  };
}

/**
 * 模拟调用方：只有 consolidate 成功返回（非 skipped）才登记待压缩并压缩；
 * 抛错时直接向上冒泡，后面两步都不会执行。
 */
async function consolidateThenCompact(options) {
  const result = await consolidate(options);
  if (!result.skipped) {
    options.adaptor.markPendingCompact(result);
    await options.compact();
  }
  return result;
}

// ------------------------------------------------------------ 正常路径

test('V15 正常路径：写库成功、水位推进、状态板只 staged 不发布', async (t) => {
  const store = openStore(t);
  const llm = fakeLlm();
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: SEQ_FROM,
    seqTo: SEQ_TO,
    llm,
    now: BASE + 120,
  });

  assert.equal(result.skipped, false);
  assert.equal(result.upto_seq, SEQ_TO);
  assert.equal(result.facts, 2);
  assert.match(result.episodeId, /^ep_/);
  assert.deepEqual(llm.calls, [
    {
      scope: 'main',
      seqFrom: SEQ_FROM,
      seqTo: SEQ_TO,
      regionText: '',
      textSource: 'transcript',
      transcript: [],
    },
  ]);

  // consolidations：恰好一行 written，水位推进到本次 upto_seq。
  const rows = store.db
    .prepare('SELECT * FROM consolidations WHERE scope = ? ORDER BY upto_seq')
    .all('main');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'written');
  assert.equal(rows[0].upto_seq, SEQ_TO);
  assert.equal(rows[0].turn_from, SEQ_FROM);
  assert.equal(rows[0].turn_to, SEQ_TO);
  assert.equal(store.getWatermark('main'), SEQ_TO);

  // episode / facts / reminder 都已入库，并挂到本次 episode。
  const episode = store.getEpisode(result.episodeId);
  assert.equal(episode.title, 'V15 事务演练');
  assert.equal(episode.consolidation_id, rows[0].id);

  const facts = store.listFacts({ scope: 'main' });
  assert.equal(facts.length, 2);
  for (const fact of facts) {
    assert.equal(fact.source_kind, 'consolidated');
    assert.equal(fact.source_episode_id, result.episodeId);
  }
  assert.deepEqual(
    facts.map((fact) => fact.statement).sort(),
    ['dsh-companion 使用 SQLite 存储', '用户偏好黑咖啡'],
  );

  const reminders = store.listReminders({ scope: 'main' });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].title, '复盘 V15 事务回滚');
  assert.equal(reminders[0].status, 'pending');
  assert.equal(reminders[0].source_episode_id, result.episodeId);

  // 状态板：staged 存在，已发布 rendered 仍为空（发布不由巩固负责）。
  const board = store.getBoardState('main');
  assert.equal(board.revision, 0);
  assert.equal(board.rendered, '');
  assert.equal(board.staged_revision, 1);
  assert.match(board.staged_rendered, /【最近进展】/);
  assert.match(board.staged_rendered, /V15 事务演练/);
  assert.equal(store.getBoard('main'), '');

  // 审计事件：ADD episodes，detail 记录本次 upto_seq 与 facts 数（V7-L2 另有 kind/duration_ms）。
  const events = store.listEvents({ table_name: 'episodes', action: 'ADD' });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'consolidator');
  assert.equal(events[0].row_id, result.episodeId);
  const detail = JSON.parse(events[0].detail_json);
  assert.equal(detail.upto_seq, SEQ_TO);
  assert.equal(detail.facts, 2);
  assert.equal(detail.reminders, 1);
  assert.equal(detail.kind, 'consolidation');
  assert.ok(Number.isInteger(detail.duration_ms) && detail.duration_ms >= 0);
});

// ------------------------------------------------------------ 失败路径

test('V15 失败路径：第 2 条 fact 抛错 → 零落库、水位/状态板/事件均不动', async (t) => {
  const store = openStore(t);

  // 先放一块已发布旧板，证明失败不会改动 revision/rendered。
  stageBoard(store, 'main', '旧板：发布前内容');
  assert.equal(publishBoard(store, 'main', 'restart'), 1);
  const beforeBoard = boardSnapshot(store);
  assert.equal(beforeBoard.revision, 1);
  assert.equal(beforeBoard.rendered, '旧板：发布前内容');

  const before = counts(store);
  assert.deepEqual(before, {
    episodes: 0,
    facts: 0,
    reminders: 0,
    consolidations: 0,
    memory_events: 0,
    state_board: 0,
  });

  // 实例级桩：第 2 条 fact 插入时抛错；不改 store.js。
  const realInsertFact = store.insertFact.bind(store);
  let attempts = 0;
  store.insertFact = (input) => {
    attempts += 1;
    if (attempts === 2) throw new Error('V15 forced fact insert failure');
    return realInsertFact(input);
  };

  const adaptor = fakeAdaptor();
  let compactCalls = 0;
  const compact = async () => {
    compactCalls += 1;
  };

  try {
    await assert.rejects(
      () =>
        consolidateThenCompact({
          store,
          scope: 'main',
          seqFrom: SEQ_FROM,
          seqTo: SEQ_TO,
          llm: fakeLlm(),
          now: BASE + 60,
          adaptor,
          compact,
        }),
      /V15 forced fact insert failure/,
    );
  } finally {
    store.insertFact = realInsertFact;
  }

  assert.equal(attempts, 2, '应在第 2 条 fact 插入时失败');

  // 四张业务表 + 事件表全部零落库，水位保持旧值（0）。
  assert.deepEqual(counts(store), before, '单事务应整体回滚');
  assert.equal(store.getWatermark('main'), 0);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM consolidations WHERE status = 'written'").get().n,
    0,
  );
  assert.equal(store.getConsolidation('anything'), null);

  // 状态板：revision/rendered 未变，staged_* 未写入。
  assert.deepEqual(boardSnapshot(store), beforeBoard);
  assert.equal(store.getBoard('main'), '旧板：发布前内容');

  // 事件表没有任何记录，更没有 written 痕迹。
  assert.equal(store.stats().memory_events, 0);
  assert.equal(store.listEvents({ limit: 1000 }).length, 0);
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM memory_events WHERE detail_json LIKE '%written%'")
      .get().n,
    0,
  );

  // 压缩解耦：失败时调用方不压缩，pended_compact 也未登记。
  assert.equal(compactCalls, 0, '写库失败不得调用 compact');
  assert.equal(adaptor.calls.length, 0, '写库失败不得触碰 adaptor');
  assert.equal(adaptor.pending_compact, null);
});

// ------------------------------------------------------------ 重试

test('V15 重试：恢复插入后成功，水位只推进到本次 upto_seq，facts 不重复', async (t) => {
  const store = openStore(t);

  const realInsertFact = store.insertFact.bind(store);
  let attempts = 0;
  store.insertFact = (input) => {
    attempts += 1;
    if (attempts === 2) throw new Error('V15 forced fact insert failure');
    return realInsertFact(input);
  };

  const llm = fakeLlm();
  try {
    await assert.rejects(
      () =>
        consolidate({
          store,
          scope: 'main',
          seqFrom: SEQ_FROM,
          seqTo: SEQ_TO,
          llm,
          now: BASE + 180,
        }),
      /V15 forced fact insert failure/,
    );
  } finally {
    store.insertFact = realInsertFact;
  }

  assert.equal(store.getWatermark('main'), 0);
  assert.deepEqual(counts(store), {
    episodes: 0,
    facts: 0,
    reminders: 0,
    consolidations: 0,
    memory_events: 0,
    state_board: 0,
  });

  // 重试同一区间：成功且只写一份 facts，水位到 SEQ_TO。
  const retry = await consolidate({
    store,
    scope: 'main',
    seqFrom: SEQ_FROM,
    seqTo: SEQ_TO,
    llm,
    now: BASE + 240,
  });

  assert.equal(retry.skipped, false);
  assert.equal(retry.upto_seq, SEQ_TO);
  assert.equal(retry.facts, 2);
  assert.equal(store.getWatermark('main'), SEQ_TO);
  assert.equal(store.listFacts({ scope: 'main' }).length, 2, '首次失败的事实不得残留在库里');
  assert.equal(store.listEpisodes({ scope: 'main' }).length, 1);
  assert.equal(store.listReminders({ scope: 'main' }).length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM consolidations').get().n, 1);

  const afterRetry = counts(store);
  const retryEvents = store.listEvents({ table_name: 'episodes', action: 'ADD' });
  assert.equal(retryEvents.length, 1);

  // 再跑一次同段：水位已覆盖，直接 skipped，不再调模型、不再写库。
  const replay = await consolidate({
    store,
    scope: 'main',
    seqFrom: SEQ_FROM,
    seqTo: SEQ_TO,
    llm,
    now: BASE + 300,
  });
  assert.deepEqual(replay, { skipped: true, upto_seq: SEQ_TO, textSource: 'transcript' });
  assert.deepEqual(counts(store), afterRetry);
  assert.equal(store.listFacts({ scope: 'main' }).length, 2);
  assert.equal(llm.calls.length, 2, '失败一次 + 重试一次，skipped 不再调模型');
});
