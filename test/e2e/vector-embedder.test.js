import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';

function openCtx(config) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-vector-e2e-'));
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
  return { ctx, dir, handle: apply(ctx, { dbPath: join(dir, 'companion.db'), ...config }) };
}

function dispose(entry) {
  entry.handle.dispose();
  rmSync(entry.dir, { recursive: true, force: true });
}

function withCtx(config, fn) {
  const entry = openCtx(config);
  try {
    fn(entry.ctx);
  } finally {
    dispose(entry);
  }
}

function statusText(ctx) {
  const definition = ctx.commands.registrations.find((entry) => entry.name === 'status');
  assert.ok(definition, 'status 命令应已注册');
  return definition.handler({ rawInput: '' }).text;
}

test('/状态：hash embedder 开启时显示 id、维度、已回填与最近命中', () => {
  withCtx({ vector: { enabled: true, dim: 64, embedder: 'hash' } }, (ctx) => {
    const text = statusText(ctx);
    assert.match(text, /向量：开·dim 64·hash:64·已回填 0·最近命中 0/u);
  });
});

test('/状态：remote 未显式 enabled 时保持关闭，不装配第三方 embedder', () => {
  withCtx(
    {
      vector: {
        enabled: true,
        embedder: 'remote',
        remote: { enabled: false, endpoint: 'https://embed.example.com/v1' },
      },
    },
    (ctx) => {
      assert.match(statusText(ctx), /向量：关/u);
      assert.equal(
        ctx.logs.some((entry) => entry.message.includes('third party')),
        false,
        '未启用 remote 不应发隐私告警',
      );
    },
  );
});

test('/状态：remote 显式开启时显示目标域名，并记录隐私 warn', () => {
  withCtx(
    {
      vector: {
        enabled: true,
        embedder: 'remote',
        remote: { enabled: true, endpoint: 'https://embed.example.com/v1', timeoutMs: 120 },
      },
    },
    (ctx) => {
      const text = statusText(ctx);
      assert.match(text, /向量：开·dim 0·remote:embed\.example\.com·已回填 0/u);
      const warning = ctx.logs.find((entry) => entry.message.includes('third party'));
      assert.ok(warning, 'remote 开启时应写隐私 warn');
      assert.equal(warning.level, 'warn');
      assert.equal(warning.meta.host, 'embed.example.com');
    },
  );
});


