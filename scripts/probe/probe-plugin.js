/**
 * Gate 0 进程内探针（只读）。
 *
 * 目的：在真实 DSH 进程里采集评审 H1/H2/H3/W2 依赖的平台事实，不猜测、
 * 不写业务库、不打印任何凭据。插件由 `scripts/probe/probe.patch.yml` 以
 * 独立 profile / 临时 DSH_HOME 挂入，启动时与首个 `agent/pre-step` 时各写
 * 一次 `.data/probe.json`（可用 `DSH_PROBE_OUT` 覆盖路径）。
 *
 * 采集内容：
 * - 运行时：process.versions.*、execPath、platform/arch；
 * - `node:sqlite` 是否可 import，DatabaseSync 与内置 SQLite 版本；
 * - ctx 上的能力面：要求探测的 service 键、cordis mixin 方法；
 * - tokenMeter.measure 的签名，以及一次真实调用的返回键（含 nodes/seq）；
 * - compaction.compactRegion 的 arity 与源码（只读，不调用）；
 * - 首个 agent/pre-step 的 payload：messages 范围/角色、session.id、preset、
 *   turn/step；以及每个 session 的触发计数（回答多会话是否都会触发）；
 * - agent/turn-stopping 是否可注册、是否触发；
 * - sessions 列表/读取面（sessions.list/get、sessionQuery、sessionController）。
 *
 * 探针绝不修改会话、不调用 compactRegion、不注册会改变决策的 pre-step 返回值：
 * listener 只记录，然后原样 `return next()`。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'gate0-probe';

/** 探针自身目录：默认输出固定落在仓库 `.data/`，不随启动 cwd 漂移。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(PLUGIN_DIR, '..', '..', '.data', 'probe.json');

/** 评审要求的 capability 键；`intervals`/`events` 不是 service，另行记录 mixin 方法。 */
const CAPABILITY_KEYS = [
  'systemPrompt',
  'tokenMeter',
  'compaction',
  'commands',
  'tools',
  'sessions',
  'subagents',
  'intervals',
  'events',
  'sessionController',
  'sessionQuery',
  'sessionProjections',
  'agents',
  'timer',
  'llm',
];

/** 单个字符串/源码片段的最大长度，避免 probe.json 膨胀。 */
const MAX_TEXT = 700;
const MAX_PREVIEW = 1200;
const MAX_PRE_STEP_EVENTS = 20;

/**
 * 归一化输出路径：config.output > DSH_PROBE_OUT > 仓库 .data/probe.json。
 * @param {unknown} config
 * @returns {string}
 */
function resolveOutput(config) {
  const configured = config && typeof config === 'object' && typeof config.output === 'string'
    ? config.output
    : undefined;
  const fromEnv = typeof process.env.DSH_PROBE_OUT === 'string' && process.env.DSH_PROBE_OUT.length > 0
    ? process.env.DSH_PROBE_OUT
    : undefined;
  return resolve(configured ?? fromEnv ?? DEFAULT_OUTPUT);
}

/**
 * 截断字符串，保留前 n 个字符。
 * @param {unknown} value
 * @param {number} [n]
 * @returns {string}
 */
function truncate(value, n = MAX_TEXT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/**
 * 把异常压成无凭据的普通对象。
 * @param {unknown} error
 * @returns {{name:string,message:string,code?:string}}
 */
function errorInfo(error) {
  const value = error && typeof error === 'object' ? error : {};
  const info = {
    name: typeof value.name === 'string' ? value.name : 'Error',
    message: truncate(value.message ?? error, 240),
  };
  if (typeof value.code === 'string') info.code = truncate(value.code, 80);
  return info;
}

/**
 * 安全执行一次读取，失败返回 fallback。
 * @template T
 * @param {() => T} fn
 * @param {T} fallback
 * @returns {T}
 */
function safeGet(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * JSON 序列化兜底：BigInt/Error/函数不炸、循环引用不炸。
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function jsonReplacer(key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return errorInfo(value);
  return value;
}

/**
 * 从函数源码里提取形参名（仅用于展示，失败返回 null）。
 * @param {string} source
 * @returns {string[]|null}
 */
function parametersFromSource(source) {
  if (typeof source !== 'string') return null;
  const start = source.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;
  const raw = source.slice(start + 1, end).trim();
  if (!raw) return [];
  return raw.split(',').map((part) => part.trim().replace(/=.*$/, '').trim()).filter(Boolean);
}

/**
 * 读取方法“真实源码”：cordis 的 service 属性访问会返回 bind 后的 native 函数，
 * 因此沿原型链找原始 descriptor；找不到时退回实例上的 toString。
 * @param {object} target
 * @param {string} methodName
 * @returns {object}
 */
function methodSource(target, methodName) {
  let cursor = target;
  let depth = 0;
  while (cursor && cursor !== Object.prototype && depth < 8) {
    const descriptor = safeGet(() => Object.getOwnPropertyDescriptor(cursor, methodName), undefined);
    if (descriptor) {
      const fn = descriptor.value ?? descriptor.get;
      if (typeof fn === 'function') {
        const source = safeGet(() => Function.prototype.toString.call(fn), null);
        return {
          foundAt: `prototype-depth-${depth}`,
          kind: descriptor.get ? 'getter' : 'value',
          arity: fn.length,
          parameters: parametersFromSource(source),
          source: source ? truncate(source, MAX_TEXT) : null,
        };
      }
      return { foundAt: `prototype-depth-${depth}`, kind: 'non-function', type: typeof descriptor.value };
    }
    cursor = safeGet(() => Object.getPrototypeOf(cursor), null);
    depth += 1;
  }
  const bound = safeGet(() => target?.[methodName], undefined);
  if (typeof bound !== 'function') return { found: false };
  return {
    foundAt: 'instance',
    kind: 'bound/native',
    arity: bound.length,
    parameters: null,
    source: truncate(Function.prototype.toString.call(bound), MAX_TEXT),
  };
}

/**
 * 采集运行时版本信息。
 * @returns {object}
 */
function processInfo() {
  const versions = process.versions ?? {};
  return {
    node: versions.node ?? null,
    electron: versions.electron ?? null,
    v8: versions.v8 ?? null,
    uv: versions.uv ?? null,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    argv0: truncate(process.argv0, 160),
    execArgv: process.execArgv.map((arg) => truncate(arg, 120)),
  };
}

/**
 * 列出对象（含原型链）上的方法名与 arity；只读，不调用。
 * @param {object} target
 * @param {number} [limit]
 * @returns {Array<{name:string,arity?:number,getter?:true}>}
 */
function methodList(target, limit = 60) {
  const out = [];
  const seen = new Set();
  let cursor = target;
  while (cursor && cursor !== Object.prototype && out.length < limit) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (key === 'constructor' || seen.has(key)) continue;
      seen.add(key);
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (!descriptor) continue;
      if (typeof descriptor.value === 'function') {
        out.push({ name: key, arity: descriptor.value.length });
      } else if (typeof descriptor.get === 'function') {
        out.push({ name: key, getter: true });
      }
      if (out.length >= limit) break;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return out;
}

/**
 * 采集一个 ctx service 的存在性与方法面。
 * @param {object} ctx
 * @param {string} key
 * @returns {object}
 */
function serviceSnapshot(ctx, key) {
  let service;
  try {
    service = ctx.get(key);
  } catch (error) {
    return { present: false, lookupError: errorInfo(error) };
  }
  if (service === undefined || service === null) return { present: false };
  const snapshot = {
    present: true,
    typeof: typeof service,
    constructor: safeGet(() => service.constructor?.name ?? null, null),
    methods: methodList(service),
  };
  const version = safeGet(() => service.version, undefined);
  if (version !== undefined) snapshot.version = truncate(version, 80);
  return snapshot;
}

/**
 * 采集 ctx 能力面：要求探测的 service 键 + cordis mixin 方法。
 * @param {object} ctx
 * @returns {object}
 */
function capabilitySnapshot(ctx) {
  const services = {};
  for (const key of CAPABILITY_KEYS) services[key] = serviceSnapshot(ctx, key);
  // `events`/`timer` 等在 cordis 中是 service 属性；未声明 inject 时直接读取会抛错。
  const direct = {};
  for (const key of ['events', 'timer', 'intervals', 'sessions', 'systemPrompt', 'tokenMeter', 'compaction']) {
    try {
      const value = ctx[key];
      direct[key] = {
        readable: true,
        typeof: typeof value,
        constructor: safeGet(() => value?.constructor?.name ?? null, null),
        arity: typeof value === 'function' ? value.length : null,
      };
    } catch (error) {
      direct[key] = { readable: false, accessError: errorInfo(error).message };
    }
  }
  const mixins = {};
  for (const key of ['on', 'once', 'effect', 'interval', 'timeout', 'throttle', 'debounce', 'get', 'inject', 'plugin']) {
    let value;
    try {
      // cordis 的 service/mixin 属性访问受 inject 约束：未声明 inject 时读取会抛错，
      // 这本身就是 Gate 0 要记录的事实，不能让探针因此挂掉。
      value = ctx[key];
    } catch (error) {
      mixins[key] = { present: false, accessError: errorInfo(error).message };
      continue;
    }
    mixins[key] = {
      present: typeof value === 'function',
      typeof: typeof value,
      arity: typeof value === 'function' ? value.length : null,
    };
  }
  return {
    capturedAt: new Date().toISOString(),
    services,
    direct,
    mixins,
    note: '`intervals`/`events` 不是 service；ctx.interval 来自 cordis timer mixin，事件经 ctx.on 注册。属性读取需要 inject 声明。',
  };
}

/**
 * tokenMeter.measure 的签名与一次调用结果摘要。
 * @param {object} ctx
 * @returns {object}
 */
function tokenMeterSnapshot(ctx) {
  const service = safeGet(() => ctx.get('tokenMeter'), undefined);
  if (!service) return { present: false };
  const measure = service.measure;
  const source = methodSource(service, 'measure');
  return {
    present: true,
    measure: {
      typeof: typeof measure,
      arity: typeof measure === 'function' ? measure.length : null,
      source: typeof measure === 'function' ? truncate(Function.prototype.toString.call(measure), MAX_TEXT) : null,
      prototypeSource: source,
    },
    estimateMessage: {
      typeof: typeof service.estimateMessage,
      arity: typeof service.estimateMessage === 'function' ? service.estimateMessage.length : null,
    },
    methods: methodList(service, 30),
    measureResult: null,
  };
}

/**
 * 摘要一次 measure 返回值：键名、是否有 nodes/surface/seq、nodes 是否为 seq 数组。
 * @param {unknown} measurement
 * @returns {object}
 */
function measurementSnapshot(measurement) {
  if (!measurement || typeof measurement !== 'object') {
    return { ok: true, type: typeof measurement, value: truncate(measurement, 240) };
  }
  const keys = Object.keys(measurement);
  const nodes = measurement.nodes;
  const nodeObjects = Array.isArray(nodes) ? nodes.filter((node) => node && typeof node === 'object') : [];
  const summary = {
    ok: true,
    keys,
    totalTokens: measurement.totalTokens ?? null,
    surfaceTokens: measurement.surfaceTokens ?? null,
    surfaceDeltaTokens: measurement.surfaceDeltaTokens ?? null,
    logRevision: measurement.logRevision ?? null,
    baselineKeys: measurement.baseline && typeof measurement.baseline === 'object'
      ? Object.keys(measurement.baseline)
      : null,
    baselineTokens: measurement.baseline?.tokens ?? null,
    hasNodesKey: 'nodes' in measurement,
    hasSurfaceKey: 'surface' in measurement,
    hasSeqKey: 'seq' in measurement,
    nodes: Array.isArray(nodes)
      ? {
          isArray: true,
          length: nodes.length,
          allNumbers: nodes.every((node) => typeof node === 'number'),
          allObjectsWithSeq: nodeObjects.length === nodes.length
            && nodeObjects.length > 0
            && nodeObjects.every((node) => typeof node.seq === 'number'),
          seqs: nodeObjects.map((node) => node.seq ?? null),
          sample: nodes.slice(0, 20),
          firstNodeKeys: nodeObjects[0] ? Object.keys(nodeObjects[0]) : null,
        }
      : { isArray: false, type: typeof nodes },
    preview: truncate(safeGet(() => JSON.stringify(measurement, jsonReplacer), '[unserializable]'), MAX_PREVIEW),
  };
  return summary;
}

/**
 * compaction.compactRegion 的 arity/源码；只读，绝不调用（它会改写 surface）。
 * @param {object} ctx
 * @returns {object}
 */
function compactionSnapshot(ctx) {
  const service = safeGet(() => ctx.get('compaction'), undefined);
  if (!service) return { present: false };
  const compactRegion = service.compactRegion;
  const source = methodSource(service, 'compactRegion');
  const compactNowSource = methodSource(service, 'compactNow');
  return {
    present: true,
    compactRegion: {
      typeof: typeof compactRegion,
      arity: typeof compactRegion === 'function' ? compactRegion.length : null,
      source: typeof compactRegion === 'function'
        ? truncate(Function.prototype.toString.call(compactRegion), MAX_TEXT)
        : null,
      prototypeSource: source,
      parameters: source.parameters ?? null,
    },
    compactNow: {
      typeof: typeof service.compactNow,
      arity: typeof service.compactNow === 'function' ? service.compactNow.length : null,
      prototypeSource: compactNowSource,
    },
    methods: methodList(service, 30),
    note: 'compactRegion 只读取签名，未调用；调用会改写 surface。',
  };
}

/**
 * 采集一次会话 surface 快照：nodes 是 surface 节点 seq 序列，不是连续事件 seq。
 * @param {object} session
 * @returns {object}
 */
function surfaceSnapshot(session) {
  const surface = session?.surface;
  if (!surface) return { available: false };
  const nodes = safeGet(() => Array.from(surface.nodes ?? []), null);
  return {
    available: true,
    nodeCount: Array.isArray(nodes) ? nodes.length : null,
    nodesSample: Array.isArray(nodes) ? nodes.slice(0, 40) : null,
    allSeqNumbers: Array.isArray(nodes) ? nodes.every((node) => typeof node === 'number') : null,
    contentGeneration: safeGet(() => surface.contentGeneration, null),
    replaceGeneration: safeGet(() => surface.replaceGeneration, null),
    logLength: safeGet(() => session.log?.length ?? null, null),
    firstLiveSeq: safeGet(() => session.firstLiveSeq ?? null, null),
    inheritedEventCount: safeGet(() => session.inheritedEventCount ?? null, null),
  };
}

/**
 * session header 的少量安全字段（不含请求头/凭据）。
 * @param {object} session
 * @returns {object}
 */
function headerSnapshot(session) {
  const header = session?.header;
  if (!header || typeof header !== 'object') return { available: false };
  return {
    available: true,
    id: header.id ?? null,
    cwd: header.cwd ?? null,
    version: header.version ?? null,
    isSeeded: header.isSeeded ?? null,
    agentPreset: header.agentPreset ?? null,
    keys: Object.keys(header).slice(0, 20),
  };
}

/**
 * 从 message 提取纯文本（user message 的 content 可能是 string 或 block 数组）。
 * @param {object} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (block.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof message?.text === 'string') return message.text;
  return '';
}

/**
 * payload.messages 的范围摘要：条数、角色序列、每条内容长度与前 80 字。
 * @param {unknown} messages
 * @returns {object}
 */
function messagesSnapshot(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const entries = list.slice(0, 50).map((message, index) => {
    const text = messageText(message);
    return {
      index,
      role: message?.role ?? null,
      id: message?.id ?? null,
      contentShape: Array.isArray(message?.content)
        ? message.content.map((block) => block?.type ?? typeof block)
        : typeof message?.content,
      textLength: text.length,
      textPrefix: truncate(text, 80),
      keys: message && typeof message === 'object' ? Object.keys(message).slice(0, 20) : [],
    };
  });
  return {
    count: list.length,
    roles: list.map((message) => message?.role ?? null),
    entries,
  };
}

/**
 * 首个 pre-step 的完整（截断）payload 快照。
 * @param {object} ctx
 * @param {object} payload
 * @returns {object}
 */
function preStepSnapshot(ctx, payload) {
  const agent = payload?.agent;
  const session = agent?.session;
  const preset = {
    header: session?.header?.agentPreset ?? null,
    projection: safeGet(() => ctx.get('sessionProjections')?.stateOf?.(session, 'agentPreset') ?? null, null),
    agentKeys: agent && typeof agent === 'object'
      ? ['preset', 'agentPreset', 'presetId'].filter((key) => key in agent)
      : [],
    payloadKeys: payload && typeof payload === 'object'
      ? Object.keys(payload).filter((key) => /preset/i.test(key))
      : [],
  };
  return {
    capturedAt: new Date().toISOString(),
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
    turn: payload?.turn ?? null,
    step: payload?.step ?? null,
    hasSignal: Boolean(payload?.signal),
    agent: {
      id: agent?.id ?? null,
      status: agent?.status ?? null,
      keys: agent && typeof agent === 'object' ? Object.keys(agent).slice(0, 30) : [],
    },
    session: {
      id: session?.id ?? null,
      header: headerSnapshot(session),
      surface: surfaceSnapshot(session),
    },
    preset,
    messages: messagesSnapshot(payload?.messages),
  };
}

/**
 * 采集 node:sqlite 可用性与 DatabaseSync 内置 SQLite 版本（内存库，不落盘）。
 * @returns {Promise<object>}
 */
async function sqliteSnapshot() {
  try {
    const mod = await import('node:sqlite');
    const snapshot = {
      ok: true,
      exports: Object.keys(mod),
      DatabaseSync: typeof mod.DatabaseSync,
      StatementSync: typeof mod.StatementSync,
      DatabaseSyncArity: typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync.length : null,
      sqliteVersion: process.versions?.sqlite ?? null,
    };
    if (typeof mod.DatabaseSync === 'function') {
      let database;
      try {
        database = new mod.DatabaseSync(':memory:');
        const row = database.prepare('select sqlite_version() as version').get();
        snapshot.sqliteVersion = row?.version ?? snapshot.sqliteVersion;
        snapshot.databaseSyncCreated = true;
      } catch (error) {
        snapshot.databaseSyncCreated = false;
        snapshot.databaseSyncError = errorInfo(error);
      } finally {
        safeGet(() => database?.close?.(), undefined);
      }
    }
    return snapshot;
  } catch (error) {
    return { ok: false, error: errorInfo(error) };
  }
}

/**
 * 采集平台暴露的 session 列表/读取面；只调用只读的 sessions.list()。
 * @param {object} ctx
 * @returns {object}
 */
function sessionsSnapshot(ctx) {
  const sessions = safeGet(() => ctx.get('sessions'), undefined);
  const live = safeGet(() => sessions?.list?.(), null);
  return {
    sessions: {
      present: Boolean(sessions),
      list: typeof sessions?.list,
      get: typeof sessions?.get,
      listArity: typeof sessions?.list === 'function' ? sessions.list.length : null,
      getArity: typeof sessions?.get === 'function' ? sessions.get.length : null,
      liveCount: Array.isArray(live) ? live.length : null,
      liveIds: Array.isArray(live) ? live.map((session) => session?.id ?? null).slice(0, 20) : null,
    },
    sessionQuery: {
      present: Boolean(safeGet(() => ctx.get('sessionQuery'), undefined)),
      methods: methodList(safeGet(() => ctx.get('sessionQuery'), null), 30),
    },
    sessionController: {
      present: Boolean(safeGet(() => ctx.get('sessionController'), undefined)),
      methods: methodList(safeGet(() => ctx.get('sessionController'), null), 30),
    },
    note: '只调用 sessions.list()（只读）；sessionQuery/sessionController 只记录方法面。',
  };
}

/**
 * C5-H2：llm 服务的挂载与调用形状。
 *
 * dsh-llm 由 dsh-base 晚挂载（`super(ctx, 'llm')`，dsh-llm/lib/index.js:1816），
 * 插件 apply 时通常还是 undefined。这里只记录能力与签名，不发起真实模型调用：
 *   - listProviders() 同步返回 [{id,name}]（dsh-llm/lib/index.js:1908）；
 *   - listModels(provider) 异步返回 [{id,name}]（:2086）；
 *   - stream(options) 返回异步迭代器（:2393，经 ctx.waterfall('llm/stream')）。
 * 探针在启动与首个 pre-step 各采样一次，便于观察晚注册。
 *
 * @param {object} ctx
 * @returns {object}
 */
function llmSnapshot(ctx) {
  const service = safeGet(() => ctx.get('llm'), undefined);
  if (!service) {
    return {
      present: false,
      capability: false,
      mount: 'dsh-llm/lib/index.js:1816',
      note: 'llm 由 dsh-base 晚挂载；apply 时不存在是正常的，插件每次调用前重新探测。',
    };
  }
  let providers = null;
  let providerError = null;
  if (typeof service.listProviders === 'function') {
    try {
      const rows = service.listProviders();
      providers = Array.isArray(rows)
        ? rows.map((row) => ({ id: row?.id ?? null, name: row?.name ?? null })).slice(0, 20)
        : null;
    } catch (error) {
      providerError = errorInfo(error);
    }
  }
  return {
    present: true,
    capability: typeof service.stream === 'function',
    mount: 'dsh-llm/lib/index.js:1816',
    listProviders: {
      typeof: typeof service.listProviders,
      arity: typeof service.listProviders === 'function' ? service.listProviders.length : null,
      sync: true,
      source: methodSource(service, 'listProviders'),
      providers,
    },
    listModels: {
      typeof: typeof service.listModels,
      arity: typeof service.listModels === 'function' ? service.listModels.length : null,
      async: true,
      source: methodSource(service, 'listModels'),
      note: 'dsh-llm/lib/index.js:2086；provider 必须是非空字符串，返回去重后的模型目录。',
    },
    stream: {
      typeof: typeof service.stream,
      arity: typeof service.stream === 'function' ? service.stream.length : null,
      source: methodSource(service, 'stream'),
      note: 'dsh-llm/lib/index.js:2393；返回 async iterable，chunk.type=text-delta 累积文本，finish.reason 表示结束。',
    },
    providerError,
    note: 'C5-H2：插件只在需要巩固/闲聊时重新解析，成功的 route 缓存 5 分钟，null 不缓存。',
  };
}

/**
 * 把探针挂进当前 ctx：启动写一次，首个 pre-step 再补一次真实 payload。
 * @param {object} ctx DSH cordis 上下文
 * @param {object} [config] 平台传入的插件配置
 */
export function apply(ctx, config) {
  const output = resolveOutput(config);
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    plugin: name,
    startedAt,
    output,
    configKeys: config && typeof config === 'object' ? Object.keys(config) : [],
    process: processInfo(),
    sqlite: { ok: null, status: 'pending' },
    capabilities: capabilitySnapshot(ctx),
    tokenMeter: tokenMeterSnapshot(ctx),
    compaction: compactionSnapshot(ctx),
    sessions: sessionsSnapshot(ctx),
    llm: llmSnapshot(ctx),
    events: {
      preStep: { registered: false, total: 0, sessions: {}, first: null, occurrences: [] },
      turnStopping: { registered: false, fired: 0, last: null },
      agentCreated: { registered: false, sessions: [] },
      agentError: { registered: false, errors: [] },
    },
    preStep: null,
    errors: [],
  };

  let closed = false;

  /**
   * 原子写 probe.json；任何写失败都不抛出到宿主，避免探针影响业务。
   */
  function flush() {
    if (closed) return;
    try {
      mkdirSync(dirname(output), { recursive: true });
      const text = JSON.stringify(report, jsonReplacer, 2);
      const temporary = `${output}.tmp-${process.pid}`;
      writeFileSync(temporary, text, 'utf8');
      try {
        renameSync(temporary, output);
      } catch {
        writeFileSync(output, text, 'utf8');
      }
    } catch {
      // 探针不能因为落盘失败影响宿主；调用方可在文档中查看 output 路径。
    }
  }

  function noteError(scope, error) {
    report.errors.push({ scope, at: new Date().toISOString(), ...errorInfo(error) });
    if (report.errors.length > 20) report.errors.shift();
  }

  // 启动即落盘：即使随后没有会话或模型调用失败，W2/能力面仍然可读。
  flush();

  // node:sqlite 的 import 是异步的，完成后补写；不阻塞插件装载。
  void sqliteSnapshot().then((snapshot) => {
    report.sqlite = snapshot;
    flush();
  });

  // 进程退出前再写一次，保证 turn-stopping / 多会话计数不丢。
  ctx.effect(() => {
    const onExit = () => flush();
    process.on('exit', onExit);
    return () => process.off('exit', onExit);
  }, 'gate0-probe:flush-on-exit');

  /**
   * pre-step 只记录，不改变决策：记录完必须原样调用 next()。
   */
  try {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const session = payload?.agent?.session;
        const sessionId = session?.id ?? null;
        const event = {
          at: new Date().toISOString(),
          sessionId,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
          messageCount: Array.isArray(payload?.messages) ? payload.messages.length : null,
          roles: Array.isArray(payload?.messages) ? payload.messages.map((message) => message?.role ?? null) : null,
          surfaceNodeCount: safeGet(() => session?.surface?.nodes?.length ?? null, null),
          surfaceNodeSample: safeGet(() => Array.from(session?.surface?.nodes ?? []).slice(0, 20), null),
          logLength: safeGet(() => session?.log?.length ?? null, null),
        };

        const preStep = report.events.preStep;
        preStep.total += 1;
        preStep.occurrences.push(event);
        if (preStep.occurrences.length > MAX_PRE_STEP_EVENTS) preStep.occurrences.shift();

        const key = sessionId ?? '(no-session)';
        const perSession = preStep.sessions[key] ?? {
          count: 0,
          firstTurn: event.turn,
          firstStep: event.step,
          lastTurn: event.turn,
          lastStep: event.step,
        };
        perSession.count += 1;
        perSession.lastTurn = event.turn;
        perSession.lastStep = event.step;
        preStep.sessions[key] = perSession;

        // 首个 pre-step：完整 payload 快照 + 一次真实 tokenMeter.measure。
        if (!report.preStep) {
          report.preStep = preStepSnapshot(ctx, payload);
          preStep.first = { at: event.at, sessionId, turn: event.turn, step: event.step };
          // 有些 service 在 boot 后才挂载；首步刷新一次能力面。
          report.capabilities = capabilitySnapshot(ctx);
          if (!report.tokenMeter?.present) report.tokenMeter = tokenMeterSnapshot(ctx);
          if (!report.compaction?.present) report.compaction = compactionSnapshot(ctx);
          report.sessions = sessionsSnapshot(ctx);
          // C5-H2：llm 可能晚于 apply 挂载，首步再采样一次能力/方法面。
          report.llm = llmSnapshot(ctx);

          const meter = safeGet(() => ctx.get('tokenMeter'), undefined);
          if (typeof meter?.measure === 'function' && session) {
            try {
              const measurement = meter.measure(session);
              report.tokenMeter.measureResult = measurementSnapshot(measurement);
            } catch (error) {
              report.tokenMeter.measureResult = { ok: false, error: errorInfo(error) };
            }
          }
        }
      } catch (error) {
        noteError('agent/pre-step', error);
      } finally {
        flush();
      }
      return next();
    });
    report.events.preStep.registered = true;
    report.events.preStep.disposerType = typeof dispose;
    flush();
  } catch (error) {
    noteError('agent/pre-step:register', error);
    flush();
  }

  // turn-stopping 是 serial 事件（无 next）；只记录，不 steer、不阻塞。
  try {
    const dispose = ctx.on('agent/turn-stopping', (payload) => {
      try {
        const turnStopping = report.events.turnStopping;
        turnStopping.fired += 1;
        turnStopping.last = {
          at: new Date().toISOString(),
          sessionId: payload?.agent?.session?.id ?? null,
          turn: payload?.turn ?? null,
        };
        // turn 即将关闭时 surface 非空：这是观察 compactRegion 所用 seq 的最佳时机。
        const session = payload?.agent?.session;
        const meter = safeGet(() => ctx.get('tokenMeter'), undefined);
        if (!report.tokenMeter.surfaceMeasurement && typeof meter?.measure === 'function' && session) {
          try {
            report.tokenMeter.surfaceMeasurement = {
              ...measurementSnapshot(meter.measure(session)),
              at: new Date().toISOString(),
              logLength: safeGet(() => session?.log?.length ?? null, null),
            };
          } catch (error) {
            report.tokenMeter.surfaceMeasurement = { ok: false, error: errorInfo(error) };
          }
        }
      } catch (error) {
        noteError('agent/turn-stopping', error);
      } finally {
        flush();
      }
    });
    report.events.turnStopping.registered = true;
    report.events.turnStopping.disposerType = typeof dispose;
    flush();
  } catch (error) {
    noteError('agent/turn-stopping:register', error);
    flush();
  }

  // 记录 agent 生命周期，用于判断多会话/子会话是否共享本进程的 pre-step。
  try {
    const dispose = ctx.on('agent/created', (payload) => {
      try {
        const session = payload?.agent?.session;
        const id = session?.id ?? null;
        if (id && !report.events.agentCreated.sessions.includes(id)) {
          report.events.agentCreated.sessions.push(id);
          if (report.events.agentCreated.sessions.length > 50) report.events.agentCreated.sessions.shift();
        }
      } catch (error) {
        noteError('agent/created', error);
      }
    });
    report.events.agentCreated.registered = true;
    report.events.agentCreated.disposerType = typeof dispose;
  } catch (error) {
    noteError('agent/created:register', error);
  }

  // 记录模型/会话错误（只留名称与截断消息），供 headless 失败时解释原因。
  try {
    const dispose = ctx.on('agent/error', (payload) => {
      try {
        report.events.agentError.errors.push({
          at: new Date().toISOString(),
          sessionId: payload?.agent?.session?.id ?? null,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
          error: errorInfo(payload?.error),
        });
        if (report.events.agentError.errors.length > 10) report.events.agentError.errors.shift();
        flush();
      } catch (error) {
        noteError('agent/error', error);
      }
    });
    report.events.agentError.registered = true;
    report.events.agentError.disposerType = typeof dispose;
  } catch (error) {
    noteError('agent/error:register', error);
  }

  flush();
  return {
    dispose() {
      closed = true;
    },
  };
}
