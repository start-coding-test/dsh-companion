/**
 * V50-M3：情绪句改走宿主 systemPrompt.context 的行为测试。
 *
 * 覆盖：启用时注册一次（name/order/interpolate）、关闭/缺能力时不注册、
 * provider 的主会话/子代理/未算 scope 返回值、宿主投影去重语义、不再造
 * companion-emotion 消息、runtime-context 快照不参与 lastUserText。
 *
 * 全部使用固定时钟与临时 DSH_HOME，不读真实时间、不写用户目录。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CARD } from '../src/persona/card.js';
import { EMOTION_PROMPT_PREFIX, EMOTION_SOURCE_KIND } from '../src/persona/emotion-wiring.js';
import { apply as applyCordis } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, TEST_NOW } from './e2e/helpers.js';

const BASELINE_50 = Object.freeze({
  pleasure: 50,
  arousal: 50,
  dominance: 50,
  energy: 50,
});

/** @returns {object} */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/** 宿主 RuntimeContextProjection 产出的快照消息形状。 */
function runtimeContextMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'x', text }] },
  };
}

/** @returns {object} */
function turnPayload(session, turnId, messages) {
  return {
    agent: { id: session.id, session },
    messages,
    turn: { id: turnId },
    step: 1,
  };
}

/** @param {number} [now] */
function makePluginCtx(now = TEST_NOW) {
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

/** 把 DSH_HOME 指到临时目录，测试结束恢复，绝不动真实 ~/.dsh。 */
function useTempDshHome(t, dir) {
  const previous = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME')
    ? process.env.DSH_HOME
    : undefined;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
}

/** @param {string} dir @returns {string} */
function writeEnabledCard(dir) {
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = {
    enabled: true,
    baseline: { ...BASELINE_50 },
    halfLifeHours: 6,
  };
  const path = join(dir, 'persona.json');
  writeFileSync(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

/**
 * 起一个临时库 + 临时 DSH_HOME + FakeCtx。enabled=false 时不写人格卡。
 * @param {object} t
 * @param {{enabled?: boolean, timezone?: string}} [options]
 */
function boot(t, options = {}) {
  // 不用 makeTempStore({t})：node:test 的 after 钩子按注册顺序执行，先删目录会
  // 让仍打开的 SQLite 连接 EPERM。这里合并成一个 after，先 dispose 再清理。
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-context-'));
  useTempDshHome(t, home);
  const config = { dbPath: temp.dbPath };
  if (options.timezone) config.timezone = options.timezone;
  if (options.enabled !== false) config.persona = { cardPath: writeEnabledCard(home) };

  const ctx = makePluginCtx();
  const session = ctx.addSession({ id: `session-${randomUUID()}` });
  const handle = applyCordis(strictCtx(ctx), config);
  t.after(() => {
    handle.dispose();
    temp.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  return { temp, home, ctx, session, handle, config };
}

/** @param {FakeCtx} ctx @param {object} payload */
async function dispatchPreStep(ctx, payload) {
  return ctx.dispatch('agent/pre-step', payload, {
    kind: 'enter',
    messages: payload.messages,
  });
}

// ---------------------------------------------------------------- 注册

test('apply：情绪启用时 context 注册一次，name/order/interpolate 正确', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-context-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEnabledCard(home);

  const ctx = makePluginCtx();
  ctx.addSession({ id: 'session-register' });
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    assert.equal(ctx.callsOf('systemPrompt.context').length, 1, '必须只注册一次');
    assert.equal(ctx.contexts.length, 1);
    const entry = ctx.contexts[0].context;
    assert.equal(entry.name, 'companion-emotion');
    assert.equal(entry.order, 320);
    assert.equal(entry.interpolate, false);
    assert.equal(typeof entry.text, 'function');
    assert.ok(entry.order > 210, '必须排在宿主已用的 100-210 之后');
    assert.equal(ctx.contexts[0].disposed, false);

    handle.dispose();
    assert.equal(ctx.contexts[0].disposed, true, 'dispose 时必须注销 context');
  } finally {
    handle.dispose();
  }
});

test('apply：情绪关闭时不注册 context，也不读写情绪表', async (t) => {
  const { temp, ctx, session } = boot(t, { enabled: false });
  assert.equal(ctx.callsOf('systemPrompt.context').length, 0);
  assert.equal(ctx.contexts.length, 0);

  const message = userMessage('你好呀');
  const payload = turnPayload(session, 'turn-disabled', [message]);
  const decision = await dispatchPreStep(ctx, payload);
  assert.equal((decision?.messages ?? [])
    .filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND).length, 0);
  assert.equal(temp.store.getEmotionState('main'), null);
  assert.equal(temp.store.countEmotionEvents('main'), 0);
});

test('apply：宿主缺 context() 时只 warn 一次并降级，不挡装配与情绪计算', async (t) => {
  const temp = makeTempStore({ t });
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-emotion-context-'));
  useTempDshHome(t, home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cardPath = writeEnabledCard(home);

  const ctx = makePluginCtx();
  delete ctx.systemPrompt.context;
  const session = ctx.addSession({ id: 'session-no-context' });
  // 不抛错就是降级成功。
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    assert.equal(typeof handle.dispose, 'function');
    assert.equal(ctx.contexts.length, 0);
    const warns = ctx.logs.filter((item) => item.level === 'warn'
      && item.message.includes('emotion context unavailable'));
    assert.equal(warns.length, 1, '缺能力只 warn 一次');

    const payload = turnPayload(session, 'turn-no-context', [userMessage('你好')]);
    await dispatchPreStep(ctx, payload);
    assert.equal(temp.store.countEmotionEvents('main'), 1, '仍照常计算情绪');
  } finally {
    handle.dispose();
  }
});

// ---------------------------------------------------------------- provider

test('context provider：主会话返回已算好的「你此刻：」，子代理与未算 scope 返回空串', async (t) => {
  const { temp, ctx, session } = boot(t);
  const payload = turnPayload(session, 'turn-provider', [userMessage('你好，今天过得还不错')]);
  await dispatchPreStep(ctx, payload);

  const entry = ctx.contexts[0].context;
  const mainText = entry.text({ agent: payload.agent });
  assert.ok(mainText.startsWith(EMOTION_PROMPT_PREFIX), `实际文本：${mainText}`);
  assert.match(mainText, /^你此刻：/u);

  // 子代理：即使主会话已经算过，也必须返回空串（宿主会过滤空 section）。
  const subSession = ctx.addSession({
    id: 'session-sub-provider',
    header: { origin: 'subagent' },
  });
  assert.equal(
    entry.text({ agent: { id: subSession.id, session: subSession } }),
    '',
  );

  // 线程会话：routeSession 解析出 thread scope，但该 scope 从未算过 → 空串。
  temp.store.upsertThread({
    key: 'thread-unknown-provider',
    name: '未算过的线程',
    session_id: 'session-thread-unknown',
    description: '未算过情绪句的线程',
  });
  assert.equal(
    entry.text({
      agent: { id: 'session-thread-unknown', session: { id: 'session-thread-unknown' } },
    }),
    '',
  );
});

// ---------------------------------------------------------------- 投影去重

/** 模拟宿主 RuntimeContextProjection.project：同文本不产出，变化才产出。 */
function createProjector() {
  const messages = [];
  let retained = null;
  return {
    messages,
    project(text) {
      if (text === retained) return undefined;
      retained = text;
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'runtime-context',
          form: 'snapshot',
          sections: [{ name: 'companion-emotion', text }],
        },
      };
      messages.push(message);
      return message;
    },
  };
}

test('宿主投影 mock：同一文本连续三轮只产出 1 条，文本变化后产出第 2 条', async (t) => {
  // 曼谷 UTC+7：TEST_NOW=09:00Z → 本地 16:00，节律四维为 0，三轮中性文本
  // 不会累积变化，保证前三条 provider 文本相同。
  const { ctx, session } = boot(t, { timezone: 'Asia/Bangkok' });
  const entry = ctx.contexts[0].context;
  const projector = createProjector();
  const texts = [];

  for (let index = 1; index <= 3; index += 1) {
    const payload = turnPayload(session, `turn-dedupe-${index}`, [userMessage('嗯嗯')]);
    await dispatchPreStep(ctx, payload);
    const text = entry.text({ agent: payload.agent });
    texts.push(text);
    projector.project(text);
  }

  assert.equal(new Set(texts).size, 1, '三轮中性文本应得到同一句');
  assert.equal(projector.messages.length, 1, '同文本三轮只应产出 1 条快照');
  assert.equal(projector.messages[0].source.kind, 'runtime-context');

  const changedPayload = turnPayload(session, 'turn-dedupe-4', [userMessage('你错了')]);
  await dispatchPreStep(ctx, changedPayload);
  const changedText = entry.text({ agent: changedPayload.agent });
  assert.notEqual(changedText, texts[0], '冲突文本必须改变情绪句');
  projector.project(changedText);
  assert.equal(projector.messages.length, 2, '文本变化后应产出第 2 条快照');
  assert.notEqual(projector.messages[0].id, projector.messages[1].id);
});

// ---------------------------------------------------------------- 不再造消息

test('启用后不再产生 source.kind=companion-emotion 的消息（行为 + 源码）', async (t) => {
  const { ctx, session } = boot(t);
  const payload = turnPayload(session, 'turn-no-message', [userMessage('你好')]);
  const decision = await dispatchPreStep(ctx, payload);
  const emotionMessages = (decision?.messages ?? [])
    .filter((item) => item?.source?.kind === EMOTION_SOURCE_KIND);
  assert.equal(emotionMessages.length, 0, '不得再注入 companion-emotion 消息');

  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /function emotionMessage\s*\(/u, 'emotionMessage 必须删除');
  assert.doesNotMatch(source, /kind:\s*EMOTION_SOURCE_KIND/u, '不得再构造情绪消息');
  assert.match(source, /kind === EMOTION_SOURCE_KIND/u, '旧转录排除的常量判断必须保留');
});

// ---------------------------------------------------------------- lastUserText

test('lastUserText：跳过 runtime-context 快照，取到真正的用户文本', async (t) => {
  const { temp, ctx, session } = boot(t);
  // 默认 Asia/Shanghai，TEST_NOW=17:00，节律 pleasure +1；中性「嗯嗯」只会
  // 产生 ambient 事件。若误把快照里的「你错了」当用户发言，会走 conflict。
  const messages = [
    userMessage('嗯嗯'),
    runtimeContextMessage('你错了，别管我'),
  ];
  const payload = turnPayload(session, 'turn-runtime-context', messages);
  await dispatchPreStep(ctx, payload);

  const saved = temp.store.getEmotionState('main');
  assert.ok(saved !== null);
  assert.equal(saved.pleasure, 51, '必须只应用用户文本的 ambient 节律');
  const events = temp.store.listEmotionEvents('main', 5);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ambient', '不得把 runtime-context 当冲突发言');

  const text = ctx.contexts[0].context.text({ agent: payload.agent });
  assert.ok(text.startsWith(EMOTION_PROMPT_PREFIX));
});
