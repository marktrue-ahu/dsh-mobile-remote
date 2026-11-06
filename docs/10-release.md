# 10 发布操作手册 — 从构建到正式发布

> 版本：v1.0 · 适用仓库：`dsh-mobile-remote`（插件 + Flutter Android App）
> 状态：本文件是**发布操作的唯一权威**。演练与预检由 `dsh-mobile-app/tools/` 下的工具实现；试发布与正式发布是**人工步骤**，须按仓库授权流程执行。
> 本文件编号 10；Android 构建与排障全文并入[附录 A](#附录-aandroid-apk-构建与排障)，不再单独成篇。

## 目录

1. [适用范围与前置](#1-适用范围与前置)
2. [发布前检查](#2-发布前检查)
3. [版本 bump](#3-版本-bump)
4. [构建](#4-构建)
5. [预检](#5-预检)
6. [演练](#6-演练)
7. [试发布](#7-试发布)
8. [正式发布](#8-正式发布)
9. [发布后验证](#9-发布后验证)
10. [失败处理与回滚](#10-失败处理与回滚)
11. [记录与清理](#11-记录与清理)
12. [release-meta 初始化、迁移与全局 build](#12-release-meta-初始化迁移与全局-build)
- [附录 A：Android APK 构建与排障](#附录-aandroid-apk-构建与排障)

---

## 1. 适用范围与前置

### 1.1 三个术语（不得混用）

| 术语 | 英文 | 做什么 | 是否接触公共 npm | 何时跑 |
|---|---|---|---|---|
| **预检** | preflight | 离线校验本地产物与元数据（清单/APK/载体 tarball/构建记录/发布字段/离线 `npm pack --dry-run`） | 否 | 构建后、发布前 |
| **演练** | drill | 用**临时本地 registry** 真实跑一遍「发布 → 全新安装 → 载体发现 → 版本更新 → 失败路径」 | 否（只连 `127.0.0.1`） | 预检通过后、试发布/正式发布前 |
| **试发布** | canary publish | 向**真实 npm** 发**一次性包名**探针，验证真实 registry 的接收/体积/标签链路（预发布版本方式与现有纯 X.Y.Z 契约冲突，见 §7.1） | **是（需授权）** | 首次发版/大版本/链路变更时 |

相关既有词汇：**发布清单**（`manifest.json`，配对权威）、**内容标识**（`plugin.contentSha256`）、**App 载体版本**（`X.Y.Z-app`，同包名预发布版本）。演练另有两个演练子域词汇：**演练 registry**（临时本地 Verdaccio 实例）、**演练版本**（`9.9.<随机补丁号>`，载体对应 `9.9.<补丁号>-app`；纯 X.Y.Z，不占正式版本线）。三词详细定义见 develop 的 `CONTEXT.md`（决策记录只落 develop，不在本分支重复）。

### 1.2 发布产物

一次正式发布形成以下产物（同一次发布、同一 HEAD）：

| 产物 | 位置 | 说明 |
|---|---|---|
| App APK | `<dist>/DSH-Remote-v<X.Y.Z>.apk` | 正式签名；清单 `app` 段描述它 |
| 主插件 tarball | `<dist>/dsh-mobile-remote-v<X.Y.Z>.tgz` | 由仓库根 `npm pack`；清单 `plugin` 段描述它 |
| 发布清单 | `<dist>/manifest.json` | schema 1；`app` + `plugin` 两段 + 顶层兼容镜像 |
| 载体 tarball | `<dist>/marktrue-dsh-mobile-remote-<X.Y.Z>-app.tgz` | 同包名 `X.Y.Z-app`；内含 APK + 清单 + 说明/许可；发布到 npm 的 `app` tag |
| 构建记录 | `<dist>/app-carrier.json` | 载体 tarball 的体积/哈希与两段身份；本地证据，不上传 |
| Release 三资产 | GitHub Release | 上面的清单 + APK + 主插件 tarball（逐字节一致） |

### 1.3 环境前置

| 依赖 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 22.15（仓库开发基线 v24） | `node --version` |
| npm | 11.x | `npm --version` |
| pnpm | 11.x（演练安装用） | `pnpm --version` |
| Verdaccio | **6.10.6**，全局安装（演练用，一次性） | `verdaccio --version` |
| Flutter/Android SDK | 构建 App 时（见附录 A） | `flutter doctor -v` |
| Git 工作区 | 发布 HEAD 干净；分支/版本经授权 | `git status --short` |

安装演练依赖（只装一次，脚本不会自动安装）：

```bash
npm i -g verdaccio@6.10.6
verdaccio --version   # 应输出 6.x
```

npm 全局前缀需可写（本机为 `~/.local`，已验证可用）；若 `EACCES`，先修 `npm config get prefix` 的权限，不要用 `sudo` 混装用户级工具。

### 1.4 六条硬规则

1. **公共版本号不可回收**：同一包名同一版本一旦发布，内容不可变、不可覆盖；发布失败/内容有误只能申请**新版本**重来。
2. **先载体、后插件**：载体 `X.Y.Z-app` 必须先发布成功并可解析，再发布主插件 `X.Y.Z`（发布窗口内主插件 404 属预期 fail-closed）。
3. **正式发布前必须演练通过**：`npm-drill` 演练失败一律阻断正式发布（本地工作流规则同步此门禁）。
4. **alpha 线在 develop**：`vX.Y.Z-alpha.N` tag 允许直接打在 `origin/develop` 的可达提交上；rc/stable tag 只允许对应 core 的 `release/vX.Y.Z`。CI 只校验**可达性**，不声称“tag 来自哪条分支”。
5. **发布 build 号全局单调**：`+N` 由全局分配规则决定（`release-meta` 水位 + 历史 tag + 发布前沿 +1），不是某条分支的本地计数器；发布前必须用 `tools/next-build.mjs` 分配、`tools/prepare-release.mjs` 原子 bump。
6. **发布政策记录唯一权威**：迁移水位、legacy tag 白名单、legacy carrier 核验映射与发布意图都在受保护分支 `release-meta` 的 `build-policy.json`；缺失/非法/双远端不一致 fail-closed，分支内副本不作为依据。

### 1.5 发布政策记录（`release-meta`）与全局 build 分配（issue #43）

自 issue #43 合入起，发布政策从「各分支本地递增 build + tag 只打 release」切换为：

- **alpha 线在 develop**：`vX.Y.Z-alpha.N` tag 允许直接打在 `origin/develop` 的可达提交上；rc/stable 仍只允许 `release/vX.Y.Z`。CI 用 `git merge-base --is-ancestor` 校验可达性，不声称 Git 不存在的“来源分支”语义。
- **发布 build 号全局单调**：`next = max(release-meta.watermark, 历史 tag build, 发布前沿) + 1`；发布前沿 = npm 上已发布 carrier 的 `appVersion` build 与 `legacyCarriers.appBuild` 的最大值。工作区 pubspec、未发布 tag、设备安装记录都不构成发布前沿。
- **全局权威是受保护分支 `release-meta` 的 `build-policy.json`**（`schema`、`watermark`、`legacyTags`、`legacyCarriers`、发布意图）。本机分配端同时校验 `origin/release-meta` 与 `github/release-meta` 的 SHA/内容完全一致；CI（`origin`=GitHub）读取自己的 `origin/release-meta`。**分支内同名文件只是提案镜像，不是分配或校验依据**；缺失、非法、双远端不一致一律 fail-closed。
- **发布意图**：每次发布在提交 npm publish 之前，把 tag / 插件与 carrier 版本 / build / 期望 integrity / 状态 `submitted` 写入 release-meta；确认可见后标记 `published`。提交后无法确认可见性（E409/staged、轮询超时、响应丢失）时标记 `unknown`，阻断后续发布与通道移动，必须人工查询 registry 后恢复；**不得把超时当作“确定未发布”，不得删除 tag 重新分配**。
- **迁移水位**：迁移时 `watermark = 32`（develop 当前 build），历史 8 个 tag 进入 `legacyTags`，8 个已发布 carrier 逐一登记 `legacyCarriers`（3 个缺顶层 `appVersion` 的旧 carrier 必须下载 tarball、按 `dist.integrity` 校验后读内嵌清单/APK build）。初始化/校验命令见 §12。
- **app / channel 指针只前进**：`app` 按 carrier 的**配对插件版本**（剥离 `-app`）比较，只有候选更新才移动；alpha/rc 的插件 channel 同样先比较后移动，候选 ≤ 当前时插件用 `<channel>-staging` 发布、channel 保持不变（反回退）。latest 只有 stable 可前进。
- **RC 期间不再冻结 develop tag**：alpha 与 rc 可交错发布，按发布时间安装的 versionCode 单调。本期只保证**同 core** 交错；跨 core 更新仍需人工安装（见 §12.4）。

工具：`node tools/next-build.mjs`（只读分配）、`node tools/prepare-release.mjs`（原子 bump）、`node tools/release-gate.mjs`（CI 判定/发布意图/指针校验/BUILD 与 manifest 断言）、`node tools/release-meta-bootstrap.mjs`（迁移种子与校验）。所有 git/npm 外部命令都有界超时（挂起会以稳定 reason fail-closed，如 `npm-metadata-unavailable` / `git-metadata-unavailable`）。

---

## 2. 发布前检查

按顺序执行；任一项不满足即停止，不放行发布。

- [ ] **先读发布政策记录**：`git fetch --multiple --tags origin github` 后运行 `node tools/next-build.mjs`，必须 `RESULT: PASS`；输出 next build 与 release-meta 的 watermark/发布前沿一致，且 `origin/release-meta` 与 `github/release-meta` 内容一致（双远端）。缺失/不一致/存在未关闭发布意图 → 停止。
- [ ] 规划中的插件版本 `<X.Y.Z[-prerelease]>` 与载体版本 `<X.Y.Z[-prerelease]>-app` 都未在 npm 上占用；`node tools/prepare-release.mjs` 会用只读 `npm view` 预检。alpha tag 必须落在 develop 可达提交上，rc/stable 必须落在对应 `release/vX.Y.Z`。
- [ ] `latest` 语义按 ADR 0025 收敛：alpha/rc 发布前后 `latest` 必须不变；只有 stable 可前进。bootstrap 期 `latest` 允许暂为 prerelease（当前为 `3.2.3-rc.1`），首个 stable 发布后必须指向 stable；不为满足规则自动发布 stable、不删除/改名历史版本。
- [ ] 当前分支与 HEAD 符合发布授权；`git status --short` 干净（或仅有不影响产物的明确变更）。
- [ ] 版本配对一致（见 §3 校验命令）：根 `package.json` 的插件完整版本、App `pubspec.yaml` 的 `X.Y.Z+N`（core 必须匹配插件）、根 `package.json` 精确载体别名（`<插件完整版本>-app`）。
- [ ] `CHANGELOG.md` 已写本次发布条目（清单 `notes` 取最新 `##` 条目全文，缺条目构建会失败）。
- [ ] 门禁测试通过（**局部子 shell + 统一隔离变量；禁止在运行中 profile 的 HOME 下跑**）：
      ```bash
      # fail-fast：Node 非零即整体失败（不会再跑 Flutter）；flutter analyze 非零不会跑 flutter test。
      # 失败时保留 GATE_HOME 作为证据（不自动删除；确认无用后再手动清理）。
      (
        set -euo pipefail
        GATE_HOME="$(mktemp -d)"
        printf 'GATE_HOME=%s\n' "$GATE_HOME"
        export HOME="$GATE_HOME" DSH_HOME="$GATE_HOME/.dsh"
        export XDG_CONFIG_HOME="$GATE_HOME/.config" XDG_CACHE_HOME="$GATE_HOME/.cache"
        export XDG_DATA_HOME="$GATE_HOME/.local/share" npm_config_cache="$GATE_HOME/.npm-cache"
        export PUB_CACHE="$GATE_HOME/.pub-cache"
        node --test test/*.mjs
        ( cd dsh-mobile-app && flutter analyze && flutter test )
      )
      ```
      > 为什么：部分 HTTP 夹具会真实调用插件 `apply()`，插件启动逻辑按 `homedir()` 读取并收敛
      > 更新事务；只隔离工作区或只设 `DSH_HOME` 不足以隔离这一读写链，Flutter 还会读取
      > `XDG_CONFIG_HOME`/`PUB_CACHE`。统一 `export` 让 Node 与 Flutter 子进程共用同一临时根；
      > `set -euo pipefail` 保证前一步失败不会继续执行后续门禁。
- [ ] 构建机环境就绪（附录 A）；签名 keystore 已备份、未丢失。
- [ ] 演练环境就绪：`verdaccio --version`；且已在当前 HEAD 的发布目录上跑通 §6 演练（`RESULT: PASS`）。
- [ ] 已取得本次**发布授权**（试发布与正式发布均需授权；本手册不代授权）。
- [ ] 发布窗口内不再 rebase/改版本/重打产物；发布记录人、时间、版本已登记。

---

## 3. 版本 bump

插件版本可为稳定版 `X.Y.Z`，或经授权的 npm prerelease `X.Y.Z-<pre>`（如 `3.2.1-alpha.1`）；App 版本仍为 `X.Y.Z+N`，其 core 必须与插件 core `X.Y.Z` 相同，`+N` 只增不减以防 Android 降级。载体版本始终是**插件完整版本追加 `-app`**，例如 `3.2.1-alpha.1-app`。**不要手工逐处改版本号**（容易漏掉精确 carrier alias，导致发布预检失败）。统一用工具：

```bash
# 1) 只读分配全局下一个 build（读 release-meta 双远端 + 历史 tag + npm 已发布 carrier）
node tools/next-build.mjs          # 期望 RESULT: PASS，并记录 next build

# 2) 原子 bump：package.json version + 精确 carrier alias + pubspec + CHANGELOG 骨架
node tools/prepare-release.mjs --version X.Y.Z[-pre] --build <next>
git diff --check

# 3) 填写 CHANGELOG 的「变更」正文（清单 notes 取最新 ## 条目全文），然后跑门禁
```

`prepare-release.mjs` 一次写入并校验：根 `package.json` 的 `version` 与 `optionalDependencies["@marktrue/dsh-mobile-remote-app"] = "npm:@marktrue/dsh-mobile-remote@<插件完整版本>-app"`、`dsh-mobile-app/pubspec.yaml` 的 `version: X.Y.Z+N`（core 与插件一致、build 必须大于当前值）、`CHANGELOG.md` 骨架；并跑 `exactCarrierAliasChecks` 与只读 npm 占用检查。任一步失败不会留下半更新。

校核（任一项不通过不得继续）：

```bash
node -e '
const p=require("./package.json");
const alias=p.optionalDependencies?.["@marktrue/dsh-mobile-remote-app"];
const want=`npm:${p.name}@${p.version}-app`;
if(alias!==want) throw new Error(`载体别名不精确: ${alias} != ${want}`);
console.log("version:",p.version,"alias:",alias);
'
grep -nE '^version:' dsh-mobile-app/pubspec.yaml
head -20 CHANGELOG.md
```

禁止：改已发布版本的任何字节；用 `latest`/范围写载体别名；只为让演练通过而改版本号；绕过 `next-build` 自行猜一个 build。

---

## 4. 构建

构建/签名/代理/Gradle/缓存/排障的完整细节在[附录 A](#附录-aandroid-apk-构建与排障)。本章只给发布流程需要的最短路径。

### 4.1 一条命令产出全部发布产物

```bash
# 清场：确保 dist 内没有别的版本残留（只删本地产物目录，不影响仓库源码）
rm -rf dsh-mobile-app/dist

# 构建 APK（若已有正式签名 APK 可跳过，见附录 A.3）
cd dsh-mobile-app
flutter pub get && flutter analyze && flutter test
flutter build apk --release
cd ..

# 打包：APK + 主插件 tgz + 完整配对清单 + App 载体 + 发布预检（fail-closed，含本地严格校验）
bash dsh-mobile-app/tools/package-release.sh
```

产物在 `dsh-mobile-app/dist/`（见 §1.2）。脚本行为：先 `npm pack` 主插件，再由 tgz + APK 生成清单，最后打载体并跑**离线预检**；任何一步失败即非零退出，不产出可发布产物。

> `UPDATE_DIR=<插件 updateDir>` 可把 APK + 清单 + 插件 tgz 拷入主机更新目录（人工区）。正式发布前确认目标目录，不要在宿主运行中重启验证时误清。

### 4.2 测试 manifest（仅联调，不用于发布）

反复验证 App 自动更新时可手工覆盖清单版本（APK 构建号保持不变，清单写更高 build）：

```bash
ALLOW_TEST_MANIFEST_VERSION=1 MANIFEST_VERSION="X.Y.Z+99" \
  bash dsh-mobile-app/tools/package-release.sh
```

该通道**不构建载体、不走载体配对门禁**，脚本会打印 `WARN`；正式发布严禁设置这两个变量。

> 分支侧文档只保留构建最短路径与排障附录；App 架构、安装、重建等日常说明仍看 `docs/06-install-run.md`。

---

## 5. 预检

预检 = **离线**校验，不联网、不发布、不写盘（`npm pack --dry-run`）。两层：

### 5.1 发布前预检（载体 npm 发布字段 + 产物一致性）

```bash
node dsh-mobile-app/tools/publish-carrier-check.mjs dsh-mobile-app/dist
# 或：npm run release:carrier:check -- dsh-mobile-app/dist
# 或：bash dsh-mobile-app/tools/package-release.sh --check-only dsh-mobile-app/dist
```

校验内容：载体发布元数据（`private=false`、`publishConfig.access=public`、`publishConfig.tag=app` 且非 latest、`files` 含 APK 与 `manifest.json`、version=`X.Y.Z-app` 且与主包版本配对、license/description/repository 齐备）；主包精确别名；清单 ↔ APK ↔ 构建记录 ↔ 载体 tarball 的 size/sha256；`npm pack --dry-run` 打包内容恰为 APK + 清单 + README + LICENSE + package.json。

输出逐条 `PASS/FAIL`；失败行带稳定 reason（如 `carrier-publish-tag-not-app`），结尾 `RESULT: FAIL` 且退出码非 0。

### 5.2 清单严格校验（发布目录内部一致性）

```bash
node dsh-mobile-app/tools/verify-update-manifest.mjs dsh-mobile-app/dist \
  --require-carrier --package-json package.json
```

含发布顺序前置、APK 内部版本实读（环境有 `aapt`/`aapt2` 时）、载体字段红线、tgz 运行时闭包等。

预检不通过 = 停止；修产物或版本后从头构建，**不要手工改 dist 内任何文件**。

---

## 6. 演练

> 工具位置约定：**发布插件的工具在仓库根 `tools/`**（演练 `tools/npm-drill.mjs`）；
> **发布 App 的工具在 `dsh-mobile-app/tools/`**（APK 构建、载体打包、发布预检、
> `package-release.sh`）。演练属于插件发布，因此位于根 `tools/`。


演练用临时本地 registry 完整预演发布与安装链路，**不接触公共 npm、不消耗任何公共版本号**。演练通过是正式发布的前置门禁。

### 6.1 前置

- 全局安装 Verdaccio（§1.3）；脚本只检查并提示，不自动安装。
- 已构建好的发布目录（§4）；或加 `--build` 让演练先跑一次发布构建。
- 演练本身不需要手机、不需要桌面版 GUI；预算 < 10 分钟。

### 6.2 命令

```bash
# 完整演练（默认 --phases all；自动起本地 registry，退出销毁现场）
# 稳定版默认插件 tag=latest；预发布显式传 tag（如本次 alpha），carrier 恒为 app，latest 不动。
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --plugin-tag alpha

# 只做离线预检阶段（不联网、不需要 Verdaccio）
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --phases preflight

# 只跑某几段调试（更早的阶段作为静默前置自动执行；更晚的未选中阶段不执行）
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --phases publish,install --plugin-tag alpha

# 复用已有 registry（CI/调试；默认只允许本机/私网地址，远端需 `DRILL_ALLOW_REMOTE_REGISTRY=1` 显式放行；低上限实例仍由脚本本机启动）
# R1 续：只迁移**受检 registry 路径**需要的凭据（同 host 其他路径不迁移）；每次 npm publish
#        的 argv 同时固定 --registry 与单参数 --@<scope>:registry=<受检URL>，并在投影时受控
#        改写包内 publishConfig 的 registry 路由；发布前用专用配置自检实际生效路由。
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --registry http://127.0.0.1:4873 --plugin-tag alpha

# 保留现场（工作目录、registry 存储、全部日志）
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --keep

# 演练前先构建（等价先跑 package-release.sh）
node tools/npm-drill.mjs --dist dsh-mobile-app/dist --build

# 与发布脚本集成（两步都要显式请求；默认构建流程不会自动跑演练）
bash dsh-mobile-app/tools/package-release.sh --drill           # 正常构建后追加演练，失败即阻断
bash dsh-mobile-app/tools/package-release.sh --drill-only      # 只演练已有 dist（不构建、不发布）
```

> 维护者/CI：默认测试套件用 `--phases preflight` 覆盖离线 CLI 契约（不联网、不需要 Verdaccio）；
> 完整五阶段演练用 opt-in 开关：`NPM_DRILL=1 node --test test/npm-drill-e2e.test.mjs`。

CLI 契约：

| 参数 | 含义 |
|---|---|
| `--dist <dir>` | 发布产物目录（默认 `dsh-mobile-app/dist`） |
| `--phases <list>` | `preflight,publish,install,discover,update,failure` 或 `all`；默认 `all` |
| `--plugin-tag <tag>` | 主插件演练 dist-tag；默认 `latest`，prerelease 用 `alpha` 等专用 tag；载体始终 `app` |
| `--registry <url>` | 复用已有 registry（跳过启动正常实例） |
| `--keep` | 保留演练现场（默认成功后销毁临时现场） |
| `--build` | 演练前先执行发布构建 |
| `-h/--help` | 帮助 |

### 6.3 五阶段与 20 条断言

| 阶段 | 断言 | 验收内容 |
|---|---|---|
| **发布**（publish） | A1–A4 | A1 registry 存活；A2 插件发布成功且可查询；A3 载体发布成功，`app`→载体，主插件由 `--plugin-tag` 指定的 tag→插件；预发布时 `latest` 不得被移动；A4 重复发布同版本被拒 |
| **全新安装**（install） | A5–A10 | A5 全新隔离 HOME + 新 profile 安装主插件成功；A6 载体别名目录存在；A7 别名目录 `package.json` 的真实 name/version 正确且带 `dsh.appCarrier` 标记；A8 载体内 APK size+sha256 与清单一致；A9 只在顶层 `snapshots:` 段内、快照直接层级读取 `optionalDependencies` 的**精确映射**（离开该段即停止；拒绝越界层级/嵌套/重复键/仅注释命中）；A10 `.modules.yaml` 的 `hoistedLocations[载体]` 必须是 `string[]`，落点规范化后**严格等于** `node_modules/<别名>`（拒绝任意前缀/后缀与 `..` 越界；绝对路径按已知 profile 根解析） |
| **真实布局发现**（discover） | A11–A13 | A11 实际安装布局下载体发现返回 found 且来源为插件自身作用域；A12 载体清单 App 版本的**构建号**与发布目录清单一致、APK 身份（file/size/sha256）一致（语义版本被投影为演练版本）；A13 以**实际安装目录中的载体清单**为 expected，要求安装后插件内容标识等于该清单 `plugin.contentSha256`，且载体发现返回 `pluginContent.matches === true`、随包清单身份与本次投影一致 |
| **版本更新**（update） | A14–A16 | A14 用指定主插件 tag 发布第二对新版本，载体 tag 仍为 `app`，预发布时 `latest` 不得被移动；A15 原安装更新成功，别名目录版本变为新载体版本；A16 旧载体被替换，再次发现得到新版本 |
| **失败路径**（failure） | A17–A20 | A17 只发插件不发载体：先核验实际安装的插件版本=pluginOnly 且 `optionalDependencies` 精确指向**未发布**的载体版本；再要求 registry 返回**结构有效**的 packument（同名、`versions` 为非数组对象、能看到刚发布的 pluginOnly）且其中不含该载体版本（坏形状一律 `drill-carrier-absence-check-failed`）；最后断言安装不报错但别名目录缺失、发现结果为「载体未安装」；A18 载体发布元数据不合规时预检以稳定 reason 失败；A19 版本配对错误时预检以稳定 reason 失败；A20 低上限（10mb）registry 发布大体量载体失败——只认 npm **结构化错误码** `npm error code E413`，不扫描任意文本里的裸数字 |

离线阶段 `preflight`（`--phases preflight`）另有辅助断言：P1 在**投影之前**校验源产物不变量（解包真实插件 tgz → name/version 与源清单一致、`optionalDependencies` 含精确别名、用真实包内容实算内容标识并与清单比对、再对**源 dist** 跑发布预检；失败 reason 为 `drill-source-*`，不得进入投影）；P2 演练版本命名合法。默认测试套件只跑该离线阶段，不联网。setup 阶段另有 S2：scope 从**已校验的源包名**推导；用与发布相同的 npm 配置执行 `npm config get registry` / `npm config get @<scope>:registry`，两者都必须等于受检地址；同时记录投影包内 `publishConfig` 路由改写数与同 host 其他路径凭据未迁移数（发布 argv 另以单参数 `--@<scope>:registry` 固定作用域路由）。

### 6.4 演练版本与隔离

- 演练版本：`9.9.<随机补丁号>`，载体对应 `9.9.<补丁号>-app`；第二对版本用**不同补丁号**；跨次运行互不冲突，也不会被误认为正式版本。
  > 演练把**分发身份**投影到独立的稳定版 `9.9.x`，保留源 APK 字节与 build 号；源 prerelease 本身仍须先通过预检。完整演练覆盖安装/载体发现/更新与失败路径；用 `--plugin-tag alpha` 时还会验证 `alpha`→主插件、`app`→载体，且 `latest` 在 prerelease 发布前后不变。
- 演练 registry：临时 Verdaccio，`127.0.0.1:<随机空闲端口>`，数据目录在仓库外；正常实例 `max_body_size: 200mb`；失败路径另起 10mb 上限实例复现 E413；无 uplink，不代理公共源。
- 演练 HOME/安装目录：独立临时目录，不影响本机 `~/.dsh`、运行中 profile 与 pnpm store。
- 演练退出：默认销毁临时 registry 与安装现场；失败时保留证据目录（便于贴 issue）。`--keep` 保留全部现场。

### 6.5 输出、记录与 reason

- 逐条 `PASS/FAIL`（失败行带 `[reason:drill-*]`）+ 阶段摘要 + `RESULT: PASS|FAIL` + `REASONS:` + `EVIDENCE:`（证据目录）+ 退出码非 0 即失败。
- 运行记录：`<状态目录>/drill/<UTC时间>-<演练版本>/run.json`（阶段/断言/结果/reason/耗时、`pluginTag`）+ registry 与包管理器日志。状态目录默认 `~/.dsh/mobile-remote/drill`（可用 `DSH_DRILL_STATE_DIR` 覆盖）。
- 常见 reason：`drill-registry-not-installed`（未装 Verdaccio）、`drill-registry-start-failed`、`drill-registry-not-allowed`、`drill-registry-scope-mismatch`（实际生效的 registry/scope 路由不等于受检地址）、`drill-source-plugin-metadata-mismatch` / `drill-source-optional-alias-missing` / `drill-source-content-digest-mismatch` / `drill-source-artifact-mismatch`（源产物不变量）、`drill-publish-failed`、`drill-dist-tag-mismatch`、`drill-install-failed`、`drill-carrier-alias-missing`、`drill-lockfile-alias-missing` / `drill-hoisted-mapping-missing`（布局结构）、`drill-plugin-digest-mismatch` / `drill-installed-carrier-manifest-mismatch`（安装后清单/摘要）、`drill-plugin-only-metadata-mismatch` / `drill-missing-carrier-unexpectedly-present` / `drill-carrier-absence-check-failed`（缺载体降级前置与缺失证明）、`drill-e413-not-reproduced` 等；完整词表见脚本头部注释。

### 6.6 失败时

1. 看证据目录下日志：`verdaccio-*.log`、`npm-publish-*.log`、`pnpm-*.log`。
2. 修代码/产物/环境后**重新构建**再跑；不要手工改 registry 数据或安装目录绕过断言。
3. 演练失败不得进入正式发布；若失败原因属于工具缺陷，先在分支修复并补测试。

---

## 7. 试发布

> **需授权**：试发布会向真实 npm 发布内容。未经明确授权不得执行。本手册不实现自动化。

目的：验证公共 npm 的**真实接收能力**（体积/请求体上限、认证、dist-tag 机制、镜像可取性）——这些是本地演练覆盖不到的。试发布是**真源补充**，不能替代 §5 预检与 §6 演练。

> **同包名 prerelease**：发布工具与运行时现已支持经授权的 `X.Y.Z-<pre>` 插件版本，载体精确配对为 `<插件完整版本>-app`。alpha 示例：插件 `3.2.4-alpha.N`、App `3.2.4+<全局 build>`、载体 `3.2.4-alpha.N-app`；载体使用 `app` tag（只有决策允许前进时才移动）。
>
> GitHub Actions [`publish-npm.yml`](../.github/workflows/publish-npm.yml) 自 issue #43 起按发布政策执行：tag 可达性（alpha→develop、rc/stable→release/vX.Y.Z）、`release-meta` 权威记录、已发布状态判定与 build 前沿、发布意图/unknown、app 先比较后移动、latest 仅 stable 前进。稳定版使用 `latest`，预发布使用 prerelease 第一段（如 `alpha`）；**预发布永不移动 `latest`**。发布 alpha 前不再要求 `latest` 是稳定版（bootstrap 例外），但仍须通过 §5 预检与 §6 演练。所有真实发布会话必须由本手册的授权流程触发，不能绕过 workflow 的 fail-closed 校验。

### 7.1 一次性包名探针（可选的公共源接收验证）

```bash
# 需授权后人工执行。准备阶段任何失败都必须中止（publish 调用次数为 0）。
(
  set -euo pipefail
  # APK 路径：显式参数优先；否则按当前版本推导（也可显式传：bash ./probe.sh <apk>）
  APK="${1:-dsh-mobile-app/dist/DSH-Remote-vX.Y.Z.apk}"
  test -s "$APK" || { echo "APK 缺失或为空：$APK" >&2; exit 1; }
  PROBE_NAME="@marktrue/dsh-mobile-remote-probe-$(date -u +%Y%m%d%H%M%S)"
  PROBE_DIR="$(mktemp -d)"
  cp "$APK" "$PROBE_DIR/" || { echo "复制 APK 失败" >&2; exit 1; }
  cat > "$PROBE_DIR/package.json" <<EOF
{ "name": "$PROBE_NAME", "version": "0.0.1", "description": "one-off npm reception probe", "license": "MIT", "files": ["$(basename "$APK")"] }
EOF
  # 用 npm pack 的 JSON 输出定位**唯一** tarball（不用通配符；pack 失败即退出）。
  PACK_JSON="$( cd "$PROBE_DIR" && npm pack --json --pack-destination "$PROBE_DIR" )"
  TGZ_NAME="$( printf '%s' "$PACK_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);if(!Array.isArray(a)||a.length!==1)process.exit(2);process.stdout.write(a[0].filename);});' )"
  test -n "$TGZ_NAME" && test -s "$PROBE_DIR/$TGZ_NAME" || { echo "npm pack 未产出唯一 tarball" >&2; exit 1; }
  TGZ="$PROBE_DIR/$TGZ_NAME"
  # 发布前核验：包名确为本次一次性 probe；tarball 内含 APK 且字节数/sha256 与源 APK 一致。
  node - "$TGZ" "$PROBE_NAME" "$APK" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [tgz, probeName, apk] = process.argv.slice(2);
const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const pkg = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
if (pkg.name !== probeName) { console.error(`包名不是本次一次性 probe：${pkg.name}`); process.exit(1); }
if (pkg.name === "@marktrue/dsh-mobile-remote") { console.error("拒绝用正式包名做探针"); process.exit(1); }
const apkName = path.basename(apk);
const entry = list.find((name) => name === `package/${apkName}`);
if (!entry) { console.error(`tarball 内缺少 APK：${apkName}`); process.exit(1); }
// 75MB 级 APK 远超 execFileSync 默认 1MB maxBuffer：必须显式放大，否则 ENOBUFS（准备失败即停）。
const packed = execFileSync("tar", ["-xzOf", tgz, entry], { maxBuffer: 512 * 1024 * 1024 });
const source = fs.readFileSync(apk);
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
if (packed.length !== source.length || sha(packed) !== sha(source)) {
  console.error(`tarball 内 APK 与源 APK 不一致（${packed.length}/${source.length} 字节）`);
  process.exit(1);
}
console.log(`ok: ${probeName} 内含与源一致的 ${packed.length} 字节 APK`);
NODE
  echo "准备完成：$TGZ"
  # 只有以上全部通过且已获授权，才执行显式 canary 发布并核对：
  # npm publish "$TGZ" --tag canary --access public
  # npm view "$PROBE_NAME" dist-tags versions --json
)
```

失败即停：APK 缺失/空、`cp` 失败、`npm pack` 非零或产出不是唯一 tarball、包名不是本次一次性 probe、tarball 内缺 APK 或字节/哈希与源不一致——任一发生都不会执行 publish。
核对项：发布请求体/体积被公共源接收；`canary` tag 正确、`latest` 未被探针占用；镜像站可取得该 tarball；认证与 npm 客户端配置指向预期源（`npm config get registry`）。
达到验证目的后按 7.2 的边界处理回收（能 unpublish 就及时操作；不能则记录并遗忘该一次性名）。

### 7.2 边界与风险

- **版本不可回收**：任何试发布（含探针）发布的版本都不可覆盖；探针版本号也占该一次性名的不可变版本（用一个版本即可，勿反复发同版本）。
- **72 小时 unpublish 边界**：公共 npm 对 `unpublish` 有严格限制（超过 72 小时的版本一般不可删；受政策/依赖/下载量约束），即使删成功也可能已被镜像缓存。
- **包名长期可见**：一次性包名可能被镜像站长期保留；命名必须可识别为试验包（`-probe-<时间>`）并记录用途/回收说明。
- **验证边界**：探针**不能**验证载体别名解析、载体发现、安装布局与版本更新——这些只由 §6 演练（使用真实配对产物）覆盖；也不得用探针结果绕开预检/演练。
- **授权**：任何真实 npm 写入（探针或正式发布）都要事先取得发布授权并记录包名/版本/时间。

> 试发布只补公共接收/镜像这一环；**正式发布仍必须**先过 §5 预检与 §6 演练。

---

## 8. 正式发布

前提：§5 预检通过、§6 演练通过（`RESULT: PASS`，或使用 `package-release.sh --drill` 由脚本阻断失败）、§7 试发布（如需要）通过、已取得发布授权。

### 8.1 发布方式：CI workflow（默认）与人工兜底

**默认路径（issue #43 起）**：版本 tag 推送触发 `.github/workflows/publish-npm.yml`，由 workflow 按发布政策自动完成：

1. tag 身份、精确 carrier alias、pubspec `+N` 校验；
2. 可达性：alpha → `origin/develop`；rc/stable → `origin/release/v<core>` 且分支 core 匹配；
3. 读取受保护 `release-meta` 的 `build-policy.json`（缺失/非法/双远端不一致 → fail-closed）；
4. 已发布状态判定 → build 前沿校验 → app/latest/channel 决策（`tools/release-gate.mjs`；channel 反回退：候选不大于当前 channel 时用 staging tag）；
5. 现场构建签名 APK、校验证书、跑完整发版演练，并断言 BUILD = `manifest.app.version` = carrier 记录/内嵌清单（`verify-package`）；
6. 在 release-meta 记录发布意图（`submitted`）；
7. 先载体后插件发布；E409/staged/轮询超时 → `unknown` 并阻断（见 §10.3）；
8. 按决策移动 channel/app/latest（app/channel 只前进；channel 决策为 staging 时插件留在 staging tag、channel 不动；latest 仅 stable），发布后校验指针不回退；
9. 关闭发布意图（`published`），校验 tarball integrity 与 carrier 身份元数据。

> 旧 tag 重跑（插件与 carrier 均已发布）是**只读幂等成功**：不要求当前 channel 仍指向旧版本，也不会把 app/latest 指回旧版。

**人工兜底**（workflow 不可用且已获授权时）必须遵守同一政策：

1. **先发载体**（默认 `app` tag，绝不 latest；若候选配对插件版本不大于当前 `app`，改用临时 tag 发布并保持 `app` 原值）：

   ```bash
   PLUGIN_VERSION=3.2.4-alpha.N
   CARRIER_VERSION="${PLUGIN_VERSION}-app"
   npm publish "dsh-mobile-app/dist/marktrue-dsh-mobile-remote-${CARRIER_VERSION}.tgz" \
     --tag app --registry=https://registry.npmjs.org \
     --@marktrue:registry=https://registry.npmjs.org
   ```

2. **核验 registry 中的载体**（不能只看退出码）：

   ```bash
   npm view "@marktrue/dsh-mobile-remote@${CARRIER_VERSION}" version dist.integrity --json \
     --registry=https://registry.npmjs.org --@marktrue:registry=https://registry.npmjs.org
   npm view @marktrue/dsh-mobile-remote dist-tags --json \
     --registry=https://registry.npmjs.org --@marktrue:registry=https://registry.npmjs.org
   # 期望：app 指针 = 本次 carrier（或保持更高的原值）；latest 不被预发布移动
   ```

3. **发布同一份主插件 tgz**（禁止重打）：alpha→`--tag alpha`、rc→`--tag rc`、stable→`--tag latest`。**先比较当前 channel**：若候选插件版本不大于当前 alpha/rc channel（或 stable 的 latest 决策是 keep），改用 `<channel>-staging`/`release-staging` 临时 tag 发布，**不移动 channel/latest**；只有候选更新时才移动。

   ```bash
   npm publish dsh-mobile-app/dist/dsh-mobile-remote-v${PLUGIN_VERSION}.tgz \
     --tag alpha --registry=https://registry.npmjs.org \
     --@marktrue:registry=https://registry.npmjs.org
   npm view @marktrue/dsh-mobile-remote dist-tags --json \
     --registry=https://registry.npmjs.org --@marktrue:registry=https://registry.npmjs.org
   # 必须看到 alpha = 本次版本、app = 本次 carrier、latest 保持原值
   ```

4. **发布 Release 三资产**（同一清单、同一 APK、同一主插件 tgz；文件名/大小/哈希逐字节一致）。
5. **记录结果**：两次发布各自的耗时/结果/公开 URL；失败与部分成功按 §10 处理。

> 人工发布会话同样必须先把发布意图写入 release-meta（`node tools/release-gate.mjs record-intent ...`），发布后标记 published/failed；无法确认可见性时标记 unknown 并停止。

### 8.2 发布窗口注意事项

- 载体已发、主插件未发期间，`pnpm add @marktrue/dsh-mobile-remote` 会 404——这是**预期 fail-closed**（防止装到没有配对载体的插件），不是故障；尽快完成第 3 步。
- 跨 npm/Release 无原子事务：任何一步成功都算部分完成；重试只能复用**已成功的同一内容**，已发布版本禁止覆盖。
- **alpha 在 develop**：先推 develop、再推 tag（双远端）。RC 期间 develop 保持与 release 相同 core，避免跨 core 更新失败。
- **不要冻结 develop tag**：alpha/rc 可交错；但必须先通过 `next-build` 基于最新发布前沿分配 build，再 bump/tag。
- 发布期间不要改分支、不要重跑构建；如需重来必须申请新版本。已发布的 tag 不得删除/移动；未发布 tag 只有在确认**从未提交 publish 请求**（无 intent/unknown）且获授权时才可删除重打。
- 发布 token 需能写入受保护分支 `release-meta`；未配置时 workflow 在发布前 fail-closed。
- 若配置 `vars.RELEASE_META_SECONDARY_REMOTE_URL`（第二 release-meta 远端，如 GitLab 镜像），workflow 会 `git remote add` 并校验双远端 SHA/内容一致；未配置时 CI 以 `origin`（GitHub）为权威，本机分配端仍校验 origin+github。

---

## 9. 发布后验证

依次核验（只读）：

1. **registry 元数据**：`npm view @marktrue/dsh-mobile-remote dist-tags versions --json`；
   - alpha/rc：决策为 move 时对应 channel = 本次版本；决策为 keep 时 channel 已等于候选；决策为 staging 时 channel 必须保持发布前值（未回退）。`app` 指向本次 carrier（或保持更高原值），`latest` 与发布前一致；
   - stable：`latest` 指向本次稳定版本（或保持更高的既有 stable）。
2. **字节一致**：查询本次插件版本与 carrier 版本的 `dist.integrity`，与本地 tgz `sha512` 一致；下载后 sha256 同样一致。
3. **发布意图状态**：`git show origin/release-meta:build-policy.json` 中本次 tag 的意图应为 `published`，且没有为其它 tag 的未关闭 `submitted`/`unknown` 意图；未知状态按 §10.3 人工恢复。
4. **镜像可取性**：在有代表性的镜像/网络环境重试上述查询与下载（记录耗时）。
5. **全新安装冒烟**：在隔离 HOME/新目录 `pnpm add @marktrue/dsh-mobile-remote@<本次插件版本>`，确认精确别名目录存在且版本为 `<本次插件版本>-app`、APK 哈希与清单一致。
6. **Release 三资产**：GitHub Release 的清单/APK/插件 tgz 与本地 dist 逐字节一致（sha256）。
7. **宿主更新目录**：如使用 `UPDATE_DIR`，确认清单/APK/tgz 已落位且 `manifest.json` 可解析；宿主重启后更新入口可用。
8. **真机**：按 `docs/06-install-run.md` 手工验证 App 更新/首装（本手册不自动化真机），记录机型、网络与结果。
9. **回滚预案**：确认上一版本插件 tgz/载体/APK 仍可取得（本地 dist 与 Release 记录），并知道回滚操作（§10）。

---

## 10. 失败处理与回滚

### 10.1 发布失败分类

| 现象 | 判断 | 处理 |
|---|---|---|
| 预检失败（`RESULT: FAIL` + reason） | 本地产物/元数据问题 | 修产物后重新构建；禁止手改 dist |
| 演练失败 | 安装/别名/dist-tag/更新链路问题 | 按 reason + 证据日志修复；重跑演练 |
| `E403`/`EPUBLISHCONFLICT`（版本已存在） | 同版本已发布（不可覆盖） | 申请**新版本**；如属误发立即评估 unpublish 政策，不静默覆盖 |
| `E413`（请求体过大） | registry 体积上限 | 换用支持大包的 registry 配置/方案；记录证据，回到方案选择 |
| 载体已发、主插件失败 | 部分成功（预期 fail-closed 窗口） | 修因后用**同一 tgz** 重试；不得重打；记录部分成功 |
| 宿主拉不到/装不上 | 镜像滞后或版本选择问题 | 核验镜像可取性；给出诊断与手工兜底路径（见 §9） |
| build 不大于已发布前沿（过期发布） | 排队期间更高 build 已发布 | 不发布；确认从未提交 publish 请求且获授权后才可删 tag 重新分配；绝不覆盖已发布版本 |
| 部分发布（carrier 已发、插件未发） | 恢复会话 | 用同一 tag 重跑；CI 排除自身 carrier 后校验 build；若已有更高版本发布则拒绝恢复，重新分配 |
| 提交后可见性未知（E409/staged/轮询超时/响应丢失） | 发布意图 `unknown` | 阻断后续发布；按 §10.3 人工查询 registry 后恢复；不得删除 tag 重新分配 |
| release-meta 缺失/schema 非法/双远端不一致 | 政策记录不可用 | fail-closed：先按 §12 修复 release-meta，不得跳过或改用分支内副本 |
| 历史 legacy carrier 缺 `appVersion` 且未登记 | 无发布前沿证据 | 按 §12 下载核验并登记后才可参与前沿；不得静默跳过 |
| app 指针指向非 carrier / 异常历史 | 无法自动比较 | 不自动移动；记录稳定 reason，人工确认后再发布或修指针 |
| 跨 core 更新失败（先 core 后 build 的判定） | 本期明确不承诺 | 卸载重装/人工安装，不在应用内降级或回退通道 |

### 10.2 回滚

- **未发布前**：直接放弃本次产物，回到构建前状态；已 bump 的版本号若未发布可复用，但需重新走完整门禁。
- **已发布后**：公共版本不可撤销，所谓回滚是**运行时回退**：
  1. 插件回滚：按既有自更新/监督器回滚机制恢复旧版本；恢复后按**已恢复实例的内容标识与健康结果**重新选择旧配对发布（不按版本号猜）。
  2. 载体/APK：旧载体仍可从 npm 下载（版本不可变）；本机 dist 与 Release 记录需保留至少一个发布周期。
  3. App：不自动降级已装 App；如需降级须人工卸载重装并重扫连接码。
  4. 记录：在发布记录中写明回滚时间、原因、恢复版本与验证结果。

### 10.3 未确认发布（unknown/staged）、过期 tag 与人工恢复

- 每次发布在提交 npm publish **之前**，先把发布意图（tag、插件/carrier 版本、build、期望 integrity、状态 `submitted`）写入 `release-meta`。确认可见后标记 `published` 并清除未关闭状态。
- 以下情况必须进入 `unknown` 并**阻断后续发布/通道移动**：E409/staged、可见性轮询超时、publish 响应丢失或其它无法确认最终状态的情况。不得把超时当作“确定未发布”，不得删除 tag 重新分配，也不得自动重发。
- 人工恢复：
  1. 只读查询 registry 的最终状态（版本是否可见、`dist.integrity` 是否符合意图）；
  2. 已确认可见 → 用 registry 实际 integrity 标记 published：
     ```bash
     REMOTE_INTEGRITY="$(npm view "@marktrue/dsh-mobile-remote@${CARRIER_VERSION}" dist.integrity --json \
       --registry=https://registry.npmjs.org --@marktrue:registry=https://registry.npmjs.org | jq -r '.')"
     node tools/release-gate.mjs mark-intent --policy <release-meta-wt>/build-policy.json \
       --tag "$TAG" --status published --integrity "$REMOTE_INTEGRITY"
     ```
     确认未接受 → `--status failed`（该 tag 才可按 §10.2 授权后重新分配）；
  3. 经授权提交并推送 `release-meta`，再继续后续发布。
- 部分恢复：carrier 已发布、插件未发布的会话允许用同一 tag 重跑；CI 使用“排除自身 carrier 后的发布前沿”校验 build。若期间已有更高版本发布，恢复必须被拒绝（不能借恢复把通道回退），只能重新分配。
- **残留 submitted 意图**：若插件与 carrier 都已可见但发布意图仍是 `submitted`（例如上次 job 在 publish 后、mark-published 前退出），fully-published 重跑会**只读成功**并在输出中报告 `leftover-intent`。按本节人工恢复：用 registry 实际 integrity 执行 `mark-intent --status published` 并推送 release-meta；不要重新发布、不要删 tag。
- tag 已创建但 CI 失败且**从未提交 publish 请求**（无发布意图/unknown）时，才可在授权后删除 tag 重新分配；已部分发布或状态未知时必须走恢复流程。
- 迟到可见的版本不得覆盖已分配/已发布的更高 build；release-meta 的恢复记录保留。

> 应急手工兜底：从受信发布源/维护者取得**同一次发布**的 APK + 完整清单，放入人工区（宿主不自动改写人工区），经导入校验后服务；不要用其他版本的 APK 顶替。

---

## 11. 记录与清理

### 11.1 每次发布必须记录

- 版本号、App 构建号、发布 UTC 时间、操作者与授权依据。
- 发布 HEAD（`git rev-parse HEAD`）、分支、工作区是否干净。
- 产物身份：清单 `app.sha256`/`plugin.sha256`/`plugin.contentSha256`、载体 tarball sha256+size、插件 tgz sha256+size。
- 演练结果：`run.json` 路径、`RESULT`、耗时、失败 reason（如有）。
- 试发布（如有）：包名、版本、dist-tag、unpublish 窗口、镜像核验结果。
- 正式发布：两次 `npm publish` 的结果与 registry 核验输出、Release URL、部分成功状态。
- 发布政策：release-meta 的 commit、全局 build 分配依据（watermark/历史 tag/发布前沿/next）、发布意图状态（submitted/published/unknown/failed）、发布前/后 channel/app/latest 指针。
- 发布状态：`fresh` / `partial-carrier` / `fully-published`（旧 tag 重跑为只读幂等），以及 tag 可达性证据（alpha→develop、rc/stable→release/v<core>）。
- 回滚（如有）：原因、时间、恢复版本、验证结果。

建议把本次 `dist/` 的 `app-carrier.json`、`manifest.json`、`publish-carrier-check`/`npm-drill` 输出一并归档到发布记录目录（仓库外）。

### 11.2 清理

- **演练现场**：默认成功后自动销毁临时 registry 与安装目录（只保留 `run.json` 与日志）；`--keep` 保留现场，确认无用后手动删除状态目录下对应 `<UTC>-<演练版本>`。
- **本地产物**：`dsh-mobile-app/dist/` 为 gitignored 本地产物；发布完成后可保留最新一份用于回滚，其余旧版本按磁盘情况清理。
- **临时目录**：确认没有遗留 Verdaccio 进程（`ss -ltn | grep <端口>`）或工作目录；异常退出时按证据目录手工清理。
- **敏感物**：keystore（`android/app/release.jks`）、`android/key.properties`、npm token 绝不提交、不写入日志/清单/文档；发布记录里只记 token 来源，不记值。
- **不可清理**：已发布到 npm 的版本与 Release 资产不可删除（除按 npm 政策在 72h 内 unpublish 的特例，且需授权与记录）。

---

## 12. release-meta 初始化、迁移与全局 build

### 12.1 创建受保护 `release-meta` 分支（一次性迁移）

前置：本机已 fetch 双远端全部 tag（`git fetch --multiple --tags origin github`），npm 只读访问可用。

```bash
# 1) 生成迁移种子（不发布任何 npm 包；旧 carrier 会下载 tarball 核验 integrity）
#    --keep 保留下载/解包现场便于核对（默认删除临时目录）
node tools/release-meta-bootstrap.mjs --out /tmp/release-meta-build-policy.json --evidence /tmp/legacy-carrier-evidence.json [--keep]
#    检查 watermark=32、8 个 legacyTags、8 个 legacyCarriers（3 个缺 appVersion 的旧 carrier
#    必须带 integrity + 从内嵌 manifest/APK 读出的 appBuild）
# 2) 校验种子与观测数据一致（可对尚未推送的种子文件或 origin/release-meta 运行）：
#    policy watermark 允许高于观测值（迁移时人工上调过），只有低于观测值才报 regressed；
#    --watermark N 可把“观测水位”抬高后再比较。
node tools/release-meta-bootstrap.mjs --check --policy /tmp/release-meta-build-policy.json [--watermark N]
# 3) 创建本地 release-meta 分支（git plumbing，不切换工作树、不自动推送；已存在时默认拒绝）
node tools/release-meta-bootstrap.mjs --write-ref
#    --force 覆盖已存在的本地/远端 release-meta 前会读取现有 build-policy.json，
#    强制 watermark 不得降低、已登记 legacyTags/legacyCarriers 不得被丢弃。
# 4) 经授权推送双远端；然后在 GitLab/GitHub 设为受保护分支
git push origin release-meta && git push github release-meta
# 5) 首次分配：期望 next build = 33（若 npm/设备存在更高 build 则更高）
node tools/next-build.mjs
```

- `watermark = 32` 取自迁移时 develop 的 build；迁移前必须人工核对是否还有“已安装/未打 tag”的更高 build，如有则上调（工具支持 `--watermark N`）。
- 3 个旧格式 carrier（`3.2.1-alpha.1/2/3-app` 缺顶层 `appVersion`）：工具下载 tarball、按 `dist.integrity` 校验 sha512、解包读取内嵌 `manifest.json` 的 `app.version`（必要时 aapt 实读 APK versionCode），登记精确 `{version, integrity, appBuild}` 并保留 `--evidence` 证据。
- 其余 5 个 carrier 直接登记 `appVersion` build 与 integrity。**不修改任何已发布包**，不重写/移动/删除历史 tag。
- `release-meta` 保护规则：只允许发布执行者/发布 workflow token 写入；水位与白名单只能通过受保护提交抬高/追加，**水位只升不降**。分支内 `build-policy.json` 副本只是提案镜像，分配端与 CI 只读 release-meta。

### 12.2 日常 alpha 发布（develop）

```bash
# 1) 准备：develop 干净、CI 绿；双远端 fetch（--multiple 不是两个位置参数）
git switch develop && git pull --ff-only origin develop
git fetch --multiple --tags origin github

# 2) 只读分配全局下一个 build
node tools/next-build.mjs

# 3) 原子 bump（package version + 精确 carrier alias + pubspec + CHANGELOG 骨架）
node tools/prepare-release.mjs --version 3.2.4-alpha.N --build <next>
git diff --check

# 4) 本地门禁：node --test test/*.mjs + flutter analyze/test + 发布预检/演练
# 5) 提交 bump；经授权打 annotated tag 并推送 develop 与 tag 到双远端
git tag -a v3.2.4-alpha.N -m "Release v3.2.4-alpha.N"
git push origin develop && git push github develop
git push origin v3.2.4-alpha.N && git push github v3.2.4-alpha.N

# 6) tag 触发 publish-npm.yml：自动完成状态判定/build 校验/意图/发布/指针校验
# 7) 真机切 alpha 通道验证
```

### 12.3 release 线与 cherry-pick

- `release/vX.Y.Z` 从 develop 的**已实机验证**提交（优先 alpha tag commit）切出，bump 到 `X.Y.Z-rc.1`，用全局下一个 build。
- 冻结新功能：release 只接受本版本修复、版本号与 CHANGELOG。
- develop 上的修复先修 develop，再 cherry-pick 到 release；release 上的修复再 cherry-pick 回 develop。**禁止 merge develop 到 release**。
- stable 发布后 develop 可进入下一 core；跨 core 的设备更新限制见 §12.4。

### 12.4 同 core / 跨 core 限制

- 本期只保证**同 core** 的 alpha/rc 交错（如 `3.2.4-alpha.N` ↔ `3.2.4-rc.N`），App 更新器先比较 core、再比较 build，按发布时间安装不降级。
- **跨 core 不在本期承诺范围**：`3.2.5+40 -> 3.2.4+41` 会被判定 `remoteOlder`；反向可能安装降级失败。需要人工安装/卸载重装，或另立设计改造更新判定。
- RC 期间建议 develop 保持与 release 相同 core，避免设备跨 core 切换。

---

## 附录 A：Android APK 构建与排障

> 本附录由原「Android APK 构建与排障指南」全文并入发布手册（发布主流程见 §4）；内容未删减，标题层级与编号调整为 A.x 以适配附录。构建环境/代理/Gradle/签名等问题优先查本附录，再回 §4。

本文记录 `dsh-mobile-app` 的 Android Release APK 构建流程，以及首次构建、网络代理、Gradle、缓存和签名相关的常见问题。每个 shell 代码块均假定从仓库根目录独立执行，代码块内另有 `cd` 时除外。


### A.1 当前构建基线

| 组件 | 当前项目使用版本 |
|---|---|
| Flutter | 3.47.1 stable（项目要求 3.47+） |
| Dart | 3.13.1（`pubspec.yaml` 要求 `^3.13.0`） |
| JDK | 17 |
| Android Gradle Plugin | 9.1.0 |
| Gradle Wrapper | 9.3.1 |
| Kotlin | 2.4.0 |

以仓库中的 `pubspec.yaml`、`android/settings.gradle.kts` 和 Gradle Wrapper 配置为准。升级 Flutter、AGP、Gradle 或 Kotlin 时应一起验证，避免只升级其中一项。

### A.2 构建前检查

确认 Flutter、Java 和 Android SDK 可用：

```bash
flutter --version
java -version
flutter doctor -v
```

如果工具安装在自定义目录，可在当前终端临时设置：

```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="/path/to/flutter/bin:$JAVA_HOME/bin:$PATH"
```

`dsh-mobile-app/android/local.properties` 至少应包含本机 SDK 路径，例如：

```properties
sdk.dir=/path/to/android-sdk
flutter.sdk=/path/to/flutter
```

`local.properties` 是本机文件，已被 Git 忽略，不应提交。

### A.3 标准 Release 构建

推荐通过 Flutter CLI 构建：

```bash
cd dsh-mobile-app
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

成功标志：命令退出码为 0，并出现 `Built ...app-release.apk`。标准产物位于：

```text
dsh-mobile-app/build/app/outputs/flutter-apk/app-release.apk
```

若只需直接调用 Android 构建链，也可使用：

```bash
cd dsh-mobile-app/android
./gradlew :app:assembleRelease --no-daemon --console=plain --max-workers=2
```

直接调用 Gradle 时，产物通常位于：

```text
dsh-mobile-app/build/app/outputs/apk/release/app-release.apk
```

直接 Gradle 构建适合排查具体 Android 任务；日常发布仍建议使用 Flutter CLI。

### A.3.1 测试构建：APK 版本不变，manifest 使用 `+99`

需要反复验证主机源自动更新时，保持 `pubspec.yaml` 和 APK 内置版本不变，只覆盖 manifest 的版本号。例如当前 APK 为 `3.1.5+22`，测试 manifest 使用 `3.1.5+99`。

```bash
cd dsh-mobile-app
flutter analyze
flutter test
flutter build apk --release

# MANIFEST_VERSION 是显式测试覆盖，必须保持语义版本并提高 build 号
ALLOW_TEST_MANIFEST_VERSION=1 \
MANIFEST_VERSION="3.1.5+99" \
UPDATE_DIR="$HOME/.dsh/mobile-remote/update" \
bash tools/package-release.sh
```

Windows PowerShell：

```powershell
$env:ALLOW_TEST_MANIFEST_VERSION = '1'
$env:MANIFEST_VERSION = '3.1.5+99'
$env:UPDATE_DIR = "$HOME/.dsh/mobile-remote/update"
.\tools\package-release.ps1
Remove-Item Env:ALLOW_TEST_MANIFEST_VERSION, Env:MANIFEST_VERSION, Env:UPDATE_DIR
```

验收：检查 `updateDir/manifest.json` 的 `version` 为 `3.1.5+99`，并校验其中的 `sha256`、`size` 与 APK 一致；更新完成后可再次执行同一流程重复测试。只有显式设置 `ALLOW_TEST_MANIFEST_VERSION=1` 才允许覆盖；正式发布不得设置该变量，发布脚本还会要求测试 manifest 与 APK 语义版本一致且 build 更大。测试结束后清理测试 manifest 并恢复正式版本。

### A.4 首次构建需要出网（代理由 .env 驱动）

首次构建会从 Google Storage / pub 下载 Flutter Android 引擎与依赖，因此需要出网。**代理地址属于环境特定信息，不写在文档或脚本里**，改为项目根 `.env`（已被 `.gitignore` 忽略）中声明：

```sh
# 项目根 .env
DSH_PROXY_ENABLED=1
DSH_PROXY_HTTP=http://<proxy-host>:<port>
DSH_PROXY_SOCKS=socks5://<proxy-host>:<port>
```

`tools/worktree.sh init/verify` 会自动读取它并导出：

- `HTTP_PROXY` / `HTTPS_PROXY`（来自 `DSH_PROXY_HTTP`）
- `ALL_PROXY`，以及给 Gradle/JVM 用的 `-DsocksProxyHost/-DsocksProxyPort`（来自 `DSH_PROXY_SOCKS`；JVM **不认** `ALL_PROXY`）

未创建 `.env` 或 `DSH_PROXY_ENABLED` 不为 `1` 时**完全不设代理**——离线/直连环境保持默认即可。模板见仓库根的 `.env.example`。

#### A.4.1 手动构建（不经 worktree.sh）

如果直接调用 Flutter/Gradle 而非 `tools/worktree.sh`，需自己导出等价变量：

```bash
# HTTP 代理（Flutter/pub 走这个）
export HTTP_PROXY=http://<proxy-host>:<port>
export HTTPS_PROXY="$HTTP_PROXY"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"

# Gradle/JVM 不认 ALL_PROXY/HTTP_PROXY，必须显式给 socks 参数
export GRADLE_OPTS="-DsocksProxyHost=<proxy-host> -DsocksProxyPort=<port>"

cd dsh-mobile-app
flutter build apk --release
```

> 早期文档曾写死 `127.0.0.1:1080` 的 HTTP 代理；该地址随构建环境迁移已不存在，
> 填入实际代理地址即可，不要再照抄旧值。

#### A.4.2 验证出网

先确认代理能访问 Flutter Storage（把地址换成实际代理）：

```bash
curl -x http://<proxy-host>:<port> \
  -I --max-time 15 \
  https://storage.googleapis.com/download.flutter.io/
```

返回任意有效 HTTP 响应（如 `HTTP/2 200`）说明链路可用。若 Flutter 已下载过引擎、依赖命中本地缓存，则离线（`--offline`）也能完成构建，此时不设代理是正常的。

### A.5 干净重建

普通代码修改不需要每次清理。遇到缓存异常或需要确认可重复构建时执行：

```bash
cd dsh-mobile-app
flutter clean
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

也可以只清理 Android 产物：

```bash
cd dsh-mobile-app/android
./gradlew clean --no-daemon --console=plain
```

不要把删除整个 `~/.gradle/caches` 作为首选方案；这会使所有 Gradle 和 Flutter 引擎依赖重新下载。

### A.6 Release 签名

正式分发必须使用固定的 release keystore。若 `android/key.properties` 不存在，项目会回退到 Debug 证书，仅适合本机测试。

生成 keystore：

```bash
cd dsh-mobile-app
keytool -genkeypair -v \
  -keystore android/app/release.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10950 \
  -alias dsh
```

创建 `android/key.properties`：

```properties
storePassword=<密码>
keyPassword=<密码>
keyAlias=dsh
storeFile=app/release.jks
```

`release.jks` 与 `key.properties` 均已被 Git 忽略。不要提交，也必须安全备份；丢失或更换 keystore 后，已安装旧版本的用户无法直接覆盖升级。

检查 APK 签名：

```bash
APP_ROOT="$(git rev-parse --show-toplevel)/dsh-mobile-app"
APK="$APP_ROOT/build/app/outputs/flutter-apk/app-release.apk"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -type f -name apksigner -print | sort -V | tail -1)"
"$APKSIGNER" \
  verify --verbose --print-certs "$APK"
```

至少应看到 `Verifies`、签名方案结果和正确的证书摘要。`CN=Android Debug` 表示当前使用的是 Debug 回退签名，不应作为正式发布包。如果 `APKSIGNER` 为空，请先通过 Android SDK Manager 安装 Android SDK Build-Tools。

### A.7 产物校验

构建完成后建议记录文件大小、SHA-256 和签名信息：

```bash
APK="$(git rev-parse --show-toplevel)/dsh-mobile-app/build/app/outputs/flutter-apk/app-release.apk"
stat "$APK"
sha256sum "$APK"
file "$APK"
```

发布前还应确认：

- `pubspec.yaml` 中的 `version: X.Y.Z+BUILD` 正确；
- 使用预期的 release 证书，而不是 Debug 证书；
- SHA-256 与发布清单一致；
- 用相同签名覆盖安装旧版本成功；
- 自动更新的检查、下载、签名预检和安装流程已真机验证。

### A.8 常见问题与处理办法

#### A.8.1 构建长时间停在 `:app:mergeReleaseNativeLibs`

**现象**：普通日志只显示以下一行，数分钟没有新输出：

```text
> Task :app:mergeReleaseNativeLibs
```

**常见原因**：Gradle 正在后台下载 Flutter 的 ARMv7、ARM64 和 x86_64 引擎 JAR。普通日志不显示下载进度，看起来像死锁。本项目曾在这里等待，实际请求地址为 `storage.googleapis.com/download.flutter.io`。

**诊断**：

```bash
cd dsh-mobile-app/android
./gradlew :app:mergeReleaseNativeLibs \
  --no-daemon --console=plain --max-workers=2 --info
```

若 `--info` 输出出现 `Downloading https://storage.googleapis.com/...`，说明任务没有死锁，只是在下载。

**处理**：按附录 A.4同时配置环境变量和 JVM 代理参数，然后保持单个构建进程运行。首次下载可能需要 5～15 分钟；缓存完成后后续构建会明显加快。

#### A.8.2 `curl` 能走代理，但 Gradle 仍然很慢或超时

**原因**：代理环境变量只证明 `curl` 配置正确，Java/Gradle 可能未读取它们。

**处理**：除 `HTTP_PROXY` 和 `HTTPS_PROXY` 外，再设置 `GRADLE_OPTS`，或向 Gradle 传入以下参数：

```text
-Dhttp.proxyHost=127.0.0.1
-Dhttp.proxyPort=1080
-Dhttps.proxyHost=127.0.0.1
-Dhttps.proxyPort=1080
```

`proxyHost` 只写主机名或 IP，不要写 `http://`；协议只出现在 `HTTP_PROXY` 的 URL 中。

#### A.8.3 多个 Gradle 构建互相等待或提示锁被占用

**现象**：日志出现 cache lock、daemon busy，或多个构建都没有进度。

**处理**：不要同时运行多个 Flutter/Gradle 构建。先确认进程：

```bash
pgrep -af 'GradleDaemon|GradleWrapperMain|flutter'
```

停止当前项目的 Gradle daemon：

```bash
cd dsh-mobile-app/android
./gradlew --stop
```

确认旧构建已退出后，只启动一个新构建。不要盲目结束系统中属于其他项目的 Java 进程。

#### A.8.4 Kotlin 增量缓存损坏

**现象**：出现 `Could not close incremental caches`、缓存文件无法关闭或增量编译状态异常。

**处理**：项目已在 `android/gradle.properties` 设置 `kotlin.incremental=false`。若仍发生：

```bash
cd dsh-mobile-app
flutter clean
flutter pub get
flutter build apk --release
```

#### A.8.5 `flutter: command not found`、`java: not found` 或 JDK 版本错误

**处理**：把 Flutter 和 JDK 17 加入 `PATH`，并设置 `JAVA_HOME`。随后重新执行：

```bash
flutter --version
java -version
flutter doctor -v
```

当前 Android 构建链以 JDK 17 为基线，不要随意切换到过旧 JDK。

#### A.8.6 `SDK location not found` 或 `flutter.sdk not set`

**处理**：检查 `dsh-mobile-app/android/local.properties`，确认 `sdk.dir` 和 `flutter.sdk` 是本机存在的绝对路径。该文件不可直接复制其他机器的路径。

#### A.8.7 AGP 9 / Kotlin 弃用警告

**现象**：日志提示 `android.builtInKotlin=false`、`android.newDsl=false` 或 `org.jetbrains.kotlin.android` 将弃用。

**说明**：在当前 Flutter 3.47.1 模板和依赖组合中，这些是迁移警告，不是本次构建失败原因。只要最终出现 `BUILD SUCCESSFUL`，可以正常产出 APK。

**处理**：不要为了消除警告单独删除配置或升级单个插件。后续迁移 Built-in Kotlin 时，应一起验证 Flutter、AGP、Kotlin 和 `mobile_scanner` 等插件，并完成完整构建与真机回归。

#### A.8.8 插件 Manifest 或 Android API 弃用警告

依赖插件可能提示 Manifest 的 `package` 属性被忽略，应用 Kotlin 代码也可能提示旧 Android API 弃用。这些警告不会阻止当前构建，但升级依赖时应复查。判断构建是否成功应以退出码、`BUILD SUCCESSFUL` 和 APK 校验为准。

#### A.8.9 构建成功但手机提示签名不一致

**原因**：新 APK 与手机已安装版本使用了不同 keystore，常见于正式签名与 Debug 回退签名混用。

**处理**：

- 正式升级：使用与旧版本完全相同的 keystore、alias 和密码重新构建；
- 无法找回旧 keystore：只能卸载旧 App 后重新安装，并重新扫码配置；
- 构建后用 `apksigner verify --print-certs` 对比证书 SHA-256。

#### A.8.10 `apksigner` 提示 `java: not found`

`apksigner` 自身也需要 Java。临时补充 JDK 17 到 `PATH`：

```bash
export JAVA_HOME=/path/to/jdk17
export PATH="$JAVA_HOME/bin:$PATH"
apksigner verify --verbose --print-certs app-release.apk
```

#### A.8.11 磁盘或内存不足

Flutter、Gradle、Android SDK、NDK 和中间产物会占用数 GB 空间。检查：

```bash
df -h .
free -h
```

优先清理当前项目产物：

```bash
cd dsh-mobile-app
flutter clean
```

不要随意删除整个 Android SDK、Flutter SDK 或 Gradle 用户缓存。

### A.9 本次成功构建记录

> 以下为**历史记录**，如实保留当时的环境细节（含当时使用的代理地址 `127.0.0.1:1080`）。
> 该代理已随构建环境迁移不再存在，**不要照抄本节的代理值**；当前做法见 A.4。

2026-08-24 在 Linux 环境完成一次 Release 构建：

- 分支：`feature/app-auto-update`；
- 构建命令：直接执行 `:app:assembleRelease`；
- Google 下载通过 `http://127.0.0.1:1080/`；
- 首次构建耗时：11 分 33 秒；
- Gradle 结果：`BUILD SUCCESSFUL`，366 个任务中 310 个执行、56 个命中缓存；
- APK 大小：72,966,782 bytes；
- SHA-256：`f5d0966cf219792bc23e0e71607d3b2f55456401abf9e4ad48ab55a747f1fe48`；
- 因没有 `android/key.properties`，该次产物使用 Debug 回退证书，仅用于测试；
- `apksigner` 验证结果为 v2 签名通过、v1 未启用。

该哈希只对应这一次本地产物。代码、依赖、版本号或签名变化后，APK 大小与哈希都会改变。
