# Along 实施与验收

> v0.5，2026-11-15。实施建议与验收条件，不是已执行结果或排期承诺。源码核对基线：本 fork `8c32a9d`；实施前重新核对。

## 1. 现有能力与扩展位置

| 能力 | 现状 | 依据与扩展位置 |
| --- | --- | --- |
| Trigger 与来源扩展 | 已有，新增 Along Source | [Trigger](../../src/core/model.ts)、[SourceKind](../../src/sources/kind.ts)、[接入示例](../008-cookbook.md) |
| 去重、订阅、评估与路由 | 已有，工作线程语义需适配 | [Intake](../../src/core/intake.ts)、[Engine](../../src/core/engine.ts) |
| Policy、Mandate 与主动模式 | 复用；默认 `observe`，需新增 Along `auto` 规则 | [授权设计](../002-authorization.md)、[Policy](../../src/policy.ts) |
| Ticket、Assignment、执行与恢复 | 复用 | [执行机制](../003-execution.md)、[DshExecutor](../../src/executor/dsh.ts) |
| Worker 工具 | 已有 `WORK_TOOLS`，保留并追加 Along 工具 | [Sessions](../../src/app/sessions.ts) |
| Skill 注册 | 已有，不支持按派工固定版本 | `Sessions.bindSkills`、[Prompts](../../src/app/prompts.ts) |
| 非编程场景启动 | 需适配；Setup 仍解析 GitHub 部署 | [Setup](../../src/app/setup.ts)、[Runtime](../../src/app/runtime.ts) |
| 定时调度 | 没有，需新增 | 见 [记忆与技能 §4](002-memory-and-skills.md#4-定时批量作业) |
| 业务存储、完整对话、记忆治理 | 新增 | 独立 Along 业务模块与 `along.sqlite` |
| Hy-Memory | 新增 | Python 记忆进程与 Memory Service 适配器 |
| 健康 7 类摘要 | Along 已有，需接入新协议 | [HealthKitReader](../../../Along/ios/AlongHealth/Sources/HealthKitReader.swift) |
| 自动生效 | Along 现有采用流程需迁移 | Along Host、共享校验、页面、文档与测试 |

Along Host 已有 DSH 上游调用协议，但不能据此推定当前 fork 已实现对应服务，两个仓库的接口要实际联调。[Along 当前技术链路](../../../Along/docs/goal-agent-flow.md)是兼容核对入口。

## 2. 阶段

第一期包含阶段 0 到 E。

### 阶段 0：前置验证（全部通过才进入 A）

1. 没有 GitHub 配置时 DSH 能启动。
2. `along` Source 在 `auto` 规则下能接单。
3. Worker 的环境变量、工作目录和提示词里没有 Kimi Token、配对 Token 和 DSH 管理凭证；`along.sqlite` 与 Hy-Memory 数据目录不在 Worker 工作目录内。
4. Worker 能用 DSH 已接入的 Skill 与工具，同时能调用新注册的 Along 工具。
5. 选定版本的 Hy-Memory 能在这台 Mac 上安装并常驻（含 Kuzu 依赖），配置的 LLM 与 Embedding 端点可用。
6. 定下批量作业的调度方式（进程内计时器或 launchd）。

### 阶段 A–E

| 阶段 | 范围 | 验收场景 |
| --- | --- | --- |
| A：骨架与数据契约 | `along.sqlite`、配对、事件 Inbox、对象版本、WorkLink、执行记录登记 | 重启后能查目标、任务和完整对话；重复事件不产生重复工作；每次 Worker 结束都有执行记录且未调用模型 |
| B：对话到自动维护 | `along.user_message`、目标与任务 Skill、ChangeSet 自动提交、按需通知；Along App 去掉采用按钮、待采用提案和目标编辑与删除入口 | 明确行动意图自动建目标，仅描述现象先回应，缺少意图才询问；聊天纠正生效；「改回去」通过新 ChangeSet 恢复；过时提交不覆盖当前意图；普通变化只展示，需要回答、近期安排有实质变化或执行受阻时才通知 |
| C：健康持续跟进 | 7 类摘要接入新协议、按变化语义筛选、合并、主动规则、多目标拆分 | 重复、乱序、跨窗、修订、旧工单和暂停场景去向正确；一条摘要影响两个目标时各自提交，一个冲突不影响另一个 |
| D：长期记忆 | Hy-Memory 接入、治理状态、批量提取、即时删除、故障降级 | 达到 [记忆与技能 §2.5](002-memory-and-skills.md#25-阶段-d-的质量门槛) 的门槛；Hy-Memory 停掉时仍能用有效记忆规划 |
| E：批量复盘与 Skill | 定时作业、分组复盘、自动发布、版本固定、自动回退 | 每条执行记录有去向；新版本被下一轮实际使用，在途执行不变；错过周期只补跑一次；问题版本自动回退 |

阶段 B 同时更新 Along 的 README、`docs/goal-agent-flow.md` 和相关测试，使其描述迁移后的行为。

## 3. 追踪与回归

每个阶段都能追踪：事件 → 筛选理由 → DSH Decision / Ticket / Assignment → 读取的输入与业务版本 → 生效的 ChangeSet → 同步与后续聊天反馈。日志不记录 Token。

关键回归：

- 同一目标的两个工作不重复处理同一句话。
- 健康事件不恢复被人工停止的工单，不解除暂停。
- 授权撤回先于下一次读数生效。
- 一个目标的 ChangeSet 原子提交；多目标之间互不阻塞。
- 手机重试不重复创建任务；手机离线时变更照常生效，重连可取回。
- 聊天纠正使旧结果失效。
- 「我想改善睡眠」自动建目标；「最近睡得不好」先回应，不直接建目标；明确意图后不再要求确认。
- 普通变化不触发系统通知；需要回答、近期安排有实质变化或执行受阻时才进入通知路径，并遵守通知权限与系统执行机会。
- 忘记记忆不删除历史聊天；撤回后在上下文装配、重启、重新提取旧聊天与重处理旧事件后均不复活。
- 批量作业重跑不重复生成 Skill 版本，失败不影响用户结果。
- 备份恢复后历史、记忆与待处理工作一致。

## 4. 接管现有手机数据

先备份，以稳定 ID 幂等导入，核对目标、任务和对话，再切换写入入口。新旧适配器不同时消费同一输入；回退时停用新投递并保留数据库，不用清库回到旧模式。
