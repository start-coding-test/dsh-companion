/**
 * v0.4.12 人格卡集成回归（t4）：在**生产接线**（apply 驱动、真实 Store / 临时库 /
 * 临时 DSH_HOME）上验证 `persona.cardPath` 的四个使用点同源、单次加载、兜底与
 * v0.4.12 等价性（渲染输出与 v0.4.11 相同）。
 *
 * 覆盖：
 *   1) 相对路径文件卡：同一次运行里人格段 / `/状态` 行 / 闲聊 llm 入参 / 承诺跟进
 *      文案四处都来自配置的卡；apply 后立刻改盘上卡文件，四处仍用启动时那份
 *      （证明只读一次，不是各处各读一次）；
 *   2) 运行期改卡不生效、不重复 warn；重启（重新 apply）才重读，坏文件恰一条
 *      warn 并回落内置卡，修好后重启恢复；
 *   3) 未配置卡时与 v0.4.12 等价（同 v0.4.11）：人格三段文本 SHA-256 与 08493eb 基线一致，
 *      `/状态` 只多「人格卡」一行、其余行逐行不变；
 *   4) B1 生产装配：状态板段 + 召回注入 + 人格段 + `/状态` 行在一轮 pre-step 中
 *      同时可见；
 *   5) 失败兜底不阻断：坏 JSON 时 apply 不抛、恰一条加载 warn（叠加改过的
 *      proactive 配置时另有内置卡冲突 warn），仍能跑完一轮 turn 且闲聊照常投递；
 *   6) v2 重跑新增：未设置 `DSH_HOME` 时相对路径回退 `<home>/.dsh` 的文件卡端到端；
 *   7) v2 重跑新增：5 种坏 JSON 形状矩阵，warn 与 `/状态` 均不泄漏卡正文（M-2）。
 *
 * 约束：不读用户 `~/.dsh`（DSH_HOME 指向 mkdtemp；回退分支用 `personaDeps.homedir`
 * 注入临时 home），不联网，零第三方依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FakeCtx } from '../fakes/ctx.js';
import { strictCtx } from '../helpers/strict-ctx.js';
import { apply as applyCordis } from '../../src/index.js';
import { stageBoard } from '../../src/memory/state-board.js';
import { TEST_NOW, makeTempStore, settle } from './helpers.js';

const NOW_MS = TEST_NOW;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const CARD_LOAD_WARN = '[dsh-companion] persona card load failed; using built-in card';

/** 自定义卡：与单测同一份，覆盖 name/address/tone/values/taboos/version/bannedPhrases。 */
const FILE_CARD = Object.freeze({
  name: '阿岩',
  address: '老板',
  tone: { style: '干练', warmth: '克制', structure: '先给行动项' },
  version: 2,
  bannedPhrases: ['收到啦', '好哒'],
  values: ['说到做到'],
  taboos: ['空话', '套近乎'],
});

/** apply 之后写到同一路径的另一张卡；运行期若被读到，断言会立刻暴露。 */
const OTHER_CARD = Object.freeze({
  name: '替换后',
  address: '替换',
  version: 9,
  bannedPhrases: ['收到啦'],
});

/** 五句话的闲聊文案；「收到啦」是文件卡禁用话术、内置卡不屏蔽（对照组）。 */
const CHAT_WITH_BANNED = '收到啦。今天天气不错。中午吃了面。下午把桌子收拾了。晚上准备早点休息。';

/**
 * B4（v2 重跑）：五种现实坏 JSON 形状。前四种在 V8 的 `JSON.parse` 错误
 * message 里会回显源文件开头字符（M-2 的泄漏路径），单引号 JSON 只给位置；
 * 这里统一断言 reason / warn / `/状态` 都不含各自的哨兵串。
 */
const BAD_JSON_SHAPES = Object.freeze([
  {
    name: '裸 token 起始',
    content: 'SECRET_BARE_TOKEN_SENTINEL_1234567890',
    sentinel: 'SECRET_BARE_TOKEN_SENTINEL_1234567890',
  },
  {
    name: 'BOM 前缀',
    content: `\uFEFF${JSON.stringify({ name: 'BOM_CARD_SENTINEL', address: '你', tone: { style: '简洁' } })}`,
    sentinel: 'BOM_CARD_SENTINEL',
    extraForbidden: '\uFEFF',
  },
  {
    name: '纯文本占位符',
    content: 'TODO_put_me_SENTINEL_PLACEHOLDER',
    sentinel: 'TODO_put_me_SENTINEL_PLACEHOLDER',
  },
  {
    name: '误写成 YAML',
    content: 'name: 隐私姓名YAML_SENTINEL\naddress: 你\ntone:\n  style: 简洁\n',
    sentinel: '隐私姓名YAML_SENTINEL',
  },
  {
    name: '单引号 JSON',
    content: "{'name': 'QUOTE_SENTINEL_NAME', 'address': '你', 'tone': {'style': '简洁'}}",
    sentinel: 'QUOTE_SENTINEL_NAME',
  },
]);

/**
 * v0.4.12（6eedde9）/ v0.4.11（08493eb）内置卡三段文本的 SHA-256（两者相同，采集于 08493eb）。
 * 采集方式：`git worktree add .data/v0411-base 08493eb` 后用同一 FakeCtx 脚本
 * 跑 `buildSections(DEFAULT_CARD)` 取安全/核心/协议三段。
 */
const V0412_SECTION_SHA256 = Object.freeze({
  'persona:safety': 'f6674ce158a44b29d07deebc12393974292b66ac873992fca03d4d1ccd0f1a27',
  'persona:core': '2c2bf0d51048619223580470c27e1ec3ecc3a7c76f9bb57a104a46e82b73d928',
  'persona:protocol': '3583cacf66261008fcc8b91207a8f945dd79de558c61c1d40ec4f48bbc9bc38b',
});

/**
 * v0.4.12（6eedde9）同一 FakeCtx / 空库 / TEST_NOW 下 `/状态` 的 14 行输出（与 v0.4.11 相同，采集于 08493eb）。
 * 第一行含与本机进程内存有关的 `RSS ok <n>MB`，比较时单独用正则；其余逐行相等。
 */
const V0412_STATUS_LINES = Object.freeze([
  '状态：entities 0 / episodes 0 / facts 0 / reminders 0 / state_board 0 / state_board_rev 1 / threads 0 / consolidations 0 / memory_events 0 / fts 0/0 / tokens 本轮 入 0 出 0（超预算 0 次）｜今日 0/3000000｜RSS ok 0MB｜向量：关',
  'RSS 阈值：warn 2.95GiB / stop 3GiB / main_only 3.15GiB',
  '压缩：宿主已开启（compaction-basic 已启用）',
  '最近压缩耗时：—',
  '最近巩固耗时：—',
  '主会话：未绑定（绑定 latest-user）',
  '线程 preset：宿主默认',
  '水位 main：0',
  '最近 job：无',
  '最近失败：无',
  '最近重试：无',
  '最近 job 失败：无',
  '闲聊：已开启 · 最近一次：无',
  '巩固：无可用模型',
]);

const V0412_STATUS_HEAD = /^状态：entities 0 \/ episodes 0 \/ facts 0 \/ reminders 0 \/ state_board 0 \/ state_board_rev 1 \/ threads 0 \/ consolidations 0 \/ memory_events 0 \/ fts 0\/0 \/ tokens 本轮 入 0 出 0（超预算 0 次）｜今日 0\/3000000｜RSS ok \d+MB｜向量：关$/u;

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/**
 * 严格 FakeCtx + commands/tools 注册记录器 + 可选闲聊模型。
 * @param {{chatLlm?: Function, now?: number}} [options]
 */
function makePluginCtx({ chatLlm, now = NOW_MS } = {}) {
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
 * 把人体的 DSH_HOME 指到临时目录；测试结束恢复（没设置过则删除）。
 * @param {import('node:test').TestContext} t
 * @param {string} dir
 */
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

/** @param {import('node:test').TestContext} t @returns {string} */
function tempCardDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v0412-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} dir
 * @param {object|string} value 对象按 JSON 写出；字符串原样写出（用于坏 JSON）。
 * @param {string} [name]
 * @returns {string} 写出的绝对路径
 */
function writeCardFile(dir, value, name = 'persona.json') {
  const path = join(dir, name);
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  writeFileSync(path, body, 'utf8');
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
  return statusTextOf(ctx).split('\n').find((line) => line.startsWith('人格卡：')) ?? null;
}

/** @param {FakeCtx} ctx */
function personaSectionsOf(ctx) {
  return ctx.sections
    .map((entry) => entry.section)
    .filter((section) => typeof section?.name === 'string' && section.name.startsWith('persona:'));
}

/** @param {FakeCtx} ctx @param {string} name @returns {string|Function|undefined} */
function sectionOf(ctx, name) {
  return personaSectionsOf(ctx).find((section) => section.name === name)?.text;
}

/** @param {FakeCtx} ctx @returns {string} */
function coreTextOf(ctx) {
  const text = sectionOf(ctx, 'persona:core');
  assert.equal(typeof text, 'string', 'persona:core 必须是静态文本');
  return text;
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
 * 调度器构造时把间隔任务基线设为当前时刻；过一个周期再 tick。
 * @param {FakeCtx} ctx
 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/**
 * 让 pre-step 看到一条已 commit 的用户消息。
 * @param {FakeCtx} ctx
 * @param {object} session
 * @param {string} text
 */
async function interact(ctx, session, text) {
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
// 1) 相对路径文件卡：四处同源 + 只加载一次
// ---------------------------------------------------------------------------

test('集成（文件卡相对路径）：人格段 / /状态 / 闲聊入参 / 承诺跟进四处同源，apply 后改盘上卡不生效', async (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  useTempDshHome(t, dir);
  const cardPath = writeCardFile(dir, FILE_CARD);
  temp.store.setMeta('main_session_id', 'main-session');
  temp.store.insertReminder({
    kind: 'commitment',
    title: '交周报',
    due_at: NOW_SECONDS - 3600,
    next_fire_at: NOW_SECONDS - 3600,
    due_granularity: 'exact',
  });

  const seen = [];
  const ctx = makePluginCtx({
    chatLlm: async (input) => {
      seen.push(input);
      return CHAT_WITH_BANNED;
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath: 'persona.json' } });
  try {
    // 启动后立刻把盘上文件换成另一张卡：任何使用点若二次读盘都会露馅。
    writeCardFile(dir, OTHER_CARD);
    assert.ok(coreTextOf(ctx).includes('你是阿岩，用户的私人管家。'), '人格段必须来自启动时加载的卡');
    assert.equal(personaLineOf(ctx), `人格卡：阿岩 v2（${resolve(dir, 'persona.json')}）`);

    const session = ctx.addSession({ id: 'session-single-load' });
    await interact(ctx, session, '今天有点累');
    await firstTick(ctx);

    assert.equal(seen.length, 1, '应调用一次闲聊模型');
    assert.equal(seen[0].card.name, '阿岩', '闲聊入参必须是启动时的卡');
    assert.equal(seen[0].card.address, '老板');
    assert.deepEqual(seen[0].card.bannedPhrases, ['收到啦', '好哒']);

    const commitments = promptTexts(ctx).filter((text) => text.includes('交周报'));
    assert.equal(commitments.length, 1);
    assert.ok(
      commitments[0].includes('老板，昨天说好的「交周报」，今天要不要推进一下？'),
      commitments[0],
    );
    assert.equal(loadFailureWarns(ctx).length, 0);
    assert.equal(conflictWarns(ctx).length, 0, '卡里没写 proactive，不应有冲突告警');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2) 运行期改卡不生效；重启才重读，warn 每次 apply 恰一条
// ---------------------------------------------------------------------------

test('集成（重启语义）：运行期改卡不生效且不重复 warn；重启用坏文件恰 1 条 warn，修好后恢复', async (t) => {
  const dir = tempCardDir(t);
  useTempDshHome(t, dir);
  const cardPath = writeCardFile(dir, FILE_CARD);

  // 第一次 apply：好卡。
  const ctx1 = makePluginCtx();
  const handle1 = apply(ctx1, { dbPath: ':memory:', persona: { cardPath: 'persona.json' } });
  try {
    assert.ok(coreTextOf(ctx1).includes('你是阿岩'));
    assert.equal(loadFailureWarns(ctx1).length, 0);
  } finally {
    // 运行期把文件改成坏 JSON：插件不重读，也不应追加 warn。
    writeFileSync(cardPath, '{ not json', 'utf8');
    const session = ctx1.addSession({ id: 'session-hot-edit' });
    await interact(ctx1, session, '今天有点累');
    assert.ok(coreTextOf(ctx1).includes('你是阿岩'), '运行期改文件不应影响已加载的卡');
    assert.equal(personaLineOf(ctx1), `人格卡：阿岩 v2（${cardPath}）`);
    assert.equal(loadFailureWarns(ctx1).length, 0, '运行期不应重读/重 warn');
    handle1.dispose();
  }

  // 第二次 apply：坏文件 → 恰一条加载 warn + 内置卡。
  const ctx2 = makePluginCtx();
  const handle2 = apply(ctx2, { dbPath: ':memory:', persona: { cardPath: 'persona.json' } });
  try {
    assert.equal(loadFailureWarns(ctx2).length, 1, '每次 apply 至多一条加载 warn');
    assert.ok(coreTextOf(ctx2).includes('你是珞然'));
    assert.match(personaLineOf(ctx2) ?? '', /^人格卡：珞然 v1（加载失败，已用内置：/u);
  } finally {
    handle2.dispose();
  }

  // 第三次 apply：修好文件（换成 version=3 的卡）→ 重启后读到新卡、无 warn。
  writeCardFile(dir, { ...FILE_CARD, name: '重启后', address: '老板', version: 3 });
  const ctx3 = makePluginCtx();
  const handle3 = apply(ctx3, { dbPath: ':memory:', persona: { cardPath: 'persona.json' } });
  try {
    assert.ok(coreTextOf(ctx3).includes('你是重启后'));
    assert.equal(personaLineOf(ctx3), `人格卡：重启后 v3（${cardPath}）`);
    assert.equal(loadFailureWarns(ctx3).length, 0);
  } finally {
    handle3.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3) 未配置卡：人格三段与 v0.4.12 逐字节相同；/状态 只多几行
// ---------------------------------------------------------------------------

test('集成（v0.4.12 等价）：未配置卡时人格三段 SHA-256 一致，/状态 除新增三行外逐行不变', () => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    for (const [name, expected] of Object.entries(V0412_SECTION_SHA256)) {
      const text = sectionOf(ctx, name);
      assert.equal(typeof text, 'string', `${name} 必须是静态文本`);
      assert.equal(
        createHash('sha256').update(text).digest('hex'),
        expected,
        `${name} 与 v0.4.12 基线逐字节不同`,
      );
    }

    const lines = statusTextOf(ctx).split('\n');
    const personaIndex = lines.findIndex((line) => line.startsWith('人格卡：'));
    assert.equal(personaIndex, 7, '人格卡行应插在线程 preset 与水位数之间');
    assert.equal(lines[personaIndex], '人格卡：珞然 v1（内置默认）');
    // P3-c：情绪行紧随人格卡行；未启用卡只显示「未启用」，不读写情绪表。
    const emotionIndex = lines.findIndex((line) => line.startsWith('情绪：'));
    assert.equal(emotionIndex, 9, '部署人设行插在人格卡与情绪行之间');
    assert.equal(lines[emotionIndex], '情绪：未启用');
    // P2（v0.4.13）：默认 off 也显式说明「宿主默认」，排障时不必猜配置。
    assert.equal(lines[8], '部署人设：宿主默认');
    // V50-L3：装配记录紧随情绪行；未启用情绪时只有段/遮蔽信息，没有情绪句。
    const assemblyIndex = lines.findIndex((line) => line.startsWith('最近一次装配：'));
    assert.equal(assemblyIndex, 10, '装配记录行插在情绪行之后、水位数之前');
    assert.match(lines[assemblyIndex], /部署人设 宿主默认；prefix 未改写/u);
    assert.match(lines[assemblyIndex], /段 safety \d+\/[0-9a-f]{8}、core \d+\/[0-9a-f]{8}、protocol \d+\/[0-9a-f]{8}/u);
    assert.equal(lines[assemblyIndex].includes('情绪句'), false, '情绪未启用时不该有情绪句');
    assert.equal(lines.length, V0412_STATUS_LINES.length + 4, '/状态 应只多人格卡、部署人设、情绪与装配记录四行');

    const withoutInjected = lines.filter(
      (line) => !line.startsWith('人格卡：')
        && !line.startsWith('部署人设：')
        && !line.startsWith('情绪：')
        && !line.startsWith('最近一次装配：'),
    );
    assert.match(withoutInjected[0], V0412_STATUS_HEAD);
    assert.equal(withoutInjected[0], V0412_STATUS_LINES[0]);
    assert.deepEqual(withoutInjected.slice(1), V0412_STATUS_LINES.slice(1));
    assert.equal(loadFailureWarns(ctx).length, 0);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4) B1 生产装配：状态板 + 召回 + 人格段 + /状态 行在一轮 pre-step 中同时可见
// ---------------------------------------------------------------------------

test('集成（B1 生产装配）：apply + pre-step 一轮时人格段 / 状态板 / 召回 / /状态 行同时可见', async () => {
  const temp = makeTempStore();
  stageBoard(temp.store, 'main', '- 周报周五交。');
  temp.store.insertFact({
    kind: 'project',
    subject_text: '周报',
    predicate: '提交时间',
    object_text: '周五',
    statement: '每周五要交周报。',
    source_kind: 'turn',
  });

  const ctx = makePluginCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const session = ctx.addSession({ id: 'session-b1-assembly' });
    const text = '周报什么时候交？';
    const userMessage = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
    ctx.emitSessionEvent(session.id, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text }] },
    });
    const decision = await ctx.dispatch('agent/pre-step', {
      agent: { id: session.id, session },
      messages: [userMessage],
      turn: 1,
      step: 1,
    }, { kind: 'enter', messages: [userMessage] });

    assert.equal(decision.messages.length, 2, '召回应以独立消息注入');
    assert.equal(decision.messages[1].source?.kind, 'companion-recall');
    const recallText = decision.messages[1].content.map((part) => part?.text ?? '').join('');
    assert.match(recallText, /^\[相关记忆\]/u);
    assert.ok(recallText.includes('周报'), recallText);

    const board = sectionOf(ctx, 'persona:state_board');
    assert.equal(typeof board, 'function', '状态板段用动态函数读已发布版本');
    assert.equal(board(), '[状态板]\n- 周报周五交。');

    assert.ok(coreTextOf(ctx).includes('你是珞然'));
    assert.equal(personaLineOf(ctx), '人格卡：珞然 v1（内置默认）');
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5) 失败兜底不阻断：坏 JSON + 改过的 proactive 配置仍能跑一轮 turn
// ---------------------------------------------------------------------------

test('集成（失败兜底）：坏 JSON 时 apply 不抛、两条 warn，仍能跑完一轮 turn 且闲聊照常投递', async (t) => {
  const temp = makeTempStore();
  const dir = tempCardDir(t);
  useTempDshHome(t, dir);
  writeCardFile(dir, '{ nope');

  const seen = [];
  const ctx = makePluginCtx({
    chatLlm: async (input) => {
      seen.push(input);
      return CHAT_WITH_BANNED;
    },
  });
  let handle;
  assert.doesNotThrow(() => {
    handle = apply(ctx, {
      dbPath: temp.dbPath,
      persona: { cardPath: 'persona.json' },
      proactiveDailyCap: 5,
      quietEnd: '07:30',
    });
  });
  try {
    assert.equal(loadFailureWarns(ctx).length, 1);
    assert.equal(conflictWarns(ctx).length, 1, '内置兜底卡也参与 proactive 冲突告警');
    assert.ok(coreTextOf(ctx).includes('你是珞然'));
    assert.match(personaLineOf(ctx) ?? '', /^人格卡：珞然 v1（加载失败，已用内置：/u);

    const session = ctx.addSession({ id: 'session-fallback-turn' });
    const decision = await interact(ctx, session, '今天有点累');
    assert.ok(Array.isArray(decision?.messages), 'pre-step 必须返回可继续的决策（messages 数组）');
    await firstTick(ctx);

    assert.equal(seen.length, 1, '兜底后闲聊仍应调用模型');
    assert.equal(seen[0].card.name, '珞然');
    assert.equal(
      promptTexts(ctx).filter((text) => text.includes('今天天气不错')).length,
      1,
      '内置卡不屏蔽该文案，闲聊应照常投递',
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6) B2 路径来源 b：未设置 DSH_HOME → 回退 <home>/.dsh
// ---------------------------------------------------------------------------

test('集成（B2 未设置 DSH_HOME）：相对 cardPath 回退 <home>/.dsh/persona.json，文件卡生效', (t) => {
  const temp = makeTempStore();
  const home = tempCardDir(t);
  mkdirSync(join(home, '.dsh'), { recursive: true });
  const cardPath = join(home, '.dsh', 'persona.json');
  writeFileSync(cardPath, JSON.stringify(FILE_CARD, null, 2), 'utf8');
  // 旧错误位置放一张同名卡做诱饵：修后行为必须只读 <.dsh> 下的这张。
  writeFileSync(join(home, 'persona.json'), JSON.stringify(OTHER_CARD, null, 2), 'utf8');

  const ctx = makePluginCtx();
  let handle;
  try {
    assert.doesNotThrow(() => {
      // 未设置 DSH_HOME（env 为空对象），homedir 注入临时 home，不读真实 ~/.dsh。
      handle = apply(
        ctx,
        { dbPath: temp.dbPath, persona: { cardPath: 'persona.json' } },
        { personaDeps: { env: {}, homedir: home } },
      );
    });
    assert.equal(loadFailureWarns(ctx).length, 0, '相对路径必须回退 ~/.dsh 并读到卡');
    assert.ok(coreTextOf(ctx).includes('你是阿岩，用户的私人管家。'));
    assert.ok(coreTextOf(ctx).includes('称呼用户为“老板”。'));
    assert.equal(coreTextOf(ctx).includes('替换后'), false, '旧位置 ~/persona.json 不能再生效');
    assert.equal(personaLineOf(ctx), `人格卡：阿岩 v2（${cardPath}）`);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7) B4 JSON 错误消息形状矩阵：5 种形状逐条兜底且不泄漏正文
// ---------------------------------------------------------------------------

test('集成（B4 JSON 错误消息形状矩阵）：5 种坏卡逐条兜底，warn 与 /状态 不泄漏卡正文且单行', async (t) => {
  for (const shape of BAD_JSON_SHAPES) {
    await t.test(shape.name, (t) => {
      const temp = makeTempStore();
      const dir = tempCardDir(t);
      const cardPath = writeCardFile(dir, shape.content);
      const ctx = makePluginCtx();
      let handle;
      try {
        assert.doesNotThrow(() => {
          handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
        }, `${shape.name}: apply 不能因坏 JSON 而抛`);

        const warns = loadFailureWarns(ctx);
        assert.equal(warns.length, 1, `${shape.name}: 加载失败只 warn 一次`);
        assert.deepEqual(Object.keys(warns[0].meta).sort(), ['path', 'reason']);
        assert.equal(warns[0].meta.path, cardPath);
        assert.ok(warns[0].meta.reason.includes('invalid JSON'));
        assert.equal(
          JSON.stringify(warns).includes(shape.sentinel),
          false,
          `${shape.name}: warn 所有字段都不能回显卡正文`,
        );

        const line = personaLineOf(ctx);
        assert.ok(line, `${shape.name}: /状态 必须有 人格卡 行`);
        assert.match(line, /^人格卡：珞然 v1（加载失败，已用内置：/u);
        assert.equal(line.includes(shape.sentinel), false, `${shape.name}: /状态 不能带卡正文`);
        if (shape.extraForbidden !== undefined) {
          assert.equal(line.includes(shape.extraForbidden), false, `${shape.name}: /状态 不能带 BOM`);
        }
        assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/u, `${shape.name}: /状态 行必须单行`);
        assert.ok(line.includes(warns[0].meta.reason), `${shape.name}: /状态 复用同一条安全原因`);

        assert.ok(coreTextOf(ctx).includes('你是珞然'), `${shape.name}: 兜底用内置卡`);
      } finally {
        handle?.dispose();
        temp.cleanup();
      }
    });
  }
});
