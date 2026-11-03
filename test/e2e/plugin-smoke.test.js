/**
 * 插件接线 smoke（t12 队长硬要求）：
 * apply(ctx) 必须真的注册命令、工具、人格段、检索注入与调度器，
 * 而不是只做配置校验。
 *
 * 只用 FakeCtx + 内存库，不启动真实 DSH、不触网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from '../fakes/ctx.js';
import { apply, name as pluginName } from '../../src/index.js';

const EXPECTED_COMMANDS = ['chat-off', 'chat-on', 'cost', 'memory', 'status', 'threads'];
const EXPECTED_TOOLS = [
  'cost_report',
  'memory_forget',
  'memory_search',
  'memory_update',
  'memory_write',
  'reminder_add',
  'reminder_done',
  'task_run',
  'thread_list',
  'thread_run',
];

/**
 * 给 FakeCtx 补 commands / tools 两个平台服务，并记录注册定义。
 * @returns {FakeCtx & {commands: object, tools: object}}
 */
function makePluginCtx() {
  const ctx = new FakeCtx({ now: Date.now() });
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
  return ctx;
}

test('apply 注册命令、工具、人格段、检索注入与调度器', async () => {
  const ctx = makePluginCtx();
  apply(ctx, { dbPath: ':memory:' });

  assert.equal(pluginName, 'dsh-companion');

  // 命令：4 个 ASCII 名，且带 definitionId。
  assert.deepEqual(
    ctx.commands.registrations.map((definition) => definition.name).sort(),
    EXPECTED_COMMANDS,
  );
  for (const definition of ctx.commands.registrations) {
    assert.match(definition.definitionId, /^dsh-companion\/command-/);
    assert.equal(typeof definition.handler, 'function');
  }

  // 工具：8 个名字 + 平台裸注册契约要求的 output。
  assert.deepEqual(
    ctx.tools.registrations.map((definition) => definition.name).sort(),
    EXPECTED_TOOLS,
  );
  for (const definition of ctx.tools.registrations) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    const rendered = definition.output.render({}, { ok: true });
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /ok/);
  }

  // 人格段与状态板段。
  const sectionNames = ctx.sections.map((entry) => entry.section.name);
  assert.deepEqual(sectionNames, [
    'persona:safety',
    'persona:core',
    'persona:protocol',
    'persona:state_board',
  ]);
  assert.equal(ctx.sections[0].section.order, 80);

  // 检索注入监听器。
  const preStep = ctx.listeners.get('agent/pre-step') ?? [];
  assert.equal(preStep.length, 1);

  // 调度器：一个 30s tick 定时器 + started 日志。
  const timers = ctx.callsOf('interval');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].args[1], 30_000);
  assert.ok(ctx.logs.some((entry) => entry.message === '[dsh-companion] scheduler started'));
});

test('注册的命令与工具真的连到 Store', async () => {
  const ctx = makePluginCtx();
  apply(ctx, { dbPath: ':memory:' });

  const memoryCommand = ctx.commands.registrations.find((definition) => definition.name === 'memory');
  const emptyReply = memoryCommand.handler({ rawInput: '' });
  assert.equal(emptyReply.kind, 'success');
  assert.match(emptyReply.text, /记忆（共 0 条）/);

  const writeTool = ctx.tools.registrations.find((definition) => definition.name === 'memory_write');
  const written = writeTool.execute({ statement: '每周五要交周报。', kind: 'project' });
  assert.equal(written.ok, true);
  assert.ok(written.id);

  const searchTool = ctx.tools.registrations.find((definition) => definition.name === 'memory_search');
  const found = await searchTool.execute({ query: '周报' });
  assert.ok(found.items.some((item) => String(item.id) === String(written.id)));

  // pre-step 把召回拼进本批进入消息。
  const decision = await ctx.dispatch(
    'agent/pre-step',
    { messages: [{ type: 'text', text: '周报' }] },
    { kind: 'enter', messages: [] },
  );
  assert.equal(decision.kind, 'enter');
  assert.ok(decision.messages.some(
    (block) => block.type === 'text' && block.text.includes('[相关记忆]'),
  ));
});
