/**
 * P1-b 轻量闲聊（R-PRO-06/07/08）。
 *
 * 纯函数集合：
 * - chatEligibility：周中、今天有互动、非安静时段、≥3 天没聊、≤1/天且 ≤3/周；
 * - buildChatPrompt：人格卡 + 最近话题 + 召回摘要 → 5..10 句、不提问的提示词；
 * - normalizeChatText：去掉问句、拒绝违禁词，保留 5..10 句才允许发送。
 *
 * 仅使用 Node 内置能力，零第三方依赖；不读写库、不发消息。
 */

import { DEFAULT_TIMEZONE, zonedDayKey } from '../time.js';

export const CHAT_MIN_SENTENCES = 5;
export const CHAT_MAX_SENTENCES = 10;
export const CHAT_COOLDOWN_DAYS = 3;
export const CHAT_DAILY_CAP = 1;
export const CHAT_WEEKLY_CAP = 3;

const DAY_SECONDS = 86_400;
const SENTENCE_PATTERN = /[^。！？!?\n]+[。！？!?]?/gu;

/** @param {unknown} value @returns {number} */
function toMillis(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return Date.now();
  return Math.abs(num) < 1e11 ? num * 1000 : num;
}

/**
 * 分区日期的星期几是否周末（0=周日，6=周六）。
 * @param {number|Date} now
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function isWeekend(now = Date.now(), timeZone = DEFAULT_TIMEZONE) {
  const key = zonedDayKey(now, timeZone);
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * 判断此刻能否发起一次主动闲聊。
 *
 * @param {{now?: number|Date, timeZone?: string, enabled?: boolean,
 *          interactionDay?: string|null, lastChatAt?: number|null,
 *          sentTimes?: number[], quiet?: boolean}} input
 * @returns {{ok: boolean, reason: string}}
 */
export function chatEligibility({
  now = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
  enabled = true,
  interactionDay = null,
  lastChatAt = null,
  sentTimes = [],
  quiet = false,
} = {}) {
  if (enabled !== true) return { ok: false, reason: 'disabled' };
  if (quiet) return { ok: false, reason: 'quiet' };
  const today = zonedDayKey(now, timeZone);
  if (interactionDay !== today) return { ok: false, reason: 'no_interaction' };
  if (isWeekend(now, timeZone)) return { ok: false, reason: 'weekend' };

  const seconds = Math.floor(toMillis(now) / 1000);
  const last = Number(lastChatAt);
  if (Number.isFinite(last) && last > 0 && seconds - last < CHAT_COOLDOWN_DAYS * DAY_SECONDS) {
    return { ok: false, reason: 'cooldown' };
  }

  const times = Array.isArray(sentTimes)
    ? sentTimes.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const todayCount = times.filter((value) => zonedDayKey(value * 1000, timeZone) === today).length;
  if (todayCount >= CHAT_DAILY_CAP) return { ok: false, reason: 'daily_cap' };

  const weekFloor = seconds - 7 * DAY_SECONDS;
  const weekCount = times.filter((value) => value >= weekFloor).length;
  if (weekCount >= CHAT_WEEKLY_CAP) return { ok: false, reason: 'weekly_cap' };

  return { ok: true, reason: 'ok' };
}

/**
 * 构造闲聊提示词。
 *
 * @param {{card?: object, recentTopics?: Array<{title?: string, summary?: string}>,
 *          recallSummary?: string, messageCount?: number}} input
 * @returns {string}
 */
export function buildChatPrompt({
  card = {},
  recentTopics = [],
  recallSummary = '',
  messageCount = CHAT_MAX_SENTENCES - 2,
} = {}) {
  const name = typeof card.name === 'string' && card.name.trim() !== '' ? card.name.trim() : '珞然';
  const address = typeof card.address === 'string' && card.address.trim() !== ''
    ? card.address.trim()
    : '你';
  const style = card.tone?.style ?? '简洁';
  const warmth = card.tone?.warmth ?? '温和';
  const structure = card.tone?.structure ?? '先结论';
  const banned = Array.isArray(card.bannedPhrases) ? card.bannedPhrases.join('、') : '';
  const topics = recentTopics
    .map((topic) => [topic?.title, topic?.summary].filter((value) => typeof value === 'string' && value.trim() !== '').join('：'))
    .filter((value) => value !== '')
    .slice(0, 5);
  const count = Math.min(CHAT_MAX_SENTENCES, Math.max(CHAT_MIN_SENTENCES, Number(messageCount) || 8));

  return [
    `你是用户的私人助手${name}，称呼用户为「${address}」。`,
    `语气：${style}、${warmth}、${structure}。`,
    '写一条主动的轻量闲聊：像熟悉的朋友顺口说几句，不要汇报工作，不要列清单。',
    `硬性要求：正好 ${count} 个完整句子；只输出正文；不要提问、不要要求用户回应、不要用问号；不要提「根据记忆」「系统」等字眼；不要重复隐私细节。`,
    banned === '' ? '' : `禁用表达：${banned}。`,
    topics.length === 0 ? '最近话题：无。' : `最近话题：\n- ${topics.join('\n- ')}`,
    recallSummary === '' ? '相关记忆：无。' : `相关记忆（可自然化用，不要逐条复述）：\n${recallSummary}`,
  ].filter((line) => line !== '').join('\n');
}

/**
 * 清洗模型输出：去掉问句、违禁词；只接受 5..10 个陈述句。
 *
 * @param {string} text
 * @param {{bannedPhrases?: string[]}} [options]
 * @returns {{ok: boolean, text: string, sentences: number, reason: string}}
 */
export function normalizeChatText(text, { bannedPhrases = [] } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { ok: false, text: '', sentences: 0, reason: 'empty' };

  const banned = (Array.isArray(bannedPhrases) ? bannedPhrases : [])
    .filter((phrase) => typeof phrase === 'string' && phrase.trim() !== '')
    .find((phrase) => raw.includes(phrase));
  if (banned !== undefined) {
    return { ok: false, text: '', sentences: 0, reason: 'banned_phrase' };
  }

  const sentences = (raw.match(SENTENCE_PATTERN) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
    .filter((sentence) => !sentence.endsWith('?') && !sentence.endsWith('？'))
    .slice(0, CHAT_MAX_SENTENCES);

  if (sentences.length < CHAT_MIN_SENTENCES) {
    return { ok: false, text: '', sentences: sentences.length, reason: 'too_few_sentences' };
  }

  const normalized = sentences
    .map((sentence) => (/[。！!]$/u.test(sentence) ? sentence : `${sentence}。`))
    .join('');
  return { ok: true, text: normalized, sentences: sentences.length, reason: 'ok' };
}
