/**
 * 待压缩区间（N-M1）：每个 scope 一个槽，互不覆盖。
 *
 * v0.3.1 之前是全插件单槽 `state.pendingCompact`：线程巩固成功会盖掉 main 尚未
 * 压缩的区间，main 那段已入库却永远不会被压缩，上下文持续增长，最终撞上平台
 * 88K 自动压缩，再触发 N-H1（水位失效）。这里改为 `Map<scope, pending>`。
 *
 * pending 形状：`{ id: string|null, startSeq: number, endSeq: number, scope: string }`。
 */

/** @returns {Map<string, object>} */
export function createPendingCompacts() {
  return new Map();
}

/**
 * 登记某个 scope 的待压缩区间；同 scope 覆盖，跨 scope 互不影响。
 *
 * @param {Map<string, object>} map
 * @param {{id?: string|null, startSeq: number, endSeq: number, scope: string}} pending
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
  map.set(scope, {
    id: typeof pending.id === 'string' && pending.id !== '' ? pending.id : null,
    startSeq: Number(pending.startSeq),
    endSeq: Number(pending.endSeq),
    scope,
  });
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

/**
 * 重启后按 scope 恢复未完成的两段式压缩（只认 nap：deep 行的 upto_seq 是审计水位）。
 *
 * 每个 scope 只恢复最新一条 `status='written'` 的 nap 行；返回 Map，供 apply 时
 * 一次性灌入 state。跨 scope 的多个 pending 都能恢复，不再只恢复 main（N-M1）。
 *
 * @param {{db: {prepare: Function}}} store
 * @returns {Map<string, object>}
 */
export function recoverPendingCompacts(store) {
  const map = createPendingCompacts();
  if (store === null || store === undefined || store.db === undefined) return map;
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
