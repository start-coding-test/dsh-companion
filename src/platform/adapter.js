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
 * 校验注入项是完整平台消息（V3-H1 + V4-L1）。
 *
 * 平台把 `decision.messages` 的每一项当消息 append 到会话
 * （`dsh-agent-loop/lib/index.js:1067`），`dsh-session` 随后校验
 * id/role/source/content（`dsh-session/lib/index.js:1186-1219`）。这里按平台
 * 消费顺序校验插件可控的完整形状：
 * - `id` 必须是非空字符串（缺了冷读会话报 "lacks an identified message"，
 *   `dsh-session/lib/index.js:1200`）；
 * - `role` 必须是字面量 `'user'`（注入一律 user/message）；
 * - `content` 必须是非空 ContentBlock 数组；
 * - `source` 必须是对象且 `source.kind` 是非空字符串（`dsh-agent-loop` 读
 *   `message.source.kind`，裸块会崩 "Cannot read properties of undefined"）。
 *
 * 任一不满足都在插件侧抛 TypeError，报错信息点名字段（V4-L1）。
 *
 * @param {unknown} message
 * @param {number} index
 * @returns {void}
 */
function assertInjectedMessage(message, index) {
  const where = `onPreStep "inject"[${index}]`;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError(`${where} must be a platform message object`);
  }
  if (typeof message.id !== 'string' || message.id === '') {
    throw new TypeError(`${where} must have a non-empty string "id"`);
  }
  if (message.role !== 'user') {
    throw new TypeError(`${where} must have "role" of 'user'`);
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new TypeError(`${where} must have "content" as a non-empty array`);
  }
  const source = message.source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${where} must have "source" as an object`);
  }
  if (typeof source.kind !== 'string' || source.kind === '') {
    throw new TypeError(`${where} must have a non-empty string "source.kind"`);
  }
}

/**
 * 把 agent/pre-step 监听器的返回值合并进 waterfall 决策。
 *
 * handler 支持四种写法：
 * - undefined / null：不修改决策；
 * - { inject: PlatformMessage[] }：追加到本批进入消息。**必须是完整平台
 *   消息**（`{ id, role, content, source }`），不能是裸内容块：平台会逐条
 *   把 `decision.messages` 当消息 append 到会话
 *   （`dsh-agent-loop/lib/index.js:1067` 读 `message.source.kind`），裸块会在
 *   真机上崩 `Cannot read properties of undefined (reading 'kind')`（V3-H1）。
 *   形状不对时这里直接抛 TypeError，把问题留在插件侧。V4-L1 起还校验
 *   `id` 与 `source.kind`（`dsh-session:1200` 的 identified message 校验）；
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
    // V3-H1：平台逐条把注入项当**消息**消费，裸 ContentBlock 会在
    // dsh-agent-loop:1067 的 `message.source.kind` 处崩。形状校验前移到
    // 适配层，错误信息指向插件而不是让平台抛 undefined。
    patch.inject.forEach((message, index) => {
      assertInjectedMessage(message, index);
    });
    const entered = Array.isArray(base.messages) ? base.messages : [];
    return { ...base, kind: 'enter', messages: [...entered, ...patch.inject] };
  }
  if (patch.kind === 'enter') {
    throw new TypeError('onPreStep enter decision must carry a "messages" array');
  }
  return base;
}

/** prompt 的默认超时：宿主 prompt(request, signal) 的第二个参数是 AbortSignal。 */
const PROMPT_TIMEOUT_MS = 30_000;

/**
 * 构造 prompt 的 AbortSignal（C5-H1a）。
 *
 * DSH 0.2.1-rc.5 的 `ApiSessionList.prompt(request, signal)` 把第二个参数
 * 当 AbortSignal 用（内部会调 `signal.throwIfAborted()`），消息 source 由
 * 宿主自己生成成 `{ kind: 'user', rpcId: request.requestId }`。旧宿主则把
 * 第二个参数当 source 对象。为了同时兼容两种宿主，这里返回真正的
 * AbortSignal，并尽量在它上面附加 `kind` / `rpcId`（附加失败就忽略，
 * 不影响新宿主）。
 *
 * @param {{ requestId?: string }} request
 * @returns {AbortSignal}
 */
function deliverySignal(request) {
  const signal = AbortSignal.timeout(PROMPT_TIMEOUT_MS);
  try {
    Object.defineProperty(signal, 'kind', { value: 'user', configurable: true });
    if (typeof request?.requestId === 'string' && request.requestId.length > 0) {
      Object.defineProperty(signal, 'rpcId', { value: request.requestId, configurable: true });
    }
  } catch {
    // 兼容旧宿主的 best-effort 附加：失败时仍按新宿主语义工作。
  }
  return signal;
}

/**
 * 创建本插件唯一的平台入口。所有平台调用都经传入的 ctx（或调用方传入的
 * agent 句柄）完成，适配层本身不 import 平台内部包。
 *
 * C-H1：cordis 4 对**未声明 inject** 的 service 属性读会直接抛
 * `cannot get property "x" without inject`，所以这里一律用 `ctx.get(name)`
 * 读 service（永不抛，缺失返回 undefined），再由 capabilities 走
 * `unavailable()` 降级；`ctx.logger`/`ctx.on` 是 Context 自有属性/mixin，
 * 不在 inject 约束内。测试席位 now/cwd 由调用方经 opts 传入。
 *
 * @param {object} ctx DSH/Cordis 平台上下文
 * @param {{ now?: () => number, cwd?: string|(() => string|undefined) }} [opts]
 *   可注入时钟与工作目录（测试与回放用）
 * @returns {object} 适配器；capabilities 暴露当前宿主实际具备的能力
 */
export function createAdapter(ctx, opts = {}) {
  if (ctx === null || typeof ctx !== 'object') {
    throw new TypeError('createAdapter(ctx): ctx must be an object');
  }

  /**
   * 按 service 名读平台能力。`ctx.get()` 是 cordis 4 唯一不抛的属性读法：
   * 未注册/未激活时返回 undefined，不会因为缺 inject 而打断 apply。
   * @param {string} name
   * @returns {any}
   */
  const service = (name) => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  /**
   * V3-M1：读**已声明 inject** 的 service，走正常属性访问。
   *
   * 声明过的 service 由 cordis fiber store 在 apply 前就绪（缺 service 时
   * entry 停在 waiting、根本不会执行到这里），属性读不会触发
   * `cannot get property "x" without inject`；这才是平台推荐写法，也能让
   * cordis 的 service 生命周期（reload/替换）生效。
   *
   * 仍保留 `get()` 回落：测试替身可能只在 `get()` 上暴露同名 service。
   * @param {string} name
   * @returns {any}
   */
  const declaredService = (name) => {
    let value;
    try {
      value = ctx[name];
    } catch {
      value = undefined;
    }
    return value === undefined ? service(name) : value;
  };

  /**
   * V3-M1：`timer` 是声明过的 inject，cordis 把它投影成 Context mixin
   * `ctx.interval(callback, delay) → Disposer`（docs/platform-api.md §1 #6，
   * `cordis-plugin-timer/lib/index.js:48,53`）。直接读 mixin，不再绕
   * `ctx.get('timer').interval`。
   * @returns {Function|undefined}
   */
  const intervalSeat = () => (typeof ctx.interval === 'function' ? ctx.interval : undefined);

  /** Context 自有属性（不在 inject 约束内）；cordis 根上下文一定持有 logger。 */
  const logger = ctx.logger;

  // headless 宿主的 logger 是带 exporters 的函数（`ctx.get('logger')` 为 undefined），
  // 调用 `info()` 既不抛错也没有可见 sink（C-H1 真机实测：启动日志被吞）。
  // 这类宿主上把 info 及以上日志镜像到 stderr，发布门
  // （scripts/probe/run-headless.mjs --plugin）才有可断言的通道；桌面宿主的
  // logger 是普通对象，不会走这条镜像。
  //
  // V3-L1：debug 也曾被全量镜像，headless 跑一轮会把 stderr 刷成调试流。默认
  // 只镜像 info/warn/error；确实要看 debug 时显式设置
  // DSH_COMPANION_MIRROR_DEBUG=1（发布门不设置，保持输出可断言）。
  const mirrorToStderr = typeof logger === 'function' && typeof process.stderr?.write === 'function';
  const mirrorDebug = process.env.DSH_COMPANION_MIRROR_DEBUG === '1';
  const MIRROR_LEVELS = new Set(['info', 'warn', 'error']);

  /**
   * 时钟：优先 opts.now（apply 传入的席位），其次宿主 `ctx.get('now')`，
   * 最后回落 Date.now()。绝不直接读 `ctx.now`：cordis 4 里它是未声明 service，
   * 属性读会抛 `cannot get property "now" without inject`。
   */
  const nowSeat = typeof opts.now === 'function' ? opts.now : service('now');
  const now = typeof nowSeat === 'function'
    ? () => Number(nowSeat())
    : (typeof nowSeat === 'number' && Number.isFinite(nowSeat) ? () => nowSeat : () => Date.now());

  /**
   * 宿主工作目录投影；工具层需要它而不是直接读 process.cwd()。
   * 读取顺序：opts.cwd → `ctx.get('cwd')` → `ctx.get('workspace').cwd`，
   * 都没有时返回 undefined，由 apply 的席位兜底 process.cwd()。
   * @returns {string|undefined}
   */
  const cwd = () => {
    let value;
    if (typeof opts.cwd === 'function') value = opts.cwd();
    else if (opts.cwd !== undefined) value = opts.cwd;
    if (value === undefined) {
      const seat = service('cwd');
      value = typeof seat === 'function' ? seat() : seat;
    }
    if (value === undefined) value = service('workspace')?.cwd;
    return typeof value === 'string' && value !== '' ? value : undefined;
  };

  /**
   * H3②：线程/任务工具的能力探测。只读 `ctx.get('sessionController')`，
   * **绝不实际创建会话**；公开服务的 create/prompt/cancel 缺一个就视为不支持。
   *
   * C5-H1b：这里探测的是 `ApiSessionList` 的公开方法 `create`，不是内部类
   * `ApiSessionAgentController` 的 `createSession`（后者不在服务对象上）。
   * @returns {boolean}
   */
  const hasThreadControl = () => {
    const controller = service('sessionController');
    return typeof controller?.create === 'function'
      && typeof controller?.prompt === 'function'
      && typeof controller?.cancel === 'function';
  };

  const capabilities = Object.freeze({
    get systemPrompt() {
      return typeof declaredService('systemPrompt')?.section === 'function';
    },
    get preStep() {
      return typeof ctx.on === 'function';
    },
    get turnStopping() {
      // 事件存在性无法静态探测；宿主有 on() 即允许注册，真实触发由会话决定。
      return typeof ctx.on === 'function';
    },
    get timer() {
      return typeof intervalSeat() === 'function';
    },
    get compaction() {
      return typeof service('compaction')?.compactRegion === 'function';
    },
    get sessionController() {
      return hasThreadControl();
    },
    /**
     * H3②：线程/任务工具的能力门槛，与 `sessionController` 同源。
     * 为 false 时接线层**不要注册** thread_run/task_run/thread_* 工具
     * （见 docs/platform-api.md §5）。
     */
    get threadTools() {
      return hasThreadControl();
    },
    get archive() {
      return typeof service('workspaceRegistry')?.archiveSession === 'function';
    },
    get tokenMeter() {
      return typeof service('tokenMeter')?.measure === 'function';
    },
    get tokenEstimator() {
      return typeof service('tokenMeter')?.estimateMessage === 'function';
    },
    get sessionEvent() {
      return typeof ctx.on === 'function';
    },
    get sessionQuery() {
      return typeof service('sessionQuery')?.readSurface === 'function';
    },
    get inbox() {
      // 清空排队输入需要拿到 agent 句柄（ctx.agents.get）再走 agent.inbox。
      const agents = service('agents');
      return typeof agents?.get === 'function' || Array.isArray(agents);
    },
    get logger() {
      return logger !== undefined && logger !== null && typeof logger.info === 'function';
    },
    get commands() {
      return typeof declaredService('commands')?.register === 'function';
    },
    get tools() {
      return typeof declaredService('tools')?.register === 'function';
    },
    get unarchive() {
      return typeof service('workspaceRegistry')?.unarchiveSession === 'function';
    },
    get llm() {
      return typeof service('llm')?.stream === 'function';
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
    const sink = logger?.[level];
    const wrote = typeof sink === 'function';
    if (wrote) {
      if (meta === undefined) sink.call(logger, message);
      else sink.call(logger, message, meta);
    }
    if (mirrorToStderr && (mirrorDebug || MIRROR_LEVELS.has(level))) {
      try {
        process.stderr.write(`${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}\n`);
      } catch {
        // stderr 不可写时忽略：日志不能反过来影响插件运行。
      }
    }
    return wrote;
  }

  /**
   * 注册 system prompt 段落，返回 Cordis disposer。
   * @param {{ name: string, order: number, text: string|Function }} section
   * @returns {Function}
   */
  function section(section) {
    const impl = declaredService('systemPrompt');
    if (typeof impl?.section !== 'function') {
      throw unavailable('no-system-prompt', 'ctx.systemPrompt.section()');
    }
    return impl.section(section);
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
   * 注册 agent/turn-stopping 监听器（serial 事件，无 next）。
   * handle 在 turn 关闭前执行；这里吞掉处理异常，避免保护逻辑阻断会话。
   * @param {(payload: object) => void|Promise<void>} handler
   * @returns {Function}
   */
  function onTurnStopping(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('onTurnStopping(handler): handler must be a function');
    }
    if (typeof ctx.on !== 'function') {
      throw unavailable('no-turn-stopping', 'ctx.on("agent/turn-stopping")');
    }
    const listener = async (payload) => {
      try {
        await handler(payload);
      } catch (error) {
        log('warn', '[dsh-companion] turn-stopping handler failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    return ctx.on('agent/turn-stopping', listener);
  }

  /**
   * 注册周期定时器，返回 disposer。
   * @param {number} ms 周期毫秒
   * @param {Function} callback
   * @returns {Function}
   */
  function every(ms, callback) {
    const interval = intervalSeat();
    if (typeof interval !== 'function') {
      throw unavailable('no-timer', 'ctx.interval()');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('every(ms, callback): callback must be a function');
    }
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new TypeError('every(ms, callback): ms must be a positive finite number');
    }
    return interval.call(ctx, callback, ms);
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
    const impl = service('compaction');
    if (typeof impl?.compactRegion !== 'function') {
      throw unavailable('no-compaction', 'ctx.compaction.compactRegion()');
    }
    return impl.compactRegion(start, end, agent, signal);
  }

  /**
   * 开一个会话（C5-H1b）。
   *
   * 宿主服务 `sessionController` 实际是 `ApiSessionList`，公开方法是
   * `create(request)`；内部类 `ApiSessionAgentController.createSession` 不在
   * 服务对象上。公开 `create` 返回 `{ sessionId, agentPreset? }`（不是
   * `{ agent }`），这里归一成历史约定 `{ agent, agentPreset, sessionId }`，
   * agent 句柄用公开的 `resolveAgent(sessionId)` 反查，调用方无需感知差异。
   *
   * 保持同步抛 `PlatformError`（缺能力时），返回值是 Promise。
   *
   * @param {object} request { sessionId?, cwd, agentPreset?, reusable? }
   * @returns {Promise<{agent: object|null, agentPreset: unknown, sessionId?: string}>}
   */
  function createSession(request) {
    const impl = service('sessionController');
    if (typeof impl?.create !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.create()');
    }
    return Promise.resolve(impl.create(request)).then(async (created) => {
      const sessionId = sessionIdOf(created);
      const agent = created?.agent
        ?? (sessionId === null ? null : await resolveAgent(sessionId));
      return {
        agent,
        agentPreset: created?.agentPreset,
        ...(sessionId === null ? {} : { sessionId }),
      };
    });
  }

  /**
   * 向会话投递一条用户消息（C5-H1a）。
   *
   * 宿主签名是 `prompt(request, signal)`：第二个参数必须是 AbortSignal。
   * 消息的 source 由宿主按 `request.requestId` 构造，所以这里保证每次调用
   * 都带 requestId（调用方没给时退化为一次性 `companion-<uuid>`），不去重
   * 就会在宿主侧失去幂等。
   *
   * @param {{ sessionId: string, content: unknown[], requestId?: string, mode?: 'queue'|'steer' }} request
   * @returns {Promise<unknown>}
   */
  function prompt(request) {
    const impl = service('sessionController');
    if (typeof impl?.prompt !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.prompt()');
    }
    const normalized = request !== null && typeof request === 'object' ? { ...request } : request;
    if (
      normalized !== null
      && typeof normalized === 'object'
      && !(typeof normalized.requestId === 'string' && normalized.requestId.length > 0)
    ) {
      normalized.requestId = `companion-${randomUUID()}`;
    }
    return impl.prompt(normalized, deliverySignal(normalized));
  }

  /**
   * 取消会话当前工作。
   * @param {string|{ sessionId: string }} target
   * @returns {unknown}
   */
  function cancel(target) {
    const impl = service('sessionController');
    if (typeof impl?.cancel !== 'function') {
      throw unavailable('no-session', 'ctx.sessionController.cancel()');
    }
    if (typeof target === 'string') return impl.cancel({ sessionId: target });
    if (target === null || typeof target !== 'object') {
      throw new TypeError('cancel(target): expected a sessionId string or a request object');
    }
    return impl.cancel(target);
  }

  /**
   * 从 createSession 返回值/请求对象里取会话 id（C5-H1b）。
   * @param {unknown} value
   * @returns {string|null}
   */
  function sessionIdOf(value) {
    if (typeof value === 'string') return value === '' ? null : value;
    if (value === null || typeof value !== 'object') return null;
    const candidates = [
      value.sessionId,
      value.session?.id,
      value.agent?.sessionId,
      value.agent?.id,
      value.agent?.session?.id,
    ];
    return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '') ?? null;
  }

  /**
   * 用公开服务 `sessionController.resolveAgent(sessionId)` 反查 agent 句柄；
   * 服务没有该方法时回落到 `ctx.agents`（数组或 Map 风格 get）。
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async function agentBySessionId(sessionId) {
    const controller = service('sessionController');
    if (typeof controller?.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(sessionId);
        if (resolved !== null && typeof resolved === 'object' && resolved.agent) {
          return resolved.agent;
        }
      } catch {
        // resolveAgent 抛错时继续试 agents 服务；两者都不可用则返回 null。
      }
    }
    const agents = service('agents');
    if (typeof agents?.get === 'function') {
      return agents.get(sessionId) ?? null;
    }
    if (Array.isArray(agents)) {
      return agents.find(
        (agent) => agent?.id === sessionId || agent?.session?.id === sessionId,
      ) ?? null;
    }
    return null;
  }

  /**
   * 把 agent 句柄 / createSession 返回值 / 会话 id 归一成 agent 句柄。
   *
   * C5-H1b：字符串或 `{ sessionId }` 走公开的
   * `sessionController.resolveAgent(sessionId)`（宿主内部同样用这个方法），
   * 不再假设调用方一定拿得到 agent 对象。
   * @param {unknown} target
   * @returns {Promise<object|null>}
   */
  async function resolveAgent(target) {
    if (typeof target === 'string') {
      return agentBySessionId(target);
    }
    if (target === null || typeof target !== 'object') return null;
    if (typeof target.whenIdle === 'function') return target;
    if (target.agent !== undefined) {
      return target.agent !== null && typeof target.agent === 'object' ? target.agent : null;
    }
    const sessionId = sessionIdOf(target);
    if (sessionId !== null) return agentBySessionId(sessionId);
    return target;
  }

  /**
   * 等待 agent 静默。whenIdle 属于 agent 句柄而非 sessionController；
   * 会话 id 或 createSession 返回值先经 resolveAgent 归一。
   * @param {object|string} target agent 句柄、会话 id，或 createSession 的返回值
   * @returns {Promise<unknown>}
   */
  function whenIdle(target) {
    return Promise.resolve(resolveAgent(target)).then((agent) => {
      if (agent !== null && typeof agent === 'object' && typeof agent.whenIdle === 'function') {
        return agent.whenIdle();
      }
      throw unavailable('no-when-idle', 'agent.whenIdle()');
    });
  }

  /**
   * 清空一个会话的排队输入（硬超时后的第二段回收）。
   *
   * 平台公开面没有 `cleanInbox`：`sessionController.cancel()` 内部固定用
   * `agent.cancel({keepInbox:true})`，只中止当前轮。队列清空必须走
   * `agent.inbox.clear()`（README 公开的 Inbox 结构接口）。
   * 会话已结束/找不到 agent 时返回 false（幂等，不抛）。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>} 是否真的清空了 inbox
   */
  async function cleanInbox(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('cleanInbox(sessionId): sessionId must be a non-empty string');
    }
    const agent = await resolveAgent(sessionId);
    if (agent === null || typeof agent !== 'object') return false;
    const inbox = agent.inbox;
    if (inbox === null || typeof inbox !== 'object' || typeof inbox.clear !== 'function') {
      return false;
    }
    await inbox.clear();
    return true;
  }

  /**
   * 归档会话。options.stopActivity === true 时平台先写归档集再停活动。
   * @param {string} sessionId
   * @param {{ stopActivity?: boolean }} [options]
   * @returns {Promise<unknown>}
   */
  function archiveSession(sessionId, options = {}) {
    const impl = service('workspaceRegistry');
    if (typeof impl?.archiveSession !== 'function') {
      throw unavailable('no-archive', 'ctx.workspaceRegistry.archiveSession()');
    }
    return impl.archiveSession(sessionId, options);
  }

  /**
   * 读取会话的 token 计量。
   * @param {object} session
   * @param {object} [requestHeader]
   * @returns {object}
   */
  function measure(session, requestHeader) {
    const impl = service('tokenMeter');
    if (typeof impl?.measure !== 'function') {
      throw unavailable('no-token-meter', 'ctx.tokenMeter.measure()');
    }
    return impl.measure(session, requestHeader);
  }

  /**
   * 估算一条消息的 token（文本 + 角色框架，平台固定启发式）。
   * 只用于 surface 索引里给单条消息标价，不参与预算判定。
   * @param {object} message
   * @returns {number}
   */
  function estimateMessage(message) {
    const impl = service('tokenMeter');
    if (typeof impl?.estimateMessage !== 'function') {
      throw unavailable('no-token-estimator', 'ctx.tokenMeter.estimateMessage()');
    }
    return impl.estimateMessage(message);
  }

  /**
   * 订阅 `session/event`（post-commit 逐条 append feed）。
   * 回调参数是 (session, event)；返回 disposer。
   * @param {(session: object, event: object) => void} handler
   * @returns {Function}
   */
  function onSessionEvent(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('onSessionEvent(handler): handler must be a function');
    }
    if (typeof ctx.on !== 'function') {
      throw unavailable('no-session-event', 'ctx.on("session/event")');
    }
    return ctx.on('session/event', (session, event) => {
      try {
        handler(session, event);
      } catch {
        // 索引是加速层：任何异常都不能打断会话事件流。
      }
    });
  }

  /**
   * 读一个会话当前的完整 surface 快照（events 与 surface.nodes 逐位 1:1）。
   * 每次 O(整段 log)：只用于冷启动/漏事件回填，不要放进热路径。
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  function readSurface(sessionId) {
    const impl = service('sessionQuery');
    if (typeof impl?.readSurface !== 'function') {
      throw unavailable('no-session-query', 'ctx.sessionQuery.readSurface()');
    }
    return impl.readSurface(sessionId);
  }

  /**
   * 注册一条人类命令。定义形状与平台一致：
   * `{ definitionId, name, description, input?, handler }`。
   * 命令名必须是平台可解析的小写 ASCII（`/^[a-z][a-z0-9_-]*$/`）。
   * @param {{definitionId?: string, name: string, description: string, handler: Function}} definition
   * @returns {Function} 平台 disposer
   */
  function registerCommand(definition) {
    const impl = declaredService('commands');
    if (typeof impl?.register !== 'function') {
      throw unavailable('no-commands', 'ctx.commands.register()');
    }
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError('registerCommand(definition): definition must be an object');
    }
    return impl.register(definition);
  }

  /**
   * 注册一个模型工具。定义形状采用平台裸注册契约：
   * `{ name, description, parameters, output: { schema, render }, execute }`。
   * `parameters` / `output.schema` 均为 JSON Schema；本插件不依赖 `defineTool`。
   * @param {{name: string, description: string, parameters: object,
   *   output: {schema: object, render: Function}, execute: Function}} definition
   * @returns {Function} 平台 disposer
   */
  function registerTool(definition) {
    const impl = declaredService('tools');
    if (typeof impl?.register !== 'function') {
      throw unavailable('no-tools', 'ctx.tools.register()');
    }
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError('registerTool(definition): definition must be an object');
    }
    return impl.register(definition);
  }

  /**
   * V3-M1：宿主销毁 context 时的兜底回收钩子。
   *
   * cordis 4 在 fiber dispose 时广播 `dispose` 事件；宿主未必调用 apply 返回的
   * `handle.dispose()`（例如直接 `ctx.dispose()` 或插件热重载），注册的
   * section/command/tool/listener 就会残留。把清理挂到该事件上，保证
   * 「apply → ctx dispose → apply」不会让注册数翻倍。
   *
   * @param {() => void} handler 清理回调（必须幂等）
   * @returns {Function|null} 注册成功返回 disposer；宿主没有 on() 时返回 null
   */
  function onDispose(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('onDispose(handler): handler must be a function');
    }
    if (typeof ctx.on !== 'function') return null;
    return ctx.on('dispose', () => {
      try {
        handler();
      } catch {
        // 卸载钩子里的异常不能打断宿主自己的 dispose 流程。
      }
    });
  }

  /**
   * 解除归档（线程重新激活）。与 archiveSession 对称，可选能力。
   * @param {string} sessionId
   * @returns {Promise<unknown>}
   */
  function unarchiveSession(sessionId) {
    const impl = service('workspaceRegistry');
    if (typeof impl?.unarchiveSession !== 'function') {
      throw unavailable('no-unarchive', 'ctx.workspaceRegistry.unarchiveSession()');
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('unarchiveSession(sessionId): sessionId must be a non-empty string');
    }
    return impl.unarchiveSession(sessionId);
  }

  /**
   * 列出平台已注册的模型路由（`ctx.llm.listProviders()` 的只读投影）。
   * 兼容同步/异步宿主实现；能力位在调用时动态判断（C5-H2）。
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async function listProviders() {
    const impl = service('llm');
    if (typeof impl?.stream !== 'function') {
      throw unavailable('no-llm', 'ctx.llm.listProviders()');
    }
    if (typeof impl.listProviders !== 'function') return [];
    const rows = await impl.listProviders();
    return Array.isArray(rows)
      ? rows.map((row) => ({ id: row?.id, name: row?.name }))
      : [];
  }

  /**
   * @param {string} provider 路由 id
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async function listModels(provider) {
    const impl = service('llm');
    if (typeof impl?.stream !== 'function') {
      throw unavailable('no-llm', 'ctx.llm.listModels()');
    }
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new TypeError('listModels(provider): provider must be a non-empty string');
    }
    if (typeof impl.listModels !== 'function') return [];
    const rows = await impl.listModels(provider);
    return Array.isArray(rows)
      ? rows.map((row) => ({ id: row?.id, name: row?.name }))
      : [];
  }

  /**
   * 走平台唯一模型调用路径（`ctx.llm.stream`），把文本增量拼成完整字符串。
   * 只用于巩固草稿这类一次性文本生成；失败时抛错，由调用方降级。
   *
   * @param {{provider: string, model: string, messages: unknown[],
   *          signal?: AbortSignal}} request
   * @returns {Promise<string>}
   */
  async function complete(request) {
    const impl = service('llm');
    if (typeof impl?.stream !== 'function') {
      throw unavailable('no-llm', 'ctx.llm.stream()');
    }
    if (request === null || typeof request !== 'object') {
      throw new TypeError('complete(request): request must be an object');
    }
    if (typeof request.provider !== 'string' || request.provider.length === 0) {
      throw new TypeError('complete(request): provider must be a non-empty string');
    }
    if (typeof request.model !== 'string' || request.model.length === 0) {
      throw new TypeError('complete(request): model must be a non-empty string');
    }
    if (!Array.isArray(request.messages)) {
      throw new TypeError('complete(request): messages must be an array');
    }

    let text = '';
    let failure = null;
    for await (const chunk of impl.stream({
      provider: request.provider,
      model: request.model,
      messages: request.messages,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })) {
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta') {
        const delta = chunk.text ?? chunk.delta ?? '';
        if (typeof delta === 'string') text += delta;
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          failure = chunk.reason?.failure?.message ?? chunk.reason?.kind;
        }
      }
    }
    if (failure !== null) {
      throw new Error(`model call failed: ${failure}`);
    }
    if (text.trim() === '') {
      throw new Error('model call returned no text');
    }
    return text;
  }

  return {
    now,
    cwd,
    log,
    section,
    onPreStep,
    onTurnStopping,
    every,
    compactRegion,
    createSession,
    prompt,
    cancel,
    whenIdle,
    cleanInbox,
    archiveSession,
    measure,
    estimateMessage,
    onSessionEvent,
    readSurface,
    registerCommand,
    registerTool,
    onDispose,
    unarchiveSession,
    listProviders,
    listModels,
    complete,
    capabilities,
  };
}
