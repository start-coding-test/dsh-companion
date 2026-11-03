import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, DEFAULTS, isQuietAt, normalizeConfig, parseClock } from '../src/config.js';
import { apply, name as pluginName } from '../src/index.js';

/** 构造本地时间（避免 UTC 偏移影响 isQuietAt 的分钟比较）。 */
function at(hours, minutes, day = 15) {
  return new Date(2026, 0, day, hours, minutes, 0, 0);
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
    assert.equal(DEFAULTS.purgeAfterDays, 7);
    assert.equal(DEFAULTS.dbPath, './.data/companion.db');
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
    ['dbPath 为空串', 'dbPath', { dbPath: '   ' }],
    ['retainTokens 不小于 compactAtTokens', 'retainTokens', { retainTokens: 24000 }],
    ['compactAtTokens 不小于 workingMemoryTokens', 'compactAtTokens', { compactAtTokens: 32000 }],
    ['workingMemoryTokens 不小于 compactHardTokens', 'workingMemoryTokens', { workingMemoryTokens: 40000 }],
    ['raw 不是对象', 'config', 'not-an-object'],
    ['raw 是数组', 'config', []],
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

describe('apply（插件入口）', () => {
  test('导出 name 为 dsh-companion', () => {
    assert.equal(pluginName, 'dsh-companion');
  });

  test('合法配置不抛，且只记录一条 config ok 日志', () => {
    const calls = [];
    const ctx = { logger: { info: (...args) => calls.push(args) } };
    assert.doesNotThrow(() => apply(ctx, { threadIdleDays: 21 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '[dsh-companion] config ok');
    assert.deepEqual(calls[0][1], { warnings: [] });
  });

  test('未知字段通过日志 warnings 暴露', () => {
    const calls = [];
    const ctx = { logger: { info: (...args) => calls.push(args) } };
    apply(ctx, { nope: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].warnings.length, 1);
    assert.match(calls[0][1].warnings[0], /nope/);
  });

  test('无 logger / 空 ctx 时不抛错', () => {
    assert.doesNotThrow(() => apply({}, {}));
    assert.doesNotThrow(() => apply(undefined, undefined));
    assert.doesNotThrow(() => apply({ logger: {} }, {}));
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
