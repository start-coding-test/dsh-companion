import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import {
  decryptJson,
  encryptJson,
  exportAll,
  importAll,
} from '../src/memory/export.js';

const TEST_NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const MS = 1_760_000_000_000;

function makeDatabase(t, prefix = 'dsh-emotion-export-') {
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

function state(overrides = {}) {
  return {
    pleasure: 60,
    arousal: 40,
    dominance: 50,
    energy: 70,
    updatedAt: MS,
    ...overrides,
  };
}

function deltas(overrides = {}) {
  return { pleasure: 1, arousal: -1, dominance: 0, energy: 2, ...overrides };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 源库：两个 scope 的状态 + 4 条事件（main 3 条，thread:budget 1 条）。
 * events 的 at 严格递增，导出顺序应为 at ASC。
 */
function seedEmotion(store) {
  store.setEmotionState('main', state({ lastEventAt: MS + 2000 }));
  store.setEmotionState('thread:budget', state({ pleasure: 20, arousal: 10, energy: 30 }));
  store.appendEmotionEvent('main', {
    at: MS,
    type: 'joy',
    deltas: deltas({ pleasure: 3 }),
    note: '项目过审',
  });
  store.appendEmotionEvent('main', {
    at: MS + 1000,
    type: 'stress',
    deltas: deltas({ arousal: 5 }),
  });
  store.appendEmotionEvent('main', {
    at: MS + 2000,
    type: 'calm',
    deltas: deltas({ arousal: -3, energy: -1 }),
  });
  store.appendEmotionEvent('thread:budget', {
    at: MS + 500,
    type: 'focus',
    deltas: deltas({ dominance: 2 }),
  });
}

test('exportAll json：emotion.state 全量、events 每 scope 最近 50 且按 at 升序，schema_version=14', (t) => {
  const { dir, store } = makeDatabase(t);
  seedEmotion(store);
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = readJson(exported.path);

  assert.equal(payload.schema_version, '14');
  assert.equal(payload.counts.facts, 0, 'counts 未新增情绪键，保持既有形状');
  assert.equal(payload.data.emotion.state.length, 2);
  assert.equal(payload.data.emotion.events.length, 4);
  assert.deepEqual(Object.keys(payload.data.emotion).sort(), ['events', 'state']);
  assert.deepEqual(exported.warnings, []);

  const states = payload.data.emotion.state;
  assert.equal(states.length, 2);
  const main = states.find((row) => row.scope === 'main');
  assert.deepEqual(main, {
    scope: 'main',
    pleasure: 60,
    arousal: 40,
    dominance: 50,
    energy: 70,
    updatedAt: MS,
    lastEventAt: MS + 2000,
  });
  assert.equal(states.find((row) => row.scope === 'thread:budget').pleasure, 20);

  const events = payload.data.emotion.events;
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((row) => row.type), ['joy', 'stress', 'calm', 'focus'], '按 scope 分组、组内 at 升序');
  assert.deepEqual(events[0].deltas, { pleasure: 3, arousal: -1, dominance: 0, energy: 2 });
  assert.equal(events[0].note, '项目过审');
  assert.equal(Object.hasOwn(events[0], 'id'), false, '导出不落源库自增 id');
});

test('导出：events 每 scope 截到最近 50 条（超出旧事件不导出）', (t) => {
  const { dir, store } = makeDatabase(t);
  for (let index = 0; index < 55; index += 1) {
    store.appendEmotionEvent('main', {
      at: MS + index,
      type: `evt-${index}`,
      deltas: deltas(),
    });
  }
  const payload = readJson(exportAll({ store, format: 'json', dir, now: TEST_NOW }).path);
  assert.equal(payload.data.emotion.events.length, 50);
  assert.equal(payload.data.emotion.events[0].type, 'evt-5');
  assert.equal(payload.data.emotion.events[49].type, 'evt-54');
});

test('导出：note 含敏感词时置 null 并记 warning，JSON 不含明文', (t) => {
  const { dir, store } = makeDatabase(t);
  store.appendEmotionEvent('main', {
    at: MS,
    type: 'confide',
    deltas: deltas(),
    note: '我的密码是 654321，别告诉别人',
  });
  store.appendEmotionEvent('main', {
    at: MS + 1,
    type: 'joy',
    deltas: deltas(),
    note: '正常备注',
  });
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const raw = readFileSync(exported.path, 'utf8');
  assert.doesNotMatch(raw, /654321/u, '敏感 note 不得出现在导出文件');
  const payload = JSON.parse(raw);
  assert.equal(payload.data.emotion.events[0].note, null);
  assert.equal(payload.data.emotion.events[1].note, '正常备注');
  assert.equal(exported.warnings.length, 1);
  assert.match(exported.warnings[0], /note/u);
});

test('importAll fresh：state 四维/updatedAt/lastEventAt 与 events 条数、顺序一致往返', (t) => {
  const source = makeDatabase(t, 'dsh-emotion-fresh-src-');
  seedEmotion(source.store);
  const exported = exportAll({
    store: source.store, format: 'json', dir: source.dir, now: TEST_NOW,
  });
  const payload = readJson(exported.path);

  const target = makeDatabase(t, 'dsh-emotion-fresh-dst-');
  const result = importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.emotionImported, { state: 2, events: 4, trimmed: 0 });
  assert.deepEqual(result.imported, {
    facts: 0, episodes: 0, reminders: 0, threads: 0, state_board: 1,
  }, '既有 imported 形状不变');

  assert.deepEqual(
    target.store.getEmotionState('main'),
    payload.data.emotion.state.find((row) => row.scope === 'main'),
  );
  assert.deepEqual(
    target.store.getEmotionState('thread:budget'),
    payload.data.emotion.state.find((row) => row.scope === 'thread:budget'),
  );

  // 导出按 at 升序，落库后 list 按 at DESC,id DESC，顺序应整体反转且内容一致。
  const expected = payload.data.emotion.events
    .filter((row) => row.scope === 'main')
    .slice()
    .reverse();
  const listed = target.store.listEmotionEvents('main', 10);
  assert.deepEqual(
    listed.map(({ scope, at, type, deltas: eventDeltas, note }) => ({
      scope, at, type, deltas: eventDeltas, note,
    })),
    expected,
  );
  assert.equal(target.store.countEmotionEvents('thread:budget'), 1);
  assert.equal(target.store.countEmotionEvents('main'), 3);
});

test('importAll fresh：目标库已有情绪数据时按「非空」拒绝（emotion 也是记忆）', (t) => {
  const source = makeDatabase(t, 'dsh-emotion-nonempty-src-');
  seedEmotion(source.store);
  const exported = exportAll({
    store: source.store, format: 'json', dir: source.dir, now: TEST_NOW,
  });

  const target = makeDatabase(t, 'dsh-emotion-nonempty-dst-');
  target.store.setEmotionState('main', state());
  assert.throws(
    () => importAll({ store: target.store, file: exported.path, mode: 'fresh' }),
    /为空/u,
  );
});

test('importAll merge：emotion_state 以导入为准覆盖，events 追加后按 50 条截断', (t) => {
  const source = makeDatabase(t, 'dsh-emotion-merge-src-');
  source.store.setEmotionState('main', state({ pleasure: 88, updatedAt: MS + 9000 }));
  for (let index = 0; index < 5; index += 1) {
    source.store.appendEmotionEvent('main', {
      at: MS + 10_000 + index,
      type: `imported-${index}`,
      deltas: deltas(),
    });
  }
  const exported = exportAll({
    store: source.store, format: 'json', dir: source.dir, now: TEST_NOW,
  });

  const target = makeDatabase(t, 'dsh-emotion-merge-dst-');
  target.store.setEmotionState('main', state({ pleasure: 10 }));
  for (let index = 0; index < 48; index += 1) {
    target.store.appendEmotionEvent('main', {
      at: MS - 48_000 + index * 1000,
      type: `local-${index}`,
      deltas: deltas(),
    });
  }
  assert.equal(target.store.countEmotionEvents('main'), 48);

  const result = importAll({ store: target.store, file: exported.path, mode: 'merge' });
  assert.deepEqual(result.emotionImported, { state: 1, events: 5, trimmed: 3 });
  assert.equal(target.store.getEmotionState('main').pleasure, 88, '导入状态覆盖本地状态');
  assert.equal(target.store.getEmotionState('main').updatedAt, MS + 9000);

  assert.equal(target.store.countEmotionEvents('main'), 50);
  const listed = target.store.listEmotionEvents('main', 50);
  assert.equal(listed[0].type, 'imported-4', '最新的是导入的事件');
  assert.equal(listed.filter((row) => row.type.startsWith('imported-')).length, 5);
  assert.equal(
    listed.some((row) => row.type === 'local-0' || row.type === 'local-1' || row.type === 'local-2'),
    false,
    '最旧的 3 条本地事件被截断',
  );
  assert.equal(listed.some((row) => row.type === 'local-3'), true);
});

test('importAll：旧导出文件（无 emotion 段）不阻断，emotionImported 全零', (t) => {
  const source = makeDatabase(t, 'dsh-emotion-legacy-src-');
  source.store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    statement: '青柠计划的代号是蓝鲸。',
    source_kind: 'turn',
    observed_at: Math.floor(TEST_NOW / 1000),
    last_reinforced_at: Math.floor(TEST_NOW / 1000),
  });
  const exported = exportAll({
    store: source.store, format: 'json', dir: source.dir, now: TEST_NOW,
  });
  const payload = readJson(exported.path);
  delete payload.data.emotion;
  const legacyPath = join(source.dir, 'legacy-export.json');
  writeFileSync(legacyPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const target = makeDatabase(t, 'dsh-emotion-legacy-dst-');
  const result = importAll({ store: target.store, file: legacyPath, mode: 'fresh' });
  assert.deepEqual(result.emotionImported, { state: 0, events: 0, trimmed: 0 });
  assert.equal(target.store.getEmotionState('main'), null);
  assert.equal(target.store.stats().facts, 1, '既有导入行为不受影响');
});

test('importAll：单文件内 55 条情绪事件导入后只留最近 50 条', (t) => {
  const target = makeDatabase(t, 'dsh-emotion-cap-');
  const events = [];
  for (let index = 0; index < 55; index += 1) {
    events.push({
      scope: 'main',
      at: MS + index,
      type: `evt-${index}`,
      deltas: deltas(),
      note: null,
    });
  }
  const payload = {
    version: 1,
    exported_at: '2026-11-05T09:00:00.000Z',
    scope: 'main',
    schema_version: '14',
    counts: {},
    data: {
      facts: [], episodes: [], reminders: [], threads: [],
      state_board: null,
      emotion: { state: [state()], events },
    },
  };
  const file = join(target.dir, 'handmade.json');
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const result = importAll({ store: target.store, file, mode: 'fresh' });
  assert.deepEqual(result.emotionImported, { state: 1, events: 55, trimmed: 5 });
  assert.equal(target.store.countEmotionEvents('main'), 50);
  assert.equal(target.store.listEmotionEvents('main', 50)[0].type, 'evt-54');
});

test('加密导出/解密不改变 emotion 段（加密只包整份 JSON）', (t) => {
  const { dir, store } = makeDatabase(t);
  seedEmotion(store);
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = readJson(exported.path);
  const encrypted = encryptJson(payload, 'correct horse battery staple', { now: TEST_NOW });
  const decrypted = decryptJson(encrypted, 'correct horse battery staple');
  assert.deepEqual(decrypted, payload);
  assert.deepEqual(decrypted.data.emotion, payload.data.emotion);
});

test('exportAll md：包含情绪分节且不打印敏感 note', (t) => {
  const { dir, store } = makeDatabase(t);
  store.setEmotionState('main', state());
  store.appendEmotionEvent('main', {
    at: MS, type: 'confide', deltas: deltas(), note: '我的密码是 654321',
  });
  const exported = exportAll({ store, format: 'md', dir, now: TEST_NOW });
  const text = readFileSync(exported.path, 'utf8');
  assert.match(text, /## 情绪 emotion（state 1 \/ events 1）/u);
  assert.match(text, /pleasure=60/u);
  assert.match(text, /confide/u);
  assert.doesNotMatch(text, /654321/u);
});
