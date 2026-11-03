/**
 * 状态板渲染与 staged 发布（T6，06 v3.3 §2.5 / §8.2 / §16.4）。
 *
 * 设计约束：
 * - 状态板是 system 段（order 160）里「我们现在处在什么局面」的一段文本；
 *   巩固时只写 `state_board_rev.staged_*`，真正翻进 system 要等四个发布
 *   时机之一（压缩成功 / 进程重启与会话重载 / 线程 unarchive / 人格编辑）。
 * - 总预算 ≤800 token。token 估算按卡上口径 `Math.ceil(text.length / 2)`；
 *   超限按「最后提及时间」从最旧的行开始挤掉，被挤掉的内容本身已在
 *   episode / facts 里，不会丢。
 *
 * 渲染输入是四组记忆行（不是 state_board 行表）：最近情景、事实、线程、
 * 提醒。5 个区块与输入的对应关系（卡上区块名 → 数据来源）：
 *   当前状态   ← facts（我们还知道哪些现状）
 *   最近进展   ← recent（最近 episode）
 *   待办       ← reminders（kind = todo / commitment）
 *   线程简表   ← threads（key + 一句话 + 最后进展 + 最后活跃日）
 *   提醒       ← reminders（kind = schedule / repeat）
 * 线程 scope 的四组输入都只含该线程自己的行。
 */

/** 状态板总预算（token，按 Math.ceil(len / 2) 估算）。 */
export const BOARD_TOKEN_LIMIT = 800;

/** 允许发布状态板的四个时机（06 v3.3 §8.2）。 */
export const PUBLISH_REASONS = Object.freeze([
  'compact',
  'restart',
  'thread-unarchive',
  'persona-edit',
]);

/** 区块标题（顺序即渲染顺序）。 */
const SECTION_TITLES = Object.freeze([
  '当前状态',
  '最近进展',
  '待办',
  '线程简表',
  '提醒',
]);

/**
 * 每个区块的行数上限（06 §2.5：进行中 8 / 最近决定 6 / 悬而未决 5 /
 * 近期安排 5 / 线程目录 10；这里按信息密度归并到 5 个区块）。
 */
const SECTION_CAPS = Object.freeze({
  当前状态: 8,
  最近进展: 6,
  待办: 5,
  线程简表: 10,
  提醒: 5,
});

const CLOSED_REMINDER_STATUSES = new Set(['done', 'cancelled', 'expired']);
const HIDDEN_FACT_STATUSES = new Set(['superseded', 'tombstoned']);
const SCHEDULE_REMINDER_KINDS = new Set(['schedule', 'repeat']);

/**
 * Date / 秒 / 毫秒时间戳统一成 Unix 秒；无法识别时返回 null（状态板不因
 * 脏数据整体失败，只是不显示日期）。
 * @param {unknown} value
 * @returns {number|null}
 */
function toSeconds(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return null;
}

/** @param {number|null} seconds @returns {string} 形如 11-03（本地时区） */
function formatDay(seconds) {
  if (seconds === null) return '';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 压成单行并截断到 max 个字符（含省略号）。 */
function clip(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text === '') return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** @param {unknown} value @returns {Array<Record<string, unknown>>} */
function asRows(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : [];
}

/**
 * 把一批行映射成状态板条目；无法成行的行直接丢弃。
 * @param {unknown[]} rows
 * @param {(row: Record<string, unknown>) => {text: string, at: number|null}|null} mapRow
 * @param {number} seqStart
 * @returns {{entries: Array<{text: string, at: number|null, seq: number}>, nextSeq: number}}
 */
function makeEntries(rows, mapRow, seqStart) {
  /** @type {Array<{text: string, at: number|null, seq: number}>} */
  const entries = [];
  let seq = seqStart;
  for (const row of asRows(rows)) {
    const mapped = mapRow(row);
    if (!mapped) continue;
    entries.push({ text: mapped.text, at: mapped.at ?? null, seq: seq++ });
  }
  entries.sort(compareRecent);
  return { entries, nextSeq: seq };
}

/** 最近提及优先；无时间戳的排最后。 */
function compareRecent(a, b) {
  const left = a.at ?? Number.NEGATIVE_INFINITY;
  const right = b.at ?? Number.NEGATIVE_INFINITY;
  if (left !== right) return right - left;
  return a.seq - b.seq;
}

/** 事实行 → 「- statement」。 */
function mapFact(row) {
  if (HIDDEN_FACT_STATUSES.has(row.status)) return null;
  const statement =
    typeof row.statement === 'string' && row.statement.trim() !== ''
      ? row.statement
      : [row.subject_text, row.predicate, row.object_text].filter(Boolean).join(' ');
  const text = clip(statement, 70);
  if (text === '') return null;
  return { text: `- ${text}`, at: toSeconds(row.observed_at) };
}

/** 情景行 → 「- MM-DD 标题：摘要」。 */
function mapEpisode(row) {
  const title = clip(row.title, 24);
  if (title === '') return null;
  const summary = clip(row.summary, 40);
  const day = formatDay(toSeconds(row.started_at ?? row.created_at));
  const prefix = day === '' ? '' : `${day} `;
  return {
    text: summary === '' ? `- ${prefix}${title}` : `- ${prefix}${title}：${summary}`,
    at: toSeconds(row.started_at ?? row.created_at),
  };
}

/** 提醒行 → 「- 标题（MM-DD）」。 */
function mapReminder(row) {
  if (CLOSED_REMINDER_STATUSES.has(row.status)) return null;
  const title = clip(row.title ?? row.text, 50);
  if (title === '') return null;
  const due = toSeconds(row.due_at ?? row.next_fire_at);
  const day = formatDay(due);
  return {
    text: day === '' ? `- ${title}` : `- ${title}（${day}）`,
    at: due ?? toSeconds(row.created_at),
  };
}

/** 线程行 → 「- key：描述｜进展：…｜活跃 MM-DD」。 */
function mapThread(row) {
  const key = clip(row.key, 24);
  if (key === '') return null;
  const parts = [`- ${key}`];
  const description = clip(row.description, 30);
  if (description !== '') parts.push(`：${description}`);
  const progress = clip(row.last_progress, 24);
  if (progress !== '') parts.push(`｜进展：${progress}`);
  const day = formatDay(toSeconds(row.last_active_at));
  if (day !== '') parts.push(`｜活跃 ${day}`);
  return { text: parts.join(''), at: toSeconds(row.last_active_at) };
}

/**
 * 把四组输入整理成 5 个区块（先按最近排、再按上限截行）。
 * @param {{recent?: unknown[], facts?: unknown[], threads?: unknown[], reminders?: unknown[]}} input
 * @returns {Array<{title: string, entries: Array<{text: string, at: number|null, seq: number, removed?: boolean}>}>}
 */
function buildSections(input) {
  const facts = asRows(input.facts);
  const recent = asRows(input.recent);
  const threads = asRows(input.threads);
  const reminders = asRows(input.reminders);
  const todoReminders = reminders.filter((row) => !SCHEDULE_REMINDER_KINDS.has(row.kind));
  const scheduleReminders = reminders.filter((row) => SCHEDULE_REMINDER_KINDS.has(row.kind));

  const bucket = [
    { title: SECTION_TITLES[0], rows: facts, map: mapFact },
    { title: SECTION_TITLES[1], rows: recent, map: mapEpisode },
    { title: SECTION_TITLES[2], rows: todoReminders, map: mapReminder },
    { title: SECTION_TITLES[3], rows: threads, map: mapThread },
    { title: SECTION_TITLES[4], rows: scheduleReminders, map: mapReminder },
  ];

  /** @type {Array<{title: string, entries: ReturnType<typeof makeEntries>['entries']}>} */
  const sections = [];
  let seq = 0;
  for (const { title, rows, map } of bucket) {
    const { entries, nextSeq } = makeEntries(rows, map, seq);
    seq = nextSeq;
    sections.push({ title, entries: entries.slice(0, SECTION_CAPS[title] ?? 10) });
  }
  return sections;
}

/**
 * 渲染区块文本；被挤掉（removed）的行不显示，空区块显示「（暂无）」
 * 以保证 5 个区块始终存在。
 * @param {ReturnType<typeof buildSections>} sections
 * @returns {string}
 */
function renderSections(sections) {
  return sections
    .map(({ title, entries }) => {
      const lines = entries.filter((entry) => !entry.removed).map((entry) => entry.text);
      return `【${title}】\n${lines.length === 0 ? '- （暂无）' : lines.join('\n')}`;
    })
    .join('\n');
}

/**
 * 找当前最旧的一行（用于 800 token 超限时挤出）。
 * @param {ReturnType<typeof buildSections>} sections
 * @returns {{section: object, entry: object}|null}
 */
function pickOldestSection(sections) {
  let victim = null;
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.removed) continue;
      if (victim === null) {
        victim = { section, entry };
        continue;
      }
      const at = entry.at ?? Number.NEGATIVE_INFINITY;
      const victimAt = victim.entry.at ?? Number.NEGATIVE_INFINITY;
      if (at < victimAt || (at === victimAt && entry.seq > victim.entry.seq)) {
        victim = { section, entry };
      }
    }
  }
  return victim;
}

/**
 * token 估算（卡上口径）：`Math.ceil(len / 2)`。
 * @param {string} text
 * @returns {number}
 */
export function estimateBoardTokens(text) {
  return Math.ceil(String(text ?? '').length / 2);
}

/**
 * 渲染状态板文本：5 区块、总量 ≤800 token；超限时按最后提及时间从最旧
 * 的行开始挤掉。
 * @param {{recent?: unknown[], facts?: unknown[], threads?: unknown[],
 *          reminders?: unknown[]}} [input]
 * @returns {string}
 */
export function renderBoard(input = {}) {
  const sections = buildSections(input ?? {});
  let text = renderSections(sections);
  while (estimateBoardTokens(text) > BOARD_TOKEN_LIMIT) {
    const victim = pickOldestSection(sections);
    if (victim === null) break;
    victim.entry.removed = true;
    text = renderSections(sections);
  }
  return text;
}

/**
 * 暂存状态板渲染（巩固事务内调用）：只写 `staged_*`，不发布。
 * staged_revision 恒为当前 revision + 1（反复覆盖不变，由 Store 保证）。
 * @param {{setStagedBoard: Function}} store
 * @param {string} scope main / thread:<key>
 * @param {string} text renderBoard() 或模型输出的渲染文本
 * @returns {{revision: number, staged_revision: number|null}}
 */
export function stageBoard(store, scope, text) {
  if (!store || typeof store.setStagedBoard !== 'function') {
    throw new TypeError('[state-board] store.setStagedBoard is required');
  }
  if (typeof text !== 'string') {
    throw new TypeError('[state-board] text must be a string');
  }
  const row = store.setStagedBoard(scope, text);
  return { revision: row.revision, staged_revision: row.staged_revision };
}

/**
 * 发布 staged → rendered。只有四个时机允许发布：
 * compact（压缩成功）/ restart（进程重启或会话重载）/
 * thread-unarchive（线程 unarchive）/ persona-edit（人格编辑）。
 * 其余 reason 一律返回 null 且不动库。
 * @param {{publishBoard: Function}} store
 * @param {string} scope main / thread:<key>
 * @param {string} reason 见 PUBLISH_REASONS
 * @returns {number|null} 新 revision；非法 reason 或无 staged 时 null
 */
export function publishBoard(store, scope, reason) {
  if (!PUBLISH_REASONS.includes(reason)) return null;
  if (!store || typeof store.publishBoard !== 'function') {
    throw new TypeError('[state-board] store.publishBoard is required');
  }
  return store.publishBoard(scope ?? 'main');
}
