# 健康汇总 context 兼容扩展（本轮固定边界）

沿 schema_version 1 / summarizer_version along-health-v1 的7种既有 scalar summary新增可选 `context`，标量value/unit/statistic/window保持。它只承载原生已经在contextReview授权下计算的汇总，没有HK样本、样本ID、逐条原始记录。

- type sleep: context允许 `windowDays`(7), `daysWithData`(0..7), `averageThroughAt` ISO时间, `latestWindowOpen`布尔, `averageMinutes`/`latestNightMinutes`/`previousNightMinutes` 非负有限分钟（可省略/空）, `latestSleepStartAt`/`latestWakeAt` ISO时间（可省略/空）。这些来自sleepSummary原字段。窗的结束是统计边界，不是实际醒来；latestNight与previousNight各有标签。旧value回退previousNight的逻辑保留，缺时段就保持未知。
- type workout: context允许 `windowDays`(28), `weekStartAt` ISO时间, `todayMinutes`/`todayCount`/`yesterdayMinutes` 非负有限汇总, `latestWorkoutAt` ISO时间, `patterns`最多40项，每项仅activity/weekday/hour/count/recentCount/averageMinutes/lastObservedAt。保持原活动类别（包括healthkit_activity_<number>），不发HK样本。原汇总字段保持。
- 其他type不带context。context类型/字段严格白名单且校验合理window/timestamp/非负数边界。旧事件完全兼容，无context不伪造上下文。
- Native仅当已获contextReview授权、对应metric已选择，才把对应sleepSummary/workoutSummary白名单字段加入该metric的context。无需新增入口、开关。context参与现有content去重；只是metric_version变化仍不发。
- Agent在health_summary增加nullable context JSON，schema16兼容迁移；summary读工具暴露同scope的context并解释观测语义。相关context实质变化可进入复评，即使value相同；旧value变化阈值仍可用。宿主验证时间/权限/版本，Agent结合目标决定keep或最小调整。
- SP明确时长不证明早睡、统计窗未结束不否定已经观测的睡眠时段、聚合不证明人任务完成、未知不判正常。保留实际用户明确约束；来源是Agent推定的准备时刻可在用户授权和新证据内调整，不把已存在时间自动当作用户硬约束。

PR边界：客户端PR负责Native投递context、Swift真实源码测试及产物/版本；Agent PR负责schema/存储/工具/变化判定/语义SP及回归。Agent先兼容上线，client同步后上机。UI/OKX无改动。

The bound health read also exposes the same-goal, same-input previous evaluated facts, with evaluation time and per-summary currentness, so a new Worker can compare the changed timing without reconstructing an unbounded chat. No previous judgement is treated as current fact.

## 正式前台验收发现的授权解释缺口

Build71自然前台已把sleep/workout context送达并触发真实复评；Worker不再用总时长证明就寝目标，却把“当前为后台事件”当成重新调整Agent准备时刻必须再次对话的理由。实际提醒source=agent、原计划明确为Agent选择的提前准备时间。修复只补健康提示中的证据引用路径：读取同目标原始已接受安排提醒指令和后续更正，必要时引用其event_id、原文及action；后台事件本身不是新授权，也不是禁止沿用原有授权。保留真正用户固定时刻、撤销、一次性限制及其他任务。不强迫本次或每次健康变化重排，缺数据或无收益可合理keep。


Host内部恢复接口requestReassessment只接受已完成的纯健康dispatch、同用户/目标/当前inputVersion，以及有限reviewKey和明确原因。它沿原readSnapshot创建有审计引用的新dispatch，保留旧keep/原健康行；相同key幂等，不允许跨目标、finance、未完成、到期/来源/修复任务或递归复查来源。schema17仅在health_dispatch增加nullable reassessment_of/reassessment_reason。Worker收到的内部事件明示“复查旧事实，不是新观测或用户指令”；既有Runtime序列化、权限、版本、工具与ChangeSet保持。没有新增手机/桥接API或Worker调用入口。验收覆盖真实Runtime复查、重复请求不派第二次、旧keep和所有事实/任务/chat不变，以及16→17所有原字段保全。正式修复以明确请求原因引用17:09原评估，不改旧决定、不改样本、不用无关任务制造触发。
