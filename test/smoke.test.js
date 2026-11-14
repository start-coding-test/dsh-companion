import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 本卡只校验仓库骨架本身；这里直接读取 package.json，不 import 插件入口。
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

test('package.json name 为 dsh-companion', () => {
  assert.equal(pkg.name, 'dsh-companion');
});

test('package.json version 为 0.7.4', () => {
  assert.equal(pkg.version, '0.7.4');
});

test('package.json 定义了 node --test 脚本', () => {
  assert.equal(typeof pkg.scripts?.test, 'string');
  assert.equal(pkg.scripts.test, 'node --test');
});
