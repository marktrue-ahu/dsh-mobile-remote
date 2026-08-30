import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createGitService } from "../lib/git-service.js";
import { createGitOperationManager, GitOperationError } from "../lib/git-operations.js";
import { createGitRemoteService } from "../lib/git-remote-service.js";

function git(cwd, ...args) {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function waitFor(manager, operationId) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			const value = manager.get(operationId);
			if (["succeeded", "failed", "cancelled", "conflicted", "unknown-result"].includes(value.status)) return resolve(value);
			if (Date.now() - started > 8000) return reject(new Error(`operation timeout: ${operationId}`));
			setTimeout(tick, 10);
		};
		tick();
	});
}
// Keep the B3 fixture independent of the host subprocess implementation.
function makeSubprocess() {
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

async function fixture({ onChanged } = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsh-git-b3-work-"));
	const bare = mkdtempSync(join(tmpdir(), "dsh-git-b3-bare-"));
	const peer = mkdtempSync(join(tmpdir(), "dsh-git-b3-peer-"));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "B3 Work");
	git(root, "config", "user.email", "b3-work@example.com");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git(root, "add", "tracked.txt");
	git(root, "commit", "-m", "base");
	git(bare, "init", "--bare");
	git(root, "remote", "add", "origin", bare);
	git(root, "push", "-u", "origin", "main");
	git(peer, "clone", bare, ".");
	git(peer, "config", "user.name", "B3 Peer");
	git(peer, "config", "user.email", "b3-peer@example.com");
	const gitService = createGitService({ subprocess: makeSubprocess(), get(name) { if (name === "workspaceRegistry") return { list: () => [{ path: root }] }; throw new Error(name); } });
	const context = await gitService.context({ cwd: root });
	const operations = createGitOperationManager({ filePath: `${root}.operations.log` });
	await operations.start();
	const writes = createGitRemoteService({ git: gitService, operations, preconditionSecret: Buffer.alloc(32, 3), onChanged });
	return { root, bare, peer, repositoryId: context.repositoryId, git: gitService, operations, writes, cleanup() { writes.stop(); operations.stop(); rmSync(root, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); rmSync(peer, { recursive: true, force: true }); } };
}

function peerCommit(f, text, message = "peer change") {
	writeFileSync(join(f.peer, "tracked.txt"), text);
	git(f.peer, "add", "tracked.txt");
	git(f.peer, "commit", "-m", message);
	git(f.peer, "push", "origin", "main");
	return git(f.peer, "rev-parse", "HEAD");
}
function localCommit(f, text, message = "local change") {
	writeFileSync(join(f.root, "tracked.txt"), text);
	git(f.root, "add", "tracked.txt");
	git(f.root, "commit", "-m", message);
	return git(f.root, "rev-parse", "HEAD");
}

const request = (name) => `b3-${name}-12345678`;

test("B3 remotes expose configured targets without host credentials", async () => {
	const f = await fixture();
	try {
		const value = await f.writes.remotes(f.repositoryId);
		assert.equal(value.remotes.length, 1);
		assert.equal(value.remotes[0].name, "origin");
		assert.equal(value.remotes[0].fetchUrl, "[local-remote]");
		assert.equal(value.remotes[0].branches.some((branch) => branch.branch === "main"), true);
		assert.equal(value.localBranches[0].upstream, "origin/main");
	} finally { f.cleanup(); }
});

test("B3 remotes adapter strips provider-only fields and rejects malformed facts", async () => {
	const f = await fixture();
	try {
		const source = await f.git.remotes(f.repositoryId);
		f.git.remotes = async () => ({ ...source, providerSecret: "must-not-leak", remotes: source.remotes.map((remote) => ({ ...remote, providerSecret: "must-not-leak" })) });
		const value = await f.writes.remotes(f.repositoryId);
		assert.deepEqual(Object.keys(value).sort(), ["localBranches", "remotes", "repositoryId", "stateVersion"]);
		assert.deepEqual(Object.keys(value.remotes[0]).sort(), ["branches", "fetchUrl", "name", "pushUrl"]);
		f.git.remotes = async () => ({ ...source, stateVersion: null });
		await assert.rejects(() => f.writes.remotes(f.repositoryId), (error) => error.code === "provider-invalid-response");
	} finally { f.cleanup(); }
});

test("B3 fetch updates only the remote-tracking ref", async () => {
	const f = await fixture();
	try {
		const beforeHead = git(f.root, "rev-parse", "HEAD");
		const target = peerCommit(f, "remote\n");
		const preflight = await f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main" });
		const operation = await f.writes.submitFetch({ repositoryId: f.repositoryId, requestId: request("fetch"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "rev-parse", "HEAD"), beforeHead);
		assert.equal(git(f.root, "rev-parse", "refs/remotes/origin/main"), target);
		assert.match(done.result.fetchResultId, /^[0-9a-f-]{36}$/);
	} finally { f.cleanup(); }
});

test("B3 cancellation stops a running fetch without claiming rollback", async () => {
	const f = await fixture();
	try {
		peerCommit(f, "remote cancellation\n");
		const preflight = await f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main" });
		const original = f.git.runCommand.bind(f.git);
		f.git.runCommand = async (argv, root, signal, options) => {
			if (argv.includes("fetch")) {
				await new Promise((resolve) => signal?.aborted ? resolve() : signal?.addEventListener("abort", resolve, { once: true }));
				throw new Error("terminated by cancellation");
			}
			return original(argv, root, signal, options);
		};
		const operation = await f.writes.submitFetch({ repositoryId: f.repositoryId, requestId: request("cancel-fetch"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		let running;
		await new Promise((resolve, reject) => {
			const started = Date.now();
			const tick = () => {
				running = f.operations.get(operation.operationId);
				if (running.status === "running") return resolve();
				if (Date.now() - started > 3000) return reject(new Error("fetch did not start"));
				setTimeout(tick, 5);
			};
			tick();
		});
		await f.operations.cancel(operation.operationId, { requestId: request("cancel-control"), expectedRevision: running.revision });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "cancelled", JSON.stringify(done));
		assert.equal(done.result.stages[0].status, "cancelled");
	} finally { f.cleanup(); }
});

test("B3 classifies a transport error after a fetched ref update as unknown-result", async () => {
	const f = await fixture();
	try {
		peerCommit(f, "remote uncertain\n");
		const preflight = await f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main" });
		const original = f.git.runCommand.bind(f.git);
		f.git.runCommand = async (argv, ...rest) => {
			const result = await original(argv, ...rest);
			if (argv.includes("fetch")) throw new Error("connection closed after fetch");
			return result;
		};
		const operation = await f.writes.submitFetch({ repositoryId: f.repositoryId, requestId: request("unknown"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "unknown-result", JSON.stringify(done));
		assert.equal(done.errorCode, "unknown-result");
		assert.equal(done.result.stages[0].status, "unknown-result");
	} finally { f.cleanup(); }
});

test("B3 normalizes provider command errors without exposing stderr", async () => {
	const f = await fixture();
	try {
		const preflight = await f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main" });
		const original = f.git.runCommand.bind(f.git);
		f.git.runCommand = async (argv, ...rest) => {
			if (argv.includes("fetch")) throw new GitOperationError("git-command-failed", "fatal: credential=super-secret");
			return original(argv, ...rest);
		};
		const operation = await f.writes.submitFetch({ repositoryId: f.repositoryId, requestId: request("provider-error"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "failed", JSON.stringify(done));
		assert.equal(done.errorCode, "auth-failed");
		assert.doesNotMatch(JSON.stringify(done), /super-secret/);
	} finally { f.cleanup(); }
});

test("B3 successful remote mutations publish Git change hints", async () => {
	const changes = [];
	const f = await fixture({ onChanged: (repositoryId, changeKinds) => changes.push({ repositoryId, changeKinds }) });
	try {
		peerCommit(f, "remote event\n");
		const preflight = await f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main" });
		const operation = await f.writes.submitFetch({ repositoryId: f.repositoryId, requestId: request("event"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.deepEqual(changes, [{ repositoryId: f.repositoryId, changeKinds: "remote-tracking" }]);
	} finally { f.cleanup(); }
});

test("B3 pull performs fetch then fast-forward merge", async () => {
	const f = await fixture();
	try {
		const target = peerCommit(f, "remote ff\n");
		const preflight = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" });
		const operation = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("pull-ff"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "rev-parse", "HEAD"), target);
		assert.deepEqual(done.result.stages.map((stage) => stage.status), ["succeeded", "succeeded"]);
	} finally { f.cleanup(); }
});

test("B3 pull merge records a conflict and abort is a separate confirmed operation", async () => {
	const f = await fixture();
	let restoredOperations;
	try {
		localCommit(f, "local conflict\n", "local conflict");
		peerCommit(f, "remote conflict\n", "remote conflict");
		const pull = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" });
		const pullOp = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("pull-conflict"), params: pull.params, preconditionToken: pull.preconditionToken });
		const conflict = await waitFor(f.operations, pullOp.operationId);
		assert.equal(conflict.status, "conflicted", JSON.stringify(conflict));
		const abort = await f.writes.abortPreflight({ repositoryId: f.repositoryId });
		const challenge = await f.writes.issueConfirmation({ repositoryId: f.repositoryId, confirmationRequestId: request("challenge"), operationType: "git.abort", params: abort.params, preconditionToken: abort.preconditionToken });
		f.writes.stop();
		f.operations.stop();
		restoredOperations = createGitOperationManager({ filePath: `${f.root}.operations.log` });
		await restoredOperations.start();
		const replacement = createGitRemoteService({ git: f.git, operations: restoredOperations, preconditionSecret: Buffer.alloc(32, 3) });
		const duplicateChallenge = await replacement.issueConfirmation({ repositoryId: f.repositoryId, confirmationRequestId: request("challenge"), operationType: "git.abort", params: abort.params, preconditionToken: abort.preconditionToken });
		assert.equal(duplicateChallenge.challengeId, challenge.challengeId);
		assert.equal(duplicateChallenge.deduplicated, true);
		const abortOp = await replacement.submitAbort({ repositoryId: f.repositoryId, requestId: request("abort"), params: abort.params, preconditionToken: abort.preconditionToken, challengeId: challenge.challengeId });
		const aborted = await waitFor(restoredOperations, abortOp.operationId);
		assert.equal(aborted.status, "succeeded", JSON.stringify(aborted));
		assert.equal(git(f.root, "status", "--porcelain"), "");
		await assert.rejects(() => replacement.submitAbort({ repositoryId: f.repositoryId, requestId: request("abort-replay"), params: abort.params, preconditionToken: abort.preconditionToken, challengeId: challenge.challengeId }), (error) => error.code === "confirmation-required");
		replacement.stop();
	} finally { restoredOperations?.stop(); f.cleanup(); }
});

test("B3 rebase conflict exposes a rebase abort target", async () => {
	const f = await fixture();
	try {
		localCommit(f, "local rebase conflict\n", "local rebase conflict");
		peerCommit(f, "remote rebase conflict\n", "remote rebase conflict");
		const pull = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "rebase" });
		const pullOp = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("rebase-conflict"), params: pull.params, preconditionToken: pull.preconditionToken });
		const conflict = await waitFor(f.operations, pullOp.operationId);
		assert.equal(conflict.status, "conflicted", JSON.stringify(conflict));
		const abort = await f.writes.abortPreflight({ repositoryId: f.repositoryId });
		assert.equal(abort.params.kind, "rebase");
	} finally { f.cleanup(); }
});

test("B3 confirmed rebase abort restores the original branch", async () => {
	const f = await fixture();
	try {
		const originalHead = localCommit(f, "local rebase abort\n", "local rebase abort");
		peerCommit(f, "remote rebase abort\n", "remote rebase abort");
		const pull = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "rebase" });
		const pullOp = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("rebase-abort-pull"), params: pull.params, preconditionToken: pull.preconditionToken });
		assert.equal((await waitFor(f.operations, pullOp.operationId)).status, "conflicted");
		const abort = await f.writes.abortPreflight({ repositoryId: f.repositoryId });
		const challenge = await f.writes.issueConfirmation({ repositoryId: f.repositoryId, confirmationRequestId: request("rebase-abort-challenge"), operationType: "git.abort", params: abort.params, preconditionToken: abort.preconditionToken });
		const abortOp = await f.writes.submitAbort({ repositoryId: f.repositoryId, requestId: request("rebase-abort"), params: abort.params, preconditionToken: abort.preconditionToken, challengeId: challenge.challengeId });
		const done = await waitFor(f.operations, abortOp.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "branch", "--show-current"), "main");
		assert.equal(git(f.root, "rev-parse", "HEAD"), originalHead);
		assert.equal(git(f.root, "status", "--porcelain"), "");
	} finally { f.cleanup(); }
});

test("B3 pull merge does not execute repository hooks", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.root, "local.txt"), "local\n");
		git(f.root, "add", "local.txt");
		git(f.root, "commit", "-m", "local side");
		writeFileSync(join(f.peer, "remote.txt"), "remote\n");
		git(f.peer, "add", "remote.txt");
		git(f.peer, "commit", "-m", "remote side");
		git(f.peer, "push", "origin", "main");
		const marker = join(f.root, "hook-ran");
		writeFileSync(join(f.root, ".git", "hooks", "post-merge"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
		chmodSync(join(f.root, ".git", "hooks", "post-merge"), 0o755);
		const pull = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" });
		const operation = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("no-hooks"), params: pull.params, preconditionToken: pull.preconditionToken });
		assert.equal((await waitFor(f.operations, operation.operationId)).status, "succeeded");
		assert.equal(existsSync(marker), false);
	} finally { f.cleanup(); }
});

test("B3 sync refuses to push a local commit created after integration", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.root, "local.txt"), "local\n");
		git(f.root, "add", "local.txt");
		git(f.root, "commit", "-m", "local side");
		writeFileSync(join(f.peer, "remote.txt"), "remote\n");
		git(f.peer, "add", "remote.txt");
		git(f.peer, "commit", "-m", "remote side");
		git(f.peer, "push", "origin", "main");
		const remoteBefore = git(f.bare, "rev-parse", "refs/heads/main");
		const preflight = await f.writes.syncPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" });
		const original = f.git.runCommand.bind(f.git);
		let mergeCompleted = false;
		let statusAfterMerge = 0;
		let externalOid;
		f.git.runCommand = async (argv, root, signal, options) => {
			if (mergeCompleted && argv.includes("status") && ++statusAfterMerge === 2) {
				git(f.root, "commit", "--allow-empty", "-m", "external after integration");
				externalOid = git(f.root, "rev-parse", "HEAD");
			}
			const value = await original(argv, root, signal, options);
			if (argv.includes("merge") && !argv.includes("merge-base")) mergeCompleted = true;
			return value;
		};
		const operation = await f.writes.submitSync({ repositoryId: f.repositoryId, requestId: request("sync-concurrent-local"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.ok(externalOid);
		assert.equal(done.status, "failed", JSON.stringify(done));
		assert.equal(done.errorCode, "state-changed");
		assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), remoteBefore);
		assert.notEqual(git(f.bare, "rev-parse", "refs/heads/main"), externalOid);
	} finally { f.cleanup(); }
});

test("B3 propagates provider failure from ancestor checks", async () => {
	const f = await fixture();
	try {
		const before = git(f.root, "rev-parse", "HEAD");
		peerCommit(f, "remote ancestor failure\n");
		const preflight = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" });
		const original = f.git.runCommand.bind(f.git);
		let injected = false;
		f.git.runCommand = async (argv, ...rest) => {
			if (!injected && argv.includes("merge-base") && argv.includes("--is-ancestor")) { injected = true; throw new GitOperationError("provider-unavailable", "injected provider failure"); }
			return original(argv, ...rest);
		};
		const operation = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("ancestor-provider"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "failed", JSON.stringify(done));
		assert.equal(done.errorCode, "provider-unavailable");
		assert.equal(git(f.root, "rev-parse", "HEAD"), before);
	} finally { f.cleanup(); }
});

test("B3 branch validation preserves provider errors", async () => {
	const f = await fixture();
	try {
		const original = f.git.runCommand.bind(f.git);
		f.git.runCommand = async (argv, ...rest) => {
			if (argv.includes("check-ref-format")) throw new GitOperationError("provider-unavailable", "injected provider failure");
			return original(argv, ...rest);
		};
		await assert.rejects(() => f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge" }), (error) => error.code === "provider-unavailable");
	} finally { f.cleanup(); }
});

test("B3 pull rebase uses the fixed fetched target", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.root, "local.txt"), "local\n");
		git(f.root, "add", "local.txt");
		git(f.root, "commit", "-m", "local only");
		writeFileSync(join(f.peer, "peer.txt"), "peer\n");
		git(f.peer, "add", "peer.txt");
		git(f.peer, "commit", "-m", "peer only");
		git(f.peer, "push", "origin", "main");
		const preflight = await f.writes.pullPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "rebase" });
		const operation = await f.writes.submitPull({ repositoryId: f.repositoryId, requestId: request("rebase"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.root, "rev-parse", "--verify", "refs/heads/main"), git(f.root, "rev-parse", "HEAD"));
		assert.equal(git(f.root, "rev-parse", "--verify", "refs/remotes/origin/main"), git(f.peer, "rev-parse", "HEAD"));
	} finally { f.cleanup(); }
});

test("B3 push uses explicit refs, rejects force, and can set upstream after success", async () => {
	const f = await fixture();
	try {
		const source = localCommit(f, "local push\n");
		const preflight = await f.writes.pushPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", localBranch: "main", setUpstream: true });
		const operation = await f.writes.submitPush({ repositoryId: f.repositoryId, requestId: request("push"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), source);
		assert.equal(git(f.root, "config", "--get", "branch.main.merge"), "refs/heads/main");
		await assert.rejects(() => f.writes.pushPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", localBranch: "main", force: true }), (error) => error.code === "invalid-argument");
	} finally { f.cleanup(); }
});

test("B3 push can create a missing remote target without force", async () => {
	const f = await fixture();
	try {
		git(f.root, "checkout", "-b", "feature");
		writeFileSync(join(f.root, "feature.txt"), "feature\n");
		git(f.root, "add", "feature.txt");
		git(f.root, "commit", "-m", "feature");
		const local = git(f.root, "rev-parse", "HEAD");
		const preflight = await f.writes.pushPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "feature", localBranch: "feature", setUpstream: true });
		assert.equal(preflight.expected.destinationOid, null);
		const operation = await f.writes.submitPush({ repositoryId: f.repositoryId, requestId: request("push-create"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(git(f.bare, "rev-parse", "refs/heads/feature"), local);
		assert.equal(git(f.root, "config", "--get", "branch.feature.remote"), "origin");
		assert.equal(git(f.root, "config", "--get", "branch.feature.merge"), "refs/heads/feature");
	} finally { f.cleanup(); }
});

test("B3 sync creates a missing remote target after skipping fetch and integrate", async () => {
	const f = await fixture();
	try {
		git(f.root, "checkout", "-b", "sync-feature");
		writeFileSync(join(f.root, "sync-feature.txt"), "sync feature\n");
		git(f.root, "add", "sync-feature.txt");
		git(f.root, "commit", "-m", "sync feature");
		const local = git(f.root, "rev-parse", "HEAD");
		const preflight = await f.writes.syncPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "sync-feature", localBranch: "sync-feature", setUpstream: false });
		assert.equal(preflight.expected.targetOid, null);
		const operation = await f.writes.submitSync({ repositoryId: f.repositoryId, requestId: request("sync-create"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.deepEqual(done.result.stages.map((stage) => stage.status), ["skipped", "skipped", "succeeded"]);
		assert.equal(git(f.bare, "rev-parse", "refs/heads/sync-feature"), local);
	} finally { f.cleanup(); }
});

test("B3 push surfaces a non-fast-forward rejection without force fallback", async () => {
	const f = await fixture();
	try {
		const remote = peerCommit(f, "remote wins\n", "remote wins");
		const local = localCommit(f, "local wins\n", "local wins");
		const preflight = await f.writes.pushPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", localBranch: "main" });
		const operation = await f.writes.submitPush({ repositoryId: f.repositoryId, requestId: request("push-rejected"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "failed", JSON.stringify(done));
		assert.equal(done.errorCode, "non-fast-forward");
		assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), remote);
		assert.notEqual(remote, local);
	} finally { f.cleanup(); }
});

test("B3 sync performs a merge and pushes the resulting local head", async () => {
	const f = await fixture();
	try {
		writeFileSync(join(f.root, "local-sync.txt"), "local\n");
		git(f.root, "add", "local-sync.txt");
		git(f.root, "commit", "-m", "local sync");
		writeFileSync(join(f.peer, "peer-sync.txt"), "peer\n");
		git(f.peer, "add", "peer-sync.txt");
		git(f.peer, "commit", "-m", "peer sync");
		git(f.peer, "push", "origin", "main");
		const preflight = await f.writes.syncPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge", setUpstream: false });
		const operation = await f.writes.submitSync({ repositoryId: f.repositoryId, requestId: request("sync-push"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.deepEqual(done.result.stages.map((stage) => stage.status), ["succeeded", "succeeded", "succeeded"]);
		assert.equal(git(f.bare, "rev-parse", "refs/heads/main"), git(f.root, "rev-parse", "HEAD"));
	} finally { f.cleanup(); }
});

test("B3 sync records skipped push after pull when remote already matches", async () => {
	const f = await fixture();
	try {
		peerCommit(f, "remote sync\n");
		const preflight = await f.writes.syncPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", strategy: "merge", setUpstream: false });
		const operation = await f.writes.submitSync({ repositoryId: f.repositoryId, requestId: request("sync"), params: preflight.params, preconditionToken: preflight.preconditionToken });
		const done = await waitFor(f.operations, operation.operationId);
		assert.equal(done.status, "succeeded", JSON.stringify(done));
		assert.equal(done.result.stages[0].status, "succeeded");
		assert.equal(done.result.stages[1].status, "succeeded");
		assert.equal(done.result.stages[2].status, "skipped");
	} finally { f.cleanup(); }
});

test("B3 rejects URL and refspec-shaped inputs instead of passing them to Git", async () => {
	const f = await fixture();
	try {
		await assert.rejects(() => f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "main", url: "https://user:secret@example.com/repo" }), (error) => error.code === "invalid-argument");
		await assert.rejects(() => f.writes.fetchPreflight({ repositoryId: f.repositoryId, remote: "origin", branch: "refs/heads/main" }), (error) => error.code === "invalid-argument");
	} finally { f.cleanup(); }
});

test("B3 refuses an implicit target when no upstream exists", async () => {
	const f = await fixture();
	try {
		git(f.root, "config", "--unset", "branch.main.remote");
		git(f.root, "config", "--unset", "branch.main.merge");
		await assert.rejects(() => f.writes.pullPreflight({ repositoryId: f.repositoryId, strategy: "merge" }), (error) => error.code === "upstream-required");
	} finally { f.cleanup(); }
});
