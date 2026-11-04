/**
 * T9 主动消息闸门（10 v3.0 §2.1 PR-01..PR-05、06 v3.3 §9）。
 *
 * 六道闸门，按顺序：
 * 1. 安静时段（默认 23:00–08:00，可跨午夜）：全部滞留 backlog，08:00 后合并发送；
 * 2. 每日硬上限 config.proactiveDailyCap（默认 3）：到上限后队列继续保持 backlog；
 * 3. 单类上限：task_report 1 / reminder 2 / chat 1（每类每日）；
 * 4. dedupeKey 120 分钟内只发一次；
 * 5. 同一类相邻 ≤10 分钟合并成一条（仍只占 1 条预算）；
 * 6. backlog 超过 5 条时丢弃最旧（enqueue 时执行）。
 *
 * 唯一投递通道是 `platform.prompt(target(), text)`（10 §2.3：唤醒 main 一轮）。
 * target 由接线层按 identity 解析出的「当前主会话 id」提供，不得传字面量 'main'；
 * 取不到主会话与投递失败同路径处理（保留 backlog 等待重试）。
 * 投递前后可选钩子（onAttempt/onSent/onFailed，如提醒的两阶段状态机）由 enqueue 携带：
 * onAttempt 在真正投递前调用（返回 false 表示本轮放弃该条），onSent 成功、onFailed 失败
 * 或队列溢出丢弃时调用，均 best-effort，不影响闸门自身的计数。
 * 每次发送成功写一条 memory_events 事件（table_name='proactive',
 * detail.kind='proactive_sent'），重启后可恢复当日计数与 dedupe 窗口。
 * 仅使用 Node 内置能力。
 */

import { DEFAULTS, isQuietAt } from '../config.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, zonedDayKey } from '../time.js';

/** 单类每日上限（PR-03）。 */
export const KIND_CAPS = Object.freeze({ task_report: 1, reminder: 2, chat: 1 });

/** 同一 dedupeKey 的重发间隔（PR-04）。 */
export const DEDUPE_WINDOW_MS = 120 * 60 * 1000;

/** 同类消息合并窗口（PR-05）。 */
export const MERGE_WINDOW_MS = 10 * 60 * 1000;

/** backlog 上限（06 v3.3 §3 主动消息 outbox）。 */
export const MAX_BACKLOG = 5;

/** memory_events 里主动消息事件的 table_name。 */
export const PROACTIVE_EVENT_TABLE = 'proactive';

const KINDS = Object.freeze(Object.keys(KIND_CAPS));

/** @param {unknown} value @returns {number} */
function normalizeNow(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('[proactive] invalid Date');
    return ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`[proactive] invalid time: ${String(value)}`);
}

/** @param {number} ms @param {string} timeZone @returns {string} 分区日期键 */
function dayKey(ms, timeZone) {
  return zonedDayKey(ms, timeZone);
}

/** @param {unknown} detail @returns {object|null} */
function parseDetail(detail) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'object') return detail;
  if (typeof detail !== 'string') return null;
  try {
    const parsed = JSON.parse(detail);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 创建主动消息闸门。
 *
 * @param {object} options
 * @param {object} options.store 需提供 appendEvent（发送记账；listEvents 可选，用于重启恢复）
 * @param {{prompt: Function}} options.platform 平台适配器窄接口
 * @param {() => (string|null)} options.target 解析当前主会话 id（无主会话返回 null）
 * @param {Record<string, unknown>} [options.config] 已校验配置（缺省用 DEFAULTS）
 * @param {() => number|Date} [options.clock]
 * @returns {{enqueue: Function, flush: Function, stats: Function}}
 */
export function createProactive({ store, platform, config, target, clock = Date.now } = {}) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createProactive(store): store must be an object');
  }
  if (typeof store.appendEvent !== 'function') {
    throw new TypeError('createProactive(store): store.appendEvent is required');
  }
  if (platform === null || typeof platform !== 'object' || typeof platform.prompt !== 'function') {
    throw new TypeError('createProactive(platform): platform.prompt is required');
  }
  if (typeof target !== 'function') {
    throw new TypeError('createProactive(target): target must resolve the current main session id');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createProactive(clock): clock must be a function');
  }

  const settings = config ?? {};
  const dailyCap = settings.proactiveDailyCap ?? DEFAULTS.proactiveDailyCap;
  if (!Number.isInteger(dailyCap) || dailyCap < 0) {
    throw new TypeError(`createProactive(config): proactiveDailyCap must be a non-negative integer, got ${dailyCap}`);
  }
  const timeZone = settings.timezone ?? DEFAULTS.timezone ?? DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError(`createProactive(config): unknown IANA time zone "${String(timeZone)}"`);
  }
  const quietConfig = {
    quietStart: settings.quietStart ?? DEFAULTS.quietStart,
    quietEnd: settings.quietEnd ?? DEFAULTS.quietEnd,
    timezone: timeZone,
  };

  const nowMs = () => normalizeNow(clock());

  /** @type {{kind: string, text: string, at: number, seq: number, dedupeKey: string|null,
   *   hooks: {onAttempt?: Function, onSent?: Function, onFailed?: Function}[]}[]} */
  const queue = [];
  /** @type {Map<string, number>} dedupeKey → 最近发送时刻（ms） */
  const dedupe = new Map();

  const state = {
    dayKey: dayKey(nowMs(), timeZone),
    sentToday: 0,
    byKind: { task_report: 0, reminder: 0, chat: 0 },
  };
  let seq = 0;
  let dropped = 0;
  /** settle 链：flush 串行执行，避免并发 flush 重复发同一条 */
  let chain = Promise.resolve();

  /** 从 memory_events 恢复当日计数与 dedupe 窗口（重启安全）。 */
  function seedFromStore() {
    if (typeof store.listEvents !== 'function') return;
    let rows;
    try {
      rows = store.listEvents({ table_name: PROACTIVE_EVENT_TABLE, limit: 500 });
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const detail = parseDetail(row?.detail_json);
      if (detail?.kind !== 'proactive_sent') continue;
      const seconds = Number(row?.at);
      if (!Number.isFinite(seconds)) continue;
      const sentAt = seconds * 1000;
      if (KINDS.includes(detail.msgKind) && dayKey(sentAt, timeZone) === state.dayKey) {
        state.sentToday += 1;
        state.byKind[detail.msgKind] += 1;
      }
      const key = typeof detail.dedupeKey === 'string' ? detail.dedupeKey : '';
      if (key !== '') {
        const previous = dedupe.get(key);
        if (previous === undefined || sentAt > previous) dedupe.set(key, sentAt);
      }
    }
  }

  seedFromStore();

  /** 跨天后重置当日预算。 */
  function ensureDay(at) {
    const key = dayKey(at, timeZone);
    if (key === state.dayKey) return;
    state.dayKey = key;
    state.sentToday = 0;
    state.byKind = { task_report: 0, reminder: 0, chat: 0 };
  }

  /** 写发送记账事件；写库失败不影响投递结果（只记入报告）。 */
  function recordSent(item, at) {
    const seconds = Math.floor(at / 1000);
    store.appendEvent({
      at: seconds,
      action: 'USED',
      table_name: PROACTIVE_EVENT_TABLE,
      row_id: null,
      actor: 'scheduler',
      reason: `proactive:${item.kind}`,
      detail_json: {
        kind: 'proactive_sent',
        msgKind: item.kind,
        text: item.text,
        dedupeKey: item.dedupeKey,
        at: seconds,
      },
    });
  }

  /**
   * 入队（同步）。backlog 超过 MAX_BACKLOG 时丢弃最旧的一条。
   * @param {{kind?: string, text: string, dedupeKey?: string, at?: number|Date,
   *   onAttempt?: Function, onSent?: Function, onFailed?: Function}} msg
   * @returns {{queued: number, dropped: number}}
   */
  function enqueue(msg) {
    if (msg === null || typeof msg !== 'object') {
      throw new TypeError('enqueue(msg): message must be an object');
    }
    const kind = msg.kind ?? 'chat';
    if (!KINDS.includes(kind)) {
      throw new TypeError(`enqueue(msg): unknown kind "${String(kind)}"`);
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (text === '') {
      throw new TypeError('enqueue(msg): text must be a non-empty string');
    }
    const dedupeKey = typeof msg.dedupeKey === 'string' && msg.dedupeKey.trim() !== ''
      ? msg.dedupeKey.trim()
      : null;
    const at = msg.at === undefined ? nowMs() : normalizeNow(msg.at);
    const hooks = [];
    if (typeof msg.onAttempt === 'function' || typeof msg.onSent === 'function'
      || typeof msg.onFailed === 'function') {
      hooks.push({ onAttempt: msg.onAttempt, onSent: msg.onSent, onFailed: msg.onFailed });
    }

    queue.push({ kind, text, at, seq: seq++, dedupeKey, hooks });
    while (queue.length > MAX_BACKLOG) {
      const droppedItem = queue.shift();
      dropped += 1;
      runHooks(droppedItem, 'onFailed');
    }
    return { queued: queue.length, dropped };
  }

  /**
   * 执行一条消息上的某类钩子；钩子异常只记入报告，不影响闸门计数。
   * @param {object|null} item
   * @param {'onAttempt'|'onSent'|'onFailed'} name
   * @param {{error?: unknown}} [report]
   * @returns {boolean} 是否全部允许（onAttempt 返回 false 表示放弃该条）
   */
  function runHooks(item, name, report) {
    if (item === null || item === undefined || !Array.isArray(item.hooks)) return true;
    let allowed = true;
    for (const hook of item.hooks) {
      const fn = hook?.[name];
      if (typeof fn !== 'function') continue;
      try {
        if (fn() === false) allowed = false;
      } catch (error) {
        if (report !== undefined) report.error = report.error ?? error;
        else console.warn('[proactive] hook failed:', error);
      }
    }
    return allowed;
  }

  /**
   * 执行一轮投递。串行化；安静时段只计数不取队列。
   * @param {number|Date} [now]
   * @returns {Promise<{sent: number, deferred: number, suppressed: number, merged: number,
   *   failed: number, quiet: boolean, items: {kind: string, text: string}[]}>}
   */
  function flush(now = nowMs()) {
    const at = normalizeNow(now);
    const run = chain.then(() => flushInternal(at));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** @param {number} at */
  async function flushInternal(at) {
    ensureDay(at);
    const report = {
      sent: 0,
      deferred: 0,
      suppressed: 0,
      merged: 0,
      failed: 0,
      quiet: false,
      items: [],
    };

    if (isQuietAt(new Date(at), quietConfig)) {
      report.quiet = true;
      report.deferred = queue.length;
      return report;
    }

    // 第一遍：预算 / 单类 / dedupe / 合并，产出本轮候选
    /** @type {{kind: string, text: string, at: number, seq: number, dedupeKey: string|null}[]} */
    const candidates = [];
    while (queue.length > 0) {
      const head = queue[0];
      if (head.at > at) break; // 尚未到点的消息不提前发
      if (state.sentToday + candidates.length >= dailyCap) break; // 到日上限：保留 backlog

      queue.shift();

      const plannedKind = state.byKind[head.kind]
        + candidates.filter((item) => item.kind === head.kind).length;
      if (plannedKind >= KIND_CAPS[head.kind]) {
        report.suppressed += 1;
        continue;
      }

      if (head.dedupeKey !== null) {
        const lastSentAt = dedupe.get(head.dedupeKey);
        const recentlySent = lastSentAt !== undefined && at - lastSentAt < DEDUPE_WINDOW_MS;
        const queuedDuplicate = candidates.some((item) => item.dedupeKey === head.dedupeKey);
        if (recentlySent || queuedDuplicate) {
          report.suppressed += 1;
          continue;
        }
      }

      const previous = candidates.length > 0 ? candidates[candidates.length - 1] : null;
      if (previous !== null && previous.kind === head.kind
        && Math.abs(head.at - previous.at) <= MERGE_WINDOW_MS) {
        previous.text = `${previous.text}\n\n${head.text}`;
        if (Array.isArray(previous.hooks)) previous.hooks.push(...head.hooks);
        if (previous.dedupeKey === null) previous.dedupeKey = head.dedupeKey;
        report.merged += 1;
        continue;
      }

      candidates.push({ ...head });
    }

    // 第二遍：真正投递；失败时把剩余候选放回队首，保留 backlog
    // 主会话 id 每轮解析一次；取不到与投递失败同路径（保留 backlog 等下次重试）
    let sessionId = null;
    try {
      const resolved = target();
      sessionId = typeof resolved === 'string' && resolved.trim() !== '' ? resolved : null;
    } catch (error) {
      report.error = error;
      sessionId = null;
    }
    if (sessionId === null) {
      const remaining = candidates.map((candidate) => ({ ...candidate }));
      queue.unshift(...remaining);
      for (const candidate of remaining) runHooks(candidate, 'onFailed', report);
      if (candidates.length > 0) report.failed += 1;
      report.error = report.error ?? new Error('[proactive] no main session');
      report.deferred += queue.length;
      return report;
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      // 投递前钩子：返回 false 表示本轮放弃该条（如提醒已被取消/已到重试上限）
      if (!runHooks(item, 'onAttempt', report)) {
        report.suppressed += 1;
        continue;
      }
      try {
        await platform.prompt(sessionId, item.text);
      } catch (error) {
        report.failed += 1;
        const remaining = candidates.slice(index).map((candidate) => ({ ...candidate }));
        for (const candidate of remaining) runHooks(candidate, 'onFailed', report);
        queue.unshift(...remaining);
        report.error = error;
        break;
      }

      state.sentToday += 1;
      state.byKind[item.kind] += 1;
      if (item.dedupeKey !== null) dedupe.set(item.dedupeKey, at);
      report.sent += 1;
      report.items.push({ kind: item.kind, text: item.text });
      runHooks(item, 'onSent', report);
      try {
        recordSent(item, at);
      } catch (error) {
        report.error = report.error ?? error;
      }
    }

    report.deferred += queue.length;
    return report;
  }

  /**
   * 当前闸门状态。
   * @param {number|Date} [now]
   * @returns {{dayKey: string, cap: number, sentToday: number, remainingToday: number,
   *   byKind: Record<string, number>, backlog: number, quiet: boolean, dropped: number}}
   */
  function stats(now = nowMs()) {
    const at = normalizeNow(now);
    ensureDay(at);
    return {
      dayKey: state.dayKey,
      cap: dailyCap,
      sentToday: state.sentToday,
      remainingToday: Math.max(0, dailyCap - state.sentToday),
      byKind: { ...state.byKind },
      backlog: queue.length,
      quiet: isQuietAt(new Date(at), quietConfig),
      dropped,
    };
  }

  return { enqueue, flush, stats };
}
