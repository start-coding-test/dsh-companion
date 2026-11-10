#!/usr/bin/env node
/**
 * 情绪分类只读报告（V50）：按行跑 classify，统计每类命中数与置信度分布。
 *
 * 用法：
 *   node scripts/emotion-report.mjs <文本文件>
 *   node scripts/emotion-report.mjs -          # 从 stdin 读
 *
 * 只读：不打开数据库、不写任何文件，结果全部走 stdout。
 * 退出码：0 成功；1 读取失败；2 用法错误。
 */
import { readFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { pathToFileURL } from 'node:url';

import { EVENT_TYPES, classify } from '../src/persona/emotion.js';

const USAGE = '用法：node scripts/emotion-report.mjs <文本文件|->（- 表示从 stdin 读取）';

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
 * 渲染报告文本（不写任何文件）。
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

async function main() {
  const arg = process.argv[2];
  if (arg === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let text;
  try {
    text = await readInput(arg);
  } catch (error) {
    process.stderr.write(`读取失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(render(analyze(text)));
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
