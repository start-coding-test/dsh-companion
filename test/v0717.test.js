/**
 * v0.7.17 H1-A：历史回填的**只读**选区、预演估算、配置与 /状态 展示。
 *
 * 全部断言是**非真机证据**：surface 是手工构造的快照，命令层用 FakeCtx + 临时库；
 * 真实宿主 surface / 摘要节点大小 / 模型成本都要在 50041 上验收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { handleMemoryCommand } from '../src/index.js';
import { handleCommand, formatBackfillPreview } from '../src/runtime/commands.js';
import { DEFAULTS, normalizeConfig } from '../src/config.js';
import {
  BACKFILL_META_PREFIX,
  BACKFILL_SUMMARY_TOKENS_UPPER,
  estimateBackfill,
  isCompactSummaryNode,
  planBackfillChunks,
  readBackfillState,
} from '../src/session/backfill.js';
import { TEST_NOW, makeTempStore } from './e2e/helpers.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Store } from '../src/memory/store.js';
import { BG_JOB_STATES, buildCancelMessage, monitorBgJobs } from '../src/task/bg-jobs.js';
import { createTools } from '../src/runtime/tools.js';
import { wakeBgJob } from '../src/index.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/**
 * 造一个 surface 快照（seqs/nodes/records 三者按位置对齐）。
 * @param {{seqs: number[], tokens?: number[], roles?: string[], texts?: string[],
 *          toolDeltas?: number[]}} input
 * @returns {{seqs: number[], nodes: object[], records: object[]}}
 */
function makeSnapshot(input) {
  const seqs = input.seqs.slice();
  const tokens = input.tokens ?? seqs.map(() => 100);
  const roles = input.roles ?? seqs.map(() => 'user');
  const texts = input.texts ?? seqs.map((seq) => `消息 ${seq}`);
  const toolDeltas = input.toolDeltas ?? seqs.map(() => 0);
  return {
    seqs,
    nodes: seqs.map((seq, index) => ({ seq, tokens: tokens[index] ?? 0 })),
    records: seqs.map((seq, index) => ({
      seq,
      role: roles[index] ?? 'user',
      text: texts[index] ?? '',
      tokens: tokens[index] ?? 0,
      toolDelta: toolDeltas[index] ?? 0,
      sourceKind: null,
    })),
  };
}

/** 计数型 meta store：记录 setMeta/deleteMeta 调用，用于证明「只读」。 */
function makeMetaStore({ watermark = null } = {}) {
  const meta = new Map();
  const writes = [];
  return {
    meta,
    writes,
    getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },
    setMeta(key, value) {
      writes.push(['set', key]);
      meta.set(key, String(value));
    },
    deleteMeta(key) {
      writes.push(['delete', key]);
      meta.delete(key);
    },
    getWatermark() {
      return watermark;
    },
  };
}

// ------------------------------------------------------------------ 选区

test('H1-A 选区：只按位置比较水位，seq 数值小但位置在水位之后不能选', () => {
  // 压缩后的替换节点可能让 seq 非单调：seq=900 在位置 1，seq=2/3 在它之后。
  const snapshot = makeSnapshot({ seqs: [1, 900, 2, 3], tokens: [100, 200, 300, 400] });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 900, chunkTokens: 32_768 });
  assert.equal(plan.reason, 'ok');
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].startSeq, 1);
  assert.equal(plan.chunks[0].endSeq, 1);
  // 按数值比较会误选 seq 2/3；按位置比较只能选位置 0。
  assert.equal(plan.selectableTokens, 100);
});

test('H1-A 选区：起点从首个可替换节点之后开始（跳过系统提示词）', () => {
  const snapshot = makeSnapshot({
    seqs: [10, 11, 12],
    roles: ['system', 'user', 'assistant'],
    tokens: [1000, 200, 300],
  });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 12, chunkTokens: 32_768 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].startSeq, 11);
  assert.equal(plan.chunks[0].endSeq, 11);
});

test('H1-A 选区：终点按工具配对收缩；配平后为空则整批作废', () => {
  const retreat = makeSnapshot({
    seqs: [1, 2, 3, 4, 5, 6],
    tokens: [10, 10, 10, 10, 10, 10],
    toolDeltas: [0, 0, 0, 0, 0, 1],
  });
  const plan = planBackfillChunks(retreat, { watermarkSeq: 6, chunkTokens: 32_768 });
  assert.equal(plan.chunks.length, 1);
  // 最后一个节点开了一个未配对的 tool-call：终点退到 5 之前。
  assert.equal(plan.chunks[0].endSeq, 5);
  assert.equal(plan.chunks[0].endIdx, 4);

  const empty = makeSnapshot({
    seqs: [1, 2],
    tokens: [10, 10],
    toolDeltas: [1, 0],
  });
  const plan2 = planBackfillChunks(empty, { watermarkSeq: 2, chunkTokens: 32_768 });
  assert.equal(plan2.chunks.length, 0);
  assert.equal(plan2.reason, 'unbalanced-boundary');
  assert.equal(plan2.selectableTokens, 0);
});

test('H1-A 选区：遇到系统节点收尾', () => {
  const snapshot = makeSnapshot({
    seqs: [1, 2, 3, 4, 5],
    roles: ['user', 'user', 'system', 'user', 'user'],
  });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 5, chunkTokens: 32_768 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].endSeq, 2);
  assert.equal(plan.reason, 'system-boundary');
});

test('H1-A 选区：跳过压缩摘要/检查点节点，不把它算进正文', () => {
  const snapshot = makeSnapshot({
    seqs: [1, 2, 3, 4, 5],
    texts: ['a', 'b', '<compacted-summary>旧摘要</compacted-summary>', 'd', 'e'],
  });
  assert.equal(isCompactSummaryNode({ text: '<compacted-summary>x</compacted-summary>' }), true);
  assert.equal(isCompactSummaryNode({ text: 'This is an automatically generated checkpoint' }), true);
  assert.equal(isCompactSummaryNode({ text: '普通消息' }), false);

  const plan = planBackfillChunks(snapshot, { watermarkSeq: 5, chunkTokens: 32_768 });
  const starts = plan.chunks.map((chunk) => chunk.startSeq);
  const ends = plan.chunks.map((chunk) => chunk.endSeq);
  assert.deepEqual(starts, [1, 4]);
  assert.deepEqual(ends, [2, 4]);
  assert.equal(plan.chunks.some((chunk) => chunk.startSeq <= 3 && chunk.endSeq >= 3), false);
});

test('H1-A 选区：按 chunkTokens 连续切批，游标用 seq 且过期游标报 stale-cursor', () => {
  const tokens = new Array(10).fill(1000);
  const snapshot = makeSnapshot({
    seqs: Array.from({ length: 10 }, (_value, index) => index + 1),
    tokens,
  });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 10, chunkTokens: 3000 });
  assert.equal(plan.chunks.length, 3);
  for (const chunk of plan.chunks) {
    assert.equal(chunk.tokens, 3000);
    assert.equal(chunk.count, 3);
  }
  assert.equal(plan.selectableTokens, 9000);

  const fromCursor = planBackfillChunks(snapshot, {
    watermarkSeq: 10,
    cursorSeq: 3,
    chunkTokens: 2000,
  });
  assert.equal(fromCursor.chunks[0].startSeq, 4);

  const stale = planBackfillChunks(snapshot, { watermarkSeq: 10, cursorSeq: 999 });
  assert.equal(stale.reason, 'stale-cursor');
  assert.equal(stale.chunks.length, 0);
});

test('H1-A 选区：水位不在当前 surface 时明确报 stale-watermark', () => {
  const snapshot = makeSnapshot({ seqs: [1, 2, 3] });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 42 });
  assert.equal(plan.reason, 'stale-watermark');
  assert.equal(plan.chunks.length, 0);
});

// ------------------------------------------------------------------ 估算

test('H1-A 估算：可回收 / 水位后不可回填 / 压后底上限 / 模型调用分项', () => {
  const snapshot = makeSnapshot({ seqs: [1, 2, 3, 4, 5], tokens: [100, 200, 300, 400, 500] });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 5, chunkTokens: 32_768 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].tokens, 1000);
  const estimate = estimateBackfill({ snapshot, plan });
  assert.equal(estimate.totalTokens, 1500);
  assert.equal(estimate.reclaimableTokens, 1000);
  assert.equal(estimate.unreclaimableTokens, 500);
  assert.equal(estimate.summaryTokensUpper, BACKFILL_SUMMARY_TOKENS_UPPER);
  assert.equal(estimate.floorUpperBound, 1500 - 1000 + BACKFILL_SUMMARY_TOKENS_UPPER);
  assert.equal(estimate.modelCalls.total, 2);
  assert.equal(estimate.modelCalls.consolidate, 1);
  assert.equal(estimate.modelCalls.compact, 1);
  assert.match(estimate.modelCalls.dedupeJudge, /未计入/u);
});

// ------------------------------------------------------------------ 只读

test('H1-A 只读：预演/读状态重复执行不写库、不写 meta 键，enabled=false 也不写 compact_backfill_*', () => {
  const store = makeMetaStore({ watermark: 4 });
  store.meta.set('unrelated', 'value');
  const snapshot = makeSnapshot({ seqs: [1, 2, 3, 4, 5], tokens: [100, 200, 300, 400, 500] });
  for (let round = 0; round < 2; round += 1) {
    const status = readBackfillState(store, 'main');
    assert.equal(status.cursorSeq, null);
    assert.equal(status.todayCount, 0);
    assert.equal(status.lastFloor, null);
    const plan = planBackfillChunks(snapshot, {
      watermarkSeq: 4,
      cursorSeq: status.cursorSeq,
      chunkTokens: 32_768,
    });
    const estimate = estimateBackfill({ snapshot, plan });
    const text = formatBackfillPreview({
      scope: 'main',
      enabled: false,
      chunkTokens: 32_768,
      maxPerDay: 6,
      watermarkSeq: 4,
      status,
      plan,
      estimate,
    });
    assert.match(text, /回填预演（只读/u);
    assert.match(text, /开关：关/u);
  }
  assert.deepEqual(store.writes, []);
  assert.deepEqual([...store.meta.keys()], ['unrelated']);
  assert.equal([...store.meta.keys()].some((key) => key.startsWith(BACKFILL_META_PREFIX)), false);
});

// ------------------------------------------------------------------ 预演文本

test('H1-A 预演文本：四项数字与模型调用口径都在', () => {
  const snapshot = makeSnapshot({ seqs: [1, 2, 3, 4], tokens: [1000, 2000, 3000, 4000] });
  const plan = planBackfillChunks(snapshot, { watermarkSeq: 4, chunkTokens: 32_768 });
  const estimate = estimateBackfill({ snapshot, plan });
  const text = formatBackfillPreview({
    scope: 'main',
    enabled: false,
    chunkTokens: 32_768,
    maxPerDay: 6,
    watermarkSeq: 4,
    status: { todayCount: 2, cursorSeq: null, lastFloor: null },
    plan,
    estimate,
  });
  assert.match(text, /可回填：1 批 \/ 6000 tokens/u);
  assert.match(text, /水位后不可回填：4000 tokens（本轮回填碰不到）/u);
  assert.match(text, /理论压后底上限：6048 tokens/u);
  assert.match(text, /预计模型调用：2 次（巩固 1 \+ 压缩摘要 1；去重裁决未计入/u);
  assert.match(text, /今日批数：2\/6/u);
  assert.match(text, /#1 seq 1–3 · 6000 tokens · 3 节点/u);
});

test('H1-A 预演文本：没有水位 / 空 surface 给出明确原因', () => {
  const empty = formatBackfillPreview({
    scope: 'main',
    enabled: true,
    chunkTokens: 32_768,
    maxPerDay: 6,
    watermarkSeq: null,
    status: { todayCount: 0 },
    plan: planBackfillChunks({ seqs: [], nodes: [], records: [] }, { watermarkSeq: null }),
    estimate: estimateBackfill({ snapshot: { nodes: [] }, plan: { chunks: [], watermarkIdx: -1 } }),
  });
  assert.match(empty, /水位：无（尚无压缩水位）/u);
  assert.match(empty, /当前会话没有 surface/u);

  const noWatermark = formatBackfillPreview({
    scope: 'main',
    enabled: true,
    chunkTokens: 32_768,
    maxPerDay: 6,
    watermarkSeq: null,
    status: { todayCount: 0 },
    plan: planBackfillChunks(makeSnapshot({ seqs: [1, 2] }), { watermarkSeq: null }),
    estimate: estimateBackfill({ snapshot: makeSnapshot({ seqs: [1, 2] }) }),
  });
  assert.match(noWatermark, /尚无正常压缩水位/u);
});

// ------------------------------------------------------------------ 配置

test('H1-A 配置：默认值、合法范围校验、旧配置零 warning、16 键不变', () => {
  const defaults = normalizeConfig({});
  assert.deepEqual(defaults.compact.backfill, { enabled: false, chunkTokens: 32_768, maxPerDay: 6 });
  assert.equal(Object.keys(DEFAULTS).length, 16);

  const warnings = [];
  const oldConfig = normalizeConfig({ compact: { minIncrementTokens: 4096 } }, warnings);
  assert.deepEqual(oldConfig.compact.backfill, defaults.compact.backfill);
  assert.equal(warnings.length, 0);

  const custom = normalizeConfig({ compact: { backfill: { enabled: true, chunkTokens: 1024, maxPerDay: 1 } } });
  assert.deepEqual(custom.compact.backfill, { enabled: true, chunkTokens: 1024, maxPerDay: 1 });

  assert.throws(
    () => normalizeConfig({ compact: { backfill: { enabled: 'yes' } } }),
    /compact\.backfill\.enabled/u,
  );
  assert.throws(
    () => normalizeConfig({ compact: { backfill: { chunkTokens: 1023 } } }),
    /compact\.backfill\.chunkTokens/u,
  );
  assert.throws(
    () => normalizeConfig({ compact: { backfill: { chunkTokens: 262_145 } } }),
    /compact\.backfill\.chunkTokens/u,
  );
  assert.throws(
    () => normalizeConfig({ compact: { backfill: { maxPerDay: 0 } } }),
    /compact\.backfill\.maxPerDay/u,
  );
  assert.throws(
    () => normalizeConfig({ compact: { backfill: { maxPerDay: 51 } } }),
    /compact\.backfill\.maxPerDay/u,
  );
});

// ------------------------------------------------------------------ /状态

function statusReply(options = {}) {
  const temp = makeTempStore();
  try {
    return handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      timeZone: 'Asia/Shanghai',
      ...options,
    }).reply;
  } finally {
    temp.cleanup();
  }
}

test('H1-A /状态：未传 backfill 时省行（旧 golden 兼容），传了才显示关/开/游标/今日批数/最近底', () => {
  const plain = statusReply();
  assert.doesNotMatch(plain, /回填：/u);

  const off = statusReply({ backfill: { enabled: false } });
  assert.match(off, /回填：关（compact\.backfill\.enabled=false）/u);

  const on = statusReply({
    backfill: {
      enabled: true,
      cursorSeq: 7,
      todayCount: 2,
      maxPerDay: 6,
      chunkTokens: 32_768,
      lastFloor: 8192,
    },
  });
  assert.match(on, /回填：开 · 游标 seq 7 · 今日 2\/6 批 · 最近压后底 8192 tokens/u);

  const noCursor = statusReply({
    backfill: { enabled: true, cursorSeq: null, todayCount: 0, maxPerDay: 6, lastFloor: null },
  });
  assert.match(noCursor, /游标 无（从水位后第一段起）/u);
  assert.match(noCursor, /最近压后底 无记录/u);
});

// ------------------------------------------------------------------ 接线

test('H1-A 接线：/记忆 回填 走只读预演（无 surface 时也给出明确文本，且不写 meta）', async () => {
  const temp = makeTempStore();
  const ctx = new FakeCtx({ now: TEST_NOW });
  ctx.addSession({ id: 'session-h1a' });
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
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const memory = ctx.commands.registrations.find((entry) => entry.name === 'memory');
    assert.ok(memory, 'memory 命令应已注册');
    const first = memory.handler({ rawInput: ' 回填' });
    assert.equal(first.kind, 'success');
    assert.match(first.text, /回填预演（只读/u);
    assert.match(first.text, /开关：关（compact\.backfill\.enabled=false）/u);
    // 预演不写任何 compact_backfill_* meta。
    const keys = temp.store.db
      .prepare("SELECT key FROM schema_meta WHERE key LIKE 'compact_backfill:%'")
      .all();
    assert.deepEqual(keys, []);
    // 重复预演文本一致（没有偷偷推进游标）。
    const second = memory.handler({ rawInput: ' 回填' });
    assert.equal(second.text, first.text);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('H1-A 接线：handleMemoryCommand 的回填分支可注入渲染；缺省时明确提示不可用', () => {
  const injected = handleMemoryCommand({
    text: '/记忆 回填',
    store: makeMetaStore(),
    backfillPreview: () => '注入的预演文本',
  });
  assert.equal(injected, '注入的预演文本');
  const missing = handleMemoryCommand({ text: '/记忆 回填', store: makeMetaStore() });
  assert.match(missing, /回填预演：当前环境不可用/u);
});


// ---------------------------------------------------------------- L2 / L3 / L5（v0.7.17）

/** 读 memory_events 里最后一条指定 kind 的 detail。 */
function lastDetail(store, kind) {
  const rows = store.listEvents({ table_name: 'bg_jobs', limit: 50 });
  for (const row of rows) {
    const detail = typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json;
    if (detail?.kind === kind) return detail;
  }
  return null;
}

function seedJob(store, overrides = {}) {
  store.insertBgJob({
    id: 'bg-l5',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    pid_or_unit: 'dsh-bg-l5',
    started_at: TEST_NOW - 10,
    deadline: TEST_NOW + 600,
    log_path: '/opt/logs/bg-l5/output.log',
    ...overrides,
  });
}

test('L2 非真机证据：monitor 的兜底（主会话通道）不抹掉 timeout 终态，且审计 channel=main', async () => {
  const store = Store.open(':memory:');
  seedJob(store);
  const config = normalizeConfig({});
  const state = {
    store,
    config,
    platform: { now: () => TEST_NOW * 1000, log() {}, agentBySessionId: () => ({ id: 'agent-main' }), sendToSubagent: async () => { throw new Error('UNAUTHORIZED'); } },
    proactive: { enqueue: () => ({ queued: true, duplicate: false }), flush: async () => ({}) },
    im: { available: true, mode: 'session' },
    mainSessionId: 's-main',
  };
  await monitorBgJobs({
    store,
    config,
    wake: (info) => wakeBgJob(state, info),
    nowMs: TEST_NOW * 1000,
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: true, exitCode: 143 }),
      unitResult: async () => 'timeout',
      readExitCode: () => 143,
      tailLog: () => '',
      capLogFile: () => false,
      signalBgProcess: async () => true,
    },
  });
  assert.equal(store.getBgJob('bg-l5').state, BG_JOB_STATES.timeout, '终态保持 timeout');
  const detail = lastDetail(store, 'bg_job_finished');
  assert.equal(detail.channel, 'main', '兜底仍算送达主会话');
  assert.equal(detail.unit_result, 'timeout');
  store.close();
});

test('L2 非真机证据：预算耗尽时 bg-jobs 的兜底也只在 woken 行降级（终态不被抹掉）', async () => {
  const arms = [
    { exitCode: 0, deadline: TEST_NOW + 600, expect: BG_JOB_STATES.wokenFallback },
    { exitCode: 143, deadline: TEST_NOW - 5, expect: BG_JOB_STATES.timeout },
  ];
  for (const arm of arms) {
    const store = Store.open(':memory:');
    seedJob(store, { deadline: arm.deadline });
    const config = normalizeConfig({ bg: { wakeBudgetPerAgent: 0 } });
    const wakes = [];
    await monitorBgJobs({
      store,
      config,
      wake: async (info) => { wakes.push(info); return { delivered: true, channel: 'main' }; },
      nowMs: TEST_NOW * 1000,
      launcher: {
        probeBgProcess: async () => ({ running: false, exited: true, exitCode: arm.exitCode }),
        unitResult: async () => 'timeout',
        readExitCode: () => arm.exitCode,
        tailLog: () => '',
        capLogFile: () => false,
        signalBgProcess: async () => true,
      },
    });
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].allowWake, false, '预算为 0 时不允许唤醒');
    assert.equal(store.getBgJob('bg-l5').state, arm.expect, `exit=${arm.exitCode} 的终态`);
    store.close();
  }
});

test('L2 非真机证据：failed / cancelled 行在 monitor 轮扫后原样保持', async () => {
  const store = Store.open(':memory:');
  seedJob(store, { id: 'bg-failed', state: 'failed' });
  seedJob(store, { id: 'bg-cancelled', state: 'cancelled' });
  const ran = [];
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW * 1000,
    launcher: { probeBgProcess: async () => { ran.push(1); return { running: true }; } },
  });
  assert.equal(summary.checked, 0, '只扫 running 行');
  assert.equal(ran.length, 0);
  assert.equal(store.getBgJob('bg-failed').state, 'failed');
  assert.equal(store.getBgJob('bg-cancelled').state, 'cancelled');
  store.close();
});

test('L5 非真机证据：lost + Result=timeout → 按 timeout 且 detail.unit_result=timeout', async () => {
  const store = Store.open(':memory:');
  seedJob(store);
  const wakes = [];
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async (info) => { wakes.push(info); return { delivered: true }; },
    nowMs: TEST_NOW * 1000,
    launcher: {
      probeBgProcess: async () => ({ running: false }),
      unitResult: async () => 'timeout',
      readExitCode: () => null,
      tailLog: () => '',
      capLogFile: () => false,
      signalBgProcess: async () => true,
    },
  });
  assert.equal(store.getBgJob('bg-l5').state, BG_JOB_STATES.timeout);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].timedOut, true);
  const detail = lastDetail(store, 'bg_job_finished');
  assert.equal(detail.unit_result, 'timeout');
  store.close();
});

test('L5 非真机证据：lost + 查询不到（null）→ state lost 且 detail 无 unit_result 键', async () => {
  const store = Store.open(':memory:');
  seedJob(store);
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW * 1000,
    launcher: {
      probeBgProcess: async () => ({ running: false }),
      unitResult: async () => null,
      readExitCode: () => null,
      tailLog: () => '',
      capLogFile: () => false,
      signalBgProcess: async () => true,
    },
  });
  assert.equal(store.getBgJob('bg-l5').state, BG_JOB_STATES.lost);
  const detail = lastDetail(store, 'bg_job_finished');
  assert.equal(Object.hasOwn(detail, 'unit_result'), false, '没查过/查不到都不写该键');
  store.close();
});

test('L5 非真机证据：exit 143 且已过 deadline（短路未查 Result）→ 无 unit_result 键', async () => {
  const store = Store.open(':memory:');
  seedJob(store, { deadline: TEST_NOW - 5 });
  let queried = 0;
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW * 1000,
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: true, exitCode: 143 }),
      unitResult: async () => { queried += 1; return null; },
      readExitCode: () => 143,
      tailLog: () => '',
      capLogFile: () => false,
      signalBgProcess: async () => true,
    },
  });
  assert.equal(queried, 0, '已过 deadline 时不再查 Result');
  assert.equal(store.getBgJob('bg-l5').state, BG_JOB_STATES.timeout);
  const detail = lastDetail(store, 'bg_job_finished');
  assert.equal(Object.hasOwn(detail, 'unit_result'), false);
  store.close();
});

test('L5 非真机证据：超时兜底分支（墙钟到期）同样不写 unit_result', async () => {
  const store = Store.open(':memory:');
  seedJob(store, { deadline: TEST_NOW - 5 });
  let queried = 0;
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW * 1000,
    graceMs: 0,
    launcher: {
      probeBgProcess: async () => ({ running: true }),
      unitResult: async () => { queried += 1; return null; },
      readExitCode: () => null,
      tailLog: () => '',
      capLogFile: () => false,
      signalBgProcess: async () => true,
    },
  });
  assert.equal(queried, 0);
  assert.equal(store.getBgJob('bg-l5').state, BG_JOB_STATES.timeout);
  const detail = lastDetail(store, 'bg_job_finished');
  assert.equal(Object.hasOwn(detail, 'unit_result'), false);
  store.close();
});

test('L3 非真机证据：取消回执只有一个生成器（两站点逐字一致 + 全库字面量唯一）', async () => {
  const job = { id: 'bg-t1', label: '训练', argv: ['python3', '/opt/work/train.py'], log_path: '/opt/logs/bg-t1/output.log' };
  const canonical = buildCancelMessage(job);
  assert.equal(
    canonical,
    '[后台任务] bg-t1 训练 已取消（用户主动停止）\n命令：python3 /opt/work/train.py\n日志：/opt/logs/bg-t1/output.log',
  );
  const store = Store.open(':memory:');
  store.insertBgJob({ id: 'bg-t1', label: '训练', argv: ['python3', '/opt/work/train.py'], cwd: '/opt/work', child_session_id: 'child-1', pid_or_unit: 'dsh-bg-t1', started_at: TEST_NOW - 1, deadline: TEST_NOW + 60, log_path: '/opt/logs/bg-t1/output.log' });
  const receipts = [];
  const tools = createTools({
    store,
    retrieve: () => [],
    platform: { capabilities: {}, now: () => TEST_NOW * 1000, log() {} },
    clock: () => TEST_NOW * 1000,
    timeZone: 'UTC',
    bgConfig: () => normalizeConfig({}),
    bgLauncher: { signal: async () => true },
    taskReceipt: async (info) => { receipts.push(info); },
  });
  const cancel = tools.find((tool) => tool.name === 'task_cancel');
  const result = await cancel.execute({ taskId: 'bg-t1' });
  assert.equal(result.ok, true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt, canonical, 'task_cancel 站点与生成器逐字一致');
  const indexSource = readFileSync('src/index.js', 'utf8');
  assert.match(indexSource, /buildCancelMessage\(job\),/u, '/停止任务 站点也走生成器');
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && readFileSync(full, 'utf8').includes('已取消（用户主动停止）')) hits.push(relative('.', full));
    }
  };
  walk('src');
  assert.deepEqual(hits.map((hit) => hit.replaceAll('\\', '/')).sort(), ['src/task/bg-jobs.js'], '字面量只允许出现在生成器里');
  store.close();
});
