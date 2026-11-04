/**
 * 会话身份路由（H3）：把平台 session 映射到记忆作用域。
 *
 * 判定顺序：
 *   1. `session.header.origin === 'subagent'`（或带 parentSession/delegationDepth）
 *      → subagent（没有自己的长期记忆作用域）；
 *   2. session 命中 `threads.session_id` → thread（scope=`thread:<key>`）；
 *   3. 其余 → main。
 *
 * 线程会话是插件自己通过 `createSession()` 创建的，平台 header 里没有可识别
 * 的 lineage，因此注册表优先；注册表读不到时退回 main（多注入一次比漏记忆安全）。
 *
 * main_session_id 绑定模式（V3-M2）：
 *   - `latest-user`（默认）：只有「最近一次真实用户输入」的非线程会话能占据主会话，
 *     探针/发布门等没有真实用户输入的会话不会把主会话钉死；真实会话出现时重绑。
 *   - `first`：兼容旧行为，首个非线程会话写入后不再更新（其余只告警）。
 */

export const MAIN_SCOPE = 'main';
export const MAIN_SESSION_META_KEY = 'main_session_id';

/** 主会话绑定模式：最近一次真实用户输入（默认）。 */
export const MAIN_BINDING_LATEST = 'latest-user';
/** 主会话绑定模式：首个非线程会话（旧行为，仅供排障/回滚）。 */
export const MAIN_BINDING_FIRST = 'first';
/** 允许的绑定模式。 */
export const MAIN_BINDINGS = Object.freeze([MAIN_BINDING_LATEST, MAIN_BINDING_FIRST]);

/**
 * 校验绑定模式；非法值抛 TypeError（配置层已校验，这里防御直接调用）。
 * @param {unknown} value
 * @returns {'latest-user'|'first'}
 */
export function normalizeMainBinding(value) {
  if (value === undefined || value === null || value === '') return MAIN_BINDING_LATEST;
  if (value === MAIN_BINDING_LATEST || value === MAIN_BINDING_FIRST) return value;
  throw new TypeError(
    `session.mainBinding must be "${MAIN_BINDING_LATEST}" or "${MAIN_BINDING_FIRST}", got ${String(value)}`,
  );
}

/**
 * 线程 key → 记忆作用域。
 * @param {string} key
 * @returns {string}
 */
export function threadScope(key) {
  return `thread:${key}`;
}

/**
 * 取 agent 的 session id。不同平台形态（agent.session.id / agent.id /
 * agent.sessionId）都兼容。
 * @param {object|null|undefined} agent
 * @returns {string|null}
 */
export function sessionIdOfAgent(agent) {
  const candidates = [agent?.session?.id, agent?.sessionId, agent?.id];
  return candidates.find((value) => typeof value === 'string' && value !== '') ?? null;
}

/**
 * 统一日志出口：适配层 log(level, message, meta) 或 console 风格对象。
 * @param {unknown} logger
 * @param {'debug'|'info'|'warn'} level
 * @param {string} message
 * @param {object} meta
 */
function log(logger, level, message, meta) {
  if (typeof logger === 'function') {
    try {
      logger(level, message, meta);
    } catch {
      // 诊断日志不得影响路由。
    }
    return;
  }
  if (typeof logger?.[level] === 'function') {
    try {
      logger[level](message, meta);
    } catch {
      // 同上。
    }
  }
}

/**
 * @param {unknown} logger
 * @param {string} message
 * @param {object} meta
 */
function warn(logger, message, meta) {
  log(logger, 'warn', message, meta);
}

/**
 * 「未知主会话」告警限流：同一个 store 上同一个 session 只 warn 一次，之后降为 debug。
 * 探针每轮都会给出新的会话 id，若不限流会持续刷屏（真机告警来源之一）。
 * @type {WeakMap<object, Set<string>>}
 */
const warnedSessions = new WeakMap();

/**
 * @param {object|undefined} store
 * @param {string} sessionId
 * @returns {boolean} true 表示本次是首次（应当 warn）
 */
function firstWarningFor(store, sessionId) {
  if (store === null || typeof store !== 'object') return true;
  let seen = warnedSessions.get(store);
  if (seen === undefined) {
    seen = new Set();
    warnedSessions.set(store, seen);
  }
  if (seen.has(sessionId)) return false;
  seen.add(sessionId);
  return true;
}

/**
 * 判断 header 是否属于 subagent。origin 是权威信号；parentSession /
 * delegationDepth 作为旧版/兼容 header 的兜底。
 * @param {object} header
 * @returns {boolean}
 */
function isSubagentHeader(header) {
  if (header === null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = Number(header.delegationDepth);
  return Number.isFinite(depth) && depth > 0
    && (typeof header.parentSession === 'string' || typeof header.parentSession === 'object');
}

/**
 * 把 agent 分类到 main / thread / subagent。
 *
 * @param {object|null|undefined} agent 平台 agent 句柄
 * @param {{store?: object, logger?: Function|object,
 *          binding?: 'latest-user'|'first', hasUserInput?: boolean}} [options]
 *   binding：主会话绑定模式（默认 latest-user）；
 *   hasUserInput：本 payload 是否含真实用户输入（非 runtime-context/召回注入），
 *     latest-user 模式下只有它为 true 才允许重绑。
 * @returns {{
 *   kind: 'main'|'thread'|'subagent',
 *   scope: string|null,
 *   sessionId: string|null,
 *   key?: string,
 *   mainSessionId?: string|null,
 *   firstMain?: boolean,
 *   unknownMain?: boolean,
 *   pendingRebind?: boolean,
 *   rebound?: boolean,
 *   reboundFrom?: string
 * }}
 */
export function classifySession(agent, options = {}) {
  const { store, logger } = options;
  const binding = normalizeMainBinding(options.binding);
  const hasUserInput = options.hasUserInput === true;
  const sessionId = sessionIdOfAgent(agent);
  const header = agent?.session?.header ?? agent?.header ?? null;

  if (isSubagentHeader(header)) {
    return { kind: 'subagent', scope: null, sessionId };
  }

  if (sessionId !== null && typeof store?.getThreadBySessionId === 'function') {
    let thread = null;
    try {
      thread = store.getThreadBySessionId(sessionId);
    } catch (error) {
      warn(logger, '[dsh-companion] thread lookup failed; treating session as main', {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (thread !== null && thread !== undefined && typeof thread.key === 'string') {
      return {
        kind: 'thread',
        scope: threadScope(thread.key),
        sessionId,
        key: thread.key,
      };
    }
  }

  if (sessionId !== null && typeof store?.getMeta === 'function') {
    let mainSessionId = null;
    try {
      mainSessionId = store.getMeta(MAIN_SESSION_META_KEY);
    } catch {
      mainSessionId = null;
    }
    if (mainSessionId === null || mainSessionId === undefined || mainSessionId === '') {
      try {
        store.setMeta(MAIN_SESSION_META_KEY, sessionId);
        mainSessionId = sessionId;
      } catch (error) {
        warn(logger, '[dsh-companion] failed to persist main_session_id', {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        kind: 'main',
        scope: MAIN_SCOPE,
        sessionId,
        mainSessionId,
        firstMain: true,
      };
    }
    if (mainSessionId === sessionId) {
      return {
        kind: 'main',
        scope: MAIN_SCOPE,
        sessionId,
        mainSessionId,
        firstMain: true,
      };
    }

    // 当前会话与已绑定的主会话不一致：是否重绑由绑定模式决定。
    if (binding === MAIN_BINDING_LATEST && hasUserInput) {
      try {
        store.setMeta(MAIN_SESSION_META_KEY, sessionId);
        log(logger, 'info', '[dsh-companion] main_session_id rebound to latest user session', {
          previous: mainSessionId,
          sessionId,
          binding,
        });
        return {
          kind: 'main',
          scope: MAIN_SCOPE,
          sessionId,
          mainSessionId: sessionId,
          rebound: true,
          reboundFrom: mainSessionId,
        };
      } catch (error) {
        warn(logger, '[dsh-companion] failed to rebind main_session_id; keeping previous', {
          previous: mainSessionId,
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          kind: 'main',
          scope: MAIN_SCOPE,
          sessionId,
          mainSessionId,
          unknownMain: true,
        };
      }
    }

    if (binding === MAIN_BINDING_LATEST) {
      // 没有真实用户输入（探针/发布门/线程外的系统会话）：不重绑、不刷屏。
      if (firstWarningFor(store, sessionId)) {
        warn(logger, '[dsh-companion] main session not rebound: no real user input yet', {
          bound: mainSessionId,
          sessionId,
          binding,
        });
      } else {
        log(logger, 'debug', '[dsh-companion] main session not rebound: no real user input yet', {
          bound: mainSessionId,
          sessionId,
          binding,
        });
      }
      return {
        kind: 'main',
        scope: MAIN_SCOPE,
        sessionId,
        mainSessionId,
        unknownMain: true,
        pendingRebind: true,
      };
    }

    // binding === 'first'：保持旧行为，只告警不重绑。
    warn(logger, '[dsh-companion] unexpected main session id; keeping main scope', {
      expected: mainSessionId,
      actual: sessionId,
    });
    return {
      kind: 'main',
      scope: MAIN_SCOPE,
      sessionId,
      mainSessionId,
      unknownMain: true,
    };
  }

  return { kind: 'main', scope: MAIN_SCOPE, sessionId, mainSessionId: sessionId ?? null };
}
