# 21 — 工程目录整理：盘点与规划（issue #164）

> 状态：**仅盘点与规划，未执行任何搬迁**。方案与理由已固化到 [ADR 0039](adr/0039-repo-layout-boundaries.md)。
> 盘点日期：2026-11-23；初版基线 `09a3e7c`，ADR 对齐于 `fc96052`（develop）。
>
> **本文档自身的归属**：留 `docs/` 顶层，与 `20-` 同类 —— 它记录当前布局的事实与引用图，
> 后续每次归位都要回看它确认「哪些路径被谁引用」。查阅价值不等于窗口记录。

## 0. 为什么先做这份文档

`#164` 的明确要求是「先 inventory → 目标结构 → 用户批准 → 分批 move」，
**禁止一次性大迁移后“再修”**。本文档只做前三步。

## 1. 现状盘点

### 1.1 仓库跟踪文件（779 个）

| 顶层 | 文件数 | 性质 |
|---|---|---|
| `dsh-mobile-app/` | 514 | Flutter App（含 `android/` 170、`test/` 200、`assets/` 31、`lib/` 99、`tools/` 8） |
| `test/` | 105 | Node 插件侧测试（`.mjs`） |
| `docs/` | 74 | 文档（`adr/` 38、`screenshots/` 9、`design/` 7、`agents/` 3，其余为编号正文） |
| `tools/` | 40 | 插件侧工具与门禁脚本 |
| `lib/` | 28 | 插件源码 |
| `.github/` | 3 | CI workflow |
| 根散文件 | 9 | `package.json`、`package-lock.json`、`cordis.patch.yml`、`README.md`、`LICENSE`、`FAQ.md`、`CONTRIBUTING.md`、`CONTEXT.md`、`CHANGELOG.md`、`AGENTS.md`、`.gitignore`、`.env.example` |
| 其他 | 1 | `prototype/` |

### 1.2 未跟踪/被忽略（本地资产，**不入库**）

| 路径 | 内容 | 归属 |
|---|---|---|
| `AGENT-RULES.md` | 本机协作规则（明确不入库） | 本地规则 |
| `.env` / `.env.example` | 代理与工具链配置（`.env` 忽略） | 本地配置 |
| `node_modules/`、`dist/` | 依赖与产物 | 生成物 |
| `dsh-mobile-app/` 内 13 项 | `build/`、`.dart_tool/`、`android/.gradle/`、`android/gradlew`、`gradle-wrapper.jar` 等 | 生成物 |

### 1.3 仓库外本地资产（**不进仓库**）

| 位置 | 内容 |
|---|---|
| `/home/mark/projects/dsh-mobile-remote-worktrees/` | 每 issue 一棵工作树（30+ 棵，含已合并待清理） |
| `~/.local/state/dsh-mobile-remote-workflow/` | `tasks/<issue>.json` 登记、`reports/` 验证与交付证据、`locks/`、`audit.log`、`deleted-branches-*.md` |
| `~/.dsh/profiles/` | 运行中 profile（`web/`、`headless/`） |
| `/tmp/3.3.1-ui-design.md`、`/tmp/3.3.1-ui-mockups/` | 设计稿与 mockup 工程（跨会话复用，**易失**） |

## 2. 已识别的问题（按影响排序）

### P1 — `tools/` 职责混杂

40 个脚本里同时存在四类不同性质的东西：

| 类别 | 例子 | 是否被门禁/CI 依赖 |
|---|---|---|
| **门禁/发布机制**（长期） | `worktree.sh`、`worktree-selftest.sh`、`release-gate.mjs`、`prepare-release.mjs`、`next-build.mjs`、`release-meta-bootstrap.mjs`、`npm-drill.mjs`、`lib/npm-drill/*`、`lib/release-*.mjs` | 是（CI + `worktree.sh verify`） |
| **契约检查**（长期） | `timeline-contract-check.mjs`、`account-usage-check.mjs`、`account-usage-adversarial-check.mjs`、`e2e-check.mjs` | 是（`verify` 的必需门禁） |
| **一次性取证脚本**（历史） | `verify-issue14-live.mjs`、`verify-issue14-p0.mjs`、`verify-413-precheck.mjs`、`verify-64k-fix.mjs`、`verify-no-model-session.mjs`、`verify-image-sniff.mjs`、`verify-seeded-session-upstream.mjs`、`hotfix05-check.mjs`、`phase1-check.mjs` | **多数否** |
| **环境/调试** | `proxy-env.sh`、`wsl-path-check.mjs`、`push-test.mjs` | `proxy-env.sh` 是必需入口 |

**关键风险（实测）**：`tools/hotfix07-unit-check.mjs` 看起来像一次性脚本，实际被 **`tools/timeline-contract-check.mjs`（必需门禁）require**。
凡按名字归档一次性脚本，**必须先查引用图**，否则会打断门禁。这是本 issue 最大的迁移风险。

### P2 — `docs/` 混合了四种文档

| 类型 | 位置 | 寿命 |
|---|---|---|
| 长期手册 | `01-PRD`、`02-architecture`、`03-api`、`04-security`、`06-install-run`、`09-compatibility`、`10-release` | 长期维护 |
| 决策记录 | `docs/adr/`（38 篇） | 长期只增 |
| Agent 约定 | `docs/agents/`（3 篇） | 长期 |
| **一次性窗口/验收记录** | `13-…2026-11-03`、`16-…2026-11-04`、`17-…`、`18-…`、`19-…` | **历史快照**，不再更新；归 `docs/history/`（ADR 0039） |
| **兼容性事实依据** | `20-dsh-022-compatibility-2026-11-05.md` | 名字带日期但**仍需回看**（CHANGELOG 引用、后续兼容决策依据）；**留顶层** |
| 设计稿 | `docs/design/`（7 篇） | 部分已被 ADR 取代 |

`docs/screenshots/` 只有 9 张早期截图（含应用商店图），与 `/tmp` 的 mockup 工程分属两套，边界模糊。

### P3 — 根目录 `CONTEXT.md` / `AGENTS.md` / `AGENT-RULES.md` 三者易混

- `AGENTS.md`（入库）：入口说明，指向 `AGENT-RULES.md`
- `AGENT-RULES.md`（**不入库**）：本机权威协作规则
- `CONTEXT.md`（入库）：领域词汇

新人和 agent 需要读三个文件才能确定"规则在哪"。这是**文档**问题，不必搬迁目录，建议加一张"读哪个"表。

### P4 — `/tmp` 设计资产易失

`/tmp/3.3.1-ui-design.md` 与 `/tmp/3.3.1-ui-mockups/`（含可重渲染的 Flutter mockup 工程）是跨会话依赖，但 `/tmp` 随时可能被清理。本轮 #153 就依赖它们。

> **已裁决（ADR 0039）**：设计稿与 mockup **均不入库**。权威位置是 GitLab issue 的 note（永久、按 issue 归类）。
> 理由：单张 PNG 约 200–300KB，36 张约 10MB，一旦提交就永久留在 Git 历史；且仓库副本会与 issue 版本漂移，
> 产生「哪份是批准稿」的歧义。mockup 工程依赖特定 Flutter 版本与本机字体，入库也不可复现。

## 3. 目标结构（建议，**未执行**）

**原则：不做 `apps/` + `packages/` 大重构。** 理由：现有布局已稳定运行（CI、release-meta、worktree 生命周期、38 篇 ADR 的引用全部指向现有路径），大改的收益远低于打断发布链的风险。只做**低风险归位**。

### 3.1 第一批（低风险，纯新增/移动文档）

1. `docs/` 内按寿命分组（**仅移动，不改内容**）：
   - `docs/history/` ← `13-`、`16-`、`17-`、`18-`、`19-` 这些**不再更新**的窗口记录
   - **`20-dsh-022-compatibility-2026-11-05.md` 留顶层**：名字带日期但它是 0.2.2 兼容范围的**事实依据**，
     `CHANGELOG.md` 引用它，后续兼容性决策（如 #166）也会回看它。判断标准是「是否还会变化」，不是「名字里有没有日期」。
   - 长期手册保持 `docs/` 顶层不动（`03-api.md` 实测 22 处引用、`04-security.md` 15 处，移动成本最高）
2. 新增 `docs/README.md`：一页**索引**说明「读哪个文档」，含 `AGENTS.md` / `AGENT-RULES.md` / `CONTEXT.md` / `docs/` 的分工表。
   **只做导航、不复述规则** —— 权威仍在 `AGENT-RULES.md`（不入库），本页要明确写这一点。
3. **设计稿不入库**（ADR 0039）：权威位置是 GitLab issue note。仓库内最多记录「某批设计稿在哪个 issue」的索引，不放二进制。

### 3.2 第二批（中风险，需同步引用）

4. `tools/` 内按性质分目录（**保留所有脚本原名**，只改路径并同步引用）：
   - `tools/gates/` ← 契约检查类（`timeline-contract-check`、`account-usage-check`、`account-usage-adversarial-check`、`e2e-check`、**`hotfix07-unit-check`**）
   - `tools/release/` ← `release-gate`、`prepare-release`、`next-build`、`release-meta-bootstrap`、`npm-drill`、`lib/npm-drill/*`、`lib/release-*`
   - `tools/worktree/` ← `worktree.sh`、`worktree-selftest.sh`
   - `tools/archive/` ← **目录保留但首版为空**；实测零外部引用的历史取证脚本
     `verify-413-precheck`、`verify-64k-fix`、`verify-no-model-session` 按 ADR 0039 **直接删除**
     （问题已修复且有回归测试覆盖，脚本本身不是可复用工具；需要时用 `git log --diff-filter=D -- <path>` 找回）
   - `tools/` 根保留：`proxy-env.sh`（必须稳定路径）

   **必须同步的引用点**：`.github/workflows/*.yml`、`tools/worktree.sh`（`REQUIRED_GATES` 里的脚本名）、`tools/timeline-contract-check.mjs`（require `hotfix07-unit-check`）、`AGENT-RULES.md`、`docs/10-release.md`、`README.md`。

### 3.3 第三批（低风险，仓库外）

5. 工作树清理：已合并的 11 棵按 `tools/worktree.sh cleanup <issue> <PR>` 核验后清理（**需用户单独授权**，见 AGENT-RULES）。
6. `/tmp` 设计资产：**不入库**（ADR 0039），权威在 GitLab issue note。仓库内不保存评审图片。

## 4. 明确不做

- 不引入 monorepo 布局（`apps/`、`packages/`）
- 不移动 `lib/`（插件源码入口，`package.json` main 指向）
- 不移动 `dsh-mobile-app/`（Flutter 工程根，含 android 构建链）
- 不移动 `docs/03-api.md` 等被代码与 ADR 大量引用的长期手册
- 不删除任何 release 证据、签名文件、历史备份
- 不改变发布物、分支模型、worktree 生命周期

## 5. 风险与缓解

| 风险 | 级别 | 缓解 |
|---|---|---|
| 归档"看起来像一次性"的脚本打断必需门禁（`hotfix07-unit-check` 实例） | **P0** | 每次移动前用引用图核对（commit 前 `grep -r` 全仓）；移动脚本的 PR 必须跑 `tools/worktree.sh verify` 全绿 |
| 移动文档打断 ADR/代码注释里的相对链接 | P1 | 第一批只移动 `docs/history/`，其余不动；移动时同 PR 修链接 |
| CI workflow 引用 `tools/` 路径 | P1 | 第二批与 workflow 修改放同一 PR，跑 CI 验证 |
| 移动期间与新功能 PR 冲突 | P1 | 每批独立 issue + 独立工作树；不与 feature 分支并行修改同一路径 |
| 工作树清理误删未合并内容 | **P0** | 只走 `tools/worktree.sh cleanup`（核验 PR 已并入 + SHA 匹配），逐棵核验，需用户授权 |

## 6. 验收（对 #164 原清单）

- [x] 目录与资产分类清单（§1）
- [x] 目标结构与迁移映射（§3）
- [x] 风险/引用影响清单（§5）
- [ ] 用户批准 ADR/计划
- [ ] 分批迁移后 CI/发布门禁/文档链接/本地工作流通过
- [ ] 清理规则与后续防乱约定

后三项需用户批准后再执行。
