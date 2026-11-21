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
 * Windows detached 替身的启动观察窗：进程就是服务本身，不能等它退出。
 *
 * D21-H3（v0.7.10）：Linux 侧不再用它，改为等 `systemd-run` 客户端真正退出
 * （DEFAULT_LAUNCH_WAIT_MS）——客户端退出时机取决于 start job 与授权流程，
 * 判定以退出码与 signal 为准。
 */
export const DEFAULT_LAUNCH_GRACE_MS = 150;

/**
 * D21-H3（v0.7.10）：Linux 侧等 `systemd-run` 客户端退出的上限。
 * 客户端退出 = 结论确定：code 0 且无 signal 才算拉起成功；超时则杀掉客户端并记
 * `launch-timeout`，绝不把它当成「已拉起」。
 */
export const DEFAULT_LAUNCH_WAIT_MS = 10_000;

/** D21-H3：systemd-run 客户端的 stderr 落盘文件名（<job 目录>/launch.log）。 */
export const LAUNCH_LOG_NAME = 'launch.log';

/** D21-H3 + D21-L1：拉起失败的回执附 launch.log 末尾多少行、最多多少字符。 */
export const LAUNCH_LOG_TAIL_LINES = 20;
const LAUNCH_TAIL_MAX_CHARS = 1200;

/** 自检命令（`systemd-run --wait /bin/true`）的超时：留足 user 模式的 DBus 往返。 */
const SELF_CHECK_TIMEOUT_MS = 20_000;

/**
 * 进程 uid（非 POSIX 平台返回 0，等价于「系统实例」路径）。
 * @returns {number}
 */
export function currentUid() {
  return typeof process.getuid === 'function' ? Number(process.getuid()) : 0;
}

/**
 * **纯函数**：D21-H4——uid 为 0 走系统实例，否则走**该 uid 的用户级 systemd**。
 *
 * 50041 以 ubuntu(uid 1000) 运行（腾讯云默认用户，用户已定保持），ubuntu 无权
 * 向系统实例提交 unit，`systemd-run` 会卡在 polkit 交互上并失败。
 * @param {number} uid
 * @returns {'system'|'user'}
 */
export function resolveSystemdMode(uid) {
  return Number(uid) === 0 ? 'system' : 'user';
}

/**
 * **纯函数**：user 模式下 systemd-run / systemctl 需要的环境。
 *
 * `systemd-run --user` 要连 `$XDG_RUNTIME_DIR` 下的共享总线；插件进程由宿主/服务
 * 拉起时往往没有这两个变量（尤其 ssh 或 systemd 单元里），所以要显式补齐；进程
 * 环境已有则沿用。
 * @param {number} uid
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function userModeEnv(uid, base = process.env) {
  const env = { ...(base ?? {}) };
  const runtimeDir = `/run/user/${Number(uid)}`;
  if (typeof env.XDG_RUNTIME_DIR !== 'string' || env.XDG_RUNTIME_DIR === '') {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }
  if (typeof env.DBUS_SESSION_BUS_ADDRESS !== 'string' || env.DBUS_SESSION_BUS_ADDRESS === '') {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

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
 *   runAs?: string, workingDirectory?: string, envNames?: string[], wrapperPath: string,
 *   user?: boolean}} input
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
  user = false,
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
    // D21-H4：非 root 走用户级 systemd（ubuntu 无权提交系统 unit）。
    ...(user ? ['--user'] : []),
    // D21-H3：不触发 polkit 交互提示，避免 systemd-run 客户端卡在授权交互上。
    '--no-ask-password',
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
  // 用户《修订二》W-1c：运行身份取 bg.runAs，默认空 = 与 50041 相同（ubuntu
  // uid 1000，用户已定保持这套身份运行）。
  //
  // D21-H4：user 模式（uid≠0）下 `--uid` 无意义——用户级管理器只能以该用户身份
  // 跑，切身份必须走系统实例（那正是 ubuntu 做不到的事）。所以非空即配置冲突，
  // 由 config 层先报错，这里再兜一层 TypeError。
  const runAsText = typeof runAs === 'string' ? runAs.trim() : '';
  if (runAsText !== '') {
    if (user) {
      throw new TypeError('[bg-launcher] bg.runAs 只能配合系统实例：user 模式（uid≠0）不能切换运行身份');
    }
    args.push('--uid', runAsText);
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
 *
 * D21-H4：user 模式要带 `--user` 与同一套 DBus 环境，否则查的是系统实例里
 * 同名的（不存在的）unit。
 * @param {string} unit
 * @param {typeof execFileAsync} [run]
 * @param {{user?: boolean, uid?: number}} [options]
 * @returns {Promise<boolean|null>}
 */
export async function systemdUnitActive(unit, run = execFileAsync, options = {}) {
  const user = options?.user === true;
  const args = [...(user ? ['--user'] : []), 'is-active', unit];
  const env = user ? userModeEnv(options?.uid ?? currentUid()) : undefined;
  try {
    const { stdout } = await run('systemctl', args, ...(env === undefined ? [] : [{ env }]));
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
 *   workingDirectory?: string, launchGraceMs?: number, launchWaitMs?: number,
 *   uid?: number, mode?: 'user'|'system',
 *   logRoot?: string, platform?: string, run?: typeof execFileAsync,
 *   spawnImpl?: typeof spawn}} input
 * @returns {Promise<{unit: string|null, pid: number|null, logPath: string, exitPath: string,
 *   wrapperPath: string, kind: 'linux'|'portable', launchLogPath?: string,
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
  launchWaitMs = DEFAULT_LAUNCH_WAIT_MS,
  uid,
  mode,
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
    // D21-H4：uid≠0（50041 的 ubuntu）走用户级 systemd，并补齐 DBus 环境。
    const effectiveUid = Number.isInteger(uid) ? Number(uid) : currentUid();
    const resolvedMode = mode === 'user' || mode === 'system' ? mode : resolveSystemdMode(effectiveUid);
    const user = resolvedMode === 'user';
    let args;
    try {
      args = buildSystemdRunArgs({
        unit,
        deadlineSec,
        memoryMax,
        cpuQuota,
        runAs,
        workingDirectory: serviceCwd,
        envNames,
        wrapperPath,
        user,
      });
    } catch (error) {
      // config.normalizeBg 已经 fail-fast；这里兜住绕过配置层的调用方。
      return {
        unit,
        pid: null,
        logPath,
        exitPath,
        wrapperPath,
        kind,
        failure: {
          reason: 'runas-unsupported',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    // D21-H3：systemd-run 客户端必须**退出**才能判定成败（不带 --wait 时它启动
    // unit 后退出；带 --user 时它还要先走 DBus/polkit）。stderr 落盘 launch.log，
    // 失败回执附尾部，别再把「被拒」当成功。
    const launchLogPath = join(dir, LAUNCH_LOG_NAME);
    let stderrText = '';
    const child = spawnImpl('systemd-run', args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      ...(user ? { env: userModeEnv(effectiveUid) } : {}),
    });
    if (child?.stderr !== null && child?.stderr !== undefined
      && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        // 只留前 8KB：失败原因（polkit / DBus）总在最前几行。
        if (stderrText.length < 8192) stderrText += String(chunk);
      });
    }
    const launch = await waitForLaunchClient(child, launchWaitMs);
    writeLaunchLog(launchLogPath, stderrText);
    if (!launch.ok) {
      return {
        unit,
        pid: null,
        logPath,
        exitPath,
        wrapperPath,
        kind,
        launchLogPath,
        failure: {
          ...launch.failure,
          launchLogTail: formatLaunchLogTail(launchLogPath).split('\n').filter((line) => line !== ''),
          message: withLaunchLogTail(launch.failure.message, launchLogPath),
        },
      };
    }
    child.unref?.();
    return { unit, pid: null, logPath, exitPath, wrapperPath, kind, launchLogPath };
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
 * W77-M1 + W78-H1：观察便携（Windows）启动器的启动结果。
 *
 * v0.7.10 D21-H3：Linux 侧已改为 waitForLaunchClient —— systemd-run 客户端退出
 * 的时机取决于 start job 与 polkit 授权（可能晚于 150ms），因此必须等客户端退出
 * 再看退出码，不能在宽限期内提前判成功。本函数只留给 portable 路径：
 *
 * - error 事件（spawn 失败：二进制不存在、权限不足…）→ 失败；
 * - exitIsFailure 时：code === 0 且没有 signal → 已拉起；
 *   code !== 0 或带 signal → 拉起被拒（参数非法、unit 名冲突…）；
 * - graceMs 内没有退出也没有 error → 已拉起，交给探针判断。
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
 * D21-H3（v0.7.10）：等 `systemd-run` 客户端**退出**，据此判定这次拉起是否成立。
 *
 * 用户级 systemd（`systemd-run --user`）的客户端退出时机取决于 start job 与
 * polkit/DBus 授权流程，可能远晚于启动瞬间；因此判定只看客户端退出结果，
 * 不看启动后经过了多久（授权失败时客户端以非 0 退出并带 stderr 原文）。
 *
 * 结论口径：
 * - `code === 0` 且 `signal === null` → ok（unit 已提交）；
 * - 非 0 / 带 signal → `launcher-exited`（附退出码）；
 * - `waitMs` 内不退出 → SIGKILL 客户端 + `launch-timeout`；
 * - spawn 失败 → `spawn-failed`。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [waitMs]
 * @returns {Promise<{ok: boolean, failure?: {reason: string, message: string, exitCode?: number|null}}>}
 */
function waitForLaunchClient(child, waitMs = DEFAULT_LAUNCH_WAIT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const budget = Number.isFinite(Number(waitMs)) && Number(waitMs) > 0
      ? Number(waitMs)
      : DEFAULT_LAUNCH_WAIT_MS;
    const timer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // 客户端已退出：忽略。
      }
      settle({
        ok: false,
        failure: {
          reason: 'launch-timeout',
          message: `systemd-run 客户端 ${budget}ms 内没有退出（可能卡在 polkit 交互）`,
          exitCode: null,
        },
      });
    }, budget);
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
      if (code === 0 && !signal) {
        settle({ ok: true });
        return;
      }
      settle({
        ok: false,
        failure: {
          reason: 'launcher-exited',
          message: `systemd-run exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
          exitCode: typeof code === 'number' ? code : null,
        },
      });
    });
    // 迟到（settle 之后）的 error 也吞掉，避免成为宿主进程的未捕获异常。
    child.on('error', () => {});
  });
}

/**
 * D21-H3：把 systemd-run 客户端 stderr 落盘（失败取证；成功时一般是空文件）。
 * @param {string} launchLogPath
 * @param {string} text
 * @returns {boolean}
 */
function writeLaunchLog(launchLogPath, text) {
  try {
    writeFileSync(launchLogPath, String(text ?? ''));
    return true;
  } catch {
    return false;
  }
}

/**
 * D21-H3 + D21-L1：读 launch.log 末尾 N 行（失败回执用），总长上限 ~1200 字。
 * @param {string} launchLogPath
 * @param {number} [lines]
 * @returns {string}
 */
export function formatLaunchLogTail(launchLogPath, lines = LAUNCH_LOG_TAIL_LINES) {
  try {
    if (!existsSync(launchLogPath)) return '';
    const text = readFileSync(launchLogPath, 'utf8').trimEnd();
    if (text === '') return '';
    const all = text.split(/\r?\n/u);
    const keep = Number.isInteger(lines) && lines > 0 ? lines : LAUNCH_LOG_TAIL_LINES;
    const tail = all.slice(-keep).join('\n');
    return tail.length > LAUNCH_TAIL_MAX_CHARS
      ? tail.slice(tail.length - LAUNCH_TAIL_MAX_CHARS)
      : tail;
  } catch {
    return '';
  }
}

/**
 * 把 launch.log 尾部拼进失败文案（没有日志时原样返回）。
 * @param {string} message
 * @param {string} launchLogPath
 * @returns {string}
 */
function withLaunchLogTail(message, launchLogPath) {
  const tail = formatLaunchLogTail(launchLogPath);
  if (tail === '') return message;
  return `${message}\nsystemd-run stderr（末尾 ${LAUNCH_LOG_TAIL_LINES} 行）：\n${tail}`;
}

/**
 * D21-H4（v0.7.10）：后台任务启动自检。
 *
 * 用与真实拉起**同一模式**跑一次 `systemd-run --no-ask-password --wait --collect
 * -p RuntimeMaxSec=… -p MemoryMax=… -p CPUQuota=… /bin/true`：失败（无 DBus /
 * polkit 拒 / 用户级 systemd 不可用 / 属性不被接受）就把 bg_run 整体
 * 标为不可用，而不是等用户派活后才发现。成功再读 `user@<uid>.service` 的
 * cgroup.controllers，缺 memory/cpu 时只标注（MemoryMax/CPUQuota 不生效），不阻止
 * 使用——云主机默认 cgroup 配置不该让功能整体不可用。
 *
 * **注意**：本机（Windows）只能跑 portable 分支，Linux 路径的真实结论属云端真机
 * 验收范围。
 *
 * @param {{platform?: string, uid?: number, mode?: 'user'|'system',
 *   run?: typeof execFileAsync}} [input]
 * @returns {Promise<{ok: boolean, mode: string, reason: string|null, message: string|null,
 *   missingControllers: string[]}>}
 */
export async function bgSelfCheck({
  platform = process.platform,
  uid,
  mode,
  run = execFileAsync,
  // 自检必须带与真实任务**同一组** cgroup 属性：不带属性时 systemd 不会把
  // memory/cpu 控制器委托给该 unit，探不出 MemoryMax/CPUQuota 是否真的生效。
  memoryMax = '4G',
  cpuQuota = '200%',
  runtimeMaxSec = 60,
} = {}) {
  const kind = launcherKind(platform);
  if (kind !== 'linux') {
    return { ok: true, mode: 'portable', reason: null, message: null, missingControllers: [] };
  }
  const effectiveUid = Number.isInteger(uid) ? Number(uid) : currentUid();
  const resolvedMode = mode === 'user' || mode === 'system' ? mode : resolveSystemdMode(effectiveUid);
  const user = resolvedMode === 'user';
  const env = user ? userModeEnv(effectiveUid) : undefined;
  const args = [
    ...(user ? ['--user'] : []),
    '--no-ask-password',
    '--wait',
    '--collect',
    '-p', `RuntimeMaxSec=${runtimeMaxSec}`,
    '-p', `MemoryMax=${memoryMax}`,
    '-p', `CPUQuota=${cpuQuota}`,
    '/bin/true',
  ];
  try {
    await run('systemd-run', args, { timeout: SELF_CHECK_TIMEOUT_MS, ...(env === undefined ? {} : { env }) });
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim();
    const message = stderr !== '' ? stderr : String(error?.message ?? error);
    return {
      ok: false,
      mode: resolvedMode,
      reason: 'self-check-failed',
      message: `systemd 自检失败（${resolvedMode} 模式）：${message}`,
      missingControllers: [],
    };
  }
  const missingControllers = await readMissingControllers({ uid: effectiveUid, mode: resolvedMode, run, env });
  return { ok: true, mode: resolvedMode, reason: null, message: null, missingControllers };
}

/**
 * D21-H4：读 `user@<uid>.service` 的 cgroup.controllers，返回缺失的控制器
 * （`'memory'` / `'cpu'`）。读不到就返回空数组，不误报。
 * @param {{uid: number, mode: string, run: typeof execFileAsync, env?: object}} input
 * @returns {Promise<string[]>}
 */
async function readMissingControllers({ uid, mode, run, env }) {
  if (mode !== 'user') return [];
  try {
    const { stdout } = await run(
      'systemctl',
      ['show', `user@${uid}.service`, '-p', 'ControlGroup', '--value'],
      { ...(env === undefined ? {} : { env }), timeout: SELF_CHECK_TIMEOUT_MS },
    );
    const cgroup = String(stdout).trim();
    if (cgroup === '') return [];
    const path = cgroup.startsWith('/') ? cgroup : `/${cgroup}`;
    const text = readFileSync(`/sys/fs/cgroup${path}/cgroup.controllers`, 'utf8');
    const have = new Set(text.split(/\s+/u).filter((item) => item !== ''));
    return ['memory', 'cpu'].filter((name) => !have.has(name));
  } catch {
    return [];
  }
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
 *   platform?: string, run?: typeof execFileAsync, user?: boolean, uid?: number}} input
 * @returns {Promise<{running: boolean, exited: boolean, exitCode: number|null}>}
 */
export async function probeBgProcess({
  unit,
  pid,
  exitPath,
  kind,
  platform = process.platform,
  run = execFileAsync,
  user = false,
  uid,
}) {
  const exitCode = readExitCode(exitPath);
  if (exitCode !== null) return { running: false, exited: true, exitCode };
  if (kind === 'linux') {
    const active = await systemdUnitActive(unit ?? '', run, { user, uid });
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
 *   signal?: 'TERM'|'KILL', platform?: string, run?: typeof execFileAsync,
 *   user?: boolean, uid?: number}} input
 * @returns {Promise<boolean>} 是否成功发出信号
 */
export async function signalBgProcess({
  unit,
  pid,
  kind,
  signal = 'TERM',
  run = execFileAsync,
  user = false,
  uid,
}) {
  if (kind === 'linux') {
    const name = unit ?? '';
    if (name === '') return false;
    // D21-H4：user 模式的 unit 只存在于该用户的用户级管理器里。
    const prefix = user ? ['--user'] : [];
    const env = user ? { env: userModeEnv(uid ?? currentUid()) } : undefined;
    try {
      if (signal === 'KILL') await run('systemctl', [...prefix, 'kill', '-s', 'KILL', name], ...(env === undefined ? [] : [env]));
      else await run('systemctl', [...prefix, 'stop', name], ...(env === undefined ? [] : [env]));
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
