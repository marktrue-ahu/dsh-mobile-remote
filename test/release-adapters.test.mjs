// 默认 git/npm 适配器的**有界执行**测试（issue #43 复审 m3）。
//
// 用 PATH 上的假 `npm`/`git` 脚本模拟挂起命令，验证超时被转换为稳定的
// `npm-metadata-unavailable` / `git-metadata-unavailable` reason，而不是无限等待。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	createDefaultGitAdapter,
	createDefaultNpmAdapter,
	releaseTimeouts,
} from "../tools/lib/release-adapters.mjs";

function makeFakeBin(t, { npmBody = null, gitBody = null } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-adapters-bin-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const write = (name, body) => {
		const file = path.join(dir, name);
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
		fs.chmodSync(file, 0o755);
	};
	if (npmBody !== null) write("npm", npmBody);
	if (gitBody !== null) write("git", gitBody);
	return dir;
}

function envWithBin(binDir, extra = {}) {
	return {
		...process.env,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		...extra,
	};
}

test("m3: hanging npm view is bounded and mapped to npm-metadata-unavailable", (t) => {
	const bin = makeFakeBin(t, { npmBody: "sleep 5\nexit 0" });
	const env = envWithBin(bin, { DSH_RELEASE_NPM_VIEW_TIMEOUT_MS: "120" });
	const adapter = createDefaultNpmAdapter({ packageName: "@marktrue/dsh-mobile-remote", env });
	const started = Date.now();
	assert.throws(
		() => adapter.listVersions(),
		(error) => {
			assert.equal(error.releaseReason, "npm-metadata-unavailable");
			assert.match(String(error.message), /timed out/);
			return true;
		},
	);
	assert.ok(Date.now() - started < 4000, "超时必须有界（不得真的等 5s+）");
});

test("m3: hanging git command is bounded and mapped to git-metadata-unavailable", (t) => {
	const bin = makeFakeBin(t, { gitBody: "sleep 5\nexit 0" });
	const env = envWithBin(bin, { DSH_RELEASE_GIT_TIMEOUT_MS: "120" });
	const adapter = createDefaultGitAdapter({ repoRoot: os.tmpdir(), env });
	const started = Date.now();
	assert.throws(
		() => adapter.revParse("HEAD"),
		(error) => {
			assert.equal(error.releaseReason, "git-metadata-unavailable");
			assert.match(String(error.message), /timed out/);
			return true;
		},
	);
	assert.ok(Date.now() - started < 4000, "超时必须有界");
});

test("m3: adapters honour injected env and timeout overrides (normal path)", (t) => {
	const bin = makeFakeBin(t, { npmBody: 'printf \'["3.2.4-alpha.1"]\'' });
	const env = envWithBin(bin, { DSH_RELEASE_NPM_VIEW_TIMEOUT_MS: "5000" });
	const adapter = createDefaultNpmAdapter({ packageName: "@marktrue/dsh-mobile-remote", env });
	assert.deepEqual(adapter.listVersions(), ["3.2.4-alpha.1"]);
	assert.equal(releaseTimeouts(env).npmView, 5000);
});


test("default git adapter: createBranchWithFile uses bounded git plumbing (no working-tree switch)", (t) => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-adapters-git-"));
	t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
	const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	assert.equal(git("init", "-q").status, 0);
	assert.equal(git("config", "user.email", "test@example.com").status, 0);
	assert.equal(git("config", "user.name", "test").status, 0);
	fs.writeFileSync(path.join(repo, "README.md"), "base\n");
	assert.equal(git("add", "README.md").status, 0);
	assert.equal(git("commit", "-q", "-m", "base").status, 0);

	const adapter = createDefaultGitAdapter({ repoRoot: repo, env: { ...process.env } });
	const content = `${JSON.stringify({ schema: 1, watermark: 32 })}\n`;
	const created = adapter.createBranchWithFile({
		branch: "release-meta",
		base: "HEAD",
		path: "build-policy.json",
		content,
		message: "seed",
	});
	assert.equal(created.branch, "release-meta");
	const shown = git("show", "release-meta:build-policy.json");
	assert.equal(shown.status, 0, shown.stderr);
	assert.equal(shown.stdout, content);
	// 不切换工作树：当前分支仍是初始分支（master/main），工作区无 build-policy.json。
	assert.equal(fs.existsSync(path.join(repo, "build-policy.json")), false);
});
