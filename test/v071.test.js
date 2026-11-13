/**
 * v0.7.1：V70-M2（同义偏好去重按 kind 取候选）与 V70-L2（mirror debug 位置）的回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/memory/store.js';
import { consolidate, selectExistingFacts } from '../src/memory/consolidate.js';
import { normalizeConfig, ConfigError } from '../src/config.js';

const BASE = 1_795_000_000;

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-v071-'));
  const store = Store.open(join(dir, 'companion.db'));
  try {
    return await fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertPreference(store, statement, options = {}) {
  store.insertFact({
    scope: options.scope ?? 'main',
    kind: 'preference',
    subject_text: options.subject ?? '用户',
    predicate: '喜欢',
    object_text: statement,
    statement,
    source_kind: 'consolidated',
    observed_at: options.observedAt ?? BASE,
  });
  return store.listFacts({ scope: options.scope ?? 'main', limit: 10, status: 'active' })
    .find((row) => row.statement === statement);
}

test('V70-M2：subject=用户 的偏好，用户说「我」也能选到候选', async () => {
  await withStore((store) => {
    insertPreference(store, '用户喜欢美式咖啡');
    // 正文里没有「用户」二字，旧实现（字面匹配 subject）会返回空。
    const rows = selectExistingFacts(store, 'main', '我最近还是喜欢喝美式，别换别的');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject_text, '用户');
  });
});

test('V70-M2：同 subject 的多条偏好全部交给模型，不被压成 1 条', async () => {
  await withStore((store) => {
    insertPreference(store, '用户喜欢美式咖啡', { observedAt: BASE });
    insertPreference(store, '用户最近喜欢拿铁', { observedAt: BASE + 60 });
    insertPreference(store, '用户不喜欢太甜的', { observedAt: BASE + 120 });
    const rows = selectExistingFacts(store, 'main', '我最近口味变了');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.statement).sort(), [
      '用户不喜欢太甜的',
      '用户喜欢美式咖啡',
      '用户最近喜欢拿铁',
    ]);
  });
});

test('V70-M2：preferenceLimit 生效（默认 12，可调小）', async () => {
  await withStore((store) => {
    for (let index = 0; index < 15; index += 1) {
      insertPreference(store, `用户喜欢第${index}种咖啡`, { observedAt: BASE + index });
    }
    assert.equal(selectExistingFacts(store, 'main', '我在说咖啡').length, 12);
    assert.equal(selectExistingFacts(store, 'main', '我在说咖啡', { preferenceLimit: 3 }).length, 3);
  });
});

test('V70-M2：对话只用「我」重复同一偏好，巩固后 active 只剩 1 条', async () => {
  await withStore(async (store) => {
    const first = insertPreference(store, '用户喜欢美式咖啡');
    assert.ok(first);

    let seenCandidates = null;
    const second = await consolidate({
      store,
      scope: 'main',
      seqFrom: 1,
      seqTo: 2,
      now: BASE + 3600,
      regionText: 'user: 我最近还是喜欢喝美式，不过想换换口味',
      llm: (input) => {
        seenCandidates = input.existingFacts;
        return {
          episode: null,
          facts: [{
            kind: 'preference',
            subject_text: '用户',
            predicate: '喜欢',
            object_text: '美式（想换口味）',
            statement: '用户喜欢美式咖啡，但想换换口味',
            supersedes: first.id,
          }],
        };
      },
    });
    assert.equal(second.facts, 1);
    assert.ok(Array.isArray(seenCandidates) && seenCandidates.some((row) => row.id === first.id));

    const active = store.listFacts({ scope: 'main', limit: 10, status: 'active' });
    assert.equal(active.length, 1, '同义偏好应只剩 1 条 active');
    assert.equal(store.getFact(first.id).status, 'superseded');
  });
});

test('V70-M2：config.consolidate.existingFactsLimit 默认 12、边界与越界', () => {
  assert.equal(normalizeConfig({}).consolidate.existingFactsLimit, 12);
  assert.equal(normalizeConfig({ consolidate: { existingFactsLimit: 3 } }).consolidate.existingFactsLimit, 3);
  assert.equal(normalizeConfig({ consolidate: { existingFactsLimit: 50 } }).consolidate.existingFactsLimit, 50);
  for (const bad of [0, 51, -1, 3.5, '3', null]) {
    assert.throws(
      () => normalizeConfig({ consolidate: { existingFactsLimit: bad } }),
      (error) => error instanceof ConfigError && error.field === 'consolidate.existingFactsLimit',
      `expected ConfigError for ${JSON.stringify(bad)}`,
    );
  }
  const withUnknown = normalizeConfig({ consolidate: { existingFactsLimit: 5, nope: 1 } });
  assert.ok(withUnknown.warnings.some((line) => line.includes('consolidate.nope')));
  assert.equal(Object.keys(normalizeConfig({})).filter((key) => !key.startsWith('_')).length >= 16, true);
});

test('V70-L2：mirror debug 日志在 query 之后、空召回 early return 之前', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const queryIndex = source.indexOf('const query = lastUserText(messages).slice(0, 200);');
  const debugIndex = source.indexOf('mirror debug');
  const emptyReturnIndex = source.indexOf("if (!Array.isArray(recalled?.items) || recalled.items.length === 0) {");
  assert.ok(queryIndex > 0 && debugIndex > 0 && emptyReturnIndex > 0);
  assert.ok(queryIndex < debugIndex, 'debug 应在 query 之后');
  assert.ok(debugIndex < emptyReturnIndex, 'debug 应在空召回 early return 之前');
});
