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
 * 平台面用 T2 适配器形状（src/platform/adapter.js）：createSession/prompt/
 * cancel/whenIdle；cleanInbox 是可选的宿主能力，没有时安静跳过。
 */

import { formatReceipt, writeReceipt } from './receipt.js';

/** 软超时：10 分钟（01 §13 R-TSK-14、10 §7.2）。到点只记录，不打断。 */
export const DEFAULT_SOFT_MS = 10 * 60 * 1000;

/** 硬超时：15 分钟（08 H-02 统一到 05 §4.1 的 900000）。到点两段式取消。 */
export const DEFAULT_HARD_MS = 15 * 60 * 1000;

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
 * @param {string} [options.cwd] 会话工作目录（缺省用 task.cwd）
 * @returns {Promise<{status: 'timeout'|'ok'|'error', sessionId: string|null, durationMs: number, error?: string}>}
 */
export async function runTask(options = {}) {
  const {
    platform,
    task,
    store,
    now = Date.now,
    softMs = DEFAULT_SOFT_MS,
    hardMs = DEFAULT_HARD_MS,
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
    });
  } catch (error) {
    outcome = { status: 'error', error: messageOf(error) };
  }

  // 硬超时：两段式取消，先中止当前轮再清空排队。
  if (outcome.status === 'timeout') {
    await cancelTask(platform, sessionId);
  } else if (outcome.status === 'error' && sessionId !== null) {
    // 失败也尽力回收会话，但取消错误不覆盖原始错误。
    await cancelTask(platform, sessionId);
  }

  const durationMs = Math.max(0, clock() - startedAt);
  const result = { status: outcome.status, sessionId, durationMs };
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
 * @param {object} options
 * @returns {Promise<{status: 'ok'|'timeout'|'error', error?: string}>}
 */
function waitForIdle({ platform, agent, sessionId, softMs, hardMs }) {
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

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (softTimer !== null) clearTimeout(softTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
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

    hardTimer = setTimeout(() => finish({ status: 'timeout' }), hardMs);
    hardTimer.unref?.();

    idle.then(
      () => finish({ status: 'ok' }),
      (error) => finish({ status: 'error', error: messageOf(error) }),
    );
  });
}

/**
 * 写回执；回执失败不能影响任务终态（只补一条错误日志）。
 *
 * @param {object} options
 * @returns {void}
 */
function writeTaskReceipt({ platform, store, task, result }) {
  const summary = typeof task.summary === 'string' && task.summary.trim() !== ''
    ? task.summary
    : defaultSummary(result);
  const text = formatReceipt({
    status: result.status,
    summary,
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
