/**
 * SQLite 存储层测试：建表、bigram FTS、scope 隔离、删除标记与 purge、
 * 水位线、状态板 staged/发布、线程冻结、事务回滚、注入安全。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/memory/store.js';
import { toBigrams, toMatchQuery } from '../src/memory/bigram.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-store-'));
const dbPath = join(dir, 'companion.db');
/** @type {Store} */
let store;

before(() => {
  store = Store.open(dbPath);
});

after(() => {
  try {
    store?.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一条最小可用事实，减少测试重复。 */
function makeFact(overrides = {}) {
  return {
    kind: 'other',
    subject_text: '测试',
    predicate: '是',
    statement: '测试事实',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: 1_700_000_000,
    ...overrides,
  };
}

test('Store.open 建出 11 张业务/辅助表与 2 张 FTS 虚表', () => {
  const expected = [
    'entities', 'episodes', 'facts', 'reminders', 'state_board',
    'state_board_rev', 'threads', 'consolidations', 'memory_events', 'schema_meta',
    'fact_vectors',
  ];
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of expected) {
    assert.ok(names.includes(table), `缺少表 ${table}`);
  }
  assert.ok(names.includes('fts_facts'));
  assert.ok(names.includes('fts_episodes'));

  const version = store.db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get();
  assert.equal(version.value, '13');

  // 状态板占位行
  const board = store.getBoardState('main');
  assert.equal(board.revision, 0);
  assert.equal(board.rendered, '');
});

test('toBigrams 生成重叠二元组并去重、限长；toMatchQuery 用 AND 连接', () => {
  const tokens = toBigrams('我妈生日是五月').split(' ');
  for (const expected of ['我妈', '妈生', '生日', '日是', '是五', '五月']) {
    assert.ok(tokens.includes(expected), `缺少 bigram ${expected}`);
  }
  assert.equal(toMatchQuery('生日'), '"生日"');
  assert.equal(toMatchQuery('我妈 生日'), '"我妈" AND "生日"');
  assert.equal(toMatchQuery('Node 24'), '"node" AND "24"');
  assert.equal(toMatchQuery('   '), '');
  assert.equal(toMatchQuery(null), '');

  const deduped = toBigrams('生日生日').split(' ');
  assert.equal(deduped.filter((token) => token === '生日').length, 1);
  assert.ok(toBigrams('啊'.repeat(2_000)).split(' ').length <= 512);
});

test('insertFact 后 searchBigram 能命中中文 bigram（生日/我妈）', () => {
  const fact = store.insertFact(
    makeFact({
      scope: 'main',
      kind: 'relation',
      subject_text: '妈',
      predicate: '生日',
      object_text: '五月',
      statement: '我妈生日是五月',
      source_kind: 'user_explicit',
      salience: 'notable',
    }),
  );
  assert.equal(fact.strength_days, 60);

  for (const query of ['生日', '我妈', '五月']) {
    const hits = store.searchBigram(query, { scope: 'main' });
    assert.ok(
      hits.some((hit) => hit.type === 'fact' && hit.id === fact.id),
      `查询「${query}」未命中事实`,
    );
  }
  // 不存在的词返回空数组而不是抛错
  assert.deepEqual(store.searchBigram('不存在的词', { scope: 'main' }), []);
});

test('searchBigram 按 scope 隔离，不串线程', () => {
  const threadFact = store.insertFact(
    makeFact({
      scope: 'thread:housing',
      statement: '我妈生日是五月，线程里说的',
    }),
  );
  const mainHits = store.searchBigram('生日', { scope: 'main' });
  assert.equal(mainHits.some((hit) => hit.id === threadFact.id), false);

  const threadHits = store.searchBigram('生日', { scope: 'thread:housing' });
  assert.ok(threadHits.some((hit) => hit.type === 'fact' && hit.id === threadFact.id));

  // 不传 scope 时两个 scope 都返回
  const allHits = store.searchBigram('生日');
  assert.ok(allHits.some((hit) => hit.id === threadFact.id));
});

test('pin 与 deleted 过滤：pinned 不衰减，删除标记后检索不到', () => {
  const normal = store.insertFact(makeFact({ scope: 'pin-test', statement: '普通事实' }));
  assert.equal(normal.strength_days, 14);

  const pinned = store.insertFact(
    makeFact({ scope: 'pin-test', salience: 'pinned', statement: '置顶事实' }),
  );
  assert.equal(pinned.strength_days, null);

  const explicit = store.insertFact(
    makeFact({ scope: 'pin-test', salience: 'explicit', statement: '显式事实' }),
  );
  assert.equal(explicit.strength_days, 365);

  assert.throws(
    () => store.insertFact(makeFact({ scope: 'pin-test', salience: 'pinned', strength_days: 3 })),
    /pinned/,
  );

  const doomed = store.insertFact(
    makeFact({ scope: 'main', statement: '生日蛋糕要买', subject_text: '蛋糕' }),
  );
  assert.equal(store.searchBigram('蛋糕', { scope: 'main' }).length, 1);
  const deleted = store.deleteFact(doomed.id, { now: 1_700_000_100 });
  assert.equal(deleted.deleted_at, 1_700_000_100);
  assert.equal(store.searchBigram('蛋糕', { scope: 'main' }).length, 0);
  assert.equal(
    store.listFacts({ scope: 'main' }).some((row) => row.id === doomed.id),
    false,
  );
  // 已删除但未过冷静期的行仍在库里（S1 可撤销）
  assert.ok(store.getFact(doomed.id));
});

test('updateFact 改文本后刷新 FTS 投影，旧词不再命中', () => {
  const fact = store.insertFact(
    makeFact({ scope: 'update-test', statement: '原来有苹果', object_text: '苹果' }),
  );
  assert.equal(store.searchBigram('苹果', { scope: 'update-test' }).length, 1);

  store.updateFact(fact.id, { statement: '现在有香蕉', object_text: '香蕉' });
  assert.equal(store.searchBigram('苹果', { scope: 'update-test' }).length, 0);
  const hits = store.searchBigram('香蕉', { scope: 'update-test' });
  assert.ok(hits.some((hit) => hit.type === 'fact' && hit.id === fact.id));
});

test('episodes 写入、检索与列表', () => {
  const episode = store.insertEpisode({
    scope: 'ep-test',
    session_id: 'sess-ep',
    started_at: 100,
    ended_at: 200,
    title: '找房子',
    summary: '周末看了三套房子',
    topics: ['租房', '望京'],
    salience: 'notable',
  });
  assert.equal(episode.scope, 'ep-test');
  assert.equal(episode.strength_days, 60);
  assert.equal(JSON.parse(episode.topics_json).includes('望京'), true);

  const hits = store.searchBigram('望京', { scope: 'ep-test' });
  assert.ok(hits.some((hit) => hit.type === 'episode' && hit.id === episode.id));

  const list = store.listEpisodes({ scope: 'ep-test' });
  assert.equal(list.length, 1);
  assert.equal(store.getEpisode(episode.id).title, '找房子');
});

test('purge 物理删除过冷静期的行，主表、FTS、审计同步', () => {
  const now = 2_000_000_000;
  const gone = store.insertFact(
    makeFact({ scope: 'purge-test', statement: '待物理删除 绝密生日', subject_text: '绝密' }),
  );
  const rowid = store.db.prepare('SELECT rowid AS rid FROM facts WHERE id = ?').get(gone.id).rid;
  store.deleteFact(gone.id, { now });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fts_facts WHERE rowid = ?').get(rowid).n, 1);

  const kept = store.insertFact(
    makeFact({ scope: 'purge-test', statement: '没删除的生日记录' }),
  );

  const purgeNow = now + 8 * 86_400;
  const cutoff = purgeNow - 7 * 86_400;
  const expectedFacts = store.db
    .prepare('SELECT COUNT(*) AS n FROM facts WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
    .get(cutoff).n;
  const expectedEpisodes = store.db
    .prepare('SELECT COUNT(*) AS n FROM episodes WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
    .get(cutoff).n;
  const result = store.purge({ now: purgeNow, cutoffDays: 7 });

  assert.equal(result.facts, expectedFacts);
  assert.equal(result.episodes, expectedEpisodes);
  assert.ok(result.facts >= 1);
  assert.equal(store.getFact(gone.id), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM fts_facts WHERE rowid = ?').get(rowid).n, 0);
  assert.ok(store.getFact(kept.id));

  const audit = store.listEvents({ table_name: 'facts', action: 'PURGED', limit: 500 })
    .find((event) => event.row_id === gone.id);
  assert.ok(audit);
  assert.equal(String(audit.detail_json).includes('绝密'), false);
});

test('purge 先断开外键引用，避免 NO ACTION 外键阻塞物理删除', () => {
  const now = 2_100_000_000;
  const episode = store.insertEpisode({
    scope: 'purge-fk',
    session_id: 's',
    started_at: 1,
    ended_at: 2,
    title: '要被遗忘的情景',
    summary: '旧情景',
    salience: 'normal',
  });
  const oldFact = store.insertFact(
    makeFact({
      scope: 'purge-fk',
      statement: '被替代的旧事实',
      source_episode_id: episode.id,
    }),
  );
  const replacement = store.insertFact(
    makeFact({ scope: 'purge-fk', statement: '替代的新事实' }),
  );
  store.updateFact(replacement.id, { superseded_by: oldFact.id });
  const linkedFact = store.insertFact(
    makeFact({
      scope: 'purge-fk',
      statement: '仍引用旧情景的事实',
      source_episode_id: episode.id,
    }),
  );
  const reminder = store.insertReminder({
    scope: 'purge-fk',
    kind: 'todo',
    title: '仍引用旧情景的提醒',
    source_episode_id: episode.id,
    next_fire_at: 5,
  });
  store.upsertBoardLine({
    scope: 'purge-fk',
    section: 'in_progress',
    line: '仍引用旧情景的行',
    ref_episode_id: episode.id,
    last_mentioned_at: 10,
  });

  store.deleteFact(oldFact.id, { now });
  store.deleteEpisode(episode.id, { now });
  const result = store.purge({ now: now + 8 * 86_400, cutoffDays: 7 });

  assert.ok(result.facts >= 1);
  assert.ok(result.episodes >= 1);
  assert.equal(store.getEpisode(episode.id), null);
  assert.equal(store.getFact(oldFact.id), null);
  // 幸存行的引用被清空，正文保留
  assert.equal(store.getFact(linkedFact.id).source_episode_id, null);
  assert.equal(store.getFact(replacement.id).superseded_by, null);
  assert.equal(store.getReminder(reminder.id).source_episode_id, null);
  assert.equal(store.listBoardLines('purge-fk')[0].ref_episode_id, null);
  assert.ok(store.getFact(replacement.id));
});

test('getWatermark 只计 written/compacted 的 MAX(upto_seq)', () => {
  const written = store.insertConsolidation({
    scope: 'wm', session_id: 's', kind: 'nap', trigger: 'idle',
    upto_seq: 10, status: 'written', started_at: 1,
  });
  store.insertConsolidation({
    scope: 'wm', session_id: 's', kind: 'nap', trigger: 'over_24k',
    upto_seq: 20, status: 'compacted', started_at: 2,
  });
  const running = store.insertConsolidation({
    scope: 'wm', session_id: 's', kind: 'nap', trigger: 'idle',
    upto_seq: 30, status: 'running', started_at: 3,
  });
  store.insertConsolidation({
    scope: 'wm', session_id: 's', kind: 'deep', trigger: 'day_change',
    upto_seq: 40, status: 'failed', started_at: 4,
  });

  assert.equal(store.getWatermark('wm'), 20);
  assert.equal(store.getWatermark('wm-none'), 0);

  const marked = store.markConsolidated(running.id, { status: 'written', tokensIn: 1234 });
  assert.equal(marked.status, 'written');
  assert.equal(marked.tokens_in, 1234);
  assert.equal(store.getWatermark('wm'), 30);
  assert.ok(written.id);
});

test('状态板：staged 反复覆盖仍是 revision+1，发布后才翻进 rendered', () => {
  assert.equal(store.getBoard('main'), '');

  const first = store.setStagedBoard('main', '进行中: 写存储层');
  assert.equal(first.revision, 0);
  assert.equal(first.staged_revision, 1);
  const second = store.setStagedBoard('main', '进行中: 写存储层测试');
  assert.equal(second.staged_revision, 1);
  assert.equal(store.getBoard('main'), '');

  assert.equal(store.publishBoard('main'), 1);
  assert.equal(store.getBoard('main'), '进行中: 写存储层测试');
  assert.equal(store.getBoardState('main').staged_revision, null);
  assert.equal(store.publishBoard('main'), null);

  // 线程 scope 首次访问自动建占位行
  assert.equal(store.getBoard('thread:housing'), '');
  assert.equal(store.getBoardState('thread:housing').revision, 0);
});

test('状态板行：整块替换、按最近提及排序、更新与删除', () => {
  const count = store.replaceBoardLines('thread:board-lines', [
    { section: 'in_progress', line: '看房', last_mentioned_at: 100 },
    { section: 'in_progress', line: '约中介', last_mentioned_at: 200 },
    { section: 'decided', line: '预算五千', last_mentioned_at: 150 },
  ]);
  assert.equal(count, 3);
  assert.equal(store.listBoardLines('thread:board-lines').length, 3);

  const inProgress = store.listBoardLines('thread:board-lines', { section: 'in_progress' });
  assert.deepEqual(inProgress.map((row) => row.line), ['约中介', '看房']);

  store.upsertBoardLine({
    id: inProgress[0].id,
    scope: 'thread:board-lines',
    section: 'in_progress',
    line: '约了两家中介',
    last_mentioned_at: 300,
  });
  assert.equal(
    store.listBoardLines('thread:board-lines', { section: 'in_progress' })[0].line,
    '约了两家中介',
  );

  assert.equal(store.deleteBoardLine(inProgress[1].id), true);
  assert.equal(store.listBoardLines('thread:board-lines').length, 2);
});

test('线程目录：upsert、按状态过滤、冻结为 archived', () => {
  const thread = store.upsertThread({
    key: 'housing', name: '找房子', session_id: 'sess-1', description: '租房子', last_active_at: 100,
  });
  assert.equal(thread.status, 'active');
  assert.equal(
    store.listThreads({ status: 'active' }).some((row) => row.key === 'housing'),
    true,
  );

  const frozen = store.freezeThread('housing');
  assert.equal(frozen.status, 'archived');
  assert.equal(
    store.listThreads({ status: 'active' }).some((row) => row.key === 'housing'),
    false,
  );
  assert.equal(store.listThreads().some((row) => row.key === 'housing'), true);

  const updated = store.upsertThread({
    key: 'housing', name: '找房子（第二季）', session_id: 'sess-1',
    description: '继续租房', last_active_at: 200, status: 'active',
  });
  assert.equal(updated.name, '找房子（第二季）');
  assert.equal(updated.last_active_at, 200);
});

test('提醒：只取 pending/snoozed 且到点的行', () => {
  const due = store.insertReminder({
    scope: 'rm', kind: 'todo', title: '交水电费', next_fire_at: 1000,
  });
  store.insertReminder({
    scope: 'rm', kind: 'todo', title: '明天开会', next_fire_at: 5000,
  });
  store.insertReminder({
    scope: 'rm', kind: 'todo', title: '已完成的事', next_fire_at: 500, status: 'done',
  });

  const rows = store.dueReminders({ now: 2000, scope: 'rm' });
  assert.deepEqual(rows.map((row) => row.id), [due.id]);
  assert.equal(store.listReminders({ scope: 'rm' }).length, 3);
  assert.equal(store.listReminders({ scope: 'rm', status: 'pending' }).length, 2);
});

test('transaction：成功提交并透传返回值；fn 抛错则整体回滚、计数不变', () => {
  const before = store.stats().facts;

  assert.throws(
    () => store.transaction(() => {
      store.insertFact(makeFact({ scope: 'tx-test', statement: '事务里的事实 生日' }));
      assert.equal(store.stats().facts, before + 1);
      throw new Error('boom');
    }),
    /boom/,
  );
  // 失败后一行都不落库
  assert.equal(store.stats().facts, before);

  assert.equal(store.transaction(() => 42), 42);

  const committedId = store.transaction(
    () => store.insertFact(makeFact({ scope: 'tx-test', statement: '提交的事实' })).id,
  );
  assert.ok(store.getFact(committedId));

  // 返回 Promise 视为误用：回滚并报错
  assert.throws(() => store.transaction(async () => 1), /synchronous/);
});

test('所有 SQL 走参数绑定：注入串不生效，append-only 触发器拦截改删', () => {
  // 注入串被当成搜索 token，不会改变 SQL 结构
  assert.deepEqual(store.searchBigram("生日' OR 1=1 --", { scope: 'main' }), []);

  const tricky = store.insertFact(
    makeFact({
      scope: 'inject',
      statement: "Robert'); DROP TABLE facts; -- 生日",
      subject_text: "x'); DROP TABLE facts; --",
      predicate: 'y',
    }),
  );
  assert.ok(store.getFact(tricky.id));
  assert.ok(
    store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'facts'").get(),
  );

  const eventId = store.appendEvent({
    action: 'ADD', table_name: 'facts', row_id: tricky.id, actor: 'user',
    detail_json: { salience: 'normal' },
  });
  assert.equal(typeof eventId, 'number');
  assert.throws(
    () => store.db.prepare('UPDATE memory_events SET reason = ? WHERE id = ?').run('x', eventId),
    /append-only/,
  );
  assert.throws(
    () => store.db.prepare('DELETE FROM memory_events WHERE id = ?').run(eventId),
    /append-only/,
  );

  const listed = store.listEvents({ table_name: 'facts', row_id: tricky.id });
  assert.equal(listed.length, 1);
  assert.equal(JSON.parse(listed[0].detail_json).salience, 'normal');
});

test('stats 返回各表与 FTS 计数', () => {
  const counts = store.stats();
  for (const key of [
    'entities', 'episodes', 'facts', 'reminders', 'state_board', 'state_board_rev',
    'threads', 'consolidations', 'memory_events', 'fts_facts', 'fts_episodes',
  ]) {
    assert.equal(typeof counts[key], 'number', `${key} 应是数字`);
  }
  assert.equal(counts.fts_facts, counts.facts);
  assert.equal(counts.fts_episodes, counts.episodes);
});

test('forgetFact：active→tombstoned、正文快照进 purge_payload、立即停读且幂等', () => {
  const now = 2_200_000_000;
  const fact = store.insertFact(
    makeFact({
      scope: 'forget-fact',
      subject_text: '青柠计划',
      statement: '青柠计划的代号是蓝鲸',
    }),
  );
  assert.ok(store.searchBigram('青柠计划', { scope: 'forget-fact' }).length > 0);

  assert.equal(
    store.forgetFact(fact.id, { at: now, payload: { reason: 'user', excerpt: '青柠计划' } }),
    true,
  );
  const row = store.getFact(fact.id);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, now);
  assert.deepEqual(JSON.parse(row.purge_payload), { reason: 'user', excerpt: '青柠计划' });
  // S1 立即停读：FTS 行还在，但检索已过滤 deleted_at
  assert.equal(store.searchBigram('青柠计划', { scope: 'forget-fact' }).length, 0);

  // 幂等与缺行
  assert.equal(store.forgetFact(fact.id, { at: now + 10 }), false);
  assert.equal(store.getFact(fact.id).deleted_at, now);
  assert.equal(store.forgetFact('fact-does-not-exist'), false);
});

test('forgetFact：dormant 不转 tombstoned，且不影响其它 scope', () => {
  const dormant = store.insertFact(
    makeFact({ scope: 'forget-fact-dormant', statement: '休眠事实', status: 'dormant' }),
  );
  assert.equal(store.forgetFact(dormant.id, { at: 2_200_000_100 }), false);
  assert.equal(store.getFact(dormant.id).status, 'dormant');

  const target = store.insertFact(makeFact({ scope: 'forget-fact-b', statement: '本 scope 事实' }));
  const other = store.insertFact(makeFact({ scope: 'forget-fact-c', statement: '别的 scope 事实' }));
  assert.equal(store.forgetFact(target.id, { at: 2_200_000_100 }), true);
  assert.equal(store.getFact(other.id).status, 'active');
  // 默认 payload 为 {}
  assert.deepEqual(JSON.parse(store.getFact(target.id).purge_payload), {});
});

test('forgetEpisode：active→tombstoned 并保留行/FTS 到冷静期结束', () => {
  const now = 2_200_000_200;
  const episode = store.insertEpisode({
    scope: 'forget-episode',
    session_id: 's',
    title: '找房 青柠计划',
    summary: '确认租房攻略',
    salience: 'normal',
  });
  assert.ok(store.searchBigram('租房攻略', { scope: 'forget-episode' }).length > 0);

  assert.equal(
    store.forgetEpisode(episode.id, { at: now, payload: { kept: 'minimal' } }),
    true,
  );
  const row = store.getEpisode(episode.id);
  assert.equal(row.status, 'tombstoned');
  assert.equal(row.deleted_at, now);
  assert.deepEqual(JSON.parse(row.purge_payload), { kept: 'minimal' });
  assert.equal(store.searchBigram('租房攻略', { scope: 'forget-episode' }).length, 0);
  assert.ok(store.getEpisode(episode.id), '冷静期内行仍在');

  assert.equal(store.forgetEpisode(episode.id, { at: now }), false);
  assert.equal(store.forgetEpisode('episode-does-not-exist'), false);

  const dormant = store.insertEpisode({
    scope: 'forget-episode',
    session_id: 's',
    title: '已沉睡情景',
    status: 'dormant',
  });
  assert.equal(store.forgetEpisode(dormant.id, { at: now }), false);
  assert.equal(store.getEpisode(dormant.id).status, 'dormant');
});

test('forgetReminder：提醒无冷静期，S1 直接删行且幂等', () => {
  const reminder = store.insertReminder({
    scope: 'forget-reminder',
    kind: 'todo',
    title: '跟进青柠计划预算',
    next_fire_at: 1_700_000_000,
  });
  assert.equal(store.forgetReminder(reminder.id), true);
  assert.equal(store.getReminder(reminder.id), null);
  assert.deepEqual(store.listReminders({ scope: 'forget-reminder', includeDeleted: true }), []);
  assert.equal(store.forgetReminder(reminder.id), false);
  assert.equal(store.forgetReminder('reminder-does-not-exist'), false);
});

test('updateEpisode：白名单字段与 FTS 刷新；未知字段抛 TypeError；缺行返回 null', () => {
  const episode = store.insertEpisode({
    scope: 'episode-update',
    session_id: 's',
    title: '旧标题 找房',
    summary: '旧摘要',
    topics_json: ['旧话题'],
    salience: 'normal',
  });

  const updated = store.updateEpisode(episode.id, {
    title: '新标题 租房',
    summary: '新摘要 预算',
    evidence: '用户原话',
    topics_json: ['租房', '预算'],
    entities_json: ['房东'],
    mood: 'neutral',
    fidelity: 'gist',
    purge_payload: '{"x":1}',
  });
  assert.equal(updated.title, '新标题 租房');
  assert.equal(updated.summary, '新摘要 预算');
  assert.equal(updated.evidence, '用户原话');
  assert.deepEqual(JSON.parse(updated.topics_json), ['租房', '预算']);
  assert.deepEqual(JSON.parse(updated.entities_json), ['房东']);
  assert.equal(updated.mood, 'neutral');
  assert.equal(updated.fidelity, 'gist');
  assert.equal(updated.purge_payload, '{"x":1}');
  // FTS 投影随 title/summary/topics 重写
  assert.ok(store.searchBigram('租房', { scope: 'episode-update' }).length > 0);
  assert.equal(store.searchBigram('旧标题', { scope: 'episode-update' }).length, 0);

  assert.throws(() => store.updateEpisode(episode.id, { titel: 'x' }), /unknown field/);
  assert.throws(() => store.updateEpisode(episode.id, { mood: 'angry' }), /invalid episode mood/);
  assert.throws(
    () => store.updateEpisode(episode.id, { status: 'superseded' }),
    /invalid episode status/,
  );
  assert.equal(store.updateEpisode('episode-does-not-exist', { title: 'x' }), null);

  const sleeping = store.updateEpisode(episode.id, { status: 'dormant', deleted_at: 123 });
  assert.equal(sleeping.status, 'dormant');
  assert.equal(sleeping.deleted_at, 123);
});

test('forget 后满 7 天 purge：物理删除、其它 scope 不受影响、审计与水位不动', () => {
  const now = 2_300_000_000;
  const fact = store.insertFact(
    makeFact({ scope: 'forget-purge', statement: '待清理 青柠计划 细节' }),
  );
  const episode = store.insertEpisode({
    scope: 'forget-purge',
    session_id: 's',
    title: '待清理情景',
    summary: '青柠计划 细节',
    salience: 'normal',
  });
  const keep = store.insertFact(
    makeFact({ scope: 'forget-purge-keep', statement: '另一 scope 事实' }),
  );
  const eventsBefore = store.stats().memory_events;
  const watermarkBefore = store.getWatermark('forget-purge');

  assert.equal(store.forgetFact(fact.id, { at: now, payload: { salience: 'normal' } }), true);
  assert.equal(store.forgetEpisode(episode.id, { at: now, payload: { salience: 'normal' } }), true);
  // S1 不写审计、不动巩固水位
  assert.equal(store.stats().memory_events, eventsBefore);
  assert.equal(store.getWatermark('forget-purge'), watermarkBefore);

  const result = store.purge({ now: now + 8 * 86_400, cutoffDays: 7 });
  assert.ok(result.facts >= 1);
  assert.ok(result.episodes >= 1);
  assert.equal(store.getFact(fact.id), null);
  assert.equal(store.getEpisode(episode.id), null);
  assert.equal(store.listFacts({ scope: 'forget-purge', includeDeleted: true }).length, 0);
  assert.equal(store.listEpisodes({ scope: 'forget-purge', includeDeleted: true }).length, 0);
  assert.ok(store.getFact(keep.id), '其它 scope 的行不被误删');
  assert.equal(store.getWatermark('forget-purge'), watermarkBefore);

  const purged = store.listEvents({ action: 'PURGED', limit: 500 });
  assert.ok(purged.some((event) => event.row_id === fact.id));
  assert.ok(purged.some((event) => event.row_id === episode.id));
});

test('v3 库迁移到 v4：加 compaction_start_seq、清空 consolidations、episode 关联置空', () => {
  const file = join(dir, 'legacy-v3.db');
  const legacy = Store.open(file);
  const consolidation = legacy.insertConsolidation({
    scope: 'main',
    session_id: 'legacy',
    kind: 'nap',
    trigger: 'idle',
    upto_seq: 10,
    turn_from: 10,
    turn_to: 10,
    status: 'written',
    started_at: 1_700_000_000,
  });
  const episode = legacy.insertEpisode({
    scope: 'main',
    session_id: 'legacy',
    consolidation_id: consolidation.id,
    title: '旧情景',
    salience: 'normal',
  });
  // 退化成 v3 形状：没有 compaction_start_seq，版本号 '3'。
  legacy.db.exec('ALTER TABLE consolidations DROP COLUMN compaction_start_seq');
  legacy.db.exec("UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'");
  legacy.close();

  const migrated = Store.open(file);
  try {
    const version = migrated.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    assert.equal(version.value, '13');
    const columns = migrated.db
      .prepare("PRAGMA table_info('consolidations')")
      .all()
      .map((column) => column.name);
    assert.ok(columns.includes('compaction_start_seq'), '迁移后应补出新列');
    assert.equal(migrated.stats().consolidations, 0, '旧 turn 口径的巩固行被清空');
    assert.equal(migrated.getEpisode(episode.id).consolidation_id, null, 'episode 关联被解除');
    assert.equal(migrated.getWatermark('main'), 0);
  } finally {
    migrated.close();
  }
});
