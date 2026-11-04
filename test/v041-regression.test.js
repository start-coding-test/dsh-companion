/**
 * v0.4.1 集成/回归测试（独立于 E-M1/S-M1 的单元测试）。
 *
 * 覆盖四类用户可见回归：
 *   1) E-M1：走真实 recall（retrieve）路径验证 local embedding 首载超时回退 FTS、
 *      加载完成后下一轮走向量路径；
 *   2) E-M1 错误分类：缺依赖 → fatal 停用；首次网络错 → transient 退避后可恢复；
 *   3) S-M1：注入后复述升级 reneed_kind='used'、同会话「来源 episode 仍在 surface」
 *      标 same_context 并被 S0 统计排除、L-2 长确认句不触发 α=4；
 *   4) 迁移：真实 v7 旧库 fixture 打开后升到当前版本（v10），重复打开幂等且数据不丢。
 *
 * 全部使用临时库与注入 loader，不联网、不读真实时间。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { apply } from '../src/index.js';
import { createEmbedder } from '../src/memory/embedders/index.js';
import {
  CONFIRM_MAX_CHARS,
  isConfirmation,
} from '../src/memory/reinforce.js';
import { retrieve } from '../src/memory/retrieve.js';
import { Store } from '../src/memory/store.js';
import { FakeCtx } from './fakes/ctx.js';
import { TEST_NOW, makeTempStore, seedMemory } from './e2e/helpers.js';

const DAY_SEC = 86_400;
const DIM = 512;
const NOW_MS = TEST_NOW;

/** 测试内定时器登记，结束前清理。 */
const timers = new Set();

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

function fakeModule() {
  return {
    pipeline: async () => async (batch) => batch.map(() => new Array(DIM).fill(0.25)),
  };
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v041-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addFact(store) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: '晨星',
    statement: '项目代号是晨星',
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: Math.floor(NOW_MS / 1000) - DAY_SEC,
    last_reinforced_at: Math.floor(NOW_MS / 1000) - DAY_SEC,
  });
}

function localVector() {
  return Object.freeze({ enabled: true, dim: DIM, embedder: 'local' });
}

/** apply 需要的 commands/tools/llm 平台服务（本文件只走 pre-step）。 */
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

function reinforcementEvents(store, factId) {
  return store
    .listEvents({ action: 'REINFORCE', row_id: factId })
    .map((event) => ({ ...event, detail: JSON.parse(event.detail_json) }));
}

test('E-M1 集成：local 首载超时，真实召回 300ms 内回退 FTS；加载完成后下一轮走向量', async () => {
  try {
    await withStore(async (store) => {
      addFact(store);
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      // 5s 后才可能完成加载（gate 提前释放则立即完成）：模拟首次下载/ONNX 初始化。
      const embedder = createEmbedder(
        { embedder: 'local', dim: DIM, embedTimeoutMs: 300 },
        {
          loader: async () => {
            await Promise.race([gate, delay(5000)]);
            return fakeModule();
          },
        },
      );
      // E-M1：预热不阻塞 turn 路径。
      embedder.warmup().catch(() => {});

      const started = Date.now();
      const first = await retrieve({
        store,
        query: '项目代号',
        now: NOW_MS,
        vector: localVector(),
        embedder,
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1000, `首轮召回不得等待模型加载，实际 ${elapsed}ms`);
      assert.equal(first.vectorError.kind, 'transient');
      assert.equal(first.vectorError.code, 'EMBEDDING_TIMEOUT');
      assert.equal('vectorHits' in first, false, '未拿到查询向量时走纯 FTS');
      assert.ok(first.items.some((item) => item.text.includes('晨星')), 'FTS 结果照常返回');

      // 加载完成后：同一召回接口走向量路径，不再返回 vectorError。
      release();
      await embedder.warmup();
      assert.equal(embedder.status(), 'ready');
      const second = await retrieve({
        store,
        query: '项目代号',
        now: NOW_MS,
        vector: localVector(),
        embedder,
      });
      assert.equal(second.vectorError, undefined);
      assert.equal('vectorHits' in second, true, '加载完成后应走向量召回路径');
      assert.equal(second.vectorHits, 0, '尚无投影时命中数为 0，但路径已是向量');
    });
  } finally {
    clearTimers();
  }
});

test('E-M1 集成：缺依赖 → fatal 停用 local，真实召回回退 FTS 且不再 import', async () => {
  await withStore(async (store) => {
    addFact(store);
    let loads = 0;
    const embedder = createEmbedder(
      { embedder: 'local', dim: DIM, embedTimeoutMs: 300 },
      {
        loader: async () => {
          loads += 1;
          throw Object.assign(new Error("Cannot find module '@huggingface/transformers'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        },
      },
    );
    await assert.rejects(embedder.warmup(), (error) => {
      assert.equal(error.kind, 'fatal');
      assert.equal(error.fatal, true);
      return true;
    });
    assert.equal(embedder.disabled, true);
    assert.equal(embedder.status(), 'fatal');

    const result = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(result.vectorError.kind, 'fatal');
    assert.equal(result.vectorError.fatal, true);
    assert.equal('vectorHits' in result, false);
    assert.ok(result.items.some((item) => item.text.includes('晨星')), '停用后仍返回 FTS');

    // 第二次召回不得再次尝试 import。
    await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(loads, 1, 'fatal 后不再 import');
  });
});

test('E-M1 集成：首次网络错 → transient 退避，窗口过后真实召回恢复向量路径', async () => {
  await withStore(async (store) => {
    addFact(store);
    let loads = 0;
    // 退避窗口留足余量（300ms），避免并发下计时器在断言前到期。
    const retryBaseMs = 300;
    const embedder = createEmbedder(
      { embedder: 'local', dim: DIM, embedTimeoutMs: 300 },
      {
        retryBaseMs,
        loader: async () => {
          loads += 1;
          if (loads === 1) {
            throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
          }
          return fakeModule();
        },
      },
    );

    // 首次失败：真实召回降级 FTS，且本轮不抛错。
    const first = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(first.vectorError.kind, 'transient');
    assert.equal(first.vectorError.fatal, false);
    assert.ok(first.items.some((item) => item.text.includes('晨星')));
    assert.equal(embedder.status(), 'backoff');

    // 退避窗口内再次召回：复用同一 transient 错误，不再打网络。
    const during = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(during.vectorError.transient, true);
    assert.equal(loads, 1, '退避窗口内不得重试加载');

    // 显式越过退避窗口：恢复加载并走向量路径。
    await new Promise((resolve) => {
      setTimeout(resolve, retryBaseMs + 80);
    });
    const after = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(after.vectorError, undefined);
    assert.equal('vectorHits' in after, true);
    assert.equal(loads, 2);
    assert.equal(embedder.status(), 'ready');
  });
});

test('S-M1 集成：来源 episode 仍在 surface → same_context=1，复述升级 used 且统计排除', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const at = Math.floor(TEST_NOW / 1000);
  const consolidation = temp.store.insertConsolidation({
    scope: 'main',
    session_id: 'e2e-main',
    kind: 'nap',
    trigger: 'idle',
    upto_seq: 2,
    status: 'written',
    started_at: at - 30 * DAY_SEC,
    finished_at: at - 30 * DAY_SEC,
  });
  // 来源 episode 关联到该巩固；fact 的 created_at 很旧（Δt > 6h，observed_at 保持
  // 新鲜以便召回），只有「来源仍在 surface」这一条路径能判定为同会话即时召回。
  temp.store.db
    .prepare('UPDATE episodes SET consolidation_id = ? WHERE id = ?')
    .run(consolidation.id, seeded.episodeId);
  temp.store.db
    .prepare(
      'UPDATE facts SET created_at = ?, observed_at = ?, last_reinforced_at = ?, strength_days = 365 WHERE id = ?',
    )
    .run(at - 30 * DAY_SEC, at, at, seeded.factId);

  const ctx = makeApplyCtx();
  // surface 里保留 seq 1..3；巩固 upto_seq=2 仍在 surface。
  const session = ctx.addSession({ id: 'session-1' });
  for (const seq of [1, 2, 3]) {
    ctx.appendEvent(session.id, {
      seq,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: `更早的第 ${seq} 轮对话。` }] },
    });
  }
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 365 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const first = await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？']), session),
    { kind: 'enter', messages: [] },
  );
  assert.match(JSON.stringify(first ?? {}), /蓝鲸/u, '应先注入该 fact');

  const recalled = temp.store.getFact(seeded.factId);
  assert.equal(recalled.reneed_kind, 'recall');
  assert.equal(recalled.first_reneed_at, at);
  assert.equal(recalled.same_context, 1, '来源 episode 仍在 surface → 同会话样本');
  assert.equal(
    temp.store.db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE reneed_kind IS NOT NULL AND same_context = 0')
      .get().n,
    0,
    '同会话样本不得进入 S0 统计口径',
  );

  // 下一轮 assistant 复述 → 强化用上，升级 used，但保留首次时间与同会话标记。
  ctx.advance(60_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '谢谢。'],
      ),
      session,
    ),
    { kind: 'enter', messages: [] },
  );
  const used = temp.store.getFact(seeded.factId);
  assert.equal(used.reneed_kind, 'used', '复述用上应升级为 used');
  assert.equal(used.first_reneed_at, at, '升级不覆盖首次样本时间');
  assert.equal(used.same_context, 1, '升级保留同会话标记');
  const events = reinforcementEvents(temp.store, seeded.factId);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.alpha, 2);
});

test('L-2：确认句长度上限——>10 字不触发 α=4，短确认句触发', () => {
  // 边界：去标点后 10 字仍算短确认，11 字即判为带新内容的长句。
  assert.equal(isConfirmation('对，我明天要去北京开会'), true, '10 字应仍在确认上限内');
  assert.equal(isConfirmation('对，我明天要去北京开会啊'), false, '11 字应超出确认上限');
  assert.equal(isConfirmation('对'), true);
  assert.equal(isConfirmation('嗯，对。'), true);
  assert.equal(isConfirmation('对，我明天要去北京开会，顺便把资料带上'), false);
  assert.equal(
    isConfirmation('没错，就是蓝鲸，记住了，这次别再忘了'),
    false,
    '带新内容的长确认句不得触发 α=4',
  );
  assert.equal(CONFIRM_MAX_CHARS, 10);
});

test('L-2 集成：长确认句 + 复述 → α=2（而不是 α=4）', async (t) => {
  const temp = makeTempStore();
  const seeded = seedMemory(temp.store, { now: TEST_NOW, statement: '青柠计划的代号是蓝鲸。' });
  const ctx = makeApplyCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(1, messages(['user', '青柠计划的代号是什么？'])),
    { kind: 'enter', messages: [] },
  );
  ctx.advance(86_400_000);
  await ctx.dispatch(
    'agent/pre-step',
    turnPayload(
      2,
      messages(
        ['user', '青柠计划的代号是什么？'],
        ['assistant', '青柠计划的代号是蓝鲸。'],
        ['user', '对，我明天要去北京开会，顺便把资料带上。'],
      ),
    ),
    { kind: 'enter', messages: [] },
  );

  const after = temp.store.getFact(seeded.factId);
  const R = Math.exp(-1 / 14);
  const expected = 14 * (1 + 2 * (1 - R)) + 1;
  assert.equal(after.recall_count, 1);
  assert.ok(Math.abs(after.strength_days - expected) < 1e-6, '长确认句只能使用 α=2');
  const events = reinforcementEvents(temp.store, seeded.factId);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.alpha, 2);
});

/** v7 facts DDL（v8 起补 same_context，v9 起再补 first_used_*）：用于构造真实旧库 fixture。 */
const V7_FACTS_SQL = `
CREATE TABLE facts (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  kind                TEXT NOT NULL CHECK (kind IN ('identity','relation','preference','project','knowledge','other')),
  subject_id          TEXT REFERENCES entities(id),
  subject_text        TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_text         TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_explicit','turn','task','consolidated','inferred')),
  source_episode_id   TEXT REFERENCES episodes(id),
  source_excerpt      TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  observed_at         INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_to            INTEGER,
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','superseded','tombstoned')),
  superseded_by       TEXT REFERENCES facts(id),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  first_reneed_at     INTEGER,
  first_reneed_tier   TEXT,
  reneed_kind         TEXT,
  CONSTRAINT ck_fact_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                   OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
`;

test('migrate：真实 v7 旧库 fixture 升 v10，幂等且数据不丢', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v041-v7-'));
  const path = join(dir, 'companion.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1) 用裸 SQLite 造一个「v7 形状」的旧库（无 same_context、无 first_used_*、无 W5 触发器）。
  const raw = new DatabaseSync(path);
  try {
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.exec(V7_FACTS_SQL);
    raw.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '7');
    raw.prepare(
      `INSERT INTO facts (
         id, scope, kind, subject_text, predicate, object_text, statement,
         source_kind, salience, observed_at, strength_days, last_reinforced_at,
         first_reneed_at, first_reneed_tier, reneed_kind
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'fact_v7_keep',
      'main',
      'project',
      '青柠计划',
      '代号',
      '蓝鲸',
      '青柠计划的代号是蓝鲸。',
      'user_explicit',
      'normal',
      1_700_000_000,
      14,
      1_700_000_000,
      1_700_000_100,
      'clear',
      'recall',
    );
  } finally {
    raw.close();
  }

  // 2) 打开两次：每次都必须升到 v10，且旧行/首次样本原样保留（first_used_* 为 NULL）。
  for (let round = 0; round < 2; round += 1) {
    const store = Store.open(path);
    try {
      assert.equal(store.getMeta('schema_version'), '10', `第 ${round + 1} 次打开应升到 v10`);
      const columns = store.db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name);
      assert.equal(columns.filter((name) => name === 'same_context').length, 1);
      const row = store.getFact('fact_v7_keep');
      assert.ok(row, '旧数据不得丢失');
      assert.equal(row.statement, '青柠计划的代号是蓝鲸。');
      assert.equal(row.first_reneed_at, 1_700_000_100, 'v7 首次样本时间保留');
      assert.equal(row.first_reneed_tier, 'clear');
      assert.equal(row.reneed_kind, 'recall');
      assert.equal(row.same_context, 0, '旧行 same_context 默认 0');
      // v8 触发器生效：非法 reneed_kind 被拒。
      assert.throws(
        () => store.db.prepare("UPDATE facts SET reneed_kind = 'bogus' WHERE id = 'fact_v7_keep'").run(),
        /invalid facts\.reneed_kind/u,
      );
    } finally {
      store.close();
    }
  }
});
