/**
 * W4：embedder 共享的输入/输出归一化。
 */

/**
 * 把输入统一成字符串数组；非数组直接报错，避免静默吞掉调用错误。
 * @param {unknown} texts
 * @returns {string[]}
 */
export function normalizeTexts(texts) {
  if (!Array.isArray(texts)) {
    throw new TypeError('[embedder] texts must be an array of strings');
  }
  return texts.map((text) => (text === null || text === undefined ? '' : String(text)));
}

/**
 * 任意数组/typed array → Float32Array；非有限值报错。
 * @param {unknown} value
 * @returns {Float32Array}
 */
export function toFloat32(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
    throw new TypeError('[embedder] embedding must be an array of numbers');
  }
  const vec = Float32Array.from(value);
  for (const item of vec) {
    if (!Number.isFinite(item)) throw new TypeError('[embedder] embedding contains non-finite values');
  }
  return vec;
}

/**
 * 从常见响应形状里取出二维数组：[[...], [...]] 或 [{embedding:[...]}]。
 * @param {unknown} value
 * @returns {unknown[]|null}
 */
export function rowsFromResponse(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (Array.isArray(value[0]) || ArrayBuffer.isView(value[0])) return value;
  if (value[0] !== null && typeof value[0] === 'object' && 'embedding' in value[0]) {
    return value.map((row) => row?.embedding ?? null);
  }
  return null;
}
