# 仓库布局靠显式边界，不靠重组目录树

Status: accepted（2026-11-23，#164）

本仓库的顶层布局（`lib/` 插件源码、`dsh-mobile-app/` Flutter 工程、`test/`、`tools/`、`docs/`）**保持不变**，不引入 `apps/` + `packages/` 的 monorepo 结构。可读性问题通过三条显式边界解决，而不是搬动目录：`tools/` 按**性质**分目录、文档按**寿命**分组、二进制设计稿**不进仓库**。

盘点证据见 [docs/21-repo-layout-inventory.md](../21-repo-layout-inventory.md)。

## 为什么不重构布局

现有布局已被四类东西**硬引用**：CI workflow 的脚本路径、`tools/worktree.sh` 的 `REQUIRED_GATES`、门禁脚本之间的 `require` 链、38 篇 ADR 与代码注释里的相对链接。这些引用在 `apps/` 迁移里全部要改，而漏改一处就打断发布链——收益只是"看起来更像标准 monorepo"，与风险完全不成比例。

判断依据：本仓库是**单产品双端**（Node 插件 + Flutter App），不是多包共享库的仓库。monorepo 分层的收益（跨包复用、独立发版）在这里不存在；插件与 App 的版本是**配对发布**的（插件 `X.Y.Z-pre` ↔ App `X.Y.Z+N` ↔ 载体 `X.Y.Z-pre-app`），天然耦合，不该按包边界拆开。

## 决策一：`tools/` 按性质分目录

40 个脚本混了四类性质，按性质分为四个目录，**所有脚本保留原名**（只改路径）：

| 目录 | 性质 |
|---|---|
| `tools/gates/` | 门禁依赖的契约检查 |
| `tools/release/` | 发布机制（build 分配、bump、发布门禁、演练） |
| `tools/worktree/` | 工作树生命周期 |
| `tools/archive/` | 无引用的历史取证脚本 |

`tools/proxy-env.sh` 留在根部，因为它是稳定入口。

**不按新旧分**：脚本的"年龄"不是它的性质。名字像一次性脚本的 `hotfix07-unit-check.mjs` 实际被必需门禁 `tools/timeline-contract-check.mjs` **require** —— 按名字归档会直接打断 `verify`。这是本仓库最容易被误判的一处，任何按名字批量移动脚本的动作都必须先查引用图。

历史取证脚本（`verify-413-precheck`、`verify-64k-fix`、`verify-no-model-session`，实测零外部引用）**直接删除**，不归档保留：它们描述的问题（413 预检、64KB 误限、无显式 model 路径）已修复并有回归测试覆盖，脚本本身不是可复用的工具。

## 决策二：文档按寿命分组

`docs/` 顶层保留**长期维护**的手册（`03-api`、`04-security`、`09-compatibility`、`10-release` 等），这类文档被代码注释与 ADR 大量引用（实测 `03-api.md` 22 处、`04-security.md` 15 处），移动成本最高且收益最低。

带日期的**一次性窗口记录**归入 `docs/history/`。判断标准不是"名字里有日期"，而是**它描述的是否还会变化**：

- `docs/20-dsh-022-compatibility-2026-11-05.md` 名字带日期但**留在顶层** —— 它是 0.2.2 兼容范围的事实依据，`CHANGELOG.md` 引用它，后续兼容性决策也会回看它。它不是窗口记录。
- `13/16/17/18/19` 是特定窗口的验收与交接记录，不再更新，归入 `history/`。

## 决策三：二进制设计稿不进仓库

UI 设计稿与 mockup 渲染产物**不入库**。它们的权威位置是 GitLab issue 的 note（永久保存、按 issue 归类、能直接和讨论关联）。

理由：单张 PNG 约 200–300KB，36 张共约 10MB，一旦提交就**永久留在 Git 历史**，即使后续删除也无法回收。仓库里的副本还会与 issue 里的版本漂移，产生"哪份是批准稿"的歧义。

可重渲染的 mockup 工程同样不进仓库 —— 它依赖特定 Flutter 版本与本机字体，入库后无法保证可复现，反而制造"看起来能重建其实建不出来"的假象。

## Consequences

- **新增工具前先问性质**：会进 `verify` 的放 `gates/`，会进发布链的放 `release/`。放错位置比放错名字更难发现。
- **新增文档前先问寿命**：还会随版本变化的手册留顶层，一次性记录进 `history/`。日期后缀不足以判断。
- **设计稿只传 issue**：仓库里不保存评审用的图片，"批准稿"的唯一权威是 issue note。
- **移动任何脚本或文档必须同一次改动里查引用图**：`grep -r` 全仓（含 `.github/workflows/`、`tools/worktree.sh`、ADR、`CHANGELOG.md`），并在同一 PR 跑完整 `verify`。
- **本 ADR 不承诺执行顺序**：目录归位的具体批次与时机由 #164 按当时的发布窗口安排；此 ADR 只锁定"做什么、不做什么、为什么"。
