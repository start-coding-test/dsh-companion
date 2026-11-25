/**
 * v0.7.19 T4：线程常驻职责（charter）、重活交线程提示、投递历史。
 *
 * 证据范围（非真机）：
 * - T4.1：thread_run 的 charter 写/更新 `threads.description`，并在 4 个投递文本
 *   构造点前面带一行「线程职责：<description>」；charter >300 码点直接拒绝。
 * - T4.3：每个 thread_run 追加一条 `schema_meta` 滚动历史（键
 *   `thread_history:<key>`，最新在前、≤30 条），回执按 requestId 回填首句与终态。
 *
 * 全部直连 `createTools()` 的 execute 或真实 apply；不依赖真实宿主。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import * as registry from '../src/thread/registry.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';

const NOW_MS = Date.UTC(2026, 11, 3, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const NOW_ISO = new Date(NOW_MS).toISOString();

const THREAD_OFFLOAD_TEXT = '预计要读大文件、批量跑命令、抓网页或日志的活交 task_run / thread_run，主会话只收结论，不把原始输出贴回主会话。';

const AGENT = Object.freeze({ id: 'main-agent' });

/** 等回执的 `.then()` 微任务落地（不阻塞、不依赖时钟前进）。 */
async function flushReceipts() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 子代理能力齐全的假平台：startSubagent 返回 childId + 已完成的 result，
 * 续派走 sendToSubagent；两者都记录调用参数供断言。
 */
function makeSubagentHarness(options = {}) {
  const store = Store.open(':memory:');
  const calls = { started: [], sent: [], prompted: [], created: [] };
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
          output: [{ type: 'text', text: options.resultText ?? `第 ${index} 次完成` }],
          stopReason: 'completed',
        }),
      };
    },
    async sendToSubagent(sender, targetId, content, sendOptions) {
      calls.sent.push({ sender, targetId, content, sendOptions });
      return { ok: true };
    },
    async prompt(request) {
      calls.prompted.push(request);
      return { ok: true };
    },
    async createSession(request) {
      calls.created.push(request);
      return { sessionId: `sess-${calls.created.length}`, agent: { id: `sess-${calls.created.length}` } };
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
    cwd: '/tmp/dsh-companion-v0719-t4',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, tools, byName };
}

/** 没有子代理能力、只有 createSession/prompt 的旧平台（无 result 的投递路径）。 */
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
    cwd: '/tmp/dsh-companion-v0719-t4',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, tools, byName };
}

// ------------------------------------------------------------ T4.1 charter

test('T4-001（v0.7.19 非真机证据）：新建线程时 charter 写 description 并注入 startSubagent prompt', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 `charter ?? threadGoal`（description）
  // 或 startSubagent 的 `线程职责：${threadDescription}` 前缀 → 本用例红。
  const harness = makeSubagentHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '预算',
      goal: '查预算',
      charter: '负责跟踪预算与报销',
    }, { agent: AGENT });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    const [spec] = harness.platform.calls.started;
    assert.equal(spec.prompt.length, 1);
    assert.deepEqual(spec.prompt, [{
      type: 'text',
      text: '线程职责：负责跟踪预算与报销\n查预算',
    }]);
    assert.equal(harness.store.getThread(result.key).description, '负责跟踪预算与报销');
  } finally {
    harness.store.close();
  }
});

test('T4-002（v0.7.19 非真机证据）：续派 sendToSubagent 的投递文本带库里的线程职责', async () => {
  // 判别力：删掉 src/runtime/tools.js 续派 sendToSubagent 的 `线程职责：${description}`
  // 前缀（或复用路径的 description 取值）→ 本用例红。
  const harness = makeSubagentHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '预算',
      goal: '查预算',
      charter: '负责跟踪预算与报销',
    }, { agent: AGENT });

    const reused = await harness.byName.thread_run.execute({
      key: created.key,
      goal: '再查一次',
    }, { agent: AGENT });

    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.equal(harness.platform.calls.sent.length, 1);
    assert.deepEqual(harness.platform.calls.sent[0].content, [{
      type: 'text',
      text: '线程职责：负责跟踪预算与报销\n再查一次',
    }]);
  } finally {
    harness.store.close();
  }
});

test('T4-003（v0.7.19 非真机证据）：复用传 charter 覆盖 description，不传则保持原值', async () => {
  // 判别力：删掉 src/runtime/tools.js 复用分支的 `charterPatch`（或 description 覆盖）
  // → 本用例红。
  const harness = makeSubagentHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '部署',
      goal: '开始',
    }, { agent: AGENT });
    assert.equal(harness.store.getThread(created.key).description, '开始');

    await harness.byName.thread_run.execute({
      key: created.key,
      goal: '继续',
      charter: '长期维护部署与回滚',
    }, { agent: AGENT });
    assert.equal(harness.store.getThread(created.key).description, '长期维护部署与回滚');

    // 不传 charter：沿用库里的职责，不被 goal 覆写。
    await harness.byName.thread_run.execute({
      key: created.key,
      goal: '再继续',
    }, { agent: AGENT });
    assert.equal(harness.store.getThread(created.key).description, '长期维护部署与回滚');
  } finally {
    harness.store.close();
  }
});

test('T4-004（v0.7.19 非真机证据）：无子代理的新建路径 description 用 charter、prompt 也带职责行', async () => {
  // 判别力：删掉 src/runtime/tools.js 新建无子代理分支的 `charter ?? goal`（description）
  // 或 platform.prompt 的职责前缀 → 本用例红。
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
    assert.equal(harness.store.getThread(result.key).description, '负责登录模块');
    assert.deepEqual(harness.platform.calls.prompted[0].content, [{
      type: 'text',
      text: '线程职责：负责登录模块\n实现登录',
    }]);
  } finally {
    harness.store.close();
  }
});

test('T4-005（v0.7.19 非真机证据）：charter 超过 300 码点被拒绝且不落库不投递', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 `charter_too_long` 判断 → 本用例红。
  const harness = makeSubagentHarness();
  try {
    const rejected = await harness.byName.thread_run.execute({
      key: 'new',
      name: '太长',
      goal: '做事',
      charter: '长'.repeat(301),
    }, { agent: AGENT });
    assert.deepEqual(rejected, { ok: false, reason: 'charter_too_long' });
    assert.equal(harness.platform.calls.started.length, 0);
    assert.equal(harness.store.getThread('太长'), null);

    // 恰好 300 码点必须通过（上限按码点计，不是字节）。
    const accepted = await harness.byName.thread_run.execute({
      key: 'new',
      name: '刚好',
      goal: '做事',
      charter: '长'.repeat(300),
    }, { agent: AGENT });
    assert.equal(accepted.ok, true);
    assert.equal(harness.store.getThread(accepted.key).description, '长'.repeat(300));
  } finally {
    harness.store.close();
  }
});

// ------------------------------------------------------- T4.3 投递历史

test('T4-006（v0.7.19 非真机证据）：thread_history 按 offset 分页且最新在前', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 appendThreadHistory（run() 开头）
  // 或 `slice(offset, offset + limit)` → 本用例红。
  const harness = makeSubagentHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '分页',
      goal: '第一次',
    }, { agent: AGENT });
    for (const goal of ['第二次', '第三次', '第四次', '第五次']) {
      await harness.byName.thread_run.execute({ key: created.key, goal }, { agent: AGENT });
    }

    const page = await harness.byName.thread_history.execute({
      key: created.key,
      limit: 2,
      offset: 1,
    });
    assert.equal(page.total, 5);
    assert.equal(page.count, 2);
    assert.equal(page.limit, 2);
    assert.equal(page.offset, 1);
    assert.deepEqual(page.items.map((item) => item.goalFirst), ['第四次', '第三次']);
    // 时间列：epoch 秒 + 可读 UTC ISO。
    assert.equal(page.items[0].at, NOW_SEC);
    assert.equal(page.items[0].atText, NOW_ISO);

    const empty = await harness.byName.thread_history.execute({ key: 'never-used' });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
  } finally {
    harness.store.close();
  }
});

test('T4-007（v0.7.19 非真机证据）：thread_history 滚动保留最近 30 条且 limit 钳到 30', async () => {
  // 判别力：删掉 src/runtime/tools.js 的 `slice(0, THREAD_HISTORY_MAX_ENTRIES)`
  // 或 `Math.min(rawLimit, THREAD_HISTORY_MAX_ENTRIES)` → 本用例红。
  const harness = makeSubagentHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '滚动',
      goal: '第1次',
    }, { agent: AGENT });
    for (let index = 2; index <= 35; index += 1) {
      await harness.byName.thread_run.execute({ key: created.key, goal: `第${index}次` }, { agent: AGENT });
    }

    const raw = harness.store.getMeta(`thread_history:${created.key}`);
    assert.equal(JSON.parse(raw).length, 30);

    const page = await harness.byName.thread_history.execute({
      key: created.key,
      limit: 100,
    });
    assert.equal(page.limit, 30, '超过上限必须钳到 30');
    assert.equal(page.count, 30);
    assert.equal(page.total, 30);
    assert.equal(page.items[0].goalFirst, '第35次');
    assert.equal(page.items[29].goalFirst, '第6次', '最旧的 5 条已被滚动淘汰');
  } finally {
    harness.store.close();
  }
});

test('T4-008（v0.7.19 非真机证据）：回执按 requestId 回填 receiptFirst 与终态', async () => {
  // 判别力：删掉 src/runtime/tools.js 回执 `.then()` 里的 updateThreadHistoryReceipt
  // → 本用例红（条目会停在 dispatched/null）。
  const harness = makeSubagentHarness({ resultText: '预算已核对，差 3 千。' });
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '回执',
      goal: '核对预算',
    }, { agent: AGENT });
    assert.equal(result.ok, true);
    await flushReceipts();

    const page = await harness.byName.thread_history.execute({ key: result.key });
    assert.equal(page.count, 1);
    assert.equal(page.items[0].goalFirst, '核对预算');
    assert.equal(page.items[0].receiptFirst, '预算已核对');
    assert.equal(page.items[0].status, 'ok');
    assert.equal(page.items[0].requestId, result.requestId);
    assert.equal(page.items[0].action, 'create');
  } finally {
    harness.store.close();
  }
});

test('T4-009（v0.7.19 非真机证据）：没有 activation.result 的投递保持 dispatched', async () => {
  // 判别力：若把初值 'dispatched' 改掉、或对无 result 路径伪造终态 → 本用例红。
  const harness = makeLegacyHarness();
  try {
    const created = await harness.byName.thread_run.execute({
      key: 'new',
      name: '旧路',
      goal: '做事',
    });
    await flushReceipts();
    await harness.byName.thread_run.execute({ key: created.key, goal: '继续做事' });
    await flushReceipts();

    const page = await harness.byName.thread_history.execute({ key: created.key });
    assert.equal(page.count, 2);
    assert.deepEqual(page.items.map((item) => item.status), ['dispatched', 'dispatched']);
    assert.deepEqual(page.items.map((item) => item.receiptFirst), [null, null]);
    assert.deepEqual(page.items.map((item) => item.goalFirst), ['继续做事', '做事']);
  } finally {
    harness.store.close();
  }
});

// ------------------------------------------------------------ T4.2 文案

test('T4-010（v0.7.19 非真机证据）：apply 注册 companion-thread-offload 系统提示（order 330 / 不插值）', () => {
  // 判别力：删掉 src/index.js apply 里的 platform.context({ name:
  // 'companion-thread-offload' … }) → 本用例红。
  const ctx = new FakeCtx({ now: NOW_MS });
  ctx.commands = {
    registrations: [],
    register(definition) { this.registrations.push(definition); return () => {}; },
  };
  ctx.tools = {
    registrations: [],
    register(definition) { this.registrations.push(definition); return () => {}; },
  };
  const handle = applyCordis(strictCtx(ctx), { dbPath: ':memory:' });
  try {
    const calls = ctx.callsOf('systemPrompt.context')
      .filter((call) => call?.args?.[0]?.name === 'companion-thread-offload');
    assert.equal(calls.length, 1, '线程提示必须只注册一次');
    const entry = calls[0].args[0];
    assert.equal(entry.order, 330, '必须排在 emotion（320）之后、宿主 100-210 之外');
    assert.equal(entry.interpolate, false, '静态文案也必须关闭插值');
    assert.equal(entry.text, THREAD_OFFLOAD_TEXT);

    // T4.2 只改文案：人格三段 + 状态板段的注册数不变（仍是 4 段）。
    assert.equal(ctx.sections.filter((item) => !item.disposed).length, 4);
  } finally {
    handle.dispose();
  }
});
