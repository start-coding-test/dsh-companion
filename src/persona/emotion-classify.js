/**
 * 情绪事件的规则分类（v0.5.2，V52 清单）。
 *
 * 设计顺序：**先判对象，再判极性，最后收紧边界**。
 * - 对象四类：她（`你`/`您`/卡里的 name）、用户自己（`我`/`俺`/无主语）、
 *   第三方（`他`/`她`/`这个人`/`老板`…）、事物（`这破…`/`工作`/`加班`…）。
 * - 只有「对象是她」且极性为负时才可能是 blame / conflict；其余负面话一律 vent。
 * - 否定与疑问守卫：负面词前 4–5 字内有「不/没/别/甭」时极性反转；
 *   「是不是…我」「我…你了吗」这类问句是用户在担心，走 reassure。
 * - 边界词收紧：`辛苦` 只有「你辛苦了 / 辛苦你 / 辛苦啦」算 thanks；
 *   `哦/行吧/随便/算了` 只在整句 ≤ 4 码点（去标点）时算 cold；
 *   `睡了` 只在句末或「我去/先/准备/要/该」之后算 goodnight；
 *   `烦不烦` 遇到叠词否定（「不烦不烦」）不算 conflict。
 *
 * 纯函数：不读时间、不用随机、不调模型。置信度由规则基线与命中次数决定。
 */

/** 分类器可能返回的标签（`none` 表示无事件；`complain` 已退役，仅用于读旧数据）。 */
export const CLASSIFY_TYPES = Object.freeze([
  'greeting',
  'care',
  'share',
  'thanks',
  'cold',
  'reunion',
  'goodnight',
  'conflict',
  'blame',
  'vent',
  'comfort',
  'reassure',
  'none',
]);

const HER_MARKERS = Object.freeze(['你', '您']);
const SELF_MARKERS = Object.freeze(['我', '俺', '自己', '本人']);
const THIRD_MARKERS = Object.freeze([
  '他', '她', '人家', '这个人', '那人', '别人', '老板', '同事', '领导',
  '朋友', '孩子', '室友', '家里人', '我妈', '我爸',
]);
const THING_MARKERS = Object.freeze([
  '这破', '这个破', '破电脑', '电脑', '系统', '工作', '加班', '项目',
  '需求', '会议', '论文', '考试', '天气', '地铁', '公交', '堵车',
]);

/** 冲着她说的负面词（只有对象是她时才成立）。 */
const INSULT_CUES = Object.freeze(['烦', '讨厌', '笨', '没用', '失望', '恶心', '受不了', '闭嘴', '滚', '敷衍', '冷淡', '凶', '骂', '吵', '闹', '忘', '迟到', '骗', '不理我']);

/** 柔和一点的指责词：同样的对象判定，但置信度更低（「你怎么又忘了」）。 */
const MILD_CUES = Object.freeze(['忘', '迟到', '敷衍', '冷淡']);

/** 明确的敌意句式（不需要额外负面词）。 */
const HOSTILE_PATTERNS = Object.freeze([
  /别管我/u,
  /少管我/u,
  /闭嘴/u,
  /别说了/u,
  /不想跟你说话/u,
  /你根本不懂/u,
  /你错了/u,
  /烦不烦/u,
  /少废话/u,
]);

/** 用户自述或转述的负面状态（对象不是她时归 vent）。 */
const STATE_CUES = Object.freeze([
  '累', '辛苦', '烦', '压力', '难受', '委屈', '撑不住', '扛不住',
  '崩溃', '郁闷', '不开心', '气死', '想哭', '烦死', '疲惫', '焦虑', '心累',
]);

const NEGATION = /(?:不|没|别|甭|无)/u;

/** 否定叠词：「不烦不烦」「不累不累」是安抚，不是敌意。 */
const NEGATED_REDUP = /不(?:烦|累|辛苦|生气)(?:不|也|啦)/u;

/** 「你一点都不烦」「不烦不烦」这类反向安抚。 */
const SOOTHING_NEGATION = /(?:不烦不烦|不累不累|一点都不烦|一点也不烦|才不烦|没烦|不讨厌)/u;

/** 「你是不是…烦我」「我…你了吗」：用户在担心自己惹到她。 */
const REASSURE_QUESTION = /(?:是不是|会不会|有没有|是不是有点|是不是很)[^。！？!?]{0,8}(?:烦|讨厌|嫌|生气)/u;
const REASSURE_SELF_QUESTION = /我[^。！？!?]{0,4}(?:烦|讨厌|嫌|惹)你[^。！？!?]{0,4}(?:吗|吧|么|\?|？)/u;

const THANKS_PATTERN = /(?:谢谢|谢啦|谢了|感谢|多谢)/u;
const THANKS_HARDWORK = /(?:辛苦你|您辛苦|你辛苦了|辛苦啦)/u;

/** 冷淡的短句核（去标点后 ≤4 码点才生效）。`嗯`/`好` 这类应答不算冷淡。 */
const COLD_CORE = /^(?:哦+|哦哦|行吧|好吧|随便|算了|呵呵|切)$/u;

const CARE_PATTERN = /(?:你怎么了|你怎么啦|还好吗|没事吧|要不要紧|注意身体|别太累|别熬夜|早点休息|多喝|照顾好自己)/u;
const COMFORT_PATTERN = /(?:抱抱|抱一下|我在|陪着你|别难过|别担心|会好的)/u;

const REUNION_PATTERN = /(?:好久不见|好久没|很久没|多少年没|这段时间你去|这段时间去哪|这阵子去哪)/u;

const GREETING_PATTERN = /(?:早安|早上好|早啊|早呀|晚上好|午安|在吗|在不在|嗨|哈喽|hello|hi(?=\b|[！!，,。\s]))|(?:^你好(?:啊|呀)?(?=$|[！!，,。？?~～\s]))|(?:^早(?:上)?[！!。，,~～\s]*$)/iu;

const SHARE_PATTERN = /(?:我跟你说|给你说|跟你说|我刚|分享|说个事|今天[^。！？!?]{0,6}(?:去|做|吃|买|见|玩))/u;

const PUNCT = /[，,。．.！!？?；;：:、~～…\-—\s]/gu;

/**
 * 逐句切分（保留句子本身，不保留分隔符）。
 * @param {string} text
 * @returns {string[]}
 */
function segments(text) {
  return text.split(/[。！？!?\n;；]+/u).map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * 判断 index 之前的窗口里是否出现否定词。
 * @param {string} segment
 * @param {number} index
 * @returns {boolean}
 */
function isNegated(segment, index) {
  const window = segment.slice(Math.max(0, index - 5), index);
  // 「不过」「不但」「不仅」是转折/递进连词，不是否定：「谢谢你，不过你好烦」仍是指责。
  const stripped = window.replace(/(?:不过|不但|不仅|不管|不论|不光)/gu, '');
  return NEGATION.test(stripped);
}

/**
 * 找 index 之前最近的对象标记，返回 her / self / third / thing / none。
 * @param {string} segment
 * @param {number} index
 * @returns {'her'|'self'|'third'|'thing'|'none'}
 */
function objectBefore(segment, index) {
  let best = { at: -1, kind: 'none' };
  const consider = (markers, kind) => {
    for (const marker of markers) {
      const at = segment.lastIndexOf(marker, index - 1);
      if (at >= 0 && at > best.at) best = { at, kind };
    }
  };
  consider(HER_MARKERS, 'her');
  consider(SELF_MARKERS, 'self');
  consider(THIRD_MARKERS, 'third');
  consider(THING_MARKERS, 'thing');
  return best.kind;
}

/**
 * 同一句里是否还有「对她的正面」（感谢/关心/安抚）：与对她的负面并存时说明分不出来。
 *
 * @param {string} segment
 * @returns {boolean}
 */
function hasHerPositive(segment) {
  return THANKS_PATTERN.test(segment)
    || THANKS_HARDWORK.test(segment)
    || CARE_PATTERN.test(segment)
    || COMFORT_PATTERN.test(segment);
}

/**
 * 取整句里第一个命中的负面词及其位置。
 * @param {string} segment
 * @param {ReadonlyArray<string>} cues
 * @returns {{cue:string,index:number}|null}
 */
function firstCue(segment, cues) {
  let found = null;
  for (const cue of cues) {
    const index = segment.indexOf(cue);
    if (index < 0) continue;
    if (found === null || index < found.index) found = { cue, index };
  }
  return found;
}

/**
 * 她 + 负面词：命中返回 cue 与是否被否定；对象不是她就返回 null。
 * @param {string} segment
 * @returns {{cue:string,index:number,negated:boolean}|null}
 */
function herInsult(segment) {
  const cue = firstCue(segment, INSULT_CUES);
  if (cue === null) return null;
  const object = objectBefore(segment, cue.index);
  if (object !== 'her') return null;
  return { ...cue, negated: isNegated(segment, cue.index) };
}

/**
 * 敌意句式（对象必须是她或省略主语）。
 * @param {string} segment
 * @returns {boolean}
 */
function hostile(segment) {
  if (NEGATED_REDUP.test(segment)) return false;
  return HOSTILE_PATTERNS.some((pattern) => pattern.test(segment));
}

/**
 * 自述/转述的负面状态：返回命中的 cue（对象不是她时成立）。
 * @param {string} segment
 * @returns {{cue:string,index:number,object:string}|null}
 */
function negativeState(segment) {
  const cue = firstCue(segment, STATE_CUES);
  if (cue === null) return null;
  const object = objectBefore(segment, cue.index);
  if (object === 'her') return null;
  return { ...cue, object };
}

/**
 * count 次命中时的置信度。
 * @param {number} base
 * @param {number} hits
 * @returns {number}
 */
function confidenceOf(base, hits) {
  const raw = Math.min(0.95, base + 0.08 * (hits - 1));
  return Math.round(raw * 100) / 100;
}

/**
 * 对单句分类；返回 null 表示本句不构成事件。
 * @param {string} segment
 * @param {string[]} extraHer 额外的「她」的称呼（卡里的 name）
 * @returns {{type:string,confidence:number,reason:string}|null}
 */
function classifySegment(segment, extraHer) {
  const herMarkers = extraHer.length > 0 ? [...HER_MARKERS, ...extraHer] : HER_MARKERS;
  const hasHer = (index) => {
    let best = { at: -1, kind: 'none' };
    const consider = (markers, kind) => {
      for (const marker of markers) {
        const at = segment.lastIndexOf(marker, index - 1);
        if (at >= 0 && at > best.at) best = { at, kind };
      }
    };
    consider(herMarkers, 'her');
    consider(SELF_MARKERS, 'self');
    consider(THIRD_MARKERS, 'third');
    consider(THING_MARKERS, 'thing');
    return best.kind;
  };

  // 1) 用户在担心自己惹到她：疑问式安抚优先。
  if (REASSURE_QUESTION.test(segment) || REASSURE_SELF_QUESTION.test(segment)) {
    return { type: 'reassure', confidence: 0.7, reason: 'reassure-question' };
  }

  // 2) 明确敌意句式（「烦不烦」要排除「不烦不烦」）。
  if (hostile(segment)) {
    const hits = HOSTILE_PATTERNS.filter((pattern) => pattern.test(segment)).length;
    if (hasHerPositive(segment)) {
      return { type: 'conflict', confidence: 0.45, reason: 'ambiguous' };
    }
    return { type: 'conflict', confidence: confidenceOf(0.78, hits), reason: 'hostile' };
  }

  // 3) 她 + 负面词；被否定时翻转成安抚。
  const insult = herInsultWith(segment, hasHer);
  if (insult !== null) {
    if (insult.negated || SOOTHING_NEGATION.test(segment)) {
      return { type: 'care', confidence: 0.7, reason: 'negated-insult' };
    }
    const mild = MILD_CUES.includes(insult.cue);
    if (hasHerPositive(segment)) {
      // 同一句既有对她的负面又有对她的正面：分不出来，降置信度只记审计。
      return { type: 'blame', confidence: 0.45, reason: 'ambiguous' };
    }
    return {
      type: 'blame',
      confidence: mild ? 0.62 : 0.74,
      reason: mild ? 'mild-blame' : 'blame',
    };
  }
  if (SOOTHING_NEGATION.test(segment)) {
    return { type: 'care', confidence: 0.7, reason: 'soothing' };
  }

  // 4) 感谢 / 辛苦（只有指向她时才算）。
  if (THANKS_PATTERN.test(segment) || THANKS_HARDWORK.test(segment)) {
    return { type: 'thanks', confidence: 0.75, reason: 'thanks' };
  }

  // 5) 冷淡：只在整句 ≤ 4 码点时成立（去标点）。
  const core = segment.replace(PUNCT, '');
  if ([...core].length <= 4 && COLD_CORE.test(core)) {
    return { type: 'cold', confidence: 0.62, reason: 'cold-short' };
  }

  // 6) 晚安：句末，或「我去/先/准备/要/该」之后。
  if (/晚安/u.test(segment) || /明天见$/u.test(segment)
    || /^(?:睡了|睡啦)$/u.test(core)
    || /(?:我去|我|先|准备|要|该)睡了?$/u.test(core)) {
    return { type: 'goodnight', confidence: 0.8, reason: 'goodnight' };
  }

  // 7) 关心 / 安抚。
  if (COMFORT_PATTERN.test(segment)) return { type: 'comfort', confidence: 0.7, reason: 'comfort' };
  if (CARE_PATTERN.test(segment)) return { type: 'care', confidence: 0.72, reason: 'care' };

  // 8) 重逢 / 问候 / 分享。
  if (REUNION_PATTERN.test(segment)) return { type: 'reunion', confidence: 0.74, reason: 'reunion' };
  if (GREETING_PATTERN.test(segment)) return { type: 'greeting', confidence: 0.7, reason: 'greeting' };

  // 9) 负面状态（对象不是她）：用户诉苦、third/thing 抱怨。
  const state = negativeState(segment);
  if (state !== null) {
    return { type: 'vent', confidence: 0.68, reason: `vent:${state.object}` };
  }

  // 10) 分享。
  if (SHARE_PATTERN.test(segment)) return { type: 'share', confidence: 0.64, reason: 'share' };

  return null;
}

/**
 * herInsult 的可注入版本：额外把卡里的 name 当作「她」。
 * @param {string} segment
 * @param {(index:number)=>string} objectAt
 * @returns {{cue:string,index:number,negated:boolean}|null}
 */
function herInsultWith(segment, objectAt) {
  const cue = firstCue(segment, INSULT_CUES);
  if (cue === null) return null;
  if (objectAt(cue.index) !== 'her') return null;
  return { ...cue, negated: isNegated(segment, cue.index) };
}

/**
 * 中文规则分类入口。
 *
 * @param {string} text 用户这一轮的最后一句文本
 * @param {{name?:string}} [options] `name` 是人格卡里的称呼（额外算作「她」）
 * @returns {{type:string, confidence:number, reason?:string}}
 */
export function classify(text, options) {
  if (typeof text !== 'string') {
    throw new TypeError(`classify(text): text must be a string (got ${typeof text})`);
  }
  const trimmed = text.trim();
  if (trimmed === '') return { type: 'none', confidence: 0 };

  let name = '';
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError(`classify(text, options): options must be an object (got ${typeof options})`);
    }
    if (options.name !== undefined && options.name !== null) {
      if (typeof options.name !== 'string') {
        throw new TypeError(`classify(text, options): options.name must be a string (got ${typeof options.name})`);
      }
      name = options.name.trim();
    }
  }
  const extraHer = name === '' || HER_MARKERS.includes(name) ? [] : [name];

  const reasons = [];
  for (const segment of segments(trimmed)) {
    const result = classifySegment(segment, extraHer);
    if (result !== null) reasons.push(result);
  }
  if (reasons.length === 0) return { type: 'none', confidence: 0 };

  // 多句时取优先级最高的那一条：她相关的负面 > 她相关的正面 > 其它。
  const priority = (item) => {
    if (item.type === 'conflict') return 100;
    if (item.type === 'blame') return 90;
    if (item.type === 'reassure') return 80;
    if (item.type === 'care' || item.type === 'comfort' || item.type === 'thanks') return 70;
    if (item.type === 'vent') return 60;
    return 10;
  };
  reasons.sort((left, right) => priority(right) - priority(left));
  const top = reasons[0];

  // 同一句里既有对她的负面、又有对她的正面时，分不出来：降到 0.45（只记录、不加增量）。
  const hasHerNegative = reasons.some((item) => item.type === 'blame' || item.type === 'conflict');
  const hasHerPositive = reasons.some((item) => item.type === 'thanks' || item.type === 'care' || item.type === 'comfort');
  if (hasHerNegative && hasHerPositive) {
    return { type: top.type, confidence: 0.45, reason: 'ambiguous' };
  }

  return top.reason === undefined
    ? { type: top.type, confidence: top.confidence }
    : { type: top.type, confidence: top.confidence, reason: top.reason };
}
