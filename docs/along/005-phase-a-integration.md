# Along 阶段 A 集成实现记录

> 2026-11-15。集成模块（装配、端到端联测、迁移备份、红线回归）的实现记录。方案唯一来源是 along 仓库 `docs/stage-a-tech-design.md`（§2.7 集成模块）；本文件只记实现落点与联测结果，不重定方案。引用行号以实现时的 Along Agent 工作树为准。

## 1. 装配落点（Along Agent `src/app/runtime.ts`）

按方案 §2.7.1 的顺序装配，全部发生在 `Runtime` 构造函数的 try 块内（失败由既有 catch 关库、放锁后重抛）：

1. **触发条件**：`assembleAlong()` 读 `store.settings()`，仅当 `localDeployment`（`src/app/setup.ts:16`：along enabled 且 github 显式 disabled）成立时装配；GitHub profile 不读 Along 配置键，零影响。
2. **配置键**：`src/deployment.ts` 的 `Config` 新增可选键 `alongStateDir`、`alongBridgeTokenFile`（`absolute()` 模式校验，§4.7），`machineOf` 透传进 `Machine`（可选字段）。localDeployment 时缺省即启动失败，错误信息给出配置指引（fail-fast，不回退、不猜路径）。
3. **BC-07-02 实现侧断言**：`alongStateDir` 在 `executionRoot(settings, machine.stateDir)`（`src/app/execution-environment.ts:18`）之内或与其同目录 → 拒绝启动（`containsPath` 私有助手，resolve+relative 判包含）。只断言路径包含关系，不夸大为沙箱（阶段 0 已实证兄弟目录可读）。
4. **目录锁**：`mkdirSync(alongStateDir, 0o700)` → `lockSync(alongStateDir, { stale: 30_000, onCompromised })`，Runtime 持锁（§2.1.2）；`AlongStore` 构造函数只开库迁移、不加锁。
5. **业务库与门面**：`new AlongStore(join(alongStateDir,'along.sqlite'))` → `createInbox` / `createChangeSetModule` 工厂注入 `AlongService` 门面（§2.1）。
6. **回环凭证**：`alongBridgeTokenFile` 指向的 0600 文件启动时读入（64 hex 校验，不符即启动失败）；**文件不存在时首次启动生成** 32B hex、0600（§4.7「首次启动生成」）。token 只存在两个 Mac 本机进程内存，不进日志、不进运行结果、不进 Worker 环境。
7. **模块实例**：`createWorkLink({ store, repo, report })`、`createRunRecord({ store, repo, prompts, report })`——`repo` 是 DSH orchestrator Store（只读 tickets/triggers），`prompts` 读 `KV.sessions.prompts(sessionId)`（§2.6.1 占位口径）。`report` sink 落运行日志（`ctx.logger.warn`）；worklink/runrecord 各自保留有界 `errors()`。`records` health entry 由 along Source kind 注册时认领（`src/sources/registry.ts:22-29`），Runtime 装配侧不重复认领（会撞 `refused`），故装配侧错误走运行日志。
8. **域事件分发**（§2.7.2）：`Runtime.emit` 回调最前加 `along.dispatch(event)`——实现为 `store.afterCommit(() => { worklink.onDomainEvent(event); runrecord.onDomainEvent(event) })`，回滚不留脏行、提交必落；随后原 notice 逻辑不变，`quiet` 语义不变。
9. **回环路由**：`initialize()` 中 `registerHttp` 之后 `registerAlongSource(ctx, host)`（`src/along/api.ts`，与 `/orchestrator` 并列的 prefix 路由，webServer 强制 loopback）；host 对象以 getter 引用门面（装配早于 setup 完成，路由注册不依赖 `configured()`）。
10. **投递泵**：`initialize()` 在 `passes.start()`/`effects.start()` 之后 `startDeliveryPump(store, deps, lifetime)`——`receive` 是 `passes.receive`（SourceContext 同一入口），`filteredReason` 读 `store.triggers.disposition(id)?.filtered`（终态原因）。`lifetime` abort 即停泵。
11. **Worker 工具**：`toolHost.along = { service, scopeFor: worklink.workScopeForTicket }`——`executorTools`（`src/app/tools/executor.ts:107-109`）据此注册 5 个 Along 工具；`WORK_TOOLS` 名单已由版本模块扩展（`src/app/sessions.ts:63-65`）。
12. **停机逆序**（§2.7.1）：`shutdown()` 的 finally 内——停泵（lifetime 已 abort，显式再停一次兜底）→ 关 AlongStore → 关 orchestrator Store → 释放 stateDir 锁 → 释放 alongStateDir 锁（逆获取序）。构造失败路径同样先关 AlongStore、放 Along 锁再重抛。

## 2. 测试夹具与端到端（Along Agent `tests/`）

- **`tests/fixtures/deployment.ts`**：`testMachine` 增加可选 `alongStateDir`/`alongBridgeTokenFile` 透传（`Machine` 新字段）。
- **`tests/fixtures/host.ts`**：
  - `webServer.register` 改为按前缀分发（原实现只保留最后一个 handler，`/along-source` 会覆盖 `/orchestrator`，方案 §2.7.3 指出的缺口）；`api()` 照旧打 `/orchestrator/api`，新增 `alongApi()` 打 `/along-source/api`（可带桥接头）。
  - `startRuntime(seed?, options?)` 新增 `{ dir?, alongStateDir? }`：给 `dir` 时跳过 mkdtemp、跳过夹具自带的 GitHub/Feishu 预置与 eval/policy 覆写（重启语义：一切数据来自沿用的 orchestrator.sqlite / along.sqlite，**带 dir 时拒绝 seed 参数**）、`stop()` 跳过 `rmSync`（目录由用例自行清理）；并在 ready 前 `register(alongKind)`，避免重启时存量待投递行被泵按「Source 未安装」打成 filtered 终态。首轮自建目录的场景由用例自己开 Store 预置沿配置再以 `dir` 传入（phaseA 主用例），保证构造时 localDeployment 成立且重启读同一目录。
  - 夹具默认给 `alongStateDir = <stateDir>/along-data`、`alongBridgeTokenFile = <alongStateDir>/bridge-token`（token 由 Runtime 首次启动生成）。
- **`tests/along-phase0.spec.ts`**（骨架复用，方案 §2.7）：`configuredProbe()` 等既有用例不变（along enabled+github disabled 的种子会触发真实装配，phase 0 探针因此升为阶段 A 骨架）；「本地启动」用例追加装配存在性与回环探测 200 的断言；凭证探针扩展 `ALONG_BRIDGE_TOKEN_FILE` 变量名（固定敏感名模式 `/KEY|PASSWORD|SECRET|TOKEN/i` 命中即被 `scrubbedParentEnv` 剔除——命名约定即过滤，无登记扩展点）。
- **`tests/along-phaseA.spec.ts`**（新增，E2E 主验收，方案 §2.7.3、§6）：
  - BC-08-01/BC-08-11 主链路：配对注册 → `POST /events` 信封 → 回执 accepted+received_seq → 沿 `along.sqlite` 断言 Inbox/message/delivery 三表同事务落库 → 真实投递泵（1s 计时器，`vi.waitFor` 轮询 delivered）→ 显式消息 candidate → `orchestrator_route` accept → Ticket + WorkLink 行 + `assignment.started` → Worker Session 注册 5 个 Along 工具 → `along_changes_commit`（goal.create，target 与原话一致）→ applied + goal_revision 1 + input_version(1, raised_by=事件号) + user_message 回填 direct link + sync_outbox → `orchestrator_report` 结束 → RunRecord 行 + outbound 执行说明消息。
  - BC-08-03：同一信封二次注入 → `duplicate` 回执、Ticket/Assignment 计数不变。
  - BC-00-05：`/sync` 拉取变更与说明在列（不拉也能生效——applied 先于拉取断言）；`/sync/ack` 回填 delivered_at。
  - 重启（BC-08-11/BC-09-04）：先停投递泵注入第二条消息（行留库），`stop()` 后同 `dir` 重开（无 seed），断言泵续投、第二条消息照常产生工作；回环查询完整对话（inbound 用户消息 + outbound 执行说明）与目标/任务内容一致。
  - 003 §3 追踪链：inbox.trigger_id → disposition → changeset.trigger_event_id → sync_outbox 各表互链断言；全部响应体不含 bridge token 字面量。
  - BC-07-02 负向：`alongStateDir` 放进 executionRoot 之下 → Runtime 启动即抛。
  - BC-07-03/04 工具侧：`along_changes_commit` 带 `goal_id`（schema 无此字段）→ 工具错误、业务行不变；`goal_id` 指向绑定外目标（沿 changeset 模块单测口径，E2E 覆盖 strict 拒绝路径）。

## 3. 迁移备份（Along Agent `scripts/along-backup.mjs`，BC-09-01/07）

流程照方案 §2.7.4：协调停写检查（`ALONG_EVENT_INGEST` 非 on 且 Along Agent 进程退出时允许备份，否则拒绝并提示先停写）→ 业务库与 orchestrator.sqlite 用 `VACUUM INTO`（一致性快照，SD-10；**不做**热文件复制——BC-09-07）→ DSH stateDir 其余内容归档：`work/` 工单目录、`worker-bin`/`worker-gitconfig`/锁文件等状态文件（会话记录落盘根目录由 harness 装配，脚本按「stateDir 内实测存在即归档、不在则提示人工登记」处理）→ Hy-Memory 目录（`~/.along/memory/`，存在即复制）与配置（profile 配置目录、pairing.json、bridge-token）→ 产出 `manifest.json`（每文件 sha256 + 大小 + 来源）。「Skill 版本」一项显式登记为阶段 A 不适用（无 Skill 版本链；prompt 版本随 orchestrator.sqlite 覆盖）。

联测记录见 §5。

## 4. along 仓库装配核对

`host/agent-host.mjs`（配对模块已落）：`ALONG_EVENT_INGEST` 开关、新端点 `/events|/sync|/sync/ack`（`/events` 30s 超时）、回执透传（200/400/409）、`identity_in_body` 接口侧拒绝、配对身份幂等注册、桥接凭证随全部回环调用（含情境评估专用 URL）、旧 DSH 分支 on 时 409——与方案 §2.4/§4.2 逐条核对一致（核对记录见 §5）。`host/server.mjs` 是静态开发服务器，手机入口是 agent-host，本轮不改（web 原则上零改动）。启停顺序：Host SIGINT → `server.close` → 进程退出；Along Agent 停机逆序见 §1.12。回退路径（BC-09-03/04）：`ALONG_EVENT_INGEST` 改回 off 即旧链路照旧，Along Agent 业务库与 DSH 状态不清（代码核对：Host 无任何清库/删除路径；Along Agent `shutdown` 只关句柄不删文件）。

## 5. 联测与红线回归结果

本轮（2026-11-15）实际执行的检查与结果；Along Agent 门禁 `pnpm check`（typecheck + vitest + tsdown build）与 along 门禁 `npm run check` 由工作流统一执行，本模块按分工只跑单个测试文件与联测脚本。

- **Along Agent 类型检查**：`node node_modules/typescript/bin/tsc --noEmit -p .`（等价 `pnpm typecheck`）→ 无错误（装配、夹具、phaseA 规格全部过编译）。
- **Along Agent 端到端**：`node node_modules/vitest/vitest.mjs run tests/along-phaseA.spec.ts` → **3 passed**（BC-08-11/BC-08-03/BC-00-05/BC-07-01/BC-07-02/BC-07-03/BC-07-04 主 E2E、隔离负向、凭证探针）。
- **Along Agent 阶段 0 骨架**：`tests/along-phase0.spec.ts` → **8 passed**（`configuredProbe()` 现在跑真实装配，新增装配存在性与回环探测 200 断言）。
- **Along Agent 沿模块回归**：`tests/along-{store,inbox,changeset,worklink,runrecord,bridge,store-acceptance}.spec.ts` → **137 passed**；`tests/along-*-verify.spec.ts` 五件 → **91 passed**；`tests/{runtime,http,deployment}.spec.ts` → **100 passed**（夹具改动对既有核心规格零回归）。
- **along 仓库新链路**：`node --test test/along-bridge.test.mjs test/event-queue.test.mjs test/event-queue-verify.test.mjs test/pairing-host-verify.test.mjs` → **36 passed**，含 BC-09-03（off/on 单消费切换）、BC-08-01/02（回执前不删待同步项、同号重试）、BC-07-05（归属拒绝与 404 同码）、真实 Host 装配（配对升级、鉴权门、凭证不出 Mac）；`test/recent-health-context.test.mjs` → **4 passed**。
- **BC-09-01 备份冒烟**（`/tmp/along-backup-smoke/run-smoke.mjs` 对 `scripts/along-backup.mjs`）：目录锁在 → 退出码 1 并给停写指引；停写后 → 备份完成（5 个文件；along.sqlite/orchestrator.sqlite 的 `VACUUM INTO` 快照可打开，manifest 含每文件 sha256 与表计数 goal=1/message=1，与源一致）；工单目录 `work/`、`worker-bin`、`bridge-token` 均归档；manifest 的 `skill_versions` 显式登记阶段 A 不适用。worker 会话记录落盘根目录在 Along Agent 仓内不可证（§2.7.4），脚本以 `worker_session_records` 说明项 + `--extra-dir` 处理，待运行中 stateDir 实测后登记。
- **BC-09-07 热复制演示**：对持有未提交事务的源库做文件复制，副本读到 1 条 message（源库提交后 2 条）——副本缺已提交数据、不构成一致快照；`VACUUM INTO` 快照计数与备份时刻源库一致 → 热复制不是备份，脚本只走快照，已记录于此。
- **BC-09-04 回退不清库**：代码核对——along Host 无任何清库/删除路径（`host/agent-host.mjs` 全文无删除端点）；Along Agent `shutdown()` 只关句柄、放锁，不删文件；E2E 重启场景证明停写期间入队的 delivery 在重启后由泵续投、业务行原样可查（tests/along-phaseA.spec.ts ⑧–⑩）。

## 6. 实现中的修正与备注

1. **runrecord 终结读修正**（跨模块接缝，集成 E2E 发现）：goal-create 路径的工单在派工时尚无 goal，WorkLink 行 `goal_id` 为 NULL；终结时从该 work 的最后一条 applied ChangeSet 反查 goal（`src/along/runrecord.ts` `finalize`），执行说明消息才能挂到目标上——否则 BC-08-11 的「按目标查完整对话」缺出站半边。仅读路径修正，WorkLink 写入仍单 owner（worklink）。
2. **filteredReason 的类型落点**：`TriggerDisposition.filtered` 是 `Reason` 对象（code+values），泵的 `filteredReason` 用 `reasonText` 格式化成串再落 `delivery.last_error`/终态原因。
3. **夹具布局备注**：测试把 `alongStateDir` 放在夹具 stateDir 之下（`<tmp>/along-data`）仅为临时目录清理方便——隔离守卫检查的是与 executionRoot（`<stateDir>/work`）的包含关系，phaseA 的负向用例证明放进 `work/` 即拒绝启动；生产路径是 `~/.along/along-data`（SD-5），在 DSH stateDir 之外。
4. **E2E 未跑真机 HTTPS/配对**（方案 §7.6 已声明）：Along Agent/along 测试全绿 + 回环契约（§4.2）两端按同一文档实现并经测试替身联调；真机联调随阶段 B 接线时执行。
