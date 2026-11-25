/**
 * v0.7.19 T5：v0.7.18 评审遗留两处关键串（{@link extractKeyPhrases}）缺陷。
 *
 * - V718-L1：超长 CJK 切分后，不含虚词的 13–24 字段仍整段入键
 *   （实测「用户喜欢珞然邻居姐姐人格卡版本四号定稿」18 字），与 v0.7.18
 *   CHANGELOG「切不出有效段时整段丢弃」不符；
 * - V718-L2：英文段正则把 `index.js` 整体取出，`index.js !== index` ⇒ 绕过
 *   路径停用词；改为比停用词前先剥末尾扩展名。
 *
 * 全部为「非真机证据」：只验证纯函数抽取结果，不涉及真实模型裁决或宿主路由。
 * T5 只改纯函数，零 DDL（SCHEMA_VERSION 不变）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractKeyPhrases } from '../src/memory/dedupe.js';

test('T5-L1（v0.7.19 非真机证据）：无虚词的超长 CJK 整句丢弃，不再整体入关键串', () => {
  // 判别力：删掉 src/memory/dedupe.js:233 的 `if (piece.length > 12) continue;` → 18 字整句重新入键，本用例红。
  const sentence = '用户喜欢珞然邻居姐姐人格卡版本四号定稿';
  assert.ok(sentence.length > 12 && sentence.length <= 24, '样本应落在 13–24 字区间');
  const phrases = extractKeyPhrases(sentence);
  assert.ok(!phrases.includes(sentence), '整句不应入关键串：' + JSON.stringify(phrases));
  assert.ok(phrases.every((phrase) => phrase.length <= 12), '任何入键段都不应超过 12 字：' + JSON.stringify(phrases));
  assert.deepEqual(phrases, [], '切不出有效段时应整段丢弃：' + JSON.stringify(phrases));

  // 对照：含虚词的超长 CJK 仍按虚词切出有效短段（防「顺手加严」导致过度丢弃）。
  const control = '后台任务在云端服务器上运行很好的';
  const controlPhrases = extractKeyPhrases(control);
  assert.ok(!controlPhrases.includes(control), '对照句整句也不应入键：' + JSON.stringify(controlPhrases));
  assert.ok(controlPhrases.length > 0, '对照句仍应切出有效短段：' + JSON.stringify(controlPhrases));
  assert.ok(controlPhrases.every((phrase) => phrase.length <= 12), '切分后每段都应 ≤12 字：' + JSON.stringify(controlPhrases));

  // 对照：13 字符英文项目名不受 CJK 专用 gate 影响（证明丢弃没有加进全局 push）。
  assert.ok(extractKeyPhrases('/opt/data/work/dsh-companion/src/index.js').includes('dsh-companion'),
    '13 字符英文项目名 dsh-companion 不应被误杀');
});

test('T5-L2（v0.7.19 非真机证据）：停用词比对前剥掉扩展名，index.js 等通用文件名不入键', () => {
  // 判别力：删掉 src/memory/dedupe.js:212 的 `const bare = key.replace(FILE_EXTENSION, '')` 并把比较改回 `key` → index.js/data.json 等重新入键，本用例红。
  const pathText = '/opt/data/work/dsh-companion/src/index.js';
  const phrases = extractKeyPhrases(pathText);
  for (const noise of ['index.js', 'index']) {
    assert.ok(!phrases.some((phrase) => phrase.toLowerCase() === noise),
      noise + ' 不应成为关键串：' + JSON.stringify(phrases));
  }
  assert.ok(phrases.includes('dsh-companion'), '项目名应保留：' + JSON.stringify(phrases));

  // 通用文件名 × 不同扩展名：剥掉扩展名后应命中未带扩展名的停用词。
  for (const [file, text] of [
    ['index.js', '/opt/data/work/dsh-companion/src/index.js'],
    ['data.json', '/opt/data/work/dsh-companion/data.json'],
    ['config.ts', '/home/dev/dsh-companion/config.ts'],
    ['app.py', '/opt/data/work/dsh-companion/app.py'],
    ['utils.mjs', '/opt/data/work/dsh-companion/src/utils.mjs'],
  ]) {
    const out = extractKeyPhrases(text);
    const bare = file.slice(0, file.lastIndexOf('.'));
    for (const noise of [file, bare]) {
      assert.ok(!out.some((phrase) => phrase.toLowerCase() === noise),
        noise + ' 不应成为关键串（样本 ' + file + '）：' + JSON.stringify(out));
    }
  }

  // 对照：既有版本/日期 gate 行为不变（剥扩展名不影响 VERSION_ONLY / DATE_TIME_ONLY）。
  const gated = extractKeyPhrases('升级到 24.3.1，2026-11-24 10:30 上线');
  assert.ok(!gated.includes('24.3.1'), '纯版本号仍被 gate 挡住：' + JSON.stringify(gated));
  assert.ok(!gated.some((phrase) => /^\d{4}-\d{2}-\d{2}$/u.test(phrase)), '纯日期仍被 gate 挡住：' + JSON.stringify(gated));
});
