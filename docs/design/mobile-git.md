# 移动端 Git 只读导航设计

Status: implemented

本文记录移动端 Git 只读导航的实现边界、API 契约和验收要求。稳定领域语言见 [`CONTEXT.md`](../../CONTEXT.md)，范围决策见 [ADR 0009](../adr/0009-mobile-git-read-only-navigation.md)。

## 1. 产品边界

移动端浏览器回答四个问题：

1. 当前会话所在仓库有哪些本地和远程分支？
2. 一至五个所选引用之间的提交拓扑是什么？
3. 某个提交的元数据、引用、统计和文件列表是什么？
4. 当前工作区有哪些已暂存、未暂存和未跟踪的文件，其单文件文本差异是什么？

Git 页面为全屏只读路由，用户可以在设置中选择并排序 1–3 个标签页（分支、图谱、工作区）；第一项作为默认页。App 不执行 stage、unstage、commit、reset、stash、分支切换/改名、fetch、pull、push、abort 等写操作。用户需要修改仓库时，仍由普通聊天中的 Agent sandbox、权限审批和工作区边界负责执行与风险控制。

## 2. 架构边界

```text
Flutter full-screen Git browser
    │  session-authorized, read-only mobile DTO
    ▼
dsh-mobile-remote Git adapter
    │  Git Service Definition / bounded on-demand preview
    ▼
external provider (preferred) / bundled read-only provider (fallback)
    │  DSH subprocess + workspace registry
    ▼
authorized Git repository on the computer
```

- App 不运行 Git、不保存独立 Git 事实。
- mobile-remote 路由只负责鉴权、移动 DTO、错误映射和能力降级。
- provider 负责仓库识别、引用验证、拓扑查询、提交详情、工作区状态和变更事实。
- 包内 fallback 实现同一 provider 契约，不在 HTTP 路由中形成第二套 Git 逻辑。
- provider 不兼容或不可用只影响 Git 浏览器，入口保持可见并显示原因。

## 3. 仓库定位与安全

- Git 入口只查看当前聊天会话 cwd 向上解析出的仓库，不提供跨仓库选择器。
- provider 必须先解析规范 Git 根目录，再验证其属于已注册 DSH 工作区。
- App 后续只使用 provider 分配的 `repositoryId`，不能提交任意路径获得读取权限。
- 软链接越界、工作区外仓库、失效 repositoryId 和任意 OID 均拒绝。
- 子进程使用 argv 数组、非交互环境、时间与输出上限。
- 移动 DTO 不返回仓库绝对路径、remote URL 或作者邮箱。
- 每个工作区预览都必须绑定会话授权、未过期快照和快照内精确文件成员；读取前后重新验证快照。路径不得用于访问快照之外的文件。
- 特殊文件、冲突、二进制、符号链接、子模块和纯模式变化返回明确状态，不伪造文本 diff。
- 单文件预览最大 512 KiB；未跟踪文件只读取有界前缀并如实标记截断。

## 4. 移动交互

### 4.1 入口与标签页

- Git 图标固定在聊天页右上角、“任务、子代理、目标”左侧，小屏也不移入更多菜单。图标使用旋转 45° 的菱形底板与直立分支标记：浅色主题黑底白线，深色主题白底黑线。
- 点击后打开全屏只读 Git 浏览器，而不是可拖动底部抽屉。
- 设置允许选择并排序 1–3 个标签页：分支列表、分支图、工作区；首项是默认页。
- 标签页保留各自滚动状态。若隐藏图谱时从分支打开提交详情，使用临时图谱视图，返回后恢复原标签。
- 仓库不存在、空仓库、provider 缺失或版本不兼容均显示明确空态、原因和重试入口。

### 4.2 分支列表

- 本地与远程引用分组展示；本地组当前分支置顶，其余保持 provider 顺序，远程组保持 provider 顺序。
- 每项显示名称、当前标记、tracking 和 ahead/behind；不展示写操作菜单。
- 名称搜索只在已返回的授权引用中做本地过滤。
- 点击分支进入分支图，并用该引用替换当前选择集；用户再通过图谱筛选器添加对比分支。

### 4.3 分支图

- 选择集至少一个、最多五个本地或远程引用（合计）；默认引用计入上限。选满后阻止继续添加并提示；筛选器可搜索并按本地/远程分组。
- 选择只存在于当前浏览器生命周期；打开图谱时按 controller 确定的默认引用恢复。
- detached HEAD 或没有当前本地分支时按“指向 HEAD 的本地引用 → 首个本地引用 → 首个远程引用”回退；默认回退引用也占一个选择名额；无引用时显示空状态。
- 最新提交在上，纵向到底自动加载下一页；横向 lane 滚动不能触发纵向分页。
- 提交内容列固定，所有行共享同一横向 viewport；活跃 lane 超出可视宽度时只滚动图形区域。
- lane 只表达 `parents` 拓扑，不表达分支所有权。分叉、普通/复杂/octopus merge、criss-cross、共同祖先、无共同历史和跨页父线不得产生虚假连接。
- 每条 lane 从其拓扑起点节点开始；没有更近子提交连入的起点节点上方不画无来源入线。真实子提交到父提交的连接保留；屏幕视口和分页边界不作为拓扑起点。
- tag 和选中引用显示在对应 tip；最多五个选中引用均参与颜色标记，多个引用同指提交时使用固定尺寸的多引用标识。颜色按 ref 稳定并适配主题，标签紧凑优先显示当前引用；HEAD 与 merge 节点有明确标记。

### 4.4 提交详情

点击节点打开提交详情：

- 作者名、提交时间、完整 OID 和完整消息；
- 父提交；
- 指向该提交的选中引用和 tag；
- 变更统计；
- 带总数和排他游标的分页文件列表。

不显示作者邮箱，不返回或渲染完整 patch，文件项不提供编辑或写操作。单文件预览按需请求；根提交与普通提交分别对比空树和第一父提交。

### 4.5 工作区与差异预览

- 工作区页按已暂存、未暂存、未跟踪分组；同一文件允许同时出现在已暂存和未暂存组。遵循 Git ignore 规则。
- 首次进入工作区时读取快照；仅在 Git 全屏页打开期间由客户端约每 30 秒检查一次是否变化。服务器不全局轮询工作区。
- 新快照不同于已展示快照时只标记陈旧；保持当前列表及预览，等待用户显式刷新，不自动替换内容。
- 用户打开文件行时才获取该文件差异。长段未变更行默认折叠，保留变更附近三行上下文并允许展开。
- 未跟踪文本按新增行显示，保留空行和看起来像 diff 元数据的普通源代码行。

## 5. Tip 绑定图快照与分页

首次请求提交有序的引用名称和 tip OID：

- provider 验证每个名称仍在该授权仓库解析到对应 tip；
- 查询返回所有选中 tip 可达提交的去重并集和稳定 topo-order；
- 响应建立绑定仓库、选择集、排序和 TTL 的不可伪造 `snapshotId`；
- 后续分页必须同时携带 `snapshotId` 和排他 cursor；
- 引用移动/删除、TTL 到期、仓库变化、错误 snapshot/cursor 返回 `graph-stale`，不得切换到新 tip 或全量图；
- App 保留旧图并提示刷新。刷新后若原引用失效，要求用户重新选择，不静默回退。

当前页提交的父提交尚未加载时，仍从子提交向下绘制未完成边界线，后续页到达后接续；这不是 lane 起点上方的入线。lane 的拓扑起点没有更近子提交连入时，其上方不画无来源线段；真实父子连接必须保留，屏幕视口和分页边界不截断连接。跨页补全不能无依据重新分配已有行的 lane。实现需避免为每个历史行长期持有独立滚动控制器或用 O(n) listener 扫描所有行。

## 6. 工作区快照与变化通知

外部 provider 或包内 fallback 把仓库/引用变化投影为 `git/changed`。抽屉收到 ref 变化时保留当前分支列表、图、滚动位置和 snapshot，提示用户刷新；不自动重排列表或替换图。

工作区快照由已打开的客户端页面按需读取和检查。若其 snapshot 改变：

- 保留当前工作区列表和文件预览；
- 显示陈旧提示与显式刷新入口；
- 不自动替换已显示内容；
- 显式刷新后才读取新快照并加载新预览。

## 7. HTTP 契约

- `GET /api/git/worktree?sessionId=…&repositoryId=…` 返回 `{repositoryId,snapshotId,staged,unstaged,untracked,truncated}`。
- `GET /api/git/preview?sessionId=…&repositoryId=…&kind=staged|unstaged|untracked&snapshotId=…&path=…` 返回工作区快照成员的有界预览。
- `GET /api/git/preview?sessionId=…&repositoryId=…&kind=commit&oid=…&path=…` 返回提交文件的预览。

端点只读、通过会话与工作区授权，并且不在响应中包含主机路径或凭据。

## 8. 移除旧写能力

只读替代实现合入 develop 后，以独立清理任务删除：

- B0 operation manager、账本、challenge 和恢复协议；
- B1 stage/unstage/commit；
- B2 分支创建、切换和重命名；
- B3 fetch/pull/push/sync/abort；
- Flutter 写 UI、operation store、写 DTO、写 API 和对应测试；
- 所有移动 Git 写路由。

升级时先停止旧执行器，再删除全部旧 Git operation/challenge 持久数据，不保留禁用桩或历史查询接口。

## 9. 验收重点

- provider 缺失、工作区外路径、非 Git 目录、空/unborn/detached/shallow/worktree 均有稳定结果；
- 本地/远程分组、搜索、tracking、ahead/behind 和当前标记正确；
- 图快照分页无重复遗漏，snapshot/cursor/repository/ref 变化均返回 `graph-stale`；
- 复杂拓扑、共同祖先、跨页父线和五个选择的 lane/绘制无虚假连接；
- Widget/手势测试验证共享横向 offset、reset/dispose 和横向滚动不触发纵向 load-more；
- 工作区快照归属与重验证、工作区变化后保留旧视图、预览有界、特殊文件明确告知；
- 提交文件列表分页、超大提交、重命名和二进制条目保持有界；
- `git/changed` 只提示刷新，不自动替换当前视图；
- App 和移动 API 中不存在可执行 Git 写操作的入口。
