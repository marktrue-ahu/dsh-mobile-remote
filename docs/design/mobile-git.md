# 移动端 Git 只读导航设计

Status: design draft

本文记录移动端 Git 只读导航的实现边界和验收要求。稳定领域语言见 [`CONTEXT.md`](../../CONTEXT.md)，范围决策见 [ADR 0009](../adr/0009-mobile-git-read-only-navigation.md)。

## 1. 产品边界

移动端只回答三个问题：

1. 当前会话所在仓库有哪些本地和远程分支？
2. 一至三个所选引用之间的提交拓扑是什么？
3. 某个提交的元数据、引用、统计和文件列表是什么？

App 不展示工作区状态或 diff，不执行 stage、commit、分支切换/改名、fetch、pull、push、abort 等写操作。用户需要修改仓库时直接在普通聊天中向 AI 提出要求，由现有 Agent sandbox、权限审批和工作区边界负责执行与风险控制。

## 2. 架构边界

```text
Flutter Git navigation drawer
    │  stable read-only mobile DTO
    ▼
dsh-mobile-remote Git adapter
    │  Git Service Definition
    ▼
external provider (preferred) / bundled read-only provider (fallback)
    │  DSH subprocess + workspace registry
    ▼
authorized Git repository on the computer
```

- App 不运行 Git、不保存独立 Git 事实。
- mobile-remote 路由只负责鉴权、移动 DTO、错误映射和能力降级。
- provider 负责仓库识别、引用验证、拓扑查询、提交详情和变化事实。
- 包内 fallback 实现同一 provider 契约，不在 HTTP 路由中形成第二套 Git 逻辑。
- provider 不兼容或不可用只影响 Git 导航，入口保持可见并显示原因。

## 3. 仓库定位与安全

- Git 入口只查看当前聊天会话 cwd 向上解析出的仓库，不提供跨仓库选择器。
- provider 必须先解析规范 Git 根目录，再验证其属于已注册 DSH 工作区。
- App 后续只使用 provider 分配的 `repositoryId`，不能提交任意路径获得读取权限。
- 软链接越界、工作区外仓库、失效 repositoryId 和任意 OID 均拒绝。
- 子进程使用 argv 数组、非交互环境、时间与输出上限。
- 移动 DTO 不返回仓库绝对路径、remote URL 或作者邮箱。

## 4. 移动交互

### 4.1 入口与抽屉

- Git 图标固定在聊天页右上角、“任务、子代理、目标”左侧，小屏也不移入更多菜单。
- 点击后打开可拖动、默认接近全屏的底部抽屉。
- 抽屉默认显示分支列表，可切换到分支图。
- 仓库不存在、空仓库、provider 缺失或版本不兼容均显示明确空态、原因和重试入口。

### 4.2 分支列表

- 本地与远程引用分组展示；本地组当前分支置顶，其余保持 provider 顺序，远程组保持 provider 顺序。
- 每项显示名称、当前标记、tracking 和 ahead/behind；不展示工作区状态或写操作菜单。
- 名称搜索只在已返回的授权引用中做本地过滤。
- 点击分支进入分支图，并用该引用替换当前选择集；用户再通过图谱筛选器添加对比分支。

### 4.3 分支图

- 选择集至少一个、最多三个本地或远程引用；筛选器可搜索并按本地/远程分组。
- 选择只存在于当前抽屉生命周期，重新打开后默认当前本地分支。
- detached HEAD 或没有当前本地分支时按“指向 HEAD 的本地引用 → 首个本地引用 → 首个远程引用”回退；无引用时显示空状态。
- 最新提交在上，纵向到底自动加载下一页；横向 lane 滚动不能触发纵向分页。
- 提交内容列固定，所有行共享同一横向 viewport；活跃 lane 超出可视宽度时只滚动图形区域。
- lane 只表达 `parents` 拓扑，不表达分支所有权。分叉、普通/复杂/octopus merge、criss-cross、共同祖先、无共同历史和跨页父线不得产生虚假连接。
- tag 和选中引用显示在对应 tip；多个引用同指提交时使用固定尺寸的多引用标识。

### 4.4 提交详情

点击节点打开提交详情：

- 作者名、提交时间、完整 OID 和完整消息；
- 父提交；
- 指向该提交的选中引用和 tag；
- 变更统计；
- 带总数和排他游标的分页文件列表。

不显示作者邮箱，不返回或渲染完整 patch，文件项不提供编辑或写操作。

## 5. Tip 绑定图快照

首次请求提交有序的引用名称和 tip OID：

- provider 验证每个名称仍在该授权仓库解析到对应 tip；
- 查询返回所有选中 tip 可达提交的去重并集和稳定 topo-order；
- 响应建立绑定仓库、选择集、排序和 TTL 的不可伪造 `snapshotId`；
- 后续分页必须同时携带 `snapshotId` 和排他 cursor；
- 引用移动/删除、TTL 到期、仓库变化、错误 snapshot/cursor 返回 `graph-stale`，不得切换到新 tip 或全量图；
- App 保留旧图并提示刷新。刷新后若原引用失效，要求用户重新选择，不静默回退。

已加载父提交尚未出现时绘制未完成边界线；后续页面到达后接续。跨页补全不能无依据重新分配已有行的 lane。实现需避免为每个历史行长期持有独立滚动控制器或用 O(n) listener 扫描所有行。

## 6. 变化通知

外部 provider 或包内 fallback 把仓库/引用变化投影为 `git/changed`。抽屉收到变化时：

- 保留当前分支列表、图、滚动位置和 snapshot；
- 显示“数据已更新”提示与刷新入口；
- 不自动重排列表或替换图；
- 用户刷新后重新读取引用并建立新 snapshot。

## 7. 移除旧写能力

只读替代实现合入 develop 后，以独立清理任务删除：

- B0 operation manager、账本、challenge 和恢复协议；
- B1 stage/unstage/commit；
- B2 分支创建、切换和重命名；
- B3 fetch/pull/push/sync/abort；
- Flutter 写 UI、operation store、写 DTO、写 API 和对应测试；
- 所有移动 Git 写路由。

升级时先停止旧执行器，再删除全部旧 Git operation/challenge 持久数据，不保留禁用桩或历史查询接口。

## 8. 验收重点

- provider 缺失、工作区外路径、非 Git 目录、空/unborn/detached/shallow/worktree 均有稳定结果；
- 本地/远程分组、搜索、tracking、ahead/behind 和当前标记正确；
- 图快照分页无重复遗漏，snapshot/cursor/repository/ref 变化均返回 `graph-stale`；
- 复杂拓扑、共同祖先、跨页父线和三个选择的 lane/绘制无虚假连接；
- Widget/手势测试验证共享横向 offset、reset/dispose 和横向滚动不触发纵向 load-more；
- 提交文件列表分页、超大提交、重命名和二进制条目保持有界；
- `git/changed` 只提示刷新，不自动替换当前视图；
- App 和移动 API 中不存在可执行 Git 写操作的入口。
