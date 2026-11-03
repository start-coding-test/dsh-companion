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

/** schema 版本（06 v3.3 §8.2 初始值）。 */
const SCHEMA_VERSION = '3';
/** S2 物理删除默认冷静期（天）。 */
const DEFAULT_PURGE_DAYS = 7;

/** S0 默认遗忘强度（天）；pinned = null 表示不衰减。 */
export const SALIENCE_STRENGTH_DAYS = Object.freeze({
  trivial: 3,
  normal: 14,
  notable: 60,
  explicit: 365,
  pinned: null,
});

const SALIENCE_VALUES = new Set(Object.keys(SALIENCE_STRENGTH_DAYS));

const EVENT_ACTIONS = new Set([
  'ADD', 'UPDATE', 'SUPERSEDE', 'MERGE', 'NOOP', 'SKIP',
  'REINFORCE', 'DECAY', 'DEGRADE', 'TOMBSTONE', 'RESTORE', 'PURGED',
  'READ', 'USED', 'EXPORT',
]);
const EVENT_ACTORS = new Set(['consolidator', 'user', 'scheduler', 'migrator']);
const CONSOLIDATION_STATUSES = new Set(['running', 'written', 'compacted', 'failed']);
const THREAD_STATUSES = new Set(['active', 'archived', 'retired']);
const BOARD_SECTIONS = new Set(['in_progress', 'decided', 'open_question', 'upcoming', 'threads']);

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
  finished_at   INTEGER
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

CREATE TABLE IF NOT EXISTS facts (
  id                  TEXT PRIMARY KEY,
  scope               TEXT NOT NULL DEFAULT 'main',
  kind                TEXT NOT NULL CHECK (kind IN ('identity','relation','preference','project','knowledge','other')),
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
  fidelity            TEXT NOT NULL DEFAULT 'full' CHECK (fidelity IN ('full','gist','index')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','superseded','tombstoned')),
  superseded_by       TEXT REFERENCES facts(id),
  deleted_at          INTEGER,
  purge_payload       TEXT,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  CONSTRAINT ck_fact_pin_decay CHECK ((salience = 'pinned' AND strength_days IS NULL)
                                   OR (salience <> 'pinned' AND strength_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_facts_key ON facts(subject_text, predicate, status);
CREATE INDEX IF NOT EXISTS ix_facts_scope ON facts(scope, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_facts_decay ON facts(status, last_reinforced_at) WHERE strength_days IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_facts_purge ON facts(deleted_at) WHERE deleted_at IS NOT NULL;

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
  last_fire_key     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','fired','snoozed','done','cancelled','expired')),
  closed_at         INTEGER,
  source_episode_id TEXT REFERENCES episodes(id),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at        INTEGER
);
CREATE INDEX IF NOT EXISTS ix_rm_fire ON reminders(status, next_fire_at) WHERE status IN ('pending','snoozed');
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

CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL DEFAULT (unixepoch()),
  action      TEXT NOT NULL CHECK (action IN (
                'ADD','UPDATE','SUPERSEDE','MERGE','NOOP','SKIP',
                'REINFORCE','DECAY','DEGRADE','TOMBSTONE','RESTORE','PURGED',
                'READ','USED','EXPORT')),
  table_name  TEXT NOT NULL,
  row_id      TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('consolidator','user','scheduler','migrator')),
  reason      TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_ev_row ON memory_events(table_name, row_id, at DESC);
CREATE TRIGGER IF NOT EXISTS ev_no_update BEFORE UPDATE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER IF NOT EXISTS ev_no_delete BEFORE DELETE ON memory_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;

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

  /** 建表/迁移；可重复调用。 */
  migrate() {
    this.#db.exec(SCHEMA_SQL);
    this.#db
      .prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', ?)")
      .run(SCHEMA_VERSION);
    const row = this.#db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get();
    if (!row || row.value !== SCHEMA_VERSION) {
      throw new StoreError(
        `[store] unsupported schema_version: ${row ? row.value : 'missing'} (expected ${SCHEMA_VERSION})`,
      );
    }
    this.#ensureScopeRow('main');
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
        requireString(input.title, 'episodes.title'),
        input.summary ?? null,
        input.evidence ?? null,
        toJsonArray(input.topics ?? input.topics_json),
        toJsonArray(input.entities ?? input.entities_json),
        input.mood ?? null,
        input.mood_evidence ?? null,
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

  // --------------------------------------------------------------- facts

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
        requireString(input.kind, 'facts.kind'),
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
        input.recall_count ?? 0,
        input.fidelity ?? 'full',
        input.status ?? 'active',
        input.superseded_by ?? null,
        epochOr(input.deleted_at, null),
        input.purge_payload ?? null,
      );
    this.#refreshFactsFts(id);
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
      'kind', 'subject_id', 'subject_text', 'predicate', 'object_text', 'statement',
      'source_kind', 'source_episode_id', 'source_excerpt', 'privacy', 'fidelity',
      'status', 'superseded_by', 'purge_payload',
    ]);
    const epochColumns = new Set(['observed_at', 'valid_from', 'valid_to', 'deleted_at']);

    for (const [key, value] of Object.entries(patch)) {
      if (epochColumns.has(key)) {
        fields.set(key, epochOr(value, null));
      } else if (key === 'recall_count') {
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
    return this.getFact(id);
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
    return info.changes > 0 ? this.getFact(id) : null;
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
           next_fire_at, last_fire_key, status, closed_at, source_episode_id, deleted_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.last_fire_key ?? null,
        input.status ?? 'pending',
        epochOr(input.closed_at, null),
        input.source_episode_id ?? null,
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
   * 到点提醒：status IN ('pending','snoozed') 且 next_fire_at <= now。
   * @param {{now?: number|Date, scope?: string, limit?: number}} [options]
   * @returns {object[]}
   */
  dueReminders(options = {}) {
    const at = epochOr(options.now, nowSeconds());
    const where = ["status IN ('pending','snoozed')", 'next_fire_at IS NOT NULL', 'next_fire_at <= ?', 'deleted_at IS NULL'];
    const args = [at];
    if (options.scope !== undefined) {
      where.push('scope = ?');
      args.push(options.scope);
    }
    const limit = clampLimit(options.limit, 100);
    return this.#db
      .prepare(
        `SELECT * FROM reminders WHERE ${where.join(' AND ')}
          ORDER BY next_fire_at ASC, id ASC LIMIT ?`,
      )
      .all(...args, limit);
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
   * 发布 staged → rendered（四个发布时机之一由调用方保证）。
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
    this.#db
      .prepare(
        `INSERT INTO consolidations (
           id, scope, session_id, kind, trigger, upto_seq, turn_from, turn_to,
           tokens_in, tokens_out, status, error, started_at, finished_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        requireString(input.scope, 'consolidations.scope'),
        requireString(input.session_id, 'consolidations.session_id'),
        requireString(input.kind, 'consolidations.kind'),
        requireString(input.trigger, 'consolidations.trigger'),
        Number(input.upto_seq),
        input.turn_from ?? null,
        input.turn_to ?? null,
        input.tokens_in ?? null,
        input.tokens_out ?? null,
        status,
        input.error ?? null,
        epochOr(input.started_at, nowSeconds()),
        epochOr(input.finished_at, null),
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
   * 巩固水位线：MAX(upto_seq) WHERE scope=? AND status IN ('written','compacted')。
   * @param {string} scope
   * @returns {number} 无水印时 0
   */
  getWatermark(scope) {
    requireString(scope, 'getWatermark(scope)');
    const row = this.#db
      .prepare(
        `SELECT MAX(upto_seq) AS watermark FROM consolidations
          WHERE scope = ? AND status IN ('written','compacted')`,
      )
      .get(scope);
    return row && row.watermark !== null ? Number(row.watermark) : 0;
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
        options.error ?? current.error,
        finishedAt,
        id,
      );
    return this.getConsolidation(id);
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

  // ---------------------------------------------------------- maintenance

  /**
   * S2：物理删除已过冷静期的 facts/episodes，同步清 FTS，并写 PURGED 审计。
   * 审计只留 id/档位，不留正文。
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
        this.#db.prepare('DELETE FROM facts WHERE rowid = ?').run(row.rid);
        this.appendEvent({
          at,
          action: 'PURGED',
          table_name: 'facts',
          row_id: row.id,
          actor: 'scheduler',
          reason: 'purge',
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
          actor: 'scheduler',
          reason: 'purge',
          detail_json: { salience: row.salience },
        });
      }
      return { facts: facts.length, episodes: episodes.length };
    });
  }

  /**
   * 各表行数快照，便于测试与观测。
   * @returns {Record<string, number>}
   */
  stats() {
    const tables = [
      'entities', 'episodes', 'facts', 'reminders', 'state_board', 'state_board_rev',
      'threads', 'consolidations', 'memory_events',
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
