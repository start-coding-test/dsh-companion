/**
 * 安装自检（W3）单测：公式边界、YAML 渲染与示例文件一致性。
 *
 * 不依赖 DSH 进程；纯函数 + 仓库文件读取。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_WORKING_MEMORY_TOKENS,
  RETAIN_TOKENS,
  renderSuggestedYaml,
  suggestConfig,
  suggestRssLimits,
} from '../src/calibrate/formula.js';
import { DEFAULTS } from '../src/config.js';
import { DEFAULT_CARD } from '../src/persona/card.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/**
 * 解析建议 YAML 的简单键值（只接受字符串与整数，够本文件断言用）。
 * @param {string} text
 * @returns {Record<string, string|number>}
 */
function parseSimpleYaml(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const matched = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    assert.ok(matched, `invalid YAML line: ${line}`);
    const raw = matched[2].trim();
    result[matched[1]] = raw.startsWith('"') ? JSON.parse(raw) : Number(raw);
  }
  return result;
}

/**
 * 解析 config.example.yml 的键值（同样只覆盖本文件的简单标量）。
 * @param {string} text
 * @returns {Record<string, string|number>}
 */
function parseExampleConfig(text) {
  return parseSimpleYaml(text);
}

test('suggestConfig：32K 工作记忆封顶与 128K 上下文', () => {
  const suggested = suggestConfig({
    totalmemBytes: 32 * GIB,
    contextWindowTokens: 128000,
    timezone: 'Asia/Shanghai',
  });
  assert.equal(suggested.workingMemoryTokens, MAX_WORKING_MEMORY_TOKENS);
  assert.equal(suggested.workingMemoryTokens, 32000);
  assert.equal(suggested.compactAtTokens, 24000);
  assert.equal(suggested.compactHardTokens, 40000);
  assert.equal(suggested.retainTokens, RETAIN_TOKENS);
  assert.ok(suggested.workingMemoryTokens <= MAX_WORKING_MEMORY_TOKENS);
});

test('suggestConfig：更大的上下文也不突破 32K；按比例缩小时四档仍合理', () => {
  const large = suggestConfig({ totalmemBytes: 64 * GIB, contextWindowTokens: 256000 });
  assert.equal(large.workingMemoryTokens, 32000);

  const medium = suggestConfig({ totalmemBytes: 64 * GIB, contextWindowTokens: 64000 });
  assert.equal(medium.workingMemoryTokens, 16000);
  assert.equal(medium.compactAtTokens, 12000);
  assert.equal(medium.compactHardTokens, 20000);
  assert.ok(medium.retainTokens < medium.compactAtTokens);
  assert.ok(medium.compactAtTokens < medium.workingMemoryTokens);
  assert.ok(medium.workingMemoryTokens < medium.compactHardTokens);
});

test('suggestConfig：contextWindow 小值按公式缩放且不为零', () => {
  const small = suggestConfig({ totalmemBytes: 32 * GIB, contextWindowTokens: 40000 });
  assert.equal(small.workingMemoryTokens, 10000);
  assert.equal(small.compactAtTokens, 7500);
  assert.equal(small.compactHardTokens, 12500);

  const tiny = suggestConfig({ totalmemBytes: 32 * GIB, contextWindowTokens: 8000 });
  assert.equal(tiny.workingMemoryTokens, 2000);
  assert.equal(tiny.compactAtTokens, 1500);
  assert.equal(tiny.compactHardTokens, 2500);
  assert.ok(tiny.workingMemoryTokens > 0);
  assert.ok(tiny.compactHardTokens > 0);
});

test('suggestConfig：总内存小值与 userLimit 下限', () => {
  const halfGig = suggestConfig({ totalmemBytes: 512 * MIB, contextWindowTokens: 128000 });
  assert.equal(halfGig.memoryBudget, 0, '0.75×512MiB−512MiB 会被夹到 0');

  const oneGig = suggestConfig({ totalmemBytes: 1 * GIB, contextWindowTokens: 128000 });
  assert.equal(oneGig.memoryBudget, 256 * MIB);

  const userLimited = suggestConfig({
    totalmemBytes: 64 * GIB,
    contextWindowTokens: 128000,
    userLimitBytes: 2 * GIB,
  });
  assert.equal(userLimited.memoryBudget, 2 * GIB);

  const zeroLimit = suggestConfig({
    totalmemBytes: 64 * GIB,
    contextWindowTokens: 128000,
    userLimitBytes: 0,
  });
  assert.equal(zeroLimit.memoryBudget, 0);
});

test('suggestConfig：16 个配置键齐全、类型正确、时区可覆盖', () => {
  const suggested = suggestConfig({
    totalmemBytes: 16 * GIB,
    contextWindowTokens: 128000,
    timezone: 'America/New_York',
  });
  assert.deepEqual(
    Object.keys(suggested).sort(),
    [...Object.keys(DEFAULTS), 'memoryBudget'].sort(),
  );
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(typeof suggested[key], typeof DEFAULTS[key], `${key} 类型应与默认值一致`);
  }
  assert.equal(suggested.timezone, 'America/New_York');
  assert.equal(suggested.dbPath, './.data/companion.db');
  assert.equal(suggested.quietStart, '23:00');
  assert.equal(suggested.quietEnd, '08:00');
  assert.ok(Number.isInteger(suggested.memoryBudget));
});

test('suggestRssLimits：按 memoryBudget 缩放，4GiB 内存给出 2.2/2.4/2.6', () => {
  const cloud = suggestConfig({ totalmemBytes: 4 * GIB, contextWindowTokens: 128000 });
  assert.equal(cloud.memoryBudget, 2.5 * GIB, '自检公式：4GiB×0.75−512MiB = 2.5GiB');
  assert.equal(cloud.rssWarnGiB, 2.2);
  assert.equal(cloud.rssStopGiB, 2.4);
  assert.equal(cloud.rssMainOnlyGiB, 2.6);
  assert.ok(cloud.rssMainOnlyGiB <= 4 * 0.75, 'mainOnly 不超过总内存 75%');

  const large = suggestConfig({ totalmemBytes: 64 * GIB, contextWindowTokens: 128000 });
  assert.equal(large.rssWarnGiB, 2.95);
  assert.equal(large.rssStopGiB, 3);
  assert.equal(large.rssMainOnlyGiB, 3.15);

  const tiny = suggestRssLimits(0.2 * GIB);
  assert.ok(tiny.rssWarnGiB > 0);
  assert.ok(tiny.rssWarnGiB < tiny.rssStopGiB);
  assert.ok(tiny.rssStopGiB < tiny.rssMainOnlyGiB);

  assert.deepEqual(suggestRssLimits(0), { rssWarnGiB: 2.95, rssStopGiB: 3, rssMainOnlyGiB: 3.15 });
});

test('renderSuggestedYaml：含 provenance 且是合法简单 YAML', () => {
  const suggested = suggestConfig({
    totalmemBytes: 32 * GIB,
    contextWindowTokens: 128000,
    timezone: 'Asia/Shanghai',
  });
  const yaml = renderSuggestedYaml(suggested, {
    generatedAt: '2026-11-03T12:34:56.000Z',
    node: 'v24.11.0',
    electron: '38.2.0',
    dsh: '0.2.1-rc.5',
    rssMedianBytes: 412 * MIB,
    totalmemBytes: 32 * GIB,
    cpus: 16,
    contextWindowTokens: 128000,
  });

  assert.match(yaml, /^# generated_at: 2026-11-03T12:34:56\.000Z$/m);
  assert.match(
    yaml,
    /^# source: node v24\.11\.0 \/ electron 38\.2\.0 \/ dsh 0\.2\.1-rc\.5 \/ rss_median 432013312 bytes$/m,
  );
  assert.doesNotMatch(yaml, /\t/, 'YAML 不用 tab');
  assert.doesNotMatch(yaml, /undefined/, '不输出 undefined');
  assert.doesNotMatch(yaml, /^memoryBudget:/m, 'memoryBudget 不是配置键');

  const parsed = parseSimpleYaml(yaml);
  assert.equal(Object.keys(parsed).length, 16);
  assert.equal(parsed.workingMemoryTokens, 32000);
  assert.equal(parsed.compactAtTokens, 24000);
  assert.equal(parsed.retainTokens, 6144);
  assert.equal(parsed.timezone, 'Asia/Shanghai');
  assert.equal(parsed.quietStart, '23:00');
  assert.equal(parsed.dbPath, './.data/companion.db');
  assert.equal(parsed.rssWarnGiB, 2.95);
  assert.equal(parsed.rssStopGiB, 3);
  assert.equal(parsed.rssMainOnlyGiB, 3.15);
});

test('renderSuggestedYaml：provenance 含换行也不会破坏注释结构', () => {
  const suggested = suggestConfig({ totalmemBytes: 8 * GIB, contextWindowTokens: 128000 });
  const yaml = renderSuggestedYaml(suggested, {
    generatedAt: '2026-11-03T00:00:00.000Z',
    node: 'v24\ninjected: true',
    electron: null,
    dsh: 'unknown',
    rssMedianBytes: 100,
  });
  const lines = yaml.split(/\r?\n/).filter((line) => line.startsWith('# source:'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /node v24 injected: true/);
  assert.doesNotMatch(yaml, /^injected:/m);
  const parsed = parseSimpleYaml(yaml);
  assert.equal(Object.keys(parsed).length, 16);
});

test('config.example.yml：16 个键齐全且与 DEFAULTS 一致', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'config.example.yml'), 'utf8');
  const parsed = parseExampleConfig(text);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULTS).sort());
  for (const [key, value] of Object.entries(parsed)) {
    assert.deepEqual(value, DEFAULTS[key], `${key} 示例值应与默认值一致`);
  }
  assert.match(text, /timezone: "Asia\/Shanghai"/);
  assert.match(text, /idleMs: 1800000/);
});

/**
 * 从 persona 示例中抽出 ```json 代码块。
 * Windows 全新检出（core.autocrlf=true）是 CRLF，正则必须同时接受 \n 与 \r\n。
 * @param {string} text
 * @returns {unknown}
 */
function parsePersonaCard(text) {
  const matched = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(text);
  assert.ok(matched, '缺少 ```json 代码块');
  return JSON.parse(matched[1]);
}

test('persona.example.md：可复制 JSON 与 DEFAULT_CARD 一致（LF/CRLF 均可解析）', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'persona.example.md'), 'utf8');
  // 仓库检出可能是 LF（Linux/CI）或 CRLF（Windows core.autocrlf=true），两种都要能解析。
  const lf = text.replace(/\r\n/gu, '\n');
  const crlf = lf.replace(/\n/gu, '\r\n');
  assert.deepEqual(parsePersonaCard(lf), DEFAULT_CARD);
  assert.deepEqual(parsePersonaCard(crlf), DEFAULT_CARD);
  // 覆盖「原文件本身就是 CRLF」与「原文件是 LF」两种检出。
  assert.deepEqual(parsePersonaCard(text), DEFAULT_CARD);
});
