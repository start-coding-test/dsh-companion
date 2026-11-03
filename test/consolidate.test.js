/**
 * T6 巩固链路 + 状态板发布测试。
 *
 * 覆盖：planConsolidation 触发与优先级、watermark skipped、坏草稿、
 * 模型抛错、事务中途写库失败回滚、成功写库与水位推进、重复段不重复、
 * facts 去重、reminders 落库、状态板 staged 不发布、四时机发布与非法
 * reason、5 区块渲染与 800 token 裁切。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/memory/store.js';
import {
  ConsolidationError,
  buildConsolidationPrompt,
  consolidate,
  planConsolidation,
} from '../src/memory/consolidate.js';
import { planRegion } from '../src/session/surface.js';
import {
  BOARD_TOKEN_LIMIT,
  PUBLISH_REASONS,
  estimateBoardTokens,
  publishBoard,
  renderBoard,
  stageBoard,
} from '../src/memory/state-board.js';

const DAY = 86_400;
const BASE = 1_700_000_000;

/** 每个测试独立的内存库，t.after 关闭。 */
function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

/** 造一份合法草稿；overrides 可替换 episode/facts/reminders。 */
function makeDraft(overrides = {}) {
  return {
    episode: {
      title: '聊了周末安排',
      summary: '用户提到周末想去看展，顺便确认了猫粮预算。',
      topics: ['周末', '看展'],
      started_at: BASE,
      ...(overrides.episode ?? {}),
    },
    facts: overrides.facts ?? [
      {
        kind: 'preference',
        subject_text: '用户',
        predicate: '想看',
        object_text: '展',
        statement: '用户周末想看展',
      },
    ],
    reminders: overrides.reminders ?? [],
  };
}

/** 假 llm：记录调用参数，可返回固定草稿或抛错。 */
function fakeLlm(draft) {
  const calls = [];
  const llm = async (args) => {
    calls.push(args);
    return typeof draft === 'function' ? draft(args) : draft;
  };
  llm.calls = calls;
  return llm;
}

/** 巩固会写到的表的行数快照。 */
function counts(store) {
  const stats = store.stats();
  return {
    episodes: stats.episodes,
    facts: stats.facts,
    reminders: stats.reminders,
    consolidations: stats.consolidations,
    memory_events: stats.memory_events,
    state_board: stats.state_board,
  };
}

/** 取渲染文本里某个区块（到下一个 【 为止）。 */
function sectionOf(text, title) {
  const start = text.indexOf(`【${title}】`);
  assert.notEqual(start, -1, `缺少区块 ${title}`);
  const next = text.indexOf('【', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

// ------------------------------------------------------ planConsolidation

test('planConsolidation：idle / threshold / hard 与优先级', () => {
  const now = BASE * 1000;
  const idle = 30 * 60 * 1000;

  assert.deepEqual(planConsolidation(), { trigger: null, pending: false });
  assert.deepEqual(
    planConsolidation({ tokens: 1_000, lastHumanAt: now - idle, now }),
    { trigger: 'idle', pending: true },
  );
  assert.deepEqual(
    planConsolidation({ tokens: 1_000, lastHumanAt: now - idle + 1, now }),
    { trigger: null, pending: false },
  );
  assert.deepEqual(
    planConsolidation({ tokens: 24_000, overCount: 2, lastHumanAt: now, now }),
    { trigger: 'threshold', pending: true },
  );
  assert.deepEqual(
    planConsolidation({ tokens: 24_000, overCount: 1, lastHumanAt: now, now }),
    { trigger: null, pending: false },
  );
  assert.deepEqual(
    planConsolidation({ tokens: 40_000, lastHumanAt: now, now }),
    { trigger: 'hard', pending: true },
  );
  // 同时满足：hard > idle > threshold
  assert.equal(
    planConsolidation({ tokens: 40_000, lastHumanAt: now - 3_600_000, now }).trigger,
    'hard',
  );
  assert.equal(
    planConsolidation({ tokens: 25_000, overCount: 3, lastHumanAt: now - 1_800_000, now }).trigger,
    'idle',
  );
  // 从未有真人消息时不按空闲触发
  assert.equal(planConsolidation({ tokens: 1_000, lastHumanAt: null, now }).trigger, null);
  // Date 入参同样可用
  assert.equal(
    planConsolidation({ tokens: 0, lastHumanAt: new Date(now - idle), now: new Date(now) }).trigger,
    'idle',
  );
});

// -------------------------------------------------------- skipped 水位线

test('consolidate：seqTo ≤ watermark 时 skipped，不调模型、不写任何行', async (t) => {
  const store = openStore(t);
  store.insertConsolidation({
    scope: 'main',
    session_id: 's1',
    kind: 'nap',
    trigger: 'idle',
    upto_seq: 5,
    status: 'written',
    started_at: BASE,
  });
  const before = counts(store);
  const llm = fakeLlm(makeDraft());

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 5,
    llm,
    now: BASE + 60,
  });

  assert.deepEqual(result, { skipped: true, upto_seq: 5, textSource: 'transcript' });
  assert.equal(llm.calls.length, 0, 'skipped 不应调用模型');
  assert.deepEqual(counts(store), before, 'skipped 不应写任何行');
  assert.equal(store.getBoardState('main').staged_revision, null);
});

// ------------------------------------------------------------ N1 选区文本

test('buildConsolidationPrompt：regionText 优先于 transcript，并保留 role 标注', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: 1,
    seqTo: 9,
    regionText: 'user: 旧事实：预算额度是 8000。\nassistant: 收到，已记住。',
    transcript: [{ role: 'assistant', text: '最近的转录不应出现在提示词里' }],
  });
  assert.match(prompt, /user: 旧事实：预算额度是 8000。/u);
  assert.match(prompt, /assistant: 收到，已记住。/u);
  assert.match(prompt, /scope=main seq=1-9/u);
  assert.doesNotMatch(prompt, /最近的转录不应出现在提示词里/u);
});

test('buildConsolidationPrompt：regionText 为空白时回退 transcript', () => {
  const prompt = buildConsolidationPrompt({
    scope: 'thread:budget',
    seqFrom: 3,
    seqTo: 4,
    regionText: '   \n ',
    transcript: [
      { role: 'user', text: '转录里的事实' },
      { role: 'assistant', text: '好的' },
    ],
  });
  assert.match(prompt, /user: 转录里的事实/u);
  assert.match(prompt, /assistant: 好的/u);
  assert.match(prompt, /scope=thread:budget seq=3-4/u);
});

test('consolidate：regionText 透传模型并返回 textSource=region', async (t) => {
  const store = openStore(t);
  const transcript = [{ role: 'assistant', text: '转录兜底' }];
  const llm = fakeLlm(makeDraft({ episode: { title: '预算', summary: '预算 8000' }, facts: [], reminders: [] }));
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 4,
    regionText: 'user: 旧事实：预算额度是 8000。',
    transcript,
    llm,
    now: BASE,
  });

  assert.equal(result.textSource, 'region');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].regionText, 'user: 旧事实：预算额度是 8000。');
  assert.equal(llm.calls[0].textSource, 'region');
  assert.deepEqual(llm.calls[0].transcript, transcript);
  assert.equal(store.getWatermark('main'), 4);
});

test('consolidate：regionText 为空白时用 transcript 并返回 textSource=transcript', async (t) => {
  const store = openStore(t);
  const transcript = [{ role: 'user', text: '转录里的事实' }];
  const llm = fakeLlm(makeDraft({ facts: [], reminders: [] }));
  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 2,
    regionText: '  ',
    transcript,
    llm,
    now: BASE,
  });

  assert.equal(result.textSource, 'transcript');
  assert.equal(llm.calls[0].textSource, 'transcript');
  assert.equal(llm.calls[0].regionText, '');
  assert.deepEqual(llm.calls[0].transcript, transcript);
});

test('consolidate：regionText 非字符串立即报编程错误，不调模型不写库', async (t) => {
  const store = openStore(t);
  const llm = fakeLlm(makeDraft({ facts: [], reminders: [] }));
  const before = counts(store);
  await assert.rejects(
    () => consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 2,
      regionText: { text: 'user: 不是字符串' },
      llm,
      now: BASE,
    }),
    /regionText must be a string/u,
  );
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(counts(store), before);
});

test('planRegion：选区边界不包含尾部预留内容', () => {
  const snapshot = {
    seqs: [1, 2, 3],
    nodes: [{ tokens: 5 }, { tokens: 5 }, { tokens: 5 }],
    records: [
      { role: 'user', text: '旧事实一' },
      { role: 'user', text: '旧事实二' },
      { role: 'assistant', text: '尾部保留内容' },
    ],
  };
  const { region } = planRegion(snapshot, { afterSeq: 0, budgetTokens: 5 });
  assert.deepEqual([region.startSeq, region.endSeq], [1, 2]);
  assert.match(region.text, /旧事实一[\s\S]*旧事实二/u);
  assert.doesNotMatch(region.text, /尾部保留内容/u);
  const prompt = buildConsolidationPrompt({
    scope: 'main',
    seqFrom: region.startSeq,
    seqTo: region.endSeq,
    regionText: region.text,
  });
  assert.match(prompt, /旧事实一/u);
  assert.doesNotMatch(prompt, /尾部保留内容/u);
});

// ------------------------------------------------------------ 坏草稿

test('consolidate：坏草稿抛 ConsolidationError(bad-draft)，库内计数不变', async (t) => {
  const store = openStore(t);
  const badDrafts = [
    null,
    [],
    {},
    { episode: { title: '只有标题' }, facts: [] },
    { episode: { title: 'x', summary: 'y' } },
    {
      episode: { title: 'x', summary: 'y' },
      facts: [{ kind: 'preference', predicate: 'p', statement: 's' }],
    },
    {
      episode: { title: 'x', summary: 'y' },
      facts: [{ kind: '不存在的类型', subject_text: '我', predicate: 'p', statement: 's' }],
    },
    { episode: { title: 'x', summary: 'y' }, facts: [], reminders: '不是数组' },
    { episode: { title: 'x', summary: 'y' }, facts: [], reminders: [{}] },
  ];

  for (const draft of badDrafts) {
    const before = counts(store);
    await assert.rejects(
      () => consolidate({
        store,
        scope: 'main',
        seqFrom: 1,
        seqTo: 2,
        llm: fakeLlm(draft),
        now: BASE,
      }),
      (error) => {
        assert.ok(error instanceof ConsolidationError, `应抛 ConsolidationError，实际 ${error?.name}`);
        assert.equal(error.code, 'bad-draft');
        return true;
      },
    );
    assert.deepEqual(counts(store), before, `坏草稿不应写库：${JSON.stringify(draft)}`);
    assert.equal(store.getWatermark('main'), 0);
  }
});

test('consolidate：llm 抛错原样上抛，库内计数不变', async (t) => {
  const store = openStore(t);
  const before = counts(store);
  const llm = async () => {
    throw new Error('model down');
  };

  await assert.rejects(
    () => consolidate({ store, scope: 'main', seqFrom: 1, seqTo: 3, llm, now: BASE }),
    /model down/,
  );
  assert.deepEqual(counts(store), before);
  assert.equal(store.getWatermark('main'), 0);
});

// ----------------------------------------------------- 事务中途失败回滚

test('consolidate：写库中途抛错整体回滚（episode/facts/consolidations 计数不变）', async (t) => {
  const store = openStore(t);
  const before = counts(store);
  const originalInsertFact = store.insertFact.bind(store);
  let inserted = 0;
  store.insertFact = (input) => {
    inserted += 1;
    if (inserted === 2) throw new Error('disk full');
    return originalInsertFact(input);
  };

  const draft = makeDraft({
    facts: [
      { kind: 'preference', subject_text: '用户', predicate: '想看', statement: '用户想看展' },
      { kind: 'preference', subject_text: '用户', predicate: '喜欢', statement: '用户喜欢猫' },
    ],
  });

  try {
    await assert.rejects(
      () => consolidate({
        store,
        scope: 'main',
        seqFrom: 1,
        seqTo: 4,
        llm: fakeLlm(draft),
        now: BASE,
      }),
      /disk full/,
    );
  } finally {
    store.insertFact = originalInsertFact;
  }

  assert.equal(inserted, 2, '应在第二条 fact 写入时失败');
  assert.deepEqual(counts(store), before, '事务应整体回滚');
  assert.equal(store.getWatermark('main'), 0);
  assert.equal(store.getBoardState('main').staged_revision, null);
});

// ---------------------------------------------------- 成功路径 + 水位推进

test('consolidate：成功写 episode/facts/reminders/consolidation 并只 staged 状态板', async (t) => {
  const store = openStore(t);
  const llm = fakeLlm(makeDraft({
    reminders: [
      { kind: 'todo', title: '订展览票', due_at: BASE + 2 * DAY, due_granularity: 'day' },
    ],
  }));

  const result = await consolidate({
    store,
    scope: 'main',
    seqFrom: 1,
    seqTo: 10,
    llm,
    now: BASE + 300,
  });

  assert.deepEqual(llm.calls, [{
    scope: 'main',
    seqFrom: 1,
    seqTo: 10,
    regionText: '',
    textSource: 'transcript',
    transcript: [],
  }]);
  assert.equal(result.skipped, false);
  assert.equal(result.upto_seq, 10);
  assert.equal(result.facts, 1);
  assert.match(result.episodeId, /^ep_/);

  const consolidation = store.db
    .prepare('SELECT * FROM consolidations WHERE scope = ? AND upto_seq = ?')
    .get('main', 10);
  assert.equal(consolidation.status, 'written');
  assert.equal(consolidation.trigger, 'idle');
  assert.equal(consolidation.turn_from, 1);
  assert.equal(consolidation.turn_to, 10);

  const episode = store.getEpisode(result.episodeId);
  assert.equal(episode.title, '聊了周末安排');
  assert.equal(episode.consolidation_id, consolidation.id);

  const facts = store.listFacts({ scope: 'main' });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source_kind, 'consolidated');
  assert.equal(facts[0].source_episode_id, result.episodeId);

  const reminders = store.listReminders({ scope: 'main' });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].title, '订展览票');
  assert.equal(reminders[0].status, 'pending');
  assert.equal(reminders[0].source_episode_id, result.episodeId);

  assert.equal(store.getWatermark('main'), 10);

  // 状态板：只写 staged_revision=1，已发布 rendered 仍为空 revision=0
  const board = store.getBoardState('main');
  assert.equal(board.revision, 0);
  assert.equal(board.rendered, '');
  assert.equal(board.staged_revision, 1);
  assert.match(board.staged_rendered, /【最近进展】/);
  assert.match(board.staged_rendered, /聊了周末安排/);
  assert.equal(store.getBoard('main'), '');

  const events = store.listEvents({ table_name: 'episodes', action: 'ADD' });
  assert.ok(events.some((event) => event.row_id === result.episodeId && event.actor === 'consolidator'));
});

test('consolidate：水位单调推进，重复同一段不产生重复 episode', async (t) => {
  const store = openStore(t);
  const calls = [];
  const llm = async (args) => {
    calls.push(args);
    return makeDraft({
      episode: { title: `第 ${args.seqTo} 段`, summary: `覆盖到 seq ${args.seqTo}` },
    });
  };

  const first = await consolidate({ store, scope: 'main', seqFrom: 1, seqTo: 10, llm, now: BASE });
  assert.equal(first.skipped, false);
  assert.equal(store.getWatermark('main'), 10);

  const second = await consolidate({
    store,
    scope: 'main',
    seqFrom: 11,
    seqTo: 20,
    llm,
    now: BASE + 60,
    trigger: 'threshold',
  });
  assert.equal(second.skipped, false);
  assert.equal(second.upto_seq, 20);
  assert.equal(store.getWatermark('main'), 20);
  assert.equal(store.listEpisodes({ scope: 'main' }).length, 2);
  assert.equal(
    store.db.prepare("SELECT trigger FROM consolidations WHERE upto_seq = 20").get().trigger,
    'threshold',
  );

  const before = counts(store);
  const repeatedOld = await consolidate({ store, scope: 'main', seqFrom: 1, seqTo: 10, llm, now: BASE + 120 });
  const repeatedCurrent = await consolidate({ store, scope: 'main', seqFrom: 11, seqTo: 20, llm, now: BASE + 120 });

  assert.deepEqual(repeatedOld, { skipped: true, upto_seq: 20, textSource: 'transcript' });
  assert.deepEqual(repeatedCurrent, { skipped: true, upto_seq: 20, textSource: 'transcript' });
  assert.equal(calls.length, 2, '重复段不应再次调用模型');
  assert.deepEqual(counts(store), before, '重复段不应写库');
  assert.equal(store.listEpisodes({ scope: 'main' }).length, 2);
});

test('consolidate：facts 按 key+value 去重（库内已存在 + 草稿内部重复都跳过）', async (t) => {
  const store = openStore(t);
  store.insertFact({
    kind: 'preference',
    subject_text: '用户',
    predicate: '想看',
    object_text: '展',
    statement: '用户周末想看展',
    source_kind: 'user_explicit',
    observed_at: BASE - DAY,
  });

  const draft = makeDraft({
    facts: [
      { kind: 'preference', subject_text: '用户', predicate: '想看', object_text: '展', statement: '同一件事的另一种说法' },
      { kind: 'preference', subject_text: '用户', predicate: '想看', object_text: '展', statement: '草稿内重复' },
      { kind: 'preference', subject_text: '用户', predicate: '喜欢', object_text: '猫', statement: '用户喜欢猫' },
    ],
  });

  const result = await consolidate({ store, scope: 'main', seqFrom: 1, seqTo: 6, llm: fakeLlm(draft), now: BASE });
  assert.equal(result.facts, 1, '只应插入真正新增的那一条');
  assert.equal(store.listFacts({ scope: 'main' }).length, 2);
});

test('consolidate：scope 隔离，线程水位互不影响', async (t) => {
  const store = openStore(t);
  const llm = fakeLlm(makeDraft({ facts: [], reminders: [] }));

  await consolidate({ store, scope: 'thread:housing', seqFrom: 1, seqTo: 3, llm, now: BASE });
  await consolidate({ store, scope: 'main', seqFrom: 1, seqTo: 3, llm, now: BASE });

  assert.equal(store.getWatermark('thread:housing'), 3);
  assert.equal(store.getWatermark('main'), 3);
  assert.equal(store.listEpisodes({ scope: 'thread:housing' }).length, 1);
  assert.equal(store.listEpisodes({ scope: 'main' }).length, 1);
  assert.equal(store.getBoardState('thread:housing').staged_revision, 1);
  assert.equal(store.getBoardState('main').staged_revision, 1);
});

// -------------------------------------------------------- 状态板渲染

test('renderBoard：5 个区块始终存在，空输入也不塌缩', () => {
  const text = renderBoard({});
  const titles = ['当前状态', '最近进展', '待办', '线程简表', '提醒'];
  for (const title of titles) assert.ok(text.includes(`【${title}】`), `缺少区块 ${title}`);
  assert.equal(text.split('\n').filter((line) => line.startsWith('【')).length, 5);
  assert.match(text, /（暂无）/);
  assert.ok(estimateBoardTokens(text) <= BOARD_TOKEN_LIMIT);
});

test('renderBoard：四组输入映射到对应区块', () => {
  const at = BASE;
  const text = renderBoard({
    recent: [{ title: '看展计划', summary: '聊了周末看展', started_at: at }],
    facts: [{ statement: '用户想养猫', observed_at: at }],
    threads: [{ key: 'housing', description: '找房', last_progress: '看了两套', last_active_at: at }],
    reminders: [
      { kind: 'todo', title: '订展览票', due_at: at },
      { kind: 'schedule', title: '每月体检', next_fire_at: at },
    ],
  });

  assert.match(sectionOf(text, '当前状态'), /用户想养猫/);
  assert.match(sectionOf(text, '最近进展'), /看展计划/);
  assert.match(sectionOf(text, '待办'), /订展览票/);
  assert.doesNotMatch(sectionOf(text, '待办'), /每月体检/);
  assert.match(sectionOf(text, '线程简表'), /housing/);
  assert.match(sectionOf(text, '线程简表'), /看了两套/);
  assert.match(sectionOf(text, '提醒'), /每月体检/);
  assert.doesNotMatch(sectionOf(text, '提醒'), /订展览票/);
});

test('renderBoard：超 800 token 时按最旧优先裁切，新内容保留', () => {
  const long = '很长的背景描述'.repeat(12);
  const recent = Array.from({ length: 20 }, (_, i) => ({
    title: `标题${i}${long}`,
    summary: long,
    started_at: BASE + i * 60,
  }));
  const facts = Array.from({ length: 30 }, (_, i) => ({
    statement: `事实${i}${long}`,
    observed_at: BASE + i * 60,
  }));
  const threads = Array.from({ length: 15 }, (_, i) => ({
    key: `thread-${i}`,
    description: long,
    last_progress: long,
    last_active_at: BASE + i * 60,
  }));
  const reminders = Array.from({ length: 15 }, (_, i) => ({
    kind: i % 2 === 0 ? 'todo' : 'schedule',
    title: `提醒${i}${long}`,
    due_at: BASE + i * 60,
  }));

  const text = renderBoard({ recent, facts, threads, reminders });
  assert.ok(estimateBoardTokens(text) <= BOARD_TOKEN_LIMIT, `超预算: ${estimateBoardTokens(text)}`);
  assert.ok(text.includes('标题19'), '最新 episode 应保留');
  assert.ok(text.includes('事实29'), '最新 fact 应保留');
  assert.ok(text.includes('thread-14'), '最新 thread 应保留');
});

// -------------------------------------------------------- staged / 发布

test('stageBoard：只写 staged，staged_revision 恒为 revision+1', (t) => {
  const store = openStore(t);
  assert.deepEqual(stageBoard(store, 'main', '第一版'), { revision: 0, staged_revision: 1 });
  assert.deepEqual(stageBoard(store, 'main', '第二版'), { revision: 0, staged_revision: 1 });

  const state = store.getBoardState('main');
  assert.equal(state.rendered, '', '暂存不应发布');
  assert.equal(state.staged_rendered, '第二版');
  assert.equal(state.revision, 0);
  assert.equal(state.staged_revision, 1);
  assert.equal(store.getBoard('main'), '');
});

test('publishBoard：只认白名单 reason（含 forget），且每次把 revision +1', (t) => {
  const store = openStore(t);
  assert.deepEqual(PUBLISH_REASONS, [
    'compact',
    'restart',
    'thread-unarchive',
    'persona-edit',
    'forget',
  ]);

  let revision = 0;
  for (const reason of PUBLISH_REASONS) {
    revision += 1;
    stageBoard(store, 'main', `板-${reason}`);
    assert.equal(publishBoard(store, 'main', reason), revision, `${reason} 应发布成功`);
    assert.equal(store.getBoard('main'), `板-${reason}`);
    // 没有新 staged 时再发布返回 null
    assert.equal(publishBoard(store, 'main', reason), null);
  }

  // 非法 reason：返回 null，且不动 staged / revision
  stageBoard(store, 'main', '待发布');
  const before = store.getBoardState('main');
  for (const reason of ['bogus', '', null, undefined, 'COMPACT', 'thread_archive']) {
    assert.equal(publishBoard(store, 'main', reason), null, `非法 reason 应返回 null: ${String(reason)}`);
  }
  const after = store.getBoardState('main');
  assert.equal(after.revision, before.revision);
  assert.equal(after.staged_revision, before.staged_revision);
  assert.equal(after.staged_rendered, '待发布');
  assert.equal(after.rendered, '板-forget');
});

test('publishBoard：没有 staged 时返回 null（白名单 reason 也一样）', (t) => {
  const store = openStore(t);
  for (const reason of PUBLISH_REASONS) {
    assert.equal(publishBoard(store, 'main', reason), null);
  }
  assert.equal(store.getBoardState('main').revision, 0);
});
