/**
 * v0.4.13 A4（工具侧）：reminder_add 接受 rrule。
 *
 * 覆盖：DAILY 首次触发点、WEEKLY+BYDAY、INTERVAL/COUNT/UNTIL 原样保留、
 * 不支持的形式明确拒绝、kind=repeat 缺 rrule、非法 BYDAY。投递/推进序列
 * （送完不算 done、推进到下一次）由接线与 store 的 advanceReminderOccurrence
 * 负责，在 store v15 合并后覆盖。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import { nextOccurrence, parseRRule } from '../src/scheduler/recurrence.js';

const CLOCK = Date.UTC(2026, 10, 13, 0, 0, 0); // 2026-11-13 08:00 Asia/Shanghai
const TZ = 'Asia/Shanghai';

function setup(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const tools = createTools({ store, clock: () => CLOCK, timeZone: TZ });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { store, add: byName.get('reminder_add') };
}

function expectedFirst(rrule, anchor) {
  const parsed = parseRRule(rrule);
  assert.equal(parsed.ok, true);
  const next = nextOccurrence({ rule: parsed.rule, anchorAt: anchor, afterAt: anchor - 1, timeZone: TZ });
  assert.equal(next.ok, true);
  return next.at;
}

describe('reminder_add + rrule（A4 工具侧）', () => {
  test('FREQ=DAILY：首次触发落在当天的配置时区时刻', async (t) => {
    const { store, add } = setup(t);
    const anchor = Math.floor(CLOCK / 1000);
    const result = await add.execute({ title: '每天喝水', kind: 'repeat', rrule: 'FREQ=DAILY' });
    assert.equal(result.ok, true);
    assert.equal(result.reminder.rrule, 'FREQ=DAILY');
    assert.equal(result.reminder.next_fire_at, expectedFirst('FREQ=DAILY', anchor));
    assert.equal(result.reminder.due_at, result.reminder.next_fire_at);
    const row = store.getReminder(result.reminder.id);
    assert.equal(row.rrule, 'FREQ=DAILY');
    assert.equal(row.next_fire_at, result.reminder.next_fire_at);
  });

  test('FREQ=WEEKLY;BYDAY=MO,TH：锚点是周三 08:00，下一次是周四 08:00', async (t) => {
    const { add } = setup(t);
    const anchor = Math.floor(CLOCK / 1000);
    const result = await add.execute({
      title: '每周锻炼',
      kind: 'repeat',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
    });
    assert.equal(result.ok, true);
    assert.equal(result.reminder.next_fire_at, expectedFirst('FREQ=WEEKLY;BYDAY=MO,TH', anchor));
    // 锚点是 2026-11-13（周五）08:00，MO/TH 的下一次是 2026-11-16（周一）08:00。
    assert.equal(result.reminder.next_fire_at, Date.UTC(2026, 10, 16, 0, 0, 0) / 1000);
  });

  test('INTERVAL / COUNT / UNTIL 原样保留', async (t) => {
    const { store, add } = setup(t);
    const rrule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=4';
    const result = await add.execute({ title: '双周会', kind: 'repeat', rrule });
    assert.equal(result.ok, true);
    assert.equal(result.reminder.rrule, rrule);
    assert.equal(store.getReminder(result.reminder.id).rrule, rrule);
  });

  test('due_at 作为锚点：首次触发从该时刻起算', async (t) => {
    const { add } = setup(t);
    const dueAt = Date.UTC(2026, 10, 20, 1, 30, 0) / 1000; // 09:30 +08
    const result = await add.execute({
      title: '每天早上汇报',
      kind: 'repeat',
      rrule: 'FREQ=DAILY',
      due_at: dueAt,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reminder.next_fire_at, dueAt);
  });

  test('不支持的形式返回 rrule_unsupported', async (t) => {
    const { add } = setup(t);
    const monthly = await add.execute({ title: '每月体检', kind: 'repeat', rrule: 'FREQ=MONTHLY' });
    assert.equal(monthly.ok, false);
    assert.equal(monthly.reason, 'rrule_unsupported');
    const bymonthday = await add.execute({ title: 'x', kind: 'repeat', rrule: 'FREQ=DAILY;BYMONTHDAY=1' });
    assert.equal(bymonthday.ok, false);
    assert.equal(bymonthday.reason, 'rrule_unsupported');
  });

  test('kind=repeat 缺 rrule 返回 rrule_required', async (t) => {
    const { add } = setup(t);
    const result = await add.execute({ title: '喝水', kind: 'repeat' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'rrule_required');
  });

  test('非法 BYDAY / 空 rrule 返回 rrule_invalid', async (t) => {
    const { add } = setup(t);
    const bad = await add.execute({ title: 'x', kind: 'repeat', rrule: 'FREQ=WEEKLY;BYDAY=FOO' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'rrule_invalid');
    const empty = await add.execute({ title: 'y', kind: 'repeat', rrule: '   ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'rrule_required');
  });

  test('不带 rrule 的一次性提醒行为不变', async (t) => {
    const { add } = setup(t);
    const dueAt = Math.floor(CLOCK / 1000) + 3_600;
    const result = await add.execute({ title: '交材料', due_at: dueAt });
    assert.equal(result.ok, true);
    assert.equal(result.reminder.rrule, null);
    assert.equal(result.reminder.next_fire_at, dueAt);
  });
});
