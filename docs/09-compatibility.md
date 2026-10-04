# 09 兼容性说明（Compatibility）

> 版本：v3.1.5（当前仓库发布基线；用量与额度功能以当前插件/API 实现为准） · 面向：开源使用者 / 二次开发 / 多设备部署

> ⚠ **平台范围（issue #6）**：`/m/api/files*`（文件下载/上传）的 TOCTOU 防护基于 descriptor-relative 语义，**仅 Linux/macOS 可用**；**Windows 返回 `503 files-unavailable`**（安全 fail-closed，理由见 docs/04 §6）。其余功能（会话、消息、审批/问询、目录浏览、通知、推送、用量查询）不受平台限制。

本文回答两个问题：**App 在哪些手机上能跑**，以及**插件在什么样的 Harness 上能跑**。

---

## 1. 版本要求

| 组件 | 要求 |
|---|---|
| 桌面端 DSH（Harness） | 插件不按宿主版本号硬拦截；可用性取决于宿主提供的 Remote RPC、事件桥等接口。诊断提供 `services` / `checks`，**并自 v3.1.6 起提供宿主能力三态报告**（`checks.hostCapabilities` 的 `ok`/`drift`/`missing` 与 `checks.hostGeneration`）；仍**不返回宿主版本号**，因此不要把插件版本推断为宿主能力。见 §2.6 |
| dsh-mobile-remote 插件 | **v3.1.5**；`/m/api/diagnostics` 提供 `services` / `checks`，并提供 `/m/api/account-usage` |
| 手机 App（Android） | v3.1.5（与插件同版本便于配对；不同版本按 API 增量兼容）；Android 7.0+、64 位机型 |
| 字段级兼容（v3.1.0） | `reasoning`/`title` 为纯增量字段：新插件+旧 App 无影响（忽略新字段）；新 App+旧插件自动回退（不渲染折叠块 / 悬浮球标题兜底短码）——任意组合均可使用 |
| 字段级兼容（v3.1.1） | `/m/api/directories` 根视图新增 `sep`（服务端路径分隔符）；新插件+旧 App 忽略该字段即可（旧 App 在 WSL 上仍按 `\` 拼接，由服务端`normalizeServerPath` 归一化兜底，浏览/建夹/建会话均可用）；新 App+旧插件缺少 `sep` 时按根视图推断分隔符——任意组合均可使用 |
| 字段级兼容（v3.1.3） | `/m/api/diagnostics` 增加审批策略与远程事件桥状态（`checks.approvalMode` / `checks.remoteEvents`）；旧版 App 忽略新增字段，不受影响 |
| 用量与额度（v3.1.5） | 新插件+新 App 通过 `/m/api/account-usage` 显示 DeepSeek/Codex/OpenCode Go；旧 App 忽略新端点。新 App+旧插件进入该入口会显示“电脑端插件版本过旧”，不影响其它功能；升级插件后无需重新配置凭据 |
| 悬浮球面板用量与额度（v3.1.5，ADR 0008） | 新 App+新插件：面板展开时按需展示三来源区块（金额行文字 + 配额行细条/颜色），整块可点进详情页。新 App+旧插件：区块整体降级为原有单行余额（点击仍=去充值），其余面板功能不受影响；旧 App 忽略新端点。无新增服务端契约 |
| Flutter 构建环境 | Flutter 3.35+（Dart SDK ^3.13） |

**快速自检**：手机 App → 设置 → 环境诊断。`services` 一节列出每个内核服务是否存在；**v3.1.3+ 看 `checks.approvalMode`**（生效策略）与 **`checks.remoteEvents`**（`true` = `$events` 双端呈现通道就绪，`false` = both 降级 mobile 或配置即 mobile/desktop）；`notes` 说明当前审批策略实际语义与**任何非全绿的宿主能力**。

**v3.1.6+ 新增两项宿主能力自检**（ADR 0017）：

- `checks.hostCapabilities`：逐项给出三态——`ok` / `drift` / `missing`。`drift` 是**能力语义漂移**（服务在、调用不报错，但成员形状不是插件认识的样子），这正是 0.2.0 四处变更的形态，旧的两分法看不见它们。
- `checks.hostGeneration`：插件**实际走了哪条代际路径**（`jobsCaller` / `settingsRead` / `wireStreamArgs`），排查"为什么同一功能在两台机器上表现不同"时先看这里。

`services.apiProxy` / `checks.respondBridge` / `checks.frameBridge` **已随 v3.1.6 删除**：该服务自 `0.1.2-rc.1` 起就不存在，保留它们只会让人以为有一条可用的旧代降级通道。同样地，`/m/api/respond` 在待办不在本地清单时返回 `404 respond-not-pending`（此前返回 `503` 并归咎于"内核过旧"，属误导——真实原因通常是"另一端已先答"或"已超时"）。

---

## 2. 内核耦合点与降级行为

插件与 Harness 的耦合分三档：**硬依赖**（缺失 = 对应功能不可用）、**软依赖**（缺失 = 功能降级）、**可选**（缺失 = 自动禁用该功能）。插件对每个依赖都做了存在性探测，**任何一项缺失都不会让插件崩溃或影响其他功能**；能力缺失一律**明确报错**，不静默伪装成功（[ADR 0001 = Issue #9](https://github.com/marktrue-ahu/dsh-mobile-remote/issues/9)）。

### 2.1 服务（`ctx.get` / `ctx.inject`）

| 服务 | 用途 | 档位 | 缺失时行为 |
|---|---|---|---|
| `webServer` | 挂载 `/m/api`、`/m/events`、`/m/qr.png` 路由 | 硬依赖（插件存在的意义） | v2.4 起守卫：纯 headless 形态下插件静默无操作，不崩进程 |
| `sessions` | 会话列表/touch/创建/停止 | 硬依赖（内核核心） | 移动端会话功能不可用 |
| `agents` | 会话创建、状态 | 硬依赖（内核核心） | 同上 |
| `workspaceRegistry` | 工作区列表、会话归档（与 PC 端同一份状态） | 软依赖 | 归档/工作区筛选不可用；App 回退为 cwd 前缀分组（旧版兼容路径） |
| `messageFeedback` | 消息 👍/👎（与 PC 端同一份） | 软依赖 | 反馈菜单隐藏/报错 |
| `approval` | 权限策略读取（`setPolicy` 仅当存在时调用） | 可选 | 跳过策略写入 |
| `credentials` | DeepSeek 余额查询 | 可选 | 回退环境变量 `DEEPSEEK_API_KEY`；都没有则余额不可用 |
| `approval/request`·`user-questions/request` 瀑布 | Agent 作用域 Cordis 瀑布，插件 answerer 应答（当前代际的交互入口） | 软依赖 | 无瀑布宿主时问询/审批**无手机弹卡**（旧代 `apiProxy` 帧桥已于 v3.1.6 删除，不存在该降级出口；见 §2.6） |
| `typertGateway` — Remote 调用入口（`invokeRpc`） | 模型目录、会话配置、发送、队列操作、归档、分支、目标等 RPC | 硬依赖 | 调用失败时对应 API 返回错误；当前诊断不会输出独立的 `host.capabilities` 状态，请结合宿主版本和运行日志排查 |
| `typertGateway` — `$events` 远程事件桥（`openWireStream`） | 插件进程内 `$events` 客户端：与桌面 GUI 同收事件副本、先答生效 | 可选（v3.1.3） | 桥不可用时 `approvalMode: both` 按 `mobile` 语义降级；`checks.remoteEvents` 和运行日志可辅助诊断 |
| `sessionController`（`prompt`） | 冷会话恢复：不在 live agent 注册表里的持久会话发送 | 冷会话路径依赖 | 宿主若不支持该调用则发送失败；当前诊断不提供该能力的独立布尔字段 |
| `apiProxy`（旧代，0.1.1-rc.2 及更早） | 问询/审批帧桥 + 应答回写 | **弃用通道**（ADR 0001） | **两代宿主（0.1.5 / 0.2.0）内核树内均 0 命中**，插件侧的探测与帧桥代码**已于 v3.1.6 整块删除**（issue #19）：保留它的唯一效果是让读者以为存在一条可用的旧代降级通道 |

> ⚠ **approvalMode（v3.1.3，issue #9）语义**：`both`（默认）= 桌面 GUI 与手机同时弹卡、任一端先答即生效、另一端自动收卡；`mobile` = 手机在线独占应答（v3.1.2 行为），离线交桌面 GUI；`desktop` = 一律交桌面 GUI（手机不弹卡）。手机在场时待办 120s 无应答 fail-close（`unavailable` / 问询跳过）。配置于 `cordis.patch.yml` → mobile-remote 行 `config.approvalMode`，重启生效。

### 2.2 事件与 RPC

| 内核接口 | 用途 | 风险与降级 |
|---|---|---|
| `ctx.on("session/event")` | 消息流/通知聚合/上下文窗口/队列即时同步/Conversation timeline | 事件形态随版本演进；未知类型进入通用事件卡，能力缺失时 App 回退摘要模式；解析异常被 try/catch 兜底 |
| `ctx.on("agent/inbox/spliced")`（经 `session/event` 送达） | 队列即时同步：内核任何生效的 inbox 变更都会 append 该会话事件，据此重推 `mobile/queue` 快照 | 事件名与载荷在当前代际与上一代一致；缺失时手机队列退回 REST 轮询兜底（不报错，仅不实时） |
| `sessionQuery.readEvent`（可选） | Tool activity 与未知 Visible event 的按需无损详情 | 不存在时回退快照；旧历史详情明确显示不可用，不猜测重建 |
| `ctx.on("agent/status")` | 状态点（绿/橙） | 同上 |
| `session/modelCatalog` RPC | 模型目录（App 模型选择器） | 失败 → 目录为空，App 隐藏模型胶囊 |
| `settings.update`（`agent-presets` / `permission` 命名空间） | 默认预设修改 | 与 PC 端同一写入通道；命名空间变更会导致设置失败（App 报错提示） |
| `session/prompt` | 发消息（`mode: queue \| steer`，`requestId` **必填**） | `requestId` 由插件无条件铸造；缺失会被网关以 `gateway/input-invalid` 拒绝投递 |
| `session/fork` / `session/cancel` | 消息分支 / 停止 | 内核接口变化 → 失败提示 |

> ⚠ **子代理通知判定需要 `session.header.origin`**：通知聚合对子代理会话（`origin === "subagent"`）抑制完成/失败通知（与内核自身通知一致）；fork 出的独立会话（无 origin）照常通知。
>
> ⚠ **两层请求幂等并存（v3.1.3）**：当前代际内核新增了按 `requestId` 的幂等短路（会扫整条持久会话日志找同 `rpcId` 的 `user/message`），与插件自建的发件回执层（`/m/api/send` + `/m/api/send-receipt`）**职责不同、两层都保留**：内核负责「同一请求不重复执行」，插件负责「传输层中断后回答是否已送达」（`Connection reset by peer` 后重试不重复即由此保证）。

> ⚠ **Issue #1 时间线能力协商（纯增量）：** `/bootstrap` 与 SSE `hello` 的 `capabilities.eventTimeline` 声明 `detail`、`unknownEvents`、`callCorrelation` 等能力。新版 App 只在 `capabilities.eventTimeline.detail` 且事件摘要带 `detail.available` 时请求 `/event-detail`；能力是端点级声明，单事件仍可能因旧日志/离线而不可用。旧插件没有声明时继续使用已有摘要/历史路径，并把详情显示为不可用，不按插件版本号猜测能力。
>
> ⚠ **当前界面降级与 dormant-session 依赖：** seeded session 若只能读取当前 surface，`/event-detail` 返回 `degraded: true` 与 `detailMode: "current-surface"`，新版 App 展示不完整提示；无法读取时使用稳定错误码和重试，不显示原始异常。休眠会话的完整读取依赖 issue #7 的独立修复，本分支不复制该实现。
>
> ⚠ **`/bootstrap` 的 `agents[*].sessionId`（纯增量）**：`agentId` 与 `sessionId` 不是同一标识（`session:` 前缀、子代理场景），新版 App 按 session 维护运行状态，需要 bootstrap 一并下发映射，否则冷启动/重连后要等 `agent/status` 变化帧才知道会话在跑（发送键会短暂显示为「发送」而非「停止」）。旧插件不发该字段时 App 回退按 `agentId == sessionId` 取值。`agents[*].title` 的兜底短码也改由 sessionId 派生（旧插件缺字段时不影响）。

### 2.3 高度自定义化的 Harness

- **自定义权限预设/模型/Agent 预设**：App 全部从内核动态读取（catalog、session-config），不内置白名单；未知预设名显示为「…」（后续版本可拉取预设清单美化）。
- **第三方插件动作**：`ctx.mobileActions.register(...)` 注册后自动出现在 App 动作区（v0.1 契约：仅 text 字段）。
- **自定义问答 provider / 自动审批策略**：若用户的 Harness 已经接管人类问询（如自动答题插件、审批策略改为自动放行），内核**不会产生** `question/requested` / `approval/requested` 帧——手机不弹窗是**正确行为**，不是 bug。
- **多 profile**：插件按 profile 安装（`<profile>/node_modules/dsh-mobile-remote`），每个 profile 独立配置口令/连接。
- **内核依赖与宿主 API 需匹配**：`package.json` 声明的 peer dependency 范围是包管理器约束，不等价于对 DSH 宿主版本的运行时兼容保证。profile 若装有与宿主不匹配的依赖副本，可能导致 RPC 失败；升级后按 [安装说明](06-install-run.md) 检查并重装依赖。

### 2.4 旧代际与弃用通道

插件当前没有宿主版本硬拦截，也没有统一的宿主能力清单；服务可用性由具体路由和交互流程决定。宿主 API 不匹配时，相关调用可能失败或按现有降级路径处理，不应假设所有缺失能力都会映射为专用 503 错误。旧代 `apiProxy` 兼容分支**已于 v3.1.6 删除**（该服务自 `0.1.2-rc.1` 起就不存在），当前只保留 `$events` 网关路径；`dispatchRpc` 等宿主接口属于集成边界，升级 DSH 后应运行对应契约测试并在目标宿主验证问询/审批结算。

### 2.5 验收范围（如实标注）

自动化验证由仓库中的 Node 契约测试、Flutter 测试和 Android 构建组成；更新安装器、宿主 RPC 与系统权限流程仍需在目标 DSH 宿主和 Android 设备上人工验收。未执行的设备/宿主组合应标记为未验证，不从其他环境的结果推定兼容。

---

### 2.6 两代宿主 API 适配（v3.1.6，issue #19 / #21）

宿主 `0.2.0` 有**四处**接口与 `0.1.x` 不同。四处**全部表现为静默失败**——服务在、调用不报错、行为却已变（"能力语义漂移"，见 `CONTEXT.md`）。插件按**结构特征**探测代际并各走一条路径，不查版本号（ADR 0017）：

| 差异 | `0.1.x` | `0.2.x` | 插件如何判别 | 传错的后果 |
|---|---|---|---|---|
| 任务查询/终止的 caller | **Agent 对象**（实现内部取其 `.id`） | **SessionId 字符串** | `jobs.events.subscribe` 是否存在（两处差异同版发生） | 列表恒返回空（像"确实没有任务"）；终止报"任务属于另一个会话" |
| 任务事件订阅 | `onJobsChanged` + `onJobDone` 两个回调 | 统一的 `events.subscribe(filter, listener)` | 同上 | 实时推送静默退化为轮询 |
| 设置读取 | `get(ns)` 返回配置节 | `describe()` 返回描述符数组（取 `value`） | `typeof settings.get === "function"` | 抛出的类型错误被 `try/catch` 吞掉，提供商配置页字段凭空消失 |
| 事件流打开的参数位次 | `(端点, 载荷, 取消信号)` | `(端点, 载荷, uplink, peer, 取消信号, 控制)` | 形参个数（3 vs 6） | 信号落进 `uplink`、真 signal 为 `undefined`，宿主在 `AbortSignal.any` 处抛错并被重试吞掉 → `approvalMode: both` 的双端呈现**永远不就绪** |

**另有一类风险单独处理**：插件依赖的若干宿主成员是 **TS-private**（无契约保证）——权限预设的 `names`/`presets`/`apply`，以及工作区注册表的 `enqueueOperation`/`requireState`/`setState`（后者此前**完全无守卫**）。v3.1.6 起这些成员缺失时**显式报错**（503）或显式降级，不再让 `TypeError` 在深处被吞成"按了没反应"。**不迁移**到公开 API——那是行为改变，与本次兼容修复分开评估。

**`$events` 流断开改为退避重连**：原实现"就绪后一旦断开即永久放弃"，使 `approvalMode: both` 在首次断流后永久退化为手机独占，直到重启宿主——而桌面 GUI 每次开关浏览器都会断流。现语义：**就绪前**失败 = 事件源尚未注册（有界重试 ≈15s）；**就绪后**断开 = 瞬时断开（3s 起退避、上限 60s、无限重连，仅插件卸载才停止）。重新就绪后退避复位。

**`0.2.0` 另外两处破坏（issue #21，与上述四处同类，但位于 #19 未覆盖的位置）**：

| 差异 | `0.1.x` | `0.2.x` | 插件如何判别 | 传错的后果 |
|---|---|---|---|---|
| 子代理目录 | `subagents/list` Remote 端点 | **该端点已删除**（内核树内 0 命中；只剩 `subagents/prompt` 与 `subagents/interruptByParent`） | 改用 `ctx.subagents.listChildren(parentSessionId)`——**两代都提供**，是持久目录（走 `sessionQuery.observeSession`，**不要求父会话有活跃 Agent**） | 报 `no active Remote method exports this endpoint`，「会话工具 → 子代理」整页打不开 |
| Codex 代理配置 | `settings.get(ns)` | **该方法已移除** | 跨代读取 `readSettingsSectionStrict` | **读不到配置被误判为"用户没开代理"** → 静默改走直连 `chatgpt.com` → 连接超时 → 手机看不到 Codex 余额（桌面网页端正常，因为它用自己的新 API 读同一份设置） |

**"读不到配置"与"未启用"必须分开**：`codexProxyUrl` 返回三态——用户没开代理（走直连是对的）／代理可用／**读不到宿主设置**（`unreadable`，显式失败）。把第三种当成第一种，是 Codex 余额静默消失里最隐蔽的一环。严格读取还会区分「命名空间确实不存在」与「`get()`/`describe()` 抛错、describe 形状漂移、描述符缺 `value`」——后者一律 `unreadable`。

**失败原因不外传**：`/m/api/account-usage` 的 `failures[].reason` 只给**稳定错误码 + 固定文案**（`timeout` / `dns` / `connection-refused` / `invalid-request` 等），**绝不回传异常原文**。凭据含内嵌 CR/LF 时，原生 fetch 的 Headers 校验会抛出带完整 Bearer 密钥的消息，而**路径脱敏不等于秘密脱敏**。

**子代理列表的完整性**：不能拿会话注册表当子代理目录——`sessions.list()` 只有 **live/驻留**会话，continuable 子代理结束并释放 handle 后会从中移除，而持久目录仍保留其身份。只用注册表会在父会话还活着时"成功却显示暂无子代理"。目录读不到时退回注册表并标注 `catalogDegraded`，**不让不完整列表冒充完整目录**。

**验证范围（如实标注）**：只对 **`0.2.x` 做真实宿主端到端验证**（本机宿主即 0.2.x）。`0.1.x` 那条路径的真实宿主验不到，**靠两代假宿主夹具保护**（`test/host-compat-020.test.mjs`：按真实签名复刻两代差异，让两条分支都被实际执行到）。因此 0.1.x 一侧属于"夹具已验证、真实宿主未验证"。

---

## 3. Android 多品牌适配

App 为 Flutter 原生 APK（`com.dsh.remote`），渲染后端为 **Impeller（Vulkan，自动回退 OpenGLES）**。

| 维度 | 状态 | 说明 |
|---|---|---|
| 渲染 | ✅ 已验证（小米 17 Pro Max） | Flutter 引擎在无 Vulkan 机型自动回退 GLES；再老机型回退 Skia。历史风险点：部分旧 Mali GPU 的 Impeller 花屏（2024 年问题，现版本基本修复） |
| 系统版本 | Android 7.0+ | minSdk 跟随引擎默认 |
| 明文 HTTP | ✅ | `usesCleartextTraffic=true` 已配置（Android 9+） |
| 扫码 | ✅ | mobile_scanner（CameraX）全品牌通用 |
| 后台存活 | 部分依赖系统 | 国产 ROM 杀后台会断 SSE；App 有指数退避重连 + 回前台自动探测。系统级提醒走推送桥（ntfy/Bark/Server酱），不依赖 App 存活 |
| 深色/字体缩放 | ✅ | Flutter 主题自适应 |

**建议发布前实测**（借 1~2 台其他品牌即可）：① 长时间流式回复渲染；② 上翻深历史（Impeller 表现）；③ 熄屏后回前台自动重连。

**如遇渲染异常**：把 `dsh-mobile-app/android/app/src/main/AndroidManifest.xml` 中 `EnableImpeller` 改为 `false` 出一个 Skia 版验证；App 代码无需改动（列表结构两种后端都验证过）。

## 4. iOS（未开发）

> **原因**：开发者手上没有苹果设备（Mac/iPhone），无法构建、真机调试与签名分发 iOS 版本——因此 iOS 端**暂未开发**。**欢迎社区贡献**：iOS 适配工作量不大，任何有 Mac 的开发者都可以按下面清单完成并提交 PR（见 CONTRIBUTING.md）。

- **Dart 代码零平台依赖**，5 个插件（shared_preferences / http / path_provider / mobile_scanner / url_launcher）均有 iOS 实现；iOS 只有 Impeller 后端，而列表结构恰在 Impeller 下验证过——代码几乎不用改。
- 需要：Mac + Xcode + Apple 开发者账号（自用免签/TestFlight）。
- 必须的配置项（预计半天）：`Info.plist` 放行局域网 http（ATS `NSAllowsLocalNetworking`）、iOS 14+ 本地网络权限文案（`NSLocalNetworkUsageDescription`）、相机权限文案。
- 分发：自用可用免费账号侧载（7 天重签）；公开分发走 TestFlight/App Store（需付费开发者账号）。

## 5. 已知问题清单（发布时如实告知）

| # | 问题 | 影响 | 状态/缓解 |
|---|---|---|---|
| 1 | 问询/审批的**出站结算**依赖网关未文档化的私有方法 `dispatchRpc` | 上游若变更该通路，问询/审批在手机在线时会失效而非降级 | 启动时探测可调用性 → 缺失则 `checks.remoteEvents=false` 且瀑布按 `mobile` 语义工作（不弹出无法应答的卡片）。见 ADR 0001 |
| 2 | 自定义权限预设名在 App 显示「…」 | 纯展示 | 后续拉取预设清单 |
| 3 | 国产 ROM 杀后台导致通知延迟（App 内角标） | 通知不及时 | 推送桥不受影响；App 重连后补拉 |
| 4 | Impeller 在极老 GPU 的潜在渲染问题（未实测） | 少数旧机可能花屏 | manifest 一行回退 Skia |
| 5 | 大体积消息（数万字符）首次滚动定位 | 仅首屏定位，无功能损失 | 列表已按段加载（50 条/页） |
| 6 | 明文 HTTP 通信 | 仅限可信内网 | 设计如此（docs/04-security.md）；公网必须虚拟组网（蒲公英推荐）/ TLS 反代（docs/06 §5/§6b） |
| 7 | 通知记录删除后，同会话同类事件会再生成新通知 | 符合预期（删除≠静音） | 已文档化 |
| 8 | GIF 发送后显示静态 | 与 PC 端一致（内核附件规范化取首帧重编码）| 动态链路已就绪（Flutter 原生支持），待内核保留动画附件 |
| 9 | 思维链块仅标题行（图标+字数+箭头）可点击切换，正文为可选中文本（点正文不切换，属设计） | 轻微认知成本 | 已文档化；折叠状态 v3.1.0 起按消息持久化（滚动/重进/重启保持） |
| 10 | 旧版 App（≤v3.0.0）在 WSL/类 Unix 服务端浏览目录会拼出 `/\home` 形态的路径 | 旧 App 在 WSL 端目录浏览受限 | **v3.1.1 已修复**（服务端 `normalizeServerPath` 归一化）；新版 App 按服务端 `sep` 拼接，任意组合可用 |
| 11 | 与 dsh-web 移动端远程（`@linxin666/dsh-remote-web-ui`）同装冲突 | 两者抢 `/m` 路由前缀（对方写死不可配），可能异常/崩溃 | 本插件 `path` 改 `/mr` 等非 `/m` 单段即可共存（App 自动适配，无需重装）；详见 FAQ |
| 12 | 手机在线时桌面端不弹审批/问询框（v3.1.2，issue #9） | 桌面用户无法在 PC 审批/应答（只能手机答或 120s fail-close） | **v3.1.3 修复**：默认 `approvalMode: both` 双端同卡、先答生效（0.1.2-rc.1+）；旧宿主/历史版本可用 `approvalMode: mobile \| desktop` 明确策略 |
| 13 | `approvalMode: both` 依赖内核 `$events` 通道 | 旧宿主（0.1.1-rc.2 及更早）无法双端同卡 | 自动降级 mobile 并写日志；诊断 `notes` 可查 |
| 14 | 宿主 API 存在**静默语义漂移**（服务在、调用不报错、行为却已变） | 升级宿主后功能"看起来正常但没有内容"，且旧的两分法探测（存在/缺失）看不见它们 | 能力三态报告（`checks.hostCapabilities` 的 `drift` + `checks.hostGeneration`）+ 两代假宿主夹具；见 §2.6、ADR 0017 |

## 6. 内置常量与"写死"数据速查

**零敏感写死**：口令、密钥、推送凭据全部在用户配置（`cordis.patch.yml`）或手机本地，代码与仓库中无任何密钥硬编码。

| 类别 | 内容 | 说明 |
|---|---|---|
| 设计令牌（有意） | 品牌色 `#426EFE` / 深色 `#0E1116` 等（App `theme.dart`）、`com.dsh.remote`、QR 协议 `DSHREMOTE\|地址\|口令`、`EnableImpeller=true` | 产品设计/通信契约，勿随意改 |
| 内核耦合词（有意） | 系统消息过滤词 `Current runtime context` / `This snapshot supersedes` / `background job `（App `chat_screen.dart`） | 与内核/PC 端保持一致的隐藏规则 |
| 插件可配置项 | `path` / `authToken` / `cookieName` / `sessionTtlMs` / `rechargeUrl` / `maxConnections` / `pushUrls` / `pushCooldownMs` / `pushContent` / `rateLimit` / `trustedHosts` / `doneGraceMs`（v2.8.0）/ `lanBridge`（v3.0.0：`{enabled, port, host}`，默认关）/ `approvalMode`（v3.1.3：`both` 默认 \| `mobile` \| `desktop`） | schema 默认值，改配置即可 |
| 插件内置常量 | 通知上限 100、catalog 缓存 15s、SSE 心跳 25s、SSE 超时 15s、登录限流默认 10 次/60s（`rateLimit` 可配）、状态文件 `~/.dsh/mobile-remote/` | 合理默认，无需配置 |
| App 内置常量 | HTTP 超时 15/20s（余额 25s）、连接/探测超时 8s、地址表上限 8、重试退避 1s→15s、看门狗 15s 检查 / 心跳 75s（3 周期）、日志保留 15 天/256KB、聊天初始窗口 50 条、历史分段 30 条、上下文圆环阈值 70%/90%、思维链折叠手动状态键 `dsh_mr_reasoning_overrides`（按会话持久化，每会话软上限 100 条） | 合理默认；修改点集中在各文件顶部常量 |
| 已消除的写死 | 充值链接（原 App 硬编码 `platform.deepseek.com/top_up`） | v2.4.2 起走 `catalog.rechargeUrl`（插件配置为准） |

## 7. 发布签名

- Release APK 需正式 keystore：`dsh-mobile-app/android/app/dsh-release.jks` + `android/key.properties`（**均已 gitignore，切勿提交**）。
- 干净克隆无 key.properties 时自动回退 debug 签名（仅自用可安装；商店/公开分发必须自建 keystore）。
- 自建方法见 `dsh-mobile-app/README.md`「构建」一节。
- ⚠ 更换签名 = 新应用：用户需卸载重装并重新扫码。
