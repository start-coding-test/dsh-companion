import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, DEFAULTS, isQuietAt, normalizeConfig, parseClock } from '../src/config.js';
import { apply, name as pluginName } from '../src/index.js';
import { zonedMinutesOfDay } from '../src/time.js';

/**
 * 构造 Asia/Shanghai 墙上时间（与配置默认 timezone 一致）。
 * 显式写 +08:00，结果不随进程 TZ 漂移；安静时段断言才有确定含义。
 */
function at(hours, minutes, day = 15) {
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return new Date(Date.parse(`2026-01-${dd}T${hh}:${mm}:00+08:00`));
}

function expectConfigError(raw, expectedField) {
  assert.throws(
    () => normalizeConfig(raw),
    (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err?.constructor?.name}`);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'ConfigError');
      assert.equal(err.field, expectedField);
      return true;
    },
  );
}

describe('DEFAULTS', () => {
  test('关键默认值与设计文档一致', () => {
    assert.equal(DEFAULTS.workingMemoryTokens, 32000);
    assert.equal(DEFAULTS.compactAtTokens, 24000);
    assert.equal(DEFAULTS.compactHardTokens, 40000);
    assert.equal(DEFAULTS.retainTokens, 6144);
    assert.equal(DEFAULTS.threadIdleDays, 14);
    assert.equal(DEFAULTS.threadMaxActive, 6);
    assert.equal(DEFAULTS.proactiveDailyCap, 3);
    assert.equal(DEFAULTS.quietStart, '23:00');
    assert.equal(DEFAULTS.quietEnd, '08:00');
    assert.equal(DEFAULTS.timezone, 'Asia/Shanghai');
    assert.equal(DEFAULTS.idleMs, 30 * 60 * 1000);
    assert.equal(DEFAULTS.purgeAfterDays, 7);
    assert.equal(DEFAULTS.dbPath, './.data/companion.db');
    assert.equal(DEFAULTS.rssWarnGiB, 2.95);
    assert.equal(DEFAULTS.rssStopGiB, 3);
    assert.equal(DEFAULTS.rssMainOnlyGiB, 3.15);
  });
});

describe('normalizeConfig', () => {
  test('无参调用返回默认值且无警告', () => {
    const cfg = normalizeConfig();
    for (const key of Object.keys(DEFAULTS)) {
      assert.deepEqual(cfg[key], DEFAULTS[key], `field ${key}`);
    }
    assert.deepEqual(cfg.warnings, []);
  });

  test('undefined / null 视为空配置', () => {
    assert.deepEqual(normalizeConfig(undefined).warnings, []);
    assert.deepEqual(normalizeConfig(null).warnings, []);
    assert.equal(normalizeConfig(null).workingMemoryTokens, 32000);
  });

  test('用户覆盖生效且其余字段回落默认值', () => {
    const cfg = normalizeConfig({
      threadIdleDays: 30,
      quietStart: '22:30',
      quietEnd: '06:15',
      purgeAfterDays: 3,
    });
    assert.equal(cfg.threadIdleDays, 30);
    assert.equal(cfg.quietStart, '22:30');
    assert.equal(cfg.quietEnd, '06:15');
    assert.equal(cfg.purgeAfterDays, 3);
    assert.equal(cfg.workingMemoryTokens, 32000);
    assert.equal(cfg.threadMaxActive, 6);
  });

  test('返回对象被 Object.freeze 且不可写', () => {
    const cfg = normalizeConfig({ threadIdleDays: 21 });
    assert.equal(Object.isFrozen(cfg), true);
    assert.throws(() => {
      cfg.threadIdleDays = 1;
    }, TypeError);
    assert.throws(() => {
      cfg.extra = true;
    }, TypeError);
    assert.equal(cfg.threadIdleDays, 21);
  });

  test('未知字段进入 warnings 且不阻断', () => {
    const cfg = normalizeConfig({ foo: 1, bar: 'x', threadMaxActive: 4 });
    assert.equal(cfg.threadMaxActive, 4);
    assert.equal(cfg.warnings.length, 2);
    assert.ok(cfg.warnings.some((w) => w.includes('foo')));
    assert.ok(cfg.warnings.some((w) => w.includes('bar')));
    assert.equal('foo' in cfg, false);
  });

  test('不修改传入的 raw 对象', () => {
    const raw = { threadIdleDays: 30, unknownKey: true };
    normalizeConfig(raw);
    assert.deepEqual(raw, { threadIdleDays: 30, unknownKey: true });
  });

  test('允许 proactiveDailyCap 为 0（关闭主动）', () => {
    assert.equal(normalizeConfig({ proactiveDailyCap: 0 }).proactiveDailyCap, 0);
  });

  test('允许 quietStart 与 quietEnd 相同（全天安静，不报错）', () => {
    const cfg = normalizeConfig({ quietStart: '12:00', quietEnd: '12:00' });
    assert.equal(cfg.quietStart, '12:00');
    assert.equal(cfg.quietEnd, '12:00');
  });

  test('RSS 三档允许小内存机器的 2.2/2.4/2.6 配置', () => {
    const cfg = normalizeConfig({ rssWarnGiB: 2.2, rssStopGiB: 2.4, rssMainOnlyGiB: 2.6 });
    assert.equal(cfg.rssWarnGiB, 2.2);
    assert.equal(cfg.rssStopGiB, 2.4);
    assert.equal(cfg.rssMainOnlyGiB, 2.6);
    assert.deepEqual(cfg.warnings, []);
  });
});

describe('normalizeConfig 非法输入', () => {
  // 每类非法输入都必须抛 ConfigError，且 field 指向出错字段。
  const invalidCases = [
    ['字符串 token', 'workingMemoryTokens', { workingMemoryTokens: '32000' }],
    ['浮点 token', 'compactAtTokens', { compactAtTokens: 24000.5 }],
    ['retainTokens 为 0', 'retainTokens', { retainTokens: 0 }],
    ['retainTokens 非负整数缺失', 'retainTokens', { retainTokens: NaN }],
    ['threadIdleDays 为 0', 'threadIdleDays', { threadIdleDays: 0 }],
    ['threadMaxActive 为负', 'threadMaxActive', { threadMaxActive: -1 }],
    ['proactiveDailyCap 为负', 'proactiveDailyCap', { proactiveDailyCap: -1 }],
    ['purgeAfterDays 为 0', 'purgeAfterDays', { purgeAfterDays: 0 }],
    ['purgeAfterDays 超过 30', 'purgeAfterDays', { purgeAfterDays: 31 }],
    ['quietStart 超范围', 'quietStart', { quietStart: '25:00' }],
    ['quietEnd 格式错误', 'quietEnd', { quietEnd: '8:00' }],
    ['quietStart 非字符串', 'quietStart', { quietStart: 2300 }],
    ['timezone 非 IANA 名', 'timezone', { timezone: 'Mars/Olympus' }],
    ['timezone 空串', 'timezone', { timezone: '   ' }],
    ['timezone 非字符串', 'timezone', { timezone: 8 }],
    ['idleMs 为 0', 'idleMs', { idleMs: 0 }],
    ['dbPath 为空串', 'dbPath', { dbPath: '   ' }],
    ['retainTokens 不小于 compactAtTokens', 'retainTokens', { retainTokens: 24000 }],
    ['compactAtTokens 不小于 workingMemoryTokens', 'compactAtTokens', { compactAtTokens: 32000 }],
    ['workingMemoryTokens 不小于 compactHardTokens', 'workingMemoryTokens', { workingMemoryTokens: 40000 }],
    ['raw 不是对象', 'config', 'not-an-object'],
    ['raw 是数组', 'config', []],
    ['rssWarnGiB 非数字', 'rssWarnGiB', { rssWarnGiB: '2.95' }],
    ['rssWarnGiB 为 null', 'rssWarnGiB', { rssWarnGiB: null }],
    ['rssWarnGiB 为 NaN', 'rssWarnGiB', { rssWarnGiB: NaN }],
    ['rssStopGiB 为 0', 'rssStopGiB', { rssStopGiB: 0 }],
    ['rssStopGiB 为布尔', 'rssStopGiB', { rssStopGiB: true }],
    ['rssMainOnlyGiB 为负', 'rssMainOnlyGiB', { rssMainOnlyGiB: -0.1 }],
    ['rssMainOnlyGiB 为 Infinity', 'rssMainOnlyGiB', { rssMainOnlyGiB: Infinity }],
    ['rssWarnGiB 不小于 rssStopGiB', 'rssWarnGiB', { rssWarnGiB: 3 }],
    ['rssStopGiB 不小于 rssMainOnlyGiB', 'rssStopGiB', { rssStopGiB: 3.15 }],
  ];

  for (const [label, field, raw] of invalidCases) {
    test(`${label} → ConfigError(field=${field})`, () => {
      expectConfigError(raw, field);
    });
  }

  test('至少覆盖 8 类非法输入', () => {
    assert.ok(invalidCases.length >= 8);
  });

  test('ConfigError 保留 field 与可读 message', () => {
    try {
      normalizeConfig({ purgeAfterDays: 99 });
      assert.fail('应当抛出 ConfigError');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.field, 'purgeAfterDays');
      assert.match(err.message, /purgeAfterDays/);
      assert.match(err.message, /must be within 1\.\.30/);
    }
  });
});

describe('parseClock', () => {
  test('合法时间转换为分钟数', () => {
    assert.equal(parseClock('00:00'), 0);
    assert.equal(parseClock('00:01'), 1);
    assert.equal(parseClock('08:30'), 510);
    assert.equal(parseClock('23:59'), 1439);
  });

  const badClocks = ['24:00', '23:60', '7:00', '12:5', 'noon', '', ' 08:00', null, undefined, 830];
  for (const value of badClocks) {
    test(`非法时间 ${JSON.stringify(value)} 抛 ConfigError`, () => {
      assert.throws(
        () => parseClock(value),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.field, 'clock');
          return true;
        },
      );
    });
  }
});

describe('isQuietAt（默认 23:00-08:00，跨午夜）', () => {
  test('跨午夜判定符合验收样例', () => {
    assert.equal(isQuietAt(at(23, 30), DEFAULTS), true);
    assert.equal(isQuietAt(at(7, 59), DEFAULTS), true);
    assert.equal(isQuietAt(at(8, 0), DEFAULTS), false);
    assert.equal(isQuietAt(at(22, 59), DEFAULTS), false);
  });

  test('边界分钟', () => {
    assert.equal(isQuietAt(at(23, 0), DEFAULTS), true); // 起点包含
    assert.equal(isQuietAt(at(0, 0), DEFAULTS), true); // 午夜内
    assert.equal(isQuietAt(at(7, 59), DEFAULTS), true);
    assert.equal(isQuietAt(at(8, 0), DEFAULTS), false); // 终点不含
    assert.equal(isQuietAt(at(12, 0), DEFAULTS), false);
  });

  test('不跨午夜的时段', () => {
    const cfg = normalizeConfig({ quietStart: '01:00', quietEnd: '05:00' });
    assert.equal(isQuietAt(at(0, 59), cfg), false);
    assert.equal(isQuietAt(at(1, 0), cfg), true);
    assert.equal(isQuietAt(at(3, 0), cfg), true);
    assert.equal(isQuietAt(at(4, 59), cfg), true);
    assert.equal(isQuietAt(at(5, 0), cfg), false);
    assert.equal(isQuietAt(at(23, 0), cfg), false);
  });

  test('quietStart == quietEnd 视为全天安静', () => {
    const cfg = normalizeConfig({ quietStart: '09:30', quietEnd: '09:30' });
    for (const minutes of [0, 1, 570, 571, 720, 1439]) {
      assert.equal(isQuietAt(at(Math.floor(minutes / 60), minutes % 60), cfg), true);
    }
  });

  test('用户覆盖的跨午夜时段', () => {
    const cfg = normalizeConfig({ quietStart: '22:00', quietEnd: '07:00' });
    assert.equal(isQuietAt(at(22, 0), cfg), true);
    assert.equal(isQuietAt(at(23, 59), cfg), true);
    assert.equal(isQuietAt(at(6, 59), cfg), true);
    assert.equal(isQuietAt(at(7, 0), cfg), false);
    assert.equal(isQuietAt(at(12, 0), cfg), false);
  });

  test('非法 Date 抛 ConfigError', () => {
    assert.throws(() => isQuietAt(new Date('nope'), DEFAULTS), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.field, 'date');
      return true;
    });
    assert.throws(() => isQuietAt('23:30', DEFAULTS), ConfigError);
  });
});

describe('timezone（M1：墙上时间不依赖进程 TZ）', () => {
  test('默认时区为 Asia/Shanghai，且可覆盖为其他 IANA 时区', () => {
    assert.equal(normalizeConfig().timezone, 'Asia/Shanghai');
    assert.equal(normalizeConfig({ timezone: 'America/New_York' }).timezone, 'America/New_York');
  });

  test('安静时段按 Asia/Shanghai 分区分钟判定边界 22:59 / 23:00 / 07:59 / 08:00', () => {
    // 先证明测试用的 epoch 确实是上海墙上时间，而不是进程本地时间。
    assert.equal(zonedMinutesOfDay(at(22, 59).getTime(), 'Asia/Shanghai'), 22 * 60 + 59);
    assert.equal(zonedMinutesOfDay(at(23, 0).getTime(), 'Asia/Shanghai'), 23 * 60);
    assert.equal(zonedMinutesOfDay(at(7, 59).getTime(), 'Asia/Shanghai'), 7 * 60 + 59);
    assert.equal(zonedMinutesOfDay(at(8, 0).getTime(), 'Asia/Shanghai'), 8 * 60);

    assert.equal(isQuietAt(at(22, 59), DEFAULTS), false);
    assert.equal(isQuietAt(at(23, 0), DEFAULTS), true);
    assert.equal(isQuietAt(at(7, 59), DEFAULTS), true);
    assert.equal(isQuietAt(at(8, 0), DEFAULTS), false);
  });

  test('覆盖 timezone 后安静时段按该分区判定（America/New_York）', () => {
    const cfg = normalizeConfig({ timezone: 'America/New_York' });
    // 2026-01-16 12:00 +08:00 = 2026-01-15 23:00 EST（EST = UTC-5）。
    const ny2300 = new Date(Date.parse('2026-01-16T12:00:00+08:00'));
    const ny2259 = new Date(Date.parse('2026-01-16T11:59:00+08:00'));
    const ny0800 = new Date(Date.parse('2026-01-16T21:00:00+08:00'));
    assert.equal(isQuietAt(ny2259, cfg), false);
    assert.equal(isQuietAt(ny2300, cfg), true);
    assert.equal(isQuietAt(ny0800, cfg), false);
  });

  test('isQuietAt 对非法 timezone 抛 ConfigError(timezone)', () => {
    const cfg = { quietStart: '23:00', quietEnd: '08:00', timezone: 'Not/AZone' };
    assert.throws(() => isQuietAt(at(23, 30), cfg), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.field, 'timezone');
      return true;
    });
  });
});

describe('apply（插件入口）', () => {
  test('导出 name 为 dsh-companion', () => {
    assert.equal(pluginName, 'dsh-companion');
  });

  test('合法配置不抛，且只记录一条 config ok 日志', () => {
    const calls = [];
    const ctx = { logger: { info: (...args) => calls.push(args) } };
    assert.doesNotThrow(() => apply(ctx, { threadIdleDays: 21, dbPath: ':memory:' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[dsh-companion] config ok');
    assert.deepEqual(calls[0][1], { warnings: [] });
  });

  test('未知字段通过日志 warnings 暴露', () => {
    const calls = [];
    const ctx = { logger: { info: (...args) => calls.push(args) } };
    apply(ctx, { nope: 1, dbPath: ':memory:' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].warnings.length, 1);
    assert.match(calls[0][1].warnings[0], /nope/);
  });

  test('无 logger / 空 ctx 时不抛错', () => {
    assert.doesNotThrow(() => apply({}, { dbPath: ':memory:' }));
    assert.doesNotThrow(() => apply(undefined, undefined));
    assert.doesNotThrow(() => apply({ logger: {} }, { dbPath: ':memory:' }));
  });

  test('非法配置 fail-fast 抛 ConfigError 且不写日志', () => {
    const calls = [];
    const ctx = { logger: { info: (...args) => calls.push(args) } };
    assert.throws(() => apply(ctx, { quietStart: '99:99' }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.field, 'quietStart');
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('只经平台服务注册，不调用旧式 registerCommand/registerTool 钩子', () => {
    const touched = [];
    const ctx = {
      logger: { info: (...args) => touched.push(['logger.info', ...args]) },
      registerCommand: (...args) => touched.push(['registerCommand', ...args]),
      registerTool: (...args) => touched.push(['registerTool', ...args]),
      on: (...args) => touched.push(['on', ...args]),
      emit: (...args) => touched.push(['emit', ...args]),
    };
    apply(ctx, { dbPath: ':memory:' });
    assert.equal(touched[0][0], 'logger.info');
    assert.ok(touched.some(([kind, event]) => kind === 'on' && event === 'agent/pre-step'));
    assert.equal(touched.filter(([kind]) => kind === 'registerCommand').length, 0);
    assert.equal(touched.filter(([kind]) => kind === 'registerTool').length, 0);
  });
});
