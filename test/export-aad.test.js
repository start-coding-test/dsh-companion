import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { decryptJson, encryptJson, exportAll } from '../src/memory/export.js';

const TEST_NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const MAGIC = 'DSH-COMPANION-EXPORT-1';
const PASSPHRASE = 'correct horse battery staple';

function makeDatabase(t, prefix = 'dsh-export-aad-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = Store.open(join(dir, 'companion.db'));
  t.after(() => {
    try {
      store.close();
    } catch {
      // 已关闭时继续清理。
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

function splitEncrypted(text) {
  const lines = text.split('\n');
  return {
    magic: lines[0],
    header: JSON.parse(lines[1]),
    ciphertext: lines[2],
    join: (header, ciphertext = lines[2]) => `${lines[0]}\n${JSON.stringify(header)}\n${ciphertext}\n`,
  };
}

test('加密 v2：header 绑定为 AAD，篡改 header 失败且错误不泄漏明文', () => {
  const secret = 'TOP-SECRET-明文不应出现在错误里';
  const text = encryptJson({ secret }, PASSPHRASE, { id: 'fact-aad' });
  const parts = splitEncrypted(text);
  assert.equal(parts.magic, MAGIC);
  assert.equal(parts.header.format, 'v2');
  assert.deepEqual(decryptJson(text, PASSPHRASE), { secret });

  const tampered = { ...parts.header, id: 'forged' };
  assert.throws(
    () => decryptJson(parts.join(tampered), PASSPHRASE),
    (error) => {
      assert.match(error.message, /解密失败/u);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('加密 v2：篡改密文失败', () => {
  const text = encryptJson({ hello: '世界' }, PASSPHRASE);
  const parts = splitEncrypted(text);
  const bytes = Buffer.from(parts.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(
    () => decryptJson(parts.join(parts.header, bytes.toString('base64')), PASSPHRASE),
    /解密失败/u,
  );
});

test('加密 v2：篡改认证标签失败', () => {
  const text = encryptJson({ hello: '世界' }, PASSPHRASE);
  const parts = splitEncrypted(text);
  const tampered = { ...parts.header, tag: randomBytes(16).toString('base64') };
  assert.throws(() => decryptJson(parts.join(tampered), PASSPHRASE), /解密失败/u);
});

test('加密 v1（无 AAD）旧文件继续可解', () => {
  const secret = { legacy: true, note: 'v1 文件' };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(PASSPHRASE, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(secret), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const header = {
    version: 1,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    id: null,
    created_at: new Date(TEST_NOW).toISOString(),
  };
  const legacy = `${MAGIC}\n${JSON.stringify(header)}\n${ciphertext.toString('base64')}\n`;
  assert.deepEqual(decryptJson(legacy, PASSPHRASE), secret);
});

test('schema_version：优先读取 store 的 schema_meta，不硬编码', (t) => {
  const { dir, store } = makeDatabase(t);
  store.setMeta('schema_version', '4');
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.schema_version, '4');
});

test('schema_version：meta 缺失时回退当前版本而不是旧常量', (t) => {
  const { dir, store } = makeDatabase(t);
  store.db.prepare("DELETE FROM schema_meta WHERE key = 'schema_version'").run();
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.schema_version, '12');
});

test('导出文件名：秒级时间戳，同一秒重复追加 -2/-3 而不覆盖', (t) => {
  const { dir, store } = makeDatabase(t);
  const first = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const second = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  const third = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  assert.match(first.path, /memory-2026-11-05-090000\.json$/u);
  assert.match(second.path, /memory-2026-11-05-090000-2\.json$/u);
  assert.match(third.path, /memory-2026-11-05-090000-3\.json$/u);
  assert.equal(new Set([first.path, second.path, third.path]).size, 3);
  for (const path of [first.path, second.path, third.path]) {
    assert.equal(existsSync(path), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
  }
});

test('导出文件名：已有同名文件时拒绝覆盖并递增', (t) => {
  const { dir, store } = makeDatabase(t);
  const existing = join(dir, 'memory-2026-11-05-090000.json');
  writeFileSync(existing, 'sentinel', 'utf8');
  const exported = exportAll({ store, format: 'json', dir, now: TEST_NOW });
  assert.match(exported.path, /memory-2026-11-05-090000-2\.json$/u);
  assert.equal(readFileSync(existing, 'utf8'), 'sentinel');
});
