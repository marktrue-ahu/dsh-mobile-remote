# Git 浏览增强：全量标签、结构化 refs、统一文件查看器与文件提交历史

> 状态：设计定稿，待实现（上游 PR：`upstream/git-browser-upgrade` → `201222-L/dsh-mobile-remote:main`，从已同步的 `main` 开）。
> 相关：[`mobile-git.md`](mobile-git.md)、[`../03-api.md`](../03-api.md)。

## Problem Statement

手机端 Git 浏览器目前有四个体验缺口：

1. 分支图每行只显示前 2 个 ref/tag，其余折叠成 `+N`，单个标签还会被 112px 截断，长仓库里很难看清一个提交到底被哪些分支/tag 指向。
2. 提交详情页虽然有 `Refs:` / `Tags:` 字段，但 bundled provider 的 `commit()` 根本不返回它们，进入详情后恒为空，与图行显示不一致。
3. “文件内容浏览”和“git diff 浏览”是两套独立组件、两套数据来源（`/api/directories`+`/api/files` vs `/api/git/preview`），视觉与交互不一致，后续加功能要改两处。
4. 无法查看单个文件的提交历史；从文件/差异视图也无法直接跳到该文件的历史。

## Solution

- 图行改为单行横向滚动，展示全部 ref/tag（规范化短名、按 HEAD → 本地分支 → 远程分支 → tag 排序），不再省略。
- 宿主 git 契约（`contractVersion 1.1.0`）加法扩展：graph/commit 返回结构化 `refsDetail` / `tagsDetail`；新增文件列表与文件历史端点；新增 `fileHistory` / `refsDetail` capability。
- App 统一展示层为 `GitFileViewer(mode: content|diff)`，两个入口只做数据适配；文件查看器顶部增加“提交历史”按钮。
- Git 管理新增 `fileHistory` tab（候选 4 个，仍可选 1–3 个），顶部选择文件、下方分页提交历史；从查看器深链时，若该 tab 未启用则打开独立历史页（无 TabBar）。
- 文件历史的“选择文件”主入口复用会话文件浏览页：点文件进入预览，预览页的“提交历史”返回原历史视图并选中该文件；原 inline 搜索/最近文件保留为“搜索文件”快捷入口。

## User Stories

1. 作为手机用户，我希望在分支图里一次看到某个提交上的全部分支/tag，而不是被折叠成 `+N`，以便判断这个提交的历史与发布状态。
2. 作为手机用户，我希望标签过长时横向滚动而不是被截断，以便看到完整 remote 分支名或 tag 名。
3. 作为手机用户，我希望标签按 HEAD / 本地分支 / 远程分支 / tag 分组排序，以便快速定位当前分支与发布 tag。
4. 作为手机用户，我希望进入提交详情后 Refs/Tags 与图行一致，以便确认该提交被哪些引用指向。
5. 作为手机用户，我希望 annotated tag 在详情里显示 tagger、日期与说明，以便判断发布来源。
6. 作为手机用户，我希望文件内容与 git diff 使用同一套查看器交互（行号、Markdown 切换、diff 折叠、横向滚动、复制），以便学习一次就能用。
7. 作为手机用户，我希望文件查看器顶部有“提交历史”按钮，直接查看当前文件的提交历史。
8. 作为手机用户，我希望从 commit diff 也能跳到该文件的历史，不需要手动重新找文件。
9. 作为手机用户，我希望 Git 管理新增“文件提交历史”tab，顶部选择文件、下方看历史，点提交进详情。
10. 作为手机用户，我希望仍然只显示我选择的 1–3 个 git tab，并能调整顺序；新的 history tab 作为可选项。
11. 作为手机用户，如果 history tab 没被我选进 1–3 个，从文件按钮进入时应看到完整历史页（而不是被隐藏），且返回后回到原文件位置。
12. 作为手机用户，我希望文件选择器能搜索仓库内的已跟踪文件，并显示最近使用过的文件，以便大仓库里快速定位。
13. 作为手机用户，我希望从文件历史点“选择文件”时进入文件浏览页，点文件看到内容预览后能通过“提交历史”按钮回到原历史视图，这样“历史 → 选择文件 → 预览 → 历史”是一条闭环且不会叠出多个 Git 页面。
14. 作为手机用户，我希望历史列表显示短 OID、subject、作者、相对时间和该文件的状态（M/A/D/R），以便扫读。
15. 作为手机用户，我希望长按历史条目可以复制 OID。
16. 作为手机用户，我希望未跟踪文件/空仓库/超时等场景有明确空态与错误提示，而不是空白页。
17. 作为维护者，我希望旧宿主（无新 capability）上的 App 自动降级：不显示历史入口，详情页用字符串兜底解析 refs/tags。
18. 作为维护者，我希望新 API 是加法扩展，外部 git provider 不实现新方法时仍能工作。
19. 作为维护者，我希望该功能作为上游 PR 交付，包含双端实现、测试与文档，不混入 fork 专属的更新/发版改动。

## Implementation Decisions

### 上游与交付

- 这是**上游贡献**，不是 fork 内部功能：要求本地 `main == github/main == origin/main`，用 `tools/worktree.sh create <issue> git-browser-upgrade --target upstream-main` 建树，分支为 `upstream/git-browser-upgrade`。
- PR 从 GitHub fork `marktrue-ahu/dsh-mobile-remote` 提到上游 `201222-L/dsh-mobile-remote:main`；单 PR 同时包含 host 插件与 Android App；桌面端不改。
- PR 只包含相对 `main` 的自包含补丁，不携带 develop 未上游化的功能，不 bump/release app 或 npm 版本。
- **PR diff 不得新增/修改** `AGENTS.md`、`AGENT-RULES.md`、`CONTEXT.md`、`docs/adr/`、`docs/agents/`、`docs/design/`；本设计稿只作为 develop 决策记录，不进入上游 PR。`docs/03-api.md` 的增量补充可以进 PR。
- PR 内 3 个提交：host API/契约 → App 统一查看器与结构化 refs 展示 → file-history tab/独立页/深链。
- 必带 Node + Flutter 测试、API 文档增量更新、CHANGELOG `Unreleased`。
- 上游合并后：先在 GitHub Sync fork，再 `tools/worktree.sh integrate` 只快进 main 镜像；回填 fork 的 develop/release 线另开任务，不在本 PR 内。

### Host 契约（`contractVersion 1.1.0`）

- `features` 新增 `fileHistory` 与 `refsDetail`，App 按 feature 位而非版本号判断；两者独立降级。
- graph commits 与 commit 详情保留旧 `refs: string[]`（deprecated），新增：
  - `refsDetail: [{kind: head|localBranch|remoteBranch|other, name, shortName, oid, current?}]`
  - `tagsDetail: [{name, shortName, oid, annotated, tagger?, date?, subject?}]`
- graph 行只保证名称级信息与 `annotated`；commit 详情返回完整 tag 元数据（subject 截断 200 字）。
- tag 指向非 commit 或嵌套 tag：显示 tag 名 + 目标非 commit 提示；注解读取失败静默降级为名字。
- 排序 HEAD → 本地分支 → 远程分支 → tag；`refs/stash` 不展示；按 (kind, shortName) 去重。
- 新增 `GET /api/git/files?sessionId&repositoryId&q=&limit=`：HEAD 已跟踪文件；`q` 为大小写不敏感路径子串；空 `q` 返回 ≤200 条、按路径排序；limit 上限 200。
- 新增 `GET /api/git/file-history?sessionId&repositoryId&path&cursor&limit=`：默认 20、最大 100；`cursor` 不透明；返回 `entries[{oid, shortOid, author, timestamp, subject, status}]`、`nextCursor`、`truncated`、`reason`。
- 历史恒 200；空/异常用 `reason: not-tracked | no-history | path-invalid`，不用 404 让客户端猜。
- 上限：最多 5000 条或 20 秒软超时；超限返回已取部分 + `truncated: true`。
- 路径归一化由 host 负责：接受工作区绝对路径或仓库相对路径，归一化到仓库根内；越界/仓库外返回 `path-invalid`。仅接受文件路径；目录返回 400。

### App 架构

- 新增 `GitFileViewer`（展示层组件）：`mode: content|diff`、标题/路径、已加载内容或 diff、`encoding/truncated/binary/notice`、加载/错误/空态、`topActions`（提交历史按钮）。内部保留行号、Markdown 预览/源码切换、diff 折叠展开、横向滚动、复制；内容 256 KiB / diff 512 KiB 上限沿用。
- `SessionFilesScreen` 与 `GitBrowserSheet._preview` 改为适配器，取数逻辑不变，只把渲染交给 `GitFileViewer`。
- 图行：取消 `maxVisible=2` / `+N` / 112px 单标签截断；标签与图共用同一横向滚动轴，单行、行高固定 86；颜色按种类固定（HEAD 高亮、本地分支、远程分支、tag=tertiaryContainer）。
- 详情页 `Refs`/`Tags` 用 `refsDetail`/`tagsDetail` 渲染；旧 host 走字符串解析兜底（`HEAD ->`、`refs/heads/`、`refs/remotes/`、`tag: refs/tags/`），无法识别保留原文；旧 host 的 Tags 从 refs 字符串派生。
- `gitTabIds` 增加 `fileHistory`；仍校验 1–3 个、唯一、已知 id；默认仍 `branches/graph/worktree`；设置弹窗候选 4 个、最多勾 3、可排序。
- history tab/独立页共用同一个 body/controller：顶部文件 chip + 主入口“选择文件/更换文件”+ 次入口“搜索文件”；主入口 push `SessionFilesScreen(selectionMode: true)`，在文件浏览里点文件进入预览，预览页的“提交历史”pop 回原历史视图并选中路径，不叠加新的 GitBrowserSheet；搜索入口仍使用服务端 `q`（防抖 250ms、最近文件按仓库持久化最多 5 个）。列表项短 OID + subject + author + 相对时间 + 状态徽标；点提交进现有详情；长按复制 OID；每页 20。
- 无文件时显示引导空态，并在该 surface 首次显示时自动弹一次 **inline 搜索选择器**（不自动全屏进入文件浏览页）；取消后本次不再自动弹；深链始终预填。
- 文件浏览选择模式：返回值为会话路径；宿主按既有规则归一化，仓库外/目录路径进入既有 `path-invalid` / `not-tracked` 空态，不新增宿主 repositoryRoot 字段。取消/系统返回返回 null，历史视图保持原选择。
- 该改动是 App 内导航/交互闭环，不改变宿主契约与领域模型；决策记录在本文档与 issue #42，不新增 ADR。

### 文件历史导航（2026-11-03 bugfix）

- 历史行点按**直接打开该文件在该提交上的 diff**（`openPreview(kind: commit, path: selectedPath, oid)`），不再先进入通用提交详情。
- 预览返回目标显式化：history-origin diff → 历史 surface；commit 详情打开文件 → 提交详情；worktree 文件 → 当前 tab。
- 独立历史视图（fileHistory tab 未启用）按返回**直接退出 Git 浏览器到调用页**，不再恢复进入前的 preview/commit；tab 已启用时在 tab 根退出。由此消除 `历史 → 预览 → 提交详情 → 历史` 的返回环。
- 深链到独立历史页同样按“返回退出到调用页”处理；历史 body 的提交行 tap 回调改为 `onOpenCommitDiff`。

- 深链：只看当前文件路径，不传/不定位 OID；范围=当前 HEAD。history tab 已启用→切 tab；未启用→push 独立历史页（无 TabBar）；返回恢复原查看器状态。
- 入口可见性：文件不在仓库或无 `fileHistory` capability → 按钮隐藏；未跟踪 → 按钮可见，进入空态。

### 空态与错误

| 场景 | 呈现 |
|---|---|
| 空仓库/无提交 | 空态“仓库还没有提交” |
| 未跟踪 | 空态“该文件暂无提交历史（未跟踪）” |
| 路径非法/目录 | 错误卡片 + 重新选择文件（优先进入文件浏览；搜索入口仍可用） |
| 超时/超限 | 已取部分 + “仅显示最近 N 条提交” |
| capability 缺失 | 入口隐藏 |
| 网络/服务错误 | 错误态 + 重试 |

## Testing Decisions

- 好测试只覆盖外部行为：宿主看 HTTP 响应契约与真实 git 仓库行为；App 看用户可见的 widget 行为与 API 适配，不断言内部实现细节。
- 优先复用现有 seam，新增 seam 控制在两个：
  1. **宿主 HTTP seam**：沿用 `test/git-read-api.test.js` 的 `apply()` + 路由驱动方式，但使用**真实 bundled provider + 临时 git 仓库**（prior art：`test/git-read-bundled-provider.test.js`），覆盖 capabilities、graph/commit 结构化 refs/tags、`/files`、`/file-history`、分页/错误/路径归一化；旧 provider 兜底用注入的 fake provider 补一例。
  2. **App widget seam**：沿用 `dsh-mobile-app/test/git_browser_widget_test.dart` 的 fake `GitReadApi` 驱动 `GitBrowserSheet` / 历史 body / 独立历史页 / `GitFileViewer`（diff 模式），覆盖全量标签、详情 refs/tags、tab 规则、深链、空态/错误态、分页、最近文件；新增文件浏览选择模式、返回选中路径、取消/返回不改变选择、搜索次入口、不叠加 GitBrowserSheet 的导航测试。
- 既有 `git_api_test.dart`、`git_models_test.dart`、`git_graph_*_test.dart`、`git_tabs_preferences_test.dart`、`session_files_*` 测试作为回归，不改断言语义（除被移除的 `+N` 截断用例需按新行为更新）。

## Out of Scope

- `git log --follow` 重命名跟随；历史分支范围切换；作者/日期筛选。
- 历史版本文件内容（blob）浏览；并排 diff。
- 桌面 DSH 端 UI；多仓库选择。
- 上游合并后的 fork 回填（另开任务）。

## Further Notes

- `docs/03-api.md` 目前是旧写时代设计，本 PR 只增量补充新端点与 capability 字段，不重写旧章节。
- 现有 `compactGitGraphLabels` 的 `+N` 行为与测试将被移除/替换；`git_graph_presentation` 改为全量排序与规范化。
- 风险集中在 annotated tag 元数据读取与 file-history 分页游标稳定性；实现时优先保证 fail-open（读不到 tag 元数据不影响名称展示）。
