/**
 * P2-c 端到端联调（v0.3.0）。
 *
 * 覆盖 V12 与导出/向量两条链路的真实接线：
 *   1. 导出 → fresh 恢复：facts/episodes/reminders/threads/状态板逐项相等，
 *      superseded / 墓碑 / secret / 敏感正文被过滤；
 *   2. 加密导出：正确口令可解，错误口令失败且不留下半文件；
 *   3. 向量开关：关闭时检索与 v0.2.0 一致；开启时 RRF 合并去重，
 *      敏感/墓碑不召回，维度不符抛错；
 *   4. 治理后再导出：降级与敏感条目不进导出，也不进向量索引；
 *   5. V12 回归：导出文件含 version/schema_version，恢复后可继续对话与召回；
 *   6. 恢复后缺向量：召回不崩溃，下一次写入重建投影后向量召回可用。
 *
 * 约束：不联网、不读真实时钟、不写仓库外固定路径（全部临时目录）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeCtx } from '../fakes/ctx.js';
import { apply } from '../../src/index.js';
import { Store } from '../../src/memory/store.js';
import {
  ENCRYPTED_MAGIC,
  EXPORT_VERSION,
  decryptJson,
  encryptJson,
  exportAll,
  importAll,
} from '../../src/memory/export.js';
import { cosine, hashEmbed, hybridSearch, searchVector } from '../../src/memory/vector.js';
import { retrieve } from '../../src/memory/retrieve.js';
import { makeTempStore, TEST_NOW } from './helpers.js';

const AT = Math.floor(TEST_NOW / 1000);
const VECTOR_ON = Object.freeze({ enabled: true, dim: 256, embedder: 'hash' });
const VECTOR_OFF = Object.freeze({ enabled: false, dim: 256, embedder: 'hash' });

/**
 * 一个临时库（t.after 自动关闭并删目录）。
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {{dir: string, dbPath: string, store: Store}}
 */
function makeDatabase(t, prefix = 'dsh-p2-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, 'companion.db');
  const store = Store.open(dbPath);
  t.after(() => {
    try {
      store.close();
    } catch {
      // 已关闭时继续删目录。
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, store };
}

/**
 * @param {Store} store
 * @param {object} [patch]
 * @returns {object}
 */
function insertFact(store, patch = {}) {
  return store.insertFact({
    scope: 'main',
    kind: 'project',
    subject_text: '青柠计划',
    predicate: '代号',
    object_text: '蓝鲸',
    statement: '青柠计划的代号是蓝鲸。',
    source_kind: 'turn',
    salience: 'normal',
    observed_at: AT,
    last_reinforced_at: AT,
    ...patch,
  });
}

/**
 * @param {Store} store
 * @param {string} scope
 * @param {number} revision
 * @param {string} rendered
 */
function insertBoard(store, scope, revision, rendered) {
  store.db
    .prepare(
      `INSERT INTO state_board_rev (scope, revision, rendered, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         revision = excluded.revision,
         rendered = excluded.rendered,
         updated_at = excluded.updated_at`,
    )
    .run(scope, revision, rendered, AT);
}

/**
 * 完整导出夹具：每类都有「应导出」与「应过滤」两种行。
 * @param {Store} store
 * @returns {object}
 */
function seedExportFixture(store) {
  const episode = store.insertEpisode({
    scope: 'main',
    session_id: 'p2-export',
    started_at: AT - 3600,
    ended_at: AT,
    title: '讨论搬家计划',
    summary: '搬家定在周六，先联系搬家公司。',
    evidence: '用户说周六搬家。',
    topics: ['搬家', '周末'],
    salience: 'notable',
    last_reinforced_at: AT,
  });
  const fact = insertFact(store, {
    kind: 'project',
    subject_text: '搬家',
    predicate: '时间',
    object_text: '周六',
    statement: '搬家定在周六。',
    source_episode_id: episode.id,
    source_excerpt: '用户说周六搬家。',
    salience: 'notable',
  });
  const reminder = store.insertReminder({
    scope: 'main',
    kind: 'todo',
    title: '联系搬家公司',
    detail: '周六前确认车型与价格。',
    counterparty: '搬家师傅',
    due_at: AT + 86_400,
    due_granularity: 'day',
    next_fire_at: AT + 86_400,
    source_episode_id: episode.id,
    status: 'pending',
  });
  const thread = store.upsertThread({
    key: 'move',
    name: '搬家线程',
    session_id: 'session-move',
    description: '只讨论搬家',
    last_progress: '已定周六',
    last_active_at: AT,
    status: 'active',
  });
  const archived = store.upsertThread({
    key: 'old-topic',
    name: '旧话题',
    session_id: 'session-old',
    description: '已经归档的线索',
    last_active_at: AT - 86_400,
    status: 'archived',
  });
  insertBoard(store, 'main', 4, '## 状态板\n- 搬家定在周六。\n- 银行卡密码是 123456。');

  // 以下行都不应出现在导出里。
  const superseded = insertFact(store, {
    subject_text: '旧手机号',
    predicate: '是',
    object_text: '111',
    statement: '旧手机号是 111。',
  });
  store.updateFact(superseded.id, { status: 'superseded', superseded_by: fact.id });
  const tombstone = insertFact(store, {
    subject_text: '临时日程',
    predicate: '是',
    object_text: '周四',
    statement: '临时日程改到周四。',
  });
  store.forgetFact(tombstone.id, { at: AT });
  const secret = insertFact(store, {
    subject_text: '秘密',
    predicate: '内容',
    object_text: '不能导出',
    statement: '秘密内容不能导出。',
    privacy: 'secret',
  });
  const sensitive = insertFact(store, {
    subject_text: '我',
    predicate: '银行卡密码',
    object_text: '123456',
    statement: '银行卡密码是 123456。',
  });
  return { episode, fact, reminder, thread, archived, superseded, tombstone, secret, sensitive };
}

/**
 * 逐项比较数据库行与导出 JSON 行。
 * @param {object|null} actual
 * @param {object} expected
 * @param {string} label
 */
function assertRowEqual(actual, expected, label) {
  assert.ok(actual, `${label} 应存在于恢复后的库`);
  assert.deepEqual({ ...actual }, { ...expected }, `${label} 应与导出文件逐项相等`);
}

/**
 * 取决策里的文本块（与 apply-turn/p1 一致）。
 * @param {{messages?: object[]}|null|undefined} decision
 * @returns {string}
 */
function decisionText(decision) {
  const messages = Array.isArray(decision?.messages) ? decision.messages : [];
  return messages
    .flatMap((message) => {
      if (Array.isArray(message?.content)) return message.content;
      return message?.type === 'text' ? [message] : [];
    })
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** @param {FakeCtx} ctx */
function makeCtx(ctx = new FakeCtx({ now: TEST_NOW })) {
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
  return ctx;
}

/** @param {FakeCtx} ctx @param {string} name @param {string} [rawInput] */
function invokeCommand(ctx, name, rawInput = '') {
  const definition = ctx.commands.registrations.find((entry) => entry.name === name);
  assert.ok(definition, `命令 ${name} 应已注册`);
  return definition.handler({ rawInput });
}

/** @param {Store} store */
function vectorCount(store) {
  return Number(store.db.prepare('SELECT COUNT(*) AS n FROM fact_vectors').get()?.n ?? 0);
}

// ------------------------------------------------------------ 导出 → fresh 恢复

test('导出→fresh 恢复：四类数据与状态板逐项相等，superseded/墓碑/secret/敏感正文被过滤', (t) => {
  const source = makeDatabase(t, 'dsh-p2-export-src-');
  const seeded = seedExportFixture(source.store);

  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));

  assert.equal(payload.version, EXPORT_VERSION);
  assert.equal(payload.scope, 'main');
  assert.equal(payload.schema_version, source.store.getMeta('schema_version'));
  assert.deepEqual(payload.counts, {
    facts: 1,
    episodes: 1,
    reminders: 1,
    threads: 2,
    state_board: 1,
  });

  const exportedFactIds = payload.data.facts.map((row) => row.id);
  assert.deepEqual(exportedFactIds, [seeded.fact.id]);
  for (const excluded of [seeded.superseded, seeded.tombstone, seeded.secret, seeded.sensitive]) {
    assert.equal(
      exportedFactIds.includes(excluded.id),
      false,
      `${excluded.id} 不应进入导出`,
    );
  }
  assert.equal(payload.data.episodes.some((row) => row.id === seeded.tombstone.id), false);
  // 状态板渲染里的敏感正文也被剔除，但正常行保留。
  assert.match(payload.data.state_board.rendered, /搬家定在周六/u);
  assert.doesNotMatch(payload.data.state_board.rendered, /银行卡密码|123456/u);

  const target = makeDatabase(t, 'dsh-p2-export-dst-');
  const result = importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'fresh');
  assert.deepEqual(result.imported, {
    facts: 1,
    episodes: 1,
    reminders: 1,
    threads: 2,
    state_board: 1,
  });
  assert.equal(result.skipped, 0);

  for (const row of payload.data.facts) {
    assertRowEqual(target.store.db.prepare('SELECT * FROM facts WHERE id = ?').get(row.id), row, `fact ${row.id}`);
  }
  for (const row of payload.data.episodes) {
    assertRowEqual(
      target.store.db.prepare('SELECT * FROM episodes WHERE id = ?').get(row.id),
      row,
      `episode ${row.id}`,
    );
  }
  for (const row of payload.data.reminders) {
    assertRowEqual(
      target.store.db.prepare('SELECT * FROM reminders WHERE id = ?').get(row.id),
      row,
      `reminder ${row.id}`,
    );
  }
  for (const row of payload.data.threads) {
    assertRowEqual(
      target.store.db.prepare('SELECT * FROM threads WHERE key = ?').get(row.key),
      row,
      `thread ${row.key}`,
    );
  }
  const board = target.store.getBoardState('main');
  assert.equal(board.scope, payload.data.state_board.scope);
  assert.equal(board.revision, payload.data.state_board.revision);
  assert.equal(board.rendered, payload.data.state_board.rendered);
  assert.equal(board.updated_at, payload.data.state_board.updated_at);

  // 恢复后 FTS 可用，且被过滤的行确实不存在。
  assert.ok(target.store.searchBigram('搬家', { scope: 'main' }).length > 0);
  assert.equal(target.store.getFact(seeded.superseded.id), null);
  assert.equal(target.store.getFact(seeded.tombstone.id), null);
  assert.equal(target.store.getFact(seeded.secret.id), null);
  assert.equal(target.store.getFact(seeded.sensitive.id), null);
});

// ---------------------------------------------------------------- 加密导出

test('加密导出：正确口令可解，错误口令失败且不产生半文件', (t) => {
  const source = makeDatabase(t, 'dsh-p2-enc-');
  insertFact(source.store, { statement: '加密导出里的记忆。' });
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));

  const encrypted = encryptJson(payload, 'correct horse', { now: TEST_NOW });
  const lines = encrypted.split(/\r?\n/u);
  assert.equal(lines[0], ENCRYPTED_MAGIC);
  const header = JSON.parse(lines[1]);
  assert.equal(header.version, EXPORT_VERSION);
  assert.equal(header.cipher, 'aes-256-gcm');
  assert.equal(header.kdf, 'scrypt');
  assert.deepEqual(decryptJson(encrypted, 'correct horse'), payload);
  assert.throws(() => decryptJson(encrypted, 'wrong horse'), /解密失败/u);
  assert.throws(() => decryptJson('not an export', 'correct horse'), /加密导出文件/u);

  const encryptedFile = join(source.dir, 'memory.enc');
  const plainFile = join(source.dir, 'decrypted.json');
  writeFileSync(encryptedFile, encrypted, 'utf8');
  const script = fileURLToPath(new URL('../../scripts/decrypt-encrypted.mjs', import.meta.url));

  const wrong = spawnSync(process.execPath, [script, encryptedFile, '--out', plainFile], {
    input: 'wrong horse\n',
    encoding: 'utf8',
  });
  assert.notEqual(wrong.status, 0, '错误口令应非零退出');
  assert.equal(existsSync(plainFile), false, '解密失败不得留下半文件');

  const right = spawnSync(process.execPath, [script, encryptedFile, '--out', plainFile], {
    input: 'correct horse\n',
    encoding: 'utf8',
  });
  assert.equal(right.status, 0, right.stderr);
  assert.equal(existsSync(plainFile), true);
  assert.deepEqual(JSON.parse(readFileSync(plainFile, 'utf8')), payload);
});

// ---------------------------------------------------------------- 向量开关

test('向量关闭：检索结果与 v0.2.0 完全一致（无 vectorHits）', async (t) => {
  const { store } = makeDatabase(t, 'dsh-p2-vec-off-');
  const fact = insertFact(store, { statement: '项目代号是晨星。', subject_text: '项目', object_text: '晨星' });

  const baseline = await retrieve({ store, query: '项目代号', scope: 'main', now: TEST_NOW });
  const disabled = await retrieve({
    store,
    query: '项目代号',
    scope: 'main',
    now: TEST_NOW,
    vector: VECTOR_OFF,
  });
  assert.deepEqual(disabled, baseline);
  assert.equal(Object.hasOwn(disabled, 'vectorHits'), false);
  assert.ok(disabled.items.some((item) => item.id === fact.id));
});

test('向量开启：hybrid RRF 合并去重，敏感/墓碑不召回，维度不符抛错', async (t) => {
  const { store } = makeDatabase(t, 'dsh-p2-vec-on-');
  const morning = insertFact(store, {
    statement: '项目代号是晨星。',
    subject_text: '项目',
    object_text: '晨星',
  });
  const plan = insertFact(store, {
    statement: '青柠计划在周四评审。',
    subject_text: '青柠计划',
    predicate: '评审',
    object_text: '周四',
  });
  const secret = insertFact(store, {
    statement: '银行卡密码是 654321。',
    subject_text: '我',
    predicate: '银行卡密码',
    object_text: '654321',
    privacy: 'secret',
  });
  const tombstone = insertFact(store, {
    statement: '临时日程改到周三。',
    subject_text: '临时日程',
    object_text: '周三',
  });
  store.forgetFact(tombstone.id, { at: AT });

  assert.equal(vectorCount(store), 2, '只应为 normal/active 事实建投影');

  const enabled = await retrieve({
    store,
    query: '项目代号',
    scope: 'main',
    now: TEST_NOW,
    vector: VECTOR_ON,
  });
  assert.ok(enabled.vectorHits >= 1, '向量应命中项目代号');
  assert.ok(enabled.items.some((item) => item.id === morning.id));
  const itemIds = enabled.items.map((item) => item.id);
  assert.equal(new Set(itemIds).size, itemIds.length, '召回结果不应重复');

  const fused = hybridSearch({ store, query: '项目代号', scope: 'main', now: TEST_NOW });
  const keys = fused.map((hit) => `${hit.type}:${hit.id}`);
  assert.equal(new Set(keys).size, keys.length, 'RRF 应按 type:id 去重');
  const hit = fused.find((entry) => entry.id === morning.id);
  assert.ok(hit, '词法 + 向量都命中的事实应出现一次');
  assert.ok(hit.score > 1 / 61, '同一事实两路命中应累加 RRF 分数');

  // 敏感与墓碑不进入向量索引（无关事实可能仍有低分近邻，只断言目标 id 缺席）。
  assert.equal(
    searchVector({ store, query: '银行卡密码', scope: 'main', now: TEST_NOW })
      .some((hit) => hit.factId === secret.id),
    false,
  );
  assert.equal(
    searchVector({ store, query: '临时日程', scope: 'main', now: TEST_NOW })
      .some((hit) => hit.factId === tombstone.id),
    false,
  );

  // 即使词法命中敏感行，开启向量的召回也不得注入。
  const sensitiveRecall = await retrieve({
    store,
    query: '银行卡密码',
    scope: 'main',
    now: TEST_NOW,
    vector: VECTOR_ON,
  });
  assert.equal(sensitiveRecall.items.some((item) => item.id === secret.id), false);
  const tombRecall = await retrieve({
    store,
    query: '临时日程',
    scope: 'main',
    now: TEST_NOW,
    vector: VECTOR_ON,
  });
  assert.equal(tombRecall.items.some((item) => item.id === tombstone.id), false);

  assert.throws(() => cosine([1, 2, 3], [1, 2]), /dimension mismatch/u);
  const wrongDim = searchVector({
    store,
    query: '项目代号',
    scope: 'main',
    now: TEST_NOW,
    embed: (text) => hashEmbed(text, 64),
  });
  assert.deepEqual(wrongDim, [], '查询维度与投影维度不符时不应返回错误命中');
});

// ------------------------------------------------------------ 治理后再导出

test('治理后再导出：superseded 与敏感条目不进导出，也不进向量索引', (t) => {
  const temp = makeTempStore();
  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: temp.dbPath });
  try {
    const keep = temp.store.insertFact({
      scope: 'main',
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡。',
      source_kind: 'user_explicit',
      salience: 'explicit',
      observed_at: AT,
      last_reinforced_at: AT,
    });
    const drop = temp.store.insertFact({
      scope: 'main',
      kind: 'preference',
      subject_text: '我',
      predicate: '习惯',
      object_text: '美式咖啡',
      statement: '我习惯早上喝美式咖啡。',
      source_kind: 'turn',
      salience: 'normal',
      observed_at: AT + 1,
      last_reinforced_at: AT + 1,
    });
    const sensitive = temp.store.insertFact({
      scope: 'main',
      kind: 'other',
      subject_text: '我',
      predicate: '银行卡密码',
      object_text: '246810',
      statement: '银行卡密码是 246810。',
      source_kind: 'turn',
      observed_at: AT + 2,
      last_reinforced_at: AT + 2,
    });
    insertBoard(temp.store, 'main', 2, '## 状态板\n- 青柠计划进行中。\n- 银行卡密码是 246810。');

    const reply = invokeCommand(ctx, 'memory', ' 治理');
    assert.equal(reply.kind, 'success');
    assert.match(reply.text, /记忆治理（已应用）/u);

    assert.equal(temp.store.getFact(keep.id).status, 'active');
    const dropped = temp.store.getFact(drop.id);
    assert.equal(dropped.status, 'superseded');
    assert.equal(dropped.superseded_by, keep.id);
    const sensitiveRow = temp.store.db
      .prepare('SELECT sensitive FROM facts WHERE id = ?')
      .get(sensitive.id);
    assert.equal(Number(sensitiveRow.sensitive), 1);
    assert.equal(
      temp.store.listEvents({ action: 'govern', limit: 10 }).length,
      1,
      '治理应只写一条审计',
    );

    const vectorIds = temp.store.db
      .prepare('SELECT fact_id FROM fact_vectors ORDER BY fact_id')
      .all()
      .map((row) => row.fact_id);
    assert.equal(vectorIds.includes(keep.id), true);
    assert.equal(vectorIds.includes(drop.id), false, '降级事实的向量应被清掉');
    // 敏感列由治理按需追加；searchVector 在查询时过滤 sensitive=1，因此原始投影行
    // 即使存在也不可被召回（下面的 searchVector 断言覆盖这一点）。

    const exported = exportAll({
      store: temp.store,
      format: 'json',
      dir: temp.dir,
      now: TEST_NOW,
    });
    const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
    assert.deepEqual(payload.data.facts.map((row) => row.id), [keep.id]);
    assert.equal(payload.counts.facts, 1);
    assert.doesNotMatch(payload.data.state_board.rendered, /银行卡密码/u);
    assert.match(payload.data.state_board.rendered, /青柠计划进行中/u);

    assert.equal(
      searchVector({ store: temp.store, query: '美式咖啡', scope: 'main', now: TEST_NOW })
        .some((hit) => hit.factId === drop.id),
      false,
    );
    assert.equal(
      searchVector({ store: temp.store, query: '银行卡密码', scope: 'main', now: TEST_NOW })
        .some((hit) => hit.factId === sensitive.id),
      false,
    );

    const target = makeDatabase(t, 'dsh-p2-govern-dst-');
    const result = importAll({ store: target.store, file: exported.path, mode: 'fresh' });
    assert.equal(result.imported.facts, 1);
    assert.equal(target.store.getFact(keep.id).statement, '我习惯早上喝美式咖啡。');
    assert.equal(target.store.getFact(drop.id), null);
    assert.equal(target.store.getFact(sensitive.id), null);
    assert.equal(vectorCount(target.store), 0, '导入不重建向量，下次写入再补');
    assert.equal(
      searchVector({ store: target.store, query: '银行卡密码', scope: 'main', now: TEST_NOW })
        .some((hit) => hit.factId === sensitive.id),
      false,
    );
  } finally {
    handle.dispose();
    temp.cleanup();
  }
});

// ------------------------------------------------------------ V12 回归

test('V12：导出文件含 version/schema_version，恢复后可继续对话与召回', async (t) => {
  const source = makeDatabase(t, 'dsh-p2-v12-src-');
  const episode = source.store.insertEpisode({
    scope: 'main',
    session_id: 'p2-v12',
    started_at: AT - 600,
    ended_at: AT,
    title: '确定搬家时间',
    summary: '搬家定在周六。',
    evidence: '用户确认周六。',
    salience: 'notable',
    last_reinforced_at: AT,
  });
  const fact = insertFact(source.store, {
    statement: '搬家定在周六。',
    subject_text: '搬家',
    predicate: '时间',
    object_text: '周六',
    source_episode_id: episode.id,
    salience: 'notable',
  });
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });
  const payload = JSON.parse(readFileSync(exported.path, 'utf8'));
  assert.equal(payload.version, EXPORT_VERSION);
  assert.equal(typeof payload.schema_version, 'string');
  assert.notEqual(payload.schema_version, '');
  assert.equal(payload.data.facts.length, 1);

  const target = makeDatabase(t, 'dsh-p2-v12-dst-');
  importAll({ store: target.store, file: exported.path, mode: 'fresh' });

  const ctx = makeCtx();
  const handle = apply(ctx, { dbPath: target.dbPath, vector: { enabled: true } });
  try {
    const session = ctx.addSession({ id: 'session-v12' });
    ctx.emitSessionEvent(session.id, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '搬家定在什么时候？' }] },
    });
    const decision = await ctx.dispatch(
      'agent/pre-step',
      {
        agent: { id: session.id, session },
        messages: [{ role: 'user', content: [{ type: 'text', text: '搬家定在什么时候？' }] }],
        turn: 1,
        step: 1,
      },
      { kind: 'enter', messages: [] },
    );
    const text = decisionText(decision);
    assert.match(text, /\[相关记忆\]/u);
    assert.match(text, /搬家定在周六/u);
    assert.match(invokeCommand(ctx, 'status').text, /向量：开·dim 256/u);
  } finally {
    handle.dispose();
  }
});

// ------------------------------------------------------- 恢复后向量缺失

test('恢复后向量缺失：召回不崩溃，下次写入重建投影后向量召回可用', async (t) => {
  const source = makeDatabase(t, 'dsh-p2-vecback-src-');
  const fact = insertFact(source.store, {
    statement: '搬家定在周六。',
    subject_text: '搬家',
    predicate: '时间',
    object_text: '周六',
  });
  const exported = exportAll({
    store: source.store,
    format: 'json',
    dir: source.dir,
    now: TEST_NOW,
  });

  const target = makeDatabase(t, 'dsh-p2-vecback-dst-');
  importAll({ store: target.store, file: exported.path, mode: 'fresh' });
  assert.equal(vectorCount(target.store), 0, '导入只写业务表，不写向量投影');

  const before = await retrieve({
    store: target.store,
    query: '搬家定在什么时候',
    scope: 'main',
    now: TEST_NOW,
    vector: VECTOR_ON,
  });
  assert.ok(before.items.some((item) => item.id === fact.id), '缺向量时词法召回仍应工作');
  assert.equal(before.vectorHits, 0);

  // 下一次写入走 Store.updateFact → #syncFactVector 重建投影。
  target.store.updateFact(fact.id, {});
  assert.equal(vectorCount(target.store), 1);

  const originalSearch = target.store.searchBigram;
  target.store.searchBigram = () => [];
  try {
    const vectorOnly = await retrieve({
      store: target.store,
      query: '周六',
      scope: 'main',
      now: TEST_NOW,
      vector: VECTOR_ON,
    });
    assert.ok(vectorOnly.items.some((item) => item.id === fact.id), '重建后应能纯向量召回');
    assert.ok(vectorOnly.vectorHits >= 1);
  } finally {
    target.store.searchBigram = originalSearch;
  }
});
