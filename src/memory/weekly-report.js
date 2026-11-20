/**
 * L120-L1：`/记忆 周报` 的数据生产者。
 *
 * 背景：以前「周报」是让模型凭上下文估算，数字不可复现。这里改成插件直接查库
 * 出数——事实按 status × kind、情景、本周新增、本周 superseded、待处理与过期
 * 提醒、pinned 数量、本周巩固 written / empty / failed 次数——模型只做解读。
 *
 * 口径约定（回报里列为「需云端对账」）：
 * - 「本周」= **滚动 7 天**（`now - 7*86400 < 时间戳 <= now`），TZ 无关，
 *   直接用 unixepoch 秒比较，云端 SQL 最好照抄这个谓词。
 * - 「新增」看 `observed_at`（事实）/`started_at`（情景）；`superseded` 看
 *   `updated_at`（只有被改写时才动这一列）。
 * - 巩固状态直接消费 v0.7.7 阶段 1 落地的 `empty` 口径：empty 不算失败。
 *
 * 只读：不使用事务、不写任何表，`store.db` 直接 prepare 聚合（同
 * `govern.js` 的先例，不给 store 加方法）。
 *
 * @param {{store: object, scope?: string, timeZone?: string, now?: number|Date}} input
 * @returns {{text: string, counts: object}}
 */
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const CONSOLIDATION_KINDS = ['nap', 'deep'];

/**
 * 本地 epoch 归一口径（`time.js` 的 `toMillis` 未导出，这里按同一规则实现）：
 * 秒级整数按秒解释、Date/毫秒按毫秒、非法值 null。
 * @param {unknown} value
 * @returns {number|null}
 */
function toEpochMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** @param {unknown} value */
function toSeconds(value) {
  const ms = toEpochMillis(value);
  return ms === null ? null : Math.floor(ms / 1000);
}

/** @param {object} store @param {string} sql @param {unknown[]} params */
function one(store, sql, params = []) {
  const row = store.db.prepare(sql).get(...params);
  return row ?? null;
}

/** @param {object} store @param {string} sql @param {unknown[]} params */
function all(store, sql, params = []) {
  return store.db.prepare(sql).all(...params) ?? [];
}

/** @param {object} input */
function collect({ store, scope, now }) {
  const nowSeconds = toSeconds(now) ?? Math.floor(Date.now() / 1000);
  const weekStart = nowSeconds - WEEK_SECONDS;
  const where = 'scope = ? AND deleted_at IS NULL';

  const factRows = all(
    store,
    `SELECT status, kind, COUNT(*) AS n FROM facts WHERE ${where} GROUP BY status, kind`,
    [scope],
  );
  const factsByStatus = {};
  const factsByKind = {};
  let factsTotal = 0;
  for (const row of factRows) {
    const n = Number(row.n) || 0;
    factsByStatus[row.status] = (factsByStatus[row.status] ?? 0) + n;
    if (row.status === 'active') {
      factsByKind[row.kind] = (factsByKind[row.kind] ?? 0) + n;
    }
    // 总数 = 除墓碑外的全部行，这样下面 status 分项相加与总数对得上
    // （superseded 是「被改写」的历史，仍属记忆存量，只有 tombstoned 不算）。
    if (row.status !== 'tombstoned') {
      factsTotal += n;
    }
  }

  const pinned = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM facts
      WHERE ${where} AND status = 'active'
        AND (salience = 'pinned' OR strength_days IS NULL)`,
    [scope],
  )?.n) || 0;

  const newFactsWeek = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM facts WHERE ${where} AND observed_at > ? AND observed_at <= ?`,
    [scope, weekStart, nowSeconds],
  )?.n) || 0;

  const supersededWeek = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM facts
      WHERE ${where} AND status = 'superseded' AND updated_at > ? AND updated_at <= ?`,
    [scope, weekStart, nowSeconds],
  )?.n) || 0;

  const episodesTotal = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM episodes WHERE ${where} AND status = 'active'`,
    [scope],
  )?.n) || 0;

  const episodesWeek = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM episodes
      WHERE ${where} AND started_at > ? AND started_at <= ?`,
    [scope, weekStart, nowSeconds],
  )?.n) || 0;

  const remindersByStatus = {};
  for (const row of all(
    store,
    `SELECT status, COUNT(*) AS n FROM reminders WHERE ${where} GROUP BY status`,
    [scope],
  )) {
    remindersByStatus[row.status] = Number(row.n) || 0;
  }

  // 已过期但还没告知过用户的条数：下一次真实发言会由 expired-notice 合并告知。
  const unnotifiedExpired = Number(one(
    store,
    `SELECT COUNT(*) AS n FROM reminders
      WHERE ${where} AND status = 'expired' AND expired_notified_at IS NULL`,
    [scope],
  )?.n) || 0;

  const consolidationsWeek = {};
  const placeholders = CONSOLIDATION_KINDS.map(() => '?').join(',');
  for (const row of all(
    store,
    `SELECT status, COUNT(*) AS n FROM consolidations
      WHERE scope = ? AND kind IN (${placeholders})
        AND started_at > ? AND started_at <= ?
      GROUP BY status`,
    [scope, ...CONSOLIDATION_KINDS, weekStart, nowSeconds],
  )) {
    consolidationsWeek[row.status] = Number(row.n) || 0;
  }

  return {
    now: nowSeconds,
    weekStart,
    factsByStatus,
    factsByKind,
    factsTotal,
    pinned,
    newFactsWeek,
    supersededWeek,
    episodesTotal,
    episodesWeek,
    remindersByStatus,
    unnotifiedExpired,
    consolidationsWeek,
  };
}

/** @param {number|undefined} value */
function show(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

/**
 * 生成 `/记忆 周报` 的文本。纯数据，不做解读、不调模型。
 * @param {{store: object, scope?: string, timeZone?: string, now?: number|Date}} input
 * @returns {{text: string, counts: object}}
 */
export function buildWeeklyMemoryReport({ store, scope = 'main', timeZone, now = Date.now() } = {}) {
  if (!store || typeof store !== 'object' || !store.db) {
    throw new TypeError('[weekly-report] store must be a Store instance');
  }
  const data = collect({ store, scope, now });
  const statusOrder = ['active', 'dormant', 'superseded', 'tombstoned'];
  const factStatusText = statusOrder
    .map((status) => `${status}=${show(data.factsByStatus[status])}`)
    .join(' · ');
  const kindOrder = ['project', 'knowledge', 'preference', 'relation', 'identity', 'lifestyle', 'mood', 'other'];
  const factKindText = kindOrder
    .filter((kind) => data.factsByKind[kind] !== undefined)
    .map((kind) => `${kind}=${show(data.factsByKind[kind])}`)
    .join(' · ') || '（无活跃事实）';
  const pending = data.remindersByStatus.pending ?? 0;
  const snoozed = data.remindersByStatus.snoozed ?? 0;
  const expired = data.remindersByStatus.expired ?? 0;
  const written = data.consolidationsWeek.written ?? 0;
  const empty = data.consolidationsWeek.empty ?? 0;
  const failed = data.consolidationsWeek.failed ?? 0;

  const lines = [
    `记忆周报（${scope}，滚动 7 天；时区 ${timeZone ?? 'Asia/Shanghai'}，窗口与本地时区无关）：`,
    `事实：共 ${data.factsTotal} 条（${factStatusText}）`,
    `活跃事实按 kind：${factKindText}`,
    `本周新增事实：${data.newFactsWeek} 条 · 本周被改写（superseded）：${data.supersededWeek} 条`,
    `情景：${data.episodesTotal} 条（本周新增 ${data.episodesWeek} 条）`,
    `提醒：待处理 ${pending} · 暂缓 ${snoozed} · 已过期 ${expired}（未告知 ${data.unnotifiedExpired}）`,
    `pinned 事实：${data.pinned} 条`,
    `本周巩固：written=${written} · empty=${empty} · failed=${failed}（empty = 区间无可抽取正文，不算失败）`,
  ];

  return {
    text: lines.join('\n'),
    counts: {
      scope,
      factsTotal: data.factsTotal,
      factsByStatus: data.factsByStatus,
      factsByKind: data.factsByKind,
      newFactsWeek: data.newFactsWeek,
      supersededWeek: data.supersededWeek,
      episodesTotal: data.episodesTotal,
      episodesWeek: data.episodesWeek,
      pinned: data.pinned,
      remindersByStatus: data.remindersByStatus,
      unnotifiedExpired: data.unnotifiedExpired,
      consolidationsWeek: { written, empty, failed },
      windowStart: data.weekStart,
      windowEnd: data.now,
    },
  };
}

