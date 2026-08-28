# Spec — App 自动更新检查（更新源：GitHub Releases / dsh 运行主机）

> 状态：已与 maintainer 完成 grill 确认（决策树已闭合）。实现目标分支：`feature/app-auto-update`。

## Problem Statement

用户通过手机 App（DSH Remote）远端操作 PC 上的 dsh。App 与插件迭代频繁（版本一致配对，见 README「版本与兼容」），但：

1. 用户不知道何时有新版本 —— 只能去 GitHub Releases 手动翻，而国内网络访问 GitHub 慢且不稳定；
2. 即使知道有新版本，也要自己下载 APK、手动安装，72MB 的包在手机浏览器里下载体验差；
3. 无法利用「手机本来就连着 dsh 主机（局域网/蒲公英）」这一现成通道 —— 主机上明明已经有构建好的 APK，却没有一个能让手机拿到它的渠道；
4. 安装时若签名与已装版本不一致，系统会直接拒绝并给出令人困惑的「应用未安装」，没有任何前置说明。

目标：App 能**检查到更新**，并能通过**可切换的更新源**（GitHub Releases / dsh 运行主机）**下载并安装**，全程有清晰的进度、校验与签名防护。

## Solution

在 App「设置 → 关于」增加更新能力：

- **更新源**（单选，持久化，默认 GitHub）：
  - **GitHub 源**：查询本项目 GitHub Releases 最新 tag（`v3.0.0` 形式），取 `DSH-Remote-*.apk` 资产，经 HTTPS 直连下载。网络不可达时给出明确失败提示（提示可切主机源），不内置代理/镜像。
  - **主机源（dsh 运行主机）**：插件新增更新目录配置与两个端点 —— `/m/api/update/manifest`（返回版本元数据）+ `/m/api/update/apk`（流式下发 APK），均走现有 `authToken` 鉴权。发布时把 APK 与 `manifest.json` 放入插件配置的目录即可。
- **检查触发**：设置页「检查更新」手动按钮（明确结果：无更新 / 有新版 / 失败原因）+ 启动时自动检查（默认开，静默：命中才提示，失败静默跳过）。
- **版本比较**：先比 `major.minor.patch`，相等再比 build 号（主机 manifest 精确到 `+N`；GitHub tag 无 build 视为 0）。同版本不提示；主机 manifest 版本**低于**本机视为异常（防降级）。
- **下载与安装**：确认弹窗（版本 / 说明 / 大小 / 来源）→ App 内下载（进度可取消）→ 主机源校验 sha256 → **签名预检**（比对自身与下载 APK 证书 SHA-256）→ 一致则拉起系统安装器；不一致或读取异常则**取消更新**并明确提示，由用户自行处理。
- **发布脚本**：新增 Linux/WSL 等价发布脚本（与现有 Windows `package-release.ps1` 等价），并让两个脚本都能生成 `manifest.json`（version 含 build / sha256 / notes）。

## User Stories

1. As a 手机用户, I want to 在设置里手动检查 App 是否有新版本, so that 我随时能知道是否有更新可装。
2. As a 手机用户, I want to 打开 App 时自动静默检查一次更新, so that 我不需要记得手动去查，有新版时自然被提醒。
3. As a 手机用户, I want to 自动检查失败时不要打扰我, so that 网络不好或 GitHub 不通时打开 App 不受影响。
4. As a 手机用户, I want to 在设置里把更新源切换为 GitHub 或 dsh 主机, so that 我能按所在网络环境选择最可靠的获取渠道。
5. As a 手机用户, I want to 首次使用默认走 GitHub Releases 源, so that 无需任何配置即可获得公开版本更新。
6. As a 手机用户, I want to 通过主机源获取更新, so that 在局域网/蒲公英里能利用手机本来就连着的主机拿到 APK，速度快且不依赖 GitHub 可达性。
7. As a 手机用户, I want to 看到「检查更新」的明确结果（没有新版本 / 有新版本 / 失败原因）, so that 我知道操作是否生效，失败时知道该做什么（如切换更新源）。
8. As a 手机用户, I want to 在检测到新版本时看到确认弹窗（版本号、更新说明、文件大小、来源）, so that 我在下载前能判断是否值得更新。
9. As a 手机用户, I want to 下载时看到进度与已下载量，并能随时取消, so that 大 APK（约 72MB）下载期间我有掌控感，误触可撤回。
10. As a 手机用户, I want to 主机源下载完成后文件经 sha256 校验, so that 传输损坏或文件被篡改时不会安装坏包。
11. As a 手机用户, I want to 下载的 APK 与我已装的版本签名一致才允许安装, so that 不会被「签名不一致」的系统报错搞糊涂，也不会装错来源的包。
12. As a 手机用户, I want to 在签名不一致时看到「已取消更新」的明确提示, so that 我明白为什么没装，并能自行决定（如先卸载旧版再装）。
13. As a 手机用户, I want to 首次安装更新时系统引导我授权「安装未知应用」, so that Android 8+ 的安装来源限制不会让我卡住。
14. As a 手机用户, I want to 主机源 manifest 的版本号精确到 build（如 3.0.0+8）, so that 同一版本内的热修（+5/+6/+7…）也能被正确识别为可更新。
15. As a 手机用户, I want to 已装版本与最新 release 同版本（如本地 3.0.0+7 vs release v3.0.0）时不提示更新, so that 热修分支不会被误判为「需要更新」。
16. As a 手机用户, I want to 主机源版本低于已装版本时不更新并提示异常, so that 部署失误不会导致手机被降级。
17. As a 部署者, I want to 把构建好的 APK 和 manifest.json 放进插件配置的更新目录即可发布主机源更新, so that 局域网内用户一条命令都不用配置就能更新。
18. As a 部署者, I want to 插件提供带鉴权的 manifest 与 APK 端点, so that 更新通道不会暴露给未授权设备。
19. As a 部署者, I want to 在 Linux/WSL 上也能一键打包（APK + 插件 tgz + manifest.json）, so that 我不依赖 Windows 的 PowerShell 发布脚本。
20. As a 部署者, I want to Windows 发布脚本与 Linux 脚本行为等价（都能生成 manifest.json）, so that 团队无论在哪台机器发布，产物一致。
21. As a 维护者, I want to manifest.json 的 notes 自动取自 CHANGELOG 最新条目, so that 用户确认弹窗里的更新说明无需手写。
22. As a 手机用户, I want to 版本行旁出现常驻的「有新版本」提示, so that 自动检查命中后我一进设置页就能看到。
23. As a 手机用户, I want to 更新源切换后立即生效（检查走当前选中的源）, so that 从 GitHub 切到主机源后不用重启 App。
24. As a 手机用户, I want to GitHub 源在 latest release 里找不到 APK 资产时得到明确提示, so that 不会误报「没有更新」或卡死。
25. As a 维护者, I want to 更新决策逻辑（版本比较、manifest 解析、防降级）是纯函数可单测, so that 版本规则的正确性能被自动化测试兜住。

## Implementation Decisions

### 更新源与配置

- App 设置「更新源」为**单选持久化偏好**（`github` | `host`），默认 `github`。切换立即影响下一次「检查更新」。
- 插件新增配置项 `updateDir`（字符串路径，默认 `~/.dsh/mobile-remote/update/`）。**manifest 是唯一权威**：App 只读 manifest，不枚举目录内 APK；插件不扫描目录里的历史版本。

### 主机源端点契约（插件侧）

- `GET {path}/api/update/manifest`（现有鉴权体系）：
  - 200 → `{ version: "3.0.0+8", apk: "DSH-Remote-v3.0.0.apk", sha256: "<hex>", size?: <字节>, notes?: "…" }`
  - `updateDir` 未配置 / 无 manifest / 文件缺失 → 对应错误码（App 明确提示「主机源未配置更新」）。
- `GET {path}/api/update/apk`（现有鉴权体系）：按 manifest 的 `apk` 文件名流式下发文件字节，含 `content-length`；读取失败回 404/500。
- 两个端点都走现有 `authToken` 鉴权，与既有安全边界一致（LAN 桥现成可用）。

### GitHub 源契约

- 版本查询：`GET api.github.com/repos/201222-L/dsh-mobile-remote/releases/latest`；解析 `tag_name`（去前缀 `v`）作为版本，build 视为 0。
- 资产选择：取 `assets[]` 中第一个名形如 `DSH-Remote-*.apk` 的条目；无 APK 资产 → 「无可用更新」明确提示。
- 下载：该资产的 `browser_download_url`，HTTPS 直连流式下载。无 sha256 校验（依赖 HTTPS + 安装器签名核对）。失败/超时 → 明确错误，建议切主机源。不内置代理/镜像。

### 版本比较规则

- 解析 `major.minor.patch` 与可选 `+build`。比较顺序：`major` → `minor` → `patch` → `build`（缺失 build 视为 0）。
- `needUpdate(local, remote)`：remote 任一主段更大 → 更新；主段相等且 build 更大 → 更新；相等 → 不更新；**remote 低于 local → 异常态（不更新，提示「更新源版本低于当前版本」）**。
- **实现取舍（buildSet）**：远端版本串未显式带 `+build` 时（GitHub tag 必然如此），主段相等即判定「不提示」——否则本地 `3.0.0+7` vs release tag `v3.0.0` 会因 build 补 0 被误判成降级异常，违背 US15。即：build 比较仅在远端显式带 `+build` 时参与；远端显式 build 更小仍按防降级处理。

### 下载、校验与安装

- 确认弹窗：版本 / notes / APK 大小 / 来源名（GitHub / 主机 · 不区分文案风格，均写来源名）。
- 下载：App 内 http 流式下载到私有缓存目录，弹窗展示进度（百分比 + 已下载量），可取消（取消即清理文件）。
- sha256 校验：**仅主机源**（manifest 提供 sha256），不一致 → 失败提示，不进入安装。
- 签名预检（下载后、拉起安装器前）：读取本机已装版本证书 SHA-256 与下载 APK 证书 SHA-256 比对：
  - 一致 → 拉起系统安装器（`ACTION_VIEW` + FileProvider，`requestLegacyExternalStorage` 不引入，用应用私有目录）；
  - 不一致 → 弹「签名不一致，已取消更新」，不进入安装；
  - 任一签名读取异常（含无法解析下载 APK 签名）→ 保守**取消**并提示。
- Android 权限与兼容：
  - `AndroidManifest.xml` 增加 `REQUEST_INSTALL_PACKAGES`；
  - 配置 FileProvider（含 `file_paths.xml`，指向缓存/私有文件目录）；
  - Android 8+ 首次安装触发系统「安装未知应用」授权引导；
  - `build.gradle.kts` release 显式 `v1SigningEnabled true`（v1+v2 双签名），使 `getPackageArchiveInfo` 能可靠读取 APK 签名做预检（纯本地分发，无平台副作用）。
- 签名一致性边界：**依赖系统安装器做最终签名核对**（双保险）；预检只做前置防呆。

### 交互与 UI

- 设置「关于」卡片新增：
  - 「更新源」行：host / GitHub 单选（默认 GitHub）；
  - 「检查更新」行：手动触发，含「检查中… / 下载中…」状态；
  - 版本行旁「● 有新版本」常驻提示（自动检查命中后显示，直到更新或版本变更）。
- 自动检查：应用启动后（连接成功场景）静默执行一次；命中 → 弹确认窗；未命中/失败 → 静默。
- 手动检查：无论结果都明确反馈（「已是最新版本」/ 确认窗 / 失败原因 + 可切源的引导）。

### 发布脚本（双端等价）

- 新增 Linux/WSL 等价脚本（bash），行为与 Windows `package-release.ps1` 对齐：
  1. 从 `pubspec.yaml` 解析版本（`X.Y.Z+BUILD`，build 取自 `+N`）；
  2. 拷贝已构建 `app-release.apk` → `dist/DSH-Remote-vX.Y.Z.apk`；
  3. `npm pack` 插件 → `dist/dsh-mobile-remote-vX.Y.Z.tgz`；
  4. 生成 `manifest.json`：`version`（含 build）、`apk` 文件名、`sha256`（对 APK 计算）、`size`（APK 字节数，确认弹窗展示用）、`notes`（取 CHANGELOG 最新条目全文）；
  5. （可选参数）把 APK + manifest 拷贝到插件 `updateDir`。
- manifest 生成收敛为**共享生成器** `tools/gen-manifest.js`（Node），两个发布脚本都调用之——JSON 合法性（notes 特殊字符自动转义）与无 BOM 编码由同一份代码保证，双端产出严格等价。
- 同步扩展 Windows ps1，使两脚本产出等价（含 manifest 生成）。

## Testing Decisions

- **主 seam（自动化必达）**：更新决策逻辑做成 **App 端纯 Dart 模块**（无 I/O：manifest / GitHub release JSON 解析、版本比较（semver + build）、需要更新判定、防降级判定、下载 URL 构造、签名校验的输入组装），在**现有 `dsh-mobile-app/test/` 单测 seam** 下用 `flutter test` 覆盖（prior art：`api_logic_test.dart`、`md_link_test.dart` —— 同款「纯逻辑模块 + 单测」形态；本轮已验证 `flutter analyze` 0 issues + 9/9 测试通道）。
  - 测例方向：`3.0.0+7` vs tag `v3.0.0` → 不更新；`3.0.0+8` vs `3.0.0+7` → 更新；`3.1.0` vs `3.0.0+999` → 更新；remote 低于 local → 异常不更新；manifest 缺 build / 非法版本 → 容错解析；GitHub 资产选择（含无 APK 资产）。
- **副 seam（已落地）**：发布脚本生成的 `manifest.json` 由同款 verify 脚本校验（`dsh-mobile-app/tools/verify-update-manifest.mjs`：version 含 build、sha256/size 与 APK 实算一致、notes 非空、apk 文件存在）；服务端 manifest 读取 helper（`readUpdateManifest`）如需进一步提取式单测沿用 `tools/verify-*.mjs` 形态（prior art：`verify-image-sniff.mjs`）。
- **明确不自动化（人工验收）**：真实 APK 下载 + 签名预检 + 系统安装器拉起 + Android 8+/11+ 授权引导 —— 需要真机/模拟器，列为发布前人工验收清单（对应 docs/06 §9 风格）。
- 不考虑引入：widget 测试脚手架、`integration_test` 新 harness（不新增 seam 层）。

## Out of Scope

- iOS 端任何形态的更新检查（当前 App 仅 Android）。
- 周期性/定时推送式更新检查（仅启动时静默 + 手动）。
- GitHub 镜像 / 代理 / 预置中转域名支持（保持直连 + 明确失败提示）。
- 自动静默安装（更新必须经用户确认弹窗，不后台装）。
- 目录内多版本 APK 枚举与历史版本清理（manifest 唯一权威，滞留旧文件由部署者自行清理）。
- 内测渠道 / 灰度 / Play 商店发布流程。
- 已装版本与下载 APK 的**包名**核对之外的加固（签名比对已覆盖主要风险）。
- 对 dsh 内核侧的任何改动（纯插件 + App + 脚本）。

## Further Notes

- **签名一致性**：本机 debug 签名构建的 release 与正式 keystore 签名不同；换签名需先卸载（docs/06 §8.3 既有约定）。更新签名预检正是为了把这种「签名不一致」提前到下载后、安装前说清楚，而不是让用户在系统安装器报错时困惑。
- **宿主源部署形态**：发布机执行发布脚本后，把 `dist/` 产物拷入主机 `updateDir`（或脚本直接带参数写入）；插件重启后主机源即可用。局域网/蒲公英场景手机直达主机，无 GitHub 依赖。
- **manifest 唯一权威的另一面**：`updateDir` 里旧 APK 不会被 App 枚举到；部署者负责保持目录整洁（文档提示）。
- **与既有验收清单的关系**：本 feature 的人工验收项并入 docs/06 §9 验收清单（新增「App 更新：双源检查 / 下载 / 签名预检 / 安装」一组）。