/**
 * v0.4.4 加固测试：
 * - V3-L1：headless 函数型 logger 的 stderr 镜像只含 info 及以上；
 * - V3-H3②：capabilities.threadTools 能力探测（不实际 createSession）；
 * - V3-H3②：/状态 在宿主不支持线程时明确提示；
 * - V3-L3：中文命令前缀识别与 pre-step 提示消息形状。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdapter } from '../src/platform/adapter.js';
import {
  CHINESE_COMMAND_HINT,
  COMMAND_HINT_SOURCE_KIND,
  chineseCommandHint,
  commandHintMessage,
  handleCommand,
} from '../src/runtime/commands.js';
import { Store } from '../src/memory/store.js';
import { FakeCtx } from './fakes/ctx.js';

const NOW_MS = Date.UTC(2026, 10, 3, 12, 0, 0);

// --------------------------------------------------------- V3-L1 日志镜像

/** headless 宿主的 logger 是函数（没有 info/warn 方法），适配层才会镜像 stderr。 */
function headlessCtx() {
  const logs = [];
  const logger = (...args) => logs.push(args);
  return {
    logs,
    logger,
    on() {},
    get() {
      return undefined;
    },
  };
}

/** 临时接管 process.stderr.write，收集镜像输出。 */
function captureStderr(run) {
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    return { writes, value: run() };
  } finally {
    process.stderr.write = original;
  }
}

function withEnv(name, value, run) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test('V3-L1：headless 函数型 logger 默认只镜像 info/warn/error，不镜像 debug', () => {
  withEnv('DSH_COMPANION_MIRROR_DEBUG', undefined, () => {
    const { writes } = captureStderr(() => {
      const adapter = createAdapter(headlessCtx());
      adapter.log('debug', 'DBG-only');
      adapter.log('info', 'INFO-kept');
      adapter.log('warn', 'WARN-kept');
      adapter.log('error', 'ERROR-kept');
    });
    const text = writes.join('');
    assert.ok(!text.includes('DBG-only'), `debug 不应出现在 stderr：${text}`);
    assert.match(text, /INFO-kept/);
    assert.match(text, /WARN-kept/);
    assert.match(text, /ERROR-kept/);
  });
});

test('V3-L1：DSH_COMPANION_MIRROR_DEBUG=1 时 debug 也镜像（显式开关）', () => {
  withEnv('DSH_COMPANION_MIRROR_DEBUG', '1', () => {
    const { writes } = captureStderr(() => {
      const adapter = createAdapter(headlessCtx());
      adapter.log('debug', 'DBG-explicit');
    });
    assert.match(writes.join(''), /DBG-explicit/);
  });
});

test('V3-L1：桌面对象型 logger 不往 stderr 镜像', () => {
  const { writes } = captureStderr(() => {
    const adapter = createAdapter(new FakeCtx());
    adapter.log('info', 'OBJECT-LOGGER');
  });
  assert.deepEqual(writes, []);
});

// ----------------------------------------------------- V3-H3② 能力探测

test('V3-H3②：无 sessionController 时 threadTools=false，且探测不创建会话', () => {
  const ctx = new FakeCtx({ missing: ['sessionController'] });
  const adapter = createAdapter(ctx);

  assert.equal(adapter.capabilities.sessionController, false);
  assert.equal(adapter.capabilities.threadTools, false);
  // 探测只读服务对象：不调用 create/prompt/cancel。
  assert.equal(ctx.callsOf('sessionController.create').length, 0);
  assert.equal(ctx.callsOf('sessionController.prompt').length, 0);
  assert.equal(ctx.callsOf('sessionController.cancel').length, 0);
});

test('V3-H3②：sessionController 方法不齐时 threadTools 也是 false', () => {
  for (const missing of [
    'sessionController.create',
    'sessionController.prompt',
    'sessionController.cancel',
  ]) {
    const adapter = createAdapter(new FakeCtx({ missing: [missing] }));
    assert.equal(adapter.capabilities.threadTools, false, `缺 ${missing} 应为 false`);
  }
});

test('V3-H3②：能力齐全时 threadTools=true 且探测无副作用', () => {
  const ctx = new FakeCtx();
  const adapter = createAdapter(ctx);
  assert.equal(adapter.capabilities.threadTools, true);
  assert.equal(ctx.callsOf('sessionController.create').length, 0);
});

// ------------------------------------------------- V3-H3② /状态 文案

test('V3-H3②：/状态 在 threadsSupported=false 时显示「线程：宿主不支持」', () => {
  const store = Store.open(':memory:');
  try {
    const reply = handleCommand({
      text: '/状态',
      store,
      now: NOW_MS,
      threadsSupported: false,
    }).reply;
    assert.match(reply, /线程：宿主不支持/);
    assert.match(reply, /thread_run\/task_run\/thread_\*/);
  } finally {
    store.close();
  }
});

test('V3-H3②：threadsSupported 缺省或 true 时 /状态 不出现不支持提示', () => {
  const store = Store.open(':memory:');
  try {
    for (const threadsSupported of [undefined, true]) {
      const reply = handleCommand({
        text: '/状态',
        store,
        now: NOW_MS,
        threadsSupported,
      }).reply;
      assert.doesNotMatch(reply, /宿主不支持/u);
    }
  } finally {
    store.close();
  }
});

// ------------------------------------------------------- V3-L3 中文命令

test('V3-L3：/记忆、/状态、/成本、/线程 前缀识别为中文命令误输入', () => {
  for (const text of ['/记忆', '/记忆 忘掉 abc', '  /状态', '/成本 本月', '/线程 列表']) {
    assert.equal(chineseCommandHint(text), CHINESE_COMMAND_HINT, text);
  }
});

test('V3-L3：ASCII 命令、普通文本与中文不带斜杠都不算误输入', () => {
  for (const text of ['/memory', '/status', '/cost', '/threads', '记忆', '今天天气不错', '', undefined]) {
    assert.equal(chineseCommandHint(text), null, String(text));
  }
});

test('V3-L3：commandHintMessage 是完整平台消息（id/role/content/source）', () => {
  const message = commandHintMessage('/记忆 忘掉 abc');
  assert.ok(message);
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.equal(message.role, 'user');
  assert.ok(Array.isArray(message.content));
  assert.equal(message.content[0].type, 'text');
  assert.match(message.content[0].text, /请用 \/memory、\/status、\/cost、\/threads/);
  assert.deepEqual(message.source, { kind: COMMAND_HINT_SOURCE_KIND });

  // 每条消息 id 不同，避免平台按 id 去重时吞掉后一条提示。
  assert.notEqual(commandHintMessage('/状态').id, commandHintMessage('/状态').id);
  assert.equal(commandHintMessage('/memory'), null);
  assert.equal(commandHintMessage('普通文本'), null);
});
