/**
 * N-L1：确认语必须是「短确认语」，不能用子串匹配。
 *
 * 旧实现 `text.includes('对')` 会让「对比一下」「对话」「不对」误触发 α=4；
 * 这里逐条锁定整句、独立小句、句末标点/空格、语气短尾与否定守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIRMATION_WORDS, isConfirmation } from '../src/memory/reinforce.js';

test('N-L1：确认词整句（含句末标点/空格）→ 确认', () => {
  for (const text of CONFIRMATION_WORDS) {
    assert.equal(isConfirmation(text), true, `整句 ${text}`);
  }
  for (const text of ['对。', '是的！', '没错？', ' 记住了 ', '确实…', '就是~', '对的', '对呀', '没错吧？', '记住了啊']) {
    assert.equal(isConfirmation(text), true, text);
  }
});

test('N-L1：确认词独立成小句 → 确认', () => {
  for (const text of ['嗯，对，就这样。', '确实，我记住了。', '是的，按这个来', '对！就按这个来']) {
    assert.equal(isConfirmation(text), true, text);
  }
});

test('N-L1：子串误判（对比/对话/不对）→ 不确认', () => {
  for (const text of ['对比一下', '对比这两个方案', '对话记录', '不对', '不太对', '好像不太对', '不太确定', '我觉得对']) {
    assert.equal(isConfirmation(text), false, text);
  }
});

test('N-L1：确认词 + 后续内容不构成短确认语 → 不确认', () => {
  for (const text of ['对了', '对了他还没来', '就是说', '就是这样', '记住了吗', '确实如此', '就是不去', '未必对']) {
    assert.equal(isConfirmation(text), false, text);
  }
});

test('N-L1：否定/犹疑守卫 → 不确认', () => {
  for (const text of ['对，但是不对', '没错，不过后来不对', '对，好像不太对', '确实不行']) {
    assert.equal(isConfirmation(text), false, text);
  }
});

test('N-L1：空值与无确认词文本 → 不确认', () => {
  for (const text of [undefined, null, '', '   ', '谢谢。', '你好', 0, 123, {}]) {
    assert.equal(isConfirmation(text), false, String(text));
  }
});

test('L-2：确认词后跟新的内容事实（去标点 >10 字）→ 不确认', () => {
  for (const text of [
    '对，我明天要去北京开会，顺便……',
    '没错，明天上午十点在北京南站集合再出发去会场。',
    '是的，我已经把方案发给客户了，等他们回复。',
    '对，记得把上次说的那三个问题一起带过去。',
  ]) {
    assert.equal(isConfirmation(text), false, text);
  }
  // 短确认语仍然成立。
  for (const text of ['对', '没错', '对。', '是的！', '嗯，对。', '确实，我记住了。']) {
    assert.equal(isConfirmation(text), true, text);
  }
});
