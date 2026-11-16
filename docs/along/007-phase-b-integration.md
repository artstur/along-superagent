# 阶段 B 最小聊天闭环实现记录

> 2026-11-15 开始，2026-11-16 收尾。本轮范围以 Along 仓库 `docs/stage-b-tech-design.md` 为准。代码已纳入仓库（`6abf690`），正式手机部署与真机验收另行记录。

## 实现

沿用阶段 A 的业务库、Inbox、版本和派工；新增持久聊天答复、无目标连续对话、消息补关联、完整同步快照。新聊天立即使旧工作失去提交资格，旧 Worker 不能仅抄取新版本号来提交旧计划。同一无目标会话的过时创建及重复创建均拒绝。首个有效创建后，宿主将同 work 的后续工具调用绑定到刚创建的目标。

Along Host 返回新协议能力及绑定用户，App 按用户隔离缓存与队列，先持久入队、再发送，按服务器接收序号合并；整页校验和缓存提交成功后才 ack，ack 失败跨重启重试。退休连接的迟到响应不能覆盖新缓存。页面复用目标选择、新建、聊天与返回入口；新链路没有采用或目标直接编辑/删除入口，也不运行旧健康复评。旧 Host 路径和旧缓存保留，历史数据不自动导入。

本地 Along Router 将允许用户的聊天作为需要回应的对话工作，现象描述也不能以“不改仓库”为由 ignore。错误的 missing/ended stop 同样拒绝而不终结原输入；有效停止仍交给原 Engine。Worker 的内置目标/任务 Skill 区分现象与行动意图，普通改变不发系统通知。

## 实际联调发现与修正

- Harness 0.2.2 在渲染前拒绝非 lossless JSON。省略工具结果中值为 undefined 的可选对象字段，继续拒绝数组 undefined、非有限数和非 JSON 对象。回归先红后绿，独立只读核实通过。
- 一轮 MiniMax 调用在 assistant tool-call 中已将 custom 的 metric 生成为 `{}`，之后尝试用自造数值指标绕过格式错误；这轮不计作语义通过。核实没有本地 Harness 把 null 改成 object 的证据。工具参数按 custom 与数值域分型，custom 只能省略或传 null，宿主固定补 null 后仍走原始完整业务 Schema；没有把 `{}` 宽松转成 null。非法 shape、未知字段及数值域缺失 metric 的拒绝已独立核实。
- 沿用编程 Router 时，一轮现象消息被当作与仓库无关而忽略。补齐本地对话上下文和工具侧窄 guard；同时拒绝以不存在工单的 stop 变相 ignore，保持停止/暂停/授权原边界。

## 验证证据

- Along `npm run check`：290 项通过；`npm run build` 后 18 个文件与 dist/、iOS 内置资源逐字节一致。HTML、SW、壳资源版本 58，Bundle 51。
- Along Agent `VITEST_MAX_WORKERS=4 pnpm check`：77 个文件、1484 项全部通过，类型检查与构建通过。曾在并行负载下出现现有 Runtime/WorkLink 5 秒超时；Runtime 单独 91 项通过，WorkLink 独立小范围通过。最终限制同时启动的测试进程，不修改超时阈值或业务断言。
- 独立只读核实：工具 JSON 输出先失败后通过；strict 工具参数与同 work 创建后绑定通过；Router 的 ignore 与无效 stop 边界已复核。
- Playwright 的 390×844 浏览器检查（原生桥和响应为替身）：聊天提交、目标/任务自动展示、无采用/直接变更入口、未发送文字及焦点跨空轮询保持、无横向溢出；无旧接口请求，控制台无错误。图片在 Along `output/playwright/stage-b-{goal,chat}.png`。
- Xcode 27.2：`xcodebuild ... -sdk iphoneos -destination generic/platform=iOS CODE_SIGNING_ALLOWED=NO build` 成功。没有因此宣称已签名安装或已在手机上运行。
- **真实模型与 Harness**：隔离 profile，Harness 0.2.2-rc.3 / MiniMax-M3.1-Flash，只有合成对话。`.artifacts/along-phaseb-chat-ready/proof.json` 为 `ok:true`：① 现象得到回应且无目标；② 行动意图创建 custom 目标、无数值 metric、带任务；③ 聊天纠正把任务改为睡前读纸质书。3 条答复落库，相关工单结束。一次无目标读取被正确拒绝，模型随后继续处理；修复后的记录没有 lossless JSON 错误。验证 profile 已停止。

未验收：实际 iPhone 的 HTTPS 配对/离线重连/安装体验，生产数据迁移与完整恢复；健康新协议后续已在 Along 阶段 C 接通，记忆生命周期与聊天工具已接入 Runtime（见 [记忆实施记录](006-memory-implementation.md) §5），定时记忆提取已接入 [维护工单](008-scheduled-maintenance.md)；完整通知策略、跨目标协调及复盘/Skill 作业仍属于后续范围。本轮成功样例不代表任意中文表达的语义质量均已通过。
