import { normalizeConfig } from './config.js';

export const name = 'dsh-companion';

/**
 * 插件入口：先 fail-fast 校验配置，成功仅记录日志，不做任何平台注册
 * （注册与装配由后续任务卡接线）。
 * @param {{logger?: {info?: Function}}} ctx 平台上下文
 * @param {Record<string, unknown>} [rawConfig] 用户原始配置
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  ctx?.logger?.info?.('[dsh-companion] config ok', { warnings: config.warnings });
}
