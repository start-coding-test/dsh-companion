import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, assemble, estimateTokens } from '../src/memory/assemble.js';

/** 三段静态人格，合计 30 token（每段 20 字）。 */
const SECTIONS = [
  { name: 'persona:safety', order: 80, text: '安全'.repeat(10) },
  { name: 'persona:core', order: 90, text: '人格'.repeat(10) },
  { name: 'persona:protocol', order: 150, text: '协议'.repeat(10) },
];

const BOARD = '状态'.repeat(10); // 20 字 + 标题 = 13 token

/** 构造 n 条等长历史（每条 100 字 = 50 token）。 */
function historyItems(n) {
  return Array.from({ length: n }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第${index}条`.padEnd(100, '历'),
  }));
}

function layerSum(result) {
  return Object.values(result.layers).reduce((sum, value) => sum + value, 0);
}

describe('estimateTokens', () => {
  test('按 Unicode 码点/2 向上取整，与设计口径一致', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('中文'), 1);
    assert.equal(estimateTokens('中文测试'), 2);
    assert.equal(estimateTokens('🙂'), 1);
    assert.equal(estimateTokens(undefined), 0);
  });
});

describe('assemble 基本装配', () => {
  test('sections 按 order 升序输出，board/Recall/history 就位', () => {
    const history = [
      { role: 'user', content: '昨天聊到测试' },
      { role: 'assistant', content: '是的' },
    ];
    const recallItems = [
      { id: 'f1', kind: 'fact', date: '2026-10-21', score: 0.9, text: '用户喜欢简洁的回答' },
      { id: 'e2', kind: 'episode', date: '2026-10-30', score: 0.4, text: '上次卡在托盘图标' },
    ];

    const result = assemble({
      sections: [SECTIONS[2], SECTIONS[0], SECTIONS[1]],
      boardText: BOARD,
      recallItems,
      history,
      userInput: '今天继续吗？',
    });

    assert.deepEqual(result.sections.map((section) => section.order), [80, 90, 150]);
    assert.equal(result.board.name, 'persona:state_board');
    assert.equal(result.board.order, 160);
    assert.ok(result.board.text.includes(BOARD));

    // 历史消息 + 本轮 user 消息
    assert.equal(result.messages.length, 3);
    const current = result.messages.at(-1);
    assert.equal(current.role, 'user');
    assert.ok(current.content[0].text.includes('今天继续吗？'));
    assert.ok(current.content[0].text.includes('[相关记忆]'));
    assert.ok(current.content[0].text.includes('(fact #f1, 2026-10-21)'));
    assert.ok(current.content[0].text.includes('用户喜欢简洁的回答'));
    assert.ok(current.content[0].text.includes('上次卡在托盘图标'));

    assert.equal(result.layers.persona, 30);
    assert.equal(result.layers.board, estimateTokens(result.board.text));
    assert.equal(result.layers.history, 4);
    assert.equal(result.layers.input, 3);
    assert.equal(result.tokens.total, layerSum(result));
    assert.equal(result.tokens.limit, DEFAULT_LIMITS.workingMemoryTokens);
    assert.deepEqual(result.dropped, { recall: [], history: [] });
    assert.equal(result.overBudget, false);

    // 输入不被修改
    assert.deepEqual(history.map((item) => item.content), ['昨天聊到测试', '是的']);
    assert.equal(recallItems.length, 2);
  });

  test('无状态板时 board=null 且不占预算', () => {
    const result = assemble({ sections: SECTIONS, userInput: '在吗' });
    assert.equal(result.board, null);
    assert.equal(result.layers.board, 0);
    assert.deepEqual(result.sections.map((section) => section.name), [
      'persona:safety',
      'persona:core',
      'persona:protocol',
    ]);
  });

  test('召回为空时不留空标题，user 原文原样保留', () => {
    const result = assemble({ sections: SECTIONS, userInput: '只问一句' });
    const text = result.messages.at(-1).content[0].text;
    assert.equal(text, '只问一句');
    assert.equal(result.layers.recall, 0);
    assert.ok(!text.includes('[相关记忆]'));
  });

  test('历史支持字符串与 role/content 两种形态', () => {
    const result = assemble({
      sections: SECTIONS,
      history: ['第一条', { role: 'assistant', content: '第二条' }],
      userInput: '继续',
    });
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0].content[0].text, '第一条');
    assert.deepEqual(result.messages[1].content[0].text, '第二条');
  });
});

describe('assemble 预算裁切', () => {
  test('超总预算时先按 score 升序丢召回', () => {
    const recallItems = [
      { id: 'high', score: 0.9, text: '甲'.repeat(400) },
      { id: 'low', score: 0.1, text: '乙'.repeat(400) },
      { id: 'mid', score: 0.5, text: '丙'.repeat(400) },
    ];
    const result = assemble({
      sections: SECTIONS,
      recallItems,
      userInput: '继续',
      limits: { workingMemoryTokens: 260, retainTokens: 0 },
    });

    assert.deepEqual(result.dropped.recall.map((item) => item.id), ['low', 'mid']);
    const current = result.messages.at(-1).content[0].text;
    assert.ok(current.includes('甲'.repeat(400)), '保留高分召回');
    assert.ok(!current.includes('乙'.repeat(400)));
    assert.ok(!current.includes('丙'.repeat(400)));
    assert.ok(result.layers.recall <= 260);
    assert.equal(result.overBudget, false);
  });

  test('召回自身受 recallTokens 上限约束（总预算未超也会裁）', () => {
    const recallItems = Array.from({ length: 5 }, (_, index) => ({
      id: `r${index}`,
      score: index,
      text: `${index}`.padEnd(40, '召'),
    }));
    const result = assemble({
      sections: SECTIONS,
      recallItems,
      userInput: '继续',
      limits: { workingMemoryTokens: 32000, recallTokens: 50 },
    });
    assert.ok(result.layers.recall <= 50, `recall=${result.layers.recall}`);
    assert.equal(result.dropped.recall.length, 4);
    // 从最低分开始丢
    assert.deepEqual(result.dropped.recall.map((item) => item.id), ['r0', 'r1', 'r2', 'r3']);
    assert.equal(result.overBudget, false);
  });

  test('仍超时从最旧裁历史，保留最后 ≥6,144 token', () => {
    const history = historyItems(200); // 10,000 token
    const result = assemble({
      sections: SECTIONS,
      history,
      userInput: '继续',
      limits: { workingMemoryTokens: 7000 },
    });

    assert.ok(result.layers.history >= 6144, `history=${result.layers.history}`);
    assert.ok(result.layers.history < 10000);
    assert.equal(result.dropped.history.length, 61);
    assert.equal(result.dropped.history[0], history[0], '最先丢最旧一条');
    // 保留的是后缀
    assert.equal(result.messages.length, 200 - 61 + 1);
    assert.deepEqual(
      result.messages[0].content[0].text,
      history[61].content,
    );
    assert.equal(result.tokens.total, layerSum(result));
    assert.equal(result.tokens.total, 6981);
    assert.equal(result.overBudget, false);
  });

  test('历史裁到 6,144 下限后仍超预算 → overBudget=true', () => {
    const history = historyItems(200);
    const result = assemble({
      sections: SECTIONS,
      history,
      userInput: '继续',
      limits: { workingMemoryTokens: 1000 },
    });
    assert.equal(result.layers.history, 6150);
    assert.equal(result.dropped.history.length, 77);
    assert.equal(result.overBudget, true);
    assert.equal(result.tokens.total, 6181);
    assert.ok(result.layers.history >= 6144);
  });

  test('人格段、状态板、本轮输入永不裁切', () => {
    const result = assemble({
      sections: SECTIONS,
      boardText: BOARD,
      history: historyItems(20),
      userInput: '这句必须完整保留',
      limits: { workingMemoryTokens: 10, retainTokens: 0 },
    });

    assert.deepEqual(result.sections, SECTIONS);
    assert.equal(result.board.text, `[状态板]\n${BOARD}`);
    assert.equal(result.messages.at(-1).content[0].text, '这句必须完整保留');
    // 召回为空、历史被裁到 0，仍因固定前缀超预算
    assert.equal(result.layers.history, 0);
    assert.equal(result.overBudget, true);
    assert.equal(result.tokens.total, 47);
  });

  test('overBudget 边界：恰好等于预算为 false，少 1 token 为 true', () => {
    const base = assemble({ sections: SECTIONS, boardText: BOARD, userInput: '继续' });
    assert.equal(base.tokens.total, 44);

    const exact = assemble({
      sections: SECTIONS,
      boardText: BOARD,
      userInput: '继续',
      limits: { workingMemoryTokens: 44 },
    });
    assert.equal(exact.overBudget, false);
    assert.equal(exact.tokens.total, 44);

    const tight = assemble({
      sections: SECTIONS,
      boardText: BOARD,
      userInput: '继续',
      limits: { workingMemoryTokens: 43 },
    });
    assert.equal(tight.overBudget, true);
    assert.deepEqual(tight.sections, SECTIONS);
  });
});
