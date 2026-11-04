/**
 * 记忆强化（H5）：遗忘曲线只衰减、不强化 → 这里补「被用上才强化」。
 *
 * 设计口径（外部评审 H5 / 06 §遗忘）：
 *   R  = exp(−Δt / 86400 / S)              —— Δt 为距上次强化的天数
 *   S' = min(3650, S×(1+α×(1−R)) + 1)      —— R 越低（越接近遗忘）强化越多
 *
 * 强化按「是否真的被回复用上」触发（见 index.js 的接线）：
 *   - 上一轮注入过的 fact，若下一轮 assistant 文本复述了它（二元组重合 ≥0.6）
 *     → α=2.0；
 *   - 若本轮 user 文本是短确认语（对/是的/没错/记住了/确实/就是，
 *     整句或独立小句，见 isConfirmation）→ α=4.0。
 *
 * 本模块保持纯函数 + 窄依赖：只依赖 Store 的 reinforceFact 能力，
 * 不做日志、不读时钟（now/at 全部由调用方传入），便于单测与复用。
 */

/** 默认强化系数（用户确认的普通强化）。 */
export const DEFAULT_ALPHA = 2.0;
/** 用户确认后的强化系数。 */
export const CONFIRM_ALPHA = 4.0;
/** 强度天数上限（约 10 年），与设计文档一致。 */
export const MAX_STRENGTH_DAYS = 3650;
/** 「用上」判定阈值：fact 二元组被 assistant 文本覆盖的比例。 */
export const USE_OVERLAP_THRESHOLD = 0.6;

/**
 * N-L1：确认词。只有「短确认语」才算确认（整句/独立小句/带语气短尾），
 * 不能用 `text.includes(word)`——否则「对比一下」「对话」「不对」都会误触发 α=4。
 */
export const CONFIRMATION_WORDS = Object.freeze(['对', '是的', '没错', '记住了', '确实', '就是']);

/** 确认词后允许的语气短尾：「对呀」「没错吧」「记住了啊」。 */
const CONFIRM_TAIL_PARTICLES = new Set(['啊', '呀', '呢', '吧', '哦', '嘛', '哈', '嗯', '啦', '的']);

/**
 * 否定/犹疑标记：命中片段附近出现即不算确认。
 * 判定时先剔除确认词本身，避免把「没错」里的「没」「错」当成否定。
 */
const CONFIRM_NEGATION = /不|没|别|错|未必/;

/**
 * 句子边界：空白、标点、符号（含中英文标点）。
 * @param {string|undefined} ch
 * @returns {boolean}
 */
function isBoundaryChar(ch) {
  return ch === undefined || /[\s\p{P}\p{S}]/u.test(ch);
}

/**
 * N-L1：判断一段 user 文本是不是「短确认语」。
 *
 * 判定步骤：
 * 1. trim 并去掉句末标点/空白；
 * 2. 确认词必须出现在合法位置，三选一：
 *    a. 整句就是确认词（「对」「记住了。」）；
 *    b. 确认词独立成小句：前后都是边界（「嗯，对，就这样」）；
 *    c. 以确认词开头且紧接边界或 ≤2 个语气短尾（「对，就是这样」「没错吧？」）。
 * 3. 命中片段附近出现 不/没/别/错/未必 → 不算确认（「好像不太对」「对，但是不对」）。
 *
 * 纯函数：不改状态、不读时钟，便于单测与复用。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isConfirmation(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  // 去掉句末标点/符号/空白（保留句中标点作为小句边界）。
  const stripped = trimmed.replace(/[\p{P}\p{S}\s]+$/u, '');
  if (stripped === '') return false;
  const chars = [...stripped];
  if (chars.length === 0) return false;

  for (const word of CONFIRMATION_WORDS) {
    const wordChars = [...word];
    for (let index = 0; index + wordChars.length <= chars.length; index += 1) {
      if (!wordChars.every((ch, offset) => chars[index + offset] === ch)) continue;
      const end = index + wordChars.length;
      // 条件 b：确认词前必须是边界（句首也算）。
      if (index > 0 && !isBoundaryChar(chars[index - 1])) continue;
      // 条件 a/b：后边界；条件 c：句首 + 语气短尾。
      let afterOk = end === chars.length || isBoundaryChar(chars[end]);
      if (!afterOk && index === 0) {
        const tail = chars.slice(end);
        afterOk = tail.length <= 2 && tail.every((ch) => CONFIRM_TAIL_PARTICLES.has(ch));
      }
      if (!afterOk) continue;
      // 否定守卫：只看命中片段之外的部分，避免「没错」被自身字符误伤。
      const around = chars.slice(0, index).join('') + chars.slice(end).join('');
      if (CONFIRM_NEGATION.test(around)) continue;
      return true;
    }
  }
  return false;
}

const DAY_MS = 86_400_000;
/** 秒/毫秒判别阈值（与 retrieve.js 的 toMillis 一致）。 */
const EPOCH_THRESHOLD = 1e11;

/**
 * 秒/毫秒时间戳统一成毫秒；非法值返回 null。
 * @param {unknown} value
 * @returns {number|null}
 */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) < EPOCH_THRESHOLD ? num * 1000 : num;
}

/**
 * 遗忘曲线 R（0..1）。
 *
 * pinned（S 为 null / pinned=true）恒为 1；强度缺失或非正、时间非法时为 0。
 * 时钟回拨（now < last）按 R=1 处理，与 retrieve.forgettingCurve 一致。
 *
 * @param {{strengthDays?: number|null, lastReinforcedAt?: number|Date|null,
 *          now?: number|Date, pinned?: boolean}} [input]
 * @returns {number} [0, 1]
 */
export function decayOf({
  strengthDays,
  lastReinforcedAt,
  now = Date.now(),
  pinned = false,
} = {}) {
  if (pinned) return 1;
  const strength = Number(strengthDays);
  if (!Number.isFinite(strength) || strength <= 0) return 0;
  const at = toMillis(now);
  const last = toMillis(lastReinforcedAt);
  if (at === null || last === null) return 0;
  if (at <= last) return 1;
  const r = Math.exp(-((at - last) / DAY_MS) / strength);
  if (!Number.isFinite(r)) return 0;
  return Math.min(1, Math.max(0, r));
}

/**
 * 强化公式：S' = min(3650, S×(1+α×(1−R)) + 1)。
 *
 * R 缺失/非法按 0（最大强化）处理；α 非法时退回 DEFAULT_ALPHA。
 * 强度非法（非数字/负）返回 0，由调用方按能力约定跳过。
 *
 * @param {{strengthDays: number, R: number, alpha?: number}} input
 * @returns {number} 新强度天数
 */
export function reinforce({ strengthDays, R, alpha = DEFAULT_ALPHA } = {}) {
  const strength = Number(strengthDays);
  if (!Number.isFinite(strength) || strength < 0) return 0;
  let r = Number(R);
  if (!Number.isFinite(r)) r = 0;
  r = Math.min(1, Math.max(0, r));
  let a = Number(alpha);
  if (!Number.isFinite(a) || a < 0) a = DEFAULT_ALPHA;
  const next = strength * (1 + a * (1 - r)) + 1;
  if (!Number.isFinite(next)) return 0;
  return Math.min(MAX_STRENGTH_DAYS, next);
}

/**
 * 在 Store 上执行一次强化。能力约定：
 *   - store 缺行 / 墓碑 / pinned / 非 active → {ok:false, reason}，不抛；
 *   - 其它意外错误 → {ok:false, reason:'error'}，不阻断调用方 turn。
 *
 * @param {{reinforceFact?: Function}} store
 * @param {{scope?: string, factId: string, at?: number|Date,
 *          alpha?: number}} input
 * @returns {{ok: boolean, id?: string, strengthDays?: number,
 *            recallCount?: number, alpha?: number, reason?: string}}
 */
export function applyReinforcement(store, { scope = 'main', factId, at, alpha = DEFAULT_ALPHA } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.reinforceFact !== 'function') {
    throw new TypeError('[reinforce] store must expose reinforceFact()');
  }
  if (typeof factId !== 'string' || factId === '') {
    throw new TypeError('[reinforce] factId must be a non-empty string');
  }
  try {
    return store.reinforceFact({ id: factId, scope, at, alpha });
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 去掉空白与标点/符号，保留文字与数字，避免「8000 元。」与「8000元」错位。
 * @param {unknown} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 字符二元组集合。
 * @param {string} text
 * @returns {Set<string>}
 */
function bigramSet(text) {
  const chars = [...text];
  const set = new Set();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    set.add(`${chars[index]}${chars[index + 1]}`);
  }
  return set;
}

/**
 * 「用上」重合度：fact 文本的二元组被 assistant 文本覆盖的比例（0..1）。
 *
 * 单字 fact（二元组为空）退化为字符覆盖比例；空文本返回 0。
 * 该口径与注入文本无关，纯文本比对，不产生可见 marker。
 *
 * @param {unknown} factText fact.statement
 * @param {unknown} assistantText 上一轮 assistant 文本
 * @returns {number} [0, 1]
 */
export function overlapRatio(factText, assistantText) {
  const fact = normalize(factText);
  const reply = normalize(assistantText);
  if (fact === '' || reply === '') return 0;

  const expected = [...bigramSet(fact)];
  if (expected.length === 0) {
    const replyChars = new Set([...reply]);
    const factChars = [...new Set([...fact])];
    if (factChars.length === 0) return 0;
    let hit = 0;
    for (const char of factChars) if (replyChars.has(char)) hit += 1;
    return hit / factChars.length;
  }

  const actual = bigramSet(reply);
  let hit = 0;
  for (const gram of expected) if (actual.has(gram)) hit += 1;
  return hit / expected.length;
}
