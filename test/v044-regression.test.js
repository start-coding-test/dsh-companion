/**
 * v0.4.4 集成回归（t6）：把 v0.4.3 真机回报的必修项在**真实插件入口**
 * `apply()` + FakeCtx + 临时库上串起来跑一遍，作为发布前的总门。
 *
 * 覆盖：
 * - V3-H1：召回注入是完整平台消息（fake loop 消费 + JSONL 冷读 + 巩固排除）；
 * - V3-H2：提醒两阶段投递（成功 fired 只一次、失败回 pending、delivering 回收）；
 * - V3-M2：主会话按「最近真实用户输入」重绑、探针不抢占、提醒投到新主会话；
 * - V3-M3：无关查询不注入、相关查询注入（先过滤后打分）；
 * - V3-M4：改记忆后旧值搜不到、新值搜得到（走注册的 memory_update/ search 工具）；
 * - V3-H3②：无 sessionController 时不注册线程/任务工具，/状态 明确提示；
 * - V3-M1：dispose 后重新 apply 不产生重复注册；
 * - V3-L1：headless 函数型 logger 默认只镜像 info 及以上；
 * - V3-L3：中文命令提示注入形状、同 turn 只注入一次、进入巩固窗口被排除。
 *
 * 不依赖网络与真实 DSH；三时区（默认 / UTC / America/Los_Angeles）均可跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { COMMAND_HINT_SOURCE_KIND } from '../src/runtime/commands.js';
import { strictCtx } from './helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds, waitFor } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const RECALL_KIND = 'companion-recall';
const HINT_TEXT_PREFIX = '宿主只注册 ASCII 命令名';

// ---------------------------------------------------------------- 测试替身

/**
 * 注册表：register 返回「从列表里摘掉自己」的 disposer，便于数注册数与验证回收。
 * @returns {{registrations: object[], register: Function}}
 */
function makeRegistry() {
  return {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const index = this.registrations.indexOf(definition);
        if (index >= 0) this.registrations.splice(index, 1);
      };
    },
  };
}

/**
 * FakeCtx + commands/tools/llm（与真机接线一致的服务面）。
 * @param {{now?: number, missing?: string[], totalTokens?: number}} [options]
 * @returns {{ctx: FakeCtx, streams: object[]}}
 */
function makeCtx({ now = TEST_NOW, missing = [], totalTokens = 1000 } = {}) {
  const ctx = new FakeCtx({ now, missing });
  ctx.commands = makeRegistry();
  ctx.tools = makeRegistry();
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream(request) {
      streams.push(request);
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          episode: { title: '回顾', summary: '用户提问。', topics: [], salience: 'normal', fidelity: 'full' },
          facts: [],
          reminders: [],
        }),
      };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  setTokens(ctx, totalTokens);
  return { ctx, streams };
}

/** @param {FakeCtx} ctx @param {number} totalTokens */
function setTokens(ctx, totalTokens) {
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 10,
    totalTokens,
    surfaceTokens: totalTokens,
    nodes: [],
  };
}

/**
 * 一轮 pre-step payload；messages 是**完整平台消息**（id/source），
 * 与真机进入批次的形状一致。
 * @param {object} session @param {object} turn @param {string} text @param {number} [step]
 * @param {object[]} [messages]
 * @returns {object}
 */
function turnPayload(session, turn, text, step = 1, messages) {
  const batch = messages ?? [
    { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  ];
  return { agent: { id: session.id, session }, messages: batch, turn, step };
}

/**
 * 复刻 `dsh-agent-loop/lib/index.js:1067`：逐条消费 decision.messages，
 * 非 runtime-context 的条目必须能按平台消息 append。
 * @param {FakeCtx} ctx @param {object} session @param {object} decision
 * @returns {object[]}
 */
function appendDecision(ctx, session, decision) {
  const appended = [];
  for (const message of decision?.messages ?? []) {
    if (message?.source?.kind === 'runtime-context') continue;
    assertPlatformMessage(message);
    appended.push(ctx.emitSessionEvent(session.id, { type: 'user/message', data: message }));
  }
  return appended;
}

/** @param {unknown} message */
function assertPlatformMessage(message) {
  assert.ok(message !== null && typeof message === 'object', '消息必须是对象');
  assert.equal(typeof message.id, 'string', '消息必须带 id');
  assert.ok(message.id.length > 0, 'id 必须是非空字符串');
  assert.equal(message.role, 'user');
  assert.ok(message.source !== null && typeof message.source === 'object');
  assert.equal(typeof message.source.kind, 'string');
  assert.ok(Array.isArray(message.content));
}

/**
 * 冷读（reopen）：消息落成 JSONL → 逐行解析 → 复验形状。
 * @param {object[]} events
 * @returns {object[]}
 */
function coldRead(events) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v044-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const event = JSON.parse(line);
        assert.equal(event.type, 'user/message');
        assertPlatformMessage(event.data);
        return event;
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 主动消息正文（FakeCtx 把 prompt 记成 content 数组）。 */
function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

/** 已到期的普通提醒。 */
function dueReminder(store, title, nowMs = TEST_NOW) {
  const nowSeconds = toEpochSeconds(nowMs);
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nowSeconds - 60,
    next_fire_at: nowSeconds - 60,
    due_granularity: 'exact',
  });
}

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** headless 宿主的函数型 logger。 */
function headlessCtx() {
  const logs = [];
  return {
    logs,
    logger: (...args) => logs.push(args),
    on() {},
    get() {
      return undefined;
    },
  };
}

/** 临时接管 process.stderr.write。 */
function captureStderr(run) {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    return { writes, value: run() };
  } finally {
    process.stderr.write = original;
  }
}

// ------------------------------------------------------- V3-H1 召回注入

test('V3-H1：召回非空一轮在真实形状 fake loop 下不崩，冷读通过', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '周报',
      predicate: '提交时间',
      object_text: '周五',
      statement: '每周五要交周报。',
      source_kind: 'turn',
    });

    const payload = turnPayload(session, { id: 'turn-1' }, '周报什么时候交？');
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });

    assert.equal(decision.kind, 'enter');
    assert.equal(decision.messages.length, 2, '用户消息 + 一条召回消息');
    const recall = decision.messages[1];
    assert.equal(recall.role, 'user');
    assert.equal(recall.source.kind, RECALL_KIND);
    assert.equal(recall.source.form, 'snapshot');
    assert.deepEqual(recall.source.sections.map((section) => section.name), ['recall']);
    assert.match(recall.content[0].text, /\[相关记忆\]/u);
    assert.match(recall.content[0].text, /周报/u);
    assert.match(recall.id, /^[0-9a-f-]{36}$/u, 'id 必须是 randomUUID');

    // 平台 fake loop：两条消息都按 user/message append（无 TypeError）。
    const appended = appendDecision(ctx, session, decision);
    assert.equal(appended.length, 2);

    // 冷读（reopen）：形状复验 + 召回正文可还原。
    const rows = coldRead(appended);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].data.id, recall.id);
    assert.equal(rows[1].data.source.kind, RECALL_KIND);
    assert.match(rows[1].data.content[0].text, /\[相关记忆\]/u);

    // 同 turn 第二步：messages 已含召回块，不再重复注入。
    const second = turnPayload(session, { id: 'turn-1' }, '谢谢。', 2, decision.messages);
    const again = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    const recalls = (again.messages ?? []).filter((message) => message?.source?.kind === RECALL_KIND);
    assert.equal(recalls.length, 1, '同一 turn 不应重复注入');
    assert.equal(recalls[0].id, recall.id, '不得换新 id 重注入');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V3-H1：召回块不进入巩固窗口（不被自我巩固）', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      statement: '预算额度调整为 8000。',
      source_kind: 'turn',
    });

    const first = turnPayload(session, { id: 'turn-1' }, '预算额度是多少？');
    const decision = await ctx.dispatch('agent/pre-step', first, {
      kind: 'enter',
      messages: first.messages,
    });
    assert.equal(decision.messages[1].source.kind, RECALL_KIND);
    appendDecision(ctx, session, decision);

    setTokens(ctx, 41_000);
    const second = turnPayload(session, { id: 'turn-2' }, '继续。');
    const third = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    appendDecision(ctx, session, third);

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const prompt = streams[0].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');

    // 提示词固定说明行会引用标记本身，因此只检查「对话：」之后的选区正文。
    const body = prompt.slice(prompt.indexOf('对话：'));
    assert.match(prompt, /预算额度是多少/u, '真实用户发言必须进入巩固窗口');
    assert.doesNotMatch(body, /\[相关记忆\]/u, '召回块不得作为用户发言进入巩固窗口');
    assert.doesNotMatch(prompt, /8000/u, '召回块正文不得进入巩固窗口');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-H2 提醒投递

test('V3-H2：投递成功转 fired，后续 tick 不重复提醒', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = dueReminder(temp.store, '给妈妈打电话');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('给妈妈打电话')).length, 1);
    const row = temp.store.getReminder(reminder.id);
    assert.equal(row.status, 'fired');
    assert.equal(row.last_fire_key, null);
    assert.equal(row.delivery_attempts, 0);

    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('给妈妈打电话')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V3-H2：prompt 抛错后重启仍 pending，补发成功才 fired', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const first = makeCtx();
  const handle = apply(first.ctx, { dbPath: temp.dbPath });
  let reminder;
  try {
    reminder = dueReminder(temp.store, '交房租');
    first.ctx.fail('sessionController.prompt');
    await firstTick(first.ctx);
    const failed = temp.store.getReminder(reminder.id);
    assert.equal(failed.status, 'pending', '投递失败必须回 pending');
    assert.equal(failed.delivery_attempts, 1);
    assert.ok(failed.last_fire_key, 'last_fire_key 保留供重试幂等');
  } finally {
    handle.dispose();
  }

  const second = makeCtx();
  const handle2 = apply(second.ctx, { dbPath: temp.dbPath });
  try {
    await firstTick(second.ctx);
    second.ctx.advance(30_000);
    await second.ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(second.ctx).filter((text) => text.includes('交房租')).length, 1);
    const delivered = temp.store.getReminder(reminder.id);
    assert.equal(delivered.status, 'fired');
    assert.equal(delivered.delivery_attempts, 0);
  } finally {
    handle2.dispose();
    temp.cleanup();
  }
});

test('V3-H2：崩溃残留 delivering 启动回收为 pending 并补发', async () => {
  const temp = makeTempStore();
  const reminder = dueReminder(temp.store, '交水电费');
  temp.store.db
    .prepare("UPDATE reminders SET status = 'delivering', delivery_attempts = 1, last_fire_key = 'stale' WHERE id = ?")
    .run(reminder.id);
  temp.store.setMeta('main_session_id', 'main-1');

  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    assert.equal(temp.store.getReminder(reminder.id).status, 'pending');
    assert.ok(
      ctx.logs.some((row) => row.level === 'info' && /reminder deliveries recovered/iu.test(row.message)),
      '回收必须留 info 日志',
    );
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交水电费')).length, 1);
    assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
    assert.equal(temp.store.getReminder(reminder.id).delivery_attempts, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-M2 主会话重绑

test('V3-M2：主会话按最近真实用户输入重绑，探针不写，提醒投到新主会话', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const first = ctx.addSession({ id: 'main-1' });
  const second = ctx.addSession({ id: 'main-2' });
  const probe = ctx.addSession({ id: 'probe-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    await ctx.dispatch('agent/pre-step', {
      agent: { id: first.id, session: first },
      messages: [{ role: 'user', content: [{ type: 'text', text: '蓝鲸是什么动物？' }] }],
      turn: 1,
      step: 1,
    }, { kind: 'enter', messages: [] });
    assert.equal(temp.store.getMeta('main_session_id'), 'main-1');

    await ctx.dispatch('agent/pre-step', {
      agent: { id: second.id, session: second },
      messages: [{ role: 'user', content: [{ type: 'text', text: '极光在哪里出现？' }] }],
      turn: 1,
      step: 1,
    }, { kind: 'enter', messages: [] });
    assert.equal(temp.store.getMeta('main_session_id'), 'main-2');

    // 探针：只有 runtime-context，不算真实用户输入。
    await ctx.dispatch('agent/pre-step', {
      agent: { id: probe.id, session: probe },
      messages: [
        {
          role: 'user',
          source: { kind: 'runtime-context' },
          content: [{ type: 'text', text: '[运行时上下文] 探针' }],
        },
      ],
      turn: 1,
      step: 1,
    }, { kind: 'enter', messages: [] });
    assert.equal(temp.store.getMeta('main_session_id'), 'main-2', '探针不得抢占主会话');

    // 提醒必须投到重绑后的 main-2。
    const reminder = dueReminder(temp.store, '周五交周报');
    await firstTick(ctx);
    const target = ctx
      .callsOf('sessionController.prompt')
      .find((call) => String(call.args[0]?.content?.map((part) => part?.text ?? '').join('') ?? '').includes('周五交周报'));
    assert.ok(target, '应投递一条提醒');
    assert.equal(target.args[0]?.sessionId, 'main-2');
    assert.equal(temp.store.getReminder(reminder.id).status, 'fired');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-M3 召回相关性

test('V3-M3：相关查询注入，无关查询不注入（不靠 recency 硬凑）', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const relevant = ctx.addSession({ id: 'session-rel' });
  const irrelevant = ctx.addSession({ id: 'session-unrel' });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    temp.store.insertFact({
      kind: 'project',
      subject_text: '周报',
      predicate: '提交时间',
      object_text: '周五',
      statement: '每周五要交周报。',
      source_kind: 'turn',
    });

    const hitPayload = turnPayload(relevant, { id: 'turn-1' }, '周五交周报吗？');
    const hit = await ctx.dispatch('agent/pre-step', hitPayload, {
      kind: 'enter',
      messages: hitPayload.messages,
    });
    assert.ok(
      (hit.messages ?? []).some((message) => message?.source?.kind === RECALL_KIND),
      '相关查询必须注入召回',
    );

    // 同一条 fact 在库，但查询完全不相关：不得因为「最近有记忆」就注入。
    const missPayload = turnPayload(irrelevant, { id: 'turn-1' }, '极光出现在哪里？');
    const miss = await ctx.dispatch('agent/pre-step', missPayload, {
      kind: 'enter',
      messages: missPayload.messages,
    });
    assert.ok(
      !(miss.messages ?? []).some((message) => message?.source?.kind === RECALL_KIND),
      '无关查询不得注入召回块',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-M4 改后重抽

test('V3-M4：memory_update 后旧值搜不到、新值搜得到（FTS + 向量只认新行）', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const writeTool = ctx.tools.registrations.find((definition) => definition.name === 'memory_write');
    const updateTool = ctx.tools.registrations.find((definition) => definition.name === 'memory_update');
    const searchTool = ctx.tools.registrations.find((definition) => definition.name === 'memory_search');
    assert.ok(writeTool && updateTool && searchTool);

    const written = writeTool.execute({
      statement: '下周四去杭州出差',
      subject: '行程',
      predicate: '计划',
      object: '杭州出差',
      kind: 'project',
    });
    assert.equal(written.ok, true);

    const updated = updateTool.execute({ id: written.id, statement: '下周四去杭州' });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.ok(updated.id && updated.id !== written.id, '修改走新行');
    assert.equal(updated.reextracted, true, '必须按新 statement 重抽');

    // 「出差」只存在于旧 object/旧 statement，新句子里已没有。
    const old = await searchTool.execute({ query: '出差' });
    assert.ok(
      !old.items.some((item) => String(item.id) === String(updated.id)),
      '旧值不得再命中新行',
    );
    const fresh = await searchTool.execute({ query: '下周四去杭州' });
    assert.ok(
      fresh.items.some((item) => String(item.id) === String(updated.id)),
      '新值必须能搜到新行',
    );

    const oldFact = temp.store.getFact(written.id);
    assert.equal(oldFact.status, 'superseded');
    const newFact = temp.store.getFact(updated.id);
    assert.equal(newFact.object_text, '杭州');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// --------------------------------------------------- V3-H3② 能力缺失注册

test('V3-H3②/V7-H1：无 sessionController 仍注册全部工具，调用返回 capability_missing，/状态 显示宿主不支持', () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx({ missing: ['sessionController'], strict: true });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const names = ctx.tools.registrations.map((definition) => definition.name);
    assert.equal(names.length, 10, `应注册 10 个工具，实际：${names.join(',')}`);
    for (const name of ['memory_search', 'memory_write', 'memory_forget', 'memory_update', 'reminder_add', 'reminder_done', 'cost_report']) {
      assert.ok(names.includes(name), `必须保留 ${name}`);
    }
    for (const name of ['thread_list', 'thread_run', 'task_run']) {
      assert.ok(names.includes(name), `V7-H1：仍应注册 ${name}`);
      const definition = ctx.tools.registrations.find((entry) => entry.name === name);
      assert.deepEqual(definition.execute({ key: 'new', name: 'x', goal: 'y' }), {
        ok: false,
        reason: 'capability_missing',
        message: '宿主未提供 sessionController，线程工具暂不可用',
      });
    }

    const status = ctx.commands.registrations.find((definition) => definition.name === 'status');
    const reply = status.handler({ rawInput: '' });
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /线程：宿主不支持/u);
    assert.match(reply.text, /线程工具调用返回 capability_missing/u);
    assert.match(reply.text, /主会话：/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V3-H3②：sessionController 齐全时注册 10 个工具，/状态 无「不支持」提示', () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const names = ctx.tools.registrations.map((definition) => definition.name);
    assert.equal(names.length, 10);
    for (const name of ['thread_list', 'thread_run', 'task_run']) {
      assert.ok(names.includes(name));
    }
    const status = ctx.commands.registrations.find((definition) => definition.name === 'status');
    const reply = status.handler({ rawInput: '' });
    assert.doesNotMatch(reply.text, /宿主不支持/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-M1 dispose

test('V3-M1：dispose 后重新 apply 不产生重复注册', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  try {
    const first = apply(ctx, { dbPath: temp.dbPath });
    assert.equal(ctx.tools.registrations.length, 10);
    assert.equal(ctx.commands.registrations.length, 6);
    assert.equal(ctx.sections.filter((item) => !item.disposed).length, 4);
    assert.equal((ctx.listeners.get('agent/pre-step') ?? []).filter((entry) => !entry.disposed).length, 1);

    first.dispose();
    const second = apply(ctx, { dbPath: temp.dbPath });
    try {
      assert.equal(ctx.tools.registrations.length, 10, '重新 apply 不得累加工具');
      assert.equal(ctx.commands.registrations.length, 6, '重新 apply 不得累加命令');
      // FakeCtx 的 section 注册不实现物理移除，按 disposed 数生效条目。
      assert.equal(ctx.sections.filter((item) => !item.disposed).length, 4, '重新 apply 不得累加人格段');
      assert.equal(
        (ctx.listeners.get('agent/pre-step') ?? []).filter((entry) => !entry.disposed).length,
        1,
        'pre-step 只应有一个监听器',
      );

      // 重新 apply 后管线仍可用（召回注入正常）。
      const session = ctx.addSession({ id: 'session-1' });
      const payload = turnPayload(session, { id: 'turn-1' }, '你好');
      const decision = await ctx.dispatch('agent/pre-step', payload, {
        kind: 'enter',
        messages: payload.messages,
      });
      assert.equal(decision.kind, 'enter');
    } finally {
      second.dispose();
    }
  } finally {
    temp.cleanup();
  }
});

// ------------------------------------------------------- V3-L1 日志级别

test('V3-L1：headless 函数型 logger 只镜像 info/warn/error，debug 默认静音', () => {
  const saved = process.env.DSH_COMPANION_MIRROR_DEBUG;
  delete process.env.DSH_COMPANION_MIRROR_DEBUG;
  try {
    const { writes } = captureStderr(() => {
      const adapter = createAdapter(headlessCtx());
      adapter.log('debug', 'DBG-only');
      adapter.log('info', 'INFO-kept');
      adapter.log('warn', 'WARN-kept');
      adapter.log('error', 'ERROR-kept');
    });
    const text = writes.join('');
    assert.ok(!text.includes('DBG-only'), 'debug 默认不镜像');
    assert.match(text, /INFO-kept/);
    assert.match(text, /WARN-kept/);
    assert.match(text, /ERROR-kept/);
  } finally {
    if (saved === undefined) delete process.env.DSH_COMPANION_MIRROR_DEBUG;
    else process.env.DSH_COMPANION_MIRROR_DEBUG = saved;
  }
});

// ------------------------------------------------------- V3-L3 中文命令

test('V3-L3：中文命令得到提示注入（完整平台消息，同 turn 只一次）', async () => {
  const temp = makeTempStore();
  const { ctx } = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const payload = turnPayload(session, { id: 'turn-1' }, '/记忆 忘掉 abc');
    const decision = await ctx.dispatch('agent/pre-step', payload, {
      kind: 'enter',
      messages: payload.messages,
    });
    const hints = (decision.messages ?? []).filter((message) => message?.source?.kind === COMMAND_HINT_SOURCE_KIND);
    assert.equal(hints.length, 1, '应注入一条中文命令提示');
    const hint = hints[0];
    assert.equal(hint.role, 'user');
    assert.ok(Array.isArray(hint.content));
    assert.match(hint.content[0].text, /^宿主只注册 ASCII 命令名/u);
    assert.match(hint.content[0].text, /请用 \/memory、\/status、\/cost、\/threads/u);

    const appended = appendDecision(ctx, session, decision);
    assert.equal(appended.length, 2, '用户消息 + 提示消息都能 append');
    const rows = coldRead(appended);
    assert.equal(rows[1].data.source.kind, COMMAND_HINT_SOURCE_KIND);

    // 同 turn 第二步：messages 已含提示，不再重复注入。
    const second = turnPayload(session, { id: 'turn-1' }, '还是不行', 2, decision.messages);
    const again = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    const hintsAgain = (again.messages ?? []).filter(
      (message) => message?.source?.kind === COMMAND_HINT_SOURCE_KIND,
    );
    assert.equal(hintsAgain.length, 1);
    assert.equal(hintsAgain[0].id, hint.id, '不得换新 id 重注入');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('V3-L3：中文命令提示不进入巩固窗口', async () => {
  const temp = makeTempStore();
  const { ctx, streams } = makeCtx();
  const session = ctx.addSession({ id: 'session-1' });
  // retainTokens 调小，让 turn 1 的节点落在保留窗口之外，hard 时能成区间。
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    const first = turnPayload(session, { id: 'turn-1' }, '/状态');
    const decision = await ctx.dispatch('agent/pre-step', first, {
      kind: 'enter',
      messages: first.messages,
    });
    assert.ok((decision.messages ?? []).some((message) => message?.source?.kind === COMMAND_HINT_SOURCE_KIND));
    appendDecision(ctx, session, decision);

    setTokens(ctx, 41_000);
    const second = turnPayload(session, { id: 'turn-2' }, '继续。');
    const third = await ctx.dispatch('agent/pre-step', second, {
      kind: 'enter',
      messages: second.messages,
    });
    appendDecision(ctx, session, third);

    await waitFor(() => streams.length === 1, { label: 'consolidation' });
    const prompt = streams[0].messages
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n');

    assert.match(prompt, /\/状态/u, '真实用户命令文本仍应进入巩固窗口');
    assert.doesNotMatch(prompt, /宿主只注册 ASCII 命令名/u, '提示注入不得进入巩固窗口');
    assert.ok(!prompt.includes(HINT_TEXT_PREFIX));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
