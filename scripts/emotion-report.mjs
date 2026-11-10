#!/usr/bin/env node
/**
 * 情绪分类只读报告（V50 / V52）：
 * - 文本模式：按行跑 classify，统计每类命中数与置信度分布；
 * - 混淆矩阵模式：读 JSONL 标注集，输出混淆矩阵、准确率门槛与错例。
 *
 * 用法：
 *   node scripts/emotion-report.mjs <文本文件>
 *   node scripts/emotion-report.mjs -                      # 从 stdin 读文本
 *   node scripts/emotion-report.mjs --confusion <golden.jsonl|->
 *   node scripts/emotion-report.mjs --input <golden.jsonl> --appraiser llm
 *   node scripts/emotion-report.mjs <golden.jsonl>         # 自动识别 JSONL
 *
 * 只读：不打开数据库、不写任何文件，结果全部走 stdout。
 * 退出码：文本模式 0 成功 / 1 读取失败 / 2 用法错误；
 *         混淆矩阵模式 0 达标 / 1 不达标（或读取失败）/ 2 用法错误。
 */
import { readFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { pathToFileURL } from 'node:url';

import { EVENT_TYPES, classify } from '../src/persona/emotion.js';
import { buildAppraisalMessages, parseAppraisal } from '../src/persona/emotion-appraise.js';

/** 发版门（与 test/emotion-golden.test.js 共用）。 */
export const THRESHOLDS = Object.freeze({
  /** 总体准确率下限。 */
  accuracy: 0.85,
  /** blame 误报上限（标注不是 blame 却判 blame 的句数）。 */
  blameFalsePositives: 2,
  /** 中性句（标注 none）被误触发成任何事件的比例上限。 */
  neutralFalseTriggerRate: 0.1,
});

/** 模型判定器的门槛（评审方留出集口径：准确率 ≥80%、blame 误报 = 0、中性误触发 ≤2/13）。 */
export const THRESHOLDS_LLM = Object.freeze({
  accuracy: 0.8,
  blameFalsePositives: 0,
  neutralFalseTriggerRate: 2 / 13,
});

/** 混淆矩阵的固定标签顺序：12 个事件类型 + none。 */
const LABELS = Object.freeze([...EVENT_TYPES, 'none']);
const LABEL_SET = new Set(LABELS);

const USAGE = [
  '用法：',
  '  node scripts/emotion-report.mjs <文本文件|->                 按行统计类型分布',
  '  node scripts/emotion-report.mjs --confusion <golden.jsonl|->  混淆矩阵与门槛',
  '  node scripts/emotion-report.mjs --input <golden.jsonl> --appraiser llm',
  '                                            模型判定器（环境变量提供端点、密钥、模型）',
  '  JSONL（每行 {"text": "...", "type": "..."}）会自动按混淆矩阵模式处理。',
].join('\n');

/**
 * 逐行分类并汇总。
 * 空行/纯空白行跳过，不计入总数。
 *
 * @param {string} text
 * @returns {{total:number, misses:number, stats:Array<{type:string,count:number,mean:number,max:number}>}}
 */
export function analyze(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`analyze(text): text must be a string (got ${typeof text})`);
  }
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  /** @type {Map<string, number[]>} */
  const buckets = new Map(EVENT_TYPES.map((type) => [type, []]));
  let misses = 0;
  for (const line of lines) {
    const { type, confidence } = classify(line);
    if (confidence <= 0) {
      misses += 1;
      continue;
    }
    // classify 的命中类型一定在 EVENT_TYPES 内；防御性写入，未知类型按未命中处理。
    const bucket = buckets.get(type);
    if (bucket === undefined) misses += 1;
    else bucket.push(confidence);
  }
  const stats = [];
  for (const type of EVENT_TYPES) {
    const values = buckets.get(type) ?? [];
    const count = values.length;
    const sum = values.reduce((total, value) => total + value, 0);
    stats.push({
      type,
      count,
      mean: count === 0 ? 0 : round2(sum / count),
      max: count === 0 ? 0 : round2(Math.max(...values)),
    });
  }
  return { total: lines.length, misses, stats };
}

/**
 * 渲染文本模式报告（不写任何文件）。
 * @param {{total:number, misses:number, stats:Array<{type:string,count:number,mean:number,max:number}>}} report
 * @returns {string}
 */
export function render(report) {
  const lines = [];
  lines.push(`情绪分类报告：共 ${report.total} 行（空行已跳过）`);
  lines.push('类型              命中   平均置信度   最高置信度');
  for (const row of report.stats) {
    lines.push(
      `${row.type.padEnd(16)}${String(row.count).padStart(5)}`
      + `${row.mean.toFixed(2).padStart(12)}${row.max.toFixed(2).padStart(12)}`,
    );
  }
  const ratio = report.total === 0 ? 0 : report.misses / report.total;
  lines.push(
    `未命中：${report.misses}/${report.total}（${(ratio * 100).toFixed(1)}%）`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * 解析 JSONL 标注集；每行必须是 `{"text": "...", "type": "..."}`。
 * 空行跳过；`complain` 已退役，拒绝读入。
 *
 * @param {string} text
 * @returns {Array<{line:number, text:string, type:string}>}
 */
export function parseGolden(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`parseGolden(text): text must be a string (got ${typeof text})`);
  }
  const raw = text.split(/\r?\n/u);
  const records = [];
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index].trim();
    if (line === '') continue;
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`第 ${lineNumber} 行不是合法 JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`第 ${lineNumber} 行不是 JSON 对象`);
    }
    if (typeof parsed.text !== 'string' || parsed.text.trim() === '') {
      throw new Error(`第 ${lineNumber} 行缺少非空 text`);
    }
    if (typeof parsed.type !== 'string') {
      throw new Error(`第 ${lineNumber} 行缺少 type`);
    }
    if (parsed.type === 'complain') {
      throw new Error(`第 ${lineNumber} 行使用了已退役的 complain`);
    }
    if (!LABEL_SET.has(parsed.type)) {
      throw new Error(`第 ${lineNumber} 行的 type 未知：${parsed.type}`);
    }
    records.push({ line: lineNumber, text: parsed.text.trim(), type: parsed.type });
  }
  if (records.length === 0) throw new Error('标注集为空');
  return records;
}

/**
 * 是否是 JSONL 标注集：每个非空行都能解析为带 text/type 的对象。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeGolden(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return false;
  if (!lines.every((line) => line.startsWith('{'))) return false;
  try {
    parseGolden(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 统计混淆矩阵与门槛结果。
 *
 * @param {Array<{text:string, type:string}>} records
 * @returns {{
 *   total:number, correct:number, accuracy:number,
 *   labels:string[],
 *   matrix:Map<string, Map<string, number>>,
 *   perType:Array<{type:string,support:number,predicted:number,correct:number,precision:number|null,recall:number|null}>,
 *   blameFalsePositives:number,
 *   neutral:{total:number,triggered:number,rate:number},
 *   failures:Array<{text:string,expected:string,predicted:string,confidence:number,reason?:string}>,
 *   passed:boolean,
 *   checks:{accuracy:boolean,blameFalsePositives:boolean,neutralFalseTriggerRate:boolean}
 * }}
 */
/**
 * 规则分类器逐条判定后出报告（与 test/emotion-golden.test.js 共用）。
 * @param {Array<{text:string, type:string}>} records
 */
export function analyzeGolden(records) {
  return buildConfusionReport(
    records,
    records.map((record) => classify(record.text)),
    THRESHOLDS,
  );
}

/**
 * 逐条用异步判定器（模型或 mock）判定后出报告。
 * 判定失败记为 error（按 none 计入矩阵），并在报告里单列条数。
 *
 * @param {Array<{text:string, type:string}>} records
 * @param {(text:string) => Promise<{type:string, confidence:number, reason?:string}>} appraise
 */
export async function analyzeGoldenWithAppraiser(records, appraise) {
  if (typeof appraise !== 'function') {
    throw new TypeError('analyzeGoldenWithAppraiser(records, appraise): appraise must be a function');
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('标注集为空');
  const results = [];
  for (const record of records) {
    try {
      const verdict = await appraise(record.text);
      results.push({ type: verdict.type, confidence: verdict.confidence });
    } catch (error) {
      results.push({
        type: 'none',
        confidence: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return buildConfusionReport(records, results, THRESHOLDS_LLM);
}

function buildConfusionReport(records, results, thresholds) {
  if (!Array.isArray(records)) {
    throw new TypeError('buildConfusionReport(records, results, thresholds): records must be an array');
  }
  if (!Array.isArray(results) || results.length !== records.length) {
    throw new TypeError('buildConfusionReport(records, results, thresholds): results length mismatch');
  }
  if (records.length === 0) throw new Error('标注集为空');

  /** @type {Map<string, Map<string, number>>} */
  const matrix = new Map(LABELS.map((label) => [label, new Map(LABELS.map((other) => [other, 0]))]));
  /** @type {Map<string, number>} */
  const support = new Map(LABELS.map((label) => [label, 0]));
  /** @type {Map<string, number>} */
  const predictedCounts = new Map(LABELS.map((label) => [label, 0]));
  const failures = [];
  let correct = 0;
  let blameFalsePositives = 0;
  let neutralTotal = 0;
  let neutralTriggered = 0;
  let errors = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const expected = record.type;
    const result = results[index];
    if (result.error !== undefined) errors += 1;
    const predicted = result.type;
    support.set(expected, (support.get(expected) ?? 0) + 1);
    predictedCounts.set(predicted, (predictedCounts.get(predicted) ?? 0) + 1);
    matrix.get(expected).set(predicted, (matrix.get(expected).get(predicted) ?? 0) + 1);
    if (expected === predicted) correct += 1;
    if (expected !== 'blame' && predicted === 'blame') blameFalsePositives += 1;
    if (expected === 'none') {
      neutralTotal += 1;
      if (predicted !== 'none') neutralTriggered += 1;
    }
    if (expected !== predicted) {
      failures.push({
        text: record.text,
        expected,
        predicted,
        confidence: result.confidence,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    }
  }

  const accuracy = correct / records.length;
  const neutralRate = neutralTotal === 0 ? 0 : neutralTriggered / neutralTotal;
  const labels = LABELS.filter((label) => (support.get(label) ?? 0) > 0 || (predictedCounts.get(label) ?? 0) > 0);
  const perType = labels.map((label) => {
    const predicted = predictedCounts.get(label) ?? 0;
    const hits = matrix.get(label).get(label) ?? 0;
    return {
      type: label,
      support: support.get(label) ?? 0,
      predicted,
      correct: hits,
      precision: predicted === 0 ? null : hits / predicted,
      recall: (support.get(label) ?? 0) === 0 ? null : hits / (support.get(label) ?? 0),
    };
  });

  const checks = {
    accuracy: accuracy >= thresholds.accuracy,
    blameFalsePositives: blameFalsePositives <= thresholds.blameFalsePositives,
    neutralFalseTriggerRate: neutralRate <= thresholds.neutralFalseTriggerRate,
    noErrors: errors === 0,
  };
  return {
    total: records.length,
    correct,
    accuracy,
    labels,
    matrix: matrix,
    perType,
    blameFalsePositives,
    neutral: { total: neutralTotal, triggered: neutralTriggered, rate: neutralRate },
    failures,
    errors,
    thresholds,
    passed: checks.accuracy && checks.blameFalsePositives
      && checks.neutralFalseTriggerRate && checks.noErrors,
    checks,
  };
}

/**
 * 渲染混淆矩阵报告（稳定文本：同输入同输出）。
 *
 * @param {ReturnType<typeof analyzeGolden>} report
 * @param {string} [source] 标注集来源，仅用于标题
 * @returns {string}
 */
export function renderConfusion(report, source = '') {
  const lines = [];
  const title = source === '' ? '混淆矩阵（行=标注，列=预测）' : `混淆矩阵（${source}）`;
  lines.push(title);
  lines.push(`标注条数：${report.total}；只列出现过的标签`);
  lines.push('');

  const firstWidth = 14;
  const cellWidth = 10;
  const header = [padEndWidth('标注\\预测', firstWidth)];
  for (const label of report.labels) header.push(padStartWidth(label, cellWidth));
  header.push(padStartWidth('合计', cellWidth));
  lines.push(header.join(''));

  for (const label of report.labels) {
    const row = [padEndWidth(label, firstWidth)];
    let total = 0;
    for (const other of report.labels) {
      const count = report.matrix.get(label).get(other) ?? 0;
      total += count;
      row.push(padStartWidth(String(count), cellWidth));
    }
    row.push(padStartWidth(String(total), cellWidth));
    lines.push(row.join(''));
  }

  lines.push('');
  lines.push('每类 precision / recall');
  const rowHeader = [
    padEndWidth('类型', 12),
    padStartWidth('标注', 6),
    padStartWidth('预测', 6),
    padStartWidth('正确', 6),
    padStartWidth('precision', 11),
    padStartWidth('recall', 8),
  ].join('');
  lines.push(rowHeader);
  for (const row of report.perType) {
    lines.push([
      padEndWidth(row.type, 12),
      padStartWidth(String(row.support), 6),
      padStartWidth(String(row.predicted), 6),
      padStartWidth(String(row.correct), 6),
      padStartWidth(row.precision === null ? 'n/a' : row.precision.toFixed(3), 11),
      padStartWidth(row.recall === null ? 'n/a' : row.recall.toFixed(3), 8),
    ].join(''));
  }

  lines.push('');
  lines.push(`总体准确率：${report.correct}/${report.total} = ${percent(report.accuracy)}`
    + `（门槛 ≥ ${percent(report.thresholds.accuracy)}，${report.checks.accuracy ? '通过' : '未通过'}）`);
  lines.push(`blame 误报：${report.blameFalsePositives} 句`
    + `（门槛 ≤ ${report.thresholds.blameFalsePositives}，${report.checks.blameFalsePositives ? '通过' : '未通过'}）`);
  lines.push(`中性句误触发率：${report.neutral.triggered}/${report.neutral.total} = ${percent(report.neutral.rate)}`
    + `（门槛 ≤ ${percent(report.thresholds.neutralFalseTriggerRate)}，`
    + `${report.checks.neutralFalseTriggerRate ? '通过' : '未通过'}）`);
  if (report.errors > 0) {
    lines.push(`判定失败：${report.errors} 句（判定器报错按 none 计入，门槛要求 0 句）`);
  }
  lines.push(`结论：${report.passed ? '通过（退出码 0）' : '未通过（退出码 1）'}`);

  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`错例（前 ${Math.min(10, report.failures.length)} 条，共 ${report.failures.length} 条）：`);
    for (const failure of report.failures.slice(0, 10)) {
      lines.push(`- ${failure.text} | 标注 ${failure.expected} | 预测 ${failure.predicted}`
        + ` | 置信度 ${failure.confidence.toFixed(2)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** @param {number} value @returns {string} */
function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 等宽对齐用：CJK 字符按 2 列计。
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(char) ? 2 : 1;
  }
  return width;
}

/** @param {string} text @param {number} width @returns {string} */
function padEndWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** @param {string} text @param {number} width @returns {string} */
function padStartWidth(text, width) {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

/** @param {string} value @returns {number} */
function round2(value) {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** @param {string} arg @returns {Promise<string>} */
async function readInput(arg) {
  if (arg === '-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(arg, 'utf8');
}


/** 判定器环境变量的候选名（先专用、再通用 OpenAI 兼容名）。 */
const APPRAISE_ENV = Object.freeze({
  baseUrl: Object.freeze(['EMOTION_APPRAISE_BASE_URL', 'OPENAI_BASE_URL']),
  apiKey: Object.freeze(['EMOTION_APPRAISE_API_KEY', 'OPENAI_API_KEY']),
  model: Object.freeze(['EMOTION_APPRAISE_MODEL', 'OPENAI_MODEL']),
});

/** @param {readonly string[]} names @param {Record<string, string | undefined>} env */
function readEnv(names, env) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 用 OpenAI 兼容端点做判定（只读：不写库、不落盘）。
 * 端点、密钥、模型全部从环境变量取，命令行不接受明文密钥。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {(text:string) => Promise<{type:string, confidence:number}>}
 */
export function createLlmJudge(env = process.env, fetchImpl = fetch) {
  const baseUrl = readEnv(APPRAISE_ENV.baseUrl, env).replace(/\/+$/u, '');
  const apiKey = readEnv(APPRAISE_ENV.apiKey, env);
  const model = readEnv(APPRAISE_ENV.model, env);
  if (baseUrl === '' || apiKey === '' || model === '') {
    const missing = [
      baseUrl === '' ? APPRAISE_ENV.baseUrl.join('|') : '',
      apiKey === '' ? APPRAISE_ENV.apiKey.join('|') : '',
      model === '' ? APPRAISE_ENV.model.join('|') : '',
    ].filter((name) => name !== '').join('、');
    throw new Error(`缺少环境变量：${missing}`);
  }
  return async (text) => {
    const messages = buildAppraisalMessages({ text, lastReply: '', cardName: '' });
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 200 }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    const verdict = parseAppraisal(raw);
    return { type: verdict.type, confidence: verdict.confidence };
  };
}

/**
 * 解析命令行参数。
 * @param {string[]} args
 * @returns {{mode:'auto'|'confusion'|'llm', input:string}}
 */
export function parseArgs(args) {
  let confusion = false;
  let appraiser = 'rules';
  let input = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--confusion') {
      confusion = true;
      continue;
    }
    if (arg === '--input') {
      const value = args[index + 1];
      if (value === undefined) throw new Error('--input 需要一个文件路径');
      input = value;
      index += 1;
      continue;
    }
    if (arg === '--appraiser') {
      const value = args[index + 1];
      if (value !== 'rules' && value !== 'llm') throw new Error('--appraiser 只能是 rules 或 llm');
      appraiser = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`未知参数：${arg}`);
    if (input !== '') throw new Error('只能给一个输入文件');
    input = arg;
  }
  if (input === '') throw new Error('缺少输入文件');
  if (appraiser === 'llm') return { mode: 'llm', input };
  return { mode: confusion ? 'confusion' : 'auto', input };
}

/**
 * 运行模型判定器模式。
 * @param {string} sourceFile
 * @param {Record<string,string|undefined>} env
 * @returns {Promise<number>} 退出码
 */
async function runLlm(sourceFile, env) {
  let text;
  try {
    text = await readInput(sourceFile);
  } catch (error) {
    process.stderr.write(`读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let records;
  try {
    records = parseGolden(text);
  } catch (error) {
    process.stderr.write(`标注集无效：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let judge;
  try {
    judge = createLlmJudge(env);
  } catch (error) {
    process.stderr.write(`判定器不可用：${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const report = await analyzeGoldenWithAppraiser(records, judge);
  process.stdout.write(renderConfusion(report, `${sourceFile === '-' ? 'stdin' : sourceFile}，模型判定`));
  return report.passed ? 0 : 1;
}

/**
 * 运行混淆矩阵模式。
 * @param {string} sourceFile 文件路径或 '-'
 * @param {boolean} forced 是否由 --confusion 强制
 * @returns {Promise<number>} 退出码
 */
async function runConfusion(sourceFile, forced) {
  let text;
  try {
    text = await readInput(sourceFile);
  } catch (error) {
    process.stderr.write(`读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let records;
  try {
    records = parseGolden(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(forced ? `标注集无效：${message}\n` : `读取失败：${message}\n`);
    return 1;
  }
  const report = analyzeGolden(records);
  process.stdout.write(renderConfusion(report, sourceFile === '-' ? 'stdin' : sourceFile));
  return report.passed ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let parsedArgs;
  try {
    parsedArgs = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsedArgs.mode === 'llm') {
    process.exitCode = await runLlm(parsedArgs.input, process.env);
    return;
  }
  if (parsedArgs.mode === 'confusion') {
    process.exitCode = await runConfusion(parsedArgs.input, true);
    return;
  }
  let text;
  try {
    text = await readInput(parsedArgs.input);
  } catch (error) {
    process.stderr.write(`读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (looksLikeGolden(text)) {
    process.exitCode = await runConfusion(parsedArgs.input, false);
    return;
  }
  process.stdout.write(render(analyze(text)));
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
