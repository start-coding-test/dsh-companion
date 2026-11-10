# 情绪分类报告（只读）

`scripts/emotion-report.mjs` 把文本按行交给 `classify`，在终端输出每类事件的命中数、
置信度均值/最大值和未命中比例。用于检查关键词规则的可达性与误判，不参与运行时。

## 用法

```powershell
# 读文件
node scripts/emotion-report.mjs D:\tmp\chat.txt

# 从 stdin 读（PowerShell 管道）
Get-Content D:\tmp\chat.txt | node scripts/emotion-report.mjs -
```

报告示例：

```text
情绪分类报告：共 6 行（空行已跳过）
类型              命中   平均置信度   最高置信度
greeting            2        0.74        0.78
...
未命中：1/6（16.7%）
```

- 每一行是一条独立输入；空行/纯空白行跳过。
- `未命中` 指分类置信度为 0（`classify` 回落 `none/0`），不等同于某个关键词类型命中。
- 只读：不打开 `~/.dsh` 数据库、不写文件，输出全部走 stdout。
- 退出码：`0` 成功；`1` 文件读取失败；`2` 用法错误。

## 混淆矩阵与门槛

`test/fixtures/emotion-golden.jsonl` 是人工标注集：207 行，每行
`{"text": "...", "type": "..."}`，`type` 取 `EVENT_TYPES` 的 12 类之一或 `none`
（无事件）。标签按「人读到这句话会怎么理解」写，不迁就实现；用户点名的 19 句历史
误判全部在册，作为回归。

覆盖分布：`none` 68、`vent` 29、`blame` 19、`care` 14、`cold` 10、`goodnight` 10、
`share` 9、`thanks` 9、`greeting` 8、`reunion` 8、`conflict` 8、`comfort` 8、
`reassure` 7。

用法：

```powershell
node scripts/emotion-report.mjs --confusion test/fixtures/emotion-golden.jsonl
```

- 矩阵行=标注类型、列=预测类型（含 `none`），只列出现过的标签。
- 汇总：总体准确率、每类 precision/recall、`blame` 误报数、中性句误触发率。
- 退出码：达标 `0`，未达标 `1`，用法错误 `2`。同输入同输出，不写库、不联网。

发版门槛（`test/emotion-golden.test.js` 断言，失败时打印错例）：

| 指标 | 门槛 | v0.5.2 首版 | v0.5.2 定稿 |
| --- | --- | --- | --- |
| 总体准确率 | ≥ 85% | 179/207 = 86.47% | **206/207 = 99.52%** |
| `blame` 误报 | ≤ 2 句 | 0 句 | **0 句** |
| 中性句误触发率 | ≤ 10% | 2/68 = 2.94% | **0/68 = 0%** |

**口径说明**：首版数字是重写后的分类器第一次跑标注集的结果（写规则时没看过标注集）；
定稿数字是补齐句法缺口后同一集合的结果，属于**样本内**成绩——它说明规则覆盖了这批
标注，不等于线上分布。真实准确率在 11-13 中期用同一脚本跑评测库导出再算。

唯一剩余错例：`别硬撑，难受就说` 标注 `care`、判成 `vent`（这句话同时有关心与诉苦
两重语气，标注本身有争议）。
## 实现位置

- 规则与 `EVENT_TYPES`：`src/persona/emotion.js`
- 脚本：`scripts/emotion-report.mjs`
- 标注集：`test/fixtures/emotion-golden.jsonl`
- 测试：`test/emotion-report.test.js`、`test/emotion-golden.test.js`
