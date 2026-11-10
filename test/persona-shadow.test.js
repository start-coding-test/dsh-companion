/**
 * P2（v0.4.13）：遮蔽宿主默认人设。
 *
 * 覆盖：配置三态与归一化、off 不注册 assemble 监听、rewrite/takeover 的
 * 纯函数语义（不原地改、深比较保留其它段）、handler 防御（异常/形状异常/
 * 子代理跳过）、以及 /状态 三态行。全部离线，不写用户 ~/.dsh。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { ConfigError, DEFAULTS, normalizeConfig } from '../src/config.js';
import { handleCommand } from '../src/runtime/commands.js';
import {
  DEPLOYMENT_PREFIX_SECTION,
  DEPLOYMENT_SUFFIX_SECTION,
  applyDeploymentShadow,
  createAssembleHandler,
  normalizeShadowMode,
} from '../src/persona/shadow.js';
import { TEST_NOW, makeTempStore } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** @param {{now?: number}} [options] */
function makePluginCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now, strict: true });
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

/**
 * 起一个真实 apply（临时库），返回 ctx 与保持句柄。
 * 用 t.after 先 dispose 再删目录，避免 Windows 上删打开中的 sqlite 失败。
 * @param {import('node:test').TestContext} t
 * @param {object} [persona]
 */
function startPlugin(t, persona) {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const config = { dbPath: temp.dbPath };
  if (persona !== undefined) config.persona = persona;
  const handle = apply(ctx, config);
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });
  return { ctx, temp };
}

/**
 * 写一张最小人格卡；chatIdentity 是模板，应由 renderTemplate 渲染。
 * @param {import('node:test').TestContext} t
 */
function writeCard(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-shadow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'card.json');
  writeFileSync(path, JSON.stringify({
    name: '测测',
    address: '主人',
    tone: { style: '简洁', warmth: '温和', structure: '先结论' },
    ...extra,
  }), 'utf8');
  return path;
}

/** @param {FakeCtx} ctx */
function integrateListener(ctx) {
  const bucket = ctx.listeners.get('system-prompt/assemble') ?? [];
  assert.equal(bucket.length, 1, '应只注册一个 assemble 监听器');
  assert.equal(bucket[0].disposed, false);
  return bucket[0].listener;
}

/** @param {FakeCtx} ctx */
function statusTextOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  const result = registration.handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  return result.text;
}

/** @param {FakeCtx} ctx @param {string} line */
function assertStatusLine(ctx, line) {
  const lines = statusTextOf(ctx).split('\n');
  assert.ok(lines.includes(line), `缺少「${line}」，实际：\n${lines.join('\n')}`);
}

/** 主会话 agent：header 只有 version/id/isSeeded。 */
function mainAgent(id = 'session-main') {
  return { id, session: { id, header: { version: 4, id, isSeeded: false } } };
}

/** 子代理 agent：header 带 origin/parentSession/delegationDepth。 */
function subAgent(id = 'session-sub') {
  return {
    id,
    session: {
      id,
      header: {
        version: 4,
        id,
        isSeeded: true,
        origin: 'subagent',
        parentSession: 'session-main',
        delegationDepth: 1,
      },
    },
  };
}

/** 一次 agent-scope 装配；next 返回传入 assembly（与真实 waterfall 末端一致）。 */
function assembleContext(agent) {
  return { agent, scope: agent, modelSelection: { provider: 'p', model: 'm' }, toolSet: {} };
}

function sectionsFixture() {
  return [
    { name: 'harness:identity', text: 'HOST' },
    { name: DEPLOYMENT_PREFIX_SECTION, text: 'You are a coding agent.', order: 0 },
    { name: 'tool:read', text: 'READ', order: 100 },
    { name: DEPLOYMENT_SUFFIX_SECTION, text: '', order: 10200 },
  ];
}

// ------------------------------------------------------------------ 配置

test('persona 默认 shadowDeployment=off；DEFAULTS 仍 16 键且 persona 非枚举', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.persona.shadowDeployment, 'off');
  assert.equal(cfg.persona.cardPath, null);
  assert.equal(Object.keys(DEFAULTS).length, 16);
  assert.equal(Object.prototype.propertyIsEnumerable.call(DEFAULTS, 'persona'), false);
});

test('shadowDeployment 归一化：true→rewrite，false→off，三种字符串原样', () => {
  assert.equal(normalizeShadowMode(undefined), 'off');
  assert.equal(normalizeShadowMode(false), 'off');
  assert.equal(normalizeShadowMode(true), 'rewrite');
  for (const mode of ['off', 'rewrite', 'takeover']) {
    assert.equal(normalizeShadowMode(mode), mode);
    assert.equal(normalizeConfig({ persona: { shadowDeployment: mode } }).persona.shadowDeployment, mode);
  }
  assert.equal(normalizeConfig({ persona: { shadowDeployment: true } }).persona.shadowDeployment, 'rewrite');
  assert.equal(normalizeConfig({ persona: { shadowDeployment: false } }).persona.shadowDeployment, 'off');
});

test('shadowDeployment 非法值抛 ConfigError(persona.shadowDeployment)', () => {
  for (const bad of ['on', 'REWRITE', 1, 0, {}, [], '']) {
    assert.throws(
      () => normalizeConfig({ persona: { shadowDeployment: bad } }),
      (error) => error instanceof ConfigError && error.field === 'persona.shadowDeployment',
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

// ------------------------------------------------------------------ off

test('off：完全不注册 system-prompt/assemble 监听，/状态 显示宿主默认', (t) => {
  const { ctx } = startPlugin(t, { shadowDeployment: 'off' });
  assert.equal(ctx.listeners.has('system-prompt/assemble'), false);
  const calls = ctx.callsOf('on').filter((call) => call.args[0] === 'system-prompt/assemble');
  assert.equal(calls.length, 0);
  assertStatusLine(ctx, '部署人设：宿主默认');
});

test('off 是默认值：不传 persona 也不注册 assemble 监听', (t) => {
  const { ctx } = startPlugin(t);
  assert.equal(ctx.listeners.has('system-prompt/assemble'), false);
});

// ------------------------------------------------------- rewrite / takeover 纯函数

test('rewrite：只换 prefix.text 并标记 interpolate:false，位置与其它段引用保留，输入数组未被改', () => {
  const sections = sectionsFixture();
  const snapshot = structuredClone(sections);
  const result = applyDeploymentShadow(sections, { mode: 'rewrite', personaText: 'CARD IDENTITY' });
  assert.notEqual(result, sections);
  assert.equal(result.length, 4);
  assert.equal(result[1].text, 'CARD IDENTITY');
  // v0.5.1 V50-M2：替换文本来自卡、已降级，必须显式标记不插值（其余字段不变）。
  assert.deepEqual(result[1], { ...snapshot[1], text: 'CARD IDENTITY', interpolate: false });
  assert.equal(result[0], sections[0]);
  assert.equal(result[2], sections[2]);
  assert.equal(result[3], sections[3]);
  assert.deepEqual(sections, snapshot);
});

test('takeover：摘 prefix 与空/纯空白 suffix，其它段顺序保留', () => {
  const sections = sectionsFixture();
  sections[3].text = '  \n\t ';
  const result = applyDeploymentShadow(sections, { mode: 'takeover' });
  assert.deepEqual(result.map((section) => section.name), ['harness:identity', 'tool:read']);
  assert.deepEqual(sections.map((section) => section.name), [
    'harness:identity', DEPLOYMENT_PREFIX_SECTION, 'tool:read', DEPLOYMENT_SUFFIX_SECTION,
  ]);
});

test('takeover：非空 suffix 保留并 warn 一次；非字符串 suffix 保守保留', () => {
  const warned = [];
  const sections = [
    { name: DEPLOYMENT_PREFIX_SECTION, text: 'HOST' },
    { name: DEPLOYMENT_SUFFIX_SECTION, text: 'KEEP ME' },
  ];
  const result = applyDeploymentShadow(sections, {
    mode: 'takeover',
    warn: (message, meta) => warned.push({ message, meta }),
  });
  assert.deepEqual(result, [{ name: DEPLOYMENT_SUFFIX_SECTION, text: 'KEEP ME' }]);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].meta.reason, 'non-empty-suffix');
  assert.equal(warned[0].meta.mode, 'takeover');

  const dynamic = [{ name: DEPLOYMENT_SUFFIX_SECTION, text: () => 'x' }];
  const kept = applyDeploymentShadow(dynamic, { mode: 'takeover' });
  assert.deepEqual(kept, dynamic);
});

test('宿主两段都缺失：warn（含 mode 与两个段名）后原样返回，不阻断装配', () => {
  const warned = [];
  const sections = [{ name: 'tool:read', text: 'R' }];
  const result = applyDeploymentShadow(sections, {
    mode: 'rewrite',
    personaText: 'X',
    warn: (message, meta) => warned.push({ message, meta }),
  });
  assert.equal(result, sections);
  assert.equal(warned.length, 1);
  assert.deepEqual(warned[0].meta.missing, [DEPLOYMENT_PREFIX_SECTION, DEPLOYMENT_SUFFIX_SECTION]);
  assert.equal(warned[0].meta.mode, 'rewrite');
});

test('非数组 sections 原样返回（不发生 map/filter）', () => {
  assert.equal(applyDeploymentShadow(null, { mode: 'rewrite', personaText: 'X' }), null);
  assert.equal(applyDeploymentShadow(undefined, { mode: 'takeover' }), undefined);
});

test('未知模式原样返回，不会误落入 takeover', () => {
  const sections = sectionsFixture();
  assert.equal(applyDeploymentShadow(sections, { mode: 'bogus' }), sections);
  assert.equal(sections[1].name, DEPLOYMENT_PREFIX_SECTION);
});

// ------------------------------------------------------- 接线：rewrite

test('rewrite 接线：prefix 换成渲染后的卡身份，输入数组未被改，/状态 已替换', async (t) => {
  const cardPath = writeCard(t, { chatIdentity: '你是{{char}}，称呼{{user}}。' });
  const { ctx } = startPlugin(t, { cardPath, shadowDeployment: 'rewrite' });
  const listener = integrateListener(ctx);

  const sections = sectionsFixture();
  const snapshot = structuredClone(sections);
  const resolved = { sections, contexts: { a: '1' }, variables: { model: 'm' } };
  const agent = mainAgent();
  const result = await listener(resolved, assembleContext(agent), async () => resolved);

  assert.notEqual(result.sections, sections);
  assert.equal(result.sections[1].text, '你是测测，称呼主人。');
  assert.notEqual(result.sections[1].text, '你是{{char}}，称呼{{user}}。');
  assert.equal(result.contexts, resolved.contexts);
  assert.deepEqual(sections, snapshot);
  assertStatusLine(ctx, '部署人设：已替换（人格卡身份）');
});

// ------------------------------------------------------- 接线：takeover

test('takeover 接线：摘掉 prefix 与空 suffix，非空 suffix 保留并只 warn 一次', async (t) => {
  const { ctx } = startPlugin(t, { shadowDeployment: 'takeover' });
  const listener = integrateListener(ctx);
  const agent = mainAgent();

  const resolved = { sections: sectionsFixture(), contexts: {}, variables: {} };
  const first = await listener(resolved, assembleContext(agent), async () => resolved);
  assert.deepEqual(first.sections.map((section) => section.name), ['harness:identity', 'tool:read']);

  const withSuffix = [{
    name: DEPLOYMENT_PREFIX_SECTION,
    text: 'HOST',
  }, {
    name: DEPLOYMENT_SUFFIX_SECTION,
    text: 'KEEP',
  }];
  const second = await listener(
    { sections: withSuffix },
    assembleContext(agent),
    async () => ({ sections: withSuffix }),
  );
  assert.deepEqual(second.sections.map((section) => section.name), [DEPLOYMENT_SUFFIX_SECTION]);
  const warns = ctx.logs.filter((log) => log.message === '[dsh-companion] non-empty deployment:persona-suffix kept by takeover');
  assert.equal(warns.length, 1, '同一原因只 warn 一次');
  assert.equal(warns[0].meta.reason, 'non-empty-suffix');
  assertStatusLine(ctx, '部署人设：已接管');
});

// ------------------------------------------------------- handler 防御

test('handler：next 抛错继续抛，不吞', async () => {
  const handler = createAssembleHandler({
    mode: 'rewrite',
    personaText: 'X',
    warn: () => assert.fail('next 抛错不应触发 shadow warn'),
  });
  await assert.rejects(
    () => handler({}, assembleContext(mainAgent()), async () => { throw new Error('next-boom'); }),
    /next-boom/,
  );
});

test('handler：转换抛错时返回 next() 原值并只 warn 一次', async () => {
  const warned = [];
  const handler = createAssembleHandler({
    mode: 'rewrite',
    personaText: 'X',
    warn: (message, meta) => warned.push({ message, meta }),
  });
  const badSections = new Proxy([], {
    get() { throw new Error('boom'); },
  });
  const resolved = { sections: badSections };
  const result = await handler({}, assembleContext(mainAgent()), async () => resolved);
  assert.equal(result, resolved);
  assert.equal(warned.length, 1);
  assert.equal(warned[0].meta.reason, 'handler-failed');
  assert.match(warned[0].meta.message, /boom/);
});

test('handler：assembly 形状异常（null / sections 非数组）不抛、原样放行', async () => {
  const handler = createAssembleHandler({ mode: 'takeover', warn: () => {} });
  const agent = mainAgent();
  assert.equal(await handler(null, assembleContext(agent), async () => null), null);
  const shaped = { sections: 'nope' };
  assert.equal(await handler(shaped, assembleContext(agent), async () => shaped), shaped);
});

test('handler：非 agent scope / 缺 agent 时原样放行', async () => {
  const handler = createAssembleHandler({ mode: 'rewrite', personaText: 'X', warn: () => {} });
  const agent = mainAgent();
  const resolved = { sections: sectionsFixture() };
  const globalContext = { scope: { kind: 'global' } };
  assert.equal(await handler(resolved, globalContext, async () => resolved), resolved);
  assert.equal(await handler(resolved, {}, async () => resolved), resolved);
  // scope 与 agent 不是同一引用（例如 scope 被包装）时也放行。
  assert.equal(
    await handler(resolved, { agent, scope: { ...agent } }, async () => resolved),
    resolved,
  );
});

test('handler：子代理不遮蔽，主会话遮蔽', async () => {
  const handler = createAssembleHandler({ mode: 'rewrite', personaText: 'X', warn: () => {} });
  const sections = sectionsFixture();
  const resolved = { sections };

  const subResult = await handler(resolved, assembleContext(subAgent()), async () => resolved);
  assert.equal(subResult, resolved);
  assert.equal(sections[1].text, 'You are a coding agent.');

  const mainResult = await handler(resolved, assembleContext(mainAgent()), async () => resolved);
  assert.notEqual(mainResult, resolved);
  assert.equal(mainResult.sections[1].text, 'X');
});

test('handler：next 只调用一次', async () => {
  const handler = createAssembleHandler({ mode: 'rewrite', personaText: 'X', warn: () => {} });
  let calls = 0;
  const resolved = { sections: sectionsFixture() };
  await handler({}, assembleContext(mainAgent()), async () => {
    calls += 1;
    return resolved;
  });
  assert.equal(calls, 1);
});

// ------------------------------------------------------- 旧调用方

test('旧调用方不传 shadow：/状态 不输出部署人设行', (t) => {
  const temp = makeTempStore();
  t.after(() => temp.cleanup());
  const result = handleCommand({ text: '/状态', store: temp.store, now: TEST_NOW });
  assert.equal(result.handled, true);
  assert.ok(result.reply.includes('状态：'));
  assert.equal(result.reply.split('\n').some((line) => line.startsWith('部署人设：')), false);
});
