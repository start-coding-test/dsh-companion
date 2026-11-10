/**
 * P1（v0.4.13）生产接线：apply 时把截断/导入诊断各记一条 warn（含段名与码点数、
 * 不含正文），且内置卡不产生任何新 warn。
 *
 * 卡文件全部写在 mkdtemp 临时目录；不写用户 ~/.dsh、不联网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { TEST_NOW, makeTempStore } from './e2e/helpers.js';

const CCV2 = readFileSync(new URL('./fixtures/persona-ccv2.json', import.meta.url), 'utf8');
const TRUNCATE_WARN = '[dsh-companion] persona section truncated; text clipped to limit';
const IMPORT_WARN = '[dsh-companion] persona card import warning';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** @param {{now?: number}} [options] */
function makePluginCtx({ now = TEST_NOW } = {}) {
  const ctx = new FakeCtx({ now, strict: true });
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
  return ctx;
}

/**
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-companion-p1-wiring-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @param {FakeCtx} ctx @param {string} message */
function warnsOf(ctx, message) {
  return ctx.logs.filter((log) => log.level === 'warn' && log.message === message);
}

/** @param {FakeCtx} ctx */
function coreTextOf(ctx) {
  const core = ctx.sections
    .map((entry) => entry.section)
    .find((section) => section?.name === 'persona:core');
  assert.ok(core, '必须注册 persona:core');
  return core.text;
}

test('CCv2 文件卡的 character_book → apply 记一条 import warning（不含书内容）', (t) => {
  const dir = tempDir(t);
  const cardPath = join(dir, 'ccv2.json');
  writeFileSync(cardPath, CCV2, 'utf8');
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
    const warns = warnsOf(ctx, IMPORT_WARN);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].meta.code, 'character_book_ignored');
    assert.equal(warns[0].meta.path, cardPath);
    assert.ok(coreTextOf(ctx).includes('你是阿岩，你的老同学。'));
    // 书内容（正文/书名/关键词）不得进入任何日志。
    const logged = JSON.stringify(ctx.logs);
    assert.ok(!logged.includes('阿岩其实怕黑'));
    assert.ok(!logged.includes('隐藏书'));
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

test('core 超 1200 → apply 记一条截断 warn，带 section/chars/max 且不含正文', (t) => {
  const dir = tempDir(t);
  const cardPath = join(dir, 'long.json');
  const description = 'BODY_SENTINEL_'.repeat(100); // 1400 码点
  writeFileSync(cardPath, JSON.stringify({
    name: '珞然',
    address: '你',
    tone: { style: '简洁', warmth: '温和', structure: '先结论' },
    description,
  }), 'utf8');
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath, persona: { cardPath } });
    const warns = warnsOf(ctx, TRUNCATE_WARN);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].meta.section, 'persona:core');
    assert.ok(warns[0].meta.chars > 1200);
    assert.equal(warns[0].meta.max, 1200);
    assert.ok(!JSON.stringify(warns).includes('BODY_SENTINEL_'));
    assert.equal([...coreTextOf(ctx)].length, 1200);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});

test('内置卡 → 不产生截断/导入 warn（基线静默）', (t) => {
  const temp = makeTempStore();
  const ctx = makePluginCtx();
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath });
    assert.equal(warnsOf(ctx, TRUNCATE_WARN).length, 0);
    assert.equal(warnsOf(ctx, IMPORT_WARN).length, 0);
  } finally {
    handle?.dispose();
    temp.cleanup();
  }
});
