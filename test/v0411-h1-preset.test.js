/**
 * V10-H1（v0.4.11）：thread_run 的宿主 preset 可配置，未知 preset 不抛异常。
 *
 * 覆盖：
 *   1) 配置 thread.agentPreset：默认 null、trim、空串→null、非法类型抛
 *      ConfigError('thread.agentPreset')、未知子键只告警、不改变 16 键安装面；
 *   2) thread_run：未配置 → createSession 参数不含 agentPreset；配置合法 →
 *      原样传入；宿主报未知 preset → 返回 preset_unknown（保留原错误文本），
 *      不抛异常、不写 threads 行；其它错误照常上抛；
 *   3) FakeCtx 增加宿主 preset 白名单校验（`agentPresets`），模拟真实宿主；
 *   4) /状态 两种显示：线程 preset：宿主默认 / 线程 preset：<name>（配置：…）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { createTools } from '../src/runtime/tools.js';
import { handleCommand } from '../src/runtime/commands.js';
import { Store } from '../src/memory/store.js';
import * as registry from '../src/thread/registry.js';
import { ConfigError, DEFAULTS, normalizeConfig } from '../src/config.js';
import { TEST_NOW } from './e2e/helpers.js';

/** DSH 0.2.1-rc.5 实际提供的 preset（用最小权限的 workspace-write 作合法值）。 */
const HOST_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];

/** @param {object} [overrides] */
function configErrorField(overrides) {
  assert.throws(
    () => normalizeConfig(overrides),
    (error) => error instanceof ConfigError,
  );
  try {
    normalizeConfig(overrides);
  } catch (error) {
    return error.field;
  }
  return null;
}

/** 直接构造 createTools 的假平台，用于单元级验证请求参数与错误归类。 */
function makeToolHarness({ threadAgentPreset, createSession } = {}) {
  const store = Store.open(':memory:');
  const platform = {
    sessions: [],
    prompts: [],
    async createSession(request) {
      this.sessions.push(request);
      if (typeof createSession === 'function') return createSession(request);
      return { sessionId: 'sess-created', agent: { id: 'sess-created' } };
    },
    async prompt(request) {
      this.prompts.push(request);
      return { ok: true };
    },
  };
  const tools = createTools({
    store,
    retrieve: async () => ({ items: [], tokens: 0, usedIds: [], truncated: false }),
    registry,
    platform,
    clock: () => TEST_NOW,
    cwd: '/tmp/dsh-companion-thread',
    threadAgentPreset,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { store, platform, byName };
}

/** 严格 FakeCtx + 注册记录器：从 apply 入口验证真实宿主契约。 */
function makePluginCtx() {
  const ctx = new FakeCtx({ now: TEST_NOW, strict: true, agentPresets: HOST_PRESETS });
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
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return ctx;
}

/** @param {FakeCtx} ctx @param {object} config */
function applyPlugin(ctx, config) {
  return applyCordis(strictCtx(ctx), config, { cwd: '/hooked/cwd', now: () => TEST_NOW });
}

/** @param {FakeCtx} ctx */
function toolOf(ctx, name) {
  return ctx.tools.registrations.find((definition) => definition.name === name);
}

/** @param {FakeCtx} ctx */
function statusOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  return registration.handler({ rawInput: '' }).text;
}

// ---------------------------------------------------------------- 配置

test('V10-H1 配置：thread.agentPreset 默认 null，且不改变 16 键安装面', () => {
  assert.equal(DEFAULTS.thread.agentPreset, null);
  assert.equal(Object.hasOwn(DEFAULTS, 'thread'), true);
  assert.equal(Object.keys(DEFAULTS).includes('thread'), false, 'thread 应是 DEFAULTS 的非枚举键');
  assert.equal(Object.keys(DEFAULTS).length, 16, '安装面仍应保持 16 键');
  assert.equal(normalizeConfig({}).thread.agentPreset, null);
});

test('V10-H1 配置：正常字符串只 trim，null/空串归一为 null', () => {
  assert.equal(
    normalizeConfig({ thread: { agentPreset: '  workspace-write  ' } }).thread.agentPreset,
    'workspace-write',
  );
  assert.equal(normalizeConfig({ thread: { agentPreset: '' } }).thread.agentPreset, null);
  assert.equal(normalizeConfig({ thread: { agentPreset: '   ' } }).thread.agentPreset, null);
  assert.equal(normalizeConfig({ thread: { agentPreset: null } }).thread.agentPreset, null);
});

test('V10-H1 配置：非法类型抛 ConfigError(thread.agentPreset)，未知子键只告警', () => {
  assert.equal(configErrorField({ thread: { agentPreset: 3 } }), 'thread.agentPreset');
  assert.equal(configErrorField({ thread: { agentPreset: ['workspace-write'] } }), 'thread.agentPreset');
  assert.equal(configErrorField({ thread: { agentPreset: true } }), 'thread.agentPreset');
  assert.equal(configErrorField({ thread: 'workspace-write' }), 'thread');

  const normalized = normalizeConfig({ thread: { agentPreset: 'workspace-write', extra: 1 } });
  assert.equal(normalized.thread.agentPreset, 'workspace-write');
  assert.ok(
    normalized.warnings.some((warning) => warning.includes('thread.extra')),
    '未知子键必须产生 warning',
  );
});

// ---------------------------------------------------------- thread_run 单元

test('V10-H1 thread_run：未配置 preset 时 createSession 参数不含 agentPreset', async () => {
  const harness = makeToolHarness();
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '研究',
      goal: '查资料',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(harness.platform.sessions.length, 1);
    assert.equal(
      Object.hasOwn(harness.platform.sessions[0], 'agentPreset'),
      false,
      '未配置时不得传 agentPreset，应走宿主默认 preset',
    );
  } finally {
    harness.store.close();
  }
});

test('V10-H1 thread_run：配置合法 preset 时 createSession 原样携带', async () => {
  const harness = makeToolHarness({ threadAgentPreset: ' workspace-write ' });
  try {
    const result = await harness.byName.thread_run.execute({
      key: 'new',
      name: '研究',
      goal: '查资料',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(harness.platform.sessions[0].agentPreset, 'workspace-write');
  } finally {
    harness.store.close();
  }
});

test('V10-H1 thread_run：宿主报未知 preset 返回 preset_unknown，不抛异常也不写半截线程行', async () => {
  const harness = makeToolHarness({
    threadAgentPreset: 'host-unknown-preset',
    createSession() {
      throw new Error('Unknown agent preset: host-unknown-preset');
    },
  });
  try {
    const result = await harness.byName.thread_run.execute({ key: 'new', name: '未知机关' });
    assert.equal(result.ok, false);
    assert.equal(result.action, 'create');
    assert.equal(result.reason, 'preset_unknown');
    assert.match(result.message, /Unknown agent preset: host-unknown-preset/u, '保留宿主原错误文本');
    assert.equal(harness.store.listThreads().length, 0, 'preset_unknown 不得写 threads 行');
    assert.equal(harness.platform.prompts.length, 0);
  } finally {
    harness.store.close();
  }
});

test('V10-H1 thread_run：未知 preset 的异步拒绝与大小写/措辞变体同样归类', async () => {
  const variants = [
    () => Promise.reject(new Error('unknown agent preset: x')),
    () => Promise.reject(new Error('UNKNOWN AGENT PRESET: x')),
    () => Promise.reject(new Error('Agent preset "x" not found')),
    () => {
      const error = new Error('no such preset');
      error.code = 'UNKNOWN_AGENT_PRESET';
      throw error;
    },
  ];
  for (const createSession of variants) {
    const harness = makeToolHarness({ threadAgentPreset: 'x', createSession });
    try {
      const result = await harness.byName.thread_run.execute({ key: 'new', name: '变体' });
      assert.equal(result.ok, false, String(createSession));
      assert.equal(result.reason, 'preset_unknown', String(createSession));
      assert.equal(typeof result.message, 'string');
    } finally {
      harness.store.close();
    }
  }
});

test('V10-H1 thread_run：非 preset 的 createSession 错误照常上抛', async () => {
  const harness = makeToolHarness({
    threadAgentPreset: 'workspace-write',
    createSession() {
      throw new Error('disk full');
    },
  });
  try {
    await assert.rejects(
      () => harness.byName.thread_run.execute({ key: 'new', name: '磁盘满' }),
      /disk full/u,
    );
    assert.equal(harness.store.listThreads().length, 0);
  } finally {
    harness.store.close();
  }
});

// ------------------------------------------------------- FakeCtx 白名单 + apply

test('V10-H1 FakeCtx：宿主 preset 白名单拒绝未知值（模拟真实宿主）', () => {
  const ctx = new FakeCtx({ now: TEST_NOW, strict: true, agentPresets: HOST_PRESETS });
  assert.throws(
    () => ctx.get('sessionController').create({ cwd: '/x', agentPreset: 'host-unknown-preset' }),
    /Unknown agent preset: host-unknown-preset/u,
  );
  // 未传 preset（宿主默认）始终合法。
  const created = ctx.get('sessionController').create({ cwd: '/x' });
  assert.equal(typeof created.sessionId, 'string');
});

test('V10-H1 apply：未配置时 thread_run 不带 agentPreset，/状态 显示宿主默认', async () => {
  const ctx = makePluginCtx();
  const handle = applyPlugin(ctx, { dbPath: ':memory:' });
  try {
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '默认 preset',
      goal: '验证默认路径',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const request = ctx.callsOf('sessionController.create')[0].args[0];
    assert.equal(Object.hasOwn(request, 'agentPreset'), false);
    assert.match(statusOf(ctx), /^线程 preset：宿主默认$/mu);
  } finally {
    handle.dispose();
  }
});

test('V10-H1 apply：配置合法 preset 时传入，/状态 显示配置来源', async () => {
  const ctx = makePluginCtx();
  const handle = applyPlugin(ctx, { dbPath: ':memory:', thread: { agentPreset: 'workspace-write' } });
  try {
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '配置 preset',
      goal: '验证配置路径',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const request = ctx.callsOf('sessionController.create')[0].args[0];
    assert.equal(request.agentPreset, 'workspace-write');
    assert.match(
      statusOf(ctx),
      /^线程 preset：workspace-write（配置：thread\.agentPreset）$/mu,
    );
  } finally {
    handle.dispose();
  }
});

test('V10-H1 apply：配置宿主不存在的 preset → preset_unknown，不抛异常、不建会话行', async () => {
  const ctx = makePluginCtx();
  const handle = applyPlugin(ctx, {
    dbPath: ':memory:',
    thread: { agentPreset: 'host-unknown-preset' },
  });
  try {
    const result = await toolOf(ctx, 'thread_run').execute({
      key: 'new',
      name: '未知 preset',
      goal: '应当返回 preset_unknown',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'preset_unknown');
    assert.match(result.message, /Unknown agent preset: host-unknown-preset/u);

    assert.equal(ctx.callsOf('sessionController.create').length, 1, '只尝试一次，不重试');
    assert.equal(ctx.callsOf('sessionController.prompt').length, 0);

    const listed = await toolOf(ctx, 'thread_list').execute({});
    assert.deepEqual(listed.items, [], 'preset_unknown 不得写 threads 行');
    // /状态 仍能正常构建（配置值原样展示，便于排障）。
    assert.match(statusOf(ctx), /^线程 preset：host-unknown-preset（配置：thread\.agentPreset）$/mu);
  } finally {
    handle.dispose();
  }
});

// ------------------------------------------------------------- /status 单元

test('V10-H1 /状态：threadAgentPreset 两种显示文案', () => {
  const store = Store.open(':memory:');
  try {
    const defaultReply = handleCommand({ text: '/状态', store, now: TEST_NOW }).reply;
    assert.match(defaultReply, /^线程 preset：宿主默认$/mu);

    const configured = handleCommand({
      text: '/状态',
      store,
      now: TEST_NOW,
      threadAgentPreset: 'workspace-write',
    }).reply;
    assert.match(configured, /^线程 preset：workspace-write（配置：thread\.agentPreset）$/mu);
    assert.doesNotMatch(configured, /^线程 preset：宿主默认$/mu);
  } finally {
    store.close();
  }
});
