/**
 * t17（P1-c）失败自愈的纯函数工具。
 *
 * 这里只放「分类 / 退避 / 下一次尝试时间」这类无副作用逻辑，方便单测；
 * 真正写库、调度重试的接线在 src/index.js 与 src/runtime/scheduler.js。
 *
 * 约束：
 * - 凭据缺失（MISSING_CREDENTIAL）不是瞬时抖动，重试只会白烧一次模型调用，
 *   因此永久跳过并降级为日志/审计；
 * - 其余巩固失败最多重试 3 次，按 1/2/4 个 60s tick 指数退避；
 * - 不读全局时钟，`at` 一律由调用方注入。
 */

/** 巩固失败最多重试次数（首次失败后）。 */
export const MAX_CONSOLIDATION_RETRIES = 3;

/** 退避档位：1/2/4 个 60s tick（毫秒）。 */
export const RETRY_BACKOFF_MS = Object.freeze([60_000, 120_000, 240_000]);

/** 判定凭据缺失的错误码/文案（宿主 adapter 与 LlmError 都带 code/message）。 */
const CREDENTIAL_PATTERN = /MISSING_CREDENTIAL|no API key|missing credential|credential[s]? (?:is|are) missing/i;

/**
 * 取错误码（兼容 Error.code、error.cause.code）。
 * @param {unknown} error
 * @returns {string|null}
 */
export function errorCode(error) {
  if (error === null || typeof error !== 'object') return null;
  const direct = error.code;
  if (typeof direct === 'string' && direct !== '') return direct;
  const cause = error.cause;
  if (cause !== null && typeof cause === 'object' && typeof cause.code === 'string') {
    return cause.code;
  }
  return null;
}

/**
 * 错误文本（兼容字符串、Error、任意抛出值）。
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error === null || error === undefined) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
}

/**
 * 是否凭据缺失：这类失败不做重试，只记录并降级。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCredentialError(error) {
  return errorCode(error) === 'MISSING_CREDENTIAL' || CREDENTIAL_PATTERN.test(errorMessage(error));
}

/**
 * 是否值得重试。当前只排除凭据缺失；其余（LLM 5xx、写库 busy、未知异常）
 * 都按可重试处理，避免把瞬时故障误判成永久失败。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableError(error) {
  return !isCredentialError(error);
}

/**
 * 第 `attempt` 次重试的延迟（attempt 从 1 开始）。
 * 超过 MAX_CONSOLIDATION_RETRIES 返回 null，表示不再重试。
 * @param {number} attempt
 * @returns {number|null}
 */
export function retryDelayMs(attempt) {
  const n = Math.floor(Number(attempt));
  if (!Number.isFinite(n) || n < 1 || n > MAX_CONSOLIDATION_RETRIES) return null;
  return RETRY_BACKOFF_MS[n - 1];
}

/**
 * 下一次重试的绝对时间；不再重试时返回 null。
 * @param {number} at 失败时刻（毫秒）
 * @param {number} attempt 第几次重试（1 开始）
 * @returns {{attempt: number, nextAt: number, delayMs: number}|null}
 */
export function planRetry(at, attempt) {
  const now = Number(at);
  if (!Number.isFinite(now)) throw new TypeError('[retry] at must be a finite timestamp');
  const delayMs = retryDelayMs(attempt);
  if (delayMs === null) return null;
  return { attempt: Math.floor(Number(attempt)), nextAt: now + delayMs, delayMs };
}

/**
 * 判断错误是否还能重试（同时考虑次数与错误类型）。
 * @param {unknown} error
 * @param {number} attempt 下一次重试序号（1 开始）
 * @returns {boolean}
 */
export function canRetry(error, attempt) {
  return isRetryableError(error) && retryDelayMs(attempt) !== null;
}
