import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

import { createGitService, parseGitBranches, parseGitCommits, parseGitStatus } from "../lib/git-service.js";

test("Git plugin only requires webServer and optional deps degrade safely", () => {
	assert.match(readFileSync(new URL("../lib/index.js", import.meta.url), "utf8"), /export const inject = \["webServer"\]/);
	const service = createGitService({ get() { throw new Error("missing service"); } });
	assert.equal(service.capabilities().available, false);
});

test("parseGitStatus consumes rename/copy source records", () => {
	const value = parseGitStatus("## main\0R  new name.txt\0old name.txt\0C  copy.txt\0source.txt\0?? untracked\0");
	assert.deepEqual(value.entries, [
		{ path: "new name.txt", oldPath: "old name.txt", index: "R", worktree: " ", rename: true },
		{ path: "copy.txt", oldPath: "source.txt", index: "C", worktree: " ", rename: true },
		{ path: "untracked", index: "?", worktree: "?", rename: false },
	]);
	assert.deepEqual(value.counts, { total: 3, staged: 2, unstaged: 1, untracked: 1 });
});

test("parseGitBranches removes git record newlines and classifies refs", () => {
	const output = [
		"refs/heads/app-auto-update\t11111111\t",
		"refs/heads/main\t22222222\t",
		"refs/remotes/origin/main\t33333333\t",
	].join("\0\n") + "\0\n";

	assert.deepEqual(parseGitBranches(output), [
		{ name: "refs/heads/app-auto-update", oid: "11111111", upstream: null, remote: false, displayName: "app-auto-update" },
		{ name: "refs/heads/main", oid: "22222222", upstream: null, remote: false, displayName: "main" },
		{ name: "refs/remotes/origin/main", oid: "33333333", upstream: null, remote: true, displayName: "origin/main" },
]);
});

test("parseGitCommits removes record framing line endings without a blank commit", () => {
	const output = [
		"11111111\x1f22222222 33333333\x1fAlice\x1f1700000000\x1fmerge\x1fHEAD -> refs/heads/main, tag: refs/tags/v1",
		"22222222\x1f44444444\x1fBob\x1f1690000000\x1ffeature\x1f",
	].join("\0\r\n") + "\0\n";

	assert.deepEqual(parseGitCommits(output), [
		{ oid: "11111111", parents: ["22222222", "33333333"], author: "Alice", timestamp: 1700000000, subject: "merge", refs: ["HEAD -> refs/heads/main", "tag: refs/tags/v1"] },
		{ oid: "22222222", parents: ["44444444"], author: "Bob", timestamp: 1690000000, subject: "feature", refs: [] },
	]);
});

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function subprocess() {
	return {
		spawn({ argv, cwd, env, signal }) {
			const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...(env ?? {}) } });
			if (signal) signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (value) => { stdout += value; });
			child.stderr.on("data", (value) => { stderr += value; });
			const done = new Promise((resolve) => child.on("close", (exitCode) => resolve({ exitCode })));
			return {
				done,
				collected: {
					stdout: { readFrom: async () => ({ text: stdout }) },
					stderr: { readFrom: async () => ({ text: stderr }) },
				},
			};
		},
	};
}

test("graph binds selected tips and paginates without duplicate commits", async () => {
	const root = mkdtempSync(`${tmpdir()}/dsh-git-graph-`);
	try {
		git(root, "init", "-b", "main");
		git(root, "config", "user.name", "Test User");
		git(root, "config", "user.email", "test@example.com");
		writeFileSync(`${root}/README.md`, "one\n");
		git(root, "add", "README.md");
		git(root, "commit", "-m", "one");
		git(root, "checkout", "-b", "feature");
		writeFileSync(`${root}/README.md`, "one\ntwo\n");
		git(root, "commit", "-am", "two");
		git(root, "checkout", "main");
		writeFileSync(`${root}/README.md`, "one\nmain\n");
		git(root, "commit", "-am", "main");
		const mainOid = git(root, "rev-parse", "refs/heads/main");
		const featureOid = git(root, "rev-parse", "refs/heads/feature");
		const service = createGitService({
			subprocess: subprocess(),
			get(name) {
				if (name === "workspaceRegistry") return { list: () => [{ path: root }] };
				throw new Error(`unknown context key: ${name}`);
			},
		});
		const first = await service.graph(root, { limit: 1, refs: [
			{ name: "refs/heads/main", tipOid: mainOid },
			{ name: "refs/heads/feature", tipOid: featureOid },
		] });
		assert.equal(first.commits.length, 1);
		assert.ok(first.snapshotId);
		assert.ok(first.nextCursor);
		const second = await service.graph(root, { limit: 20, cursor: first.nextCursor });
		const combined = [...first.commits, ...second.commits];
		assert.equal(new Set(combined.map((commit) => commit.oid)).size, combined.length);
		assert.ok(combined.some((commit) => commit.oid === mainOid));
		assert.ok(combined.some((commit) => commit.oid === featureOid));
		writeFileSync(`${root}/README.md`, "one\nmain\nchanged\n");
		git(root, "commit", "-am", "changed");
		await assert.rejects(
			() => service.graph(root, { limit: 1, cursor: first.nextCursor }),
			(error) => error.code === "graph-stale",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function serviceFor(root, onChanged) {
	return createGitService({ subprocess: subprocess(), get(name) {
		if (name === "workspaceRegistry") return { list: () => [{ path: root }] };
		throw new Error(`unknown context key: ${name}`);
	} }, { onChanged });
}

test("non-git context is a 404 and unborn graph is an empty page", async () => {
	const root = mkdtempSync(`${tmpdir()}/dsh-empty-git-`);
	try {
		const service = serviceFor(root);
		await assert.rejects(() => service.context({ cwd: root }), (e) => e.code === "not-git-repository" && e.status === 404);
		git(root, "init", "-b", "main");
		const page = await service.graph(root);
		assert.deepEqual(page.commits, []);
		assert.equal(page.nextCursor, null);
		assert.ok(page.snapshotId);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("root commit diff contains added file content", async () => {
	const root = mkdtempSync(`${tmpdir()}/dsh-root-diff-`);
	try {
		git(root, "init", "-b", "main");
		git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com");
		writeFileSync(`${root}/new.txt`, "root content\n"); git(root, "add", "new.txt"); git(root, "commit", "-m", "root");
		const oid = git(root, "rev-parse", "HEAD");
		const diff = await serviceFor(root).diff(root, { kind: "commit", oid });
		assert.match(diff.text, /root content/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("deleted selected ref invalidates an existing graph snapshot", async () => {
	const root = mkdtempSync(`${tmpdir()}/dsh-stale-ref-`);
	try {
		git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com");
		writeFileSync(`${root}/a`, "a\n"); git(root, "add", "a"); git(root, "commit", "-m", "a");
		writeFileSync(`${root}/a`, "b\n"); git(root, "commit", "-am", "b"); git(root, "branch", "topic");
		const oid = git(root, "rev-parse", "refs/heads/topic"); const service = serviceFor(root);
		const first = await service.graph(root, { limit: 1, refs: [{ name: "refs/heads/topic", tipOid: oid }] });
		git(root, "branch", "-D", "topic");
		await assert.rejects(() => service.graph(root, { cursor: first.nextCursor }), (e) => e.code === "graph-stale" && e.status === 409);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("polling observes repository roots resolved from a subdirectory", async () => {
	const workspace = mkdtempSync(`${tmpdir()}/dsh-workspace-`); const root = `${workspace}/repo`; const subdir = `${root}/nested`;
	try {
		mkdirSync(root, { recursive: true });
		// repository is nested below the registered workspace root
		git(root, "init", "-b", "main"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@example.com");
		mkdirSync(subdir, { recursive: true }); writeFileSync(`${root}/a`, "a\n"); git(root, "add", "a"); git(root, "commit", "-m", "a");
		const events = []; const service = createGitService({ subprocess: subprocess(), get(name) { if (name === "workspaceRegistry") return { list: () => [{ path: workspace }] }; throw new Error(name); } }, { onChanged: (r) => events.push(r) });
		await service.context({ cwd: subdir }); await service.start(); await service._pollOnce();
		writeFileSync(`${root}/a`, "changed\n"); await service._pollOnce();
		assert.ok(events.includes(root)); service.stop();
	} finally { rmSync(workspace, { recursive: true, force: true }); }
});
