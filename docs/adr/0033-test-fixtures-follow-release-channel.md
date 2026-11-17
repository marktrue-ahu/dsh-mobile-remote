# 0033 测试夹具按发布通道推导，不硬编码 alpha

状态：已接受（2026-11-17），实现追踪 GitLab #114 后续修复；随 `3.2.4-rc.1` 的发布阻塞修复落地。关联：ADR 0030（release-meta 单远端）、`docs/10-release.md` §2（发版前门禁）。

## 背景

`3.2.4-rc.1` 首次推送 tag 后 CI 失败，阻塞在 `Run Node and Flutter tests in parallel`：**tests 1211 / pass 1195 / fail 3**。三条失败全部是测试夹具对「本地版本必须是 alpha」的耦合：

| 测试 | 失败信息 |
|---|---|
| `宿主管理器通道：capabilities 报 host-manager…` | `Error: local version is not alpha: 3.2.4-rc.1` |
| `宿主管理器通道：提交走 runHostUpdate…` | 同上 |
| `#96 review handler：慢 npm 下…` | `bootstrap+force 应只跑 dist-tags+plugin+carrier 共 3 次，实际 1` |

根因两处：

1. `test/host-manager-channel.test.mjs` 的 `nextAlpha()` 用正则 `^(.*-alpha\.)(\d+)$` 硬编码 alpha，非 alpha 版本直接 `throw`；
2. `test/plugin-update-check-routes.test.mjs` 的假 npm 在 `dist-tags` 里只声明 `alpha`，而 `3.2.4-rc.1` 经 `lib/npm-update-source.js` 的 `npmUpdateChannel()` 正确解析为 **`rc`** 通道，取不到标签 → `npm-channel-version-missing` → 只出网 1 次。

**产品代码完全正确**：`npmUpdateChannel()` 已支持三种通道（`alpha.N`→alpha、`rc.N`→rc、无 prerelease→latest）。问题只在测试夹具。

### 为什么潜伏了 11 天

| 事件 | 时间 |
|---|---|
| `v3.2.3-rc.1` 发布 | 2026-11-02 |
| `host-manager-channel.test.mjs` 引入 | 2026-11-07 |
| `plugin-update-check-routes.test.mjs` 引入 | 2026-11-13 |
| `3.2.4-rc.1` 首次触发 | 2026-11-17 |

两个测试引入时，`3.2.3-rc.1` 早已发布（`git cat-file -e v3.2.3-rc.1:test/host-manager-channel.test.mjs` → 不存在）。此后 develop 一直跑 alpha（`3.2.4-alpha.N`），而 alpha 版本号恰好匹配两个硬编码假设 —— **CI 全绿，缺陷被版本号掩盖**。

同一时期本机发版门禁**漏了 `node --test test/*.mjs`**（`AGENT-RULES.md` 的门禁表只有 5 条，而 `docs/10-release.md:119` 一直要求包含它），所以发版前也查不出来。

## 决策

### 1. 测试夹具按「本地版本的实际通道」推导

`nextCandidate(version)` 按 SemVer 解析后分三支：

| 本地版本 | 通道 | 下一个候选 |
|---|---|---|
| `X.Y.Z-alpha.N` | `alpha` | `X.Y.Z-alpha.(N+1)` |
| `X.Y.Z-rc.N` | `rc` | `X.Y.Z-rc.(N+1)` |
| `X.Y.Z`（稳定） | `latest` | 下一个补丁版本 |

与产品侧 `npmUpdateChannel()` 同口径。**不假设任何具体通道。**

假 npm 的 `dist-tags` 按实际通道声明，不固定为 `alpha`。

### 2. 发版门禁补入 `node --test test/*.mjs`

`AGENT-RULES.md` 的「开发分支门禁（发布前必跑）」从 5 条补为 **6 条**，并在表下写明本次教训：

> 这条门禁在**非 alpha 版本**下尤其关键：alpha 版本号会掩盖「通道硬编码」类缺陷，只有 rc/stable 才暴露。

### 3. 判读方式：按「与基线同集合」而非「0 fail」

本机 root 环境下全量 node 套件有 **4 项固定失败**（chmod 0500 仍可写 ×2、canary 要求 `uid>0`、aapt 降级），与本次改动无关，在 CI 的 `uid=1000` 环境下不出现。

因此发版门禁对该套件的判据是：**失败集合与 alpha 基线完全一致 → 通过；出现新增失败 → 阻断**。

实测三种通道的失败集合完全一致：

| 通道 | 结果 |
|---|---|
| `3.2.4-alpha.21` | 1211 / 1190 pass / 4 fail / 17 skip |
| `3.2.4-rc.1` | 1211 / 1190 pass / 4 fail / 17 skip |
| `3.2.4`（stable） | 1211 / 1190 pass / 4 fail / 17 skip |

## 后果

### 收益

- **rc / stable 发布不再被假失败阻塞**。这原本会阻塞所有非 alpha 发布（包括 `3.2.1` / `3.2.2` / `3.2.3` 将来要发的 stable）。
- 测试夹具与产品逻辑同口径，不再各自维护一套通道假设。
- 发版门禁补全后，同类「只在特定版本通道下失败」的缺陷能在本机发现，不必等 CI。

### 代价与约束

- **测试夹具不得硬编码版本通道**。新增涉及版本的测试时，必须从 `package.json` 的 `version` 推导通道，或用显式参数注入。
- **`node --test test/*.mjs` 是发版前必跑项**，不可因「本机 root 有 4 项固定失败」而跳过；应按同集合判读。
- 4 项 root 环境失败的**根治**需要非 root 运行环境或改这些测试的环境依赖设计，属独立议题，本决策不涉及。

### 不受影响

- `lib/npm-update-source.js` 的 `npmUpdateChannel()` 行为不变；
- 发布流程、tag 政策、dist-tag 反回退规则不变；
- 4 项 root 环境失败保持原样（不通过改测试掩盖）。

## 未采纳的替代方案

**只让 rc 能过（正则放宽到 `alpha|rc`）**：能解本次阻塞，但 stable 发布（`3.2.4`，无 prerelease）仍会抛 `local version is not alpha: 3.2.4`，且假 npm 仍缺 `latest` 标签。选择按通道通用化，一次解决三类版本。

**把 4 项 root 环境失败加 skip**：会让这些测试在真实 Linux 用户环境（非 root）下永不执行，失去覆盖。选择保持原样、按同集合判读。

**改产品代码去适配测试**：产品逻辑是对的，改它是本末倒置。

## 验证

- 修复在 develop（`6d8f9c6`）与 `release/v3.2.4`（`20b5773`，cherry-pick）内容一致；
- **rc 场景**（release 分支，版本 `3.2.4-rc.1`）：两个目标测试文件 3/3 通过；
- **stable 场景**（临时把 `package.json` 版本改为 `3.2.4`）：3/3 通过，测完已还原（工作树 `git status` 为空）；
- **alpha 场景**（develop 基线）：3/3 通过；
- 全量三通道对照见上表，失败集合 IDENTICAL；
- `3.2.4-rc.1` CI run `44105583685` **success**（21m16s），此前失败的三条测试全绿。
