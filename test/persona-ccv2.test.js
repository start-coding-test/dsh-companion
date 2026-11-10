/**
 * CCv2 / CCv3 角色卡导入（v0.4.13 P1）。
 *
 * 覆盖：spec 包装映射、address/version 缺省、字段缺失走默认值、`{{char}}`/`{{user}}`
 * 在所有渲染输出里替换（卡里原文不动）、`character_book` 忽略并给 warning、name 仍必填。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CARD,
  loadPersonaCard,
  parseCardSource,
  parseCardSourceDetailed,
} from '../src/persona/card.js';
import { buildChatPrompt } from '../src/persona/chat.js';
import { buildSections } from '../src/persona/sections.js';

const CCV2 = readFileSync(new URL('./fixtures/persona-ccv2.json', import.meta.url), 'utf8');
const CCV3 = readFileSync(new URL('./fixtures/persona-ccv3.json', import.meta.url), 'utf8');

/** 用临时目录隔离人格卡文件（不碰 ~/.dsh）。 */
function withTempDir(fn) {
  return (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-ccv2-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return fn(dir);
  };
}

function sectionByName(sections, name) {
  return sections.find((section) => section.name === name);
}

describe('CCv2 导入', () => {
  test('data 字段映射 + address/version 缺省', () => {
    const card = parseCardSource(CCV2);
    assert.equal(card.name, '阿岩');
    assert.equal(card.address, '你');
    assert.equal(card.version, 1);
    assert.equal(card.description, '你是{{char}}，{{user}}的老同学。称呼用户为「{{user}}」。');
    assert.equal(card.personality, '嘴硬心软');
    assert.equal(card.scenario, '{{char}}和{{user}}合租。');
    assert.equal(card.mes_example, '<START>\n{{char}}：回来了？');
    assert.equal(card.first_mes, '哟。');
    assert.equal(card.post_history_instructions, '保持简短。');
    // 未出现在 data 里的字段用本卡默认值。
    assert.deepEqual(card.values, DEFAULT_CARD.values);
    assert.equal(card.memoryCitation, 'explicit');
  });

  test('渲染输出替换 {{char}}/{{user}}，卡里原文保持不变', () => {
    const card = parseCardSource(CCV2);
    const sections = buildSections(card);
    const core = sectionByName(sections, 'persona:core');
    const voice = sectionByName(sections, 'persona:voice');
    assert.ok(core.text.includes('你是阿岩，你的老同学。'));
    assert.ok(core.text.includes('场景：阿岩和你合租。'));
    assert.ok(voice.text.includes('阿岩：回来了？'));
    const prompt = buildChatPrompt({ card });
    assert.equal(prompt.split('\n')[0], '你是用户的私人助手阿岩，称呼用户为「你」。');
    const all = `${sections.map((section) => section.text).join('\n')}\n${prompt}`;
    assert.ok(!all.includes('{{char}}'));
    assert.ok(!all.includes('{{user}}'));
    assert.equal(card.description.includes('{{char}}'), true);
  });

  test('character_book 存在 → warning，且不进任何渲染文本', () => {
    const detailed = parseCardSourceDetailed(CCV2);
    assert.deepEqual(detailed.warnings, [{ code: 'character_book_ignored' }]);
    const all = [
      ...buildSections(detailed.card).map((section) => section.text),
      buildChatPrompt({ card: detailed.card }),
    ].join('\n');
    assert.ok(!all.includes('阿岩其实怕黑'));
    assert.ok(!all.includes('隐藏书'));
    assert.ok(!all.includes('秘密'));
  });

  test('loadPersonaCard 读 CCv2 文件：status=file + warning', withTempDir((dir) => {
    const path = join(dir, 'ccv2.json');
    writeFileSync(path, CCV2, 'utf8');
    const loaded = loadPersonaCard(path);
    assert.equal(loaded.status, 'file');
    assert.equal(loaded.card.name, '阿岩');
    assert.deepEqual(loaded.warnings, [{ code: 'character_book_ignored' }]);
    assert.deepEqual(loaded.card, parseCardSource(CCV2));
  }));

  test('name 为空仍报错', () => {
    const source = JSON.parse(CCV2);
    source.data.name = '';
    assert.throws(
      () => parseCardSource(JSON.stringify(source)),
      { name: 'TypeError', message: /"name"/ },
    );
  });

  test('name 缺失仍报错（不静默回落内置名）', () => {
    const source = JSON.parse(CCV2);
    delete source.data.name;
    assert.throws(
      () => parseCardSource(JSON.stringify(source)),
      { name: 'TypeError', message: /"name"/ },
    );
  });
});

describe('CCv3 导入', () => {
  test('data 字段映射 + address/version 取自 data，字段缺失用默认值', () => {
    const card = parseCardSource(CCV3);
    assert.equal(card.name, '岚');
    assert.equal(card.address, '老板');
    assert.equal(card.version, 4);
    assert.equal(card.description, '你是{{char}}，{{user}}的旅伴。');
    assert.equal(card.personality, '');
    assert.equal(card.scenario, '');
    assert.equal(card.mes_example, '');
    assert.equal(card.first_mes, '');
    assert.equal(card.post_history_instructions, '');
  });

  test('渲染替换占位符，且 character_book 只给 warning', () => {
    const detailed = parseCardSourceDetailed(CCV3);
    assert.deepEqual(detailed.warnings, [{ code: 'character_book_ignored' }]);
    const core = sectionByName(buildSections(detailed.card), 'persona:core');
    assert.ok(core.text.includes('你是岚，老板的旅伴。'));
    assert.ok(!core.text.includes('{{char}}'));
    const prompt = buildChatPrompt({ card: detailed.card });
    assert.equal(prompt.split('\n')[0], '你是用户的私人助手岚，称呼用户为「老板」。');
    // mes_example 为空 → 不注册 voice 段。
    assert.ok(!buildSections(detailed.card).some((section) => section.name === 'persona:voice'));
  });

  test('loadPersonaCard 读 CCv3 文件', withTempDir((dir) => {
    const path = join(dir, 'ccv3.json');
    writeFileSync(path, CCV3, 'utf8');
    const loaded = loadPersonaCard(path);
    assert.equal(loaded.status, 'file');
    assert.equal(loaded.card.name, '岚');
    assert.equal(loaded.card.address, '老板');
    assert.equal(loaded.card.version, 4);
    assert.deepEqual(loaded.warnings, [{ code: 'character_book_ignored' }]);
  }));

  test('name 为空仍报错', () => {
    const source = JSON.parse(CCV3);
    source.data.name = '   ';
    assert.throws(
      () => parseCardSource(JSON.stringify(source)),
      { name: 'TypeError', message: /"name"/ },
    );
  });
});

describe('CCv2/v3 归一化边界', () => {
  test('spec 不匹配 → 仍按原生卡校验（顶层没有 name 直接报错）', () => {
    assert.throws(
      () => parseCardSource(JSON.stringify({ spec: 'chara_card_v1', data: { name: '甲' } })),
      { name: 'TypeError', message: /"name"/ },
    );
  });

  test('spec 匹配但 data 不是对象 → 按原生卡处理（缺 name 报错）', () => {
    assert.throws(
      () => parseCardSource(JSON.stringify({ spec: 'chara_card_v2', data: 'x' })),
      { name: 'TypeError', message: /"name"/ },
    );
  });

  test('address 为空串时回落「你」', () => {
    const source = JSON.parse(CCV2);
    source.data.address = '   ';
    assert.equal(parseCardSource(JSON.stringify(source)).address, '你');
  });
});
