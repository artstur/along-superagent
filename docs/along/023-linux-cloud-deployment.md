# V-1 实测记录：along-super-agent 在 Linux 云端独立部署

> 2026-11-23。环境：阿里云 ECS，Alibaba Cloud Linux 4，Docker 29.10.0 / Compose v5.8.0。
> 结论一句话：**可行**。沿仓库 `docs/cloud-deploy-multi-user.md` §3.5 Tier 2 挂起半年的 V-1 验证项判定通过。
>
> 本文记录**实测事实**（发行物实际提供什么、Linux 上装什么要多久、要多少内存与磁盘、
> 这台 ECS 的网络有什么坑），不是部署手册 —— 部署编排由沿仓库 `deploy/` 承担。
> 沿仓库 `origin/feature/tier2-cloud-orchestration` 分支已据此实现 Tier 2 编排
> （`deploy/Dockerfile.superagent`、`deploy/superagent-start.sh`、`deploy/superagent-seed.mjs`、
> `deploy/docker-compose.tier2.yml`），本文与它互补而不重复。

## 1. 背景：沿仓库此前为什么判定「不可行」

`along/docs/cloud-deploy-multi-user.md` §2.1 与 §3.5 写明：

> 官方 Linux 可运行发行物 `@deepseek-ai/dsh` 是 headless 一次性形态（无监听端口、每调用一个进程退出），承载不了长驻数据面。

据此 §1 把 `/events`、`/sync`、`/notifications/*` 等新链路端点在云端定为 503（`ALONG_EVENT_INGEST=off`），云端 v1 只用一个 headless 一次性 runner（`deploy/agent-runner.mjs`）承接目标聊天。

**该结论与发行物实际内容不符。** 解包 `@deepseek-ai/dsh@0.2.2-rc.5` 后，包内 `README.zh.md` 明确写着：

| 入口 | 用途 |
| --- | --- |
| `dsh <name>` / `dsh --profile <name>` | 启动 `$DSH_HOME/profiles/<name>` 下的 profile |
| `dsh --profile <name> --from-default-profile <template>` | 用随附模板的副本替换/创建自定义 profile 后启动 |
| `dsh web` | 启动 Web profile |
| `dsh plugin --profile <name> <pnpm args>` | 在 profile 目录中转发 pnpm 管理该 profile 的插件 |

且「拒绝插件管理」只针对 `desktop` 这个 Electron 专属 profile（`src/plugin.ts:13,47,72`），普通 profile 的插件安装是放行的。npm 发行物同时自带 `@deepseek-ai/dsh-web-app` bundle（含 `dsh-host-webserver`、`dsh-web-frontend`、全套 `dsh-client-ui-*`）。

沿仓库当时的结论很可能只看了 headless 一侧（`dsh-headless`），未验证 `dsh web` 这条路径。

## 2. 实测环境

| 项 | 值 |
| --- | --- |
| 基础镜像 | `node:24-bookworm-slim`（DSH 0.2.2-rc.5 要求 `node>=24.9.0`） |
| DSH | `@deepseek-ai/dsh@0.2.2-rc.5`（全局安装） |
| bundle | `along-superagent` 仓库源码 → `pnpm install --frozen-lockfile` + `pnpm build` → `lib/index.js` |
| profile | `dsh superagent --from-default-profile web --dump-config` |
| 插件安装 | `dsh plugin --profile superagent add link:/opt/along-superagent` |

`cordis.patch.yml`（与 `along/tools/activate.mjs` 的 `patchDocument` 同口径）：

```yaml
- id: webserver
  config: { host: 127.0.0.1, port: 3082 }
- id: dsh-superagent
  config:
    stateDir: /var/lib/dsh/state
    alongStateDir: /var/lib/along/data
    alongBridgeTokenFile: /var/lib/along/data/bridge-token
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-along
  disabled: false
```

## 3. 一个必须知道的启动前置条件

**仅靠 patch 文件不足以让 setup 通过。** `src/app/setup.ts:16` 的判定是：

```ts
const localDeployment = (settings: Settings): boolean =>
  settings.sources.along?.enabled === true && settings.sources.github?.enabled === false
```

这是 **Settings 存储层**的记录，不是插件层的 disabled 开关。首次启动时 sqlite 里没有 `sources` 记录，于是 setup 走 GitHub 分支并报 `repositoryUnset`（`/orchestrator/api/state` 可见），Runtime 停在 `paused / setupPending`。

沿的 Mac 启动器已在 `along/tools/activate.mjs:260-265` 处理了这一点：**仅当业务库不存在时**（首次建库），用一段 node 脚本写入同一份 seed：

```js
store.saveSettings({ ...s,
  sources: { ...s.sources, along: {enabled:true,config:{}}, github: {enabled:false,config:{}}, feishu:{enabled:false,config:{}} },
  eval: { ...s.eval, mode: 'auto' } })
```

云端部署必须复刻这一步。注意 `node:sqlite` 读 TypeScript 源码需要 `--experimental-transform-types`（Node 24 对 `enum` 等语法仍报错）。

### 3.1 两种写库路径

实测用了两条路，都能让 setup 通过：

| 路径 | 做法 | 适用 |
| --- | --- | --- |
| 走 Store API | `node --experimental-transform-types` 引 `src/app/store.ts`，`store.saveSettings(...)` | 开发与验证；简单，但要能 import TS 源码 |
| 直写 kv 表 | `node:sqlite` 直接 INSERT `settings-version:<n>` 与 `settings-revision` 指针 | 正式编排；沿仓库 `deploy/superagent-seed.mjs` 走这条 |

直写 kv 时**必须同时写版本快照与指针两个键**：设置是**带版本**的快照，`settings-revision` 指向当前版本号，
`settings-version:<n>` 存第 n 版。少写指针，`Store.settings()` 读不到设置。
指针的值是 **JSON 数字**（`Store.get` 对 value 列做 `JSON.parse`，裸数字才能解析成 number）。
只写 kv 表即可，schema 由 Store 打开数据库时自己建；**不要预写 schema 版本键**，
那会让 Runtime 以为数据库需要迁移。

## 4. 实测结果

### 4.1 DSH 与 bundle 启动

```
dsh web: http://127.0.0.1:3082/?token=…
```

容器正常常驻，无崩溃、无重启循环。

**bundle 的装法（实测有效路径）**：本次用 `dsh plugin --profile superagent add link:/opt/along-superagent`，
pnpm 在 profile 目录里装，`node_modules/dsh-superagent` 成为**可解析的包**（`lib/` 是构建产物，
必须真实存在于包内，否则运行时 `ERR_MODULE_NOT_FOUND`）。

沿仓库 tier2 分支走的是等价但更稳的路径：把 bundle 链进 **DSH CLI 的 node_modules 树**
（`deploy/superagent-start.sh`），理由与本文一致 —— bundle 必须与 CLI 同树，peer 依赖才解析得到；
只配 bundle 层（不落成可解析的包）会 `ERR_MODULE_NOT_FOUND`。

`dsh plugin` 与 profile 模板的关系有一处顺序要求：`--from-default-profile web` 会**重置**该 profile，
所以必须先铺模板、再装 bundle、再写 patch。

### 4.2 管理面 `/orchestrator/api/state`

```json
{
  "setup": { "problem": null },
  "health": {
    "runtime": { "state": "ready", "detail": "Orchestrator is ready" },
    "records": { "state": "starting" },
    "delivery": { "state": "ready" }, "relay": { "state": "ready" },
    "assessment": { "state": "ready" }, "reply": { "state": "ready" }
  }
}
```

`setup.problem` 为 `null`、Runtime 为 `ready` —— 即 `docs/006-deployment.md` 描述的「正常服务」状态。

### 4.3 Along 数据面 `/along-source/api/goals/along-status-probe`

请求头：`x-along-bridge: 1`、`x-along-bridge-token: <bridge-token 文件内容>`、`x-along-user: u_1a2b3c4d`、`x-along-device: d_5e6f7a8b`。

```
200 {"service":"along-source","ready":true}
```

这正是 `along-superagent/docs/006-deployment.md`「Along bridge readiness」表里 Tier 2 的判定条件：

> Require HTTP 200 with `service` equal to `along-source` and `ready` equal to `true` for Tier 2.

**V-1 通过。**

### 4.4 鉴权边界按预期收紧

| 请求 | 结果 | 含义 |
| --- | --- | --- |
| 无 bridge token | `401 {"error":"unauthorized"}` | 桥接凭证缺失被拒 |
| 身份形状不合规（`u_test`） | `403 {"error":"invalid_identity"}` | 凭证已过，身份守卫拦下 |
| 身份合规但未配对 | `403 {"error":"identity_mismatch"}` | 走到绑定检查 |
| 探针（合规合成身份） | `200 ready:true` | 服务级就绪 |

身份形状是硬约束（`src/along/api.ts:60-61`）：`/^u_[0-9a-f]{8}$/`、`/^d_[0-9a-f]{8}$/`。

### 4.5 产物与副作用

- `along.sqlite`（含 -wal/-shm，0600）在 `alongStateDir` 自动创建；
- `bridge-token`（65 字节，0600）在 `alongBridgeTokenFile` 自动生成；
- `worker-bin/gh`、`worker-bin/lark-cli` shim 自动生成，内容为明确的拒绝（Along-only 部署无 GitHub 账号 / 无飞书机器人）。

### 4.6 面板

`dsh web` 的鉴权是 token → cookie 交换：`GET /?token=…` 返回 303 并下发 `dsh-auth-*` cookie，随后 `GET /` 返回 200 与完整前端 HTML（41 KB）。面板可达。

## 5. 本机资源账（实测）
这台 ECS 同时跑着 `multica` 的三个容器（postgres / backend / frontend），along-super-agent 是第四个。

| 项 | 实测值 | 说明 |
| --- | --- | --- |
| 总内存 | 3.5 GB（3557 MiB） | 阿里云 ECS，2 核 |
| 当前可用（MemAvailable） | 1.9 GB | 含 buff/cache 1.7 GB |
| CPU | 2 核 | |
| 磁盘 | 40 GB，可用 20 GB | 镜像已占 4.3 GB，构建缓存 2.7 GB |
| superagent 容器 idle | **45 MiB / 3.474 GiB，CPU 0.14%** | 只起了 orchestrator，无 worker、无模型调用 |
| 业务库体积 | orchestrator.sqlite 168K + along.sqlite 592K | 空库 |
| 沿仓库对 agent 容器的设计上限 | `mem_limit: 2g`、`cpus: 1.5`、`pids_limit: 192` | 依据「4 dsh 并发 ≈ 数百 MB～1GB」 |
| 沿仓库对 host 容器的设计上限 | `mem_limit: 512m`、`cpus: 1.0` | |
| Hy-Memory Python RSS（Mac 实测样本） | 峰值 230 MiB | `along-superagent/docs/along/006-memory-implementation.md` §实测结果；文档明确「不是连续峰值，也不是长期内存稳定性证据」 |

**结论：这台机器跑「superagent 单独 + 空载」绰绰有余；跑「superagent + 4 路并发 worker + Hy-Memory + 沿 Host」会很紧张。**

三个真实约束：

1. **并发上限必须降。** 沿的设计假设 agent 容器可以吃到 2 GB / 1.5 核。本机只有 1.9 GB 可用，且要分给 host 容器（512 MB）、Hy-Memory Python 进程（~230 MB）与系统。`executor.maxWorkers` 需从默认 3 降到 1–2。
2. **磁盘是更紧的弦。** Hy-Memory 的依赖链（chromadb + onnxruntime + tokenizers + kuzu）在 `python:3.12-slim` 上装完约 1.5–2 GB；加上 DSH 发行物与构建缓存，20 GB 可用空间会被显著吃掉，需要预留清理策略。
3. **这台机器不是空机器。** `multica` 三个容器常驻，正式部署前要先决定 along 是否要与 multica 同机 —— 若要，建议单独一台 4 核 8 GB 的机器，而不是在这台上挤。

另：本次 Hy-Memory 镜像构建实测因 **apt 源（deb.debian.org）下载极慢**（20 分钟未完成一个 `apt-get install`）而被迫中止，改用「不装编译工具链、纯 pip 路径」重试。`langdetect` 只有 sdist 但为纯 Python，`chromadb` / `kuzu` 均有 cp312 manylinux wheel —— **不需要编译器**，因此镜像可以做得比原设计更小（原设计装了 build-essential 再删）。

### 5.1 网络是这台机的一个硬约束

pip 官方源 `files.pythonhosted.org` 实测只有 **27 kB/s**，`hy-memory` 的依赖树（chromadb + onnxruntime + tokenizers + kuzu）直接拉超时失败。阿里云 pypi 镜像实测 **176 kB/s**（快 6.4 倍），换源后可正常下载。

同理，`apt-get` 也慢到不可用 —— 正式镜像的构建应：
- 全部依赖走 **阿里云镜像**（pypi 用 `mirrors.aliyun.com/pypi/simple/`，apt 用 `mirrors.aliyun.com/debian`）；
- **不装编译工具链**（无 C 扩展需要编译）；
- 基础镜像在**本机构建并保留**，避免在服务器上重复拉取。

### 5.2 扩容建议（本次拍板：就用这台，Host 暂不接）

部署形态 = **只跑 superagent 一个长驻服务**（Along Host 暂不接入），因此容量需求明显低于沿仓库原设计（host 容器 512m + agent 容器 2g 的两段式不再需要）。

按组件拆：

| 组件 | 内存 | 依据 |
| --- | --- | --- |
| superagent 空载 | **实测 95 MiB RSS**（容器 45 MiB） | 本次实测 |
| superagent + N 路并发 worker | 每路 ~150–250 MiB | 沿仓库口径「4 并发 ≈ 数百 MB～1GB」 |
| Hy-Memory Python 进程 | ~230 MiB 峰值 | 沿仓库 Mac 实测（`006-memory-implementation.md`） |
| Docker daemon + 系统 + multica | ~1.1 GB（已实测占 565 MiB + 系统） | 本次实测 |
| 磁盘 | 镜像 2.6 GB（DSH）+ ~1 GB（Hy-Memory）+ 构建缓存 2.7 GB + 数据卷 | 本次实测 |

**推荐配置：4 核 8 GB**（当前 2 核 3.5 GB 需扩容）。

- 内存 8 GB：system+multica ~1.1 GB + superagent 并发 ~1 GB + Hy-Memory ~0.3 GB + 余量，宽松。
- 若只保持 superagent 空载 + 单 worker + Hy-Memory，4 GB 也够，但并发一上来就会触发 OOM。
- CPU 4 核：`executor.maxWorkers` 可保持默认 3（沿的默认 `maxWorkers: 3`），DSH worker 是子进程，2 核下并发会互相拖慢。
- **磁盘至少 60 GB**：当前 40 GB 已用 18 GB，加上 Hy-Memory 镜像与构建缓存会逼近上限；沿的 `along.sqlite` 与 Hy-Memory 的 Chroma/Kuzu 数据目录都会持续增长。

**在这台机（3.5 GB）上的临时降级方案**，若不扩容也能先跑起来：
- `executor.maxWorkers` 从 3 降到 1；
- `mem_limit` 给 superagent 容器 1.5g，不设 Hy-Memory（走 SQLite 降级）；
- 先清构建缓存（`docker builder prune`）腾出 2.7 GB；
- 不用 Hy-Memory 时沿的 SQLite 降级语义明确（文档：「Omit `alongMemory` to retain local governance and explicit SQLite fallback; this does not silently disable conversations」）。

### 5.3 Hy-Memory 在 Linux 上的实测结论

**可行。** 与 Mac 路径同版本、同依赖，不需要编译器。

| 项 | 结果 |
| --- | --- |
| 安装 | `pip install hy-memory==2.0.16` 成功（`PIP_RC=0`），**不需要 build-essential** |
| import 自检 | `hy_memory` / `kuzu 0.11.3` / `chromadb 1.5.9` 全部 OK，与 Mac 端同版本 |
| 安装体积 | **778 MB**（`/opt/pkgs`，python:3.12-slim-bookworm 基础镜像另计 188 MB） |
| offline 探针 | `{"mode":"offline-transport","hy_memory":"2.0.16","dimensions":1024,"kuzu_native_query":true,"add_search_reopen":true,"offline_calls":{"embeddings":4,"llm":1},"seconds":5.838}` |

`kuzu_native_query: true` 说明 Kuzu 原生图查询在 Linux x86_64 上正常；`add_search_reopen: true` 说明写入→检索→重开后检索这条完整链路通过。

两个必须知道的事实：

1. **`langdetect` 与 `jieba` 只有 sdist**（纯 Python），pip 会现场构建 —— 这不需要编译器，但会让安装多花几分钟。
2. **探针结尾的 `Task was destroyed but it is pending` 与 `AttributeError: 'NoneType' object has no attribute 'execute'` 是已知现象**，沿仓库 `docs/along/004-phase0-validation.md` §3.3 与 `006-memory-implementation.md` 在 Mac 上记录过同一组现象（SDK 关闭时 pipeline trace 未落盘、SQLite cache 连接已关）。**不是 Linux 特有**，也不是本次引入。

### 5.4 镜像构建的三个约束（这台机专属）

1. **pip 官方源不可用**：`files.pythonhosted.org` 实测 27 kB/s，依赖树直接超时；必须用 `mirrors.aliyun.com/pypi/simple/`（176 kB/s）。
2. **apt 源不可用**：`deb.debian.org` 实测 20 分钟未完成一次 `apt-get install`；正式镜像应换 `mirrors.aliyun.com/debian`，并**避免任何 apt 安装**（本方案已证明 Hy-Memory 不需要编译工具链）。
3. **基础镜像在本机构建并保留**：DSH 发行物 + bundle 构建产物合计 2.63 GB，在服务器上重复构建既慢又占磁盘。



部署形态 = **只跑 superagent 一个长驻服务**（Along Host 暂不接入），因此容量需求明显低于沿仓库原设计（host 容器 512m + agent 容器 2g 的两段式不再需要）。

按组件拆：

| 组件 | 内存 | 依据 |
| --- | --- | --- |
| superagent 空载 | **实测 95 MiB RSS**（容器 45 MiB） | 本次实测 |
| superagent + N 路并发 worker | 每路 ~150–250 MiB | 沿仓库口径「4 并发 ≈ 数百 MB～1GB」 |
| Hy-Memory Python 进程 | ~230 MiB 峰值 | 沿仓库 Mac 实测（`006-memory-implementation.md`） |
| Docker daemon + 系统 + multica | ~1.1 GB（已实测占 565 MiB + 系统） | 本次实测 |
| 磁盘 | 镜像 2.6 GB（DSH）+ ~2 GB（Hy-Memory）+ 构建缓存 2.7 GB + 数据卷 | 本次实测 |

**推荐配置：4 核 8 GB**（当前 2 核 3.5 GB 需扩容）。

- 内存 8 GB：system+multica ~1.1 GB + superagent 并发 ~1 GB + Hy-Memory ~0.3 GB + 余量，宽松。
- 若只保持 superagent 空载 + 单 worker + Hy-Memory，4 GB 也够，但并发一上来就会触发 OOM。
- CPU 4 核：`executor.maxWorkers` 可保持默认 3（沿的默认 `maxWorkers: 3`），DSH worker 是子进程，2 核下并发会互相拖慢。
- **磁盘至少 60 GB**：当前 40 GB 已用 18 GB，加上 Hy-Memory 镜像与构建缓存会逼近上限；沿的 `along.sqlite` 与 Hy-Memory 的 Chroma/Kuzu 数据目录都会持续增长。

**在这台机（3.5 GB）上的临时降级方案**，若不扩容也能先跑起来：
- `executor.maxWorkers` 从 3 降到 1；
- `mem_limit` 给 superagent 容器 1.5g，不设 Hy-Memory（走 SQLite 降级）；
- 先清构建缓存（`docker builder prune`）腾出 2.7 GB；
- 不用 Hy-Memory 时沿的 SQLite 降级语义明确（文档：「Omit `alongMemory` to retain local governance and explicit SQLite fallback; this does not silently disable conversations」）。

## 6. 尚未覆盖的部分

| 项 | 状态 | 备注 |
| --- | --- | --- |
| 真实模型调用 | 未测 | 需要 DeepSeek API Key；`dsh-superagent` 的 model 配置走 profile 层的 `agent-default-model` |
| Worker 真实执行 | 未测 | 需要一张真实 Ticket；worker preset 的 bash 沙箱在 Linux 上未验证 |
| Along 事件摄取（`/events`） | 未测 | 需要 Host 侧配合；本轮按用户决定只跑 superagent 本身 |
| Hy-Memory | 见 §5.3 | Linux python3.12 + hy-memory 2.0.16 已单独验证通过 |
| 与 `along` Host 的联调 | 未测 | 属于本轮范围外（用户选择「只把 superagent 独立跑起来验证可用性」） |
| 长时稳定性 / 断电恢复 | 未测 | 需要观察期 |

## 7. 结论与影响

1. **V-1 通过**：Linux npm 发行物可以承载长驻 superagent，Tier 2 在技术上成立。
2. 沿仓库 `docs/cloud-deploy-multi-user.md` §2.1/§3.5 关于「Linux 只能 headless 一次性形态」的表述需要修订 —— 它与 `dsh web` 的实际存在相悖，是一份基于不完整信息的设计结论。
3. 云端正式部署的形态随之变化：不再需要「host + 一次性 runner」的二段式，superagent 可作为长驻服务直接承载 Along 数据面。**但这需要重新评估 §1 里「不做新链路数据面上云」的整条取舍**，因为它的唯一理由就是长驻运行时不可得。
4. 部署时必须包含 settings seed（§3），否则 setup 永远停在 `repositoryUnset`。

### 7.1 待沿仓库修订的具体位置

`origin/feature/tier2-cloud-orchestration` 已实现 Tier 2 编排并把 V-1 写成「已通过」，但**旧结论原文仍在**，
合入 main 时需要一并修订，否则两份结论并存：

| 位置 | 现文 | 建议 |
| --- | --- | --- |
| `docs/cloud-deploy-multi-user.md` §2.1 | 「已核实的官方 Linux 发行物 `@deepseek-ai/dsh` 是 headless 一次性形态（无监听端口、每调用一个进程退出），承载不了长驻数据面」 | 改为：发行物同时提供 `dsh web`（长驻 Web profile）与 `dsh headless`（一次性）；两者并存，headless 不是唯一形态。V-1 实测见本文 |
| 同上 §2.2 冲突表 C9 | 「DSH 核心运行时无 Linux 长驻形态」 | 该条已不成立，标注为 V-1 已推翻 |
| 同上 §1 | 「不做新链路数据面上云（Tier 2）」 | 该取舍的唯一理由是长驻运行时不可得；V-1 通过后需重新评估（tier2 分支已实际开启，§6.5） |
| 同上 §3.5 | 「Tier 2（验证项 V-1，不在本轮验收范围）」 | 改为已通过并给出就绪契约 |

### 7.2 本轮未覆盖、tier2 分支需继续验证的

tier2 分支的实现比本轮独立验证的范围更大（Host 接入、公网 IPv4 HTTPS、TLS 与 CA、回退路径），
这些**本轮完全没测**。本轮只证明了 superagent 本体能在 Linux 长驻并承载 Along 数据面：

- 真实模型调用与 Worker 真实执行（真实 Ticket、bash 沙箱在 Linux 上的行为）；
- Host 与 superagent 的实际联调（配对、事件摄取、投递泵的端到端）；
- 公网形态的 TLS / CA / 回退；
- 长时稳定性与断电恢复；
- Hy-Memory 的真实模型质量（offline 只证明管道，不证明质量）。

