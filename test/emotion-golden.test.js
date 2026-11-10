/**
 * 情绪分类中文标注集（golden set）与发版门槛测试。
 *
 * 门槛（用户定的发版门）：
 * - 总体准确率 ≥ 85%；
 * - blame 误报 ≤ 2 句（标注不是 blame 却判 blame）；
 * - 中性句误触发率 ≤ 10%（标注 none 却判出非 none）。
 *
 * 标注集是新标注的：标签按「人怎么理解」写，不按当前规则调参。
 * 失败时打印前 10 个错例（text / 标注 / 预测 / 置信度），便于定位规则缺口。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLASSIFY_TYPES } from '../src/persona/emotion-classify.js';
import {
  THRESHOLDS,
  analyzeGolden,
  parseGolden,
  renderConfusion,
} from '../scripts/emotion-report.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/emotion-report.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/emotion-golden.jsonl', import.meta.url));

/** 用户点名、必须出现在标注集里的误判回归句。 */
const REQUIRED = Object.freeze([
  '今天好辛苦',
  '我最近好辛苦',
  '哦对了，明天提醒我开会',
  '算了，我自己来吧',
  '睡了一下午',
  '不烦不烦',
  '你一点都不烦',
  '你是不是很烦我',
  '我烦你了吗',
  '你看这个人好烦',
  '我好烦',
  '我今天好烦',
  '烦死了',
  '他好烦',
  '这破电脑好烦',
  '压力好大',
  '你是不是也觉得加班好累',
  '你怎么又忘了',
  '你好烦',
]);

/** @returns {Array<{line:number,text:string,type:string}>} */
function goldenRecords() {
  return parseGolden(readFileSync(FIXTURE, 'utf8'));
}

/** 错例摘要（最多 10 条），用于失败信息。 @param {ReturnType<typeof analyzeGolden>} report */
function failureDetail(report) {
  return report.failures.slice(0, 10).map((failure) => (
    `「${failure.text}」 标注=${failure.expected} 预测=${failure.predicted}`
    + ` 置信度=${failure.confidence.toFixed(2)}`
  )).join('\n');
}

/** @param {string[]} args @param {object} [options] */
function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...options });
}

/** @param {string} dir */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-emotion-golden-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- 标注集本身

test('标注集：每行都是合法 JSONL，type 属于分类器标签，text 不重复', () => {
  const records = goldenRecords();
  assert.ok(records.length >= 195 && records.length <= 215, `标注集条数 ${records.length} 偏离约 200 行`);
  assert.equal(new Set(records.map((record) => record.text)).size, records.length, '标注集中有重复 text');
  for (const record of records) {
    assert.ok(CLASSIFY_TYPES.includes(record.type), `第 ${record.line} 行 type 非法：${record.type}`);
    assert.ok(record.text.trim() !== '', `第 ${record.line} 行 text 为空`);
  }
});

test('标注集：12 个事件类型每类 ≥6 句，none ≥60 句', () => {
  const records = goldenRecords();
  const counts = new Map();
  for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1);
  for (const type of CLASSIFY_TYPES) {
    const expectedType = type === 'none' ? 'none' : type;
    const count = counts.get(expectedType) ?? 0;
    const floor = expectedType === 'none' ? 60 : 6;
    assert.ok(count >= floor, `${expectedType} 只有 ${count} 句（下限 ${floor}）`);
  }
  assert.equal([...counts.keys()].length, CLASSIFY_TYPES.length, '应当覆盖全部 13 个标签（含 none）');
});

test('标注集：用户点名的 19 句误判回归全部在册', () => {
  const texts = new Set(goldenRecords().map((record) => record.text));
  for (const sentence of REQUIRED) {
    assert.ok(texts.has(sentence), `标注集缺少回归句「${sentence}」`);
  }
});

// ---------------------------------------------------------------- 发版门槛

test(`门槛：总体准确率 ≥ ${(THRESHOLDS.accuracy * 100).toFixed(0)}%`, () => {
  const report = analyzeGolden(goldenRecords());
  const detail = failureDetail(report);
  assert.ok(
    report.accuracy >= THRESHOLDS.accuracy,
    `总体准确率 ${(report.accuracy * 100).toFixed(2)}% 低于 `
    + `${(THRESHOLDS.accuracy * 100).toFixed(0)}%（${report.correct}/${report.total}）\n${detail}`,
  );
});

test(`门槛：blame 误报 ≤ ${THRESHOLDS.blameFalsePositives} 句`, () => {
  const report = analyzeGolden(goldenRecords());
  const detail = failureDetail(report);
  assert.ok(
    report.blameFalsePositives <= THRESHOLDS.blameFalsePositives,
    `blame 误报 ${report.blameFalsePositives} 句超过 ${THRESHOLDS.blameFalsePositives} 句\n${detail}`,
  );
});

test(`门槛：中性句误触发率 ≤ ${(THRESHOLDS.neutralFalseTriggerRate * 100).toFixed(0)}%`, () => {
  const report = analyzeGolden(goldenRecords());
  const detail = failureDetail(report);
  assert.ok(
    report.neutral.rate <= THRESHOLDS.neutralFalseTriggerRate,
    `中性句误触发率 ${(report.neutral.rate * 100).toFixed(2)}% 超过 `
    + `${(THRESHOLDS.neutralFalseTriggerRate * 100).toFixed(0)}%`
    + `（${report.neutral.triggered}/${report.neutral.total}）\n${detail}`,
  );
});

// ---------------------------------------------------------------- CLI

test('CLI：--confusion 读标注集，输出稳定、退出 0、不落文件', (t) => {
  const dir = tempDir(t);
  const before = readdirSync(dir).sort();
  const first = run(['--confusion', FIXTURE], { cwd: dir });
  const second = run(['--confusion', FIXTURE], { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout, '同输入必须同输出');
  assert.match(first.stdout, /混淆矩阵/u);
  assert.match(first.stdout, /总体准确率：\d+\/\d+ = \d+\.\d{2}%/u);
  assert.match(first.stdout, /blame 误报：\d+ 句/u);
  assert.match(first.stdout, /结论：通过（退出码 0）/u);
  assert.deepEqual(readdirSync(dir).sort(), before, '脚本不应写任何文件');
});

test('CLI：普通文本文件仍走按行统计模式（不被误判为 JSONL）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'chat.txt');
  writeFileSync(file, '你好\n今天加班好累\n帮我查下明天天气\n', 'utf8');
  const result = run([file], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /共 3 行/u);
  assert.match(result.stdout, /未命中：1\/3/u);
  assert.doesNotMatch(result.stdout, /混淆矩阵/u);
});

test('CLI：不达标标注集退出 1，并在 stdout 打印错例', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'bad.jsonl');
  writeFileSync(file, [
    JSON.stringify({ text: '你好', type: 'none' }),
    JSON.stringify({ text: '晚安', type: 'none' }),
    JSON.stringify({ text: '帮我查下明天天气', type: 'blame' }),
  ].join('\n'), 'utf8');
  const result = run(['--confusion', file], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /结论：未通过（退出码 1）/u);
  assert.match(result.stdout, /错例/u);
});

test('CLI：--confusion 缺参数退出 2；非法 JSONL 退出 1 且只写 stderr', (t) => {
  const dir = tempDir(t);
  const missingArg = run(['--confusion'], { cwd: dir });
  assert.equal(missingArg.status, 2);
  assert.match(missingArg.stderr, /用法/u);
  assert.equal(missingArg.stdout, '');

  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"text": "你好"}\n', 'utf8');
  const invalid = run(['--confusion', bad], { cwd: dir });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /标注集无效/u);
  assert.equal(invalid.stdout, '');
});

// ---------------------------------------------------------------- 渲染

test('renderConfusion：矩阵行和等于各标注类支持数，报告可重复渲染', () => {
  const report = analyzeGolden(goldenRecords());
  for (const label of report.labels) {
    const row = report.perType.find((row) => row.type === label);
    assert.equal(row.support, row.correct + report.failures.filter((failure) => failure.expected === label).length);
  }
  assert.equal(renderConfusion(report, 'x'), renderConfusion(report, 'x'));
});
