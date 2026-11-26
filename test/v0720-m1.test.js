/**
 * v0.7.20 M1：旧线程 description 不再被当职责注入。
 *
 * 证据范围（非真机）：
 * - 只有「本次显式给了 charter」或「历史上设过 charter（`schema_meta` 键
 *   `thread_charter_set:<key>` = '1'）」才在投递文本前拼「线程职责：…」行。
 * - 未设过 charter 的线程（存量线程的 description 是当年第一条 goal）投递文本
 *   逐字回到 v0.7.18：续派 `[{type:'text',text:goal}]`，prompt/prompt 同口径。
 * - 零 DDL：标记只写 `schema_meta`，不动表结构。
 *
 * 全部直连 `createTools()` 的 execute；不依赖真实宿主。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import * as registry from '../src/thread/registry.js';

const NOW_MS = Date.UTC(2026, 11, 26, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

const AGENT = Object.freeze({ id: 'main-agent' });

/** 等回执的 `.then()` 微任务落地（不阻塞、不依赖时钟前进）。 */
async function flushReceipts() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 子代理能力齐全的假平台：startSubagent 返回 childId + 已完成的 result，
 * 续派走 sendToSubagent；`sendThrows` 可模拟目标已不可恢复（触发重建）。
 */
function makeSubagentHarness(options = {}) {
  const store = Store.open(':memory:');
  const calls = { started: [], sent: [], prompted: [] };
  const platform = {
    capabilities: {
      subagents: true,
      subagentMessages: true,
      tools: true,
    },
    calls,
    log() {},
    async startSubagent(spec) {
      calls.started.push(spec);
      const index = calls.started.length;
      return {
        childId: `child-${index}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: `第 ${index} 次完成` }],
          stopReason: 'completed',
        }),
      };
    },
    async sendToSubagent(sender, targetId, content, sendOptions) {
      if (options.sendThrows !== undefined) throw options.sendThrows;
      calls.sent.push({ sender, targetId, content, sendOptions });
      return { ok: true };
    },
    async prompt(request) {
      calls.prompted.push(request);
      return { ok: true };
    },
    async unarchiveSession() {
      return { ok: true };
    },
  };
  const tools = createTools({
    store,
    platform,
    registry,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-v0720-m1',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, tools, byName };
}

/** 没有子代理能力、只有 createSession/prompt 的旧平台（无锚复用路径）。 */
function makeLegacyHarness() {
  const store = Store.open(':memory:');
  const calls = { prompted: [], created: [] };
  const platform = {
    capabilities: {},
    calls,
    log() {},
    async createSession(request) {
      calls.created.push(request);
      return { sessionId: `sess-${calls.created.length}`, agent: { id: `sess-${calls.created.length}` } };
    },
    async prompt(request) {
      calls.prompted.push(request);
      return { ok: true };
    },
  };
  const tools = createTools({
    store,
    platform,
    registry,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-v0720-m1',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, tools, byName };
}

/** 一条存量线程：description 是当年第一条 goal，没有任何 charter 标记。 */
function seedStockThread(store, extra = {}) {
  return store.upsertThread({
    key: 'rent',
    name: '租房',
    session_id: 's-old',
    description: '帮我找两居室',
    status: 'active',
    last_active_at: NOW_SEC - 86400,
    ...extra,
  });
}

// ------------------------------------------------------------ 存量线程（无 charter）

test('M1-001（v0.7.20 非真机证据）：存量线程有锚续派不再注入「线程职责」行，文本逐字回到 v0.7.18', async () => {
  // 判别力：删掉 src/runtime/tools.js 续派 sendToSubagent 的 `withCharter ?` 判断
  // （恢复无条件拼 `线程职责：${description}\n`）→ 本用例红。
  const harness = makeSubagentHarness();
  try {
    seedStockThread(harness.store, { child_session_id: 's-old' });
    const reused = await harness.byName.thread_run.execute(
      { key: 'rent', goal: '再查一次' },
      { agent: AGENT },
    );

    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.equal(harness.platform.calls.sent.length, 1);
    // v0.7.18 原文：纯 goal，不带职责行。
    assert.deepEqual(harness.platform.calls.sent[0].content, [{ type: 'text', text: '再查一次' }]);
    assert.equal(
      JSON.stringify(harness.platform.calls.sent[0].content).includes('线程职责'),
      false,
      '旧 goal 不得被当成职责注入',
    );
    // description 列内容不变（仍是旧 goal），只是不再注入。
    assert.equal(harness.store.getThread('rent').description, '帮我找两居室');
  } finally {
    harness.store.close();
  }
});

test('M1-002（v0.7.20 非真机证据）：存量线程无锚复用（旧 prompt 路径）同样不带职责行', async () => {
  // 判别力：删掉 src/runtime/tools.js 无锚复用 platform.prompt 的 `withCharter ?`
  // 判断 → 本用例红（会多出「线程职责：帮我找两居室\n」）。
  const harness = makeLegacyHarness();
  try {
    seedStockThread(harness.store);
    const reused = await harness.byName.thread_run.execute({ key: 'rent', goal: '继续找房' });

    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.deepEqual(harness.platform.calls.prompted[0].content, [{ type: 'text', text: '继续找房' }]);
    assert.equal(harness.store.getThread('rent').description, '帮我找两居室');
  } finally {
    harness.store.close();
  }
});

// ------------------------------------------------------------ 显式设 charter

test('M1-003（v0.7.20 非真机证据）：设 charter 新建（startSubagent 路径）带职责行并写标记', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 markThreadCharterSet 调用 → 标记断言红；
  // 删掉 createThreadSession prompt 的 `withCharter ?` → 职责行断言红。
  const harness = makeSubagentHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '预算',
      goal: '查预算',
      charter: '负责跟踪预算与报销',
    }, { agent: AGENT });

    assert.equal(result.ok, true);
    const [spec] = harness.platform.calls.started;
    assert.deepEqual(spec.prompt, [{
      type: 'text',
      text: '线程职责：负责跟踪预算与报销\n查预算',
    }]);
    assert.equal(harness.store.getMeta(`thread_charter_set:${result.key}`), '1');
    assert.equal(harness.store.getThread(result.key).description, '负责跟踪预算与报销');
  } finally {
    harness.store.close();
  }
});

test('M1-004（v0.7.20 非真机证据）：设 charter 新建（无子代理 prompt 路径）带职责行并写标记', async () => {
  // 判别力：删掉 src/runtime/tools.js 新建无子代理分支的 `withCharter ?` 或
  // markThreadCharterSet 调用 → 本用例红。
  const harness = makeLegacyHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '登录',
      goal: '实现登录',
      charter: '负责登录模块',
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    assert.deepEqual(harness.platform.calls.prompted[0].content, [{
      type: 'text',
      text: '线程职责：负责登录模块\n实现登录',
    }]);
    assert.equal(harness.store.getMeta(`thread_charter_set:${result.key}`), '1');
  } finally {
    harness.store.close();
  }
});

test('M1-005（v0.7.20 非真机证据）：设过 charter 的线程后续派（不传 charter）仍带职责行', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 threadCharterActive（只认本次 charter）
  // → 标记读取失效，本用例红。
  const harness = makeSubagentHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '预算',
      goal: '查预算',
      charter: '负责跟踪预算与报销',
    }, { agent: AGENT });
    assert.equal(harness.platform.calls.sent.length, 0);

    const reused = await harness.byName.thread_run.execute({
      key: created.key,
      goal: '再查一次',
    }, { agent: AGENT });

    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.deepEqual(harness.platform.calls.sent[0].content, [{
      type: 'text',
      text: '线程职责：负责跟踪预算与报销\n再查一次',
    }]);
  } finally {
    harness.store.close();
  }
});

test('M1-006（v0.7.20 非真机证据）：设过 charter 的线程无锚复用（旧 prompt 路径）也读标记注入', async () => {
  // 判别力：删掉无锚复用 platform.prompt 的 `withCharter ?` 或 threadCharterActive
  // → 本用例红（会退化成纯 goal）。
  const harness = makeLegacyHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '部署',
      goal: '开始',
      charter: '长期维护部署与回滚',
    });
    const reused = await harness.byName.thread_run.execute({
      key: created.key,
      goal: '继续',
    });

    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.deepEqual(harness.platform.calls.prompted[1].content, [{
      type: 'text',
      text: '线程职责：长期维护部署与回滚\n继续',
    }]);
  } finally {
    harness.store.close();
  }
});

// ------------------------------------------------------------ 安全点

test('M1-007（v0.7.20 非真机证据）：charter 超限被拒时不写标记，后续派仍是 v0.7.18 文本', async () => {
  // 判别力：把 markThreadCharterSet 提到长度校验之前（或删掉 charter_too_long 分支）
  // → 标记被写上，后续派多出「线程职责」行，本用例红。
  const harness = makeSubagentHarness();
  try {
    seedStockThread(harness.store, { child_session_id: 's-old' });
    const rejected = await harness.byName.thread_run.execute({
      key: 'rent',
      goal: '做事',
      charter: '长'.repeat(301),
    }, { agent: AGENT });
    assert.deepEqual(rejected, { ok: false, reason: 'charter_too_long' });
    assert.equal(harness.store.getMeta('thread_charter_set:rent'), null);

    const reused = await harness.byName.thread_run.execute(
      { key: 'rent', goal: '再查一次' },
      { agent: AGENT },
    );
    assert.deepEqual(harness.platform.calls.sent[0].content, [{ type: 'text', text: '再查一次' }]);
    assert.equal(harness.store.getThread('rent').description, '帮我找两居室');
  } finally {
    harness.store.close();
  }
});

test('M1-008（v0.7.20 非真机证据）：设 charter 的续派失败重建，重建首条 prompt 仍带职责行', async () => {
  // 判别力：让 createThreadSession 不认 schema_meta 标记（threadCharterActive 直接
  // 返回 false，或删掉 existingThread 读取）→ 重建这条调用不带 charter，职责行只能靠
  // 标记+库存 description 拿到，本用例红。实测：把 withCharter 改成「只读标记」并
  // 把写入移到 startSubagent 之后，本用例仍绿（初始 create 已在返回前写好标记，且
  // description 已存 charter）——故本用例锁的是「重建复用标记与库存 description」，
  // 不是写入顺序。
  const harness = makeSubagentHarness({
    sendThrows: Object.assign(new Error('subagent not found'), { code: 'UNAVAILABLE' }),
  });
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '复盘',
      goal: '开始',
      charter: '负责复盘与归因',
    }, { agent: AGENT });
    const rebuilt = await harness.byName.thread_run.execute({
      key: created.key,
      goal: '继续',
    }, { agent: AGENT });

    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.rebuilt, true);
    const specs = harness.platform.calls.started;
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[1].prompt, [{
      type: 'text',
      text: '线程职责：负责复盘与归因\n继续',
    }]);
    assert.equal(harness.store.getMeta(`thread_charter_set:${created.key}`), '1');
  } finally {
    harness.store.close();
  }
});
