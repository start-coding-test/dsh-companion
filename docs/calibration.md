# 首次安装自检（calibration）

目标：安装时实测机器与模型上下文，给出一份**建议配置**，减少「默认 32K 工作记忆在
小内存机器上吃紧、在 200K 上下文模型上又太保守」的问题。自检只读测量，不合并配置、
不写人格卡、不写记忆库。

## 两种运行方式

### 方式 A：headless 一键运行（推荐）

```bash
cd dsh-companion
node scripts/calibrate/run.mjs
```

脚本会：

1. 定位 DSH CLI（`--dsh` / `DSH_CLI` / `DSH_INSTALL_DIR` / 常见安装目录 / `PATH`）；
2. 用 `.data/calibrate-home` 作为临时 `DSH_HOME`，叠加
   `scripts/calibrate/calibrate.patch.yml` 跑一次 headless 会话；
3. 由插件在进程内测量并写出：
   - `.data/calibration.json`：测量明细 + 建议值 + provenance；
   - `.data/config.suggested.yml`：可人工复制的建议配置；
4. 打印两个文件路径与摘要。

临时 home 默认清理；加 `--keep-home` 保留便于排查。模型凭据缺失时 DSH 会话可能
失败，但只要插件已装载，机器/版本部分仍会写出；此时脚本会提示手工运行方式，
必要时退出码为 `2`。

### 方式 B：挂进现有 profile

把下面片段加进你的 profile `cordis.patch.yml`（路径按实际仓库位置改）：

```yaml
- insert:
    - id: dsh-companion-calibrate
      name: '<repo>/dsh-companion/scripts/calibrate/calibrate-plugin.js'
      config:
        contextWindowTokens: 128000
```

重载 profile 后正常聊一句，插件会在前几个 `agent/pre-step` 采集 `tokenMeter` 节点数
（surface 尚空时自动重试），并写 `.data/calibration.json` 与 `.data/config.suggested.yml`。`contextWindowTokens`
是平台未上报时的兜底，按你的模型窗口修改。

也可以不挂 profile，直接对任意 headless 会话叠加：

```bash
dsh --profile headless --patch "<repo>/dsh-companion/scripts/calibrate/calibrate.patch.yml" "Reply with exactly: ok"
```

## 建议公式

设 `C = contextWindowTokens`、`M = totalmemBytes`：

| 键 | 建议值 |
| --- | --- |
| `memoryBudget`（提示值，非配置键） | `max(0, min(userLimitBytes ?? ∞, M × 0.75 − 512MiB))` |
| `workingMemoryTokens` | `min(32000, C × 0.25)`，向下取整到 1000 |
| `compactAtTokens` | `round(0.75 × workingMemoryTokens)` |
| `compactHardTokens` | `min(round(1.25 × workingMemoryTokens), round(C × 0.6))` |
| `retainTokens` | `6144` |
| `threadMaxActive` | `6` |
| `threadIdleDays` | `14` |
| `proactiveDailyCap` | `3` |
| `quietStart` / `quietEnd` | `"23:00"` / `"08:00"` |
| `timezone` | 传入值，否则用进程默认 IANA 时区 |
| `purgeAfterDays` | `7` |
| `dbPath` | `./.data/companion.db` |
| `rssWarnGiB` | `max(0.01, round2(min(2.95, 0.88 × B)))` |
| `rssStopGiB` | `max(round2(rssWarnGiB + 0.01), round2(min(3.0, 0.96 × B)))` |
| `rssMainOnlyGiB` | `max(round2(rssStopGiB + 0.01), round2(min(3.15, 1.04 × B)))` |

其中 `B = memoryBudget / 1GiB`（即上面的内存预算换算成 GiB）；三档随内存预算缩放、在
`2.95/3.0/3.15` 封顶，并强制满足 `0 < rssWarnGiB < rssStopGiB < rssMainOnlyGiB`。
例如 2C4G：`M = 4GiB` → `B = max(0, 4×0.75−0.5) = 2.5GiB`，自检直接建议
`rssWarnGiB: 2.2`、`rssStopGiB: 2.4`、`rssMainOnlyGiB: 2.6`。三档都不要超过总内存
75%（4GiB 即 3.0GiB）：超过时进程可能在降级逻辑生效前就被 OOM kill。

`memoryBudget` 只是内存预算提示（字节），不会写进 YAML 键，避免被配置层当作未知键。
`userLimitBytes` 对应你对 DSH/本插件内存占用的硬上限；未设置时只看机器总内存。

### 告警线

- 内存告警线就是 `min(user_limit, totalmem × 0.75 − 512MiB)`：RSS 中位数接近或超过
  该值时，建议降低 `workingMemoryTokens`、缩短保留尾部，或把 `dbPath` 移到更轻的
  运行环境。自检会用这条预算线推算 `rssWarnGiB`/`rssStopGiB`/`rssMainOnlyGiB`
  三个建议值；手工调整时保持三者严格递增，且 `rssMainOnlyGiB` 不超过总内存 75%。
- `contextWindowTokens` 小于约 `33K` 时，公式可能给出
  `compactAtTokens < retainTokens`，属于「模型窗口太小、MVP 不推荐」的情况。此时
  不要直接抄建议文件；升级模型窗口，或手工把四档 token 调成满足
  `0 < retainTokens < compactAtTokens < workingMemoryTokens < compactHardTokens` 的值。

## 误差口径

- **RSS**：先做一次 warm-up，再取 3 次 `process.memoryUsage().rss` 的中位数，单位
  bytes；单次读数受 GC、页面缓存与 Electron 共享内存影响，不应当作精确峰值。
- **15% 容差**：同一台机器重复自检，RSS 中位数与建议值允许约 ±15% 的波动；超过
  15% 时再看 `calibration.json` 的 `rssSamples`，确认不是一次性尖峰。
- **上下文窗口**：优先取平台 `sessionProjections` 的 `contextPressure.contextWindow`；
  取不到时用 patch 里的 `contextWindowTokens`；再取不到用 128000 兜底，并在
  `measurement.contextWindow.source` 标出来源。
- **token 建议值**：token 是模型侧计量，不承诺与平台压缩阈值逐 token 对齐；自检给的是
  安全起点，不是性能上限。

## suggested 文件的 provenance

`config.suggested.yml` 头部注释与 `calibration.json` 的 `provenance` 记录：

- `# generated_at`：生成时间（ISO 8601）；
- `# source:`：node / electron / dsh 版本与 `rss_median`（bytes）；
- `# measured:`：totalmem、cpus、contextWindow；
- `# memoryBudget:`：公式与结果（bytes，仅提示）。

`calibration.json` 还保留 `measurement` 原始明细（版本、SQLite、CPU、RSS 样本、
tokenMeter 节点数、contextWindow 来源）与 `merged: false`，方便复审。

## 不自动合并

自检**不会**：

- 修改 `config.yml`、profile 或任何用户配置；
- 写 `persona.json` / 人格卡；
- 写记忆库、会话或 provider 设置。

建议文件是起点：先对比 `config.yml` 里的现值，再人工复制需要的键。若你的环境有
固定内存配额或特殊模型路由，以你的实际约束为准。

## 平台限制

- 只在 DSH 进程内测量；纯 Node 脚本（不挂插件）拿不到 `tokenMeter` 与
  `sessionProjections`，`tokenMeter` 会显示 `n/a`。
- RSS 包含 Electron/V8/共享库，不等于插件独占内存；macOS/Linux 的计数口径也与
  Windows 略有差异。
- `contextWindowTokens` 若平台未上报，只能用 patch 配置兜底；请按实际模型修改，
  不要假设所有模型都是 128K。
- 自检不测试模型质量、网络延迟或磁盘 I/O；这些不影响本文件的 16 个配置键建议
  （含 RSS 三档）。
- `node:sqlite` 不可用时 `measurement.sqlite.ok=false`，插件本身仍可运行，但数据库
  相关功能会降级；这属于环境问题，不是自检失败。
