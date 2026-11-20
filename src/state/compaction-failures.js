/**
 * v0.7.7 C120-H2/L1：压缩失败的两次计数，都落在 `schema_meta` 里（持久化，重启后
 * `/状态` 仍能看到），两个口径互相独立：
 *
 * - **连续失败次数**（`compaction_failures:<scope>`）：只要有一次压缩成功就清零。
 *   只用于诊断展示，`/状态` 直接读它。
 * - **同一区间的尝试次数**（`compaction_attempts:<scope>` 存 `startSeq:endSeq:n`）：
 *   区间变了就重新从 1 数起。`maybeCompact` 用它决定是否放弃 pending：
 *   确定性错误（宿主判定边界不合法 / 压后不更小）第一次就丢弃，其余错误最多
 *   尝试 {@link MAX_COMPACTION_RETRIES} 次。
 *
 * 早期 Store 只有 setMeta 且要求非空串，清零只能写占位值 `'0'` / `''`；v0.7.7
 * C120-L1 起 Store 有 deleteMeta，清零优先删键（见 clearMetaKey），占位值只作为
 * 没有该方法的兜底。读取时把 0 与空串都当无值。
 */

/** 非确定性错误的尝试上限（含首次尝试）：达到即丢弃 pending，避免每 turn 重复失败。 */
export const MAX_COMPACTION_RETRIES = 3;

const FAILURES_PREFIX = 'compaction_failures:';
const LAST_ERROR_PREFIX = 'compaction_last_error:';
const ATTEMPTS_PREFIX = 'compaction_attempts:';

/**
 * 读连续压缩失败次数。
 * @param {object} store
 * @param {string} scope
 * @returns {number} 0 表示当前没有未恢复的失败
 */
export function readCompactionFailures(store, scope) {
  try {
    const raw = Number(store.getMeta(`${FAILURES_PREFIX}${scope}`));
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

/**
 * 读最后一条压缩失败错误原文（不截断，`/状态` 直接展示）。
 * @param {object} store
 * @param {string} scope
 * @returns {string|null}
 */
export function readCompactionLastError(store, scope) {
  try {
    const value = store.getMeta(`${LAST_ERROR_PREFIX}${scope}`);
    return typeof value === 'string' && value !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 记一次压缩失败：连续失败次数 +1，并覆盖最后一条错误原文。
 * @returns {number} 更新后的连续失败次数
 */
export function recordCompactionFailure(store, scope, message) {
  const next = readCompactionFailures(store, scope) + 1;
  try {
    store.setMeta(`${FAILURES_PREFIX}${scope}`, String(next));
    store.setMeta(`${LAST_ERROR_PREFIX}${scope}`, message === undefined || message === null
      ? ''
      : String(message));
  } catch {
    // 失败计数只是诊断信息，写不进去不影响压缩本身的处理。
  }
  return next;
}

/** 压缩成功后清连续失败计数：有 deleteMeta 就删键，否则退回写 0/空串。 */
export function clearCompactionFailures(store, scope) {
  clearMetaKey(store, `${FAILURES_PREFIX}${scope}`, '0');
  clearMetaKey(store, `${LAST_ERROR_PREFIX}${scope}`, '');
}

/**
 * 清一个诊断用的 meta 键。
 *
 * Store 的 setMeta 拒绝空字符串（requireString），写 `''` 会静默失败、旧值残留；
 * v0.7.7 C120-L1 因此给 Store 加了 deleteMeta，这里优先删键，没有该方法时
 * （测试替身等）退回写占位值。
 * @param {object} store
 * @param {string} key
 * @param {string} fallback
 */
function clearMetaKey(store, key, fallback) {
  try {
    if (store.getMeta(key) === null) return;
    if (typeof store.deleteMeta === 'function') {
      store.deleteMeta(key);
      return;
    }
    store.setMeta(key, fallback);
  } catch {
    // 诊断信息写失败可忽略。
  }
}

/**
 * 读当前区间已经尝试过几次（区间不同则视为 0）。
 * @returns {number}
 */
export function readCompactionAttempts(store, scope, startSeq, endSeq) {
  try {
    const raw = store.getMeta(`${ATTEMPTS_PREFIX}${scope}`);
    if (typeof raw !== 'string' || raw === '') return 0;
    const [start, end, count] = raw.split(':');
    if (Number(start) !== Number(startSeq) || Number(end) !== Number(endSeq)) return 0;
    const parsed = Number(count);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * 记一次尝试（区间变化即重新计数）。
 * @returns {number} 该区间累计尝试次数（含本次）
 */
export function recordCompactionAttempt(store, scope, startSeq, endSeq) {
  const next = readCompactionAttempts(store, scope, startSeq, endSeq) + 1;
  try {
    store.setMeta(`${ATTEMPTS_PREFIX}${scope}`, `${Number(startSeq)}:${Number(endSeq)}:${next}`);
  } catch {
    // 见上：计数失败不影响压缩流程。
  }
  return next;
}

/** 压缩成功后忘掉区间尝试计数。 */
export function clearCompactionAttempts(store, scope) {
  clearMetaKey(store, `${ATTEMPTS_PREFIX}${scope}`, '0:0:0');
}
