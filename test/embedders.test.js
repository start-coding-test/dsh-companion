import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EmbeddingTimeout,
  EmbeddingUnavailable,
  createEmbedder,
} from '../src/memory/embedders/index.js';
import { hashEmbed } from '../src/memory/vector.js';

test('hash embedder：批量返回 Float32Array，id 带维度，语义与 hashEmbed 一致', async () => {
  const embedder = createEmbedder({ embedder: 'hash', dim: 64 });
  assert.equal(embedder.id, 'hash:64');
  assert.equal(embedder.dim, 64);
  const vectors = await embedder.embed(['项目代号', '项目代号', '']);
  assert.equal(vectors.length, 3);
  for (const vec of vectors) {
    assert.ok(vec instanceof Float32Array);
    assert.equal(vec.length, 64);
  }
  assert.deepEqual(Array.from(vectors[0]), Array.from(hashEmbed('项目代号', 64)));
  assert.deepEqual(Array.from(vectors[0]), Array.from(vectors[1]));
  assert.ok(vectors[2].every((value) => value === 0));
  assert.deepEqual(await embedder.embed([]), []);
});

test('createEmbedder：none 返回 null，未知类型抛错', () => {
  assert.equal(createEmbedder({ embedder: 'none' }), null);
  assert.throws(() => createEmbedder({ embedder: 'openai' }), /unsupported vector\.embedder/u);
});

test('local embedder：loader 缺失时抛 EmbeddingUnavailable，且只尝试一次', async () => {
  let loads = 0;
  const embedder = createEmbedder(
    { embedder: 'local' },
    {
      loader: async () => {
        loads += 1;
        throw Object.assign(new Error('Cannot find module @huggingface/transformers'), {
          code: 'MODULE_NOT_FOUND',
        });
      },
    },
  );
  assert.equal(embedder.id, 'local:Xenova/bge-small-zh-v1.5:512');
  assert.equal(embedder.dim, 512);
  await assert.rejects(
    embedder.embed(['项目代号']),
    (error) => error instanceof EmbeddingUnavailable && error.code === 'EMBEDDING_UNAVAILABLE',
  );
  await assert.rejects(embedder.embed(['再试一次']), EmbeddingUnavailable);
  assert.equal(loads, 1, '永久性失败缓存，避免反复 import');
});

test('local embedder：fake loader 成功，入库不加前缀、查询加指令前缀', async () => {
  const calls = [];
  const batches = [];
  const embedder = createEmbedder(
    { embedder: 'local', prefixQuery: true },
    {
      loader: async () => ({
        pipeline: async (...args) => {
          calls.push(args);
          return async (batch) => {
            batches.push(batch);
            return { tolist: () => batch.map(() => new Array(512).fill(0.25)) };
          };
        },
      }),
    },
  );
  assert.equal(embedder.id, 'local:Xenova/bge-small-zh-v1.5:512');
  const [stored] = await embedder.embed(['项目代号是晨星']);
  assert.ok(stored instanceof Float32Array);
  assert.equal(stored.length, 512);
  assert.equal(batches.at(-1)[0], '项目代号是晨星');

  const [query] = await embedder.embedQuery(['项目代号']);
  assert.equal(query.length, 512);
  assert.match(batches.at(-1)[0], /^为这个句子生成表示以用于检索相关文章：/u);
  assert.match(batches.at(-1)[0], /项目代号$/u);

  assert.deepEqual(calls[0], ['feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' }]);
});

test('local embedder：prefixQuery=false 时查询不加前缀，已知 e5 模型取 384 维', async () => {
  const batches = [];
  const embedder = createEmbedder(
    { embedder: 'local', localModel: 'Xenova/e5-small', prefixQuery: false },
    {
      loader: async () => ({
        pipeline: async () => async (batch) => {
          batches.push(batch);
          return batch.map(() => new Array(384).fill(0.5));
        },
      }),
    },
  );
  assert.equal(embedder.id, 'local:Xenova/e5-small:384');
  assert.equal(embedder.dim, 384);
  await embedder.embedQuery(['查询']);
  assert.equal(batches.at(-1)[0], '查询');
});

test('local embedder：输出维度不符时抛 EmbeddingUnavailable', async () => {
  const embedder = createEmbedder(
    { embedder: 'local' },
    {
      loader: async () => ({
        pipeline: async () => async (batch) => batch.map(() => new Array(8).fill(0)),
      }),
    },
  );
  await assert.rejects(embedder.embed(['x']), (error) => {
    assert.ok(error instanceof EmbeddingUnavailable);
    assert.match(error.message, /dimension mismatch/u);
    return true;
  });
});

test('remote embedder：默认关闭时 createEmbedder 返回 null（不装配、不发请求）', () => {
  const embedder = createEmbedder({
    embedder: 'remote',
    remote: { enabled: false, endpoint: 'https://embed.example.com/v1' },
  });
  assert.equal(embedder, null);
});

test('remote embedder：注入 fetch，批量 POST、Bearer key、id 由 embedderId 指定', async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }] };
      },
    };
  };
  const embedder = createEmbedder(
    {
      embedder: 'remote',
      embedderId: 'remote:corp',
      remote: { enabled: true, endpoint: 'https://embed.example.com/v1', apiKeyEnv: 'EMB_KEY', timeoutMs: 500 },
    },
    { fetch: fakeFetch, env: { EMB_KEY: 's3cret' } },
  );
  assert.equal(embedder.id, 'remote:corp');
  const vectors = await embedder.embed(['甲', '乙']);
  assert.equal(vectors.length, 2);
  assert.deepEqual(Array.from(vectors[0]), [1, 0, 0]);
  assert.deepEqual(Array.from(vectors[1]), [0, 1, 0]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://embed.example.com/v1');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer s3cret');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].init.body), { input: ['甲', '乙'] });
});

test('remote embedder：超时抛 EmbeddingTimeout，HTTP 失败抛 EmbeddingUnavailable', async () => {
  const timeoutEmbedder = createEmbedder(
    {
      embedder: 'remote',
      remote: { enabled: true, endpoint: 'https://embed.example.com/v1', timeoutMs: 20 },
    },
    {
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    },
  );
  await assert.rejects(timeoutEmbedder.embed(['x']), (error) => {
    assert.ok(error instanceof EmbeddingTimeout);
    assert.equal(error.code, 'EMBEDDING_TIMEOUT');
    assert.equal(error.timeoutMs, 20);
    return true;
  });

  const failedEmbedder = createEmbedder(
    {
      embedder: 'remote',
      remote: { enabled: true, endpoint: 'https://embed.example.com/v1' },
    },
    {
      fetch: async () => ({ ok: false, status: 500, async json() { return {}; } }),
    },
  );
  await assert.rejects(
    failedEmbedder.embed(['x']),
    (error) => error instanceof EmbeddingUnavailable && error.code === 'EMBEDDING_UNAVAILABLE',
  );
});
