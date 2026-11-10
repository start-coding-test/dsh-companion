/**
 * v0.5.1 回归：
 * - V50-M2：卡里的未知模板占位符（`{{time}}`、`{{random:a,b}}`、`{{original}}` 等）
 *   在渲染期降级成 `{...}`（输出里没有 `{{`）；人格段注册时带 `interpolate: false`；
 *   rewrite 模式替换后的段也带 `interpolate: false`。
 * - V50-L2：卡文本里的 `<!-- ... -->` 在渲染前剥离；未闭合时保守原样保留并告警。
 *
 * 背景（已取证）：宿主 dsh-system-prompt 的插值器遇到未注册的 `{{...}}` **不是忽略
 * 而是整轮抛错**（`.dsh-src/dsh-system-prompt/lib/index.js:160-184`）。所以下面用
 * 一个复刻其语义的严格 mock 跑「注册 section → 渲染」的路径，而不只断言字符串。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CARD,
  parseCardSource,
  parseCardSourceDetailed,
  renderTemplate,
  stripHtmlComments,
} from '../src/persona/card.js';
import { buildSections, buildSectionsWithDiagnostics } from '../src/persona/sections.js';
import { buildChatPrompt } from '../src/persona/chat.js';
import { DEPLOYMENT_PREFIX_SECTION, applyDeploymentShadow } from '../src/persona/shadow.js';

// ------------------------------------------------------------ 宿主严格 mock（只读复刻）

/** 与宿主同口径：合法变量名 / 完整引用组（lib/index.js:65,67）。 */
const HOST_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const HOST_GROUP_AT = /^\{\{([^{}]*)\}\}/;

class HostPromptError extends Error {}

/**
 * 复刻宿主 interpolate()（lib/index.js:160-184）：
 * 未注册变量、名字不合法、值为 undefined 一律抛错；半截 `{{`（后面没有 `}}`）当普通文本。
 *
 * @param {unknown} text
 * @param {Record<string, unknown>} variables
 * @param {'section'|'context'} kind
 * @param {string} name
 * @returns {string}
 */
function hostInterpolate(text, variables, kind, name) {
  const source = String(text ?? '');
  let out = '';
  let last = 0;
  let open = source.indexOf('{{', last);
  while (open >= 0) {
    const group = HOST_GROUP_AT.exec(source.slice(open));
    if (group === null) {
      // 半截 `{{`：宿主把它当普通散文继续渲染，不抛错。
      if (source.indexOf('}}', open + 2) < 0) break;
      throw new HostPromptError(
        `malformed prompt variable reference at "${source.slice(open, open + 12)}" in ${kind} "${name}"`,
      );
    }
    const varName = group[0].slice(2, -2);
    if (!HOST_VARIABLE_NAME.test(varName)) {
      throw new HostPromptError(
        `malformed prompt variable reference "{{${varName}}}" in ${kind} "${name}"`,
      );
    }
    if (!Object.hasOwn(variables, varName)) {
      throw new HostPromptError(`unknown prompt variable "{{${varName}}}" in ${kind} "${name}"`);
    }
    const value = variables[varName];
    if (value === undefined) {
      throw new HostPromptError(
        `prompt variable "{{${varName}}}" in ${kind} "${name}" resolved to undefined`,
      );
    }
    out += source.slice(last, open) + String(value);
    last = open + group[0].length;
    open = source.indexOf('{{', last);
  }
  return out + source.slice(last);
}

/**
 * 复刻 renderPrompt()（lib/index.js:120）：只有 `interpolate === false` 才跳过插值，
 * 其余（含 undefined / true）一律插值。
 *
 * @param {ReadonlyArray<{name: string, text: string, interpolate?: boolean}>} sections
 * @param {Record<string, unknown>} variables
 * @returns {string}
 */
function hostRenderPrompt(sections, variables) {
  return sections
    .map((section) => (section.interpolate === false
      ? section.text
      : hostInterpolate(section.text, variables, 'section', section.name)))
    .join('\n\n');
}

/** 复刻 src/platform/adapter.js:375-382：`platform.section()` 原样转发对象。 */
function hostRegister(sections) {
  const registered = [];
  for (const section of sections) registered.push(section);
  return registered;
}

/** v0.5.0 的渲染算法（只有 `{{char}}`/`{{user}}`），用于对照「修之前」的行为。 */
function legacyRender(text, card) {
  return text.split('{{char}}').join(card.name).split('{{user}}').join(card.address);
}

// ------------------------------------------------------------------------ 测试用卡

/** 同时含 `{{random:a,b}}`、`{{time}}`、`{{original}}` 与一条 HTML 注释的原生卡。 */
const TEMPLATE_CARD = {
  name: '阿岩',
  address: '你',
  description: '你是{{char}}，{{user}}的老同学。现在是{{time}}，天气{{random:晴,雨}}。',
  personality: '嘴硬心软<!-- 备注：不要进提示词 -->',
  scenario: '{{char}} 和 {{user}} 合租；{{original}}。',
  mes_example: '<START>\n{{char}}：回来了？',
  first_mes: '哟。',
  tone: {
    style: '简短',
    warmth: '温和',
    structure: '先结论',
    notes: '不夸张',
    voice: '语速慢',
  },
};

/** @param {Record<string, unknown>} [overrides] */
function templateCardText(overrides = {}) {
  return JSON.stringify({ ...TEMPLATE_CARD, ...overrides });
}

/** @param {Record<string, unknown>} [overrides] */
function loadTemplateCard(overrides = {}) {
  return parseCardSourceDetailed(templateCardText(overrides));
}

describe('V50-M2 渲染期降级', () => {
  test('renderTemplate：未知占位符降级为单花括号，输出里没有 {{', () => {
    const card = parseCardSource(templateCardText());
    const out = renderTemplate(card.description, card);
    assert.ok(!out.includes('{{'), `仍有 {{：${out}`);
    assert.ok(out.includes('阿岩'));
    assert.ok(out.includes('你的老同学'));
    assert.ok(out.includes('{time}'));
    assert.ok(out.includes('{random:晴,雨}'));
  });

  test('renderTemplate：只替换 {{char}}/{{user}}，半截 {{ 与孤立 }} 按文本保留', () => {
    const context = { name: 'A', address: 'B' };
    assert.equal(renderTemplate('{{char}}与{{user}}', context), 'A与B');
    assert.equal(renderTemplate('{{time}}', context), '{time}');
    assert.equal(renderTemplate('{{random:a,b}}', context), '{random:a,b}');
    assert.equal(renderTemplate('{{user}} 说了 {{char}} 的名字', context), 'B 说了 A 的名字');
    // 半截 `{{`（后面没有 `}}`）宿主当普通散文，这里也降成单花括号，保证没有 `{{`。
    assert.equal(renderTemplate('半截 {{ 没有结尾', context), '半截 { 没有结尾');
    assert.equal(renderTemplate('孤立 }} 结束', context), '孤立 }} 结束');
    assert.equal(renderTemplate('{{ Character }}', context), '{ Character }');
  });

  test('renderTemplate：非字符串原样返回', () => {
    assert.equal(renderTemplate(null, { name: 'A' }), null);
    assert.equal(renderTemplate(42, { name: 'A' }), 42);
    assert.equal(renderTemplate(undefined, {}), undefined);
  });

  test('buildSections：每段带 interpolate:false，文本里没有 {{、没有注释', () => {
    const card = parseCardSource(templateCardText());
    const sections = buildSections(card);
    assert.deepEqual(sections.map((section) => section.name), [
      'persona:safety', 'persona:core', 'persona:voice', 'persona:protocol',
    ]);
    for (const section of sections) {
      assert.equal(section.interpolate, false, `${section.name} 缺 interpolate:false`);
      assert.ok(!section.text.includes('{{'), `${section.name} 残留 {{`);
      assert.ok(!section.text.includes('<!--'), `${section.name} 残留注释`);
      assert.ok(!section.text.includes('-->'), `${section.name} 残留注释结尾`);
    }
    const core = sections.find((section) => section.name === 'persona:core');
    assert.ok(core.text.includes('{time}'));
    assert.ok(core.text.includes('{random:晴,雨}'));
    assert.ok(core.text.includes('{original}'));
  });

  test('buildChatPrompt：占位符已降级、注释已剥离', () => {
    const card = parseCardSource(templateCardText());
    const prompt = buildChatPrompt({ card });
    assert.ok(!prompt.includes('{{'), `仍有 {{：${prompt}`);
    assert.ok(!prompt.includes('<!--'));
    assert.ok(!prompt.includes('-->'));
    assert.ok(prompt.includes('{time}'));
    assert.ok(prompt.includes('{random:晴,雨}'));
    // 人设要点来自 description，剥注释后正文必须保留。
    assert.ok(prompt.includes('老同学'));
  });

  test('严格 mock：修之前同一段文本会让宿主整轮抛错（证明 mock 是严格的）', () => {
    const card = parseCardSource(templateCardText());
    const legacyText = legacyRender(card.description, card); // v0.5.0：只换 char/user
    assert.ok(legacyText.includes('{{time}}'));
    assert.throws(
      () => hostRenderPrompt([{ name: 'persona:core', text: legacyText }], { model: 'm' }),
      /unknown prompt variable "\{\{time\}\}"/,
    );
    // `interpolate: true` 与未设置的段都会插值，只有 `=== false` 才免疫。
    assert.throws(
      () => hostRenderPrompt([{ name: 'persona:core', text: '{{time}}', interpolate: true }], {}),
      /unknown prompt variable/,
    );
  });

  test('严格 mock：注册 buildSections 输出 → 渲染不抛错（V50-M2 主路径）', () => {
    const card = parseCardSource(templateCardText());
    const variables = { model: 'm' };
    const registered = hostRegister(buildSections(card));
    let rendered = '';
    assert.doesNotThrow(() => {
      rendered = hostRenderPrompt(registered, variables);
    });
    assert.ok(!rendered.includes('{{'));
    assert.ok(rendered.includes('{time}'));
    assert.ok(rendered.includes('{random:晴,雨}'));
    assert.ok(rendered.includes('{original}'));
    // 卡里出现的已注册变量 `{{model}}` 也不该被替换（段文本一律原样使用）。
    const withModel = loadTemplateCard({ personality: '用 {{model}} 自称' });
    const sections = hostRegister(buildSections(withModel.card));
    const text = hostRenderPrompt(sections, variables);
    assert.ok(text.includes('{model}'), '占位符应在渲染期降级为 {model}');
  });

  test('buildSectionsWithDiagnostics：每段 interpolate === false 且冻结', () => {
    const card = parseCardSource(templateCardText());
    const { sections } = buildSectionsWithDiagnostics(card);
    for (const section of sections) {
      assert.equal(section.interpolate, false);
      assert.ok(Object.isFrozen(section));
    }
  });

  test('rewrite：替换段带 interpolate:false，宿主不再二次插值', () => {
    const base = [
      { name: 'harness:identity', text: 'HOST' },
      { name: DEPLOYMENT_PREFIX_SECTION, text: 'You are a coding agent.', order: 0 },
      { name: 'tool:read', text: 'READ', order: 100 },
    ];
    // 故意传入含 `{{...}}` 的替换文本：即使上游漏了降级，标记也必须让宿主原样使用。
    const personaText = '你是用户的私人助手。现在是{{time}}。';
    const result = applyDeploymentShadow(base, { mode: 'rewrite', personaText });
    assert.equal(result[1].interpolate, false);
    assert.equal(result[1].text, personaText);
    assert.equal(result[0].interpolate, undefined, '其它段的标记不被改动');
    assert.equal(result[2].interpolate, undefined);

    const variables = { model: 'm' };
    let rendered = '';
    assert.doesNotThrow(() => {
      rendered = hostRenderPrompt(result, variables);
    });
    assert.ok(rendered.includes('现在是{{time}}。'), '原样使用，不插值');
    // 去掉标记后同一段会被宿主插值 → 未注册变量抛错。
    assert.throws(
      () => hostRenderPrompt([{ ...result[1], interpolate: undefined }], variables),
      /unknown prompt variable "\{\{time\}\}"/,
    );
  });

  test('内置卡：buildSections 输出与 v0.5.0 逐字节一致（无占位符/注释可降级）', () => {
    const card = DEFAULT_CARD;
    const context = { name: card.name, address: card.address };
    const sections = buildSections(card);
    assert.deepEqual(sections.map((section) => section.name), [
      'persona:safety', 'persona:core', 'persona:protocol',
    ]);
    for (const field of ['description', 'chatIdentity', 'mes_example']) {
      const raw = card[field];
      assert.equal(renderTemplate(raw, context), legacyRender(raw, context), `${field} 渲染结果变了`);
      assert.ok(!renderTemplate(raw, context).includes('{{'));
    }
    for (const section of sections) {
      assert.equal(section.interpolate, false);
      assert.ok(!section.text.includes('{{'));
      assert.ok(!section.text.includes('<!--'));
    }
  });

  test('内置卡：解析/合并后与原卡深相等，且不产生新 warning', () => {
    const { card, warnings } = parseCardSourceDetailed(JSON.stringify(DEFAULT_CARD));
    assert.deepEqual(card, DEFAULT_CARD);
    assert.deepEqual(warnings, []);
  });
});

describe('V50-L2 卡文本 HTML 注释', () => {
  test('stripHtmlComments：非贪婪、跨行、多处', () => {
    assert.equal(stripHtmlComments('无注释'), '无注释');
    assert.equal(stripHtmlComments('a<!--x-->b'), 'ab');
    assert.equal(stripHtmlComments('<!--a--><!--b-->'), '');
    assert.equal(stripHtmlComments('中<!--a--> 间 <!--b-->尾'), '中 间 尾');
    assert.equal(stripHtmlComments('前\n<!-- 多行\n注释 -->\n后'), '前\n\n后');
    // 非贪婪：一行里两段注释都要剥掉，而不是一路吃到最后一个 `-->`。
    assert.equal(stripHtmlComments('a<!--1-->b<!--2-->c'), 'abc');
  });

  test('stripHtmlComments：未闭合的 <!-- 原样保留（不吞正文）', () => {
    const text = '保留 <!-- 只有开头\n正文';
    assert.equal(stripHtmlComments(text), text);
    // 前面有正常注释、后面出现未闭合：整段保守原样返回，不做半截剥离。
    const mixed = 'a<!--x-->b<!--y';
    assert.equal(stripHtmlComments(mixed), mixed);
    assert.equal(stripHtmlComments(''), '');
    assert.equal(stripHtmlComments(null), null);
  });

  test('卡加载：所有文本字段的注释被剥离，正文保留', () => {
    const source = JSON.stringify({
      name: '注释卡',
      address: '你',
      description: '前文<!-- 备注：不要进提示词 -->后文',
      personality: '正常<!-- hidden -->',
      scenario: '第一行\n<!-- 多行\n注释 -->\n第二行',
      mes_example: '<START>\n{{char}}<!--x-->：在。',
      first_mes: '哟<!--c-->',
      post_history_instructions: '简短<!--x-->',
      chatIdentity: '你是{{char}}<!-- c -->。',
      tone: {
        style: '简短<!--x-->',
        warmth: '温和',
        structure: '先结论',
        notes: 'a<!--x-->b',
        voice: 'v<!--x-->',
      },
      values: ['甲<!--x-->', '乙'],
      taboos: ['丙<!--y-->'],
      bannedPhrases: ['丁<!--z-->'],
    });
    const { card, warnings } = parseCardSourceDetailed(source);
    assert.equal(card.description, '前文后文');
    assert.equal(card.personality, '正常');
    assert.equal(card.scenario, '第一行\n\n第二行');
    assert.equal(card.mes_example, '<START>\n{{char}}：在。');
    assert.equal(card.first_mes, '哟');
    assert.equal(card.post_history_instructions, '简短');
    assert.equal(card.chatIdentity, '你是{{char}}。');
    assert.equal(card.tone.style, '简短');
    assert.equal(card.tone.notes, 'ab');
    assert.equal(card.tone.voice, 'v');
    assert.deepEqual(card.values, ['甲', '乙']);
    assert.deepEqual(card.taboos, ['丙']);
    assert.deepEqual(card.bannedPhrases, ['丁']);
    // 全部闭合，不应该有告警。
    assert.deepEqual(warnings.filter((warning) => warning.code === 'html_comment_unterminated'), []);

    const joined = buildSections(card).map((section) => section.text).join('\n');
    assert.ok(!joined.includes('<!--'));
    assert.ok(!joined.includes('-->'));
    assert.ok(joined.includes('前文后文'));
    const prompt = buildChatPrompt({ card });
    assert.ok(!prompt.includes('<!--'));
    assert.ok(!prompt.includes('-->'));
  });

  test('name / address 也剥注释（复审 L-2：身份字段曾漏清洗）', () => {
    const source = JSON.stringify({
      name: '岚<!-- 备注：不要进提示词 -->',
      address: '你<!--x-->',
      description: '正文',
      chatIdentity: '你是{{char}}，称呼对方为「{{user}}」。',
      tone: {},
    });
    const { card } = parseCardSourceDetailed(source);
    assert.equal(card.name, '岚');
    assert.equal(card.address, '你');

    const joined = buildSections(card).map((section) => section.text).join('\n');
    assert.ok(!joined.includes('<!--'), '身份字段的注释不得漏进人格段');
    assert.ok(!joined.includes('-->'));
    assert.equal(renderTemplate(card.chatIdentity, card), '你是岚，称呼对方为「你」。');
    assert.equal(buildChatPrompt({ card }).includes('<!--'), false);
  });

  test('未闭合注释：原样保留 + 一条 warning（detail 只放字段名）', () => {
    const source = JSON.stringify({
      name: '注释卡',
      address: '你',
      description: '正文<!-- 没关掉\n更多正文',
      tone: {},
    });
    const { card, warnings } = parseCardSourceDetailed(source);
    assert.equal(card.description, '正文<!-- 没关掉\n更多正文');
    const found = warnings.filter((warning) => warning.code === 'html_comment_unterminated');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].detail, ['description']);
    // 渲染兜底层不会二次告警（渲染函数没有告警通道），但也剥不掉未闭合注释。
    assert.equal(renderTemplate(card.description, card), '正文<!-- 没关掉\n更多正文');
  });

  test('renderTemplate 兜底：运行期拼进来的注释也被剥离', () => {
    assert.equal(renderTemplate('前<!-- 运行期 -->后', { name: 'a', address: 'b' }), '前后');
    assert.equal(
      renderTemplate('{{char}}<!-- x -->{{user}}', { name: 'A', address: 'B' }),
      'AB',
    );
  });

  test('占位符 warning：detail 只有名字，不含正文', () => {
    const { warnings } = loadTemplateCard();
    const found = warnings.filter((warning) => warning.code === 'template_placeholder_downgraded');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].detail, ['time', 'random:晴,雨', 'original']);
    assert.ok(Object.isFrozen(found[0].detail));
    for (const label of found[0].detail) {
      assert.ok(!label.includes('老同学'), 'detail 不能带正文');
      assert.ok(!label.includes('备注'), 'detail 不能带注释正文');
    }
  });

  test('只用 {{char}}/{{user}} 的卡不产生占位符 warning', () => {
    const { warnings } = loadTemplateCard({
      description: '你是{{char}}，{{user}}的老同学。',
      scenario: '合租。',
      personality: '嘴硬心软',
    });
    assert.equal(warnings.some((warning) => warning.code === 'template_placeholder_downgraded'), false);
  });

  test('CCv2 卡里的占位符与注释同样被处理（导入期 warning 叠加）', () => {
    const source = JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '阿岩',
        description: '你是{{char}}<!-- 备注 -->，现在是{{time}}。',
        personality: '嘴硬心软',
        scenario: '{{char}}和{{user}}合租。',
        character_book: { entries: [] },
      },
    });
    const { card, warnings } = parseCardSourceDetailed(source);
    assert.equal(card.description, '你是{{char}}，现在是{{time}}。');
    assert.deepEqual(warnings.map((warning) => warning.code), [
      'character_book_ignored',
      'template_placeholder_downgraded',
    ]);
    assert.deepEqual(warnings[1].detail, ['time']);
    const sections = buildSections(card);
    for (const section of sections) {
      assert.ok(!section.text.includes('{{'));
      assert.ok(!section.text.includes('<!--'));
    }
    assert.doesNotThrow(() => hostRenderPrompt(hostRegister(sections), { model: 'm' }));
  });
});
