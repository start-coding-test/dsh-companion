/**
 * 用户可见命令（05 §4.5、06 §10）：/记忆、/成本、/线程、/状态。
 *
 * 设计约束：
 * - 只读写注入的 Store，不直接持有全局单例，便于测试与后续多会话接线；
 * - 所有 SQL 都走 store.db 的参数绑定（store.js 未提供按 kind 计数等聚合方法，
 *   因此这里只做只读聚合；显式遗忘统一走 memory/forget.js 的 forgetMemory，
 *   命令层不再直接调用 forgetFact/deleteFact）；
 * - 未知命令返回 { handled: false }，由调用方决定是否交给模型；
 * - 命令回复是给人看的短文本，不塞 JSON。
 *
 * V3-L3：平台命令名必须是 ASCII（`dsh-commands/lib/index.js:78` 的
 * `^[a-z][a-z0-9_-]*$`），用户直接输入 `/记忆` 不会进入命令分发，而会当普通
 * 文本发给模型。`chineseCommandHint()` / `commandHintMessage()` 供 pre-step
 * 识别这种误输入并用一句提示把用户导到 ASCII 命令名。
 */

import { randomUUID } from 'node:crypto';
import { describeAssembly, displaySectionName } from '../persona/assembly-record.js';

import { forgetMemory } from '../memory/forget.js';
import { describe } from '../persona/emotion.js';
import { DAILY_TOKEN_LIMIT } from './budget.js';
import { formatTimingLines } from './timing.js';
import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  zonedDayKey,
  zonedParts,
  zonedStartOfDay,
  zonedStartOfMonth,
} from '../time.js';

const MEMORY_COMMANDS = new Set(['记忆', '成本', '线程', '状态']);
const MAX_FORGET = 5;
const RSS_LEVEL_NAMES = Object.freeze(['ok', 'warn', 'stop_dispatch', 'main_only']);

/** C5-L1：/线程 与 /状态 共用的「宿主没有线程能力」提示（V7-H1：工具仍注册）。 */
const THREADS_UNSUPPORTED_TEXT = '线程：宿主不支持（无 sessionController，线程工具调用返回 capability_missing）';

/** C5-M1：/状态 的压缩开关文案；undefined 表示调用方未提供能力位（不显示）。 */
const COMPACTION_DISABLED_TEXT = '压缩：宿主未开启（compaction-basic 未启用）';
const COMPACTION_ENABLED_TEXT = '压缩：宿主已开启（compaction-basic 已启用）';

/** V3-L3：宿主只注册 ASCII 命令名，给误输入中文命令的用户一句固定提示。 */
export const CHINESE_COMMAND_HINT = '请用 /memory、/status、/cost、/threads';

/** V3-L3：会被 pre-step 识别为「中文命令误输入」的前缀。 */
const CHINESE_COMMAND_PREFIXES = Object.freeze(['/记忆', '/状态', '/成本', '/线程']);

/** V3-L3：提示注入消息的 source.kind，便于转录/巩固与普通用户发言区分。 */
export const COMMAND_HINT_SOURCE_KIND = 'companion-command-hint';

/**
 * 识别用户误输入的中文命令。
 *
 * 只按前缀判断（`/记忆`、`/状态`、`/成本`、`/线程`），不解析参数；返回的是
 * 给用户看的 ASCII 命令提示，不是该命令的执行结果。识别不到返回 null。
 *
 * @param {unknown} text 用户输入
 * @returns {string|null}
 */
export function chineseCommandHint(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trimStart();
  return CHINESE_COMMAND_PREFIXES.some((prefix) => raw.startsWith(prefix))
    ? CHINESE_COMMAND_HINT
    : null;
}

/**
 * 为误输入的中文命令构造 pre-step 注入消息（完整平台消息，V3-H1 形状）。
 *
 * 平台把 pre-step 的 `decision.messages` 逐条当 user/message 追加
 * （`dsh-agent-loop/lib/index.js:1067`），因此必须是 `{id, role, content,
 * source}` 而不是裸内容块。消息本身是给模型的一句指令：用固定提示回复用户。
 * 接线层只在本轮（turn）第一次 pre-step 时调用一次，避免每 step 重复注入。
 *
 * @param {unknown} text 用户输入
 * @returns {{id: string, role: 'user', content: object[], source: object}|null}
 */
export function commandHintMessage(text) {
  const hint = chineseCommandHint(text);
  if (hint === null) return null;
  const raw = String(text).trimStart();
  const prefix = CHINESE_COMMAND_PREFIXES.find((item) => raw.startsWith(item));
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `宿主只注册 ASCII 命令名，${prefix} 不会被执行。请直接回复用户一句：${hint}`,
    }],
    source: { kind: COMMAND_HINT_SOURCE_KIND },
  };
}

/**
 * 解析并执行一条用户命令。
 *
 * @param {object} options
 * @param {string} options.text 原始输入
 * @param {import('../memory/store.js').Store} options.store
 * @param {number|Date} options.now 毫秒时间戳或 Date（由接线层注入）
 * @param {string} [options.scope='main'] 作用域
 * @param {object} [options.metrics] createMetrics() 句柄；/状态 用它显示本轮 token
 * @param {string} [options.timeZone=DEFAULT_TIMEZONE] 日期/日界线所用 IANA 时区
 * @param {{dailyTokens?: number, dailyLimit?: number, tripped?: boolean,
 *   rssLevel?: string, rssLevelCode?: number, rssMB?: number,
 *   rssLimits?: {warnGiB?: number, stopGiB?: number, mainOnlyGiB?: number}}} [options.budget] M4 预算/RSS 快照
 * @param {boolean} [options.threadsSupported] H3②：宿主是否提供 sessionController
 *   （V7-H1：由接线层在每次命令调用时读取，不用 apply 时快照）；false 时
 *   /状态 明确显示「线程：宿主不支持」
 * @param {{id?: string|null, binding?: string}} [options.mainSession] V3-M2：
 *   当前主会话 id 与绑定模式（latest-user / first），/状态 展示用
 * @param {boolean} [options.compactionSupported] C5-M1：宿主是否提供
 *   compaction.compactRegion（compaction-basic）；false 时 /状态 明确提示
 * @param {number} [options.pendingCompactions] C5-M1：待压缩区间数（仅展示用）
 * @param {string|null} [options.threadAgentPreset] V10-H1：thread.agentPreset
 *   配置值；null/空串时 /状态 显示「宿主默认」
 * @param {{lastCompactMs?: number|null, lastConsolidateMs?: number|null,
 *   compactWarnMs?: number, consolidateWarnMs?: number}} [options.timing]
 *   G0-9：最近一次压缩/巩固耗时与阈值；传入时 /状态 追加两行耗时
 * @param {{mode?: string}} [options.shadow] P2：部署人设遮蔽状态；不传时
 *   /状态 不输出「部署人设」行（旧调用方格式不变）
 * @returns {{handled: boolean, reply: string}}
 */
export function handleCommand({
  text,
  store,
  now,
  scope = 'main',
  metrics,
  timeZone = DEFAULT_TIMEZONE,
  budget,
  threadsSupported,
  mainSession,
  compactionSupported,
  pendingCompactions,
  threadAgentPreset,
  timing,
  persona,
  shadow,
  emotion,
  assembly,
} = {}) {
  if (typeof text !== 'string') return { handled: false, reply: '' };
  const raw = text.trim();
  if (!raw.startsWith('/')) return { handled: false, reply: '' };

  const body = raw.slice(1).trim();
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { handled: false, reply: '' };

  const command = parts[0];
  if (!MEMORY_COMMANDS.has(command)) return { handled: false, reply: '' };
  if (store === null || store === undefined) {
    throw new TypeError('[commands] store is required');
  }
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError(`[commands] unknown IANA time zone "${String(timeZone)}"`);
  }

  if (command === '记忆') {
    return handleMemoryCommand(parts.slice(1), { store, now, scope });
  }
  if (command === '成本') {
    const summary = summarizeCost(store, now, timeZone);
    return { handled: true, reply: formatCost(summary, budget) };
  }
  if (command === '线程') {
    // C5-L1：宿主没有线程能力时与 /状态 用同一句提示，不返回空目录、不抛错。
    if (threadsSupported === false) return { handled: true, reply: THREADS_UNSUPPORTED_TEXT };
    return { handled: true, reply: formatThreads(store.listThreads({ limit: 100 }), timeZone) };
  }
  return {
    handled: true,
    reply: formatStatus(store, scope, metrics, timeZone, budget, {
      threadsSupported,
      mainSession,
      compactionSupported,
      pendingCompactions,
      threadAgentPreset,
      timing,
      persona,
      shadow,
      emotion,
      // V50-L3：最近一次装配（只含字数与短哈希，见 persona/assembly-record.js）。
      assembly,
      now: toMillis(now),
    }),
  };
}

/**
 * 今日/本月 token 汇总。
 *
 * 数据源按 t11 卡：memory_events.detail_json 里的 tokensIn/tokensOut
 * （也兼容 tokens_in/tokens_in 与 input/output 命名）。没有 token 字段的
 * 事件不计入。返回结构固定为 {today, month}，各自 {tokensIn, tokensOut, total}。
 *
 * @param {object} store
 * @param {number|Date} now 毫秒时间戳或 Date（由接线层注入）
 * @param {string} [timeZone=DEFAULT_TIMEZONE] 日界线所用 IANA 时区
 * @returns {{today: {tokensIn:number,tokensOut:number,total:number},
 *            month: {tokensIn:number,tokensOut:number,total:number}}}
 */
export function summarizeCost(store, now, timeZone = DEFAULT_TIMEZONE) {
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError(`[commands] unknown IANA time zone "${String(timeZone)}"`);
  }
  const at = toMillis(now);
  const dayStart = zonedStartOfDay(at, timeZone);
  const monthStart = zonedStartOfMonth(at, timeZone);
  const rows = listTokenEvents(store, Math.floor(monthStart / 1000));

  const today = emptyCost();
  const month = emptyCost();
  for (const row of rows) {
    const parts = tokenParts(parseDetail(row.detail_json));
    addCost(month, parts);
    if (toMillis(row.at) >= dayStart) addCost(today, parts);
  }
  return { today, month };
}

// ------------------------------------------------------------- 记忆

/**
 * @param {string[]} args `/记忆` 之后的词
 * @param {{store: object, now: number|Date, scope: string}} ctx
 * @returns {{handled: boolean, reply: string}}
 */
function handleMemoryCommand(args, ctx) {
  if (args.length === 0) {
    return { handled: true, reply: formatMemorySummary(ctx.store, ctx.scope) };
  }

  const sub = args[0];
  if (sub === '忘掉' || sub === '彻底忘掉') {
    const immediate = sub === '彻底忘掉';
    const rest = args.slice(1);
    const confirmed = rest.length > 0 && rest[rest.length - 1] === '确认';
    const target = (confirmed ? rest.slice(0, -1) : rest).join(' ').trim();
    if (target === '') {
      return { handled: true, reply: `用法：/记忆 ${sub} <id|关键词>${immediate ? ' [确认]' : ''}` };
    }
    return {
      handled: true,
      reply: forgetReply(ctx, target, { immediate, confirm: confirmed }),
    };
  }

  if (sub === '置顶' || sub === '取消置顶') {
    const id = args[1];
    if (!id) {
      return {
        handled: true,
        reply: `用法：/记忆 ${sub} <id>`,
      };
    }
    return { handled: true, reply: setPinned(ctx.store, id, sub === '置顶') };
  }

  // 未知子命令按未知输入处理，避免把模型该处理的话吞掉。
  return { handled: false, reply: '' };
}

/**
 * 按 kind 统计事实并给出置顶数。
 * @param {object} store
 * @param {string} scope
 * @returns {string}
 */
function formatMemorySummary(store, scope) {
  const counts = factCounts(store, scope);
  if (counts.total === 0) return '记忆：暂无事实（置顶 0 条）。';

  const kinds = Object.entries(counts.byKind)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(' / ');
  return `记忆：${counts.total} 条事实（${kinds}），置顶 ${counts.pinned} 条。`;
}

/**
 * @param {object} store
 * @param {string} scope
 * @returns {{total:number, pinned:number, byKind:Record<string, number>}}
 */
function factCounts(store, scope) {
  if (hasDb(store)) {
    const rows = store.db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM facts
          WHERE scope = ? AND deleted_at IS NULL AND status <> 'tombstoned'
          GROUP BY kind ORDER BY kind ASC`,
      )
      .all(scope);
    const pinnedRow = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM facts
          WHERE scope = ? AND deleted_at IS NULL AND status <> 'tombstoned'
            AND salience = 'pinned'`,
      )
      .get(scope);
    const byKind = {};
    let total = 0;
    for (const row of rows) {
      const n = Number(row.n);
      byKind[row.kind] = n;
      total += n;
    }
    return { total, pinned: Number(pinnedRow?.n ?? 0), byKind };
  }

  // 兼容只有 Store 公共 API 的假实现（测试/外部调用）。
  const facts = store.listFacts({ scope, limit: 1000 });
  const byKind = {};
  let pinned = 0;
  for (const fact of facts) {
    byKind[fact.kind] = (byKind[fact.kind] ?? 0) + 1;
    if (fact.salience === 'pinned') pinned += 1;
  }
  return { total: facts.length, pinned, byKind };
}

/**
 * 命令层遗忘入口：id 直接走 forgetMemory；否则按关键词找 active 事实。
 * 显式遗忘的 S1 / 状态板清洗 / 物删（可选）全部在 memory/forget.js 内完成；
 * 命令层不传 llm，因此定向巩固在命令路径上是 skipped（不阻塞 S1）。
 * @param {{store: object, now: number|Date, scope: string}} ctx
 * @param {string} target
 * @param {{immediate: boolean, confirm: boolean}} options
 * @returns {string}
 */
function forgetReply(ctx, target, options) {
  const exact = typeof ctx.store.getFact === 'function' ? ctx.store.getFact(target) : null;
  if (exact) {
    const result = forgetMemory({
      store: ctx.store,
      kind: 'fact',
      id: exact.id,
      at: ctx.now,
      scope: ctx.scope,
      immediate: options.immediate,
      confirm: options.confirm,
    });
    return formatForgetReply(result, exact.id, options);
  }
  return forgetByKeyword(ctx, target, options);
}

/**
 * 关键词遗忘：最多标记 MAX_FORGET 条 active 事实，避免一条命令清空整库。
 * @param {{store: object, now: number|Date, scope: string}} ctx
 * @param {string} target
 * @param {{immediate: boolean, confirm: boolean}} options
 * @returns {string}
 */
function forgetByKeyword(ctx, target, options) {
  const hits = ctx.store.searchBigram(target, { scope: ctx.scope, limit: 10 });
  const ids = [];
  for (const hit of hits) {
    if (hit.type !== 'fact') continue;
    if (ids.length >= MAX_FORGET) break;
    const row = ctx.store.getFact(hit.id);
    if (!row || row.status === 'tombstoned' || row.deleted_at) continue;
    const result = forgetMemory({
      store: ctx.store,
      kind: 'fact',
      id: row.id,
      at: ctx.now,
      scope: ctx.scope,
      immediate: options.immediate,
      confirm: options.confirm,
    });
    if (result.reason === 'needs_confirm') {
      // 彻底忘掉未带「确认」：只提示第一个目标，命中集合保持不变。
      return `回复 /记忆 彻底忘掉 ${row.id} 确认 立即删除`;
    }
    if (result.ok) ids.push(row.id);
  }
  if (ids.length === 0) return `没有找到可遗忘的事实：${target}`;
  if (options.immediate) return `已彻底遗忘：${ids.join('、')}（已物理删除）`;
  return `已标记为遗忘：${ids.join('、')}（7 天后物理删除）`;
}

/**
 * @param {object} result forgetMemory 的结构化结果
 * @param {string} id
 * @param {{immediate: boolean}} options
 * @returns {string}
 */
function formatForgetReply(result, id, options) {
  switch (result.reason) {
    case 'needs_confirm':
      return `回复 /记忆 彻底忘掉 ${id} 确认 立即删除`;
    case 'not_found':
    case 'not_active':
      return `未找到事实：${id}`;
    case 'already_deleted':
      return options.immediate
        ? `已彻底遗忘：${id}（此前已删除）`
        : `已标记为遗忘：${id}（7 天后物理删除）`;
    default:
      if (result.ok && result.purged) return `已彻底遗忘：${id}（已物理删除）`;
      if (result.ok) return `已标记为遗忘：${id}（7 天后物理删除）`;
      return `未找到事实：${id}`;
  }
}

/**
 * 置顶/取消置顶：一次 updateFact 同时写 salience 与 strength_days，
 * 保证 pinned↔NULL、explicit↔365 的 CHECK 约束始终成立。
 * @param {object} store
 * @param {string} id
 * @param {boolean} pinned
 * @returns {string}
 */
function setPinned(store, id, pinned) {
  const fact = store.getFact(id);
  if (!fact || fact.deleted_at) return `未找到事实：${id}`;
  if (pinned) {
    store.updateFact(id, { salience: 'pinned', strength_days: null });
    return `已置顶：${id}`;
  }
  store.updateFact(id, { salience: 'explicit', strength_days: 365 });
  return `已取消置顶：${id}`;
}

// ------------------------------------------------------------- 成本

/** @returns {{tokensIn:number,tokensOut:number,total:number}} */
function emptyCost() {
  return { tokensIn: 0, tokensOut: 0, total: 0 };
}

/** @param {object} cost @param {{in:number,out:number}} parts */
function addCost(cost, parts) {
  cost.tokensIn += parts.tokensIn;
  cost.tokensOut += parts.tokensOut;
  cost.total += parts.tokensIn + parts.tokensOut;
}

/** @param {string} detail */
function parseDetail(detail) {
  if (detail === null || detail === undefined || detail === '') return {};
  if (typeof detail === 'object') return detail;
  try {
    const value = JSON.parse(detail);
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** @param {object} detail @returns {{tokensIn:number,tokensOut:number}} */
function tokenParts(detail) {
  return {
    tokensIn: firstNumber(detail, ['tokensIn', 'tokens_in', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']),
    tokensOut: firstNumber(detail, ['tokensOut', 'tokens_out', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']),
  };
}

/** @param {object} detail @param {string[]} keys */
function firstNumber(detail, keys) {
  for (const key of keys) {
    const n = Number(detail[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * @param {object} store
 * @param {number} sinceSec
 * @returns {Array<{at:number, detail_json:unknown}>}
 */
function listTokenEvents(store, sinceSec) {
  if (hasDb(store)) {
    return store.db
      .prepare('SELECT at, detail_json FROM memory_events WHERE at >= ? ORDER BY at ASC')
      .all(sinceSec);
  }
  return store
    .listEvents({ limit: 1000 })
    .filter((row) => toMillis(row.at) / 1000 >= sinceSec);
}

/**
 * 成本文案；budget 存在时追加今日配额/熔断状态（M4）。
 * @param {{today:object, month:object}} summary
 * @param {{dailyTokens?: number, dailyLimit?: number, tripped?: boolean}} [budget]
 */
function formatCost(summary, budget) {
  let text = `成本：今日 ${summary.today.total} tokens（入 ${summary.today.tokensIn} / 出 ${summary.today.tokensOut}）`
    + `｜本月 ${summary.month.total} tokens（入 ${summary.month.tokensIn} / 出 ${summary.month.tokensOut}）`;
  if (budget !== null && typeof budget === 'object') {
    const daily = Number(budget.dailyTokens) || 0;
    const limit = Number(budget.dailyLimit) || DAILY_TOKEN_LIMIT;
    text += `｜今日配额 ${daily} / ${limit}`;
    if (budget.tripped === true) text += '（已熔断）';
  }
  return text;
}

// ------------------------------------------------------------- 线程/状态

/** @param {object[]} rows @param {string} timeZone */
function formatThreads(rows, timeZone) {
  if (rows.length === 0) return '线程目录：暂无。';
  const lines = ['线程目录（' + rows.length + '）：', 'key | 状态 | 名称 | 最后活跃'];
  for (const row of rows) {
    lines.push(`${row.key} | ${row.status} | ${row.name} | ${formatDate(row.last_active_at, timeZone)}`);
  }
  return lines.join('\n');
}

/**
 * RSS 三档阈值行（N-M3/W4-10）。接线层未传 rssLimits 时返回 null，
 * 保持旧快照格式不变（命令层可被单测直接调用）。
 * @param {object} [budget]
 * @returns {string|null}
 */
function formatRssLimits(budget) {
  const limits = budget?.rssLimits;
  if (limits === null || limits === undefined || typeof limits !== 'object') return null;
  const warn = formatGiB(limits.warnGiB);
  const stop = formatGiB(limits.stopGiB);
  const mainOnly = formatGiB(limits.mainOnlyGiB);
  if (warn === null || stop === null || mainOnly === null) return null;
  return `RSS 阈值：warn ${warn}GiB / stop ${stop}GiB / main_only ${mainOnly}GiB`;
}

/** @param {unknown} value @returns {string|null} */
function formatGiB(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * 100) / 100);
}

/** @param {object} store @param {string} scope @param {object|undefined} metrics @param {string} timeZone @param {object} [budget] @param {{threadsSupported?: boolean, mainSession?: {id?: string|null, binding?: string}, threadAgentPreset?: string|null, persona?: {name?: string, version?: number, status?: string, path?: string|null, reason?: string|null}, shadow?: {mode?: string}, emotion?: object}} [options] */
function formatStatus(store, scope, metrics, timeZone, budget, options = {}) {
  const stats = store.stats();
  const tables = [
    'entities', 'episodes', 'facts', 'reminders', 'state_board', 'state_board_rev',
    'threads', 'consolidations', 'memory_events',
  ];
  const counts = tables.map((table) => `${table} ${stats[table] ?? 0}`).join(' / ');
  const watermark = store.getWatermark(scope);
  const job = latestConsolidation(store, scope);
  const jobText = job
    ? `${job.kind} ${job.status} upto_seq=${job.upto_seq}（${formatDateTime(job.started_at, timeZone)}）`
    : '无';
  const fts = `fts ${stats.fts_facts ?? 0}/${stats.fts_episodes ?? 0}`;
  const tokenText = formatTokenSnapshot(metrics, budget);
  const failureText = formatFailureStatus(store, timeZone);
  const limitsText = formatRssLimits(budget);
  const lines = [`状态：${counts} / ${fts}${tokenText}`];
  if (limitsText !== null) lines.push(limitsText);
  // H3②：宿主没有 sessionController 时线程/任务工具虽已注册但调用会返回
  // capability_missing，状态里说清楚，免得用户以为 /线程 为空是数据问题。
  if (options.threadsSupported === false) {
    lines.push(THREADS_UNSUPPORTED_TEXT);
  }
  // C5-M1：web-app 默认不启用 compaction-basic（disabled:true），插件只能靠
  // 宿主 compactRegion 压缩；能力位为 false 时说明原因与开关，避免「占内存」误判。
  if (options.compactionSupported === false) {
    lines.push(COMPACTION_DISABLED_TEXT);
  } else if (options.compactionSupported === true) {
    const pending = Number(options.pendingCompactions);
    const suffix = Number.isFinite(pending) && pending > 0 ? `，待压缩 ${pending} 个区间` : '';
    lines.push(`${COMPACTION_ENABLED_TEXT}${suffix}`);
  }
  // G0-9：最近一次压缩/巩固实际耗时（只观测，不设超时）；无样本显示 —。
  // timing 只在接线层传入时输出，保持旧调用方（单测）的 /状态 格式不变。
  if (options.timing !== null && options.timing !== undefined && typeof options.timing === 'object') {
    lines.push(...formatTimingLines(options.timing));
  }
  // V3-M2：主会话绑定对排障关键（提醒投错会话时先看这里）。
  const mainSession = options.mainSession;
  if (mainSession !== null && mainSession !== undefined && typeof mainSession === 'object') {
    const binding = typeof mainSession.binding === 'string' && mainSession.binding !== ''
      ? mainSession.binding
      : 'latest-user';
    const id = typeof mainSession.id === 'string' && mainSession.id !== '' ? mainSession.id : '未绑定';
    lines.push(`主会话：${id}（绑定 ${binding}）`);
  }
  // V10-H1：线程 preset 是否来自配置；排障 preset_unknown 时先看这一行。
  const threadPreset = typeof options.threadAgentPreset === 'string'
    && options.threadAgentPreset.trim() !== ''
    ? options.threadAgentPreset.trim()
    : null;
  lines.push(threadPreset === null
    ? '线程 preset：宿主默认'
    : `线程 preset：${threadPreset}（配置：thread.agentPreset）`);
  // v0.4.12：人格卡来源（内置默认 / 文件路径 / 加载失败原因）；只在接线层传入时输出，
  // 旧调用方（单测/其它宿主）不传则整行省略，输出格式不变。
  const personaLine = formatPersonaLine(options.persona);
  if (personaLine !== null) lines.push(personaLine);
  // P2（v0.5.0）：部署人设遮蔽状态；只在接线层传入 options.shadow 时输出。
  const shadowLine = formatShadowLine(options.shadow);
  if (shadowLine !== null) lines.push(shadowLine);
  // P3-c：情绪状态行。只在接线层传入 options.emotion 时输出，旧调用方格式不变。
  const emotionLine = formatEmotionLine(store, scope, options.emotion, options.now, timeZone);
  if (emotionLine !== null) lines.push(emotionLine);
  // V50-L3：最近一次装配（时间/遮蔽/段字数与短哈希/本轮情绪句）；不传则整行省略。
  const assemblyLine = formatAssemblyLine(options.assembly, options.now, timeZone);
  if (assemblyLine !== null) lines.push(assemblyLine);
  lines.push(`水位 ${scope}：${watermark}`, `最近 job：${jobText}`, failureText);
  return lines.join('\n');
}

/**
 * v0.4.12：人格卡来源行。
 *
 * 格式：`人格卡：<name> v<version>（<路径> | 内置默认 | 加载失败，已用内置：<原因>）`
 * 加载失败的原因已含解析后路径与错误码，这里不再重复；卡正文永不进 /状态。
 *
 * @param {{name?: unknown, version?: unknown, status?: unknown, path?: unknown, reason?: unknown}} [persona]
 * @returns {string|null} 未传 persona 时返回 null（不输出该行）
 */
function formatPersonaLine(persona) {
  if (persona === null || persona === undefined || typeof persona !== 'object') return null;
  const name = typeof persona.name === 'string' && persona.name.trim() !== ''
    ? persona.name.trim()
    : '未知';
  const version = Number.isInteger(persona.version) && persona.version > 0 ? ` v${persona.version}` : '';
  let source;
  if (persona.status === 'fallback') {
    const reason = typeof persona.reason === 'string' && persona.reason.trim() !== ''
      ? persona.reason.trim()
      : '原因未知';
    source = `加载失败，已用内置：${reason}`;
  } else if (persona.status === 'file') {
    source = typeof persona.path === 'string' && persona.path.trim() !== ''
      ? persona.path.trim()
      : '路径未知';
  } else {
    source = '内置默认';
  }
  return `人格卡：${name}${version}（${source}）`;
}

/**
 * P2（v0.5.0）：部署人设遮蔽状态行。
 *
 * 只反映实际注册结果（接线层注册失败按 'off' 传），不读配置原文。
 *
 * @param {{mode?: unknown}} [shadow]
 * @returns {string|null} 未传 shadow 时返回 null（不输出该行）
 */
function formatShadowLine(shadow) {
  if (shadow === null || shadow === undefined || typeof shadow !== 'object') return null;
  if (shadow.mode === 'off') return '部署人设：宿主默认';
  if (shadow.mode === 'rewrite') return '部署人设：已替换（人格卡身份）';
  if (shadow.mode === 'takeover') return '部署人设：已接管';
  return null;
}

/**
 * V50-L3：最近一次装配。
 *
 * 只展示可验证的元数据：时间、遮蔽模式、prefix 是否真的被改写、各段字数与短哈希、
 * 本轮情绪句。卡正文、段正文一律不进这一行——记录层也从不保存它们。
 *
 * @param {object|undefined} assembly 装配记录（createAssemblyRecord 产出的对象）
 * @param {number} now
 * @param {string} timeZone
 * @returns {string|null} 未传或尚无记录时返回 null
 */
function formatAssemblyLine(assembly, now, timeZone) {
  const snapshot = describeAssembly(assembly);
  if (snapshot === null) return null;
  // 取三者里最新的一次：装配（静态段）发生在 apply，遮蔽与情绪句每轮都可能更新，
  // 只按顺序短路会让刚发生的改写显示成「1 小时前」。
  const stamps = [snapshot.sectionsAt, snapshot.shadowAt, snapshot.emotionAt]
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  const at = stamps.length > 0 ? Math.max(...stamps) : null;
  const when = at === null ? '时间未知' : formatRelativeTimeCn(at, now, timeZone);
  const parts = [`最近一次装配：${when === '' ? '时间未知' : when}`];
  const mode = snapshot.shadowMode === 'rewrite'
    ? '已替换（rewrite）'
    : snapshot.shadowMode === 'takeover' ? '已接管（takeover）' : '宿主默认';
  parts.push(`部署人设 ${mode}`, snapshot.shadowRewritten ? 'prefix 已改写' : 'prefix 未改写');
  if (snapshot.sections.length > 0) {
    const segments = snapshot.sections.map((section) => {
      const name = displaySectionName(section?.name);
      const hash = typeof section?.hash === 'string' && section.hash !== '' ? section.hash : '—';
      return `${name} ${section?.chars ?? 0}/${hash}`;
    });
    parts.push(`段 ${segments.join('、')}`);
  }
  if (snapshot.emotionText !== '') parts.push(`情绪句「${snapshot.emotionText}」`);
  return parts.join('；');
}

/** P3-c：情绪事件类型 → /状态 里的中文标签；白名单之外（ambient）不展示。 */
const EMOTION_EVENT_LABELS = Object.freeze({
  greeting: '问候',
  care: '关心',
  share: '分享',
  thanks: '谢谢',
  complain: '抱怨',
  cold: '冷淡',
  reunion: '重逢',
  goodnight: '晚安',
  conflict: '冲突',
  comfort: '安慰',
  // V50-M1：指向她的负面话 / 用户自述疲惫，分开标注。
  blame: '指责',
  vent: '倾诉',
});

/**
 * P3-c：情绪状态行。
 *
 * - 未传 options.emotion（旧调用方）→ null，整行省略，输出格式不变；
 * - 未启用 → `情绪：未启用`，**不读库**；
 * - 启用但还没有状态 → `情绪：未开始`；
 * - 有状态 → `情绪：<describe>（最近：问候 5 分钟前 / 分享 2 小时前）`，
 *   最近事件最多 3 条、只展示白名单类型。
 *
 * @param {object} store
 * @param {string} scope
 * @param {{enabled?: boolean}|undefined} options
 * @param {number|undefined} now 毫秒时间戳
 * @param {string} timeZone
 * @returns {string|null}
 */
function formatEmotionLine(store, scope, options, now, timeZone) {
  if (options === null || options === undefined) return null;
  if (options.enabled !== true) return '情绪：未启用';

  let state;
  let events;
  try {
    state = store.getEmotionState(scope);
    events = state === null ? [] : store.listEmotionEvents(scope, 3);
  } catch {
    // 情绪只是展示项：读库失败不拖垮 /状态。
    return '情绪：未开始';
  }
  if (state === null) return '情绪：未开始';

  let line = `情绪：${describe(state)}`;
  const recent = [];
  for (const event of Array.isArray(events) ? events : []) {
    const label = EMOTION_EVENT_LABELS[event?.type];
    if (label === undefined) continue;
    const when = formatRelativeTimeCn(event.at, now, timeZone);
    if (when === '') continue;
    recent.push(`${label} ${when}`);
    if (recent.length >= 3) break;
  }
  if (recent.length > 0) line += `（最近：${recent.join(' / ')}）`;
  return line;
}

/**
 * P3-c：中文相对时间（复用现有 zonedDayKey 做日历日判定，不新增依赖）。
 *
 * 口径：<1 分钟「刚刚」；<1 小时「N 分钟前」；<24 小时「N 小时前」；
 * 配置时区的日历日差 1 天「昨天」；再早「N 天前」。未来时间按「刚刚」；
 * 非法入参返回空串（调用方跳过）。
 *
 * @param {number|Date} value 事件时间
 * @param {number|Date} now 当前时间
 * @param {string} [timeZone=DEFAULT_TIMEZONE]
 * @returns {string}
 */
export function formatRelativeTimeCn(value, now, timeZone = DEFAULT_TIMEZONE) {
  if (!isValidTimeZone(timeZone)) return '';
  const rawAt = value instanceof Date ? value.getTime() : Number(value);
  const rawNow = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(rawAt) || !Number.isFinite(rawNow)) return '';
  const at = toMillis(rawAt);
  const current = toMillis(rawNow);
  if (!Number.isFinite(at) || !Number.isFinite(current)) return '';
  const diff = current - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;

  const days = zonedDayNumberAt(current, timeZone) - zonedDayNumberAt(at, timeZone);
  if (days === 1) return '昨天';
  if (days > 1) return `${days} 天前`;
  return `${Math.floor(diff / 3_600_000)} 小时前`;
}

/**
 * 配置时区下的「日历日序号」，用于跨时区/跨 DST 的昨天判定。
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
function zonedDayNumberAt(ms, timeZone) {
  const [year, month, day] = zonedDayKey(ms, timeZone).split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * t17：从审计事件里找最近一次失败/重试/job 失败，供 /状态 展示。
 * 只读、异常安全；事件不存在时显示「无」。
 * @param {object} store
 * @param {string} timeZone
 * @returns {string}
 */
function formatFailureStatus(store, timeZone) {
  let rows = [];
  try {
    rows = typeof store?.listEvents === 'function' ? store.listEvents({ limit: 200 }) : [];
  } catch {
    rows = [];
  }
  let lastError = null;
  let lastRetry = null;
  let lastJobFailed = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    const detail = parseDetailJson(row?.detail_json);
    const reason = String(row?.reason ?? '');
    const kind = typeof detail?.kind === 'string' ? detail.kind : '';
    if (lastError === null && (reason === 'consolidation_failed' || reason === 'consolidation_failed_final')) {
      lastError = describeFailure(row, detail, timeZone, '巩固失败');
    }
    if (lastRetry === null && (reason === 'retry' || reason.startsWith('job_retry') || kind === 'retry' || kind === 'job_retry')) {
      lastRetry = describeRetry(row, detail, timeZone);
    }
    if (lastJobFailed === null && (reason.startsWith('job_error') || reason === 'backup_failed' || kind === 'job_error')) {
      lastJobFailed = describeFailure(row, detail, timeZone, 'job 失败');
    }
    if (lastError !== null && lastRetry !== null && lastJobFailed !== null) break;
  }
  return `最近失败：${lastError ?? '无'}\n最近重试：${lastRetry ?? '无'}\n最近 job 失败：${lastJobFailed ?? '无'}`;
}

/** @param {object} row @param {object|null} detail @param {string} timeZone @param {string} label */
function describeFailure(row, detail, timeZone, label) {
  const message = truncateText(detail?.message ?? detail?.last_error ?? '', 100);
  const at = formatDateTime(row?.at, timeZone);
  return `${label}${message === '' ? '' : `：${message}`}（${at}）`;
}

/** @param {object} row @param {object|null} detail @param {string} timeZone */
function describeRetry(row, detail, timeZone) {
  const attempt = Number(detail?.attempts);
  const prefix = Number.isFinite(attempt) && attempt > 0 ? `第 ${attempt} 次重试` : '重试';
  const next = Number(detail?.nextRetryAt);
  const when = Number.isFinite(next) && next > 0
    ? formatDateTime(toMillis(next) / 1000, timeZone)
    : formatDateTime(row?.at, timeZone);
  return `${prefix} → ${when}`;
}

/** @param {unknown} value */
function parseDetailJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {number} max */
function truncateText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 本轮 token / 每日配额 / RSS 快照（L6、M4）：metrics 缺失时显示 0，绝不 throw。
 * RSS 的 MB 优先用接线层传入的 state.rss（metrics 的 rssMB 是进程实时读数，
 * 与可注入的 rssReader 不是同一口径）。
 * @param {object} [metrics]
 * @param {object} [budget]
 * @returns {string}
 */
function formatTokenSnapshot(metrics, budget) {
  const vectorText = formatVectorText(budget);
  if (!metrics || typeof metrics.snapshot !== 'function') return ` / tokens 本轮 0${vectorText}`;
  try {
    const snapshot = metrics.snapshot();
    const tokensIn = Number(snapshot.tokensIn) || 0;
    const tokensOut = Number(snapshot.tokensOut) || 0;
    const overBudget = Number(snapshot.overBudget) || 0;
    const daily = Number(budget?.dailyTokens ?? snapshot.dailyTokens) || 0;
    const tripped = budget?.tripped === true || Number(snapshot.budgetTripped) >= 1;
    const rssCode = Number(budget?.rssLevelCode ?? snapshot.rssLevel) || 0;
    const rssName = RSS_LEVEL_NAMES[rssCode] ?? 'ok';
    const rssMB = Number(budget?.rssMB ?? snapshot.rssMB) || 0;
    return ` / tokens 本轮 入 ${tokensIn} 出 ${tokensOut}（超预算 ${overBudget} 次）`
      + `｜今日 ${daily}/${DAILY_TOKEN_LIMIT}${tripped ? '（已熔断）' : ''}`
      + `｜RSS ${rssName} ${rssMB}MB`
      + vectorText;
  } catch {
    return ` / tokens 本轮 0${vectorText}`;
  }
}

/**
 * 向量召回状态片段（P2-b / W4）：关闭时只显示「关」，开启时显示 dim、embedder
 * 与本进程已回填条数、最近命中；E2-M1 追加回填超时/推理占用计数。
 * 旧 budget 形状（无 embedder）保持原格式。
 * @param {object} [budget]
 * @returns {string}
 */
function formatVectorText(budget) {
  const vector = budget?.vector;
  if (vector === undefined || vector === null || vector.enabled !== true) return '｜向量：关';
  const dim = Number(vector.dim) || 0;
  const lastHits = Number(vector.lastHits) || 0;
  if (typeof vector.embedder !== 'string' || vector.embedder === '') {
    return `｜向量：开·dim ${dim}·最近命中 ${lastHits}`;
  }
  const timeouts = Number(vector.backfillTimeouts) || 0;
  const busy = Number(vector.embedBusy) || 0;
  return `｜向量：开·dim ${dim}·${vector.embedder}·已回填 ${Number(vector.backfilled) || 0}·最近命中 ${lastHits}`
    + `·回填超时 ${timeouts}·占用 ${busy}`;
}

/** @param {object} store @param {string} scope */
function latestConsolidation(store, scope) {
  if (!hasDb(store)) return null;
  return store.db
    .prepare(
      `SELECT * FROM consolidations
        WHERE scope = ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(scope) ?? null;
}

// ------------------------------------------------------------- helpers

/** @param {object} store */
function hasDb(store) {
  return store?.db !== null && typeof store?.db?.prepare === 'function';
}

/** @param {number|string|Date} value */
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  // 非法时间戳不读全局时钟：交给调用方注入的 now 语义保持一致，记为 0。
  if (!Number.isFinite(n)) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/** @param {number|null|undefined} sec @param {string} timeZone */
function formatDate(sec, timeZone) {
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return '—';
  return zonedDayKey(Number(sec) * 1000, timeZone);
}

/** @param {number|null|undefined} sec @param {string} timeZone */
function formatDateTime(sec, timeZone) {
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return '—';
  const ms = Number(sec) * 1000;
  const parts = zonedParts(ms, timeZone);
  const hh = String(parts.hour).padStart(2, '0');
  const mm = String(parts.minute).padStart(2, '0');
  return `${zonedDayKey(ms, timeZone)} ${hh}:${mm}`;
}
