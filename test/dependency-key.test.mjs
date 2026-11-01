// npm 正式渠道的**依赖键自描述**（包名带 scope 后，profile 里的依赖键随之改变）。
// 若仍硬编码旧包名，从 npm 安装的插件会找不到 profile → 自更新直接不可用。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	LEGACY_DEPENDENCY_KEY,
	acquireLock,
	dependencyKeyIn,
	dependencyKeysFor,
	findProfileDir,
	profileSpecifierOf,
	publishOwnedSnapshotLink,
	restoreOwnedProfile,
	switchOwnedDependency,
	updateLockPath,
} from "../lib/plugin-update-transaction.js";
import { switchDependencySpecifier } from "../lib/plugin-self-update.js";

const SCOPED = "@marktrue/dsh-mobile-remote";

async function makePlugin(root, name) {
	await mkdir(join(root, "lib"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "3.2.0", dependencies: { qrcode: "^1.5.4" } }));
	await writeFile(join(root, "lib", "index.js"), "export const x = 1;\n");
}

test("dependencyKeysFor：从插件自己的包名推导，并保留旧键兜底", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-"));
	try {
		const scoped = join(base, "scoped");
		await makePlugin(scoped, SCOPED);
		assert.deepEqual(dependencyKeysFor(scoped), [SCOPED, LEGACY_DEPENDENCY_KEY]);

		const legacy = join(base, "legacy");
		await makePlugin(legacy, LEGACY_DEPENDENCY_KEY);
		assert.deepEqual(dependencyKeysFor(legacy), [LEGACY_DEPENDENCY_KEY], "同键不重复");

		assert.deepEqual(dependencyKeysFor(join(base, "missing")), [LEGACY_DEPENDENCY_KEY], "读不到包名时退回旧键");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("findProfileDir：scope 键的 profile 也能被验证式定位到", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-profile-"));
	try {
		const pluginRoot = join(base, "plugin");
		await makePlugin(pluginRoot, SCOPED);
		const profile = join(base, "profile");
		const installed = join(profile, "node_modules", "dsh-mobile-remote");
		// 真实安装的插件目录一定有自己的 package.json——依赖键正是从它推导的
		await makePlugin(installed, SCOPED);
		await writeFile(join(profile, "package.json"), JSON.stringify({
			name: "web-profile", dependencies: { [SCOPED]: "^3.2.0", qrcode: "^1.5.4" },
		}));

		const found = findProfileDir(installed, {
			readJson: (f) => JSON.parse(readFileSync(f, "utf8")),
		});
		assert.equal(found, profile);
		assert.equal(dependencyKeyIn(JSON.parse(await readFile(join(profile, "package.json"), "utf8")), [SCOPED]), SCOPED);
		assert.equal(profileSpecifierOf(profile, { keys: [SCOPED, LEGACY_DEPENDENCY_KEY] }), "^3.2.0");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("switchDependencySpecifier：改写**实际存在的那个键**，不新增第二个依赖", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-switch-"));
	try {
		const profileDir = join(base, "profile");
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "package.json"), JSON.stringify({
			name: "web", dependencies: { [SCOPED]: "^3.2.0", qrcode: "^1.5.4" },
		}));
		const r = switchDependencySpecifier({ profileDir, nextSpecifier: "file:/artifact", keys: [SCOPED, LEGACY_DEPENDENCY_KEY] });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.key, SCOPED, "必须回报实际改写的键");
		assert.equal(r.previous, "^3.2.0");
		const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies[SCOPED], "file:/artifact");
		assert.equal(LEGACY_DEPENDENCY_KEY in doc.dependencies, false, "不得凭空新增旧键依赖");
		assert.equal(doc.dependencies.qrcode, "^1.5.4", "其它依赖不受影响");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("受代际保护的 switch/restore 也按传入的键工作（scope 渠道）", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-arb-"));
	try {
		const profileDir = join(base, "profile");
		await mkdir(profileDir, { recursive: true });
		await writeFile(join(profileDir, "package.json"), JSON.stringify({
			name: "web", dependencies: { [SCOPED]: "file:/old", qrcode: "^1.5.4" },
		}));
		const lockPath = updateLockPath(base);
		const grant = acquireLock(lockPath, { opId: "depkey-op" });
		assert.equal(grant.ok, true, grant.error);

		const switched = switchOwnedDependency({ profileDir, nextSpecifier: "file:/new", key: SCOPED, lockPath, lease: grant.lease });
		assert.equal(switched.ok, true, switched.error);
		let doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies[SCOPED], "file:/new");

		const restored = restoreOwnedProfile({
			profileDir, snapshotDir: join(base, "snap"), key: SCOPED, lockPath, lease: grant.lease,
			snapshot: { packageJson: JSON.stringify({ name: "web", dependencies: { [SCOPED]: "file:/old", qrcode: "^1.5.4" } }) },
		});
		assert.equal(restored.ok, true, restored.error);
		doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies[SCOPED], `file:${join(base, "snap")}`, "legacy restore writes the snapshot path into the same key");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("NPM rollback restores the prior exact package spec instead of leaving a file dependency", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-npm-restore-"));
	try {
		const profileDir = join(base, "profile");
		await mkdir(profileDir, { recursive: true });
		const oldSpec = "3.2.1-alpha.3";
		const packageJson = { name: "web", dependencies: { [SCOPED]: oldSpec, qrcode: "^1.5.4" } };
		await writeFile(join(profileDir, "package.json"), JSON.stringify({ ...packageJson, dependencies: { ...packageJson.dependencies, [SCOPED]: "3.2.2-alpha.1" } }));
		await writeFile(join(profileDir, "pnpm-lock.yaml"), "candidate-lock\n");
		const lockPath = updateLockPath(base);
		const grant = acquireLock(lockPath, { opId: "restore-npm-spec" });
		assert.equal(grant.ok, true, grant.error);
		const restored = restoreOwnedProfile({
			profileDir,
			snapshotDir: join(base, "snapshot"),
			key: SCOPED,
			preserveSpecifier: true,
			lockPath,
			lease: grant.lease,
			snapshot: { packageJson: JSON.stringify(packageJson), pnpmLock: "original-lock\n" },
		});
		assert.equal(restored.ok, true, restored.error);
		const doc = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
		assert.equal(doc.dependencies[SCOPED], oldSpec);
		assert.equal(doc.dependencies.qrcode, "^1.5.4");
		assert.equal(await readFile(join(profileDir, "pnpm-lock.yaml"), "utf8"), "original-lock\n");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("scoped rollback snapshot link is published under the real package key", async () => {
	const base = await mkdtemp(join(tmpdir(), "depkey-scoped-link-"));
	try {
		const profileDir = join(base, "profile");
		const snapshotDir = join(base, "snapshot");
		await mkdir(join(profileDir, "node_modules"), { recursive: true });
		await mkdir(join(snapshotDir, "lib"), { recursive: true });
		await writeFile(join(snapshotDir, "package.json"), JSON.stringify({ name: SCOPED, version: "3.2.1-alpha.3" }));
		const lockPath = updateLockPath(base);
		const grant = acquireLock(lockPath, { opId: "restore-scoped-link" });
		assert.equal(grant.ok, true, grant.error);
		const published = publishOwnedSnapshotLink({ profileDir, snapshotDir, key: SCOPED, lockPath, lease: grant.lease });
		assert.equal(published.ok, true, published.error);
		assert.equal(await realpath(join(profileDir, "node_modules", SCOPED)), await realpath(snapshotDir));
		assert.equal(await readlink(join(profileDir, "node_modules", SCOPED)), await realpath(snapshotDir));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
