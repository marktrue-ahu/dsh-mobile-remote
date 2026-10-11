// 外部监督器的契约（评审 #32 note 1286 的 R1；二次复核的 F1/F3/F7）：
//   - **先安排第一次重启**，再等新实例健康（旧宿主不会自己加载新代码，F1）；
//   - 重启目标是**当前实例**（端口占用者），不是事务里记的旧 PID（F3）；
//   - 回滚走**快照**，且中间态不得被当成成功（F7）。
// 全部用注入的等待器/恢复器/重启器驱动，不碰真实宿主。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
	TRANSACTION_PHASE,
	acquireLock,
	writeOwnedTransaction,
	readLock,
	readTransaction,
	transactionFile,
	updateLockPath,
} from "../lib/plugin-update-transaction.js";
import { findPortOwnerPid, portKillSnippet, superviseUpdate, waitForHost } from "../lib/update-supervisor.js";

let txSeq = 0;
async function writeTx(base, over = {}) {
  // 生产里每个操作有自己的状态文件（服务端 UUID）；这里照做，避免把新操作写进旧终态文件。
  const opId = `op-${++txSeq}`;
  const lockPath = updateLockPath(base), currentFile = transactionFile(base);
  const file = join(base, '.dsh', 'mobile-remote', 'transactions', `${randomUUID()}.json`);
  await mkdir(join(base, '.dsh', 'mobile-remote', 'transactions'), { recursive: true });
  const grant = acquireLock(lockPath, { opId, stateFile: currentFile });
  assert.equal(grant.ok, true, grant.error);
  const tx = { opId, lease: grant.lease, phase: TRANSACTION_PHASE.RESTART_PENDING, startedAt: new Date().toISOString(),
    profileDir: join(base, 'profile'), previousSnapshotDir: join(base, 'snapshots', 'b'.repeat(64)),
    previousContentSha256: 'b'.repeat(64), targetContentSha256: 'a'.repeat(64), targetVersion: '3.3.0',
    port: 3080, restartForm: 'web-systemd', attempts: 0, lockPath, currentFile, ...over };
  writeOwnedTransaction(file, tx, { lockPath, lease: grant.lease, currentFile });
  return file;
}

test("waitForHost：按正在运行的内容标识确认健康，超时如实失败", async () => {
	let hits = 0;
	const ok = await waitForHost({
		port: 3080,
		expectContentSha256: "a".repeat(64),
		pollMs: 1,
		timeoutMs: 500,
		fetchImpl: async () => {
			hits++;
			return { ok: true, json: async () => ({ ok: true, plugin: { contentSha256: hits >= 2 ? "a".repeat(64) : "b".repeat(64) } }) };
		},
		sleep: async () => {},
		now: (() => { let t = 0; return () => (t += 10); })(),
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.matched, "content");

	const timedOut = await waitForHost({
		port: 3080,
		expectContentSha256: "f".repeat(64),
		pollMs: 1,
		timeoutMs: 30,
		fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, plugin: { contentSha256: "b".repeat(64) } }) }),
		sleep: async () => {},
		now: (() => { let t = 0; return () => (t += 10); })(),
	});
	assert.equal(timedOut.ok, false);
	assert.match(timedOut.error, /host-wait-timeout/);
});

test("F1：**先重启、后等待**——旧实例持续响应时不得被当成已健康", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-f1-"));
	try {
		const file = await writeTx(base);
		const order = [];
		const tx = readTransaction(file);
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => {
				order.push("wait");
				return { ok: false, error: "host-wait-timeout: content-mismatch" };
			},
			restart: () => {
				order.push("restart");
				return { ok: true };
			},
			restore: () => ({ ok: true }),
			log: () => {},
			maxRollbacks: 1,
		});
		assert.equal(order[0], "restart", `首次重启必须发生在等待之前，实际顺序：${order.join("→")}`);
		assert.equal(order.filter((x) => x === "restart").length >= 2, true, "回滚后还要再重启一次");
		assert.equal(r.phase, TRANSACTION_PHASE.FAILED); // 回滚后仍确认不到旧内容 → 失败
		assert.ok(tx.targetContentSha256);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("新版本健康 → SETTLED 并释放锁", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-ok-"));
	try {
		const file = await writeTx(base);
		assert.equal(readLock(updateLockPath(base)).opId, readTransaction(file).opId);
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => ({ ok: true, matched: "content" }),
			restart: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.SETTLED);
		assert.equal(r.result.ok, true);
		assert.equal(readLock(updateLockPath(base)), null, "终态必须释放锁");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("F3/F7：重启目标由端口占用者决定；回滚走快照且中间态不改原始目标", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-rb-"));
	try {
		const file = await writeTx(base);
		const restarts = [];
		const restores = [];
		let wait = 0;
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => {
				wait++;
				return wait === 1 ? { ok: false, error: "host-wait-timeout" } : { ok: true, matched: "content" };
			},
			restart: (args) => {
				restarts.push(args);
				return { ok: true };
			},
			restore: (args) => {
				restores.push(args);
				return { ok: true };
			},
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.ROLLED_BACK);
		// 恢复必须指向**快照**，而不是可能已变的原 source
		assert.equal(restores.length, 1);
		assert.equal(restores[0].snapshotDir, join(base, "snapshots", "b".repeat(64)));
		assert.equal(restores[0].profileDir, join(base, "profile"));
		// 两次重启：首次（升级）+ 回滚
		assert.equal(restarts.length, 2);
		assert.equal(restarts[1].pid, null, "回滚重启不得沿用更新前的旧 PID");
		// 回滚中间态与终态都保留**原始升级目标**（App 才不会把它当成功，F7）
		assert.equal(r.targetContentSha256, "a".repeat(64));
		assert.equal(r.rolledBack, true);
		assert.equal(r.result.reason, "rolled-back");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("首次重启失败触发一次恢复，不能把损坏安装当普通终态", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-rf-"));
	try {
		const file = await writeTx(base);
		let waited = 0;
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => {
				waited++;
				return { ok: true, matched: "content" };
			},
			restart: (() => { let n=0; return () => ++n === 1 ? { ok: false, error: "restart-script-exit-1" } : { ok: true }; })(),
			restore: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.ROLLED_BACK);
		assert.equal(r.result.reason, "rolled-back");
		assert.equal(waited, 1, "只等待恢复后的旧实例");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("回滚恢复安装失败 / 回滚后未确认 → FAILED（不假装回滚成功）", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-bad-"));
	try {
		const restoreFailed = await superviseUpdate({
			stateFile: await writeTx(base),
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restart: () => ({ ok: true }),
			restore: () => ({ ok: false, error: "restore-install-failed: pnpm-exit-1" }),
			log: () => {},
		});
		assert.equal(restoreFailed.phase, TRANSACTION_PHASE.FAILED);
		assert.equal(restoreFailed.result.reason, "rollback-restore-failed");

		const unconfirmed = await superviseUpdate({
			stateFile: await writeTx(base),
			waitForHost: async () => ({ ok: false, error: "host-wait-timeout" }),
			restart: () => ({ ok: true }),
			restore: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(unconfirmed.phase, TRANSACTION_PHASE.FAILED);
		assert.equal(unconfirmed.result.reason, "rollback-unconfirmed");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("回滚次数用尽 / 缺回滚目标 → FAILED，不再重启", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-ex-"));
	try {
		let restarts = 0;
		const exhausted = await superviseUpdate({
			stateFile: await writeTx(base, { attempts: 1 }),
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restart: () => {
				restarts++;
				return { ok: true };
			},
			restore: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(exhausted.result.reason, "rollback-exhausted");
		assert.equal(restarts, 1, "只应有首次重启，不应再重启");

		const noTarget = await superviseUpdate({
			stateFile: await writeTx(base, { previousSnapshotDir: "" }),
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restart: () => ({ ok: true }),
			restore: () => {
				throw new Error("不应恢复");
			},
			log: () => {},
		});
		assert.equal(noTarget.result.reason, "rollback-target-missing");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("无事务或阶段不对 → 明确拒绝（不猜）", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-none-"));
	try {
		assert.equal((await superviseUpdate({ stateFile: transactionFile(base), log: () => {} })).error, "no-transaction");
		const file = await writeTx(base, { phase: TRANSACTION_PHASE.STAGING });
		assert.match((await superviseUpdate({ stateFile: file, log: () => {} })).error, /not-restart-pending/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("F3：重启目标解析当前端口占用者（而不是旧 PID）", () => {
	const snippet = portKillSnippet(3080, 4141);
	assert.match(snippet, /sport = :3080/, "必须按端口找当前实例");
	assert.match(snippet, /lsof -ti tcp:3080/, "ss 不可用时退回 lsof");
	assert.match(snippet, /P=4141/, "两者都找不到才退回记录值");

	// 注入的 run：ss 给出 pid=777
	const pid = findPortOwnerPid(3080, {
		run: () => ({ status: 0, stdout: 'LISTEN 0 511 *:3080 *:* users:(("node",pid=777,fd=21))\n' }),
	});
	assert.equal(pid, 777);
	// ss 无输出 → lsof 兜底
	const viaLsof = findPortOwnerPid(3080, {
		run: (cmd) => (cmd === "ss" ? { status: 0, stdout: "" } : { status: 0, stdout: "888\n" }),
	});
	assert.equal(viaLsof, 888);
	// 都失败 → null（调用方退回记录值）
	assert.equal(findPortOwnerPid(3080, { run: () => ({ status: 1, stdout: "" }) }), null);
});
