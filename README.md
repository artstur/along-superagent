# Along Agent

Along 的 Agent 工程基于 DSH Super Agent，负责接收聊天与授权健康摘要、维护目标和任务、治理长期记忆并调度维护工作。目标与任务经程序校验后自动生效，用户通过聊天纠正。目标 chat 只承载用户与 Agent 的直接对话。后台编排与执行记录保留审计，推荐通过任务结果交付。开发与验收使用隔离身份，不得通过正式配对伪装用户发言。

本地目录沿用 `along-superagent`，包名、DSH 插件 ID 与命令沿用 `dsh-superagent`；本文和 Along 文档中的 **Along Agent** 指本工程。远端仓库地址保持不变。

## 当前实现

从[文档导航](docs/README.md)查找目标聊天、健康跟进、OKX 私有报告和记忆的实现。每份阶段记录标明当时的验证范围。完整复盘、Skill 自动发布和回退属于待实现能力，详见[实施与验收](docs/along/003-implementation.md)。

## 本地运行

开发独立的本地环境时，与 Along 产品工程相邻放置：

```text
personal/
├── Along/                # iPhone / Web、HTTPS Host、启动器
└── along-superagent/     # Along Agent：DSH Runtime、业务服务与记忆
```

在相邻的 Along 工程中按[本地验证与手机连接](https://github.com/artstur/Along/blob/main/docs/stage-b-tech-design.md#本地验证与手机连接)安装依赖并运行 `npm run activate`。本地手机链路无需 GitHub 账号。Hy-Memory 需要另行配置，缺省时从 SQLite 读取有效记忆。

单独开发本工程：

```sh
pnpm install --frozen-lockfile
pnpm check    # 类型检查、全部测试、构建
```

依赖版本以 `package.json` 和锁文件为准；DSH 实际运行版本与兼容性验证见 [技术验证记录](docs/along/004-phase0-validation.md)。

## 文档与代码导航

| 代码位置 | 职责 |
| --- | --- |
| `src/along/` | Along 业务存储、事件、ChangeSet、健康跟进、记忆与定时维护 |
| `src/app/` | Runtime 装配、设置、会话和工具接线 |
| `src/core/`、`src/executor/` | 事件路由、授权、工单与 DSH 执行恢复 |
| `src/sources/` | Along、GitHub、飞书等输入来源 |
| `src/client/`、`locale/` | DSH 管理面板 |
| `tests/`、`scripts/` | 自动检查、合成验证与备份工具 |

## 来源与许可

本工程基于 DSH Super Agent 的研究原型，保留 GitHub / 飞书编程 Agent 能力和相关技术文档；不是 DeepSeek 官方产品。原型与 Along 扩展均需按实际环境验证，文档中的设计方向不代表全部已实现。

[MIT](LICENSE)，保留上游版权与许可。
