/**
 * T11 e2e 基础设施（卡片 t15）。
 *
 * 供 V2 遗忘闭环与后续 T11 集成测试复用，提供五件确定性小工具：
 *   1) makeTempStore —— mkdtemp + Store.open，返回 store 与幂等 cleanup；
 *   2) createClock   —— 固定时钟，now/advance 全部内存推进，不读真实时间；
 *   3) makeFakeLlm   —— 返回合法 consolidation 草稿的假模型（不联网）；
 *   4) seedMemory    —— 一次写入 facts/episodes/reminders 的 seed；
 *   5) forgetMemory / recallInjection —— V2 的测试侧封装：S1 遗忘语义
 *      （06 v3.3 §7.8）与「检索 → 30K 装配 → 注入文本」的端到端观察窗口。
 *
 * 约束：只用 node: 内置模块与仓库现有 src；不联网；临时文件只落在
 * os.tmpdir()，不写仓库外固定路径。
 *
 * 时间口径：本文件的 `now` 入参既接受 Date，也接受 Unix 秒或毫秒
 * （以 1e11 为界自动识别，与 retrieve.js 的 toMillis 一致）；落库统一转
 * Unix 秒（Store 的 DDL 约定）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assemble } from '../../src/memory/assemble.js';
import { retrieve } from '../../src/memory/retrieve.js';
import { Store } from '../../src/memory/store.js';

/** 一天的毫秒 / 秒。 */
export const DAY_MS = 86_400_000;
export const DAY_SECONDS = 86_400;

/** 固定基准时刻：2026-11-05T09:00:00Z，让所有断言与真实日期无关。 */
export const TEST_NOW = Date.UTC(2026, 10, 5, 9, 0, 0);

/** 秒 / 毫秒判别阈值（1e11 秒已远超 5138 年，与 retrieve.js 保持一致）。 */
const EPOCH_THRESHOLD = 1e11;

/**
 * 时间戳归一化到毫秒；接受 Date / Unix 秒 / Unix 毫秒。
 * @param {Date|number|string} value
 * @returns {number}
 */
export function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('invalid Date timestamp');
    return ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw new TypeError(`invalid timestamp: ${String(value)}`);
  return Math.abs(num) < EPOCH_THRESHOLD ? num * 1000 : num;
}

/**
 * 时间戳归一化到 Unix 秒（Store 落库口径）。
 * @param {Date|number|string} value
 * @returns {number}
 */
export function toEpochSeconds(value) {
  return Math.floor(toMillis(value) / 1000);
}

/**
 * 轮询等待异步副作用（M3：巩固由 setImmediate 排到 step 之后）完成。
 *
 * 使用真实计时器而非 FakeCtx 的手动时钟；predicate 返回真值即返回该值。
 *
 * @param {() => any} predicate
 * @param {{timeoutMs?: number, intervalMs?: number, label?: string}} [options]
 * @returns {Promise<any>}
 */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 让出真实事件循环一小段时间，等已排队的后台任务收尾。
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
export async function settle(ms = 25) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 建一个临时 SQLite 库。
 *
 * 传 `t`（node:test 的 TestContext）时自动注册 `t.after(cleanup)`，测试结束
 * 关闭连接并删除整个临时目录；也可以手动调用返回的 cleanup（幂等）。
 *
 * @param {{t?: {after?: Function}, prefix?: string}} [options]
 * @returns {{store: Store, dir: string, dbPath: string, cleanup: () => void}}
 */
export function makeTempStore(options = {}) {
  const { t = null, prefix = 'dsh-companion-e2e-' } = options;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'companion.db');
  const store = Store.open(dbPath);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      store.close();
    } catch {
      // 连接已关闭时继续清理目录，避免掩盖测试本身的失败。
    }
    rmSync(dir, { recursive: true, force: true });
  };
  if (t && typeof t.after === 'function') t.after(cleanup);
  return { store, dir, dbPath, cleanup };
}

/**
 * 固定时钟：只做内存加减，便于断言冷静期 / 遗忘曲线等时间语义。
 * @param {Date|number} [start] 默认 TEST_NOW（毫秒）
 * @returns {{now: () => number, ms: () => number, seconds: () => number,
 *            advance: (ms?: number) => number, advanceDays: (days?: number) => number,
 *            set: (value: Date|number) => number}}
 */
export function createClock(start = TEST_NOW) {
  let current = toMillis(start);
  const step = (delta) => {
    const num = Number(delta);
    if (!Number.isFinite(num)) throw new TypeError(`invalid clock delta: ${String(delta)}`);
    current += num;
    return current;
  };
  return {
    now: () => current,
    ms: () => current,
    seconds: () => Math.floor(current / 1000),
    advance: (ms = 0) => step(ms),
    advanceDays: (days = 0) => step(Math.round(Number(days) * DAY_MS)),
    set: (value) => {
      current = toMillis(value);
      return current;
    },
  };
}

/**
 * 合法 consolidation 草稿（字段与 consolidate.js 的 normalizeDraft 对齐）。
 * @param {object} [overrides] 顶层覆盖：episode / facts / reminders 整体替换
 * @returns {{episode: object, facts: object[], reminders: object[]}}
 */
export function makeDraft(overrides = {}) {
  return {
    episode: {
      title: '聊了青柠计划的分阶段安排',
      summary: '用户说青柠计划的代号是蓝鲸，下一步先做预算。',
      topics: ['青柠计划'],
      salience: 'normal',
      fidelity: 'full',
      ...(overrides.episode ?? {}),
    },
    facts: overrides.facts ?? [
      {
        kind: 'project',
        subject_text: '青柠计划',
        predicate: '代号',
        object_text: '蓝鲸',
        statement: '青柠计划的代号是蓝鲸。',
        source_kind: 'consolidated',
        source_excerpt: '用户：青柠计划的代号是蓝鲸。',
        salience: 'normal',
      },
    ],
    reminders: overrides.reminders ?? [
      {
        kind: 'todo',
        title: '跟进青柠计划的预算',
        detail: '本周给出预算范围。',
        due_granularity: 'day',
      },
    ],
  };
}

/**
 * 假模型：返回草稿的深拷贝并记录调用，不联网、无随机性。
 * @param {object} [draft] 默认 makeDraft()
 * @returns {((request: object) => Promise<object>) & {calls: object[], draft: object}}
 */
export function makeFakeLlm(draft = makeDraft()) {
  /** @type {object[]} */
  const calls = [];
  const llm = async (request) => {
    calls.push(request);
    return structuredClone(draft);
  };
  llm.calls = calls;
  llm.draft = draft;
  return llm;
}

/**
 * 写入一条 episode + 一条 fact + 一条 reminder（直接 insert，不经过巩固链路）。
 *
 * 刻意不走 consolidate：巩固会写 ADD 审计事件与状态板快照，干扰「遗忘后
 * memory_events 只留 PURGED」「状态板清零」等断言。
 *
 * @param {Store} store
 * @param {{scope?: string, now?: Date|number, title?: string, summary?: string,
 *          statement?: string, subjectText?: string, predicate?: string,
 *          objectText?: string, reminderTitle?: string}} [options]
 * @returns {{episode: object, fact: object, reminder: object,
 *            episodeId: string, factId: string, reminderId: string}}
 */
export function seedMemory(store, options = {}) {
  if (!store || typeof store.insertEpisode !== 'function') {
    throw new TypeError('seedMemory: store is required');
  }
  const {
    scope = 'main',
    now = TEST_NOW,
    title = '讨论青柠计划的分阶段安排',
    summary = '用户说青柠计划的代号是蓝鲸。',
    statement = '青柠计划的代号是蓝鲸。',
    subjectText = '青柠计划',
    predicate = '代号',
    objectText = '蓝鲸',
    reminderTitle = '跟进青柠计划的预算',
  } = options;
  const at = toEpochSeconds(now);

  const episode = store.insertEpisode({
    scope,
    session_id: `e2e-${scope}`,
    started_at: at,
    ended_at: at,
    title,
    summary,
    evidence: summary,
    topics: [subjectText],
    salience: 'normal',
    last_reinforced_at: at,
    fidelity: 'full',
  });
  const fact = store.insertFact({
    scope,
    kind: 'project',
    subject_text: subjectText,
    predicate,
    object_text: objectText,
    statement,
    source_kind: 'turn',
    source_episode_id: episode.id,
    source_excerpt: summary,
    salience: 'normal',
    observed_at: at,
    last_reinforced_at: at,
  });
  const reminder = store.insertReminder({
    scope,
    kind: 'todo',
    title: reminderTitle,
    detail: summary,
    due_at: at + DAY_SECONDS,
    due_granularity: 'day',
    next_fire_at: at + DAY_SECONDS,
    status: 'pending',
    source_episode_id: episode.id,
  });

  return {
    episode,
    fact,
    reminder,
    episodeId: episode.id,
    factId: fact.id,
    reminderId: reminder.id,
  };
}

/**
 * V2 S1（显式遗忘的第一步）的测试侧封装。
 *
 * 06 v3.3 §7.8：S1 立即停读、7 天冷静期内只软删不物删。这里在一个事务内
 * 调用 Store 的显式遗忘 API（与生产命令层同一入口）：
 *   - fact     → store.forgetFact（status='tombstoned'、deleted_at、purge_payload）；
 *   - episode  → store.forgetEpisode（同上，行与 FTS 保留到 purge）；
 *   - reminder → store.forgetReminder（提醒无冷静期，直接删行）；
 *   - 状态板   → replaceBoardLines(scope, []) 同步删行；state_board_rev 无公开
 *                删除 API，仍需直达 SQL 清空快照（S1 要求状态板同步）。
 *
 * @param {Store} store
 * @param {{scope?: string, factId?: string|null, episodeId?: string|null,
 *          reminderId?: string|null, now?: Date|number}} [options]
 * @returns {{scope: string, factId: string|null, episodeId: string|null,
 *            reminderId: string|null, at: number}}
 */
export function forgetMemory(store, options = {}) {
  if (!store || typeof store.transaction !== 'function') {
    throw new TypeError('forgetMemory: store is required');
  }
  const {
    scope = 'main',
    factId = null,
    episodeId = null,
    reminderId = null,
    now = TEST_NOW,
  } = options;
  if (!factId && !episodeId && !reminderId) {
    throw new TypeError('forgetMemory: need factId, episodeId or reminderId');
  }
  const at = toEpochSeconds(now);

  return store.transaction(() => {
    if (factId && !store.forgetFact(factId, { at })) {
      throw new Error(`forgetMemory: fact not found or already forgotten: ${factId}`);
    }
    if (episodeId && !store.forgetEpisode(episodeId, { at })) {
      throw new Error(`forgetMemory: episode not found or already forgotten: ${episodeId}`);
    }
    if (reminderId && !store.forgetReminder(reminderId, { at })) {
      throw new Error(`forgetMemory: reminder not found: ${reminderId}`);
    }

    store.replaceBoardLines(scope, [], { now: at });
    store.db.prepare('DELETE FROM state_board_rev WHERE scope = ?').run(scope);

    return { scope, factId, episodeId, reminderId, at };
  });
}

/**
 * 观测窗口：检索 → 30K 装配 → 拼接注入文本。
 *
 * userInput 传空串，因此注入文本里只剩装配层追加的 `[相关记忆]` 块——断言
 * 「已遗忘的内容不再进入上下文」时不会与用户原文混淆。
 *
 * @param {{store: Store, query: string, scope?: string, now?: Date|number}} input
 * @returns {Promise<{recalled: object, assembled: object, injected: string}>}
 */
export async function recallInjection({ store, query, scope = 'main', now = TEST_NOW } = {}) {
  if (!store) throw new TypeError('recallInjection: store is required');
  const recalled = await retrieve({ store, query, scope, now });
  const assembled = assemble({ recallItems: recalled.items, userInput: '' });
  const injected = assembled.messages
    .flatMap((message) => message.content)
    .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
    .join('\n');
  return { recalled, assembled, injected };
}
