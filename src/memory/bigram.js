/**
 * 中文 bigram 分词与 FTS5 MATCH 串生成。
 *
 * 目的：SQLite FTS5 的 unicode61 分词器不切分中文，直接把整段汉字当作一个
 * token。这里在入库前把中文切成重叠二元组（bigram），用空格分隔后再交给
 * FTS5；查询词走同一套切分，因此「生日」「我妈」这类两字词都能命中。
 * 文档见 memory/docs/06-记忆系统设计.md §8.3。
 *
 * 规则：
 * - 中文连续段：重叠二元组，如「我妈生日」→ 我妈 / 妈生 / 生日；
 *   单字段落退化为该字本身（配合 toMatchQuery 的前缀查询）。
 * - ASCII 词：整词作为一个 token（小写化），支持 node.js / v3.1 这类写法。
 * - 去重、保持首次出现顺序、最多 512 个 token（防止长文把 FTS 撑爆）。
 * - 输入先做 NFKC 归一化（全角转半角），再小写化。
 *
 * 仅使用 Node 内置能力，零第三方依赖。
 */

/** CJK 统一表意文字（含扩展 A、兼容区）。 */
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
/** ASCII 词：字母/数字，允许内部 . _ - 连接（node.js、v3.1、zh-cn）。 */
const ASCII_WORD = /[a-z0-9]+(?:[._-][a-z0-9]+)*/g;

/** token 上限：512 个 bigram 约覆盖 1000+ 字中文。 */
export const MAX_TOKENS = 512;

/**
 * 把一段文本切成 FTS5 索引用的 token 串（空格分隔）。
 * @param {unknown} text 任意文本；null/undefined 返回空串
 * @returns {string} 空格分隔的 token 串；无 token 时为空串
 */
export function toBigrams(text) {
  if (text === undefined || text === null) return '';
  const source = String(text).normalize('NFKC').toLowerCase();
  if (source.trim() === '') return '';

  /** @type {Map<string, true>} 去重且保持首次出现顺序 */
  const seen = new Map();
  const push = (token) => {
    if (!token || seen.has(token) || seen.size >= MAX_TOKENS) return;
    seen.set(token, true);
  };

  let run = '';
  let runKind = null;
  const flushRun = () => {
    if (run === '') return;
    if (runKind === 'cjk') {
      const chars = [...run];
      if (chars.length === 1) {
        push(chars[0]);
      } else {
        for (let i = 0; i + 1 < chars.length; i += 1) {
          push(chars[i] + chars[i + 1]);
        }
      }
    } else {
      const words = run.match(ASCII_WORD) ?? [];
      for (const word of words) push(word);
    }
    run = '';
  };

  for (const char of source) {
    const kind = CJK_CHAR.test(char) ? 'cjk' : 'other';
    if (runKind !== null && kind !== runKind) flushRun();
    runKind = kind;
    run += char;
    if (seen.size >= MAX_TOKENS) break;
  }
  if (seen.size < MAX_TOKENS) flushRun();

  return [...seen.keys()].slice(0, MAX_TOKENS).join(' ');
}

/**
 * 把查询文本转成 FTS5 MATCH 串：每个 token 加引号并用 AND 连接。
 * 单字符 token 用前缀查询（"生"*），因为索引里存的是二元组。
 * 无有效 token 时返回空串（调用方应直接返回空结果，不能执行 MATCH）。
 * @param {unknown} text 查询文本
 * @returns {string} 形如 `"生日" AND "蛋糕"` 的 MATCH 串
 */
export function toMatchQuery(text) {
  const tokens = toBigrams(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens
    .map((token) => (token.length === 1 ? `"${token}"*` : `"${token}"`))
    .join(' AND ');
}
