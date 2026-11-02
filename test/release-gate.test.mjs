// `tools/release-gate.mjs` CI 门禁测试（issue #43 / 设计稿 §5.2、§6、§11.2）。
//
// 夹具仓库 + 假 npm 适配器：覆盖已发布状态判定顺序、build 前沿、A/B 排队、
// 部分恢复、旧 tag 重跑、app/latest 决策、release intent 与 unknown 阻断。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	FAKE_ADAPTERS,
	HISTORICAL_CARRIERS,
	PACKAGE_NAME,
	buildPolicySeed,
	fixtureIntegrity,
	writeFakeState,
} from "./helpers/release-fixtures.mjs";
import { createAdapters } from "./helpers/fake-release-adapters.mjs";
import { gatePrepare } from "../tools/release-gate.mjs";
import { serializeBuildPolicy } from "../tools/lib/release-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "tools", "release-gate.mjs");
const RELEASE_CHECKS = path.join(ROOT, "dsh-mobile-app", "tools", "lib", "release-checks.mjs");

function makeGateFixture(t, {
	pluginVersion = "3.2.4-alpha.2",
	build = 33,
	carriers = [],
	pluginVisible = false,
	carrierVisible = false,
	distTags = { latest: "3.2.3-rc.1", alpha: "3.2.3-alpha.1", app: "3.2.3-rc.1-app" },
	intents = [],
	policy = null,
} = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-release-gate-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "repo");
	fs.mkdirSync(path.join(root, "dsh-mobile-app", "tools", "lib"), { recursive: true });
	fs.copyFileSync(RELEASE_CHECKS, path.join(root, "dsh-mobile-app", "tools", "lib", "release-checks.mjs"));
	const core = pluginVersion.split("-")[0];
	const packageJson = {
		name: PACKAGE_NAME,
		version: pluginVersion,
		optionalDependencies: { [`${PACKAGE_NAME}-app`]: `npm:${PACKAGE_NAME}@${pluginVersion}-app` },
	};
	fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	fs.writeFileSync(path.join(root, "dsh-mobile-app", "pubspec.yaml"), `name: dsh_mobile_app\nversion: ${core}+${build}\n`);

	const policySeed = policy ?? buildPolicySeed({ intents });
	const policyFile = path.join(dir, "build-policy.json");
	fs.writeFileSync(policyFile, serializeBuildPolicy(policySeed));

	// 已发布 carrier（历史 + 本次夹具追加；同 version 的夹具条目覆盖历史条目）。
	const carrierByVersion = new Map(HISTORICAL_CARRIERS.map((carrier) => [carrier.version, {
		version: carrier.version,
		appVersion: carrier.legacy ? null : `${carrier.version.slice(0, -4).split("-")[0]}+${carrier.appBuild}`,
		integrity: carrier.integrity,
	}]));
	for (const carrier of carriers) carrierByVersion.set(carrier.version, { ...carrier });
	const allCarriers = [...carrierByVersion.values()];
	const versions = allCarriers.map((carrier) => carrier.version);
	if (pluginVisible) versions.push(pluginVersion);
	if (carrierVisible && !versions.includes(`${pluginVersion}-app`)) versions.push(`${pluginVersion}-app`);
	const metadata = {};
	for (const carrier of allCarriers) {
		metadata[carrier.version] = {
			version: carrier.version,
			appVersion: carrier.appVersion ?? undefined,
			dist: { integrity: carrier.integrity },
		};
	}
	const state = {
		releaseMeta: null,
		tags: [],
		tagFiles: {},
		remoteTags: {},
		npm: { versions, metadata, distTags, tarballs: {} },
	};
	const stateFile = writeFakeState(dir, state);
	const adapters = createAdapters({ env: { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile } });
	return { dir, root, policyFile, stateFile, adapters, policy: policySeed };
}

function prepare(fixture, tag, extra = {}) {
	return gatePrepare({ adapters: fixture.adapters, root: fixture.root, tag, policy: fixture.policyFile, ...extra });
}

function codes(result) {
	return (result.reasons ?? []).map((item) => item.code);
}

// ── 已发布状态判定顺序 ─────────────────────────────────────────────────────────────

test("gate prepare: fresh publish requires build > watermark and > published frontier", async (t) => {
	const fixture = makeGateFixture(t);
	const result = await prepare(fixture, "v3.2.4-alpha.2");
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.state, "fresh");
	assert.equal(result.watermark, 32);
	assert.equal(result.frontier, 28);
	assert.equal(result.build, 33);
	assert.equal(result.appDecision, "move");
	assert.equal(result.latestDecision, "keep");
});

test("gate prepare: stale build below watermark/frontier rejected without publishing", async (t) => {
	const belowWatermark = makeGateFixture(t, { build: 32 });
	const result = await prepare(belowWatermark, "v3.2.4-alpha.2");
	assert.equal(result.ok, false);
	assert.ok(codes(result).includes("build-not-above-watermark"));

	const belowFrontier = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.10",
		carriers: [{ version: "3.2.4-alpha.9-app", appVersion: "3.2.4+34", integrity: fixtureIntegrity("frontier") }],
	});
	const frontierResult = await prepare(belowFrontier, "v3.2.4-alpha.10");
	// 本次 build 33 < 已发布前沿 34（B 先发布，A 后发布 → 过期拒绝）。
	assert.equal(frontierResult.ok, false);
	assert.ok(codes(frontierResult).includes("build-not-above-published-frontier"));
});

test("gate prepare: fully-published old tag rerun is idempotent read-only (no channel equality, no rollback)", async (t) => {
	// alpha.2 已发布后重跑 alpha.1：alpha 通道现在指向 alpha.2，app 也指向 alpha.2-app。
	const fixture = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.1",
		build: 33,
		carriers: [{ version: "3.2.4-alpha.1-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("alpha1") }],
		pluginVisible: true,
		carrierVisible: true,
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.2", app: "3.2.4-alpha.2-app" },
	});
	const result = await prepare(fixture, "v3.2.4-alpha.1");
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.state, "fully-published");
	// 完全发布的重跑：即使 build 不高于当前 frontier 也必须只读成功（build 校验被跳过）。
	assert.equal(result.appDecision, "keep");
	assert.equal(result.latestDecision, "keep");
});

test("gate prepare: partial carrier recovery excludes own carrier; newer published version rejects recovery", async (t) => {
	const own = { version: "3.2.4-alpha.2-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("own") };
	const partial = makeGateFixture(t, { carriers: [own], carrierVisible: true });
	const result = await prepare(partial, "v3.2.4-alpha.2");
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.state, "partial-carrier");
	assert.equal(result.partialOwnCarrierBuild, 33);
	assert.equal(result.frontier, 28, "前沿必须排除自身 carrier");

	const expired = makeGateFixture(t, {
		carriers: [own, { version: "3.2.4-alpha.3-app", appVersion: "3.2.4+34", integrity: fixtureIntegrity("newer") }],
		carrierVisible: true,
	});
	const expiredResult = await prepare(expired, "v3.2.4-alpha.2");
	assert.equal(expiredResult.ok, false);
	assert.ok(codes(expiredResult).includes("build-not-above-published-frontier"));
});

test("gate prepare: plugin visible without carrier is inconsistent and fails closed", async (t) => {
	const fixture = makeGateFixture(t, { pluginVisible: true });
	const result = await prepare(fixture, "v3.2.4-alpha.2");
	assert.equal(result.ok, false);
	assert.ok(codes(result).includes("publish-state-inconsistent"));
});

// ── 分支 / tag 身份 ────────────────────────────────────────────────────────────────

test("gate prepare: tag/version/core mismatches and unsupported prerelease channels fail", async (t) => {
	const tagMismatch = makeGateFixture(t, { pluginVersion: "3.2.4-alpha.3" });
	const mismatch = await prepare(tagMismatch, "v3.2.4-alpha.2");
	assert.equal(mismatch.ok, false);
	assert.ok(codes(mismatch).includes("tag-version-mismatch"));

	const beta = makeGateFixture(t, { pluginVersion: "3.2.4-beta.1" });
	const betaResult = await prepare(beta, "v3.2.4-beta.1");
	assert.equal(betaResult.ok, false);
	assert.ok(codes(betaResult).includes("tag-kind-unsupported"));

	const fixture = makeGateFixture(t);
	fs.writeFileSync(path.join(fixture.root, "dsh-mobile-app", "pubspec.yaml"), "name: dsh_mobile_app\nversion: 3.2.5+33\n");
	const coreMismatch = await prepare(fixture, "v3.2.4-alpha.2");
	assert.equal(coreMismatch.ok, false);
	assert.ok(codes(coreMismatch).includes("app-core-mismatch"));
});

test("gate prepare: legacy tag never becomes a new release", async (t) => {
	const pollutedPolicy = buildPolicySeed();
	pollutedPolicy.legacyTags = [...pollutedPolicy.legacyTags, "v3.2.4-alpha.2"];
	const fresh = makeGateFixture(t, { policy: pollutedPolicy });
	const result = await prepare(fresh, "v3.2.4-alpha.2");
	assert.equal(result.ok, false);
	assert.ok(codes(result).includes("tag-in-legacy-whitelist"));

	// 已发布历史 tag 的重跑是只读幂等（legacy 白名单不阻断），参见 fully-published 用例。
	const published = makeGateFixture(t, {
		pluginVersion: "3.2.1-alpha.1",
		build: 24,
		pluginVisible: true,
	});
	const rerun = await prepare(published, "v3.2.1-alpha.1");
	assert.equal(rerun.ok, true, JSON.stringify(rerun.reasons));
	assert.equal(rerun.state, "fully-published");
});

// ── app / latest 指针 ──────────────────────────────────────────────────────────────

test("gate prepare: app pointer compares paired plugin versions (alpha.10 vs alpha.9, rc vs alpha)", async (t) => {
	const forward = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.10",
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.9", app: "3.2.4-alpha.9-app" },
	});
	const result = await prepare(forward, "v3.2.4-alpha.10");
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.appDecision, "move");

	const backward = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.9",
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.10", app: "3.2.4-alpha.10-app" },
	});
	const keep = await prepare(backward, "v3.2.4-alpha.9");
	assert.equal(keep.ok, true, JSON.stringify(keep.reasons));
	assert.equal(keep.appDecision, "keep");

	const rcVsAlpha = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.2",
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.1", app: "3.2.3-rc.1-app" },
	});
	const rcKeep = await prepare(rcVsAlpha, "v3.2.4-alpha.2");
	assert.equal(rcKeep.appDecision, "move", "更高 core 的 alpha 可以前进 app");

	const manual = makeGateFixture(t, {
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.3-alpha.1", app: "not-a-carrier" },
	});
	const manualResult = await prepare(manual, "v3.2.4-alpha.2");
	assert.equal(manualResult.ok, false);
	assert.ok(codes(manualResult).includes("app-pointer-manual-recovery"));
});

test("gate prepare: prerelease never advances latest; stable only forward", async (t) => {
	const prerelease = makeGateFixture(t);
	const alpha = await prepare(prerelease, "v3.2.4-alpha.2");
	assert.equal(alpha.latestDecision, "keep");

	const stable = makeGateFixture(t, {
		pluginVersion: "3.2.3",
		build: 33,
		distTags: { latest: "3.2.3-rc.1", rc: "3.2.3-rc.1", app: "3.2.3-rc.1-app" },
	});
	const stableResult = await prepare(stable, "v3.2.3");
	assert.equal(stableResult.ok, true, JSON.stringify(stableResult.reasons));
	assert.equal(stableResult.latestDecision, "move", "首个 stable 可以前进 latest");

	const olderStable = makeGateFixture(t, {
		pluginVersion: "3.2.3",
		build: 33,
		distTags: { latest: "3.2.4", rc: "3.2.3-rc.1", app: "3.2.4-app" },
	});
	const older = await prepare(olderStable, "v3.2.3");
	assert.equal(older.ok, true, JSON.stringify(older.reasons));
	assert.equal(older.latestDecision, "keep", "旧 stable 不得回退 latest");
});

// ── 发布意图 / unknown ─────────────────────────────────────────────────────────────

test("gate prepare: unknown/unclosed intent blocks publish; same tag submitted allows resume", async (t) => {
	const unknownIntent = {
		tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 33, status: "unknown",
	};
	const blocked = makeGateFixture(t, { intents: [unknownIntent] });
	const blockedResult = await prepare(blocked, "v3.2.4-alpha.2");
	assert.equal(blockedResult.ok, false);
	assert.ok(codes(blockedResult).includes("release-intent-unknown"));
	const sameTagFixture = makeGateFixture(t, { pluginVersion: "3.2.4-alpha.1", intents: [unknownIntent] });
	const sameTag = await prepare(sameTagFixture, "v3.2.4-alpha.1");
	assert.equal(sameTag.ok, false, "unknown 必须先人工恢复，连同一 tag 重跑也阻断");
	assert.ok(codes(sameTag).includes("release-intent-unknown"));

	// 已完全发布的旧 tag 只读重跑不受其它 unknown 意图影响（阻断的是后续发布/通道移动）。
	const publishedRerun = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.1",
		carriers: [{ version: "3.2.4-alpha.1-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("alpha1") }],
		pluginVisible: true,
		carrierVisible: true,
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.2", app: "3.2.4-alpha.2-app" },
		intents: [unknownIntent],
	});
	const readOnly = await prepare(publishedRerun, "v3.2.4-alpha.1");
	assert.equal(readOnly.ok, true, JSON.stringify(readOnly.reasons));
	assert.equal(readOnly.state, "fully-published");

	const submitted = makeGateFixture(t, {
		intents: [{ ...unknownIntent, tag: "v3.2.4-alpha.2", pluginVersion: "3.2.4-alpha.2", carrierVersion: "3.2.4-alpha.2-app", status: "submitted" }],
	});
	const resume = await prepare(submitted, "v3.2.4-alpha.2");
	assert.equal(resume.ok, true, JSON.stringify(resume.reasons));

	const otherTag = makeGateFixture(t, {
		pluginVersion: "3.2.4-alpha.3",
		build: 34,
		intents: [{ ...unknownIntent, tag: "v3.2.4-alpha.2", pluginVersion: "3.2.4-alpha.2", carrierVersion: "3.2.4-alpha.2-app", status: "submitted" }],
	});
	const otherTagResult = await prepare(otherTag, "v3.2.4-alpha.3");
	assert.equal(otherTagResult.ok, false);
	assert.ok(codes(otherTagResult).includes("release-intent-open"));
});

test("delayed visibility: submitted intent lets the same tag resume; after visibility appears it is fully-published read-only", async (t) => {
	const intent = {
		tag: "v3.2.4-alpha.2", pluginVersion: "3.2.4-alpha.2", carrierVersion: "3.2.4-alpha.2-app", build: 33, status: "submitted",
	};
	// 发布请求已提交但 npm 尚未可见：同 tag 恢复允许，其它 tag 被阻断。
	const delayed = makeGateFixture(t, { intents: [intent] });
	const resume = await prepare(delayed, "v3.2.4-alpha.2");
	assert.equal(resume.ok, true, JSON.stringify(resume.reasons));
	assert.equal(resume.state, "fresh");

	// 迟到可见：下一次运行看到 plugin+carrier，进入 fully-published 只读幂等。
	const visible = makeGateFixture(t, {
		carriers: [{ version: "3.2.4-alpha.2-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("late") }],
		pluginVisible: true,
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.1", app: "3.2.4-alpha.2-app" },
		intents: [intent],
	});
	const late = await prepare(visible, "v3.2.4-alpha.2");
	assert.equal(late.ok, true, JSON.stringify(late.reasons));
	assert.equal(late.state, "fully-published");
});

// ── record / mark intent + verify CLI ─────────────────────────────────────────────

test("release-gate CLI: record-intent writes submitted intent idempotently, mark-intent closes unknown", (t) => {
	const fixture = makeGateFixture(t);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile };
	const args = [
		CLI, "record-intent", "--policy", fixture.policyFile,
		"--tag", "v3.2.4-alpha.2", "--build", "33",
		"--integrity", `sha512-${"A".repeat(86)}==`, "--json",
	];
	const first = spawnSync(process.execPath, args, { encoding: "utf8", env });
	assert.equal(first.status, 0, first.stderr);
	const firstResult = JSON.parse(first.stdout);
	assert.equal(firstResult.changed, true);
	assert.equal(firstResult.intent.status, "submitted");
	const policy = JSON.parse(fs.readFileSync(fixture.policyFile, "utf8"));
	assert.equal(policy.intents.length, 1);
	assert.equal(policy.intents[0].status, "submitted");

	const second = spawnSync(process.execPath, args, { encoding: "utf8", env });
	assert.equal(second.status, 0, second.stderr);
	assert.equal(JSON.parse(second.stdout).changed, false, "同一意图必须幂等");

	// 重跑/部分恢复时重建产物字节可能不同：--resume 必须允许同一会话继续，而不是误报冲突。
	const resumed = spawnSync(process.execPath, [
		CLI, "record-intent", "--policy", fixture.policyFile,
		"--tag", "v3.2.4-alpha.2", "--build", "33",
		"--integrity", `sha512-${"B".repeat(86)}==`, "--resume", "--json",
	], { encoding: "utf8", env });
	assert.equal(resumed.status, 0, resumed.stderr);
	const resumedResult = JSON.parse(resumed.stdout);
	assert.equal(resumedResult.changed, false);
	assert.equal(resumedResult.resumed, true);

	const marked = spawnSync(process.execPath, [
		CLI, "mark-intent", "--policy", fixture.policyFile,
		"--tag", "v3.2.4-alpha.2", "--status", "unknown", "--note", "visibility timeout", "--json",
	], { encoding: "utf8", env });
	assert.equal(marked.status, 0, marked.stderr);
	const markedPolicy = JSON.parse(fs.readFileSync(fixture.policyFile, "utf8"));
	assert.equal(markedPolicy.intents.at(-1).status, "unknown");

	// published 时以 registry 实际 integrity 为准（覆盖本地重建字节差异）。
	const publishedIntegrity = `sha512-${"C".repeat(86)}==`;
	const published = spawnSync(process.execPath, [
		CLI, "mark-intent", "--policy", fixture.policyFile,
		"--tag", "v3.2.4-alpha.2", "--status", "published",
		"--integrity", publishedIntegrity, "--json",
	], { encoding: "utf8", env });
	assert.equal(published.status, 0, published.stderr);
	const publishedPolicy = JSON.parse(fs.readFileSync(fixture.policyFile, "utf8"));
	assert.equal(publishedPolicy.intents.at(-1).status, "published");
	assert.equal(publishedPolicy.intents.at(-1).integrity, publishedIntegrity);
});

test("release-gate CLI: verify-tags verifies no rollback and channel/latest invariants", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-tags-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "3.2.4-alpha.1" })}\n`);
	const state = { npm: { versions: [], metadata: {}, distTags: { alpha: "3.2.4-alpha.1", app: "3.2.4-alpha.1-app", latest: "3.2.3-rc.1" } } };
	const stateFile = writeFakeState(dir, state);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile };
	const args = [
		CLI, "verify-tags", "--root", dir, "--adapters", FAKE_ADAPTERS, "--json",
		"--state", "fresh", "--plugin-tag", "alpha", "--plugin-version", "3.2.4-alpha.1",
		"--carrier-version", "3.2.4-alpha.1-app", "--app-decision", "move",
		"--latest-decision", "keep", "--latest-before", "3.2.3-rc.1",
	];
	const ok = spawnSync(process.execPath, args, { encoding: "utf8", env });
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(ok.stdout).ok, true);

	state.npm.distTags.latest = "3.2.4-alpha.1"; // 预发布移动 latest → 失败
	const badStateFile = writeFakeState(dir, state);
	const bad = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...env, DSH_RELEASE_FAKE_STATE: badStateFile } });
	assert.equal(bad.status, 1);
	assert.ok(JSON.parse(bad.stdout).reasons.some((item) => item.code === "latest-prerelease-moved"));
});


// ── 复审补充（task-17）──────────────────────────────────────────────────────────────

function runGateCli(args, env) {
	return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
}

test("gate prepare: alpha channel anti-rollback — candidate older than current channel uses staging tag", async (t) => {
	// 新发布：channel alpha 已指向更高的 alpha.3（异常/历史组合），候选 alpha.2 不得把 channel 回退。
	const fresh = makeGateFixture(t, {
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.3", app: "3.2.3-rc.1-app" },
	});
	const freshResult = await prepare(fresh, "v3.2.4-alpha.2");
	assert.equal(freshResult.ok, true, JSON.stringify(freshResult.reasons));
	assert.equal(freshResult.channelDecision, "staging");

	// 部分恢复：自身 carrier 已发布、插件未发布，channel 仍指向更高 alpha.3 → staging（不移动 channel）。
	const partial = makeGateFixture(t, {
		carriers: [{ version: "3.2.4-alpha.2-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("own-alpha2") }],
		carrierVisible: true,
		distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.3", app: "3.2.4-alpha.3-app" },
	});
	const partialResult = await prepare(partial, "v3.2.4-alpha.2");
	assert.equal(partialResult.ok, true, JSON.stringify(partialResult.reasons));
	assert.equal(partialResult.state, "partial-carrier");
	assert.equal(partialResult.channelDecision, "staging");

	// CLI 输出 GITHUB_ENV：staging 时必须用 <channel>-staging 发布插件且 channel 决策可读。
	const envFile = path.join(fresh.dir, "github-env");
	const cli = runGateCli([
		"prepare", "--root", fresh.root, "--tag", "v3.2.4-alpha.2",
		"--policy", fresh.policyFile, "--adapters", FAKE_ADAPTERS,
		"--github-env", envFile, "--json",
	], { ...process.env, DSH_RELEASE_FAKE_STATE: fresh.stateFile });
	assert.equal(cli.status, 0, cli.stderr);
	const envText = fs.readFileSync(envFile, "utf8");
	assert.match(envText, /^CHANNEL_DECISION=staging$/m);
	assert.match(envText, /^PLUGIN_PUBLISH_TAG=alpha-staging$/m);
	assert.match(envText, /^PLUGIN_STAGING_TAG=alpha-staging$/m);
});

test("verify-tags CLI: channel staging accepts unchanged channel and rejects a moved channel", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-channel-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "3.2.4-alpha.2" })}\n`);
	const state = {
		npm: {
			versions: [],
			metadata: {},
			distTags: { alpha: "3.2.4-alpha.3", app: "3.2.4-alpha.3-app", latest: "3.2.3-rc.1" },
		},
	};
	const stateFile = writeFakeState(dir, state);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile };
	const args = [
		"verify-tags", "--root", dir, "--adapters", FAKE_ADAPTERS, "--json",
		"--state", "partial-carrier", "--plugin-tag", "alpha", "--plugin-version", "3.2.4-alpha.2",
		"--carrier-version", "3.2.4-alpha.2-app", "--channel-decision", "staging", "--channel-before", "3.2.4-alpha.3",
		"--app-decision", "keep", "--app-before", "3.2.4-alpha.3-app",
		"--latest-decision", "keep", "--latest-before", "3.2.3-rc.1",
	];
	const ok = runGateCli(args, env);
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	assert.equal(JSON.parse(ok.stdout).ok, true);

	state.npm.distTags.alpha = "3.2.4-alpha.2"; // channel 被回退 → 必须失败
	const movedFile = writeFakeState(dir, state);
	const moved = runGateCli(args, { ...env, DSH_RELEASE_FAKE_STATE: movedFile });
	assert.equal(moved.status, 1);
	assert.ok(JSON.parse(moved.stdout).reasons.some((item) => item.code === "channel-not-preserved"));
});

test("gate prepare: fully-published rerun reports leftover submitted/unknown intent (m7) without failing read-only", async (t) => {
	for (const status of ["submitted", "unknown"]) {
		const fixture = makeGateFixture(t, {
			pluginVersion: "3.2.4-alpha.1",
			carriers: [{ version: "3.2.4-alpha.1-app", appVersion: "3.2.4+33", integrity: fixtureIntegrity("leftover") }],
			pluginVisible: true,
			carrierVisible: true,
			distTags: { latest: "3.2.3-rc.1", alpha: "3.2.4-alpha.2", app: "3.2.4-alpha.2-app" },
			intents: [{
				tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 33, status,
			}],
		});
		const result = await prepare(fixture, "v3.2.4-alpha.1");
		assert.equal(result.ok, true, JSON.stringify(result.reasons));
		assert.equal(result.state, "fully-published");
		assert.equal(result.leftoverIntent?.status, status);
	}
});

test("release-gate CLI: verify-package asserts BUILD vs manifest.app.version and carrier identity (m8)", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-package-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const dist = path.join(dir, "dist");
	fs.mkdirSync(dist, { recursive: true });
	const manifest = {
		schema: 1,
		app: { version: "3.2.4+33", file: "DSH-Remote-v3.2.4.apk" },
		plugin: { version: "3.2.4-alpha.2" },
	};
	const carrier = { schema: 1, name: PACKAGE_NAME, version: "3.2.4-alpha.2-app", manifest };
	fs.writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	fs.writeFileSync(path.join(dist, "app-carrier.json"), `${JSON.stringify(carrier, null, 2)}\n`);
	const args = [
		"verify-package", "--root", dir, "--dist", dist, "--json",
		"--plugin-version", "3.2.4-alpha.2", "--carrier-version", "3.2.4-alpha.2-app", "--build", "33",
	];
	const ok = runGateCli(args, process.env);
	assert.equal(ok.status, 0, ok.stdout + ok.stderr);
	assert.equal(JSON.parse(ok.stdout).ok, true);

	const badBuild = runGateCli([...args.slice(0, -1), "34"], process.env);
	assert.equal(badBuild.status, 1);
	assert.ok(JSON.parse(badBuild.stdout).reasons.some((item) => item.code === "build-manifest-mismatch"));

	const wrongVersion = runGateCli([
		"verify-package", "--root", dir, "--dist", dist, "--json",
		"--plugin-version", "3.2.4-alpha.3", "--carrier-version", "3.2.4-alpha.3-app", "--build", "33",
	], process.env);
	assert.equal(wrongVersion.status, 1);
	assert.ok(JSON.parse(wrongVersion.stdout).reasons.some((item) => item.code === "plugin-version-mismatch"));
});

test("release-gate CLI: mark-intent for a tag without existing intent fails closed (m6)", (t) => {
	const fixture = makeGateFixture(t);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile };
	const result = runGateCli([
		"mark-intent", "--policy", fixture.policyFile,
		"--tag", "v3.2.4-alpha.9", "--status", "published", "--json",
	], env);
	assert.equal(result.status, 1);
	assert.ok(JSON.parse(result.stdout).reasons.some((item) => item.code === "release-intent-missing"));
});
