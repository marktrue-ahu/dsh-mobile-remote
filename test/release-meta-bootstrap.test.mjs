// `tools/release-meta-bootstrap.mjs` 迁移种子测试（issue #43 / 设计稿 §12）。
//
// 3 个真实旧格式 carrier（缺顶层 appVersion）用**真实 tarball fixture** 模拟：
// 下载 → sha512 integrity 校验 → 解包 → 读内嵌 manifest.json 的 app.version。
// 全程离线（假 npm 适配器 + 本地 tar 文件），不触碰真实 npm / 真实分支。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
	tagFiles,
	tagSha,
	writeFakeState,
} from "./helpers/release-fixtures.mjs";
import { createAdapters } from "./helpers/fake-release-adapters.mjs";
import {
	HISTORICAL_TAG_BUILDS,
} from "./helpers/release-fixtures.mjs";
import {
	buildReleaseMetaSeed,
	checkPolicyAgainstSeed,
} from "../tools/release-meta-bootstrap.mjs";
import { readEmbeddedCarrierBuild } from "../tools/lib/release-adapters.mjs";
import { serializeBuildPolicy } from "../tools/lib/release-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "tools", "release-meta-bootstrap.mjs");

function sha512Base64(buffer) {
	return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

/** 生成一个只含 package/manifest.json（+package.json）的 carrier tarball。 */
function makeCarrierTarball(dir, version, appVersion) {
	const base = path.join(dir, `tar-${version}`);
	const pkgDir = path.join(base, "package");
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(path.join(pkgDir, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version })}\n`);
	fs.writeFileSync(path.join(pkgDir, "manifest.json"), `${JSON.stringify({ schema: 1, app: { version: appVersion } })}\n`);
	const tgz = path.join(dir, `marktrue-${version}.tgz`);
	const result = spawnSync("tar", ["-czf", tgz, "-C", base, "package"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return tgz;
}

function makeFixture(t, { corruptIntegrity = null, missingManifest = false } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bootstrap-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const versions = [];
	const metadata = {};
	const tarballs = {};
	for (const carrier of HISTORICAL_CARRIERS) {
		versions.push(carrier.version);
		if (carrier.legacy) {
			let tgz;
			if (missingManifest) {
				const base = path.join(dir, `no-manifest-${carrier.version}`);
				fs.mkdirSync(path.join(base, "package"), { recursive: true });
				fs.writeFileSync(path.join(base, "package", "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: carrier.version })}\n`);
				tgz = path.join(dir, `marktrue-${carrier.version}.tgz`);
				const packed = spawnSync("tar", ["-czf", tgz, "-C", base, "package"], { encoding: "utf8" });
				assert.equal(packed.status, 0, packed.stderr);
			} else {
				tgz = makeCarrierTarball(dir, carrier.version, `${carrier.version.slice(0, -4).split("-")[0]}+${carrier.appBuild}`);
			}
			tarballs[carrier.version] = tgz;
			const integrity = sha512Base64(fs.readFileSync(tgz));
			metadata[carrier.version] = {
				version: carrier.version,
				dist: { integrity: corruptIntegrity === carrier.version ? sha512Base64(Buffer.from("evil")) : integrity },
				...(corruptIntegrity === carrier.version ? {} : {}),
			};
		} else {
			metadata[carrier.version] = {
				version: carrier.version,
				appVersion: `${carrier.version.slice(0, -4).split("-")[0]}+${carrier.appBuild}`,
				dist: { integrity: carrier.integrity },
			};
		}
	}
	const state = {
		releaseMeta: null,
		tags: [...HISTORICAL_TAG_BUILDS.map(([tag]) => ({ name: tag, sha: tagSha(tag) })), { name: "v0.9.0-rc.1", sha: tagSha("v0.9.0-rc.1") }],
		tagFiles: tagFiles(),
		remoteTags: {},
		npm: { versions, metadata, distTags: {}, tarballs },
	};
	const stateFile = writeFakeState(dir, state);
	const adapters = createAdapters({ env: { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile } });
	const repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, "dsh-mobile-app"), { recursive: true });
	fs.writeFileSync(path.join(repo, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "3.2.4-alpha.1" })}\n`);
	fs.writeFileSync(path.join(repo, "dsh-mobile-app", "pubspec.yaml"), "name: dsh_mobile_app\nversion: 3.2.4+32\n");
	return { dir, state, stateFile, adapters, repo };
}

test("bootstrap: seed registers 8 tags + 8 carriers, legacy 3 verified via tarball manifest", async (t) => {
	const fixture = makeFixture(t);
	const seed = await buildReleaseMetaSeed({
		adapters: fixture.adapters,
		packageName: PACKAGE_NAME,
		currentBuild: 32,
	});
	assert.equal(seed.ok, true, JSON.stringify(seed.reasons));
	assert.equal(seed.policy.schema, 1);
	assert.equal(seed.policy.watermark, 32);
	assert.deepEqual(seed.policy.legacyTags, HISTORICAL_TAG_BUILDS.map(([tag]) => tag));
	assert.equal(seed.policy.legacyCarriers.length, 8);
	const byVersion = new Map(seed.policy.legacyCarriers.map((entry) => [entry.version, entry]));
	assert.equal(byVersion.get("3.2.1-alpha.1-app").appBuild, 24);
	assert.equal(byVersion.get("3.2.1-alpha.2-app").appBuild, 24);
	assert.equal(byVersion.get("3.2.1-alpha.3-app").appBuild, 25);
	assert.equal(byVersion.get("3.2.3-rc.1-app").appBuild, 28);
	assert.equal(seed.evidence.carriers.filter((entry) => entry.method === "manifest").length, 3);
	assert.equal(seed.evidence.carriers.filter((entry) => entry.method === "appVersion").length, 5);
	// 种子必须能通过自身 schema 校验。
	const parsed = JSON.parse(serializeBuildPolicy(seed.policy));
	assert.equal(parsed.watermark, 32);
});

test("bootstrap: watermark is raised to current develop build (never below 32)", async (t) => {
	const fixture = makeFixture(t);
	const seed = await buildReleaseMetaSeed({ adapters: fixture.adapters, packageName: PACKAGE_NAME, currentBuild: 40 });
	assert.equal(seed.ok, true);
	assert.equal(seed.policy.watermark, 40);
});

test("bootstrap fail-closed: legacy tarball integrity mismatch never registers a build", async (t) => {
	const fixture = makeFixture(t, { corruptIntegrity: "3.2.1-alpha.1-app" });
	const seed = await buildReleaseMetaSeed({ adapters: fixture.adapters, packageName: PACKAGE_NAME, currentBuild: 32 });
	assert.equal(seed.ok, false);
	assert.ok(seed.reasons.some((item) => item.code === "legacy-carrier-integrity-mismatch"));
});

test("bootstrap: embedded build unreadable (no manifest) fails closed instead of guessing", async (t) => {
	const fixture = makeFixture(t, { missingManifest: true });
	const seed = await buildReleaseMetaSeed({ adapters: fixture.adapters, packageName: PACKAGE_NAME, currentBuild: 32 });
	assert.equal(seed.ok, false);
	assert.ok(seed.reasons.some((item) => item.code === "legacy-carrier-build-unreadable"));
});

test("readEmbeddedCarrierBuild: manifest preferred, injected APK reader used as fallback", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-embedded-"));
	try {
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ app: { version: "3.2.1+24", file: "DSH-Remote-v3.2.1.apk" } }));
		const fromManifest = readEmbeddedCarrierBuild({ carrierDir: dir });
		assert.equal(fromManifest.ok, true);
		assert.equal(fromManifest.build, 24);
		assert.equal(fromManifest.evidence.method, "manifest");

		fs.rmSync(path.join(dir, "manifest.json"));
		let called = false;
		const fromApk = readEmbeddedCarrierBuild({
			carrierDir: dir,
			readApkBuild: () => { called = true; return 25; },
		});
		assert.equal(called, false, "没有 manifest.app.file 时不调用 APK 读取");
		assert.equal(fromApk.ok, false);

		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ app: { file: "DSH-Remote-v3.2.1.apk" } }));
		const fallback = readEmbeddedCarrierBuild({ carrierDir: dir, readApkBuild: () => { called = true; return 25; } });
		assert.equal(called, true);
		assert.equal(fallback.ok, true);
		assert.equal(fallback.build, 25);
		assert.equal(fallback.evidence.method, "apk");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bootstrap --check: policy matching observed data passes; drift fails with stable reasons", async (t) => {
	const fixture = makeFixture(t);
	const seed = await buildReleaseMetaSeed({ adapters: fixture.adapters, packageName: PACKAGE_NAME, currentBuild: 32 });
	assert.equal(seed.ok, true);
	assert.equal(checkPolicyAgainstSeed({ policy: seed.policy, seed }).ok, true);

	const missingTag = structuredClone(seed.policy);
	missingTag.legacyTags = missingTag.legacyTags.filter((tag) => tag !== "v3.2.1-alpha.2");
	const missingTagCheck = checkPolicyAgainstSeed({ policy: missingTag, seed });
	assert.equal(missingTagCheck.ok, false);
	assert.ok(missingTagCheck.reasons.some((item) => item.code === "legacy-tag-unregistered"));

	const missingCarrier = structuredClone(seed.policy);
	missingCarrier.legacyCarriers = missingCarrier.legacyCarriers.filter((entry) => entry.version !== "3.2.1-alpha.1-app");
	const missingCarrierCheck = checkPolicyAgainstSeed({ policy: missingCarrier, seed });
	assert.equal(missingCarrierCheck.ok, false);
	assert.ok(missingCarrierCheck.reasons.some((item) => item.code === "legacy-carrier-unregistered"));

	// m5：policy watermark 高于观测值（迁移时人工上调过）是合法的，不得误报 regressed。
	const raised = structuredClone(seed.policy);
	raised.watermark = 40;
	const raisedCheck = checkPolicyAgainstSeed({ policy: raised, seed });
	assert.equal(raisedCheck.ok, true, JSON.stringify(raisedCheck.reasons));

	// 只有 policy watermark **低于**观测值（会把水位往回写）才失败。
	const lowered = structuredClone(seed.policy);
	lowered.watermark = 20;
	const loweredCheck = checkPolicyAgainstSeed({ policy: lowered, seed });
	assert.equal(loweredCheck.ok, false);
	assert.ok(loweredCheck.reasons.some((item) => item.code === "build-policy-watermark-regressed"));

	const extra = structuredClone(seed.policy);
	extra.legacyCarriers.push({ version: "3.2.0-rc.1-app", integrity: `sha512-${"A".repeat(86)}==`, appBuild: 20 });
	const extraCheck = checkPolicyAgainstSeed({ policy: extra, seed });
	assert.equal(extraCheck.ok, false);
	assert.ok(extraCheck.reasons.some((item) => item.code === "legacy-carrier-unverified"));
});

test("bootstrap CLI: --write-ref seeds local release-meta via git plumbing adapter (no push)", (t) => {
	const fixture = makeFixture(t);
	const callsFile = path.join(fixture.dir, "calls.jsonl");
	const result = spawnSync(process.execPath, [
		CLI, "--json", "--root", fixture.repo, "--write-ref",
		"--adapters", FAKE_ADAPTERS,
	], {
		encoding: "utf8",
		env: {
			...process.env,
			DSH_RELEASE_FAKE_STATE: fixture.stateFile,
			DSH_RELEASE_FAKE_CALLS: callsFile,
		},
	});
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.branch.branch, "release-meta");
	assert.equal(parsed.branch.path, "build-policy.json");
	const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const branchCall = calls.find((call) => call.kind === "git.createBranchWithFile");
	assert.ok(branchCall, "必须用 git plumbing 创建本地分支");
	const policy = JSON.parse(branchCall.content);
	assert.equal(policy.watermark, 32);
	assert.equal(policy.legacyCarriers.length, 8);
});

test("bootstrap CLI: existing release-meta branch refused unless --force (no silent policy overwrite)", (t) => {
	const fixture = makeFixture(t);
	const existing = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
	existing.revParse = { "refs/heads/release-meta": "c".repeat(40) };
	existing.refFiles = {
		"refs/heads/release-meta": { "build-policy.json": JSON.stringify({ ...buildPolicySeed(), watermark: 32 }) },
	};
	const stateFile = writeFakeState(fixture.dir, existing);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: stateFile };
	const refused = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--write-ref", "--adapters", FAKE_ADAPTERS], { encoding: "utf8", env });
	assert.equal(refused.status, 1);
	const refusedResult = JSON.parse(refused.stdout);
	assert.equal(refusedResult.ok, false);
	assert.ok(refusedResult.reasons.some((item) => item.code === "release-meta-branch-exists"), JSON.stringify(refusedResult).slice(0, 800));
	const forced = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--write-ref", "--force", "--adapters", FAKE_ADAPTERS], { encoding: "utf8", env });
	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(JSON.parse(forced.stdout).ok, true);

	// m9：--force 也不得降低现有 watermark（本地分支记录 40 > seed 32）。
	existing.refFiles["refs/heads/release-meta"]["build-policy.json"] = JSON.stringify({ ...buildPolicySeed(), watermark: 40 });
	const regressedFile = writeFakeState(fixture.dir, existing);
	const regressed = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--write-ref", "--force", "--adapters", FAKE_ADAPTERS], {
		encoding: "utf8",
		env: { ...env, DSH_RELEASE_FAKE_STATE: regressedFile },
	});
	assert.equal(regressed.status, 1);
	assert.ok(JSON.parse(regressed.stdout).reasons.some((item) => item.code === "build-policy-watermark-regressed"), JSON.stringify(JSON.parse(regressed.stdout)).slice(0, 500));

	// m9：远端 origin/release-meta 水位更高时，首次创建本地分支也不得低于它。
	const remoteOnly = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
	remoteOnly.revParse = { "refs/remotes/origin/release-meta": "d".repeat(40) };
	remoteOnly.refFiles = {
		"refs/remotes/origin/release-meta": { "build-policy.json": JSON.stringify({ ...buildPolicySeed(), watermark: 40 }) },
	};
	const remoteFile = writeFakeState(fixture.dir, remoteOnly);
	const remote = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--write-ref", "--adapters", FAKE_ADAPTERS], {
		encoding: "utf8",
		env: { ...env, DSH_RELEASE_FAKE_STATE: remoteFile },
	});
	assert.equal(remote.status, 1);
	assert.ok(JSON.parse(remote.stdout).reasons.some((item) => item.code === "build-policy-watermark-regressed"));
});

test("bootstrap CLI: --write-ref without --json prints explicit push instructions (no automatic push)", (t) => {
	const fixture = makeFixture(t);
	const result = spawnSync(process.execPath, [
		CLI, "--root", fixture.repo, "--write-ref", "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile } });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /git push origin release-meta/);
	assert.match(result.stderr, /git push github release-meta/);
	assert.match(result.stdout, /RESULT: PASS/);
});

test("bootstrap CLI: default stdout is the seed policy JSON (redirectable)", (t) => {
	const fixture = makeFixture(t);
	const result = spawnSync(process.execPath, [
		CLI, "--root", fixture.repo, "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile } });
	assert.equal(result.status, 0, result.stderr);
	const policy = JSON.parse(result.stdout);
	assert.equal(policy.watermark, 32);
	assert.equal(policy.legacyTags.length, 8);
	assert.match(result.stderr, /watermark=32 legacyTags=8 legacyCarriers=8/);

	const seed = buildPolicySeed();
	assert.equal(seed.schema, 1);
});

test("bootstrap CLI: --out and --evidence write files; fail path exits non-zero", (t) => {
	const fixture = makeFixture(t);
	const out = path.join(fixture.dir, "policy.json");
	const evidence = path.join(fixture.dir, "evidence.json");
	const ok = spawnSync(process.execPath, [
		CLI, "--root", fixture.repo, "--out", out, "--evidence", evidence,
		"--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile } });
	assert.equal(ok.status, 0, ok.stderr);
	assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).legacyCarriers.length, 8);
	assert.equal(JSON.parse(fs.readFileSync(evidence, "utf8")).carriers.length, 8);

	const badState = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
	badState.npm.metadata["3.2.1-alpha.1-app"].dist.integrity = `sha512-${"B".repeat(86)}==`;
	const badFile = writeFakeState(fixture.dir, badState);
	const bad = spawnSync(process.execPath, [
		CLI, "--root", fixture.repo, "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: badFile } });
	assert.equal(bad.status, 1);
	assert.match(bad.stdout, /legacy-carrier-integrity-mismatch/);
	assert.match(bad.stdout, /RESULT: FAIL/);
});


// ── 复审补充（task-17）──────────────────────────────────────────────────────────────

test("m4: --keep retains downloaded/extracted carrier evidence instead of deleting it", async (t) => {
	const fixture = makeFixture(t);
	const seed = await buildReleaseMetaSeed({
		adapters: fixture.adapters,
		packageName: PACKAGE_NAME,
		currentBuild: 32,
		keepTarballs: true,
	});
	assert.equal(seed.ok, true, JSON.stringify(seed.reasons));
	assert.ok(seed.tempDir && fs.existsSync(seed.tempDir), "keepTarballs 必须保留临时目录并报告路径");
	t.after(() => { try { fs.rmSync(seed.tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });

	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile };
	const cli = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--keep", "--adapters", FAKE_ADAPTERS], { encoding: "utf8", env });
	assert.equal(cli.status, 0, cli.stderr);
	const result = JSON.parse(cli.stdout);
	assert.ok(result.tempDir && fs.existsSync(result.tempDir), "CLI --keep 必须保留并报告目录");
	t.after(() => { try { fs.rmSync(result.tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });
});

test("m5/n6: --check allows policy watermark above observed, rejects below; --watermark raises observed floor", (t) => {
	const fixture = makeFixture(t);
	const env = { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile };
	const seedCli = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--adapters", FAKE_ADAPTERS], { encoding: "utf8", env });
	assert.equal(seedCli.status, 0, seedCli.stderr);
	const seed = JSON.parse(seedCli.stdout);
	const policyFile = path.join(fixture.dir, "seed-policy.json");
	fs.writeFileSync(policyFile, JSON.stringify(seed.policy));

	// 默认 watermark 32：policy=32 == observed 32 → PASS。
	const passing = spawnSync(process.execPath, [CLI, "--json", "--root", fixture.repo, "--check", "--policy", policyFile, "--adapters", FAKE_ADAPTERS], { encoding: "utf8", env });
	assert.equal(passing.status, 0, passing.stdout + passing.stderr);

	// --watermark 40 抬高观测值：policy 32 < 40 → 应 fail（不得把水位往回写）。
	const raised = spawnSync(process.execPath, [
		CLI, "--json", "--root", fixture.repo, "--check", "--policy", policyFile, "--watermark", "40", "--adapters", FAKE_ADAPTERS,
	], { encoding: "utf8", env });
	assert.equal(raised.status, 1);
	const raisedResult = JSON.parse(raised.stdout);
	assert.ok(raisedResult.reasons.some((item) => item.code === "build-policy-watermark-regressed"), JSON.stringify(raisedResult).slice(0, 500));
});
