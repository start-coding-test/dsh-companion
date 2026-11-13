/**
 * v0.4.13 A2：额度闸门。
 *
 * 三块：错误识别（isQuotaError）、配额文件读取与评估（readQuotaFile）、后台推迟
 * 判定（deferBackground）。闸门只挡后台；hard 巩固、压缩与主会话永远放行——这里
 * 用 deferBackground 的 trigger 参数把这条红线钉住。另覆盖 config.quota 的归一化
 * 与 /状态 的额度行三态。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { DEFAULTS, normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { handleCommand } from '../src/runtime/commands.js';
import { deferBackground, isQuotaError, readQuotaFile } from '../src/runtime/quota-gate.js';

const NOW = Date.UTC(2026, 10, 13, 6, 0, 0); // 2026-11-13 14:00 +08

const SEC = (ms) => Math.floor(ms / 1000);
const snapshot = (overrides = {}) => ({
  updatedAt: SEC(NOW),
  windows: [
    { name: '5h', remaining: 900, limit: 1_000, resetAt: SEC(NOW + 300_000) },
    { name: '7d', remaining: 90_000, limit: 100_000, resetAt: SEC(NOW + 86_400_000) },
    { name: 'month', remaining: 900_000, limit: 1_000_000 },
  ],
  ...overrides,
});

describe('isQuotaError', () => {
  test('认出 429 / 限流 / 额度不足', () => {
    assert.equal(isQuotaError(new Error('HTTP 429 Too Many Requests')), true);
    assert.equal(isQuotaError('rate limit exceeded'), true);
    assert.equal(isQuotaError('insufficient quota for this window'), true);
  });

  test('普通错误与空值不算', () => {
    assert.equal(isQuotaError(new Error('model call returned no text')), false);
    assert.equal(isQuotaError(''), false);
    assert.equal(isQuotaError(undefined), false);
    assert.equal(isQuotaError(null), false);
  });
});

describe('readQuotaFile', () => {
  const readFile = (payload) => () => JSON.stringify(payload);

  test('健康快照：不暂停，带余量文案', () => {
    const result = readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: readFile(snapshot()) });
    assert.equal(result.ok, true);
    assert.equal(result.evaluation.paused, false);
    assert.match(result.line, /5h/u);
  });

  test('任一窗口低于预留线：暂停并给 resumeAt', () => {
    const tight = snapshot({
      windows: [
        { name: '5h', remaining: 100, limit: 1_000, resetAt: SEC(NOW + 300_000) },
        { name: '7d', remaining: 90_000, limit: 100_000 },
        { name: 'month', remaining: 900_000, limit: 1_000_000 },
      ],
    });
    const result = readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: readFile(tight) });
    assert.equal(result.evaluation.paused, true);
    assert.equal(result.evaluation.resumeAt, SEC(NOW + 300_000));
  });

  test('快照过期视为不紧张（stale 优先于紧张）', () => {
    const old = snapshot({ updatedAt: SEC(NOW - 30 * 60_000) });
    const result = readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: readFile(old) });
    assert.equal(result.ok, true);
    assert.equal(result.evaluation.state, 'stale');
    assert.equal(result.evaluation.paused, false);
  });

  test('缺文件 / 坏 JSON / 结构非法都返回 ok:false 且不抛', () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.deepEqual(
      readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: () => { throw enoent; } }),
      { ok: false, reason: 'file_missing' },
    );
    assert.deepEqual(
      readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: () => '{not json' }),
      { ok: false, reason: 'read_failed' },
    );
    assert.equal(
      readQuotaFile({ path: 'x.json', nowMs: NOW, readFile: () => '{"windows":"nope"}' }).ok,
      false,
    );
  });

  test('path 或 now 非法直接拒绝', () => {
    assert.deepEqual(readQuotaFile({ nowMs: NOW }), { ok: false, reason: 'path_missing' });
    assert.deepEqual(readQuotaFile({ path: '  ', nowMs: NOW }), { ok: false, reason: 'path_missing' });
    assert.deepEqual(readQuotaFile({ path: 'x.json', nowMs: Number.NaN }), { ok: false, reason: 'now_invalid' });
  });
});

describe('deferBackground', () => {
  test('暂停时挡后台触发', () => {
    assert.equal(deferBackground({ paused: true, trigger: 'threshold' }), true);
    assert.equal(deferBackground({ paused: true, trigger: 'idle' }), true);
  });

  test('hard 是安全阀，永远放行', () => {
    assert.equal(deferBackground({ paused: true, trigger: 'hard' }), false);
  });

  test('不紧张时都放行', () => {
    assert.equal(deferBackground({ paused: false, trigger: 'threshold' }), false);
    assert.equal(deferBackground({}), false);
  });
});

describe('config.quota', () => {
  test('默认 none、不读文件', () => {
    const cfg = normalizeConfig({});
    assert.equal(cfg.quota.source, 'none');
    assert.equal(cfg.quota.path, null);
    assert.deepEqual(cfg.quota.reserve, { '5h': 0.3, '7d': 0.2, month: 0.1 });
  });

  test('file 必须带路径', () => {
    assert.throws(() => normalizeConfig({ quota: { source: 'file' } }), /quota\.path/u);
    assert.throws(() => normalizeConfig({ quota: { source: 'file', path: '  ' } }), /quota\.path/u);
    assert.equal(
      normalizeConfig({ quota: { source: 'file', path: 'D:/q.json' } }).quota.path,
      'D:/q.json',
    );
  });

  test('source 只接受 none/file，reserve 越界报错', () => {
    assert.throws(() => normalizeConfig({ quota: { source: 'command' } }), /quota\.source/u);
    assert.throws(
      () => normalizeConfig({ quota: { source: 'none', reserve: { '5h': 1.2 } } }),
      /quota\.reserve\.5h/u,
    );
    assert.throws(
      () => normalizeConfig({ quota: { source: 'none', reserve: { month: -0.1 } } }),
      /quota\.reserve\.month/u,
    );
  });

  test('未知键只 warning', () => {
    const cfg = normalizeConfig({ quota: { source: 'none', nope: 1 } });
    assert.equal(cfg.warnings.some((w) => w.includes('quota.nope')), true);
  });

  test('安装自检仍是 16 键', () => {
    assert.equal(Object.keys(DEFAULTS).length, 16);
  });
});

describe('/状态 的额度行（A2）', () => {
  let dir;
  let store;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-quota-line-'));
    store = Store.open(join(dir, 'companion.db'));
  });

  after(() => {
    store?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = (quota) => handleCommand({
    text: '/状态',
    store,
    now: NOW,
    timeZone: 'Asia/Shanghai',
    quota,
  }).reply;

  test('source=none（null）不输出该行', () => {
    assert.equal(ask(null).includes('额度'), false);
    assert.equal(ask(undefined).includes('额度'), false);
  });

  test('紧张时给暂停截止时间', () => {
    const reply = ask({ source: 'file', paused: true, pausedUntil: Math.floor((NOW + 30 * 60_000) / 1000) });
    assert.match(reply, /额度紧张，后台暂停至 \d{2}:\d{2}/u);
  });

  test('充裕时用接线层文案', () => {
    const reply = ask({ source: 'file', paused: false, line: '额度充裕（5h 90%）' });
    assert.equal(reply.includes('额度充裕（5h 90%）'), true);
  });
});

describe('配额文件真实读盘', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-quota-file-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('写盘快照能被读到（含 stale 判定）', () => {
    const path = join(dir, 'quota.json');
    writeFileSync(path, JSON.stringify(snapshot()), 'utf8');
    const fresh = readQuotaFile({ path, nowMs: NOW });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.evaluation.paused, false);
    const stale = readQuotaFile({ path, nowMs: NOW + 60 * 60_000 });
    assert.equal(stale.ok, true);
    assert.equal(stale.evaluation.state, 'stale');
    assert.equal(stale.evaluation.paused, false);
  });
});
