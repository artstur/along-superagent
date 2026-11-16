# Along Agent

Along 的 Mac 本地 Agent 工程，基于 DSH Super Agent 构建，负责接收聊天与授权健康摘要、维护目标与任务、治理长期记忆并调度维护工作。目标与任务经程序校验后自动生效，用户通过聊天纠正。

本地目录沿用 `along-superagent`，包名、DSH 插件 ID 与命令沿用 `dsh-superagent`；本文和 Along 文档中的 **Along Agent** 指本工程。远端仓库地址保持不变。

## 当前实现

| 能力 | 状态与验证入口 |
| --- | --- |
| 业务存储、配对、事件 Inbox、版本与执行记录 | 已实现；[阶段 A 集成](docs/along/005-phase-a-integration.md) |
| 聊天、自动建目标与聊天纠正 | 最小闭环已实现；[阶段 B 集成](docs/along/007-phase-b-integration.md) |
| 健康变化自动跟进 | 新协议、可靠补传、逐目标筛选与自动派工已实现；[Along 阶段 C](../Along/docs/stage-c-tech-design.md) |
| 长期记忆与明确忘记 | 已接入 Runtime、Worker 工具及 SQLite 降级；[记忆实施](docs/along/006-memory-implementation.md) |
| 定时记忆维护 | 已接入持久批次和 DSH 工单，默认 Mac 本地时间 03:00，可配置；[维护设计与验证](docs/along/008-scheduled-maintenance.md) |
| 完整复盘、Skill 自动发布及回退 | 待实现；[实施与验收](docs/along/003-implementation.md) |

代码实现和合成数据验证不代表完成真机验收。实际 iPhone 配对、后台执行机会、长期记忆质量、生产数据迁移与完整恢复的边界，以各阶段验收记录为准。

## 本地运行

与 Along 产品工程相邻放置：

```text
personal/
├── Along/                # iPhone / Web、HTTPS Host、启动器
└── along-superagent/     # Along Agent：DSH Runtime、业务服务与记忆
```

在 Along 工程安装依赖后运行 `npm run activate`。启动器构建两个工程并初始化专用的 `along-phone` profile；打印手机地址、指纹和配对码。详细配置与重跑规则见 [Along 本地验证与手机连接](../Along/docs/stage-b-tech-design.md#本地验证与手机连接)。Along 本地部署不要求 GitHub 账号；Hy-Memory 需要另行配置，未配置时降级读取 SQLite 中的有效记忆。

单独开发本工程：

```sh
pnpm install --frozen-lockfile
pnpm check    # 类型检查、全部测试、构建
```

依赖版本以 `package.json` 和锁文件为准；DSH 实际运行版本与兼容性验证见 [技术验证记录](docs/along/004-phase0-validation.md)。

## 文档与代码导航

- **产品决策与规范**：[决策记录](docs/along/000-decisions.md)、[系统架构](docs/along/001-architecture.md)、[记忆与技能](docs/along/002-memory-and-skills.md)。这些文件包含目标设计，不能把尚未实现的部分视为当前能力。
- **实现与验收**：[阶段与剩余范围](docs/along/003-implementation.md)，以及上表各模块的实施记录；旧记录中的版本与测试条数对应当时的快照。
- **DSH 核心机制**：[设计原则](docs/000-philosophy.md)、[领域模型](docs/001-domain.md)、[授权](docs/002-authorization.md)、[执行](docs/003-execution.md)、[提示词](docs/004-prompts.md)、[管理面板](docs/005-panel.md)、[部署运维](docs/006-deployment.md)、[代码架构](docs/007-architecture.md)、[来源扩展](docs/008-cookbook.md)。
- **GitHub / 飞书部署**：[SETUP.md](SETUP.md) 与[中文概览](docs/overview.zh-CN.md)，用于编程 Agent 场景；Along 本地部署使用上面的启动入口。

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
