/**
 * v0.4.10 V9-L1/L2：敏感判定收窄（token / 银行卡）与补漏（口令 / 设备值）。
 *
 * V9-L1 误报：裸 `\btoken\b` 会把「用户这个月 token 额度约 10B」判成凭据；裸
 * 「银行卡」会把「用户的银行卡在招行」判成凭据。收窄后 token 只在「字段名 + 值」
 * 形态命中，银行卡只在卡号形态（12 位以上数字，允许空格/连字符分隔）命中；
 * 卡号字段名（`卡号` / `card number`）也要求后面跟数字。
 *
 * V9-L2 漏报：「路由器口令是蓝鲸-7788」「WiFi 是 蓝鲸-7788」此前返回 false；
 * 现在由 `口令` 强词与「设备/网络名词 + 是/为/:/= + 含数字或符号的值」形态覆盖。
 *
 * 逐条覆盖验收里的正反例，并保留 V7-M3 的旧敏感面与负向排除（密码学 /
 * tokenizer / keyboard / key is abcd）回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, isSensitiveText, scan } from '../src/memory/govern.js';
import { Store } from '../src/memory/store.js';

const NOW_MS = Date.UTC(2026, 10, 5, 9, 0, 0);

// ------------------------------------------------- V9-L1：token 收窄

test('V9-L1：token 纯提及/额度讨论不再判敏感', () => {
  assert.equal(isSensitiveText('用户这个月 token 额度约 10B'), false);
  assert.equal(isSensitiveText('这个月 token 用量大约 10B'), false);
  assert.equal(isSensitiveText('项目里 token 预算还剩一半'), false);
});

test('V9-L1：token 字段值仍判敏感', () => {
  assert.equal(isSensitiveText('token 是 abc123'), true);
  assert.equal(isSensitiveText('API token：sk-xxxxxx'), true);
  assert.equal(isSensitiveText('access token 是 abc123'), true);
  assert.equal(isSensitiveText('这个 token 是 abc123'), true);
});

// ------------------------------------------------- V9-L1：银行卡收窄

test('V9-L1：银行卡/信用卡纯提及不再判敏感', () => {
  assert.equal(isSensitiveText('用户的银行卡在招行'), false);
  assert.equal(isSensitiveText('用户的信用卡在招行'), false);
  assert.equal(isSensitiveText('银行卡和信用卡都办了'), false);
});

test('V9-L1：卡号形态（12 位以上数字，允许空格/连字符）仍判敏感', () => {
  assert.equal(isSensitiveText('银行卡 6222 0202 0000 1234'), true);
  assert.equal(isSensitiveText('银行卡 6222-0202-0000-1234'), true);
  assert.equal(isSensitiveText('6222020200001234'), true);
  assert.equal(isSensitiveText('卡号 6222 0000 1111'), true);
  assert.equal(isSensitiveText('card number 4111-1111'), true);
  assert.equal(isSensitiveText('银行卡号 6222'), true, '旧用例：卡号字段名 + 数字');
});

test('V9-L1：不足 12 位的数字/日期不被当成卡号', () => {
  assert.equal(isSensitiveText('订单号 12345678'), false);
  assert.equal(isSensitiveText('会议定在 2026-11-05 20:51'), false);
});

// ------------------------------------------------- V9-L2：口令 / 设备值

test('V9-L2：口令强词命中（路由器口令），不再漏报', () => {
  assert.equal(isSensitiveText('路由器口令是蓝鲸-7788'), true);
  assert.equal(isSensitiveText('口令：蓝鲸-7788'), true);
  assert.equal(isSensitiveText('门禁口令 8848'), true);
});

test('V9-L2：设备/网络名词 + 判断词 + 含数字或符号的值命中（WiFi），不再漏报', () => {
  assert.equal(isSensitiveText('WiFi 是 蓝鲸-7788'), true);
  assert.equal(isSensitiveText('wifi为blue-7788'), true);
  assert.equal(isSensitiveText('Wi-fi：home-8899'), true);
  assert.equal(isSensitiveText('路由器是 华硕AX6000'), true);
  assert.equal(isSensitiveText('热点是 5G-8899'), true);
});

test('V9-L2：设备名词的纯提及或纯文字值不误报', () => {
  assert.equal(isSensitiveText('路由器的说明书在哪'), false);
  assert.equal(isSensitiveText('WiFi 是 家里的网络'), false);
  assert.equal(isSensitiveText('门锁是 指纹款'), false);
  assert.equal(isSensitiveText('热点是 公司大楼'), false);
});

// ------------------------------------------------- V7-M3 旧用例回归

test('V7-M3 回归：既有敏感面仍命中', () => {
  const hits = [
    '我的 wifi 密码是 蓝鲸-7788',
    '密码：蓝鲸-7788',
    'password 是 hunter2',
    'passwd = 1234',
    'API key 是 sk-abc123',
    'apikey: abc123xyz',
    '验证码 123456',
    'verification code 778899',
    'CVV 123',
    '私钥放在文件里',
    'secret: hunter2',
    'pwd=1234',
    '身份证 110101199001011234',
    '我的身份证号码是 110101',
    'wifi 密码是 abc',
    '银行卡密码要改',
    '我的银行卡密码是 123456',
    '我家住址在朝阳区',
  ];
  for (const text of hits) {
    assert.equal(isSensitiveText(text), true, `应命中：${text}`);
  }
});

test('V7-M3 回归：学科词 / 分词器 / 普通英文不误伤', () => {
  const misses = [
    '密码学很有趣',
    '密码学和 tokenizer 有什么区别？',
    'tokenizer 怎么用',
    'keyboard 坏了',
    'key is abcd',
    '我喜欢喝咖啡',
    '',
    null,
    undefined,
  ];
  for (const text of misses) {
    assert.equal(isSensitiveText(text), false, `不应命中：${String(text)}`);
  }
});

// ------------------------------------------------- 治理链路集成

test('V9-L1 集成：scan/apply 只把 token 字段值的事实计入 sensitive', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const observedAt = Math.floor(NOW_MS / 1000);
  const normal = store.insertFact({
    kind: 'preference',
    subject_text: '用户',
    predicate: 'token 额度',
    object_text: '约 10B',
    statement: '用户这个月 token 额度约 10B',
    source_kind: 'user_explicit',
    observed_at: observedAt,
  });
  const sensitive = store.insertFact({
    kind: 'knowledge',
    subject_text: 'API',
    predicate: 'token',
    object_text: 'sk-abc123',
    statement: 'API token 是 sk-abc123',
    source_kind: 'user_explicit',
    observed_at: observedAt,
  });

  const report = scan({ store, now: NOW_MS });
  assert.equal(report.counts.sensitive, 1);

  const dry = apply({ store, now: NOW_MS });
  assert.deepEqual(dry.sensitive.map((item) => item.id), [sensitive.id]);
  assert.equal(dry.sensitive.some((item) => item.id === normal.id), false);
});
