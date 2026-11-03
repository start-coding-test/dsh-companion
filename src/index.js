/**
 * 插件入口：装配人格段、记忆管线、命令、工具与调度器。
 *
 * 设计约束（t12 / 07 §4）：
 * - 只做接线，不实现业务逻辑；所有能力来自已完成的模块与平台适配层；
 * - 不直接 import 任何 @deepseek-ai/* 包，平台调用统一经 createAdapter(ctx)；
 * - 宿主缺少某项服务时安静跳过（日志用 debug），不让插件装载失败；
 * - 配置非法时 fail-fast，抛 ConfigError 且不产生任何注册。
 */

import { copyFileSync } from 'node:fs';

import { normalizeConfig } from './config.js';
import { Store } from './memory/store.js';
import { retrieve } from './memory/retrieve.js';
import { boardSection, buildSections } from './persona/sections.js';
import { DEFAULT_CARD } from './persona/card.js';
import { createAdapter } from './platform/adapter.js';
import { handleCommand } from './runtime/commands.js';
import { createMetrics } from './runtime/metrics.js';
import { createProactive } from './runtime/proactive.js';
import { JOB_IDS, createScheduler } from './runtime/scheduler.js';
import { createTools } from './runtime/tools.js';
import * as threadRegistry from './thread/registry.js';

export const name = 'dsh-companion';

/** 默认作用域。 */
const SCOPE = 'main';

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

/**
 * 插件入口。
 * @param {object} ctx 平台上下文
 * @param {Record<string, unknown>} [rawConfig] 用户原始配置
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const host = ctx !== null && typeof ctx === 'object' ? ctx : null;
  host?.logger?.info?.('[dsh-companion] config ok', { warnings: config.warnings });
  if (host === null) return;

  const platform = createAdapter(host, { now: () => host.now?.() ?? Date.now() });
  const store = Store.open(config.dbPath);
  const metrics = createMetrics({ clock: platform.now });

  registerSections(platform, store);
  registerMemoryPipeline(platform, store, metrics);
  registerCommands(platform, store);
  registerTools(platform, store);
  startScheduler(platform, store, config, metrics);
}

/**
 * 注册人格三段与状态板段。
 * @param {object} platform
 * @param {Store} store
 */
function registerSections(platform, store) {
  if (!platform.capabilities.systemPrompt) return;
  for (const section of buildSections(DEFAULT_CARD)) {
    platform.section(section);
  }
  platform.section({
    name: 'persona:state_board',
    order: 160,
    text: () => {
      const published = store.getBoard(SCOPE);
      return published === null || published === undefined ? '' : boardSection(published).text;
    },
  });
}

/**
 * 注册检索注入：每轮把与本轮用户输入相关的记忆拼成一条文本块，追加到本批
 * 进入消息末尾（agent/pre-step 的 inject 语义）。
 * @param {object} platform
 * @param {Store} store
 * @param {{inc: Function}} metrics
 */
function registerMemoryPipeline(platform, store, metrics) {
  if (!platform.capabilities.preStep) return;
  platform.onPreStep(async (payload) => {
    const query = lastTextBlock(payload?.messages);
    if (query === '' || query.startsWith('[相关记忆]')) return null;
    let result;
    try {
      result = await retrieve({ store, query: query.slice(0, 200), scope: SCOPE, now: platform.now() });
    } catch (error) {
      platform.log('warn', '[dsh-companion] recall injection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!Array.isArray(result?.items) || result.items.length === 0) return null;
    metrics.inc('recalls', result.items.length);
    const lines = result.items.map((item) => `- (${item.kind} #${item.id}) ${item.text}`);
    return { inject: [{ type: 'text', text: `[相关记忆]\n${lines.join('\n')}` }] };
  });
}

/**
 * 注册 4 个 ASCII 命令；handler 统一转给 handleCommand。
 * @param {object} platform
 * @param {Store} store
 */
function registerCommands(platform, store) {
  if (!platform.capabilities.commands) return;
  for (const alias of COMMAND_ALIASES) {
    platform.registerCommand({
      definitionId: alias.definitionId,
      name: alias.name,
      description: alias.description,
      handler: (invocation) => {
        const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
        const result = handleCommand({
          text: `${alias.prefix}${rawInput}`,
          store,
          now: platform.now(),
          scope: SCOPE,
        });
        if (!result.handled) {
          return { kind: 'error', text: `未识别的命令参数；用法：${alias.prefix} [参数]` };
        }
        return { kind: 'success', text: result.reply };
      },
    });
  }
}

/**
 * 注册 8 个模型工具。工具的 parameters 已是 JSON Schema，直接按平台裸注册
 * 契约补齐 output（宽 schema + 文本 render），不做 defineTool 依赖。
 * @param {object} platform
 * @param {Store} store
 */
function registerTools(platform, store) {
  if (!platform.capabilities.tools) return;
  const tools = createTools({
    store,
    retrieve,
    registry: threadRegistry,
    platform,
  });
  for (const tool of tools) {
    platform.registerTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderToolValue(value) }],
      },
      execute: (args) => tool.execute(args ?? {}),
    });
  }
}

/**
 * 注册并启动 6 个定时任务；任务体只调用已完成模块。
 * @param {object} platform
 * @param {Store} store
 * @param {object} config
 * @param {object} metrics
 */
function startScheduler(platform, store, config, metrics) {
  if (!platform.capabilities.timer) return;
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

  const jobs = {
    'idle-probe': async () => {
      await proactive.flush();
    },
    reminders: async () => {
      fireDueReminders(store, platform, proactive);
      await proactive.flush();
    },
    'deep-sleep': () => {
      platform.log('debug', '[dsh-companion] deep-sleep tick', metrics.snapshot());
    },
    's2-purge': () => {
      const result = store.purge({ now: platform.now(), cutoffDays: config.purgeAfterDays });
      platform.log('info', '[dsh-companion] s2-purge done', result);
    },
    backup: () => {
      backupDatabase(store, platform);
    },
    'thread-freeze': async () => {
      await freezeThreads(store, platform, config);
    },
  };

  const scheduler = createScheduler({
    clock: platform.now,
    store,
    jobs,
    timer: (callback, delay) => platform.every(delay, callback),
    clearTimer: (handle) => {
      if (typeof handle === 'function') handle();
    },
  });
  scheduler.start(platform.now());
  platform.log('info', '[dsh-companion] scheduler started', { jobs: JOB_IDS.length });
}

/**
 * 把到点的提醒转成主动消息，并标记为 fired。
 * @param {Store} store
 * @param {object} platform
 * @param {{enqueue: Function}} proactive
 * @returns {number} 本次处理条数
 */
function fireDueReminders(store, platform, proactive) {
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
    proactive.enqueue({
      kind: 'reminder',
      text: `提醒：${row.title}`,
      dedupeKey: `reminder:${row.id}:${seconds}`,
      at: now,
    });
  }
  return due.length;
}

/**
 * 备份 SQLite 主库：先 checkpoint 把 WAL 落盘，再复制为 `<dbPath>.bak`。
 * @param {Store} store
 * @param {object} platform
 */
function backupDatabase(store, platform) {
  if (store.dbPath === ':memory:') return;
  try {
    store.db.exec('PRAGMA wal_checkpoint(FULL)');
  } catch {
    // checkpoint 失败不阻断复制；主库仍可能包含大部分已提交数据。
  }
  copyFileSync(store.dbPath, `${store.dbPath}.bak`);
  platform.log('info', '[dsh-companion] backup done', { path: `${store.dbPath}.bak` });
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

/**
 * 取本批进入消息里最后一条非空文本块；没有则返回空串。
 * @param {unknown} messages
 * @returns {string}
 */
function lastTextBlock(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const block = messages[index];
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.trim();
    if (text !== '') return text;
  }
  return '';
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
