/**
 * 用户可见命令（05 §4.5、06 §10）：/记忆、/成本、/线程、/状态。
 *
 * 设计约束：
 * - 只读写注入的 Store，不直接持有全局单例，便于测试与后续多会话接线；
 * - 所有 SQL 都走 store.db 的参数绑定（store.js 未提供按 kind 计数等聚合方法，
 *   本卡不允许改 store.js，因此这里只做只读聚合与 S1 tombstone）；
 * - 未知命令返回 { handled: false }，由调用方决定是否交给模型；
 * - 命令回复是给人看的短文本，不塞 JSON。
 */

const MEMORY_COMMANDS = new Set(['记忆', '成本', '线程', '状态']);
const MAX_FORGET = 5;

/**
 * 解析并执行一条用户命令。
 *
 * @param {object} options
 * @param {string} options.text 原始输入
 * @param {import('../memory/store.js').Store} options.store
 * @param {number|Date} [options.now=Date.now] 毫秒时间戳或 Date
 * @param {string} [options.scope='main'] 作用域
 * @returns {{handled: boolean, reply: string}}
 */
export function handleCommand({ text, store, now = Date.now(), scope = 'main' } = {}) {
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

  if (command === '记忆') {
    return handleMemoryCommand(parts.slice(1), { store, now, scope });
  }
  if (command === '成本') {
    const summary = summarizeCost(store, now);
    return { handled: true, reply: formatCost(summary) };
  }
  if (command === '线程') {
    return { handled: true, reply: formatThreads(store.listThreads({ limit: 100 })) };
  }
  return { handled: true, reply: formatStatus(store, scope) };
}

/**
 * 今日/本月 token 汇总。
 *
 * 数据源按 t11 卡：memory_events.detail_json 里的 tokensIn/tokensOut
 * （也兼容 tokens_in/tokens_in 与 input/output 命名）。没有 token 字段的
 * 事件不计入。返回结构固定为 {today, month}，各自 {tokensIn, tokensOut, total}。
 *
 * @param {object} store
 * @param {number|Date} [now=Date.now]
 * @returns {{today: {tokensIn:number,tokensOut:number,total:number},
 *            month: {tokensIn:number,tokensOut:number,total:number}}}
 */
export function summarizeCost(store, now = Date.now()) {
  const at = toMillis(now);
  const dayStart = startOfDay(at);
  const monthStart = startOfMonth(at);
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
  if (sub === '忘掉') {
    const target = args.slice(1).join(' ').trim();
    if (target === '') {
      return { handled: true, reply: '用法：/记忆 忘掉 <id|关键词>' };
    }
    return { handled: true, reply: forgetMemory(ctx.store, target, ctx) };
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
 * S1 显式遗忘：id 直接转 tombstoned；否则按关键词找 active 事实，
 * 最多标记 MAX_FORGET 条。行与 FTS 保留到满 7 天后的 S2 purge。
 * @param {object} store
 * @param {string} target
 * @param {{now:number|Date, scope:string}} ctx
 * @returns {string}
 */
function forgetMemory(store, target, ctx) {
  // Store 的时间参数按 Unix 秒处理；命令层允许 Date/毫秒，这里统一换算。
  const at = Math.floor(toMillis(ctx.now) / 1000);
  const exact = typeof store.getFact === 'function' ? store.getFact(target) : null;
  if (exact) {
    if (exact.status === 'tombstoned' || exact.deleted_at) {
      return `已标记为遗忘：${exact.id}（7 天后物理删除）`;
    }
    const forgotten = store.forgetFact(exact.id, {
      at,
      payload: { statement: exact.statement, kind: exact.kind, scope: exact.scope },
    });
    if (forgotten || store.getFact(exact.id)?.status === 'tombstoned') {
      return `已标记为遗忘：${exact.id}（7 天后物理删除）`;
    }
    return `未找到事实：${target}`;
  }

  const hits = store.searchBigram(target, { scope: ctx.scope, limit: 10 });
  const ids = [];
  for (const hit of hits) {
    if (hit.type !== 'fact') continue;
    if (ids.length >= MAX_FORGET) break;
    const row = store.getFact(hit.id);
    if (!row || row.status === 'tombstoned' || row.deleted_at) continue;
    const forgotten = store.forgetFact(row.id, {
      at,
      payload: { statement: row.statement, kind: row.kind, scope: row.scope },
    });
    if (forgotten) ids.push(row.id);
  }
  if (ids.length === 0) return `没有找到可遗忘的事实：${target}`;
  return `已标记为遗忘：${ids.join('、')}（7 天后物理删除）`;
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

/** @param {{today:object, month:object}} summary */
function formatCost(summary) {
  return `成本：今日 ${summary.today.total} tokens（入 ${summary.today.tokensIn} / 出 ${summary.today.tokensOut}）`
    + `｜本月 ${summary.month.total} tokens（入 ${summary.month.tokensIn} / 出 ${summary.month.tokensOut}）`;
}

// ------------------------------------------------------------- 线程/状态

/** @param {object[]} rows */
function formatThreads(rows) {
  if (rows.length === 0) return '线程目录：暂无。';
  const lines = ['线程目录（' + rows.length + '）：', 'key | 状态 | 名称 | 最后活跃'];
  for (const row of rows) {
    lines.push(`${row.key} | ${row.status} | ${row.name} | ${formatDate(row.last_active_at)}`);
  }
  return lines.join('\n');
}

/** @param {object} store @param {string} scope */
function formatStatus(store, scope) {
  const stats = store.stats();
  const tables = [
    'entities', 'episodes', 'facts', 'reminders', 'state_board', 'state_board_rev',
    'threads', 'consolidations', 'memory_events',
  ];
  const counts = tables.map((table) => `${table} ${stats[table] ?? 0}`).join(' / ');
  const watermark = store.getWatermark(scope);
  const job = latestConsolidation(store, scope);
  const jobText = job
    ? `${job.kind} ${job.status} upto_seq=${job.upto_seq}（${formatDateTime(job.started_at)}）`
    : '无';
  const fts = `fts ${stats.fts_facts ?? 0}/${stats.fts_episodes ?? 0}`;
  return `状态：${counts} / ${fts}\n水位 ${scope}：${watermark}\n最近 job：${jobText}`;
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
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e11 ? n * 1000 : n;
}

/** @param {number} ms */
function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** @param {number} ms */
function startOfMonth(ms) {
  const date = new Date(ms);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** @param {number|null|undefined} sec */
function formatDate(sec) {
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return '—';
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10);
}

/** @param {number|null|undefined} sec */
function formatDateTime(sec) {
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return '—';
  return new Date(Number(sec) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
