# Embedding 可插拔（W4）

向量召回默认仍关闭（`vector.enabled: false`）。开启后，`vector.embedder` 决定查询与事实如何向量化；检索只比较**同一个 embedder id** 生成的向量，换模型不会拿旧向量硬算。

## 接口

```js
const embedder = createEmbedder(config.vector); // src/memory/embedders/index.js
// { id, dim, kind, async embed(texts) -> Float32Array[], embedQuery?(texts) }
```

- `id`：写入 `fact_vectors.embedder_id`，检索/回填都按它过滤。
- `dim`：向量维度；`remote` 在第一次响应前为 `0`（未知）。
- `embed(texts)`：批量，顺序与输入一致；失败抛 `EmbeddingUnavailable`（`code=EMBEDDING_UNAVAILABLE`）或 `EmbeddingTimeout`（`code=EMBEDDING_TIMEOUT`）。
- `embedQuery(texts)`：可选；查询侧专用（local 会加指令前缀）。

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

默认模型 `Xenova/bge-small-zh-v1.5`（int8 ONNX，512 维），id 形如 `local:bge-small-zh-v1.5:512`。首次使用会从 Hugging Face 下载模型文件；下载/加载失败抛 `EmbeddingUnavailable`，召回退回 FTS。

- 查询默认加中文检索指令前缀 `为这个句子生成表示以用于检索相关文章：`，入库事实不加；`vector.prefixQuery: false` 可关闭。
- 选型：bge-small-zh-v1.5 为 MIT、约 24M 参数、512 维、int8 约 23.9MB，中文检索质量与体积平衡较好；备选 `Xenova/multilingual-e5-small`（384 维，需把 `vector.localModel` 改成它，id/维度自动跟随）。

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

## 存储与回填（schema v6）

- `fact_vectors` 新增 `embedder_id TEXT NOT NULL DEFAULT ''`；v5→v6 迁移把旧行填成 `hash:<dim>`。
- 检索/混合检索只召回当前 `embedder_id`（以及当前维度）的行；换模型后旧向量自动失效。
- hash 写入路径同步投影；local/remote 是异步实现，写入时先不投影，由 idle-probe 每批 ≤ `vector.backfillBatchSize`（默认 50）回填缺失/不匹配的活跃事实。回填失败只记 metric，下次 tick 继续。
- `/状态`：`向量：关`；开启后 `向量：开·dim 512·local:bge-small-zh-v1.5:512·已回填 N·最近命中 N`。remote 未显式 `enabled: true` 时仍显示「关」，也不会发隐私告警。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `vector.enabled` | `false` | 总开关；关闭时与 v0.3.2 路径逐字节一致 |
| `vector.embedder` | `"hash"` | `hash` / `local` / `remote` / `none` |
| `vector.dim` | `256` | hash 维度（8–4096）；local 由模型决定 |
| `vector.localModel` | `"Xenova/bge-small-zh-v1.5"` | local 模型 id |
| `vector.prefixQuery` | `true` | local 查询是否加指令前缀 |
| `vector.embedderId` | `""` | remote 的写入 id；空则 `remote:<host>` |
| `vector.embedTimeoutMs` | `300` | 默认 embedding 超时（1–60000ms） |
| `vector.backfillBatchSize` | `50` | 每次 idle-probe 回填上限（1–50） |
| `vector.remote.enabled` | `false` | remote 必须显式开启 |
| `vector.remote.endpoint` | `""` | remote 开启时必须是 http(s) URL |
| `vector.remote.apiKeyEnv` | `""` | 读取 API key 的环境变量名 |
| `vector.remote.timeoutMs` | `300` | remote 超时，缺省继承 `embedTimeoutMs` |

非法值（未知 embedder、endpoint 非 URL、维度/批量越界等）在启动时抛 `ConfigError`。

## 失败降级与指标

- embedding 超时/未安装/HTTP 错误：`vectorEmbedFailures` +1，本轮退回 FTS；同一 turn 不重试。
- 回填成功：`vectorBackfilled` 累计条数，`/状态` 的「已回填」是本进程启动后的累计值。
- 所有测试均不联网：local 用注入的 fake loader，remote 用注入的 fetch。
