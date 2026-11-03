import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

function status(store, budget) {
  return handleCommand({ text: '/状态', store, now: NOW_MS, budget });
}

test('/状态：向量关闭时显示「向量：关」', () => {
  const store = Store.open(':memory:');
  try {
    const reply = status(store, { vector: { enabled: false, dim: 256, lastHits: 0 } }).reply;
    assert.match(reply, /向量：关/);
  } finally {
    store.close();
  }
});

test('/状态：向量开启时显示维度与最近命中数', () => {
  const store = Store.open(':memory:');
  try {
    const reply = status(store, {
      vector: { enabled: true, dim: 64, lastHits: 3 },
    }).reply;
    assert.match(reply, /向量：开·dim 64·最近命中 3/);
  } finally {
    store.close();
  }
});

test('/状态：未传 budget 时按关闭展示', () => {
  const store = Store.open(':memory:');
  try {
    const reply = status(store, undefined).reply;
    assert.match(reply, /向量：关/);
  } finally {
    store.close();
  }
});
