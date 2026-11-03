/**
 * H3 会话分流：identity 路由 + 工具作用域 + thread_run 登记。
 *
 * 这些用例只依赖 Store / createTools / 假平台，不跑完整 pre-step；
 * 生产接线（main/thread/subagent pre-step）在 test/e2e/session-scope.test.js。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import * as registry from '../src/thread/registry.js';
import {
  MAIN_SESSION_META_KEY,
  classifySession,
  threadScope,
} from '../src/session/identity.js';

const NOW_MS = Date.UTC(2026, 11, 1, 4, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** @param {Store} store @param {object} [overrides] @returns {object} */
function addThread(store, overrides = {}) {
  return store.upsertThread({
    key: 't1',
    name: '研究',
    session_id: 'sess-thread',
    description: '线程：研究',
    last_active_at: NOW_SEC,
    status: 'active',
    ...overrides,
  });
}

/** @param {Store} store @param {object} [overrides] @returns {object} */
function addFact(store, overrides = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '蓝鲸',
    predicate: '是',
    object_text: '海洋哺乳动物',
    statement: '蓝鲸是海洋哺乳动物',
    source_kind: 'user_explicit',
    ...overrides,
  });
}

/**
 * @param {Store} store
 * @param {() => (string|null|undefined)} currentScope
 * @param {object} [platformOverrides]
 */
function makeTools(store, currentScope, platformOverrides = {}) {
  const searches = [];
  const retrieve = async (request) => {
    searches.push(request);
    return { items: [], tokens: 0, usedIds: [], truncated: false };
  };
  const platform = {
    created: [],
    prompted: [],
    unarchived: [],
    async createSession(request) {
      this.created.push(request);
      return { sessionId: 'sess-created', agent: { id: 'sess-created' } };
    },
    async prompt(request) {
      this.prompted.push(request);
      return { ok: true };
    },
    async unarchiveSession(sessionId) {
      this.unarchived.push(sessionId);
      return { ok: true };
    },
    ...platformOverrides,
  };
  const tools = createTools({
    store,
    retrieve,
    registry,
    platform,
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-thread',
    currentScope,
  });
  return { tools, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])), searches, platform };
}

test('classifySession：origin=subagent 优先识别，不落记忆作用域', () => {
  const store = Store.open(':memory:');
  try {
    const agent = {
      id: 'sub-1',
      session: {
        id: 'sub-1',
        header: { origin: 'subagent', parentSession: 'main-1', delegationDepth: 1 },
      },
    };
    const identity = classifySession(agent, { store });
    assert.equal(identity.kind, 'subagent');
    assert.equal(identity.scope, null);
    assert.equal(identity.sessionId, 'sub-1');
    assert.equal(store.getMeta(MAIN_SESSION_META_KEY), null, 'subagent 不得占用 main_session_id');
  } finally {
    store.close();
  }
});

test('classifySession：threads.session_id 命中返回 thread scope，且先于默认 main', () => {
  const store = Store.open(':memory:');
  try {
    addThread(store, { key: 'alpha', session_id: 'sess-alpha' });
    const agent = { id: 'sess-alpha', session: { id: 'sess-alpha', header: { version: 4 } } };
    const identity = classifySession(agent, { store });
    assert.deepEqual(identity, {
      kind: 'thread',
      scope: threadScope('alpha'),
      sessionId: 'sess-alpha',
      key: 'alpha',
    });
    assert.equal(store.getMeta(MAIN_SESSION_META_KEY), null);
  } finally {
    store.close();
  }
});

test('classifySession：首个 main 持久化 main_session_id，重载后沿用；未知 main 只告警', () => {
  const store = Store.open(':memory:');
  try {
    const logs = [];
    const logger = (level, message, meta) => logs.push({ level, message, meta });
    const first = classifySession(
      { id: 'main-1', session: { id: 'main-1', header: { version: 4 } } },
      { store, logger },
    );
    assert.equal(first.kind, 'main');
    assert.equal(first.scope, 'main');
    assert.equal(store.getMeta(MAIN_SESSION_META_KEY), 'main-1');
    assert.equal(first.firstMain, true);

    const again = classifySession(
      { id: 'main-1', session: { id: 'main-1', header: { version: 4 } } },
      { store, logger },
    );
    assert.equal(again.kind, 'main');
    assert.equal(again.firstMain, true);

    const other = classifySession(
      { id: 'main-2', session: { id: 'main-2', header: { version: 4 } } },
      { store, logger },
    );
    assert.equal(other.kind, 'main');
    assert.equal(other.scope, 'main');
    assert.equal(other.unknownMain, true);
    assert.equal(store.getMeta(MAIN_SESSION_META_KEY), 'main-1');
    assert.ok(logs.some((row) => row.level === 'warn' && /main_session_id|main session/iu.test(row.message)));
  } finally {
    store.close();
  }
});

test('Store：threads.session_id 唯一 + getThreadBySessionId', () => {
  const store = Store.open(':memory:');
  try {
    addThread(store, { key: 'one', session_id: 'same-session' });
    assert.equal(store.getThreadBySessionId('same-session').key, 'one');
    assert.equal(store.getThreadBySessionId('missing'), null);
    assert.throws(
      () => addThread(store, { key: 'two', session_id: 'same-session' }),
      /UNIQUE|constraint/iu,
    );
  } finally {
    store.close();
  }
});

test('工具作用域：thread 默认写自己的 scope，显式 main 被拒绝；main 可显式 main', async () => {
  const store = Store.open(':memory:');
  try {
    addThread(store, { key: 't1', session_id: 'sess-thread' });
    const { byName, searches } = makeTools(store, () => threadScope('t1'));

    const written = byName.memory_write.execute({ statement: '线程里的偏好' });
    assert.equal(written.ok, true);
    assert.equal(written.scope, threadScope('t1'));
    assert.equal(store.listFacts({ scope: threadScope('t1') }).length, 1);

    const denied = byName.memory_write.execute({ statement: '越界', scope: 'main' });
    assert.deepEqual(denied, { ok: false, reason: 'scope_denied', scope: 'main' });

    const searched = await byName.memory_search.execute({ query: '偏好' });
    assert.deepEqual(searched.items, []);
    assert.equal(searches.at(-1).scope, threadScope('t1'));
    assert.deepEqual(
      await byName.memory_search.execute({ query: '偏好', scope: 'main' }),
      { ok: false, reason: 'scope_denied', scope: 'main' },
    );
  } finally {
    store.close();
  }
});

test('工具作用域：subagent（currentScope=null）拒绝记忆读写与遗忘', async () => {
  const store = Store.open(':memory:');
  try {
    const fact = addFact(store);
    const { byName } = makeTools(store, () => null);
    assert.deepEqual(
      await byName.memory_search.execute({ query: '蓝鲸' }),
      { ok: false, reason: 'scope_denied', scope: null },
    );
    assert.deepEqual(
      byName.memory_write.execute({ statement: '子会话不该记住' }),
      { ok: false, reason: 'scope_denied', scope: null },
    );
    assert.deepEqual(
      await byName.memory_forget.execute({ id: fact.id }),
      { ok: false, reason: 'scope_denied', scope: null },
    );
    assert.equal(store.listFacts({ scope: 'main' }).length, 1);
  } finally {
    store.close();
  }
});

test('工具作用域：memory_forget 不能跨 scope 删除别人的事实', async () => {
  const store = Store.open(':memory:');
  try {
    const mainFact = addFact(store, { statement: '主会话的私事' });
    addThread(store, { key: 't1', session_id: 'sess-thread' });
    const { byName } = makeTools(store, () => threadScope('t1'));
    const result = await byName.memory_forget.execute({ id: mainFact.id });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'scope_denied');
    assert.equal(store.getFact(mainFact.id).deleted_at, null);
  } finally {
    store.close();
  }
});

test('thread_run：createSession 成功后把 session_id 写回 threads 行，并可按 session 反查 scope', async () => {
  const store = Store.open(':memory:');
  try {
    const { byName, platform } = makeTools(store, () => 'main');
    const result = await byName.thread_run.execute({ key: 'new', name: '研究', goal: '查资料' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    assert.equal(result.sessionId, 'sess-created');
    assert.equal(platform.created[0].agentPreset, 'companion-thread');
    const row = store.getThread(result.key);
    assert.equal(row.session_id, 'sess-created');
    assert.equal(row.status, 'active');
    const identity = classifySession(
      { id: 'sess-created', session: { id: 'sess-created', header: { version: 4 } } },
      { store },
    );
    assert.equal(identity.kind, 'thread');
    assert.equal(identity.scope, threadScope(result.key));
  } finally {
    store.close();
  }
});

test('thread_run：归档线程复用会 unarchive，session_id 与 thread scope 保持不变', async () => {
  const store = Store.open(':memory:');
  try {
    addThread(store, { key: 'arch', session_id: 'sess-arch', status: 'archived' });
    const { byName, platform } = makeTools(store, () => 'main');
    const result = await byName.thread_run.execute({ key: 'arch' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reuse');
    assert.equal(result.reactivated, true);
    assert.deepEqual(platform.unarchived, ['sess-arch']);
    const row = store.getThread('arch');
    assert.equal(row.status, 'active');
    assert.equal(row.session_id, 'sess-arch');
    const identity = classifySession(
      { id: 'sess-arch', session: { id: 'sess-arch', header: { version: 4 } } },
      { store },
    );
    assert.equal(identity.kind, 'thread');
    assert.equal(identity.scope, threadScope('arch'));
  } finally {
    store.close();
  }
});
