/**
 * W4：hash embedder（默认，零依赖，测试/离线可用）。
 * 复用 src/memory/vector.js 的 hashEmbed 语义，batch 只是逐条调用。
 */

import { hashEmbed } from '../vector.js';
import { normalizeTexts } from './util.js';

/**
 * @param {{dim?: number}} [options]
 */
export function createHashEmbedder(options = {}) {
  const dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : 256;
  return {
    id: `hash:${dim}`,
    dim,
    kind: 'hash',
    /**
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
      return normalizeTexts(texts).map((text) => hashEmbed(text, dim));
    },
  };
}
