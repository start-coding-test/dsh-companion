/**
 * scripts/emotion-report.mjs 的单测：文件输入、stdin、错误出口。
 * 临时文件只落在 os.tmpdir()；脚本本身只读，报告只走 stdout。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/emotion-report.mjs', import.meta.url));

/** @param {string} dir */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-emotion-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {string[]} args @param {object} [options] */
function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('emotion-report：文件输入按行统计 count/mean/max 与未命中比例', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'input.txt');
  writeFileSync(file, [
    '你好',
    '你好，在吗',
    '今天加班好累',
    '帮我查下明天天气',
    '',
    '谢谢你',
    '你好烦',
    '',
  ].join('\n'), 'utf8');
  const before = readdirSync(dir).sort();

  const result = run([file], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /共 6 行/u);
  // greeting 两行：0.70 与 0.78 → count 2 / mean 0.74 / max 0.78。
  assert.match(result.stdout, /greeting\s+2\s+0\.74\s+0\.78/u);
  assert.match(result.stdout, /vent\s+1\s+0\.68\s+0\.68/u);
  assert.match(result.stdout, /thanks\s+1\s+0\.75\s+0\.75/u);
  assert.match(result.stdout, /blame\s+1\s+0\.74\s+0\.74/u);
  assert.match(result.stdout, /未命中：1\/6（16\.7%）/u);
  // EVENT_TYPES 全量列出，未命中的类 count=0。
  assert.match(result.stdout, /care\s+0\s+0\.00\s+0\.00/u);
  assert.match(result.stdout, /comfort\s+0\s+0\.00\s+0\.00/u);

  // 只读：目录里除了输入文件不应多出任何东西。
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test('emotion-report：- 从 stdin 读取，空行跳过，不落任何文件', (t) => {
  const dir = tempDir(t);
  const result = run(['-'], { cwd: dir, input: '好的\n晚安\n\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /共 2 行/u);
  assert.match(result.stdout, /goodnight\s+1\s+0\.80\s+0\.80/u);
  assert.match(result.stdout, /未命中：1\/2（50\.0%）/u);
  assert.deepEqual(readdirSync(dir), [], 'stdin 模式不应写文件');
});

test('emotion-report：无参数退出 2，文件不存在退出 1，错误只走 stderr', (t) => {
  const dir = tempDir(t);
  const missingArg = run([], { cwd: dir });
  assert.equal(missingArg.status, 2);
  assert.match(missingArg.stderr, /用法/u);
  assert.equal(missingArg.stdout, '');

  const missingFile = run([join(dir, 'nope.txt')], { cwd: dir });
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stderr, /读取失败/u);
  assert.equal(missingFile.stdout, '');
  assert.deepEqual(readdirSync(dir), []);
});
