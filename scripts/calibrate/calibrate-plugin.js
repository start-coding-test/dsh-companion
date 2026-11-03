/**
 * 安装自检插件：在真实 DSH 进程内测量机器与上下文，写出建议配置。
 *
 * 由 `scripts/calibrate/calibrate.patch.yml` 以 overlay 形式挂入；也可以
 * 手动加进 profile。插件只读测量、只写 `.data/calibration.json` 与
 * `.data/config.suggested.yml`，**不会**合并配置、不会写人格卡或记忆库。
 *
 * 输出目录优先级：config.outputDir > DSH_CALIBRATE_OUT > 仓库 `.data/`。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

import {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  renderSuggestedYaml,
  suggestConfig,
} from '../../src/calibrate/formula.js';

export const name = 'dsh-companion-calibrate';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIR = resolve(PLUGIN_DIR, '..', '..', '.data');

/** 输出文件名固定，run.mjs 与文档都按这两个名字查找。 */
const CALIBRATION_FILE = 'calibration.json';
const SUGGESTED_FILE = 'config.suggested.yml';

/**
 * 解析输出目录。
 * @param {unknown} config
 * @returns {string}
 */
function resolveOutputDir(config) {
  const configured = config && typeof config === 'object' && typeof config.outputDir === 'string'
    ? config.outputDir
    : undefined;
  const fromEnv = typeof process.env.DSH_CALIBRATE_OUT === 'string' && process.env.DSH_CALIBRATE_OUT.trim() !== ''
    ? process.env.DSH_CALIBRATE_OUT
    : undefined;
  return resolve(configured ?? fromEnv ?? DEFAULT_OUTPUT_DIR);
}

/**
 * 安全读取，不打断宿主。
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
 * 异常转普通对象，绝不带凭据。
 * @param {unknown} error
 * @returns {{name:string,message:string}}
 */
function errorInfo(error) {
  const value = error && typeof error === 'object' ? error : {};
  return {
    name: typeof value.name === 'string' ? value.name : 'Error',
    message: String(value.message ?? error ?? 'unknown').slice(0, 240),
  };
}

/**
 * 中位数；空数组返回 null。
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * 同步等待若干毫秒，用于取得稳定的 RSS 采样；启动时一次性约 45ms。
 * @param {number} milliseconds
 */
function sleepSync(milliseconds) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // 极少数嵌入环境没有 SharedArrayBuffer；直接连续采样即可。
  }
}

/**
 * 从 DSH 安装目录尽力读取版本；读不到就返回 null，绝不猜测。
 * @returns {string|null}
 */
function detectDshVersion() {
  if (typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION.trim() !== '') {
    return process.env.DSH_VERSION.trim();
  }
  if (typeof process.versions?.dsh === 'string' && process.versions.dsh) return process.versions.dsh;

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'));
    candidates.push(join(process.resourcesPath, 'app', 'dsh', 'package.json'));
  }
  candidates.push(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'package.json'));

  for (const file of candidates) {
    const version = safeGet(() => {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return typeof parsed?.version === 'string' ? parsed.version : null;
    }, null);
    if (version) return version;
  }
  return null;
}

/**
 * 测量 node:sqlite 与内置 SQLite 版本（内存库，不落盘）。
 * @returns {Promise<{ok:boolean,version?:string,nodeSqlite?:boolean,error?:object}>}
 */
async function sqliteSnapshot() {
  try {
    const mod = await import('node:sqlite');
    const snapshot = {
      ok: true,
      nodeSqlite: true,
      version: process.versions?.sqlite ?? null,
    };
    if (typeof mod.DatabaseSync === 'function') {
      let database;
      try {
        database = new mod.DatabaseSync(':memory:');
        const row = database.prepare('select sqlite_version() as version').get();
        snapshot.version = row?.version ?? snapshot.version;
      } finally {
        safeGet(() => database?.close?.(), undefined);
      }
    }
    return snapshot;
  } catch (error) {
    return { ok: false, nodeSqlite: false, error: errorInfo(error) };
  }
}

/**
 * 采集 CPU 信息。
 * @returns {{count:number,model:string|null}}
 */
function cpuSnapshot() {
  const cpus = safeGet(() => os.cpus(), []);
  return {
    count: Array.isArray(cpus) ? cpus.length : 0,
    model: Array.isArray(cpus) && cpus[0]?.model ? String(cpus[0].model) : null,
  };
}

/**
 * 从 session 投影/头信息里找 contextWindow。
 * @param {object} ctx
 * @param {object} session
 * @returns {{tokens:number|null,source:string|null}}
 */
function contextWindowFromPlatform(ctx, session) {
  const projections = safeGet(() => ctx.get('sessionProjections'), undefined);
  const state = safeGet(
    () => projections?.stateOf?.(session, 'contextPressure') ?? null,
    null,
  );
  if (state && Number.isFinite(state.contextWindow) && state.contextWindow > 0) {
    return { tokens: state.contextWindow, source: 'platform.sessionProjections.contextPressure' };
  }
  const snapshot = safeGet(
    () => projections?.snapshot?.(session, ['contextPressure'])?.values?.contextPressure ?? null,
    null,
  );
  if (snapshot && Number.isFinite(snapshot.contextWindow) && snapshot.contextWindow > 0) {
    return { tokens: snapshot.contextWindow, source: 'platform.sessionProjections.snapshot' };
  }
  const headerWindow = safeGet(
    () => session?.header?.contextWindow ?? session?.contextWindow ?? null,
    null,
  );
  if (Number.isFinite(headerWindow) && headerWindow > 0) {
    return { tokens: headerWindow, source: 'platform.session.header' };
  }
  return { tokens: null, source: null };
}

/**
 * 写两个输出文件；任何失败都吞掉，避免自检影响 DSH 正常启动。
 * @param {string} outputDir
 * @param {object} report
 * @param {string} yaml
 * @returns {{calibration:string,suggested:string,written:boolean}}
 */
function writeOutputs(outputDir, report, yaml) {
  const calibrationPath = join(outputDir, CALIBRATION_FILE);
  const suggestedPath = join(outputDir, SUGGESTED_FILE);
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, text, 'utf8');
    try {
      renameSync(temporary, path);
    } catch {
      writeFileSync(path, text, 'utf8');
    }
  };
  try {
    write(calibrationPath, `${JSON.stringify(report, null, 2)}\n`);
    write(suggestedPath, yaml);
    return { calibration: calibrationPath, suggested: suggestedPath, written: true };
  } catch (error) {
    return {
      calibration: calibrationPath,
      suggested: suggestedPath,
      written: false,
      error: errorInfo(error),
    };
  }
}

/**
 * 挂载插件。
 * @param {object} ctx DSH cordis 上下文
 * @param {object} [config] patch 配置
 * @returns {{dispose:() => void}}
 */
export function apply(ctx, config) {
  const outputDir = resolveOutputDir(config);
  const generatedAt = new Date().toISOString();
  const configuredContextWindow = Number(config?.contextWindowTokens);
  const startRss = safeGet(() => process.memoryUsage().rss, 0);

  const report = {
    schemaVersion: 1,
    plugin: name,
    generatedAt,
    outputDir,
    merged: false,
    note: 'suggested config is advisory; copy it into config.yml manually',
    measurement: {
      process: {
        node: process.version,
        electron: process.versions?.electron ?? null,
        dsh: detectDshVersion(),
        execPath: process.execPath,
        platform: process.platform,
        arch: process.arch,
      },
      memory: {
        totalmemBytes: safeGet(() => os.totalmem(), 0),
        freememBytes: safeGet(() => os.freemem(), 0),
        rssBytes: startRss,
        rssSamples: [startRss],
        rssMedianBytes: startRss || null,
        rssMethod: 'warm-up + 3 samples, median',
      },
      cpu: cpuSnapshot(),
      sqlite: { ok: null, status: 'pending' },
      contextWindow: {
        tokens: Number.isFinite(configuredContextWindow) && configuredContextWindow > 0
          ? configuredContextWindow
          : FALLBACK_CONTEXT_WINDOW_TOKENS,
        source: Number.isFinite(configuredContextWindow) && configuredContextWindow > 0
          ? 'config.contextWindowTokens'
          : 'fallback',
      },
      tokenMeter: { ok: null, status: 'pending' },
    },
    suggested: {},
    provenance: {},
    outputs: {},
  };

  const rssSamples = [startRss];
  let closed = false;

  /**
   * 根据当前测量重算建议并落盘。第一次在启动时立即写，后续在 sqlite/RSS/
   * pre-step 测量完成后覆盖。
   */
  function flush() {
    if (closed) return;
    const measured = report.measurement;
    const contextWindow = measured.contextWindow.tokens;
    const suggested = suggestConfig({
      totalmemBytes: measured.memory.totalmemBytes,
      rssBytes: measured.memory.rssMedianBytes,
      cpus: measured.cpu.count,
      nodeVersion: measured.process.node,
      electronVersion: measured.process.electron,
      contextWindowTokens: contextWindow,
      timezone: config?.timezone,
    });
    report.suggested = suggested;
    report.provenance = {
      generatedAt,
      node: measured.process.node,
      electron: measured.process.electron,
      dsh: measured.process.dsh,
      rssMedianBytes: measured.memory.rssMedianBytes,
      totalmemBytes: measured.memory.totalmemBytes,
      cpus: measured.cpu.count,
      contextWindowTokens: contextWindow,
      contextWindowSource: measured.contextWindow.source,
    };
    report.outputs = {
      calibration: join(outputDir, CALIBRATION_FILE),
      suggested: join(outputDir, SUGGESTED_FILE),
    };
    const yaml = renderSuggestedYaml(suggested, report.provenance);
    report.outputs = writeOutputs(outputDir, report, yaml);
  }

  // 启动即写：即使随后模型调用失败，也能拿到机器/版本建议。
  flush();

  // SQLite import 异步，完成后补写。
  void sqliteSnapshot().then((snapshot) => {
    report.measurement.sqlite = snapshot;
    flush();
  });

  // RSS：warm-up 后同步取 3 次中位数，避免宿主提前退出时只剩 1 个样本。
  for (let index = 0; index < 3; index += 1) {
    sleepSync(15);
    const rss = safeGet(() => process.memoryUsage().rss, 0);
    if (rss > 0) rssSamples.push(rss);
  }
  if (rssSamples.length > 1) {
    report.measurement.memory.rssSamples = rssSamples;
    report.measurement.memory.rssMedianBytes = median(rssSamples.slice(1));
    flush();
  }

  // 进程退出前再写一次，保证 pre-step 的 tokenMeter 结果不丢。
  try {
    ctx.effect(() => {
      const onExit = () => flush();
      process.on('exit', onExit);
      return () => {
        flush();
        closed = true;
        process.off('exit', onExit);
      };
    }, 'dsh-companion-calibrate:flush-on-exit');
  } catch {
    // ctx.effect 不可用时至少保留启动落盘。
  }

  // 首个 pre-step 测量 tokenMeter（节点数）与平台 contextWindow；不改变决策。
  // 第一个 pre-step 的 surface 可能还是空的，因此 nodes=0 时在后续 step 重试。
  let meterAttempts = 0;
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const session = payload?.agent?.session;
        const meter = report.measurement.tokenMeter;
        const needsMeter = meter.status === 'pending' || (meter.ok === true && meter.nodes === 0);
        if (session && needsMeter && meterAttempts < 12) {
          meterAttempts += 1;
          const platformWindow = contextWindowFromPlatform(ctx, session);
          if (platformWindow.tokens) {
            report.measurement.contextWindow = platformWindow;
          }
          const service = safeGet(() => ctx.get('tokenMeter'), undefined);
          if (typeof service?.measure === 'function') {
            try {
              const measurement = service.measure(session);
              const nodes = Array.isArray(measurement?.nodes) ? measurement.nodes : [];
              report.measurement.tokenMeter = {
                ok: true,
                nodes: nodes.length,
                totalTokens: measurement?.totalTokens ?? null,
                surfaceTokens: measurement?.surfaceTokens ?? null,
              };
            } catch (error) {
              report.measurement.tokenMeter = { ok: false, error: errorInfo(error) };
            }
          } else {
            report.measurement.tokenMeter = { ok: false, error: { name: 'NotFound', message: 'tokenMeter service unavailable' } };
          }
        }
      } catch (error) {
        report.measurement.tokenMeter = { ok: false, error: errorInfo(error) };
      } finally {
        flush();
      }
      return next();
    });
  } catch (error) {
    report.measurement.tokenMeter = { ok: false, error: errorInfo(error) };
    flush();
  }

  return {
    dispose() {
      flush();
      closed = true;
    },
  };
}
