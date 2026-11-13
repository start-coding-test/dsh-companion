/**
 * 重复提醒 rrule 子集与展开：解析、推进、COUNT/UNTIL、重试不漂移、跨 DST、
 * 区间计数与格式化。
 *
 * 所有断言都用固定 UTC 时刻 + 显式 IANA 时区，因此 TZ=UTC /
 * TZ=America/New_York 等环境变量不影响结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RRULE_ITERATIONS,
  countOccurrencesBetween,
  formatRRule,
  nextOccurrence,
  parseRRule,
} from '../src/scheduler/recurrence.js';
import { zonedParts } from '../src/time.js';

const HOUR = 3_600;
const DAY = 86_400;
const SHANGHAI = 'Asia/Shanghai';
const NEW_YORK = 'America/New_York';

/** ISO 时刻 → Unix 秒。 */
function at(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

/** 解析并断言成功，返回 rule 对象。 */
function ruleOf(text) {
  const parsed = parseRRule(text);
  assert.equal(parsed.ok, true, `parseRRule 应成功：${text}`);
  return parsed.rule;
}

function next({ rule, anchorAt, afterAt, timeZone = SHANGHAI }) {
  return nextOccurrence({ rule, anchorAt, afterAt, timeZone });
}

function countBetween({ rule, anchorAt, fromAt, toAt, timeZone = SHANGHAI }) {
  return countOccurrencesBetween({ rule, anchorAt, fromAt, toAt, timeZone });
}

test('parseRRule：DAILY 基本形态与缺省值', () => {
  assert.deepEqual(parseRRule('FREQ=DAILY'), {
    ok: true,
    rule: { freq: 'DAILY', interval: 1, byDay: null, count: null, until: null },
  });
  assert.deepEqual(parseRRule('FREQ=DAILY;INTERVAL=1'), {
    ok: true,
    rule: { freq: 'DAILY', interval: 1, byDay: null, count: null, until: null },
  });
});

test('parseRRule：WEEKLY BYDAY 去重排序、COUNT、INTERVAL', () => {
  assert.deepEqual(
    ruleOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10'),
    { freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], count: 10, until: null },
  );
  assert.deepEqual(ruleOf('FREQ=WEEKLY;BYDAY=WE,MO,WE').byDay, ['MO', 'WE']);
  assert.deepEqual(ruleOf('FREQ=WEEKLY;BYDAY=SU,SA,FR').byDay, ['FR', 'SA', 'SU']);
});

test('parseRRule：键名大小写不敏感、允许空格、重复键取第一个', () => {
  assert.deepEqual(ruleOf(' freq = daily ; interval = 3 '), {
    freq: 'DAILY', interval: 3, byDay: null, count: null, until: null,
  });
  assert.equal(ruleOf('FREQ=DAILY;INTERVAL=2;INTERVAL=5').interval, 2);
  assert.equal(ruleOf('FREQ=DAILY;COUNT=2;COUNT=9').count, 2);
});

test('parseRRule：UNTIL 日期形态按当日 23:59:59Z 折算，时刻形态按 UTC', () => {
  assert.equal(
    ruleOf('FREQ=DAILY;UNTIL=20261120').until,
    Date.UTC(2026, 10, 20, 23, 59, 59) / 1000,
  );
  assert.equal(
    ruleOf('FREQ=DAILY;UNTIL=20261120T081500Z').until,
    Date.UTC(2026, 10, 20, 8, 15, 0) / 1000,
  );
});

test('parseRRule：不支持的规则返回 rrule_unsupported', () => {
  for (const text of [
    'FREQ=HOURLY',
    'FREQ=MONTHLY',
    'FREQ=DAILY;BYDAY=MO',
    'FREQ=DAILY;BYMONTHDAY=1',
    'FREQ=DAILY;BYSETPOS=1',
    'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9',
  ]) {
    const parsed = parseRRule(text);
    assert.equal(parsed.ok, false, text);
    assert.equal(parsed.reason, 'rrule_unsupported', text);
    assert.equal(typeof parsed.detail, 'string', text);
  }
});

test('parseRRule：非法输入返回 rrule_invalid', () => {
  for (const text of [
    '',
    '   ',
    null,
    42,
    {},
    'FREQ=DAILY;',
    'INTERVAL=2',
    'FREQ=DAILY;INTERVAL=0',
    'FREQ=DAILY;INTERVAL=-1',
    'FREQ=DAILY;INTERVAL=1.5',
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;COUNT=1.5',
    'FREQ=WEEKLY;BYDAY=XX',
    'FREQ=WEEKLY;BYDAY=',
    'FREQ=WEEKLY;BYDAY=MO,,WE',
    'FREQ=DAILY;UNTIL=20260230',
    'FREQ=DAILY;UNTIL=20261120T250000Z',
    'FREQ=DAILY;UNTIL=20261120T080000',
  ]) {
    const parsed = parseRRule(text);
    assert.equal(parsed.ok, false, String(text));
    assert.equal(parsed.reason, 'rrule_invalid', String(text));
    assert.equal(typeof parsed.detail, 'string', String(text));
  }
});

test('nextOccurrence：DAILY 基本推进与 afterAt 落在两次之间', () => {
  const rule = ruleOf('FREQ=DAILY');
  const anchor = at('2026-11-13T00:00:00Z'); // 上海本地 08:00

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor - 1 }), {
    ok: true, at: anchor, index: 0, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: anchor + DAY, index: 1, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor + 5 * HOUR }), {
    ok: true, at: anchor + DAY, index: 1, exhausted: false,
  });

  // 本地墙上时间始终是 08:00
  for (const offset of [1, 2, 3]) {
    const result = next({ rule, anchorAt: anchor, afterAt: anchor + (offset - 1) * DAY });
    const wall = zonedParts(result.at * 1000, SHANGHAI);
    assert.equal(wall.hour, 8);
    assert.equal(wall.minute, 0);
  }
});

test('nextOccurrence：DAILY INTERVAL 推进', () => {
  const anchor = at('2026-11-13T00:00:00Z');
  const rule = ruleOf('FREQ=DAILY;INTERVAL=3');

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: anchor + 3 * DAY, index: 1, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor + 3 * DAY }), {
    ok: true, at: anchor + 6 * DAY, index: 2, exhausted: false,
  });
  // 非触发日当作「两次之间」，取下一次
  assert.equal(next({ rule, anchorAt: anchor, afterAt: anchor + DAY }).at, anchor + 3 * DAY);
});

test('nextOccurrence：WEEKLY 多日按周内顺序推进', () => {
  const anchor = at('2026-11-16T01:00:00Z'); // 上海 2026-11-16（周一）09:00
  const rule = ruleOf('FREQ=WEEKLY;BYDAY=MO,WE');

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: at('2026-11-18T01:00:00Z'), index: 1, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-18T01:00:00Z') }), {
    ok: true, at: at('2026-11-23T01:00:00Z'), index: 2, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-23T01:00:00Z') }), {
    ok: true, at: at('2026-11-25T01:00:00Z'), index: 3, exhausted: false,
  });
});

test('nextOccurrence：WEEKLY 单日与 INTERVAL=2 跨周', () => {
  const anchor = at('2026-11-16T01:00:00Z'); // 周一 09:00

  const single = ruleOf('FREQ=WEEKLY');
  assert.deepEqual(next({ rule: single, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: at('2026-11-23T01:00:00Z'), index: 1, exhausted: false,
  });

  const biweekly = ruleOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
  assert.equal(next({ rule: biweekly, anchorAt: anchor, afterAt: anchor }).at, at('2026-11-18T01:00:00Z'));
  assert.deepEqual(next({ rule: biweekly, anchorAt: anchor, afterAt: at('2026-11-18T01:00:00Z') }), {
    ok: true, at: at('2026-11-30T01:00:00Z'), index: 2, exhausted: false,
  });
  assert.equal(
    next({ rule: biweekly, anchorAt: anchor, afterAt: at('2026-11-30T01:00:00Z') }).at,
    at('2026-12-02T01:00:00Z'),
  );
});

test('nextOccurrence：WEEKLY BYDAY 不含锚点星期时从锚点之后第一个格点开始', () => {
  // 锚点是周一，规则只要周日：周一不是触发点，序列从 2026-11-22（周日）开始。
  const anchor = at('2026-11-16T01:00:00Z');
  const rule = ruleOf('FREQ=WEEKLY;BYDAY=SU');
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: at('2026-11-22T01:00:00Z'), index: 0, exhausted: false,
  });
  assert.equal(
    next({ rule, anchorAt: anchor, afterAt: at('2026-11-22T01:00:00Z') }).at,
    at('2026-11-29T01:00:00Z'),
  );
});

test('nextOccurrence：COUNT 含 anchor 本身，耗尽后 exhausted', () => {
  const anchor = at('2026-11-13T00:00:00Z');
  const rule = ruleOf('FREQ=DAILY;COUNT=3');

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor - 1 }), {
    ok: true, at: anchor, index: 0, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor + DAY }), {
    ok: true, at: anchor + 2 * DAY, index: 2, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: anchor + 2 * DAY }), {
    ok: true, at: null, index: null, exhausted: true,
  });

  const once = ruleOf('FREQ=DAILY;COUNT=1');
  assert.equal(next({ rule: once, anchorAt: anchor, afterAt: anchor - 1 }).at, anchor);
  assert.deepEqual(next({ rule: once, anchorAt: anchor, afterAt: anchor }), {
    ok: true, at: null, index: null, exhausted: true,
  });

  const weekly = ruleOf('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2');
  const monday = at('2026-11-16T01:00:00Z');
  assert.equal(next({ rule: weekly, anchorAt: monday, afterAt: monday }).index, 1);
  assert.deepEqual(next({ rule: weekly, anchorAt: monday, afterAt: at('2026-11-18T01:00:00Z') }), {
    ok: true, at: null, index: null, exhausted: true,
  });
});

test('nextOccurrence：UNTIL 日期形态包含当天', () => {
  const anchor = at('2026-11-18T00:00:00Z'); // 上海 08:00
  const rule = ruleOf('FREQ=DAILY;UNTIL=20261120');

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-19T00:00:00Z') }), {
    ok: true, at: at('2026-11-20T00:00:00Z'), index: 2, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-20T00:00:00Z') }), {
    ok: true, at: null, index: null, exhausted: true,
  });
});

test('nextOccurrence：UNTIL UTC 时刻形态，等于该时刻仍算一次', () => {
  const anchor = at('2026-11-18T00:00:00Z');
  const rule = ruleOf('FREQ=DAILY;UNTIL=20261120T000000Z');

  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-19T00:00:00Z') }), {
    ok: true, at: at('2026-11-20T00:00:00Z'), index: 2, exhausted: false,
  });
  assert.deepEqual(next({ rule, anchorAt: anchor, afterAt: at('2026-11-20T00:00:00Z') }), {
    ok: true, at: null, index: null, exhausted: true,
  });
});

test('nextOccurrence：重试后仍按原序列推进，不漂移', () => {
  const anchor = at('2026-11-16T01:00:00Z'); // 周一 09:00
  const rule = ruleOf('FREQ=WEEKLY;BYDAY=MO,WE');

  // 周一原定 09:00，实际 14:30 才送达
  const first = next({ rule, anchorAt: anchor, afterAt: anchor + 5 * HOUR + 30 * 60 });
  assert.deepEqual(first, {
    ok: true, at: at('2026-11-18T01:00:00Z'), index: 1, exhausted: false,
  });

  // 周三原定 09:00，实际 10:07 才送达
  const second = next({
    rule,
    anchorAt: anchor,
    afterAt: at('2026-11-18T01:00:00Z') + HOUR + 7 * 60,
  });
  assert.deepEqual(second, {
    ok: true, at: at('2026-11-23T01:00:00Z'), index: 2, exhausted: false,
  });
});

test('DST 春进：America/New_York 01:30 日更序列保持本地 01:30（2027-03-14）', () => {
  const rule = ruleOf('FREQ=DAILY');
  const anchor = at('2027-03-12T06:30:00Z'); // 03-12 01:30 EST

  const first = next({ rule, anchorAt: anchor, afterAt: anchor, timeZone: NEW_YORK });
  assert.deepEqual(first, {
    ok: true, at: at('2027-03-13T06:30:00Z'), index: 1, exhausted: false,
  });

  const second = next({ rule, anchorAt: anchor, afterAt: first.at, timeZone: NEW_YORK });
  assert.equal(second.at, at('2027-03-14T06:30:00Z'));

  const third = next({ rule, anchorAt: anchor, afterAt: second.at, timeZone: NEW_YORK });
  assert.equal(third.at, at('2027-03-15T05:30:00Z'));

  for (const instant of [anchor, first.at, second.at, third.at]) {
    const wall = zonedParts(instant * 1000, NEW_YORK);
    assert.equal(wall.hour, 1);
    assert.equal(wall.minute, 30);
  }
  // 切换前一天仍是 EST（24h），切换后一天变成 EDT（23h）
  assert.equal(second.at - first.at, DAY);
  assert.equal(third.at - second.at, 23 * HOUR);
});

test('DST 秋退：America/New_York 01:30 日更序列取较早瞬时（2027-11-07）', () => {
  const rule = ruleOf('FREQ=DAILY');
  const anchor = at('2027-11-06T05:30:00Z'); // 11-06 01:30 EDT

  const first = next({ rule, anchorAt: anchor, afterAt: anchor, timeZone: NEW_YORK });
  assert.deepEqual(first, {
    ok: true, at: at('2027-11-07T05:30:00Z'), index: 1, exhausted: false,
  });

  const second = next({ rule, anchorAt: anchor, afterAt: first.at, timeZone: NEW_YORK });
  assert.equal(second.at, at('2027-11-08T06:30:00Z')); // 11-08 01:30 EST

  for (const instant of [anchor, first.at, second.at]) {
    const wall = zonedParts(instant * 1000, NEW_YORK);
    assert.equal(wall.hour, 1);
    assert.equal(wall.minute, 30);
  }
  // 秋退当天取较早的那个 01:30（EDT），到次日间隔 25h
  assert.equal(first.at - anchor, DAY);
  assert.equal(second.at - first.at, 25 * HOUR);
});

test('DST 春进缺口：不存在的本地 02:30 归一到缺口之后的 03:30', () => {
  const rule = ruleOf('FREQ=DAILY');
  const anchor = at('2027-03-13T07:30:00Z'); // 03-13 02:30 EST

  const result = next({ rule, anchorAt: anchor, afterAt: anchor, timeZone: NEW_YORK });
  assert.equal(result.ok, true);
  assert.equal(result.index, 1);
  assert.equal(result.at, at('2027-03-14T07:30:00Z')); // 03:30 EDT
  const wall = zonedParts(result.at * 1000, NEW_YORK);
  assert.equal(wall.hour, 3);
  assert.equal(wall.minute, 30);

  // 序列仍严格递增（向后归一化）
  const following = next({ rule, anchorAt: anchor, afterAt: result.at, timeZone: NEW_YORK });
  assert.equal(following.at, at('2027-03-15T06:30:00Z')); // 03-15 02:30 EDT
});

test('countOccurrencesBetween：fromAt 不含、toAt 含', () => {
  const anchor = at('2026-11-13T00:00:00Z');
  const rule = ruleOf('FREQ=DAILY');

  assert.equal(countBetween({ rule, anchorAt: anchor, fromAt: anchor, toAt: anchor + 3 * DAY }).count, 3);
  assert.equal(countBetween({ rule, anchorAt: anchor, fromAt: anchor - 1, toAt: anchor }).count, 1);
  assert.equal(countBetween({ rule, anchorAt: anchor, fromAt: anchor, toAt: anchor }).count, 0);
  assert.equal(countBetween({ rule, anchorAt: anchor, fromAt: anchor + 1, toAt: anchor + 2 * DAY }).count, 2);
  assert.equal(countBetween({ rule, anchorAt: anchor, fromAt: anchor + 5 * DAY, toAt: anchor + 2 * DAY }).count, 0);
});

test('countOccurrencesBetween：遵守 COUNT 与 UNTIL', () => {
  const anchor = at('2026-11-13T00:00:00Z');

  const capped = ruleOf('FREQ=DAILY;COUNT=2');
  assert.equal(
    countBetween({ rule: capped, anchorAt: anchor, fromAt: anchor - 1, toAt: anchor + 10 * DAY }).count,
    2,
  );

  const untilRule = ruleOf('FREQ=DAILY;UNTIL=20261120');
  const lateAnchor = at('2026-11-18T00:00:00Z');
  assert.equal(
    countBetween({ rule: untilRule, anchorAt: lateAnchor, fromAt: lateAnchor - 1, toAt: lateAnchor + 10 * DAY }).count,
    3,
  );
});

test('countOccurrencesBetween：WEEKLY 多日与边界', () => {
  const anchor = at('2026-11-16T01:00:00Z'); // 周一 09:00
  const rule = ruleOf('FREQ=WEEKLY;BYDAY=MO,WE');

  assert.equal(
    countBetween({ rule, anchorAt: anchor, fromAt: anchor, toAt: at('2026-11-25T01:00:00Z') }).count,
    3, // 周三 18、周一 23、周三 25
  );
  assert.equal(
    countBetween({
      rule,
      anchorAt: anchor,
      fromAt: at('2026-11-18T01:00:00Z'),
      toAt: at('2026-11-23T01:00:00Z'),
    }).count,
    1, // 起点不含周三，终点含周一
  );
});

test('formatRRule：四种形态与 COUNT/UNTIL 后缀', () => {
  const daily8 = at('2026-11-13T00:00:00Z'); // 上海 08:00
  const weekly9 = at('2026-11-16T01:00:00Z'); // 上海 09:00

  assert.equal(
    formatRRule('FREQ=DAILY;INTERVAL=1', { timeZone: SHANGHAI, anchorAt: daily8 }),
    '每天 08:00',
  );
  assert.equal(
    formatRRule('FREQ=DAILY;INTERVAL=2', { timeZone: SHANGHAI, anchorAt: daily8 }),
    '每 2 天 08:00',
  );
  assert.equal(
    formatRRule('FREQ=WEEKLY;BYDAY=MO,WE', { timeZone: SHANGHAI, anchorAt: weekly9 }),
    '每周一、周三 09:00',
  );
  assert.equal(
    formatRRule('FREQ=WEEKLY', { timeZone: SHANGHAI, anchorAt: weekly9 }),
    '每周 09:00',
  );
  assert.equal(
    formatRRule('FREQ=DAILY;COUNT=10', { timeZone: SHANGHAI, anchorAt: daily8 }),
    '每天 08:00（共 10 次）',
  );
  assert.equal(
    formatRRule('FREQ=DAILY;UNTIL=20261120', { timeZone: SHANGHAI, anchorAt: daily8 }),
    '每天 08:00（至 2026-11-20）',
  );
});

test('formatRRule：时区参与取时刻、无 anchorAt 不臆造时刻、非法文本兜底', () => {
  const instant = at('2026-11-13T00:00:00Z');
  assert.equal(formatRRule('FREQ=DAILY', { timeZone: 'UTC', anchorAt: instant }), '每天 00:00');
  assert.equal(formatRRule('FREQ=DAILY', { timeZone: SHANGHAI, anchorAt: instant }), '每天 08:00');
  assert.equal(formatRRule('FREQ=DAILY', { timeZone: SHANGHAI }), '每天');
  assert.equal(formatRRule('FREQ=HOURLY', { timeZone: SHANGHAI }), '重复规则无效');
  assert.equal(formatRRule('not-a-rule', { timeZone: SHANGHAI }), '重复规则无效');
  assert.equal(formatRRule(null, { timeZone: SHANGHAI }), '重复规则无效');
});

test('非法输入与溢出：返回稳定 reason，不抛异常', () => {
  assert.deepEqual(
    nextOccurrence({ rule: 'FREQ=HOURLY', anchorAt: 0, afterAt: 0 }),
    { ok: false, reason: 'rrule_invalid' },
  );
  assert.deepEqual(
    nextOccurrence({
      rule: ruleOf('FREQ=DAILY'),
      anchorAt: at('2026-11-13T00:00:00Z'),
      afterAt: at('2026-11-13T00:00:00Z'),
      timeZone: 'Not/AZone',
    }),
    { ok: false, reason: 'invalid_time_zone' },
  );
  assert.equal(nextOccurrence().ok, false);
  assert.equal(
    countOccurrencesBetween({
      rule: ruleOf('FREQ=DAILY'),
      anchorAt: at('2026-11-13T00:00:00Z'),
      fromAt: null,
      toAt: at('2026-11-20T00:00:00Z'),
    }).ok,
    false,
  );

  const anchor = at('2026-01-01T00:00:00Z');
  assert.deepEqual(
    nextOccurrence({
      rule: ruleOf('FREQ=DAILY'),
      anchorAt: anchor,
      afterAt: anchor + (MAX_RRULE_ITERATIONS + 5) * DAY,
      timeZone: 'UTC',
    }),
    { ok: false, reason: 'rrule_overflow' },
  );
});
