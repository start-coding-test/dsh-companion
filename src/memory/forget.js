/**
 * 遗忘闭环（H4，06 v3.3 §7.8）。
 *
 * 一个完整的显式遗忘分四步：
 *   1) 定向巩固（可选）：目标事实来自某个已巩固区间时，先对该 seq 区间
 *      再跑一次 consolidate，并用 excludeFactIds 保证目标 statement 不被
 *      写回；失败只 warn，不阻断 S1。
 *   2) S1：fact/episode → tombstoned + deleted_at + purge_payload。检索 /
 *      注入入口按 deleted_at / status 立即停读（retrieve 与 searchBigram 都
 *      已过滤）。
 *   3) 状态板清洗：删掉引用被遗忘行的 state_board 行，清掉 rendered /
 *      staged 文本里的残留行，再按当前 active 记忆重新渲染，并以
 *      publishBoard('forget') 立即发布（显式遗忘是允许缓存失效的安全点）。
 *   4) 物删：immediate=true 且 confirm=true 时跳过 7 天冷静期，走
 *      store.purgeIds 定向物理删除；否则交给既有 s2-purge 在 7 天后处理。
 *
 * 兼容同步命令层：没有 llm（或没有可巩固区间）时本函数同步返回结果对象；
 * 只有真正需要定向巩固时才返回 Promise（命令层不传 llm，因此始终同步）。
 */

import { consolidate } from './consolidate.js';
import {
  boardFragments,
  publishBoard,
  renderBoard,
  scrubBoardText,
  stageBoard,
} from './state-board.js';

/** 冷静期天数（与 store.DEFAULT_PURGE_DAYS / s2-purge 保持一致）。 */
export const FORGET_PURGE_DAYS = 7;
const FORGET_PURGE_SECONDS = FORGET_PURGE_DAYS * 86_400;

const MEMORY_KINDS = new Set(['fact', 'episode']);

/**
 * Date / Unix 秒 / Unix 毫秒 → Unix 秒（Store 落库口径）。
 * @param {unknown} value
 * @returns {number}
 */
function toEpochSeconds(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('[forget] invalid Date timestamp');
    return Math.floor(ms / 1000);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) throw new TypeError(`[forget] invalid timestamp: ${String(value)}`);
  return Math.abs(num) < 1e11 ? Math.trunc(num) : Math.floor(num / 1000);
}

/**
 * @param {unknown} logger
 * @returns {(message: string, error?: unknown) => void}
 */
function resolveWarn(logger) {
  if (logger && typeof logger.warn === 'function') return logger.warn.bind(logger);
  return (message, error) => {
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(message, error);
    }
  };
}

/** @param {object} store @param {string} scope */
function boardInput(store, scope) {
  return {
    recent: store.listEpisodes({ scope, limit: 6 }),
    facts: store.listFacts({ scope, status: 'active', limit: 10 }),
    threads: store.listThreads({ status: 'active', limit: 10 }),
    reminders: store.listReminders({ scope, limit: 12 }),
  };
}

/**
 * 判断是否需要定向巩固，并生成（可选的）Promise。
 * 目标事实 → 来源 episode → consolidation 的 turn_from/turn_to。
 * @returns {{skipped: object} | {promise: Promise<object>}}
 */
function planTargetedConsolidation({ store, kind, row, llm, scope, at }) {
  if (kind !== 'fact') return { skipped: { skipped: true, reason: 'episode-forget' } };
  if (typeof llm !== 'function') return { skipped: { skipped: true, reason: 'no-llm' } };
  if (!row.source_episode_id || typeof store.getEpisode !== 'function') {
    return { skipped: { skipped: true, reason: 'no-source-episode' } };
  }
  const episode = store.getEpisode(row.source_episode_id);
  if (!episode || !episode.consolidation_id || typeof store.getConsolidation !== 'function') {
    return { skipped: { skipped: true, reason: 'no-consolidation' } };
  }
  const consolidation = store.getConsolidation(episode.consolidation_id);
  const seqFrom = Number(consolidation?.turn_from);
  const seqTo = Number(consolidation?.turn_to);
  if (!Number.isFinite(seqFrom) || !Number.isFinite(seqTo) || seqTo < seqFrom) {
    return { skipped: { skipped: true, reason: 'no-range' } };
  }
  return {
    promise: consolidate({
      store,
      scope,
      seqFrom: Math.trunc(seqFrom),
      seqTo: Math.trunc(seqTo),
      llm,
      now: at,
      trigger: 'forget',
      kind: 'forget_flush',
      sessionId: consolidation.session_id ?? scope,
      excludeFactIds: [row.id],
    }),
  };
}

/**
 * S1 + 状态板清洗 +（可选）立即物删。
 * @param {object} input
 * @returns {object} 结构化结果
 */
function finishForget({ store, kind, row, id, scope, at, immediate, consolidation, warn }) {
  const payload =
    kind === 'fact'
      ? { statement: row.statement, kind: row.kind, scope }
      : { title: row.title, kind: 'episode', scope };

  const tombstoned =
    kind === 'fact'
      ? store.forgetFact(id, { at, payload })
      : store.forgetEpisode(id, { at, payload });

  if (!tombstoned) {
    const current = kind === 'fact' ? store.getFact(id) : store.getEpisode(id);
    if (!current || (current.status !== 'tombstoned' && !current.deleted_at)) {
      return { ok: false, reason: 'not_active', kind, id, scope };
    }
  }

  // 状态板：先删行/清残留，再按 active 记忆重渲染并以 forget 原因发布。
  let boardRevision = null;
  let boardError;
  try {
    store.scrubStateBoard({ scope, ids: [id], now: at });
    const fragments = boardFragments(store, [id]);
    const text = scrubBoardText(renderBoard(boardInput(store, scope)), fragments);
    stageBoard(store, scope, text);
    boardRevision = publishBoard(store, scope, 'forget');
  } catch (error) {
    boardError = error instanceof Error ? error.message : String(error);
    warn('[forget] state board scrub failed', error);
  }

  const result = {
    ok: true,
    kind,
    id,
    scope,
    tombstoned: true,
    deletedAt: at,
    purged: false,
    purgeAt: at + FORGET_PURGE_SECONDS,
    boardRevision,
  };
  if (boardError !== undefined) result.boardError = boardError;
  if (consolidation !== undefined) result.consolidation = consolidation;

  if (immediate) {
    const purged = store.purgeIds(
      kind === 'fact' ? { facts: [id], episodes: [], at } : { facts: [], episodes: [id], at },
    );
    result.purged = true;
    result.purgeAt = at;
    result.purgedRows = purged;
  }
  return result;
}

/**
 * 显式遗忘一条事实或情景。
 *
 * @param {object} input
 * @param {import('./store.js').Store} input.store
 * @param {'fact'|'episode'} [input.kind='fact']
 * @param {string} input.id
 * @param {Date|number} [input.at] 遗忘时刻（默认当前时间）
 * @param {string} [input.scope] 目标行缺失 scope 时的兜底
 * @param {boolean} [input.immediate=false] 是否跳过 7 天冷静期立即物删
 * @param {boolean} [input.confirm=false] immediate 的二次确认标记
 * @param {Function} [input.llm] 定向巩固用的模型回调（可选）
 * @param {{warn?: Function}} [input.logger] 诊断日志
 * @returns {object|Promise<object>} 无 llm/无需巩固时同步返回结构化结果
 */
export function forgetMemory(input = {}) {
  const { store, llm, logger } = input;
  if (!store || typeof store.forgetFact !== 'function' || typeof store.forgetEpisode !== 'function') {
    throw new TypeError('[forget] store must be a Store instance');
  }
  const kind = input.kind ?? 'fact';
  if (!MEMORY_KINDS.has(kind)) {
    throw new TypeError(`[forget] unknown kind: ${String(kind)}`);
  }
  const id = input.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new TypeError('[forget] id must be a non-empty string');
  }
  const at = toEpochSeconds(input.at ?? input.now ?? Date.now());
  const immediate = input.immediate === true;
  const confirm = input.confirm === true;
  const warn = resolveWarn(logger);

  const row = kind === 'fact' ? store.getFact(id) : store.getEpisode(id);
  if (!row) return { ok: false, reason: 'not_found', kind, id };
  const scope = typeof row.scope === 'string' && row.scope !== '' ? row.scope : input.scope ?? 'main';

  if (row.status === 'tombstoned' || (row.deleted_at !== null && row.deleted_at !== undefined)) {
    return {
      ok: false,
      reason: 'already_deleted',
      kind,
      id,
      scope,
      deletedAt: row.deleted_at ?? null,
      purgeAt: row.deleted_at !== null && row.deleted_at !== undefined
        ? row.deleted_at + FORGET_PURGE_SECONDS
        : null,
    };
  }

  if (immediate && !confirm) {
    return { ok: false, reason: 'needs_confirm', kind, id, scope };
  }

  const plan = planTargetedConsolidation({ store, kind, row, llm, scope, at });
  if (plan.skipped) {
    return finishForget({
      store, kind, row, id, scope, at, immediate, consolidation: plan.skipped, warn,
    });
  }
  return plan.promise
    .then((consolidation) =>
      finishForget({ store, kind, row, id, scope, at, immediate, consolidation, warn }),
    )
    .catch((error) => {
      warn('[forget] targeted consolidation failed; continuing with S1', error);
      return finishForget({
        store,
        kind,
        row,
        id,
        scope,
        at,
        immediate,
        consolidation: {
          skipped: true,
          reason: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
        warn,
      });
    });
}
