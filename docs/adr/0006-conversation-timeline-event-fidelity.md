# 对话时间线保留事件保真度

Status: accepted

日期：2026-09-19（补录：决策产生于 `feature/execution-trace-display`，实施合并进 develop 后补入本 ADR 序列，编号 0006）

## Context

DSH Remote Android App 过去只接收有损摘要，并把工具调用限制为短暂活动条；历史接口还使用固定白名单。这个取舍降低了移动端流量，但用户无法在手机上审阅主会话的工具参数、结果、错误、未知可见事件和完整生命周期。

当前需求要求 App 与 DSH Web 在语义上对齐主会话的 Conversation timeline，同时保留普通模式的可读性。DSH 组件可能以不同 release-candidate 版本组合运行，因此不能用 package version 推断能力。

## Decision

1. 服务端以 additive capabilities 声明对话时间线能力。
2. 实时和历史返回同一轻量事件摘要 envelope，并保留 durable `seq`、事件类型、关联标识和按需详情指针。
3. 完整长参数、结果和未知事件通过认证的单事件详情端点读取；详情缺失时 App 明确显示不可用，不猜测重建。
4. 历史回放过滤 token 级实时 chunk、`request/header`、`request/context`、seed/step 边界、`system/message` 和已由队列投影承载的日志；保留未知候选 Visible event 的类型、顺序和详情指针。`ignorable` 不单独作为移动端 visibility filter，以免新版本的未知可见记录被静默丢弃。
5. App 普通模式显示摘要并隐藏选定 runtime 注入；调试模式显示可获得的原始工具 IO、协议元数据和未知事件，但系统提示词与已知上下文快照永不通过时间线详情端点或 UI 返回。工具生命周期按 `callId` 合并。
6. 能力缺失时优雅降级到旧摘要/历史行为；新增字段不得破坏旧客户端。

## Consequences

- 传输、历史、App 事件模型和渲染必须同时演进；恢复一个 UI 开关不足以完成需求。
- 默认列表仍然轻量，但详情请求可能暴露原始参数和结果，包括敏感数据；现有认证与网络信任边界继续适用。
- 需要测试实时/历史收敛、跨页 catch-up、未知事件和旧服务端降级。
- 这取代了旧架构简表 D5 的“摘要下放而非全量事件”策略；摘要仍是默认展示形式，但不再是唯一可获得的数据。

## 后续修订（需求变更补记）

- **详情正文口径收敛**（2026-09-20）：详情端点对 `assistant/message` 附**规范化 `data.text`**（与摘要同一 `blocksToText`，跳过 `reasoning` 与内部块），客户端**必须直接采用、不得自行递归拼接** `message.content`——否则思维链会在折叠块之外重复出现。摘要的详情指针增补 `textChars`（未截断正文长度），供客户端在加载前判断「是否真有正文增量」。详见 GitLab issue #1 评论 #299。
- **产出文件不再上时间线**（2026-09-20）：`tool/result` 与 `assistant/message` 停发 `files` 元数据（用户自己的附件仍保留）；App 移除工具卡与 assistant 消息的文件行及其下载入口，用户附件只显示文件名。详见 GitLab issue #1 评论 #303。
