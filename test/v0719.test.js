/**
 * T1（v0.7.19）：工具输出裁剪接入宿主 `toolResultPruner`。
 *
 * 背景（lead 已亲核的宿主契约）：
 * - 服务名 `toolResultPruner`（pruner `lib/index.js:71` `super(ctx,"toolResultPruner")`），
 *   宿主导缩在 `compaction-basic/lib/index.js:926` 用 `this.ctx.get("toolResultPruner")`；
 * - 入口 `pruneSession(session)` 返回 `{pruned, charsRemoved}`（pruner `lib/index.js:187-190`），
 *   `charsRemoved` 按 Unicode code point 累加；`pruned[]` 元素含
 *   `originalSeq/replacementSeq/callId/charsBefore/charsAfter`；
 * - `pruneContent` 在内容 ≤ 阈值时返回 null（:93）→ 重复调用**幂等**；无候选时
 *   `pruned=[]`、`charsRemoved=0`、零副作用；
 * - 阈值 8192/4096/1024 沿用宿主默认（`dsh-base/cordis.patch.yml:425-430`），插件不自己截断。
 *
 * **这些用例全部是测试替身（mock pruner / mock compaction），不是真机证据。**
 * 它们只证明「接线正确、调用顺序正确、缺服务降级、幂等与累计口径正确」；
 * 真机效果（真实阈值下裁掉多少字符）另由云端预演验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';
import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

// ---------------------------------------------------------------- 事件构造（照 v077-stage1）

/** @param {string} text @param {number} [seq] */
function userEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/** 一条带 N 个 tool-call 的 assistant 消息。 @param {number} calls @param {number} [seq] */
function assistantToolCallEvent(calls = 1, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: Array.from({ length: calls }, (_, index) => ({
          type: 'tool-call',
          id: `call-${index}`,
          name: 'bash',
        })),
      },
    },
  };
}

/** @param {number} [seq] */
function toolResultEvent(seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'tool/result',
    data: { callId: undefined, content: [{ type: 'text', text: 'ok' }] },
  };
}

/** @param {string} text @param {number} [seq] */
function assistantTextEvent(text, seq) {
  return {
    ...(seq === undefined ? {} : { seq }),
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

/** 一条能通过配平校验的区间：user(1) / assistant tool-call(2) / tool result(3) / assistant text(4)。 */
function pairedEvents() {
  return [
    userEvent('拉一下日志。', 1),
    assistantToolCallEvent(1, 2),
    toolResultEvent(3),
    assistantTextEvent('构建通过。', 4),
  ];
}

// ---------------------------------------------------------------- 接线骨架

/** @param {{now?: number}} [options] */
function makeCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  ctx.commands = { register: () => () => {} };
  ctx.tools = { register: () => () => {} };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ episode: null, facts: [], reminders: [] }) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return ctx;
}

/**
 * 播种一条「已巩固、可压缩」的 nap 行，作为下次 apply 启动时恢复的 pending。
 * @param {string} dbPath
 * @param {{start: number, end: number}} region
 */
function seedPending(dbPath, { start, end }) {
  const store = Store.open(dbPath);
  try {
    store.insertConsolidation({
      scope: 'main',
      kind: 'nap',
      status: 'written',
      session_id: 'main',
      trigger: 'turn',
      upto_seq: end,
      turn_from: start,
      turn_to: end,
      compaction_start_seq: start,
      started_at: Math.floor(TEST_NOW / 1000),
      finished_at: Math.floor(TEST_NOW / 1000),
    });
  } finally {
    store.close();
  }
}

/**
 * 触发一次 turn 头（pre-step enter）。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {number} turn
 * @param {string} text
 */
async function preStep(ctx, session, turn, text) {
  ctx.emitSessionEvent(session.id, userEvent(text));
  return ctx.dispatch(
    'agent/pre-step',
    {
      agent: { id: session.id, session },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      turn,
      step: 1,
    },
    { kind: 'enter', messages: [] },
  );
}

/** 取 `prune_stats:<scope>` 的落库值（schema_meta，零 DDL）。 */
function pruneStats(store, scope = 'main') {
  const raw = store.getMeta('prune_stats:' + scope);
  return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------- T1-001 调用顺序

test('T1-001（v0.7.19 非真机证据）：compactRegion 之前先调 pruneSession，且传入 agent.session', async () => {
  // 判别力：删掉 maybeCompact 主路径的 `pruneBeforeCompact(state, payload?.agent);`
  // → 调用序列变成 [prune, compact]，紧邻压缩之前不再是 prune，本用例红。
  // v0.7.20 T1 起存量裁剪只认主会话：本用例的 session 是 main scope，因此
  // 「启动存量裁剪 1 次 + 压缩前 1 次」的两次 prune 仍是**精确**口径（不是 >=）。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-t1-order', events: pairedEvents() });
  const sequence = [];
  const seen = [];
  ctx.toolResultPruner = {
    pruneSession(input) {
      sequence.push('prune');
      seen.push(input);
      return { pruned: [], charsRemoved: 0 };
    },
  };
  const originalCompact = ctx.compaction.compactRegion;
  ctx.compaction.compactRegion = function patched(start, end, agent, signal) {
    sequence.push('compact');
    return originalCompact.call(this, start, end, agent, signal);
  };
  // pending 的 end 切在 assistant tool-call(2) 上 → 收缩到平衡切口 1，压缩一定会发生。
  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    await settle();
    // bootstrap（runPreStep 顶部）裁一次 → 压缩路径再裁一次 → 才压缩。
    assert.equal(
      sequence.join(' → '),
      'prune → prune → compact',
      `压缩之前紧邻的一步必须是 pruneSession（主会话：存量裁剪 1 次 + 压缩前 1 次），实际序列：${sequence.join(' → ')}`,
    );
    assert.equal(seen.at(-1), session, '传进 pruneSession 的必须是 agent.session 对象本身');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- T1-002 缺服务降级

test('T1-002（v0.7.19 非真机证据）：缺 toolResultPruner 不抛错、压缩照常、warn 只打一次', async () => {
  // 判别力：删掉 pruneBeforeCompact 里的 `state.prunerMissingWarned` 守卫 →
  // 同一 turn 的两次查找（启动存量裁剪 + 压缩前）各 warn 一次，本用例的 warns===1 红。
  // v0.7.20 T1 起存量裁剪只认主会话：本用例是 main scope，查找次数因此是**精确 2 次**。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-t1-missing', events: pairedEvents() });

  // 探针：不改生产代码，直接从 ctx.get 侧计数（适配层只走 service() → ctx.get）。
  const originalGet = ctx.get.bind(ctx);
  let prunerLookups = 0;
  ctx.get = (name) => {
    if (name === 'toolResultPruner') {
      prunerLookups += 1;
      return undefined;
    }
    return originalGet(name);
  };

  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    await settle();

    assert.equal(prunerLookups, 2, `主会话一个 turn 内恰好查找两次（存量裁剪 + 压缩前），实际 ${prunerLookups}`);
    const calls = ctx.callsOf('compaction.compactRegion');
    assert.equal(calls.length, 1, '缺 pruner 不能阻断压缩');

    const warns = ctx.logs.filter(
      (entry) => entry.level === 'warn' && /toolResultPruner unavailable/u.test(String(entry.message)),
    );
    assert.equal(warns.length, 1, `缺服务只 warn 一次，实际 ${warns.length} 次`);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- T1-003 审计与累计

test('T1-003（v0.7.19 非真机证据）：pruned 非空才写审计并累加 prune_stats，空结果零副作用', async () => {
  // 判别力：删掉 pruneBeforeCompact 里的 `if (pruned.length === 0) return;` →
  // 首次（启动存量裁剪，空 pruned）也会多写一条 count:0 的审计，本用例的 events===1 红。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-t1-audit', events: pairedEvents() });

  // 第一次调用来自主会话首个 pre-step 的存量裁剪（空结果），第二次来自压缩前 —— 同一个
  // turn 内正好同时验证「空结果不写」与「非空结果按条累加」；次序是**精确** 2 次。
  let calls = 0;
  const resultSets = [
    { pruned: [], charsRemoved: 0 },
    {
      pruned: [
        { originalSeq: 11, replacementSeq: 112, callId: 'call-a', charsBefore: 9000, charsAfter: 1200 },
        { originalSeq: 12, replacementSeq: 113, callId: 'call-b', charsBefore: 8200, charsAfter: 900 },
      ],
      charsRemoved: 123,
    },
  ];
  ctx.toolResultPruner = {
    pruneSession() {
      const result = resultSets[Math.min(calls, resultSets.length - 1)];
      calls += 1;
      return result;
    },
  };

  // 历史累计：{count:5, charsRemoved:7}，本版必须**累加**而不是覆盖。
  temp.store.setMeta('prune_stats:main', JSON.stringify({ count: 5, charsRemoved: 7 }));
  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    await settle();

    assert.equal(calls, 2, `主会话一个 turn 内裁两次（存量裁剪 + 压缩前），实际 ${calls}`);

    const events = temp.store.listEvents({ table_name: 'tool_prune' });
    assert.equal(events.length, 1, `空 pruned 不写审计，只有非空那一次落库，实际 ${events.length} 条`);
    const event = events[0];
    assert.equal(event.action, 'USED', 'actor/action 只能用现有枚举（EVENT_ACTIONS）');
    assert.equal(event.actor, 'scheduler');
    assert.equal(event.row_id, 'main');
    assert.equal(event.reason, 'tool_result_prune');
    const detail = JSON.parse(event.detail_json);
    assert.equal(detail.kind, 'tool_result_prune');
    assert.equal(detail.count, 2);
    assert.equal(detail.charsRemoved, 123);

    assert.deepEqual(
      pruneStats(temp.store),
      { count: 7, charsRemoved: 130 },
      '累计值 = 旧值 + 本次（5+2 条 / 7+123 字符），不按日清',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('T1-004（v0.7.19 非真机证据）：pruned 恒空时既不写审计也不动累计', async () => {
  // 判别力：删掉 pruneBeforeCompact 里的 `if (pruned.length === 0) return;` → 每次空裁都写一条
  // count:0 的审计行，本用例的 events===0 红（累计不变是因为加了 0，那一条不构成判别）。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-t1-idem', events: pairedEvents() });
  let calls = 0;
  ctx.toolResultPruner = {
    pruneSession() {
      calls += 1;
      return { pruned: [], charsRemoved: 0 };
    },
  };
  temp.store.setMeta('prune_stats:main', JSON.stringify({ count: 3, charsRemoved: 40 }));
  seedPending(temp.dbPath, { start: 1, end: 2 });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, compactMinRegionTokens: 0 });
  try {
    await preStep(ctx, session, 1, '继续。');
    await settle();

    assert.equal(calls, 2, 'pruneSession 应被调用（幂等由宿主保证，插件只负责不重复记账）');
    assert.equal(temp.store.listEvents({ table_name: 'tool_prune' }).length, 0, '无裁剪就不该有审计行');
    assert.deepEqual(pruneStats(temp.store), { count: 3, charsRemoved: 40 }, '累计值保持原样');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- T1-005 /状态 行（命令层）

test('T1-005（v0.7.19 非真机证据）：/状态 有累计才多一行，0 或未接线整行省略', (t) => {
  // 判别力：删掉 src/runtime/commands.js:914 的 `function formatPruneLine` 或 :733 的
  // `if (pruneLine !== null) lines.push(pruneLine);` → 非零场景不再出现该行，本用例红。
  const temp = makeTempStore();
  t.after(temp.cleanup);
  const base = { text: '/状态', store: temp.store, now: TEST_NOW, timeZone: 'UTC' };

  const unwired = handleCommand(base).reply;
  assert.doesNotMatch(unwired, /工具输出裁剪/u, '未接线时整行省略（旧 golden 零波及）');

  const zero = handleCommand({ ...base, prune: { count: 0, charsRemoved: 0 } }).reply;
  assert.doesNotMatch(zero, /工具输出裁剪/u, 'count=0 也省行');

  const some = handleCommand({ ...base, prune: { count: 12, charsRemoved: 3456 } }).reply;
  assert.match(some, /工具输出裁剪：累计 12 条 \/ 3456 字符/u);
});

test('T1-006（v0.7.19 非真机证据）：生产接线把 prune_stats 累计接进 /状态', () => {
  // 判别力：删掉 src/index.js:1348 的 `prune: pruneStatsOf(store, scope),`（或
  // src/runtime/commands.js:165/204 的 prune 透传）→ /状态 不再出现该行，本用例红。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0719-t1-'));
  const dbPath = join(dir, 'store.db');
  let handle = null;
  try {
    const seed = Store.open(dbPath);
    seed.setMeta('prune_stats:main', JSON.stringify({ count: 4, charsRemoved: 321 }));
    seed.close();

    const ctx = new FakeCtx({ now: TEST_NOW });
    ctx.commands = {
      registrations: [],
      register(definition) {
        this.registrations.push(definition);
        return () => {};
      },
    };
    ctx.tools = {
      registrations: [],
      register(definition) {
        this.registrations.push(definition);
        return () => {};
      },
    };
    handle = applyCordis(strictCtx(ctx), { dbPath });

    const status = ctx.commands.registrations.find((entry) => entry.name === 'status');
    assert.ok(status, 'status 命令应已注册');
    const reply = status.handler({ rawInput: '' });
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /工具输出裁剪：累计 4 条 \/ 321 字符/u);
  } finally {
    if (handle !== null) handle.dispose();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 插件仍持有连接时 Windows 删不掉，留给系统清理。
    }
  }
});

// ---------------------------------------------------------------- T1-007 首窗 bootstrap

test('T1-007（v0.7.19 非真机证据）：启动后首个窗口只清一次存量（pre-step 缓存 agent 兜底）', async () => {
  // 判别力：删掉 maybeBootstrapPrune 开头的 `if (state.pruneBootstrapDone === true) return;` →
  // 之后每个 60s tick 都会再裁一次，本用例第二次/第三次 tick 的计数红。
  // v0.7.20 T1：idle-probe 的存量裁剪臂已删除（首个窗口一定还没有主会话 agent，恒不生效），
  // 存量裁剪只由主会话首个 pre-step 触发；本用例仍覆盖「窗口不裁 / 首个 turn 裁一次 / 之后不裁」。
  const temp = makeTempStore();
  const ctx = makeCtx();
  const session = ctx.addSession({ id: 'session-t1-boot', events: [userEvent('你好。', 1)] });
  let prunes = 0;
  ctx.toolResultPruner = {
    pruneSession() {
      prunes += 1;
      return { pruned: [], charsRemoved: 0 };
    },
  };
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 20_000, compactMinRegionTokens: 0 });
  try {
    // 1) 首个 idle 窗口先到：idle-probe 已无存量裁剪臂（且此时没有任何 agent 句柄），不裁。
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(prunes, 0, 'idle 窗口不触发存量裁剪（臂已删除；且无 agent 句柄，不抛错、不阻断）');

    // 2) 主会话首个 turn 到来：pre-step 兜底裁一次（缓存 agent + 置 done）。
    await preStep(ctx, session, 1, '继续。');
    await settle();
    assert.equal(prunes, 1, '主会话首个 turn 应兜底清一次存量');

    // 3) 之后两个 idle 窗口：done 已置位，不再重复裁。
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(prunes, 1, '第二个窗口不得再裁');

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(prunes, 1, '第三个窗口不得再裁（done 标志只跑一次）');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
