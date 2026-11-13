/**
 * `task_run` 执行器（08 H6、05 §6.4）：全局单执行槽 + 排队 + 软/硬超时 + 回执。
 *
 * 与 worker.js 的分工：
 * - worker.js 是「一次 worker 会话」的生命周期（createSession → prompt →
 *   whenIdle → 两段式取消），不关心并发；
 * - 本模块在它外面加**进程级串行执行槽**：同一时刻最多 1 个 worker，
 *   忙时最多排队 2 个，再多的请求直接 `{ok:false, reason:'busy', queue:2}`，
 *   避免上游一次 fan-out 把宿主拖垮（H6 的「无并发锁」缺陷）。
 *
 * 超时（沿用 worker.js 的常量，05 §4.1）：
 * - 软超时 600s：只记 warn 与耗时，不打断；
 * - 硬超时 900s：两段式回收——`cancel({sessionId, keepInbox:true})` 只中止
 *   当前轮，再 `cleanInbox(sessionId)` 清空排队；终态 `timeout`。
 *
 * 审计：收尾写入两条 memory_events（均为 append-only）：
 * - USED / `kind:'task_receipt'`：≤300 字回执正文（receipt.js）；
 * - USED / `kind:'task_run'`：任务生命周期记录。
 *   `memory_events.action` 的白名单里没有 `TASK`，故用 USED + kind 表达，
 *   避免为一个内部事件升级 schema。
 *
 * token 预算（v0.4.13 A3，D-1 / N-M4 / W1）：worker 因估算 token 超过硬线而
 * 提前结束时回 `partial`（区别于成功 done / 超时 timeout / 失败 failed），
 * 对外结果多一个 `partial:true` 与 `reason:'token_limit'`，回执追加
 * 「因 token 上限提前结束」一行；硬超时仍是 `timeout`，两者不混淆。
 */

import { formatReceipt, writeReceipt } from './receipt.js';
import {
  DEFAULT_HARD_MS,
  DEFAULT_SAMPLE_MS,
  DEFAULT_SOFT_MS,
  TOKEN_LIMIT_NOTE,
  runTask as runWorkerTask,
} from './worker.js';
import { WORKER_STOP_TOKENS, WORKER_WARN_TOKENS } from './limits.js';

export { DEFAULT_HARD_MS, DEFAULT_SAMPLE_MS, DEFAULT_SOFT_MS };

/** 并发上限：同一时刻只允许一个 worker 会话（H6）。 */
export const MAX_EXEC_SLOTS = 1;

/** 排队上限：槽位忙时最多再排 2 个，超出的直接拒绝。 */
export const MAX_QUEUE = 2;

/** `goal` 的最大字符数（码点）。 */
export const GOAL_MAX_CHARS = 2000;

/** `title` 的最大字符数（码点）。 */
export const TITLE_MAX_CHARS = 80;

/** 对外状态 → 回执状态词表（receipt.js 的 成功/超时/失败；partial 原样输出）。 */
const RECEIPT_STATUS = Object.freeze({
  done: 'ok',
  timeout: 'timeout',
  partial: 'partial',
  failed: 'error',
});

/** 默认结论（回执里的一句话）。 */
function defaultSummary(status, error) {
  if (status === 'done') return '任务完成';
  if (status === 'timeout') return '任务超时，已两段式取消';
  if (status === 'partial') return TOKEN_LIMIT_NOTE;
  return error === undefined ? '任务失败' : `任务失败：${error}`;
}

/**
 * 建一个独立执行器。生产用模块级单例；测试用它拿隔离的槽位状态。
 *
 * @param {{maxExec?: number, maxQueue?: number}} [options]
 */
export function createTaskRunner({ maxExec = MAX_EXEC_SLOTS, maxQueue = MAX_QUEUE } = {}) {
  if (!Number.isInteger(maxExec) || maxExec < 1) {
    throw new TypeError('createTaskRunner: maxExec must be a positive integer');
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new TypeError('createTaskRunner: maxQueue must be a non-negative integer');
  }

  let active = 0;
  const waiting = [];
  let sequence = 0;
  let finished = 0;

  /**
   * 取执行槽：空闲直接拿；忙则排队；队列满返回 false。
   * 被唤醒时槽位直接转交（active 不变），因此不能在这里重复 +1。
   * @returns {Promise<boolean>}
   */
  async function acquire() {
    if (active < maxExec) {
      active += 1;
      return true;
    }
    if (waiting.length >= maxQueue) return false;
    await new Promise((resolve) => {
      waiting.push(resolve);
    });
    return true;
  }

  /** 释放执行槽：有等待者则转交，否则回收。 */
  function release() {
    const next = waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    active -= 1;
  }

  /** 生成进程内唯一 taskId（时间 + 递增序号；不依赖平台 id）。 */
  function nextTaskId(baseMs) {
    sequence += 1;
    return `task-${Math.trunc(baseMs).toString(36)}-${sequence.toString(36)}`;
  }

  /**
   * 跑一次任务（串行、可排队）。
   *
   * @param {object} options
   * @param {object} options.platform T2 适配器（createSession/prompt/whenIdle/cancel）
   * @param {object} [options.store] 记忆库；给了才写审计事件
   * @param {string} options.goal 任务目标（1..2000 码点）
   * @param {string} [options.title] 任务标题（≤80 码点），只用于回执与审计
   * @param {number} [options.at] 起始毫秒时间戳（缺省用 now()）
   * @param {{softMs?: number, hardMs?: number, tokenWarn?: number, tokenStop?: number,
   *   sampleMs?: number}} [options.limits]
   * @param {number|Function} [options.now=Date.now] 时钟
   * @param {string} [options.cwd] worker 会话工作目录
   * @param {string} [options.agentPreset] worker 会话 preset
   * @param {string} [options.claimKey] 本次执行的稳定标识；给了就生成
   *   `companion-task:<taskId>:<claimKey>` 作为 prompt requestId（C5-H1b）
   * @param {string} [options.scope='main'] 回执/审计 scope
   * @returns {Promise<{ok: true, taskId: string, status: 'done'|'timeout'|'partial'|'failed',
   *   receipt: string, sessionId: string|null, durationMs: number,
   *   partial?: true, reason?: string, error?: string}
   *   | {ok: false, reason: 'busy', queue: number}>}
   */
  async function runTask(options = {}) {
    const {
      platform,
      store = null,
      goal,
      title,
      at,
      limits = {},
      now = Date.now,
      cwd,
      agentPreset,
      claimKey,
      scope = 'main',
    } = options;

    const goalText = normalizeGoal(goal);
    const titleText = normalizeTitle(title);
    const { softMs, hardMs, tokenWarn, tokenStop, sampleMs } = normalizeLimits(limits);
    const clock = typeof now === 'function' ? () => Number(now()) : () => Number(now);
    const startedAt = Number.isFinite(at) ? Number(at) : clock();
    const taskId = nextTaskId(startedAt);
    const receiptScope = typeof scope === 'string' && scope !== '' ? scope : 'main';

    const granted = await acquire();
    if (!granted) {
      return { ok: false, reason: 'busy', queue: maxQueue };
    }

    try {
      let workerResult;
      try {
        workerResult = await runWorkerTask({
          platform,
          task: {
            id: taskId,
            scope: receiptScope,
            prompt: goalText,
            summary: titleText,
            ...(typeof claimKey === 'string' && claimKey !== ''
              ? { requestId: `companion-task:${taskId}:${claimKey}` }
              : {}),
            ...(agentPreset === undefined ? {} : { agentPreset }),
            ...(cwd === undefined ? {} : { cwd }),
          },
          // 回执由本模块写（需要 title/status 映射），worker 不再写第二条。
          store: null,
          now: clock,
          softMs,
          hardMs,
          tokenWarn,
          tokenStop,
          sampleMs,
        });
      } catch (error) {
        // 参数/适配器异常：worker 尚未接管，直接收敛成 failed 回执。
        workerResult = {
          status: 'error',
          sessionId: null,
          durationMs: Math.max(0, clock() - startedAt),
          error: messageOf(error),
        };
      }

      const status = toStatus(workerResult.status);
      const durationMs = Number.isFinite(workerResult.durationMs)
        ? Number(workerResult.durationMs)
        : Math.max(0, clock() - startedAt);
      const baseSummary = titleText === undefined
        ? defaultSummary(status, workerResult.error)
        : titleText;
      // token 硬线：标题保留已完成内容，另起一行说明提前结束的原因。
      const summary = status === 'partial' && titleText !== undefined
        ? `${titleText}\n${TOKEN_LIMIT_NOTE}`
        : baseSummary;
      const reason = status === 'partial' ? workerResult.reason ?? 'token_limit' : undefined;
      const receipt = formatReceipt({
        status: RECEIPT_STATUS[status],
        summary: status === 'failed' ? defaultSummary(status, workerResult.error) : summary,
        artifacts: [],
        durationMs,
      });

      writeAudit({
        platform,
        store,
        scope: receiptScope,
        taskId,
        title: titleText,
        status,
        receipt,
        durationMs,
        sessionId: workerResult.sessionId ?? null,
        atSeconds: Math.floor(startedAt / 1000),
        reason,
      });

      finished += 1;
      const result = {
        ok: true,
        taskId,
        status,
        receipt,
        sessionId: workerResult.sessionId ?? null,
        durationMs,
      };
      if (status === 'failed' && workerResult.error !== undefined) {
        result.error = String(workerResult.error);
      }
      if (status === 'partial') {
        result.partial = true;
        result.reason = reason;
      }
      return result;
    } finally {
      release();
    }
  }

  /**
   * 非阻塞取槽（N-M2：thread_run 与 task_run 共用）。
   * 槽忙时立即返回 false，不排队——thread_run 交给主会话回「排队中」。
   * @returns {boolean}
   */
  function tryAcquire() {
    if (active < maxExec) {
      active += 1;
      return true;
    }
    return false;
  }

  /** 只读槽位统计（测试与诊断用）。 */
  function stats() {
    return { active, queued: waiting.length, finished, maxExec, maxQueue };
  }

  return { runTask, stats, tryAcquire, release };
}

const defaultRunner = createTaskRunner();

/**
 * 模块级单例：`task_run` 工具用它，保证全进程只有一个执行槽。
 * @param {object} options 同 createTaskRunner().runTask
 */
export function runTask(options) {
  return defaultRunner.runTask(options);
}

/** 单例槽位统计。 */
export function taskRunnerStats() {
  return defaultRunner.stats();
}

/**
 * N-M2：非阻塞取执行槽（thread_run 用）。
 * @returns {boolean}
 */
export function tryAcquireExecSlot() {
  return defaultRunner.tryAcquire();
}

/** N-M2：释放执行槽（thread_run 结束时调用）。 */
export function releaseExecSlot() {
  defaultRunner.release();
}

/**
 * 写两条审计事件；审计失败不影响任务终态（只补日志）。
 * @param {object} input
 * @returns {void}
 */
function writeAudit({
  platform, store, scope, taskId, title, status, receipt, durationMs, sessionId, atSeconds, reason,
}) {
  if (store === null || store === undefined) return;
  try {
    writeReceipt(store, {
      scope,
      taskId,
      status: RECEIPT_STATUS[status] ?? status,
      text: receipt,
    });
  } catch (error) {
    safeLog(platform, 'error', '[dsh-companion] failed to write task receipt', {
      error: messageOf(error),
    });
  }
  try {
    if (typeof store.appendEvent === 'function') {
      store.appendEvent({
        at: atSeconds,
        action: 'USED',
        actor: 'scheduler',
        table_name: 'threads',
        row_id: String(taskId),
        reason: `task_run:${status}`,
        detail_json: {
          scope,
          kind: 'task_run',
          taskId,
          title: title ?? null,
          status,
          durationMs,
          sessionId,
          // 只有 partial（token 截断）才带 reason，其余终态保持旧形状。
          ...(reason === undefined ? {} : { reason }),
        },
      });
    }
  } catch (error) {
    safeLog(platform, 'error', '[dsh-companion] failed to write task_run event', {
      error: messageOf(error),
    });
  }
}

/** @param {string} status @returns {'done'|'timeout'|'partial'|'failed'} */
function toStatus(status) {
  if (status === 'ok') return 'done';
  if (status === 'timeout') return 'timeout';
  if (status === 'partial') return 'partial';
  return 'failed';
}

/** @param {unknown} goal @returns {string} */
function normalizeGoal(goal) {
  if (typeof goal !== 'string' || goal.trim() === '') {
    throw new TypeError('task_run: goal must be a non-empty string');
  }
  const text = goal.trim();
  if (charLength(text) > GOAL_MAX_CHARS) {
    throw new TypeError(`task_run: goal must be at most ${GOAL_MAX_CHARS} characters`);
  }
  return text;
}

/** @param {unknown} title @returns {string|undefined} */
function normalizeTitle(title) {
  if (title === undefined || title === null) return undefined;
  if (typeof title !== 'string') {
    throw new TypeError('task_run: title must be a string');
  }
  const text = title.trim();
  if (text === '') return undefined;
  if (charLength(text) > TITLE_MAX_CHARS) {
    throw new TypeError(`task_run: title must be at most ${TITLE_MAX_CHARS} characters`);
  }
  return text;
}

/** @param {object} limits */
function normalizeLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('task_run: limits must be an object');
  }
  const softMs = limits.softMs ?? DEFAULT_SOFT_MS;
  const hardMs = limits.hardMs ?? DEFAULT_HARD_MS;
  const tokenWarn = limits.tokenWarn ?? WORKER_WARN_TOKENS;
  const tokenStop = limits.tokenStop ?? WORKER_STOP_TOKENS;
  const sampleMs = limits.sampleMs ?? DEFAULT_SAMPLE_MS;
  if (typeof softMs !== 'number' || !Number.isFinite(softMs) || softMs <= 0) {
    throw new TypeError('task_run: limits.softMs must be a positive finite number');
  }
  if (typeof hardMs !== 'number' || !Number.isFinite(hardMs) || hardMs <= 0) {
    throw new TypeError('task_run: limits.hardMs must be a positive finite number');
  }
  if (hardMs < softMs) {
    throw new TypeError('task_run: limits.hardMs must be >= limits.softMs');
  }
  if (typeof tokenWarn !== 'number' || !Number.isFinite(tokenWarn) || tokenWarn < 0) {
    throw new TypeError('task_run: limits.tokenWarn must be a non-negative finite number');
  }
  if (typeof tokenStop !== 'number' || !Number.isFinite(tokenStop) || tokenStop <= 0) {
    throw new TypeError('task_run: limits.tokenStop must be a positive finite number');
  }
  if (tokenStop <= tokenWarn) {
    throw new TypeError('task_run: limits.tokenStop must be greater than limits.tokenWarn');
  }
  if (typeof sampleMs !== 'number' || !Number.isFinite(sampleMs) || sampleMs <= 0) {
    throw new TypeError('task_run: limits.sampleMs must be a positive finite number');
  }
  return { softMs, hardMs, tokenWarn, tokenStop, sampleMs };
}

/** @param {string} text @returns {number} */
function charLength(text) {
  return Array.from(text).length;
}

/** @param {object} platform @param {string} level @param {string} message @param {unknown} [meta] */
function safeLog(platform, level, message, meta) {
  try {
    platform?.log?.(level, message, meta);
  } catch {
    // 日志是旁路：忽略。
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
