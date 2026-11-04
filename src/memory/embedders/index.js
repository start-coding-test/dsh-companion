/**
 * W4：embedding 可插拔入口。
 *
 * `createEmbedder(vectorConfig, deps)` 返回 `{ id, dim, async embed(texts) -> Float32Array[] }`：
 *   - hash（默认）：零依赖，复用 hashEmbed；id 形如 hash:256。
 *   - local：动态 import('@huggingface/transformers')；未安装抛 EmbeddingUnavailable。
 *   - remote：显式 enabled=true 才请求；默认关闭。
 * vector.embedder='none' 时返回 null（调用方走纯 FTS，与 v0.3.2 关闭路径一致）。
 */

import { createHashEmbedder } from './hash.js';
import { createLocalEmbedder } from './local.js';
import { createRemoteEmbedder } from './remote.js';
import { EmbeddingBusy, EmbeddingTimeout, EmbeddingUnavailable } from './errors.js';

export { EmbeddingBusy, EmbeddingTimeout, EmbeddingUnavailable };

/**
 * @param {{
 *   embedder?: string,
 *   dim?: number,
 *   localModel?: string,
 *   prefixQuery?: boolean,
 *   embedderId?: string,
 *   embedTimeoutMs?: number,
 *   backfillTimeoutMs?: number,
 *   remote?: {enabled?: boolean, endpoint?: string, apiKeyEnv?: string, timeoutMs?: number},
 * }} [vectorConfig]
 * @param {{loader?: () => Promise<unknown>, fetch?: typeof fetch, env?: Record<string, string|undefined>,
 *   now?: () => number, retryBaseMs?: number, maxLoadAttempts?: number, loadTimeoutMs?: number}} [deps]
 * @returns {null | {id: string, dim: number, embed: (texts: string[]) => Promise<Float32Array[]>, embedQuery?: (texts: string|string[]) => Promise<Float32Array[]>, warmup?: () => Promise<unknown>}}
 */
export function createEmbedder(vectorConfig = {}, deps = {}) {
  const config = vectorConfig === null || typeof vectorConfig !== 'object' ? {} : vectorConfig;
  const kind = config.embedder === undefined ? 'hash' : config.embedder;
  if (kind === 'none') return null;
  if (kind === 'hash') {
    return createHashEmbedder({ dim: config.dim });
  }
  if (kind === 'local') {
    return createLocalEmbedder({
      model: config.localModel,
      prefixQuery: config.prefixQuery,
      dim: undefined,
      loader: deps.loader,
      // E-M1/E2-M1：查询等待加载/推理用 config.vector.embedTimeoutMs；
      // 空闲回填走独立的 backfillTimeoutMs，两者互不挤占。
      timeoutMs: config.embedTimeoutMs,
      backfillTimeoutMs: config.backfillTimeoutMs,
      loadTimeoutMs: deps.loadTimeoutMs,
      retryBaseMs: deps.retryBaseMs,
      maxLoadAttempts: deps.maxLoadAttempts,
      now: deps.now,
    });
  }
  if (kind === 'remote') {
    const remote = config.remote && typeof config.remote === 'object' ? config.remote : {};
    // remote 默认关闭：即使 vector.embedder=remote，也只有在
    // vector.remote.enabled=true 时才装配，避免误把记忆原文发到第三方。
    if (remote.enabled !== true) return null;
    return createRemoteEmbedder({
      endpoint: remote.endpoint,
      apiKeyEnv: remote.apiKeyEnv,
      timeoutMs: remote.timeoutMs || config.embedTimeoutMs,
      embedderId: config.embedderId,
      fetch: deps.fetch,
      env: deps.env,
    });
  }
  throw new Error(`[embedder] unsupported vector.embedder: ${JSON.stringify(kind)}`);
}
