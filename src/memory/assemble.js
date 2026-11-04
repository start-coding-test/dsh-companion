/**
 * 32K 工作记忆装配（05-架构设计.md §2.4、§3.1；06-记忆系统设计.md §7）。
 *
 * 纯函数、无平台依赖：输入 system 段、状态板文本、召回、最近对话与本轮输入，
 * 输出可直接注册/发送的结构，并在超预算时按设计顺序裁切：
 *   1) 先按 score 升序丢召回（可裁到 0）；
 *   2) 仍超则从最旧删最近对话，但保留最后 ≥ retainTokens（默认 6,144）；
 *   3) 人格段、状态板、本轮 user 输入永不裁切；
 *   4) 全部裁完仍超才置 overBudget=true。
 *
 * token 估算统一为 estimateTokens(text)=Math.ceil([...text].length/2)，
 * 与插件其它模块共用同一口径（中文约 2 字符/token）。
 */

import { boardSection } from '../persona/sections.js';

/** 装配默认预算（与 05 §2.4 / 06 §7 对齐）。 */
export const DEFAULT_LIMITS = Object.freeze({
  workingMemoryTokens: 32000,
  retainTokens: 6144,
  boardTokens: 800,
  recallTokens: 2050,
  summaryTokens: 1000,
});

/**
 * 估算文本 token 数（中文约 2 字符/token）。空文本为 0。
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil([...String(text ?? '')].length / 2);
}

/**
 * 装配本轮工作记忆。
 *
 * @param {object} input
 * @param {Array<{name:string, order:number, text:string}>} [input.sections] system 静态段
 * @param {string} [input.boardText] 已渲染的状态板正文（空则不出段）
 * @param {Array<object>} [input.recallItems] 召回项（需含 text/content 与 score，可选 id/kind/date）
 * @param {Array<object|string>} [input.history] 最近对话（role + content/text；按时间从旧到新）
 * @param {string} [input.userInput] 本轮用户原文
 * @param {Partial<typeof DEFAULT_LIMITS>} [input.limits] 预算覆盖
 * @returns {{
 *   sections: Array<{name:string, order:number, text:string}>,
 *   board: {name:string, order:number, text:string}|null,
 *   messages: Array<{role:string, content:Array<{type:'text', text:string}>}>,
 *   layers: {persona:number, board:number, recall:number, history:number, input:number},
 *   tokens: {total:number, limit:number},
 *   dropped: {recall:Array<object>, history:Array<object|string>},
 *   overBudget: boolean
 * }}
 */
export function assemble({
  sections = [],
  boardText = '',
  recallItems = [],
  history = [],
  userInput = '',
  limits = {},
} = {}) {
  if (!Array.isArray(sections)) throw new TypeError('assemble: sections must be an array');
  if (!Array.isArray(recallItems)) throw new TypeError('assemble: recallItems must be an array');
  if (!Array.isArray(history)) throw new TypeError('assemble: history must be an array');

  const budget = normalizeLimits(limits);
  const inputText = String(userInput ?? '');

  // system 段按 order 升序输出；复制后排序，不改调用方数组。
  const sortedSections = sections
    .map((section) => ({ ...section }))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  const boardBody = String(boardText ?? '').trim();
  const board = boardBody === '' ? null : boardSection(boardBody);

  const recallEntries = recallItems.map((item, index) => ({
    item,
    index,
    score: scoreOf(item),
    dropped: false,
  }));
  const historyEntries = history.map((item) => ({
    item,
    tokens: estimateTokens(textOf(item)),
    dropped: false,
  }));

  /** @type {{recall: Array<object>, history: Array<object|string>}} */
  const dropped = { recall: [], history: [] };

  const state = () => computeState({
    sortedSections,
    board,
    recallEntries,
    historyEntries,
    inputText,
  });

  let current = state();

  // 召回自身也有注入上限（默认 2,050），与总预算独立。
  while (current.layers.recall > budget.recallTokens && dropLowestRecall(recallEntries, dropped)) {
    current = state();
  }

  // 阶段 1：先裁召回，分数最低的先走，允许裁到 0。
  while (current.total > budget.workingMemoryTokens && dropLowestRecall(recallEntries, dropped)) {
    current = state();
  }

  // 阶段 2：再从最旧删对话，但保留最后 ≥ retainTokens 的原文。
  while (current.total > budget.workingMemoryTokens) {
    const oldest = historyEntries.find((entry) => !entry.dropped);
    if (!oldest) break;
    if (current.layers.history - oldest.tokens < budget.retainTokens) break;
    oldest.dropped = true;
    dropped.history.push(oldest.item);
    current = state();
  }

  const messages = [
    ...current.activeHistory.map((entry) => toMessage(entry.item)),
    {
      role: 'user',
      content: [{
        type: 'text',
        text: current.recallBlock === '' ? inputText : `${inputText}\n\n${current.recallBlock}`,
      }],
    },
  ];

  return {
    sections: sortedSections,
    board,
    messages,
    layers: current.layers,
    tokens: { total: current.total, limit: budget.workingMemoryTokens },
    dropped,
    overBudget: current.total > budget.workingMemoryTokens,
  };
}

/**
 * @param {object} params
 * @returns {{
 *   layers: {persona:number, board:number, recall:number, history:number, input:number},
 *   total: number,
 *   recallBlock: string,
 *   activeHistory: Array<{item: object|string, tokens: number, dropped: boolean}>
 * }}
 */
function computeState({ sortedSections, board, recallEntries, historyEntries, inputText }) {
  const activeRecall = recallEntries.filter((entry) => !entry.dropped);
  const activeHistory = historyEntries.filter((entry) => !entry.dropped);
  const recallBlock = recallBlockFor(activeRecall);

  const layers = {
    persona: sortedSections.reduce((sum, section) => sum + estimateTokens(section.text), 0),
    board: board === null ? 0 : estimateTokens(board.text),
    recall: estimateTokens(recallBlock),
    history: activeHistory.reduce((sum, entry) => sum + entry.tokens, 0),
    input: estimateTokens(inputText),
  };
  const total = layers.persona + layers.board + layers.recall + layers.history + layers.input;
  return { layers, total, recallBlock, activeHistory };
}

/**
 * 丢掉当前召回中 score 最低的一项（同分时丢较新的，保持确定性）。
 * @param {Array<{item:object, score:number, index:number, dropped:boolean}>} entries
 * @param {{recall: Array<object>}} dropped
 * @returns {boolean} 是否丢掉了一项
 */
function dropLowestRecall(entries, dropped) {
  let target = null;
  for (const entry of entries) {
    if (entry.dropped) continue;
    if (target === null || entry.score < target.score
      || (entry.score === target.score && entry.index > target.index)) {
      target = entry;
    }
  }
  if (target === null) return false;
  target.dropped = true;
  dropped.recall.push(target.item);
  return true;
}

/**
 * 渲染召回块；为空返回空串（不留空标题）。
 * @param {Array<{item:object}>} entries
 * @returns {string}
 */
function recallBlockFor(entries) {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => recallLine(entry.item));
  // V4-L2：成对标记。摘要若原样复述召回块，巩固前可据此整段剔除，
  // 避免注入内容经「压缩摘要 → 巩固」回流成新事实。
  return `[相关记忆]\n${lines.join('\n')}\n[/相关记忆]`;
}

/**
 * 单条召回行：`- (fact #123, 2026-10-21) 文本`。
 * @param {object} item
 * @returns {string}
 */
function recallLine(item) {
  const record = item ?? {};
  const id = record.id ?? record.factId ?? record.episodeId;
  const kind = record.kind ?? record.type ?? 'memory';
  const date = record.date ?? record.createdAt ?? record.created_at;
  const label = [
    String(kind),
    id === undefined || id === null ? '' : ` #${id}`,
    date === undefined || date === null || date === '' ? '' : `, ${date}`,
  ].join('');
  const body = textOf(record).replace(/\s+/gu, ' ').trim();
  return `- (${label}) ${body}`;
}

/**
 * 把历史项规范成平台消息（文本块）。
 * @param {object|string} item
 * @returns {{role:string, content:Array<{type:'text', text:string}>}}
 */
function toMessage(item) {
  if (typeof item === 'string') {
    return { role: 'user', content: [{ type: 'text', text: item }] };
  }
  const role = typeof item?.role === 'string' ? item.role : 'user';
  return { role, content: [{ type: 'text', text: textOf(item) }] };
}

/**
 * 取文本：兼容 string、{text}、{content}、ContentBlock[]。
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((part) => textOf(part)).join('');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return textOf(value.content);
    if (typeof value.summary === 'string') return value.summary;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * @param {unknown} item
 * @returns {number}
 */
function scoreOf(item) {
  const score = item && typeof item === 'object' ? item.score ?? item.relevance : undefined;
  const number = Number(score);
  return Number.isFinite(number) ? number : 0;
}

/**
 * 合并并校验预算。
 * @param {Partial<typeof DEFAULT_LIMITS>} limits
 * @returns {typeof DEFAULT_LIMITS}
 */
function normalizeLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('assemble: limits must be an object');
  }
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`assemble: limits.${key} must be a non-negative finite number`);
    }
  }
  if (merged.workingMemoryTokens <= 0) {
    throw new TypeError('assemble: limits.workingMemoryTokens must be positive');
  }
  return merged;
}
