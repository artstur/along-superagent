# Along Agent 代码质量与文档整理 · 2026-11-16

## 目标与验收

主分类：agent / data。起始基线：`149633722101956de9b8be974b4f2925b616297b`（核实远端 main）。交付前已同步主线 `b79fccc93f63dd9cdcd219401a4a1b654d6a5152`（PR #3 合并后），无冲突。无上游 PR 依赖；本轮差异不改变到期复查、每日委托或通知业务。

本轮 Goal：巡检 Along 业务边界及适配器，复现并修复真实代码问题，整理受影响代码的职责、命名和数据流。仅在降低复杂度时使用设计模式，不为未来需求增加抽象、依赖或产品入口。同步清理文档入口、重复及失效指引，保留历史证据并明确当前实现、目标设计与历史验收的差别。

用户可观察验收：数据或记忆凭证被错误配置在 Worker 根的点号开头子目录时，服务明确拒绝启动；合法的相邻目录继续正常使用，目标可持久化并在重开后读回。读者从 README 能找到当前运行说明与各阶段历史记录，不会误将目标设计视为已实现。

## 实施流程与范围

1. 基线运行 `npm run check`（类型检查、全部测试、构建）。巡检 `src/along/` 及相关测试，优先输入校验、异步失败、状态一致性。
2. 逐项记录候选现象、不变量与复现证据；修复前先写能失败的回归，再最小修复。对测试做回退检测。
3. 整理代码只服务已证实问题与可维护性，避免无关格式化；保留权限、凭证、健康汇总和 Agent 输出校验边界。
4. 运行完整检查与构建验收，在固定提交上进行独立只读复核；处理有效发现后推送任务分支与 PR。
5. 文档独立提交。历史技术验证不删除；当前入口消除失效链接，重复内容用链接指向归属文档。

## 候选与结果

### C1 → Bug A1：点号开头的子目录绕过隔离守卫

- 不变量：Along 数据目录与 Worker 根不能彼此包含；记忆数据和凭证路径同样不能位于 Worker 根内。
- 复现：`work/..private`、`work/...` 是真实子目录，旧 `relative(...).startsWith('..')` 把它们当成父目录穿越，守卫未抛错；反向包含也有同样问题。
- `pnpm exec vitest run tests/along-store-acceptance.spec.ts tests/along-memory-transport.spec.ts`：修复前 2 failed / 32 passed，断言失败为“expected function to throw an error, but it didn't”。
- 方案：把路径包含判断提为命名清楚的纯函数，显式区分完整的父目录段 `..` 与普通点号开头名称；保留兄弟前缀、真实穿越和不同根路径边界。复用现有守卫，不增加另一套策略。
- 影响：配置含这类路径时现在启动失败，阻止数据/凭证落入 Worker 目录；没有改变业务协议或已有合法兄弟目录行为。此检查是配置边界，不能代替操作系统沙箱。

### 文档整理

- 根 README 的重复长导航合并到 `docs/README.md`，按当前实现、目标设计、阶段验收、GitHub / 飞书部署分组。
- SETUP 保留安装步骤，收敛重复入口说明；中文概览明确适用范围，避免误当作 Along 手机的安装流程。
- 跨仓 Markdown 链接改为 Along GitHub 主线文件地址，同时保留本地相邻目录的运行要求；链接不再依赖本地恰有兄弟仓库。
- 既有阶段记录的日期、源码基线、验收数量与待验项均保留。双仓 Goal Prompt 归属配套 Along `docs/code-quality-goal.md`。

### 验证

- 基线：`npm run check`，80 个文件 / 1537 项测试通过，类型检查与构建成功。
- 定向修复后：`pnpm exec vitest run tests/along-store-acceptance.spec.ts tests/along-memory-transport.spec.ts`，34/34 通过。
- 回退检测：仅恢复旧 `src/along/store.ts`，上述两条新增测试再次失败（32 passed / 2 failed）；恢复修复后继续验证。
- 首次修复快照 `npm run check`：80 个文件 / 1539 项测试全部通过，类型检查与 Node / 浏览器构建均成功。
- 构建入口：从 `lib/along-memory.js` 导入真实导出，在隔离临时库写入合成目标并关闭重开后读回；合法记忆适配器可关闭，`work/..memory` 配置被构建产物拒绝。未启动 Python 或模型。
- 文档：全部本地 Markdown 链接解析成功；8 个跨仓主线文件地址均与配套 Along 源码对应。`git diff --check` 通过。
- 独立只读复核：固定快照 `0724acb`，`VERDICT: PASS`。核实者在原基线加新测试重现 2 红、当前定向 34 全绿；相邻路径与文档等合计 216 项通过，额外 12 组路径实例无缺陷。
- 同步最新主线后：`npm run check`，81 个文件 / 1544 项测试全部通过，类型检查与两端构建成功。再次从最终构建导出写入合成库、关闭重开并读回，合法适配器可关闭，`work/..memory` 和 `work/..secret.env` 均被拒绝。

没有生产部署、进程替换或 iPhone 真机验收；启动隔离拒绝行为通过实际守卫与记忆适配器构造函数测试验证。

## 2026-11-25 · 维护入口与并发测试

本轮以 `ccc57ba64494ce528e7c27eff5539455bb09e3e9` 为基线。根 README 保留工程职责和本地开发命令，功能说明及阶段证据由文档导航统一索引。设置保存测试复用现有的 deferred fixture，仍在相同的调用点创建、等待和释放 Promise。验收覆盖文档链接、类型检查、全量测试和 `lib/` 构建文件的逐份比对。

本轮 `npm run check` 通过，1927 项测试通过，1 项真实模型测试沿用既有跳过条件。相同工具链构建基线和清理后的版本，25 份 `lib/` 文件的路径和 SHA-256 均一致。

## 2026-11-27 · 死代码清理（TASK-83）

### 范围与口径

只删除**确认无入口且无兼容用途**的导入与私有辅助逻辑；涉及接口、持久化数据或兼容性语义的候选只记录证据，留待单独评估，不在本轮删除。Along 与 Along Agent 两仓同批排查、同批交付。

### 排查手段

- **模块可达性**：以 `tsdown.config.ts` 的 7 个构建入口（`src/index.ts`、`src/client/index.tsx`、`src/sources/github.ts`、`src/sources/feishu.ts`、`src/sources/along.ts`、`src/along/memory/index.ts`、`src/along-handoff.ts`）为根，沿 `import` / `import()` / `export … from` 边遍历 `src/` 全量模块，列出无任何入口引用的模块；再单独列出「只有测试引用、生产无引用」的模块。
- **编译期死代码**：`tsc --noEmit --noUnusedLocals --noUnusedParameters` 列出未使用的导入、局部量与参数（该组合原本不在 `tsconfig.json` 里，本轮清理后加入）。
- **导入级死代码**：解析 `src/` 与 `tests/` 的全部 `import`（含跨行与 `import type`），逐个绑定名在导入文件其余部分做词边界检索。
- **声明级死代码**：`function` / `const` / `class` / `interface` / `type` 的名字在全仓出现次数 ≤ 1（只有声明处）才列为候选；只被本文件内引用的 `export` 属于「只多一个导出关键字」，不算死代码。

### 已删除

**1. `src/` 12 处未使用绑定**：

| 文件 | 删除项 |
| --- | --- |
| `src/along/changeset.ts` | 未使用的类型导入 `TaskTriggerInput` |
| `src/along/health-store.ts` | 未使用的导入 `healthLocalDate` |
| `src/along/task-activation.ts` | 未使用的局部量 `store` |
| `src/along/tools.ts` | 未使用的局部量 `bound` |
| `src/app/resources.ts` | 未使用的导入 `KV` |
| `src/app/runtime.ts` | 未使用的导入 `allowedSender`、`triggerMessage`、`ticketCard` |
| `src/core/engine.ts` | 未使用的类型导入 `ChannelRef` |
| `src/core/tickets.ts` | 未使用的导入 `latestReport` |
| `src/executor/dsh.ts` | 未使用的局部量 `source` |
| `src/infra/environment.ts` | 未使用的解构变量 `repository` |
| `src/sources/github.ts` | 未使用的类型导入 `GithubComment` |
| `src/sources/host.ts` | 未使用的类型导入 `ChannelRef` |

`src/infra/environment.ts` 的 `writeEnvironment` 仍然接受 `repository`（`Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>`），只是不再解构它：函数体写的 git config 只依赖 `stateDir` 与 GitHub 凭据，从不引用仓库地址，签名保持原样以免改动调用方契约。

**2. `tests/` 14 处未使用绑定**：`along-bridge-verify.spec.ts` 的 `origin` 参数、`along-inbox-verify.spec.ts` 的 `dbPath`、`along-inbox.spec.ts` 的 `inbox` 与 `path`、`along-runrecord-verify.spec.ts` 的 `rmSync` 与 map 回调的 `v`、`along-runrecord.spec.ts` 的 `rmSync`、`along-source-state.spec.ts` 的类型导入 `SourceIdentity`、`along-task-trigger-runtime.spec.ts` 的 `kind` 参数、`along-weekly-completion.spec.ts` 解构出的 `goal`、`along-worklink-verify.spec.ts` 的 `rmSync`、`second` 与 `h`、`along-worklink.spec.ts` 的 `rmSync`、`feishu-read.spec.ts` 的导入 `feishuReferences`、`model-surface.spec.ts` 的常量 `ASSESSMENT`、`runtime.spec.ts` 解构出的 `ticket`、`sources.spec.ts` 的导入 `MemoryRepositories`、`store.spec.ts` 的导入 `key`。

删除后保留了全部副作用调用：`await acceptedTicket()`、`await startAlongHost()`、`await h.acceptedTicket(secondEvent)` 仍照原样执行。

**3. `tsconfig.json` 加入 `noUnusedLocals` 与 `noUnusedParameters`**：把「未使用的导入／局部量／参数」变成编译期错误，避免死代码再次累积。清理后全仓零违规，`pnpm typecheck` 与 `pnpm build` 均通过。

### 已记录、未删除的候选

- **`src/along/legacy-import.ts`（休眠的旧数据兼容路径）**：这是 `src/` 里**唯一**没有生产代码引用的模块——2026-11-27 全仓引用核对显示只有 `tests/along-store.spec.ts` 与 `tests/along-store-acceptance.spec.ts` 导入它。它是「手机旧版 localStorage 导出」向 `along.sqlite` 的稳定 ID 幂等导入器（`g_health`/`g_finance`/`g_custom`）。删除会改变持久化数据与兼容性语义，需要单独评估，本轮只把结论写进 `docs/007-architecture.md` 的模块索引。
- **只多一个 `export` 关键字的符号**：全仓有 136 个导出符号只在本文件内被引用（如 `src/along/envelope.ts` 的 `EVENT_TYPES`、`src/app/notices.ts` 的 `receiptNotice`、`src/policy.ts` 的 `POLICY_REVISION`），符号本身都在用，死的只是导出面。收窄模块公开面属于接口变更，未纳入本轮。

### 结论与验证

`src/` 全量模块（含 7 个构建入口）没有可达性缺失的模块；`src/` 与 `tests/` 在加入 `noUnusedLocals` / `noUnusedParameters` 后零违规，说明导入级与局部量级的死代码已清空。

- `pnpm check`（`pnpm typecheck` + `pnpm test` + `pnpm build`）：**111** 个测试文件、**1932** 项通过、**1** 项跳过（真实模型测试沿用既有跳过条件），类型检查与两端构建成功。
- 清理未增删任何用例（`git diff -U0 -- tests` 无 `it(` / `test(` / `describe(` 声明行变化），测试条数与清理前一致。
- 未验证事项：未部署公开环境、未启动真实模型、未做 iPhone 真机验收；这些流程本轮未执行，不得记为已验收。
