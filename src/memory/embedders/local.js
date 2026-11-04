/**
 * W4：local embedder —— 可选动态加载 @huggingface/transformers。
 *
 * 主包保持零第三方依赖：该包不写进 package.json dependencies，
 * 未安装时 embed() 抛 EmbeddingUnavailable，调用方回退纯 FTS。
 *
 * 默认模型 Xenova/bge-small-zh-v1.5（MIT、24M 参数、512 维、int8 约 23.9MB）。
 * 查询侧按 BGE 官方用法加指令前缀；入库事实不加（prefixQuery=false 可关）。
 *
 * E2-M1：回填与查询的超时/占用分离：
 *   - 查询/前台等待仍以 `timeoutMs`（config.vector.embedTimeoutMs，默认 300）为上限；
 *   - 空闲回填的推理以 `backfillTimeoutMs`（config.vector.backfillTimeoutMs，
 *     默认 30s）为上限，避免几十条 bge-small int8 必然超过 300ms；
 *   - 推理单飞：同一 embedder 同时最多一个 in-flight。查询遇到占用直接抛
 *     `EmbeddingBusy`（调用方回退纯 FTS，不排队）；idle-probe 回填遇到占用
 *     跳过本次 tick。`Promise.race` 超时后底层推理仍算占用，直到真正结束
 *     才允许下一批，避免批次叠加；
 *   - 加载单飞（L2-3）：同一时刻最多一个加载 promise。`loadTimeoutMs` 只放弃
 *     等待，不取消底层加载；重试复用尚未结束的 promise，不再并行起第二个。
 */

import { EmbeddingBusy, EmbeddingTimeout, EmbeddingUnavailable } from './errors.js';
import { normalizeTexts, rowsFromResponse, toFloat32 } from './util.js';

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';
const DEFAULT_DIM = 512;
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';
const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_BACKFILL_TIMEOUT_MS = 30_000;
const DEFAULT_LOAD_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_MAX_LOAD_ATTEMPTS = 5;

/**
 * 已知模型的 embedding 维度；未知模型按 512 处理（与 bge-small 对齐）。
 */
const KNOWN_MODEL_DIMS = Object.freeze({
  'Xenova/bge-small-zh-v1.5': 512,
  'Xenova/bge-small-zh': 512,
  'Xenova/e5-small': 384,
  'Xenova/e5-small-v2': 384,
  'intfloat/multilingual-e5-small': 384,
});

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 依赖未安装的可判别判定：Loader/初始化抛出的错误链里出现模块缺失。
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingDependency(error) {
  const seen = new Set();
  let current = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current.code === 'ERR_MODULE_NOT_FOUND' || current.code === 'MODULE_NOT_FOUND') {
      return true;
    }
    const message = typeof current.message === 'string' ? current.message : '';
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/u.test(message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Promise.race 形式的超时（不取消底层操作，只限制前台等待）。
 * 定时器 unref：不因等待超时而拖住进程退出/测试结束。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {() => Error} onTimeout
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  /** @type {NodeJS.Timeout|undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} output transformers.js 输出（Tensor 或数组）
 * @param {number} expectedCount
 * @returns {Float32Array[]}
 */
function outputRows(output, expectedCount) {
  let value = output;
  if (value !== null && typeof value === 'object' && typeof value.tolist === 'function') {
    value = value.tolist();
  }
  let rows = rowsFromResponse(value);
  if (rows === null && expectedCount === 1 && Array.isArray(value)
    && value.length > 0 && typeof value[0] === 'number') {
    rows = [value];
  }
  if (rows === null || rows.length !== expectedCount) {
    throw new EmbeddingUnavailable(
      `[embedder:local] unexpected output shape (expected ${expectedCount} rows)`,
    );
  }
  return rows.map((row) => toFloat32(row));
}

/**
 * @param {{
 *   model?: string,
 *   prefixQuery?: boolean,
 *   dim?: number,
 *   loader?: () => Promise<unknown>,
 *   timeoutMs?: number,
 *   backfillTimeoutMs?: number,
 *   loadTimeoutMs?: number,
 *   retryBaseMs?: number,
 *   retryMaxMs?: number,
 *   maxLoadAttempts?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createLocalEmbedder(options = {}) {
  const model = typeof options.model === 'string' && options.model.trim() !== ''
    ? options.model.trim()
    : DEFAULT_MODEL;
  const dim = Number.isInteger(options.dim) && options.dim > 0
    ? options.dim
    : (KNOWN_MODEL_DIMS[model] || DEFAULT_DIM);
  const prefixQuery = options.prefixQuery !== false;
  const loader = typeof options.loader === 'function'
    ? options.loader
    : () => import('@huggingface/transformers');
  // E-M1：查询/前台等待与推理的统一上限（config.vector.embedTimeoutMs）。
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  // E2-M1：回填推理的独立上限（config.vector.backfillTimeoutMs）。
  const backfillTimeoutMs = positiveInt(options.backfillTimeoutMs, DEFAULT_BACKFILL_TIMEOUT_MS);
  // 后台加载硬上限：只放弃本次等待，不取消底层加载；至少 30s 以覆盖首次下载。
  const loadTimeoutMs = positiveInt(
    options.loadTimeoutMs,
    Math.max(timeoutMs * 20, DEFAULT_LOAD_TIMEOUT_MS),
  );
  const retryBaseMs = positiveInt(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const retryMaxMs = positiveInt(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
  const maxLoadAttempts = positiveInt(options.maxLoadAttempts, DEFAULT_MAX_LOAD_ATTEMPTS);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /** @type {unknown} 已加载的 transformers.js pipeline */
  let extractor = null;
  /**
   * L2-3：底层加载 promise 单飞。只有真正 settle 才清空——
   * loadTimeoutMs 只让等待方放弃，不取消、也不清空它，重试复用同一个。
   * @type {Promise<unknown>|null}
   */
  let loadInFlight = null;
  /** E2-M1：当前推理 promise（底层，超时后仍保留到真正结束）。 */
  let inferenceInFlight = null;
  /** @type {Error|null} 依赖未安装等永久失败：停用 local，不再重试。 */
  let fatalError = null;
  /** @type {Error|null} 最近一次加载失败（transient 时用于同一退避窗口内直接复用）。 */
  let lastError = null;
  /** 当前退避窗口内连续失败次数。 */
  let failures = 0;
  /** 下一次允许重试的时间戳（ms）。 */
  let nextRetryAt = 0;

  function statusOf() {
    if (fatalError !== null) return 'fatal';
    if (extractor !== null) return 'ready';
    if (loadInFlight !== null) return 'loading';
    if (lastError !== null && now() < nextRetryAt) return 'backoff';
    return 'idle';
  }

  /** @param {unknown} error @returns {Error} 带 kind/fatal/transient 的加载错误 */
  function classifyLoadFailure(error) {
    if (error instanceof EmbeddingTimeout) return error;
    if (isMissingDependency(error)) {
      return new EmbeddingUnavailable(
        '[@huggingface/transformers] not installed; run "npm i @huggingface/transformers" to enable vector.embedder=local',
        { cause: error, fatal: true, kind: 'fatal' },
      );
    }
    if (error instanceof EmbeddingUnavailable) {
      // 初始化阶段抛出的 EmbeddingUnavailable 一律按可重试处理（保留原 message）。
      return new EmbeddingUnavailable(error.message, {
        cause: error.cause ?? error,
        transient: true,
        kind: 'transient',
      });
    }
    return new EmbeddingUnavailable(
      `[embedder:local] failed to load model "${model}"`,
      { cause: error, transient: true, kind: 'transient' },
    );
  }

  /**
   * 真正执行加载（含依赖 import 与 pipeline 初始化）。
   * L2-3：这里不套 loadTimeoutMs——超时只由等待方的 withTimeout 表达，
   * 底层加载保留在 loadInFlight 里供重试复用，避免并行第二个加载。
   * @returns {Promise<unknown>}
   */
  async function doLoad() {
    let mod;
    try {
      mod = await loader();
    } catch (error) {
      throw classifyLoadFailure(error);
    }
    if (mod === null || typeof mod !== 'object' || typeof mod.pipeline !== 'function') {
      throw new EmbeddingUnavailable('[@huggingface/transformers] does not export pipeline()', {
        fatal: true,
        kind: 'fatal',
      });
    }
    try {
      return await mod.pipeline('feature-extraction', model, { dtype: 'q8' });
    } catch (error) {
      throw classifyLoadFailure(error);
    }
  }

  /**
   * 打开（或复用）唯一的加载 promise；成功/失败状态在底层 settle 时记录。
   * @returns {Promise<unknown>}
   */
  function beginLoad() {
    const pending = (async () => {
      try {
        const loaded = await doLoad();
        extractor = loaded;
        failures = 0;
        lastError = null;
        nextRetryAt = 0;
        return loaded;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.fatal === true) {
          fatalError = lastError;
        } else {
          failures += 1;
          if (failures >= maxLoadAttempts) {
            // 连续失败达到上限：长冷却后允许新一轮尝试，绝不永久停用。
            nextRetryAt = now() + retryMaxMs;
            failures = 0;
          } else {
            nextRetryAt = now() + Math.min(retryBaseMs * 2 ** (failures - 1), retryMaxMs);
          }
        }
        throw lastError;
      }
    })();
    loadInFlight = pending;
    const clear = () => {
      if (loadInFlight === pending) loadInFlight = null;
    };
    // 失败由等待方处理；这里挂一个空 handler 只为在超时后仍能清空并避免 unhandled。
    pending.then(clear, clear);
    return pending;
  }

  /**
   * E-M1/L2-3：异步预热。不阻塞调用方；失败只 reject（由调用方决定是否记日志）。
   * 退避窗口内重复调用立即拿到同一 transient 错误，不再打网络；
   * 已有未结束的加载时复用它，等待上限仍是 loadTimeoutMs（只放弃等待不取消）。
   * @returns {Promise<unknown>}
   */
  function warmup() {
    if (extractor !== null) return Promise.resolve(extractor);
    if (fatalError !== null) return Promise.reject(fatalError);
    if (loadInFlight !== null) {
      return withTimeout(
        loadInFlight,
        loadTimeoutMs,
        () => new EmbeddingTimeout(
          `[embedder:local] model load still pending after ${loadTimeoutMs}ms; reusing the same load`,
          { timeoutMs: loadTimeoutMs },
        ),
      );
    }
    if (lastError !== null && now() < nextRetryAt) return Promise.reject(lastError);
    return withTimeout(
      beginLoad(),
      loadTimeoutMs,
      () => new EmbeddingTimeout(
        `[embedder:local] model load exceeded ${loadTimeoutMs}ms; continuing in background`,
        { timeoutMs: loadTimeoutMs },
      ),
    );
  }

  /**
   * 前台取 extractor：最多等 timeoutMs；模型仍在后台加载时抛 transient 超时。
   * @returns {Promise<unknown>}
   */
  async function ensureExtractor() {
    if (fatalError !== null) throw fatalError;
    if (extractor !== null) return extractor;
    if (lastError !== null && now() < nextRetryAt) throw lastError;
    const pending = warmup();
    return withTimeout(
      pending,
      timeoutMs,
      () => new EmbeddingTimeout(
        `[embedder:local] model still loading; waited ${timeoutMs}ms, warmup continues in background`,
        { timeoutMs },
      ),
    );
  }

  /**
   * 单飞推理：已有 in-flight 时直接抛 EmbeddingBusy（不排队）。
   * 超时只截断本次等待，inferenceInFlight 保留到底层 settle，防止批次叠加。
   * @param {unknown} ready
   * @param {string[]} batch
   * @param {number} waitMs
   * @param {string} label
   * @returns {Promise<unknown>}
   */
  async function inferOnce(ready, batch, waitMs, label) {
    if (inferenceInFlight !== null) {
      throw new EmbeddingBusy(
        `[embedder:local] inference already in flight; query falls back to FTS`,
        { timeoutMs: waitMs },
      );
    }
    const pending = Promise.resolve().then(() => ready(batch, { pooling: 'mean', normalize: true }));
    inferenceInFlight = pending;
    const clear = () => {
      if (inferenceInFlight === pending) inferenceInFlight = null;
    };
    pending.then(clear, clear);
    try {
      return await withTimeout(
        pending,
        waitMs,
        () => new EmbeddingTimeout(
          `[embedder:local] ${label} timed out after ${waitMs}ms`,
          { timeoutMs: waitMs },
        ),
      );
    } catch (error) {
      if (error instanceof EmbeddingTimeout || error instanceof EmbeddingBusy) throw error;
      throw new EmbeddingUnavailable('[embedder:local] inference failed', {
        cause: error,
        transient: true,
        kind: 'transient',
      });
    }
  }

  /**
   * @param {string[]} texts
   * @param {number} waitMs 推理等待上限（查询=timeoutMs，回填=backfillTimeoutMs）
   * @param {string} label 仅用于超时消息
   * @returns {Promise<Float32Array[]>}
   */
  async function embedRaw(texts, waitMs, label) {
    const batch = normalizeTexts(texts);
    if (batch.length === 0) return [];
    const ready = await ensureExtractor();
    const output = await inferOnce(ready, batch, waitMs, label);
    const rows = outputRows(output, batch.length);
    for (const row of rows) {
      if (row.length !== dim) {
        throw new EmbeddingUnavailable(
          `[embedder:local] dimension mismatch: model returned ${row.length}, expected ${dim}`,
        );
      }
    }
    return rows;
  }

  return {
    id: `local:${model}:${dim}`,
    dim,
    kind: 'local',
    model,
    prefixQuery,
    timeoutMs,
    backfillTimeoutMs,
    loadTimeoutMs,
    /** E-M1：异步预热（启动 / idle-probe 调用）；失败不抛给调用方，除非显式 await。 */
    warmup,
    /** E2-M1：是否有推理在跑（查询遇占用回退 FTS，回填遇占用跳过本次）。 */
    busy: () => inferenceInFlight !== null,
    /** @returns {'idle'|'loading'|'ready'|'backoff'|'fatal'} */
    status: () => statusOf(),
    /** 诊断快照：/状态 或日志可用。 */
    state() {
      return {
        status: statusOf(),
        attempts: failures,
        nextRetryAt,
        lastError: lastError === null
          ? null
          : {
            code: lastError.code ?? null,
            kind: lastError.kind ?? null,
            transient: lastError.transient === true,
            fatal: lastError.fatal === true,
            message: lastError.message,
          },
      };
    },
    /** 依赖未安装等永久失败：local 已停用。 */
    get disabled() {
      return fatalError !== null;
    },
    /**
     * 入库/普通文本：不加指令前缀，使用查询/前台的 timeoutMs。
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embed(texts) {
      return embedRaw(texts, timeoutMs, 'inference');
    },
    /**
     * E2-M1：空闲回填专用；使用独立的 backfillTimeoutMs，避免几十条推理
     * 被查询的 300ms 上限截断。
     * @param {string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embedBackfill(texts) {
      return embedRaw(texts, backfillTimeoutMs, 'backfill inference');
    },
    /**
     * 查询文本：prefixQuery=true 时加 BGE 检索指令前缀。
     * @param {string|string[]} texts
     * @returns {Promise<Float32Array[]>}
     */
    async embedQuery(texts) {
      const batch = normalizeTexts(Array.isArray(texts) ? texts : [texts]);
      if (!prefixQuery) return embedRaw(batch, timeoutMs, 'query inference');
      return embedRaw(batch.map((text) => `${QUERY_INSTRUCTION}${text}`), timeoutMs, 'query inference');
    },
  };
}
