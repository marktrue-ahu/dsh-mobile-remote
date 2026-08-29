# 移动端 Git 管理设计

Status: design draft

本文记录移动 Git 的实现边界、候选 provider 调研、风险和验收要求。稳定领域语言见 [`CONTEXT.md`](../../CONTEXT.md)，已接受决策见 [`docs/adr/`](../adr/)。

## 1. 设计原则

1. 电脑端 DSH 是 Git 事实和操作的唯一来源，App 不保存独立 Git 状态，也不运行 Git。
2. App 只消费 mobile-remote 的稳定移动契约，不感知具体插件或 provider 名称。
3. mobile-remote 只做鉴权、DTO/错误映射、确认挑战和事件投影，不解析 Git 终端文本作为长期协议。
4. Git provider 通过官方 DSH subprocess 能力执行命令，并以已注册工作区为安全边界。
5. 功能缺失或不兼容必须明确显示原因，不能出现无响应按钮或静默猜测。
6. 首先交付简单、常用且可安全恢复的功能，复杂历史改写和冲突编辑后置。

## 2. 架构边界

```text
Flutter App
    │  stable mobile DTO + intents
    ▼
dsh-mobile-remote Git adapter
    │  Git Service Definition
    ▼
Git provider
    │  DSH subprocess + workspace registry
    ▼
Git repository on the computer
```

Git Service Definition 至少需要覆盖：

- 仓库识别、状态、差异、分支、引用、提交图和能力查询；
- stage、unstage、commit、分支操作、fetch、pull、push、stash 和 tag 意图；
- 操作标识、阶段、结果、取消能力、冲突状态和可用后续动作；
- 稳定错误分类，例如仓库不存在、工作区越界、目标不明确、状态已变化、需要确认、发生冲突和 provider 不兼容；
- 状态变化与操作进度事件。

Service Definition 不包含 Flutter 类型、HTTP 状态码、具体插件类型或 Git 命令输出文本。mobile-remote 拥有自己的版本化 DTO，并负责映射 provider 的兼容差异。

## 3. 仓库定位与安全边界

- 会话 cwd 只作为默认定位线索；provider 必须向上解析 Git 根目录后，再验证其规范路径属于已注册 DSH 工作区。
- App 使用 provider 分配的 `repositoryId`，不得提交任意 cwd 作为操作权限。
- 对软链接、嵌套仓库、worktree、已删除 cwd、workspace 外仓库和 detached HEAD 返回明确状态。
- 展示路径应优先使用工作区相对路径；是否展示完整主机路径由隐私设置决定。
- Git 子进程使用 argv 数组和受控环境，禁用交互式终端提示，并限制输出大小和运行时间。

## 4. 操作任务模型

写操作启动接口只负责验证意图并创建任务：

```text
intent + requestId + repositoryId
                │
                ▼
        accepted(operationId)
                │
      queued → running → terminal
                │
       events + resumable query
```

B0 已在 [`lib/git-operations.js`](../../lib/git-operations.js) 落地任务模块。它提供带事务帧的追加日志、原子快照、幂等占位、状态迁移、协调域队列、取消、启动调和和事件投影。完整事务帧包含长度、校验和及单一 payload；截断尾帧不会生效。`challenge consumed + operation created` 等变化必须由一个事务提交。

终态包括 `succeeded`、`failed`、`cancelled`、`conflicted` 和 `unknown-result`。手机断线或请求超时后必须先按 `operationId` 查询，不得自动重复写操作。`running` 任务在重启时只能由只读调和决定；不能证明结果时进入 `unknown-result` 并阻塞对应协调域。

同一协调域同时只运行一个写任务。读取可以并发；不同 worktree 的共享 refs 使用 `common` 协调域；工作区/index/head 相关操作使用 `worktree` 协调域，涉及远端 tracking branch 的切换同时占用 common + worktree。B0 的任务 manager 还使用实例 owner 文件和每协调域 lease 文件防止同一 provider 重入。它不能锁住终端等外部 Git 消费者，因此操作前后做事实检测，外部竞争属于 `detect-only`，不得假装回滚。

每个写意图都绑定操作特定的 `preconditionToken`，而全局 `stateVersion` 只用于读视图刷新。取消先落盘 `cancelRequested` 再终止子进程；已经更新的引用、工作区或远端不能因取消而宣称回滚。若仓库进入 merge/rebase/cherry-pick 等中间状态，provider 单独报告可用的 abort/continue 操作；首版只开放安全可验证的 abort，continue 与冲突编辑后置。

## 5. 破坏性操作与确认

普通移动认证只能证明调用者有权访问 mobile-remote，不能替代对具体破坏性操作的确认。Slice B 普通 commit 使用 UI 独立明确确认但不申请 challenge；当前 B0 唯一需要服务端 challenge 的开放破坏性操作是 merge/rebase abort。挑战绑定：

- repositoryId、协调域和操作特定 preconditionToken 摘要；
- 操作类型及按 canonical JSON 编码的完整参数摘要；
- 当前共享 authToken 凭据版本的不可逆摘要；
- 一次性随机值、服务端时间和不超过两分钟的有效期。

challenge 的消费与操作任务创建必须是同一账本事务；重复、过期、参数变化或跨仓库使用都拒绝。它只防误触、旧状态、参数篡改和重放，不能抵御 authToken 泄漏。Slice B 只有 merge/rebase abort 开放服务端 challenge；删除分支、放弃改动、drop stash、reset、clean、远端删除和 force push 不提供执行端点。

## 6. 功能交付顺序

### Slice A：基础与只读

当前实现状态：已接入 mobile-remote 的 `gitService` provider seam 与 `/m/api/git/*` 只读桥；Flutter
快捷栏、状态/分支/提交图/差异视图已落地。provider 不可用时保持可见的能力降级；B1/B2 写闭环由独立
`gitWriteService` 投影，仍不把 Git 命令或 provider DTO 暴露给 Flutter。Slice A 本身仍只读，写能力不属于其交付范围。

- provider 可用性和诊断；
- 仓库状态、当前分支和 ahead/behind；
- 本地/远端分支列表；
- 只读提交图、提交详情和差异（拓扑增强见下文）；
- Git 快捷栏和三个可配置槽位。

### Slice A1：分支图深化约定

分支图仍是只读导航视图，电脑端 DSH/Git provider 是提交、引用和拓扑关系的唯一事实源。App 不重新运行 Git，也不根据本地缓存推断不存在的提交关系。

#### 选择集与筛选器

- 打开分支图时默认只选择当前本地分支；detached HEAD 或没有当前本地分支时，按“指向 HEAD 的本地引用 → provider 返回的第一个本地引用 → provider 返回的第一个远程引用”确定性兜底。没有引用时进入空状态，不猜测最近使用记录。
- 本地分支和远程分支是独立引用，均可进入选择集；筛选器按“本地分支/远程分支”分组。
- 本地组将当前分支置顶，其余本地引用保持 provider 顺序；远程组保持 provider 顺序。App 不另行按名称或提交时间排序。
- 选择集至少包含 1 个、最多包含 `maxVisibleBranches` 个分支；首版 `maxVisibleBranches = 3`，上限必须是单一配置常量，筛选器、提示文案、颜色和布局不得重复写死数值。
- 达到上限后禁用未选中的选项，并在筛选器旁持续显示“已选择 N/N”；禁用项不依赖点击 toast 解释原因。取消最后一个选中项时拒绝操作。
- 筛选器固定在图标题下方。本地和远程各占一行，行内 chip 横向滚动；chip 同时显示分支颜色、名称和选中状态，并承担图例职责。
- 选择状态只在当前分支图页面生命周期内保留；关闭后重新打开，重新按默认规则选择，不写入全局设置。

#### 拓扑范围与服务契约

- 首次请求默认返回最近 100 条提交，继续滚动时使用游标请求后续提交；提交顺序由 provider 保证，最新提交在上方，App 不按标题、作者或本地时间重排。
- 图请求携带选中分支的引用名称和当时的 tip OID。服务端必须验证引用仍在当前 `repositoryId` 的授权仓库内解析到该 OID；不接受任意 OID，也不在名称/OID 不匹配时静默改用最新 tip。OID 是拓扑起点，引用名称只用于身份、展示和失效提示。
- 筛选结果是所有选中 tip 的可达提交集合之并集，共享提交按 OID 去重并只显示一次。提交顺序使用 provider 的稳定拓扑/日期顺序；筛选不以“共同祖先”为截止点，也不能截断集合内必要的合并父线。
- 服务端返回短期、不可伪造的图快照标识。快照至少绑定 `repositoryId`、有序引用名称/tip OID 集、排序语义、页大小上限和 TTL，不要求保存完整提交列表。后续分页必须携带快照标识和不透明的排他游标；快照有效时，拼接页面不得重复或遗漏提交。
- 引用移动或删除、tip 校验失败、游标不属于该快照、仓库身份变化或 TTL 到期时返回 `graph-stale`；不得回退到全量图或新 tip。App 保留旧图并提示刷新，刷新后建立新快照。
- 没有共同历史的选中分支允许并列显示为独立拓扑组件，组件之间不绘制虚假连线。
- 已加载提交的父提交尚未返回时，只绘制到边界的未完成连接；后续加载成功后自动接续，失败时显示可重试状态，不创建伪提交。
- provider 不支持按 tip 筛选时，只有在能力声明保证拓扑完整的情况下才允许适配层过滤；否则必须明确报告筛选不可用，不得静默回退到全量图。

#### 图形布局与视觉语义

- 图形区域的默认可视宽度约 72–88dp，提交标题和元信息使用剩余宽度，不引入整页横向滚动。拓扑同时活跃的 lane 数不等于选中分支数；lane 超出默认宽度承载能力时，仅图形区域内部横向滚动，提交内容列保持固定，并用边缘渐隐提示还有 lane。不得通过重叠或删除父线伪造拓扑。
- `maxVisibleBranches` 只限制选择集，lane 布局容量独立计算；未来提高分支上限时，不要求同步修改节点尺寸、颜色段上限或页面级布局常量。
- 普通提交使用固定大小实心圆；合并提交使用带外环的节点；当前 HEAD 使用额外外环和“当前”标记。节点大小和行高首版固定，不提供缩放设置。
- 分叉和合并使用显示 lane 连线表达，合并节点保留所有必要父线；第一父边延续当前显示 lane，其他父边进入各自 lane。Git 提交不归属于某个分支，文案、DTO 和实现不得使用“提交所属分支”推断颜色或拓扑。
- lane 的显示色以选中 tip 的引用名称作为稳定种子，而不是筛选顺序或“分支所有权”；共享历史由确定性的 lane 布局规则选色。刷新和重新选择后尽量保持稳定。浅色/深色主题各自使用高对比度调色板，颜色之外仍通过文字标签、节点外形和图例区分。
- 仅当多个选中引用的 tip 直接指向同一提交 OID 时，节点才表达多引用：单一引用使用实心引用色，多引用使用中性色填充和固定尺寸分段色环；颜色段数量受独立的 `maxNodeColorSegments` 常量限制，超出部分以 `+N` 收纳，不套多层同心圆。普通共享祖先不因“可从多个 tip 到达”而显示多色节点。
- 分支标签显示选中的本地/远程引用，tag 使用中性色；单行最多显示 2 个标签，其余收纳为 `+N`，完整引用在提交详情中查看。长名称在标签内省略，远程引用保留 remote 身份。
- 当前分支标签增加“当前”标识；本地 tracking 分支和远程引用仍保持独立，不合并为一个节点。

#### 交互、刷新与异常

- 点击提交行或节点打开现有提交详情抽屉；分支图不直接切换分支，切换仍通过分支抽屉完成。
- 筛选器在图加载期间仍可操作。移除分支时，可以对当前快照中已加载且具备完整可达性元数据的提交做即时收窄；新增或替换分支会请求新快照，并在新首屏成功前保留旧图及加载状态，不把不同快照的页面拼接。provider 无法证明本地收窄完整时也必须请求新快照。
- 收到 `git/changed` 事件只显示“数据已更新”提示，不自动重排；用户点击刷新后建立新的图快照。
- 首次加载显示进度，继续加载显示底部进度；无提交、仓库不是 Git 仓库、provider 不可用和失效 tip 都显示明确原因及刷新入口，不显示空白画布。
- 颜色不足时保持固定节点尺寸和引用文字标签，不依赖颜色单独识别。
- 默认 provider 的命令输出解析属于 provider 实现边界，不进入移动协议。若使用 NUL 分隔记录，必须在 provider 单元测试中验证记录边界 CR/LF 清理和尾部空记录过滤，确保 OID、分支名、远程标志和引用字段不携带 framing 字符。
- 该方案是 Slice A 的只读增强，不扩大分支切换、提交、同步等写操作范围；服务边界遵循 [ADR 0001](../adr/0001-mobile-git-scope.md) 与 [ADR 0002](../adr/0002-git-provider-integration.md)，tip 绑定的短期图快照与分页决策见 [ADR 0005](../adr/0005-tip-bound-git-graph-snapshots.md)。

### Slice B1：暂存与精确提交（已实现）

- `gitWriteService` 创建短期 change-set，绑定仓库、HEAD、index tree、工作区 diff/status 事实与 TTL；
- 客户端只选择服务端生成的 fileId/hunkId。临时 index 中执行 file/hunk stage 与 unstage，再通过 index lock 原子安装；未跟踪、二进制和重命名首版只支持整文件；
- commit 使用预演返回的 staged tree 与 HEAD 前置条件，以 `commit-tree` 创建对象并以 `update-ref` CAS 更新当前本地分支，不运行 hooks；
- B1 任务接入 B0 的幂等、仓库串行、取消、SSE 查询和 stale/unknown-result 语义；外部 Git 消费者仍为 detect-only；

### Slice B2：本地分支与受保护切换（已实现）

- 本地分支创建、重命名和无 force 切换均由任务账本执行；创建默认从当前 HEAD，也可使用 provider 已验证的 commit 或远端精确引用作为起点，创建不会自动切换；远端切换必须显式提供 `localName`，并以该名称创建 tracking branch；
- 受保护切换先检查当前 HEAD、目标 OID、工作区状态和 Git 中间态。Git 可安全携带改动时允许无 force 切换；存在覆盖风险时不签发 token，只返回提交、转电脑或取消入口；
- 分支名称通过 Git ref 规则校验，重命名只影响本地 ref/config，不触碰远端；所有 token 在执行前重新检查，外部变化使用 `state-changed`/`unknown-result` 语义；

### Slice B：日常写闭环

- 文件与 hunk 级 stage/unstage；
- 可编辑提交消息和 commit；
- 创建、切换和重命名本地分支；
- fetch、pull、push 与明确 upstream/远端选择；
- 后台任务、断线恢复、取消和冲突交接。

### Slice C：扩展管理

- stash 创建、应用和 drop；
- tag 查看、创建、推送和删除；
- 模型生成提交消息；
- 经单独安全评审后增加远端分支删除等高风险操作。

## 7. 分支与同步语义

- 点击本地分支表示切换；如果改动可能被覆盖，先展示提交、stash、放弃或取消等处理入口。Git 能安全携带改动时可以切换，但仍应明确提示。
- 点击远端分支表示创建或选择对应的本地 tracking branch，不把远端引用直接称为“切换到远端分支”。
- 本地分支重命名和删除不隐式修改远端；远端操作必须单独命名和确认。
- 无 upstream 时由用户选择 remote 和目标分支；不得假定 `origin`。
- “远端同步”是分阶段编排，不是原子操作。pull 成功、push 失败时必须保留并展示真实的部分成功状态。

## 8. 模型提交消息

App 只发送“为当前 staged changes 生成候选消息”的意图。模型读取行为由 DSH 侧执行并进入可审计的会话或任务事实流，不由 App 直接调用外部模型 API。

候选消息绑定生成时的 staged tree 标识；用户确认 commit 前若暂存内容已变化，必须提示重新生成或再次确认。provider 需要限制 diff 体积、排除二进制内容并遵循现有模型数据边界。生成结果永远可编辑，永远不能自动提交。

## 9. 候选 provider 调研

调研结论只反映 2026-08-25 的版本状态，不构成稳定依赖承诺。

| 候选 | 可复用点 | 主要缺口 | 定位 |
|---|---|---|---|
| `dsh-wending-git-workbench` | workspace gate、DSH subprocess、SSE、跨插件只读服务 | 写操作仍主要在内部服务/私有路由；缺少完整稳定契约、tags/stash 等 | provider 技术验证首选，不直接依赖私有路由 |
| `dock-git` | 功能覆盖广，包含较多远端和历史操作 | 使用浏览器私有路由并直接 spawn；高风险操作较多 | 借鉴命令覆盖和解析，不作为移动协议 |
| `dsh-web-enhanced` | 结构化 Git domain 和 Typert gateway | Git 范围较窄，夹带大量无关 UI/功能 | 借鉴 domain 与 gateway 设计 |
| `dsh-client-ui-git-graph` | 已安装，workspace gate、DSH subprocess、分支和图谱 | 只注册内部 `/git` 路由，写能力仅切换/创建分支，无跨插件服务 | Slice A 参考或 provider 原型 |
| `dsh-git-status` | 当前分支和少量快捷操作简单 | 能力范围太窄 | UI 交互参考 |

没有候选当前直接满足本项目的 Service Definition。首选路径是先定义契约并做适配验证，再决定贡献上游、维护适配 provider，还是实现独立 provider。

## 10. 发布与兼容

默认 provider 的发布方式仍是实现阻塞项，见 ADR 0004。无论最终选择如何，都必须满足：

- bootstrap/diagnostics 返回 Git 服务版本、provider 能力和不可用原因，但不把插件名称变成 App 业务分支；
- provider 缺失、卸载或版本不兼容只影响 Git 功能；
- mobile-remote 保持已发布 API 只增不删，新旧 App 对未知字段和缺失能力均可降级；
- provider DTO 不直接穿透到移动 API；
- 发布说明列出已验证的 DSH、Service Definition、provider、mobile-remote 和 App 组合。

## 11. 风险登记

| 风险 | 影响 | 主要控制措施 |
|---|---|---|
| Service Definition 或 provider 版本漂移 | App 功能突然失效，错误语义不一致 | 独立稳定契约、能力协商、兼容矩阵和契约测试 |
| 默认安装没有受支持 provider | 用户看到 Git 入口却无法使用 | ADR 0004 落定前不宣称默认可用；诊断明确报告原因 |
| 断线或超时后结果不明 | 用户重试造成重复 pull/push/commit | operationId、幂等键、持久结果和 `unknown-result` 状态 |
| 手机、电脑和其他消费者并发写仓库 | 状态竞态、冲突或误操作 | 仓库级写串行、状态版本预检和外部变化检测 |
| 移动 API 新增直接仓库写能力 | 口令泄露后的破坏范围扩大 | 强认证、服务端确认挑战、工作区边界和高风险功能默认关闭 |
| pull/rebase 进入冲突或中间状态 | 仓库停留在无法继续的状态 | 显式冲突状态、独立 abort、模型/电脑交接和恢复说明 |
| 大仓库、超大 diff 或提交图 | 高频子进程、内存和移动流量过高 | 分页、输出上限、缓存、取消和按需加载 |
| hooks、凭据助手或交互式提示等待 | 后台任务挂起或行为与电脑端不一致 | 非交互环境、阶段超时、明确错误和可配置 hooks 策略 |
| 模型读取 staged diff | 私密代码外发、提示注入、提交前内容变化 | 遵循模型数据边界、体积限制、审计日志和 staged tree 绑定 |

## 12. 验收与风险测试

至少覆盖以下真实仓库场景：

- 空仓库、unborn branch、detached HEAD、浅克隆、嵌套仓库和 worktree；
- 脏工作区、未跟踪文件、重命名、二进制文件、超大 diff 和 hooks 失败；
- 多 remote、无 upstream、ahead/behind、凭据失败和远端拒绝；
- merge/rebase 冲突，以及在 fetch、pull、push 各阶段取消；
- 两台手机、电脑 UI 和其他消费者同时操作同一仓库；
- App 断线重试、provider 重载、DSH 重启后的任务结果查询；
- 任意路径、软链接越界、确认挑战重放和参数篡改；
- 旧 App/新 App、provider 缺失、旧 provider 和未知能力的兼容降级。

分支图深化还必须覆盖：

- 普通双亲合并、octopus merge、criss-cross merge、无共同历史的多个根，以及活跃 lane 超出默认图形宽度；
- 浅克隆边界、父提交跨页、空仓库和 unborn branch，分页拼接无重复、无遗漏且未完成父线能够接续；
- 多个本地/远程引用指向同一 OID、超过 `maxNodeColorSegments` 的引用，以及长名称和 tag 标签溢出；
- 引用在首屏与后续页之间移动、删除或改名，错误快照/游标、TTL 到期和仓库身份变化均返回 `graph-stale`；
- 达到选择上限、只剩一个选择、加载中更改选择，以及新快照失败后旧图仍可查看；
- 浅色/深色主题、系统字体放大、色觉差异和仅凭非颜色线索辨识 HEAD、merge、引用与 lane；
- 默认 provider 的 NUL/CRLF 记录边界回归测试，以及 provider 不具备完整筛选能力时的明确降级。

实现前需要把这些场景转成 provider 单元测试、真实临时仓库集成测试和移动 API 契约测试。
