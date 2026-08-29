import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	GitOperationError,
	OperationLedger,
	canonicalJson,
	createGitOperationManager,
	digest,
} from "../lib/git-operations.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dsh-git-operations-"));
	const filePath = join(root, "operations.log");
	return { root, filePath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function managerFixture(options = {}) {
	const f = fixture();
	const manager = createGitOperationManager({ filePath: f.filePath, ...options });
	await manager.start();
	return { ...f, manager };
}

const request = (n) => `request-${String(n).padStart(5, "0")}`;

test("canonical JSON and digest are independent of object key order", () => {
	assert.equal(canonicalJson({ z: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"z":1}');
	assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
	assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
});

test("ledger replays complete frames and ignores a truncated tail", () => {
	const f = fixture();
	try {
		const ledger = new OperationLedger({ filePath: f.filePath });
		ledger.transaction([{ type: "operation.created", operationId: "op-1", requestKey: "actor:req", requestDigest: "d", operation: { operationId: "op-1", status: "queued" } }]);
		const before = ledger.state.operations["op-1"];
		const original = readFileSync(f.filePath, "utf8");
		writeFileSync(f.filePath, `${original}999:deadbeef:`);
		const restored = new OperationLedger({ filePath: f.filePath });
		assert.deepEqual(restored.state.operations["op-1"], before);
	} finally { f.cleanup(); }
});

test("ledger compaction preserves operations and replay skips the pre-compaction log", () => {
	const f = fixture();
	try {
		const ledger = new OperationLedger({ filePath: f.filePath });
		ledger.transaction([{ type: "operation.created", operationId: "op-compact", requestKey: "actor:req-compact", requestDigest: "d", operation: { operationId: "op-compact", status: "queued" } }]);
		ledger.compact();
		const restored = new OperationLedger({ filePath: f.filePath });
		assert.equal(restored.state.operations["op-compact"].status, "queued");
		assert.equal(restored.state.txIds.length, 1);
	} finally { f.cleanup(); }
});

test("same requestId is idempotent, but changed parameters are rejected", async () => {
	const { manager, cleanup } = await managerFixture();
	try {
		manager.registerExecutor("noop", async () => ({ status: "succeeded", result: { ok: true } }));
		const first = await manager.submit({ repositoryId: "repo-1", requestId: request(1), kind: "noop", params: { value: 1 }, preconditionToken: "p1" });
		const duplicate = await manager.submit({ repositoryId: "repo-1", requestId: request(1), kind: "noop", params: { value: 1 }, preconditionToken: "p1" });
		assert.equal(duplicate.operationId, first.operationId);
		assert.equal(duplicate.deduplicated, true);
		await assert.rejects(() => manager.submit({ repositoryId: "repo-1", requestId: request(1), kind: "noop", params: { value: 2 }, preconditionToken: "p1" }), (error) => error.code === "idempotency-conflict");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(first.operationId).status, "succeeded");
	} finally { manager.stop(); cleanup(); }
});

test("precondition failures remain visible and executor progress cannot mutate state", async () => {
	const { manager, cleanup } = await managerFixture();
	try {
		manager.setPreconditionChecker(() => { throw new GitOperationError("state-changed", "repository changed", { requiresRefresh: true }); });
		manager.registerExecutor("precondition", async () => ({ status: "succeeded" }));
		const stale = await manager.submit({ repositoryId: "repo", requestId: request(12), kind: "precondition", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(stale.operationId).status, "failed");
		assert.equal(manager.get(stale.operationId).errorCode, "state-changed");

		manager.setPreconditionChecker(undefined);
		manager.registerExecutor("bad-progress", async ({ update }) => { update({ status: "succeeded" }); });
		const bad = await manager.submit({ repositoryId: "repo-2", requestId: request(13), kind: "bad-progress", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(bad.operationId).status, "failed");
		assert.equal(manager.get(bad.operationId).errorCode, "invalid-argument");
	} finally { manager.stop(); cleanup(); }
});

test("list rejects invalid limits and prunes only completed history", async () => {
	const { manager, cleanup } = await managerFixture({ maxOperations: 2 });
	try {
		assert.throws(() => manager.list({ limit: 0 }), (error) => error.code === "invalid-argument");
		manager.registerExecutor("tiny", async () => ({ status: "succeeded" }));
		for (let i = 0; i < 3; i++) await manager.submit({ repositoryId: `repo-${i}`, requestId: request(14 + i), kind: "tiny", preconditionToken: "p" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(manager.list({}).operations.length <= 2);
	} finally { manager.stop(); cleanup(); }
});

test("operations in one coordination domain serialize while other domains run independently", async () => {
	const { manager, cleanup } = await managerFixture();
	try {
		let active = 0;
		let maximum = 0;
		const starts = [];
		manager.registerExecutor("wait", async ({ operation }) => {
			active++;
			maximum = Math.max(maximum, active);
			starts.push(operation.params.name);
			await new Promise((resolve) => setTimeout(resolve, operation.params.delay));
			active--;
			return { status: "succeeded" };
		});
		await Promise.all([
			manager.submit({ repositoryId: "repo", coordinationDomain: "repo", requestId: request(2), kind: "wait", params: { name: "a", delay: 20 }, preconditionToken: "p" }),
			manager.submit({ repositoryId: "repo", coordinationDomain: "repo", requestId: request(3), kind: "wait", params: { name: "b", delay: 1 }, preconditionToken: "p" }),
			manager.submit({ repositoryId: "other", coordinationDomain: "other", requestId: request(4), kind: "wait", params: { name: "c", delay: 5 }, preconditionToken: "p" }),
		]);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(maximum, 2);
		assert.deepEqual(starts.filter((x) => x === "a" || x === "b"), ["a", "b"]);
	} finally { manager.stop(); cleanup(); }
});

test("queued cancellation is terminal and running cancellation is delegated to executor", async () => {
	const { manager, cleanup } = await managerFixture();
	try {
		let release;
		const blocked = new Promise((resolve) => { release = resolve; });
		manager.registerExecutor("cancel", async ({ signal }) => {
			if (signal.aborted) throw new GitOperationError("cancelled", "cancelled");
			await blocked;
			if (signal.aborted) throw new GitOperationError("cancelled", "cancelled");
			return { status: "succeeded" };
		});
		const first = await manager.submit({ repositoryId: "repo", requestId: request(5), kind: "cancel", preconditionToken: "p" });
		const second = await manager.submit({ repositoryId: "repo", requestId: request(6), kind: "cancel", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		const secondView = manager.get(second.operationId);
		assert.equal((await manager.cancel(second.operationId, { requestId: request(9), expectedRevision: secondView.revision })).status, "cancelled");
		const firstView = manager.get(first.operationId);
		await manager.cancel(first.operationId, { requestId: request(10), expectedRevision: firstView.revision });
		release();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(first.operationId).status, "cancelled");
	} finally { manager.stop(); cleanup(); }
});

test("unknown-result blocks a domain until an explicit recovery acknowledgement", async () => {
	const { manager, cleanup } = await managerFixture();
	try {
		manager.registerExecutor("uncertain", async () => { throw new GitOperationError("unknown-result", "cannot prove result", { requiresRefresh: true }); });
		manager.registerExecutor("ok", async () => ({ status: "succeeded" }));
		const uncertain = await manager.submit({ repositoryId: "repo", requestId: request(7), kind: "uncertain", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(uncertain.operationId).status, "unknown-result");
		const queued = await manager.submit({ repositoryId: "repo", requestId: request(8), kind: "ok", preconditionToken: "p" });
		assert.equal(manager.get(queued.operationId).status, "queued");
		const uncertainView = manager.get(uncertain.operationId);
		await manager.acknowledgeRecovery({ repositoryId: "repo", operationId: uncertain.operationId, facts: { confirmed: true, stateVersion: "v1", observedAt: Date.now() }, requestId: request(11), expectedRevision: uncertainView.revision });
		assert.equal(manager.get(queued.operationId).recoveryBlocked, undefined);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(manager.get(queued.operationId).status, "succeeded");
	} finally { manager.stop(); cleanup(); }
});

test("recovery facts can be checked against provider read-only facts", async () => {
	const { manager, cleanup } = await managerFixture({ verifyRecoveryFacts: async ({ facts }) => facts.stateVersion === "current" });
	try {
		manager.registerExecutor("uncertain-check", async () => { throw new GitOperationError("unknown-result", "result is uncertain"); });
		const op = await manager.submit({ repositoryId: "repo", requestId: request(18), kind: "uncertain-check", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		const view = manager.get(op.operationId);
		await assert.rejects(() => manager.acknowledgeRecovery({ repositoryId: "repo", operationId: op.operationId, requestId: request(19), expectedRevision: view.revision, facts: { confirmed: true, stateVersion: "stale", observedAt: Date.now() } }), (error) => error.code === "state-changed");
	} finally { manager.stop(); cleanup(); }
});

test("only one manager owns a ledger at a time", async () => {
	const f = fixture();
	const first = createGitOperationManager({ filePath: f.filePath });
	const second = createGitOperationManager({ filePath: f.filePath });
	try {
		await first.start();
		await assert.rejects(() => second.start(), (error) => error.code === "provider-ambiguous");
	} finally { first.stop(); second.stop(); f.cleanup(); }
});

test("corrupt complete log frames disable the manager instead of silently skipping history", async () => {
	const f = fixture();
	try {
		writeFileSync(f.filePath, "corrupt-frame\n");
		const manager = createGitOperationManager({ filePath: f.filePath });
		await assert.rejects(() => manager.start(), (error) => error.code === "provider-unavailable");
		assert.equal(manager.capabilities().available, false);
	} finally { f.cleanup(); }
});

test("stop releases provider-owned leases after requesting cancellation", async () => {
	const f = fixture();
	const first = createGitOperationManager({ filePath: f.filePath });
	let release;
	try {
		await first.start();
		first.registerExecutor("hang", async () => await new Promise((resolve) => { release = resolve; }));
		await first.submit({ repositoryId: "repo", requestId: request(17), kind: "hang", preconditionToken: "p" });
		await new Promise((resolve) => setImmediate(resolve));
		first.stop();
		const second = createGitOperationManager({ filePath: f.filePath });
		await second.start();
		second.stop();
	} finally {
		release?.();
		await new Promise((resolve) => setImmediate(resolve));
		first.stop();
		f.cleanup();
	}
});

test("a persisted running operation is reconciled, never replayed", async () => {
	const f = fixture();
	try {
		const seed = new OperationLedger({ filePath: f.filePath });
		seed.transaction([{
			type: "operation.created", operationId: "op-running", requestKey: "actor:req-running", requestDigest: "digest", operation: {
				operationId: "op-running", requestId: "req-running", repositoryId: "repo", coordinationDomain: "repo", kind: "danger", params: {}, status: "running", revision: 2, createdAt: 1, updatedAt: 1,
			},
		}, { type: "operation.updated", operationId: "op-running", patch: { status: "running" } }]);
		const reconciled = createGitOperationManager({ filePath: f.filePath, reconcile: async () => ({ status: "succeeded", facts: { observed: true } }) });
		await reconciled.start();
		assert.equal(reconciled.get("op-running").status, "succeeded");
		reconciled.stop();
	} finally { f.cleanup(); }
});
