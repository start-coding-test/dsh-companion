/**
 * v0.4.7 集成回归（V6-M1 / V6-L1 / V6-L3 + v10 → v11 迁移）。
 *
 * 与专项测试互补：这里全部走真实插件入口 `apply()` + FakeCtx + 真实 Store /
 * 临时库，把三项修复放回同一条链路里，确认它们没有互相踩踏：
 *   1. 调度器 tick → 提醒投递：同一 occurrence 连续失败两次 requestId 不变、
 *      attempts 递增且仍 pending；成功投递后下一次到点 requestId 变化、
 *      attempts 归零，再失败 1 次不 expired；
 *   2. v10 旧库经 apply() 打开后迁移到 v11，旧行 occurrence_key 为 NULL，
 *      到点仍能正常生成 occurrence 并完成投递；
 *   3. /状态 的运行时路由标注为「（自动选取）」；
 *   4. llm/provider 发现失败 warn 去重：连续两次探测只 1 条，发现成功后
 *      重置，再次失败可再 warn 一次（provider 与 model 两类）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';

import { TEST_NOW, makeTempStore, settle, toEpochSeconds } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

const PROVIDER_WARN = '[dsh-companion] llm provider discovery failed';
const MODEL_WARN = '[dsh-companion] llm model discovery failed';

/** 基础 FakeCtx：commands/tools 注册桩 + tokenMeter 默认值。 */
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

/** sessionController.prompt 的请求/文本快照（捕获完整 args）。 */
function promptCalls(ctx) {
  return ctx.callsOf('sessionController.prompt').map((call) => {
    const request = call.args[0];
    const content = request?.content;
    return {
      request,
      signal: call.args[1],
      text: Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '',
    };
  });
}

function commandOf(ctx, name) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition;
}

function statusText(ctx) {
  return commandOf(ctx, 'status').handler({ rawInput: '' }).text;
}

/** 同一 title 的 warn 日志条数（fake logger 计数）。 */
function warnsAbout(ctx, message) {
  return ctx.logs.filter((entry) => entry.level === 'warn' && entry.message === message);
}

/** 调度器基线在 apply 时刻，先过一个周期再 tick。 */
async function firstTick(ctx) {
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
}

/** 插入一条已到期的普通提醒。 */
function dueReminder(store, title, nowMs = TEST_NOW) {
  const nowSeconds = toEpochSeconds(nowMs);
  return store.insertReminder({
    kind: 'todo',
    title,
    due_at: nowSeconds - 60,
    next_fire_at: nowSeconds - 60,
    due_granularity: 'exact',
  });
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

// ------------------------------------------------------------ V6-M1

test('v0.4.7 回归：提醒连续失败两次 requestId 不变，成功换代后 attempts 归零（再失败不 expired）', async (t) => {
  const temp = makeTempStore();
  temp.store.setMeta('main_session_id', 'main-1');
  const ctx = makeCtx();
  // 本用例要投 4 次（3 次同一 occurrence + 1 次下一 occurrence），放宽日上限。
  const handle = apply(ctx, { dbPath: temp.dbPath, proactiveDailyCap: 10 });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  const reminder = dueReminder(temp.store, '交房租');
  ctx.fail('sessionController.prompt');

  // 第一次失败：入队前生成 occurrence，requestId 由它决定。
  await firstTick(ctx);
  let calls = promptCalls(ctx);
  assert.equal(calls.length, 1, '失败后不应在同一次 flush 里重复投递');
  const firstRequestId = calls[0].request.requestId;
  let row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.delivery_attempts, 1);
  const occurrence = row.occurrence_key;
  assert.ok(occurrence, '入队前必须生成 occurrence_key');
  assert.equal(
    firstRequestId,
    `companion-reminder:${reminder.id}:${occurrence}`,
    'requestId 必须由 occurrence 决定',
  );
  assert.equal(calls[0].signal.rpcId, firstRequestId, '旧宿主兼容：signal 上附 rpcId');
  const firstRetryAt = row.next_fire_at;

  // 退避 30s 后第二次失败：next_fire_at 被改写，但 requestId 完全一致。
  ctx.advance(30_000);
  await ctx.fireTimers();
  await settle(50);
  calls = promptCalls(ctx);
  assert.equal(calls.length, 2, '退避到期后应重试一次');
  assert.equal(calls[1].request.requestId, firstRequestId, '同一 occurrence 的重试 rpcId 不得变化');
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'pending', '失败两次仍 pending');
  assert.equal(row.delivery_attempts, 2, 'attempts 按尝试递增到 2');
  assert.equal(row.occurrence_key, occurrence);
  assert.equal(row.next_fire_at, firstRetryAt + 60, '退避 60s 确实改写了 next_fire_at');
  assert.match(statusText(ctx), /最近失败：投递失败/u, '连续失败仍可从 /状态 看到');

  // 退避 60s 后第三次成功：fired，occurrence/计数全部复位。
  ctx.failures.delete('sessionController.prompt');
  ctx.advance(60_000);
  await ctx.fireTimers();
  await settle(50);
  calls = promptCalls(ctx);
  assert.equal(calls.length, 3, '第三次应投递成功');
  assert.equal(calls[2].request.requestId, firstRequestId, '同一次到点内成功投递仍用同一 requestId');
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'fired');
  assert.equal(row.occurrence_key, null);
  assert.equal(row.last_fire_key, null);
  assert.equal(row.delivery_attempts, 0, '成功投递后 attempts 必须归零');

  // 模拟下一个到点：requestId 换代、attempts 从 0 重新计，失败 1 次不 expired。
  const nextFire = toEpochSeconds(ctx.now()) + 60;
  temp.store.db
    .prepare("UPDATE reminders SET status = 'pending', next_fire_at = ? WHERE id = ?")
    .run(nextFire, reminder.id);
  ctx.advance(3 * 60 * 60 * 1000);
  ctx.fail('sessionController.prompt');
  await ctx.fireTimers();
  await settle(50);

  calls = promptCalls(ctx);
  assert.equal(calls.length, 4, '下一个到点应重新入队投递一次');
  assert.notEqual(calls[3].request.requestId, firstRequestId, '下一次到点必须换新 requestId');
  row = temp.store.getReminder(reminder.id);
  assert.equal(row.status, 'pending', '失败 1 次仍 pending');
  assert.notEqual(row.status, 'expired', '成功换代后的首次失败不得被旧计数提前 expired');
  assert.equal(row.delivery_attempts, 1, 'attempts 从 0 重新计，不继承上一次到点的计数');
  assert.ok(row.occurrence_key);
  assert.notEqual(row.occurrence_key, occurrence);
  assert.equal(
    calls[3].request.requestId,
    `companion-reminder:${reminder.id}:${row.occurrence_key}`,
  );
});

// ------------------------------------------------------------ v10 → v11

test('v0.4.7 回归：v10 旧库经 apply 迁移到 v11，occurrence_key 为 NULL 且到点可投递', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-v10-regress-'));
  const dbPath = join(dir, 'companion.db');
  const dueAt = toEpochSeconds(TEST_NOW) - 60;

  // v10 的真实形态：status 已含 delivering，有 delivery_attempts，没有 occurrence_key。
  const V10_REMINDERS_DDL = `
    CREATE TABLE reminders (
      id                TEXT PRIMARY KEY,
      scope             TEXT NOT NULL DEFAULT 'main',
      kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
      title             TEXT NOT NULL,
      detail            TEXT,
      counterparty      TEXT,
      due_at            INTEGER,
      due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
      rrule             TEXT,
      next_fire_at      INTEGER,
      last_fire_key     TEXT,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
      closed_at         INTEGER,
      source_episode_id TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at        INTEGER
    );
    CREATE INDEX ix_rm_fire ON reminders(status, next_fire_at) WHERE status IN ('pending','snoozed');
    CREATE INDEX ix_rm_done ON reminders(closed_at) WHERE status IN ('done','cancelled');
  `;
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '10');
    INSERT INTO schema_meta (key, value) VALUES ('main_session_id', 'main-1');
  `);
  legacy.exec(V10_REMINDERS_DDL);
  legacy
    .prepare(`
      INSERT INTO reminders (id, kind, title, due_at, due_granularity, next_fire_at, status)
      VALUES ('old-10', 'todo', '旧提醒', ?, 'exact', ?, 'pending')
    `)
    .run(dueAt, dueAt);
  legacy.close();

  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath });
  t.after(() => {
    handle.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // 迁移在 apply 打开 Store 时完成；旧行 occurrence_key 为 NULL 但可直接投递。
  await firstTick(ctx);
  const calls = promptCalls(ctx);
  assert.equal(calls.length, 1, 'v10 旧行的到期提醒应正常入队投递');
  assert.equal(calls[0].text, '[提醒] 旧提醒');
  const requestId = calls[0].request.requestId;
  assert.match(
    requestId,
    /^companion-reminder:old-10:.+$/u,
    '旧行到点后也必须生成 occurrence 并写入 requestId',
  );

  handle.dispose();
  const reopened = Store.open(dbPath);
  try {
    assert.equal(reopened.getMeta('schema_version'), '12');
    const migrated = reopened.getReminder('old-10');
    assert.equal(migrated.status, 'fired', '迁移后的旧行应完成投递');
    assert.equal(migrated.occurrence_key, null, '成功投递后 occurrence_key 清空');
    assert.equal(migrated.last_fire_key, null);
    assert.equal(migrated.delivery_attempts, 0);
  } finally {
    reopened.close();
  }
});

// ------------------------------------------------------------ V6-L1

test('v0.4.7 回归：/状态 的运行时巩固路由标注「自动选取」', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  ctx.llm = fakeLlm({
    providers: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });

  await settle(30);
  const text = statusText(ctx);
  assert.match(text, /巩固：deepseek-official\/deepseek-chat（自动选取）/u);
  assert.doesNotMatch(text, /（运行时）/u, '自动选取不得再标成「运行时」');
  assert.doesNotMatch(text, /巩固：无可用模型/u);
});

// ------------------------------------------------------------ V6-L3

test('v0.4.7 回归：llm 发现失败 warn 去重，发现成功后重置（provider 与 model 两类）', async (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  let providersFailing = true;
  let modelsFailing = false;
  ctx.llm = fakeLlm({
    providers: () => {
      if (providersFailing) throw new Error('providers down');
      return [{ id: 'deepseek-official', name: 'DeepSeek' }];
    },
    models: () => {
      if (modelsFailing) throw new Error('models down');
      return [];
    },
  });
  const handle = apply(ctx, { dbPath: temp.dbPath });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
  });
  await settle(30);

  // 阶段 1：provider 发现失败只 warn 一次；连续两次探测不重复。
  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1, '首次 provider 发现失败只 warn 一次');
  assert.match(statusText(ctx), /巩固：无可用模型/u);
  for (let round = 0; round < 2; round += 1) {
    ctx.advance(61_000);
    statusText(ctx);
    await settle(30);
  }
  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1, '连续两次发现失败不得重复 warn');

  // provider 发现恢复（空模型仍算恢复）：去重键清空，再次失败可再 warn 一次。
  providersFailing = false;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, PROVIDER_WARN).length, 1);
  providersFailing = true;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  const providerWarns = warnsAbout(ctx, PROVIDER_WARN);
  assert.equal(providerWarns.length, 2, '成功发现后再次失败应重新 warn 一次');
  assert.equal(providerWarns[1].meta.reason, 'providers');

  // 阶段 2：provider 恢复、某 provider 的 listModels 失败同样只 warn 一次。
  providersFailing = false;
  modelsFailing = true;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  const modelWarns = warnsAbout(ctx, MODEL_WARN);
  assert.equal(modelWarns.length, 1, '首次模型发现失败只 warn 一次');
  assert.equal(modelWarns[0].meta.provider, 'deepseek-official');
  assert.equal(modelWarns[0].meta.reason, 'models:deepseek-official');

  for (let round = 0; round < 2; round += 1) {
    ctx.advance(61_000);
    statusText(ctx);
    await settle(30);
  }
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 1, '连续两次模型发现失败不得重复 warn');

  // 模型发现恢复（空列表也算恢复）后再失败：可再 warn 一次。
  modelsFailing = false;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 1);
  modelsFailing = true;
  ctx.advance(61_000);
  statusText(ctx);
  await settle(30);
  assert.equal(warnsAbout(ctx, MODEL_WARN).length, 2, '成功发现后再次失败应重新 warn 一次');
});
