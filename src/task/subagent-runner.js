/**
 * SA-B1（v0.7.7 阶段 4）：用宿主子代理接口执行 task_run / thread_run 的「新建」
 * 分支，替代 `src/task/worker.js` 的 `createSession` + `prompt` 直投路径。
 *
 * 为什么换：worker 路径只能开一个普通会话再把目标 prompt 进去，拿不到结构化
 * 结果、也没有宿主级的并发/深度约束。宿主子代理接口
 * （`dsh-subagent/src/index.ts`）提供：
 * - `startActivation(spec)` :259（实现 :267-292）：派活，返回
 *   `{childId, name, messageId?, result, dispose}`；
 * - `sendMessage(sender, targetId, content, {signal})` :368-375：续派；
 * - `SubagentResult`（`types.ts:260-286`）：`{output, structured?, diagnostic?,
 *   stopReason}`，`stopReason ∈ completed|aborted|error|max-tokens|refusal`
 *   （`types.ts:241-252`），**`structured` 不保证存在**。
 *
 * 本模块只做三件事：组装 spec（A12 命名 / D3 模型裁决）、等结果并把五态映射成
 * 插件自己的 `{status, receipt}`（A1 ≤300 字）、异常兜底。深耕投递与审计留在
 * 调用方（`src/task/run.js`、`src/runtime/tools.js`），便于单测与回退。
 *
 * 兼容回退：`platform.capabilities.subagents === false` 时不进入本模块，
 * `src/task/worker.js` 原路径照旧可用（该文件本阶段不动）。
 */

import { formatReceipt, RECEIPT_MAX_CHARS } from './receipt.js';

/** 宿主 spawn provider 名（`dsh-subagent-spawn-in-process/src/index.ts:28-30`）。 */
export const SUBAGENT_PROVIDER = 'spawn';

/**
 * 投递语义：`'caller'` 表示 activation 的结果消息回给调用方（本插件），
 * 由插件自己转述；`'parent'` 会直接进父会话（插件侧要自己控制回执格式，
 * 所以不用）。见 `types.ts:29-46`。
 */
export const SUBAGENT_DELIVERY = 'caller';

/** 子代理 preset：宿主 minimal（不含插件人格，见阶段 4 SA-B4 的 dump 结论）。 */
export const SUBAGENT_PRESET = 'minimal';

/**
 * 深度上限：宿主 `assertSubagentMaxDepth`（`index.ts:272`）按 provider 的
 * `depthLimit` 能力校验；插件只要一层，子代理不能再派孙代理。
 */
export const SUBAGENT_MAX_DEPTH = 1;

/** 硬超时（毫秒）：沿用 worker 的两段式口径（软 10min / 硬 15min，这里只做硬线）。 */
export const SUBAGENT_HARD_MS = 900_000;

/**
 * D3 裁决（阶段 4）：`subagent.model` **默认空 = 沿用主会话路由**，只有显式
 * 配置且命中 allowlist 时才通过 `agentOptions.model` 传给宿主
 * （`types.ts:170-177`，spawn provider 会把 agentOptions merge over parent）。
 *
 * allowlist 与 profile 允许集对齐（`C:\Users\93488\.dsh\profiles\desktop\cordis.patch.yml`
 * 的 `magpie/opencode-go/*` 两行）；越界不报错，warn 后回落默认（空）。
 */
export const SUBAGENT_MODEL_ALLOWLIST = Object.freeze([
  'magpie/opencode-go/deepseek-v4.1-flash',
  'magpie/opencode-go/glm-5.3',
]);

/**
 * A1：给子代理声明的结构化输出 schema。
 *
 * 宿主 schema 子集只允许 `type/oneOf/properties/required/additionalProperties/
 * items/enum/const` + 注解（`dsh-tools/src/json-schema.ts:267`），**没有
 * maxLength**（同文件 :347-371 / :397-405）——所以长度只能在插件侧截断：
 * 由 `src/task/receipt.js` 的 `RECEIPT_MAX_CHARS=300` 兜底。
 */
export const SUBAGENT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    receipt: {
      type: 'string',
      description: `不超过 ${RECEIPT_MAX_CHARS} 字的结论回执；超长会被插件截断。`,
    },
    status: {
      type: 'string',
      enum: ['ok', 'partial', 'failed'],
      description: '任务终态：ok 完成 / partial 部分完成 / failed 失败。',
    },
    artifacts: {
      type: 'array',
      items: { type: 'string' },
      description: '产物路径或名称（可选，最多 3 条）。',
    },
  },
  required: ['receipt'],
});

/** 宿主 name 规则（`types.ts:29-46`）：1-32 位 `[a-z0-9-]`，首字符字母，`lead` 保留。 */
const HOST_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const RESERVED_NAME = 'lead';

/**
 * A12：线程 key → 宿主合法 name。
 *
 * 线程 key 是 ≤24 码点的中文短名（`src/thread/registry.js`），直接当 name 会被
 * 宿主拒绝。规则：`t` + key 的 UTF-8 hex；同一 key 幂等稳定，截断到 32 位以内。
 * 人类可读的原名放进 `label`（宿主 label 不限字符集）。
 *
 * @param {string} key 线程 key
 * @returns {string}
 */
export function threadSubagentName(key) {
  const text = typeof key === 'string' ? key : String(key ?? '');
  const hex = Buffer.from(text, 'utf8').toString('hex');
  return `t${hex}`.slice(0, 32);
}

/**
 * A12：任务 id → 宿主合法 name（`task-<base36>`，幂等稳定）。
 * @param {string} taskId `task_run` 的 taskId（形如 `t-<base36>`，见 src/task/run.js）
 * @returns {string}
 */
export function taskSubagentName(taskId) {
  const text = typeof taskId === 'string' && taskId !== '' ? taskId : 'unknown';
  // 任务 id 可能带连字符/数字，先取数字与字母部分的 base36 摘要，保证幂等。
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) % 0xffffffff;
  return `task-${hash.toString(36)}`.slice(0, 32);
}

/**
 * 校验/兜底一个候选 name：不合法就按 `agent-N` 兜底交给宿主自命名。
 * @param {string} name
 * @returns {string|null} 合法 name 或 null（不传 name 字段）
 */
export function normalizeSubagentName(name) {
  if (typeof name !== 'string') return null;
  const lower = name.trim().toLowerCase();
  if (lower === '' || lower === RESERVED_NAME) return null;
  return HOST_NAME_PATTERN.test(lower) ? lower : null;
}

/**
 * D3：模型裁决。默认空 = 不传 agentOptions（沿用主会话路由）。
 * @param {string|null|undefined} model 配置里的 `subagent.model`
 * @param {{warn?: Function}} [hooks]
 * @returns {string|null} 允许的模型，或 null（不传）
 */
export function resolveSubagentModel(model, hooks = {}) {
  if (typeof model !== 'string' || model.trim() === '') return null;
  const wanted = model.trim();
  if (SUBAGENT_MODEL_ALLOWLIST.includes(wanted)) return wanted;
  if (typeof hooks.warn === 'function') {
    hooks.warn('[dsh-companion] subagent.model is not in the allowlist; falling back to the main route', {
      model: wanted,
      allowlist: SUBAGENT_MODEL_ALLOWLIST,
    });
  }
  return null;
}

/**
 * A3：五态映射（`types.ts:241-252`）+ 结构化结果缺失/损坏降级。
 *
 * | stopReason | 插件 status | 说明 |
 * | --- | --- | --- |
 * | completed | ok | 正常结束 |
 * | aborted | error | 被取消，带 diagnostic 摘要 |
 * | error | error | 失败，带 diagnostic 摘要 |
 * | max-tokens | partial | 部分完成（上下文/输出上限） |
 * | refusal | error | 模型拒绝执行 |
 *
 * @param {string} stopReason
 * @returns {{status: 'ok'|'partial'|'error', reason?: string}}
 */
export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'completed':
      return { status: 'ok' };
    case 'max-tokens':
      return { status: 'partial', reason: 'max_tokens' };
    case 'refusal':
      return { status: 'error', reason: 'refusal' };
    case 'aborted':
      return { status: 'error', reason: 'aborted' };
    case 'error':
      return { status: 'error', reason: 'subagent_error' };
    default:
      // 未知 stopReason（host 的映射可扩展）：按失败处理，但保留原始值便于诊断。
      return { status: 'error', reason: `unknown_stop_reason:${String(stopReason)}` };
  }
}

/**
 * 从 `SubagentResult.output`（ContentBlock[]）取纯文本摘要。
 * @param {unknown} output
 * @returns {string}
 */
export function outputText(output) {
  if (!Array.isArray(output)) return '';
  const parts = [];
  for (const block of output) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 读出结构化结果：对象直接用；字符串按 JSON 解析；失败返回 `{ok:false}`。
 * @param {unknown} structured
 * @returns {{ok: true, value: object}|{ok: false, error: string}|{ok: true, value: null}}
 */
export function parseStructured(structured) {
  if (structured === undefined || structured === null) return { ok: true, value: null };
  if (typeof structured === 'object' && !Array.isArray(structured)) {
    return { ok: true, value: structured };
  }
  if (typeof structured === 'string') {
    try {
      const parsed = JSON.parse(structured);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, error: 'structured result is not an object' };
    } catch (error) {
      return { ok: false, error: `structured result is not valid JSON: ${messageOf(error)}` };
    }
  }
  return { ok: false, error: `structured result has unsupported type ${typeof structured}` };
}

/**
 * A1：把子代理结果收成 ≤300 字回执。
 *
 * 优先用结构化回执（`structured.receipt`），缺失时降级到 output 全文
 * （计划 A3：「structured 缺失 → 降级取 output 截断、回执只带摘要」）；
 * 无论哪条路径都由 `formatReceipt` 兜底截断。
 *
 * @param {{status: string, structured?: object|null, text?: string, durationMs?: number}} input
 * @returns {string}
 */
export function buildSubagentReceipt({ status, structured, text, durationMs = 0 }) {
  const receipt = typeof structured?.receipt === 'string' ? structured.receipt.trim() : '';
  const artifacts = Array.isArray(structured?.artifacts)
    ? structured.artifacts.filter((item) => typeof item === 'string' && item.trim() !== '')
    : [];
  const summary = receipt !== '' ? receipt : (typeof text === 'string' ? text : '');
  return formatReceipt({ status, summary, artifacts, durationMs });
}

/**
 * 派一个子代理并把结果收成插件自己的 {status, receipt} 形状。
 *
 * 与 `src/task/worker.js` 的 `runTask()` 返回同一形状，调用方（`src/task/run.js`）
 * 无需分叉：`{status:'ok'|'partial'|'timeout'|'error', sessionId, durationMs,
 * reason?, error?, receipt?, structured?}`。
 *
 * @param {object} options
 * @param {object} options.platform 适配器（需 capabilities.subagents + startSubagent）
 * @param {{id?: string, prompt: string, agentPreset?: string, cwd?: string}} options.task
 * @param {object} options.parent 存活 agent 句柄（宿主校验必须是精确对象）
 * @param {string} [options.name] 宿主 name（A12 归一后的值）
 * @param {string} [options.label] 人类可读 label
 * @param {string|null} [options.model] 配置里的 subagent.model（D3）
 * @param {number|Function} [options.now=Date.now] 时钟（毫秒）
 * @param {number} [options.hardMs=SUBAGENT_HARD_MS] 硬超时
 * @param {AbortSignal} [options.signal] 外部取消信号（工具 exec.signal）
 * @param {(childId: string) => void} [options.onChildId] 拿到 childId 的回调（线程锚回写）
 * @param {object} [options.logger] platform.log 的窄化引用（warn 用）
 * @returns {Promise<object>}
 */
export async function runSubagentTask(options = {}) {
  const {
    platform,
    task,
    parent,
    name,
    label,
    model,
    now = Date.now,
    hardMs = SUBAGENT_HARD_MS,
    signal,
    onChildId,
    logger,
  } = options;

  const clock = typeof now === 'function' ? () => Number(now()) : () => Number(now);
  const startedAt = clock();
  const warn = typeof logger === 'function' ? logger : null;

  if (platform === null || typeof platform !== 'object'
    || typeof platform.startSubagent !== 'function') {
    return {
      status: 'error',
      sessionId: null,
      durationMs: 0,
      error: 'subagent-unavailable',
    };
  }
  if (task === null || typeof task !== 'object' || typeof task.prompt !== 'string' || task.prompt === '') {
    return {
      status: 'error',
      sessionId: null,
      durationMs: Math.max(0, clock() - startedAt),
      error: 'task prompt must be a non-empty string',
    };
  }
  if (parent === null || typeof parent !== 'object') {
    return {
      status: 'error',
      sessionId: null,
      durationMs: Math.max(0, clock() - startedAt),
      error: 'no live parent agent',
    };
  }

  const resolvedModel = resolveSubagentModel(model, { warn: warn ?? undefined });
  const normalizedName = normalizeSubagentName(name);
  const preset = typeof task.agentPreset === 'string' && task.agentPreset.trim() !== ''
    ? task.agentPreset.trim()
    : SUBAGENT_PRESET;

  // 硬超时与外部 signal 合成一个控制器：任一触发都 abort 宿主侧运行。
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal !== undefined && typeof signal.addEventListener === 'function') {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(hardMs)));
  // 定时器不应拖住进程退出。
  if (typeof hardTimer?.unref === 'function') hardTimer.unref();

  let activation = null;
  try {
    activation = await platform.startSubagent({
      provider: SUBAGENT_PROVIDER,
      delivery: SUBAGENT_DELIVERY,
      agentPreset: preset,
      maxDepth: SUBAGENT_MAX_DEPTH,
      label: typeof label === 'string' && label !== '' ? label : (task.id ?? 'task'),
      ...(normalizedName === null ? {} : { name: normalizedName }),
      prompt: [{ type: 'text', text: task.prompt }],
      parent,
      signal: controller.signal,
      outputSchema: SUBAGENT_OUTPUT_SCHEMA,
      // D3：默认不传 agentOptions → 沿用主会话路由；只有显式 allowlist 模型才传。
      ...(resolvedModel === null ? {} : { agentOptions: { model: resolvedModel } }),
      ...(typeof task.cwd === 'string' && task.cwd !== '' ? { cwd: task.cwd } : {}),
    });
  } catch (error) {
    clearTimeout(hardTimer);
    if (signal !== undefined && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
    return {
      status: 'error',
      sessionId: null,
      durationMs: Math.max(0, clock() - startedAt),
      error: messageOf(error),
    };
  }

  const childId = typeof activation?.childId === 'string' ? activation.childId : null;
  if (childId !== null && typeof onChildId === 'function') {
    try {
      onChildId(childId);
    } catch {
      // 锚回写失败不影响本次执行。
    }
  }

  let result = null;
  let failure = null;
  try {
    result = await activation.result;
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(hardTimer);
    if (signal !== undefined && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }

  const durationMs = Math.max(0, clock() - startedAt);
  const dispose = async () => {
    if (typeof activation?.dispose !== 'function') return;
    try {
      await activation.dispose();
    } catch {
      // dispose 失败只影响宿主侧清理，不影响回执。
    }
  };
  await dispose();

  if (failure !== null) {
    // result 本身 reject：可能是取消/宿主内部错误；timedOut 优先报超时。
    return {
      status: timedOut ? 'timeout' : 'error',
      sessionId: childId,
      durationMs,
      ...(timedOut ? { reason: 'hard_timeout' } : {}),
      error: messageOf(failure),
    };
  }
  if (timedOut) {
    return {
      status: 'timeout',
      sessionId: childId,
      durationMs,
      reason: 'hard_timeout',
      error: `subagent did not finish within ${hardMs}ms`,
    };
  }

  const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'error';
  const mapped = mapStopReason(stopReason);
  const parsed = parseStructured(result?.structured);
  const text = outputText(result?.output);
  const diagnostic = typeof result?.diagnostic === 'string' && result.diagnostic.trim() !== ''
    ? result.diagnostic.trim()
    : '';

  if (!parsed.ok) {
    // A3：structured 存在但解析失败 → error（回执带上解析错误，便于排查）。
    return {
      status: 'error',
      sessionId: childId,
      durationMs,
      stopReason,
      reason: 'structured_parse_failed',
      error: parsed.error,
      receipt: buildSubagentReceipt({
        status: 'failed',
        structured: null,
        text: parsed.error,
        durationMs,
      }),
    };
  }

  const structured = parsed.value;
  const receipt = buildSubagentReceipt({
    status: mapped.status === 'ok' ? 'ok' : mapped.status === 'partial' ? 'partial' : 'error',
    structured,
    text,
    durationMs,
  });

  const out = {
    status: mapped.status,
    sessionId: childId,
    durationMs,
    stopReason,
    receipt,
    structured,
    text,
  };
  if (mapped.reason !== undefined) out.reason = mapped.reason;
  if (diagnostic !== '') out.error = diagnostic;
  else if (mapped.status === 'error') out.error = text !== '' ? text : `subagent stopped: ${stopReason}`;
  return out;
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
