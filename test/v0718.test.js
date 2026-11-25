/**
 * v0.7.18 L4：强化审计来源；L2/L3：回填批不占 `/状态` 展示面 + 取消受理文案不主张终态。
 *
 * `Store.reinforceFact` 新增 `reason` / `actor` 两个可选入参，**默认保持原值**
 * （`used_in_reply` / `consolidator`）⇒ 巩固与召回强化路径零行为差异；
 * 只有 `memory_write` 的查重强化改记 `dedupe_write` / `user`（用户 2026-11-25 裁决：
 * 计划原文的 `actor='tool'` 被 schema 16 的 `memory_events.actor` CHECK 拒绝，
 * 落到既有 `user` 桶；`reason` 仍区分「查重写入」），便于审计区分来源。
 *
 * 全部为「非真机证据」：只验证审计事件字段，不涉及真实模型裁决或宿主路由。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { extractKeyPhrases } from '../src/memory/dedupe.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { formatStopTaskReply, handleCommand } from '../src/runtime/commands.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'preference',
    subject_text: '我',
    predicate: '记住',
    object_text: null,
    statement: '一条事实',
    source_kind: 'user_explicit',
    observed_at: NOW_SEC,
    ...overrides,
  });
}

function reinforceEvents(store, id) {
  return store.listEvents({ action: 'REINFORCE', row_id: id });
}

function makeMemoryWrite(store, extra = {}) {
  const tools = createTools({
    store,
    retrieve: () => ({ ok: true, items: [] }),
    platform: { log: () => {}, now: () => NOW_MS, capabilities: {} },
    clock: () => NOW_MS,
    timeZone: 'UTC',
    currentScope: () => 'main',
    ...extra,
  });
  return tools.find((tool) => tool.name === 'memory_write');
}

test('L4（v0.7.18 非真机证据）：reinforceFact 不带新参时审计仍是 used_in_reply/consolidator', (t) => {
  const store = openStore(t);
  const fact = addFact(store);

  const result = store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC });
  assert.equal(result.ok, true);

  const events = reinforceEvents(store, fact.id);
  assert.equal(events.length, 1);
  // 默认保持原值：巩固（consolidate）与召回路径都走这条默认分支，删默认值会立刻红。
  assert.equal(events[0].actor, 'consolidator');
  assert.equal(events[0].reason, 'used_in_reply');

  // 显式传参可用；非字符串/空串回落默认值（只影响审计，不新增抛错路径）。
  assert.equal(store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC, reason: 'dedupe_write', actor: 'user' }).ok, true);
  assert.equal(store.reinforceFact({ id: fact.id, scope: 'main', at: NOW_SEC, reason: '', actor: 7 }).ok, true);

  const all = reinforceEvents(store, fact.id);
  assert.equal(all.length, 3);
  assert.deepEqual([all[1].actor, all[1].reason], ['user', 'dedupe_write']);
  assert.deepEqual([all[2].actor, all[2].reason], ['consolidator', 'used_in_reply']);
});

test('L4（v0.7.18 非真机证据）：memory_write 查重 skip 强化的审计是 dedupe_write/user', async (t) => {
  const store = openStore(t);
  const statement = '青柠计划的代号是蓝鲸。';
  addFact(store, { statement });

  const write = makeMemoryWrite(store);
  const result = await write.execute({ kind: 'preference', statement, salience: 'normal', privacy: 'normal' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'reinforced', '同 kind 高相似走 skip → 强化旧条');
  assert.ok(result.duplicateOf, '返回 duplicateOf');

  const events = reinforceEvents(store, result.duplicateOf);
  assert.equal(events.length, 1);
  // tools.js 的 reinforce helper 一处传参即覆盖 skip 与 ask→same 两条分支。
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].reason, 'dedupe_write');
});

test('L4（v0.7.18 非真机证据）：memory_write ask→same 强化同样记 dedupe_write/user', async (t) => {
  const store = openStore(t);
  const statement = '青柠计划的代号是蓝鲸。';
  addFact(store, { statement: `${statement}（旧版本）` });

  const write = makeMemoryWrite(store, {
    judge: async () => JSON.stringify({ items: [{ index: 1, verdict: 'same' }] }),
    dedupe: { dedupeSkip: 0.99, dedupeAsk: 0.1 },
  });
  const result = await write.execute({ kind: 'preference', statement, salience: 'normal', privacy: 'normal' });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'reinforced');

  const events = reinforceEvents(store, result.duplicateOf);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'user');
  assert.equal(events[0].reason, 'dedupe_write');
});


// ------------------------------------------------------ L2（/状态 最近 job）

test('L2（v0.7.18 非真机证据）：回填批不占「最近 job：」，仍显示正常巩固行', (t) => {
  const store = openStore(t);
  // 正常巩固行较早落库；回填批（kind=forget_flush + trigger=backfill）更晚，
  // 若 SQL 不过滤 trigger，ORDER BY started_at DESC 会选中回填行（删掉过滤即红）。
  store.insertConsolidation({
    scope: 'main',
    kind: 'nap',
    trigger: 'threshold',
    upto_seq: 120,
    session_id: 'session-l2',
    status: 'written',
    started_at: NOW_SEC - 600,
  });
  store.insertConsolidation({
    scope: 'main',
    kind: 'forget_flush',
    trigger: 'backfill',
    upto_seq: 120,
    session_id: 'session-l2',
    status: 'written',
    started_at: NOW_SEC,
  });

  const reply = handleCommand({ text: '/状态', store, now: NOW_MS, timeZone: 'UTC' }).reply;
  assert.match(reply, /最近 job：nap written/u, '应选正常巩固行，实际：' + reply);
  assert.doesNotMatch(reply, /forget_flush/u);
});

// ------------------------------------------------------ L3（取消受理文案）

test('L3（v0.7.18 非真机证据）：取消受理文案不主张终态，两条分支措辞一致', () => {
  // 判别力：把 commands.js 的两处受理文案改回旧版（含「（状态：已取消）」）即红。
  const bg = formatStopTaskReply({ taskId: 'bg-1', kind: 'bg', result: { ok: true, cancelled: 1, taskId: 'bg-1' } });
  const task = formatStopTaskReply({ taskId: 'task-1', result: { ok: true, cancelled: 1, taskId: 'task-1' } });
  for (const [label, text, target] of [
    ['bg', bg, 'bg-1'],
    ['task', task, 'task-1'],
  ]) {
    assert.match(text, /取消中，收尾后回执送达/u, label + ' 应说明取消中而非终态');
    assert.ok(text.includes(target), label + ' 保留任务标识');
    assert.doesNotMatch(text, /已取消/u, label + ' 不应提前主张已取消');
  }
});


// ------------------------------------------------------ L5（关键串收窄）

test('L5（v0.7.18 非真机证据）：路径通用段不入关键串，项目名仍保留', () => {
  // 判别力：删掉 KEY_PHRASE_PATH_STOPWORDS 判断 → opt/data/work/src 会重新出现即红。
  const phrases = extractKeyPhrases('/opt/data/work/dsh-companion/src/index.js');
  for (const noise of ['opt', 'data', 'work', 'src']) {
    assert.ok(!phrases.some((phrase) => phrase.toLowerCase() === noise), noise + ' 不应成为关键串：' + JSON.stringify(phrases));
  }
  assert.ok(phrases.includes('dsh-companion'), '项目名应保留：' + JSON.stringify(phrases));
});

test('L5（v0.7.18 非真机证据）：超长 CJK 整句不整体入索引，按虚词切分', () => {
  // 判别力：把 CJK 分支改回整体 push → 整句会出现在结果里即红。
  const sentence = '后台任务在云端服务器上运行很好的';
  const phrases = extractKeyPhrases(sentence);
  assert.ok(!phrases.includes(sentence), '整句不应整体入索引：' + JSON.stringify(phrases));
  assert.ok(phrases.length > 0, '仍应切出有效短段：' + JSON.stringify(phrases));
  for (const phrase of phrases) {
    assert.ok(phrase.length <= 12, '切分后每段都应短于整句：' + phrase);
  }
});

test('L5（v0.7.18 非真机证据）：短有效锚点与既有版本/日期 gate 不变', () => {
  // 防「顺手提高 MIN_LENGTH」误杀 dsh / QQ 这类短实体；版本号/日期仍被 gate 挡住。
  const phrases = extractKeyPhrases('dsh 和 QQ 都在 50041 上跑，升级到 24.3.1，2026-11-24 10:30 上线');
  for (const keep of ['dsh', 'QQ']) {
    assert.ok(phrases.includes(keep), keep + ' 应仍可入索引：' + JSON.stringify(phrases));
  }
  assert.ok(!phrases.includes('24.3.1'), '纯版本号仍被 gate 挡住');
  assert.ok(!phrases.some((phrase) => /^\d{4}-\d{2}-\d{2}$/u.test(phrase)), '纯日期仍被 gate 挡住');
});

// ------------------------------------------------------ L5（裁决计数）

function makeJudgeWriter(store, options = {}) {
  let now = options.now ?? NOW_MS;
  const calls = [];
  const write = createTools({
    store,
    retrieve: () => ({ ok: true, items: [] }),
    platform: { log: () => {}, now: () => now, capabilities: {} },
    clock: () => now,
    timeZone: 'UTC',
    currentScope: () => 'main',
    judge: async (prompt) => {
      calls.push(prompt);
      return JSON.stringify({ items: [{ index: 1, verdict: 'new' }] });
    },
    dedupe: { dedupeSkip: 0.99, dedupeAsk: 0.1 },
    ...options.extra,
  }).find((tool) => tool.name === 'memory_write');
  return { write, calls, advance: (ms) => { now += ms; } };
}

function judgeMeta(store) {
  const raw = store.getMeta('dedupe_judge:main');
  return raw === null ? null : JSON.parse(raw);
}

test('L5（v0.7.18 非真机证据）：ask 档每次裁决 +1，skip/new 不计', async (t) => {
  const store = openStore(t);
  addFact(store, { statement: '青柠计划的代号是蓝鲸。' });
  const { write, calls } = makeJudgeWriter(store);

  assert.equal(judgeMeta(store), null, '初始没有计数键');

  const sameKind = { kind: 'preference', salience: 'normal', privacy: 'normal' };
  const first = await write.execute({ ...sameKind, statement: '青柠计划的代号是白鲸。' });
  assert.equal(first.ok, true);
  assert.equal(judgeMeta(store).count, 1);
  assert.equal(calls.length, 1);

  const second = await write.execute({ ...sameKind, statement: '青柠计划的代号是灰鲸。' });
  assert.equal(second.ok, true);
  assert.equal(judgeMeta(store).count, 2);

  // skip：同句高相似直接强化，不发 judge、不计数。
  await write.execute({ ...sameKind, statement: '青柠计划的代号是蓝鲸。' });
  assert.equal(calls.length, 2, 'skip 不应触发 judge');
  assert.equal(judgeMeta(store).count, 2);

  // new：完全无关的句子不触发 judge、不计数。
  await write.execute({ ...sameKind, statement: '周末去修自行车链条。' });
  assert.equal(calls.length, 2);
  assert.equal(judgeMeta(store).count, 2);
});

test('L5（v0.7.18 非真机证据）：跨日从 1 重新计数（坏数据也按新一天重置）', async (t) => {
  const store = openStore(t);
  addFact(store, { statement: '青柠计划的代号是蓝鲸。' });
  const { write, advance } = makeJudgeWriter(store);

  // 每次换一句：同一句第二次写会走 skip（高 Jaccard），不触发 judge。
  const statements = ['青柠计划的代号是白鲸。', '青柠计划的代号是灰鲸。', '青柠计划的代号是红鲸。', '青柠计划的代号是金鲸。'];
  const base = { kind: 'preference', salience: 'normal', privacy: 'normal' };
  await write.execute({ ...base, statement: statements[0] });
  await write.execute({ ...base, statement: statements[1] });
  assert.equal(judgeMeta(store).count, 2);

  advance(24 * 3600 * 1000);
  await write.execute({ ...base, statement: statements[2] });
  assert.equal(judgeMeta(store).count, 1, '跨日后应重置为 1');

  // 坏数据防御：非 JSON 都不抛错，按新一天从 1 记。
  store.setMeta('dedupe_judge:main', 'not-json');
  await write.execute({ ...base, statement: statements[3] });
  assert.equal(judgeMeta(store).count, 1);
});

// ------------------------------------------------------ L5（/状态 省行与接线）

test('L5（v0.7.18 非真机证据）：0 计数省行，非零才多一行', (t) => {
  const store = openStore(t);
  const base = handleCommand({ text: '/状态', store, now: NOW_MS, timeZone: 'UTC' }).reply;
  assert.doesNotMatch(base, /查重裁决/u, '未接线/无计数时整行省略');

  const zero = handleCommand({ text: '/状态', store, now: NOW_MS, timeZone: 'UTC', dedupe: { count: 0 } }).reply;
  assert.doesNotMatch(zero, /查重裁决/u, 'count=0 也省行');

  const some = handleCommand({ text: '/状态', store, now: NOW_MS, timeZone: 'UTC', dedupe: { count: 3 } }).reply;
  assert.match(some, /查重裁决（今日）：3 次/u);
});

test('L5（v0.7.18 非真机证据）：生产接线把 dedupe_judge 计数接进 /状态', () => {
  // 判别力：删掉 src/index.js 的 dedupe 注入行（dedupeJudgeStatusOf）→ 本用例红。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0718-l5-'));
  const dbPath = join(dir, 'store.db');
  try {
    const seed = Store.open(dbPath);
    seed.setMeta('dedupe_judge:main', JSON.stringify({ date: '2026-11-25', count: 4 }));
    seed.close();

    const ctx = new FakeCtx({ now: NOW_MS });
    ctx.commands = {
      registrations: [],
      register(definition) { this.registrations.push(definition); return () => {}; },
    };
    ctx.tools = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
    applyCordis(strictCtx(ctx), { dbPath });

    const status = ctx.commands.registrations.find((entry) => entry.name === 'status');
    assert.ok(status, 'status 命令应已注册');
    const reply = status.handler({ rawInput: '' });
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /查重裁决（今日）：4 次/u);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上插件仍持有连接时删不掉，留给系统清理。
    }
  }
});
