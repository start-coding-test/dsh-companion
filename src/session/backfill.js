/**
 * H1-A（v0.7.17）：历史回填的**只读**选区与预演估算。
 *
 * 本模块全部是纯函数：不写库、不推进游标、不登记 pending、不改水位、不调模型。
 * 输出结构给 H1-B 执行层复用（每批带 start/end 的 seq 与位置、tokens、count）。
 *
 * 选区规则（glm H1-A 红线）：
 * - 「水位之前」严格按 seq 在 surface 中的**位置**（`indexOf`）比较，绝不按 seq
 *   数值大小——压缩后的替换节点追加在日志末尾，可见 seq 可能非单调；
 * - 起点先过 `firstReplaceableIndex`（跳过系统提示词/前导不可替换节点），再收缩
 *   到工具配对平衡切口；终点过 `alignRegionToToolPairing`，配平后为空则整批作废；
 * - 遇系统节点收尾；compact-checkpoint / 压缩摘要节点不可选，跳过。
 *
 * 宿主事实：`session.surface.nodes` 只有 seq（`node_modules/@deepseek-ai/dsh-agent/
 * src/runtime-types.ts` 的 `SessionSurface`），token 数来自 `tokenMeter.measure()`
 * 的 `nodes[].tokens`；两者都按 surface 位置排列。选区不依赖任何数组下标做游标，
 * 游标一律是 seq。
 */

import {
  alignRegionToToolPairing,
  firstReplaceableIndex,
} from './surface.js';

/** schema_meta 里回填状态的键前缀（H1-A 只读，不写）。 */
export const BACKFILL_META_PREFIX = 'compact_backfill:';

/**
 * 单批摘要节点的保守 token 上限。
 *
 * 这是**假定值**，不是宿主契约：宿主压缩后的摘要节点大小由模型决定，插件读不到它的
 * 预估值。预演用它给出「压后底」的上限（越小越乐观、越大越保守），刻意取偏大的
 * 2,048，避免把成本说小。真实值只有 H1-B 执行后实测。
 */
export const BACKFILL_SUMMARY_TOKENS_UPPER = 2048;

export const BACKFILL_MIN_CHUNK_TOKENS = 1024;
export const BACKFILL_MAX_CHUNK_TOKENS = 262_144;
export const BACKFILL_MIN_PER_DAY = 1;
export const BACKFILL_MAX_PER_DAY = 50;

/** 压缩摘要/检查点节点的正文标记（与 memory/consolidate.js:528 同一口径）。 */
const SUMMARY_MARKERS = Object.freeze([
  '<compacted-summary>',
  'automatically generated checkpoint',
]);

/**
 * 这条 surface 记录是不是压缩摘要 / 检查点节点。
 * @param {{text?: string}|null|undefined} record
 * @returns {boolean}
 */
export function isCompactSummaryNode(record) {
  const text = typeof record?.text === 'string' ? record.text : '';
  if (text === '') return false;
  for (const marker of SUMMARY_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

/**
 * @param {object|null|undefined} record
 * @returns {string} 归一化 role（未知返回 'unknown'）
 */
function roleOf(record) {
  const role = typeof record?.role === 'string' ? record.role.toLowerCase() : '';
  if (role === 'system' || role === 'developer' || role === 'user'
    || role === 'assistant' || role === 'tool') {
    return role;
  }
  return 'unknown';
}

/**
 * @param {object[]} nodes
 * @param {number} from 含
 * @param {number} to 含
 * @returns {number}
 */
function tokensBetween(nodes, from, to) {
  let total = 0;
  for (let index = from; index <= to; index += 1) {
    total += Number(nodes[index]?.tokens) || 0;
  }
  return total;
}

/**
 * 按位置选区：从游标之后、水位之前，切出若干连续原文区间。
 *
 * @param {{seqs?: number[], nodes?: object[], records?: object[]}} snapshot
 * @param {{
 *   watermarkSeq?: number|null,
 *   cursorSeq?: number|null,
 *   chunkTokens?: number,
 * }} [options]
 * @returns {{
 *   chunks: Array<{startIdx:number,endIdx:number,startSeq:number,endSeq:number,
 *                  tokens:number,count:number}>,
 *   reason: string,
 *   watermarkSeq: number|null,
 *   cursorSeq: number|null,
 *   nextCursorSeq: number|null,
 *   selectableTokens: number,
 *   watermarkIdx: number,
 * }}
 */
export function planBackfillChunks(snapshot, options = {}) {
  const seqs = Array.isArray(snapshot?.seqs) ? snapshot.seqs : [];
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  const chunkTokens = Number.isFinite(options.chunkTokens) && options.chunkTokens > 0
    ? Math.trunc(options.chunkTokens)
    : 32_768;
  // 显式 null/undefined 表示「没有水位」；不能走 Number(null)=0 的隐式转换。
  const rawWatermark = options.watermarkSeq;
  const watermarkSeq = rawWatermark === null || rawWatermark === undefined
    ? null
    : (Number.isFinite(Number(rawWatermark)) ? Number(rawWatermark) : null);
  const rawCursor = options.cursorSeq;
  const cursorSeq = rawCursor === null || rawCursor === undefined
    ? null
    : (Number.isFinite(Number(rawCursor)) ? Number(rawCursor) : null);

  const base = {
    chunks: [],
    reason: 'ok',
    watermarkSeq,
    cursorSeq,
    nextCursorSeq: cursorSeq,
    selectableTokens: 0,
    watermarkIdx: -1,
  };

  if (seqs.length === 0) return { ...base, reason: 'empty-surface' };
  // 「水位之前」是位置概念：用 indexOf 找水位所在位置，再比较位置大小。
  const watermarkIdx = watermarkSeq === null ? -1 : seqs.indexOf(watermarkSeq);
  if (watermarkSeq === null) return { ...base, reason: 'no-watermark' };
  if (watermarkIdx < 0) return { ...base, reason: 'stale-watermark' };
  base.watermarkIdx = watermarkIdx;

  let from = 0;
  if (cursorSeq !== null) {
    const at = seqs.indexOf(cursorSeq);
    if (at < 0) return { ...base, reason: 'stale-cursor' };
    from = at + 1;
  }
  if (from >= watermarkIdx) return { ...base, reason: 'watermark-before-cursor' };

  from = firstReplaceableIndex(snapshot, from);
  if (from >= watermarkIdx) return { ...base, reason: 'no-replaceable-range' };

  const chunks = [];
  let index = from;
  // terminal 只在真正无法继续时置位；budget/summary 只是本批结束，继续下一批。
  let terminal = null;
  while (index < watermarkIdx) {
    if (isCompactSummaryNode(records[index])) { index += 1; continue; }
    if (roleOf(records[index]) === 'system') { terminal = 'system-boundary'; break; }

    let endIdx = index;
    let tokens = 0;
    while (endIdx < watermarkIdx) {
      if (roleOf(records[endIdx]) === 'system') { terminal = 'system-boundary'; break; }
      if (isCompactSummaryNode(records[endIdx])) break;
      const nodeTokens = Number(nodes[endIdx]?.tokens) || 0;
      if (tokens > 0 && tokens + nodeTokens > chunkTokens) break;
      tokens += nodeTokens;
      endIdx += 1;
    }

    let lastIdx = endIdx - 1;
    if (lastIdx < index) { terminal = terminal ?? 'no-chunk'; break; }

    const aligned = alignRegionToToolPairing(records, index, lastIdx);
    if (aligned === null) { terminal = 'unbalanced-boundary'; break; }
    const fenced = firstReplaceableIndex(snapshot, aligned.startIdx);
    if (fenced > aligned.endIdx) { terminal = 'unbalanced-boundary'; break; }
    lastIdx = aligned.endIdx;

    const chunkTokensTotal = tokensBetween(nodes, fenced, lastIdx);
    if (chunkTokensTotal > 0) {
      chunks.push({
        startIdx: fenced,
        endIdx: lastIdx,
        startSeq: seqs[fenced],
        endSeq: seqs[lastIdx],
        tokens: chunkTokensTotal,
        count: lastIdx - fenced + 1,
      });
    }
    index = lastIdx + 1;
    if (terminal !== null) break;
  }
  if (chunks.length === 0) {
    return { ...base, reason: terminal ?? 'no-chunk' };
  }
  const last = chunks[chunks.length - 1];
  return {
    ...base,
    chunks,
    reason: terminal ?? 'ok',
    nextCursorSeq: last.endSeq,
    selectableTokens: chunks.reduce((sum, chunk) => sum + chunk.tokens, 0),
  };
}

/**
 * 预演估算：把选区换算成用户能核对的口径。
 *
 * - `reclaimableTokens`：水位之前、按批可回收的 tokens（= 各批之和）；
 * - `unreclaimableTokens`：水位位置之后的部分（本轮回填碰不到）；
 * - `floorUpperBound`：压后底的**理论上限** = 当前 surface tokens − 可回收 +
 *   每批摘要上限（{@link BACKFILL_SUMMARY_TOKENS_UPPER}）。摘要实际多大由模型决定，
 *   所以这是上限而不是预测；
 * - `modelCalls`：分项给出。每批固定 1 次巩固 + 1 次压缩摘要；巩固内的去重裁决
 *   视候选而定（0..1 次/批），本预演**不计入**，也不计失败重试。
 *
 * @param {{
 *   snapshot?: {seqs?: number[], nodes?: object[], records?: object[]},
 *   plan?: ReturnType<typeof planBackfillChunks>,
 *   chunkTokens?: number,
 * }} [input]
 * @returns {{
 *   totalTokens: number,
 *   reclaimableTokens: number,
 *   unreclaimableTokens: number,
 *   floorUpperBound: number,
 *   summaryTokensUpper: number,
 *   chunks: number,
 *   modelCalls: {consolidate:number, compact:number, total:number, dedupeJudge:string},
 * }}
 */
export function estimateBackfill(input = {}) {
  const snapshot = input.snapshot ?? {};
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const plan = input.plan ?? { chunks: [], watermarkIdx: -1 };
  const chunks = Array.isArray(plan.chunks) ? plan.chunks : [];
  const totalTokens = tokensBetween(nodes, 0, nodes.length - 1);
  const reclaimableTokens = chunks.reduce((sum, chunk) => sum + (Number(chunk.tokens) || 0), 0);
  const watermarkIdx = Number.isInteger(plan.watermarkIdx) ? plan.watermarkIdx : -1;
  const unreclaimableTokens = watermarkIdx >= 0 && watermarkIdx < nodes.length
    ? tokensBetween(nodes, watermarkIdx, nodes.length - 1)
    : 0;
  const summaryTokensUpper = chunks.length * BACKFILL_SUMMARY_TOKENS_UPPER;
  const remaining = Math.max(0, totalTokens - reclaimableTokens);
  return {
    totalTokens,
    reclaimableTokens,
    unreclaimableTokens,
    floorUpperBound: remaining + summaryTokensUpper,
    summaryTokensUpper,
    chunks: chunks.length,
    modelCalls: {
      consolidate: chunks.length,
      compact: chunks.length,
      total: chunks.length * 2,
      dedupeJudge: '未计入（巩固内去重裁决至多 1 次/批，视候选而定）',
    },
  };
}

/**
 * 读回填状态（只读；H1-A 不写任何 `compact_backfill:*`）。
 *
 * 键位约定给 H1-B 用：
 * - `compact_backfill:cursor:<scope>` 游标 seq（数字字符串）
 * - `compact_backfill:day:<scope>` 今日批次 JSON `{"date":"YYYY-MM-DD","count":n}`
 * - `compact_backfill:floor:<scope>` 最近一次压后底（tokens）
 *
 * @param {{getMeta?: Function}} store
 * @param {string} scope
 * @returns {{cursorSeq: number|null, todayCount: number, todayDate: string|null,
 *            lastFloor: number|null}}
 */
export function readBackfillState(store, scope) {
  const state = {
    cursorSeq: null,
    todayCount: 0,
    todayDate: null,
    lastFloor: null,
  };
  if (store === null || typeof store?.getMeta !== 'function') return state;
  const read = (suffix) => {
    try {
      return store.getMeta(`${BACKFILL_META_PREFIX}${suffix}:${scope}`);
    } catch {
      return null;
    }
  };
  const cursor = read('cursor');
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    const parsed = Number(cursor);
    if (Number.isFinite(parsed) && parsed >= 0) state.cursorSeq = parsed;
  }
  const day = read('day');
  if (typeof day === 'string' && day.trim() !== '') {
    try {
      const parsed = JSON.parse(day);
      const count = Number(parsed?.count);
      if (Number.isFinite(count) && count >= 0) state.todayCount = Math.trunc(count);
      if (typeof parsed?.date === 'string') state.todayDate = parsed.date;
    } catch {
      // 损坏按「没有批次记录」处理。
    }
  }
  const floor = read('floor');
  if (floor !== null && floor !== undefined && floor !== '') {
    const parsed = Number(floor);
    if (Number.isFinite(parsed) && parsed >= 0) state.lastFloor = parsed;
  }
  return state;
}
