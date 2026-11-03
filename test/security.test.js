/**
 * T9b 隐私与泄露回归测试（卡片 t21）。
 *
 * 目标：锁住「记忆正文不外泄到非记忆通道」。这是私人管家产品的硬要求
 * （06 v3.3 §7.6、01 R-MEM 安全项），因此这里只做黑盒断言，不改 src：
 *
 *   1) privacy='secret' 的事实在管理面可取（listFacts / 按 id），但检索、
 *      30K 装配注入、模型工具 memory_search 都拿不到正文；
 *   2) memory_events 的 ADD / USED / PURGED 审计只保留元数据，
 *      detail_json 里不出现 statement / summary 正文；
 *   3) S2 purge 后 facts / episodes / 两张 FTS 表都不再有正文残留，
 *      purge_payload 随行删除；仓库当前没有备份实现，备份目录检查会
 *      明确跳过并记录 diagnostic；
 *   4) 用 spy logger（同时兜住 console）跑 consolidate / retrieve / purge，
 *      序列化后的日志里不出现敏感标记串；
 *   5) tombstone 冷静期内，检索、装配注入、工具搜索都只得到空结果——
 *      「不记得了」的措辞由调用方处理，本文件只断言正文不可得。
 *
 * 时间口径：正文只落在 Unix 秒（Store DDL），retrieve 的 now 用毫秒。
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { assemble } from '../src/memory/assemble.js';
import { consolidate } from '../src/memory/consolidate.js';
import { retrieve } from '../src/memory/retrieve.js';
import { createScheduler } from '../src/runtime/scheduler.js';
import { createTools } from '../src/runtime/tools.js';
import {
  TEST_NOW,
  createClock,
  makeFakeLlm,
  makeTempStore,
  recallInjection,
} from './e2e/helpers.js';

/** 敏感标记：任何非记忆通道都不应出现。 */
const MARKER = 'SECRET-MARKER-42';
/** 带标记的事实正文。 */
const SECRET_STATEMENT = `${MARKER} 是青柠计划的真实代号`;
/** 与密码/私密信息等价的场景：正文里同时带中文检索词与标记串。 */
const NOW_SEC = Math.floor(TEST_NOW / 1000);

/**
 * 写入一条正常的（默认非 secret）事实。
 * @param {import('../src/memory/store.js').Store} store
 * @param {object} [overrides]
 * @returns {object}
 */
function insertFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement: SECRET_STATEMENT,
    source_kind: 'user_explicit',
    observed_at: NOW_SEC,
    salience: 'normal',
    privacy: 'normal',
    ...overrides,
  });
}

/**
 * S1 遗忘事实：只置 tombstoned/deleted_at 与正文快照 purge_payload，
 * 行与 FTS 保留到 S2 purge（06 v3.3 §7.8）。
 *
 * 这里走 Store 在 HEAD 上已有的公开面 updateFact，而不是尚未合入的
 * forgetFact，避免测试依赖并发开发中的未提交 API；语义与生产入口一致。
 *
 * @param {import('../src/memory/store.js').Store} store
 * @param {string} id
 * @param {{at?: number, payload?: string}} [options]
 * @returns {object}
 */
function tombstoneFact(store, id, options = {}) {
  const at = options.at ?? NOW_SEC;
  const payload = options.payload ?? JSON.stringify({ body: MARKER });
  const row = store.updateFact(id, {
    status: 'tombstoned',
    deleted_at: at,
    purge_payload: payload,
  });
  assert.ok(row, `fact ${id} should exist before tombstone`);
  return row;
}

/**
 * S1 遗忘情景。HEAD 上还没有 updateEpisode / forgetEpisode 公开方法，
 * 与既有 e2e helpers 的历史做法一致，用一条目标态 UPDATE 补 status。
 *
 * @param {import('../src/memory/store.js').Store} store
 * @param {string} id
 * @param {{at?: number, payload?: string}} [options]
 */
function tombstoneEpisode(store, id, options = {}) {
  const at = options.at ?? NOW_SEC;
  const payload = options.payload ?? JSON.stringify({ body: MARKER });
  const info = store.db
    .prepare(
      `UPDATE episodes
          SET status = 'tombstoned', deleted_at = ?, purge_payload = ?
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(at, payload, id);
  assert.ok(Number(info.changes) > 0, `episode ${id} should exist before tombstone`);
}

/**
 * 把装配结果里的所有文本块拼起来，模拟真正注入模型的正文。
 * @param {{messages: Array<{content: Array<{text?: string}>}>}} assembled
 * @returns {string}
 */
function injectedText(assembled) {
  return assembled.messages
    .flatMap((message) => message.content)
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .join('\n');
}

/**
 * @param {ReturnType<import('../src/memory/store.js').Store['listEvents']>} events
 * @returns {string} 所有事件的序列化文本（用于标记串扫描）
 */
function serializeEvents(events) {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

/**
 * @param {unknown} value
 * @returns {object|null}
 */
function parseDetail(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {...unknown} args
 * @returns {number}
 */
function count(db, sql, ...args) {
  const row = db.prepare(sql).get(...args);
  return Number(row?.n ?? 0);
}

/**
 * 递归扫目录里是否出现标记串（只用于备份目录；备份文件可能是二进制，
 * 按 UTF-8 读取足够发现是否混入 JSON/文本备份）。
 * @param {string} dir
 * @param {string} marker
 * @returns {string[]} 命中的文件路径
 */
function scanForMarker(dir, marker) {
  const hits = [];
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && readFileSync(full, 'utf8').includes(marker)) {
        hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

/**
 * 收集 console 输出，避免任何底层模块偷偷把正文打到日志里。
 * @returns {{captured: string[], restore: () => void}}
 */
function spyConsole() {
  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  const captured = [];
  const originals = {};
  for (const level of levels) {
    originals[level] = console[level];
    console[level] = (...args) => {
      captured.push(args.map((arg) => safeStringify(arg)).join(' '));
    };
  }
  return {
    captured,
    restore() {
      for (const level of levels) console[level] = originals[level];
    },
  };
}

/**
 * 与平台适配层同形的 spy logger。
 * @returns {{entries: object[], text: () => string, debug: Function,
 *            info: Function, warn: Function, error: Function}}
 */
function makeSpyLogger() {
  const entries = [];
  /** @param {string} level @param {unknown[]} args */
  const push = (level, args) => {
    entries.push({ level, text: args.map((arg) => safeStringify(arg)).join(' ') });
  };
  return {
    entries,
    debug: (...args) => push('debug', args),
    info: (...args) => push('info', args),
    warn: (...args) => push('warn', args),
    error: (...args) => push('error', args),
    text: () => entries.map((entry) => `${entry.level}: ${entry.text}`).join('\n'),
  };
}

/**
 * 稳定序列化任意日志参数（Error、BigInt、循环引用都不能让测试崩）。
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? String(inner) : inner)) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 扫描全部 memory_events，断言敏感标记串没有进入审计通道。
 * @param {import('../src/memory/store.js').Store} store
 */
function assertNoMarkerInEvents(store) {
  const events = store.listEvents({ limit: 500 });
  assert.ok(Array.isArray(events));
  const serialized = serializeEvents(events);
  assert.ok(
    !serialized.includes(MARKER),
    `memory_events 不得出现敏感正文，实际事件：\n${serialized}`,
  );
  for (const event of events) {
    const detail = parseDetail(event.detail_json);
    if (detail === null) continue;
    assert.ok(!JSON.stringify(detail).includes(MARKER), `event #${event.id} detail 泄漏正文`);
  }
}

// ---------------------------------------------------------------------------
// 1) secret 事实：管理面可取，检索 / 装配 / 工具不可得
// ---------------------------------------------------------------------------

test('secret 事实：管理面可取，检索/装配/工具都拿不到正文', async (t) => {
  const { store } = makeTempStore({ t, prefix: 'dsh-sec-secret-' });

  const fact = insertFact(store, { scope: 'vault', privacy: 'secret' });
  assert.equal(fact.privacy, 'secret');

  // 管理面 / 用户主动查看：listFacts 与按 id 显式取仍可用。
  const listed = store.listFacts({ scope: 'vault' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, fact.id);
  assert.ok(store.getFact(fact.id).statement.includes(MARKER));

  // 普通检索（关键词与全标记串）都不得返回该事实。
  const byMarker = await retrieve({ store, query: MARKER, scope: 'vault', now: TEST_NOW });
  assert.deepEqual(byMarker.items, []);
  const byTopic = await retrieve({ store, query: '青柠计划', scope: 'vault', now: TEST_NOW });
  assert.deepEqual(byTopic.items, []);

  // 装配注入：secret 项从未进入 recallItems，注入正文自然不含正文。
  const injected = injectedText(assemble({ recallItems: byMarker.items, userInput: '' }));
  assert.ok(!injected.includes(MARKER));

  // 模型工具面 memory_search 与 retrieve 同源，也不得泄漏。
  const tool = createTools({ store, retrieve }).find((item) => item.name === 'memory_search');
  assert.ok(tool, 'memory_search tool should exist');
  const result = await tool.execute({ query: MARKER, scope: 'vault' });
  assert.deepEqual(result.items, []);
  assert.ok(!JSON.stringify(result).includes(MARKER));
});

// ---------------------------------------------------------------------------
// 2) memory_events：ADD / USED / PURGED 审计只留元数据
// ---------------------------------------------------------------------------

test('memory_events：ADD/USED/PURGED 只留元数据，不落正文', async (t) => {
  const { store } = makeTempStore({ t, prefix: 'dsh-sec-events-' });

  // ADD：真实巩固链路写一条带标记的 episode + fact。
  const llm = makeFakeLlm({
    episode: {
      title: `讨论 ${MARKER} 的分阶段安排`,
      summary: `摘要里也包含 ${MARKER}，用于验证审计不落正文。`,
      topics: ['青柠计划'],
      salience: 'normal',
    },
    facts: [{
      kind: 'knowledge',
      subject_text: '青柠计划',
      predicate: '代号',
      object_text: MARKER,
      statement: SECRET_STATEMENT,
      source_kind: 'consolidated',
      source_excerpt: SECRET_STATEMENT,
      salience: 'normal',
    }],
    reminders: [],
  });
  const written = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 9,
    llm,
    now: NOW_SEC,
  });
  assert.equal(written.skipped, false);
  assert.equal(written.upto_seq, 9);
  assert.equal(written.facts, 1);

  const addEvents = store.listEvents({ action: 'ADD', limit: 50 });
  assert.ok(addEvents.length >= 1, 'consolidate should append an ADD event');
  const add = addEvents.find((event) => event.table_name === 'episodes');
  assert.ok(add, 'ADD event should target episodes');
  assert.equal(add.actor, 'consolidator');
  assert.equal(add.row_id, written.episodeId);
  const addDetail = parseDetail(add.detail_json);
  assert.deepEqual(Object.keys(addDetail).sort(), ['facts', 'reminders', 'upto_seq']);
  assert.equal(addDetail.upto_seq, 9);

  // USED：真实调度器触发 job，审计只写 job 元数据。
  const clock = createClock(TEST_NOW);
  const scheduler = createScheduler({
    clock: () => clock.now(),
    store,
    timer: () => null,
    clearTimer: () => {},
  });
  clock.advance(61_000);
  const report = scheduler.runDue();
  assert.ok(report.ran.includes('idle-probe'), `idle-probe should run, got ${report.ran.join(',')}`);

  const usedEvents = store.listEvents({ action: 'USED', table_name: 'scheduler_jobs', limit: 50 });
  assert.ok(usedEvents.length >= 1, 'scheduler should append USED events');
  for (const event of usedEvents) {
    const detail = parseDetail(event.detail_json);
    assert.equal(detail.kind, 'job_run');
    assert.ok(!('text' in detail), 'job_run 不得夹带正文');
    assert.ok(!('statement' in detail));
    assert.ok(!('summary' in detail));
  }

  // PURGED：S2 物理删除只留 id/档位，不复制 purge_payload。
  const purgedFact = insertFact(store, { scope: 'main' });
  tombstoneFact(store, purgedFact.id, { payload: JSON.stringify({ body: MARKER }) });
  assert.deepEqual(store.purge({ now: NOW_SEC + 1, cutoffDays: 0 }), { facts: 1, episodes: 0 });

  const purgedEvents = store.listEvents({ action: 'PURGED', limit: 50 });
  assert.equal(purgedEvents.length, 1);
  const purged = purgedEvents[0];
  assert.equal(purged.table_name, 'facts');
  assert.equal(purged.row_id, purgedFact.id);
  assert.deepEqual(parseDetail(purged.detail_json), { salience: 'normal' });

  // 全表兜底：任何事件字段都不得出现标记串。
  assertNoMarkerInEvents(store);
});

// ---------------------------------------------------------------------------
// 3) purge：正文与 purge_payload 物理清除
// ---------------------------------------------------------------------------

test('purge：facts/episodes/FTS 无正文残留，purge_payload 随行删除', async (t) => {
  const { store, dir } = makeTempStore({ t, prefix: 'dsh-sec-purge-' });

  const fact = insertFact(store, { scope: 'main' });
  const episode = store.insertEpisode({
    scope: 'main',
    session_id: 'security-purge',
    started_at: NOW_SEC,
    ended_at: NOW_SEC,
    title: `${MARKER} 的完整情景标题`,
    summary: `${MARKER} 的完整情景摘要`,
    salience: 'normal',
    privacy: 'normal',
  });

  // 先证明 S1 冷静期内正文与快照都还在（否则后面的清除断言可能是空验证）。
  assert.ok(store.getFact(fact.id).statement.includes(MARKER));
  assert.ok(store.getEpisode(episode.id).summary.includes(MARKER));
  tombstoneFact(store, fact.id, { payload: JSON.stringify({ body: MARKER }) });
  tombstoneEpisode(store, episode.id, { payload: JSON.stringify({ body: MARKER }) });
  assert.equal(
    count(store.db, 'SELECT COUNT(*) AS n FROM facts WHERE purge_payload LIKE ?', `%${MARKER}%`),
    1,
  );
  assert.equal(
    count(store.db, 'SELECT COUNT(*) AS n FROM episodes WHERE purge_payload LIKE ?', `%${MARKER}%`),
    1,
  );

  // S2：物理删除。
  assert.deepEqual(store.purge({ now: NOW_SEC + 1, cutoffDays: 0 }), { facts: 1, episodes: 1 });
  assert.equal(store.getFact(fact.id), null);
  assert.equal(store.getEpisode(episode.id), null);
  assert.deepEqual(store.listFacts({ scope: 'main', includeDeleted: true }), []);
  assert.deepEqual(store.listEpisodes({ scope: 'main', includeDeleted: true }), []);
  assert.deepEqual(store.searchBigram(MARKER), []);
  assert.deepEqual(store.searchBigram('青柠计划'), []);

  // 直接扫表与 FTS 投影，排除「检索层过滤但库内仍有正文」。
  assert.equal(
    count(store.db, 'SELECT COUNT(*) AS n FROM facts WHERE statement LIKE ?', `%${MARKER}%`),
    0,
  );
  assert.equal(
    count(store.db, 'SELECT COUNT(*) AS n FROM facts WHERE purge_payload LIKE ?', `%${MARKER}%`),
    0,
  );
  assert.equal(
    count(
      store.db,
      'SELECT COUNT(*) AS n FROM episodes WHERE title LIKE ? OR summary LIKE ?',
      `%${MARKER}%`,
      `%${MARKER}%`,
    ),
    0,
  );
  assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM fts_facts'), 0);
  assert.equal(count(store.db, 'SELECT COUNT(*) AS n FROM fts_episodes'), 0);

  // 备份：仓库当前没有备份实现（scheduler 的 backup job 只负责触发注入
  // 的 handler，src 内没有 VACUUM INTO / 备份写盘）。若未来测试目录真的
  // 出现备份目录，则必须不含该 scope 的正文；否则明确跳过并记录。
  const backupDirs = ['backups', 'backup']
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path));
  if (backupDirs.length === 0) {
    t.diagnostic('无备份实现：未发现 backups/ 或 backup/ 目录，备份正文检查按卡片要求跳过');
  } else {
    for (const backupDir of backupDirs) {
      assert.deepEqual(scanForMarker(backupDir, MARKER), [], `备份目录 ${backupDir} 混入正文`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4) 日志：spy logger + console 兜底
// ---------------------------------------------------------------------------

test('日志通道：consolidate/retrieve/purge 不输出敏感正文', async (t) => {
  const { store } = makeTempStore({ t, prefix: 'dsh-sec-logs-' });
  const fact = insertFact(store, { scope: 'main' });
  const logger = makeSpyLogger();
  const consoleSpy = spyConsole();

  try {
    // 三个入口都额外传 logger：当前实现不依赖 logger，但未来若接入日志，
    // 这个 spy 会立即捕获是否把正文带进了日志参数。
    const llm = makeFakeLlm({
      episode: {
        title: `讨论 ${MARKER}`,
        summary: `摘要 ${MARKER}`,
        topics: ['青柠计划'],
        salience: 'normal',
      },
      facts: [],
      reminders: [],
    });
    await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      llm,
      now: NOW_SEC,
      logger,
    });

    await retrieve({
      store,
      query: MARKER,
      scope: 'main',
      now: TEST_NOW,
      logger,
    });

    tombstoneFact(store, fact.id);
    store.purge({ now: NOW_SEC + 1, cutoffDays: 0, logger });
  } finally {
    consoleSpy.restore();
  }

  assert.ok(!logger.text().includes(MARKER), `spy logger 泄漏正文：\n${logger.text()}`);
  const consoleText = consoleSpy.captured.join('\n');
  assert.ok(!consoleText.includes(MARKER), `console 泄漏正文：\n${consoleText}`);
});

// ---------------------------------------------------------------------------
// 5) tombstone 冷静期：检索 / 注入 / 工具都拿不到正文
// ---------------------------------------------------------------------------

test('tombstone 冷静期内：检索/装配/工具搜索都只得到空结果', async (t) => {
  const { store } = makeTempStore({ t, prefix: 'dsh-sec-tombstone-' });

  const fact = insertFact(store, { scope: 'main' });
  const episode = store.insertEpisode({
    scope: 'main',
    session_id: 'security-tombstone',
    started_at: NOW_SEC,
    ended_at: NOW_SEC,
    title: `${MARKER} 待遗忘情景`,
    summary: `待遗忘摘要 ${MARKER}`,
    salience: 'normal',
    privacy: 'normal',
  });

  tombstoneFact(store, fact.id);
  tombstoneEpisode(store, episode.id);

  // S1 目标态：软删标记已落下，正文行仍在（等 S2 物理删除）。
  const row = store.getFact(fact.id);
  assert.equal(row.status, 'tombstoned');
  assert.ok(row.deleted_at !== null && row.deleted_at !== undefined);

  // 检索：命中 FTS 也会在读取时被 deleted/status 过滤。
  const recalled = await retrieve({ store, query: MARKER, scope: 'main', now: TEST_NOW });
  assert.deepEqual(recalled.items, []);
  const byTopic = await retrieve({ store, query: '青柠计划', scope: 'main', now: TEST_NOW });
  assert.deepEqual(byTopic.items, []);

  // 装配注入：与 recallInjection 的真实链路一致，注入正文为空。
  const { injected } = await recallInjection({
    store,
    query: MARKER,
    scope: 'main',
    now: TEST_NOW,
  });
  assert.equal(injected, '');
  assert.ok(!injected.includes(MARKER));

  // 工具面：memory_search 只返回空 items，正文不可得。
  const tool = createTools({ store, retrieve }).find((item) => item.name === 'memory_search');
  const result = await tool.execute({ query: '青柠计划', scope: 'main' });
  assert.deepEqual(result.items, []);
  assert.ok(!JSON.stringify(result).includes(MARKER));

  // 默认列表也不返回 tombstone 行；includeDeleted 才看得到（用户显式查看场景）。
  assert.deepEqual(store.listFacts({ scope: 'main' }), []);
  assert.deepEqual(store.listEpisodes({ scope: 'main' }), []);
  assert.equal(store.listFacts({ scope: 'main', includeDeleted: true }).length, 1);
  assert.equal(store.listEpisodes({ scope: 'main', includeDeleted: true }).length, 1);
});
