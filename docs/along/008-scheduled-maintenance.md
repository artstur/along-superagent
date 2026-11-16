# 定时维护通过 DSH 工单执行

2026-11-16。目标：新聊天无需人工调用即可批量形成长期记忆，维护工作复用 DSH Ticket、Assignment、Worker、执行记录及恢复路径。

## 本轮范围

只接通记忆提取与撤回后的 SDK 清理，不实现复盘、Skill 发布、回退或手机新入口。已有对话立即影响当前规划的行为保持不变。SDK 未配置时保留 SQLite 读取与撤回，不产生无法执行的定时工单。

## 实现方案

### 可配置执行时间（2026-11-16）

目标：在 DSH 的 `dsh-superagent` 插件配置里设置 `alongMaintenanceTime`，使用 Mac 本地时区的 24 小时 `HH:mm`，默认 `03:00`。复用 Settings → Deployment 与 Plugin Manager 共用的现有配置表单，在 Along 部署中增加一个执行时间字段；GitHub 部署不显示。复用现有 volatile 配置机制，保存后下一次周期检查生效，不新增手机入口或模式。

调度规则：尚未到期且没有在途批次的日程改为新时间的下一次出现；已到期的漏跑仍补一次，不能被修改时间跳过；在途批次保持身份和断点，完成后按当前配置安排下一周期。配置的上次取值随日程持久化到现有 `meta`，不升级数据库 schema。旧日程按原默认 `03:00` 识别。跨日、重启、人工停止与空批次推进都使用同一时间计算。

验收：默认值、自定义值、非法格式/时分越界、volatile 更新及 Runtime 接线；存量未来日程重排、已到期日程保留、在途批次不重复建单、完成后使用新时间、重启保留新日程。完整 `pnpm check` 与 Along `npm run check` 通过后提交并推送当前功能分支。

- DSH 进程内周期检查，每个已配对且仍允许的用户默认在 Mac 本地时间每天 03:00 到期；持久化下一次时间与批次。无待处理记忆时不启动 Worker。启动或唤醒后按当前时间检查；多个漏跑周期合为一次，未完成批次优先续跑。本轮不实现积压阈值提前触发。
- `along.sqlite` schema 3 新增 schedule/batch 表。首次装配初始化下一次夜间时间；之后由持久时间判断漏跑。批次先落盘，再通过内部 `along-maintenance` Trigger 送入 Engine；固定 Trigger ID 与独立 Thread 防止重复建单及混入用户对话。跨业务库与 DSH 库没有原子事务：每次从持久批次和 Trigger/Decision/Ticket 反查恢复，不能依赖一次内存回调成功。
- 增加通用 `scheduled` Mandate basis，由本地维护模块对数据库中存在且与完整 Trigger 一致的批次提供策略。非人工事件保持 `human:false`；手机事件协议不接受维护事件。固定维护候选确定性 accept，不经模型判断是否有必要。授权仍要求本地 Along 部署、SDK 配置及允许的绑定用户；暂停期间不投递、不执行，人工停止的工单不自动重开。
- Worker 获得仅适用于该维护工单的 `along_maintenance_run` 工具，不注册目标修改、聊天答复或普通记忆工具。工具不接受用户、批次或路径参数；宿主从 Ticket 绑定，逐页调用现有 `MemoryService.runBatch()`，批次冻结输入上界，后来的聊天留给下一批。SDK、凭证和治理只在宿主操作。保留 SDK 超时与批次幂等，不增加模型语义分类规则。
- 批次完成依赖持久记忆进度及清理状态；Worker 未执行工具或仍 pending 时不能 report ready/dropped。单次工具处理有页数上限，返回是否需要继续；pending 按持久退避时间重试，避免模型紧密重试。失败/中断不丢批次；DSH 正常恢复同一 Ticket/Assignment。需要重试已失败 Assignment 时沿用同一 Ticket；人工停止当前批次后标记 stopped、不自动重开，本周期不重新建单。下一次夜间仍可产生新的周期批次；停止一次执行与取消周期是不同语义，本轮不新增周期管理入口。
- 所有用户维护串行共享 MemoryService，禁止重叠调用；停止 Runtime 时先停止调度和执行，再等待批处理、关闭 Python owner，最后关业务库。维护执行记录落现有 run_record；普通维护不写手机聊天、不发通知。
- 现有策略变更计算使用同一策略装配函数，不能把正常设置更新误判为撤销系统维护授权。GitHub 部署无定时作业、工具或策略变化。

## 验收

1. 真实 SQLite + Runtime：新消息 → 到期批次 → 内部 Trigger → 确定性 accept → Ticket/Assignment → 注册工具 → 真实治理（SDK I/O 可替身）→ 有效记忆 → 结束记录，全程无需手工 route。
2. 重复 tick/Trigger、跨日休眠、跨库写入中断和重启仍只有同一批次/工单；无积压不启动 Worker；新消息不无限延长当前批次。
3. 多页、清理、SDK pending/失败退避及重试；假完成拒绝；工具参数严格，普通工单/伪造内部事件不能获得执行能力；多用户互不串数据。
4. 暂停、SDK 未配置、用户移出名单、人工停止均不绕过；重启续跑保持原状态；停机不在关库后写入。
5. `VITEST_MAX_WORKERS=4 pnpm check` 与 Along `npm run check`。真实 SDK/模型冒烟只用合成中文数据，与测试替身、长期稳定性及真机验收分别记录。

## 实施记录

实现已接通：`maintenance.ts` 负责内部事件、固定派工规则、运行能力和恢复；`maintenance-store.ts` 与 schema-3 表共享 AlongStore 事务；Runtime 复用既有 pass 计时器，无新后台进程。普通 Worker 的工具名单不变，维护 Worker 只注册运行和报告两个工具，并屏蔽继承的文件、Shell、网络与子 Agent 工具。已完成作业不唤醒主会话，停止当前批次不会取消下一周期。

验证（2026-11-16）：

- `VITEST_MAX_WORKERS=4 pnpm check`：79 个文件、**1506 项通过**，类型检查、测试与构建通过。新增 `tests/along-maintenance.spec.ts` 16 项，使用真实 Runtime/Engine/SQLite/工具，仅替换 SDK I/O。
- Along `npm run check`：**290 项通过**。没有修改手机源码或生成资源。
- 覆盖重复投递/接单、无积压、无 SDK、暂停、用户移出/恢复、伪造内部身份、系统事件不能停止工单、普通 Worker 不能取得维护能力、严格参数、假完成、121 条多页与新输入上界、SDK 失败退避、同工单重试、批次落盘/事件接收后的跨库中断、在途停机恢复、撤回清理、并发用户、执行中人工停止、已结束执行记录的重启补登，以及正常设置更新不撤销维护资格。

生产接管边界：代码尚未部署到正式手机或正式 DSH profile；只有本地 Along profile 配置完整 `alongMemory`、用户已配对且仍允许时才自动调度。首次装配初始化下一次本地 03:00；后续启动/周期检查补跑持久时间中漏掉的一次。复盘、Skill 发布/回退、积压提前触发及长期稳定性仍未验收。


### 真实 Runtime / Worker / SDK 验证

最终构建使用 Harness 0.2.2-rc.3、MiniMax-M3.1-Flash、Hy-Memory 2.0.16 的真实 LLM/Embedding，输入只有合成中文偏好。隔离 profile 的调度日期被验证宿主设为过去；未直接调用 `runBatch()`、未手工 route。证明文件 `.artifacts/along-maintenance-runtime-final-retest/proof.json` 为 `ok:true`，两份工单全部结束，五条断言通过：内部事件确定性建单、真实 Worker 调用宿主批处理、SDK 产出通过治理的记忆、不写手机聊天、下一份周期工单清理明确撤回的 SDK 投影。两轮各调用一次 `along_maintenance_run` 与 `orchestrator_report`，无工具错误。成功样例的分类为 preference/explicit，来源与逐字引用匹配，SDK 引用有效。

保留的失败证据：`.artifacts/along-maintenance-runtime-final/proof.json` 中调度、工具和工单结束均正常，但本批 processed=1/saved=0，预期偏好的语义断言失败。SDK 日志已产出一条 L2 事实，Along 未形成有效记忆；未保留该轮分类器完整返回，因此无法区分空分类与被治理拒绝的提案，不能武断归因。随后在相同输入、相同最终代码的独立目录复测通过，没有放宽校验、替换输入或将失败算作成功。提取语义质量和可诊断性仍需阶段 D 后续工作；调度完成不意味着每句聊天都会生成有效记忆。

验证进程均已停止；没有切换正式数据或部署 profile。复跑探针与 launcher 留在对应忽略目录，密钥由原有 0600 验证 env 文件读取，证明文件不含密钥。


### 可配置时间交付验证

`alongMaintenanceTime` 已出现在 Along 部署的 Settings → Deployment 和 DSH Plugin Manager 共用配置页，使用时间输入框，支持只读回显；保存通过原有 DSH ConfigForm 将 `HH:mm` 字符串写回插件配置，不转成数值、不重启进程。YAML 同样可设置 `alongMaintenanceTime: "02:15"`。GitHub 部署不显示这个字段。

最终 `VITEST_MAX_WORKERS=4 pnpm check`：79 个文件、**1518 项测试通过**，类型检查与构建通过；Along `npm run check` 290 项通过。相较前一轮新增配置格式边界、volatile 更新、存量日程重排、已到期/在途保留、配置重启保持及共享配置页的字符串保存/只读回显验收。`tests/along-maintenance.spec.ts` 当前为 18 项；本轮未重复调用真实 SDK，原真实链路成功及失败记录继续保留，未将其当作本轮时间配置的真实 UI 操作证据。
