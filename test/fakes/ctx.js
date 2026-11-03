/**
 * FakeCtx：适配层的测试替身。
 *
 * - 覆盖适配层用到的 11 个平台面：now、logger、systemPrompt.section、on、
 *   interval、compaction.compactRegion、sessionController.createSession、
 *   sessionController.prompt、sessionController.cancel、
 *   workspaceRegistry.archiveSession、tokenMeter.measure。
 * - 手动时钟：构造参数 now（毫秒）指定起点，advance(ms) 推进。
 * - 调用记录：calls 数组，元素为 { method, args, at }。
 * - 失败注入：构造参数 fail 或 fail(key, error) 注入，key 使用点号路径，
 *   例如 "compaction.compactRegion"；whenIdle 的 key 为 "agent.whenIdle"。
 * - 返回值注入：构造参数 returns，按同样的点号 key 覆盖默认返回值。
 * - 缺失能力：构造参数 missing，例如 ["compaction", "sessionController"]；
 *   对应服务切片不会挂到 FakeCtx 上，用于验证 PlatformError。
 */
export class FakeCtx {
  /**
   * @param {{
   *   now?: number,
   *   missing?: string[],
   *   fail?: Record<string, Error>,
   *   returns?: Record<string, unknown>,
   * }} [options]
   */
  constructor(options = {}) {
    this._clock = options.now ?? Date.parse('2026-01-01T00:00:00.000Z');
    this._sessionSeq = 0;
    this.calls = [];
    this.logs = [];
    this.listeners = new Map();
    this.timers = [];
    this.sections = [];
    this.agents = [];
    this.sessions = new Map();
    this.returns = options.returns ?? {};
    this.failures = new Map(Object.entries(options.fail ?? {}));
    this.missing = new Set(options.missing ?? []);

    if (!this.missing.has('logger')) {
      this.logger = {};
      for (const level of ['debug', 'info', 'warn', 'error']) {
        this.logger[level] = (message, meta) => {
          this.logs.push({ level, message, meta });
          this._failAt(`logger.${level}`);
        };
      }
    }

    if (!this.missing.has('systemPrompt')) {
      this.systemPrompt = {
        section: (section) => {
          this._record('systemPrompt.section', [section]);
          this._failAt('systemPrompt.section');
          let disposed = false;
          const disposer = () => {
            disposed = true;
          };
          this.sections.push({
            section,
            disposer,
            get disposed() {
              return disposed;
            },
          });
          return disposer;
        },
      };
    }

    if (!this.missing.has('on')) {
      this.on = (event, listener) => {
        this._record('on', [event, listener]);
        this._failAt('on');
        const entry = { event, listener, disposed: false };
        const bucket = this.listeners.get(event) ?? [];
        bucket.push(entry);
        this.listeners.set(event, bucket);
        return () => {
          entry.disposed = true;
        };
      };
    }

    if (!this.missing.has('timer')) {
      this.interval = (callback, delay) => {
        this._record('interval', [callback, delay]);
        this._failAt('interval');
        const timer = { callback, delay, fires: 0, disposed: false };
        this.timers.push(timer);
        return () => {
          timer.disposed = true;
        };
      };
    }

    if (!this.missing.has('compaction')) {
      this.compaction = {
        compactRegion: (start, end, agent, signal) => {
          this._record('compaction.compactRegion', [start, end, agent, signal]);
          this._failAt('compaction.compactRegion');
          const fallback = {
            compactionId: `compact-fake-${this.calls.length}`,
            start,
            end,
          };
          const session = agent?.session;
          if (this.returns['compaction.compactRegion'] === undefined && this.sessions.has(session?.id)) {
            // 平台语义：压缩后原区间从 surface 消失；默认追加一个 seq 最大的替换节点。
            this.compactSession(session.id, start, end);
          }
          return this._value('compaction.compactRegion', fallback);
        },
      };
    }

    if (!this.missing.has('sessionController')) {
      this.sessionController = {};
      if (!this.missing.has('sessionController.createSession')) {
        this.sessionController.createSession = (request) => {
          this._record('sessionController.createSession', [request]);
          this._failAt('sessionController.createSession');
          this._sessionSeq += 1;
          const sessionId = request?.sessionId ?? `session-fake-${this._sessionSeq}`;
          const agent = {
            id: sessionId,
            session: { id: sessionId },
            whenIdle: async () => {
              this._record('agent.whenIdle', []);
              this._failAt('agent.whenIdle');
              return { id: sessionId };
            },
          };
          this.agents.push(agent);
          return this._value('sessionController.createSession', {
            agent,
            agentPreset: null,
          });
        };
      }
      if (!this.missing.has('sessionController.prompt')) {
        this.sessionController.prompt = (request, source) => {
          this._record('sessionController.prompt', [request, source]);
          this._failAt('sessionController.prompt');
          return this._value('sessionController.prompt', { accepted: true });
        };
      }
      if (!this.missing.has('sessionController.cancel')) {
        this.sessionController.cancel = (request) => {
          this._record('sessionController.cancel', [request]);
          this._failAt('sessionController.cancel');
          return this._value('sessionController.cancel', true);
        };
      }
    }

    if (!this.missing.has('workspaceRegistry')) {
      this.workspaceRegistry = {
        archiveSession: (sessionId, archiveOptions) => {
          this._record('workspaceRegistry.archiveSession', [sessionId, archiveOptions]);
          this._failAt('workspaceRegistry.archiveSession');
          return this._value('workspaceRegistry.archiveSession', {
            sessionId,
            archived: true,
            stopped: archiveOptions?.stopActivity === true,
          });
        },
      };
    }

    if (!this.missing.has('tokenMeter')) {
      this.tokenMeter = {
        measure: (session, requestHeader) => {
          this._record('tokenMeter.measure', [session, requestHeader]);
          this._failAt('tokenMeter.measure');
          const computed = this._measureOf(session);
          const override = this.returns['tokenMeter.measure'];
          if (override === undefined) return computed;
          // 测试可以改写总量（totalTokens），但 surface 节点仍来自真实会话；
          // 只有显式给了非空 nodes 时才整体替换。
          const merged = { ...computed, ...override };
          if (!Array.isArray(override.nodes) || override.nodes.length === 0) merged.nodes = computed.nodes;
          return merged;
        },
        estimateMessage: (message) => {
          this._record('tokenMeter.estimateMessage', [message]);
          this._failAt('tokenMeter.estimateMessage');
          return Math.max(1, Math.ceil(this._textOf(message).length / 2));
        },
      };
    }

    if (!this.missing.has('sessionQuery')) {
      this.sessionQuery = {
        readSurface: (sessionId) => {
          this._record('sessionQuery.readSurface', [sessionId]);
          this._failAt('sessionQuery.readSurface');
          const session = this.sessions.get(sessionId);
          if (session === undefined) return this._value('sessionQuery.readSurface', null);
          return this._value('sessionQuery.readSurface', {
            session: session.header,
            inheritedEventCount: 0,
            capturedThroughSeq: session.surface.nodes.at(-1) ?? null,
            events: session.events.filter((event) => event !== null),
            ...(session.eventsTruncated ? { truncated: true } : {}),
          });
        },
      };
    }
  }

  /**
   * 当前手动时钟（毫秒）。
   * @returns {number}
   */
  now() {
    return this._clock;
  }

  /**
   * 推进手动时钟。
   * @param {number} ms
   * @returns {number} 推进后的时钟
   */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new TypeError('advance(ms): ms must be a non-negative finite number');
    }
    this._clock += ms;
    return this._clock;
  }

  /**
   * 动态注入失败。
   * @param {string} key 点号路径，例如 "compaction.compactRegion"
   * @param {Error} [error]
   */
  fail(key, error = new Error(`injected failure: ${key}`)) {
    this.failures.set(key, error);
  }

  /**
   * 触发已注册的周期回调（跳过已 dispose 的 timer）。
   * @param {number} [times]
   * @returns {Promise<Array<{delay:number, fires:number, disposed:boolean}>>}
   */
  async fireTimers(times = 1) {
    for (let round = 0; round < times; round += 1) {
      for (const timer of this.timers) {
        if (timer.disposed) continue;
        timer.fires += 1;
        await timer.callback();
      }
    }
    return this.timers.map(({ delay, fires, disposed }) => ({ delay, fires, disposed }));
  }

  /**
   * 按注册顺序执行 waterfall：监听器拿到 (payload, next)，最后一个
   * next 返回 fallback(payload) 或 fallback。
   * @param {string} event
   * @param {object} payload
   * @param {object|Function} [fallback]
   * @returns {Promise<object>}
   */
  async dispatch(event, payload, fallback) {
    const entries = (this.listeners.get(event) ?? []).filter((entry) => !entry.disposed);
    let index = -1;
    const next = async () => {
      index += 1;
      if (index < entries.length) return entries[index].listener(payload, next);
      return typeof fallback === 'function' ? fallback(payload) : fallback;
    };
    return next();
  }

  /**
   * 按方法名筛选调用记录。
   * @param {string} method
   * @returns {Array<{method:string,args:unknown[],at:number}>}
   */
  callsOf(method) {
    return this.calls.filter((call) => call.method === method);
  }

  // ------------------------------------------------------- 会话 / surface 仿真

  /**
   * 登记一个假会话：`surface.nodes` + 事件日志 + `deriveEventMessage`。
   *
   * 只给 nodes 不给 events 时，`readSurface` 会把这些节点映射成 `null`
   * （模拟「surface 只有 seq、正文缺失」的降级场景）。
   *
   * @param {{id?: string, nodes?: number[], header?: object, events?: object[]}} [options]
   * @returns {object} 会话对象
   */
  addSession(options = {}) {
    this._sessionSeq += 1;
    const id = options.id ?? `session-fake-${this._sessionSeq}`;
    const session = {
      id,
      header: { version: 4, id, isSeeded: false, ...(options.header ?? {}) },
      surface: { nodes: [] },
      bySeq: new Map(),
      events: [],
      deriveEventMessage: (event) => FakeCtx.deriveEventMessage(event),
    };
    this.sessions.set(id, session);
    for (const seq of options.nodes ?? []) session.surface.nodes.push(Number(seq));
    for (const event of options.events ?? []) this.appendEvent(id, event);
    return session;
  }

  /**
   * 追加一条 surface 事件（不触发 session/event 监听器）。
   * @param {string} sessionId
   * @param {object} event {type, data, seq?}
   * @returns {object} 存储后的事件（带 seq）
   */
  appendEvent(sessionId, event) {
    const session = this._session(sessionId);
    const seq = Number.isFinite(event?.seq) ? Number(event.seq) : this._maxSeq(session) + 1;
    const stored = { ...event, seq };
    session.bySeq.set(seq, stored);
    session.events.push(stored);
    if (!session.surface.nodes.includes(seq)) session.surface.nodes.push(seq);
    return stored;
  }

  /**
   * 追加事件并触发 `session/event` 监听器（platform emit 语义）。
   * @param {string} sessionId
   * @param {object} event
   * @returns {object} 存储后的事件
   */
  emitSessionEvent(sessionId, event) {
    const session = this._session(sessionId);
    const stored = this.appendEvent(sessionId, event);
    for (const entry of this.listeners.get('session/event') ?? []) {
      if (!entry.disposed) entry.listener(session, stored);
    }
    return stored;
  }

  /**
   * 模拟平台压缩：把 [start, end] 从 surface 移除。
   * - 默认（平台真实语义）：追加一个 seq 最大的替换节点；
   * - `remap` 数组：剩余节点按位置重编号（模拟「压缩后 seq 重映射」）。
   * @param {string} sessionId
   * @param {number} start
   * @param {number} end
   * @param {{remap?: number[], text?: string}} [options]
   * @returns {{removed: number[], replacement: object|null, nodes: number[]}}
   */
  compactSession(sessionId, start, end, options = {}) {
    const session = this._session(sessionId);
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(start);
    const endIdx = nodes.indexOf(end);
    if (startIdx < 0 || endIdx < startIdx) {
      throw new Error('compactSession: region is not in the current surface');
    }
    const removed = nodes.splice(startIdx, endIdx - startIdx + 1);
    if (Array.isArray(options.remap)) {
      if (options.remap.length !== nodes.length) {
        throw new Error('compactSession: remap length must match the remaining nodes');
      }
      const rekeyed = new Map();
      nodes.forEach((seq, index) => {
        const next = Number(options.remap[index]);
        const event = session.bySeq.get(seq);
        nodes[index] = next;
        if (event !== undefined) rekeyed.set(next, { ...event, seq: next });
      });
      session.bySeq = rekeyed;
      return { removed, replacement: null, nodes: [...nodes] };
    }
    const seq = this._maxSeq(session) + 1;
    const replacement = {
      seq,
      type: 'user/message',
      data: {
        role: 'user',
        id: `compact-${seq}`,
        source: { kind: 'system', reason: 'compaction' },
        content: [{ type: 'text', text: options.text ?? '[compacted]' }],
      },
    };
    session.bySeq.set(seq, replacement);
    nodes.push(seq);
    return { removed, replacement, nodes: [...nodes] };
  }

  /**
   * 平台 deriveEventMessage 的等价实现（用于 index 的增量索引）。
   * @param {object} event
   * @returns {object|null}
   */
  static deriveEventMessage(event) {
    if (event === null || typeof event !== 'object') return null;
    const data = event.data ?? {};
    const message = event.type === 'user/message' ? data : data.message ?? null;
    if (message === null) return null;
    if (Array.isArray(message.content) && message.content.length === 0) return null;
    return message;
  }

  _session(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`unknown fake session: ${sessionId}`);
    return session;
  }

  _maxSeq(session) {
    let max = 0;
    for (const seq of session.surface.nodes) max = Math.max(max, Number(seq) || 0);
    for (const seq of session.bySeq.keys()) max = Math.max(max, Number(seq) || 0);
    return max;
  }

  _surfaceEvents(session) {
    return session.surface.nodes.map((seq) => session.bySeq.get(seq) ?? null);
  }

  _measureOf(session) {
    if (session === null || typeof session !== 'object' || !this.sessions.has(session.id)) {
      return {
        logRevision: 1,
        baseline: null,
        surfaceDeltaTokens: 100,
        totalTokens: 1000,
        surfaceTokens: 1000,
        nodes: [],
      };
    }
    const nodes = this._surfaceEvents(session).map((event) => {
      const message = event === null ? null : FakeCtx.deriveEventMessage(event);
      const tokens = Math.max(1, Math.ceil((message === null ? '' : FakeCtx.textOf(message)).length / 2));
      return { seq: event?.seq ?? 0, tokens, heuristicTokens: tokens };
    });
    const total = nodes.reduce((sum, node) => sum + node.tokens, 0);
    return {
      logRevision: nodes.length,
      baseline: null,
      surfaceDeltaTokens: 0,
      totalTokens: total,
      surfaceTokens: total,
      nodes,
    };
  }

  static textOf(message) {
    if (typeof message === 'string') return message;
    const blocks = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message)
        ? message
        : [];
    return blocks
      .filter((block) => block !== null && typeof block === 'object')
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }

  _record(method, args) {
    this.calls.push({ method, args, at: this._clock });
  }

  _failAt(key) {
    const error = this.failures.get(key);
    if (error !== undefined) throw error;
  }

  _value(key, fallback) {
    return Object.hasOwn(this.returns, key) ? this.returns[key] : fallback;
  }
}
