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

import { isQuietAt, normalizeConfig } from './config.js';
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
import { buildConsolidationPrompt, consolidate, planConsolidation } from './memory/consolidate.js';
import {
  appendEventWithAction,
  apply as applyGovernance,
  exportMirror,
  isSensitiveText,
  scan as scanGovernance,
} from './memory/govern.js';
import { publishBoard, renderBoard, stageBoard } from './memory/state-board.js';
import { boardSection, buildSections } from './persona/sections.js';
import { DEFAULT_CARD } from './persona/card.js';
import {
  buildChatPrompt,
  chatEligibility,
  normalizeChatText,
} from './persona/chat.js';
import {
  COMMITMENT_FOLLOWUP_REASON,
  commitmentAuditDetail,
  commitmentOverdueDays,
  followUpText,
  scanCommitmentFollowups,
} from './scheduler/commitments.js';
import { createAdapter } from './platform/adapter.js';
import { MAIN_SCOPE, classifySession, threadScope } from './session/identity.js';
import {
  BUDGET_REASONS,
  DAILY_TOKEN_LIMIT,
  checkMemory,
  createBudgetState,
  levelAtLeast,
  overDailyBudget,
  recordTurnUsage,
} from './runtime/budget.js';
import {
  MAX_CONSOLIDATION_RETRIES,
  errorMessage,
  isCredentialError,
  retryDelayMs,
} from './runtime/retry.js';
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
import { zonedDayKey, zonedParts } from './time.js';

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

/** P1-b：闲聊状态持久化键（schema_meta，JSON/字符串都能存活重启）。 */
const CHAT_META = Object.freeze({
  enabled: 'p1b.chat.enabled',
  lastAt: 'p1b.chat.last_at',
  sent: 'p1b.chat.sent',
  lastTryDay: 'p1b.chat.last_try_day',
  interactionDay: 'p1b.interaction.day',
});

/** P1-b：单次提醒 job 最多跟进多少条承诺，避免一次刷屏。 */
const COMMITMENT_MAX_FOLLOWUPS = 20;

/** P1-b：闲聊历史保留 7 天（与每周上限同窗口）。 */
const CHAT_HISTORY_SECONDS = 7 * 86_400;

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
    description: '查看今日/本月 token 成本与每日 3M 熔断状态（对应 /成本）',
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
  Object.freeze({
    name: 'chat-off',
    definitionId: 'dsh-companion/command-chat-off',
    description: '关闭主动闲聊（对应 /别闲聊）',
    prefix: '/别闲聊',
  }),
  Object.freeze({
    name: 'chat-on',
    definitionId: 'dsh-companion/command-chat-on',
    description: '恢复主动闲聊（对应 /恢复闲聊）',
    prefix: '/恢复闲聊',
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
    // M4：turn 结束时结算本轮 token；没有该事件时由下一次 pre-step 的差值兜底。
    if (platform.capabilities.turnStopping && typeof platform.onTurnStopping === 'function') {
      track(platform.onTurnStopping((payload) => {
        const usage = measureTokens(state, payload);
        if (usage !== null) recordUsage(state, usage, sessionIdOf(payload));
      }));
    }
    registerCommands(platform, store, config, metrics, track, () => state.currentScope, () => budgetInfo(state), state);
    registerTools(platform, store, config, track, () => state.currentScope, () => toolBudgetGate(state));
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
      state.disposed = true;
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
    /** M4：每日 token 累计（按配置时区的日键复位）。 */
    budget: createBudgetState(),
    /** M4：每个会话上次测得的 totalTokens；差值即一轮新增用量。 */
    tokenBaselines: new Map(),
    /** M4：当日是否已到 3M 熔断线。 */
    budgetTripped: false,
    /** M4：最近一次 RSS 检查结果；scheduler 启动前为 ok。 */
    rss: { level: 'ok', code: 0, rssBytes: 0, rssMB: 0, totalmemBytes: 0, checkedAt: null },
    /** M4：测试可经宿主注入内存读数；缺省走 process.memoryUsage()。 */
    rssReader: typeof host?.rssReader === 'function' ? host.rssReader : null,
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
    /** M3：待执行的巩固任务（pre-step 只登记，不 await）。 */
    pendingConsolidation: null,
    /** M3：同一时刻只跑一个巩固任务。 */
    consolidationInFlight: false,
    /** M3：已把「跑巩固」排进 setImmediate，避免重复排队。 */
    consolidationScheduled: false,
    /** M3：上一轮巩固结果，下一轮 pre-step 开头检查（只用于日志）。 */
    lastConsolidationResult: null,
    /** t17：失败巩固的重试登记（job + attempts + nextAt）。 */
    consolidationRetry: null,
    /** dispose 后后台任务不再碰已关闭的 Store。 */
    disposed: false,
    llmResolved: false,
    llm: null,
    llmRoute: null,
    warnedNoLlm: false,
    /** P1-b：闲聊模型单独解析/缓存，不复用巩固模型（提示词与输出都不同）。 */
    chatLlmResolved: false,
    chatLlm: null,
    chatLlmRoute: null,
    warnedNoChatLlm: false,
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
 * 注册 6 个 ASCII 命令；handler 统一转给 handleCommand 或 P1-b 闲聊开关。
 * @param {object} platform
 * @param {Store} store
 * @param {Readonly<Record<string, unknown>>} config
 * @param {object} metrics
 * @param {(disposer: Function) => void} track
 * @param {() => (string|null)} [currentScope]
 * @param {() => object|undefined} [budgetInfo] 命令展示用的预算/RSS 快照
 * @param {object} [state] 闲聊开关/最近一次需要读写 state.store 的 schema_meta
 */
function registerCommands(platform, store, config, metrics, track, currentScope, budgetInfo, state) {
  if (!platform.capabilities.commands) return;
  for (const alias of COMMAND_ALIASES) {
    track(platform.registerCommand({
      definitionId: alias.definitionId,
      name: alias.name,
      description: alias.description,
      handler: (invocation) => {
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
        const routedScope = currentScope ? currentScope() : undefined;
        const scope = routedScope === undefined ? SCOPE : routedScope;
        let result;
        try {
          if (alias.name === 'memory') {
            const custom = handleMemoryCommand({
              text: `${alias.prefix}${rawInput}`,
              store,
              now: platform.now(),
              scope,
              timeZone: config.timezone,
            });
            if (custom !== null) return { kind: 'success', text: custom };
          }
          if (alias.name === 'chat-off' || alias.name === 'chat-on') {
            return {
              kind: 'success',
              text: handleChatCommand({
                state,
                mode: alias.name === 'chat-on' ? 'on' : 'off',
                now: platform.now(),
              }),
            };
          }
          result = handleCommand({
            text: `${alias.prefix}${rawInput}`,
            store,
            now: platform.now(),
            scope,
            metrics,
            timeZone: config.timezone,
            budget: typeof budgetInfo === 'function' ? budgetInfo() : undefined,
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
        const text = alias.name === 'status'
          ? `${result.reply}\n${formatChatStatus(state, platform.now())}`
          : result.reply;
        return { kind: 'success', text };
      },
    }));
  }
}

/**
 * 注册 9 个模型工具。工具的 parameters 已是 JSON Schema，直接按平台裸注册
 * 契约补齐 output（宽 schema + 文本 render），不做 defineTool 依赖。
 * @param {object} platform
 * @param {Store} store
 * @param {Readonly<Record<string, unknown>>} config
 * @param {(disposer: Function) => void} track
 * @param {() => (string|null)} [currentScope]
 * @param {() => object|undefined} [budgetGate] M4：task_run/thread_run 的预算/内存闸门
 */
function registerTools(platform, store, config, track, currentScope, budgetGate) {
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
    budgetGate,
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
  track(platform.registerTool({
    name: 'memory_update',
    description: '修改一条已有长期记忆：旧条标记为 superseded，新内容以新 id 继续生效。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修改的记忆 id（fact id）' },
        statement: { type: 'string', description: '修改后的完整陈述' },
      },
      required: ['id', 'statement'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
    },
    execute: (args) => {
      const routedScope = currentScope ? currentScope() : undefined;
      return updateMemoryTool({
        store,
        scope: routedScope === undefined ? SCOPE : routedScope,
        args: args ?? {},
        now: platform.now(),
      });
    },
  }));
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
  if (state.lastConsolidationResult !== null) {
    // M3：上一轮 step 结束后跑的巩固在这里收账；失败只记录，不影响当前轮。
    const previous = state.lastConsolidationResult;
    state.lastConsolidationResult = null;
    platform.log(previous.ok ? 'debug' : 'warn', '[dsh-companion] previous consolidation finished', previous);
  }

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
  if (human !== '') {
    state.lastHumanAt = platform.now();
    recordInteractionDay(state, platform.now());
    // R-PRO-08：用户一句「今天不想聊」也算明确叫停，不必等命令。
    if (human.includes('今天不想聊')) setChatEnabled(state, false);
  }

  const usage = measureTokens(state, payload);
  if (usage !== null) {
    state.tokens = usage.tokensIn;
    state.overCount = usage.tokensIn >= config.compactAtTokens ? state.overCount + 1 : 0;
    state.metrics.observe('tokensIn', usage.tokensIn);
    state.metrics.observe('tokensOut', usage.tokensOut);
    if (isNewTurn) recordTokenEvent(state, usage);
  }
  if (usage !== null) {
    // M4：turn-stopping 可用时这里通常 delta=0（已在 turn 末结算）；
    // 不可用/未触发时，本次差值就是上一轮新增用量。
    recordUsage(state, usage, sessionIdOf(payload) ?? scope);
  }

  // H1：每步刷新 surface 快照（seq 列表 + 对齐的 token/文本索引）。
  await refreshSurface(state, payload, usage?.nodes ?? null);

  if (isNewTurn) {
    // 先补上一轮写库后未完成的两段式压缩（平台只允许 turn 内压缩）。
    await maybeCompact(state, payload, scope);
    // M3：只登记巩固，立即返回；模型调用在 step 之后由后台任务执行。
    scheduleConsolidation(state, payload, scope);
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
 * M4：按 tokenMeter 的 totalTokens 差值累计当日用量。
 *
 * 首次见到某会话只建基线（不把插件装载前的历史算进今天）；之后每次测量
 * 记增量。turn-stopping 与 pre-step 共用基线，因此不会双计。
 * @param {object} state
 * @param {{tokensIn: number}} usage measureTokens 的返回值
 * @param {string|null} sessionId
 * @returns {number} 本次记入的增量
 */
function recordUsage(state, usage, sessionId) {
  if (usage === null || typeof usage !== 'object') return 0;
  const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown';
  const total = Math.max(0, Number(usage.tokensIn) || 0);
  const baselines = state.tokenBaselines;
  let delta = 0;
  if (baselines.has(id)) {
    const previous = baselines.get(id);
    delta = total > previous ? total - previous : 0;
  }
  baselines.set(id, total);
  if (delta > 0) {
    recordTurnUsage(state.budget, delta, {
      at: state.platform.now(),
      timezone: state.config.timezone,
    });
    state.platform.log('debug', '[dsh-companion] daily token usage', {
      sessionId: id,
      delta,
      dailyTokens: state.budget.dailyTokens,
    });
  }
  refreshBudget(state);
  return delta;
}

/**
 * M4：刷新当日熔断状态与 metrics；跨日自动复位并解除熔断。
 * @param {object} state
 * @param {number} [at]
 * @returns {boolean} 是否处于熔断
 */
function refreshBudget(state, at = state.platform.now()) {
  const was = state.budgetTripped === true;
  const tripped = overDailyBudget(state.budget, DAILY_TOKEN_LIMIT, {
    at,
    timezone: state.config.timezone,
  });
  state.budgetTripped = tripped;
  state.metrics.observe('dailyTokens', state.budget.dailyTokens);
  state.metrics.observe('budgetTripped', tripped ? 1 : 0);
  if (tripped && !was) {
    state.platform.log('warn', '[dsh-companion] daily token budget tripped', {
      dailyTokens: state.budget.dailyTokens,
      limit: DAILY_TOKEN_LIMIT,
    });
  } else if (!tripped && was) {
    state.platform.log('info', '[dsh-companion] daily token budget reset', {
      dailyTokens: state.budget.dailyTokens,
      dayKey: state.budget.dailyDayKey,
    });
  }
  return tripped;
}

/**
 * 命令层预算快照（/成本、/状态用）。
 * @param {object} state
 * @returns {object}
 */
function budgetInfo(state) {
  refreshBudget(state);
  return {
    dailyTokens: state.budget.dailyTokens,
    dailyLimit: DAILY_TOKEN_LIMIT,
    tripped: state.budgetTripped,
    rssLevel: state.rss.level,
    rssLevelCode: state.rss.code,
    rssMB: state.rss.rssMB,
  };
}

/**
 * M4：工具层闸门。stop_dispatch 停 task_run；main_only 额外停线程创建。
 * @param {object} state
 * @returns {{allowTask: boolean, allowThread: boolean, taskReason?: string, threadReason?: string}}
 */
function toolBudgetGate(state) {
  refreshBudget(state);
  const memoryBlocked = levelAtLeast(state.rss.level, 'stop_dispatch');
  const mainOnly = levelAtLeast(state.rss.level, 'main_only');
  return {
    allowTask: !state.budgetTripped && !memoryBlocked,
    allowThread: !mainOnly,
    taskReason: state.budgetTripped ? BUDGET_REASONS.daily : BUDGET_REASONS.memory,
    threadReason: BUDGET_REASONS.mainOnly,
  };
}

/**
 * M4：读一次 RSS 并更新档位/metrics。异常安全，绝不让内存保护中断调度。
 * @param {object} state
 * @returns {{level: string, code: number, rssBytes: number, rssMB: number}}
 */
function runRssCheck(state) {
  const previous = state.rss?.level ?? 'ok';
  let result;
  try {
    result = checkMemory(state.rssReader === null ? {} : { rssReader: state.rssReader });
  } catch (error) {
    state.platform.log('debug', '[dsh-companion] rss check failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return state.rss;
  }
  state.rss = {
    level: result.level,
    code: result.code,
    rssBytes: result.rssBytes,
    rssMB: result.rssMB,
    totalmemBytes: result.totalmemBytes,
    checkedAt: state.platform.now(),
  };
  state.metrics.observe('rssLevel', result.code);
  state.metrics.observe('rssUsedMB', result.rssMB);
  if (result.level !== previous) {
    if (levelAtLeast(result.level, 'stop_dispatch')) {
      state.platform.log('warn', '[dsh-companion] rss pressure degraded', {
        level: result.level,
        rssMB: result.rssMB,
      });
    } else if (result.level === 'ok') {
      state.platform.log('info', '[dsh-companion] rss pressure recovered', { rssMB: result.rssMB });
    }
  }
  return state.rss;
}

/**
 * 主动消息是否应暂停：熔断或 RSS ≥ stop_dispatch 时不再 flush/投递提醒。
 * @param {object} state
 * @returns {boolean}
 */
function proactiveBlocked(state) {
  refreshBudget(state);
  return state.budgetTripped === true || levelAtLeast(state.rss.level, 'stop_dispatch');
}

/**
 * 巩固阶段：水位判断 → 模型草稿 → 单事务写库，成功才登记 pending_compact。
 * @param {object} state
 * @param {object} payload
 * @param {string} [scope] 当前会话作用域
 */
/**
 * 巩固阶段（M3）：pre-step 只做同步判断，登记 pendingConsolidation 后立即返回；
 * 真正的模型调用与写库由 setImmediate 排到 step 之后，单飞执行，失败只 warn。
 * @param {object} state
 * @param {object} payload
 * @param {string} [scope] 当前会话作用域
 */
function scheduleConsolidation(state, payload, scope = SCOPE) {
  if (state.disposed) return;
  const { platform, config } = state;
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

  const snapshot = state.surfaceSnapshotByScope.get(scope) ?? state.surfaceSnapshot;
  // N1：登记时就把当前选区的文本与边界固定下来，后台任务执行时仍会按
  // 最新水位重算；只有边界完全一致才复用这份文本，避免选区漂移。
  const { region } = planRegion(snapshot, {
    afterSeq: watermarkOf(state, scope),
    budgetTokens: config.retainTokens,
  });
  state.pendingConsolidation = {
    scope,
    trigger: plan.trigger,
    sessionId: sessionIdOf(payload) ?? scope,
    // H1：窗口按 surface seq 算；快照在 pre-step 已刷新好，这里固定下来，
    // 避免后台任务运行时被下一轮 pre-step 的新快照覆盖。
    snapshot,
    // N1：surface 选区文本（含 role 标注），执行时交给 consolidate。
    regionText: region?.text ?? '',
    regionStartSeq: region?.startSeq ?? null,
    regionEndSeq: region?.endSeq ?? null,
    // 后台执行时当前转录可能已经换轮，固定一份供选区缺失时兜底。
    transcript: state.transcript.map((row) => ({ role: row.role, text: row.text })),
  };
  if (state.consolidationScheduled || state.consolidationInFlight) return;
  state.consolidationScheduled = true;
  setImmediate(() => {
    state.consolidationScheduled = false;
    void runConsolidationJob(state);
  });
}

/**
 * 后台巩固任务：单飞；完成后若有新登记则再排一次。
 * @param {object} state
 */
async function runConsolidationJob(state) {
  if (state.disposed || state.consolidationInFlight) return;
  const job = state.pendingConsolidation;
  state.pendingConsolidation = null;
  if (job === null) return;
  state.consolidationInFlight = true;
  try {
    await executeConsolidationJob(state, job);
  } catch (error) {
    state.lastConsolidationResult = {
      ok: false,
      scope: job.scope,
      trigger: job.trigger,
      message: error instanceof Error ? error.message : String(error),
    };
    state.platform.log('warn', '[dsh-companion] consolidation job failed', {
      scope: job.scope,
      trigger: job.trigger,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    state.consolidationInFlight = false;
    if (!state.disposed && state.pendingConsolidation !== null && !state.consolidationScheduled) {
      state.consolidationScheduled = true;
      setImmediate(() => {
        state.consolidationScheduled = false;
        void runConsolidationJob(state);
      });
    }
  }
}

/**
 * 真正执行一次巩固：水位判断 → 模型草稿 → 单事务写库，成功才登记 pending_compact。
 * @param {object} state
 * @param {{scope:string, trigger:string, sessionId:string, snapshot:object|null,
 *   regionText?:string, regionStartSeq?:number|null, regionEndSeq?:number|null,
 *   transcript?:object[]}} job
 */
async function executeConsolidationJob(state, job) {
  const { store, platform, metrics, config } = state;
  const retrying = typeof job.consolidationId === 'string' && job.consolidationId !== '';
  let startSeq;
  let endSeq;
  let regionText;
  if (retrying) {
    // t17：重试固定使用首次登记的区间，不再按已变化的 surface 重选，
    // 否则会与 failed 行的 (scope, upto_seq, kind) 不匹配。
    startSeq = Number(job.regionStartSeq);
    endSeq = Number(job.regionEndSeq);
    if (!Number.isFinite(startSeq) || !Number.isFinite(endSeq)) {
      platform.log('warn', '[dsh-companion] consolidation retry has no region; dropping');
      state.consolidationRetry = null;
      return;
    }
    regionText = typeof job.regionText === 'string' && job.regionText !== '' ? job.regionText : null;
    platform.log('info', '[dsh-companion] consolidation retry attempt', {
      attempt: job.attempts ?? 1,
      startSeq,
      endSeq,
    });
  } else {
    const snapshot = job.snapshot;
    if (snapshot === null || snapshot === undefined) return;
    const watermark = watermarkOf(state, job.scope);
    const { region, reason } = planRegion(snapshot, {
      afterSeq: watermark,
      budgetTokens: config.retainTokens,
    });
    if (region === null) {
      platform.log('debug', '[dsh-companion] consolidation window empty', {
        reason,
        watermark,
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
    // N1：优先使用登记时固定的选区文本，但只有边界与本次重算完全一致时才复用；
    // 水位/选区漂移时以当步 region.text 为准，绝不把错位文本交给模型。
    const sameRegion = job.regionStartSeq === region.startSeq && job.regionEndSeq === region.endSeq;
    startSeq = region.startSeq;
    endSeq = region.endSeq;
    regionText = sameRegion && typeof job.regionText === 'string' && job.regionText !== ''
      ? job.regionText
      : region.text;
  }
  const transcript = Array.isArray(job.transcript) ? job.transcript : state.transcript;

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
      scope: job.scope,
      seqFrom: startSeq,
      seqTo: endSeq,
      // N1：模型输入优先用 surface 选区，transcript 只在选区缺失时兜底。
      regionText,
      transcript,
      llm,
      now: at,
      trigger: job.trigger,
      sessionId: job.sessionId,
      // 窗口已在 surface 层选好；水位推进允许跨过旧值。
      guardWatermark: false,
    });
    if (result?.skipped) {
      state.lastConsolidationResult = {
        ok: true,
        skipped: true,
        scope: job.scope,
        trigger: job.trigger,
        upto_seq: result.upto_seq,
      };
      return;
    }

    const consolidation = findConsolidation(store, job.scope, Number(result.upto_seq));
    state.pendingCompact = {
      id: consolidation?.id ?? null,
      startSeq,
      endSeq,
      scope: job.scope,
    };
    setWatermark(state, job.scope, endSeq);
    state.consolidationRetry = null;
    metrics.inc('consolidations');
    state.lastConsolidationResult = {
      ok: true,
      scope: job.scope,
      trigger: job.trigger,
      upto_seq: result.upto_seq,
    };
    platform.log('info', '[dsh-companion] consolidation written', {
      upto_seq: result.upto_seq,
      facts: result.facts ?? 0,
      trigger: job.trigger,
    });
  } catch (error) {
    const message = errorMessage(error);
    metrics.inc('consolidationFailures');
    state.lastConsolidationResult = {
      ok: false,
      scope: job.scope,
      trigger: job.trigger,
      message,
    };
    platform.log('warn', '[dsh-companion] consolidation failed', {
      trigger: job.trigger,
      message,
    });
    if (state.disposed) return;

    const attempts = Number(job.attempts ?? 0) + 1;
    let failedId = typeof job.consolidationId === 'string' ? job.consolidationId : null;
    try {
      failedId = recordFailedConsolidation(state, job, { startSeq, endSeq, at, message });
    } catch (recordError) {
      // 失败行写不进去时仍要保留原始错误与重试能力。
      platform.log('warn', '[dsh-companion] failed to record consolidation failure', {
        message: errorMessage(recordError),
      });
    }
    try {
      store.appendEvent({
        at,
        action: 'UPDATE',
        table_name: 'consolidations',
        row_id: failedId,
        actor: 'consolidator',
        reason: 'consolidation_failed',
        detail_json: { kind: 'consolidation_failure', trigger: job.trigger, message, attempts },
      });
    } catch {
      // 审计失败不覆盖原始错误。
    }

    const delay = retryDelayMs(attempts);
    if (!isCredentialError(error) && delay !== null && attempts <= MAX_CONSOLIDATION_RETRIES) {
      const nextAt = platform.now() + delay;
      state.consolidationRetry = {
        job: {
          ...job,
          consolidationId: failedId,
          attempts,
          regionStartSeq: startSeq,
          regionEndSeq: endSeq,
          regionText,
        },
        nextAt,
        scope: job.scope,
      };
      try {
        store.appendEvent({
          at,
          action: 'UPDATE',
          table_name: 'consolidations',
          row_id: failedId,
          actor: 'consolidator',
          reason: 'retry',
          detail_json: {
            kind: 'retry',
            trigger: job.trigger,
            attempts,
            nextRetryAt: Math.floor(nextAt / 1000),
            message,
            consolidationId: failedId,
          },
        });
      } catch {
        // 重试审计失败不影响重试本身。
      }
      platform.log('warn', '[dsh-companion] consolidation retry scheduled', {
        attempt: attempts,
        nextAt,
        delay,
      });
      return;
    }

    state.consolidationRetry = null;
    platform.log('error', '[dsh-companion] consolidation failed permanently', {
      attempts,
      credential: isCredentialError(error),
      message,
    });
    try {
      store.appendEvent({
        at,
        action: 'UPDATE',
        table_name: 'consolidations',
        row_id: failedId,
        actor: 'consolidator',
        reason: 'consolidation_failed_final',
        detail_json: {
          kind: 'consolidation_final',
          trigger: job.trigger,
          attempts,
          credential: isCredentialError(error),
          message,
        },
      });
    } catch {
      // 最终失败日志已可观测；审计失败不覆盖原始错误。
    }
  }
}

/**
 * t17：把一次巩固失败落成 consolidations 的 failed 行（重试复用同一行）。
 * @param {object} state
 * @param {object} job
 * @param {{startSeq:number, endSeq:number, at:number, message:string}} info
 * @returns {string|null}
 */
function recordFailedConsolidation(state, job, { startSeq, endSeq, at, message }) {
  const { store } = state;
  if (typeof job.consolidationId === 'string' && job.consolidationId !== '') {
    const existing = store.getConsolidation(job.consolidationId);
    if (existing && existing.status !== 'written' && existing.status !== 'compacted') {
      store.markConsolidated(existing.id, { status: 'failed', finishedAt: at, error: message });
      return existing.id;
    }
  }
  try {
    const row = store.insertConsolidation({
      scope: job.scope,
      session_id: job.sessionId ?? job.scope,
      kind: 'nap',
      trigger: job.trigger,
      upto_seq: endSeq,
      turn_from: startSeq,
      turn_to: endSeq,
      compaction_start_seq: startSeq,
      status: 'failed',
      error: message,
      started_at: at,
      finished_at: at,
    });
    return row?.id ?? null;
  } catch (insertError) {
    const existing = findConsolidation(store, job.scope, endSeq);
    // 并发/重叠巩固可能已把同一区间写成 written；不得为了记录失败而回退成功行。
    if (existing !== null && existing !== undefined
      && existing.status !== 'written' && existing.status !== 'compacted') {
      store.markConsolidated(existing.id, { status: 'failed', finishedAt: at, error: message });
      return existing.id;
    }
    throw insertError;
  }
}

/**
 * t17：idle 检查是否到了巩固重试时间；到点则把 job 放回待执行槽。
 * 有新巩固在排队/执行时延后，避免重试覆盖更新的窗口。
 * @param {object} state
 * @returns {boolean} 是否已排入执行
 */
function maybeRetryConsolidation(state) {
  const retry = state.consolidationRetry;
  if (retry === null || state.disposed) return false;
  if (state.consolidationInFlight || state.consolidationScheduled) return false;
  if (state.pendingConsolidation !== null) return false;
  if (state.platform.now() < retry.nextAt) return false;
  // 后续巩固可能已经推进水位覆盖旧区间；此时重试旧区间会把水位写回退。
  const retryEnd = Number(retry.job?.regionEndSeq);
  if (Number.isFinite(retryEnd) && watermarkOf(state, retry.scope) >= retryEnd) {
    state.consolidationRetry = null;
    state.platform.log('warn', '[dsh-companion] consolidation retry superseded; dropping', {
      scope: retry.scope,
      endSeq: retryEnd,
      watermark: watermarkOf(state, retry.scope),
    });
    return false;
  }
  state.consolidationRetry = null;
  state.pendingConsolidation = retry.job;
  state.consolidationScheduled = true;
  setImmediate(() => {
    state.consolidationScheduled = false;
    void runConsolidationJob(state);
  });
  return true;
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
    state.llm = async ({ scope, seqFrom, seqTo, regionText, textSource, transcript }) => hook({
      scope,
      seqFrom,
      seqTo,
      // N1：选区文本透传给宿主注入的模型；transcript 保留为兜底。
      regionText: regionText ?? '',
      textSource: textSource ?? (regionText ? 'region' : 'transcript'),
      transcript: Array.isArray(transcript) ? transcript : state.transcript,
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

  state.llm = async ({ scope, seqFrom, seqTo, regionText, transcript }) => {
    const prompt = buildConsolidationPrompt({
      scope,
      seqFrom,
      seqTo,
      regionText: regionText ?? '',
      transcript: Array.isArray(transcript) ? transcript : state.transcript,
    });
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
      // t17：巩固失败的重试优先于闲聊/主动消息，且不受预算降级影响。
      maybeRetryConsolidation(state);
      // M4：每 60s 读一次 RSS；warn 只记 metric，stop_dispatch/main_only 降级。
      runRssCheck(state);
      if (proactiveBlocked(state)) return;
      await runLightChat(state);
      const report = await proactive.flush();
      recordChatDelivery(state, report);
    },
    reminders: async () => {
      // 降级/熔断期间不把提醒标记 fired，恢复后仍可补投。
      if (proactiveBlocked(state)) return;
      // P1-b：承诺跟进先入队，逾期久的排前面；通用提醒不重复播报 commitment。
      runCommitmentFollowups(state);
      fireDueReminders(state);
      const report = await proactive.flush();
      recordChatDelivery(state, report);
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
    // 承诺由 runCommitmentFollowups 单独处理（每日最多一次、文案不同）。
    if (row.kind === 'commitment') continue;
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

/* ------------------------------------------------------------------------- */
/* P1-b：承诺跟进 + 轻量闲聊                                                   */
/* ------------------------------------------------------------------------- */

/**
 * 读 schema_meta 里的 JSON；损坏/缺失都退回默认值，不影响调度。
 * @param {Store} store
 * @param {string} key
 * @param {unknown} fallback
 * @returns {unknown}
 */
function readMetaJson(store, key, fallback) {
  try {
    const raw = store.getMeta(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * 写 schema_meta；失败只 warn（重启后最多丢一次闲聊开关/历史）。
 * @param {Store} store
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
function writeMeta(store, key, value) {
  try {
    store.setMeta(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读出闲聊开关、上次闲聊时间（ms）与最近发送历史（Unix 秒）。
 * @param {object} state
 * @returns {{enabled: boolean, lastAt: number|null, sentTimes: number[],
 *            interactionDay: string|null}}
 */
function chatStateOf(state) {
  const store = state?.store;
  let enabled = true;
  let lastAt = null;
  let sentTimes = [];
  let interactionDay = null;
  try {
    if (store.getMeta(CHAT_META.enabled) === '0') enabled = false;
    const rawLast = Number(store.getMeta(CHAT_META.lastAt));
    if (Number.isFinite(rawLast) && rawLast > 0) lastAt = rawLast * 1000;
    const rawSent = readMetaJson(store, CHAT_META.sent, []);
    sentTimes = Array.isArray(rawSent)
      ? rawSent.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const rawDay = store.getMeta(CHAT_META.interactionDay);
    interactionDay = typeof rawDay === 'string' && rawDay !== '' ? rawDay : null;
  } catch {
    // 读失败按「默认开启、无历史」处理，不阻断任何调度。
  }
  return { enabled, lastAt, sentTimes, interactionDay };
}

/**
 * 记录今天有过用户互动（当天只写一次）。
 * @param {object} state
 * @param {number} now
 */
function recordInteractionDay(state, now) {
  try {
    const day = zonedDayKey(now, state.config.timezone);
    if (state.store.getMeta(CHAT_META.interactionDay) === day) return;
    writeMeta(state.store, CHAT_META.interactionDay, day);
  } catch {
    // 互动记录失败不影响本轮对话。
  }
}

/**
 * 持久化闲聊开关（/别闲聊、/恢复闲聊）。
 * @param {object} state
 * @param {boolean} enabled
 */
function setChatEnabled(state, enabled) {
  if (state?.store) writeMeta(state.store, CHAT_META.enabled, enabled ? '1' : '0');
}

/**
 * 处理 /别闲聊 与 /恢复闲聊；返回给用户的确认文案。
 * @param {{state?: object, mode: 'on'|'off', now?: number}} input
 * @returns {string}
 */
function handleChatCommand({ state, mode } = {}) {
  const enabled = mode === 'on';
  setChatEnabled(state, enabled);
  return enabled ? '已恢复主动闲聊。' : '已关闭主动闲聊。';
}

/**
 * 补零。
 * @param {number} value
 * @returns {string}
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 按配置时区格式化日期时间（状态命令展示用）。
 * @param {number} ms
 * @param {string} timeZone
 * @returns {string}
 */
function formatDateTime(ms, timeZone) {
  const parts = zonedParts(ms, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * /状态 里的闲聊行：开关 + 最近一次时间。
 * @param {object} state
 * @param {number} now
 * @returns {string}
 */
function formatChatStatus(state, now) {
  const chat = chatStateOf(state);
  const last = chat.lastAt === null ? '无' : formatDateTime(chat.lastAt, state.config.timezone);
  return `闲聊：${chat.enabled ? '已开启' : '已关闭'} · 最近一次：${last}`;
}

/**
 * 扫描到期承诺并入队：每条每天最多一次，逾期久的先入队。
 * @param {object} state
 * @returns {number} 本次入队条数
 */
function runCommitmentFollowups(state) {
  const { store, platform, proactive, config, metrics } = state;
  const now = platform.now();
  const timeZone = config.timezone;
  let rows;
  try {
    rows = scanCommitmentFollowups({ store, now, timeZone, scope: SCOPE });
  } catch (error) {
    platform.log('warn', '[dsh-companion] commitment scan failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  if (rows.length === 0) return 0;

  // 安静时段不打扰：行保持 pending/snoozed（相当于留在待跟进 backlog），
  // 等安静结束后的第一个 reminders tick 再补发，避免跨日重复。
  if (isQuietAt(new Date(now), config)) {
    platform.log('debug', '[dsh-companion] commitment follow-ups deferred by quiet hours', {
      pending: rows.length,
    });
    return 0;
  }

  const dayKey = zonedDayKey(now, timeZone);
  const mark = store.db.prepare(
    'UPDATE reminders SET last_fire_key = ?, updated_at = unixepoch() WHERE id = ?',
  );
  let count = 0;
  for (const row of rows) {
    if (count >= COMMITMENT_MAX_FOLLOWUPS) break;
    const overdueDays = commitmentOverdueDays(row, { now });
    proactive?.enqueue({
      kind: 'reminder',
      text: followUpText({ card: DEFAULT_CARD, reminder: row, overdueDays }),
      dedupeKey: `commitment:${row.id}:${dayKey}`,
      at: now,
    });
    mark.run(dayKey, row.id);
    try {
      store.appendEvent({
        at: Math.floor(now / 1000),
        action: 'USED',
        table_name: 'reminders',
        row_id: row.id,
        actor: 'scheduler',
        reason: COMMITMENT_FOLLOWUP_REASON,
        detail_json: commitmentAuditDetail(row),
      });
    } catch {
      // 审计失败不影响已经入队的跟进。
    }
    metrics?.inc('commitmentFollowups');
    count += 1;
  }
  if (count > 0) {
    platform.log('debug', '[dsh-companion] commitment follow-ups queued', { count, day: dayKey });
  }
  return count;
}

/**
 * 判断此刻能否发起轻量闲聊，并生成一条 5..10 句的主动消息。
 * 所有失败只记日志，绝不向外抛。
 * @param {object} state
 * @returns {Promise<{queued: boolean, reason?: string, sentences?: number}>}
 */
async function runLightChat(state) {
  const { store, platform, config, metrics } = state;
  const now = platform.now();
  const timeZone = config.timezone;
  const dayKey = zonedDayKey(now, timeZone);
  try {
    if (store.getMeta(CHAT_META.lastTryDay) === dayKey) {
      return { queued: false, reason: 'already_tried' };
    }
    const chat = chatStateOf(state);
    const verdict = chatEligibility({
      now,
      timeZone,
      enabled: chat.enabled,
      interactionDay: chat.interactionDay,
      lastChatAt: chat.lastAt === null ? null : Math.floor(chat.lastAt / 1000),
      sentTimes: chat.sentTimes,
      quiet: isQuietAt(new Date(now), config),
    });
    if (!verdict.ok) {
      platform.log('debug', '[dsh-companion] light chat skipped', { reason: verdict.reason });
      return { queued: false, reason: verdict.reason };
    }

    let recentTopics = [];
    try {
      recentTopics = store.listEpisodes({ scope: SCOPE, limit: 5 }).map((row) => ({
        title: typeof row.title === 'string' ? row.title : '',
        summary: typeof row.summary === 'string' ? row.summary : '',
      }));
    } catch {
      recentTopics = [];
    }

    let recallSummary = '';
    try {
      const recalled = await retrieve({
        store,
        query: recentTopics[0]?.title ?? '',
        scope: SCOPE,
        now,
        budgetTokens: 600,
        limit: 3,
      });
      recallSummary = recalled.items
        .map((item) => item.text)
        .filter((text) => typeof text === 'string' && text !== '')
        .join('\n');
    } catch {
      recallSummary = '';
    }

    const llm = await resolveChatLlm(state);
    if (typeof llm !== 'function') {
      if (!state.warnedNoChatLlm) {
        state.warnedNoChatLlm = true;
        platform.log('warn', '[dsh-companion] no LLM available for light chat');
      }
      return { queued: false, reason: 'no_llm' };
    }

    let raw;
    try {
      raw = await llm({ card: DEFAULT_CARD, recentTopics, recallSummary, messageCount: 8 });
    } catch (error) {
      platform.log('warn', '[dsh-companion] light chat generation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { queued: false, reason: 'llm_failed' };
    }

    const normalized = normalizeChatText(typeof raw === 'string' ? raw : raw?.text, {
      bannedPhrases: DEFAULT_CARD.bannedPhrases,
    });
    if (!normalized.ok) {
      platform.log('debug', '[dsh-companion] light chat rejected', {
        reason: normalized.reason,
        sentences: normalized.sentences,
      });
      writeMeta(store, CHAT_META.lastTryDay, dayKey);
      return { queued: false, reason: normalized.reason };
    }

    state.proactive?.enqueue({
      kind: 'chat',
      text: normalized.text,
      dedupeKey: `chat:${dayKey}`,
      at: now,
    });
    writeMeta(store, CHAT_META.lastTryDay, dayKey);
    metrics?.inc('lightChatAttempts');
    platform.log('debug', '[dsh-companion] light chat queued', {
      sentences: normalized.sentences,
    });
    return { queued: true, sentences: normalized.sentences };
  } catch (error) {
    platform.log('warn', '[dsh-companion] light chat failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { queued: false, reason: 'error' };
  }
}

/**
 * 统计 proactive 实际投出的聊天，更新最近一次时间与 7 天历史。
 * @param {object} state
 * @param {unknown} report proactive.flush 的返回值
 * @returns {number}
 */
function recordChatDelivery(state, report) {
  try {
    const items = Array.isArray(report?.items) ? report.items : [];
    if (!items.some((item) => item?.kind === 'chat')) return 0;
    const { store, platform, metrics } = state;
    const nowSeconds = Math.floor(platform.now() / 1000);
    const rawSent = readMetaJson(store, CHAT_META.sent, []);
    const sent = Array.isArray(rawSent)
      ? rawSent.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    sent.push(nowSeconds);
    const pruned = sent.filter((value) => value >= nowSeconds - CHAT_HISTORY_SECONDS);
    writeMeta(store, CHAT_META.lastAt, String(nowSeconds));
    writeMeta(store, CHAT_META.sent, JSON.stringify(pruned));
    metrics?.inc('lightChats');
    return 1;
  } catch {
    return 0;
  }
}

/**
 * 解析闲聊模型：优先宿主 hook，其次平台 LLM 路由。
 * @param {object} state
 * @returns {Promise<Function|null>}
 */
async function resolveChatLlm(state) {
  if (state.chatLlmResolved) return state.chatLlm;
  state.chatLlmResolved = true;
  const hook = state.host?.companion?.chatLlm;
  if (typeof hook === 'function') {
    state.chatLlm = async (input) => hook(input);
    state.chatLlmRoute = { kind: 'hook' };
    return state.chatLlm;
  }
  const { platform } = state;
  if (!platform?.capabilities?.llm) {
    state.chatLlm = null;
    return null;
  }
  try {
    const providers = (await platform.listProviders()) ?? [];
    let provider = null;
    let model = null;
    for (const candidate of providers) {
      const models = (await platform.listModels(candidate.id)) ?? [];
      if (models.length > 0) {
        provider = candidate.id;
        model = models[0].id ?? models[0];
        break;
      }
    }
    if (provider === null || model === null) {
      state.chatLlm = null;
      return null;
    }
    state.chatLlmRoute = { provider, model };
    state.chatLlm = async (input) => state.platform.complete({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildChatPrompt(input) }] }],
    });
  } catch {
    state.chatLlm = null;
  }
  return state.chatLlm;
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
      // 审计失败不影响把错误上抛给调度器。
    }
    // t17：备份失败必须让 scheduler 记录 job_error/last_error，并在次日重试；
    // 不能在这里吞掉（只写审计会让调度器误以为成功）。
    throw error;
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

// -------------------------------------------------------------- P1-a 记忆治理

/** `/记忆` 每页条数。 */
const MEMORY_PAGE_SIZE = 20;
/** `/记忆` 旧子命令：拦截器返回 null，交给 commands.js 保持原行为。 */
const LEGACY_MEMORY_VERBS = Object.freeze(['忘掉', '彻底忘掉', '置顶', '取消置顶']);

/**
 * 删除某条 fact 的 FTS 行（治理/编辑后调用；updateFact 会重刷 FTS）。
 * @param {Store} store
 * @param {string} id
 */
function deleteFactFtsRow(store, id) {
  store.db
    .prepare('DELETE FROM fts_facts WHERE rowid = (SELECT rowid FROM facts WHERE id = ?)')
    .run(id);
}

/**
 * 按需追加 sensitive 列（幂等；只加列，不动既有列）。
 * @param {Store} store
 */
function ensureSensitiveColumn(store) {
  const columns = store.db.prepare('PRAGMA table_info(facts)').all();
  if (columns.some((column) => column.name === 'sensitive')) return;
  store.db.exec('ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0');
}

/**
 * 解析 `/记忆` 的参数：页码 + 关键词。
 * @param {string} text
 * @returns {{page: number, keyword: string}}
 */
function parseMemoryPage(text) {
  const words = [];
  let page = 1;
  const tokens = String(text ?? '').split(/\s+/u).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const inline = /^--page=(\d+)$/u.exec(token);
    if (inline !== null) {
      page = Math.max(1, Number(inline[1]));
      continue;
    }
    if (token === '--page') {
      const next = Number(tokens[index + 1]);
      if (Number.isFinite(next)) {
        page = Math.max(1, Math.trunc(next));
        index += 1;
      }
      continue;
    }
    const chinese = /^第(\d+)页$/u.exec(token);
    if (chinese !== null) {
      page = Math.max(1, Number(chinese[1]));
      continue;
    }
    words.push(token);
  }
  return { page, keyword: words.join(' ').trim() };
}

/**
 * 记忆列表文本：按 kind 分组、关键词过滤、每页最多 20 条。
 * @param {{store: Store, scope: string, text: string, timeZone: string}} input
 * @returns {string}
 */
function formatMemoryList({ store, scope, text, timeZone }) {
  const { page, keyword } = parseMemoryPage(text);
  const needle = keyword.toLowerCase();
  const rows = store.db
    .prepare(
      `SELECT * FROM facts
        WHERE scope = ? AND status = 'active' AND deleted_at IS NULL
        ORDER BY kind ASC, observed_at DESC, id ASC`,
    )
    .all(scope);
  const matched = needle === ''
    ? rows
    : rows.filter((fact) => [
      fact.statement,
      fact.subject_text,
      fact.predicate,
      fact.object_text,
    ].some((part) => String(part ?? '').toLowerCase().includes(needle)));

  const title = keyword === ''
    ? `记忆（共 ${matched.length} 条）`
    : `记忆（匹配「${keyword}」共 ${matched.length} 条）`;
  if (matched.length === 0) {
    return keyword === '' ? `${title}\n\n还没有记忆。` : `${title}\n\n没有匹配的记忆。`;
  }

  const pages = Math.max(1, Math.ceil(matched.length / MEMORY_PAGE_SIZE));
  const current = Math.min(page, pages);
  const start = (current - 1) * MEMORY_PAGE_SIZE;
  const pageRows = matched.slice(start, start + MEMORY_PAGE_SIZE);
  const lines = [`${title} · 第 ${current}/${pages} 页`];
  let lastKind = null;
  for (const fact of pageRows) {
    const kind = String(fact.kind ?? 'other');
    if (kind !== lastKind) {
      lines.push('', `[${kind}]`);
      lastKind = kind;
    }
    const source = String(fact.source_kind ?? 'unknown');
    const at = zonedDayKey(toMillis(fact.observed_at), timeZone);
    const marks = [];
    if (fact.sensitive === 1) marks.push('敏感');
    if (fact.privacy === 'secret') marks.push('secret');
    const suffix = marks.length === 0 ? '' : `（${marks.join('/')}）`;
    lines.push(`- ${fact.id} · ${source} · ${at}${suffix}`);
    lines.push(`  ${String(fact.statement ?? '').replace(/\s+/gu, ' ').trim()}`);
  }
  const remaining = matched.length - start - pageRows.length;
  if (remaining > 0) {
    lines.push('', `还有 ${remaining} 条；用关键词或 --page 继续查看。`);
  }
  return lines.join('\n');
}

/**
 * `/记忆 治理` 的摘要文本。
 * @param {{store: Store, scope: string, now: number, dryRun: boolean}} input
 * @returns {string}
 */
function formatGovernance({ store, scope, now, dryRun }) {
  const result = applyGovernance({ store, scope, now, dryRun });
  const lines = [
    `记忆治理（${dryRun ? 'dry-run，不写库' : '已应用'}）`,
    `重复 ${result.counts.duplicates} 组 · 冲突 ${result.counts.conflicts} 组 · 过期 ${result.counts.stale} 条 · 敏感 ${result.counts.sensitive} 条`,
  ];
  if (result.duplicates.length > 0) {
    lines.push('重复（保留 ← 降级）：');
    for (const item of result.duplicates) lines.push(`- ${item.keepId} ← ${item.dropId}（${item.score.toFixed(2)}）`);
  }
  if (result.conflicts.length > 0) {
    lines.push('冲突：');
    for (const item of result.conflicts) {
      lines.push(`- ${item.subject ?? '(无 subject)'} / ${item.predicate ?? '(无 predicate)'}：${item.factIds.join(', ')}`);
    }
  }
  if (result.applied.superseded.length > 0) lines.push(`已降级：${result.applied.superseded.join(', ')}`);
  if (result.applied.sensitive.length > 0) lines.push(`已标记敏感：${result.applied.sensitive.join(', ')}`);
  if (dryRun) lines.push('加 --dry-run 之外的写法（/记忆 治理）才会真正应用。');
  return lines.join('\n');
}

/**
 * 编辑一条长期记忆：新内容以新 id 生效，旧条 superseded_by 指向新条。
 *
 * @param {{store: Store, scope?: string, id: string, statement: string,
 *          now?: number|Date}} input
 * @returns {{ok: boolean, id?: string, supersededId?: string, reason?: string, message?: string}}
 */
export function editMemoryFact({ store, scope = SCOPE, id, statement, now = Date.now() } = {}) {
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, reason: 'invalid_id', message: '记忆 id 不能为空' };
  }
  if (typeof statement !== 'string' || statement.trim() === '') {
    return { ok: false, reason: 'invalid_statement', message: '新内容不能为空' };
  }
  const confidence = store.getFact?.(id);
  if (confidence === null || confidence === undefined) {
    return { ok: false, reason: 'not_found', message: `没有找到记忆 ${id}` };
  }
  if (confidence.scope !== scope) {
    return { ok: false, reason: 'scope_denied', message: `记忆 ${id} 不在当前作用域` };
  }
  if (confidence.deleted_at !== null || confidence.status !== 'active') {
    return { ok: false, reason: 'not_active', message: `记忆 ${id} 不是 active 状态` };
  }

  const nowMs = toMillis(now);
  const atSeconds = Math.floor(nowMs / 1000);
  const nextStatement = statement.trim();
  const markSensitive = confidence.sensitive === 1 || isSensitiveText(nextStatement);
  let newId = null;
  try {
    store.transaction(() => {
      const inserted = store.insertFact({
        scope,
        kind: confidence.kind,
        subject_id: confidence.subject_id,
        subject_text: confidence.subject_text,
        predicate: confidence.predicate,
        object_text: confidence.object_text,
        statement: nextStatement,
        source_kind: confidence.source_kind,
        source_episode_id: confidence.source_episode_id,
        source_excerpt: confidence.source_excerpt,
        salience: confidence.salience,
        privacy: confidence.privacy,
        observed_at: atSeconds,
        valid_from: atSeconds,
        strength_days: confidence.salience === 'pinned' ? null : confidence.strength_days,
        last_reinforced_at: confidence.last_reinforced_at ?? null,
        recall_count: 0,
        fidelity: confidence.fidelity,
        status: 'active',
      });
      newId = inserted.id;
      store.updateFact(id, { status: 'superseded', superseded_by: newId });
      deleteFactFtsRow(store, id);
      if (markSensitive) {
        ensureSensitiveColumn(store);
        store.db.prepare('UPDATE facts SET sensitive = 1 WHERE id = ?').run(newId);
        deleteFactFtsRow(store, newId);
      }
      appendEventWithAction(store, {
        action: 'EDIT',
        tableName: 'facts',
        rowId: newId,
        actor: 'user',
        reason: 'memory_update',
        at: nowMs,
        detail: { from: id, to: newId },
      });
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, id: newId, supersededId: id };
}

/**
 * `/记忆` 的新子命令；返回 null 时交给旧 handleCommand（忘掉/置顶等）。
 *
 * @param {{text: string, store: Store, now?: number, scope?: string, timeZone?: string}} input
 * @returns {string|null}
 */
export function handleMemoryCommand({ text, store, now = Date.now(), scope = SCOPE, timeZone } = {}) {
  const body = String(text ?? '').replace(/^\/记忆/u, '').trim();
  const [verb] = body.split(/\s+/u);
  if (body === '' || verb === '列表' || verb === 'list') {
    const keyword = body === '' ? '' : body.slice(verb.length).trim();
    return formatMemoryList({ store, scope, text: keyword, timeZone: timeZone ?? 'Asia/Shanghai' });
  }
  if (verb === '改' || verb === 'edit') {
    const rest = body.slice(verb.length).trim();
    const matched = /^(\S+)\s+([\s\S]+)$/u.exec(rest);
    if (matched === null) return '用法：/记忆 改 <id> <新内容>';
    const result = editMemoryFact({ store, scope, id: matched[1], statement: matched[2], now });
    if (result.ok) return `已更新记忆：${result.supersededId} → ${result.id}`;
    return `修改失败：${result.message ?? result.reason}`;
  }
  if (verb === '治理' || verb === 'govern') {
    const dryRun = body.includes('--dry-run');
    return formatGovernance({ store, scope, now: toMillis(now), dryRun });
  }
  if (LEGACY_MEMORY_VERBS.includes(verb)) return null;
  return formatMemoryList({ store, scope, text: body, timeZone: timeZone ?? 'Asia/Shanghai' });
}

/**
 * memory_update 工具执行体。
 * @param {{store: Store, scope: string|null|undefined, args: object, now?: number}} input
 * @returns {object}
 */
export function updateMemoryTool({ store, scope, args, now = Date.now() } = {}) {
  if (scope === null) return { ok: false, reason: 'scope_denied', message: 'subagent 会话不能修改记忆' };
  return editMemoryFact({
    store,
    scope: scope ?? SCOPE,
    id: args?.id,
    statement: args?.statement,
    now,
  });
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

export {
  formatChatStatus,
  handleChatCommand,
  runCommitmentFollowups,
  runLightChat,
};
