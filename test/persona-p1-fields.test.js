/**
 * P1（v0.4.13）人格卡字段生效 / 截断诊断 / 记忆引用模式 / emotion 结构校验。
 *
 * 只测纯函数（loadPersonaCard 的文件路径在 CCv2 测试里覆盖）；不读写 ~/.dsh。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CARD,
  parseCardSource,
  validateCard,
} from '../src/persona/card.js';
import { buildChatPrompt } from '../src/persona/chat.js';
import { buildSections, buildSectionsWithDiagnostics } from '../src/persona/sections.js';

/** 以默认卡为底，tone 显式深合并，避免半张卡。 */
function withCard(overrides = {}) {
  return {
    ...DEFAULT_CARD,
    ...overrides,
    tone: { ...DEFAULT_CARD.tone, ...(overrides.tone ?? {}) },
  };
}

/** @param {ReadonlyArray<{name:string}>} sections @param {string} name */
function sectionByName(sections, name) {
  return sections.find((section) => section.name === name);
}

function charLength(text) {
  return [...text].length;
}

describe('字段生效：core 段', () => {
  test('description/personality/scenario/tone.notes 进 core，占位符被替换', () => {
    const card = parseCardSource(JSON.stringify({
      ...withCard(),
      description: '你是{{char}}，{{user}}的测试助手。',
      personality: '沉稳，话少',
      scenario: '{{user}}在赶工期，{{char}}在旁边打下手',
      tone: { ...DEFAULT_CARD.tone, notes: '少用感叹号' },
    }));
    const core = sectionByName(buildSections(card), 'persona:core');
    assert.ok(core.text.includes('你是珞然，你的测试助手。'));
    assert.ok(core.text.includes('性格：沉稳，话少'));
    assert.ok(core.text.includes('场景：你在赶工期，珞然在旁边打下手'));
    assert.ok(core.text.includes('语气简洁、温和，先结论；少用感叹号。'));
    assert.ok(!core.text.includes('{{char}}'));
    assert.ok(!core.text.includes('{{user}}'));
    // 卡里存的原文保持不变，便于 diff。
    assert.equal(card.description, '你是{{char}}，{{user}}的测试助手。');
  });

  test('taboos: [] 时整行「禁区」省略（V12-L4）', () => {
    const core = sectionByName(buildSections(withCard({ taboos: [] })), 'persona:core');
    assert.ok(!core.text.includes('禁区'));
    assert.ok(core.text.includes('价值观：'));
  });

  test('personality/scenario 为空字符串时不输出对应行', () => {
    const core = sectionByName(buildSections(withCard()), 'persona:core');
    assert.ok(!core.text.includes('性格：'));
    assert.ok(!core.text.includes('场景：'));
  });

  test('first_mes / post_history_instructions 只存不用', () => {
    const card = withCard({ first_mes: '第一句话', post_history_instructions: '保持简短' });
    const all = buildSections(card).map((section) => section.text).join('\n');
    assert.ok(!all.includes('第一句话'));
    assert.ok(!all.includes('保持简短'));
    assert.equal(card.first_mes, '第一句话');
    assert.equal(card.post_history_instructions, '保持简短');
  });
});

describe('字段生效：voice 段', () => {
  test('tone.voice 非空时注册 order 95 的 persona:voice', () => {
    const card = withCard({ tone: { voice: '喜欢用短句，偶尔停顿。' } });
    const sections = buildSections(card);
    assert.deepEqual(sections.map((section) => section.name), [
      'persona:safety',
      'persona:core',
      'persona:voice',
      'persona:protocol',
    ]);
    const voice = sectionByName(sections, 'persona:voice');
    assert.equal(voice.order, 95);
    assert.equal(voice.text, '[说话方式]\n（模仿口吻，不照抄内容）\n喜欢用短句，偶尔停顿。');
  });

  test('tone.voice 为空时用 mes_example，<START> 被替换为空行', () => {
    const card = withCard({ mes_example: '<START>\n{{char}}：回来了？\n{{user}}：刚到。' });
    const voice = sectionByName(buildSections(card), 'persona:voice');
    assert.ok(voice.text.startsWith('[说话方式]\n（模仿口吻，不照抄内容）\n'));
    assert.ok(!voice.text.includes('<START>'));
    assert.ok(voice.text.includes('珞然：回来了？'));
    assert.ok(voice.text.includes('你：刚到。'));
    // mes_example 不会混进 core。
    const core = sectionByName(buildSections(card), 'persona:core');
    assert.ok(!core.text.includes('回来了？'));
  });

  test('两者都为空 → 不注册 voice（内置卡）', () => {
    const names = buildSections(DEFAULT_CARD).map((section) => section.name);
    assert.ok(!names.includes('persona:voice'));
  });
});

describe('字段生效：闲聊提示词', () => {
  test('chatIdentity 渲染为第 1 行，{{char}}/{{user}} 被替换', () => {
    const card = withCard({ chatIdentity: '我是{{char}}，称呼你为「{{user}}」。' });
    const lines = buildChatPrompt({ card }).split('\n');
    assert.equal(lines[0], '我是珞然，称呼你为「你」。');
  });

  test('mes_example 非空时在语气行后插入口吻参考（第一段）', () => {
    const card = withCard({ mes_example: '<START>\n{{char}}：回来了？\n<START>\n{{char}}：吃饭没。' });
    const lines = buildChatPrompt({ card }).split('\n');
    assert.equal(lines[1], '语气：简洁、温和、先结论。');
    assert.equal(lines[2], '口吻参考（模仿语气，不照抄内容）：珞然：回来了？');
  });

  test('口吻参考最多 300 码点', () => {
    const card = withCard({ mes_example: '甲'.repeat(400) });
    const prompt = buildChatPrompt({ card });
    const line = prompt.split('\n').find((item) => item.startsWith('口吻参考'));
    const prefix = '口吻参考（模仿语气，不照抄内容）：';
    assert.equal(charLength(line.slice(prefix.length)), 300);
  });

  test('mes_example 为空时没有口吻参考行（基线不变）', () => {
    assert.ok(!buildChatPrompt({ card: DEFAULT_CARD }).includes('口吻参考'));
  });

  test('emotionLine 钩子：非空追加末尾，默认不出现', () => {
    const prompt = buildChatPrompt({ card: DEFAULT_CARD, emotionLine: '有点累，但还算安心' });
    assert.ok(prompt.endsWith('\n你此刻：有点累，但还算安心'));
    assert.ok(!buildChatPrompt({ card: DEFAULT_CARD }).includes('你此刻'));
    // 空白字符串同样视为关闭。
    assert.ok(!buildChatPrompt({ card: DEFAULT_CARD, emotionLine: '   ' }).includes('你此刻'));
  });
});

describe('长度与截断诊断', () => {
  test('core 超 1200 码点截到 1200，并返回 section_truncated', () => {
    const description = 'X'.repeat(1300);
    const card = withCard({ description });
    const expectedRaw = [
      '[身份与口吻]',
      description,
      `语气${DEFAULT_CARD.tone.style}、${DEFAULT_CARD.tone.warmth}，${DEFAULT_CARD.tone.structure}；${DEFAULT_CARD.tone.notes}。`,
      '价值观：',
      ...DEFAULT_CARD.values.map((value) => `- ${value}`),
      `禁区：${DEFAULT_CARD.taboos.join('、')}；被问到时短拒，并转向可行的帮助。`,
    ].join('\n');
    const { sections, warnings } = buildSectionsWithDiagnostics(card);
    const core = sectionByName(sections, 'persona:core');
    assert.equal(charLength(core.text), 1200);
    assert.equal(core.text, [...expectedRaw].slice(0, 1200).join(''));
    assert.deepEqual(warnings, [{
      code: 'section_truncated',
      section: 'persona:core',
      chars: charLength(expectedRaw),
      max: 1200,
    }]);
  });

  test('voice 超 1200 码点截到 1200，并返回 section_truncated', () => {
    const voiceText = 'V'.repeat(1300);
    const card = withCard({ tone: { voice: voiceText } });
    const expectedRaw = `[说话方式]\n（模仿口吻，不照抄内容）\n${voiceText}`;
    const { sections, warnings } = buildSectionsWithDiagnostics(card);
    const voice = sectionByName(sections, 'persona:voice');
    assert.equal(charLength(voice.text), 1200);
    assert.equal(voice.text, [...expectedRaw].slice(0, 1200).join(''));
    assert.deepEqual(warnings, [{
      code: 'section_truncated',
      section: 'persona:voice',
      chars: charLength(expectedRaw),
      max: 1200,
    }]);
  });

  test('未截断时 warnings 为空，buildSections 签名不变（只返回数组）', () => {
    assert.deepEqual(buildSectionsWithDiagnostics(DEFAULT_CARD).warnings, []);
    assert.ok(Array.isArray(buildSections(DEFAULT_CARD)));
  });
});

describe('memoryCitation', () => {
  const NATURAL_LINE = '- 日常对话里自然化用记忆，不必逐条交代出处；用户问起或需要核对事实时，再说来源与时间。';

  test('natural 只替换记忆协议第 2 条，其余行逐字节不变', () => {
    const explicitLines = sectionByName(buildSections(withCard()), 'persona:protocol')
      .text.split('\n');
    const naturalLines = sectionByName(
      buildSections(withCard({ memoryCitation: 'natural' })),
      'persona:protocol',
    ).text.split('\n');
    assert.equal(naturalLines.length, explicitLines.length);
    const changed = [];
    for (let i = 0; i < explicitLines.length; i += 1) {
      if (naturalLines[i] !== explicitLines[i]) changed.push(i);
    }
    assert.deepEqual(changed, [2]);
    assert.equal(naturalLines[2], NATURAL_LINE);
  });

  test('缺省（explicit）与 v0.4.12 协议文本一致', () => {
    assert.equal(
      sectionByName(buildSections(DEFAULT_CARD), 'persona:protocol').text,
      sectionByName(buildSections(withCard({ memoryCitation: 'explicit' })), 'persona:protocol').text,
    );
  });

  test('非法枚举抛 TypeError', () => {
    assert.throws(
      () => validateCard(withCard({ memoryCitation: 'sometimes' })),
      { name: 'TypeError', message: /"memoryCitation" must be "explicit" or "natural"/ },
    );
  });
});

describe('emotion 结构校验（只校验 + 透传，不实现逻辑）', () => {
  test('默认值与任务卡一致', () => {
    assert.deepEqual(DEFAULT_CARD.emotion, {
      enabled: false,
      baseline: { pleasure: 50, arousal: 50, dominance: 50, energy: 60 },
      halfLifeHours: 6,
      appraiser: 'rules',
      appraiseModel: null,
      appraiseTimeoutMs: 8000,
    });
  });

  test('合法 emotion 原样保留（透传）', () => {
    const emotion = {
      enabled: true,
      baseline: { pleasure: 70, arousal: 40, dominance: 55, energy: 80 },
      halfLifeHours: 24,
    };
    const card = parseCardSource(JSON.stringify({ ...withCard(), emotion }));
    // v0.6：判定器三键由规范化补默认值（与 v0.5.2 行为一致：默认走规则）。
    assert.deepEqual(card.emotion, {
      ...emotion,
      appraiser: 'rules',
      appraiseModel: null,
      appraiseTimeoutMs: 8000,
    });
  });

  test('emotion 非法类型/越界/超上限分别抛 TypeError', () => {
    assert.throws(
      () => validateCard(withCard({ emotion: 'happy' })),
      { name: 'TypeError', message: /"emotion" must be an object/ },
    );
    assert.throws(
      () => validateCard(withCard({ emotion: { enabled: 'yes' } })),
      { name: 'TypeError', message: /"emotion\.enabled" must be a boolean/ },
    );
    assert.throws(
      () => validateCard(withCard({ emotion: { baseline: { ...DEFAULT_CARD.emotion.baseline, pleasure: 101 } } })),
      { name: 'TypeError', message: /"emotion\.baseline\.pleasure" must be a number between 0 and 100/ },
    );
    assert.throws(
      () => validateCard(withCard({ emotion: { halfLifeHours: 0 } })),
      { name: 'TypeError', message: /"emotion\.halfLifeHours"/ },
    );
    assert.throws(
      () => validateCard(withCard({ emotion: { halfLifeHours: 169 } })),
      { name: 'TypeError', message: /"emotion\.halfLifeHours"/ },
    );
  });

  test('缺省 emotion 字段不报错（旧卡兼容）', () => {
    const card = withCard();
    delete card.emotion;
    assert.doesNotThrow(() => validateCard(card));
  });
});

describe('新增字符串字段类型校验', () => {
  test('非字符串抛 TypeError，消息包含字段路径', () => {
    assert.throws(
      () => validateCard(withCard({ description: 123 })),
      { name: 'TypeError', message: /persona card: "description" must be a string/ },
    );
    assert.throws(
      () => validateCard(withCard({ tone: { notes: 5 } })),
      { name: 'TypeError', message: /persona card: "tone\.notes" must be a string/ },
    );
    assert.throws(
      () => validateCard(withCard({ chatIdentity: [] })),
      { name: 'TypeError', message: /persona card: "chatIdentity" must be a string/ },
    );
  });
});
