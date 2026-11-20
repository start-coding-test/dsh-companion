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
 * C120-H1：索引条目必需字段。
 *
 * 旧版本记录（升级前建立的内存索引 / 阶段 2 新增字段）缺任一字段都无法证明
 * compactRegion 的切口合法，必须用 `readSurface` 全量重读一次。新增字段时只往
 * 这里加名字，`snapshot()` 的触发逻辑不用改（阶段 2 的 sourceKind 走同一入口）。
 */
const REQUIRED_ENTRY_FIELDS = Object.freeze(['toolDelta']);

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
 * C120-H1：单条 surface 事件对「未配对工具调用数」的增量。
 *
 * 与宿主 `dsh-compaction` 的配平计数完全一致（deepseek-harness
 * `@deepseek-ai/dsh-compaction/src/tool-pairing.ts:29-38` 的 `eventDelta`）：
 * - `assistant/message` → 内容里 `tool-call` 块的数量（一次响应可发多个调用，+N）；
 * - `tool/result` → −1；
 * - 其它事件 → 0。
 *
 * 宿主**不按 callId 配对**（现网 `tool/result` 的 callId 为 undefined），只做计数
 * 累加，累计回到 0 的切口才允许 `compactRegion` 落刀。这里保持同一口径：块类型
 * 只认宿主认的 `tool-call` / `tool/result`，其它拼写按 0 计（宿主同样不认）。
 *
 * @param {unknown} event `session/event` 或 `sessionQuery.readSurface()` 的条目
 * @returns {number} 净配对增量（整数，可为负）
 */
export function toolDeltaOf(event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  if (type === 'assistant/message') {
    const content = event?.data?.message?.content ?? event?.data?.content;
    if (!Array.isArray(content)) return 0;
    let calls = 0;
    for (const block of content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call') calls += 1;
    }
    return calls;
  }
  if (type === 'tool/result') return -1;
  return 0;
}

/**
 * C120-H1：配平切口表。
 *
 * `cuts[i] === true` 表示「第 i 个节点之前」可落刀：前面所有节点的 toolDelta 累计为 0。
 * N 个节点有 N+1 个切口（最后一项是 surface 尾之后），与宿主
 * `tool-pairing.ts:11-24` 的 `cutBalanced` 同构。累计为负（孤儿 tool/result）时该切口
 * 记为不平衡：宿主遇到这种 surface 会直接抛 `corrupt surface`，我们提前挡掉。
 *
 * @param {object[]} records surface 记录（含 toolDelta）
 * @returns {boolean[]} 长度 = records.length + 1
 */
export function toolPairingCuts(records) {
  const list = Array.isArray(records) ? records : [];
  const cuts = new Array(list.length + 1).fill(false);
  let open = 0;
  cuts[0] = true;
  for (let index = 0; index < list.length; index += 1) {
    open += Number(list[index]?.toolDelta) || 0;
    cuts[index + 1] = open === 0;
  }
  return cuts;
}

/**
 * @param {object|null} record
 * @returns {boolean} 是否 tool/result 节点（起点落在它上面会把结果和调用切开）
 */
function isToolResultRecord(record) {
  return normalizeRole(record?.role) === 'tool';
}

/**
 * C120-H1：把 `[startIdx, endIdx]` 收紧到合法的配平切口。
 *
 * 合法 = 起点之前的累计为 0、起点不是 tool/result、终点之后的累计为 0。做法是只
 * **收缩**不扩张：起点向后推进到第一个合法切口（丢掉的未配对调用留在下一轮），
 * 终点向前退到最后一个合法切口（尾部未结束的 tool-call 留在 surface 里等结果）。
 *
 * @param {object[]} records
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {{startIdx: number, endIdx: number, adjusted: boolean}|null}
 *   `null` 表示收缩后没有可用区间
 */
export function alignRegionToToolPairing(records, startIdx, endIdx) {
  const list = Array.isArray(records) ? records : [];
  const start = Number(startIdx);
  const end = Number(endIdx);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end >= list.length || end < start) return null;
  const cuts = toolPairingCuts(list);
  let from = start;
  while (from <= end && (cuts[from] !== true || isToolResultRecord(list[from]))) from += 1;
  let to = end;
  while (to >= from && cuts[to + 1] !== true) to -= 1;
  if (from > to) return null;
  return { startIdx: from, endIdx: to, adjusted: from !== start || to !== end };
}

/**
 * 计算巩固窗口：`(afterSeq, endSeq]`。
 *
 * - `afterSeq` 是「水位」seq，**按位置**比较（`indexOf`），不按数值大小；
 *   水位不在当前 surface（被压缩替换掉）时返回 `reason: 'stale-watermark'`，
 *   调用方应跳过本轮而不是从位置 0 重来（否则会重复巩固）。
 * - 尾部从后往前累加 token，把最后 ≤6,144 tokens 留给模型；跨过预算的那个节点
 *   留在尾部里，所以窗口可能在预算内提前结束。
 * - V7-M1：surface 的前导系统节点（role=system，宿主 node 0 的系统提示词）不可被
 *   压缩替换。起点落在系统节点上时用 `firstReplaceableIndex` 推进到其后第一个
 *   非系统节点；推进后没有可替换节点则返回 `reason: 'no-replaceable-range'`。
 * - C120-H1：切口必须配平（累计 toolDelta 为 0）。起点推进到第一个配平切口、终点
 *   退到最后一个配平切口，尾部未结束的 tool-call 不进窗口；收缩后无区间返回
 *   `reason: 'unbalanced-boundary'`。
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

  // V7-M1：系统提示词所在的节点不可替换，起点必须落在它之后。
  startIdx = firstReplaceableIndex(snapshot, startIdx);
  if (startIdx >= seqs.length) return { region: null, reason: 'no-replaceable-range' };

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

  // 区间内也不包系统节点：遇到系统节点就提前收尾，它后面的内容留到下一轮
  // （下一轮 afterSeq 会落在它之前，再由 firstReplaceableIndex 跳过）。
  let stopIdx = endIdx;
  for (let index = startIdx; index <= endIdx; index += 1) {
    if (normalizeRole(records[index]?.role) === 'system') {
      stopIdx = index - 1;
      break;
    }
  }
  if (stopIdx < startIdx) {
    return { region: null, reason: 'no-replaceable-range', tailStartIdx };
  }

  // C120-H1：宿主只接受「累计 toolDelta 为 0」的切口。起点先跳过系统提示词，再
  // 推到第一个配平切口；终点退回最后一个配平切口（尾部未结束的 tool-call 留在
  // surface 里等结果）。两者都只收缩，丢了的内容留到下一轮，不会重复巩固。
  let alignedStart = startIdx;
  let alignedStop = stopIdx;
  for (;;) {
    const aligned = alignRegionToToolPairing(records, alignedStart, alignedStop);
    if (aligned === null) {
      return { region: null, reason: 'unbalanced-boundary', tailStartIdx };
    }
    const fenced = firstReplaceableIndex(snapshot, aligned.startIdx);
    if (fenced > aligned.endIdx) {
      return { region: null, reason: 'no-replaceable-range', tailStartIdx };
    }
    if (fenced === alignedStart && aligned.endIdx === alignedStop) break;
    alignedStart = fenced;
    alignedStop = aligned.endIdx;
  }
  startIdx = alignedStart;
  stopIdx = alignedStop;

  const lines = [];
  let tokens = 0;
  let missing = 0;
  for (let index = startIdx; index <= stopIdx; index += 1) {
    const record = records[index] ?? null;
    const text = typeof record?.text === 'string' ? record.text : '';
    if (record === null || record?.missing === true) missing += 1;
    if (text !== '') lines.push(`${record?.role ?? 'unknown'}: ${text}`);
    tokens += Number(nodes[index]?.tokens) || Number(record?.tokens) || 0;
  }

  return {
    region: {
      startIdx,
      endIdx: stopIdx,
      startSeq: seqs[startIdx],
      endSeq: seqs[stopIdx],
      tokens,
      count: stopIdx - startIdx + 1,
      text: lines.join('\n'),
      missing,
    },
    reason: 'ok',
    tailStartIdx,
  };
}

/**
 * V7-M1：从 `from` 起找到第一个可被压缩替换的节点下标。
 *
 * 宿主把 surface 节点 0 的系统提示词视为不可替换（`surface replace: node 0 holds
 * the system prompt ...`）。这里跳过 role=system 的前导节点，返回其后的第一个
 * 非系统节点；全部都是系统节点时返回 `seqs.length`。所有压缩调用点（常规巩固、
 * deep-sleep 与 pending 恢复后的 compactRegion）都必须先用它收紧起点。
 *
 * @param {{seqs: number[], records: object[]}} snapshot
 * @param {number} [from] 起始下标（含）；负数或非整数按 0 处理
 * @returns {number} 可替换节点下标，或 seqs.length 表示没有
 */
export function firstReplaceableIndex(snapshot, from = 0) {
  const seqs = Array.isArray(snapshot?.seqs) ? snapshot.seqs : [];
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const raw = Number(from);
  let index = Number.isInteger(raw) && raw > 0 ? raw : 0;
  for (; index < seqs.length; index += 1) {
    const role = normalizeRole(records[index]?.role);
    if (role === 'system') continue;
    // 节点 0 的位置本身受宿主保护；正文缺失（role 未知）时无法证明它不是系统
    // 提示词，保守跳过，宁可本轮不压缩也不触发 surface replace 报错。
    if (index === 0 && role === 'unknown') continue;
    return index;
  }
  return seqs.length;
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
   * @returns {{seq: number, role: string, text: string, tokens: number, toolDelta: number}|null}
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
    // C120-H1：宿主配平计数，供 planRegion / maybeCompact 选合法切口。
    return { seq, role, text, tokens, toolDelta: toolDeltaOf(event) };
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
   * C120-H1：这条索引记录缺哪些必需字段（空数组 = 完整）。
   * @param {object} entry
   * @returns {string[]}
   */
  function missingEntryFields(entry) {
    const absent = [];
    if (entry === null || typeof entry !== 'object') return [...REQUIRED_ENTRY_FIELDS];
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(entry, field)) absent.push(field);
    }
    return absent;
  }

  /**
   * @param {number[]} seqs
   * @param {object} state
   * @param {Map<number, object>|null} measured
   * @returns {{records: object[], nodes: object[], missing: number, incomplete: number}}
   */
  function build(seqs, state, measured) {
    const records = [];
    const nodes = [];
    let missing = 0;
    let incomplete = 0;
    for (const seq of seqs) {
      const stored = state.records.get(seq) ?? null;
      const priced = measured?.get(seq) ?? null;
      const tokens = Number(priced?.tokens ?? stored?.tokens ?? 0) || 0;
      const heuristicTokens = Number(priced?.heuristicTokens ?? stored?.tokens ?? 0) || 0;
      if (stored === null) missing += 1;
      else if (missingEntryFields(stored).length > 0) incomplete += 1;
      nodes.push({ seq, tokens, heuristicTokens });
      records.push(stored === null
        ? { seq, role: 'unknown', text: '', tokens, missing: true }
        : { ...stored, tokens, missing: false });
    }
    return { records, nodes, missing, incomplete };
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
    // 缺正文（missing）或缺配平字段（incomplete）都说明索引不可信：用
    // readSurface 全量重读一次，每会话在内存里最多一次（forceRebuild 可再强制）。
    const needRebuild = built.missing > 0 || built.incomplete > 0;
    const shouldRebuild = needRebuild && allowRebuild
      && (options.forceRebuild === true || state.rebuilt !== true);
    if (shouldRebuild) {
      try {
        await rebuild(session, { force: true });
        built = build(seqs, state, measured);
      } catch {
        // 回填失败就保留缺失标记，让调用方降级。
      }
    }
    return {
      seqs,
      nodes: built.nodes,
      records: built.records,
      missing: built.missing,
      incomplete: built.incomplete,
    };
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
