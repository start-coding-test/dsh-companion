/**
 * v0.4.9 集成回归：五项修复在**真实 apply 路径**上一起工作。
 *
 * 与各修复自己的单测不同，这里统一用 strictCtx + FakeCtx + 临时库跑插件
 * 接线（commands/tools 注册、pre-step waterfall、scheduler、store），只断言
 * 用户可见的结果：
 *   1. V7-H1：apply 时没有 sessionController 也注册 10 个工具；线程工具返回
 *      capability_missing；宿主晚挂载后同一注册项直接可用，/status 与 /threads
 *      文案随能力实时变化；
 *   2. V7-M1：恢复的 pending 起点落在 surface 的系统节点上时，压缩起点被
 *      收紧到系统节点之后，系统提示词留在 surface；
 *   3. V7-M3：输入凭据后巩固，facts / FTS / 状态板都不出现凭据串，回复提示
 *      带固定建议句；「密码学」「tokenizer」这类普通文本不误伤；
 *   4. V7-L2：apply 生产路径的巩固事件带非负整数 duration_ms；
 *   5. V8-L1/L2：改期清空 retry_at、失败退避按 retry_at 到期、到期查询的
 *      EXPLAIN QUERY PLAN 命中表达式索引 ix_rm_due（store 级断言）。
 *
 * 只新增测试，不改实现；临时库落在 os.tmpdir()，测试结束删除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { CREDENTIAL_HINT, isSensitiveText } from '../src/memory/govern.js';
import { buildDueRemindersQuery, reminderDueAt } from '../src/memory/store.js';

import { TEST_NOW, makeTempStore, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config) => applyCordis(strictCtx(ctx), config);

const PASSWORD_VALUE = '蓝鲸-7788';
const API_KEY_VALUE = 'sk-abc123';

const CAPABILITY_MISSING = {
  ok: false,
  reason: 'capability_missing',
  message: '宿主未提供 sessionController，线程工具暂不可用',
};

const THREADS_UNSUPPORTED = '线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）';

const PRIVACY_KIND = 'companion-privacy-hint';

const ALL_TOOL_NAMES = [
  'cost_report',
  'memory_forget',
  'memory_search',
  'memory_update',
  'memory_write',
  'reminder_add',
  'reminder_done',
  'task_run',
  'thread_list',
  'thread_run',
];

/**
 * 集成用 FakeCtx：strict 宿主 + commands/tools 注册表 + 可控 tokenMeter/llm。
 *
 * @param {{
 *   now?: number,
 *   missing?: string[],
 *   totalTokens?: number,
 *   advanceOnStream?: number,
 *   drafts?: object[]|null,
 * }} [options]
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeCtx(options = {}) {
  const {
    now = TEST_NOW,
    missing = [],
    totalTokens = 0,
    advanceOnStream = 0,
    drafts = null,
  } = options;
  const ctx = new FakeCtx({ now, strict: true, missing });
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
  let callIndex = 0;
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream(request) {
      if (!Array.isArray(drafts) || drafts.length === 0) {
        throw new Error('unexpected consolidation model call');
      }
      streams.push(request);
      const draft = drafts[Math.min(callIndex, drafts.length - 1)];
      callIndex += 1;
      if (advanceOnStream > 0) ctx.advance(advanceOnStream);
      yield { type: 'text-delta', text: JSON.stringify(draft) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
  return { ctx, streams };
}

/** 取注册的工具定义。 */
function toolOf(ctx, name) {
  const definition = ctx.tools.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `工具 ${name} 应已注册`);
  return definition;
}

/** 执行命令并返回其纯文本。 */
function commandText(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition.handler({ rawInput: '' }).text;
}

/**
 * 一轮 pre-step payload。emit=true 时先按平台语义把用户消息 commit 进 surface，
 * 这样 transcript / 巩固区间才看得到这轮内容。
 */
function turnPayload(ctx, session, turn, text, step = 1, { emit = true } = {}) {
  if (emit) {
    ctx.emitSessionEvent(session.id, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text }] },
    });
  }
  return {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn,
    step,
  };
}

/** 从 pre-step 决策里挑出凭据提示注入。 */
function privacyHints(decision) {
  return (decision?.messages ?? []).filter((message) => message?.source?.kind === PRIVACY_KIND);
}

// ------------------------------------------------- V7-H1：线程能力晚挂载

test('v0.4.9 集成：宿主晚挂载 sessionController 前后，线程工具与文案实时切换', async (t) => {
  const temp = makeTempStore();
  const { ctx } = makeCtx({ missing: ['sessionController'] });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  // apply 时没有 sessionController：仍然注册全部 10 个工具。
  assert.equal(ctx.tools.registrations.length, 10);
  assert.deepEqual(ctx.tools.registrations.map((entry) => entry.name).sort(), ALL_TOOL_NAMES);

  // 调用时判能力：三个线程/任务工具返回稳定错误对象。
  for (const name of ['thread_list', 'thread_run', 'task_run']) {
    const result = await toolOf(ctx, name).execute({ key: 'new', name: '集成', goal: '不应执行' });
    assert.deepEqual(result, CAPABILITY_MISSING, `${name} 应返回 capability_missing`);
  }

  // /status 与 /threads 使用同一句「宿主不支持」。
  assert.ok(commandText(ctx, 'status').includes(THREADS_UNSUPPORTED));
  assert.equal(commandText(ctx, 'threads'), THREADS_UNSUPPORTED);

  // 宿主晚挂载服务（capabilities getter 随之变 true），不重新 apply。
  assert.equal(ctx.attachSessionController(), true);
  const after = await toolOf(ctx, 'thread_run').execute({ key: 'new', name: '集成', goal: '晚挂载后执行' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(after.action, 'create');
  assert.ok(ctx.callsOf('sessionController.create').length >= 1);
  assert.ok(ctx.callsOf('sessionController.prompt').length >= 1);

  const status = commandText(ctx, 'status');
  const threads = commandText(ctx, 'threads');
  assert.doesNotMatch(status, /宿主不支持/u);
  assert.doesNotMatch(threads, /宿主不支持/u);
  assert.match(threads, /线程目录/u);
});

// ------------------------------------------- V7-M1：压缩起点跳过系统节点

test('v0.4.9 集成：恢复的 pending 起点是系统节点时，compactRegion 从其后开始', async (t) => {
  const temp = makeTempStore();
  const { ctx } = makeCtx({ totalTokens: 1000 });
  const session = ctx.addSession({ id: 'session-compact' });
  const system = ctx.appendEvent(session.id, {
    type: 'system/message',
    data: {
      message: {
        role: 'system',
        content: [{ type: 'text', text: `系统提示词：你是严谨的助手。${'规则。'.repeat(40)}` }],
      },
    },
  });
  const user = ctx.appendEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '我下周要把预算调到 8000。' }] },
  });
  // 旧版本/重启恢复留下的 pending：起点误记在系统节点上。
  temp.store.insertConsolidation({
    id: 'cs-v049-integration',
    scope: 'main',
    session_id: session.id,
    kind: 'nap',
    trigger: 'auto',
    upto_seq: user.seq,
    turn_from: system.seq,
    compaction_start_seq: system.seq,
    status: 'written',
    finished_at: Math.floor(TEST_NOW / 1000),
  });

  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '继续。', 1, { emit: false }), {
    kind: 'enter',
    messages: [],
  });

  const calls = ctx.callsOf('compaction.compactRegion');
  assert.equal(calls.length, 1, '恢复的 pending 应在 turn 头压缩一次');
  const [start, end] = calls[0].args;
  assert.equal(start, user.seq, '压缩起点必须是系统节点之后的节点');
  assert.notEqual(start, system.seq);
  assert.equal(end, user.seq);
  assert.equal(session.surface.nodes[0], system.seq, '系统提示词节点必须留在 surface');
});

// ------------------------------------------------ V7-M3：凭据不落库

/** 含凭据（应被过滤）与普通事实（应保留）的巩固草稿。 */
function credentialDraft() {
  return {
    episode: {
      title: '网络与密钥设置',
      summary: '用户确认了家里网络和 API 配置。',
      topics: ['网络'],
    },
    facts: [
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '密码是',
        object_text: PASSWORD_VALUE,
        statement: `用户 wifi 密码是 ${PASSWORD_VALUE}`,
      },
      {
        kind: 'knowledge',
        subject_text: 'API',
        predicate: 'key 是',
        object_text: API_KEY_VALUE,
        statement: `API key 是 ${API_KEY_VALUE}`,
      },
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '喜欢',
        object_text: '喝咖啡',
        statement: '用户喜欢喝咖啡',
      },
    ],
    reminders: [
      { kind: 'todo', title: `把 wifi 密码改成 ${PASSWORD_VALUE}` },
      { kind: 'todo', title: '订展览票' },
    ],
  };
}

test('v0.4.9 集成：输入凭据后 facts/FTS/状态板无该串，回复带建议句', async (t) => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx({ totalTokens: 41_000, drafts: [credentialDraft()] });
  const session = ctx.addSession({ id: 'session-credentials' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const input = `我的 wifi 密码是 ${PASSWORD_VALUE}，API key 是 ${API_KEY_VALUE}`;
  const decision = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, input), {
    kind: 'enter',
    messages: [],
  });

  // 回复提示：命中凭据时注入一句固定建议句，且不含具体值。
  const hints = privacyHints(decision);
  assert.equal(hints.length, 1, '凭据输入应注入一条提示');
  assert.ok(hints[0].content[0].text.includes(CREDENTIAL_HINT), '提示应包含固定建议句');
  assert.doesNotMatch(hints[0].content[0].text, /蓝鲸-7788|sk-abc123/u);

  await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'credential consolidation' });
  assert.equal(streams.length, 1, '应只跑一次巩固模型调用');

  // facts：只保留普通事实，凭据串不出现。
  const facts = temp.store.listFacts({ scope: 'main' });
  assert.deepEqual(facts.map((fact) => fact.statement), ['用户喜欢喝咖啡']);
  for (const fact of facts) {
    assert.doesNotMatch(JSON.stringify(fact), /蓝鲸-7788|sk-abc123/u);
  }

  // FTS 投影同样检索不到凭据。
  assert.equal(
    temp.store.searchBigram(PASSWORD_VALUE, {}).filter((row) => row.type === 'fact').length,
    0,
  );
  assert.equal(
    temp.store.searchBigram(API_KEY_VALUE, {}).filter((row) => row.type === 'fact').length,
    0,
  );

  // 敏感提醒不落库，普通提醒保留。
  assert.deepEqual(
    temp.store.listReminders({ scope: 'main' }).map((row) => row.title),
    ['订展览票'],
  );

  // 状态板：凭据串不出现，普通内容仍在。
  const board = temp.store.getBoardState('main').staged_rendered;
  assert.doesNotMatch(board, /蓝鲸-7788|sk-abc123/u);
  assert.match(board, /用户喜欢喝咖啡/u);
  assert.match(board, /订展览票/u);

  // 回执日志也说明凭据被跳过（模型侧可据此解释「没保存」）。
  assert.ok(
    ctx.logs.some((entry) => entry.message.includes('credential content skipped')),
    '巩固回执应记录被跳过的凭据内容',
  );
});

test('v0.4.9 集成：密码学/tokenizer 不误伤，普通事实照常写入', async (t) => {
  const temp = makeTempStore();
  const normalDraft = {
    episode: { title: '技术闲聊', summary: '用户问起密码学与 tokenizer。', topics: ['技术'] },
    facts: [
      {
        kind: 'knowledge',
        subject_text: '用户',
        predicate: '觉得',
        object_text: '密码学有趣',
        statement: '用户觉得密码学有趣',
      },
    ],
    reminders: [],
  };
  const { ctx } = makeCtx({ totalTokens: 41_000, drafts: [normalDraft] });
  const session = ctx.addSession({ id: 'session-normal-words' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const input = '密码学和 tokenizer 有什么区别？';
  assert.equal(isSensitiveText(input), false, '学科词/分词器不得被判为凭据');

  const decision = await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, input), {
    kind: 'enter',
    messages: [],
  });
  assert.equal(privacyHints(decision).length, 0, '普通技术讨论不应注入凭据提示');

  await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'normal consolidation' });
  assert.deepEqual(
    temp.store.listFacts({ scope: 'main' }).map((fact) => fact.statement),
    ['用户觉得密码学有趣'],
    '普通事实必须照常写入',
  );
});

// ------------------------------------------------ V7-L2：duration_ms

test('v0.4.9 集成：apply 生产路径的巩固事件带非负整数 duration_ms', async (t) => {
  const temp = makeTempStore();
  const draft = {
    episode: { title: '预算调整', summary: '用户把项目预算调到 8000。', topics: ['预算'] },
    facts: [
      {
        kind: 'project',
        subject_text: '预算',
        predicate: '额度',
        object_text: '8000',
        statement: '预算额度调整为 8000。',
      },
    ],
    reminders: [],
  };
  const { ctx } = makeCtx({ totalTokens: 41_000, advanceOnStream: 250, drafts: [draft] });
  const session = ctx.addSession({ id: 'session-duration' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4, threadIdleDays: 14 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
    kind: 'enter',
    messages: [],
  });
  await waitFor(() => temp.store.getWatermark('main') === 1, { label: 'duration consolidation' });

  const event = temp.store.listEvents({ table_name: 'episodes', limit: 50 })[0];
  assert.ok(event, '巩固成功应写 episodes 事件');
  const detail = JSON.parse(event.detail_json);
  assert.equal(detail.kind, 'consolidation');
  assert.equal(typeof detail.duration_ms, 'number');
  assert.ok(Number.isInteger(detail.duration_ms), 'duration_ms 必须是整数');
  assert.ok(detail.duration_ms >= 0, 'duration_ms 必须非负');
  assert.equal(detail.duration_ms, 250, '模型耗时 250ms 应被记录');
});

// ------------------------------------- V8-L1/L2：到期口径与索引

/** 插入一条提醒（可直接指定 next_fire_at / retry_at）。 */
function insertReminder(store, title, { nextFireAt = null } = {}) {
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nextFireAt,
    due_granularity: nextFireAt === null ? 'none' : 'exact',
    next_fire_at: nextFireAt,
  });
}

test('v0.4.9 集成：改期清 retry_at、失败退避生效、EXPLAIN 命中 ix_rm_due', (t) => {
  const temp = makeTempStore({ t });
  const now = toEpochSeconds(TEST_NOW);
  const reminder = insertReminder(temp.store, '交房租', { nextFireAt: now - 60 });

  // 失败退避：只写 retry_at，且按 retry_at 到期。
  assert.equal(temp.store.claimReminderDelivery(reminder.id, `${now - 60}@1`), true);
  assert.equal(temp.store.markReminderDeliveryFailed(reminder.id, { now }), true);
  let row = temp.store.getReminder(reminder.id);
  assert.equal(row.next_fire_at, now - 60, '失败不改原定时间');
  assert.equal(row.retry_at, now + 30, '失败写退避时刻');
  assert.equal(reminderDueAt(row), now + 30, '到期口径取 max');
  assert.deepEqual(temp.store.dueReminders({ now }), [], '退避未到不得到期');
  assert.deepEqual(temp.store.dueReminders({ now: now + 29 }), []);
  assert.deepEqual(
    temp.store.dueReminders({ now: now + 30 }).map((item) => item.id),
    [reminder.id],
    '退避到期才允许重试',
  );

  // 改期：清空 retry_at 等残留，按新时间到期。
  const moved = temp.store.rescheduleReminder(reminder.id, { next_fire_at: now - 10 });
  assert.ok(moved, '改期应返回更新后的行');
  assert.equal(moved.retry_at, null, '改期必须清空旧 retry_at');
  assert.equal(moved.occurrence_key, null);
  assert.equal(moved.last_fire_key, null);
  assert.equal(moved.delivery_attempts, 0);
  assert.equal(reminderDueAt(moved), now - 10, '到期口径只认新时间');
  assert.deepEqual(
    temp.store.dueReminders({ now }).map((item) => item.id),
    [reminder.id],
    '旧 retry_at 不得压过新时间',
  );

  // 索引：新表达式索引存在、裸列旧索引不存在，查询计划命中新索引。
  const indexes = temp.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'")
    .all()
    .map((item) => item.name);
  assert.ok(indexes.includes('ix_rm_due'));
  assert.ok(!indexes.includes('ix_rm_fire'));

  const { sql, args } = buildDueRemindersQuery({ now });
  const plan = temp.store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((item) => String(item.detail))
    .join(' | ');
  assert.match(plan, /USING INDEX ix_rm_due/u, `查询计划：${plan}`);
  assert.doesNotMatch(plan, /SCAN reminders/u, `不得全表扫：${plan}`);
});
