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
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isQuietAt, normalizeConfig } from './config.js';
import { REMINDER_MAX_DELIVERY_ATTEMPTS, Store, reminderDueAt } from './memory/store.js';
import { retrieve } from './memory/retrieve.js';
import { createEmbedder } from './memory/embedders/index.js';
import { assemble } from './memory/assemble.js';
import {
  CONFIRM_ALPHA,
  DEFAULT_ALPHA,
  USE_OVERLAP_THRESHOLD,
  applyReinforcement,
  isConfirmation,
  overlapRatio,
} from './memory/reinforce.js';
import { buildConsolidationPrompt, consolidate, planConsolidation } from './memory/consolidate.js';
import {
  episodeSourceInSurface,
  isSameContextSample,
  resolveObservedAt,
} from './memory/reneed.js';
import {
  appendEventWithAction,
  apply as applyGovernance,
  CREDENTIAL_HINT,
  exportMirror,
  isSensitiveText,
  scan as scanGovernance,
} from './memory/govern.js';
import { exportAll } from './memory/export.js';
import { publishBoard, renderBoard, stageBoard } from './memory/state-board.js';
import { boardSection, buildSections, buildSectionsWithDiagnostics } from './persona/sections.js';
import { CARD_STATUS, DEFAULT_CARD, loadPersonaCard, personaProactiveConflicts, renderTemplate } from './persona/card.js';
import {
  createAssemblyRecord,
  recordEmotionText,
  recordSections,
  recordShadow,
} from './persona/assembly-record.js';
import { createAssembleHandler } from './persona/shadow.js';
import {
  EMOTION_PROMPT_PREFIX,
  EMOTION_SOURCE_KIND,
  applyClassifiedEvent,
  runEmotionTurn,
} from './persona/emotion-wiring.js';
import {
  APPRAISAL_ERRORS,
  AppraisalError,
  buildAppraisalMessages,
  createAppraisalQueue,
  createAppraisalStats,
} from './persona/emotion-appraise.js';
import { classify as classifyEmotion } from './persona/emotion-classify.js';
import {
  buildChatPrompt,
  chatEligibility,
  normalizeChatText,
  renderBannedPhrases,
} from './persona/chat.js';
import {
  COMMITMENT_FOLLOWUP_REASON,
  commitmentAuditDetail,
  commitmentOverdueDays,
  followUpText,
  scanCommitmentFollowups,
} from './scheduler/commitments.js';
import { createAdapter } from './platform/adapter.js';
import { MAIN_SCOPE, MAIN_BINDING_LATEST, MAIN_SESSION_META_KEY, classifySession, threadScope } from './session/identity.js';
import {
  BUDGET_REASONS,
  DAILY_TOKEN_LIMIT,
  checkMemory,
  createBudgetState,
  levelAtLeast,
  overDailyBudget,
  recordTurnUsage,
  rssLimitsFromConfig,
} from './runtime/budget.js';
import {
  MAX_CONSOLIDATION_RETRIES,
  errorMessage,
  isCredentialError,
  retryDelayMs,
} from './runtime/retry.js';
import { COMMAND_HINT_SOURCE_KIND, commandHintMessage, handleCommand } from './runtime/commands.js';
import { elapsedMs, nowMs, recordTimingSample } from './runtime/timing.js';
import { createMetrics } from './runtime/metrics.js';
import { createProactive } from './runtime/proactive.js';
import { JOB_IDS, createScheduler } from './runtime/scheduler.js';
import { createTools } from './runtime/tools.js';
import {
  createPendingCompacts,
  peekPendingCompact,
  recoverPendingCompacts,
  setPendingCompact,
  takePendingCompact,
} from './state/pending-compact.js';
import {
  createSurfaceIndex,
  firstReplaceableIndex,
  planRegion,
  surfaceSeqs,
  watermarkAfterCompact,
} from './session/surface.js';
import * as threadRegistry from './thread/registry.js';
import { zonedDayKey, zonedParts } from './time.js';

export const name = 'dsh-companion';

/**
 * cordis inject 声明（C-H1）。
 *
 * 只列目标宿主真实存在、且插件缺了就跑不起来的 service；名单以
 * `scripts/probe/probe-plugin.js` 产出的 `.data/probe.json`
 * `capabilities.services.*.present` 为准（2026-11-03 探针：四项均为 true）。
 *
 * - `ctx.interval` 是 timer 混入的访问器，内部读 `timer` service，所以声明
 *   `timer` 而不是 `interval`；`ctx.on` 来自 Context 自带的 events，不需要声明。
 * - cordis 4 没有 optional inject：一旦声明，宿主缺该 service 时整个 entry 会停在
 *   待激活状态、插件永远不 apply。因此其余能力（compaction / sessionController /
 *   workspaceRegistry / tokenMeter / sessionQuery / agents / llm / logger …）全部
 *   走 `ctx.get(name)` 探测 + adapter 的 unavailable 降级，不写进 inject。
 *
 * 历史：v0.4.2 之前没有本声明，真实宿主上 apply 的第一个属性读
 * （`ctx.rssReader`）就抛 `cannot get property "rssReader" without inject`，
 * 插件从未激活；测试用普通对象 mock，属性读不抛，所以 667 个用例没覆盖到。
 */
export const inject = ['systemPrompt', 'timer', 'commands', 'tools'];

/** 默认/主会话作用域。 */
const SCOPE = MAIN_SCOPE;

/** 召回预算（R-SES-07：注入 ≤2050 tokens；总量由 config.workingMemoryTokens 控制）。 */
const RECALL_BUDGET_TOKENS = 2050;

/**
 * 召回注入消息的 `source.kind`（v0.4.4 / V3-H1）。
 *
 * 平台把 `decision.messages` 的每一项都当**完整消息**处理：
 * `dsh-agent-loop/lib/index.js:1067` 逐条读 `message.source.kind`，
 * 非 `runtime-context` 的消息直接 `session.append('user/message', message)`，
 * 而 `dsh-session/lib/index.js:1186-1219` 要求消息带非空 `id`、`role`、
 * `source`（对象 + 非空字符串 kind）与数组 `content`。所以召回注入必须是
 * 完整平台消息，不能是裸内容块（裸块会崩在 `reading 'kind'`）。
 *
 * 该 kind 同时是本插件识别「这条 user/message 是召回注入、不是用户发言」
 * 的标记：转录快照与巩固选区文本据此排除注入块。
 */
const RECALL_SOURCE_KIND = 'companion-recall';

/**
 * 宿主运行时上下文快照的 source.kind（`RuntimeContextProjection` 生成）。
 * 它也是 user/message，但不是用户发言：转录与 lastUserText 必须排除。
 */
const RUNTIME_CONTEXT_SOURCE_KIND = 'runtime-context';

/**
 * V7-H1：线程/任务类工具。
 *
 * 能力只能在**调用时**判断：sessionController 由宿主在 apply 之后才挂载
 * （adapter.capabilities 是 getter），apply 时读到 false 只代表「还没挂上」。
 * 若据此少注册工具，真宿主上这组工具就永远不会注册；因此一律注册，执行时
 * 再按 `capabilities.threadTools` 决定返回 capability_missing 还是真正执行。
 */
const THREAD_TOOL_NAMES = new Set(['thread_list', 'thread_run', 'task_run']);

/**
 * V7-H1：线程能力缺失时的稳定错误对象。每次新建，避免调用方改写共享常量。
 * @returns {{ok: false, reason: string, message: string}}
 */
function threadCapabilityMissing() {
  return {
    ok: false,
    reason: 'capability_missing',
    message: '宿主未提供 sessionController，线程工具暂不可用',
  };
}

/**
 * V3-L3：中文命令提示注入正文的固定前缀。
 * surface 记录只有 `{role, text, tokens}`（没有 source），排除巩固窗口时按
 * 这个前缀兜底识别；文案与 runtime/commands.js 的 commandHintMessage 一致。
 */
const COMMAND_HINT_TEXT_PREFIX = '宿主只注册 ASCII 命令名';

/**
 * V7-M3：凭据提示注入消息的 source.kind 与正文前缀。
 *
 * 用户消息命中凭据类内容（密码/key/token/验证码…）时，pre-step 注入一句给模型
 * 的指令：不要复述具体值、不要调用记忆工具保存，并在回复里带上固定提示。
 * 提示本身也带 source.kind，转录/巩固/主会话绑定都按 kind 或前缀排除。
 */
const PRIVACY_HINT_SOURCE_KIND = 'companion-privacy-hint';
const PRIVACY_HINT_TEXT_PREFIX = '用户消息里含凭据类信息';

/** 召回块文本标记（assemble 渲染）；surface 记录只有 role/text，没有 source。 */
const RECALL_MARKER = '[相关记忆]';

/**
 * V4-L2：召回块结束标记。注入块会随会话保留到下一次压缩，平台摘要若原样
 * 复述召回内容，单看开头标记无法确定剔除边界；成对标记让巩固前能整段剔除。
 */
const RECALL_END_MARKER = '[/相关记忆]';

/**
 * C5-H1a：本插件主动投递消息的 requestId 前缀。
 *
 * 宿主会把 `sessionController.prompt` 的消息记成 `source.kind='user'`、
 * `source.rpcId=request.requestId`。插件自己发出的提醒/主动消息因此必须能被
 * 认出来，否则会被当成用户发言参与巩固、主会话重绑与召回查询。
 */
const COMPANION_RPC_PREFIX = 'companion-';

/** C5-H1a：提醒正文前缀（surface 记录没有 source，按正文兜底识别）。 */
const REMINDER_TEXT_PREFIX = '[提醒] ';

/** C5-H1a：投递失败事件 kind（memory_events.detail_json.kind）。 */
const DELIVERY_ERROR_KIND = 'delivery_error';

/** 转录快照：只保留最近 N 条 / N 字符，供巩固模型使用。 */
const TRANSCRIPT_MAX_MESSAGES = 40;
const TRANSCRIPT_MAX_CHARS = 6000;

/** 备份保留份数（t23 L2：按日期滚动）。 */
const BACKUP_KEEP = 7;

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
 * 读一个宿主席位：先看 `apply()` 第三参 hooks（测试/嵌入方显式注入），
 * 再经 `ctx.get(name)` 读宿主 service。
 *
 * 绝不直接读 Context 代理属性：cordis 4 对 inject 未声明的 service 属性读会抛
 * `cannot get property "x" without inject`（C-H1 根因）。`ctx.get()` 是唯一
 * 不抛的属性读法，缺失时返回 undefined。
 *
 * @param {object} ctx 平台上下文
 * @param {Record<string, unknown>} hooks 显式注入的席位
 * @param {string} name 席位名
 * @returns {unknown}
 */
function hostValue(ctx, hooks, name) {
  if (hooks !== null && typeof hooks === 'object'
    && Object.prototype.hasOwnProperty.call(hooks, name)
    && hooks[name] !== undefined) {
    return hooks[name];
  }
  if (typeof ctx?.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

/**
 * 组装测试席位：now / cwd / rssReader / companion。
 *
 * 宿主（或 hooks）不提供时回落进程能力，保证插件在裸 ctx（单测、headless 探针）
 * 上仍能启动：`Date.now()`、`process.cwd()`、`process.memoryUsage().rss`。
 *
 * @param {object} ctx 平台上下文
 * @param {Record<string, unknown>} hooks
 * @returns {{now: () => number, cwd: () => string, rssReader: () => number, companion: object|null}}
 */
function createSeats(ctx, hooks) {
  const nowSeat = hostValue(ctx, hooks, 'now');
  let now;
  if (typeof nowSeat === 'function') {
    now = () => Number(nowSeat());
  } else if (typeof nowSeat === 'number' && Number.isFinite(nowSeat)) {
    now = () => nowSeat;
  } else {
    now = () => Date.now();
  }

  const workspaceSeat = hostValue(ctx, hooks, 'workspace');
  const cwdSeat = hostValue(ctx, hooks, 'cwd');
  const cwd = () => {
    let value;
    if (typeof cwdSeat === 'function') value = cwdSeat();
    else if (cwdSeat !== undefined) value = cwdSeat;
    else value = workspaceSeat?.cwd;
    return typeof value === 'string' && value !== '' ? value : process.cwd();
  };

  const rssSeat = hostValue(ctx, hooks, 'rssReader');
  const rssReader = typeof rssSeat === 'function'
    ? () => Number(rssSeat())
    : () => process.memoryUsage().rss;

  const companionSeat = hostValue(ctx, hooks, 'companion');
  const companion = companionSeat !== null && typeof companionSeat === 'object'
    ? companionSeat
    : null;

  return { now, cwd, rssReader, companion };
}

/**
 * 插件入口。
 * @param {object} ctx 平台上下文
 * @param {Record<string, unknown>} [rawConfig] 用户原始配置
 * @param {Record<string, unknown>} [hooks] 显式注入的测试席位（now/cwd/rssReader/companion/personaDeps）
 * @returns {{dispose: () => void}|undefined}
 */
export function apply(ctx, rawConfig, hooks = {}) {
  const config = normalizeConfig(rawConfig);
  const host = ctx !== null && typeof ctx === 'object' ? ctx : null;
  host?.logger?.info?.('[dsh-companion] config ok', { warnings: config.warnings });
  if (host === null) return undefined;

  const installed = INSTALLS.get(host);
  if (installed) {
    host.logger?.debug?.('[dsh-companion] already installed on this context; reusing handle');
    return installed.handle;
  }

  const seats = createSeats(host, hooks);
  const platform = createAdapter(host, { now: seats.now, cwd: seats.cwd });
  const store = Store.open(config.dbPath);
  // W4：向量关闭时保持 v0.3.2 的 hash 投影路径；开启时按 embedder 配置 id/dim。
  // local/remote 没有同步向量函数，写入路径先不投影，由 idle-probe 回填。
  const embedder = config.vector.enabled ? createEmbedder(config.vector) : null;
  if (embedder === null || embedder.kind === 'hash') {
    store.setVectorDim(config.vector.dim);
  } else {
    store.configureVectors({ id: embedder.id, dim: embedder.dim || 0, embed: null });
  }
  const metrics = createMetrics({ clock: platform.now });
  const state = createWiringState({ platform, store, config, metrics, embedder, seats });
  // v0.4.12：人格卡只在 apply 时加载一次（不做热加载）；失败回落内置卡并 warn。
  applyPersonaCard(state, hooks);
  // V3-H2：先把上次进程崩溃时残留的 delivering 提醒收回 pending，避免永久卡住。
  recoverReminderDeliveries(state);
  if (embedder !== null && embedder.kind === 'remote') {
    // W4：remote 会把原文发到第三方，启动时必须显式告警（隐私例外见 docs/embedding.md）。
    platform.log('warn', '[dsh-companion] vector.embedder=remote enabled; memory text will be sent to a third party', {
      host: embedder.host ?? '',
      timeoutMs: embedder.timeoutMs,
    });
  }
  // E-M1：local 模型异步预热（首次下载/ONNX 初始化），不阻塞首轮 turn；
  // 失败只记日志/指标，召回本轮回退 FTS，idle-probe 按退避重试。
  prewarmEmbedder(state);

  // C5-H2：llm 服务由 dsh-base 晚注册（启动时 undefined，约 30 秒后才可用）。
  // 这里只做一次非阻塞预热，让 /状态 尽早拿到真实 provider/model；能力与路由在
  // 每次使用时仍会重新解析，启动瞬间的否定结果不会被固化。
  void resolveLlmRoute(state).catch((error) => {
    platform.log('debug', '[dsh-companion] llm route prewarm failed', {
      message: errorMessage(error),
    });
  });

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
    state.pendingCompact = recoverPendingCompacts(store);
    state.watermarkSeq = initialWatermark(store, SCOPE);
    state.watermarkByScope.set(SCOPE, state.watermarkSeq);
    // H1：surface 索引。优先用 session/event 增量维护；宿主没有该事件时靠
    // readSurface 冷启动回填（每次 O(整段 log)，只在缺失时触发）。
    state.surface = createSurfaceIndex({ platform, tailTokens: state.config.retainTokens });
    // V7-H1 审计：session/event 是 Context 事件 API（ctx.on 存在性），不是
    // 晚挂载的 service；监听器又只能在 apply 阶段注册，故这里保留 apply 时判断
    // （capability 由 ctx.on 是否可调用决定，apply 后不会变）。
    if (platform.capabilities.sessionEvent) {
      track(platform.onSessionEvent((session, event) => {
        state.surface.record(session, event);
      }));
    } else {
      platform.log('debug', '[dsh-companion] session/event unavailable; surface index rebuilds on demand');
    }
    publishOnThreadUnarchive(platform, store);

    registerSections(platform, store, track, state.card, state.assembly);
    // V50-M3：情绪句改走宿主动态 context（order 320，避开宿主已用的 100-210）。
    // 仅在卡上启用情绪时注册；宿主缺 context() 时只 warn 一次并降级为不注入，
    // 默认（情绪关闭）路径完全不注册、不读不写库。
    if (state.card?.emotion?.enabled === true) {
      try {
        track(platform.context({
          name: 'companion-emotion',
          order: 320,
          interpolate: false,
          text: (context) => emotionContextText(state, context),
        }));
      } catch (error) {
        platform.log('warn', '[dsh-companion] emotion context unavailable; emotion line disabled', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // P2（v0.5.0）：遮蔽宿主默认人设。off 时连监听器都不注册，默认路径与旧版
    // 完全一致；失败只 warn，不挡装配。
    state.shadowMode = registerDeploymentShadow(platform, config, track, state.card, state.assembly);
    // V7-H1 审计：pre-step 是事件钩子注册（只能在 apply 阶段完成），能力位来自
    // Context 事件 API 而非晚挂载 service，故保留 apply 时判断。
    if (platform.capabilities.preStep) {
      track(platform.onPreStep((payload) => runPreStep(state, payload)));
    }
    // M4：turn 结束时结算本轮 token；没有该事件时由下一次 pre-step 的差值兜底。
    // V7-H1 审计：同上，turnStopping 是事件钩子注册，apply 时决定。
    if (platform.capabilities.turnStopping && typeof platform.onTurnStopping === 'function') {
      track(platform.onTurnStopping((payload) => {
        const usage = measureTokens(state, payload);
        if (usage !== null) recordUsage(state, usage, sessionIdOf(payload));
      }));
    }
    registerCommands(platform, store, config, metrics, track, () => state.currentScope, () => budgetInfo(state), state);
    registerTools(
      platform,
      store,
      config,
      track,
      () => state.currentScope,
      () => toolBudgetGate(state),
      metrics,
      (input) => retrieveVectors(state, input),
      vectorConfig(state),
    );
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
      // v0.6-E2：后台判定可能还在途；apply 回调已加 dispose 守卫，这里再尽力收尾一次，
      // 避免「dispose 后还有 promise 在写库」的假象（不阻塞关闭流程）。
      try {
        const queue = state.appraiserQueue;
        state.appraiserQueue = null;
        if (queue !== null && typeof queue.drain === 'function') {
          Promise.resolve(queue.drain()).catch(() => {});
        }
      } catch {
        // 队列收尾失败不影响资源释放。
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

  // V3-M1：宿主直接销毁 context（cordis `dispose` 事件）时也回收注册，
  // 不依赖调用方是否记得调用 handle.dispose()。
  platform.onDispose(() => {
    handle.dispose();
  });

  INSTALLS.set(host, { handle, store });
  return handle;
}

/**
 * @param {object} input
 * @returns {object}
 */
function createWiringState({ platform, store, config, metrics, embedder = null, seats }) {
  return {
    platform,
    store,
    config,
    metrics,
    /** v0.4.12：启动时加载一次的人格卡（applyPersonaCard 填充），人格段/跟进/闲聊共用。 */
    card: null,
    /** v0.4.12：人格卡加载来源 {card,status,path,reason}；/状态 展示用。 */
    cardSource: null,
    /** P2（v0.5.0）：实际生效的遮蔽模式；/状态 展示用。注册失败时回落 'off'。 */
    shadowMode: 'off',
    /** V50-L3：最近一次装配的只读记录（仅在内存里，只存字数与短哈希）。 */
    assembly: createAssemblyRecord(),
    /** v0.6-E4：判定器来源占比与延迟统计（24h 滑动窗口，只存元数据）。 */
    appraiserStats: createAppraisalStats(),
    /** v0.6-E2：按 scope 单飞的判定队列（llm 模式首次用到时创建）。 */
    appraiserQueue: null,
    /** W4：当前 embedder（关闭向量时为 null）；local/remote 由注入 loader/fetch 构造。 */
    embedder,
    /** W4：本进程已回填的向量条数（/状态 展示）。 */
    vectorBackfilled: 0,
    /** E-M1：local 预热状态标记（'idle' / 'ready' / 最近一次失败键），用于日志去重。 */
    embedderWarmupState: 'idle',
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
    /** M4：测试/宿主可注入内存读数；缺省走 process.memoryUsage()（经 seats 回落）。 */
    rssReader: seats.rssReader,
    /** P1-b：测试/宿主可注入模型钩子；缺省 null（走 adapter 的 llm 能力）。 */
    companion: seats.companion,
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
    /** N-H1：每个 scope 上一版（外部压缩前）的 surface seq，用于识别替换节点。 */
    prevSurfaceSeqsByScope: new Map(),
    /** 巩固水位：最近一次成功巩固的 surface seq；0 = 尚未巩固任何节点。 */
    watermarkSeq: 0,
    /** H3：每个 scope 各自的水位（切换 main/thread 时恢复）。 */
    watermarkByScope: new Map(),
    /** H3：当前 pre-step 路由到的记忆作用域；null=subagent。 */
    currentScope: SCOPE,
    /** H3：最近一次身份路由结果（诊断用）。 */
    currentSession: null,
    /** V3-M2：最近一次解析出的主会话 id（schema_meta 的缓存，提醒投递用）。 */
    mainSessionId: null,
    /** 已注入召回的 turn 集合（同一 scope 的同一 turn 只注入一次）。 */
    turnSeen: new Set(),
    /** 本轮注入的 fact id（H5：下一轮判断是否被用上）。 */
    lastRecalledIds: [],
    /** H5：注入 fact 所属的 scope；跨 scope 的下一轮不误强化。 */
    lastRecallScope: SCOPE,
    /** 注入时转录里最近一条 assistant 文本 / assistant 条数，用于判断是否出现新回复。 */
    lastRecallAssistant: '',
    assistantCountAtRecall: 0,
    /**
     * v8/S-M1：本批注入样本（id → {at, tier, sameContext}）。v9 起 sameContext
     * 只描述本次注入的对照口径；「用上」时另按用上时刻重算 used_same_context。
     */
    lastRecallSamples: new Map(),
    /**
     * v0.4.2/L-4：本批注入的实际档位（id → clear/ambiguous/miss）。index 档
     * 也记（miss），只供「用上」时写 first_used_tier，不写 recall 样本。
     */
    lastRecallTiers: new Map(),
    /** 最近一段转录（用于巩固模型草稿）；当前激活 scope 的视图。 */
    transcript: [],
    /** H3：每个 scope 各自的转录，切换会话时恢复，避免跨会话串味。 */
    transcriptByScope: new Map(),
    transcriptScope: SCOPE,
    /**
     * V50-M3：每个 scope 最近一次算好的情绪句（`你此刻：…`）。由 systemPrompt.context
     * 在装配时读取，不再造 user 消息；未算过/已关闭时没有值。
     */
    emotionTextByScope: new Map(),
    lastHumanAt: null,
    tokens: 0,
    overCount: 0,
    /** N-M1：每个 scope 一个待压缩槽，跨 scope 不再互相覆盖。 */
    pendingCompact: createPendingCompacts(),
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
    /**
     * G0-9：最近一次压缩/巩固实际执行的耗时（毫秒，失败样本也记录，只用于
     * 日志与 /状态 展示）；null 表示还没有样本。
     */
    lastCompactMs: null,
    lastConsolidateMs: null,
    /** G0-9：超阈值 warn 去重标记；同类出现一次不超过阈值的样本后重置。 */
    compactSlowWarned: false,
    consolidateSlowWarned: false,
    /** P2-b：最近一次召回注入里由向量路命中并实际注入的条数。 */
    lastVectorHits: 0,
    /** dispose 后后台任务不再碰已关闭的 Store。 */
    disposed: false,
    // C5-H2：模型路由每次按需重新解析（否定结果不缓存）；成功路由带版本/时间。
    llmRoute: null,
    llmRouteProbed: false,
    llmRouteRefreshing: false,
    llmRoutePromise: null,
    llmRouteLastAttemptAt: null,
    /** V6-L3：llm 发现失败按原因去重；成功解析出路由后清空。 */
    llmDiscoveryWarnReasons: new Set(),
    lastNoModelFailureAt: null,
    /** C5-M2：同一 skip 原因只 warn 一次；巩固真正继续时清空。 */
    skipWarnReason: null,
    /** C5-M2：同一投递失败原因只 warn 一次；恢复成功后清空。 */
    deliveryWarnReason: null,
    /** P1-b：闲聊模型单独解析/缓存，不复用巩固模型（提示词与输出都不同）。 */
    chatLlm: null,
    chatLlmRoute: null,
    warnedNoChatLlm: false,
  };
}

/**
 * 启动时加载一次人格卡（v0.4.12），结果放进 state.card / state.cardSource。
 *
 * 加载失败绝不阻断 apply：回落到内置卡，写一条 warn（含解析后路径与原因，
 * 不含卡正文）；/状态 会显示「加载失败，已用内置：<原因>」。改卡需重启。
 *
 * @param {object} state
 * @param {Record<string, unknown>} [hooks] 测试席位；`hooks.personaDeps` 可注入
 *   loadPersonaCard 的 env/homedir（生产不传时读 process.env 与 os.homedir()）
 */
function applyPersonaCard(state, hooks = {}) {
  const { platform, config } = state;
  const loaded = loadPersonaCard(config.persona?.cardPath ?? null, hooks.personaDeps ?? {});
  state.card = loaded.card;
  state.cardSource = loaded;

  if (loaded.status === CARD_STATUS.FALLBACK) {
    platform.log('warn', '[dsh-companion] persona card load failed; using built-in card', {
      path: loaded.path,
      reason: loaded.reason,
    });
    // 不 return：兜底用的也是内置卡，proactive 同名字段同样会被配置覆盖，继续比较。
  }

  // 本版 proactive 行为以配置为准（不改行为），两边不一致时只 warn 提醒去重。
  // 内置卡也参与比较：内置 proactive 值等于默认配置，只有用户改了配置才会不一致，
  // 此时正需要提醒「卡里的同名字段被配置覆盖」。
  const conflicts = personaProactiveConflicts(loaded.card, config);
  if (conflicts.length > 0) logProactiveConflicts(platform, config, loaded, conflicts);

  // chatPerDay 在配置里没有对应键，只做一次 debug 说明（不告警）。
  if (loaded.status === CARD_STATUS.FILE && Object.hasOwn(loaded.card.proactive ?? {}, 'chatPerDay')) {
    platform.log('debug', '[dsh-companion] persona card proactive.chatPerDay has no config counterpart; card value kept', {
      path: loaded.path,
      chatPerDay: loaded.card.proactive.chatPerDay,
    });
  }

  // v0.5.0（P1）：段被截断不静默——每条一条 warn，只带段名与码点数，不带正文。
  for (const warning of buildSectionsWithDiagnostics(loaded.card).warnings) {
    platform.log('warn', '[dsh-companion] persona section truncated; text clipped to limit', {
      section: warning.section,
      chars: warning.chars,
      max: warning.max,
    });
  }

  // 导入期诊断（如 CCv2/v3 的 character_book 被忽略、模板占位符被降级）；
  // detail 只放名字/字段名，不含正文。
  for (const warning of loaded.warnings ?? []) {
    platform.log('warn', '[dsh-companion] persona card import warning', {
      code: warning.code,
      path: loaded.path,
      detail: warning.detail,
    });
  }
}

/**
 * proactive 冲突告警（v0.4.12）。
 *
 * 文件卡沿用既有英文事件文案（meta 带解析后路径与字段）；内置卡/兜底卡用中文
 * 说明并带上两边取值——只有用户改过配置才会触发，用于提醒卡里的 proactive
 * 同名字段会被配置覆盖（本版以配置为准，行为不变）。
 *
 * @param {object} platform
 * @param {object} config 归一化后的配置（含 proactiveDailyCap/quietStart/quietEnd）
 * @param {{card: object, status: string, path: string|null}} loaded
 * @param {Array<{cardField: string, configField: string}>} conflicts
 */
function logProactiveConflicts(platform, config, loaded, conflicts) {
  const fields = conflicts.map((item) => `proactive.${item.cardField}≠${item.configField}`);
  if (loaded.status === CARD_STATUS.FILE) {
    platform.log('warn', '[dsh-companion] persona card proactive settings conflict with config; config wins', {
      path: loaded.path,
      fields,
    });
    return;
  }
  const details = conflicts.map((item) => (
    `proactive.${item.cardField}=${String(loaded.card.proactive[item.cardField])}`
    + ` 与配置 ${item.configField}=${String(config[item.configField])} 不一致`
  ));
  platform.log('warn', `[dsh-companion] 人格卡（内置默认）的 ${details.join('；')}，以配置为准`, {
    path: loaded.path,
    fields,
    source: loaded.status,
  });
}

/**
 * /状态 用的人格卡来源快照；state 未加载过卡（旧调用方）时返回 undefined，
 * 命令层据此不输出「人格卡」行，保持旧输出格式不变。
 * @param {object} [state]
 * @returns {{name: string, version: number, status: string, path: string|null, reason: string|null}|undefined}
 */
function personaStatus(state) {
  if (state?.card === null || state?.card === undefined) return undefined;
  if (state.cardSource === null || state.cardSource === undefined) return undefined;
  return {
    name: state.card.name,
    version: state.card.version,
    status: state.cardSource.status,
    path: state.cardSource.path,
    reason: state.cardSource.reason,
  };
}

// ----------------------------------------------------------- 人格段 / 命令

/**
 * 注册人格三段与状态板段。
 * @param {object} platform
 * @param {Store} store
 * @param {(disposer: Function) => void} track
 * @param {Readonly<object>} card 启动时加载一次的人格卡（state.card）
 */
function registerSections(platform, store, track, card, record) {
  // V7-H1 审计：systemPrompt 是声明的 inject，cordis 在 apply 前就绪；段注册
  // 也只能在 apply 阶段完成，故保留 apply 时判断（不存在晚挂载后补注册的路径）。
  if (!platform.capabilities.systemPrompt) return;
  const sections = buildSections(card);
  for (const section of sections) {
    track(platform.section(section));
  }
  track(platform.section({
    name: 'persona:state_board',
    order: 160,
    // V50-M2：状态板正文来自记忆（可能被用户写入含 `{{…}}` 的文本）。宿主的
    // interpolate() 对未注册变量是**整轮抛错**，不是忽略；显式关闭插值，
    // 让状态板永远按字面量进入 system prompt。
    interpolate: false,
    text: () => {
      const published = store.getBoard(SCOPE);
      return published === null || published === undefined ? '' : boardSection(published).text;
    },
  }));
  // V50-L3：只记静态段；状态板是动态段（text 为函数），按设计跳过。
  recordSections(record, sections, typeof platform.now === 'function' ? platform.now() : null);
}

/**
 * P2（v0.5.0）：按配置遮蔽宿主默认人设。
 *
 * 只能走 `system-prompt/assemble` waterfall：宿主 0.4.x 的
 * `deployment:persona-prefix/-suffix` 在全局层注册，同名再注册必抛。
 *
 * @param {object} platform
 * @param {object} config 已归一化的配置
 * @param {(disposer: Function) => void} track
 * @param {Readonly<object>} card 启动时加载一次的人格卡（state.card）
 * @returns {'off'|'rewrite'|'takeover'} 实际生效的模式（注册失败回落 'off'）
 */
function registerDeploymentShadow(platform, config, track, card, record) {
  const mode = config.persona?.shadowDeployment ?? 'off';
  if (mode === 'off') return 'off';
  if (typeof platform.onAssemble !== 'function') {
    platform.log('warn', '[dsh-companion] system-prompt/assemble unavailable; deployment persona shadow disabled', {
      mode,
    });
    return 'off';
  }
  const source = card ?? DEFAULT_CARD;
  const personaText = renderTemplate(source.chatIdentity || DEFAULT_CARD.chatIdentity, {
    name: source.name || DEFAULT_CARD.name,
    address: source.address || DEFAULT_CARD.address,
  });
  const handler = createAssembleHandler({
    mode,
    personaText,
    warn: (message, meta) => platform.log('warn', message, meta),
    onApplied: (info) => recordShadow(record, { ...info, nowMs: platform.now() }),
  });
  const disposer = platform.onAssemble(handler);
  if (typeof disposer !== 'function') {
    platform.log('warn', '[dsh-companion] system-prompt/assemble registration failed; deployment persona shadow disabled', {
      mode,
    });
    return 'off';
  }
  track(disposer);
  platform.log('info', '[dsh-companion] deployment persona shadow enabled', { mode });
  return mode;
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
  // V7-H1 审计：commands 是声明的 inject，apply 前就绪；命令注册只能在 apply
  // 阶段完成，故保留 apply 时判断。命令内部的能力位则在下文按调用时读取。
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
              cwd: typeof platform.cwd === 'function' ? platform.cwd() : undefined,
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
            // V7-H1：每次命令调用时读能力位，不用 apply 时快照（宿主可能晚挂载）。
            threadsSupported: platform.capabilities.threadTools === true,
            // V3-M2：/状态 展示当前主会话与绑定模式。
            mainSession: {
              id: currentMainSessionId(state),
              binding: mainBindingOf(config),
            },
            // V10-H1：/状态 展示线程 preset 来源（配置值或宿主默认）。
            threadAgentPreset: config.thread?.agentPreset ?? null,
            // C5-M1：web-app 默认 compaction-basic disabled:true；能力位 false 时
            // /状态 直接说明原因，并展示待压缩区间数（真开时）。
            compactionSupported: platform.capabilities.compaction,
            pendingCompactions: state.pendingCompact.size,
            // G0-9：/状态 展示最近一次压缩/巩固耗时与「（超阈值）」标注。
            timing: {
              lastCompactMs: state.lastCompactMs,
              lastConsolidateMs: state.lastConsolidateMs,
              compactWarnMs: config.timing?.compactWarnMs,
              consolidateWarnMs: config.timing?.consolidateWarnMs,
            },
            // v0.4.12：/状态 展示人格卡来源（内置默认 / 文件路径 / 加载失败原因）。
            persona: personaStatus(state),
            // P2（v0.5.0）：/状态 展示部署人设的遮蔽状态。
            shadow: { mode: state.shadowMode },
            // P3-c：/状态 展示情绪状态；未启用时命令层只输出「情绪：未启用」。
            emotion: { enabled: state.card?.emotion?.enabled === true },
      // V50-L3：最近一次装配（字数与短哈希，不含正文）。
      assembly: state.assembly,
      // v0.6-E4：判定器模式与近 24h 来源占比/延迟/最近失败；情绪未启用时不输出该行。
      ...(state.card?.emotion?.enabled === true
        ? {
          appraiser: {
            mode: state.card?.emotion?.appraiser === 'llm' ? 'llm' : 'rules',
            stats: state.appraiserStats?.snapshot?.(platform.now()) ?? null,
          },
        }
        : {}),
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
        const metricSnapshot = typeof metrics.snapshot === 'function' ? metrics.snapshot() : {};
        const reanchors = Number(metricSnapshot.watermarkReanchors) || 0;
        // R-M1：外部压缩吞掉未巩固节点时，把丢失量也放进 /状态，便于观测。
        const lostUnconsolidated = Number(metricSnapshot.compactionLostUnconsolidated) || 0;
        const text = alias.name === 'status'
          ? `${withDeliveryFailure(store, result.reply)}\n${formatChatStatus(state, platform.now())}`
            + `\n${formatConsolidationStatus(state, platform.now())}`
            + (reanchors > 0 ? `\n水位重锚：${reanchors} 次` : '')
            + (lostUnconsolidated > 0 ? `\n未巩固被压缩：${lostUnconsolidated} 个节点` : '')
          : result.reply;
        return { kind: 'success', text };
      },
    }));
  }
}

/**
 * 注册 10 个模型工具（9 个来自 createTools + 下方 memory_update）。工具的
 * parameters 已是 JSON Schema，直接按平台裸注册契约补齐 output（宽 schema +
 * 文本 render），不做 defineTool 依赖。线程/任务工具在 execute 里调用时判能力。
 * @param {object} platform
 * @param {Store} store
 * @param {Readonly<Record<string, unknown>>} config
 * @param {(disposer: Function) => void} track
 * @param {() => (string|null)} [currentScope]
 * @param {() => object|undefined} [budgetGate] M4：task_run/thread_run 的预算/内存闸门
 * @param {{inc:Function}} [metrics] 计数器（thread_run 槽位日志/兜底）
 * @param {(input: object) => Promise<object>} [retrieveFn] 带 embedder 的召回入口（缺省用 retrieve）
 * @param {object} [vectorCfg] 召回用的 vector 配置（embedder 不可用时 enabled=false）
 */
function registerTools(platform, store, config, track, currentScope, budgetGate, metrics, retrieveFn, vectorCfg) {
  // V7-H1 审计：tools 是声明的 inject，apply 前就绪；工具注册只能在 apply
  // 阶段完成，故保留 apply 时判断。线程能力见下方 execute 内的调用时判断。
  if (!platform.capabilities.tools) return;
  const tools = createTools({
    store,
    retrieve: typeof retrieveFn === 'function' ? retrieveFn : retrieve,
    registry: threadRegistry,
    platform,
    clock: platform.now,
    cwd: typeof platform.cwd === 'function' ? platform.cwd() : undefined,
    timeZone: config.timezone,
    // V10-H1：线程会话 preset 由配置决定；null 时 thread_run 不传（宿主默认）。
    threadAgentPreset: config.thread?.agentPreset ?? null,
    currentScope,
    budgetGate,
    metrics,
    vector: vectorCfg ?? config.vector,
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
      execute: (args) => {
        // V7-H1：线程/任务工具一律注册，执行时再判能力（宿主可能晚于 apply
        // 挂载 sessionController）；缺失时返回稳定错误对象，不抛未捕获异常。
        if (THREAD_TOOL_NAMES.has(tool.name) && platform.capabilities.threadTools !== true) {
          return threadCapabilityMissing();
        }
        return tool.execute(args ?? {});
      },
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
 * 判断本轮 payload 是否含「真实用户输入」（V3-M2）。
 *
 * latest-user 绑定只认真实输入：runtime-context 注入、召回注入（companion-recall
 * 或 [相关记忆] 前缀）都不算，探针/发布门因此不会抢占 main_session_id。
 *
 * @param {unknown} messages payload.messages
 * @returns {boolean}
 */
function hasRealUserInput(messages) {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    const sourceKind = message.source?.kind;
    if (sourceKind === 'runtime-context' || sourceKind === RECALL_SOURCE_KIND) continue;
    // P3-c：情绪注入也是插件注入，不算用户真实输入。
    if (sourceKind === EMOTION_SOURCE_KIND) continue;
    // V3-L3：中文命令提示也是插件注入，不算用户真实输入（不会抢占主会话绑定）。
    if (sourceKind === COMMAND_HINT_SOURCE_KIND) continue;
    // V7-M3：凭据提示是插件注入，不算用户真实输入。
    if (sourceKind === PRIVACY_HINT_SOURCE_KIND) continue;
    // C5-H1a：插件主动投递（提醒/任务/线程）被宿主记成 user，不重绑主会话。
    if (isCompanionMessage(message)) continue;
    const blocks = Array.isArray(message.content)
      ? message.content
      : (message.type === 'text' ? [message] : []);
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const text = block.text.trim();
      if (
        text === ''
        || text.startsWith(RECALL_MARKER)
        || text.startsWith(EMOTION_PROMPT_PREFIX)
      ) continue;
      return true;
    }
  }
  return false;
}

/**
 * 当前主会话 id（M2）：以 schema_meta 的 main_session_id 为准，缺省回退内存值。
 * 提醒投递与 /状态 都用它，避免再出现字面量 'main'。
 * @param {object} state
 * @returns {string|null}
 */
function currentMainSessionId(state) {
  try {
    const persisted = state.store.getMeta(MAIN_SESSION_META_KEY);
    if (typeof persisted === 'string' && persisted !== '') return persisted;
  } catch {
    // meta 读失败时退回内存快照。
  }
  return typeof state.mainSessionId === 'string' && state.mainSessionId !== '' ? state.mainSessionId : null;
}

/** @param {object} config @returns {'latest-user'|'first'} */
function mainBindingOf(config) {
  return config?.session?.mainBinding ?? MAIN_BINDING_LATEST;
}

/**
 * 启动回收：把上次进程崩溃时残留的 delivering 提醒收回 pending（超上限的过期）。
 * 幂等；没有残留时零写入。
 * @param {object} state
 * @returns {{recovered: number, expired: number}}
 */
function recoverReminderDeliveries(state) {
  try {
    const result = state.store.recoverReminderDeliveries(REMINDER_MAX_DELIVERY_ATTEMPTS);
    if (result.recovered > 0 || result.expired > 0) {
      state.platform.log('info', '[dsh-companion] reminder deliveries recovered on startup', result);
    }
    return result;
  } catch (error) {
    state.platform.log('warn', '[dsh-companion] reminder delivery recovery failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return { recovered: 0, expired: 0 };
  }
}

/**
 * H3：把当前 pre-step 的 agent 路由到 main / thread / subagent。
 * 没有 payload.agent 的旧调用按 main 处理，保持既有测试行为。
 * @param {object} state
 * @param {object} payload
 * @returns {{kind:'main'|'thread'|'subagent', scope:string|null, sessionId:string|null}}
 */
function routeSession(state, payload) {
  if (state === null || typeof state !== 'object') {
    return { kind: 'main', scope: SCOPE, sessionId: null, legacy: true };
  }
  if (payload?.agent === null || payload?.agent === undefined) {
    state.currentSession = { kind: 'main', scope: SCOPE, sessionId: null, legacy: true };
    state.currentScope = SCOPE;
    return state.currentSession;
  }
  let identity;
  try {
    identity = classifySession(payload.agent, {
      store: state.store,
      logger: (level, message, meta) => state.platform.log(level, message, meta),
      binding: mainBindingOf(state.config),
      hasUserInput: hasRealUserInput(payload.messages),
    });
  } catch (error) {
    state.platform?.log?.('warn', '[dsh-companion] session routing failed; fallback to main', {
      message: error instanceof Error ? error.message : String(error),
    });
    identity = { kind: 'main', scope: SCOPE, sessionId: null, legacy: true };
  }
  state.currentSession = identity;
  if (typeof identity.mainSessionId === 'string' && identity.mainSessionId !== '') {
    state.mainSessionId = identity.mainSessionId;
  }
  if (identity.kind === 'subagent') {
    state.currentScope = null;
    state.metrics?.inc?.('subagentSkips');
    state.platform?.log?.('debug', '[dsh-companion] subagent session skipped', {
      sessionId: identity.sessionId,
    });
    return identity;
  }
  state.currentScope = identity.scope ?? SCOPE;
  state.platform?.log?.('debug', '[dsh-companion] session routed', {
    kind: identity.kind,
    scope: state.currentScope,
    sessionId: identity.sessionId,
    threadKey: identity.key ?? null,
    mainSessionId: identity.mainSessionId ?? null,
    mainBinding: mainBindingOf(state.config),
    rebound: identity.rebound === true,
  });
  return identity;
}


/** 水位重锚的持久化键前缀：外部压缩后旧 upto_seq 已失效，重启时要能恢复新锚点。 */
const WATERMARK_ANCHOR_PREFIX = 'watermark_anchor:';

/**
 * 读持久化的水位锚点（N-H1/R-L2）。
 *
 * 约定：正数 = 重锚到的 surface seq；-1 = 已重锚到起点（内存水位 0）。
 * 0 同时被 sleep 写路径用作「清空」（Store 没有 deleteMeta），所以「有效锚点 0」
 * 必须用哨兵 -1 落库，否则重启后会回退到旧 upto_seq，再次 stale、再次归零。
 *
 * @param {{getMeta: Function}} store
 * @param {string} scope
 * @returns {number|null} 正数 seq、-1，或 null（无锚点）
 */
function readWatermarkAnchor(store, scope) {
  try {
    const raw = Number(store.getMeta(`${WATERMARK_ANCHOR_PREFIX}${scope}`));
    return Number.isSafeInteger(raw) && (raw > 0 || raw === -1) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 写/清水位锚点。
 *
 * - 正数：重锚到的 surface seq；
 * - -1：已重锚到起点（内存水位 0），重启时按 0 恢复；
 * - 0/null：清空，回到「最新一条巩固行的 upto_seq」口径。
 *
 * @param {{setMeta: Function}} store
 * @param {string} scope
 * @param {number|null} seq
 */
function writeWatermarkAnchor(store, scope, seq) {
  try {
    store.setMeta(`${WATERMARK_ANCHOR_PREFIX}${scope}`, String(seq ?? 0));
  } catch {
    // 锚点只是恢复优化；写失败最多重启后重锚一次。
  }
}

/** 清掉锚点，回到「最新一条巩固行的 upto_seq」口径。 */
function clearWatermarkAnchor(store, scope) {
  writeWatermarkAnchor(store, scope, null);
}

/**
 * 初始化水位：优先用外部压缩后的重锚值，否则用最新巩固行的 upto_seq。
 *
 * R-L2：锚点 -1 表示「已重锚到起点」，这里还原成内存水位 0（有效锚点），
 * 不能再回退旧 upto_seq；其他值仍按无锚点处理。导出供单测与重启恢复断言。
 *
 * @param {{getWatermark: Function, getMeta: Function}} store
 * @param {string} scope
 * @returns {number}
 */
export function initialWatermark(store, scope) {
  const anchor = readWatermarkAnchor(store, scope);
  if (anchor === -1) return 0;
  if (anchor !== null) return anchor;
  return Number(store.getWatermark(scope)) || 0;
}

/**
 * R-M1/R-L1：按位置计算外部压缩后的重锚点。
 *
 * `previous` / `current` 都是按 surface 位置排列的 seq 列表（不是数值排序）：
 * 1. 旧水位在 `previous` 里的位置之后还有节点从 current 消失 → 这些节点是被外部
 *    压缩吞掉且尚未巩固的内容；此时锚点取替换节点（平台摘要）在 current 里的
 *    前一个节点，让摘要本身进入下一次巩固窗口 `(afterSeq, end]`；
 * 2. 没有丢未巩固内容 → 锚点取替换节点，保持旧语义（摘要不重复巩固）；
 * 3. 认不出替换节点（seq 被重映射）→ 从 current 第一个节点重来；
 * 4. 没有上一版快照 → 0（整段重来，宁可重抽一次，也不能静默断档）。
 *
 * 「替换节点」= current 中按位置第一个不在 previous 里的节点。不能用
 * `Math.min(fresh)`：平台把摘要追加在日志末尾（seq 最大），而重编号场景下
 * 数值最小的 fresh 节点未必在位置最前；巩固窗口只认位置。
 *
 * @param {number[]|null|undefined} previous 上一版 surface seq（按位置）
 * @param {number[]|null|undefined} current 当前 surface seq（按位置）
 * @param {number} watermark 旧水位
 * @returns {{anchor: number, mode: 'no-history'|'replacement'|'replacement-lost'|'remapped', lost: number}}
 */
export function resolveReanchor(previous, current, watermark) {
  const seqs = Array.isArray(current) ? current.filter((seq) => Number.isFinite(seq)) : [];
  const prev = Array.isArray(previous) ? previous.filter((seq) => Number.isFinite(seq)) : [];
  if (seqs.length === 0 || prev.length === 0) {
    return { anchor: 0, mode: 'no-history', lost: 0 };
  }
  const known = new Set(prev);
  const currentSeqs = new Set(seqs);
  const fresh = seqs.filter((seq) => !known.has(seq));
  if (fresh.length === 0) {
    return { anchor: seqs[0], mode: 'remapped', lost: 0 };
  }
  const replacement = fresh[0];
  const replacementIdx = seqs.indexOf(replacement);
  const oldIdx = prev.indexOf(Number(watermark));
  // oldIdx = -1（旧水位也不在上一版里）时按最保守口径：被移除节点全算丢失。
  const lost = prev.filter((seq, index) => index > oldIdx && !currentSeqs.has(seq)).length;
  if (lost > 0) {
    return {
      anchor: replacementIdx > 0 ? seqs[replacementIdx - 1] : 0,
      mode: 'replacement-lost',
      lost,
    };
  }
  return { anchor: replacement, mode: 'replacement', lost: 0 };
}

/**
 * N-H1/R-M1：水位不在当前 surface 时重锚，避免巩固永久停摆或静默丢掉未巩固内容。
 *
 * 平台压缩会把一段节点换成一个**追加在日志末尾的摘要节点**（seq 不在压缩前的
 * surface 里）；重锚位置由 {@link resolveReanchor} 按 surface 位置计算：
 * 压缩越过旧水位时把锚点前挪到替换节点之前（让摘要进入巩固窗口），否则锚在
 * 替换节点之后；无历史归零、seq 重映射时从当前第一个节点重来。
 *
 * @param {object} state
 * @param {string} scope
 * @param {{seqs?: number[]}|null|undefined} snapshot
 * @returns {number} 可用的水位
 */
function ensureWatermark(state, scope, snapshot) {
  const current = watermarkOf(state, scope);
  if (!(current > 0)) return current;
  const seqs = Array.isArray(snapshot?.seqs) ? snapshot.seqs : [];
  if (seqs.length === 0 || seqs.includes(current)) return current;

  const previous = state.prevSurfaceSeqsByScope?.get?.(scope) ?? null;
  const { anchor, mode, lost } = resolveReanchor(previous, seqs, current);

  setWatermark(state, scope, anchor);
  // R-L2：anchor 为 0 时落库写 -1（哨兵），否则重启后会被旧 upto_seq 覆盖。
  writeWatermarkAnchor(state.store, scope, anchor > 0 ? anchor : -1);
  state.metrics.inc('watermarkReanchors');
  if (lost > 0) state.metrics.inc('compactionLostUnconsolidated', lost);
  state.platform.log(
    'warn',
    lost > 0
      ? '[dsh-companion] stale watermark re-anchored after external compaction (compactionLostUnconsolidated)'
      : '[dsh-companion] stale watermark re-anchored after external compaction',
    {
      scope,
      watermark: current,
      anchor,
      mode,
      lost,
      nodes: seqs.length,
    },
  );
  return anchor;
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
    state.watermarkByScope.set(scope, initialWatermark(state.store, scope));
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
  // N-H1：平台自动压缩 / 用户 /compact 会让旧水位从 surface 消失；先重锚再谈巩固，
  // 否则 planRegion 永远返回 stale-watermark，该 scope 静默停摆。
  const snapshotBefore = state.surfaceSnapshotByScope.get(scope) ?? state.surfaceSnapshot;
  const watermarkBefore = watermarkOf(state, scope);
  const anchor = ensureWatermark(state, scope, snapshotBefore);
  if (anchor !== watermarkBefore) {
    // R-M1：外部压缩把旧区间换成了从日志末尾追加的替换节点，正文索引里还没有它；
    // 不回填一次，巩固窗口会因 missing>0 被跳过，平台摘要就永远进不了记忆库。
    const refreshed = await refreshSurface(state, payload, usage?.nodes ?? null, { forceRebuild: true });
    if (refreshed !== null) ensureWatermark(state, scope, refreshed);
  }

  if (isNewTurn) {
    // 先补上一轮写库后未完成的两段式压缩（平台只允许 turn 内压缩）。
    await maybeCompact(state, payload, scope);
    // M3：只登记巩固，立即返回；模型调用在 step 之后由后台任务执行。
    scheduleConsolidation(state, payload, scope);
  }

  const hint = injectCommandHint(state, payload, messages, turnKey);
  const privacy = injectPrivacyHint(state, payload, messages, turnKey);
  // V50-M3：情绪只算不注入，结果由 systemPrompt.context 在装配时取用。
  injectEmotion(state, payload, messages, turnKey, scope);
  const injection = await injectRecall(state, payload, messages, turnKey, scope);
  const hints = [hint, privacy, ...(injection?.inject ?? [])]
    .filter((item) => item !== null);
  if (hints.length === 0) return injection;
  return { ...(injection ?? {}), inject: hints };
}

/**
 * V7-M3：用户消息里含凭据类内容时注入一句给模型的指令。
 *
 * 不做拦截（用户仍能说出口），只要求模型：不复述具体值、不用记忆工具保存，
 * 并在回复里带固定提示。不注入的话，模型很可能把「wifi 密码是 xxx」当成普通
 * 偏好写进记忆工具，而这是用户明确不希望保存的内容。
 *
 * 同一 turn 只注入一次（platform 会把注入消息回灌到后续 step）。
 *
 * @param {object} state
 * @param {object} payload
 * @param {unknown[]} messages
 * @param {string|null} turnKey
 * @returns {{id: string, role: 'user', content: object[], source: object}|null}
 */
function injectPrivacyHint(state, payload, messages, turnKey) {
  const key = `privacy:${sessionIdOf(payload) ?? SCOPE}:${turnKey ?? `step:${String(payload?.step ?? 'unknown')}`}`;
  if (state.turnSeen.has(key)) return null;
  const message = privacyHintMessage(lastUserText(messages));
  if (message === null) return null;
  state.turnSeen.add(key);
  return message;
}

/**
 * 构造凭据提示注入消息（完整平台消息，V3-H1 形状）。
 * @param {unknown} text 用户输入
 * @returns {{id: string, role: 'user', content: object[], source: object}|null}
 */
function privacyHintMessage(text) {
  if (typeof text !== 'string' || text.trim() === '' || !isSensitiveText(text)) return null;
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `${PRIVACY_HINT_TEXT_PREFIX}，请勿复述具体值、不要调用记忆工具保存。请直接回复用户一句：${CREDENTIAL_HINT}`,
    }],
    source: { kind: PRIVACY_HINT_SOURCE_KIND },
  };
}

/**
 * V3-L3：识别用户把中文命令（`/记忆`、`/状态`…）当命令输入的情况，注入一句
 * 提示让模型改用 ASCII 命令名。宿主命令名只允许 ASCII，这类文本会当普通发言
 * 发给模型；不提示的话模型只能猜。
 *
 * 同一 turn 只注入一次（平台会把注入消息回灌到后续 step 的 messages，否则每
 * step 都会重复注入）。提示消息是完整平台消息（V3-H1 形状），source.kind 为
 * `companion-command-hint`，下游转录/巩固按 kind 或固定前缀排除。
 *
 * @param {object} state
 * @param {object} payload
 * @param {unknown[]} messages
 * @param {string|null} turnKey
 * @returns {{id: string, role: 'user', content: object[], source: object}|null}
 */
function injectCommandHint(state, payload, messages, turnKey) {
  const key = `hint:${sessionIdOf(payload) ?? SCOPE}:${turnKey ?? `step:${String(payload?.step ?? 'unknown')}`}`;
  if (state.turnSeen.has(key)) return null;
  const message = commandHintMessage(lastUserText(messages));
  if (message === null) return null;
  state.turnSeen.add(key);
  return message;
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
      const previous = state.surfaceSnapshotByScope.get(state.currentScope);
      if (previous !== null && previous !== undefined && Array.isArray(previous.seqs)
        && previous.seqs.length > 0) {
        state.prevSurfaceSeqsByScope.set(state.currentScope, previous.seqs.slice());
      }
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
 * - 本轮 user 文本是短确认语（整句/独立小句，见 isConfirmation）且复述成立 → α=4，
 *   否则 α=2。不能用子串匹配：`对比一下`、`对话` 都包含「对」。
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
      state.lastRecallSamples = new Map();
      state.lastRecallTiers = new Map();
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
      state.lastRecallSamples = new Map();
      state.lastRecallTiers = new Map();
      state.lastRecallScope = scope;
    }
    return;
  }

  state.lastRecalledIds = [];
  const samples = state.lastRecallSamples instanceof Map ? state.lastRecallSamples : new Map();
  state.lastRecallSamples = new Map();
  const tiers = state.lastRecallTiers instanceof Map ? state.lastRecallTiers : new Map();
  state.lastRecallTiers = new Map();
  const userText = lastUserText(messages);
  const confirmed = isConfirmation(userText);
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
      // v8/S-M1：复述命中即「用上」；v9 起按用上那一刻记录 used 样本。
      markUsedReneed(state, id, fact, at, samples.get(id), tiers.get(id));
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

/**
 * 来源 episode 是否仍在当前 surface（S-M1）。
 *
 * 巩固时 episode 记录 consolidations.upto_seq。该 seq 还在当前 surface 里，
 * 说明原文尚未被压缩替换，召回属于「来源还在上下文里」。
 *
 * @param {object} state
 * @param {string} scope
 * @param {object|null} fact
 * @returns {boolean}
 */
function sourceStillInSurface(state, scope, fact) {
  const episodeId = fact?.source_episode_id;
  if (typeof episodeId !== 'string' || episodeId === '') return false;
  try {
    const episode = state.store?.getEpisode?.(episodeId);
    if (episode === null || episode === undefined || !episode.consolidation_id) return false;
    const consolidation = state.store?.getConsolidation?.(episode.consolidation_id);
    const snapshot = state.surfaceSnapshotByScope?.get?.(scope) ?? state.surfaceSnapshot;
    return episodeSourceInSurface({
      seqs: Array.isArray(snapshot?.seqs) ? snapshot.seqs : null,
      episode,
      consolidation,
    });
  } catch {
    return false;
  }
}

/**
 * 事实的原话时间（L2-1）：same_context 判定与 Δt 统一用 observed_at。
 *
 * 先取来源 episode 兜底（旧库/导入行可能缺 observed_at），再交给
 * resolveObservedAt 按口径顺序取值。取不到时返回 null，由调用方保守处理。
 *
 * @param {object} state
 * @param {object|null} fact
 * @returns {number|null}
 */
function factOriginTime(state, fact) {
  let episode = null;
  const episodeId = fact?.source_episode_id;
  if (typeof episodeId === 'string' && episodeId !== '') {
    try {
      episode = state.store?.getEpisode?.(episodeId) ?? null;
    } catch {
      episode = null;
    }
  }
  return resolveObservedAt({ fact, episode });
}

/**
 * v9/S2-M1：把「用上」写进 used 样本。first_reneed_* 保持 recall 样本不动；
 * 时间/档位/同会话都以「用上那一刻」为准，same_context 用 observed_at 当场
 * 重算（L2-1），不再沿用首次注入时的旧值。
 *
 * @param {object} state
 * @param {string} id
 * @param {object|null} fact
 * @param {number} atSeconds 本轮强化时刻（Unix 秒）
 * @param {{at?: number, tier?: string, sameContext?: boolean}|undefined} sample
 * @param {string|undefined} injectionTier 本轮注入的实际档位（L-4，含 index 档
 *   的 miss）；取不到时退回 sample.tier，再退回库内 fact.fidelity 兜底
 */
function markUsedReneed(state, id, fact, atSeconds, sample, injectionTier) {
  const store = state.store;
  if (store === null || store === undefined || typeof store.markReneedUsed !== 'function') return;
  let tier = injectionTier;
  if (tier !== 'clear' && tier !== 'ambiguous' && tier !== 'miss') {
    tier = sample?.tier;
  }
  if (tier !== 'clear' && tier !== 'ambiguous' && tier !== 'miss') {
    // 兜底：本轮注入档位未记到（旧状态/直接调用），只能用库内 fidelity 猜。
    tier = fact?.fidelity === 'gist' ? 'ambiguous' : 'clear';
    if (fact?.fidelity === 'index') tier = 'miss';
  }
  const sameContext = isSameContextSample({
    at: atSeconds,
    createdAt: factOriginTime(state, fact),
    sourceInSurface: sourceStillInSurface(state, state.lastRecallScope ?? SCOPE, fact),
  });
  try {
    store.markReneedUsed(id, { at: atSeconds, tier, sameContext });
  } catch (error) {
    // 埋点失败不影响强化结果。
    state.platform.log('warn', '[dsh-companion] mark used reneed failed', {
      id,
      message: error instanceof Error ? error.message : String(error),
    });
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
 * E-M1：异步预热 local embedding。启动与 idle-probe 触发，绝不 await 在 turn 路径上。
 * 失败只记 metric 与日志：transient 由 idle-probe 按指数退避重试；
 * fatal（ERR_MODULE_NOT_FOUND / Cannot find module）停用 local，召回保持纯 FTS。
 * @param {object} state
 */
function prewarmEmbedder(state) {
  const { embedder, platform } = state;
  if (embedder === null || embedder === undefined || typeof embedder.warmup !== 'function') return;
  if (embedder.disabled === true) return;
  let pending;
  try {
    pending = embedder.warmup();
  } catch (error) {
    pending = Promise.reject(error);
  }
  Promise.resolve(pending).then(
    () => {
      if (state.embedderWarmupState === 'ready') return;
      state.embedderWarmupState = 'ready';
      platform.log('info', '[dsh-companion] local embedding model ready', {
        embedder: embedder.id,
        timeoutMs: embedder.timeoutMs,
      });
    },
    (error) => {
      const kind = error?.kind ?? (error?.fatal === true ? 'fatal' : 'transient');
      state.metrics.inc('vectorEmbedLoadFailures');
      if (kind === 'fatal') state.metrics.inc('vectorEmbedFatal');
      const key = `${kind}:${error?.code ?? ''}:${error?.message ?? ''}`;
      // 同一错误只记一次日志，避免 idle-probe 每 60s 刷屏；恢复由成功分支复位。
      if (state.embedderWarmupState === key) return;
      state.embedderWarmupState = key;
      platform.log(kind === 'fatal' ? 'warn' : 'info',
        '[dsh-companion] local embedding warmup failed; recall falls back to FTS', {
          embedder: embedder.id,
          kind,
          code: error?.code ?? null,
          reason: error?.message ?? String(error),
          retryAt: typeof embedder.state === 'function' ? embedder.state().nextRetryAt : 0,
        });
    },
  );
}

/**
 * W4：召回用的 vector 配置。embedder 未装配（关闭、none、remote 未启用、
 * local 未安装）时强制 enabled=false，走纯 FTS，避免拿错维度/旧向量。
 * @param {object} state
 * @returns {object}
 */
function vectorConfig(state) {
  if (state.embedder !== null && state.embedder !== undefined) return state.config.vector;
  return { ...state.config.vector, enabled: false };
}

/**
 * W4：带 embedder 的召回入口。embedding 失败（未安装/超时/网络）只记 metric
 * 并退回纯 FTS，绝不阻塞当前 turn。
 * E-M1：local 依赖未安装（fatal，已停用）时直接走纯 FTS，不再每轮尝试。
 * @param {object} state
 * 导出仅供回归测试直接验证「占用只记 busy」的指标口径；属于内部 API，
 * 不承诺对外稳定。
 *
 * @param {object} input retrieve() 参数
 * @returns {Promise<object>}
 */
export async function retrieveVectors(state, input) {
  const disabled = state.embedder !== null
    && state.embedder !== undefined
    && state.embedder.disabled === true;
  const result = disabled
    ? await retrieve({
      ...input,
      embedder: null,
      vector: { ...(input.vector ?? state.config.vector), enabled: false },
      recall: input.recall ?? state.config?.recall ?? null,
    })
    : await retrieve({
      ...input,
      embedder: state.embedder,
      recall: input.recall ?? state.config?.recall ?? null,
    });
  if (result !== null && typeof result === 'object' && result.vectorError) {
    if (result.vectorError.code === 'EMBEDDING_BUSY') {
      // L-1：占用不是失败（回填推理仍在跑，下一轮会好），只记 busy；与
      // docs/embedding.md 口径一致，回填占用期不虚增 failures、不打 warn。
      state.metrics.inc('vectorEmbedBusy');
      state.platform.log('debug', '[dsh-companion] embedding busy; falling back to FTS', result.vectorError);
    } else {
      state.metrics.inc('vectorEmbedFailures');
      state.platform.log('warn', '[dsh-companion] embedding failed; falling back to FTS', result.vectorError);
    }
  }
  return result;
}

/**
 * W4：空闲回填本批（≤backfillBatchSize）缺失/不匹配的向量。
 * E-M1：local 尚未预热完成时不占用 idle-probe，只触发/续接预热。
 * E2-M1：回填用 embedder.embedBackfill（backfillTimeoutMs），与查询超时分离；
 * 同一 embedder 已有推理在跑时跳过本 tick 并记 vectorEmbedBusy，不排队叠加。
 * 失败只记 metric 与 warn，不抛出，不阻塞 idle-probe。
 * @param {object} state
 * @returns {Promise<number>} 本批写入条数
 */
export async function backfillVectors(state) {
  const { store, embedder, config, metrics, platform } = state;
  if (config.vector.enabled !== true || embedder === null || embedder.kind === 'hash') return 0;
  if (typeof embedder.status === 'function' && embedder.status() !== 'ready') {
    prewarmEmbedder(state);
    return 0;
  }
  // E2-M1：上一次超时的推理在底层结束前仍算占用——本 tick 直接跳过。
  if (typeof embedder.busy === 'function' && embedder.busy()) {
    metrics.inc('vectorEmbedBusy');
    return 0;
  }
  let written = 0;
  try {
    const rows = store.listVectorBackfill({
      embedderId: embedder.id,
      dim: embedder.dim || 0,
      limit: config.vector.backfillBatchSize,
    });
    if (rows.length === 0) return 0;
    const embedBatch = typeof embedder.embedBackfill === 'function'
      ? embedder.embedBackfill.bind(embedder)
      : embedder.embed.bind(embedder);
    const vectors = await embedBatch(rows.map((row) => row.text));
    if (!Array.isArray(vectors) || vectors.length !== rows.length) {
      throw new Error(
        `[dsh-companion] embedder returned ${Array.isArray(vectors) ? vectors.length : 'non-array'} vectors for ${rows.length} texts`,
      );
    }
    for (let i = 0; i < rows.length; i += 1) {
      const vec = vectors[i];
      if (!(vec instanceof Float32Array) || vec.length === 0) continue;
      const saved = store.upsertFactVector({
        factId: rows[i].id,
        vec,
        embedderId: embedder.id,
      });
      if (saved !== null) written += 1;
    }
    if (written > 0) {
      state.vectorBackfilled += written;
      metrics.inc('vectorBackfilled', written);
    }
  } catch (error) {
    const code = error?.code ?? null;
    if (code === 'EMBEDDING_TIMEOUT') {
      metrics.inc('vectorBackfillTimeouts');
    } else if (code === 'EMBEDDING_BUSY') {
      // 竞态下仍可能撞上刚起的推理；本批跳过，下一 tick 再试。
      metrics.inc('vectorEmbedBusy');
      return written;
    }
    metrics.inc('vectorEmbedFailures');
    platform.log('warn', '[dsh-companion] vector backfill failed', {
      code,
      reason: error?.message ?? String(error),
    });
  }
  return written;
}

/**
 * 命令层预算快照（/成本、/状态用）。
 * @param {object} state
 * @returns {object}
 */
function budgetInfo(state) {
  refreshBudget(state);
  const rssLimits = rssLimitsFromConfig(state.config).gib;
  const metricsSnapshot = typeof state.metrics?.snapshot === 'function'
    ? state.metrics.snapshot()
    : {};
  return {
    dailyTokens: state.budget.dailyTokens,
    dailyLimit: DAILY_TOKEN_LIMIT,
    tripped: state.budgetTripped,
    rssLevel: state.rss.level,
    rssLevelCode: state.rss.code,
    rssMB: state.rss.rssMB,
    rssLimits: {
      warnGiB: rssLimits.warn,
      stopGiB: rssLimits.stop_dispatch,
      mainOnlyGiB: rssLimits.main_only,
    },
    vector: {
      enabled: state.embedder !== null && state.embedder !== undefined,
      dim: state.embedder === null ? state.config.vector.dim : state.embedder.dim,
      embedder: state.embedder?.id ?? null,
      backfilled: state.vectorBackfilled,
      lastHits: state.lastVectorHits,
      backfillTimeouts: metricsSnapshot.vectorBackfillTimeouts ?? 0,
      embedBusy: metricsSnapshot.vectorEmbedBusy ?? 0,
    },
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
  const limits = rssLimitsFromConfig(state.config).bytes;
  let result;
  try {
    const source = state.rssReader === null ? { limits } : { rssReader: state.rssReader, limits };
    result = checkMemory(source);
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

  // V3-H1：召回注入块也会作为 user/message 出现在 surface 上；选区文本里
  // 清掉它，避免把注入块当用户发言巩固（seqs/nodes 不动，token 口径不变）。
  const snapshot = withoutRecallRecords(state.surfaceSnapshotByScope.get(scope) ?? state.surfaceSnapshot);
  // N1：登记时就把当前选区的文本与边界固定下来，后台任务执行时仍会按
  // 最新水位重算；只有边界完全一致才复用这份文本，避免选区漂移。
  const { region } = planRegion(snapshot, {
    afterSeq: ensureWatermark(state, scope, snapshot),
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

/** C5-M2：跳过原因只在变化时告警，避免每 tick 刷屏。 */
function warnSkipOnce(state, reason, message, meta) {
  if (state.skipWarnReason === reason) return;
  state.skipWarnReason = reason;
  state.platform.log('warn', message, { reason, ...meta });
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
  // G0-9：巩固耗时从任务入口计到 consolidate() 返回/抛错（含选区与模型解析）。
  // 只观测，不设超时；无窗口/无模型等早退不算一次执行，不采样。
  const consolidationStartedMs = nowMs(platform.now);
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
    // V3-H1：登记时已过滤；重试/旧快照再兜一次（幂等）。
    const snapshot = withoutRecallRecords(job.snapshot);
    if (snapshot === null || snapshot === undefined) return;
    const watermark = ensureWatermark(state, job.scope, snapshot);
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
      // C5-M2：web 宿主只显示 info+，跳过原因用 warn；同一原因只在状态变化时打一次。
      warnSkipOnce(state, 'surface-incomplete', '[dsh-companion] consolidation skipped: surface text incomplete', {
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
    // C5-M2：跳过原因升到 warn，并按原因去重；/状态 的「无可用模型」不受影响。
    warnSkipOnce(state, 'no-llm', '[dsh-companion] consolidation skipped: no model available', {
      scope: job.scope,
    });
    return;
  }
  // 真正继续巩固即状态变化，下一次跳过可以再告警。
  state.skipWarnReason = null;

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
      // V7-L2：duration_ms 用平台毫秒时钟（测试注入的假时钟也可控）。
      clock: platform.now,
      trigger: job.trigger,
      sessionId: job.sessionId,
      // 窗口已在 surface 层选好；水位推进允许跨过旧值。
      guardWatermark: false,
    });
    // G0-9：成功样本（含 skipped；耗时口径见函数入口注释）。采样/告警失败不影响主流程。
    recordTimingSample(state, 'consolidate', elapsedMs(platform.now, consolidationStartedMs), {
      ok: true,
      warnMs: config.timing?.consolidateWarnMs,
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
    setPendingCompact(state.pendingCompact, {
      id: consolidation?.id ?? null,
      startSeq,
      endSeq,
      scope: job.scope,
    });
    setWatermark(state, job.scope, endSeq);
    clearWatermarkAnchor(state.store, job.scope);
    state.consolidationRetry = null;
    metrics.inc('consolidations');
    const sensitive = Number(result.sensitive) || 0;
    const notice = typeof result.notice === 'string' && result.notice !== '' ? result.notice : null;
    state.lastConsolidationResult = {
      ok: true,
      scope: job.scope,
      trigger: job.trigger,
      upto_seq: result.upto_seq,
      sensitive,
      notice,
    };
    platform.log(sensitive > 0 ? 'warn' : 'info', '[dsh-companion] consolidation written', {
      upto_seq: result.upto_seq,
      facts: result.facts ?? 0,
      sensitive,
      notice,
      trigger: job.trigger,
    });
    if (notice !== null) {
      // V7-M3：凭据类内容未落库，回执里给用户同一句建议。
      platform.log('info', '[dsh-companion] credential content skipped', {
        scope: job.scope,
        sensitive,
        notice,
      });
    }
  } catch (error) {
    const message = errorMessage(error);
    // G0-9：失败样本也记录耗时（只用于日志）；不影响下面的失败登记与重试。
    recordTimingSample(state, 'consolidate', elapsedMs(platform.now, consolidationStartedMs), {
      ok: false,
      warnMs: config.timing?.consolidateWarnMs,
    });
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
  const { platform, store, config } = state;
  const pending = peekPendingCompact(state.pendingCompact, scope);
  if (pending === null) return;
  if (!platform.capabilities.compaction) {
    platform.log('debug', '[dsh-companion] compaction unavailable; keeping pending_compact');
    return;
  }

  const snapshot = await refreshSurface(state, payload);
  if (snapshot === null) return;
  const seqs = snapshot.seqs;
  let startIdx = seqs.indexOf(pending.startSeq);
  const endIdx = seqs.indexOf(pending.endSeq);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    // 区间已不在当前 surface（被别的压缩替换 / 会话切换）：丢弃，不重试旧 seq。
    platform.log('warn', '[dsh-companion] pending compaction region expired; dropping', {
      startSeq: pending.startSeq,
      endSeq: pending.endSeq,
      nodes: seqs.length,
    });
    takePendingCompact(state.pendingCompact, scope);
    state.metrics.inc('compactionDrops');
    return;
  }

  // V7-M1：旧 pending 可能把起点记在 surface 节点 0（系统提示词）上，宿主会拒绝
  // 替换。所有 compactRegion 调用点都先做同一道收紧：跳过系统节点，区间为空就丢弃。
  const fencedIdx = firstReplaceableIndex(snapshot, startIdx);
  if (fencedIdx > endIdx) {
    platform.log('warn', '[dsh-companion] pending compaction region has no replaceable node; dropping', {
      startSeq: pending.startSeq,
      endSeq: pending.endSeq,
      nodes: seqs.length,
    });
    takePendingCompact(state.pendingCompact, scope);
    state.metrics.inc('compactionDrops');
    return;
  }
  startIdx = fencedIdx;

  const start = seqs[startIdx];
  const end = seqs[endIdx];
  // V7-L2：压缩耗时用平台毫秒时钟单独计时；事件时间戳仍是秒级。
  const startedMs = platform.now();
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
    takePendingCompact(state.pendingCompact, scope);
    clearWatermarkAnchor(state.store, scope);
    const revision = publishBoard(store, scope, 'compact');

    // V7-L2：压缩完成事件带毫秒耗时（detail.kind='compaction' 与巩固事件区分）。
    // 审计写失败不影响已成功的压缩。
    const durationMs = Math.max(0, Math.round(platform.now() - startedMs));
    // G0-9：压缩耗时口径 = compactRegion 调用 + 之后的重读 surface/写库/发布看板；
    // 只观测，不设超时（失败样本在 catch 里记录）。
    recordTimingSample(state, 'compact', durationMs, {
      ok: true,
      warnMs: config.timing?.compactWarnMs,
    });
    try {
      store.appendEvent({
        at: Math.floor(platform.now() / 1000),
        action: 'UPDATE',
        table_name: 'compactions',
        row_id: pending.id ?? null,
        actor: 'consolidator',
        reason: 'compaction',
        detail_json: {
          kind: 'compaction',
          start,
          end,
          watermark,
          duration_ms: durationMs,
        },
      });
    } catch (error) {
      platform.log('warn', '[dsh-companion] compaction event write failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    platform.log('info', '[dsh-companion] compacted and published state board', {
      start,
      end,
      watermark,
      revision,
      durationMs,
    });
  } catch (error) {
    state.metrics.inc('compactionFailures');
    // G0-9：失败样本也记录耗时（只用于日志），压缩仍保持 pending_compact、不中止。
    recordTimingSample(state, 'compact', elapsedMs(platform.now, startedMs), {
      ok: false,
      warnMs: config.timing?.compactWarnMs,
    });
    platform.log('warn', '[dsh-companion] compactRegion failed; keeping pending_compact', {
      start,
      end,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * P3-c 情绪计算：读库 → 衰减/节律/安静时段 → 分类事件 → 落库 → 描述，把结果
 * 暂存到 state.emotionTextByScope，由 systemPrompt.context 在装配时读取；不再
 * 造 user 消息。同一 turn 只算一次。卡上 `emotion.enabled !== true` 时清空该
 * scope 的旧句并返回 null，不读也不写库，保证默认路径与接入前完全一致。
 *
 * 写入失败的 warn 口径与 injectRecall 一致：只记录，不影响本轮对话。
 *
 * @param {object} state
 * @param {object} payload
 * @param {unknown[]} messages
 * @param {string|null} turnKey
 * @param {string} [scope]
 * @returns {null}
 */
function injectEmotion(state, payload, messages, turnKey, scope = SCOPE) {
  if (state.card?.emotion?.enabled !== true) {
    state.emotionTextByScope?.delete(scope);
    return null;
  }

  const { platform, config, store } = state;
  const key = `emotion:${sessionIdOf(payload) ?? scope}:${turnKey ?? `step:${String(payload?.step ?? 'unknown')}`}`;
  if (state.turnSeen.has(key)) return null;
  if (isToolTail(messages)) {
    state.turnSeen.add(key);
    return null;
  }
  const text = lastUserText(messages);
  if (text === '') return null;
  // v0.6-E2：斜杠命令不判定（既不写事件、也不发模型请求）——命令不是对话内容。
  if (text.trimStart().startsWith('/')) {
    state.turnSeen.add(key);
    return null;
  }
  state.turnSeen.add(key);

  try {
    const now = platform.now();
    const parts = zonedParts(now, config.timezone);
    const quiet = isQuietAt(new Date(now), config);
    const llmMode = state.card?.emotion?.appraiser === 'llm';

    // v0.6-E2：llm 模式下 pre-step 只做「衰减 + 描述」，立刻返回不等模型；
    // 判定在后台进行，结果到达后由 applyClassifiedEvent 单独落库，下一轮生效。
    const result = runEmotionTurn({
      store,
      card: state.card,
      config,
      now,
      hour: parts.hour,
      minute: parts.minute,
      quiet,
      scope,
      text,
      skipEvent: llmMode,
      note: llmMode ? undefined : 'rules',
    });
    state.emotionTextByScope?.set(scope, `${EMOTION_PROMPT_PREFIX}${result.line}`);
    if (llmMode) {
      submitAppraisal(state, {
        scope,
        text,
        lastReply: lastAssistantText(state.transcriptByScope?.get(scope) ?? []),
        now,
        hour: parts.hour,
        minute: parts.minute,
        quiet,
      });
    }
    return null;
  } catch (error) {
    platform.log('warn', '[dsh-companion] emotion injection failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}


/**
 * 判定模型路由：卡内显式 {provider, model} 优先，否则复用共识模型解析。
 * @param {object} state
 * @returns {Promise<{provider: string, model: string, source: string}|null>}
 */
async function resolveAppraiserRoute(state) {
  const configured = state.card?.emotion?.appraiseModel ?? null;
  if (configured !== null && typeof configured.provider === 'string' && typeof configured.model === 'string') {
    return { provider: configured.provider, model: configured.model, source: 'card' };
  }
  const route = await resolveLlmRoute(state);
  if (route === null || typeof route.provider !== 'string') return null;
  return route;
}

/**
 * 判定 token 计入每日预算（与 recordTurnUsage 同一本账，v0.6-E4）。
 * 用「输入码点 + 输出码点」估算，宁可高估不低估。
 */
function recordAppraisalUsage(state, promptText, replyText) {
  // 码点计数（与文档口径一致）：代理对算 1 个，而不是 String#length 的 2 个。
  const codepoints = (text) => (typeof text === 'string' ? [...text].length : 0);
  const estimate = Math.ceil((codepoints(promptText) + codepoints(replyText)) / 2);
  if (estimate <= 0) return;
  recordTurnUsage(state.budget, estimate, {
    at: state.platform.now(),
    timezone: state.config.timezone,
  });
  refreshBudget(state);
}

/**
 * 惰性创建判定队列（每 scope 至多 1 在途 + 1 排队）。
 * @param {object} state
 * @returns {object}
 */
function ensureAppraiserQueue(state) {
  if (state.appraiserQueue !== null) return state.appraiserQueue;
  const timeoutMs = state.card?.emotion?.appraiseTimeoutMs ?? 8000;
  state.appraiserQueue = createAppraisalQueue({
    timeoutMs,
    classifyRules: (text) => classifyRulesOnly(state, text),
    canCall: () => state.disposed !== true && state.budgetTripped !== true,
    now: () => state.platform.now(),
    log: (level, message, meta) => state.platform.log(level, message, meta),
    onSample: (sample) => {
      state.appraiserStats?.record?.(sample);
    },
    judge: async (item) => {
      const route = await resolveAppraiserRoute(state);
      if (route === null) throw new AppraisalError(APPRAISAL_ERRORS.nollm);
      const messages = buildAppraisalMessages({
        text: item.text,
        lastReply: item.lastReply,
        cardName: state.card?.name,
      });
      const raw = await state.platform.complete({ provider: route.provider, model: route.model, messages });
      recordAppraisalUsage(state, JSON.stringify(messages), raw);
      return raw;
    },
    apply: async (item, verdict, source) => {
      // dispose 之后不再写库（store 可能已 close）。
      if (state.disposed) return;
      // E1：模型只给 0..1 的强度，物理力度沿用 0.5–1.5 的既有映射（0.5 + intensity），
      // 与强度来自规则时的 intensityFor 同一区间，物理参数不变。
      const intensity = Number.isFinite(verdict?.intensity)
        ? Math.min(1.5, Math.max(0.5, 0.5 + verdict.intensity))
        : undefined;
      applyClassifiedEvent({
        store: state.store,
        card: state.card,
        scope: item.scope,
        classified: verdict,
        intensity,
        note: source,
        now: state.platform.now(),
        hour: zonedParts(state.platform.now(), state.config.timezone).hour,
        minute: zonedParts(state.platform.now(), state.config.timezone).minute,
        quiet: isQuietAt(new Date(state.platform.now()), state.config),
      });
    },
  });
  return state.appraiserQueue;
}

/**
 * 规则兜底入口（复用 v0.5.2 分类器，不看卡名以外的上下文）。
 * @param {object} state
 * @param {string} text
 * @returns {{type: string, confidence: number}}
 */
function classifyRulesOnly(state, text) {
  return classifyEmotion(typeof text === 'string' ? text : '', { name: state.card?.name });
}

/**
 * 提交一次后台判定；队列不可用时静默放弃（本轮已按规则写入衰减）。
 * @param {object} state
 * @param {{scope: string, text: string, lastReply: string, now: number, hour: number, minute: number, quiet: boolean}} item
 */
function submitAppraisal(state, item) {
  if (state.disposed) return;
  try {
    ensureAppraiserQueue(state).submit(item);
  } catch (error) {
    state.platform.log('warn', '[dsh-companion] emotion appraise enqueue failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * V50-M3：systemPrompt.context provider。
 *
 * 宿主每次装配/请求前调用；子代理返回空串（宿主会过滤空 section），其它会话按
 * routeSession 解析 scope 后取 injectEmotion 暂存的最近一句。路由失败按主会话
 * 兜底并返回空串，provider 本身绝不抛错。
 *
 * @param {object} state
 * @param {{agent?: object}|null|undefined} context
 * @returns {string}
 */
function emotionContextText(state, context) {
  let identity;
  try {
    identity = routeSession(state, { agent: context?.agent });
  } catch (error) {
    state?.platform?.log?.('warn', '[dsh-companion] emotion context routing failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
  if (identity?.kind === 'subagent') return '';
  const scope = identity?.scope ?? SCOPE;
  const text = state?.emotionTextByScope?.get(scope) ?? '';
  // V50-L3：本轮真正会被投影出去的那句，记在内存里供 /状态 显示。
  if (text !== '') {
    recordEmotionText(state.assembly, text, typeof state?.platform?.now === 'function' ? state.platform.now() : null);
  }
  return text;
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
    recalled = await retrieveVectors(state, {
      store,
      query,
      scope,
      now: platform.now(),
      budgetTokens: RECALL_BUDGET_TOKENS,
      vector: vectorConfig(state),
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
  if (Number.isInteger(recalled.vectorHits)) state.lastVectorHits = recalled.vectorHits;

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
  recordRecalledFacts(state, recalled, assembled, scope, platform.now());
  return { inject: [recallMessage(injection)] };
}

/**
 * 构造召回注入消息：**完整平台消息**，不是裸 ContentBlock（V3-H1）。
 *
 * 形状对齐平台自己的注入实现（`dsh-time-context/lib/index.js:215-246` 用
 * `createUserMessage({content, source:{kind, form:'snapshot', sections}})`）：
 * - `id`：平台消息必须带 id，缺了冷读会话会报 `lacks an identified message`
 *   （`dsh-session/lib/index.js:1200`）；这里用 `randomUUID()`，与
 *   `dsh-llm` 的 `createMessage` 同口径，不引入平台包（零新增依赖）。
 * - `role:'user'`：user/message 的类型↔角色映射固定，`dsh-session` 会校验。
 * - `content`：文本块数组（与平台内容块契约一致）。
 * - `source`：`kind=companion-recall` 供插件下游（转录/巩固）排除；
 *   `form`/`sections` 与 time-context 的 snapshot 注入同构，便于宿主识别。
 *
 * @param {string} text 渲染好的 `[相关记忆]` 块（含标题）
 * @returns {{id: string, role: 'user', content: object[], source: object}}
 */
function recallMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: RECALL_SOURCE_KIND,
      form: 'snapshot',
      sections: [{ name: 'recall', text }],
    },
  };
}

/**
 * 记录本轮真正进入注入块的 fact id（预算裁切丢掉的召回不算），
 * 以及注入时刻的 assistant 快照，供下一轮「用上」判定。
 * 同时把 full/gist 档的首次再需要写进 facts.first_reneed_*（W5）；写失败
 * 只告警，不影响本轮召回注入。
 *
 * v8/S-M1：首次样本会标记 `same_context`（observed_at 距注入 < 6h 或来源
 * episode 仍在当前 surface），统计口径排除；样本同时放进 state.lastRecallSamples。
 * v9/S2-M1：样本里的 at/tier 不再被后续注入沿用；「用上」时由 markUsedReneed
 * 按用上那一刻重算，recall 样本保持首次注入时的值作对照。
 * v0.4.2/L-4：全部注入 fact 的实际档位另记在 state.lastRecallTiers（index 档为
 * miss），供「用上」写 first_used_tier；index 档仍不写 recall 样本。
 *
 * @param {object} state
 * @param {{items: object[]}} recalled
 * @param {object} assembled
 * @param {string} [scope] 本轮注入所属的会话作用域
 * @param {number} [at] 注入时刻（毫秒），与 platform.now() 同口径
 */
function recordRecalledFacts(state, recalled, assembled, scope = SCOPE, at = Date.now()) {
  const dropped = Array.isArray(assembled?.dropped?.recall) ? assembled.dropped.recall : [];
  const droppedIds = new Set(
    dropped
      .map((item) => (item !== null && typeof item === 'object' ? item.id : null))
      .filter((id) => typeof id === 'string'),
  );
  const atSeconds = Math.floor(Number(at) / 1000);
  const ids = [];
  const samples = new Map();
  const tiers = new Map();
  for (const item of recalled.items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.kind !== 'fact' || typeof item.id !== 'string') continue;
    if (droppedIds.has(item.id)) continue;
    if (ids.includes(item.id)) continue;
    ids.push(item.id);
    // v0.4.2/L-4：记下本轮注入的实际档位（index 档也记 miss），供「用上」时
    // 写 first_used_tier；只有 full/gist 才继续写 recall 样本（markFirstReneed）。
    tiers.set(
      item.id,
      item.fidelity === 'full' ? 'clear' : item.fidelity === 'gist' ? 'ambiguous' : 'miss',
    );
    if (item.fidelity !== 'full' && item.fidelity !== 'gist') continue;
    const tier = item.fidelity === 'full' ? 'clear' : 'ambiguous';
    let fact = null;
    try {
      fact = state.store?.getFact?.(item.id) ?? null;
    } catch {
      fact = null;
    }
    // 每次注入都按本次时刻记录对照样本；是否同会话用 observed_at 口径
    // （L2-1）。第二次注入不改写 first_reneed_*（markFirstReneed 只在首次
    // 写入），但样本表里保留本次的 at/tier，供「用上」时取当前档位。
    const sample = {
      at: atSeconds,
      tier,
      sameContext: isSameContextSample({
        at: atSeconds,
        createdAt: factOriginTime(state, fact),
        sourceInSurface: sourceStillInSurface(state, scope, fact),
      }),
    };
    samples.set(item.id, sample);
    try {
      state.store?.markFirstReneed?.(item.id, {
        at: sample.at,
        tier: sample.tier,
        kind: 'recall',
        sameContext: sample.sameContext,
      });
    } catch (error) {
      state.platform?.log?.('warn', '[dsh-companion] mark first reneed failed', {
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  state.lastRecalledIds = ids;
  state.lastRecallSamples = samples;
  state.lastRecallTiers = tiers;
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
      const marker = block.text.indexOf(RECALL_MARKER);
      if (marker >= 0) return block.text.slice(marker).trim();
    }
  }
  return '';
}

/**
 * 这条 payload 消息是否是插件注入（召回块 / 中文命令提示，V3-H1 + V3-L3）。
 * 平台会把注入消息作为普通 user/message 回灌，下游不得当用户发言处理。
 * @param {unknown} message
 * @returns {boolean}
 */
function isInjectedMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const kind = message.source?.kind;
  return kind === RECALL_SOURCE_KIND
    || kind === EMOTION_SOURCE_KIND
    || kind === COMMAND_HINT_SOURCE_KIND
    || kind === PRIVACY_HINT_SOURCE_KIND
    || kind === RUNTIME_CONTEXT_SOURCE_KIND
    || isCompanionMessage(message);
}

/**
 * C5-H1a：这条 payload 消息是否是本插件主动投递（提醒/任务/线程/主动消息）。
 *
 * 宿主把它们记成普通 `user/message`，source 是 `{kind:'user', rpcId}`。优先按
 * `source.rpcId` 的 `companion-` 前缀识别；拿不到 rpcId（或旧宿主/回放）时按
 * 正文的 `[提醒] ` 前缀兜底。
 *
 * @param {unknown} message
 * @returns {boolean}
 */
function isCompanionMessage(message) {
  if (message === null || typeof message !== 'object') return false;
  const rpcId = message.source?.rpcId;
  if (typeof rpcId === 'string' && rpcId.startsWith(COMPANION_RPC_PREFIX)) return true;
  const blocks = Array.isArray(message.content) ? message.content : [];
  for (const block of blocks) {
    const text = typeof block === 'string' ? block : block?.type === 'text' ? block.text : null;
    if (typeof text === 'string' && text.trimStart().startsWith(REMINDER_TEXT_PREFIX)) return true;
  }
  return false;
}

/**
 * C5-H1a：一条 surface 记录是否是本插件主动投递。
 * surface 记录只有 `{role, text, tokens}`（没有 source），按 role+正文前缀兜底。
 * @param {{role?: string, text?: string}|null|undefined} record
 * @returns {boolean}
 */
function isCompanionRecord(record) {
  return record?.role === 'user'
    && typeof record.text === 'string'
    && record.text.trimStart().startsWith(REMINDER_TEXT_PREFIX);
}

/**
 * 一条 surface 记录是否是召回注入。
 * surface 记录只有 `{role, text, tokens}`（见 src/session/surface.js），
 * 没有 source，因此按 role+文本前缀兜底识别。
 * @param {{role?: string, text?: string}|null|undefined} record
 * @returns {boolean}
 */
function isRecallRecord(record) {
  if (record?.role !== 'user' || typeof record.text !== 'string') return false;
  const text = record.text.trimStart();
  return text.startsWith(RECALL_MARKER)
    || text.startsWith(EMOTION_PROMPT_PREFIX)
    || text.startsWith(COMMAND_HINT_TEXT_PREFIX)
    || text.startsWith(PRIVACY_HINT_TEXT_PREFIX);
}

/**
 * V4-L2：从任意文本里剔除完整的 `[相关记忆] … [/相关记忆]` 片段。
 *
 * 召回块本身会随会话保留到下一次压缩；平台压缩摘要可能把它复述进摘要节点，
 * 而摘要节点又在下一轮进入巩固窗口（source.kind 在 surface 层已丢失）。
 * 这里按成对标记整段删除，保留摘要里的普通对话内容。
 *
 * 标记不全（只有开头、没有结尾）时保持原文不动：宁可交给提示词规则，
 * 也不做「删除剩余全文」之类会误伤摘要后文的猜测。
 *
 * @param {string} text
 * @returns {string}
 */
function scrubRecallBlocks(text) {
  if (typeof text !== 'string' || !text.includes(RECALL_MARKER)) return text;
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(RECALL_MARKER, cursor);
    if (start < 0) {
      output += text.slice(cursor);
      break;
    }
    const end = text.indexOf(RECALL_END_MARKER, start + RECALL_MARKER.length);
    if (end < 0) {
      // 没有结束标记：无法安全确定边界，保留原文。
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    cursor = end + RECALL_END_MARKER.length;
    if (text[cursor] === '\r') cursor += 1;
    if (text[cursor] === '\n') cursor += 1;
  }
  return output.replace(/[ \t]+$/u, '');
}

/**
 * 返回把召回注入记录文本清空的 surface 快照副本。
 *
 * 只清文本、不动 `seqs`/`nodes`：选区边界与 token 计量口径保持不变
 * （surface 仍按平台 `estimateMessage` 把注入消息计入 tokens/预算），
 * 只保证交给巩固模型的选区文本里不出现召回块，注入块不会被当成
 * 用户发言巩固进记忆。
 *
 * @param {{seqs: number[], nodes: object[], records: object[]}|null|undefined} snapshot
 * @returns {object|null|undefined}
 */
function withoutRecallRecords(snapshot) {
  const records = Array.isArray(snapshot?.records) ? snapshot.records : null;
  if (records === null) return snapshot;
  // V4-L2：摘要节点可能把召回块夹在正文中（不是以标记开头），这类记录也要剔除。
  // C5-H1a：插件主动投递（提醒）会以 user 文本留在 surface 里，同样清空。
  const needsScrub = records.some((record) => isRecallRecord(record)
    || isCompanionRecord(record)
    || (typeof record?.text === 'string' && record.text.includes(RECALL_MARKER)));
  if (!needsScrub) return snapshot;
  return {
    ...snapshot,
    records: records.map((record) => {
      if (isRecallRecord(record) || isCompanionRecord(record)) return { ...record, text: '' };
      if (typeof record?.text !== 'string') return record;
      const text = scrubRecallBlocks(record.text);
      return text === record.text ? record : { ...record, text };
    }),
  };
}

// ---------------------------------------------------------- 巩固模型接入

/** C5-H2：成功路由的复用窗口；否定结果不缓存，每次调用重新探测。 */
const LLM_ROUTE_TTL_MS = 5 * 60 * 1000;
/** C5-H2：「无可用模型」失败事件的写库节流，避免 /状态 轮询刷屏。 */
const LLM_NO_MODEL_RETRY_MS = 60 * 1000;

/**
 * 读取 `consolidation.model` 的显式选路；未配置返回 null。
 * @param {object} config
 * @returns {{provider: string, model: string}|null}
 */
function configuredLlmModel(config) {
  const configured = config?.consolidation?.model;
  if (configured === null || configured === undefined) return null;
  if (typeof configured?.provider !== 'string' || typeof configured?.model !== 'string') return null;
  return { provider: configured.provider, model: configured.model };
}

/**
 * llm 能力位是动态 getter：启动时服务尚未挂载、约 30 秒后才出现，因此每次调用都要重读。
 * @param {object} state
 * @returns {boolean}
 */
function llmCapability(state) {
  try {
    return state.platform?.capabilities?.llm === true;
  } catch {
    return false;
  }
}

/**
 * 记录一次成功路由（带版本与解析时间）；否定结果不写入。
 * @param {object} state
 * @param {{provider: string|null, model: string|null, source: 'config'|'runtime'}} route
 * @returns {object}
 */
function setLlmRoute(state, route) {
  const version = Number(state.llmRoute?.version ?? 0) + 1;
  state.llmRoute = Object.freeze({
    ...route,
    resolvedAt: state.platform.now(),
    version,
  });
  return state.llmRoute;
}

/**
 * V6-L3：llm provider/model 发现失败按原因只 warn 一次。
 *
 * 真机 web 宿主只展示 info 及以上，原 debug 日志看不到；但调度每 5 分钟重试
 * 一次解析，直接升 warn 会刷屏。这里按「providers」与「models:<providerId>」
 * 两类原因去重；对应发现成功时清掉该键，成功解析出路由后整体清空。
 *
 * @param {object} state
 * @param {string} reason
 * @param {string} message
 * @param {Record<string, unknown>} meta
 */
function warnLlmDiscoveryOnce(state, reason, message, meta) {
  if (!(state.llmDiscoveryWarnReasons instanceof Set)) {
    state.llmDiscoveryWarnReasons = new Set();
  }
  if (state.llmDiscoveryWarnReasons.has(reason)) return;
  state.llmDiscoveryWarnReasons.add(reason);
  state.platform.log('warn', message, { reason, ...meta });
}

/** V6-L3：成功解析出路由后清空发现失败的去重键，之后再失败可重新告警。 */
function clearLlmDiscoveryWarnings(state) {
  if (state.llmDiscoveryWarnReasons instanceof Set) {
    state.llmDiscoveryWarnReasons.clear();
  } else {
    state.llmDiscoveryWarnReasons = new Set();
  }
}

/** V6-L3：某一类发现成功后清掉对应去重键，之后再失败可重新告警。 */
function clearLlmDiscoveryReason(state, reason) {
  if (state.llmDiscoveryWarnReasons instanceof Set) {
    state.llmDiscoveryWarnReasons.delete(reason);
  }
}

/**
 * 解析实际可用的 provider/model：显式配置优先；否则遍历 providers，跳过模型列表为空的，
 * 取第一个有模型的 provider。失败/无模型一律返回 null（不缓存否定结果）。
 *
 * @param {object} state
 * @returns {Promise<{provider: string, model: string, source: string}|null>}
 */
async function resolveLlmRoute(state) {
  if (state.disposed) return null;
  const now = state.platform.now();
  if (!llmCapability(state)) {
    state.llmRouteProbed = true;
    state.llmRouteLastAttemptAt = now;
    return null;
  }

  const configured = configuredLlmModel(state.config);
  if (configured !== null) {
    state.llmRouteProbed = true;
    state.llmRouteLastAttemptAt = now;
    return setLlmRoute(state, { ...configured, source: 'config' });
  }

  const cached = state.llmRoute;
  if (cached?.source === 'runtime' && typeof cached.provider === 'string'
    && now - Number(cached.resolvedAt ?? 0) < LLM_ROUTE_TTL_MS) {
    state.llmRouteProbed = true;
    return cached;
  }

  if (state.llmRoutePromise !== null) return state.llmRoutePromise;
  state.llmRouteRefreshing = true;
  const pending = (async () => {
    let providers = [];
    try {
      providers = await state.platform.listProviders();
      // V6-L3：provider 发现恢复，之后再失败可以重新告警一次。
      clearLlmDiscoveryReason(state, 'providers');
    } catch (error) {
      warnLlmDiscoveryOnce(state, 'providers', '[dsh-companion] llm provider discovery failed', {
        message: errorMessage(error),
      });
    }
    for (const row of Array.isArray(providers) ? providers : []) {
      const providerId = typeof row?.id === 'string' && row.id !== '' ? row.id : null;
      if (providerId === null) continue;
      let models = [];
      try {
        models = await state.platform.listModels(providerId);
        clearLlmDiscoveryReason(state, `models:${providerId}`);
      } catch (error) {
        warnLlmDiscoveryOnce(
          state,
          `models:${providerId}`,
          '[dsh-companion] llm model discovery failed',
          {
            provider: providerId,
            message: errorMessage(error),
          },
        );
        continue;
      }
      const model = (Array.isArray(models) ? models : [])
        .find((entry) => typeof entry?.id === 'string' && entry.id !== '');
      if (!model) continue;
      const route = setLlmRoute(state, { provider: providerId, model: model.id, source: 'runtime' });
      clearLlmDiscoveryWarnings(state);
      return route;
    }
    if (state.llmRoute?.source === 'runtime') state.llmRoute = null;
    return null;
  })();
  state.llmRoutePromise = pending;
  try {
    return await pending;
  } finally {
    if (state.llmRoutePromise === pending) state.llmRoutePromise = null;
    state.llmRouteRefreshing = false;
    state.llmRouteProbed = true;
    state.llmRouteLastAttemptAt = state.platform.now();
  }
}

/**
 * C5-H2：无可用模型时写一条「巩固失败」审计，让 /状态 的「最近失败」可见。
 * 按 LLM_NO_MODEL_RETRY_MS 节流；不创建 consolidations 行。
 * @param {object} state
 * @param {number} [now]
 */
function reportNoModelFailure(state, now = state.platform.now()) {
  if (state.disposed) return;
  if (state.lastNoModelFailureAt !== null
    && now - Number(state.lastNoModelFailureAt) < LLM_NO_MODEL_RETRY_MS) {
    return;
  }
  state.lastNoModelFailureAt = now;
  try {
    state.store.appendEvent({
      at: Math.floor(now / 1000),
      action: 'UPDATE',
      table_name: 'consolidations',
      row_id: null,
      actor: 'consolidator',
      reason: 'consolidation_failed',
      detail_json: { kind: 'consolidation_no_model', message: '无可用模型' },
    });
  } catch {
    // 审计写失败不影响业务，也不覆盖状态展示。
  }
}

/**
 * 解析巩固模型：优先宿主注入（`ctx.companion.consolidationLlm`），其次走平台唯一模型路径
 * `ctx.llm.stream`。每次调用都重新确认能力与路由，晚注册的 llm 服务可以被下一次调用用上。
 * @param {object} state
 * @returns {Promise<Function|null>}
 */
async function resolveConsolidationLlm(state) {
  const hook = state.companion?.consolidationLlm;
  if (typeof hook === 'function') {
    state.llmRouteProbed = true;
    return async ({ scope, seqFrom, seqTo, regionText, textSource, transcript }) => hook({
      scope,
      seqFrom,
      seqTo,
      // N1：选区文本透传给宿主注入的模型；transcript 保留为兜底。
      regionText: regionText ?? '',
      textSource: textSource ?? (regionText ? 'region' : 'transcript'),
      transcript: Array.isArray(transcript) ? transcript : state.transcript,
    });
  }

  const route = await resolveLlmRoute(state);
  if (route === null || typeof route.provider !== 'string') {
    reportNoModelFailure(state);
    return null;
  }
  const { provider, model } = route;
  return async ({ scope, seqFrom, seqTo, regionText, transcript }) => {
    const prompt = buildConsolidationPrompt({
      scope,
      seqFrom,
      seqTo,
      regionText: regionText ?? '',
      transcript: Array.isArray(transcript) ? transcript : state.transcript,
    });
    const text = await state.platform.complete({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    });
    return parseDraftJson(text);
  };
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
    // V5-L2：提醒「重试中，下次 HH:MM」按 config.timezone 与本次巩固时刻渲染。
    now: Math.floor(now / 1000),
    timeZone: config.timezone,
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
    afterSeq: ensureWatermark(state, SCOPE, snapshot),
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
      // V7-L2：同一平台毫秒时钟计 duration_ms。
      clock: platform.now,
      trigger: 'deep-sleep',
      sessionId: SCOPE,
      guardWatermark: false,
    });
    if (result?.skipped) return { written: false, reason: 'skipped' };
    const row = findConsolidation(store, SCOPE, Number(result.upto_seq));
    setPendingCompact(state.pendingCompact, {
      id: row?.id ?? null,
      startSeq: region.startSeq,
      endSeq: region.endSeq,
      scope: SCOPE,
    });
    setWatermark(state, SCOPE, region.endSeq);
    clearWatermarkAnchor(state.store, SCOPE);
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
  // V7-H1 审计：timer 是声明的 inject（cordis 在 apply 前就绪）；调度器只能
  // 注册一次，故保留 apply 时判断，不存在晚挂载后补启动的路径。
  if (!platform.capabilities.timer) return () => {};

  const proactive = createProactive({
    store,
    platform: {
      // C5-H1a：requestId 由 proactive 按「份」算出并透传，宿主按 rpcId 去重。
      prompt: (sessionId, text, options = {}) => platform.prompt({
        sessionId,
        content: [{ type: 'text', text }],
        ...(typeof options?.requestId === 'string' && options.requestId.length > 0
          ? { requestId: options.requestId }
          : {}),
      }),
    },
    // V3-H2：投递目标是 identity 解析出的当前主会话 id，不再是字面量 'main'。
    target: () => currentMainSessionId(state),
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
      // E-M1：local 模型预热/退避重试；未就绪期间 backfill 直接跳过。
      prewarmEmbedder(state);
      // W4：空闲时回填一批缺失/不匹配的向量；失败不阻塞后续闲聊。
      await backfillVectors(state);
      if (proactiveBlocked(state)) return;
      await runLightChat(state);
      const report = await proactive.flush();
      recordChatDelivery(state, report);
      logDeliveryReport(state, report);
    },
    reminders: async () => {
      // 降级/熔断期间不把提醒标记 fired，恢复后仍可补投。
      if (proactiveBlocked(state)) return;
      // P1-b：承诺跟进先入队，逾期久的排前面；通用提醒不重复播报 commitment。
      runCommitmentFollowups(state);
      fireDueReminders(state);
      const report = await proactive.flush();
      recordChatDelivery(state, report);
      logDeliveryReport(state, report);
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
 * 把到点的提醒转成主动消息（V3-H2 两阶段投递，V4-H1 队列/退避加固）。
 *
 * 这里只入队并挂上状态机钩子，不再提前把行标成 fired：
 *   onAttempt → 复核最新行后 claim（pending/snoozed → delivering，attempts+1）
 *   onSent    → store.markReminderDelivered（delivering → fired）
 *   onFailed  → store.markReminderDeliveryFailed（delivering → pending + 退避）
 * 投递失败/进程崩溃时行仍可重试；启动时 recoverReminderDeliveries 兜底回收。
 *
 * 队列语义（V4-H1）：
 * - dedupeKey 稳定为 `reminder:<id>`（不含 tick 秒），配合 proactive.enqueue 的
 *   同键跳过，安静时段/日上限/退避期间每个 tick 重复入队只会保留一份。
 * - requestId 按 occurrence 稳定（V6-M1）：入队前取 `ensureReminderOccurrence`，
 *   同一次到点内即使失败退避（只写 `retry_at`，30s→60s），重试仍复用同一个
 *   occurrence_key，rpcId 不变，宿主才能按 rpcId 去重；投递成功/置 expired 后
 *   occurrence 清空，下一次到点生成新 key，attempts 也从 0 重新计数。
 * - fireKey 用「发生时刻 + 本次重试时刻」（V5-L2）：`<next_fire_at>:<retry_at??0>`。
 *   next_fire_at 是原定到点时间、退避期间不变，只拼它会让每次重试都算同一次
 *   attempt；拼上本次 retry_at 后，每次真正重试才累加 attempts，而同一 tick 的
 *   两次 flush 看到同一个 retry_at，仍不会重复计数。
 * - onAttempt 返回 false 表示本轮不投递：行已不是 pending/snoozed、已删除、
 *   occurrence 已换代，或 max(next_fire_at, retry_at??0) 仍在未来（失败退避
 *   30s→60s→120s 尚未到期）。proactive 会对该份回调 onFailed，若已 claim 成功
 *   则释放回 pending，不会留下 delivering 残留。
 * - onFailed 由 store.markReminderDeliveryFailed 按 attempts 写入退避时刻
 *   `retry_at`（next_fire_at 保持原定时间不动）；attempts 达上限（3）才置
 *   expired，因此连续 3 个 30s tick 不会直接把提醒耗成 expired（30s/60s/120s
 *   退避下第 3 次重试最早在约 3.5 分钟后）。
 *
 * @param {object} state
 * @returns {number} 本次入队条数（因同 id 已排队而跳过的不计）
 */
function fireDueReminders(state) {
  const { store, platform, proactive } = state;
  const now = platform.now();
  const seconds = Math.floor(now / 1000);
  const due = store.dueReminders({ now: seconds, limit: 50 });
  if (due.length === 0) return 0;
  let queued = 0;
  for (const row of due) {
    // 承诺由 runCommitmentFollowups 单独处理（每日最多一次、文案不同）。
    if (row.kind === 'commitment') continue;
    const attempts = Number(row.delivery_attempts ?? 0);
    if (attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS) {
      // 重试用尽：不再无限重试，置 expired 留痕。
      store.expireReminder(row.id);
      platform.log('warn', '[dsh-companion] reminder delivery attempts exhausted; expired', {
        id: row.id,
        attempts,
      });
      continue;
    }
    // V6-M1：本次到点的稳定身份。已不是 pending/snoozed（刚被完成/取消/删除）
    // 时返回 null，直接跳过，避免把旧 occurrence 的 rpcId 带进来。
    const occurrenceKey = store.ensureReminderOccurrence(row.id, seconds);
    if (occurrenceKey === null) continue;
    const result = proactive?.enqueue({
      kind: 'reminder',
      // C5-H1a：正文前缀供 surface/回放侧兜底识别「这不是用户发言」。
      text: `${REMINDER_TEXT_PREFIX}${row.title}`,
      dedupeKey: `reminder:${row.id}`,
      // requestId 与 occurrence_key 同源：同一次到点/同一次 claim 内重试保持一致，
      // 宿主才能按 rpcId 去重（否则退避后重试会被当成新消息重复投递）。
      requestId: `companion-reminder:${row.id}:${occurrenceKey}`,
      at: now,
      onAttempt: () => {
        const fresh = store.getReminder(row.id);
        if (fresh === null || fresh === undefined) return false;
        if (fresh.status !== 'pending' && fresh.status !== 'snoozed') return false;
        if (fresh.occurrence_key !== occurrenceKey) return false;
        // V8-L2：到期时刻与 store.dueReminders 共用同一口径
        // max(next_fire_at, retry_at)（reminderDueAt），不再各写一份 Math.max。
        const nowSeconds = Math.floor(platform.now() / 1000);
        const dueAt = reminderDueAt(fresh);
        if (dueAt === null || dueAt > nowSeconds) return false;
        // V5-L2：fireKey = 原定到点时刻 + 本次重试时刻，退避后每次重试都递增
        // attempts；同一 tick 双 flush 看到同一个 retry_at，不会重复计数。
        const fireKey = `${fresh.next_fire_at}:${fresh.retry_at ?? 0}`;
        return store.claimReminderDelivery(
          fresh.id,
          fireKey,
          REMINDER_MAX_DELIVERY_ATTEMPTS,
        );
      },
      onSent: () => store.markReminderDelivered(row.id),
      onFailed: () => store.markReminderDeliveryFailed(row.id, {
        now: Math.floor(platform.now() / 1000),
      }),
    });
    if (result?.duplicate !== true) queued += 1;
  }
  return queued;
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
 * C5-H2：/状态 里的巩固模型行。同步展示，缺路由时在后台触发一次解析。
 *
 * 优先级与真实调用一致：宿主注入 → consolidation.model 配置 → 运行时自动选取。
 * 来源标注（V6-L1）：宿主注入 →「（宿主注入）」、配置 →「（配置）」、
 * 自动选取 →「（自动选取）」。能力位为 false、或探测后没有任何「有模型」的
 * provider 时显示「无可用模型」，并写一条节流后的失败事件供「最近失败」行展示。
 *
 * @param {object} state
 * @param {number} now
 * @returns {string}
 */
function formatConsolidationStatus(state, now) {
  if (typeof state.companion?.consolidationLlm === 'function') {
    state.llmRouteProbed = true;
    return '巩固：宿主注入模型（宿主注入）';
  }
  const configured = configuredLlmModel(state.config);
  if (!llmCapability(state)) {
    reportNoModelFailure(state, now);
    return '巩固：无可用模型';
  }
  const route = state.llmRoute;
  if (route?.source === 'runtime' && typeof route.provider === 'string') {
    return `巩固：${route.provider}/${route.model}（自动选取）`;
  }
  if (configured !== null) {
    return `巩固：${configured.provider}/${configured.model}（配置）`;
  }
  const lastAttemptAt = state.llmRouteLastAttemptAt;
  const stale = lastAttemptAt === null || now - Number(lastAttemptAt) >= LLM_NO_MODEL_RETRY_MS;
  if (!state.llmRouteProbed || stale) {
    void resolveLlmRoute(state).catch(() => {});
    if (!state.llmRouteProbed) return '巩固：解析中';
  }
  if (state.llmRouteRefreshing) return '巩固：解析中';
  reportNoModelFailure(state, now);
  return '巩固：无可用模型';
}

/**
 * C5-H1a：投递失败优先显示在 /状态 的「最近失败」行。
 *
 * `src/runtime/commands.js` 的 formatFailureStatus 只认巩固/job 失败；主动消息
 * 投递失败（FakeCtx/真实宿主 prompt 抛 TypeError 等）写在 memory_events 的
 * `reason='delivery_error'`。这里只在投递失败比巩固失败更新时替换那一行，
 * 不改写其它状态行，也不改动命令层（本卡范围外）。
 *
 * @param {object} store
 * @param {string} reply 命令层已生成的回复
 * @returns {string}
 */
function withDeliveryFailure(store, reply) {
  if (typeof reply !== 'string' || typeof store?.listEvents !== 'function') return reply;
  let rows = [];
  try {
    rows = store.listEvents({ limit: 200 });
  } catch {
    return reply;
  }
  let latestDelivery = null;
  let latestConsolidationFailure = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (latestDelivery === null && String(row?.reason ?? '') === DELIVERY_ERROR_KIND) {
      latestDelivery = row;
    }
    if (latestConsolidationFailure === null
      && (row?.reason === 'consolidation_failed' || row?.reason === 'consolidation_failed_final')) {
      latestConsolidationFailure = row;
    }
    if (latestDelivery !== null && latestConsolidationFailure !== null) break;
  }
  if (latestDelivery === null) return reply;
  // C5-H2：无可用模型是配置状态而非更新的运行失败；不要让 /状态 自己写的
  // no-model 事件遮住真实的投递失败（C5-H1a）。
  let consolidationDetail = latestConsolidationFailure?.detail_json;
  if (typeof consolidationDetail === 'string') {
    try {
      consolidationDetail = JSON.parse(consolidationDetail);
    } catch {
      consolidationDetail = null;
    }
  }
  if (consolidationDetail?.kind !== 'consolidation_no_model'
    && latestConsolidationFailure !== null
    && Number(latestConsolidationFailure.id) > Number(latestDelivery.id)) {
    return reply;
  }
  let detail = latestDelivery.detail_json;
  if (typeof detail === 'string') {
    try {
      detail = JSON.parse(detail);
    } catch {
      detail = null;
    }
  }
  const name = typeof detail?.errorName === 'string' && detail.errorName !== ''
    ? detail.errorName
    : 'Error';
  const message = typeof detail?.errorMessage === 'string' ? detail.errorMessage : '';
  const line = message === ''
    ? `最近失败：投递失败：${name}`
    : `最近失败：投递失败：${name}：${message}`;
  return reply.replace(/^最近失败：.*$/mu, () => line);
}

/**
 * 扫描到期承诺并入队：每条每天最多一次，逾期久的先入队。
 * @param {object} state
 * @returns {number} 本次入队条数
 */
function runCommitmentFollowups(state) {
  const { store, platform, proactive, config, metrics, card } = state;
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
      // C5-H1a：承诺跟进同样是插件主动投递，正文带提醒前缀，requestId 按天稳定。
      text: `${REMINDER_TEXT_PREFIX}${followUpText({ card, reminder: row, overdueDays })}`,
      dedupeKey: `commitment:${row.id}:${dayKey}`,
      requestId: `companion-commitment:${row.id}:${dayKey}`,
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
  const { store, platform, config, metrics, card } = state;
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
      const recalled = await retrieveVectors(state, {
        store,
        query: recentTopics[0]?.title ?? '',
        scope: SCOPE,
        now,
        budgetTokens: 600,
        limit: 3,
        vector: vectorConfig(state),
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
      raw = await llm({ card, recentTopics, recallSummary, messageCount: 8 });
    } catch (error) {
      platform.log('warn', '[dsh-companion] light chat generation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { queued: false, reason: 'llm_failed' };
    }

    const normalized = normalizeChatText(typeof raw === 'string' ? raw : raw?.text, {
      bannedPhrases: renderBannedPhrases(card),
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
      // C5-H1a：主动闲聊也必须有稳定 requestId（同一天只投一次）。
      requestId: `companion-chat:${dayKey}:daily`,
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

/** 从 proactive.flush 的 report 里取可用于去重的失败原因。 */
function describeDeliveryFailure(report) {
  const error = report?.error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error !== null && error !== undefined) return String(error);
  const failed = Number(report?.failed);
  return Number.isFinite(failed) && failed > 0 ? `failed=${failed}` : null;
}

/**
 * C5-M2：投递失败原因用 warn（web 宿主只显示 info+），同一原因只打一次；
 * 一次成功 flush 视为状态恢复，清空去重键。/状态 的「最近失败」仍由事件表驱动。
 */
function logDeliveryReport(state, report) {
  try {
    const reason = describeDeliveryFailure(report);
    if (reason === null) {
      // 只有真正投出过消息才算恢复；另一条队列的空 flush 不能清掉去重键。
      if (Number(report?.sent) > 0) state.deliveryWarnReason = null;
      return;
    }
    if (state.deliveryWarnReason === reason) return;
    state.deliveryWarnReason = reason;
    state.platform.log('warn', '[dsh-companion] proactive delivery failed', {
      reason,
      failed: Number(report?.failed) || 0,
      deferred: Number(report?.deferred) || 0,
    });
  } catch {
    // 日志失败绝不能影响调度。
  }
}

/**
 * 解析闲聊模型：优先宿主 hook，其次复用巩固模型的同一套路由解析
 * （C5-H2：consolidation.model → 运行时探测；否定结果不缓存）。
 * @param {object} state
 * @returns {Promise<Function|null>}
 */
async function resolveChatLlm(state) {
  const hook = state.companion?.chatLlm;
  if (typeof hook === 'function') {
    state.chatLlmRoute = { kind: 'hook' };
    state.chatLlm = async (input) => hook(input);
    return state.chatLlm;
  }
  const route = await resolveLlmRoute(state);
  if (route === null || typeof route.provider !== 'string') {
    state.chatLlm = null;
    state.chatLlmRoute = null;
    return null;
  }
  const { provider, model } = route;
  state.chatLlmRoute = { provider, model, source: route.source };
  state.chatLlm = async (input) => state.platform.complete({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildChatPrompt(input) }] }],
  });
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
    // 召回/命令提示注入块回灌后也是 user/message，但不是用户发言（V3-H1 + V3-L3）。
    if (isInjectedMessage(message)) continue;
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
    // C5-H1a：主动投递的提醒正文没有 source 可查，按正文前缀兜底排除，
    // 避免它被当成召回查询（lastUserText）或交互日记录的唯一输入。
    if (
      text === ''
      || text.startsWith(RECALL_MARKER)
      || text.startsWith(EMOTION_PROMPT_PREFIX)
      || text.startsWith(REMINDER_TEXT_PREFIX)
    ) continue;
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
    if (
      text === ''
      || text.startsWith(RECALL_MARKER)
      || text.startsWith(EMOTION_PROMPT_PREFIX)
    ) continue;
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
 * 去掉抽取文本两端的空白与标点；只用于「值」的边界收敛。
 * @param {unknown} text
 * @returns {string}
 */
function trimExtractionEdges(text) {
  return String(text ?? '')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .trim();
}

/**
 * V3-M4：按编辑后的 statement 重抽事实字段（保守规则，不做 NLP）。
 *
 * 旧实现只替换 `statement`，`subject_text`/`predicate`/`object_text` 沿用旧行，
 * 于是治理去重、冲突分组与 FTS/向量索引都还停在旧值（真机实测：改
 * 「下周四去杭州」后 object_text 仍是「杭州出差」，旧值还能被搜到）。
 *
 * 保守规则：
 * - `subject_text` 沿用旧值：用户改的是内容，不推断主体变化；
 * - `predicate` 沿用旧值：自由文本里没有可靠的关系词，凭空猜会把治理分组打散；
 * - `object_text` 取「新 statement 去掉可复用前缀」后的剩余部分。前缀优先用
 *   「旧 statement 中旧 object_text 之前的部分」（旧值由抽取产生，它的位置正好
 *   划出主体+关系与值的边界），例如「下周四去杭州出差」的 object_text 是
 *   「杭州出差」，边界为「下周四去」，故改成「下周四去杭州」得到「杭州」；
 *   旧 object 缺失时依次回退到 `subject_text`、旧 `predicate`（memory_write 的
 *   模板词，如「记住」），取能匹配上的最长前缀；
 * - 句子没变时保留旧 object_text（纯审计场景不该把值清空）；
 * - 去前缀后为空、或整句与旧句子没有任何可复用前缀（换成了完全无关的说法），
 *   视为抽不出：`object_text = null`，由调用方在 EDIT 审计里标 `reextracted: false`。
 *
 * @param {object} oldFact 旧 facts 行（需含 statement/subject_text/predicate/object_text）
 * @param {string} statement 编辑后的新内容
 * @returns {{subject_text: string, predicate: string, object_text: string|null,
 *            extracted: boolean, unchanged: boolean}}
 */
export function reextractFactFields(oldFact, statement) {
  const subject = String(oldFact?.subject_text ?? '');
  const predicate = String(oldFact?.predicate ?? '');
  const oldStatement = String(oldFact?.statement ?? '').trim();
  const nextStatement = String(statement ?? '').trim();
  if (nextStatement !== '' && nextStatement === oldStatement) {
    return {
      subject_text: subject,
      predicate,
      object_text: oldFact?.object_text ?? null,
      extracted: true,
      unchanged: true,
    };
  }
  const miss = {
    subject_text: subject,
    predicate,
    object_text: null,
    extracted: false,
    unchanged: false,
  };
  if (nextStatement === '') return miss;

  // 前缀边界优先取「旧 statement 中旧 object_text 之前的部分」：旧值是抽取出来的，
  // 它出现的位置正好划出「主体 + 关系」与「值」的边界（「下周四去杭州出差」的
  // object_text 是「杭州出差」，边界就是「下周四去」）。旧 object 缺失时依次
  // 回退到 subject 与 predicate（memory_write 模板词，如「记住」）。
  const oldObject = trimExtractionEdges(oldFact?.object_text ?? '');
  const boundaries = [];
  if (oldObject !== '') {
    const at = oldStatement.indexOf(oldObject);
    if (at > 0) boundaries.push(trimExtractionEdges(oldStatement.slice(0, at)));
  }
  if (subject !== '') boundaries.push(trimExtractionEdges(subject));
  if (predicate !== '') boundaries.push(trimExtractionEdges(predicate));
  const usable = boundaries
    .filter((prefix) => prefix !== ''
      && prefix.length < nextStatement.length
      && nextStatement.startsWith(prefix))
    .sort((left, right) => right.length - left.length);
  // 没有任何可复用前缀（换成了完全无关的说法），说明抽不出值。
  if (usable.length === 0) return miss;
  const objectText = trimExtractionEdges(nextStatement.slice(usable[0].length));
  if (objectText === '') return miss;
  return { subject_text: subject, predicate, object_text: objectText, extracted: true, unchanged: false };
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
  // V3-M4：按新 statement 重抽内容字段，避免旧 object_text 继续参与检索与治理。
  const fields = reextractFactFields(confidence, nextStatement);
  const markSensitive = confidence.sensitive === 1 || isSensitiveText(nextStatement);
  let newId = null;
  try {
    store.transaction(() => {
      const inserted = store.insertFact({
        scope,
        kind: confidence.kind,
        subject_id: confidence.subject_id,
        subject_text: fields.subject_text,
        predicate: fields.predicate,
        object_text: fields.object_text,
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
      // W5：用户纠正旧事实即「漏·纠正」；已有首次样本时不覆盖。
      store.markFirstReneed?.(id, { at: atSeconds, tier: 'miss', kind: 'correction' });
      store.updateFact(id, { status: 'superseded', superseded_by: newId });
      deleteFactFtsRow(store, id);
      if (markSensitive) {
        ensureSensitiveColumn(store);
        store.db.prepare('UPDATE facts SET sensitive = 1 WHERE id = ?').run(newId);
        // 重建（而不是只删 FTS）：sensitive 列出现后向量投影也必须按新值重算并清掉。
        store.updateFact(newId, {});
        deleteFactFtsRow(store, newId);
      }
      appendEventWithAction(store, {
        action: 'EDIT',
        tableName: 'facts',
        rowId: newId,
        actor: 'user',
        reason: 'memory_update',
        at: nowMs,
        // V3-M4：审计里标出这是编辑，以及内容字段是否抽得出来（抽不出即 object_text=NULL）。
        detail: {
          from: id,
          to: newId,
          edited: true,
          reextracted: fields.extracted,
        },
      });
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ok: true,
    id: newId,
    supersededId: id,
    reextracted: fields.extracted,
    objectText: fields.object_text,
  };
}

/**
 * `/记忆` 的新子命令；返回 null 时交给旧 handleCommand（忘掉/置顶等）。
 *
 * @param {{text: string, store: Store, now?: number, scope?: string, timeZone?: string,
 *          cwd?: string, dir?: string}} input
 * @returns {string|null}
 */
export function handleMemoryCommand({
  text,
  store,
  now = Date.now(),
  scope = SCOPE,
  timeZone,
  cwd,
  dir,
} = {}) {
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
  if (verb === '导出' || verb === 'export') {
    const format = body.slice(verb.length).trim();
    if (format !== '' && format !== 'md' && format !== 'json') {
      return '用法：/记忆 导出 [md|json]';
    }
    const targetDir = dir ?? join(cwd ?? process.cwd(), '.data', 'export');
    const result = exportAll({
      store,
      scope,
      format: format === 'md' ? 'md' : 'json',
      dir: targetDir,
      now: toMillis(now),
    });
    return [
      `已导出记忆（${result.format}）：facts=${result.counts.facts} · episodes=${result.counts.episodes} · reminders=${result.counts.reminders} · threads=${result.counts.threads}`,
      `文件：${result.path}`,
    ].join('\n');
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
