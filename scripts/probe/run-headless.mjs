#!/usr/bin/env node
/**
 * Gate 0 headless 采集器：用临时 DSH_HOME + 独立 profile 跑一次 headless 会话，
 * 把探针写出的 probe.json 拷回仓库 `.data/probe.json`。
 *
 * `--plugin` 是发布门（C-H1 + V3-H1）：不再挂 Gate 0 探针，而是用 `--patch` 把本仓库的
 * 真插件 `src/index.js` 插进 headless profile，跑两轮：
 *   A) 冒烟：断言 `[dsh-companion] scheduler started` 出现、且没有 `did not activate`；
 *   B) 召回：预置 1 条 fact 后发命中消息，断言没有 `reading 'kind'` 崩溃、且该 fact 的
 *      `first_reneed_at` 非空（召回注入真的走通）。
 * 没有 DSH 的机器上该模式退出码 2，可在 CI 里用 `--plugin` 的退出码区分
 * 「跳过」（2）与「失败」（1）。
 *
 * 特点：
 * - 不读、不写用户 `~/.dsh`：DSH_HOME 指向仓库内 `.data/probe-home`；
 * - 不安装依赖、不修改 profile；profile 由 shipped 模板按需生成；
 * - 默认任务只要求模型回一句 ok；即使模型凭据缺失、会话在请求阶段失败，
 *   只要 `agent/pre-step` 已触发，probe.json 仍然有效（H1/H2/W2 可判定）；
 * - 不打印环境变量值；诊断输出会 redact 常见 key 形态。
 *
 * 用法：
 *   node scripts/probe/run-headless.mjs [--help]
 *   node scripts/probe/run-headless.mjs [--task "..." ] [--dsh <path>] [--timeout <ms>]
 *   node scripts/probe/run-headless.mjs --plugin [--dsh <path>] [--keep-home]
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { Store } from '../../src/memory/store.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const PATCH_FILE = join(SCRIPT_DIR, 'probe.patch.yml');
const PROBE_OUT = join(REPO_ROOT, '.data', 'probe.json');
const PROBE_RUN1 = join(REPO_ROOT, '.data', 'probe-run1.json');
const PROBE_HOME = join(REPO_ROOT, '.data', 'probe-home');

/** C-H1 发布门：真插件入口与它专用的 overlay/临时 home。 */
const PLUGIN_ENTRY = join(REPO_ROOT, 'src', 'index.js');
const PLUGIN_PATCH = join(REPO_ROOT, '.data', 'plugin-gate.patch.yml');
const PLUGIN_HOME = join(REPO_ROOT, '.data', 'plugin-gate-home');
const PLUGIN_DB = join(REPO_ROOT, '.data', 'plugin-gate', 'companion.db');
const PLUGIN_MARKER = '[dsh-companion] scheduler started';
const PLUGIN_FAILURE_MARKER = 'did not activate';
const PLUGIN_LOG = join(REPO_ROOT, '.data', 'plugin-gate.log');
/** V3-H1 召回门：预置事实 + 命中消息；命中的 query 长度必须过 M3 查询门。 */
const PLUGIN_RECALL_TASK = '周五要交的周报是什么时候';
const PLUGIN_RECALL_STATEMENT = '每周五要交周报。';
/** C5-H2 巩固门：独立库 + 低阈值，灌入明显超过阈值的文本。 */
const PLUGIN_CONSOLIDATION_PATCH = join(REPO_ROOT, '.data', 'plugin-gate-round-c.patch.yml');
const PLUGIN_CONSOLIDATION_DB = join(REPO_ROOT, '.data', 'plugin-gate', 'round-c.db');
const PLUGIN_CONSOLIDATION_TASK = [
  '请记住下面这段工作记录，之后我会问你细节。',
  '周一上午我们确认了发布清单：C5-H2 需要让巩固在 llm 晚挂载后仍能运行，',
  '选路顺序是宿主 hook、配置 consolidation.model、运行时 provider 探测。',
  '周二修了 resolveConsolidationLlm 的负缓存，成功 route 缓存五分钟，null 不缓存。',
  '周三检查 /状态 输出，要求显示实际的 provider 和 model，找不到时写「巩固：无可用模型」。',
  '周四补了发布门 round C：有凭据时灌入超过阈值的对话，断言 consolidations 至少一行；',
  '没有凭据时标注 SKIP。周五准备发布 v0.4.6，并确认三个时区的 node --test 全绿。',
  '另外记下几个数字：工作记忆阈值 32000，自动压缩 24000，硬阈值 40000，',
  '保留尾部 6144，提醒日上限 3，静默时段 23:00 到 08:00。',
  '这些数字在配置里都有默认值，安装自检要求顶层恰好十六个键。',
  '如果后续要调整巩固模型，只需要改 consolidation.model，不用动其他开关。',
].join('');
/** 真机崩溃原文（v0.4.3：裸内容块没有 source）。 */
const PLUGIN_CRASH_RE = /reading ['"]kind['"]|Cannot read properties of undefined/u;

const HELP = `Gate 0 headless 探针采集器

用法:
  node scripts/probe/run-headless.mjs [options]
  node scripts/probe/run-headless.mjs --plugin [options]

选项:
  --task <text>      发给 headless 会话的任务文本（默认: "Reply with exactly: ok"）
  --task2 <text>     --two-turn 时第二轮的任务文本（默认: "Second turn: reply with exactly: ok"）
  --two-turn         首轮之后用 --session-id 续跑同一会话，采集第 2 个 turn 的
                     pre-step/surface（模型凭据缺失时也能拿到第 2 个 pre-step）
  --plugin           C-H1 发布门：用 --patch 把本仓库真插件（src/index.js）挂到
                     headless，跑三轮：
                       A) 冒烟：出现 "[dsh-companion] scheduler started"、且没有
                          "did not activate"；
                       B) 召回（V3-H1）：在门专用库里预置 1 条 fact 后发命中消息，
                          断言输出里没有 reading 'kind' 崩溃，且该 fact 的
                          first_reneed_at 非空（证明召回真的注入过）。
                       C) 巩固（C5-H2）：换独立库与低阈值，灌入超过阈值的文本，
                          断言 consolidations 至少 1 行；无模型凭据时标注 SKIP。
                      无模型凭据时 agent loop 到不了 pre-step，round B 也标注 SKIP。
                      退出码 0=通过，1=未通过，2=找不到 DSH；完整 stdout/stderr
                      落盘到 .data/plugin-gate.log
  --dsh <path>       DSH CLI 路径（默认依次尝试 DSH_CLI 环境变量、PATH、常见安装目录）
  --timeout <ms>     子进程超时，默认 120000
  --keep-home        保留临时 DSH_HOME（默认也会保留，便于查看日志；目录在 .data/ 下）
  --help, -h         显示本帮助

环境变量:
  DSH_CLI            DSH CLI 路径（同 --dsh）
  DSH_INSTALL_DIR    DeepSeek Harness 安装根目录（用于推导 resources/runtime/cli/bin/dsh.cmd）
  DSH_PROBE_TIMEOUT  超时毫秒数（可被 --timeout 覆盖）

说明:
  - 临时 DSH_HOME 固定为 ${PROBE_HOME}（--plugin 用 ${PLUGIN_HOME}）
  - 探针输出先写入临时 DSH_HOME，再拷贝到 ${PROBE_OUT}
  - 加 --two-turn 时，第一轮报告另存为 .data/probe-run1.json，第二轮报告写入
    .data/probe.json（第二轮 surface 已非空，可回答 compactRegion 的 seq 语义）
  - --plugin 每次重建 .data/plugin-gate/companion.db，避免旧库掩盖激活失败
  - 该脚本不会读取或修改用户 ~/.dsh；若模型凭据缺失，会话可能失败，
    但 agent/pre-step 已在请求前触发，probe.json 仍可用于 Gate 0 判定。
`;

/**
 * 解析命令行参数（保持零依赖）。
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const options = {
    task: 'Reply with exactly: ok',
    task2: 'Second turn: reply with exactly: ok',
    dsh: undefined,
    timeoutMs: Number(process.env.DSH_PROBE_TIMEOUT ?? 120_000),
    keepHome: false,
    twoTurn: false,
    plugin: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--task') {
      options.task = argv[++index] ?? '';
    } else if (arg === '--task2') {
      options.task2 = argv[++index] ?? '';
    } else if (arg === '--two-turn') {
      options.twoTurn = true;
    } else if (arg === '--plugin') {
      options.plugin = true;
    } else if (arg === '--dsh') {
      options.dsh = argv[++index];
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg === '--keep-home') {
      options.keepHome = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer (ms)');
  }
  return options;
}

/**
 * 在 PATH 里找可执行文件（Windows 用 where，其余用 which）。
 * @param {string} command
 * @returns {string|undefined}
 */
function findOnPath(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status !== 0 || !probe.stdout) return undefined;
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

/**
 * 定位 DSH CLI。
 * @param {string|undefined} explicit
 * @returns {{path:string, source:string}|undefined}
 */
function locateDsh(explicit) {
  if (explicit) return { path: explicit, source: '--dsh' };
  if (process.env.DSH_CLI) return { path: process.env.DSH_CLI, source: 'DSH_CLI' };

  const candidates = [];
  if (process.env.DSH_INSTALL_DIR) {
    candidates.push(join(process.env.DSH_INSTALL_DIR, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  candidates.push(join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  candidates.push(join(programFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'));
  candidates.push('D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd');
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, source: 'known install path' };
  }

  const onPath = findOnPath('dsh');
  if (onPath) return { path: onPath, source: 'PATH' };
  return undefined;
}

/**
 * 把 dsh.cmd 还原成 Electron-as-Node 调用，避免经过 cmd.exe 的引号处理。
 * dsh.cmd 的内容是：ELECTRON_RUN_AS_NODE=1 "<root>\DeepSeek Harness.exe"
 * --expose-internals "<root>\resources\app.asar\dsh\node_modules\@deepseek-ai\
 * dsh-desktop-host\lib\cli.js" %*
 * @param {string} cliPath
 * @returns {{command:string,prefixArgs:string[],env:object,shell:boolean}}
 */
function resolveLaunch(cliPath) {
  const extension = cliPath.toLowerCase().endsWith('.cmd') || cliPath.toLowerCase().endsWith('.bat');
  if (extension && existsSync(cliPath)) {
    const binDir = dirname(cliPath); // <root>/resources/runtime/cli/bin
    const resourcesDir = resolve(binDir, '..', '..', '..'); // <root>/resources
    const installRoot = resolve(resourcesDir, '..'); // <root>
    const executable = join(installRoot, 'DeepSeek Harness.exe');
    // cli.js 位于 app.asar 内部，不是可 existsSync 的普通路径；Electron 参数可以直接加载它。
    const cliScript = join(resourcesDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    if (existsSync(executable)) {
      return {
        command: executable,
        prefixArgs: ['--expose-internals', cliScript],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
      };
    }
  }
  return { command: cliPath, prefixArgs: [], env: {}, shell: extension };
}

/**
 * 去掉常见密钥形态，避免诊断输出泄露凭据。
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/(authorization\s*[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/(bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***');
}

/**
 * 读取并摘要 probe.json。
 * @param {string} file
 * @returns {object|null}
 */
function summarizeProbe(file) {
  if (!existsSync(file)) return null;
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const preStep = report.events?.preStep;
    const sessions = preStep?.sessions ?? {};
    const sessionIds = Object.keys(sessions);
    return {
      node: report.process?.node ?? null,
      electron: report.process?.electron ?? null,
      execPath: report.process?.execPath ?? null,
      sqlite: report.sqlite?.ok === true
        ? `ok (SQLite ${report.sqlite.sqliteVersion ?? 'unknown'})`
        : `unavailable${report.sqlite?.error ? `: ${report.sqlite.error.message}` : ''}`,
      capabilities: Object.fromEntries(
        Object.entries(report.capabilities?.services ?? {}).map(([key, value]) => [key, Boolean(value?.present)]),
      ),
      preStepRegistered: Boolean(preStep?.registered),
      preStepTotal: preStep?.total ?? 0,
      preStepSessions: sessionIds,
      preStepMessages: report.preStep?.messages?.count ?? null,
      preStepRoles: report.preStep?.messages?.roles ?? null,
      measureKeys: report.tokenMeter?.measureResult?.keys ?? null,
      measureNodes: report.tokenMeter?.measureResult?.nodes ?? null,
      compactRegion: report.compaction?.compactRegion ?? null,
      surfaceNodeCount: report.preStep?.session?.surface?.nodeCount ?? null,
      surfaceNodes: report.preStep?.session?.surface?.nodesSample ?? null,
      logLength: report.preStep?.session?.surface?.logLength ?? null,
      occurrences: preStep?.occurrences ?? [],
      turnStopping: report.events?.turnStopping ?? null,
      agentCreated: report.events?.agentCreated?.sessions ?? [],
      agentErrors: report.events?.agentError?.errors ?? [],
    };
  } catch (error) {
    return { parseError: redact(error?.message ?? error) };
  }
}

/**
 * 打印摘要（不含环境变量值）。
 * @param {object} summary
 */
function printSummary(summary) {
  const lines = [
    `node:        ${summary.node}${summary.electron ? ` (electron ${summary.electron})` : ''}`,
    `execPath:    ${summary.execPath}`,
    `node:sqlite: ${summary.sqlite}`,
    `pre-step:    registered=${summary.preStepRegistered} total=${summary.preStepTotal} sessions=${summary.preStepSessions.length}`,
    `  messages:  ${summary.preStepMessages} roles=${JSON.stringify(summary.preStepRoles)}`,
    `  sessions:  ${summary.preStepSessions.join(', ') || '(none)'}`,
    `  surface:   nodes=${summary.surfaceNodeCount} seq=${JSON.stringify(summary.surfaceNodes)} logLength=${summary.logLength}`,
    `  turns:     ${JSON.stringify(summary.occurrences.map((entry) => ({ turn: entry.turn, step: entry.step, messages: entry.messageCount, surfaceNodes: entry.surfaceNodeCount })))}`,
    `tokenMeter:  keys=${JSON.stringify(summary.measureKeys)}`,
    `  nodes:     ${JSON.stringify(summary.measureNodes)}`,
    `  params:    ${JSON.stringify(summary.compactRegion?.parameters ?? null)}`,
    `compactRegion: arity=${summary.compactRegion?.arity ?? 'n/a'}`,
    `turn-stopping: registered=${summary.turnStopping?.registered} fired=${summary.turnStopping?.fired}`,
    `agents:      created=${JSON.stringify(summary.agentCreated)}`,
  ];
  if (summary.agentErrors.length > 0) {
    lines.push(`agent/error: ${JSON.stringify(summary.agentErrors.map((entry) => entry.error))}`);
  }
  const present = Object.entries(summary.capabilities)
    .filter(([, value]) => value)
    .map(([key]) => key);
  lines.push(`capability:  ${present.join(', ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * 启动一次 headless 子进程并收集输出。
 * @returns {Promise<{exitCode:number|null,timedOut:boolean,stdout:string,stderr:string}>}
 */
/**
 * 收集子进程输出直到退出/超时；`finish()` 在结束回调里读取最终输出，
 * 便于 pipe 与文件两种 stdio 形态共用同一套等待逻辑。
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => { stdout: string, stderr: string }} finish
 * @param {number} timeoutMs
 * @returns {Promise<{exitCode:number|null,timedOut:boolean,stdout:string,stderr:string}>}
 */
function collectRun(child, finish, timeoutMs) {
  return new Promise((resolvePromise) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const settle = (code, extra = '') => {
      clearTimeout(timer);
      const output = finish();
      resolvePromise({
        exitCode: code,
        timedOut,
        stdout: output.stdout,
        stderr: output.stderr + extra,
      });
    };
    child.once('error', (error) => settle(null, `\nspawn error: ${error.message}`));
    child.once('close', (code) => settle(code));
  });
}

/** @param {string} value @param {number} limit @returns {string} 保留末尾 limit 字符 */
function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value;
}

function runHeadless(launch, env, args, timeoutMs) {
  const options = { cwd: REPO_ROOT, env, windowsHide: true, shell: launch.shell };
  let child;
  try {
    child = spawn(launch.command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // 部分沙箱（包括本仓库的云端验证环境）禁止带管道的 spawn（EPERM），但允许
    // stdio 指向文件描述符。文件型 stdio 收集完再回放，语义与 pipe 版本一致，
    // 让字面 verify 命令在这些环境里也能真实跑一次 headless。
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-headless-'));
      const outPath = join(dir, 'stdout.log');
      const errPath = join(dir, 'stderr.log');
      const outFd = openSync(outPath, 'w');
      const errFd = openSync(errPath, 'w');
      let fallback;
      try {
        fallback = spawn(launch.command, args, { ...options, stdio: ['ignore', outFd, errFd] });
      } finally {
        closeSync(outFd);
        closeSync(errFd);
      }
      return collectRun(fallback, () => ({
        stdout: tail(readFileSync(outPath, 'utf8'), 20_000),
        stderr: tail(readFileSync(errPath, 'utf8'), 20_000),
      }), timeoutMs).then((result) => {
        rmSync(dir, { recursive: true, force: true });
        return result;
      });
    } catch (fallbackError) {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      return Promise.resolve({
        exitCode: null,
        timedOut: false,
        stdout: '',
        stderr: `spawn error: ${error.message}; file fallback failed: ${fallbackError.message}`,
      });
    }
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = tail(stdout + chunk.toString('utf8'), 20_000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = tail(stderr + chunk.toString('utf8'), 20_000);
  });
  return collectRun(child, () => ({ stdout, stderr }), timeoutMs);
}

/**
 * 从 probe.json 中取会话 id（用于第二轮 --session-id 续跑）。
 * @param {string} file
 * @returns {string|null}
 */
function sessionIdOf(file) {
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    return report?.preStep?.session?.id
      ?? Object.keys(report?.events?.preStep?.sessions ?? {})[0]
      ?? null;
  } catch {
    return null;
  }
}

/**
 * 打印一次失败诊断的尾部。
 */
function printFailureTail(label, run) {
  process.stderr.write(`probe: ${label} produced no probe.json (DSH exit ${run.exitCode}${run.timedOut ? ', timed out' : ''})\n`);
  if (run.stdout.trim()) {
    process.stderr.write(`dsh stdout (tail):\n${redact(run.stdout.trim()).split(/\r?\n/).slice(-15).join('\n')}\n`);
  }
  if (run.stderr.trim()) {
    process.stderr.write(`dsh stderr (tail):\n${redact(run.stderr.trim()).split(/\r?\n/).slice(-15).join('\n')}\n`);
  }
}

/**
 * 生成干净的子进程环境：清掉当前 DSH 会话的 profile/session 变量，避免串到临时 home。
 * @param {object} launch
 * @param {string} home 临时 DSH_HOME
 * @param {object} [extra] 额外环境变量（DSH_PROBE_OUT 等）
 * @returns {object}
 */
function childEnvFor(launch, home, extra = {}) {
  const env = { ...process.env };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    delete env[key];
  }
  return Object.assign(env, { DSH_HOME: home, ...extra }, launch.env);
}

/**
 * 写 --plugin 模式的 overlay patch。
 * `name` 相对 patch 文件目录解析（与 probe.patch.yml 的 ./probe-plugin.js 同一语义）。
 * @returns {string} patch 文件路径
 */
function writePluginPatch() {
  const dbPath = PLUGIN_DB.split('\\').join('/');
  const lines = [
    '# 自动生成：run-headless.mjs --plugin（C-H1 发布门），请勿手改。',
    '- insert:',
    '    - id: dsh-companion-plugin-gate',
    '      name: ../src/index.js',
    '      config:',
    `        dbPath: ${JSON.stringify(dbPath)}`,
    '',
  ];
  writeFileSync(PLUGIN_PATCH, lines.join('\n'), 'utf8');
  return PLUGIN_PATCH;
}

/**
 * round C 专用 overlay：独立库 + 低阈值，保证一段普通对话就会触发巩固。
 * @returns {string} patch 文件路径
 */
function writeConsolidationPatch() {
  const dbPath = PLUGIN_CONSOLIDATION_DB.split('\\').join('/');
  const lines = [
    '# 自动生成：run-headless.mjs --plugin round C（C5-H2 巩固门），请勿手改。',
    '- insert:',
    '    - id: dsh-companion-plugin-gate-c5h2',
    '      name: ../src/index.js',
    '      config:',
    `        dbPath: ${JSON.stringify(dbPath)}`,
    '        retainTokens: 1',
    '        compactAtTokens: 50',
    '        workingMemoryTokens: 100',
    '        compactHardTokens: 200',
    '',
  ];
  writeFileSync(PLUGIN_CONSOLIDATION_PATCH, lines.join('\n'), 'utf8');
  return PLUGIN_CONSOLIDATION_PATCH;
}

/**
 * C-H1 发布门：把真插件挂到 headless 宿主上跑一次，断言它真的激活。
 *
 * 判定只看启动日志（scheduler started 在 apply 内、构建会话之前打印），
 * 因此模型凭据缺失、会话请求失败都不影响本门判定。
 *
 * @param {object} options parseArgs 结果
 * @returns {Promise<number>} 0 通过；1 未通过；2 环境缺失（找不到 DSH / 插件入口）
 */
async function runPluginGate(options) {
  if (!existsSync(PLUGIN_ENTRY)) {
    process.stderr.write(`plugin-gate: missing plugin entry ${PLUGIN_ENTRY}\n`);
    return 2;
  }
  const located = locateDsh(options.dsh);
  if (!located) {
    process.stderr.write(
      'plugin-gate: DSH CLI not found. Pass --dsh <path>, set DSH_CLI, or set DSH_INSTALL_DIR to the DeepSeek Harness install root.\n',
    );
    return 2;
  }

  const launch = resolveLaunch(located.path);
  if (!options.keepHome && existsSync(PLUGIN_HOME)) {
    rmSync(PLUGIN_HOME, { recursive: true, force: true });
  }
  mkdirSync(PLUGIN_HOME, { recursive: true });
  mkdirSync(dirname(PLUGIN_DB), { recursive: true });
  // 每次从空库开始：旧库存在会让人误以为插件已激活（正是 C-H1 的现场）。
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${PLUGIN_DB}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  const patch = writePluginPatch();
  const args = [...launch.prefixArgs, '--profile', 'headless', '--patch', patch, options.task];
  const env = childEnvFor(launch, PLUGIN_HOME);

  process.stdout.write(`plugin-gate: DSH CLI ${located.path} (${located.source})\n`);
  process.stdout.write(`plugin-gate: plugin ${PLUGIN_ENTRY}\n`);
  process.stdout.write(`plugin-gate: overlay ${patch}\n`);
  process.stdout.write(`plugin-gate: temp DSH_HOME ${PLUGIN_HOME}\n`);

  // ---------------- round A：冒烟（插件激活） ----------------
  const firstRun = await runHeadless(launch, env, args, options.timeoutMs);
  const first = summarizePluginRun(firstRun);
  process.stdout.write(
    `plugin-gate: round A (smoke) exit=${firstRun.exitCode}${firstRun.timedOut ? ' (timeout)' : ''} schedulerStarted=${first.started} didNotActivate=${first.inactive}\n`,
  );

  const logLines = [
    `plugin-gate: ${new Date().toISOString()}`,
    `plugin: ${PLUGIN_ENTRY}`,
    `overlay: ${patch}`,
    `dsh: ${located.path}`,
    `args: ${args.map((arg) => JSON.stringify(arg)).join(' ')}`,
    `round A: exit=${firstRun.exitCode}${firstRun.timedOut ? ' (timeout)' : ''} schedulerStarted=${first.started} didNotActivate=${first.inactive}`,
    '--- round A stdout ---',
    redact(firstRun.stdout),
    '--- round A stderr ---',
    redact(firstRun.stderr),
  ];

  if (!first.started || first.inactive) {
    return failPluginGate(
      first.started ? 'round A: plugin logged did not activate' : 'round A: missing scheduler started marker',
      [firstRun],
      logLines,
    );
  }

  // ---------------- round B：预置 1 条 fact + 命中消息（V3-H1 真机形态） ----------------
  const second = await runRecallRound(launch, env, patch, options);
  process.stdout.write(
    `plugin-gate: round B (recall) exit=${second.exitCode}${second.timedOut ? ' (timeout)' : ''} schedulerStarted=${second.started} didNotActivate=${second.inactive} recallCrash=${second.crash} firstReneedAt=${second.firstReneedAt ?? 'null'}${second.error ? ` error=${second.error}` : ''}\n`,
  );
  logLines.push(
    `round B task: ${PLUGIN_RECALL_TASK}`,
    `round B: exit=${second.exitCode}${second.timedOut ? ' (timeout)' : ''} schedulerStarted=${second.started} didNotActivate=${second.inactive} recallCrash=${second.crash} seededFact=${second.seededId ?? 'null'} firstReneedAt=${second.firstReneedAt ?? 'null'}${second.error ? ` error=${second.error}` : ''}`,
    '--- round B stdout ---',
    redact(second.stdout ?? ''),
    '--- round B stderr ---',
    redact(second.stderr ?? ''),
  );
  mkdirSync(dirname(PLUGIN_LOG), { recursive: true });
  writeFileSync(PLUGIN_LOG, logLines.join('\n'));

  if (second.error) {
    process.stderr.write(`plugin-gate: FAIL (round B: ${second.error})\n`);
    return 1;
  }
  if (second.crash) {
    process.stderr.write('plugin-gate: FAIL (round B: platform crashed reading message.source.kind)\n');
    return 1;
  }
  if (!second.started || second.inactive) {
    process.stderr.write('plugin-gate: FAIL (round B: plugin did not activate)\n');
    return 1;
  }
  // 没有模型凭据时 agent loop 到不了 pre-step，first_reneed_at 保持 null：
  // 此时只能证明「没有崩」，如实标注 SKIP 而不是假 PASS。
  if (second.firstReneedAt === null && /MISSING_CREDENTIAL|no API key/u.test(`${second.stdout}\n${second.stderr}`)) {
    process.stdout.write('plugin-gate: round B SKIPPED (no model credentials; agent loop never reached pre-step)\n');
  } else if (second.firstReneedAt === null) {
    process.stderr.write('plugin-gate: FAIL (round B: seeded fact never recalled; first_reneed_at is null)\n');
    return 1;
  }

  // ---------------- round C：灌入超过阈值的文本（C5-H2 巩固真机门） ----------------
  const third = await runConsolidationRound(launch, env, options);
  process.stdout.write(
    `plugin-gate: round C (consolidation) exit=${third.exitCode}${third.timedOut ? ' (timeout)' : ''} schedulerStarted=${third.started} didNotActivate=${third.inactive} consolidations=${third.count}${third.credentialsMissing ? ' credentials=missing' : ''}${third.error ? ` error=${third.error}` : ''}\n`,
  );
  logLines.push(
    `round C task: ${PLUGIN_CONSOLIDATION_TASK}`,
    `round C: exit=${third.exitCode}${third.timedOut ? ' (timeout)' : ''} schedulerStarted=${third.started} didNotActivate=${third.inactive} consolidations=${third.count} credentialsMissing=${third.credentialsMissing}${third.error ? ` error=${third.error}` : ''}`,
    '--- round C stdout ---',
    redact(third.stdout ?? ''),
    '--- round C stderr ---',
    redact(third.stderr ?? ''),
  );
  mkdirSync(dirname(PLUGIN_LOG), { recursive: true });
  writeFileSync(PLUGIN_LOG, logLines.join('\n'));

  if (third.error) {
    process.stderr.write(`plugin-gate: FAIL (round C: ${third.error})\n`);
    return 1;
  }
  if (third.inactive) {
    process.stderr.write('plugin-gate: FAIL (round C: plugin did not activate)\n');
    return 1;
  }
  if (third.count >= 1) {
    process.stdout.write(`plugin-gate: round C PASS (consolidations=${third.count})\n`);
  } else if (third.credentialsMissing) {
    process.stdout.write(
      'plugin-gate: round C SKIPPED (no model credentials; consolidation cannot run without a model)\n',
    );
  } else {
    process.stderr.write(
      'plugin-gate: FAIL (round C: no consolidation row written despite over-threshold input)\n',
    );
    return 1;
  }

  process.stdout.write('plugin-gate: PASS (round A + round B + round C)\n');
  process.stdout.write(`plugin-gate: full log ${PLUGIN_LOG}\n`);
  return 0;
}

/**
 * 判定一次 headless 输出：插件是否激活、是否崩在 platform 消息形状上。
 * @param {{stdout:string, stderr:string}} run
 * @returns {{started:boolean, inactive:boolean, crash:boolean, combined:string}}
 */
function summarizePluginRun(run) {
  const combined = `${run.stdout}\n${run.stderr}`;
  return {
    started: combined.includes(PLUGIN_MARKER),
    inactive: combined.includes(PLUGIN_FAILURE_MARKER),
    crash: PLUGIN_CRASH_RE.test(combined),
    combined,
  };
}

/**
 * round B：预置 1 条 fact → 发命中消息 → 断言召回真的注入过。
 *
 * 证据链：pre-step 的 injectRecall 命中后调用 recordRecalledFacts →
 * Store.markFirstReneed；first_reneed_at 非空即证明召回路径真的走通。
 * 同时断言输出里没有 `reading 'kind'`：v0.4.3 的裸内容块就在这里崩。
 *
 * @param {object} launch
 * @param {NodeJS.ProcessEnv} env
 * @param {string} patch
 * @param {object} options
 * @returns {Promise<object>}
 */
async function runRecallRound(launch, env, patch, options) {
  const result = {
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    started: false,
    inactive: false,
    crash: false,
    seededId: null,
    firstReneedAt: null,
    error: null,
  };
  try {
    const seedStore = Store.open(PLUGIN_DB);
    try {
      const fact = seedStore.insertFact({
        kind: 'project',
        subject_text: '周报',
        predicate: '提交时间',
        object_text: '周五',
        statement: PLUGIN_RECALL_STATEMENT,
        source_kind: 'turn',
      });
      result.seededId = fact?.id ?? null;
    } finally {
      seedStore.close();
    }

    const args = [...launch.prefixArgs, '--profile', 'headless', '--patch', patch, PLUGIN_RECALL_TASK];
    const run = await runHeadless(launch, env, args, options.timeoutMs);
    Object.assign(result, summarizePluginRun(run), {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout,
      stderr: run.stderr,
    });

    const readStore = Store.open(PLUGIN_DB);
    try {
      const row = result.seededId === null ? null : readStore.getFact(result.seededId);
      result.firstReneedAt = Number.isInteger(row?.first_reneed_at) ? row.first_reneed_at : null;
    } finally {
      readStore.close();
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * round C：灌入超过阈值的文本 → 断言 consolidations 至少一行（C5-H2）。
 *
 * 无模型凭据时 agent loop 不产生对话，巩固自然不会运行；此时只标注 SKIP，
 * 不把「环境缺失」误判成「功能失败」。有凭据而 0 行才是真失败。
 *
 * @param {object} launch
 * @param {NodeJS.ProcessEnv} env
 * @param {object} options
 * @returns {Promise<object>}
 */
async function runConsolidationRound(launch, env, options) {
  const result = {
    exitCode: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    started: false,
    inactive: false,
    crash: false,
    count: 0,
    credentialsMissing: false,
    error: null,
  };
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${PLUGIN_CONSOLIDATION_DB}${suffix}`;
      if (existsSync(file)) rmSync(file, { force: true });
    }
    const patch = writeConsolidationPatch();
    const args = [...launch.prefixArgs, '--profile', 'headless', '--patch', patch, PLUGIN_CONSOLIDATION_TASK];
    const run = await runHeadless(launch, env, args, options.timeoutMs);
    Object.assign(result, summarizePluginRun(run), {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stdout: run.stdout,
      stderr: run.stderr,
    });
    result.credentialsMissing = /MISSING_CREDENTIAL|no API key/u.test(`${run.stdout}\n${run.stderr}`);
    if (existsSync(PLUGIN_CONSOLIDATION_DB)) {
      const db = new DatabaseSync(PLUGIN_CONSOLIDATION_DB, { readOnly: true });
      try {
        const row = db.prepare("SELECT COUNT(*) AS n FROM consolidations WHERE status IN ('written', 'compacted')").get();
        result.count = Number(row?.n ?? 0);
      } finally {
        db.close();
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * 发布门失败路径：落盘完整证据并打印每轮输出尾部。
 * @param {string} reason
 * @param {Array<{stdout:string, stderr:string}>} runs
 * @param {string[]} logLines
 * @returns {number} 1
 */
function failPluginGate(reason, runs, logLines) {
  mkdirSync(dirname(PLUGIN_LOG), { recursive: true });
  writeFileSync(PLUGIN_LOG, logLines.concat('').join('\n'));
  process.stderr.write(`plugin-gate: FAIL (${reason})\n`);
  for (const run of runs) {
    for (const [label, text] of [['stdout', run.stdout], ['stderr', run.stderr]]) {
      const tail = redact(text.trim()).split(/\r?\n/).slice(-20).join('\n');
      if (tail) process.stderr.write(`plugin-gate: ${label} (tail):\n${tail}\n`);
    }
  }
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (options.plugin) {
    return await runPluginGate(options);
  }

  if (!existsSync(PATCH_FILE)) {
    process.stderr.write(`probe: missing patch file ${PATCH_FILE}\n`);
    return 2;
  }

  const located = locateDsh(options.dsh);
  if (!located) {
    process.stderr.write(
      'probe: DSH CLI not found. Pass --dsh <path>, set DSH_CLI, or set DSH_INSTALL_DIR to the DeepSeek Harness install root.\n',
    );
    return 2;
  }

  // 只清理仓库 .data 下的临时 DSH_HOME；不碰用户 profile。
  if (!options.keepHome && existsSync(PROBE_HOME)) rmSync(PROBE_HOME, { recursive: true, force: true });
  mkdirSync(PROBE_HOME, { recursive: true });
  mkdirSync(dirname(PROBE_OUT), { recursive: true });
  for (const file of [PROBE_OUT, PROBE_RUN1]) {
    if (existsSync(file)) rmSync(file, { force: true });
  }

  const probeInHome = join(PROBE_HOME, 'probe.json');
  const launch = resolveLaunch(located.path);
  const baseArgs = [...launch.prefixArgs, '--profile', 'headless', '--patch', PATCH_FILE];
  process.stdout.write(`probe: DSH CLI ${located.path} (${located.source})\n`);
  process.stdout.write(`probe: temp DSH_HOME ${PROBE_HOME}\n`);
  process.stdout.write(`probe: overlay ${PATCH_FILE}\n`);

  // 子进程只继承普通环境：清掉当前 DSH 会话的 profile/session 变量，避免串到临时 home。
  const childEnv = childEnvFor(launch, PROBE_HOME, { DSH_PROBE_OUT: probeInHome });

  const first = await runHeadless(launch, childEnv, [...baseArgs, options.task], options.timeoutMs);
  if (!existsSync(probeInHome)) {
    printFailureTail('run 1', first);
    return 1;
  }
  copyFileSync(probeInHome, PROBE_RUN1);
  const run1 = summarizeProbe(PROBE_RUN1);
  if (run1?.parseError) {
    process.stderr.write(`probe: run 1 probe.json is not valid JSON: ${run1.parseError}\n`);
    return 1;
  }
  process.stdout.write(`probe: run 1 wrote ${PROBE_RUN1}\n`);
  printSummary(run1);

  // 默认把第一轮结果作为 probe.json；--two-turn 时用同一 session 续跑，
  // 第二轮的 surface 非空，可直接观察 seq 语义。
  copyFileSync(PROBE_RUN1, PROBE_OUT);
  let finalSummary = run1;
  let finalRun = first;
  if (options.twoTurn) {
    const sessionId = sessionIdOf(PROBE_RUN1);
    if (!sessionId) {
      process.stdout.write('probe: --two-turn skipped: run 1 reported no session id\n');
    } else {
      const second = await runHeadless(
        launch,
        childEnv,
        [...baseArgs, '--session-id', sessionId, options.task2],
        options.timeoutMs,
      );
      finalRun = second;
      if (existsSync(probeInHome)) {
        copyFileSync(probeInHome, PROBE_OUT);
        finalSummary = summarizeProbe(PROBE_OUT);
        process.stdout.write(`probe: run 2 (resumed ${sessionId}) wrote ${PROBE_OUT}\n`);
        if (finalSummary?.parseError) {
          process.stderr.write(`probe: run 2 probe.json is not valid JSON: ${finalSummary.parseError}\n`);
          return 1;
        }
        printSummary(finalSummary);
      } else {
        process.stdout.write('probe: --two-turn run 2 produced no probe.json; keeping run 1 as probe.json\n');
        printFailureTail('run 2', second);
      }
    }
  }

  const captured = (finalSummary?.preStepTotal ?? 0) > 0 || (finalSummary?.agentCreated?.length ?? 0) > 0;
  if (finalRun.exitCode !== 0) {
    process.stdout.write(
      `probe: DSH exited ${finalRun.exitCode}${finalRun.timedOut ? ' (timeout)' : ''}; probe data ${captured ? 'was captured before the failure (expected when no model credentials are available)' : 'has no session/pre-step evidence'}.\n`,
    );
    if (!captured && finalRun.stderr.trim()) {
      process.stderr.write(`dsh stderr (tail):\n${redact(finalRun.stderr.trim()).split(/\r?\n/).slice(-15).join('\n')}\n`);
    }
  }
  return captured ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`probe: ${redact(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
