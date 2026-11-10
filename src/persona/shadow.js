/**
 * P2（v0.5.0）：遮蔽宿主默认人设。
 *
 * 宿主 0.4.x 没有 `deployment:persona` 段，人设本体来自全局层注册的
 * `deployment:persona-prefix`（order 0），尾段是 `deployment:persona-suffix`
 * （order 10200）。同名 section 不能再注册（全局层必抛），唯一安全的改写入口
 * 是 `system-prompt/assemble` waterfall：宿主把本次装配结果、装配 context 和
 * `next()` 交给监听器，监听器返回新的 assembly。
 *
 * 三种模式：
 * - `off`：接线层完全不注册监听器，默认路径与旧版本逐字节一致；
 * - `rewrite`：只把 prefix 的 `text` 换成人格卡身份，位置/其它属性保留；
 * - `takeover`：摘掉 prefix，以及空/纯空白的 suffix（非空 suffix 保留并 warn）。
 *
 * 本模块不读写宿主状态、不联网；`applyDeploymentShadow` 以纯函数形式返回新
 * 数组/新对象，绝不原地修改传入的 sections（其它监听器可能仍持有引用）。
 */

import { classifySession } from '../session/identity.js';

/** 宿主默认人设段的段名（0.4.x 事实，见 docs/persona-deployment-host.md）。 */
export const DEPLOYMENT_PREFIX_SECTION = 'deployment:persona-prefix';
/** 宿主默认人设尾段的段名。 */
export const DEPLOYMENT_SUFFIX_SECTION = 'deployment:persona-suffix';

/** 配置允许的三种取值。 */
export const SHADOW_MODES = Object.freeze(['off', 'rewrite', 'takeover']);

/**
 * 把配置值归一为三态；无法识别时返回 null（由配置层抛 ConfigError）。
 *
 * `true` 等价 `'rewrite'`，`false` 等价 `'off'`；undefined 视为默认 `'off'`。
 *
 * @param {unknown} value
 * @returns {'off'|'rewrite'|'takeover'|null}
 */
export function normalizeShadowMode(value) {
  if (value === undefined || value === false) return 'off';
  if (value === true) return 'rewrite';
  if (typeof value === 'string' && SHADOW_MODES.includes(value)) return value;
  return null;
}

/**
 * 按模式改写一次 assembly 的 sections。
 *
 * 调用方必须传入 `next()` 已解析出的最终 sections；本函数不调用 next、不写日志
 * 以外的副作用。返回原数组引用表示「无需改动」。
 *
 * v0.5.1 V50-M2：`rewrite` 把替换段标成 `interpolate: false`——替换文本来自人格卡、
 * 已降级，宿主不能再当模板插值一遍；`takeover` 摘段，不产生新文本，故不涉及。
 *
 * @param {unknown} sections
 * @param {{mode: 'off'|'rewrite'|'takeover', personaText?: string,
 *          warn?: (message: string, meta?: object) => void}} options
 * @returns {unknown} 新数组，或原引用（非数组/未变化）
 */
export function applyDeploymentShadow(sections, options = {}) {
  const { mode, personaText = '', warn = () => {} } = options;
  if (mode === 'off' || !Array.isArray(sections)) return sections;
  // 配置层已拒绝非法值；直接调用本函数时也不猜语义，未知模式一律不动。
  if (mode !== 'rewrite' && mode !== 'takeover') return sections;

  const hasPrefix = sections.some((section) => section?.name === DEPLOYMENT_PREFIX_SECTION);
  const hasSuffix = sections.some((section) => section?.name === DEPLOYMENT_SUFFIX_SECTION);

  // 宿主改版（段名又变）时唯一可观测的信号：两个默认段都不在。只 warn 一次，
  // 由 createAssembleHandler 的 warnOnce 负责去重；这里不阻断装配。
  if (!hasPrefix && !hasSuffix) {
    warn('[dsh-companion] deployment persona sections missing; shadow skipped', {
      reason: 'missing-sections',
      mode,
      missing: [DEPLOYMENT_PREFIX_SECTION, DEPLOYMENT_SUFFIX_SECTION],
    });
    return sections;
  }

  if (mode === 'rewrite') {
    if (!hasPrefix) {
      warn('[dsh-companion] deployment persona prefix missing; rewrite skipped', {
        reason: 'rewrite-missing-prefix',
        mode,
        missing: [DEPLOYMENT_PREFIX_SECTION],
      });
      return sections;
    }
    const next = sections.map((section) => (
      section?.name === DEPLOYMENT_PREFIX_SECTION
        // v0.5.1 V50-M2：替换文本来自人格卡、已按 renderTemplate 降级，必须显式
        // `interpolate: false`；否则宿主会把它再当模板插值一遍，卡里的
        // `{time}`/半截 `{{` 仍可能让整轮渲染抛错（其余段保持宿主原样）。
        ? { ...section, text: personaText, interpolate: false }
        : section
    ));
    return next;
  }

  // takeover
  const kept = [];
  let keptNonEmptySuffix = false;
  for (const section of sections) {
    if (section?.name === DEPLOYMENT_PREFIX_SECTION) continue;
    if (section?.name === DEPLOYMENT_SUFFIX_SECTION) {
      const text = section.text;
      if (typeof text === 'string' && text.trim() === '') continue;
      // 非字符串（例如动态函数）无法判定为空，按「非空」保守保留。
      keptNonEmptySuffix = true;
    }
    kept.push(section);
  }
  if (keptNonEmptySuffix) {
    warn('[dsh-companion] non-empty deployment:persona-suffix kept by takeover', {
      reason: 'non-empty-suffix',
      mode,
      section: DEPLOYMENT_SUFFIX_SECTION,
    });
  }
  return kept.length === sections.length ? sections : kept;
}

/**
 * 生成 `system-prompt/assemble` waterfall 监听器。
 *
 * 只处理 agent scope：宿主把 `context.scope` 设成当前 agent 实例（实测
 * `context.scope === context.agent`），全局/其它 scope 原样放行。子代理按现有
 * `classifySession()` 判定（`header.origin === 'subagent'`，或带 delegationDepth
 * 的旧 header）跳过遮蔽；fork 子会话若 header 只有 parentSession、没有 origin/
 * delegationDepth，会被 classifySession 归为 main，仍会遮蔽（见文档限制）。
 *
 * 先 `await next()` 拿到瀑布后的最终 assembly，再只读地构造新对象；任何异常都
 * 被吞掉并只 warn 一次，然后返回 next() 的原值，绝不阻断装配。
 *
 * @param {{mode: 'off'|'rewrite'|'takeover', personaText?: string,
 *          warn?: (message: string, meta?: object) => void,
 *          onApplied?: (info: {mode: string, rewritten: boolean}) => void}} options
 *   `onApplied` 只在**真的改动了**装配结果时调用（V50-L3 的 `/状态` 装配记录用）：
 *   它不参与装配决策，抛错也吞掉，避免排障信息反过来打断对话。
 * @returns {(assembly: object, context: object, next: Function) => Promise<object>}
 */
export function createAssembleHandler(options = {}) {
  const { mode, personaText = '', warn = () => {}, onApplied = null } = options;
  const warned = new Set();
  /** 去重后的告警：同一原因在进程生命周期内最多一条。 */
  const warnOnce = (message, meta = {}) => {
    const key = typeof meta.reason === 'string' ? meta.reason : message;
    if (warned.has(key)) return;
    warned.add(key);
    try {
      warn(message, meta);
    } catch {
      // 告警本身不能反过来影响装配。
    }
  };

  return async function assembleShadow(assembly, context, next) {
    const resolved = await next();
    if (mode === 'off') return resolved;
    try {
      if (context === null || typeof context !== 'object') return resolved;
      const agent = context.agent;
      if (agent === null || agent === undefined) return resolved;
      // 只有 agent scope 才遮蔽；宿主实测 scope 就是 agent 实例本身。
      if (context.scope !== agent) return resolved;
      // 子代理不遮蔽：沿用 /状态 与会话路由同一套判定。
      if (classifySession(agent).kind === 'subagent') return resolved;
      const sections = resolved?.sections;
      if (!Array.isArray(sections)) return resolved;
      const transformed = applyDeploymentShadow(sections, { mode, personaText, warn: warnOnce });
      if (transformed === sections) return resolved;
      if (typeof onApplied === 'function') {
        try {
          onApplied({ mode, rewritten: mode === 'rewrite' });
        } catch {
          // 装配记录失败不影响装配本身。
        }
      }
      return { ...resolved, sections: transformed };
    } catch (error) {
      warnOnce('[dsh-companion] deployment persona shadow failed; host persona left unchanged', {
        reason: 'handler-failed',
        mode,
        message: error instanceof Error ? error.message : String(error),
      });
      return resolved;
    }
  };
}
