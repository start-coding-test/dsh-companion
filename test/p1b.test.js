/**
 * P1-b：承诺提醒与轻量闲聊。
 *
 * 分三层：
 * - commitments.js / chat.js 纯函数（时间、排序、敏感词、句数、资格）；
 * - 真实 apply() 注册的 6 个 ASCII 命令与 schema_meta 持久化；
 * - FakeCtx 手动时钟 + 调度器 tick 的生产接线（reminders / idle-probe job）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply } from '../src/index.js';
import {
  commitmentAuditDetail,
  commitmentOverdueDays,
  followedToday,
  followUpText,
  isCommitmentDue,
  scanCommitmentFollowups,
} from '../src/scheduler/commitments.js';
import {
  buildChatPrompt,
  chatEligibility,
  isWeekend,
  normalizeChatText,
} from '../src/persona/chat.js';
import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const NOW_MS = TEST_NOW;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const FIVE_SENTENCES = '今天天气不错。路上看到一棵银杏。中午吃了面。下午把桌子收拾了。晚上准备早点休息。';
const SIX_SENTENCES = `${FIVE_SENTENCES}周末想去公园走走。`;

/**
 * 一条到期承诺。
 * @param {object} [overrides]
 * @returns {object}
 */
function commitmentRow(overrides = {}) {
  return {
    id: 'rm_commitment_1',
    kind: 'commitment',
    status: 'pending',
    title: '交周报',
    detail: null,
    due_at: NOW_SECONDS - 3600,
    due_granularity: 'exact',
    last_fire_key: null,
    deleted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------- 承诺（纯函数）

test('承诺：到期/未完成/未删除才算 due，逾期天数按整天计算', () => {
  assert.equal(isCommitmentDue(commitmentRow(), { now: NOW_MS }), true);
  assert.equal(isCommitmentDue(commitmentRow({ due_at: NOW_SECONDS + 60 }), { now: NOW_MS }), false);
  assert.equal(isCommitmentDue(commitmentRow({ status: 'done' }), { now: NOW_MS }), false);
  assert.equal(isCommitmentDue(commitmentRow({ kind: 'todo' }), { now: NOW_MS }), false);
  assert.equal(isCommitmentDue(commitmentRow({ deleted_at: NOW_SECONDS }), { now: NOW_MS }), false);

  assert.equal(commitmentOverdueDays(commitmentRow(), { now: NOW_MS }), 0);
  assert.equal(
    commitmentOverdueDays(commitmentRow({ due_at: NOW_SECONDS - 2 * 86_400 }), { now: NOW_MS }),
    2,
  );
});

test('承诺：今天已跟进（ISO 日键或旧 Unix 秒）不再扫描', () => {
  const base = commitmentRow();
  assert.equal(followedToday(base, { now: NOW_MS, timeZone: 'Asia/Shanghai' }), false);
  assert.equal(
    followedToday({ ...base, last_fire_key: '2026-11-05' }, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    true,
  );
  assert.equal(
    followedToday({ ...base, last_fire_key: '2026-11-04' }, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    false,
  );
  assert.equal(
    followedToday({ ...base, last_fire_key: String(NOW_SECONDS) }, { now: NOW_MS, timeZone: 'Asia/Shanghai' }),
    true,
  );
});

test('承诺：扫描按逾期降序、due_at 升序，并跳过今天已跟进的行', () => {
  const rows = [
    commitmentRow({ id: 'rm_today', due_at: NOW_SECONDS - 60 }),
    commitmentRow({ id: 'rm_old', due_at: NOW_SECONDS - 3 * 86_400 }),
    commitmentRow({ id: 'rm_done', status: 'done' }),
    commitmentRow({ id: 'rm_followed', last_fire_key: '2026-11-05' }),
    commitmentRow({ id: 'rm_yesterday', due_at: NOW_SECONDS - 86_400 }),
  ];
  const store = { listReminders: () => rows };
  const selected = scanCommitmentFollowups({
    store,
    now: NOW_MS,
    timeZone: 'Asia/Shanghai',
    scope: 'main',
  });
  assert.deepEqual(selected.map((row) => row.id), ['rm_old', 'rm_yesterday', 'rm_today']);
  assert.deepEqual(selected.map((row) => row.overdue_days), [3, 1, 0]);
});

test('承诺：文案用「昨天/前几天说好」；敏感 title 与审计 detail 不泄露', () => {
  const card = { address: '你' };
  assert.match(followUpText({ card, reminder: commitmentRow(), overdueDays: 0 }), /昨天说好/u);
  assert.match(followUpText({ card, reminder: commitmentRow(), overdueDays: 2 }), /前几天说好/u);
  assert.match(followUpText({ card, reminder: commitmentRow(), overdueDays: 2 }), /交周报/u);

  const sensitive = commitmentRow({ title: '银行卡密码要改' });
  const text = followUpText({ card, reminder: sensitive, overdueDays: 1 });
  assert.doesNotMatch(text, /银行卡|密码/u);
  assert.match(text, /那件事/u);
  assert.deepEqual(commitmentAuditDetail(sensitive), {
    kind: 'commitment_followup',
    id: sensitive.id,
  });
  assert.equal(commitmentAuditDetail(commitmentRow()).title, '交周报');
});

// ---------------------------------------------------------------- 闲聊（纯函数）

const MONDAY_10 = Date.parse('2026-11-02T10:00:00+08:00');
const SATURDAY_10 = Date.parse('2026-11-07T10:00:00+08:00');

test('闲聊资格：开关/安静/无互动/周末的优先级', () => {
  const base = { now: MONDAY_10, timeZone: 'Asia/Shanghai', interactionDay: '2026-11-02' };
  assert.equal(chatEligibility({ ...base, enabled: false }).reason, 'disabled');
  assert.equal(chatEligibility({ ...base, quiet: true }).reason, 'quiet');
  assert.equal(chatEligibility({ ...base, interactionDay: '2026-11-01' }).reason, 'no_interaction');
  assert.equal(
    chatEligibility({ ...base, now: SATURDAY_10, interactionDay: '2026-11-07' }).reason,
    'weekend',
  );
  assert.equal(chatEligibility(base).ok, true);
  assert.equal(isWeekend(SATURDAY_10, 'Asia/Shanghai'), true);
  assert.equal(isWeekend(MONDAY_10, 'Asia/Shanghai'), false);
});

test('闲聊资格：3 天冷却、每天 1 条、每周 3 条', () => {
  const base = {
    now: MONDAY_10,
    timeZone: 'Asia/Shanghai',
    interactionDay: '2026-11-02',
  };
  const seconds = Math.floor(MONDAY_10 / 1000);
  assert.equal(
    chatEligibility({ ...base, lastChatAt: seconds - 2 * 86_400 }).reason,
    'cooldown',
  );
  assert.equal(
    chatEligibility({ ...base, lastChatAt: seconds - 3 * 86_400 }).ok,
    true,
  );
  assert.equal(
    chatEligibility({ ...base, sentTimes: [seconds - 3600] }).reason,
    'daily_cap',
  );
  assert.equal(
    chatEligibility({ ...base, sentTimes: [seconds - 86_400, seconds - 2 * 86_400, seconds - 3 * 86_400] }).reason,
    'weekly_cap',
  );
});

test('闲聊输出：只保留 5..10 个陈述句，拒绝问句与违禁词', () => {
  const six = normalizeChatText(SIX_SENTENCES);
  assert.equal(six.ok, true);
  assert.equal(six.sentences, 6);

  const withQuestion = normalizeChatText(`${FIVE_SENTENCES}你周末有空吗？`);
  assert.equal(withQuestion.ok, true);
  assert.equal(withQuestion.sentences, 5);
  assert.doesNotMatch(withQuestion.text, /[？?]/u);

  assert.equal(normalizeChatText('第一句。第二句。第三句。第四句。').reason, 'too_few_sentences');
  assert.equal(
    normalizeChatText(`${FIVE_SENTENCES}亲爱的。`, { bannedPhrases: ['亲爱的'] }).reason,
    'banned_phrase',
  );
  const eleven = Array.from({ length: 11 }, (_, index) => `第${index + 1}句。`).join('');
  assert.equal(normalizeChatText(eleven).sentences, 10);
});

test('闲聊提示词：人格卡 + 最近话题 + 召回摘要 + 不提问约束', () => {
  const prompt = buildChatPrompt({
    card: { name: '珞然', address: '你', tone: { style: '简洁' }, bannedPhrases: ['亲爱的'] },
    recentTopics: [{ title: '预算', summary: '聊到 8000' }],
    recallSummary: '用户偏好美式咖啡',
  });
  assert.match(prompt, /珞然/u);
  assert.match(prompt, /最近话题/u);
  assert.match(prompt, /预算/u);
  assert.match(prompt, /相关记忆/u);
  assert.match(prompt, /美式咖啡/u);
  assert.match(prompt, /不要提问/u);
  assert.match(prompt, /亲爱的/u);
});

// ---------------------------------------------------------------- apply 接线

/**
 * FakeCtx + commands/tools + 可选 chatLlm 宿主 hook。
 * @param {{now?: number, chatLlm?: Function}} [options]
 * @returns {FakeCtx}
 */
function makeCtx({ now = NOW_MS, chatLlm } = {}) {
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
 * 调度器构造时把间隔任务的基线设为当前时刻，先过一个周期再 tick。
 * @param {FakeCtx} ctx
 * @returns {Promise<object[]>}
 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  const result = await ctx.fireTimers();
  await settle(50);
  return result;
}

/**
 * 让 pre-step 看到一条已 commit 的用户消息，并记录当天互动。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {string} [text]
 * @returns {Promise<object>}
 */
async function interact(ctx, session, text = '今天有点累') {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return ctx.dispatch('agent/pre-step', {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn: 1,
    step: 1,
  }, { kind: 'enter', messages: [] });
}

test('命令：6 个 ASCII 名；/别闲聊 与 /恢复闲聊 经 schema_meta 跨重启持久化', () => {
  const temp = makeTempStore();
  const firstCtx = makeCtx();
  const firstHandle = apply(firstCtx, { dbPath: temp.dbPath });
  try {
    const names = firstCtx.commands.registrations.map((definition) => definition.name).sort();
    assert.deepEqual(names, ['chat-off', 'chat-on', 'cost', 'memory', 'status', 'threads']);
    for (const definition of firstCtx.commands.registrations) {
      assert.match(definition.name, /^[a-z][a-z0-9_-]*$/);
    }

    const off = invokeCommand(firstCtx, 'chat-off');
    assert.equal(off.kind, 'success');
    assert.match(off.text, /已关闭主动闲聊/u);
    assert.equal(temp.store.getMeta('p1b.chat.enabled'), '0');
    assert.match(invokeCommand(firstCtx, 'status').text, /闲聊：已关闭/u);

    firstHandle.dispose();

    const secondCtx = makeCtx();
    const secondHandle = apply(secondCtx, { dbPath: temp.dbPath });
    try {
      const status = invokeCommand(secondCtx, 'status');
      assert.match(status.text, /闲聊：已关闭/u);
      assert.match(status.text, /最近一次：无/u);
      assert.match(invokeCommand(secondCtx, 'chat-on').text, /已恢复主动闲聊/u);
      assert.equal(temp.store.getMeta('p1b.chat.enabled'), '1');
      assert.match(invokeCommand(secondCtx, 'status').text, /闲聊：已开启/u);
    } finally {
      secondHandle.dispose();
    }
  } finally {
    temp.cleanup();
  }
});

test('承诺接线：reminders tick 跟进一次，第二天重置；done 后不再跟进', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: NOW_SECONDS - 3600,
      next_fire_at: NOW_SECONDS - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    const first = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(first.length, 1);
    assert.match(first[0], /昨天说好/u);
    assert.equal(temp.store.getReminder(reminder.id).last_fire_key, '2026-11-05');

    const event = temp.store.listEvents({
      table_name: 'reminders',
      row_id: reminder.id,
      action: 'USED',
      limit: 5,
    }).find((row) => row.reason === 'commitment_followup');
    assert.ok(event, '应写 commitment_followup 审计');
    assert.deepEqual(JSON.parse(event.detail_json), {
      kind: 'commitment_followup',
      id: reminder.id,
      title: '交周报',
    });

    // 同一天再次 tick 不重复。
    ctx.advance(30_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 1);

    // 完成后的承诺即使第二天也不再提醒。
    temp.store.db
      .prepare("UPDATE reminders SET status = 'done', closed_at = ? WHERE id = ?")
      .run(NOW_SECONDS, reminder.id);
    ctx.advance(86_400_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('交周报')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('承诺接线：安静时段不打扰，行保持 pending，早上补发一次', async () => {
  const quietNow = Date.parse('2026-11-05T23:30:00+08:00');
  const temp = makeTempStore();
  const ctx = makeCtx({ now: quietNow });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: Math.floor(quietNow / 1000) - 3600,
      next_fire_at: Math.floor(quietNow / 1000) - 3600,
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

test('承诺接线：敏感标题不进入消息正文与审计 detail', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const reminder = temp.store.insertReminder({
      kind: 'commitment',
      title: '银行卡密码要改',
      due_at: NOW_SECONDS - 86_400,
      next_fire_at: NOW_SECONDS - 86_400,
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

test('闲聊接线：互动当天、非安静、5 句投递一次并记录最近时间', async () => {
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

    const status = invokeCommand(ctx, 'status');
    assert.match(status.text, /闲聊：已开启/u);
    assert.match(status.text, /最近一次：2026-11-05 17:0\d/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：无互动不发起；周末不发起', async () => {
  const noInteraction = makeTempStore();
  const first = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const firstHandle = apply(first, { dbPath: noInteraction.dbPath });
  try {
    await firstTick(first);
    assert.equal(promptTexts(first).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    firstHandle.dispose();
    noInteraction.cleanup();
  }

  const weekendNow = Date.parse('2026-11-07T10:00:00+08:00');
  const weekend = makeTempStore();
  const second = makeCtx({ now: weekendNow, chatLlm: async () => FIVE_SENTENCES });
  const secondHandle = apply(second, { dbPath: weekend.dbPath });
  try {
    const session = second.addSession({ id: 'session-1' });
    await interact(second, session, '周六好');
    await firstTick(second);
    assert.equal(promptTexts(second).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    secondHandle.dispose();
    weekend.cleanup();
  }
});

test('闲聊接线：3 天冷却 / 每天 1 条 / 每周 3 条都会跳过', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    temp.store.setMeta('p1b.chat.last_at', String(NOW_SECONDS - 2 * 86_400));
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);

    temp.store.setMeta('p1b.chat.last_at', String(NOW_SECONDS - 3 * 86_400));
    temp.store.setMeta('p1b.chat.sent', JSON.stringify([
      NOW_SECONDS,
      NOW_SECONDS - 86_400,
      NOW_SECONDS - 2 * 86_400,
    ]));
    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：输出不合规（问句过多）不发送，且当天不反复调用模型', async () => {
  const temp = makeTempStore();
  let calls = 0;
  const ctx = makeCtx({
    chatLlm: async () => {
      calls += 1;
      return '你好吗？今天忙不忙？要不要休息？吃了吗？睡得好吗？';
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(calls, 1);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('你好吗')).length, 0);
    assert.equal(temp.store.getMeta('p1b.chat.last_try_day'), '2026-11-05');

    ctx.advance(60_000);
    await ctx.fireTimers();
    await settle(50);
    assert.equal(calls, 1, '同一天失败后不再重复调用模型');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：没有可用模型时只 warn，不影响命令与会话', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
    assert.ok(ctx.logs.some((entry) => /no LLM available for light chat/u.test(entry.message)));

    const status = invokeCommand(ctx, 'status');
    assert.equal(status.kind, 'success');
    assert.match(status.text, /闲聊：已开启/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：成功投递后当天第二次 tick 命中每日上限，不重复发送', async () => {
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
    assert.equal(temp.store.getMeta('p1b.chat.last_try_day'), '2026-11-05');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：用户说「今天不想聊」立即关闭开关', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => FIVE_SENTENCES });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天不想聊');
    assert.equal(temp.store.getMeta('p1b.chat.enabled'), '0');
    await firstTick(ctx);
    assert.equal(promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length, 0);
    assert.match(invokeCommand(ctx, 'status').text, /闲聊：已关闭/u);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('闲聊接线：无效输出/无模型等失败路径不会抛出到调度器', async () => {
  const temp = makeTempStore();
  const ctx = makeCtx({ chatLlm: async () => { throw new Error('model down'); } });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-1' });
    await interact(ctx, session, '今天有点累');
    ctx.advance(60_000);
    await assert.doesNotReject(() => ctx.fireTimers());
    await settle(50);
    assert.ok(ctx.logs.some((entry) => /light chat generation failed/u.test(entry.message)));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
