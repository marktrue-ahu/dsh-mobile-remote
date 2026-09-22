# DSH Mobile Git 只读导航上下文

本上下文定义手机端 Git 只读导航使用的领域语言。Git 事实属于电脑端授权工作区；手机端只观察仓库事实，不拥有或执行 Git 写操作。用户需要修改仓库时，通过普通会话向 AI 表达意图，该行为不属于 Git 只读导航。

## 仓库

**Git 工作区**：
经 DSH 工作区授权、包含一个 Git 仓库的电脑端目录，是 Git 读取能力的安全边界。
_避免_：当前项目、手机目录、任意 cwd

**仓库上下文**：
由当前聊天会话的工作目录解析出的授权 Git 工作区，是该会话 Git 导航入口唯一查看的仓库。
_避免_：仓库选择器、客户端路径、任意 cwd

**仓库标识**：
由电脑端为仓库上下文分配的稳定身份，手机端用它引用仓库而不把主机路径当作读取权限。
_避免_：cwd、绝对路径

**当前分支**：
仓库上下文中当前检出的本地分支；仓库处于 detached HEAD 时不存在当前分支。
_避免_：远端分支、会话分支、HEAD

## 移动交互

**移动端 Git 只读导航**：
手机端围绕分支列表、分支图和提交详情提供的仓库观察能力，不包含状态、差异或任何 Git 写操作。
_避免_：移动端 Git 管理、日常 Git 闭环、Git 工作台

**Git 导航入口**：
聊天界面右上角用于打开当前仓库导航抽屉的固定入口；能力不可用时仍然可见并说明原因。
_避免_：Git 快捷栏、功能槽位、静默隐藏

**分支抽屉**：
用于浏览本地与远端分支、进入分支图和查看提交详情的只读移动面板。
_避免_：分支操作面板、仓库选择器

**分支图**：
按提交拓扑展示分支、远端引用、标签和提交历史的只读导航视图。
_避免_：分支抽屉、线性提交列表

**分支图选择集**：
一次分支图查询明确选择的一至三个本地或远程引用；引用名称表达身份，查询建立时的 tip OID 固定其历史起点。
_避免_：当前可见颜色、所有分支、提交所属分支

**分支图快照**：
把仓库、分支图选择集和排序边界绑定在一起的短期只读查询身份，用于保证多页提交属于同一次拓扑观察。
_避免_：完整提交缓存、实时分支状态、App 本地快照

**显示 lane**：
分支图为表达父子、分叉和合并关系而计算的视觉轨道；它不是 Git 分支，也不表示提交归属于某个分支。
_避免_：分支所有权、选中分支数量、提交分支

**提交详情**：
从分支图节点下钻查看的只读提交事实，包括作者名、时间、OID、完整消息、父提交、引用、标签、变更统计和可分页文件列表；不包含作者邮箱或 patch。
_避免_：提交编辑、完整 diff、作者身份档案

**仓库变化提示**：
导航期间检测到引用或仓库事实变化后保留当前内容并提示显式刷新，不在用户浏览时静默替换查询身份。
_避免_：自动重排、静默陈旧

## 能力边界

**Git 能力接缝**：
连接 Git 服务定义、一个或多个能力提供者以及能力消费者的稳定边界。
_避免_：某个插件的私有路由、Flutter 直接运行 Git

**Git 服务定义**：
独立描述仓库识别、分支、提交拓扑、提交详情、变化事件和稳定错误语义的只读 DSH 服务契约，不依赖具体提供者或移动协议。
_避免_：Git 写操作契约、provider DTO、HTTP API

**Git 能力提供者**：
在 DSH 进程内实现 Git 服务定义并拥有仓库只读事实的组件；外部 provider 优先，缺失时可由包内只读 provider 提供默认能力。
_避免_：Flutter App、移动适配器、Git 写执行器

**Git 移动适配器**：
把只读 Git 服务定义投影为稳定移动契约的 mobile-remote 组件，拥有移动鉴权和兼容降级，但不拥有 Git 状态或写操作。
_避免_：Git provider、写任务协调器、终端文本协议

**Git 能力可用性**：
移动适配器根据服务定义和兼容版本报告的只读功能集合；不可用能力必须给出明确原因。
_避免_：插件名称、静默隐藏、Git 写能力

---

# DSH Mobile Remote

DSH Mobile Remote extends a single user's computer-hosted DeepSeek Harness into a phone remote, including read-only visibility into the balances and quotas of configured model providers.

## Language

**Usage and allowance**:
The grouping of provider-specific monetary balances and time-window quotas in the mobile UI, without pretending they share one additive total.
_Avoid_: Balance page, total balance

**Balance**:
A monetary amount that remains available for spending, such as the DeepSeek API CNY balance or finite Codex credits.
_Avoid_: Quota, allowance

**Quota**:
Capacity remaining within a provider-defined time window, represented independently for each window and accompanied by its reset time when known.
_Avoid_: Balance, total balance

**Quota window**:
One independently reset usage period, such as 5 hours, week, or month; valid windows are shown separately and are never summed.
_Avoid_: Billing period, total quota

**Active Codex account**:
The single account currently selected by dsh-codex-connect for subsequent Codex requests; mobile usage visibility follows this account only and identifies it by display name and masked email.
_Avoid_: Mobile account, session account

**Codex credits**:
A monetary Codex balance reported independently from time-window quotas; finite credits remain visible even when quota windows are also present.
_Avoid_: Codex quota, combined balance

**Individual spending limit**:
A Codex workspace member's exact allowance, used amount, and remaining amount; it is separate from both Codex credits and time-window quotas.
_Avoid_: Monthly quota, Codex credits

**Usage source**:
A provider account whose latest balance or quota query succeeds; a source stops being available as soon as its latest query fails and is omitted wherever usage sources are listed.
_Avoid_: Account, model

**Usage summary**:
The at-a-glance rendering of the currently available usage sources in the mobile UI, shown as independent per-source entries; it never aggregates balances or quota percentages.
_Avoid_: Total balance, combined quota

## Conversation timeline

**Conversation timeline**:
The ordered, replayable rendering of one session's Visible events, covering both live delivery and historical replay.
_Avoid_: Chat log, message list

**Visible event**:
A main-conversation event the user may see, carrying a durable sequence number, its type, and — when the computer can still retrieve it — an on-demand detail pointer; an unrecognized type is kept, never silently dropped.
_Avoid_: Internal record, raw log line

**Tool activity**:
One tool invocation merged across its whole lifecycle by call id, so arguments, running state, result and error stay in a single timeline entry instead of separate rows.
_Avoid_: Tool result, activity bar

**On-demand event detail**:
The lossless per-event payload retrieved by sequence number for long arguments, results and unknown events; when the computer no longer holds it, the phone states it is unavailable instead of reconstructing it.
_Avoid_: Summary, cached event

**Canonical detail text**:
The visible text of an event as extracted by the computer under the same rule as the event summary, excluding reasoning and internal blocks; the phone must use it as given and never re-derive text by concatenating raw content blocks.
_Avoid_: Full response, joined content

**Ordinary mode**:
The default presentation of the timeline: execution detail is summarized, and selected runtime injections and protocol metadata are hidden.
_Avoid_: Simple mode, non-technical mode

**Debug mode**:
The opt-in presentation that additionally exposes raw tool input/output, protocol metadata and unknown events, while system prompts and known context snapshots never appear in either mode.
_Avoid_: Developer mode, verbose mode

**Timeline capability**:
The computer's additive declaration that it can serve the timeline, its history and on-demand detail; the phone follows this declaration rather than inferring support from component versions.
_Avoid_: Version check, feature flag

**Code fence**:
A block boundary made of three or more backticks; a closing fence must use at least as many backticks as its opener, and everything inside the fence is code — never re-parsed as Markdown. Indentation in the opening line is tolerated so that code blocks nested in list items still render.
_Avoid_: Triple-backtick block, code marker

**Markdown block parsing**:
The client-side process that cuts a message's given text into block elements (headings, lists, quotes, tables, code) for the Conversation timeline; it renders the text as given and never re-derives it.
_Avoid_: Markdown conversion, HTML rendering
