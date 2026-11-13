/**
 * A8⑥（v0.4.13）：闲聊轮的生活类召回条数由 recall.chatLimit 决定（默认 1）。
 *
 * 只做配置层断言：默认值、合法区间、非法值、以及不破坏 16 键安装面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, ConfigError, normalizeConfig } from '../src/config.js';

test('recall.chatLimit 默认 1，且不改 16 键安装面', () => {
  assert.equal(DEFAULTS.recall.chatLimit, 1);
  assert.equal(Object.keys(DEFAULTS).length, 16);
  assert.equal(normalizeConfig({}).recall.chatLimit, 1);
});

test('recall.chatLimit 合法区间 0..5', () => {
  for (const value of [0, 1, 3, 5]) {
    assert.equal(normalizeConfig({ recall: { chatLimit: value } }).recall.chatLimit, value);
  }
});

test('recall.chatLimit 越界或非整数抛 ConfigError(recall.chatLimit)', () => {
  const bad = [-1, 6, 1.5, '2', null, Number.NaN];
  for (const value of bad) {
    assert.throws(
      () => normalizeConfig({ recall: { chatLimit: value } }),
      (error) => error instanceof ConfigError && error.field === 'recall.chatLimit',
      `value=${String(value)}`,
    );
  }
});

test('recall.chatLimit=0 表示闲聊不带记忆', () => {
  assert.equal(normalizeConfig({ recall: { chatLimit: 0 } }).recall.chatLimit, 0);
});
