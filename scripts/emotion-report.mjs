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

/** 发版门（与 test/emotion-golden.test.js 共用）。 */
export const THRESHOLDS = Object.freeze({
  /** 总体准确率下限。 */
  accuracy: 0.85,
  /** blame 误报上限（标注不是 blame 却判 blame 的句数）。 */
  blameFalsePositives: 2,
  /** 中性句（标注 none）被误触发成任何事件的比例上限。 */
  neutralFalseTriggerRate: 0.1,
});

/** 混淆矩阵的固定标签顺序：12 个事件类型 + none。 */
const LABELS = Object.freeze([...EVENT_TYPES, 'none']);
const LABEL_SET = new Set(LABELS);

const USAGE = [
  '用法：',
  '  node scripts/emotion-report.mjs <文本文件|->                 按行统计类型分布',
  '  node scripts/emotion-report.mjs --confusion <golden.jsonl|->  混淆矩阵与门槛',
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
export function analyzeGolden(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('analyzeGolden(records): records must be an array');
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

  for (const record of records) {
    const expected = record.type;
    const result = classify(record.text);
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
    accuracy: accuracy >= THRESHOLDS.accuracy,
    blameFalsePositives: blameFalsePositives <= THRESHOLDS.blameFalsePositives,
    neutralFalseTriggerRate: neutralRate <= THRESHOLDS.neutralFalseTriggerRate,
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
    passed: checks.accuracy && checks.blameFalsePositives && checks.neutralFalseTriggerRate,
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
    + `（门槛 ≥ ${percent(THRESHOLDS.accuracy)}，${report.checks.accuracy ? '通过' : '未通过'}）`);
  lines.push(`blame 误报：${report.blameFalsePositives} 句`
    + `（门槛 ≤ ${THRESHOLDS.blameFalsePositives}，${report.checks.blameFalsePositives ? '通过' : '未通过'}）`);
  lines.push(`中性句误触发率：${report.neutral.triggered}/${report.neutral.total} = ${percent(report.neutral.rate)}`
    + `（门槛 ≤ ${percent(THRESHOLDS.neutralFalseTriggerRate)}，`
    + `${report.checks.neutralFalseTriggerRate ? '通过' : '未通过'}）`);
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
  if (args[0] === '--confusion') {
    const target = args[1];
    if (target === undefined) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runConfusion(target, true);
    return;
  }
  if (args.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const arg = args[0];
  let text;
  try {
    text = await readInput(arg);
  } catch (error) {
    process.stderr.write(`读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (looksLikeGolden(text)) {
    process.exitCode = await runConfusion(arg, false);
    return;
  }
  process.stdout.write(render(analyze(text)));
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
