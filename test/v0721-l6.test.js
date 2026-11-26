/**
 * 判别力（删接线必红）：L6-001 先证同 kind bigram Jaccard < dedupeAsk=0.5（原
 * classifyDraftFact 路径判 new、直接 insert），再让另一 kind 的既有事实与草稿共享
 * 关键串 dsh-companion。删掉 upgradeVerdictWithKeyPhrases 包装或删掉
 * keyPhraseIndex 接线后，L6-001 的 judge 调用数从 1 变 0、result.facts 从 0 变 1。
 *
 * v0.7.21 L6：巩固（consolidate）写库前查重复用跨 kind 关键串升级。
 *
 * ⚠️ 非真机证据：judge / LLM 全部是替身；真实小模型裁决质量与生产宿主路由属云端
 * 验收。本文件只锁「巩固路径是否真的把跨 kind 同关键串的 new 草稿送进现有 judge」。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { consolidate } from '../src/memory/consolidate.js';
import {
  buildKeyPhraseIndex, classifyDraftFact, collectActiveFactsByKind,
  upgradeVerdictWithKeyPhrases,
} from '../src/memory/dedupe.js';
import { jaccard, textBigrams } from '../src/memory/similarity.js';

const NOW = 1_790_000_000; // 固定时钟，不读真实时间
const DEDUPE_ASK = 0.5; // 与 DEFAULT_DEDUPE_ASK 同值；本文件不放开这个阈值

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

/** 造一条活跃事实。 */
function seedFact(store, input) {
  return store.insertFact({
    scope: 'main',
    kind: 'preference',
    subject_text: '用户',
    predicate: '相关',
    object_text: null,
    statement: '一条事实',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: NOW,
    last_reinforced_at: NOW,
    ...input,
  });
}

/** 单条事实的草稿。 */
function draftWith(facts) {
  return { episode: null, facts, reminders: [] };
}

/** 当前活跃事实行。 */
function activeFacts(store) {
  return store.listFacts({ scope: 'main', status: 'active', limit: 20 });
}

describe('L6：巩固路径跨 kind 关键串升级（v0.7.21）', () => {
  test('L6-001（v0.7.21 非真机证据）：另一 kind 共享关键串且 bigram<0.5 的草稿升为 ask，judge=same 不新增重复行', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, {
      kind: 'project',
      statement: 'dsh-companion 用 Node 跑服务',
    });
    const draft = {
      kind: 'preference',
      subject_text: 'dsh-companion',
      predicate: '配置',
      object_text: 'ubuntu 用户',
      statement: 'dsh-companion 配了 ubuntu 用户',
    };

    // 判别力前置：原路径（同 kind 比 bigram）必须判 new，即没有 L6 接线时直接 insert。
    const score = jaccard(textBigrams(existing.statement), textBigrams(draft.statement));
    assert.ok(
      score < DEDUPE_ASK,
      `构造必须低于 dedupeAsk=${DEDUPE_ASK}，证明原路径不会 ask（实际 ${score.toFixed(3)}）`,
    );
    const byKind = collectActiveFactsByKind(store, 'main');
    const base = classifyDraftFact(draft, byKind, {});
    assert.equal(base.verdict, 'new', '同 kind 无候选：原路径判 new（直接插入）');
    const index = buildKeyPhraseIndex(byKind);
    const upgraded = upgradeVerdictWithKeyPhrases(draft, base, index);
    assert.equal(upgraded.verdict, 'ask', '跨 kind 关键串命中把 new 升为 ask');
    assert.equal(upgraded.match.id, existing.id);
    assert.equal(String(upgraded.keyPhrase).toLowerCase(), 'dsh-companion');

    const prompts = [];
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: dsh-companion 配了 ubuntu 用户，服务跑得还行。',
      llm: () => draftWith([draft]),
      // 巩固链路的 judge 契约是「已解析对象」，不是工具侧的 JSON 字符串。
      judge: async (prompt) => {
        prompts.push(prompt);
        return { items: [{ index: 1, verdict: 'same' }] };
      },
    });

    assert.equal(prompts.length, 1, '跨 kind 关键串命中必须调用 judge 一次');
    assert.match(prompts[0], /dsh-companion 用 Node 跑服务/u, 'judge 收到既有事实原文');
    assert.match(prompts[0], /dsh-companion 配了 ubuntu 用户/u, 'judge 收到草稿原文');
    assert.equal(result.dedupe.asked, 1, '该草稿进入 same/ask 链');
    assert.equal(result.dedupe.same, 1);
    assert.equal(result.facts, 0, 'judge=same 不新增行');
    assert.equal(activeFacts(store).length, 1, '库里仍只有一条，无重复行');
    assert.equal(store.getFact(existing.id).status, 'active');
    assert.ok(
      store.getFact(existing.id).recall_count > existing.recall_count,
      '旧条被强化（recall_count 增加）',
    );
  });

  test('L6-002（v0.7.21 非真机证据）：无共享关键串的 new 草稿仍按原路径 insert，judge 不被调用', async (t) => {
    const store = openStore(t);
    seedFact(store, { kind: 'lifestyle', statement: '用户养了一只叫团子的猫' });
    const draft = {
      kind: 'preference',
      subject_text: '用户',
      predicate: '每周',
      object_text: '游泳',
      statement: '用户每周三去游泳',
    };
    const score = jaccard(textBigrams('用户养了一只叫团子的猫'), textBigrams(draft.statement));
    assert.ok(score < DEDUPE_ASK, `负例构造也必须 < dedupeAsk（实际 ${score.toFixed(3)}）`);

    let judgeCalls = 0;
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我每周三去游泳，猫在家。',
      llm: () => draftWith([draft]),
      judge: async () => {
        judgeCalls += 1;
        return { items: [{ index: 1, verdict: 'same' }] };
      },
    });

    assert.equal(judgeCalls, 0, '不命中关键串不应进入 judge');
    assert.equal(result.dedupe.asked, 0);
    assert.equal(result.facts, 1, '不命中仍照常写入');
    assert.equal(activeFacts(store).length, 2);
    assert.ok(activeFacts(store).some((row) => row.statement === draft.statement));
  });

  test('L6-003（v0.7.21 非真机证据）：原有 skip 档不被升级成 ask，不新增 skip 计数', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, {
      kind: 'preference',
      statement: '我每天早上喝咖啡',
    });
    const draft = {
      kind: 'preference',
      subject_text: '我',
      predicate: '每天早上',
      object_text: '喝咖啡',
      statement: '我每天早上喝咖啡',
    };
    const score = jaccard(textBigrams(existing.statement), textBigrams(draft.statement));
    assert.equal(score, 1, '构造必须落在 skip 档（Jaccard=1）');
    const byKind = collectActiveFactsByKind(store, 'main');
    const base = classifyDraftFact(draft, byKind, {});
    assert.equal(base.verdict, 'skip');
    assert.equal(
      upgradeVerdictWithKeyPhrases(draft, base, buildKeyPhraseIndex(byKind)).verdict,
      'skip',
      'upgrade 只作用于 new，skip 原样保留',
    );

    let judgeCalls = 0;
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: 我每天早上喝咖啡。',
      llm: () => draftWith([draft]),
      judge: async () => {
        judgeCalls += 1;
        return { items: [{ index: 1, verdict: 'same' }] };
      },
    });

    assert.equal(judgeCalls, 0, 'skip 档不走 judge（没有被升级成 ask）');
    assert.equal(result.dedupe.asked, 0, '不新增 ask');
    assert.equal(result.facts, 0);
    assert.equal(activeFacts(store).length, 1);
    assert.ok(
      store.getFact(existing.id).recall_count > existing.recall_count,
      'skip 仍按原语义强化旧条',
    );
  });

  test('L6-004（v0.7.21 非真机证据）：跨 kind 升级只给裁决机会——judge=new 时两条并存', async (t) => {
    const store = openStore(t);
    const existing = seedFact(store, {
      kind: 'project',
      statement: 'dsh-companion 用 Node 跑服务',
    });
    const draft = {
      kind: 'preference',
      subject_text: 'dsh-companion',
      predicate: '配置',
      object_text: 'ubuntu 用户',
      statement: 'dsh-companion 配了 ubuntu 用户',
    };

    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      regionText: 'user: dsh-companion 配了 ubuntu 用户。',
      llm: () => draftWith([draft]),
      judge: async () => ({ items: [{ index: 1, verdict: 'new' }] }),
    });

    assert.equal(result.dedupe.asked, 1);
    assert.equal(result.dedupe.repl, 1, 'judge 判 new：不是强制合并，只多一次裁决');
    assert.equal(result.facts, 1);
    assert.equal(activeFacts(store).length, 2, '两条并存，未误合并');
    assert.equal(store.getFact(existing.id).status, 'active');
  });
});
