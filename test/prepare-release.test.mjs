// `tools/prepare-release.mjs` 原子 bump 测试（issue #43 / 设计稿 §8）。
//
// 临时夹具目录 + 注入假 npm 适配器：不触碰真实工作树、不 tag、不 push、不发布。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FAKE_ADAPTERS, PACKAGE_NAME, fakeState, writeFakeState } from "./helpers/release-fixtures.mjs";
import { createAdapters } from "./helpers/fake-release-adapters.mjs";
import { prepareRelease, writeFilesAtomically } from "../tools/prepare-release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "tools", "prepare-release.mjs");
const RELEASE_CHECKS = path.join(ROOT, "dsh-mobile-app", "tools", "lib", "release-checks.mjs");

function makeFixture(t, { version = "3.2.4-alpha.1", build = 32, aliasVersion = "3.2.4-alpha.1", chain = true } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-prepare-release-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "repo");
	fs.mkdirSync(path.join(root, "dsh-mobile-app", "tools", "lib"), { recursive: true });
	fs.copyFileSync(RELEASE_CHECKS, path.join(root, "dsh-mobile-app", "tools", "lib", "release-checks.mjs"));
	const packageJson = {
		name: PACKAGE_NAME,
		version,
		optionalDependencies: { [`${PACKAGE_NAME}-app`]: `npm:${PACKAGE_NAME}@${aliasVersion}-app` },
	};
	fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	fs.writeFileSync(path.join(root, "dsh-mobile-app", "pubspec.yaml"), `name: dsh_mobile_app\nversion: 3.2.4+${build}\n`);
	fs.writeFileSync(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## v${version}（build ${build}）— 上一版\n\n旧内容\n`);
	const adapters = createAdapters({ env: { ...process.env, DSH_RELEASE_FAKE_STATE: writeFakeState(dir, fakeState()) } });
	const stateFile = path.join(dir, "fake-state.json");
	return { dir, root, stateFile, adapters, chain };
}

function snapshot(root) {
	return {
		packageJson: fs.readFileSync(path.join(root, "package.json"), "utf8"),
		pubspec: fs.readFileSync(path.join(root, "dsh-mobile-app", "pubspec.yaml"), "utf8"),
		changelog: fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"),
	};
}

test("prepare-release: atomically updates package.json version + exact alias, pubspec and CHANGELOG", async (t) => {
	const fixture = makeFixture(t);
	const before = snapshot(fixture.root);
	const result = await prepareRelease({
		root: fixture.root,
		version: "3.2.4-alpha.2",
		build: 33,
		adapters: fixture.adapters,
	});
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.version, "3.2.4-alpha.2");
	assert.equal(result.build, 33);

	const pkg = JSON.parse(fs.readFileSync(path.join(fixture.root, "package.json"), "utf8"));
	assert.equal(pkg.version, "3.2.4-alpha.2");
	assert.equal(pkg.optionalDependencies[`${PACKAGE_NAME}-app`], `npm:${PACKAGE_NAME}@3.2.4-alpha.2-app`);

	const pubspec = fs.readFileSync(path.join(fixture.root, "dsh-mobile-app", "pubspec.yaml"), "utf8");
	assert.match(pubspec, /^version: 3\.2\.4\+33$/m);
	const changelog = fs.readFileSync(path.join(fixture.root, "CHANGELOG.md"), "utf8");
	assert.match(changelog, /^## v3\.2\.4-alpha\.2（build 33，issues …）— 摘要/m);
	assert.match(changelog, /插件 `3\.2\.4-alpha\.2` \/ App `3\.2\.4\+33` \/ 载体 `3\.2\.4-alpha\.2-app`/);
	assert.match(changelog, /## v3\.2\.4-alpha\.1（build 32）— 上一版/);
	assert.notEqual(before.pubspec, pubspec);
});

test("prepare-release: npm version already published fails closed with no writes", async (t) => {
	const fixture = makeFixture(t);
	const before = snapshot(fixture.root);
	const state = fakeState();
	state.npm.metadata["3.2.4-alpha.2"] = { version: "3.2.4-alpha.2", dist: { integrity: "x" } };
	const adapters = createAdapters({ env: { ...process.env, DSH_RELEASE_FAKE_STATE: writeFakeState(fixture.dir, state) } });
	const result = await prepareRelease({ root: fixture.root, version: "3.2.4-alpha.2", build: 33, adapters });
	assert.equal(result.ok, false);
	assert.ok(result.reasons.some((item) => item.code === "npm-version-already-published"));
	assert.deepEqual(snapshot(fixture.root), before, "失败时不得留下半更新");
});

test("prepare-release: build must increase and be valid", async (t) => {
	const fixture = makeFixture(t);
	const before = snapshot(fixture.root);
	const same = await prepareRelease({ root: fixture.root, version: "3.2.4-alpha.2", build: 32, adapters: fixture.adapters });
	assert.equal(same.ok, false);
	assert.ok(same.reasons.some((item) => item.code === "build-not-increased"));
	const invalid = await prepareRelease({ root: fixture.root, version: "3.2.4-alpha.2", build: 0, adapters: fixture.adapters });
	assert.equal(invalid.ok, false);
	assert.deepEqual(snapshot(fixture.root), before);
});

test("prepare-release: invalid plugin version / current pubspec rejected", async (t) => {
	const fixture = makeFixture(t);
	const badVersion = await prepareRelease({ root: fixture.root, version: "3.2.4-", build: 33, adapters: fixture.adapters });
	assert.equal(badVersion.ok, false);
	assert.ok(badVersion.reasons.some((item) => item.code === "prepare-version-invalid"));

	const brokenRoot = path.join(fixture.dir, "broken");
	fs.mkdirSync(path.join(brokenRoot, "dsh-mobile-app"), { recursive: true });
	fs.writeFileSync(path.join(brokenRoot, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: "3.2.4-alpha.2" })}\n`);
	fs.writeFileSync(path.join(brokenRoot, "dsh-mobile-app", "pubspec.yaml"), "name: dsh_mobile_app\n");
	fs.writeFileSync(path.join(brokenRoot, "CHANGELOG.md"), "# Changelog\n");
	const broken = await prepareRelease({ root: brokenRoot, version: "3.2.4-alpha.2", build: 33, adapters: fixture.adapters });
	assert.equal(broken.ok, false);
	assert.ok(broken.reasons.some((item) => item.code === "pubspec-version-invalid" || item.code === "pubspec-version-missing"));
});

test("prepare-release: omitted --build allocates global next build from release-meta/tags/npm", async (t) => {
	const fixture = makeFixture(t);
	const result = await prepareRelease({ root: fixture.root, version: "3.2.4-alpha.2", adapters: fixture.adapters });
	assert.equal(result.ok, true, JSON.stringify(result.reasons));
	assert.equal(result.build, 33);
	const pubspec = fs.readFileSync(path.join(fixture.root, "dsh-mobile-app", "pubspec.yaml"), "utf8");
	assert.match(pubspec, /^version: 3\.2\.4\+33$/m);
});

test("prepare-release CLI: --json output, no tag/push", async (t) => {
	const fixture = makeFixture(t);
	const result = spawnSync(process.execPath, [
		CLI,
		"--root", fixture.root,
		"--version", "3.2.4-alpha.2",
		"--build", "34",
		"--adapters", FAKE_ADAPTERS,
		"--json",
	], { encoding: "utf8", env: { ...process.env, DSH_RELEASE_FAKE_STATE: fixture.stateFile } });
	assert.equal(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout);
	assert.equal(parsed.ok, true);
	assert.equal(parsed.version, "3.2.4-alpha.2");
	assert.equal(parsed.build, 34);
	const pubspec = fs.readFileSync(path.join(fixture.root, "dsh-mobile-app", "pubspec.yaml"), "utf8");
	assert.match(pubspec, /^version: 3\.2\.4\+34$/m);
});

test("prepare-release: atomic writer rolls back already-renamed files on later failure", (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-atomic-write-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const first = path.join(dir, "first.txt");
	const blocked = path.join(dir, "blocked");
	fs.writeFileSync(first, "before\n");
	fs.mkdirSync(blocked);
	const result = writeFilesAtomically([
		{ file: first, previous: "before\n", content: "after\n" },
		{ file: blocked, previous: "", content: "x\n" },
	]);
	assert.equal(result.ok, false);
	assert.equal(fs.readFileSync(first, "utf8"), "before\n", "已 rename 的文件必须回滚");
	const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
	assert.deepEqual(leftovers, [], "失败后不得遗留临时文件");
});
