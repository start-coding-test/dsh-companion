/**
 * v0.5.0 复审（review-v20）回归：M-1 / M-2 / M-3 与 L-7。
 *
 * 1) CCv2/v3 的 `data.extensions.address` 与 `data.address` 都要被接受，顶层优先；
 * 2) `{{char}}` / `{{user}}` 在 tone.* 与 bannedPhrases 里也必须渲染（core 与闲聊）；
 * 3) 巩固提示词不再写死「私人管家」；
 * 4) `DEFAULT_BASELINE` 与内置卡 `emotion.baseline` 必须一致（缺省继承 vs 非法回落）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CARD, parseCardSourceDetailed } from '../src/persona/card.js';
import { buildSections } from '../src/persona/sections.js';
import { buildChatPrompt } from '../src/persona/chat.js';
import { DEFAULT_BASELINE } from '../src/persona/emotion.js';
import { buildConsolidationPrompt } from '../src/memory/consolidate.js';

const PLACEHOLDER_CARD = JSON.stringify({
  name: '岚',
  address: '老板',
  tone: {
    style: '像{{char}}一样简洁',
    warmth: '对{{user}}温和',
    structure: '先给{{user}}结论',
  },
  bannedPhrases: ['叫{{user}}老大', '自称{{char}}大人'],
});

function coreAndChat(card) {
  const sections = buildSections(card);
  const core = sections.find((section) => section.name === 'persona:core');
  assert.ok(core, 'core 段必须存在');
  const chat = buildChatPrompt({ card, recentTopics: [], messageCount: 6 });
  return { core: core.text, chat };
}

test('M-1：CCv2 的 data.extensions.address 被接受（顶层 data.address 优先）', () => {
  const viaExtensions = parseCardSourceDetailed(JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '岚', extensions: { address: '先生' } },
  }));
  assert.equal(viaExtensions.card.address, '先生');
  assert.deepEqual(viaExtensions.warnings, []);

  const both = parseCardSourceDetailed(JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '岚', address: '老板', extensions: { address: '先生' } },
  }));
  assert.equal(both.card.address, '老板', '顶层 data.address 优先');

  const empty = parseCardSourceDetailed(JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '岚', extensions: { address: '   ' } },
  }));
  assert.equal(empty.card.address, '你', '空白 extensions.address 仍回落「你」');
});

test('M-1：CCv3 同样读 data.extensions.address', () => {
  const parsed = parseCardSourceDetailed(JSON.stringify({
    spec: 'chara_card_v3',
    data: { name: '岚', extensions: { address: '先生' } },
  }));
  assert.equal(parsed.card.address, '先生');
});

test('M-2：tone.* 与 bannedPhrases 里的 {{char}}/{{user}} 在 core 与闲聊里都渲染', () => {
  const { card } = parseCardSourceDetailed(PLACEHOLDER_CARD);
  const { core, chat } = coreAndChat(card);

  assert.doesNotMatch(core, /\{\{/u, `core 不应残留占位符：${core}`);
  assert.doesNotMatch(chat, /\{\{/u, `闲聊提示词不应残留占位符：${chat}`);
  assert.match(core, /语气像岚一样简洁、对老板温和，先给老板结论/u);
  assert.match(chat, /语气：像岚一样简洁、对老板温和、先给老板结论。/u);
  assert.match(chat, /禁用表达：叫老板老大、自称岚大人。/u);
});

test('M-2：内置卡输出里不出现占位符（渲染是空操作）', () => {
  const { core, chat } = coreAndChat(DEFAULT_CARD);
  assert.doesNotMatch(core, /\{\{/u);
  assert.doesNotMatch(chat, /\{\{/u);
});

test('M-3：巩固提示词是中性身份，不含「私人管家」', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    transcript: [{ role: 'user', text: '你好' }],
  });
  assert.doesNotMatch(prompt, /私人管家|私人助手/u);
  assert.match(prompt, /^你是记忆巩固器。/u);
});

test('L-7：DEFAULT_BASELINE 与内置卡 emotion.baseline 一致，非法基线回落到同一组值', () => {
  assert.deepEqual({ ...DEFAULT_CARD.emotion.baseline }, { ...DEFAULT_BASELINE });

  const tone = { style: '简洁', warmth: '温和', structure: '先结论' };
  const parsed = parseCardSourceDetailed(JSON.stringify({
    name: '岚',
    address: '你',
    tone,
    emotion: { enabled: true, baseline: { pleasure: 999 } },
  }));
  assert.deepEqual(parsed.card.emotion.baseline, DEFAULT_BASELINE);
  assert.ok(parsed.warnings.some((warning) => warning.code === 'emotion_baseline_invalid'));

  const omitted = parseCardSourceDetailed(JSON.stringify({
    name: '岚',
    address: '你',
    tone,
    emotion: { enabled: true },
  }));
  assert.deepEqual(omitted.card.emotion.baseline, DEFAULT_BASELINE);
});
