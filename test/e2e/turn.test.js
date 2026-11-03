/**
 * T11c 一轮完整链路 e2e：
 *   seed 记忆 → 召回 → 32K 装配 → 巩固成功（状态板只 staged）
 *   → open turn 压缩成功后才 publish → 下一轮召回看到新事实。
 *
 * 原则：只依赖 FakeCtx + 临时库；不启动真实 DSH、不联网、不读真实时钟。
 *
 * 口径：本文件是组件级 self-wired（测试自己串 consolidate / compactRegion /
 * publishBoard），不是 apply() 的生产路径；生产接线由 apply-turn.test.js 覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, assemble } from '../../src/memory/assemble.js';
import { consolidate } from '../../src/memory/consolidate.js';
import { retrieve } from '../../src/memory/retrieve.js';
import { publishBoard } from '../../src/memory/state-board.js';
import { DEFAULT_CARD } from '../../src/persona/card.js';
import { buildSections } from '../../src/persona/sections.js';
import { createAdapter } from '../../src/platform/adapter.js';
import { FakeCtx } from '../fakes/ctx.js';
import {
  TEST_NOW,
  createClock,
  makeDraft,
  makeFakeLlm,
  makeTempStore,
  recallInjection,
  seedMemory,
} from './helpers.js';
import { makeBudgetHistory } from '../helpers/scenarios.js';

/**
 * 一轮装配：召回 → assemble；open === true 时调用压缩。
 * @param {object} input
 * @returns {Promise<{recalled: object, assembled: object}>}
 */
async function runTurn({ store, platform, query, history, open }) {
  const recalled = await retrieve({ store, query, scope: 'main', now: TEST_NOW });
  const assembled = assemble({
    sections: buildSections(DEFAULT_CARD),
    boardText: store.getBoard('main'),
    recallItems: recalled.items,
    history,
    userInput: '继续',
  });
  if (open) await platform.compactRegion(1, 2, { id: 'agent-main' });
  return { recalled, assembled };
}

test('一轮完整链路：巩固只 staged，压缩成功才发布，下一轮召回新事实', async (t) => {
  const { store } = makeTempStore({ t });
  const clock = createClock(TEST_NOW);
  const ctx = new FakeCtx({ now: clock.now() });
  const platform = createAdapter(ctx, { now: clock.now });

  seedMemory(store, {
    now: clock.seconds(),
    title: '青柠计划启动',
    summary: '用户确认青柠计划本周启动，先定预算。',
    statement: '青柠计划每周三开例会。',
    reminderTitle: '准备周会材料',
  });

  // 第一轮：召回旧记忆并装配 32K（历史远超预算）。
  const history = makeBudgetHistory(900); // 45,000 token
  const firstTurn = await runTurn({
    store,
    platform,
    query: '青柠计划',
    history,
    open: true,
  });
  assert.ok(firstTurn.recalled.items.length >= 1, '第一轮应召回 seed 的记忆');
  assert.ok(firstTurn.assembled.dropped.history.length > 0, '历史应被裁短');
  assert.ok(
    firstTurn.assembled.layers.history >= DEFAULT_LIMITS.retainTokens,
    `压缩后历史尾部应 ≥ ${DEFAULT_LIMITS.retainTokens} token`,
  );
  assert.equal(ctx.callsOf('compaction.compactRegion').length, 1, 'open turn 压缩一次');

  // 巩固：新事实写入，但状态板只 staged，不发布。
  const draft = makeDraft({
    facts: [
      {
        kind: 'project',
        subject_text: '青柠计划',
        predicate: '预算',
        object_text: '每月 8000 元',
        statement: '青柠计划的预算是每月 8000 元。',
        source_kind: 'consolidated',
        salience: 'normal',
      },
    ],
  });
  const llm = makeFakeLlm(draft);
  const merged = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 1,
    llm,
    now: clock.seconds(),
    trigger: 'idle',
    sessionId: 'session-turn-1',
  });
  assert.equal(merged.skipped, false);
  assert.equal(merged.facts, 1);

  const staged = store.getBoardState('main');
  assert.equal(store.getBoard('main'), '', '巩固后状态板不得直接发布');
  assert.ok(staged.staged_revision > staged.revision, '巩固应推进 staged 版本');
  assert.match(staged.staged_rendered, /8000/, 'staged 内容应含新事实');

  // 压缩成功后发布：revision +1，板内容翻进 system prompt。
  const publishedRevision = publishBoard(store, 'main', 'compact');
  assert.equal(publishedRevision, staged.revision + 1);
  const published = store.getBoard('main');
  assert.match(published, /8000/, '发布后的板应含新事实');
  assert.equal(staged.staged_revision > staged.revision, true);

  // 关闭轮次不再压缩。
  await runTurn({ store, platform, query: '继续', history, open: false });
  assert.equal(
    ctx.callsOf('compaction.compactRegion').length,
    1,
    '只有 open turn 才允许压缩',
  );

  // 下一轮：新事实可被召回并注入进 user 消息。
  const nextTurn = await runTurn({ store, platform, query: '预算', history, open: false });
  assert.ok(
    nextTurn.recalled.items.some((item) => item.text.includes('8000')),
    '下一轮召回应看到新事实',
  );
  const injection = await recallInjection({ store, query: '预算', now: TEST_NOW });
  assert.match(injection.injected, /8000/);
});

test('压缩失败时不发布状态板，修复后成功才发布', async (t) => {
  const { store } = makeTempStore({ t });
  const clock = createClock(TEST_NOW);
  const ctx = new FakeCtx({ now: clock.now() });
  const platform = createAdapter(ctx, { now: clock.now });

  const llm = makeFakeLlm(makeDraft());
  await consolidate({
    store,
    scope: 'main',
    seqFrom: 2,
    seqTo: 2,
    llm,
    now: clock.seconds(),
    sessionId: 'session-turn-2',
  });
  const staged = store.getBoardState('main');
  assert.ok(staged.staged_revision > staged.revision);

  ctx.fail('compaction.compactRegion', new Error('compaction boom'));
  await assert.rejects(
    async () => platform.compactRegion(1, 2, { id: 'agent-main' }),
    /compaction boom/u,
  );
  assert.equal(store.getBoard('main'), '', '压缩失败不得发布状态板');

  ctx.failures.delete('compaction.compactRegion');
  const published = publishBoard(store, 'main', 'restart');
  assert.ok(published >= 1, '修复后发布应成功');
  assert.match(store.getBoard('main'), /蓝鲸|青柠计划/u);
});
