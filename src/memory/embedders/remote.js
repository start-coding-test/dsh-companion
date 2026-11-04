/**
 * W4：remote embedder —— 显式开启后 POST 到用户配置的 endpoint。
 *
 * 隐私例外：remote 会把待向量化文本发送到第三方；7 天删除管不到第三方副本。
 * 因此默认 enabled=false；敏感/秘密/墓碑事实在进入 embed 之前由 store 过滤。
 */

import { EmbeddingTimeout, EmbeddingUnavailable } from './errors.js';
import { normalizeTexts, rowsFromResponse, toFloat32 } from './util.js';

/**
 * @param {string} endpoint
 * @returns {string} host（失败时返回空串）
 */
function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}

/**
 * @param {unknown} payload 响应 JSON
 * @param {number} expectedCount
 * @returns {Float32Array[]|null}
 */
function rowsFromPayload(payload, expectedCount) {
  if (payload === null || typeof payload !== 'object') return null;
  const rows = rowsFromResponse(payload.data)
    || rowsFromResponse(payload.embeddings)
    || rowsFromResponse(payload.vectors)
    || rowsFromResponse(payload.embedding);
  if (rows !== null || expectedCount !== 1) return rows;
  const single = payload.embedding ?? payload.vector ?? payload.data;
  if (Array.isArray(single) && single.length > 0 && typeof single[0] === 'number') return [single];
  return null;
}

/**
 * @param {{
 *   endpoint?: string,
 *   apiKeyEnv?: string,
 *   timeoutMs?: number,
 *   embedderId?: string,
 *   model?: string,
 *   dim?: number,
 *   fetch?: typeof fetch,
 *   env?: Record<string, string|undefined>,
 * }} [options]
 */
export function createRemoteEmbedder(options = {}) {
  const endpoint = typeof options.endpoint === 'string' ? options.endpoint : '';
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 300;
  const apiKeyEnv = typeof options.apiKeyEnv === 'string' ? options.apiKeyEnv : '';
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const fetchFn = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const host = hostOf(endpoint);
  let dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : 0;
  const configuredId = typeof options.embedderId === 'string' && options.embedderId.trim() !== ''
    ? options.embedderId.trim()
    : '';

  function resolvedId() {
    return configuredId || `remote:${host || 'unconfigured'}`;
  }

  return {
    get id() {
      return resolvedId();
    },
    get dim() {
      return dim;
    },
    kind: 'remote',
    endpoint,
    host,
    timeoutMs,
    /**
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
      return embedImpl(texts);
    },
    /** 查询与事实走同一 endpoint；remote 不自动加指令前缀。 */
    async embedQuery(texts) {
      return embedImpl(Array.isArray(texts) ? texts : [texts]);
    },
  };

  /**
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>}
   */
  async function embedImpl(texts) {
      const batch = normalizeTexts(texts);
      if (batch.length === 0) return [];
      if (endpoint === '') {
        throw new EmbeddingUnavailable('[embedder:remote] vector.remote.endpoint is empty');
      }
      if (typeof fetchFn !== 'function') {
        throw new EmbeddingUnavailable('[embedder:remote] fetch is not available');
      }
      const headers = { 'content-type': 'application/json' };
      const apiKey = apiKeyEnv === '' ? undefined : env[apiKeyEnv];
      if (typeof apiKey === 'string' && apiKey !== '') headers.authorization = `Bearer ${apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      let response;
      try {
        response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(options.model ? { model: options.model, input: batch } : { input: batch }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new EmbeddingTimeout(`[embedder:remote] timed out after ${timeoutMs}ms`, {
            cause: error,
            timeoutMs,
          });
        }
        throw new EmbeddingUnavailable('[embedder:remote] request failed', { cause: error });
      } finally {
        clearTimeout(timer);
      }
      if (response === null || typeof response !== 'object' || !('ok' in response)) {
        throw new EmbeddingUnavailable('[embedder:remote] invalid fetch response');
      }
      if (!response.ok) {
        throw new EmbeddingUnavailable(`[embedder:remote] HTTP ${response.status}`);
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new EmbeddingUnavailable('[embedder:remote] invalid JSON response', { cause: error });
      }
      const rows = rowsFromPayload(payload, batch.length);
      if (rows === null || rows.length !== batch.length) {
        throw new EmbeddingUnavailable(
          `[embedder:remote] unexpected response shape (expected ${batch.length} rows)`,
        );
      }
      const vectors = rows.map((row) => toFloat32(row));
      if (dim === 0) dim = vectors[0].length;
      for (const vec of vectors) {
        if (vec.length !== dim) {
          throw new EmbeddingUnavailable(
            `[embedder:remote] dimension mismatch: got ${vec.length}, expected ${dim}`,
          );
        }
      }
      return vectors;
  }
}
