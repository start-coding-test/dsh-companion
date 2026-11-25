/**
 * T2（v0.7.19）：召回作用域按 `source_kind` 放行——用户亲口的事实全线程可见，
 * 线程学到的事实留在线程。
 *
 * 口径（用户 m00023）：
 *   1) 线程召回 main：放行条件 = kind ∈ identity/preference **或** source_kind='user_explicit'；
 *   2) 主会话召回线程 scope：只取 source_kind='user_explicit' 的行，其余留在本线程。
 *
 * 接线（本文件刻意走真实路径 `recallScopes` → `retrieve`，不手搓 scope 对象）：
 *   - `src/index.js` `recallScopes` main 分支返回 `threadScopes` + `threadFactSourceKinds:['user_explicit']`，
 *     线程分支返回 `threadFactSourceKinds:null`；
 *   - `src/memory/retrieve.js` `scopeAllows(type,rowScope,rowKind,rowSourceKind)` 的两层判定；
 *   - `src/memory/store.js` `searchBigram` fact 投影列补 `f.source_kind`（词法 df 统计路径）。
 *
 * ⚠️ 非真机证据：事实行全部构造，宿主子代理与模型调用不参与；只证明接线与放行口径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { recallScopes } from '../src/index.js';

const NOW = 1_790_000_000; // 固定时钟（秒）
const NOW_MS = NOW * 1000;

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function seedFact(store, input) {
  return store.insertFact({
    source_kind: 'turn',
    salience: 'normal',
    observed_at: NOW,
    last_reinforced_at: NOW,
    ...input,
  });
}

test('T2-①（v0.7.19 非真机证据）：线程召回 main，user_explicit 但 kind 非 identity/preference 的事实可见', async (t) => {
  // 判别力：删掉 src/memory/retrieve.js `scopeAllows` 末行的
  // `|| rowSourceKind === 'user_explicit'` → 本用例的 explicit 断言红。
  const store = openStore(t);
  store.upsertThread({ key: 'deploy', name: '部署', description: '部署线程', session_id: 'sess-deploy', status: 'active' });
  seedFact(store, {
    scope: 'main', kind: 'project', source_kind: 'user_explicit',
    subject_text: '结账日', predicate: '定在', object_text: '每周五',
    statement: '用户亲口说结账日固定在每周五。',
  });
  seedFact(store, {
    scope: 'main', kind: 'project', source_kind: 'consolidated',
    subject_text: '发布窗口', predicate: '定在', object_text: '周四晚',
    statement: '巩固记录：发布窗口定在周四晚。',
  });
  seedFact(store, {
    scope: 'main', kind: 'identity', source_kind: 'consolidated',
    subject_text: '用户称呼', predicate: '称呼', object_text: '老板',
    statement: '用户希望被称呼为老板。',
  });

  const scopes = recallScopes(store, 'thread:deploy');
  assert.equal(scopes.threadFactSourceKinds, null, '线程分支不得限制本线程可读的 source_kind');

  const explicit = await retrieve({ store, scope: 'thread:deploy', query: '结账日 每周五', now: NOW_MS, ...scopes });
  assert.ok(
    explicit.items.some((item) => /结账日/u.test(item.text)),
    'main 的 user_explicit 事实（kind=project）应进线程召回',
  );

  const consolidated = await retrieve({ store, scope: 'thread:deploy', query: '发布窗口 周四晚', now: NOW_MS, ...scopes });
  assert.deepEqual(consolidated.items, [], 'main 的 consolidated 事实（kind=project）留在主会话');

  const identity = await retrieve({ store, scope: 'thread:deploy', query: '称呼 老板', now: NOW_MS, ...scopes });
  assert.ok(
    identity.items.some((item) => /老板/u.test(item.text)),
    'kind ∈ identity/preference 的旧通道仍放行（即使 source_kind 不是 user_explicit）',
  );
});

test('T2-②（v0.7.19 非真机证据）：主会话召回线程 scope 只取 user_explicit，consolidated 留在线程', async (t) => {
  // 判别力：删掉 src/memory/retrieve.js `scopeAllows` 里
  // `if (threadFactSourceKindSet.size > 0 && threadScopeSet.has(rowScope)) {...}`
  // 这段早退 → 本用例的 learned 断言红（consolidated 线程事实漏进主会话）。
  const store = openStore(t);
  store.upsertThread({ key: 'deploy', name: '部署', description: '部署线程', session_id: 'sess-deploy', status: 'active' });
  seedFact(store, {
    scope: 'thread:deploy', kind: 'project', source_kind: 'user_explicit',
    subject_text: 'flux', predicate: '训练用数据集', object_text: 'flux 数据集',
    statement: '用户亲口指定 flux 数据集做训练集。',
  });
  seedFact(store, {
    scope: 'thread:deploy', kind: 'project', source_kind: 'consolidated',
    subject_text: 'flux 缓存', predicate: '位于', object_text: '本地磁盘',
    statement: '线程巩固：flux 缓存落在本地磁盘第三分区。',
  });

  const scopes = recallScopes(store, 'main');
  assert.deepEqual(scopes.threadFactSourceKinds, ['user_explicit'], '主会话召回线程 facts 只放用户亲口的事实');
  assert.deepEqual(scopes.threadScopes, ['thread:deploy']);

  const explicit = await retrieve({ store, scope: 'main', query: 'flux 数据集', now: NOW_MS, ...scopes });
  assert.ok(
    explicit.items.some((item) => /flux 数据集/u.test(item.text)),
    '线程里 user_explicit 的事实应回主会话',
  );

  const learned = await retrieve({ store, scope: 'main', query: 'flux 缓存 本地磁盘', now: NOW_MS, ...scopes });
  assert.deepEqual(learned.items, [], '线程自己巩固出的 consolidated 事实不得进主会话');

  // 线程本会话仍能读到自己的 consolidated 事实（不能把线程自己的记忆也锁掉）。
  const own = await retrieve({
    store,
    scope: 'thread:deploy',
    query: 'flux 缓存 本地磁盘',
    now: NOW_MS,
    ...recallScopes(store, 'thread:deploy'),
  });
  assert.ok(
    own.items.some((item) => /flux 缓存/u.test(item.text)),
    '线程必须能读本线程 scope 的全部 facts',
  );
});
