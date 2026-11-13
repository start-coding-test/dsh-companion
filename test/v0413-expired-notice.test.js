import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { buildExpiredNotice, injectExpiredNotices, EXPIRED_SOURCE_KIND } from '../src/reminder/expired-notice.js';
import { lastUserText } from '../src/index.js';

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

function userMessage(text, extra = {}) {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], ...extra };
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
    dueAt: NOW_S - 60,
  }));
  const trimmed = buildExpiredNotice(many, { timeZone: 'Asia/Shanghai' });
  assert.equal(trimmed.split('\n').filter((line) => line.startsWith('- ')).length, 5);
  assert.match(trimmed, /（另有 3 条未列出。）/u);
  assert.equal(buildExpiredNotice([]), '');
  assert.equal(buildExpiredNotice(null), '');
});

test('V70-M1: 提醒投递回合不算用户发言（正文由主干 lastUserText 判定）', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    const { state } = fakeState(store);
    // 宿主把插件投递记成普通 user/message：source.kind='user' + rpcId companion-*。
    const delivery = [
      {
        id: 'd1',
        role: 'user',
        source: { kind: 'user', rpcId: 'companion-reminder:r1' },
        content: [{ type: 'text', text: '[提醒] 交电费\n到点了。' }],
      },
    ];
    const text = lastUserText(delivery);
    assert.equal(text, '', '投递回合不应被视为用户正文');

    const result = await injectExpiredNotices(state, {}, 'turn-delivery', 'main', text);
    assert.equal(result, null);
    assert.equal(store.listUnnotifiedExpired('main').length, 1, '不能标记已告知');
    assert.equal(state.turnSeen.size, 0, '没有正文时不应占用本轮 turnSeen');
  });
});

test('V70-M1: 只有 runtime-context 的回合不注入', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    const { state } = fakeState(store);
    const messages = [
      {
        id: 'c1',
        role: 'user',
        source: { kind: 'runtime-context', form: 'snapshot' },
        content: [{ type: 'text', text: 'This snapshot supersedes earlier runtime-context snapshots.' }],
      },
    ];
    const text = lastUserText(messages);
    assert.equal(text, '');
    assert.equal(await injectExpiredNotices(state, {}, 'turn-ctx', 'main', text), null);
    assert.equal(store.listUnnotifiedExpired('main').length, 1);
  });
});

test('V70-M1: 下一条真实用户消息注入一次并标记', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    insertExpired(store, { title: '拿快递', dueAt: NOW_S - 7200 });
    const { state, logs } = fakeState(store);

    const messages = [
      userMessage('刚到家', { source: { kind: 'user' } }),
    ];
    const text = lastUserText(messages);
    assert.equal(text, '刚到家');

    const result = await injectExpiredNotices(state, {}, 'turn-real', 'main', text);
    assert.ok(result);
    const message = result.inject[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, EXPIRED_SOURCE_KIND);
    assert.equal(message.source.form, 'notice');
    assert.match(message.content[0].text, /有 2 条提醒未能按时送达/u);
    assert.match(message.content[0].text, /交电费/u);
    assert.equal(store.listUnnotifiedExpired('main').length, 0);
    assert.ok(logs.some((entry) => entry.message.includes('expired notice injected')));

    // 同一进程再来一次不再注入。
    assert.equal(
      await injectExpiredNotices(state, {}, 'turn-next', 'main', lastUserText([userMessage('还在吗')])),
      null,
    );

    // 重启（新实例）也不会重复告知。
    assert.equal(
      await injectExpiredNotices(
        fakeState(store).state,
        {},
        'turn-reopen',
        'main',
        lastUserText([userMessage('重启后')]),
      ),
      null,
    );
  });
});

test('injectExpiredNotices: 无过期提醒时不注入', async () => {
  await withStore(async (store) => {
    const { state } = fakeState(store);
    assert.equal(await injectExpiredNotices(state, {}, 'turn-1', 'main', '在吗'), null);
  });
});

test('injectExpiredNotices: 斜杠命令与空正文不触发', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '交电费', dueAt: NOW_S - 3600 });
    const { state } = fakeState(store);
    assert.equal(await injectExpiredNotices(state, {}, 'turn-1', 'main', '/状态'), null);
    assert.equal(await injectExpiredNotices(state, {}, 'turn-2', 'main', '   '), null);
    assert.equal(store.listUnnotifiedExpired('main').length, 1, '两种跳过都不应标记');
  });
});

test('injectExpiredNotices: 其它 scope 的过期提醒不影响本 scope', async () => {
  await withStore(async (store) => {
    insertExpired(store, { title: '线程里的提醒', dueAt: NOW_S - 60, scope: 'thread:t1' });
    const { state } = fakeState(store);
    assert.equal(await injectExpiredNotices(state, {}, 'turn-1', 'main', '你好'), null);
    assert.equal(store.listUnnotifiedExpired('thread:t1').length, 1);
  });
});

test('injectExpiredNotices: store 查询抛错时静默返回 null', async () => {
  const { state, logs } = fakeState({
    listUnnotifiedExpired() {
      throw new Error('boom');
    },
  });
  const result = await injectExpiredNotices(state, {}, 'turn-1', 'main', '你好');
  assert.equal(result, null);
  assert.ok(logs.some((entry) => entry.message.includes('expired notice lookup failed')));
});
