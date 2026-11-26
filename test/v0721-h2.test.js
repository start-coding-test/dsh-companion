// ⚠️ 非真机证据
/**
 * v0.7.21 H2：s2-purge 毫秒当秒 + 存量 PURGED.at 迁移（非真机证据）。
 *
 * 判别力：全部走真实生产接线（apply() 启动的真实 scheduler catch-up 调用真实
 * jobs['s2-purge']），不拿手拼 store.purge 冒充接线；直接 store.purge 的用例
 * 只用于锁 toEpoch 的毫秒防御。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeCtx } from './fakes/ctx.js';
import { apply as applyCordis } from '../src/index.js';
import { Store } from '../src/memory/store.js';
import { strictCtx } from './helpers/strict-ctx.js';
import { makeTempStore } from './e2e/helpers.js';

const apply = (ctx, config, hooks) => applyCordis(strictCtx(ctx), config, hooks);

/** Asia/Shanghai 2026-11-04 03:31：s2-purge 计划 03:30 落在 6h 补扫窗口内。 */
const NOW_MS = Date.parse('2026-11-04T03:31:00+08:00');
const NOW_SEC = Math.floor(NOW_MS / 1000);
const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
const MARKER = 'purged_event_at_seconds_v0721';

/**
 * FakeCtx + apply 需要的三个平台面；s2-purge 不碰模型，真被调用即视为接线异常。
 * @returns {{ctx: FakeCtx}}
 */
function makeApplyCtx() {
  const ctx = new FakeCtx({ now: NOW_MS });
  ctx.addSession({ id: 'session-1' });
  ctx.commands = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.tools = {
    registrations: [],
    register(definition) {
      this.registrations.push(definition);
      return () => {};
    },
  };
  ctx.llm = {
    listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
    listModels: (providerId) => (providerId === 'fake-provider' ? [{ id: 'fake-model', name: 'Fake Model' }] : []),
    async *stream() {
      throw new Error('H2 test: s2-purge 不应调用模型');
    },
  };
  ctx.returns['tokenMeter.measure'] = {
    logRevision: 1,
    baseline: null,
    surfaceDeltaTokens: 0,
    totalTokens: 0,
    surfaceTokens: 0,
    nodes: [],
  };
  return { ctx };
}

/**
 * 种一条已遗忘（tombstoned）的 fact，deleted_at 精确等于给定秒。
 * @param {Store} store
 * @param {number} atSeconds
 * @param {string} label
 * @returns {object}
 */
function seedTombstone(store, atSeconds, label) {
  const fact = store.insertFact({
    kind: 'knowledge',
    subject_text: label,
    predicate: '状态',
    object_text: '已遗忘',
    statement: `${label} 已经遗忘。`,
    source_kind: 'turn',
    observed_at: atSeconds,
    last_reinforced_at: atSeconds,
    salience: 'normal',
  });
  assert.equal(store.forgetFact(fact.id, { at: atSeconds }), true, `seedTombstone: ${label} 应可转 tombstoned`);
  return fact;
}

/**
 * 绕过 Store API 直接写 memory_events（append-only 只拦 UPDATE/DELETE）。
 * @param {Store} store
 * @param {{at: number, action?: string, tableName?: string, actor?: string,
 *          reason?: string, detail?: object|null}} input
 * @returns {number}
 */
function rawInsertEvent(store, {
  at,
  action = 'PURGED',
  tableName = 'facts',
  actor = 'scheduler',
  reason = 'purge',
  detail = null,
}) {
  return Number(
    store.db
      .prepare(
        `INSERT INTO memory_events (at, action, table_name, row_id, actor, reason, detail_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(at, action, tableName, actor, reason, detail === null ? null : JSON.stringify(detail))
      .lastInsertRowid,
  );
}

/** @param {Store} store @param {number|bigint} id @returns {number} */
function eventAt(store, id) {
  return Number(store.db.prepare('SELECT at FROM memory_events WHERE id = ?').get(id).at);
}

/** @param {Store} store @param {string} id @returns {number} */
function factRowCount(store, id) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE id = ?').get(id).n);
}

/** @param {Store} store @returns {object[]} */
function migratorRepairEvents(store) {
  return store.db
    .prepare(
      `SELECT detail_json FROM memory_events
        WHERE action = 'UPDATE' AND actor = 'migrator' AND reason = 'v21-purged-at-ms-repair'
        ORDER BY id`,
    )
    .all();
}

/** @param {Store} store @param {string} name @returns {boolean} */
function triggerExists(store, name) {
  return store.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(name).n > 0;
}

test('H2-001（v0.7.21 非真机证据）：真实 apply 启动的 s2-purge catch-up 按秒计算冷静期并写秒级 PURGED.at', async () => {
  // 判别力：若 src/index.js 的 s2-purge 仍把 platform.now()（毫秒）传给 purge，
  // cutoff 会远大于任何秒级 deleted_at，6 天 tombstone 与 7 天内情绪事件会被误删，
  // 且 PURGED.at 变成 13 位毫秒；本用例的三组断言会分别变红。
  // toEpoch 防御上线后行为可能被兜住，故另有 purge 入参单位断言锁接线本身。
  const temp = makeTempStore();
  const keptFact = seedTombstone(temp.store, NOW_SEC - 6 * DAY_SECONDS, '六天前的遗忘事实');
  const goneFact = seedTombstone(temp.store, NOW_SEC - 8 * DAY_SECONDS, '八天前的遗忘事实');
  const keptEmotion = temp.store.appendEmotionEvent('main', {
    at: NOW_MS - 6 * DAY_MS,
    type: 'joy',
    deltas: { pleasure: 2, arousal: 1, dominance: 0, energy: 0 },
  });
  const goneEmotion = temp.store.appendEmotionEvent('main', {
    at: NOW_MS - 8 * DAY_MS,
    type: 'confide',
    deltas: { pleasure: 1, arousal: 0, dominance: 0, energy: 0 },
  });

  const { ctx } = makeApplyCtx();
  // 判别力（接线单位）：toEpoch 的毫秒防御会把错误单位兜住，行为层面可能看不出差别，
  // 所以额外只读观测真实 jobs['s2-purge'] 传给 store.purge 的 now——它必须是 Unix 秒。
  const originalPurge = Store.prototype.purge;
  const purgeNowArgs = [];
  Store.prototype.purge = function observePurgeNow(options = {}) {
    purgeNowArgs.push(options.now);
    return originalPurge.call(this, options);
  };
  let handle;
  try {
    handle = apply(ctx, { dbPath: temp.dbPath });
    // s2-purge 在 scheduler.start() 的 catch-up 中同步执行；等同一轮 deep-sleep /
    // thread-freeze 的异步收尾，避免它们在断言期继续写库。
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(factRowCount(temp.store, keptFact.id), 1,
      '6 天 tombstone 未过 7 天冷静期，真实 s2-purge 不应物删');
    assert.equal(factRowCount(temp.store, goneFact.id), 0,
      '8 天 tombstone 已过 7 天冷静期，真实 s2-purge 应物删');

    const keptEmotionRows = temp.store.db
      .prepare('SELECT COUNT(*) AS n FROM emotion_events WHERE id = ?')
      .get(keptEmotion.id).n;
    assert.equal(Number(keptEmotionRows), 1,
      '7 天内的 emotion_events（毫秒口径）必须保留');
    const goneEmotionRows = temp.store.db
      .prepare('SELECT COUNT(*) AS n FROM emotion_events WHERE id = ?')
      .get(goneEmotion.id).n;
    assert.equal(Number(goneEmotionRows), 0,
      '7 天外的 emotion_events 才应被 s2-purge 清掉');

    const purged = temp.store.db
      .prepare("SELECT at, table_name FROM memory_events WHERE action = 'PURGED' ORDER BY id")
      .all();
    assert.ok(purged.length >= 1, '真实 s2-purge 应写 PURGED 审计');
    for (const row of purged) {
      assert.equal(Number(row.at), NOW_SEC,
        `PURGED.at 必须是 Unix 秒（${NOW_SEC}），实际 ${row.at}`);
    }
    assert.ok(
      purged.some((row) => row.table_name === 'emotion_events'),
      '情绪事件被清掉时应写 table_name=emotion_events 的 PURGED 审计',
    );
    // schema_version 不因 H2 改动（硬约束）。
    assert.equal(temp.store.getMeta('schema_version'), '16');

    // 接线层：真实 s2-purge 调用 store.purge 的 now 必须是秒，不能靠 toEpoch 兜底。
    assert.equal(purgeNowArgs.length >= 1, true, 's2-purge 必须真实调用 store.purge');
    for (const nowArg of purgeNowArgs) {
      assert.equal(typeof nowArg, 'number');
      assert.equal(Number.isInteger(nowArg), true, `purge 的 now 必须是整数秒，实际 ${nowArg}`);
      assert.ok(Math.abs(nowArg) < 1e11,
        `s2-purge 传给 purge 的 now 必须是秒（<1e11），实际 ${nowArg}`);
    }
  } finally {
    Store.prototype.purge = originalPurge;
    handle?.dispose();
    temp.cleanup();
  }
});

test('H2-002（v0.7.21 非真机证据）：toEpoch 对毫秒 number/bigint 按 1e11 阈值换算，直接 purge 也得到秒语义', () => {
  // 判别力：删掉 toEpoch 的 1e11 阈值（退回 Math.trunc / Number(bigint)）后，
  // purge 的 cutoff 会按毫秒减 7 天，6 天 tombstone 被一并误删，PURGED.at 变 13 位。
  const temp = makeTempStore();
  try {
    const kept = seedTombstone(temp.store, NOW_SEC - 6 * DAY_SECONDS, '防御-六天');
    const gone = seedTombstone(temp.store, NOW_SEC - 8 * DAY_SECONDS, '防御-八天');
    const result = temp.store.purge({ now: NOW_MS, cutoffDays: 7 });
    assert.deepEqual(result, { facts: 1, episodes: 0 },
      '毫秒 now 应等价于秒 now：只删 8 天前的 tombstone');
    assert.equal(factRowCount(temp.store, kept.id), 1);
    assert.equal(factRowCount(temp.store, gone.id), 0);
    const last = temp.store.db
      .prepare("SELECT at FROM memory_events WHERE action = 'PURGED' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(Number(last.at), NOW_SEC, 'purge 审计 at 应是秒而不是毫秒');

    // BigInt 毫秒同样要过 1e11 阈值（旧实现 Number(bigint) 直接当秒）。
    const goneBig = seedTombstone(temp.store, NOW_SEC - 8 * DAY_SECONDS, '防御-bigint');
    const bigResult = temp.store.purge({ now: BigInt(NOW_MS), cutoffDays: 7 });
    assert.deepEqual(bigResult, { facts: 1, episodes: 0 });
    assert.equal(factRowCount(temp.store, goneBig.id), 0);
    const lastBig = temp.store.db
      .prepare("SELECT at FROM memory_events WHERE action = 'PURGED' ORDER BY id DESC LIMIT 1")
      .get();
    assert.equal(Number(lastBig.at), NOW_SEC, 'BigInt 毫秒也应换算为秒');
  } finally {
    temp.cleanup();
  }
});

test('H2-003（v0.7.21 非真机证据）：存量 PURGED.at 毫秒一次性修正为秒，写唯一 migrator 审计且 detail 只有 rows', () => {
  // 判别力：删掉 UPDATE（或把条件改成 1=0）后目标行仍是 13 位毫秒；
  // 若改成无 WHERE 全表更新，非 PURGED / 秒级对照行也会被改写。
  const temp = makeTempStore();
  try {
    const target1 = rawInsertEvent(temp.store, { at: NOW_MS });
    const target2 = rawInsertEvent(temp.store, { at: NOW_MS - 1000 });
    const secondsControl = rawInsertEvent(temp.store, { at: NOW_SEC - 60 });
    const nonPurgedControl = rawInsertEvent(temp.store, {
      at: NOW_MS,
      action: 'USED',
      tableName: 'scheduler_jobs',
    });
    // 打开空库时迁移已落标记（0 行不写审计）；删掉标记后重开模拟存量库。
    assert.notEqual(temp.store.getMeta(MARKER), null);
    temp.store.deleteMeta(MARKER);
    temp.store.close();

    const reopened = Store.open(temp.dbPath);
    try {
      assert.equal(eventAt(reopened, target1), Math.floor(NOW_MS / 1000),
        'PURGED.at 毫秒应 floor 成秒');
      assert.equal(eventAt(reopened, target2), Math.floor((NOW_MS - 1000) / 1000));
      assert.equal(eventAt(reopened, secondsControl), NOW_SEC - 60,
        '已经是秒的 PURGED 行不能被二次换算');
      assert.equal(eventAt(reopened, nonPurgedControl), NOW_MS,
        '非 PURGED 行即使 at 是 13 位也必须保持原值');

      const repairs = migratorRepairEvents(reopened);
      assert.equal(repairs.length, 1, '恰好一条 migrator 修复审计');
      const detail = JSON.parse(repairs[0].detail_json);
      assert.deepEqual(detail, { rows: 2 }, 'detail 只含修复条数 2');
      assert.deepEqual(Object.keys(detail), ['rows'], 'detail 不得附带正文/时间等其它字段');

      const marker = reopened.getMeta(MARKER);
      assert.notEqual(marker, null, '修复后必须写 schema_meta 标记');
      assert.ok(Number(marker) < 1e11, '标记值是秒级时间戳');
      assert.equal(reopened.getMeta('schema_version'), '16');
    } finally {
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('H2-003b（v0.7.21 非真机证据）：0 行命中只写标记、不写迁移审计', () => {
  // 判别力：若迁移无条件写 audit，新库/无存量库会留下 migrator 噪音，本用例变红。
  const temp = makeTempStore();
  try {
    rawInsertEvent(temp.store, { at: NOW_MS, action: 'USED', tableName: 'scheduler_jobs' });
    temp.store.deleteMeta(MARKER);
    temp.store.close();

    const reopened = Store.open(temp.dbPath);
    try {
      assert.equal(migratorRepairEvents(reopened).length, 0, '0 行命中不得写审计');
      assert.notEqual(reopened.getMeta(MARKER), null, '0 行也要落标记以免每次 open 重扫');
    } finally {
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});

test('H2-004（v0.7.21 非真机证据）：标记存在时重开不重复修复、不覆盖新写入的毫秒行、不重复审计', () => {
  // 判别力：删掉「有标记直接跳过」守卫后，重开会把标记后新写入的毫秒 PURGED 行
  // 也改掉、并重写标记 + 追加第二条审计，本用例三组断言都会变红。
  const temp = makeTempStore();
  try {
    rawInsertEvent(temp.store, { at: NOW_MS });
    temp.store.deleteMeta(MARKER);
    temp.store.close();

    const first = Store.open(temp.dbPath);
    let markerAfterFirst;
    try {
      markerAfterFirst = first.getMeta(MARKER);
      assert.equal(migratorRepairEvents(first).length, 1);
    } finally {
      first.close();
    }

    const second = Store.open(temp.dbPath);
    try {
      // 标记之后又出现一条（理论上不该再出现的）毫秒 PURGED 行。
      const lateMsRow = rawInsertEvent(second, { at: NOW_MS + 2000 });
      second.close();

      const third = Store.open(temp.dbPath);
      try {
        assert.equal(eventAt(third, lateMsRow), NOW_MS + 2000,
          '标记已存在时不得再修复新行（一次性迁移）');
        assert.equal(migratorRepairEvents(third).length, 1, '不得重复写迁移审计');
        assert.equal(third.getMeta(MARKER), markerAfterFirst, '标记值不得被重写');
      } finally {
        third.close();
      }
    } catch (error) {
      try {
        second.close();
      } catch {
        // 已关闭
      }
      throw error;
    }
  } finally {
    temp.cleanup();
  }
});

test('H2-005（v0.7.21 非真机证据）：迁移后 ev_no_update 立即恢复，append-only 仍拦截 UPDATE/DELETE 且不碰 ev_no_delete', () => {
  // 判别力：删掉恢复触发器的 `CREATE TRIGGER ... ev_no_update` 后，迁移提交后
  // 触发器表里没有 ev_no_update，raw UPDATE 不再抛 append-only，本用例变红。
  const temp = makeTempStore();
  try {
    rawInsertEvent(temp.store, { at: NOW_MS });
    temp.store.deleteMeta(MARKER);
    temp.store.close();

    const reopened = Store.open(temp.dbPath);
    try {
      assert.equal(triggerExists(reopened, 'ev_no_update'), true,
        '迁移结束必须恢复 ev_no_update');
      assert.equal(triggerExists(reopened, 'ev_no_delete'), true,
        'ev_no_delete 不属于本项授权，必须原样存在');
      assert.throws(
        () => reopened.db.prepare("UPDATE memory_events SET at = at WHERE action = 'PURGED'").run(),
        /append-only/u,
        '恢复后的 ev_no_update 必须继续拒绝 UPDATE',
      );
      assert.throws(
        () => reopened.db.prepare('DELETE FROM memory_events').run(),
        /append-only/u,
        'ev_no_delete 必须继续拒绝 DELETE',
      );
    } finally {
      reopened.close();
    }
  } finally {
    temp.cleanup();
  }
});
