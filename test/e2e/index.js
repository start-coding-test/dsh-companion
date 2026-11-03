/**
 * 目录入口：让 `node --test test/e2e` 在 Node 24 上也能跑通。
 *
 * Node v24.9.0 的前置位置参数按模块入口解析，目录必须能被解析成
 * index.js；这里把各 e2e 文件显式 import 进来。
 *
 * 注意：`node --test`（无参数）的默认发现也会把这个 index.js 当测试文件，
 * 若无条件 import 会让每个 e2e 用例跑两遍。目录模式子进程的 argv[1] 是目录
 * 本身，默认发现时是 index.js，据此只在目录模式注册。
 */

const entry = process.argv[1] ?? '';
const invokedAsDirectory = /[\\/]test[\\/]e2e$/u.test(entry);

if (invokedAsDirectory) {
  await import('./acceptance.test.js');
  await import('./apply-turn.test.js');
  await import('./assemble-budget.test.js');
  await import('./forget.test.js');
  await import('./interrupt.test.js');
  await import('./plugin-smoke.test.js');
  await import('./turn.test.js');
  await import('./write-fail.test.js');
}
