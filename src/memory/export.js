/**
 * P2-a：记忆导出与可恢复导入。
 *
 * 设计约束：
 * - 只读导出，不改变源库；默认过滤 secret / sensitive / 墓碑行；
 * - JSON 是唯一可恢复格式；MD 用于人读；
 * - 导入在单个 SQLite 事务内完成，任一行失败即整体回滚；
 * - 不扩展既有 DDL 语义；facts.sensitive 是 P1-a 按需加的列，导出时
 *   通过 PRAGMA 探测，不存在时按未标记处理；
 * - 零第三方依赖，加密使用 node:crypto 的 scrypt + AES-256-GCM。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toBigrams } from './bigram.js';
import { isSensitiveText } from './govern.js';

/** 本插件导出文件格式版本。 */
export const EXPORT_VERSION = 1;
/** `/记忆 导出` 与默认路径使用的子目录名。 */
export const EXPORT_DIR_NAME = 'export';
/** MD 镜像默认最大行数。 */
export const MIRROR_MAX_LINES = 200;
/** 加密文件魔数。 */
export const ENCRYPTED_MAGIC = 'DSH-COMPANION-EXPORT-1';
/** scrypt 参数（2^14, r=8, p=1）。 */
export const SCRYPT_N = 2 ** 14;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

const TABLES = Object.freeze({
  facts: { pk: 'id', order: 'kind ASC, observed_at ASC, id ASC' },
  episodes: { pk: 'id', order: 'started_at ASC, id ASC' },
  reminders: { pk: 'id', order: 'created_at ASC, id ASC' },
  threads: { pk: 'key', order: 'key ASC' },
});

/**
 * @param {unknown} value
 * @returns {number}
 */
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  if (!Number.isFinite(number)) return Date.now();
  // 兼容 Store 的 Unix 秒口径；毫秒时间戳在当前年代远大于 1e11。
  return number > 1e11 ? number : number * 1000;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toSeconds(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number > 1e11 ? Math.floor(number / 1000) : Math.floor(number);
}

/**
 * 文件名时间戳（UTC，YYYY-MM-DD-HHmmss）。秒级可降低同名概率；同一秒内
 * 由 writeUniqueExport 追加 -2/-3 递增，绝不覆盖已有文件。
 * @param {number|Date} [now]
 * @returns {string}
 */
export function formatStamp(now = Date.now()) {
  const date = new Date(toMillis(now));
  const pad = (value) => String(value).padStart(2, '0');
  const day = [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())].join('-');
  return `${day}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/**
 * 当前 schema 版本（与 store.js 的 SCHEMA_VERSION 保持一致）。store.js 没有
 * 导出该常量，因此这里仅作为 schema_meta 缺失时的兜底；正常情况下导出应
 * 读取数据库里的实际版本，而不是猜。
 */
const CURRENT_SCHEMA_VERSION = '13';

/**
 * 读取导出 payload 应写入的 schema_version：优先 store.getMeta，
 * 其次直接读 schema_meta 表，最后才回退到当前版本。
 * @param {import('./store.js').Store} store
 * @returns {string}
 */
function schemaVersionOf(store) {
  let value = null;
  try {
    if (store !== null && typeof store?.getMeta === 'function') {
      value = store.getMeta('schema_version');
    }
  } catch {
    value = null;
  }
  if ((value === null || value === undefined || String(value).trim() === '')
    && typeof store?.db?.prepare === 'function') {
    try {
      const row = store.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get();
      value = row?.value ?? null;
    } catch {
      value = null;
    }
  }
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text === '' ? CURRENT_SCHEMA_VERSION : text;
}

/**
 * 以独占方式写导出文件：同一秒重复导出时依次尝试 -2、-3……
 * 使用 wx 标志避免“检查后写入”之间的竞态与静默覆盖。
 * @param {string} targetDir
 * @param {string} stamp
 * @param {'json'|'md'} format
 * @param {string} body
 * @returns {string}
 */
function writeUniqueExport(targetDir, stamp, format, body) {
  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    const suffix = sequence === 1 ? '' : `-${sequence}`;
    const path = join(targetDir, `memory-${stamp}${suffix}.${format}`);
    try {
      writeFileSync(path, body, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('[export] 无法分配唯一的导出文件名');
}

/**
 * 当前表是否存在某一列（用于兼容 P1-a 之前没有 sensitive 的旧库）。
 * @param {import('./store.js').Store} store
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
function hasColumn(store, table, column) {
  const rows = store.db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} table
 * @returns {Set<string>}
 */
function tableColumns(store, table) {
  return new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

/**
 * 文本是否应被默认导出过滤。
 * @param {unknown} text
 * @returns {boolean}
 */
function isPrivateText(text) {
  return isSensitiveText(text === null || text === undefined ? '' : String(text));
}

/**
 * 读取 facts 导出集：只取 active、未删除、非 secret/sensitive 的非墓碑行。
 * @param {import('./store.js').Store} store
 * @param {string} scope
 * @returns {object[]}
 */
function readFacts(store, scope) {
  const columns = tableColumns(store, 'facts');
  const sensitiveClause = columns.has('sensitive') ? ' AND (sensitive IS NULL OR sensitive = 0)' : '';
  const rows = store.db
    .prepare(
      `SELECT * FROM facts
        WHERE scope = ? AND status = 'active' AND deleted_at IS NULL
          AND privacy NOT IN ('sensitive', 'secret')${sensitiveClause}
        ORDER BY ${TABLES.facts.order}`,
    )
    .all(scope);
  return rows.filter((row) => !isPrivateText(row.statement));
}

/**
 * 读取 episodes 导出集：排除墓碑、secret/sensitive 与敏感正文。
 * @param {import('./store.js').Store} store
 * @param {string} scope
 * @returns {object[]}
 */
function readEpisodes(store, scope) {
  const rows = store.db
    .prepare(
      `SELECT * FROM episodes
        WHERE scope = ? AND status <> 'tombstoned' AND deleted_at IS NULL
          AND privacy NOT IN ('sensitive', 'secret')
        ORDER BY ${TABLES.episodes.order}`,
    )
    .all(scope);
  return rows.filter((row) => !isPrivateText([row.title, row.summary, row.evidence, row.mood_evidence]
    .filter(Boolean)
    .join('\n')));
}

/**
 * 读取 reminders 导出集：排除已删除与敏感正文。
 * @param {import('./store.js').Store} store
 * @param {string} scope
 * @returns {object[]}
 */
function readReminders(store, scope) {
  const rows = store.db
    .prepare(
      `SELECT * FROM reminders
        WHERE scope = ? AND deleted_at IS NULL
        ORDER BY ${TABLES.reminders.order}`,
    )
    .all(scope);
  return rows.filter((row) => !isPrivateText([row.title, row.detail, row.counterparty]
    .filter(Boolean)
    .join('\n')));
}

/**
 * 读取 threads。threads 没有 scope / deleted 列，按全局目录导出。
 * @param {import('./store.js').Store} store
 * @returns {object[]}
 */
function readThreads(store) {
  return store.db.prepare(`SELECT * FROM threads ORDER BY ${TABLES.threads.order}`).all();
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} scope
 * @returns {object|null}
 */
function readBoard(store, scope) {
  return store.db.prepare('SELECT * FROM state_board_rev WHERE scope = ?').get(scope) ?? null;
}

/**
 * 收集导出数据（纯读，不写库）。
 * @param {import('./store.js').Store} store
 * @param {{scope?: string}} [options]
 * @returns {{facts: object[], episodes: object[], reminders: object[],
 *            threads: object[], state_board: object|null, counts: object}}
 */
/**
 * 状态板是渲染文本，不是 facts 行；导出时把未导出的敏感/墓碑事实正文
 * 从渲染行里剔除，避免“facts 过滤了但 board 泄漏”。
 * @param {string} rendered
 * @param {string[]} excludedStatements
 * @returns {string}
 */
function scrubBoard(rendered, excludedStatements) {
  const text = String(rendered ?? '');
  if (text === '' || excludedStatements.length === 0) return text;
  return text
    .split(/\r?\n/u)
    .filter((line) => !excludedStatements.some((statement) => statement !== '' && line.includes(statement)))
    .join('\n');
}

export function collectExportData(store, { scope = 'main' } = {}) {
  if (!store || typeof store.db?.prepare !== 'function') {
    throw new TypeError('[export] store is required');
  }
  if (typeof scope !== 'string' || scope === '') {
    throw new TypeError('[export] scope must be a non-empty string');
  }

  const facts = readFacts(store, scope);
  const episodes = readEpisodes(store, scope);
  const reminders = readReminders(store, scope);
  const threads = readThreads(store);
  const board = readBoard(store, scope);
  const keptFactIds = new Set(facts.map((row) => row.id));
  const excludedStatements = store.db
    .prepare("SELECT id, statement FROM facts WHERE scope = ? AND statement IS NOT NULL AND statement <> ''")
    .all(scope)
    .filter((row) => !keptFactIds.has(row.id))
    .map((row) => row.statement);
  const stateBoard = board === null
    ? null
    : {
      scope: board.scope,
      revision: board.revision,
      rendered: scrubBoard(board.rendered, excludedStatements),
      updated_at: board.updated_at,
    };

  return {
    facts,
    episodes,
    reminders,
    threads,
    state_board: stateBoard,
    counts: {
      facts: facts.length,
      episodes: episodes.length,
      reminders: reminders.length,
      threads: threads.length,
      state_board: stateBoard === null ? 0 : 1,
    },
  };
}

/**
 * @param {object} data
 * @returns {string}
 */
function renderMarkdown(data) {
  const lines = [
    '# dsh-companion 记忆导出',
    '',
    `- exported_at: ${data.exported_at}`,
    `- scope: ${data.scope}`,
    `- schema_version: ${data.schema_version}`,
    `- counts: facts=${data.counts.facts}, episodes=${data.counts.episodes}, reminders=${data.counts.reminders}, threads=${data.counts.threads}, state_board=${data.counts.state_board}`,
    '',
  ];

  lines.push(`## 事实 facts（${data.data.facts.length}）`, '');
  for (const fact of data.data.facts) {
    lines.push(`- ${fact.id} · ${fact.kind} · ${fact.statement}`);
    lines.push(`  - source: ${fact.source_kind}; observed_at: ${new Date(toSeconds(fact.observed_at, 0) * 1000).toISOString()}`);
  }
  if (data.data.facts.length === 0) lines.push('（无）');
  lines.push('');

  lines.push(`## 情景 episodes（${data.data.episodes.length}）`, '');
  for (const episode of data.data.episodes) {
    lines.push(`- ${episode.id} · ${episode.title}`);
    if (episode.summary) lines.push(`  - ${String(episode.summary).replace(/\s+/gu, ' ').trim()}`);
  }
  if (data.data.episodes.length === 0) lines.push('（无）');
  lines.push('');

  lines.push(`## 提醒 reminders（${data.data.reminders.length}）`, '');
  for (const reminder of data.data.reminders) {
    lines.push(`- ${reminder.id} · ${reminder.status} · ${reminder.title}`);
    if (reminder.detail) lines.push(`  - ${String(reminder.detail).replace(/\s+/gu, ' ').trim()}`);
  }
  if (data.data.reminders.length === 0) lines.push('（无）');
  lines.push('');

  lines.push(`## 线程 threads（${data.data.threads.length}）`, '');
  for (const thread of data.data.threads) {
    lines.push(`- ${thread.key} · ${thread.name} · ${thread.status}`);
    if (thread.description) lines.push(`  - ${String(thread.description).replace(/\s+/gu, ' ').trim()}`);
  }
  if (data.data.threads.length === 0) lines.push('（无）');
  lines.push('');

  lines.push(`## 状态板 state_board（revision ${data.data.state_board?.revision ?? 0}）`, '');
  lines.push(data.data.state_board?.rendered ?? '');
  lines.push('');

  return lines.join('\n');
}

/**
 * 导出到文件。
 *
 * @param {{store: import('./store.js').Store, scope?: string, format?: 'md'|'json',
 *          dir?: string, now?: number|Date}} input
 * @returns {{path: string, format: string, exported_at: string, scope: string,
 *            counts: object, bytes: number}}
 */
export function exportAll({ store, scope = 'main', format = 'json', dir, now = Date.now() } = {}) {
  if (format !== 'json' && format !== 'md') {
    throw new TypeError('[export] format must be "json" or "md"');
  }
  const at = toMillis(now);
  const collected = collectExportData(store, { scope });
  const exportedAt = new Date(at).toISOString();
  const schemaVersion = schemaVersionOf(store);
  const data = {
    version: EXPORT_VERSION,
    exported_at: exportedAt,
    scope,
    schema_version: schemaVersion,
    counts: collected.counts,
    data: {
      facts: collected.facts,
      episodes: collected.episodes,
      reminders: collected.reminders,
      threads: collected.threads,
      state_board: collected.state_board,
    },
  };

  const targetDir = dir ?? join(process.cwd(), '.data', EXPORT_DIR_NAME);
  mkdirSync(targetDir, { recursive: true });
  const body = format === 'json' ? `${JSON.stringify(data, null, 2)}\n` : renderMarkdown(data);
  const path = writeUniqueExport(targetDir, formatStamp(at), format, body);

  return {
    path,
    format,
    exported_at: exportedAt,
    scope,
    counts: collected.counts,
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

/**
 * 目标库是否为空（忽略 Store.migrate 建出的空状态板占位行）。
 * @param {import('./store.js').Store} store
 * @param {string} scope
 * @returns {boolean}
 */
function isTargetEmpty(store, scope) {
  for (const table of ['facts', 'episodes', 'reminders', 'threads', 'state_board']) {
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    if (Number(row?.n ?? 0) > 0) return false;
  }
  const board = store.db
    .prepare('SELECT revision, rendered FROM state_board_rev WHERE scope = ?')
    .get(scope);
  if (board && (Number(board.revision ?? 0) > 0 || String(board.rendered ?? '').trim() !== '')) {
    return false;
  }
  return true;
}

/**
 * 插入一行：只使用目标表当前存在的列，兼容旧库没有敏感列的情况。
 * @param {import('./store.js').Store} store
 * @param {string} table
 * @param {object} row
 */
function insertRow(store, table, row) {
  const columns = tableColumns(store, table);
  const keys = Object.keys(row).filter((key) => columns.has(key) && row[key] !== undefined);
  if (keys.length === 0) throw new Error(`[export] empty row for ${table}`);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  store.db.prepare(sql).run(...keys.map((key) => row[key]));
}

/**
 * 目标库缺少被引用行时把外键置空，避免导入因为未导出的墓碑/巩固行失败。
 * @param {import('./store.js').Store} store
 * @param {string} id
 * @param {string} table
 * @param {string} [column]
 * @returns {string|null}
 */
function existingReference(store, table, id, column = 'id') {
  if (id === null || id === undefined || id === '') return null;
  const row = store.db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} = ?`).get(id);
  return row ? id : null;
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} table
 * @param {string} pk
 * @param {unknown} value
 * @returns {boolean}
 */
function rowExists(store, table, pk, value) {
  return store.db.prepare(`SELECT 1 AS one FROM ${table} WHERE ${pk} = ?`).get(value) !== undefined;
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} id
 */
function rebuildFactFts(store, id) {
  const row = store.db
    .prepare('SELECT rowid AS rid, fidelity, statement, subject_text, predicate, object_text FROM facts WHERE id = ?')
    .get(id);
  if (!row) return;
  const parts = [row.statement, row.subject_text, row.predicate];
  if (row.fidelity === 'full') parts.push(row.object_text);
  store.db.prepare('DELETE FROM fts_facts WHERE rowid = ?').run(row.rid);
  store.db.prepare('INSERT INTO fts_facts (rowid, txt) VALUES (?, ?)')
    .run(row.rid, toBigrams(parts.filter(Boolean).join('\n')));
}

/**
 * @param {import('./store.js').Store} store
 * @param {string} id
 */
function rebuildEpisodeFts(store, id) {
  const row = store.db
    .prepare('SELECT rowid AS rid, title, summary, topics_json FROM episodes WHERE id = ?')
    .get(id);
  if (!row) return;
  let topics = '';
  try {
    topics = JSON.parse(row.topics_json ?? '[]').join(' ');
  } catch {
    topics = '';
  }
  store.db.prepare('DELETE FROM fts_episodes WHERE rowid = ?').run(row.rid);
  store.db.prepare('INSERT INTO fts_episodes (rowid, txt) VALUES (?, ?)')
    .run(row.rid, toBigrams([row.title, row.summary, topics].filter(Boolean).join('\n')));
}

/**
 * 导入 JSON 导出文件。
 *
 * @param {{store: import('./store.js').Store, file: string,
 *          mode?: 'fresh'|'merge'}} input
 * @returns {{ok: true, mode: string, path: string, imported: object,
 *            skipped: number, skippedByTable: object, counts: object}}
 */
export function importAll({ store, file, mode = 'fresh' } = {}) {
  if (!store || typeof store.transaction !== 'function') {
    throw new TypeError('[export] store is required');
  }
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('[export] file must be a non-empty path');
  }
  if (mode !== 'fresh' && mode !== 'merge') {
    throw new TypeError('[export] mode must be "fresh" or "merge"');
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`[export] 无法读取导出文件 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!payload || payload.version !== EXPORT_VERSION) {
    throw new Error(`[export] 不支持的导出文件版本：${String(payload?.version)}（期望 ${EXPORT_VERSION}）`);
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('[export] 导出文件缺少 data 对象');
  }
  const scope = typeof payload.scope === 'string' && payload.scope !== '' ? payload.scope : 'main';
  const data = payload.data;
  for (const key of ['facts', 'episodes', 'reminders', 'threads']) {
    if (!Array.isArray(data[key])) throw new Error(`[export] 导出文件 data.${key} 必须是数组`);
  }

  if (mode === 'fresh' && !isTargetEmpty(store, scope)) {
    throw new Error('[export] fresh 模式要求目标记忆库为空；请先使用新库或改用 merge 模式');
  }

  const imported = { facts: 0, episodes: 0, reminders: 0, threads: 0, state_board: 0 };
  const skippedByTable = { facts: 0, episodes: 0, reminders: 0, threads: 0, state_board: 0 };

  const run = () => {
    const skipIfExists = (table, pk, value) => {
      if (mode !== 'merge') return false;
      if (!rowExists(store, table, pk, value)) return false;
      skippedByTable[table] += 1;
      return true;
    };

    // 先写 episodes，满足 facts/reminders 的外键。
    for (const raw of data.episodes) {
      if (!raw || typeof raw !== 'object') throw new Error('[export] episodes 中存在非法行');
      if (skipIfExists('episodes', 'id', raw.id)) continue;
      const row = { ...raw };
      if (row.consolidation_id !== null && row.consolidation_id !== undefined) {
        row.consolidation_id = existingReference(store, 'consolidations', row.consolidation_id);
      }
      insertRow(store, 'episodes', row);
      rebuildEpisodeFts(store, row.id);
      imported.episodes += 1;
    }

    for (const raw of data.facts) {
      if (!raw || typeof raw !== 'object') throw new Error('[export] facts 中存在非法行');
      if (skipIfExists('facts', 'id', raw.id)) continue;
      const row = { ...raw };
      row.source_episode_id = existingReference(store, 'episodes', row.source_episode_id);
      row.superseded_by = existingReference(store, 'facts', row.superseded_by);
      insertRow(store, 'facts', row);
      rebuildFactFts(store, row.id);
      imported.facts += 1;
    }

    for (const raw of data.reminders) {
      if (!raw || typeof raw !== 'object') throw new Error('[export] reminders 中存在非法行');
      if (skipIfExists('reminders', 'id', raw.id)) continue;
      const row = { ...raw };
      row.source_episode_id = existingReference(store, 'episodes', row.source_episode_id);
      insertRow(store, 'reminders', row);
      imported.reminders += 1;
    }

    for (const raw of data.threads) {
      if (!raw || typeof raw !== 'object') throw new Error('[export] threads 中存在非法行');
      if (skipIfExists('threads', 'key', raw.key)) continue;
      insertRow(store, 'threads', raw);
      imported.threads += 1;
    }

    const board = data.state_board;
    if (board && typeof board === 'object') {
      const current = store.db
        .prepare('SELECT revision, rendered FROM state_board_rev WHERE scope = ?')
        .get(board.scope ?? scope);
      if (mode === 'merge' && current
        && (Number(current.revision ?? 0) > 0 || String(current.rendered ?? '').trim() !== '')) {
        skippedByTable.state_board += 1;
      } else {
        const at = toSeconds(board.updated_at, Math.floor(Date.now() / 1000));
        store.db.prepare(
          `INSERT INTO state_board_rev (scope, revision, rendered, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET
             revision = excluded.revision,
             rendered = excluded.rendered,
             updated_at = excluded.updated_at`,
        ).run(board.scope ?? scope, Number(board.revision ?? 0), String(board.rendered ?? ''), at);
        imported.state_board += 1;
      }
    }
  };

  store.transaction(run);
  const skipped = Object.values(skippedByTable).reduce((sum, value) => sum + value, 0);
  return {
    ok: true,
    mode,
    path: file,
    imported,
    skipped,
    skippedByTable,
    counts: store.stats(),
  };
}

/**
 * 加密一组 JSON 数据。返回可直接写盘的 UTF-8 文本。
 *
 * @param {unknown} value
 * @param {string} passphrase
 * @param {{id?: string, now?: number|Date}} [options]
 * @returns {string}
 */
export function encryptJson(value, passphrase, { id = null, now = Date.now() } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('[export] passphrase must be a non-empty string');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // v2：magic + header JSON（不含 tag，tag 是 GCM 的输出）作为 AAD，
  // 绑定 cipher/KDF 参数/salt/iv/id/created_at 等元数据；tag 本身由 GCM 校验。
  const header = {
    format: 'v2',
    version: EXPORT_VERSION,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    id,
    created_at: new Date(toMillis(now)).toISOString(),
  };
  const headerJson = JSON.stringify(header);
  cipher.setAAD(Buffer.from(`${ENCRYPTED_MAGIC}\n${headerJson}`, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // tag 追加在 header 末尾；AAD 重建时删除 tag 后 stringify，字段顺序不变。
  const fileHeader = { ...header, tag: tag.toString('base64') };
  return `${ENCRYPTED_MAGIC}\n${JSON.stringify(fileHeader)}\n${ciphertext.toString('base64')}\n`;
}

/**
 * 解密 encryptJson 生成的文本。
 * @param {string} text
 * @param {string} passphrase
 * @returns {unknown}
 */
export function decryptJson(text, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('[export] passphrase must be a non-empty string');
  }
  const lines = String(text ?? '').split(/\r?\n/u);
  if (lines[0] !== ENCRYPTED_MAGIC) throw new Error('[export] 不是 dsh-companion 加密导出文件');
  let header;
  try {
    header = JSON.parse(lines[1] ?? '');
  } catch {
    throw new Error('[export] 加密文件头无效');
  }
  if (header.cipher !== 'aes-256-gcm' || header.kdf !== 'scrypt') {
    throw new Error('[export] 不支持的加密算法');
  }
  const format = header.format;
  if (format !== undefined && format !== 'v1' && format !== 'v2') {
    throw new Error('[export] 不支持的加密文件格式');
  }
  const salt = Buffer.from(String(header.salt ?? ''), 'base64');
  const iv = Buffer.from(String(header.iv ?? ''), 'base64');
  const tag = Buffer.from(String(header.tag ?? ''), 'base64');
  const ciphertext = Buffer.from(lines.slice(2).join('').trim(), 'base64');
  if (salt.length === 0 || iv.length === 0 || tag.length === 0 || ciphertext.length === 0) {
    throw new Error('[export] 加密文件内容不完整');
  }
  const key = scryptSync(passphrase, salt, 32, {
    N: Number(header.N) || SCRYPT_N,
    r: Number(header.r) || SCRYPT_R,
    p: Number(header.p) || SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (format === 'v2') {
      // 与 encryptJson 对称：去掉 tag 后按原字段顺序重建 AAD。
      const { tag: _tag, ...authenticated } = header;
      decipher.setAAD(Buffer.from(`${ENCRYPTED_MAGIC}\n${JSON.stringify(authenticated)}`, 'utf8'));
    }
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    // 不拼接底层错误信息，避免把任何与明文/内部结构相关的细节带出去。
    throw new Error('[export] 解密失败（口令错误、文件损坏或认证失败）');
  }
}
