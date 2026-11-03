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
 */

import { forgetMemory } from '../memory/forget.js';
import { DAILY_TOKEN_LIMIT } from './budget.js';
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
 *   rssLevel?: string, rssMB?: number}} [options.budget] M4 预算/RSS 快照
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
    return { handled: true, reply: formatThreads(store.listThreads({ limit: 100 }), timeZone) };
  }
  return { handled: true, reply: formatStatus(store, scope, metrics, timeZone, budget) };
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

/** @param {object} store @param {string} scope @param {object|undefined} metrics @param {string} timeZone @param {object} [budget] */
function formatStatus(store, scope, metrics, timeZone, budget) {
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
  return `状态：${counts} / ${fts}${tokenText}\n水位 ${scope}：${watermark}\n最近 job：${jobText}`;
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
  if (!metrics || typeof metrics.snapshot !== 'function') return ' / tokens 本轮 0';
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
      + `｜RSS ${rssName} ${rssMB}MB`;
  } catch {
    return ' / tokens 本轮 0';
  }
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
