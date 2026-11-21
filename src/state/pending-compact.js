/**
 * 待压缩区间（N-M1）：每个 scope 一个槽，互不覆盖。
 *
 * v0.3.1 之前是全插件单槽 `state.pendingCompact`：线程巩固成功会盖掉 main 尚未
 * 压缩的区间，main 那段已入库却永远不会被压缩，上下文持续增长，最终撞上平台
 * 88K 自动压缩，再触发 N-H1（水位失效）。这里改为 `Map<scope, pending>`。
 *
 * pending 形状：`{ id: string|null, startSeq: number, endSeq: number, scope: string,
 * tokens?: number, accumulating?: true }`。
 *
 * v0.7.10（D21-M1）：真机上闲聊每轮巩固区间都很小（1K 上下），旧逻辑在
 * `belowCompactMinRegion` 命中时**不登记** pending，而水位照推 —— 那一段就永远
 * 不会被插件压缩，插件压缩基本停摆。现在小区间也登记为 `accumulating:true` 的
 * pending（`tokens` 累计），等下一次巩固区间与之相邻时合并，累计到
 * `compactMinRegionTokens` 才真正压缩。
 *
 * 累积状态必须跨重启保留：`pending_compact:<scope>` 写进 `schema_meta`
 * （store.setMeta/deleteMeta，v0.7.7 C120-L1 已提供 deleteMeta），不新增表、不动
 * SCHEMA_VERSION（仍 16）。
 */

/** `schema_meta` 里累积 pending 的键前缀。 */
export const PENDING_COMPACT_META_PREFIX = 'pending_compact:';

/** @returns {Map<string, object>} */
export function createPendingCompacts() {
  return new Map();
}

/**
 * 归一化 token 计数：非法/负数按 0（未知也按 0，只影响何时够大，不影响正确性）。
 * @param {unknown} value
 * @returns {number}
 */
function normalizeTokens(value) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.trunc(tokens);
}

/**
 * 登记某个 scope 的待压缩区间；同 scope 覆盖，跨 scope 互不影响。
 *
 * `tokens` / `accumulating` 只在调用方给出时才写进形状（历史调用方与从
 * consolidations 表恢复的行保持旧的三字段形状，`deepEqual` 断言不受影响）。
 *
 * @param {Map<string, object>} map
 * @param {{id?: string|null, startSeq: number, endSeq: number, scope: string,
 *   tokens?: number, accumulating?: boolean}} pending
 * @returns {Map<string, object>}
 */
export function setPendingCompact(map, pending) {
  if (!(map instanceof Map)) throw new TypeError('setPendingCompact: map must be a Map');
  if (pending === null || typeof pending !== 'object') {
    throw new TypeError('setPendingCompact: pending must be an object');
  }
  const { scope } = pending;
  if (typeof scope !== 'string' || scope === '') {
    throw new TypeError('setPendingCompact: pending.scope must be a non-empty string');
  }
  const entry = {
    id: typeof pending.id === 'string' && pending.id !== '' ? pending.id : null,
    startSeq: Number(pending.startSeq),
    endSeq: Number(pending.endSeq),
    scope,
  };
  if (pending.tokens !== undefined) entry.tokens = normalizeTokens(pending.tokens);
  if (pending.accumulating === true) entry.accumulating = true;
  map.set(scope, entry);
  return map;
}

/**
 * 读取但不消费某个 scope 的待压缩区间。
 *
 * @param {Map<string, object>} map
 * @param {string} scope
 * @returns {object|null}
 */
export function peekPendingCompact(map, scope) {
  if (!(map instanceof Map)) return null;
  return map.get(scope) ?? null;
}

/**
 * 取出并清空某个 scope 的待压缩区间（压缩失败时调用方要写回）。
 *
 * @param {Map<string, object>} map
 * @param {string} scope
 * @returns {object|null}
 */
export function takePendingCompact(map, scope) {
  if (!(map instanceof Map)) return null;
  const pending = map.get(scope) ?? null;
  map.delete(scope);
  return pending;
}

/** `schema_meta` 键名：每个 scope 一个。 */
export function pendingCompactMetaKey(scope) {
  return `${PENDING_COMPACT_META_PREFIX}${scope}`;
}

/**
 * 把 pending 累积状态落到 `schema_meta`（v0.7.10 D21-M1：重启后不丢）。
 *
 * 只写元数据（seq 与 token 数），不含任何正文；失败返回 false（调用方只 warn）。
 *
 * @param {{setMeta?: Function}} store
 * @param {object} pending
 * @returns {boolean}
 */
export function persistPendingCompact(store, pending) {
  if (store === null || store === undefined || typeof store.setMeta !== 'function') return false;
  if (pending === null || typeof pending !== 'object') return false;
  const scope = typeof pending.scope === 'string' ? pending.scope : '';
  if (scope === '') return false;
  try {
    store.setMeta(pendingCompactMetaKey(scope), JSON.stringify({
      id: typeof pending.id === 'string' && pending.id !== '' ? pending.id : null,
      startSeq: Number(pending.startSeq),
      endSeq: Number(pending.endSeq),
      tokens: normalizeTokens(pending.tokens),
      accumulating: pending.accumulating === true,
      scope,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉某个 scope 的累积状态（压缩成功 / 区间失效 / 丢弃后调用）。
 * @param {{deleteMeta?: Function}} store
 * @param {string} scope
 * @returns {boolean}
 */
export function clearPersistedPendingCompact(store, scope) {
  if (store === null || store === undefined || typeof store.deleteMeta !== 'function') return false;
  if (typeof scope !== 'string' || scope === '') return false;
  try {
    store.deleteMeta(pendingCompactMetaKey(scope));
    return true;
  } catch {
    return false;
  }
}

/**
 * 重启后按 scope 恢复未完成的两段式压缩。
 *
 * 口径（v0.7.10 起）：
 * 1. 先读 `schema_meta` 里的 `pending_compact:<scope>`——这是**累积中**的区间，
 *    带 tokens，优先采信（D21-M1：重启不丢累积状态）；
 * 2. 再按 consolidations 表补齐没有 meta 的 scope（legacy / meta 写失败），
 *    只认 nap：deep 行的 upto_seq 是审计水位。
 *
 * 每个 scope 只恢复一条，跨 scope 的多个 pending 都能恢复（N-M1）。
 *
 * @param {{db: {prepare: Function}, getMeta?: Function}} store
 * @returns {Map<string, object>}
 */
export function recoverPendingCompacts(store) {
  const map = createPendingCompacts();
  if (store === null || store === undefined || store.db === undefined) return map;

  try {
    const rows = store.db.prepare(
      `SELECT key, value FROM schema_meta WHERE key LIKE '${PENDING_COMPACT_META_PREFIX}%'`,
    ).all();
    for (const row of rows) {
      const key = typeof row.key === 'string' ? row.key : '';
      if (key === '') continue;
      const scope = key.slice(PENDING_COMPACT_META_PREFIX.length);
      if (scope === '') continue;
      let parsed = null;
      try {
        parsed = JSON.parse(String(row.value));
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') continue;
      const startSeq = Number(parsed.startSeq);
      const endSeq = Number(parsed.endSeq);
      if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) continue;
      setPendingCompact(map, {
        id: typeof parsed.id === 'string' && parsed.id !== '' ? parsed.id : null,
        startSeq,
        endSeq,
        scope,
        tokens: parsed.tokens,
        accumulating: parsed.accumulating === true,
      });
    }
  } catch {
    // meta 读失败时退到 consolidations 表；不影响启动。
  }

  const rows = store.db.prepare(
    `SELECT scope, id, upto_seq, turn_from, compaction_start_seq
       FROM consolidations
      WHERE status = 'written' AND kind = 'nap'
      ORDER BY started_at DESC, rowid DESC`,
  ).all();
  for (const row of rows) {
    const scope = typeof row.scope === 'string' ? row.scope : '';
    if (scope === '' || map.has(scope)) continue;
    const endSeq = Number(row.upto_seq);
    const startSeq = Number(row.compaction_start_seq ?? row.turn_from ?? endSeq);
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) continue;
    map.set(scope, {
      id: typeof row.id === 'string' && row.id !== '' ? row.id : null,
      startSeq,
      endSeq,
      scope,
    });
  }
  return map;
}
