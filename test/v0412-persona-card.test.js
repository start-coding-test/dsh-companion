/**
 * v0.4.12 人格卡接线（t2）：persona.cardPath 的加载、生效、兜底与状态行。
 *
 * 覆盖用户验收清单：
 *   1) 未配置 persona.cardPath → 人格段 / 闲聊 / 承诺跟进三处都用内置卡；
 *   2) 配置合法卡（临时目录 JSON）→ 人格段用卡的 name/address、闲聊 llm 入参 card
 *      与 bannedPhrases、承诺跟进用卡的 address、/状态 显示文件绝对路径；
 *   3) 失败分支（文件不存在 / JSON 非法 / 必填缺失 / 读到目录）→ 内置卡 +
 *      一条 warn（含解析后路径与原因、不含卡正文），apply 不抛；
 *   4) 相对路径按 DSH_HOME 解析；DSH_HOME 未设置回退 ~/.dsh（用注入 deps 断言，
 *      不读真实用户目录）；
 *   5) /状态 三态（内置默认 / 文件路径 / 加载失败）与旧调用方不新增该行；
 *   6) proactive 冲突告警：文件卡与配置不一致时只 warn 一次且字段名可读，一致
 *      不 warn；内置默认卡也参与比较（配置改成非默认时告警，文案含「内置默认」
 *      与两边取值，本版以配置为准）。
 *
 * 约束：所有卡文件写在 mkdtemp 临时目录并 t.after 清理；DSH_HOME 用 env/deps 注入；
 * 不写用户 ~/.dsh、不联网、零第三方依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';
import {
  CARD_STATUS,
  DEFAULT_CARD,
  loadPersonaCard,
  resolveCardPath,
  resolveDshHome,
} from '../src/persona/card.js';
import { buildSections } from '../src/persona/sections.js';
import { TEST_NOW, makeTempStore, settle } from './e2e/helpers.js';

const NOW_MS = TEST_NOW;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const CARD_LOAD_WARN = '[dsh-companion] persona card load failed; using built-in card';
const CARD_CONFLICT_WARN = '[dsh-companion] persona card proactive settings conflict with config; config wins';
const CHAT_META_LAST_TRY_DAY = 'p1b.chat.last_try_day';

/** 自定义卡：覆盖 name/address/tone/values/taboos/version 与两条自定义禁用话术。 */
const FILE_CARD = Object.freeze({
  name: '阿岩',
  address: '老板',
  tone: { style: '干练', warmth: '克制', structure: '先给行动项' },
  version: 2,
  bannedPhrases: ['收到啦', '好哒'],
  values: ['说到做到'],
  taboos: ['空话', '套近乎'],
});

/** 五句话的闲聊文案；「收到啦」是文件卡的禁用话术、内置卡不屏蔽（对照组）。 */
const CHAT_WITH_BANNED = '收到啦。今天天气不错。中午吃了面。下午把桌子收拾了。晚上准备早点休息。';

/**
 * M-2 回归：五种现实坏 JSON 形状（每种埋一个哨兵串，断言 warn / /状态 / reason 都不含它）。
 * 这些形状的共同点是 V8 的 SyntaxError message 会回显源文件开头字符。
 */
const BAD_JSON_SHAPES = Object.freeze([
  { name: '裸 token 起始', content: 'SECRET_BODY_SENTINEL_INITIAL', sentinel: 'SECRET_BODY_SENTINEL_INITIAL' },
  {
    name: 'BOM 前缀',
    content: `\uFEFF${JSON.stringify({ name: 'BOM_SENTINEL_NAME', address: '你' })}`,
    sentinel: 'BOM_SENTINEL_NAME',
  },
  { name: '纯文本占位符', content: 'TODO_put_me_SENTINEL_PLACEHOLDER', sentinel: 'TODO_put_me_SENTINEL_PLACEHOLDER' },
  {
    name: '误写成 YAML',
    content: 'name: 隐私姓名YAML_SENTINEL\naddress: 你\ntone:\n  style: 简洁\n',
    sentinel: '隐私姓名YAML_SENTINEL',
  },
  {
    name: '单引号 JSON',
    content: "{'name': 'QUOTE_SENTINEL_NAME', 'address': '你'}",
    sentinel: 'QUOTE_SENTINEL_NAME',
  },
]);

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/**
 * 严格 FakeCtx + commands/tools 注册记录器（与 v0411 集成测试同一模板）。
 * @param {{now?: number, chatLlm?: Function}} [options]
 */
function makePluginCtx({ now = NOW_MS, chatLlm } = {}) {
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
  if (typeof chatLlm === 'function') ctx.companion = { chatLlm };
  return ctx;
}

/**
 * 临时人格卡目录；测试结束自动删除。
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempCardDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v0412-card-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} dir
 * @param {object} value
 * @param {string} [name]
 * @returns {string} 写出的绝对路径
 */
function writeCardFile(dir, value, name = 'card.json') {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
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

/** @param {FakeCtx} ctx @returns {string|null} */
function personaLineOf(ctx) {
  const line = statusTextOf(ctx).split('\n').find((text) => text.startsWith('人格卡：'));
  return line ?? null;
}

/**
 * 人格段（含状态板段）；顺序即注册顺序。
 * @param {FakeCtx} ctx
 * @returns {Array<{name: string, order: number, text: string|Function}>}
 */
function personaSectionsOf(ctx) {
  return ctx.sections
    .map((entry) => entry.section)
    .filter((section) => typeof section?.name === 'string' && section.name.startsWith('persona:'));
}

/** @param {FakeCtx} ctx @returns {string} */
function coreTextOf(ctx) {
  const core = personaSectionsOf(ctx).find((section) => section.name === 'persona:core');
  assert.ok(core, '必须注册 persona:core');
  return core.text;
}

/** @param {FakeCtx} ctx */
function loadFailureWarns(ctx) {
  return ctx.logs.filter((log) => log.level === 'warn' && log.message === CARD_LOAD_WARN);
}

/** proactive 冲突告警（文件卡英文事件文案 / 内置卡中文说明都含 proactive）。 */
function conflictWarns(ctx) {
  return ctx.logs.filter((log) => log.level === 'warn' && log.message.includes('proactive'));
}

/** @param {FakeCtx} ctx @returns {string[]} */
function promptTexts(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const content = call.args[0]?.content;
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  });
}

/**
 * 调度器构造时把间隔任务的基线设为当前时刻，先过一个周期再 tick。
 * @param {FakeCtx} ctx
 * @returns {Promise<object[]>}
 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  const result = await ctx.fireTimers();
  await settle(50);
  return result;
}

/**
 * 让 pre-step 看到一条已 commit 的用户消息，并记录当天互动。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {string} [text]
 * @returns {Promise<object>}
 */
async function interact(ctx, session, text = '今天有点累') {
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  return ctx.dispatch('agent/pre-step', {
    agent: { id: session.id, session },
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    turn: 1,
    step: 1,
  }, { kind: 'enter', messages: [] });
}

// ---------------------------------------------------------------------------
// 路径解析（纯函数）
// ---------------------------------------------------------------------------

test('resolveCardPath：null/空白 → null；绝对路径原样；相对路径拼到 DSH_HOME', () => {
  const env = { DSH_HOME: join(tmpdir(), 'dsh-home-a') };
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(resolveCardPath(value, { env }), null);
  }

  const absolute = join(tmpdir(), 'cards', 'persona.json');
  assert.equal(resolveCardPath(absolute, { env }), absolute, '绝对路径必须原样使用，不再拼 DSH_HOME');
  assert.equal(
    resolveCardPath(absolute, { env: { DSH_HOME: join(tmpdir(), 'elsewhere') } }),
    absolute,
  );

  assert.equal(resolveCardPath('persona.json', { env }), resolve(env.DSH_HOME, 'persona.json'));
  assert.equal(
    resolveCardPath('  cards/persona.json  ', { env }),
    resolve(env.DSH_HOME, 'cards/persona.json'),
  );
  assert.throws(() => resolveCardPath(42, { env }), {
    name: 'TypeError',
    message: /cardPath must be a string or null/u,
  });
});

test('resolveDshHome：DSH_HOME 优先；未设置或空白时回退 <homedir>/.dsh（不读真实用户目录）', () => {
  const dshHome = join(tmpdir(), 'dsh-home-env');
  const home = join(tmpdir(), 'home-of-tester');
  const expectedHome = join(home, '.dsh');

  assert.equal(resolveDshHome({ env: { DSH_HOME: ` ${dshHome} ` } }), dshHome);
  // M-1：未设置 DSH_HOME 时回退的是 <用户主目录>/.dsh，注入的 homedir 与 os.homedir() 一视同仁。
  assert.equal(resolveDshHome({ env: { DSH_HOME: '' }, homedir: home }), expectedHome);
  assert.equal(resolveDshHome({ env: {}, homedir: () => home }), expectedHome);
  assert.equal(resolveDshHome({ env: { DSH_HOME: '   ' }, homedir: () => ` ${home} ` }), expectedHome);

  // 相对 cardPath 跟着 <home>/.dsh 走；注入 homedir 覆盖真实 ~。
  assert.equal(resolveCardPath('persona.json', { env: {}, homedir: home }), join(expectedHome, 'persona.json'));
  assert.equal(
    resolveCardPath('persona.json', { env: {}, homedir: () => home }),
    join(expectedHome, 'persona.json'),
  );

  // 未注入任何 deps 时回退 os.homedir()/.dsh（只拼路径，不读目录内容）。
  assert.equal(resolveDshHome({ env: {} }), join(osHomedir(), '.dsh'));
  assert.equal(resolveCardPath('persona.json', { env: {} }), join(osHomedir(), '.dsh', 'persona.json'));
});

test('loadPersonaCard：DSH_HOME 未设置时相对路径读 <注入 home>/.dsh/persona.json；旧位置 <home>/persona.json 回落', (t) => {
  const home = tempCardDir(t);
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const expectedPath = join(home, '.dsh', 'persona.json');
  writeFileSync(expectedPath, JSON.stringify(FILE_CARD), 'utf8');

  const loaded = loadPersonaCard('persona.json', { env: {}, homedir: home });
  assert.equal(loaded.status, CARD_STATUS.FILE, '必须读到 ~/.dsh 下的卡，而不是 ~/persona.json');
  assert.equal(loaded.path, expectedPath);
  assert.equal(loaded.card.name, '阿岩');

  // 卡放在旧错误位置 <home>/persona.json：现在应 ENOENT 兜底，且 reason 指向 .dsh 下的路径。
  const wrongHome = tempCardDir(t);
  writeFileSync(join(wrongHome, 'persona.json'), JSON.stringify(FILE_CARD), 'utf8');
  const missing = loadPersonaCard('persona.json', { env: {}, homedir: wrongHome });
  assert.equal(missing.status, CARD_STATUS.FALLBACK);
  assert.match(missing.reason, /^文件不存在（ENOENT）：/u);
  assert.equal(missing.path, join(wrongHome, '.dsh', 'persona.json'), '解析后路径必须是 <.dsh> 下的位置');
  assert.ok(missing.reason.includes(join(wrongHome, '.dsh', 'persona.json')));
});

// ---------------------------------------------------------------------------
// loadPersonaCard：apply 时只加载一次的那个函数
// ---------------------------------------------------------------------------

test('loadPersonaCard：未配置路径 → builtin + 内置卡（珞然/你/默认禁用话术）', () => {
  const loaded = loadPersonaCard(null);
  assert.equal(loaded.status, CARD_STATUS.BUILTIN);
  assert.equal(loaded.path, null);
  assert.equal(loaded.reason, null);
  assert.equal(loaded.card.name, '珞然');
  assert.equal(loaded.card.address, '你');
  assert.deepEqual(loaded.card.bannedPhrases, DEFAULT_CARD.bannedPhrases);
  assert.deepEqual(loaded.card, DEFAULT_CARD);
  assert.ok(Object.isFrozen(loaded.card), '内置卡必须是冻结副本');
  // trim 后为空也算「未配置」。
  assert.equal(loadPersonaCard('   ').status, CARD_STATUS.BUILTIN);
});

test('loadPersonaCard：合法卡文件 → file + 深合并；buildSections 用卡里的 name/address/tone', (t) => {
  const dir = tempCardDir(t);
  const path = writeCardFile(dir, { ...FILE_CARD, proactive: { chatPerDay: 2 } });

  const loaded = loadPersonaCard(path);
  assert.equal(loaded.status, CARD_STATUS.FILE);
  assert.equal(loaded.path, path, '绝对路径原样返回');
  assert.equal(loaded.reason, null);
  assert.equal(loaded.card.name, '阿岩');
  assert.equal(loaded.card.address, '老板');
  assert.equal(loaded.card.version, 2);
  assert.deepEqual(loaded.card.bannedPhrases, ['收到啦', '好哒']);
  // 卡里没写的字段沿用内置默认：对象深合并，数组整体替换。
  assert.deepEqual(loaded.card.relation, DEFAULT_CARD.relation);
  assert.deepEqual(loaded.card.proactive, { ...DEFAULT_CARD.proactive, chatPerDay: 2 });

  const [, core] = buildSections(loaded.card);
  assert.ok(core.text.includes('你是阿岩，用户的私人管家。'));
  assert.ok(core.text.includes('称呼用户为“老板”。'));
  assert.ok(core.text.includes('语气干练、克制，先给行动项'));
  assert.ok(core.text.includes('说到做到'));
  assert.ok(core.text.includes('空话、套近乎'));
});

test('loadPersonaCard：相对路径 + 注入 DSH_HOME → 读到 <DSH_HOME>/persona.json', (t) => {
  const dir = tempCardDir(t);
  writeCardFile(dir, FILE_CARD, 'persona.json');

  const loaded = loadPersonaCard('persona.json', { env: { DSH_HOME: dir } });
  assert.equal(loaded.status, CARD_STATUS.FILE);
  assert.equal(loaded.path, resolve(dir, 'persona.json'));
  assert.equal(loaded.card.name, '阿岩');
});

test('loadPersonaCard：文件不存在 → fallback + 内置卡 + 原因含 ENOENT 与解析后路径', (t) => {
  const dir = tempCardDir(t);
  const path = join(dir, 'missing.json');

  const loaded = loadPersonaCard(path);
  assert.equal(loaded.status, CARD_STATUS.FALLBACK);
  assert.equal(loaded.path, path);
  assert.deepEqual(loaded.card, DEFAULT_CARD);
  assert.match(loaded.reason, /^文件不存在（ENOENT）：/u);
  assert.ok(loaded.reason.includes(path));
});

test('loadPersonaCard：坏 JSON 五种现实形状 → 全部 fallback，reason 不含卡正文且单行（M-2）', (t) => {
  const dir = tempCardDir(t);
  BAD_JSON_SHAPES.forEach((shape, index) => {
    const path = join(dir, `bad-shape-${index}.json`);
    writeFileSync(path, shape.content, 'utf8');

    const loaded = loadPersonaCard(path);
    assert.equal(loaded.status, CARD_STATUS.FALLBACK, `${shape.name}: 必须兜底`);
    assert.deepEqual(loaded.card, DEFAULT_CARD, `${shape.name}: 兜底用内置卡`);
    assert.match(loaded.reason, /invalid JSON/u, `${shape.name}: 固定文案`);
    assert.ok(loaded.reason.includes(path), `${shape.name}: reason 含解析后路径`);
    assert.equal(loaded.reason.includes(shape.sentinel), false, `${shape.name}: reason 不能回显卡正文`);
    assert.doesNotMatch(loaded.reason, /[\r\n\t\u0000-\u001f\u007f]/u, `${shape.name}: reason 必须单行`);
    assert.ok(loaded.reason.length <= 160, `${shape.name}: reason 超长`);
  });
});

test('loadPersonaCard：必填字段缺失（name 空白 / 缺 tone）→ fallback + 原因指出字段名', (t) => {
  const dir = tempCardDir(t);
  const emptyName = writeCardFile(dir, {
    name: '   ',
    address: '你',
    tone: { style: '简洁', warmth: '温和', structure: '先结论' },
    taboos: ['绝密禁区'],
  }, 'empty-name.json');

  const missingName = loadPersonaCard(emptyName);
  assert.equal(missingName.status, CARD_STATUS.FALLBACK);
  assert.deepEqual(missingName.card, DEFAULT_CARD);
  assert.match(missingName.reason, /"name" must be a non-empty string/u);
  assert.ok(missingName.reason.includes(emptyName));
  assert.doesNotMatch(missingName.reason, /绝密禁区/u, '原因里不能带卡正文');

  const noTone = writeCardFile(dir, { name: '阿岩', address: '老板', version: 2 }, 'no-tone.json');
  const missingTone = loadPersonaCard(noTone);
  assert.equal(missingTone.status, CARD_STATUS.FALLBACK);
  assert.match(missingTone.reason, /"tone" must be an object/u);
});

test('loadPersonaCard：路径是目录（其它读取错误）→ fallback + EISDIR，不抛', (t) => {
  const dir = tempCardDir(t);
  const notAFile = join(dir, 'not-a-file');
  mkdirSync(notAFile);

  const loaded = loadPersonaCard(notAFile);
  assert.equal(loaded.status, CARD_STATUS.FALLBACK);
  assert.match(loaded.reason, /EISDIR/u);
  assert.ok(loaded.reason.includes(notAFile));
  assert.deepEqual(loaded.card, DEFAULT_CARD);
});

// ---------------------------------------------------------------------------
// 生产接线：未配置 persona.cardPath → 三处都用内置卡
// ---------------------------------------------------------------------------

test('生产接线（未配置）：人格段用内置卡，注册顺序 80/90/150/160', () => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const sections = personaSectionsOf(ctx);
    assert.deepEqual(
      sections.map((section) => section.name),
      ['persona:safety', 'persona:core', 'persona:protocol', 'persona:state_board'],
    );
    assert.deepEqual(sections.map((section) => section.order), [80, 90, 150, 160]);

    const core = coreTextOf(ctx);
    assert.ok(core.includes('你是珞然，用户的私人管家。'));
    assert.ok(core.includes('称呼用户为“你”。'));
    assert.ok(core.includes('语气简洁、温和，先结论'));
    assert.doesNotMatch(core, /阿岩|老板/u);

    const configLog = ctx.logs.find((log) => log.message === '[dsh-companion] config ok');
    assert.deepEqual(configLog.meta.warnings, [], '未配置 persona 时不应有配置 warning');
    assert.equal(personaLineOf(ctx), '人格卡：珞然 v1（内置默认）');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线（未配置）：闲聊 llm 入参 card 为内置卡，内置卡不屏蔽的短语照常投递', async () => {
  const temp = makeTempStore();
  const seen = [];
  const ctx = makePluginCtx({
    chatLlm: async (input) => {
      seen.push(input);
      return CHAT_WITH_BANNED;
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-builtin-chat' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);

    assert.equal(seen.length, 1, '应调用一次闲聊模型');
    assert.equal(seen[0].card.name, '珞然');
    assert.equal(seen[0].card.address, '你');
    assert.deepEqual(seen[0].card.bannedPhrases, DEFAULT_CARD.bannedPhrases);
    assert.equal(seen[0].messageCount, 8);

    const chats = promptTexts(ctx).filter((text) => text.includes('今天天气不错'));
    assert.equal(chats.length, 1, '「收到啦」不是内置卡的禁用话术，应投递');
    assert.equal((chats[0].match(/。/gu) ?? []).length, 5);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线（未配置）：承诺跟进文案使用内置卡 address（你）', async () => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-session');
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: NOW_SECONDS - 3600,
      next_fire_at: NOW_SECONDS - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    const texts = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(texts.length, 1);
    assert.ok(texts[0].includes('你，昨天说好的「交周报」，今天要不要推进一下？'));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 生产接线：persona.cardPath 指定合法文件卡 → 四处替换都生效
// ---------------------------------------------------------------------------

test('生产接线（文件卡）：人格段文本用卡里的 name/address/tone/values/taboos', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, FILE_CARD);
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    const core = coreTextOf(ctx);
    assert.ok(core.includes('你是阿岩，用户的私人管家。'));
    assert.ok(core.includes('称呼用户为“老板”。'));
    assert.ok(core.includes('语气干练、克制，先给行动项'));
    assert.ok(core.includes('说到做到'));
    assert.ok(core.includes('空话、套近乎'));
    assert.doesNotMatch(core, /珞然/u);

    assert.equal(loadFailureWarns(ctx).length, 0);
    assert.equal(conflictWarns(ctx).length, 0, '卡里没写 proactive，不应有冲突告警');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线（文件卡）：闲聊 llm 入参 card 为文件卡，bannedPhrases 来自卡（命中即拒发）', async (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, FILE_CARD);
  const seen = [];
  const ctx = makePluginCtx({
    chatLlm: async (input) => {
      seen.push(input);
      return CHAT_WITH_BANNED;
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    const session = ctx.addSession({ id: 'session-file-chat' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].card.name, '阿岩');
    assert.equal(seen[0].card.address, '老板');
    assert.deepEqual(seen[0].card.bannedPhrases, ['收到啦', '好哒']);

    assert.equal(
      promptTexts(ctx).filter((text) => text.includes('收到啦')).length,
      0,
      '文件卡的 bannedPhrases 必须参与闲聊校验',
    );
    const rejected = ctx.logs.find((log) => log.message === '[dsh-companion] light chat rejected');
    assert.equal(rejected?.meta?.reason, 'banned_phrase');
    assert.equal(temp.store.getMeta(CHAT_META_LAST_TRY_DAY), '2026-11-05');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线（文件卡）：承诺跟进文案使用卡里的 address（老板）', async (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, FILE_CARD);
  temp.store.setMeta('main_session_id', 'main-session');
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    temp.store.insertReminder({
      kind: 'commitment',
      title: '交周报',
      due_at: NOW_SECONDS - 3600,
      next_fire_at: NOW_SECONDS - 3600,
      due_granularity: 'exact',
    });

    await firstTick(ctx);
    const texts = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(texts.length, 1);
    assert.ok(texts[0].includes('老板，昨天说好的「交周报」，今天要不要推进一下？'));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线（文件卡）：/状态 显示「人格卡：阿岩 v2（<绝对路径>）」，路径原样', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, FILE_CARD);
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    assert.equal(personaLineOf(ctx), `人格卡：阿岩 v2（${cardPath}）`);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('生产接线：DSH_HOME 指向临时目录 + 相对 cardPath="persona.json" 读到 <DSH_HOME>/persona.json', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, FILE_CARD, 'persona.json');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;

  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath: 'persona.json' } });

    assert.equal(loadFailureWarns(ctx).length, 0, '相对路径必须解析到 DSH_HOME 下的文件');
    assert.ok(coreTextOf(ctx).includes('你是阿岩，用户的私人管家。'));
    assert.equal(personaLineOf(ctx), `人格卡：阿岩 v2（${cardPath}）`);
  } finally {
    handle?.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 生产接线（M-1）：DSH_HOME 未设置 → 回退 <home>/.dsh
// ---------------------------------------------------------------------------

test('生产接线（M-1）：DSH_HOME 未设置 + 注入 home → 读 <home>/.dsh/persona.json，人格段与 /状态 生效', (t) => {
  const temp = makeTempStore();
  const home = tempCardDir(t);
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const cardPath = join(home, '.dsh', 'persona.json');
  writeFileSync(cardPath, JSON.stringify(FILE_CARD), 'utf8');

  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(
      ctx,
      { dbPath: temp.dbPath, persona: { cardPath: 'persona.json' } },
      { personaDeps: { env: {}, homedir: home } },
    );
    assert.ok(handle);
    assert.equal(loadFailureWarns(ctx).length, 0, '相对路径必须回退到 <home>/.dsh 并读到卡');
    assert.ok(coreTextOf(ctx).includes('你是阿岩，用户的私人管家。'));
    assert.ok(coreTextOf(ctx).includes('称呼用户为“老板”。'));
    assert.equal(personaLineOf(ctx), `人格卡：阿岩 v2（${cardPath}）`);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

test('生产接线（M-1）：卡在旧错误位置 <home>/persona.json → ENOENT 兜底，reason 指向 <home>/.dsh/persona.json', (t) => {
  const temp = makeTempStore();
  const home = tempCardDir(t);
  writeFileSync(join(home, 'persona.json'), JSON.stringify(FILE_CARD), 'utf8');
  const expectedPath = join(home, '.dsh', 'persona.json');

  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(
      ctx,
      { dbPath: temp.dbPath, persona: { cardPath: 'persona.json' } },
      { personaDeps: { env: {}, homedir: home } },
    );
    assert.ok(handle, 'apply 不能因卡路径不匹配而失败');
    const warns = loadFailureWarns(ctx);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].meta.path, expectedPath);
    assert.match(warns[0].meta.reason, /^文件不存在（ENOENT）：/u);
    assert.ok(warns[0].meta.reason.includes(expectedPath));
    assert.ok(coreTextOf(ctx).includes('你是珞然，用户的私人管家。'));
    assert.match(personaLineOf(ctx), /^人格卡：珞然 v1（加载失败，已用内置：/u);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 生产接线：加载失败兜底（apply 不抛、一条 warn、不含卡正文）
// ---------------------------------------------------------------------------

test('生产接线（失败）：文件不存在 → 一条 warn 含路径与原因、人格段与 /状态 回落内置卡', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = join(dir, 'missing.json');
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
    assert.ok(handle, 'apply 必须返回句柄，不能因卡加载失败而抛错');

    const warns = loadFailureWarns(ctx);
    assert.equal(warns.length, 1, '加载失败只 warn 一次');
    assert.deepEqual(Object.keys(warns[0].meta).sort(), ['path', 'reason']);
    assert.equal(warns[0].meta.path, cardPath);
    assert.match(warns[0].meta.reason, /^文件不存在（ENOENT）：/u);
    assert.ok(warns[0].meta.reason.includes(cardPath));

    assert.ok(coreTextOf(ctx).includes('你是珞然，用户的私人管家。'));
    const line = personaLineOf(ctx);
    assert.match(line, /^人格卡：珞然 v1（加载失败，已用内置：/u);
    assert.ok(line.includes(warns[0].meta.reason));
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

test('生产接线（失败）：JSON 非法 → 一条 warn 不含卡正文，回落内置卡', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = join(dir, 'broken.json');
  writeFileSync(cardPath, '{"name":"秘卡正文勿外泄","address":"你",', 'utf8');
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
    assert.ok(handle);

    const warns = loadFailureWarns(ctx);
    assert.equal(warns.length, 1);
    assert.match(warns[0].meta.reason, /invalid JSON/u);
    assert.equal(JSON.stringify(warns[0]).includes('秘卡正文勿外泄'), false, 'warn 不能带卡正文');

    assert.ok(coreTextOf(ctx).includes('你是珞然，用户的私人管家。'));
    assert.match(personaLineOf(ctx), /^人格卡：珞然 v1（加载失败，已用内置：/u);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

test('生产接线（M-2）：五种坏 JSON 形状 → warn 与 /状态 都不泄漏卡正文，且单行', (t) => {
  BAD_JSON_SHAPES.forEach((shape, index) => {
    const temp = makeTempStore();
    const dir = tempCardDir(t);
    const cardPath = join(dir, `bad-${index}.json`);
    writeFileSync(cardPath, shape.content, 'utf8');
    const ctx = makePluginCtx();
    let handle;
    try {
      handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
      assert.ok(handle, `${shape.name}: apply 不能因坏 JSON 而抛`);

      const warns = loadFailureWarns(ctx);
      assert.equal(warns.length, 1, `${shape.name}: 加载失败只 warn 一次`);
      assert.equal(
        JSON.stringify(warns).includes(shape.sentinel),
        false,
        `${shape.name}: warn 所有字段都不能带卡正文`,
      );

      const line = personaLineOf(ctx);
      assert.ok(line, `${shape.name}: /状态 必须有 人格卡 行`);
      assert.equal(line.includes(shape.sentinel), false, `${shape.name}: /状态 不能带卡正文`);
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/u, `${shape.name}: /状态 行必须单行`);
      assert.ok(line.includes(warns[0].meta.reason), `${shape.name}: /状态 复用同一条安全原因`);
    } finally {
      handle?.dispose();
      temp.cleanup();
    }
  });
});

test('生产接线（失败）：必填字段缺失 → 一条 warn 指出字段，回落内置卡', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, {
    name: '   ',
    address: '你',
    tone: { style: '简洁', warmth: '温和', structure: '先结论' },
    taboos: ['绝密禁区'],
  });
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
    assert.ok(handle);

    const warns = loadFailureWarns(ctx);
    assert.equal(warns.length, 1);
    assert.match(warns[0].meta.reason, /"name" must be a non-empty string/u);
    assert.equal(JSON.stringify(warns[0]).includes('绝密禁区'), false, 'warn 不能带卡正文');

    assert.ok(coreTextOf(ctx).includes('你是珞然，用户的私人管家。'));
    assert.match(personaLineOf(ctx), /^人格卡：珞然 v1（加载失败，已用内置：/u);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 配置 warning / /状态 旧调用方
// ---------------------------------------------------------------------------

test('persona 未知键 → 一条配置 warning（不阻断 apply）', () => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { unknownKey: true } });
  try {
    const configLog = ctx.logs.find((log) => log.message === '[dsh-companion] config ok');
    assert.ok(configLog.meta.warnings.includes('unknown config field "persona.unknownKey" ignored'));
    assert.ok(coreTextOf(ctx).includes('你是珞然，用户的私人管家。'));
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('/状态：旧调用方（未传 persona）不新增人格卡行，输出格式不变', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());

  const legacy = handleCommand({ text: '/状态', store, now: NOW_MS });
  assert.equal(legacy.handled, true);
  assert.doesNotMatch(legacy.reply, /人格卡/u);

  const explicitNull = handleCommand({ text: '/状态', store, now: NOW_MS, persona: null });
  assert.doesNotMatch(explicitNull.reply, /人格卡/u);
});

// ---------------------------------------------------------------------------
// proactive 冲突告警
// ---------------------------------------------------------------------------

test('proactive 冲突：文件卡 dailyCap/quietStart/quietEnd 与配置不一致 → 恰一条 warn、字段名可读', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, {
    ...FILE_CARD,
    proactive: { dailyCap: 5, quietStart: '22:00', quietEnd: '07:30' },
  });
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    const warns = conflictWarns(ctx);
    assert.equal(warns.length, 1, '多个冲突字段合并成一条 warn');
    assert.equal(warns[0].message, CARD_CONFLICT_WARN);
    assert.equal(warns[0].meta.path, cardPath);
    assert.deepEqual(warns[0].meta.fields, [
      'proactive.dailyCap≠proactiveDailyCap',
      'proactive.quietStart≠quietStart',
      'proactive.quietEnd≠quietEnd',
    ]);
    assert.equal(loadFailureWarns(ctx).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('proactive 冲突：文件卡与配置一致 → 不 warn', (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  const cardPath = writeCardFile(dir, {
    ...FILE_CARD,
    proactive: { dailyCap: 3, quietStart: '23:00', quietEnd: '08:00' },
  });
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
  try {
    assert.equal(conflictWarns(ctx).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('proactive 冲突：内置默认卡 + 非默认配置 → 告警一次，文案含「内置默认」与两边取值', () => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath, proactiveDailyCap: 5, quietEnd: '07:30' });
  try {
    const warns = conflictWarns(ctx);
    assert.equal(warns.length, 1, '两个冲突字段合并成一条 warn');
    const [warn] = warns;
    assert.match(warn.message, /内置默认/u);
    assert.ok(warn.message.includes('proactive.dailyCap=3'));
    assert.ok(warn.message.includes('proactiveDailyCap=5'));
    assert.ok(warn.message.includes('proactive.quietEnd=08:00'));
    assert.ok(warn.message.includes('quietEnd=07:30'));
    assert.equal(warn.meta.source, 'builtin');
    assert.equal(loadFailureWarns(ctx).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('proactive 冲突：内置默认卡 + 默认配置 → 不 warn（默认值本就一致）', () => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    assert.equal(conflictWarns(ctx).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});
