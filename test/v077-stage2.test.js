/**
 * v0.7.7 阶段 2（L120 记忆质量）：巩固/提醒/周报侧的行为锁定。
 *
 * 覆盖面（对应任务书验收单 ①②④⑤⑥）：
 *   ① L120-H1①：surface 层注入消息不进 region.text、tokens 照常累加；
 *      `selectExistingFactsFromRegion` 见 [相关记忆] 不再整段放弃候选。
 *   ② L120-H1②：写库前近似查重（≥0.85 只强化；0.5–0.85 交一次模型判定，
 *      same/update/new/抛错四条分支）。
 *   ④ L120-H3a/b/d：状态码/进度/临时路径/命令输出不进 project/knowledge；
 *      project+knowledge 单次上限；mood 草稿事实只进 episode。
 *   ⑤ L120-H4 + M2：助手自己的下一步不写提醒；同义提醒不重复写。
 *   ⑥ L120-L1：`/记忆 周报` 的数字与库内真实行数一致。
 *   附加（阶段 1 追补）：区间只有注入消息时直接记 empty，不调模型。
 *
 * ⚠️ 数据来源：50041 云端 surface 快照尚未到达，本文件全部使用构造数据；
 * 真快照到达后应替换回放用例（见 test/v077-stage2.test.js 末节注释）。
 * ⚠️ 模型调用全部是 mock（非真机证据）：这里只锁插件的判定与写库口径。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import {
  consolidate,
  buildConsolidationPrompt,
  isAssistantSelfActionReminder,
  isEphemeralFactText,
  selectExistingFactsFromRegion,
} from '../src/memory/consolidate.js';
import { jaccard, textBigrams } from '../src/memory/similarity.js';
import { buildWeeklyMemoryReport } from '../src/memory/weekly-report.js';
import { planRegion } from '../src/session/surface.js';

const NOW = 1_790_000_000; // 固定时钟，不读真实时间
const DAY = 86_400;

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

/**
 * 一条 planRegion 用的索引记录。
 * @param {{seq: number, role: string, text: string, tokens?: number,
 *          sourceKind?: string|null}} input
 */
function record({ seq, role, text, tokens = 1, sourceKind = null }) {
  return { seq, role, text, tokens, toolDelta: 0, sourceKind };
}

/**
 * planRegion 的尾部预算读 `nodes[index].tokens`，平铺 records 必须同步造 nodes。
 * @param {object[]} records
 */
function snapshotOf(records) {
  return {
    seqs: records.map((row) => row.seq),
    records,
    nodes: records.map((row) => ({ seq: row.seq, role: row.role, tokens: row.tokens })),
    tokens: records.map((row) => row.tokens),
  };
}

/** 造一条活跃事实。 */
function seedFact(store, input) {
  return store.insertFact({
    kind: 'preference',
    subject_text: '用户',
    predicate: '喜欢',
    object_text: '手冲咖啡',
    statement: '用户喜欢手冲咖啡。',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: NOW,
    last_reinforced_at: NOW,
    ...input,
  });
}

/** 单条事实的草稿。 */
function draftWith(facts, reminders = []) {
  return { episode: null, facts, reminders };
}

// ---------------------------------------------------------------- ① surface

describe('L120-H1①：注入消息不进选区正文', () => {
  test('companion-recall 记录不拼进 region.text，但 tokens 与 count 照常算', () => {
    const records = [
      record({ seq: 1, role: 'user', text: '我上次说的咖啡机是什么型号？' }),
      record({
        seq: 2,
        role: 'user',
        text: '[相关记忆]\n用户喜欢手冲咖啡\n[/相关记忆]',
        sourceKind: 'companion-recall',
      }),
      record({ seq: 3, role: 'assistant', text: '德龙 EC685。' }),
      record({ seq: 4, role: 'user', text: '对，就它。' }),
    ];
    const region = planRegion(snapshotOf(records), { afterSeq: 0, budgetTokens: 1 });
    assert.ok(region.region, '应选出区间');
    assert.equal(region.region.injected, 1, 'count 一行注入被剔除');
    assert.doesNotMatch(region.region.text, /相关记忆/u, '注入正文不得进入选区文本');
    assert.match(region.region.text, /咖啡机/u);
    assert.match(region.region.text, /德龙/u);
    assert.equal(region.region.count, 3, 'count 仍是节点数（含被剔除的注入）');
    assert.equal(region.region.tokens, 3, 'tokens 照常累加（预算/压缩口径不变）');
  });

  test('普通用户消息（无 sourceKind）不会被误剔', () => {
    const records = [
      record({ seq: 1, role: 'user', text: '普通发言' }),
      record({ seq: 2, role: 'assistant', text: '回复' }),
      record({ seq: 3, role: 'user', text: '尾部' }),
    ];
    const region = planRegion(snapshotOf(records), { afterSeq: 0, budgetTokens: 1 });
    assert.equal(region.region.injected, 0);
    assert.match(region.region.text, /普通发言/u);
  });

  test('见 [相关记忆] 不再整段放弃候选：候选非空，且不含快照正文里的假事实', (t) => {
    const store = openStore(t);
    const fact = seedFact(store, {});
    const regionText = [
      'user: 我还是喜欢手冲咖啡，用户喜欢手冲咖啡这事没变',
      'user: [相关记忆]',
      'user: 用户喜欢手冲咖啡',
      'user: [/相关记忆]',
      'assistant: 记下了。',
    ].join('\n');
    const rows = selectExistingFactsFromRegion(store, 'main', regionText, []);
    assert.ok(rows.length >= 1, '带召回快照的区间仍应给出候选（改 gate 前这里是 []）');
    assert.ok(rows.some((row) => row.id === fact.id));
  });

  test('压缩摘要 gate 仍然保留（<compacted-summary> 不给候选）', (t) => {
    const store = openStore(t);
    seedFact(store, {});
    const rows = selectExistingFactsFromRegion(
      store,
      'main',
      'user: <compacted-summary>用户喜欢手冲咖啡</compacted-summary>',
      [],
    );
    assert.deepEqual(rows, []);
  });
});

// ---------------------------------------------------------------- ② 写库查重

describe('L120-H1②：写库前近似查重', () => {
  test('Jaccard ≥ 0.85：不新增行，只强化旧条', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, { statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆。' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喜欢喝',
      object_text: '手冲咖啡',
      statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆子。',
    };
    const score = jaccard(textBigrams(existing.statement), textBigrams(draft.statement));
    assert.ok(score >= 0.85, `构造必须落在 ≥0.85 档（实际 ${score.toFixed(3)}）`);

    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我还是喜欢手冲咖啡，每天早上自己磨豆子。',
      llm: () => draftWith([draft]),
    });
    assert.equal(result.facts, 0, '不应新写事实');
    assert.equal(result.dedupe.same, 0, '≥0.85 档不走模型判定');
    const facts = store.listFacts({ scope: 'main', limit: 10 });
    assert.equal(facts.length, 1, '库里仍只有一条');
    const after = store.getFact(existing.id);
    assert.ok(after.recall_count > existing.recall_count, '旧条被强化（recall_count 增加）');
  });

  test('0.5–0.85 档：judge=same → 只强化，不写新行', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, { statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆。' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喜欢喝',
      object_text: '手冲咖啡',
      statement: '用户爱喝手冲咖啡，早上自己磨豆子喝。',
    };
    const score = jaccard(textBigrams(existing.statement), textBigrams(draft.statement));
    assert.ok(score >= 0.5 && score < 0.85, `构造必须落在 0.5–0.85 档（实际 ${score.toFixed(3)}）`);
    let prompts = 0;
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我喝咖啡偏爱手冲，早上自己磨豆。',
      llm: () => draftWith([draft]),
      judge: () => {
        prompts += 1;
        return { items: [{ index: 1, verdict: 'same' }] };
      },
    });
    assert.equal(prompts, 1, 'ask 档只合成一次模型判定');
    assert.equal(result.dedupe.same, 1);
    assert.equal(result.facts, 0);
    assert.equal(store.listFacts({ scope: 'main', limit: 10 }).length, 1);
    assert.equal(store.getFact(existing.id).status, 'active');
  });

  test('0.5–0.85 档：judge=update → 写新行并 supersede 旧行', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, { statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆。' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喜欢喝',
      object_text: '手冲咖啡',
      statement: '用户爱喝手冲咖啡，早上自己磨豆子喝。',
    };
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我喝咖啡偏爱手冲，早上自己磨豆。',
      llm: () => draftWith([draft]),
      judge: () => ({ items: [{ index: 1, verdict: 'update' }] }),
    });
    assert.equal(result.dedupe.update, 1);
    assert.equal(result.facts, 1);
    const old = store.getFact(existing.id);
    assert.equal(old.status, 'superseded');
    const facts = store.listFacts({ scope: 'main', limit: 10 });
    const fresh = facts.find((row) => row.id !== existing.id);
    assert.ok(fresh, '应写入新行');
    assert.equal(old.superseded_by, fresh.id, '旧行指向新行');
  });

  test('0.5–0.85 档：judge=new → 两条并存', async (t) => {
    const store = openStore(t);
    seedFact(store, { statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆。' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喜欢喝',
      object_text: '手冲咖啡',
      statement: '用户爱喝手冲咖啡，早上自己磨豆子喝。',
    };
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我喝咖啡偏爱手冲，早上自己磨豆。',
      llm: () => draftWith([draft]),
      judge: () => ({ items: [{ index: 1, verdict: 'new' }] }),
    });
    assert.equal(result.dedupe.repl, 1);
    assert.equal(store.listFacts({ scope: 'main', limit: 10 }).length, 2);
  });

  test('判定抛错：整批按 new 保守写入并计数，不吞掉本次巩固', async (t) => {
    const store = openStore(t);
    seedFact(store, { statement: '用户喜欢喝手冲咖啡，每天早上自己磨豆。' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喜欢喝',
      object_text: '手冲咖啡',
      statement: '用户爱喝手冲咖啡，早上自己磨豆子喝。',
    };
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我喝咖啡偏爱手冲，早上自己磨豆。',
      llm: () => draftWith([draft]),
      judge: () => {
        throw new Error('judge timeout');
      },
    });
    assert.equal(result.dedupe.failed, 1);
    assert.equal(result.facts, 1, '保守写入');
    assert.equal(store.listFacts({ scope: 'main', limit: 10 }).length, 2);
  });
});

// ---------------------------------------------------------------- ④ H3 降量

describe('L120-H3：抽取降量', () => {
  test('isEphemeralFactText：状态码/进度/临时路径/命令输出判过程状态，生活类不拦', () => {
    assert.equal(isEphemeralFactText({ kind: 'project', statement: '接口返回 HTTP 200，正常。' }), true);
    assert.equal(isEphemeralFactText({ kind: 'knowledge', statement: '训练进度 45/100 步。' }), true);
    assert.equal(isEphemeralFactText({ kind: 'project', statement: '日志写到 C:\\Temp\\out.json' }), true);
    assert.equal(isEphemeralFactText({ kind: 'project', statement: '命令执行完 exit code 0。' }), true);
    assert.equal(isEphemeralFactText({ kind: 'project', statement: '项目零依赖，只要求 Node 24。' }), false);
    // 生活类按计划不拦：百分比/步数在生活事实里是正当内容。
    assert.equal(isEphemeralFactText({ kind: 'lifestyle', statement: '体脂率 18% 了。' }), false);
    assert.equal(isEphemeralFactText({ kind: 'mood', statement: '状态码 200 心情好。' }), false);
  });

  test('一次巩固里只留长期结论：过程状态与 mood 草稿事实都被丢弃', async (t) => {
    const store = openStore(t);
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 5,
      now: NOW,
      regionText: 'user: 跑完训练了，日志在 C:\\Temp\\out.json',
      llm: () => draftWith([
        { kind: 'project', subject_text: '接口', predicate: '返回', object_text: 'HTTP 200', statement: '接口返回 HTTP 200。' },
        { kind: 'knowledge', subject_text: '训练', predicate: '进度', object_text: '45/100', statement: '训练进度 45/100 步。' },
        { kind: 'project', subject_text: '日志', predicate: '位置', object_text: 'C:\\Temp\\out.json', statement: '日志在 C:\\Temp\\out.json。' },
        { kind: 'project', subject_text: '命令', predicate: '退出码', object_text: '0', statement: '命令 exit code 0。' },
        { kind: 'project', subject_text: 'dsh-companion', predicate: '依赖', object_text: '零第三方依赖', statement: '插件零第三方依赖。' },
        { kind: 'mood', subject_text: '用户', predicate: '此刻', object_text: '轻松', statement: '用户此刻想聊轻松点。' },
      ]),
    });
    assert.equal(result.dropped.ephemeral, 4, '四条过程状态被拦');
    assert.equal(result.dropped.mood, 1, 'mood 草稿事实只进 episode');
    assert.equal(result.facts, 1, '只留长期结论');
    const [fact] = store.listFacts({ scope: 'main', limit: 10 });
    assert.match(fact.statement, /零第三方依赖/u);
  });

  test('project+knowledge 单次上限（默认 5）：超出丢尾部并计数', async (t) => {
    const store = openStore(t);
    const facts = Array.from({ length: 7 }, (_, index) => ({
      kind: 'project',
      subject_text: `模块${index}`,
      predicate: '职责',
      object_text: `职责${index}`,
      statement: `模块${index}负责职责${index}的长期结论。`,
    }));
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 5,
      now: NOW,
      regionText: 'user: 过一遍七个模块。',
      llm: () => draftWith(facts),
    });
    assert.equal(result.facts, 5);
    assert.equal(result.dropped.capped, 2);
  });

  test('maxProjectFacts 可配：0 表示不写工程类事实', async (t) => {
    const store = openStore(t);
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 5,
      now: NOW,
      maxProjectFacts: 0,
      regionText: 'user: 过一下项目。',
      llm: () => draftWith([
        { kind: 'project', subject_text: 'a', predicate: 'b', object_text: 'c', statement: '项目 a 的结论。' },
        { kind: 'preference', subject_text: '用户', predicate: '喜欢', object_text: '茶', statement: '用户喜欢喝茶。' },
      ]),
    });
    assert.equal(result.facts, 1, '只剩 preference');
    assert.equal(result.dropped.capped, 1);
  });

  test('提示词写入 H3/H4 口径（一次性状态、上限、瞬时状态、提醒两类）', () => {
    const prompt = buildConsolidationPrompt({
      scope: 'main',
      seqFrom: 1,
      seqTo: 9,
      regionText: 'user: 跑完训练了。',
      existingFacts: [],
    });
    assert.match(prompt, /不要记录一次性的过程状态/u);
    assert.match(prompt, /project 与 knowledge 类事实最多 5 条/u);
    assert.match(prompt, /瞬时状态/u);
    assert.match(prompt, /只为两类记 reminders/u);
  });
});

// ---------------------------------------------------------------- ⑤ H4 + M2

describe('L120-H4/M2：提醒只记用户的事、同义不重复', () => {
  test('isAssistantSelfActionReminder：助手自己的下一步被认出，用户的事不误拦', () => {
    assert.equal(isAssistantSelfActionReminder({ title: '回答助手能否区分QQ和微信消息' }), true);
    assert.equal(isAssistantSelfActionReminder({ title: '重启 dsh web 服务' }), true);
    assert.equal(isAssistantSelfActionReminder({ title: '查看本次训练结果' }), true);
    assert.equal(isAssistantSelfActionReminder({ title: '周五给老板交周报' }), false);
    assert.equal(isAssistantSelfActionReminder({ title: '明早提醒我吃药' }), false);
  });

  test('草稿提醒：助手自己的下一步被丢，用户的事保留', async (t) => {
    const store = openStore(t);
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 你等会儿记得回答我那个问题；周五我得给老板交周报。',
      llm: () => draftWith([], [
        { kind: 'todo', title: '回答助手能否区分QQ和微信消息' },
        { kind: 'todo', title: '重启 dsh web 服务' },
        { kind: 'commitment', title: '周五给老板交周报' },
      ]),
    });
    assert.equal(result.dropped.selfAction, 2);
    assert.equal(result.reminders, 1);
    const rows = store.listReminders({ scope: 'main', status: 'pending', limit: 10 });
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /周报/u);
  });

  test('同义提醒（标题 Jaccard ≥0.8）不再重复写', async (t) => {
    const store = openStore(t);
    store.insertReminder({ scope: 'main', kind: 'todo', title: '周五给老板交周报', status: 'pending' });
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 别忘了周五给老板交周报。',
      llm: () => draftWith([], [{ kind: 'todo', title: '周五给老板交周报' }]),
    });
    assert.equal(result.dropped.duplicate, 1);
    assert.equal(result.reminders, 0);
    assert.equal(store.listReminders({ scope: 'main', limit: 10 }).length, 1);
  });
});

// ---------------------------------------------------------------- 附加：empty

describe('C120-M3 追补：区间只有注入消息时直接记 empty', () => {
  test('全是召回/提醒注入 → 不调模型，写 status=empty 并推进游标', async (t) => {
    const store = openStore(t);
    let calls = 0;
    const regionText = [
      'user: [相关记忆]',
      'user: 用户喜欢手冲咖啡',
      'user: [/相关记忆]',
      'user: [提醒] 喝水',
      'user: [情绪] 平静',
    ].join('\n');
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 4,
      now: NOW,
      regionText,
      llm: () => {
        calls += 1;
        return draftWith([]);
      },
    });
    assert.equal(calls, 0, '不该调模型');
    assert.equal(result.empty, true);
    assert.equal(result.upto_seq, 4);
    assert.deepEqual(store.consolidationStatusCounts('main'), { empty: 1 });
    assert.equal(store.getWatermark('main'), 4);
  });
});

// ---------------------------------------------------------------- ⑥ 周报

describe('L120-L1：/记忆 周报 直接出数', () => {
  test('各段计数与库内真实行数一致', (t) => {
    const store = openStore(t);
    const recent = NOW - DAY;
    const older = NOW - 10 * DAY;
    // 事实：本周新增 2 条（含 1 条 pinned），另 1 条是旧事实、1 条本周被改写。
    const pinned = seedFact(store, {
      kind: 'identity',
      subject_text: '用户',
      predicate: '名字',
      object_text: '阿岚',
      statement: '用户叫阿岚。',
      salience: 'pinned',
      observed_at: recent,
      last_reinforced_at: recent,
    });
    seedFact(store, {
      kind: 'project',
      subject_text: 'dsh-companion',
      predicate: '版本',
      object_text: '0.7.7',
      statement: '插件版本 0.7.7。',
      observed_at: recent,
      last_reinforced_at: recent,
    });
    seedFact(store, {
      kind: 'knowledge',
      subject_text: '蓝鲸',
      predicate: '是',
      object_text: '海洋哺乳动物',
      statement: '蓝鲸是海洋哺乳动物。',
      observed_at: older,
      last_reinforced_at: older,
    });
    const superseded = seedFact(store, {
      kind: 'preference',
      subject_text: '用户',
      predicate: '喝',
      object_text: '速溶',
      statement: '用户喝速溶咖啡。',
      observed_at: older,
      last_reinforced_at: older,
    });
    store.updateFact(superseded.id, { status: 'superseded' });
    // updateFact 的 updated_at 走真实时钟，这里回写成本周内，窗口谓词才可测。
    store.db.prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run(recent, superseded.id);
    // 情景：1 条本周、1 条上周。
    store.insertEpisode({
      scope: 'main',
      session_id: 'main',
      title: '聊了咖啡',
      summary: '用户说了手冲偏好。',
      started_at: recent,
      domain: 'life',
    });
    store.insertEpisode({
      scope: 'main',
      session_id: 'main',
      title: '旧情景',
      summary: '很久以前。',
      started_at: older,
      domain: 'work',
    });
    // 提醒：1 pending、1 expired 未告知。
    store.insertReminder({ scope: 'main', kind: 'todo', title: '交周报', status: 'pending' });
    const expired = store.insertReminder({
      scope: 'main',
      kind: 'todo',
      title: '过期的旧事',
      status: 'pending',
    });
    store.expireReminder(expired.id);
    // 巩固：本周 written 1、empty 1、failed 1（另有一条上周的不计入）。
    for (const [index, status] of ['written', 'empty', 'failed'].entries()) {
      store.insertConsolidation({
        scope: 'main',
        session_id: 'main',
        kind: 'nap',
        upto_seq: 100 + index,
        status,
        trigger: 'idle',
        started_at: recent,
      });
    }
    store.insertConsolidation({ scope: 'main', session_id: 'main', kind: 'nap', upto_seq: 200, status: 'written', trigger: 'idle', started_at: older });

    const { text, counts } = buildWeeklyMemoryReport({
      store,
      scope: 'main',
      timeZone: 'Asia/Shanghai',
      now: NOW,
    });

    assert.equal(counts.factsTotal, 4, 'superseded 也计入总数');
    assert.equal(counts.factsByStatus.active, 3);
    assert.equal(counts.factsByStatus.superseded, 1);
    assert.equal(counts.factsByKind.project, 1);
    assert.equal(counts.factsByKind.knowledge, 1);
    assert.equal(counts.newFactsWeek, 2, '滚动 7 天内新增 2 条');
    assert.equal(counts.supersededWeek, 1);
    assert.equal(counts.episodesTotal, 2);
    assert.equal(counts.episodesWeek, 1);
    assert.equal(counts.pinned, 1, 'salience=pinned 记 1 条');
    assert.equal(counts.remindersByStatus.pending, 1);
    assert.equal(counts.remindersByStatus.expired, 1);
    assert.equal(counts.unnotifiedExpired, 1);
    assert.deepEqual(counts.consolidationsWeek, { written: 1, empty: 1, failed: 1 });

    // 文本与数字一致（实现方在报告里就不再估算）。
    assert.match(text, /rolling|滚动 7 天/u);
    assert.match(text, new RegExp(`本周新增事实：2 条`, 'u'));
    assert.match(text, /本周巩固：written=1 · empty=1 · failed=1/u);
    assert.match(text, /pinned 事实：1 条/u);
    assert.ok(store.getFact(pinned.id).status === 'active');
  });
});
