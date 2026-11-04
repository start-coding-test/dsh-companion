/**
 * E-M1：local embedder 的加载/推理超时、异步预热、错误分类与退避重试。
 *
 * 全部用注入的 fake loader，不联网、不依赖可选包。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EmbeddingTimeout,
  EmbeddingUnavailable,
  createEmbedder,
} from '../src/memory/embedders/index.js';
import { createLocalEmbedder } from '../src/memory/embedders/local.js';
import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';

const NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_SEC = 86_400;
const MODEL = 'Xenova/bge-small-zh-v1.5';
const DIM = 512;

/** 测试内定时器登记，结束前清理，避免 unref 前的挂起句柄拖慢套件。 */
const timers = new Set();

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  });
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

function fakeModule() {
  return {
    pipeline: async () => async (batch) => batch.map(() => new Array(DIM).fill(0.25)),
  };
}

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-local-embed-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addFact(store) {
  return store.insertFact({
    scope: 'main',
    kind: 'knowledge',
    subject_text: '项目',
    predicate: '代号',
    object_text: '晨星',
    statement: '项目代号是晨星',
    source_kind: 'user_explicit',
    salience: 'normal',
    observed_at: NOW_SEC - DAY_SEC,
    last_reinforced_at: NOW_SEC - DAY_SEC,
  });
}

function localVector() {
  return Object.freeze({ enabled: true, dim: DIM, embedder: 'local' });
}

test('E-M1：embedTimeoutMs 透传到 local（默认 300ms）', () => {
  const embedder = createEmbedder({ embedder: 'local', embedTimeoutMs: 1200 });
  assert.equal(embedder.timeoutMs, 1200);
  assert.equal(createEmbedder({ embedder: 'local' }).timeoutMs, 300);
  assert.equal(embedder.loadTimeoutMs >= 1200, true);
});

test('E-M1：loader 延迟 5s，embedQuery 在 embedTimeoutMs 内抛 transient 而不阻塞', async () => {
  const started = Date.now();
  try {
    const embedder = createEmbedder(
      { embedder: 'local', embedTimeoutMs: 300 },
      { loader: () => delay(5000).then(fakeModule) },
    );
    // 预热不 await，模拟启动/ idle-probe 触发。
    embedder.warmup().catch(() => {});
    await assert.rejects(embedder.embedQuery(['项目代号']), (error) => {
      assert.ok(error instanceof EmbeddingTimeout);
      assert.equal(error.transient, true);
      assert.equal(error.kind, 'transient');
      assert.equal(error.code, 'EMBEDDING_TIMEOUT');
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `前台等待应被 embedTimeoutMs 截断，实际 ${elapsed}ms`);
    assert.equal(embedder.status(), 'loading', '超时只截断前台等待，后台加载继续进行');
  } finally {
    clearTimers();
  }
});

test('E-M1：加载期间召回 300ms 内回退 FTS 且本轮不抛错；加载完成后下一轮走向量', async () => {
  await withStore(async (store) => {
    addFact(store);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let loaderCalls = 0;
    const embedder = createLocalEmbedder({
      model: MODEL,
      timeoutMs: 300,
      loader: async () => {
        loaderCalls += 1;
        await gate;
        return fakeModule();
      },
    });
    embedder.warmup().catch(() => {});

    // 第一轮：模型仍在加载 → 300ms 内截断，本轮直接 FTS。
    const started = Date.now();
    const first = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `召回不应等待模型加载，实际 ${elapsed}ms`);
    assert.equal(first.vectorError.kind, 'transient');
    assert.equal(first.vectorError.code, 'EMBEDDING_TIMEOUT');
    assert.equal('vectorHits' in first, false, '未拿到查询向量时走纯 FTS');
    assert.ok(first.items.some((item) => item.text.includes('晨星')), 'FTS 结果照常返回');

    // 放行后台加载，等预热完成。
    release();
    await embedder.warmup();
    assert.equal(embedder.status(), 'ready');
    assert.equal(loaderCalls, 1, '并发预热合并为一次加载');

    // 第二轮：加载完成 → 走向量路径（embedder_id 匹配的投影参与召回）。
    const second = await retrieve({
      store,
      query: '项目代号',
      now: NOW_MS,
      vector: localVector(),
      embedder,
    });
    assert.equal(second.vectorError, undefined);
    assert.equal('vectorHits' in second, true, '拿到查询向量后走向量召回路径');
    assert.equal(second.vectorHits, 0, '尚无已回填投影时命中数为 0，但路径已是向量');
  });
});

test('E-M1：依赖未安装（Cannot find module）→ fatal，停用 local 且不再 import', async () => {
  let loads = 0;
  const embedder = createEmbedder(
    { embedder: 'local', embedTimeoutMs: 300 },
    {
      loader: async () => {
        loads += 1;
        throw Object.assign(new Error("Cannot find module '@huggingface/transformers'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        });
      },
    },
  );
  await assert.rejects(embedder.warmup(), (error) => {
    assert.ok(error instanceof EmbeddingUnavailable);
    assert.equal(error.fatal, true);
    assert.equal(error.kind, 'fatal');
    assert.equal(error.transient, false);
    assert.match(error.message, /not installed/u);
    return true;
  });
  assert.equal(embedder.disabled, true);
  assert.equal(embedder.status(), 'fatal');
  // 已停用：后续 embed/预热都直接失败，不再尝试 import。
  await assert.rejects(embedder.embed(['项目代号']), (error) => error.fatal === true);
  await assert.rejects(embedder.warmup(), (error) => error.fatal === true);
  assert.equal(loads, 1, 'fatal 后不再重复 import');
});

test('E-M1：首轮网络错 → transient，指数退避后重试可用', async () => {
  let loads = 0;
  // 退避窗口用 300ms（而不是 1ms），让「窗口内不重试」的断言不依赖调度顺序；
  // 整套并发运行时 1ms 定时器可能在断言前就到期，status 从 backoff 变 idle。
  const retryBaseMs = 300;
  const embedder = createEmbedder(
    { embedder: 'local', embedTimeoutMs: 300 },
    {
      retryBaseMs,
      loader: async () => {
        loads += 1;
        if (loads === 1) {
          throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
        }
        return fakeModule();
      },
    },
  );
  await assert.rejects(embedder.warmup(), (error) => {
    assert.equal(error.transient, true);
    assert.equal(error.kind, 'transient');
    assert.equal(error.fatal, false);
    return true;
  });
  assert.equal(embedder.status(), 'backoff');
  assert.equal(embedder.disabled, false, '网络错误不得一次失败即永久停用');
  const state = embedder.state();
  assert.ok(state.nextRetryAt > Date.now(), '退避窗口应尚未到期');

  // 退避窗口内再次触发不会立刻打网络（warmup 与 embed 都复用同一 transient 错误）。
  await assert.rejects(embedder.warmup(), (error) => error.transient === true);
  await assert.rejects(embedder.embed(['项目代号']), (error) => error.transient === true);
  assert.equal(loads, 1, '退避窗口内复用同一 transient 错误');
  assert.equal(embedder.status(), 'backoff');

  // 显式等待真实计时器越过退避窗口（不用 10ms + 假设，避免并发下的竞态）。
  await new Promise((resolve) => {
    setTimeout(resolve, retryBaseMs + 50);
  });
  const [vec] = await embedder.embedQuery(['项目代号']);
  assert.ok(vec instanceof Float32Array);
  assert.equal(vec.length, DIM);
  assert.equal(loads, 2);
  assert.equal(embedder.status(), 'ready');
});

test('E-M1：推理超时抛 EmbeddingTimeout（transient），不无限等待', async () => {
  const started = Date.now();
  try {
    const embedder = createEmbedder(
      { embedder: 'local', embedTimeoutMs: 60 },
      {
        loader: async () => ({
          pipeline: async () => async (batch) => {
            await delay(5000);
            return batch.map(() => new Array(DIM).fill(0));
          },
        }),
      },
    );
    await embedder.warmup();
    await assert.rejects(embedder.embed(['慢推理']), (error) => {
      assert.ok(error instanceof EmbeddingTimeout);
      assert.equal(error.transient, true);
      assert.equal(error.code, 'EMBEDDING_TIMEOUT');
      return true;
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `推理应被 embedTimeoutMs 截断，实际 ${elapsed}ms`);
  } finally {
    clearTimers();
  }
});
