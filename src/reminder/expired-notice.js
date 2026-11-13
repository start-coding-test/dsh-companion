import { randomUUID } from 'node:crypto';
import { DEFAULT_TIMEZONE, zonedParts } from '../time.js';

/** 过期提醒通知的注入来源前缀：与其它注入消息一致，巩固/召回/闲聊都会跳过。 */
export const EXPIRED_SOURCE_KIND = 'companion-expired';

/** 一次最多列出多少条（避免一次刷屏，其余只给条数）。 */
const EXPIRED_NOTICE_MAX_LINES = 5;

/**
 * 把过期提醒排成一段一次性说明。
 *
 * @param {Array<object>} rows store.listUnnotifiedExpired 返回的行
 * @param {{ timeZone?: string }} [options]
 * @returns {string} 空字符串表示没有可告知的内容
 */
export function buildExpiredNotice(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const timeZone = typeof options.timeZone === 'string' ? options.timeZone : DEFAULT_TIMEZONE;
  const lines = [];
  for (const row of rows.slice(0, EXPIRED_NOTICE_MAX_LINES)) {
    const title = typeof row?.title === 'string' && row.title.trim() !== '' ? row.title.trim() : '一条提醒';
    const at = Number(row?.due_at ?? row?.next_fire_at ?? row?.created_at ?? 0);
    let when = '原定时间未知';
    if (Number.isFinite(at) && at > 0) {
      const parts = zonedParts(at * 1000, timeZone ?? DEFAULT_TIMEZONE);
      when = `${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    }
    lines.push(`- ${title}（原定 ${when}）`);
  }
  const rest = rows.length - lines.length;
  const head = `有 ${rows.length} 条提醒未能按时送达：`;
  const tail = rest > 0 ? `\n（另有 ${rest} 条未列出。）` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/**
 * V5-L1：下次发言时把「重试用尽已过期」的提醒告知用户一次。
 *
 * 只在用户真正说话的那一步注入；告知后立刻打标，重启不会重复。
 *
 * @param {object} state 插件状态（store/platform/config）
 * @param {object} payload pre-step 载荷
 * @param {Array<object>} messages 本步消息
 * @param {string|undefined} turnKey 轮次键
 * @param {string} scope 记忆域
 * @returns {Promise<object|null>} `{inject:[message]}` 或 null
 */
export async function injectExpiredNotices(state, payload, messages, turnKey, scope = 'main') {
  const { store, platform, config } = state ?? {};
  if (store === null || typeof store?.listUnnotifiedExpired !== 'function') return null;
  if (typeof turnKey === 'string' && state.turnSeen instanceof Set) {
    const key = `expired:${String(payload?.agent?.session?.id ?? scope)}:${turnKey}`;
    if (state.turnSeen.has(key)) return null;
    state.turnSeen.add(key);
  }
  const text = lastUserTextOf(messages);
  if (text === '') return null;
  if (text.trimStart().startsWith('/')) return null;

  let rows;
  try {
    rows = store.listUnnotifiedExpired(scope);
  } catch (error) {
    platform?.log?.('debug', '[dsh-companion] expired notice lookup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const notice = buildExpiredNotice(rows, { timeZone: config?.timezone });
  if (notice === '') return null;

  try {
    store.markExpiredNotified(rows.map((row) => row.id), Math.floor((platform?.now?.() ?? Date.now()) / 1000));
  } catch (error) {
    platform?.log?.('debug', '[dsh-companion] expired notice mark failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  platform?.log?.('info', '[dsh-companion] expired notice injected', { count: rows.length, scope });
  return {
    inject: [
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: notice }],
        source: { kind: EXPIRED_SOURCE_KIND, form: 'notice' },
      },
    ],
  };
}

/** 取本步第一条非注入的用户正文（只看文本，跳过注入消息）。 */
function lastUserTextOf(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message?.source?.kind === 'string' && message.source.kind !== '') continue;
    const content = message?.content;
    const parts = Array.isArray(content) ? content : [];
    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    if (text !== '' && !text.startsWith('<dsh_im_')) return text;
  }
  return '';
}
