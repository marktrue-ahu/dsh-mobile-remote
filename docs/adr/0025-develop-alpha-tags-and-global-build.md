# 0025 develop alpha 发布与全局单调 build 号

状态：已接受（2026-11-02）。实现追踪 GitLab issue #43；实际发布流程自 #43 合入起生效，之前仍按既有 release-only 流程。关联：ADR 0019、0020、0021、0022、0023、0024；设计稿 `docs/design/alpha-release-global-build.md`；领域术语见 `CONTEXT.md`「发布」。

## 背景

本 fork 需要持续把 develop 的新功能装到手机上实机测试，但既有发布规则要求版本 tag 只指向 `release/*` 分支的最终提交，CI 也强制校验 tag 提交必须包含在 `release/*` 中。实际后果是：

- develop 无法直接打 alpha tag；每次测试都要先切一条短期 release 分支，流程重，很快出现「本版本修复」与「develop 新功能」分叉。
- 若让 alpha 与 rc 并行，两条线各自递增 App 的 `+N`；同一台设备交叉安装会触发 Android `INSTALL_FAILED_VERSION_DOWNGRADE`，因此只能选择「RC 期间冻结 develop tag」，牺牲 develop 的持续实机验证。
- 根因不是「tag 不能并行」，而是 App 的 `+N` 按分支局部递增，缺少全局单调分配。
- 当前 `publish-npm.yml` 会让预发布也前进 `latest`，与 ADR 0024「预发布不得移动 `latest`」冲突；carrier 发布先 `--tag app` 再比较指针，等于把 `app` 指针无条件改成本次候选，alpha 与 rc 交错时会回退。
- 上述问题已由设计稿 rev.2 分析并通过评审（issue #42 #note_1587/#note_1589）；用户已确认全部决策。

## 决策

### 1. alpha 线允许在 develop，rc/stable 留在 release 线

- `develop` 可以打 `vX.Y.Z-alpha.N` tag，用于 develop 快照的实机测试；`release/vX.Y.Z` 只承载同 core 的 `-rc.N` 与 stable tag；`feature/*`、`fix/*`、`upstream/*` 禁止发布 tag。
- tag 归属按**可达性**校验：alpha 的提交须可达于 `origin/develop`；rc/stable 的提交须可达于对应 core 的 `origin/release/vX.Y.Z`，且 release 分支 core 必须等于 tag core。`git branch --contains` 只证明可达性，不声称「tag 来自哪条分支」这一 Git 不存在的属性。
- 发布 tag 不可复用、不可覆盖；只有从未成功发布的 tag 才允许在明确授权后删除。

### 2. 发布 build 号全局单调

- 领域规范名：**发布 build 号**指 `dsh-mobile-app/pubspec.yaml` 的 `+N`；Android 安装包实际的 **App versionCode** 由它派生，不再是「各分支自己 +1」。
- 分配规则：打 tag 前，`next = max(迁移水位, 历史 tag build, 已发布 carrier 的 appVersion build) + 1`。历史 tag 只用于避免复用；**已发布 carrier 才是发布前沿的唯一权威**。
- CI 校验规则：对**未发布的新 tag**要求 `build > 发布前沿`；carrier/插件均已发布的重跑幂等跳过；部分发布（例如 carrier 已发、插件未发）恢复时排除自身 carrier 后再校验；**不得用「当前所有 tag 的最大 build」作合法性判据**——tag 集合会在排队发布期间变化，用它会使合法排队或恢复任务被旧 tag 阻断。
- 历史兼容：迁移前的历史 tag 允许存在重复 build，仅 `legacyTags` 白名单内 grandfathered；新 tag 必须高于迁移水位并从下一个值开始。具体水位值与白名单放设计稿与 issue #43，不写死在 ADR。不得重写、移动或删除历史 tag。
- 发布前沿只由「已发布 carrier 的 `appVersion` build 最大值」决定；工作区 pubspec、未发布 tag、设备安装记录都不构成发布前沿。缺少可验证 `appVersion` 的旧 carrier 不参与自动前沿推断：迁移时人工核对或显式登记，不得猜测；无法确认时 fail-closed。

### 3. alpha 与 rc 可以交错，不再冻结 develop tag

- alpha tag 与 rc tag 可以交替发布，不冻结任何一条线；只要每次发布都基于最新的发布前沿分配 build，后发布 tag 的 build 必然更大，按发布时间安装不会降级。
- 发布执行仍是串行、需授权的动作；若两个 tag 几乎同时分配，后发布者因 `build > 发布前沿` 不成立而失败，必须重新 bump，绝不覆盖已发布版本。
- **同 core 边界**：本期只保证同 core 的 alpha/rc 交错（例如 `3.2.4-alpha.N` ↔ `3.2.4-rc.N`）。App 更新器先比较 core、再比较 build；跨 core（如 develop 已到 `3.2.5-alpha.N` 而 release 仍是 `3.2.4-rc.N`）的更新不在本期承诺内，需人工安装/卸载。未来若要支持跨 core，必须重新决策更新判定与配对安全。

### 4. `app` 与 `latest` 指针

- **`app` 指针不得回退**：carrier 发布前先读取当前 `app`，只有候选 carrier 的 SemVer 大于当前值（或无当前值）才允许移动 `app`；否则用临时 tag 发布 carrier，保持 `app` 原值。禁止「先 `npm publish --tag app` 再比较」的写法。重跑/部分恢复同样先比较后移动；`app` 指向非 carrier 的异常历史转人工处理，不自动修复。
- **`latest` 只由稳定版前进**：alpha/rc 只更新自身通道（`alpha`/`rc`），不得移动 `latest`。这与 ADR 0024 的约束一致；当前 workflow 的「所有发布都前进 latest」必须在 issue #43 中修正。
- **bootstrap 例外**：当前 npm 上 `latest` 为 `3.2.3-rc.1`、尚无稳定版。首个 stable 发布前允许 `latest` 暂为 prerelease；首个 stable 发布后 `latest` 必须指向 stable。不为满足该不变量而自动发布 stable、删除或改名历史版本；发布 stable 仍需正常 release 流程与授权。
- 通道更新仍由本机插件版本的 prerelease 段决定；候选插件用精确 `${candidate}-app` 配对 carrier，`app`/`latest` 指针不作为 App 与插件的配对依据。

### 5. release 线与 cherry-pick

- `release/vX.Y.Z` 从 develop 的指定提交切出（优先已实机验证的 alpha tag commit），bump 到 `X.Y.Z-rc.1` 并冻结新功能。
- develop 上的修复先修 develop，再 cherry-pick 到 release；release 上的修复再 cherry-pick 回 develop。**禁止 merge develop 到 release**，避免把未计划的新功能带进冻结线。
- stable 发布后 develop 可进入下一 core；跨 core 的设备更新按 §3 的限制走人工安装。

### 6. 生效、实施与授权

- 本 ADR 状态为「已接受」，但**实际发布流程自 issue #43 实现合入起生效**；在实现完成前，既有 release-only 流程仍有效，不能按本 ADR 直接给 develop 打 alpha tag。
- issue #43 负责：全局 build 分配工具、原子 bump 工具、workflow 的 tag 归属/build/app/latest 校验、发布手册与 AGENT-RULES 同步、迁移水位落地。
- 发布执行者、推送/tag/发版的逐次授权以 `AGENT-RULES.md` 为准；本 ADR 不复述授权清单，避免两份规则漂移。

## 后果

- develop 从此可以作为长期实机测试线：alpha tag 直接来自 develop，不需要先切 release 分支；RC 期间不再冻结 develop tag。
- CI 必须按 §1/§2/§4 修改；在 #43 完成前，当前 workflow 仍会拒绝 develop 上的 alpha tag，并可能让预发布移动 `latest`。这是「已接受但未实现」的已知过渡状态。
- 历史 8 个 tag 的重复 build 不重写；迁移水位与 legacy 白名单由设计稿给出，新发布从水位之后开始。迁移前必须人工核对已安装设备/未打 tag 构建，必要时抬水位；未打 tag 的更高 build 不能被忽略。
- 当前 npm `latest=3.2.3-rc.1` 的 bootstrap 状态保留到首个 stable 发布；首个 stable 之后 latest 必须为 stable。
- 发布失败/回滚：未发布 tag 可删除并重新分配；已发布版本不可覆盖、不可回退；部分发布按恢复语义完成或作废，不得借恢复把通道指针回退。
- 跨 core 更新仍是已知限制：Android versionCode 更大不代表 App 更新器接受；跨 core 需人工安装，这是本期明确不承诺的能力边界。

## 考虑过的方案

- **RC 期间冻结 develop tag**：拒绝。能规避 versionCode 冲突，但牺牲 develop 的持续实机验证，且冻结解除后仍要面对两条线的 build 顺序问题。
- **时间戳 versionCode**：拒绝。构建时取时间可保证单调，但 versionCode 不可预测、不落在 git 中，排查与审计困难；本 ADR 选择「可审计的全局分配 + 发布前沿校验」。
- **dev flavor / 独立 applicationIdSuffix**：拒绝。能让 develop 包与 release 包共存，但无法覆盖生产包升级/自动更新链路，且会改变 host 插件与 carrier 的配对语义。
- **alpha tag 只打 release 线**：拒绝。这是现状，正是「每次测试先切 release 分支」与 cherry-pick 负担的来源；alpha 语义上属于 develop。
- **各分支局部递增 `+N`**：拒绝。alpha/rc 交错必然产生降级安装；只在单线顺序发布时成立，无法支持并行测试线与发布线。
