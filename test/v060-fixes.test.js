/**
 * v0.6 复审 r1 的回归测试（M1 / M2）：
 * - M1：斜杠命令不判定——llm 卡也不发请求、不写事件。
 * - M2：模型给的 intensity 真正参与物理增量（不再只按 confidence 回落）。
 *
 * 固定时钟 + 临时 DSH_HOME，不联网、不读真实时间、不写用户目录。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CARD } from '../src/persona/card.js';
import { APPRAISAL_ERRORS, AppraisalError, parseAppraisal } from '../src/persona/emotion-appraise.js';
import { apply as applyCordis } from '../src/index.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore, TEST_NOW } from './e2e/helpers.js';

function makePluginCtx(now = TEST_NOW) {
  const ctx = new FakeCtx({ now, strict: true });
  ctx.commands = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  ctx.tools = { registrations: [], register(d) { this.registrations.push(d); return () => {}; } };
  return ctx;
}

function useTempDshHome(t, dir) {
  const previous = Object.prototype.hasOwnProperty.call(process.env, 'DSH_HOME') ? process.env.DSH_HOME : undefined;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
}

function writeCard(dir) {
  const card = structuredClone(DEFAULT_CARD);
  card.emotion = { ...card.emotion, enabled: true, appraiser: 'llm', appraiseTimeoutMs: 2000 };
  const path = join(dir, 'persona.json');
  writeFileSync(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

async function pollUntil(check, label, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function turnPayload(session, messages) {
  return {
    agent: { session: { header: { id: session.id, cwd: 'C:\\work', version: 4, isSeeded: false } } },
    step: 1,
    messages,
  };
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** 起一个插件实例，跑一轮 pre-step，返回该轮落库的第一条非 ambient 事件（可能为 null）。 */
async function runTurn(t, { verdict, text = '你怎么又忘了', extraTexts = [], expectEvent = true }) {
  const temp = makeTempStore();
  const home = mkdtempSync(join(tmpdir(), 'dsh-companion-v060b-'));
  useTempDshHome(t, home);
  const cardPath = writeCard(home);
  const ctx = makePluginCtx();
  let requests = 0;
  ctx.llm = {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    async *stream() {
      requests += 1;
      yield { type: 'text-delta', text: JSON.stringify(verdict) };
      yield { type: 'finish', reason: { kind: 'ok' } };
    },
  };
  const session = ctx.addSession({ id: `session-${randomUUID()}` });
  const handle = applyCordis(strictCtx(ctx), { dbPath: temp.dbPath, persona: { cardPath } });
  t.after(() => {
    handle.dispose();
    temp.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage(text)]), { kind: 'enter', messages: [] });
  for (const extra of extraTexts) {
    await ctx.dispatch('agent/pre-step', turnPayload(session, [userMessage(extra)]), { kind: 'enter', messages: [] });
  }
  const events = expectEvent
    ? await pollUntil(
      () => {
        const rows = temp.store.listEmotionEvents('main', 20).filter((row) => row.type !== 'ambient');
        return rows.length > 0 ? rows : null;
      },
      '事件落库',
    )
    : null;
  if (!expectEvent) await new Promise((resolve) => setTimeout(resolve, 80));
  return { temp, ctx, events, requests: () => requests };
}

test('M1 回归：斜杠命令不判定（不发请求、不写事件）', async (t) => {
  const run = await runTurn(t, {
    verdict: { target: 'her', type: 'blame', intensity: 0.8, confidence: 0.9 },
    text: '/状态',
    extraTexts: ['/foo', '/记忆 列表'],
    expectEvent: false,
  });
  assert.equal(run.requests(), 0, '斜杠命令不得触发模型判定');
  assert.equal(run.temp.store.countEmotionEvents('main'), 0, '斜杠命令不得写情绪事件');
});

test('L8 回归：一轮普通消息只入账一次（不重复记事件）', async (t) => {
  const run = await runTurn(t, {
    verdict: { target: 'her', type: 'blame', intensity: 0.8, confidence: 0.9 },
    text: '你怎么又忘了',
  });
  // 等后台落库稳定，再断言「只入账一次」。
  await new Promise((resolve) => setTimeout(resolve, 120));
  const llmRows = run.temp.store.listEmotionEvents('main', 50).filter((row) => row.note === 'llm');
  assert.equal(llmRows.length, 1, '同一事件只应入账一次');
  assert.equal(run.requests(), 1, '同一轮只应发一次判定请求');
});

test('M2 回归：模型 intensity 小则增量小、大则增量大（同一 confidence）', async (t) => {
  const weak = await runTurn(t, {
    verdict: { target: 'her', type: 'blame', intensity: 0.1, confidence: 0.9 },
  });
  const strong = await runTurn(t, {
    verdict: { target: 'her', type: 'blame', intensity: 0.9, confidence: 0.9 },
  });
  const weakDelta = Math.abs(weak.events[0].deltas.pleasure);
  const strongDelta = Math.abs(strong.events[0].deltas.pleasure);
  assert.ok(weakDelta > 0 && strongDelta > 0);
  assert.ok(
    strongDelta > weakDelta * 1.5,
    `intensity 0.9 的增量应明显大于 0.1：weak=${weakDelta} strong=${strongDelta}`,
  );
});

test('parseAppraisal：多出来的键（例如 PAD 增量）一律算失败', () => {
  const raw = '{"target":"her","type":"blame","intensity":0.5,"confidence":0.6,"pleasure":-3}';
  assert.throws(() => parseAppraisal(raw), (error) => {
    assert.ok(error instanceof AppraisalError);
    assert.equal(error.code, APPRAISAL_ERRORS.invalid);
    return true;
  });
});
