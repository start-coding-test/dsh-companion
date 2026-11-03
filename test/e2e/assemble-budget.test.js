/**
 * V10 / V16 装配预算 e2e（06-记忆系统设计.md §7、05-架构设计.md §2.4）。
 *
 * 只驱动 assemble() 的裁切行为，不依赖 Store、调度器与命令层：
 * - V10：超 32K 时低分召回先丢、历史从最旧裁且保留尾部 ≥6,144、人格/板/输入不动。
 * - V16：单侧超限、双侧超限、弱召回与边界 32,000 的裁切顺序。
 *
 * 所有日期由固定 NOW 推导，不读真实时钟、不联网、不写仓库外路径。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIMITS,
  assemble,
  estimateTokens,
} from '../../src/memory/assemble.js';
import { buildSections } from '../../src/persona/sections.js';
import { DEFAULT_CARD } from '../../src/persona/card.js';

/** 固定时钟：装配只应依赖输入，不应读取真实时间。 */
const NOW = Object.freeze({
  epoch: Date.parse('2026-11-03T20:00:00.000+08:00'),
  iso: '2026-11-03T20:00:00.000+08:00',
});
const DAY_MS = 86_400_000;
const dayOf = (offset) => new Date(NOW.epoch + offset * DAY_MS).toISOString().slice(0, 10);

/** 每条历史 100 字 = 50 token。 */
const HISTORY_CHARS = 100;
const HISTORY_TOKENS = estimateTokens('历'.repeat(HISTORY_CHARS));

function makeHistory(count, chars = HISTORY_CHARS, prefix = '第') {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}${index}条`.padEnd(chars, '历').slice(0, chars),
  }));
}

function makeRecallItem({ id, score, chars = 400, retention = 0 }) {
  return {
    id,
    kind: 'fact',
    date: dayOf(-Number(id.replace(/\D/gu, '') || 0)),
    score,
    // 模拟记忆强度 R：assemble 不读它，弱项不得因此挤掉强项。
    retention,
    text: `${id}：${'记'.repeat(Math.max(0, chars - id.length - 1))}`,
  };
}

function layerSum(result) {
  return Object.values(result.layers).reduce((sum, value) => sum + value, 0);
}

function assertInvariants(result) {
  assert.equal(result.tokens.total, layerSum(result), 'tokens.total 应与各层之和自洽');
  assert.ok(Number.isInteger(result.tokens.total));
  assert.equal(result.tokens.limit, DEFAULT_LIMITS.workingMemoryTokens);
}

function droppedScores(result) {
  return result.dropped.recall.map((item) => item.score);
}

function assertAscending(scores) {
  assert.deepEqual(scores, [...scores].sort((left, right) => left - right));
}

describe('V10 装配超 32K 的完整裁切', () => {
  test('低分召回先丢、历史保留尾部 ≥6,144，人格/板/输入不动', () => {
    // 刻意打乱输入顺序，验证丢弃依据是 score 而不是数组下标。
    const scores = [0.3, 0.9, 0.1, 0.7, 0.5, 0.2, 0.8, 0.4, 0.05, 0.6, 0.15, 0.75];
    const recallItems = scores.map((score, index) => makeRecallItem({
      id: `r${index}`,
      score,
      chars: 400,
    }));
    const history = makeHistory(900); // 45,000 token，远超 32K
    const sections = buildSections(DEFAULT_CARD);
    const boardText = `当前局面：${'板'.repeat(395)}`; // 400 字
    const userInput = '今天先把预算装配跑通。';

    const result = assemble({ sections, boardText, recallItems, history, userInput });

    // 召回：总量受 2,050 上限约束；历史独占超 32K 时召回会被全部牺牲。
    assert.ok(result.layers.recall <= DEFAULT_LIMITS.recallTokens,
      `recall=${result.layers.recall} 应 ≤ ${DEFAULT_LIMITS.recallTokens}`);
    assert.deepEqual(
      result.dropped.recall.map((item) => item.id),
      [...recallItems].sort((left, right) => left.score - right.score).map((item) => item.id),
      'dropped.recall 应按 score 升序（同分时较新者先丢）',
    );
    assertAscending(droppedScores(result));

    // 历史：从最旧裁，保留的是原数组的后缀，且尾部 ≥ 6,144 token。
    assert.ok(result.dropped.history.length > 0, '应裁掉部分历史');
    assert.deepEqual(
      result.dropped.history,
      history.slice(0, result.dropped.history.length),
      'dropped.history 必须是历史前缀',
    );
    assert.ok(result.layers.history >= DEFAULT_LIMITS.retainTokens,
      `history=${result.layers.history} 应 ≥ ${DEFAULT_LIMITS.retainTokens}`);
    assert.ok(result.layers.history < 900 * HISTORY_TOKENS, '历史应被裁短');
    assert.equal(result.messages.length, 900 - result.dropped.history.length + 1);
    assert.equal(
      result.messages[0].content[0].text,
      history[result.dropped.history.length].content,
      '保留窗口必须从被裁前缀之后开始',
    );

    // 人格三段、状态板与本轮输入逐字节不变。
    assert.deepEqual(result.sections, sections);
    assert.deepEqual(result.sections.map((section) => section.order), [80, 90, 150]);
    assert.equal(result.board.text, `[状态板]\n${boardText}`);
    assert.equal(result.messages.at(-1).role, 'user');
    assert.equal(result.messages.at(-1).content[0].text, userInput);

    // 总预算：召回已被清空，历史裁到下限即可回到 32K 内。
    assert.equal(result.layers.recall, 0);
    assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens,
      `total=${result.tokens.total} 应 ≤ 32,000`);
    assert.equal(result.overBudget, false);
    assertInvariants(result);
  });
});

describe('V16 单侧/双侧超限与边界', () => {
  test('仅历史超 32K：只裁历史，召回与人格段不动', () => {
    const history = makeHistory(800); // 40,000 token
    const sections = buildSections(DEFAULT_CARD);
    const boardText = '当前局面：等待用户确认。';
    const result = assemble({ sections, boardText, history, userInput: '继续' });

    assert.deepEqual(result.dropped.recall, []);
    assert.equal(result.layers.recall, 0);
    assert.ok(result.dropped.history.length > 0);
    assert.ok(result.layers.history >= DEFAULT_LIMITS.retainTokens);
    assert.ok(result.layers.history < 800 * HISTORY_TOKENS);
    assert.deepEqual(result.sections, sections);
    assert.equal(result.board.text, `[状态板]\n${boardText}`);
    assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens);
    assert.equal(result.overBudget, false);

    // 历史保留的是尾部：首条消息下标 = 被裁条数。
    assert.equal(
      result.messages[0].content[0].text,
      history[result.dropped.history.length].content,
    );
  });

  test('仅召回超 2,050：只裁召回，历史完整保留', () => {
    const recallItems = Array.from({ length: 12 }, (_, index) => makeRecallItem({
      id: `q${index}`,
      score: (index + 1) / 20, // 0.05..0.6
      chars: 500, // 每条约 250 token，总量 > 2,050
    }));
    const history = makeHistory(12, 40); // 240 token，远低于总预算
    const result = assemble({ history, recallItems, userInput: '继续' });

    assert.ok(result.dropped.recall.length > 0, '应裁掉低分召回');
    assert.deepEqual(result.dropped.history, [], '历史不应被裁');
    assert.equal(result.layers.history, 12 * estimateTokens('历'.repeat(40)));
    assert.ok(result.layers.recall <= DEFAULT_LIMITS.recallTokens,
      `recall=${result.layers.recall} 应 ≤ 2,050`);
    assert.equal(result.messages.length, history.length + 1);
    assert.deepEqual(
      result.messages.slice(0, -1).map((message) => message.content[0].text),
      history.map((item) => item.content),
      '历史逐条保留',
    );
    assertAscending(droppedScores(result));
    assert.equal(result.overBudget, false);

    // 最高分召回必须仍在注入文本里。
    const best = [...recallItems].sort((left, right) => right.score - left.score)[0];
    assert.ok(result.messages.at(-1).content[0].text.includes(best.text));
  });

  test('两侧都超：先清空低分召回，再裁历史', () => {
    const history = makeHistory(800); // 40,000 token
    const recallItems = Array.from({ length: 12 }, (_, index) => makeRecallItem({
      id: `b${index}`,
      score: 0.05 + index * 0.07,
      chars: 500, // 约 3,000 token > 2,050
    }));
    const result = assemble({ history, recallItems, userInput: '继续' });

    assert.equal(result.dropped.recall.length, recallItems.length,
      '历史独占超 32K 时召回会被全部让位');
    assert.ok(result.dropped.history.length > 0);
    assert.equal(result.layers.recall, 0);
    assert.ok(result.layers.history >= DEFAULT_LIMITS.retainTokens);
    assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens);
    assert.equal(result.overBudget, false);
    assertAscending(droppedScores(result));
    assert.equal(
      result.messages[0].content[0].text,
      history[result.dropped.history.length].content,
    );
  });

  test('弱召回（低 score、高 R）不得挤掉强召回', () => {
    const recallItems = [
      makeRecallItem({ id: 'strong', score: 0.95, chars: 1000 }),
      makeRecallItem({ id: 'weak', score: 0.05, chars: 1000, retention: 1 }),
      makeRecallItem({ id: 'm1', score: 0.9, chars: 500 }),
      makeRecallItem({ id: 'm2', score: 0.85, chars: 500 }),
      makeRecallItem({ id: 'm3', score: 0.8, chars: 500 }),
      makeRecallItem({ id: 'm4', score: 0.75, chars: 500 }),
    ];
    const result = assemble({ recallItems, userInput: '继续' });

    assert.ok(result.layers.recall <= DEFAULT_LIMITS.recallTokens);
    assert.ok(
      result.dropped.recall.some((item) => item.id === 'weak'),
      '低分弱召回应先被丢弃（retention 不参与装配排序）',
    );
    assert.ok(
      !result.dropped.recall.some((item) => item.id === 'strong'),
      '高分强召回必须保留',
    );
    const text = result.messages.at(-1).content[0].text;
    assert.ok(text.includes(recallItems[0].text), '强召回原文应被注入');
    assert.ok(!text.includes(recallItems[1].text), '弱召回原文不应被注入');
  });

  test('恰好 32,000 token：不裁任何一层', () => {
    const history = makeHistory(640); // 640 × 50 = 32,000
    assert.equal(history.length * HISTORY_TOKENS, DEFAULT_LIMITS.workingMemoryTokens);

    const result = assemble({ history, userInput: '' });

    assert.equal(result.layers.history, DEFAULT_LIMITS.workingMemoryTokens);
    assert.equal(result.tokens.total, DEFAULT_LIMITS.workingMemoryTokens);
    assert.deepEqual(result.dropped, { recall: [], history: [] });
    assert.equal(result.overBudget, false);
    assert.equal(result.messages.length, history.length + 1);
    assert.equal(result.messages[0].content[0].text, history[0].content);
    assert.equal(result.messages.at(-2).content[0].text, history.at(-1).content);
    assertInvariants(result);
  });

  test('超过 32,000 仅 1 token 时才裁历史', () => {
    const history = makeHistory(640);
    history.push({ role: 'user', content: '多'.repeat(2) }); // +1 token

    const result = assemble({ history, userInput: '' });

    // 32001 - 50（最旧一条）= 31951，已回到 32,000 以内，因此只裁一条。
    const expectedHistory = DEFAULT_LIMITS.workingMemoryTokens + 1 - HISTORY_TOKENS;
    assert.equal(result.layers.history, expectedHistory);
    assert.equal(result.dropped.history.length, 1);
    assert.equal(result.dropped.history[0], history[0]);
    assert.equal(result.tokens.total, expectedHistory);
    assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens);
    assert.equal(result.overBudget, false);
    assert.equal(result.messages.length, 640 + 1);
    assert.equal(result.messages[0].content[0].text, history[1].content);
  });
});
