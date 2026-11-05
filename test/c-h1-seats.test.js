/**
 * C-H1 回归：测试席位（now/cwd/workspace/rssReader/companion）只能经
 * `ctx.get()` 或 `apply(ctx, config, hooks)` 读取，缺省回落进程能力；
 * 直接读 Context 代理属性会被严格代理拦下（见 plugin-smoke）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../src/index.js';
import { createAdapter } from '../src/platform/adapter.js';
import { FakeCtx } from './fakes/ctx.js';
import { strictCtx } from './helpers/strict-ctx.js';

function makePluginCtx() {
  const ctx = new FakeCtx();
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

test('adapter：now/cwd 经 ctx.get/opts 读取，缺省回落 Date.now()', () => {
  const ctx = new FakeCtx({ now: 1_700_000_000_000 });
  const adapter = createAdapter(ctx);
  assert.equal(adapter.now(), 1_700_000_000_000);
  ctx.advance(250);
  assert.equal(adapter.now(), 1_700_000_000_250);
  assert.equal(adapter.cwd(), undefined, 'FakeCtx 未给 cwd 时不伪造目录');

  const hooked = createAdapter(ctx, { now: () => 42, cwd: () => '/hook/cwd' });
  assert.equal(hooked.now(), 42);
  assert.equal(hooked.cwd(), '/hook/cwd');

  const bare = createAdapter({});
  assert.ok(Math.abs(bare.now() - Date.now()) < 30_000);
  assert.equal(bare.cwd(), undefined);
});

test('apply 的 hooks 席位优先于宿主：cwd 进 thread_run 的 create 请求', async () => {
  const ctx = makePluginCtx();
  const handle = apply(strictCtx(ctx), { dbPath: ':memory:' }, {
    cwd: '/hooked/cwd',
    now: () => 1_700_000_000_000,
  });

  const tool = ctx.tools.registrations.find((definition) => definition.name === 'thread_run');
  assert.equal(typeof tool?.execute, 'function');

  const result = await tool.execute({ key: 'new', name: 'C-H1 席位', goal: '把席位读法锁住' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const call = ctx.callsOf('sessionController.create')[0];
  assert.equal(call.args[0].cwd, '/hooked/cwd');

  handle.dispose();
});

test('apply 在裸 ctx 上不读 Context 属性也能安装（席位回落进程能力）', () => {
  const ctx = {};
  const handle = apply(ctx, { dbPath: ':memory:' });
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
});

test('adapter：函数形 logger 把日志镜像到 stderr，发布门才看得到 marker', () => {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    // headless 宿主：logger 是函数对象，info() 调用成功但没有可见 sink。
    const headlessLogger = Object.assign(() => {}, {
      debug() {},
      info() {},
      warn() {},
      error() {},
    });
    const adapter = createAdapter({ logger: headlessLogger, get: () => undefined });
    assert.equal(adapter.log('info', '[dsh-companion] scheduler started', { jobs: 6 }), true);
    const mirrored = lines.join('');
    assert.ok(mirrored.includes('[dsh-companion] scheduler started'), 'marker 必须写到 stderr');
    assert.ok(mirrored.includes('{"jobs":6}'), 'meta 一并镜像，便于真机排查');

    lines.length = 0;
    // 桌面宿主：logger 是普通对象，照旧只写宿主 sink，不污染 stderr。
    const desktopLogger = { debug() {}, info() {}, warn() {}, error() {} };
    const desktop = createAdapter({ logger: desktopLogger, get: () => undefined });
    desktop.log('info', 'desktop only');
    assert.deepEqual(lines, []);
  } finally {
    process.stderr.write = original;
  }
});
