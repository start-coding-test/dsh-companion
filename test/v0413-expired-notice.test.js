import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { buildExpiredNotice, injectExpiredNotices, EXPIRED_SOURCE_KIND } from '../src/reminder/expired-notice.js';

const NOW_MS = Date.UTC(2026, 10, 13, 2, 0, 0); // 2026-11-13 10:00 +08
const NOW_S = Math.floor(NOW_MS / 1000);

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-expired-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    return await fn(store);
  } finally {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeState(store, overrides = {}) {
  const logs = [];
  const state = {
    store,
    config: { timezone: 'Asia/Shanghai' },
    turnSeen: new Set(),
    platform: {
      now: () => NOW_MS,
      log: (level, message, meta) => logs.push({ level, message, meta }),
    },
    ...overrides,
  };
  return { state, logs };
}

function userMessages(text) {
  return [
    { id: 'u1', role: 'user', content: [{ type: 'text', text }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '我在。' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text }] },
  ];
}

/** 造一条已过期、未通知的提醒（重试用尽的那条路径）。 */
function insertExpired(store, { title, dueAt, scope = 'main' }) {
  const row = store.insertReminder({
    scope,
    title,
    kind: 'todo',
    due_at: dueAt,
    next_fire_at: dueAt,
    status: 'pending',
  });
  store.expireReminder(row.id);
  return row.id;
}

test('buildExpiredNotice: 条数、标题、原定时间（本地时区）与上限', () => {
  const rows = [
    { id: 'r1', title: '交电费', due_at: NOW_S - 3600 },
    { id: 'r2', title: '开会', due_at: NOW_S - 86400 },
  ];
  const text = buildExpiredNotice(rows, { timeZone: 'Asia/Shanghai' });
  assert.match(text, /^有 2 条提醒未能按时送达：/u);
  assert.match(text, /- 交电费（原定 11-13 09:00）/u);
  assert.match(text, /- 开会（原定 11-12 10:00）/u);
  assert.equal(text.includes('另有'), false);

  const many = Array.from({ length: 8 }, (_, index) => ({
    id: `m${index}`,
    title: `提醒${index}`,
    due_at: NOW_S - 60,
  }));
  const trimmed = buildExpiredNotice(many, { timeZone: 'Asia/Shanghai' });
  assert.equal(trimmed.split('\n').filter((line) => line.startsWith('- ')).length, 5);
  assert.match(trimmed, /（另有 3 条未列出。）/u);
  assert.equal(buildExpiredNotice([]), '');
  assert.equal(buildExpiredNotice(null), '');
});

test('injectExpiredNotices: 宿主真实正文（source.kind=user）能被识别（H-1）', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    const { state } = fakeState(store);
    const hostMessages = [
      { id: 'h1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '刚到家' }] },
    ];
    const result = await injectExpiredNotices(state, {}, hostMessages, 'turn-host', 'main');
    assert.ok(result, '宿主的 source.kind=user 不应被当成注入消息');
    assert.equal(result.inject.length, 1);
  });
});

test('injectExpiredNotices: 无过期提醒时不注入', async () => {
  await withStore(async (store) => {
    const { state } = fakeState(store);
    const result = await injectExpiredNotices(state, {}, userMessages('在吗'), 'turn-1', 'main');
    assert.equal(result, null);
  });
});

test('injectExpiredNotices: 注入一条 companion-expired 通知并标记已告知', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    insertExpired(store, { title: '拿快递', dueAt: NOW_S - 7200 });
    const { state, logs } = fakeState(store);

    const result = await injectExpiredNotices(state, {}, userMessages('晚上好'), 'turn-1', 'main');
    assert.ok(result);
    assert.equal(result.inject.length, 1);
    const message = result.inject[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, EXPIRED_SOURCE_KIND);
    assert.equal(message.source.form, 'notice');
    assert.match(message.content[0].text, /有 2 条提醒未能按时送达/u);
    assert.match(message.content[0].text, /交电费/u);
    assert.ok(logs.some((entry) => entry.message.includes('expired notice injected')));

    // 已打标：同一进程再来一次不再注入。
    const again = await injectExpiredNotices(state, {}, userMessages('还在吗'), 'turn-2', 'main');
    assert.equal(again, null);
    assert.equal(store.listUnnotifiedExpired('main').length, 0);

    // 重启（新实例）也不会重复告知。
    const reopened = await injectExpiredNotices(
      fakeState(store).state,
      {},
      userMessages('重启后'),
      'turn-3',
      'main',
    );
    assert.equal(reopened, null);
  });
});

test('injectExpiredNotices: 斜杠命令与注入消息不触发', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    const { state } = fakeState(store);
    assert.equal(await injectExpiredNotices(state, {}, userMessages('/状态'), 'turn-1', 'main'), null);
    assert.equal(store.listUnnotifiedExpired('main').length, 1);

    const injectedOnly = [
      {
        id: 'x1',
        role: 'user',
        content: [{ type: 'text', text: '召回内容' }],
        source: { kind: 'companion-recall', form: 'snapshot' },
      },
    ];
    assert.equal(await injectExpiredNotices(state, {}, injectedOnly, 'turn-2', 'main'), null);
    assert.equal(store.listUnnotifiedExpired('main').length, 1);
  });
});

test('injectExpiredNotices: 其它 scope 的过期提醒不影响本 scope', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '线程里的提醒', dueAt: NOW_S - 60, scope: 'thread:t1' });
    const { state } = fakeState(store);
    assert.equal(await injectExpiredNotices(state, {}, userMessages('你好'), 'turn-1', 'main'), null);
    assert.equal(store.listUnnotifiedExpired('thread:t1').length, 1);
  });
});

test('injectExpiredNotices: store 查询抛错时静默返回 null', async () => {
  const { state, logs } = fakeState({
    listUnnotifiedExpired() {
      throw new Error('boom');
    },
  });
  const result = await injectExpiredNotices(state, {}, userMessages('你好'), 'turn-1', 'main');
  assert.equal(result, null);
  assert.ok(logs.some((entry) => entry.message.includes('expired notice lookup failed')));
});
