/**
 * A1（v0.4.13）：token 账本 —— 纯换算、持久化、/状态 展示。
 *
 * 只测公开面：token-ledger 的纯函数、store 的 v15 记账 API（写库→重开仍在）、
 * handleCommand 的 /状态 行。不读真实时钟、不写用户目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';
import { reportTaskUsage } from '../src/runtime/tools.js';
import {
  dayKeyOf,
  normalizeUsage,
  peakOf,
  summarizeUsage,
  usageRow,
} from '../src/runtime/token-ledger.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 13, 6, 0, 0); // 2026-11-13 14:00 +08

describe('token ledger 纯换算（A1）', () => {
  test('peakOf 按本地 00:30–08:30 判错峰', () => {
    const at = (h, m) => Date.UTC(2026, 10, 13, h - 8, m, 0);
    assert.equal(peakOf(at(9, 0), TZ), 'peak');
    assert.equal(peakOf(at(3, 0), TZ), 'offpeak');
    assert.equal(peakOf(at(8, 29), TZ), 'offpeak');
    assert.equal(peakOf(at(8, 30), TZ), 'peak');
    assert.equal(peakOf(at(0, 30), TZ), 'offpeak');
    assert.equal(peakOf(at(0, 29), TZ), 'peak');
  });

  test('dayKeyOf 按配置时区日界线', () => {
    assert.equal(dayKeyOf(Date.UTC(2026, 10, 13, 15, 30, 0), TZ), '2026-11-13'); // 23:30 +08
    assert.equal(dayKeyOf(Date.UTC(2026, 10, 13, 16, 30, 0), TZ), '2026-11-14'); // 次日 00:30 +08
  });

  test('normalizeUsage 夹取非负整数并回退 totalTokens', () => {
    assert.deepEqual(normalizeUsage({ inputTokens: 12, outputTokens: 3, cacheHitTokens: 4 }), {
      input: 12,
      output: 3,
      cacheHit: 4,
    });
    assert.deepEqual(normalizeUsage({ inputTokens: -1, outputTokens: 2.9 }), { input: 0, output: 2, cacheHit: 0 });
    assert.deepEqual(normalizeUsage({ totalTokens: 30 }), { input: 30, output: 0, cacheHit: 0 });
    assert.deepEqual(normalizeUsage(null), { input: 0, output: 0, cacheHit: 0 });
    // cacheHit 不能超过 input
    assert.deepEqual(normalizeUsage({ inputTokens: 5, cacheHitTokens: 99 }), { input: 5, output: 0, cacheHit: 5 });
  });

  test('usageRow 带 dayKey / peak / scope', () => {
    const row = usageRow({
      at: NOW,
      timeZone: TZ,
      source: 'consolidate',
      scope: 'project:alpha',
      usage: { inputTokens: 100, outputTokens: 20, cacheHitTokens: 40 },
      requestId: 'req_1',
    });
    assert.equal(row.dayKey, '2026-11-13');
    assert.equal(row.peak, 'peak');
    assert.equal(row.source, 'consolidate');
    assert.equal(row.scope, 'project:alpha');
    assert.equal(row.input, 100);
    assert.equal(row.output, 20);
    assert.equal(row.cacheHit, 40);
    assert.equal(row.requestId, 'req_1');
  });

  test('summarizeUsage 折算占比并给中文来源名', () => {
    const summary = summarizeUsage({
      dayKey: '2026-11-13',
      total: { input: 300, output: 100, cacheHit: 50, total: 400 },
      bySource: [
        { source: 'main', total: 300, share: 0.75 },
        { source: 'consolidate', total: 80, share: 0.2 },
        { source: 'appraise', total: 20, share: 0.05 },
      ],
    });
    assert.equal(summary.total, 400);
    assert.equal(summary.cacheHit, 50);
    assert.deepEqual(summary.bySource.map((row) => row.label), ['主会话', '巩固', '判定']);
    assert.equal(summarizeUsage(null).total, 0);
  });
});

describe('token_usage 持久化与 /状态（A1）', () => {
  let dir;
  let store;
  const dbPath = () => join(dir, 'companion.db');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-token-ledger-'));
    store = Store.open(dbPath());
  });

  after(() => {
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  test('写库后聚合按来源分组，重开后仍在', () => {
    const dayKey = dayKeyOf(NOW, TZ);
    store.recordTokenUsage({ at: NOW, dayKey, source: 'main', scope: 'main', input: 600, output: 0 });
    store.recordTokenUsage({ at: NOW + 1000, dayKey, source: 'consolidate', input: 300, output: 20 });
    store.recordTokenUsage({ at: NOW + 2000, dayKey, source: 'appraise', input: 80, output: 0, cacheHit: 40 });

    let aggregate = store.aggregateTokenUsage(dayKey);
    assert.equal(aggregate.total.total, 1000);
    assert.equal(aggregate.bySource.length, 3);
    assert.equal(aggregate.bySource[0].source, 'main');
    assert.equal(aggregate.bySource[0].share, 0.6);

    store.close();
    store = Store.open(dbPath());
    aggregate = store.aggregateTokenUsage(dayKey);
    assert.equal(aggregate.total.total, 1000, '重启后账本不应清零');
    assert.equal(store.sumTokenUsageSince(NOW + 500).total, 400);
  });

  test('/状态 显示今日用量与来源占比（无样本整行省略）', () => {
    const dayKey = dayKeyOf(NOW, TZ);
    const aggregate = store.aggregateTokenUsage(dayKey);
    const summary = summarizeUsage(aggregate);
    const reply = handleCommand({
      text: '/状态',
      store,
      now: NOW,
      timeZone: TZ,
      tokenUsage: summary,
    }).reply;
    assert.match(reply, /今日用量：1000 tokens/u);
    assert.match(reply, /主会话 60%/u);
    assert.match(reply, /巩固 32%/u);

    const without = handleCommand({ text: '/状态', store, now: NOW, timeZone: TZ }).reply;
    assert.doesNotMatch(without, /今日用量/u);
  });
});

test('A1：task_run 结束后按 task 来源入账（reportTaskUsage）', () => {
  const calls = [];
  const recordTokenUsage = (entry) => calls.push(entry);

  assert.equal(reportTaskUsage({ tokensIn: 1234 }, { scope: 'main', recordTokenUsage }), true);
  assert.deepEqual(calls, [{ source: 'task', scope: 'main', usage: { inputTokens: 1234 } }]);

  // 缺 tokensIn / 非正数 / 没给回传函数：一律不记。
  assert.equal(reportTaskUsage({}, { scope: 'main', recordTokenUsage }), false);
  assert.equal(reportTaskUsage({ tokensIn: 0 }, { scope: 'main', recordTokenUsage }), false);
  assert.equal(reportTaskUsage({ tokensIn: 10 }, {}), false);
  assert.equal(calls.length, 1);

  // 未指定 scope 时落到 main。
  reportTaskUsage({ tokensIn: 5 }, { recordTokenUsage });
  assert.equal(calls[1].scope, 'main');
});
