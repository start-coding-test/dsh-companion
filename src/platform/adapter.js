import { randomUUID } from 'node:crypto';

import { PlatformError } from './errors.js';

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * 平台能力缺失错误。
 * @param {string} code
 * @param {string} what
 * @returns {PlatformError}
 */
function unavailable(code, what) {
  return new PlatformError(code, `${what} is unavailable on this platform context`);
}

/**
 * 把 agent/pre-step 监听器的返回值合并进 waterfall 决策。
 *
 * handler 支持四种写法：
 * - undefined / null：不修改决策；
 * - { inject: ContentBlock[] }：追加到本批进入消息（模型可见的上下文注入）；
 * - { messages: ContentBlock[] }：整体替换本批进入消息；
 * - { reject: true } 或 { kind: 'reject' }：拒绝本步。
 *
 * 返回时始终展开原决策，保留 startsRequestSeries 等上游字段；平台要求
 * enter 决策的 messages 是完整批次，不能只返回 { messages }。
 *
 * @param {object} decision 平台 fallback 或上游监听器给出的决策
 * @param {object|null|undefined} patch handler 返回值
 * @returns {object}
 */
function mergeDecision(decision, patch) {
  const base = decision !== null && typeof decision === 'object'
    ? decision
    : { kind: 'enter', messages: [] };
  if (patch === undefined || patch === null) return base;
  if (typeof patch !== 'object') {
    throw new TypeError('onPreStep handler must return an object, null or undefined');
  }
  if (patch.reject === true || patch.kind === 'reject') {
    return { ...base, kind: 'reject' };
  }
  if (patch.messages !== undefined && patch.inject !== undefined) {
    throw new TypeError('onPreStep handler must return either messages or inject, not both');
  }
  if (patch.messages !== undefined) {
    if (!Array.isArray(patch.messages)) {
      throw new TypeError('onPreStep "messages" must be an array');
    }
    return { ...base, kind: 'enter', messages: [...patch.messages] };
  }
  if (patch.inject !== undefined) {
    if (!Array.isArray(patch.inject)) {
      throw new TypeError('onPreStep "inject" must be an array');
    }
    const entered = Array.isArray(base.messages) ? base.messages : [];
    return { ...base, kind: 'enter', messages: [...entered, ...patch.inject] };
  }
  if (patch.kind === 'enter') {
    throw new TypeError('onPreStep enter decision must carry a "messages" array');
  }
  return base;
}

/**
 * 默认 prompt source：与 sessionController 客户端包装保持一致
 * （{ kind: 'user', rpcId }），让平台按 rpcId 对重试做幂等去重。
 * @param {{ requestId?: string }} request
 * @param {object} [source] 调用方显式指定的 source
 * @returns {object}
 */
function promptSource(request, source) {
  if (source !== undefined) return source;
  const rpcId = typeof request?.requestId === 'string' && request.requestId.length > 0
    ? request.requestId
    : `companion-${randomUUID()}`;
  return { kind: 'user', rpcId };
}

/**
 * 创建本插件唯一的平台入口。所有平台调用都经传入的 ctx（或调用方传入的
 * agent 句柄）完成，适配层本身不 import 平台内部包。
 *
 * @param {object} ctx DSH/Cordis 平台上下文
 * @param {{ now?: () => number }} [opts] 可注入时钟（测试与回放用）
 * @returns {object} 适配器；capabilities 暴露当前宿主实际具备的能力
 */
export function createAdapter(ctx, opts = {}) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('createAdapter(ctx): ctx must be an object');
  }

  const now = typeof opts.now === 'function'
    ? opts.now
    : typeof ctx.now === 'function'
      ? () => ctx.now()
      : () => Date.now();

  const capabilities = Object.freeze({
    get systemPrompt() {
      return typeof ctx.systemPrompt?.section === 'function';
    },
    get preStep() {
      return typeof ctx.on === 'function';
    },
    get timer() {
      return typeof ctx.interval === 'function';
    },
    get compaction() {
      return typeof ctx.compaction?.compactRegion === 'function';
    },
    get sessionController() {
      return typeof ctx.sessionController?.createSession === 'function'
        && typeof ctx.sessionController?.prompt === 'function'
        && typeof ctx.sessionController?.cancel === 'function';
    },
    get archive() {
      return typeof ctx.workspaceRegistry?.archiveSession === 'function';
    },
    get tokenMeter() {
      return typeof ctx.tokenMeter?.measure === 'function';
    },
    get logger() {
      return typeof ctx.logger?.info === 'function';
    },
  });

  /**
   * 写一条结构化日志；宿主没有 logger 时安静跳过（日志不应阻断业务）。
   * @param {'debug'|'info'|'warn'|'error'} level
   * @param {string} message
   * @param {unknown} [meta]
   * @returns {boolean} 是否真的写入了日志
   */
  function log(level, message, meta) {
    if (!LOG_LEVELS.has(level)) {
      throw new TypeError(`log(level): unsupported level "${String(level)}"`);
    }
    const logger = ctx.logger;
    const sink = logger?.[level];
    if (typeof sink !== 'function') return false;
    if (meta === undefined) sink.call(logger, message);
    else sink.call(logger, message, meta);
    return true;
  }

  /**
   * 注册 system prompt 段落，返回 Cordis disposer。
   * @param {{ name: string, order: number, text: string|Function }} section
   * @returns {Function}
   */
  function section(section) {
    if (!capabilities.systemPrompt) {
      throw unavailable('no-system-prompt', 'ctx.systemPrompt.section()');
    }
    return ctx.systemPrompt.section(section);
  }

  /**
   * 注册 agent/pre-step waterfall 监听器。handler 在平台 fallback 决策之后
   * 执行，返回的补丁由 mergeDecision 合并；返回 disposer。
   * @param {(payload: object, decision: object) => object|null|undefined|Promise<object|null|undefined>} handler
   * @returns {Function}
   */
  function onPreStep(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('onPreStep(handler): handler must be a function');
    }
    if (typeof ctx.on !== 'function') {
      throw unavailable('no-pre-step', 'ctx.on("agent/pre-step")');
    }
    const listener = async (payload, next) => {
      const decision = await next();
      if (decision?.kind === 'reject') return decision;
      const patch = await handler(payload, decision);
      return mergeDecision(decision, patch);
    };
    return ctx.on('agent/pre-step', listener);
  }

  /**
   * 注册周期定时器，返回 disposer。
   * @param {number} ms 周期毫秒
   * @param {Function} callback
   * @returns {Function}
   */
  function every(ms, callback) {
    if (typeof ctx.interval !== 'function') {
      throw unavailable('no-timer', 'ctx.interval()');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('every(ms, callback): callback must be a function');
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new TypeError('every(ms, callback): ms must be a positive finite number');
    }
    return ctx.interval(callback, ms);
  }

  /**
   * 压缩 surface 的闭区间 [start, end]。
   * 必须在有 open turn 时调用（见 docs/platform-api.md），空闲期只能延后到
   * 下一轮 agent/pre-step。
   * @param {number} start 起始 surface 节点 seq（含）
   * @param {number} end 结束 surface 节点 seq（含）
   * @param {object} agent
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  function compactRegion(start, end, agent, signal) {
    if (!capabilities.compaction) {
      throw unavailable('no-compaction', 'ctx.compaction.compactRegion()');
    }
    return ctx.compaction.compactRegion(start, end, agent, signal);
  }

  /**
   * @param {object} request { sessionId?, cwd, agentPreset?, reusable? }
   * @returns {Promise<{agent: object, agentPreset: unknown}>}
   */
  function createSession(request) {
    if (typeof ctx.sessionController?.createSession !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.createSession()');
    }
    return ctx.sessionController.createSession(request);
  }

  /**
   * 向会话投递一条用户消息。
   * @param {{ sessionId: string, content: unknown[], requestId?: string, mode?: 'queue'|'steer' }} request
   * @param {object} [source] 缺省按 requestId 构造 { kind: 'user', rpcId }
   * @returns {Promise<unknown>}
   */
  function prompt(request, source) {
    if (typeof ctx.sessionController?.prompt !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.prompt()');
    }
    return ctx.sessionController.prompt(request, promptSource(request, source));
  }

  /**
   * 取消会话当前工作。
   * @param {string|{ sessionId: string }} target
   * @returns {unknown}
   */
  function cancel(target) {
    if (typeof ctx.sessionController?.cancel !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.cancel()');
    }
    if (typeof target === 'string') return ctx.sessionController.cancel({ sessionId: target });
    if (target === null || typeof target !== 'object') {
      throw new TypeError('cancel(target): expected a sessionId string or a request object');
    }
    return ctx.sessionController.cancel(target);
  }

  /**
   * 等待 agent 静默。whenIdle 属于 agent 句柄而非 sessionController。
   * @param {object} target agent 句柄，或 createSession 的返回值 { agent }
   * @returns {Promise<unknown>}
   */
  function whenIdle(target) {
    const agent = target?.agent ?? target;
    if (agent !== null && typeof agent === 'object' && typeof agent.whenIdle === 'function') {
      return agent.whenIdle();
    }
    throw unavailable('no-when-idle', 'agent.whenIdle()');
  }

  /**
   * 归档会话。options.stopActivity === true 时平台先写归档集再停活动。
   * @param {string} sessionId
   * @param {{ stopActivity?: boolean }} [options]
   * @returns {Promise<unknown>}
   */
  function archiveSession(sessionId, options = {}) {
    if (typeof ctx.workspaceRegistry?.archiveSession !== 'function') {
      throw unavailable('no-archive', 'ctx.workspaceRegistry.archiveSession()');
    }
    return ctx.workspaceRegistry.archiveSession(sessionId, options);
  }

  /**
   * 读取会话的 token 计量。
   * @param {object} session
   * @param {object} [requestHeader]
   * @returns {object}
   */
  function measure(session, requestHeader) {
    if (typeof ctx.tokenMeter?.measure !== 'function') {
      throw unavailable('no-token-meter', 'ctx.tokenMeter.measure()');
    }
    return ctx.tokenMeter.measure(session, requestHeader);
  }

  return {
    now,
    log,
    section,
    onPreStep,
    every,
    compactRegion,
    createSession,
    prompt,
    cancel,
    whenIdle,
    archiveSession,
    measure,
    capabilities,
  };
}
