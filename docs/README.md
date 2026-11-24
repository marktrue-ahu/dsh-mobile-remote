# 文档索引

本页**只做导航**：告诉你"哪类问题该读哪个文件"。它不承载规则、不复述结论——内容以被指向的文件为准。

## 先确认你要读的是哪一类

| 文件 | 入库 | 解决什么问题 |
|---|---|---|
| [`AGENTS.md`](../AGENTS.md) | ✅ | **入口**。仓库级的 agent 指令，指向下面各处的权威位置 |
| `AGENT-RULES.md` | ❌ **不入库** | **本机权威协作规则**：分支模型、工作树生命周期、门禁与发布链路、本机环境 |
| [`CONTEXT.md`](../CONTEXT.md) | ✅ | **领域词汇**：仓库里各概念的准确定义与"避免怎么说" |
| [`docs/`](.) | ✅ | **文档正文**（本目录）：手册、决策、设计稿与历史记录 |

`AGENT-RULES.md` 只存在于本机、由 `.gitignore` 排除，**不在仓库里**，因此无法在这里链接。

> **本机协作规则见 `AGENT-RULES.md`（不入库），本页不复述。**
> 需要知道"能不能这么做""该从哪条分支开""门禁怎么跑"，直接读那份文件；本页任何内容都不构成对它的补充或例外。

## `docs/` 的四个分类

`docs/` 按**寿命**分组，而不是按主题编号。判断标准是"这份文档还会不会变、还会不会被回看"（依据 [ADR 0039](adr/0039-repo-layout-boundaries.md)）。

### 1. 长期手册（本层，`NN-名称.md`）

随版本维护、被代码注释与 ADR 大量引用，因此留在 `docs/` 顶层。

| 文件 | 内容 |
|---|---|
| [`00-开发总纲.md`](00-开发总纲.md) | 产品规划、阶段划分、决策记录 |
| [`01-PRD.md`](01-PRD.md) | 产品需求文档 |
| [`02-architecture.md`](02-architecture.md) | 系统架构设计 |
| [`03-api.md`](03-api.md) | API 接口设计 |
| [`04-security.md`](04-security.md) | 安全设计（宿主信任模型） |
| [`05-test-cases.md`](05-test-cases.md) | 测试用例设计 |
| [`06-install-run.md`](06-install-run.md) | 部署与启用 |
| [`07-user-manual.md`](07-user-manual.md) | 用户操作手册 |
| [`08-扩展开发指南.md`](08-扩展开发指南.md) | 扩展与二次开发（动作区、自定义推送、页面/App 定制） |
| [`09-compatibility.md`](09-compatibility.md) | 兼容性：内核耦合点、降级行为、已知问题、签名 |
| [`10-release.md`](10-release.md) | 发布操作手册：从构建到正式发布 |
| [`11-notification-reliability.md`](11-notification-reliability.md) | 后台提醒与桌面宠物 |
| [`12-implementation-status.md`](12-implementation-status.md) | 实施状态与后续待验收项 |
| [`20-dsh-022-compatibility-2026-11-05.md`](20-dsh-022-compatibility-2026-11-05.md) | DSH 0.2.2 兼容范围的事实依据 |

> `20-` 名字带日期但**不是**窗口记录：它记录当前兼容范围，后续兼容性决策会回看它，`CHANGELOG.md` 也引用它，所以留顶层。同一判断标准的例外说明见 ADR 0039。

### 2. [`adr/`](adr/) — 架构决策记录

`NNNN-短横线标题.md`，一篇一个**已敲定且不轻易回退**的决策：背景、选项、选择、后果。

- "为什么当初这么定" → 先看这里，不要从代码反推。
- ADR **只增不改**（Status 行可改），新决策另开新文件，不复写旧结论。
- 最新一篇 [`0039-repo-layout-boundaries.md`](adr/0039-repo-layout-boundaries.md) 解释本目录的分组规则。

### 3. [`agents/`](agents/) — agent 协作的配置性事实

| 文件 | 内容 |
|---|---|
| [`agents/issue-tracker.md`](agents/issue-tracker.md) | Issue 跟踪在自建 GitLab 的哪里、怎么用 |
| [`agents/triage-labels.md`](agents/triage-labels.md) | 标准五标签分类词汇 |
| [`agents/domain.md`](agents/domain.md) | 领域文档约定 |

### 4. [`design/`](design/) — 设计稿与跨端契约

尚未收敛成 ADR、但仍需在实现期反复对照的设计说明与接口契约（载体分发、自动更新、Git 浏览增强、桌面形态自适应等）。

看 `design/` 还是 `adr/`：**已定且要长期守住 → `adr/`；仍在细化、会随实现修订 → `design/`**。

### 5. [`history/`](history/) — 一次性窗口记录（只读存档）

特定时间窗口的验收、交接与 issue 复核记录。**不再更新**，只作为当时事实的存档保留。

| 文件 | 内容 |
|---|---|
| [`history/13-device-acceptance-2026-11-03.md`](history/13-device-acceptance-2026-11-03.md) | 2026-11-03 真机验收 |
| [`history/16-next-window-handoff-2026-11-04.md`](history/16-next-window-handoff-2026-11-04.md) | 2026-11-04 后续窗口交接 |
| [`history/17-remaining-work-review-2026-11-04.md`](history/17-remaining-work-review-2026-11-04.md) | 2026-11-04 剩余问题复核 |
| [`history/18-device-reliability-acceptance-2026-11-04.md`](history/18-device-reliability-acceptance-2026-11-04.md) | 2026-11-04 文件下载与桌面宠物真机验收 |
| [`history/19-issue-followup-2026-11-04.md`](history/19-issue-followup-2026-11-04.md) | 2026-11-04 issue 后续处理 |

**`history/` 里的内容不是现状**：其中的"待办""下一步"是当时视角，判断当前状态请看 [`12-implementation-status.md`](12-implementation-status.md) 与 GitLab issue。

### 6. [`screenshots/`](screenshots/) — 界面截图

用于 README 与用户手册的稳定界面图。评审用的一次性设计稿不放在这里。

## 常见问题 → 去哪读

| 你想知道 | 读这个 |
|---|---|
| 这个仓库怎么协作、分支怎么开、门禁怎么跑 | `AGENT-RULES.md`（本机，不入库） |
| 某个词/概念到底指什么 | [`CONTEXT.md`](../CONTEXT.md) |
| 为什么当初做了某个技术选择 | [`adr/`](adr/) |
| 接口长什么样 | [`03-api.md`](03-api.md) |
| 怎么发布、版本号规则 | [`10-release.md`](10-release.md) |
| 安全边界、文件权限模型 | [`04-security.md`](04-security.md) |
| 某个历史窗口发生了什么 | [`history/`](history/) |
| 现在做到哪了、还差什么 | [`12-implementation-status.md`](12-implementation-status.md) + GitLab issue |
| 怎么二次开发 / 自定义动作 | [`08-扩展开发指南.md`](08-扩展开发指南.md) |
| 项目总览、安装、常见问题 | [`../README.md`](../README.md)、[`../FAQ.md`](../FAQ.md) |

## 新增文档时放哪

1. 问一句：**这份文档还会变吗？还会被回看吗？**
2. 会长期维护、会被引用 → 留 `docs/` 顶层，接下一个编号。
3. 是某个决策的定论 → `docs/adr/`，新建编号文件。
4. 是特定窗口的一次性验收/交接 → `docs/history/`。
5. 答不上来 → **默认留顶层**，并在 PR 里说明理由（误留只是放错位置，误移会打断引用链）。

移动或改名任何文档时，**同一次改动内**全仓检索引用（含 `README.md`、`CHANGELOG.md`、`.github/`、`tools/`、ADR 与代码注释），并同步更新本索引。
