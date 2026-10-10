// 更新事务的契约（评审 #32 note 1286 的 R2/R3/R10）：
//   - 产物/快照目录按**内容标识**命名且不可变——同版本不同内容不会互相覆盖；
//   - profile 目录靠**验证式查找**（声明了本插件依赖），不靠模块层级推断；
//   - 同一 profile 同时只允许一个事务，重复请求幂等。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_LOCK_STALE_MS,
	acquireLock,
	artifactDir,
	artifactRoot,
	dirReady,
	findProfileDir,
	newOperationId,
	profileSpecifierOf,
	readLock,
	readTransaction,
	releaseLock,
	snapshotDir,
	snapshotInstalled,
	snapshotRoot,
	transactionFile,
	updateLockFile,
	writeTransaction,
} from "../lib/plugin-update-transaction.js";

async function tmp(prefix = "tx-") {
	return mkdtemp(join(tmpdir(), prefix));
}

test("产物/快照目录按内容标识命名：同版本不同内容天然分属不同目录", () => {
	const a = "a".repeat(64);
	const b = "b".repeat(64);
	assert.notEqual(artifactDir("/root", a), artifactDir("/root", b));
	assert.equal(artifactDir("/root", a.toUpperCase()), artifactDir("/root", a));
	// 快照与产物必须落在不同根：否则"回滚目标"会被新产物覆盖（评审 R2）
	assert.notEqual(snapshotRoot("/home"), artifactRoot("/home"));
});

test("findProfileDir：靠依赖声明验证，而不是靠目录层级", async () => {
	const base = await tmp("profile-");
	try {
		// pnpm 标准布局：profile/node_modules/.pnpm/<entry>/node_modules/dsh-mobile-remote
		const profile = join(base, "profile");
		const plugin = join(profile, "node_modules", ".pnpm", "entry@1", "node_modules", "dsh-mobile-remote");
		await mkdir(plugin, { recursive: true });
		await writeFile(join(profile, "package.json"), JSON.stringify({
			name: "web-profile",
			dependencies: { "dsh-mobile-remote": "file:/somewhere", qrcode: "^1.5.4" },
		}));
		// 往上两层是 .pnpm/<entry>，那里没有依赖声明 → 必须继续往上找到 profile
		assert.equal(findProfileDir(plugin), profile);

		// 没有任何祖先声明该依赖 → 返回空（调用方转降级指引，绝不动文件）
		const orphan = join(base, "orphan", "node_modules", "dsh-mobile-remote");
		await mkdir(orphan, { recursive: true });
		assert.equal(findProfileDir(orphan), "");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("profileSpecifierOf：读出依赖声明；缺 profile 或字段返回空串", async () => {
	const base = await tmp("spec-");
	try {
		const profile = join(base, "p");
		await mkdir(profile, { recursive: true });
		await writeFile(join(profile, "package.json"), JSON.stringify({ dependencies: { "dsh-mobile-remote": "github:a/b#v1" } }));
		assert.equal(profileSpecifierOf(profile), "github:a/b#v1");
		assert.equal(profileSpecifierOf(""), "");
		assert.equal(profileSpecifierOf(join(base, "nope")), "");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("acquireLock：同 opId 幂等；不同 opId 且持有者存活 → busy；持有者已死可抢占", async () => {
	const base = await tmp("lock-");
	try {
		const file = updateLockFile(base);
		const op1 = newOperationId();
		const op2 = newOperationId();
		assert.equal(acquireLock(file, { opId: op1, pid: 111, now: 1000, isPidAlive: () => true }).ok, true);
		// 重入：同一 opId 幂等成功（重试不另开事务）
		assert.equal(acquireLock(file, { opId: op1, pid: 111, now: 1001, isPidAlive: () => true }).ok, true);
		// 另一操作 → busy，并回传持有者
		const busy = acquireLock(file, { opId: op2, pid: 222, now: 1002, isPidAlive: () => true });
		assert.equal(busy.ok, false);
		assert.equal(busy.error, "update-busy");
		assert.equal(busy.holder.opId, op1);
		// 持有者已死 → 抢占
		assert.equal(acquireLock(file, { opId: op2, pid: 222, now: 1003, isPidAlive: () => false }).ok, true);
		assert.equal(readLock(file).opId, op2);
		// 过期锁也可抢占（持有者仍存活，但锁已超过 staleMs）
		assert.equal(
			acquireLock(file, { opId: op1, pid: 111, now: 1003 + DEFAULT_LOCK_STALE_MS + 1, isPidAlive: () => true }).ok,
			true,
		);
		// 只有持有者能释放
		assert.equal(releaseLock(file, op2), false);
		assert.equal(releaseLock(file, op1), true);
		assert.equal(readLock(file), null);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("snapshotInstalled：把当前内容复制成不可变快照（原目录不动）", async () => {
	const base = await tmp("snap-");
	try {
		const installed = join(base, "installed");
		await mkdir(join(installed, "lib"), { recursive: true });
		await writeFile(join(installed, "package.json"), '{"version":"3.2.0"}\n');
		await writeFile(join(installed, "lib", "index.js"), "export const a = 1;\n");
		const dest = snapshotDir(join(base, "snaps"), "a".repeat(64));
		const r = snapshotInstalled({ installedRoot: installed, destDir: dest });
		assert.equal(r.ok, true, r.error);
		assert.equal(await readFile(join(dest, "lib", "index.js"), "utf8"), "export const a = 1;\n");
		// 原目录仍在（运行中的插件不能被搬走）
		assert.equal(dirReady(installed), true);
		assert.equal(dirReady(dest), true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("snapshotInstalled：源不存在时明确失败（不制造空快照当回滚目标）", async () => {
	const base = await tmp("snap2-");
	try {
		const r = snapshotInstalled({ installedRoot: join(base, "missing"), destDir: join(base, "d") });
		assert.equal(r.ok, false);
		assert.equal(r.error, "installed-root-missing");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("事务状态文件可读写，且带 updatedAt", async () => {
	const base = await tmp("state-");
	try {
		const file = transactionFile(base);
		assert.equal(readTransaction(file), null);
		const tx = writeTransaction(file, { opId: "op1", phase: "staging" });
		assert.equal(tx.opId, "op1");
		assert.ok(typeof tx.updatedAt === "string");
		assert.equal(readTransaction(file).phase, "staging");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
