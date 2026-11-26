// ⚠️ 非真机证据
/**
 * v0.7.21 M3：consolidate-dedupe 查重裁决的 token 用量入账（非真机证据）。
 *
 * 判别力（首行）：本用例**只走生产接线**——`apply()` 启动插件 → `registerTools`
 * 把真实 `judgeFactDuplicates` 注入 `memory_write` 的 judge 闭包 → ask 档触发
 * 一次真实查重模型调用 → `judgeFactDuplicates` 自己调 `recordModelUsage` 落
 * `token_usage`；用例从不直接调 `recordModelUsage`，也不手拼 store 调用冒充接线。
 * 因此：
 *   - 把 `src/index.js` 的 `source` 改回 `'consolidate-dedupe'`（不在
 *     `TOKEN_USAGE_SOURCES`/CHECK 枚举里）→ 账本无行且 debug 出现
 *     `token ledger write failed`，本用例红；
 *   - 漏掉 `requestId: 'consolidate-dedupe'` → request_id 区分断言红。
 * 模型只是替身（`ctx.llm.stream`），真实小模型裁决质量属云端验收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { strictCtx } from './helpers/strict-ctx.js';

/** 2026-11-05T09:00:00Z（本地 17:00）：避开 03:00/03:30 的定时任务补扫窗口。 */
const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);

/** 假模型回报的用量：三个计数都非零，确保账本不是「全 0 也算写入」。 */
const MOCK_USAGE = Object.freeze({ inputTokens: 1234, outputTokens: 56, cacheReadTokens: 78 });

test('M3-001（v0.7.21 非真机证据）：真实查重法官的用量以 source=consolidate、request_id=consolidate-dedupe 入账', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v0721-m3-'));
  const dbPath = join(dir, 'companion.db');
  let handle = null;
  let side = null;
  t.after(() => {
    try {
      side?.close();
    } catch {
      // 已关闭时不重复报错。
    }
    try {
      handle?.dispose?.();
    } catch {
      // 卸载失败不应掩盖断言失败。
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上连接仍被占用时留给系统清理。
    }
  });

  const ctx = new FakeCtx({ now: NOW_MS });
  /** 每次真实模型调用的请求；用来证明这次写入来自查重法官，而不是别的来源。 */
  const streams = [];
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider'
      ? [{ id: 'fake-model', name: 'Fake Model' }]
      : []),
    async *stream(request) {
      streams.push(request);
      // judgeFactDuplicates 用 parseDraftJson 解析这段文本。
      yield { type: 'text-delta', text: JSON.stringify({ items: [{ index: 1, verdict: 'same' }] }) };
      // 宿主的用量 chunk：adapter.complete 会回调 request.onUsage。
      yield { type: 'usage', usage: { ...MOCK_USAGE } };
    },
  };
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };

  handle = applyCordis(strictCtx(ctx), {
    dbPath,
    consolidation: { model: { provider: 'fake-provider', model: 'fake-model' } },
  });

  const write = ctx.tools.registrations.find((definition) => definition.name === 'memory_write');
  assert.ok(write, 'memory_write 必须已注册（生产接线）');

  const first = await write.execute({ kind: 'preference', statement: '我每天早上喝咖啡' });
  assert.equal(first.verdict, 'inserted', '首条没有近似事实，直接插入、不应发模型请求');
  assert.equal(streams.length, 0, '首条不得触发查重模型调用');

  // 近义句落进 0.5–0.85 的 ask 档 → memory_write 的 judge 闭包 → 真实 judgeFactDuplicates。
  const second = await write.execute({ kind: 'preference', statement: '我每天早上都喝咖啡' });
  assert.equal(streams.length, 1, 'ask 档必须真的发起一次查重模型调用');
  assert.equal(streams[0].purpose, 'companion-consolidate', '查重与巩固共用同一条模型通道');
  assert.equal(second.duplicateOf, first.id, 'judge=same → 强化首条，不新写');

  // 先卸载插件再旁路打开同一个库，避免 Windows 下的双连接锁。
  handle.dispose();
  handle = null;
  side = Store.open(dbPath);
  const rows = side.db
    .prepare(
      `SELECT source, request_id, scope, input_tokens, output_tokens, cache_hit_tokens
         FROM token_usage
        ORDER BY id`,
    )
    .all();

  assert.equal(rows.length, 1, '一次查重裁决应恰好入账一行 token_usage');
  assert.equal(rows[0].source, 'consolidate', 'source 必须收进既有枚举 consolidate（旧值 consolidate-dedupe 会被 CHECK 拒绝）');
  assert.equal(rows[0].request_id, 'consolidate-dedupe', '用 request_id 区分查重裁决这一路');
  assert.equal(rows[0].scope, null, 'judgeFactDuplicates 拿不到 scope，保持 null');
  assert.equal(rows[0].input_tokens, MOCK_USAGE.inputTokens, 'input 必须与 mock usage 一致');
  assert.equal(rows[0].output_tokens, MOCK_USAGE.outputTokens, 'output 必须与 mock usage 一致');
  assert.equal(rows[0].cache_hit_tokens, MOCK_USAGE.cacheReadTokens, 'cache hit 必须与 mock usage 一致');

  const ledgerFailures = ctx.logs.filter(
    (entry) => String(entry.message).includes('token ledger write failed'),
  );
  assert.deepEqual(ledgerFailures, [], 'debug 不得再出现 token ledger write failed');
});
