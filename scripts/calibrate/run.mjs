#!/usr/bin/env node
/**
 * 安装自检 runner：用临时 DSH_HOME + headless profile 跑一次真实 DSH 会话，
 * 让 `calibrate-plugin.js` 测量并写出：
 *   - .data/calibration.json
 *   - .data/config.suggested.yml
 *
 * 不读、不写用户 `~/.dsh`；不安装依赖；不修改 profile。即使模型凭据缺失，
 * 只要插件在 pre-step 前已启动，机器/版本建议仍然会落盘。
 *
 * 用法：
 *   node scripts/calibrate/run.mjs [--help]
 *   node scripts/calibrate/run.mjs [--dsh <path>] [--task "..."] [--timeout <ms>]
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const PATCH_FILE = join(SCRIPT_DIR, 'calibrate.patch.yml');
const DATA_DIR = join(REPO_ROOT, '.data');
const CALIBRATION_OUT = join(DATA_DIR, 'calibration.json');
const SUGGESTED_OUT = join(DATA_DIR, 'config.suggested.yml');
const CALIBRATE_HOME = join(DATA_DIR, 'calibrate-home');

const HELP = `dsh-companion 安装自检

用法:
  node scripts/calibrate/run.mjs [options]

选项:
  --dsh <path>       DSH CLI 路径（默认依次尝试 DSH_CLI、DSH_INSTALL_DIR、常见安装目录、PATH）
  --task <text>      发给 headless 的任务（默认: "Reply with exactly: ok"）
  --timeout <ms>     子进程超时，默认 120000
  --keep-home        保留临时 DSH_HOME（.data/calibrate-home）便于排查
  --help, -h         显示帮助

环境变量:
  DSH_CLI            DSH CLI 路径（同 --dsh）
  DSH_INSTALL_DIR    DeepSeek Harness 安装根目录

输出:
  .data/calibration.json       测量明细、suggested、provenance
  .data/config.suggested.yml   人工核对后复制到 config.yml 的建议配置
`;

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const options = {
    dsh: undefined,
    task: 'Reply with exactly: ok',
    timeoutMs: Number(process.env.DSH_CALIBRATE_TIMEOUT ?? 120_000),
    keepHome: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--dsh') options.dsh = argv[++index];
    else if (arg === '--task') options.task = argv[++index] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--keep-home') options.keepHome = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer (ms)');
  }
  return options;
}

/**
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
 * @param {string|undefined} explicit
 * @returns {{path:string,source:string}|undefined}
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
 * 把 dsh.cmd 还原为 Electron-as-Node 调用（与 probe runner 同策略）。
 * @param {string} cliPath
 * @returns {{command:string,prefixArgs:string[],env:object,shell:boolean}}
 */
function resolveLaunch(cliPath) {
  const extension = cliPath.toLowerCase().endsWith('.cmd') || cliPath.toLowerCase().endsWith('.bat');
  if (extension && existsSync(cliPath)) {
    const binDir = dirname(cliPath);
    const resourcesDir = resolve(binDir, '..', '..', '..');
    const installRoot = resolve(resourcesDir, '..');
    const executable = join(installRoot, 'DeepSeek Harness.exe');
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
 * 脱敏诊断输出。
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
 * @param {object} launch
 * @param {object} env
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{exitCode:number|null,timedOut:boolean,stdout:string,stderr:string}>}
 */
function runHeadless(launch, env, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(launch.command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: launch.shell,
    });
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
 * @returns {object|null}
 */
function readCalibration() {
  if (!existsSync(CALIBRATION_OUT)) return null;
  try {
    return JSON.parse(readFileSync(CALIBRATION_OUT, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} report
 */
function printSummary(report) {
  const measurement = report.measurement ?? {};
  const memory = measurement.memory ?? {};
  const suggested = report.suggested ?? {};
  const lines = [
    `calibration: ${CALIBRATION_OUT}`,
    `suggested:   ${SUGGESTED_OUT}`,
    `node:        ${measurement.process?.node ?? 'unknown'}`,
    `electron:    ${measurement.process?.electron ?? 'n/a'}`,
    `dsh:         ${measurement.process?.dsh ?? 'unknown'}`,
    `sqlite:      ${measurement.sqlite?.ok ? `ok (${measurement.sqlite.version ?? 'unknown'})` : 'unavailable'}`,
    `memory:      total=${memory.totalmemBytes ?? 0} bytes rss_median=${memory.rssMedianBytes ?? 'n/a'} bytes`,
    `cpus:        ${measurement.cpu?.count ?? 0}`,
    `context:     ${measurement.contextWindow?.tokens ?? 'unknown'} tokens (${measurement.contextWindow?.source ?? 'unknown'})`,
    `tokenMeter:  ${measurement.tokenMeter?.ok ? `nodes=${measurement.tokenMeter.nodes}` : 'n/a'}`,
    `suggested:   working=${suggested.workingMemoryTokens} compactAt=${suggested.compactAtTokens} hard=${suggested.compactHardTokens} memoryBudget=${suggested.memoryBudget}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * @param {object} run
 */
function printFailure(run) {
  process.stderr.write(`calibrate: 未生成 calibration.json（DSH exit ${run.exitCode}${run.timedOut ? ', timed out' : ''}）\n`);
  if (run.stdout.trim()) {
    process.stderr.write(`dsh stdout (tail):\n${redact(run.stdout.trim()).split(/\r?\n/).slice(-15).join('\n')}\n`);
  }
  if (run.stderr.trim()) {
    process.stderr.write(`dsh stderr (tail):\n${redact(run.stderr.trim()).split(/\r?\n/).slice(-15).join('\n')}\n`);
  }
  process.stderr.write(
    '\n手工运行方式：\n'
    + `  dsh --profile headless --patch "${PATCH_FILE}" "Reply with exactly: ok"\n`
    + '或把 scripts/calibrate/calibrate-plugin.js 加进你的 profile，启动后查看 .data/calibration.json。\n',
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!existsSync(PATCH_FILE)) {
    process.stderr.write(`calibrate: missing patch file ${PATCH_FILE}\n`);
    return 2;
  }
  const located = locateDsh(options.dsh);
  if (!located) {
    process.stderr.write(
      'calibrate: DSH CLI 未找到。用 --dsh <path>，或设置 DSH_CLI / DSH_INSTALL_DIR。\n',
    );
    return 2;
  }

  if (!options.keepHome && existsSync(CALIBRATE_HOME)) {
    rmSync(CALIBRATE_HOME, { recursive: true, force: true });
  }
  mkdirSync(CALIBRATE_HOME, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  for (const file of [CALIBRATION_OUT, SUGGESTED_OUT]) {
    if (existsSync(file)) rmSync(file, { force: true });
  }

  const launch = resolveLaunch(located.path);
  const baseArgs = [...launch.prefixArgs, '--profile', 'headless', '--patch', PATCH_FILE];
  process.stdout.write(`calibrate: DSH CLI ${located.path} (${located.source})\n`);
  process.stdout.write(`calibrate: temp DSH_HOME ${CALIBRATE_HOME}\n`);
  process.stdout.write(`calibrate: overlay ${PATCH_FILE}\n`);

  const childEnv = { ...process.env };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    DSH_HOME: CALIBRATE_HOME,
    DSH_CALIBRATE_OUT: DATA_DIR,
    ...launch.env,
  });

  const run = await runHeadless(launch, childEnv, [...baseArgs, options.task], options.timeoutMs);
  const report = readCalibration();
  if (!options.keepHome && existsSync(CALIBRATE_HOME)) {
    try {
      rmSync(CALIBRATE_HOME, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响结果。
    }
  }
  if (!report || !existsSync(SUGGESTED_OUT)) {
    printFailure(run);
    return 2;
  }

  process.stdout.write(`calibrate: DSH exit ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}\n`);
  printSummary(report);
  if (run.exitCode !== 0) {
    process.stdout.write(
      'calibrate: DSH 会话未正常结束，但自检数据已写出；请核对上面的测量值与 .data/config.suggested.yml。\n',
    );
  }
  process.stdout.write('calibrate: 未自动合并配置；请人工核对后复制到 config.yml。\n');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`calibrate: ${redact(error?.stack ?? error)}\n`);
    process.exitCode = 2;
  });
