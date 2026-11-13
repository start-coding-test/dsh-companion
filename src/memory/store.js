/**
 * dsh-companion SQLite 存储层（node:sqlite DatabaseSync，零第三方依赖）。
 *
 * DDL 唯一权威：memory/docs/06-记忆系统设计.md v3.3 §8.2。
 * 历史任务卡上的列名只是语义速记，实际列名按下表映射：
 *
 * | 卡上（语义速记）                                  | §8.2 实际实现                                             |
 * | ------------------------------------------------- | --------------------------------------------------------- |
 * | episodes.seq_from / seq_to / payload_json         | 无这些列；区间由调用方传入并写 consolidations.upto_seq；   |
 * |                                                   | 正文在 summary / evidence，审计在 memory_events           |
 * | facts.key / value / text / confidence             | subject_text / object_text / statement；无 confidence     |
 * | reminders.text                                    | title（+ detail）                                         |
 * | state_board(scope PK, rendered)                   | state_board 行表 + state_board_rev.rendered（分版本）     |
 * | threads.key                                       | key（同）                                                 |
 * | consolidations.summary / created_at               | 无 summary / created_at；有 kind/trigger/status/started_at |
 * | memory_events.scope / kind / payload_json         | 无 scope/kind；action/table_name/row_id/actor/detail_json  |
 * | 状态板发布 "revision + 1"                          | state_board_rev.staged_revision = revision + 1            |
 *
 * 对外方法名与签名保持 t5 卡所列；另补状态板行 CRUD（供巩固写 staged 前
 * 落行）与 transaction(fn)（T6 巩固单事务写库用）。
 *
 * FTS 投影（§8.2 + §8.3）：入库时把「当前保真档位保留的文本」切成 bigram
 * 写 fts_facts / fts_episodes，用主表 rowid 关联；检索联查主表并过滤
 * deleted_at IS NULL。facts 投影 statement + subject_text + predicate
 * （fidelity='full' 时再加 object_text）；episodes 投影 title + summary +
 * topics。降级/更新时由本层刷新投影。
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toBigrams, toMatchQuery } from './bigram.js';
import {
  REDACTED_CREDENTIAL, appendEventWithAction, hasUnredactedCredentialValue, redactSensitiveValues,
} from './govern.js';
import { RENEED_KINDS } from './reneed.js';
import { DEFAULT_ALPHA, decayOf, reinforce } from './reinforce.js';
import { boardFragments, renderBoard, scrubBoardText } from './state-board.js';
import { DEFAULT_VECTOR_DIM, hashEmbed } from './vector.js';

/**
 * schema 版本。
 * v4：consolidations 改 surface seq 口径（见 docs/h1-h3-probe.md）。
 * v5：新增 fact_vectors（P2-b 可选向量召回），只建表、不动既有数据。
 * v6：fact_vectors 增加 embedder_id（W4 可插拔 embedding），旧行回填
 *     `hash:<dim>`，避免换模型后新旧向量混用。
 * v7：facts 增加 first_reneed_at/first_reneed_tier/reneed_kind（W5 S0 标定
 *     首次再需要埋点），旧行保持 NULL 作为删失样本。
 * v8：facts.reneed_kind 合法值扩为含 `used`（强化路径判定「用上」时写入，
 *     S0 主样本），并新增 `same_context` 标记同会话即时召回样本
 *     （旧行默认 0，口径见 docs/s0-calibration.md 与 src/memory/reneed.js）。
 *     `reneed_kind` 的库级校验用幂等触发器实现（等价于 CHECK，避免重建表）。
 * v9：facts 新增 first_used_at/first_used_tier/used_same_context，记录首次
 *     「被用上」（S2-M1）：时间/档位取用上那一刻，same_context 当场重新判定。
 *     first_reneed_* 与 same_context 原样保留给 recall 样本作对照；旧行新列为 NULL。
 * v10：reminders.status 合法值增加 `delivering`（两阶段投递：先占位再置 fired），
 *     并新增 delivery_attempts 计数（重启回收与重试上限）。SQLite 不能改 CHECK，
 *     由 #ensureRemindersDeliveryColumns 幂等重建表，旧行 delivery_attempts=0。
 * v11：reminders 增加 occurrence_key（V6-M1）：requestId 按「本次到点」而非
 *     next_fire_at 取值，失败退避改写 next_fire_at 后重试仍复用同一 rpcId；
 *     投递成功/置 expired 时清空，下一次到点重新生成。旧行 NULL，按列检测补列。
 * v12（V5-L2）：reminders 增加 retry_at。next_fire_at 恢复为「原定到点时间」，
 *     失败退避只写 retry_at；调度按 max(next_fire_at, retry_at) 判断到期
 *     （V8-L2 起与 onAttempt 统一口径，见 REMINDER_DUE_AT_SQL），成功/过期时
 *     清空 retry_at。旧行 NULL，按列检测补列。
 * V8-L1/L2（不改变 schema_version，索引/触发器由 migrate 幂等补建）：
 *     - 到期索引改表达式索引 ix_rm_due(status, max(...)) 并删除 ix_rm_fire；
 *     - 改期（next_fire_at 变化）时清空残留 retry_at，库级触发器兜底。
 * v13（V10-L1）：纯数据迁移，无新列。旧库的 episodes.title/summary/evidence/
 *     mood_evidence/topics_json/entities_json 可能仍有 v0.4.10 之前落库的明文
 *     凭据值（并已投影进 fts_episodes），打开旧库时一次性重跑写入路径的脱敏
 *     口径（#scrubLegacyEpisodes），只有真正变化的行才更新并重建 FTS。成功后
 *     在 schema_meta 写 episode_scrub_v13 标记，重复打开直接跳过；审计只写一条
 *     memory_events（action=scrub，detail={scanned,changed}，不含正文）。
 * v14（P3-b）：新增 emotion_state / emotion_events 两张表，只建表、不动既有数据；
 *     DDL 走 CREATE TABLE IF NOT EXISTS，v13 库打开时自动补表（幂等）。
 *     时间戳按卡面独立约定用「毫秒」epoch（既有表多用秒），所以 emotion_events.at
 *     与 purge 的秒级 cutoff 比较时要先换算，见 purge()。
 * v15（v0.4.13 存储卡）：
 *     - 新增 token_usage 入账账本（A1），按 day_key + source 聚合；day_key 由调用方
 *       按配置时区算好，store 不读时区配置。at 是毫秒。
 *     - facts 增加 injected_count / used_count / unused_streak（A8.1/A8.2）；旧的
 *       recall_count 保留但新代码不再写（v14 遗留，只读旧库时仍可参考），升级时
 *       用 `used_count = recall_count` 回填一次（幂等）。
 *     - facts.kind 扩枚举（A8.5）：lifestyle / mood 新增，共 8 类。SQLite 改不了
 *       CHECK，按「表 SQL 是否已含 lifestyle」检测后重建表，显式保留 rowid
 *       以维持 fts_facts 的 rowid 关联。
 *     - memory_events.action 扩枚举（B3）：govern / EDIT / scrub，同样重建表并
 *       保留 rowid、ix_ev_row 与 append-only 触发器。
 *     - reminders 增加 expired_notified_at / series_index（A4/A5），按列检测补列。
 *     重建表期间必须临时关闭 foreign_keys：facts 是 fact_vectors 的父表，FK 打开
 *     时 DROP TABLE 会隐式 DELETE 并级联清空向量行；PRAGMA 在事务内是 no-op，
 *     所以由 migrate() 在 BEGIN 之前关闭、提交/回滚后恢复。
 */
export const SCHEMA_VERSION = '15';
/** v13：存量 episode 脱敏标记；存在即表示一次性 scrub 已完成（幂等跳过）。 */
const EPISODE_SCRUB_MARKER = 'episode_scrub_v13';
/** v13 scrub 的 rowid 批大小：大库分批复用同一游标，避免一次读全表。 */
const EPISODE_SCRUB_BATCH = 200;
/** S2 物理删除默认冷静期（天）。 */
const DEFAULT_PURGE_DAYS = 7;

/** P3-b：情绪四维（顺序即 deltas_json / 校验顺序，避免多处漂移）。 */
export const EMOTION_DIMENSIONS = Object.freeze(['pleasure', 'arousal', 'dominance', 'energy']);

/** P3-b：每 scope 保留的情绪事件条数（追加后截断，超出删最旧）。 */
export const EMOTION_EVENT_RETENTION = 50;

/** P3-b：listEmotionEvents 的默认条数。 */
const EMOTION_EVENT_DEFAULT_LIMIT = 3;

/** P3-b：情绪四维合法区间（含端点）。 */
const EMOTION_MIN = 0;
const EMOTION_MAX = 100;

/** 提醒两阶段投递的最大尝试次数（超过后过期，避免死循环重试）。 */
export const REMINDER_MAX_DELIVERY_ATTEMPTS = 3;

/**
 * 提醒投递失败后的重试退避（秒）。
 *
 * 第 n 次失败（`delivery_attempts = n`）按下标 `n - 1` 取值：30s → 60s → 120s，
 * 超出数组长度后沿用最后一档。退避只写入 `retry_at`（v0.4.8 起，V5-L2）：
 * `next_fire_at` 保持原定到点时间不动，调度按 max(next_fire_at, retry_at)
 * 判断到期。失败一次就往后推，而不是让调度器每个 tick（30s）立刻重试——否则
 * 约 3 个 tick 就可能把 `delivery_attempts` 耗尽并把提醒置 `expired`
 * （v0.4.4 评审 V4-H1）。
 */
export const REMINDER_RETRY_BACKOFF_SECONDS = Object.freeze([30, 60, 120]);

/** S0 默认遗忘强度（天）；pinned = null 表示不衰减。 */
export const SALIENCE_STRENGTH_DAYS = Object.freeze({
  trivial: 3,
  normal: 14,
  notable: 60,
  explicit: 365,
  pinned: null,
});

const SALIENCE_VALUES = new Set(Object.keys(SALIENCE_STRENGTH_DAYS));

/** W5 首次再需要的档位与来源（store.markFirstReneed 校验用）。 */
const RENEED_TIERS = new Set(['clear', 'ambiguous', 'miss']);
const RENEED_KIND_SET = new Set(RENEED_KINDS);

export const EVENT_ACTIONS = new Set([
  'ADD', 'UPDATE', 'SUPERSEDE', 'MERGE', 'NOOP', 'SKIP',
  'REINFORCE', 'DECAY', 'DEGRADE', 'TOMBSTONE', 'RESTORE', 'PURGED',
  'READ', 'USED', 'EXPORT',
  // v15（B3）：治理/导出改写/存量脱敏三类审计动作。此前靠
  // PRAGMA ignore_check_constraints 绕过 CHECK 写入，v15 起是合法枚举。
  'govern', 'EDIT', 'scrub',
]);
const EVENT_ACTORS = new Set(['consolidator', 'user', 'scheduler', 'migrator']);
const CONSOLIDATION_STATUSES = new Set(['running', 'written', 'compacted', 'failed']);
const THREAD_STATUSES = new Set(['active', 'archived', 'retired']);

/** t17：BUSY/locked 事务最多重试 3 次（首次 + 3 次重试）与退避上限。 */
const BUSY_MAX_ATTEMPTS = 4;
const BUSY_BACKOFF_MAX_MS = 25;

/**
 * 是否为 SQLite 忙/锁冲突（主库与 WAL 都覆盖）。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isBusyError(error) {
  if (error === null || typeof error !== 'object') return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED_SHAREDCACHE') {
    return true;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return /database (?:table )?is locked|database is busy|SQLITE_BUSY/i.test(message);
}

/**
 * 同步睡眠：退避抖动只用于事务入口，不需要异步。
 * @param {number} ms
 */
function sleepSync(ms) {
  const wait = Math.max(0, Math.floor(Number(ms)));
  if (wait === 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, wait);
}

/**
 * 第 attempt 次重试前的抖动（5–25ms 线性增长），保证 ≤50ms。
 * @param {number} attempt
 * @returns {number}
 */
function busyBackoffMs(attempt) {
  const base = Math.min(BUSY_BACKOFF_MAX_MS, 5 * attempt);
  return base + Math.floor(Math.random() * (BUSY_BACKOFF_MAX_MS + 1));
}
const EPISODE_STATUSES = new Set(['active', 'dormant', 'tombstoned']);
const MOOD_VALUES = new Set(['positive', 'neutral', 'tired', 'anxious', 'low', 'excited']);
const FIDELITY_VALUES = new Set(['full', 'gist', 'index']);
const BOARD_SECTIONS = new Set(['in_progress', 'decided', 'open_question', 'upcoming', 'threads']);

/**
 * v15（A8.5）：facts.kind 的合法枚举。
 *
 * `lifestyle` 覆盖作息/饮食/兴趣等长期习惯，`mood` 覆盖情绪事件；人际关系继续用
 * `relation`，不再新增 person 类。顺序即文档/提示词里的展示顺序。
 * 这里是 store 侧的单一来源：insertFact / updateFact 用它校验，DDL 的 CHECK 也由
 * 它生成；consolidate.js 与 runtime/tools.js 各自的旧 6 类集合由后续卡跟进。
 */
export const FACT_KINDS = Object.freeze([
  'identity', 'relation', 'preference', 'project', 'knowledge', 'lifestyle', 'mood', 'other',
]);

const FACT_KIND_SET = new Set(FACT_KINDS);

/** v15（A1）：token_usage.source 的六类调用来源。 */
export const TOKEN_USAGE_SOURCES = Object.freeze([
  'main', 'consolidate', 'smalltalk', 'embedding', 'task', 'thread',
]);

const TOKEN_USAGE_SOURCE_SET = new Set(TOKEN_USAGE_SOURCES);

/** v15（A1）：token_usage.peak 的取值（v0.4.14 错峰计价预留）。 */
const TOKEN_PEAK_SET = new Set(['peak', 'offpeak']);

/**
 * V8-L2：提醒「唯一到期口径」的 SQL 表达式。
 *
 * 到期时刻 = `max(next_fire_at, retry_at)`：next_fire_at 是原定到点时间，
 * 失败退避只写 retry_at。取 max 而不是 COALESCE(retry_at, next_fire_at)，是因为
 * onAttempt 一直按 max 判定「退避是否已到」——两处口径必须一致，否则旧库/旧数据
 * 里 retry_at 早于 next_fire_at 时会出现「调度认为没到期、onAttempt 认为已到期」
 * 或相反的分叉。NULL 参与 max 时按 0 处理（epoch 秒恒为正，0 等价于「无时间」），
 * 是否真有到期时间由调用方另外用 `next_fire_at IS NOT NULL OR retry_at IS NOT NULL`
 * 过滤。
 *
 * 同一个常量同时用于 queries 与表达式索引，保证 EXPLAIN QUERY PLAN 能命中
 * ix_rm_due（SQLite 按表达式树匹配索引）。
 */
export const REMINDER_DUE_AT_SQL = 'max(COALESCE(next_fire_at, 0), COALESCE(retry_at, 0))';

/**
 * 单行提醒的到期时刻（Unix 秒），与 {@link REMINDER_DUE_AT_SQL} 完全同义。
 *
 * 调度侧（dueReminders 的 SQL）与投递侧（index.js 的 onAttempt）共用这一口径：
 * 两处都按 max(next_fire_at, retry_at) 判断，不再各写一份 Math.max/COALESCE。
 * @param {{next_fire_at?: number|null, retry_at?: number|null}|null|undefined} row
 * @returns {number|null} 两个时间都为空时返回 null
 */
export function reminderDueAt(row) {
  if (row === null || row === undefined || typeof row !== 'object') return null;
  const next = toEpochOrNull(row.next_fire_at);
  const retry = toEpochOrNull(row.retry_at);
  if (next === null && retry === null) return null;
  return Math.max(next ?? 0, retry ?? 0);
}

/**
 * 可选 epoch 值 → 整数秒或 null（不抛错，供展示/比较的只读路径使用）。
 * @param {unknown} value
 * @returns {number|null}
 */
function toEpochOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    if (Number.isFinite(num)) return Math.trunc(num);
  }
  return null;
}

/**
 * v15：facts 表 DDL 的单一来源。
 *
 * 新库建表（SCHEMA_SQL）与 v15 的 kind 枚举重建（#rebuildFactsForKindEnum）共用
 * 同一份列定义，避免两处漂移；重建只换表名。kind 的 CHECK 由 {@link FACT_KINDS}
 * 生成。`recall_count` 是 v14 遗留列：v15 起新代码只写 used_count，保留它是为了
 * 打开旧库时还能读到历史召回次数（升级时一次性回填 used_count）。
 * @param {string} table 表名（仅内部常量，不接受外部输入）
 */
function factsTableDdl(table) {
  const kinds = FACT_KINDS.map((kind) => `'${kind}'`).join(',');
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  kind                TEXT NOT NULL CHECK (kind IN (${kinds})),
  subject_id          TEXT REFERENCES entities(id),
  subject_text        TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_text         TEXT,
  statement           TEXT NOT NULL,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('user_explicit','turn','task','consolidated','inferred')),
  source_episode_id   TEXT REFERENCES episodes(id),
  source_excerpt      TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  observed_at         INTEGER NOT NULL,
  valid_from          INTEGER,
  valid_to            INTEGER,
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  injected_count      INTEGER NOT NULL DEFAULT 0,
  used_count          INTEGER NOT NULL DEFAULT 0,
  unused_streak       INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','superseded','tombstoned')),
  superseded_by       TEXT REFERENCES facts(id),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  first_reneed_at     INTEGER,
  first_reneed_tier   TEXT,
  reneed_kind         TEXT,
  same_context        INTEGER NOT NULL DEFAULT 0 CHECK (same_context IN (0,1)),
  first_used_at       INTEGER,
  first_used_tier     TEXT,
  used_same_context   INTEGER CHECK (used_same_context IN (0,1)),
  CONSTRAINT ck_fact_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                   OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);`;
}

/**
 * v15：memory_events 表 DDL 的单一来源（action 枚举与重建共用）。
 *
 * 与 facts 一样只返回 CREATE TABLE；ix_ev_row 与两个 append-only 触发器由调用方
 * 在表就位后补建（重建时必须先 DROP 旧表，否则旧触发器名会挡住新建）。
 * @param {string} table 表名（仅内部常量）
 */
function memoryEventsTableDdl(table) {
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  action      TEXT NOT NULL CHECK (action IN (
                'ADD','UPDATE','SUPERSEDE','MERGE','NOOP','SKIP',
                'REINFORCE','DECAY','DEGRADE','TOMBSTONE','RESTORE','PURGED',
                'READ','USED','EXPORT','govern','EDIT','scrub')),
  table_name  TEXT NOT NULL,
  row_id      TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('consolidator','user','scheduler','migrator')),
  reason      TEXT,
  detail_json TEXT
);`;
}

/**
 * §8.2 DDL。表按外键依赖排序（consolidations 先于 episodes），
 * 语义与文档一致；CREATE ... IF NOT EXISTS 保证 migrate 幂等。
 */
const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA secure_delete = ON;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('person','org','place','pet','thing','project')),
  name          TEXT NOT NULL,
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  relation      TEXT,
  privacy       TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_ent_name ON entities(name);

CREATE TABLE IF NOT EXISTS consolidations (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('nap','deep','forget_flush')),
  trigger       TEXT NOT NULL,
  upto_seq      INTEGER NOT NULL,
  turn_from     INTEGER,
  turn_to       INTEGER,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','written','compacted','failed')),
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  compaction_start_seq INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_consolidations_scope_upto ON consolidations(scope, upto_seq, kind);
CREATE INDEX IF NOT EXISTS ix_consolidations_scope ON consolidations(scope, upto_seq);

CREATE TABLE IF NOT EXISTS episodes (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  session_id          TEXT NOT NULL,
  consolidation_id    TEXT REFERENCES consolidations(id),
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT,
  evidence            TEXT,
  topics_json         TEXT NOT NULL DEFAULT '[]',
  entities_json       TEXT NOT NULL DEFAULT '[]',
  mood                TEXT CHECK (mood IN ('positive','neutral','tired','anxious','low','excited')),
  mood_evidence       TEXT,
  salience            TEXT NOT NULL CHECK (salience IN ('trivial','normal','notable','explicit','pinned')),
  privacy             TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','sensitive','secret')),
  strength_days       REAL,
  last_reinforced_at  INTEGER NOT NULL,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','tombstoned')),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT ck_ep_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                 OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ep_scope_time ON episodes(scope, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ep_decay ON episodes(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ep_purge ON episodes(deleted_at) WHERE deleted_at IS NOT NULL;

${factsTableDdl('facts')}
CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(subject_text, predicate, status);
CREATE INDEX IF NOT EXISTS ix_facts_scope ON facts(scope, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_facts_decay ON facts(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_facts_purge ON facts(deleted_at) WHERE deleted_at IS NOT NULL;

-- P2-b：可选向量召回。hashEmbed 的离线向量投影；只随 facts 生命周期维护，
-- 关闭向量时表为空也不会影响检索。FK 级联保证物理删除后不留孤儿。
CREATE TABLE IF NOT EXISTS fact_vectors (
  fact_id     TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  embedder_id TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_fact_vectors_dim ON fact_vectors(dim);

CREATE TABLE IF NOT EXISTS reminders (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL DEFAULT 'main',
  kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
  title             TEXT NOT NULL,
  detail            TEXT,
  counterparty      TEXT,
  due_at            INTEGER,
  due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
  rrule             TEXT,
  next_fire_at      INTEGER,
  retry_at          INTEGER,
  last_fire_key     TEXT,
  occurrence_key    TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
  closed_at         INTEGER,
  source_episode_id TEXT REFERENCES episodes(id),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  -- v15（A4/A5）：过期提醒的一次性通知标记 + 重复提醒的系列序号。
  expired_notified_at INTEGER,
  series_index      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at        INTEGER
);
-- V8-L1：到期扫描按 status + max(next_fire_at, retry_at) 过滤与排序，索引必须是
-- 同一表达式才能命中；旧的 ix_rm_fire(status, next_fire_at) 永远服务不了这条查询。
-- 注意：ix_rm_due 不在这里建——它引用 retry_at，而旧库（v3..v11）此时还没有该列，
-- 直接在 SCHEMA_SQL 里建会在补列之前报 no such column。它由
-- #ensureReminderDueIndex 在补列之后统一创建并对旧库就地补建（同时 DROP 旧索引）。
CREATE INDEX IF NOT EXISTS ix_rm_done ON reminders(closed_at) WHERE status IN ('done','cancelled');

CREATE TABLE IF NOT EXISTS state_board (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,
  section           TEXT NOT NULL CHECK (section IN ('in_progress','decided','open_question','upcoming','threads')),
  line              TEXT NOT NULL,
  ref_episode_id    TEXT REFERENCES episodes(id),
  ref_thread_key    TEXT,
  last_mentioned_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ix_sb_scope ON state_board(scope, section, last_mentioned_at DESC);

CREATE TABLE IF NOT EXISTS state_board_rev (
  scope            TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL,
  rendered         TEXT NOT NULL,
  staged_revision  INTEGER,
  staged_rendered  TEXT,
  staged_at        INTEGER,
  updated_at       INTEGER NOT NULL
);

-- P3-b（v14）：情绪状态与情绪事件。
-- 时间戳约定：这两张表用「毫秒」epoch（既有表多用秒），卡面要求新表独立口径，
-- 因此 updated_at / last_event_at / at 都是毫秒，不参与既有表的秒级比较。
-- 每 scope 一行状态；事件行由 store 侧保证每 scope 只留最近 50 条。
CREATE TABLE IF NOT EXISTS emotion_state (
  scope         TEXT PRIMARY KEY,
  pleasure      REAL NOT NULL,
  arousal       REAL NOT NULL,
  dominance     REAL NOT NULL,
  energy        REAL NOT NULL,
  updated_at    INTEGER NOT NULL,  -- 毫秒
  last_event_at INTEGER            -- 毫秒，可空
);
CREATE TABLE IF NOT EXISTS emotion_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  at          INTEGER NOT NULL,    -- 毫秒
  type        TEXT NOT NULL,
  deltas_json TEXT NOT NULL,       -- {"pleasure":..,"arousal":..,"dominance":..,"energy":..}
  note        TEXT
);
CREATE INDEX IF NOT EXISTS ix_emotion_events ON emotion_events (scope, at);

CREATE TABLE IF NOT EXISTS threads (
  key             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  description     TEXT NOT NULL,
  last_progress   TEXT,
  last_active_at  INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','retired')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
-- H3：一个线程会话只对应一条线程目录行；按 session_id 反查 scope 依赖唯一性。
CREATE UNIQUE INDEX IF NOT EXISTS ux_threads_session ON threads(session_id);

${memoryEventsTableDdl('memory_events')}
CREATE INDEX IF NOT EXISTS ix_ev_row ON memory_events(table_name, row_id, at DESC);
CREATE TRIGGER IF NOT EXISTS ev_no_update BEFORE UPDATE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS ev_no_delete BEFORE DELETE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;

-- v15（A1）：token 入账账本。
-- day_key 由调用方按配置时区算好的本地日键（YYYY-MM-DD），store 不读时区配置；
-- at 是毫秒（与 emotion_* 一致，便于 5 小时滑窗），其余表多用秒。
-- peak 预留给 v0.4.14 错峰计价，当前只写入、不参与聚合。
CREATE TABLE IF NOT EXISTS token_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  day_key          TEXT NOT NULL,
  source           TEXT NOT NULL CHECK (source IN ('main','consolidate','smalltalk','embedding','task','thread')),
  scope            TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  peak             TEXT CHECK (peak IS NULL OR peak IN ('peak','offpeak')),
  request_id       TEXT
);
CREATE INDEX IF NOT EXISTS ix_token_usage_day ON token_usage(day_key, source);

-- 全文检索：列名 txt 存放 toBigrams() 结果，rowid 与主表 rowid 对齐
CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(txt, tokenize = 'unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(txt, tokenize = 'unicode61');
`;

/** @returns {number} 当前 Unix 秒 */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** @param {string} prefix @returns {string} 形如 ep_ab12... 的主键 */
function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`[store] ${name} must be a non-empty string`);
  }
  return value;
}

/**
 * v15（A8.5）：facts.kind 校验（白名单见 {@link FACT_KINDS}）。
 * @param {unknown} value
 * @returns {string}
 */
function requireFactKind(value) {
  const kind = requireString(value, 'facts.kind');
  if (!FACT_KIND_SET.has(kind)) {
    throw new TypeError(`[store] invalid facts.kind: ${kind}`);
  }
  return kind;
}

/**
 * v15（A1）：token 计数 / 毫秒时间戳的校验：必须是 >= 0 的整数。
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireNonNegativeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`[store] ${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * 把 Date / 秒 / 毫秒时间戳转成 Unix 秒；null/undefined 原样返回。
 * 数字一律按秒处理（与 SQLite unixepoch() 对齐）；Date 自动取秒。
 * @param {unknown} value
 * @returns {number|null}
 */
function toEpoch(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError('[store] invalid Date');
    return Math.floor(ms / 1000);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  throw new TypeError(`[store] invalid timestamp: ${String(value)}`);
}

/**
 * 可选时间字段：undefined/null 用 fallback。
 * @param {unknown} value
 * @param {number|null} fallback
 * @returns {number|null}
 */
function epochOr(value, fallback) {
  return value === null || value === undefined ? fallback : toEpoch(value);
}

/**
 * 物删/清洗的 id 列表：只接受非空字符串，去重并保持顺序。
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeIdList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('[store] ids must be an array of non-empty strings');
  }
  const seen = new Set();
  const out = [];
  for (const id of value) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('[store] ids must be an array of non-empty strings');
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 数组/JSON 字符串统一成 JSON 数组文本。
 * @param {unknown} value
 * @returns {string}
 */
function toJsonArray(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string' && value.trim() !== '') return value;
  return '[]';
}

/**
 * V9-M1：episode 文本字段的防御性脱敏（任何调用方都不落明文）。
 *
 * 巩固层写库前已按字段脱敏一次，这里再对 title/summary/evidence/
 * mood_evidence/topics/entities 套一遍：`redactSensitiveValues` 对非字符串
 * 原样返回、对无命中文本返回原文、且幂等，所以对已脱敏的值不会叠加占位符。
 * V9-M1b 起兜底判定用 `hasUnredactedCredentialValue`：只有脱敏后仍残留凭据
 * 「值」形态才整段替换，避免把「用户提到一个密码」这类叙事二次抹掉。
 * fts_episodes 由 `#refreshEpisodesFts` 从主表投影，自动跟着干净。
 *
 * @param {unknown} value 文本或文本数组（topics/entities）
 * @returns {unknown}
 */
function redactEpisodeInput(value) {
  if (Array.isArray(value)) return redactEpisodeItems(value);
  // 有些调用方直接传 topics_json 文本；先按 JSON 解析再逐项脱敏，
  // 避免把引号/方括号当成值的一部分而破坏 JSON 结构。
  if (typeof value === 'string' && value.trimStart().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return redactEpisodeItems(parsed);
    } catch {
      // 坏 JSON 退化为整段文本脱敏（不改变「尽量不落明文」的取向）。
    }
  }
  return redactEpisodeText(value);
}

/** @param {unknown[]} items */
function redactEpisodeItems(items) {
  return items.map((item) => redactEpisodeText(item));
}

/**
 * V9-M1b：单条 episode 文本的防御性脱敏。值级替换后若仍残留凭据「值」才整段
 * 替换为占位符；非字符串原样返回。
 * @param {unknown} value
 * @returns {unknown}
 */
function redactEpisodeText(value) {
  if (typeof value !== 'string' || value === '') return value;
  const redacted = redactSensitiveValues(value);
  return hasUnredactedCredentialValue(redacted) ? REDACTED_CREDENTIAL : redacted;
}

/**
 * V10-L1：存量 episodes 的 JSON 数组文本脱敏（topics_json/entities_json）。
 *
 * 逐项走 `redactEpisodeText`；只有某项真的变了才重新序列化，未命中的数组保持
 * 原文本一个字节不动（避免存量库因格式化差异被无谓重写）。JSON 合法时输出
 * 仍是合法 JSON 数组；不是 JSON 数组的坏数据退化为整段文本脱敏，与写入路径
 * `redactEpisodeInput` 的取向一致。
 *
 * @param {unknown} text
 * @returns {unknown}
 */
function scrubEpisodeJsonText(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (text.trimStart().startsWith('[')) {
    let parsed = null;
    try {
      const value = JSON.parse(text);
      if (Array.isArray(value)) parsed = value;
    } catch {
      // 坏 JSON：走下面的整段文本脱敏。
    }
    if (parsed !== null) {
      const items = redactEpisodeItems(parsed);
      const changed = items.some((item, index) => item !== parsed[index]);
      return changed ? JSON.stringify(items) : text;
    }
  }
  return redactEpisodeText(text);
}

/**
 * 审计 detail_json：对象序列化，字符串原样，空值 null。
 * @param {unknown} value
 * @returns {string|null}
 */
function toDetailJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * 解析 topics_json 等 JSON 数组文本；坏数据返回空数组（FTS 不因此失败）。
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
function parseJsonArray(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.map((item) => String(item));
  } catch {
    return [];
  }
}

/**
 * 按 S0 默认值补全 strength_days；pinned 必须为 NULL，非 pinned 必须非 NULL。
 * @param {string} salience
 * @param {unknown} strengthDays
 * @returns {number|null}
 */
function resolveStrengthDays(salience, strengthDays) {
  if (!SALIENCE_VALUES.has(salience)) {
    throw new TypeError(`[store] invalid salience: ${String(salience)}`);
  }
  if (salience === 'pinned') {
    if (strengthDays !== null && strengthDays !== undefined) {
      throw new TypeError('[store] pinned salience requires strength_days = null');
    }
    return null;
  }
  if (typeof strengthDays === 'number' && Number.isFinite(strengthDays)) {
    return strengthDays;
  }
  if (strengthDays === null || strengthDays === undefined) {
    return SALIENCE_STRENGTH_DAYS[salience];
  }
  throw new TypeError(`[store] invalid strength_days: ${String(strengthDays)}`);
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function clampLimit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(num)));
}

/** @param {unknown} value @returns {number} */
function clampOffset(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.trunc(num);
}

/**
 * P3-b：情绪四维校验（0–100 的有限数）。字符串数字也不算合法（按 Number.isFinite
 * 的严格口径），避免调用方把「'60'」当成 60 静默落库。
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireEmotionValue(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < EMOTION_MIN || value > EMOTION_MAX) {
    throw new TypeError(`[store] ${name} must be a finite number in ${EMOTION_MIN}..${EMOTION_MAX}`);
  }
  return value;
}

/**
 * P3-b：毫秒时间戳校验。emotion_* 两张表按卡面新表约定用毫秒，这里不做
 * 秒/毫秒猜测定性（既有表才用秒）；非有限数一律 TypeError。
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function requireEmotionMillis(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[store] ${name} must be a finite millisecond timestamp`);
  }
  return Math.trunc(value);
}

/**
 * P3-b：可空毫秒时间戳。null/undefined 都表示「没有」，其余按 {@link requireEmotionMillis}。
 * @param {unknown} value
 * @param {string} name
 * @returns {number|null}
 */
function optionalEmotionMillis(value, name) {
  if (value === null || value === undefined) return null;
  return requireEmotionMillis(value, name);
}

/**
 * P3-b：deltas 归一化——必须是含四维有限数的对象。
 * 增量允许为负（一次负向事件），所以这里不做 0–100 限制，只有 state 才限制。
 * @param {unknown} deltas
 * @returns {{pleasure:number, arousal:number, dominance:number, energy:number}}
 */
function normalizeEmotionDeltas(deltas) {
  if (deltas === null || typeof deltas !== 'object' || Array.isArray(deltas)) {
    throw new TypeError(
      '[store] emotion deltas must be an object with pleasure/arousal/dominance/energy',
    );
  }
  const out = {};
  for (const dimension of EMOTION_DIMENSIONS) {
    const value = deltas[dimension];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`[store] emotion deltas.${dimension} must be a finite number`);
    }
    out[dimension] = value;
  }
  return /** @type {{pleasure:number, arousal:number, dominance:number, energy:number}} */ (out);
}

/**
 * P3-b：deltas_json 反序列化。坏数据返回空对象，读路径不因单行损坏而整体失败。
 * @param {unknown} text
 * @returns {object}
 */
function parseEmotionDeltas(text) {
  if (typeof text !== 'string' || text === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/**
 * P3-b：DB 行（snake_case）→ 对外状态对象（camelCase）。
 * @param {object} row
 * @returns {{scope:string, pleasure:number, arousal:number, dominance:number,
 *            energy:number, updatedAt:number, lastEventAt:number|null}}
 */
function mapEmotionStateRow(row) {
  return {
    scope: String(row.scope),
    pleasure: Number(row.pleasure),
    arousal: Number(row.arousal),
    dominance: Number(row.dominance),
    energy: Number(row.energy),
    updatedAt: Number(row.updated_at),
    lastEventAt: row.last_event_at === null || row.last_event_at === undefined
      ? null
      : Number(row.last_event_at),
  };
}

/**
 * P3-b：DB 行（snake_case）→ 对外事件对象（deltas 已反序列化）。
 * @param {object} row
 * @returns {{id:number, scope:string, at:number, type:string,
 *            deltas:object, note:string|null}}
 */
function mapEmotionEventRow(row) {
  return {
    id: Number(row.id),
    scope: String(row.scope),
    at: Number(row.at),
    type: String(row.type),
    deltas: parseEmotionDeltas(row.deltas_json),
    note: row.note === null || row.note === undefined ? null : String(row.note),
  };
}

/**
 * 构造 dueReminders 的查询（V8-L1/L2）。
 *
 * 单独导出是为了让测试能对**同一条 SQL** 跑 EXPLAIN QUERY PLAN，断言命中
 * ix_rm_due；同时保证查询表达式与索引表达式来自同一个常量
 * {@link REMINDER_DUE_AT_SQL}，不会各写一份而漂移。
 * @param {{now?: number|Date, scope?: string, limit?: number}} [options]
 * @returns {{sql: string, args: (number|string)[]}}
 */
export function buildDueRemindersQuery(options = {}) {
  const at = epochOr(options.now, nowSeconds());
  const where = [
    "status IN ('pending','snoozed')",
    // 到期口径是 max(...)，两侧都为 NULL 的行没有到期时间，必须排除。
    '(next_fire_at IS NOT NULL OR retry_at IS NOT NULL)',
    `${REMINDER_DUE_AT_SQL} <= ?`,
    'deleted_at IS NULL',
  ];
  const args = [at];
  if (options.scope !== undefined) {
    where.push('scope = ?');
    args.push(options.scope);
  }
  const limit = clampLimit(options.limit, 100);
  return {
    sql: `SELECT * FROM reminders WHERE ${where.join(' AND ')}
          ORDER BY ${REMINDER_DUE_AT_SQL} ASC, id ASC LIMIT ?`,
    args: [...args, limit],
  };
}

/** 存储层错误对象：用于区分校验失败与 SQLite 原生错误。 */
export class StoreError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export class Store {
  /** @type {DatabaseSync} */
  #db;
  /** @type {string} */
  #dbPath;
  #inTransaction = false;
  /** P2-b：向量投影维度；关闭向量时不会写入 fact_vectors。 */
  #vectorDim = DEFAULT_VECTOR_DIM;
  /** W4：当前向量写入者 id；检索只召回同 id 的向量。 */
  #vectorEmbedderId = `hash:${DEFAULT_VECTOR_DIM}`;
  /**
   * 同步向量函数；async embedder（local/remote）没有同步版本时为 null，
   * 其向量由空闲回填（upsertFactVector）补齐。
   * @type {((text: string, dim: number) => Float32Array)|null}
   */
  #vectorEmbed = hashEmbed;

  /**
   * 请用 Store.open(path) 创建实例。
   * @param {DatabaseSync} db
   * @param {string} dbPath
   */
  constructor(db, dbPath) {
    this.#db = db;
    this.#dbPath = dbPath;
  }

  /**
   * 打开（不存在则创建）单文件记忆库并完成建表/迁移。
   * @param {string} dbPath 文件路径；':memory:' 用于测试
   * @returns {Store}
   */
  static open(dbPath) {
    if (typeof dbPath !== 'string' || dbPath === '') {
      throw new TypeError('[store] dbPath must be a non-empty string');
    }
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    const store = new Store(db, dbPath);
    store.#applyPragmas();
    store.migrate();
    return store;
  }

  /** 底层连接（仅供诊断/测试/迁移；业务读写请走本类方法）。 */
  get db() {
    return this.#db;
  }

  /** 当前向量投影维度。 @returns {number} */
  get vectorDim() {
    return this.#vectorDim;
  }

  /** W4：当前向量写入者 id（如 hash:256 / local:bge-small-zh-v1.5:512）。 @returns {string} */
  get vectorEmbedderId() {
    return this.#vectorEmbedderId;
  }

  /**
   * 设置向量投影维度。维度变化时清掉旧维度投影（下次写入会按新维度重建），
   * 避免 searchVector 按 dim 过滤后静默丢召回。
   * 兼容入口：仅用于 hash embedder，相当于 configureVectors({id:`hash:${dim}`, dim, embed:hashEmbed})。
   * @param {number} dim
   * @returns {number}
   */
  setVectorDim(dim) {
    if (!Number.isInteger(dim) || dim < 8 || dim > 4096) {
      throw new TypeError(`[store] invalid vector dim: ${String(dim)}`);
    }
    this.configureVectors({ id: `hash:${dim}`, dim, embed: hashEmbed });
    return dim;
  }

  /**
   * W4：配置当前 embedder 的 id/维度/同步向量函数。
   *
   * id 或维度变化会删除不匹配的旧投影（换模型后旧向量不可比），随后由
   * 写入路径或空闲回填按新 id 重建。`embed` 为 null 表示只能用异步
   * embedder（local/remote），此时写入路径不生成向量，等回填补齐。
   * @param {{id: string, dim: number, embed?: ((text: string, dim: number) => Float32Array)|null}} input
   * @returns {{id: string, dim: number}}
   */
  configureVectors(input = {}) {
    const id = requireString(input.id, 'fact_vectors.embedder_id');
    const dim = input.dim === undefined ? this.#vectorDim : input.dim;
    if (!Number.isInteger(dim) || dim < 0 || dim > 4096) {
      throw new TypeError(`[store] invalid vector dim: ${String(dim)}`);
    }
    const embed = input.embed === undefined ? null : input.embed;
    if (embed !== null && typeof embed !== 'function') {
      throw new TypeError('[store] vector embed must be a function or null');
    }
    if (id !== this.#vectorEmbedderId || dim !== this.#vectorDim) {
      this.#db
        .prepare('DELETE FROM fact_vectors WHERE embedder_id <> ? OR (dim <> ? AND ? > 0)')
        .run(id, dim > 0 ? dim : this.#vectorDim, dim);
      this.#vectorEmbedderId = id;
      this.#vectorDim = dim;
    }
    this.#vectorEmbed = embed;
    return { id, dim };
  }

  /**
   * W4：写入一条事实向量（回填/异步 embedder 用）。
   *
   * 写入前复核事实仍可向量化（active + normal + 未删除 + 非 sensitive），
   * 避免回填批次与治理/删除并发时留下可召回残影。
   * @param {{factId: string, vec: Float32Array, embedderId?: string}} input
   * @returns {{factId: string, embedderId: string, dim: number}|null}
   */
  upsertFactVector(input = {}) {
    const factId = requireString(input.factId, 'fact_vectors.fact_id');
    const embedderId = requireString(
      input.embedderId === undefined ? this.#vectorEmbedderId : input.embedderId,
      'fact_vectors.embedder_id',
    );
    const vec = input.vec;
    if (!(vec instanceof Float32Array)) {
      throw new TypeError('[store] fact vector must be a Float32Array');
    }
    if (vec.length < 8 || vec.length > 4096) {
      throw new TypeError(`[store] invalid vector dim: ${vec.length}`);
    }
    for (const value of vec) {
      if (!Number.isFinite(value)) throw new TypeError('[store] fact vector contains non-finite values');
    }
    const hasSensitive = this.#db
      .prepare("SELECT 1 AS present FROM pragma_table_info('facts') WHERE name = 'sensitive'")
      .get() !== undefined;
    const row = this.#db
      .prepare(
        `SELECT status, deleted_at, privacy${hasSensitive ? ', sensitive' : ''}
           FROM facts WHERE id = ?`,
      )
      .get(factId);
    const keep = row !== undefined
      && row.deleted_at === null
      && row.status === 'active'
      && row.privacy === 'normal'
      && (!hasSensitive || Number(row.sensitive) === 0);
    if (!keep) {
      this.#db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(factId);
      return null;
    }
    const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    this.#db
      .prepare(
        `INSERT INTO fact_vectors (fact_id, dim, vec, embedder_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id) DO UPDATE SET
           dim = excluded.dim,
           vec = excluded.vec,
           embedder_id = excluded.embedder_id,
           updated_at = excluded.updated_at`,
      )
      .run(factId, vec.length, bytes, embedderId, nowSeconds());
    return { factId, embedderId, dim: vec.length };
  }

  /**
   * W4：列出需要回填的活跃事实（向量缺失 / embedder_id 不一致 / 维度不一致）。
   *
   * 只取 active + normal + 未删除 + 非 sensitive（若治理加了该列），
   * 墓碑/superseded/secret 不会进入 embedder（remote 隐私前提）。
   * @param {{embedderId?: string, dim?: number, limit?: number}} [input]
   * @returns {{id: string, text: string}[]}
   */
  listVectorBackfill(input = {}) {
    const embedderId = requireString(
      input.embedderId === undefined ? this.#vectorEmbedderId : input.embedderId,
      'fact_vectors.embedder_id',
    );
    const dim = input.dim === undefined ? this.#vectorDim : input.dim;
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 50;
    const hasSensitive = this.#db
      .prepare("SELECT 1 AS present FROM pragma_table_info('facts') WHERE name = 'sensitive'")
      .get() !== undefined;
    const dimFilter = Number.isInteger(dim) && dim > 0 ? ' OR fv.dim <> ?' : '';
    const params = [embedderId];
    if (dimFilter !== '') params.push(dim);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT f.id, f.statement, f.subject_text, f.predicate, f.object_text
           FROM facts f
           LEFT JOIN fact_vectors fv ON fv.fact_id = f.id
          WHERE f.status = 'active'
            AND f.deleted_at IS NULL
            AND f.privacy = 'normal'
            ${hasSensitive ? 'AND COALESCE(f.sensitive, 0) = 0' : ''}
            AND (fv.fact_id IS NULL OR fv.embedder_id <> ?${dimFilter})
          ORDER BY f.last_reinforced_at DESC, f.id ASC
          LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) => ({
      id: row.id,
      text: [row.statement, row.subject_text, row.predicate, row.object_text]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(' '),
    }));
  }

  /** 数据库文件路径。 */
  get dbPath() {
    return this.#dbPath;
  }

  /** 当前是否处于事务中（同步事务）。 */
  get inTransaction() {
    return this.#inTransaction;
  }

  #applyPragmas() {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  /**
   * 建表/迁移；可重复调用。
   *
   * v8/S-M1：旧库升级（#migrateFrom + 补列 + 触发器 + 索引 + scope 行）包在
   * 单个 BEGIN IMMEDIATE 事务里，崩溃不会留下「版本已升但列没补」的半迁移；
   * 新库或已是当前版本的库只走幂等的 ensure 路径。
   */
  migrate() {
    this.#db.exec(SCHEMA_SQL);
    this.#db
      .prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
    const row = this.#db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    const from = row ? String(row.value) : 'missing';
    const upgrading = from !== SCHEMA_VERSION;
    // v15：升级路径要重建 facts / memory_events（SQLite 改不了 CHECK）。facts 是
    // fact_vectors 的父表，foreign_keys=ON 时 DROP TABLE 会隐式 DELETE 并级联清空
    // 向量行；PRAGMA foreign_keys 在事务内是 no-op，所以必须在 BEGIN 之前关闭，
    // 提交/回滚后再恢复。非升级路径没有 DROP TABLE，不需要动。
    if (upgrading) {
      this.#db.exec('PRAGMA foreign_keys = OFF');
      this.#db.exec('BEGIN IMMEDIATE');
    }
    try {
      if (upgrading) this.#migrateFrom(from);
      // v10：reminders 增加 delivering 状态与 delivery_attempts；SQLite 改不了
      // CHECK，按列检测后重建表（幂等，新库直接命中「列已存在」）。
      this.#ensureRemindersDeliveryColumns();
      // v11：reminders 增加 occurrence_key（V6-M1），按列检测补列，旧行 NULL。
      this.#ensureReminderOccurrenceColumn();
      // v12：reminders 增加 retry_at（V5-L2 退避时刻），按列检测补列，旧行 NULL。
      this.#ensureReminderRetryColumn();
      // v15：reminders 增加 expired_notified_at / series_index（A4/A5），按列检测
      // 补列；升级路径已在 #migrateFrom 里补过，这里是新库/修复路径的幂等兜底。
      this.#ensureReminderExpiryColumns();
      // V8-L1/L2：到期表达式索引 + 改期清空 retry_at 的库级不变量（幂等，旧库就地补建）。
      this.#ensureReminderDueIndex();
      // v6/v7/v8/v9 的列与索引放在迁移之后处理：旧表此时才补上 embedder_id 与
      // first_reneed_*/same_context/first_used_* 列。ALTER 按列检测，重复调用安全。
      this.#ensureFactsReneedColumns();
      // v15：facts 计数三列（injected_count / used_count / unused_streak）。
      this.#ensureFactsCounterColumns();
      this.#ensureReneedKindTriggers();
      this.#db.exec(`
        CREATE INDEX IF NOT EXISTS ix_fact_vectors_embedder ON fact_vectors(embedder_id);
        CREATE INDEX IF NOT EXISTS ix_facts_reneed ON facts(scope, first_reneed_at);
        CREATE INDEX IF NOT EXISTS ix_facts_used ON facts(scope, first_used_at);
      `);
      this.#ensureScopeRow('main');
      // v13（V10-L1）：存量 episode/FTS 一次性脱敏。旧库升级与「已有数据但还没
      // 打标记」的库都在这里补齐一次；已标记 / 空库直接跳过（幂等）。
      this.#scrubLegacyEpisodes({ atomic: !upgrading });
      if (upgrading) this.#db.exec('COMMIT');
    } catch (error) {
      if (upgrading) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // 回滚失败时保留原始错误
        }
      }
      throw error;
    } finally {
      // 无论提交还是回滚，都恢复连接默认的 FK 约束（#applyPragmas 的约定）。
      if (upgrading) this.#db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * 读取 schema_meta 的字符串值。
   * @param {string} key
   * @returns {string|null}
   */
  getMeta(key) {
    const row = this.#db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
    return row === undefined ? null : String(row.value);
  }

  /**
   * 写入/覆盖 schema_meta 的字符串值（幂等）。
   * @param {string} key
   * @param {string} value
   * @returns {string}
   */
  setMeta(key, value) {
    const metaKey = requireString(key, 'schema_meta.key');
    const metaValue = requireString(value, 'schema_meta.value');
    this.#db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(metaKey, metaValue);
    return metaValue;
  }

  /**
   * 给旧 facts 表补 W5/v8/v9 的列（nullable，same_context 有默认值）。逐列检测，
   * 兼容任意旧版本。只新增列，不重建表、不动既有行；旧行 same_context=0，
   * v8 及更早的行 first_used_ 三列与 used_same_context 为 NULL（没有「用上」记录）。
   */
  #ensureFactsReneedColumns() {
    const columns = new Set(
      this.#db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has('first_reneed_at')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN first_reneed_at INTEGER');
    }
    if (!columns.has('first_reneed_tier')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN first_reneed_tier TEXT');
    }
    if (!columns.has('reneed_kind')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN reneed_kind TEXT');
    }
    if (!columns.has('same_context')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN same_context INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('first_used_at')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN first_used_at INTEGER');
    }
    if (!columns.has('first_used_tier')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN first_used_tier TEXT');
    }
    if (!columns.has('used_same_context')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN used_same_context INTEGER');
    }
  }

  /**
   * v8：`reneed_kind` 只允许 recall/dedupe/correction/used。
   *
   * 旧库的 facts 没有 CHECK 约束；重建表会牵动外键与 FTS rowid，代价和风险都
   * 高于收益。这里用等价的 BEFORE INSERT/UPDATE 触发器做库级校验：任何写入
   * 路径（含导出导入、手工 SQL）都绕不过去，且 CREATE TRIGGER IF NOT EXISTS
   * 可重复执行。
   */
  #ensureReneedKindTriggers() {
    // kind 字面量从 reneed.js 的 RENEED_KINDS 生成，避免这里与校验集合两处
    // 漂移。注意 CREATE TRIGGER IF NOT EXISTS 不会更新已存在的触发器：若将来
    // 增删 kind，需要在迁移里显式 DROP 再重建（当前 kind 集未变，不需要）。
    const kinds = RENEED_KINDS.map((kind) => `'${kind}'`).join(', ');
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_facts_reneed_kind_ins
      BEFORE INSERT ON facts
      WHEN NEW.reneed_kind IS NOT NULL
       AND NEW.reneed_kind NOT IN (${kinds})
      BEGIN
        SELECT RAISE(ABORT, 'invalid facts.reneed_kind');
      END;
      CREATE TRIGGER IF NOT EXISTS trg_facts_reneed_kind_upd
      BEFORE UPDATE OF reneed_kind ON facts
      WHEN NEW.reneed_kind IS NOT NULL
       AND NEW.reneed_kind NOT IN (${kinds})
      BEGIN
        SELECT RAISE(ABORT, 'invalid facts.reneed_kind');
      END;
    `);
  }

  /**
   * 升级旧库；支持 v3 → v4 → v5 → v6 → v7 → v8 → v9。
   *
   * v3 的 `consolidations.upto_seq` 是插件自增 turn 计数，与平台 surface seq
   * 不可比（H1）。开发期尚无用户数据，直接清空巩固行（facts/episodes 保留），
   * 并把 episodes.consolidation_id 置空以免外键阻断删除。
   *
   * v4 → v5 只新增 fact_vectors，DDL 已由 migrate() 的 SCHEMA_SQL 幂等建好；
   * 这里只推进版本号，不改任何既有数据。旧事实的向量由后续写入/编辑补齐。
   *
   * v5 → v6 给 fact_vectors 补 embedder_id：v5 旧行都是 hashEmbed 产物，
   * 回填为 `hash:<dim>`；其余新旧不匹配行留空，由空闲回填重建。
   *
   * v6 → v7 只推进版本号；first_reneed_* 三列由 migrate() 统一补，旧行 NULL。
   *
   * v7 → v8 只推进版本号；same_context 列与 reneed_kind 触发器由 migrate()
   * 统一补，旧行 same_context=0、first_reneed_* 原样保留。
   *
   * v8 → v9 只推进版本号；first_used_ 三列与 used_same_context 由 migrate()
   * 统一补（#ensureFactsReneedColumns），旧行 NULL，不需要回填：没有「用上」
   * 记录就是 NULL，不能用 recall 样本反推。
   * v9 → v10 只推进版本号；reminders 的 delivering 状态与 delivery_attempts
   * 由 migrate() 统一重建（#ensureRemindersDeliveryColumns）。
   * v10 → v11 只推进版本号；reminders.occurrence_key 由 migrate() 统一补列
   * （#ensureReminderOccurrenceColumn），旧行 NULL，不需要回填。
   * v11 → v12 只推进版本号；reminders.retry_at 由 migrate() 统一补列
   * （#ensureReminderRetryColumn），旧行 NULL，不需要回填。
   * v12 → v13 只推进版本号（无新列）；存量 episode 的脱敏 scrub 由 migrate()
   * 统一执行（#scrubLegacyEpisodes，带 schema_meta 标记，幂等）。
   * v13 → v14 只推进版本号（纯新增表）；emotion_state / emotion_events 由
   * migrate() 的 SCHEMA_SQL 幂等建好，旧库打开即补齐，不做任何数据回填。
   * v14 → v15 由 #upgradeToV15 统一处理：facts 补计数三列并重建 kind CHECK、
   * memory_events 重建 action CHECK、reminders 补两列，再用 recall_count 回填
   * used_count；各步都按列/表 SQL 检测，可重复执行。
   * @param {string} from 旧版本号
   */
  #migrateFrom(from) {
    const known = new Set(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']);
    if (!known.has(from)) {
      throw new StoreError(
        `[store] unsupported schema_version: ${from} (expected ${SCHEMA_VERSION})`,
      );
    }
    // 各版本自己的数据修补；列/索引/表重建统一由 #upgradeToV15 的幂等检测收口。
    if (from === '5') {
      // 事务由 migrate() 统一开启/提交（v8：整个升级路径单事务）。
      const columns = this.#db
        .prepare("PRAGMA table_info('fact_vectors')")
        .all()
        .map((column) => column.name);
      if (!columns.includes('embedder_id')) {
        this.#db.exec("ALTER TABLE fact_vectors ADD COLUMN embedder_id TEXT NOT NULL DEFAULT ''");
      }
      this.#db.exec(
        "UPDATE fact_vectors SET embedder_id = 'hash:' || dim WHERE embedder_id = ''",
      );
    } else if (from === '3') {
      // v3 → v4：事务由 migrate() 统一开启/提交（v8：整个升级路径单事务）。
      const columns = this.#db
        .prepare("PRAGMA table_info('consolidations')")
        .all()
        .map((column) => column.name);
      if (!columns.includes('compaction_start_seq')) {
        this.#db.exec('ALTER TABLE consolidations ADD COLUMN compaction_start_seq INTEGER');
      }
      this.#db.exec('UPDATE episodes SET consolidation_id = NULL WHERE consolidation_id IS NOT NULL');
      this.#db.exec('DELETE FROM consolidations');
    }
    // v3..v14 → v15：补列 + 两处 CHECK 枚举重建 + recall_count 回填，全部幂等。
    this.#upgradeToV15();
    this.#db
      .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
      .run(SCHEMA_VERSION);
  }

  /**
   * v15：把任意 v3..v14 库补齐到 v15 形态。
   *
   * 四步都按「列是否存在 / 表 SQL 是否已含新枚举」检测，重复调用安全；调用方
   * （#migrateFrom）已在 migrate() 的升级事务内，且事务期间 foreign_keys 已关闭
   * （facts 重建不能级联清空 fact_vectors）。
   */
  #upgradeToV15() {
    this.#ensureFactsCounterColumns();
    this.#rebuildFactsForKindEnum();
    this.#rebuildMemoryEventsForActions();
    this.#ensureReminderExpiryColumns();
    // v14 遗留：recall_count 只被旧代码累加。v15 起 used_count 是唯一计数来源，
    // 升级时把历史召回次数搬一次；`used_count = 0` 条件保证重复执行不会重复累加。
    this.#db.exec(`
      UPDATE facts
         SET used_count = recall_count
       WHERE used_count = 0 AND recall_count > 0
    `);
  }

  /**
   * v15（A8.1/A8.2）：facts 增加 injected_count / used_count / unused_streak。
   * 逐列 ALTER，旧行取默认 0；新库 SCHEMA_SQL 已含三列，直接命中。
   */
  #ensureFactsCounterColumns() {
    const columns = new Set(
      this.#db
        .prepare("PRAGMA table_info('facts')")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has('injected_count')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN injected_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('used_count')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.has('unused_streak')) {
      this.#db.exec('ALTER TABLE facts ADD COLUMN unused_streak INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * v15（A8.5）：facts.kind 扩枚举，SQLite 改不了 CHECK，只能整表重建。
   *
   * - 幂等：以 sqlite_master 里 facts 的 SQL 是否已含 `'lifestyle'` 判定；旧库
   *   （v3..v14）的 SQL 里没有该值，新库由 SCHEMA_SQL 直接建好，直接返回。
   * - 行标识：INSERT 显式带上 rowid，并在 SELECT 里取旧 rowid——fts_facts 是独立
   *   FTS5 表、按 `facts.rowid` 关联，丢了 rowid 旧行的全文命中会全部错位。
   * - 列集合取新旧交集（PRAGMA table_info），旧版本缺的列由新 DDL 的默认值补；
   *   先前的 ALTER 已把 v15 三列补上，所以它们会被原样搬过去。
   * - DROP/RENAME 期间 FK 已由 migrate() 关闭，fact_vectors 不会被级联删除。
   */
  #rebuildFactsForKindEnum() {
    const row = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'")
      .get();
    if (row && String(row.sql).includes("'lifestyle'")) return;
    const columns = this.#db
      .prepare("PRAGMA table_info('facts')")
      .all()
      .map((column) => column.name);
    if (columns.length === 0) {
      throw new StoreError('[store] facts table missing during v15 rebuild');
    }
    this.#db.exec('DROP TABLE IF EXISTS facts_v15');
    this.#db.exec(factsTableDdl('facts_v15'));
    const names = columns.join(', ');
    this.#db.exec(`INSERT INTO facts_v15 (rowid, ${names}) SELECT rowid, ${names} FROM facts`);
    this.#db.exec('DROP TABLE facts');
    this.#db.exec('ALTER TABLE facts_v15 RENAME TO facts');
    // 索引随旧表 DROP 一起消失，按新表名重建（名字保持 v14 约定）。
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(subject_text, predicate, status);
      CREATE INDEX IF NOT EXISTS ix_facts_scope ON facts(scope, status) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS ix_facts_decay ON facts(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_facts_purge ON facts(deleted_at) WHERE deleted_at IS NOT NULL;
    `);
  }

  /**
   * v15（B3）：memory_events.action 扩枚举（govern / EDIT / scrub）。
   *
   * 与 facts 同样整表重建，显式保留 rowid（id 是 INTEGER PRIMARY KEY，别名 rowid；
   * 旧 id 有空洞时也原样保留，AUTOINCREMENT 的下一个值由 SQLite 自己续上）。
   * 重建后补回 ix_ev_row 与两个 append-only 触发器。
   */
  #rebuildMemoryEventsForActions() {
    const row = this.#db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_events'")
      .get();
    if (row && String(row.sql).includes("'govern'")) return;
    const columns = this.#db
      .prepare("PRAGMA table_info('memory_events')")
      .all()
      .map((column) => column.name);
    if (columns.length === 0) {
      throw new StoreError('[store] memory_events table missing during v15 rebuild');
    }
    this.#db.exec('DROP TABLE IF EXISTS memory_events_v15');
    this.#db.exec(memoryEventsTableDdl('memory_events_v15'));
    // id 就是 rowid 的别名，只显式写 rowid，避免同一列出现两次。
    const names = columns.filter((name) => name !== 'id').join(', ');
    this.#db.exec(
      `INSERT INTO memory_events_v15 (rowid, ${names}) SELECT rowid, ${names} FROM memory_events`,
    );
    this.#db.exec('DROP TABLE memory_events');
    this.#db.exec('ALTER TABLE memory_events_v15 RENAME TO memory_events');
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS ix_ev_row ON memory_events(table_name, row_id, at DESC);
      CREATE TRIGGER IF NOT EXISTS ev_no_update BEFORE UPDATE ON memory_events
      BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ev_no_delete BEFORE DELETE ON memory_events
      BEGIN SELECT RAISE(ABORT,'append-only'); END;
    `);
  }

  /**
   * v15（A4/A5）：reminders 增加 expired_notified_at（过期一次性通知）与
   * series_index（重复提醒系列序号）。逐列 ALTER，旧行分别取 NULL / 0。
   */
  #ensureReminderExpiryColumns() {
    const columns = new Set(
      this.#db
        .prepare("PRAGMA table_info('reminders')")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has('expired_notified_at')) {
      this.#db.exec('ALTER TABLE reminders ADD COLUMN expired_notified_at INTEGER');
    }
    if (!columns.has('series_index')) {
      this.#db.exec('ALTER TABLE reminders ADD COLUMN series_index INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * V10-L1（v13）：存量 episodes 一次性脱敏 scrub。
   *
   * v0.4.10 的写入路径（insertEpisode / consolidate）已对 episode 六字段脱敏，
   * 但更早落库的行仍可能含明文凭据值（如「路由器密码 蓝鲸-7788」），并已投影
   * 进 fts_episodes。这里对历史行重跑写入路径的同一口径：
   * - 文本字段走 `redactEpisodeText`（值级替换；仍残留值形态才整段替换）；
   * - topics_json / entities_json 逐项脱敏并保持 JSON 合法；
   * - 只有真正变化的行才 UPDATE 并 `#refreshEpisodesFts` 重建投影，未变化的行
   *   一个字节都不动（幂等 + 大库可控）。
   *
   * 幂等与审计：成功后在 schema_meta 写 `episode_scrub_v13` 标记，之后重复打开
   * 直接跳过；扫描过行就写一条 memory_events（action=scrub，detail 只含
   * {scanned, changed}，不含正文）。空库也写标记（v15/B1：否则每次打开空库都要
   * 重新探测一遍），但 scanned === 0 时不写审计事件，避免给新建库留审计噪音。
   * 凭据判定面在每行上逐字段重跑，不依赖 SQL 预筛（预筛只能当优化，
   * 会漏掉 sk-/卡号/设备值等没有「密码」字样的形态）。
   *
   * 事务：升级路径由 `migrate()` 的 BEGIN IMMEDIATE 包住（失败连同版本号一起
   * 回滚）；非升级的补齐路径（有数据但还没有标记）自己开事务，保证「改行 +
   * 重建 FTS + 标记 + 审计」原子。调用方保证事务内不做网络/计时。
   *
   * @param {{atomic?: boolean}} [options]
   * @returns {{skipped: boolean, scanned: number, changed: number, eventId: number|null}}
   */
  #scrubLegacyEpisodes(options = {}) {
    if (this.getMeta(EPISODE_SCRUB_MARKER) !== null) {
      return { skipped: true, scanned: 0, changed: 0, eventId: null };
    }
    const columns = new Set(
      this.#db
        .prepare("PRAGMA table_info('episodes')")
        .all()
        .map((column) => column.name),
    );
    if (columns.size === 0) {
      throw new StoreError('[store] episodes table missing during v13 scrub');
    }
    // mood_evidence 之外的列在各旧版本 DDL 里都存在；按列检测只为兼容砍过列的库。
    const fields = ['title', 'summary', 'evidence', 'topics_json', 'entities_json', 'mood_evidence']
      .filter((name) => columns.has(name));
    const total = Number(this.#db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n);
    if (total === 0) {
      // v15（B1）：空库也落标记，避免每次打开都重跑一遍探测；没有扫描到行，
      // 所以不写审计事件（新建库不应有 scrub 审计噪音）。
      this.setMeta(EPISODE_SCRUB_MARKER, String(nowSeconds()));
      return { skipped: false, scanned: 0, changed: 0, eventId: null };
    }

    const atomic = options.atomic === true;
    if (atomic) this.#db.exec('BEGIN IMMEDIATE');
    try {
      const jsonFields = new Set(['topics_json', 'entities_json']);
      const select = `SELECT rowid AS rid, id, ${fields.join(', ')} FROM episodes`;
      const update = `UPDATE episodes SET ${fields.map((name) => `${name} = ?`).join(', ')} WHERE rowid = ?`;
      const updateStmt = this.#db.prepare(update);
      let cursor = 0;
      let scanned = 0;
      let changed = 0;
      for (;;) {
        const rows = this.#db
          .prepare(`${select} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`)
          .all(cursor, EPISODE_SCRUB_BATCH);
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = Number(row.rid);
          scanned += 1;
          const next = {};
          let touched = false;
          for (const field of fields) {
            const previous = row[field];
            const value = jsonFields.has(field)
              ? scrubEpisodeJsonText(previous)
              : redactEpisodeText(previous);
            next[field] = value;
            if (value !== previous) touched = true;
          }
          if (!touched) continue;
          updateStmt.run(...fields.map((field) => next[field]), row.rid);
          // 只有发生变化的行才重建 FTS 投影；未变化的行不动投影（幂等）。
          this.#refreshEpisodesFts(String(row.id));
          changed += 1;
        }
        if (rows.length < EPISODE_SCRUB_BATCH) break;
      }

      // 标记在数据落库之后写；升级路径与 scrub 同一事务，半迁移不会留下标记。
      this.setMeta(EPISODE_SCRUB_MARKER, String(nowSeconds()));
      const eventId = appendEventWithAction(this, {
        action: 'scrub',
        tableName: 'episodes',
        actor: 'migrator',
        reason: 'v13-legacy-episode-scrub',
        detail: { scanned, changed },
      });
      if (atomic) this.#db.exec('COMMIT');
      return { skipped: false, scanned, changed, eventId };
    } catch (error) {
      if (atomic) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // 回滚失败时保留原始错误
        }
      }
      throw error;
    }
  }

  /**
   * v10：reminders 增加 `delivering` 状态与 delivery_attempts。
   *
   * SQLite 无法修改 CHECK 约束，因此旧表按「是否已有 delivery_attempts 列」判定，
   * 需要时整表重建（新 DDL 与原表一致，只多一列并放宽 status CHECK）。重建必须
   * 在新库/旧库都幂等：新库 SCHEMA_SQL 已含该列，直接返回；索引在 DROP TABLE 时
   * 会一并删除，重建后补回。调用方（migrate）已包在 BEGIN IMMEDIATE 里。
   */
  #ensureRemindersDeliveryColumns() {
    const columns = this.#db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    if (columns.includes('delivery_attempts')) return;
    this.#db.exec(`
      DROP TABLE IF EXISTS reminders_v10;
      CREATE TABLE reminders_v10 (
        id                TEXT PRIMARY KEY,
        scope             TEXT NOT NULL DEFAULT 'main',
        kind              TEXT NOT NULL CHECK (kind IN ('todo','schedule','repeat','commitment')),
        title             TEXT NOT NULL,
        detail            TEXT,
        counterparty      TEXT,
        due_at            INTEGER,
        due_granularity   TEXT CHECK (due_granularity IN ('exact','day','week','month','none')),
        rrule             TEXT,
        next_fire_at      INTEGER,
        retry_at          INTEGER,
        last_fire_key     TEXT,
        occurrence_key    TEXT,
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','delivering','fired','snoozed','done','cancelled','expired')),
        closed_at         INTEGER,
        source_episode_id TEXT REFERENCES episodes(id),
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        deleted_at        INTEGER
      );
      INSERT INTO reminders_v10 (
        id, scope, kind, title, detail, counterparty, due_at, due_granularity, rrule,
        next_fire_at, last_fire_key, status, closed_at, source_episode_id,
        delivery_attempts, created_at, updated_at, deleted_at
      )
        SELECT id, scope, kind, title, detail, counterparty, due_at, due_granularity, rrule,
               next_fire_at, last_fire_key, status, closed_at, source_episode_id,
               0, created_at, updated_at, deleted_at
          FROM reminders;
      DROP TABLE reminders;
      ALTER TABLE reminders_v10 RENAME TO reminders;
      -- 只补不依赖 retry_at 的索引；ix_rm_due 由 #ensureReminderDueIndex 在
      -- 补列之后创建（v9 库此时还没有 retry_at 列）。
      CREATE INDEX IF NOT EXISTS ix_rm_done ON reminders(closed_at)
        WHERE status IN ('done','cancelled');
    `);
  }

  /**
   * v11（V6-M1）：reminders 增加 occurrence_key。
   *
   * 只加可空列，不重建表；旧行保持 NULL，等到下一次真正到点入队时再惰性生成。
   * 逐列检测因此对新库、v10 旧库、v3..v9 升级路径都幂等；调用方（migrate）已包在
   * BEGIN IMMEDIATE 里。
   */
  #ensureReminderOccurrenceColumn() {
    const columns = this.#db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    if (columns.includes('occurrence_key')) return;
    this.#db.exec('ALTER TABLE reminders ADD COLUMN occurrence_key TEXT');
  }

  /**
   * v12（V5-L2）：reminders 增加 retry_at（退避时刻，NULL 表示未在重试）。
   *
   * 只加可空列，不重建表；旧行保持 NULL（到期口径 max(next_fire_at, retry_at)
   * 里 NULL 按 0 处理，等价于「还没有退避时刻」）。
   * 逐列检测因此对新库、v11 旧库、v3..v10 升级/重建路径都幂等；调用方
   * （migrate）已包在 BEGIN IMMEDIATE 里。
   */
  #ensureReminderRetryColumn() {
    const columns = this.#db
      .prepare("PRAGMA table_info('reminders')")
      .all()
      .map((column) => column.name);
    if (columns.includes('retry_at')) return;
    this.#db.exec('ALTER TABLE reminders ADD COLUMN retry_at INTEGER');
  }

  /**
   * V8-L1/L2：提醒到期索引迁移 + 改期清空 retry_at 的库级不变量。
   *
   * 1) `ix_rm_due(status, max(COALESCE(next_fire_at,0), COALESCE(retry_at,0)))`
   *    是 dueReminders 唯一可能命中的索引（表达式必须与查询里的表达式树一致）。
   * 2) 删除旧 `ix_rm_fire(status, next_fire_at)`：它建在裸列上，而到期判断自
   *    v0.4.8 起只用 max(...) 表达式，任何查询都走不到它；保留只会让每次提醒
   *    状态变更多维护一棵 B 树（还多一份写入放大），并给 planner 一个永远不被
   *    选中的候选。全仓没有其它按 (status, next_fire_at) 过滤的查询。
   * 3) 触发器在「next_fire_at 被改写」时清空残留的 retry_at（V8-L2）：唯一到期
   *    口径是 max(...)，旧的 retry_at 会压过新时间导致改期后仍按旧退避时刻到期。
   *    把它放在库级而不是只放在某个方法里，是为了让导入/恢复、手工 SQL、将来新增
   *    的 snooze 路径共享同一条不变量；触发器的内层 UPDATE 不再改 next_fire_at，
   *    不会递归。
   *
   * 全部是 CREATE/DROP ... IF [NOT] EXISTS，可重复执行；旧库（v3..v12）在
   * migrate() 的升级事务里就地补建，不需要提升 schema_version。
   */
  #ensureReminderDueIndex() {
    this.#db.exec(`
      DROP INDEX IF EXISTS ix_rm_fire;
      CREATE INDEX IF NOT EXISTS ix_rm_due ON reminders(status, ${REMINDER_DUE_AT_SQL})
        WHERE status IN ('pending','snoozed');
      CREATE TRIGGER IF NOT EXISTS trg_reminders_reschedule_clear_retry
      AFTER UPDATE OF next_fire_at ON reminders
      WHEN NEW.next_fire_at IS NOT OLD.next_fire_at
       AND NEW.retry_at IS NOT NULL
      BEGIN
        UPDATE reminders SET retry_at = NULL WHERE id = NEW.id;
      END;
    `);
  }

  close() {
    this.#db.close();
  }

  /**
   * 同步事务：BEGIN IMMEDIATE → fn() → COMMIT；fn 抛错（或返回 Promise）时
   * ROLLBACK 并原样重抛。返回值原样透传。不支持嵌套调用。
   * @template T
   * @param {() => T} fn 同步函数
   * @returns {T}
   */
  transaction(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[store] transaction(fn) requires a function');
    }
    if (this.#inTransaction) {
      throw new StoreError('[store] nested transaction is not supported');
    }
    // t17：SQLITE_BUSY/locked 是并发写库的瞬时抖动，入口最多重试 3 次
    //（首次 + 3 次重试）。每次重试前都已 ROLLBACK，不会留下半开事务；
    // 最终失败原样重抛，不吞错。
    let lastError;
    for (let attempt = 1; attempt <= BUSY_MAX_ATTEMPTS; attempt += 1) {
      try {
        this.#db.exec('BEGIN IMMEDIATE');
        this.#inTransaction = true;
        try {
          const result = fn();
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            throw new StoreError('[store] transaction(fn) requires a synchronous function');
          }
          this.#db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            this.#db.exec('ROLLBACK');
          } catch {
            // ROLLBACK 失败时保留原始错误
          }
          throw error;
        } finally {
          this.#inTransaction = false;
        }
      } catch (error) {
        lastError = error;
        if (!isBusyError(error) || attempt >= BUSY_MAX_ATTEMPTS) throw error;
        sleepSync(busyBackoffMs(attempt));
      }
    }
    // 理论不可达；保留最终错误，避免吞错。
    throw lastError;
  }

  /**
   * 内部原子执行：已在事务中则直接执行，否则自行 BEGIN/COMMIT。
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  #atomic(fn) {
    if (this.#inTransaction) return fn();
    return this.transaction(fn);
  }

  // ---------------------------------------------------------------- FTS

  /**
   * 重写一条 FTS 投影（先删后插，保证 fidility/文本变化后不残留旧 token）。
   * @param {'fts_facts'|'fts_episodes'} table 内部常量
   * @param {number} rowid 主表 rowid
   * @param {string} text 原始文本
   */
  #replaceFts(table, rowid, text) {
    this.#db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowid);
    this.#db.prepare(`INSERT INTO ${table} (rowid, txt) VALUES (?, ?)`).run(rowid, toBigrams(text));
  }

  /** @param {string} id */
  #refreshFactsFts(id) {
    const row = this.#db
      .prepare(
        `SELECT rowid AS rid, fidelity, statement, subject_text, predicate, object_text
           FROM facts WHERE id = ?`,
      )
      .get(id);
    if (!row) return;
    const parts = [row.statement, row.subject_text, row.predicate];
    if (row.fidelity === 'full') parts.push(row.object_text);
    this.#replaceFts('fts_facts', row.rid, parts.filter(Boolean).join('\n'));
  }

  /**
   * P2-b：维护 fact_vectors 投影。
   *
   * 只有 active + normal + 未删除的事实保留向量；tombstone/superseded/
   * sensitive/secret/物理删除都会清掉。这里用 hashEmbed 的离线向量，
   * 真实 embedding 接入时应替换本方法的 embed 来源。
   * @param {string} id
   */
  #syncFactVector(id) {
    // P1-a 的治理会在命中敏感文本时按需 ALTER TABLE 加 sensitive 列；
    // 该列不在基础 schema 里，存在时必须一并排除，避免治理后仍从向量通道召回。
    const hasSensitive = this.#db
      .prepare("SELECT 1 AS present FROM pragma_table_info('facts') WHERE name = 'sensitive'")
      .get() !== undefined;
    const row = this.#db
      .prepare(
        `SELECT id, statement, subject_text, predicate, object_text,
                privacy, status, deleted_at${hasSensitive ? ', sensitive' : ''}
           FROM facts WHERE id = ?`,
      )
      .get(id);
    const keep = row !== undefined
      && row.deleted_at === null
      && row.status === 'active'
      && row.privacy === 'normal'
      && (!hasSensitive || Number(row.sensitive) === 0);
    if (!keep) {
      this.#db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(id);
      return;
    }
    const text = [row.statement, row.subject_text, row.predicate, row.object_text]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' ');
    // 异步 embedder（local/remote）没有同步向量函数：先清掉旧 id 的投影，
    // 等 idle-probe 的回填用新 id 补写，避免检索命中过期向量。
    if (this.#vectorEmbed === null) {
      this.#db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(id);
      return;
    }
    const vec = this.#vectorEmbed(text, this.#vectorDim);
    if (!(vec instanceof Float32Array) || vec.length !== this.#vectorDim) {
      throw new StoreError('[store] vector embed returned an unexpected dimension');
    }
    const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    this.#db
      .prepare(
        `INSERT INTO fact_vectors (fact_id, dim, vec, embedder_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fact_id) DO UPDATE SET
           dim = excluded.dim,
           vec = excluded.vec,
           embedder_id = excluded.embedder_id,
           updated_at = excluded.updated_at`,
      )
      .run(id, this.#vectorDim, bytes, this.#vectorEmbedderId, nowSeconds());
  }

  /** @param {string} id */
  #refreshEpisodesFts(id) {
    const row = this.#db
      .prepare(
        `SELECT rowid AS rid, fidelity, title, summary, topics_json
           FROM episodes WHERE id = ?`,
      )
      .get(id);
    if (!row) return;
    const topics = parseJsonArray(row.topics_json).join(' ');
    this.#replaceFts('fts_episodes', row.rid, [row.title, row.summary, topics].filter(Boolean).join('\n'));
  }

  // ------------------------------------------------------------ episodes

  /**
   * 写入一条情景并同步 FTS。
   * @param {object} input
   * @returns {object} 落库后的行
   */
  insertEpisode(input = {}) {
    const salience = input.salience ?? 'normal';
    const strengthDays = resolveStrengthDays(salience, input.strength_days);
    const id = input.id ?? newId('ep');
    const startedAt = epochOr(input.started_at, nowSeconds());
    const endedAt = epochOr(input.ended_at, startedAt);
    const lastReinforcedAt = epochOr(input.last_reinforced_at, nowSeconds());
    this.#db
      .prepare(
        `INSERT INTO episodes (
           id, scope, session_id, consolidation_id, started_at, ended_at, title, summary,
           evidence, topics_json, entities_json, mood, mood_evidence, salience, privacy,
           strength_days, last_reinforced_at, recall_count, fidelity, status, deleted_at,
           purge_payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.scope ?? 'main',
        requireString(input.session_id, 'episodes.session_id'),
        input.consolidation_id ?? null,
        startedAt,
        endedAt,
        redactEpisodeInput(requireString(input.title, 'episodes.title')),
        redactEpisodeInput(input.summary ?? null),
        redactEpisodeInput(input.evidence ?? null),
        toJsonArray(redactEpisodeInput(input.topics ?? input.topics_json)),
        toJsonArray(redactEpisodeInput(input.entities ?? input.entities_json)),
        input.mood ?? null,
        redactEpisodeInput(input.mood_evidence ?? null),
        salience,
        input.privacy ?? 'normal',
        strengthDays,
        lastReinforcedAt,
        input.recall_count ?? 0,
        input.fidelity ?? 'full',
        input.status ?? 'active',
        epochOr(input.deleted_at, null),
        input.purge_payload ?? null,
      );
    this.#refreshEpisodesFts(id);
    return this.getEpisode(id);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getEpisode(id) {
    return this.#db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) ?? null;
  }

  /**
   * 按作用域列出情景（默认排除已标记删除的行）。
   * @param {{scope?: string, status?: string, includeDeleted?: boolean, limit?: number, offset?: number}} [options]
   * @returns {object[]}
   */
  listEpisodes(options = {}) {
    const where = [];
    const args = [];
    if (options.scope !== undefined) {
      where.push('scope = ?');
      args.push(options.scope);
    }
    if (options.status !== undefined) {
      where.push('status = ?');
      args.push(options.status);
    }
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    const limit = clampLimit(options.limit, 50);
    const offset = clampOffset(options.offset);
    const sql = `
      SELECT * FROM episodes
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC, id DESC
      LIMIT ? OFFSET ?`;
    return this.#db.prepare(sql).all(...args, limit, offset);
  }

  /**
   * S1：标记删除（deleted_at），保留 FTS 直到 S2 purge。
   * @param {string} id
   * @param {{now?: number|Date}} [options]
   * @returns {object|null}
   */
  deleteEpisode(id, options = {}) {
    const at = epochOr(options.now, nowSeconds());
    const info = this.#db
      .prepare('UPDATE episodes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, id);
    return info.changes > 0 ? this.getEpisode(id) : null;
  }

  /**
   * 更新一条情景（白名单字段，06 v3.3 §8.2）。
   *
   * 未知字段抛 TypeError（避免拼错列名被静默忽略）；topics_json /
   * entities_json 接受数组或 JSON 文本；deleted_at 接受 Unix 秒或 Date。
   * 改 title/summary/topics_json 后同步重写 FTS 投影。
   *
   * @param {string} id
   * @param {object} [patch]
   * @returns {object|null} 更新后的行；行不存在返回 null
   */
  updateEpisode(id, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('[store] updateEpisode(id, patch) requires a patch object');
    }
    const current = this.getEpisode(id);
    if (!current) return null;

    const textColumns = new Set([
      'title', 'summary', 'evidence', 'mood', 'fidelity', 'status', 'purge_payload',
    ]);
    const jsonColumns = new Set(['topics_json', 'entities_json']);
    /** @type {Map<string, unknown>} */
    const fields = new Map();

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'deleted_at') {
        fields.set(key, epochOr(value, null));
      } else if (jsonColumns.has(key)) {
        fields.set(key, toJsonArray(value));
      } else if (key === 'title') {
        fields.set(key, requireString(value, 'episodes.title'));
      } else if (key === 'status') {
        if (!EPISODE_STATUSES.has(value)) {
          throw new TypeError(`[store] invalid episode status: ${String(value)}`);
        }
        fields.set(key, value);
      } else if (key === 'mood') {
        if (value !== null && value !== undefined && !MOOD_VALUES.has(value)) {
          throw new TypeError(`[store] invalid episode mood: ${String(value)}`);
        }
        fields.set(key, value ?? null);
      } else if (key === 'fidelity') {
        if (value !== null && value !== undefined && !FIDELITY_VALUES.has(value)) {
          throw new TypeError(`[store] invalid episode fidelity: ${String(value)}`);
        }
        fields.set(key, value ?? null);
      } else if (textColumns.has(key)) {
        fields.set(key, value ?? null);
      } else {
        throw new TypeError(`[store] updateEpisode: unknown field "${key}"`);
      }
    }

    if (fields.size === 0) return current;

    const assignments = [...fields.keys()].map((key) => `${key} = ?`);
    this.#db
      .prepare(`UPDATE episodes SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...fields.values(), id);
    this.#refreshEpisodesFts(id);
    return this.getEpisode(id);
  }

  /**
   * S1 显式遗忘情景：仅 active 可转 tombstoned，正文快照写 purge_payload，
   * 行与 FTS 保留到 S2 purge（06 v3.3 §7.8「立即停读 → 7 天冷静期」）。
   * 已 tombstoned 或行不存在（含 dormant）返回 false，保持幂等。
   *
   * @param {string} id
   * @param {{at?: number|Date, payload?: unknown}} [options]
   * @returns {boolean} 是否发生状态迁移
   */
  forgetEpisode(id, options = {}) {
    const at = epochOr(options.at, nowSeconds());
    const payload = JSON.stringify(options.payload ?? {});
    const info = this.#db
      .prepare(
        `UPDATE episodes
            SET status = 'tombstoned', deleted_at = ?, purge_payload = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(at, payload, id);
    return Number(info.changes) > 0;
  }

  // --------------------------------------------------------------- facts

  /**
   * 记录一条事实的「首次再需要」（W5 S0 标定，recall/漏样本对照）。幂等：只有
   * first_reneed_at 为 NULL 时才写，后到的 recall/correction 不覆盖首次样本。
   *
   * v8：`sameContext=true` 标记同会话即时召回（写入后 <6h 或来源 episode 仍在
   * 当前 surface），统计时排除；kind 允许 `used`。
   *
   * v9/M-1：`reneed_kind='used'` 的行整体跳过——used 主样本可能先于 recall
   * 样本出现（index 档注入不写 first_reneed_at），后续 full/gist 注入不得把
   * kind 降级回 recall，也不得补写晚于 first_used_at 的 first_reneed_at。
   *
   * @param {string} id
   * @param {{at?: number|Date, tier: 'clear'|'ambiguous'|'miss',
   *          kind: 'recall'|'dedupe'|'correction'|'used',
   *          sameContext?: boolean}} options
   * @returns {boolean} 是否本次写入（false = 已有首次样本/已是 used 或行不存在）
   */
  markFirstReneed(id, options = {}) {
    const factId = requireString(id, 'first_reneed.id');
    const tier = requireString(options.tier, 'first_reneed.tier');
    if (!RENEED_TIERS.has(tier)) {
      throw new TypeError(`[store] invalid first_reneed.tier: ${String(tier)}`);
    }
    const kind = requireString(options.kind, 'first_reneed.kind');
    if (!RENEED_KIND_SET.has(kind)) {
      throw new TypeError(`[store] invalid first_reneed.kind: ${String(kind)}`);
    }
    const at = epochOr(options.at, nowSeconds());
    const sameContext = options.sameContext === true ? 1 : 0;
    const info = this.#db
      .prepare(
        `UPDATE facts
            SET first_reneed_at = ?, first_reneed_tier = ?, reneed_kind = ?,
                same_context = ?, updated_at = unixepoch()
          WHERE id = ? AND first_reneed_at IS NULL
            AND (reneed_kind IS NULL OR reneed_kind <> 'used')`,
      )
      .run(at, tier, kind, sameContext, factId);
    return Number(info.changes) > 0;
  }

  /**
   * 记录「首次被用上」（v9 / S2-M1）。
   *
   * 与 recall 样本（first_reneed_*）分账：注入时写的那组列保持不动，作对照；
   * 这里只写用上那一刻的事实——`first_used_at`=当前时刻、`first_used_tier`=
   * 当前档位、`used_same_context`=当场按 observed_at 重算的同会话判定
   * （调用方负责判定，store 只落库）。
   *
   * 覆盖语义（首次「非 same_context 的用上」）：
   * - 尚无 first_used_*：写入；
   * - 已有 used_same_context=1、本次为 0：允许覆盖一次（把「刚写完就被注入
   *   过」的伪样本换成真正的跨会话用上）；
   * - 已有 used_same_context=0：不再覆盖，保持真正的首次。
   *
   * 只处理 `recall` / `used` / 尚未写入的样本；`dedupe`/`correction` 是更早的
   * “漏”样本，不能被后来的使用覆盖，返回 false。
   *
   * @param {string} id
   * @param {{at?: number|Date, tier: 'clear'|'ambiguous'|'miss',
   *          sameContext?: boolean}} options
   * @returns {boolean} 是否本次写入/覆盖
   */
  markReneedUsed(id, options = {}) {
    const factId = requireString(id, 'first_reneed.id');
    const tier = requireString(options.tier, 'first_reneed.tier');
    if (!RENEED_TIERS.has(tier)) {
      throw new TypeError(`[store] invalid first_reneed.tier: ${String(tier)}`);
    }
    const at = epochOr(options.at, nowSeconds());
    const sameContext = options.sameContext === true ? 1 : 0;
    const info = this.#db
      .prepare(
        `UPDATE facts
            SET first_used_at = ?,
                first_used_tier = ?,
                used_same_context = ?,
                reneed_kind = 'used',
                updated_at = unixepoch()
          WHERE id = ?
            AND (reneed_kind IS NULL OR reneed_kind IN ('recall', 'used'))
            AND (used_same_context IS NULL
                 OR (used_same_context = 1 AND ? = 0))`,
      )
      .run(at, tier, sameContext, factId, sameContext);
    return Number(info.changes) > 0;
  }

  /**
   * 写入一条事实并同步 FTS。
   * @param {object} input
   * @returns {object} 落库后的行
   */
  insertFact(input = {}) {
    const salience = input.salience ?? 'normal';
    const strengthDays = resolveStrengthDays(salience, input.strength_days);
    const id = input.id ?? newId('fact');
    const observedAt = epochOr(input.observed_at, nowSeconds());
    const lastReinforcedAt = epochOr(input.last_reinforced_at, nowSeconds());
    this.#db
      .prepare(
        `INSERT INTO facts (
           id, scope, kind, subject_id, subject_text, predicate, object_text, statement,
           source_kind, source_episode_id, source_excerpt, salience, privacy, observed_at,
           valid_from, valid_to, strength_days, last_reinforced_at, recall_count, fidelity,
           status, superseded_by, deleted_at, purge_payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.scope ?? 'main',
        requireFactKind(input.kind),
        input.subject_id ?? null,
        requireString(input.subject_text, 'facts.subject_text'),
        requireString(input.predicate, 'facts.predicate'),
        input.object_text ?? null,
        requireString(input.statement, 'facts.statement'),
        requireString(input.source_kind, 'facts.source_kind'),
        input.source_episode_id ?? null,
        input.source_excerpt ?? null,
        salience,
        input.privacy ?? 'normal',
        observedAt,
        epochOr(input.valid_from, null),
        epochOr(input.valid_to, null),
        strengthDays,
        lastReinforcedAt,
        // v14 遗留列：v15 起新 API 不再写 recall_count（保留仅为读旧库/导入兼容）。
        input.recall_count ?? 0,
        input.fidelity ?? 'full',
        input.status ?? 'active',
        input.superseded_by ?? null,
        epochOr(input.deleted_at, null),
        input.purge_payload ?? null,
      );
    this.#refreshFactsFts(id);
    this.#syncFactVector(id);
    return this.getFact(id);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getFact(id) {
    return this.#db.prepare('SELECT * FROM facts WHERE id = ?').get(id) ?? null;
  }

  /**
   * 局部更新事实；变更文本后自动刷新 FTS。salience 与 strength_days 联动：
   * 改 salience 未显式给 strength_days 时按新 salience 取 S0 默认值。
   * @param {string} id
   * @param {object} patch
   * @returns {object|null}
   */
  updateFact(id, patch = {}) {
    const current = this.getFact(id);
    if (!current) return null;

    /** @type {Map<string, unknown>} */
    const fields = new Map();
    const textColumns = new Set([
      'subject_id', 'subject_text', 'predicate', 'object_text', 'statement',
      'source_kind', 'source_episode_id', 'source_excerpt', 'privacy', 'fidelity',
      'status', 'superseded_by', 'purge_payload',
    ]);
    const epochColumns = new Set(['observed_at', 'valid_from', 'valid_to', 'deleted_at']);

    for (const [key, value] of Object.entries(patch)) {
      if (epochColumns.has(key)) {
        fields.set(key, epochOr(value, null));
      } else if (key === 'kind') {
        fields.set(key, requireFactKind(value));
      } else if (key === 'recall_count') {
        // v14 遗留计数：保留写入仅为兼容旧导入；新代码用 markFactsUsed。
        fields.set(key, Number(value) || 0);
      } else if (key === 'salience') {
        if (!SALIENCE_VALUES.has(value)) {
          throw new TypeError(`[store] invalid salience: ${String(value)}`);
        }
        fields.set(key, value);
      } else if (key === 'strength_days') {
        fields.set(key, value === null || value === undefined ? null : Number(value));
      } else if (textColumns.has(key)) {
        fields.set(key, value ?? null);
      }
    }

    if (fields.has('salience') || fields.has('strength_days')) {
      const salience = fields.get('salience') ?? current.salience;
      const strength = resolveStrengthDays(salience, fields.get('strength_days'));
      fields.set('salience', salience);
      fields.set('strength_days', strength);
    }

    const assignments = [...fields.keys()].map((key) => `${key} = ?`);
    assignments.push('updated_at = unixepoch()');
    this.#db
      .prepare(`UPDATE facts SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...fields.values(), id);
    this.#refreshFactsFts(id);
    this.#syncFactVector(id);
    return this.getFact(id);
  }

  /**
   * 强化一条事实（H5「被用上才强化」）。
   *
   * 单事务内完成：校验 active 且 salience≠pinned → 按遗忘曲线算 R →
   * UPDATE strength_days / last_reinforced_at / recall_count+1 →
   * appendEvent({action:'REINFORCE', table_name:'facts', detail_json:{alpha, from, to}})。
   *
   * 能力约定：缺行 / 墓碑（deleted_at 非空）/ pinned / 非 active 一律返回
   * {ok:false, reason}，不抛；只有参数类型错误才抛 TypeError。
   *
   * @param {{id: string, scope?: string, at?: number|Date, alpha?: number}} input
   * @returns {{ok: boolean, id?: string, strengthDays?: number,
   *            recallCount?: number, alpha?: number, reason?: string}}
   */
  reinforceFact({ id, scope = 'main', at, alpha = DEFAULT_ALPHA } = {}) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('[store] reinforceFact requires a non-empty id');
    }
    let effectiveAlpha = Number(alpha);
    if (!Number.isFinite(effectiveAlpha) || effectiveAlpha < 0) effectiveAlpha = DEFAULT_ALPHA;

    const run = () => {
      const row = this.#db
        .prepare('SELECT * FROM facts WHERE id = ? AND scope = ?')
        .get(id, scope);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.deleted_at !== null && row.deleted_at !== undefined) {
        return { ok: false, reason: 'deleted' };
      }
      if (row.salience === 'pinned') return { ok: false, reason: 'pinned' };
      if (row.status !== 'active') return { ok: false, reason: 'inactive' };

      const from = Number(row.strength_days);
      if (!Number.isFinite(from) || from < 0) {
        return { ok: false, reason: 'invalid_strength' };
      }
      const atSeconds = epochOr(at, nowSeconds());
      const R = decayOf({
        strengthDays: from,
        lastReinforcedAt: row.last_reinforced_at,
        now: atSeconds,
      });
      const to = reinforce({ strengthDays: from, R, alpha: effectiveAlpha });

      this.#db
        .prepare(
          `UPDATE facts
              SET strength_days = ?, last_reinforced_at = ?,
                  recall_count = recall_count + 1, updated_at = unixepoch()
            WHERE id = ? AND scope = ?`,
        )
        .run(to, atSeconds, id, scope);
      this.appendEvent({
        at: atSeconds,
        action: 'REINFORCE',
        table_name: 'facts',
        row_id: id,
        actor: 'consolidator',
        reason: 'used_in_reply',
        detail_json: { alpha: effectiveAlpha, from, to },
      });
      const updated = this.getFact(id);
      return {
        ok: true,
        id,
        strengthDays: Number(updated?.strength_days ?? to),
        recallCount: Number(updated?.recall_count ?? 0),
        alpha: effectiveAlpha,
      };
    };

    // 已经是事务上下文时直接复用，避免嵌套 BEGIN 报错。
    return this.inTransaction ? run() : this.transaction(run);
  }

  /**
   * v15（A8.1）：批量累加「被注入」计数（injected_count / unused_streak）。
   *
   * 单事务批量更新，只作用于 `status='active' AND deleted_at IS NULL` 的行；未知
   * 或非 active 的 id 静默跳过（检索侧可能拿着上一轮快照的 id，不能因为并发删除
   * 让整批失败）。atSeconds 只做类型校验、当前不落库：facts 没有 per-event 注入
   * 时间列，保留参数是为了和 markFactsUsed 的签名对称、后续审计扩展不破坏调用方。
   * @param {string[]} ids
   * @param {number|Date} [atSeconds]
   * @returns {{updated: number}}
   */
  bumpFactInjected(ids, atSeconds) {
    return this.#bumpFactCounters(ids, atSeconds, 'injected');
  }

  /**
   * v15（A8.2）：批量累加「被用上」计数（used_count+1）并清零 unused_streak。
   *
   * 与 bumpFactInjected 同一批量/过滤/跳过语义；`used_count` 是 v15 起的唯一
   * 「用上」计数来源（v14 的 recall_count 只由旧 reinforce 路径继续累加）。
   * @param {string[]} ids
   * @param {number|Date} [atSeconds]
   * @returns {{updated: number}}
   */
  markFactsUsed(ids, atSeconds) {
    return this.#bumpFactCounters(ids, atSeconds, 'used');
  }

  /**
   * @param {string[]} ids
   * @param {number|Date|undefined} atSeconds
   * @param {'injected'|'used'} mode
   * @returns {{updated: number}}
   */
  #bumpFactCounters(ids, atSeconds, mode) {
    const list = normalizeIdList(ids);
    // 参数校验先于空数组短路：非法时间戳不应该因为 ids 为空就被吞掉。
    if (atSeconds !== undefined && atSeconds !== null) toEpoch(atSeconds);
    if (list.length === 0) return { updated: 0 };
    const sql = mode === 'injected'
      ? `UPDATE facts
            SET injected_count = injected_count + 1,
                unused_streak = unused_streak + 1
          WHERE id = ? AND status = 'active' AND deleted_at IS NULL`
      : `UPDATE facts
            SET used_count = used_count + 1,
                unused_streak = 0
          WHERE id = ? AND status = 'active' AND deleted_at IS NULL`;
    return this.#atomic(() => {
      const statement = this.#db.prepare(sql);
      let updated = 0;
      for (const id of list) updated += Number(statement.run(id).changes);
      return { updated };
    });
  }

  /**
   * S1：标记删除（保留行与 FTS 直到 purge）。
   * @param {string} id
   * @param {{now?: number|Date}} [options]
   * @returns {object|null}
   */
  deleteFact(id, options = {}) {
    const at = epochOr(options.now, nowSeconds());
    const info = this.#db
      .prepare('UPDATE facts SET deleted_at = ?, updated_at = unixepoch() WHERE id = ? AND deleted_at IS NULL')
      .run(at, id);
    if (Number(info.changes) > 0) {
      this.#syncFactVector(id);
      return this.getFact(id);
    }
    return null;
  }

  /**
   * S1 显式遗忘事实：仅 active 可转 tombstoned，正文快照写 purge_payload，
   * 行与 FTS 保留到 S2 purge（06 v3.3 §7.8「立即停读 → 7 天冷静期」）。
   * 已 tombstoned 或行不存在返回 false，保持幂等。
   *
   * @param {string} id
   * @param {{at?: number|Date, payload?: unknown}} [options]
   * @returns {boolean} 是否发生状态迁移
   */
  forgetFact(id, options = {}) {
    const at = epochOr(options.at, nowSeconds());
    const payload = JSON.stringify(options.payload ?? {});
    const info = this.#db
      .prepare(
        `UPDATE facts
            SET status = 'tombstoned', deleted_at = ?, purge_payload = ?, updated_at = unixepoch()
          WHERE id = ? AND status = 'active'`,
      )
      .run(at, payload, id);
    if (Number(info.changes) > 0) this.#syncFactVector(id);
    return Number(info.changes) > 0;
  }

  /**
   * @param {{scope?: string, kind?: string, status?: string, subject_text?: string,
   *          includeDeleted?: boolean, limit?: number, offset?: number}} [options]
   * @returns {object[]}
   */
  listFacts(options = {}) {
    const where = [];
    const args = [];
    if (options.scope !== undefined) {
      where.push('scope = ?');
      args.push(options.scope);
    }
    if (options.kind !== undefined) {
      where.push('kind = ?');
      args.push(options.kind);
    }
    if (options.status !== undefined) {
      where.push('status = ?');
      args.push(options.status);
    }
    if (options.subject_text !== undefined) {
      where.push('subject_text = ?');
      args.push(options.subject_text);
    }
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    const limit = clampLimit(options.limit, 50);
    const offset = clampOffset(options.offset);
    const sql = `
      SELECT * FROM facts
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY observed_at DESC, id DESC
      LIMIT ? OFFSET ?`;
    return this.#db.prepare(sql).all(...args, limit, offset);
  }

  // ----------------------------------------------------------- reminders

  /**
   * 写入提醒（不参与遗忘曲线）。
   * @param {object} input
   * @returns {object}
   */
  insertReminder(input = {}) {
    const id = input.id ?? newId('rm');
    this.#db
      .prepare(
        `INSERT INTO reminders (
           id, scope, kind, title, detail, counterparty, due_at, due_granularity, rrule,
           next_fire_at, retry_at, last_fire_key, occurrence_key, status, closed_at,
           source_episode_id, expired_notified_at, series_index, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.scope ?? 'main',
        requireString(input.kind, 'reminders.kind'),
        requireString(input.title, 'reminders.title'),
        input.detail ?? null,
        input.counterparty ?? null,
        epochOr(input.due_at, null),
        input.due_granularity ?? null,
        input.rrule ?? null,
        epochOr(input.next_fire_at, null),
        epochOr(input.retry_at, null),
        input.last_fire_key ?? null,
        input.occurrence_key === undefined || input.occurrence_key === null
          ? null
          : requireString(input.occurrence_key, 'reminders.occurrence_key'),
        input.status ?? 'pending',
        epochOr(input.closed_at, null),
        input.source_episode_id ?? null,
        epochOr(input.expired_notified_at, null),
        input.series_index === undefined || input.series_index === null
          ? 0
          : requireNonNegativeInteger(input.series_index, 'reminders.series_index'),
        epochOr(input.deleted_at, null),
      );
    return this.getReminder(id);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getReminder(id) {
    return this.#db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) ?? null;
  }

  /**
   * 到点提醒：status IN ('pending','snoozed') 且到期时刻 <= now。
   *
   * 到期时刻统一取 `max(next_fire_at, retry_at)`（V8-L2，表达式见
   * {@link REMINDER_DUE_AT_SQL}）：next_fire_at 是原定到点时间，失败退避写在
   * retry_at，两者取较大者——这与 index.js 的 onAttempt 判定（同样用
   * {@link reminderDueAt}）是同一口径。排序也用该表达式，重试项不会因为原定
   * 时间早而抢在别的提醒前面。查询形状与 ix_rm_due 的表达式索引严格对应
   * （V8-L1），EXPLAIN QUERY PLAN 命中 `ix_rm_due`。
   * @param {{now?: number|Date, scope?: string, limit?: number}} [options]
   * @returns {object[]}
   */
  dueReminders(options = {}) {
    const { sql, args } = buildDueRemindersQuery(options);
    return this.#db.prepare(sql).all(...args);
  }

  /**
   * 改期（snooze / 重新排期）：更新原定到点时间并清空一切「上一次到点」的残留。
   *
   * V8-L2：唯一到期口径是 max(next_fire_at, retry_at)，所以改期必须同时清空
   * retry_at，否则旧退避时刻会压过新时间、改期后仍按旧时刻到期。这里一并清掉
   * occurrence_key / last_fire_key / delivery_attempts / closed_at，让改期后的
   * 到点算新的一次 occurrence（新 rpcId、退避预算从 0 开始）。
   *
   * 只对仍在等待投递的行（pending/snoozed、未删除）生效；行不存在或已结束
   * （done/cancelled/expired/fired）时返回 null。这是插件内唯一的改期入口；
   * 其它直接写 next_fire_at 的路径由 trg_reminders_reschedule_clear_retry 兜底
   * 清空 retry_at。
   * @param {string} id
   * @param {{next_fire_at: number|Date, due_at?: number|Date|null,
   *          due_granularity?: string|null, status?: 'pending'|'snoozed'}} options
   * @returns {object|null} 更新后的行；没有可改期的活跃行时 null
   */
  rescheduleReminder(id, options = {}) {
    const reminderId = requireString(id, 'reminders.id');
    if (options.next_fire_at === null || options.next_fire_at === undefined) {
      throw new TypeError('[store] rescheduleReminder requires next_fire_at');
    }
    const nextFireAt = toEpoch(options.next_fire_at);
    const dueAt = epochOr(options.due_at, null);
    const dueGranularity = options.due_granularity ?? null;
    const status = options.status === undefined
      ? null
      : requireString(options.status, 'reminders.status');
    if (status !== null && status !== 'pending' && status !== 'snoozed') {
      throw new TypeError('[store] rescheduleReminder status must be pending or snoozed');
    }
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET next_fire_at = ?,
                due_at = COALESCE(?, due_at),
                due_granularity = COALESCE(?, due_granularity),
                status = COALESCE(?, status),
                retry_at = NULL,
                occurrence_key = NULL,
                last_fire_key = NULL,
                delivery_attempts = 0,
                closed_at = NULL,
                updated_at = unixepoch()
          WHERE id = ?
            AND deleted_at IS NULL
            AND status IN ('pending','snoozed')`,
      )
      .run(nextFireAt, dueAt, dueGranularity, status, reminderId);
    if (Number(info.changes) === 0) return null;
    return this.getReminder(reminderId);
  }

  /**
   * v15（A5）：把一条提醒推进到下一次 occurrence（重复提醒/系列提醒用）。
   *
   * 与 rescheduleReminder 的区别：这是「本次已经走完、进入系列下一集」，所以
   * 无条件把状态拉回 pending 并清空投递现场（attempts/retry_at/closed_at），
   * 同时写入新的 next_fire_at / occurrence_key / series_index。只对未删除的行
   * 生效；行不存在（或已物理删除）返回 `{ok:false}`，不抛错。
   *
   * @param {string} id
   * @param {{nextFireAt?: number|Date, at?: number|Date, occurrenceKey?: string,
   *          seriesIndex?: number}} options `at` 是 nextFireAt 的兼容别名；
   *          occurrenceKey 缺省时按 `nextFireAt-occ_xxx` 生成
   * @returns {{ok: boolean}}
   */
  advanceReminderOccurrence(id, options = {}) {
    const reminderId = requireString(id, 'reminders.id');
    const nextFireRaw = options.nextFireAt ?? options.at;
    if (nextFireRaw === null || nextFireRaw === undefined) {
      throw new TypeError('[store] advanceReminderOccurrence requires nextFireAt');
    }
    const nextFireAt = toEpoch(nextFireRaw);
    const occurrenceKey = options.occurrenceKey === undefined || options.occurrenceKey === null
      ? `${nextFireAt}-${newId('occ')}`
      : requireString(options.occurrenceKey, 'reminders.occurrence_key');
    const seriesIndex = options.seriesIndex === undefined || options.seriesIndex === null
      ? 0
      : requireNonNegativeInteger(options.seriesIndex, 'reminders.series_index');
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET next_fire_at = ?,
                occurrence_key = ?,
                series_index = ?,
                status = 'pending',
                delivery_attempts = 0,
                retry_at = NULL,
                closed_at = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(nextFireAt, occurrenceKey, seriesIndex, reminderId);
    return { ok: Number(info.changes) > 0 };
  }

  /**
   * V6-M1：取（或惰性创建）本次到点的 occurrence key。
   *
   * requestId 必须按「occurrence」稳定：同一次到点因失败退避写入 `retry_at`
   * 之后，重试仍复用同一个 key（宿主按 rpcId 去重）；投递成功或置 `expired` 时
   * 清空，下一次到点再生成新 key。只有真正到了入队时刻才写库，插入提醒本身不
   * 产生 key。
   *
   * 只对 `pending`/`snoozed` 且未删除的行生效；行不存在、已 fired/done/cancelled
   * 时返回 null，调用方据此跳过入队。
   *
   * @param {string} id
   * @param {number|Date} [now] 本次到点时间（Unix 秒），用于生成可读的 key
   * @returns {string|null} 活跃提醒的 occurrence_key
   */
  ensureReminderOccurrence(id, now) {
    const reminderId = requireString(id, 'reminders.id');
    const at = epochOr(now, nowSeconds());
    // key 带「本次到点秒」便于排查，再拼唯一后缀保证同秒多次到点也不撞。
    const key = `${at}-${newId('occ')}`;
    this.#db
      .prepare(
        `UPDATE reminders
            SET occurrence_key = COALESCE(occurrence_key, ?),
                updated_at = unixepoch()
          WHERE id = ?
            AND status IN ('pending','snoozed')
            AND deleted_at IS NULL`,
      )
      .run(key, reminderId);
    const row = this.#db
      .prepare('SELECT occurrence_key, status, deleted_at FROM reminders WHERE id = ?')
      .get(reminderId);
    if (row === undefined || row === null) return null;
    if (row.status !== 'pending' && row.status !== 'snoozed') return null;
    if (row.deleted_at !== null && row.deleted_at !== undefined) return null;
    if (row.occurrence_key === null || row.occurrence_key === undefined) return null;
    return String(row.occurrence_key);
  }

  /**
   * 两阶段投递第一步：把到点提醒占位为 `delivering` 并记下本次 fire key。
   *
   * 只有 pending/snoozed 且未超重试上限的行能占位成功；占位成功返回 true，
   * 调用方随后才真正调用 platform.prompt。delivery_attempts 按「不同 fireKey」
   * 计数：同一 tick 内 reminders 与 idle-probe 两次 flush 对同一条提醒重试不会
   * 重复消耗预算。失败回 pending 时保留 last_fire_key 供下次重试。
   *
   * V5-L2：fireKey 由调用方按「发生时刻 + 本次重试时刻」构造（例如
   * `<next_fire_at>@<retry_at>`）。next_fire_at 在退避期间不再变化，因此只用它
   * 会让每次重试看上去都是同一次尝试；把本次的 retry_at（或当前 tick）拼进去，
   * 每次真正重试才累加 attempts，同一 tick 的重复 flush 仍不重复计数。
   *
   * @param {string} id
   * @param {string} fireKey 调用方构造的「发生时刻 + 本次重试时刻」
   * @param {number} [maxAttempts]
   * @returns {boolean} 是否占位成功
   */
  claimReminderDelivery(id, fireKey, maxAttempts = REMINDER_MAX_DELIVERY_ATTEMPTS) {
    const key = requireString(fireKey, 'reminders.last_fire_key');
    const max = Number.isInteger(maxAttempts) && maxAttempts > 0
      ? maxAttempts
      : REMINDER_MAX_DELIVERY_ATTEMPTS;
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'delivering',
                last_fire_key = ?,
                delivery_attempts = delivery_attempts
                  + (CASE WHEN last_fire_key IS ? THEN 0 ELSE 1 END),
                updated_at = unixepoch()
          WHERE id = ?
            AND status IN ('pending','snoozed')
            AND deleted_at IS NULL
            AND delivery_attempts < ?`,
      )
      .run(key, key, requireString(id, 'reminders.id'), max);
    return Number(info.changes) > 0;
  }

  /**
   * 两阶段投递第二步（成功）：delivering → fired。
   *
   * V6-M1：一次到点结束，清空 occurrence_key/last_fire_key 并把 attempts 归零，
   * 下一次到点重新生成 occurrence（新 rpcId），也不会继承上一次的失败计数。
   * V5-L2：同时清空 retry_at，成功后不再残留退避时刻。
   * @param {string} id
   * @returns {boolean}
   */
  markReminderDelivered(id) {
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'fired',
                occurrence_key = NULL,
                last_fire_key = NULL,
                retry_at = NULL,
                delivery_attempts = 0,
                updated_at = unixepoch()
          WHERE id = ? AND status = 'delivering'`,
      )
      .run(requireString(id, 'reminders.id'));
    return Number(info.changes) > 0;
  }

  /**
   * 两阶段投递第二步（失败）：delivering → pending，并写入退避时刻 `retry_at`。
   *
   * V5-L2：`next_fire_at` 是原定到点时间，失败退避不得覆盖它；退避只写
   * `retry_at`，调度按 max(next_fire_at, retry_at) 到期。成功后 retry_at
   * 清空，展示侧仍用原定时间。
   *
   * - 保留 `last_fire_key`：同一 occurrence 的重复 claim 不重复计数；
   * - 按 `delivery_attempts` 取退避 30s → 60s → 120s（见
   *   `REMINDER_RETRY_BACKOFF_SECONDS`），避免失败后每个 tick（30s）立刻重试、
   *   约 3 个 tick 就把 attempts 耗尽置 `expired`；
   * - attempts 已达上限：直接置 `expired` 并清空 retry_at，不再无限重试。
   *
   * 只对 `delivering` 行生效；对尚未 claim 的 `pending` 行是空操作（返回 false），
   * 因此调用方可以对「本轮没轮到投递」的条目无脑回调 onFailed 而不会改动它们。
   * 读-改-写之间用 `delivery_attempts = ?` 做乐观校验，避免覆盖并发改动。
   *
   * @param {string} id
   * @param {{now?: number|Date}} [options] now 为退避起点的 Unix 秒（缺省当前时间）
   * @returns {boolean} 是否真的释放（或置过期）了一行
   */
  markReminderDeliveryFailed(id, options = {}) {
    const reminderId = requireString(id, 'reminders.id');
    const row = this.getReminder(reminderId);
    if (row === null || row.status !== 'delivering') return false;
    const attempts = Number(row.delivery_attempts ?? 0);
    if (attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS) {
      // V6-M1：本次 occurrence 彻底失败，清掉 occurrence/last_fire_key 并把
      // 计数归零，与成功投递的「一次 occurrence 结束」语义保持一致。
      // V5-L2：结束态不残留 retry_at。
      const expired = this.#db
        .prepare(
          `UPDATE reminders
              SET status = 'expired',
                  occurrence_key = NULL,
                  last_fire_key = NULL,
                  retry_at = NULL,
                  delivery_attempts = 0,
                  updated_at = unixepoch()
            WHERE id = ? AND status = 'delivering' AND delivery_attempts = ?`,
        )
        .run(reminderId, attempts);
      return Number(expired.changes) > 0;
    }
    const now = epochOr(options.now, nowSeconds());
    const backoffIndex = Math.min(
      Math.max(attempts - 1, 0),
      REMINDER_RETRY_BACKOFF_SECONDS.length - 1,
    );
    const retryAt = now + REMINDER_RETRY_BACKOFF_SECONDS[backoffIndex];
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'pending',
                retry_at = ?,
                updated_at = unixepoch()
          WHERE id = ? AND status = 'delivering' AND delivery_attempts = ?`,
      )
      .run(retryAt, reminderId, attempts);
    return Number(info.changes) > 0;
  }

  /**
   * 启动回收：把上次进程崩溃时留下的 `delivering` 行收回 pending。
   *
   * 未超上限的回到 pending 等待重试；已达上限的直接 expired，避免死循环。
   * 幂等，可在每次启动时无条件调用。
   *
   * @param {number} [maxAttempts]
   * @returns {{recovered: number, expired: number}}
   */
  recoverReminderDeliveries(maxAttempts = REMINDER_MAX_DELIVERY_ATTEMPTS) {
    const max = Number.isInteger(maxAttempts) && maxAttempts > 0
      ? maxAttempts
      : REMINDER_MAX_DELIVERY_ATTEMPTS;
    const recovered = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'pending', updated_at = unixepoch()
          WHERE status = 'delivering' AND delivery_attempts < ?`,
      )
      .run(max);
    const expired = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'expired',
                occurrence_key = NULL,
                last_fire_key = NULL,
                retry_at = NULL,
                delivery_attempts = 0,
                updated_at = unixepoch()
          WHERE status = 'delivering' AND delivery_attempts >= ?`,
      )
      .run(max);
    return {
      recovered: Number(recovered.changes) || 0,
      expired: Number(expired.changes) || 0,
    };
  }

  /**
   * 重试次数用尽：提醒置 expired（不再投递）。
   *
   * V6-M1：同样结束本次 occurrence——清空 occurrence_key/last_fire_key 并把
   * attempts 归零，避免同一条提醒将来重新启用时继承旧计数/rpcId。
   * V5-L2：同时清空 retry_at，结束态不残留退避时刻。
   * @param {string} id
   * @returns {boolean}
   */
  expireReminder(id) {
    const info = this.#db
      .prepare(
        `UPDATE reminders
            SET status = 'expired',
                occurrence_key = NULL,
                last_fire_key = NULL,
                retry_at = NULL,
                delivery_attempts = 0,
                updated_at = unixepoch()
          WHERE id = ? AND status IN ('pending','snoozed','delivering')
            AND deleted_at IS NULL`,
      )
      .run(requireString(id, 'reminders.id'));
    return Number(info.changes) > 0;
  }

  /**
   * @param {{scope?: string, status?: string, includeDeleted?: boolean,
   *          limit?: number, offset?: number}} [options]
   * @returns {object[]}
   */
  listReminders(options = {}) {
    const where = [];
    const args = [];
    if (options.scope !== undefined) {
      where.push('scope = ?');
      args.push(options.scope);
    }
    if (options.status !== undefined) {
      where.push('status = ?');
      args.push(options.status);
    }
    if (!options.includeDeleted) where.push('deleted_at IS NULL');
    const limit = clampLimit(options.limit, 100);
    const offset = clampOffset(options.offset);
    return this.#db
      .prepare(
        `SELECT * FROM reminders
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY (due_at IS NULL) ASC, due_at ASC, id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
  }

  /**
   * v15（A4）：列出某 scope 下「已过期但还没通知过」的提醒。
   *
   * 只返回投递侧需要的最小字段；按 due_at 升序（NULL 排最后——理论上 expired
   * 行都有 due_at，这里只是防御），同一时刻按 id 稳定排序。已软删的行不返回。
   * @param {string} scope
   * @returns {{id: string, title: string, due_at: number|null, kind: string,
   *            rrule: string|null}[]}
   */
  listUnnotifiedExpired(scope) {
    const scopeKey = requireString(scope, 'reminders.scope');
    return this.#db
      .prepare(
        `SELECT id, title, due_at, kind, rrule
           FROM reminders
          WHERE scope = ?
            AND status = 'expired'
            AND expired_notified_at IS NULL
            AND deleted_at IS NULL
          ORDER BY (due_at IS NULL) ASC, due_at ASC, id ASC`,
      )
      .all(scopeKey);
  }

  /**
   * v15（A4）：批量标记过期提醒已通知（写 expired_notified_at）。
   *
   * 只命中仍处于 expired 且尚未标记的行，重复调用幂等；未知/已标记的 id 跳过。
   * @param {string[]} ids
   * @param {number|Date} [atSeconds] 缺省取当前秒
   * @returns {{updated: number}}
   */
  markExpiredNotified(ids, atSeconds) {
    const list = normalizeIdList(ids);
    const at = epochOr(atSeconds, nowSeconds());
    if (list.length === 0) return { updated: 0 };
    return this.#atomic(() => {
      const statement = this.#db.prepare(
        `UPDATE reminders
            SET expired_notified_at = ?
          WHERE id = ?
            AND status = 'expired'
            AND expired_notified_at IS NULL`,
      );
      let updated = 0;
      for (const id of list) updated += Number(statement.run(at, id).changes);
      return { updated };
    });
  }

  /**
   * S1 显式遗忘提醒。
   *
   * reminders 表没有 `tombstoned` 状态，也没有 `purge_payload` 列（06 v3.3 §7.7
   * 提醒不参与自然遗忘，无需冷静期正文快照）；purge() 也只扫 facts/episodes。
   * 因此显式遗忘按「立即停读」直接物理删除该行，重复调用或行不存在返回 false。
   *
   * @param {string} id
   * @param {object} [options] 预留（提醒无冷静期，at/payload 无落点）
   * @returns {boolean} 是否删除了行
   */
  forgetReminder(id, options = {}) {
    // 提醒无冷静期（06 §7.7）：options.at/payload 无落点，保留签名以免调用方分叉。
    void options;
    const info = this.#db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    return Number(info.changes) > 0;
  }

  // ---------------------------------------------------------- state board

  /** @param {string} scope */
  #ensureScopeRow(scope) {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO state_board_rev (scope, revision, rendered, updated_at)
         VALUES (?, 0, '', ?)`,
      )
      .run(scope, nowSeconds());
  }

  /**
   * 读取已发布的状态板渲染文本（system 段正在用的版本）。
   * t6 装配直接把它当 boardText 用；线程首次访问返回 ''。
   * @param {string} [scope]
   * @returns {string}
   */
  getBoard(scope = 'main') {
    const row = this.getBoardState(scope);
    return row ? row.rendered : '';
  }

  /**
   * 读取状态板版本行（含 staged_*），便于发布/诊断。
   * @param {string} [scope]
   * @returns {object|null}
   */
  getBoardState(scope = 'main') {
    if (typeof scope !== 'string' || scope === '') {
      throw new TypeError('[store] scope must be a non-empty string');
    }
    this.#ensureScopeRow(scope);
    return this.#db.prepare('SELECT * FROM state_board_rev WHERE scope = ?').get(scope) ?? null;
  }

  /**
   * 暂存渲染：staged_revision 恒等于当前 revision + 1（反复覆盖不变）。
   * 只写 staged_*，不动 rendered；真正翻进 system 要等 publishBoard。
   * @param {string} scope
   * @param {string} rendered
   * @param {{now?: number|Date}} [options]
   * @returns {object} 更新后的版本行
   */
  setStagedBoard(scope, rendered, options = {}) {
    if (typeof rendered !== 'string') {
      throw new TypeError('[store] rendered must be a string');
    }
    const at = epochOr(options.now, nowSeconds());
    this.getBoardState(scope); // 确保占位行存在
    this.#db
      .prepare(
        `UPDATE state_board_rev
            SET staged_revision = revision + 1,
                staged_rendered = ?,
                staged_at = ?,
                updated_at = ?
          WHERE scope = ?`,
      )
      .run(rendered, at, at, scope);
    return this.getBoardState(scope);
  }

  /**
   * 发布 staged → rendered。调用方须先经 state-board.js 的
   * PUBLISH_REASONS 白名单判定（compact/restart/thread-unarchive/
   * persona-edit/forget）。
   * @param {string} [scope]
   * @returns {number|null} 新 revision；无 staged 时返回 null
   */
  publishBoard(scope = 'main') {
    this.#ensureScopeRow(scope);
    const info = this.#db
      .prepare(
        `UPDATE state_board_rev
            SET revision = staged_revision,
                rendered = staged_rendered,
                staged_revision = NULL,
                staged_rendered = NULL,
                staged_at = NULL,
                updated_at = ?
          WHERE scope = ? AND staged_revision IS NOT NULL`,
      )
      .run(nowSeconds(), scope);
    if (info.changes === 0) return null;
    return this.getBoardState(scope).revision;
  }

  /**
   * 遗忘后清洗状态板（H4）：删除引用被遗忘 episode 的行，并从
   * rendered / staged_rendered 文本中移除包含被遗忘正文的渲染行。
   * 若行级定位不到任何残留，则按当前 active 记忆重新渲染并写 staged
   * （renderBoard 的 5 区块/预算口径保持不变）。
   * @param {{scope?: string, ids?: string[], now?: number|Date,
   *          rerender?: boolean}} [options]
   * @returns {{scope: string, removedRows: number, located: boolean,
   *            rerendered: boolean, rendered: string, staged: string|null,
   *            fragments: number}}
   */
  scrubStateBoard(options = {}) {
    const scope = options.scope ?? 'main';
    if (typeof scope !== 'string' || scope === '') {
      throw new TypeError('[store] scrubStateBoard scope must be a non-empty string');
    }
    const ids = normalizeIdList(options.ids);
    const at = epochOr(options.now, nowSeconds());
    return this.#atomic(() => {
      const fragments = boardFragments(this, ids);
      let removedRows = 0;
      for (const row of this.listBoardLines(scope)) {
        const referenced =
          row.ref_episode_id !== null &&
          row.ref_episode_id !== undefined &&
          ids.includes(row.ref_episode_id);
        const residual = scrubBoardText(row.line, fragments) !== row.line;
        if (!referenced && !residual) continue;
        if (this.deleteBoardLine(row.id)) removedRows += 1;
      }

      const state = this.getBoardState(scope);
      const rendered = scrubBoardText(state.rendered, fragments);
      let staged =
        state.staged_rendered === null ? null : scrubBoardText(state.staged_rendered, fragments);
      let located =
        removedRows > 0 || rendered !== state.rendered || staged !== state.staged_rendered;
      let rerendered = false;
      if (!located && options.rerender !== false) {
        staged = scrubBoardText(this.#renderBoardText(scope), fragments);
        rerendered = true;
      }
      if (rendered !== state.rendered || (staged ?? null) !== (state.staged_rendered ?? null)) {
        this.#db
          .prepare(
            `UPDATE state_board_rev
                SET rendered = ?, staged_rendered = ?, updated_at = ?
              WHERE scope = ?`,
          )
          .run(rendered, staged, at, scope);
      }
      return {
        scope,
        removedRows,
        located,
        rerendered,
        rendered,
        staged,
        fragments: fragments.length,
      };
    });
  }

  /** 按当前 active 记忆重新渲染状态板（遗忘清洗兜底）。 */
  #renderBoardText(scope) {
    return renderBoard({
      recent: this.listEpisodes({ scope, limit: 6 }),
      facts: this.listFacts({ scope, status: 'active', limit: 10 }),
      threads: this.listThreads({ status: 'active', limit: 10 }),
      reminders: this.listReminders({ scope, limit: 12 }),
    });
  }

  /**
   * 列状态板行（供 t6 装配读取原始行；渲染文本请用 getBoard）。
   * @param {string} scope
   * @param {{section?: string}} [options]
   * @returns {object[]}
   */
  listBoardLines(scope = 'main', options = {}) {
    const where = ['scope = ?'];
    const args = [scope];
    if (options.section !== undefined) {
      where.push('section = ?');
      args.push(options.section);
    }
    return this.#db
      .prepare(
        `SELECT * FROM state_board WHERE ${where.join(' AND ')}
          ORDER BY section ASC, last_mentioned_at DESC, created_at ASC`,
      )
      .all(...args);
  }

  /**
   * 整块替换某 scope 的状态板行（巩固在事务内调用）。
   * @param {string} scope
   * @param {object[]} lines
   * @param {{now?: number|Date}} [options]
   * @returns {number} 写入行数
   */
  replaceBoardLines(scope, lines = [], options = {}) {
    if (!Array.isArray(lines)) throw new TypeError('[store] lines must be an array');
    const at = epochOr(options.now, nowSeconds());
    return this.#atomic(() => {
      this.#db.prepare('DELETE FROM state_board WHERE scope = ?').run(scope);
      for (const line of lines) {
        // scope 由参数强制，避免行数据里的同名字段把行写到别的 scope。
        this.upsertBoardLine({
          ...line,
          scope,
          last_mentioned_at: line.last_mentioned_at ?? at,
        });
      }
      return lines.length;
    });
  }

  /**
   * 插入或更新一行状态板。
   * @param {object} input
   * @returns {object}
   */
  upsertBoardLine(input = {}) {
    const section = requireString(input.section, 'state_board.section');
    if (!BOARD_SECTIONS.has(section)) {
      throw new TypeError(`[store] invalid state_board.section: ${section}`);
    }
    const id = input.id ?? newId('sb');
    this.#db
      .prepare(
        `INSERT INTO state_board (
           id, scope, section, line, ref_episode_id, ref_thread_key, last_mentioned_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           section = excluded.section,
           line = excluded.line,
           ref_episode_id = excluded.ref_episode_id,
           ref_thread_key = excluded.ref_thread_key,
           last_mentioned_at = excluded.last_mentioned_at,
           updated_at = unixepoch()`,
      )
      .run(
        id,
        requireString(input.scope ?? 'main', 'state_board.scope'),
        section,
        requireString(input.line, 'state_board.line'),
        input.ref_episode_id ?? null,
        input.ref_thread_key ?? null,
        epochOr(input.last_mentioned_at, nowSeconds()),
      );
    return this.#db.prepare('SELECT * FROM state_board WHERE id = ?').get(id);
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  deleteBoardLine(id) {
    const info = this.#db.prepare('DELETE FROM state_board WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ------------------------------------------------------------- threads

  /**
   * 插入/更新线程目录行。
   * @param {object} input
   * @returns {object}
   */
  upsertThread(input = {}) {
    const key = requireString(input.key, 'threads.key');
    const status = input.status ?? 'active';
    if (!THREAD_STATUSES.has(status)) {
      throw new TypeError(`[store] invalid threads.status: ${status}`);
    }
    this.#db
      .prepare(
        `INSERT INTO threads (key, name, session_id, description, last_progress, last_active_at, status)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           name = excluded.name,
           session_id = excluded.session_id,
           description = excluded.description,
           last_progress = excluded.last_progress,
           last_active_at = excluded.last_active_at,
           status = excluded.status`,
      )
      .run(
        key,
        requireString(input.name, 'threads.name'),
        requireString(input.session_id, 'threads.session_id'),
        requireString(input.description, 'threads.description'),
        input.last_progress ?? null,
        epochOr(input.last_active_at, nowSeconds()),
        status,
      );
    return this.getThread(key);
  }

  /**
   * @param {string} key
   * @returns {object|null}
   */
  getThread(key) {
    return this.#db.prepare('SELECT * FROM threads WHERE key = ?').get(key) ?? null;
  }

  /**
   * H3：按平台 session id 反查线程目录行（用于 pre-step 路由）。
   * @param {string} sessionId
   * @returns {object|null}
   */
  getThreadBySessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return this.#db.prepare('SELECT * FROM threads WHERE session_id = ?').get(sessionId) ?? null;
  }

  /**
   * @param {{status?: string, limit?: number}} [options]
   * @returns {object[]}
   */
  listThreads(options = {}) {
    const where = [];
    const args = [];
    if (options.status !== undefined) {
      where.push('status = ?');
      args.push(options.status);
    }
    const limit = clampLimit(options.limit, 100);
    return this.#db
      .prepare(
        `SELECT * FROM threads
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY last_active_at DESC, key ASC LIMIT ?`,
      )
      .all(...args, limit);
  }

  /**
   * 冻结/归档线程（06 v3.3 用 archived；retired 表示不再启用）。
   * @param {string} key
   * @param {{status?: 'archived'|'retired'}} [options]
   * @returns {object|null}
   */
  freezeThread(key, options = {}) {
    const status = options.status ?? 'archived';
    if (!THREAD_STATUSES.has(status)) {
      throw new TypeError(`[store] invalid threads.status: ${status}`);
    }
    const info = this.#db.prepare('UPDATE threads SET status = ? WHERE key = ?').run(status, key);
    return info.changes > 0 ? this.getThread(key) : null;
  }

  // ------------------------------------------------------ consolidations

  /**
   * 登记一次巩固（upto_seq 为水位：本段最后一条被巩固的 seq）。
   * @param {object} input
   * @returns {object}
   */
  insertConsolidation(input = {}) {
    const status = input.status ?? 'running';
    if (!CONSOLIDATION_STATUSES.has(status)) {
      throw new TypeError(`[store] invalid consolidations.status: ${status}`);
    }
    const id = input.id ?? newId('cs');
    const scope = requireString(input.scope, 'consolidations.scope');
    const kind = requireString(input.kind, 'consolidations.kind');
    const uptoSeq = Number(input.upto_seq);
    const turnFrom = input.turn_from ?? null;
    const compactionStartSeq = input.compaction_start_seq ?? turnFrom ?? null;
    // t17：重试失败巩固时，同一 (scope, upto_seq, kind) 的唯一键已存在一行 failed。
    // 就地复用它（改为本次的 running/written/failed），既不新增重复行，也不改 DDL；
    // 非 failed 行（written/compacted）仍按唯一约束抛错，避免静默覆盖已成功区间。
    const existing = this.#db
      .prepare('SELECT id, status FROM consolidations WHERE scope = ? AND upto_seq = ? AND kind = ?')
      .get(scope, uptoSeq, kind);
    if (existing && existing.status === 'failed') {
      this.#db
        .prepare(
          `UPDATE consolidations
              SET session_id = ?, trigger = ?, turn_from = ?, turn_to = ?,
                  tokens_in = ?, tokens_out = ?, status = ?, error = ?,
                  started_at = ?, finished_at = ?, compaction_start_seq = ?
            WHERE id = ?`,
        )
        .run(
          requireString(input.session_id, 'consolidations.session_id'),
          requireString(input.trigger, 'consolidations.trigger'),
          turnFrom,
          input.turn_to ?? null,
          input.tokens_in ?? null,
          input.tokens_out ?? null,
          status,
          input.error ?? null,
          epochOr(input.started_at, nowSeconds()),
          epochOr(input.finished_at, null),
          compactionStartSeq,
          existing.id,
        );
      return this.getConsolidation(existing.id);
    }
    this.#db
      .prepare(
        `INSERT INTO consolidations (
           id, scope, session_id, kind, trigger, upto_seq, turn_from, turn_to,
           tokens_in, tokens_out, status, error, started_at, finished_at,
           compaction_start_seq
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        scope,
        requireString(input.session_id, 'consolidations.session_id'),
        kind,
        requireString(input.trigger, 'consolidations.trigger'),
        uptoSeq,
        turnFrom,
        input.turn_to ?? null,
        input.tokens_in ?? null,
        input.tokens_out ?? null,
        status,
        input.error ?? null,
        epochOr(input.started_at, nowSeconds()),
        epochOr(input.finished_at, null),
        compactionStartSeq,
      );
    return this.getConsolidation(id);
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getConsolidation(id) {
    return this.#db.prepare('SELECT * FROM consolidations WHERE id = ?').get(id) ?? null;
  }

  /**
   * 巩固水位：最近一次成功巩固的 **surface seq**。
   *
   * 取「最新一条」而不是 MAX(upto_seq)：压缩会把区间替换成一个追加在日志末尾的
   * 节点，可见 seq 可能非单调（catalog:627-632），MAX 会跳过刚写入的较低水位。
   * forget_flush 是定向巩固，不代表整段推进，不参与水位。
   * @param {string} scope
   * @returns {number} 无水印时 0
   */
  getWatermark(scope) {
    requireString(scope, 'getWatermark(scope)');
    const row = this.#db
      .prepare(
        `SELECT upto_seq AS watermark FROM consolidations
          WHERE scope = ? AND status IN ('written','compacted') AND kind <> 'forget_flush'
          ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(scope);
    return row && row.watermark !== null ? Number(row.watermark) : 0;
  }

  /**
   * 压缩后用新 seq 空间重写水位（H1：替换节点 seq 最大，旧的数值水位已失效）。
   * @param {string} id 巩固行 id
   * @param {{uptoSeq: number}} [options]
   * @returns {object|null}
   */
  retargetConsolidation(id, options = {}) {
    const seq = Number(options.uptoSeq);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError('[store] retargetConsolidation(uptoSeq) must be a non-negative integer');
    }
    const current = this.getConsolidation(id);
    if (!current) return null;
    this.#db.prepare('UPDATE consolidations SET upto_seq = ? WHERE id = ?').run(seq, id);
    return this.getConsolidation(id);
  }

  /**
   * 标记巩固结果（written/compacted/failed），并写 finished_at。
   * @param {string} id
   * @param {{status?: string, tokensIn?: number, tokensOut?: number,
   *          finishedAt?: number|Date, error?: string|null}} [options]
   * @returns {object|null}
   */
  markConsolidated(id, options = {}) {
    const current = this.getConsolidation(id);
    if (!current) return null;
    const status = options.status ?? 'written';
    if (!CONSOLIDATION_STATUSES.has(status)) {
      throw new TypeError(`[store] invalid consolidations.status: ${status}`);
    }
    const finishedAt =
      options.finishedAt !== undefined
        ? epochOr(options.finishedAt, nowSeconds())
        : status === 'running'
          ? current.finished_at
          : nowSeconds();
    this.#db
      .prepare(
        `UPDATE consolidations
            SET status = ?, tokens_in = ?, tokens_out = ?, error = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run(
        status,
        options.tokensIn ?? current.tokens_in,
        options.tokensOut ?? current.tokens_out,
        // t17：重试成功后要能用 error:null 清掉上一次的失败原因。
        options.error !== undefined ? options.error : current.error,
        finishedAt,
        id,
      );
    return this.getConsolidation(id);
  }

  // ----------------------------------------------------------- token usage

  /**
   * v15（A1）：写入一条 token 用量账本。
   *
   * `day_key` 由调用方按配置时区算好（store 不碰时区），`at` 是毫秒时间戳；
   * 三个计数都是非负整数，`cacheHit` 是 input 的子集、只做统计展示，不参与
   * `total`（见 {@link aggregateTokenUsage}）。`peak` 预留给 v0.4.14 错峰计费，
   * 现在只做枚举校验。
   * @param {{at?: number, dayKey: string, source: string, scope?: string|null,
   *          input?: number, output?: number, cacheHit?: number,
   *          peak?: 'peak'|'offpeak'|null, requestId?: string|null}} input
   * @returns {{id: number}}
   */
  recordTokenUsage(input = {}) {
    const at = input.at === undefined || input.at === null
      ? Date.now()
      : requireNonNegativeInteger(input.at, 'token_usage.at');
    const dayKey = requireString(input.dayKey, 'token_usage.day_key');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      throw new TypeError('[store] token_usage.day_key must be YYYY-MM-DD');
    }
    const source = requireString(input.source, 'token_usage.source');
    if (!TOKEN_USAGE_SOURCE_SET.has(source)) {
      throw new TypeError(`[store] invalid token_usage.source: ${source}`);
    }
    const scope = input.scope === undefined || input.scope === null
      ? null
      : requireString(input.scope, 'token_usage.scope');
    const inputTokens = input.input === undefined || input.input === null
      ? 0
      : requireNonNegativeInteger(input.input, 'token_usage.input');
    const outputTokens = input.output === undefined || input.output === null
      ? 0
      : requireNonNegativeInteger(input.output, 'token_usage.output');
    const cacheHitTokens = input.cacheHit === undefined || input.cacheHit === null
      ? 0
      : requireNonNegativeInteger(input.cacheHit, 'token_usage.cacheHit');
    const peak = input.peak === undefined ? null : input.peak;
    if (peak !== null && !TOKEN_PEAK_SET.has(peak)) {
      throw new TypeError(`[store] invalid token_usage.peak: ${String(peak)}`);
    }
    const requestId = input.requestId === undefined || input.requestId === null
      ? null
      : requireString(input.requestId, 'token_usage.request_id');
    const info = this.#db
      .prepare(
        `INSERT INTO token_usage (
           at, day_key, source, scope, input_tokens, output_tokens,
           cache_hit_tokens, peak, request_id
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(at, dayKey, source, scope, inputTokens, outputTokens, cacheHitTokens, peak, requestId);
    return { id: Number(info.lastInsertRowid) };
  }

  /**
   * v15（A1）：按天聚合 token 用量。
   *
   * `total.total = input + output`（cacheHit 是 input 的子集，不重复计入）；
   * 每个 source 的 `share = 该 source 的 total / 当日 total`，保留 4 位小数。
   * 无数据时返回 `total.total === 0` 且 `bySource: []`；有行但全为 0 时
   * `share` 取 0（不做 0/0）。排序按 total 降序，同额按 source 升序保证稳定。
   * @param {string} dayKey 本地日键 YYYY-MM-DD
   * @returns {{dayKey: string, total: {input: number, output: number,
   *            cacheHit: number, total: number},
   *            bySource: {source: string, input: number, output: number,
   *                       cacheHit: number, total: number, share: number}[]}}
   */
  aggregateTokenUsage(dayKey) {
    const key = requireString(dayKey, 'token_usage.day_key');
    const rows = this.#db
      .prepare(
        `SELECT source,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit
           FROM token_usage
          WHERE day_key = ?
          GROUP BY source`,
      )
      .all(key);
    const total = { input: 0, output: 0, cacheHit: 0, total: 0 };
    const bySource = [];
    for (const row of rows) {
      const inputTokens = Number(row.input);
      const outputTokens = Number(row.output);
      const cacheHit = Number(row.cache_hit);
      const sourceTotal = inputTokens + outputTokens;
      total.input += inputTokens;
      total.output += outputTokens;
      total.cacheHit += cacheHit;
      total.total += sourceTotal;
      bySource.push({
        source: String(row.source),
        input: inputTokens,
        output: outputTokens,
        cacheHit,
        total: sourceTotal,
        share: 0,
      });
    }
    for (const entry of bySource) {
      entry.share = total.total === 0 ? 0 : Math.round((entry.total / total.total) * 10000) / 10000;
    }
    bySource.sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
    return { dayKey: key, total, bySource };
  }

  /**
   * v15（A1）：统计 `at >= atMs` 的窗口用量（5 小时滑窗用）。
   * @param {number} atMs 毫秒时间戳（含）
   * @returns {{input: number, output: number, cacheHit: number, total: number}}
   */
  sumTokenUsageSince(atMs) {
    const since = requireNonNegativeInteger(atMs, 'token_usage.since');
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit
           FROM token_usage
          WHERE at >= ?`,
      )
      .get(since);
    const inputTokens = Number(row.input);
    const outputTokens = Number(row.output);
    return {
      input: inputTokens,
      output: outputTokens,
      cacheHit: Number(row.cache_hit),
      total: inputTokens + outputTokens,
    };
  }

  // -------------------------------------------------------- memory events

  /**
   * 追加审计事件（memory_events 由触发器保证 append-only）。
   * @param {object} input
   * @returns {number} 事件 id
   */
  appendEvent(input = {}) {
    const action = requireString(input.action, 'memory_events.action');
    if (!EVENT_ACTIONS.has(action)) {
      throw new TypeError(`[store] invalid memory_events.action: ${action}`);
    }
    const actor = requireString(input.actor, 'memory_events.actor');
    if (!EVENT_ACTORS.has(actor)) {
      throw new TypeError(`[store] invalid memory_events.actor: ${actor}`);
    }
    const info = this.#db
      .prepare(
        `INSERT INTO memory_events (at, action, table_name, row_id, actor, reason, detail_json)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        epochOr(input.at, nowSeconds()),
        action,
        requireString(input.table_name, 'memory_events.table_name'),
        input.row_id ?? null,
        actor,
        input.reason ?? null,
        toDetailJson(input.detail_json),
      );
    return Number(info.lastInsertRowid);
  }

  /**
   * @param {{table_name?: string, row_id?: string, action?: string, limit?: number}} [options]
   * @returns {object[]}
   */
  listEvents(options = {}) {
    const where = [];
    const args = [];
    if (options.table_name !== undefined) {
      where.push('table_name = ?');
      args.push(options.table_name);
    }
    if (options.row_id !== undefined) {
      where.push('row_id = ?');
      args.push(options.row_id);
    }
    if (options.action !== undefined) {
      where.push('action = ?');
      args.push(options.action);
    }
    const limit = clampLimit(options.limit, 100);
    return this.#db
      .prepare(
        `SELECT * FROM memory_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit);
  }

  // -------------------------------------------------------------- search

  /**
   * bigram 全文检索：联查 fts_facts/fts_episodes 与主表，只返回未删除行。
   * @param {string} query
   * @param {{scope?: string, limit?: number}} [options]
   * @returns {object[]} 统一形状 { type:'fact'|'episode', id, scope, ... , rank }
   */
  searchBigram(query, options = {}) {
    const match = toMatchQuery(query);
    if (!match) return [];
    const limit = clampLimit(options.limit, 20);
    const scope = options.scope;

    const scopeClause = scope === undefined ? '' : ' AND f.scope = ?';
    const factArgs = [match, ...(scope === undefined ? [] : [scope]), limit];
    const factRows = this.#db
      .prepare(
        `SELECT f.id, f.scope, f.kind, f.statement, f.subject_text, f.predicate,
                f.object_text, f.salience, f.status, bm25(fts_facts) AS rank
           FROM fts_facts JOIN facts f ON f.rowid = fts_facts.rowid
          WHERE fts_facts MATCH ? AND f.deleted_at IS NULL${scopeClause}
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(...factArgs);

    const episodeScopeClause = scope === undefined ? '' : ' AND e.scope = ?';
    const episodeArgs = [match, ...(scope === undefined ? [] : [scope]), limit];
    const episodeRows = this.#db
      .prepare(
        `SELECT e.id, e.scope, e.title, e.summary, e.topics_json, e.salience,
                e.status, bm25(fts_episodes) AS rank
           FROM fts_episodes JOIN episodes e ON e.rowid = fts_episodes.rowid
          WHERE fts_episodes MATCH ? AND e.deleted_at IS NULL${episodeScopeClause}
          ORDER BY rank ASC
          LIMIT ?`,
      )
      .all(...episodeArgs);

    const merged = [
      ...factRows.map((row) => ({ type: 'fact', ...row })),
      ...episodeRows.map((row) => ({ type: 'episode', ...row })),
    ];
    merged.sort((a, b) => a.rank - b.rank);
    return merged.slice(0, limit);
  }

  // ---------------------------------------------------------------- emotion

  /**
   * P3-b：读取某 scope 的情绪状态行。
   *
   * 时间戳是毫秒 epoch（emotion_* 两张表按卡面新表约定用毫秒，既有表多用秒）；
   * 没有状态行返回 null（表示「还没有情绪基线」，不是四维全 0）。
   * @param {string} scope
   * @returns {{scope: string, pleasure: number, arousal: number, dominance: number,
   *            energy: number, updatedAt: number, lastEventAt: number|null}|null}
   */
  getEmotionState(scope) {
    const key = requireString(scope, 'emotion_state.scope');
    const row = this.#db.prepare('SELECT * FROM emotion_state WHERE scope = ?').get(key);
    return row === undefined ? null : mapEmotionStateRow(row);
  }

  /**
   * P3-b：写入/覆盖某 scope 的情绪状态（ON CONFLICT(scope) DO UPDATE）。
   *
   * 校验：四维必须是 0–100 的有限数、updatedAt 必须是有限毫秒数，否则 TypeError；
   * lastEventAt 可空。调用方**省略** lastEventAt（undefined）时保留库里已有的值，
   * 避免「只更新四维」的写入把 appendEmotionEvent 维护的事件时间抹掉；要显式清除
   * 必须传 null。
   * @param {string} scope
   * @param {{pleasure: number, arousal: number, dominance: number, energy: number,
   *          updatedAt: number, lastEventAt?: number|null}} state
   * @returns {{scope: string, pleasure: number, arousal: number, dominance: number,
   *            energy: number, updatedAt: number, lastEventAt: number|null}}
   */
  setEmotionState(scope, state = {}) {
    const key = requireString(scope, 'emotion_state.scope');
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('[store] emotion state must be an object');
    }
    const values = {};
    for (const dimension of EMOTION_DIMENSIONS) {
      values[dimension] = requireEmotionValue(state[dimension], `emotion_state.${dimension}`);
    }
    const updatedAt = requireEmotionMillis(state.updatedAt, 'emotion_state.updated_at');
    let lastEventAt;
    if (state.lastEventAt === undefined) {
      const existing = this.#db
        .prepare('SELECT last_event_at FROM emotion_state WHERE scope = ?')
        .get(key);
      lastEventAt = existing === undefined || existing.last_event_at === null
        ? null
        : Number(existing.last_event_at);
    } else {
      lastEventAt = optionalEmotionMillis(state.lastEventAt, 'emotion_state.last_event_at');
    }
    this.#db
      .prepare(
        `INSERT INTO emotion_state (
           scope, pleasure, arousal, dominance, energy, updated_at, last_event_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           pleasure = excluded.pleasure,
           arousal = excluded.arousal,
           dominance = excluded.dominance,
           energy = excluded.energy,
           updated_at = excluded.updated_at,
           last_event_at = excluded.last_event_at`,
      )
      .run(
        key,
        values.pleasure,
        values.arousal,
        values.dominance,
        values.energy,
        updatedAt,
        lastEventAt,
      );
    return this.getEmotionState(key);
  }

  /**
   * P3-b：追加一条情绪事件，并把该 scope 的事件裁剪到最近
   * {@link EMOTION_EVENT_RETENTION} 条（超出删最旧），单事务。
   *
   * 同时把 emotion_state.last_event_at 更新为本次 `at`（仅当该 scope 有状态行），
   * 让「最近一次情绪事件」无需扫事件表即可读出。
   * 校验：at 有限毫秒数、type 非空字符串、deltas 含四维有限数，否则 TypeError；
   * note 可空。非法输入在开启事务之前就抛错，不会留下半截写入。
   * @param {string} scope
   * @param {{at: number, type: string, deltas: object, note?: string|null}} input
   * @returns {{id: number, scope: string, at: number, type: string,
   *            deltas: object, note: string|null}}
   */
  appendEmotionEvent(scope, input = {}) {
    const key = requireString(scope, 'emotion_events.scope');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('[store] emotion event must be an object');
    }
    const at = requireEmotionMillis(input.at, 'emotion_events.at');
    const type = requireString(input.type, 'emotion_events.type');
    const deltas = normalizeEmotionDeltas(input.deltas);
    let note = null;
    if (input.note !== null && input.note !== undefined) {
      if (typeof input.note !== 'string') {
        throw new TypeError('[store] emotion_events.note must be a string or null');
      }
      note = input.note === '' ? null : input.note;
    }
    return this.#atomic(() => {
      const info = this.#db
        .prepare(
          `INSERT INTO emotion_events (scope, at, type, deltas_json, note)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(key, at, type, JSON.stringify(deltas), note);
      this.#trimEmotionEvents(key);
      this.#db
        .prepare('UPDATE emotion_state SET last_event_at = ? WHERE scope = ?')
        .run(at, key);
      return { id: Number(info.lastInsertRowid), scope: key, at, type, deltas, note };
    });
  }

  /**
   * P3-b：把某 scope 的事件裁剪到最近 N 条（按 at DESC, id DESC 保留，删其余）。
   * 调用方负责事务；返回实际删除条数。
   * @param {string} scope
   * @returns {number}
   */
  #trimEmotionEvents(scope) {
    const info = this.#db
      .prepare(
        `DELETE FROM emotion_events
          WHERE scope = ?
            AND id NOT IN (
              SELECT id FROM emotion_events
               WHERE scope = ?
               ORDER BY at DESC, id DESC
               LIMIT ?
            )`,
      )
      .run(scope, scope, EMOTION_EVENT_RETENTION);
    return Number(info.changes);
  }

  /**
   * P3-b：按 `at DESC, id DESC` 取某 scope 最近 N 条情绪事件（默认 3）。
   * deltas_json 反序列化成对象返回；坏 JSON 退化为空对象，不阻断读取。
   * @param {string} scope
   * @param {number} [limit]
   * @returns {{id: number, scope: string, at: number, type: string,
   *            deltas: object, note: string|null}[]}
   */
  listEmotionEvents(scope, limit = EMOTION_EVENT_DEFAULT_LIMIT) {
    const key = requireString(scope, 'emotion_events.scope');
    const size = clampLimit(limit, EMOTION_EVENT_DEFAULT_LIMIT);
    const rows = this.#db
      .prepare(
        `SELECT id, scope, at, type, deltas_json, note
           FROM emotion_events
          WHERE scope = ?
          ORDER BY at DESC, id DESC
          LIMIT ?`,
      )
      .all(key, size);
    return rows.map((row) => mapEmotionEventRow(row));
  }

  /**
   * P3-b：某 scope 的情绪事件总数。
   * @param {string} scope
   * @returns {number}
   */
  countEmotionEvents(scope) {
    const key = requireString(scope, 'emotion_events.scope');
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM emotion_events WHERE scope = ?')
      .get(key);
    return Number(row?.n ?? 0);
  }

  /**
   * P3-b：清空某 scope 的情绪状态与全部事件（单事务，其它 scope 不受影响）。
   * @param {string} scope
   * @returns {{events: number}} 被删除的事件条数
   */
  resetEmotion(scope) {
    const key = requireString(scope, 'emotion_state.scope');
    return this.#atomic(() => {
      const info = this.#db
        .prepare('DELETE FROM emotion_events WHERE scope = ?')
        .run(key);
      this.#db.prepare('DELETE FROM emotion_state WHERE scope = ?').run(key);
      return { events: Number(info.changes) };
    });
  }

  // ---------------------------------------------------------- maintenance

  /**
   * S2：物理删除已过冷静期的 facts/episodes，同步清 FTS，并写 PURGED 审计。
   * 审计只留 id/档位，不留正文。
   *
   * P3-b（v14）：同一事务里顺带遗忘窗口外的情绪痕迹——删除
   * `emotion_events.at < cutoff` 的事件行，并删除这些 scope 的
   * `emotion_state` 行（窗口外的情绪不留基线）；有删除时额外写一条
   * PURGED 审计（table_name='emotion_events'，detail 只含条数，不含正文）。
   * 返回形状保持 `{facts, episodes}` 不变（安全测试依赖）。
   * @param {{now?: number|Date, cutoffDays?: number}} [options]
   * @returns {{facts: number, episodes: number}}
   */
  purge(options = {}) {
    const at = epochOr(options.now, nowSeconds());
    const cutoffDays = options.cutoffDays ?? DEFAULT_PURGE_DAYS;
    if (typeof cutoffDays !== 'number' || !Number.isFinite(cutoffDays) || cutoffDays < 0) {
      throw new TypeError('[store] cutoffDays must be a non-negative number');
    }
    const cutoff = at - Math.trunc(cutoffDays * 86400);
    return this.#atomic(() => {
      const facts = this.#db
        .prepare(
          `SELECT rowid AS rid, id, salience FROM facts
            WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
        )
        .all(cutoff);
      const episodes = this.#db
        .prepare(
          `SELECT rowid AS rid, id, salience FROM episodes
            WHERE deleted_at IS NOT NULL AND deleted_at <= ?`,
        )
        .all(cutoff);
      const result = this.#purgeRows({
        facts, episodes, at, actor: 'scheduler', reason: 'purge',
      });
      // emotion_* 用毫秒，purge 的 cutoff 是秒：这里显式换算，不改既有表口径。
      const emotion = this.#purgeEmotionBefore(cutoff * 1000);
      if (emotion.events > 0 || emotion.states > 0) {
        this.appendEvent({
          at,
          action: 'PURGED',
          table_name: 'emotion_events',
          row_id: null,
          actor: 'scheduler',
          reason: 'purge',
          detail_json: { emotionEvents: emotion.events, emotionStates: emotion.states },
        });
      }
      return result;
    });
  }

  /**
   * P3-b：删除毫秒 cutoff 之前的情绪事件，并删除这些 scope 的状态行。
   * 调用方负责事务；只返回条数，不返回正文。
   * @param {number} cutoffMs
   * @returns {{events: number, states: number}}
   */
  #purgeEmotionBefore(cutoffMs) {
    if (!Number.isFinite(cutoffMs)) return { events: 0, states: 0 };
    const scopes = this.#db
      .prepare('SELECT DISTINCT scope FROM emotion_events WHERE at < ?')
      .all(cutoffMs)
      .map((row) => row.scope);
    if (scopes.length === 0) return { events: 0, states: 0 };
    const marks = scopes.map(() => '?').join(',');
    const events = this.#db
      .prepare('DELETE FROM emotion_events WHERE at < ?')
      .run(cutoffMs);
    const states = this.#db
      .prepare(`DELETE FROM emotion_state WHERE scope IN (${marks})`)
      .run(...scopes);
    return { events: Number(events.changes), states: Number(states.changes) };
  }

  /**
   * H4 立即物删：跳过 7 天冷静期，只删除调用方点名且已 tombstoned
   * （deleted_at 非空）的行。外键断开、FTS 清理与审计口径同 purge()，
   * 但 actor='user'、reason='forget'。未标记删除的行一律忽略，避免误删。
   * @param {{facts?: string[], episodes?: string[], at?: number|Date, now?: number|Date}} [options]
   * @returns {{facts: number, episodes: number}}
   */
  purgeIds(options = {}) {
    const at = epochOr(options.at ?? options.now, nowSeconds());
    const factIds = normalizeIdList(options.facts);
    const episodeIds = normalizeIdList(options.episodes);
    if (factIds.length === 0 && episodeIds.length === 0) return { facts: 0, episodes: 0 };
    return this.#atomic(() => {
      const facts = this.#selectTombstonedByIds('facts', factIds);
      const episodes = this.#selectTombstonedByIds('episodes', episodeIds);
      return this.#purgeRows({ facts, episodes, at, actor: 'user', reason: 'forget' });
    });
  }

  /**
   * 按 id 选取已标记删除的行（active 行不参与物删）。
   * @param {'facts'|'episodes'} table
   * @param {string[]} ids
   * @returns {Array<{rid:number,id:string,salience:string}>}
   */
  #selectTombstonedByIds(table, ids) {
    if (ids.length === 0) return [];
    const marks = ids.map(() => '?').join(',');
    return this.#db
      .prepare(
        `SELECT rowid AS rid, id, salience FROM ${table}
          WHERE id IN (${marks}) AND deleted_at IS NOT NULL`,
      )
      .all(...ids);
  }

  /**
   * 物理删除一组行并写 PURGED 审计（purge / purgeIds 共用）。
   * @param {{facts: object[], episodes: object[], at: number,
   *          actor: 'scheduler'|'user', reason: string}} input
   * @returns {{facts: number, episodes: number}}
   */
  #purgeRows({ facts, episodes, at, actor, reason }) {
    const factIds = facts.map((row) => row.id);
    const episodeIds = episodes.map((row) => row.id);

    // 先断开幸存行指向待删行的外键（DDL 为 NO ACTION），否则 FK 会阻塞物理删除：
    // facts.source_episode_id / reminders.source_episode_id / state_board.ref_episode_id
    // → episodes；facts.superseded_by → facts。只清指针，不动正文与审计。
    if (episodeIds.length > 0) {
      const marks = episodeIds.map(() => '?').join(',');
      this.#db
        .prepare(
          `UPDATE facts SET source_episode_id = NULL, updated_at = unixepoch()
            WHERE source_episode_id IN (${marks})`,
        )
        .run(...episodeIds);
      this.#db
        .prepare(
          `UPDATE reminders SET source_episode_id = NULL, updated_at = unixepoch()
            WHERE source_episode_id IN (${marks})`,
        )
        .run(...episodeIds);
      this.#db
        .prepare(
          `UPDATE state_board SET ref_episode_id = NULL, updated_at = unixepoch()
            WHERE ref_episode_id IN (${marks})`,
        )
        .run(...episodeIds);
    }
    if (factIds.length > 0) {
      const marks = factIds.map(() => '?').join(',');
      this.#db
        .prepare(
          `UPDATE facts SET superseded_by = NULL, updated_at = unixepoch()
            WHERE superseded_by IN (${marks})`,
        )
        .run(...factIds);
    }

    for (const row of facts) {
      this.#db.prepare('DELETE FROM fts_facts WHERE rowid = ?').run(row.rid);
      this.#db.prepare('DELETE FROM fact_vectors WHERE fact_id = ?').run(row.id);
      this.#db.prepare('DELETE FROM facts WHERE rowid = ?').run(row.rid);
      this.appendEvent({
        at,
        action: 'PURGED',
        table_name: 'facts',
        row_id: row.id,
        actor,
        reason,
        detail_json: { salience: row.salience },
      });
    }
    for (const row of episodes) {
      this.#db.prepare('DELETE FROM fts_episodes WHERE rowid = ?').run(row.rid);
      this.#db.prepare('DELETE FROM episodes WHERE rowid = ?').run(row.rid);
      this.appendEvent({
        at,
        action: 'PURGED',
        table_name: 'episodes',
        row_id: row.id,
        actor,
        reason,
        detail_json: { salience: row.salience },
      });
    }
    return { facts: facts.length, episodes: episodes.length };
  }

  /**
   * 各表行数快照，便于测试与观测。
   * @returns {Record<string, number>}
   */
  stats() {
    const tables = [
      'entities', 'episodes', 'facts', 'reminders', 'state_board', 'state_board_rev',
      'threads', 'consolidations', 'memory_events',
      'emotion_state', 'emotion_events', 'token_usage',
    ];
    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of tables) {
      counts[table] = this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    counts.fts_facts = this.#db.prepare('SELECT COUNT(*) AS n FROM fts_facts').get().n;
    counts.fts_episodes = this.#db.prepare('SELECT COUNT(*) AS n FROM fts_episodes').get().n;
    return counts;
  }
}
