/**
 * v0.7.12（V711-M1 / S3）：合并回执的发送记账与重启补投。
 *
 * **非真机证据**：`platform.prompt` 是替身，只记录调用；事件库用 `Store.open(':memory:')`。
 * 真实宿主投递与 rpcId 去重属 50041 云端验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { createProactive, PROACTIVE_EVENT_TABLE } from '../src/runtime/proactive.js';

const NOW = Date.parse('2026-11-05T10:00:00+08:00');

function makeStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function pendings(store) {
  return store.listEvents({ table_name: PROACTIVE_EVENT_TABLE, limit: 500 })
    .map((row) => ({ row, detail: JSON.parse(row.detail_json) }))
    .filter(({ detail }) => detail?.kind === 'proactive_pending');
}

test('V711-M1：同日 3 条回执合并成 1 条送达后，重建不再补投任何一条', async (t) => {
  const store = makeStore(t);
  const prompts = [];
  const platform = {
    async prompt(sessionId, text, options) { prompts.push({ text, options }); },
  };
  const config = normalizeConfig({ proactiveDailyCap: 3 });
  const proactive = createProactive({
    store, config, target: () => 'main', clock: () => NOW, platform,
  });

  for (let i = 1; i <= 3; i += 1) {
    proactive.enqueue({
      kind: 'task_report',
      text: `任务完成 ${i}`,
      dedupeKey: `t-${i}`,
      requestId: `companion-task-receipt:r-${i}`,
      at: NOW + (i - 1) * 1000,
    });
  }
  const flushed = await proactive.flush(NOW + 5000);
  assert.equal(flushed.sent, 1, '3 条回执在合并窗口内应合成 1 条');
  assert.equal(flushed.merged, 2);
  assert.equal(prompts.length, 1);
  for (let i = 1; i <= 3; i += 1) assert.match(prompts[0].text, new RegExp(`任务完成 ${i}`, 'u'));

  // 发送事件必须记住每一份的 dedupeKey。
  const sent = store.listEvents({ table_name: PROACTIVE_EVENT_TABLE, limit: 500 })
    .map((row) => JSON.parse(row.detail_json))
    .filter((detail) => detail?.kind === 'proactive_sent');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].dedupeKeys, ['t-1', 't-2', 't-3']);

  // 同一 store 重建：三条都算已送达，补投 0 条。
  const replayPrompts = [];
  const rebuilt = createProactive({
    store,
    config,
    target: () => 'main',
    clock: () => NOW + 5000,
    platform: { async prompt(sessionId, text) { replayPrompts.push(text); } },
  });
  assert.equal(rebuilt.stats(NOW + 5000).backlog, 0, '重建后不得把已送达的回执重新入队');
  const replayFlush = await rebuilt.flush(NOW + 5000);
  assert.equal(replayFlush.sent, 0);
  assert.equal(replayPrompts.length, 0);

  // 去重窗口也按每一份 key 生效：第 2、3 条在同一窗口内不再重发。
  const dedupePrompts = [];
  const windowed = createProactive({
    store,
    config,
    target: () => 'main',
    clock: () => NOW + 5000,
    platform: { async prompt(sessionId, text) { dedupePrompts.push(text); } },
  });
  for (const key of ['t-1', 't-2', 't-3']) {
    windowed.enqueue({ kind: 'task_report', text: `重发 ${key}`, dedupeKey: key, at: NOW + 5000 });
  }
  const windowFlush = await windowed.flush(NOW + 5000);
  assert.equal(windowFlush.sent, 0, '三个 key 都还在 120 分钟去重窗口内');
  assert.equal(dedupePrompts.length, 0);
});

test('V711-M1：只有第 2 条未送达时只补投那一条', async (t) => {
  const store = makeStore(t);
  for (let i = 1; i <= 3; i += 1) {
    store.appendEvent({
      at: Math.floor((NOW - 5000) / 1000),
      action: 'USED',
      table_name: PROACTIVE_EVENT_TABLE,
      row_id: null,
      actor: 'scheduler',
      reason: 'proactive:pending',
      detail_json: {
        kind: 'proactive_pending',
        msgKind: 'task_report',
        dedupeKey: `t-${i}`,
        text: `任务完成 ${i}`,
      },
    });
  }
  // 1、3 已送达（合并条里的两份 key 都要记），2 没送达。
  store.appendEvent({
    at: Math.floor((NOW - 1000) / 1000),
    action: 'USED',
    table_name: PROACTIVE_EVENT_TABLE,
    row_id: null,
    actor: 'scheduler',
    reason: 'proactive:task_report',
    detail_json: {
      kind: 'proactive_sent',
      msgKind: 'task_report',
      text: '任务完成 1\n\n任务完成 3',
      dedupeKey: 't-1',
      dedupeKeys: ['t-1', 't-3'],
      at: Math.floor((NOW - 1000) / 1000),
    },
  });

  const prompts = [];
  const proactive = createProactive({
    store,
    config: normalizeConfig({}),
    target: () => 'main',
    clock: () => NOW,
    platform: { async prompt(sessionId, text) { prompts.push(text); } },
  });
  assert.equal(proactive.stats(NOW).backlog, 1);
  const flushed = await proactive.flush(NOW);
  assert.equal(flushed.sent, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /任务完成 2/u);
  assert.doesNotMatch(prompts[0], /任务完成 1/u);
  assert.doesNotMatch(prompts[0], /任务完成 3/u);
  assert.equal(proactive.stats(NOW).backlog, 0);
});

test('S3：pending 事件记录原 requestId，补投沿用它让宿主 rpcId 去重兜底', async (t) => {
  const store = makeStore(t);
  const proactive = createProactive({
    store,
    config: normalizeConfig({}),
    target: () => 'main',
    clock: () => NOW,
    platform: { async prompt() {} },
  });
  proactive.enqueue({
    kind: 'task_report',
    text: '未发出的回执',
    dedupeKey: 't-req',
    requestId: 'companion-task-receipt:r-req',
    at: NOW,
  });
  const recorded = pendings(store);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].detail.requestId, 'companion-task-receipt:r-req');

  const calls = [];
  const rebuilt = createProactive({
    store,
    config: normalizeConfig({}),
    target: () => 'main',
    clock: () => NOW,
    platform: {
      async prompt(sessionId, text, options) { calls.push({ text, options }); },
    },
  });
  const flushed = await rebuilt.flush(NOW);
  assert.equal(flushed.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.requestId, 'companion-task-receipt:r-req');
});
