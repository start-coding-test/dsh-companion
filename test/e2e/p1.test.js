/**
 * P1-d 端到端联调（v0.2.0）。
 *
 * 本文件只走真实插件入口 `apply()` + FakeCtx + 临时库 + 手动时钟，
 * 验证 P1-a/b/c 六块能力在接线后仍成立：
 *   1. 治理 dry-run 不写库、apply 后重复组只剩一条 active 且旧条 superseded_by；
 *   2. `/记忆 改` 后下一轮召回注入新内容、旧内容不再进入上下文；
 *   3. 承诺到期只跟进一次、安静时段不打扰、完成后不再跟进；
 *   4. 闲聊四闸门（当日互动/非安静/冷却 3 天/每日 1 条且每周 3 条）
 *      + 周末关闭 + `/别闲聊` 跨重启持久化；
 *   5. 巩固失败按 1/2/4 个 tick 重试 3 次后放弃，事件可查；凭据错误不重试；
 *   6. v0.1.1 回归：V2 遗忘、V10/V16 裁切、V14 线程、V15 写失败不压缩。
 *
 * 约束：不联网、不读真实时钟、不写仓库外固定路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { strictCtx } from '../helpers/strict-ctx.js';

import { Store } from '../../src/memory/store.js';
import { DEFAULT_LIMITS, assemble, estimateTokens } from '../../src/memory/assemble.js';
import { consolidate } from '../../src/memory/consolidate.js';
import { buildSections } from '../../src/persona/sections.js';
import { DEFAULT_CARD } from '../../src/persona/card.js';
import { freezeIdleThreads, planThreadRun } from '../../src/thread/registry.js';
import {
  TEST_NOW,
  createClock,
  forgetMemory,
  makeDraft,
  makeFakeLlm,
  makeTempStore,
  recallInjection,
  seedMemory,
  settle,
  toEpochSeconds,
  waitFor,
} from './helpers.js';
import {
  WRITE_FAIL_SEQ_FROM,
  WRITE_FAIL_SEQ_TO,
  makeBudgetHistory,
  makeBudgetRecallItem,
  makeBudgetScenario,
  makeWriteFailDraft,
} from '../helpers/scenarios.js';

// C-H1：apply 一律经严格 ctx 代理，未声明 inject 的属性读会像真实 cordis 一样抛错。
const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;

/** 五句合规闲聊。 */
const FIVE_SENTENCES = '今天天气不错。路上看到一棵银杏。中午吃了面。下午把桌子收拾了。晚上准备早点休息。';

/** Asia/Shanghai 墙上时刻 → epoch ms（等于默认 config.timezone，与进程 TZ 无关）。 */
const at = (iso) => Date.parse(`${iso}+08:00`);

/**
 * FakeCtx + commands/tools + 可选的闲聊/巩固模型。
 * @param {{now?: number, chatLlm?: Function|null, llm?: object|null}} [options]
 * @returns {FakeCtx}
 */
function makeCtx({ now = TEST_NOW, chatLlm = null, llm = null } = {}) {
  const ctx = new FakeCtx({ now });
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
  if (typeof chatLlm === 'function') ctx.companion = { chatLlm };
  if (llm) ctx.llm = llm;
  return ctx;
}

/**
 * @param {FakeCtx} ctx
 * @param {string} name
 * @returns {object}
 */
function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition;
}

/**
 * @param {FakeCtx} ctx
 * @param {string} name
 * @param {string} [rawInput]
 * @returns {{kind: string, text: string}}
 */
function invokeCommand(ctx, name, rawInput = '') {
  return commandOf(ctx, name).handler({ rawInput });
}

/**
 * 主动消息正文（FakeCtx 把 prompt 记成 content 数组）。
 * @param {FakeCtx} ctx
 * @returns {string[]}
 */
function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

/**
 * 一轮 pre-step 的标准 payload；user 消息先 commit 进 surface。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {number} turn
 * @param {string} text
 * @param {number} [step]
 * @returns {object}
 */
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

/**
 * 制造一次「当天有互动」的 pre-step。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {string} [text]
 * @returns {Promise<object>}
 */
async function interact(ctx, session, text = '今天有点累') {
  return ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, text), {
    kind: 'enter',
    messages: [],
  });
}

/**
 * 调度器构造时把间隔任务基线设为当前时刻，先过一个周期再 tick。
 * @param {FakeCtx} ctx
 * @returns {Promise<Array<object>>}
 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  const result = await ctx.fireTimers();
  await settle(50);
  return result;
}

/** 触发 hard 巩固的 token 计量返回值。 */
function hardMeasure() {
  return {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 120,
    totalTokens: 41_000,
    surfaceTokens: 41_000,
    nodes: [],
  };
}

/**
 * 每次都失败的巩固模型（非凭据错误）。
 * @param {string} [message]
 * @returns {object}
 */
function failingLlm(message = 'model down') {
  return {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream() {
      throw new Error(message);
    },
  };
}

/**
 * 前 failTimes 次失败、之后返回合法草稿的模型，用于验证「重试成功即恢复」。
 * @param {number} [failTimes]
 * @returns {object}
 */
function flakyLlm(failTimes = 1) {
  let calls = 0;
  return {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: () => [{ id: 'fake-model', name: 'Fake Model' }],
    async *stream() {
      calls += 1;
      if (calls <= failTimes) throw new Error('model down');
      yield { type: 'text-delta', text: JSON.stringify(makeDraft()) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
    get calls() {
      return calls;
    },
  };
}

/** @param {Store} store @param {string} reason */
function consolidationEvents(store, reason) {
  return store
    .listEvents({ table_name: 'consolidations', limit: 100 })
    .filter((row) => row.reason === reason);
}

/** @param {Store} store */
function consolidationRows(store) {
  return store.db
    .prepare("SELECT id, status, error FROM consolidations WHERE scope = 'main' ORDER BY started_at, id")
    .all();
}

/**
 * 新增一个线程行（V14 回归用）。
 * @param {Store} store
 * @param {string} key
 * @param {object} [overrides]
 * @returns {object}
 */
function addThread(store, key, overrides = {}) {
  return store.upsertThread({
    key,
    name: key,
    session_id: `session-${key}`,
    description: `${key} 线程`,
    ...overrides,
  });
}

// ---------------------------------------------------------------- 治理与记忆编辑

test('治理 dry-run：只读扫描，不降级事实、不写审计', () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const observedAt = toEpochSeconds(TEST_NOW);
    const keep = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡',
      source_kind: 'user_explicit',
      salience: 'explicit',
      observed_at: observedAt,
    });
    const drop = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡',
      source_kind: 'turn',
      salience: 'normal',
      observed_at: observedAt + 1,
    });

    const reply = invokeCommand(ctx, 'memory', ' 治理 --dry-run');
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /记忆治理（dry-run，不写库）/u);
    assert.match(reply.text, /重复 1 组/u);
    assert.equal(temp.store.getFact(keep.id).status, 'active');
    assert.equal(temp.store.getFact(drop.id).status, 'active');
    assert.equal(temp.store.listEvents({ action: 'govern', limit: 5 }).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('治理 apply：重复组只剩一条 active，旧条 superseded_by 并写 govern 事件', () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const observedAt = toEpochSeconds(TEST_NOW);
    const keep = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡',
      source_kind: 'user_explicit',
      salience: 'explicit',
      observed_at: observedAt,
    });
    const drop = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡',
      source_kind: 'turn',
      salience: 'normal',
      observed_at: observedAt + 1,
    });

    const reply = invokeCommand(ctx, 'memory', ' 治理');
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /已应用/u);

    assert.equal(temp.store.getFact(keep.id).status, 'active');
    const superseded = temp.store.getFact(drop.id);
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.superseded_by, keep.id);

    const events = temp.store.listEvents({ action: 'govern', limit: 10 });
    assert.equal(events.length, 1);
    const detail = JSON.parse(events[0].detail_json);
    assert.deepEqual(detail.supersededIds, [drop.id]);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('治理后召回只命中保留条，被降级内容不再进入上下文', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const observedAt = toEpochSeconds(TEST_NOW);
    const keepStatement = '我习惯早上喝美式咖啡';
    for (const [index, source] of [['user_explicit', 'explicit'], ['turn', 'normal']].entries()) {
      temp.store.insertFact({
        kind: 'preference',
        subject_text: '我',
        predicate: '习惯',
        object_text: '美式咖啡',
        statement: keepStatement,
        source_kind: source[0],
        salience: source[1],
        observed_at: observedAt + index,
      });
    }

    invokeCommand(ctx, 'memory', ' 治理');
    const active = temp.store.listFacts({ scope: 'main', status: 'active' });
    assert.equal(active.length, 1);

    const { recalled, injected } = await recallInjection({
      store: temp.store,
      query: '美式咖啡',
      scope: 'main',
      now: TEST_NOW,
    });
    assert.equal(recalled.items.filter((item) => item.text.includes('美式咖啡')).length, 1);
    assert.match(injected, /我习惯早上喝美式咖啡/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('/记忆 改：旧条 superseded、新条 active，写 EDIT 事件', () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const old = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '咖啡',
      statement: '我习惯早上喝咖啡',
      source_kind: 'user_explicit',
      salience: 'explicit',
      observed_at: toEpochSeconds(TEST_NOW),
    });

    const reply = invokeCommand(ctx, 'memory', ` 改 ${old.id} 我改喝无糖美式`);
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /已更新记忆/u);

    const superseded = temp.store.getFact(old.id);
    assert.equal(superseded.status, 'superseded');
    assert.ok(superseded.superseded_by);
    const updated = temp.store.getFact(superseded.superseded_by);
    assert.equal(updated.status, 'active');
    assert.equal(updated.statement, '我改喝无糖美式');

    const event = temp.store.listEvents({ action: 'EDIT', limit: 1 })[0];
    const detail = JSON.parse(event.detail_json);
    assert.equal(detail.from, old.id);
    assert.equal(detail.to, updated.id);
    assert.equal(detail.edited, true, 'V3-M4：EDIT 审计标出这是编辑');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('/记忆 改 后下一轮召回注入新内容，旧内容不再注入', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const old = temp.store.insertFact({
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '咖啡',
      statement: '我习惯早上喝咖啡',
      source_kind: 'user_explicit',
      salience: 'explicit',
      observed_at: toEpochSeconds(TEST_NOW),
    });

    invokeCommand(ctx, 'memory', ` 改 ${old.id} 我改喝无糖美式`);

    const fresh = await recallInjection({ store: temp.store, query: '无糖美式', scope: 'main', now: TEST_NOW });
    assert.match(fresh.injected, /我改喝无糖美式/u);

    const stale = await recallInjection({ store: temp.store, query: '早上喝咖啡', scope: 'main', now: TEST_NOW });
    assert.doesNotMatch(stale.injected, /我习惯早上喝咖啡/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- 承诺提醒

test('承诺 e2e：reminders tick 到期跟进一次，同一天不重复，写 commitment_followup 审计', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  // 模拟上一会话已绑定主会话：提醒投递目标由 identity 解析，不再用字面量 'main'。
  temp.store.setMeta('main_session_id', 'main-session');
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const nowSeconds = toEpochSeconds(TEST_NOW);
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: nowSeconds - 3600,
      next_fire_at: nowSeconds - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    const texts = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(texts.length, 1);
    assert.match(texts[0], /昨天说好/u);
    assert.equal(temp.store.getReminder(reminder.id).last_fire_key, '2026-11-05');

    const event = temp.store
      .listEvents({ table_name: 'reminders', row_id: reminder.id, action: 'USED', limit: 5 })
      .find((row) => row.reason === 'commitment_followup');
    assert.ok(event, '应写 commitment_followup 审计');
    assert.deepEqual(JSON.parse(event.detail_json), {
      kind: 'commitment_followup',
      id: reminder.id,
      title: '交周报',
    });

    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('承诺 e2e：安静时段不打扰、行保持 pending，早上补发一次', async () => {
  const quietNow = at('2026-11-05T23:30:00');
  const temp = makeTempStore();
  const ctx = makeCtx({ now: quietNow });
  // 模拟上一会话已绑定主会话：提醒投递目标由 identity 解析，不再用字面量 'main'。
  temp.store.setMeta('main_session_id', 'main-session');
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const quietSeconds = Math.floor(quietNow / 1000);
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: quietSeconds - 3600,
      next_fire_at: quietSeconds - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 0);
    assert.equal(temp.store.getReminder(reminder.id).last_fire_key, null);
    assert.equal(temp.store.getReminder(reminder.id).status, 'pending');

    ctx.advance(9 * 3600 * 1000); // 次日 08:30
    await ctx.fireTimers();
    await settle(50);
    const sent = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(sent.length, 1);
    assert.equal(temp.store.getReminder(reminder.id).last_fire_key, '2026-11-06');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('承诺 e2e：完成后不再跟进', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  // 模拟上一会话已绑定主会话：提醒投递目标由 identity 解析，不再用字面量 'main'。
  temp.store.setMeta('main_session_id', 'main-session');
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const nowSeconds = toEpochSeconds(TEST_NOW);
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: nowSeconds - 3600,
      next_fire_at: nowSeconds - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 1);

    temp.store.db
      .prepare("UPDATE reminders SET status = 'done', closed_at = ? WHERE id = ?")
      .run(nowSeconds, reminder.id);
    ctx.advance(DAY_MS);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('承诺 e2e：敏感标题不进入消息正文与审计 detail', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  // 模拟上一会话已绑定主会话：提醒投递目标由 identity 解析，不再用字面量 'main'。
  temp.store.setMeta('main_session_id', 'main-session');
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const nowSeconds = toEpochSeconds(TEST_NOW);
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '银行卡密码要改',
      due_at: nowSeconds - DAY_SECONDS,
      next_fire_at: nowSeconds - DAY_SECONDS,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    const texts = promptTexts(ctx).filter((text) => text.includes('那件事'));
    assert.equal(texts.length, 1);
    assert.doesNotMatch(texts[0], /银行卡|密码/u);
    const event = temp.store.listEvents({
      table_name: 'reminders',
      row_id: reminder.id,
      action: 'USED',
      limit: 5,
    })[0];
    assert.doesNotMatch(event.detail_json, /银行卡|密码/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- 闲聊闸门

test('闲聊 e2e：没有当日互动不发起', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：互动当天、非安静、5 句投递一次并记录最近时间', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);

    const chats = promptTexts(ctx).filter((text) => text.includes('今天天气不错'));
    assert.equal(chats.length, 1);
    assert.equal((chats[0].match(/。/gu) ?? []).length, 5);
    assert.doesNotMatch(chats[0], /[？?]/u);
    assert.ok(Number(temp.store.getMeta('p1b.chat.last_at')) > 0);
    assert.match(invokeCommand(ctx, 'status').text, /闲聊：已开启/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：安静时段不发起，第二天有互动后补发一条', async () => {
  const quietNow = at('2026-11-05T23:30:00');
  const temp = makeTempStore();
  const ctx = makeCtx({ now: quietNow, chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);

    ctx.advance(9 * 3600 * 1000); // 次日 08:30，非安静
    await interact(ctx, session, '早上好');
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：周末不发起', async () => {
  const saturdayNow = at('2026-11-07T10:00:00');
  const temp = makeTempStore();
  const ctx = makeCtx({ now: saturdayNow, chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '周六好');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：3 天冷却内不发起，满 3 天后可发起', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const nowSeconds = toEpochSeconds(TEST_NOW);
    temp.store.setMeta('p1b.chat.last_at', String(nowSeconds - 2 * DAY_SECONDS));
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);

    temp.store.setMeta('p1b.chat.last_at', String(nowSeconds - 3 * DAY_SECONDS));
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：每天最多 1 条，同一天第二次 tick 不重复', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 1);

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：7 天内已有 3 条时命中每周上限', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const nowSeconds = toEpochSeconds(TEST_NOW);
    temp.store.setMeta('p1b.chat.last_at', String(nowSeconds - 3 * DAY_SECONDS));
    temp.store.setMeta('p1b.chat.sent', JSON.stringify([
      nowSeconds - DAY_SECONDS,
      nowSeconds - 2 * DAY_SECONDS,
      nowSeconds - 3 * DAY_SECONDS,
    ]));
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊 e2e：/别闲聊 关闭后立即静默，且跨重启持久化，/恢复闲聊 可恢复', async () => {
  const temp = makeTempStore();
  const firstCtx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const firstHandle = apply(firstCtx, { dbPath: temp.dbPath });
  try {
    assert.equal(invokeCommand(firstCtx, 'chat-off').kind, 'success');
    assert.equal(temp.store.getMeta('p1b.chat.enabled'), '0');
    assert.match(invokeCommand(firstCtx, 'status').text, /闲聊：已关闭/u);

    const session = firstCtx.addSession({ id: 'session-1' });
    await interact(firstCtx, session, '今天有点累');
    await firstTick(firstCtx);
    assert.equal(promptTexts(firstCtx).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    firstHandle.dispose();
  }

  const secondCtx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const secondHandle = apply(secondCtx, { dbPath: temp.dbPath });
  try {
    assert.match(invokeCommand(secondCtx, 'status').text, /闲聊：已关闭/u);
    assert.match(invokeCommand(secondCtx, 'chat-on').text, /已恢复主动闲聊/u);
    assert.equal(temp.store.getMeta('p1b.chat.enabled'), '1');
    assert.match(invokeCommand(secondCtx, 'status').text, /闲聊：已开启/u);
  } finally {
    secondHandle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- 巩固失败自愈

test('巩固失败：按 60s/120s/240s 重试 3 次后放弃，失败/重试/最终事件均可查', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ llm: failingLlm() });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.setMeta('p1b.chat.enabled', '0');
    const session = ctx.addSession({ id: 'session-1' });
    ctx.returns['tokenMeter.measure'] = hardMeasure();
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    await waitFor(
      () => consolidationEvents(temp.store, 'consolidation_failed').length === 1,
      { label: 'first consolidation failure' },
    );

    for (const [index, delay] of [60_000, 120_000, 240_000].entries()) {
      ctx.advance(delay);
      await ctx.fireTimers();
      await waitFor(
        () => consolidationEvents(temp.store, 'consolidation_failed').length === index + 2,
        { label: `failure event ${index + 2}` },
      );
    }

    assert.equal(consolidationEvents(temp.store, 'consolidation_failed').length, 4);
    assert.equal(consolidationEvents(temp.store, 'retry').length, 3);

    const finals = consolidationEvents(temp.store, 'consolidation_failed_final');
    assert.equal(finals.length, 1);
    const detail = JSON.parse(finals[0].detail_json);
    assert.equal(detail.kind, 'consolidation_final');
    assert.equal(detail.attempts, 4);
    assert.equal(detail.credential, false);

    const rows = consolidationRows(temp.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.match(rows[0].error, /model down/u);
    assert.equal(temp.store.getWatermark('main'), 0);
    assert.equal(temp.store.getBoard('main'), '');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('巩固失败：凭据缺失不重试，首次即永久失败', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ llm: failingLlm('MISSING_CREDENTIAL: no api key') });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.setMeta('p1b.chat.enabled', '0');
    const session = ctx.addSession({ id: 'session-1' });
    ctx.returns['tokenMeter.measure'] = hardMeasure();
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    await waitFor(
      () => consolidationEvents(temp.store, 'consolidation_failed_final').length === 1,
      { label: 'final consolidation failure' },
    );

    assert.equal(consolidationEvents(temp.store, 'consolidation_failed').length, 1);
    assert.equal(consolidationEvents(temp.store, 'retry').length, 0);
    const detail = JSON.parse(consolidationEvents(temp.store, 'consolidation_failed_final')[0].detail_json);
    assert.equal(detail.attempts, 1);
    assert.equal(detail.credential, true);

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(consolidationEvents(temp.store, 'consolidation_failed').length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('巩固失败：重试成功后推进水位并停止重试', async () => {
  const temp = makeTempStore();
  const llm = flakyLlm(1);
  const ctx = makeCtx({ llm });
  const handle = apply(ctx, { dbPath: temp.dbPath, retainTokens: 4 });
  try {
    temp.store.setMeta('p1b.chat.enabled', '0');
    const session = ctx.addSession({ id: 'session-1' });
    ctx.returns['tokenMeter.measure'] = hardMeasure();
    await ctx.dispatch('agent/pre-step', turnPayload(ctx, session, 1, '我下周要把预算调到 8000。'), {
      kind: 'enter',
      messages: [],
    });
    await waitFor(
      () => consolidationEvents(temp.store, 'retry').length === 1,
      { label: 'retry scheduled' },
    );
    assert.equal(temp.store.getWatermark('main'), 0);

    ctx.advance(60_000);
    await ctx.fireTimers();
    await waitFor(() => temp.store.getWatermark('main') >= 1, { label: 'retry success' });

    assert.ok(temp.store.getWatermark('main') >= 1);
    assert.equal(llm.calls, 2);
    assert.equal(consolidationEvents(temp.store, 'retry').length, 1);
    assert.equal(consolidationEvents(temp.store, 'consolidation_failed_final').length, 0);
    assert.equal(temp.store.listFacts({ scope: 'main', status: 'active' }).length >= 1, true);

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(llm.calls, 2, '成功后不应再重试');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------- v0.1.1 回归

test('v0.1.1 回归 V2：遗忘 7 天冷静期后 03:30 purge 清空事实/回合/FTS', async () => {
  const temp = makeTempStore();
  const base = at('2026-11-03T03:00:00');
  const seeded = seedMemory(temp.store, {
    now: base,
    title: '青柠计划启动',
    summary: '用户说了青柠计划的代号。',
    statement: '青柠计划的代号是蓝鲸。',
    reminderTitle: '跟进青柠计划预算',
  });
  forgetMemory(temp.store, {
    scope: 'main',
    factId: seeded.factId,
    episodeId: seeded.episodeId,
    reminderId: seeded.reminderId,
    now: base,
  });

  const ctx = makeCtx({ now: at('2026-11-10T03:30:00') });
  const handle = apply(ctx, { dbPath: temp.dbPath, purgeAfterDays: 7 });
  try {
    await waitFor(() => temp.store.getFact(seeded.factId) === null, { label: 's2 purge' });
    assert.equal(temp.store.getEpisode(seeded.episodeId), null);

    assert.deepEqual(temp.store.searchBigram('青柠计划'), []);
    const stats = temp.store.stats();
    assert.equal(stats.fts_facts, 0);
    assert.equal(stats.fts_episodes, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('v0.1.1 回归 V10/V16：32K 内先丢低分召回，人格段不动', () => {
  const scenario = makeBudgetScenario();
  const sections = buildSections(DEFAULT_CARD);
  const personaTokens = sections.reduce((sum, section) => sum + estimateTokens(section.text), 0);

  const result = assemble({
    sections,
    boardText: scenario.boardText,
    recallItems: scenario.recallItems,
    history: scenario.history,
    userInput: scenario.userInput,
  });

  assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens);
  assert.ok(result.dropped.recall.length > 0, '应先丢低分召回');
  assert.ok(result.dropped.history.length > 0, '再按最旧挤历史');
  assert.ok(result.layers.history >= DEFAULT_LIMITS.retainTokens);
  assert.equal(result.layers.persona, personaTokens, '人格段不得被裁');
  const droppedScores = result.dropped.recall.map((item) => item.score);
  assert.deepEqual(droppedScores, [...droppedScores].sort((a, b) => a - b));

  const heavyRecall = Array.from({ length: 12 }, (_unused, index) => makeBudgetRecallItem({
    id: `h${index}`,
    score: 0.9 - index * 0.01,
    chars: 1000,
  }));
  const recallOnly = assemble({
    recallItems: heavyRecall,
    history: makeBudgetHistory(12, 40),
    userInput: '继续',
  });
  assert.ok(recallOnly.dropped.recall.length > 0);
  assert.equal(recallOnly.dropped.history.length, 0);
  assert.equal(recallOnly.layers.history, 12 * 20);
});

test('v0.1.1 回归 V14：同一 key 复用，归档线程标记 reactivate-archived', () => {
  const store = Store.open(':memory:');
  try {
    const first = planThreadRun({ store, key: 'rent', name: '租房' });
    assert.equal(first.action, 'create');

    addThread(store, 'rent', { name: '租房' });
    const second = planThreadRun({ store, key: 'rent' });
    assert.equal(second.action, 'reuse');
    assert.equal(second.reason, 'active-thread');

    store.freezeThread('rent');
    const archived = planThreadRun({ store, key: 'rent' });
    assert.equal(archived.action, 'reuse');
    assert.equal(archived.reason, 'reactivate-archived');
    assert.equal(store.getThread('rent').status, 'archived');
  } finally {
    store.close();
  }
});

test('v0.1.1 回归 V14：空闲恰好 14 天不冻结，14 天 + 1 秒冻结', () => {
  const store = Store.open(':memory:');
  const baseSeconds = 1_700_000_000;
  try {
    addThread(store, 'edge', { last_active_at: baseSeconds - 14 * DAY_SECONDS });
    addThread(store, 'stale', { last_active_at: baseSeconds - 14 * DAY_SECONDS - 1 });
    addThread(store, 'fresh', { last_active_at: baseSeconds - 13 * DAY_SECONDS });
    addThread(store, 'already', { status: 'archived', last_active_at: baseSeconds - 30 * DAY_SECONDS });

    const frozen = freezeIdleThreads(store, baseSeconds * 1000);
    assert.equal(frozen, 1);
    assert.equal(store.getThread('edge').status, 'active');
    assert.equal(store.getThread('fresh').status, 'active');
    assert.equal(store.getThread('stale').status, 'archived');
    assert.equal(freezeIdleThreads(store, baseSeconds * 1000), 0);
  } finally {
    store.close();
  }
});

test('v0.1.1 回归 V15：写库失败零落库、不推进水位、不触发压缩', async () => {
  const temp = makeTempStore();
  const clock = createClock(at('2026-11-05T10:00:00'));
  const llm = makeFakeLlm(makeWriteFailDraft());
  const boardBefore = temp.store.getBoardState('main');

  const originalInsertFact = temp.store.insertFact.bind(temp.store);
  let inserted = 0;
  temp.store.insertFact = (input) => {
    inserted += 1;
    if (inserted === 2) throw new Error('insert fact failed');
    return originalInsertFact(input);
  };

  await assert.rejects(
    () => consolidate({
      store: temp.store,
      scope: 'main',
      seqFrom: WRITE_FAIL_SEQ_FROM,
      seqTo: WRITE_FAIL_SEQ_TO,
      llm,
      now: clock.seconds(),
      sessionId: 'v15-session',
    }),
    /insert fact failed/u,
  );

  const stats = temp.store.stats();
  assert.equal(stats.episodes, 0);
  assert.equal(stats.facts, 0);
  assert.equal(stats.reminders, 0);
  assert.equal(stats.consolidations, 0);
  assert.equal(stats.memory_events, 0);
  assert.equal(temp.store.getWatermark('main'), 0);
  const boardAfter = temp.store.getBoardState('main');
  assert.equal(boardAfter.revision, boardBefore.revision);
  assert.equal(boardAfter.staged_revision, boardBefore.staged_revision);

  temp.cleanup();
});
