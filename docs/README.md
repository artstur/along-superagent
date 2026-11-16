# Along Agent 文档导航

文档分为当前代码说明、产品设计与阶段记录。验收记录中的日期、版本和测试条数描述当时快照；自动化成功不代表已完成 iPhone 真机或后台验收。

## 当前实现与开发

| 阅读目的 | 入口 |
| --- | --- |
| 从手机启动 Mac 本地服务 | [Along 一条命令激活](https://github.com/artstur/Along/blob/main/docs/stage-b-tech-design.md#一条命令激活本机服务2026-11-16)；在相邻 `Along/` 中执行 `npm run activate` |
| 理解进程、Router / Worker、健康跟进与长期记忆 | [当前运行图](along/009-current-runtime.md) |
| 核对已实现范围和待验项 | [实施与验收](along/003-implementation.md) 第 1 节 |
| 查找 DSH 核心模块与测试 | [代码架构索引](007-architecture.md)；Along 入口为 [`src/along/`](../src/along/) 和 [`src/app/runtime.ts`](../src/app/runtime.ts) |
| 继续本轮代码质量改进 | [代码质量与文档整理记录](along/010-code-quality.md)；双仓库 Goal Prompt 归属配套 Along 的 `docs/code-quality-goal.md` |

## 产品决策与目标设计

| 文档 | 用途 |
| --- | --- |
| [决策记录](along/000-decisions.md) | 已定决策与替代关系 |
| [目标架构](along/001-architecture.md) | 系统边界与后续设计，不能整体视为已实现 |
| [记忆与技能](along/002-memory-and-skills.md) | 治理契约、质量门槛与尚待实现的复盘 / Skill 能力 |
| [实施与验收](along/003-implementation.md) 第 2–4 节 | 阶段范围、验收标准与迁移要求 |

## 阶段实现与当时验收

这些文件保留方案、实现落点与后续补记，读当前链路时先从上方运行图进入。

- [阶段 0：技术验证](along/004-phase0-validation.md)
- [阶段 A：存储、事件与桥接](along/005-phase-a-integration.md)
- [阶段 D：长期记忆实施](along/006-memory-implementation.md)
- [阶段 B：聊天与自动生效](along/007-phase-b-integration.md)
- [定时记忆维护](along/008-scheduled-maintenance.md)

## 保留的 GitHub / 飞书编程 Agent 指南

这组指南面向编程 Agent 部署；Along 本地手机链路不需要 GitHub Agent 账号。

- 产品与安装：[中文功能概览](overview.zh-CN.md)、[安装引导](../SETUP.md)。
- 原理与行为：[设计原则](000-philosophy.md)、[领域模型](001-domain.md)、[授权](002-authorization.md)、[执行](003-execution.md)。
- 配置与运维：[提示词](004-prompts.md)、[管理面板](005-panel.md)、[部署](006-deployment.md)。
- 开发：[代码架构](007-architecture.md)、[来源扩展](008-cookbook.md)。
