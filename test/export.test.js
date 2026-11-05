import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/memory/store.js';
import {
  EXPORT_VERSION,
  decryptJson,
  encryptJson,
  exportAll,
  formatStamp,
  importAll,
} from '../src/memory/export.js';
import { handleMemoryCommand } from '../src/index.js';

const TEST_NOW = Date.UTC(2026, 10, 5, 9, 0, 0);

function makeDatabase(t, prefix = 'dsh-export-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'companion.db');
  const store = Store.open(dbPath);
  t.after(() => {
    try {
      store.close();
    } catch {
      // 已关闭时继续删目录。
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, store };
}

function seed(store, { now = TEST_NOW, statement = '青柠计划的代号是蓝鲸。' } = {}) {
  const at = Math.floor(now / 1000);
  const episode = store.insertEpisode({
    scope: 'main',
    session_id: 'export-test',
    started_at: at,
    ended_at: at,
    title: '讨论青柠计划',
    summary: statement,
    evidence: statement,
    topics: ['青柠计划'],
    salience: 'normal',
    last_reinforced_at: at,
  });
  const fact = store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement,
    source_kind: 'turn',
    source_episode_id: episode.id,
    source_excerpt: statement,
    salience: 'normal',
    observed_at: at,
    last_reinforced_at: at,
  });
  const reminder = store.insertReminder({
    scope: 'main',
    kind: 'todo',
    title: '跟进青柠计划预算',
    detail: '本周给出范围。',
    due_at: at + 3600,
    due_granularity: 'day',
    next_fire_at: at + 3600,
    status: 'pending',
    source_episode_id: episode.id,
  });
  const thread = store.upsertThread({
    key: 'budget',
    name: '预算线程',
    session_id: 'thread-session-budget',
    description: '只讨论青柠计划预算',
    last_progress: '等待范围',
    last_active_at: at,
    status: 'active',
  });
  store.db
    .prepare(
      `INSERT INTO state_board_rev (scope, revision, rendered, updated_at)
       VALUES ('main', 3, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = excluded.revision,
         rendered = excluded.rendered,
         updated_at = excluded.updated_at`,
    )
    .run('## 状态板\n- 青柠计划进行中', at);
  return { episode, fact, reminder, thread };
}

function writeJson(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

test('exportAll json：计数、文件名与默认过滤 secret/sensitive/墓碑', (t) => {
  const { dir, store } = makeDatabase(t);
  const { fact, episode, reminder, thread } = seed(store);

  const secret = store.insertFact({
    scope: 'main',
    kind: 'identity',
    subject_text: '银行卡',
    predicate: '尾号',
    statement: '银行卡尾号是 1234。',
    source_kind: 'user_explicit',
    privacy: 'secret',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });
  const sensitiveText = store.insertFact({
    scope: 'main',
    kind: 'identity',
    subject_text: '账号',
    predicate: '密码',
    statement: '我的密码是 654321。',
    source_kind: 'user_explicit',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });
  const tombstoned = store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '旧项目',
    predicate: '状态',
    statement: '旧项目已经结束。',
    source_kind: 'turn',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });
  store.forgetFact(tombstoned.id, { at: Math.floor(TEST_NOW / 1000) });
  store.forgetEpisode(episode.id, { at: Math.floor(TEST_NOW / 1000) });
  store.insertEpisode({
    scope: 'main',
    session_id: 'export-test',
    started_at: Math.floor(TEST_NOW / 1000),
    ended_at: Math.floor(TEST_NOW / 1000),
    title: '旧情景',
    summary: '不应导出',
    salience: 'normal',
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
    status: 'tombstoned',
    deleted_at: Math.floor(TEST_NOW / 1000),
  });

  const result = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  assert.match(result.path, /memory-2026-11-05-090000\.json$/u);
  const payload = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(payload.version, EXPORT_VERSION);
  assert.equal(payload.scope, 'main');
  assert.equal(payload.exported_at, '2026-11-05T09:00:00.000Z');
  assert.equal(payload.schema_version, '11');
  assert.equal(payload.counts.facts, 1);
  assert.equal(payload.counts.episodes, 0);
  assert.equal(payload.counts.reminders, 1);
  assert.equal(payload.counts.threads, 1);
  assert.equal(payload.counts.state_board, 1);
  assert.deepEqual(payload.data.facts.map((row) => row.id), [fact.id]);
  assert.equal(payload.data.reminders[0].id, reminder.id);
  assert.equal(payload.data.threads[0].key, thread.key);
  assert.match(payload.data.state_board.rendered, /青柠计划进行中/u);
  assert.deepEqual(
    payload.data.facts.map((row) => row.id).sort(),
    [fact.id].sort(),
  );
  for (const hidden of [secret.id, sensitiveText.id, tombstoned.id]) {
    assert.equal(payload.data.facts.some((row) => row.id === hidden), false);
  }
});

test('exportAll md：人读分节，包含正文且不泄漏敏感内容', (t) => {
  const { dir, store } = makeDatabase(t);
  const { fact } = seed(store);
  store.insertFact({
    scope: 'main',
    kind: 'identity',
    subject_text: '银行卡',
    predicate: '尾号',
    statement: '银行卡尾号是 9876。',
    source_kind: 'user_explicit',
    privacy: 'secret',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });

  const result = exportAll({ store, format: 'md', dir, now: TEST_NOW });
  assert.match(result.path, /memory-2026-11-05-090000\.md$/u);
  const text = readFileSync(result.path, 'utf8');
  assert.match(text, /# dsh-companion 记忆导出/u);
  assert.match(text, /## 事实 facts（1）/u);
  assert.match(text, new RegExp(fact.statement, 'u'));
  assert.doesNotMatch(text, /9876/u);
  assert.match(text, /## 状态板 state_board（revision 3）/u);
});

test('formatStamp：UTC 文件名时间戳（秒级）', () => {
  assert.equal(formatStamp(Date.UTC(2026, 10, 5, 9, 0, 0)), '2026-11-05-090000');
  assert.equal(formatStamp(Date.UTC(2026, 0, 1, 0, 5, 0)), '2026-01-01-000500');
  assert.equal(formatStamp(Date.UTC(2026, 0, 1, 0, 5, 7)), '2026-01-01-000507');
});

test('exportAll：非法格式抛错；写盘失败抛错不吞', (t) => {
  const { dir, store } = makeDatabase(t);
  seed(store);
  assert.throws(() => exportAll({ store, format: 'yaml', dir }), /format/u);

  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory', 'utf8');
  assert.throws(() => exportAll({ store, format: 'json', dir: blocker }), (error) => Boolean(error?.code));
});

test('exportAll：facts.sensitive 列存在时排除已标记行', (t) => {
  const { dir, store } = makeDatabase(t);
  const { fact } = seed(store);
  store.db.exec('ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
  store.db.prepare('UPDATE facts SET sensitive = 1 WHERE id = ?').run(fact.id);

  const result = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(payload.counts.facts, 0);
  assert.deepEqual(payload.data.facts, []);
});

test('importAll fresh：导出后恢复 facts/episodes/reminders/threads/board 与 FTS', (t) => {
  const source = makeDatabase(t, 'dsh-export-src-');
  const seeded = seed(source.store);
  const exported = exportAll({ store: source.store, format: 'json', dir: source.dir, now: TEST_NOW });
  assert.ok(exported.path);

  const target = makeDatabase(t, 'dsh-export-dst-');
  const result = importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.imported, {
    facts: 1, episodes: 1, reminders: 1, threads: 1, state_board: 1,
  });
  assert.equal(result.skipped, 0);

  const fact = target.store.getFact(seeded.fact.id);
  assert.equal(fact.statement, seeded.fact.statement);
  assert.equal(fact.scope, 'main');
  assert.equal(target.store.getEpisode(seeded.episode.id).title, '讨论青柠计划');
  assert.equal(target.store.getReminder?.(seeded.reminder.id)?.title, '跟进青柠计划预算');
  assert.equal(target.store.getThread(seeded.thread.key).session_id, 'thread-session-budget');
  assert.equal(target.store.getBoard('main'), '## 状态板\n- 青柠计划进行中');
  assert.ok(target.store.searchBigram('青柠计划', { scope: 'main' }).length > 0);
});

test('importAll fresh：目标库非空时拒绝且不写入', (t) => {
  const source = makeDatabase(t, 'dsh-export-src2-');
  seed(source.store);
  const exported = exportAll({ store: source.store, format: 'json', dir: source.dir, now: TEST_NOW });

  const target = makeDatabase(t, 'dsh-export-dst2-');
  target.store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '已有',
    predicate: '状态',
    statement: '已有记忆。',
    source_kind: 'turn',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });
  const before = target.store.stats();
  assert.throws(
    () => importAll({ store: target.store, file: exported.path, mode: 'fresh' }),
    /fresh/u,
  );
  assert.equal(target.store.stats().facts, before.facts);
});

test('importAll：拒绝非本插件版本、非 JSON 文件与坏 data 结构', (t) => {
  const { dir, store } = makeDatabase(t);
  const badVersion = writeJson(dir, 'bad-version.json', { version: 99, data: {} });
  assert.throws(() => importAll({ store, file: badVersion }), /版本/u);

  const badData = writeJson(dir, 'bad-data.json', { version: EXPORT_VERSION, data: { facts: [] } });
  assert.throws(() => importAll({ store, file: badData }), /episodes/u);

  const notJson = join(dir, 'not-json.txt');
  writeFileSync(notJson, 'hello', 'utf8');
  assert.throws(() => importAll({ store, file: notJson }), /无法读取/u);
  assert.throws(() => importAll({ store, file: join(dir, 'missing.json') }), /无法读取/u);
});

test('importAll merge：按 id 去重、不覆盖 active、记录 skipped', (t) => {
  const source = makeDatabase(t, 'dsh-export-src3-');
  const seeded = seed(source.store);
  const exported = exportAll({ store: source.store, format: 'json', dir: source.dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  payload.data.facts.push({
    ...payload.data.facts[0],
    id: 'fact-extra',
    statement: '新增的一条记忆。',
    subject_text: '新增',
    predicate: '内容',
    source_episode_id: payload.data.episodes[0].id,
  });
  const file = writeJson(source.dir, 'merge-source.json', payload);

  const target = makeDatabase(t, 'dsh-export-dst3-');
  const at = Math.floor(TEST_NOW / 1000);
  target.store.insertFact({
    id: seeded.fact.id,
    scope: 'main',
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    statement: '本地已有内容。',
    source_kind: 'turn',
    observed_at: at,
    last_reinforced_at: at,
  });
  const result = importAll({ store: target.store, file, mode: 'merge' });
  assert.equal(result.skippedByTable.facts, 1);
  assert.equal(result.imported.facts, 1);
  assert.equal(target.store.getFact(seeded.fact.id).statement, '本地已有内容。');
  assert.equal(target.store.getFact('fact-extra').statement, '新增的一条记忆。');
});

test('importAll：事务失败时零落库', (t) => {
  const source = makeDatabase(t, 'dsh-export-src4-');
  seed(source.store);
  const exported = exportAll({ store: source.store, format: 'json', dir: source.dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  payload.data.facts[0].statement = null;
  const bad = writeJson(source.dir, 'bad-fact.json', payload);

  const target = makeDatabase(t, 'dsh-export-dst4-');
  assert.throws(() => importAll({ store: target.store, file: bad, mode: 'fresh' }));
  assert.equal(target.store.stats().facts, 0);
  assert.equal(target.store.stats().episodes, 0);
  assert.equal(target.store.stats().reminders, 0);
  assert.equal(target.store.stats().threads, 0);
});

test('encryptJson/decryptJson：AES-256-GCM + scrypt，头含 KDF 参数，错口令失败', () => {
  const text = encryptJson({ hello: '世界', n: 1 }, 'correct horse', { id: 'fact-1', now: TEST_NOW });
  const lines = text.split('\n');
  assert.equal(lines[0], 'DSH-COMPANION-EXPORT-1');
  const header = JSON.parse(lines[1]);
  assert.equal(header.format, 'v2');
  assert.equal(header.cipher, 'aes-256-gcm');
  assert.equal(header.kdf, 'scrypt');
  assert.equal(header.N, 16384);
  assert.equal(header.r, 8);
  assert.equal(header.p, 1);
  assert.equal(header.id, 'fact-1');
  assert.ok(header.salt.length > 0);
  assert.ok(header.iv.length > 0);
  assert.ok(header.tag.length > 0);
  assert.deepEqual(decryptJson(text, 'correct horse'), { hello: '世界', n: 1 });
  assert.throws(() => decryptJson(text, 'wrong horse'), /解密失败/u);
  assert.throws(() => decryptJson(text, ''), /passphrase/u);
  assert.throws(() => encryptJson({ a: 1 }, ''), /passphrase/u);
});

test('加密 CLI：stdin 口令导出、解密恢复；错误口令非零退出', (t) => {
  const { dir, dbPath, store } = makeDatabase(t, 'dsh-export-cli-');
  const at = Math.floor(TEST_NOW / 1000);
  const fact = store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '加密导出',
    predicate: '内容',
    statement: '这条记忆需要加密。',
    source_kind: 'turn',
    observed_at: at,
    last_reinforced_at: at,
  });
  store.close();

  const exportScript = fileURLToPath(new URL('../scripts/export-encrypted.mjs', import.meta.url));
  const decryptScript = fileURLToPath(new URL('../scripts/decrypt-encrypted.mjs', import.meta.url));
  const encrypted = join(dir, 'fact.enc');
  const plain = join(dir, 'fact.json');

  const exported = spawnSync(process.execPath, [
    exportScript,
    dbPath,
    fact.id,
    '--out',
    encrypted,
  ], { input: 'correct horse\n', encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(readFileSync(encrypted, 'utf8').startsWith('DSH-COMPANION-EXPORT-1\n'));

  const decrypted = spawnSync(process.execPath, [
    decryptScript,
    encrypted,
    '--out',
    plain,
  ], { input: 'correct horse\n', encoding: 'utf8' });
  assert.equal(decrypted.status, 0, decrypted.stderr);
  const payload = JSON.parse(readFileSync(plain, 'utf8'));
  assert.equal(payload.id, fact.id);
  assert.equal(payload.fact.statement, '这条记忆需要加密。');

  const wrong = spawnSync(process.execPath, [
    decryptScript,
    encrypted,
    '--out',
    join(dir, 'wrong.json'),
  ], { input: 'wrong horse\n', encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /解密失败/u);
});

test('/记忆 导出：写 .data/export 并回显路径与条数；md 与非法格式', (t) => {
  const { dir, store } = makeDatabase(t);
  seed(store);

  const jsonText = handleMemoryCommand({
    text: '/记忆 导出 json',
    store,
    now: TEST_NOW,
    cwd: dir,
  });
  assert.match(jsonText, /已导出记忆（json）/u);
  assert.match(jsonText, /facts=1/u);
  const jsonPath = jsonText.split('文件：')[1].trim();
  assert.ok(readFileSync(jsonPath, 'utf8').includes('"version": 1'));

  const mdText = handleMemoryCommand({ text: '/记忆 导出 md', store, now: TEST_NOW, cwd: dir });
  assert.match(mdText, /已导出记忆（md）/u);
  assert.match(readFileSync(mdText.split('文件：')[1].trim(), 'utf8'), /## 事实 facts/u);

  assert.equal(
    handleMemoryCommand({ text: '/记忆 导出 yaml', store, now: TEST_NOW, cwd: dir }),
    '用法：/记忆 导出 [md|json]',
  );
});
