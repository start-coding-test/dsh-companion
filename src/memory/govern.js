/**
 * P1-a：记忆治理（去重 / 冲突 / 过期 / 敏感）与导出镜像。
 *
 * 设计约束（review-v2 P1-a）：
 * - 只读扫描与显式 apply 分离，扫描永远不写库，apply 默认 dryRun；
 * - 不物理删除任何行：重复项用 superseded_by 指向保留条，敏感项只打标记并从
 *   FTS 投影剔除；墓碑/secret 永远不进入导出镜像；
 * - 不改既有 schema 列：sensitive 列在首次真正 apply 且命中敏感事实时按需
 *   ALTER TABLE 追加（幂等），旧库无需迁移；
 * - memory_events 允许的 action 集合没有 govern，历史表又是 append-only；审计
 *   写入用 `PRAGMA ignore_check_constraints` 局部绕过 CHECK，动作仍记为
 *   `govern`（编辑事实记为 `EDIT`），结束时恢复原值。
 *
 * 零第三方依赖：bigram 分词复用 bigram.js，衰减复用 reinforce.js。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toBigrams } from './bigram.js';
import { decayOf } from './reinforce.js';

/** 记忆治理默认作用域。 */
export const GOVERN_SCOPE = 'main';
/** 重复判定阈值（bigram Jaccard）。 */
export const DUPLICATE_THRESHOLD = 0.92;
/** 过期判定阈值（遗忘曲线 R）。 */
export const STALE_R = 0.05;
/** 导出镜像默认上限。 */
export const MIRROR_MAX_LINES = 200;
/**
 * V7-M3：命中凭据类内容时给用户的固定提示。
 * 回复与巩固回执共用同一句，避免文案分叉。
 */
export const CREDENTIAL_HINT = '这类信息建议放环境变量或文件里，我不代为保存。';

/**
 * 敏感词：命中即视为不可进入 facts / FTS / 状态板 / 导出镜像。
 *
 * V7-M3 在原有「身份证/银行卡/密码/住址」之外补齐凭据类字段名：
 * - `密码(?!学)`：排除「密码学」这类学科词，保留「wifi 密码」「银行卡密码」；
 * - `passw(?:or)?d`：password / passwd；
 * - `token` 用 `\btoken\b` 词边界，`tokenizer`、`tokens` 不命中；
 * - `key` 只在「字段名 + 分隔符 + 值」形式里判（见 CREDENTIAL_FIELD_PATTERN），
 *   `keyboard`、`SECRET-MARKER-42` 这类标记不命中；`secret` 同理；
 * - `sk-` 开头的 API key 字面值（至少 6 位）单独兜底。
 */
const SENSITIVE_PATTERN = /身份证|银行卡|信用卡|住址|密码(?!学)|passw(?:or)?d|验证码|verification\s*code|\bCVC\b|\bCVV\b|私钥|密钥|卡号|card\s*number|api[\s_-]?key|\baccess[\s_-]?token\b|令牌|\btoken\b|\bsk-[A-Za-z0-9]{6,}/iu;

/**
 * V7-M3：「字段名 + 值」形式（`key 是 abc123`、`secret: hunter2`、`pwd=1234`）。
 * 字段名后必须有分隔符/判断词，再跟至少 4 个非空白字符的值。
 */
const CREDENTIAL_FIELD_PATTERN = /(?:^|[^A-Za-z0-9_])(?:key|secret|token|pwd|pass|passwd)\s*(?:是|为|:|：|=|is)\s*([^\s，。；,;]{4,})/iu;

/** 已由 privacy=secret 标记的事实不进入任何治理/导出视图。 */
const SECRET_PRIVACY = 'secret';
/** 秒/毫秒判别阈值。 */
const EPOCH_THRESHOLD = 1e11;

/**
 * 判断文本是否命中敏感/凭据内容。
 *
 * 强敏感词直接命中；弱字段名（key/secret/token/pwd）只在「字段名 + 值」形式
 * 且值里含数字或符号时命中，避免 `key is abcd` 这类英文语句误报。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSensitiveText(text) {
  if (text === null || text === undefined) return false;
  const value = String(text);
  if (SENSITIVE_PATTERN.test(value)) return true;
  const field = CREDENTIAL_FIELD_PATTERN.exec(value);
  if (field === null) return false;
  return /[\d\p{P}\p{S}]/u.test(field[1]);
}

/**
 * 统一毫秒时间戳；非法值回退 Date.now()。
 * @param {unknown} value
 * @returns {number}
 */
function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return Date.now();
  return Math.abs(num) < EPOCH_THRESHOLD ? Math.round(num * 1000) : Math.round(num);
}

/** @param {unknown} value @returns {number} 秒 */
function toEpochSeconds(value) {
  return Math.floor(toMillis(value) / 1000);
}

/**
 * 真相/活跃事实直接 SQL 读取（listFacts 的 limit 上限 500，扫描不能截断）。
 * @param {object} store
 * @param {string} scope
 * @returns {object[]}
 */
function activeFacts(store, scope) {
  return store.db
    .prepare(
      `SELECT * FROM facts
        WHERE scope = ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY observed_at ASC, id ASC`,
    )
    .all(scope);
}

/**
 * 事实的 bigram token 集合。
 * @param {object} fact
 * @returns {Set<string>}
 */
function tokensOf(fact) {
  return new Set(toBigrams(fact.statement).split(' ').filter(Boolean));
}

/**
 * Jaccard 相似度；空集合返回 0。
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {number}
 */
function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** salience 质量顺序；pinned 最高。 */
const SALIENCE_RANK = Object.freeze({
  pinned: 5,
  explicit: 4,
  notable: 3,
  normal: 2,
  trivial: 1,
});

/**
 * 保留哪一条：salience → recall_count → strength_days → 更新时间 → id。
 * 返回值 >0 表示 left 更好。
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
function compareQuality(left, right) {
  const rankDiff = (SALIENCE_RANK[left.salience] ?? 0) - (SALIENCE_RANK[right.salience] ?? 0);
  if (rankDiff !== 0) return rankDiff;
  const recallDiff = Number(left.recall_count ?? 0) - Number(right.recall_count ?? 0);
  if (recallDiff !== 0) return recallDiff;
  const strengthDiff = Number(left.strength_days ?? 0) - Number(right.strength_days ?? 0);
  if (strengthDiff !== 0) return strengthDiff;
  const observedDiff = Number(left.observed_at ?? 0) - Number(right.observed_at ?? 0);
  if (observedDiff !== 0) return observedDiff;
  return String(left.id).localeCompare(String(right.id));
}

/**
 * 扫描三类可治理项；完全不写库。
 *
 * @param {{store: object, scope?: string, now?: number|Date}} input
 * @returns {{
 *   duplicates: Array<{keepId: string, dropId: string, score: number}>,
 *   conflicts: Array<{subject: string|null, predicate: string|null, factIds: string[]}>,
 *   stale: Array<{id: string, R: number}>,
 *   counts: {duplicates: number, conflicts: number, stale: number, sensitive: number},
 * }}
 */
export function scan({ store, scope = GOVERN_SCOPE, now = Date.now() } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.db?.prepare !== 'function') {
    throw new TypeError('[govern] store must expose a SQLite db connection');
  }
  const facts = activeFacts(store, scope).filter((fact) => fact.privacy !== SECRET_PRIVACY);

  // 1) 重复：两两 Jaccard，按分数降序贪心分配 keep/drop。
  const tokens = new Map(facts.map((fact) => [fact.id, tokensOf(fact)]));
  const pairs = [];
  for (let left = 0; left < facts.length; left += 1) {
    for (let right = left + 1; right < facts.length; right += 1) {
      const a = facts[left];
      const b = facts[right];
      const score = jaccard(tokens.get(a.id), tokens.get(b.id));
      if (score < DUPLICATE_THRESHOLD) continue;
      const keep = compareQuality(a, b) >= 0 ? a : b;
      const drop = keep.id === a.id ? b : a;
      if (drop.salience === 'pinned') continue;
      pairs.push({ keepId: keep.id, dropId: drop.id, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.keepId.localeCompare(b.keepId) || a.dropId.localeCompare(b.dropId));
  const dropped = new Set();
  const duplicates = [];
  for (const pair of pairs) {
    if (dropped.has(pair.keepId) || dropped.has(pair.dropId)) continue;
    dropped.add(pair.dropId);
    duplicates.push({ keepId: pair.keepId, dropId: pair.dropId, score: Number(pair.score.toFixed(4)) });
  }

  // 2) 冲突：同 subject+predicate 但 object 不同（object 为 null 也视为一个取值）。
  const groups = new Map();
  for (const fact of facts) {
    const key = `${fact.subject_text ?? ''}\u0000${fact.predicate ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { subject: fact.subject_text ?? null, predicate: fact.predicate ?? null, facts: [] };
      groups.set(key, group);
    }
    group.facts.push(fact);
  }
  const conflicts = [];
  for (const group of groups.values()) {
    if (group.facts.length < 2) continue;
    const objects = new Set(group.facts.map((fact) => String(fact.object_text ?? '')));
    if (objects.size < 2) continue;
    conflicts.push({
      subject: group.subject,
      predicate: group.predicate,
      factIds: group.facts.map((fact) => fact.id).sort(),
    });
  }
  conflicts.sort((a, b) => String(a.subject).localeCompare(String(b.subject)) || String(a.predicate).localeCompare(String(b.predicate)));

  // 3) 过期：仅报告，不处理。pinned 不参与衰减。
  const stale = [];
  for (const fact of facts) {
    if (fact.salience === 'pinned') continue;
    const strengthDays = Number(fact.strength_days);
    if (!Number.isFinite(strengthDays) || strengthDays <= 0) continue;
    const lastReinforcedAt = fact.last_reinforced_at ?? fact.observed_at;
    const r = decayOf({ strengthDays, lastReinforcedAt, now });
    if (r < STALE_R) stale.push({ id: fact.id, R: Number(r.toFixed(6)) });
  }
  stale.sort((a, b) => a.R - b.R || a.id.localeCompare(b.id));

  const sensitive = facts.filter((fact) => isSensitiveText([fact.statement, fact.subject_text, fact.object_text].join(' ')));

  return {
    duplicates,
    conflicts,
    stale,
    counts: {
      duplicates: duplicates.length,
      conflicts: conflicts.length,
      stale: stale.length,
      sensitive: sensitive.length,
    },
  };
}

/**
 * 幂等追加 sensitive 列；只新增列，不修改既有列。
 * @param {object} store
 * @returns {boolean} 本次是否真的加了列
 */
function ensureSensitiveColumn(store) {
  const columns = store.db.prepare('PRAGMA table_info(facts)').all();
  if (columns.some((column) => column.name === 'sensitive')) return false;
  store.db.exec('ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
  return true;
}

/** @param {object} store @param {string} id */
function deleteFactFts(store, id) {
  store.db
    .prepare('DELETE FROM fts_facts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)')
    .run(id);
}

/**
 * 写一条不在 CHECK 白名单里的审计事件（govern / EDIT）。
 *
 * `memory_events` 的 action 被 DDL CHECK 与 append-only 触发器双重约束；这里
 * 只在当前连接上临时忽略 CHECK，事件仍然真实落库，finally 恢复原值。
 *
 * @param {object} store
 * @param {{action: string, tableName?: string, rowId?: string|null, actor?: string,
 *          reason?: string, detail?: object|null, at?: number|Date}} input
 * @returns {number} 新事件 id
 */
export function appendEventWithAction(store, {
  action,
  tableName = 'facts',
  rowId = null,
  actor = 'user',
  reason = 'govern',
  detail = null,
  at = Date.now(),
} = {}) {
  if (typeof action !== 'string' || action === '') {
    throw new TypeError('[govern] action must be a non-empty string');
  }
  const db = store.db;
  const previous = db.prepare('PRAGMA ignore_check_constraints').get();
  const previousValue = previous?.ignore_check_constraints ?? 0;
  try {
    db.exec('PRAGMA ignore_check_constraints = ON');
    const info = db
      .prepare(
        `INSERT INTO memory_events (at, action, table_name, row_id, actor, reason, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toEpochSeconds(at),
        action,
        tableName,
        rowId,
        actor,
        reason,
        detail === null || detail === undefined ? null : JSON.stringify(detail),
      );
    return Number(info.lastInsertRowid);
  } finally {
    db.exec(`PRAGMA ignore_check_constraints = ${previousValue ? 'ON' : 'OFF'}`);
  }
}

/**
 * 应用治理：重复降级 + 敏感标记/FTS 剔除 + 一条 govern 审计。
 *
 * 默认 dryRun=true，只扫描不写；显式传 dryRun:false 才落库。
 *
 * @param {{store: object, scope?: string, now?: number|Date, dryRun?: boolean}} input
 * @returns {object}
 */
export function apply({ store, scope = GOVERN_SCOPE, now = Date.now(), dryRun = true } = {}) {
  const report = scan({ store, scope, now });
  const facts = activeFacts(store, scope).filter((fact) => fact.privacy !== SECRET_PRIVACY);
  const sensitive = facts.filter((fact) => isSensitiveText([fact.statement, fact.subject_text, fact.object_text].join(' ')));

  if (dryRun) {
    return {
      dryRun: true,
      scope,
      duplicates: report.duplicates,
      conflicts: report.conflicts,
      stale: report.stale,
      sensitive: sensitive.map((fact) => ({ id: fact.id, statement: fact.statement })),
      applied: { superseded: [], sensitive: [] },
      eventId: null,
      counts: report.counts,
    };
  }

  const addedSensitiveColumn = sensitive.length > 0 ? ensureSensitiveColumn(store) : false;
  const superseded = [];
  const sensitiveIds = [];
  const at = toMillis(now);

  let eventId = null;
  store.transaction(() => {
    for (const item of report.duplicates) {
      const keep = store.getFact(item.keepId);
      const drop = store.getFact(item.dropId);
      if (keep === null || drop === null) continue;
      if (drop.deleted_at !== null || drop.status !== 'active') continue;
      if (drop.salience === 'pinned') continue;
      store.updateFact(drop.id, { status: 'superseded', superseded_by: keep.id });
      deleteFactFts(store, drop.id);
      superseded.push(drop.id);
    }

    for (const fact of sensitive) {
      const current = store.getFact(fact.id);
      if (current === null || current.deleted_at !== null || current.status !== 'active') continue;
      store.db
        .prepare('UPDATE facts SET sensitive = 1, updated_at = unixepoch() WHERE id = ? AND scope = ?')
        .run(fact.id, scope);
      deleteFactFts(store, fact.id);
      sensitiveIds.push(fact.id);
    }

    eventId = appendEventWithAction(store, {
      action: 'govern',
      tableName: 'facts',
      rowId: null,
      actor: 'user',
      reason: 'governance',
      at,
      detail: {
        duplicates: report.duplicates.length,
        conflicts: report.conflicts.length,
        stale: report.stale.length,
        sensitive: sensitive.length,
        supersededIds: superseded,
        sensitiveIds,
      },
    });
  });

  return {
    dryRun: false,
    scope,
    duplicates: report.duplicates,
    conflicts: report.conflicts,
    stale: report.stale,
    sensitive: sensitive.map((fact) => ({ id: fact.id, statement: fact.statement })),
    applied: { superseded, sensitive: sensitiveIds },
    eventId,
    counts: report.counts,
    sensitiveColumnAdded: addedSensitiveColumn,
  };
}

/**
 * 把当前 scope 的活跃事实导出为 `<dir>/MEMORY.md`。
 *
 * 仅显式调用才写文件；不读 $DSH_HOME，不触碰用户 profile。secret / 墓碑 /
 * deleted / sensitive 事实不导出。超出行数上限时截断并标注剩余条数。
 *
 * @param {{store: object, dir: string, now?: number|Date, scope?: string,
 *          maxLines?: number}} input
 * @returns {{path: string, lines: number, facts: number, truncated: number}}
 */
export function exportMirror({ store, dir, now = Date.now(), scope = GOVERN_SCOPE, maxLines = MIRROR_MAX_LINES } = {}) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('[govern] store must be an object');
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new TypeError('[govern] dir must be a non-empty string');
  }
  const limit = Math.max(1, Math.min(200, Number.isFinite(Number(maxLines)) ? Math.trunc(Number(maxLines)) : MIRROR_MAX_LINES));
  const facts = activeFacts(store, scope).filter(
    (fact) => fact.privacy !== SECRET_PRIVACY && fact.sensitive !== 1 && !isSensitiveText(fact.statement),
  );

  const generatedAt = new Date(toMillis(now)).toISOString();
  const lines = [
    '# MEMORY.md',
    '',
    `> generated_at: ${generatedAt}`,
    '> source: dsh-companion facts（scope=' + scope + '）',
    `> facts: ${facts.length}`,
    '',
  ];
  const body = [];
  const byKind = new Map();
  for (const fact of facts) {
    const kind = String(fact.kind ?? 'other');
    let group = byKind.get(kind);
    if (group === undefined) {
      group = [];
      byKind.set(kind, group);
    }
    group.push(fact);
  }
  const kinds = [...byKind.keys()].sort();
  for (const kind of kinds) {
    body.push(`## ${kind}`);
    body.push('');
    for (const fact of byKind.get(kind)) {
      const statement = String(fact.statement ?? '').replace(/\s+/gu, ' ').trim();
      if (statement === '') continue;
      const source = String(fact.source_kind ?? 'unknown');
      body.push(`- ${statement}（source: ${source}; id: ${fact.id}）`);
    }
    body.push('');
  }

  const available = Math.max(1, limit - lines.length);
  const truncated = Math.max(0, body.length - available);
  const selected = truncated > 0 ? body.slice(0, available) : body;
  if (truncated > 0 && selected.length > 0) {
    selected[selected.length - 1] = `- …（还有 ${truncated} 行未导出）`;
  }
  const content = [...lines, ...selected].join('\n').replace(/\n+$/u, '\n');
  const outputPath = join(dir, 'MEMORY.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, content, 'utf8');

  return {
    path: outputPath,
    lines: content.split('\n').length,
    facts: facts.length,
    truncated,
  };
}
