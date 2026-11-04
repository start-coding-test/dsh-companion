/**
 * W4：embedding 不可用/超时的统一错误类型。
 *
 * 调用方（retrieve / 回填）只需识别 `EmbeddingUnavailable`：
 *   - local 模型未安装、动态 import 失败、模型加载/推理失败；
 *   - remote 未启用、endpoint 缺失、fetch 不可用、HTTP 非 2xx；
 *   - 响应形状/维度不符合预期。
 * 超时是 `EmbeddingTimeout`（继承自 `EmbeddingUnavailable`），但带 `transient=true`，
 * 表示下一次仍可重试；其它不可用错误默认按“本进程内不可用”处理。
 */

export class EmbeddingUnavailable extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, transient?: boolean}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EmbeddingUnavailable';
    this.code = 'EMBEDDING_UNAVAILABLE';
    this.transient = options.transient === true;
  }
}

export class EmbeddingTimeout extends EmbeddingUnavailable {
  /**
   * @param {string} message
   * @param {{cause?: unknown, timeoutMs?: number}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause, transient: true });
    this.name = 'EmbeddingTimeout';
    this.code = 'EMBEDDING_TIMEOUT';
    this.timeoutMs = options.timeoutMs;
  }
}
