/**
 * W4：local embedder —— 可选动态加载 @huggingface/transformers。
 *
 * 主包保持零第三方依赖：该包不写进 package.json dependencies，
 * 未安装时 embed() 抛 EmbeddingUnavailable，调用方回退纯 FTS。
 *
 * 默认模型 Xenova/bge-small-zh-v1.5（MIT、24M 参数、512 维、int8 约 23.9MB）。
 * 查询侧按 BGE 官方用法加指令前缀；入库事实不加（prefixQuery=false 可关）。
 */

import { EmbeddingUnavailable } from './errors.js';
import { normalizeTexts, rowsFromResponse, toFloat32 } from './util.js';

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_DIM = 512;
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

/**
 * 已知模型的 embedding 维度；未知模型按 512 处理（与 bge-small 对齐）。
 */
const KNOWN_MODEL_DIMS = Object.freeze({
  'Xenova/bge-small-zh-v1.5': 512,
  'Xenova/bge-small-zh': 512,
  'Xenova/e5-small': 384,
  'Xenova/e5-small-v2': 384,
  'intfloat/multilingual-e5-small': 384,
});

/**
 * @param {unknown} output transformers.js 输出（Tensor 或数组）
 * @param {number} expectedCount
 * @returns {Float32Array[]}
 */
function outputRows(output, expectedCount) {
  let value = output;
  if (value !== null && typeof value === 'object' && typeof value.tolist === 'function') {
    value = value.tolist();
  }
  let rows = rowsFromResponse(value);
  if (rows === null && expectedCount === 1 && Array.isArray(value)
    && value.length > 0 && typeof value[0] === 'number') {
    rows = [value];
  }
  if (rows === null || rows.length !== expectedCount) {
    throw new EmbeddingUnavailable(
      `[embedder:local] unexpected output shape (expected ${expectedCount} rows)`,
    );
  }
  return rows.map((row) => toFloat32(row));
}

/**
 * @param {{
 *   model?: string,
 *   prefixQuery?: boolean,
 *   dim?: number,
 *   loader?: () => Promise<unknown>,
 * }} [options]
 */
export function createLocalEmbedder(options = {}) {
  const model = typeof options.model === 'string' && options.model.trim() !== ''
    ? options.model.trim()
    : DEFAULT_MODEL;
  const dim = Number.isInteger(options.dim) && options.dim > 0
    ? options.dim
    : (KNOWN_MODEL_DIMS[model] || DEFAULT_DIM);
  const prefixQuery = options.prefixQuery !== false;
  const loader = typeof options.loader === 'function'
    ? options.loader
    : () => import('@huggingface/transformers');
  /** @type {Promise<unknown>|null} */
  let extractorPromise = null;
  /** @type {Error|null} 永久性失败（未安装/加载失败），避免反复 import 打日志。 */
  let fatalError = null;

  async function loadExtractor() {
    if (fatalError !== null) throw fatalError;
    if (extractorPromise !== null) return extractorPromise;
    extractorPromise = (async () => {
      let mod;
      try {
        mod = await loader();
      } catch (error) {
        throw new EmbeddingUnavailable(
          '[@huggingface/transformers] not installed; run "npm i @huggingface/transformers" to enable vector.embedder=local',
          { cause: error },
        );
      }
      if (mod === null || typeof mod !== 'object' || typeof mod.pipeline !== 'function') {
        throw new EmbeddingUnavailable('[@huggingface/transformers] does not export pipeline()');
      }
      try {
        return await mod.pipeline('feature-extraction', model, { dtype: 'q8' });
      } catch (error) {
        throw new EmbeddingUnavailable(
          `[embedder:local] failed to load model "${model}"`,
          { cause: error },
        );
      }
    })();
    try {
      return await extractorPromise;
    } catch (error) {
      extractorPromise = null;
      const wrapped = error instanceof EmbeddingUnavailable
        ? error
        : new EmbeddingUnavailable('[embedder:local] failed to initialize', { cause: error });
      if (wrapped.transient !== true) fatalError = wrapped;
      throw wrapped;
    }
  }

  async function embedRaw(texts) {
    const batch = normalizeTexts(texts);
    if (batch.length === 0) return [];
    const extractor = await loadExtractor();
    let output;
    try {
      output = await extractor(batch, { pooling: 'mean', normalize: true });
    } catch (error) {
      throw new EmbeddingUnavailable('[embedder:local] inference failed', { cause: error });
    }
    const rows = outputRows(output, batch.length);
    for (const row of rows) {
      if (row.length !== dim) {
        throw new EmbeddingUnavailable(
          `[embedder:local] dimension mismatch: model returned ${row.length}, expected ${dim}`,
        );
      }
    }
    return rows;
  }

  return {
    id: `local:${model}:${dim}`,
    dim,
    kind: 'local',
    model,
    prefixQuery,
    /**
     * 入库/普通文本：不加指令前缀。
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
      return embedRaw(texts);
    },
    /**
     * 查询文本：prefixQuery=true 时加 BGE 检索指令前缀。
     * @param {string|string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embedQuery(texts) {
      const batch = normalizeTexts(Array.isArray(texts) ? texts : [texts]);
      if (!prefixQuery) return embedRaw(batch);
      return embedRaw(batch.map((text) => `${QUERY_INSTRUCTION}${text}`));
    },
  };
}
