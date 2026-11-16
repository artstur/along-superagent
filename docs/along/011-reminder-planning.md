# Agent 编排任务时安排提醒

主分类为 agent，依赖 Along 已有的 task_updated 快照、iPhone scheduledAt 排程和 Host 到时补偿。用户在 Along 描述带时限或节奏的行动时，Agent 同时决定何时提醒并说明依据。能合理安排就直接排，重要时窗不明时只问必要的问题。普通建议和明确免打扰的任务不建立通知。

## 数据与交付

- Worker 在用户对话中创建任务或重排提醒时提交 reminder_plan。状态为 scheduled、needs_time 或 off。已排任务继续使用 scheduled_at 作为实际触发时间，附来源 user 或 agent 及用户可读说明；needs_time 附具体问题。一次性不续，daily 沿用已有原文授权。weekly 由用户的周节奏原文约束，工作日为本地 ISO 星期 1–7，在原有到期工单上续排。
- 同一事务保存任务修订、当前提醒计划和必要的对话消息。同步保留原 task_updated 及消息类型。持续计划仅在开放任务和有效目标上有下一次；重放、改期与撤销使用原来的修订、幂等键和系统排程标识。源数据无相应信息的存量任务保持原状。
- 手机继续以 scheduledAt 排本地通知。没有具体时间时确保 App 有一条即时可读的追问。任务快照可带 reminderPlan 展示来源及理由。现有客户端兼容附加字段。正式目标不做回填。
- 验收使用隔离库、真实工具和同步链路，覆盖 Agent 选择提醒时刻、无法确定而追问、无时限与免打扰、每日到时、按当地周一／周四预约下一训练日、调整和退出。正式环境由发版负责人备份并切换。

## Agent 与客户端契约

正常 Worker 的 task.create 必须带 reminder_plan。修改任务内容或提醒时提交完整替代计划；不改变既有安排的文字调整可传字符串 keep。幂等重放先查原提交结果。计划校验被拒时工具给出具体修正方式；时刻可以合理推定、持续委托尚不能证明时，立即先提交下一次并说明实际覆盖范围。

在 /goals/:id 的 tasks 和 /sync 的 payload.snapshot.tasks 中，新任务可有以下字段。旧记录没有充分依据时该字段缺省。

| reminderPlan.state | 公开字段 | 提醒行为 |
|---|---|---|
| scheduled | source 为 user 或 agent，explanation 为 2–240 字符，repeat 为 once、daily 或 weekly | scheduledAt 包含完整时区偏移，为下一次实际触发时刻 |
| needs_time | question 为 2–240 字符 | scheduledAt 缺省，具体问题在本目标对话中出现 |
| off | reason 为 opt_out 或 untimed | scheduledAt 缺省，已有预约撤回 |

持续委托的 scheduled 计划另有 timezone（用户原始入站事件中的 IANA 时区）和 wallTime（建立或明确调整委托时的 ISO 时间戳）。weekly 另有 weekday，以 ISO 1–7 指定实际提醒日。出差、服务离线或遇到夏令时变化后，后端仍以委托时区和原墙钟续排。春季不存在的钟点顺延，下一次恢复原钟点。服务端和手机以同一 task ID、实际时间和修订识别重复与撤销。每次到期仍用既有 task_updated.payload.notification.kind=reminder_due；previousDailyOccurrence 在日、周自动续排时均仅对对应的新修订有效。

scheduled 的 agent 来源说明与 needs_time 的问题在同一 changeset 事务中写入普通对话。解释和问题本身不触发额外系统横幅。user 来源必须直接指向本任务的提醒动作及原文钟点；课程、截止时刻和 Agent 挑选的提前量有独立意义。手机只接受服务端投影的两个时区字段，Worker 不能输入这两个值。

## 发布与回退

1. 发布责任人锁定合并提交，使用项目要求的 Node、pnpm、锁定依赖，在隔离目录运行 pnpm check，再从同一提交构建和打包。核对构建后的 lib、prompts 和 skills/dsh-superagent-along-task/SKILL.md 均包含在部署包中。
2. 暂停旧 DSH 单写进程，保留上一版包，备份 Along 业务 SQLite（含 WAL 中已提交的事务）及同一时点的 DSH 工单库。在专用测试 profile 中先通过配对、/events、Worker、/sync 验证后再切换生产包。首次打开自动原子迁移 schema 5 至 6。
3. 回滚时停止新版单写进程。旧程序会拒绝更高 schema，应一并恢复相同切换点的旧业务库、工单库和旧包。保留新版运行期备份并核对切换后业务差异，再恢复服务。

## 隔离验收

覆盖新任务缺少提醒决定、业务时刻冒充用户提醒、被拒后仅排下一次、免打扰、同一请求内多个周期动作、修订重放、周一／周四滚动以及夏令时和 schema 5 存量。入口为 tests/along-reminder-planning.spec.ts。模拟器中的合成用户从 App 发送请求后，经真实入站工单与 Host 同步产生系统排程；改期、撤销、答复追问、指定横幅到点与点击打开原任务均通过。隔离真实模型针对未在 Skill 中出现的周三／周六课程及 22:00 截止事项，提交了周二／周五的预约提醒和每日 21:00 的准备提醒，三项均经 /sync 返回 Agent 来源。


## 预约行动日与活动日校验（2026-11-16）

主分类 agent，依赖已合并 PR #5。隔离复现发现，Worker 只引用课程名作为 action 时，原句“每周一提醒我预约周二课程”在 action 之前同时包含周一与周二，旧校验会错误接受周二。正确规则是预约/预订动作之前的周节奏约束提醒日，动作之后的日期约束被预约的活动，不能转授权为提醒日。

最小修复仅收紧周计划原文范围，不重建协议或改正式数据。覆盖实际注册 Worker 的 task.create/ChangeSet 校验，以及中英文预约动作、正确提醒日、课程日误用、完整动作与短活动名。类型检查、全量测试与构建通过后独立复核，以单独 PR 合并；主仓消费接口无形状变化。
