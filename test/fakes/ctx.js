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
          return this._value('compaction.compactRegion', {
            compactionId: `compact-fake-${this.calls.length}`,
            start,
            end,
          });
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
          return this._value('tokenMeter.measure', {
            logRevision: 1,
            baseline: null,
            surfaceDeltaTokens: 100,
            totalTokens: 1000,
            surfaceTokens: 1000,
            nodes: [],
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
