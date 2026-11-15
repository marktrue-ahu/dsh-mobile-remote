// issue #110：rc.2 host-manager 契约、restart-pending 启动认领、死 holder 收敛、
// 原 argv 重启命令保留。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	TRANSACTION_PHASE,
	acquireLock,
	convergeStaleTransaction,
	finishOwnedTerminal,
	lockHolderAlive,
	processIdentityAlive,
	processStartTime,
	readLock,
	readTransaction,
	releaseLock,
	transactionFile,
	updateLockPath,
	writeOwnedTransaction,
} from "../lib/plugin-update-transaction.js";
import { reportPendingUpdate } from "../lib/plugin-self-update.js";
import { defaultRestart } from "../lib/update-supervisor.js";
import { respawnCommandOf } from "../lib/plugin-self-update.js";

const TARGET = "a".repeat(64);
const OTHER = "b".repeat(64);

function setup() {
	const base = mkdtempSync(join(tmpdir(), "update-recovery-110-"));
	mkdirSync(join(base, ".dsh", "mobile-remote"), { recursive: true });
	const stateFile = transactionFile(base);
	const lockPath = updateLockPath(base);
	return { base, stateFile, lockPath };
}

function writeRestartPending({ stateFile, lockPath, lease, target = TARGET, startedAt = new Date().toISOString() }) {
	writeOwnedTransaction(stateFile, {
		opId: lease.opId,
		phase: TRANSACTION_PHASE.RESTART_PENDING,
		startedAt,
		targetContentSha256: target,
		targetVersion: "3.2.4-alpha.17",
		artifact: { dir: "/tmp/artifact", contentSha256: target },
		snapshot: { dir: "/tmp/snapshot", contentSha256: OTHER },
		lease,
	}, { lockPath, lease, currentFile: stateFile });
}

function makeDeadHolder(lockPath, lease) {
	// 保留 transaction 的 lease，但把 holder 两个身份都写成明显已死/被复用的 pid。
	writeFileSync(join(lockPath, "holder.json"), JSON.stringify({
		opId: lease.opId,
		generation: lease.generation,
		worker: { pid: 999999, start: "1" },
		supervisor: { pid: 999998, start: "2" },
		pid: 999999,
	}));
}

test("#110 P1-B：restart-pending + 内容匹配 + holder 已死 → adoptable，finish 后 settled 且元数据保留", () => {
	const { base, stateFile, lockPath } = setup();
	try {
		const lock = acquireLock(lockPath, { opId: "op-adopt", pid: process.pid });
		assert.equal(lock.ok, true);
		const lease = lock.lease;
		writeRestartPending({ stateFile, lockPath, lease, target: TARGET });
		makeDeadHolder(lockPath, lease);
		assert.equal(lockHolderAlive(lockPath), false);

		const reported = reportPendingUpdate({
			stateFile, lockPath, localContentSha256: TARGET, holderAlive: false,
		});
		assert.equal(reported.action, "adoptable");
		assert.equal(reported.reason, "loaded-target-content-adopted");
		finishOwnedTerminal(stateFile, {
			phase: "settled",
			result: { ok: true, matched: "loaded-target-content-adopted" },
			expectedPhases: ["restart-pending"],
		}, { lockPath, lease: reported.transaction.lease, currentFile: stateFile });
		const tx = readTransaction(stateFile);
		assert.equal(tx.phase, "settled");
		assert.equal(tx.result.matched, "loaded-target-content-adopted");
		assert.equal(tx.targetVersion, "3.2.4-alpha.17");
		assert.deepEqual(tx.artifact, { dir: "/tmp/artifact", contentSha256: TARGET });
		assert.deepEqual(tx.snapshot, { dir: "/tmp/snapshot", contentSha256: OTHER });
		assert.equal(readLock(lockPath), null);
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("#110 P1-B：holder 活着 → 只报告 matched，不 adopt；/proc starttime 可判 pid 复用", () => {
	const { base, stateFile, lockPath } = setup();
	try {
		const lock = acquireLock(lockPath, { opId: "op-alive", pid: process.pid });
		const lease = lock.lease;
		writeRestartPending({ stateFile, lockPath, lease, target: TARGET });
		// acquireLock 写的是真实当前进程 identity，应判活。
		assert.equal(lockHolderAlive(lockPath), true);
		assert.equal(processIdentityAlive({ pid: process.pid, start: processStartTime(process.pid) }), true);
		// 同 pid 但 starttime 不匹配（pid 复用）必须判死。
		assert.equal(processIdentityAlive({ pid: process.pid, start: "different-start" }), false);
		const reported = reportPendingUpdate({
			stateFile, lockPath, localContentSha256: TARGET, holderAlive: true,
		});
		assert.equal(reported.action, "matched");
		assert.equal(reported.reason, "loaded-target-content");
		assert.equal(readTransaction(stateFile).phase, "restart-pending");
	} finally { rmSync(base, { recursive: true, force: true }); }
});

test("#110 P1-C：restart-pending + 死 holder + stale，内容匹配 settled；不匹配 failed(confirmation-lost)", () => {
	const { base, stateFile, lockPath } = setup();
	try {
		const lock = acquireLock(lockPath, { opId: "op-converge", pid: process.pid });
		const lease = lock.lease;
		const old = new Date(Date.now() - 3600_000).toISOString();
		writeRestartPending({ stateFile, lockPath, lease, target: TARGET, startedAt: old });
		makeDeadHolder(lockPath, lease);
		const settled = convergeStaleTransaction({
			stateFile, lockPath, localContentSha256: TARGET, staleMs: 0,
		});
		assert.equal(settled.action, "settled");
		assert.equal(readTransaction(stateFile).phase, "settled");
		assert.equal(readTransaction(stateFile).result.matched, "loaded-target-content-adopted");
		assert.deepEqual(readTransaction(stateFile).artifact, { dir: "/tmp/artifact", contentSha256: TARGET });
	} finally { rmSync(base, { recursive: true, force: true }); }

	const second = setup();
	try {
		const lock = acquireLock(second.lockPath, { opId: "op-converge-2", pid: process.pid });
		const lease = lock.lease;
		writeRestartPending({
			stateFile: second.stateFile,
			lockPath: second.lockPath,
			lease,
			startedAt: new Date(Date.now() - 3600_000).toISOString(),
		});
		makeDeadHolder(second.lockPath, lease);
		const failed = convergeStaleTransaction({
			stateFile: second.stateFile,
			lockPath: second.lockPath,
			localContentSha256: OTHER,
			staleMs: 0,
		});
		assert.equal(failed.action, "converged");
		const tx = readTransaction(second.stateFile);
		assert.equal(tx.phase, "failed");
		assert.equal(tx.result.reason, "confirmation-lost");
		assert.deepEqual(tx.artifact, { dir: "/tmp/artifact", contentSha256: TARGET });
		assert.notEqual(tx.phase, "restart-pending", "不得无限 pending");
	} finally { rmSync(second.base, { recursive: true, force: true }); }
});

test("#110 P2：defaultRestart 透传原始 argv（保留 --port 3082），不落回默认 profile 命令", () => {
	const cmd = respawnCommandOf(["/usr/bin/node", "/opt/dsh/bin/dsh", "web", "--no-open", "--port", "3082"]);
	assert.ok(cmd.includes("--port"));
	assert.ok(cmd.includes("3082"));
	let script = "";
	const result = defaultRestart({
		restartForm: "web-foreground",
		port: 3082,
		pid: 123,
		profile: "web",
		respawnCommand: cmd,
		spawnSyncImpl: (shell, args) => { script = args.join(" "); return { error: null, status: 0 }; },
	});
	assert.equal(result.ok, true);
	assert.ok(script.includes("--port 3082"), script);
	assert.ok(!script.includes("web --profile web"), "不得丢掉原参数");
});
