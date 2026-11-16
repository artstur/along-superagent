# Along 阶段 0 技术验证

> 2026-11-15。方案基线：`4b9df2e`。本轮验证可行性与缺口，不接管手机数据，不启动正式 Along 服务，不改变已有 DSH profile。

> 本文保留阶段 0 当时的验证结果；其中“尚未实现”指该次快照。后续业务写入、手机新协议及定时记忆维护的完成范围见 [实施与验收](003-implementation.md) 第 1 节。

## 1. 目标、范围与方法

按 [实施与验收](003-implementation.md) 的阶段 0 检查六个前提。验证使用临时业务目录、合成用户数据和独立 Python 虚拟环境；不使用真实健康摘要。先保留原型基线，再增加可重复的探针，明确区分真实软件调用、宿主替身与尚未实现的集成。

| 前提 | 验证方法 | 通过标准 |
| --- | --- | --- |
| 不依赖 GitHub 启动 | 对空 GitHub 配置运行真实 Runtime 初始化 | 已配置且能创建编排 Session；只保留管理 API 不算通过 |
| Along Source 自动接单 | 正式 descriptor 注册到 Runtime，经事件、Policy、路由到 Ticket / Assignment；隔离 profile 核实插件加载 | Along 事件能产生真实领域记录；替身代替模型判断的结果单独注明 |
| Worker 凭证与目录边界 | 合成凭证探针、真实 DSH 环境过滤函数、临时目录读写及提示词检查 | 不隐式继承凭证；不把目录分开放置等同于沙箱；未部署对象不声称已验证 |
| 工具与 Skill 共存 | 在真实工具注册器中验证继承工具与本地扩展；宿主替身覆盖派工装配 | 继承工具与扩展工具可调用，结束 guard 拒绝调用；正式业务工具与真实模型选 Skill 的验收另外记录 |
| Hy-Memory 可运行 | 固定版本安装、原生依赖导入、`pro` / `chat` 初始化与合成数据接口冒烟 | 安装并能保持进程；真实模型与 Embedding 连通性需独立实测，替身不算通过 |
| 批量调度方式 | 检查进程生命周期、持久化边界和 Mac 休眠补跑需求 | 给出选型与补跑、去重规则；未实现调度器不声称运行验收通过 |

## 2. 验收与交付

保留探针命令、版本与结果，失败记录具体位置和最小后续改动。`pnpm check` 覆盖类型、测试与构建。阶段 0 只有六项前提实际满足才通过；探针成功复现阻塞不等于阶段通过。正式代码适配前继续更新本文件中的范围和验收。

## 3. 本轮结果

本轮已完成基线、8 个 DSH 探针、隔离 Harness 启动、真实 Worker 和 Hy-Memory 真实服务冒烟，并实现本地启动与 Along Source 最小插件。基线 `pnpm check` 为 1197 项通过；最终为 1205 项通过，类型检查与构建均通过。代码在 `feature/along-phase0`，尚未接管手机数据。

- 百炼 `text-embedding-v4` 已实际返回 1024 维向量；MiniMax `MiniMax-M3.1-Flash` 的 OpenAI 兼容接口已返回 JSON。
- Hy-Memory 2.0.16、Kuzu 0.11.3、Chroma 1.5.9 已在本机 Python 3.12 / arm64 环境安装。真实 `pro` / `chat` 写入、检索和重新打开后检索通过，单次冒烟约 6.4 秒；这不代表阶段 D 的记忆质量验收通过。
- 已解除 Along 本地部署的 GitHub 启动依赖；默认空配置仍保留 `repositoryUnset`。正式 Along descriptor 的显式消息和非人工健康事件能走通领域层并生成派工，重复事件不重复创建；这些派工测试的宿主和模型判断由替身提供。
- 已安装的 Harness 0.2.2-rc.3 在独立 `DSH_HOME` / profile 中实际启动：管理 API 返回 HTTP 200、Runtime `ready`，仓库与 GitHub 账号均为 `null`；Along Source 为 installed / enabled / ready。原型开发依赖仍为 0.2.1-alpha.2，本轮不是全套版本兼容认证。
- 开发依赖的真实 DSH 工具注册器测试通过，执行体由替身提供；另在已安装的 Harness 中，真实主 Agent 创建工单并派工，真实 Worker 读取测试 Skill、调用 Along 探针工具并报告结束。`read`、`bash`、`skill` 仍可见；结束后再次调用被正式 guard 明确拒绝。正式 Along 业务写入工具尚未实现。
- 合成 Token 的过滤函数测试通过；真实 Worker 的提示词装配和会话快照不包含本轮实际 MiniMax 凭证及三类合成 Token，真实 subprocess service 启动的子进程也未继承这些变量。目录外合成数据仍能被同账号进程读取，证明目录分离不是沙箱。凭证文件权限为 0600，但不能据此隔离同账号 Worker 的文件读取能力，也不能外推为已覆盖未来全部凭证与工具。
- 调度选型为 DSH 进程内计时器，批次、到期时间和断点持久化；具体实现和休眠补跑在阶段 E 验证。

因此，本轮证明了本地启动、Source 装配、真实 Worker / Skill / 探针工具和记忆依赖的可行性。正式 Along 业务写入、手机鉴权接入、记忆质量和批次调度仍未实现或完成运行验收，不能把这些基础链路证据当成完整架构已交付。

### 3.1 继续验证：解除 GitHub 启动依赖

**目标**：启用 Along 且不启用 GitHub 时，Runtime 能建立编排 Session 和执行器，不要求虚构 GitHub 仓库或账号。

**范围与方案**：部署中的 GitHub 能力变为可选；启用 Along、存储配置明确关闭 GitHub 时使用本地部署。GitHub 专属入口显式检查能力，缺失时拒绝；Worker 的 `gh` shim 拒绝调用，不回落到操作者账号。已有 GitHub 部署仍完成原账号与环境检查，默认空配置仍保留设置提示。先不新增业务数据库、手机接入接口或目标写入工具。

**验收**：Along 本地配置能初始化 Runtime；显式消息与非人工健康事件在本地部署内产生 Ticket / Assignment；不调用 GitHub CLI；GitHub 专属调用明确失败；原 GitHub 全量检查仍通过。

### 3.2 Along Source 最小装配

把探针中的 Source descriptor 落为可加载插件，提供三类事件及受控消息子类型的范围检查、允许用户配置和注册生命周期。默认不启用，不增加手机 HTTP 入口；配对、事件信封、摘要校验与业务写入仍属于阶段 A。未知事件类型与消息子类型在 Source 层拒绝，健康事件不能被标成人工消息来获得授权。原探针改为使用正式 descriptor，再用隔离 Harness profile 验证插件实际加载。

### 3.3 Hy-Memory 接入中实际遇到的问题

- `MEMORY_LLM_MAX_RETRIES=0` 在 2.0.16 中表示零次调用，提取立即失败。本轮使用 `1`，即尝试一次；不能沿用 OpenAI SDK 的“0 次重试但仍调用一次”理解。
- SDK 的默认同步 `close()` 未先等待异步 pipeline trace 落盘，快速关闭时复现过 `store_pipeline_log` 失败和 pending task 警告。探针在关闭 cache 前，分别在写入与检索 owner loop 等待 `drain_pipeline_log_tasks()`，之后离线与真实服务冒烟均无该警告。桥接使用了固定版本的内部 loop 属性，正式服务需要封装和回归，不能把它当成稳定公开 API。
- 百炼的 `text-embedding-v4` 使用 1024 维、每批最多 10 条；SDK 默认 batch size 为 64，本轮显式设为 10。Embedder 与 Chroma 维度同时设为 1024。
- MiniMax 使用 `max_completion_tokens`、4096 的提取输出预算、`reasoning_effort=low`，不发送 temperature；这些参数只经过本轮合成样本冒烟，质量门槛仍在阶段 D。

接口依据：[百炼 OpenAI Embedding 兼容接口](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai)、[MiniMax OpenAI SDK](https://platform.minimax.cn/docs/api-reference/text-openai-api)。凭证仅在 Mac 的专用配置文件中，仓库不保存真实值。

### 3.4 真实 Worker 补充验证

在临时 profile 加载仅供验证的插件，注册测试 Skill 和无外部写入的 Along 探针工具；使用合成对话触发真实主 Agent 与 Worker。验证 guard 只允许读取测试 Skill、调用探针与报告，拒绝其余工具执行。探针检查原工作工具仍可见、凭证不出现在持久会话内，并通过真实 subprocess service 启动子进程核对凭证变量被过滤。完成后保存不含凭证的证明并停止临时进程；这个测试工具不作为正式产品工具发布。

实测证明位于忽略的 `.artifacts/along-phase0/worker-proof.json`：`skillRead`、`workerCreated`、`childEnvClean`、`endedGuardDenied` 均为 true；`secretInPrompt`、`secretInEvents` 均为 false，子进程退出码 0。报告 `state=dropped` 后，真实执行管线返回 `Ticket ended; new work needs a new authorized ticket`。探针使用 Harness 0.2.2 的批量工具执行 API；早期沿用 0.2.1 单调用 API 得到的 `ToolBatchExecutionError` 不计为 guard 验证证据。临时进程已停止。

## 4. 复现命令与下一步

```sh
pnpm check
pnpm exec vitest run tests/along-phase0.spec.ts
uv venv --python python3.12 .artifacts/along-phase0/venv
uv pip install --python .artifacts/along-phase0/venv/bin/python 'hy-memory==2.0.16'
.artifacts/along-phase0/venv/bin/python scripts/along-memory-probe.py --offline
.artifacts/along-phase0/venv/bin/python scripts/along-memory-probe.py --env-file ~/.along/verification/phase0-memory.env
```

最后一条命令需要已有本机配置，不把密钥写进命令行。每次探针使用独立合成数据目录；`.artifacts/along-phase0/requirements.lock` 保留本轮 Python 完整依赖版本，不进入正式依赖。

本轮并行验证期间，全量检查曾多次出现既有 `tests/service-script.spec.ts` 的 5 秒超时；单独 15 项复跑通过。停止临时 Harness 后，默认 `pnpm check` 全量 1205 项、类型检查与构建均通过，没有修改超时阈值；该证据不足以确定超时根因。真实 Harness 的 profile、状态和证明文件都位于忽略的 `.artifacts/along-phase0/`，不修改已有用户 profile，验证结束后停止临时进程。

下一轮优先补 DSH 完整兼容与 Hy-Memory 深度验证；业务库、事件信封、配对接入和业务工具按阶段 A 推进。正式写入工具继续执行变更校验，凭证检查随新增工具与凭证扩展。不得将当前 Source descriptor 视为已完成手机事件接入。

## 5. 剩余技术验证

以下是尚未完成的验证清单，不是通过记录。本次只更新方案，不继续运行探针或推进功能实现。

| 项目 | 现有证据与缺口 | 后续验收 |
| --- | --- | --- |
| DSH 版本兼容 | 开发依赖 0.2.1-alpha.2，真实 Harness 0.2.2-rc.3；目前只验证部分链路，工具执行 API 已发现差异 | 完整核对启动、派工、工具执行、会话恢复与停止；优先补验 |
| Hy-Memory 质量与常驻稳定性 | 已完成合成数据写入、检索与重新打开；未证明长期常驻、中文业务质量或正式服务故障恢复 | 补长时间运行、关闭与重启恢复；阶段 D 验证更正、否定、跨目标隔离、忘记不复活及故障降级 |
| 业务写入一致性 | 正式业务库和写入工具尚未实现 | 随阶段 A–B 验证幂等、并发、旧结果失效、跨目标独立提交及约束协调 |
| 手机与健康联调 | 尚未实现新协议接入，也未接管手机数据 | 随阶段 A–C 真机验证配对、离线补传、重连同步、7 类摘要和按需通知 |
| 批量调度与 Skill | 已选进程内计时器，调度器与 Skill 版本链尚未实现 | 随阶段 E 验证休眠补跑、崩溃续跑、固定版本、自动发布及回退 |
| 迁移与备份恢复 | 尚未迁移旧数据或做完整恢复演练 | 验证稳定 ID 导入、单入口切换和各存储恢复后的一致性 |

首期不验收额外的健康授权撤回及关联历史数据清理流程（D15）。不设置应用侧累计模型用量上限（D17）；模型调用量记录不等于预算熔断。
