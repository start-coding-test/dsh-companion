/**
 * 线程目录（06 v3.3 §2.5 / §6.1.1，05 §6.3）：线程命名、复用/新建判定，
 * 以及空闲 14 天冻结。
 *
 * 约定：
 * - `planThreadRun()` 只读 Store（getThread/listThreads），不写库；真正的
 *   `createSession(preset=config.thread.agentPreset（未配置用宿主默认）, scope='thread:<key>')`
 *   与 `threads` 行写入由上层 thread_run 工具完成（本卡只有目录规则）。
 * - 同时活跃线程上限 6；超限拒绝而不是静默冻结（冻结由每日 03:00 的
 *   `freezeIdleThreads()` 负责）。
 * - Store 的线程状态是 active|archived|retired（v3.3 无 frozen 字面量），
 *   冻结即 archived；命中 archived 的 key 视为「可复用/需解冻」，返回
 *   reuse 让上层走 unarchiveSession，而不是新建。
 */

/** 同时活跃线程上限（05 §6.3）。 */
export const MAX_ACTIVE_THREADS = 6;

/** 线程空闲天数阈值（05 §6.3 / 06 v3.3 §2.6）。 */
export const THREAD_IDLE_DAYS = 14;

/** `thread_run(key='new')` 的占位 key。 */
export const NEW_THREAD_KEY = 'new';

/** 线程 key/短名长度上限（按 Unicode 码点计）。 */
export const THREAD_NAME_MAX = 24;

/** 一天秒数，与 SQLite unixepoch() 对齐。 */
const SECONDS_PER_DAY = 86_400;

/** 控制字符（C0、DEL、C1）；用户输入里出现时直接去掉。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * 把用户给的中文短名整理成线程 key：去首尾空白、空白→'-'、去掉控制字符、
 * 压缩连续 '-'、最长 24 个码点。整理后为空则抛错（调用方据此拒绝）。
 *
 * @param {string} name 原始短名（例如「租房 攻略」）
 * @returns {string} 清洗后的短名（例如「租房-攻略」）
 */
export function normalizeThreadName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('thread name must be a non-empty string');
  }
  const collapsed = name
    // 空白（含 tab/换行）先变 '-'，再清掉其它控制字符（NUL、C1 等）。
    .replace(/\s+/g, '-')
    .replace(CONTROL_CHARS, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed === '') {
    throw new TypeError('thread name must be a non-empty string');
  }
  const truncated = Array.from(collapsed).slice(0, THREAD_NAME_MAX).join('');
  const cleaned = truncated.replace(/-+$/g, '');
  if (cleaned === '') {
    throw new TypeError('thread name must be a non-empty string');
  }
  return cleaned;
}

/**
 * 判定一次 thread_run 该复用、新建还是拒绝（只读，不写库）。
 *
 * 规则（05 §6.3）：
 * - key 已存在且 active → reuse；
 * - key 已存在但已冻结/退役 → reuse（上层负责 unarchiveSession 后继续）；
 * - key 不存在且不是 'new' → create（沿用调用方给的 key，可能撞上限）；
 * - key === 'new' → 必须带合法 name，生成的 key 由 name 派生，重名加 -2/-3…；
 * - 下一步会新增线程且活跃数已到 maxActive → reject('too-many-threads')。
 *
 * @param {object} options
 * @param {object} options.store Store 实例（getThread/listThreads）
 * @param {string} options.key thread_run 的 key（已有 key 或 'new'）
 * @param {string} [options.name] 中文短名，仅 key==='new' 时必需
 * @param {number} [options.maxActive=6] 活跃线程上限
 * @param {number} [options.now] 预留（本函数不读时钟），保持与卡片签名一致
 * @param {number} [options.idleDays=14] 预留（冻结由 freezeIdleThreads 负责）
 * @returns {{action: 'reuse'|'create'|'reject', key: string, reason: string}}
 */
export function planThreadRun(options = {}) {
  const {
    store,
    key,
    name,
    maxActive = MAX_ACTIVE_THREADS,
  } = options;
  assertStore(store, 'planThreadRun');
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('planThreadRun: key must be a non-empty string');
  }
  if (typeof maxActive !== 'number' || !Number.isInteger(maxActive) || maxActive < 1) {
    throw new TypeError('planThreadRun: maxActive must be a positive integer');
  }

  const wanted = key.trim();

  // 已有 key：active 直接复用；已冻结/退役也复用（先解冻再续聊）。
  const existing = store.getThread(wanted);
  if (existing !== null && existing !== undefined) {
    if (existing.status === 'active') {
      return { action: 'reuse', key: wanted, reason: 'active-thread' };
    }
    return { action: 'reuse', key: wanted, reason: `reactivate-${existing.status ?? 'inactive'}` };
  }

  if (wanted !== NEW_THREAD_KEY) {
    if (countActiveThreads(store) >= maxActive) {
      return { action: 'reject', key: wanted, reason: 'too-many-threads' };
    }
    return { action: 'create', key: wanted, reason: 'explicit-key' };
  }

  // key === 'new'：没有合法中文短名无法建 key。
  let base;
  try {
    base = normalizeThreadName(name);
  } catch {
    return { action: 'reject', key: NEW_THREAD_KEY, reason: 'name-required' };
  }

  if (countActiveThreads(store) >= maxActive) {
    return { action: 'reject', key: NEW_THREAD_KEY, reason: 'too-many-threads' };
  }

  const generated = uniqueKey(store, base);
  if (generated === null) {
    return { action: 'reject', key: NEW_THREAD_KEY, reason: 'key-exhausted' };
  }
  return { action: 'create', key: generated, reason: 'new-thread' };
}

/**
 * 冻结空闲超过 idleDays 的活跃线程（05 §6.3：每日 03:00 扫描）。
 *
 * 只处理 status='active' 的行；last_active_at 严格小于 now-idleDays 才冻结，
 * 边界（恰好 idleDays 天）不冻结。冻结走 Store.freezeThread（默认 archived），
 * 平台会话的 archiveSession({stopActivity:true}) 由调用方接着做。
 *
 * @param {object} store Store 实例（listThreads/freezeThread）
 * @param {number|Date} [now=Date.now()] 当前时间：毫秒时间戳、秒或 Date
 * @param {number} [idleDays=14] 空闲天数阈值
 * @returns {number} 被冻结的线程数
 */
export function freezeIdleThreads(store, now = Date.now(), idleDays = THREAD_IDLE_DAYS) {
  assertStore(store, 'freezeIdleThreads');
  if (typeof store.freezeThread !== 'function') {
    throw new TypeError('freezeIdleThreads: store must provide freezeThread()');
  }
  if (typeof idleDays !== 'number' || !Number.isFinite(idleDays) || idleDays < 0) {
    throw new TypeError('freezeIdleThreads: idleDays must be a non-negative number');
  }
  const nowSeconds = toSeconds(now, 'now');
  const cutoff = nowSeconds - Math.floor(idleDays * SECONDS_PER_DAY);

  let frozen = 0;
  for (const thread of store.listThreads({ status: 'active', limit: 500 })) {
    const lastActive = thread.last_active_at === null || thread.last_active_at === undefined
      ? 0
      : toSeconds(thread.last_active_at, 'last_active_at');
    if (lastActive < cutoff) {
      const updated = store.freezeThread(thread.key);
      if (updated !== null && updated !== undefined) frozen += 1;
    }
  }
  return frozen;
}

/**
 * @param {object} store
 * @param {string} caller
 */
function assertStore(store, caller) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError(`${caller}: store must be a Store instance`);
  }
  if (typeof store.getThread !== 'function' || typeof store.listThreads !== 'function') {
    throw new TypeError(`${caller}: store must provide getThread()/listThreads()`);
  }
}

/**
 * @param {object} store
 * @returns {number} 活跃线程数
 */
function countActiveThreads(store) {
  return store.listThreads({ status: 'active', limit: 500 }).length;
}

/**
 * 在 24 码点预算内生成不冲突的 key：base、base-2、base-3…
 * @param {object} store
 * @param {string} base
 * @returns {string|null} 全部后缀都占用时返回 null
 */
function uniqueKey(store, base) {
  const taken = (candidate) => store.getThread(candidate) !== null
    && store.getThread(candidate) !== undefined;
  if (!taken(base)) return base;

  for (let n = 2; n <= 1000; n += 1) {
    const suffix = `-${n}`;
    const room = THREAD_NAME_MAX - Array.from(suffix).length;
    const head = Array.from(base)
      .slice(0, Math.max(1, room))
      .join('')
      .replace(/-+$/g, '');
    const candidate = `${head}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

/**
 * 毫秒时间戳、秒或 Date 一律转 Unix 秒（>1e12 视为毫秒）。
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function toSeconds(value, label) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new TypeError(`${label} must be a valid Date or timestamp`);
    return Math.floor(ms / 1000);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new TypeError(`${label} must be a Date or timestamp`);
  }
  return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
}
