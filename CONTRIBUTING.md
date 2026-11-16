# 贡献指南

欢迎任何形式的贡献：提 issue、修 bug、加功能、补文档、二次开发。

## 参与方式

- **报告问题**：GitHub Issues —— 说明环境（dsh 版本 / 平台）、操作步骤、现象；移动端问题附截图更佳
- **提交代码**：Fork → 分支 → PR；小改动直接 PR，大功能先开 issue 讨论
- **文档**：README / docs/ 的任何改进都欢迎
- **二次开发**：见 `docs/08-扩展开发指南.md` —— 欢迎基于本项目做自己的定制并回馈上游

## 开发环境

- **插件**：Node.js 18+；在 `~/.dsh/profiles/<desktop|web>` 以 `file:` 依赖引入（见 docs/06-install-run.md；桌面版移动端用 LAN 桥）
- **App**：Flutter 3.47+ + Android SDK；`flutter analyze` 必须零问题

## 代码约定

- 插件：ESM，遵循现有 `lib/index.js` 的风格；新端点必须在 `docs/03-api.md` 补文档
- 原型：`prototype/app-prototype.html`（设计参考，零构建，改完直接刷新浏览器看效果）
- App：`flutter analyze` 零 warning；UI 使用 `theme.dart` 设计令牌，不硬编码颜色
- 提交信息：中文或英文均可，一句话说明改动（如 `fix: SSE 解析死循环`）
- 兼容边界：改动涉及内核服务依赖时，对照 `docs/09-compatibility.md` 的降级约定

## 测试要求

- 插件改动：跑 `tools/e2e-check.mjs`（需 `DSH_MOBILE_TOKEN` 环境变量）
- App 改动：`flutter analyze` + 真机冒烟（发消息/收通知/新建会话）
- 新端点：在 `docs/05-test-cases.md` 补用例

## 安全底线

- 任何新端点默认走统一鉴权；敏感数据（口令/二维码）只允许 loopback 读取
- 不引入公网暴露；见 `docs/04-security.md`

## 发布新版本（维护者清单）

> 本节是 [`docs/10-release.md`](docs/10-release.md)（发布操作手册）的摘要，冲突以该手册为准。
> 公共 npm 发布只有一条链路：**版本 tag 触发 `.github/workflows/publish-npm.yml`**，由 CI 按受保护分支
> `release-meta` 的发布政策完成「校验 → 构建签名 APK → 发版演练 → 先载体后插件发布 → 指针校验」。
> 发布动作（推分支、推 tag、试发布与正式发布）都需要维护者逐次授权。

**版本配对契约**（唯一口径，见手册 §1.4/§3）：插件版本 `X.Y.Z[-alpha.N|-rc.N]`，git tag 为 `v<完整插件版本>`，
App 版本 `X.Y.Z+<build>`，载体版本 `<完整插件版本>-app`。App 与插件只要求 **core（`X.Y.Z`）相同**，
不是完整版本字符串相等；`+N` 由全局单调分配，不能手工猜、也不能只改一处。

**分支与可发布状态**：`develop` 是集成分支与 alpha 发布线，保持可发布状态（版本已 bump、CHANGELOG 已更新、门禁通过）；
`main` 是**上游镜像**，只做 fast-forward，不直接提交、不改写历史。功能/修复走 `feature/*`、`fix/*` 分支，
经 PR 合入 `develop`；rc/stable 从 develop 已验证提交切 `release/vX.Y.Z`，只接受本版本修复（cherry-pick），
**禁止 merge develop 到 release**。破坏性/实验性改动走分支或 PR，不直接提交到 `develop`。

**维护者步骤**：

1. **发布前检查**（手册 §2）：`git fetch --multiple --tags origin github` → `node tools/next-build.mjs` 必须
   `RESULT: PASS`；目标版本未在 npm 占用；`git status --short` 干净；发布授权已取得。
2. **跑门禁**（手册 §2 的隔离子 shell；**禁止在运行中 profile 的 HOME 下跑**）：`node --test test/*.mjs` +
   `flutter analyze` + `flutter test` 全绿；发布插件/载体前还要跑发版演练
   （`node tools/npm-drill.mjs --dist <产物目录>` 或 `package-release.sh --drill`）并得到 `RESULT: PASS`（手册 §6）。
3. **原子 bump**：`node tools/prepare-release.mjs --version <完整插件版本> --build <next>`（如
   `--version 3.2.4-alpha.N`），一次写入插件版本、
   精确 carrier 别名、`dsh-mobile-app/pubspec.yaml` 的 `X.Y.Z+N` 与 `CHANGELOG.md` 骨架；填写 CHANGELOG 正文，
   确认 `git diff --check` 干净。
4. **本地打包与预检**：`cd dsh-mobile-app && flutter build apk --release`，再 `bash dsh-mobile-app/tools/package-release.sh`
   在 `dsh-mobile-app/dist/` 产出发布产物（APK、插件 tgz、`manifest.json`、载体 tgz、构建记录 `app-carrier.json`）
   并跑离线预检；预检/演练失败即停，不手改 `dist/`。本机打包**不发布 npm**；`UPDATE_DIR`、`MANIFEST_VERSION`、
   `ALLOW_TEST_MANIFEST_VERSION` 已退役（传入即 fail-closed）。
5. **提交并推送分支**（经授权）：alpha 推 `develop`，rc/stable 推 `release/vX.Y.Z`；两个远端都要推
   （本仓库 `origin` 为 GitLab 备份、`github` 为 PR 与 CI 源，两边必须一致）。
6. **打并推 tag**（经授权）：`git tag -a v<完整插件版本> -m "Release v<完整插件版本>"`；**先推分支、再推 tag**，
   两个远端都要推。tag 就是 CI 的触发条件（workflow 只监听 `v*` tag）。
7. **CI 发布**：workflow 校验 tag 可达性（alpha → `origin/develop`；rc/stable → 对应 `release/vX.Y.Z`）与
   `release-meta` 政策，现场构建签名 APK、校验证书、跑发版演练，先载体后插件发布，再按决策移动
   `app`/channel/`latest` 并校验指针不回退。失败或可见性未知按手册 §10 恢复：**不得把超时当作未发布，
   不得删 tag 重新分配**。
8. **发布后验证与设备验收**（手册 §9）：`npm view @marktrue/dsh-mobile-remote dist-tags versions --json`；
   `dist.integrity` 与本地 tgz 一致；release-meta 中发布意图为 `published`；再按 `docs/06-install-run.md`
   在真机验证 App 更新/首装，记录机型、网络与结果。
9. 大更新在 DSH 社区发帖；`CHANGELOG.md` 保持完整历史。

**版本保留原则**：

- 已发布到 npm 的版本内容不可变、不可覆盖；已发布 tag 与版本号不可删除或重用，发布出错只能申请**新版本**重来
  （手册 §1.4/§10）。
- 历史版本保留在 npm registry 与 git tag 中供回退。**当前发布链不创建 GitHub Release**，APK 通过 npm 载体分发
  （手册 §1.2/§8.1/§9）；仓库若存在旧 Release，仅作历史记录，不再新增。
- 同一签名覆盖安装，用户升级无痛，且能保留已连接设备信息；**不要更换签名 keystore**（换 keystore = 换应用）。

> 历史口径：旧文档中的「在 GitHub 网页创建 Release、上传 APK 与 tgz 两个附件」以及「手机侧载无自动更新」
> 属于旧发布链；自 issue #43 起改为 tag 触发 CI 发布 npm（插件 + 载体），App 走 npm 自动更新通道。

**待确认**：

- 人工兜底发布（workflow 不可用时的手工 `npm publish` 路径）由谁授权与执行：步骤见手册 §8.1，本仓库是否需要
  保留该路径待确认。
- 现有历史 GitHub Release 的最终处置（保留 / 归档）待确认；当前链路既不创建也不修改它们。
- 「大更新在 DSH 社区发帖」的具体渠道与模板未在本仓库文档中定义，待确认。
