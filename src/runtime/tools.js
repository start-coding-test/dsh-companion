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
 *   新建时 createSession(preset='companion-thread') 并写 threads 行。
 */

import { forgetMemory } from '../memory/forget.js';
import {
  releaseExecSlot,
  runTask as runBackgroundTask,
  tryAcquireExecSlot,
} from '../task/run.js';
import { summarizeCost } from './commands.js';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../time.js';

const FACT_KINDS = new Set(['identity', 'relation', 'preference', 'project', 'knowledge', 'other']);
const SALIENCE = new Set(['trivial', 'normal', 'notable', 'explicit', 'pinned']);
const PRIVACY = new Set(['normal', 'sensitive', 'secret']);
const REMINDER_KINDS = new Set(['todo', 'schedule', 'repeat', 'commitment']);
const THREAD_STATUSES = new Set(['active', 'archived', 'retired']);

/** 投递给线程/worker 的目标长度上限（按 Unicode 码点计，L 级）。 */
const GOAL_MAX_CODEPOINTS = 2000;

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
 * @param {() => (string|null|undefined)} [deps.currentScope] 当前会话 scope
 *   （pre-step 记录）；undefined=尚未路由（按 main），null=subagent（拒绝记忆工具）。
 * @param {() => {allowTask?: boolean, allowThread?: boolean, taskReason?: string,
 *   threadReason?: string}} [deps.budgetGate] M4 执行前闸门（每日熔断/RSS 降级）。
 * @param {{inc:Function}} [deps.metrics] 计数器（thread_run 槽位兜底/超时）。
 * @param {{setTimeout:Function, clearTimeout:Function}} [deps.timers] 可注入定时器。
 * @returns {Array<{name:string, description:string, parameters:object, execute:Function}>}
 */
export function createTools({
  store,
  retrieve,
  registry,
  platform,
  clock = Date.now,
  cwd,
  timeZone = DEFAULT_TIMEZONE,
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
  const defaultCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;

  /**
   * 当前会话 scope：undefined=尚未路由（兼容旧调用，按 main）；null=subagent，
   * 没有长期记忆作用域，记忆工具一律拒绝。
   * @returns {string|null|undefined}
   */
  const scopeNow = () => (typeof currentScope === 'function' ? currentScope() : undefined);

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
      description: '写入一条用户显式给出的事实，返回落库后的 id 与摘要。',
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
      execute(args = {}) {
        assertArgs(args, 'memory_write');
        const statement = requireString(args.statement, 'memory_write', 'statement');
        const kind = optionalEnum(args.kind, FACT_KINDS, 'memory_write', 'kind') ?? 'other';
        const salience = optionalEnum(args.salience, SALIENCE, 'memory_write', 'salience') ?? 'normal';
        const privacy = optionalEnum(args.privacy, PRIVACY, 'memory_write', 'privacy') ?? 'normal';
        const requested = optionalString(args.scope, 'memory_write', 'scope');
        const resolved = resolveScope(requested);
        if (!resolved.ok) return resolved;
        const row = store.insertFact({
          scope: resolved.scope,
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
        return { ok: true, id: row.id, statement: row.statement, scope: row.scope, salience: row.salience };
      },
    },

    {
      name: 'memory_forget',
      description: '按 id 遗忘一条事实：默认 S1（7 天后物理删除）；immediate+confirm 时立即物删。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '事实 id' },
          immediate: {
            type: 'boolean',
            description: '跳过 7 天冷静期立即物理删除（需 confirm=true）',
          },
          confirm: { type: 'boolean', description: '确认立即删除（immediate 的二次确认）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'memory_forget');
        const id = requireString(args.id, 'memory_forget', 'id');
        const immediate = optionalBoolean(args.immediate, 'memory_forget', 'immediate') ?? false;
        const confirm = optionalBoolean(args.confirm, 'memory_forget', 'confirm') ?? false;
        const current = scopeNow();
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
          scope: SCOPE_SCHEMA,
        },
        required: ['title'],
        additionalProperties: false,
      },
      execute(args = {}) {
        assertArgs(args, 'reminder_add');
        const title = requireString(args.title, 'reminder_add', 'title');
        const kind = optionalEnum(args.kind, REMINDER_KINDS, 'reminder_add', 'kind') ?? 'todo';
        const dueAt = optionalInt(args.due_at, 'reminder_add', 'due_at', 0, Number.MAX_SAFE_INTEGER);
        const requested = optionalString(args.scope, 'reminder_add', 'scope');
        const resolved = resolveScope(requested);
        if (!resolved.ok) return resolved;
        const row = store.insertReminder({
          scope: resolved.scope,
          kind,
          title,
          detail: optionalString(args.detail, 'reminder_add', 'detail') ?? null,
          counterparty: optionalString(args.counterparty, 'reminder_add', 'counterparty') ?? null,
          due_at: dueAt ?? null,
          due_granularity: dueAt === undefined ? 'none' : 'exact',
          next_fire_at: dueAt ?? null,
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
      name: 'thread_run',
      description: '复用或新建一个线程会话，并把目标投递进去。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '线程 key；新建时传 new' },
          name: { type: 'string', description: '线程名（key=new 时必填）' },
          goal: { type: 'string', description: '投递给线程的目标/任务（可选）' },
          cwd: { type: 'string', description: '新会话工作目录（可选）' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      async execute(args = {}) {
        assertArgs(args, 'thread_run');
        const key = requireString(args.key, 'thread_run', 'key');
        const name = optionalString(args.name, 'thread_run', 'name');
        const goal = optionalString(args.goal, 'thread_run', 'goal');
        if (exceedsGoalLimit(goal)) return { ok: false, reason: 'goal_too_long' };
        const gate = gateNow();
        if (gate !== null && gate.allowThread === false) {
          return { ok: false, reason: gate.threadReason ?? 'memory_main_only' };
        }
        const plan = planThreadRun(registry, { store, key, name });
        if (plan.action === 'reject') {
          return { ok: false, action: 'reject', key: plan.key ?? key, reason: plan.reason };
        }

        // 新建分支返回的句柄直接用于 whenIdle，避免线程尚未进入 ctx.agents 时退化。
        let createdHandle = null;

        const run = async () => {
          const nowSec = Math.floor(nowMs() / 1000);
          if (plan.action === 'reuse') {
            let thread = store.getThread(plan.key);
            if (!thread) {
              return { ok: false, action: 'reuse', key: plan.key, reason: 'thread-row-missing' };
            }
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
                status: 'active',
                last_progress: goal ?? thread.last_progress,
                last_active_at: nowSec,
              });
              reactivated = true;
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
                content: [{ type: 'text', text: goal }],
              });
              store.upsertThread({ ...thread, last_progress: goal, last_active_at: nowSec });
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
  
          if (typeof platform?.createSession !== 'function') {
            return { ok: false, action: 'create', key: plan.key, reason: 'session-unavailable' };
          }
          const targetCwd = optionalString(args.cwd, 'thread_run', 'cwd') ?? defaultCwd;
          if (targetCwd === undefined) {
            // cwd 必须由接线层从宿主注入；不读 process.cwd()（L3）。
            return { ok: false, action: 'create', key: plan.key, reason: 'cwd-unavailable' };
          }
          const created = await platform.createSession({
            cwd: targetCwd,
            agentPreset: 'companion-thread',
          });
          createdHandle = created;
          const sessionId = sessionIdOf(created);
          if (sessionId === null) {
            throw new Error('[tools] thread_run: createSession() returned no session id');
          }
  
          const thread = store.upsertThread({
            key: plan.key,
            name: name ?? plan.key,
            session_id: sessionId,
            description: goal ?? `线程：${plan.key}`,
            last_progress: goal ?? null,
            last_active_at: nowSec,
            status: 'active',
          });
  
          let prompted = false;
          if (goal !== undefined) {
            await platform.prompt({
              sessionId,
              content: [{ type: 'text', text: goal }],
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
        '把一件独立任务交给串行 worker 执行：全局单槽（同一时刻 1 个），'
        + '忙时排队最多 2 个，超出直接返回 busy；软超时 600s 只告警，'
        + '硬超时 900s 两段式取消。返回 ≤300 字回执。',
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
      async execute(args = {}) {
        assertArgs(args, 'task_run');
        const goal = requireString(args.goal, 'task_run', 'goal');
        const title = optionalString(args.title, 'task_run', 'title');
        const gate = gateNow();
        if (gate !== null && gate.allowTask === false) {
          return { ok: false, reason: gate.taskReason ?? 'daily_budget_exceeded' };
        }
        if (typeof platform?.createSession !== 'function'
          || typeof platform?.prompt !== 'function'
          || typeof platform?.whenIdle !== 'function') {
          return { ok: false, reason: 'session-unavailable' };
        }
        const scope = scopeNow();
        return runBackgroundTask({
          platform,
          store,
          goal,
          title,
          at: nowMs(),
          scope: typeof scope === 'string' && scope !== '' ? scope : 'main',
          cwd: defaultCwd,
        });
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
