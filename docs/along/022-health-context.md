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
