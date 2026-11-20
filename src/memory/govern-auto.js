/**
 * L120-M1：deep-sleep 自动去重（治理的自动档）。
 *
 * 与 `govern.js` 的差别：
 * - 手动 `/记忆 治理` 是 0.92 严格阈值 + 默认 dryRun，用户主动触发；
 * - 这里由 deep-sleep 每夜跑一次，阈值取 `config.govern.autoDedupeThreshold`
 *   （默认 0.6，能抓住「同一件事换了说法」），但**判定权交给模型**：只有模型
 *   判 same 的对子才 supersede，判不准或调用失败就原样不动、留到次夜。
 *
 * 安全约束（计划硬要求）：
 * - 只处理同 scope、同 kind、active 的事实；
 * - pinned 永不 drop，也不作为被合并的一方；
 * - 只改状态（superseded + superseded_by），**不物理删除**；
 * - 一次最多交 `MAX_JUDGE_PAIRS` 对给模型，避免长 prompt；候选留次夜继续。
 *
 * @module memory/govern-auto
 */
import { jaccard, textBigrams } from './similarity.js';

/** 单次交模型裁决的对子上限（候选超出的留到次夜）。 */
export const MAX_JUDGE_PAIRS = 20;

/** 每个 kind 的扫描上限，防止一次 deep-sleep 读全库。 */
const SCAN_LIMIT = 400;

/** 单页 listFacts 的条数（Store 的 clamp 上界）。 */
const FACT_PAGE_SIZE = 200;

/**
 * 取 scope 下所有 active 事实（分页），供两两比较。
 * @param {object} store
 * @param {string} scope
 * @returns {Array<{id:string,kind:string,statement:string,tokens:Set<string>,
 *   salience:string|null,last_reinforced_at:number|null,observed_at:number|null}>}
 */
function activeFacts(store, scope) {
  const rows = [];
  for (let offset = 0; offset < SCAN_LIMIT; offset += FACT_PAGE_SIZE) {
    const page = store.listFacts({ scope, status: 'active', limit: FACT_PAGE_SIZE, offset }) ?? [];
    rows.push(...page);
    if (page.length < FACT_PAGE_SIZE) break;
  }
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    statement: String(row.statement ?? ''),
    tokens: textBigrams(row.statement ?? ''),
    salience: row.salience ?? null,
    last_reinforced_at: row.last_reinforced_at ?? null,
    observed_at: row.observed_at ?? null,
  })).filter((row) => row.statement.trim() !== '');
}

/**
 * 找出「同 kind 且 bigram Jaccard ≥ threshold」的对子。
 *
 * 每对固定成 `{keep, drop}`：keep 是较新/质量更好的一条，drop 是候选被合并的
 * 旧条。pinned 只会出现在 keep 侧；两侧都 pinned 的对子直接跳过（保守）。
 *
 * @param {{store:object, scope:string, threshold:number, limit?:number}} input
 * @returns {{pairs: Array<{keep:object, drop:object, score:number}>, scanned:number}}
 */
export function planAutoDedupe({ store, scope, threshold, limit = MAX_JUDGE_PAIRS } = {}) {
  const facts = activeFacts(store, scope);
  const byKind = new Map();
  for (const fact of facts) {
    const bucket = byKind.get(fact.kind);
    if (bucket === undefined) byKind.set(fact.kind, [fact]);
    else bucket.push(fact);
  }
  const pairs = [];
  for (const bucket of byKind.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i];
        const right = bucket[j];
        const score = jaccard(left.tokens, right.tokens);
        if (!(score >= threshold)) continue;
        const leftPinned = left.salience === 'pinned';
        const rightPinned = right.salience === 'pinned';
        if (leftPinned && rightPinned) continue;
        // 保留策略：pinned 优先，其次 last_reinforced_at / observed_at 更近的，最后比 id。
        let keep = left;
        let drop = right;
        const keepNewer = !leftPinned && !rightPinned
          && (Number(right.last_reinforced_at ?? 0) > Number(left.last_reinforced_at ?? 0)
            || (Number(right.last_reinforced_at ?? 0) === Number(left.last_reinforced_at ?? 0)
              && String(right.id) > String(left.id)));
        if (keepNewer || (leftPinned === false && rightPinned === true)) {
          keep = right;
          drop = left;
        }
        pairs.push({ keep, drop, score });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score || String(a.drop.id).localeCompare(String(b.drop.id)));
  return { pairs: pairs.slice(0, Math.max(0, limit)), scanned: facts.length };
}

/**
 * 组给模型看的判定 prompt。只给 id 与正文，不要用户其它上下文。
 * @param {Array<{keep:object, drop:object}>} pairs
 * @returns {string}
 */
export function buildAutoDedupePrompt(pairs) {
  const lines = [
    '你在做长期记忆的重复判定。每组里有两条事实，请判断它们是否在说同一件事。',
    'same：同一件事的不同说法（可以合并）；update：后者取代前者（信息更新）；new：两件不同的事。',
    '只输出 JSON：{"items":[{"index":1,"verdict":"same"}]}，index 从 1 开始，每组都要有。',
    '',
  ];
  pairs.forEach((pair, index) => {
    lines.push(`#${index + 1}`);
    lines.push(`A(id=${pair.drop.id}｜kind=${pair.drop.kind})：${pair.drop.statement}`);
    lines.push(`B(id=${pair.keep.id}｜kind=${pair.keep.kind})：${pair.keep.statement}`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 解析模型返回的判定。结构坏返回 null（调用方按「本轮不处理」处理）。
 * @param {unknown} payload
 * @param {number} expected
 * @returns {Array<'same'|'update'|'new'>|null}
 */
export function parseAutoDedupeVerdicts(payload, expected) {
  if (!payload || typeof payload !== 'object') return null;
  const items = Array.isArray(payload.items) ? payload.items : null;
  if (items === null) return null;
  const verdicts = new Array(expected).fill('new');
  for (const item of items) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || index < 1 || index > expected) continue;
    const verdict = typeof item?.verdict === 'string' ? item.verdict.trim().toLowerCase() : '';
    if (verdict === 'same' || verdict === 'update' || verdict === 'new') {
      verdicts[index - 1] = verdict;
    }
  }
  return verdicts;
}

/**
 * 应用判定：same / update 都把 drop 侧标 superseded（superseded_by=keep.id）。
 * 只改状态，不删行；pinned 的 drop 侧再兜一次（防御上游把 pinned 放进 drop）。
 *
 * @param {{store:object, scope:string, pairs:Array, verdicts:Array, now:number}} input
 * @returns {{superseded:number, dropped:number}}
 */
export function applyAutoDedupe({ store, scope, pairs, verdicts, now } = {}) {
  const at = Math.floor(Number(now) / 1000);
  const update = store.db.prepare(
    `UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = ?
      WHERE id = ? AND scope = ? AND status = 'active'`,
  );
  let superseded = 0;
  let dropped = 0;
  store.transaction(() => {
    pairs.forEach((pair, index) => {
      const verdict = verdicts[index] ?? 'new';
      if (verdict !== 'same' && verdict !== 'update') return;
      if (pair.drop.salience === 'pinned') {
        dropped += 1;
        return;
      }
      const info = update.run(pair.keep.id, at, pair.drop.id, scope);
      if (Number(info?.changes ?? 0) > 0) superseded += 1;
    });
  });
  return { superseded, dropped };
}
