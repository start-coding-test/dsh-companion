/**
 * V6-L1 / V6-L3：/状态 路由来源标注与 llm 发现失败 warn 去重。
 *
 * 真机反馈：
 *   - 自动选取的巩固路由在 /状态 里仍标「（运行时）」，与真实来源不符；
 *   - provider/model 发现失败只有 debug 日志，web 宿主只显示 info+，看不到；
 *     但调度每 5 分钟重试一次解析，直接升 warn 会刷屏。
 *
 * 覆盖：
 *   1. /状态 三态文案：配置 →「（配置）」、自动选取 →「（自动选取）」、
 *      宿主注入 →「（宿主注入）」；「无可用模型」不变；
 *   2. listProviders 抛错只 warn 一次，连续解析不重复，发现成功后再次失败再 warn 一次；
 *   3. 某 provider 的 listModels 抛错只 warn 一次，同上复位语义；
 *   4. 发现失败不影响 /状态 的「巩固：无可用模型」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { strictCtx } from './helpers/strict-ctx.js';

import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const PROVIDER_WARN = '[dsh-companion] llm provider discovery failed';
const MODEL_WARN = '[dsh-companion] llm model discovery failed';

function makeCtx(now = TEST_NOW) {
  const ctx = new FakeCtx({ now });
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

function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition;
}

function statusText(ctx) {
  return commandOf(ctx, 'status').handler({ rawInput: '' }).text;
}

/** 同一 title 的 warn 日志条数。 */
function warnsAbout(ctx, message) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && entry.message === message);
}

function fakeLlm({ providers, models }) {
  return {
    listProviders: providers,
    listModels: models,
    async *stream() {
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
}

test('V6-L1：/状态 巩固路由三态标注（配置/自动选取/宿主注入）', async (t) => {
  // 配置：显式 consolidation.model。
  const configured = makeTempStore();
  const configuredCtx = makeCtx();
  configuredCtx.llm = fakeLlm({
    providers: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  });
  const configuredHandle = apply(configuredCtx, {
    dbPath: configured.dbPath,
    consolidation: { model: { provider: 'magpie', model: 'main-model' } },
  });
  t.after(() => {
    configuredHandle.dispose();
    configured.cleanup();
  });
  assert.match(statusText(configuredCtx), /巩固：magpie\/main-model（配置）/u);

  // 自动选取：provider/model 都来自运行时发现。
  const discovered = makeTempStore();
  const discoveredCtx = makeCtx();
  discoveredCtx.llm = fakeLlm({
    providers: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  });
  const discoveredHandle = apply(discoveredCtx, { dbPath: discovered.dbPath });
  t.after(() => {
    discoveredHandle.dispose();
    discovered.cleanup();
  });
  await settle(30);
  assert.match(
    statusText(discoveredCtx),
    /巩固：deepseek-official\/deepseek-chat（自动选取）/u,
    'runtime 路由必须标「自动选取」而不是「运行时」',
  );

  // 宿主注入：ctx.companion.consolidationLlm。
  const hook = makeTempStore();
  const hookCtx = makeCtx();
  const hookHandle = apply(
    hookCtx,
    { dbPath: hook.dbPath },
    { companion: { consolidationLlm: async () => ({ episodes: [] }) } },
  );
  t.after(() => {
    hookHandle.dispose();
    hook.cleanup();
  });
  assert.match(statusText(hookCtx), /巩固：宿主注入模型（宿主注入）/u);
});

test('V6-L3：listProviders 抛错只 warn 一次，发现成功后再次失败可再 warn', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  let failing = true;
  ctx.llm = fakeLlm({
    providers: () => {
      if (failing) throw new Error('providers down');
      return [];
    },
    models: () => [],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });
  await settle(30);

  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1, '首次 provider 发现失败只 warn 一次');
  assert.match(statusText(ctx), /巩固：无可用模型/u);

  // 连续两次解析（间隔超过 60s 的探测窗口）不得重复刷屏。
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  statusText(ctx);
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1, '连续两次发现失败不得重复 warn');

  // provider 发现恢复（即便仍没有模型）：去重键清空。
  failing = false;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1);

  // 再次失败：允许重新告警一次。
  failing = true;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  const warns = warnsAbout(ctx, PROVIDER_WARN);
  assert.equal(warns.length, 2, '成功发现后再次失败应重新 warn 一次');
  assert.equal(warns[1].meta.reason, 'providers');
});

test('V6-L3：某 provider 的 listModels 抛错只 warn 一次，成功后再次失败可再 warn', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  let failing = true;
  ctx.llm = fakeLlm({
    providers: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: () => {
      if (failing) throw new Error('models down');
      return [];
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });
  await settle(30);

  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 1, '首次模型发现失败只 warn 一次');
  assert.equal(warnsAbout(ctx, MODEL_WARN)[0].meta.provider, 'deepseek-official');
  assert.equal(warnsAbout(ctx, MODEL_WARN)[0].meta.reason, 'models:deepseek-official');
  assert.match(statusText(ctx), /巩固：无可用模型/u);

  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  statusText(ctx);
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 1, '连续两次模型发现失败不得重复 warn');

  // 该 provider 的模型发现恢复（空列表也算恢复）：去重键清空。
  failing = false;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 1);

  failing = true;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 2, '成功发现后再次失败应重新 warn 一次');
});
