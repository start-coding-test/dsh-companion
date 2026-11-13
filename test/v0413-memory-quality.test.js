/**
 * v0.4.13 A8：记忆质量（当前覆盖 ④ 纯工具区间不写占位 episode、⑤ 巩固提示词
 * 补生活类抽取指引与 kind）。
 *
 * ①计数拆分/②未用降档/③同义去重需要 v15 schema 与巩固侧改写，分别在后续提交
 * 覆盖；这里先把「模型可以不给 episode」与「提示词明确要求生活类」钉死。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ConsolidationError,
  buildConsolidationPrompt,
  consolidate,
} from '../src/memory/consolidate.js';
import { Store } from '../src/memory/store.js';

const NOW = 1_790_000_000;

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

describe('A8④：纯工具区间不写占位 episode', () => {
  test('episode 为 null 时只写事实，不写情景记忆', async (t) => {
    const store = openStore(t);
    const result = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 3,
      now: NOW,
      llm: () => ({
        episode: null,
        facts: [{ kind: 'knowledge', subject_text: 'D 盘', predicate: '剩余', object_text: '12GB', statement: 'D 盘剩余 12GB' }],
      }),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.episodeId, undefined);
    assert.equal(result.facts, 1);
    const stats = store.stats();
    assert.equal(stats.episodes, 0);
    assert.equal(stats.facts, 1);
    const [fact] = store.listFacts({ scope: 'main', limit: 10 });
    assert.equal(fact.source_episode_id, null);
  });

  test('episode 缺字段（没有 title/summary）仍按坏草稿拒绝', async (t) => {
    const store = openStore(t);
    await assert.rejects(
      () => consolidate({
        store,
        scope: 'main',
        seqFrom: 1,
        seqTo: 2,
        now: NOW,
        llm: () => ({ episode: { title: '只有标题' }, facts: [] }),
      }),
      (error) => error instanceof ConsolidationError && error.code === 'bad-draft',
    );
    assert.equal(store.stats().consolidations, 0);
  });

  test('整段空手而归（无 episode、无事实、无提醒）拒绝', async (t) => {
    const store = openStore(t);
    await assert.rejects(
      () => consolidate({
        store,
        scope: 'main',
        seqFrom: 1,
        seqTo: 2,
        now: NOW,
        llm: () => ({ episode: null, facts: [] }),
      }),
      (error) => error instanceof ConsolidationError
        && error.code === 'bad-draft'
        && /draft is empty/u.test(error.message),
    );
    assert.equal(store.stats().consolidations, 0);
  });
});

describe('A8⑤：巩固提示词的生活类指引', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    regionText: 'user: 今天加班到十点\nassistant: 辛苦了',
  });

  test('允许 episode 为 null，并要求不编造情景', () => {
    assert.match(prompt, /"episode":\{"title":"\.\.\.","summary":"\.\.\."\} 或 null/u);
    assert.match(prompt, /"episode" 写 null/u);
  });

  test('kind 里出现 lifestyle / mood，并给出生活类抽取方向', () => {
    assert.match(prompt, /lifestyle\|mood/u);
    assert.match(prompt, /作息/u);
    assert.match(prompt, /饮食/u);
    assert.match(prompt, /人际关系/u);
  });

  test('同一对象要求沿用同一个 subject_text', () => {
    assert.match(prompt, /subject_text 保持一致/u);
  });

  test('原有红线仍在：旧记忆只作佐证、凭据不复述', () => {
    assert.match(prompt, /不得据此新建事实或改写现有结论/u);
    assert.match(prompt, /不得复述密码、口令、token、卡号/u);
  });
});
