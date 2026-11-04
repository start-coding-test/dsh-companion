/**
 * v0.4.2 集成/回归测试（S2-M1 + L2-1 + E2-M1 + L2-3）。
 *
 * 覆盖评审 review-code-v0.4.1 指出的四个口径问题：
 *   1) 「刚写入就被注入、几天后真被用上」：same_context 与 Δt 取用上那一刻，
 *      不能被 1 小时前的注入样本吞掉（first_used_at=+3d、used_same_context=0、
 *      Δt=3d）；
 *   2) 首次注入未用、第二次注入才用上：取第二次「用上」的时刻；
 *   3) 非 same_context 用上覆盖同会话用上一次，之后不再覆盖；
 *   4) observed_at 口径：created_at 很旧但原话时间新鲜时仍判同会话（来源不在
 *      surface 也一样）。
 *
 *   5) E2-M1：回填走独立超时与默认批量 8，50 条 fake 推理全部写入；
 *   6) E2-M1：连续两次 idle-probe 只有一个推理、查询撞上回填占用回退 FTS；
 *   7) L2-3：loadTimeoutMs 只放弃等待，重试复用同一个加载 promise。
 *
 * 全部使用临时库与 FakeCtx 手动时钟/转录，不联网、不读真实时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, backfillVectors, retrieveVectors } from '../src/index.js';
import { retrieve } from '../src/memory/retrieve.js';
import { EmbeddingTimeout } from '../src/memory/embedders/index.js';
import { createLocalEmbedder } from '../src/memory/embedders/local.js';
import { DEFAULTS } from '../src/config.js';
import { FakeCtx } from './fakes/ctx.js';
import { TEST_NOW, makeTempStore, seedMemory } from './e2e/helpers.js';

const DAY_SEC = 86_400;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DIM = 512;
const MODEL = 'Xenova/bge-small-zh-v1.5';
const VECTOR_NOW_MS = TEST_NOW;
const VECTOR_NOW_SEC = Math.floor(VECTOR_NOW_MS / 1000);

/** apply 需要的 commands/tools/llm 平台服务（只走 pre-step）。 */
function makeApplyCtx() {
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
  ctx.llm = {
    listProviders: () => [],
    listModels: () => [],
    async *stream() {
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  return ctx;
}

function messages(...rows) {
  return rows.map(([role, text]) => ({ role, content: [{ type: 'text', text }] }));
}

function turnPayload(turn, msgs, session = { id: 'session-1' }, step = 1) {
  return {
    agent: { id: 'agent-1', session },
    messages: msgs,
    turn,
    step,
  };
}

test('S2-M1 集成：1h 前的注入样本不得吞掉 3 天后的真实用上', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // t0+1h：首次注入（recall 样本，Δt<6h → same_context=1，统计时排除）。
  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.reneed_kind, 'recall');
  assert.equal(recalled.first_reneed_at, at + 3600);
  assert.equal(recalled.same_context, 1, '注入时仍在同会话窗口内');
  assert.equal(recalled.first_used_at, null, '尚未被用上');

  // t0+3d：assistant 复述 → 真正用上；同一份 1h 前的注入样本不能让这次算
  // 同会话，Δt 也必须从 observed_at 起算 3 天。
  ctx.advance(3 * DAY_MS - HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '谢谢。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );

  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 3 * DAY_SEC, '用上时间取用上那一刻');
  assert.equal(used.first_used_tier, 'clear');
  assert.equal(used.used_same_context, 0, '跨会话用上，不得沿用注入时的 same_context=1');
  assert.equal(used.first_reneed_at, at + 3600, 'recall 样本保持首次注入时间作对照');
  assert.equal(used.same_context, 1, 'recall 的同会话标记不被改写');
  assert.equal(
    used.first_used_at - used.observed_at,
    3 * DAY_SEC,
    'Δt 用 observed_at 口径应为 3 天',
  );

  // 再来一次用上：已有非 same_context 记录，不再覆盖。
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      3,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '知道了。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const again = temp.store.getFact(seeded.factId);
  assert.equal(again.first_used_at, at + 3 * DAY_SEC, '首次跨会话用上保持不被覆盖');
  assert.equal(again.used_same_context, 0);
});

test('S2-M1 集成：首次注入未用、第二次注入才用上 → 取第二次用上时刻', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // 第 1 次注入（t0+1h）：用户只问不确认，assistant 也没有复述该事实。
  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  assert.equal(temp.store.getFact(seeded.factId).first_used_at, null);

  // 第 2 次注入（t0+2d）：仍未用上，但注入样本会更新为本次时刻。
  ctx.advance(2 * DAY_MS - HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(['user', '青柠计划的代号是？'], ['assistant', '我先查一下。'], ['user', '好']),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const secondRecall = temp.store.getFact(seeded.factId);
  assert.equal(secondRecall.first_reneed_at, at + 3600, 'first_reneed_* 仍是首次注入');
  assert.equal(secondRecall.first_used_at, null);

  // t0+3d：复述该事实 → 用上；时间必须是这次用上，而不是第 1/2 次注入。
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      3,
      messages(
        ['user', '青柠计划的代号是？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '好。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 3 * DAY_SEC, '首次用上取第二次之后的实际用上时刻');
  assert.equal(used.used_same_context, 0);
  assert.equal(used.first_used_at - used.observed_at, 3 * DAY_SEC);
});

test('L2-1 集成：created_at 很旧但 observed_at 新鲜 → 仍判同会话（来源不在 surface）', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  // 模拟延迟巩固：事实 30 天前写入，但原话发生在 1 小时前；来源 episode 没有
  // 关联巩固 → 不走「仍在 surface」路径，只能靠 observed_at 判定。
  temp.store.db
    .prepare(
      'UPDATE facts SET created_at = ?, observed_at = ?, last_reinforced_at = ?, strength_days = 365 WHERE id = ?',
    )
    .run(at - 30 * DAY_SEC, at, at, seeded.factId);

  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.same_context, 1, 'Δt 应相对 observed_at 的 1h，而不是 created_at 的 30d');

  // 同一会话内 10 分钟后就复述用上：按 observed_at 仍是同会话样本。
  ctx.advance(10 * 60_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '好。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.used_same_context, 1, '用上时按 observed_at 重算仍为同会话');
  assert.equal(
    used.first_used_at,
    at + 4200,
    '用上时间取实际复述时刻',
  );
});

// ───────────────────────── E2-M1 + L2-3 ─────────────────────────

const timers = new Set();

/** 真实短延时（fake extractor 用）；unref 保证不会拖住进程。 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  });
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

/** 每条文本 20ms（可覆盖）的 fake extractor；calls 记录每批文本数。 */
function slowModule({ msPerText = 20, gate = null } = {}) {
  const calls = [];
  const perText = typeof msPerText === 'function' ? msPerText : () => msPerText;
  return {
    calls,
    module: {
      pipeline: async () => async (batch) => {
        calls.push(batch.length);
        if (gate !== null) await gate;
        await delay(batch.length * perText());
        return batch.map(() => new Array(DIM).fill(0.25));
      },
    },
  };
}

/** 回填测试的最小 state（指标记录 + 日志缓冲）。 */
function makeVectorState(store, embedder, vector = {}) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    state: {
      store,
      embedder,
      config: { vector: { enabled: true, ...vector } },
      metrics: {
        inc(name, value = 1) {
          calls.push({ name, value });
        },
        snapshot() {
          const out = {};
          for (const call of calls) out[call.name] = (out[call.name] ?? 0) + call.value;
          return out;
        },
      },
      platform: {
        log(level, message, meta) {
          logs.push({ level, message, meta });
        },
      },
      vectorBackfilled: 0,
    },
  };
}

/** 插入一条待回填的事实（无向量）。 */
function addVectorFact(store, n, objectText = `代号${n}`) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: objectText,
    statement: `项目代号是${objectText}`,
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: VECTOR_NOW_SEC - DAY_SEC,
    last_reinforced_at: VECTOR_NOW_SEC - DAY_SEC,
  });
}

test('E2-M1：默认批量 8，50 条 20ms 推理在回填超时下分 7 批全部写入', async (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  for (let i = 0; i < 50; i += 1) addVectorFact(temp.store, i);
  const fake = slowModule({ msPerText: 20 });
  const embedder = createLocalEmbedder({
    model: MODEL,
    // 查询超时故意压到 5ms：若回填误用查询超时，任何一批都必然超时。
    timeoutMs: 5,
    backfillTimeoutMs: 30_000,
    loader: async () => fake.module,
  });
  t.after(clearTimers);
  await embedder.warmup();
  assert.equal(embedder.status(), 'ready');
  assert.equal(embedder.timeoutMs, 5);
  assert.equal(embedder.backfillTimeoutMs, 30_000);
  temp.store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
  const { state, calls } = makeVectorState(temp.store, embedder, {
    backfillBatchSize: DEFAULTS.vector.backfillBatchSize,
  });

  const started = Date.now();
  let written = 0;
  const batches = [];
  for (let round = 0; round < 20; round += 1) {
    const n = await backfillVectors(state);
    written += n;
    if (n === 0) break;
    batches.push(fake.calls.at(-1));
  }
  const elapsed = Date.now() - started;

  assert.equal(DEFAULTS.vector.backfillBatchSize, 8, '默认回填批量必须是 8');
  assert.equal(DEFAULTS.vector.backfillTimeoutMs, 30_000);
  assert.equal(written, 50, '50 条必须全部写入，而不是被 5ms 查询超时截断');
  assert.deepEqual(batches, [8, 8, 8, 8, 8, 8, 2], '每批不超过默认批量 8');
  assert.ok(elapsed < 30_000, `应在回填超时内完成，实际 ${elapsed}ms`);
  const rows = temp.store.db
    .prepare('SELECT COUNT(*) AS n FROM fact_vectors WHERE embedder_id = ?')
    .get(embedder.id);
  assert.equal(rows.n, 50);
  assert.equal(calls.some((call) => call.name === 'vectorBackfillTimeouts'), false);
});

test('E2-M1：连续两次 idle-probe 只有一个推理，第二次记占用', async (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  addVectorFact(temp.store, 1, '晨星');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fake = slowModule({ msPerText: 5, gate });
  const embedder = createLocalEmbedder({
    model: MODEL,
    timeoutMs: 300,
    backfillTimeoutMs: 30_000,
    loader: async () => fake.module,
  });
  t.after(clearTimers);
  await embedder.warmup();
  temp.store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
  const { state, calls } = makeVectorState(temp.store, embedder, { backfillBatchSize: 8 });

  const first = backfillVectors(state);
  await delay(10);
  assert.equal(embedder.busy(), true);
  assert.equal(await backfillVectors(state), 0, '占用期间第二次探测直接跳过');
  release();
  assert.equal(await first, 1);
  assert.equal(fake.calls.length, 1, '两次 idle-probe 只允许一个推理');
  assert.equal(calls.filter((call) => call.name === 'vectorEmbedBusy').length, 1);
});

test('E2-M1：查询撞上回填占用时回退 FTS，不排队等待', async (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  addVectorFact(temp.store, 1, '晨星');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fake = slowModule({ msPerText: 5, gate });
  const embedder = createLocalEmbedder({
    model: MODEL,
    timeoutMs: 300,
    backfillTimeoutMs: 30_000,
    loader: async () => fake.module,
  });
  t.after(clearTimers);
  await embedder.warmup();
  temp.store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
  const { state } = makeVectorState(temp.store, embedder, { backfillBatchSize: 8 });

  const backfill = backfillVectors(state);
  try {
    await delay(10);
    assert.equal(embedder.busy(), true);
    const started = Date.now();
    const result = await retrieve({
      store: temp.store,
      query: '项目代号',
      now: VECTOR_NOW_MS,
      vector: { enabled: true, dim: DIM, embedder: 'local' },
      embedder,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 250, `查询不得等待回填推理，实际 ${elapsed}ms`);
    assert.equal(result.vectorError?.name, 'EmbeddingBusy');
    assert.equal(result.vectorError?.code, 'EMBEDDING_BUSY');
    assert.equal(result.vectorError?.transient, true);
    assert.ok(result.items.some((item) => item.text.includes('晨星')), 'FTS 结果照常返回');
  } finally {
    release();
    await backfill;
  }
});

test('L2-3：loadTimeoutMs 只放弃等待，重试复用同一加载 promise', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let loads = 0;
  const embedder = createLocalEmbedder({
    model: MODEL,
    timeoutMs: 300,
    loadTimeoutMs: 20,
    loader: async () => {
      loads += 1;
      await gate;
      return slowModule().module;
    },
  });
  t.after(clearTimers);
  await assert.rejects(embedder.warmup(), (error) => error instanceof EmbeddingTimeout);
  assert.equal(loads, 1);
  assert.equal(embedder.status(), 'loading', '底层加载未被取消，仍是 loading');

  await assert.rejects(embedder.warmup(), (error) => error instanceof EmbeddingTimeout);
  assert.equal(loads, 1, '重试必须复用未结束的加载 promise');

  release();
  await embedder.warmup();
  assert.equal(embedder.status(), 'ready');
  assert.equal(loads, 1);
});

test('L2-1 集成：延迟巩固不缩短 Δt（7 小时前原话仍判跨会话）', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  // 延迟巩固：原话（observed_at）发生在 7 小时前，直到刚刚才被巩固写入
  // （created_at/last_reinforced_at 都是 at）。若用巩固时刻计时，1 小时后注入
  // 的 Δt 会被缩短成 1h → 误判同会话；L2-1 要求取 observed_at（此时 Δt=8h）。
  temp.store.db
    .prepare(
      'UPDATE facts SET created_at = ?, observed_at = ?, last_reinforced_at = ?, strength_days = 365 WHERE id = ?',
    )
    .run(at, at - 7 * 3600, at, seeded.factId);

  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  ctx.advance(HOUR_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.reneed_kind, 'recall');
  assert.equal(recalled.first_reneed_at, at + 3600);
  assert.equal(
    recalled.same_context,
    0,
    'Δt 应为 observed_at 起的 8h，不能被刚刚的巩固时刻缩短成同会话',
  );

  // 用上时同样按 observed_at 重算：仍是非同会话样本。
  ctx.advance(10 * 60_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '好。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 4200);
  assert.equal(used.used_same_context, 0, '用上时 Δt 仍取 observed_at 的 8h10m');
  assert.equal(
    used.first_used_at - used.observed_at,
    8 * 3600 + 600,
    'Δt 必须从原话时间起算，不被巩固时刻缩短',
  );
  assert.equal(used.first_reneed_at, at + 3600, 'recall 样本保持首次注入时刻');
});

test('M-1 回归：index 档注入被用上后，后续 full 注入不得把 used 降级回 recall', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  // 让 R 在 t0+6d 落到 index 档（>=0.05 且 <0.2）：strength=3d、Δt=6d → R≈0.135。
  temp.store.db
    .prepare('UPDATE facts SET strength_days = 3 WHERE id = ?')
    .run(seeded.factId);
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // t0+6d：index 档注入。index 档不写 recall 样本（first_reneed_at 保持 NULL），
  // 但 fact 已进入 lastRecalledIds/tier 表，下一轮复述即可判为「用上」。
  ctx.advance(6 * DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), { id: 'session-1' }),
    { kind: 'enter', messages: [] },
  );
  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.first_reneed_at, null, 'index 档不写 recall 样本');
  assert.equal(recalled.reneed_kind, null);
  assert.equal(recalled.first_used_at, null);

  // 紧接着复述 → 用上。档位必须是本轮注入的 index（miss），不能拿库内
  // fidelity=full 猜成 clear（L-4）。
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '谢谢。'],
      ),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used');
  assert.equal(used.first_used_at, at + 6 * DAY_SEC, '用上时间取用上那一刻');
  assert.equal(used.first_used_tier, 'miss', '档位取本轮实际注入档（index→miss）');
  assert.equal(used.used_same_context, 0);
  assert.equal(used.first_reneed_at, null, 'used 行允许没有 recall 样本');

  // 强化后强度上升；等一天让它以 full 档再次注入（R≈0.99）。
  temp.store.db
    .prepare('UPDATE facts SET strength_days = 100 WHERE id = ?')
    .run(seeded.factId);
  ctx.advance(DAY_MS);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      3,
      messages(['user', '青柠计划的代号？'], ['assistant', '是蓝鲸。'], ['user', '好。']),
      { id: 'session-1' },
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  assert.equal(after.reneed_kind, 'used', '后续 recall 样本不得把 used 降级');
  assert.equal(after.first_used_at, used.first_used_at, 'first_used_at 不得被改写');
  assert.equal(after.first_used_tier, 'miss');
  assert.equal(after.first_reneed_at, null, '不得补写晚于 first_used_at 的 recall 样本');

  const mainSamples = temp.store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM facts
        WHERE reneed_kind = 'used' AND used_same_context = 0
          AND first_used_at IS NOT NULL AND observed_at > 0`,
    )
    .get();
  assert.equal(mainSamples.n, 1, 'S0 主样本 SQL 必须命中 1 行');
  const recallSamples = temp.store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE reneed_kind = 'recall'")
    .get();
  assert.equal(recallSamples.n, 0, 'used 行不得被 recall 对照误计');
});

test('L-1：查询撞上推理占用只记 vectorEmbedBusy，不虚增 failures/warn', async (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  addVectorFact(temp.store, 1, '晨星');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fake = slowModule({ msPerText: 5, gate });
  const embedder = createLocalEmbedder({
    model: MODEL,
    timeoutMs: 300,
    backfillTimeoutMs: 30_000,
    loader: async () => fake.module,
  });
  t.after(clearTimers);
  await embedder.warmup();
  temp.store.configureVectors({ id: embedder.id, dim: embedder.dim, embed: null });
  const { state, calls, logs } = makeVectorState(temp.store, embedder, { backfillBatchSize: 8 });

  const backfill = backfillVectors(state);
  try {
    await delay(10);
    assert.equal(embedder.busy(), true);
    // 回填占用期连续两次查询：都回退 FTS，只记 busy。
    for (let i = 0; i < 2; i += 1) {
      const result = await retrieveVectors(state, {
        store: temp.store,
        query: '项目代号',
        now: VECTOR_NOW_MS,
        vector: { enabled: true, dim: DIM, embedder: 'local' },
      });
      assert.equal(result.vectorError?.code, 'EMBEDDING_BUSY');
      assert.ok(result.items.some((item) => item.text.includes('晨星')), 'FTS 结果照常返回');
    }
    const snapshot = state.metrics.snapshot();
    assert.equal(snapshot.vectorEmbedBusy, 2, '每次查询记一次占用');
    assert.equal(snapshot.vectorEmbedFailures, undefined, '占用不得计入失败');
    assert.equal(
      logs.filter((entry) => entry.level === 'warn' && entry.message.includes('embedding failed')).length,
      0,
      '占用不打 warn（降为 debug）',
    );
  } finally {
    release();
    await backfill;
  }
});
