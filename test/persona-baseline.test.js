/**
 * v0.4.12 基线快照（P1 硬要求）：内置卡 + 情绪关闭时，system 段文本与闲聊提示词
 * 必须与 v0.4.12 逐字节一致。
 *
 * 基准文件 `test/fixtures/persona-v0412.json` 由仓库外脚本在 6eedde9 上生成：
 * - sections：buildSections(DEFAULT_CARD) 的 name/order/text；
 * - chatWithContext：带话题/召回/8 句的闲聊提示词；
 * - chatBare：只传卡的闲聊提示词。
 *
 * 失败时打印首个差异位置与前后片段，避免只看到「文本不相等」。
 */

import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CARD } from '../src/persona/card.js';
import { buildChatPrompt } from '../src/persona/chat.js';
import { buildSections } from '../src/persona/sections.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/persona-v0412.json', import.meta.url), 'utf8'),
);

/**
 * 首个差异的上下文片段，用于失败信息。
 * @param {string} expected
 * @param {string} actual
 * @returns {string}
 */
function diffSnippet(expected, actual) {
  if (expected === actual) return '(equal)';
  const limit = Math.max(expected.length, actual.length);
  for (let i = 0; i < limit; i += 1) {
    if (expected[i] !== actual[i]) {
      const start = Math.max(0, i - 30);
      return `首个差异 @ ${i}\n  expected: ${JSON.stringify(expected.slice(start, i + 50))}`
        + `\n  actual:   ${JSON.stringify(actual.slice(start, i + 50))}`;
    }
  }
  return `长度不同：expected=${expected.length} actual=${actual.length}`;
}

describe('v0.4.12 基线：system 段', () => {
  test('buildSections(DEFAULT_CARD) 与快照逐字节一致', () => {
    const sections = buildSections(DEFAULT_CARD);
    assert.equal(sections.length, fixture.sections.length);
    for (let i = 0; i < fixture.sections.length; i += 1) {
      const expected = fixture.sections[i];
      const actual = sections[i];
      assert.equal(actual.name, expected.name, `第 ${i} 段 name 变了`);
      assert.equal(actual.order, expected.order, `第 ${i} 段 order 变了`);
      assert.equal(
        actual.text,
        expected.text,
        `${expected.name} 文本与 v0.4.12 不一致：\n${diffSnippet(expected.text, actual.text)}`,
      );
    }
  });

  test('内置卡不注册 persona:voice（保证 system 文本不变）', () => {
    const names = buildSections(DEFAULT_CARD).map((section) => section.name);
    assert.ok(!names.includes('persona:voice'));
  });
});

describe('v0.4.12 基线：闲聊提示词', () => {
  test('带话题/召回/8 句的提示词逐字节一致', () => {
    const actual = buildChatPrompt({
      card: DEFAULT_CARD,
      recentTopics: [{ title: '交周报', summary: '周五前交' }],
      recallSummary: '- [事实] 周报周五交（2026-11-01）',
      messageCount: 8,
    });
    assert.equal(
      actual,
      fixture.chatWithContext,
      `闲聊提示词与 v0.4.12 不一致：\n${diffSnippet(fixture.chatWithContext, actual)}`,
    );
  });

  test('只传卡的提示词逐字节一致（空话题/空记忆）', () => {
    const actual = buildChatPrompt({ card: DEFAULT_CARD });
    assert.equal(
      actual,
      fixture.chatBare,
      `闲聊提示词与 v0.4.12 不一致：\n${diffSnippet(fixture.chatBare, actual)}`,
    );
  });

  test('emotionLine 默认空字符串不改变基线', () => {
    const actual = buildChatPrompt({
      card: DEFAULT_CARD,
      recentTopics: [{ title: '交周报', summary: '周五前交' }],
      recallSummary: '- [事实] 周报周五交（2026-11-01）',
      messageCount: 8,
      emotionLine: '',
    });
    assert.equal(actual, fixture.chatWithContext);
  });
});
