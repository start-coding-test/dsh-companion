/**
 * v0.7.7 阶段 2：提醒触发点/生命周期、召回领域门、deep-sleep 自动去重。
 *
 * 覆盖面（对应任务书验收单 ③⑤⑥⑦⑧）：
 *   ③ L120-H2：day 粒度补当地 09:00、exact 原样、week/month 不触发；
 *   ⑥ L120-M3：三类过期清理 + snoozed 不动 + 一次性合并告知；
 *   ⑦ L120-M4：闲聊轮工程配置类必须有稀有锚点；
 *   ⑧ L120-M1：跨 kind 不入候选、pinned 不丢、判定 same 才 supersede、
 *      判定失败不落 supersede（dryRun 语义 = 只出清单）。
 *
 * ⚠️ 模型调用全部是 mock（非真机证据）；时间用固定 NOW 与显式 timeZone，
 * 不读 process.env.TZ。50041 云端快照未到，数据均构造。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { jaccard, textBigrams } from '../src/memory/similarity.js';
import {
  planAutoDedupe,
  applyAutoDedupe,
  buildAutoDedupePrompt,
  parseAutoDedupeVerdicts,
} from '../src/memory/govern-auto.js';
import { RARE_ANCHOR_MAX_ITEMS, retrieve } from '../src/memory/retrieve.js';
import { backfillNextFireAt } from '../src/reminder/next-fire.js';
import { injectExpiredNotices } from '../src/reminder/expired-notice.js';
import { governDedupeAuto, expireStaleReminders } from '../src/index.js';

const NOW = 1_790_000_000; // 固定时钟（秒）
const NOW_MS = NOW * 1000;
const DAY = 86_400;

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

/** epoch 秒 → ISO，便于断言时区。 */
function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------- ③ H2

describe('L120-H2：day 粒度补当地 09:00', () => {
  test('已有 next_fire_at 原样保留', () => {
    const reminder = { due_at: NOW, next_fire_at: NOW + 60, due_granularity: 'day' };
    assert.equal(backfillNextFireAt(reminder, { timeZone: 'UTC' }), NOW + 60);
  });

  test('无 due_at / 带 rrule / week / month 一律不触发', () => {
    assert.equal(backfillNextFireAt({ due_granularity: 'day' }, { timeZone: 'UTC' }), null);
    assert.equal(
      backfillNextFireAt({ due_at: NOW, due_granularity: 'day', rrule: 'FREQ=WEEKLY' }, { timeZone: 'UTC' }),
      null,
    );
    assert.equal(backfillNextFireAt({ due_at: NOW, due_granularity: 'week' }, { timeZone: 'UTC' }), null);
    assert.equal(backfillNextFireAt({ due_at: NOW, due_granularity: 'month' }, { timeZone: 'UTC' }), null);
  });

  test('exact 直接等于 due_at', () => {
    assert.equal(backfillNextFireAt({ due_at: NOW, due_granularity: 'exact' }, { timeZone: 'UTC' }), NOW);
  });

  test('Asia/Shanghai：当地 2026-11-21 → 01:00Z', () => {
    const dueAt = Math.floor(Date.parse('2026-11-21T00:00:00Z') / 1000);
    const next = backfillNextFireAt({ due_at: dueAt, due_granularity: 'day' }, { timeZone: 'Asia/Shanghai' });
    assert.equal(iso(next), '2026-11-21T01:00:00.000Z');
  });

  test('UTC：当地 2026-11-21 → 09:00Z', () => {
    const dueAt = Math.floor(Date.parse('2026-11-21T00:00:00Z') / 1000);
    const next = backfillNextFireAt({ due_at: dueAt, due_granularity: 'day' }, { timeZone: 'UTC' });
    assert.equal(iso(next), '2026-11-21T09:00:00.000Z');
  });

  test('America/New_York 春令（2026-03-08）：09:00 当地 = 13:00Z', () => {
    const dueAt = Math.floor(Date.parse('2026-03-08T05:00:00Z') / 1000);
    const next = backfillNextFireAt({ due_at: dueAt, due_granularity: 'day' }, { timeZone: 'America/New_York' });
    assert.equal(iso(next), '2026-03-08T13:00:00.000Z');
  });

  test('America/New_York 秋令（2026-11-01）：09:00 当地 = 14:00Z', () => {
    const dueAt = Math.floor(Date.parse('2026-11-01T04:00:00Z') / 1000);
    const next = backfillNextFireAt({ due_at: dueAt, due_granularity: 'day' }, { timeZone: 'America/New_York' });
    assert.equal(iso(next), '2026-11-01T14:00:00.000Z');
  });

  test('due_at 已过当地 09:00 也取当天（当天补投，不推次日）', () => {
    // 2026-11-21T12:00Z 在上海是 20:00，当天 09:00 早过了 → 仍取当天 09:00。
    const dueAt = Math.floor(Date.parse('2026-11-21T12:00:00Z') / 1000);
    const next = backfillNextFireAt({ due_at: dueAt, due_granularity: 'day' }, { timeZone: 'Asia/Shanghai' });
    assert.equal(iso(next), '2026-11-21T01:00:00.000Z');
  });
});

// ---------------------------------------------------------------- ⑥ M3

describe('L120-M3：提醒生命周期清理', () => {
  /** 把创建/更新时间改成指定时刻（insertReminder 不接受这些列）。 */
  function age(store, id, seconds) {
    store.db.prepare('UPDATE reminders SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(seconds, seconds, id);
  }

  function seed(store, input) {
    return store.insertReminder({ scope: 'main', status: 'pending', ...input });
  }

  test('三类过期 + snoozed 不动 + 其他活跃项保留', (t) => {
    const store = openStore(t);
    const overdue = seed(store, { kind: 'todo', title: '早该做的', due_at: NOW - 2 * DAY, due_granularity: 'exact' });
    const staleTodo = seed(store, { kind: 'todo', title: '八天没动的待办' });
    age(store, staleTodo.id, NOW - 8 * DAY);
    const staleCommitment = seed(store, { kind: 'commitment', title: '一个月前的承诺' });
    age(store, staleCommitment.id, NOW - 31 * DAY);
    const freshTodo = seed(store, { kind: 'todo', title: '刚建的三天待办' });
    age(store, freshTodo.id, NOW - 3 * DAY);
    const repeatReminder = seed(store, {
      kind: 'repeat',
      title: '每周汇报',
      due_at: NOW - 5 * DAY,
      due_granularity: 'day',
      rrule: 'FREQ=WEEKLY',
    });
    const snoozed = seed(store, { kind: 'todo', title: '暂缓的旧事' });
    store.rescheduleReminder(snoozed.id, { next_fire_at: NOW + DAY, status: 'snoozed' });
    age(store, snoozed.id, NOW - 40 * DAY);

    const state = {
      store,
      platform: { log: () => {} },
      config: { reminderStaleDays: 30, reminderTodoStaleDays: 7 },
    };
    const expired = expireStaleReminders(state, NOW_MS);

    assert.equal(expired, 3, '过期 3 条');
    assert.equal(store.getReminder(overdue.id).status, 'expired');
    assert.equal(store.getReminder(staleTodo.id).status, 'expired');
    assert.equal(store.getReminder(staleCommitment.id).status, 'expired');
    assert.equal(store.getReminder(freshTodo.id).status, 'pending', '未到期的不动');
    assert.equal(store.getReminder(repeatReminder.id).status, 'pending', 'repeat 按计划继续');
    assert.equal(store.getReminder(snoozed.id).status, 'snoozed', 'snoozed 不动');
    // 只改状态、不物理删。
    assert.equal(store.listReminders({ scope: 'main', limit: 50 }).length, 6);
  });

  test('过期后一次性合并告知，标记后清零', async (t) => {
    const store = openStore(t);
    const first = store.insertReminder({ scope: 'main', kind: 'todo', title: '旧事一', status: 'pending' });
    const second = store.insertReminder({ scope: 'main', kind: 'todo', title: '旧事二', status: 'pending' });
    store.expireReminder(first.id);
    store.expireReminder(second.id);
    assert.equal(store.listUnnotifiedExpired('main').length, 2);

    const state = { store, platform: { log: () => {} } };
    const decision = await injectExpiredNotices(state, { messages: [] }, 'turn-1', 'main', '在吗');
    const injected = (decision?.inject ?? []).find((message) => message?.source?.kind === 'companion-expired');
    assert.ok(injected, '应注入一条合并告知');
    assert.match(injected.content[0].text, /旧事一/u);
    assert.match(injected.content[0].text, /旧事二/u);
    store.markExpiredNotified([first.id, second.id], NOW);
    assert.equal(store.listUnnotifiedExpired('main').length, 0);
  });
});

// ---------------------------------------------------------------- ⑦ M4

describe('L120-M4：闲聊轮不拖出工程配置事实', () => {
  const AT = NOW;

  function seed(store, input) {
    return store.insertFact({
      source_kind: 'turn',
      salience: 'normal',
      observed_at: AT,
      last_reinforced_at: AT,
      ...input,
    });
  }

  test('闲聊句 + 纯中文查询：技术形态 knowledge 无稀有锚点时不注入', async (t) => {
    const store = openStore(t);
    // 四条都含「压缩」，让该 bigram 的 df ≥4（超出 RARE_ANCHOR_MAX_DF），刻意不稀有。
    for (let index = 0; index < 4; index += 1) {
      seed(store, {
        kind: 'knowledge',
        subject_text: 'compactMinRegionTokens',
        predicate: '默认',
        object_text: '4096',
        statement: `compactMinRegionTokens 默认 4096，压缩区间第 ${index} 条说明。`,
      });
    }
    const result = await retrieve({
      store,
      query: '压缩该怎么设置',
      now: NOW_MS,
      casualChat: true,
    });
    assert.deepEqual(result.items, [], '闲聊轮里这类事实必须命中稀有锚点才注入');
  });

  test('闲聊句里明确提到稀有标识符（flux）仍能召回 project 事实', async (t) => {
    const store = openStore(t);
    const flux = seed(store, {
      kind: 'project',
      subject_text: 'flux 数据集',
      predicate: '位置',
      object_text: 'D 盘',
      statement: 'flux 数据集放在 D 盘。',
    });
    const result = await retrieve({
      store,
      query: '还记得 flux 数据集那事吗',
      now: NOW_MS,
      casualChat: true,
    });
    assert.ok(result.items.some((item) => item.id === flux.id), '命中稀有锚点应放行');
  });

  test('稀有锚点放行受既有配额约束（≤2 条）', async (t) => {
    const store = openStore(t);
    for (const name of ['flux', 'lora', 'qlora']) {
      seed(store, {
        kind: 'project',
        subject_text: `${name} 数据集`,
        predicate: '位置',
        object_text: 'D 盘',
        statement: `${name} 数据集放在 D 盘。`,
      });
    }
    const result = await retrieve({
      store,
      query: 'flux lora qlora 数据集都在哪',
      now: NOW_MS,
      casualChat: true,
    });
    const rare = result.items.filter((item) => item.rare === true);
    assert.ok(rare.length <= RARE_ANCHOR_MAX_ITEMS, `稀有放行不得超过 ${RARE_ANCHOR_MAX_ITEMS} 条`);
  });

  test('非闲聊轮（casualChat=false）不设门：同一查询照常召回', async (t) => {
    const store = openStore(t);
    // 同样用 4 条让「压缩」不稀有：闲聊轮被门拦下，工作轮不受影响。
    for (let index = 0; index < 4; index += 1) {
      seed(store, {
        kind: 'knowledge',
        subject_text: 'compactMinRegionTokens',
        predicate: '默认',
        object_text: '4096',
        statement: `compactMinRegionTokens 默认 4096，压缩区间第 ${index} 条说明。`,
      });
    }
    const casual = await retrieve({ store, query: '压缩该怎么设置', now: NOW_MS, casualChat: true });
    const working = await retrieve({ store, query: '压缩该怎么设置', now: NOW_MS, casualChat: false });
    assert.deepEqual(casual.items, []);
    assert.ok(working.items.length >= 1, '工作轮不受闲聊门影响');
  });
});

// ---------------------------------------------------------------- ⑧ M1

describe('L120-M1：deep-sleep 自动去重', () => {
  function seed(store, input) {
    return store.insertFact({
      kind: 'project',
      subject_text: '预算',
      predicate: '额度',
      object_text: '8000',
      source_kind: 'turn',
      salience: 'normal',
      observed_at: NOW,
      last_reinforced_at: NOW,
      ...input,
    });
  }

  test('同 kind 近似对进候选；跨 kind 再像也不进', (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    const newer = seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    seed(store, { kind: 'knowledge', statement: '预算额度是 8000，项目按这个执行。' });

    const score = jaccard(textBigrams(older.statement), textBigrams(newer.statement));
    assert.ok(score >= 0.6, `构造必须 ≥0.6（实际 ${score.toFixed(3)}）`);
    const { pairs } = planAutoDedupe({ store, scope: 'main', threshold: 0.6 });
    assert.equal(pairs.length, 1, '跨 kind 不配对');
    assert.equal(pairs[0].keep.id, newer.id, '较新者保留');
    assert.equal(pairs[0].drop.id, older.id);
  });

  test('pinned 永不被 drop（即使更旧）', (t) => {
    const store = openStore(t);
    const pinned = seed(store, {
      statement: '预算额度是 8000，项目按这个走。',
      salience: 'pinned',
      last_reinforced_at: NOW - 30 * DAY,
      observed_at: NOW - 30 * DAY,
    });
    seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const { pairs } = planAutoDedupe({ store, scope: 'main', threshold: 0.6 });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].keep.id, pinned.id, 'pinned 保留');
    assert.notEqual(pairs[0].drop.id, pinned.id, 'pinned 不进 drop');
  });

  test('dryRun 语义：plan 只出清单不写库', (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    const newer = seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const { pairs } = planAutoDedupe({ store, scope: 'main', threshold: 0.6 });
    assert.equal(pairs.length, 1);
    assert.equal(store.getFact(older.id).status, 'active', 'plan 不改状态');
    assert.equal(store.getFact(newer.id).status, 'active');
  });

  test('judge=same 才 supersede 旧条，判 new 不动', (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    const newer = seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const { pairs } = planAutoDedupe({ store, scope: 'main', threshold: 0.6 });

    const prompt = buildAutoDedupePrompt(pairs);
    assert.match(prompt, /预算额度/u, '提示词带上 A/B 正文');
    const sameVerdicts = parseAutoDedupeVerdicts({ items: [{ index: 1, verdict: 'same' }] }, pairs.length);
    const applied = applyAutoDedupe({ store, scope: 'main', pairs, verdicts: sameVerdicts, now: NOW_MS });
    assert.equal(applied.superseded, 1);
    assert.equal(store.getFact(older.id).status, 'superseded');
    assert.equal(store.getFact(newer.id).status, 'active');
    // 不物理删除。
    assert.ok(store.getFact(older.id));

    const notSame = parseAutoDedupeVerdicts({ items: [{ index: 1, verdict: 'new' }] }, pairs.length);
    const second = applyAutoDedupe({ store, scope: 'main', pairs, verdicts: notSame, now: NOW_MS });
    assert.equal(second.superseded, 0, '判 new 不 supersede');
  });

  test('缺项兜底为 new：宁可多留一条也不误删', () => {
    assert.deepEqual(parseAutoDedupeVerdicts({ items: [] }, 2), ['new', 'new']);
    assert.equal(parseAutoDedupeVerdicts('not json', 1), null);
  });

  test('governDedupeAuto：无 llm 路由时跳过且不写 meta、不改库', async (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const state = {
      store,
      platform: { log: () => {}, now: () => NOW_MS, capabilities: { llm: false } },
      config: { govern: { autoDedupeThreshold: 0.6 } },
    };
    const result = await governDedupeAuto(state, NOW_MS);
    assert.equal(result.skipped, 'no-llm');
    assert.equal(result.candidates, 1);
    assert.equal(store.getFact(older.id).status, 'active');
    assert.equal(store.getMeta('govern_last_run'), null, '跳过时不写 meta');
  });

  test('governDedupeAuto：判定失败只 warn，不 supersede、不写 meta', async (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const state = {
      store,
      platform: {
        log: () => {},
        now: () => NOW_MS,
        capabilities: { llm: true },
        complete: async () => {
          throw new Error('judge timeout');
        },
      },
      config: { consolidation: { model: { provider: 'p', model: 'm' } }, govern: { autoDedupeThreshold: 0.6 } },
    };
    const result = await governDedupeAuto(state, NOW_MS);
    assert.equal(result.skipped, 'judge-failed');
    assert.equal(store.getFact(older.id).status, 'active');
    assert.equal(store.getMeta('govern_last_run'), null);
  });

  test('governDedupeAuto：判定 same → supersede 旧条并写 /状态 用的 meta', async (t) => {
    const store = openStore(t);
    const older = seed(store, { statement: '预算额度是 8000，项目按这个走。', last_reinforced_at: NOW - DAY });
    seed(store, { statement: '预算额度是 8000，项目按这个执行。', last_reinforced_at: NOW });
    const state = {
      store,
      platform: {
        log: () => {},
        now: () => NOW_MS,
        capabilities: { llm: true },
        complete: async () => JSON.stringify({ items: [{ index: 1, verdict: 'same' }] }),
      },
      config: { consolidation: { model: { provider: 'p', model: 'm' } }, govern: { autoDedupeThreshold: 0.6 } },
    };
    const result = await governDedupeAuto(state, NOW_MS);
    assert.equal(result.judgedSame, 1);
    assert.equal(result.superseded, 1);
    assert.equal(store.getFact(older.id).status, 'superseded');
    const meta = JSON.parse(store.getMeta('govern_last_run'));
    assert.equal(meta.superseded, 1);
    assert.equal(meta.threshold, 0.6);
  });
});
