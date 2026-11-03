# dsh-companion

DSH 私人管家记忆插件（dsh-companion）。

## 状态

MVP 开发中（仓库骨架已就绪，插件入口与各功能模块按任务卡逐步落地）。

## 环境要求

- Node.js >= 24（使用内置 `node:sqlite`）
- 零第三方依赖，无需 `npm install`

## 测试

```bash
node --test
```

或：

```bash
npm test
```

## 设计文档

- 记忆系统设计：[../memory/docs/06-记忆系统设计.md](../memory/docs/06-记忆系统设计.md)
- 架构设计：[../memory/docs/05-架构设计.md](../memory/docs/05-架构设计.md)
- 风险与里程碑：[../memory/docs/07-风险与里程碑.md](../memory/docs/07-风险与里程碑.md)
- 开发规划：[../memory/开发规划-v2.md](../memory/开发规划-v2.md)

## 目录结构（当前）

```
dsh-companion/
├── package.json
├── .gitignore
├── README.md
└── test/
    └── smoke.test.js
```

> 插件入口 `src/index.js` 由后续任务卡（T3 配置校验与插件入口）创建。
