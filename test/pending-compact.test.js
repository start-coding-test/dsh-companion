/**
 * N-M1：每个 scope 一个待压缩槽。
 *
 * 覆盖：set/peek/take 的独立性、参数校验、重启恢复（多 scope + 最新一条）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../src/memory/store.js';
import {
  createPendingCompacts,
  peekPendingCompact,
  recoverPendingCompacts,
  setPendingCompact,
  takePendingCompact,
} from '../src/state/pending-compact.js';

test('pending-compact：set/peek/take 按 scope 隔离', () => {
  const map = createPendingCompacts();
  setPendingCompact(map, { id: 'a', startSeq: 3, endSeq: 9, scope: 'main' });
  setPendingCompact(map, { id: 'b', startSeq: 4, endSeq: 8, scope: 'thread:t1' });

  assert.equal(peekPendingCompact(map, 'main').endSeq, 9);
  assert.equal(peekPendingCompact(map, 'thread:t1').endSeq, 8);
  assert.equal(peekPendingCompact(map, 'thread:t2'), null);

  setPendingCompact(map, { startSeq: 10, endSeq: 12, scope: 'main' });
  assert.equal(peekPendingCompact(map, 'main').id, null, '同 scope 覆盖，id 缺省为 null');
  assert.equal(peekPendingCompact(map, 'main').startSeq, 10);

  const taken = takePendingCompact(map, 'main');
  assert.equal(taken.endSeq, 12);
  assert.equal(peekPendingCompact(map, 'main'), null);
  assert.equal(peekPendingCompact(map, 'thread:t1').endSeq, 8, '拿掉 main 不影响线程槽');
});

test('pending-compact：非法输入抛 TypeError', () => {
  const map = createPendingCompacts();
  assert.throws(() => setPendingCompact(map, null), /pending/);
  assert.throws(() => setPendingCompact(map, { scope: '', startSeq: 1, endSeq: 2 }), /scope/);
  assert.throws(() => setPendingCompact({}, { scope: 'main', startSeq: 1, endSeq: 2 }), /Map/);
});

test('pending-compact：重启按 scope 恢复最新一条 nap，不再只恢复 main', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  store.insertConsolidation({
    id: 'cs-main', scope: 'main', kind: 'nap', status: 'written',
    session_id: 's-main', trigger: 'idle', upto_seq: 20, turn_from: 18,
    compaction_start_seq: 18, started_at: 100,
  });
  store.insertConsolidation({
    id: 'cs-main-old', scope: 'main', kind: 'nap', status: 'written',
    session_id: 's-main', trigger: 'idle', upto_seq: 10, turn_from: 10,
    compaction_start_seq: 10, started_at: 50,
  });
  store.insertConsolidation({
    id: 'cs-t1', scope: 'thread:t1', kind: 'nap', status: 'written',
    session_id: 's-t1', trigger: 'idle', upto_seq: 31, turn_from: 28,
    compaction_start_seq: 28, started_at: 120,
  });
  store.insertConsolidation({
    id: 'cs-compacted', scope: 'thread:t2', kind: 'nap', status: 'compacted',
    session_id: 's-t2', trigger: 'idle', upto_seq: 40, turn_from: 40,
    compaction_start_seq: 40, started_at: 130,
  });

  const map = recoverPendingCompacts(store);
  assert.equal(map.size, 2, '只恢复 written 的两个 scope');
  assert.deepEqual(peekPendingCompact(map, 'main'), {
    id: 'cs-main', startSeq: 18, endSeq: 20, scope: 'main',
  });
  assert.deepEqual(peekPendingCompact(map, 'thread:t1'), {
    id: 'cs-t1', startSeq: 28, endSeq: 31, scope: 'thread:t1',
  });
  assert.equal(peekPendingCompact(map, 'thread:t2'), null);
});
