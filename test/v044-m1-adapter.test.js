/**
 * v0.4.4 / V3-M1：已声明 inject 的服务走属性访问，未声明的继续 ctx.get()；
 * 并在宿主 `dispose` 事件上兜底回收注册。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply as applyCordis } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';

const DECLARED = new Set(['systemPrompt', 'timer', 'commands', 'tools']);

/** 注册表：register 返回「从列表里摘掉自己」的 disposer，便于数注册数。 */
function makeRegistry() {
  return {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        const index = this.registrations.indexOf(definition);
        if (index >= 0) this.registrations.splice(index, 1);
      };
    },
  };
}

function makeCtx() {
  const ctx = new FakeCtx({ now: Date.UTC(2026, 10, 5, 9, 0, 0) });
  ctx.commands = makeRegistry();
  ctx.tools = makeRegistry();
  return ctx;
}

test('已 inject 的四个服务走属性访问，不被 ctx.get() 读取', () => {
  const ctx = makeCtx();
  const original = ctx.get.bind(ctx);
  const asked = [];
  ctx.get = (name) => {
    asked.push(name);
    if (DECLARED.has(name)) return undefined; // 只暴露在属性上
    return original(name);
  };

  const platform = createAdapter(ctx);
  assert.equal(platform.capabilities.systemPrompt, true);
  assert.equal(platform.capabilities.timer, true);
  assert.equal(platform.capabilities.commands, true);
  assert.equal(platform.capabilities.tools, true);

  platform.section({ name: 'persona', order: 1, text: 'x' });
  platform.registerCommand({
    definitionId: 'dsh-companion/command-test',
    name: 'status',
    description: '测试命令',
    handler: () => {},
  });
  platform.registerTool({
    name: 'memory_search',
    description: '测试工具',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => 'ok' },
    execute: () => ({}),
  });
  const disposer = platform.every(1000, () => {});
  assert.equal(typeof disposer, 'function');

  assert.deepEqual(asked.filter((name) => DECLARED.has(name)), [], '四个声明服务不应再经过 get()');
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.commands.registrations.length, 1);
  assert.equal(ctx.tools.registrations.length, 1);
  assert.equal(ctx.timers.length, 1);
});

test('strictCtx（未声明即抛）不再阻断四个服务的读取', () => {
  const ctx = makeCtx();
  const strict = strictCtx(ctx);
  const platform = createAdapter(strict);

  assert.equal(platform.capabilities.systemPrompt, true);
  assert.equal(platform.capabilities.timer, true);
  assert.equal(platform.capabilities.commands, true);
  assert.equal(platform.capabilities.tools, true);

  assert.equal(typeof platform.section({ name: 'persona', order: 1, text: 'x' }), 'function');
  assert.equal(typeof platform.every(1000, () => {}), 'function');
  assert.equal(typeof platform.registerCommand({
    definitionId: 'dsh-companion/command-test',
    name: 'status',
    description: '测试命令',
    handler: () => {},
  }), 'function');
  assert.equal(typeof platform.registerTool({
    name: 'memory_search',
    description: '测试工具',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => 'ok' },
    execute: () => ({}),
  }), 'function');
});

test('未声明的服务仍走 ctx.get()（缺失时能力为 false，不抛错）', () => {
  const ctx = makeCtx();
  const asked = [];
  const original = ctx.get.bind(ctx);
  ctx.get = (name) => {
    asked.push(name);
    return original(name);
  };
  const platform = createAdapter(ctx);
  // compaction / workspaceRegistry / tokenMeter 都没在 inject 里，必须仍靠 get()。
  assert.equal(platform.capabilities.compaction, true);
  assert.ok(asked.includes('compaction'));

  const bare = new FakeCtx({ missing: ['compaction', 'tokenMeter', 'workspaceRegistry'] });
  bare.commands = makeRegistry();
  bare.tools = makeRegistry();
  const minimal = createAdapter(bare);
  assert.equal(minimal.capabilities.compaction, false);
  assert.equal(minimal.capabilities.tokenMeter, false);
  assert.equal(minimal.capabilities.archive, false);
});

test('apply → ctx dispose 事件 → apply：注册数不累加', async () => {
  const ctx = makeCtx();
  const first = applyCordis(ctx, { dbPath: ':memory:' });
  const commandCount = ctx.commands.registrations.length;
  const toolCount = ctx.tools.registrations.length;
  const sectionCount = ctx.sections.length;
  const listenerCount = (ctx.listeners.get('agent/pre-step') ?? []).length;
  assert.ok(commandCount > 0 && toolCount > 0 && sectionCount > 0);

  // 宿主直接销毁 context（没有调用 apply 返回的 handle.dispose）。
  await ctx.dispatch('dispose', {});

  assert.equal(ctx.commands.registrations.length, 0, 'commands 应被回收');
  assert.equal(ctx.tools.registrations.length, 0, 'tools 应被回收');
  assert.equal(ctx.sections.filter((item) => !item.disposed).length, 0, 'sections 应被回收');
  assert.equal(
    (ctx.listeners.get('agent/pre-step') ?? []).filter((entry) => !entry.disposed).length,
    0,
    'pre-step 监听器应被回收',
  );

  const second = applyCordis(ctx, { dbPath: ':memory:' });
  assert.notEqual(second, first, 'dispose 后应允许重新安装');
  assert.equal(ctx.commands.registrations.length, commandCount, '重装后注册数回到一份');
  assert.equal(ctx.tools.registrations.length, toolCount);
  assert.equal(ctx.sections.filter((item) => !item.disposed).length, sectionCount);

  second.dispose();
  assert.equal(ctx.commands.registrations.length, 0);
  assert.equal(ctx.tools.registrations.length, 0);
});

test('apply 幂等：未 dispose 时重复 apply 复用 handle，注册不翻倍', () => {
  const ctx = makeCtx();
  const first = applyCordis(ctx, { dbPath: ':memory:' });
  const commandCount = ctx.commands.registrations.length;
  const second = applyCordis(ctx, { dbPath: ':memory:' });
  assert.equal(second, first);
  assert.equal(ctx.commands.registrations.length, commandCount);
  first.dispose();
});
