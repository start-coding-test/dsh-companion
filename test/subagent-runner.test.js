/**
 * v0.7.7 阶段 4（SA-B1/SA-B2/SA-B3/SA-B4）测试。
 *
 * 覆盖：
 * - SA-B1：startActivation 规格（provider/delivery/preset/maxDepth/name/label/prompt/
 *   parent/signal/outputSchema）、D3 默认不传 model、allowlist 越界回落、A3 五态映射、
 *   A12 命名、parent 非存活 → 错误回执不崩、D6 并发 2 槽 + 第 3 个排队；
 * - SA-B2：线程续跑走 sendToSubagent（不再 createSession）、childId 持久化、
 *   session_id/child_session_id 双列反查、续跑失败重建；
 * - SA-B3：回执 ≤300 字投进 proactive 队列、新前缀/kind 的三处排除、投递日志落库；
 * - SA-B4：config.subagent 默认空 model + concurrency 2。
 *
 * 全部为 mock/构造数据：宿主接口形状按
 * `D:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-subagent\src\index.ts`
 * （startActivation :267-292、sendMessage :368-375）与
 * `...\dsh-subagent\src\types.ts`（SubagentActivation :49-66、SubagentStartRequest
 * :144-191、StopReasonMap :241-252、SubagentResult :260-286）构造，
 * 非真机证据：未在真机子代理会话回放。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, normalizeConfig, normalizeSubagent } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { createProactive } from '../src/runtime/proactive.js';
import { createTools } from '../src/runtime/tools.js';
import {
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_PRESET,
  SUBAGENT_PROVIDER,
  SUBAGENT_DELIVERY,
  SUBAGENT_MODEL_ALLOWLIST,
  buildSubagentReceipt,
  mapStopReason,
  normalizeSubagentName,
  resolveSubagentModel,
  runSubagentTask,
  taskSubagentName,
  threadSubagentName,
} from '../src/task/subagent-runner.js';
import { createTaskRunner } from '../src/task/run.js';
import { RECEIPT_MAX_CHARS } from '../src/task/receipt.js';
import * as registry from '../src/thread/registry.js';

const NOW_MS = Date.UTC(2026, 10, 20, 9, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** 造一个「存活的主会话 Agent」替身（宿主只要求精确对象同一个引用）。 */
function makeAgent(id = 'agent-main') {
  return { id, sessionId: id };
}

/**
 * 子代理服务的假实现：记录每次 startActivation 的 spec，结果可注入。
 * @param {{result?: object, throws?: Error|null}} [options]
 */
function makeSubagentPlatform(options = {}) {
  const calls = { started: [], sent: [] };
  const platform = {
    calls,
    capabilities: { subagents: true, subagentMessages: true, tools: true },
    log() {},
    async createSession() {
      calls.created = (calls.created ?? 0) + 1;
      throw new Error('createSession should not be used on the subagent path');
    },
    async prompt() {
      calls.prompted = (calls.prompted ?? 0) + 1;
      return { ok: true };
    },
    async startSubagent(spec) {
      calls.started.push(spec);
      if (options.throws instanceof Error) throw options.throws;
      const sessionId = `child-${calls.started.length}`;
      return {
        childId: sessionId,
        name: spec.name ?? `agent-${calls.started.length}`,
        messageId: `msg-${calls.started.length}`,
        result: Promise.resolve(options.result ?? {
          output: [{ type: 'text', text: '已完成' }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      };
    },
    async sendToSubagent(sender, targetId, content, sendOptions) {
      calls.sent.push({ sender, targetId, content, sendOptions });
      if (options.sendThrows instanceof Error) throw options.sendThrows;
      return 'msg-sent';
    },
  };
  return platform;
}

/* ---------------------------------------------------------------- SA-B1 */

test('SA-B1：startActivation 规格（provider/delivery/preset/maxDepth/prompt/parent/signal，v0.7.13 起不传 outputSchema）', async () => {
  const platform = makeSubagentPlatform();
  const parent = makeAgent();
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-1', scope: 'main', prompt: '写周报' },
    parent,
    label: '周报',
    now: () => NOW_MS,
  });

  assert.equal(result.status, 'ok');
  assert.equal(platform.calls.started.length, 1);
  const [spec] = platform.calls.started;
  assert.equal(spec.provider, SUBAGENT_PROVIDER);
  assert.equal(spec.delivery, SUBAGENT_DELIVERY);
  assert.equal(spec.agentPreset, SUBAGENT_PRESET);
  assert.equal(spec.maxDepth, SUBAGENT_MAX_DEPTH);
  assert.equal(spec.parent, parent, 'parent 必须是同一个 Agent 引用（宿主 UNAUTHORIZED 守卫）');
  assert.ok(spec.signal instanceof AbortSignal, 'signal 必须显式传入');
  // R22-H2：提示词尾部必须追加「最后一段用一句话给出结论」，其余正文原样保留。
  assert.equal(spec.prompt.length, 1);
  assert.equal(spec.prompt[0].type, 'text');
  assert.ok(spec.prompt[0].text.startsWith('写周报'), '原 prompt 必须原样保留在前面');
  assert.ok(spec.prompt[0].text.includes('最后一段用一句话给出结论'), 'v0.7.13：必须追加结论要求');
  assert.equal(spec.label, '周报');
  // R22-H2（v0.7.13）：不再声明 outputSchema —— 宿主 `dsh-subagent/src/activation.ts:150-158`
  // 在父方声明 schema 而子代理没交结构化结果时，会把 completed 改写成 error。
  assert.equal(Object.hasOwn(spec, 'outputSchema'), false, 'v0.7.13 起不得再传 outputSchema');
  // D3：默认不传 agentOptions（= 沿用主会话路由）
  assert.equal(Object.hasOwn(spec, 'agentOptions'), false, '默认不得传 agentOptions.model');
});

test('D3：显式配置且命中 allowlist 才经 agentOptions 传 model；越界 warn 后回落', async () => {
  const warnings = [];
  const platform = makeSubagentPlatform();
  const logger = (message, meta) => warnings.push({ message, meta });

  await runSubagentTask({
    platform,
    task: { id: 'task-2', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    model: SUBAGENT_MODEL_ALLOWLIST[0],
    logger,
    now: () => NOW_MS,
  });
  assert.deepEqual(platform.calls.started[0].agentOptions, { model: SUBAGENT_MODEL_ALLOWLIST[0] });

  await runSubagentTask({
    platform,
    task: { id: 'task-3', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    model: 'someone/not-allowed',
    logger,
    now: () => NOW_MS,
  });
  assert.equal(
    Object.hasOwn(platform.calls.started[1], 'agentOptions'),
    false,
    'allowlist 越界必须回落成「不传 model」',
  );
  assert.equal(warnings.length, 1);

  // resolveSubagentModel 是同一套口径的纯函数视图
  assert.equal(resolveSubagentModel(''), null);
  assert.equal(resolveSubagentModel(null), null);
  assert.equal(resolveSubagentModel(SUBAGENT_MODEL_ALLOWLIST[1]), SUBAGENT_MODEL_ALLOWLIST[1]);
  assert.equal(resolveSubagentModel('x/y', { warn: () => {} }), null);
});

test('A3：五态 stopReason 映射到统一状态与固定 reason', () => {
  assert.deepEqual(mapStopReason('completed'), { status: 'ok' });
  assert.deepEqual(mapStopReason('aborted'), { status: 'error', reason: 'aborted' });
  assert.deepEqual(mapStopReason('error'), { status: 'error', reason: 'subagent_error' });
  assert.deepEqual(mapStopReason('max-tokens'), { status: 'partial', reason: 'max_tokens' });
  assert.deepEqual(mapStopReason('refusal'), { status: 'error', reason: 'refusal' });
  assert.deepEqual(mapStopReason('something-new'), {
    status: 'error',
    reason: 'unknown_stop_reason:something-new',
  });
});

test('A3：structured 缺失降级取正文、解析失败回 error、回执 ≤300 字', async () => {
  const platform = makeSubagentPlatform({
    result: {
      output: [{ type: 'text', text: '结论：'.concat('很长的输出'.repeat(80)) }],
      stopReason: 'completed',
    },
  });
  const result = await runSubagentTask({
    platform,
    task: { id: 'task-4', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    now: () => NOW_MS,
  });
  assert.equal(result.status, 'ok');
  assert.equal(typeof result.structured, 'object');
  assert.equal(result.structured, null, 'structured 缺失时显式降级为 null');
  assert.ok(Array.from(result.receipt).length <= RECEIPT_MAX_CHARS);

  // max-tokens → partial
  const partial = await runSubagentTask({
    platform: makeSubagentPlatform({ result: { output: [], stopReason: 'max-tokens' } }),
    task: { id: 'task-5', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    now: () => NOW_MS,
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.reason, 'max_tokens');

  // structured 是坏 JSON → error + structured_parse_failed
  const broken = await runSubagentTask({
    platform: makeSubagentPlatform({
      result: { output: [], structured: '{not json', stopReason: 'completed' },
    }),
    task: { id: 'task-6', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    now: () => NOW_MS,
  });
  assert.equal(broken.status, 'error');
  assert.equal(broken.reason, 'structured_parse_failed');

  // buildSubagentReceipt 兜底截断
  const long = buildSubagentReceipt({ status: 'ok', structured: null, text: '很长的输出'.repeat(100), durationMs: 1 });
  assert.ok(Array.from(long).length <= RECEIPT_MAX_CHARS);
});

test('A12：宿主 name 规则（1-32 小写字母数字连字符、首字符字母、lead 保留）', () => {
  assert.equal(normalizeSubagentName('t-grow'), 't-grow');
  assert.equal(normalizeSubagentName('lead'), null, 'lead 是保留名');
  assert.equal(normalizeSubagentName('1abc'), null, '首字符必须字母');
  assert.equal(normalizeSubagentName('A-UP'), 'a-up', '会先小写化再校验');
  assert.equal(normalizeSubagentName('a_up'), null, '下划线不合法');
  assert.equal(normalizeSubagentName('a'.repeat(33)), null, '超过 32 位');

  // 线程 key 是中文短名：hex 形态稳定、幂等、≤32、不外泄中文
  const name = threadSubagentName('部署');
  assert.match(name, /^t[0-9a-f]+$/u);
  assert.ok(name.length <= 32);
  assert.equal(threadSubagentName('部署'), name, '同 key 必须幂等');
  assert.notEqual(threadSubagentName('预算'), name);

  const taskName = taskSubagentName('task-abc-1');
  assert.match(taskName, /^task-[a-z0-9]+$/u);
  assert.ok(taskName.length <= 32);
  assert.equal(normalizeSubagentName(taskName), taskName);
});

test('SA-B1：parent 非存活（startActivation 抛 UNAUTHORIZED）→ 错误回执，不上抛', async () => {
  const unauthorized = Object.assign(
    new Error('subagent creation requires the exact live parent agent'),
    { code: 'UNAUTHORIZED' },
  );
  const result = await runSubagentTask({
    platform: makeSubagentPlatform({ throws: unauthorized }),
    task: { id: 'task-7', scope: 'main', prompt: '做事' },
    parent: makeAgent(),
    now: () => NOW_MS,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.sessionId, null);
  assert.match(result.error, /UNAUTHORIZED|exact live parent/u);
});

test('D6：并发上限 2 —— 第 3 个排队而不是立即拒绝', async () => {
  const runner = createTaskRunner();
  assert.equal(runner.stats().maxExec, 2);
  assert.equal(runner.tryAcquire(), true);
  assert.equal(runner.tryAcquire(), true);
  assert.equal(runner.tryAcquire(), false, '两个槽位占满后应立即 busy');
  runner.release();
  assert.equal(runner.tryAcquire(), true, '释放一个槽位后又能取到');
  // setMaxExec 只在空闲时生效
  runner.release();
  runner.release();
  assert.equal(runner.setMaxExec(3), true);
  assert.equal(runner.stats().maxExec, 3);
  assert.throws(() => runner.setMaxExec(0), /positive integer/u);
});

/* ---------------------------------------------------------------- SA-B2 */

/** 建一个带子代理能力的工具面（真实 Store + 假 platform）。 */
function makeToolHarness(options = {}) {
  const store = Store.open(':memory:');
  const platform = makeSubagentPlatform(options);
  const tools = createTools({
    store,
    platform,
    registry,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    clock: () => NOW_MS,
    cwd: '/tmp/dsh-companion-subagent',
    subagentModel: options.subagentModel,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, byName };
}

test('SA-B2：新建线程走 startActivation 并把 childId 写成续跑锚', async () => {
  const harness = makeToolHarness();
  try {
    const result = await harness.byName.thread_run.execute(
      { key: 'new', name: '部署', goal: '梳理部署步骤' },
      { agent: makeAgent() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, 'create');
    assert.equal(harness.platform.calls.created ?? 0, 0, '不得再调 createSession');
    const [spec] = harness.platform.calls.started;
    assert.equal(spec.provider, SUBAGENT_PROVIDER);
    assert.equal(spec.delivery, SUBAGENT_DELIVERY);
    assert.equal(spec.agentPreset, SUBAGENT_PRESET);
    assert.equal(spec.maxDepth, 1);
    assert.equal(spec.label, '部署');
    assert.match(spec.name, /^t[0-9a-f]+$/u);

    const thread = harness.store.getThread(result.key);
    assert.equal(thread.child_session_id, result.sessionId);
    assert.equal(thread.session_id, result.sessionId);
    // 双列反查都能命中同一行
    assert.equal(harness.store.getThreadBySessionId(result.sessionId)?.key, result.key);
  } finally {
    harness.store.close();
  }
});

test('SA-B2：有锚的线程续跑走 sendToSubagent，不再 createSession', async () => {
  const harness = makeToolHarness();
  try {
    const created = await harness.byName.thread_run.execute(
      { key: 'new', name: '预算', goal: '查预算' },
      { agent: makeAgent() },
    );
    const startedCount = harness.platform.calls.started.length;

    const reused = await harness.byName.thread_run.execute(
      { key: created.key, goal: '再查一次' },
      { agent: makeAgent() },
    );
    assert.equal(reused.ok, true);
    assert.equal(reused.action, 'reuse');
    assert.equal(reused.rebuilt, undefined, '正常续跑不该重建');
    assert.equal(harness.platform.calls.started.length, startedCount, '续跑不得再派新子代理');
    assert.equal(harness.platform.calls.sent.length, 1);
    const [sent] = harness.platform.calls.sent;
    assert.equal(sent.targetId, created.sessionId);
    // v0.7.20 M1：没显式设过 charter 的线程不注入职责行，续派文本回到 v0.7.18（纯 goal）。
    assert.deepEqual(sent.content, [{ type: 'text', text: '再查一次' }]);
  } finally {
    harness.store.close();
  }
});

test('SA-B2：续跑失败（目标已不可恢复）→ 重建会话并更新锚，回执注明 rebuilt', async () => {
  const harness = makeToolHarness({
    sendThrows: Object.assign(new Error('subagent not found'), { code: 'UNAVAILABLE' }),
  });
  try {
    const created = await harness.byName.thread_run.execute(
      { key: 'new', name: '复盘', goal: '开始' },
      { agent: makeAgent() },
    );
    const rebuilt = await harness.byName.thread_run.execute(
      { key: created.key, goal: '继续' },
      { agent: makeAgent() },
    );
    assert.equal(rebuilt.ok, true);
    assert.equal(rebuilt.action, 'reuse');
    assert.equal(rebuilt.rebuilt, true);
    assert.notEqual(rebuilt.sessionId, created.sessionId, '重建应拿到新的 childId');
    assert.equal(harness.platform.calls.started.length, 2);
    const thread = harness.store.getThread(created.key);
    assert.equal(thread.child_session_id, rebuilt.sessionId, '锚必须更新到新会话');
  } finally {
    harness.store.close();
  }
});

test('SA-B2：没有 exec.agent 时退回旧路径（createSession + prompt）', async () => {
  const harness = makeToolHarness();
  try {
    const platform = harness.platform;
    platform.createSession = async (request) => {
      platform.calls.created = (platform.calls.created ?? 0) + 1;
      return { sessionId: 'sess-legacy', agent: { id: 'sess-legacy' } };
    };
    const result = await harness.byName.thread_run.execute({ key: 'new', name: '旧路', goal: '做事' });
    assert.equal(result.ok, true);
    assert.equal(platform.calls.created, 1);
    assert.equal(result.sessionId, 'sess-legacy');
    assert.equal(harness.store.getThread(result.key).child_session_id, null);
  } finally {
    harness.store.close();
  }
});

/* ---------------------------------------------------------------- SA-B3 */

test('SA-B3：回执经 proactive 队列投回主会话（≤300 字，带 [任务] 前缀）', async () => {
  const store = Store.open(':memory:');
  try {
    const prompts = [];
    const platform = {
      now: () => NOW_MS,
      async prompt(sessionId, text, options) {
        prompts.push({ sessionId, text, options });
        return { ok: true };
      },
      log() {},
    };
    const proactive = createProactive({
      platform,
      store,
      config: { ...DEFAULTS, quietStart: '23:00', quietEnd: '08:00' },
      target: () => 'main-session',
      metrics: { inc() {} },
    });
    // 与 index.js deliverTaskReceipt 同形：enqueue(task_report) + flush
    const receipt = '状态：成功｜结论：周报已生成｜耗时：1.2s';
    const text = `[任务] ${receipt}`;
    const result = proactive.enqueue({
      kind: 'task_report',
      text,
      dedupeKey: 'task-receipt:task-1',
      requestId: 'companion-task-receipt:task-1',
      at: NOW_MS,
    });
    assert.equal(result.duplicate, false);
    // 同一 dedupeKey 在队列中时再入队 → duplicate（不会重复打扰）
    const again = proactive.enqueue({
      kind: 'task_report',
      text,
      dedupeKey: 'task-receipt:task-1',
      requestId: 'companion-task-receipt:task-1',
      at: NOW_MS,
    });
    assert.equal(again.duplicate, true);
    const report = await proactive.flush(NOW_MS);
    assert.equal(report.sent, 1, '回执必须真的投出去');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].text, /\[任务\]/u);
    assert.ok(Array.from(receipt).length <= RECEIPT_MAX_CHARS);
    assert.equal(prompts[0].options.requestId, 'companion-task-receipt:task-1');
    assert.equal(prompts[0].sessionId, 'main-session');

  } finally {
    store.close();
  }
});

test('SA-B3：投递日志落库（时间 / 回执 id / 成功位）', async () => {
  const store = Store.open(':memory:');
  try {
    // 与 index.js recordTaskReceiptDelivery 同形的事件形状
    store.appendEvent({
      at: NOW_SEC,
      action: 'USED',
      actor: 'scheduler',
      table_name: 'threads',
      row_id: 'task-9',
      reason: 'task_receipt_delivered',
      detail_json: {
        kind: 'task_receipt_delivery',
        receiptId: 'task-9',
        taskId: 'task-9',
        status: 'done',
        delivered: true,
        title: '周报',
        sessionId: 'child-1',
        reason: null,
      },
    });
    const rows = store.listEvents({ limit: 10 });
    const row = rows.find((item) => item.reason === 'task_receipt_delivered');
    assert.ok(row, '必须留下可核对的投递日志');
    assert.equal(row.at, NOW_SEC);
    const detail = JSON.parse(row.detail_json);
    assert.equal(detail.receiptId, 'task-9');
    assert.equal(detail.delivered, true);
  } finally {
    store.close();
  }
});

/* ---------------------------------------------------------------- SA-B4 */

test('SA-B4：config.subagent 默认 = 空 model + concurrency 2，且不参与 16 键安装面', () => {
  assert.equal(Object.hasOwn(DEFAULTS, 'subagent'), true);
  assert.equal(Object.keys(DEFAULTS).length, 16, '扩展项必须非枚举');
  assert.deepEqual(DEFAULTS.subagent, { model: '', concurrency: 2 });

  const config = normalizeConfig({});
  assert.equal(config.subagent.model, '');
  assert.equal(config.subagent.concurrency, 2);

  const custom = normalizeConfig({ subagent: { model: SUBAGENT_MODEL_ALLOWLIST[0], concurrency: 3 } });
  assert.equal(custom.subagent.model, SUBAGENT_MODEL_ALLOWLIST[0]);
  assert.equal(custom.subagent.concurrency, 3);

  const warnings = [];
  const withUnknown = normalizeSubagent({ model: ' a/b ', unknownKey: 1 }, warnings);
  assert.equal(withUnknown.model, 'a/b', 'model 只 trim，不在这里判 allowlist');
  assert.equal(warnings.length, 1);

  assert.throws(() => normalizeSubagent({ concurrency: 0 }), /subagent\.concurrency/u);
  assert.throws(() => normalizeSubagent({ concurrency: 9 }), /subagent\.concurrency/u);
  assert.throws(() => normalizeSubagent({ model: 5 }), /subagent\.model/u);
});
