/**
 * 平台适配层错误：用稳定的 code 表达「当前宿主缺少某项平台能力」，
 * 便于调用方按能力降级而不是匹配错误文案。
 */
export class PlatformError extends Error {
  /**
   * @param {string} code 稳定的错误码，例如 no-compaction / no-session
   * @param {string} [message] 可读说明，缺省时使用 code
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'PlatformError';
    this.code = code;
  }
}
