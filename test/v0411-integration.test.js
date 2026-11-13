/**
 * v0.4.11 集成回归（t5）：三项修复在**生产接线**（apply 驱动、真实 Store / 临时库 /
 * 手动时钟）上协同工作，而不只是各自单测通过。
 *
 * 覆盖：
 *   1) V10-H1 preset 三态：未配置 → 宿主默认（createSession 实参不含 agentPreset）；
 *      配置 workspace-write → 实参带该值；配置宿主不存在的 preset → 工具返回
 *      {ok:false, reason:'preset_unknown'}，不抛异常、不写 threads / 不投递；
 *   2) G0-9 计时：apply 的巩固/压缩路径产生真实耗时行；把阈值压到 1ms 强制超阈值后，
 *      同类 warn 只出现一次，/状态 两行都带「（超阈值）」，且巩固/压缩结果照常落库
 *      （没有硬超时截断）；
 *   3) V10-L1 scrub：v12 旧库（episodes + FTS 明文）经 apply 打开后六字段与 FTS 均无
 *      明文、恰一条 scrub 审计（detail 只有计数）；第二次 apply 不改行、不加事件；
 *   4) 回归：同一 /状态 同时出现「线程 preset：」与两行耗时；schema_version 为 13。
 *
 * 说明：本文件只做集成断言，配置校验/脱敏细节由 v0411-h1-preset / v0411-g09-timing /
 * v0411-scrub 三个单测文件覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { REDACTED_CREDENTIAL } from '../src/memory/govern.js';
import { toBigrams } from '../src/memory/bigram.js';
import { TEST_NOW, makeTempStore, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** DSH 0.2.1-rc.5 实际提供的 preset；用于模拟真实宿主的白名单校验。 */
const HOST_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];
/** 宿主不存在的值（不要再用 companion-thread，避免看起来像旧硬编码）。 */
const UNKNOWN_PRESET = 'host-unknown-preset';

const PASSWORD_VALUE = '蓝鲸-7788';
const LEGACY_NOW = 1_700_000_000;

/** 巩固模型返回的草稿（与 apply-turn e2e 相同，便于断言写库成功）。 */
const DRAFT = {
  episode: {
    title: '预算调整',
    summary: '用户把项目预算调到 8000。',
    topics: ['预算'],
    salience: 'normal',
    fidelity: 'full',
  },
  facts: [
    {
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      salience: 'normal',
    },
  ],
  reminders: [],
};

/**
 * 严格 FakeCtx + commands/tools 注册记录器。
 * @param {{agentPresets?: string[]|null, now?: number}} [options]
 */
function makePluginCtx({ agentPresets = HOST_PRESETS, now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now, strict: true, agentPresets });
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
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return ctx;
}

/**
 * FakeCtx + commands/tools/llm；手动时钟可被巩固/压缩过程推进。
 * settings.streamDelayMs：巩固模型流开始前推进假时钟，模拟慢巩固。
 * @returns {{ctx: FakeCtx, streams: object[], session: object, settings: {streamDelayMs: number}}}
 */
function makeApplyCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now });
  const session = ctx.addSession({ id: 'session-1' });
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
  const streams = [];
  const settings = { streamDelayMs: 0 };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      if (settings.streamDelayMs > 0) ctx.advance(settings.streamDelayMs);
      yield { type: 'text-delta', text: JSON.stringify(DRAFT) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  // 41K tokens：hard 巩固阈值；需要避免重复巩固时测试再改回 1K。
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
  return { ctx, streams, session, settings };
}

/** @param {FakeCtx} ctx @param {object} session @param {number} turn @param {string} text @param {number} [step] */
function turnPayload(ctx, session, turn, text, step = 1) {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** @param {FakeCtx} ctx @param {string} name */
function toolOf(ctx, name) {
  const registration = ctx.tools.registrations.find((definition) => definition.name === name);
  assert.ok(registration, `必须注册工具 ${name}`);
  return registration;
}

/** @param {FakeCtx} ctx */
function statusOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  return registration.handler({ rawInput: '' }).text;
}

/** @param {FakeCtx} ctx @param {string} needle */
function warnLogs(ctx, needle) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && entry.message.includes(needle));
}

// ------------------------------------------------------- V10-H1 preset 三态

test('v0.4.11 集成：preset 未配置 → thread_run 实参不含 agentPreset，/状态 显示宿主默认', async () => {
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: ':memory:' }, { cwd: '/hooked/cwd', now: () => TEST_NOW });
  try {
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '默认 preset',
      goal: '验证宿主默认路径',
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const request = ctx.callsOf('sessionController.create')[0].args[0];
    assert.equal(Object.hasOwn(request, 'agentPreset'), false, '未配置时不得传 agentPreset（null/空串也不行）');
    assert.match(statusOf(ctx), /^线程 preset：宿主默认$/mu);
  } finally {
    handle.dispose();
  }
});

test('v0.4.11 集成：preset 配置合法 → createSession 实参带配置值，/状态 标注来源', async () => {
  const ctx = makePluginCtx();
  const handle = apply(
    ctx,
    { dbPath: ':memory:', thread: { agentPreset: 'workspace-write' } },
    { cwd: '/hooked/cwd', now: () => TEST_NOW },
  );
  try {
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '配置 preset',
      goal: '验证配置路径',
    });
    assert.equal(result.ok, true, JSON.stringify(result));

    const request = ctx.callsOf('sessionController.create')[0].args[0];
    assert.equal(request.agentPreset, 'workspace-write');
    assert.match(
      statusOf(ctx),
      /^线程 preset：workspace-write（配置：thread\.agentPreset）$/mu,
    );
  } finally {
    handle.dispose();
  }
});

test('v0.4.11 集成：preset 宿主不认识 → preset_unknown，不抛、不写 threads、不投递', async () => {
  const ctx = makePluginCtx();
  const handle = apply(
    ctx,
    { dbPath: ':memory:', thread: { agentPreset: UNKNOWN_PRESET } },
    { cwd: '/hooked/cwd', now: () => TEST_NOW },
  );
  try {
    // 工具 execute 不应 reject：错误被归类成模型可读的返回值。
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '未知 preset',
      goal: '应当返回 preset_unknown',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'preset_unknown');
    assert.equal(result.message, `Unknown agent preset: ${UNKNOWN_PRESET}`);

    assert.equal(ctx.callsOf('sessionController.create').length, 1, '只尝试一次，不重试');
    assert.equal(ctx.callsOf('sessionController.prompt').length, 0, '不得向未建成的会话投递');

    const listed = await toolOf(ctx, 'thread_list').execute({});
    assert.deepEqual(listed.items, [], 'preset_unknown 不得写 threads 行');

    // 配置值原样展示，便于排障（宿主列表只有运行时才知道，不做本地枚举校验）。
    assert.match(
      statusOf(ctx),
      new RegExp(`^线程 preset：${UNKNOWN_PRESET}（配置：thread\\.agentPreset）$`, 'mu'),
    );
  } finally {
    handle.dispose();
  }
});

// ------------------------------------------- G0-9 计时（超阈值不中止）

test('v0.4.11 集成：apply 巩固/压缩耗时进 /状态，超阈值只告警一次且任务照常完成', async () => {
  const temp = makeTempStore();
  const { ctx, session, streams, settings } = makeApplyCtx();
  // 巩固模型耗时 5s；阈值压到 1ms，强制走超阈值分支（但不设硬超时）。
  settings.streamDelayMs = 5_000;
  const handle = apply(
    ctx,
    {
      dbPath: temp.dbPath,
      threadIdleDays: 14,
      retainTokens: 4,
      thread: { agentPreset: 'workspace-write' },
      timing: { consolidateWarnMs: 1, compactWarnMs: 1 },
    },
  );
  try {
    // turn 1：慢巩固仍然完成——水位推进、事实/状态板落库、模型只调用一次。
    // 注意：这里不能注入固定 now 钩子，否则手动时钟推进不了，耗时永远是 0。
    const decision = await ctx.dispatch(
      'agent/pre-step',
      turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'),
      { kind: 'enter', messages: [] },
    );
    assert.ok(decision, '慢巩固不应中止 pre-step');
    await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'slow consolidation' });

    const facts = temp.store.listFacts({ scope: 'main', status: 'active' });
    assert.equal(facts.length, 1, '巩固结果必须落库（不能被阈值截断）');
    assert.match(facts[0].statement, /8000/u);
    assert.ok(temp.store.getBoardState('main').staged_revision >= 1);
    assert.equal(streams.length, 1);
    assert.equal(temp.store.getMeta('schema_version'), '15');

    const consolidateWarns = warnLogs(ctx, 'consolidation took');
    assert.equal(consolidateWarns.length, 1, `只应告警一次，实际 ${JSON.stringify(consolidateWarns)}`);
    assert.deepEqual(consolidateWarns[0].meta, {
      kind: 'consolidate',
      durationMs: 5_000,
      warnMs: 1,
      ok: true,
    });

    let status = statusOf(ctx);
    assert.match(status, /^线程 preset：workspace-write（配置：thread\.agentPreset）$/mu);
    assert.match(status, /最近巩固耗时：5\.0s（超阈值）/u);
    assert.match(status, /最近压缩耗时：—/u, '还没有压缩样本时应显示 —');

    // turn 2：让 compactRegion 走 3s（阈值 1ms），压缩同样必须完成。
    ctx.returns['tokenMeter.measure'] = {
      logRevision: 2,
      baseline: null,
      surfaceDeltaTokens: 10,
      totalTokens: 1_000,
      surfaceTokens: 1_000,
      nodes: [],
    };
    const original = ctx.compaction.compactRegion;
    let compactCalls = 0;
    ctx.compaction.compactRegion = (start, end, agent, signal) => {
      compactCalls += 1;
      ctx.advance(3_000);
      return original(start, end, agent, signal);
    };

    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 2, '现在预算额度是多少？'), {
      kind: 'enter',
      messages: [],
    });

    assert.equal(compactCalls, 1);
    assert.deepEqual(session.surface.nodes, [2, 3], '压缩应替换区间而不是中止');
    assert.equal(temp.store.getWatermark('main'), 3);
    assert.ok(temp.store.getBoardState('main').revision >= 1);

    const compactWarns = warnLogs(ctx, 'compaction took');
    assert.equal(compactWarns.length, 1, `只应告警一次，实际 ${JSON.stringify(compactWarns)}`);
    assert.deepEqual(compactWarns[0].meta, {
      kind: 'compact',
      durationMs: 3_000,
      warnMs: 1,
      ok: true,
    });

    // 回归：同一 /状态 里 preset 行与两行耗时同时存在，且都带超阈值标注。
    status = statusOf(ctx);
    assert.match(status, /^线程 preset：workspace-write（配置：thread\.agentPreset）$/mu);
    assert.match(status, /最近压缩耗时：3\.0s（超阈值）/u);
    assert.match(status, /最近巩固耗时：5\.0s（超阈值）/u);
    assert.match(status, /水位 main：3/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V10-L1 scrub（apply）

/** @param {import('node:test').TestContext} t */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-integration-'));
  if (t && typeof t.after === 'function') {
    t.after(() => rmSync(dir, { recursive: true, force: true }));
  }
  return dir;
}

/** episodes 行里会落文本的列拼起来（六字段）。 */
function episodeText(row) {
  return [
    row.title,
    row.summary,
    row.evidence,
    row.mood_evidence,
    row.topics_json,
    row.entities_json,
  ].filter((value) => typeof value === 'string').join('\n');
}

/** fts_episodes 的 bigram 投影原文。 */
function episodeFtsText(store) {
  return store.db.prepare('SELECT txt FROM fts_episodes').all()
    .map((row) => row.txt)
    .join('\n');
}

/** 含明文凭据的旧行：四字段 + topics/entities 全都带值。 */
const SENSITIVE_LEGACY_ROW = {
  id: 'ep-integration-sensitive',
  session_id: 'sess-integration-sensitive',
  title: `路由器密码 ${PASSWORD_VALUE}`,
  summary: `WiFi 密码是 ${PASSWORD_VALUE}，周末在家`,
  evidence: '用户用 SK-ABC12345 调接口',
  mood: 'neutral',
  mood_evidence: '口令：bluewhale',
  topics: [`密码 ${PASSWORD_VALUE}`, '周末'],
  entities: [`路由器密码 ${PASSWORD_VALUE}`],
};

/** 普通叙事旧行：提到「密码」但没有值，必须逐字节保持原样。 */
const NARRATIVE_LEGACY_ROW = {
  id: 'ep-integration-narrative',
  session_id: 'sess-integration-narrative',
  title: '周末去看展览',
  summary: '用户提到密码但没有给出任何值，只是聊了聊密码学',
  evidence: '展览在美术馆，门票 60 元',
  mood: 'positive',
  mood_evidence: '心情不错',
  topics: ['周末', '展览'],
  entities: ['美术馆'],
};

/** 绕过写入路径直写旧 episode + 明文 FTS（等价 v0.4.10 之前落库的数据）。 */
function insertLegacyEpisode(store, row) {
  store.db
    .prepare(
      `INSERT INTO episodes (
         id, scope, session_id, consolidation_id, started_at, ended_at, title, summary,
         evidence, topics_json, entities_json, mood, mood_evidence, salience, privacy,
         strength_days, last_reinforced_at, recall_count, fidelity, status, deleted_at,
         purge_payload
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      row.id,
      'main',
      row.session_id,
      null,
      LEGACY_NOW,
      LEGACY_NOW + 60,
      row.title,
      row.summary,
      row.evidence,
      JSON.stringify(row.topics),
      JSON.stringify(row.entities),
      row.mood,
      row.mood_evidence,
      'normal',
      'normal',
      7,
      LEGACY_NOW,
      0,
      'full',
      'active',
      null,
      null,
    );
  const projection = [row.title, row.summary, row.topics.join(' ')]
    .filter(Boolean)
    .join('\n');
  store.db
    .prepare(
      `INSERT INTO fts_episodes (rowid, txt)
       VALUES ((SELECT rowid FROM episodes WHERE id = ?), ?)`,
    )
    .run(row.id, toBigrams(projection));
}

/** 建一个 v12 形态的旧库（episodes + FTS 明文，schema_version 退回 12）。 */
function makeLegacyDb(t) {
  const dir = tempDir(t);
  const file = join(dir, 'memory.db');
  const store = Store.open(file);
  try {
    insertLegacyEpisode(store, SENSITIVE_LEGACY_ROW);
    insertLegacyEpisode(store, NARRATIVE_LEGACY_ROW);
    store.db
      .prepare("UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'")
      .run();
    // B1：空库建库时已写标记；删掉以模拟真正的 v12 旧库。
    store.db.prepare("DELETE FROM schema_meta WHERE key = 'episode_scrub_v13'").run();
  } finally {
    store.close();
  }
  return file;
}

test('v0.4.11 集成：apply 打开 v12 旧库先 scrub episodes/FTS，二次 apply 幂等', (t) => {
  const file = makeLegacyDb(t);

  // 第一次 apply：Store.open 的 v13 迁移在插件接线前完成脱敏。
  const firstCtx = makePluginCtx();
  const firstHandle = apply(
    firstCtx,
    { dbPath: file, thread: { agentPreset: 'workspace-write' } },
    { cwd: '/hooked/cwd', now: () => TEST_NOW },
  );
  firstHandle.dispose();

  let snapshot = null;
  const inspected = Store.open(file);
  try {
    assert.equal(inspected.getMeta('schema_version'), '15');

    const sensitive = inspected.getEpisode(SENSITIVE_LEGACY_ROW.id);
    const narrative = inspected.getEpisode(NARRATIVE_LEGACY_ROW.id);
    assert.ok(sensitive);
    assert.ok(narrative);

    // episodes 六字段与 fts_episodes 均不含明文。
    for (const marker of [PASSWORD_VALUE, 'abc123', 'bluewhale', 'SK-ABC12345']) {
      assert.ok(!episodeText(sensitive).includes(marker), `episode 字段仍含明文：${marker}`);
      assert.ok(!episodeFtsText(inspected).includes(marker), `fts_episodes 仍含明文：${marker}`);
    }
    assert.equal(sensitive.title, `路由器密码 ${REDACTED_CREDENTIAL}`);
    assert.equal(sensitive.summary, `WiFi 密码是 ${REDACTED_CREDENTIAL}，周末在家`);
    assert.deepEqual(JSON.parse(sensitive.topics_json), [
      `密码 ${REDACTED_CREDENTIAL}`,
      '周末',
    ]);

    // 普通叙事逐字节不变（不能因为出现「密码」二字就整段抹掉）。
    assert.equal(narrative.title, '周末去看展览');
    assert.equal(narrative.summary, '用户提到密码但没有给出任何值，只是聊了聊密码学');
    assert.equal(narrative.topics_json, JSON.stringify(NARRATIVE_LEGACY_ROW.topics));

    // 审计恰一条 scrub，detail 只有计数、不含正文。
    const events = inspected.listEvents({ action: 'scrub' });
    assert.equal(events.length, 1);
    assert.equal(events[0].table_name, 'episodes');
    assert.equal(events[0].reason, 'v13-legacy-episode-scrub');
    assert.deepEqual(JSON.parse(events[0].detail_json), { scanned: 2, changed: 1 });
    assert.ok(!events[0].detail_json.includes(PASSWORD_VALUE));
    assert.ok(!events[0].detail_json.includes('密码'));

    snapshot = {
      rows: inspected.db.prepare('SELECT * FROM episodes ORDER BY rowid ASC').all(),
      fts: episodeFtsText(inspected),
      scrubEvents: events.length,
    };
  } finally {
    inspected.close();
  }

  // 第二次 apply（模拟重启）：不新增 scrub 事件、不改任何行/FTS。
  const secondCtx = makePluginCtx();
  const secondHandle = apply(
    secondCtx,
    { dbPath: file, thread: { agentPreset: 'workspace-write' } },
    { cwd: '/hooked/cwd', now: () => TEST_NOW },
  );
  secondHandle.dispose();

  const again = Store.open(file);
  try {
    assert.deepEqual(
      again.db.prepare('SELECT * FROM episodes ORDER BY rowid ASC').all(),
      snapshot.rows,
      '二次 apply 不得改动 episodes 行',
    );
    assert.equal(episodeFtsText(again), snapshot.fts, '二次 apply 不得改动 FTS 投影');
    assert.equal(
      again.listEvents({ action: 'scrub' }).length,
      snapshot.scrubEvents,
      '二次 apply 不得新增 scrub 事件',
    );
  } finally {
    again.close();
  }
});
