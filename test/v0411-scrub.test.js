/**
 * v0.4.11 V10-L1：存量 episodes / fts_episodes 一次性脱敏 scrub（幂等）。
 *
 * 背景：v0.4.10（V9-M1/M1b）只保证「新写入」的 episode 在入库前脱敏；更早落库
 * 的行仍可能含明文凭据值（例如云端 g02 的「路由器密码 蓝鲸-7788」），而且已经
 * 投影进 fts_episodes，会被召回、注入与导出。v13 在 Store.open 的迁移框架内对
 * 存量行重跑写入路径的同口径脱敏，并重建受影响行的 FTS 投影。
 *
 * 覆盖：
 *   1. v12 旧库（episodes + fts_episodes 均为明文）升级后六字段与 FTS 都不含
 *      明文，普通叙事逐字节不变；schema_version 升到 13；
 *   2. 幂等：第二次打开不产生任何行改动、不新增第二条 scrub 事件；
 *   3. 纯叙事（提到「密码」但没有值）不被整段抹掉；JSON 数组保持合法；
 *      脱敏面漏网但残留值形态的字段整段替换为 [凭据已省略]；
 *   4. 审计事件 detail 只有 {scanned, changed} 计数，不含正文；
 *   5. 新建空库也写标记（B1：避免每次打开都重扫），但不写 scrub 事件（不给新
 *      用户留审计噪音）；
 *   6. 已是 v13 但还没有标记的库（例如标记写入前失败后被外部恢复）也会补齐一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { REDACTED_CREDENTIAL } from '../src/memory/govern.js';
import { toBigrams } from '../src/memory/bigram.js';
import { Store } from '../src/memory/store.js';

const PASSWORD_VALUE = '蓝鲸-7788';
const SCRUB_MARKER = 'episode_scrub_v13';
const SCRUB_ACTION = 'scrub';
const LEGACY_NOW = 1_700_000_000;

/** @param {import('node:test').TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-scrub-'));
  if (t && typeof t.after === 'function') {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  }
  return dir;
}

/** episodes 行里会落文本的列拼起来（六字段）。 */
function episodeText(row) {
  return [
    row.title,
    row.summary,
    row.evidence,
    row.mood_evidence,
    row.topics_json,
    row.entities_json,
  ].filter((value) => typeof value === 'string').join('\n');
}

/** fts_episodes 的 bigram 投影原文。 */
function episodeFtsText(store) {
  return store.db.prepare('SELECT txt FROM fts_episodes').all()
    .map((row) => row.txt)
    .join('\n');
}

/** 某条 episode 的 FTS 投影。 */
function ftsTextOf(store, id) {
  const row = store.db
    .prepare(
      `SELECT txt FROM fts_episodes
        WHERE rowid = (SELECT rowid FROM episodes WHERE id = ?)`,
    )
    .get(id);
  return row?.txt ?? null;
}

// ------------------------------------------------------ 造旧库（绕过写入路径）

/** 含明文凭据的旧行：四字段 + topics/entities 全都带值。 */
const SENSITIVE_LEGACY_ROW = {
  id: 'ep-legacy-sensitive',
  session_id: 'sess-legacy-sensitive',
  title: `路由器密码 ${PASSWORD_VALUE}`,
  summary: `WiFi 密码是 ${PASSWORD_VALUE}，周末在家`,
  // 大写 sk- 不在 redact 的值级面里：整段兜底为 REDACTED_CREDENTIAL。
  evidence: '用户用 SK-ABC12345 调接口',
  mood: 'neutral',
  mood_evidence: '口令：bluewhale',
  topics: [`密码 ${PASSWORD_VALUE}`, '周末'],
  entities: [`路由器密码 ${PASSWORD_VALUE}`],
};

/** 普通叙事旧行：提到「密码」但没有值，必须逐字节保持原样。 */
const NARRATIVE_LEGACY_ROW = {
  id: 'ep-legacy-narrative',
  session_id: 'sess-legacy-narrative',
  title: '周末去看展览',
  summary: '用户提到密码但没有给出任何值，只是聊了聊密码学',
  evidence: '展览在美术馆，门票 60 元',
  mood: 'positive',
  mood_evidence: '心情不错',
  topics: ['周末', '展览'],
  entities: ['美术馆'],
};

/**
 * 绕过 insertEpisode 的脱敏直写一条 episode，并手工写入含明文的 FTS 投影，
 * 等价于 v0.4.10 之前落库、且该版本 store 已经投影过的存量数据。
 */
function insertLegacyEpisode(store, row) {
  store.db
    .prepare(
      `INSERT INTO episodes (
         id, scope, session_id, consolidation_id, started_at, ended_at, title, summary,
         evidence, topics_json, entities_json, mood, mood_evidence, salience, privacy,
         strength_days, last_reinforced_at, recall_count, fidelity, status, deleted_at,
         purge_payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      'main',
      row.session_id,
      null,
      LEGACY_NOW,
      LEGACY_NOW + 60,
      row.title,
      row.summary,
      row.evidence,
      JSON.stringify(row.topics),
      JSON.stringify(row.entities),
      row.mood,
      row.mood_evidence,
      'normal',
      'normal',
      7,
      LEGACY_NOW,
      0,
      'full',
      'active',
      null,
      null,
    );
  const projection = [row.title, row.summary, row.topics.join(' ')]
    .filter(Boolean)
    .join('\n');
  store.db
    .prepare(
      `INSERT INTO fts_episodes (rowid, txt)
       VALUES ((SELECT rowid FROM episodes WHERE id = ?), ?)`,
    )
    .run(row.id, toBigrams(projection));
}

/**
 * 建一个 v12 形态的旧库：先按当前版本建库（新库为空、无标记无事件），直写含
 * 明文的 episode + FTS，再把 schema_version 退回 '12' 并关闭，模拟旧库文件。
 * @returns {string} 数据库文件路径
 */
function makeLegacyDb(t) {
  const dir = tempDir(t);
  const file = join(dir, 'memory.db');
  const store = Store.open(file);
  try {
    // B1（v15）：空库也会写标记，避免每次打开都重扫；这里模拟 v12 旧库，删掉标记。
    assert.notEqual(store.getMeta(SCRUB_MARKER), null, 'B1：新建空库也应写 scrub 标记');
    store.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(SCRUB_MARKER);
    insertLegacyEpisode(store, SENSITIVE_LEGACY_ROW);
    insertLegacyEpisode(store, NARRATIVE_LEGACY_ROW);
    store.db
      .prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'")
      .run();
  } finally {
    store.close();
  }
  return file;
}

// --------------------------------------------------------------- 升级 scrub

test('V10-L1：v12 旧库升级到 v13 时脱敏 episodes 六字段并重建 FTS', (t) => {
  const file = makeLegacyDb(t);

  const store = Store.open(file);
  try {
    assert.equal(store.getMeta('schema_version'), '15');
    assert.notEqual(store.getMeta(SCRUB_MARKER), null, 'scrub 成功后应写标记');

    const sensitive = store.getEpisode(SENSITIVE_LEGACY_ROW.id);
    const narrative = store.getEpisode(NARRATIVE_LEGACY_ROW.id);
    assert.ok(sensitive);
    assert.ok(narrative);

    // 六字段全部不含明文值。
    for (const marker of [PASSWORD_VALUE, 'abc123', 'bluewhale', 'SK-ABC12345']) {
      assert.ok(!episodeText(sensitive).includes(marker), `episode 字段仍含明文：${marker}`);
      assert.ok(!episodeFtsText(store).includes(marker), `fts_episodes 仍含明文：${marker}`);
    }

    // 值级脱敏保留上下文；漏网的整段兜底为统一占位符。
    assert.equal(sensitive.title, `路由器密码 ${REDACTED_CREDENTIAL}`);
    assert.equal(sensitive.summary, `WiFi 密码是 ${REDACTED_CREDENTIAL}，周末在家`);
    assert.equal(sensitive.evidence, REDACTED_CREDENTIAL);
    assert.equal(sensitive.mood_evidence, `口令：${REDACTED_CREDENTIAL}`);

    // JSON 数组仍然合法，且逐项完成值级脱敏。
    assert.deepEqual(JSON.parse(sensitive.topics_json), [
      `密码 ${REDACTED_CREDENTIAL}`,
      '周末',
    ]);
    assert.deepEqual(JSON.parse(sensitive.entities_json), [
      `路由器密码 ${REDACTED_CREDENTIAL}`,
    ]);

    // 普通叙事逐字节不变（含提到「密码」但无值的那句）。
    assert.equal(narrative.title, '周末去看展览');
    assert.equal(narrative.summary, '用户提到密码但没有给出任何值，只是聊了聊密码学');
    assert.equal(narrative.evidence, '展览在美术馆，门票 60 元');
    assert.equal(narrative.mood_evidence, '心情不错');
    assert.equal(narrative.topics_json, JSON.stringify(NARRATIVE_LEGACY_ROW.topics));
    assert.equal(narrative.entities_json, JSON.stringify(NARRATIVE_LEGACY_ROW.entities));
    assert.deepEqual(JSON.parse(narrative.topics_json), ['周末', '展览']);
    assert.equal(
      ftsTextOf(store, narrative.id),
      toBigrams([
        '周末去看展览',
        '用户提到密码但没有给出任何值，只是聊了聊密码学',
        '周末 展览',
      ].join('\n')),
    );

    // FTS 投影随字段一起更新（只含脱敏后的文本）。
    assert.equal(
      ftsTextOf(store, sensitive.id),
      toBigrams([
        `路由器密码 ${REDACTED_CREDENTIAL}`,
        `WiFi 密码是 ${REDACTED_CREDENTIAL}，周末在家`,
        `密码 ${REDACTED_CREDENTIAL} 周末`,
      ].join('\n')),
    );

    // 审计：一条 scrub，detail 只有计数。
    const events = store.listEvents({ action: SCRUB_ACTION });
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.table_name, 'episodes');
    assert.equal(event.actor, 'migrator');
    assert.equal(event.reason, 'v13-legacy-episode-scrub');
    assert.deepEqual(JSON.parse(event.detail_json), { scanned: 2, changed: 1 });
    assert.ok(!event.detail_json.includes(PASSWORD_VALUE));
    assert.ok(!event.detail_json.includes('密码'));
  } finally {
    store.close();
  }
});

test('V10-L1：二次打开无变化、不新增第二条 scrub 事件', (t) => {
  const file = makeLegacyDb(t);
  let snapshot = null;

  const first = Store.open(file);
  try {
    snapshot = {
      rows: first.db.prepare('SELECT * FROM episodes ORDER BY rowid ASC').all(),
      fts: episodeFtsText(first),
      events: first.listEvents({ action: SCRUB_ACTION }).length,
    };
    assert.equal(snapshot.events, 1);
  } finally {
    first.close();
  }

  const second = Store.open(file);
  try {
    assert.equal(second.getMeta('schema_version'), '15');
    assert.deepEqual(
      second.db.prepare('SELECT * FROM episodes ORDER BY rowid ASC').all(),
      snapshot.rows,
      '二次打开不应改动任何 episode 行',
    );
    assert.equal(episodeFtsText(second), snapshot.fts, '二次打开不应重写 FTS 投影');
    assert.equal(
      second.listEvents({ action: SCRUB_ACTION }).length,
      1,
      '二次打开不应新增 scrub 事件',
    );
  } finally {
    second.close();
  }
});

test('V10-L1：新建空库也写 scrub 标记，但不写 scrub 事件', (t) => {
  const dir = tempDir(t);
  const store = Store.open(join(dir, 'memory.db'));
  try {
    assert.notEqual(store.getMeta(SCRUB_MARKER), null, 'B1：空库也要写标记，避免重扫');
    assert.equal(store.listEvents({ action: SCRUB_ACTION }).length, 0);
    assert.equal(store.listEvents().length, 0);
    assert.equal(store.getMeta('schema_version'), '15');
  } finally {
    store.close();
  }
});

test('V10-L1：已是 v13 但无标记的库也会补齐一次（非升级路径自开事务）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'memory.db');
  const seed = Store.open(file);
  try {
    insertLegacyEpisode(seed, SENSITIVE_LEGACY_ROW);
    // B1：空库建库时就写了标记；删掉以模拟「已是 v13 但无标记」的库。
    seed.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(SCRUB_MARKER);
  } finally {
    seed.close();
  }

  const store = Store.open(file);
  try {
    const row = store.getEpisode(SENSITIVE_LEGACY_ROW.id);
    assert.ok(!episodeText(row).includes(PASSWORD_VALUE));
    assert.ok(!episodeFtsText(store).includes(PASSWORD_VALUE));
    const events = store.listEvents({ action: SCRUB_ACTION });
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].detail_json), { scanned: 1, changed: 1 });
    assert.notEqual(store.getMeta(SCRUB_MARKER), null);
  } finally {
    store.close();
  }
});

test('V10-L1：超过单批大小的库按 rowid 键集分批扫完（不跳行）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'memory.db');
  const seed = Store.open(file);
  try {
    const insert = seed.db.prepare(
      `INSERT INTO episodes (
         id, scope, session_id, started_at, ended_at, title, summary, topics_json,
         entities_json, salience, privacy, strength_days, last_reinforced_at,
         recall_count, fidelity, status
       ) VALUES (?, 'main', ?, ?, ?, ?, ?, '[]', '[]',
                 'normal', 'normal', 7, ?, 0, 'full', 'active')`,
    );
    // 205 行 > EPISODE_SCRUB_BATCH(200)：验证第二批仍会被扫到。
    for (let i = 1; i <= 205; i += 1) {
      const sensitive = i === 205;
      insert.run(
        `ep-batch-${i}`,
        `s-batch-${i}`,
        LEGACY_NOW,
        LEGACY_NOW,
        sensitive ? `路由器密码 ${PASSWORD_VALUE}` : `第 ${i} 次散步`,
        sensitive ? `WiFi 密码是 ${PASSWORD_VALUE}` : `天气不错，走了 ${i} 分钟`,
        LEGACY_NOW,
      );
    }
    seed.db
      .prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'")
      .run();
    seed.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(SCRUB_MARKER);
  } finally {
    seed.close();
  }

  const store = Store.open(file);
  try {
    assert.equal(store.getEpisode('ep-batch-205').title, `路由器密码 ${REDACTED_CREDENTIAL}`);
    assert.equal(store.getEpisode('ep-batch-1').title, '第 1 次散步');
    const events = store.listEvents({ action: SCRUB_ACTION });
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(events[0].detail_json), { scanned: 205, changed: 1 });
  } finally {
    store.close();
  }
});

test('V10-L1：已脱敏的 JSON 数组不被重新序列化（未命中行逐字节不变）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'memory.db');
  // 故意用带空格的 JSON 文本，验证未命中行不会被 JSON.stringify 重排。
  const topicsJson = '[ "周末" ,  "展览" ]';
  const seed = Store.open(file);
  try {
    seed.db
      .prepare(
        `INSERT INTO episodes (
           id, scope, session_id, started_at, ended_at, title, summary, topics_json,
           entities_json, salience, privacy, strength_days, last_reinforced_at,
           recall_count, fidelity, status
         ) VALUES ('ep-spacing', 'main', 's-spacing', ?, ?, '周末去看展览', '聊了密码学', ?, '[]',
                   'normal', 'normal', 7, ?, 0, 'full', 'active')`,
      )
      .run(LEGACY_NOW, LEGACY_NOW + 60, topicsJson, LEGACY_NOW);
    seed.db
      .prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'")
      .run();
    seed.db.prepare('DELETE FROM schema_meta WHERE key = ?').run(SCRUB_MARKER);
  } finally {
    seed.close();
  }

  const store = Store.open(file);
  try {
    const row = store.getEpisode('ep-spacing');
    assert.equal(row.topics_json, topicsJson, '未命中项不应触发重新序列化');
    assert.equal(row.title, '周末去看展览');
    assert.equal(store.listEvents({ action: SCRUB_ACTION }).length, 1);
    assert.deepEqual(
      JSON.parse(store.listEvents({ action: SCRUB_ACTION })[0].detail_json),
      { scanned: 1, changed: 0 },
    );
  } finally {
    store.close();
  }
});
