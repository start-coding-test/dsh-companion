/**
 * 模型工具面（05 §7.5、t11 卡）：8 个工具的描述符 + 执行层。
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
import { summarizeCost } from './commands.js';
import { DEFAULT_TIMEZONE, isValidTimeZone } from '../time.js';

const FACT_KINDS = new Set(['identity', 'relation', 'preference', 'project', 'knowledge', 'other']);
const SALIENCE = new Set(['trivial', 'normal', 'notable', 'explicit', 'pinned']);
const PRIVACY = new Set(['normal', 'sensitive', 'secret']);
const REMINDER_KINDS = new Set(['todo', 'schedule', 'repeat', 'commitment']);
const THREAD_STATUSES = new Set(['active', 'archived', 'retired']);

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
        const scope = optionalString(args.scope, 'memory_search', 'scope') ?? 'main';
        const limit = optionalInt(args.limit, 'memory_search', 'limit', 1, 50) ?? 20;
        return retrieve({ store, query, scope, limit });
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
        const scope = optionalString(args.scope, 'memory_write', 'scope') ?? 'main';
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
        return forgetMemory({
          store,
          kind: 'fact',
          id,
          at: nowMs(),
          immediate,
          confirm,
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
        const scope = optionalString(args.scope, 'reminder_add', 'scope') ?? 'main';
        const row = store.insertReminder({
          scope,
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
        const plan = planThreadRun(registry, { store, key, name });
        if (plan.action === 'reject') {
          return { ok: false, action: 'reject', key: plan.key ?? key, reason: plan.reason };
        }

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
