/**
 * worker token 预算与结局判定测试（D-1 / N-M4 / W1）。
 *
 * 覆盖：60K/80K 边界、wrap_up 只迁移一次、stop 终态不回退、非法 token、
 * 阈值乱序的 RangeError、收尾提示字数/数字/稳定性、四种结局与优先级、
 * 回执合并不改入参且保留额外字段。
 *
 * 全部为纯函数测试：不读时钟、不读 TZ，三时区结果一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKER_STOP_TOKENS,
  WORKER_WARN_TOKENS,
  classifyWorkerOutcome,
  mergeReceiptStatus,
  nextStage,
  wrapUpPrompt,
} from '../src/task/limits.js';

test('阈值常量：软线 60000、硬线 80000', () => {
  assert.equal(WORKER_WARN_TOKENS, 60_000);
  assert.equal(WORKER_STOP_TOKENS, 80_000);
  assert.ok(WORKER_WARN_TOKENS < WORKER_STOP_TOKENS);
});

test('nextStage：59999 / 60000 / 79999 / 80000 四个边界', () => {
  assert.deepEqual(
    nextStage('run', 59_999),
    { stage: 'run', changed: false, reason: null },
    '未到软线保持 run',
  );
  assert.deepEqual(
    nextStage('run', 60_000),
    { stage: 'wrap_up', changed: true, reason: 'warn_tokens' },
    '到软线注入收尾提示',
  );
  assert.deepEqual(
    nextStage('run', 79_999),
    { stage: 'wrap_up', changed: true, reason: 'warn_tokens' },
    '软硬线之间仍是 wrap_up',
  );
  assert.deepEqual(
    nextStage('run', 80_000),
    { stage: 'stop', changed: true, reason: 'stop_tokens' },
    '到硬线结束',
  );
});

test('nextStage：wrap_up 只迁移一次，且不会退回 run', () => {
  const first = nextStage('run', 60_000);
  assert.equal(first.stage, 'wrap_up');
  assert.equal(first.changed, true);

  // 同一阶段内继续涨 token：不再算迁移。
  assert.deepEqual(
    nextStage(first.stage, 61_000),
    { stage: 'wrap_up', changed: false, reason: null },
  );
  // 预算回落也不回 run（避免状态机在 60K 附近反复横跳）。
  assert.deepEqual(
    nextStage('wrap_up', 0),
    { stage: 'wrap_up', changed: false, reason: null },
  );
  // 但 wrap_up 仍可被硬线推进到 stop。
  assert.deepEqual(
    nextStage('wrap_up', 80_000),
    { stage: 'stop', changed: true, reason: 'stop_tokens' },
  );
});

test('nextStage：stop 是终态，任何 token 都不回退', () => {
  for (const tokens of [0, 59_999, 60_000, 79_999, 80_000, 1_000_000]) {
    assert.deepEqual(
      nextStage('stop', tokens),
      { stage: 'stop', changed: false, reason: null },
      `token=${tokens} 时 stop 不变`,
    );
  }
});

test('nextStage：非法 tokens 按 0 处理', () => {
  for (const tokens of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    -80_000,
    '60000',
    null,
    undefined,
    {},
    [],
  ]) {
    assert.deepEqual(
      nextStage('run', tokens),
      { stage: 'run', changed: false, reason: null },
      `tokens=${String(tokens)} 按 0`,
    );
  }
});

test('nextStage：支持自定义阈值，乱序抛 RangeError', () => {
  const options = { warnAt: 10, stopAt: 20 };
  assert.equal(nextStage('run', 9, options).stage, 'run');
  assert.equal(nextStage('run', 10, options).stage, 'wrap_up');
  assert.equal(nextStage('run', 19, options).stage, 'wrap_up');
  assert.equal(nextStage('run', 20, options).stage, 'stop');

  // 相等或倒序都必须拒绝：状态机会失去 stop 或一进来就 stop。
  assert.throws(() => nextStage('run', 0, { warnAt: 100, stopAt: 100 }), RangeError);
  assert.throws(() => nextStage('run', 0, { warnAt: 200, stopAt: 100 }), RangeError);
});

test('nextStage：非法阶段/阈值类型抛 TypeError', () => {
  assert.throws(() => nextStage('done', 0), TypeError);
  assert.throws(() => nextStage('', 0), TypeError);
  assert.throws(() => nextStage('run', 0, { warnAt: -1 }), TypeError);
  assert.throws(() => nextStage('run', 0, { stopAt: Number.NaN }), TypeError);
});

test('wrapUpPrompt：≤200 字、整数余额、两次调用稳定', () => {
  const prompt = wrapUpPrompt(12_345);
  assert.ok(Array.from(prompt).length <= 200, '收尾提示不超过 200 字');
  assert.ok(Array.from(prompt).length > 0);
  assert.ok(prompt.includes('剩余预算约 12345 tokens'), '写明剩余整数预算');
  assert.match(prompt, /停止开启新话题/u);
  assert.match(prompt, /新工具链/u);
  assert.match(prompt, /已完成、未完成、下一步/u);
  assert.match(prompt, /partial/u);
  assert.equal(wrapUpPrompt(12_345), prompt, '同一输入结果稳定');

  // 大数也不能撑破字数上限。
  assert.ok(Array.from(wrapUpPrompt(999_999_999)).length <= 200);
});

test('wrapUpPrompt：非数/负数/小数归一化为非负整数', () => {
  const cases = [
    [1234.9, 1234],
    [1, 1],
    [0, 0],
    [-5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ['60000', 0],
    [null, 0],
    [undefined, 0],
  ];
  for (const [input, expected] of cases) {
    const prompt = wrapUpPrompt(input);
    assert.ok(
      prompt.includes(`剩余预算约 ${expected} tokens`),
      `input=${String(input)} 应显示 ${expected}`,
    );
  }
});

test('classifyWorkerOutcome：completed / timeout / token_limit / cancelled 四种结局', () => {
  assert.deepEqual(
    classifyWorkerOutcome({}),
    { status: 'completed', reason: null },
    '正常完成',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ timedOut: true }),
    { status: 'partial', reason: 'timeout' },
    '硬超时截断可区分',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ hitStopTokens: true }),
    { status: 'partial', reason: 'token_limit' },
    'token 硬线命中',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ stage: 'stop' }),
    { status: 'partial', reason: 'token_limit' },
    '进入 stop 阶段也算 token 截断',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ cancelled: true }),
    { status: 'cancelled', reason: 'cancelled' },
  );
  assert.deepEqual(
    classifyWorkerOutcome({ stage: 'wrap_up' }),
    { status: 'completed', reason: null },
    '只到软线但正常结束仍算完成',
  );
});

test('classifyWorkerOutcome：优先级 cancelled > token_limit > timeout > completed', () => {
  assert.deepEqual(
    classifyWorkerOutcome({
      cancelled: true, timedOut: true, stage: 'stop', hitStopTokens: true,
    }),
    { status: 'cancelled', reason: 'cancelled' },
    '取消压过一切',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ timedOut: true, stage: 'stop', hitStopTokens: true }),
    { status: 'partial', reason: 'token_limit' },
    'token 截断压过超时',
  );
  assert.deepEqual(
    classifyWorkerOutcome({ timedOut: true, stage: 'wrap_up' }),
    { status: 'partial', reason: 'timeout' },
    '软线不改变超时判定',
  );
});

test('mergeReceiptStatus：返回新对象、不改入参、保留额外字段', () => {
  const receipt = Object.freeze({
    taskId: 'task-1',
    summary: '周报已生成',
    status: 'ok',
    reason: 'old_reason',
    durationMs: 1200,
    artifacts: ['report.md'],
    extra: { nested: true },
  });
  const merged = mergeReceiptStatus(receipt, { status: 'partial', reason: 'token_limit' });

  assert.notEqual(merged, receipt, '必须返回新对象');
  assert.deepEqual(merged, {
    taskId: 'task-1',
    summary: '周报已生成',
    status: 'partial',
    reason: 'token_limit',
    durationMs: 1200,
    artifacts: ['report.md'],
    extra: { nested: true },
  });
  // 入参保持冻结时的原值。
  assert.equal(receipt.status, 'ok');
  assert.equal(receipt.reason, 'old_reason');
});

test('mergeReceiptStatus：completed 清空 reason，partial 缺省 reason 为 null', () => {
  const merged = mergeReceiptStatus(
    { taskId: 'task-2', status: 'partial', reason: 'timeout' },
    { status: 'completed', reason: 'timeout' },
  );
  assert.deepEqual(merged, { taskId: 'task-2', status: 'completed', reason: null });

  const draft = { taskId: 'task-3' };
  const partial = mergeReceiptStatus(draft, { status: 'partial' });
  assert.deepEqual(partial, { taskId: 'task-3', status: 'partial', reason: null });
  assert.deepEqual(draft, { taskId: 'task-3' }, '草稿不被改写');
});
