/**
 * t17：SQLite BUSY/LOCKED 时事务入口的有界重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store, isBusyError } from '../src/memory/store.js';

function openStore(t) {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  return store;
}

function busyError(code = 'SQLITE_BUSY') {
  const error = new Error('database is locked');
  error.code = code;
  return error;
}

test('isBusyError 识别 SQLITE_BUSY / LOCKED 与常见文案', () => {
  assert.equal(isBusyError(busyError('SQLITE_BUSY')), true);
  assert.equal(isBusyError(busyError('SQLITE_LOCKED')), true);
  assert.equal(isBusyError(new Error('database is busy')), true);
  assert.equal(isBusyError(new Error('database table is locked')), true);
  assert.equal(isBusyError(new Error('disk full')), false);
  assert.equal(isBusyError(null), false);
});

test('transaction 遇到 BUSY 会重试并在成功后提交', (t) => {
  const store = openStore(t);
  const realExec = store.db.exec.bind(store.db);
  let begins = 0;
  store.db.exec = (sql) => {
    if (sql === 'BEGIN IMMEDIATE') {
      begins += 1;
      if (begins < 3) throw busyError();
    }
    return realExec(sql);
  };
  t.after(() => {
    store.db.exec = realExec;
  });

  const result = store.transaction(() => 42);
  assert.equal(result, 42);
  assert.equal(begins, 3);
});

test('transaction BUSY 重试 3 次后抛出原始错误', (t) => {
  const store = openStore(t);
  const realExec = store.db.exec.bind(store.db);
  let begins = 0;
  store.db.exec = (sql) => {
    if (sql === 'BEGIN IMMEDIATE') {
      begins += 1;
      throw busyError('SQLITE_BUSY');
    }
    return realExec(sql);
  };
  t.after(() => {
    store.db.exec = realExec;
  });

  assert.throws(() => store.transaction(() => 1), (error) => {
    assert.equal(error.code, 'SQLITE_BUSY');
    return true;
  });
  assert.equal(begins, 4);
});

test('transaction 非 BUSY 错误不重试且原样抛出', (t) => {
  const store = openStore(t);
  const realExec = store.db.exec.bind(store.db);
  let begins = 0;
  store.db.exec = (sql) => {
    if (sql === 'BEGIN IMMEDIATE') {
      begins += 1;
      throw new Error('disk full');
    }
    return realExec(sql);
  };
  t.after(() => {
    store.db.exec = realExec;
  });

  assert.throws(() => store.transaction(() => 1), /disk full/u);
  assert.equal(begins, 1);
});
