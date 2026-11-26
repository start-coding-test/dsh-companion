/**
 * 模型工具面（05 §7.5、t11 卡）：9 个工具的描述符 + 执行层。
 *
 * 约束：
 * - `createTools` 只接收依赖（store/retrieve/registry/platform/clock/cwd），execute 不读全局单例；
 *   clock 与 cwd 由接线层注入，模块内不再直接调 Date.now() / process.cwd()；
 * - 能力缺失时返回 `{ok:false,reuse?...,reason}`，不静默跳过；
 * - 每个工具都带合法 JSON Schema（type=object + properties + required）；
 * - 必填参数缺失时同步抛 TypeError，便于模型侧拿到明确错误；
 * - thread_run 遵循 05 §2.8.1：先用 registry 做复用/新建/拒绝判定，
 *   新建时按配置 thread.agentPreset 决定 createSession 的 preset（未配置则不传，
 *   走宿主默认），并写 threads 行；宿主报未知 preset 时返回 preset_unknown
 *   而不是把错误抛给模型。
 */

import { forgetMany, forgetMemory } from '../memory/forget.js';
// M2（v0.7.15）：task_cancel 走执行器的取消入口；startTask 仍是 task_run 的派出入口。
import {
  releaseExecSlot,
  startTask as startBackgroundTask,
  stopTaskById,
  tryAcquireExecSlot,
} from '../task/run.js';
import { resolveStopTarget } from '../task/stop-target.js';
// D21-M2（v0.7.10）：宿主 sendToSubagent/prompt 的第 4 参必须是真的 AbortSignal，
// 传 `{}` 时宿主会调 `signal.throwIfAborted()` 直接抛错。
import { deliverySignal } from '../platform/adapter.js';
import { summarizeCost } from './commands.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, zonedDayKey } from '../time.js';
import { nextOccurrence, parseRRule } from '../scheduler/recurrence.js';
import { FACT_KINDS as STORE_FACT_KINDS } from '../memory/store.js';
// M1（v0.7.17）：memory_write 的近似查重、judge 裁决与跨 kind 关键串升级，
// 与 consolidate.js 共用同一套纯函数（dedupe.js），避免两处口径漂移。
import {
  buildDedupeJudgePrompt,
  buildKeyPhraseIndex,
  classifyDraftFact,
  collectActiveFactsByKind,
  parseDedupeVerdicts,
  upgradeVerdictWithKeyPhrases,
} from '../memory/dedupe.js';
// SA-B1/SA-B2（v0.7.7 阶段 4）：子代理命名与模型 allowlist 与 runner 共用一份口径。
// T120-M1（v0.7.7 阶段 5）：线程回执要取「结论首句」回写 last_progress。
import {
  SUBAGENT_MODEL_ALLOWLIST,
  buildSubagentReceipt,
  mapStopReason,
  normalizeSubagentName,
  outputText,
  threadSubagentName,
} from '../task/subagent-runner.js';
import { progressFromReceipt } from '../task/receipt.js';
// W-1..W-5（v0.7.7 阶段 6）：后台长任务。
// H2（v0.7.15）：bg_run 不再发「启动告知」，故 buildStartNotice 不再引入。
import { BG_JOB_STATES, cancelBgJob, startBgJob } from '../task/bg-jobs.js';
import { sessionIdOfAgent } from '../session/identity.js';

const FACT_KINDS = new Set(STORE_FACT_KINDS);
const SALIENCE = new Set(['trivial', 'normal', 'notable', 'explicit', 'pinned']);
const PRIVACY = new Set(['normal', 'sensitive', 'secret']);
const REMINDER_KINDS = new Set(['todo', 'schedule', 'repeat', 'commitment']);
/**
 * v0.7.19 T3.1：同一 scope 下「待触发」提醒的条数上限。已有 `>= 50` 条即拒绝新增
 * （第 51 条被拦），提示用户先清理。`fired` 已触发、`done`/`cancelled`/`expired`
 * 终态与软删行都不计入，口径见 `Store.countActiveReminders`。
 */
const REMINDER_ACTIVE_LIMIT = 50;
const REMINDER_ACTIVE_STATUSES = Object.freeze(['pending', 'snoozed', 'delivering']);
const THREAD_STATUSES = new Set(['active', 'archived', 'retired']);

/** 投递给线程/worker 的目标长度上限（按 Unicode 码点计，L 级）。 */
const GOAL_MAX_CODEPOINTS = 2000;

/**
 * v0.7.19 T4.1：线程常驻职责（charter）长度上限，按 Unicode 码点计。
 * 职责直接写进现有的 `threads.description`（TEXT，不加列），超限只拒绝本次调用。
 */
const THREAD_CHARTER_MAX_CODEPOINTS = 300;

/**
 * v0.7.19 T4.3：每个线程滚动保留的投递历史条数，以及 thread_history 的默认页大小。
 * 历史存 `schema_meta`（键 `thread_history:<key>`），零 DDL、最新在前；口径沿用
 * v0.7.18 L5 的 `dedupe_judge:<scope>` 键惯例。
 */
const THREAD_HISTORY_MAX_ENTRIES = 30;
const THREAD_HISTORY_DEFAULT_LIMIT = 10;

/** 投递历史里「goal 首句 / 回执首句」的展示长度上限（码点）。 */
const THREAD_HISTORY_FIRST_SENTENCE_MAX = 80;

/**
 * N-M2：thread_run 占槽后等线程空闲的上限；超时强制释放，避免槽位泄漏。
 * 与 worker 硬超时 900s 对齐。
 */
const THREAD_SLOT_HOLD_MAX_MS = 900_000;

/** 可注入定时器，便于测试 900s 兜底路径而不真的等待。 */
const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
});

/** 进程内递增序号：给每次 thread_run/task_run 执行一个稳定、可读的短 id。 */
let executionSequence = 0;

/**
 * 生成一次执行的唯一短 id（时间 + 递增序号）。同一次 execute 内只调用一次，
 * 重试/多次投递共享同一个 id，不会每 tick 变化（C5-H1b）。
 * @param {string} prefix
 * @param {number} ms
 * @returns {string}
 */
function makeExecutionId(prefix, ms) {
  executionSequence += 1;
  return `${prefix}-${Math.trunc(ms).toString(36)}-${executionSequence.toString(36)}`;
}

/**
 * 槽位保持到线程空闲：thread_run 已经把目标投递进去，真正的执行是线程会话；
 * 只有等它 whenIdle 才算这次执行结束，否则 task_run 会与它并行成第二个执行态。
 * whenIdle 不可用/抛错时立即释放（宁可弱保证，也不泄漏槽位），并留下
 * warn 日志与 threadSlotFallback 计数；900s 兜底强制释放同样可观测。
 *
 * target 优先传 createSession 返回的句柄（含 agent），避免线程刚创建/刚解除
 * 归档时 ctx.agents 反查不到而直接退化；只有 reuse 分支才传会话 id。
 *
 * @param {object} platform
 * @param {string|object} target 会话 id 或 createSession 返回的 {agent}
 * @param {{sessionId?:string, action?:string, key?:string, metrics?:object,
 *   timers?:{setTimeout:Function, clearTimeout:Function}}} [context]
 */
function holdExecSlotUntilIdle(platform, target, {
  sessionId,
  action,
  key,
  metrics,
  timers = DEFAULT_TIMERS,
} = {}) {
  const baseMeta = { action, key, sessionId };
  let released = false;
  let timer = null;
  const stopTimer = () => {
    if (timer === null) return;
    const pending = timer;
    timer = null;
    try {
      timers.clearTimeout(pending);
    } catch {
      // 定时器已触发/已回收：释放路径不应因此中断。
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    stopTimer();
    releaseExecSlot();
  };
  const warn = (message, meta = {}) => {
    try {
      platform?.log?.('warn', message, { ...baseMeta, ...meta });
    } catch {
      // 日志失败不能影响槽位释放。
    }
  };
  const fallback = (error) => {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    try {
      metrics?.inc?.('threadSlotFallback');
    } catch {
      // metrics 不可用时释放仍然优先。
    }
    warn('[tools] thread_run: whenIdle unavailable; exec slot released early', { reason });
    release();
  };

  if (typeof platform?.whenIdle !== 'function') {
    release();
    return;
  }
  try {
    const idle = Promise.resolve(platform.whenIdle(target));
    timer = timers.setTimeout(() => {
      timer = null;
      try {
        metrics?.inc?.('threadSlotTimeout');
      } catch {
        // 计数失败不能阻止兜底释放。
      }
      warn('[tools] thread_run: exec slot force-released after idle timeout', {
        maxMs: THREAD_SLOT_HOLD_MAX_MS,
      });
      release();
    }, THREAD_SLOT_HOLD_MAX_MS);
    if (typeof timer?.unref === 'function') timer.unref();
    idle.then(
      () => release(),
      (error) => fallback(error),
    );
  } catch (error) {
    fallback(error);
  }
}

const SCOPE_SCHEMA = Object.freeze({ type: 'string', description: '作用域，默认 main' });
const LIMIT_SCHEMA = Object.freeze({
  type: 'integer', minimum: 1, maximum: 50, description: '最多返回条数',
});

/**
 * @param {object} deps
 * @param {import('../memory/store.js').Store} deps.store
 * @param {Function} deps.retrieve 四档检索函数（src/memory/retrieve.js）
 * @param {object} [deps.registry] src/thread/registry.js 的命名空间
 * @param {object} [deps.platform] src/platform/adapter.js 返回的适配器
 * @param {() => number} [deps.clock] 可注入时钟（毫秒），默认 Date.now
 * @param {string} [deps.cwd] thread_run 新建会话的默认工作目录
 * @param {string} [deps.timeZone=DEFAULT_TIMEZONE] cost_report 日界线所用 IANA 时区
 * @param {string|null} [deps.threadAgentPreset] 新建线程会话的宿主 preset；
 *   null/空串表示不传 agentPreset（走宿主默认 preset，与 task_run 一致）。
 * @param {() => (string|null|undefined)} [deps.currentScope] 当前会话 scope
 *   （pre-step 记录）；undefined=尚未路由（按 main），null=subagent（拒绝记忆工具）。
 * @param {() => {allowTask?: boolean, allowThread?: boolean, taskReason?: string,
 *   threadReason?: string}} [deps.budgetGate] M4 执行前闸门（每日熔断/RSS 降级）。
 * @param {{inc:Function}} [deps.metrics] 计数器（thread_run 槽位兜底/超时）。
 * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers] 可注入定时器。
 * @returns {Array<{name:string, description:string, parameters:object, execute:Function}>}
 */
/**
 * A1（v0.4.13）：把 worker 会话的 token 估算按 task 来源交给账本。
 *
 * 抽成独立函数便于在不起真实 worker 的情况下单测；任何异常/缺字段都静默。
 *
 * @param {unknown} result runTask 的返回值（可能带 tokensIn）
 * @param {{scope?: string, recordTokenUsage?: Function}} [options]
 * @returns {boolean} 是否真正记账
 */
export function reportTaskUsage(result, options = {}) {
  const { scope, recordTokenUsage } = options ?? {};
  if (typeof recordTokenUsage !== 'function') return false;
  const tokensIn = result !== null && typeof result === 'object' ? result.tokensIn : undefined;
  if (!Number.isFinite(tokensIn) || tokensIn <= 0) return false;
  recordTokenUsage({ source: 'task', scope: typeof scope === 'string' && scope !== '' ? scope : 'main', usage: { inputTokens: tokensIn } });
  return true;
}

export function createTools({
  store,
  retrieve,
  registry,
  platform,
  clock = Date.now,
  cwd,
  timeZone = DEFAULT_TIMEZONE,
  threadAgentPreset,
  subagentModel,
  taskLimits,
  recordTokenUsage,
  // SA-B3（v0.7.7 阶段 4）：task_run 收尾后的回执投递回调（接线层注入；缺省不投递）。
  taskReceipt,
  // W-1/W-5（阶段 6）：后台长任务配置（含 bg 节与 bgConcurrency）与主会话 id 解析。
  // bgConfig 可以是配置对象或返回配置的函数；缺省视为「未配置 bg.workRoot」。
  bgConfig,
  mainSessionId,
  // W77-M3（v0.7.8）：日志根与 launcher 的注入点。生产走模块默认值/真实
  // systemd-run；单测注入临时目录 + startBgProcess 替身，不碰真实 /opt 与真实 systemd。
  bgLogRoot,
  bgLauncher,
  // D21-H4（v0.7.10）：后台任务可用性（启动自检结果）。返回
  // `{ok:true, mode:'user'|'system', missingControllers}` 或
  // `{ok:false, reason, message}`；缺省视为「未做自检 = 可用」。
  bgAvailability,
  // M1（v0.7.17）：memory_write ask 档的裁决回调（async (prompt) => JSON）。
  // 生产接线层在 src/index.js registerTools 里注入 judgeFactDuplicates；缺省
  // undefined 时 ask 档按 new 保守插入（与 consolidate.js 同一口径）。
  judge,
  // M1（v0.7.17）：查重阈值；缺省走 dedupe.js 的 DEFAULT_DEDUPE_SKIP/ASK。
  dedupe,
  currentScope,
  budgetGate,
  metrics,
  timers = DEFAULT_TIMERS,
  vector,
} = {}) {
  if (store === null || store === undefined) {
    throw new TypeError('createTools: store is required');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createTools: clock must be a function');
  }
  if (!isValidTimeZone(timeZone)) {
    throw new TypeError(`createTools: unknown IANA time zone "${String(timeZone)}"`);
  }
  const nowMs = () => Number(clock());
  // M1（v0.7.17）：judge 可选；显式传了就必须是函数，避免生产接线漏传被静默吞掉。
  if (judge !== undefined && typeof judge !== 'function') {
    throw new TypeError('createTools: judge must be a function');
  }
  const judgeFn = typeof judge === 'function' ? judge : null;
  const dedupeOptions = {
    dedupeSkip: Number.isFinite(dedupe?.dedupeSkip) ? dedupe.dedupeSkip : undefined,
    dedupeAsk: Number.isFinite(dedupe?.dedupeAsk) ? dedupe.dedupeAsk : undefined,
  };
  // 一次裁决只有一组（memory_write 逐条写），失败/坏结构一律按 new 保守。
  // L5（v0.7.18）：查重裁决次数（用户 m02319 观察项：关键串偏宽 → 裁决调用偏多，
  // 只增成本不误判）。只统计 ask 档真正发起的 judge 调用，skip/new 不计。
  // 落 schema_meta（键 `dedupe_judge:<scope>`，值 {date,count}），不算加表；
  // 与 `compact_backfill:day:<scope>` / `bg_wake:*` 同一先例。计数失败绝不阻断写入。
  const DEDUPE_JUDGE_META_PREFIX = 'dedupe_judge:';
  const bumpDedupeJudge = (scope) => {
    try {
      const key = `${DEDUPE_JUDGE_META_PREFIX}${scope}`;
      const day = zonedDayKey(nowMs(), timeZone);
      const meta = typeof store.getMeta === 'function' ? store.getMeta(key) : null;
      let count = 0;
      if (typeof meta === 'string' && meta !== '') {
        try {
          const parsed = JSON.parse(meta);
          if (
            parsed !== null && typeof parsed === 'object' && parsed.date === day
            && Number.isFinite(Number(parsed.count))
          ) {
            count = Math.max(0, Math.trunc(Number(parsed.count)));
          }
        } catch {
          count = 0;
        }
      }
      if (typeof store.setMeta === 'function') store.setMeta(key, JSON.stringify({ date: day, count: count + 1 }));
    } catch {
      // 观察数据：任何异常都静默，不影响 memory_write 主流程。
    }
  };

  const judgeVerdict = async (factText, existingText) => {
    if (judgeFn === null) return null;
    try {
      const payload = await judgeFn(buildDedupeJudgePrompt([{ fact: factText, existing: existingText }]));
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const verdicts = parseDedupeVerdicts(parsed, 1);
      return verdicts === null ? null : verdicts[0];
    } catch {
      return null;
    }
  };
  const defaultCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  // V10-H1：null/空串统一为「不传 preset」；非空字符串只 trim（合法性由宿主判定）。
  const threadPreset = typeof threadAgentPreset === 'string' && threadAgentPreset.trim() !== ''
    ? threadAgentPreset.trim()
    : null;

  /**
   * D3（SA-B4，v0.7.7 阶段 4）：`subagent.model` 的裁决结果。
   *
   * **默认空 = 沿用主会话路由**（计划原文「模型可配（默认沿用主会话路由）」）；
   * 只有显式配置且命中 allowlist 才经 `agentOptions` 传到宿主，越界 warn 后回落。
   * @returns {string|null}
   */
  const subagentModelResolved = (() => {
    const raw = typeof subagentModel === 'string' ? subagentModel.trim() : '';
    if (raw === '') return null;
    if (SUBAGENT_MODEL_ALLOWLIST.includes(raw)) return raw;
    if (typeof platform?.log === 'function') {
      platform.log('warn', '[dsh-companion] subagent.model is not in the allowlist; using the main route', {
        model: raw,
        allowlist: SUBAGENT_MODEL_ALLOWLIST,
      });
    }
    return null;
  })();

  /**
   * 当前会话 scope：undefined=尚未路由（兼容旧调用，按 main）；null=subagent，
   * 没有长期记忆作用域，记忆工具一律拒绝。
   * @returns {string|null|undefined}
   */
  const scopeNow = () => (typeof currentScope === 'function' ? currentScope() : undefined);

  /**
   * W-1（阶段 6）：后台长任务配置。返回 null 表示「bg.workRoot 未配置」——
   * 工具直接报不可用，不去猜路径。
   * @returns {object|null}
   */
  const bgConfigNow = () => {
    const source = typeof bgConfig === 'function' ? bgConfig() : bgConfig;
    if (source === null || source === undefined || typeof source !== 'object') return null;
    const workRoot = typeof source?.bg?.workRoot === 'string' ? source.bg.workRoot.trim() : '';
    return workRoot === '' ? null : source;
  };

  /**
   * M4 闸门快照；闸门本身异常时放行（不能因为保护层故障阻断工具）。
   * @returns {{allowTask?: boolean, allowThread?: boolean, taskReason?: string,
   *   threadReason?: string}|null}
   */
  const gateNow = () => {
    if (typeof budgetGate !== 'function') return null;
    try {
      const gate = budgetGate();
      return gate !== null && typeof gate === 'object' ? gate : null;
    } catch {
      return null;
    }
  };

  /**
   * 解析并校验请求 scope：默认当前 session scope；显式 scope 必须与之相同。
   * @param {string|undefined} requested
   * @returns {{ok:true, scope:string}|{ok:false, reason:'scope_denied', scope:string|null}}
   */
  const resolveScope = (requested) => {
    const current = scopeNow();
    if (current === null) {
      return { ok: false, reason: 'scope_denied', scope: null };
    }
    const scope = current === undefined ? (requested ?? 'main') : current;
    if (requested !== undefined && requested !== scope) {
      return { ok: false, reason: 'scope_denied', scope: requested };
    }
    return { ok: true, scope };
  };

  return [
    {
      name: 'memory_search',
      description: '按关键词检索长期记忆（事实与情景），返回按预算裁切后的四档文本。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词' },
          scope: SCOPE_SCHEMA,
          limit: LIMIT_SCHEMA,
        },
        required: ['query'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        assertArgs(args, 'memory_search');
        if (typeof retrieve !== 'function') {
          return { ok: false, reason: 'retrieve-unavailable' };
        }
        const query = requireString(args.query, 'memory_search', 'query');
        const requested = optionalString(args.scope, 'memory_search', 'scope');
        const resolved = resolveScope(requested);
        if (!resolved.ok) return resolved;
        const limit = optionalInt(args.limit, 'memory_search', 'limit', 1, 50) ?? 20;
        return retrieve({ store, query, scope: resolved.scope, limit, vector });
      },
    },

    {
      name: 'memory_write',
      description: '写入一条用户显式给出的事实；会先做近似查重（同义只强化、被取代则置 superseded），返回 id / duplicateOf / verdict。',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: '自然语言事实，例如「我妈生日是五月」' },
          subject: { type: 'string', description: '主体，默认「我」' },
          predicate: { type: 'string', description: '谓语/关系，默认「记住」' },
          object: { type: 'string', description: '客体（可选）' },
          kind: { type: 'string', enum: [...FACT_KINDS], description: '事实类型，默认 other' },
          salience: { type: 'string', enum: [...SALIENCE], description: '显著性，默认 normal' },
          privacy: { type: 'string', enum: [...PRIVACY], description: '隐私级别，默认 normal' },
          scope: SCOPE_SCHEMA,
          source_excerpt: { type: 'string', description: '原话摘录（可选）' },
        },
        required: ['statement'],
        additionalProperties: false,
      },
      // M1（v0.7.17）：先查重再落库。skip=同 kind 高相似 → 只强化旧条；
      // ask=字面拿不准或跨 kind 关键串命中 → 一次小模型裁决 same/update/new；
      // 判定不可用（未注入/抛错/结构坏）一律按 new 保守插入，绝不静默丢写入。
      async execute(args = {}) {
        assertArgs(args, 'memory_write');
        const statement = requireString(args.statement, 'memory_write', 'statement');
        const kind = optionalEnum(args.kind, FACT_KINDS, 'memory_write', 'kind') ?? 'other';
        const salience = optionalEnum(args.salience, SALIENCE, 'memory_write', 'salience') ?? 'normal';
        const privacy = optionalEnum(args.privacy, PRIVACY, 'memory_write', 'privacy') ?? 'normal';
        const requested = optionalString(args.scope, 'memory_write', 'scope');
        const resolved = resolveScope(requested);
        if (!resolved.ok) return resolved;
        const scope = resolved.scope;
        const at = Math.floor(nowMs() / 1000);
        const byKind = collectActiveFactsByKind(store, scope);
        const classified = classifyDraftFact({ kind, statement }, byKind, dedupeOptions);
        const verdict = upgradeVerdictWithKeyPhrases({ kind, statement }, classified, buildKeyPhraseIndex(byKind));
        const insert = (label) => {
          const row = store.insertFact({
            scope,
            kind,
            subject_text: optionalString(args.subject, 'memory_write', 'subject') ?? '我',
            predicate: optionalString(args.predicate, 'memory_write', 'predicate') ?? '记住',
            object_text: optionalString(args.object, 'memory_write', 'object') ?? null,
            statement,
            source_kind: 'user_explicit',
            source_excerpt: optionalString(args.source_excerpt, 'memory_write', 'source_excerpt') ?? statement,
            salience,
            privacy,
          });
          return { ok: true, id: row.id, duplicateOf: null, verdict: label, statement: row.statement, scope: row.scope };
        };
        const reinforce = (target, label) => {
          if (typeof store.reinforceFact === 'function') store.reinforceFact({ id: target.id, scope, at, reason: 'dedupe_write', actor: 'user' });
          return {
            ok: true,
            id: target.id,
            duplicateOf: target.id,
            verdict: label,
            statement: typeof target.statement === 'string' ? target.statement : statement,
            scope,
          };
        };
        if (verdict.verdict === 'skip' && verdict.match !== null) return reinforce(verdict.match, 'reinforced');
        if (verdict.verdict === 'ask' && verdict.match !== null) {
          const target = verdict.match;
          // L5（v0.7.18 复核增量 (b)）：只在真正发起 judge 调用时 +1。`judgeFn === null` 时
          // `judgeVerdict` 直接返回 null、没有 LLM 调用，计入会与本版 CHANGELOG 的
          // 「只计真实裁决调用」矛盾（用户意图是观察 LLM 成本）；生产恒注入 judge
          // （`src/index.js` 的 createTools 接线），故对生产行为零影响。
          if (judgeFn !== null) bumpDedupeJudge(scope);
          const judged = await judgeVerdict(statement, typeof target.statement === 'string' ? target.statement : '');
          if (judged === 'same') return reinforce(target, 'reinforced');
          if (judged === 'update') {
            // 用户红线：pinned 不得被 update supersede；退化为插新条（不阻断显式写入）。
            const existing = typeof store.getFact === 'function' ? store.getFact(target.id) : null;
            if (existing?.salience === 'pinned') {
              platform?.log?.('warn', '[dsh-companion] memory_write update target is pinned; inserted a new fact instead', { targetId: target.id });
              return insert('inserted');
            }
            const row = insert('updated');
            store.updateFact(target.id, { status: 'superseded', superseded_by: row.id });
            return { ...row, duplicateOf: target.id };
          }
          return insert('inserted');
        }
        return insert('inserted');
      },
    },

    {
      name: 'memory_forget',
      description: '按 id 遗忘记忆：默认 S1（7 天后物理删除）；immediate+confirm 时立即物删。可传单个 id，也可传 ids 批量（≤50，逐条独立、批量一次收尾）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '事实或情景 id（单条路径）' },
          ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 50,
            description: '批量 id 列表（≤50，自动去重；与 id 二选一）',
          },
          kind: {
            type: 'string',
            enum: ['fact', 'episode'],
            description: '无 `fact_` / `ep_` 前缀的 id 按此种类处理，默认 fact',
          },
          immediate: {
            type: 'boolean',
            description: '跳过 7 天冷静期立即物理删除（需 confirm=true）',
          },
          confirm: { type: 'boolean', description: '确认立即删除（immediate 的二次确认）' },
        },
        required: [],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'memory_forget');
        const immediate = optionalBoolean(args.immediate, 'memory_forget', 'immediate') ?? false;
        const confirm = optionalBoolean(args.confirm, 'memory_forget', 'confirm') ?? false;
        const current = scopeNow();
        // M2（v0.7.17）：批量路径。逐条独立（跨 scope / 找不到只让该条失败），
        // 状态板与（可选）物删在 forgetMany 里各收尾一次；单条路径一字不动。
        if (Array.isArray(args.ids)) {
          if (current === null) return { ok: false, reason: 'scope_denied', scope: null };
          const kind = optionalEnum(args.kind, ['fact', 'episode'], 'memory_forget', 'kind') ?? 'fact';
          if (args.ids.length === 0) {
            throw new TypeError('[tools] memory_forget: ids must contain at least one id');
          }
          if (args.ids.length > 50) {
            throw new TypeError('[tools] memory_forget: ids must contain at most 50 entries');
          }
          for (const entry of args.ids) requireString(entry, 'memory_forget', 'ids');
          return forgetMany({
            store,
            ids: args.ids,
            kind,
            at: nowMs(),
            immediate,
            confirm,
            ...(current === undefined ? {} : { scope: current }),
          });
        }
        const id = requireString(args.id, 'memory_forget', 'id');
        if (current === null) return { ok: false, reason: 'scope_denied', scope: null };
        const fact = store.getFact(id);
        if (fact && current !== undefined && fact.scope !== current) {
          return { ok: false, reason: 'scope_denied', scope: fact.scope };
        }
        return forgetMemory({
          store,
          kind: 'fact',
          id,
          at: nowMs(),
          immediate,
          confirm,
          ...(current === undefined ? {} : { scope: current }),
        });
      },
    },

    {
      name: 'reminder_add',
      description: '新增一条提醒（到点由调度器触发，不参与遗忘曲线）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '提醒标题' },
          kind: { type: 'string', enum: [...REMINDER_KINDS], description: '提醒类型，默认 todo' },
          due_at: { type: 'integer', description: '到期时间（Unix 秒），可选' },
          detail: { type: 'string', description: '补充说明（可选）' },
          counterparty: { type: 'string', description: '相关的人/方（可选）' },
          // A4（v0.4.13）：重复提醒。支持 FREQ=DAILY / FREQ=WEEKLY;BYDAY=… 与
          // INTERVAL / COUNT / UNTIL；不支持的形式明确返回 rrule_unsupported。
          rrule: { type: 'string', description: '重复规则（RFC 5545 子集，如 FREQ=DAILY 或 FREQ=WEEKLY;BYDAY=MO,TH），可选' },
          scope: SCOPE_SCHEMA,
        },
        required: ['title'],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'reminder_add');
        const title = requireString(args.title, 'reminder_add', 'title');
        let kind = optionalEnum(args.kind, REMINDER_KINDS, 'reminder_add', 'kind') ?? 'todo';
        const dueAt = optionalInt(args.due_at, 'reminder_add', 'due_at', 0, Number.MAX_SAFE_INTEGER);
        const requested = optionalString(args.scope, 'reminder_add', 'scope');
        const resolved = resolveScope(requested);
        if (!resolved.ok) return resolved;

        // A4：带 rrule 就是系列提醒；第一次触发点由规则算，不能直接拿 due_at 当唯一时间。
        // 空白 rrule 视为「没给规则」，与 kind=repeat 一样要求补规则；避免把
        // 「随便写了几个空格」当成合法系列。
        if (typeof args.rrule === 'string' && args.rrule.trim() === '') {
          return { ok: false, reason: 'rrule_required', message: 'rrule 不能为空字符串' };
        }
        const rruleText = optionalString(args.rrule, 'reminder_add', 'rrule');
        let rrule = null;
        let firstAt = dueAt ?? null;
        if (rruleText !== undefined) {
          const parsed = parseRRule(rruleText, { timeZone });
          if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.detail };
          const anchor = dueAt ?? Math.floor(nowMs() / 1000);
          const next = nextOccurrence({
            rule: parsed.rule,
            anchorAt: anchor,
            afterAt: anchor - 1,
            timeZone,
          });
          if (next.ok !== true) {
            return { ok: false, reason: next.reason ?? 'rrule_unsupported', message: next.detail ?? '' };
          }
          rrule = rruleText.trim();
          firstAt = next.at;
          // M-3：有 rrule 就是系列；kind 缺省 todo 也要按 repeat 存，否则首投后置 fired 不再推进。
          kind = 'repeat';
        } else if (kind === 'repeat') {
          return { ok: false, reason: 'rrule_required', message: 'kind=repeat 需要 rrule' };
        }

        // T3.1（v0.7.19）：同 scope 待触发提醒条数护栏。计数走精确 COUNT(*)
        // （listReminders 单 status + LIMIT 截断，数不准）；`>= 50` 即拒绝本次新增，
        // 已有 50 条时第 51 条被拦。校验放在 insertReminder 之前，拒绝时不落行。
        const activeCount = store.countActiveReminders(resolved.scope, REMINDER_ACTIVE_STATUSES);
        if (activeCount >= REMINDER_ACTIVE_LIMIT) {
          return {
            ok: false,
            reason: 'reminder_cap',
            message: `同一 scope 待触发提醒已有 ${activeCount} 条（上限 ${REMINDER_ACTIVE_LIMIT} 条），请先用 reminder_done 清理不再需要的提醒，再新增`,
            count: activeCount,
            limit: REMINDER_ACTIVE_LIMIT,
          };
        }

        const row = store.insertReminder({
          scope: resolved.scope,
          kind,
          title,
          detail: optionalString(args.detail, 'reminder_add', 'detail') ?? null,
          counterparty: optionalString(args.counterparty, 'reminder_add', 'counterparty') ?? null,
          due_at: firstAt,
          due_granularity: firstAt === null ? 'none' : 'exact',
          next_fire_at: firstAt,
          rrule,
        });
        return { ok: true, reminder: row };
      },
    },

    {
      name: 'reminder_done',
      description: '把一条提醒标记为完成。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '提醒 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'reminder_done');
        const id = requireString(args.id, 'reminder_done', 'id');
        const row = store.getReminder(id);
        if (!row) return { ok: false, id, reason: 'not-found' };
        if (row.status === 'done') return { ok: true, id, alreadyDone: true, reminder: row };
        if (row.status === 'cancelled') return { ok: false, id, reason: 'cancelled', reminder: row };

        const nowSec = Math.floor(nowMs() / 1000);
        const info = store.db
          .prepare(
            `UPDATE reminders
                SET status = 'done', closed_at = ?, updated_at = unixepoch()
              WHERE id = ? AND deleted_at IS NULL
                AND status NOT IN ('done','cancelled')`,
          )
          .run(nowSec, id);
        return {
          ok: info.changes > 0,
          id,
          changed: info.changes > 0,
          reminder: store.getReminder(id),
        };
      },
    },

    {
      name: 'thread_list',
      description: '列出线程目录，可按状态或关键词过滤。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...THREAD_STATUSES], description: '按状态过滤' },
          query: { type: 'string', description: '按 key/名称/描述过滤（可选）' },
          limit: LIMIT_SCHEMA,
        },
        required: [],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'thread_list');
        const status = optionalEnum(args.status, THREAD_STATUSES, 'thread_list', 'status');
        const limit = optionalInt(args.limit, 'thread_list', 'limit', 1, 50) ?? 50;
        const query = optionalString(args.query, 'thread_list', 'query')?.toLowerCase();
        let items = store.listThreads({ status, limit });
        if (query) {
          items = items.filter((row) => [row.key, row.name, row.description]
            .some((value) => String(value ?? '').toLowerCase().includes(query)));
        }
        return { items, count: items.length };
      },
    },

    {
      // v0.7.19 T4.3：只读的投递历史。独立工具而不是给 thread_list 加参数，
      // 因为 thread_list 是无参目录（required: []），加参会改变其返回形态。
      name: 'thread_history',
      description:
        '查看某个线程最近做过什么：返回最近 N 次投递的时间、目标首句、回执首句与终态。'
        + '只读，不新建线程也不投递；不传 limit 默认 10 条，最多 30 条。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '线程 key' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 1000,
            description: '返回条数（可选，默认 10；超过 30 按 30 计）',
          },
          offset: { type: 'integer', minimum: 0, maximum: 1000, description: '分页偏移（可选，默认 0）' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'thread_history');
        const key = requireString(args.key, 'thread_history', 'key');
        // 规格口径是「上限 30 → 超出钳到 30」，所以 limit 不用 optionalInt 的
        // 范围拒绝，而是校验正整数后自己钳；schema 的 maximum 只挡明显异常入参。
        const rawLimit = args.limit ?? THREAD_HISTORY_DEFAULT_LIMIT;
        if (!Number.isInteger(rawLimit) || rawLimit < 1) {
          throw new TypeError('[tools] thread_history.limit must be a positive integer');
        }
        const limit = Math.min(rawLimit, THREAD_HISTORY_MAX_ENTRIES);
        const offset = optionalInt(args.offset, 'thread_history', 'offset', 0, 1000) ?? 0;
        const all = readThreadHistory(store, key);
        const items = all.slice(offset, offset + limit).map((entry) => ({
          ...entry,
          atText: threadHistoryTimeText(entry.at),
        }));
        return {
          key,
          count: items.length,
          total: all.length,
          limit,
          offset,
          items,
        };
      },
    },

    {
      name: 'thread_run',
      description:
        '需要多天反复推进、同类事沿用的用这个：复用或新建一个线程会话，并把目标投递进去；'
        + '一次性的活直接用 task_run。新建之前先用 thread_list 找同类 key，'
        + '已有同类线程就复用（key 传已有 key），确实没有再用 key=new 新建。'
        // v0.7.19 T4.2：重活交线程（只改文案，不加拦截逻辑）。
        + '预计要读大文件、批量跑命令、抓网页或日志的活交 thread_run，主会话只收结论，不把原始输出贴回主会话。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '线程 key；新建时传 new' },
          name: { type: 'string', description: '线程名（key=new 时必填）' },
          goal: { type: 'string', description: '投递给线程的目标/任务（可选）' },
          // v0.7.19 T4.1：线程常驻职责。additionalProperties:false，必须显式声明。
          charter: {
            type: 'string',
            maxLength: THREAD_CHARTER_MAX_CODEPOINTS,
            description: '线程常驻职责（可选，≤300 字）：写入/更新线程 description，'
              + '之后每次投递都带一行「线程职责：…」',
          },
          cwd: { type: 'string', description: '新会话工作目录（可选）' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      async execute(args = {}, exec = {}) {
        assertArgs(args, 'thread_run');
        const key = requireString(args.key, 'thread_run', 'key');
        const name = optionalString(args.name, 'thread_run', 'name');
        const goal = optionalString(args.goal, 'thread_run', 'goal');
        if (exceedsGoalLimit(goal)) return { ok: false, reason: 'goal_too_long' };
        const charter = optionalString(args.charter, 'thread_run', 'charter');
        if (charter !== undefined && Array.from(charter).length > THREAD_CHARTER_MAX_CODEPOINTS) {
          return { ok: false, reason: 'charter_too_long' };
        }
        const gate = gateNow();
        if (gate !== null && gate.allowThread === false) {
          return { ok: false, reason: gate.threadReason ?? 'memory_main_only' };
        }
        const plan = planThreadRun(registry, { store, key, name });
        if (plan.action === 'reject') {
          return { ok: false, action: 'reject', key: plan.key ?? key, reason: plan.reason };
        }

        // SA-B1/SA-B2（阶段 4）：宿主子代理能力 + 存活 parent。
        // 宿主 UNAUTHORIZED 守卫要求 parent 是精确存活的 Agent 对象
        // （`dsh-subagent/src/index.ts:275-277`），所以只认 `exec.agent`；
        // 拿不到就走旧路径（createSession / prompt），不猜 parent。
        const sender = exec?.agent !== null && typeof exec?.agent === 'object' ? exec.agent : null;
        const subagentsReady = platform?.capabilities?.subagents === true && sender !== null;
        const canContinue = platform?.capabilities?.subagentMessages === true && sender !== null;

        // 新建分支返回的句柄直接用于 whenIdle，避免线程尚未进入 ctx.agents 时退化。
        let createdHandle = null;
        // C5-H1b：同一次 thread_run 的所有投递共用一个 requestId；宿主据此把
        // 「用户输入」与运行时内部消息区分开，重试不会产生新的用户消息。
        const runId = makeExecutionId('run', nowMs());
        const requestId = `companion-thread:${plan.key}:${runId}`;

        const run = async () => {
          const nowSec = Math.floor(nowMs() / 1000);
          // v0.7.19 T4.3（G1=A 授权的写入点）：每次 thread_run 只追加一条滚动历史，
          // 记在 schema_meta 里（零 DDL）。回执落地后按 requestId 更新同一条，所以
          // 续派失败重建不会产生两条；没有 activation.result 的路径停在 dispatched。
          appendThreadHistory(store, plan.key, {
            at: nowSec,
            goalFirst: threadHistoryFirstSentence(goal),
            receiptFirst: null,
            status: 'dispatched',
            requestId,
            action: plan.action,
          });
          if (plan.action === 'reuse') {
            let thread = store.getThread(plan.key);
            if (!thread) {
              return { ok: false, action: 'reuse', key: plan.key, reason: 'thread-row-missing' };
            }
            // v0.7.19 T4.1：复用时传了 charter 就覆盖常驻职责，不传沿用库里的值。
            // description 列 NOT NULL，upsert 展开 `...thread` 时显式覆盖即可。
            const description = charter ?? thread.description;
            // v0.7.20 M1：只有显式设过 charter 的线程才注入「线程职责」行。存量线程的
            // description 是当年第一条 goal，v0.7.19 把它当职责注入属于误导；标记存
            // `schema_meta`（零 DDL），未设过的线程投递文本逐字回到 v0.7.18。
            const withCharter = threadCharterActive(store, plan.key, charter);
            if (charter !== undefined) markThreadCharterSet(store, plan.key);
            const charterPatch = charter === undefined ? {} : { description: charter };
            // SA-B2：有续派锚 → 走宿主 sendMessage（运行中下一 step 收、空闲开新
            // turn、冷目标在树根下恢复，`dsh-subagent/src/index.ts:356-375`）。
            const anchor = typeof thread.child_session_id === 'string' && thread.child_session_id !== ''
              ? thread.child_session_id
              : null;
            if (anchor !== null && canContinue) {
              let continued = false;
              if (goal !== undefined) {
                try {
                  // D21-M2（v0.7.10）：第 4 参必须是真 AbortSignal（宿主会调
                  // `signal.throwIfAborted()`）；旧代码在没有 exec.signal 时传
                  // `{}`，续派必然抛错并退化成重建会话。
                  await platform.sendToSubagent(
                    sender,
                    anchor,
                    [{ type: 'text', text: withCharter ? `线程职责：${description}\n${goal}` : goal }],
                    { signal: exec?.signal ?? deliverySignal({ requestId }) },
                  );
                  continued = true;
                } catch (error) {
                  // 保守默认：目标已不可恢复（UNAVAILABLE 等）→ 重建会话并更新锚，
                  // 回执里注明「已重建」（可逆，见回报「与计划不一致」清单）。
                  if (typeof platform?.log === 'function') {
                    platform.log('warn', '[dsh-companion] thread continuation failed; rebuilding', {
                      key: plan.key,
                      anchor,
                      error: errorMessage(error),
                    });
                  }
                  const rebuilt = await createThreadSession({ goal, name, key: plan.key, nowSec, requestId, sender });
                  if (rebuilt.ok !== true) return rebuilt;
                  return { ...rebuilt, action: 'reuse', reactivated: false, rebuilt: true, prompted: true };
                }
              }
              const updated = store.upsertThread({
                ...thread,
                ...charterPatch,
                status: 'active',
                child_session_id: anchor,
                last_progress: goal ?? thread.last_progress,
                last_active_at: nowSec,
              });
              return {
                ok: true,
                action: 'reuse',
                key: plan.key,
                sessionId: anchor,
                reactivated: false,
                continued,
                prompted: continued,
                thread: updated,
              };
            }
            // 旧线程（无锚）：先按旧路径恢复/打开会话并投递一次，首续派时建立锚。
            let reactivated = false;
            if (thread.status !== 'active') {
              if (typeof platform?.unarchiveSession !== 'function') {
                return {
                  ok: false,
                  action: 'reuse',
                  key: plan.key,
                  reason: 'unarchive-unavailable',
                };
              }
              await platform.unarchiveSession(thread.session_id);
              thread = store.upsertThread({
                ...thread,
                ...charterPatch,
                status: 'active',
                last_progress: goal ?? thread.last_progress,
                last_active_at: nowSec,
              });
              reactivated = true;
            }
            // 只更新职责、没有新目标时也必须落库（下面的 upsert 只在有 goal 时执行）。
            if (charter !== undefined && goal === undefined) {
              thread = store.upsertThread({ ...thread, description: charter });
            }
            let prompted = false;
            if (goal !== undefined) {
              if (typeof platform?.prompt !== 'function') {
                return {
                  ok: false,
                  action: 'reuse',
                  key: plan.key,
                  reason: 'prompt-unavailable',
                };
              }
              await platform.prompt({
                sessionId: thread.session_id,
                content: [{ type: 'text', text: withCharter ? `线程职责：${description}\n${goal}` : goal }],
                requestId,
              });
              store.upsertThread({
                ...thread,
                ...charterPatch,
                last_progress: goal,
                last_active_at: nowSec,
              });
              prompted = true;
            }
            return {
              ok: true,
              action: 'reuse',
              key: plan.key,
              sessionId: thread.session_id,
              reactivated,
              prompted,
            };
          }

          // 新建分支：有子代理能力且给了目标 → 走 startActivation（拿 childId 当锚）；
          // 没有目标或没有能力 → 旧 createSession 路径（与历史行为一致）。
          if (subagentsReady && goal !== undefined) {
            return createThreadSession({ goal, name, key: plan.key, nowSec, requestId, sender });
          }
          if (typeof platform?.createSession !== 'function') {
            return { ok: false, action: 'create', key: plan.key, reason: 'session-unavailable' };
          }
          const targetCwd = optionalString(args.cwd, 'thread_run', 'cwd') ?? defaultCwd;
          if (targetCwd === undefined) {
            // cwd 必须由接线层从宿主注入；不读 process.cwd()（L3）。
            return { ok: false, action: 'create', key: plan.key, reason: 'cwd-unavailable' };
          }
          const request = { cwd: targetCwd };
          if (threadPreset !== null) request.agentPreset = threadPreset;
          let created;
          try {
            created = await platform.createSession(request);
          } catch (error) {
            // V10-H1：宿主的 preset 列表运行时才可知；配置了宿主不认识的 preset
            // 时返回可诊断的 preset_unknown，不把异常抛给模型/用户。
            if (!isUnknownAgentPresetError(error)) throw error;
            return {
              ok: false,
              action: 'create',
              key: plan.key,
              reason: 'preset_unknown',
              message: errorMessage(error),
            };
          }
          createdHandle = created;
          const sessionId = sessionIdOf(created);
          if (sessionId === null) {
            throw new Error('[tools] thread_run: createSession() returned no session id');
          }

          // v0.7.19 T4.1：新建时职责优先用 charter，其次 goal，最后兜底短名。
          const threadDescription = charter ?? goal ?? `线程：${plan.key}`;
          // v0.7.20 M1：新建线程只有显式给了 charter 才注入职责行；没给就逐字回到
          // v0.7.18（纯 goal），并把「设过 charter」标记写到 schema_meta。
          const withCharter = charter !== undefined;
          if (withCharter) markThreadCharterSet(store, plan.key);
          const thread = store.upsertThread({
            key: plan.key,
            name: name ?? plan.key,
            session_id: sessionId,
            description: threadDescription,
            last_progress: goal ?? null,
            last_active_at: nowSec,
            status: 'active',
          });

          let prompted = false;
          if (goal !== undefined) {
            await platform.prompt({
              sessionId,
              content: [{ type: 'text', text: withCharter ? `线程职责：${threadDescription}\n${goal}` : goal }],
              requestId,
            });
            prompted = true;
          }
          return {
            ok: true,
            action: 'create',
            key: plan.key,
            sessionId,
            prompted,
            thread,
          };
        };

        /**
         * SA-B1/SA-B2（阶段 4）：用宿主 startActivation 新建线程会话。
         *
         * 线程 key 是中文短名，直接当宿主 name 会被拒（1-32 位 `[a-z0-9-]`、
         * 首字符字母、`lead` 保留，见 `dsh-subagent/src/types.ts:29-46`）；
         * A12 的口径是 `t` + key 的 UTF-8 hex，原名放 label。
         * childId 回写 `threads.child_session_id` 作为续派锚。
         *
         * @param {{goal: string, name?: string, key: string, nowSec: number,
         *   requestId: string, sender: object}} input
         * @returns {Promise<object>}
         */
        async function createThreadSession({ goal: threadGoal, name: threadName, key: threadKey, nowSec, requestId, sender }) {
          const hostName = normalizeSubagentName(threadSubagentName(threadKey));
          // v0.7.19 T4.1：startSubagent 的 prompt 在 upsert 之前，职责必须先算成
          // 局部变量（不能读库）；charter 直接从 execute 闭包取，不层层传参。
          // v0.7.20 M1：本函数也被「续派失败重建」复用，那时闭包里没有 charter，但
          // 线程可能早就设过职责；此时要沿用库里的 description，否则首条 prompt 会
          // 丢职责行，或把 goal 冒充成职责（`线程职责：<goal>` 正是本版要修的误导）。
          const existingThread = typeof store?.getThread === 'function' ? store.getThread(threadKey) : null;
          const withCharter = charter !== undefined
            || (existingThread !== null && threadCharterActive(store, threadKey, undefined));
          const threadDescription = charter
            ?? (withCharter && existingThread !== null ? existingThread.description : null)
            ?? threadGoal
            ?? `线程：${threadKey}`;
          // v0.7.20 M1：标记必须在 startSubagent（首条投递）之前写，否则续派失败
          // 重建后的首条投递会丢职责行；prompt 本身回到 v0.7.18 的纯 threadGoal。
          if (charter !== undefined) markThreadCharterSet(store, threadKey);
          let activation;
          try {
            activation = await platform.startSubagent({
              provider: 'spawn',
              delivery: 'caller',
              agentPreset: threadPreset ?? 'minimal',
              maxDepth: 1,
              label: threadName ?? threadKey,
              ...(hostName === null ? {} : { name: hostName }),
              prompt: [{ type: 'text', text: withCharter ? `线程职责：${threadDescription}\n${threadGoal}` : threadGoal }],
              parent: sender,
              signal: exec?.signal ?? new AbortController().signal,
              ...(subagentModelResolved === null ? {} : { agentOptions: { model: subagentModelResolved } }),
              ...(defaultCwd === undefined ? {} : { cwd: defaultCwd }),
            });
          } catch (error) {
            if (!isUnknownAgentPresetError(error)) throw error;
            return {
              ok: false,
              action: 'create',
              key: threadKey,
              reason: 'preset_unknown',
              message: errorMessage(error),
            };
          }
          const sessionId = typeof activation?.childId === 'string' ? activation.childId : null;
          if (sessionId === null) {
            throw new Error('[tools] thread_run: startActivation() returned no child id');
          }
          const thread = store.upsertThread({
            key: threadKey,
            name: threadName ?? threadKey,
            session_id: sessionId,
            child_session_id: sessionId,
            description: threadDescription,
            last_progress: threadGoal ?? null,
            last_active_at: nowSec,
            status: 'active',
          });
          // 结果消息由宿主交给 IM/会话通道；这里只把 anchor 记下来，避免激活
          // 之后的网络/模型往返阻塞 thread_run 工具本身。
          //
          // T120-M1（v0.7.7 阶段 5）：回执落地后把「结论首句」写回
          // `threads.last_progress`，状态板线程目录才能显示真实进展而不是一句
          // 当初的 goal。不 await、失败只打日志（工具调用已返回）。
          Promise.resolve(activation.result)
            .then((result) => {
              try {
                const outcome = mapStopReason(result?.stopReason);
                const receipt = buildSubagentReceipt({
                  status: outcome.status,
                  structured: result?.structured,
                  text: outputText(result?.output),
                  durationMs: 0,
                });
                const progress = progressFromReceipt(receipt);
                // v0.7.19 T4.3：回执按 requestId 回填同一条历史（首句 + 终态）；
                // progress 为空时也回填终态，threads.last_progress 的既有写法不动。
                updateThreadHistoryReceipt(store, threadKey, requestId, {
                  receiptFirst: progress,
                  status: outcome.status,
                });
                if (progress === null) return;
                const latest = store.getThread(threadKey) ?? thread;
                store.upsertThread({
                  ...latest,
                  last_progress: progress,
                  last_active_at: Math.floor(nowMs() / 1000),
                });
              } catch (error) {
                platform.log('warn', '[dsh-companion] thread progress update failed', {
                  key: threadKey,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            })
            .catch(() => {});
          return {
            ok: true,
            action: 'create',
            key: threadKey,
            sessionId,
            prompted: true,
            thread,
            requestId,
          };
        }

        // N-M2：thread_run 会真正驱动一个会话执行，必须与 task_run 共用执行槽；
        // 没有 goal 只是复用/新建线程行，不占槽。
        if (goal === undefined) return run();
        if (!tryAcquireExecSlot()) {
          return { ok: false, action: plan.action, key: plan.key, reason: 'busy' };
        }
        let handedOff = false;
        try {
          const result = await run();
          if (result?.ok === true && result.prompted === true
            && typeof result.sessionId === 'string' && result.sessionId !== '') {
            handedOff = true;
            // create 用刚返回的句柄；reuse 只能靠会话 id 反查，反查失败会走 fallback 日志。
            holdExecSlotUntilIdle(platform, createdHandle ?? result.sessionId, {
              sessionId: result.sessionId,
              action: result.action,
              key: result.key,
              metrics,
              timers,
            });
          }
          return result;
        } finally {
          if (!handedOff) releaseExecSlot();
        }
      },
    },

    {
      name: 'task_run',
      description:
        '一次性的活用这个：把一件独立任务交给子代理执行，跑完就结束。'
        + '需要多天反复推进、同类事沿用的用 thread_run。'
        // v0.7.19 T4.2：重活交任务（只改文案，不加拦截逻辑）。
        + '预计要读大文件、批量跑命令、抓网页或日志的活交 task_run，主会话只收结论，不把原始输出贴回主会话。'
        + '**立即返回** {ok, status:"started", taskId, title}，子代理在后台继续跑；'
        + '结果稍后以回执（task_report）送达会话，本轮先告诉用户「已派出」。'
        + '并发上限 2（subagentConcurrency），忙时排队最多 2 个，超出立即返回 busy；'
        + '软超时 600s 只告警，硬超时 900s 中止。立即返回 started，结果稍后以回执送达。派出后直接回复用户，不要在本轮 sleep 或轮询等结果；要取消用 task_cancel，不要用 kill / pgrep / systemctl。',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: '任务目标（自包含，worker 不读长期记忆）',
          },
          title: {
            type: 'string',
            maxLength: 80,
            description: '任务标题（可选，只用于回执与审计）',
          },
        },
        required: ['goal'],
        additionalProperties: false,
      },
      async execute(args = {}, exec = {}) {
        assertArgs(args, 'task_run');
        const goal = requireString(args.goal, 'task_run', 'goal');
        const title = optionalString(args.title, 'task_run', 'title');
        const gate = gateNow();
        if (gate !== null && gate.allowTask === false) {
          return { ok: false, reason: gate.taskReason ?? 'daily_budget_exceeded' };
        }
        // SA-B1（阶段 4）：宿主有子代理服务时走派活路径（不需要 sessionController
        // 的 createSession/prompt/whenIdle）；没有则回退 worker 直投路径。
        const subagentsReady = platform?.capabilities?.subagents === true
          && exec?.agent !== null && typeof exec?.agent === 'object';
        if (!subagentsReady
          && (typeof platform?.createSession !== 'function'
            || typeof platform?.prompt !== 'function'
            || typeof platform?.whenIdle !== 'function')) {
          return { ok: false, reason: 'session-unavailable' };
        }
        const scope = scopeNow();
        // C5-H1b：一次 task_run 执行对应一个稳定 claimKey，worker 的 prompt
        // requestId = companion-task:<taskId>:<claimKey>，重试不换 id。
        const claimKey = makeExecutionId('claim', nowMs());
        const runScope = typeof scope === 'string' && scope !== '' ? scope : 'main';
        // D21-H2（v0.7.10）：这里**不 await** 执行 Promise——宿主的工具调用会等
        // execute 返回。执行信号由 task/run.js 自持（硬超时 / abortAll），与主轮次
        // 的 `exec.signal` 解耦，结果只走 SA-B3 的 onReceipt 回执。
        // SA-B3 的 onReceipt 回执。
        const started = startBackgroundTask({
          platform,
          store,
          goal,
          title,
          at: nowMs(),
          scope: runScope,
          cwd: defaultCwd,
          claimKey,
          // SA-B1：派活所需的存活 parent（宿主 UNAUTHORIZED 守卫要求精确对象，
          // 见 dsh-subagent/src/index.ts:275-277）+ D3 的模型裁决结果。
          agent: subagentsReady ? exec.agent : null,
          subagent: subagentsReady
            ? {
              enabled: true,
              model: subagentModel,
              label: title ?? goal.slice(0, 32),
              logger: typeof platform?.log === 'function'
                ? (message, meta) => platform.log('warn', message, meta)
                : undefined,
            }
            : null,
          ...(taskLimits === undefined ? {} : { limits: taskLimits }),
          // SA-B3（阶段 4）：回执投回主会话由接线层决定（tools 不认识 proactive）。
          ...(typeof taskReceipt === 'function' ? { onReceipt: taskReceipt } : {}),
        });
        // busy / 额度闸门 / session-unavailable 等前置拒绝仍是**同步**返回值。
        if (started.ok !== true) return started;
        // A1（v0.4.13）：worker 会话的 token 估算按 task 来源入账；记账是旁路。
        Promise.resolve(started.done).then(
          (result) => reportTaskUsage(result, { scope: runScope, recordTokenUsage }),
          () => {},
        );
        return {
          ok: true,
          status: 'started',
          taskId: started.taskId,
          title: title ?? null,
          queued: started.queued === true,
          note: '已派出，结果稍后以回执送达；本轮不必等待。',
        };
      },
    },

    {
      name: 'bg_run',
      description:
        '把长耗时脚本（训练/构建/批处理）丢到后台跑，立即返回 id，本轮可以正常结束。'
        + '只做边界限制、不审脚本内容：cwd 与脚本必须在 bg.workRoot 内（符号链接与 .. 跳出会被拒），'
        + 'argv[0] 只允许 bg.interpreters（python3/bash/node），argv 数组直传不经 shell。'
        + '只该用于预计超过 10 分钟的任务；10 分钟以内的活直接用 task_run/thread_run，'
        + '否则光调度与轮询的开销就不划算。deadline_min 必填且不超过 bg.maxDeadlineMin。'
        + '同一时刻只跑 bgConcurrency（默认 1）个，满额会返回正在运行的任务。'
        + '结束后会唤醒发起它的子代理，并给主会话投一条回执（终态 + 退出码 + 日志尾部 ≤2KB + 日志路径）。派出后直接回复用户，不要在本轮 sleep 或轮询等结果；要提前停下用 task_cancel（它按同一模式 systemctl stop 该 unit），不要用 kill / pgrep / systemctl。'
        + 'bg.workRoot 未配置时本工具不可用。',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            description: 'argv 数组：argv[0] 是解释器（python3/bash/node），argv[1] 是 workRoot 内的脚本，后续为传给脚本的参数',
          },
          cwd: {
            type: 'string',
            description: '工作目录（相对 bg.workRoot 或绝对路径，必须落在 workRoot 内）',
          },
          deadline_min: {
            type: 'integer',
            description: '预计最长运行分钟数（必填；超时会被 RuntimeMaxSec 终止，插件侧兜底 TERM→KILL）',
          },
          label: {
            type: 'string',
            description: '任务标签（可选，用于回执与审计）',
          },
        },
        required: ['argv', 'cwd', 'deadline_min'],
        additionalProperties: false,
      },
      async execute(args = {}, exec = {}) {
        assertArgs(args, 'bg_run');
        const argv = args.argv;
        if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) {
          return { ok: false, reason: 'bad-argv', message: 'argv 必须是字符串数组' };
        }
        const bgConfig = typeof bgConfigNow === 'function' ? bgConfigNow() : null;
        if (bgConfig === null) {
          return { ok: false, reason: 'not-configured', message: '不可用：未配置 bg.workRoot（后台长任务的工作目录根）' };
        }
        // D21-H4（v0.7.10）：启动自检失败时后台任务整体不可用——别让用户以为派出去了
        // （D21-H3 的「被拒当成功」就是同类误导）。
        const availability = typeof bgAvailability === 'function' ? bgAvailability() : null;
        if (availability !== null && availability !== undefined && availability.ok === false) {
          return {
            ok: false,
            reason: 'bg-unavailable',
            message: typeof availability.message === 'string' && availability.message !== ''
              ? availability.message
              : '后台任务不可用：systemd 自检失败',
          };
        }
        const cwdText = requireString(args.cwd, 'bg_run', 'cwd');
        const deadlineMin = args.deadline_min;
        const label = optionalString(args.label, 'bg_run', 'label');

        // W-3：唤醒目标是「发起它的子代理会话」——即 exec.agent 的会话 id。
        const senderSessionId = sessionIdOfAgent(exec?.agent);
        if (senderSessionId === null) {
          return { ok: false, reason: 'no-sender', message: 'bg_run 需要调用方 agent 的会话 id（exec.agent）' };
        }
        // A2：主会话 id 用来在唤醒失败时兜底投递。
        const rootSessionId = typeof mainSessionId === 'function' ? mainSessionId() : null;

        const started = await startBgJob({
          store,
          config: bgConfig,
          params: { argv, cwd: cwdText, deadlineMin, label },
          origin: {
            childAgentName: typeof exec?.agent?.name === 'string' ? exec.agent.name : null,
            childSessionId: senderSessionId,
            rootSessionId,
            launchedBy: 'bg_run',
          },
          // W77-M3：日志根与 launcher 都可注入（单测用临时目录 + startBgProcess 替身，
          // 不碰真实 /opt 与真实 systemd-run）。
          ...(typeof bgLogRoot === 'string' && bgLogRoot !== '' ? { logRoot: bgLogRoot } : {}),
          ...(bgLauncher !== null && typeof bgLauncher === 'object' ? { launcher: bgLauncher } : {}),
        });
        if (started.ok !== true && started.reason === 'launch-failed') {
          // W77-M1：拉起被拒也沿 SA-B3 回执一句，不让它静默消失在后台。
          if (typeof taskReceipt === 'function') {
            try {
              await taskReceipt({
                title: label ?? '后台任务',
                status: 'error',
                receipt: `[任务] 后台任务拉起失败：${started.message}`,
                taskId: started.job?.id ?? null,
                sessionId: senderSessionId,
              });
            } catch {
              // 回执失败不改变工具返回。
            }
          }
          return {
            ok: false,
            reason: started.reason,
            message: started.message,
            ...(started.job !== undefined ? { id: started.job.id } : {}),
          };
        }
        if (started.ok !== true) {
          return {
            ok: false,
            reason: started.reason,
            message: started.message,
            ...(Array.isArray(started.running) ? { running: started.running } : {}),
          };
        }
        // H2（v0.7.15）：启动告知不再走 taskReceipt。它与结束回执共用
        // taskId=job.id，dedupeKey `task-receipt:<id>` 在 120 分钟窗口内会把结束回执
        // 当成重复静默丢掉（且当时不写事件）。启动信息只由工具返回值告诉调用方，
        // 结束回执才是真正需要投给主会话的那一条。
        return {
          ok: true,
          id: started.job.id,
          state: started.job.state,
          deadline: started.job.deadline,
          log_path: started.job.log_path,
          pid_or_unit: started.job.pid_or_unit,
        };
      },
    },

    {
      name: 'task_cancel',
      description:
        '取消一个在跑的任务：task_run 派出的子代理任务，或 bg_run 拉起的后台任务（同一个 id 空间）。'
        + '取消后该任务以 cancelled 终态结束，主会话会收到一条「已取消」回执；'
        + '已结束或未知的 taskId 返回 not-found。后台任务按拉起时的同一模式 systemctl stop 对应 unit。'
        + '取消只能用本工具，不要用 kill / pgrep / systemctl。',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'task_run 或 bg_run 返回的 taskId',
          },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        assertArgs(args, 'task_cancel');
        const taskId = requireString(args.taskId, 'task_cancel', 'taskId');
        // L4（v0.7.17）：与 /停止任务 共用解析（task_run → bg 直查 → 审计 sessionId 反查）。
        const resolved = resolveStopTarget({ store, target: taskId, stopTask: stopTaskById });
        if (resolved.ok !== true) {
          if (resolved.reason === 'ambiguous') {
            return {
              ok: false,
              reason: 'ambiguous',
              taskId,
              candidates: resolved.candidates,
              message: '这个任务派出了多个在跑的后台任务，请用具体 id 再取消',
            };
          }
          return {
            ok: false,
            reason: 'not-found',
            taskId,
            message: '没有在跑的任务使用这个 taskId（可能已结束或 id 写错）',
          };
        }
        if (resolved.kind === 'task') {
          return { ok: true, taskId, cancelled: true, kind: 'task', note: '已请求中止，回执稍后送达。' };
        }
        if (resolved.job.state === BG_JOB_STATES.cancelling) {
          return {
            ok: false,
            reason: 'already-cancelling',
            taskId,
            message: '已在取消中：进程退出后会收到「已取消」回执',
          };
        }
        // L1（v0.7.17）：这里只受理取消（claim cancelling + TERM）；「已取消」回执由
        // monitor 在进程真退出后发一次，避免回执点与状态收敛点分离。
        const bgResult = await cancelBgJob({
          store,
          jobId: resolved.job.id,
          launcher: bgLauncher !== null && typeof bgLauncher === 'object' ? bgLauncher : {},
          nowMs: nowMs(),
        });
        if (bgResult.ok !== true) {
          if (bgResult.reason === 'already-cancelling') {
            return {
              ok: false,
              reason: 'already-cancelling',
              taskId,
              message: '已在取消中：进程退出后会收到「已取消」回执',
            };
          }
          if (bgResult.reason === 'stop-failed') {
            return {
              ok: false,
              reason: 'cancel-failed',
              taskId,
              message: `取消失败（${bgResult.message ?? 'systemctl stop 失败'}）`,
            };
          }
          return {
            ok: false,
            reason: 'not-found',
            taskId,
            message: '没有在跑的任务使用这个 taskId（可能已结束或 id 写错）',
          };
        }
        return {
          ok: true,
          taskId,
          cancelled: true,
          kind: 'bg',
          state: 'cancelling',
          note: '已请求取消后台任务，进程退出后主会话会收到「已取消」回执。',
        };
      },
    },

    {
      name: 'cost_report',
      description: '返回今日/本月 token 成本（memory_events 里的 token 汇总）。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'cost_report');
        return summarizeCost(store, nowMs(), timeZone);
      },
    },
  ];
}

// ------------------------------------------------ v0.7.20 M1 线程职责标记

/**
 * 「该线程显式设过 charter」标记的 schema_meta 键（值 `'1'`）。零 DDL：沿用
 * `thread_history:<key>` / `dedupe_judge:<scope>` 的每线程一键惯例。
 * @param {string} key
 * @returns {string}
 */
function threadCharterSetKey(key) {
  return `thread_charter_set:${key}`;
}

/**
 * v0.7.20 M1：本次投递是否该带「线程职责」行。
 *
 * 存量线程的 `threads.description` 是当年第一条 goal（不是职责），v0.7.19 每次
 * 续派都把它前置成职责属于误导。所以只有「本次显式给了 charter」或「历史上设过
 * charter（schema_meta 有标记）」才注入；读不到/坏值一律按没设过处理。
 * @param {object} store
 * @param {string} key
 * @param {string|undefined} charter 本次调用显式传入的职责
 * @returns {boolean}
 */
function threadCharterActive(store, key, charter) {
  if (charter !== undefined) return true;
  try {
    if (store === null || typeof store !== 'object' || typeof store.getMeta !== 'function') {
      return false;
    }
    return store.getMeta(threadCharterSetKey(key)) === '1';
  } catch {
    return false;
  }
}

/**
 * v0.7.20 M1：记下「该线程显式设过 charter」。写失败只影响下次续派是否带职责行，
 * 绝不挡住本次投递（schema_meta 只是标记，真值仍在 `threads.description`）。
 * @param {object} store
 * @param {string} key
 */
function markThreadCharterSet(store, key) {
  try {
    if (store !== null && typeof store === 'object' && typeof store.setMeta === 'function') {
      store.setMeta(threadCharterSetKey(key), '1');
    }
  } catch {
    // 尽力而为：标记写不进去，下次续派退化成「不带职责行」，不会误注入旧 goal。
  }
}

// ------------------------------------------------ v0.7.19 T4.3 线程投递历史

/**
 * 线程投递历史的 schema_meta 键。零 DDL：沿用 v0.7.18 L5 `dedupe_judge:<scope>`
 * 的键惯例，每个线程一个键。
 * @param {string} key
 * @returns {string}
 */
function threadHistoryKey(key) {
  return `thread_history:${key}`;
}

/**
 * 读取线程投递历史（最新在前）。键不存在、JSON 损坏、值不是数组都返回空数组：
 * 历史是尽力而为的只读目录，坏一条不能挡住 thread_run / thread_history。
 * @param {object} store
 * @param {string} key
 * @returns {object[]}
 */
function readThreadHistory(store, key) {
  try {
    const raw = store.getMeta(threadHistoryKey(key));
    if (typeof raw !== 'string' || raw === '') return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry !== null && typeof entry === 'object');
  } catch {
    return [];
  }
}

/**
 * 覆盖写入线程投递历史，滚动保留最新 `THREAD_HISTORY_MAX_ENTRIES` 条。
 * 写失败只丢历史，不挡投递本身（schema_meta 只是滚动目录）。
 * @param {object} store
 * @param {string} key
 * @param {object[]} entries
 */
function writeThreadHistory(store, key, entries) {
  try {
    store.setMeta(
      threadHistoryKey(key),
      JSON.stringify(entries.slice(0, THREAD_HISTORY_MAX_ENTRIES)),
    );
  } catch {
    // 历史是附加信息：写不进去也不影响线程投递与回执。
  }
}

/**
 * 追加一条投递记录（最新在前）。每个 thread_run 调用只追加一条，回执落地后
 * 再按 requestId 更新同一条，避免续派失败重建时产生两条。
 * @param {object} store
 * @param {string} key
 * @param {object} entry
 */
function appendThreadHistory(store, key, entry) {
  const entries = readThreadHistory(store, key);
  entries.unshift(entry);
  writeThreadHistory(store, key, entries);
}

/**
 * 按 requestId 把回执首句与终态写回对应记录；找不到匹配记录就不动。
 * @param {object} store
 * @param {string} key
 * @param {string} requestId
 * @param {{receiptFirst?: string|null, status?: string}} patch
 */
function updateThreadHistoryReceipt(store, key, requestId, patch) {
  const entries = readThreadHistory(store, key);
  let matched = false;
  const next = entries.map((entry) => {
    if (entry.requestId !== requestId) return entry;
    matched = true;
    return { ...entry, ...patch };
  });
  if (matched) writeThreadHistory(store, key, next);
}

/**
 * 取一段文本的首句（投递历史的 goalFirst / receiptFirst 口径）：按中英文句读与
 * 换行切分，压掉空白，超长截到 `THREAD_HISTORY_FIRST_SENTENCE_MAX` 码点。
 * @param {unknown} text
 * @returns {string|null}
 */
function threadHistoryFirstSentence(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return null;
  const part = raw
    .split(/[。！？!?\r\n，,；;：:]/u)
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .find((segment) => segment !== '');
  if (part === undefined) return null;
  const chars = Array.from(part);
  return chars.length > THREAD_HISTORY_FIRST_SENTENCE_MAX
    ? `${chars.slice(0, THREAD_HISTORY_FIRST_SENTENCE_MAX).join('')}…`
    : part;
}

/**
 * 把 epoch 秒格式化成 UTC ISO 串；非法值返回 null（历史条目容错）。
 * @param {unknown} seconds
 * @returns {string|null}
 */
function threadHistoryTimeText(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** @param {unknown} args @param {string} tool */
function assertArgs(args, tool) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(`[tools] ${tool}: args must be an object`);
  }
}

/** @param {unknown} value @param {string} tool @param {string} field */
function requireString(value, tool, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`[tools] ${tool}: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} tool @param {string} field */
function optionalString(value, tool, field) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, tool, field);
}

/** @param {unknown} value @param {string} tool @param {string} field @param {number} min @param {number} max */
function optionalInt(value, tool, field, min, max) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TypeError(`[tools] ${tool}: ${field} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

/** @param {unknown} value @param {string} tool @param {string} field */
function optionalBoolean(value, tool, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new TypeError(`[tools] ${tool}: ${field} must be a boolean`);
  }
  return value;
}

/** @param {unknown} value @param {Set<string>} allowed @param {string} tool @param {string} field */
function optionalEnum(value, allowed, tool, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new TypeError(`[tools] ${tool}: ${field} must be one of ${[...allowed].join(', ')}`);
  }
  return value;
}

/** @param {string|undefined} goal @returns {boolean} */
function exceedsGoalLimit(goal) {
  return goal !== undefined && Array.from(goal).length > GOAL_MAX_CODEPOINTS;
}

/** 从任意抛出值取可读错误文本（保留宿主原话）。 @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error ?? '');
}

/**
 * 判断平台错误是否是「未知 agent preset」一类（V10-H1）。
 * 兼容英文宿主文案的大小写/空格差异，以及 `code` 形式的错误。
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnknownAgentPresetError(error) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : '';
  if (/unknown.?agent.?preset|agent.?preset.?unknown|preset.?not.?found/i.test(code)) return true;
  const message = errorMessage(error);
  if (message === '') return false;
  if (/unknown\s+agent\s+preset/i.test(message)) return true;
  return /agent\s+preset/i.test(message)
    && /(unknown|not\s+found|unrecognized|unsupported|invalid|does\s+not\s+exist|no\s+such)/i.test(message);
}

/** @param {object} registry @param {{store:object,key:string,name?:string}} input */
function planThreadRun(registry, input) {
  if (typeof registry?.planThreadRun === 'function') {
    return registry.planThreadRun(input);
  }
  if (typeof registry === 'function') return registry(input);
  throw new TypeError('createTools: registry.planThreadRun is required for thread_run');
}

/** @param {unknown} created @returns {string|null} */
function sessionIdOf(created) {
  const candidates = [
    created?.sessionId,
    created?.id,
    created?.session?.id,
    created?.agent?.sessionId,
    created?.agent?.id,
  ];
  return candidates.find((value) => typeof value === 'string' && value !== '') ?? null;
}
