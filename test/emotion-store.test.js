import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EMOTION_EVENT_RETENTION,
  Store,
} from '../src/memory/store.js';

const NOW_MS = 1_760_000_000_000;

function makeDatabase(t, prefix = 'dsh-emotion-store-') {
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
    updatedAt: NOW_MS,
    ...overrides,
  };
}

function deltas(overrides = {}) {
  return { pleasure: 1, arousal: -1, dominance: 0, energy: 2, ...overrides };
}

function tableExists(store, table) {
  const row = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

test('迁移：v13 库（已建库后降版本并 DROP 新表）打开后升到 v14，补表且不丢数据', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-emotion-migrate-'));
  const dbPath = join(dir, 'companion.db');
  /** @type {Store|null} */
  let live = null;
  t.after(() => {
    try {
      live?.close();
    } catch {
      // 已关闭。
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // 造 v13 形状：保留既有数据，把版本标回 13，并删掉 v14 才有的两张表。
  {
    const store = Store.open(dbPath);
    const at = Math.floor(NOW_MS / 1000);
    const fact = store.insertFact({
      scope: 'main',
      kind: 'identity',
      subject_text: '青柠计划',
      predicate: '代号',
      object_text: '蓝鲸',
      statement: '青柠计划的代号是蓝鲸。',
      source_kind: 'user_explicit',
      salience: 'normal',
      observed_at: at,
      last_reinforced_at: at,
    });
    store.insertEpisode({
      scope: 'main',
      session_id: 'emotion-migrate',
      started_at: at,
      ended_at: at,
      title: '迁移前的记忆',
      summary: '迁移前的情景不应丢失。',
      topics: ['迁移'],
      salience: 'normal',
      last_reinforced_at: at,
    });
    store.db.exec('DROP INDEX IF EXISTS ix_emotion_events');
    store.db.exec('DROP TABLE IF EXISTS emotion_events');
    store.db.exec('DROP TABLE IF EXISTS emotion_state');
    store.db.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schema_version'").run();
    assert.equal(store.getMeta('schema_version'), '13');
    store.close();
    assert.ok(fact.id);
  }

  const migrated = Store.open(dbPath);
  live = migrated;
  assert.equal(migrated.getMeta('schema_version'), '15');
  assert.ok(tableExists(migrated, 'emotion_state'));
  assert.ok(tableExists(migrated, 'emotion_events'));
  assert.equal(
    migrated.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n,
    1,
    'v13 的 facts 数据应保留',
  );
  assert.equal(
    migrated.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
    1,
    'v13 的 episodes 数据应保留',
  );
  assert.deepEqual(migrated.getEmotionState('main'), null);

  // 重复打开幂等：版本不变、不重复建表、不重置数据。
  migrated.close();
  const reopened = Store.open(dbPath);
  live = reopened;
  assert.equal(reopened.getMeta('schema_version'), '15');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 1);
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'emotion_state'").get().n,
    1,
  );
});

test('getEmotionState：未知 scope 返回 null；setEmotionState 不存在→插入、存在→覆盖且无重复行', (t) => {
  const { store } = makeDatabase(t);
  assert.equal(store.getEmotionState('main'), null);

  const first = store.setEmotionState('main', state());
  assert.deepEqual(first, {
    scope: 'main',
    pleasure: 60,
    arousal: 40,
    dominance: 50,
    energy: 70,
    updatedAt: NOW_MS,
    lastEventAt: null,
  });

  const second = store.setEmotionState(
    'main',
    state({ pleasure: 12.5, arousal: 99, dominance: 0, energy: 100, updatedAt: NOW_MS + 1000 }),
  );
  assert.equal(second.pleasure, 12.5);
  assert.equal(second.arousal, 99);
  assert.equal(second.updatedAt, NOW_MS + 1000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM emotion_state').get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM emotion_state WHERE scope = 'main'").get().n, 1);
});

test('setEmotionState：省略 lastEventAt 保留现值，显式 null 清空', (t) => {
  const { store } = makeDatabase(t);
  store.setEmotionState('main', state({ lastEventAt: NOW_MS + 500 }));
  store.setEmotionState('main', state({ pleasure: 61 }));
  assert.equal(store.getEmotionState('main').lastEventAt, NOW_MS + 500);
  store.setEmotionState('main', state({ lastEventAt: null }));
  assert.equal(store.getEmotionState('main').lastEventAt, null);
});

test('setEmotionState 参数校验：四维越界/非数、updatedAt 非法抛 TypeError', (t) => {
  const { store } = makeDatabase(t);
  for (const bad of [
    { pleasure: 101 },
    { pleasure: -1 },
    { pleasure: Number.NaN },
    { pleasure: Number.POSITIVE_INFINITY },
    { pleasure: '50' },
  ]) {
    assert.throws(() => store.setEmotionState('main', state(bad)), TypeError, JSON.stringify(bad));
  }
  for (const dim of ['pleasure', 'arousal', 'dominance', 'energy']) {
    const missing = state();
    delete missing[dim];
    assert.throws(() => store.setEmotionState('main', missing), TypeError, `缺 ${dim}`);
  }
  assert.throws(() => store.setEmotionState('main', state({ updatedAt: Number.NaN })), TypeError);
  assert.throws(() => store.setEmotionState('main', state({ updatedAt: undefined })), TypeError);
  assert.throws(() => store.setEmotionState('main', state({ lastEventAt: 'yesterday' })), TypeError);
  assert.throws(() => store.setEmotionState('', state()), TypeError);
  assert.equal(store.getEmotionState('main'), null, '校验失败不应留下半截写入');
});

test('appendEmotionEvent：插入、deltas 反序列化、last_event_at 同步、list 按 at DESC,id DESC', (t) => {
  const { store } = makeDatabase(t);
  store.setEmotionState('main', state());
  const first = store.appendEmotionEvent('main', {
    at: NOW_MS,
    type: 'joy',
    deltas: deltas({ pleasure: 3 }),
    note: '项目过审',
  });
  assert.equal(typeof first.id, 'number');
  assert.deepEqual(first.deltas, { pleasure: 3, arousal: -1, dominance: 0, energy: 2 });
  assert.equal(store.getEmotionState('main').lastEventAt, NOW_MS);

  const second = store.appendEmotionEvent('main', {
    at: NOW_MS + 1000,
    type: 'stress',
    deltas: deltas({ arousal: 4 }),
  });
  const third = store.appendEmotionEvent('main', {
    at: NOW_MS + 1000,
    type: 'calm',
    deltas: deltas({ arousal: -2 }),
  });
  assert.equal(store.getEmotionState('main').lastEventAt, NOW_MS + 1000);

  const listed = store.listEmotionEvents('main');
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map((row) => row.type), ['calm', 'stress', 'joy'], '同 at 时 id 大的在前');
  assert.equal(listed[0].id, third.id);
  assert.equal(listed[1].id, second.id);
  assert.equal(listed[2].id, first.id);
  assert.deepEqual(listed[2].deltas, { pleasure: 3, arousal: -1, dominance: 0, energy: 2 });
  assert.equal(listed[0].scope, 'main');
  assert.equal(store.listEmotionEvents('main', 2).length, 2);
  assert.equal(store.listEmotionEvents('main', 2)[0].type, 'calm');
  assert.equal(store.countEmotionEvents('main'), 3);
});

test('appendEmotionEvent：超过 50 条后淘汰最旧，总数恒为 50', (t) => {
  const { store } = makeDatabase(t);
  const total = EMOTION_EVENT_RETENTION + 5;
  for (let index = 0; index < total; index += 1) {
    store.appendEmotionEvent('main', {
      at: NOW_MS + index,
      type: `evt-${index}`,
      deltas: deltas(),
    });
  }
  assert.equal(store.countEmotionEvents('main'), EMOTION_EVENT_RETENTION);
  const all = store.listEmotionEvents('main', EMOTION_EVENT_RETENTION);
  assert.equal(all.length, EMOTION_EVENT_RETENTION);
  assert.equal(all[0].type, `evt-${total - 1}`, '最新的在最前');
  assert.equal(all[EMOTION_EVENT_RETENTION - 1].type, `evt-${total - EMOTION_EVENT_RETENTION}`, '最旧的被淘汰');
  assert.equal(store.getEmotionState('main'), null, '无状态行时 append 不伪造 state');
});

test('appendEmotionEvent 参数校验：at/type/deltas/note 非法抛 TypeError', (t) => {
  const { store } = makeDatabase(t);
  assert.throws(
    () => store.appendEmotionEvent('main', { at: NOW_MS, type: 'joy', deltas: { pleasure: 1 } }),
    TypeError,
    'deltas 缺维',
  );
  assert.throws(
    () => store.appendEmotionEvent('main', {
      at: NOW_MS, type: 'joy', deltas: deltas({ energy: 'lots' }),
    }),
    TypeError,
  );
  assert.throws(
    () => store.appendEmotionEvent('main', {
      at: NOW_MS, type: 'joy', deltas: deltas({ dominance: Number.NaN }),
    }),
    TypeError,
  );
  assert.throws(
    () => store.appendEmotionEvent('main', { at: NOW_MS, type: 'joy', deltas: null }),
    TypeError,
  );
  assert.throws(
    () => store.appendEmotionEvent('main', { at: '1000', type: 'joy', deltas: deltas() }),
    TypeError,
    'at 必须是数字',
  );
  assert.throws(
    () => store.appendEmotionEvent('main', { at: Number.NaN, type: 'joy', deltas: deltas() }),
    TypeError,
  );
  assert.throws(
    () => store.appendEmotionEvent('main', { at: NOW_MS, type: '', deltas: deltas() }),
    TypeError,
  );
  assert.throws(
    () => store.appendEmotionEvent('main', { at: NOW_MS, type: 'joy', deltas: deltas(), note: 42 }),
    TypeError,
  );
  assert.equal(store.countEmotionEvents('main'), 0, '校验失败不应写入');
});

test('listEmotionEvents：坏 deltas_json 退化为空对象，不阻断整表读取', (t) => {
  const { store } = makeDatabase(t);
  store.appendEmotionEvent('main', { at: NOW_MS, type: 'joy', deltas: deltas() });
  store.db
    .prepare("UPDATE emotion_events SET deltas_json = 'not-json' WHERE type = 'joy'")
    .run();
  assert.deepEqual(store.listEmotionEvents('main')[0].deltas, {});
});

test('resetEmotion：单事务删该 scope 两表，其它 scope 不受影响，返回事件条数', (t) => {
  const { store } = makeDatabase(t);
  store.setEmotionState('main', state());
  store.setEmotionState('other', state({ pleasure: 20 }));
  for (let index = 0; index < 4; index += 1) {
    store.appendEmotionEvent('main', { at: NOW_MS + index, type: 'joy', deltas: deltas() });
  }
  store.appendEmotionEvent('other', { at: NOW_MS, type: 'calm', deltas: deltas() });

  assert.deepEqual(store.resetEmotion('main'), { events: 4 });
  assert.equal(store.getEmotionState('main'), null);
  assert.equal(store.countEmotionEvents('main'), 0);
  assert.equal(store.getEmotionState('other').pleasure, 20, '其它 scope 的状态保留');
  assert.equal(store.countEmotionEvents('other'), 1, '其它 scope 的事件保留');
  assert.deepEqual(store.resetEmotion('main'), { events: 0 }, '重复 reset 幂等');
});

test('purge：按 cutoff 删情绪事件、删对应 state，审计含 emotionEvents 且不含正文，重复 purge 幂等', (t) => {
  const { store } = makeDatabase(t);
  const now = 1_800_000_000;
  const cutoffDays = 7;
  const cutoffMs = (now - cutoffDays * 86400) * 1000;
  store.setEmotionState('main', state({ updatedAt: NOW_MS }));
  store.appendEmotionEvent('main', {
    at: cutoffMs - 1000,
    type: 'old-stress',
    deltas: deltas(),
    note: '这条旧事件应该被清掉',
  });
  store.appendEmotionEvent('main', {
    at: cutoffMs + 1000,
    type: 'fresh-joy',
    deltas: deltas(),
    note: '这条新事件保留',
  });
  store.setEmotionState('kept', state({ updatedAt: NOW_MS }));
  store.appendEmotionEvent('kept', {
    at: cutoffMs + 2000,
    type: 'kept',
    deltas: deltas(),
  });

  assert.deepEqual(store.purge({ now, cutoffDays }), { facts: 0, episodes: 0 });
  assert.equal(store.countEmotionEvents('main'), 1);
  assert.deepEqual(store.listEmotionEvents('main').map((row) => row.type), ['fresh-joy']);
  assert.equal(store.getEmotionState('main'), null, '窗口外痕迹所在 scope 的 state 被删');
  assert.equal(store.getEmotionState('kept').pleasure, 60, '只有新事件的 scope 不受影响');

  const audits = store.listEvents({ table_name: 'emotion_events', action: 'PURGED' });
  assert.equal(audits.length, 1);
  const detail = JSON.parse(audits[0].detail_json);
  assert.deepEqual(detail, { emotionEvents: 1, emotionStates: 1 });
  assert.equal(audits[0].row_id, null);
  assert.doesNotMatch(JSON.stringify(detail), /应该被清掉/u);

  // 重复 purge：没有新删除 → 不再追写审计，状态不再变化。
  assert.deepEqual(store.purge({ now, cutoffDays }), { facts: 0, episodes: 0 });
  assert.equal(store.listEvents({ table_name: 'emotion_events', action: 'PURGED' }).length, 1);
  assert.equal(store.countEmotionEvents('main'), 1);
});

test('purge：无情绪数据时不追加审计事件（既有审计计数不回归）', (t) => {
  const { store } = makeDatabase(t);
  const before = store.listEvents({ action: 'PURGED' }).length;
  store.purge({ now: 1_800_000_000, cutoffDays: 7 });
  assert.equal(store.listEvents({ action: 'PURGED' }).length, before);
});
