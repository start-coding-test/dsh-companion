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
 */

export const MAIN_SCOPE = 'main';
export const MAIN_SESSION_META_KEY = 'main_session_id';

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
 * @param {unknown} logger 适配层 log(level, message, meta) 或 console 风格
 * @param {string} message
 * @param {object} meta
 */
function warn(logger, message, meta) {
  if (typeof logger === 'function') {
    try {
      logger('warn', message, meta);
    } catch {
      // 诊断日志不得影响路由。
    }
    return;
  }
  if (typeof logger?.warn === 'function') {
    try {
      logger.warn(message, meta);
    } catch {
      // 同上。
    }
  }
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
 * @param {{store?: object, logger?: Function|object}} [options]
 * @returns {{
 *   kind: 'main'|'thread'|'subagent',
 *   scope: string|null,
 *   sessionId: string|null,
 *   key?: string,
 *   firstMain?: boolean,
 *   unknownMain?: boolean
 * }}
 */
export function classifySession(agent, options = {}) {
  const { store, logger } = options;
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
    }
    if (mainSessionId !== null && mainSessionId !== sessionId) {
      warn(logger, '[dsh-companion] unexpected main session id; keeping main scope', {
        expected: mainSessionId,
        actual: sessionId,
      });
      return { kind: 'main', scope: MAIN_SCOPE, sessionId, unknownMain: true };
    }
    return {
      kind: 'main',
      scope: MAIN_SCOPE,
      sessionId,
      firstMain: mainSessionId === sessionId && mainSessionId !== null,
    };
  }

  return { kind: 'main', scope: MAIN_SCOPE, sessionId };
}
