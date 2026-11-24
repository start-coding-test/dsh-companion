/**
 * v0.7.17 M1：memory_write 的近似查重（skip/ask/new）、judge 裁决、跨 kind 关键串
 * 升级、pinned 三处设防，以及生产接线（apply → registerTools → judge）。
 *
 * 全部为「非真机证据」：judge / LLM / platform 都是替身；真实小模型裁决质量与
 * 生产宿主路由属云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { consolidate } from '../src/memory/consolidate.js';
import { extractKeyPhrases } from '../src/memory/dedupe.js';
import { apply, editMemoryFact } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';

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

function makeTools(store, extra = {}) {
  const logs = [];
  const platform = {
    log: (level, message, meta) => logs.push({ level, message, meta }),
    now: () => NOW_MS,
    capabilities: {},
  };
  const tools = createTools({
    store,
    retrieve: () => ({ ok: true, items: [] }),
    platform,
    clock: () => NOW_MS,
    timeZone: 'UTC',
    currentScope: () => 'main',
    ...extra,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { byName, logs };
}

const judgeOf = (verdict) => {
  const calls = [];
  const judge = async (prompt) => {
    calls.push(prompt);
    return JSON.stringify({ items: [{ index: 1, verdict }] });
  };
  judge.calls = calls;
  return judge;
};

const activeCount = (store) => store.listFacts({ scope: 'main', status: 'active' }).length;

// ---------------------------------------------------------------- skip 档

test('M1 skip：同 kind 高相似只强化旧条，零新行、last_reinforced_at 前进（非真机证据）', async (t) => {
  const store = openStore(t);
  const existing = addFact(store, { statement: '我每天早上喝咖啡' });
  const { byName } = makeTools(store);

  const result = await byName.memory_write.execute({ kind: 'preference', statement: '我每天早上喝咖啡' });

  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'reinforced');
  assert.equal(result.duplicateOf, existing.id);
  assert.equal(result.id, existing.id);
  assert.equal(activeCount(store), 1, '不应新写一行');
  assert.equal(store.getFact(existing.id).last_reinforced_at, NOW_SEC);
});

// ---------------------------------------------------------------- ask 档

test('M1 ask + judge same：强化旧条且 judge 收到双方原文（非真机证据）', async (t) => {
  const store = openStore(t);
  const existing = addFact(store, { statement: '我每天早上喝咖啡' });
  const judge = judgeOf('same');
  const { byName } = makeTools(store, { judge });

  const result = await byName.memory_write.execute({ kind: 'preference', statement: '我每天早上都喝咖啡' });

  assert.equal(result.verdict, 'reinforced');
  assert.equal(result.duplicateOf, existing.id);
  assert.equal(activeCount(store), 1);
  assert.equal(judge.calls.length, 1);
  assert.match(judge.calls[0], /我每天早上喝咖啡/u);
  assert.match(judge.calls[0], /我每天早上都喝咖啡/u);
});

test('M1 ask + judge update：旧条 superseded、新条 active（非真机证据）', async (t) => {
  const store = openStore(t);
  const existing = addFact(store, { statement: '每周五交周报给组长' });
  const { byName } = makeTools(store, { judge: judgeOf('update') });

  const result = await byName.memory_write.execute({ kind: 'preference', statement: '每周五交周报' });

  assert.equal(result.verdict, 'updated');
  assert.equal(result.duplicateOf, existing.id);
  assert.notEqual(result.id, existing.id);
  const old = store.getFact(existing.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by, result.id);
  assert.equal(store.getFact(result.id).status, 'active');
});

test('M1 ask + judge new：两条都留（非真机证据）', async (t) => {
  const store = openStore(t);
  addFact(store, { statement: '每周五交周报给组长' });
  const { byName } = makeTools(store, { judge: judgeOf('new') });

  const result = await byName.memory_write.execute({ kind: 'preference', statement: '每周五交周报' });

  assert.equal(result.verdict, 'inserted');
  assert.equal(result.duplicateOf, null);
  assert.equal(activeCount(store), 2);
});

test('M1 judge 抛错 / 返回坏 JSON / 未注入：一律按 new 保守插入，不丢写入（非真机证据）', async (t) => {
  const store = openStore(t);
  addFact(store, { statement: '每周五交周报给组长' });

  const throwing = makeTools(store, {
    judge: async () => {
      throw new Error('judge down');
    },
  });
  const thrown = await throwing.byName.memory_write.execute({ kind: 'preference', statement: '每周五交周报' });
  assert.equal(thrown.verdict, 'inserted');
  assert.equal(activeCount(store), 2);

  const garbage = makeTools(store, { judge: async () => 'not-json' });
  const garbled = await garbage.byName.memory_write.execute({ kind: 'preference', statement: '每周五要交周报' });
  assert.equal(garbled.verdict, 'inserted');

  const missing = makeTools(store);
  const absent = await missing.byName.memory_write.execute({ kind: 'preference', statement: '每周五交周报给主管' });
  assert.equal(absent.verdict, 'inserted');
  assert.equal(activeCount(store), 4);
});

// ------------------------------------------------- 跨 kind 关键串升级

test('M1 关键串跨 kind 升级 ask：同项目名不同 kind 也进 judge（非真机证据）', async (t) => {
  const store = openStore(t);
  const existing = addFact(store, {
    kind: 'project',
    statement: 'dsh-companion 用 Node 跑服务',
  });
  const judge = judgeOf('same');
  const { byName } = makeTools(store, { judge });

  const result = await byName.memory_write.execute({
    kind: 'preference',
    statement: 'dsh-companion 配了 ubuntu 用户',
  });

  assert.equal(judge.calls.length, 1, '关键串命中应升级为 ask');
  assert.equal(result.verdict, 'reinforced');
  assert.equal(result.duplicateOf, existing.id);
});

test('M1 关键串只扩大 ask、永不触发 skip：跨 kind 同句仍可被判 new（非真机证据）', async (t) => {
  const store = openStore(t);
  addFact(store, { kind: 'project', statement: '我每天早上喝咖啡' });
  const judge = judgeOf('new');
  const { byName } = makeTools(store, { judge });

  const result = await byName.memory_write.execute({
    kind: 'preference',
    statement: '我每天早上喝咖啡',
  });

  assert.equal(judge.calls.length, 1, '跨 kind 必须走 judge 而不是直接 skip');
  assert.equal(result.verdict, 'inserted');
  assert.equal(activeCount(store), 2);
});

test('M1 关键串：纯版本号 / 纯日期时间不入索引（非真机证据）', () => {
  const phrases = extractKeyPhrases('升级到 24.3.1，2026-11-24 10:30 上线');
  assert.ok(!phrases.includes('24.3.1'), '纯版本号不应成为关键串');
  assert.ok(!phrases.includes('2026-11-24'), '纯日期不应成为关键串');
  assert.ok(!phrases.includes('10:30'), '纯时间不应成为关键串');
});

// ------------------------------------------------------------- pinned 设防

test('M1 pinned：memory_write 的 update 目标 pinned → 不 supersede，插新条 + warn（非真机证据）', async (t) => {
  const store = openStore(t);
  const pinned = addFact(store, { statement: '每周五交周报给组长', salience: 'pinned' });
  const { byName, logs } = makeTools(store, { judge: judgeOf('update') });

  const result = await byName.memory_write.execute({ kind: 'preference', statement: '每周五交周报' });

  assert.equal(result.verdict, 'inserted');
  assert.equal(result.duplicateOf, null);
  const old = store.getFact(pinned.id);
  assert.equal(old.status, 'active', 'pinned 不得被 superseded');
  assert.equal(old.superseded_by, null);
  assert.equal(store.getFact(result.id).status, 'active');
  assert.ok(logs.some((entry) => entry.level === 'warn' && String(entry.message).includes('pinned')));
});

test('M1 pinned：memory_update（editMemoryFact）拒绝改 pinned（非真机证据）', (t) => {
  const store = openStore(t);
  const pinned = addFact(store, { statement: '我每天早上喝咖啡', salience: 'pinned' });

  const result = editMemoryFact({ store, scope: 'main', id: pinned.id, statement: '我每天中午喝咖啡', now: NOW_MS });

  assert.deepEqual(result, {
    ok: false,
    reason: 'pinned',
    message: 'pinned 记忆不允许被 update 取代，请先显式改 salience',
  });
  assert.equal(store.getFact(pinned.id).statement, '我每天早上喝咖啡');
  assert.equal(activeCount(store), 1);
});

test('M1 pinned：巩固的 judge update 不会 supersede pinned 目标（非真机证据）', async (t) => {
  const store = openStore(t);
  const pinned = addFact(store, { statement: '每周五交周报给组长', salience: 'pinned' });
  const draft = {
    episode: {
      title: '周报安排',
      summary: '用户说每周五要交周报。',
      topics: ['周报'],
      started_at: NOW_SEC,
    },
    facts: [
      {
        kind: 'preference',
        subject_text: '我',
        predicate: '习惯',
        object_text: '交周报',
        statement: '每周五交周报',
      },
    ],
    reminders: [],
  };
  const llm = async () => draft;
  // 注意：consolidate 的 judge 契约是「返回已解析对象」（index.js 里
  // judgeFactDuplicates 返回 parseDraftJson 的结果），不是 JSON 文本。
  const judge = async () => ({ items: [{ index: 1, verdict: 'update' }] });

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 10,
    llm,
    judge,
    now: NOW_SEC,
  });

  assert.equal(result.superseded, 0, 'pinned 目标不应被 supersede');
  const old = store.getFact(pinned.id);
  assert.equal(old.status, 'active', 'pinned 目标必须保持 active');
  assert.equal(old.superseded_by, null);
  const active = store.listFacts({ scope: 'main', status: 'active' });
  assert.equal(active.length, 2, '新事实照常插入，只不做 supersede');
  assert.equal(store.getFact(pinned.id).statement, '每周五交周报给组长');
});

// --------------------------------------------------- 生产接线（判别力钉死）

test('M1 接线：真实 apply 的 memory_write 会调用生产 judge（删接线必红；非真机证据）', async (t) => {
  const ctx = new FakeCtx({ now: NOW_MS });
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      yield { type: 'text-delta', text: JSON.stringify({ items: [{ index: 1, verdict: 'same' }] }) };
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  const handle = apply(ctx, {
    dbPath: ':memory:',
    consolidation: { model: { provider: 'fake-provider', model: 'fake-model' } },
  });
  t.after(() => handle?.dispose?.());

  const write = ctx.tools.registrations.find((definition) => definition.name === 'memory_write');
  assert.ok(write, 'memory_write 必须已注册');

  const first = await write.execute({ kind: 'preference', statement: '我每天早上喝咖啡' });
  assert.equal(first.verdict, 'inserted');
  const second = await write.execute({ kind: 'preference', statement: '我每天早上都喝咖啡' });

  assert.equal(streams.length, 1, 'ask 档必须真的走生产 judge（LLM）一次');
  assert.equal(streams[0].purpose, 'companion-consolidate');
  assert.equal(second.duplicateOf, first.id, 'judge same → 强化第一条而不是新写');
  assert.equal(second.id, first.id, '强化不新写行');
});
