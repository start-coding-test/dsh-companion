import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
  importAll,
} from '../src/memory/export.js';
import { handleMemoryCommand } from '../src/index.js';

const TEST_NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const AT = Math.floor(TEST_NOW / 1000);

function makeDatabase(t, prefix = 'dsh-export-more-') {
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

function insertFact(store, patch = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement: '青柠计划的代号是蓝鲸。',
    source_kind: 'user_explicit',
    observed_at: AT,
    last_reinforced_at: AT,
    ...patch,
  });
}

function insertBoard(store, scope, revision, rendered) {
  store.db
    .prepare(
      `INSERT INTO state_board_rev (scope, revision, rendered, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = excluded.revision,
         rendered = excluded.rendered,
         updated_at = excluded.updated_at`,
    )
    .run(scope, revision, rendered, AT);
}

function writeJson(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function exportAndImportSource(t) {
  const source = makeDatabase(t, 'dsh-export-source-');
  const episode = source.store.insertEpisode({
    scope: 'main',
    session_id: 'export-more',
    started_at: AT,
    ended_at: AT,
    title: '青柠计划复盘',
    summary: '青柠计划的代号是蓝鲸。',
    evidence: '用户确认：青柠计划的代号是蓝鲸。',
    salience: 'notable',
    last_reinforced_at: AT,
  });
  const fact = insertFact(source.store, {
    source_episode_id: episode.id,
    source_excerpt: '用户确认：青柠计划的代号是蓝鲸。',
    salience: 'notable',
  });
  const reminder = source.store.insertReminder({
    scope: 'main',
    kind: 'todo',
    title: '跟进预算',
    detail: '本周给范围',
    due_at: AT + 3600,
    due_granularity: 'day',
    next_fire_at: AT + 3600,
    status: 'pending',
    source_episode_id: episode.id,
  });
  source.store.upsertThread({
    key: 'budget',
    name: '预算线程',
    session_id: 'thread-budget',
    description: '只讨论预算',
    last_progress: '等待范围',
    last_active_at: AT,
    status: 'active',
  });
  insertBoard(source.store, 'main', 4, '- 青柠计划进行中');
  return { source, episode, fact, reminder };
}

test('exportAll：scope 隔离，不把别的作用域事实带进导出', (t) => {
  const { dir, store } = makeDatabase(t);
  insertFact(store, { scope: 'main', statement: '主会话事实。' });
  insertFact(store, { scope: 'thread:budget', statement: '线程事实。' });

  const exported = exportAll({ store, scope: 'thread:budget', format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.scope, 'thread:budget');
  assert.equal(payload.counts.facts, 1);
  assert.equal(payload.data.facts[0].statement, '线程事实。');
  assert.ok(!JSON.stringify(payload).includes('主会话事实'));
});

test('exportAll：空库计数为 0，文件名仍是 memory-*.json', (t) => {
  const { dir, store } = makeDatabase(t);
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.counts.facts, 0);
  assert.equal(payload.counts.episodes, 0);
  assert.equal(payload.counts.reminders, 0);
  assert.equal(payload.counts.threads, 0);
  assert.match(exported.path, /memory-\d{4}-\d{2}-\d{2}-\d{6}\.json$/u);
});

test('exportAll：只导出 active、未删除事实；dormant/superseded 被排除', (t) => {
  const { dir, store } = makeDatabase(t);
  insertFact(store, { statement: 'active 事实。' });
  insertFact(store, { statement: 'dormant 事实。', status: 'dormant' });
  insertFact(store, { statement: 'superseded 事实。', status: 'superseded' });

  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.counts.facts, 1);
  assert.equal(payload.data.facts[0].statement, 'active 事实。');
});

test('exportAll：状态板会剔除未导出敏感事实的正文', (t) => {
  const { dir, store } = makeDatabase(t);
  insertFact(store, { statement: '青柠计划的代号是蓝鲸。' });
  insertFact(store, {
    subject_text: '账号',
    predicate: '密码',
    statement: '我的密码是 654321。',
    privacy: 'sensitive',
  });
  insertBoard(store, 'main', 2, [
    '- 青柠计划的代号是蓝鲸。',
    '- 我的密码是 654321。',
  ].join('\n'));

  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const raw = readFileSync(exported.path, 'utf8');
  assert.ok(raw.includes('青柠计划的代号是蓝鲸。'));
  assert.ok(!raw.includes('654321'));
  assert.equal(JSON.parse(raw).data.state_board.revision, 2);
});

test('exportAll：reminders 已删除不出现，归档 threads 仍保留', (t) => {
  const { dir, store } = makeDatabase(t);
  const reminder = store.insertReminder({
    scope: 'main',
    kind: 'todo',
    title: '临时提醒',
    due_at: AT + 60,
    due_granularity: 'day',
    next_fire_at: AT + 60,
    status: 'pending',
  });
  store.forgetReminder(reminder.id);
  store.upsertThread({
    key: 'archived',
    name: '归档线程',
    session_id: 'thread-archived',
    description: '已归档',
    last_active_at: AT,
    status: 'archived',
  });

  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.counts.reminders, 0);
  assert.equal(payload.counts.threads, 1);
  assert.equal(payload.data.threads[0].key, 'archived');
});

test('importAll fresh：保留 observed_at、strength_days、source_excerpt 等内容', (t) => {
  const { source, fact } = exportAndImportSource(t);
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const target = makeDatabase(t, 'dsh-export-target-');
  const result = importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  assert.equal(result.ok, true);

  const restored = target.store.getFact(fact.id);
  assert.equal(restored.statement, fact.statement);
  assert.equal(restored.observed_at, fact.observed_at);
  assert.equal(restored.strength_days, fact.strength_days);
  assert.equal(restored.source_excerpt, fact.source_excerpt);
  assert.equal(restored.salience, 'notable');
});

test('importAll merge：threads 冲突跳过且保留目标内容', (t) => {
  const { source } = exportAndImportSource(t);
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const target = makeDatabase(t, 'dsh-export-merge-thread-');
  importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  target.store.upsertThread({
    key: 'budget',
    name: '目标线程名',
    session_id: 'thread-target',
    description: '目标已有内容',
    last_active_at: AT,
    status: 'active',
  });

  const result = importAll({ store: target.store, file: exported.path, mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.skippedByTable.threads, 1);
  assert.equal(target.store.getThread('budget').name, '目标线程名');
});

test('importAll merge：已有非空状态板时跳过，不覆盖目标 revision', (t) => {
  const { source } = exportAndImportSource(t);
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const target = makeDatabase(t, 'dsh-export-merge-board-');
  insertBoard(target.store, 'main', 1, '- 目标自己的状态板');

  const result = importAll({ store: target.store, file: exported.path, mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.skippedByTable.state_board, 1);
  const board = target.store.getBoardState('main');
  assert.equal(board.revision, 1);
  assert.equal(board.rendered, '- 目标自己的状态板');
});

test('importAll merge：已有同 id reminder 跳过，不覆盖 active', (t) => {
  const { source, reminder } = exportAndImportSource(t);
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const target = makeDatabase(t, 'dsh-export-merge-reminder-');
  importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  target.store.db
    .prepare('UPDATE reminders SET title = ? WHERE id = ?')
    .run('目标提醒标题', reminder.id);

  const result = importAll({ store: target.store, file: exported.path, mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.skippedByTable.reminders, 1);
  assert.equal(target.store.getReminder(reminder.id).title, '目标提醒标题');
});

test('encryptJson：同一明文两次导出的 salt/iv/密文不同，但都可解密', () => {
  const value = { version: EXPORT_VERSION, hello: 'world' };
  const first = encryptJson(value, 'passphrase', { id: 'f1', now: TEST_NOW });
  const second = encryptJson(value, 'passphrase', { id: 'f1', now: TEST_NOW });
  assert.notEqual(first, second);
  assert.deepEqual(decryptJson(first, 'passphrase'), value);
  assert.deepEqual(decryptJson(second, 'passphrase'), value);
  assert.throws(() => decryptJson('not an export', 'passphrase'), /格式|export/u);
});

test('加密 CLI：缺少 --out 时非零退出', (t) => {
  const { dir, dbPath, store } = makeDatabase(t);
  const fact = insertFact(store);
  const script = fileURLToPath(new URL('../scripts/export-encrypted.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, dbPath, fact.id], {
    input: 'correct horse\n',
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.ok(existsSync(dir));
});

test('加密 CLI：空口令非零退出且不写文件', (t) => {
  const { dir, dbPath, store } = makeDatabase(t);
  const fact = insertFact(store);
  const output = join(dir, 'empty.enc');
  const script = fileURLToPath(new URL('../scripts/export-encrypted.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, dbPath, fact.id, '--out', output], {
    input: '\n',
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(output), false);
});

test('/记忆 导出：无参数默认 json，支持自定义目录', (t) => {
  const { dir, store } = makeDatabase(t);
  insertFact(store);
  const reply = handleMemoryCommand({
    text: '/记忆 导出',
    store,
    now: TEST_NOW,
    scope: 'main',
    dir,
  });
  assert.match(reply, /已导出记忆（json）/u);
  const path = reply.split('文件：')[1].trim();
  assert.ok(path.endsWith('.json'));
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(payload.counts.facts, 1);
});

test('/记忆 导出：仅接受 md/json', (t) => {
  const { dir, store } = makeDatabase(t);
  const reply = handleMemoryCommand({
    text: '/记忆 导出 yaml',
    store,
    now: TEST_NOW,
    scope: 'main',
    dir,
  });
  assert.match(reply, /用法：\/记忆 导出 \[md\|json\]/u);
});
