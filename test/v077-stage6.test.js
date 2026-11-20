/**
 * W-1..W-5（v0.7.7 阶段 6）验收测试：后台长任务。
 *
 * **非真机证据**：systemd-run / RuntimeMaxSec / 真实 20 分钟脚本 + 重启补投这些
 * 生产路径本机（Windows 开发机）无法验证，测试用注入的 launcher（probe/signal/
 * tail）+ 假 pid/unit 覆盖状态机；systemd 参数只做纯函数断言（`buildSystemdRunArgs`）。
 * 生产语义见 src/task/bg-launcher.js 的文件头。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULTS, normalizeBg, normalizeConfig } from '../src/config.js';
import { Store } from '../src/memory/store.js';
import { createTools } from '../src/runtime/tools.js';
import {
  buildPosixWrapper,
  buildSystemdRunArgs,
  buildWindowsWrapper,
  capLogFile,
  launcherKind,
  readExitCode,
  tailLog,
} from '../src/task/bg-launcher.js';
import {
  BG_JOB_STATES,
  BG_TAIL_BYTES,
  buildStartNotice,
  buildWakeMessage,
  isInsideRoot,
  monitorBgJobs,
  readWakeCount,
  startBgJob,
  validateBgRun,
} from '../src/task/bg-jobs.js';

const NOW_MS = 1_700_000_000_000;

/** 在临时目录里造一个 workRoot（含脚本）。 */
function makeWorkRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bg-'));
  const work = join(root, 'work');
  mkdirSync(join(work, 'proj'), { recursive: true });
  writeFileSync(join(work, 'proj', 'train.py'), 'print("hi")\n');
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(root, 'outside', 'escape.py'), 'print("nope")\n');
  // bg_run 的 Windows 替身是 detached 子进程，它的 cwd 可能就在 workRoot 里；
  // 目录被占用时 rm 会 EPERM，这里带重试（并且失败也不影响断言结论）。
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // 临时目录残留不影响测试结论。
    }
  });
  return { root, work, outside: join(root, 'outside') };
}

function bgConfig(workRoot, overrides = {}) {
  return normalizeConfig({
    bg: { workRoot, ...overrides },
  });
}

/**
 * W77-M3：launcher 替身——不 spawn 任何进程，只返回一份「已拉起」的结果
 * （或注入的 `failure`）。所有形如真实 systemd 的输出都由这里构造，
 * **非真机证据**：真实的 systemd-run / RuntimeMaxSec 未在本机验证。
 */
function fakeLauncher(logRoot, overrides = {}) {
  const calls = [];
  return {
    calls,
    async startBgProcess(spec) {
      calls.push(spec);
      const dir = join(logRoot, spec.id);
      mkdirSync(dir, { recursive: true });
      return {
        unit: `dsh-bg-${spec.id}`,
        pid: null,
        logPath: join(dir, 'output.log'),
        exitPath: join(dir, 'exit'),
        wrapperPath: join(dir, 'run.sh'),
        kind: 'linux',
        ...overrides,
      };
    },
  };
}

test('W-1：bg.workRoot 未配置 → 工具报不可用，不猜路径', () => {
  const verdict = validateBgRun({ argv: ['node', 'x.js'], cwd: '/tmp', deadlineMin: 20, config: DEFAULTS });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'not-configured');
  assert.match(verdict.message, /未配置 bg\.workRoot/u);
});

test('W-1a：cwd 用 .. 跳出 workRoot 被拒（realpath 之后比较，不是字符串前缀）', (t) => {
  const { work, outside } = makeWorkRoot(t);
  const config = bgConfig(work);
  const verdict = validateBgRun({
    argv: ['node', join(work, 'proj', 'train.py')],
    cwd: '../outside',
    deadlineMin: 20,
    config,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'cwd-outside');
  assert.ok(outside.length > 0);
});

test('W-1a：指向 workRoot 外的符号链接被拒（注入 realpath 模拟符号链接解析）', (t) => {
  const { work, outside } = makeWorkRoot(t);
  const config = bgConfig(work);
  // 本机（Windows）建符号链接需管理员权限，这里注入 realpath 的解析结果来模拟
  // 「cwd 是一个指向 workRoot 外的符号链接」这一形态。
  const fakeFs = {
    realpathSync: (path) => (String(path).includes('link-out') ? join(outside, 'x') : work),
  };
  const verdict = validateBgRun({
    argv: ['node', join(work, 'proj', 'train.py')],
    cwd: 'link-out',
    deadlineMin: 20,
    config,
    fs: fakeFs,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'cwd-outside');
});

test('W-1b：argv[0] 不在 bg.interpreters 白名单被拒', (t) => {
  const { work } = makeWorkRoot(t);
  const verdict = validateBgRun({
    argv: ['/bin/sh', join(work, 'proj', 'train.py')],
    cwd: work,
    deadlineMin: 20,
    config: bgConfig(work),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'interpreter-denied');
  assert.match(verdict.message, /python3, bash, node/u);
});

test('W-1b：脚本在 workRoot 外被拒（即使解释器合法）', (t) => {
  const { work, outside } = makeWorkRoot(t);
  const verdict = validateBgRun({
    argv: ['python3', join(outside, 'escape.py')],
    cwd: work,
    deadlineMin: 20,
    config: bgConfig(work),
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'script-outside');
});

test('W-5：deadline_min 必填、必须是正整数、不超过 bg.maxDeadlineMin', (t) => {
  const { work } = makeWorkRoot(t);
  const config = bgConfig(work, { maxDeadlineMin: 60 });
  const base = { argv: ['python3', join(work, 'proj', 'train.py')], cwd: work, config };
  assert.equal(validateBgRun({ ...base }).reason, 'deadline-required');
  assert.equal(validateBgRun({ ...base, deadlineMin: 1.5 }).reason, 'bad-deadline');
  assert.equal(validateBgRun({ ...base, deadlineMin: 61 }).reason, 'deadline-too-long');
  const ok = validateBgRun({ ...base, deadlineMin: 60 });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.deadlineSec, 3600);
});

test('W-5：workRoot 剩余空间低于 bg.minFreeDiskMB 时拒绝启动（注入 statfs）', (t) => {
  const { work } = makeWorkRoot(t);
  const config = bgConfig(work, { minFreeDiskMB: 1024 });
  const verdict = validateBgRun({
    argv: ['python3', join(work, 'proj', 'train.py')],
    cwd: work,
    deadlineMin: 20,
    config,
    fs: { statfsSync: () => ({ bavail: 10, bsize: 4096 }) },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'disk-low');
});

test('W-5：并发满额时拒绝并返回正在运行的任务', (t) => {
  const { work } = makeWorkRoot(t);
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const config = bgConfig(work);
  store.insertBgJob({
    id: 'bg-running-1',
    label: '训练',
    argv: ['python3', '/opt/work/t.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    started_at: 1_700_000_000,
    deadline: 1_700_000_600,
    log_path: '/opt/logs/bg-running-1/output.log',
  });
  const verdict = validateBgRun({
    argv: ['python3', join(work, 'proj', 'train.py')],
    cwd: work,
    deadlineMin: 20,
    config,
    store,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'busy');
  assert.match(verdict.message, /bg-running-1/u);
  assert.match(verdict.message, /训练/u);
  assert.equal(verdict.running.length, 1);
});

test('W-1：合法请求返回执行计划（realpath 后的 cwd、脚本 sha256、deadline 秒）', (t) => {
  const { work } = makeWorkRoot(t);
  const verdict = validateBgRun({
    argv: ['python3', join(work, 'proj', 'train.py')],
    cwd: 'proj',
    deadlineMin: 20,
    config: bgConfig(work),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.plan.cwd, join(work, 'proj'));
  assert.equal(verdict.plan.deadlineMin, 20);
  assert.match(verdict.plan.scriptSha256, /^[0-9a-f]{64}$/u);
  assert.equal(isInsideRoot(work, verdict.plan.scriptPath), true);
});

test('W77-H1：相对 argv[1] 的计划输出绝对路径（校验、sha256 与实际执行是同一文件）', (t) => {
  const { work } = makeWorkRoot(t);
  const verdict = validateBgRun({
    argv: ['python3', 'train.py', '--epochs', '3'],
    cwd: 'proj',
    deadlineMin: 20,
    config: bgConfig(work),
  });
  assert.equal(verdict.ok, true);
  // 瞬态 service 自己有一套 cwd，相对路径在那边解析会指向别的文件。
  assert.equal(verdict.plan.argv[0], 'python3');
  assert.equal(verdict.plan.argv[1], verdict.plan.scriptPath);
  assert.equal(isInsideRoot(work, verdict.plan.argv[1]), true);
  assert.ok(!verdict.plan.argv[1].includes('..'));
  assert.deepEqual(verdict.plan.argv.slice(2), ['--epochs', '3']);
});

test('W-1c：systemd-run 参数（RuntimeMaxSec / MemoryMax / CPUQuota / --collect；runAs 空不加 --uid）', () => {
  const base = {
    unit: 'dsh-bg-abc',
    deadlineSec: 1200,
    memoryMax: '4G',
    cpuQuota: '200%',
    workingDirectory: '/opt/dsh-companion/.data/work/proj',
    wrapperPath: '/opt/logs/abc/run.sh',
  };
  const asRoot = buildSystemdRunArgs({ ...base, runAs: '' });
  assert.deepEqual(asRoot, [
    '--unit', 'dsh-bg-abc',
    '--collect',
    '-p', 'RuntimeMaxSec=1200',
    '-p', 'MemoryMax=4G',
    '-p', 'CPUQuota=200%',
    // W77-H1：service 的工作目录（spawn 的 cwd 只影响 systemd-run 客户端）。
    '--working-directory=/opt/dsh-companion/.data/work/proj',
    // W77-M2：PATH/HOME 恒透传，避免 venv/conda/代理环境与珞然的 bash 不一致。
    '-E', 'PATH',
    '-E', 'HOME',
    '/bin/sh', '/opt/logs/abc/run.sh',
  ]);
  const asUser = buildSystemdRunArgs({ ...base, runAs: 'trainer' });
  assert.deepEqual(asUser.slice(asUser.indexOf('--uid')), ['--uid', 'trainer', '/bin/sh', '/opt/logs/abc/run.sh']);
  assert.throws(() => buildSystemdRunArgs({ ...base, workingDirectory: undefined }), /working directory/u);
  assert.equal(launcherKind('linux'), 'linux');
  assert.equal(launcherKind('win32'), 'portable');
});

test('W77-M2：bg.env 列出的变量在 -E 后透传，PATH/HOME 去重不重复', () => {
  const args = buildSystemdRunArgs({
    unit: 'dsh-bg-env',
    deadlineSec: 60,
    memoryMax: '2G',
    cpuQuota: '100%',
    workingDirectory: '/opt/work',
    envNames: ['PYTHONPATH', 'PATH', 'HTTP_PROXY', '  '],
    wrapperPath: '/opt/logs/env/run.sh',
  });
  const envPairs = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === '-E') envPairs.push(args[i + 1]);
  }
  assert.deepEqual(envPairs, ['PATH', 'HOME', 'PYTHONPATH', 'HTTP_PROXY']);
});

test('W-1b/d：包装器按 argv 逐项单引号包裹（不经 shell 拼接），并写日志与退出码', () => {
  const script = buildPosixWrapper({
    logPath: '/opt/logs/abc/output.log',
    exitPath: '/opt/logs/abc/exit',
    argv: ['python3', '/opt/work/train.py', '--lr', '1e-3; rm -rf /'],
  });
  // 危险参数被包在单引号里，不会被当成 shell 分隔符执行。
  assert.ok(script.includes(`'1e-3; rm -rf /'`));
  assert.ok(script.includes(`exec >> '/opt/logs/abc/output.log' 2>&1`));
  assert.ok(script.includes(`> "/opt/logs/abc/exit"`));
  // 单引号参数里的 ' 被转义成 '\''，不会提前闭合。
  const tricky = buildPosixWrapper({
    logPath: '/l',
    exitPath: '/e',
    argv: ['node', "it's.js"],
  });
  assert.ok(tricky.includes(`'it'\\''s.js'`));
  assert.throws(
    () => buildWindowsWrapper({ logPath: '/l', exitPath: '/e', argv: ['node', 'a&b.js'] }),
    /shell metacharacters/u,
  );
});

test('W-1d/W-3：退出码读取与日志尾部 ≤2KB', (t) => {
  const { root } = makeWorkRoot(t);
  const exitPath = join(root, 'exit');
  assert.equal(readExitCode(exitPath), null);
  writeFileSync(exitPath, '3\n');
  assert.equal(readExitCode(exitPath), 3);
  const logPath = join(root, 'output.log');
  writeFileSync(logPath, 'x'.repeat(5000));
  assert.equal(tailLog(logPath, BG_TAIL_BYTES).length, BG_TAIL_BYTES);
});

test('W-1e/f：startBgJob 落库 bg_jobs + 审计行并立即返回 id', async (t) => {
  const { work } = makeWorkRoot(t);
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-bglog-'));
  t.after(() => rmSync(logRoot, { recursive: true, force: true }));
  const config = bgConfig(work);
  const calls = [];
  const result = await startBgJob({
    store,
    config,
    params: { argv: ['python3', join(work, 'proj', 'train.py'), '--epochs', '3'], cwd: work, deadlineMin: 20, label: '训练' },
    origin: { childAgentName: 'agent-1', childSessionId: 'child-1', rootSessionId: 'main', launchedBy: 'bg_run' },
    logRoot,
    nowMs: NOW_MS,
    launcher: {
      startBgProcess: async (input) => {
        calls.push(input);
        return { unit: `dsh-bg-${input.id}`, pid: null, logPath: `${logRoot}/${input.id}/output.log`, exitPath: `${logRoot}/${input.id}/exit`, wrapperPath: 'x', kind: 'linux' };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.job.id, /^bg-/u);
  assert.equal(result.job.state, BG_JOB_STATES.running);
  assert.equal(result.job.child_session_id, 'child-1');
  assert.equal(result.job.pid_or_unit, `dsh-bg-${result.job.id}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deadlineSec, 1200);
  assert.equal(calls[0].argv[2], '--epochs');
  const audit = store.listEvents({ table_name: 'bg_jobs' });
  assert.equal(audit.length, 1);
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.kind, 'bg_job_started');
  assert.equal(detail.child_session_id, 'child-1');
  assert.match(detail.script_sha256, /^[0-9a-f]{64}$/u);
});

/** 造一条 running 行（监视器测试用）。 */
function seedRunning(store, overrides = {}) {
  return store.insertBgJob({
    id: 'bg-1',
    label: '训练',
    argv: ['python3', '/opt/work/train.py'],
    cwd: '/opt/work',
    child_session_id: 'child-1',
    started_at: 1_700_000_000,
    deadline: 1_700_001_200,
    log_path: '/opt/logs/bg-1/output.log',
    ...overrides,
  });
}

test('W-2/W-3：已退出 → 原子迁移 woken 并投递一次；再跑一轮不再唤醒', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  seedRunning(store);
  const wakes = [];
  const launcher = {
    probeBgProcess: async () => ({ running: false, exited: true, exitCode: 0 }),
    signalBgProcess: async () => true,
    tailLog: () => 'epoch 3/3 loss=0.1',
    // W77-M3：不碰真实路径（截断由单独用例覆盖）。
    capLogFile: () => false,
  };
  const first = await monitorBgJobs({
    store,
    config: DEFAULTS,
    wake: async (info) => {
      wakes.push(info);
      return { delivered: true, channel: 'subagent' };
    },
    launcher,
    nowMs: NOW_MS,
  });
  assert.deepEqual(first, { checked: 1, woken: 1, timedOut: 0, lost: 0, running: 0 });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].exitCode, 0);
  assert.match(wakes[0].message, /退出码：0/u);
  assert.match(wakes[0].message, /loss=0\.1/u);
  const job = store.getBgJob('bg-1');
  assert.equal(job.state, BG_JOB_STATES.woken);
  assert.equal(job.exit_code, 0);

  const second = await monitorBgJobs({
    store, config: DEFAULTS, wake: async () => ({ delivered: true }), launcher, nowMs: NOW_MS + 30_000,
  });
  assert.equal(second.checked, 0);
  assert.equal(wakes.length, 1);
});

test('W-2：超 deadline → 状态 timeout，先 TERM 再 KILL（RuntimeMaxSec 只是主杀）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  seedRunning(store, { deadline: 1_700_000_600 });
  const signals = [];
  const summary = await monitorBgJobs({
    store,
    config: DEFAULTS,
    wake: async () => ({ delivered: true, channel: 'subagent' }),
    launcher: {
      probeBgProcess: async () => ({ running: true, exited: false, exitCode: null }),
      signalBgProcess: async ({ signal }) => {
        signals.push(signal);
        return true;
      },
      tailLog: () => 'still running',
      capLogFile: () => false,
      readExitCode: () => null,
    },
    nowMs: 1_700_000_700_000,
    graceMs: 0,
  });
  assert.equal(summary.timedOut, 1);
  assert.deepEqual(signals, ['TERM', 'KILL']);
  const job = store.getBgJob('bg-1');
  assert.equal(job.state, BG_JOB_STATES.timeout);
});

test('W-4：进程不在了又没有退出码文件 → lost 并仍然唤醒（带已取到的日志尾巴）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  seedRunning(store);
  const wakes = [];
  const summary = await monitorBgJobs({
    store,
    config: DEFAULTS,
    wake: async (info) => {
      wakes.push(info);
      return { delivered: true, channel: 'subagent' };
    },
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: false, exitCode: null }),
      signalBgProcess: async () => true,
      tailLog: () => 'tail-before-crash',
      capLogFile: () => false,
    },
    nowMs: NOW_MS,
  });
  assert.equal(summary.lost, 1);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].lost, true);
  assert.match(wakes[0].message, /tail-before-crash/u);
  assert.equal(store.getBgJob('bg-1').state, BG_JOB_STATES.lost);
});

test('W-3：唤醒预算耗尽 → woken-fallback（不再唤醒，直接投主会话）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  seedRunning(store);
  store.setMeta('bg_wake:child-1', '3');
  const config = normalizeConfig({ bg: { workRoot: '/opt/work', wakeBudgetPerAgent: 3 } });
  let allowWakeSeen = null;
  await monitorBgJobs({
    store,
    config,
    wake: async (info) => {
      allowWakeSeen = info.allowWake;
      return { delivered: false, channel: 'main' };
    },
    launcher: {
      probeBgProcess: async () => ({ running: false, exited: true, exitCode: 2 }),
      signalBgProcess: async () => true,
      tailLog: () => 'boom',
      capLogFile: () => false,
    },
    nowMs: NOW_MS,
  });
  assert.equal(allowWakeSeen, false);
  assert.equal(store.getBgJob('bg-1').state, BG_JOB_STATES.wokenFallback);
  assert.equal(readWakeCount(store, 'child-1'), 3);
});

test('W-3：唤醒成功计入预算，消息形状含退出码 / 日志路径 / 尾部输出', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const job = seedRunning(store);
  const message = buildWakeMessage(job, { exitCode: 7, tail: 'last line' });
  assert.match(message, /\[后台任务\] bg-1 训练/u);
  assert.match(message, /退出码：7/u);
  assert.match(message, /日志：\/opt\/logs\/bg-1\/output\.log/u);
  assert.match(message, /末尾输出：\nlast line/u);
  const notice = buildStartNotice({ ...job, deadlineMin: 20 });
  assert.match(notice, /^\[任务\] /u);
  assert.match(notice, /预计 20 分钟/u);
});

test('W-1e：bg_jobs 状态迁移是原子的（第二次 claim 返回 false）', (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  seedRunning(store);
  assert.equal(store.claimBgJobState('bg-1', 'woken', { exit_code: 0 }), true);
  assert.equal(store.claimBgJobState('bg-1', 'woken', { exit_code: 0 }), false);
  assert.equal(store.countRunningBgJobs(), 0);
  assert.equal(store.listBgJobs({ state: 'woken' }).length, 1);
});

test('W-5/SA-B4：bg 配置默认值与校验（16 键安装面不动）', () => {
  assert.equal(Object.keys(DEFAULTS).length, 16);
  assert.deepEqual(DEFAULTS.bg.interpreters, ['python3', 'bash', 'node']);
  assert.equal(DEFAULTS.bg.workRoot, '');
  assert.equal(DEFAULTS.bg.runAs, '');
  assert.equal(DEFAULTS.bg.maxDeadlineMin, 360);
  assert.equal(DEFAULTS.bg.memoryMax, '4G');
  assert.equal(DEFAULTS.bg.cpuQuota, '200%');
  assert.equal(DEFAULTS.bg.minFreeDiskMB, 1024);
  assert.equal(DEFAULTS.bg.wakeBudgetPerAgent, 3);
  assert.equal(DEFAULTS.bgConcurrency, 1);
  assert.throws(() => normalizeBg({ interpreters: [] }), /bg\.interpreters/u);
  assert.throws(() => normalizeBg({ maxDeadlineMin: 0 }), /bg\.maxDeadlineMin/u);
  assert.throws(() => normalizeConfig({ bgConcurrency: 0 }), /bgConcurrency/u);
  const warnings = [];
  const cfg = normalizeConfig({ bg: { workRoot: '/opt/work', unknownKey: 1 } }, warnings);
  assert.equal(cfg.bg.workRoot, '/opt/work');
  // normalizeConfig 的 warnings 走配置对象自身（第二参数只是老调用点为兼容传的空数组）。
  const allWarnings = [...(cfg.warnings ?? []), ...warnings];
  assert.ok(allWarnings.some((line) => line.includes('bg.unknownKey')), allWarnings.join('\n'));
});

test('W-1：bg_run 工具在未配置 workRoot 时返回不可用', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const tools = createTools({ store, retrieve: async () => ({ items: [] }), registry: {}, platform: {}, clock: () => NOW_MS });
  const tool = tools.find((entry) => entry.name === 'bg_run');
  const result = await tool.execute({ argv: ['node', 'x.js'], cwd: '/tmp', deadline_min: 20 }, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

test('W-1/W-5：bg_run 正常启动返回 id 并沿 SA-B3 告知一句；并发满额返回 busy', async (t) => {
  const { work } = makeWorkRoot(t);
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-bglog-'));
  t.after(() => rmSync(logRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const config = bgConfig(work);
  const notices = [];
  // W77-M3：注入 logRoot + launcher 替身，用例不再走真实 /opt 与真实 systemd-run。
  const launcher = fakeLauncher(logRoot);
  const tools = createTools({
    store,
    retrieve: async () => ({ items: [] }),
    registry: {},
    platform: {},
    clock: () => NOW_MS,
    bgConfig: config,
    mainSessionId: () => 'main-session',
    taskReceipt: async (info) => notices.push(info),
    bgLogRoot: logRoot,
    bgLauncher: launcher,
  });
  const tool = tools.find((entry) => entry.name === 'bg_run');
  const exec = { agent: { id: 'child-session-1', name: 'agent-1' } };
  const started = await tool.execute(
    { argv: ['python3', join(work, 'proj', 'train.py')], cwd: 'proj', deadline_min: 20, label: '训练' },
    exec,
  );
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(started.id, /^bg-/u);
  assert.equal(store.getBgJob(started.id).child_session_id, 'child-session-1');
  assert.equal(notices.length, 1);
  assert.match(notices[0].receipt, /^\[任务\] /u);
  // W77-H1/M2：拉起时把 service 工作目录与 bg.env 透传给 launcher。
  assert.equal(launcher.calls.length, 1);
  assert.equal(launcher.calls[0].workingDirectory, join(work, 'proj'));
  assert.deepEqual(launcher.calls[0].envNames, []);
  assert.equal(launcher.calls[0].logRoot, logRoot);

  store.updateBgJob(started.id, { state: 'woken', exit_code: 0, finished_at: 1 });
  // 并发：默认 1，塞一条 running 后必须 busy。
  seedRunning(store, { id: 'bg-2' });
  const busy = await tool.execute(
    { argv: ['python3', join(work, 'proj', 'train.py')], cwd: 'proj', deadline_min: 20 },
    exec,
  );
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.running.length, 1);
});

test('W77-M1：systemd-run 拉起被拒 → 记 failed 行 + 审计，并经 SA-B3 回执一句', async (t) => {
  const { work } = makeWorkRoot(t);
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const logRoot = mkdtempSync(join(tmpdir(), 'dsh-bglog-'));
  t.after(() => rmSync(logRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const notices = [];
  const launcher = fakeLauncher(logRoot, {
    failure: { reason: 'launcher-exited', message: 'systemd-run exited early with code 1', exitCode: 1 },
  });
  const tools = createTools({
    store,
    retrieve: async () => ({ items: [] }),
    registry: {},
    platform: {},
    clock: () => NOW_MS,
    bgConfig: bgConfig(work),
    mainSessionId: () => 'main-session',
    taskReceipt: async (info) => notices.push(info),
    bgLogRoot: logRoot,
    bgLauncher: launcher,
  });
  const tool = tools.find((entry) => entry.name === 'bg_run');
  const exec = { agent: { id: 'child-session-1', name: 'agent-1' } };
  const result = await tool.execute(
    { argv: ['python3', join(work, 'proj', 'train.py')], cwd: 'proj', deadline_min: 20, label: '训练' },
    exec,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'launch-failed');
  assert.match(result.message, /后台任务拉起失败/u);
  // 落库为 failed（不是 running），否则下一轮监视器会去探一个不存在的 unit。
  const job = store.getBgJob(result.id);
  assert.equal(job.state, 'failed');
  assert.equal(job.exit_code, 1);
  assert.equal(job.finished_at, job.started_at);
  // 审计行 + SA-B3 回执各一条。
  const events = store.listEvents({ limit: 10 }).filter((row) => row.table_name === 'bg_jobs');
  const failedEvent = events.find((row) => String(row.detail_json).includes('bg_job_failed'));
  assert.ok(failedEvent, '应写一条 bg_job_failed 审计');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, 'error');
  assert.match(notices[0].receipt, /^\[任务\] 后台任务拉起失败/u);
  assert.equal(notices[0].sessionId, 'child-session-1');
});
test('W77-L1：capLogFile 超限只保留尾部，未超限不动文件', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bgcap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const path = join(dir, 'output.log');
  const body = 'HEAD'.repeat(250) + 'TAIL'.repeat(25);
  writeFileSync(path, body);
  assert.equal(capLogFile(path, body.length + 10), false);
  assert.equal(readFileSync(path, 'utf8'), body);
  assert.equal(capLogFile(path, 100), true);
  const capped = readFileSync(path, 'utf8');
  assert.equal(capped.length, 100);
  assert.equal(capped, body.slice(body.length - 100));
  // 0 / 非法值表示不截断。
  assert.equal(capLogFile(path, 0), false);
  assert.equal(capLogFile(join(dir, 'missing.log'), 10), false);
});

test('W77-L1：监视器每轮按 bg.logMaxMB 截一次日志（截断放监视器，包装器被 SIGKILL 时也会执行）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  const capped = [];
  seedRunning(store, { id: 'bg-cap' });
  const summary = await monitorBgJobs({
    store,
    config: bgConfig('/opt/work', { logMaxMB: 7 }),
    wake: async () => ({ delivered: true }),
    nowMs: NOW_MS,
    launcher: {
      probeBgProcess: async () => ({ running: true, exited: false, exitCode: null }),
      signalBgProcess: async () => true,
      tailLog: () => '',
      capLogFile: (path, maxBytes) => {
        capped.push({ path, maxBytes });
        return true;
      },
    },
  });
  assert.equal(summary.running, 1);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].maxBytes, 7 * 1024 * 1024);
});

test('W77-L1：bg.logMaxMB = 0 关闭截断（不调用 capLogFile）', async (t) => {
  const store = Store.open(':memory:');
  t.after(() => store.close());
  let called = 0;
  seedRunning(store, { id: 'bg-nocap' });
  await monitorBgJobs({
    store,
    config: bgConfig('/opt/work', { logMaxMB: 0 }),
    wake: async () => ({ delivered: true }),
    nowMs: NOW_MS,
    launcher: {
      probeBgProcess: async () => ({ running: true, exited: false, exitCode: null }),
      signalBgProcess: async () => true,
      tailLog: () => '',
      capLogFile: () => {
        called += 1;
        return true;
      },
    },
  });
  assert.equal(called, 0);
});