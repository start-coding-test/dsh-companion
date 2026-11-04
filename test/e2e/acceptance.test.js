/**
 * T11c 端到端验收集（V2 / V10 / V15 / V16 + 提醒线）。
 *
 * 复用 test/e2e/helpers.js 与 test/helpers/scenarios.js 的场景数据，
 * 不重复定义遗忘/预算/写失败的场景。只跑假宿主与临时库：
 * 不启动真实 DSH、不联网、不读真实时钟。
 *
 * 口径：本文件是组件级 self-wired（逐模块调用 consolidate / scheduler /
 * proactive），不是 apply() 的生产路径；生产接线由 apply-turn.test.js 覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LIMITS, assemble, estimateTokens } from '../../src/memory/assemble.js';
import { consolidate } from '../../src/memory/consolidate.js';
import { DEFAULT_CARD } from '../../src/persona/card.js';
import { buildSections } from '../../src/persona/sections.js';
import { normalizeConfig } from '../../src/config.js';
import { createProactive } from '../../src/runtime/proactive.js';
import { createScheduler } from '../../src/runtime/scheduler.js';
import { FakeCtx } from '../fakes/ctx.js';
import {
  createClock,
  forgetMemory,
  makeDraft,
  makeFakeLlm,
  makeTempStore,
  seedMemory,
} from './helpers.js';
import {
  WRITE_FAIL_SEQ_FROM,
  WRITE_FAIL_SEQ_TO,
  makeBudgetHistory,
  makeBudgetRecallItem,
  makeBudgetScenario,
  makeWriteFailDraft,
} from '../helpers/scenarios.js';

/** Asia/Shanghai 墙上时刻 → epoch ms（等于默认 config.timezone，与进程 TZ 无关）。 */
const at = (iso) => Date.parse(`${iso}+08:00`);

const results = [];

/**
 * 跑一个验收场景，失败只记录不中断，最后统一汇总。
 * @param {string} name
 * @param {() => Promise<void>|void} fn
 */
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

/**
 * 假计时器：只记录句柄，不真的排队。
 * @returns {{unref: () => void}}
 */
function fakeTimerHandle() {
  return { unref() {} };
}

test('T11c 验收：V2/V10/V15/V16 + 提醒线', async (t) => {
  // ------------------------------------------------------------------ V2
  await scenario('V2 遗忘冷静期与 03:30 purge', async () => {
    const { store } = makeTempStore({ t });
    const base = at('2026-11-03T03:00:00');
    const seeded = seedMemory(store, {
      now: Math.floor(base / 1000),
      title: '青柠计划启动',
      summary: '用户说了青柠计划的代号。',
      statement: '青柠计划的代号是蓝鲸。',
      reminderTitle: '跟进青柠计划预算',
    });
    assert.ok(seeded.factId);
    forgetMemory(store, {
      scope: 'main',
      factId: seeded.factId,
      episodeId: seeded.episodeId,
      reminderId: seeded.reminderId,
      now: base,
    });

    const purgeAt = at('2026-11-10T03:30:00');
    const scheduler = createScheduler({
      store,
      clock: () => purgeAt,
      timer: fakeTimerHandle,
      clearTimer: () => {},
      jobs: {
        's2-purge': (nowMs) => store.purge({ now: nowMs, cutoffDays: 7 }),
      },
    });
    const ran = scheduler.runDue(purgeAt);
    assert.ok(ran.ran.includes('s2-purge'), '本地 03:30 应触发 s2-purge');

    assert.equal(store.getFact(seeded.factId), null);
    assert.equal(store.getEpisode(seeded.episodeId), null);
    assert.deepEqual(store.searchBigram('青柠计划'), []);
    const stats = store.stats();
    assert.equal(stats.fts_facts, 0);
    assert.equal(stats.fts_episodes, 0);

    scheduler.runDue(at('2026-12-10T03:30:00'));
    assert.deepEqual(store.searchBigram('青柠计划'), []);
    assert.equal(store.stats().fts_facts, 0);
    assert.equal(store.stats().fts_episodes, 0);
  });

  // ------------------------------------------------------------- V10/V16
  await scenario('V10/V16 32K 裁切顺序与人格段不动', async () => {
    const scenarioData = makeBudgetScenario();
    const sections = buildSections(DEFAULT_CARD);
    const personaTokens = sections
      .reduce((sum, section) => sum + estimateTokens(section.text), 0);

    const result = assemble({
      sections,
      boardText: scenarioData.boardText,
      recallItems: scenarioData.recallItems,
      history: scenarioData.history,
      userInput: scenarioData.userInput,
    });
    assert.ok(result.tokens.total <= DEFAULT_LIMITS.workingMemoryTokens);
    assert.ok(result.dropped.recall.length > 0, '应先丢低分召回');
    assert.ok(result.dropped.history.length > 0, '再按最旧挤历史');
    assert.ok(result.layers.history >= DEFAULT_LIMITS.retainTokens);
    assert.equal(result.layers.persona, personaTokens, '人格段不得被裁');
    const droppedScores = result.dropped.recall.map((item) => item.score);
    assert.deepEqual(droppedScores, [...droppedScores].sort((a, b) => a - b));

    // V16 单侧：召回超 2,050 时只裁召回，历史完整保留。
    const heavyRecall = Array.from({ length: 12 }, (_unused, index) => makeBudgetRecallItem({
      id: `h${index}`,
      score: 0.9 - index * 0.01,
      chars: 1000,
    }));
    const smallHistory = makeBudgetHistory(12, 40);
    const recallOnly = assemble({
      recallItems: heavyRecall,
      history: smallHistory,
      userInput: '继续',
    });
    assert.ok(recallOnly.dropped.recall.length > 0);
    assert.equal(recallOnly.dropped.history.length, 0);
    assert.equal(recallOnly.layers.history, 12 * 20);
  });

  // ----------------------------------------------------------------- V15
  await scenario('V15 写库失败零落库且不触发压缩', async () => {
    const { store } = makeTempStore({ t });
    const clock = createClock(at('2026-11-05T10:00:00'));
    const llm = makeFakeLlm(makeWriteFailDraft());
    const boardBefore = store.getBoardState('main');

    const originalInsertFact = store.insertFact.bind(store);
    let inserted = 0;
    store.insertFact = (input) => {
      inserted += 1;
      if (inserted === 2) throw new Error('insert fact failed');
      return originalInsertFact(input);
    };

    let compactCalls = 0;
    let failed = false;
    try {
      await consolidate({
        store,
        scope: 'main',
        seqFrom: WRITE_FAIL_SEQ_FROM,
        seqTo: WRITE_FAIL_SEQ_TO,
        llm,
        now: clock.seconds(),
        sessionId: 'v15-session',
      });
    } catch {
      failed = true;
      // 失败路径不调用压缩。
    }
    if (!failed) compactCalls += 1;

    assert.equal(failed, true);
    assert.equal(compactCalls, 0);
    const stats = store.stats();
    assert.equal(stats.episodes, 0);
    assert.equal(stats.facts, 0);
    assert.equal(stats.reminders, 0);
    assert.equal(stats.consolidations, 0);
    assert.equal(stats.memory_events, 0);
    assert.equal(store.getWatermark('main'), 0);
    const boardAfter = store.getBoardState('main');
    assert.equal(boardAfter.revision, boardBefore.revision);
    assert.equal(boardAfter.staged_revision, boardBefore.staged_revision);
  });

  // ------------------------------------------------------------- 提醒线
  await scenario('提醒线：安静时段不打扰、每日 ≤3、漏扫 6h 补一次', async () => {
    const { store } = makeTempStore({ t });
    let now = at('2026-11-04T23:30:00');
    const prompts = [];
    const config = normalizeConfig({
      quietStart: '23:00',
      quietEnd: '08:00',
      proactiveDailyCap: 3,
    });
    const proactive = createProactive({
      store,
      config,
      target: () => 'main',
      clock: () => now,
      platform: {
        async prompt(sessionId, text) {
          prompts.push({ sessionId, text });
        },
      },
    });

    proactive.enqueue({ kind: 'chat', text: '夜深了，先睡吧。', dedupeKey: 'quiet-1', at: now });
    const quiet = await proactive.flush(now);
    assert.equal(quiet.quiet, true);
    assert.equal(prompts.length, 0);
    assert.equal(quiet.deferred, 1);

    now = at('2026-11-05T08:00:00');
    const morning = await proactive.flush(now);
    assert.equal(morning.sent, 1);
    assert.equal(prompts.length, 1);

    // 当日剩余额度 2：2 条提醒 + 1 条任务汇报，只发 2 条。
    proactive.enqueue({ kind: 'reminder', text: '提醒：交周报。', dedupeKey: 'r-1', at: now });
    proactive.enqueue({ kind: 'reminder', text: '提醒：开会。', dedupeKey: 'r-2', at: now });
    proactive.enqueue({ kind: 'task_report', text: '任务完成：整理文档。', dedupeKey: 't-1', at: now });
    const capped = await proactive.flush(now);
    assert.equal(capped.sent, 2);
    assert.equal(capped.merged, 0, 'V4-H1：提醒不参与合并，两条各自投递');
    assert.equal(prompts.length, 3);
    assert.equal(capped.deferred, 1, '任务汇报留到下一轮（日上限已满）');
    assert.equal(proactive.stats(now).remainingToday, 0);

    // 日上限后再来的消息不得突破 3 条。
    proactive.enqueue({ kind: 'chat', text: '再加一句。', dedupeKey: 'c-2', at: now });
    const extra = await proactive.flush(now);
    assert.equal(extra.sent, 0);
    assert.equal(extra.deferred, 2, '超额消息留在 backlog，不丢也不发');
    assert.equal(prompts.length, 3);

    // 调度器补扫：04:30 启动，6h 内的 4 个每日任务各补一次；重启不重复。
    const { store: schedulerStore } = makeTempStore({ t });
    const catchUpRuns = [];
    const jobs = {
      'idle-probe': () => catchUpRuns.push('idle-probe'),
      reminders: () => catchUpRuns.push('reminders'),
      'deep-sleep': () => catchUpRuns.push('deep-sleep'),
      's2-purge': () => catchUpRuns.push('s2-purge'),
      backup: () => catchUpRuns.push('backup'),
      'thread-freeze': () => catchUpRuns.push('thread-freeze'),
    };
    const bootAt = at('2026-11-04T04:30:00');
    const first = createScheduler({
      store: schedulerStore,
      clock: () => bootAt,
      jobs,
      timer: fakeTimerHandle,
      clearTimer: () => {},
    });
    const started = first.start(bootAt);
    assert.deepEqual(
      [...started.catchUp].sort(),
      ['backup', 'deep-sleep', 's2-purge', 'thread-freeze'],
    );
    first.stop();

    const second = createScheduler({
      store: schedulerStore,
      clock: () => bootAt,
      jobs,
      timer: fakeTimerHandle,
      clearTimer: () => {},
    });
    const restarted = second.start(bootAt);
    assert.deepEqual(restarted.catchUp, [], '重启后同日不得重复补跑');
    second.stop();
  });

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    `${failed.length === 0 ? 'PASS' : 'FAIL'} [t12 acceptance] `
    + `${results.length - failed.length}/${results.length} scenarios`,
  );
  for (const entry of failed) {
    console.error(`- ${entry.name}: ${entry.error?.stack ?? entry.error}`);
  }
  assert.deepEqual(failed.map((entry) => entry.name), []);
});
