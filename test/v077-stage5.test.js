/**
 * v0.7.7 阶段 5：跨作用域召回范围（T120-M2）、线程进展（T120-M1）、工具文案（T120-L1）。
 *
 * 覆盖面（任务书 5 条验收）：
 *   ① 线程里巩固出的 project 事实能在主会话召回（kind 不限）；
 *   ② 线程召回命中 main 的 identity / preference，main 的 project / knowledge 不出现；
 *   ③ 主会话召回不出现线程情景原文；
 *   ④ threads.last_progress 取回执结论首句（含无结论段的降级截断）；
 *   ⑤ task_run / thread_run 描述含 T120-L1 的三句文案。
 * 另含 5a：Store.searchBigram / listEpisodes 的 scope 集合支持。
 *
 * ⚠️ 非真机证据：事实/情景/线程行全部构造，未回放 50041 云端快照；
 * 宿主子代理与模型调用均为 mock。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Store } from '../src/memory/store.js';
import { retrieve } from '../src/memory/retrieve.js';
import { progressFromReceipt } from '../src/task/receipt.js';
import { recallScopes } from '../src/index.js';
import { createTools } from '../src/runtime/tools.js';

const NOW = 1_790_000_000; // 固定时钟（秒）
const NOW_MS = NOW * 1000;

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function seedFact(store, input) {
  return store.insertFact({
    source_kind: 'turn',
    salience: 'normal',
    observed_at: NOW,
    last_reinforced_at: NOW,
    ...input,
  });
}

function seedEpisode(store, input) {
  return store.insertEpisode({
    session_id: `session-${input.scope}`,
    started_at: NOW,
    ended_at: NOW,
    salience: 'normal',
    fidelity: 'full',
    ...input,
  });
}

/** 与 index.js 的 recallScopes 同一口径（主会话）。 */
function mainScopes(threadKeys) {
  return {
    factScopes: ['main', ...threadKeys.map((key) => `thread:${key}`)],
    episodeScopes: ['main'],
    attachedScopes: null,
    attachedKinds: null,
  };
}

/** 与 index.js 的 recallScopes 同一口径（线程）。 */
function threadScopes(key) {
  return {
    factScopes: [`thread:${key}`, 'main'],
    episodeScopes: [`thread:${key}`],
    attachedScopes: ['main'],
    attachedKinds: ['identity', 'preference'],
  };
}

// ------------------------------------------------------------ 5a：scope 集合

describe('T120-M2（5a）：scope 集合 API', () => {
  test('searchBigram 接受集合：线程可含 main、main 不含他人线程、单值仍隔离', (t) => {
    const store = openStore(t);
    seedFact(store, {
      scope: 'main', kind: 'preference', subject_text: '咖啡',
      predicate: '喜欢', object_text: '美式', statement: '咖啡只喝美式。',
    });
    seedFact(store, {
      scope: 'thread:deploy', kind: 'project', subject_text: 'flux',
      predicate: '数据集', object_text: '本地', statement: 'flux 数据集在本地。',
    });
    seedFact(store, {
      scope: 'thread:other', kind: 'project', subject_text: 'flux',
      predicate: '数据集', object_text: '远端', statement: 'flux 数据集在远端。',
    });

    const mainOnly = store.searchBigram('数据集', { scope: 'main' });
    assert.equal(mainOnly.length, 0, '单值 main 不含任何线程事实');

    const threadView = store.searchBigram('数据集', { scope: ['thread:deploy', 'main'] });
    assert.deepEqual(threadView.map((row) => row.scope), ['thread:deploy']);

    const mainView = store.searchBigram('数据集', { scope: ['main', 'thread:deploy'] });
    assert.deepEqual(mainView.map((row) => row.scope), ['thread:deploy']);

    const all = store.searchBigram('数据集', { scope: ['main', 'thread:deploy', 'thread:other'] });
    assert.equal(all.length, 2);

    // 空集合不炸，也不返回任何行。
    assert.deepEqual(store.searchBigram('数据集', { scope: [] }), []);
  });

  test('listEpisodes 接受集合：作用域隔离与单值兼容', (t) => {
    const store = openStore(t);
    seedEpisode(store, { scope: 'main', title: '主会话情景', summary: '主线。' });
    seedEpisode(store, { scope: 'thread:deploy', title: '部署情景', summary: '部署线。' });

    assert.equal(store.listEpisodes({ scope: 'main' }).length, 1);
    assert.equal(store.listEpisodes({ scope: 'thread:deploy' }).length, 1);
    assert.equal(store.listEpisodes({ scope: ['main', 'thread:deploy'] }).length, 2);
    assert.equal(store.listEpisodes({ scope: ['thread:deploy'] }).length, 1);
  });
});

// ------------------------------------------------- 验收① 线程事实回主会话

describe('验收①：线程巩固出的 project 事实能在主会话召回', () => {
  test('主会话 scope 集含线程时命中 project 事实（不限 kind）', async (t) => {
    const store = openStore(t);
    seedFact(store, {
      scope: 'thread:deploy',
      kind: 'project',
      subject_text: 'flux',
      predicate: '训练用数据集',
      object_text: 'flux 数据集',
      statement: 'LoRA 训练用 flux 数据集，路径在 D:/data/flux。',
    });

    const before = await retrieve({ store, query: 'flux 数据集', now: NOW_MS, ...mainScopes([]) });
    assert.deepEqual(before.items, [], '没有线程 scope 时主会话看不到线程事实');

    const after = await retrieve({ store, query: 'flux 数据集', now: NOW_MS, ...mainScopes(['deploy']) });
    assert.ok(after.items.length >= 1, '主会话应召回线程里的 project 事实');
    assert.match(after.items[0].text, /flux 数据集/u);
  });

  test('recallScopes：主会话 facts 含活跃线程、episodes 只含 main', (t) => {
    const store = openStore(t);
    store.upsertThread({ key: 'deploy', name: '部署', description: '部署线程', session_id: 'sess-deploy', status: 'active' });
    store.upsertThread({ key: 'old', name: '旧线', description: '归档线程', session_id: 'sess-old', status: 'archived' });

    const scopes = recallScopes(store, 'main');
    assert.deepEqual(scopes.factScopes, ['main', 'thread:deploy']);
    assert.deepEqual(scopes.episodeScopes, ['main']);
    assert.equal(scopes.attachedScopes, null);

    const thread = recallScopes(store, 'thread:deploy');
    assert.deepEqual(thread.factScopes, ['thread:deploy', 'main']);
    assert.deepEqual(thread.episodeScopes, ['thread:deploy']);
    assert.deepEqual(thread.attachedScopes, ['main']);
    assert.deepEqual(thread.attachedKinds, ['identity', 'preference']);
  });
});

// -------------------------------------- 验收② 线程召回 main 的身份偏好

describe('验收②：线程召回 main 的身份偏好，不召回 main 的工程事实', () => {
  test('identity/preference 放行，project/knowledge 被行级过滤', async (t) => {
    const store = openStore(t);
    seedFact(store, {
      scope: 'main', kind: 'identity', subject_text: '用户称呼',
      predicate: '称呼', object_text: '老板', statement: '用户希望被称呼为老板，别叫先生。',
    });
    seedFact(store, {
      scope: 'main', kind: 'preference', subject_text: '咖啡',
      predicate: '喜欢', object_text: '美式', statement: '咖啡只喝美式，不加糖。',
    });
    seedFact(store, {
      scope: 'main', kind: 'project', subject_text: '部署',
      predicate: '进行中', object_text: '近期', statement: '部署项目进行中，先跑冒烟。',
    });
    seedFact(store, {
      scope: 'main', kind: 'knowledge', subject_text: '冒烟',
      predicate: '含义', object_text: '快速验证', statement: '冒烟指快速验证主链路。',
    });

    const identity = await retrieve({ store, query: '称呼 老板', now: NOW_MS, ...threadScopes('deploy') });
    assert.ok(identity.items.some((item) => /老板/u.test(item.text)), '应召回 main 的身份事实');

    const preference = await retrieve({ store, query: '咖啡 美式', now: NOW_MS, ...threadScopes('deploy') });
    assert.ok(preference.items.some((item) => /美式/u.test(item.text)), '应召回 main 的偏好事实');

    const project = await retrieve({ store, query: '部署 冒烟', now: NOW_MS, ...threadScopes('deploy') });
    assert.deepEqual(project.items, [], 'main 的 project/knowledge 不往线程灌');

    // 同一批候选在主会话（无 kind 限制）里是可见的。
    const mainView = await retrieve({ store, query: '部署 冒烟', now: NOW_MS, ...mainScopes([]) });
    assert.ok(mainView.items.length >= 1);
  });
});

// ------------------------------------ 验收③ 主会话不出现线程情景原文

describe('验收③：主会话召回不含线程情景', () => {
  test('线程 episode 不进主会话 items 文本', async (t) => {
    const store = openStore(t);
    seedFact(store, {
      scope: 'main', kind: 'project', subject_text: 'flux',
      predicate: '数据集', object_text: '本地', statement: 'flux 数据集在本地。',
    });
    seedEpisode(store, {
      scope: 'thread:deploy',
      title: '线程情景标题',
      summary: '线程情景原文：部署当天数据库锁住了三次。',
    });

    const own = await retrieve({
      store,
      query: '线程情景 原文',
      now: NOW_MS,
      ...threadScopes('deploy'),
    });
    assert.ok(
      own.items.some((item) => item.kind === 'episode' && /数据库锁住/u.test(item.text)),
      '本线程能看到自己的情景',
    );

    const main = await retrieve({ store, query: '线程情景 原文', now: NOW_MS, ...mainScopes(['deploy']) });
    assert.ok(
      main.items.every((item) => !/数据库锁住/u.test(item.text)),
      '主会话不得出现线程情景原文',
    );
  });
});

// --------------------------------------------- 验收④ 线程进展取回执首句

describe('验收④：last_progress 取回执结论首句', () => {
  test('有结论段取首句；空结论段返回 null', () => {
    const text = '状态：成功｜结论：已跑通 flux 数据集训练。第二轮在调参。｜产物：a.pt｜耗时：1.2s';
    assert.equal(progressFromReceipt(text), '已跑通 flux 数据集训练');
    assert.equal(progressFromReceipt('状态：失败｜结论：｜产物：｜耗时：0ms'), null);
    assert.equal(progressFromReceipt(''), null);
    assert.equal(progressFromReceipt(null), null);
  });

  test('无结论段时降级为首句，超长截断到 120 码点', () => {
    assert.equal(progressFromReceipt('没有结论段的裸回执，后面这句不要。'), '没有结论段的裸回执');
    const long = `状态：成功｜结论：${'长'.repeat(300)}｜耗时：1s`;
    const progress = progressFromReceipt(long);
    assert.equal([...progress].length, 120);
    assert.ok(progress.endsWith('…'));
  });

  test('线程行上的 last_progress 可被 upsertThread 回写并读回', (t) => {
    const store = openStore(t);
    const thread = store.upsertThread({
      key: 'deploy', name: '部署', description: '部署线程', session_id: 'sess-deploy',
      last_progress: '开线', last_active_at: NOW, status: 'active',
    });
    const next = progressFromReceipt('状态：成功｜结论：镜像已推到 registry。｜耗时：2s');
    store.upsertThread({ ...thread, last_progress: next, last_active_at: NOW + 60 });
    const reread = store.getThread('deploy');
    assert.equal(reread.last_progress, '镜像已推到 registry');
    assert.equal(reread.last_active_at, NOW + 60);
  });
});

// --------------------------------------------------------- 验收⑤ 工具文案

describe('验收⑤：工具描述含 T120-L1 口径', () => {
  test('task_run 指向一次性活、thread_run 指向多天沿用并要求先 thread_list', () => {
    const tools = createTools({
      store: Store.open(':memory:'),
      platform: { log: () => {}, capabilities: {} },
      nowMs: () => NOW_MS,
    });
    const taskRun = tools.find((tool) => tool.name === 'task_run');
    const threadRun = tools.find((tool) => tool.name === 'thread_run');
    assert.ok(taskRun && threadRun);

    assert.match(taskRun.description, /一次性的活/u);
    assert.match(taskRun.description, /thread_run/u);
    assert.match(threadRun.description, /多天反复推进/u);
    assert.match(threadRun.description, /task_run/u);
    assert.match(threadRun.description, /thread_list/u);
  });
});
