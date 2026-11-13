/** 云端-C11-L2：线程执行槽兜底/超时计数在 /状态 的可观测断言。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { createMetrics } from '../src/runtime/metrics.js';
import { handleCommand } from '../src/runtime/commands.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-slot-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function statusReply(store, metrics) {
  const result = handleCommand({ text: '/状态', store, metrics, now: NOW, timeZone: TZ });
  assert.equal(result.handled, true);
  return result.reply;
}

test('线程槽计数为 0 时不出现片段', () => {
  withStore((store) => {
    const reply = statusReply(store, createMetrics({ clock: () => NOW }));
    assert.equal(reply.includes('线程槽'), false);
  });
});

test('兜底与超时计数出现在 tokens 行', () => {
  withStore((store) => {
    const metrics = createMetrics({ clock: () => NOW });
    metrics.inc('threadSlotFallback', 2);
    metrics.inc('threadSlotTimeout', 1);
    const reply = statusReply(store, metrics);
    assert.match(reply, /线程槽 兜底 2·超时 1/u);
  });
});

test('只有兜底计数时超时显示 0', () => {
  withStore((store) => {
    const metrics = createMetrics({ clock: () => NOW });
    metrics.inc('threadSlotFallback', 3);
    assert.match(statusReply(store, metrics), /线程槽 兜底 3·超时 0/u);
  });
});
