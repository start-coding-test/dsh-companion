/**
 * worker token 预算与结局判定（D-1 / N-M4 / W1，05 §6.4）。
 *
 * worker.js 目前只有软/硬**时间**超时（600s/900s），回执也分不清「正常完成」
 * 与「被截断」。本模块补上按**估算 token** 的收尾口径，只做纯逻辑：
 *
 * - `nextStage`：run → wrap_up（软 60K，注入收尾提示）→ stop（硬 80K，结束）；
 * - `wrapUpPrompt`：软线到点后给模型看的中文收尾指令（≤200 字）；
 * - `classifyWorkerOutcome`：把取消/超时/token 截断收敛成回执状态；
 * - `mergeReceiptStatus`：把状态并进回执草稿，返回新对象。
 *
 * 设计口径：
 * - 阈值按「估算 token」而非真实计费，宁可提前收尾；
 * - 软线只提示、不打断；硬线结束本轮并回 `status='partial'`，调用方看到
 *   partial（reason=token_limit/timeout）可以决定是否重新派发；
 * - `stop` 是终态，`wrap_up` 也不会退回 `run`（避免预算回落时反复横跳）；
 * - 纯函数不读时钟、不读 env，三时区行为一致。
 */

/** 软线：估算 token 达到 60K 注入收尾提示。 */
export const WORKER_WARN_TOKENS = 60_000;

/** 硬线：估算 token 达到 80K 结束本轮，回执 status=partial。 */
export const WORKER_STOP_TOKENS = 80_000;

/** 收尾提示的字数上限（码点）。 */
const WRAP_UP_MAX_CHARS = 200;

/** 合法阶段；数组保持声明顺序，报错信息里也按这个顺序展示。 */
const STAGES = Object.freeze(['run', 'wrap_up', 'stop']);

/**
 * 估算 token 归一化：非法值（NaN/Infinity/负数/非数）按 0 处理。
 * 这里刻意 fail-open：估算器异常时不应凭空触发收尾或结束。
 *
 * @param {unknown} value
 * @returns {number} 非负有限数
 */
function normalizeTokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 解析并校验阈值。默认 60K/80K；乱序（stopAt <= warnAt）必须抛 RangeError，
 * 因为那会让状态机永远进不了 stop 或一进来就 stop，属于配置错误。
 *
 * @param {object} [options]
 * @returns {{warnAt: number, stopAt: number}}
 */
function resolveThresholds(options) {
  const source = options !== null && typeof options === 'object' ? options : {};
  const warnAt = source.warnAt ?? WORKER_WARN_TOKENS;
  const stopAt = source.stopAt ?? WORKER_STOP_TOKENS;
  if (typeof warnAt !== 'number' || !Number.isFinite(warnAt) || warnAt < 0) {
    throw new TypeError('nextStage: warnAt must be a non-negative finite number');
  }
  if (typeof stopAt !== 'number' || !Number.isFinite(stopAt) || stopAt <= 0) {
    throw new TypeError('nextStage: stopAt must be a positive finite number');
  }
  if (stopAt <= warnAt) {
    throw new RangeError('nextStage: stopAt must be greater than warnAt');
  }
  return { warnAt, stopAt };
}

/**
 * 根据累计估算 token 计算 worker 的下一阶段。
 *
 * 迁移规则（按顺序判定，命中即返回）：
 * 1. `tokens >= stopAt` → `stop`（reason `stop_tokens`）；
 * 2. `tokens >= warnAt` 且当前是 `run` → `wrap_up`（reason `warn_tokens`）；
 * 3. 否则保持当前阶段（changed=false）。
 *
 * `changed` 表示本次是否发生了迁移；`reason` 只在 changed=true 时给出，
 * 原地不动一律为 null。`stop` 为终态，任何输入都不会退回 `run`/`wrap_up`；
 * `wrap_up` 也不会退回 `run`。
 *
 * @param {'run'|'wrap_up'|'stop'} current 当前阶段
 * @param {number} tokens 累计估算 token（非法值按 0）
 * @param {{warnAt?: number, stopAt?: number}} [options] 阈值覆盖
 * @returns {{stage: 'run'|'wrap_up'|'stop', changed: boolean,
 *            reason: 'warn_tokens'|'stop_tokens'|null}}
 */
export function nextStage(current, tokens, options = {}) {
  if (!STAGES.includes(current)) {
    throw new TypeError(`nextStage: current must be one of ${STAGES.join('|')}`);
  }
  const { warnAt, stopAt } = resolveThresholds(options);
  const used = normalizeTokens(tokens);

  // 终态优先：已经 stop 就不再产生任何迁移。
  if (current === 'stop') {
    return { stage: 'stop', changed: false, reason: null };
  }
  if (used >= stopAt) {
    return { stage: 'stop', changed: true, reason: 'stop_tokens' };
  }
  if (used >= warnAt && current === 'run') {
    return { stage: 'wrap_up', changed: true, reason: 'warn_tokens' };
  }
  return { stage: current, changed: false, reason: null };
}

/**
 * 软线到点后注入的中文收尾指令（≤200 字）。
 *
 * 要求模型停止开新话题/新工具链，把进度写成结构化小结，并说明本轮会以
 * partial 回执结束。剩余 token 非数/负数/非有限值按 0；文案里的数字是整数
 * （小数向下取整，保守估计）。
 *
 * @param {number} remainingTokens 剩余估算 token
 * @returns {string}
 */
export function wrapUpPrompt(remainingTokens) {
  const remaining = Math.floor(normalizeTokens(remainingTokens));
  const text = `剩余预算约 ${remaining} tokens。请立即收尾：停止开启新话题或新工具链，只把当前工作做到最小可交付。请用结构化小结回复：已完成、未完成、下一步。本轮以 partial 回执结束，调用方可据此重新派发。`;
  // 正常长度约 100 余字；这里只做防御性截断，保证契约（≤200 字）不被破坏。
  const chars = Array.from(text);
  return chars.length <= WRAP_UP_MAX_CHARS
    ? text
    : `${chars.slice(0, WRAP_UP_MAX_CHARS - 1).join('')}…`;
}

/**
 * 判定 worker 终态，供回执合并使用。
 *
 * 优先级：cancelled > token_limit > timeout > completed。
 * - 用户主动取消（cancelled）是最高事实，不能再被内部限制改写；
 * - token 硬线（stage='stop' 或 hitStopTokens）是 worker 自己触发的截断，
 *   必须先于时间超时——两者同时出现时 partial 的原因应归到预算；
 * - 都没有才是正常完成。
 *
 * @param {{cancelled?: boolean, timedOut?: boolean,
 *          stage?: 'run'|'wrap_up'|'stop', hitStopTokens?: boolean}} [outcome]
 * @returns {{status: 'partial'|'cancelled'|'completed',
 *            reason: 'token_limit'|'timeout'|'cancelled'|null}}
 */
export function classifyWorkerOutcome(outcome = {}) {
  const source = outcome !== null && typeof outcome === 'object' ? outcome : {};
  const { cancelled, timedOut, stage, hitStopTokens } = source;

  if (cancelled) {
    return { status: 'cancelled', reason: 'cancelled' };
  }
  if (stage === 'stop' || hitStopTokens) {
    return { status: 'partial', reason: 'token_limit' };
  }
  if (timedOut) {
    return { status: 'partial', reason: 'timeout' };
  }
  return { status: 'completed', reason: null };
}

/**
 * 把结局并进回执草稿：返回新对象，不改入参，其它字段原样保留。
 * `completed` 时 reason 强制为 null（清掉草稿里可能残留的旧原因）。
 *
 * @param {object} receipt 回执草稿
 * @param {{status: string, reason?: string|null}} outcome classifyWorkerOutcome() 的结果
 * @returns {object} 合并后的新回执
 */
export function mergeReceiptStatus(receipt, outcome) {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)
    || typeof outcome.status !== 'string' || outcome.status === '') {
    throw new TypeError('mergeReceiptStatus: outcome.status must be a non-empty string');
  }
  const source = receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
    ? receipt
    : {};
  const reason = outcome.status === 'completed' ? null : (outcome.reason ?? null);
  return { ...source, status: outcome.status, reason };
}
