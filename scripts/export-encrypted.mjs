#!/usr/bin/env node
/**
 * P2-a：单条事实的加密导出。
 *
 *   node scripts/export-encrypted.mjs <db> <fact-id> --out <file>
 *
 * passphrase 只从 stdin 读取；命令行参数、日志、文件名中都不出现。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { Store } from '../src/memory/store.js';
import { EXPORT_VERSION, encryptJson } from '../src/memory/export.js';

/**
 * 读取一行口令。TTY 下关闭回显；管道输入直接读到 EOF。
 * @returns {Promise<string>}
 */
async function readPassphrase() {
  const tty = process.stdin.isTTY === true;
  if (tty) {
    process.stdin.setRawMode(true);
    process.stderr.write('Passphrase: ');
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const cleanup = () => {
      if (tty) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // 终端已关闭时忽略。
        }
        process.stderr.write('\n');
      }
      process.stdin.pause();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data.replace(/\r?\n$/u, ''));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n') || data.includes('\r')) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', reject);
  });
}

/**
 * @param {string[]} argv
 * @returns {{dbPath: string, id: string, out: string}}
 */
function parseArgs(argv) {
  const positional = [];
  let out = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2 || out === '') {
    throw new UsageError('用法：node scripts/export-encrypted.mjs <db> <fact-id> --out <file>');
  }
  return { dbPath: positional[0], id: positional[1], out };
}

class UsageError extends Error {}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const passphrase = await readPassphrase();
  if (passphrase.trim() === '') {
    console.error('错误：passphrase 不能为空');
    process.exitCode = 1;
    return;
  }

  let store;
  try {
    store = Store.open(options.dbPath);
    const fact = store.getFact(options.id);
    if (!fact) throw new Error(`没有找到事实 ${options.id}`);
    const payload = {
      version: EXPORT_VERSION,
      type: 'fact',
      exported_at: new Date().toISOString(),
      id: options.id,
      fact,
    };
    const text = encryptJson(payload, passphrase, { id: options.id });
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, text, 'utf8');
    console.log(options.out);
  } catch (error) {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (store) store.close();
  }
}

await main();
