// 发布政策纯判定测试（issue #43 / 设计稿 §11.1、§11.2）。
//
// 直接 import tools/lib/release-policy.mjs：零网络、零文件、确定性。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PUBLISH_STATES,
	appDistTagDecision,
	applyReleaseIntent,
	assertNewBuild,
	channelDistTagDecision,
	assertNoOpenReleaseIntents,
	assertReleaseMetaSources,
	assertWatermarkNotRegressed,
	classifyPublishState,
	compareSemver,
	computePublishedFrontier,
	frontierInputFromCarriers,
	latestDistTagDecision,
	markReleaseIntent,
	openReleaseIntents,
	parseBuildPolicy,
	parseCarrierVersion,
	parseReleaseTag,
	releaseChannel,
	parseSemver,
	serializeBuildPolicy,
	validateBuildPolicy,
	verifyDistTagsAfterPublish,
} from "../tools/lib/release-policy.mjs";

const PACKAGE_NAME = "@marktrue/dsh-mobile-remote";

/** 生成合法形状的 npm integrity（sha512-<86 base64 字符>==），互不相同。 */
let integritySeq = 0;
function integrity(seed = "") {
	integritySeq += 1;
	const body = `${seed}${String(integritySeq).padStart(4, "0")}`.padEnd(86, "A").slice(0, 86);
	return `sha512-${body}==`;
}
const LEGACY_TAGS = [
	"v3.2.1-alpha.1", "v3.2.1-alpha.2", "v3.2.1-alpha.3", "v3.2.1-rc.1",
	"v3.2.2-alpha.1", "v3.2.2-rc.1", "v3.2.3-alpha.1", "v3.2.3-rc.1",
];
const LEGACY_CARRIERS = [
	{ version: "3.2.1-alpha.1-app", integrity: integrity("a"), appBuild: 24 },
	{ version: "3.2.1-alpha.2-app", integrity: integrity("b"), appBuild: 24 },
	{ version: "3.2.1-alpha.3-app", integrity: integrity("c"), appBuild: 25 },
	{ version: "3.2.1-rc.1-app", integrity: integrity("d"), appBuild: 26 },
	{ version: "3.2.2-alpha.1-app", integrity: integrity("e"), appBuild: 26 },
	{ version: "3.2.2-rc.1-app", integrity: integrity("f"), appBuild: 27 },
	{ version: "3.2.3-alpha.1-app", integrity: integrity("g"), appBuild: 27 },
	{ version: "3.2.3-rc.1-app", integrity: integrity("h"), appBuild: 28 },
];
const POLICY = {
	schema: 1,
	watermark: 32,
	legacyTags: LEGACY_TAGS,
	legacyCarriers: LEGACY_CARRIERS,
	updatedAt: "2026-11-02",
	intents: [],
};

function policyWith(overrides = {}) {
	return { ...POLICY, ...overrides };
}

// ── 基础解析 ────────────────────────────────────────────────────────────────────────

test("semver compare: prerelease ordering, numeric identifiers and stable > prerelease", () => {
	assert.equal(compareSemver("3.2.4", "3.2.4-rc.1"), 1);
	assert.equal(compareSemver("3.2.4-rc.1", "3.2.4"), -1);
	assert.equal(compareSemver("3.2.4-alpha.10", "3.2.4-alpha.9"), 1);
	assert.equal(compareSemver("3.2.4-alpha.2", "3.2.4-alpha.10"), -1);
	assert.equal(compareSemver("3.2.4", "3.2.4"), 0);
	assert.equal(compareSemver("3.2.3", "3.2.4-rc.1"), -1);
	assert.equal(compareSemver("3.2.4-alpha.1", "3.2.4-beta.1"), -1);
});

test("release tag parsing: alpha/rc/stable and unsupported prerelease", () => {
	assert.deepEqual(parseReleaseTag("v3.2.4-alpha.2"), {
		tag: "v3.2.4-alpha.2", pluginVersion: "3.2.4-alpha.2", core: "3.2.4", kind: "alpha", prerelease: "alpha.2",
	});
	assert.equal(parseReleaseTag("v3.2.4-rc.1").kind, "rc");
	assert.equal(parseReleaseTag("v3.2.4").kind, "stable");
	assert.equal(parseReleaseTag("v3.2.4-beta.1").kind, "prerelease-other");
	assert.equal(releaseChannel("v3.2.4-beta.1"), null);
	assert.equal(parseReleaseTag("3.2.4"), null);
	assert.equal(parseReleaseTag("v3.2.4-app"), null);
});

test("carrier version pairs by stripping exactly the trailing -app (never raw compare)", () => {
	assert.equal(parseCarrierVersion("3.2.4-alpha.10-app").pluginVersion, "3.2.4-alpha.10");
	assert.equal(parseCarrierVersion("3.2.4-app").pluginVersion, "3.2.4");
	assert.equal(parseCarrierVersion("3.2.4-app-extra"), null);
});

// ── build-policy schema ─────────────────────────────────────────────────────────────

test("build policy: valid seed parses; serialize round-trips", () => {
	const parsed = parseBuildPolicy(serializeBuildPolicy(POLICY));
	assert.equal(parsed.ok, true);
	assert.equal(parsed.policy.watermark, 32);
	assert.equal(parsed.policy.legacyTags.length, 8);
	assert.equal(parsed.policy.legacyCarriers.length, 8);
});

test("build policy fail-closed: invalid JSON / schema / watermark / legacy entries", () => {
	assert.equal(parseBuildPolicy("{").ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, schema: 2 }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, watermark: 0 }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, watermark: "32" }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, legacyTags: ["v3.2.4-alpha.1", "v3.2.4-alpha.1"] }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, legacyCarriers: [{ version: "3.2.1-alpha.1-app", integrity: "sha512-x", appBuild: 24 }] }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, legacyCarriers: [LEGACY_CARRIERS[0], LEGACY_CARRIERS[0]] }).ok, false);
	assert.equal(validateBuildPolicy({ ...POLICY, intents: [{ tag: "v-bad" }] }).ok, false);
});

test("dual release-meta sources: both required, same SHA and byte-identical content", () => {
	const content = serializeBuildPolicy(POLICY);
	const ok = assertReleaseMetaSources({
		origin: { sha: "aaa", content },
		github: { sha: "aaa", content },
	});
	assert.equal(ok.ok, true);
	assert.equal(assertReleaseMetaSources({ origin: { sha: "aaa", content }, github: {} }).ok, false, "github 缺失必须 fail-closed");
	const divergedSha = assertReleaseMetaSources({ origin: { sha: "aaa", content }, github: { sha: "bbb", content } });
	assert.equal(divergedSha.ok, false);
	assert.equal(divergedSha.reasons[0].code, "release-meta-diverged");
	const divergedContent = assertReleaseMetaSources({ origin: { sha: "aaa", content }, github: { sha: "aaa", content: "{}\n" } });
	assert.equal(divergedContent.ok, false, "内容逐字节不一致必须 fail-closed");
});

test("watermark only rises", () => {
	assert.equal(assertWatermarkNotRegressed(32, 32).ok, true);
	assert.equal(assertWatermarkNotRegressed(32, 40).ok, true);
	const regressed = assertWatermarkNotRegressed(40, 32);
	assert.equal(regressed.ok, false);
	assert.equal(regressed.reasons[0].code, "build-policy-watermark-regressed");
});

// ── 发布前沿 ────────────────────────────────────────────────────────────────────────

test("frontier: max of new carrier appVersion and verified legacy appBuild; legacy entries verified by integrity", () => {
	const publishedCarriers = [
		{ version: "3.2.1-alpha.1-app", integrity: LEGACY_CARRIERS[0].integrity }, // legacy，缺 appVersion
		{ version: "3.2.1-alpha.2-app", integrity: LEGACY_CARRIERS[1].integrity },
		{ version: "3.2.1-alpha.3-app", integrity: LEGACY_CARRIERS[2].integrity },
		{ version: "3.2.1-rc.1-app", integrity: LEGACY_CARRIERS[3].integrity, appVersion: "3.2.1+26" },
		{ version: "3.2.2-alpha.1-app", integrity: LEGACY_CARRIERS[4].integrity, appVersion: "3.2.2+26" },
		{ version: "3.2.2-rc.1-app", integrity: LEGACY_CARRIERS[5].integrity, appVersion: "3.2.2+27" },
		{ version: "3.2.3-alpha.1-app", integrity: LEGACY_CARRIERS[6].integrity, appVersion: "3.2.3+27" },
		{ version: "3.2.3-rc.1-app", integrity: LEGACY_CARRIERS[7].integrity, appVersion: "3.2.3+28" },
		{ version: "3.2.4-alpha.1-app", integrity: integrity("j"), appVersion: "3.2.4+33" },
	];
	const input = frontierInputFromCarriers(publishedCarriers);
	const result = computePublishedFrontier({ ...input, legacyCarriers: LEGACY_CARRIERS });
	assert.equal(result.ok, true);
	assert.equal(result.frontier, 33);
	assert.equal(result.entries.length, 9);
});

test("frontier fail-closed: unregistered carrier missing appVersion; registered legacy integrity/appVersion mismatch", () => {
	const missing = computePublishedFrontier({
		newCarrierAppVersions: [{ version: "3.2.4-alpha.1-app", appVersion: null }],
		legacyCarriers: LEGACY_CARRIERS,
	});
	assert.equal(missing.ok, false);
	assert.ok(missing.reasons.some((item) => item.code === "carrier-app-version-missing"));

	const integrityMismatch = computePublishedFrontier({
		newCarrierAppVersions: [{ version: "3.2.1-alpha.1-app", appVersion: null, integrity: integrity("evil") }],
		legacyCarriers: LEGACY_CARRIERS,
	});
	assert.equal(integrityMismatch.ok, false);
	assert.ok(integrityMismatch.reasons.some((item) => item.code === "legacy-carrier-integrity-mismatch"));

	const buildMismatch = computePublishedFrontier({
		newCarrierAppVersions: [{ version: "3.2.3-rc.1-app", appVersion: "3.2.3+99", integrity: LEGACY_CARRIERS[7].integrity }],
		legacyCarriers: LEGACY_CARRIERS,
	});
	assert.equal(buildMismatch.ok, false);
	assert.ok(buildMismatch.reasons.some((item) => item.code === "legacy-carrier-build-mismatch"));

	const unverified = computePublishedFrontier({
		newCarrierAppVersions: [],
		legacyCarriers: LEGACY_CARRIERS,
	});
	assert.equal(unverified.ok, false, "登记了但 npm 未返回的 legacy carrier 不能静默忽略");
});

// ── build 校验（CI） ───────────────────────────────────────────────────────────────

test("build check: fresh publish must exceed watermark and published frontier", () => {
	assert.equal(assertNewBuild({ build: 33, watermark: 32, frontier: 32 }).ok, true);
	const watermark = assertNewBuild({ build: 32, watermark: 32, frontier: 0 });
	assert.equal(watermark.ok, false);
	assert.ok(watermark.reasons.some((item) => item.code === "build-not-above-watermark"));
	const frontier = assertNewBuild({ build: 33, watermark: 32, frontier: 34 });
	assert.equal(frontier.ok, false);
	assert.ok(frontier.reasons.some((item) => item.code === "build-not-above-published-frontier"));
	// A（33）先打 tag、B（34）后打 tag 但未发布：A 可发布；B 先发布后 A 因 33<34 被拒（上面 frontier=34）。
	assert.equal(assertNewBuild({ build: 34, watermark: 32, frontier: 33 }).ok, true);
});

test("build check: fully-published rerun skips build validation (old alpha.1 after alpha.2)", () => {
	const result = assertNewBuild({ build: 24, watermark: 32, frontier: 40, fullyPublished: true });
	assert.equal(result.ok, true);
	assert.equal(result.skipped, true);
});

test("build check: partial recovery excludes own carrier but rejects newer published frontier", () => {
	// 自己 carrier build 33 已发布，其它已发布前沿 32 → 允许完成会话。
	const ok = assertNewBuild({ build: 33, watermark: 32, frontier: 32, partialOwnCarrierBuild: 33 });
	assert.equal(ok.ok, true);
	assert.equal(ok.partial, true);
	// 自身 carrier 记录的 build 与 tag build 不一致 → fail-closed。
	const mismatch = assertNewBuild({ build: 33, watermark: 32, frontier: 32, partialOwnCarrierBuild: 32 });
	assert.equal(mismatch.ok, false);
	// B（34）已发布后，A（33）不允许借恢复把通道回退。
	const expired = assertNewBuild({ build: 33, watermark: 32, frontier: 34, partialOwnCarrierBuild: 33 });
	assert.equal(expired.ok, false);
	// tag 落入 legacy 白名单不得作为新发布。
	const legacy = assertNewBuild({ build: 33, watermark: 32, frontier: 0, legacyTag: true });
	assert.equal(legacy.ok, false);
	assert.ok(legacy.reasons.some((item) => item.code === "tag-in-legacy-whitelist"));
});

// ── 已发布状态 ──────────────────────────────────────────────────────────────────────

test("publish state classification precedes dynamic channel guards", () => {
	assert.equal(classifyPublishState(false, false), PUBLISH_STATES.FRESH);
	assert.equal(classifyPublishState(false, true), PUBLISH_STATES.PARTIAL_CARRIER);
	assert.equal(classifyPublishState(true, true), PUBLISH_STATES.FULLY_PUBLISHED);
	assert.equal(classifyPublishState(true, false), PUBLISH_STATES.PARTIAL_PLUGIN);
});

// ── app 指针（配对插件版本比较）────────────────────────────────────────────────────

test("app decision: compare paired plugin versions after stripping -app", () => {
	assert.equal(appDistTagDecision(null, "3.2.4-alpha.1-app").action, "move");
	assert.equal(appDistTagDecision("3.2.4-alpha.9-app", "3.2.4-alpha.10-app").action, "move", "alpha.10 > alpha.9（数字序）");
	assert.equal(appDistTagDecision("3.2.4-alpha.10-app", "3.2.4-alpha.9-app").action, "keep", "不得回退");
	assert.equal(appDistTagDecision("3.2.4-rc.1-app", "3.2.4-app").action, "move", "stable 3.2.4 > rc.1");
	assert.equal(appDistTagDecision("3.2.4-app", "3.2.4-rc.1-app").action, "keep", "rc 不得把 stable 回退");
	assert.equal(appDistTagDecision("3.2.3-rc.1-app", "3.2.4-alpha.1-app").action, "move", "更高 core 前进");
	assert.equal(appDistTagDecision("3.2.4-alpha.1-app", "3.2.4-alpha.1-app").action, "keep");
	assert.equal(appDistTagDecision("3.2.4-alpha.1", "3.2.4-alpha.2-app").action, "manual", "app 指向非 carrier → 人工");
	assert.equal(appDistTagDecision("3.2.4-alpha.2-app", "not-a-carrier").action, "manual");
});

test("latest decision: only stable advances; prerelease never moves it", () => {
	assert.equal(latestDistTagDecision("3.2.4-alpha.1", "3.2.3-rc.1").action, "keep");
	assert.equal(latestDistTagDecision("3.2.4-rc.1", "3.2.3-rc.1").action, "keep");
	assert.equal(latestDistTagDecision("3.2.3", "3.2.3-rc.1").action, "move", "首个 stable 前进 latest");
	assert.equal(latestDistTagDecision("3.2.3", "3.2.3").action, "keep");
	assert.equal(latestDistTagDecision("3.2.3", "3.2.4").action, "keep", "旧 stable 不得回退 latest");
	const manual = latestDistTagDecision("3.2.3", "3.2.3-app");
	assert.equal(manual.action, "manual");
});

test("post-publish dist-tags: old fully-published tag rerun does not require current channel equality or move pointers", () => {
	// alpha.2 已发布后重跑 alpha.1：alpha 通道现在指向 alpha.2，app 指向 alpha.2-app。
	const rerun = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FULLY_PUBLISHED,
		pluginTag: "alpha",
		pluginVersion: "3.2.4-alpha.1",
		channelCurrent: "3.2.4-alpha.2",
		candidateCarrierVersion: "3.2.4-alpha.1-app",
		appDecision: "keep",
		appCurrent: "3.2.4-alpha.2-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(rerun.ok, true);
	// app 被回退到更旧 carrier → fail。
	const rolledBack = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FULLY_PUBLISHED,
		pluginVersion: "3.2.4-alpha.1",
		candidateCarrierVersion: "3.2.4-alpha.1-app",
		appDecision: "keep",
		appCurrent: "3.2.3-rc.1-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(rolledBack.ok, false);
});

test("post-publish dist-tags: fresh move/latest rules are verified", () => {
	const fresh = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH,
		pluginTag: "alpha",
		pluginVersion: "3.2.4-alpha.1",
		channelCurrent: "3.2.4-alpha.1",
		candidateCarrierVersion: "3.2.4-alpha.1-app",
		appDecision: "move",
		appBefore: "3.2.3-rc.1-app",
		appCurrent: "3.2.4-alpha.1-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(fresh.ok, true);

	const channel = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH, pluginTag: "alpha", pluginVersion: "3.2.4-alpha.1",
		channelCurrent: "3.2.4-alpha.0", candidateCarrierVersion: "3.2.4-alpha.1-app",
		appDecision: "move", appCurrent: "3.2.4-alpha.1-app",
		latestDecision: "keep", latestBefore: "3.2.3-rc.1", latestNow: "3.2.3-rc.1",
	});
	assert.equal(channel.ok, false, "通道未指向本次版本必须失败");

	const latestMovedByPrerelease = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH, pluginTag: "alpha", pluginVersion: "3.2.4-alpha.1",
		channelCurrent: "3.2.4-alpha.1", candidateCarrierVersion: "3.2.4-alpha.1-app",
		appDecision: "move", appCurrent: "3.2.4-alpha.1-app",
		latestDecision: "keep", latestBefore: "3.2.3-rc.1", latestNow: "3.2.4-alpha.1",
	});
	assert.equal(latestMovedByPrerelease.ok, false, "预发布移动 latest 必须失败");

	const stableMove = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH, pluginTag: "latest", pluginVersion: "3.2.4",
		channelCurrent: "3.2.3-rc.1", candidateCarrierVersion: "3.2.4-app",
		appDecision: "move", appCurrent: "3.2.4-app",
		latestDecision: "move", latestBefore: "3.2.3-rc.1", latestNow: "3.2.4",
	});
	assert.equal(stableMove.ok, true);
});

// ── 发布意图 / unknown ─────────────────────────────────────────────────────────────

test("release intents: submitted blocks other tags, allows resuming same tag; unknown blocks everything", () => {
	let policy = policyWith();
	const submitted = applyReleaseIntent(policy, {
		tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 33,
	});
	assert.equal(submitted.ok, true);
	assert.equal(submitted.changed, true);
	policy = submitted.policy;
	assert.equal(openReleaseIntents(policy).length, 1);
	assert.equal(assertNoOpenReleaseIntents(policy).ok, false, "其它分配必须被阻断");
	assert.equal(assertNoOpenReleaseIntents(policy, { tag: "v3.2.4-alpha.1" }).ok, true, "同 tag 续跑允许");

	// 同内容幂等；不同内容冲突。
	const identical = applyReleaseIntent(policy, {
		tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 33,
	});
	assert.equal(identical.ok, true);
	assert.equal(identical.changed, false);
	const conflict = applyReleaseIntent(policy, {
		tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 34,
	});
	assert.equal(conflict.ok, false);

	const unknown = markReleaseIntent(policy, { tag: "v3.2.4-alpha.1", status: "unknown" });
	assert.equal(unknown.ok, true);
	assert.equal(assertNoOpenReleaseIntents(unknown.policy, { tag: "v3.2.4-alpha.1" }).ok, false, "unknown 连自身重跑也阻断，必须人工恢复");
	const published = markReleaseIntent(unknown.policy, { tag: "v3.2.4-alpha.1", status: "published" });
	assert.equal(published.ok, true);
	assert.equal(openReleaseIntents(published.policy).length, 0);
	const duplicate = applyReleaseIntent(published.policy, {
		tag: "v3.2.4-alpha.1", pluginVersion: "3.2.4-alpha.1", carrierVersion: "3.2.4-alpha.1-app", build: 33,
	});
	assert.equal(duplicate.ok, false, "已 published 的 tag 不得重复发布会话");
});


// ── 复审补充（task-17）──────────────────────────────────────────────────────────────

test("n4: semantic versions reject leading zeros (core and numeric prerelease)", () => {
	assert.equal(parseSemver("3.02.4"), null);
	assert.equal(parseSemver("3.2.4-alpha.01"), null);
	assert.ok(parseSemver("3.2.4-alpha.0") !== null, "数字 0 是合法标识");
	assert.ok(parseSemver("3.2.4-alpha.0.0") !== null);
	assert.ok(parseSemver("03.2.4") === null);
	assert.ok(parseSemver("3.2.4-alpha.10") !== null);
	assert.equal(compareSemver("3.2.4-alpha.9", "3.2.4-alpha.10"), -1);
});

test("channel anti-rollback: compare candidate plugin version to current alpha/rc channel dist-tag", () => {
	assert.equal(channelDistTagDecision("3.2.4-alpha.2", null).action, "move");
	assert.equal(channelDistTagDecision("3.2.4-alpha.2", "3.2.4-alpha.1").action, "move");
	assert.equal(channelDistTagDecision("3.2.4-alpha.2", "3.2.4-alpha.2").action, "keep");
	assert.equal(channelDistTagDecision("3.2.4-alpha.2", "3.2.4-alpha.3").action, "staging");
	assert.equal(channelDistTagDecision("3.2.4-rc.1", "3.2.4-rc.2").action, "staging");
	assert.equal(channelDistTagDecision("3.2.4-alpha.10", "3.2.4-alpha.9").action, "move");
	assert.equal(channelDistTagDecision("3.2.4-alpha.2", "garbage").action, "manual");
	assert.equal(channelDistTagDecision("not-a-version", "3.2.4-alpha.1").action, "manual");
});

test("post-publish channel check: staging keeps channel unchanged; keep/move require channel == candidate", () => {
	const staging = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.PARTIAL_CARRIER,
		pluginTag: "alpha",
		pluginVersion: "3.2.4-alpha.2",
		channelCurrent: "3.2.4-alpha.3",
		channelDecision: "staging",
		channelBefore: "3.2.4-alpha.3",
		candidateCarrierVersion: "3.2.4-alpha.2-app",
		appDecision: "keep",
		appBefore: "3.2.4-alpha.3-app",
		appCurrent: "3.2.4-alpha.3-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(staging.ok, true, JSON.stringify(staging.reasons));

	const rolledChannel = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH,
		pluginTag: "alpha",
		pluginVersion: "3.2.4-alpha.2",
		channelCurrent: "3.2.4-alpha.2",
		channelDecision: "staging",
		channelBefore: "3.2.4-alpha.3",
		candidateCarrierVersion: "3.2.4-alpha.2-app",
		appDecision: "move",
		appCurrent: "3.2.4-alpha.2-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(rolledChannel.ok, false);
	assert.ok(rolledChannel.reasons.some((item) => item.code === "channel-not-preserved"));

	const keepDecision = verifyDistTagsAfterPublish({
		state: PUBLISH_STATES.FRESH,
		pluginTag: "alpha",
		pluginVersion: "3.2.4-alpha.2",
		channelCurrent: "3.2.4-alpha.2",
		channelDecision: "keep",
		candidateCarrierVersion: "3.2.4-alpha.2-app",
		appDecision: "move",
		appCurrent: "3.2.4-alpha.2-app",
		latestDecision: "keep",
		latestBefore: "3.2.3-rc.1",
		latestNow: "3.2.3-rc.1",
	});
	assert.equal(keepDecision.ok, true);
});

test("m6: markReleaseIntent refuses to create an intent for an unknown tag", () => {
	const result = markReleaseIntent(policyWith(), { tag: "v3.2.4-alpha.9", status: "published" });
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((item) => item.code === "release-intent-missing"));
});
