/**
 * e2e 共用场景数据（t12 要求：验收测试不得重复定义场景数据）。
 *
 * 这里只放「场景输入」——固定时钟、历史条目、召回条目、V15 草稿；
 * 具体断言仍留在各自的测试文件里，避免测试之间互相耦合。
 */

/** 每条历史 100 字 = 50 token（assemble 的 estimateTokens 为 ceil(字数/2)）。 */
export const BUDGET_HISTORY_CHARS = 100;
export const BUDGET_HISTORY_TOKENS = 50;
export const BUDGET_DAY_MS = 86_400_000;

/** V10/V16 固定时钟：装配只应依赖输入，不应读取真实时间。 */
export const BUDGET_NOW = Object.freeze({
  epoch: Date.parse('2026-11-03T20:00:00.000+08:00'),
  iso: '2026-11-03T20:00:00.000+08:00',
});

/**
 * 由固定时钟推导日期字符串。
 * @param {number} offset 相对 TODAY 的天数偏移
 * @returns {string} YYYY-MM-DD
 */
export function budgetDayOf(offset) {
  return new Date(BUDGET_NOW.epoch + offset * BUDGET_DAY_MS).toISOString().slice(0, 10);
}

/**
 * 生成 count 条历史消息，每条默认 100 字 = 50 token。
 * @param {number} count
 * @param {number} [chars]
 * @param {string} [prefix]
 * @returns {Array<{role:string, content:string}>}
 */
export function makeBudgetHistory(count, chars = BUDGET_HISTORY_CHARS, prefix = '第') {
  return Array.from({ length: count }, (_unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}${index}条`.padEnd(chars, '历').slice(0, chars),
  }));
}

/**
 * 生成一条召回候选。
 * @param {{id:string, score:number, chars?:number, retention?:number}} input
 */
export function makeBudgetRecallItem({ id, score, chars = 400, retention = 0 }) {
  return {
    id,
    kind: 'fact',
    date: budgetDayOf(-Number(id.replace(/\D/gu, '') || 0)),
    score,
    // 模拟记忆强度 R：assemble 不读它，弱项不得因此挤掉强项。
    retention,
    text: `${id}：${'记'.repeat(Math.max(0, chars - id.length - 1))}`,
  };
}

/** V10 主场景默认分数（刻意乱序）。 */
export const BUDGET_SCORES = Object.freeze([
  0.3, 0.9, 0.1, 0.7, 0.5, 0.2, 0.8, 0.4, 0.05, 0.6, 0.15, 0.75,
]);

/**
 * V10 主场景：900 条历史（45,000 token）+ 12 条乱序召回。
 * @returns {{now:typeof BUDGET_NOW, history:Array, recallItems:Array, boardText:string, userInput:string}}
 */
export function makeBudgetScenario() {
  return {
    now: BUDGET_NOW,
    history: makeBudgetHistory(900),
    recallItems: BUDGET_SCORES.map((score, index) => makeBudgetRecallItem({
      id: `r${index}`,
      score,
    })),
    boardText: `当前局面：${'板'.repeat(395)}`,
    userInput: '今天先把预算装配跑通。',
  };
}

/** V15 时间/序号常量。 */
export const WRITE_FAIL_DAY = 86_400;
export const WRITE_FAIL_BASE = 1_700_000_000;
export const WRITE_FAIL_SEQ_FROM = 31;
export const WRITE_FAIL_SEQ_TO = 42;

/**
 * V15 合法草稿：1 episode + 2 facts + 1 reminder。
 * @returns {object}
 */
export function makeWriteFailDraft() {
  return {
    episode: {
      title: 'V15 事务演练',
      summary: '用户确认了咖啡偏好，并讨论把记忆落到 SQLite。',
      topics: ['测试', '事务'],
      started_at: WRITE_FAIL_BASE,
    },
    facts: [
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '偏好',
        object_text: '黑咖啡',
        statement: '用户偏好黑咖啡',
      },
      {
        kind: 'project',
        subject_text: 'dsh-companion',
        predicate: '使用',
        object_text: 'SQLite',
        statement: 'dsh-companion 使用 SQLite 存储',
      },
    ],
    reminders: [
      {
        kind: 'todo',
        title: '复盘 V15 事务回滚',
        due_at: WRITE_FAIL_BASE + WRITE_FAIL_DAY,
        due_granularity: 'day',
      },
    ],
  };
}
