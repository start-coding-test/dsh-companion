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

test('vector 默认：关闭、256 维、hash embedder', () => {
  const cfg = normalizeConfig({});
  assert.deepEqual(cfg.vector, { enabled: false, dim: 256, embedder: 'hash' });
  assert.ok(Object.isFrozen(cfg.vector));
});

test('vector 覆盖：enabled/dim/embedder 均生效且被冻结', () => {
  const cfg = normalizeConfig({ vector: { enabled: true, dim: 64, embedder: 'none' } });
  assert.deepEqual(cfg.vector, { enabled: true, dim: 64, embedder: 'none' });
  assert.ok(Object.isFrozen(cfg.vector));
});

test('vector 部分覆盖：未提供的子键回落到默认值', () => {
  const cfg = normalizeConfig({ vector: { enabled: true } });
  assert.deepEqual(cfg.vector, { enabled: true, dim: 256, embedder: 'hash' });
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

test('vector.embedder 白名单：hash/none 合法，其它报错', () => {
  assert.equal(normalizeConfig({ vector: { embedder: 'hash' } }).vector.embedder, 'hash');
  assert.equal(normalizeConfig({ vector: { embedder: 'none' } }).vector.embedder, 'none');
  expectConfigError({ vector: { embedder: 'openai' } }, 'vector.embedder');
});

test('DEFAULTS.vector 不被 normalize 结果共享引用修改', () => {
  const cfg = normalizeConfig({ vector: { dim: 128 } });
  assert.equal(DEFAULTS.vector.dim, 256);
  assert.equal(cfg.vector.dim, 128);
});
