# 设计：桌面形态自适应（自动开桥 / 默认更新目录 / APK 就位）

> **状态**：方案稿（未实施）。来源：桌面版实机安装反馈（GitLab #35 验收后续）。
> **目标**：让"在 DSH 桌面版安装插件"变成**装完即用**，不需要用户手改 `cordis.patch.yml`、不需要手工拷 APK。

---

## 1. 问题（实机反馈）

在 DSH 桌面版上安装插件后，用户需要手工做三件事才能用，否则"装了等于没装"：

| # | 现状 | 后果 |
|---|---|---|
| P1 | `lanBridge.enabled` 默认 `false`；桌面版 webserver **只听回环** | 手机根本连不上 |
| P2 | `updateDir` 未配置时，**人工区**不生效（只有 carrier/托管区有默认目录） | 没有 APK 分发源；且用户不知道该把目录指到哪 |
| P3 | APK 不在插件包内（设计上由独立的"载体包"分发，尚未发 npm） | 装完插件仍没有 App 安装包 |

另：用户尝试安装 `desktop-kit.tgz` 报错——**这是预期行为**：kit 不是插件包（无 `package.json`/`dsh.bundle`），只是"手工拷两文件"的物料。

---

## 2. 原则

1. **插件不改用户配置**。三条问题的解法都落在运行时行为与默认值上，不写 `cordis.patch.yml`。
   （理由：改用户 YAML 风险高——本项目曾因一个未加引号的 `@` 导致 DSH 启动崩溃。）
2. **形态自适应优于文档要求**。桌面形态与 web 形态的差异（是否要桥、更新谁来管、平台能力）应由插件自己判，不要求用户理解。
3. **默认可用，显式可关**。新的默认行为必须能通过显式配置关掉，且诊断里能看出"这是默认行为还是你配置的"。
4. **安全默认不放宽**：自动开监听必须仍然强口令、尽量少暴露网卡。

---

## 3. P1：桌面形态自动开 LAN 桥

### 3.1 配置三态

`lanBridge.enabled` 从 `boolean.default(false)` 改为**可选**：

| 配置 | 语义 |
|---|---|
| 未配置（`undefined`） | **自动**：形态为 desktop 且能绑定到私有网卡时开启；其它形态保持关闭 |
| `true` / `false` | 显式，维持现有语义（向后兼容） |
| `port` 未配置 | 显式 `enabled: true` 时仍沿用现默认 `3080`（向后兼容）；**自动模式**走下面的选端口逻辑 |

### 3.2 形态判定

复用现有 `runtimeForm(ctx)`：`DSH_DESKTOP=1` 或存在 `desktopBrowserAccess` 服务 → `desktop`。
（现有实现已用该服务兜底，不依赖桌面启动器是否置环境变量。）

判不出桌面形态时：**不自动开桥**，诊断给 `lanBridge.source = "auto-skipped"` + `reason = "form-unknown"`，提示用户显式配置——不猜。

### 3.3 端口：自动选空闲，并**持久化**

自动模式不能每次随机：手机端配对的是**具体端口**，随机化会导致每次重启都要重扫码。因此：

1. 候选顺序：`3081 → 3082 → … → 3089`（避开 web 宿主惯用的 3080）；
2. 首次成功绑定后，把端口写入插件状态：`<DSH_HOME>/mobile-remote/lan-bridge/<profileKey>.json`（`{port, host, at, schema:1}`）；
3. 后续启动**优先复用**已持久化端口；若被占用则按候选序列重新选并更新状态文件；
4. 诊断输出 `lanBridge: { enabled, host, port, listening, source: "auto-desktop"|"config", portSource: "persisted"|"probe"|"config" }`。

### 3.4 绑定地址：只绑私有网卡（安全）

自动模式**不绑 `0.0.0.0`**，而是取第一块**私有 IPv4**（`10/8`、`172.16/12`、`192.168/16`）：
- 满足"同一 WiFi 手机可达"；
- 不会因为多网卡（含公网/VPN 网卡）意外暴露到广域网；
- 找不到私有地址 → 不自动开桥，`reason = "no-private-address"`。

显式配置模式下仍按用户给的 `host`（含 `0.0.0.0`）——尊重显式选择，但诊断给出暴露面提示。

### 3.5 安全与可观测

- 口令：已有 A9 自动生成（43 字符）满足桥的 ≥16 门槛，无需用户配置；
- 启动日志与诊断各给一行明确提示："已在 `<host>:<port>` 自动开启移动端 LAN 桥（来源：默认，可用 `lanBridge.enabled: false` 关闭）"；
- `enabled: false` 时绝不自动开启（显式优先）。

### 3.6 验收

- 桌面版安装插件 + **不改任何配置** → 重启后：诊断 `lanBridge.listening = true`、`source = auto-desktop`；手机扫码可连；
- 同机再起 web 宿主（3080）→ 桌面桥不撞端口（3081 起）；
- 重启桌面版两次 → 端口不变（持久化生效）；
- 显式 `enabled: false` → 不监听；
- 无私有网卡的环境（模拟）→ 不自动开、诊断给出 `no-private-address`。

---

## 4. P2：updateDir 默认生效 + 自动创建

### 4.1 与既有设计的偏差（这是 bug）

设计稿 §5.4 明确："配置的 `updateDir` 非空时使用该目录；**未配置时，自动载体分发使用 `~/.dsh/mobile-remote/update`**；这是本次新增默认行为，不再依赖用户手工开启主机更新目录。"

实现只把默认值给了 **carrier/托管区**（`carrierUpdateDir`），而**人工区**（`legacyManualAppArtifact`）仍要求显式配置：`configuredUpdateDir === ""` 直接返回 `update-not-configured`。真机验收时就因此出现过"匿名入口 503"。

### 4.2 改法

1. `configuredUpdateDir` 为空时回退到 `DEFAULT_CARRIER_UPDATE_DIR`（`<home>/.dsh/mobile-remote/update`）——人工区与托管区**同一个目录**；
2. 插件激活时 `mkdir -p` 该目录（失败只记诊断，不影响启动）；
3. 诊断新增 `updateDirSource: "config" | "default"`，保留 `updateDirConfigured` 兼容；
4. 目录就绪后，用户把 `manifest.json` + APK 放进去即可被匿名入口与 App 更新消费（无需改任何配置）。

### 4.3 验收

- 全新 profile（未配置 updateDir）→ 启动后目录被创建、诊断 `updateDirSource = default`；
- 放 `manifest.json` + APK → `/api/update/apk` 匿名 200、sha256 与清单一致；
- 显式配置了别的目录 → 仍以配置为准（`source = config`）；
- 目录不可写 → 诊断 `reason = update-dir-unwritable`，插件其余功能不受影响。

> 注意：本项**不**尝试把 `updateDir` 写进用户配置——默认值已足够，写入配置属于"插件改用户文件"，不做。

---

## 5. P3：APK 自动就位（三条路线）

### 5.1 为什么不能简单"把 APK 放进插件包"

配对清单里的 `plugin` 段包含**插件自身**的 `sha256`/`size`/`contentSha256`。若清单放进插件包，就形成**自引用**（清单 → 包哈希 → 清单）。载体包之所以是独立包，正是为了打破这个环。

### 5.2 三条路线

| 路线 | 机制 | 代价 | 适用 |
|---|---|---|---|
| **A. 发 npm 载体**（正解） | 发 `3.2.x-app`；桌面版 pnpm 安装插件时按 `optionalDependencies` 自动装载体 → 插件导入托管区 → APK 自动就位 | 需发版授权；此后每次发布成对发布 | **正式渠道**，推荐 |
| **B. 本地"胖包"** | 插件包附 `app/`：APK + `app-meta.json`（**只含 app 字段**：version/file/size/sha256）；插件启动时用**运行时自算的 `selfContentSha256`** 合成完整配对快照并落位 updateDir | 包 +34MB（gzip 后）；插件内容标识**包含 APK**（App 换版 → 插件内容标识变）；与发布版身份不同，**只能作本地/离线专用包** | 离线安装、桌面自用 |
| **C. 保持现状** | 解压 kit，拷 `manifest.json` + APK | 每次发版手工一次 | 兜底 |

### 5.3 若做 B：实现要点

1. 打包器（`build-app-carrier.mjs` 或新脚本）产出 `*-local.tgz`：在标准插件包基础上加 `app/DSH-Remote-vX.Y.Z.apk` 与 `app/app-meta.json`；
2. 插件启动时（与载体导入同一异步任务）：若 `app/` 存在且 `app-meta.json` 的 `sha256/size` 与实际 APK 一致 → 用 `selfContentSha256` + `app-meta` 合成 identity → `releaseId` → 走托管区 `stageRelease/publishStagedRelease`（或直接落 updateDir 人工区）；
3. 诊断标注 `provision.source = "bundled-app"`，便于区分"随包带入"与"载体/人工区"；
4. **不得**把该包分发到公共渠道（`dsh.bundle` 的注释与 README 明确标注 local-only）。

### 5.4 验收

- A：npm 发载体后，干净桌面安装 → 无任何手工步骤，`appArtifact=ok` 且手机可首装/更新；
- B：装本地胖包 → `updateDir` 自动出现 APK + 合成清单 → 手机扫码首装成功；
- C：现有流程不变。

---

## 6. 分期与范围

| 阶段 | 内容 | 风险 |
|---|---|---|
| **S1**（建议先做） | P1 自动开桥（三态 + 自动端口 + 持久化 + 私有网卡绑定）+ P2 默认目录/自动创建 + 诊断字段 + 单测 | 低；纯运行时行为，可用显式配置关掉 |
| **S2**（可选） | P3-B 本地胖包（运行时合成快照） | 中；内容标识语义与包体积，需要用户明确接受 |
| **S3**（发版时） | P3-A 发 npm 载体 → 桌面零配置成为默认 | 依赖发版授权与公共 npm 大包验证 |

## 7. 不做

- 不写用户 `cordis.patch.yml`（插件不改用户配置）；
- 不在自动模式下绑 `0.0.0.0`；
- 不让"胖包"进入公共分发渠道；
- 不放弃显式配置的优先级（显式永远覆盖自动）。

## 8. 待定问题

1. 自动模式端口候选区间（`3081–3089`）是否够用？被占满时的降级行为（报 `no-free-port` 而不随机挑高位端口）？
2. `lan-bridge` 状态文件按 profileKey 存还是按宿主实例存（同一 DSH_HOME 下多 profile 是否共享一个桥）？
3. 胖包（P3-B）是否要做——若做，版本号/内容标识与发布版的关系如何向用户解释？
4. 桌面版内核不提供 `desktopBrowserAccess` 时（更老或更新的桌面版），是否需要第二条形态判据（例如监听地址恒为回环）？
