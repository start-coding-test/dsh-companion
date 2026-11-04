import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, DEFAULTS, normalizeConfig } from '../src/config.js';

function expectConfigError(raw, field) {
  assert.throws(
    () => normalizeConfig(raw),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, field);
      return true;
    },
  );
}

test('vector 默认：关闭、256 维、hash embedder 及可插拔默认键', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.vector, {
    enabled: false,
    dim: 256,
    embedder: 'hash',
    localModel: 'Xenova/bge-small-zh-v1.5',
    prefixQuery: true,
    embedderId: '',
    embedTimeoutMs: 300,
    backfillBatchSize: 50,
    remote: { enabled: false, endpoint: '', apiKeyEnv: '', timeoutMs: 300 },
  });
  assert.ok(Object.isFrozen(cfg.vector));
  assert.ok(Object.isFrozen(cfg.vector.remote));
});

test('vector 覆盖：enabled/dim/embedder 均生效且被冻结', () => {
  const cfg = normalizeConfig({ vector: { enabled: true, dim: 64, embedder: 'none' } });
  assert.equal(cfg.vector.enabled, true);
  assert.equal(cfg.vector.dim, 64);
  assert.equal(cfg.vector.embedder, 'none');
  assert.ok(Object.isFrozen(cfg.vector));
});

test('vector 部分覆盖：未提供的子键回落到默认值', () => {
  const cfg = normalizeConfig({ vector: { enabled: true } });
  assert.equal(cfg.vector.enabled, true);
  assert.equal(cfg.vector.dim, 256);
  assert.equal(cfg.vector.embedder, 'hash');
  assert.equal(cfg.vector.backfillBatchSize, 50);
});

test('vector 未知子键：只 warning，不影响其它配置', () => {
  const cfg = normalizeConfig({ vector: { enabled: true, foo: 1 } });
  assert.equal(cfg.vector.enabled, true);
  assert.ok(cfg.warnings.some((warning) => warning.includes('vector.foo')));
});

test('vector 非对象：抛 ConfigError(vector)', () => {
  expectConfigError({ vector: 'on' }, 'vector');
  expectConfigError({ vector: null }, 'vector');
});

test('vector.enabled 非布尔：抛 ConfigError(vector.enabled)', () => {
  expectConfigError({ vector: { enabled: 'yes' } }, 'vector.enabled');
  expectConfigError({ vector: { enabled: 1 } }, 'vector.enabled');
});

test('vector.dim 边界：8 与 4096 合法，越界/非整数报错', () => {
  assert.equal(normalizeConfig({ vector: { dim: 8 } }).vector.dim, 8);
  assert.equal(normalizeConfig({ vector: { dim: 4096 } }).vector.dim, 4096);
  for (const dim of [7, 4097, 0, -1, 12.5, '256']) {
    expectConfigError({ vector: { dim } }, 'vector.dim');
  }
});

test('vector.embedder 白名单：hash/local/remote/none 合法，其它报错', () => {
  assert.equal(normalizeConfig({ vector: { embedder: 'hash' } }).vector.embedder, 'hash');
  assert.equal(normalizeConfig({ vector: { embedder: 'local' } }).vector.embedder, 'local');
  assert.equal(
    normalizeConfig({
      vector: { embedder: 'remote', remote: { enabled: true, endpoint: 'https://embed.example.com/v1' } },
    }).vector.embedder,
    'remote',
  );
  assert.equal(normalizeConfig({ vector: { embedder: 'none' } }).vector.embedder, 'none');
  expectConfigError({ vector: { embedder: 'openai' } }, 'vector.embedder');
});

test('vector 可插拔子键：localModel/prefixQuery/embedderId/超时/回填批量生效', () => {
  const cfg = normalizeConfig({
    vector: {
      embedder: 'local',
      localModel: 'Xenova/e5-small',
      prefixQuery: false,
      embedderId: 'my-local',
      embedTimeoutMs: 1200,
      backfillBatchSize: 12,
    },
  });
  assert.equal(cfg.vector.localModel, 'Xenova/e5-small');
  assert.equal(cfg.vector.prefixQuery, false);
  assert.equal(cfg.vector.embedderId, 'my-local');
  assert.equal(cfg.vector.embedTimeoutMs, 1200);
  assert.equal(cfg.vector.backfillBatchSize, 12);
  assert.ok(Object.isFrozen(cfg.vector));
});

test('vector.remote：合法配置、端点必填、超时继承', () => {
  const cfg = normalizeConfig({
    vector: {
      embedder: 'remote',
      embedderId: 'remote:corp',
      remote: { enabled: true, endpoint: 'https://embed.example.com/v1', apiKeyEnv: 'EMB_KEY' },
    },
  });
  assert.deepEqual(cfg.vector.remote, {
    enabled: true,
    endpoint: 'https://embed.example.com/v1',
    apiKeyEnv: 'EMB_KEY',
    timeoutMs: 300,
  });
  assert.ok(Object.isFrozen(cfg.vector.remote));

  const customTimeout = normalizeConfig({
    vector: {
      embedder: 'remote',
      remote: { enabled: true, endpoint: 'http://127.0.0.1:9999/embed', timeoutMs: 42 },
    },
  });
  assert.equal(customTimeout.vector.remote.timeoutMs, 42);

  expectConfigError(
    { vector: { embedder: 'remote', remote: { enabled: true, endpoint: '' } } },
    'vector.remote.endpoint',
  );
  expectConfigError(
    { vector: { embedder: 'remote', remote: { enabled: true, endpoint: 'file:///tmp/x' } } },
    'vector.remote.endpoint',
  );
  expectConfigError({ vector: { remote: { enabled: 'yes' } } }, 'vector.remote.enabled');
  expectConfigError({ vector: { remote: { enabled: false, endpoint: 1 } } }, 'vector.remote.endpoint');
  expectConfigError({ vector: { remote: { enabled: false, apiKeyEnv: 1 } } }, 'vector.remote.apiKeyEnv');
  expectConfigError({ vector: { remote: { enabled: false, timeoutMs: 0 } } }, 'vector.remote.timeoutMs');
  expectConfigError({ vector: { remote: 'on' } }, 'vector.remote');
});

test('vector 可插拔子键非法值逐项报 ConfigError(field)', () => {
  for (const localModel of ['', '   ', 1, null]) {
    expectConfigError({ vector: { localModel } }, 'vector.localModel');
  }
  for (const prefixQuery of ['true', 1, null]) {
    expectConfigError({ vector: { prefixQuery } }, 'vector.prefixQuery');
  }
  for (const embedderId of [1, null, {}]) {
    expectConfigError({ vector: { embedderId } }, 'vector.embedderId');
  }
  for (const embedTimeoutMs of [0, -1, 60_001, 1.5, '300']) {
    expectConfigError({ vector: { embedTimeoutMs } }, 'vector.embedTimeoutMs');
  }
  for (const backfillBatchSize of [0, 51, 2.5, '10']) {
    expectConfigError({ vector: { backfillBatchSize } }, 'vector.backfillBatchSize');
  }
});

test('vector.remote 未知子键：只 warning', () => {
  const cfg = normalizeConfig({
    vector: { remote: { enabled: false, foo: true } },
  });
  assert.ok(cfg.warnings.some((warning) => warning.includes('vector.remote.foo')));
});

test('DEFAULTS.vector 不被 normalize 结果共享引用修改', () => {
  const cfg = normalizeConfig({ vector: { dim: 128 } });
  assert.equal(DEFAULTS.vector.dim, 256);
  assert.equal(cfg.vector.dim, 128);
});
