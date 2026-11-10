/**
 * P3-a 情绪内核单测：衰减 / 节律 / 事件 / 分类 / 描述 / 存储形状。
 *
 * 全部纯函数：不使用真实时钟，nowMs 与 updatedAt 都是写死的毫秒数，
 * 因此本文件在任意时区（TZ）下结果一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BASELINE,
  DESCRIBE_SENTENCES,
  EVENT_TYPES,
  applyEvent,
  circadian,
  classify,
  createState,
  decay,
  deserialize,
  describe,
  normalizeState,
  serialize,
} from '../src/persona/emotion.js';

/** 一小时 / 一分钟的毫秒数。 */
const HOUR_MS = 3600000;

/** 写死的时间锚点（2023-11-14T22:13:20Z），不使用真实时钟。 */
const T0 = 1_700_000_000_000;

const DIMS = ['pleasure', 'arousal', 'dominance', 'energy'];
const PAD_DIMS = ['pleasure', 'arousal', 'dominance'];

const BASELINE = { pleasure: 50, arousal: 40, dominance: 45, energy: 60 };
const MID = { pleasure: 50, arousal: 50, dominance: 50, energy: 50, updatedAt: T0 };

/** 16:00 四维节律偏移全为零，用来把「事件固有增量」与「节律偏移」分开。 */
const NEUTRAL_CLOCK = { hour: 16, minute: 0 };

/**
 * 与实现一致的四舍五入（保留两位小数，并把 -0 归一为 0）。
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 取某事件的 deltas（默认在中性时刻，intensity 可调）。
 * @param {string} type
 * @param {number} [intensity]
 * @returns {object}
 */
function deltasOf(type, intensity = 1) {
  const { event } = applyEvent(MID, {
    type,
    intensity,
    nowMs: T0,
    ...NEUTRAL_CLOCK,
  });
  return event.deltas;
}

test('normalizeState：四维夹到 0–100，非数值回落 baseline，且不修改入参', () => {
  const input = {
    pleasure: 130,
    arousal: -20,
    dominance: Number.NaN,
    energy: 'x',
    updatedAt: T0,
  };
  const output = normalizeState(input, BASELINE);
  assert.deepEqual(output, {
    pleasure: 100,
    arousal: 0,
    dominance: BASELINE.dominance,
    energy: BASELINE.energy,
    updatedAt: T0,
  });
  assert.deepEqual(Object.keys(output), ['pleasure', 'arousal', 'dominance', 'energy', 'updatedAt']);
  assert.notEqual(output, input);
  assert.equal(input.pleasure, 130, '入参不被修改');
});

test('normalizeState：updatedAt 非有限数 / state 非对象 / baseline 非法时抛 TypeError', () => {
  assert.throws(() => normalizeState({ ...MID, updatedAt: Number.NaN }, BASELINE), TypeError);
  assert.throws(() => normalizeState({ ...MID, updatedAt: Number.POSITIVE_INFINITY }, BASELINE), TypeError);
  assert.throws(() => normalizeState({
    pleasure: 1, arousal: 1, dominance: 1, energy: 1,
  }, BASELINE), TypeError);
  assert.throws(() => normalizeState(null, BASELINE), TypeError);
  assert.throws(() => normalizeState(MID, 42), TypeError);
});

test('createState：以 baseline 为初值、updatedAt = nowMs；缺省基线用 DEFAULT_BASELINE', () => {
  assert.deepEqual(createState({ baseline: BASELINE, nowMs: T0 }), { ...BASELINE, updatedAt: T0 });
  assert.deepEqual(createState({ nowMs: T0 }), { ...DEFAULT_BASELINE, updatedAt: T0 });
  assert.throws(() => createState({ baseline: BASELINE, nowMs: Number.NaN }), TypeError);
  assert.throws(() => createState({ baseline: BASELINE }), TypeError);
  assert.throws(() => createState(), TypeError);
});

test('decay：6h 半衰期后四维到基线的距离各减半（1e-9 容差）', () => {
  const start = {
    pleasure: 90,
    arousal: 85,
    dominance: 10,
    energy: 15,
    updatedAt: T0,
  };
  const output = decay(start, { baseline: BASELINE, nowMs: T0 + 6 * HOUR_MS, halfLifeHours: 6 });
  for (const dim of DIMS) {
    const expected = BASELINE[dim] + (start[dim] - BASELINE[dim]) * 0.5;
    assert.ok(Math.abs(output[dim] - expected) < 1e-9, `${dim}: ${output[dim]} vs ${expected}`);
  }
  assert.equal(output.updatedAt, T0 + 6 * HOUR_MS);
});

test('decay：多次半衰期按指数收敛，且始终留在 0–100', () => {
  const start = {
    pleasure: 90,
    arousal: 85,
    dominance: 10,
    energy: 15,
    updatedAt: T0,
  };
  const afterFour = decay(start, { baseline: BASELINE, nowMs: T0 + 24 * HOUR_MS, halfLifeHours: 6 });
  for (const dim of DIMS) {
    const expected = BASELINE[dim] + (start[dim] - BASELINE[dim]) * 0.5 ** 4;
    assert.ok(Math.abs(afterFour[dim] - expected) < 1e-9, `${dim}: ${afterFour[dim]} vs ${expected}`);
    assert.ok(afterFour[dim] >= 0 && afterFour[dim] <= 100);
  }
  const muchLater = decay(afterFour, { baseline: BASELINE, nowMs: T0 + 168 * HOUR_MS, halfLifeHours: 6 });
  for (const dim of DIMS) {
    assert.ok(Math.abs(muchLater[dim] - BASELINE[dim]) < 1e-3, `${dim} 应贴近基线`);
    assert.ok(
      Math.abs(muchLater[dim] - BASELINE[dim]) < Math.abs(afterFour[dim] - BASELINE[dim]),
      `${dim} 应继续靠近基线`,
    );
  }
});

test('decay：dt=0 逐值恒等（deepEqual），负 dt 视为 0', () => {
  const start = {
    pleasure: 90,
    arousal: 85,
    dominance: 10,
    energy: 15,
    updatedAt: T0,
  };
  assert.deepEqual(
    decay(start, { baseline: BASELINE, nowMs: T0, halfLifeHours: 6 }),
    start,
  );
  assert.deepEqual(
    decay(start, { baseline: BASELINE, nowMs: T0 - 3 * HOUR_MS, halfLifeHours: 6 }),
    { ...start, updatedAt: T0 - 3 * HOUR_MS },
  );
});

test('decay：halfLifeHours 非法（≤0 / >168 / 非数）抛 TypeError，边界值合法', () => {
  const start = {
    pleasure: 90,
    arousal: 85,
    dominance: 10,
    energy: 15,
    updatedAt: T0,
  };
  for (const bad of [0, -6, 169, Number.NaN, '6', undefined, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => decay(start, { baseline: BASELINE, nowMs: T0 + HOUR_MS, halfLifeHours: bad }),
      TypeError,
      `halfLifeHours=${String(bad)}`,
    );
  }
  assert.equal(
    decay(start, { baseline: BASELINE, nowMs: T0 + HOUR_MS, halfLifeHours: 168 }).updatedAt,
    T0 + HOUR_MS,
  );
  assert.ok(Number.isFinite(
    decay(start, { baseline: BASELINE, nowMs: T0 + HOUR_MS, halfLifeHours: 0.5 }).pleasure,
  ));
  assert.throws(() => decay(start, { baseline: BASELINE, halfLifeHours: 6 }), TypeError);
});

test('decay：返回新对象、更新 updatedAt、不修改入参', () => {
  const start = {
    pleasure: 90,
    arousal: 85,
    dominance: 10,
    energy: 15,
    updatedAt: T0,
  };
  const snapshot = { ...start };
  const output = decay(start, { baseline: BASELINE, nowMs: T0 + 3 * HOUR_MS, halfLifeHours: 6 });
  assert.notEqual(output, start);
  assert.deepEqual(start, snapshot);
  for (const dim of DIMS) {
    assert.notEqual(output[dim], start[dim], `${dim} 应发生衰减`);
    assert.ok(output[dim] >= 0 && output[dim] <= 100);
  }
  assert.equal(output.updatedAt, T0 + 3 * HOUR_MS);
});

test('circadian：整点与半点按相邻整点线性插值（含 23.5 这类小数小时）', () => {
  assert.equal(circadian({ hour: 6, minute: 0 }, MID).energy, -7);
  assert.equal(circadian({ hour: 8, minute: 0 }, MID).energy, -2);
  assert.equal(circadian({ hour: 7, minute: 0 }, MID).energy, -4.5);
  assert.ok(Math.abs(circadian({ hour: 6, minute: 30 }, MID).energy - (-5.75)) < 1e-9);
  assert.ok(Math.abs(circadian({ hour: 23, minute: 45 }, MID).energy - (-7.75)) < 1e-9);
  assert.deepEqual(circadian({ hour: 23, minute: 30 }, MID), circadian({ hour: 23.5 }, MID));
  assert.equal(circadian({ hour: 10, minute: 0 }, MID).pleasure, 2.5);
  assert.equal(circadian({ hour: 14, minute: 0 }, MID).arousal, -2.5);
  assert.equal(circadian({ hour: 9, minute: 0 }, MID).dominance, 1);
  assert.deepEqual(circadian(NEUTRAL_CLOCK, MID), {
    pleasure: 0, arousal: 0, dominance: 0, energy: 0,
  });
});

test('circadian：同参数两次调用相等，任意分钟输出都在 PAD ±5 / energy ±12 内', () => {
  assert.deepEqual(circadian({ hour: 9, minute: 17 }, MID), circadian({ hour: 9, minute: 17 }, MID));
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 7) {
      const offset = circadian({ hour, minute }, MID);
      assert.deepEqual(Object.keys(offset), ['pleasure', 'arousal', 'dominance', 'energy']);
      for (const dim of PAD_DIMS) {
        assert.ok(Math.abs(offset[dim]) <= 5, `${dim}@${hour}:${minute}=${offset[dim]}`);
      }
      assert.ok(Math.abs(offset.energy) <= 12, `energy@${hour}:${minute}=${offset.energy}`);
    }
  }
});

test('circadian：hour 越界或非数、minute 越界都抛 TypeError', () => {
  for (const bad of [25, -1, 24, Number.NaN, '8', undefined]) {
    assert.throws(() => circadian({ hour: bad }, MID), TypeError, `hour=${String(bad)}`);
  }
  assert.throws(() => circadian({ hour: 9, minute: 60 }, MID), TypeError);
  assert.throws(() => circadian({ hour: 9, minute: -1 }, MID), TypeError);
  assert.throws(() => circadian({ hour: 9, minute: Number.NaN }, MID), TypeError);
});

test('circadian：深夜精力明显低、清晨回升、上午愉悦偏高、午后唤醒偏低、傍晚愉悦偏高', () => {
  assert.ok(circadian({ hour: 23 }, MID).energy <= -6);
  for (let hour = 0; hour <= 5; hour += 1) {
    assert.ok(circadian({ hour }, MID).energy <= -8, `${hour} 点应明显低`);
  }
  assert.ok(circadian({ hour: 8 }, MID).energy > circadian({ hour: 6 }, MID).energy, '清晨回升');
  assert.ok(circadian({ hour: 6 }, MID).energy > circadian({ hour: 5 }, MID).energy, '六点开始回升');
  assert.ok(circadian({ hour: 10 }, MID).pleasure > 0, '上午愉悦偏高');
  assert.ok(circadian({ hour: 14 }, MID).arousal < 0, '午后唤醒偏低');
  assert.ok(circadian({ hour: 19 }, MID).pleasure > circadian({ hour: 16 }, MID).pleasure, '傍晚愉悦偏高');
});

test('applyEvent：十种类型的语义方向正确（在节律零点隔离节律偏移）', () => {
  assert.ok(deltasOf('greeting').pleasure > 0);
  assert.ok(deltasOf('care').pleasure > 0 && deltasOf('care').arousal > 0 && deltasOf('care').energy > 0);
  assert.ok(deltasOf('share').pleasure > 0 && deltasOf('share').arousal > 0);
  assert.ok(deltasOf('thanks').pleasure > 0);
  assert.ok(deltasOf('complain').pleasure < 0 && deltasOf('complain').arousal > 0);
  assert.ok(deltasOf('cold').pleasure < 0 && deltasOf('cold').dominance < 0);
  assert.ok(deltasOf('reunion').pleasure > 0 && deltasOf('reunion').arousal > 0);
  assert.ok(deltasOf('goodnight').arousal < 0 && deltasOf('goodnight').energy > 0);
  assert.ok(deltasOf('conflict').pleasure < 0 && deltasOf('conflict').dominance < 0);
  assert.ok(deltasOf('conflict').arousal > 0);
  assert.ok(deltasOf('comfort').pleasure > 0);
  assert.deepEqual(deltasOf('greeting'), {
    pleasure: 4, arousal: 1, dominance: 0.5, energy: 0.5,
  });
  assert.deepEqual(EVENT_TYPES.length, 10);
});

test('applyEvent：intensity 夹到 0–3，0 与负值不产生事件增量', () => {
  assert.deepEqual(deltasOf('conflict', 10), deltasOf('conflict', 3));
  assert.deepEqual(deltasOf('reunion', Number.POSITIVE_INFINITY), deltasOf('reunion', 3));
  assert.deepEqual(deltasOf('conflict', 0), {
    pleasure: 0, arousal: 0, dominance: 0, energy: 0,
  });
  assert.deepEqual(deltasOf('conflict', -5), deltasOf('conflict', 0));
  assert.deepEqual(deltasOf('reunion', 0.5), {
    pleasure: 3, arousal: 2, dominance: 0.5, energy: 0.5,
  });
});

test('applyEvent：单维固有增量上限 PAD ≤8、energy ≤6（intensity 放大后仍受限）', () => {
  for (const type of EVENT_TYPES) {
    const deltas = deltasOf(type, 10);
    for (const dim of PAD_DIMS) {
      assert.ok(Math.abs(deltas[dim]) <= 8, `${type}.${dim}=${deltas[dim]}`);
    }
    assert.ok(Math.abs(deltas.energy) <= 6, `${type}.energy=${deltas.energy}`);
  }
  assert.equal(deltasOf('conflict', 10).pleasure, -8);
  assert.equal(deltasOf('conflict', 10).dominance, -8);
  assert.equal(deltasOf('reunion', 10).pleasure, 8);
  assert.equal(deltasOf('reunion', 1).pleasure, 6);
});

test('applyEvent：结果始终 0–100，deltas 与实际差值一致且保留两位小数', () => {
  for (const startValue of [0, 100]) {
    for (const type of EVENT_TYPES) {
      for (let hour = 0; hour < 24; hour += 1) {
        const state = {
          pleasure: startValue,
          arousal: startValue,
          dominance: startValue,
          energy: startValue,
          updatedAt: T0,
        };
        const result = applyEvent(state, {
          type,
          intensity: 3,
          nowMs: T0 + hour * HOUR_MS,
          hour,
          minute: 0,
        });
        assert.equal(result.event.type, type);
        assert.equal(result.event.at, T0 + hour * HOUR_MS);
        for (const dim of DIMS) {
          const value = result.state[dim];
          assert.ok(value >= 0 && value <= 100, `${type}@${hour}.${dim}=${value}`);
          assert.equal(result.event.deltas[dim], round2(value - state[dim]), `${type}@${hour}.${dim} deltas`);
          const scaled = result.event.deltas[dim] * 100;
          assert.ok(Math.abs(scaled - Math.round(scaled)) < 1e-9, `${type}.${dim} 应为两位小数`);
        }
      }
    }
  }
});

test('applyEvent：deltas 含节律部分（深夜 reunion 的精力增量仍为负）', () => {
  const result = applyEvent(MID, { type: 'reunion', intensity: 2, nowMs: T0, hour: 3, minute: 0 });
  const rhythm = circadian({ hour: 3, minute: 0 }, MID);
  assert.equal(rhythm.energy, -10);
  assert.ok(result.event.deltas.energy < 0, '固有 +2 被深夜 -10 的节律盖过');
  assert.equal(result.event.deltas.energy, -8);
  assert.equal(result.event.deltas.pleasure, 6.5);
  assert.equal(result.event.deltas.energy, rhythm.energy + 2);
});

test('applyEvent：未知类型、非法 nowMs/intensity 抛 TypeError，且不修改入参', () => {
  assert.throws(() => applyEvent(MID, { type: 'happy', nowMs: T0 }), TypeError);
  assert.throws(() => applyEvent(MID, { type: 'Greeting', nowMs: T0 }), TypeError);
  assert.throws(() => applyEvent(MID, { nowMs: T0 }), TypeError);
  assert.throws(() => applyEvent(MID, { type: 'greeting', nowMs: Number.NaN }), TypeError);
  assert.throws(() => applyEvent(MID, { type: 'greeting', intensity: '2', nowMs: T0 }), TypeError);
  assert.throws(() => applyEvent(MID, { type: 'greeting', intensity: Number.NaN, nowMs: T0 }), TypeError);
  assert.throws(() => applyEvent(MID, { type: 'greeting', nowMs: T0, hour: 25 }), TypeError);
  const snapshot = { ...MID };
  applyEvent(MID, { type: 'conflict', intensity: 2, nowMs: T0 + HOUR_MS });
  assert.deepEqual(MID, snapshot);
});

test('classify：十组关键词各自命中正确类型，置信度落在 0–1', () => {
  const cases = [
    ['早上好呀', 'greeting'],
    ['嗨，在吗', 'greeting'],
    ['谢谢你啦', 'thanks'],
    ['感谢你一直陪我', 'thanks'],
    ['今天你都做了什么', 'share'],
    ['我跟你说个事', 'share'],
    ['你怎么了，还好吗', 'care'],
    ['别太累，注意身体', 'care'],
    ['最近压力好大', 'complain'],
    ['烦死了，累死了', 'complain'],
    ['随便吧', 'cold'],
    ['算了，不想说了', 'cold'],
    ['好久不见', 'reunion'],
    ['这段时间你去哪了', 'reunion'],
    ['晚安啦', 'goodnight'],
    ['我先睡了，明天见', 'goodnight'],
    ['你错了，别管我', 'conflict'],
    ['烦不烦啊', 'conflict'],
    ['抱抱你，别难过', 'comfort'],
    ['别担心，我在', 'comfort'],
  ];
  for (const [text, expected] of cases) {
    const result = classify(text);
    assert.equal(result.type, expected, text);
    assert.ok(result.confidence > 0 && result.confidence <= 1, `${text} -> ${result.confidence}`);
  }
});

test('classify：无关键词回落 share/0，空串与纯空白同样回落', () => {
  assert.deepEqual(classify('天气不错'), { type: 'share', confidence: 0 });
  assert.deepEqual(classify('今天天气很好'), { type: 'share', confidence: 0 });
  assert.deepEqual(classify(''), { type: 'share', confidence: 0 });
  assert.deepEqual(classify('   '), { type: 'share', confidence: 0 });
});

test('classify：非字符串抛 TypeError，且同输入两次结果相等', () => {
  assert.throws(() => classify(undefined), TypeError);
  assert.throws(() => classify(null), TypeError);
  assert.throws(() => classify(42), TypeError);
  assert.deepEqual(classify('谢谢你'), classify('谢谢你'));
});

test('describe：四维分档穷举下均无阿拉伯数字、≤40 码点、非空', () => {
  const seen = new Set();
  for (const pleasure of [100, 90, 65, 64, 60, 45, 44, 40, 35, 34, 20, 0]) {
    for (const energy of [100, 65, 64, 50, 45, 44, 20, 0]) {
      for (const arousal of [0, 35, 70, 100]) {
        for (const dominance of [0, 40, 80, 100]) {
          const text = describe({
            pleasure, arousal, dominance, energy,
          });
          assert.equal(/^\d/.test(text), false, text);
          assert.equal(/\d/.test(text), false, text);
          assert.ok(text.length > 0, '不能为空');
          assert.ok([...text].length <= 40, `${text} -> ${[...text].length}`);
          assert.equal(/愉悦|唤醒|掌控|精力值|百分比|%/.test(text), false, text);
          seen.add(text);
        }
      }
    }
  }
  assert.equal(seen.size, 12);
});

test('describe：恰好 12 种表述，分档边界处切换、同档内稳定', () => {
  assert.equal(DESCRIBE_SENTENCES.length, 12);
  assert.equal(new Set(DESCRIBE_SENTENCES).size, 12, '12 种表述互不相同');
  for (const sentence of DESCRIBE_SENTENCES) {
    assert.equal(/^\d/.test(sentence), false, sentence);
    assert.equal(/\d/.test(sentence), false, sentence);
    assert.ok([...sentence].length <= 40, sentence);
    assert.ok(sentence.startsWith('现在'), sentence);
  }
  const at = (pleasure, energy) => describe({
    pleasure, arousal: 50, dominance: 50, energy,
  });
  assert.equal(at(65, 60), at(90, 64), '同档内稳定');
  assert.notEqual(at(64, 60), at(65, 60), '愉悦档边界 65');
  assert.notEqual(at(44, 60), at(45, 60), '愉悦档边界 45');
  assert.notEqual(at(34, 60), at(35, 60), '愉悦档边界 35');
  assert.equal(at(44, 60), at(35, 60), '35–44 同档');
  assert.equal(at(70, 45), at(70, 64), '精力 45–64 同档');
  assert.notEqual(at(70, 44), at(70, 45), '精力档边界 45');
  assert.notEqual(at(70, 64), at(70, 65), '精力档边界 65');
});

test('describe：同输入两次结果相等，缺 updatedAt 也能渲染', () => {
  const state = {
    pleasure: 61, arousal: 42, dominance: 70, energy: 33, updatedAt: T0,
  };
  assert.equal(describe(state), describe(state));
  const withoutTimestamp = {
    pleasure: 61, arousal: 42, dominance: 70, energy: 33,
  };
  assert.equal(describe(withoutTimestamp), describe(state));
  assert.throws(() => describe(null), TypeError);
});

test('serialize/deserialize：对象与 JSON 字符串往返一致，只输出五个字段', () => {
  const state = {
    pleasure: 12.5, arousal: 88, dominance: 40, energy: 99.9, updatedAt: T0,
  };
  assert.deepEqual(serialize(state), state);
  assert.notEqual(serialize(state), state);
  assert.deepEqual(deserialize(serialize(state)), state);
  assert.deepEqual(deserialize(JSON.stringify(state)), state);
  const withExtra = {
    ...state, note: 'x', baseline: 3,
  };
  assert.deepEqual(serialize(withExtra), state);
  assert.deepEqual(
    Object.keys(serialize(withExtra)),
    ['pleasure', 'arousal', 'dominance', 'energy', 'updatedAt'],
  );
});

test('serialize/deserialize：字段缺失、非数值、越界、坏 JSON、null 一律 TypeError', () => {
  const invalid = [
    { arousal: 40, dominance: 40, energy: 40, updatedAt: T0 },
    {
      pleasure: Number.NaN, arousal: 40, dominance: 40, energy: 40, updatedAt: T0,
    },
    {
      pleasure: 40, arousal: 40, dominance: 40, energy: 101, updatedAt: T0,
    },
    {
      pleasure: 40, arousal: 40, dominance: 40, energy: -1, updatedAt: T0,
    },
    {
      pleasure: 40, arousal: 40, dominance: 40, energy: 40, updatedAt: Number.NaN,
    },
    {
      pleasure: '40', arousal: 40, dominance: 40, energy: 40, updatedAt: T0,
    },
  ];
  for (const raw of invalid) {
    assert.throws(() => serialize(raw), TypeError);
    assert.throws(() => deserialize(raw), TypeError);
  }
  assert.throws(() => deserialize('not json'), TypeError);
  assert.throws(() => deserialize(null), TypeError);
  assert.throws(() => deserialize([1, 2, 3]), TypeError);
  assert.throws(() => deserialize(JSON.stringify({ pleasure: 1 })), TypeError);
});

test('确定性：全部导出函数同输入连跑两次 deepEqual', () => {
  const build = () => ({
    normalized: normalizeState({
      pleasure: 70, arousal: 20, dominance: 50, energy: 110, updatedAt: T0,
    }, BASELINE),
    created: createState({ baseline: BASELINE, nowMs: T0 }),
    decayed: decay(MID, { baseline: BASELINE, nowMs: T0 + 5 * HOUR_MS, halfLifeHours: 5 }),
    rhythm: circadian({ hour: 21, minute: 45 }, MID),
    applied: applyEvent(MID, { type: 'care', intensity: 1.5, nowMs: T0 + 7 * HOUR_MS, hour: 21, minute: 45 }),
    classified: classify('好久不见，最近还好吗'),
    described: describe({
      pleasure: 30, arousal: 80, dominance: 20, energy: 40, updatedAt: T0,
    }),
    serialized: serialize(MID),
    roundTripped: deserialize(JSON.stringify(MID)),
  });
  assert.deepEqual(build(), build());
});
