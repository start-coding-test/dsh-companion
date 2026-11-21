/**
 * `task_run` 执行器（08 H6、05 §6.4）：执行槽 + 排队 + 软/硬超时 + 回执。
 *
 * 与 worker.js 的分工：
 * - worker.js 是「一次 worker 会话」的生命周期（createSession → prompt →
 *   whenIdle → 两段式取消），不关心并发；
 * - SA-B1（v0.7.7 阶段 4）起，宿主有子代理服务时改由
 *   `src/task/subagent-runner.js` 派活（拿到结构化结果、宿主级深度/并发约束），
 *   worker.js 保留为兼容回退路径，本文件只在「没有子代理能力」时用它；
 * - 本模块在它外面加**进程级执行槽**：同一时刻最多 `MAX_EXEC_SLOTS` 个执行，
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
import { runSubagentTask } from './subagent-runner.js';
import {
  DEFAULT_HARD_MS,
  DEFAULT_SAMPLE_MS,
  DEFAULT_SOFT_MS,
  TOKEN_LIMIT_NOTE,
  runTask as runWorkerTask,
} from './worker.js';
import { WORKER_STOP_TOKENS, WORKER_WARN_TOKENS } from './limits.js';

export { DEFAULT_HARD_MS, DEFAULT_SAMPLE_MS, DEFAULT_SOFT_MS };

/**
 * 并发上限（D6，v0.7.7 阶段 4）：2。
 *
 * 阶段 1 前的口径是 1（「全局单槽」）；D6 裁决把它改成 2 并同步 config 的
 * `subagentConcurrency`。槽位仍然是有界队列（`MAX_QUEUE`），不是无限制并发。
 */
export const MAX_EXEC_SLOTS = 2;

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

  // D6：槽位数由 config.subagent.concurrency 驱动，但只在空闲时改（改动时若有
  // 在跑的任务，槽位账本会错位）。
  let slots = maxExec;
  let active = 0;
  const waiting = [];
  let sequence = 0;
  let finished = 0;
  /**
   * v0.7.10（D21-H2）：本执行器自持的中止信号（每个在跑任务一个）。
   *
   * 之前 task_run 把宿主的 `exec.signal` 传给子代理：主会话本轮结束（宿主 abort
   * 工具调用的 signal）会连带中止子代理，且工具调用要 `await` 整个执行 Promise，
   * 主会话因此被阻塞。现在执行信号与主轮次解耦，只有三种来源能中止子代理：
   * 硬超时（subagent-runner 的 900s）、`abortAll()`（插件卸载/进程退出）、
   * 显式取消。
   */
  const activeControllers = new Set();

  /**
   * 同步准入（v0.7.10 D21-H2）：空闲直接占槽；忙时占一个排队位；队列满返回 null
   * ——工具层据此**同步**返回 busy，不再 await 队列。
   * 被唤醒时槽位直接转交（active 不变），因此排队分支不能在这里 +1。
   * @returns {{queued: boolean}|null}
   */
  function admit() {
    if (active < slots) {
      active += 1;
      return { queued: false };
    }
    if (waiting.length >= maxQueue) return null;
    return { queued: true };
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
   * 开始一次任务，**不等待**执行结束（v0.7.10 D21-H2）。
   *
   * 调用方拿到的 `done` 覆盖排队与子代理的 `activation.result` 全部执行过程，
   * 工具层不 await 它，因此工具调用与主会话都不被阻塞：
   *   - 参数校验、busy 判定、占槽全部同步完成，工具层可立即返回 started/busy；
   *   - 执行 Promise 以 `done` 返回，调用方**不需要** await（rejection 已内部消费）；
   *   - 子代理执行信号是本执行器自持的 AbortController，与主轮次解耦。
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
   * @param {string} [options.taskId] 预先生成的 taskId（工具层先回 started 用）
   * @param {object} [options.subagent] 派活参数 {enabled, name, label, model, hardMs, onChildId, logger}
   * @param {Function} [options.onReceipt] SA-B3 回执投递（唯一的结果回传通道）
   * @returns {{ok: true, taskId: string, queued: boolean, done: Promise<object>}
   *   | {ok: false, reason: 'busy', queue: number}}
   */
  function startTask(options = {}) {
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
      agent = null,
      subagent = null,
      onReceipt = null,
      taskId: presetTaskId,
    } = options;

    const goalText = normalizeGoal(goal);
    const titleText = normalizeTitle(title);
    const { softMs, hardMs, tokenWarn, tokenStop, sampleMs } = normalizeLimits(limits);
    const clock = typeof now === 'function' ? () => Number(now()) : () => Number(now);
    const startedAt = Number.isFinite(at) ? Number(at) : clock();
    const taskId = typeof presetTaskId === 'string' && presetTaskId !== ''
      ? presetTaskId
      : nextTaskId(startedAt);
    const receiptScope = typeof scope === 'string' && scope !== '' ? scope : 'main';

    const admission = admit();
    if (admission === null) {
      return { ok: false, reason: 'busy', queue: maxQueue };
    }

    // D21-H2：执行信号只受本执行器控制——硬超时（subagent-runner）、abortAll()
    // （插件卸载/进程退出）与显式取消能中止子代理；主会话本轮结束不会。
    const controller = new AbortController();
    activeControllers.add(controller);

    const done = (async () => {
      if (admission.queued) {
        await new Promise((resolve) => {
          waiting.push(resolve);
        });
      }
      try {
        let workerResult;
        // SA-B1（阶段 4）：有子代理能力且有存活 parent 时走派活路径；否则回退
        // worker 的 createSession + prompt（保留原行为，兼容不支持子代理的宿主）。
        const useSubagent = subagent !== null && typeof subagent === 'object'
          && subagent.enabled === true
          && platform?.capabilities?.subagents === true
          && agent !== null && typeof agent === 'object';
        try {
          if (useSubagent) {
            workerResult = await runSubagentTask({
              platform,
              task: {
                id: taskId,
                scope: receiptScope,
                prompt: goalText,
                ...(agentPreset === undefined ? {} : { agentPreset }),
                ...(cwd === undefined ? {} : { cwd }),
              },
              parent: agent,
              name: subagent.name,
              label: subagent.label ?? (titleText ?? taskId),
              model: subagent.model ?? null,
              now: clock,
              // 硬超时来自任务限额（默认 900s，与 SUBAGENT_HARD_MS 一致），不是主轮次预算。
              hardMs,
              // D21-H2（v0.7.10）：用执行器自持的 controller，不用 exec.signal——
              // 主轮次结束/被取消不得中止子代理（宿主验证见 dsh-subagent/src/manager.ts:857-865
              // 与 dsh-agent/src/index.ts:99-100 的 creation-only signal）。
              signal: controller.signal,
              ...(typeof subagent.onChildId === 'function' ? { onChildId: subagent.onChildId } : {}),
              logger: subagent.logger,
            });
          } else {
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
          }
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
        // SA-B1：子代理路径已经用结构化结果收过 ≤300 字回执（A1），没有显式
        // title 时直接用它（保持「回执只说结论」的口径），否则沿用 title 口径。
        const receipt = titleText === undefined
          && typeof workerResult.receipt === 'string' && workerResult.receipt !== ''
          ? workerResult.receipt
          : formatReceipt({
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

        // SA-B3（阶段 4）：回执投递是旁路——失败只 warn，不影响任务终态。
        if (typeof onReceipt === 'function') {
          try {
            await onReceipt({
              taskId,
              status,
              receipt,
              title: titleText ?? null,
              sessionId: workerResult.sessionId ?? null,
              ...(reason === undefined ? {} : { reason }),
            });
          } catch (error) {
            safeLog(platform, 'warn', '[dsh-companion] task receipt delivery failed', {
              taskId,
              error: messageOf(error),
            });
          }
        }

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
        activeControllers.delete(controller);
        release();
      }
    })();

    // 工具层不 await done：这里消费 rejection，任何执行异常只记日志，绝不冒到
    // 工具调用层（D21-H2）。
    done.catch((error) => {
      safeLog(platform, 'error', '[dsh-companion] task execution crashed', {
        taskId,
        error: messageOf(error),
      });
    });

    return { ok: true, taskId, queued: admission.queued, done };
  }

  /**
   * 等任务真正结束（内部与测试用的兼容包装）。
   * 工具层不要用它——那会把主会话重新卡住（D21-H2）。
   * @param {object} options 同 startTask
   * @returns {Promise<object>}
   */
  async function runTask(options = {}) {
    const started = startTask(options);
    if (started.ok !== true) return started;
    return await started.done;
  }

  /**
   * 中止所有在跑任务的执行信号（插件卸载 / 进程退出）。
   * 这是「主轮次结束」之外唯一能中止子代理的路径之一（另一个是硬超时）。
   * @param {string} [reason='shutdown']
   * @returns {number} 被中止的任务数
   */
  function abortAll(reason = 'shutdown') {
    const controllers = [...activeControllers];
    activeControllers.clear();
    let aborted = 0;
    for (const controller of controllers) {
      try {
        controller.abort(reason);
        aborted += 1;
      } catch {
        // 已 abort 或不属于本执行器：忽略。
      }
    }
    return aborted;
  }

  /**
   * 非阻塞取槽（N-M2：thread_run 与 task_run 共用）。
   * 槽忙时立即返回 false，不排队——thread_run 交给主会话回「排队中」。
   * @returns {boolean}
   */
  function tryAcquire() {
    if (active < slots) {
      active += 1;
      return true;
    }
    return false;
  }

  /** 只读槽位统计（测试与诊断用）。 */
  function stats() {
    return { active, queued: waiting.length, finished, maxExec: slots, maxQueue };
  }

  /**
   * D6：把槽位数改成配置值（config.subagent.concurrency）。
   *
   * 只允许在完全空闲时改：改成 1 而此刻有 2 个任务在跑，会让 `release()` 的
   * 计数失去意义（active 可能永远大于 slots）。
   * @param {number} next
   * @returns {boolean} 是否生效
   */
  function setMaxExec(next) {
    if (!Number.isInteger(next) || next < 1) {
      throw new TypeError('setMaxExec: next must be a positive integer');
    }
    if (active !== 0 || waiting.length !== 0) return false;
    slots = next;
    return true;
  }

  return { startTask, runTask, stats, tryAcquire, release, setMaxExec, abortAll };
}

const defaultRunner = createTaskRunner();

/**
 * 模块级单例：`task_run` 工具用它，保证全进程只有一个执行槽。
 *
 * v0.7.10（D21-H2）：工具层改用 `startTask`（立即返回），`runTask` 只留给
 * 需要等待结果的内部调用与测试。
 * @param {object} options 同 createTaskRunner().runTask
 */
export function runTask(options) {
  return defaultRunner.runTask(options);
}

/**
 * 立即开始任务并返回 `{ok, taskId, queued, done}`；`done` 不 await 也能跑完。
 * @param {object} options 同 createTaskRunner().startTask
 */
export function startTask(options) {
  return defaultRunner.startTask(options);
}

/**
 * 中止所有在跑任务的执行信号（插件卸载 / 进程退出时调用）。
 * @param {string} [reason]
 * @returns {number}
 */
export function abortActiveTasks(reason) {
  return defaultRunner.abortAll(reason);
}

/** 单例槽位统计。 */
export function taskRunnerStats() {
  return defaultRunner.stats();
}

/**
 * D6（阶段 4）：按配置调整全局执行槽数（config.subagent.concurrency）。
 * 只允许在空闲时生效；改动被忽略时返回 false（下一次 apply 再试）。
 * @param {number} concurrency
 * @returns {boolean}
 */
export function configureTaskConcurrency(concurrency) {
  return defaultRunner.setMaxExec(concurrency);
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
