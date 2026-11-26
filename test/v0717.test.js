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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Store } from '../src/memory/store.js';
import { BG_JOB_STATES, buildCancelMessage, cancelBgJob, monitorBgJobs } from '../src/task/bg-jobs.js';
import { resolveStopTarget } from '../src/task/stop-target.js';
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

// v0.7.21 H2：bg_jobs.started_at/deadline 是 Unix 秒（insertBgJob 走 epochOr）；
// 原种子直接把毫秒 TEST_NOW 写进秒字段，只是靠 monitor 的 nowMs 数值巧合才对上。
const TEST_NOW_SEC = Math.floor(TEST_NOW / 1000);

function seedJob(store, overrides = {}) {
  store.insertBgJob({
    id: 'bg-l5',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    pid_or_unit: 'dsh-bg-l5',
    started_at: TEST_NOW_SEC - 10,
    deadline: TEST_NOW_SEC + 600,
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
    platform: { now: () => TEST_NOW, log() {}, agentBySessionId: () => ({ id: 'agent-main' }), sendToSubagent: async () => { throw new Error('UNAUTHORIZED'); } },
    proactive: { enqueue: () => ({ queued: true, duplicate: false }), flush: async () => ({}) },
    im: { available: true, mode: 'session' },
    mainSessionId: 's-main',
  };
  await monitorBgJobs({
    store,
    config,
    wake: (info) => wakeBgJob(state, info),
    nowMs: TEST_NOW,
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
    { exitCode: 0, deadline: TEST_NOW_SEC + 600, expect: BG_JOB_STATES.wokenFallback },
    { exitCode: 143, deadline: TEST_NOW_SEC - 5, expect: BG_JOB_STATES.timeout },
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
      nowMs: TEST_NOW,
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
    nowMs: TEST_NOW,
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
    nowMs: TEST_NOW,
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
    nowMs: TEST_NOW,
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
  seedJob(store, { deadline: TEST_NOW_SEC - 5 });
  let queried = 0;
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW,
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
  seedJob(store, { deadline: TEST_NOW_SEC - 5 });
  let queried = 0;
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    nowMs: TEST_NOW,
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
  store.insertBgJob({ id: 'bg-t1', label: '训练', argv: ['python3', '/opt/work/train.py'], cwd: '/opt/work', child_session_id: 'child-1', pid_or_unit: 'dsh-bg-t1', started_at: TEST_NOW_SEC - 1, deadline: TEST_NOW_SEC + 60, log_path: '/opt/logs/bg-t1/output.log' });
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
  // L1（v0.7.17）：task_cancel 只受理（claim cancelling + TERM），不再自己发回执；
  // 取消回执的唯一消费站点是 monitor 的 deliverCancel，正文必须逐字来自生成器。
  assert.equal(receipts.length, 0, '工具层不再直发取消回执');
  assert.equal(result.state, 'cancelling');
  const delivered = [];
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async ({ job: settled }) => { delivered.push(buildCancelMessage(settled)); return { delivered: true }; },
    nowMs: TEST_NOW,
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: true, exitCode: 143 }),
      signalBgProcess: async () => true,
      unitResult: async () => null,
      readExitCode: () => 143,
      tailLog: () => '',
      capLogFile: () => false,
    },
  });
  assert.equal(summary.cancelled, 1);
  assert.deepEqual(delivered, [canonical], 'monitor 站点回执与生成器逐字一致');
  const indexSource = readFileSync('src/index.js', 'utf8');
  assert.match(indexSource, /buildCancelMessage\(job\),/u, '/停止任务 的收敛回执也走生成器（deliverCancel 接线）');
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


// ---------------------------------------------------------------- L1（v0.7.17 第 3 步）

const NOW_S = Math.floor(TEST_NOW / 1000);

/** 造一条 running 的 bg 行（其余列用测试默认值）。 */
function seedBgJob(store, id, extra = {}) {
  store.insertBgJob({
    id,
    label: extra.label ?? '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: extra.child_session_id ?? 'child-1',
    pid_or_unit: extra.pid_or_unit ?? `dsh-bg-${id}`,
    started_at: NOW_S - 10,
    deadline: NOW_S + 3600,
    log_path: `/opt/logs/${id}/output.log`,
  });
}

/** monitor 用的替身 launcher：probe 结果由入参决定，其余不关心。 */
function fakeLauncher(probeResult, signals = []) {
  return {
    probeBgProcess: async () => probeResult,
    signalBgProcess: async (args) => { signals.push(args); return true; },
    unitResult: async () => null,
    readExitCode: () => (Number.isInteger(probeResult.exitCode) ? probeResult.exitCode : null),
    tailLog: () => '',
    capLogFile: () => false,
  };
}

test('L1 非真机证据：cancelling 收敛压过超时归类（exit 0 也按已取消，且零 wake）', async () => {
  const store = Store.open(':memory:');
  seedBgJob(store, 'bg-l1a');
  const cancel = await cancelBgJob({
    store, jobId: 'bg-l1a', uid: 0, nowMs: TEST_NOW,
    launcher: { signal: async () => true },
  });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.state, 'cancelling');
  const signatures = [];
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => { throw new Error('取消不应走 wake 通道'); },
    deliverCancel: async ({ job, exitCode }) => { signatures.push({ id: job.id, exitCode }); return { delivered: true }; },
    nowMs: TEST_NOW,
    launcher: fakeLauncher({ running: false, exited: true, exitCode: 0 }),
  });
  assert.equal(summary.checked, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.woken, 0);
  assert.equal(summary.timedOut, 0);
  assert.deepEqual(signatures, [{ id: 'bg-l1a', exitCode: 0 }]);
  assert.equal(store.getBgJob('bg-l1a').state, BG_JOB_STATES.cancelled);
  store.close();
});

test('L1 非真机证据：TERM 抛错 → 回滚 running、零回执，monitor 之后按普通 running 处理', async () => {
  const store = Store.open(':memory:');
  seedBgJob(store, 'bg-l1b');
  const failed = await cancelBgJob({
    store, jobId: 'bg-l1b', uid: 0, nowMs: TEST_NOW,
    launcher: { signal: async () => { throw new Error('Failed to connect to bus'); } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'stop-failed');
  assert.equal(store.getBgJob('bg-l1b').state, BG_JOB_STATES.running, '回滚 running');
  assert.equal(store.getBgJob('bg-l1b').finished_at, null, '回滚要清掉抢占时间戳');
  const delivered = [];
  const summary = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: TEST_NOW,
    launcher: fakeLauncher({ running: true, exited: false, exitCode: null }),
  });
  assert.equal(summary.running, 1);
  assert.equal(delivered.length, 0, '回滚后不应有任何取消回执');
  assert.equal(store.getBgJob('bg-l1b').state, BG_JOB_STATES.running);
  store.close();
});

test('L1 非真机证据：cancelling 不占并发槽（busy 检查仍只看 running）', () => {
  const store = Store.open(':memory:');
  seedBgJob(store, 'bg-l1c');
  store.updateBgJob('bg-l1c', { state: BG_JOB_STATES.cancelling, finished_at: NOW_S - 5 });
  assert.equal(store.getBgJob('bg-l1c').state, 'cancelling');
  assert.equal(store.countRunningBgJobs(), 0, '取消中不计入并发');
  assert.deepEqual(store.listBgJobs({ state: BG_JOB_STATES.running }), [], 'running 清单里没有它');
  assert.equal(store.listBgJobs({ state: BG_JOB_STATES.cancelling }).length, 1);
  store.close();
});

test('L1 非真机证据：重复取消第二次 already-cancelling，全程仍只有一条回执', async () => {
  const store = Store.open(':memory:');
  seedBgJob(store, 'bg-l1d');
  const first = await cancelBgJob({ store, jobId: 'bg-l1d', uid: 0, nowMs: TEST_NOW, launcher: { signal: async () => true } });
  assert.equal(first.ok, true);
  const second = await cancelBgJob({ store, jobId: 'bg-l1d', uid: 0, nowMs: TEST_NOW, launcher: { signal: async () => true } });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-cancelling');
  const delivered = [];
  await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: TEST_NOW,
    launcher: fakeLauncher({ running: false, exited: true, exitCode: 143 }),
  });
  assert.equal(delivered.length, 1, '只投一条');
  store.close();
});

test('L1 非真机证据：宽限期超期升级 KILL，下一轮才收敛', async () => {
  const store = Store.open(':memory:');
  seedBgJob(store, 'bg-l1e');
  await cancelBgJob({ store, jobId: 'bg-l1e', uid: 0, nowMs: TEST_NOW, launcher: { signal: async () => true } });
  const requests = store.getBgJob('bg-l1e').finished_at;
  const signals = [];
  const delivered = [];
  const stillAlive = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: (requests + 31) * 1000,
    launcher: fakeLauncher({ running: true, exited: false, exitCode: null }, signals),
  });
  assert.equal(stillAlive.running, 1);
  assert.equal(signals.length, 1, '超宽限必须升级一次 KILL');
  assert.equal(signals[0].signal, 'KILL');
  assert.equal(delivered.length, 0, '进程还活着时不发回执');
  assert.equal(store.getBgJob('bg-l1e').state, BG_JOB_STATES.cancelling);
  const settled = await monitorBgJobs({
    store,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: (requests + 60) * 1000,
    launcher: fakeLauncher({ running: false, exited: true, exitCode: 137 }),
  });
  assert.equal(settled.cancelled, 1);
  assert.equal(delivered.length, 1);
  store.close();
});

test('L1 非真机证据：重启后 cancelling 行由同一 monitor 收敛（状态在库）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0717-l1-'));
  const dbPath = join(dir, 'store.db');
  const first = Store.open(dbPath);
  seedBgJob(first, 'bg-l1f');
  await cancelBgJob({ store: first, jobId: 'bg-l1f', uid: 0, nowMs: TEST_NOW, launcher: { signal: async () => true } });
  first.close();
  const reopened = Store.open(dbPath);
  assert.equal(reopened.getBgJob('bg-l1f').state, BG_JOB_STATES.cancelling);
  const delivered = [];
  const summary = await monitorBgJobs({
    store: reopened,
    config: normalizeConfig({}),
    wake: async () => ({ delivered: true }),
    deliverCancel: async (info) => { delivered.push(info); return { delivered: true }; },
    nowMs: TEST_NOW,
    launcher: fakeLauncher({ running: false, exited: true, exitCode: 143 }),
    recovering: true,
  });
  assert.equal(summary.cancelled, 1);
  assert.equal(delivered.length, 1);
  assert.equal(reopened.getBgJob('bg-l1f').state, BG_JOB_STATES.cancelled);
  reopened.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 可能占用 */ }
});

// ---------------------------------------------------------------- L4（v0.7.17 第 3 步）

function seedTaskAudit(store, taskId, sessionId) {
  store.appendEvent({
    at: NOW_S - 5,
    action: 'USED',
    actor: 'scheduler',
    table_name: 'threads',
    row_id: taskId,
    reason: 'task_run:done',
    detail_json: { kind: 'task_run', taskId, status: 'done', sessionId },
  });
}

test('L4 非真机证据：已结束 task id → 审计 sessionId 反查唯一 running bg', async () => {
  const store = Store.open(':memory:');
  seedTaskAudit(store, 'task-l4a', 'child-l4a');
  seedBgJob(store, 'bg-l4a', { child_session_id: 'child-l4a', label: '训练' });
  const resolved = resolveStopTarget({ store, target: 'task-l4a', stopTask: () => false });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.kind, 'bg');
  assert.equal(resolved.job.id, 'bg-l4a');
  assert.equal(resolved.viaSession, true);
  // 工具层同一解析：task_cancel 用已结束 task id 也能落到这条 bg 上。
  const tools = createTools({
    store,
    retrieve: () => [],
    platform: { capabilities: {}, now: () => TEST_NOW * 1000, log() {} },
    clock: () => TEST_NOW * 1000,
    timeZone: 'UTC',
    bgConfig: () => normalizeConfig({}),
    bgLauncher: { signal: async () => true },
  });
  const cancelTool = tools.find((tool) => tool.name === 'task_cancel');
  const toolResult = await cancelTool.execute({ taskId: 'task-l4a' });
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.kind, 'bg');
  assert.equal(store.getBgJob('bg-l4a').state, BG_JOB_STATES.cancelling);
  store.close();
});

test('L4 非真机证据：同 session 多个 running bg → 只列候选不取消', () => {
  const store = Store.open(':memory:');
  seedTaskAudit(store, 'task-l4b', 'child-l4b');
  seedBgJob(store, 'bg-l4b1', { child_session_id: 'child-l4b', label: '训练 A' });
  seedBgJob(store, 'bg-l4b2', { child_session_id: 'child-l4b', label: '训练 B' });
  const resolved = resolveStopTarget({ store, target: 'task-l4b', stopTask: () => false });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'ambiguous');
  assert.equal(resolved.candidates.length, 2);
  assert.match(resolved.candidates[0].command, /train\.py/u);
  store.close();
});

test('L4 非真机证据：审计无 sessionId / bg 已 woken → 都 not-found，不猜', () => {
  const store = Store.open(':memory:');
  seedTaskAudit(store, 'task-l4c', null);
  const noSession = resolveStopTarget({ store, target: 'task-l4c', stopTask: () => false });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.reason, 'not-found');
  seedTaskAudit(store, 'task-l4d', 'child-l4d');
  seedBgJob(store, 'bg-l4d', { child_session_id: 'child-l4d' });
  store.updateBgJob('bg-l4d', { state: BG_JOB_STATES.woken });
  const woken = resolveStopTarget({ store, target: 'task-l4d', stopTask: () => false });
  assert.equal(woken.ok, false);
  assert.equal(woken.reason, 'not-found', '已唤醒的行不是可取消目标');
  store.close();
});

test('L4 非真机证据：bg 直查优先于审计回跳', () => {
  const store = Store.open(':memory:');
  // 一个 id 同时是 running bg id，也被别的 task 审计引用到另一个 bg：
  seedBgJob(store, 'bg-l4e', { child_session_id: 'child-direct', label: '直查命中' });
  seedBgJob(store, 'bg-l4e-other', { child_session_id: 'child-l4e' });
  seedTaskAudit(store, 'bg-l4e', 'child-l4e');
  const resolved = resolveStopTarget({ store, target: 'bg-l4e', stopTask: () => false });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.job.id, 'bg-l4e');
  assert.equal(resolved.viaSession, undefined, '直查命中优先，不走审计回跳');
  store.close();
});

test('L4 非真机证据：/停止任务 <已结束 task id> 走生产接线，解析到 bg 并受理取消', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0717-l4-'));
  const dbPath = join(dir, 'store.db');
  try {
    const seed = Store.open(dbPath);
    seedTaskAudit(seed, 'task-l4f', 'child-l4f');
    seedBgJob(seed, 'bg-l4f', { child_session_id: 'child-l4f', label: '训练' });
    seed.close();
    const ctx = new FakeCtx({ now: TEST_NOW });
    ctx.commands = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
    ctx.tools = { registrations: [], register(definition) { this.registrations.push(definition); return () => {}; } };
    applyCordis(strictCtx(ctx), { dbPath });
    const stop = ctx.commands.registrations.find((entry) => entry.name === 'stop-task');
    const reply = stop.handler({ rawInput: 'task-l4f' });
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /已请求中止后台任务 bg-l4f/u, 'reply 指向审计反查到的 bg');
    let state = null;
    for (let i = 0; i < 100 && state !== BG_JOB_STATES.cancelling; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const check = Store.open(dbPath);
      state = check.getBgJob('bg-l4f')?.state ?? null;
      check.close();
    }
    assert.equal(state, BG_JOB_STATES.cancelling, '生产接线要真的 claim cancelling');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 保留临时目录 */ }
  }
});
