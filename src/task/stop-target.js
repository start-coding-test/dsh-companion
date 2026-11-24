/**
 * L4（v0.7.17）：`/停止任务` 与 `task_cancel` 共用的目标解析。
 *
 * 解析顺序（与 v0.7.16 的两段式一致，只多一段回跳）：
 *   1. task_run 在跑 → `stopTask(id)`（调用方注入 `stopActiveTask`）；
 *   2. bg_jobs 直接按 id 命中（running / cancelling）——直查优先于审计回跳；
 *   3. 已结束的 task id → task_run 审计（memory_events, table_name='threads',
 *      row_id=taskId）里的 `detail_json.sessionId` → `bg_jobs.child_session_id`
 *      反查 running/cancelling 的后台任务：唯一才取消，多个只列候选，零个 not-found。
 *
 * 本模块只做**解析**（不取消、不发回执），两个调用点各自决定 await/fire-and-forget
 * 与展示形态，避免文案与解析各漂一份。
 */

/** 可被取消的后台任务状态（L1 引入 cancelling）。 */
const STOPPABLE_BG_STATES = Object.freeze(['running', 'cancelling']);

/**
 * @param {object} input
 * @param {object} input.store Store 实例（需要 getBgJob / listBgJobs / latestEventForRow）
 * @param {string|null} input.target 用户给的 taskId
 * @param {(taskId: string) => boolean} [input.stopTask] task_run 的取消入口
 * @returns {{ok: true, kind: 'task', taskId: string}
 *   | {ok: true, kind: 'bg', taskId: string, job: object, viaSession?: boolean}
 *   | {ok: false, reason: 'not-found'|'ambiguous', taskId: string,
 *      candidates?: Array<{id: string, label: string|null, command: string|null}>}}
 */
export function resolveStopTarget({ store, target, stopTask } = {}) {
  const id = typeof target === 'string' ? target.trim() : '';
  if (id === '') return { ok: false, reason: 'not-found', taskId: '' };
  if (typeof stopTask === 'function' && stopTask(id) === true) {
    return { ok: true, kind: 'task', taskId: id };
  }
  let job = null;
  try {
    job = store?.getBgJob?.(id) ?? null;
  } catch {
    job = null;
  }
  if (job !== null && job !== undefined && STOPPABLE_BG_STATES.includes(job.state)) {
    return { ok: true, kind: 'bg', taskId: id, job };
  }
  // L4：task_run 已结束（stopTask 未命中），用审计里的子代理会话反查它派出的后台任务。
  let sessionId = null;
  try {
    const event = store?.latestEventForRow?.('threads', id) ?? null;
    let detail = event?.detail_json ?? null;
    if (typeof detail === 'string') {
      try {
        detail = JSON.parse(detail);
      } catch {
        detail = null;
      }
    }
    if (detail !== null && typeof detail === 'object'
      && typeof detail.sessionId === 'string' && detail.sessionId !== '') {
      sessionId = detail.sessionId;
    }
  } catch {
    sessionId = null;
  }
  if (sessionId === null) return { ok: false, reason: 'not-found', taskId: id };
  let jobs = [];
  try {
    jobs = store.listBgJobs({ state: STOPPABLE_BG_STATES, sessionId, limit: 20 }) ?? [];
  } catch {
    jobs = [];
  }
  if (jobs.length === 1) {
    return { ok: true, kind: 'bg', taskId: id, job: jobs[0], viaSession: true };
  }
  if (jobs.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      taskId: id,
      candidates: jobs.map((candidate) => ({
        id: candidate.id,
        label: typeof candidate.label === 'string' && candidate.label !== '' ? candidate.label : null,
        command: Array.isArray(candidate.argv) ? candidate.argv.join(' ') : null,
      })),
    };
  }
  return { ok: false, reason: 'not-found', taskId: id };
}
