/**
 * W-1c（v0.7.7 阶段 6）：后台长任务的「拉起/探活/终止」抽象。
 *
 * 生产路径（现网 = Linux/systemd，用户《修订二》W-1c 原文）：
 *   `systemd-run --unit=dsh-bg-<id> --collect -p RuntimeMaxSec=<deadline 秒>
 *    -p MemoryMax=<bg.memoryMax> -p CPUQuota=<bg.cpuQuota> [--uid=<bg.runAs>]
 *    /bin/sh <wrapper.sh>`
 *   计划原文写 `--scope`，但 `--scope` 会跟随调用方的前台会话（插件退出即连带
 *   结束），而同一处要求「进程脱离插件，插件重启或宿主升级不连带杀掉」。这里改用
 *   同样走 cgroup 的**瞬态 service**（`--unit` + `--collect`）满足「脱离 + 资源上限 +
 *   RuntimeMaxSec 主杀」三项要求；差异已列入最终回报。
 *   `bg.runAs` 为空 = 不加身份参数 = 与 50041 同身份（root），非空才传 `--uid`。
 *
 * 开发机替身（Windows，**仅单测**，不是生产路径）：
 *   `spawn(detached).unref()` 拉起一个 `.cmd` 包装器，终止走 `taskkill /T /F`。
 *   本机无法验证 systemd 路径，测试里一律标注「非真机证据」。
 *
 * 包装器（W-1d）负责两件事，保证插件重启后仍能取到结果：
 *   1. 把 stdout/stderr 追加进 `<id>/output.log`；
 *   2. 退出时把退出码写进 `<id>/exit`。
 * 监视器（W-2）只依赖这两个文件 + 进程/unit 状态，不依赖父进程存活。
 *
 * 日志根用模块默认常量（用户原文固定值），不作为配置键；单测注入临时目录。
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  ftruncateSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 用户《修订一》W-1d 原文固定值：日志根。 */
export const DEFAULT_BG_LOG_ROOT = '/opt/dsh-companion/.data/bg-jobs';

/**
 * W77-M1：拉起后观察 systemd-run 客户端多久，判定「这次启动是否被拒」。
 * W78-H1：不带 `--wait` / `--scope` 时它启动 unit 后就**立即以 0 退出**，并不阻塞到
 * unit 结束（阻塞是 `--wait` 的行为），所以早退本身不是失败信号 —— 要看退出码与
 * signal：code 0 且无 signal 即启动成功，非 0 或带 signal（参数非法、unit 名冲突等）
 * 才算失败；窗口内没退出同样视为已拉起。
 */
export const DEFAULT_LAUNCH_GRACE_MS = 150;

/**
 * W78-L1：日志截断的分块大小。`bg.logMaxMB` 允许到 1024MB，一次性分配会直接
 * RangeError（被 catch 吞掉 → 永不截断），所以固定按 1MB 搬运。
 */
const LOG_CAP_CHUNK_BYTES = 1024 * 1024;

/** 包装器文件名（<id>/ 目录内）。 */
const WRAPPER_NAME = 'run.sh';
const WRAPPER_NAME_WIN = 'run.cmd';
export const EXIT_FILE_NAME = 'exit';
export const LOG_FILE_NAME = 'output.log';

/**
 * 任务目录：`<logRoot>/<id>`。
 * @param {string} logRoot
 * @param {string} id
 * @returns {string}
 */
export function jobDir(logRoot, id) {
  if (typeof logRoot !== 'string' || logRoot === '') {
    throw new TypeError('[bg-launcher] jobDir(logRoot, id) requires a non-empty log root');
  }
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('[bg-launcher] jobDir(logRoot, id) requires a non-empty id');
  }
  return join(logRoot, id);
}

/**
 * 平台判定：`linux` 走 systemd；其它（开发机 Windows）走 detached 替身。
 * @param {string} [platform]
 * @returns {'linux'|'portable'}
 */
export function launcherKind(platform = process.platform) {
  return platform === 'linux' ? 'linux' : 'portable';
}

/**
 * **纯函数**：拼 `systemd-run` 参数（单测直接断言，不需真机）。
 *
 * W77-H1：`--working-directory` 必须显式给出。`spawn` 的 `cwd` 只作用于
 * systemd-run **客户端**，瞬态 service 自身的无 cwd 时落在 `/`——脚本里的相对
 * 路径读写就会落到根目录，且 `argv[1]` 若为相对路径会在 `/` 下解析。调用方
 * 传入 realpath 之后的工作目录与绝对脚本路径，二者一致。
 *
 * W77-M2：瞬态 service 只有 systemd 默认环境（PATH 精简、没有 venv/conda/代理
 * 变量），所以默认透传 `PATH` 与 `HOME`（取 50041 进程即调用方的值），
 * 其余变量由 `bg.env` 列表逐项透传（systemd-run `-E NAME` 无值 = 从调用方环境
 * 取值；`--setenv=` 的透传形态见 systemd-run(1)）。
 *
 * @param {{unit: string, deadlineSec: number, memoryMax: string, cpuQuota: string,
 *   runAs?: string, workingDirectory?: string, envNames?: string[], wrapperPath: string}} input
 * @returns {string[]}
 */
export function buildSystemdRunArgs({
  unit,
  deadlineSec,
  memoryMax,
  cpuQuota,
  runAs,
  workingDirectory,
  envNames = [],
  wrapperPath,
}) {
  if (typeof unit !== 'string' || unit === '') {
    throw new TypeError('[bg-launcher] buildSystemdRunArgs() requires a unit name');
  }
  if (!Number.isInteger(deadlineSec) || deadlineSec < 1) {
    throw new TypeError('[bg-launcher] buildSystemdRunArgs() requires a positive deadlineSec');
  }
  if (typeof wrapperPath !== 'string' || wrapperPath === '') {
    throw new TypeError('[bg-launcher] buildSystemdRunArgs() requires a wrapper path');
  }
  if (typeof workingDirectory !== 'string' || workingDirectory === '') {
    throw new TypeError('[bg-launcher] buildSystemdRunArgs() requires a working directory');
  }
  const args = [
    '--unit', unit,
    // --collect：unit 结束后自动 GC，避免 `systemctl list-units` 堆垃圾。
    '--collect',
    '-p', `RuntimeMaxSec=${deadlineSec}`,
    '-p', `MemoryMax=${memoryMax}`,
    '-p', `CPUQuota=${cpuQuota}`,
    // W77-H1：service 自己的工作目录（spawn 的 cwd 只影响 systemd-run 客户端）。
    `--working-directory=${workingDirectory}`,
  ];
  // W77-M2：环境透传。PATH/HOME 是默认项，其余来自 bg.env。
  const seen = new Set();
  for (const name of ['PATH', 'HOME', ...envNames]) {
    const key = typeof name === 'string' ? name.trim() : '';
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    args.push('-E', key);
  }
  // 用户《修订二》W-1c：运行身份取 bg.runAs（默认空 = 与 50041 相同，即 root）。
  if (typeof runAs === 'string' && runAs.trim() !== '') {
    args.push('--uid', runAs.trim());
  }
  args.push('/bin/sh', wrapperPath);
  return args;
}

/**
 * **纯函数**：POSIX 包装器正文（写日志 + 写退出码文件）。
 * @param {{logPath: string, exitPath: string, argv: string[]}} input
 * @returns {string}
 */
export function buildPosixWrapper({ logPath, exitPath, argv }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('[bg-launcher] buildPosixWrapper() requires a non-empty argv');
  }
  // 逐参数单引号包裹（`'` → `'\''`），不经 shell 拼接变量值。
  const quoted = argv.map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`).join(' ');
  return [
    '#!/bin/sh',
    '# dsh-companion bg wrapper（W-1d）：写截断日志 + 退出码文件，插件重启后仍可取证。',
    `exec >> '${logPath.replace(/'/g, `'\\''`)}' 2>&1`,
    `trap 'printf "%s\\n" "$?" > "${exitPath.replace(/"/g, '\\"')}"' EXIT`,
    quoted,
    '',
  ].join('\n');
}

/**
 * **纯函数**：Windows 替身包装器正文（`.cmd`）。
 *
 * 只用于本机单测：cmd 的转义规则与 sh 不同，所以对含 `"`、`%`、`&`、`|` 的
 * 参数直接拒绝（生产走 POSIX 包装器，不受影响）。
 * @param {{logPath: string, exitPath: string, argv: string[]}} input
 * @returns {string}
 */
export function buildWindowsWrapper({ logPath, exitPath, argv }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('[bg-launcher] buildWindowsWrapper() requires a non-empty argv');
  }
  for (const arg of argv) {
    if (/["%&|<>]/.test(String(arg))) {
      throw new TypeError(`[bg-launcher] windows stand-in rejects shell metacharacters: ${String(arg)}`);
    }
  }
  const command = argv.map((arg) => `"${String(arg)}"`).join(' ');
  return [
    '@echo off',
    'rem dsh-companion bg wrapper (Windows stand-in, tests only)',
    `${command} >> "${logPath}" 2>&1`,
    `echo %ERRORLEVEL%> "${exitPath}"`,
    '',
  ].join('\r\n');
}

/**
 * 写包装器到任务目录并返回路径。
 * @param {{dir: string, kind: 'linux'|'portable', logPath: string, exitPath: string, argv: string[]}} input
 * @returns {string}
 */
export function writeWrapper({ dir, kind, logPath, exitPath, argv }) {
  mkdirSync(dir, { recursive: true });
  if (kind === 'linux') {
    const path = join(dir, WRAPPER_NAME);
    writeFileSync(path, buildPosixWrapper({ logPath, exitPath, argv }), { mode: 0o755 });
    return path;
  }
  const path = join(dir, WRAPPER_NAME_WIN);
  writeFileSync(path, buildWindowsWrapper({ logPath, exitPath, argv }));
  return path;
}

/**
 * 读退出码文件；不存在返回 null（还在跑或已 lost）。
 * @param {string} exitPath
 * @returns {number|null}
 */
export function readExitCode(exitPath) {
  try {
    if (!existsSync(exitPath)) return null;
    const raw = readFileSync(exitPath, 'utf8').trim();
    if (raw === '') return null;
    const code = Number.parseInt(raw, 10);
    return Number.isInteger(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * `systemctl is-active <unit>` → boolean；查询失败按「不可判定」返回 null，
 * 让调用方退到「无退出文件 → lost」分支，而不是误判为已退出。
 * @param {string} unit
 * @param {typeof execFileAsync} [run]
 * @returns {Promise<boolean|null>}
 */
export async function systemdUnitActive(unit, run = execFileAsync) {
  try {
    const { stdout } = await run('systemctl', ['is-active', unit]);
    return String(stdout).trim() === 'active';
  } catch (error) {
    const text = String(error?.stdout ?? '').trim();
    if (text === 'inactive' || text === 'failed' || text === 'unknown') return false;
    return null;
  }
}

/**
 * 拉起一个后台任务。
 *
 * W77-H1：`workingDirectory` 交给 systemd-run 的 `--working-directory`，与
 * `spawn` 的 `cwd`（只作用于 `systemd-run` 客户端）分离——瞬态 service 默认在
 * `/` 下运行，不显式给工作目录就会把脚本里的相对路径读写落到根目录。
 *
 * W77-M1：监听 `error` 与早期 `exit`，拉起被拒（binary 不存在 / 参数非法 /
 * unit 冲突）时返回 `failure`，由调用方落库为 `failed` 并经 SA-B3 回执一句；
 * 不再让 `systemd-run` 的 spawn 错误变成宿主进程的未捕获异常。
 *
 * @param {{id: string, argv: string[], cwd: string, deadlineSec: number,
 *   memoryMax: string, cpuQuota: string, runAs?: string, envNames?: string[],
 *   workingDirectory?: string, launchGraceMs?: number,
 *   logRoot?: string, platform?: string, run?: typeof execFileAsync,
 *   spawnImpl?: typeof spawn}} input
 * @returns {Promise<{unit: string|null, pid: number|null, logPath: string, exitPath: string,
 *   wrapperPath: string, kind: 'linux'|'portable',
 *   failure?: {reason: string, message: string, exitCode?: number|null}}>}
 */
export async function startBgProcess({
  id,
  argv,
  cwd,
  deadlineSec,
  memoryMax,
  cpuQuota,
  runAs = '',
  envNames = [],
  workingDirectory,
  launchGraceMs = DEFAULT_LAUNCH_GRACE_MS,
  logRoot = DEFAULT_BG_LOG_ROOT,
  platform = process.platform,
  run = execFileAsync,
  spawnImpl = spawn,
}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('[bg-launcher] startBgProcess() requires a non-empty argv');
  }
  const dir = jobDir(logRoot, id);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, LOG_FILE_NAME);
  const exitPath = join(dir, EXIT_FILE_NAME);
  // 每次拉起都清掉旧退出码，避免上一次的残留被当成这次的结果。
  if (existsSync(exitPath)) rmSync(exitPath, { force: true });
  const kind = launcherKind(platform);
  const wrapperPath = writeWrapper({ dir, kind, logPath, exitPath, argv });
  // W77-H1：service 自己的工作目录（spawn 的 cwd 只影响 systemd-run 客户端）。
  const serviceCwd = typeof workingDirectory === 'string' && workingDirectory !== ''
    ? workingDirectory
    : cwd;

  if (kind === 'linux') {
    const unit = `dsh-bg-${id}`;
    const args = buildSystemdRunArgs({
      unit,
      deadlineSec,
      memoryMax,
      cpuQuota,
      runAs,
      workingDirectory: serviceCwd,
      envNames,
      wrapperPath,
    });
    // W78-H1：systemd-run 不带 --wait/--scope 时**启动 unit 后立即以 0 退出**，
    // 不会阻塞到 unit 结束；这里 spawn 后只观察「是否被拒」，随后就交给探针。
    const child = spawnImpl('systemd-run', args, { cwd, detached: true, stdio: 'ignore' });
    const launch = await watchLaunch(child, launchGraceMs, { exitIsFailure: true });
    if (!launch.ok) {
      return { unit, pid: null, logPath, exitPath, wrapperPath, kind, failure: launch.failure };
    }
    child.unref?.();
    return { unit, pid: null, logPath, exitPath, wrapperPath, kind };
  }

  // Windows 替身：`.cmd` 包装器 + detached。仅本机单测路径。
  const child = spawnImpl(process.env.COMSPEC ?? 'cmd.exe', ['/c', wrapperPath], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // 替身里「脚本跑得快」不是启动失败：早退按正常结束处理，交给监视器读退出码。
  const launch = await watchLaunch(child, launchGraceMs, { exitIsFailure: false });
  if (!launch.ok) {
    return { unit: null, pid: child.pid ?? null, logPath, exitPath, wrapperPath, kind, failure: launch.failure };
  }
  child.unref?.();
  return { unit: null, pid: child.pid ?? null, logPath, exitPath, wrapperPath, kind };
}

/**
 * W77-M1 + W78-H1：观察子进程的启动结果。
 *
 * **systemd-run 的实际行为**（W78-H1 更正）：不带 `--wait` 也不带 `--scope` 时，
 * systemd-run 启动 unit 后**立即以 0 退出**，不会阻塞到 unit 结束（阻塞是 `--wait`
 * 的行为）。所以早退本身不是失败信号，必须看退出码：
 *
 * - `error` 事件（spawn 失败：二进制不存在、权限不足…）→ 失败；
 * - `exitIsFailure` 时（Linux 的 systemd-run）：`code === 0` 且没有 signal → 已拉起；
 *   `code !== 0` 或带 signal → 拉起被拒（参数非法、unit 名冲突…）；
 * - `graceMs` 内没有退出也没有 error → 已拉起，交给探针判断。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} graceMs
 * @param {{exitIsFailure: boolean}} options
 * @returns {Promise<{ok: boolean, failure?: {reason: string, message: string, exitCode?: number|null}}>}
 */
function watchLaunch(child, graceMs, { exitIsFailure }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle({ ok: true }), Math.max(0, Number(graceMs) || 0));
    timer.unref?.();
    child.once('error', (error) => {
      settle({
        ok: false,
        failure: {
          reason: 'spawn-failed',
          message: String(error?.message ?? error),
          exitCode: null,
        },
      });
    });
    child.once('exit', (code, signal) => {
      if (!exitIsFailure) {
        settle({ ok: true });
        return;
      }
      // W78-H1：systemd-run 正常路径就是「启动 unit 后马上以 0 退出」。
      if (code === 0 && !signal) {
        settle({ ok: true });
        return;
      }
      settle({
        ok: false,
        failure: {
          reason: 'launcher-exited',
          message: `systemd-run exited early with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
          exitCode: typeof code === 'number' ? code : null,
        },
      });
    });
    // 迟到（grace 之后）的 error 也吞掉，避免成为宿主进程的未捕获异常。
    child.on('error', () => {});
  });
}

/**
 * W77-L1（方案甲）：把日志文件截到「保留尾部」≤ `maxBytes`。
 *
 * 直接改文件而不是靠包装器里的 `tail`：包装器可能被 `RuntimeMaxSec` 的 SIGKILL
 * 直接杀掉，`trap` 不保证执行；监视器每轮对 running 的任务调用一次，长训练日志
 * 最多超出上限「一个轮询间隔」（30 秒）的量。
 *
 * W78-L1：按 1MB 分块读写，不再一次性 `Buffer.alloc(maxBytes)`。`bg.logMaxMB` 允许
 * 到 1024MB，一次分配在这种量级会直接抛 RangeError 并被 catch 静默吞掉，结果是
 * 大日志永远截不断。分块之后任何合法上限都只占 1MB 内存；仍然是原地重写（保留
 * inode）并保留尾部。
 *
 * @param {string} logPath
 * @param {number} maxBytes
 * @returns {boolean} 是否真的截断过
 */
export function capLogFile(logPath, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return false;
  try {
    const stat = statSync(logPath);
    if (stat.size <= maxBytes) return false;
    const fd = openSync(logPath, 'r+');
    try {
      let readPos = stat.size - maxBytes;
      let writePos = 0;
      const chunkBytes = Math.min(LOG_CAP_CHUNK_BYTES, maxBytes);
      const buffer = Buffer.allocUnsafe(chunkBytes);
      while (readPos < stat.size) {
        const want = Math.min(chunkBytes, stat.size - readPos);
        const read = readSync(fd, buffer, 0, want, readPos);
        if (read <= 0) break;
        let written = 0;
        while (written < read) {
          const wrote = writeSync(fd, buffer, written, read - written, writePos + written);
          if (wrote <= 0) throw new Error('[bg-launcher] capLogFile short write');
          written += wrote;
        }
        readPos += read;
        writePos += read;
      }
      if (writePos !== maxBytes) {
        // 读不满（文件在我们读的期间被追加/截断）时按实际写入量收尾，避免留下尾部残片。
        ftruncateSync(fd, writePos);
        return writePos > 0;
      }
      ftruncateSync(fd, maxBytes);
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    // 截断是防膨胀的尽力而为，失败不影响监视结论。
    return false;
  }
}

/**
 * 探活 + 取退出码。返回 `{running, exited, exitCode}`：
 * - 退出码文件存在 → `exited:true`；
 * - Linux：`systemctl is-active` 判定；Windows：`tasklist` 查 pid；
 * - 两者都不可判定（查询失败）→ `running:true`（宁可多等一轮，不要误判 lost）。
 *
 * @param {{unit: string|null, pid: number|null, exitPath: string, kind: 'linux'|'portable',
 *   platform?: string, run?: typeof execFileAsync}} input
 * @returns {Promise<{running: boolean, exited: boolean, exitCode: number|null}>}
 */
export async function probeBgProcess({ unit, pid, exitPath, kind, platform = process.platform, run = execFileAsync }) {
  const exitCode = readExitCode(exitPath);
  if (exitCode !== null) return { running: false, exited: true, exitCode };
  if (kind === 'linux') {
    const active = await systemdUnitActive(unit ?? '', run);
    if (active === false) {
      // unit 已结束但还没有退出码文件：包装器可能刚被 RuntimeMaxSec 杀掉。
      return { running: false, exited: false, exitCode: null };
    }
    return { running: true, exited: false, exitCode: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) return { running: false, exited: false, exitCode: null };
  try {
    const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH']);
    const alive = String(stdout).includes(String(pid));
    return { running: alive, exited: false, exitCode: null };
  } catch {
    return { running: true, exited: false, exitCode: null };
  }
}

/**
 * 发信号：Linux 走 `systemctl stop`（SIGTERM）/ `systemctl kill -s KILL`；
 * Windows 替身走 `taskkill /T`（不带 /F）与 `taskkill /T /F`。
 *
 * W-2 的「先 TERM 10 秒后 KILL」由监视器定时器串起来，这里只做单次信号。
 * @param {{unit: string|null, pid: number|null, kind: 'linux'|'portable',
 *   signal?: 'TERM'|'KILL', platform?: string, run?: typeof execFileAsync}} input
 * @returns {Promise<boolean>} 是否成功发出信号
 */
export async function signalBgProcess({ unit, pid, kind, signal = 'TERM', run = execFileAsync }) {
  if (kind === 'linux') {
    const name = unit ?? '';
    if (name === '') return false;
    try {
      if (signal === 'KILL') await run('systemctl', ['kill', '-s', 'KILL', name]);
      else await run('systemctl', ['stop', name]);
      return true;
    } catch {
      return false;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    await run('taskkill', signal === 'KILL' ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读日志末尾 ≤2KB（W-3 唤醒消息只带尾部，避免把整份训练日志塞进消息）。
 * @param {string} logPath
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function tailLog(logPath, maxBytes = 2048) {
  try {
    if (!existsSync(logPath)) return '';
    const text = readFileSync(logPath, 'utf8');
    const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 2048;
    if (text.length <= budget) return text;
    return text.slice(text.length - budget);
  } catch {
    return '';
  }
}
