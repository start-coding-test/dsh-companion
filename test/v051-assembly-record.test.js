/**
 * V50-L3：`/状态` 的「最近一次装配」。
 *
 * 三条不变量：
 * 1) 只记元数据——字数与短哈希，卡正文/段正文都不进记录、不进 `/状态`；
 * 2) 没记录时整行不出现（旧调用方与未接线宿主格式不变）；
 * 3) 记录只在内存里，进程重启后由下次 apply 重新生成，不读库。
 *
 * 走 FakeCtx + 临时目录 + 固定时钟，不读真实时间、不写用户目录。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import {
  createAssemblyRecord,
  describeAssembly,
  displaySectionName,
  hasAssemblyRecord,
  recordEmotionText,
  recordSections,
  recordShadow,
  shortHash,
} from '../src/persona/assembly-record.js';
import { handleCommand } from '../src/runtime/commands.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const SENTINEL = '卡正文哨兵-不要出现在状态里';

/** 极简平台上下文：只补命令/工具注册表，其余走 FakeCtx 默认能力。 */
function makePluginCtx() {
  const ctx = new FakeCtx({ now: NOW, strict: true });
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

function statusTextOf(ctx) {
  const registration = ctx.commands.registrations.find(
    (definition) => definition.definitionId === 'dsh-companion/command-status',
  );
  assert.ok(registration, '必须注册 /状态 命令');
  const result = registration.handler({ rawInput: '' });
  assert.equal(result.kind, 'success');
  return result.text;
}

function assemblyLineOf(text) {
  return text.split('\n').find((line) => line.startsWith('最近一次装配：')) ?? null;
}

describe('装配记录（纯函数）', () => {
  test('shortHash 稳定、8 位十六进制、空文本为空串', () => {
    assert.match(shortHash('abc'), /^[0-9a-f]{8}$/u);
    assert.equal(shortHash('abc'), shortHash('abc'));
    assert.notEqual(shortHash('abc'), shortHash('abd'));
    assert.equal(shortHash(''), '');
    assert.equal(shortHash(undefined), '');
    assert.equal(shortHash('abc'), createHash('sha256').update('abc').digest('hex').slice(0, 8));
  });

  test('displaySectionName 只去掉 persona: 前缀', () => {
    assert.equal(displaySectionName('persona:core'), 'core');
    assert.equal(displaySectionName('harness:identity'), 'harness:identity');
    assert.equal(displaySectionName(''), '未知');
    assert.equal(displaySectionName(undefined), '未知');
  });

  test('recordSections 跳过动态段（text 为函数），按码点计字数', () => {
    const record = createAssemblyRecord();
    assert.equal(hasAssemblyRecord(record), false);
    assert.equal(describeAssembly(record), null);

    recordSections(record, [
      { name: 'persona:safety', text: '安全底线' },
      { name: 'persona:state_board', text: () => '每轮都变' },
      { name: '', text: '无名段' },
      { name: 'persona:core', text: '😀😀' },
    ], NOW);

    const snapshot = describeAssembly(record);
    assert.equal(snapshot.sections.length, 2, '函数段与无名段都不该进记录');
    assert.deepEqual(snapshot.sections.map((section) => section.name), ['persona:safety', 'persona:core']);
    assert.equal(snapshot.sections[0].chars, 4);
    assert.equal(snapshot.sections[1].chars, 2, '按码点计数，不按 UTF-16 长度');
    assert.equal(snapshot.sectionsAt, NOW);
    assert.equal(snapshot.shadowMode, 'off');
    assert.equal(snapshot.shadowRewritten, false);
    assert.equal(snapshot.emotionText, '');
  });

  test('recordShadow 只接受三态模式，rewritten 一旦为真不再回落', () => {
    const record = createAssemblyRecord();
    recordShadow(record, { mode: 'rewrite', rewritten: true, nowMs: NOW });
    assert.equal(record.shadowMode, 'rewrite');
    assert.equal(record.shadowRewritten, true);
    recordShadow(record, { mode: 'bogus', rewritten: false, nowMs: NOW + 1 });
    assert.equal(record.shadowMode, 'rewrite', '非法模式不能覆盖已记录的模式');
    assert.equal(record.shadowRewritten, true, '已改写的事实不会被后来的放行抹掉');
  });

  test('recordEmotionText 只收非空字符串；describeAssembly 返回副本语义', () => {
    const record = createAssemblyRecord();
    recordEmotionText(record, '', NOW);
    recordEmotionText(record, null, NOW);
    assert.equal(hasAssemblyRecord(record), false);

    recordEmotionText(record, '你此刻：心情不错', NOW);
    const snapshot = describeAssembly(record);
    assert.equal(snapshot.emotionText, '你此刻：心情不错');
    assert.equal(snapshot.emotionAt, NOW);
  });
});

describe('装配记录（/状态 集成）', () => {
  let dir;
  let cardPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'companion-assembly-'));
    cardPath = join(dir, 'persona.json');
    writeFileSync(cardPath, JSON.stringify({
      name: '岚',
      address: '你',
      description: SENTINEL,
      chatIdentity: '你是{{char}}，是{{user}}的邻居姐姐。',
      tone: { notes: '轻声' },
    }, null, 2), 'utf8');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('apply 后：段字数与短哈希可复核，卡正文与段正文都不出现', () => {
    const ctx = makePluginCtx();
    const handle = applyCordis(strictCtx(ctx), {
      dbPath: join(dir, 'main.db'),
      persona: { cardPath },
    });
    try {
      const line = assemblyLineOf(statusTextOf(ctx));
      assert.ok(line, 'apply 之后必须有装配记录行');
      assert.match(line, /部署人设 宿主默认；prefix 未改写/u);
      assert.match(line, /段 safety \d+\/[0-9a-f]{8}、core \d+\/[0-9a-f]{8}、protocol \d+\/[0-9a-f]{8}/u);
      assert.equal(line.includes(SENTINEL), false, '卡正文不得进 /状态');
      assert.doesNotMatch(line, /邻居姐姐/u, '段正文不得进 /状态');

      // 段字数与哈希要和真实注册的段文本对得上（不是随便填的数）。
      const core = ctx.sections
        .map((entry) => entry.section)
        .find((section) => section?.name === 'persona:core');
      assert.ok(core, '人格段必须已注册');
      const expectedChars = [...core.text].length;
      const expectedHash = createHash('sha256').update(core.text).digest('hex').slice(0, 8);
      assert.match(line, new RegExp(`core ${expectedChars}/${expectedHash}`, 'u'));
    } finally {
      handle.dispose();
    }
  });

  test('情绪句只出现在记录里，渲染成「情绪句「…」」，且不含数字', () => {
    const store = Store.open(join(dir, 'status.db'));
    try {
      const record = createAssemblyRecord();
      recordSections(record, [{ name: 'persona:core', text: '你是岚。' }], NOW);
      recordEmotionText(record, '你此刻：心情不错，有点惦记他今天加班', NOW);

      const { reply } = handleCommand({ text: '/状态', store, now: NOW, assembly: record });
      const line = assemblyLineOf(reply);
      assert.ok(line);
      assert.match(line, /情绪句「你此刻：心情不错，有点惦记他今天加班」/u);
      assert.doesNotMatch(line, /[0-9]+(?:\.\d+)?[ ]*(?:分钟|小时)前/u);
      // 情绪句本体不含数值（「N 分钟前」是装配时间，属允许的展示）。
      const sentence = line.slice(line.indexOf('情绪句「'));
      assert.doesNotMatch(sentence, /[0-9]/u);
    } finally {
      store.close();
    }
  });

  test('没有记录时不输出该行（旧调用方格式不变）', () => {
    const store = Store.open(join(dir, 'legacy.db'));
    try {
      const legacy = handleCommand({ text: '/状态', store, now: NOW });
      assert.equal(assemblyLineOf(legacy.reply), null);
      const empty = handleCommand({ text: '/状态', store, now: NOW, assembly: createAssemblyRecord() });
      assert.equal(assemblyLineOf(empty.reply), null, '空记录与不传等价');
    } finally {
      store.close();
    }
  });
});
