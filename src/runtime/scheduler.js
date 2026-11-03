/**
 * T9 调度器：6 个内置定时任务。
 *
 * 设计口径（06 v3.3 §9、05 v3.0 §2.1）：
 * - 间隔任务：idle-probe 每 60s、reminders 每 30s；
 * - 每日任务：deep-sleep 03:00、s2-purge 03:30、backup 04:00、
 *   thread-freeze 03:00（全部按本地时区 Date 计算，不写死 UTC 偏移）；
 * - 每次触发把 lastRunAt 以 memory_events 事件（detail.kind='job_run'）落库，
 *   重启后从事件恢复；启动时若每日任务在 catchUpWindowMs（默认 6h）内漏跑，
 *   补跑一次；超出补扫窗口的当日任务直接放弃，避免拖到白天突然补跑；
 * - 同一 job 不重入：上一次还在跑（handler 返回 Promise 未 settle）时跳过。
 *
 * 本模块只负责「何时触发」；任务体由调用方通过 jobs 注入（job id → 函数），
 * 未注入的 job 只记录触发事件，不执行任何业务。仅使用 Node 内置能力。
 */

/**
 * 内置任务表。`at` 仅用于展示/测试，真正计算用 `atMinutes`（本地分钟）。
 * @type {ReadonlyArray<Readonly<{id: string, kind: 'interval'|'daily',
 *   intervalMs?: number, at?: string, atMinutes?: number}>>}
 */
export const JOB_SPECS = Object.freeze([
  Object.freeze({ id: 'idle-probe', kind: 'interval', intervalMs: 60_000 }),
  Object.freeze({ id: 'reminders', kind: 'interval', intervalMs: 30_000 }),
  Object.freeze({ id: 'deep-sleep', kind: 'daily', at: '03:00', atMinutes: 3 * 60 }),
  Object.freeze({ id: 's2-purge', kind: 'daily', at: '03:30', atMinutes: 3 * 60 + 30 }),
  Object.freeze({ id: 'backup', kind: 'daily', at: '04:00', atMinutes: 4 * 60 }),
  Object.freeze({ id: 'thread-freeze', kind: 'daily', at: '03:00', atMinutes: 3 * 60 }),
]);

/** 6 个内置 job id（固定顺序）。 */
export const JOB_IDS = Object.freeze(JOB_SPECS.map((spec) => spec.id));

/** memory_events 里调度事件的 table_name。 */
export const JOB_EVENT_TABLE = 'scheduler_jobs';

/** @param {unknown} value @returns {number} 毫秒时间戳 */
function normalizeNow(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('[scheduler] invalid Date');
    return ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`[scheduler] invalid time: ${String(value)}`);
}

/** @param {number} ms @returns {string} 本地日期键，用于「当日只跑一次」 */
function localDayKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 本地时区里「当天 HH:MM」的毫秒时间戳。
 * 用 setHours 而不是 UTC 偏移，DST 切换交给 Date 归一化。
 * @param {number} ms
 * @param {number} minutes 0..1439
 * @returns {number}
 */
function scheduleToday(ms, minutes) {
  const date = new Date(ms);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
}

/** @param {number} ms @param {number} days @returns {number} */
function addLocalDays(ms, days) {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
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
 * 创建调度器。所有时间都过 `clock()`，测试可注入假时钟复现。
 *
 * @param {object} options
 * @param {() => number|Date} [options.clock]
 * @param {object} options.store 需提供 appendEvent / listEvents（memory_events）
 * @param {Record<string, Function>|Function} [options.jobs] job id → handler；
 *   也可以是 (now, context) => ... 的统一 handler
 * @param {number} [options.tickMs] 定时器 tick，默认 30s
 * @param {number} [options.catchUpWindowMs] 启动补扫窗口，默认 6h
 * @param {Function} [options.timer] setInterval 替身
 * @param {Function} [options.clearTimer] clearInterval 替身
 * @returns {{start: Function, stop: Function, runDue: Function, listJobs: Function}}
 */
export function createScheduler({
  clock = Date.now,
  store,
  jobs = {},
  tickMs = 30_000,
  catchUpWindowMs = 6 * 3600 * 1000,
  timer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createScheduler(store): store must be an object');
  }
  if (typeof store.appendEvent !== 'function') {
    throw new TypeError('createScheduler(store): store.appendEvent is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createScheduler(clock): clock must be a function');
  }
  if (typeof timer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('createScheduler(timer): timer and clearTimer must be functions');
  }
  if (!(Number.isFinite(tickMs) && tickMs > 0)) {
    throw new TypeError(`createScheduler(tickMs): must be a positive number, got ${tickMs}`);
  }
  if (!(Number.isFinite(catchUpWindowMs) && catchUpWindowMs >= 0)) {
    throw new TypeError(`createScheduler(catchUpWindowMs): must be >= 0, got ${catchUpWindowMs}`);
  }
  if (jobs !== null && typeof jobs !== 'object' && typeof jobs !== 'function') {
    throw new TypeError('createScheduler(jobs): must be a map or a function');
  }

  /** @type {Map<string, number>} 上次触发时间（ms） */
  const lastRunAt = new Map();
  /** @type {Set<string>} 正在运行、尚未 settle 的 job */
  const running = new Set();
  /** @type {Set<string>} `${jobId}:${dayKey}`，当日漏跑且超出补扫窗口 */
  const suppressed = new Set();
  /** @type {unknown[]} 最近调度/任务错误（诊断用） */
  const errors = [];

  let started = false;
  /** @type {unknown} */
  let timerHandle = null;

  const nowMs = () => normalizeNow(clock());

  /**
   * 从 memory_events 恢复 lastRunAt：取该 job 最近一条 kind='job_run' 事件。
   * @param {string} id
   * @returns {number|null}
   */
  function readLastRunAt(id) {
    if (typeof store.listEvents !== 'function') return null;
    let rows;
    try {
      rows = store.listEvents({ table_name: JOB_EVENT_TABLE, row_id: id, limit: 20 });
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const detail = parseDetail(row?.detail_json);
      if (detail?.kind !== 'job_run' || detail.jobId !== id) continue;
      const seconds = Number(row?.at);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
    return null;
  }

  /** 写一条 job_run 事件（失败不阻断调度）。 */
  function persistJobRun(spec, at, trigger) {
    const seconds = Math.floor(at / 1000);
    store.appendEvent({
      at: seconds,
      action: 'USED',
      table_name: JOB_EVENT_TABLE,
      row_id: spec.id,
      actor: 'scheduler',
      reason: `job_run:${spec.id}`,
      detail_json: {
        kind: 'job_run',
        jobId: spec.id,
        jobKind: spec.kind,
        trigger,
        at: seconds,
      },
    });
  }

  /** 写一条 job_error 事件（失败不阻断调度）。 */
  function persistJobError(spec, error, trigger, at) {
    const seconds = Math.floor(at / 1000);
    store.appendEvent({
      at: seconds,
      action: 'USED',
      table_name: JOB_EVENT_TABLE,
      row_id: spec.id,
      actor: 'scheduler',
      reason: `job_error:${spec.id}`,
      detail_json: {
        kind: 'job_error',
        jobId: spec.id,
        trigger,
        message: error instanceof Error ? error.message : String(error),
        at: seconds,
      },
    });
  }

  /** @param {() => void} fn */
  function safePersist(fn) {
    try {
      fn();
    } catch (error) {
      errors.push(error);
    }
  }

  /** @param {string} id @returns {Function|null} */
  function handlerFor(id) {
    if (typeof jobs === 'function') return jobs;
    const handler = jobs?.[id];
    return typeof handler === 'function' ? handler : null;
  }

  /**
   * 触发一个 job：先记 lastRunAt/事件，再执行 handler。
   * @param {object} spec
   * @param {number} at
   * @param {'schedule'|'catch-up'} trigger
   * @returns {{id: string, status: 'ran'|'started'|'error', error?: unknown}}
   */
  function invoke(spec, at, trigger) {
    running.add(spec.id);
    lastRunAt.set(spec.id, at);
    safePersist(() => persistJobRun(spec, at, trigger));

    const handler = handlerFor(spec.id);
    const context = Object.freeze({ id: spec.id, trigger, spec });
    let result;
    try {
      result = handler === null ? undefined : handler(at, context);
    } catch (error) {
      running.delete(spec.id);
      errors.push(error);
      safePersist(() => persistJobError(spec, error, trigger, at));
      return { id: spec.id, status: 'error', error };
    }

    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(
        () => {
          running.delete(spec.id);
        },
        (error) => {
          running.delete(spec.id);
          errors.push(error);
          safePersist(() => persistJobError(spec, error, trigger, at));
        },
      );
      return { id: spec.id, status: 'started' };
    }

    running.delete(spec.id);
    return { id: spec.id, status: 'ran' };
  }

  /** @param {object} spec @param {number} at @returns {boolean} */
  function isDue(spec, at) {
    if (spec.kind === 'interval') {
      const last = lastRunAt.get(spec.id);
      return last === undefined || last === null || at - last >= spec.intervalMs;
    }
    const scheduled = scheduleToday(at, spec.atMinutes);
    if (at < scheduled) return false;
    if (at - scheduled > catchUpWindowMs) {
      suppressed.add(`${spec.id}:${localDayKey(at)}`);
      return false;
    }
    if (suppressed.has(`${spec.id}:${localDayKey(at)}`)) return false;
    const last = lastRunAt.get(spec.id);
    return last === undefined || last === null || last < scheduled;
  }

  /**
   * 跑一遍到期的 job（同步触发；异步 handler 只登记 running）。
   * @param {number|Date} [now]
   * @returns {{now: number, ran: string[], skipped: object[], errors: object[]}}
   */
  function runDue(now = nowMs()) {
    const at = normalizeNow(now);
    const report = { now: at, ran: [], skipped: [], errors: [] };
    for (const spec of JOB_SPECS) {
      if (!isDue(spec, at)) continue;
      if (running.has(spec.id)) {
        report.skipped.push({ id: spec.id, reason: 'running' });
        continue;
      }
      const outcome = invoke(spec, at, 'schedule');
      if (outcome.status === 'error') {
        report.errors.push({ id: spec.id, error: outcome.error });
      }
      report.ran.push(spec.id);
    }
    return report;
  }

  /**
   * 启动：先补扫 6h 内漏跑的每日任务，再挂 tick 定时器。幂等。
   * @param {number|Date} [now]
   * @returns {{started: boolean, catchUp: string[]}}
   */
  function start(now = nowMs()) {
    if (started) return { started: true, catchUp: [] };
    const at = normalizeNow(now);
    started = true;

    const catchUp = [];
    for (const spec of JOB_SPECS) {
      if (spec.kind !== 'daily' || running.has(spec.id)) continue;
      const scheduled = scheduleToday(at, spec.atMinutes);
      if (at < scheduled) continue;
      const last = lastRunAt.get(spec.id);
      if (last !== undefined && last !== null && last >= scheduled) continue;
      if (suppressed.has(`${spec.id}:${localDayKey(at)}`)) continue;
      if (at - scheduled > catchUpWindowMs) {
        suppressed.add(`${spec.id}:${localDayKey(at)}`);
        continue;
      }
      invoke(spec, at, 'catch-up');
      catchUp.push(spec.id);
    }

    timerHandle = timer(() => {
      try {
        runDue();
      } catch (error) {
        errors.push(error);
      }
    }, tickMs);
    if (timerHandle !== null && typeof timerHandle === 'object'
      && typeof timerHandle.unref === 'function') {
      timerHandle.unref();
    }
    return { started: true, catchUp };
  }

  /** 停止定时器。幂等。 */
  function stop() {
    if (!started) return { stopped: true };
    started = false;
    if (timerHandle !== null && timerHandle !== undefined) {
      clearTimer(timerHandle);
      timerHandle = null;
    }
    return { stopped: true };
  }

  /**
   * 列出 6 个 job 的状态与下一次应触发时间。
   * @param {number|Date} [now]
   * @returns {object[]}
   */
  function listJobs(now = nowMs()) {
    const at = normalizeNow(now);
    return JOB_SPECS.map((spec) => {
      const last = lastRunAt.get(spec.id) ?? null;
      const base = {
        id: spec.id,
        kind: spec.kind,
        lastRunAt: last,
        running: running.has(spec.id),
      };
      if (spec.kind === 'interval') {
        return {
          ...base,
          intervalMs: spec.intervalMs,
          nextRunAt: (last ?? at) + spec.intervalMs,
        };
      }
      const scheduled = scheduleToday(at, spec.atMinutes);
      const suppressedToday = suppressed.has(`${spec.id}:${localDayKey(at)}`);
      let nextRunAt;
      if (at < scheduled) {
        nextRunAt = scheduled;
      } else if (suppressedToday || (last !== null && last >= scheduled)) {
        nextRunAt = addLocalDays(scheduled, 1);
      } else {
        nextRunAt = scheduled;
      }
      return {
        ...base,
        at: spec.at,
        atMinutes: spec.atMinutes,
        nextRunAt,
      };
    });
  }

  // 构造时恢复水位：间隔任务没有历史时以当前时刻为基线（启动后过一整个
  // 周期才首次触发）；每日任务若今天已过点且超出补扫窗口，当日标记放弃。
  const initAt = nowMs();
  for (const spec of JOB_SPECS) {
    const persisted = readLastRunAt(spec.id);
    if (persisted !== null) lastRunAt.set(spec.id, persisted);
    else if (spec.kind === 'interval') lastRunAt.set(spec.id, initAt);
  }
  for (const spec of JOB_SPECS) {
    if (spec.kind !== 'daily') continue;
    const scheduled = scheduleToday(initAt, spec.atMinutes);
    const last = lastRunAt.get(spec.id);
    if (initAt >= scheduled && (last === undefined || last === null || last < scheduled)
      && initAt - scheduled > catchUpWindowMs) {
      suppressed.add(`${spec.id}:${localDayKey(initAt)}`);
    }
  }

  return { start, stop, runDue, listJobs };
}
