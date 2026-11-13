/**
 * P1-a 记忆治理测试：scan / apply / exportMirror 与 EDIT 审计。
 *
 * 覆盖外部评审 P1-a 的边界：Jaccard 0.92、冲突、R<0.05、pinned 保护、
 * dryRun 不写、敏感词 + FTS 投影剔除、事件 detail 计数与 id、镜像脱敏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import {
  appendEventWithAction,
  apply,
  exportMirror,
  isSensitiveText,
  scan,
} from '../src/memory/govern.js';
import { editMemoryFact } from '../src/index.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);
const DAY_MS = 86_400_000;

function makeStore(t) {
  const store = Store.open(':memory:');
  if (t && typeof t.after === 'function') t.after(() => store.close());
  return store;
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    kind: 'preference',
    subject_text: '我',
    predicate: '习惯',
    object_text: '喝咖啡',
    statement: '我习惯早上喝咖啡',
    source_kind: 'user_explicit',
    observed_at: Math.floor(NOW_MS / 1000),
    ...overrides,
  });
}

function ftsCount(store, id) {
  return store.db
    .prepare('SELECT COUNT(*) AS n FROM fts_facts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)')
    .get(id).n;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-govern-'));
  if (t && typeof t.after === 'function') t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('isSensitiveText：命中身份证/银行卡/密码/住址，普通文本不命中', () => {
  assert.equal(isSensitiveText('我的身份证号码是 110101'), true);
  assert.equal(isSensitiveText('银行卡号 6222'), true);
  assert.equal(isSensitiveText('wifi 密码是 abc'), true);
  assert.equal(isSensitiveText('我家住址在朝阳区'), true);
  assert.equal(isSensitiveText('我喜欢喝咖啡'), false);
  assert.equal(isSensitiveText(null), false);
});

test('scan：重复项用 bigram Jaccard ≥0.92，冲突同 subject+predicate 不同 object，过期 R<0.05', (t) => {
  const store = makeStore(t);
  const keep = addFact(store, {
    subject_text: '我妈',
    predicate: '生日',
    object_text: '五月',
    statement: '我妈生日是五月三日',
    salience: 'explicit',
  });
  const drop = addFact(store, {
    subject_text: '我妈',
    predicate: '生日',
    object_text: '五月',
    statement: '我妈生日是五月三日',
    salience: 'normal',
  });
  const conflict = addFact(store, {
    subject_text: '预算',
    predicate: '金额',
    object_text: '8000',
    statement: '预算金额是 8000',
    observed_at: Math.floor((NOW_MS - 2 * DAY_MS) / 1000),
  });
  const conflict2 = addFact(store, {
    subject_text: '预算',
    predicate: '金额',
    object_text: '12000',
    statement: '预算金额是 12000',
    observed_at: Math.floor((NOW_MS - 2 * DAY_MS) / 1000),
    salience: 'notable',
  });
  const stale = addFact(store, {
    subject_text: '旧闻',
    predicate: '状态',
    object_text: '过期',
    statement: '这条记忆已经很久没有用过了',
    observed_at: Math.floor((NOW_MS - 100 * DAY_MS) / 1000),
    last_reinforced_at: Math.floor((NOW_MS - 100 * DAY_MS) / 1000),
    salience: 'normal',
  });
  const pinned = addFact(store, {
    subject_text: '旧闻',
    predicate: '置顶',
    object_text: '不过期',
    statement: '置顶记忆从不衰减',
    observed_at: Math.floor((NOW_MS - 100 * DAY_MS) / 1000),
    salience: 'pinned',
  });

  const report = scan({ store, now: NOW_MS });
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].keepId, keep.id, 'salience 更高的保留');
  assert.equal(report.duplicates[0].dropId, drop.id);
  assert.ok(report.duplicates[0].score >= 0.92);
  assert.equal(report.duplicates[0].score, 1);

  const budgetConflict = report.conflicts.find((item) => item.subject === '预算');
  assert.deepEqual(budgetConflict.factIds, [conflict.id, conflict2.id].sort());
  assert.equal(report.stale.some((item) => item.id === stale.id), true);
  assert.equal(report.stale.some((item) => item.id === pinned.id), false, 'pinned 不参与过期');
});

test('scan 相似度阈值：低于 0.92 的相近文本不当作重复', (t) => {
  const store = makeStore(t);
  addFact(store, { statement: '我每天早上去公园散步' });
  addFact(store, { statement: '我每天早上去公司上班' });
  const report = scan({ store, now: NOW_MS });
  assert.equal(report.duplicates.length, 0);
});

test('编辑敏感事实：新条保留 sensitive 标记且不进 FTS/镜像', (t) => {
  const store = makeStore(t);
  const old = addFact(store, {
    subject_text: '我',
    predicate: '银行卡',
    object_text: '6222',
    statement: '我的银行卡密码是 123456',
    salience: 'notable',
  });
  const result = editMemoryFact({
    store,
    scope: 'main',
    id: old.id,
    statement: '我的银行卡密码是 654321',
    now: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(store.getFact(old.id).status, 'superseded');
  const updated = store.getFact(result.id);
  assert.equal(updated.sensitive, 1);
  assert.equal(ftsCount(store, updated.id), 0);
  assert.equal(store.searchBigram('654321', {}).length, 0);
  const dir = tempDir(t);
  exportMirror({ store, dir, now: NOW_MS });
  const mirror = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.doesNotMatch(mirror, /654321/);
});

test('scan 只读：不改 status、不写事件、不建 sensitive 列', (t) => {
  const store = makeStore(t);
  const first = addFact(store, { statement: '重复记忆内容一样' });
  const second = addFact(store, { statement: '重复记忆内容一样' });
  const beforeEvents = store.listEvents({ limit: 500 }).length;
  const report = scan({ store, now: NOW_MS });
  assert.equal(report.duplicates.length, 1);
  assert.equal(store.getFact(first.id).status, 'active');
  assert.equal(store.getFact(second.id).status, 'active');
  assert.equal(store.listEvents({ limit: 500 }).length, beforeEvents);
  const columns = store.db.prepare('PRAGMA table_info(facts)').all();
  assert.equal(columns.some((column) => column.name === 'sensitive'), false);
});

test('apply 默认 dryRun=true：不 supersede、不标记敏感、不写事件', (t) => {
  const store = makeStore(t);
  const first = addFact(store, { statement: '我家的 wifi 密码是 abc123' });
  const second = addFact(store, { statement: '我家的 wifi 密码是 abc123' });
  const result = apply({ store, now: NOW_MS });
  assert.equal(result.dryRun, true);
  assert.equal(result.eventId, null);
  assert.equal(store.getFact(first.id).status, 'active');
  assert.equal(store.getFact(second.id).status, 'active');
  assert.equal(ftsCount(store, first.id), 1);
  assert.equal(store.listEvents({ action: 'govern', limit: 10 }).length, 0);
});

test('apply dryRun=false：重复降级 + 删 FTS + 敏感标记 + govern 事件 detail', (t) => {
  const store = makeStore(t);
  const keep = addFact(store, {
    subject_text: '妈妈',
    predicate: '生日',
    object_text: '五月',
    statement: '妈妈生日是五月三日',
    salience: 'explicit',
  });
  const drop = addFact(store, {
    subject_text: '妈妈',
    predicate: '生日',
    object_text: '五月',
    statement: '妈妈生日是五月三日',
    salience: 'normal',
  });
  const secret = addFact(store, {
    subject_text: '我',
    predicate: '银行卡',
    object_text: '6222',
    statement: '我的银行卡密码是 123456',
    salience: 'notable',
  });

  const result = apply({ store, now: NOW_MS, dryRun: false });
  assert.equal(result.dryRun, false);
  assert.equal(result.applied.superseded.length, 1);
  assert.deepEqual(result.applied.superseded, [drop.id]);
  assert.equal(store.getFact(keep.id).status, 'active');
  assert.equal(store.getFact(drop.id).status, 'superseded');
  assert.equal(store.getFact(drop.id).superseded_by, keep.id);
  assert.equal(ftsCount(store, drop.id), 0, '降级条从 FTS 投影剔除');

  const secretRow = store.getFact(secret.id);
  assert.equal(secretRow.sensitive, 1);
  assert.equal(ftsCount(store, secret.id), 0, '敏感条从 FTS 投影剔除');
  assert.equal(store.searchBigram('银行卡', {}).length, 0);

  const events = store.listEvents({ action: 'govern', limit: 10 });
  assert.equal(events.length, 1);
  const detail = JSON.parse(events[0].detail_json);
  assert.equal(events[0].actor, 'user');
  assert.equal(detail.duplicates, 1);
  assert.equal(detail.sensitive, 1);
  assert.deepEqual(detail.supersededIds, [drop.id]);
  assert.deepEqual(detail.sensitiveIds, [secret.id]);
  assert.equal(typeof result.eventId, 'number');
  assert.equal(result.eventId, events[0].id);
});

test('apply 不物理删除任何行，重复执行幂等（已 superseded 不再降级）', (t) => {
  const store = makeStore(t);
  const first = addFact(store, { statement: '同样的偏好' });
  const second = addFact(store, { statement: '同样的偏好' });
  apply({ store, now: NOW_MS, dryRun: false });
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
  const again = apply({ store, now: NOW_MS, dryRun: false });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, rows);
  assert.equal(again.applied.superseded.length, 0);
  assert.equal(store.getFact(first.id).status + store.getFact(second.id).status !== '', true);
});

test('exportMirror：写 MEMORY.md，过滤 secret/敏感/墓碑，并受 maxLines 限制', (t) => {
  const store = makeStore(t);
  const dir = tempDir(t);
  addFact(store, { statement: '正常记忆：每周五交周报。', source_kind: 'user_explicit' });
  addFact(store, { statement: '秘密记忆：内部代号。', privacy: 'secret' });
  const sensitive = addFact(store, { statement: '我的银行卡密码是 123456' });
  const tomb = addFact(store, { statement: '墓碑记忆不应导出' });
  store.forgetFact(tomb.id, { at: NOW_MS });

  const result = exportMirror({ store, dir, now: NOW_MS });
  assert.equal(result.facts > 0, true);
  assert.equal(result.truncated, 0);
  const content = readFileSync(result.path, 'utf8');
  assert.match(content, /generated_at:/);
  assert.match(content, /source: dsh-companion facts/);
  assert.match(content, /正常记忆：每周五交周报/);
  assert.doesNotMatch(content, /秘密记忆：内部代号/);
  assert.doesNotMatch(content, /银行卡密码/);
  assert.doesNotMatch(content, /墓碑记忆不应导出/);
  assert.equal(content.includes(sensitive.id), false);

  const longDir = tempDir(t);
  for (let index = 0; index < 20; index += 1) {
    addFact(store, { statement: `批量记忆 ${index}`, subject_text: `主题${index}` });
  }
  const limited = exportMirror({ store, dir: longDir, now: NOW_MS, maxLines: 12 });
  assert.equal(limited.truncated > 0, true);
  assert.equal(limited.lines <= 12, true);
  assert.equal(readFileSync(limited.path, 'utf8').split('\n').length <= 12, true);
});

test('appendEventWithAction：允许 govern/EDIT 直插，结束后恢复 CHECK 约束', (t) => {
  const store = makeStore(t);
  const eventId = appendEventWithAction(store, {
    action: 'EDIT',
    tableName: 'facts',
    rowId: 'fact_test',
    reason: 'memory_update',
    detail: { from: 'a', to: 'b' },
    at: NOW_MS,
  });
  assert.equal(typeof eventId, 'number');
  const event = store.listEvents({ action: 'EDIT', limit: 1 })[0];
  assert.equal(event.id, eventId);
  assert.equal(event.detail_json, '{"from":"a","to":"b"}');
  const pragma = store.db.prepare('PRAGMA ignore_check_constraints').get();
  assert.equal(pragma.ignore_check_constraints, 0);
  assert.throws(
    () => store.db.prepare("INSERT INTO memory_events (at, action, table_name, actor) VALUES (0, 'NOPE', 'facts', 'user')").run(),
    /CHECK/i,
    '恢复后普通插入仍受 CHECK 约束',
  );
  // v15 起 govern/EDIT/scrub 已在 CHECK 白名单内：普通插入不再需要临时 PRAGMA。
  store.db.prepare("INSERT INTO memory_events (at, action, table_name, actor) VALUES (0, 'govern', 'facts', 'user')").run();
});
