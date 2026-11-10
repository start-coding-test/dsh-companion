/**
 * 闲聊提示词里的人设要点行（P4）。
 *
 * 规则：只有**用户卡**（description 与内置默认文案不同）才输出「人设要点：…」；
 * 内置卡 / 情绪关闭时，闲聊提示词必须与 v0.4.12 逐字节一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CARD } from '../src/persona/card.js';
import { buildChatPrompt } from '../src/persona/chat.js';

/** @param {object} [card] */
const promptOf = (card) => buildChatPrompt({ card, recentTopics: [], messageCount: 6 });

test('内置卡：不出现「人设要点」，首行仍是 chatIdentity', () => {
  const prompt = promptOf(DEFAULT_CARD);
  assert.ok(!prompt.includes('人设要点'), '内置卡不应追加人设要点');
  assert.equal(prompt.split('\n')[0], '你是用户的私人助手珞然，称呼用户为「你」。');
});

test('用户卡：输出「人设要点」，位置在身份行之后、语气行之前', () => {
  const card = { ...DEFAULT_CARD, description: '你是{{char}}，{{user}}的邻居姐姐，在出版社做编辑。' };
  const lines = promptOf(card).split('\n');
  assert.equal(lines[0], '你是用户的私人助手珞然，称呼用户为「你」。');
  assert.equal(lines[1], '人设要点：你是珞然，你的邻居姐姐，在出版社做编辑。');
  assert.match(lines[2], /^语气：/u);
});

test('用户卡：多行 description 压成一行，占位符已替换', () => {
  const card = { ...DEFAULT_CARD, description: '第一行{{char}}\n第二行{{user}}' };
  const line = promptOf(card).split('\n').find((item) => item.startsWith('人设要点：'));
  assert.equal(line, '人设要点：第一行珞然 第二行你');
});

test('用户卡：description 超长截到 200 码点', () => {
  const card = { ...DEFAULT_CARD, description: '长'.repeat(500) };
  const line = promptOf(card).split('\n').find((item) => item.startsWith('人设要点：'));
  assert.equal([...line].length, [...'人设要点：'].length + 200);
});

test('用户卡：情绪行仍追加在末尾，不被要点行挤掉', () => {
  const card = { ...DEFAULT_CARD, description: '隔壁的姐姐。' };
  const prompt = buildChatPrompt({ card, emotionLine: '心情不错', messageCount: 6 });
  assert.ok(prompt.includes('人设要点：隔壁的姐姐。'));
  assert.equal(prompt.split('\n').at(-1), '你此刻：心情不错');
});
