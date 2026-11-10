/**
 * persona:voice 段（order 95）的组合规则。
 *
 * v0.5.0 修：`tone.voice` 与 `mes_example` 同时存在时，两者都要进 voice 段——
 * 早期实现是 `if (voice) return …`，卡里写了说话方式就把示例对话静默丢弃了。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CARD, parseCardSourceDetailed } from '../src/persona/card.js';
import { buildSections } from '../src/persona/sections.js';

/** @param {object} card @returns {string|undefined} */
function voiceOf(card) {
  return buildSections(card).find((section) => section.name === 'persona:voice')?.text;
}

test('voice：内置卡两字段皆空 → 不注册 persona:voice（v0.4.12 基线）', () => {
  assert.equal(voiceOf(DEFAULT_CARD), undefined);
});

test('voice：只有 tone.voice → 段里只有说话方式', () => {
  const card = { ...DEFAULT_CARD, tone: { ...DEFAULT_CARD.tone, voice: '句子短，语速慢。' } };
  const text = voiceOf(card);
  assert.ok(text);
  assert.match(text, /^\[说话方式\]\n（模仿口吻，不照抄内容）\n句子短，语速慢。$/u);
  assert.equal(text.match(/句子短/u).length, 1);
});

test('voice：只有 mes_example → 段里是示例，<START> 变空行且占位符已替换', () => {
  const card = {
    ...DEFAULT_CARD,
    mes_example: '<START>\n{{char}}：回来啦。\n{{user}}：嗯。',
  };
  const text = voiceOf(card);
  assert.ok(text);
  assert.ok(!text.includes('<START>'), '分隔符应被替换掉');
  assert.match(text, /珞然：回来啦。/u);
  assert.match(text, /你：嗯。/u);
});

test('voice：两者都有 → 说话方式与示例都在（v0.5.0 修复点）', () => {
  const card = {
    ...DEFAULT_CARD,
    tone: { ...DEFAULT_CARD.tone, voice: '句子短，语速慢。' },
    mes_example: '<START>\n{{char}}：回来啦。',
  };
  const text = voiceOf(card);
  assert.ok(text);
  assert.match(text, /句子短，语速慢。/u);
  assert.match(text, /珞然：回来啦。/u);
  assert.ok(
    text.indexOf('句子短') < text.indexOf('珞然：回来啦。'),
    '说话方式应在示例之前',
  );
});

test('voice：CCv2 卡导入后 tone.voice 与 mes_example 都不丢', () => {
  const raw = JSON.stringify({
    spec: 'chara_card_v2',
    data: {
      name: '阿岩',
      mes_example: '<START>\n{{char}}：来了？',
      personality: '话少',
    },
  });
  const { card } = parseCardSourceDetailed(raw);
  const text = voiceOf(card);
  assert.ok(text);
  assert.match(text, /阿岩：来了？/u);
});
