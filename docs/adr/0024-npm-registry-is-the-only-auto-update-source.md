# 0024 宿主 npm registry 是自动更新的唯一来源

状态：已接受（2026-10-30）。关联：ADR 0019、0020、0021、0022、0023。

## 背景

本 fork 的插件与 App 载体使用 scoped npm 包 `@marktrue/dsh-mobile-remote`，发布坐标与上游版本线独立（ADR 0023）。当前插件自更新默认读取上游 `201222-L/dsh-mobile-remote` 的 GitHub Release 清单；手机设置页的 App 更新来源选择又能在固定发布和主机人工目录之间切换。更新候选因此存在多个发布权威，默认上游源也可能与正在运行的 fork 包身份不匹配。

期望流程是：手机 App 发起电脑端插件更新；DSH 宿主按其 npm 配置从所选 registry 取得并安装本 fork 插件及配对 App 载体；插件健康确认后，手机再从 DSH 取得 APK。手机不访问 npm，也不持有宿主 npm 凭据。

## 决策

### 1. npm 是唯一的更新来源

- 插件和配对 App 载体的更新候选及包字节，只来自 DSH 宿主有效 npm registry。对 `@marktrue` 包，使用宿主 `@marktrue:registry`；未设置时使用默认 `registry`。不硬编码 npmjs、公共镜像或私有镜像。
- 更新器复用宿主 npm 配置与凭据；凭据不得下发给手机、写入发布清单或日志。只有宿主明确配置的 registry 才可接收该 registry 的凭据；显式配置的私有 HTTP registry 可用，但凭据只发往该配置地址。
- 插件自动更新来源固定为 `npm`，管理员可设 `off` 关闭。移除 GitHub Release、自定义 URL 和人工 updateDir 作为自动更新候选来源；registry 不可用、认证失败或元数据无效时 fail-closed，不回退其他来源。
- packument 查询和 tarball 获取经由宿主 npm/pnpm 有效配置（包括 scope registry、代理/no_proxy 与认证），不硬编码 URL。只向配置选中的 registry 主机发送其凭据；若 registry 返回跨源 tarball 地址，不得把 registry 凭据转发给该地址。

### 2. 版本通道与配对

- 稳定版插件跟随 `latest`；已安装预发布插件跟随其预发布通道（当前为 `alpha`），不跨通道升级。预发布不得移动 `latest`。
- carrier 仍发布在 `app` dist-tag，但配对按插件完整版本精确解析：插件 `X.Y.Z[-pre]` 对应 carrier `X.Y.Z[-pre]-app`。carrier 必须存在且 App core 与插件 core 一致；缺失或不匹配时拒绝整对更新，不允许只更新插件。
- npm packument/`dist.integrity` 用于候选与 tarball 校验；carrier 内 schema 1 `manifest.json` 仍是两端版本配对、APK size/SHA-256 的权威；插件内容标识按 ADR 0019 复算。更新事务一经受理，固定插件与 carrier 版本及哈希，不再追随可变 dist-tag。
- 只接受高于当前版本的候选；同一 NPM 版本出现不同完整性或内容标识时视为损坏并拒绝，不按内容变化覆盖同版本。

### 3. DSH 安装与 App 分发

- 手机 App 只向 DSH 发起插件更新请求。宿主依据其 npm 配置取回插件与精确配对 carrier；更新完成后的 profile 依赖保持为精确 npm 版本，而非长期 `file:` tarball 路径；回滚恢复原有精确 npm spec。NPM 凭据仅在宿主侧使用。
- NPM 是版本和包的来源；DSH 托管区可保存经校验的 NPM carrier，并通过现有更新端点向手机传输 APK。人工区仍受 ADR 0021 保护，人工放置的文件不能形成自动更新候选。手机不直接请求 npm。
- 包管理器可能静默跳过 optional carrier；安装成功不能作为 carrier 存在的证明。宿主必须核实 exact carrier、清单及 APK 身份，缺失时拒绝该配对。

### 4. 检查与更新交互

- 桌面 DSH 插件的“连接移动端”设置页在进入时做一次只读检查，并保留手动重查按钮。检查由宿主侧只读 API 执行，与会安装的 `POST /plugin-update` 分开；返回候选状态、插件版本和配对 App build，不暴露 registry 凭据、token 或可携带认证信息的 URL。没有更新时显示当前/最新状态；registry、认证或配对校验失败时显示不可用，不生成更新按钮。
- 只有发现完整且高于当前版本的插件/carrier 配对时，桌面页才显示“更新插件”按钮。点击先确认目标版本及宿主重启；确认后调用现有插件更新事务，由外部监督器完成安装、重启、健康核验与回滚。检查页面本身绝不安装或重启。
- 手机 App 的“更新电脑端插件”入口保留，并与桌面按钮共用同一个 opId/事务锁；两端同时触发时不得创建并发安装。App 更新仍必须等插件健康确认后才开放，且 App 只通过 DSH 获取已由 npm 选定并验证的 APK。
- 移除手机 App 设置页的更新来源选择菜单；旧的 App 侧来源偏好不得继续把更新导向 GitHub 或人工区。当前“检查更新”行只检查 App，文案改为“检查 App 更新”。

## 后果

- 当前 `pluginUpdateManifest` 的 `upstream` 默认值、GitHub/custom URL 分支由本 ADR 取代；`off` 管理开关保留。ADR 0019 的内容标识、冻结快照、显式触发、重启接续及健康回滚要求继续有效。
- 宿主 registry 配置错误、401/403、版本/载体不齐或 integrity/manifest 校验失败时，用户看到“更新不可用”，当前两端保持不变；不把错误伪装成“已是最新”。
- 私有 HTTP registry 的凭据会在其配置的私网链路上传输；如链路不可信，应改用 HTTPS。使用代理的宿主还需正确配置 registry 的 `no_proxy`，但更新器不得绕过用户的 npm registry 选择。
- 现有 App 的 GitHub/人工源选择状态不再是更新来源；迁移后 App 只向 DSH 取宿主已验证的 carrier APK。

## 考虑过的方案

- **继续用 GitHub Release 清单**：拒绝。当前 DSH 安装的是 fork scoped 包，默认上游 `201222-L` Release 与本 fork 的 npm 身份、tag 和内容不一致。
- **手机 App 直接查询/下载 npm**：拒绝。registry 凭据属于宿主；手机只需连接 DSH，由 DSH 分发经过校验的 APK。
- **人工 updateDir 或 GitHub 作为 npm 故障时的 fallback**：拒绝。多个候选源会使同一版本的两端配对与内容身份不确定。
- **同一 NPM 版本内容变化时自动重装**：拒绝。版本不可覆盖；新内容必须使用新版本号，防止回滚快照和当前发布身份歧义。
- **成功后长期保留 `file:` 插件依赖**：拒绝。它会绕过宿主后续的 npm registry 解析，与本 ADR 的唯一来源约束冲突；`file:` 只能是安装事务内部的临时暂存。
