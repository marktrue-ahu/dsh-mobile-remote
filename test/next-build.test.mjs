// `tools/next-build.mjs` 分配规则测试（issue #43 / 设计稿 §11.1、§12）。
//
// 全程离线：git / npm 适配器通过 test/helpers/fake-release-adapters.mjs 注入。
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
	HISTORICAL_TAG_BUILDS,
	PACKAGE_NAME,
	buildPolicySeed,
	fakeState,
	writeFakeState,
} from "./helpers/release-fixtures.mjs";
import { serializeBuildPolicy } from "../tools/lib/release-policy.mjs";
import { allocateNextBuild } from "../tools/next-build.mjs";
import { createAdapters } from "./helpers/fake-release-adapters.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "tools", "next-build.mjs");

function makeStateDir(t, state) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-next-build-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const stateFile = writeFakeState(dir, state);
	const adapters = createAdapters({ env: { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile } });
	const root = path.join(dir, "repo");
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "3.2.4-alpha.1" }, null, 2)}\n`);
	return { dir, stateFile, adapters, root };
}

function reasonCodes(result) {
	return (result.reasons ?? []).map((item) => item.code);
}

test("next-build: migration baseline (watermark 32 > tag max 28) yields 33", (t) => {
	const fixture = makeStateDir(t, fakeState());
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, true);
	assert.equal(result.watermark, 32);
	assert.equal(result.tagMaxBuild, 28);
	assert.equal(result.frontier, 28);
	assert.equal(result.nextBuild, 33);
	assert.equal(result.maxSource, "watermark");
});

test("next-build: published carrier appVersion/frontier above watermark yields frontier+1", (t) => {
	const carriers = [
		...HISTORICAL_CARRIERS.map((carrier) => ({
			version: carrier.version,
			appVersion: carrier.legacy ? null : `${carrier.version.slice(0, -4).split("-")[0]}+${carrier.appBuild}`,
			integrity: carrier.integrity,
		})),
		{ version: "3.2.4-alpha.1-app", appVersion: "3.2.4+33", integrity: "sha512-fixture-new===" },
	];
	// 让新 carrier integrity 合法形状（fixture 字符串只需通过 frontier 的 integrity 对比，不校验格式）。
	const fixture = makeStateDir(t, fakeState({ carriers }));
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, true);
	assert.equal(result.frontier, 33);
	assert.equal(result.nextBuild, 34);
});

test("next-build fail-closed: release-meta missing/diverged", (t) => {
	const divergentSha = fakeState();
	divergentSha.releaseMeta.github.sha = "b".repeat(40);
	const shaFixture = makeStateDir(t, divergentSha);
	const shaResult = allocateNextBuild({ adapters: shaFixture.adapters, packageName: PACKAGE_NAME, repoRoot: shaFixture.root });
	assert.equal(shaResult.ok, false);
	assert.ok(reasonCodes(shaResult).includes("release-meta-diverged"));

	const divergentContent = fakeState();
	divergentContent.releaseMeta.github.content = `${divergentContent.releaseMeta.github.content}\n`;
	const contentFixture = makeStateDir(t, divergentContent);
	const contentResult = allocateNextBuild({ adapters: contentFixture.adapters, packageName: PACKAGE_NAME, repoRoot: contentFixture.root });
	assert.equal(contentResult.ok, false);
	assert.ok(reasonCodes(contentResult).includes("release-meta-diverged"));

	const missing = fakeState();
	delete missing.releaseMeta.github;
	const missingFixture = makeStateDir(t, missing);
	const missingResult = allocateNextBuild({ adapters: missingFixture.adapters, packageName: PACKAGE_NAME, repoRoot: missingFixture.root });
	assert.equal(missingResult.ok, false);
	assert.ok(reasonCodes(missingResult).includes("release-meta-missing"));
});

test("next-build: upstream/non-package tags on only one remote are ignored;本包发布 tag 缺失仍 fail-closed", (t) => {
	const ignored = fakeState();
	ignored.remoteTags.github = ignored.remoteTags.github.filter((entry) => entry.name !== "v0.9.0-rc.1");
	const okFixture = makeStateDir(t, ignored);
	const okResult = allocateNextBuild({ adapters: okFixture.adapters, packageName: PACKAGE_NAME, repoRoot: okFixture.root });
	assert.equal(okResult.ok, true);
	assert.equal(okResult.nextBuild, 33);

	const missingRelease = fakeState();
	missingRelease.remoteTags.github = missingRelease.remoteTags.github.filter((entry) => entry.name !== "v3.2.2-rc.1");
	const missingFixture = makeStateDir(t, missingRelease);
	const missingResult = allocateNextBuild({ adapters: missingFixture.adapters, packageName: PACKAGE_NAME, repoRoot: missingFixture.root });
	assert.equal(missingResult.ok, false);
	assert.ok(reasonCodes(missingResult).includes("tag-sha-diverged"));
});

test("next-build fail-closed: same tag diverged between remotes", (t) => {
	const state = fakeState();
	state.remoteTags.github[0].sha = "z".repeat(40);
	const fixture = makeStateDir(t, state);
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, false);
	assert.ok(reasonCodes(result).includes("tag-sha-diverged"));
});

test("next-build fail-closed: unregistered carrier missing appVersion (legacy must be registered)", (t) => {
	const policy = buildPolicySeed();
	policy.legacyCarriers = policy.legacyCarriers.filter((entry) => entry.version !== "3.2.1-alpha.1-app");
	const state = fakeState();
	state.releaseMeta = {
		origin: { sha: "a".repeat(40), content: serializeBuildPolicy(policy) },
		github: { sha: "a".repeat(40), content: serializeBuildPolicy(policy) },
	};
	const fixture = makeStateDir(t, state);
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, false);
	assert.ok(reasonCodes(result).includes("carrier-app-version-missing"));
});

test("next-build fail-closed: registered legacy carrier integrity mismatch", (t) => {
	const state = fakeState();
	state.npm.metadata["3.2.1-alpha.2-app"].dist.integrity = `sha512-${"Z".repeat(86)}==`;
	const fixture = makeStateDir(t, state);
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, false);
	assert.ok(reasonCodes(result).includes("legacy-carrier-integrity-mismatch"));
});

test("next-build fail-closed: open/unknown release intent blocks allocation", (t) => {
	const cases = ["submitted", "unknown"];
	for (const status of cases) {
		const state = fakeState({
			intents: [{
				tag: "v3.2.4-alpha.1",
				pluginVersion: "3.2.4-alpha.1",
				carrierVersion: "3.2.4-alpha.1-app",
				build: 33,
				status,
			}],
		});
		const fixture = makeStateDir(t, state);
		const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
		assert.equal(result.ok, false, `${status} 必须阻断分配`);
		assert.ok(reasonCodes(result).some((code) => code === "release-intent-open" || code === "release-intent-unknown"), status);
	}
});

test("next-build fail-closed: git timeout maps to stable git-metadata-unavailable reason (m3)", (t) => {
	const state = fakeState();
	state.failFetch = "git fetch timed out";
	state.failFetchReason = "git-metadata-unavailable";
	const fixture = makeStateDir(t, state);
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, false);
	assert.ok(reasonCodes(result).includes("git-metadata-unavailable"));
});

test("next-build fail-closed: npm metadata unavailable", (t) => {
	const state = fakeState();
	state.npmError = "ETIMEDOUT";
	const fixture = makeStateDir(t, state);
	const result = allocateNextBuild({ adapters: fixture.adapters, packageName: PACKAGE_NAME, repoRoot: fixture.root });
	assert.equal(result.ok, false);
	assert.ok(reasonCodes(result).includes("npm-metadata-unavailable"));
});

test("next-build CLI: --json pass output and fail exit code (offline adapters)", (t) => {
	const fixture = makeStateDir(t, fakeState());
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile };
	const ok = spawnSync(process.execPath, [
		CLI, "--json", "--root", fixture.root, "--package", PACKAGE_NAME, "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env });
	assert.equal(ok.status, 0, ok.stderr);
	const parsed = JSON.parse(ok.stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.nextBuild, 33);

	const badState = fakeState();
	delete badState.releaseMeta.github;
	const badFile = writeFakeState(fixture.dir, badState);
	const bad = spawnSync(process.execPath, [
		CLI, "--json", "--root", fixture.root, "--package", PACKAGE_NAME, "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...env, DSH_RELEASE_FAKE_STATE: badFile } });
	assert.equal(bad.status, 1);
	const badResult = JSON.parse(bad.stdout);
	assert.equal(badResult.ok, false);
	assert.ok(badResult.reasons.some((item) => item.code === "release-meta-missing"));
});

test("next-build CLI: human output reports RESULT and next build", (t) => {
	const fixture = makeStateDir(t, fakeState());
	const result = spawnSync(process.execPath, [
		CLI, "--root", fixture.root, "--package", PACKAGE_NAME, "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /watermark\s*:\s*32/);
	assert.match(result.stdout, /next build\s*:\s*33/);
	assert.match(result.stdout, /RESULT: PASS/);
	void HISTORICAL_TAG_BUILDS;
});

// 防御：fakeState 的默认 carriers 与设计稿 §12 的 8 条一致。
test("fixtures match design §12 historical data", () => {
	assert.equal(HISTORICAL_CARRIERS.length, 8);
	assert.equal(HISTORICAL_CARRIERS.filter((carrier) => carrier.legacy).length, 3);
	assert.deepEqual(HISTORICAL_TAG_BUILDS.map(([, build]) => build), [24, 24, 25, 26, 26, 27, 27, 28]);
});
