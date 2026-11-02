# 设计稿：develop alpha 发布与全局单调 build 号（方案 1）

- 状态：**已批准（approved，2026-11-02，rev.3；已按 issue #42 #note_1597 评审补充修订）**
- 关联：GitLab issue #42（评审评论 #note_1587）、`docs/10-release.md`、`.github/workflows/publish-npm.yml`、`AGENT-RULES.md`「发布」一节
- 日期：2026-11-02
- 修订摘要：rev.2 修正 build 校验与幂等恢复、历史 build 重复与迁移水位、app dist-tag 先比较后移动、双远端 fetch、bump 原子性、latest 迁移、contains 判据、跨 core 更新限制；rev.3 补充旧 carrier 缺 appVersion 的 legacy 映射、release-meta 全局权威、未确认发布（unknown/staged）阻断、app 指针按配对插件版本比较

## 1. 问题

当前发布规则要求版本 tag 只指向 `release/*` 分支的最终提交，CI 也强制校验 tag 提交必须包含在 `release/*` 中。实际使用中这带来两个问题：

1. **develop 无法直接实机测试**：要测 develop 最新功能，必须先从 develop 切一条短期 release 分支再打 alpha tag，流程重、且 release 分支上很快出现「本版本修复」与 develop 新功能的分叉。
2. **RC 期间冻结 develop tag 不可接受**：develop alpha 与 release rc 并行时，两条线各自递增 App `+N`，同一台设备交叉安装会触发 Android `INSTALL_FAILED_VERSION_DOWNGRADE`；若靠「RC 期间冻结 develop tag」规避，又牺牲了 develop 的持续实机验证。

根因不是「tag 不能并行」，而是 **App versionCode（`pubspec.yaml` 的 `+N`）目前按分支局部递增，缺少全局单调分配**。

## 2. 目标与非目标

### 目标

- develop 可以持续打 `vX.Y.Z-alpha.N` tag，用于实机测试，**不需要**先切 release 分支。
- `release/vX.Y.Z` 继续承载 rc/stable；alpha 与 rc 可以**并行/交替**打 tag，不冻结任何一条线。
- 同一台设备上，按发布时间安装/更新时 **versionCode 单调**，不会出现降级安装失败；build 分配与发布顺序有可验证的规则。
- release 线只接受 cherry-pick 的修复，不从 develop merge 新功能；develop 仍可继续前进。
- 发布仍是 fail-closed：版本号/配对/单调性任何一项不满足就拒绝发布；已发布 tag 的重跑必须幂等。

### 非目标 / 明确限制

- 不做 `applicationIdSuffix` / dev flavor（无法覆盖生产包升级链路）。
- 不改「carrier 精确配对 `${pluginVersion}-app`」模型。
- 不做时间戳 versionCode（不可审计、不可复现；仅作为被否决的备选）。
- **本期不保证跨 core 的应用内更新**：`update_core.dart` 先比较 core、再比较 build。`3.2.5+40 -> 3.2.4+41` 会被判定为 `remoteOlder`（尽管 Android versionCode 更大），反过来 `3.2.4+41 -> 3.2.5+40` 会判定可更新但实际安装降级失败。因此本期只保证**同 core** 的 alpha/rc 交错；跨 core 切换走人工安装流程（见 §5.3、§7）。
- 不改变「发布动作需要用户逐次授权」的规则。

## 3. 决策摘要

1. **alpha tag 允许打在 develop**；rc/stable tag 仍只允许打在对应 core 的 `release/vX.Y.Z`。
2. **App build 号全局单调**：由「迁移水位 + 历史 tag + 已发布 carrier」共同决定，在打 tag 前分配；CI 只对未来发布做单调/唯一校验，**不再用每次重跑时动态变化的全量 tag 最大值作为合法性判据**。
3. **不再需要 RC 期间冻结 develop tag**：alpha/rc 可交替发布；build 按发布顺序递增，不要求 tag 创建顺序严格等于发布顺序。
4. **`latest` dist-tag 只由稳定版推进**（已确认，见 §6.2/§13）；当前 `latest` 仍为 `3.2.3-rc.1`、尚无稳定版，按 bootstrap 例外过渡。
5. **`app` dist-tag 必须先比较后移动**：现有 workflow 先 `npm publish --tag app` 再比较，等于永远「keep」，会把 `app` 从更高 SemVer 的 rc/stable 回退到 alpha；本设计改为**发布前判定、不可回退**。
6. release 分支从 develop 的指定提交切出（优先已实机验证的 alpha tag commit）；修复 **cherry-pick** 进 release，release 的修复再 cherry-pick 回 develop；**禁止 merge develop 到 release**。
7. 增加一个**原子 bump 工具**，同时更新 `package.json` 的 version 与精确 carrier alias、`pubspec.yaml` 与 CHANGELOG；避免只改主版本导致 alias 校验失败。

## 4. 分支与 tag 策略

### 4.1 分支职责（在现有基础上调整）

| 分支 | 变更 |
|---|---|
| `develop` | 允许打 `vX.Y.Z-alpha.N` tag（实机测试）；普通 push 仍不 bump 公共版本、不发 npm |
| `release/vX.Y.Z` | 只允许同 core 的 rc/stable tag；从 develop 指定提交切出；只接受本版本修复与版本/CHANGELOG |
| `feature/*` / `fix/*` / `upstream/*` | 仍然禁止任何发布 tag |

### 4.2 tag 与分支的对应关系（CI 强制）

| tag 形态 | 允许的可达分支 | 额外校验 |
|---|---|---|
| `vX.Y.Z-alpha.N` | `origin/develop` | tag 的 core `X.Y.Z` 与 tag 指向提交的 `package.json` 一致（bump 已保证）；提交已推送到 develop |
| `vX.Y.Z-rc.N` | `origin/release/vX.Y.Z` | 分支名 core 必须等于 tag core；提交已推送到该 release 分支 |
| `vX.Y.Z` | `origin/release/vX.Y.Z` | 同上 |

- `git branch -r --contains` **只证明可达性**，不证明「tag 是在哪条分支上创建的」（Git 没有这个属性）。因此上表表述为「提交须可达于某允许 ref」，并在测试中断言**不在允许集合内则拒绝**，不承诺不可能验证的“来源分支”语义。
- alpha tag 指向的提交必须已经推到 `origin/develop`（先推 develop，再推 tag）；rc/stable 同理先推 release 分支。
- 同一 tag 版本号全局不可复用；删除 tag 只在「从未成功发布」且获得明确授权时允许。

## 5. 全局单调 build 号

### 5.1 分配不变量与数据源

- **唯一事实源仍是 `dsh-mobile-app/pubspec.yaml` 的 `+N`**；tag 指向的提交里必须记录实际 build。
- **全局权威**：迁移水位、legacy tag 白名单、legacy carrier 核验记录统一放在受保护的 **`release-meta` 分支**的 `build-policy.json`（路径在实现中固定）。分配工具与 CI 都从 `origin/release-meta` 读取最新记录；本机同时校验 `github/release-meta`。**不得信任当前 develop/release 树里的副本**——分支内的同名文件只能作为提案镜像，不是分配或校验依据。
  - `release-meta` 缺失、两个远端 SHA/内容不一致、schema 非法 → fail-closed。
  - 更新水位/白名单只能通过 `release-meta` 的受保护提交，需发布授权；水位只允许抬高，不得回退。
- 发布政策记录的 schema（初始种子示意）：
  ```json
  {
    "schema": 1,
    "watermark": 32,
    "legacyTags": ["v3.2.1-alpha.1", "…现有 8 个 tag…"],
    "legacyCarriers": [
      { "version": "3.2.1-alpha.1-app", "integrity": "sha512-…", "appBuild": 24 }
    ],
    "updatedAt": "2026-11-02"
  }
  ```
  - `legacyCarriers` 是迁移期**旧格式 carrier 的已核验映射**：对每个缺顶层 `appVersion` 的已发布 carrier，按 `dist.integrity` 校验 tarball、读取其内嵌 `manifest.json`/APK 的 App build，并登记精确版本、integrity 与 build。只有这张表能把旧 carrier 纳入发布前沿；**不修改任何已发布包，不静默跳过未知记录**。
  - 新 carrier 必须有合法顶层 `appVersion` 且 integrity 匹配；未登记的 carrier 缺字段/非法 → fail-closed；已登记 legacy carrier 的 integrity 不符 → fail-closed。
- `tools/next-build.mjs` 分配规则：
  ```
  nextBuild = max(
      release-meta 的 watermark,
      所有历史 release tag 提交里的 build（legacy 重复值也参与 max）,
      已发布新 carrier 的 appVersion build,
      legacyCarriers 的 appBuild
  ) + 1
  ```
- **发布前沿**定义：`max(已发布新 carrier 的 appVersion build, legacyCarriers 的 appBuild)`；工作区 pubspec、未发布 tag、设备安装记录都不构成发布前沿。缺少可验证 `appVersion` 且未在 `legacyCarriers` 登记的旧 carrier 不参与自动前沿推断：先按 §12 人工核验登记，无法确认时 fail-closed。
- 双远端 fetch 必须正确：使用 `git fetch --multiple --tags origin github`（或分别 fetch），并在同名 tag 的 SHA 不一致时 **fail-closed**；分配端与 CI 端必须声明各自看到的数据源（本机 `origin`=GitLab、`github`=fork；CI `origin`=GitHub），不能假定同名 remote 同源。
- 打 tag 前先确认 `origin/release-meta` 与 `github/release-meta` 内容一致；不一致时不得分配。发布记录以 **tag 身份 + npm 已发布状态 + release-meta 的发布意图** 为准，不新增每分支可变的 build 台账。

### 5.2 CI 校验（`publish-npm.yml`）

按「tag 身份 → 已发布状态 → build 校验 → 发布」顺序执行：

1. **tag 身份校验**（保留并增强）：
   - tag 版本 = `package.json` 版本；
   - App core = 插件 core；
   - 主包 `optionalDependencies` 的精确 carrier alias 必须等于 `npm:<name>@<pluginVersion>-app`（现有 `exactCarrierAliasChecks`）；
   - pubspec 的 `+N` 存在且合法。
2. **祖先/core 校验**：按 §4.2 检查允许的可达 ref，并校验 release 分支 core 与 tag core 一致。
3. **发布政策记录校验**：从 `origin/release-meta`（本机双远端）读取 `build-policy.json`；缺失、schema 非法、双远端不一致 → fail-closed；tag 不在 `legacyTags` 中（新 tag 不得落入 legacy 白名单），且 `build > watermark`。
4. **已发布状态判定**（在 build 单调校验之前，保证重跑幂等）：
   - 若插件与 carrier 都已在 npm 可见：跳过发布，执行只读验证后成功退出；
   - 若 carrier 已发布但插件未发布（部分恢复）：允许继续，但 build 校验必须使用「排除自身 carrier 版本后的已发布最大值」；
   - 若两者均未发布（新发布）：build 校验使用发布前沿（新 carrier appVersion 与 legacyCarriers appBuild 的较大者）。
5. **build 校验（新规则）**：
   - 必须 `build > release-meta 的 watermark`；tag 不在 `legacyTags` 中；
   - 新发布：`build > 发布前沿`（发布前沿 = 新 carrier appVersion 最大值与 legacyCarriers appBuild 最大值的较大者）；
   - 部分恢复：`build > max(排除自身 carrier 后的发布前沿)`；
   - **不再要求** `build > 所有 tag 的 build 最大值`：tag 集合只在分配端用于避免复用，不作为 CI 合法性判据。这样 A（build 33）先打 tag、B（build 34）后打 tag 但尚未发布时，A 的首次 CI/恢复不会被 B 阻断；若 B 先发布，A 之后再发布会因 33 < 34 被拒绝（这是正确的过期发布拒绝，避免降级）。
   - npm 元数据（versions/appVersion）读取失败或超时 → fail-closed（稳定 reason，如 `build-frontier-unavailable`）。
6. **构建产物一致性**：沿用 `package-release.sh` 的清单/载体预检，确保 APK 实际 versionCode、carrier `appVersion`、pubspec `+N` 三者一致，并补充显式断言与稳定 reason。
7. **dist-tag 规则**：
   - alpha → 插件 `alpha` tag，carrier 按 §6.1 处理 `app`；
   - rc → 插件 `rc` tag，carrier 按 §6.1 处理 `app`；
   - stable → 插件 `latest` tag，carrier 按 §6.1 处理 `app`；
   - **`latest` 只在 stable 发布时前进**；alpha/rc 不得移动 `latest`（迁移期语义见 §6.2）。
8. **未知/延迟可见状态**：发布请求提交后若无法确认最终可见性，按 §5.5 进入 `unknown`，不得当作“确定未发布”继续发布。
9. **并发/幂等**：workflow 全局 concurrency 只保证同一时刻一个发布任务，不是“分配→推 tag→CI 完成”的全流程锁；本设计不依赖它证明单调性，单调性由 §5.2 的已发布前沿校验和 §5.1 的分配规则保证。

### 5.3 为什么能去掉冻结，以及同 core 限制

- 每条 tag 的 build 在**分配时**取 `release-meta watermark / 历史 tag / 新 carrier appVersion / legacyCarriers appBuild` 的最大值 +1；发布时 CI 再校验「大于已发布前沿」。因此 **发布顺序 = build 递增顺序**；后发布的 tag 一定比先发布的大。
- alpha/rc 交替发布时，只要每次都从最新发布前沿分配，就不会降级；tag 创建先后不必严格对齐（A/B 排队场景见 §5.2）。
- 但 App 内更新判定是先 core 后 build（`update_core.dart`）。因此：
  - **同 core**（如 `3.2.4-alpha.N` ↔ `3.2.4-rc.N`）可用本方案交错，App 更新器按 build 正常工作；
  - **跨 core**（如 develop 已 bump 到 `3.2.5-alpha.N`，release 仍是 `3.2.4-rc.N`）不在本期保证范围；需要人工安装/卸载，或另立设计改造更新判定。
  - 因此 RC 期间建议 develop 保持同 core（见 §7、§12）。

### 5.4 并发与恢复语义

- 仓库约定「发布执行者全局唯一」；tag 创建仍应串行并在创建前重新 fetch `release-meta` 与 tags，避免使用过期水位；存在未关闭的发布意图（unknown/submitted）时不得开始新分配。
- 若两个 tag 几乎同时创建：它们可能拿到相同 `next`；先发布者成功，后发布者因 `build > 已发布前沿` 不成立而失败，必须重新 bump，**绝不覆盖已发布版本**。
- 部分发布恢复：按 §5.2 第 3 步区分「自身已发布 carrier」与「其它已发布版本」，只允许完成自己的发布会话，不允许借恢复把通道回退到更旧版本。
- 如果 tag 已创建但因 CI 失败未发布：只有确认**从未提交任何 publish 请求**（无发布意图/无 unknown 状态）时，才可删除 tag（授权后）重新分配；若已部分发布或存在未确认发布，按恢复流程完成或人工处置，不得失而复用。

### 5.5 未确认发布（unknown/staged）

- 仅凭 npm 可见版本集合**无法区分**「从未提交」与「提交后结果未知」：publish 请求可能已被 registry 接受，但可见性轮询超时/job 退出，之后才变为可见。
- 每次发布在提交前，先把**发布意图**写入 `release-meta`（tag、plugin/carrier 版本、build、期望 integrity、状态 `submitted`）；确认 npm 可见后再标记 `published` 并清除未确认状态。
- 若 publish 请求可能已提交但无法确认最终状态（含 E409/staged、可见性轮询超时、响应丢失）：状态置 `unknown`；**在人工确认前阻断后续发布/通道移动**，不得把超时当作“确定未发布”，也不得删除 tag 重新分配。
- 人工恢复：先查询 registry 的最终版本/可见性，再把意图标为 `published`（完成）或 `failed`（确认未接受，可重新分配）；恢复记录保留在 `release-meta`。迟到可见的版本即使后来出现，也不得覆盖已分配/已发布的更高 build。
- 该规则同时覆盖插件与 carrier 的 dist-tag 写入；同一发布意图未关闭时，不得开始下一个 build 分配。

## 6. dist-tag 与更新链路

### 6.1 app dist-tag：先比较后移动

现状缺陷（已评审确认）：workflow 在 `Publish carrier (app tag)` 步骤无条件 `npm publish <carrier> --tag app`，之后才读取 `current_app` 与候选比较；此时 app 已经指向候选，比较结果必然 `keep`，因此 `rc/stable → alpha` 会把 app 回退。alpha 与 rc 交错发布正好稳定触发。

修正流程：

1. 发布 carrier **之前**读取当前 `dist-tags.app`；
2. 若候选 carrier 的**配对插件版本**（剥离末尾 `-app` 后的 `X.Y.Z[-pre]`）SemVer **大于**当前 `app` 所指向 carrier 的配对插件版本（或当前不存在），允许移动：`npm publish ... --tag app`；**禁止直接比较裸 carrier 字符串**（例如 `3.2.4-app` 与 `3.2.4-rc.1-app`、`3.2.4-alpha.10-app` 与 `3.2.4-alpha.9-app`，裸比较会误判 keep）。现有 workflow 已先剥离后缀，修订实现必须保留该比较域。
3. 若候选不大于当前值：使用临时 tag 发布（如 `--tag app-staging`），**不移动 `app`**；发布可见后可清理临时 tag（清理失败仅告警，不影响精确版本解析）；
4. 发布后断言：允许移动时 `app == 本次 carrier`；不允许移动时 `app` 保持原值；违反则 fail；
5. 重跑/部分恢复：若 carrier 已发布，跳过 republish，只做同样的指针比较（只前进不回退），再进入插件发布/通道 tag 步骤。
6. 已知边界：若当前 `app` 指向非 carrier（异常历史），不自动移动，记稳定 reason 并要求人工处理。

### 6.2 latest dist-tag 与迁移（已确认）

- 已确认：**只有 stable 发布可前进 `latest`**；alpha/rc 只更新自身通道（与 ADR 0024 及 `docs/10-release.md` 既有约定一致）。
- 当前 npm 实际状态（评审时只读查询）：
  ```text
  latest = 3.2.3-rc.1
  alpha  = 3.2.3-alpha.1
  rc     = 3.2.3-rc.1
  app    = 3.2.3-rc.1-app
  无 X.Y.Z 稳定主插件版本
  ```
  因此「stable-only」落地后，`latest` 不会立即变成稳定版，而是停留在 `3.2.3-rc.1` 直到首个 stable 发布。
- 过渡期不变量（已确认）：
  1. 预发布发布前后 `latest` 必须保持不变；
  2. `latest` 允许在 bootstrap 阶段是 prerelease，但首个 stable 发布后必须指向 stable；
  3. 不为满足规则自动发布 stable、不删除/改名历史版本；首个 stable 走正常 release 流程并需授权。

### 6.3 更新器配对（补充说明）

- 插件更新通道由本机插件版本的 prerelease 段决定（alpha/rc/latest）；候选插件后，carrier 用精确 `${candidate}-app` 配对，App 版本取自 carrier 清单。因此 `app`/`latest` 指针不影响 alpha 设备拿到自己的精确 carrier。
- 跨 core 切换的限制见 §2/§5.3；本期不承诺应用内跨 core 更新。

## 7. release 生命周期（cherry-pick 模型）

1. develop 持续 alpha tag 实机验证（建议 RC 期间保持与 release 相同的 core，例如 develop 继续 `3.2.4-alpha.N`）。
2. 决定发版时，从 develop 的某个 **CI 全绿且已实机验证的提交**（优先 alpha tag commit）切 `release/vX.Y.Z`。
3. release 分支 bump 到 `X.Y.Z-rc.1`，build 用全局下一个值；冻结新功能。
4. develop 上发现的问题：先修 develop，再 cherry-pick 到 release（release 只接受本版本修复）。
5. release 上的修复：cherry-pick 回 develop，保持两边一致；**禁止 merge develop 到 release**（避免把未计划的新功能带进冻结线）。
6. rc 通过后发布 stable；stable 后 develop 可以进入下一 core，但跨 core 的设备更新需人工安装（见 §2/§5.3）。
7. 发布 stable 后，下一轮 alpha 从新 core 开始；`latest` 在 stable 发布时前进。

## 8. 操作流程（alpha 实机测试）

```bash
# 1) 准备：develop 干净、CI 绿，双远端 tag 与 release-meta 同步拉取（--multiple，不是两个位置参数）
git switch develop && git pull --ff-only origin develop
git fetch --multiple origin github
git fetch --multiple --tags origin github

# 2) 计算全局下一个 build（只读；输出 next 与来源）
node tools/next-build.mjs

# 3) 原子 bump（同时改主包 version + 精确 carrier alias + pubspec + CHANGELOG 骨架）
node tools/prepare-release.mjs --version 3.2.4-alpha.N --build <next>
git diff --check

# 4) 本地门禁（flutter analyze/test + 相关 node tests + 发布预检）
# 5) 提交 bump
# 6) 打 annotated tag 并推送（需用户授权）
git tag -a v3.2.4-alpha.N -m "Release v3.2.4-alpha.N"
git push origin develop && git push github develop
git push origin v3.2.4-alpha.N && git push github v3.2.4-alpha.N
# 7) 等待 workflow 发布 alpha 通道 + carrier；手机切 alpha 通道实机测试
```

> `prepare-release.mjs` 必须校验：`package.json.version`、精确 carrier alias、pubspec core/build、CHANGELOG 条目、npm 上版本未占用；任一步失败则不留下半更新（写临时文件/失败回滚或只在全部校验后一次性写入）。

## 9. 失败与回滚

| 场景 | 处理 |
|---|---|
| 打 tag 后 CI 发现 build 不大于已发布前沿 | 不发布；只有确认从未提交 publish 请求（无发布意图/unknown）时，才可删除未发布 tag（授权后）并重新分配 |
| 首个 tag 尚在排队，后续 tag 已发布导致旧 tag 过期 | 旧 tag 不发布（fail-closed），重新分配；不覆盖已发布版本 |
| 部分发布（carrier 已发、插件未发） | 只允许完成自身会话；若已有更新版本发布，拒绝恢复，重新分配 |
| 版本已发布但发现阻断问题 | 发下一个 alpha/rc/stable 版本；禁止覆盖/复用已发布版本 |
| tag 打错分支/提交 | 删除未发布 tag 并重打；已发布版本只能新版本修正 |
| 跨通道/跨 core 回退到更小 build | 文档要求卸载重装或人工安装；不做特殊支持 |
| app tag 指针异常/非 carrier | 不自动移动，记录稳定 reason，人工处理 |
| 提交后可见性未知（unknown/staged） | 阻断后续发布；查询 registry 最终状态后标记 published/failed，人工恢复；不得删除 tag 重新分配 |

## 10. 实现范围（评审通过后）

1. 受保护的 `release-meta` 分支与 `build-policy.json`（watermark、legacyTags、legacyCarriers）；分配端与 CI 的读取/校验逻辑；水位只升不降。
2. `tools/next-build.mjs`（只读分配；正确双 remote fetch；npm 已发布 carrier appVersion 查询；legacyCarriers 纳入前沿；release-meta 双远端一致性；稳定 reason）。
3. `tools/prepare-release.mjs`（原子 bump：package version + exact alias + pubspec + CHANGELOG + 预检；不负责 tag/push）。
4. 发布意图/unknown 状态记录（`release-meta` 内）与阻断/恢复逻辑。
5. `publish-npm.yml`：
   - 按 §4.2 拆分 alpha / rc / stable 的可达 ref 与 core 校验；
   - §5.2 的发布政策记录、已发布状态判定、build 前沿校验与幂等恢复顺序；
   - §5.5 未确认发布的阻断/恢复；
   - §6.1 app tag 先比较后移动（比较配对插件版本）；
   - §6.2 latest 仅 stable 前进；
   - 保持既有 carrier 精确配对、签名/产物校验、全局 concurrency。
6. `docs/10-release.md`：alpha-on-develop、全局 build 分配、迁移水位、cherry-pick 规则、app/latest 规则、跨 core 限制；删除「tag 只打 release」「RC 冻结」等旧表述。
7. `AGENT-RULES.md`「发布」一节同步（本文件不随仓库推送）。
8. 相关 workflow 策略测试与工具测试；真实旧 carrier fixture 与 mock registry 故障注入；本地 tag 序列 dry-run，不写公共 npm。

## 11. 测试决策

### 11.1 分配与迁移

- `release-meta`/`build-policy.json`/watermark 缺失、非法或双远端不一致 → fail-closed，不隐式从 0 开始。
- 历史重复 build（24/24、26/26、27/27）且 tag 在 `legacyTags`：新分配仍从 watermark（32）之后开始；历史 tag 不被重写。
- 未打 tag 的 build 高于 tag 最大值（如 develop 32 vs tag max 28）：next 必须 > 32。
- 已发布 carrier appVersion 高于 watermark：next 必须 > 该值。
- 3 个真实旧格式 carrier（缺顶层 appVersion）经 integrity 校验并登记 legacyCarriers 后参与前沿；未登记的新 carrier 缺字段 → fail-closed；已登记 carrier integrity 不符 → fail-closed。
- 双远端同名 tag 不同 SHA → fail-closed；`git fetch --multiple --tags origin github` 成功路径。
- `release-meta` 缺失/schema 非法/双远端不一致 → fail-closed；分支内旧 watermark 快照不得作为权威；只在 develop 抬水位、release 仍读旧快照的场景必须被 CI 拒绝（应读 release-meta 的 40，分配出 ≥41）。
- npm 元数据/registry 可用性读取失败或超时 → fail-closed。

### 11.2 发布与恢复

- A（build 33）打 tag 后、B（34）打 tag 但未发布：A 首次 CI/恢复可正常发布；B 后发布（34>33）成功。
- B 先发布、A 后发布：A 因 33 < 已发布前沿 34 被拒绝（过期拒绝）。
- A 部分发布（carrier 33 已发布，plugin 未发布）后恢复：排除自身 carrier 后仍大于前沿 → 完成；若 B 34 已发布 → 拒绝。
- 插件与 carrier 均已发布的重跑：在 build 校验之前幂等跳过（旧 alpha.1 在 alpha.2 已发布后重跑不得要求当前 channel 仍等于 alpha.1，也不得重新指回旧版）。
- app tag：rc→alpha、stable→alpha、不同 core 的候选都不能把 app 回退；`3.2.4-app` vs `3.2.4-rc.1-app`、`3.2.4-alpha.10-app` vs `3.2.4-alpha.9-app` 必须在剥离 `-app` 后比较配对插件版本；允许前进时发布后 app == 候选；重跑同一判断。
- 未确认发布：mock registry“请求已接受但延迟可见/响应丢失”时进入 unknown，阻断后续发布；人工确认后 published/failed 恢复；unknown 期间不得删除 tag 重新分配。
- latest：alpha/rc 发布前后 latest 不变；stable 发布后 latest == stable（迁移期例外见 §6.2）。
- exact alias：bump 后 `exactCarrierAliasChecks` 全 PASS；APK versionCode / carrier appVersion / pubspec build 三者一致。

### 11.3 分支与更新限制

- 祖先/core：alpha 提交不可达于 develop → 拒绝；rc/stable 提交不可达于对应 `release/v<core>` → 拒绝；release 分支 core 与 tag core 不一致 → 拒绝（负向测试断言“不在允许集合”）。
- 同 core：`3.2.4-alpha.N` ↔ `3.2.4-rc.N` 的 App 更新器判定按 build 单调。
- 跨 core：明确记录 `update_core` 的 `remoteOlder`/降级限制，不作为本期验收承诺；人工安装流程文档化。

## 12. 迁移水位与历史兼容（评审 #2）

- 历史 tag 实测（2026-11-02）：
  ```text
  v3.2.1-alpha.1  3.2.1+24
  v3.2.1-alpha.2  3.2.1+24
  v3.2.1-alpha.3  3.2.1+25
  v3.2.1-rc.1     3.2.1+26
  v3.2.2-alpha.1  3.2.2+26
  v3.2.2-rc.1     3.2.2+27
  v3.2.3-alpha.1  3.2.3+27
  v3.2.3-rc.1     3.2.3+28
  ```
  tag 最大 build = 28；develop 已是 32；npm 当前 `latest=3.2.3-rc.1`、无稳定版。
- **旧 carrier 元数据实测**：8 个已发布 carrier 中 3 个（3.2.1-alpha.1/2/3-app）没有顶层 `appVersion`；其余 5 个已知最大 build=28。旧格式是合法历史，不能按新字段缺失直接拒绝，也不能静默跳过。
- 迁移动作：
  1. 创建受保护分支 `release-meta`，写入 `build-policy.json` 初始种子：watermark = **32**（取 develop 当前 build；迁移前人工核对是否有更高 build 的已安装/未打 tag 构建，必要时上调）；`legacyTags` 列出现存 8 个 tag；`legacyCarriers` 对 8 个已发布 carrier 逐一登记。
  2. 3 个缺 `appVersion` 的旧 carrier：下载对应 tarball，校验 `dist.integrity`，读取内嵌 `manifest.json` 或 APK 的实际 App build，记录精确 `{version, integrity, appBuild}`；保留核验证据。其余 5 个 carrier 同样登记 `appVersion` build 与 integrity。
  3. 把 `release-meta` 推到 `origin` 与 `github`，确认两端内容一致；分配端与 CI 只读该权威记录；分支内的副本不作为依据。
  4. `next-build` 首次运行应输出 33（或更高，若 npm/设备存在更高 build）。
  5. 不重写、不移动、不删除任何历史 tag；不改变已发布 carrier 内容。
- 迁移验证：用隔离临时仓库 + 真实旧 carrier fixture（含 3 个缺 `appVersion` 的样例）跑 `next-build` 与 workflow 策略测试；验证未登记 carrier 缺字段/已登记 integrity 不符都 fail-closed；不对真实 npm 写入。

## 13. 已确认决策（2026-11-02）

用户已确认以下全部决策，本设计进入实现阶段：

1. **build 分配**：采用 `max(迁移水位, 历史 tag build, 已发布新 carrier appVersion build, legacyCarriers appBuild) + 1`；CI 只校验「大于发布前沿」，不校验全量 tag 最大值。✅
2. **迁移水位**：`watermark = 32`（develop 当前 build），维护在受保护 `release-meta` 的 `build-policy.json`；迁移前人工核对已安装设备/未打 tag 构建，若有更高 build 则上调；历史 8 个 tag 进入 `legacyTags`，3 个缺 `appVersion` 的旧 carrier 经核验进入 `legacyCarriers`。✅
3. **latest 语义**：仅 stable 前进 `latest`；过渡期允许 `latest` 暂为 `3.2.3-rc.1`，首个 stable 发布后必须指向 stable，且不为满足规则自动发布 stable。✅
4. **RC 期间 core**：develop 保持与 release 相同 core（如 `3.2.4-alpha.N` ↔ `3.2.4-rc.N`）；跨 core 更新走人工安装，不作为更新器端到端承诺。✅
5. **alpha 频率/CHANGELOG**：按需打 alpha tag；每个 alpha tag 写简版 CHANGELOG 条目。✅
6. **app tag**：先比较后移动、不可回退；`app` 指向非 carrier 等异常历史不自动修复，转人工处理。✅
7. **rev.3 评审补充（不改变已确认政策，均为正确性要求）**：旧 carrier 缺 `appVersion` 时只能通过 `legacyCarriers` 已核验映射进入前沿；watermark/白名单/发布意图以受保护 `release-meta` 为全局权威，分支内快照无效；提交后状态未知时必须阻断后续发布并人工恢复；app 指针比较必须使用配对插件版本（剥离 `-app`）。
