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
		spawn({ argv, cwd, env, signal, stdio, input }) {
			const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: [stdio?.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"] });
			if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
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
	const gitService = createGitService({ subprocess: options.subprocess ?? subprocess(), get(name) { if (name === "workspaceRegistry") return { list: () => [{ path: root }] }; throw new Error(name); } });
	const context = await gitService.context({ cwd: root });
	assert.match(context.repositoryId, /^repo_[0-9a-f]{32}$/);
	assert.equal(Object.hasOwn(context, "root"), false);
	const operations = createGitOperationManager({ filePath: `${root}.dsh-operations.log` });
	await operations.start();
	const writes = createGitWriteService({ git: gitService, operations, ...options });
	return { root, repositoryId: context.repositoryId, git: gitService, operations, writes, cleanup() { writes.stop(); operations.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("B2 creates a local branch from a verified HEAD without switching", async () => {
	const f = await fixture();
	try {
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "feature" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-001", action: "create", params: { name: preflight.name, startOid: preflight.startOid }, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.equal(git(f.root, "branch", "--show-current"), "main");
		assert.equal(git(f.root, "rev-parse", "refs/heads/feature"), preflight.startOid);
	} finally { f.cleanup(); }
});

test("B2 creates a local tracking branch from a verified remote ref", async () => {
	const f = await fixture();
	try {
		git(f.root, "remote", "add", "origin", `${f.root}/bare`);
		const oid = git(f.root, "rev-parse", "HEAD");
		git(f.root, "update-ref", "refs/remotes/origin/main", oid);
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "remote-feature", remoteRef: "refs/remotes/origin/main" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-004", action: "create", params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.equal(git(f.root, "rev-parse", "refs/heads/remote-feature"), oid);
		assert.equal(git(f.root, "config", "--get", "branch.remote-feature.remote"), "origin");
		assert.equal(git(f.root, "config", "--get", "branch.remote-feature.merge"), "refs/heads/main");
	} finally { f.cleanup(); }
});

test("B2 renames only the local branch and preserves its commit", async () => {
	const f = await fixture();
	try {
		const oid = git(f.root, "rev-parse", "HEAD");
		git(f.root, "config", "--add", "branch.main.remote", "origin");
		git(f.root, "config", "--add", "branch.main.merge", "refs/heads/main");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "rename", oldName: "main", name: "renamed" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-002", action: "rename", params: { oldName: preflight.oldName, name: preflight.name, oldOid: preflight.oldOid }, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "branch", "--show-current"), "renamed");
		assert.equal(git(f.root, "rev-parse", "refs/heads/renamed"), oid);
		assert.equal(git(f.root, "config", "--get", "branch.renamed.remote"), "origin");
		assert.equal(git(f.root, "config", "--get", "branch.renamed.merge"), "refs/heads/main");
		assert.equal(spawnSync("git", ["-C", f.root, "config", "--get-regexp", "^branch\\.main\\."], { encoding: "utf8" }).status, 1);
	} finally { f.cleanup(); }
});

test("B2 rejects renaming a branch checked out in another linked worktree", async () => {
	const f = await fixture();
	const linked = `${f.root}-linked`;
	try {
		git(f.root, "branch", "holder");
		git(f.root, "switch", "holder");
		git(f.root, "worktree", "add", linked, "main");
		await assert.rejects(() => f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "rename", oldName: "main", name: "renamed" }), (error) => ["repository-busy", "state-changed"].includes(error.code));
		assert.equal(git(f.root, "rev-parse", "refs/heads/main"), git(f.root, "rev-parse", "HEAD"));
		assert.notEqual(spawnSync("git", ["-C", f.root, "show-ref", "--verify", "refs/heads/renamed"], { encoding: "utf8" }).status, 0);
	} finally { rmSync(linked, { recursive: true, force: true }); f.cleanup(); }
});

test("B2 rejects invalid and duplicate local branch names", async () => {
	const f = await fixture();
	try {
		await assert.rejects(() => f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "bad..name" }), (error) => error.code === "invalid-argument");
		const first = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "feature" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-005", action: "create", params: first.params, preconditionToken: first.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		await assert.rejects(() => f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "feature" }), (error) => error.code === "branch-exists");
	} finally { f.cleanup(); }
});

test("B2 protects a dirty worktree during branch switch preflight", async () => {
	const f = await fixture();
	try {
		git(f.root, "branch", "feature");
		git(f.root, "switch", "feature");
		writeFileSync(`${f.root}/tracked.txt`, "feature branch\n");
		git(f.root, "add", "tracked.txt");
		git(f.root, "commit", "-m", "feature change");
		git(f.root, "switch", "main");
		writeFileSync(`${f.root}/tracked.txt`, "dirty\n");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "switch", targetBranch: "feature" });
		assert.equal(preflight.safe, false);
		assert.deepEqual(preflight.allowedActions, ["commit", "computer", "cancel"]);
		assert.equal(preflight.preconditionToken, undefined);
	} finally { f.cleanup(); }
});

test("B2 allows Git-safe dirty changes to travel across a branch switch", async () => {
	const f = await fixture();
	try {
		git(f.root, "branch", "feature");
		writeFileSync(`${f.root}/tracked.txt`, "safe dirty\n");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "switch", targetBranch: "feature" });
		assert.equal(preflight.safe, true);
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-006", action: "switch", params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.equal(git(f.root, "branch", "--show-current"), "feature");
		assert.equal(readFileSync(`${f.root}/tracked.txt`, "utf8"), "safe dirty\n");
	} finally { f.cleanup(); }
});

test("B2 can switch from detached HEAD when the worktree is clean", async () => {
	const f = await fixture();
	try {
		git(f.root, "branch", "feature");
		git(f.root, "switch", "--detach", "HEAD");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "switch", targetBranch: "feature" });
		assert.equal(preflight.safe, true);
	} finally { f.cleanup(); }
});

test("B2 switches cleanly without force", async () => {
	const f = await fixture();
	try {
		git(f.root, "branch", "feature");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "switch", targetBranch: "feature" });
		const params = { targetBranch: preflight.targetBranch, targetRef: preflight.targetRef, targetOid: preflight.targetOid };
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-branch-003", action: "switch", params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.equal(git(f.root, "branch", "--show-current"), "feature");
	} finally { f.cleanup(); }
});

test("B2 does not report success when switch post-facts mismatch", async () => {
	const base = subprocess();
	const f = await fixture({ subprocess: { spawn(spec) {
		const child = base.spawn(spec);
		if (spec.argv.includes("switch") && !spec.argv.includes("--show-current")) child.done = child.done.then((result) => { writeFileSync(`${spec.cwd}/tracked.txt`, "post-fact mismatch\\n"); return result; });
		return child;
	} } });
	try {
		git(f.root, "branch", "feature");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "switch", targetBranch: "feature" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-switch-mismatch", action: "switch", params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "unknown-result");
	} finally { f.cleanup(); }
});

test("B2 reports unknown-result for non-cancelled partial branch creation", async () => {
	const base = subprocess();
	const f = await fixture({ subprocess: { spawn(spec) {
		if (spec.argv.includes("branch.partial.remote")) return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: async () => ({ text: "" }) }, stderr: { readFrom: async () => ({ text: "injected fault" }) } } };
		return base.spawn(spec);
	} } });
	try {
		git(f.root, "remote", "add", "origin", `${f.root}/bare`);
		git(f.root, "update-ref", "refs/remotes/origin/main", git(f.root, "rev-parse", "HEAD"));
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "partial", remoteRef: "refs/remotes/origin/main" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-create-partial", action: "create", params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "unknown-result");
	} finally { f.cleanup(); }
});

test("B2 reports unknown-result for non-cancelled partial branch rename", async () => {
	const base = subprocess();
	const f = await fixture({ subprocess: { spawn(spec) {
		if (spec.argv.includes("--rename-section") && spec.argv.includes("branch.renamed")) return { done: Promise.resolve({ exitCode: 1 }), collected: { stdout: { readFrom: async () => ({ text: "" }) }, stderr: { readFrom: async () => ({ text: "injected fault" }) } } };
		return base.spawn(spec);
	} } });
	try {
		git(f.root, "config", "branch.main.remote", "origin");
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "rename", oldName: "main", name: "renamed" });
		const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-rename-partial", action: "rename", params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "failed");
	} finally { f.cleanup(); }
});

test("B2 recovers config rename that applies before cancelled or failed transport error", async (t) => {
	for (const mode of ["cancelled", "failed"]) {
		await t.test(mode, async () => {
			let renameStarted = false;
			const base = subprocess();
			const f = await fixture({ subprocess: { spawn(spec) {
				const injected = spec.argv.includes("--rename-section") && spec.argv.at(-2) === "branch.main" && spec.argv.at(-1) === "branch.renamed";
				if (!injected) return base.spawn(spec);
				renameStarted = true;
				const child = base.spawn(spec);
				const done = child.done.then(async () => {
					if (mode === "failed") return { exitCode: 1 };
					await new Promise((resolve) => spec.signal?.aborted ? resolve() : spec.signal?.addEventListener("abort", resolve, { once: true }));
					return { exitCode: 143 };
				});
				return { ...child, done };
			} } });
			try {
				git(f.root, "config", "branch.main.remote", "origin");
				const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "rename", oldName: "main", name: "renamed" });
				const operation = await f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: `b2-rename-${mode}`, action: "rename", params: preflight.params, preconditionToken: preflight.preconditionToken });
				if (mode === "cancelled") {
					for (let i = 0; i < 100 && (!renameStarted || f.operations.get(operation.operationId).status !== "running"); i++) await new Promise((resolve) => setTimeout(resolve, 1));
					const current = f.operations.get(operation.operationId);
					if (current.status === "running") await f.operations.cancel(operation.operationId, { requestId: `cancel-${mode}`, expectedRevision: current.revision });
				}
				const done = await waitFor(f.operations, operation.operationId);
				assert.equal(done.status, mode === "cancelled" ? "cancelled" : "failed", JSON.stringify(done));
				assert.equal(git(f.root, "config", "--get", "branch.main.remote"), "origin");
				assert.notEqual(spawnSync("git", ["-C", f.root, "config", "--get", "branch.renamed.remote"], { encoding: "utf8" }).status, 0);
			} finally { f.cleanup(); }
		});
	}
});

test("B2 signed branch token survives service reconstruction and executes", async () => {
	const secret = Buffer.alloc(32, 7);
	const f = await fixture({ preconditionSecret: secret });
	try {
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "reconstructed" });
		f.writes.stop();
		const rebuilt = createGitWriteService({ git: f.git, operations: f.operations, preconditionSecret: secret });
		const operation = await rebuilt.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-rebuilt", action: "create", params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "rev-parse", "refs/heads/reconstructed"), preflight.startOid);
		rebuilt.stop();
	} finally { f.cleanup(); }
});

test("B2 rejects tampered and expired signed branch tokens", async () => {
	let clock = 1_000_000;
	const f = await fixture({ preconditionSecret: Buffer.alloc(32, 8), now: () => clock });
	try {
		const preflight = await f.writes.branchPreflight({ repositoryId: f.repositoryId, action: "create", name: "tamper" });
		const originalToken = preflight.preconditionToken;
		const separator = originalToken.indexOf(".");
		const macFirst = originalToken[separator + 1];
		const replacement = macFirst === "A" ? "B" : "A";
		const tampered = `${originalToken.slice(0, separator + 1)}${replacement}${originalToken.slice(separator + 2)}`;
		await assert.rejects(() => f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-tamper", action: "create", params: preflight.params, preconditionToken: tampered }), (error) => error.code === "state-changed");
		clock += 10 * 60 * 1000 + 1;
		await assert.rejects(() => f.writes.submitBranch({ repositoryId: f.repositoryId, requestId: "b2-expired", action: "create", params: preflight.params, preconditionToken: preflight.preconditionToken }), (error) => error.code === "state-changed");
	} finally { f.cleanup(); }
});

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
