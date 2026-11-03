#!/usr/bin/env node
/**
 * P2-b 向量召回离线对比（零依赖、可复现）。
 *
 * 生成 200 条合成事实与 20 条查询，分别跑：
 *   - FTS：store.searchBigram（v0.2.0 检索路径）
 *   - 向量：searchVector + hashEmbed
 *   - RRF：hybridSearch（FTS + 向量）
 * 输出 hit@5 对比表。hashEmbed 是字符 bigram 哈希，仅用于离线/测试，
 * 不代表真实 embedding 的召回质量；真实 embedding 接入留 P3。
 *
 * 用法：node scripts/bench-vector.mjs [--dim 256] [--json]
 */

import { Store } from '../src/memory/store.js';
import { hashEmbed, hybridSearch, searchVector } from '../src/memory/vector.js';

const TOPICS = 20;
const PER_TOPIC = 10;
const LIMIT = 5;

function parseArgs(argv) {
  const options = { dim: 256, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dim') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 8 || value > 4096) {
        throw new TypeError('--dim must be an integer between 8 and 4096');
      }
      options.dim = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** 连接远小于 5 的字符噪声，避免单字查询退化成全表匹配。 */
function noise(seed) {
  const alphabet = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
  return `${alphabet[seed % alphabet.length]}${alphabet[(seed * 7 + 3) % alphabet.length]}`;
}

function seedFacts(store, dim) {
  const facts = [];
  for (let topic = 0; topic < TOPICS; topic += 1) {
    for (let index = 0; index < PER_TOPIC; index += 1) {
      const id = `fact-bench-${topic}-${index}`;
      const statement = `主题${topic} 的记忆条目 ${index}：关于「丙${noise(topic * 10 + index)}计划」的第 ${index} 条细节，编号 ${topic}-${index}。`;
      store.insertFact({
        id,
        scope: 'main',
        kind: 'other',
        subject_text: `主题${topic}`,
        predicate: '记录',
        object_text: `条目${index}`,
        statement,
        source_kind: 'consolidated',
        salience: 'normal',
        privacy: 'normal',
        fidelity: 'full',
        observed_at: Math.floor(Date.now() / 1000) - index * 3600,
      });
      facts.push({ id, topic, index, statement });
    }
  }
  return facts;
}

function topFive(set) {
  return new Set([...set].slice(0, LIMIT));
}

function scoreQueries(store, facts, dim) {
  const rows = [];
  for (let topic = 0; topic < TOPICS; topic += 1) {
    const target = facts.find((fact) => fact.topic === topic && fact.index === 0).id;
    const query = `主题${topic} 条目 0 丙${noise(topic * 10)}计划`;
    const fts = store
      .searchBigram(query, { scope: 'main', limit: 50 })
      .filter((hit) => hit.type === 'fact')
      .map((hit) => hit.id);
    const vector = searchVector({
      store,
      scope: 'main',
      query,
      embed: (text) => hashEmbed(text, dim),
      limit: 50,
    }).map((hit) => hit.factId);
    const hybrid = hybridSearch({
      store,
      scope: 'main',
      query,
      embed: (text) => hashEmbed(text, dim),
      limit: 50,
    })
      .filter((hit) => hit.type === 'fact')
      .map((hit) => hit.id);
    rows.push({
      query,
      target,
      fts: topFive(fts).has(target),
      vector: topFive(vector).has(target),
      hybrid: topFive(hybrid).has(target),
    });
  }
  return rows;
}

function percent(hits, total) {
  return total === 0 ? '0.0%' : `${((hits / total) * 100).toFixed(1)}%`;
}

function printTable(rows) {
  const hits = {
    fts: rows.filter((row) => row.fts).length,
    vector: rows.filter((row) => row.vector).length,
    hybrid: rows.filter((row) => row.hybrid).length,
  };
  console.log('P2-b 合成数据 hit@5（200 facts / 20 queries，hashEmbed 非生产质量）');
  console.log('');
  console.log('方法    hit@5    命中/总数');
  console.log(`FTS     ${percent(hits.fts, rows.length).padEnd(8)} ${hits.fts}/${rows.length}`);
  console.log(`向量    ${percent(hits.vector, rows.length).padEnd(8)} ${hits.vector}/${rows.length}`);
  console.log(`RRF     ${percent(hits.hybrid, rows.length).padEnd(8)} ${hits.hybrid}/${rows.length}`);
  console.log('');
  console.log('逐查询：');
  for (const row of rows) {
    console.log(`- ${row.query}  FTS=${row.fts ? '✓' : '×'}  向量=${row.vector ? '✓' : '×'}  RRF=${row.hybrid ? '✓' : '×'}`);
  }
  return hits;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`bench-vector: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('用法：node scripts/bench-vector.mjs [--dim 256] [--json]');
    return;
  }

  const store = Store.open(':memory:');
  store.setVectorDim(options.dim);
  const facts = seedFacts(store, options.dim);
  const rows = scoreQueries(store, facts, options.dim);

  if (options.json) {
    console.log(JSON.stringify({ dim: options.dim, facts: facts.length, queries: rows.length, rows }, null, 2));
    return;
  }
  printTable(rows);
}

main();
