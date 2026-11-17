# 0030 release-meta 单远端策略（GitHub 为唯一权威）

状态：已接受（2026-11-17）。关联：ADR 0025（develop alpha tag 与全局 build）、issue #43（发布政策）、#113（工具链清理）。本 ADR 修订 `docs/design/alpha-release-global-build.md` rev.3 中「双远端必须逐字节一致」的约束。

## 背景

发布政策记录在受保护分支 `release-meta` 的 `build-policy.json`（迁移水位、legacyTags、legacyCarriers、发布意图）。ADR 0025 确立「全局单调 build」时，规定本机分配端与 CI **都必须校验 `origin` + `github` 两个远端的 `release-meta` 逐字节一致**，任一缺失或不一致即 fail-closed。

该约束在 WSL 时代成本可接受：两个远端都是开发者显式推送的目标。但迁移到容器环境后，`origin`（GitLab，内网镜像）与 `github`（PR 与 CI 源）分属不同网络路径，`release-meta` 的写入方只有 CI 一处——**GitLab 侧那份永远是「需要人工同步的副本」**，从未成为权威。

2026-11-17 发布 `3.2.4-alpha.21` 后暴露了具体代价：CI 把 `github/release-meta` 推进到 `290cdee`（含 alpha.21 的 submitted + published 意图），而 `origin/release-meta` 停在 `33d0a24`（alpha.20）。此时：

- 本机跑 `node tools/next-build.mjs` **直接 FAIL**（`release-meta-diverged`），阻断下一次发版；
- 两份 `build-policy.json` 的 `watermark` 都是 32，但 `intents` 分别是 20 条与 21 条 —— 差异正是最新一次发布记录；
- 按旧文档 `git show origin/release-meta:build-policy.json` 查发布意图，会读到**过期快照**，误判为「没有未关闭意图」。本机的 `origin` 是 GitLab，不是 CI 眼中的 origin。

## 决策

### 1. `release-meta` 只在 GitHub 保留

`github/release-meta` 是**唯一权威**。不要求 GitLab `origin` 存在同名分支，也不要求两者一致。

CI 侧本就支持该形态：`publish-npm.yml` 只在显式配置 `vars.RELEASE_META_SECONDARY_REMOTE_URL` 时才校验第二个远端；未配置时只以 `origin`（GitHub）为权威。本仓库不配置该变量。

### 2. 本机分配端用 `--remotes github`

`tools/next-build.mjs` **保持默认双远端**（该默认值仍是有效的 fail-closed 保护，用于显式配置了第二远端的场景），调用时显式传参：

```bash
node tools/next-build.mjs --remotes github
```

**不带该参数会以 `release-meta-diverged` fail-closed**，这是预期的安全行为，不是缺陷。

### 3. 单远端仅限 `release-meta` 一个分支

`main`、`develop`、`release/*`、`hotfix/*` 以及所有 tag **继续推双远端**。GitLab 侧仍是完整代码镜像；放弃同步的只有发布政策记录这一个分支。

## 后果

### 收益

- 消除一次每次发版都要做、且容易遗忘的人工同步步骤；
- 消除「读到过期快照误判发布意图」这类陷阱；
- `next-build` 的失败原因更可读：只有真正缺失/非法才 fail，不再因副本落后而 fail。

### 代价与约束

- **本机所有 `next-build` 调用必须带 `--remotes github`**。已更新 `AGENT-RULES.md`（新增「release-meta 单远端策略」节）、`docs/10-release.md`（§1.4/§1.5/§2/§3/§4.2/§8.1/§9/§10/§12）、`docs/06-install-run.md`、`CONTRIBUTING.md`、`publish-npm.yml` 注释（仅注释，未改逻辑）。
- **GitLab 上可能残留历史 `release-meta`**。它是历史快照，**不是权威**；不要用同步它来「修复」发布状态。需要核验时一律读 `github/release-meta`。
- 若将来重新启用第二远端（例如加一处异地镜像），必须同时配置 `RELEASE_META_SECONDARY_REMOTE_URL` 并去掉 `--remotes github`，两者要一起改，不能只改一侧。

### 不受影响

- `release-meta` 仍是**受保护分支**，仍只接受发布执行者经授权的提交；
- 水位只升不降、白名单只增不删；
- CI 的发布意图写入、`unknown` 恢复、`leftover-intent` 处理、先载体后插件、指针反回退等全部政策不变；
- 已发布 tag 的不可变性不变。

## 验证

- `node tools/next-build.mjs --remotes github` → `RESULT: PASS`，next build 54（`github=290cdee`，watermark 32，historical 53，frontier 52）；
- `node tools/next-build.mjs`（默认）→ `RESULT: FAIL (release-meta-diverged)`，符合上述决策 2 的预期；
- `node --test test/next-build.test.mjs` → 13/13 pass（测试覆盖「双远端分歧时 fail-closed」的能力，与默认使用哪个远端无关，故未改动）；
- `node --test test/publish-workflow-policy.test.mjs` → 15/15 pass（该套件直读 `publish-npm.yml` 做契约断言，证明只改注释未破坏契约）。

## 未采纳的替代方案

**把 `next-build` 的默认值改成 `["github"]`**：能让所有旧文档的写法直接可用，但会让「显式配置第二远端」场景失去默认保护，且与 `publish-npm.yml` 的注释及 `docs/design/alpha-release-global-build.md` 的设计记录冲突。选择保留默认值、在调用侧显式传参，把决策点留在调用处。

**删除 `origin/release-meta` 分支**：本机 `origin` 是内网 GitLab，删除分支是不可逆的对外操作；且历史快照对排查旧发布仍有价值。选择保留但明确其非权威地位。
