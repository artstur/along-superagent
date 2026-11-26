# Along Agent 工程约定

- 本仓库维护 DSH bundle、Along 业务逻辑与管理面板。iPhone / Web、Host、Mac 启动器与云端部署编排属于相邻 Along 仓库。包名与插件 ID 均为 `dsh-superagent`。入口和工具链见 [README](README.md)，技术文档从[导航](docs/README.md)进入。
- 改 Along 业务先看 [`src/along/`](src/along/) 和 [Runtime 装配](src/app/runtime.ts)。`orchestrator.sqlite` 保存 DSH 工单及执行状态；`along.sqlite` 保存 Along 业务状态。SQLite 是有效记忆的治理依据，Hy-Memory 是可重建投影；记忆配置及降级见[接线说明](docs/along/006-memory-implementation.md#5-runtime-接线方案2026-11-16按用户反馈修订)。`MEMORY_EMBEDDER_BATCH_SIZE` 由 Python 记忆进程读取，不是 Worker 配置。
- 目标 chat 只接收可信直接对话；不要把后台执行、自动复查或验收消息改成聊天。用隔离身份和合成数据验证，不通过正式配对代发用户消息。业务库、记忆目录和凭证不得放进 Worker 工作区。变更事件、同步、通知或交接契约时，同时核对 Along Host 和客户端；冷交接按[单写入者契约](docs/along/019-personal-cloud-handoff.md)执行，不用普通配对替代。
- 优先用 `pnpm exec vitest run <test-file>` 做定向回归，再跑 `pnpm check`。真实模型测试默认不跑，独立启用方式见[健康编排验收](docs/along/024-proactive-health-and-results.md#actual-model-and-nativeclient-checks)。把代码实现、合成测试、实测部署和真机验收分别记录，不用其中一项代替另一项。
