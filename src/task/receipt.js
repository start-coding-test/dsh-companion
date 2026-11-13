/**
 * 任务回执（05 §6.4、07 R-12）：≤300 字中文四要素——状态、结论、产物、耗时。
 *
 * 回执是 worker 唯一的对外产出通道（05 §6.4 / D9：worker 只读记忆、不写记忆），
 * 落库时写 `memory_events` 审计行（action=USED、actor=scheduler、
 * table_name=threads），正文放在 detail_json 里，与 Store 的真实列名对齐。
 */

/** 回执字数上限（05 §6.4：「≤300 字回执」）。 */
export const RECEIPT_MAX_CHARS = 300;

/** 产物区最多占用的字数（给结论留预算）。 */
const ARTIFACTS_BUDGET_MAX = 80;

/** 内部状态到中文的映射。 */
const STATUS_LABELS = Object.freeze({
  ok: '成功',
  timeout: '超时',
  partial: '部分完成',
  error: '失败',
});

/**
 * 生成一条 ≤300 字的中文回执。
 *
 * 四个要素始终保留；结论过长时截断并补「…」，产物过长时同样截断。
 *
 * @param {object} receipt
 * @param {string} receipt.status 'ok'|'timeout'|'partial'|'error'（其它值原样展示）
 * @param {string} [receipt.summary] 结论（一句话）
 * @param {Array<string|object>} [receipt.artifacts] 产物（路径或带 path/name 的对象）
 * @param {number} [receipt.durationMs] 耗时（毫秒）
 * @returns {string} 形如「状态：成功｜结论：…｜产物：…｜耗时：1.2s」
 */
export function formatReceipt(receipt = {}) {
  const {
    status,
    summary = '',
    artifacts = [],
    durationMs = 0,
  } = receipt;

  const statusText = STATUS_LABELS[status] ?? String(status ?? '未知');
  const durationText = formatDuration(durationMs);
  const artifactsText = joinArtifacts(artifacts);

  const head = `状态：${statusText}｜结论：`;
  const mid = '｜产物：';
  const tail = `｜耗时：${durationText}`;
  const fixed = charLength(head) + charLength(mid) + charLength(tail);
  const budgetTotal = Math.max(0, RECEIPT_MAX_CHARS - fixed);
  const artifactsBudget = Math.min(
    ARTIFACTS_BUDGET_MAX,
    Math.max(1, Math.floor(budgetTotal / 3)),
  );
  const shownArtifacts = artifactsText === ''
    ? '无'
    : truncate(artifactsText, artifactsBudget);
  const summaryBudget = Math.max(0, budgetTotal - charLength(shownArtifacts));
  const shownSummary = truncate(normalizeSummary(summary), summaryBudget) || '无';

  const text = `${head}${shownSummary}${mid}${shownArtifacts}${tail}`;
  // 兜底：预算计算有偏差时宁可截断结论也不越过 300 字（四要素仍在前缀里）。
  return charLength(text) > RECEIPT_MAX_CHARS
    ? truncate(text, RECEIPT_MAX_CHARS)
    : text;
}

/**
 * 把回执写入记忆库审计流（memory_events）。
 *
 * 卡片给的 `{scope, kind:'task_receipt', payload}` 在真实 Store 里不存在；
 * 这里映射成 `appendEvent()` 的真实形状，语义字段放 detail_json：
 * `{scope, kind:'task_receipt', taskId, status, text}`。
 *
 * @param {object} store Store 实例（appendEvent）
 * @param {object} receipt
 * @param {string} receipt.scope 'main' 或 'thread:<key>'
 * @param {string|number|null} [receipt.taskId] 任务包 id
 * @param {string} receipt.status 'ok'|'timeout'|'error'
 * @param {string} receipt.text formatReceipt() 的结果
 * @returns {number} memory_events 行 id
 */
export function writeReceipt(store, receipt = {}) {
  const {
    scope,
    taskId = null,
    status,
    text,
  } = receipt;
  if (store === null || typeof store !== 'object' || typeof store.appendEvent !== 'function') {
    throw new TypeError('[receipt] store must provide appendEvent()');
  }
  if (typeof scope !== 'string' || scope === '') {
    throw new TypeError('[receipt] scope must be a non-empty string');
  }
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('[receipt] text must be a non-empty string');
  }
  const rowId = taskId === null || taskId === undefined || taskId === '' ? null : String(taskId);
  const statusText = status === undefined || status === null ? 'unknown' : String(status);
  return store.appendEvent({
    action: 'USED',
    actor: 'scheduler',
    table_name: 'threads',
    row_id: rowId,
    reason: `task_receipt:${statusText}`,
    detail_json: {
      scope,
      kind: 'task_receipt',
      taskId: rowId,
      status: statusText,
      text,
    },
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSummary(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} artifacts
 * @returns {string}
 */
function joinArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return '';
  return artifacts
    .map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'object') {
        const path = item.path ?? item.name ?? item.label;
        if (typeof path === 'string' && path !== '') return path;
      }
      return String(item).trim();
    })
    .filter((item) => item !== '')
    .join('、');
}

/**
 * @param {unknown} durationMs
 * @returns {string}
 */
function formatDuration(durationMs) {
  const num = Number(durationMs);
  if (!Number.isFinite(num) || num <= 0) return '0ms';
  if (num < 1000) return `${Math.round(num)}ms`;
  if (num < 60_000) return `${(num / 1000).toFixed(1)}s`;
  const minutes = Math.floor(num / 60_000);
  const seconds = Math.round((num % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * 按 Unicode 码点计长度（中文 1 字算 1）。
 * @param {string} text
 * @returns {number}
 */
function charLength(text) {
  return Array.from(text).length;
}

/**
 * 超过预算时截断并补「…」；预算为 0 时返回空串。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars) {
  const chars = Array.from(text);
  if (maxChars <= 0) return '';
  if (chars.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}
