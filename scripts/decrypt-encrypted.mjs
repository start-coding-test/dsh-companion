#!/usr/bin/env node
/**
 * P2-a：解密 export-encrypted.mjs 生成的文件，用于恢复验证。
 *
 *   node scripts/decrypt-encrypted.mjs <encrypted-file> [--out <json-file>]
 *
 * passphrase 只从 stdin 读取；不打印、不写入日志。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { decryptJson } from '../src/memory/export.js';

/**
 * @param {string[]} argv
 * @returns {{file: string, out: string}}
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
  if (positional.length !== 1) {
    throw new Error('用法：node scripts/decrypt-encrypted.mjs <encrypted-file> [--out <json-file>]');
  }
  return { file: positional[0], out };
}

/**
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
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (tty) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // 终端已关闭时忽略。
        }
        process.stderr.write('\n');
      }
      process.stdin.pause();
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

  try {
    const payload = decryptJson(readFileSync(options.file, 'utf8'), passphrase);
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    if (options.out !== '') {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, body, 'utf8');
      console.log(options.out);
    } else {
      process.stdout.write(body);
    }
  } catch (error) {
    console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
