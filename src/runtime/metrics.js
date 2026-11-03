/**
 * 运行指标（07 §6 M1/M6/M12）：轻量计数器 + 快照。
 *
 * 约定：
 * - tokensIn / tokensOut / overBudget / recalls 是插件每轮会累加的计数器；
 * - rssMB 每次 snapshot 时从 process.memoryUsage() 现算，不缓存；
 * - inc 负责累加，observe 负责记录最近一次值（例如装配占用、召回耗时）；
 * - 未出现的指标补 0，调用方可以直接把 snapshot 写进日志/观测面。
 */

const REQUIRED_GAUGES = ['tokensIn', 'tokensOut', 'overBudget', 'recalls'];

/**
 * @param {{clock?: () => number}} [options]
 * @returns {{
 *   inc: (name: string, n?: number) => number,
 *   observe: (name: string, value: number) => number,
 *   snapshot: () => Record<string, number>
 * }}
 */
export function createMetrics({ clock = Date.now } = {}) {
  if (typeof clock !== 'function') {
    throw new TypeError('createMetrics: clock must be a function');
  }

  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, number>} */
  const observations = new Map();

  /**
   * 累加一个计数器；返回累加后的值。
   * @param {string} name
   * @param {number} [n=1]
   * @returns {number}
   */
  function inc(name, n = 1) {
    assertMetricName(name);
    if (!Number.isFinite(n)) {
      throw new TypeError('metrics.inc: n must be a finite number');
    }
    const next = (counters.get(name) ?? 0) + n;
    counters.set(name, next);
    return next;
  }

  /**
   * 记录一个最近值；返回该值。
   * @param {string} name
   * @param {number} value
   * @returns {number}
   */
  function observe(name, value) {
    assertMetricName(name);
    if (!Number.isFinite(value)) {
      throw new TypeError('metrics.observe: value must be a finite number');
    }
    observations.set(name, value);
    return value;
  }

  /**
   * 生成快照。必需字段恒存在；额外指标按 observe/inc 的名字补充。
   * @returns {Record<string, number>}
   */
  function snapshot() {
    const result = {};
    for (const name of REQUIRED_GAUGES) {
      result[name] = observations.get(name) ?? counters.get(name) ?? 0;
    }
    result.rssMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
    result.capturedAt = Number(clock());

    for (const [name, value] of observations) {
      if (!(name in result)) result[name] = value;
    }
    for (const [name, value] of counters) {
      if (!(name in result)) result[name] = value;
    }
    return result;
  }

  return { inc, observe, snapshot };
}

/** @param {unknown} name */
function assertMetricName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('metrics: name must be a non-empty string');
  }
}
