/**
 * v0.6-E4/E5：判定器可观测性与评测脚本（模型判定器）测试。
 *
 * - createLlmJudge：端点/鉴权/请求体、HTTP 失败、非 JSON 内容。
 * - analyzeGoldenWithAppraiser：门槛用 LLM 口径、判定失败单列并阻断通过。
 * - parseArgs：--input / --appraiser 的参数校验。
 * - /状态：判定器行三态（规则无样本、模型有样本、最近失败）。
 *
 * 不联网：fetch 用本地 mock 实现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  THRESHOLDS_LLM,
  analyzeGoldenWithAppraiser,
  createLlmJudge,
  parseArgs,
} from '../scripts/emotion-report.mjs';
import { APPRAISAL_ERRORS, AppraisalError } from '../src/persona/emotion-appraise.js';
import { handleCommand } from '../src/runtime/commands.js';
import { makeTempStore } from './e2e/helpers.js';

const ENV = Object.freeze({
  EMOTION_APPRAISE_BASE_URL: 'https://example.invalid/v1',
  EMOTION_APPRAISE_API_KEY: 'sk-test',
  EMOTION_APPRAISE_MODEL: 'judge-1',
});

test('createLlmJudge：请求端点、鉴权头、模型与分隔块文本', async () => {
  const calls = [];
  const judge = createLlmJudge(ENV, async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '{"target":"her","type":"blame","intensity":0.8,"confidence":0.9}' } }] };
      },
    };
  });
  const verdict = await judge('你怎么又忘了');
  assert.deepEqual(verdict, { type: 'blame', confidence: 0.9 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'judge-1');
  assert.equal(body.temperature, 0);
  assert.match(body.messages[1].content[0].text, /你怎么又忘了/u);
});

test('createLlmJudge：缺少环境变量、HTTP 失败、内容非 JSON 都抛错', async () => {
  assert.throws(() => createLlmJudge({}, async () => ({})), /缺少环境变量/u);

  const httpFail = createLlmJudge(ENV, async () => ({ ok: false, status: 500 }));
  await assert.rejects(() => httpFail('x'), /HTTP 500/u);

  const badJson = createLlmJudge(ENV, async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: '我觉得有点生气' } }] };
    },
  }));
  await assert.rejects(() => badJson('x'), (error) => {
    assert.ok(error instanceof AppraisalError);
    assert.equal(error.code, APPRAISAL_ERRORS.invalid);
    return true;
  });
});

test('analyzeGoldenWithAppraiser：按 LLM 门槛判定，失败条数单列并阻断通过', async () => {
  const records = [
    { text: '甲', type: 'blame' },
    { text: '乙', type: 'none' },
    { text: '丙', type: 'care' },
  ];
  const verdicts = { 甲: 'blame', 乙: 'none', 丙: 'care' };
  const report = await analyzeGoldenWithAppraiser(records, async (text) => ({
    type: verdicts[text],
    confidence: 0.9,
  }));
  assert.equal(report.correct, 3);
  assert.equal(report.thresholds, THRESHOLDS_LLM);
  assert.equal(report.errors, 0);
  assert.equal(report.passed, true);

  const broken = await analyzeGoldenWithAppraiser(records, async (text) => {
    if (text === '乙') throw new Error('boom');
    return { type: verdicts[text], confidence: 0.9 };
  });
  assert.equal(broken.errors, 1);
  assert.deepEqual(broken.errorKinds, [['boom', 1]]);
  assert.equal(broken.checks.noErrors, false);
  assert.equal(broken.passed, false);
});

test('parseArgs：--input / --appraiser 校验', () => {
  assert.deepEqual(parseArgs(['a.jsonl']), { mode: 'auto', input: 'a.jsonl' });
  assert.deepEqual(parseArgs(['--confusion', 'a.jsonl']), { mode: 'confusion', input: 'a.jsonl' });
  assert.deepEqual(parseArgs(['--input', 'a.jsonl', '--appraiser', 'llm']), { mode: 'llm', input: 'a.jsonl' });
  assert.throws(() => parseArgs(['--input']), /--input/u);
  assert.throws(() => parseArgs(['--input', 'a', '--appraiser', 'model']), /rules 或 llm/u);
  assert.throws(() => parseArgs(['--nope', 'a']), /未知参数/u);
  assert.throws(() => parseArgs(['a', 'b']), /只能给一个/u);
  assert.throws(() => parseArgs([]), /缺少输入文件/u);
});

// ---------------------------------------------------------------- E4 /状态

/** @param {'rules'|'llm'} mode @param {object|null} stats */
function statusWithAppraiser(t, mode, stats) {
  const temp = makeTempStore({ t });
  const now = 1_700_000_000_000;
  return handleCommand({
    text: '/状态',
    store: temp.store,
    now,
    appraiser: stats === null ? { mode } : { mode, stats },
  }).reply;
}

test('/状态：规则模式无样本', (t) => {
  const reply = statusWithAppraiser(t, 'rules', null);
  assert.match(reply, /判定器：规则（近 24h 无判定）/u);
});

test('/状态：模型模式展示来源占比、延迟与 p95、最近失败', (t) => {
  const reply = statusWithAppraiser(t, 'llm', {
    llm: 7,
    rules: 0,
    fallback: 3,
    total: 10,
    avgMs: 412,
    p95Ms: 900,
    lastError: { at: 1_700_000_000_000, code: 'timeout' },
  });
  assert.match(reply, /判定器：模型/u);
  assert.match(reply, /近 24h 模型 7（70%）/u);
  assert.match(reply, /规则兜底 3（30%）/u);
  assert.match(reply, /平均 412ms/u);
  assert.match(reply, /p95 900ms/u);
  assert.match(reply, /最近失败 timeout/u);
});

test('/状态：模型模式无样本时写「无判定」', (t) => {
  const reply = statusWithAppraiser(t, 'llm', { llm: 0, rules: 0, fallback: 0, total: 0, avgMs: null, p95Ms: null, lastError: null });
  assert.match(reply, /判定器：模型（近 24h 无判定）/u);
});
