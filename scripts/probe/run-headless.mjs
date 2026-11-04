#!/usr/bin/env node
/**
 * Gate 0 headless 采集器：用临时 DSH_HOME + 独立 profile 跑一次 headless 会话，
 * 把探针写出的 probe.json 拷回仓库 `.data/probe.json`。
 *
 * `--plugin` 是发布门（C-H1）：不再挂 Gate 0 探针，而是用 `--patch` 把本仓库的
 * 真插件 `src/index.js` 插进 headless profile，跑一次并断言
 *   `[dsh-companion] scheduler started`
 * 出现、且输出里没有 `did not activate`。没有 DSH 的机器上该模式退出码 2，
 * 可在 CI 里用 `--plugin` 的退出码区分「跳过」（2）与「失败」（1）。
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
                     headless，跑一次并断言出现 "[dsh-companion] scheduler started"、
                     且没有 "did not activate"。退出码 0=通过，1=未通过，2=找不到 DSH
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
function runHeadless(launch, env, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(launch.command, args, {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: launch.shell,
      });
    } catch (error) {
      // 某些沙箱里 spawn 直接抛（EPERM），按一次失败运行上报，交调用方判定。
      resolvePromise({ exitCode: null, timedOut: false, stdout: '', stderr: `spawn error: ${error.message}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-20_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-20_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, timedOut, stdout, stderr: `${stderr}\nspawn error: ${error.message}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, timedOut, stdout, stderr });
    });
  });
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

  const run = await runHeadless(launch, env, args, options.timeoutMs);
  const combined = `${run.stdout}\n${run.stderr}`;
  const started = combined.includes(PLUGIN_MARKER);
  const inactive = combined.includes(PLUGIN_FAILURE_MARKER);
  process.stdout.write(
    `plugin-gate: exit=${run.exitCode}${run.timedOut ? ' (timeout)' : ''} schedulerStarted=${started} didNotActivate=${inactive}\n`,
  );

  if (started && !inactive) {
    process.stdout.write(`plugin-gate: PASS (${PLUGIN_MARKER})\n`);
    return 0;
  }

  process.stderr.write(
    `plugin-gate: FAIL (${started ? 'plugin logged did not activate' : 'missing scheduler started marker'})\n`,
  );
  for (const [label, text] of [['stdout', run.stdout], ['stderr', run.stderr]]) {
    const tail = redact(text.trim()).split(/\r?\n/).slice(-20).join('\n');
    if (tail) process.stderr.write(`plugin-gate: ${label} (tail):\n${tail}\n`);
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
