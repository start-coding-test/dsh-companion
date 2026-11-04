# Embedding 可插拔（W4）

向量召回默认仍关闭（`vector.enabled: false`）。开启后，`vector.embedder` 决定查询与事实如何向量化；检索只比较**同一个 embedder id** 生成的向量，换模型不会拿旧向量硬算。配置键总表见 [README](../README.md#配置)，开启与排障步骤见 [usage.md](usage.md#向量召回可选)。

## 接口

```js
const embedder = createEmbedder(config.vector); // src/memory/embedders/index.js
// { id, dim, kind, async embed(texts), embedQuery?(texts), embedBackfill?(texts), busy?() }
```

- `id`：写入 `fact_vectors.embedder_id`，检索/回填都按它过滤。
- `dim`：向量维度；`remote` 在第一次响应前为 `0`（未知）。
- `embed(texts)`：批量，顺序与输入一致；失败抛 `EmbeddingUnavailable`（`code=EMBEDDING_UNAVAILABLE`）或 `EmbeddingTimeout`（`code=EMBEDDING_TIMEOUT`）。
- `embedQuery(texts)`：可选；查询侧专用（local 会加指令前缀）。
- `embedBackfill(texts)`：可选；回填侧专用，使用独立的 `vector.backfillTimeoutMs`（local 实现；未实现时回退 `embed`，仍受查询超时约束）。
- `busy()`：可选；同一 embedder 是否已有推理在跑。查询遇忙抛 `EmbeddingBusy`（`code=EMBEDDING_BUSY`，`transient=true`），由召回层立即退回 FTS。

召回层在 `embed` 失败时只记 metric 并退回纯 bigram FTS，不阻塞当前 turn。

## 三种实现

### `hash`（默认）

复用 `hashEmbed`：字符 bigram → FNV-1a → 桶 → L2 归一，维度取 `vector.dim`（默认 256），id 形如 `hash:256`。零依赖、可离线；**不是语义 embedding**，中文同义改写召回有限，仅作测试/零依赖兜底。

### `local`

动态 `import('@huggingface/transformers')`，不写进 `package.json` 依赖：

```bash
cd dsh-companion
npm i @huggingface/transformers   # 可选依赖，不装则 local 自动退回 FTS
```

默认模型 `Xenova/bge-small-zh-v1.5`（int8 ONNX，512 维），id 形如 `local:bge-small-zh-v1.5:512`。首次使用会从 Hugging Face 下载模型文件（约 24MB），之后从本地缓存加载；下载/加载/推理失败都只影响向量路，召回退回 FTS（见下节）。

- 查询默认加中文检索指令前缀 `为这个句子生成表示以用于检索相关文章：`，入库事实不加；`vector.prefixQuery: false` 可关闭。
- 选型：bge-small-zh-v1.5 为 MIT、约 24M 参数、512 维、int8 约 23.9MB，中文检索质量与体积平衡较好；备选 `Xenova/multilingual-e5-small`（384 维，需把 `vector.localModel` 改成它，id/维度自动跟随）。

#### local 的超时与异步预热（E-M1）

- **前台等待统一受 `vector.embedTimeoutMs` 约束**（默认 300ms）：等待模型加载完成（`ensureExtractor`）与单批推理各以它为上限。超时抛 `EmbeddingTimeout`（`code=EMBEDDING_TIMEOUT`，`transient=true`），当前 turn 直接走纯 FTS，不向用户抛错，同一 turn 内不重试。
- **加载是异步预热**：`apply` 启动后与每次 idle-probe 都会触发 `warmup()`，turn 路径不 `await`；加载期间召回被超时打断只退 FTS，回填探测到状态不是 `ready` 时本批跳过，只续接预热，不占用 idle-probe。
- **后台加载另有硬上限**：`loadTimeoutMs` 默认 `max(20 × embedTimeoutMs, 180s)`，只用于避免下载/初始化永久挂起，不参与 turn 等待；它不是配置键，测试/依赖注入可覆盖。
- **错误分类**：
  - 可选依赖未安装（`ERR_MODULE_NOT_FOUND` / `Cannot find module`，或模块不导出 `pipeline`）→ `fatal`：本进程停用 local、只尝试一次 import，召回保持纯 FTS；
  - 网络、超时、模型初始化失败、推理失败 → `transient`：按 1s / 2s / 4s / 8s 指数退避重试；连续第 5 次失败后进入 60s 长冷却，随后重新尝试，**不会一次失败即永久停用**。
- **诊断**：embedder 暴露只读 `status()`（`idle` / `loading` / `ready` / `backoff` / `fatal`）与 `state()`（连续尝试次数、下次重试时间、最近错误）；加载/预热日志按错误去重。`/状态` 在既有「向量」片段后追加回填超时与占用计数（见「失败降级与指标」），状态机本身仍只在日志与 `state()` 里。

#### 回填独立超时、推理单飞与加载单飞（E2-M1 / L2-3）

- **两套超时**：查询（`embed` / `embedQuery`）继续用 `vector.embedTimeoutMs`（默认 300ms）；回填走 `embedBackfill`，用 `vector.backfillTimeoutMs`（默认 30000ms，1–600000）。2C 上 bge-small int8 单批几十条约需 1–2s【估】，回填再用 300ms 必然超时，向量会一直填不满；拆开后查询仍保持 300ms 的快速降级。
- **批量默认 8**：`vector.backfillBatchSize` 默认从 50 降到 8（仍允许 1–50），按「条数 × 单条预算」控制单批耗时；50 条的批量只在显式调大配置时出现。
- **推理单飞**：local 维护 `inferenceInFlight`，同一时刻只允许一个底层推理。`inferenceInFlight` 只在底层真正 settle 后清空；`Promise.race` 超时只截断等待，不取消底层计算，因此超时批次未结束前仍算占用，下一次 idle-probe 不会起新批。
- **idle-probe 遇忙跳过**：`backfillVectors` 开跑前先 `busy()`，已占用就记 `vectorEmbedBusy` 并跳过本 tick，不排队、不叠加。
- **查询遇忙回退 FTS**：查询推理与回填共用同一把单飞锁；查询遇到占用直接抛 `EmbeddingBusy`（`transient`），召回层立即退回纯 FTS，不等待回填结束。回填路径遇忙同样记 `vectorEmbedBusy` 并留待下一 tick。
- **加载单飞（L2-3）**：`loadInFlight` 只在底层加载真正 settle 后清空；`doLoad` 内部不再套 `loadTimeoutMs`，`warmup()` 只由等待方用 `withTimeout(loadTimeoutMs)` 放弃等待，下载/ONNX 初始化继续。退避结束后的重试复用同一个未结束的 promise，不会并行起第二个加载；`status() === 'loading'` 以 `loadInFlight !== null` 为准。
- **指标**：回填超时记 `vectorBackfillTimeouts`，查询/回填遇占用记 `vectorEmbedBusy`；`/状态` 显示「回填超时 N·占用 M」。底层推理失败仍记 `vectorEmbedFailures`。
- **真机待办（D-4）**：在 2C 目标机器上实测**单条与批量推理耗时**，用实测值校准 `backfillTimeoutMs` 与 `backfillBatchSize`，并同时记录首次加载/下载耗时与 RSS 增量；测试目前只使用注入的 fake loader。

### `remote`

默认关闭。显式开启后把查询与回填事实批量 POST 到 `vector.remote.endpoint`：

```yaml
vector:
  enabled: true
  embedder: remote
  embedTimeoutMs: 300
  remote:
    enabled: true
    endpoint: https://embed.example.com/v1/embeddings
    apiKeyEnv: DSH_EMBED_API_KEY   # 存在时发 Authorization: Bearer <env 值>
    timeoutMs: 300
```

请求体 `{ model?, input: [text...] }`；响应接受 `{ data: [{ embedding: [...] }, ...] }`、`{ embeddings: [...] }` 或裸二维数组。id 取 `vector.embedderId`，未填时用 `remote:<host>`。

**隐私例外**：remote 会把记忆原文（回填时）和用户查询（召回时）发到第三方，7 天物理删除只覆盖本机 SQLite，管不到第三方日志。开启时启动日志会写 `warn`（含目标域名），`/状态` 显示 `remote:<域名>`；敏感/secret/墓碑事实在 embedding 前已被过滤，不会进入回填批次。

remote 不实现 local 的加载/推理单飞：每次查询或回填都是一次独立 HTTP 请求，受 `vector.remote.timeoutMs`（缺省继承 `embedTimeoutMs`）约束；回填批量仍受 `vector.backfillBatchSize` 限制。

## 存储与回填（schema v9）

- `fact_vectors` 在 v5→v6 新增 `embedder_id TEXT NOT NULL DEFAULT ''`，迁移把旧行填成 `hash:<dim>`；v6→v7 只给 `facts` 增加 `first_reneed_at` / `first_reneed_tier` / `reneed_kind`，不改 `fact_vectors` 结构；v7→v8 只给 `facts` 补 `same_context`、把 `reneed_kind` 合法值扩为含 `used`（幂等触发器校验）；v8→v9 只给 `facts` 补 `first_used_at` / `first_used_tier` / `used_same_context` 并加 `ix_facts_used`，同样不改 `fact_vectors` 与已有数据。
- 检索/混合检索只召回当前 `embedder_id`（以及当前维度）的行；换模型后旧向量自动失效。
- hash 写入路径同步投影；local/remote 是异步实现，写入时先不投影，由 idle-probe 每批 ≤ `vector.backfillBatchSize`（默认 8，上限 50）回填缺失/不匹配的活跃事实。回填使用 `vector.backfillTimeoutMs`（默认 30s），失败只记 metric，下次 tick 继续；同一 embedder 已有推理在跑时本 tick 跳过，不叠加。
- `/状态`：`向量：关`；开启后 `向量：开·dim 512·local:bge-small-zh-v1.5:512·已回填 N·最近命中 N·回填超时 N·占用 N`。remote 未显式 `enabled: true` 时仍显示「关」，也不会发隐私告警。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `vector.enabled` | `false` | 总开关；关闭时与 v0.3.2 路径逐字节一致 |
| `vector.embedder` | `"hash"` | `hash` / `local` / `remote` / `none` |
| `vector.dim` | `256` | hash 维度（8–4096）；local 由模型决定 |
| `vector.localModel` | `"Xenova/bge-small-zh-v1.5"` | local 模型 id |
| `vector.prefixQuery` | `true` | local 查询是否加指令前缀 |
| `vector.embedderId` | `""` | remote 的写入 id；空则 `remote:<host>` |
| `vector.embedTimeoutMs` | `300` | 前台查询 embedding 超时（1–60000ms）；local 同时覆盖「等待加载」与查询推理，remote 缺省继承 |
| `vector.backfillTimeoutMs` | `30000` | 回填推理的独立超时（1–600000ms）；只约束 idle-probe 回填，不影响查询 |
| `vector.backfillBatchSize` | `8` | 每次 idle-probe 回填上限（1–50） |
| `vector.remote.enabled` | `false` | remote 必须显式开启 |
| `vector.remote.endpoint` | `""` | remote 开启时必须是 http(s) URL |
| `vector.remote.apiKeyEnv` | `""` | 读取 API key 的环境变量名 |
| `vector.remote.timeoutMs` | `300` | remote 超时，缺省继承 `embedTimeoutMs` |

非法值（未知 embedder、endpoint 非 URL、维度/批量/超时越界等）在启动时抛 `ConfigError`。

## 失败降级与指标

- 召回/回填时 embedding 超时、transient 失败或 HTTP 错误：`vectorEmbedFailures` +1，本轮退回 FTS；同一 turn 不重试。回填超时另记 `vectorBackfillTimeouts`；查询或回填遇到已有推理在跑记 `vectorEmbedBusy`，查询立即回退 FTS。
- local 异步预热失败：`vectorEmbedLoadFailures` +1；其中 `fatal`（缺依赖）再记 `vectorEmbedFatal` +1，本进程停用 local。预热成功/失败日志按错误去重，恢复后复位。
- 回填成功：`vectorBackfilled` 累计条数，`/状态` 的「已回填」是本进程启动后的累计值。
- `/状态` 的向量片段：关闭时 `向量：关`；开启时 `向量：开·dim 512·local:bge-small-zh-v1.5:512·已回填 N·最近命中 N·回填超时 N·占用 N`（`remote` 显式开启时显示 `remote:<域名>`）。预热状态本身（`idle`/`loading`/`backoff`/`fatal`）只在日志与 `embedder.state()` 里，不在这行文字中。
- **与 remote 对齐**：remote 的超时取 `vector.remote.timeoutMs`，缺省继承 `embedTimeoutMs`；超时同样是 `EmbeddingTimeout`（transient），同样只在本轮退回 FTS、不向用户抛错。差别是 remote 没有后台加载与预热退避（也没有本地推理单飞）——每次召回/回填都重新请求，下一次调用即天然重试。
- 所有测试均不联网：local 用注入的 fake loader，remote 用注入的 fetch。

## 相关文档

- [README 配置表](../README.md#配置)与[向量召回](../README.md#向量召回可选)
- [使用手册：向量召回](usage.md#向量召回可选)
- [S0 标定流程](s0-calibration.md)（`facts.first_used_*` / `first_reneed_*` 埋点，与向量表无关）
- [已知技术债与真机联调清单](known-debt.md)
