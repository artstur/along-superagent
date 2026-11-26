# Along 实施与验收

> 2026-11-26 核对第 1 节实现索引。后续章节定义阶段范围与验收条件，不代表全部已通过。设计起始基线为 `a07764f`；各阶段实际证据见对应实施记录。

## 1. 现有能力与扩展位置

| 能力 | 现状 | 依据与扩展位置 |
| --- | --- | --- |
| Trigger 与来源扩展 | Along Source、配对身份与事件接入已实现；手机真机联调待验 | [Trigger](../../src/core/model.ts)、[SourceKind](../../src/sources/kind.ts)、[阶段 A 集成](005-phase-a-integration.md) |
| 去重、订阅、评估与路由 | 复用核心机制，Along 聊天路由与绑定已接通 | [Intake](../../src/core/intake.ts)、[Engine](../../src/core/engine.ts) |
| Policy、Mandate 与主动模式 | 复用；Along 本地部署使用 `auto`，聊天、健康与维护规则已接通；默认核心配置仍为 `observe` | [授权设计](../002-authorization.md)、[Policy](../../src/policy.ts) |
| Ticket、Assignment、执行与恢复 | 复用 | [执行机制](../003-execution.md)、[DshExecutor](../../src/executor/dsh.ts) |
| Worker 工具 | 保留 `WORK_TOOLS`，Along 目标、任务与记忆工具已接入；维护工单使用专门工具 | [Sessions](../../src/app/sessions.ts) |
| Skill 注册 | 已有，不支持按派工固定版本 | `Sessions.bindSkills`、[Prompts](../../src/app/prompts.ts) |
| 非编程场景启动 | 已支持显式启用 Along、关闭 GitHub 的本地部署 | [Setup](../../src/app/setup.ts)、[Runtime](../../src/app/runtime.ts) |
| 定时调度 | 记忆维护已通过持久批次与 DSH 工单接通；完整复盘与 Skill 作业待实现 | 见 [定时维护](008-scheduled-maintenance.md) |
| 业务存储、完整对话、记忆治理 | 阶段 A 基座、记忆治理、Runtime/Worker 工具与定时记忆维护已实现 | 独立 Along 业务模块与 `along.sqlite`；[记忆实施记录](006-memory-implementation.md) |
| Hy-Memory | 固定版本安装、Runtime 生命周期装配及中文合成样例验证已实现；全面质量与长期稳定性待验收 | [Python 记忆进程与 Memory Service](006-memory-implementation.md) |
| 健康 7 类摘要 | 阶段 C 已接通新协议、前后台可靠队列、逐目标自动派工与跟进；真机后台机会待验收 | [HealthKitReader](https://github.com/artstur/Along/blob/main/ios/AlongHealth/Sources/HealthKitReader.swift) |
| 主动健康复查与任务结果 | 已支持按目标本地日期持久去重的复查；执行结果作为任务证据交付，不混入直接聊天 | [主动健康编排与任务结果](024-proactive-health-and-results.md) |
| 自动生效 | B 最小聊天闭环已实现：新协议页面自动展示已校验状态；旧 Host 兼容路径仍保留采用行为 | Along `docs/stage-b-tech-design.md`，Along Agent `tests/along-phaseB.spec.ts` |
| 个人工作区迁云 | 已实现专用单用户、显式目标范围的冷交接；不是普通配对或数据合并 | [冷交接范围、操作与验证](019-personal-cloud-handoff.md) |

Along Host 与 Along Agent 的新协议已有合成数据验证；真机配对、离线重连与后台机会是否通过，以相应版本的验收记录为准，不从 Agent 测试推定。[Along 当前技术链路](https://github.com/artstur/Along/blob/main/docs/goal-agent-flow.md)是兼容核对入口。

## 2. 阶段

第一期包含阶段 0 到 E。

### 阶段 0：前置验证（全部通过才进入 A）

1. 没有 GitHub 配置时 DSH 能启动。
2. `along` Source 在 `auto` 规则下能接单。
3. Worker 的环境变量、工作目录和提示词里没有 Kimi Token、配对 Token 和 DSH 管理凭证；`along.sqlite` 与 Hy-Memory 数据目录不在 Worker 工作目录内。
4. Worker 能用 DSH 已接入的 Skill 与工具，同时能调用新注册的 Along 工具。
5. 选定版本的 Hy-Memory 能在这台 Mac 上安装并常驻（含 Kuzu 依赖），配置的 LLM 与 Embedding 端点可用。
6. 定下批量作业的调度方式（进程内计时器或 launchd）。

阶段 0 已验证本地启动、Source 派工、真实 Worker / Skill / 探针工具和记忆接口冒烟，并选定进程内调度；没有据此标记整套架构通过。开发依赖与实际 Harness 版本不同，完整兼容性及 Hy-Memory 长时间常驻稳定性仍待补验。剩余技术验证和对应阶段见 [验证记录 §5](004-phase0-validation.md#5-剩余技术验证)。

### 阶段 A–E

| 阶段 | 范围 | 验收场景 |
| --- | --- | --- |
| A：骨架与数据契约 | `along.sqlite`、配对、事件 Inbox、对象版本、WorkLink、执行记录登记 | 重启后能查目标、任务和完整对话；重复事件不产生重复工作；每次 Worker 结束都有执行记录且未调用模型 |
| B：对话到自动维护 | `along.user_message`、目标与任务 Skill、ChangeSet 自动提交、按需通知；Along App 去掉采用按钮、待采用提案和目标编辑与删除入口 | 明确行动意图自动建目标，仅描述现象先回应，缺少意图才询问；聊天纠正生效；「改回去」通过新 ChangeSet 恢复；过时提交不覆盖当前意图；普通变化只展示，需要回答、近期安排有实质变化或执行受阻时才通知；跨目标安排遵守明确优先级和硬约束，其余由 Agent 协调 |
| C：健康持续跟进 | 7 类摘要接入新协议、按变化语义筛选、合并、主动规则、多目标拆分 | 重复、乱序、跨窗、修订、旧工单和暂停场景去向正确；一条摘要影响两个目标时各自提交，一个冲突不影响另一个 |
| D：长期记忆 | Hy-Memory 接入、记忆更新与带状态的历史上下文、批量提取、明确忘记、故障降级 | 达到 [记忆与技能 §2.5](002-memory-and-skills.md#25-阶段-d-的质量门槛) 的门槛；Hy-Memory 停掉时仍能用有效记忆规划 |
| E：批量复盘与 Skill | 定时作业、分组复盘、自动发布、版本固定、自动回退 | 每条执行记录有去向；新版本被下一轮实际使用，在途执行不变；错过周期只补跑一次；问题版本自动回退 |

阶段 B 同时更新 Along 的 README、`docs/goal-agent-flow.md` 和相关测试，使其描述迁移后的行为。

## 3. 追踪与回归

每个阶段都能追踪：事件 → 筛选理由 → DSH Decision / Ticket / Assignment → 读取的输入与业务版本 → 生效的 ChangeSet → 同步与后续聊天反馈。日志不记录 Token。

关键回归：

- 同一目标的两个工作不重复处理同一句话。
- 健康事件不恢复被人工停止的工单，不解除暂停。
- 首期不实现额外的健康授权撤回与关联历史清理流程（D15）；数据不可用、未同步与实际为零仍需区分。
- 一个目标的 ChangeSet 原子提交；多目标之间互不阻塞；跨目标协调遵守明确优先级和硬约束，无法同时满足硬约束时才询问（D14）。
- 手机重试不重复创建任务；手机离线时变更照常生效，重连可取回。
- 聊天纠正使旧结果失效。
- 「我想改善睡眠」自动建目标；「最近睡得不好」先回应，不直接建目标；明确意图后不再要求确认。
- 普通变化不触发系统通知；需要回答、近期安排有实质变化或执行受阻时才进入通知路径，并遵守通知权限与系统执行机会。
- 忘记记忆不删除历史聊天；撤回后在上下文装配、重启、重新提取旧聊天与重处理旧事件后均不复活。
- 忘记偏好不自动取消目标或重排现有任务，后续规划不再使用该偏好（D16）。
- 批量作业重跑不重复生成 Skill 版本，失败不影响用户结果。
- 不设置应用侧每日预算或累计模型用量上限，不以自设预算暂停工作（D17）。
- 备份恢复后历史、记忆与待处理工作一致。

## 4. 接管现有手机数据

先备份，以稳定 ID 幂等导入，核对目标、任务和对话，再切换写入入口。新旧适配器不同时消费同一输入；回退时停用新投递并保留数据库，不用清库回到旧模式。
