# 04 安全设计文档 — dsh-mobile-remote

> 版本：v3.1.5 · 状态：已实现 · 配套：02-architecture.md、03-api.md、09-compatibility.md

## 1. 威胁模型

### 1.1 资产

| 资产 | 价值 |
|---|---|
| agent 控制权 | 极高：agent 可执行 bash/pwsh（本机全权限 ≥ 远程代码执行） |
| 会话内容 | 高：对话、工具输出、工作区文件内容 |
| 访问口令 | 高：等于 agent 控制权（App 持有即已认证） |

### 1.2 攻击面与威胁

| 威胁 | 路径 | 前置条件 | 等级 |
|---|---|---|---|
| T1 局域网内任意设备驱动 agent | 系统监听 0.0.0.0 后，同网段设备直接访问 `/m/api/*` | 口令未启用 | **高** |
| T2 公网暴露 | 路由器 3080 端口映射/穿透到公网 | 用户违反约束 | **极高**（禁止项） |
| T3 口令爆破 | 反复携带口令访问 API | 口令启用 | 低（v2.6 起登录限流：10 次/60s → 429 + Retry-After） |
| T5 中间人窃听 | WiFi 被监听，明文 HTTP | 无 TLS | 中（见 §3） |
| T6 DNS 重绑定 | 攻击者域名解析到 127.0.0.1 后经浏览器访问 | 无 TLS | 低（Host 校验阻断，见 §5） |

### 1.3 攻击面缩减原则
1. **默认回环**：未配置 0.0.0.0 时，插件随 webserver 只监听 127.0.0.1，移动 API 物理不可达。
2. **通路分级**：可信 WiFi（家用）→ 允许 0.0.0.0 + 建议口令；外出 → 虚拟组网（蒲公英实测推荐 / Tailscale 思路，WireGuard 加密 + 设备认证）；公网直连 → 禁止。
3. **口令即闸门**：启用口令后，全部移动 API（含 SSE）在建立连接时校验；任何绕过路径返回 401。
## 2. 身份鉴权方案

### 2.1 访问口令（推荐启用）

- 配置项 `authToken`（`cordis.patch.yml` 注入），**默认空 = 关闭**。
- App 每次请求携带 `X-Mobile-Token: <token>` 头；服务端常量时间比较（`crypto.timingSafeEqual`）。
- 失败统一 `401 auth-required`，避免枚举。
- 口令长度要求（文档约束）：≥ 16 字符，用 `crypto.randomBytes(24).toString('base64url')` 生成。
- 口令比较为**常量时间**（sha256 定长化 + `timingSafeEqual`，v2.6 起消除长度侧信道）。
- **登录限流（v2.6）**：错误口令按来源 IP 计数，窗口内 ≥10 次 → `429 rate-limited` + `Retry-After`；认证成功重置计数；仅口令启用时生效（可配 `rateLimit.maxFailures/windowMs/blockMs`）。frp 等中继场景所有外部请求同源（中继 IP），阈值对单用户足够宽裕。
- 每台电脑使用**不同口令**；二维码含口令，泄露后立即更换（改配置 + 重启，旧码作废）。
### 2.2 Cookie 通道（兼容保留）

- 名称 `dsh_mobile_token`；`HttpOnly`、`SameSite=Lax`、`Path=/m`。v2.1 起无登录入口（网页版已移除），仅供旧客户端兼容，与请求头等价。
### 2.3 认证中间件实现要求
- 所有受保护端点统一走一个 `authorized(req)` 前置校验；禁止散落判断。
- 校验失败：`401` + 统一错误体；SSE 端点同样在 HTTP 头阶段拒绝（不建立流）。
## 3. 传输安全

| 通路 | 传输安全 | 说明 |
|---|---|---|
| 127.0.0.1 回环 | 本机可信 | 默认 |
| 局域网（可信 WiFi） | 无 TLS，明文 | 家用 WiFi 信任模型；口令启用时明文风险可接受 |
| 虚拟组网（蒲公英/Tailscale） | **WireGuard 端到端加密 + 设备身份** | 外出唯一通路（蒲公英国内可用，实测推荐） |
| HTTPS 反代（可选，v2.6 文档化） | TLS（受信任 CA / 手机安装内网 CA 根证书） | 不信任 WiFi / 公网反代场景；部署见 06-install-run §6b |
| 公网裸 HTTP | **禁止** | 运维约束：不映射端口、不做 NAT 穿透到 3080 |

明文路径下口令可能被同网段监听者截获——这是**明确的残余风险**，缓解手段：仅可信 WiFi 使用、口令启用、定期更换。

### 3b. LAN 桥（v3.0.0：桌面版局域网直连的官方通道）
> 背景：DSH Desktop（0.1.1-rc.2 起）强制 webserver 只听 `127.0.0.1`（`dsh-plugin-desktop` 的 DesktopWebServer 构造器对非回环 host 直接 throw，用户 patch 无法覆盖），手机无法直连桌面版。插件在 DSH 进程内自建第二个 HTTP 监听（`lanBridge`，默认 `0.0.0.0:3080`），把 `/m/api*` 流式转发到回环 webserver（SSE 透传）。

**这是新增攻击面，边界在代码中强制（`lib/index.js`「LAN 桥」段）：**
1. **只转发移动 API 面**：`pathname.startsWith(/m/api)` 之外一律 404——桌面 `/api` RPC 网关、`/m/api/qr-config`（含口令）、`/m/qr.png`（仅本机语义）、一切其他 `/m/*` 面均不转发；Host 头重写为 `127.0.0.1:<webServer.port>` 使下游 hostAllowed 自然放行（真实鉴权仍由口令把关）。
2. **口令强制**：未配置 `authToken`、或口令短于 16 字符 → **拒绝启动桥**（仅警告不断言；schema 不设 min 以免破坏既有用户）并记日志。
3. **资源防护**：LAN 桥 Node server 的 `lanServer.maxConnections=128`（**传输层并发 socket 上限**，与移动端 SSE 配额不是同一个值；SSE 走插件 `maxConnections`，默认 **16**，满额时按 issue #131 驱逐 1 条满龄候选（stalled 优先；启发式，不宣称精确判活）而不是盲目调大）、headersTimeout 15s、requestTimeout 180s、upstream SSE 60s/普通请求 180s 超时、在网连接随插件卸载销毁。
4. **暴露条件**：桥默认关闭；开启即等于「0.0.0.0 移动 API 可达」——前置条件：可信 WiFi + ≥16 字符强口令（同 §2.1）。`/m/api/diagnostics` 的 `runtime.lanBridge.listening` 可确认监听状态（绑定失败时 QR/地址自动回退，不会指向死端口）。
5. **与 §3 表格关系**：桥上的流量走「局域网（可信 WiFi）明文」档位，残余风险与缓解同 §3 末。

## 4. 前端注入防护（XSS）
- App 为 Flutter 原生渲染（无 HTML 注入面）；消息内链接仅 http/https 可点击（v2.6 起 scheme 白名单，`file:`/`intent:`/`tel:` 等一律渲染为纯文本）。
- 插件 API 返回的文本为纯 JSON（不含 HTML）；桌面客户端模块（设置页二维码）仅渲染服务端返回的地址/口令文本。
## 5. Host 校验

- 移动 API 处理前校验 `Host` 头：必须匹配回环地址、本机任一面 internal IPv4（含 Tailscale），不匹配 → 403（阻断 DNS 重绑定，与 dsh /api 信任围栏同思路）。
- 名单在插件激活时以 `os.networkInterfaces()` 快照（过滤虚拟网卡：VMnet/vEthernet/代理虚拟网段）。
- `trustedHosts`（v2.4.2+）：隧道/中继类方案（frp/SakuraFrp 托管）下请求 Host 是中继地址，需在此显式放行（配合强口令）；纯虚拟组网/局域网无需配置。
## 6. 数据安全

### 文件与工作目录的权限边界（issue #68 / #16）

文件通道按用途分开，**不能再用一条“任意路径”规则描述**：

- **下载 `GET /m/api/files`（#16 已收紧）**：新调用必须带 `sessionId`，`path` 为会话 cwd 内相对路径；服务端 `realpath` 后做词法包含，再以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开、`fstat` 确认普通文件、`/proc/self/fd` 复核实际路径仍在 cwd 内。绝对路径、`..`、symlink 逃逸、目录/设备/FIFO 一律拒绝；旧调用不带 `sessionId` 时只接受绝对路径且必须落在已注册工作区。详见下方「文件下载」条目。
- **上传 `POST /m/api/files/upload`**：只允许写入 `sessionId` 对应 cwd（缺省首个注册工作区根），文件名拒绝分隔符/NUL/`.`/`..`；当前按目标路径直接写入，**未**采用下载侧的 descriptor-relative 句柄保护（#16 未覆盖上传）。
- **目录选择器 `GET/POST /m/api/directories`**：仍保留**有意**的任意路径浏览（新建会话需跨盘选工作目录），会跟随符号链接；它不是文件下载授权边界，也不因 #16 收窄。

同一认证身份还能通过 `POST /sessions {cwd}` 注册新的工作目录。因此按“已注册工作区 / 会话 cwd”过滤不能防御“先注册更大目录”的攻击者：它降低的是误用或口令泄露后的**直接任意文件读取面**，不替代宿主 OS 身份、沙箱与可信传输。若要增加受限身份，需要宿主批准的根目录、`realpath` / 符号链接检查和工作目录注册授权一起设计，不能只改下载接口。

### 工作区图片端点（`/m/api/workspace-image`，issue #95）

该端点比通用文件传输更窄：只允许当前会话 cwd 内、cwd 属于已登记工作区的普通图片，且使用 **fd 绑定**读取：`open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` 后以 `fstat` 与 `/proc/self/fd/<fd>` 的实际路径做 cwd/工作区 containment，再 `readSync(fd)` 有界读取并 `finally close`；不再按路径二次 `stat`/`readFileSync`。末级 symlink 被 `O_NOFOLLOW` 拒绝，中间目录换链由 fd 实际路径校验拒绝。非 Linux/无 procfs/无 O_NOFOLLOW 一律 `501 image-verification-unavailable`，**fail-closed，不回退**。

已知/接受边界：hardlink 与 bind-mount 的同用户场景不在本端点威胁模型内；8 MiB/8192px/40MP 上限；HEAD 仍完整读取以生成强 ETag。通用文件下载 `/files` 已按 #16 收紧；上传与目录选择器的边界见上节，三者不可混用。

### 插件安装源选择（`/m/api/plugin-inventory/registries` 与 `registry` 参数，issue #153）

手机端「安装源选择」**只改变本次解析用的 registry**，不是新的安装通道：

- **只读**：`GET /m/api/plugin-inventory/registries` 投影宿主 `pluginManager.registries()`（首选源、回退源、pnpm 自身解析出的源），`writable` 恒 `false`；App 不能新增/删除/改写电脑端 registry，不写 profile `package.json`、`pnpm-lock.yaml`、`.npmrc` 或插件状态目录。
- **凭据安全（P0）**：出网前统一剥离 `username`/`password`/`search`/`hash`；**带凭据的条目整条丢弃**，不做“只去密码”的脱敏回显——回显保留用户名/主机关系，下游容易误当成可复用源。响应只给 `display`（host + pathname），日志不使用原始 URL。
- **手动 URL 校验**：只接受 `http(s)`；拒绝非字符串/空/超 2048 字节、控制字符与空白、`new URL` 失败（裸路径、`file:`/`data:`/`git+ssh:`/`ftp:` 等非 http(s)）、带 userinfo、带 query、带 fragment、hostname 为空。失败一律 `400 registry-invalid`，`detail` **只给类别**、不回显原文（原文可能含凭据）。通过后与宿主 `normalizeRegistry` 幂等：pathname 末尾补 `/`。
- **允许 localhost 与私网**：内网 Verdaccio/Nexus 是合法用例，因此**不加私网/回环黑名单**。代价是已认证用户可以让宿主向指定 http(s) 主机发 registry 查询/安装请求；这与他本就能在电脑端配置 registry 等价，但**扩大了从手机发起的内网请求面**（可被用作端口/服务存在性探测：错误码与耗时能区分“无服务”“非 registry”）。缓解：端点需要移动端口令；registry 参数只改变解析源，**不能指定包**（指定包的能力见下节 P2，边界同样是“等价于电脑端操作”）；不持久化，不会长期改变后续行为。
- **不静默换源**：`versions` 返回 `requestedRegistry`/`answeredRegistry`/`attempts[{registry,problem}]`，安装/升级操作快照带 `registries`/`attempt{index,total}`/`answeredRegistry`。失败时 `answeredRegistry` 留空——不能声称“某个源答了”。
- **旧宿主降级**：无 `registries()`/抛错 → HTTP 200 + `supported:false`（不是 404/500），App 只显示「当前电脑端不提供安装源信息」，仍可在宿主默认源安装。

### 任意 spec 安装（`/m/api/plugin-inventory/inspect` 与 `install {spec}`，issue #175 P2）

手机端可以**触发宿主任意 spec 安装**。威胁模型与显式接受的边界如下——这一节是「#153 手动 URL 不能安装任意包」之后的能力扩张，**必须**与它一起读。

**能力等价性（接受该风险的理由）**：`spec` 交给宿主 `pluginManager.installBundle()`，与在电脑端运行 `dsh plugin install <spec>` 等价。已认证的移动端用户本就能操作该电脑端，因此这不是**权限**提升；提升的是**从手机侧发起**的便利面：不必回到电脑端键盘。

**硬约束（实现必须保持）**：

- **插件侧不解析 spec**：形态判定（`registry`/`git`/`path`/`tarball`）、路径合法性、git 地址、tarball 一律交宿主 `parseInstallSpec()` 与 `pluginManager.inspect()`。插件侧只做与语义无关的线性输入防御：非字符串/空/超 2048 字节/含控制字符（`\u0000-\u001f\u007f`）→ `400 invalid-spec`，`detail` 只给类别。**重复实现解析器必然与宿主漂移**，且会绕过宿主的合法性判断。
- **`path` 只接受宿主机绝对路径**：相对路径由宿主 `parseInstallSpec()` 拒绝。UI 明确提示「填电脑上的路径，不是手机的」——手机没有电脑文件系统访问权，路径**只能手输**，App 不提供也不应该提供目录浏览。
- **不回显原始 spec（P0）**：spec 可能含访问 token、内网主机名或家目录路径。因此：错误响应/`detail`/日志/操作快照的 `name` 都不得出现 spec 原文；预校验成功时 op 用**包名**，失败占位用固定串 `install-spec`。宿主 `inspect()` 的 `reason` 对 `path` 会拼入文件系统错误（含绝对路径）、对 registry 会回传原源错误，**必须经白名单收敛**后才可透出（只保留宿主固定短句，其余置空，由 App 按 `problem` 出人话）。
- **`name` 与 `spec` 互斥**：同传 → `400 bad-request`。不替用户二选一——那会在“以为按配置渠道装”时实际装了任意包。
- **`name` 路径不变**：`{name}` 仍只从宿主 `installable` 清单取 `installTarget.spec`（#153 三分类 UI 依赖它）。op 快照带 `source: "name" | "spec"` 以便区分。
- **并发**：同一时刻只允许一个 `spec` 安装，第二个 → `409 plugin-install-in-progress`；不排队（排队只会让手机端长时间无反馈）。`name` 路径不受此限，仍按 `name` 去重。

**安装脚本授权（明确的「不做」）**：pnpm 可能拦截 build scripts（脚本可执行任意代码），宿主有 `approvedBuilds` 授权机制。**手机端不提供该授权通道**：遇到拦截只回报 `errorCode: "build-blocked"` + `pendingBuilds`（**只有包名**），App 显示「需要在电脑端完成安装脚本授权」+ 指引，**不渲染任何批准按钮**。理由：批准安装脚本等于允许任意代码在电脑上执行，该决定必须发生在能看到完整脚本与上下文的电脑端。`pendingBuilds` 在插件侧再做一次**包名形状**校验（排除 `/` 开头的路径、空白与控制字符），避免把路径透到手机屏幕上。

**宿主失败类别的真实来源**：宿主 `installBundle()` 在 pnpm 失败时 `throw new Error(run.output)`，`change()` 把它折成 `error.code: "operation-error"`——**`build-blocked` 不在 `error.code` 里**，只在 `result.packageResult.kind`（由 `classifyInstallFailure()` 判出）。因此插件侧从 `packageResult.kind` 还原 `build-blocked`，而非读 `error.code`。这一点若按“错误码直读”实现会静默失效（表现为永远显示通用的 `operation-error`）。

**旧宿主降级**：无 `inspect()` → `200 + supported:false`（不是 404/500），预校验不可用；安装仍可提交，`installBundle` 自己会做完整校验。

**已知残余风险**：`path`/`git`/`tarball` 三类在**首次**安装时由 pnpm 在电脑端执行，等于让手机输入决定了电脑端要拉取/执行的包。宿主的 bundle 校验（`dsh.bundle` 声明）与本仓库的预校验只降低误操作，不构成代码审计——与 `dsh plugin install` 同等级。这也是「手机端不做 build scripts 授权」这条边界存在的原因。

### 持久化与投递

- 插件**持久化仅限最小移动端状态**（`~/.dsh/mobile-remote/`：通知已读 id、会话最近活跃时间），不含会话内容；口令只存在于 profile 配置。
- 会话内容沿用 dsh 现有策略存储；插件仅在请求处理期间持有内存副本。
- **二维码数据端点 `/m/api/qr-config` 仅允许 loopback**（TCP socket 来源校验，无法伪造）—— 桌面设置页读取后展示二维码；二维码含地址+口令，请勿截屏转发。
- **问询/审批应答（`/m/api/respond`）不绕过内核安全**：RC1 路径先在插件侧按原始问题严格校验答案（每项必须有 `selected: string[]`，`custom` 若存在必须为字符串，选项/数量/重复项均校验），再通过 `$events/result` 交给内核；旧 `apiProxy` 路径仍由内核 schema 校验。rpcId 与 sessionId 必须命中对应 pending 表（先到先得，不可伪造待答）。取消操作同样以 `UserQuestionError`/`ASK_CANCELLED` rejection 走内核语义。
- **文件下载（`/m/api/files`，GitLab #16 已收紧）**：新调用必须携带 `sessionId`，`path` 为该会话 cwd 内**相对路径**；服务端 `realpath(cwd)` 后做词法包含校验，再 `open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)` + `fstat` 确认普通文件 + `/proc/self/fd/<fd>` 复核真实路径仍在 cwd 内，读取固定在该句柄。绝对路径、`..`、编码绕过、symlink 逃逸、目录/设备/FIFO 一律拒绝；非 Linux / 无 procfs / 无 `O_NOFOLLOW` 稳定返回 `503 files-unavailable`，不回退为路径读取。
  - **旧客户端兼容**：不带 `sessionId` 时只接受绝对路径且必须落在**已注册工作区**内（不再允许任意宿主路径）；这是为旧 App 保留的兼容通道，权限仍受已注册工作区约束。
  - **上传（`/m/api/files/upload`）**：只允许写入 `sessionId` 对应 cwd（缺省首个注册工作区根）并拒绝文件名分隔符/NUL；本次未采用下载侧的 descriptor-relative 句柄保护，属于已知残余边界。
  - **目录选择器**（`/m/api/directories`）仍保留**任意路径浏览**（新建会话需跨盘选工作目录），不适用工作区包含语义。
  - **信任边界不变**：已认证用户可以 `POST /sessions {cwd}` 注册新工作目录，因此工作区/会话包含校验不能防御「先注册更大目录」；它降低的是误用/口令泄露后的直接任意文件读取面，不替代宿主 OS 身份、沙箱与可信传输。
- **第三方推送通道脱敏（v2.6）**：Server酱/ntfy/Bark/generic 等推送默认只收到「事件类型 + 会话短码」（`pushContent: minimal`），会话标题/错误详情等核心内容默认不出本机；仅显式配置 `pushContent: standard` 后外发——第三方服务不可信。
- **用量与额度投影（v3.1.5）**：`/m/api/account-usage` 只返回成功来源的余额/配额、脱敏 Codex 账户标签和汇总失败数；DeepSeek/OpenCode Go 密钥与 Codex OAuth token 永不进入响应、App 日志或持久化文件。OpenCode Go 只请求固定官方 HTTPS 端点；Codex 启用代理但代理不可用时拒绝直连。服务端只保留 60 秒进程内快照，单来源失败不回退到过期数据。
- **桌面宠物 overlay 面板脱敏（沿用 ADR 0008）**：桌面宠物是 **`TYPE_APPLICATION_OVERLAY` 系统级浮层**，可能出现在锁屏、他人可见、或覆盖其它应用之上。因此面板的用量与额度区块只展示来源标题、金额文字与配额细条/颜色；**不显示账户身份（displayName/maskedEmail）**、不显示任何聚合或换算数值；配额窗口永不相加。数据仅按需获取（展开面板时，客户端节流）、失败沿用旧值并标注相对时间，不新增后台轮询或持久化。
## 7. 安全测试要点（并入 05-test-cases.md）
1. 口令启用后：未认证访问 bootstrap/send/events/history 返回 401；错误口令 401。
2. 口令关闭时：以上端点返回 200。
3. Host 校验：伪造 Host 头 → 403。
4. `/m/api/qr-config`：非 loopback 来源 → 403；loopback → 200。
5. 系统监听 0.0.0.0 后，从另一台设备验证：同网段可访问（设计内行为）；确认公网端口未开放。
6. LAN 桥：未配置口令/短于 16 字符 → `diagnostics.runtime.lanBridge.listening=false` 且日志有拒绝提示；配置正确 → listening=true，经桥访问 bootstrap 200、无口令 401、`/m/api/qr-config` 与 `/api/*` 一律 404（模拟环境若无法真机，用另一台同网设备 curl 验证）。
## 8. 运维约束（与 06-install-run.md 联动）
- 启用 0.0.0.0 前确认网络为可信 WiFi；离开可信网络前确认服务未在公网可达。
- 建议（非强制）在 profile 配置中启用口令；口令变更 = 改配置 + 重启 dsh。
- 虚拟组网为外出标准姿势（蒲公英国内实测推荐；Tailscale 国内控制面不可达）；纯组网方案插件侧无需额外配置，隧道/中继类需 `trustedHosts` 放行 + 强口令。
- `authToken` 必须启用（v2.6 起启动日志与桌面设置页对「认证未启用」显式警示）；不信任的 WiFi（酒店/咖啡馆）下优先 HTTPS 反代（06-install-run §6b）。
