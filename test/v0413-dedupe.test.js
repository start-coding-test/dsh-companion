/**
 * A8③（v0.4.13）：同一偏好的不同说法只保留一条 active 事实。
 *
 * 用两次巩固模拟：第一次写入「用户喜欢美式咖啡」，第二次把「拿铁」当作同一 subject
 * 的变化，草稿带 supersedes=<旧 id>，落库后旧行变 superseded、active 只剩新行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { consolidate, buildConsolidationPrompt, selectExistingFacts } from '../src/memory/consolidate.js';

const BASE = 1_795_000_000;

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-a83-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const fact = (statement, subject = '咖啡') => ({
  kind: 'preference',
  subject_text: subject,
  predicate: '喜欢',
  object_text: statement,
  statement,
});

test('selectExistingFacts 只挑对话里提到过的 subject', async () => {
  await withStore((store) => {
    store.insertFact({
      scope: 'main',
      kind: 'preference',
      subject_text: '咖啡',
      predicate: '喜欢',
      object_text: '美式',
      statement: '用户喜欢美式咖啡',
      source_kind: 'consolidated',
      observed_at: BASE,
    });
    assert.equal(selectExistingFacts(store, 'main', '今天喝了咖啡').length, 1);
    assert.equal(selectExistingFacts(store, 'main', '今天在写代码').length, 0);
  });
});

test('prompt 带上同主题既有事实与 supersedes 指引', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    regionText: 'user: 今天还是喝咖啡',
    existingFacts: [{ id: 'fact_x', subject_text: '咖啡', statement: '用户喜欢美式咖啡' }],
  });
  assert.match(prompt, /同主题已有事实/u);
  // 只提示 id 与主题，不复述正文（正文可能来自召回快照）。
  assert.match(prompt, /id=fact_x｜咖啡/u);
  assert.doesNotMatch(prompt, /用户喜欢美式咖啡/u);
  assert.match(prompt, /supersedes/u);
});

test('第二次巩固用 supersedes 整条改写，active 只剩 1 条', async () => {
  await withStore(async (store) => {
    const first = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 2,
      now: BASE,
      regionText: 'user: 我平时只喝美式咖啡',
      llm: () => ({ episode: { title: '喝咖啡', summary: '聊到咖啡' }, facts: [fact('用户喜欢美式咖啡')] }),
    });
    assert.equal(first.facts, 1);

    const old = store.listFacts({ scope: 'main', limit: 10, status: 'active' })[0];
    assert.ok(old);

    const second = await consolidate({
      store,
      scope: 'main',
      seqFrom: 3,
      seqTo: 4,
      now: BASE + 60,
      regionText: 'user: 今天想喝咖啡，换成交拿铁吧',
      llm: (input) => {
        // 候选里必须能看到第一次写的事实，模型才有 id 可引用。
        assert.ok(input.existingFacts.some((row) => row.id === old.id));
        return {
          episode: null,
          facts: [{ ...fact('用户现在更喜欢拿铁'), supersedes: old.id }],
        };
      },
    });
    assert.equal(second.facts, 1);

    const active = store.listFacts({ scope: 'main', limit: 10, status: 'active' });
    assert.equal(active.length, 1, '同主题只应剩 1 条 active');
    assert.equal(active[0].statement, '用户现在更喜欢拿铁');

    const superseded = store.getFact(old.id);
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.superseded_by, active[0].id);
  });
});

test('supersedes 指向候选集外的 id 时忽略，不误伤其它行', async () => {
  await withStore(async (store) => {
    const stray = store.insertFact({
      scope: 'main',
      kind: 'preference',
      subject_text: '茶',
      predicate: '喜欢',
      object_text: '龙井',
      statement: '用户喜欢龙井',
      source_kind: 'consolidated',
      observed_at: BASE,
    });

    await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 2,
      now: BASE + 10,
      llm: () => ({
        episode: null,
        facts: [{ ...fact('用户喜欢咖啡'), supersedes: stray.id }],
      }),
    });

    assert.equal(store.getFact(stray.id).status, 'active');
  });
});
