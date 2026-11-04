/**
 * 安装自检的纯计算层（W3 / MVP）。
 *
 * 只做建议值计算与 YAML 渲染，不读环境、不写文件、不碰数据库，便于单测。
 * 计算口径见 docs/calibration.md；所有 token 值都是「建议值」，最终配置仍由
 * 用户复制/合并后生效，插件不会自动改 profile。
 */

/** 1 MiB，内存预算按二进制单位换算是为了与 `os.totalmem()` 的字节口径对齐。 */
const MIB = 1024 * 1024;

/** 1 GiB，RSS 三档阈值使用 GiB 口径（与 `src/runtime/budget.js` 一致）。 */
const GIB = 1024 * 1024 * 1024;

/** RSS 三档默认阈值（GiB），与 config.js 的 DEFAULTS 保持一致。 */
const DEFAULT_RSS_GIB = Object.freeze({ warn: 2.95, stop: 3, mainOnly: 3.15 });

/** 工作记忆硬上限（token）：再大的上下文也先按 32K 装配。 */
export const MAX_WORKING_MEMORY_TOKENS = 32000;

/** 压缩时保留的最近对话尾部（token），MVP 固定值。 */
export const RETAIN_TOKENS = 6144;

/** 平台未上报、也没有显式配置时的保守上下文窗口（tokens）。 */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128000;

/** 建议值里不随测量变化的固定项。 */
const FIXED = Object.freeze({
  idleMs: 30 * 60 * 1000,
  threadMaxActive: 6,
  threadIdleDays: 14,
  proactiveDailyCap: 3,
  purgeAfterDays: 7,
  quietStart: '23:00',
  quietEnd: '08:00',
  dbPath: './.data/companion.db',
});

/**
 * 向下取整到 1000 token；非有限值返回 0。
 * @param {number} value
 * @returns {number}
 */
function floorToThousand(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 1000) * 1000;
}

/**
 * 取有限正数；否则用 fallback。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * 当前进程的 IANA 时区；取不到时回退 UTC（Node 总会有值，这里只是兜底）。
 * @returns {string}
 */
function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 由内存预算给出 RSS 三档阈值建议（N-M3/W4-10）。
 *
 * 口径：`memoryBudget = min(userLimit, totalmem×0.75−512MiB)`，三档按预算比例
 * 缩放并封顶在默认 2.95/3.0/3.15GiB；4GiB 内存 → budget 2.5GiB → 2.2/2.4/2.6。
 * 保证严格递增（预算极小时每档至少 +0.01GiB），且不超过总内存 75% 的自检口径。
 * @param {number} memoryBudgetBytes
 * @returns {{rssWarnGiB: number, rssStopGiB: number, rssMainOnlyGiB: number}}
 */
export function suggestRssLimits(memoryBudgetBytes) {
  const budget = Number(memoryBudgetBytes);
  const defaults = {
    rssWarnGiB: DEFAULT_RSS_GIB.warn,
    rssStopGiB: DEFAULT_RSS_GIB.stop,
    rssMainOnlyGiB: DEFAULT_RSS_GIB.mainOnly,
  };
  if (!Number.isFinite(budget) || budget <= 0) return defaults;
  const budgetGiB = budget / GIB;
  const step = 0.01;
  const warn = Math.max(round2(Math.min(DEFAULT_RSS_GIB.warn, 0.88 * budgetGiB)), step);
  const stop = Math.max(round2(Math.min(DEFAULT_RSS_GIB.stop, 0.96 * budgetGiB)), round2(warn + step));
  const mainOnly = Math.max(
    round2(Math.min(DEFAULT_RSS_GIB.mainOnly, 1.04 * budgetGiB)),
    round2(stop + step),
  );
  return { rssWarnGiB: warn, rssStopGiB: stop, rssMainOnlyGiB: mainOnly };
}

/**
 * 保留两位小数（GiB）。
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 根据机器与模型上下文给出 16 个配置键的建议值，外加一个只用于提示的
 * `memoryBudget`（字节，不写入 YAML 键，避免成为未知配置项）。
 *
 * 公式：
 * - memoryBudget = min(userLimitBytes ?? ∞, totalmemBytes × 0.75 − 512MiB)，下限 0；
 * - workingMemoryTokens = min(32000, contextWindow × 0.25)，向下取整到 1000；
 * - compactAtTokens = round(0.75 × working)；
 * - compactHardTokens = min(round(1.25 × working), contextWindow × 0.6)；
 * - rssWarnGiB / rssStopGiB / rssMainOnlyGiB = 按 memoryBudget 缩放的三档
 *   （0.88×/0.96×/1.04×，封顶 2.95/3.0/3.15；4GiB 内存 → 2.2/2.4/2.6）；
 * - retainTokens / 线程 / 主动 / 安静时段 / 清退天数用 MVP 固定值。
 *
 * 注意：contextWindow 小于约 33K 时，按公式得到的 compactAt 可能低于
 * retainTokens，这属于「模型窗口太小、MVP 不推荐」的情况；calibration.md
 * 会给出告警，suggestConfig 本身仍按公式返回，方便调用方判断与提示。
 *
 * @param {{
 *   totalmemBytes?: number,
 *   rssBytes?: number,
 *   cpus?: number | unknown[],
 *   nodeVersion?: string,
 *   electronVersion?: string | null,
 *   contextWindowTokens?: number,
 *   userLimitBytes?: number,
 *   timezone?: string,
 * }} [measurement]
 * @returns {{
 *   memoryBudget: number,
 *   workingMemoryTokens: number,
 *   compactAtTokens: number,
 *   compactHardTokens: number,
 *   idleMs: number,
 *   retainTokens: number,
 *   threadMaxActive: number,
 *   threadIdleDays: number,
 *   proactiveDailyCap: number,
 *   quietStart: string,
 *   quietEnd: string,
 *   timezone: string,
 *   purgeAfterDays: number,
 *   dbPath: string,
 *   rssWarnGiB: number,
 *   rssStopGiB: number,
 *   rssMainOnlyGiB: number,
 * }}
 */
export function suggestConfig(measurement = {}) {
  const input = measurement && typeof measurement === 'object' ? measurement : {};
  const totalmemBytes = positiveNumber(input.totalmemBytes, 0);
  const contextWindow = positiveNumber(input.contextWindowTokens, FALLBACK_CONTEXT_WINDOW_TOKENS);

  const totalmemBudget = totalmemBytes > 0
    ? Math.floor(totalmemBytes * 0.75 - 512 * MIB)
    : 0;
  const rawUserLimit = typeof input.userLimitBytes === 'number' ? input.userLimitBytes : Number(input.userLimitBytes);
  const userLimit = Number.isFinite(rawUserLimit) && rawUserLimit >= 0
    ? rawUserLimit
    : Number.POSITIVE_INFINITY;
  const memoryBudget = Math.max(0, Math.floor(Math.min(userLimit, totalmemBudget)));

  const workingMemoryTokens = Math.max(
    1000,
    floorToThousand(Math.min(MAX_WORKING_MEMORY_TOKENS, contextWindow * 0.25)),
  );
  const compactAtTokens = Math.round(workingMemoryTokens * 0.75);
  const compactHardTokens = Math.min(
    Math.round(workingMemoryTokens * 1.25),
    Math.round(contextWindow * 0.6),
  );

  const timezone = typeof input.timezone === 'string' && input.timezone.trim() !== ''
    ? input.timezone.trim()
    : defaultTimeZone();
  const rss = suggestRssLimits(memoryBudget);

  return {
    memoryBudget,
    workingMemoryTokens,
    compactAtTokens,
    compactHardTokens,
    idleMs: FIXED.idleMs,
    retainTokens: RETAIN_TOKENS,
    threadMaxActive: FIXED.threadMaxActive,
    threadIdleDays: FIXED.threadIdleDays,
    proactiveDailyCap: FIXED.proactiveDailyCap,
    quietStart: FIXED.quietStart,
    quietEnd: FIXED.quietEnd,
    timezone,
    purgeAfterDays: FIXED.purgeAfterDays,
    dbPath: FIXED.dbPath,
    rssWarnGiB: rss.rssWarnGiB,
    rssStopGiB: rss.rssStopGiB,
    rssMainOnlyGiB: rss.rssMainOnlyGiB,
  };
}

/**
 * 单行注释安全化：去掉换行、控制字符与注释分隔后的空白，避免 provenance
 * 里的外部字符串破坏 YAML 结构。
 * @param {unknown} value
 * @returns {string}
 */
function commentValue(value) {
  return String(value ?? 'unknown')
    .replace(/[\r\n\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || 'unknown';
}

/**
 * YAML 字符串标量：用 JSON 双引号形式，天然转义反斜杠/引号/换行。
 * @param {unknown} value
 * @returns {string}
 */
function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * YAML 数字标量：保留两位小数，非正/非法值退回 fallback。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {string}
 */
function yamlNumber(value, fallback) {
  const number = Number(value);
  const base = Number.isFinite(number) && number > 0 ? number : fallback;
  return String(Math.round(base * 100) / 100);
}

/**
 * 渲染建议配置 YAML。输出只包含 `src/config.js` 认识的 16 个键；
 * `memoryBudget` 作为注释展示，因为它是内存预算提示，不是配置项。
 *
 * @param {ReturnType<typeof suggestConfig>} suggested
 * @param {{
 *   generatedAt?: string,
 *   node?: string,
 *   electron?: string | null,
 *   dsh?: string | null,
 *   rssMedianBytes?: number,
 *   totalmemBytes?: number,
 *   cpus?: number | unknown[],
 *   contextWindowTokens?: number,
 * }} [provenance]
 * @returns {string}
 */
export function renderSuggestedYaml(suggested, provenance = {}) {
  const value = suggested && typeof suggested === 'object' ? suggested : {};
  const meta = provenance && typeof provenance === 'object' ? provenance : {};
  const generatedAt = meta.generatedAt ?? new Date().toISOString();
  const node = commentValue(meta.node ?? process.version);
  const electron = commentValue(meta.electron ?? 'n/a');
  const dsh = commentValue(meta.dsh ?? 'unknown');
  const rssMedianBytes = positiveNumber(meta.rssMedianBytes, 0);
  const totalmemBytes = positiveNumber(meta.totalmemBytes, 0);
  const cpus = Array.isArray(meta.cpus) ? meta.cpus.length : Number(meta.cpus);
  const cpuCount = Number.isFinite(cpus) && cpus > 0 ? Math.round(cpus) : 'unknown';
  const contextWindow = positiveNumber(meta.contextWindowTokens, FALLBACK_CONTEXT_WINDOW_TOKENS);
  const memoryBudget = Number.isFinite(value.memoryBudget) ? value.memoryBudget : 0;
  const rssDefaults = suggestRssLimits(memoryBudget);

  const lines = [
    '# dsh-companion 建议配置（calibration 生成，未自动合并）',
    `# generated_at: ${commentValue(generatedAt)}`,
    `# source: node ${node} / electron ${electron} / dsh ${dsh} / rss_median ${rssMedianBytes} bytes`,
    `# measured: totalmem ${totalmemBytes} bytes / cpus ${cpuCount} / contextWindow ${contextWindow} tokens`,
    `# memoryBudget: ${memoryBudget} bytes (advisory: min(user_limit, totalmem*0.75 - 512MiB))`,
    '# 使用方式：人工核对后，把需要的键复制到 config.yml；本文件不会自动生效。',
    '',
    `workingMemoryTokens: ${Number(value.workingMemoryTokens) || 0}`,
    `compactAtTokens: ${Number(value.compactAtTokens) || 0}`,
    `compactHardTokens: ${Number(value.compactHardTokens) || 0}`,
    `idleMs: ${Number(value.idleMs) || 0}`,
    `retainTokens: ${Number(value.retainTokens) || 0}`,
    '',
    '# RSS 三档（GiB）：0 < warn < stop < mainOnly，按 memoryBudget 建议，勿超过总内存 75%',
    `rssWarnGiB: ${yamlNumber(value.rssWarnGiB, rssDefaults.rssWarnGiB)}`,
    `rssStopGiB: ${yamlNumber(value.rssStopGiB, rssDefaults.rssStopGiB)}`,
    `rssMainOnlyGiB: ${yamlNumber(value.rssMainOnlyGiB, rssDefaults.rssMainOnlyGiB)}`,
    '',
    `threadMaxActive: ${Number(value.threadMaxActive) || 0}`,
    `threadIdleDays: ${Number(value.threadIdleDays) || 0}`,
    `proactiveDailyCap: ${Number(value.proactiveDailyCap) || 0}`,
    `quietStart: ${yamlString(value.quietStart ?? FIXED.quietStart)}`,
    `quietEnd: ${yamlString(value.quietEnd ?? FIXED.quietEnd)}`,
    `timezone: ${yamlString(value.timezone ?? defaultTimeZone())}`,
    `purgeAfterDays: ${Number(value.purgeAfterDays) || 0}`,
    `dbPath: ${yamlString(value.dbPath ?? FIXED.dbPath)}`,
    '',
  ];
  return lines.join('\n');
}
