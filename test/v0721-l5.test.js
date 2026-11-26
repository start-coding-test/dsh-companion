// ⚠️ 非真机证据：本文件只验证 v0.7.21 L5「/状态 本轮 tokens 标注（估算）+ 插件版本行」
// 的代码行为，不代表真机 / 真实宿主上的渲染结果。首行判别力：删掉 formatTokenSnapshot
// 正常分支的「（估算）」→ L5-001（及 persona golden）变红；漏注入 pluginVersion 或把
// 版本写死成非 package.json 的值 → L5-001 版本断言变红；读取包元数据的兜底缺失 →
// L5-003 变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { handleCommand } from '../src/runtime/commands.js';
import { TEST_NOW, makeTempStore } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** 包元数据里的真实版本号（与 /状态 的「插件：」行必须一致，防止硬编码蒙混）。 */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/**
 * 严格 FakeCtx + commands/tools 注册记录器（与 persona-card e2e 同构）。
 * @param {object} [options] 透传给 FakeCtx（returns/fail/missing/...）
 */
function makePluginCtx(options = {}) {
  const ctx = new FakeCtx({ now: TEST_NOW, strict: true, ...options });
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

/** @param {FakeCtx} ctx @returns {string} */
function statusTextOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  const result = registration.handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  return result.text;
}

/** 走一轮真实 pre-step，让 tokenMeter 的测量值落到 metrics 里。 */
async function dispatchOneTurn(ctx, sessionId, text) {
  const session = ctx.addSession({ id: sessionId });
  const userMessage = {
    id: `${sessionId}-m1`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
  ctx.emitSessionEvent(session.id, {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }] },
  });
  await ctx.dispatch('agent/pre-step', {
    agent: { id: session.id, session },
    messages: [userMessage],
    turn: 1,
    step: 1,
  }, { kind: 'enter', messages: [userMessage] });
  return session;
}

test('L5-001（v0.7.21 非真机证据）：真实 apply + 一轮 pre-step 后 /状态 把本轮 tokens 标为估算，数字仍等于 tokenMeter 测量值', async () => {
  const temp = makeTempStore();
  // totalTokens=8000 / surfaceDeltaTokens=1200 是本例的受控测量值；
  // 标注只加文字，数值必须原样来自 measure（公式不动）。
  const ctx = makePluginCtx({
    returns: { 'tokenMeter.measure': { totalTokens: 8000, surfaceDeltaTokens: 1200 } },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    await dispatchOneTurn(ctx, 'session-l5-001', '记住：周报周五交。');
    const lines = statusTextOf(ctx).split('\n');

    assert.match(
      lines[0],
      /\/ tokens 本轮（估算） 入 8000 出 1200（超预算 0 次）｜今日 0\/3000000｜RSS ok \d+MB｜向量：关$/u,
      '正常分支必须标「（估算）」且 入/出 仍等于 tokenMeter 的 totalTokens/surfaceDeltaTokens',
    );
    assert.equal(
      lines[0].includes('tokens 本轮 入'),
      false,
      '未标注的「tokens 本轮 入」不许再出现在正常分支',
    );

    const mainIndex = lines.findIndex((line) => line.startsWith('主会话：'));
    assert.notEqual(mainIndex, -1, '/状态 应有主会话行');
    assert.equal(
      lines[mainIndex + 1],
      `插件：dsh-companion v${PACKAGE_VERSION}`,
      '插件版本行必须紧随主会话行，且版本取自 package.json',
    );
    assert.equal(lines.filter((line) => line.startsWith('插件：')).length, 1);
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

test('L5-002（v0.7.21 非真机证据）：实测压缩底与最近压后底不误标估算，兜底 tokens 本轮 0 也保持原格式', () => {
  const temp = makeTempStore();
  try {
    // 接线层把 schema_meta 里的实测样本 `compact_floor:<scope>` 以 compact.floor 传给
    // 命令层（src/index.js status 分支）；这里走同一个命令层入口，样本取自实测值。
    const measured = handleCommand({
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      scope: 'main',
      metrics: null,
      compact: { floor: 38800, target: 100000, minIncrementTokens: 4096, cooldownTurns: 3 },
      backfill: { enabled: true, cursorSeq: null, maxPerDay: 20, todayCount: 1, lastFloor: 8192 },
    });
    assert.equal(measured.handled, true);

    const floorLine = measured.reply
      .split('\n')
      .find((line) => line.startsWith('压缩底：'));
    assert.ok(floorLine, '有实测样本时 /状态 应输出压缩底行');
    assert.match(floorLine, /^压缩底：38800 tokens（目标 100000，增量门槛 4096，冷却 3 轮）$/u);
    assert.equal(floorLine.includes('估算'), false, '实测压缩底不标注估算');

    const backfillLine = measured.reply
      .split('\n')
      .find((line) => line.startsWith('回填：'));
    assert.ok(backfillLine, '开了 compact.backfill 时 /状态 应输出回填行');
    assert.match(backfillLine, /最近压后底 8192 tokens$/u, '最近压后底仍用实测数字与原格式');
    assert.equal(backfillLine.includes('估算'), false, '实测最近压后底不标注估算');

    // 既有兜底行为不变：没有 metrics 时仍是「tokens 本轮 0」，不冒称估算。
    assert.ok(measured.reply.includes('/ tokens 本轮 0｜'), '无 metrics 的兜底格式不变');
    assert.equal(measured.reply.includes('tokens 本轮（估算）'), false);
  } finally {
    temp.cleanup();
  }
});

test('L5-003（v0.7.21 非真机证据）：包元数据读取失败时 /状态 省略插件行且其余行照常（缺失注入受控测试）', async () => {
  // (a) 命令层契约：null / 空串 / 纯空白不输出「插件：」行；非空才输出。
  const temp = makeTempStore();
  try {
    const base = {
      text: '/状态',
      store: temp.store,
      now: TEST_NOW,
      scope: 'main',
      metrics: null,
    };
    for (const pluginVersion of [null, '', '   ']) {
      const result = handleCommand({ ...base, pluginVersion });
      assert.equal(result.handled, true);
      assert.equal(
        result.reply.split('\n').some((line) => line.startsWith('插件：')),
        false,
        `pluginVersion=${JSON.stringify(pluginVersion)} 时不应有插件行`,
      );
    }
    const present = handleCommand({ ...base, pluginVersion: '9.9.9-controlled' });
    assert.ok(
      present.reply.includes('插件：dsh-companion v9.9.9-controlled'),
      '非空版本号应原样出现在插件行',
    );
  } finally {
    temp.cleanup();
  }

  // (b) 真读不到 package.json：把 src 复制到没有 package.json 的临时目录再 apply。
  //     读版本失败必须被 try/catch 吞掉 → 省略插件行，/状态 仍成功。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-l5-nopkg-'));
  const temp2 = makeTempStore();
  let handle2 = null;
  try {
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(dir, 'src'), {
      recursive: true,
    });
    const mod = await import(pathToFileURL(join(dir, 'src', 'index.js')).href);
    const ctx = makePluginCtx();
    handle2 = mod.apply(strictCtx(ctx), { dbPath: temp2.dbPath });
    const lines = statusTextOf(ctx).split('\n');
    assert.equal(
      lines.some((line) => line.startsWith('插件：')),
      false,
      '读不到 package.json 时必须整行省略，不能猜版本',
    );
    assert.ok(
      lines.some((line) => line.startsWith('主会话：')),
      '省略插件行不影响其它状态行',
    );
    assert.match(lines[0], /tokens 本轮（估算）/u, 'token 标注与版本读取互不影响');
  } finally {
    if (handle2 !== null) handle2.dispose();
    temp2.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
