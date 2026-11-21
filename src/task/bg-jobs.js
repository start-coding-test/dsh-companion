/**
 * W-1/W-2/W-3/W-4/W-5（v0.7.7 阶段 6）：后台长任务的校验、落库、监视与唤醒。
 *
 * 用户口径（《修订一》W-1..W-5 原文）：
 * - 不审脚本内容（脚本由用户自建，如训练脚本），只限制**工作目录、解释器、时长与资源**；
 * - workRoot 未配置 → 工具直接返回不可用；
 * - 拉起后立即返回 id，发起子代理可以正常结束本轮；
 * - 退出/超时后**原子迁移只唤醒一次**，把退出码、末尾 ≤2KB 输出与日志路径交给
 *   原子代理（冷恢复），子代理再按 SA-B3 回执主会话；原子代理不存在 → 直接投主会话。
 *
 * 本模块只管状态机与文案，进程操作全部走 `bg-launcher.js`（Linux systemd /
 * Windows 替身），因此单测可以在无 systemd 的机器上覆盖全部分支。
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { isAbsolute, basename, relative, resolve } from 'node:path';
import {
  DEFAULT_BG_LOG_ROOT,
  capLogFile,
  currentUid,
  jobDir,
  probeBgProcess,
  readExitCode,
  resolveSystemdMode,
  signalBgProcess,
  startBgProcess,
  tailLog,
} from './bg-launcher.js';

/** W-3：唤醒预算按发起子代理聚合，存这份 meta 的前缀（值为次数）。 */
const WAKE_META_PREFIX = 'bg_wake:';

/** W-2：TERM 之后等这么久还活着就 KILL。 */
export const BG_TERM_GRACE_MS = 10_000;

/** W-3：唤醒消息里附带的日志尾部字节数上限。 */
export const BG_TAIL_BYTES = 2048;

/** 状态取值是自由 TEXT（表上无 CHECK 枚举），这里是插件侧的语义清单。 */
export const BG_JOB_STATES = Object.freeze({
  running: 'running',
  woken: 'woken',
  wokenFallback: 'woken-fallback',
  // W77-M1：拉起就被 systemd-run 拒绝（或 spawn 失败），从未真正跑起来。
  failed: 'failed',
  timeout: 'timeout',
  lost: 'lost',
});

/**
 * 判断 `child` 是否在 `root` 之内（realpath 之后比较，`..` 与符号链接都已被
 * realpath 归一，不会「看起来在里面」）。
 * @param {string} root
 * @param {string} child
 * @returns {boolean}
 */
export function isInsideRoot(root, child) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * W-1a/b + W-5：校验一次 bg_run 请求。
 *
 * 只做「能不能启动」的判定并返回执行计划；不创业目录、不落库（由 startBgJob 做）。
 * 校验顺序按用户原文：workRoot 未配置 → 并发满额 → cwd/符号链接 → 解释器 →
 * 脚本在 workRoot 内 → deadline → 磁盘余量。前一项失败就返回，便于测试逐条断言。
 *
 * @param {object} input
 * @param {string[]} input.argv
 * @param {string} input.cwd
 * @param {number} input.deadlineMin
 * @param {string} [input.label]
 * @param {object} input.config  已 normalize 的 config（用 bg / bgConcurrency）
 * @param {object} [input.store] 有时用于并发闸门与 running 清单
 * @param {object} [input.fs]    注入点：{realpathSync, statSync, statfsSync}
 * @returns {{ok: true, plan: object} | {ok: false, reason: string, message: string, running?: object[]}}
 */
export function validateBgRun({ argv, cwd, deadlineMin, label, config, store, fs = {} }) {
  const bg = config?.bg ?? {};
  const workRootRaw = typeof bg.workRoot === 'string' ? bg.workRoot.trim() : '';
  if (workRootRaw === '') {
    return {
      ok: false,
      reason: 'not-configured',
      message: '不可用：未配置 bg.workRoot（后台长任务的工作目录根）',
    };
  }

  const concurrency = Number.isInteger(config?.bgConcurrency) ? config.bgConcurrency : 1;
  if (store !== undefined && store !== null) {
    const running = store.listBgJobs({ state: BG_JOB_STATES.running, limit: 50 });
    if (running.length >= concurrency) {
      const lines = running.map((job) => {
        const labelText = job.label === null || job.label === '' ? '(无标签)' : job.label;
        return `- ${job.id}｜${labelText}｜${job.argv.join(' ')}｜deadline ${formatDeadline(job)}`;
      });
      return {
        ok: false,
        reason: 'busy',
        message: [
          `并发已满（bgConcurrency=${concurrency}），后台任务不能并行；正在运行：`,
          ...lines,
        ].join('\n'),
        running,
      };
    }
  }

  const realpath = fs.realpathSync ?? realpathSync;
  const stat = fs.statSync ?? statSync;
  const statfs = fs.statfsSync ?? statfsSync;

  if (!Array.isArray(argv) || argv.length < 2) {
    return {
      ok: false,
      reason: 'bad-argv',
      message: '参数不足：argv 至少要给出解释器与脚本路径（argv[0] 解释器，argv[1] 脚本）',
    };
  }
  for (const item of argv) {
    if (typeof item !== 'string' || item === '') {
      return { ok: false, reason: 'bad-argv', message: 'argv 的每一项都必须是非空字符串' };
    }
  }
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    return { ok: false, reason: 'bad-cwd', message: 'cwd 必须是非空字符串' };
  }

  let workRoot;
  try {
    workRoot = realpath(workRootRaw);
  } catch {
    return {
      ok: false,
      reason: 'workroot-missing',
      message: `不可用：bg.workRoot 不存在或不可访问（${workRootRaw}）`,
    };
  }

  // W-1a：cwd 必须在 workRoot 下；realpath 之后比较，符号链接跳出与 .. 都被拦住。
  let realCwd;
  try {
    realCwd = realpath(resolve(workRoot, cwd.trim()));
  } catch {
    return { ok: false, reason: 'bad-cwd', message: `cwd 不可访问或不存在：${cwd.trim()}` };
  }
  if (!isInsideRoot(workRoot, realCwd)) {
    return {
      ok: false,
      reason: 'cwd-outside',
      message: `cwd 必须在 bg.workRoot 内（${realCwd} 不在 ${workRoot} 下；符号链接与 .. 跳出都会被拒绝）`,
    };
  }
  let cwdIsDir = false;
  try {
    cwdIsDir = stat(realCwd).isDirectory();
  } catch {
    cwdIsDir = false;
  }
  if (!cwdIsDir) {
    return { ok: false, reason: 'bad-cwd', message: `cwd 不是目录：${realCwd}` };
  }

  // W-1b：解释器白名单（原样比较 argv[0]，不做 PATH 解析——计划要求 argv 数组直传）。
  const interpreters = Array.isArray(bg.interpreters) ? bg.interpreters : [];
  if (!interpreters.includes(argv[0])) {
    return {
      ok: false,
      reason: 'interpreter-denied',
      message: `解释器不在白名单：argv[0]=${argv[0]}，允许 ${interpreters.join(', ')}`,
    };
  }

  // W-1b：脚本也必须在 workRoot 内（同样按 realpath 判定）。
  let realScript;
  try {
    realScript = realpath(resolve(realCwd, argv[1]));
  } catch {
    return { ok: false, reason: 'bad-script', message: `脚本不存在或不可访问：${argv[1]}` };
  }
  if (!isInsideRoot(workRoot, realScript)) {
    return {
      ok: false,
      reason: 'script-outside',
      message: `脚本必须在 bg.workRoot 内（${realScript} 不在 ${workRoot} 下）`,
    };
  }

  // W-5：deadline 必填且不超过 bg.maxDeadlineMin。
  const maxDeadline = Number.isInteger(bg.maxDeadlineMin) ? bg.maxDeadlineMin : 360;
  if (deadlineMin === undefined || deadlineMin === null) {
    return { ok: false, reason: 'deadline-required', message: 'deadline_min 必填（分钟）' };
  }
  if (!Number.isInteger(deadlineMin) || deadlineMin < 1) {
    return { ok: false, reason: 'bad-deadline', message: `deadline_min 必须是正整数分钟，收到 ${JSON.stringify(deadlineMin)}` };
  }
  if (deadlineMin > maxDeadline) {
    return {
      ok: false,
      reason: 'deadline-too-long',
      message: `deadline_min ${deadlineMin} 超过上限 bg.maxDeadlineMin=${maxDeadline}`,
    };
  }

  // W-5：workRoot 剩余空间低于 bg.minFreeDiskMB 时拒绝启动。
  const minFree = Number.isInteger(bg.minFreeDiskMB) ? bg.minFreeDiskMB : 1024;
  if (minFree > 0) {
    try {
      const info = statfs(workRoot);
      const freeMB = Math.floor((Number(info.bavail) * Number(info.bsize)) / (1024 * 1024));
      if (Number.isFinite(freeMB) && freeMB < minFree) {
        return {
          ok: false,
          reason: 'disk-low',
          message: `workRoot 剩余空间不足：${freeMB}MB < bg.minFreeDiskMB=${minFree}MB`,
        };
      }
    } catch {
      // statfs 不可用（有些容器 / 平台不支持）时不拦，交给运行期失败。
    }
  }

  const scriptSha256 = sha256OfFile(realScript, fs);
  return {
    ok: true,
    plan: {
      // W77-H1：argv[1] 换成 realpath 之后的绝对路径。systemd 的瞬态 service 自己
      // 有一套 cwd（由 --working-directory 给），相对路径在那边解析会指向别的文件；
      // 校验、sha256 与实际执行必须是同一个绝对路径。
      argv: [argv[0], realScript, ...argv.slice(2)],
      cwd: realCwd,
      scriptPath: realScript,
      scriptSha256,
      deadlineMin,
      deadlineSec: deadlineMin * 60,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : basename(realScript),
      workRoot,
    },
  };
}

/**
 * 脚本 sha256（W-1e 审计列）。读不到时返回 null，不影响启动。
 * @param {string} path
 * @param {object} [fs] 注入点：{readFileSync}
 * @returns {string|null}
 */
export function sha256OfFile(path, fs = {}) {
  const read = typeof fs.readFileSync === 'function' ? fs.readFileSync : readFileSync;
  try {
    return createHash('sha256').update(read(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 生成任务 id：时间有序 + 随机后缀（便于人肉排查，也避免重名）。
 * @param {number} nowMs
 * @returns {string}
 */
export function makeBgJobId(nowMs = Date.now()) {
  const stamp = Math.floor(nowMs).toString(36);
  const suffix = createHash('sha256')
    .update(`${nowMs}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `bg-${stamp}-${suffix}`;
}

/**
 * W-1d：日志路径（`<logRoot>/<id>/output.log`）。
 * @param {string} id
 * @param {string} [logRoot]
 * @returns {string}
 */
export function bgLogPath(id, logRoot = DEFAULT_BG_LOG_ROOT) {
  return `${jobDir(logRoot, id).replace(/\\/gu, '/')}/output.log`;
}

/**
 * W-1：拉起任务并落库，返回立刻可见的行（W-1f：立即返回 id）。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.config
 * @param {{argv: string[], cwd: string, deadlineMin: number, label?: string}} input.params
 * @param {{childAgentName?: string|null, childSessionId: string, rootSessionId?: string|null,
 *   launchedBy?: string|null}} input.origin
 * @param {string} [input.logRoot]
 * @param {object} [input.launcher] 注入点：{startBgProcess}
 * @param {number} [input.nowMs]
 * @returns {Promise<{ok: true, job: object} | {ok: false, reason: string, message: string}>}
 */
export async function startBgJob({
  store,
  config,
  params,
  origin,
  logRoot = DEFAULT_BG_LOG_ROOT,
  launcher = {},
  nowMs = Date.now(),
  uid,
}) {
  const verdict = validateBgRun({
    argv: params?.argv,
    cwd: params?.cwd,
    deadlineMin: params?.deadlineMin,
    label: params?.label,
    config,
    store,
  });
  if (!verdict.ok) return verdict;

  const plan = verdict.plan;
  const id = makeBgJobId(nowMs);
  const start = launcher.startBgProcess ?? startBgProcess;
  const started = await start({
    id,
    argv: plan.argv,
    cwd: plan.cwd,
    // W77-H1：service 自己的工作目录（不是 spawn 客户端的 cwd）。
    workingDirectory: plan.cwd,
    // W77-M2：PATH/HOME 由 launcher 默认透传，这里只补 bg.env 列出的变量。
    envNames: Array.isArray(config?.bg?.env) ? config.bg.env : [],
    deadlineSec: plan.deadlineSec,
    memoryMax: config?.bg?.memoryMax ?? '4G',
    cpuQuota: config?.bg?.cpuQuota ?? '200%',
    runAs: config?.bg?.runAs ?? '',
    // D21-H4：uid 决定 systemd 模式（0=系统实例，非 0=该用户的用户级实例）。
    uid: Number.isInteger(uid) ? Number(uid) : currentUid(),
    logRoot,
  });
  const logPath = started.logPath ?? bgLogPath(id, logRoot);
  const startedAt = Math.floor(nowMs / 1000);

  // W77-M1：拉起被拒（systemd-run 早退 / spawn 失败）→ 记 failed 行 + 审计，
  // 由调用方（tools 的 bg_run）沿 SA-B3 回执一句，不再静默丢在后台。
  if (started.failure !== undefined && started.failure !== null) {
    const failure = started.failure;
    const failedJob = store.insertBgJob({
      id,
      label: plan.label,
      argv: plan.argv,
      cwd: plan.cwd,
      script_sha256: plan.scriptSha256,
      child_agent_name: origin?.childAgentName ?? null,
      child_session_id: origin?.childSessionId,
      root_session_id: origin?.rootSessionId ?? null,
      pid_or_unit: started.unit ?? null,
      started_at: startedAt,
      deadline: startedAt + plan.deadlineSec,
      state: BG_JOB_STATES.failed,
      log_path: logPath.replace(/\\/gu, '/'),
      exit_code: failure.exitCode ?? null,
      finished_at: startedAt,
      launched_by: origin?.launchedBy ?? null,
    });
    try {
      store.appendEvent({
        action: 'ADD',
        actor: 'scheduler',
        table_name: 'bg_jobs',
        row_id: id,
        reason: 'bg_run',
        detail_json: {
          kind: 'bg_job_failed',
          label: plan.label,
          argv: plan.argv,
          cwd: plan.cwd,
          failure: failure.reason,
          message: failure.message,
          // D21-H3：systemd-run 客户端的 stderr（polkit/DBus 原文）进审计，
          // 排障不必再去翻 launch.log。
          launch_log_tail: Array.isArray(failure.launchLogTail) ? failure.launchLogTail : [],
          child_session_id: origin?.childSessionId ?? null,
          log_path: failedJob.log_path,
        },
      });
    } catch {
      // 同 W-1e：审计失败不影响失败回执本身。
    }
    const launchLogTail = Array.isArray(failure.launchLogTail) && failure.launchLogTail.length > 0
      ? failure.launchLogTail
      : [];
    const tailText = launchLogTail.length > 0 ? launchLogTail.join('\n') : '';
    // D21-H3：launcher 可能已经把同一段 stderr 拼进 failure.message（真实拉起失败
    // 就是这条路径）；回执里只允许出现一次，message 缺了才补。
    const failureMessage = typeof failure.message === 'string' ? failure.message : String(failure.message ?? '');
    const needsTail = tailText !== '' && !failureMessage.includes(tailText);
    return {
      ok: false,
      reason: 'launch-failed',
      message: `后台任务拉起失败（${failure.reason}）：${failureMessage}${needsTail ? `\n启动日志末尾：\n${tailText}` : ''}`,
      launchLogTail,
      job: failedJob,
    };
  }

  const job = store.insertBgJob({
    id,
    label: plan.label,
    argv: plan.argv,
    cwd: plan.cwd,
    script_sha256: plan.scriptSha256,
    child_agent_name: origin?.childAgentName ?? null,
    child_session_id: origin?.childSessionId,
    root_session_id: origin?.rootSessionId ?? null,
    pid_or_unit: started.unit ?? (started.pid === null || started.pid === undefined ? null : String(started.pid)),
    started_at: startedAt,
    deadline: startedAt + plan.deadlineSec,
    state: BG_JOB_STATES.running,
    log_path: logPath.replace(/\\/gu, '/'),
    launched_by: origin?.launchedBy ?? null,
  });

  // W-1e：审计记录（与 bg_jobs 行并存，便于 /记忆 治理与事后追责）。
  try {
    store.appendEvent({
      action: 'ADD',
      actor: 'scheduler',
      table_name: 'bg_jobs',
      row_id: id,
      reason: 'bg_run',
      detail_json: {
        kind: 'bg_job_started',
        label: plan.label,
        argv: plan.argv,
        cwd: plan.cwd,
        script_sha256: plan.scriptSha256,
        child_session_id: origin?.childSessionId ?? null,
        pid_or_unit: job.pid_or_unit,
        deadline: job.deadline,
        log_path: job.log_path,
        runAs: config?.bg?.runAs ?? '',
      },
    });
  } catch {
    // 审计写失败不影响任务本身（与 run.js writeAudit 同口径）。
  }
  return { ok: true, job };
}

/**
 * W-3：唤醒消息正文——退出码、末尾 ≤2KB 输出、日志路径。
 * @param {object} job
 * @param {{exitCode: number|null, tail: string, timedOut?: boolean}} result
 * @returns {string}
 */
export function buildWakeMessage(job, { exitCode, tail, timedOut = false }) {
  const label = job?.label === null || job?.label === undefined || job.label === ''
    ? '(无标签)'
    : String(job.label);
  const command = Array.isArray(job?.argv) ? job.argv.join(' ') : '';
  const codeText = exitCode === null || exitCode === undefined
    ? '未知（未取到退出码）'
    : String(exitCode);
  const stateText = timedOut === true ? '已超时被终止' : '已结束';
  const tailText = typeof tail === 'string' && tail.trim() !== '' ? tail.trimEnd() : '（日志为空）';
  return [
    `[后台任务] ${job?.id ?? ''} ${label} ${stateText}`,
    `命令：${command}`,
    `退出码：${codeText}`,
    `日志：${job?.log_path ?? ''}`,
    '末尾输出：',
    tailText,
  ].join('\n');
}

/**
 * W-3：唤醒预算——按发起子代理（child_session_id）聚合计数。
 * @param {object} store
 * @param {string} childSessionId
 * @returns {number}
 */
export function readWakeCount(store, childSessionId) {
  const key = `${WAKE_META_PREFIX}${childSessionId}`;
  try {
    const raw = store.getMeta(key);
    const n = Number.parseInt(String(raw ?? '0'), 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {object} store
 * @param {string} childSessionId
 * @param {number} count
 */
export function writeWakeCount(store, childSessionId, count) {
  const key = `${WAKE_META_PREFIX}${childSessionId}`;
  try {
    store.setMeta(key, String(count));
  } catch {
    // 诊断性质，写失败不阻塞唤醒。
  }
}

/**
 * W-2/W-4：扫描一轮后台任务。
 *
 * 三种结局：
 * 1. 还在跑、未超 deadline → 什么都不做；
 * 2. 已退出（退出码文件存在）→ 原子迁移 `running → woken`，由 `wake` 回调投递；
 * 3. 已超 deadline 或 unit 已经没了却没有退出码文件 → 先 TERM、等
 *    `BG_TERM_GRACE_MS` 再 KILL，状态记 `timeout`；完全查不到进程且无退出文件 →
 *    `lost`（W-4 第三分支）。
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.config
 * @param {(info: object) => Promise<object>|object} input.wake 唤醒/投递回调
 * @param {object} [input.launcher] {probeBgProcess, signalBgProcess, tailLog, readExitCode}
 * @param {number} [input.nowMs]
 * @param {number} [input.uid] 进程 uid（D21-H4：非 0 → 用户级 systemd）
 * @param {boolean} [input.recovering] 启动恢复（W-4）时为 true，语义相同但日志区分
 * @returns {Promise<{checked: number, woken: number, timedOut: number, lost: number, running: number}>}
 */
export async function monitorBgJobs({
  store,
  config,
  wake,
  launcher = {},
  nowMs = Date.now(),
  uid,
  recovering = false,
  graceMs = BG_TERM_GRACE_MS,
}) {
  const probe = launcher.probeBgProcess ?? probeBgProcess;
  const signal = launcher.signalBgProcess ?? signalBgProcess;
  const readTail = launcher.tailLog ?? tailLog;
  const capLog = launcher.capLogFile ?? capLogFile;
  // D21-H4：探针与信号查询要和拉起时同一模式（--user + DBus 环境）。
  const effectiveUid = Number.isInteger(uid) ? Number(uid) : currentUid();
  const userMode = resolveSystemdMode(effectiveUid) === 'user';
  const jobs = store.listBgJobs({ state: BG_JOB_STATES.running, limit: 100 });
  const summary = { checked: jobs.length, woken: 0, timedOut: 0, lost: 0, running: 0 };
  const nowSec = Math.floor(nowMs / 1000);
  // W77-L1（方案甲）：日志按 bg.logMaxMB 保留尾部。包装器可能被 RuntimeMaxSec 的
  // SIGKILL 直接杀掉（trap 不保证执行），所以截断放在监视器里每轮做一次，
  // 长任务日志最多超出「一个轮询间隔」的量。
  const logMaxMB = Number.isFinite(config?.bg?.logMaxMB) ? config.bg.logMaxMB : 50;
  const logMaxBytes = Math.max(0, Math.floor(logMaxMB * 1024 * 1024));

  for (const job of jobs) {
    if (logMaxBytes > 0) capLog(job.log_path, logMaxBytes);
    const kind = job.pid_or_unit !== null && String(job.pid_or_unit).startsWith('dsh-bg-') ? 'linux' : 'portable';
    const pid = kind === 'portable' && job.pid_or_unit !== null ? Number.parseInt(String(job.pid_or_unit), 10) : null;
    const exitPath = `${String(job.log_path).replace(/\/output\.log$/u, '')}/exit`;
    let probed;
    try {
      probed = await probe({ unit: job.pid_or_unit, pid, exitPath, kind, ...(kind === 'linux' ? { user: userMode, uid: effectiveUid } : {}) });
    } catch {
      summary.running += 1;
      continue;
    }

    if (probed.exited === true) {
      const claimed = store.claimBgJobState(job.id, BG_JOB_STATES.woken, {
        exit_code: probed.exitCode ?? null,
        finished_at: nowSec,
      });
      if (!claimed) continue; // 已被并发的另一轮抢到，保证只唤醒一次。
      const tail = readTail(job.log_path, BG_TAIL_BYTES);
      summary.woken += 1;
      await deliverWake({ store, config, wake, job, exitCode: probed.exitCode ?? null, tail, timedOut: false });
      continue;
    }

    if (probed.running === true && nowSec < job.deadline) {
      summary.running += 1;
      continue;
    }

    if (probed.running === true && nowSec >= job.deadline) {
      // W-2：主杀由 systemd 的 RuntimeMaxSec 完成，这里是兜底（TERM → 10s → KILL）。
      await signal({ unit: job.pid_or_unit, pid, kind, signal: 'TERM', ...(kind === 'linux' ? { user: userMode, uid: effectiveUid } : {}) });
      const termDeadline = nowMs + graceMs;
      let stillAlive = true;
      while (nowMs < termDeadline) {
        await sleep(Math.min(250, Math.max(0, termDeadline - nowMs)));
        nowMs = Date.now() > nowMs ? Date.now() : nowMs;
        const again = await probe({ unit: job.pid_or_unit, pid, exitPath, kind, ...(kind === 'linux' ? { user: userMode, uid: effectiveUid } : {}) }).catch(() => ({ running: false }));
        if (again.exited === true || again.running !== true) {
          stillAlive = false;
          break;
        }
        break; // 单轮不阻塞调度器：下一轮 tick 继续判断，KILL 由下一轮补。
      }
      if (stillAlive) await signal({ unit: job.pid_or_unit, pid, kind, signal: 'KILL', ...(kind === 'linux' ? { user: userMode, uid: effectiveUid } : {}) });
      const code = readExitCode(exitPath);
      const claimed = store.claimBgJobState(job.id, BG_JOB_STATES.timeout, {
        exit_code: code ?? null,
        finished_at: nowSec,
      });
      if (!claimed) continue;
      summary.timedOut += 1;
      await deliverWake({
        store,
        config,
        wake,
        job,
        exitCode: code ?? null,
        tail: readTail(job.log_path, BG_TAIL_BYTES),
        timedOut: true,
      });
      continue;
    }

    // W-4 第三分支：既没在跑，也没有退出码文件 → lost，仍然唤醒（附已取到的日志尾巴）。
    const claimed = store.claimBgJobState(job.id, BG_JOB_STATES.lost, { finished_at: nowSec });
    if (!claimed) continue;
    summary.lost += 1;
    await deliverWake({
      store,
      config,
      wake,
      job,
      exitCode: readExitCode(exitPath),
      tail: readTail(job.log_path, BG_TAIL_BYTES),
      timedOut: false,
      lost: true,
    });
  }

  // W-4 的启动扫描只在真的接管了遗留任务时才记一条审计：没有 running 行时
  // 每 30 秒/每次重启都写一行会把 memory_events 撑满（也污染 /状态 的首行计数）。
  if (recovering && summary.checked > 0) {
    try {
      store.appendEvent({
        action: 'USED',
        actor: 'scheduler',
        table_name: 'bg_jobs',
        row_id: null,
        reason: 'bg_recover',
        detail_json: { kind: 'bg_recover', ...summary },
      });
    } catch {
      // 同上：诊断记录失败不阻塞启动。
    }
  }
  return summary;
}

/**
 * W-3：单条唤醒/投递。命中预算且能唤醒原子代理 → `woken`，否则 `woken-fallback`
 * 直接投主会话（A2 兜底）。
 * @param {object} input
 * @returns {Promise<object>}
 */
async function deliverWake({ store, config, wake, job, exitCode, tail, timedOut, lost = false }) {
  const budget = Number.isInteger(config?.bg?.wakeBudgetPerAgent) ? config.bg.wakeBudgetPerAgent : 3;
  const used = readWakeCount(store, job.child_session_id);
  const allowWake = used < budget;
  const message = buildWakeMessage(job, { exitCode, tail, timedOut });
  let outcome;
  try {
    outcome = await wake({
      job,
      message,
      exitCode,
      tail,
      timedOut,
      lost,
      allowWake,
      state: allowWake ? BG_JOB_STATES.woken : BG_JOB_STATES.wokenFallback,
    });
  } catch (error) {
    outcome = { delivered: false, channel: 'none', error: String(error?.message ?? error) };
  }
  if (allowWake && outcome?.delivered === true) {
    writeWakeCount(store, job.child_session_id, used + 1);
    store.updateBgJob(job.id, { wake_count: job.wake_count + 1 });
  } else if (!allowWake) {
    // 预算耗尽：状态落成 fallback，便于 /状态 与排查区分「唤醒」与「直接通知」。
    store.updateBgJob(job.id, { state: BG_JOB_STATES.wokenFallback });
  }
  try {
    store.appendEvent({
      action: 'USED',
      actor: 'scheduler',
      table_name: 'bg_jobs',
      row_id: job.id,
      reason: 'bg_job_finished',
      detail_json: {
        kind: 'bg_job_finished',
        state: store.getBgJob(job.id)?.state ?? null,
        exit_code: exitCode,
        timed_out: timedOut === true,
        lost: lost === true,
        wake_budget: budget,
        wake_used: used,
        channel: outcome?.channel ?? null,
        delivered: outcome?.delivered === true,
      },
    });
  } catch {
    // 同上。
  }
  return outcome ?? { delivered: false };
}

/** W-2 计时用的最小 sleep（单测可注入 graceMs=0 跳过等待）。 */
function sleep(ms) {
  return new Promise((resolvePromise) => {
    if (ms <= 0) resolvePromise();
    else setTimeout(resolvePromise, ms).unref?.();
  });
}

/**
 * W-5：启动时告知用户一句（label、预计时长、deadline）。文案与 SA-B3 前缀一致。
 * @param {object} job
 * @returns {string}
 */
export function buildStartNotice(job) {
  const label = job?.label === null || job?.label === undefined || job.label === ''
    ? '(无标签)'
    : String(job.label);
  const minutes = Number.isInteger(job?.deadlineMin)
    ? job.deadlineMin
    : Math.max(1, Math.round(((job?.deadline ?? 0) - (job?.started_at ?? 0)) / 60));
  const deadlineClock = formatDeadline(job);
  return `[任务] 已把后台任务「${label}」拉起来（预计 ${minutes} 分钟，deadline ${deadlineClock}，id ${job?.id ?? ''}）；完成后会把退出码与日志尾部回执给你。`;
}

/**
 * 秒级 epoch → `HH:MM`（按调度器时区由调用方转换；这里只做粗略的本地展示）。
 * @param {object} job
 * @returns {string}
 */
function formatDeadline(job) {
  if (!Number.isInteger(job?.deadline)) return '未知';
  const date = new Date(job.deadline * 1000);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
