/**
 * R-M2：thread_run 持槽的真机退化与日志。
 *
 * 覆盖：
 * - create 分支把 createSession 返回的句柄直接交给 whenIdle（不靠 ctx.agents 反查）；
 * - reuse 分支反查失败 → warn + threadSlotFallback，且槽位仍被释放；
 * - whenIdle reject → warn + threadSlotFallback，且槽位仍被释放；
 * - 900s 兜底 → warn + threadSlotTimeout，且槽位被强制释放。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { createMetrics } from '../src/runtime/metrics.js';
import * as registry from '../src/thread/registry.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** 可手动 resolve 的 whenIdle 句柄。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    timers: {
      setTimeout(callback, ms) {
        const handle = { callback, ms, unref() {} };
        scheduled.push(handle);
        return handle;
      },
      clearTimeout(handle) {
        cleared.push(handle);
      },
    },
  };
}

/**
 * fake platform 模拟 adapter.whenIdle 的解析语义：
 * - 对象/句柄 → 取 `target.agent ?? target` 调 whenIdle()；
 * - 字符串 → 只查 agents 表，查不到就抛错（真机上 ctx.agents 反查失败）。
 */
function makeHarness({ timers } = {}) {
  const store = Store.open(':memory:');
  const logs = [];
  const metrics = createMetrics({ clock: () => NOW_MS });
  const agents = new Map();
  const idles = new Map();

  const platform = {
    sessions: [],
    prompts: [],
    idleTargets: [],
    log(level, message, meta) {
      logs.push({ level, message, meta });
      return true;
    },
    whenIdle(target) {
      this.idleTargets.push(target);
      if (typeof target === 'string') {
        const agent = agents.get(target);
        if (!agent) throw new Error('no-when-idle: agent.whenIdle()');
        return agent.whenIdle();
      }
      const candidate = target?.agent ?? target;
      if (typeof candidate?.whenIdle !== 'function') {
        throw new Error('no-when-idle: agent.whenIdle()');
      }
      return candidate.whenIdle();
    },
    async createSession(request) {
      this.sessions.push(request);
      const sessionId = `sess-${this.sessions.length}`;
      const idle = deferred();
      idles.set(sessionId, idle);
      const agent = { id: sessionId, whenIdle: () => idle.promise };
      return { sessionId, agent };
    },
    async prompt(request) {
      this.prompts.push(request);
      return { ok: true };
    },
    async unarchiveSession() {
      return { ok: true };
    },
  };

  const tools = createTools({
    store,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    registry,
    platform,
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-thread',
    metrics,
    ...(timers === undefined ? {} : { timers }),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  return {
    store,
    logs,
    metrics,
    agents,
    idles,
    platform,
    byName,
    registerAgent(sessionId, agent) {
      agents.set(sessionId, agent);
    },
    releaseIdle(sessionId) {
      const idle = idles.get(sessionId);
      assert.ok(idle, `没有待释放的 whenIdle：${sessionId}`);
      idle.resolve();
    },
  };
}

/** 让 idle.then 的释放回调跑完。 */
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function warnLogs(harness) {
  return harness.logs.filter((entry) => entry.level === 'warn');
}

test('R-M2 create：whenIdle 收到 createSession 句柄，不依赖 ctx.agents 反查', async () => {
  const harness = makeHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new', name: '新线程', goal: '统计本周开销',
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    assert.equal(harness.platform.idleTargets.length, 1);
    const target = harness.platform.idleTargets[0];
    assert.equal(typeof target, 'object', 'create 分支应传句柄而不是会话 id');
    assert.equal(target.agent.id, 'sess-1');
    assert.deepEqual(warnLogs(harness), []);
    assert.equal(harness.metrics.snapshot().threadSlotFallback ?? 0, 0);
  } finally {
    harness.releaseIdle('sess-1');
    await tick();
    harness.store.close();
  }
});

test('R-M2 reuse：ctx.agents 反查失败 → warn + threadSlotFallback，槽位仍释放', async () => {
  const harness = makeHarness();
  try {
    harness.store.upsertThread({
      key: 'rent', name: '租房', session_id: 's-old',
      description: '占位', last_active_at: NOW_SEC,
    });

    const result = await harness.byName.thread_run.execute({ key: 'rent', goal: '继续看房' });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'reuse');

    const warns = warnLogs(harness);
    assert.equal(warns.length, 1, '反查失败应有且仅有一条 warn');
    assert.match(warns[0].message, /whenIdle unavailable/);
    assert.deepEqual(
      [warns[0].meta.action, warns[0].meta.key, warns[0].meta.sessionId],
      ['reuse', 'rent', 's-old'],
    );
    assert.match(String(warns[0].meta.reason), /no-when-idle/);
    assert.equal(harness.metrics.snapshot().threadSlotFallback, 1);

    // 槽位已释放：下一次 thread_run 不应 busy。
    const next = await harness.byName.thread_run.execute({
      key: 'new', name: '第二个线程', goal: '再试一次',
    });
    assert.equal(next.ok, true);
    assert.equal(next.action, 'create');
  } finally {
    harness.releaseIdle('sess-1');
    await tick();
    harness.store.close();
  }
});

test('R-M2 reject：whenIdle reject → warn + threadSlotFallback，槽位仍释放', async () => {
  const harness = makeHarness();
  try {
    harness.store.upsertThread({
      key: 'rent', name: '租房', session_id: 's-old',
      description: '占位', last_active_at: NOW_SEC,
    });
    harness.registerAgent('s-old', {
      id: 's-old',
      whenIdle: () => Promise.reject(new Error('thread crashed')),
    });

    const result = await harness.byName.thread_run.execute({ key: 'rent', goal: '继续看房' });
    assert.equal(result.ok, true);
    await tick();

    const warns = warnLogs(harness);
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /whenIdle unavailable/);
    assert.equal(warns[0].meta.action, 'reuse');
    assert.match(String(warns[0].meta.reason), /thread crashed/);
    assert.equal(harness.metrics.snapshot().threadSlotFallback, 1);

    const next = await harness.byName.thread_run.execute({
      key: 'new', name: '第二个线程', goal: '再试一次',
    });
    assert.equal(next.ok, true, 'whenIdle 失败后槽位必须释放');
  } finally {
    harness.releaseIdle('sess-1');
    await tick();
    harness.store.close();
  }
});

test('R-M2 timeout：900s 兜底强制释放 → warn + threadSlotTimeout', async () => {
  const fake = makeFakeTimers();
  const harness = makeHarness({ timers: fake.timers });
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new', name: '卡住的线程', goal: '永远不结束的任务',
    });
    assert.equal(result.ok, true);
    assert.equal(fake.scheduled.length, 1, '持槽应注册 900s 兜底定时器');
    assert.equal(fake.scheduled[0].ms, 900_000);

    fake.scheduled[0].callback();
    await tick();

    const warns = warnLogs(harness);
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /force-released after idle timeout/);
    assert.deepEqual(
      [warns[0].meta.action, warns[0].meta.key, warns[0].meta.sessionId, warns[0].meta.maxMs],
      ['create', result.key, result.sessionId, 900_000],
    );
    assert.equal(harness.metrics.snapshot().threadSlotTimeout, 1);

    const next = await harness.byName.thread_run.execute({
      key: 'new', name: '第二个线程', goal: '再试一次',
    });
    assert.equal(next.ok, true, '900s 强制释放后槽位必须可用');
  } finally {
    harness.store.close();
  }
});
