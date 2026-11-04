/**
 * R-M1/R-L1 纯函数单测：外部压缩后的重锚位置。
 *
 * `resolveReanchor(previous, current, watermark)` 只做位置计算，不碰 store/metrics；
 * e2e 覆盖接线，这里覆盖分支语义，避免只能靠 e2e 回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReanchor } from '../src/index.js';

test('resolveReanchor：无历史 → 锚点 0，整段重来', () => {
  assert.deepEqual(resolveReanchor(null, [3, 4], 2), { anchor: 0, mode: 'no-history', lost: 0 });
  assert.deepEqual(resolveReanchor([], [3, 4], 2), { anchor: 0, mode: 'no-history', lost: 0 });
  assert.deepEqual(resolveReanchor([1], [], 1), { anchor: 0, mode: 'no-history', lost: 0 });
});

test('resolveReanchor：压缩未越过水位 → 锚在替换节点之后（摘要不重复巩固）', () => {
  assert.deepEqual(resolveReanchor([1], [2], 1), { anchor: 2, mode: 'replacement', lost: 0 });
  assert.deepEqual(
    resolveReanchor([1, 2, 3], [1, 2, 4], 3),
    { anchor: 4, mode: 'replacement', lost: 0 },
    '水位之后没有节点消失，保持旧语义',
  );
});

test('resolveReanchor：压缩越过水位 → 锚点前挪到替换节点之前，摘要参与巩固', () => {
  // 水位 1，[1,2,3] 全被压掉，只剩追加的摘要节点 4：窗口从 0 开始。
  assert.deepEqual(
    resolveReanchor([1, 2, 3], [4], 1),
    { anchor: 0, mode: 'replacement-lost', lost: 2 },
  );
  // 水位 1，压掉 [1,2,3]，4/5 仍在 surface 且摘要 6 追加在末尾：
  // 锚点 = 摘要节点的前一个位置（5），(5, end] 把 6 纳入窗口。
  assert.deepEqual(
    resolveReanchor([1, 2, 3, 4, 5], [4, 5, 6], 1),
    { anchor: 5, mode: 'replacement-lost', lost: 2 },
  );
});

test('resolveReanchor：旧水位不在上一版里时按最保守口径统计丢失', () => {
  assert.deepEqual(
    resolveReanchor([1, 2], [3], 99),
    { anchor: 0, mode: 'replacement-lost', lost: 2 },
    '无法定位旧水位时，被移除节点全部视为未巩固',
  );
});

test('resolveReanchor：替换节点按「位置最前」而不是数值最小', () => {
  // 合成 surface：9 在位置 0、7 在位置 1；Math.min(fresh) 会错取 7。
  assert.deepEqual(
    resolveReanchor([1, 2], [9, 7, 1, 2], 3),
    { anchor: 9, mode: 'replacement', lost: 0 },
  );
});

test('resolveReanchor：seq 重映射（认不出替换节点）→ 从当前第一个节点重来', () => {
  assert.deepEqual(
    resolveReanchor([1, 2, 3], [1, 2], 3),
    { anchor: 1, mode: 'remapped', lost: 0 },
  );
});
