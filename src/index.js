/**
 * 插件入口：装配人格段、记忆管线、命令、工具与调度器。
 *
 * 设计约束（t12 / t23 / 07 §4）：
 * - 只做接线，不实现业务逻辑；所有能力来自已完成的模块与平台适配层；
 * - 不直接 import 任何 @deepseek-ai/* 包，平台调用统一经 createAdapter(ctx)；
 * - 宿主缺少某项服务时安静跳过（日志用 debug），不让插件装载失败；
 * - 配置非法时 fail-fast，抛 ConfigError 且不产生任何注册；
 * - 同一 ctx 二次 apply 是幂等的：返回同一个 { dispose } 句柄，不重复注册；
 * - dispose 关闭 Store、清掉 interval 与所有注册。
 *
 * 主链路（t23 H1）：
 *   每轮 agent/pre-step
 *     → 记录 token 度量（tokenMeter.measure）与转录快照
 *     → turn 头：planConsolidation 判定（hard > idle > threshold）
 *     → consolidate 先写库（成功才登记 pending_compact）
 *     → 同一 turn 头（若有上轮 pending）compactRegion(区间终点 ≤ 水位) → 成功后
 *       publishBoard('compact')
 *     → 召回经 assemble 预算裁切，同一 turn 只注入一次
 *   deep-sleep 03:00 不再空转：遗忘降级 + 状态板重渲染（staged）+ 审计。
 */
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { normalizeConfig } from './config.js';
import { Store } from './memory/store.js';
import { retrieve } from './memory/retrieve.js';
import { assemble } from './memory/assemble.js';
import {
  CONFIRM_ALPHA,
  DEFAULT_ALPHA,
  USE_OVERLAP_THRESHOLD,
  applyReinforcement,
  overlapRatio,
} from './memory/reinforce.js';
import { consolidate, planConsolidation } from './memory/consolidate.js';
import { publishBoard, renderBoard, stageBoard } from './memory/state-board.js';
import { boardSection, buildSections } from './persona/sections.js';
import { DEFAULT_CARD } from './persona/card.js';
import { createAdapter } from './platform/adapter.js';
import { MAIN_SCOPE, classifySession, threadScope } from './session/identity.js';
import { handleCommand } from './runtime/commands.js';
import { createMetrics } from './runtime/metrics.js';
import { createProactive } from './runtime/proactive.js';
import { JOB_IDS, createScheduler } from './runtime/scheduler.js';
import { createTools } from './runtime/tools.js';
import {
  createSurfaceIndex,
  planRegion,
  surfaceSeqs,
  watermarkAfterCompact,
} from './session/surface.js';
import * as threadRegistry from './thread/registry.js';
import { zonedDayKey } from './time.js';

export const name = 'dsh-companion';

/** 默认/主会话作用域。 */
const SCOPE = MAIN_SCOPE;

/** 召回预算（R-SES-07：注入 ≤2050 tokens；总量由 config.workingMemoryTokens 控制）。 */
const RECALL_BUDGET_TOKENS = 2050;

/** 转录快照：只保留最近 N 条 / N 字符，供巩固模型使用。 */
const TRANSCRIPT_MAX_MESSAGES = 40;
const TRANSCRIPT_MAX_CHARS = 6000;

/** 备份保留份数（t23 L2：按日期滚动）。 */
const BACKUP_KEEP = 7;

/** H5 确认词：本轮 user 文本带这些词且上一轮 assistant 复述过 fact → α=4。 */
const CONFIRMATION_WORDS = Object.freeze(['对', '是的', '没错', '记住了', '确实', '就是']);

const DAY_MS = 86_400_000;

/**
 * 平台命令名必须是小写 ASCII（`/^[a-z][a-z0-9_-]*$/`），
 * 因此中文 `/记忆` 只能通过 ASCII 命令 + 前缀映射落到 handleCommand。
 */
const COMMAND_ALIASES = Object.freeze([
  Object.freeze({
    name: 'memory',
    definitionId: 'dsh-companion/command-memory',
    description: '查看或管理长期记忆（对应 /记忆）',
    prefix: '/记忆',
  }),
  Object.freeze({
    name: 'cost',
    definitionId: 'dsh-companion/command-cost',
    description: '查看今日/本月 token 成本（对应 /成本）',
    prefix: '/成本',
  }),
  Object.freeze({
    name: 'threads',
    definitionId: 'dsh-companion/command-threads',
    description: '列出线程目录（对应 /线程）',
    prefix: '/线程',
  }),
  Object.freeze({
    name: 'status',
    definitionId: 'dsh-companion/command-status',
    description: '查看记忆库与调度状态（对应 /状态）',
    prefix: '/状态',
  }),
]);

/** 每个 ctx 一份安装记录：二次 apply 短路，dispose 释放。 */
const INSTALLS = new WeakMap();

/**
 * 插件入口。
 * @param {object} ctx 平台上下文
 * @param {Record<string, unknown>} [rawConfig] 用户原始配置
 * @returns {{dispose: () => void}|undefined}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const host = ctx !== null && typeof ctx === 'object' ? ctx : null;
  host?.logger?.info?.('[dsh-companion] config ok', { warnings: config.warnings });
  if (host === null) return undefined;

  const installed = INSTALLS.get(host);
  if (installed) {
    host.logger?.debug?.('[dsh-companion] already installed on this context; reusing handle');
    return installed.handle;
  }

  const platform = createAdapter(host, { now: () => host.now?.() ?? Date.now() });
  const store = Store.open(config.dbPath);
  const metrics = createMetrics({ clock: platform.now });
  const state = createWiringState({ host, platform, store, config, metrics });

  const disposers = [];
  const track = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer);
  };

  try {
    // 重启/重载发布时机（四时机之一）。
    const restarted = publishBoard(store, SCOPE, 'restart');
    if (restarted !== null) {
      platform.log('info', '[dsh-companion] state board published on restart', { revision: restarted });
    }
    state.pendingCompact = recoverPendingCompact(store, SCOPE);
    state.watermarkSeq = Number(store.getWatermark(SCOPE)) || 0;
    state.watermarkByScope.set(SCOPE, state.watermarkSeq);
    // H1：surface 索引。优先用 session/event 增量维护；宿主没有该事件时靠
    // readSurface 冷启动回填（每次 O(整段 log)，只在缺失时触发）。
    state.surface = createSurfaceIndex({ platform, tailTokens: state.config.retainTokens });
    if (platform.capabilities.sessionEvent) {
      track(platform.onSessionEvent((session, event) => {
        state.surface.record(session, event);
      }));
    } else {
      platform.log('debug', '[dsh-companion] session/event unavailable; surface index rebuilds on demand');
    }
    publishOnThreadUnarchive(platform, store);

    registerSections(platform, store, track);
    if (platform.capabilities.preStep) {
      track(platform.onPreStep((payload) => runPreStep(state, payload)));
    }
    registerCommands(platform, store, config, metrics, track, () => state.currentScope);
    registerTools(platform, store, config, track, () => state.currentScope);
    track(startScheduler(state));
  } catch (error) {
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        disposer();
      } catch {
        // 卸载失败不应遮蔽原始装载错误。
      }
    }
    try {
      store.close();
    } catch {
      // Store 可能尚未成功打开。
    }
    throw error;
  }

  let disposed = false;
  const handle = Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposer of disposers.splice(0).reverse()) {
        try {
          disposer();
        } catch {
          // 单个 disposer 失败不影响其余资源释放。
        }
      }
      try {
        state.scheduler?.stop?.();
      } catch {
        // scheduler 可能尚未启动。
      }
      try {
        store.close();
      } catch {
        // 已关闭时幂等。
      }
      INSTALLS.delete(host);
      host.logger?.info?.('[dsh-companion] disposed');
    },
  });

  INSTALLS.set(host, { handle, store });
  return handle;
}

/**
 * @param {object} input
 * @returns {object}
 */
function createWiringState({ host, platform, store, config, metrics }) {
  return {
    host,
    platform,
    store,
    config,
    metrics,
    scheduler: null,
    proactive: null,
    /** 上一轮 turn 标识（platform payload.turn）；按 scope 分开，避免线程共用 turn 号。 */
    lastTurn: null,
    /** H3：每个 scope 的上一轮 turn 标识。 */
    lastTurnByScope: new Map(),
    /** H1：surface seq 索引（session/event 增量 + readSurface 冷启动回填）。 */
    surface: null,
    /** 最近一次 pre-step 的 surface 快照（timer/审计复用）。 */
    surfaceSnapshot: null,
    /** H3：每个 scope 最近一次 surface 快照；deep-sleep 用 main 的。 */
    surfaceSnapshotByScope: new Map(),
    /** 巩固水位：最近一次成功巩固的 surface seq；0 = 尚未巩固任何节点。 */
    watermarkSeq: 0,
    /** H3：每个 scope 各自的水位（切换 main/thread 时恢复）。 */
    watermarkByScope: new Map(),
    /** H3：当前 pre-step 路由到的记忆作用域；null=subagent。 */
    currentScope: SCOPE,
    /** H3：最近一次身份路由结果（诊断用）。 */
    currentSession: null,
    /** 已注入召回的 turn 集合（同一 scope 的同一 turn 只注入一次）。 */
    turnSeen: new Set(),
    /** 本轮注入的 fact id（H5：下一轮判断是否被用上）。 */
    lastRecalledIds: [],
    /** H5：注入 fact 所属的 scope；跨 scope 的下一轮不误强化。 */
    lastRecallScope: SCOPE,
    /** 注入时转录里最近一条 assistant 文本 / assistant 条数，用于判断是否出现新回复。 */
    lastRecallAssistant: '',
    assistantCountAtRecall: 0,
    /** 最近一段转录（用于巩固模型草稿）；当前激活 scope 的视图。 */
    transcript: [],
    /** H3：每个 scope 各自的转录，切换会话时恢复，避免跨会话串味。 */
    transcriptByScope: new Map(),
    transcriptScope: SCOPE,
    lastHumanAt: null,
    tokens: 0,
    overCount: 0,
    pendingCompact: null,
    llmResolved: false,
    llm: null,
    llmRoute: null,
    warnedNoLlm: false,
  };
}

// ----------------------------------------------------------- 人格段 / 命令

/**
 * 注册人格三段与状态板段。
 * @param {object} platform
 * @param {Store} store
 * @param {(disposer: Function) => void} track
 */
function registerSections(platform, store, track) {
  if (!platform.capabilities.systemPrompt) return;
  for (const section of buildSections(DEFAULT_CARD)) {
    track(platform.section(section));
  }
  track(platform.section({
    name: 'persona:state_board',
    order: 160,
    text: () => {
      const published = store.getBoard(SCOPE);
      return published === null || published === undefined ? '' : boardSection(published).text;
    },
  }));
}

/**
 * 第三个状态板发布时机：线程恢复（unarchive）。
 * 工具层只会调用 platform.unarchiveSession，因此在这里包一层，成功后发布。
 * @param {object} platform
 * @param {Store} store
 */
function publishOnThreadUnarchive(platform, store) {
  const original = platform.unarchiveSession;
  if (typeof original !== 'function') return;
  platform.unarchiveSession = async (sessionId, ...rest) => {
    const result = await original(sessionId, ...rest);
    try {
      const thread = store.getThreadBySessionId(sessionId);
      const scope = thread === null || thread === undefined ? SCOPE : threadScope(thread.key);
      publishBoard(store, scope, 'thread-unarchive');
    } catch (error) {
      platform.log('warn', '[dsh-companion] publish on thread unarchive failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  };
}

/**
 * 注册 4 个 ASCII 命令；handler 统一转给 handleCommand。
 * @param {object} platform
 * @param {Store} store
 * @param {Readonly<Record<string, unknown>>} config
 * @param {object} metrics
 * @param {(disposer: Function) => void} track
 * @param {() => (string|null)} [currentScope]
 */
function registerCommands(platform, store, config, metrics, track, currentScope) {
  if (!platform.capabilities.commands) return;
  for (const alias of COMMAND_ALIASES) {
    track(platform.registerCommand({
      definitionId: alias.definitionId,
      name: alias.name,
      description: alias.description,
      handler: (invocation) => {
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
        let result;
        try {
          result = handleCommand({
            text: `${alias.prefix}${rawInput}`,
            store,
            now: platform.now(),
            scope: currentScope?.() ?? SCOPE,
            metrics,
            timeZone: config.timezone,
          });
        } catch (error) {
          return {
            kind: 'error',
            text: `命令失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (!result.handled) {
          return { kind: 'error', text: `未识别的命令参数；用法：${alias.prefix} [参数]` };
        }
        return { kind: 'success', text: result.reply };
      },
    }));
  }
}

/**
 * 注册 8 个模型工具。工具的 parameters 已是 JSON Schema，直接按平台裸注册
 * 契约补齐 output（宽 schema + 文本 render），不做 defineTool 依赖。
 * @param {object} platform
 * @param {Store} store
 * @param {Readonly<Record<string, unknown>>} config
 * @param {(disposer: Function) => void} track
 * @param {() => (string|null)} [currentScope]
 */
function registerTools(platform, store, config, track, currentScope) {
  if (!platform.capabilities.tools) return;
  const tools = createTools({
    store,
    retrieve,
    registry: threadRegistry,
    platform,
    clock: platform.now,
    cwd: typeof platform.cwd === 'function' ? platform.cwd() : undefined,
    timeZone: config.timezone,
    currentScope,
  });
  for (const tool of tools) {
    track(platform.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
      },
      execute: (args) => tool.execute(args ?? {}),
    }));
  }
}

// -------------------------------------------------------------- 主管线

/**
 * H3：把当前 pre-step 的 agent 路由到 main / thread / subagent。
 * 没有 payload.agent 的旧调用按 main 处理，保持既有测试行为。
 * @param {object} state
 * @param {object} payload
 * @returns {{kind:'main'|'thread'|'subagent', scope:string|null, sessionId:string|null}}
 */
function routeSession(state, payload) {
  if (payload?.agent === null || payload?.agent === undefined) {
    state.currentSession = { kind: 'main', scope: SCOPE, sessionId: null, legacy: true };
    state.currentScope = SCOPE;
    return state.currentSession;
  }
  const identity = classifySession(payload.agent, {
    store: state.store,
    logger: (level, message, meta) => state.platform.log(level, message, meta),
  });
  state.currentSession = identity;
  if (identity.kind === 'subagent') {
    state.currentScope = null;
    state.metrics.inc('subagentSkips');
    state.platform.log('debug', '[dsh-companion] subagent session skipped', {
      sessionId: identity.sessionId,
    });
    return identity;
  }
  state.currentScope = identity.scope ?? SCOPE;
  state.platform.log('debug', '[dsh-companion] session routed', {
    kind: identity.kind,
    scope: state.currentScope,
    sessionId: identity.sessionId,
    threadKey: identity.key ?? null,
  });
  return identity;
}

/**
 * 读取/初始化某个 scope 的水位。
 * @param {object} state
 * @param {string} scope
 * @returns {number}
 */
function watermarkOf(state, scope) {
  if (!(state.watermarkByScope instanceof Map)) state.watermarkByScope = new Map();
  if (!state.watermarkByScope.has(scope)) {
    state.watermarkByScope.set(scope, Number(state.store.getWatermark(scope)) || 0);
  }
  return Number(state.watermarkByScope.get(scope)) || 0;
}

/**
 * 写入某个 scope 的水位，并同步当前作用域的快捷字段。
 * @param {object} state
 * @param {string} scope
 * @param {number} seq
 */
function setWatermark(state, scope, seq) {
  if (!(state.watermarkByScope instanceof Map)) state.watermarkByScope = new Map();
  state.watermarkByScope.set(scope, seq);
  if (state.currentScope === scope) state.watermarkSeq = seq;
}

/**
 * agent/pre-step 主处理：度量 → 巩固/压缩 → 召回注入（每 turn 一次）。
 * @param {object} state
 * @param {object} payload {agent, messages, turn, step, signal}
 * @returns {Promise<object|null>}
 */
async function runPreStep(state, payload) {
  const { platform, config } = state;
  const identity = routeSession(state, payload);
  if (identity.kind === 'subagent') return null;
  const scope = identity.scope ?? SCOPE;
  state.currentScope = scope;
  state.watermarkSeq = watermarkOf(state, scope);

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const turnKey = turnKeyOf(payload);
  // turn 号只保证同一会话内唯一；多个 main 会话共用 main scope 时不能互相抑制。
  const turnScope = sessionIdOf(payload) ?? scope;
  const lastTurn = state.lastTurnByScope.get(turnScope) ?? null;
  const isNewTurn = turnKey !== null && turnKey !== lastTurn;
  if (isNewTurn) state.lastTurnByScope.set(turnScope, turnKey);
  state.lastTurn = turnKey;

  activateScopeTranscript(state, scope);
  captureTranscript(state, messages);
  state.transcriptByScope.set(scope, state.transcript);
  // H5：先根据「上一轮 assistant 是否复述了上轮注入的 fact」做强化，
  // 再处理本轮注入（注入会覆盖 lastRecalledIds）。
  reinforceOnUse(state, messages, isNewTurn, scope);
  const human = lastUserText(messages);
  if (human !== '') state.lastHumanAt = platform.now();

  const usage = measureTokens(state, payload);
  if (usage !== null) {
    state.tokens = usage.tokensIn;
    state.overCount = usage.tokensIn >= config.compactAtTokens ? state.overCount + 1 : 0;
    state.metrics.observe('tokensIn', usage.tokensIn);
    state.metrics.observe('tokensOut', usage.tokensOut);
    if (isNewTurn) recordTokenEvent(state, usage);
  }

  // H1：每步刷新 surface 快照（seq 列表 + 对齐的 token/文本索引）。
  await refreshSurface(state, payload, usage?.nodes ?? null);

  if (isNewTurn) {
    // 先补上一轮写库后未完成的两段式压缩（平台只允许 turn 内压缩）。
    await maybeCompact(state, payload, scope);
    await maybeConsolidate(state, payload, scope);
  }

  return injectRecall(state, payload, messages, turnKey, scope);
}

/**
 * 刷新当前会话的 surface 快照（无 session 时为 null，插件继续工作）。
 * @param {object} state
 * @param {object} payload
 * @param {object[]|null} [measuredNodes] 已从 tokenMeter 拿到的节点，免二次测量
 * @param {{forceRebuild?: boolean}} [options]
 * @returns {Promise<object|null>}
 */
async function refreshSurface(state, payload, measuredNodes = null, options = {}) {
  const session = payload?.agent?.session ?? null;
  if (session === null || typeof session !== 'object' || state.surface === null) return null;
  try {
    const snapshot = await state.surface.snapshot(session, {
      measured: measuredNodes,
      forceRebuild: options.forceRebuild === true,
    });
    state.surfaceSnapshot = snapshot;
    if (typeof state.currentScope === 'string' && state.currentScope !== '') {
      state.surfaceSnapshotByScope.set(state.currentScope, snapshot);
    }
    return snapshot;
  } catch (error) {
    state.platform.log('debug', '[dsh-companion] surface snapshot failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * H5「被用上才强化」：检查上一轮注入的 fact 是否被最近一条 assistant 文本
 * 复述（二元组重合 ≥0.6），是则按 α 强化并写 REINFORCE 审计。
 *
 * 判定细节（卡片 t3）：
 * - 只认「注入之后出现的新 assistant」：注入时记录最近 assistant 文本/条数，
 *   同一 turn 的后续 step 若还没有新回复，则保留 pending 到下一次 pre-step；
 *   进入新 turn 仍无新回复（历史缺失）则放弃，避免陈旧注入误强化。
 * - 本轮 user 文本含确认词（对/是的/没错/记住了/确实/就是）且复述成立 → α=4，
 *   否则 α=2。
 * - 每条 fact 每批注入只强化一次；pinned/已删/非 active 跳过；失败只 warn。
 *
 * @param {object} state
 * @param {unknown[]} messages
 * @param {boolean} isNewTurn
 * @param {string} [scope] 当前会话 scope
 */
function reinforceOnUse(state, messages, isNewTurn, scope = SCOPE) {
  const ids = Array.isArray(state.lastRecalledIds) ? state.lastRecalledIds : [];
  if (ids.length === 0) return;

  const recallScope = state.lastRecallScope ?? SCOPE;
  if (recallScope !== scope) {
    // 上轮注入属于另一个会话作用域：不跨 scope 强化；换轮时丢弃。
    if (isNewTurn) {
      state.lastRecalledIds = [];
      state.lastRecallScope = scope;
    }
    return;
  }

  const assistantText = lastAssistantText(state.transcript);
  const assistantCount = countAssistantRows(state.transcript);
  const hasNewReply = assistantText !== ''
    && (assistantText !== state.lastRecallAssistant
      || assistantCount > state.assistantCountAtRecall);
  if (!hasNewReply) {
    if (isNewTurn) {
      state.lastRecalledIds = [];
      state.lastRecallScope = scope;
    }
    return;
  }

  state.lastRecalledIds = [];
  const userText = lastUserText(messages);
  const confirmed = CONFIRMATION_WORDS.some((word) => userText.includes(word));
  const alpha = confirmed ? CONFIRM_ALPHA : DEFAULT_ALPHA;
  const at = Math.floor(state.platform.now() / 1000);

  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const fact = state.store.getFact(id);
      if (!fact) continue;
      if (fact.deleted_at !== null && fact.deleted_at !== undefined) continue;
      if (fact.salience === 'pinned') continue;
      if (fact.status !== 'active') continue;
      if (overlapRatio(fact.statement, assistantText) < USE_OVERLAP_THRESHOLD) continue;

      const result = applyReinforcement(state.store, { scope: recallScope, factId: id, at, alpha });
      if (!result?.ok) {
        state.platform.log('warn', '[dsh-companion] reinforcement skipped', {
          id,
          reason: result?.reason ?? 'unknown',
        });
        continue;
      }
      state.metrics.inc('reinforcements');
      state.platform.log('debug', '[dsh-companion] reinforced recalled fact', {
        id,
        alpha,
        strengthDays: result.strengthDays,
        recallCount: result.recallCount,
      });
    } catch (error) {
      // 强化失败不阻断本轮 turn。
      state.platform.log('warn', '[dsh-companion] reinforcement failed', {
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** @param {object} state @param {object} payload @returns {object|null} */
function measureTokens(state, payload) {
  const { platform } = state;
  if (!platform.capabilities.tokenMeter) return null;
  const session = payload?.agent?.session ?? payload?.agent;
  if (session === null || typeof session !== 'object') return null;
  try {
    const measured = platform.measure(session);
    return {
      tokensIn: Number(measured?.totalTokens) || 0,
      tokensOut: Number(measured?.surfaceDeltaTokens) || 0,
      nodes: Array.isArray(measured?.nodes) ? measured.nodes : null,
      session,
    };
  } catch (error) {
    platform.log('debug', '[dsh-companion] tokenMeter.measure failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 每轮写一条 token 审计事件，供 /成本 与 /状态 统计（L6）。
 * @param {object} state
 * @param {{tokensIn: number, tokensOut: number}} usage
 */
function recordTokenEvent(state, usage) {
  try {
    state.store.appendEvent({
      at: Math.floor(state.platform.now() / 1000),
      action: 'USED',
      table_name: 'tokens',
      actor: 'consolidator',
      reason: 'turn_metrics',
      detail_json: { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut },
    });
  } catch (error) {
    state.platform.log('debug', '[dsh-companion] token event failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 巩固阶段：水位判断 → 模型草稿 → 单事务写库，成功才登记 pending_compact。
 * @param {object} state
 * @param {object} payload
 * @param {string} [scope] 当前会话作用域
 */
async function maybeConsolidate(state, payload, scope = SCOPE) {
  const { store, platform, metrics, config } = state;
  const plan = planConsolidation({
    tokens: state.tokens,
    lastHumanAt: state.lastHumanAt,
    now: platform.now(),
    overCount: state.overCount,
    hardTokens: config.compactHardTokens,
    atTokens: config.compactAtTokens,
    idleMs: config.idleMs,
  });
  if (!plan.trigger) return;
  if (state.transcript.length === 0) return;

  // H1：窗口按 surface seq 算 —— 水位之后的节点，减去尾部 6,144 tokens 保留区。
  const snapshot = await refreshSurface(state, payload);
  if (snapshot === null) return;
  const { region, reason } = planRegion(snapshot, {
    afterSeq: state.watermarkSeq,
    budgetTokens: state.config.retainTokens,
  });
  if (region === null) {
    platform.log('debug', '[dsh-companion] consolidation window empty', {
      reason,
      watermark: state.watermarkSeq,
      nodes: snapshot.seqs.length,
    });
    return;
  }
  if (region.missing > 0) {
    platform.log('debug', '[dsh-companion] consolidation skipped: surface text incomplete', {
      missing: region.missing,
      count: region.count,
    });
    return;
  }

  const llm = await resolveConsolidationLlm(state);
  if (typeof llm !== 'function') {
    if (!state.warnedNoLlm) {
      state.warnedNoLlm = true;
      platform.log('debug', '[dsh-companion] consolidation model unavailable; skipping consolidation');
    }
    return;
  }

  const at = Math.floor(platform.now() / 1000);
  try {
    const result = await consolidate({
      store,
      scope,
      seqFrom: region.startSeq,
      seqTo: region.endSeq,
      llm,
      now: at,
      trigger: plan.trigger,
      sessionId: sessionIdOf(payload) ?? scope,
      // 窗口已在 surface 层选好；水位推进允许跨过旧值。
      guardWatermark: false,
    });
    if (result?.skipped) return;

    const consolidation = findConsolidation(store, scope, Number(result.upto_seq));
    state.pendingCompact = {
      id: consolidation?.id ?? null,
      startSeq: region.startSeq,
      endSeq: region.endSeq,
      scope,
    };
    setWatermark(state, scope, region.endSeq);
    metrics.inc('consolidations');
    platform.log('info', '[dsh-companion] consolidation written', {
      upto_seq: result.upto_seq,
      facts: result.facts ?? 0,
      trigger: plan.trigger,
    });
  } catch (error) {
    metrics.inc('consolidationFailures');
    platform.log('warn', '[dsh-companion] consolidation failed', {
      trigger: plan.trigger,
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      store.appendEvent({
        at,
        action: 'UPDATE',
        table_name: 'consolidations',
        actor: 'consolidator',
        reason: 'consolidation_failed',
        detail_json: {
          trigger: plan.trigger,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // 审计失败不覆盖原始错误。
    }
  }
}

/**
 * 两段式压缩：只在 open turn 内调用；终点 ≤ 巩固水位，成功后发布状态板。
 * @param {object} state
 * @param {object} payload
 * @param {string} [scope] 当前会话作用域
 */
async function maybeCompact(state, payload, scope = SCOPE) {
  const { platform, store } = state;
  if (state.pendingCompact === null) return;
  if (!platform.capabilities.compaction) {
    platform.log('debug', '[dsh-companion] compaction unavailable; keeping pending_compact');
    return;
  }

  const pending = state.pendingCompact;
  if (pending.scope !== undefined && pending.scope !== scope) {
    // 另一个作用域登记的待压缩区间：留给对应会话的 turn 头处理。
    return;
  }
  const snapshot = await refreshSurface(state, payload);
  if (snapshot === null) return;
  const seqs = snapshot.seqs;
  const startIdx = seqs.indexOf(pending.startSeq);
  const endIdx = seqs.indexOf(pending.endSeq);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    // 区间已不在当前 surface（被别的压缩替换 / 会话切换）：丢弃，不重试旧 seq。
    platform.log('warn', '[dsh-companion] pending compaction region expired; dropping', {
      startSeq: pending.startSeq,
      endSeq: pending.endSeq,
      nodes: seqs.length,
    });
    state.pendingCompact = null;
    state.metrics.inc('compactionDrops');
    return;
  }

  const start = seqs[startIdx];
  const end = seqs[endIdx];
  try {
    await platform.compactRegion(start, end, payload?.agent);
    if (pending.id) {
      store.markConsolidated(pending.id, { status: 'compacted' });
    }
    state.metrics.inc('compactions');

    // 压缩把区间替换成追加在日志末尾的节点（seq 最大），旧水位在新空间失效：
    // 重读 surface，水位记为「替换节点 / 位置水位」并在库内重写，保证自洽。
    const next = await refreshSurface(state, payload, null, { forceRebuild: true });
    const watermark = watermarkAfterCompact({
      newSeqs: next?.seqs ?? surfaceSeqs(payload?.agent?.session),
      oldSeqs: seqs,
      startIdx,
    });
    setWatermark(state, scope, watermark);
    if (pending.id) store.retargetConsolidation(pending.id, { uptoSeq: watermark });
    state.pendingCompact = null;
    const revision = publishBoard(store, scope, 'compact');
    platform.log('info', '[dsh-companion] compacted and published state board', {
      start,
      end,
      watermark,
      revision,
    });
  } catch (error) {
    state.metrics.inc('compactionFailures');
    platform.log('warn', '[dsh-companion] compactRegion failed; keeping pending_compact', {
      start,
      end,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 召回注入：经 assemble 做预算裁切，同一 turn 只注入一次；末条是工具结果时跳过。
 * @param {object} state
 * @param {object} payload
 * @param {unknown[]} messages
 * @param {string|null} turnKey
 * @param {string} [scope] 当前会话作用域
 * @returns {Promise<object|null>}
 */
async function injectRecall(state, payload, messages, turnKey, scope = SCOPE) {
  const { store, platform, metrics, config } = state;
  const key = `${sessionIdOf(payload) ?? scope}:${turnKey ?? `step:${String(payload?.step ?? 'unknown')}`}`;
  if (state.turnSeen.has(key)) return null;
  if (isToolTail(messages)) {
    state.turnSeen.add(key);
    return null;
  }
  const query = lastUserText(messages).slice(0, 200);
  if (query === '') return null;

  let recalled;
  try {
    recalled = await retrieve({
      store,
      query,
      scope,
      now: platform.now(),
      budgetTokens: RECALL_BUDGET_TOKENS,
    });
  } catch (error) {
    platform.log('warn', '[dsh-companion] recall injection failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    state.turnSeen.add(key);
    return null;
  }
  if (!Array.isArray(recalled?.items) || recalled.items.length === 0) {
    state.turnSeen.add(key);
    return null;
  }

  const assembled = assemble({
    sections: [],
    boardText: '',
    recallItems: recalled.items,
    history: [],
    userInput: query,
    limits: {
      workingMemoryTokens: config.workingMemoryTokens,
      retainTokens: config.retainTokens,
      boardTokens: 0,
      recallTokens: RECALL_BUDGET_TOKENS,
      summaryTokens: 0,
    },
  });
  if (assembled?.dropped?.recall > 0 || (assembled?.tokens?.recall ?? 0) > RECALL_BUDGET_TOKENS) {
    metrics.inc('overBudget');
  }
  metrics.inc('recalls', recalled.items.length);
  state.turnSeen.add(key);

  const injection = extractRecallBlock(assembled?.messages);
  if (injection === '') return null;
  recordRecalledFacts(state, recalled, assembled, scope);
  return { inject: [{ type: 'text', text: injection }] };
}

/**
 * 记录本轮真正进入注入块的 fact id（预算裁切丢掉的召回不算），
 * 以及注入时刻的 assistant 快照，供下一轮「用上」判定。
 * @param {object} state
 * @param {{items: object[]}} recalled
 * @param {object} assembled
 * @param {string} [scope] 本轮注入所属的会话作用域
 */
function recordRecalledFacts(state, recalled, assembled, scope = SCOPE) {
  const dropped = Array.isArray(assembled?.dropped?.recall) ? assembled.dropped.recall : [];
  const droppedIds = new Set(
    dropped
      .map((item) => (item !== null && typeof item === 'object' ? item.id : null))
      .filter((id) => typeof id === 'string'),
  );
  const ids = [];
  for (const item of recalled.items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.kind !== 'fact' || typeof item.id !== 'string') continue;
    if (droppedIds.has(item.id)) continue;
    if (!ids.includes(item.id)) ids.push(item.id);
  }
  state.lastRecalledIds = ids;
  state.lastRecallScope = scope;
  state.lastRecallAssistant = lastAssistantText(state.transcript);
  state.assistantCountAtRecall = countAssistantRows(state.transcript);
}

/**
 * 提取 assemble 渲染出的 `[相关记忆]` 块（含标题）。
 * @param {unknown[]} messages
 * @returns {string}
 */
function extractRecallBlock(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const marker = block.text.indexOf('[相关记忆]');
      if (marker >= 0) return block.text.slice(marker).trim();
    }
  }
  return '';
}

// ---------------------------------------------------------- 巩固模型接入

/**
 * 解析巩固模型：优先宿主注入（`ctx.companion.consolidationLlm`），
 * 其次走平台唯一模型路径 `ctx.llm.stream`（自动选第一条 provider/model）。
 * @param {object} state
 * @returns {Promise<Function|null>}
 */
async function resolveConsolidationLlm(state) {
  if (state.llmResolved) return state.llm;
  state.llmResolved = true;

  const hook = state.host?.companion?.consolidationLlm;
  if (typeof hook === 'function') {
    state.llm = async ({ scope, seqFrom, seqTo }) => hook({
      scope,
      seqFrom,
      seqTo,
      transcript: state.transcript,
    });
    return state.llm;
  }

  if (!state.platform.capabilities.llm) return null;
  try {
    const providers = state.platform.listProviders();
    const provider = Array.isArray(providers) ? providers.find((row) => row?.id) : null;
    if (!provider) return null;
    const models = await state.platform.listModels(provider.id);
    const model = Array.isArray(models) ? models.find((row) => row?.id) : null;
    if (!model) return null;
    state.llmRoute = { provider: provider.id, model: model.id };
  } catch (error) {
    state.platform.log('debug', '[dsh-companion] llm route resolution failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  state.llm = async ({ scope, seqFrom, seqTo }) => {
    const prompt = buildConsolidationPrompt(state, { scope, seqFrom, seqTo });
    const text = await state.platform.complete({
      provider: state.llmRoute.provider,
      model: state.llmRoute.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    return parseDraftJson(text);
  };
  return state.llm;
}

/**
 * 巩固提示词：把转录转成草稿 JSON。只保留文本，不含工具参数。
 * @param {object} state
 * @param {{scope: string, seqFrom: number, seqTo: number}} segment
 * @returns {string}
 */
function buildConsolidationPrompt(state, segment) {
  const lines = state.transcript.map((row) => `${row.role}: ${row.text}`);
  return [
    '你是私人管家的记忆巩固器。把下面这段对话压缩成一条情景记忆与若干长期事实。',
    '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。格式：',
    '{"episode":{"title":"...","summary":"..."},',
    ' "facts":[{"kind":"identity|relation|preference|project|knowledge|other",',
    '           "subject_text":"...","predicate":"...","object_text":"...","statement":"..."}],',
    ' "reminders":[{"kind":"todo","title":"..."}]}',
    `scope=${segment.scope} seq=${segment.seqFrom}-${segment.seqTo}`,
    '对话：',
    lines.join('\n'),
  ].join('\n');
}

/**
 * 解析模型返回的草稿 JSON；容忍 ```json 代码块包裹。
 * @param {string} text
 * @returns {object}
 */
function parseDraftJson(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/u.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('consolidation draft is not a JSON object');
  }
  return JSON.parse(body.slice(start, end + 1));
}

// -------------------------------------------------------------- 深睡任务

/**
 * deep-sleep（03:00）MVP 子步（06 §4.3 的最小实现，已在代码与 CHANGELOG 注明）：
 * 1) 巩固：睡眠窗口内若还有未巩固的转录且模型可用，按 deep-sleep 触发写库；
 *    成功则登记 pending_compact，交给下一次 open turn 压缩；
 * 2) 遗忘降级：active 且非 pinned 的事实，超过 strength_days 未强化 → dormant；
 * 3) GC：清理 FTS 孤儿行（仅崩溃残留，正常 purge 会成对删除）；
 * 4) 状态板重渲染：把结果写进 staged（发布仍只在四个时机）；
 * 5) 审计：写一条 kind=deep 的 consolidations 与 memory_events（不改水位）。
 * 情景→语义的模型抽取需要更强的巩固模型，留给后续版本（MVP 只做规则子步）。
 * @param {object} state
 * @returns {Promise<{consolidated: object, dormant: number, gc: number}>}
 */
async function runDeepSleep(state) {
  const { store, platform, config } = state;
  // deep-sleep 是主会话的维护任务：使用 main 的转录视图，避免把线程会话串进来。
  activateScopeTranscript(state, SCOPE);
  const now = platform.now();
  const consolidated = await deepConsolidate(state);
  const dormant = decayFacts(state, now);
  const gc = gcFtsOrphans(state);
  const board = renderBoard({
    recent: store.listEpisodes({ scope: SCOPE, limit: 6 }),
    facts: store.listFacts({ scope: SCOPE, status: 'active', limit: 10 }),
    threads: store.listThreads({ status: 'active', limit: 10 }),
    reminders: store.listReminders({ scope: SCOPE, limit: 12 }),
  });
  stageBoard(store, SCOPE, board);

  const at = Math.floor(now / 1000);
  const day = zonedDayKey(now, config.timezone);
  try {
    store.insertConsolidation({
      scope: SCOPE,
      session_id: `deep:${day}`,
      // consolidations.kind 的 CHECK 只允许 nap/deep/forget_flush；
      // 日粒度记在 session_id 与审计 detail 里。
      kind: 'deep',
      trigger: 'deep-sleep',
      upto_seq: watermarkOf(state, SCOPE),
      status: 'written',
      started_at: at,
      finished_at: at,
    });
  } catch (error) {
    if (!/UNIQUE/iu.test(String(error?.message ?? error))) {
      platform.log('warn', '[dsh-companion] deep-sleep consolidation row failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  store.appendEvent({
    at,
    action: 'UPDATE',
    table_name: 'facts',
    actor: 'consolidator',
    reason: 'deep-sleep',
    detail_json: { day, dormant, gc, consolidated, board: 'staged' },
  });
  platform.log('info', '[dsh-companion] deep-sleep done', { dormant, gc, consolidated });
  return { consolidated, dormant, gc };
}

/**
 * 睡眠期巩固：只处理已产生但未巩固的转录；无模型时安静跳过。
 * @param {object} state
 * @returns {Promise<object>}
 */
async function deepConsolidate(state) {
  const { store, platform } = state;
  if (state.transcript.length === 0) return { written: false, reason: 'nothing-to-consolidate' };
  // 定时器没有 payload：用 main 最近一次 pre-step 的快照（无快照说明没跑过 agent）。
  const snapshot = state.surfaceSnapshotByScope.get(SCOPE)
    ?? (state.currentScope === SCOPE ? state.surfaceSnapshot : null);
  if (snapshot === null || snapshot.seqs.length === 0) {
    return { written: false, reason: 'no-surface' };
  }
  const { region, reason } = planRegion(snapshot, {
    afterSeq: watermarkOf(state, SCOPE),
    budgetTokens: state.config.retainTokens,
  });
  if (region === null) return { written: false, reason };
  if (region.missing > 0) return { written: false, reason: 'text-incomplete' };
  const llm = await resolveConsolidationLlm(state);
  if (typeof llm !== 'function') return { written: false, reason: 'no-llm' };
  try {
    const result = await consolidate({
      store,
      scope: SCOPE,
      seqFrom: region.startSeq,
      seqTo: region.endSeq,
      llm,
      now: Math.floor(platform.now() / 1000),
      trigger: 'deep-sleep',
      sessionId: SCOPE,
      guardWatermark: false,
    });
    if (result?.skipped) return { written: false, reason: 'skipped' };
    const row = findConsolidation(store, SCOPE, Number(result.upto_seq));
    state.pendingCompact = {
      id: row?.id ?? null,
      startSeq: region.startSeq,
      endSeq: region.endSeq,
      scope: SCOPE,
    };
    setWatermark(state, SCOPE, region.endSeq);
    state.metrics.inc('consolidations');
    return { written: true, upto_seq: result.upto_seq, facts: result.facts ?? 0 };
  } catch (error) {
    state.metrics.inc('consolidationFailures');
    platform.log('warn', '[dsh-companion] deep-sleep consolidation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { written: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * FTS 孤儿清理：删除主表已不存在、但索引行仍残留的行（崩溃残留）。
 * @param {object} state
 * @returns {number} 清理行数
 */
function gcFtsOrphans(state) {
  const { store, platform } = state;
  let removed = 0;
  for (const [fts, main] of [['fts_facts', 'facts'], ['fts_episodes', 'episodes']]) {
    try {
      const info = store.db
        .prepare(`DELETE FROM ${fts} WHERE rowid NOT IN (SELECT rowid FROM ${main})`)
        .run();
      removed += Number(info.changes) || 0;
    } catch (error) {
      platform.log('debug', '[dsh-companion] fts gc skipped', {
        table: fts,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}

/**
 * 遗忘降级：分页扫描，避免 listFacts 单页截断遗漏。
 * @param {object} state
 * @param {number} nowMs
 * @returns {number} 降级条数
 */
function decayFacts(state, nowMs) {
  const { store, platform } = state;
  const pageSize = 200;
  let dormant = 0;
  for (let offset = 0; ; offset += pageSize) {
    const page = store.listFacts({ scope: SCOPE, status: 'active', limit: pageSize, offset });
    for (const fact of page) {
      if (fact.salience === 'pinned') continue;
      const strengthDays = Number(fact.strength_days);
      if (!Number.isFinite(strengthDays) || strengthDays <= 0) continue;
      const last = toMillis(fact.last_reinforced_at);
      if (last === null) continue;
      if ((nowMs - last) / DAY_MS >= strengthDays) {
        try {
          store.updateFact(fact.id, { status: 'dormant' });
          dormant += 1;
        } catch (error) {
          platform.log('warn', '[dsh-companion] fact decay failed', {
            id: fact.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (page.length < pageSize) break;
  }
  return dormant;
}

// ------------------------------------------------------------ 调度与备份

/**
 * 注册并启动 6 个定时任务；任务体只调用已完成模块。
 * @param {object} state
 * @returns {Function} disposer：停止 scheduler
 */
function startScheduler(state) {
  const { platform, store, config, metrics } = state;
  if (!platform.capabilities.timer) return () => {};

  const proactive = createProactive({
    store,
    platform: {
      prompt: (sessionId, text) => platform.prompt({
        sessionId,
        content: [{ type: 'text', text }],
      }),
    },
    config,
    clock: platform.now,
  });
  state.proactive = proactive;

  const jobs = {
    'idle-probe': async () => {
      await proactive.flush();
    },
    reminders: async () => {
      fireDueReminders(state);
      await proactive.flush();
    },
    'deep-sleep': async () => {
      await runDeepSleep(state);
    },
    's2-purge': () => {
      const result = store.purge({ now: platform.now(), cutoffDays: config.purgeAfterDays });
      platform.log('info', '[dsh-companion] s2-purge done', result);
    },
    backup: () => {
      backupDatabase(state);
    },
    'thread-freeze': async () => {
      await freezeThreads(store, platform, config);
    },
  };

  const scheduler = createScheduler({
    clock: platform.now,
    store,
    jobs,
    timeZone: config.timezone,
    timer: (callback, delay) => platform.every(delay, callback),
    clearTimer: (handle) => {
      if (typeof handle === 'function') handle();
    },
  });
  state.scheduler = scheduler;
  scheduler.start(platform.now());
  platform.log('info', '[dsh-companion] scheduler started', { jobs: JOB_IDS.length, metrics: metrics.snapshot() });
  return () => scheduler.stop();
}

/**
 * 把到点的提醒转成主动消息，并标记为 fired。
 * @param {object} state
 * @returns {number} 本次处理条数
 */
function fireDueReminders(state) {
  const { store, platform, proactive } = state;
  const now = platform.now();
  const seconds = Math.floor(now / 1000);
  const due = store.dueReminders({ now: seconds, limit: 50 });
  if (due.length === 0) return 0;
  const mark = store.db.prepare(
    `UPDATE reminders
        SET status = 'fired', last_fire_key = ?, updated_at = unixepoch()
      WHERE id = ? AND status IN ('pending', 'snoozed')`,
  );
  for (const row of due) {
    mark.run(String(seconds), row.id);
    proactive?.enqueue({
      kind: 'reminder',
      text: `提醒：${row.title}`,
      dedupeKey: `reminder:${row.id}:${seconds}`,
      at: now,
    });
  }
  return due.length;
}

/**
 * 备份 SQLite 主库：checkpoint → 复制为 `<db>.<YYYY-MM-DD>.bak`，
 * 只保留最近 7 份；失败写 scheduler_jobs 审计事件（L2）。
 * @param {object} state
 * @returns {string|null} 备份路径
 */
function backupDatabase(state) {
  const { store, platform } = state;
  if (store.dbPath === ':memory:') return null;
  const now = platform.now();
  const stamp = zonedDayKey(now, state.config.timezone);
  const dir = dirname(store.dbPath);
  const base = basename(store.dbPath);
  const target = join(dir, `${base}.${stamp}.bak`);

  try {
    mkdirSync(dir, { recursive: true });
    try {
      store.db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch {
      // checkpoint 失败不阻断复制；主库仍可能包含大部分已提交数据。
    }
    copyFileSync(store.dbPath, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    platform.log('error', '[dsh-companion] backup failed', { path: target, message });
    try {
      store.appendEvent({
        at: Math.floor(now / 1000),
        action: 'USED',
        table_name: 'scheduler_jobs',
        row_id: 'backup',
        actor: 'scheduler',
        reason: 'backup_failed',
        detail_json: { message, path: target },
      });
    } catch {
      // 审计失败不影响任务继续。
    }
    return null;
  }

  try {
    const prefix = `${base}.`;
    const backups = readdirSync(dir)
      .filter((file) => file.startsWith(prefix) && file.endsWith('.bak'))
      .sort();
    for (const file of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // 单个旧备份删除失败不阻断本次备份。
      }
    }
  } catch (error) {
    platform.log('warn', '[dsh-companion] backup rotation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  platform.log('info', '[dsh-companion] backup done', { path: target });
  return target;
}

/**
 * 冻结空闲线程，并归档对应会话（platform 支持 archiveSession 时）。
 * @param {Store} store
 * @param {object} platform
 * @param {object} config
 */
async function freezeThreads(store, platform, config) {
  const activeBefore = new Set(store.listThreads({ status: 'active', limit: 500 }).map((row) => row.key));
  const frozen = threadRegistry.freezeIdleThreads(store, platform.now(), config.threadIdleDays);
  if (frozen === 0 || !platform.capabilities.archive) return;
  for (const thread of store.listThreads({ status: 'archived', limit: 500 })) {
    if (!activeBefore.has(thread.key)) continue;
    try {
      await platform.archiveSession(thread.session_id, { stopActivity: true });
    } catch (error) {
      platform.log('warn', '[dsh-companion] archive thread session failed', {
        key: thread.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------- 小工具

/**
 * 重启后恢复未完成的两段式压缩（只认 nap：deep 行的 upto_seq 是审计水位）。
 * @param {Store} store
 * @param {string} scope
 * @returns {{id: string, startSeq: number, endSeq: number, scope: string}|null}
 */
function recoverPendingCompact(store, scope) {
  const row = store.db.prepare(
    `SELECT id, upto_seq, turn_from, compaction_start_seq FROM consolidations
      WHERE scope = ? AND status = 'written' AND kind = 'nap'
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
  ).get(scope);
  if (!row) return null;
  const endSeq = Number(row.upto_seq);
  const startSeq = Number(row.compaction_start_seq ?? row.turn_from ?? endSeq);
  return { id: row.id, startSeq, endSeq, scope };
}

/**
 * @param {Store} store
 * @param {string} scope
 * @param {number} uptoSeq
 * @returns {object|null}
 */
function findConsolidation(store, scope, uptoSeq) {
  return store.db.prepare(
    `SELECT * FROM consolidations
      WHERE scope = ? AND upto_seq = ? AND kind = 'nap'
      ORDER BY started_at DESC LIMIT 1`,
  ).get(scope, uptoSeq) ?? null;
}

/**
 * turn 标识：优先 payload.turn；对象取 id，否则 JSON 化。
 * @param {object} payload
 * @returns {string|null}
 */
function turnKeyOf(payload) {
  const turn = payload?.turn;
  if (turn === undefined || turn === null) return null;
  if (typeof turn === 'object') {
    if (turn.id !== undefined && turn.id !== null) return `turn:${String(turn.id)}`;
    try {
      return `turn:${JSON.stringify(turn)}`;
    } catch {
      return null;
    }
  }
  return `turn:${String(turn)}`;
}

/**
 * 把平台 payload.messages 的两种形态（role 消息数组 / 裸内容块数组）统一成文本行。
 * @param {unknown[]} messages
 * @returns {{role: string, text: string}[]}
 */
function textRows(messages) {
  if (!Array.isArray(messages)) return [];
  const rows = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== 'text' || typeof block.text !== 'string') continue;
        rows.push({ role: typeof message.role === 'string' ? message.role : 'user', text: block.text });
      }
      continue;
    }
    if (message.type === 'text' && typeof message.text === 'string') {
      rows.push({ role: typeof message.role === 'string' ? message.role : 'user', text: message.text });
    }
  }
  return rows;
}

/**
 * 取本批最后一条 user 文本（跳过注入块）。
 * @param {unknown[]} messages
 * @returns {string}
 */
function lastUserText(messages) {
  const rows = textRows(messages);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== 'user') continue;
    const text = row.text.trim();
    if (text === '' || text.startsWith('[相关记忆]')) continue;
    return text;
  }
  return '';
}

/**
 * 转录里最近一条非空 assistant 文本。
 * @param {{role: string, text: string}[]} transcript
 * @returns {string}
 */
function lastAssistantText(transcript) {
  if (!Array.isArray(transcript)) return '';
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const row = transcript[index];
    if (row?.role !== 'assistant') continue;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (text !== '') return text;
  }
  return '';
}

/**
 * 转录里 assistant 消息条数（用于判断注入后是否出现了新回复）。
 * @param {{role: string}[]} transcript
 * @returns {number}
 */
function countAssistantRows(transcript) {
  if (!Array.isArray(transcript)) return 0;
  let count = 0;
  for (const row of transcript) {
    if (row?.role === 'assistant') count += 1;
  }
  return count;
}

/**
 * 末条消息是否工具结果（工具调用后不再注入召回）。
 * @param {unknown[]} messages
 * @returns {boolean}
 */
function isToolTail(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== 'object') return false;
  if (last.role === 'tool') return true;
  if (last.type === 'tool-result' || last.type === 'tool-call') return true;
  const blocks = Array.isArray(last.content) ? last.content : [];
  return blocks.some((block) => block?.type === 'tool-result' || block?.type === 'tool-call');
}

/**
 * 切换当前 scope 的转录视图：先把上一个 scope 的转录存回 Map。
 * @param {object} state
 * @param {string} scope
 */
function activateScopeTranscript(state, scope) {
  if (!(state.transcriptByScope instanceof Map)) state.transcriptByScope = new Map();
  if (state.transcriptScope === scope) return;
  state.transcriptByScope.set(state.transcriptScope ?? SCOPE, state.transcript);
  state.transcript = state.transcriptByScope.get(scope) ?? [];
  state.transcriptScope = scope;
}

/**
 * 转录快照：最近 N 条文本消息，截断到 N 字符。
 * @param {object} state
 * @param {unknown[]} messages
 */
function captureTranscript(state, messages) {
  const rows = [];
  for (const row of textRows(messages)) {
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const text = row.text.trim();
    if (text === '' || text.startsWith('[相关记忆]')) continue;
    rows.push({ role: row.role, text });
  }
  const tail = rows.slice(-TRANSCRIPT_MAX_MESSAGES);
  const joined = [];
  let budget = TRANSCRIPT_MAX_CHARS;
  for (let index = tail.length - 1; index >= 0 && budget > 0; index -= 1) {
    const row = tail[index];
    const text = row.text.length > budget ? row.text.slice(row.text.length - budget) : row.text;
    joined.unshift({ role: row.role, text });
    budget -= text.length;
  }
  state.transcript = joined;
}

/** @param {object} payload @returns {string|null} */
function sessionIdOf(payload) {
  const id = payload?.agent?.session?.id ?? payload?.agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 秒/毫秒统一成毫秒。
 * @param {number|Date|null|undefined} value
 * @returns {number|null}
 */
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.abs(num) < 1e11 ? Math.round(num * 1000) : Math.round(num);
}

/**
 * 工具结果的文本渲染；无法序列化时退回 String。
 * @param {unknown} value
 * @returns {string}
 */
function renderToolValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
