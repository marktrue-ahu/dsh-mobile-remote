# 0023 上游代码同步与 fork 的 npm 发布坐标分离

状态：已接受（2026-10-29）。

## 背景

本 fork 需要持续吸收 `github/main` 的代码修复与功能，但其公共发行链与上游并不相同：develop 使用 scoped npm 包名、Trusted Publisher、插件与 App 载体精确配对；上游 `main` 的包名和版本线属于另一发行主体。把上游代码并入 develop，不应被误解为同步上游的包名、版本、载体别名或发布标签。

这次决策前的对照是 develop `08d82e1` 与 main `09dd293`。main 有自己的 v3.2.2 / v3.3.0 开发记录，而 develop 保留本 fork 的发布历史和身份。两条版本线可以共享代码，但发布元数据必须仍由本 fork 控制。

## 决策

1. 上游同步采用**将完整 `github/main` 以 merge commit 合入 develop** 的方式，不 rebase、不把整条上游历史改写为 fork 私有历史。冲突逐文件按语义解决，不使用 `-X ours` / `-X theirs`。
2. **npm 发布坐标属于本 fork 的发布边界**：保留 develop 的 scoped 包名、插件版本、精确 App 载体别名及发布配置；不复制上游 main 的 unscoped 包名、版本号或 dist-tag 作为本 fork 的发行身份。版本 bump 仍在本 fork 的 release 流程中独立决定。
3. 合入上游代码时，develop 是当前集成行为的语义基线：保留 develop 已有的兼容、预算、取消和发布能力，并将 main 的新增能力按文件语义补入，避免因上游整文件改动而回退本地修复。
4. CHANGELOG 保留本 fork 的发布历史；上游的 v3.2.2 / v3.3.0 条目不作为本 fork 已发布版本记录。合入的代码变更留待本 fork 下一条 release 线写入自己的发布说明。
5. 本次 develop 的 App `pubspec.yaml` 版本保持 `3.2.1+24`，不因合并上游 main 自动改变；由于 App `3.2.1+25` 已随 alpha3 发布，下一个实际发布的 App build number 必须高于 `+25`。此 build number 是当时的版本状态，不构成长期固定值。

## 后果

- develop 可以包含领先或不同于上游的实现，同时继续使用本 fork 已公开的 npm 包身份和载体约定。
- 上游 release notes 不会自动变成本 fork 的 release notes；发布时仍需在本 fork 的 release 分支校验 package name、版本配对、App build number 和 dist-tags。
- LAN Bridge 默认行为、二维码地址排序等具体产品行为属于各自代码/契约决策，不由本 ADR 取代。

## 考虑过的方案

- **同步上游包名和版本**：拒绝。会改变已发布 scoped package 的身份，并把上游的 release/version line 误当成本 fork 的发布。
- **只 cherry-pick 部分 main 提交**：本次不采用。用户选择全量同步上游 main，以完整保留其代码历史；个别冲突仍按本 fork 的 develop 语义解决。
- **直接复制上游 CHANGELOG 作为 fork 的最新发布记录**：拒绝。上游发布并不表示本 fork 已按相同 package identity 发布。
