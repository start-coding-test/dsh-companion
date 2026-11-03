/**
 * T9 调度器：6 个内置定时任务。
 *
 * 设计口径（06 v3.3 §9、05 v3.0 §2.1）：
 * - 间隔任务：idle-probe 每 60s、reminders 每 30s；
 * - 每日任务：deep-sleep 03:00、s2-purge 03:30、backup 04:00、
 *   thread-freeze 03:00（全部按配置时区 config.timezone 的分区墙上时间计算，
 *   不读 process.env.TZ、不写死 UTC 偏移）；
 * - 每次触发把 lastRunAt 以 memory_events 事件（detail.kind='job_run'）落库，
 *   重启后从事件恢复；启动时若每日任务在 catchUpWindowMs（默认 6h）内漏跑，
 *   补跑一次；超出补扫窗口的当日任务直接放弃，避免拖到白天突然补跑；
 * - 同一 job 不重入：上一次还在跑（handler 返回 Promise 未 settle）时跳过。
 *
 * 本模块只负责「何时触发」；任务体由调用方通过 jobs 注入（job id → 函数），
 * 未注入的 job 只记录触发事件，不执行任何业务。仅使用 Node 内置能力。
 */

import {
  DEFAULT_TIMEZONE,
  addDaysToDayKey,
  dayKeyToParts,
  isValidTimeZone,
  zonedDayKey,
  zonedParts,
  zonedTimeToInstant,
} from '../time.js';

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

/** @param {number} ms @param {string} timeZone @returns {string} 分区日期键，用于「当日只跑一次」 */
function localDayKey(ms, timeZone) {
  return zonedDayKey(ms, timeZone);
}

/**
 * 配置时区里「当天 HH:MM」的毫秒时间戳：先取分区墙上日期，再反解瞬时，
 * 跨夏令时由 Intl 归一化。
 * @param {number} ms
 * @param {number} minutes 0..1439
 * @param {string} timeZone
 * @returns {number}
 */
function scheduleToday(ms, minutes, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return zonedTimeToInstant({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
  }, timeZone);
}

/**
 * 同一分区墙上时间加 N 天（保留时分秒）。
 * @param {number} ms @param {number} days @param {string} timeZone @returns {number}
 */
function addLocalDays(ms, days, timeZone) {
  const parts = zonedParts(ms, timeZone);
  const shifted = dayKeyToParts(addDaysToDayKey(zonedDayKey(ms, timeZone), days));
  return zonedTimeToInstant({
    ...shifted,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }, timeZone);
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
 * @param {string} [options.timeZone=DEFAULT_TIMEZONE] 墙上时间所用 IANA 时区
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
  timeZone = DEFAULT_TIMEZONE,
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
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError(`createScheduler(timeZone): unknown IANA time zone "${String(timeZone)}"`);
  }

  /** @type {Map<string, number>} 上次触发时间（ms） */
  const lastRunAt = new Map();
  /** @type {Set<string>} 正在运行、尚未 settle 的 job */
  const running = new Set();
  /** @type {Set<string>} `${jobId}:${dayKey}`，当日漏跑且超出补扫窗口 */
  const suppressed = new Set();
  /** @type {unknown[]} 最近调度/任务错误（诊断用） */
  const errors = [];
  /**
   * t17：每个 job 的连续失败状态（失败次数 + 最后错误）。
   * 从 memory_events 恢复；成功后清空，失败可被 /状态 与 listJobs 观察。
   * @type {Map<string, {attempts: number, lastError: string, lastErrorAt: number}>}
   */
  const failures = new Map();

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

  /**
   * t17：从事件里恢复最近一次失败状态。
   * 最新一条 job_run 代表后来跑过（可能成功），清空失败；job_retry 不是失败本身。
   * @param {string} id
   * @returns {{attempts: number, lastError: string, lastErrorAt: number}|null}
   */
  function readFailureState(id) {
    if (typeof store.listEvents !== 'function') return null;
    let rows;
    try {
      rows = store.listEvents({ table_name: JOB_EVENT_TABLE, row_id: id, limit: 50 });
    } catch {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const detail = parseDetail(row?.detail_json);
      if (detail === null || detail.jobId !== id) continue;
      if (detail.kind === 'job_run') return null;
      if (detail.kind !== 'job_error') continue;
      const attempts = Number(detail.attempts);
      const seconds = Number(row?.at);
      return {
        attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 1,
        lastError: typeof detail.message === 'string' ? detail.message : '',
        lastErrorAt: Number.isFinite(seconds) ? seconds * 1000 : null,
      };
    }
    return null;
  }

  /**
   * t17：该 job 下一次按计划触发的时间（失败后用于审计「次日重试」）。
   * @param {object} spec
   * @param {number} at
   * @returns {number}
   */
  function nextScheduledAt(spec, at) {
    if (spec.kind === 'interval') return at + spec.intervalMs;
    const scheduled = scheduleToday(at, spec.atMinutes, timeZone);
    return at < scheduled ? scheduled : addLocalDays(scheduled, 1, timeZone);
  }

  /**
   * t17：记录一次失败并写 job_error/job_retry 事件。
   * 失败不抛给调用方；下一次到期（每日任务次日、间隔任务下个周期）自然重试。
   * @param {object} spec
   * @param {unknown} error
   * @param {string} trigger
   * @param {number} at
   */
  function recordFailure(spec, error, trigger, at) {
    const previous = failures.get(spec.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    failures.set(spec.id, { attempts, lastError: message, lastErrorAt: at });
    safePersist(() => persistJobError(spec, error, trigger, at, attempts));
    safePersist(() => persistJobRetry(spec, at, trigger, attempts));
  }

  /** 写一条 job_retry 事件（失败不阻断调度）。 */
  function persistJobRetry(spec, at, trigger, attempts) {
    const seconds = Math.floor(at / 1000);
    store.appendEvent({
      at: seconds,
      action: 'USED',
      table_name: JOB_EVENT_TABLE,
      row_id: spec.id,
      actor: 'scheduler',
      reason: `job_retry:${spec.id}`,
      detail_json: {
        kind: 'job_retry',
        jobId: spec.id,
        trigger,
        attempts,
        nextRetryAt: nextScheduledAt(spec, at),
        at: seconds,
      },
    });
  }

  /** 成功时清空连续失败状态。 @param {string} id */
  function recordSuccess(id) {
    failures.delete(id);
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

  /** 写一条 job_error 事件（失败不阻断调度；attempts 供恢复失败状态）。 */
  function persistJobError(spec, error, trigger, at, attempts = 1) {
    const seconds = Math.floor(at / 1000);
    const message = error instanceof Error ? error.message : String(error);
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
        message,
        last_error: message,
        attempts,
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
      recordFailure(spec, error, trigger, at);
      return { id: spec.id, status: 'error', error };
    }

    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(
        () => {
          running.delete(spec.id);
          recordSuccess(spec.id);
        },
        (error) => {
          running.delete(spec.id);
          errors.push(error);
          recordFailure(spec, error, trigger, at);
        },
      );
      return { id: spec.id, status: 'started' };
    }

    running.delete(spec.id);
    recordSuccess(spec.id);
    return { id: spec.id, status: 'ran' };
  }

  /** @param {object} spec @param {number} at @returns {boolean} */
  function isDue(spec, at) {
    if (spec.kind === 'interval') {
      const last = lastRunAt.get(spec.id);
      return last === undefined || last === null || at - last >= spec.intervalMs;
    }
    const scheduled = scheduleToday(at, spec.atMinutes, timeZone);
    if (at < scheduled) return false;
    if (at - scheduled > catchUpWindowMs) {
      suppressed.add(`${spec.id}:${localDayKey(at, timeZone)}`);
      return false;
    }
    if (suppressed.has(`${spec.id}:${localDayKey(at, timeZone)}`)) return false;
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
      const scheduled = scheduleToday(at, spec.atMinutes, timeZone);
      if (at < scheduled) continue;
      const last = lastRunAt.get(spec.id);
      if (last !== undefined && last !== null && last >= scheduled) continue;
      if (suppressed.has(`${spec.id}:${localDayKey(at, timeZone)}`)) continue;
      if (at - scheduled > catchUpWindowMs) {
        suppressed.add(`${spec.id}:${localDayKey(at, timeZone)}`);
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
      const failure = failures.get(spec.id) ?? null;
      const base = {
        id: spec.id,
        kind: spec.kind,
        lastRunAt: last,
        running: running.has(spec.id),
        attempts: failure?.attempts ?? 0,
        lastError: failure?.lastError ?? null,
        lastErrorAt: failure?.lastErrorAt ?? null,
      };
      if (spec.kind === 'interval') {
        return {
          ...base,
          intervalMs: spec.intervalMs,
          nextRunAt: (last ?? at) + spec.intervalMs,
        };
      }
      const scheduled = scheduleToday(at, spec.atMinutes, timeZone);
      const suppressedToday = suppressed.has(`${spec.id}:${localDayKey(at, timeZone)}`);
      let nextRunAt;
      if (at < scheduled) {
        nextRunAt = scheduled;
      } else if (suppressedToday || (last !== null && last >= scheduled)) {
        nextRunAt = addLocalDays(scheduled, 1, timeZone);
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
    const failure = readFailureState(spec.id);
    if (failure !== null) failures.set(spec.id, failure);
  }
  for (const spec of JOB_SPECS) {
    if (spec.kind !== 'daily') continue;
    const scheduled = scheduleToday(initAt, spec.atMinutes, timeZone);
    const last = lastRunAt.get(spec.id);
    if (initAt >= scheduled && (last === undefined || last === null || last < scheduled)
      && initAt - scheduled > catchUpWindowMs) {
      suppressed.add(`${spec.id}:${localDayKey(initAt, timeZone)}`);
    }
  }

  return { start, stop, runDue, listJobs };
}
