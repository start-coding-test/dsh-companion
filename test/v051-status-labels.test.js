/**
 * V50-M1：/状态 的「最近事件」要认得 blame / vent 两个新类型。
 *
 * 生产代码里 EMOTION_EVENT_LABELS 是模块内常量，这里走公开入口 handleCommand
 * 做行为断言：写两条事件，看 /状态 的回复里有没有对应中文标签。
 * 用固定时钟与临时库，不读真实时间、不写用户目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';

const NOW = Date.UTC(2026, 10, 10, 8, 30, 0);
const MINUTE = 60_000;

describe('/状态 情绪事件标签（V50-M1）', () => {
  let dir;
  let store;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-status-labels-'));
    store = Store.open(join(dir, 'companion.db'));
  });

  after(() => {
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  test('blame / vent 事件显示为「指责」「倾诉」', () => {
    store.setEmotionState('main', {
      pleasure: 46,
      arousal: 52,
      dominance: 48,
      energy: 44,
      updatedAt: NOW - MINUTE,
    });
    store.appendEmotionEvent('main', {
      at: NOW - 2 * MINUTE,
      type: 'blame',
      deltas: { pleasure: -7, arousal: 2, dominance: 0, energy: -1 },
    });
    store.appendEmotionEvent('main', {
      at: NOW - MINUTE,
      type: 'vent',
      deltas: { pleasure: -2, arousal: 1, dominance: 0, energy: 0 },
    });

    const { reply } = handleCommand({
      text: '/状态',
      store,
      now: NOW,
      emotion: { enabled: true },
    });

    assert.match(reply, /情绪：/u);
    assert.match(reply, /最近：/u);
    assert.match(reply, /指责/u);
    assert.match(reply, /倾诉/u);
    // 未登记的旧类型不应把整行吞掉；两个标签都在同一行里。
    assert.match(reply, /指责 .*倾诉|倾诉 .*指责/u);
  });
});
