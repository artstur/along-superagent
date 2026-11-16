# 联网研究与推荐

主分类：agent。依赖 Along 客户端兼容推荐展示；依赖 DSH 0.2.2 的 web 服务和已授权 provider。用户可观察验收：原目标的徒步任务执行或正常到期后，App 展示可比较路线、匹配原因、条件与未知项、可点击来源及检索时间；反馈留在原目标。

## 架构与范围

用户意图、当前目标及约束 → Router → 原目标 Worker → 通用研究/徒步 skill → `along_web_search` / `along_web_fetch` → 绑定 scope 的持久证据 → 结构化推荐 → 原 message sync → App 卡片 → 既有 Notification 模块。

工具复用 `ctx.web.search/fetch` 与 DSH 凭据管理。[DeepSeek 官方 Search & Fetch](https://api-docs.deepseek.com/guides/search/) 是可供产品调用的真实 API。本功能要求 profile 明确固定 `deepseek-search-api` / `deepseek-fetch-api`；每次操作通过公开 settings descriptor 核实，避免回退到能访问内网的 HTTP provider。旧 DSH 没有 web 服务时返回 unavailable，业务工具不接触密钥。`web-deepseek-api.sendOriginalQuestion:false` 必须显式设置并逐次核实，避免provider默认将当前原始对话加入 ori_question。

地址限制 HTTP(S)、无用户名密码、无本机/私有/保留IP、公共DNS解析；Fetch 使用远端API避免本机DNS重绑定。网页与摘要作为不可信资料，不授予权限。调用限时限量，仅对可重试限流/超时/服务端错误短暂重试一次，失败返回可恢复状态。不得将原始健康数据或完整对话放进搜索词。

证据由 AlongStore 拥有的 SQLite 组件保存，绑定 user/goal/ticket；推荐仅引用当前任务取得的 source id，并核对原文摘录和有效期。URL、检索时间及有效期来自宿主。天气三小时、开放一天、路线七天、通用资料一天；检索新鲜并不证明预测覆盖出行日期，Worker须核实，未知不能通过。路线关闭、天气风险、过期资料不能标为可推荐。缺少精确距离/爬升等数据时留未知。

手动聊天使用 `along_chat_reply`；既有 `task_due` Worker 使用 `along_health_followup` 发布推荐并完成复查，不新增调度器。通知复用原消息/事件身份，去重重试由既有模块负责，不把通知当徒步完成。不更改原目标与提醒；必要任务调整仍走合法 ChangeSet。

## 推荐协议

message sync payload 可选 `recommendation`：`{version:1,kind:'hiking'|'general',status:'ready'|'partial'|'unavailable',title,summary,timeWindow?,constraints:[],options:[{id,title,reason,status:'recommended'|'conditional'|'excluded',conditions:[],unknowns:[],facts:[{label,value,sourceIds:[]}],checks:[{kind:'access'|'weather',status:'ok'|'risk'|'unknown',summary,sourceIds:[]}],sourceIds:[]}],sources:[{id,title,url,retrievedAt,expiresAt,publishedAt?}],retrievedAt,validUntil,nextStep}`。

最多三方案；无证据可空 options。model 输入只含内容、sourceIds 和支撑摘录，宿主生成来源及时间，并收紧状态。徒步必须核查 access/weather；risk 排除，unknown/过期仅条件候选。旧消息与旧快照不带 recommendation 仍可读取，幂等比较包含推荐和通知元信息。

## 验证与交付

测试涵盖工具成功、失败/空结果、超时/限流、URL/DNS、证据范围/摘录/过期、关闭/恶劣天气、证据不足、重复消息、旧协议与到期入口。运行 pnpm check（类型、全部测试和构建）。至少隔离真实 Worker 网络验证后才交付正式用户；共享服务与原手机由集成负责人统一发布，逐端记录实际观察与待验项。

已核实的回归基线：原 HEAD 的健康样本把当前窗口固定在 2026-11-16；跨日运行原 health.ts 时同样有 11 项因过期无工单失败。本次仅把该合成测试的 Date 固定在样本日，未改变真实健康新鲜度判断。项目 Node 要求 >=22.19；使用 22.23.4 完成检查和打包。

独立审查后的收紧：所有领域已提供的检查都必须通过，任何过期引用均降为条件方案；非徒步不会跳过未知天气。普通 task_id 消息的 WorkLink 保留原任务，推荐答复默认沿用该归属。Along Worker 与其子 Agent 的原生 web_search/web_fetch 被拒绝，必须使用会保存 scope 证据的沿途工具；其他 Source 的既有工具不变。

历史 task.feedback/task.completed 仅按已验证用户和实际任务归属合并进分页对话；旧反馈没有 message_goal_link 时也可只读恢复，不回灌旧目标或修改任务状态。

## 真实 Worker 验证后的修订

首轮隔离真实网络已取得官方气象与第三方路线资料，但把第三方开放信息当成已核实，且从普通天气预报推断无预警。新增徒步确定性门槛：开放通过需要可识别的政府一级来源；当前识别不了的运营方及第三方只保留未知。天气通过需要官方预报和明确当前警报证据；单独晴天预报不能证明无警报。工具增加 alerts 用途，推荐输入的天气检查可带 alertStatus/alertEvidence，wire 仍只有 access/weather。宿主降级时替换矛盾检查文案。

同轮数值校验正确拒绝了未被摘录支持的附加时刻，随后模型错误移动了 JSON 层级；错误将定位具体方案/事实与不支持数字，skill提供完整结构和局部修复规则。检索预算仍16次，优先官方开放、预报和警报，减少候选及可选精确事实。

到期研究任务经合法变更完成后，推荐结果使用当前任务版本的 task_result 通知；仍开放的研究用当前版本 recommendation_ready。已完成的实际徒步不因推荐绕过原过滤。研究身份取原到期修订的内容，无法确认时不升级完成任务的通知。

周期研究沿用 task_daily 的 weekday 和既有 renewDaily，不新增scheduler或数据契约。宿主到期场景下，已绑定周期的研究不允许自动永久完成/取消；本轮 keep 完成review并自动续排原任务。健康读取明确提供repeat、weekday和保持时的下一周期。用户新的真实聊天仍可合法停用；当前没有周期证据的旧任务由真实授权对话补计划，校验不放松。

独立复审再收紧：宿主到期的持续研究整项保留原任务，自动Worker不接受任何task ChangeSet，避免经off、null、repeat或内容改写间接清掉周期；新用户聊天不受此限制。徒步领域从原到期修订、绑定任务或原用户意图派生，模型自报general不能绕过徒步校验。

## 推荐文字与最终校验状态一致

第二轮真实 Worker 仍把日期不明的第三方微博警报写成当前风险，并在降级后的摘要中保留强断言。徒步检查的 risk 和 ok 都必须有新鲜已抓取的一手依据；当前警报风险额外需要可核时间与明确生效证据，否则未知。任何候选尚未确认或被排除时，宿主统一生成保守摘要、后续动作和候选说明，移除标题里的推荐标签，避免预警时改去另一处户外公园。已引用事实、来源和未知项保留用于比较；一般领域和所有条件均通过的结果保留原文。旧客户端的消息正文也从同一份最终投影生成；重试按原始提交比较，保持幂等。

降级时未通过的开放/天气/警报参数不保留为当前精确facts，移入未知说明；有已抓取有效依据的路线长度等资料继续展示。单次研究完成后的新聊天反馈也统一按宿主任务状态选择 task_result/当前revision，已完成实际徒步继续静默，普通无推荐聊天不变。

投影负例补充：无当前警报、已解除以及假设警报的句子不作为生效警报证据，“没有暴雨”等否定句不作为恶劣天气依据。事实类别同时核对value，不信任model label/purpose；关键检查未通过时，仅保留有已抓取有效route依据的纯路线度量，其余参数归入未知，防止“route/小贴士/无需预约”绕行。

同任务人类反馈预算：旧due ticket被合法resume后，WorkLink已绑定新human事件，回复身份正常；原16预算却按ticket累计导致“发新消息重试”无效。预算现按宿主持久event分桶（既有operation TEXT内编码event/operation），同事件重试与重启仍共用16，新显式消息或新due事件各有16。来源receipt保持原user/goal/ticket范围，仍可复用未过期旧依据，不改Router/Engine、不改任务状态、不新增目标。

无某一类别预警不等于整体无预警；clear 证据若同时含有效警报或恶劣天气正向条款，或仅说明特定类别没有预警，均保留未知，不给出整体无警报结论。
