/**
 * V50-L3：`/状态` 的「最近一次装配」记录。
 *
 * 只回答四个问题，且**只留在进程内存**里：
 * - 人格段是什么时候装进 system prompt 的；
 * - 每段多少码点、内容短哈希（用于确认「换了卡但没重启」这类问题）；
 * - 宿主默认人设是否真的被改写/接管；
 * - 本轮注入的情绪句是哪一句。
 *
 * 明确不存：卡正文、段正文、任何可还原内容。哈希是 SHA-256 前 8 个十六进制字符，
 * 只够做同一/不同一比较，不能反推。记录本身不做持久化，进程重启即清空。
 */
import { createHash } from 'node:crypto';

/** 段名展示时去掉的公共前缀，避免 `/状态` 一行过长。 */
const SECTION_NAME_PREFIX = 'persona:';
const SHORT_HASH_LENGTH = 8;

/**
 * 内容短哈希：空文本返回空串（段存在但正文为空时不冒充「有内容」）。
 * @param {unknown} text
 * @returns {string}
 */
export function shortHash(text) {
  if (typeof text !== 'string' || text === '') return '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, SHORT_HASH_LENGTH);
}

/**
 * 段名展示形式：`persona:core` → `core`，其余保持原样。
 * @param {string} name
 * @returns {string}
 */
export function displaySectionName(name) {
  if (typeof name !== 'string' || name === '') return '未知';
  return name.startsWith(SECTION_NAME_PREFIX) ? name.slice(SECTION_NAME_PREFIX.length) : name;
}

/**
 * 新建一条空记录。字段名保持直白，便于测试与排障时直接读。
 * @returns {object}
 */
export function createAssemblyRecord() {
  return {
    sections: null,
    sectionsAt: null,
    shadowMode: 'off',
    shadowRewritten: false,
    shadowAt: null,
    emotionText: null,
    emotionAt: null,
  };
}

/**
 * 记录人格段装配结果。动态段（`text` 是函数）跳过——它们的正文可能是状态板，
 * 每轮都变，记下来既没意义又等于把记忆内容留在内存里。
 *
 * @param {object} record
 * @param {unknown} sections
 * @param {number|null} nowMs
 */
export function recordSections(record, sections, nowMs) {
  if (record === null || typeof record !== 'object') return;
  if (!Array.isArray(sections)) return;
  const entries = [];
  for (const section of sections) {
    const name = typeof section?.name === 'string' ? section.name : '';
    const text = section?.text;
    if (name === '' || typeof text !== 'string') continue;
    entries.push(Object.freeze({
      name,
      chars: [...text].length,
      hash: shortHash(text),
    }));
  }
  record.sections = Object.freeze(entries);
  record.sectionsAt = Number.isFinite(nowMs) ? nowMs : null;
}

/**
 * 记录遮蔽实际发生的情况（每次 assemble 都会调，但只有变化才值得记时间）。
 *
 * @param {object} record
 * @param {{mode?: unknown, rewritten?: unknown, nowMs?: unknown}} info
 */
export function recordShadow(record, info = {}) {
  if (record === null || typeof record !== 'object') return;
  const { mode, rewritten, nowMs } = info;
  if (mode === 'off' || mode === 'rewrite' || mode === 'takeover') record.shadowMode = mode;
  if (rewritten === true) record.shadowRewritten = true;
  if (Number.isFinite(nowMs)) record.shadowAt = nowMs;
}

/**
 * 记下本轮情绪句（原文是「你此刻：…」，不含数值）。
 * @param {object} record
 * @param {unknown} text
 * @param {number|null} nowMs
 */
export function recordEmotionText(record, text, nowMs) {
  if (record === null || typeof record !== 'object') return;
  if (typeof text !== 'string' || text === '') return;
  record.emotionText = text;
  record.emotionAt = Number.isFinite(nowMs) ? nowMs : null;
}

/**
 * 是否已经有任何可展示的内容（没有就整行不出）。
 * @param {object} record
 * @returns {boolean}
 */
export function hasAssemblyRecord(record) {
  if (record === null || typeof record !== 'object') return false;
  return record.sections !== null || record.shadowAt !== null || record.emotionText !== null;
}

/**
 * 给 `/状态` 用的只读快照（不返回正文，只返回字数与哈希）。
 * @param {object} record
 * @returns {{sections: ReadonlyArray<object>, sectionsAt: number|null,
 *            shadowMode: string, shadowRewritten: boolean, shadowAt: number|null,
 *            emotionText: string, emotionAt: number|null}|null}
 */
export function describeAssembly(record) {
  if (hasAssemblyRecord(record) === false) return null;
  return {
    sections: Array.isArray(record.sections) ? record.sections : [],
    sectionsAt: Number.isFinite(record.sectionsAt) ? record.sectionsAt : null,
    shadowMode: typeof record.shadowMode === 'string' ? record.shadowMode : 'off',
    shadowRewritten: record.shadowRewritten === true,
    shadowAt: Number.isFinite(record.shadowAt) ? record.shadowAt : null,
    emotionText: typeof record.emotionText === 'string' ? record.emotionText : '',
    emotionAt: Number.isFinite(record.emotionAt) ? record.emotionAt : null,
  };
}
