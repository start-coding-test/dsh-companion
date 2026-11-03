/**
 * H1：surface seq 索引与巩固窗口选区。
 *
 * 平台事实（docs/h1-h3-probe.md，2026-11 实测 + 源码核对）：
 * - `session.surface.nodes` 只给 **seq**（`readonly SessionSeq[]`），不含文本/角色；
 * - `tokenMeter.measure(session).nodes` 每项固定 `{ seq, tokens, heuristicTokens }`，
 *   同样只有 seq 与 token 数；
 * - `session/event` 是 post-commit 的逐条 feed，`session.deriveEventMessage(event)`
 *   把事件投影成 Message（两者都是公开面）；
 * - 冷启动/漏事件用 `sessionQuery.readSurface(sessionId)` 回填：`events` 与
 *   `surface.nodes` **逐位 1:1**，每次 O(整段 log)，因此每会话最多一次；
 * - **surface 位置 ≠ 数值 seq**：`compactRegion` 的闭区间按位置解释，替换节点追加在
 *   日志末尾（seq 最大），所以压缩后的可见 seq 可能非单调（`catalog:627-632`）。
 *
 * 本模块只做三件事：维护 `seq → {role, text, tokens}` 索引、给调用方一个对齐的
 * surface 快照、按「水位之后 + 尾部 6,144 之前」算巩固窗口。不做任何写库/模型调用。
 */

/** 尾部保留预算：最后 6,144 tokens 留在 surface 里，不进入巩固窗口。 */
export const CONSOLIDATION_TAIL_TOKENS = 6144;

/** 单会话最多保留的 seq 记录数（防御异常长的 surface，超出丢最旧）。 */
const MAX_RECORDS_PER_SESSION = 5000;

/** 最多跟踪的会话数（主会话 + 线程 + subagent，超出按 LRU 淘汰）。 */
const MAX_SESSIONS = 32;

/**
 * 把 Message / 内容块数组压成纯文本。
 * 只取 `type === 'text'` 的块；工具调用/结果保留一行摘要，方便模型理解上下文。
 * @param {unknown} message
 * @returns {string}
 */
export function flattenMessage(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  const blocks = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(message)
      ? message
      : [];
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'tool-call' || block.type === 'tool_use') {
      const name = block.name ?? block.toolName ?? '';
      parts.push(`[tool call${name === '' ? '' : ` ${name}`}]`);
      continue;
    }
    if (block.type === 'tool-result' || block.type === 'tool_result') {
      parts.push('[tool result]');
    }
  }
  return parts.join('\n');
}

/**
 * 从会话上读 surface 的 seq 列表（公开面：`session.surface.nodes`）。
 * @param {object} session
 * @returns {number[]}
 */
export function surfaceSeqs(session) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return [];
  const seqs = [];
  for (const value of nodes) {
    // 只接受真正的 seq：不要把 null/布尔（Number(null) === 0）当成节点。
    if (typeof value === 'number' && Number.isFinite(value)) {
      seqs.push(value);
      continue;
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      seqs.push(Number(value));
    }
  }
  return seqs;
}

/**
 * 压缩后的新水位。
 *
 * 平台把 `[startIdx..endIdx]` 换成一个**追加在日志末尾**的替换节点（seq 最大），
 * 因此：
 * 1. 能在新 surface 里认出「旧 surface 没有的 seq」→ 取其中最大者（替换节点）；
 * 2. 认不出（例如 FakeCtx 的整段重编号）→ 按位置取 `newSeqs[startIdx]`；
 * 3. 都取不到（空 surface）→ 兜底 `max(0, min(newSeqs) - 1)`，即任务里
 *    「压缩后仍保留的最小 seq − 1」的数值下界，保证新 seq 空间里自洽。
 *
 * @param {{newSeqs?: number[], oldSeqs?: number[], startIdx?: number}} input
 * @returns {number}
 */
export function watermarkAfterCompact({ newSeqs = [], oldSeqs = [], startIdx = 0 } = {}) {
  const seqs = newSeqs.filter((seq) => Number.isFinite(seq));
  if (seqs.length === 0) return 0;
  const known = new Set(oldSeqs.filter((seq) => Number.isFinite(seq)));
  const fresh = seqs.filter((seq) => !known.has(seq));
  if (fresh.length > 0) return Math.max(...fresh);
  if (Number.isSafeInteger(startIdx) && startIdx >= 0 && startIdx < seqs.length) {
    return seqs[startIdx];
  }
  return Math.max(0, Math.min(...seqs) - 1);
}

/**
 * 计算巩固窗口：`(afterSeq, endSeq]`。
 *
 * - `afterSeq` 是「水位」seq，**按位置**比较（`indexOf`），不按数值大小；
 *   水位不在当前 surface（被压缩替换掉）时返回 `reason: 'stale-watermark'`，
 *   调用方应跳过本轮而不是从位置 0 重来（否则会重复巩固）。
 * - 尾部从后往前累加 token，把最后 ≤6,144 tokens 留给模型；跨过预算的那个节点
 *   留在尾部里，所以窗口可能在预算内提前结束。
 *
 * @param {{seqs: number[], nodes: object[], records: object[]}} snapshot
 * @param {{afterSeq?: number, budgetTokens?: number}} [options]
 * @returns {{
 *   region: {startIdx: number, endIdx: number, startSeq: number, endSeq: number,
 *            tokens: number, count: number, text: string, missing: number}|null,
 *   reason: string,
 *   tailStartIdx?: number,
 * }}
 */
export function planRegion(snapshot, options = {}) {
  const seqs = Array.isArray(snapshot?.seqs) ? snapshot.seqs : [];
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const budgetTokens = Number.isFinite(options.budgetTokens)
    ? Math.max(0, options.budgetTokens)
    : CONSOLIDATION_TAIL_TOKENS;
  if (seqs.length === 0) return { region: null, reason: 'empty-surface' };

  let startIdx = 0;
  const afterSeq = Number(options.afterSeq);
  if (Number.isFinite(afterSeq) && afterSeq > 0) {
    const at = seqs.indexOf(afterSeq);
    if (at < 0) return { region: null, reason: 'stale-watermark' };
    startIdx = at + 1;
  }

  let tailTokens = 0;
  let tailStartIdx = seqs.length;
  for (let index = seqs.length - 1; index >= 0; index -= 1) {
    tailTokens += Number(nodes[index]?.tokens) || 0;
    if (tailTokens > budgetTokens) {
      tailStartIdx = index + 1;
      break;
    }
    tailStartIdx = index;
  }

  const endIdx = tailStartIdx - 1;
  if (endIdx < startIdx) {
    return { region: null, reason: 'inside-tail', tailStartIdx };
  }

  const lines = [];
  let tokens = 0;
  let missing = 0;
  for (let index = startIdx; index <= endIdx; index += 1) {
    const record = records[index] ?? null;
    const text = typeof record?.text === 'string' ? record.text : '';
    if (record === null || record?.missing === true) missing += 1;
    if (text !== '') lines.push(`${record?.role ?? 'unknown'}: ${text}`);
    tokens += Number(nodes[index]?.tokens) || Number(record?.tokens) || 0;
  }

  return {
    region: {
      startIdx,
      endIdx,
      startSeq: seqs[startIdx],
      endSeq: seqs[endIdx],
      tokens,
      count: endIdx - startIdx + 1,
      text: lines.join('\n'),
      missing,
    },
    reason: 'ok',
    tailStartIdx,
  };
}

/**
 * @param {string} role
 * @returns {string}
 */
function normalizeRole(role) {
  const value = typeof role === 'string' ? role.toLowerCase() : '';
  if (value === 'system' || value === 'developer' || value === 'user'
    || value === 'assistant' || value === 'tool') {
    return value;
  }
  return 'unknown';
}

/**
 * 创建按会话缓存的 surface 索引。
 *
 * @param {{
 *   platform: { measure?: Function, readSurface?: Function, estimateMessage?: Function },
 *   tailTokens?: number,
 * }} input
 * @returns {object} 索引句柄
 */
export function createSurfaceIndex({ platform, tailTokens = CONSOLIDATION_TAIL_TOKENS } = {}) {
  if (platform === null || typeof platform !== 'object') {
    throw new TypeError('[surface] createSurfaceIndex requires a platform adapter');
  }

  /** @type {Map<string, {id: string, records: Map<number, object>, rebuilt: boolean}>} */
  const sessions = new Map();

  /**
   * @param {object} session
   * @returns {string|null}
   */
  function sessionIdOf(session) {
    const id = session?.id ?? session?.header?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  }

  /**
   * 取（或建）会话索引状态，并按 LRU 触碰。
   * @param {object} session
   * @returns {{id: string, records: Map<number, object>, rebuilt: boolean}|null}
   */
  function stateFor(session) {
    const id = sessionIdOf(session);
    if (id === null) return null;
    const existing = sessions.get(id);
    if (existing !== undefined) {
      sessions.delete(id);
      sessions.set(id, existing);
      return existing;
    }
    const created = { id, records: new Map(), rebuilt: false };
    sessions.set(id, created);
    if (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
    return created;
  }

  /**
   * 事件 → 索引条目。
   * @param {object} session
   * @param {object} event
   * @param {number} seq
   * @param {object|null} [message]
   * @returns {{seq: number, role: string, text: string, tokens: number}|null}
   */
  function entryOf(session, event, seq, message = undefined) {
    let projected = message;
    if (projected === undefined) {
      projected = null;
      if (typeof session?.deriveEventMessage === 'function') {
        try {
          projected = session.deriveEventMessage(event);
        } catch {
          projected = null;
        }
      }
    }
    const source = projected ?? event?.data?.message ?? event?.data ?? null;
    const text = flattenMessage(source);
    const role = normalizeRole(projected?.role ?? event?.type?.split('/')?.[0]);
    let tokens = 0;
    if (projected !== null && projected !== undefined
      && typeof platform.estimateMessage === 'function') {
      try {
        const estimated = Number(platform.estimateMessage(projected));
        if (Number.isFinite(estimated) && estimated >= 0) tokens = estimated;
      } catch {
        tokens = 0;
      }
    }
    if (tokens === 0) tokens = Math.ceil(text.length / 2);
    return { seq, role, text, tokens };
  }

  /**
   * 增量写入一条 `session/event`。异常一律吞掉：索引只是加速层。
   * @param {object} session
   * @param {object} event
   * @returns {object|null}
   */
  function record(session, event) {
    try {
      const state = stateFor(session);
      if (state === null || event === null || typeof event !== 'object') return null;
      const seq = Number(event.seq);
      if (!Number.isFinite(seq)) return null;
      const entry = entryOf(session, event, seq);
      if (entry === null) return null;
      state.records.set(seq, entry);
      if (state.records.size > MAX_RECORDS_PER_SESSION) {
        state.records.delete(state.records.keys().next().value);
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * 用 `sessionQuery.readSurface()` 全量回填（O(整段 log)，每会话一次）。
   * @param {object} session
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object|null>} readSurface 原始结果
   */
  async function rebuild(session, options = {}) {
    const state = stateFor(session);
    if (state === null) return null;
    if (typeof platform.readSurface !== 'function') return null;
    if (state.rebuilt && options.force !== true) return null;
    const surface = await platform.readSurface(state.id);
    const events = Array.isArray(surface?.events) ? surface.events : [];
    const seqs = surfaceSeqs(session);
    const filled = new Map();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === null || typeof event !== 'object') continue;
      const seq = Number(seqs[index] ?? event.seq);
      if (!Number.isFinite(seq)) continue;
      filled.set(seq, entryOf(session, event, seq));
    }
    // 实时事件比回填快照新：同一 seq 以实时记录为准。
    for (const [seq, entry] of state.records) {
      if (!filled.has(seq)) filled.set(seq, entry);
    }
    state.records = filled;
    state.rebuilt = true;
    return surface;
  }

  /**
   * @param {number[]} seqs
   * @param {object} state
   * @param {Map<number, object>|null} measured
   * @returns {{records: object[], nodes: object[], missing: number}}
   */
  function build(seqs, state, measured) {
    const records = [];
    const nodes = [];
    let missing = 0;
    for (const seq of seqs) {
      const stored = state.records.get(seq) ?? null;
      const priced = measured?.get(seq) ?? null;
      const tokens = Number(priced?.tokens ?? stored?.tokens ?? 0) || 0;
      const heuristicTokens = Number(priced?.heuristicTokens ?? stored?.tokens ?? 0) || 0;
      if (stored === null) missing += 1;
      nodes.push({ seq, tokens, heuristicTokens });
      records.push(stored === null
        ? { seq, role: 'unknown', text: '', tokens, missing: true }
        : { ...stored, tokens, missing: false });
    }
    return { records, nodes, missing };
  }

  /**
   * 当前 surface 的对齐快照。
   * @param {object} session
   * @param {{measured?: object[]|null, allowRebuild?: boolean, forceRebuild?: boolean}} [options]
   * @returns {Promise<{seqs: number[], nodes: object[], records: object[], missing: number}>}
   */
  async function snapshot(session, options = {}) {
    // seq 列表优先用 tokenMeter.measure().nodes（平台按 surface 顺序克隆），
    // 拿不到时退回 session.surface.nodes；两者是同一组节点。
    const measuredList = Array.isArray(options.measured) ? options.measured : null;
    const measuredSeqs = measuredList === null
      ? []
      : measuredList
        .map((node) => Number(node?.seq))
        .filter((seq) => Number.isFinite(seq));
    const seqs = measuredSeqs.length > 0 ? measuredSeqs : surfaceSeqs(session);
    const state = stateFor(session);
    if (state === null || seqs.length === 0) {
      return { seqs: [], nodes: [], records: [], missing: 0 };
    }
    let measuredNodes = measuredList;
    if (measuredNodes === null && typeof platform.measure === 'function') {
      try {
        const measured = platform.measure(session);
        measuredNodes = Array.isArray(measured?.nodes) ? measured.nodes : null;
      } catch {
        measuredNodes = null;
      }
    }
    let measured = null;
    if (measuredNodes !== null) {
      measured = new Map();
      for (const node of measuredNodes) {
        const seq = Number(node?.seq);
        if (Number.isFinite(seq)) measured.set(seq, node);
      }
      // 多出来的 seq（历史测量）不该污染当前 surface：只按 seqs 取。
    }

    let built = build(seqs, state, measured);
    const allowRebuild = options.allowRebuild !== false;
    const shouldRebuild = built.missing > 0 && allowRebuild
      && (options.forceRebuild === true || state.rebuilt !== true);
    if (shouldRebuild) {
      try {
        await rebuild(session, { force: true });
        built = build(seqs, state, measured);
      } catch {
        // 回填失败就保留缺失标记，让调用方降级。
      }
    }
    return { seqs, nodes: built.nodes, records: built.records, missing: built.missing };
  }

  /**
   * 丢弃某个会话的索引（会话结束/压缩后重建）。
   * @param {string} sessionId
   * @returns {boolean}
   */
  function invalidate(sessionId) {
    return sessions.delete(sessionId);
  }

  /** @returns {number} 已跟踪会话数（测试/诊断用） */
  function size() {
    return sessions.size;
  }

  return { record, rebuild, snapshot, invalidate, size, sessionIdOf, tailTokens };
}
