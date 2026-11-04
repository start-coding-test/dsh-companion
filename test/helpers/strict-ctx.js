/**
 * 严格 Context 替身（C-H1）。
 *
 * 背景：真实 cordis 4 的 Context 是 Proxy，读**未声明 inject** 的 service 属性会抛
 *   `cannot get property "x" without inject`
 * （见 ReflectService.handler.get）。旧测试 ctx 是普通对象，读任何属性都不抛，
 * 所以「插件从未在真实宿主上激活」这类问题在 667 个用例里完全没暴露。
 *
 * 用法：
 * ```js
 * const { ctx } = makeCtx();
 * await apply(strictCtx(ctx), { dbPath });   // 被测代码只拿到严格代理
 * // 断言/操控仍用原始 ctx（logs、timers、dispatch …）
 * ```
 *
 * 代理规则（与 cordis 对齐）：
 * - symbol / `prototype` / `then` / 数字串 / 下划线开头：直接透传（cordis 的
 *   special property，不经过 inject 检查）。
 * - inject 声明的 service：返回目标对象的同名属性；没有则回落 `target.get(name)`
 *   （cordis 里声明了的 service 由 fiber store 提供，这里用 fake 的 get 模拟）。
 * - Context 自有属性（root/baseUrl/fiber/reflect/registry/events/logger）与
 *   mixin 方法（get/on/once/effect/plugin/interval/…）：允许读，函数绑回 target，
 *   保证 `this` 仍是被测 fake。
 * - 其余一切属性：抛 cordis 同文案错误。
 *
 * @module test/helpers/strict-ctx
 */
import * as plugin from '../../src/index.js';

/** Context 构造函数里直接赋值的自有属性（Reflect.has → true，无需 inject）。 */
const ROOT_PROPS = new Set([
  'root',
  'baseUrl',
  'fiber',
  'reflect',
  'registry',
  'events',
  'logger',
]);

/** cordis 各 Service 注册的 mixin 访问器（读它们不需要 inject，内部自己解析 service）。 */
const MIXINS = new Set([
  'get', 'set', 'provide', 'accessor', 'mixin',
  'runtime', 'effect',
  'inject', 'plugin',
  'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
  'timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval',
]);

/** fake ctx → (inject 签名 → proxy)，同一 fake/inject 组合复用同一个 proxy。 */
const CACHE = new WeakMap();

/**
 * 判断是否 cordis 的 special property（跳过 inject 检查）。
 * @param {string|symbol} prop
 * @returns {boolean}
 */
function isSpecialProperty(prop) {
  if (typeof prop === 'symbol') return true;
  if (prop === 'prototype' || prop === 'then') return true;
  if (prop.startsWith('_')) return true;
  const index = Number.parseInt(prop, 10);
  return Number.isFinite(index) && String(index) === prop;
}

/**
 * 包装一个测试 ctx，让未声明的属性读与真实 cordis 一样抛错。
 *
 * @param {object} target 测试 ctx（FakeCtx 或普通对象）
 * @param {{inject?: string[]}} [options] 覆盖默认的 inject 名单（默认取插件声明）
 * @returns {object} 严格代理
 */
export function strictCtx(target, options = {}) {
  if (target === null || typeof target !== 'object') {
    throw new TypeError('strictCtx(target): target must be an object');
  }
  const inject = Array.isArray(options.inject) ? options.inject : plugin.inject;
  if (!Array.isArray(inject)) {
    throw new TypeError('strictCtx(target): plugin.inject must be an array');
  }
  const signature = inject.join('\u0000');
  let bySignature = CACHE.get(target);
  if (bySignature === undefined) {
    bySignature = new Map();
    CACHE.set(target, bySignature);
  }
  const cached = bySignature.get(signature);
  if (cached !== undefined) return cached;

  const declared = new Set(inject);
  const proxy = new Proxy(target, {
    get(object, prop, receiver) {
      if (isSpecialProperty(prop)) return Reflect.get(object, prop, receiver);

      if (declared.has(prop)) {
        const value = Reflect.get(object, prop, object);
        if (value !== undefined) return value;
        return typeof object.get === 'function' ? object.get(prop) : undefined;
      }

      if (ROOT_PROPS.has(prop)) return Reflect.get(object, prop, object);

      if (MIXINS.has(prop)) {
        const value = Reflect.get(object, prop, object);
        if (typeof value === 'function') return value.bind(object);
        return value;
      }

      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    set(object, prop, value) {
      object[prop] = value;
      return true;
    },
    has(object, prop) {
      return Reflect.has(object, prop);
    },
  });

  bySignature.set(signature, proxy);
  return proxy;
}
