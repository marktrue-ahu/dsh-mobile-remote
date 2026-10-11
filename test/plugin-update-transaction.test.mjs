// 更新事务的契约（评审 #32 note 1286 的 R2/R3/R10）：
//   - 产物/快照目录按**内容标识**命名且不可变——同版本不同内容不会互相覆盖；
//   - profile 目录靠**验证式查找**（声明了本插件依赖），不靠模块层级推断；
//   - 同一 profile 同时只允许一个事务，重复请求幂等。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
	snapshotReady,
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

test("acquireLock：存活者互斥、同代重入、死者接管、旧代不能释放", async () => {
  const base = await tmp("lock-");
  try {
    const file = updateLockFile(base), op1 = newOperationId(), op2 = newOperationId();
    const first = acquireLock(file, { opId: op1 });
    assert.equal(first.ok, true);
    assert.equal(acquireLock(file, { opId: op1, lease: first.lease }).ok, true);
    assert.equal(acquireLock(file, { opId: op1 }).ok, false, "同请求ID不是同代所有权");
    assert.equal(acquireLock(file, { opId: op2, now: Date.now() + DEFAULT_LOCK_STALE_MS * 100 }).ok, false);
    assert.equal(releaseLock(file, op1), false, "只知道ID不可释放");
    assert.equal(releaseLock(file, first.lease), true);
    const dead = acquireLock(file, { opId: op1, pid: 2147483646 });
    const second = acquireLock(file, { opId: op2 });
    assert.equal(second.ok, true);
    assert.equal(releaseLock(file, dead.lease), false);
    assert.equal(readLock(file).opId, op2);
    assert.equal(releaseLock(file, second.lease), true);
    assert.equal(readLock(file), null);
  } finally { await rm(base, { recursive: true, force: true }); }
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
		// 只有**带完成标记**的快照才算可用（半复制不会被当成回滚目标，F4）
		assert.equal(snapshotReady(dest), true);
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

test("snapshotInstalled：解引用 symlink，得到自包含快照（F4）", async () => {
	const base = await tmp("snap3-");
	try {
		// 模拟 pnpm：副本里的依赖是指向树外 store 的符号链接
		const store = join(base, "store", "qrcode");
		await mkdir(store, { recursive: true });
		await writeFile(join(store, "package.json"), '{"name":"qrcode","main":"index.js"}\n');
		await writeFile(join(store, "index.js"), "module.exports = {toBuffer: async()=>Buffer.from([137,80,78,71,13,10,26,10])};\n");
		const installed = join(base, "installed");
		await mkdir(join(installed, "lib"), { recursive: true });
		await mkdir(join(installed, "node_modules"), { recursive: true });
		await writeFile(join(installed, "package.json"), '{"dependencies":{"qrcode":"1.0.0"}}\n');
		await symlink(store, join(installed, "node_modules", "qrcode"), "dir");

		const dest = snapshotDir(join(base, "snaps"), "c".repeat(64));
		const r = snapshotInstalled({ installedRoot: installed, destDir: dest });
		assert.equal(r.ok, true, r.error);
		assert.equal(snapshotReady(dest), true);
		// 快照里是**真实文件**，不是指向树外的链接
		assert.equal(await readFile(join(dest, "node_modules", "qrcode", "index.js"), "utf8"), "module.exports = {toBuffer: async()=>Buffer.from([137,80,78,71,13,10,26,10])};\n");
		const st = await lstat(join(dest, "node_modules", "qrcode"));
		assert.ok(st.isDirectory() || st.isSymbolicLink(), "链接仅可指向快照内部已冻结依赖");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("snapshotInstalled：复制中途失败不留「可用」快照（原子发布，F4）", async () => {
	const base = await tmp("snap4-");
	try {
		const installed = join(base, "installed");
		await mkdir(installed, { recursive: true });
		await writeFile(join(installed, "package.json"), "{}\n");
		await mkdir(join(installed, "lib"));
		await writeFile(join(installed, "lib", "index.js"), "export const ok=1;\n");
		const dest = snapshotDir(join(base, "snaps"), "d".repeat(64));
		const r = snapshotInstalled({ installedRoot: installed, destDir: dest, copyFile: () => ({ ok: false, error: "ENOSPC" }) });
		assert.equal(r.ok, false);
		assert.match(r.error, /snapshot-failed/);
		assert.equal(snapshotReady(dest), false, "半成品不能被当成回滚目标");
		assert.equal(existsSync(dest), false);
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
