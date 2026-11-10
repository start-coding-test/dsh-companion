import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CARD, loadCard, validateCard } from '../src/persona/card.js';
import { boardSection, buildSections } from '../src/persona/sections.js';

/** 用临时目录隔离人格卡文件。 */
function withTempDir(fn) {
  return (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-persona-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return fn(dir);
  };
}

function writeCard(dir, value, name = 'card.json') {
  const path = join(dir, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function charLength(text) {
  return [...text].length;
}

describe('DEFAULT_CARD', () => {
  test('默认值与用户拍板一致', () => {
    assert.equal(DEFAULT_CARD.name, '珞然');
    assert.equal(DEFAULT_CARD.address, '你');
    assert.deepEqual(DEFAULT_CARD.tone, {
      style: '简洁',
      warmth: '温和',
      structure: '先结论',
      notes: '不堆铺垫，不夸张感叹，不用亲密称呼',
      voice: '',
    });
    assert.deepEqual(DEFAULT_CARD.relation, { butler: 0.7, friend: 0.3 });
    assert.deepEqual(DEFAULT_CARD.proactive, {
      dailyCap: 3,
      chatPerDay: 1,
      quietStart: '23:00',
      quietEnd: '08:00',
    });
    assert.equal(DEFAULT_CARD.version, 1);
  });

  test('禁用话术至少 5 条，价值观 4 条，禁区至少 4 条', () => {
    assert.ok(DEFAULT_CARD.bannedPhrases.length >= 5);
    assert.equal(DEFAULT_CARD.values.length, 4);
    assert.ok(DEFAULT_CARD.taboos.length >= 4);
    assert.ok(DEFAULT_CARD.bannedPhrases.every((phrase) => typeof phrase === 'string' && phrase.length > 0));
    assert.ok(DEFAULT_CARD.values.every((value) => typeof value === 'string' && value.length > 0));
    assert.ok(DEFAULT_CARD.taboos.every((taboo) => typeof taboo === 'string' && taboo.length > 0));
  });

  test('默认卡深度冻结，运行期无法改人格', () => {
    assert.ok(Object.isFrozen(DEFAULT_CARD));
    assert.ok(Object.isFrozen(DEFAULT_CARD.tone));
    assert.ok(Object.isFrozen(DEFAULT_CARD.bannedPhrases));
    assert.throws(() => { DEFAULT_CARD.name = '别人'; }, TypeError);
    assert.throws(() => { DEFAULT_CARD.tone.style = '浮夸'; }, TypeError);
    assert.throws(() => { DEFAULT_CARD.values.push('新价值观'); }, TypeError);
  });

  test('validateCard 接受默认卡，拒绝缺字段/空字段', () => {
    assert.equal(validateCard(DEFAULT_CARD), DEFAULT_CARD);
    assert.throws(() => validateCard({ ...DEFAULT_CARD, name: '' }), /name/u);
    assert.throws(() => validateCard({ ...DEFAULT_CARD, address: '   ' }), /address/u);
    assert.throws(() => validateCard({ ...DEFAULT_CARD, tone: null }), /tone/u);
    assert.throws(() => validateCard({ ...DEFAULT_CARD, version: 0 }), /version/u);
    assert.throws(() => validateCard({ ...DEFAULT_CARD, values: '不是数组' }), /values/u);
  });
});

describe('loadCard', () => {
  test('不传路径返回默认卡（冻结副本）', () => {
    const card = loadCard();
    assert.notEqual(card, DEFAULT_CARD);
    assert.deepEqual(card, DEFAULT_CARD);
    assert.ok(Object.isFrozen(card));
    assert.ok(Object.isFrozen(card.tone));
  });

  test('路径不存在时回落到默认卡', withTempDir((dir) => {
    const card = loadCard(join(dir, 'missing.json'));
    assert.deepEqual(card, DEFAULT_CARD);
    assert.ok(Object.isFrozen(card));
  }));

  test('存在时读 JSON 并与默认值深合并', withTempDir((dir) => {
    const path = writeCard(dir, {
      name: '阿岩',
      address: '您',
      tone: { style: '直接' },
      values: ['守时：说好的时间一定到'],
      version: 7,
    });
    const card = loadCard(path);
    assert.equal(card.name, '阿岩');
    assert.equal(card.address, '您');
    assert.deepEqual(card.tone, {
      style: '直接',
      warmth: '温和',
      structure: '先结论',
      notes: '不堆铺垫，不夸张感叹，不用亲密称呼',
      voice: '',
    });
    assert.deepEqual(card.values, ['守时：说好的时间一定到']);
    assert.equal(card.version, 7);
    // 未覆盖字段保留默认值
    assert.deepEqual(card.proactive, DEFAULT_CARD.proactive);
    assert.deepEqual(card.bannedPhrases, DEFAULT_CARD.bannedPhrases);
    assert.ok(Object.isFrozen(card));
    assert.ok(Object.isFrozen(card.values));
  }));

  test('数组整体替换而不是拼接', withTempDir((dir) => {
    const path = writeCard(dir, {
      name: '珞然',
      address: '你',
      tone: { style: '简洁', warmth: '温和', structure: '先结论' },
      bannedPhrases: ['收到！'],
      taboos: ['未经验证的判断'],
    });
    const card = loadCard(path);
    assert.deepEqual(card.bannedPhrases, ['收到！']);
    assert.deepEqual(card.taboos, ['未经验证的判断']);
  }));

  test('非法 JSON 抛 TypeError', withTempDir((dir) => {
    const path = writeCard(dir, '{oops');
    assert.throws(() => loadCard(path), (err) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /invalid JSON/u);
      return true;
    });
  }));

  test('必填字段缺失或为空时拒绝', withTempDir((dir) => {
    const missingName = writeCard(dir, {
      address: '你',
      tone: { style: '简洁' },
    }, 'no-name.json');
    assert.throws(() => loadCard(missingName), /name/u);

    const missingAddress = writeCard(dir, {
      name: '珞然',
      tone: { style: '简洁' },
    }, 'no-address.json');
    assert.throws(() => loadCard(missingAddress), /address/u);

    const missingTone = writeCard(dir, {
      name: '珞然',
      address: '你',
    }, 'no-tone.json');
    assert.throws(() => loadCard(missingTone), /tone/u);

    const badTone = writeCard(dir, {
      name: '珞然',
      address: '你',
      tone: '简洁',
    }, 'bad-tone.json');
    assert.throws(() => loadCard(badTone), /tone/u);
  }));
});

describe('buildSections', () => {
  test('固定返回 safety/core/protocol，order 为 80/90/150', () => {
    const sections = buildSections(DEFAULT_CARD);
    assert.equal(sections.length, 3);
    assert.deepEqual(sections.map((section) => section.name), [
      'persona:safety',
      'persona:core',
      'persona:protocol',
    ]);
    assert.deepEqual(sections.map((section) => section.order), [80, 90, 150]);
    assert.ok(sections.every((section) => typeof section.text === 'string' && section.text !== ''));
  });

  test('各段长度不超过设计上限（250/600/400 字）', () => {
    const [safety, core, protocol] = buildSections(DEFAULT_CARD);
    assert.ok(charLength(safety.text) <= 250, `safety=${charLength(safety.text)}`);
    assert.ok(charLength(core.text) <= 600, `core=${charLength(core.text)}`);
    assert.ok(charLength(protocol.text) <= 400, `protocol=${charLength(protocol.text)}`);
  });

  test('纯函数：同一张卡两次渲染完全一致，且不含当轮变量', () => {
    const first = buildSections(DEFAULT_CARD);
    const second = buildSections(DEFAULT_CARD);
    assert.deepEqual(first, second);

    const all = first.map((section) => section.text).join('\n');
    assert.doesNotMatch(all, /\d{4}[-/年]\d{1,2}/u, '不得包含日期');
    assert.ok(!all.includes('今天'));
    assert.ok(!all.includes('明天'));
    assert.ok(!all.includes('召回'));
    assert.ok(!all.includes('现在'));
    assert.ok(!all.includes('本轮对话'));
  });

  test('人格文本不含任何 bannedPhrases', () => {
    const all = buildSections(DEFAULT_CARD).map((section) => section.text).join('\n');
    for (const phrase of DEFAULT_CARD.bannedPhrases) {
      assert.ok(!all.includes(phrase), `人格段不应出现禁用话术：${phrase}`);
    }
  });

  test('自定义卡驱动 core 段（名字/称呼/语气/价值观/禁区）', () => {
    const card = {
      name: '阿岩',
      address: '您',
      tone: { style: '直接', warmth: '冷静', structure: '列点' },
      values: ['守时：说好的时间一定到'],
      taboos: ['未经验证的判断'],
      version: 2,
    };
    const [, core] = buildSections(card);
    assert.ok(core.text.includes('阿岩'));
    assert.ok(core.text.includes('您'));
    assert.ok(core.text.includes('直接'));
    assert.ok(core.text.includes('冷静'));
    assert.ok(core.text.includes('列点'));
    assert.ok(core.text.includes('守时：说好的时间一定到'));
    assert.ok(core.text.includes('未经验证的判断'));
  });

  test('返回值冻结，防止下游改人格', () => {
    const sections = buildSections(DEFAULT_CARD);
    assert.ok(Object.isFrozen(sections));
    assert.ok(Object.isFrozen(sections[0]));
    assert.throws(() => { sections[0].text = '替换'; }, TypeError);
  });

  test('不传卡时抛清晰 TypeError（v0.4.12 起必须显式传入）', () => {
    assert.throws(() => buildSections(), {
      name: 'TypeError',
      message: /buildSections\(card\): card is required/,
    });
    assert.throws(() => buildSections(null), TypeError);
    assert.throws(() => buildSections(undefined), TypeError);
    assert.throws(() => buildSections('珞然'), TypeError);
    // 显式传入内置卡仍渲染三段，与旧的「默认卡」行为等价。
    const sections = buildSections(DEFAULT_CARD);
    assert.equal(sections.length, 3);
    assert.ok(sections[1].text.includes(DEFAULT_CARD.name));
  });
});

describe('boardSection', () => {
  test('状态板段 name/order 固定，正文被包装', () => {
    const section = boardSection('用户在做桌宠；今天有 2 个待办。');
    assert.equal(section.name, 'persona:state_board');
    assert.equal(section.order, 160);
    assert.ok(section.text.startsWith('[状态板]'));
    assert.ok(section.text.includes('用户在做桌宠'));
    assert.ok(Object.isFrozen(section));
  });

  test('空状态板不产生空标题', () => {
    assert.equal(boardSection('').text, '');
    assert.equal(boardSection('   ').text, '');
    assert.equal(boardSection(null).text, '');
  });
});
