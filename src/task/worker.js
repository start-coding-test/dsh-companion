/**
 * 轻任务 worker（05 §6.4、10 §7）：0/1 个一次性 worker 会话。
 *
 * 生命周期：
 * 1. `createSession({cwd, agentPreset})` 开一个独立会话（不注入记忆，D9）；
 * 2. `prompt({sessionId, content:[{type:'text', text}]})` 投递任务包；
 * 3. `whenIdle()` 等完成——软超时（默认 10 分钟）只记录并继续等，硬超时
 *    （默认 15 分钟）才两段式取消：先 `cancel({sessionId, keepInbox:true})`
 *    只中止当前轮，再 `cleanInbox(sessionId)` 清空排队，否则队列里的消息会
 *    继续跑（10-主动性与轻任务.md §7.2）；
 * 4. 产出只有回执（receipt.js），worker 不写记忆。
 *
 * token 预算（v0.4.13 A3，D-1 / N-M4 / W1）：
 * - 等待 idle 期间按 `sampleMs`（默认 5s）用 `platform.measure(session)`
 *   采样估算 token；平台没有 tokenMeter 时**零采样**，行为与旧版一致；
 * - 软线（默认 60K）只向同一会话投递一次收尾提示（limits.wrapUpPrompt），
 *   不打断；投递失败只 warn，不重试；
 * - 硬线（默认 80K）结束等待，按两段式取消回收，终态 `partial`，
 *   reason=`token_limit`；硬超时仍走 `timeout`，两者不混淆；
 * - 采样失败只写 debug，不影响任务完成。
 *
 * 平台面用 T2 适配器形状（src/platform/adapter.js）：createSession/prompt/
 * cancel/whenIdle；cleanInbox 是可选的宿主能力，没有时安静跳过。
 */

import { formatReceipt, writeReceipt } from './receipt.js';
import {
  WORKER_STOP_TOKENS,
  WORKER_WARN_TOKENS,
  nextStage,
  wrapUpPrompt,
} from './limits.js';

/** 软超时：10 分钟（01 §13 R-TSK-14、10 §7.2）。到点只记录，不打断。 */
export const DEFAULT_SOFT_MS = 10 * 60 * 1000;

/** 硬超时：15 分钟（08 H-02 统一到 05 §4.1 的 900000）。到点两段式取消。 */
export const DEFAULT_HARD_MS = 15 * 60 * 1000;

/** token 采样间隔：5s（估算器只能轮询，没有推送）。 */
export const DEFAULT_SAMPLE_MS = 5_000;

/** 回执里标识 token 截断的那一行（run.js 复用同一文案）。 */
export const TOKEN_LIMIT_NOTE = '因 token 上限提前结束';

/**
 * 跑一个轻任务，返回终态摘要。
 *
 * @param {object} options
 * @param {object} options.platform T2 适配器（createSession/prompt/cancel/whenIdle）
 * @param {object} options.task 任务包：{id?, scope?, prompt, agentPreset?, summary?, artifacts?, requestId?, cwd?}
 * @param {object} [options.store] 记忆库；给了才写回执（memory_events 审计行）
 * @param {number|Function} [options.now=Date.now] 时钟：毫秒时间戳或返回毫秒的函数
 * @param {number} [options.softMs=600000] 软超时
 * @param {number} [options.hardMs=900000] 硬超时（必须 ≥ softMs）
 * @param {number} [options.tokenWarn=60000] token 软线：只投递收尾提示
 * @param {number} [options.tokenStop=80000] token 硬线：结束并两段式取消
 * @param {number} [options.sampleMs=5000] token 采样间隔
 * @param {string} [options.cwd] 会话工作目录（缺省用 task.cwd）
 * @returns {Promise<{status: 'timeout'|'partial'|'ok'|'error', sessionId: string|null,
 *   durationMs: number, reason?: string, error?: string}>}
 */
export async function runTask(options = {}) {
  const {
    platform,
    task,
    store,
    now = Date.now,
    softMs = DEFAULT_SOFT_MS,
    hardMs = DEFAULT_HARD_MS,
    tokenWarn = WORKER_WARN_TOKENS,
    tokenStop = WORKER_STOP_TOKENS,
    sampleMs = DEFAULT_SAMPLE_MS,
    cwd,
  } = options;

  assertPlatform(platform, 'runTask');
  if (task === null || typeof task !== 'object') {
    throw new TypeError('runTask: task must be an object');
  }
  if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
    throw new TypeError('runTask: task.prompt must be a non-empty string');
  }
  if (typeof softMs !== 'number' || !Number.isFinite(softMs) || softMs <= 0) {
    throw new TypeError('runTask: softMs must be a positive finite number');
  }
  if (typeof hardMs !== 'number' || !Number.isFinite(hardMs) || hardMs <= 0) {
    throw new TypeError('runTask: hardMs must be a positive finite number');
  }
  if (hardMs < softMs) {
    throw new TypeError('runTask: hardMs must be >= softMs');
  }
  assertTokenBudget(tokenWarn, tokenStop, sampleMs);

  const clock = resolveClock(now);
  const startedAt = clock();
  let sessionId = null;
  let outcome;

  try {
    const created = await platform.createSession({
      cwd: cwd ?? task.cwd,
      agentPreset: task.agentPreset,
    });
    sessionId = extractSessionId(created);
    if (sessionId === null) {
      throw new Error('[worker] createSession() returned no session id');
    }

    const promptRequest = {
      sessionId,
      content: [{ type: 'text', text: task.prompt }],
    };
    if (typeof task.requestId === 'string' && task.requestId !== '') {
      promptRequest.requestId = task.requestId;
    }
    await platform.prompt(promptRequest);

    outcome = await waitForIdle({
      platform,
      agent: created?.agent ?? created,
      sessionId,
      softMs,
      hardMs,
      tokenWarn,
      tokenStop,
      sampleMs,
      ...resolveTokenSampling(platform, created),
    });
  } catch (error) {
    outcome = { status: 'error', error: messageOf(error) };
  }

  // 硬超时 / token 硬线 / 失败：都尽力回收会话；取消错误不覆盖原始终态。
  // 硬超时与 token 截断在这里共用一个两段式回收，但 reason 不同。
  if (outcome.status === 'timeout' || outcome.status === 'partial') {
    await cancelTask(platform, sessionId);
  } else if (outcome.status === 'error' && sessionId !== null) {
    await cancelTask(platform, sessionId);
  }

  const durationMs = Math.max(0, clock() - startedAt);
  const result = { status: outcome.status, sessionId, durationMs };
  if (typeof outcome.reason === 'string' && outcome.reason !== '') {
    result.reason = outcome.reason;
  }
  if (outcome.status === 'error') {
    result.error = outcome.error ?? 'unknown task error';
  }

  // 回执：只有调用方给了 store（或 task.store）才落库；worker 不写记忆，只写审计事件。
  const receiptStore = store ?? task.store ?? null;
  if (receiptStore !== null && receiptStore !== undefined) {
    writeTaskReceipt({ platform, store: receiptStore, task, result });
  }

  return result;
}

/**
 * 两段式取消，幂等：可以重复调用（重复 cancel 不会抛到调用方）。
 *
 * @param {object} platform T2 适配器
 * @param {string} sessionId 会话 id；空值直接返回未取消
 * @returns {Promise<{sessionId: string|null, cancelled: boolean, errors: string[]}>}
 */
export async function cancelTask(platform, sessionId) {
  const errors = [];
  if (platform === null || typeof platform !== 'object') {
    return { sessionId: sessionId ?? null, cancelled: false, errors: ['platform is unavailable'] };
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { sessionId: sessionId ?? null, cancelled: false, errors };
  }

  let cancelled = false;
  try {
    // 第一段：只中止当前 turn，保留 inbox（10 §7.2 表格 ①）。
    await invokeCancel(platform, sessionId);
    cancelled = true;
  } catch (error) {
    errors.push(`cancel: ${messageOf(error)}`);
  }

  try {
    // 第二段：清空排队，否则 queued 消息会继续跑（表格 ②）。
    if (typeof platform.cleanInbox === 'function') {
      await platform.cleanInbox(sessionId);
    }
  } catch (error) {
    errors.push(`cleanInbox: ${messageOf(error)}`);
  }

  return { sessionId, cancelled, errors };
}

/**
 * 等待 agent 静默；软超时只记日志，硬超时才判 timeout。
 *
 * 同时按 token 预算轮询采样（`measure` 为 null 时完全不采样）：
 * - 软线：投递一次收尾提示，继续等 idle；
 * - 硬线：结束等待（`partial` + `reason:'token_limit'`），由 runTask 回收。
 *
 * @param {object} options
 * @param {Function|null} [options.measure] 采样函数；null/缺省 = 平台无 tokenMeter
 * @param {unknown} [options.session] 交给 measure 的会话对象
 * @param {number} [options.tokenWarn=60000] token 软线
 * @param {number} [options.tokenStop=80000] token 硬线
 * @param {number} [options.sampleMs=5000] 采样间隔
 * @returns {Promise<{status: 'ok'|'timeout'|'partial'|'error', reason?: string, error?: string}>}
 */
function waitForIdle({
  platform, agent, sessionId, softMs, hardMs, measure, session, tokenWarn, tokenStop, sampleMs,
}) {
  let idle;
  try {
    idle = Promise.resolve(platform.whenIdle(agent));
  } catch (error) {
    return Promise.resolve({ status: 'error', error: messageOf(error) });
  }

  return new Promise((resolve) => {
    let settled = false;
    let softTimer = null;
    let hardTimer = null;
    let sampleTimer = null;
    let stage = 'run';

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (softTimer !== null) clearTimeout(softTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      if (sampleTimer !== null) clearTimeout(sampleTimer);
      resolve(value);
    };

    softTimer = setTimeout(() => {
      softTimer = null;
      // 软超时：先报进度，不打断（R-TSK-14）；继续等硬超时。
      safeLog(platform, 'warn', '[dsh-companion] task soft timeout: still running, not interrupted', {
        sessionId,
        softMs,
      });
    }, softMs);
    softTimer.unref?.();

    hardTimer = setTimeout(() => finish({ status: 'timeout', reason: 'timeout' }), hardMs);
    hardTimer.unref?.();

    // 采样定时器：每次采样后重新排下一次（间隔可配，默认 5s）。
    function scheduleSample() {
      if (typeof measure !== 'function' || settled) return;
      sampleTimer = setTimeout(sampleOnce, sampleMs);
      sampleTimer.unref?.();
    }

    /** 软线到点：只投递一次收尾提示；失败只 warn，不重复轰炸。 */
    function deliverWrapUp(totalTokens) {
      const remaining = Math.max(0, tokenStop - totalTokens);
      const request = {
        sessionId,
        content: [{ type: 'text', text: wrapUpPrompt(remaining) }],
      };
      let delivered;
      try {
        delivered = platform.prompt(request);
      } catch (error) {
        safeLog(platform, 'warn', '[dsh-companion] task token warn: wrap-up prompt failed, not retried', {
          sessionId,
          error: messageOf(error),
        });
        return;
      }
      Promise.resolve(delivered).then(
        () => safeLog(platform, 'debug', '[dsh-companion] task token warn: wrap-up prompt delivered', {
          sessionId,
          totalTokens,
        }),
        (error) => safeLog(platform, 'warn', '[dsh-companion] task token warn: wrap-up prompt failed, not retried', {
          sessionId,
          error: messageOf(error),
        }),
      );
    }

    function applySample(totalTokens) {
      if (settled) return;
      const verdict = nextStage(stage, totalTokens, { warnAt: tokenWarn, stopAt: tokenStop });
      if (verdict.changed) {
        stage = verdict.stage;
        if (stage === 'wrap_up') {
          safeLog(platform, 'debug', '[dsh-companion] task token warn: wrap_up, asking worker to wrap up', {
            sessionId,
            totalTokens,
            remainingTokens: Math.max(0, tokenStop - totalTokens),
          });
          deliverWrapUp(totalTokens);
        } else if (stage === 'stop') {
          safeLog(platform, 'warn', '[dsh-companion] task token stop: budget reached, stopping worker', {
            sessionId,
            totalTokens,
            tokenStop,
          });
          // 结束等待；两段式取消由 runTask 统一执行，保持与硬超时同一回收路径。
          finish({ status: 'partial', reason: 'token_limit' });
          return;
        }
      }
      scheduleSample();
    }

    function sampleOnce() {
      sampleTimer = null;
      if (settled) return;
      let measured;
      try {
        measured = measure(session);
      } catch (error) {
        // 采样是旁路：失败只记 debug，按原节奏继续等。
        safeLog(platform, 'debug', '[dsh-companion] task token sample failed', {
          sessionId,
          error: messageOf(error),
        });
        scheduleSample();
        return;
      }
      Promise.resolve(measured).then(
        (value) => applySample(readTotalTokens(value)),
        (error) => {
          if (settled) return;
          safeLog(platform, 'debug', '[dsh-companion] task token sample failed', {
            sessionId,
            error: messageOf(error),
          });
          scheduleSample();
        },
      );
    }

    scheduleSample();

    idle.then(
      () => finish({ status: 'ok' }),
      (error) => finish({ status: 'error', error: messageOf(error) }),
    );
  });
}

/**
 * 平台支持 tokenMeter 时才挂采样；能力缺失返回 null（零采样，与旧版一致）。
 *
 * @param {object} platform
 * @param {unknown} created createSession 的返回值
 * @returns {{measure: Function|null, session: unknown}}
 */
function resolveTokenSampling(platform, created) {
  try {
    if (platform?.capabilities?.tokenMeter !== true) return { measure: null, session: null };
    if (typeof platform.measure !== 'function') return { measure: null, session: null };
  } catch {
    return { measure: null, session: null };
  }
  const agent = created?.agent ?? created;
  return {
    measure: (target) => platform.measure(target),
    // 真实宿主里 measure 要吃会话对象（agent.session）；拿不到时退化成 id。
    session: agent?.session ?? { id: extractSessionId(created) },
  };
}

/**
 * measure() 的返回值里取 totalTokens；非法值按 0（fail-open，不凭空触发截断）。
 * @param {unknown} measurement
 * @returns {number}
 */
function readTotalTokens(measurement) {
  const total = measurement?.totalTokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : 0;
}

/**
 * 校验 token 预算参数；乱序属于配置错误（RangeError），与 limits.nextStage 一致。
 * @param {number} tokenWarn
 * @param {number} tokenStop
 * @param {number} sampleMs
 * @returns {void}
 */
function assertTokenBudget(tokenWarn, tokenStop, sampleMs) {
  if (typeof tokenWarn !== 'number' || !Number.isFinite(tokenWarn) || tokenWarn < 0) {
    throw new TypeError('runTask: tokenWarn must be a non-negative finite number');
  }
  if (typeof tokenStop !== 'number' || !Number.isFinite(tokenStop) || tokenStop <= 0) {
    throw new TypeError('runTask: tokenStop must be a positive finite number');
  }
  if (tokenStop <= tokenWarn) {
    throw new RangeError('runTask: tokenStop must be greater than tokenWarn');
  }
  if (typeof sampleMs !== 'number' || !Number.isFinite(sampleMs) || sampleMs <= 0) {
    throw new TypeError('runTask: sampleMs must be a positive finite number');
  }
}

/**
 * 写回执；回执失败不能影响任务终态（只补一条错误日志）。
 *
 * @param {object} options
 * @returns {void}
 */
function writeTaskReceipt({ platform, store, task, result }) {
  const explicit = typeof task.summary === 'string' && task.summary.trim() !== ''
    ? task.summary
    : null;
  const summary = explicit ?? defaultSummary(result);
  // token 硬线：保留已完成内容，另起一行说明提前结束的原因。
  const shownSummary = explicit !== null && result.status === 'partial'
    ? `${explicit}\n${TOKEN_LIMIT_NOTE}`
    : summary;
  const text = formatReceipt({
    status: result.status,
    summary: shownSummary,
    artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
    durationMs: result.durationMs,
  });
  try {
    writeReceipt(store, {
      scope: typeof task.scope === 'string' && task.scope !== '' ? task.scope : 'main',
      taskId: task.id ?? task.taskId ?? null,
      status: result.status,
      text,
    });
  } catch (error) {
    safeLog(platform, 'error', '[dsh-companion] failed to write task receipt', {
      error: messageOf(error),
    });
  }
}

/**
 * @param {{status: string, error?: string}} result
 * @returns {string}
 */
function defaultSummary(result) {
  if (result.status === 'ok') return '任务完成';
  if (result.status === 'timeout') return '任务超时，已两段式取消';
  if (result.status === 'partial') return TOKEN_LIMIT_NOTE;
  return result.error ? `任务失败：${result.error}` : '任务失败';
}

/**
 * 适配器签名是 cancel(request)；兼容两参实现 cancel(sessionId, options)。
 * @param {object} platform
 * @param {string} sessionId
 * @returns {unknown}
 */
function invokeCancel(platform, sessionId) {
  const cancel = platform.cancel;
  if (typeof cancel !== 'function') {
    throw new TypeError('[worker] platform.cancel() is unavailable');
  }
  if (cancel.length >= 2) {
    return cancel(sessionId, { keepInbox: true });
  }
  return cancel({ sessionId, keepInbox: true });
}

/**
 * @param {object} platform
 * @param {string} caller
 * @returns {void}
 */
function assertPlatform(platform, caller) {
  if (platform === null || typeof platform !== 'object') {
    throw new TypeError(`${caller}: platform must be a T2 adapter`);
  }
  for (const method of ['createSession', 'prompt', 'whenIdle']) {
    if (typeof platform[method] !== 'function') {
      throw new TypeError(`${caller}: platform.${method}() is required`);
    }
  }
}

/**
 * @param {unknown} created createSession 的返回值
 * @returns {string|null}
 */
function extractSessionId(created) {
  if (typeof created === 'string') return created === '' ? null : created;
  const agent = created?.agent ?? created;
  const id = agent?.id ?? agent?.session?.id ?? created?.sessionId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * 写日志是旁路：平台没有 logger 或 logger 抛错都不能影响任务终态。
 * @param {object} platform
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {unknown} [meta]
 * @returns {void}
 */
function safeLog(platform, level, message, meta) {
  try {
    platform.log?.(level, message, meta);
  } catch {
    // 忽略：日志不应阻断任务。
  }
}

/**
 * @param {number|Function} now
 * @returns {() => number}
 */
function resolveClock(now) {
  if (typeof now === 'function') return () => Number(now());
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  return () => Date.now();
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
