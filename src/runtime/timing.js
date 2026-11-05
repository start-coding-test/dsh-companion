/**
 * G0-9（v0.4.11）：压缩/巩固耗时观测。
 *
 * 设计约束：
 * - **只观测，不设硬超时、不中止任务**：耗时样本与告警都不改变主流程；
 * - 每次实际执行记录一份耗时（毫秒，失败样本同样记录，仅用于日志）；
 * - 单次样本严格大于阈值时写一条 warn；
 * - 同一类（compact / consolidate）在同一插件实例内只告警一次，直到出现
 *   一次不超过阈值的样本后重置，避免持续超时刷屏；
 * - 所有函数异常安全：计时或日志失败都返回 null，不影响压缩/巩固。
 *
 * 阈值来自 config.timing（压缩默认 20000ms、巩固默认 60000ms），对应真机
 * 验收口径 p95（压缩 ≤20s、巩固 ≤60s）。
 */

/**
 * 两类耗时样本在 state 上的字段名。
 * `label` 用于日志与阈值文案，`lastField` 保存最近一次毫秒数，
 * `warnedField` 保存「本轮超阈值是否已告警」的去重标记。
 */
export const TIMING_KINDS = Object.freeze({
  compact: Object.freeze({
    label: 'compaction',
    lastField: 'lastCompactMs',
    warnedField: 'compactSlowWarned',
  }),
  consolidate: Object.freeze({
    label: 'consolidation',
    lastField: 'lastConsolidateMs',
    warnedField: 'consolidateSlowWarned',
  }),
});

/**
 * 把输入规整为非负整数毫秒；非有限数字或负数返回 null。
 * 注意不能直接用 Number(value)：null/'' 会被转成 0。
 * @param {unknown} value
 * @returns {number|null}
 */
export function toDurationMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/**
 * 读取时钟（毫秒）。时钟本身抛错时返回 null，不影响调用方。
 * @param {(() => number)|number|undefined} clock
 * @returns {number|null}
 */
export function nowMs(clock) {
  try {
    const value = typeof clock === 'function' ? clock() : clock;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 计算 startedMs 到 clock() 的耗时（毫秒，四舍五入、非负）。
 * 任一时刻不可用或计时抛错时返回 null。
 * @param {(() => number)|number|undefined} clock
 * @param {number|null} startedMs
 * @returns {number|null}
 */
export function elapsedMs(clock, startedMs) {
  const started = toDurationMs(startedMs);
  if (started === null) return null;
  const finished = nowMs(clock);
  if (finished === null) return null;
  return Math.max(0, Math.round(finished - started));
}

/**
 * 秒级展示，保留 1 位小数（12.3s、72.4s）；无样本显示 —。
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatSeconds(ms) {
  const duration = toDurationMs(ms);
  if (duration === null) return '—';
  return `${(duration / 1000).toFixed(1)}s`;
}

/**
 * 阈值展示：20s（整数阈值不带 .0）、0.5s（小数阈值保留 1 位）。
 * @param {number} ms
 * @returns {string}
 */
export function formatThresholdSeconds(ms) {
  const text = (ms / 1000).toFixed(1);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}s`;
}

/**
 * /状态 展示值：超阈值时追加「（超阈值）」。
 * @param {number|null|undefined} ms
 * @param {number|null|undefined} warnMs
 * @returns {string}
 */
export function formatTimingValue(ms, warnMs) {
  const duration = toDurationMs(ms);
  if (duration === null) return '—';
  const text = `${(duration / 1000).toFixed(1)}s`;
  const threshold = toDurationMs(warnMs);
  if (threshold !== null && threshold > 0 && duration > threshold) return `${text}（超阈值）`;
  return text;
}

/**
 * 记录一次耗时样本，必要时写一条去重后的 warn。
 *
 * 去重规则：同类只告警一次；出现一次不超过阈值的样本后重置，之后再次
 * 超阈值会重新告警。失败样本同样记录最近耗时，但告警 meta 里带 ok:false
 * （仅用于日志；/状态 只展示毫秒数，不区分成功/失败）。
 *
 * @param {object|null} state 插件状态（需有 platform.log）
 * @param {'compact'|'consolidate'} kind
 * @param {number|null} durationMs
 * @param {{ok?: boolean, warnMs?: number, log?: Function}} [options]
 * @returns {{kind: string, durationMs: number, ok: boolean, over: boolean, warned: boolean}|null}
 */
export function recordTimingSample(state, kind, durationMs, { ok = true, warnMs, log } = {}) {
  try {
    const spec = TIMING_KINDS[kind];
    if (spec === undefined || state === null || typeof state !== 'object') return null;
    const duration = toDurationMs(durationMs);
    if (duration === null) return null;
    const succeeded = ok !== false;
    state[spec.lastField] = duration;

    const threshold = toDurationMs(warnMs);
    const over = threshold !== null && duration > threshold;
    if (!over) {
      // 低/等阈值样本：重置去重标记，下次超阈值重新告警。
      if (state[spec.warnedField] === true) state[spec.warnedField] = false;
      return { kind, durationMs: duration, ok: succeeded, over: false, warned: false };
    }

    const alreadyWarned = state[spec.warnedField] === true;
    state[spec.warnedField] = true;
    if (alreadyWarned) {
      return { kind, durationMs: duration, ok: succeeded, over: true, warned: false };
    }

    const message = `[dsh-companion] ${spec.label} took ${formatSeconds(duration)} (>${formatThresholdSeconds(threshold)})`;
    const meta = { kind, durationMs: duration, warnMs: threshold, ok: succeeded };
    try {
      const logger = typeof log === 'function' ? log : state.platform?.log;
      if (typeof logger === 'function') logger('warn', message, meta);
    } catch {
      // 日志失败不能影响压缩/巩固主流程。
    }
    return { kind, durationMs: duration, ok: succeeded, over: true, warned: true };
  } catch {
    return null;
  }
}

/**
 * /状态 的两行耗时展示（压缩、巩固）。无样本或字段缺失为 —。
 * @param {{lastCompactMs?: number|null, lastConsolidateMs?: number|null,
 *   compactWarnMs?: number, consolidateWarnMs?: number}} [timing]
 * @returns {string[]}
 */
export function formatTimingLines(timing) {
  const source = timing ?? {};
  return [
    `最近压缩耗时：${formatTimingValue(source.lastCompactMs, source.compactWarnMs)}`,
    `最近巩固耗时：${formatTimingValue(source.lastConsolidateMs, source.consolidateWarnMs)}`,
  ];
}
