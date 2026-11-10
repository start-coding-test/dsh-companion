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
- `未命中` 指分类置信度为 0（`classify` 回落 `share/0`），不等同于 `share` 关键词命中。
- 只读：不打开 `~/.dsh` 数据库、不写文件，输出全部走 stdout。
- 退出码：`0` 成功；`1` 文件读取失败；`2` 用法错误。

## 实现位置

- 规则与 `EVENT_TYPES`：`src/persona/emotion.js`
- 脚本：`scripts/emotion-report.mjs`
- 测试：`test/emotion-report.test.js`
