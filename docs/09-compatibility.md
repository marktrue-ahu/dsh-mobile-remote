# 09 兼容性说明（Compatibility）

> 版本：v3.1.1 基线（RC1 适配在 `feature/dsh-0.1.2-rc1-compat` 分支实施，尚未发布新版本） · 面向：开源使用者 / 二次开发 / 多设备部署

本文回答两个问题：**App 在哪些手机上能跑**，以及**插件在什么样的 Harness 上能跑**。

---

## 1. 版本要求

| 组件 | 要求 |
|---|---|
| 桌面端 DSH（Harness） | 支持 **v0.1.1-rc.2** 与 **v0.1.2-rc.1**；前者使用旧 `apiProxy`/`/api` Remote，后者使用 Typert Gateway/Remote Event。更低版本可能缺少 `apiProxy`、`workspaceRegistry`、`commands` 或 Gateway 服务，功能会按 §2 降级 |
| dsh-mobile-remote 插件 | **v3.1.1 基线（与 App/git tag 版本号统一）**；RC1 适配完成前不改正式版本号；`/m/api/diagnostics` 可自检 |
| 手机 App（Android） | v3.1.1 基线（与插件同版本 = 完美配对；不同版本可用但"谁旧谁吃亏"，详见 README「版本与兼容」）；Android 7.0+、64 位机型 |
| 字段级兼容（v3.1.0 候选） | `reasoning`/`title` 为纯增量字段：新插件+旧 App 无影响（忽略新字段）；新 App+旧插件自动回退（不渲染折叠块 / 悬浮球标题兜底短码）——任意组合均可使用 |
| 字段级兼容（v3.1.1） | `/m/api/directories` 根视图新增 `sep`（服务端路径分隔符）；新插件+旧 App 忽略该字段即可（旧 App 在 WSL 上仍按 `\` 拼接，由服务端`normalizeServerPath` 归一化兜底，浏览/建夹/建会话均可用）；新 App+旧插件缺少 `sep` 时按根视图推断分隔符——任意组合均可使用 |
| Flutter 构建环境 | Flutter 3.35+（Dart SDK ^3.13） |

**快速自检**：手机 App → 设置 → 环境诊断。`services` 一节列出每个内核服务是否存在；`checks.respondBridge` / `checks.frameBridge` 为 ✅ 表示问询/审批弹窗桥已就绪；`checks.pendingFrames` 是**计数**（当前挂起的待答弹窗数，0 = 正常无待答，>0 = 有问询/审批等待处理）。

---

## 2. 内核耦合点与降级行为

插件与 Harness 的耦合分三档：**硬依赖**（缺失 = 对应功能不可用）、**软依赖**（缺失 = 功能降级）、**可选**（缺失 = 自动禁用该功能）。插件对每个依赖都做了存在性探测，**任何一项缺失都不会让插件崩溃或影响其他功能**。

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
| `typertGateway` | RC1 Remote 调用、Remote Event 问询/审批桥 | RC1 必需（由 `ctx.inject` 获取） | `protocol` 回退为 `api-proxy-legacy`；受影响的 RC1 功能明确报错，不伪装为成功 |
| `apiProxy` | 0.1.1-rc.2 的问询/审批弹窗桥 + 应答回写 | 旧版可选 | `checks.respondBridge=false`，手机不弹问询/审批卡（PC 端不受影响）；`/m/api/respond` 返回 503 |
| `userQuestions` | （间接）问询链路 | 可选 | 无弹窗（同上） |

> ⚠ **两代 Host Remote 不能只做名称替换**：0.1.1-rc.2 的 `apiProxy` 使用旧 `/api` envelope；0.1.2-rc.1 的 Typert Gateway 要求命名 `args`、严格方法签名，并通过 `$events`/`$events/result` 传递问询与审批。适配集中在 [lib/rc1-adapter.js](../lib/rc1-adapter.js) 和 `lib/index.js` 的 Remote Event 桥；业务错误不会在两条协议之间重试，避免一次移动操作重复执行。

> RC1 事件桥在 Gateway stream 重连时复用已有 `eventId`，移动端 pending 帧只补发一次；回答前会校验会话、交互类型和审批结果。Gateway 不可用时，诊断会显示实际协议和桥状态，受影响功能返回明确错误。

### 2.2 事件与 RPC

| 内核接口 | 用途 | 风险与降级 |
|---|---|---|
| `ctx.on("session/event")` | 消息流/通知聚合/上下文窗口 | 事件形态随版本演进；未知类型一律透传不解析，解析异常被 try/catch 兜底 |
| `ctx.on("agent/status")` | 状态点（绿/橙） | 同上 |
| `session.models` / `session.modelCatalog` | 模型目录（App 模型选择器） | 旧版走 `session.models`；RC1 走无参数 `session/modelCatalog`，并把 RC1 `default` 归一为移动 API 的 `current`；失败 → 目录为空，App 隐藏模型胶囊 |
| `settings.update`（`agent-presets` / `permission` 命名空间） | 默认预设修改 | RC1 通过 `settings/update(ns, patch, expectedRevision)`；命名空间变更会导致设置失败（App 报错提示） |
| `session.prompt` / `session.fork` / `session.cancel` | 发消息、消息分支、停止 | RC1 统一把业务请求放入命名 `request`；错误透传并显示明确提示 |

> ⚠ **子代理通知判定需要 `session.header.origin`（DSH ≥ 0.1.1-rc.2）**：通知聚合对子代理会话（`origin === "subagent"`）抑制完成/失败通知（与内核自身通知一致）。旧内核 header 无 `origin` 字段时，子代理完成/失败通知会被放行（不影响功能正确性，仅通知噪音）；fork 出的独立会话（无 origin）照常通知。
>
> ⚠ **v3.1.0 候选新增字段（纯增量，无协议破坏）**：`assistant/message` 摘要的 `reasoning`（思维链正文，仅非空时下发，≤20000 字符）与 `/m/api/bootstrap` 的 `agents[*].title` / `sessions[*].title`（会话标题，空则兜底短码）。旧版 App 按 key 取值、忽略未知字段；旧版插件缺少这些字段时新版 App 自动回退（不渲染折叠块 / 悬浮球显示 id 短码）。两端任意组合均可正常使用。

### 2.3 RC1 适配边界

RC1 适配不复用 `dsh-std`，只在插件内集中转换 Host 差异。移动端 HTTP/SSE 接口保持原有字段和语义，`lib/rc1-adapter.js` 负责以下命名与参数边界：

- `session.prompt`、`selectModel`、`attachment`、`updateQueue`、`fork`、`cancel`、`page`、`workspace.archiveSession` 使用 RC1 的命名 `request` 参数；`session.list` 使用保留的 `_request` 空对象。
- `session.models` 调用 `session/modelCatalog`，将 RC1 的 `default` 映射为移动端继续读取的 `current`。
- RC1 的会话当前模型优先从 `model/selection` 与 `request/header` 事件折叠；冷会话读取 `session.list` 的 `modelSelection.next`，没有选择时才使用部署默认模型。
- `settings.update` 保持三个独立参数；`subagent.list`、`subagent.interrupt` 使用 RC1 的 `subagents` 命名空间；目标服务使用 `agentId` 查找会话。
- `user-questions/request` 和 `approval/request` 经 `$events` 转成现有 `question/requested`、`approval/requested` 帧；回答经 `$events/result` 结算（RC1 下走 Typert Gateway 的**进程内 `dispatchRpc`**，不走旧版 HTTP `/api` envelope——后者被浏览器会话认证栅挡住会 401）；事件流重连不重复弹出同一个 `eventId`。

当 `typertGateway` 未注入时，插件继续使用 0.1.1-rc.2 的旧 `apiProxy`/`/api` 通道。`/m/api/diagnostics` 返回 `protocol`（`typert-rc1` 或 `api-proxy-legacy`）、`services.typertGateway`、`remoteEventClientId`，用于确认实际选中的协议。已在真实 **0.1.2-rc.1** 宿主（Web CLI / Linux）验证：`protocol=typert-rc1` 生效、`$events` stream 收到 `ready`、真实 `ask_user_question` 瀑布正确转成 `question/requested` 帧；期间发现并修复了 respond 结算经旧 HTTP envelope 导致 `401` 的缺陷（详见 [docs/rc1-respond-settle-review.md](rc1-respond-settle-review.md)）。**完整兼容声明仍需**按 [RC1 兼容验收清单](rc1-acceptance-checklist.md) 在两种 Host 版本、Desktop/Web、Windows 与 WSL/Linux 环境逐项实测（当前逐项进展见 [docs/rc1-t01-t19-verification.md](rc1-t01-t19-verification.md)）。

### 2.4 高度自定义化的 Harness

- **自定义权限预设/模型/Agent 预设**：App 全部从内核动态读取（catalog、session-config），不内置白名单；未知预设名显示为「…」（后续版本可拉取预设清单美化）。
- **第三方插件动作**：`ctx.mobileActions.register(...)` 注册后自动出现在 App 动作区（v0.1 契约：仅 text 字段）。
- **自定义问答 provider / 自动审批策略**：若用户的 Harness 已经接管人类问询（如自动答题插件、审批策略改为自动放行），内核**不会产生** `question/requested` / `approval/requested` 帧——手机不弹窗是**正确行为**，不是 bug。
- **多 profile**：插件按 profile 安装（`<profile>/node_modules/dsh-mobile-remote`），每个 profile 独立配置口令/连接。

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
| 1 | 两代 Host Remote 契约不同 | Host 升级后可能出现映射或事件桥错误 | RC1 使用本地 Typert 适配层；旧版保留 apiProxy 路径；诊断显示实际协议，插件版本跟进 |
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

## 6. 内置常量与"写死"数据速查

**零敏感写死**：口令、密钥、推送凭据全部在用户配置（`cordis.patch.yml`）或手机本地，代码与仓库中无任何密钥硬编码。

| 类别 | 内容 | 说明 |
|---|---|---|
| 设计令牌（有意） | 品牌色 `#426EFE` / 深色 `#0E1116` 等（App `theme.dart`）、`com.dsh.remote`、QR 协议 `DSHREMOTE\|地址\|口令`、`EnableImpeller=true` | 产品设计/通信契约，勿随意改 |
| 内核耦合词（有意） | 系统消息过滤词 `Current runtime context` / `This snapshot supersedes` / `background job `（App `chat_screen.dart`）、旧 apiProxy 与 RC1 Gateway 字段名 | 与内核/PC 端保持一致的隐藏规则 |
| 插件可配置项 | `path` / `authToken` / `cookieName` / `sessionTtlMs` / `rechargeUrl` / `maxConnections` / `pushUrls` / `pushCooldownMs` / `pushContent` / `rateLimit` / `trustedHosts` / `doneGraceMs`（v2.8.0）/ `lanBridge`（v3.0.0：`{enabled, port, host}`，默认关） | schema 默认值，改配置即可 |
| 插件内置常量 | 通知上限 100、catalog 缓存 15s、SSE 心跳 25s、SSE 超时 15s、登录限流默认 10 次/60s（`rateLimit` 可配）、状态文件 `~/.dsh/mobile-remote/` | 合理默认，无需配置 |
| App 内置常量 | HTTP 超时 15/20s（余额 25s）、连接/探测超时 8s、地址表上限 8、重试退避 1s→15s、看门狗 15s 检查 / 心跳 75s（3 周期）、日志保留 15 天/256KB、聊天初始窗口 50 条、历史分段 30 条、上下文圆环阈值 70%/90%、思维链折叠手动状态键 `dsh_mr_reasoning_overrides`（按会话持久化，每会话软上限 100 条） | 合理默认；修改点集中在各文件顶部常量 |
| 已消除的写死 | 充值链接（原 App 硬编码 `platform.deepseek.com/top_up`） | v2.4.2 起走 `catalog.rechargeUrl`（插件配置为准） |

## 7. 发布签名

- Release APK 需正式 keystore：`dsh-mobile-app/android/app/dsh-release.jks` + `android/key.properties`（**均已 gitignore，切勿提交**）。
- 干净克隆无 key.properties 时自动回退 debug 签名（仅自用可安装；商店/公开分发必须自建 keystore）。
- 自建方法见 `dsh-mobile-app/README.md`「构建」一节。
- ⚠ 更换签名 = 新应用：用户需卸载重装并重新扫码。
