// 外部监督器的契约（评审 #32 note 1286 的 R1）：
// 回滚**不能**依赖新版插件能否加载，所以"等待健康 → 确认内容标识 → 失败回滚 → 再确认"
// 必须由一个独立进程完成。这里用注入的等待器/恢复器/重启器驱动全部路径，不碰真实宿主。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TRANSACTION_PHASE, readLock, readTransaction, transactionFile, updateLockFile, acquireLock } from "../lib/plugin-update-transaction.js";
import { superviseUpdate, waitForHost } from "../lib/update-supervisor.js";

async function writeTx(base, over = {}) {
	const file = transactionFile(base);
	await mkdir(join(base, ".dsh", "mobile-remote"), { recursive: true });
	await writeFile(file, `${JSON.stringify({
		opId: "op-1",
		phase: TRANSACTION_PHASE.RESTART_PENDING,
		startedAt: new Date().toISOString(),
		profileDir: join(base, "profile"),
		previousSpecifier: "file:/old",
		previousContentSha256: "b".repeat(64),
		targetContentSha256: "a".repeat(64),
		targetVersion: "3.3.0",
		attempts: 0,
		...over,
	}, null, 2)}\n`);
	return file;
}

test("waitForHost：按**正在运行的内容标识**确认新实例健康，超时如实失败", async () => {
	let hits = 0;
	const fetchImpl = async () => {
		hits++;
		return { ok: true, json: async () => ({ ok: true, plugin: { version: "3.3.0", contentSha256: hits >= 2 ? "a".repeat(64) : "b".repeat(64) } }) };
	};
	const ok = await waitForHost({
		port: 3080,
		expectContentSha256: "a".repeat(64),
		pollMs: 1,
		timeoutMs: 500,
		fetchImpl,
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

test("superviseUpdate：新版本健康 → SETTLED 并释放锁", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup-"));
	try {
		const file = await writeTx(base);
		acquireLock(updateLockFile(base), { opId: "op-1", pid: process.pid });
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => ({ ok: true, matched: "content" }),
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.SETTLED);
		assert.equal(r.result.ok, true);
		assert.equal(readLock(updateLockFile(base)), null, "终态必须释放锁，否则下一次更新永远 busy");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("superviseUpdate：新版本未生效 → 换回旧依赖 + 再重启，确认后记 ROLLED_BACK", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup2-"));
	try {
		const file = await writeTx(base);
		const restored = [];
		const restarts = [];
		let wait = 0;
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => {
				wait++;
				return wait === 1 ? { ok: false, error: "host-wait-timeout: content-mismatch" } : { ok: true, matched: "content" };
			},
			restore: ({ profileDir, previousSpecifier }) => {
				restored.push({ profileDir, previousSpecifier });
				return { ok: true };
			},
			restart: (a) => {
				restarts.push(a);
				return { ok: true };
			},
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.ROLLED_BACK);
		assert.equal(restored.length, 1);
		assert.equal(restored[0].previousSpecifier, "file:/old");
		assert.equal(restarts.length, 1);
		assert.equal(r.attempts, 1);
		assert.equal(r.rolledBack, true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("superviseUpdate：回滚恢复安装失败 → FAILED（不假装回滚成功）", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup3-"));
	try {
		const file = await writeTx(base);
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restore: () => ({ ok: false, error: "restore-install-failed: pnpm-exit-1" }),
			restart: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.FAILED);
		assert.equal(r.result.reason, "rollback-restore-failed");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("superviseUpdate：回滚后仍未确认旧版本 → FAILED（rollback-unconfirmed）", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup4-"));
	try {
		const file = await writeTx(base);
		const r = await superviseUpdate({
			stateFile: file,
			waitForHost: async () => ({ ok: false, error: "host-wait-timeout" }),
			restore: () => ({ ok: true }),
			restart: () => ({ ok: true }),
			log: () => {},
		});
		assert.equal(r.phase, TRANSACTION_PHASE.FAILED);
		assert.equal(r.result.reason, "rollback-unconfirmed");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("superviseUpdate：回滚次数用尽 / 缺回滚目标 → FAILED，不再重启", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup5-"));
	try {
		const exhausted = await writeTx(base, { attempts: 1 });
		const r1 = await superviseUpdate({
			stateFile: exhausted,
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restore: () => ({ ok: true }),
			restart: () => { throw new Error("不应重启"); },
			log: () => {},
		});
		assert.equal(r1.result.reason, "rollback-exhausted");

		const noTarget = await writeTx(base, { previousSpecifier: "" });
		const r2 = await superviseUpdate({
			stateFile: noTarget,
			waitForHost: async () => ({ ok: false, error: "timeout" }),
			restore: () => { throw new Error("不应恢复"); },
			restart: () => { throw new Error("不应重启"); },
			log: () => {},
		});
		assert.equal(r2.result.reason, "rollback-target-missing");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("superviseUpdate：无事务或阶段不对 → 明确拒绝（不猜）", async () => {
	const base = await mkdtemp(join(tmpdir(), "sup6-"));
	try {
		assert.equal((await superviseUpdate({ stateFile: transactionFile(base), log: () => {} })).error, "no-transaction");
		const file = await writeTx(base, { phase: TRANSACTION_PHASE.STAGING });
		assert.match((await superviseUpdate({ stateFile: file, log: () => {} })).error, /not-restart-pending/);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
