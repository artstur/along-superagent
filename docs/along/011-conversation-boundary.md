# 目标对话与后台编排的边界

主分类 data / agent；依赖 Along 客户端的 audience 读取、缓存重放与任务推荐呈现。

目标 chat 仅呈现用户亲自发送的消息、Agent 对其的直接回答，及直接对话中的必要澄清。执行收尾、开发验收、提醒补排和日常调度保留审计记录，不作为用户或 Agent 的聊天发言。后台推荐继续作为任务结果和通知交付。开发验收使用隔离身份与数据，不得通过正式配对伪装用户发言。

每条 message 有宿主写入的 audience（conversation / background）。模型和外部事件不能声明 audience。正常 user_message 与直接回复归 conversation；执行回执、任务状态事实与自动更新归 background；自动 health/due 的 ask 也归 background：目前没有宿主验证缺失事实的 anchor，模型自报 ask/reason/text 不构成 chat 权限。历史未标记的直接对话默认保留。旧执行记录根据持久 sync 的 execution 标记及健康 dispatch 关联迁移，而非文案关键词。

/sync?conversation_version=1 返回全部载体和当前持久 audience，旧 outbox 中的 audience 不得覆盖当前值。未声明能力的旧客户端获得无 message 的 changeset_note 占位，游标与分页不变，防止继续收到后台文字；旧缓存需升级后完整重放才能清除。推荐不会删除，升级后可重新取得。

历史开发污染只允许宿主存储维护方法按已核实的源 event_id 与私有证据引用隔离，追溯直接回复、ChangeSet 问题和 RunRecord 回执；不按前缀或自然语言匹配、不删除原始记录、不沿共同 conversation 根误伤之后的用户消息。隔离可审计、幂等，同步使用原消息身份更新已缓存记录。该方法不开放为模型工具或配对 HTTP 参数。

验收：直接对话保留；后台文字不进入 chat；结果、推荐、任务与提醒保留；旧缓存重放可收敛；分页 seq 不变；历史维护失败原子回滚且不跨用户；模型不能伪造消息 audience。手机本轮断开，签名包准备后待原机覆盖更新、前台验证。

Worker 的 along_conversation_read 在数据库 LIMIT 前筛选可信对话与真实任务事件，messages 仅返回 conversation。task.feedback / completed 保留在单独标注 source=task_event 的 task_feedback 中，不被误写为本人聊天；内部执行和隔离开发消息既不进入 messages，也不占用分页名额。底层审计读取仍保留全部记录。

历史隔离的同步更正携带 classification_only=true，保留推荐和原通知定位身份，但不构成新的通知意图。客户端和Host需明确跳过该类同步的通知下发，不能只靠设备历史去重。

记忆读取仅排除 message_audience_audit 明确记载的已证实开发输入来源；同源派生记忆在有效读取时被来源过滤。不能因 background 泛化失效合法健康或执行记忆，不删除记忆审计记录、不调用忘记流程，也不改变现有任务安排。

自动 ask 不下发 task_result 通知。工具回执明确 background_only，不新增强制人工 blocked/Attention 条件，也不改变原 Worker ready 与 pump 收尾语义：本次评估交付 need_data 可以收尾，不代表用户目标／任务已完成，后续真实事实仍可触发新工作。真正阻塞事项继续复用原有 blocked + human_action 的内部 Attention；不通过该机制将后台日志转成个人通知。无 task 的必要问题目前没有 App 专用交互面，保留为已知限制；已有 task 的 needs_time 仍在原任务卡。本轮不新建通用澄清 UI 或自动识别问句系统。

历史 health/due ask 在 workspaceSync 读取时按真实 health_dispatch 关联标记 classification_only=true，保持旧 notification.event_id 供已送达通知定位，但客户端与Host不据此再发通知；不修改原 outbox 或刷新时间，历史审计完整保留。

已证实开发来源的原始旧 sync 也在读取时按 message_audience_audit 关联投影 classification_only，防止新客户端重放近期旧结果时误响；未关联开发审计／自动ask的正常后台推荐保持原通知能力。
