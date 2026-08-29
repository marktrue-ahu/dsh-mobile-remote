import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createGitService } from "../lib/git-service.js";
import { createGitOperationManager } from "../lib/git-operations.js";
import { createGitWriteService } from "../lib/git-write-service.js";

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
			let stdout = ""; let stderr = "";
			child.stdout.on("data", (value) => { stdout += value; });
			child.stderr.on("data", (value) => { stderr += value; });
			const done = new Promise((resolve) => child.on("close", (exitCode) => resolve({ exitCode })));
			return { done, collected: { stdout: { readFrom: async () => ({ text: stdout }) }, stderr: { readFrom: async () => ({ text: stderr }) } } };
		},
	};
}
function waitFor(manager, operationId) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			const operation = manager.get(operationId);
			if (["succeeded", "failed", "cancelled", "conflicted", "unknown-result"].includes(operation.status)) return resolve(operation);
			if (Date.now() - started > 5000) return reject(new Error("operation timeout"));
			setTimeout(tick, 10);
		};
		tick();
	});
}
async function fixture(options = {}) {
	const root = mkdtempSync(`${tmpdir()}/dsh-git-write-`);
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "B1 Test");
	git(root, "config", "user.email", "b1@example.com");
	writeFileSync(`${root}/tracked.txt`, "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n");
	git(root, "add", "tracked.txt");
	git(root, "commit", "-m", "base");
	const gitService = createGitService({ subprocess: subprocess(), get(name) { if (name === "workspaceRegistry") return { list: () => [{ path: root }] }; throw new Error(name); } });
	const context = await gitService.context({ cwd: root });
	assert.match(context.repositoryId, /^repo_[0-9a-f]{32}$/);
	assert.equal(Object.hasOwn(context, "root"), false);
	const operations = createGitOperationManager({ filePath: `${root}.dsh-operations.log` });
	await operations.start();
	const writes = createGitWriteService({ git: gitService, operations, ...options });
	return { root, repositoryId: context.repositoryId, operations, writes, cleanup() { writes.stop(); operations.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("B1 write operations reject host paths instead of treating them as repository IDs", async () => {
	const f = await fixture();
	try {
		await assert.rejects(() => f.writes.createChangeSet({ repositoryId: f.root, kind: "working" }), (error) => error.code === "workspace-not-allowed");
	} finally { f.cleanup(); }
});

test("B1 refuses a Git index configured outside the repository metadata directory", async () => {
	const f = await fixture();
	try {
		const externalIndex = `${f.root}.external-index`;
		const originalIndex = readFileSync(`${f.root}/.git/index`);
		writeFileSync(externalIndex, originalIndex);
		unlinkSync(`${f.root}/.git/index`);
		symlinkSync(externalIndex, `${f.root}/.git/index`);
		writeFileSync(`${f.root}/new.txt`, "new content\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-006", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "failed");
		assert.equal(done.errorCode, "workspace-not-allowed");
		assert.deepEqual(readFileSync(externalIndex), originalIndex);
	} finally { f.cleanup(); }
});

test("B1 reports unknown-result when index installation succeeds but verification callback fails", async () => {
	const f = await fixture({ onChanged: () => { throw new Error("observer failed"); } });
	try {
		writeFileSync(`${f.root}/new.txt`, "new content\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-007", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "unknown-result");
	} finally { f.cleanup(); }
});

test("B1 stages a selected hunk through a temporary index", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/tracked.txt`, "one\ntwo changed\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten changed\neleven\ntwelve\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		assert.equal(changes.files.length, 1);
		assert.ok(changes.files[0].hunks.length >= 2);
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-001", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId, hunkIds: [changes.files[0].hunks[0].hunkId] }], preconditionToken: changes.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		const staged = git(f.root, "diff", "--cached");
		const unstaged = git(f.root, "diff");
		assert.match(staged, /two changed/);
		assert.doesNotMatch(staged, /ten changed/);
		assert.match(unstaged, /ten changed/);
	} finally { f.cleanup(); }
});

test("B1 rejects a stage task when the change-set facts are stale", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/tracked.txt`, "changed\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		writeFileSync(`${f.root}/tracked.txt`, "changed again\n");
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-003", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "failed");
		assert.equal(done.errorCode, "state-changed");
	} finally { f.cleanup(); }
});

test("B1 stages an untracked file and commits the exact staged tree without hooks", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/new.txt`, "new content\n");
		writeFileSync(`${f.root}/.git/hooks/pre-commit`, "#!/bin/sh\nexit 1\n");
		chmodSync(`${f.root}/.git/hooks/pre-commit`, 0o755);
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-002", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId, hunkIds: [] }], preconditionToken: changes.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded", JSON.stringify(f.operations.get(operation.operationId)));
		const preflight = await f.writes.commitPreflight({ repositoryId: f.repositoryId, message: "add new file" });
		const commit = await f.writes.submitCommit({ repositoryId: f.repositoryId, requestId: "b1-commit-001", message: "add new file", preconditionToken: preflight.preconditionToken, confirm: true });
		const done = await waitFor(f.operations, commit.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "log", "-1", "--format=%s"), "add new file");
		assert.equal(git(f.root, "show", "-s", "--format=%T", "HEAD"), preflight.stagedTree);
	} finally { f.cleanup(); }
});

test("B1 can commit a staged deletion that leaves an empty index", async () => {
	const f = await fixture();
	try {
		rmSync(`${f.root}/tracked.txt`);
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const stage = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-005", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		assert.equal((await waitFor(f.operations, stage.operationId)).status, "succeeded");
		const preflight = await f.writes.commitPreflight({ repositoryId: f.repositoryId, message: "remove tracked file" });
		const commit = await f.writes.submitCommit({ repositoryId: f.repositoryId, requestId: "b1-commit-003", message: "remove tracked file", preconditionToken: preflight.preconditionToken, confirm: true });
		assert.equal((await waitFor(f.operations, commit.operationId)).status, "succeeded");
		assert.equal(git(f.root, "ls-tree", "-r", "--name-only", "HEAD"), "");
	} finally { f.cleanup(); }
});

test("B1 rejects commit when identity changes after preflight", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/new.txt`, "new content\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const stage = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-008", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		assert.equal((await waitFor(f.operations, stage.operationId)).status, "succeeded");
		const preflight = await f.writes.commitPreflight({ repositoryId: f.repositoryId, message: "identity stale" });
		git(f.root, "config", "user.email", "changed@example.com");
		const commit = await f.writes.submitCommit({ repositoryId: f.repositoryId, requestId: "b1-commit-004", message: "identity stale", preconditionToken: preflight.preconditionToken, confirm: true });
		const done = await waitFor(f.operations, commit.operationId);
		assert.equal(done.status, "failed");
		assert.equal(done.errorCode, "state-changed");
	} finally { f.cleanup(); }
});

test("B1 rejects commit when HEAD changes after preflight", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/new.txt`, "new content\n");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "working" });
		const stage = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-stage-004", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken });
		assert.equal((await waitFor(f.operations, stage.operationId)).status, "succeeded");
		const preflight = await f.writes.commitPreflight({ repositoryId: f.repositoryId, message: "stale commit" });
		git(f.root, "commit", "--allow-empty", "-m", "external");
		const commit = await f.writes.submitCommit({ repositoryId: f.repositoryId, requestId: "b1-commit-002", message: "stale commit", preconditionToken: preflight.preconditionToken, confirm: true });
		const done = await waitFor(f.operations, commit.operationId);
		assert.equal(done.status, "failed");
		assert.equal(done.errorCode, "state-changed");
	} finally { f.cleanup(); }
});

test("B1 unstages a full file without changing the worktree", async () => {
	const f = await fixture();
	try {
		writeFileSync(`${f.root}/tracked.txt`, "changed\n");
		git(f.root, "add", "tracked.txt");
		const changes = await f.writes.createChangeSet({ repositoryId: f.repositoryId, kind: "staged" });
		const operation = await f.writes.submitStage({ repositoryId: f.repositoryId, requestId: "b1-unstage-001", changeSetId: changes.changeSetId, selections: [{ fileId: changes.files[0].fileId }], preconditionToken: changes.preconditionToken, unstage: true });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded", JSON.stringify(f.operations.get(operation.operationId)));
		assert.equal(git(f.root, "diff", "--cached"), "");
		assert.match(git(f.root, "diff"), /changed/);
	} finally { f.cleanup(); }
});
